/**
 * Main Application Shell: Tab Navigation, Dirty-Tab Visibility Gating, Adaptive Polling
 */

import { store, subscribe, notify, hydrateFromServer, updateSettings, getEffectiveTheme, applyTheme } from "./store.js";
import { initScreening, renderScreening, connectTelemetry } from "./screening.js";
import { initRecords, renderRecords, fetchRecords, refreshOpenModalCharts } from "./records.js";
import { initSettings, renderSettings } from "./settings.js";
import { initDev, renderDev, fetchDevRuns, loadDevSpectrum, clearDevChartsBeforeThemeSwap } from "./dev.js";

const dirtyTabs = new Set(["records", "settings", "dev"]);

function renderThemeButton() {
  const isDark = getEffectiveTheme() === "dark";
  const moon = document.getElementById("icon-theme-moon");
  const sun = document.getElementById("icon-theme-sun");
  const label = document.getElementById("theme-toggle-label");
  if (moon) moon.classList.toggle("hidden", isDark);
  if (sun) sun.classList.toggle("hidden", !isDark);
  if (label) label.textContent = isDark ? "Light" : "Dark";
}

function renderHeaderBadges() {
  const audioBadge = document.getElementById("badge-audio");
  const audioText = document.getElementById("badge-audio-text");
  if (store.audioDevice.connected) {
    audioBadge.className = "badge badge-success";
    audioText.textContent = `Audio: ${store.audioDevice.name || "UGREEN OK"}`;
  } else {
    audioBadge.className = "badge badge-warning";
    audioText.textContent = "Audio: Disconnected";
  }

  const modeBadge = document.getElementById("badge-mode");
  const effectiveMock =
    store.activeSession.state === "running" ? store.activeSession.mock : store.settings.mock;
  if (effectiveMock) {
    modeBadge.className = "badge badge-info";
    modeBadge.textContent = "Mock Mode";
  } else {
    modeBadge.className = "badge badge-neutral";
    modeBadge.textContent = "Live Audio Mode";
  }

  const sseBadge = document.getElementById("badge-sse");
  const sseText = document.getElementById("badge-sse-text");
  if (store.sseConnected && store.serverOnline) {
    sseBadge.className = "badge badge-success";
    sseText.textContent = "Server Live";
  } else {
    sseBadge.className = "badge badge-danger";
    sseText.textContent = "Reconnecting...";
  }
}

function renderTabs() {
  const devEnabled = Boolean(store.settings.dev_mode);
  const nav = document.querySelector(".tab-nav");
  if (nav) nav.classList.toggle("has-dev", devEnabled);

  const devBtn = document.getElementById("tab-btn-dev");
  if (devBtn) devBtn.classList.toggle("hidden", !devEnabled);

  if (!devEnabled && store.activeTab === "dev") {
    store.activeTab = "screening";
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === store.activeTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.getElementById("panel-screening").classList.toggle("hidden", store.activeTab !== "screening");
  document.getElementById("panel-records").classList.toggle("hidden", store.activeTab !== "records");
  document.getElementById("panel-settings").classList.toggle("hidden", store.activeTab !== "settings");
  document.getElementById("panel-dev").classList.toggle("hidden", !devEnabled || store.activeTab !== "dev");
}

function renderTabByName(tabName) {
  dirtyTabs.delete(tabName);
  switch (tabName) {
    case "screening":
      renderScreening();
      break;
    case "records":
      renderRecords();
      break;
    case "settings":
      renderSettings();
      break;
    case "dev":
      renderDev();
      break;
    default:
      break;
  }
}

function scheduleTabRender(tabName) {
  if (tabName === "dev" && !store.settings.dev_mode) {
    dirtyTabs.add("dev");
    return;
  }
  if (store.activeTab === tabName) {
    renderTabByName(tabName);
  } else {
    dirtyTabs.add(tabName);
  }
}

async function activateTab(tabName) {
  const prevTab = store.activeTab;
  store.activeTab = tabName || "screening";
  renderTabs();

  if (store.activeTab === "records" && (prevTab !== "records" || dirtyTabs.has("records"))) {
    if (dirtyTabs.has("records")) renderTabByName("records");
    fetchRecords();
  } else if (store.activeTab === "dev" && store.settings.dev_mode) {
    renderTabByName("dev");
    const pending = store.dev.pendingRunFilename;
    if (pending) {
      store.dev.pendingRunFilename = null;
      await fetchDevRuns();
      await loadDevSpectrum(pending);
    } else if (!store.dev.runs.length) {
      await fetchDevRuns();
    }
  } else if (dirtyTabs.has(store.activeTab)) {
    renderTabByName(store.activeTab);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initScreening();
  initRecords();
  initSettings();
  initDev();

  document.getElementById("btn-theme-toggle").addEventListener("click", () => {
    const nextTheme = getEffectiveTheme() === "dark" ? "light" : "dark";
    clearDevChartsBeforeThemeSwap();
    dirtyTabs.add("dev");
    dirtyTabs.add("screening");
    updateSettings({ theme: nextTheme });
    refreshOpenModalCharts();
  });

  // Dev Mode confirmation dialog handlers + ?dev=1 activation
  const devModal = document.getElementById("dev-confirm-modal");
  document.getElementById("btn-dev-cancel").addEventListener("click", () => {
    devModal.classList.add("hidden");
  });
  document.getElementById("btn-dev-confirm").addEventListener("click", () => {
    devModal.classList.add("hidden");
    dirtyTabs.add("dev");
    updateSettings({ dev_mode: true });
    if (store.activeTab === "dev") {
      fetchDevRuns();
    }
  });
  if (new URLSearchParams(window.location.search).get("dev") === "1" && !store.settings.dev_mode) {
    devModal.classList.remove("hidden");
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activateTab(btn.dataset.tab || "screening");
    });
  });

  let prevSessionState = store.activeSession.state;
  subscribe("session", () => {
    renderHeaderBadges();
    scheduleTabRender("screening");
    scheduleTabRender("dev");

    if (
      prevSessionState !== "completed" &&
      prevSessionState !== "waiting_for_next_ear" &&
      (store.activeSession.state === "completed" || store.activeSession.state === "waiting_for_next_ear")
    ) {
      dirtyTabs.add("records");
      if (store.activeTab === "records") {
        fetchRecords();
      }
    }
    prevSessionState = store.activeSession.state;
  });

  subscribe("hardware", () => {
    renderHeaderBadges();
    scheduleTabRender("settings");
    scheduleTabRender("screening");
    scheduleTabRender("dev");
  });

  subscribe("records", () => {
    scheduleTabRender("records");
  });

  subscribe(["dev_metrics", "dev_tone", "dev_logs"], () => {
    scheduleTabRender("dev");
  });

  subscribe("ui", () => {
    renderThemeButton();
    renderHeaderBadges();
    renderTabs();
    renderTabByName(store.activeTab);
  });

  renderThemeButton();
  renderTabs();
  await hydrateFromServer();
  connectTelemetry();

  // Adaptive poll: 15s when SSE is live (only checks USB audio badge), 5s when disconnected
  let pollTimer = null;
  function scheduleNextPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    const delayMs = store.sseConnected ? 15000 : 5000;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (document.visibilityState === "visible") {
        await hydrateFromServer();
      }
      scheduleNextPoll();
    }, delayMs);
  }
  scheduleNextPoll();

  // Re-hydrate seamlessly when tablet wakes from sleep or browser tab becomes visible
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      await hydrateFromServer();
      scheduleNextPoll();
    }
  });

  // Ensure Chart.js canvases render in high-contrast light colors when printing from dark mode
  window.addEventListener("beforeprint", () => {
    document.documentElement.setAttribute("data-theme", "light");
    renderTabByName(store.activeTab);
    refreshOpenModalCharts();
  });
  window.addEventListener("afterprint", () => {
    applyTheme();
    renderTabByName(store.activeTab);
    refreshOpenModalCharts();
  });
});
