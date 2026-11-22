#if __has_include(<gtest/gtest.h>)
#include <gtest/gtest.h>
#else
#include "mini_gtest.hpp"
#endif

#include "oae/dsp_engine.hpp"
#include <cmath>
#include <random>

TEST(DspEngineTest, AmpCheckBugFixVerification) {
    // Construct samples where block 1 has average 600, block 2 has average 100
    std::vector<int16_t> samples(2000);
    for (size_t i = 0; i < 1000; ++i) {
        samples[i] = (i % 2 == 0) ? 600 : -600; // Alternating signs
    }
    for (size_t i = 1000; i < 2000; ++i) {
        samples[i] = (i % 2 == 0) ? 100 : -100;
    }

    // In the buggy Java code:
    // 1) Signed sum cancelled alternating values to ~0.
    // 2) summer was never reset, accumulating across blocks.
    // In our fixed C++ code:
    // It sums std::abs(), so block 1 avg is 600, block 2 avg is 100, max_avg is 600.
    int32_t max_amp = oae::dsp::amp_check(samples);
    EXPECT_EQ(max_amp, 600);
}

TEST(DspEngineTest, SnrCalculationKnownPeak) {
    uint32_t seglen = 48000;
    uint32_t target_bin = 1264;
    std::vector<double> power_spec(seglen / 2 + 1, 100.0); // Baseline noise power = 100.0 (20 dB)

    // Inject strong tone at target_bin: power = 1000000.0 (60 dB)
    power_spec[target_bin] = 1000000.0;

    auto res = oae::dsp::calc_snr(power_spec, seglen, target_bin);

    // Signal: 10 * log10(1000000) = 60.0 dB
    // Noise: 10 * log10(100) = 20.0 dB
    // SNR: 60.0 - 20.0 = 40.0 dB
    EXPECT_NEAR(res.signal_db, 60.0, 0.1);
    EXPECT_NEAR(res.noise_db, 20.0, 0.1);
    EXPECT_NEAR(res.snr_db, 40.0, 0.1);
}

TEST(DspEngineTest, CleanSignalPassesClinicalThreshold) {
    oae::OaeConfig cfg;
    cfg.audio.sample_rate = 48000;
    cfg.audio.process_window_length_factor = 1.0;
    cfg.audio.init_signal_trim_factor = 1.0;
    cfg.test.snr_threshold_db = 7.0;

    oae::FrequencyPair pair;
    pair.f2 = 2016;
    pair.f1 = 1640;
    pair.oae_bin = 1264;
    pair.imd_bin = 2392;

    // Generate 5 seconds (240,000 samples)
    uint32_t total_samples = 5 * 48000;
    std::vector<int16_t> recording(total_samples);

    // Inject 1264 Hz tone (simulated OAE) with low noise
    for (uint32_t i = 0; i < total_samples; ++i) {
        double phase = 2.0 * M_PI * 1264.0 * (static_cast<double>(i % 48000) / 48000.0);
        double s = 150.0 * std::sin(phase);
        recording[i] = static_cast<int16_t>(s);
    }

    auto res = oae::dsp::process_frequency_pair(recording, pair, cfg);
    EXPECT_TRUE(res.pass);
    EXPECT_GT(res.snr_db, 7.0);
    EXPECT_EQ(res.segments_used, 4u);
    EXPECT_EQ(res.segments_rejected, 0u);
}

TEST(DspEngineTest, ArtifactRejectionDiscardsCorruptedBlock) {
    oae::OaeConfig cfg;
    cfg.audio.sample_rate = 48000;
    cfg.artifact.enabled = true;
    cfg.artifact.art_threshold_db = 4.0;

    oae::FrequencyPair pair;
    pair.f2 = 2016;
    pair.f1 = 1640;
    pair.oae_bin = 1264;
    pair.imd_bin = 2392;

    uint32_t total_samples = 5 * 48000;
    std::vector<int16_t> recording(total_samples);

    // Clean OAE signal everywhere
    for (uint32_t i = 0; i < total_samples; ++i) {
        double t = static_cast<double>(i) / 48000.0;
        recording[i] = static_cast<int16_t>(200.0 * std::sin(2.0 * M_PI * 1264.0 * t));
    }

    // Inject massive broadband noise burst into segment 2 (samples 96000 to 144000)
    for (uint32_t i = 96000; i < 144000; ++i) {
        recording[i] = static_cast<int16_t>((rand() % 10000) - 5000);
    }

    auto res = oae::dsp::process_frequency_pair(recording, pair, cfg);
    // Segment 2 should have been rejected due to art >= 4 dB jump
    EXPECT_EQ(res.segments_rejected, 1u);
    EXPECT_EQ(res.segments_used, 3u);
    EXPECT_TRUE(res.pass); // Remaining 3 segments still detect OAE
}

#ifndef GTEST_INCLUDE_GTEST_GTEST_H_
int main() {
    return RUN_ALL_TESTS();
}
#endif
