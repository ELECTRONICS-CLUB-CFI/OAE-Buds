/**
 * Centralized Topic-Scoped Store & Diffed /api/status Hydration
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
let nextLogSeq = 0;

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
    pendingRunFilename: null,
    spectrumData: null,
    selectedPairIndex: 0,
    toneTestBusy: false,
    toneTestResult: null,
    toneTestError: null,
    consoleLogs: [],
    logResetCount: 0,
    consoleOpen: false,
  },
};

export function appendDevLogs(kind, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  for (const raw of lines) {
    nextLogSeq += 1;
    store.dev.consoleLogs.push({ seq: nextLogSeq, ts, kind, text: String(raw ?? "") });
  }
  while (store.dev.consoleLogs.length > 300) {
    store.dev.consoleLogs.shift();
  }
}

export function appendDevLog(kind, text) {
  appendDevLogs(kind, [text]);
}

export function clearDevLogs() {
  store.dev.consoleLogs = [];
  store.dev.logResetCount += 1;
}

const ALL_TOPICS = ["session", "hardware", "records", "dev_metrics", "dev_tone", "dev_logs", "ui"];
const topicListeners = new Map();

function addTopicListener(topic, fn) {
  let set = topicListeners.get(topic);
  if (!set) {
    set = new Set();
    topicListeners.set(topic, set);
  }
  set.add(fn);
}

export function subscribe(topicsOrFn, maybeFn) {
  const fn = typeof topicsOrFn === "function" ? topicsOrFn : maybeFn;
  const topics = typeof topicsOrFn === "function"
    ? ["*"]
    : Array.isArray(topicsOrFn)
      ? topicsOrFn
      : [topicsOrFn];

  if (typeof fn !== "function") return () => {};
  for (const t of topics) {
    addTopicListener(t, fn);
  }
  return () => {
    for (const t of topics) {
      topicListeners.get(t)?.delete(fn);
    }
  };
}

export function notify(...topics) {
  const activeTopics = topics.length ? topics : ALL_TOPICS;
  const toInvoke = new Set();
  for (const t of activeTopics) {
    const set = topicListeners.get(t);
    if (set) {
      for (const fn of set) toInvoke.add(fn);
    }
  }
  const wildcard = topicListeners.get("*");
  if (wildcard) {
    for (const fn of wildcard) toInvoke.add(fn);
  }

  for (const fn of toInvoke) {
    try {
      fn(store, activeTopics);
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
      notify("ui");
    }
  });
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings));
  } catch (_) {
    // ignore storage quota errors
  }
}

export function updateSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  applyTheme();
  persistSettings();
  notify("ui");
}

let lastHardwareSnap = "";
let lastConfigSnap = "";
let lastSessionSnap = "";

function stableSessionCompareKey(sess) {
  if (!sess) return "";
  // Ignore elapsed_seconds ticks when idle or identical, compare full state otherwise
  return JSON.stringify(sess);
}

export function applyStatusPayload(data) {
  if (!data) return;
  const changed = [];

  const nextOnline = data.server === "ok";
  if (nextOnline !== store.serverOnline) {
    store.serverOnline = nextOnline;
    changed.push("hardware");
  }

  if (data.audio_device) {
    const hwSnap = JSON.stringify(data.audio_device);
    if (hwSnap !== lastHardwareSnap) {
      lastHardwareSnap = hwSnap;
      store.audioDevice = data.audio_device;
      if (!changed.includes("hardware")) changed.push("hardware");
    }
  }

  if (data.config) {
    const cfgSnap = JSON.stringify(data.config);
    if (cfgSnap !== lastConfigSnap) {
      lastConfigSnap = cfgSnap;
      store.config = data.config;
      if (!changed.includes("hardware")) changed.push("hardware");
    }
    const validNames = (data.config.profiles || []).map((p) => p.name);
    if (validNames.length && !validNames.includes(store.settings.profile)) {
      store.settings = { ...store.settings, profile: data.config.default_profile || validNames[0] };
      persistSettings();
      changed.push("ui");
    }
  }

  if (data.active_session) {
    const sessSnap = stableSessionCompareKey(data.active_session);
    if (sessSnap !== lastSessionSnap) {
      lastSessionSnap = sessSnap;
      store.activeSession = data.active_session;
      changed.push("session");
    }
  }

  if (changed.length > 0) {
    notify(...changed);
  }
}

export async function hydrateFromServer() {
  try {
    const resp = await fetch("/api/status", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    applyStatusPayload(data);
    return true;
  } catch (err) {
    if (store.serverOnline) {
      store.serverOnline = false;
      notify("hardware");
    }
    return false;
  }
}
