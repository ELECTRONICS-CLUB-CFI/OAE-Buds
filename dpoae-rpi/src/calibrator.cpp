#include "oae/calibrator.hpp"
#include "oae/signal_gen.hpp"
#include "oae/dsp_engine.hpp"
#include <cmath>
#include <numeric>
#include <iostream>

namespace oae {
namespace calib {

constexpr double EPSILON = 1e-12;

FitChecker::FitChecker(const FitCheckConfig& config, uint32_t sample_rate)
    : config_(config), sample_rate_(sample_rate) {
    double attack_time = 0.01;  // 10ms responsive attack
    double release_time = 0.05; // 50ms release
    gain_attack_ = std::exp(-1.0 / (sample_rate_ * attack_time));
    gain_release_ = std::exp(-1.0 / (sample_rate_ * release_time));
}

void FitChecker::reset() {
    env_out_ = 0.0;
    first_buffer_ = true;
    env_history_.clear();
    last_envelope_ = 0.0;
    consecutive_passes_ = 0;
    sealed_ = false;
}

double FitChecker::compute_envelope(std::span<const int16_t> buffer) {
    if (buffer.empty()) return 0.0;
    if (first_buffer_) {
        env_out_ = std::abs(static_cast<double>(buffer[0]));
        first_buffer_ = false;
    }
    double accum = 0.0;
    for (int16_t s : buffer) {
        double env_in = std::abs(static_cast<double>(s));
        if (env_out_ < env_in) {
            env_out_ = env_in + gain_attack_ * (env_out_ - env_in);
        } else {
            env_out_ = env_in + gain_release_ * (env_out_ - env_in);
        }
        accum += env_out_;
    }
    return accum / static_cast<double>(buffer.size());
}

bool FitChecker::process_buffer(std::span<const int16_t> buffer) {
    double env = compute_envelope(buffer);
    last_envelope_ = env;
    int32_t env_val = static_cast<int32_t>(env);

    if (env_val >= config_.seal_check_threshold && env_val <= config_.seal_occlusion_threshold) {
        consecutive_passes_++;
    } else {
        consecutive_passes_ = 0;
    }

    if (consecutive_passes_ >= config_.consecutive_pass_buffers) {
        sealed_ = true;
    } else {
        sealed_ = false;
    }

    return sealed_;
}

std::pair<double, double> Calibrator::compute_tone_spl_and_gain(
    uint32_t freq,
    const std::vector<double>& segment,
    size_t tone_index,
    const CalibrationPolynomials& calib) {

    auto mag = dsp::compute_magnitude_spectrum(segment);

    // At 4800 samples and 48000 Hz, resolution is 10 Hz per bin.
    // e.g. 1640 Hz is bin 164.
    size_t fidx = freq / 10;
    double peak = (fidx < mag.size()) ? mag[fidx] : 1.0;
    double amp_db = 20.0 * std::log10(std::max(peak, EPSILON));

    double p1 = (tone_index < calib.p1.size()) ? calib.p1[tone_index] : 1.0;
    double p2 = (tone_index < calib.p2.size()) ? calib.p2[tone_index] : -50.0;
    double a = (tone_index < calib.a.size()) ? calib.a[tone_index] : 1e-7;
    double b = (tone_index < calib.b.size()) ? calib.b[tone_index] : 0.115;
    double spl_target = (tone_index < calib.spl_targets.size()) ? calib.spl_targets[tone_index] : 60.0;
    double default_gain = (tone_index < calib.defaults.size()) ? calib.defaults[tone_index] : 0.15;
    double max_gain = (tone_index < calib.maxvals.size()) ? calib.maxvals[tone_index] : 0.50;

    double spl = p1 * amp_db + p2;
    double delta = spl_target - spl;
    double target_rx = amp_db + delta;
    double target_tx = a * std::exp(b * target_rx);

    if (target_tx > max_gain || target_tx < 0.001) {
        target_tx = default_gain;
    }

    return {target_tx, amp_db};
}

CalibResult Calibrator::calibrate(std::span<const int16_t> recording,
                                  const OaeConfig& config,
                                  DeviceProfile& profile) {
    CalibResult res;
    uint32_t fs = config.audio.sample_rate;

    // Generate local chirp reference to cross-correlate against
    auto ref_chirp = signal_gen::make_linear_chirp(
        config.vol_calib.chirp_start_hz,
        config.vol_calib.chirp_end_hz,
        config.vol_calib.chirp_duration_seconds,
        fs, 0.0, 0.5);

    // Search window: first 0.5 s of recording (24,000 samples)
    size_t search_len = std::min(recording.size(), static_cast<size_t>(config.vol_calib.latency_search_window_seconds * fs));
    std::vector<double> pre(ref_chirp.begin(), ref_chirp.end());
    std::vector<double> s1(recording.begin(), recording.begin() + search_len);

    auto corr = dsp::xcorr_fft(pre, s1);

    size_t max_idx = 0;
    double max_val = 0.0;
    for (size_t i = 0; i < corr.size(); ++i) {
        if (corr[i] > max_val) {
            max_val = corr[i];
            max_idx = i;
        }
    }

    res.chirp_onset_sample = static_cast<int32_t>(max_idx);
    res.chirp_latency_ms = (static_cast<double>(max_idx) / fs) * 1000.0;

    size_t idx = max_idx + pre.size();
    auto active_pairs = config.get_active_pairs();
    size_t num_pairs = std::min(active_pairs.size(), size_t(4));

    size_t pad_samples = static_cast<size_t>(config.vol_calib.pad_duration_seconds * fs);
    size_t examine_samples = static_cast<size_t>(config.vol_calib.examine_duration_seconds * fs);
    size_t tone_samples = static_cast<size_t>(config.vol_calib.tone_duration_seconds * fs);

    size_t tone_counter = 0;
    for (size_t i = 0; i < num_pairs; ++i) {
        size_t ss1 = idx + pad_samples;
        size_t ee1 = ss1 + examine_samples;
        size_t ss2 = ss1 + tone_samples;
        size_t ee2 = ss2 + examine_samples;

        if (ee2 >= recording.size()) {
            break;
        }

        std::vector<double> seg1(recording.begin() + ss1, recording.begin() + ee1);
        std::vector<double> seg2(recording.begin() + ss2, recording.begin() + ee2);

        uint32_t f1 = active_pairs[i].f1;
        uint32_t f2 = active_pairs[i].f2;

        auto [v1, amp1] = compute_tone_spl_and_gain(f1, seg1, tone_counter, profile.calibration);
        auto [v2, amp2] = compute_tone_spl_and_gain(f2, seg2, tone_counter + 1, profile.calibration);

        res.calibrated_vol3[f1] = v1;
        res.calibrated_vol3[f2] = v2;
        profile.vol3[f1] = v1;
        profile.vol3[f2] = v2;

        res.measured_amplitudes_db.push_back(amp1);
        res.measured_amplitudes_db.push_back(amp2);

        idx += tone_samples * 2;
        tone_counter += 2;
    }

    res.success = (tone_counter == 8);
    return res;
}

} // namespace calib
} // namespace oae
