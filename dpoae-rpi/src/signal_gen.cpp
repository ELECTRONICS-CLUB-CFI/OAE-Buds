#include "oae/signal_gen.hpp"
#include <cmath>

namespace oae {
namespace signal_gen {

constexpr double PI = 3.14159265358979323846;

double normalize_phase(double ang) {
    double angle = ang;
    while (angle < 0.0) {
        angle += 2.0 * PI;
    }
    while (angle >= 2.0 * PI) {
        angle -= 2.0 * PI;
    }
    return angle;
}

std::vector<int16_t> make_sine_wave(uint32_t num_samples, double freq, uint32_t sampling_freq, double vol) {
    std::vector<int16_t> sin_wave(num_samples);
    double initial_phase = normalize_phase(0.0);
    double dphase = 2.0 * PI * freq / static_cast<double>(sampling_freq);
    double phase = initial_phase;
    double amplitude = 32000.0 * vol;

    for (uint32_t i = 0; i < num_samples; ++i) {
        sin_wave[i] = static_cast<int16_t>(std::sin(phase) * amplitude);
        phase += dphase;
        phase = normalize_phase(phase);
    }
    return sin_wave;
}

std::vector<int16_t> make_dual_tone(double f1, double f2, uint32_t sampling_freq,
                                    uint32_t num_samples, double v1, double v2) {
    std::vector<int16_t> signal1 = make_sine_wave(num_samples, f1, sampling_freq, v1);
    std::vector<int16_t> signal2 = make_sine_wave(num_samples, f2, sampling_freq, v2);

    std::vector<int16_t> stereo(num_samples * 2);
    for (uint32_t i = 0; i < num_samples; ++i) {
        stereo[2 * i] = signal1[i];       // Left Channel: f1
        stereo[2 * i + 1] = signal2[i];   // Right Channel: f2
    }
    return stereo;
}

std::vector<int16_t> make_linear_chirp(double start_freq, double end_freq,
                                       double duration_sec, uint32_t sampling_freq,
                                       double initial_phase, double scale) {
    uint32_t N = static_cast<uint32_t>(duration_sec * sampling_freq);
    std::vector<int16_t> ans(N);
    double k = (end_freq - start_freq) / duration_sec;
    double mult = 32767.0 * scale;

    for (uint32_t i = 0; i < N; ++i) {
        double t = static_cast<double>(i) / sampling_freq;
        double phase = initial_phase + 2.0 * PI * (start_freq * t + 0.5 * k * t * t);
        phase = normalize_phase(phase);
        ans[i] = static_cast<int16_t>(std::sin(phase) * mult);
    }
    return ans;
}

std::vector<int16_t> make_stereo_chirp(double start_freq, double end_freq,
                                       double duration_sec, uint32_t sampling_freq,
                                       double initial_phase, double scale) {
    std::vector<int16_t> mono = make_linear_chirp(start_freq, end_freq, duration_sec, sampling_freq, initial_phase, scale);
    std::vector<int16_t> stereo(mono.size() * 2);
    for (size_t i = 0; i < mono.size(); ++i) {
        stereo[2 * i] = mono[i];
        stereo[2 * i + 1] = mono[i];
    }
    return stereo;
}

std::vector<int16_t> make_calib_sequence(const OaeConfig& config, const DeviceProfile& profile) {
    uint32_t fs = config.audio.sample_rate;
    // Preamble chirp
    std::vector<int16_t> pre = make_stereo_chirp(config.vol_calib.chirp_start_hz,
                                                 config.vol_calib.chirp_end_hz,
                                                 config.vol_calib.chirp_duration_seconds,
                                                 fs, 0.0, 1.0);

    // Initial pad: 4800 stereo samples (0.05 s = 2400 stereo samples, Java used 4800 = 0.1s pad)
    uint32_t pad_stereo_samples = 4800;
    uint32_t pulse_len_samples = static_cast<uint32_t>(config.vol_calib.tone_duration_seconds * fs);

    auto active_pairs = config.get_active_pairs();
    size_t num_pairs = std::min(active_pairs.size(), size_t(4));

    size_t total_stereo_samples = pad_stereo_samples + (pre.size() / 2) + (num_pairs * 2 * pulse_len_samples);
    std::vector<int16_t> out_sig(total_stereo_samples * 2, 0);

    size_t write_idx = pad_stereo_samples * 2;
    for (int16_t sample : pre) {
        out_sig[write_idx++] = sample;
    }

    for (size_t i = 0; i < num_pairs; ++i) {
        uint32_t f1 = active_pairs[i].f1;
        uint32_t f2 = active_pairs[i].f2;

        double v3a = 0.15;
        double v3b = 0.05;
        auto it_a = profile.vol3.find(f1);
        if (it_a != profile.vol3.end()) v3a = it_a->second;
        auto it_b = profile.vol3.find(f2);
        if (it_b != profile.vol3.end()) v3b = it_b->second;

        // Pulse 1: f1 Left (v3a), f2 Right (0)
        auto pulse1 = make_dual_tone(f1, f2, fs, pulse_len_samples, v3a, 0.0);
        for (int16_t sample : pulse1) {
            out_sig[write_idx++] = sample;
        }

        // Pulse 2: f1 Left (0), f2 Right (v3b)
        auto pulse2 = make_dual_tone(f1, f2, fs, pulse_len_samples, 0.0, v3b);
        for (int16_t sample : pulse2) {
            out_sig[write_idx++] = sample;
        }
    }

    return out_sig;
}

} // namespace signal_gen
} // namespace oae
