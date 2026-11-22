#include "oae/session_runner.hpp"
#include "oae/signal_gen.hpp"
#include "oae/calibrator.hpp"
#include <fstream>
#include <sstream>
#include <iostream>
#include <chrono>
#include <iomanip>
#include <filesystem>

namespace oae {
namespace session {

SessionRunner::SessionRunner(OaeConfig config, audio::IAudioEngine& audio_engine)
    : config_(std::move(config)), audio_engine_(audio_engine) {}

bool SessionRunner::save_wav(const std::string& filepath,
                             std::span<const int16_t> samples,
                             uint32_t sample_rate) {
    std::ofstream out(filepath, std::ios::binary);
    if (!out.is_open()) return false;

    uint32_t num_samples = static_cast<uint32_t>(samples.size());
    uint32_t subchunk2_size = num_samples * 2;
    uint32_t chunk_size = 36 + subchunk2_size;
    uint16_t audio_format = 1; // PCM
    uint16_t num_channels = 1; // Mono
    uint32_t byte_rate = sample_rate * 2;
    uint16_t block_align = 2;
    uint16_t bits_per_sample = 16;

    out.write("RIFF", 4);
    out.write(reinterpret_cast<const char*>(&chunk_size), 4);
    out.write("WAVE", 4);

    out.write("fmt ", 4);
    uint32_t subchunk1_size = 16;
    out.write(reinterpret_cast<const char*>(&subchunk1_size), 4);
    out.write(reinterpret_cast<const char*>(&audio_format), 2);
    out.write(reinterpret_cast<const char*>(&num_channels), 2);
    out.write(reinterpret_cast<const char*>(&sample_rate), 4);
    out.write(reinterpret_cast<const char*>(&byte_rate), 4);
    out.write(reinterpret_cast<const char*>(&block_align), 2);
    out.write(reinterpret_cast<const char*>(&bits_per_sample), 2);

    out.write("data", 4);
    out.write(reinterpret_cast<const char*>(&subchunk2_size), 4);
    out.write(reinterpret_cast<const char*>(samples.data()), subchunk2_size);

    return true;
}

static std::string escape_json(const std::string& s) {
    std::ostringstream o;
    for (char c : s) {
        if (c == '"') o << "\\\"";
        else if (c == '\\') o << "\\\\";
        else if (c == '\b') o << "\\b";
        else if (c == '\f') o << "\\f";
        else if (c == '\n') o << "\\n";
        else if (c == '\r') o << "\\r";
        else if (c == '\t') o << "\\t";
        else if (static_cast<unsigned char>(c) <= 0x1f) {
            o << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
        } else {
            o << c;
        }
    }
    return o.str();
}

std::string SessionSummary::to_json() const {
    std::ostringstream ss;
    ss << "{\n";
    ss << "  \"session_id\": \"" << escape_json(session_id) << "\",\n";
    ss << "  \"patient_id\": \"" << escape_json(patient_id) << "\",\n";
    ss << "  \"ear\": \"" << escape_json(ear) << "\",\n";
    ss << "  \"notes\": \"" << escape_json(notes) << "\",\n";
    ss << "  \"timestamp\": \"" << escape_json(timestamp_str) << "\",\n";
    ss << "  \"timestamp_ms\": " << timestamp_ms << ",\n";
    ss << "  \"profile\": \"" << escape_json(profile_name) << "\",\n";
    ss << "  \"verdict\": \"" << escape_json(verdict) << "\",\n";
    ss << "  \"passed_count\": " << passed_count << ",\n";
    ss << "  \"total_active_frequencies\": " << total_active_frequencies << ",\n";
    ss << "  \"noise_check\": \"" << escape_json(noise_check_result) << "\",\n";
    ss << "  \"fit_check_passed\": " << (fit_check_passed ? "true" : "false") << ",\n";
    ss << "  \"vol_calib_passed\": " << (vol_calib_passed ? "true" : "false") << ",\n";
    ss << "  \"total_duration_seconds\": " << std::fixed << std::setprecision(2) << total_duration_seconds << ",\n";
    ss << "  \"frequencies\": [\n";

    for (size_t i = 0; i < results.size(); ++i) {
        const auto& r = results[i];
        ss << "    {\n";
        ss << "      \"f2\": " << r.f2 << ",\n";
        ss << "      \"f1\": " << r.f1 << ",\n";
        ss << "      \"oae_bin\": " << r.oae_bin << ",\n";
        ss << "      \"imd_bin\": " << r.imd_bin << ",\n";
        ss << "      \"signal_db\": " << std::fixed << std::setprecision(1) << r.signal_db << ",\n";
        ss << "      \"noise_db\": " << std::fixed << std::setprecision(1) << r.noise_db << ",\n";
        ss << "      \"snr_db\": " << std::fixed << std::setprecision(1) << r.snr_db << ",\n";
        ss << "      \"ambient_noise_db\": " << std::fixed << std::setprecision(1) << r.ambient_noise_db << ",\n";
        ss << "      \"segments_used\": " << r.segments_used << ",\n";
        ss << "      \"segments_rejected\": " << r.segments_rejected << ",\n";
        ss << "      \"pass\": " << (r.pass ? "true" : "false") << "\n";
        ss << "    }" << (i + 1 < results.size() ? "," : "") << "\n";
    }

    ss << "  ]\n";
    ss << "}\n";
    return ss.str();
}

SessionSummary SessionRunner::run_session(const std::string& patient_id,
                                         const std::string& ear,
                                         const std::string& output_dir,
                                         bool verbose,
                                         bool json_stream,
                                         const std::string& session_id,
                                         const std::string& notes,
                                         const std::atomic<bool>* stop_flag) {
    auto start_time = std::chrono::steady_clock::now();
    uint64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    // Timestamp formatting
    std::time_t now_c = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm_buf;
#if defined(_WIN32)
    localtime_s(&tm_buf, &now_c);
#else
    localtime_r(&now_c, &tm_buf);
#endif
    char time_str[64];
    std::strftime(time_str, sizeof(time_str), "%Y-%m-%d %H:%M:%S", &tm_buf);

    SessionSummary summary;
    summary.session_id = session_id;
    summary.patient_id = patient_id;
    summary.ear = ear;
    summary.notes = notes;
    summary.timestamp_str = time_str;
    summary.timestamp_ms = now_ms;
    summary.profile_name = config_.active_profile_name;

    auto active_pairs = config_.get_active_pairs();
    summary.total_active_frequencies = static_cast<uint32_t>(active_pairs.size());

    std::string base_filename = patient_id + "-" + ear + "-" + std::to_string(now_ms);

    if (json_stream) {
        std::cout << "{\"event\": \"started\", \"session_id\": \"" << escape_json(session_id)
                  << "\", \"patient_id\": \"" << escape_json(patient_id)
                  << "\", \"ear\": \"" << escape_json(ear)
                  << "\", \"notes\": \"" << escape_json(notes)
                  << "\", \"profile\": \"" << escape_json(config_.active_profile_name)
                  << "\", \"timestamp\": \"" << escape_json(time_str)
                  << "\", \"total_pairs\": " << active_pairs.size() << "}\n" << std::flush;
    } else if (verbose) {
        std::cout << "=========================================================\n";
        std::cout << "           OAE Buds — DPOAE Screening Test               \n";
        std::cout << "=========================================================\n";
        std::cout << "[INFO] Patient ID: " << patient_id << " (" << ear << " ear)\n";
        if (!session_id.empty()) std::cout << "[INFO] Session ID: " << session_id << "\n";
        std::cout << "[INFO] Hardware Profile: " << config_.active_profile_name << "\n";
        std::cout << "[INFO] Timestamp: " << time_str << "\n";
    }

    if (stop_flag && stop_flag->load()) {
        if (json_stream) {
            std::cout << "{\"event\": \"aborted\", \"reason\": \"Stop requested before start\"}\n" << std::flush;
        }
        summary.verdict = "Aborted";
        return summary;
    }

    // 1. Fit Check (optional)
    if (config_.fit_check.enabled) {
        if (json_stream) {
            std::cout << "{\"event\": \"phase_changed\", \"phase\": \"fit_check\"}\n" << std::flush;
        } else if (verbose) {
            std::cout << "[INFO] Running probe seal check (226 Hz tone)...\n";
        }

        calib::FitChecker checker(config_.fit_check, config_.audio.sample_rate);
        auto fit_tone = signal_gen::make_dual_tone(
            config_.fit_check.check_frequency_hz,
            config_.fit_check.check_frequency_hz,
            config_.audio.sample_rate,
            config_.audio.sample_rate / 2, // 0.5s loop
            config_.fit_check.tone_volume,
            config_.fit_check.tone_volume);

        audio_engine_.run_duplex_streaming(fit_tone, [&](std::span<const int16_t> chunk) {
            if (stop_flag && stop_flag->load()) return false;
            bool sealed = checker.process_buffer(chunk);
            return !sealed; // stop streaming when sealed
        });

        summary.fit_check_passed = checker.is_sealed();
        if (json_stream) {
            std::cout << "{\"event\": \"fit_check_result\", \"passed\": "
                      << (summary.fit_check_passed ? "true" : "false") << "}\n" << std::flush;
        } else if (verbose) {
            std::cout << "[INFO] Probe fit check: " << (summary.fit_check_passed ? "SEALED (Pass)" : "NOT SEALED") << "\n";
        }
    }

    if (stop_flag && stop_flag->load()) {
        if (json_stream) {
            std::cout << "{\"event\": \"aborted\", \"reason\": \"Stop requested during fit check\"}\n" << std::flush;
        }
        summary.verdict = "Aborted";
        return summary;
    }

    // 2. Volume Calibration (optional)
    if (config_.vol_calib.enabled) {
        if (json_stream) {
            std::cout << "{\"event\": \"phase_changed\", \"phase\": \"vol_calib\"}\n" << std::flush;
        } else if (verbose) {
            std::cout << "[INFO] Running in-ear volume calibration...\n";
        }

        auto calib_seq = signal_gen::make_calib_sequence(config_, config_.active_profile());
        size_t rx_len = (calib_seq.size() / 2) + static_cast<size_t>(config_.audio.sample_rate * config_.vol_calib.pad_duration_seconds);
        std::vector<int16_t> rx_calib(rx_len);

        audio_engine_.run_duplex_fixed(calib_seq, rx_calib);

        auto calib_res = calib::Calibrator::calibrate(rx_calib, config_, config_.profiles[config_.active_profile_name]);
        summary.vol_calib_passed = calib_res.success;
        if (json_stream) {
            std::cout << "{\"event\": \"vol_calib_result\", \"passed\": "
                      << (calib_res.success ? "true" : "false")
                      << ", \"chirp_latency_ms\": " << std::fixed << std::setprecision(1) << calib_res.chirp_latency_ms << "}\n" << std::flush;
        } else if (verbose) {
            std::cout << "[INFO] Chirp onset detected at sample: " << calib_res.chirp_onset_sample
                      << " (" << std::fixed << std::setprecision(1) << calib_res.chirp_latency_ms << " ms latency)\n";
        }
    }

    if (stop_flag && stop_flag->load()) {
        if (json_stream) {
            std::cout << "{\"event\": \"aborted\", \"reason\": \"Stop requested during calibration\"}\n" << std::flush;
        }
        summary.verdict = "Aborted";
        return summary;
    }

    // 3. Measure Active Frequency Pairs
    if (json_stream) {
        std::cout << "{\"event\": \"phase_changed\", \"phase\": \"frequency_sweep\"}\n" << std::flush;
    }

    uint32_t fs = config_.audio.sample_rate;
    uint32_t test_duration_sec = config_.test.constant_tone_seconds;
    uint32_t total_samples = test_duration_sec * fs; // e.g. 5 * 48000 = 240,000

    if (!output_dir.empty()) {
        std::filesystem::create_directories(output_dir);
    }

    for (size_t i = 0; i < active_pairs.size(); ++i) {
        if (stop_flag && stop_flag->load()) {
            if (json_stream) {
                std::cout << "{\"event\": \"aborted\", \"reason\": \"Stop requested during sweep\"}\n" << std::flush;
            }
            summary.verdict = "Aborted";
            return summary;
        }

        const auto& pair = active_pairs[i];
        if (json_stream) {
            std::cout << "{\"event\": \"frequency_measuring\", \"pair_index\": " << (i + 1)
                      << ", \"total_pairs\": " << active_pairs.size()
                      << ", \"f1\": " << pair.f1
                      << ", \"f2\": " << pair.f2 << "}\n" << std::flush;
        } else if (verbose) {
            std::cout << "[INFO] Measuring Pair [" << (i + 1) << "/" << active_pairs.size()
                      << "]: f1=" << pair.f1 << " Hz, f2=" << pair.f2 << " Hz (" << test_duration_sec << " s)...\n";
        }

        double v3a = 0.15;
        double v3b = 0.05;
        const auto& prof = config_.active_profile();
        auto it_a = prof.vol3.find(pair.f1);
        if (it_a != prof.vol3.end()) v3a = it_a->second;
        auto it_b = prof.vol3.find(pair.f2);
        if (it_b != prof.vol3.end()) v3b = it_b->second;

        auto tx_stereo = signal_gen::make_dual_tone(pair.f1, pair.f2, fs, total_samples, v3a, v3b);
        std::vector<int16_t> rx_mono(total_samples);

        audio_engine_.run_duplex_fixed(tx_stereo, rx_mono);

        if (stop_flag && stop_flag->load()) {
            if (json_stream) {
                std::cout << "{\"event\": \"aborted\", \"reason\": \"Stop requested during sweep\"}\n" << std::flush;
            }
            summary.verdict = "Aborted";
            return summary;
        }

        // Save raw WAV file
        if (!output_dir.empty()) {
            std::string wav_path = output_dir + "/" + base_filename + "-" + std::to_string(pair.f2) + ".wav";
            save_wav(wav_path, rx_mono, fs);
        }

        // Process DPOAE response
        auto dpoae_res = dsp::process_frequency_pair(rx_mono, pair, config_);
        summary.results.push_back(dpoae_res);

        if (dpoae_res.pass) {
            summary.passed_count++;
        }

        if (json_stream) {
            std::cout << "{\"event\": \"artifact_status\", \"pair_index\": " << (i + 1)
                      << ", \"segments_accepted\": " << dpoae_res.segments_used
                      << ", \"segments_rejected\": " << dpoae_res.segments_rejected
                      << ", \"status\": \"" << (dpoae_res.segments_rejected > 0 ? "artifact_retry" : "clear") << "\"}\n" << std::flush;

            std::cout << "{\"event\": \"frequency_result\", \"pair_index\": " << (i + 1)
                      << ", \"f1\": " << pair.f1
                      << ", \"f2\": " << pair.f2
                      << ", \"oae_bin\": " << dpoae_res.oae_bin
                      << ", \"signal_db\": " << std::fixed << std::setprecision(1) << dpoae_res.signal_db
                      << ", \"noise_db\": " << std::fixed << std::setprecision(1) << dpoae_res.noise_db
                      << ", \"snr_db\": " << std::fixed << std::setprecision(1) << dpoae_res.snr_db
                      << ", \"pass\": " << (dpoae_res.pass ? "true" : "false") << "}\n" << std::flush;
        } else if (verbose) {
            std::cout << "       -> Signal: " << std::fixed << std::setprecision(1) << dpoae_res.signal_db << " dB | "
                      << "Noise: " << dpoae_res.noise_db << " dB | "
                      << "SNR: " << dpoae_res.snr_db << " dB | "
                      << "Result: " << (dpoae_res.pass ? "PASS" : "FAIL") << "\n";
        }
    }

    // 4. Evaluate Pass / Refer
    summary.verdict = (summary.passed_count >= config_.test.pass_rule_min_frequencies) ? "Pass" : "Refer";

    // 5. Evaluate Noise Floor Thresholds
    int noisy_count = 0;
    for (size_t i = 0; i < summary.results.size() && i < config_.noise_thresholds.size(); ++i) {
        if (summary.results[i].noise_db >= config_.noise_thresholds[i]) {
            noisy_count++;
        }
    }
    summary.noise_check_result = (noisy_count >= 3) ? "retry" : "noise-pass";

    auto end_time = std::chrono::steady_clock::now();
    summary.total_duration_seconds = std::chrono::duration<double>(end_time - start_time).count();

    // 6. Save JSON report
    std::string saved_json_path = "";
    if (!output_dir.empty()) {
        saved_json_path = output_dir + "/" + base_filename + ".json";
        std::ofstream json_out(saved_json_path);
        if (json_out.is_open()) {
            json_out << summary.to_json();
            if (verbose && !json_stream) std::cout << "[INFO] Results saved to: " << saved_json_path << "\n";
        }
    }

    if (json_stream) {
        std::cout << "{\"event\": \"completed\", \"session_id\": \"" << escape_json(session_id)
                  << "\", \"patient_id\": \"" << escape_json(patient_id)
                  << "\", \"ear\": \"" << escape_json(ear)
                  << "\", \"verdict\": \"" << escape_json(summary.verdict)
                  << "\", \"passed_count\": " << summary.passed_count
                  << ", \"total_active_frequencies\": " << summary.total_active_frequencies
                  << ", \"duration_seconds\": " << std::fixed << std::setprecision(2) << summary.total_duration_seconds
                  << ", \"json_file\": \"" << escape_json(saved_json_path) << "\"}\n" << std::flush;
    } else if (verbose) {
        std::cout << "=========================================================\n";
        std::cout << "[FINAL RESULT] Verdict: " << summary.verdict
                  << " (" << summary.passed_count << "/" << summary.total_active_frequencies << " passed) | "
                  << "Noise check: " << summary.noise_check_result << "\n";
        std::cout << "=========================================================\n";
    }

    return summary;
}

} // namespace session
} // namespace oae
