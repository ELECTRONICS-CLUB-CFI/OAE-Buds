/**
 * Main Application Shell: Tab Navigation, Header Badges, Lifecycle Hydration
 */

import { store, subscribe, notify, hydrateFromServer, updateSettings, getEffectiveTheme, applyTheme } from "./store.js";
import { initScreening, renderScreening, connectTelemetry } from "./screening.js";
import { initRecords, renderRecords, fetchRecords, refreshOpenModalCharts } from "./records.js";
import { initSettings, renderSettings } from "./settings.js";
import { initDev, renderDev, fetchDevRuns, clearDevChartsBeforeThemeSwap } from "./dev.js";

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

function renderAll() {
  renderThemeButton();
  renderHeaderBadges();
  renderTabs();
  renderScreening();
  renderRecords();
  renderSettings();
  renderDev();
}

document.addEventListener("DOMContentLoaded", async () => {
  initScreening();
  initRecords();
  initSettings();
  initDev();

  document.getElementById("btn-theme-toggle").addEventListener("click", () => {
    const nextTheme = getEffectiveTheme() === "dark" ? "light" : "dark";
    clearDevChartsBeforeThemeSwap();
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
    updateSettings({ dev_mode: true });
    fetchDevRuns();
  });
  if (new URLSearchParams(window.location.search).get("dev") === "1" && !store.settings.dev_mode) {
    devModal.classList.remove("hidden");
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.activeTab = btn.dataset.tab || "screening";
      if (store.activeTab === "records") {
        fetchRecords();
      } else if (store.activeTab === "dev") {
        fetchDevRuns();
      }
      notify();
    });
  });

  let prevSessionState = store.activeSession.state;
  subscribe(() => {
    renderAll();
    if (
      prevSessionState !== "completed" &&
      prevSessionState !== "waiting_for_next_ear" &&
      (store.activeSession.state === "completed" || store.activeSession.state === "waiting_for_next_ear")
    ) {
      fetchRecords();
    }
    prevSessionState = store.activeSession.state;
  });

  await hydrateFromServer();
  connectTelemetry();
  fetchRecords();

  // Re-hydrate seamlessly when tablet wakes from sleep or browser tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      hydrateFromServer();
    }
  });

  // Light poll every 5s so USB audio plug/unplug updates the header badge automatically
  setInterval(() => {
    if (document.visibilityState === "visible") {
      hydrateFromServer();
    }
  }, 5000);

  // Ensure Chart.js canvases render in high-contrast light colors when printing from dark mode
  window.addEventListener("beforeprint", () => {
    document.documentElement.setAttribute("data-theme", "light");
    notify();
    refreshOpenModalCharts();
  });
  window.addEventListener("afterprint", () => {
    applyTheme();
    notify();
    refreshOpenModalCharts();
  });
});
