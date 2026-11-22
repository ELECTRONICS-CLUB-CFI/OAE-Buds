#pragma once

#include <vector>
#include <cstdint>
#include "oae_config.hpp"

namespace oae {
namespace signal_gen {

// Phase normalization to [0, 2*PI) matching AngularMath.Normalize()
double normalize_phase(double angle);

// Generate single-channel sine wave (signed 16-bit PCM scaled by 32000.0 * vol)
std::vector<int16_t> make_sine_wave(uint32_t num_samples, double freq, uint32_t sampling_freq, double vol);

// Generate interleaved stereo dual-tone: Left = f1, Right = f2
// Buffer length is 2 * num_samples
std::vector<int16_t> make_dual_tone(double f1, double f2, uint32_t sampling_freq,
                                    uint32_t num_samples, double v1, double v2);

// Generate mono linear chirp: f(t) = start_freq + ((end_freq - start_freq) / time) * t
std::vector<int16_t> make_linear_chirp(double start_freq, double end_freq,
                                       double duration_sec, uint32_t sampling_freq,
                                       double initial_phase = 0.0, double scale = 1.0);

// Generate interleaved stereo chirp (same signal on Left and Right)
std::vector<int16_t> make_stereo_chirp(double start_freq, double end_freq,
                                       double duration_sec, uint32_t sampling_freq,
                                       double initial_phase = 0.0, double scale = 1.0);

// Generate full calibration sequence for in-ear volume calibration:
// [4800 pad samples] + [0.1 s chirp preamble] + [8 x 0.2 s calibration pulses]
std::vector<int16_t> make_calib_sequence(const OaeConfig& config, const DeviceProfile& profile);

} // namespace signal_gen
} // namespace oae
