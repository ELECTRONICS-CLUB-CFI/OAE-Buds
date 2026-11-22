#include "oae/oae_config.hpp"
#include <fstream>
#include <sstream>
#include <algorithm>
#include <iostream>

namespace oae {

const DeviceProfile& OaeConfig::active_profile() const {
    auto it = profiles.find(active_profile_name);
    if (it != profiles.end()) {
        return it->second;
    }
    static DeviceProfile fallback{"fallback", "Fallback profile", 0.5, 0.5, 200, {}, {}, {}};
    return fallback;
}

std::vector<FrequencyPair> OaeConfig::get_active_pairs() const {
    std::vector<FrequencyPair> active;
    for (const auto& pair : frequency_pairs) {
        if (pair.active) {
            active.push_back(pair);
        }
    }
    return active;
}

static std::string trim(const std::string& str) {
    size_t first = str.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    size_t last = str.find_last_not_of(" \t\r\n");
    return str.substr(first, (last - first + 1));
}

static std::vector<double> parse_double_array(const std::string& val_str) {
    std::vector<double> res;
    size_t start = val_str.find('[');
    size_t end = val_str.rfind(']');
    if (start == std::string::npos || end == std::string::npos || end <= start) {
        return res;
    }
    std::string inner = val_str.substr(start + 1, end - start - 1);
    std::stringstream ss(inner);
    std::string item;
    while (std::getline(ss, item, ',')) {
        item = trim(item);
        if (!item.empty()) {
            try {
                res.push_back(std::stod(item));
            } catch (...) {}
        }
    }
    return res;
}

std::optional<OaeConfig> OaeConfig::load_from_file(const std::string& path,
                                                  const std::string& profile_name,
                                                  std::string* error_out) {
    std::ifstream file(path);
    if (!file.is_open()) {
        file.open("../" + path);
    }
    if (!file.is_open()) {
        file.open("dpoae-rpi/" + path);
    }
    if (!file.is_open()) {
        file.open("../../" + path);
    }
    if (!file.is_open()) {
        if (error_out) *error_out = "Failed to open configuration file: " + path;
        return std::nullopt;
    }

    OaeConfig cfg;
    cfg.frequency_pairs.clear();
    cfg.noise_thresholds.clear();
    cfg.active_profile_name = profile_name;

    std::string current_section;
    std::string line;
    FrequencyPair current_pair;
    bool in_freq_pair_array = false;

    auto finalize_pair = [&]() {
        if (in_freq_pair_array && current_pair.f2 != 0) {
            cfg.frequency_pairs.push_back(current_pair);
            current_pair = FrequencyPair();
            in_freq_pair_array = false;
        }
    };

    while (std::getline(file, line)) {
        // Strip comment
        size_t comment_pos = line.find('#');
        if (comment_pos != std::string::npos) {
            line = line.substr(0, comment_pos);
        }
        line = trim(line);
        if (line.empty()) continue;

        if (line.rfind("[[frequency_pairs]]", 0) == 0) {
            finalize_pair();
            in_freq_pair_array = true;
            current_section = "frequency_pairs";
            continue;
        } else if (line.front() == '[' && line.back() == ']') {
            finalize_pair();
            current_section = trim(line.substr(1, line.size() - 2));
            continue;
        }

        size_t eq_pos = line.find('=');
        if (eq_pos == std::string::npos) continue;

        std::string key = trim(line.substr(0, eq_pos));
        std::string val = trim(line.substr(eq_pos + 1));

        if (current_section == "audio") {
            if (key == "sample_rate") cfg.audio.sample_rate = std::stoul(val);
            else if (key == "bit_depth") cfg.audio.bit_depth = std::stoul(val);
            else if (key == "recording_window_seconds") cfg.audio.recording_window_seconds = std::stod(val);
            else if (key == "play_window_ms") cfg.audio.play_window_ms = std::stod(val);
            else if (key == "process_window_length_factor") cfg.audio.process_window_length_factor = std::stod(val);
            else if (key == "init_signal_trim_factor") cfg.audio.init_signal_trim_factor = std::stod(val);
        } else if (current_section == "test") {
            if (key == "snr_threshold_db") cfg.test.snr_threshold_db = std::stod(val);
            else if (key == "spl_threshold_db") cfg.test.spl_threshold_db = std::stod(val);
            else if (key == "max_tries") cfg.test.max_tries = std::stoul(val);
            else if (key == "constant_tone_seconds") cfg.test.constant_tone_seconds = std::stoul(val);
            else if (key == "pass_rule_min_frequencies") cfg.test.pass_rule_min_frequencies = std::stoul(val);
        } else if (current_section == "artifact_rejection") {
            if (key == "enabled") cfg.artifact.enabled = (val == "true");
            else if (key == "art_threshold_db") cfg.artifact.art_threshold_db = std::stod(val);
            else if (key == "snr_floor_db") cfg.artifact.snr_floor_db = std::stod(val);
            else if (key == "imd_threshold") cfg.artifact.imd_threshold = std::stod(val);
            else if (key == "amp_threshold") cfg.artifact.amp_threshold = std::stol(val);
        } else if (current_section == "fit_check") {
            if (key == "enabled") cfg.fit_check.enabled = (val == "true");
            else if (key == "check_frequency_hz") cfg.fit_check.check_frequency_hz = std::stoul(val);
            else if (key == "seal_check_threshold") cfg.fit_check.seal_check_threshold = std::stol(val);
            else if (key == "seal_occlusion_threshold") cfg.fit_check.seal_occlusion_threshold = std::stol(val);
            else if (key == "consecutive_pass_buffers") cfg.fit_check.consecutive_pass_buffers = std::stoul(val);
            else if (key == "calib_signal") {
                if (val.front() == '"' && val.back() == '"') val = val.substr(1, val.size() - 2);
                cfg.fit_check.calib_signal = val;
            } else if (key == "tone_volume") cfg.fit_check.tone_volume = std::stod(val);
        } else if (current_section == "volume_calibration") {
            if (key == "enabled") cfg.vol_calib.enabled = (val == "true");
            else if (key == "chirp_start_hz") cfg.vol_calib.chirp_start_hz = std::stod(val);
            else if (key == "chirp_end_hz") cfg.vol_calib.chirp_end_hz = std::stod(val);
            else if (key == "chirp_duration_seconds") cfg.vol_calib.chirp_duration_seconds = std::stod(val);
            else if (key == "tone_duration_seconds") cfg.vol_calib.tone_duration_seconds = std::stod(val);
            else if (key == "examine_duration_seconds") cfg.vol_calib.examine_duration_seconds = std::stod(val);
            else if (key == "pad_duration_seconds") cfg.vol_calib.pad_duration_seconds = std::stod(val);
            else if (key == "latency_search_window_seconds") cfg.vol_calib.latency_search_window_seconds = std::stod(val);
        } else if (in_freq_pair_array) {
            if (key == "f2") current_pair.f2 = std::stoul(val);
            else if (key == "f1") current_pair.f1 = std::stoul(val);
            else if (key == "oae_bin") current_pair.oae_bin = std::stoul(val);
            else if (key == "imd_bin") current_pair.imd_bin = std::stoul(val);
            else if (key == "active") current_pair.active = (val == "true");
        } else if (current_section == "noise_thresholds") {
            if (key == "values") cfg.noise_thresholds = parse_double_array(val);
        } else if (current_section.rfind("profiles.", 0) == 0) {
            std::string sub = current_section.substr(9);
            size_t dot_pos = sub.find('.');
            std::string p_name = (dot_pos == std::string::npos) ? sub : sub.substr(0, dot_pos);
            std::string p_sub = (dot_pos == std::string::npos) ? "" : sub.substr(dot_pos + 1);

            auto& prof = cfg.profiles[p_name];
            prof.name = p_name;

            if (p_sub.empty()) {
                if (key == "description") {
                    if (val.front() == '"' && val.back() == '"') val = val.substr(1, val.size() - 2);
                    prof.description = val;
                } else if (key == "master_volume") prof.master_volume = std::stod(val);
                else if (key == "vol_default") prof.vol_default = std::stod(val);
                else if (key == "seal_check_threshold") prof.seal_check_threshold = std::stol(val);
            } else if (p_sub == "vol1_defaults") {
                prof.vol1_defaults[std::stoul(key)] = std::stod(val);
            } else if (p_sub == "vol3") {
                prof.vol3[std::stoul(key)] = std::stod(val);
            } else if (p_sub == "calibration") {
                if (key == "p1") prof.calibration.p1 = parse_double_array(val);
                else if (key == "p2") prof.calibration.p2 = parse_double_array(val);
                else if (key == "a") prof.calibration.a = parse_double_array(val);
                else if (key == "b") prof.calibration.b = parse_double_array(val);
                else if (key == "spl_targets") prof.calibration.spl_targets = parse_double_array(val);
                else if (key == "defaults") prof.calibration.defaults = parse_double_array(val);
                else if (key == "maxvals") prof.calibration.maxvals = parse_double_array(val);
            }
        }
    }
    finalize_pair();

    // Validation
    if (cfg.audio.sample_rate != 48000) {
        if (error_out) *error_out = "Unsupported sample rate (must be 48000): " + std::to_string(cfg.audio.sample_rate);
        return std::nullopt;
    }
    if (cfg.get_active_pairs().empty()) {
        if (error_out) *error_out = "No active frequency pairs configured.";
        return std::nullopt;
    }

    return cfg;
}

} // namespace oae
