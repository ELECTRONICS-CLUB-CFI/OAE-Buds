#include "oae/oae_config.hpp"
#include "oae/session_runner.hpp"
#include <iostream>
#include <string>
#include <memory>
#include <cmath>
#include <csignal>
#include <atomic>
#include <sstream>
#include <iomanip>
#include <algorithm>

// External factory for MiniaudioEngine
extern std::unique_ptr<oae::audio::IAudioEngine> make_audio_engine();

static std::atomic<oae::audio::IAudioEngine*> g_active_audio_engine{nullptr};
static std::atomic<bool> g_stop_requested{false};

void signal_handler(int sig) {
    (void)sig;
    g_stop_requested.store(true);
    auto* eng = g_active_audio_engine.load();
    if (eng) {
        eng->stop();
    }
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    std::string config_path = "config/oae_config.toml";
    std::string profile_name = "ugreen_80864_rpi5";
    std::string patient_id = "0";
    std::string ear = "left";
    std::string out_dir = "./results";
    std::string session_id = "";
    std::string notes = "";
    bool verbose = true;
    bool mock_mode = false;
    bool json_stream = false;
    bool dev_telemetry = false;
    bool tone_test_mode = false;
    oae::session::ToneTestConfig tone_opts;

    std::optional<bool> override_fit_check;
    std::optional<bool> override_vol_calib;
    std::optional<double> override_snr_threshold;
    std::optional<uint32_t> override_tone_seconds;
    std::optional<uint32_t> override_min_pass_freqs;
    std::optional<int32_t> override_amp_threshold;
    std::optional<double> override_art_threshold;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        } else if (arg == "--profile" && i + 1 < argc) {
            profile_name = argv[++i];
        } else if (arg == "--patient" && i + 1 < argc) {
            patient_id = argv[++i];
        } else if (arg == "--ear" && i + 1 < argc) {
            ear = argv[++i];
        } else if (arg == "--out-dir" && i + 1 < argc) {
            out_dir = argv[++i];
        } else if (arg == "--session-id" && i + 1 < argc) {
            session_id = argv[++i];
        } else if (arg == "--notes" && i + 1 < argc) {
            notes = argv[++i];
        } else if (arg == "--json-stream") {
            json_stream = true;
        } else if (arg == "--dev-telemetry") {
            dev_telemetry = true;
        } else if (arg == "--tone-test") {
            tone_test_mode = true;
        } else if (arg == "--channel" && i + 1 < argc) {
            tone_opts.channel = argv[++i];
        } else if (arg == "--freq" && i + 1 < argc) {
            tone_opts.freq_hz = std::stod(argv[++i]);
        } else if (arg == "--f2" && i + 1 < argc) {
            tone_opts.f2_hz = std::stod(argv[++i]);
        } else if (arg == "--duration" && i + 1 < argc) {
            tone_opts.duration_s = std::stod(argv[++i]);
        } else if (arg == "--amp" && i + 1 < argc) {
            tone_opts.amplitude = std::stod(argv[++i]);
        } else if (arg == "--snr-threshold" && i + 1 < argc) {
            override_snr_threshold = std::stod(argv[++i]);
        } else if (arg == "--tone-seconds" && i + 1 < argc) {
            override_tone_seconds = static_cast<uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--min-pass-freqs" && i + 1 < argc) {
            override_min_pass_freqs = static_cast<uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--amp-threshold" && i + 1 < argc) {
            override_amp_threshold = static_cast<int32_t>(std::stol(argv[++i]));
        } else if (arg == "--art-threshold" && i + 1 < argc) {
            override_art_threshold = std::stod(argv[++i]);
        } else if (arg == "--fit-check") {
            override_fit_check = true;
        } else if (arg == "--no-fit-check") {
            override_fit_check = false;
        } else if (arg == "--vol-calib") {
            override_vol_calib = true;
        } else if (arg == "--no-vol-calib") {
            override_vol_calib = false;
        } else if (arg == "--mock") {
            mock_mode = true;
        } else if (arg == "--quiet") {
            verbose = false;
        } else if (arg == "--verbose") {
            verbose = true;
        } else if (arg == "--help" || arg == "-h") {
            std::cout << "OAE Buds — Native Headless C++ DPOAE Screening Tool for Raspberry Pi 5\n\n"
                      << "Usage:\n"
                      << "  dpoae-rpi [options]\n\n"
                      << "Options:\n"
                      << "  --config <path>      Path to TOML configuration file (default: config/oae_config.toml)\n"
                      << "  --profile <name>     Hardware profile name (default: ugreen_80864_rpi5)\n"
                      << "  --patient <id>       Patient ID / identifier (default: 0)\n"
                      << "  --ear <left|right>   Ear under test (default: left)\n"
                      << "  --out-dir <path>     Directory to store JSON and WAV results (default: ./results)\n"
                      << "  --session-id <id>    Session tracking UUID for linking bilateral tests\n"
                      << "  --notes <text>       Clinical operator notes\n"
                      << "  --json-stream        Output NDJSON events to stdout with explicit flush\n"
                      << "  --dev-telemetry      Emit audio health stats & write FFT/envelope sidecar JSON\n"
                      << "  --tone-test          Run duplex playback/capture sanity check bench test\n"
                      << "  --channel <l|r|both> Tone-test channel routing (default: left)\n"
                      << "  --freq <hz>          Tone-test primary frequency in Hz (default: 1000)\n"
                      << "  --f2 <hz>            Optional secondary frequency in Hz for dual-tone test\n"
                      << "  --duration <sec>     Tone-test duration in seconds (default: 2.0)\n"
                      << "  --amp <0..0.6>       Tone-test amplitude (hard-clamped to 0.60 safety ceiling)\n"
                      << "  --fit-check          Force probe seal & occlusion check before test\n"
                      << "  --no-fit-check       Skip probe seal check\n"
                      << "  --vol-calib          Run in-ear volume calibration sequence\n"
                      << "  --no-vol-calib       Skip in-ear volume calibration\n"
                      << "  --mock               Simulate audio I/O with synthetic passing DPOAE responses (offline testing)\n"
                      << "  --quiet              Suppress verbose logging\n"
                      << "  --help, -h           Show this help message\n";
            return 0;
        }
    }

    std::string err;
    auto cfg_opt = oae::OaeConfig::load_from_file(config_path, profile_name, &err);
    if (!cfg_opt.has_value()) {
        if (json_stream) {
            std::cout << "{\"event\": \"error\", \"message\": \"" << err << "\"}\n" << std::flush;
        } else {
            std::cerr << "[ERROR] " << err << "\n";
        }
        return 1;
    }

    auto cfg = *cfg_opt;
    if (override_fit_check.has_value()) {
        cfg.fit_check.enabled = *override_fit_check;
    }
    if (override_vol_calib.has_value()) {
        cfg.vol_calib.enabled = *override_vol_calib;
    }
    if (override_snr_threshold.has_value()) {
        cfg.test.snr_threshold_db = *override_snr_threshold;
    }
    if (override_tone_seconds.has_value()) {
        cfg.test.constant_tone_seconds = std::clamp(*override_tone_seconds, 1u, 20u);
    }
    if (override_min_pass_freqs.has_value()) {
        cfg.test.pass_rule_min_frequencies = std::clamp(*override_min_pass_freqs, 1u, 4u);
    }
    if (override_amp_threshold.has_value()) {
        cfg.artifact.amp_threshold = std::max<int32_t>(1, *override_amp_threshold);
    }
    if (override_art_threshold.has_value()) {
        cfg.artifact.art_threshold_db = std::max(0.5, *override_art_threshold);
    }

    // Audio engine instantiation
    std::unique_ptr<oae::audio::IAudioEngine> audio_engine;
    if (mock_mode) {
        class CliMockAudio : public oae::audio::IAudioEngine {
        public:
            explicit CliMockAudio(bool tone_test) : tone_test_(tone_test) {}
            bool tone_test_ = false;
            std::atomic<bool> stop_requested_{false};
            std::vector<uint32_t> oae_freqs = {1264, 1923, 2579, 3187};
            size_t pair_idx = 0;
            bool open(uint32_t, uint32_t, uint32_t, const std::string&) override { return true; }
            void close() override {}
            void stop() override { stop_requested_.store(true); }
            void run_duplex_fixed(std::span<const int16_t> tx_stereo, std::span<int16_t> rx_mono) override {
                if (stop_requested_.load()) return;
                if (tone_test_) {
                    // Simulate acoustic loopback with ~10 ms (480 samples) delay and 0.25 attenuation
                    constexpr size_t delay = 480;
                    for (size_t s = 0; s < rx_mono.size(); ++s) {
                        if (stop_requested_.load()) break;
                        if (s < delay || (2 * (s - delay) + 1) >= tx_stereo.size()) {
                            rx_mono[s] = 0;
                        } else {
                            int32_t l = tx_stereo[2 * (s - delay)];
                            int32_t r = tx_stereo[2 * (s - delay) + 1];
                            rx_mono[s] = static_cast<int16_t>((l + r) / 4);
                        }
                    }
                    return;
                }
                if (rx_mono.size() < 240000) {
                    // Volume calibration or chirp sequence
                    std::fill(rx_mono.begin(), rx_mono.end(), 0);
                    return;
                }
                uint32_t freq = (pair_idx < oae_freqs.size()) ? oae_freqs[pair_idx++] : 1264;
                for (size_t s = 0; s < rx_mono.size(); ++s) {
                    if (stop_requested_.load()) break;
                    double phase = 2.0 * M_PI * freq * (static_cast<double>(s % 48000) / 48000.0);
                    rx_mono[s] = static_cast<int16_t>(250.0 * std::sin(phase));
                }
            }
            void run_duplex_streaming(std::span<const int16_t>, std::function<bool(std::span<const int16_t>)> on_rx) override {
                std::vector<int16_t> chunk(1000, 350);
                for (int i = 0; i < 26; ++i) {
                    if (stop_requested_.load()) break;
                    if (!on_rx(chunk)) break;
                }
            }
        };
        audio_engine = std::make_unique<CliMockAudio>(tone_test_mode);
    } else {
        extern std::unique_ptr<oae::audio::IAudioEngine> make_audio_engine();
        audio_engine = make_audio_engine();
    }

    if (!audio_engine->open(cfg.audio.sample_rate, 2, 1)) {
        if (json_stream) {
            std::cout << "{\"event\": \"error\", \"message\": \"Could not open duplex audio interface.\"}\n" << std::flush;
        } else {
            std::cerr << "[ERROR] Could not open duplex audio interface.\n";
        }
        return 1;
    }
    g_active_audio_engine.store(audio_engine.get());

    oae::session::SessionRunner runner(cfg, *audio_engine);

    if (tone_test_mode) {
        tone_opts.output_dir = out_dir;
        tone_opts.json_stream = json_stream;
        tone_opts.verbose = verbose;
        runner.run_tone_test(tone_opts, &g_stop_requested);
        audio_engine->close();
        g_active_audio_engine.store(nullptr);
        return g_stop_requested.load() ? 130 : 0;
    }

    auto summary = runner.run_session(
        patient_id, ear, out_dir, verbose, json_stream, session_id, notes, &g_stop_requested, dev_telemetry);

    audio_engine->close();
    g_active_audio_engine.store(nullptr);

    if (g_stop_requested.load() || summary.verdict == "Aborted") {
        return 130;
    }
    return (summary.verdict == "Pass") ? 0 : 2;
}
