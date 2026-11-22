#pragma once

#include <vector>
#include <span>
#include <cstdint>
#include <functional>
#include <string>

namespace oae {
namespace audio {

// Abstract duplex audio interface enabling deterministic mock testing offline
// and native ALSA / miniaudio execution on Raspberry Pi 5
class IAudioEngine {
public:
    virtual ~IAudioEngine() = default;

    // Initialize and open audio device
    virtual bool open(uint32_t sample_rate = 48000,
                      uint32_t channels_tx = 2,
                      uint32_t channels_rx = 1,
                      const std::string& device_name = "") = 0;

    // Play stereo tx_buffer while capturing mono into rx_buffer (fixed duration)
    // Synchronous call; blocks until tx has finished playing and rx has filled
    virtual void run_duplex_fixed(std::span<const int16_t> tx_stereo,
                                 std::span<int16_t> rx_mono) = 0;

    // Play looped stereo tx while continuously streaming captured mono frames
    // to the on_rx_chunk callback. Callback returns true to continue, false to stop.
    virtual void run_duplex_streaming(
        std::span<const int16_t> tx_stereo_loop,
        std::function<bool(std::span<const int16_t>)> on_rx_chunk) = 0;

    // Immediately interrupt and mute ongoing audio playback/recording
    virtual void stop() {}

    virtual void close() = 0;
};

} // namespace audio
} // namespace oae
