#pragma once

#include <vector>
#include <span>
#include <cstdint>
#include <utility>
#include "oae_config.hpp"

namespace oae {
namespace dsp {

struct SnrResult {
    double signal_db = 0.0;
    double noise_db = 0.0;
    double snr_db = 0.0;
};

struct DpoaeResult {
    uint32_t f2 = 0;
    uint32_t f1 = 0;
    uint32_t oae_bin = 0;
    uint32_t imd_bin = 0;

    double signal_db = 0.0;
    double noise_db = 0.0;
    double snr_db = 0.0;
    double ambient_noise_db = 0.0;

    bool pass = false;
    uint32_t segments_used = 0;
    uint32_t segments_rejected = 0;
};

// Amplitude check matching Signal.ampCheck() with BUG FIX:
// Accurately resets summer=0 every 1000 samples and sums absolute values
int32_t amp_check(std::span<const int16_t> samples);

// Compute broadband artifact metric matching Signal.calcArt():
// Mean 10*log10(power) over bins [0, max_bin)
double calc_art(const std::vector<double>& spec_power, uint32_t max_bin = 6000);

// Calculate SNR matching Signal.calcSNR():
// Evaluates power at track_tone_bin vs. +/-200 Hz sideband average (with +/-2 bin guard)
SnrResult calc_snr(const std::vector<double>& spec_power, uint32_t seglen, uint32_t track_tone_bin);

struct AudioHealthMetrics {
    double peak_dbfs = -120.0;
    double rms_dbfs = -120.0;
    uint32_t clipped_samples = 0;
};

struct WaveformEnvelope {
    std::vector<int16_t> min_vals;
    std::vector<int16_t> max_vals;
};

struct DecimatedSpectrum {
    std::vector<double> freqs_hz;
    std::vector<double> magnitudes_db;
};

// Compute peak dBFS, RMS dBFS, and clipped sample count (|s| >= 32767)
AudioHealthMetrics compute_audio_health(std::span<const int16_t> samples);

// Downsample time-domain signal into min/max envelope buckets for UI plotting
WaveformEnvelope compute_waveform_envelope(std::span<const int16_t> samples, size_t target_points = 500);

// Peak-hold decimation of power spectrum into dB magnitudes across [min_hz, max_hz]
DecimatedSpectrum decimate_spectrum_db(const std::vector<double>& spec_power,
                                       uint32_t sample_rate,
                                       double min_hz = 500.0,
                                       double max_hz = 6000.0,
                                       size_t num_points = 512);

// Coherent averaging, artifact rejection, power spectrum, and DPOAE SNR evaluation
// Implements the complete Signal.work() pipeline from Android Java
DpoaeResult process_frequency_pair(std::span<const int16_t> raw_recording,
                                   const FrequencyPair& pair,
                                   const OaeConfig& config,
                                   std::vector<double>* out_spec_power = nullptr);

// Real-to-complex FFT returning squared magnitude (power spectrum) of length N/2 + 1
std::vector<double> compute_power_spectrum(const std::vector<double>& time_data);

// Linear magnitude spectrum for calibration
std::vector<double> compute_magnitude_spectrum(const std::vector<double>& time_data);

// Cross-correlation of preamble and signal via FFT/IFFT:
// Returns real cross-correlation array of length sig_len
std::vector<double> xcorr_fft(const std::vector<double>& preamble,
                              const std::vector<double>& signal);

} // namespace dsp
} // namespace oae
