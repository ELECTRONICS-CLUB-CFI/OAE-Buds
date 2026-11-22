#pragma once

#include "oae/audio_engine.hpp"
#include <vector>
#include <span>
#include <queue>
#include <cmath>
#include <algorithm>

namespace oae {
namespace test {

class MockAudioEngine : public audio::IAudioEngine {
public:
    bool is_open = false;
    std::vector<std::vector<int16_t>> captured_tx_calls;
    std::queue<std::vector<int16_t>> canned_rx_responses;

    // For streaming fit check: canned frames
    std::vector<std::vector<int16_t>> canned_streaming_chunks;

    bool open(uint32_t sample_rate = 48000,
              uint32_t channels_tx = 2,
              uint32_t channels_rx = 1,
              const std::string& device_name = "") override {
        is_open = true;
        return true;
    }

    void close() override {
        is_open = false;
    }

    void enqueue_response(std::vector<int16_t> resp) {
        canned_rx_responses.push(std::move(resp));
    }

    void run_duplex_fixed(std::span<const int16_t> tx_stereo,
                          std::span<int16_t> rx_mono) override {
        // Record what was sent
        captured_tx_calls.emplace_back(tx_stereo.begin(), tx_stereo.end());

        // Fill rx_mono
        if (!canned_rx_responses.empty()) {
            auto resp = canned_rx_responses.front();
            canned_rx_responses.pop();
            size_t copy_len = std::min(rx_mono.size(), resp.size());
            std::copy_n(resp.begin(), copy_len, rx_mono.begin());
            if (copy_len < rx_mono.size()) {
                std::fill(rx_mono.begin() + copy_len, rx_mono.end(), 0);
            }
        } else {
            // Default silence if no canned response
            std::fill(rx_mono.begin(), rx_mono.end(), 0);
        }
    }

    void run_duplex_streaming(
        std::span<const int16_t> tx_stereo_loop,
        std::function<bool(std::span<const int16_t>)> on_rx_chunk) override {
        captured_tx_calls.emplace_back(tx_stereo_loop.begin(), tx_stereo_loop.end());

        for (const auto& chunk : canned_streaming_chunks) {
            bool cont = on_rx_chunk(chunk);
            if (!cont) break;
        }
    }
};

} // namespace test
} // namespace oae
