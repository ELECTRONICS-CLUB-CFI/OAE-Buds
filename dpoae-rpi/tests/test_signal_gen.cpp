#if __has_include(<gtest/gtest.h>)
#include <gtest/gtest.h>
#else
#include "mini_gtest.hpp"
#endif

#include "oae/signal_gen.hpp"
#include <cmath>
#include <numeric>

TEST(SignalGenTest, PhaseNormalization) {
    constexpr double PI = 3.14159265358979323846;
    EXPECT_NEAR(oae::signal_gen::normalize_phase(0.0), 0.0, 1e-6);
    EXPECT_NEAR(oae::signal_gen::normalize_phase(2.0 * PI), 0.0, 1e-6);
    EXPECT_NEAR(oae::signal_gen::normalize_phase(3.0 * PI), PI, 1e-6);
    EXPECT_NEAR(oae::signal_gen::normalize_phase(-PI), PI, 1e-6);
    EXPECT_NEAR(oae::signal_gen::normalize_phase(4.0 * PI + 0.5), 0.5, 1e-6);
}

TEST(SignalGenTest, SingleSineWaveGeneration) {
    uint32_t fs = 48000;
    uint32_t len = 48000; // 1 second
    double freq = 1000.0;
    double vol = 0.5;

    auto sine = oae::signal_gen::make_sine_wave(len, freq, fs, vol);
    ASSERT_EQ(sine.size(), len);

    // Max absolute sample should be close to 32000 * 0.5 = 16000
    int16_t max_val = 0;
    for (int16_t s : sine) {
        max_val = std::max(max_val, static_cast<int16_t>(std::abs(s)));
    }
    EXPECT_NEAR(max_val, 16000, 100);
}

TEST(SignalGenTest, DualToneStereoIsolation) {
    uint32_t fs = 48000;
    uint32_t len = 48000; // 1 second
    double f1 = 1640.0;
    double f2 = 2016.0;
    double v1 = 0.8;
    double v2 = 0.4;

    auto stereo = oae::signal_gen::make_dual_tone(f1, f2, fs, len, v1, v2);
    ASSERT_EQ(stereo.size(), 2 * len);

    // Separate Left and Right channels
    std::vector<double> left(len);
    std::vector<double> right(len);
    for (size_t i = 0; i < len; ++i) {
        left[i] = stereo[2 * i];
        right[i] = stereo[2 * i + 1];
    }

    // Verify amplitude scaling
    int16_t max_left = 0, max_right = 0;
    for (size_t i = 0; i < len; ++i) {
        max_left = std::max(max_left, static_cast<int16_t>(std::abs(stereo[2 * i])));
        max_right = std::max(max_right, static_cast<int16_t>(std::abs(stereo[2 * i + 1])));
    }
    EXPECT_NEAR(max_left, 32000 * v1, 100);
    EXPECT_NEAR(max_right, 32000 * v2, 100);

    // Goertzel tone energy test to verify L has f1 but no f2, and R has f2 but no f1
    auto goertzel_mag = [&](const std::vector<double>& data, double target_freq) {
        double k = (target_freq * data.size()) / fs;
        double w = (2.0 * M_PI / data.size()) * k;
        double cosine = std::cos(w);
        double coeff = 2.0 * cosine;
        double q0 = 0.0, q1 = 0.0, q2 = 0.0;
        for (double sample : data) {
            q0 = coeff * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }
        return std::sqrt(q1 * q1 + q2 * q2 - q1 * q2 * coeff);
    };

    double l_at_f1 = goertzel_mag(left, f1);
    double l_at_f2 = goertzel_mag(left, f2);
    double r_at_f1 = goertzel_mag(right, f1);
    double r_at_f2 = goertzel_mag(right, f2);

    EXPECT_GT(l_at_f1, 1e7);
    EXPECT_LT(l_at_f2, 1e3); // Left channel must have negligible energy at f2

    EXPECT_GT(r_at_f2, 1e7);
    EXPECT_LT(r_at_f1, 1e3); // Right channel must have negligible energy at f1
}

TEST(SignalGenTest, CalibrationSequenceStructure) {
    oae::OaeConfig cfg;
    cfg.audio.sample_rate = 48000;
    cfg.vol_calib.pad_duration_seconds = 0.05;
    cfg.vol_calib.chirp_duration_seconds = 0.1;
    cfg.vol_calib.tone_duration_seconds = 0.2;

    oae::DeviceProfile prof;
    prof.vol3[1640] = 0.15;
    prof.vol3[2016] = 0.05;
    prof.vol3[2438] = 0.07;
    prof.vol3[2953] = 0.09;
    prof.vol3[3282] = 0.25;
    prof.vol3[3985] = 0.03;
    prof.vol3[4078] = 0.18;
    prof.vol3[4969] = 0.08;

    auto seq = oae::signal_gen::make_calib_sequence(cfg, prof);
    // Pad: 4800 samples stereo = 9600 int16
    // Chirp: 0.1s * 48000 = 4800 samples stereo = 9600 int16
    // 8 pulses * 0.2s * 48000 = 8 * 9600 stereo = 76800 samples stereo = 153600 int16
    // Total stereo samples = 4800 + 4800 + 76800 = 86400 -> 172800 int16
    EXPECT_EQ(seq.size(), 172800u);

    // Initial pad should be zero
    for (size_t i = 0; i < 9600; ++i) {
        EXPECT_EQ(seq[i], 0);
    }
}

#ifndef GTEST_INCLUDE_GTEST_GTEST_H_
int main() {
    return RUN_ALL_TESTS();
}
#endif
