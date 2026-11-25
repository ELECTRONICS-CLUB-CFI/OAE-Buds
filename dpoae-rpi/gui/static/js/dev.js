/**
 * Developer / Lab Tab Controller:
 *  - FFT Spectrum Inspector (500 Hz - 6 kHz + f1, f2, 2f1-f2, noise floor markers)
 *  - Waveform Envelope & Clipping Panel + Pair WAV Player
 *  - Manual Tone & Loopback Bench Test (Live Hardware Only)
 *  - Parameter Overrides Form (Explicit Guard Checkbox)
 *  - Collapsible Ephemeral Live Telemetry & stderr Console
 */

import { store, notify, updateSettings, getEffectiveTheme } from "./store.js";
import { escapeHtml } from "./dpgram_chart.js";

function destroyDevCanvasChart(canvasId) {
  const el = document.getElementById(canvasId);
  if (el && el._oaeChart) {
    el._oaeChart.destroy();
    el._oaeChart = null;
  }
}

const markerOverlayPlugin = {
  id: "oaeDevMarkers",
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const markers = pluginOptions?.markers || [];
    const noiseDb = pluginOptions?.noiseDb;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;

    const ctx = chart.ctx;
    ctx.save();

    if (typeof noiseDb === "number" && Number.isFinite(noiseDb)) {
      const yPos = yScale.getPixelForValue(noiseDb);
      if (yPos >= yScale.top && yPos <= yScale.bottom) {
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = pluginOptions.noiseLineColor || "#64748b";
        ctx.lineWidth = 1.5;
        ctx.moveTo(xScale.left, yPos);
        ctx.lineTo(xScale.right, yPos);
        ctx.stroke();

        ctx.fillStyle = pluginOptions.noiseLineColor || "#64748b";
        ctx.font = "600 11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(`Noise Floor (${noiseDb.toFixed(1)} dB)`, xScale.right - 6, yPos - 4);
      }
    }

    for (const m of markers) {
      if (!m || typeof m.hz !== "number" || m.hz < xScale.min || m.hz > xScale.max) continue;
      const xPos = xScale.getPixelForValue(m.hz);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.moveTo(xPos, yScale.top);
      ctx.lineTo(xPos, yScale.bottom);
      ctx.stroke();

      ctx.fillStyle = m.color;
      ctx.font = "700 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(m.label, xPos, yScale.top + (m.yOffset || 12));
    }
    ctx.restore();
  },
};

export async function fetchDevRuns() {
  if (!store.settings.dev_mode) return;
  try {
    const resp = await fetch("/api/dev/runs?limit=30", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    store.dev.runs = data.runs || [];
    if (!store.dev.selectedRunFilename && store.dev.runs.length > 0) {
      await loadDevSpectrum(store.dev.runs[0].filename);
      return;
    }
  } catch (err) {
    console.error("Failed to fetch dev runs:", err);
  }
  notify();
}

export async function loadDevSpectrum(filename) {
  if (!filename) return;
  store.dev.selectedRunFilename = filename;
  try {
    const resp = await fetch(`/api/dev/spectrum/${encodeURIComponent(filename)}`, { cache: "no-store" });
    if (resp.ok) {
      store.dev.spectrumData = await resp.json();
      store.dev.selectedPairIndex = 0;
    }
  } catch (err) {
    console.error("Failed to load dev spectrum:", err);
  }
  notify();
}

let lastSpectrumRenderKey = "";

function renderSpectrumAndWaveform() {
  const data = store.dev.spectrumData;
  const runSelect = document.getElementById("dev-run-select");
  if (runSelect) {
    const runs = store.dev.runs || [];
    const optionsHtml = runs.length
      ? runs
          .map(
            (r) =>
              `<option value="${escapeHtml(r.filename)}">${escapeHtml(r.patient_id)} (${escapeHtml(
                String(r.ear || "").toUpperCase()
              )}) — ${escapeHtml(r.filename)}</option>`
          )
          .join("")
      : '<option value="">No --dev-telemetry runs recorded yet</option>';
    if (runSelect.innerHTML !== optionsHtml) {
      runSelect.innerHTML = optionsHtml;
    }
    if (store.dev.selectedRunFilename) {
      runSelect.value = store.dev.selectedRunFilename;
    }
  }

  const pairTabs = document.getElementById("dev-pair-tabs");
  const metricsEl = document.getElementById("dev-pair-metrics");
  const wavAudio = document.getElementById("dev-pair-audio");
  const wavLink = document.getElementById("dev-pair-wav-dl");

  const pairs = data?.pairs || [];
  if (!pairs.length) {
    if (pairTabs) pairTabs.innerHTML = "";
    if (metricsEl) {
      metricsEl.innerHTML =
        '<p class="muted">Run a screening while Developer Mode is active to inspect FFT spectra, waveform envelopes, and clipping metrics.</p>';
    }
    if (wavAudio) wavAudio.removeAttribute("src");
    if (wavLink) wavLink.classList.add("hidden");
    destroyDevCanvasChart("dev-fft-canvas");
    destroyDevCanvasChart("dev-wave-canvas");
    lastSpectrumRenderKey = "";
    return;
  }

  const idx = Math.min(Math.max(0, store.dev.selectedPairIndex || 0), pairs.length - 1);
  const pair = pairs[idx];

  if (pairTabs) {
    pairTabs.innerHTML = pairs
      .map(
        (p, i) =>
          `<button type="button" class="btn btn-sm ${i === idx ? "btn-primary" : "btn-outline"} dev-pair-btn" data-idx="${i}">Pair ${
            p.pair_index
          }: ${p.f2} Hz</button>`
      )
      .join("");
    pairTabs.querySelectorAll(".dev-pair-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        store.dev.selectedPairIndex = Number(btn.dataset.idx);
        notify();
      });
    });
  }

  if (metricsEl) {
    const clipBadge =
      Number(pair.clipped_samples || 0) > 0
        ? `<span class="badge badge-danger">${pair.clipped_samples} Clipped</span>`
        : `<span class="badge badge-success">0 Clipped</span>`;
    metricsEl.innerHTML = `
      <span class="badge badge-info">Peak: ${Number(pair.peak_dbfs).toFixed(1)} dBFS</span>
      <span class="badge badge-neutral">RMS: ${Number(pair.rms_dbfs).toFixed(1)} dBFS</span>
      ${clipBadge}
      <span class="badge badge-neutral">Signal: ${Number(pair.signal_db).toFixed(1)} dB | SNR: ${Number(pair.snr_db).toFixed(1)} dB</span>
    `;
  }

  const wavFilename = pair.wav_file ? String(pair.wav_file).split("/").pop() : "";
  if (wavFilename && wavAudio && wavLink) {
    const wavUrl = `/api/dev/wav/${encodeURIComponent(wavFilename)}`;
    if (wavAudio.getAttribute("src") !== wavUrl) {
      wavAudio.setAttribute("src", wavUrl);
    }
    wavLink.href = wavUrl;
    wavLink.download = wavFilename;
    wavLink.classList.remove("hidden");
  } else if (wavAudio && wavLink) {
    wavAudio.removeAttribute("src");
    wavLink.classList.add("hidden");
  }

  const theme = getEffectiveTheme();
  const renderKey = `${store.dev.selectedRunFilename}:${idx}:${theme}`;
  if (renderKey === lastSpectrumRenderKey) return;
  lastSpectrumRenderKey = renderKey;

  const isDark = theme === "dark";
  const gridColor = isDark ? "#334155" : "#e2e8f0";
  const tickColor = isDark ? "#cbd5e1" : "#334155";
  const fftLineColor = isDark ? "#2dd4bf" : "#0f766e";
  const waveColor = isDark ? "#38bdf8" : "#0369a1";
  const waveFill = isDark ? "rgba(56, 189, 248, 0.25)" : "rgba(3, 105, 161, 0.2)";

  // 1. FFT Spectrum Chart
  destroyDevCanvasChart("dev-fft-canvas");
  const fftCanvas = document.getElementById("dev-fft-canvas");
  if (fftCanvas && typeof window.Chart !== "undefined" && pair.spectrum) {
    const freqs = pair.spectrum.freqs_hz || [];
    const mags = pair.spectrum.magnitudes_db || [];
    const pts = freqs.map((hz, i) => ({ x: hz, y: mags[i] }));

    const markers = [
      { hz: Number(pair.oae_bin), label: `2f1-f2 (${pair.oae_bin})`, color: isDark ? "#4ade80" : "#15803d", yOffset: 12 },
      { hz: Number(pair.f1), label: `f1 (${pair.f1})`, color: isDark ? "#fbbf24" : "#b45309", yOffset: 26 },
      { hz: Number(pair.f2), label: `f2 (${pair.f2})`, color: isDark ? "#38bdf8" : "#0369a1", yOffset: 12 },
      { hz: Number(pair.imd_bin), label: `IMD (${pair.imd_bin})`, color: isDark ? "#f87171" : "#b91c1c", yOffset: 26 },
    ];

    const chart = new window.Chart(fftCanvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "FFT Magnitude (dB)",
            data: pts,
            borderColor: fftLineColor,
            borderWidth: 1.75,
            pointRadius: 0,
            tension: 0.05,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        plugins: {
          legend: { display: false },
          oaeDevMarkers: {
            markers,
            noiseDb: Number(pair.noise_db),
            noiseLineColor: isDark ? "#94a3b8" : "#64748b",
          },
        },
        scales: {
          x: {
            type: "linear",
            min: 500,
            max: 6000,
            title: { display: true, text: "Frequency (Hz)", color: tickColor },
            ticks: { color: tickColor },
            grid: { color: gridColor },
          },
          y: {
            title: { display: true, text: "Magnitude (dB)", color: tickColor },
            ticks: { color: tickColor },
            grid: { color: gridColor },
          },
        },
      },
      plugins: [markerOverlayPlugin],
    });
    // Store reference in dpgram registry via a local map if needed; destroyChart uses chartRegistry,
    // so track via Chart.getChart when available:
    fftCanvas._oaeChart = chart;
  }

  // 2. Waveform Min/Max Envelope Chart
  destroyDevCanvasChart("dev-wave-canvas");
  const waveCanvas = document.getElementById("dev-wave-canvas");
  if (waveCanvas && typeof window.Chart !== "undefined" && pair.waveform) {
    const mins = pair.waveform.min || [];
    const maxs = pair.waveform.max || [];
    const labels = mins.map((_, i) => i);

    const wChart = new window.Chart(waveCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Min",
            data: mins,
            borderColor: waveColor,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
          {
            label: "Max",
            data: maxs,
            borderColor: waveColor,
            backgroundColor: waveFill,
            borderWidth: 1,
            pointRadius: 0,
            fill: "-1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: {
            suggestedMin: -1000,
            suggestedMax: 1000,
            title: { display: true, text: "PCM Amplitude", color: tickColor },
            ticks: { color: tickColor },
            grid: { color: gridColor },
          },
        },
      },
    });
    waveCanvas._oaeChart = wChart;
  }
}

function renderToneTestPanel() {
  const hwWarn = document.getElementById("dev-tone-hw-warn");
  const runBtn = document.getElementById("btn-run-tone-test");
  const errBox = document.getElementById("dev-tone-error");
  const resBox = document.getElementById("dev-tone-result");

  const hwConnected = Boolean(store.audioDevice.connected);
  const busy = store.dev.toneTestBusy || store.activeSession.state === "running";
  if (hwWarn) hwWarn.classList.toggle("hidden", hwConnected);
  if (runBtn) {
    runBtn.disabled = !hwConnected || busy;
    runBtn.textContent = store.dev.toneTestBusy ? "Running Tone Test..." : "Run Live Tone Test";
  }

  if (errBox) {
    errBox.classList.toggle("hidden", !store.dev.toneTestError);
    errBox.textContent = store.dev.toneTestError || "";
  }

  const res = store.dev.toneTestResult;
  if (resBox) {
    if (!res) {
      resBox.classList.add("hidden");
    } else {
      resBox.classList.remove("hidden");
      const wavUrl = res.wav_filename ? `/api/dev/wav/${encodeURIComponent(res.wav_filename)}` : "";
      resBox.innerHTML = `
        <div class="dev-metrics-row" style="margin-bottom:0.65rem;">
          <span class="badge badge-info">Peak Freq: ${Number(res.measured_peak_hz).toFixed(1)} Hz</span>
          <span class="badge badge-neutral">RMS: ${Number(res.rms_dbfs).toFixed(1)} dBFS</span>
          <span class="badge badge-neutral">Peak: ${Number(res.peak_dbfs).toFixed(1)} dBFS</span>
          <span class="badge ${res.clipped_samples > 0 ? "badge-danger" : "badge-success"}">${res.clipped_samples} Clipped</span>
          <span class="badge badge-neutral">Latency: ${Number(res.latency_ms).toFixed(1)} ms</span>
          <span class="badge badge-neutral">Amp Applied: ${Number(res.amplitude_applied).toFixed(2)}</span>
        </div>
        ${
          wavUrl
            ? `<div class="wav-player-row">
                 <audio controls src="${wavUrl}"></audio>
                 <a class="btn btn-outline btn-sm" href="${wavUrl}" download="${escapeHtml(res.wav_filename)}">Download WAV</a>
               </div>`
            : ""
        }
      `;
    }
  }
}

function renderOverridesForm() {
  const cb = document.getElementById("dev-use-overrides");
  if (cb) cb.checked = Boolean(store.settings.dev_overrides_enabled);

  const ov = store.settings.dev_overrides || {};
  const cfg = store.config || {};
  const map = {
    "ov-snr": ov.snr_threshold_db ?? cfg.snr_threshold_db ?? 7.0,
    "ov-tone-sec": ov.constant_tone_seconds ?? cfg.constant_tone_seconds ?? 5,
    "ov-min-freqs": ov.pass_rule_min_frequencies ?? cfg.pass_rule_min_frequencies ?? 3,
    "ov-amp": ov.amp_threshold ?? cfg.amp_threshold ?? 500,
    "ov-art": ov.art_threshold_db ?? cfg.art_threshold_db ?? 4.0,
  };
  for (const [id, val] of Object.entries(map)) {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) {
      input.value = val;
    }
  }
}

function renderConsoleDrawer() {
  const body = document.getElementById("dev-console-body");
  const toggleBtn = document.getElementById("btn-toggle-console");
  const logEl = document.getElementById("dev-console-log");
  if (body) body.classList.toggle("hidden", !store.dev.consoleOpen);
  if (toggleBtn) toggleBtn.textContent = store.dev.consoleOpen ? "Hide Console" : "Show Console";
  if (logEl) {
    const lines = store.dev.consoleLogs || [];
    logEl.textContent = lines.length
      ? lines.map((l) => `[${l.ts}] [${l.kind}] ${l.text}`).join("\n")
      : "No live telemetry events logged in this browser session yet.";
    logEl.scrollTop = logEl.scrollHeight;
  }
}

export function renderDev() {
  if (!store.settings.dev_mode) return;
  renderSpectrumAndWaveform();
  renderToneTestPanel();
  renderOverridesForm();
  renderConsoleDrawer();
}

export function initDev() {
  document.getElementById("btn-dev-refresh-runs").addEventListener("click", fetchDevRuns);
  document.getElementById("dev-run-select").addEventListener("change", (e) => {
    if (e.target.value) loadDevSpectrum(e.target.value);
  });

  // Cleanup Chart.js instances cleanly on canvas
  const origDestroy = window.Chart?.getChart;
  if (typeof origDestroy === "function") {
    // Chart.js v4 automatically associates chart with canvas via Chart.getChart
  }

  // Tone Test Form
  document.getElementById("dev-tone-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    store.dev.toneTestBusy = true;
    store.dev.toneTestError = null;
    notify();

    const channel = document.getElementById("tone-channel").value;
    const freqHz = Number(document.getElementById("tone-freq").value);
    const f2Raw = document.getElementById("tone-f2").value.trim();
    const f2Hz = f2Raw ? Number(f2Raw) : null;
    const durationS = Number(document.getElementById("tone-duration").value);
    const amplitude = Number(document.getElementById("tone-amp").value);

    try {
      const resp = await fetch("/api/dev/tone-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          freq_hz: freqHz,
          f2_hz: f2Hz,
          duration_s: durationS,
          amplitude,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(body.detail || `Tone test failed (HTTP ${resp.status})`);
      }
      store.dev.toneTestResult = body;
    } catch (err) {
      store.dev.toneTestError = err.message;
    } finally {
      store.dev.toneTestBusy = false;
      notify();
    }
  });

  // Parameter Overrides
  const readOverridesFromInputs = () => ({
    snr_threshold_db: Number(document.getElementById("ov-snr").value),
    constant_tone_seconds: Number(document.getElementById("ov-tone-sec").value),
    pass_rule_min_frequencies: Number(document.getElementById("ov-min-freqs").value),
    amp_threshold: Number(document.getElementById("ov-amp").value),
    art_threshold_db: Number(document.getElementById("ov-art").value),
  });

  document.getElementById("dev-use-overrides").addEventListener("change", (e) => {
    updateSettings({
      dev_overrides_enabled: Boolean(e.target.checked),
      dev_overrides: readOverridesFromInputs(),
    });
  });

  ["ov-snr", "ov-tone-sec", "ov-min-freqs", "ov-amp", "ov-art"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      updateSettings({ dev_overrides: readOverridesFromInputs() });
    });
  });

  document.getElementById("btn-reset-overrides").addEventListener("click", () => {
    updateSettings({ dev_overrides_enabled: false, dev_overrides: {} });
  });

  // Console Drawer
  document.getElementById("btn-toggle-console").addEventListener("click", () => {
    store.dev.consoleOpen = !store.dev.consoleOpen;
    notify();
  });
  document.getElementById("btn-clear-console").addEventListener("click", () => {
    store.dev.consoleLogs = [];
    notify();
  });
}

export function clearDevChartsBeforeThemeSwap() {
  lastSpectrumRenderKey = "";
  ["dev-fft-canvas", "dev-wave-canvas"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el._oaeChart) {
      el._oaeChart.destroy();
      el._oaeChart = null;
    }
  });
}
