#pragma once

#include <string>
#include <vector>
#include <unordered_map>
#include <cstdint>
#include <optional>

namespace oae {

struct AudioConfig {
    uint32_t sample_rate = 48000;
    uint32_t bit_depth = 16;
    double recording_window_seconds = 1.5;
    double play_window_ms = 1500.0;
    double process_window_length_factor = 1.0;
    double init_signal_trim_factor = 1.0;

    uint32_t process_window_length() const {
        return static_cast<uint32_t>(sample_rate * process_window_length_factor);
    }
    uint32_t init_trim_length() const {
        return static_cast<uint32_t>(sample_rate * init_signal_trim_factor);
    }
};

struct TestConfig {
    double snr_threshold_db = 7.0;
    double spl_threshold_db = -50.0;
    uint32_t max_tries = 1;
    uint32_t constant_tone_seconds = 5;
    uint32_t pass_rule_min_frequencies = 3;
};

struct ArtifactConfig {
    bool enabled = true;
    double art_threshold_db = 4.0;
    double snr_floor_db = -25.0;
    double imd_threshold = 200.0;
    int32_t amp_threshold = 500;
};

struct FitCheckConfig {
    bool enabled = false;
    uint32_t check_frequency_hz = 226;
    int32_t seal_check_threshold = 200;
    int32_t seal_occlusion_threshold = 500;
    uint32_t consecutive_pass_buffers = 25;
    std::string calib_signal = "tone";
    double tone_volume = 0.6;
};

struct VolumeCalibConfig {
    bool enabled = true;
    double chirp_start_hz = 1000.0;
    double chirp_end_hz = 4000.0;
    double chirp_duration_seconds = 0.1;
    double tone_duration_seconds = 0.2;
    double examine_duration_seconds = 0.1;
    double pad_duration_seconds = 0.05;
    double latency_search_window_seconds = 0.5;
};

struct FrequencyPair {
    uint32_t f2 = 0;       // Test tone (e.g. 2016 Hz)
    uint32_t f1 = 0;       // Companion tone (e.g. 1640 Hz)
    uint32_t oae_bin = 0;  // 2*f1 - f2 bin index (1264 Hz)
    uint32_t imd_bin = 0;  // 2*f2 - f1 bin index (2392 Hz)
    bool active = true;
};

struct CalibrationPolynomials {
    std::vector<double> p1;
    std::vector<double> p2;
    std::vector<double> a;
    std::vector<double> b;
    std::vector<double> spl_targets;
    std::vector<double> defaults;
    std::vector<double> maxvals;
};

struct DeviceProfile {
    std::string name;
    std::string description;
    double master_volume = 0.5;
    double vol_default = 0.5;
    int32_t seal_check_threshold = 200;

    // Per-f2 playback volume fraction: f2 -> volume [0.0, 1.0]
    std::unordered_map<uint32_t, double> vol1_defaults;

    // Per-tone volume for calibration pulses: freq -> volume [0.0, 1.0]
    std::unordered_map<uint32_t, double> vol3;

    CalibrationPolynomials calibration;
};

struct OaeConfig {
    AudioConfig audio;
    TestConfig test;
    ArtifactConfig artifact;
    FitCheckConfig fit_check;
    VolumeCalibConfig vol_calib;
    std::vector<FrequencyPair> frequency_pairs = {
        {2016, 1640, 1264, 2392, true},
        {2953, 2438, 1923, 3468, true},
        {3985, 3282, 2579, 4688, true},
        {4969, 4078, 3187, 5860, true}
    };
    std::vector<double> noise_thresholds = {96.0, 94.0, 95.0, 87.0};

    std::unordered_map<std::string, DeviceProfile> profiles;
    std::string active_profile_name = "ugreen_80864_rpi5";

    const DeviceProfile& active_profile() const;

    // Load and validate from TOML file
    static std::optional<OaeConfig> load_from_file(const std::string& path,
                                                  const std::string& profile_name = "ugreen_80864_rpi5",
                                                  std::string* error_out = nullptr);

    // Helpers to get active frequency pairs
    std::vector<FrequencyPair> get_active_pairs() const;
};

} // namespace oae
