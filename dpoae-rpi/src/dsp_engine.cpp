#include "oae/dsp_engine.hpp"
#include <cmath>
#include <complex>
#include <algorithm>
#include <numeric>
#include <iostream>

#ifdef OAE_USE_FFTW3
#include <fftw3.h>
#endif

namespace oae {
namespace dsp {

constexpr double EPSILON = 1e-12;

int32_t amp_check(std::span<const int16_t> samples) {
    int32_t max_avg = 0;
    int32_t counter = 0;
    int64_t sum_abs = 0;

    for (int16_t s : samples) {
        sum_abs += std::abs(static_cast<int32_t>(s));
        counter++;
        if (counter == 1000) {
            int32_t avg = static_cast<int32_t>(sum_abs / 1000);
            if (avg > max_avg) {
                max_avg = avg;
            }
            sum_abs = 0; // FIX: Reset accumulator for every 1000-sample block
            counter = 0;
        }
    }
    return max_avg;
}

double calc_art(const std::vector<double>& spec_power, uint32_t max_bin) {
    double sum = 0.0;
    uint32_t limit = std::min(max_bin, static_cast<uint32_t>(spec_power.size()));
    for (uint32_t i = 0; i < limit; ++i) {
        sum += 10.0 * std::log10(std::max(spec_power[i], EPSILON));
    }
    return (limit > 0) ? (sum / static_cast<double>(limit)) : 0.0;
}

SnrResult calc_snr(const std::vector<double>& spec_power, uint32_t seglen, uint32_t track_tone_bin) {
    (void)seglen;
    size_t bin = track_tone_bin;
    size_t spec_size = spec_power.size();

    if (bin >= spec_size) {
        return {0.0, 0.0, 0.0};
    }

    size_t tol = 2;
    size_t fwindow = 200;

    double signal_pwr = spec_power[bin];

    double noise_sum = 0.0;
    size_t noise_count = 0;

    // Left noise band: [bin - fwindow - tol, bin - tol]
    size_t left_start = (bin > fwindow + tol) ? (bin - fwindow - tol) : 0;
    size_t left_end = (bin > tol) ? (bin - tol) : 0;
    for (size_t i = left_start; i <= left_end && i < spec_size; ++i) {
        noise_sum += spec_power[i];
        noise_count++;
    }

    // Right noise band: [bin + tol, bin + tol + fwindow]
    size_t right_start = bin + tol;
    size_t right_end = std::min(bin + tol + fwindow, spec_size - 1);
    for (size_t i = right_start; i <= right_end; ++i) {
        noise_sum += spec_power[i];
        noise_count++;
    }

    double noise_pwr = (noise_count > 0) ? (noise_sum / static_cast<double>(noise_count)) : 1.0;

    double signal_db = 10.0 * std::log10(std::max(signal_pwr, EPSILON));
    double noise_db = 10.0 * std::log10(std::max(noise_pwr, EPSILON));
    double snr_db = signal_db - noise_db;

    return {signal_db, noise_db, snr_db};
}

// Built-in Bluestein / Cooley-Tukey Fallback FFT for zero-dependency builds
namespace fallback_fft {
    static void fft_radix2(std::vector<std::complex<double>>& a, bool invert) {
        size_t n = a.size();
        for (size_t i = 1, j = 0; i < n; i++) {
            size_t bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) std::swap(a[i], a[j]);
        }
        for (size_t len = 2; len <= n; len <<= 1) {
            double ang = 2.0 * M_PI / len * (invert ? -1 : 1);
            std::complex<double> wlen(std::cos(ang), std::sin(ang));
            for (size_t i = 0; i < n; i += len) {
                std::complex<double> w(1);
                for (size_t j = 0; j < len / 2; j++) {
                    std::complex<double> u = a[i + j];
                    std::complex<double> v = a[i + j + len / 2] * w;
                    a[i + j] = u + v;
                    a[i + j + len / 2] = u - v;
                    w *= wlen;
                }
            }
        }
        if (invert) {
            for (auto& x : a) x /= static_cast<double>(n);
        }
    }

    static size_t next_pow2(size_t n) {
        size_t p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    // Bluestein's Chirp-Z algorithm: computes exact DFT for arbitrary size N in O(M log M)
    static std::vector<std::complex<double>> dft_bluestein(const std::vector<std::complex<double>>& x, bool invert) {
        size_t n = x.size();
        size_t m = next_pow2(2 * n - 1);

        std::vector<std::complex<double>> a(m, 0.0);
        std::vector<std::complex<double>> b(m, 0.0);

        double sgn = invert ? 1.0 : -1.0;
        std::vector<std::complex<double>> w(n);
        for (size_t i = 0; i < n; ++i) {
            double angle = sgn * M_PI * (static_cast<double>(i * i % (2 * n))) / static_cast<double>(n);
            w[i] = std::complex<double>(std::cos(angle), std::sin(angle));
            a[i] = x[i] * w[i];
            b[i] = std::conj(w[i]);
            if (i > 0) {
                b[m - i] = b[i];
            }
        }

        fft_radix2(a, false);
        fft_radix2(b, false);
        for (size_t i = 0; i < m; ++i) a[i] *= b[i];
        fft_radix2(a, true);

        std::vector<std::complex<double>> y(n);
        for (size_t i = 0; i < n; ++i) {
            y[i] = a[i] * w[i];
            if (invert) y[i] /= static_cast<double>(n);
        }
        return y;
    }
} // namespace fallback_fft

std::vector<double> compute_power_spectrum(const std::vector<double>& time_data) {
    size_t n = time_data.size();
    size_t half_n = n / 2 + 1;
    std::vector<double> power(half_n);

#ifdef OAE_USE_FFTW3
    double* in = fftw_alloc_real(n);
    fftw_complex* out = fftw_alloc_complex(half_n);
    fftw_plan plan = fftw_plan_dft_r2c_1d(static_cast<int>(n), in, out, FFTW_ESTIMATE);

    std::copy_n(time_data.data(), n, in);
    fftw_execute(plan);

    for (size_t i = 0; i < half_n; ++i) {
        double r = out[i][0];
        double c = out[i][1];
        power[i] = r * r + c * c;
    }

    fftw_destroy_plan(plan);
    fftw_free(in);
    fftw_free(out);
#else
    std::vector<std::complex<double>> cx(n);
    for (size_t i = 0; i < n; ++i) cx[i] = time_data[i];
    auto dft_res = fallback_fft::dft_bluestein(cx, false);
    for (size_t i = 0; i < half_n; ++i) {
        power[i] = std::norm(dft_res[i]);
    }
#endif

    return power;
}

std::vector<double> compute_magnitude_spectrum(const std::vector<double>& time_data) {
    auto pwr = compute_power_spectrum(time_data);
    std::vector<double> mag(pwr.size());
    for (size_t i = 0; i < pwr.size(); ++i) {
        mag[i] = std::sqrt(pwr[i]);
    }
    return mag;
}

std::vector<double> xcorr_fft(const std::vector<double>& preamble, const std::vector<double>& signal) {
    size_t sig_len = signal.size();
    size_t n = sig_len;

    std::vector<std::complex<double>> a_cx(n, 0.0);
    std::vector<std::complex<double>> b_cx(n, 0.0);

    for (size_t i = 0; i < preamble.size() && i < n; ++i) a_cx[i] = preamble[i];
    for (size_t i = 0; i < signal.size() && i < n; ++i) b_cx[i] = signal[i];

    auto A = fallback_fft::dft_bluestein(a_cx, false);
    auto B = fallback_fft::dft_bluestein(b_cx, false);

    for (size_t i = 0; i < n; ++i) {
        // Cross-correlation: B * conj(A) gives peak at positive lag when signal B is delayed relative to preamble A
        B[i] = B[i] * std::conj(A[i]);
    }

    auto ifft_res = fallback_fft::dft_bluestein(B, true);

    std::vector<double> corr(n);
    for (size_t i = 0; i < n; ++i) {
        corr[i] = ifft_res[i].real();
    }
    return corr;
}

DpoaeResult process_frequency_pair(std::span<const int16_t> raw_recording,
                                   const FrequencyPair& pair,
                                   const OaeConfig& config) {
    uint32_t seglen = config.audio.process_window_length(); // 48000
    uint32_t trim_len = config.audio.init_trim_length();     // 48000

    DpoaeResult result;
    result.f2 = pair.f2;
    result.f1 = pair.f1;
    result.oae_bin = pair.oae_bin;
    result.imd_bin = pair.imd_bin;

    if (raw_recording.size() <= trim_len + seglen) {
        return result;
    }

    uint32_t numsegs = static_cast<uint32_t>((raw_recording.size() - trim_len) / seglen);
    size_t cc = trim_len;

    std::vector<double> sumbuffer(seglen, 0.0);
    std::vector<double> avbuffer(seglen, 0.0);
    uint32_t segcounter = 0;

    std::vector<double> spec_power;
    std::vector<double> snrs;
    std::vector<double> arts;

    uint32_t rejected_count = 0;

    for (uint32_t i = 0; i < numsegs; ++i) {
        std::span<const int16_t> block = raw_recording.subspan(cc, seglen);
        cc += seglen;
        segcounter += 1;

        for (uint32_t j = 0; j < seglen; ++j) {
            sumbuffer[j] += block[j];
            avbuffer[j] = sumbuffer[j] / segcounter;
        }

        spec_power = compute_power_spectrum(avbuffer);
        SnrResult snr_res = calc_snr(spec_power, seglen, pair.oae_bin);
        double art = calc_art(spec_power, 6000);

        bool ignore = false;
        if (!arts.empty()) {
            if (config.artifact.enabled &&
                (art - arts.back() >= config.artifact.art_threshold_db ||
                 snr_res.snr_db < config.artifact.snr_floor_db ||
                 (art < arts.back() && snr_res.snr_db < snrs.back()))) {
                ignore = true;
            }
        } else {
            // First block: evaluate time-domain amplitude
            int32_t initial_amp = amp_check(block);
            if (config.artifact.enabled && initial_amp > config.artifact.amp_threshold) {
                ignore = true;
            }
        }

        if (ignore) {
            rejected_count++;
            segcounter -= 1;
            for (uint32_t j = 0; j < seglen; ++j) {
                sumbuffer[j] -= block[j];
            }
            if (segcounter > 0) {
                for (uint32_t j = 0; j < seglen; ++j) {
                    avbuffer[j] = sumbuffer[j] / segcounter;
                }
                spec_power = compute_power_spectrum(avbuffer);
            }
        } else {
            arts.push_back(art);
            snrs.push_back(snr_res.snr_db);
        }
    }

    if (segcounter == 0) {
        // Fallback if all were rejected: use last available raw block
        return result;
    }

    // Final evaluation on the coherently averaged spectrum
    SnrResult calc_oae = calc_snr(spec_power, seglen, pair.oae_bin);
    SnrResult calc_imd = calc_snr(spec_power, seglen, pair.imd_bin);

    // Ambient noise in [0, 1000 Hz)
    double ambient_sum = 0.0;
    for (size_t i = 0; i < 1000 && i < spec_power.size(); ++i) {
        ambient_sum += 10.0 * std::log10(std::max(spec_power[i], EPSILON));
    }
    result.ambient_noise_db = ambient_sum / 1000.0;

    double snr1 = calc_oae.signal_db - calc_oae.noise_db;
    double snr2 = calc_imd.signal_db - calc_imd.noise_db;

    double sig = 0.0;
    double noise = 0.0;

    if (snr2 > config.artifact.imd_threshold) {
        sig = snr1;
        noise = snr2;
    } else {
        sig = calc_oae.signal_db;
        noise = calc_oae.noise_db;
    }

    double final_snr = std::ceil(sig - noise);

    result.signal_db = sig;
    result.noise_db = noise;
    result.snr_db = final_snr;
    result.segments_used = segcounter;
    result.segments_rejected = rejected_count;
    result.pass = (final_snr >= config.test.snr_threshold_db);

    return result;
}

} // namespace dsp
} // namespace oae
