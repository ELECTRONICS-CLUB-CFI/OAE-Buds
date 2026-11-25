/**
 * Main Application Shell: Tab Navigation, Header Badges, Lifecycle Hydration
 */

import { store, subscribe, notify, hydrateFromServer } from "./store.js";
import { initScreening, renderScreening, connectTelemetry } from "./screening.js";
import { initRecords, renderRecords, fetchRecords } from "./records.js";
import { initSettings, renderSettings } from "./settings.js";

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
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === store.activeTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.getElementById("panel-screening").classList.toggle("hidden", store.activeTab !== "screening");
  document.getElementById("panel-records").classList.toggle("hidden", store.activeTab !== "records");
  document.getElementById("panel-settings").classList.toggle("hidden", store.activeTab !== "settings");
}

function renderAll() {
  renderHeaderBadges();
  renderTabs();
  renderScreening();
  renderRecords();
  renderSettings();
}

document.addEventListener("DOMContentLoaded", async () => {
  initScreening();
  initRecords();
  initSettings();

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      store.activeTab = btn.dataset.tab || "screening";
      if (store.activeTab === "records") {
        fetchRecords();
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
});
