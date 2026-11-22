#if __has_include(<gtest/gtest.h>)
#include <gtest/gtest.h>
#else
#include "mini_gtest.hpp"
#endif

#include "oae/oae_config.hpp"
#include <fstream>

TEST(ConfigTest, LoadValidDefaultToml) {
    std::string err;
    auto cfg_opt = oae::OaeConfig::load_from_file("config/oae_config.toml", "ugreen_80864_rpi5", &err);
    if (!cfg_opt.has_value()) {
        std::cerr << "Config load failed with err: " << err << "\n";
    }
    ASSERT_TRUE(cfg_opt.has_value());

    const auto& cfg = *cfg_opt;
    EXPECT_EQ(cfg.audio.sample_rate, 48000u);
    EXPECT_EQ(cfg.audio.bit_depth, 16u);
    EXPECT_EQ(cfg.audio.process_window_length(), 48000u);
    EXPECT_EQ(cfg.audio.init_trim_length(), 48000u);

    EXPECT_NEAR(cfg.test.snr_threshold_db, 7.0, 1e-5);
    EXPECT_NEAR(cfg.test.spl_threshold_db, -50.0, 1e-5);
    EXPECT_EQ(cfg.test.constant_tone_seconds, 5u);
    EXPECT_EQ(cfg.test.pass_rule_min_frequencies, 3u);

    EXPECT_TRUE(cfg.artifact.enabled);
    EXPECT_NEAR(cfg.artifact.art_threshold_db, 4.0, 1e-5);
    EXPECT_NEAR(cfg.artifact.imd_threshold, 200.0, 1e-5);
    EXPECT_EQ(cfg.artifact.amp_threshold, 500);

    // Active frequency pairs
    auto active_pairs = cfg.get_active_pairs();
    ASSERT_EQ(active_pairs.size(), 4u);

    EXPECT_EQ(active_pairs[0].f2, 2016u);
    EXPECT_EQ(active_pairs[0].f1, 1640u);
    EXPECT_EQ(active_pairs[0].oae_bin, 1264u);
    EXPECT_EQ(active_pairs[0].imd_bin, 2392u);

    EXPECT_EQ(active_pairs[1].f2, 2953u);
    EXPECT_EQ(active_pairs[1].f1, 2438u);
    EXPECT_EQ(active_pairs[1].oae_bin, 1923u);
    EXPECT_EQ(active_pairs[1].imd_bin, 3468u);

    EXPECT_EQ(active_pairs[2].f2, 3985u);
    EXPECT_EQ(active_pairs[2].f1, 3282u);
    EXPECT_EQ(active_pairs[2].oae_bin, 2579u);
    EXPECT_EQ(active_pairs[2].imd_bin, 4688u);

    EXPECT_EQ(active_pairs[3].f2, 4969u);
    EXPECT_EQ(active_pairs[3].f1, 4078u);
    EXPECT_EQ(active_pairs[3].oae_bin, 3187u);
    EXPECT_EQ(active_pairs[3].imd_bin, 5860u);

    // Noise thresholds
    ASSERT_EQ(cfg.noise_thresholds.size(), 4u);
    EXPECT_NEAR(cfg.noise_thresholds[0], 96.0, 1e-5);
    EXPECT_NEAR(cfg.noise_thresholds[1], 94.0, 1e-5);
    EXPECT_NEAR(cfg.noise_thresholds[2], 95.0, 1e-5);
    EXPECT_NEAR(cfg.noise_thresholds[3], 87.0, 1e-5);

    // Profile verification
    EXPECT_EQ(cfg.active_profile_name, "ugreen_80864_rpi5");
    const auto& prof = cfg.active_profile();
    EXPECT_EQ(prof.calibration.p1.size(), 8u);
    EXPECT_EQ(prof.calibration.p2.size(), 8u);
    EXPECT_EQ(prof.calibration.a.size(), 8u);
    EXPECT_EQ(prof.calibration.b.size(), 8u);
}

TEST(ConfigTest, LoadNonexistentTomlReturnsError) {
    std::string err;
    auto cfg_opt = oae::OaeConfig::load_from_file("nonexistent_file.toml", "sch3", &err);
    EXPECT_FALSE(cfg_opt.has_value());
    EXPECT_FALSE(err.empty());
}

#ifndef GTEST_INCLUDE_GTEST_GTEST_H_
int main() {
    return RUN_ALL_TESTS();
}
#endif
