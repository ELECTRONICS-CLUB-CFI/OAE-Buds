#pragma once

#include <vector>
#include <span>
#include <cstdint>
#include <deque>
#include "oae_config.hpp"

namespace oae {
namespace calib {

struct CalibResult {
    bool success = false;
    int32_t chirp_onset_sample = -1;
    double chirp_latency_ms = 0.0;
    std::unordered_map<uint32_t, double> calibrated_vol3;
    std::vector<double> measured_amplitudes_db;
};

// Probe seal and occlusion checker matching OfflineRecorder.envCheck() & threshCheck()
class FitChecker {
public:
    FitChecker(const FitCheckConfig& config, uint32_t sample_rate = 48000);

    // Feed in a captured PCM buffer (e.g. from AudioRecord / miniaudio chunk)
    // Returns true when 25 consecutive buffers satisfy [seal_check_threshold, seal_occlusion_threshold]
    bool process_buffer(std::span<const int16_t> buffer);

    bool is_sealed() const { return sealed_; }
    double last_envelope() const { return last_envelope_; }
    uint32_t consecutive_good_buffers() const { return consecutive_passes_; }

    void reset();

private:
    FitCheckConfig config_;
    uint32_t sample_rate_;
    double env_out_ = 0.0;
    bool first_buffer_ = true;
    double gain_attack_;
    double gain_release_;
    std::deque<int32_t> env_history_;
    double last_envelope_ = 0.0;
    uint32_t consecutive_passes_ = 0;
    bool sealed_ = false;

    double compute_envelope(std::span<const int16_t> buffer);
};

// In-ear volume calibration matching Utils.volcalib() & Utils.compute()
class Calibrator {
public:
    static CalibResult calibrate(std::span<const int16_t> recording,
                                 const OaeConfig& config,
                                 DeviceProfile& profile);

    // Compute target transmit gain and measured amplitude for a given tone segment
    static std::pair<double, double> compute_tone_spl_and_gain(
        uint32_t freq,
        const std::vector<double>& segment,
        size_t tone_index,
        const CalibrationPolynomials& calib);
};

} // namespace calib
} // namespace oae
