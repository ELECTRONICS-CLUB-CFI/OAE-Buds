#if __has_include(<gtest/gtest.h>)
#include <gtest/gtest.h>
#else
#include "mini_gtest.hpp"
#endif

#include "oae/calibrator.hpp"
#include "oae/signal_gen.hpp"
#include "oae/dsp_engine.hpp"
#include <cmath>
#include <algorithm>

TEST(CalibratorTest, FitCheckerSealProgression) {
    oae::FitCheckConfig cfg;
    cfg.seal_check_threshold = 200;
    cfg.seal_occlusion_threshold = 500;
    cfg.consecutive_pass_buffers = 25;

    oae::calib::FitChecker checker(cfg, 48000);
    EXPECT_FALSE(checker.is_sealed());

    // Generate a buffer with RMS envelope around 350 (inside [200, 500])
    std::vector<int16_t> good_buffer(1000, 350);

    // Feed 24 good buffers -> still not sealed
    for (int i = 0; i < 24; ++i) {
        bool sealed = checker.process_buffer(good_buffer);
        EXPECT_FALSE(sealed);
    }
    EXPECT_EQ(checker.consecutive_good_buffers(), 24u);

    // 25th good buffer -> sealed!
    bool sealed = checker.process_buffer(good_buffer);
    EXPECT_TRUE(sealed);
    EXPECT_TRUE(checker.is_sealed());

    // An occluded buffer (> 500) resets sealing
    std::vector<int16_t> bad_buffer(1000, 800);
    checker.process_buffer(bad_buffer);
    EXPECT_FALSE(checker.is_sealed());
    EXPECT_EQ(checker.consecutive_good_buffers(), 0u);
}

TEST(CalibratorTest, ChirpLatencyRecovery) {
    uint32_t fs = 48000;
    double duration = 0.1;
    auto chirp = oae::signal_gen::make_linear_chirp(1000.0, 4000.0, duration, fs, 0.0, 0.5);

    // Construct a received buffer delayed by exactly 1200 samples
    size_t delay = 1200;
    std::vector<double> preamble(chirp.begin(), chirp.end());
    std::vector<double> rx(24000, 0.0); // 0.5s window
    for (size_t i = 0; i < chirp.size() && (i + delay) < rx.size(); ++i) {
        rx[i + delay] = chirp[i];
    }

    auto xcorr = oae::dsp::xcorr_fft(preamble, rx);
    // Find peak index
    size_t max_idx = 0;
    double max_val = 0.0;
    for (size_t i = 0; i < xcorr.size(); ++i) {
        if (xcorr[i] > max_val) {
            max_val = xcorr[i];
            max_idx = i;
        }
    }

    EXPECT_NEAR(static_cast<double>(max_idx), static_cast<double>(delay), 2.0);
}

TEST(CalibratorTest, SplAndGainCalculationClamping) {
    oae::CalibrationPolynomials calib;
    calib.p1 = {1.0};
    calib.p2 = {-50.0};
    calib.a = {1e-7};
    calib.b = {0.115};
    calib.spl_targets = {60.0};
    calib.defaults = {0.15};
    calib.maxvals = {0.50};

    // Synthesize a segment with known amplitude
    std::vector<double> seg(4800, 0.0);
    // 1640 Hz tone with known amplitude
    for (size_t i = 0; i < seg.size(); ++i) {
        seg[i] = 2000.0 * std::sin(2.0 * M_PI * 1640.0 * i / 48000.0);
    }

    auto [gain, amp] = oae::calib::Calibrator::compute_tone_spl_and_gain(1640, seg, 0, calib);
    EXPECT_GT(amp, 0.0);
    EXPECT_LE(gain, calib.maxvals[0]); // Must be clamped if it exceeds max
    EXPECT_GT(gain, 0.0);
}

#ifndef GTEST_INCLUDE_GTEST_GTEST_H_
int main() {
    return RUN_ALL_TESTS();
}
#endif
