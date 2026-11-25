#include "oae/audio_engine.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <cstring>
#include <cstdio>
#include <cctype>
#include <thread>
#include <chrono>
#include <atomic>
#include <algorithm>

#if __has_include("miniaudio.h")
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_PULSEAUDIO
#define MA_NO_JACK
#include "miniaudio.h"

namespace oae {
namespace audio {

class MiniaudioEngine : public IAudioEngine {
public:
    MiniaudioEngine() = default;
    ~MiniaudioEngine() override { close(); }

    bool open(uint32_t sample_rate = 48000,
              uint32_t channels_tx = 2,
              uint32_t channels_rx = 1,
              const std::string& device_name = "") override {
        sample_rate_ = sample_rate;
        channels_tx_ = channels_tx;
        channels_rx_ = channels_rx;
        device_name_ = device_name;

        if (ma_context_init(nullptr, 0, nullptr, &context_) != MA_SUCCESS) {
            std::cerr << "[ERROR] Failed to initialize miniaudio context.\n";
            return false;
        }

        context_initialized_ = true;
        resolve_audio_devices();
        return true;
    }

    void stop() override {
        // Async-signal-safe: wake polling loops; main thread stops and uninits device.
        stop_requested_.store(true);
        streaming_keep_running_.store(false);
    }

    void close() override {
        if (device_started_) {
            ma_device_stop(&device_);
            ma_device_uninit(&device_);
            device_started_ = false;
        }
        if (context_initialized_) {
            ma_context_uninit(&context_);
            context_initialized_ = false;
        }
    }

    void run_duplex_fixed(std::span<const int16_t> tx_stereo,
                          std::span<int16_t> rx_mono) override {
        stop_requested_ = false;
        if (!context_initialized_) {
            open(sample_rate_, channels_tx_, channels_rx_, device_name_);
        }

        tx_ptr_ = tx_stereo.data();
        tx_frames_remaining_ = tx_stereo.size() / channels_tx_;
        rx_ptr_ = rx_mono.data();
        rx_frames_remaining_ = rx_mono.size() / channels_rx_;
        streaming_mode_ = false;

        if (!init_duplex_device()) {
            return;
        }

        device_started_ = true;
        ma_device_start(&device_);

        // Wait until all rx frames are captured or stop requested
        while (rx_frames_remaining_ > 0 && !stop_requested_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        ma_device_stop(&device_);
        ma_device_uninit(&device_);
        device_started_ = false;
    }

    void run_duplex_streaming(
        std::span<const int16_t> tx_stereo_loop,
        std::function<bool(std::span<const int16_t>)> on_rx_chunk) override {
        stop_requested_ = false;
        if (!context_initialized_) {
            open(sample_rate_, channels_tx_, channels_rx_, device_name_);
        }

        tx_loop_ptr_ = tx_stereo_loop.data();
        tx_loop_frames_ = tx_stereo_loop.size() / channels_tx_;
        tx_loop_idx_ = 0;
        on_rx_chunk_ = std::move(on_rx_chunk);
        streaming_mode_ = true;
        streaming_keep_running_ = true;

        if (!init_duplex_device()) {
            return;
        }

        device_started_ = true;
        ma_device_start(&device_);

        while (streaming_keep_running_.load() && !stop_requested_.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        ma_device_stop(&device_);
        ma_device_uninit(&device_);
        device_started_ = false;
    }

private:
    static std::string to_lower_str(std::string s) {
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        return s;
    }

    static bool is_usb_audio_name(const std::string& name) {
        std::string lower = to_lower_str(name);
        return lower.find("ugreen") != std::string::npos ||
               lower.find("usb audio") != std::string::npos ||
               lower.find("usb pnp") != std::string::npos ||
               lower.find("c-media") != std::string::npos;
    }

    static int detect_usb_card_from_proc_asound() {
        std::ifstream cards("/proc/asound/cards");
        if (!cards.is_open()) return -1;
        std::string line;
        while (std::getline(cards, line)) {
            if (is_usb_audio_name(line)) {
                std::istringstream iss(line);
                int idx = -1;
                if (iss >> idx && idx >= 0) {
                    return idx;
                }
            }
        }
        return -1;
    }

    void resolve_audio_devices() {
        has_playback_id_ = false;
        has_capture_id_ = false;
        detected_alsa_card_ = -1;

        if (!device_name_.empty()) {
            ma_device_info* pPlayback = nullptr;
            ma_uint32 playbackCount = 0;
            ma_device_info* pCapture = nullptr;
            ma_uint32 captureCount = 0;
            std::string target_lower = to_lower_str(device_name_);

            if (ma_context_get_devices(&context_, &pPlayback, &playbackCount, &pCapture, &captureCount) == MA_SUCCESS) {
                for (ma_uint32 i = 0; i < playbackCount; ++i) {
                    if (to_lower_str(pPlayback[i].name).find(target_lower) != std::string::npos ||
                        to_lower_str(pPlayback[i].id.alsa) == target_lower) {
                        playback_id_ = pPlayback[i].id;
                        has_playback_id_ = true;
                        break;
                    }
                }
                for (ma_uint32 i = 0; i < captureCount; ++i) {
                    if (to_lower_str(pCapture[i].name).find(target_lower) != std::string::npos ||
                        to_lower_str(pCapture[i].id.alsa) == target_lower) {
                        capture_id_ = pCapture[i].id;
                        has_capture_id_ = true;
                        break;
                    }
                }
            }

            if (!has_playback_id_) {
                std::snprintf(playback_id_.alsa, sizeof(playback_id_.alsa), "%s", device_name_.c_str());
                has_playback_id_ = true;
            }
            if (!has_capture_id_) {
                std::snprintf(capture_id_.alsa, sizeof(capture_id_.alsa), "%s", device_name_.c_str());
                has_capture_id_ = true;
            }
            return;
        }

        // Auto-detect USB / UGREEN audio card via miniaudio ALSA enumeration first
        ma_device_info* pPlayback = nullptr;
        ma_uint32 playbackCount = 0;
        ma_device_info* pCapture = nullptr;
        ma_uint32 captureCount = 0;

        if (ma_context_get_devices(&context_, &pPlayback, &playbackCount, &pCapture, &captureCount) == MA_SUCCESS) {
            for (ma_uint32 i = 0; i < playbackCount; ++i) {
                if (is_usb_audio_name(pPlayback[i].name)) {
                    playback_id_ = pPlayback[i].id;
                    has_playback_id_ = true;
                    break;
                }
            }
            for (ma_uint32 i = 0; i < captureCount; ++i) {
                if (is_usb_audio_name(pCapture[i].name)) {
                    capture_id_ = pCapture[i].id;
                    has_capture_id_ = true;
                    break;
                }
            }
        }

        detected_alsa_card_ = detect_usb_card_from_proc_asound();
        if (detected_alsa_card_ >= 0) {
            if (!has_playback_id_) {
                std::snprintf(playback_id_.alsa, sizeof(playback_id_.alsa), ":%d,0", detected_alsa_card_);
                has_playback_id_ = true;
            }
            if (!has_capture_id_) {
                std::snprintf(capture_id_.alsa, sizeof(capture_id_.alsa), ":%d,0", detected_alsa_card_);
                has_capture_id_ = true;
            }
        }
    }

    bool init_duplex_device() {
        ma_device_config config = ma_device_config_init(ma_device_type_duplex);
        config.sampleRate = sample_rate_;
        config.playback.format = ma_format_s16;
        config.playback.channels = channels_tx_;
        config.playback.pDeviceID = has_playback_id_ ? &playback_id_ : nullptr;
        config.playback.shareMode = ma_share_mode_exclusive;
        config.capture.format = ma_format_s16;
        config.capture.channels = channels_rx_;
        config.capture.pDeviceID = has_capture_id_ ? &capture_id_ : nullptr;
        config.capture.shareMode = ma_share_mode_exclusive;
        config.dataCallback = data_callback;
        config.pUserData = this;

        config.alsa.noAutoFormat = MA_TRUE;
        config.alsa.noAutoChannels = MA_TRUE;
        config.alsa.noAutoResample = MA_TRUE;

        if (ma_device_init(&context_, &config, &device_) == MA_SUCCESS) {
            return true;
        }

        // Fallback: retry via ALSA plughw (handles hardware channel/format differences)
        if (detected_alsa_card_ >= 0 || (has_playback_id_ && playback_id_.alsa[0] == ':')) {
            ma_device_id plug_pb{};
            ma_device_id plug_cap{};
            if (detected_alsa_card_ >= 0) {
                std::snprintf(plug_pb.alsa, sizeof(plug_pb.alsa), "plughw:%d,0", detected_alsa_card_);
                std::snprintf(plug_cap.alsa, sizeof(plug_cap.alsa), "plughw:%d,0", detected_alsa_card_);
            } else {
                std::snprintf(plug_pb.alsa, sizeof(plug_pb.alsa), "plughw%.248s", playback_id_.alsa);
                if (has_capture_id_ && capture_id_.alsa[0] == ':') {
                    std::snprintf(plug_cap.alsa, sizeof(plug_cap.alsa), "plughw%.248s", capture_id_.alsa);
                } else {
                    plug_cap = capture_id_;
                }
            }
            config.playback.pDeviceID = &plug_pb;
            config.capture.pDeviceID = &plug_cap;
            config.playback.shareMode = ma_share_mode_shared;
            config.capture.shareMode = ma_share_mode_shared;
            config.alsa.noAutoFormat = MA_FALSE;
            config.alsa.noAutoChannels = MA_FALSE;
            config.alsa.noAutoResample = MA_FALSE;

            if (ma_device_init(&context_, &config, &device_) == MA_SUCCESS) {
                return true;
            }
        }

        std::cerr << "[ERROR] Failed to initialize duplex audio device";
        if (has_playback_id_) {
            std::cerr << " (playback='" << playback_id_.alsa << "', capture='" << capture_id_.alsa << "')";
        }
        std::cerr << ".\n";
        return false;
    }
    static void data_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
        auto* engine = static_cast<MiniaudioEngine*>(pDevice->pUserData);

        // 1. Playback Handling
        if (pOutput) {
            int16_t* out = static_cast<int16_t*>(pOutput);
            if (!engine->streaming_mode_) {
                ma_uint32 frames_to_write = std::min(frameCount, static_cast<ma_uint32>(engine->tx_frames_remaining_));
                if (frames_to_write > 0 && engine->tx_ptr_) {
                    std::memcpy(out, engine->tx_ptr_, frames_to_write * engine->channels_tx_ * sizeof(int16_t));
                    engine->tx_ptr_ += frames_to_write * engine->channels_tx_;
                    engine->tx_frames_remaining_ -= frames_to_write;
                }
                if (frames_to_write < frameCount) {
                    std::memset(out + (frames_to_write * engine->channels_tx_), 0,
                                (frameCount - frames_to_write) * engine->channels_tx_ * sizeof(int16_t));
                }
            } else {
                // Looped playback
                ma_uint32 written = 0;
                while (written < frameCount && engine->tx_loop_frames_ > 0) {
                    ma_uint32 chunk = std::min(frameCount - written, static_cast<ma_uint32>(engine->tx_loop_frames_ - engine->tx_loop_idx_));
                    std::memcpy(out + (written * engine->channels_tx_),
                                engine->tx_loop_ptr_ + (engine->tx_loop_idx_ * engine->channels_tx_),
                                chunk * engine->channels_tx_ * sizeof(int16_t));
                    written += chunk;
                    engine->tx_loop_idx_ = (engine->tx_loop_idx_ + chunk) % engine->tx_loop_frames_;
                }
            }
        }

        // 2. Capture Handling
        if (pInput) {
            const int16_t* in = static_cast<const int16_t*>(pInput);
            if (!engine->streaming_mode_) {
                ma_uint32 frames_to_read = std::min(frameCount, static_cast<ma_uint32>(engine->rx_frames_remaining_));
                if (frames_to_read > 0 && engine->rx_ptr_) {
                    std::memcpy(engine->rx_ptr_, in, frames_to_read * engine->channels_rx_ * sizeof(int16_t));
                    engine->rx_ptr_ += frames_to_read * engine->channels_rx_;
                    engine->rx_frames_remaining_ -= frames_to_read;
                }
            } else {
                if (engine->on_rx_chunk_) {
                    bool cont = engine->on_rx_chunk_(std::span<const int16_t>(in, frameCount * engine->channels_rx_));
                    if (!cont) {
                        engine->streaming_keep_running_ = false;
                    }
                }
            }
        }
    }

    uint32_t sample_rate_ = 48000;
    uint32_t channels_tx_ = 2;
    uint32_t channels_rx_ = 1;
    std::string device_name_;

    ma_context context_{};
    ma_device device_{};
    ma_device_id playback_id_{};
    ma_device_id capture_id_{};
    bool has_playback_id_ = false;
    bool has_capture_id_ = false;
    int detected_alsa_card_ = -1;
    bool context_initialized_ = false;
    bool device_started_ = false;

    // Fixed run state
    const int16_t* tx_ptr_ = nullptr;
    std::atomic<size_t> tx_frames_remaining_{0};
    int16_t* rx_ptr_ = nullptr;
    std::atomic<size_t> rx_frames_remaining_{0};

    // Streaming state
    bool streaming_mode_ = false;
    std::atomic<bool> streaming_keep_running_{false};
    std::atomic<bool> stop_requested_{false};
    const int16_t* tx_loop_ptr_ = nullptr;
    size_t tx_loop_frames_ = 0;
    size_t tx_loop_idx_ = 0;
    std::function<bool(std::span<const int16_t>)> on_rx_chunk_;
};

} // namespace audio
} // namespace oae

#else

// Fallback stub for dev environments where miniaudio.h is vendored on Raspberry Pi
namespace oae {
namespace audio {

class MiniaudioEngine : public IAudioEngine {
public:
    bool open(uint32_t = 48000, uint32_t = 2, uint32_t = 1, const std::string& = "") override {
        return true;
    }
    void close() override {}
    void run_duplex_fixed(std::span<const int16_t>, std::span<int16_t> rx_mono) override {
        std::fill(rx_mono.begin(), rx_mono.end(), 0);
    }
    void run_duplex_streaming(std::span<const int16_t>, std::function<bool(std::span<const int16_t>)>) override {}
};

} // namespace audio
} // namespace oae

#endif

#include <memory>
std::unique_ptr<oae::audio::IAudioEngine> make_audio_engine() {
    return std::make_unique<oae::audio::MiniaudioEngine>();
}

