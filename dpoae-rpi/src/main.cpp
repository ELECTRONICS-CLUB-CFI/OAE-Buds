#include "oae/oae_config.hpp"
#include "oae/session_runner.hpp"
#include <iostream>
#include <string>
#include <memory>

// External factory for MiniaudioEngine
extern std::unique_ptr<oae::audio::IAudioEngine> make_audio_engine();

int main(int argc, char* argv[]) {
    std::string config_path = "config/oae_config.toml";
    std::string profile_name = "ugreen_80864_rpi5";
    std::string patient_id = "0";
    std::string ear = "left";
    std::string out_dir = "./results";
    bool verbose = true;
    bool mock_mode = false;

    std::optional<bool> override_fit_check;
    std::optional<bool> override_vol_calib;

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
        std::cerr << "[ERROR] " << err << "\n";
        return 1;
    }

    auto cfg = *cfg_opt;
    if (override_fit_check.has_value()) {
        cfg.fit_check.enabled = *override_fit_check;
    }
    if (override_vol_calib.has_value()) {
        cfg.vol_calib.enabled = *override_vol_calib;
    }

    // Audio engine instantiation
    std::unique_ptr<oae::audio::IAudioEngine> audio_engine;
    if (mock_mode) {
        class CliMockAudio : public oae::audio::IAudioEngine {
        public:
            std::vector<uint32_t> oae_freqs = {1264, 1923, 2579, 3187};
            size_t pair_idx = 0;
            bool open(uint32_t, uint32_t, uint32_t, const std::string&) override { return true; }
            void close() override {}
            void run_duplex_fixed(std::span<const int16_t>, std::span<int16_t> rx_mono) override {
                if (rx_mono.size() < 240000) {
                    // Volume calibration or chirp sequence
                    std::fill(rx_mono.begin(), rx_mono.end(), 0);
                    return;
                }
                uint32_t freq = (pair_idx < oae_freqs.size()) ? oae_freqs[pair_idx++] : 1264;
                for (size_t s = 0; s < rx_mono.size(); ++s) {
                    double phase = 2.0 * M_PI * freq * (static_cast<double>(s % 48000) / 48000.0);
                    rx_mono[s] = static_cast<int16_t>(250.0 * std::sin(phase));
                }
            }
            void run_duplex_streaming(std::span<const int16_t>, std::function<bool(std::span<const int16_t>)> on_rx) override {
                std::vector<int16_t> chunk(1000, 350);
                for (int i = 0; i < 26; ++i) {
                    if (!on_rx(chunk)) break;
                }
            }
        };
        audio_engine = std::make_unique<CliMockAudio>();
    } else {
        extern std::unique_ptr<oae::audio::IAudioEngine> make_audio_engine();
        audio_engine = make_audio_engine();
    }

    if (!audio_engine->open(cfg.audio.sample_rate, 2, 1)) {
        std::cerr << "[ERROR] Could not open duplex audio interface.\n";
        return 1;
    }

    oae::session::SessionRunner runner(cfg, *audio_engine);
    auto summary = runner.run_session(patient_id, ear, out_dir, verbose);

    audio_engine->close();

    return (summary.verdict == "Pass") ? 0 : 2;
}
