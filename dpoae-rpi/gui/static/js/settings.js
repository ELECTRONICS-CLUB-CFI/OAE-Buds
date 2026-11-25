/**
 * Settings & Hardware Diagnostics Tab Controller
 */

import { store, updateSettings, hydrateFromServer } from "./store.js";
import { escapeHtml } from "./dpgram_chart.js";

let lastProfilesKey = "";
let lastAudioKey = "";

export function renderSettings() {
  const themeSelect = document.getElementById("setting-theme");
  if (themeSelect) {
    themeSelect.value = store.settings.theme || "auto";
  }

  const profileSelect = document.getElementById("setting-profile");
  if (profileSelect) {
    const profiles = store.config.profiles || [];
    const profilesKey = profiles.map((p) => `${p.name}:${p.description}`).join("|");
    if (profilesKey !== lastProfilesKey) {
      lastProfilesKey = profilesKey;
      profileSelect.innerHTML = profiles
        .map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} — ${escapeHtml(p.description)}</option>`)
        .join("");
    }
    profileSelect.value = store.settings.profile;
  }

  const mockCb = document.getElementById("setting-mock");
  const fitCb = document.getElementById("setting-fit-check");
  const volCb = document.getElementById("setting-vol-calib");
  const devCb = document.getElementById("setting-dev-mode");
  if (mockCb) mockCb.checked = Boolean(store.settings.mock);
  if (fitCb) fitCb.checked = Boolean(store.settings.fit_check);
  if (volCb) volCb.checked = Boolean(store.settings.vol_calib);
  if (devCb) devCb.checked = Boolean(store.settings.dev_mode);

  const hwBox = document.getElementById("hw-status-box");
  if (hwBox) {
    const dev = store.audioDevice;
    const audioKey = JSON.stringify(dev);
    if (audioKey === lastAudioKey) {
      return;
    }
    lastAudioKey = audioKey;

    const rawList = (dev.raw_cards || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("");
    if (dev.connected) {
      hwBox.innerHTML = `
        <div><strong>Status:</strong> <span class="badge badge-success">USB Audio Connected</span></div>
        <div style="margin-top:0.4rem;"><strong>Card ${escapeHtml(dev.card_index)}:</strong> ${escapeHtml(dev.name)}</div>
        ${rawList ? `<ul style="margin:0.5rem 0 0;padding-left:1.2rem;">${rawList}</ul>` : ""}
      `;
    } else {
      hwBox.innerHTML = `
        <div><strong>Status:</strong> <span class="badge badge-warning">USB Audio Disconnected</span></div>
        <p class="muted" style="margin-top:0.4rem;">No UGREEN / USB audio card detected in /proc/asound/cards. Enable Mock Mode to run offline tests.</p>
        ${rawList ? `<ul style="margin:0.5rem 0 0;padding-left:1.2rem;">${rawList}</ul>` : ""}
      `;
    }
  }
}

export function initSettings() {
  document.getElementById("setting-theme").addEventListener("change", (e) => {
    updateSettings({ theme: e.target.value });
  });

  document.getElementById("setting-profile").addEventListener("change", (e) => {
    updateSettings({ profile: e.target.value });
  });

  document.getElementById("setting-mock").addEventListener("change", (e) => {
    updateSettings({ mock: Boolean(e.target.checked) });
  });

  document.getElementById("setting-fit-check").addEventListener("change", (e) => {
    updateSettings({ fit_check: Boolean(e.target.checked) });
  });

  document.getElementById("setting-vol-calib").addEventListener("change", (e) => {
    updateSettings({ vol_calib: Boolean(e.target.checked) });
  });

  document.getElementById("setting-dev-mode").addEventListener("change", (e) => {
    if (e.target.checked) {
      e.target.checked = false;
      document.getElementById("dev-confirm-modal").classList.remove("hidden");
    } else {
      if (store.activeTab === "dev") {
        store.activeTab = "screening";
      }
      updateSettings({ dev_mode: false, dev_overrides_enabled: false });
    }
  });

  document.getElementById("btn-verify-hw").addEventListener("click", async () => {
    const out = document.getElementById("hw-verify-output");
    out.classList.remove("hidden");
    out.innerHTML = '<span class="muted">Checking ALSA mixer...</span>';

    try {
      const resp = await fetch("/api/hardware/verify", { method: "POST" });
      const data = await resp.json();
      await hydrateFromServer();

      const mixer = data.mixer || {};
      if (mixer.ok) {
        const actions = (mixer.actions || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("");
        out.innerHTML = `
          <strong style="color:var(--success);">Mixer Verified &amp; Locked (Card ${escapeHtml(mixer.card_index)})</strong>
          <ul style="margin:0.4rem 0 0;padding-left:1.2rem;">${actions}</ul>
        `;
      } else {
        out.innerHTML = `<strong style="color:var(--danger);">Check Failed:</strong> ${escapeHtml(mixer.error || "Hardware not connected")}`;
      }
    } catch (err) {
      out.innerHTML = `<strong style="color:var(--danger);">Error:</strong> ${escapeHtml(err.message)}`;
    }
  });
}
