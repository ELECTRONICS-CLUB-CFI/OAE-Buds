#pragma once

#include <string>
#include <vector>
#include <span>
#include <cstdint>
#include "oae_config.hpp"
#include "dsp_engine.hpp"
#include "audio_engine.hpp"

namespace oae {
namespace session {

struct SessionSummary {
    std::string patient_id = "0";
    std::string ear = "left";
    std::string timestamp_str;
    uint64_t timestamp_ms = 0;
    std::string profile_name;

    std::string verdict = "Refer"; // "Pass" or "Refer"
    uint32_t passed_count = 0;
    uint32_t total_active_frequencies = 0;

    std::vector<dsp::DpoaeResult> results;
    std::string noise_check_result = "noise-pass"; // "noise-pass" or "retry"
    bool fit_check_passed = true;
    bool vol_calib_passed = true;
    double total_duration_seconds = 0.0;

    std::string to_json() const;
};

class SessionRunner {
public:
    SessionRunner(OaeConfig config, audio::IAudioEngine& audio_engine);

    // Run the complete deterministic DPOAE screening state machine:
    // FIT_CHECK -> VOL_CALIB -> MEASURE_PAIR[0..3] -> EVALUATE -> SAVE
    SessionSummary run_session(const std::string& patient_id,
                               const std::string& ear,
                               const std::string& output_dir,
                               bool verbose = true);

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
