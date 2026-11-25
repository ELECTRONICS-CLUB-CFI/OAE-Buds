/**
 * Centralized Reactive Store & /api/status Hydration
 */

const SETTINGS_KEY = "oae_buds_gui_settings_v1";

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (_) {
    // ignore storage errors
  }
  return {};
}

const saved = loadSavedSettings();

export const store = {
  activeTab: "screening",
  serverOnline: false,
  sseConnected: false,
  audioDevice: {
    connected: false,
    card_index: null,
    name: null,
    raw_cards: [],
  },
  config: {
    profiles: [{ name: "ugreen_80864_rpi5", description: "UGREEN 80864 (RPi5)" }],
    default_profile: "ugreen_80864_rpi5",
    snr_threshold_db: 7.0,
    constant_tone_seconds: 5,
    pass_rule_min_frequencies: 3,
    amp_threshold: 500,
    art_threshold_db: 4.0,
    fit_check_default: false,
    vol_calib_default: true,
  },
  settings: {
    profile: saved.profile || "ugreen_80864_rpi5",
    mock: typeof saved.mock === "boolean" ? saved.mock : false,
    fit_check: typeof saved.fit_check === "boolean" ? saved.fit_check : false,
    vol_calib: typeof saved.vol_calib === "boolean" ? saved.vol_calib : true,
    theme: ["auto", "light", "dark"].includes(saved.theme) ? saved.theme : "auto",
    dev_mode: typeof saved.dev_mode === "boolean" ? saved.dev_mode : false,
    dev_overrides_enabled: typeof saved.dev_overrides_enabled === "boolean" ? saved.dev_overrides_enabled : false,
    dev_overrides: saved.dev_overrides && typeof saved.dev_overrides === "object" ? saved.dev_overrides : {},
  },
  activeSession: {
    session_id: null,
    state: "idle",
    patient_id: "",
    notes: "",
    workflow: "single",
    current_ear: null,
    profile: "ugreen_80864_rpi5",
    mock: false,
    fit_check: false,
    vol_calib: true,
    current_phase: null,
    current_frequency_index: 0,
    total_frequencies: 4,
    current_f1: null,
    current_f2: null,
    artifact_status: null,
    elapsed_seconds: 0,
    frequencies_done: [],
    fit_check_passed: null,
    vol_calib_passed: null,
    left_result: null,
    right_result: null,
    error_message: null,
  },
  records: {
    items: [],
    loading: false,
    search: "",
    verdict: "",
    ear: "",
  },
  dev: {
    runs: [],
    selectedRunFilename: null,
    spectrumData: null,
    selectedPairIndex: 0,
    toneTestBusy: false,
    toneTestResult: null,
    toneTestError: null,
    consoleLogs: [],
    consoleOpen: false,
  },
};

export function appendDevLog(kind, text) {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  store.dev.consoleLogs.push({ ts, kind, text });
  if (store.dev.consoleLogs.length > 300) {
    store.dev.consoleLogs.shift();
  }
}

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try {
      fn(store);
    } catch (err) {
      console.error("Store subscriber error:", err);
    }
  }
}

export function getEffectiveTheme() {
  const pref = store.settings.theme || "auto";
  if (pref === "dark" || pref === "light") return pref;
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

export function applyTheme() {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", getEffectiveTheme());
  }
}

applyTheme();
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (store.settings.theme === "auto") {
      applyTheme();
      notify();
    }
  });
}

export function updateSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  applyTheme();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings));
  } catch (_) {
    // ignore storage quota errors
  }
  notify();
}

export function applyStatusPayload(data) {
  if (!data) return;
  store.serverOnline = data.server === "ok";
  if (data.audio_device) {
    store.audioDevice = data.audio_device;
  }
  if (data.config) {
    store.config = data.config;
    const validNames = (data.config.profiles || []).map((p) => p.name);
    if (validNames.length && !validNames.includes(store.settings.profile)) {
      updateSettings({ profile: data.config.default_profile || validNames[0] });
    }
  }
  if (data.active_session) {
    store.activeSession = data.active_session;
  }
  notify();
}

export async function hydrateFromServer() {
  try {
    const resp = await fetch("/api/status", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    applyStatusPayload(data);
    return true;
  } catch (err) {
    store.serverOnline = false;
    notify();
    return false;
  }
}
