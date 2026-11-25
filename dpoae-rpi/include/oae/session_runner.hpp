#pragma once

#include <string>
#include <vector>
#include <span>
#include <cstdint>
#include <atomic>
#include "oae_config.hpp"
#include "dsp_engine.hpp"
#include "audio_engine.hpp"

namespace oae {
namespace session {

struct SessionSummary {
    std::string session_id;
    std::string patient_id = "0";
    std::string ear = "left";
    std::string notes;
    std::string timestamp_str;
    uint64_t timestamp_ms = 0;
    std::string profile_name;

    std::string verdict = "Refer"; // "Pass", "Refer", or "Aborted"
    uint32_t passed_count = 0;
    uint32_t total_active_frequencies = 0;

    std::vector<dsp::DpoaeResult> results;
    std::string noise_check_result = "noise-pass"; // "noise-pass" or "retry"
    bool fit_check_enabled = false;
    bool fit_check_passed = true;
    bool vol_calib_enabled = true;
    bool vol_calib_passed = true;
    double total_duration_seconds = 0.0;
    std::string dev_telemetry_file;

    std::string to_json() const;
};

struct ToneTestConfig {
    static constexpr double kMaxSafeAmplitude = 0.60;

    std::string channel = "left"; // "left", "right", or "both"
    double freq_hz = 1000.0;
    double f2_hz = 0.0;           // Optional secondary tone for "both"
    double duration_s = 2.0;
    double amplitude = 0.20;
    std::string output_dir = "./results";
    bool json_stream = false;
    bool verbose = true;
};

struct ToneTestResult {
    std::string channel = "left";
    double target_hz = 1000.0;
    double f2_hz = 0.0;
    double amplitude_requested = 0.20;
    double amplitude_applied = 0.20;
    double duration_s = 2.0;
    double measured_peak_hz = 0.0;
    double rms_dbfs = -120.0;
    double peak_dbfs = -120.0;
    uint32_t clipped_samples = 0;
    double latency_ms = 0.0;
    std::string wav_file;

    std::string to_json_line() const;
};

class SessionRunner {
public:
    SessionRunner(OaeConfig config, audio::IAudioEngine& audio_engine);

    // Run the complete deterministic DPOAE screening state machine:
    // FIT_CHECK -> VOL_CALIB -> MEASURE_PAIR[0..3] -> EVALUATE -> SAVE
    SessionSummary run_session(const std::string& patient_id,
                               const std::string& ear,
                               const std::string& output_dir,
                               bool verbose = true,
                               bool json_stream = false,
                               const std::string& session_id = "",
                               const std::string& notes = "",
                               const std::atomic<bool>* stop_flag = nullptr,
                               bool dev_telemetry = false);

    // Execute a short duplex tone playback + capture sanity check with safety ceiling
    ToneTestResult run_tone_test(const ToneTestConfig& opts,
                                 const std::atomic<bool>* stop_flag = nullptr);

    // Save 16-bit mono PCM as standard uncompressed WAV file
    static bool save_wav(const std::string& filepath,
                         std::span<const int16_t> samples,
                         uint32_t sample_rate = 48000);

private:
    OaeConfig config_;
    audio::IAudioEngine& audio_engine_;
};

} // namespace session
} // namespace oae
