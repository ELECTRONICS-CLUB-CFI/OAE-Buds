#if __has_include(<gtest/gtest.h>) && !defined(OAE_USE_MINI_GTEST)
#include <gtest/gtest.h>
#else
#include "mini_gtest.hpp"
#endif

#include "oae/session_runner.hpp"
#include "mock_audio_engine.hpp"
#include <cmath>
#include <filesystem>
#include <fstream>

TEST(SessionMockTest, ClinicalPassRuleThreeOfFour) {
    oae::OaeConfig cfg;
    cfg.fit_check.enabled = false;
    cfg.vol_calib.enabled = false; // Fast test focused on 4-pair evaluation
    cfg.test.pass_rule_min_frequencies = 3;

    oae::test::MockAudioEngine mock_audio;

    // We have 4 frequency pairs: 2016 (oae 1264), 2953 (oae 1923), 3985 (oae 2579), 4969 (oae 3187)
    // Make 3 of them pass (1264, 1923, 2579) and 1 fail (3187)
    uint32_t total_samples = 5 * 48000;
    std::vector<uint32_t> oae_freqs = {1264, 1923, 2579, 3187};

    for (int i = 0; i < 4; ++i) {
        std::vector<int16_t> resp(total_samples, 0);
        double amp = (i < 3) ? 300.0 : 0.0; // i=0,1,2 have high OAE amplitude; i=3 is silence/fail
        for (uint32_t s = 0; s < total_samples; ++s) {
            double t = static_cast<double>(s) / 48000.0;
            resp[s] = static_cast<int16_t>(amp * std::sin(2.0 * M_PI * oae_freqs[i] * t));
        }
        mock_audio.enqueue_response(std::move(resp));
    }

    oae::session::SessionRunner runner(cfg, mock_audio);
    auto summary = runner.run_session("patient_42", "left", "./test_results", false);

    EXPECT_EQ(summary.passed_count, 3u);
    EXPECT_EQ(summary.verdict, "Pass");
    EXPECT_EQ(summary.results.size(), 4u);
    EXPECT_TRUE(summary.results[0].pass);
    EXPECT_TRUE(summary.results[1].pass);
    EXPECT_TRUE(summary.results[2].pass);
    EXPECT_FALSE(summary.results[3].pass);
}

TEST(SessionMockTest, ClinicalReferRuleLessThanThreePassed) {
    oae::OaeConfig cfg;
    cfg.fit_check.enabled = false;
    cfg.vol_calib.enabled = false;
    cfg.test.pass_rule_min_frequencies = 3;

    oae::test::MockAudioEngine mock_audio;
    uint32_t total_samples = 5 * 48000;

    // All 4 pairs fail (silence/weak noise)
    for (int i = 0; i < 4; ++i) {
        std::vector<int16_t> resp(total_samples, 5);
        mock_audio.enqueue_response(std::move(resp));
    }

    oae::session::SessionRunner runner(cfg, mock_audio);
    auto summary = runner.run_session("patient_99", "right", "./test_results", false);

    EXPECT_LT(summary.passed_count, 3u);
    EXPECT_EQ(summary.verdict, "Refer");
}

TEST(SessionMockTest, JsonSummarySerialization) {
    oae::session::SessionSummary s;
    s.session_id = "sess_test_123";
    s.patient_id = "123";
    s.ear = "right";
    s.notes = "Patient was quiet";
    s.verdict = "Pass";
    s.passed_count = 3;
    s.total_active_frequencies = 4;
    s.noise_check_result = "noise-pass";

    oae::dsp::DpoaeResult r;
    r.f2 = 2016;
    r.f1 = 1640;
    r.signal_db = 45.0;
    r.noise_db = 30.0;
    r.snr_db = 15.0;
    r.pass = true;
    s.results.push_back(r);

    std::string json = s.to_json();
    EXPECT_NE(json.find("\"session_id\": \"sess_test_123\""), std::string::npos);
    EXPECT_NE(json.find("\"patient_id\": \"123\""), std::string::npos);
    EXPECT_NE(json.find("\"notes\": \"Patient was quiet\""), std::string::npos);
    EXPECT_NE(json.find("\"verdict\": \"Pass\""), std::string::npos);
    EXPECT_NE(json.find("\"snr_db\": 15.0"), std::string::npos);
}

TEST(SessionMockTest, JsonStreamSessionExecution) {
    oae::OaeConfig cfg;
    cfg.fit_check.enabled = false;
    cfg.vol_calib.enabled = false;
    cfg.test.pass_rule_min_frequencies = 3;

    oae::test::MockAudioEngine mock_audio;
    uint32_t total_samples = 5 * 48000;
    std::vector<uint32_t> oae_freqs = {1264, 1923, 2579, 3187};

    for (size_t i = 0; i < 4; ++i) {
        std::vector<int16_t> resp(total_samples);
        for (size_t s = 0; s < total_samples; ++s) {
            double t = static_cast<double>(s) / 48000.0;
            resp[s] = static_cast<int16_t>(100.0 * std::sin(2.0 * M_PI * oae_freqs[i] * t));
        }
        mock_audio.enqueue_response(std::move(resp));
    }

    oae::session::SessionRunner runner(cfg, mock_audio);
    auto summary = runner.run_session("test_stream_user", "left", "./test_results", false, true, "sess_abc", "Test note");

    EXPECT_EQ(summary.session_id, "sess_abc");
    EXPECT_EQ(summary.notes, "Test note");
    EXPECT_EQ(summary.patient_id, "test_stream_user");
    EXPECT_EQ(summary.verdict, "Pass");
}

TEST(SessionMockTest, DevTelemetryWritesSidecarFile) {
    oae::OaeConfig cfg;
    cfg.fit_check.enabled = false;
    cfg.vol_calib.enabled = false;
    cfg.test.pass_rule_min_frequencies = 3;

    oae::test::MockAudioEngine mock_audio;
    uint32_t total_samples = 5 * 48000;
    std::vector<uint32_t> oae_freqs = {1264, 1923, 2579, 3187};
    for (size_t i = 0; i < 4; ++i) {
        std::vector<int16_t> resp(total_samples);
        for (size_t s = 0; s < total_samples; ++s) {
            double t = static_cast<double>(s) / 48000.0;
            resp[s] = static_cast<int16_t>(150.0 * std::sin(2.0 * M_PI * oae_freqs[i] * t));
        }
        mock_audio.enqueue_response(std::move(resp));
    }

    oae::session::SessionRunner runner(cfg, mock_audio);
    auto summary = runner.run_session("dev_user", "left", "./test_results", false, false, "sess_dev", "", nullptr, true);

    EXPECT_FALSE(summary.dev_telemetry_file.empty());
    EXPECT_TRUE(std::filesystem::exists(summary.dev_telemetry_file));

    std::ifstream in(summary.dev_telemetry_file);
    std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    EXPECT_NE(content.find("\"freqs_hz\""), std::string::npos);
    EXPECT_NE(content.find("\"magnitudes_db\""), std::string::npos);
    EXPECT_NE(content.find("\"clipped_samples\""), std::string::npos);
}

TEST(SessionMockTest, ToneTestClampsSafetyAmplitudeAndDetectsPeak) {
    oae::OaeConfig cfg;
    oae::test::MockAudioEngine mock_audio;

    // Enqueue 1s 1200 Hz loopback tone with 480-sample onset latency
    std::vector<int16_t> rx(48000, 0);
    for (size_t s = 480; s < rx.size(); ++s) {
        double t = static_cast<double>(s) / 48000.0;
        rx[s] = static_cast<int16_t>(2000.0 * std::sin(2.0 * M_PI * 1200.0 * t));
    }
    mock_audio.enqueue_response(std::move(rx));

    oae::session::SessionRunner runner(cfg, mock_audio);
    oae::session::ToneTestConfig opts;
    opts.channel = "left";
    opts.freq_hz = 1200.0;
    opts.duration_s = 1.0;
    opts.amplitude = 0.99; // Exceeds safety ceiling!
    opts.output_dir = "./test_results";
    opts.verbose = false;

    auto res = runner.run_tone_test(opts);
    EXPECT_NEAR(res.amplitude_requested, 0.99, 1e-6);
    EXPECT_NEAR(res.amplitude_applied, oae::session::ToneTestConfig::kMaxSafeAmplitude, 1e-6);
    EXPECT_NEAR(res.measured_peak_hz, 1200.0, 2.0);
    EXPECT_NEAR(res.latency_ms, 10.0, 0.5);
    EXPECT_EQ(res.clipped_samples, 0u);
    EXPECT_FALSE(res.wav_file.empty());
    EXPECT_TRUE(std::filesystem::exists(res.wav_file));
}

#ifndef GTEST_INCLUDE_GTEST_GTEST_H_
int main() {
    return RUN_ALL_TESTS();
}
#endif
