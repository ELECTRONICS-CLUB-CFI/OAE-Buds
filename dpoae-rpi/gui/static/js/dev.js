/**
 * Developer / Lab Tab Controller:
 *  - Lazy Visible-Only Chart.js Initialization & In-Place chart.update("none")
 *  - Decimated Waveform & Pre-Formatted {x, y} Spectrum Rendering
 *  - Media Decoder Leak Prevention for <audio controls>
 *  - Incremental DocumentFragment + rAF Batched Live Telemetry Console
 */

import { store, notify, updateSettings, getEffectiveTheme, clearDevLogs } from "./store.js";
import { escapeHtml } from "./dpgram_chart.js";

function isDevPanelVisible() {
  if (!store.settings.dev_mode || store.activeTab !== "dev") return false;
  const panel = document.getElementById("panel-dev");
  return Boolean(panel && !panel.classList.contains("hidden"));
}

function getClippedDpr() {
  return Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 1.5);
}

function releaseAudioElement(audioEl) {
  if (!audioEl) return;
  try {
    audioEl.pause();
    if (audioEl.hasAttribute("src")) {
      audioEl.removeAttribute("src");
      audioEl.load();
    }
  } catch (_) {
    // ignore media reset errors in headless/non-DOM envs
  }
}

function destroyDevCanvasChart(canvasId) {
  const el = document.getElementById(canvasId);
  if (el && el._oaeChart) {
    el._oaeChart.destroy();
    el._oaeChart = null;
    el._oaeChartMode = null;
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
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = pluginOptions.noiseLineColor || "#64748b";
        ctx.lineWidth = 1.5;
        ctx.moveTo(xScale.left, yPos);
        ctx.lineTo(xScale.right, yPos);
        ctx.stroke();
      }
    }

    for (const m of markers) {
      if (!m || typeof m.hz !== "number" || m.hz < xScale.min || m.hz > xScale.max) continue;
      const xPos = xScale.getPixelForValue(m.hz);
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.moveTo(xPos, yScale.top);
      ctx.lineTo(xPos, yScale.bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

const barValueLabelPlugin = {
  id: "oaeBarLabels",
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data) return;
    const values = chart.data.datasets?.[0]?.data || [];
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = pluginOptions?.textColor || "#cbd5e1";
    ctx.font = "700 11px sans-serif";
    ctx.textAlign = "center";
    meta.data.forEach((bar, i) => {
      const val = Number(values[i]);
      if (!Number.isFinite(val)) return;
      if (val >= 0) {
        ctx.textBaseline = "bottom";
        const yPos = Math.max(chart.chartArea.top + 14, bar.y - 4);
        ctx.fillText(`${val.toFixed(1)} dB`, bar.x, yPos);
      } else {
        ctx.textBaseline = "top";
        const yPos = Math.min(chart.chartArea.bottom - 14, bar.y + 4);
        ctx.fillText(`${val.toFixed(1)} dB`, bar.x, yPos);
      }
    });
    ctx.restore();
  },
};

function decimateEnvelopePoints(mins, maxs, targetPoints = 400) {
  const n = Math.min(Array.isArray(mins) ? mins.length : 0, Array.isArray(maxs) ? maxs.length : 0);
  if (n === 0) return { minPts: [], maxPts: [] };
  if (n <= targetPoints) {
    const minPts = new Array(n);
    const maxPts = new Array(n);
    for (let i = 0; i < n; i += 1) {
      minPts[i] = { x: i, y: Number(mins[i]) };
      maxPts[i] = { x: i, y: Number(maxs[i]) };
    }
    return { minPts, maxPts };
  }

  const bucketSize = n / targetPoints;
  const minPts = new Array(targetPoints);
  const maxPts = new Array(targetPoints);
  for (let b = 0; b < targetPoints; b += 1) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(n, Math.max(start + 1, Math.floor((b + 1) * bucketSize)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = start; j < end; j += 1) {
      const vLo = Number(mins[j]);
      const vHi = Number(maxs[j]);
      if (vLo < lo) lo = vLo;
      if (vHi > hi) hi = vHi;
    }
    minPts[b] = { x: b, y: lo };
    maxPts[b] = { x: b, y: hi };
  }
  return { minPts, maxPts };
}

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
  notify("dev_metrics");
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
  notify("dev_metrics");
}

let lastRunsSelectKey = "";
let lastPairMetaKey = "";
let lastSpectrumRenderKey = "";
let devChartMode = "bars"; // "bars" | "spectrum"

function lookupToneDb(pair, explicitVal, targetHz) {
  if (explicitVal !== undefined && explicitVal !== null && Number.isFinite(Number(explicitVal))) {
    return Number(explicitVal);
  }
  const freqs = pair?.spectrum?.freqs_hz || [];
  const mags = pair?.spectrum?.magnitudes_db || [];
  if (!freqs.length || freqs.length !== mags.length) return 0.0;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < freqs.length; i += 1) {
    const d = Math.abs(Number(freqs[i]) - Number(targetHz));
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return Number(mags[bestIdx] || 0);
}

function buildKeyToneEntries(pair, isDark, normOffsetDb = 0) {
  return [
    {
      key: "oae",
      label: `2f1-f2`,
      hz: Number(pair.oae_bin),
      fullLabel: `2f1-f2 (${pair.oae_bin} Hz)`,
      db: Number(pair.signal_db || 0) - normOffsetDb,
      color: isDark ? "#4ade80" : "#15803d",
    },
    {
      key: "f1",
      label: `f1`,
      hz: Number(pair.f1),
      fullLabel: `f1 (${pair.f1} Hz)`,
      db: lookupToneDb(pair, pair.f1_db, pair.f1) - normOffsetDb,
      color: isDark ? "#fbbf24" : "#b45309",
    },
    {
      key: "f2",
      label: `f2`,
      hz: Number(pair.f2),
      fullLabel: `f2 (${pair.f2} Hz)`,
      db: lookupToneDb(pair, pair.f2_db, pair.f2) - normOffsetDb,
      color: isDark ? "#38bdf8" : "#0369a1",
    },
    {
      key: "imd",
      label: `IMD`,
      hz: Number(pair.imd_bin),
      fullLabel: `IMD (${pair.imd_bin} Hz)`,
      db: lookupToneDb(pair, pair.imd_db, pair.imd_bin) - normOffsetDb,
      color: isDark ? "#f87171" : "#b91c1c",
    },
    {
      key: "noise",
      label: `Noise Floor`,
      hz: null,
      fullLabel: `Noise Floor`,
      db: Number(pair.noise_db || 0) - normOffsetDb,
      color: isDark ? "#94a3b8" : "#64748b",
    },
  ];
}

function updateOrCreateBarChart(canvas, entries, colors) {
  if (!canvas || typeof window.Chart === "undefined") return;
  const labels = entries.map((e) => (e.hz ? `${e.label} (${e.hz} Hz)` : e.label));
  const vals = entries.map((e) => e.db);
  const bgColors = entries.map((e) => e.color);

  if (canvas._oaeChart && canvas._oaeChartMode !== "bars") {
    destroyDevCanvasChart("dev-fft-canvas");
  }

  const existing = canvas._oaeChart;
  if (existing) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = vals;
    existing.data.datasets[0].backgroundColor = bgColors;
    existing.data.datasets[0].borderColor = bgColors;
    existing.options.plugins.oaeBarLabels = { textColor: colors.tickColor };
    existing.options.scales.x.ticks.color = colors.tickColor;
    existing.options.scales.x.grid.color = colors.gridColor;
    existing.options.scales.y.title.color = colors.tickColor;
    existing.options.scales.y.ticks.color = colors.tickColor;
    existing.options.scales.y.grid.color = colors.gridColor;
    existing.update("none");
    return;
  }

  canvas._oaeChartMode = "bars";
  canvas._oaeChart = new window.Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Amplitude (dB)",
          data: vals,
          backgroundColor: bgColors,
          borderColor: bgColors,
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 56,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      devicePixelRatio: getClippedDpr(),
      layout: { padding: { top: 22, bottom: 22 } },
      plugins: {
        legend: { display: false },
        oaeBarLabels: { textColor: colors.tickColor },
      },
      scales: {
        x: {
          ticks: { color: colors.tickColor, font: { weight: "600" } },
          grid: { display: false },
        },
        y: {
          beginAtZero: false,
          title: { display: true, text: "Amplitude (dB, |X|/N)", color: colors.tickColor },
          ticks: { color: colors.tickColor },
          grid: { color: colors.gridColor },
        },
      },
    },
    plugins: [barValueLabelPlugin],
  });
}

function updateOrCreateFftChart(canvas, pts, markers, noiseDb, colors) {
  if (!canvas || typeof window.Chart === "undefined") return;
  if (canvas._oaeChart && canvas._oaeChartMode !== "spectrum") {
    destroyDevCanvasChart("dev-fft-canvas");
  }

  const existing = canvas._oaeChart;
  if (existing) {
    existing.data.datasets[0].data = pts;
    existing.data.datasets[0].borderColor = colors.fftLineColor;
    existing.options.plugins.oaeDevMarkers = {
      markers,
      noiseDb,
      noiseLineColor: colors.noiseLineColor,
    };
    existing.options.scales.x.title.color = colors.tickColor;
    existing.options.scales.x.ticks.color = colors.tickColor;
    existing.options.scales.x.grid.color = colors.gridColor;
    existing.options.scales.y.title.color = colors.tickColor;
    existing.options.scales.y.ticks.color = colors.tickColor;
    existing.options.scales.y.grid.color = colors.gridColor;
    existing.update("none");
    return;
  }

  canvas._oaeChartMode = "spectrum";
  canvas._oaeChart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [
        {
          label: "Normalized Amplitude (dB)",
          data: pts,
          borderColor: colors.fftLineColor,
          borderWidth: 1.75,
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
      normalized: true,
      devicePixelRatio: getClippedDpr(),
      elements: {
        point: { radius: 0, hitRadius: 4 },
      },
      plugins: {
        legend: { display: false },
        oaeDevMarkers: {
          markers,
          noiseDb,
          noiseLineColor: colors.noiseLineColor,
        },
      },
      scales: {
        x: {
          type: "linear",
          min: 500,
          max: 6000,
          title: { display: true, text: "Frequency (Hz)", color: colors.tickColor },
          ticks: { color: colors.tickColor },
          grid: { color: colors.gridColor },
        },
        y: {
          title: { display: true, text: "Amplitude (dB, |X|/N)", color: colors.tickColor },
          ticks: { color: colors.tickColor },
          grid: { color: colors.gridColor },
        },
      },
    },
    plugins: [markerOverlayPlugin],
  });
}

function updateOrCreateWaveChart(canvas, minPts, maxPts, colors) {
  if (!canvas || typeof window.Chart === "undefined") return;
  const maxX = Math.max(1, minPts.length - 1);
  const existing = canvas._oaeChart;
  if (existing) {
    existing.data.datasets[0].data = minPts;
    existing.data.datasets[0].borderColor = colors.waveColor;
    existing.data.datasets[1].data = maxPts;
    existing.data.datasets[1].borderColor = colors.waveColor;
    existing.options.scales.x.max = maxX;
    existing.options.scales.y.title.color = colors.tickColor;
    existing.options.scales.y.ticks.color = colors.tickColor;
    existing.options.scales.y.grid.color = colors.gridColor;
    existing.update("none");
    return;
  }

  canvas._oaeChart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [
        {
          label: "Min",
          data: minPts,
          borderColor: colors.waveColor,
          borderWidth: 1,
          fill: false,
        },
        {
          label: "Max",
          data: maxPts,
          borderColor: colors.waveColor,
          borderWidth: 1,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      devicePixelRatio: getClippedDpr(),
      elements: {
        point: { radius: 0, hitRadius: 4 },
      },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: maxX,
          display: false,
        },
        y: {
          suggestedMin: -1000,
          suggestedMax: 1000,
          title: { display: true, text: "PCM Amplitude", color: colors.tickColor },
          ticks: { color: colors.tickColor },
          grid: { color: colors.gridColor },
        },
      },
    },
  });
}

function renderSpectrumAndWaveform() {
  const data = store.dev.spectrumData;
  const runSelect = document.getElementById("dev-run-select");
  if (runSelect) {
    const runs = store.dev.runs || [];
    const selectKey = runs.map((r) => r.filename).join("|");
    if (selectKey !== lastRunsSelectKey) {
      lastRunsSelectKey = selectKey;
      runSelect.innerHTML = runs.length
        ? runs
            .map(
              (r) =>
                `<option value="${escapeHtml(r.filename)}">${escapeHtml(r.patient_id)} (${escapeHtml(
                  String(r.ear || "").toUpperCase()
                )}) — ${escapeHtml(r.filename)}</option>`
            )
            .join("")
        : '<option value="">No --dev-telemetry runs recorded yet</option>';
    }
    if (store.dev.selectedRunFilename && runSelect.value !== store.dev.selectedRunFilename) {
      runSelect.value = store.dev.selectedRunFilename;
    }
  }

  const pairTabs = document.getElementById("dev-pair-tabs");
  const metricsEl = document.getElementById("dev-pair-metrics");
  const wavAudio = document.getElementById("dev-pair-audio");
  const wavLink = document.getElementById("dev-pair-wav-dl");

  const pairs = data?.pairs || [];
  const legendEl = document.getElementById("dev-fft-legend");
  if (!pairs.length) {
    if (lastPairMetaKey !== "empty") {
      lastPairMetaKey = "empty";
      if (pairTabs) pairTabs.innerHTML = "";
      if (legendEl) legendEl.innerHTML = "";
      if (metricsEl) {
        metricsEl.innerHTML =
          '<p class="muted">Run a screening while Developer Mode is active to inspect FFT spectra, waveform envelopes, and clipping metrics.</p>';
      }
      releaseAudioElement(wavAudio);
      if (wavLink) wavLink.classList.add("hidden");
    }
    destroyDevCanvasChart("dev-fft-canvas");
    destroyDevCanvasChart("dev-wave-canvas");
    lastSpectrumRenderKey = "";
    return;
  }

  const idx = Math.min(Math.max(0, store.dev.selectedPairIndex || 0), pairs.length - 1);
  const pair = pairs[idx];
  const sampleRate = Math.max(1, Number(data?.sample_rate || 48000));
  const normOffsetDb = 20 * Math.log10(sampleRate);
  const pairMetaKey = `${store.dev.selectedRunFilename}:${idx}:${pairs.length}:${sampleRate}:${pair.wav_file || ""}:${pair.segments_used}`;
  if (pairMetaKey !== lastPairMetaKey) {
    lastPairMetaKey = pairMetaKey;
    if (pairTabs) {
      pairTabs.innerHTML = pairs
        .map(
          (p, i) =>
            `<button type="button" class="btn btn-sm ${i === idx ? "btn-primary" : "btn-outline"} dev-pair-btn" data-idx="${i}">Pair ${
              p.pair_index
            }: ${p.f2} Hz</button>`
        )
        .join("");
    }

    if (metricsEl) {
      const clipBadge =
        Number(pair.clipped_samples || 0) > 0
          ? `<span class="badge badge-danger">${pair.clipped_samples} Clipped</span>`
          : `<span class="badge badge-success">0 Clipped</span>`;
      const rejectBadge =
        pair.segments_used === 0
          ? `<span class="badge badge-warning">All segments rejected (&gt; Amp Check) — raw block shown</span>`
          : "";
      const normSignalDb = Number(pair.signal_db || 0) - normOffsetDb;
      metricsEl.innerHTML = `
        <span class="badge badge-info">Peak: ${Number(pair.peak_dbfs).toFixed(1)} dBFS</span>
        <span class="badge badge-neutral">RMS: ${Number(pair.rms_dbfs).toFixed(1)} dBFS</span>
        ${clipBadge}
        <span class="badge badge-neutral">Signal: ${normSignalDb.toFixed(1)} dB | SNR: ${Number(pair.snr_db).toFixed(1)} dB</span>
        ${rejectBadge}
      `;
    }

    const wavFilename = pair.wav_file ? String(pair.wav_file).split("/").pop() : "";
    if (wavFilename && wavAudio && wavLink) {
      const wavUrl = `/api/dev/wav/${encodeURIComponent(wavFilename)}`;
      if (wavAudio.getAttribute("src") !== wavUrl) {
        releaseAudioElement(wavAudio);
        wavAudio.setAttribute("src", wavUrl);
      }
      wavLink.href = wavUrl;
      wavLink.download = wavFilename;
      wavLink.classList.remove("hidden");
    } else if (wavAudio && wavLink) {
      releaseAudioElement(wavAudio);
      wavLink.classList.add("hidden");
    }
  }

  // Lazy chart initialization: never instantiate charts while #panel-dev is hidden (display: none)
  if (!isDevPanelVisible()) {
    return;
  }

  const theme = getEffectiveTheme();
  const renderKey = `${store.dev.selectedRunFilename}:${idx}:${sampleRate}:${theme}:${devChartMode}`;
  if (renderKey === lastSpectrumRenderKey) return;
  lastSpectrumRenderKey = renderKey;

  const isDark = theme === "dark";
  const colors = {
    gridColor: isDark ? "#334155" : "#e2e8f0",
    tickColor: isDark ? "#cbd5e1" : "#334155",
    fftLineColor: isDark ? "#2dd4bf" : "#0f766e",
    waveColor: isDark ? "#38bdf8" : "#0369a1",
    noiseLineColor: isDark ? "#94a3b8" : "#64748b",
  };

  const entries = buildKeyToneEntries(pair, isDark, normOffsetDb);
  if (legendEl) {
    legendEl.innerHTML = entries
      .map(
        (e) =>
          `<span class="fft-legend-chip"><span class="fft-dot" style="background:${e.color};"></span><span>${escapeHtml(
            e.fullLabel
          )}: <strong>${e.db.toFixed(1)} dB</strong></span></span>`
      )
      .join("");
  }

  const fftCanvas = document.getElementById("dev-fft-canvas");
  if (fftCanvas) {
    if (devChartMode === "bars") {
      updateOrCreateBarChart(fftCanvas, entries, colors);
    } else if (pair.spectrum) {
      const freqs = pair.spectrum.freqs_hz || [];
      const mags = pair.spectrum.magnitudes_db || [];
      const pts = freqs.map((hz, i) => ({ x: Number(hz), y: Number(mags[i]) - normOffsetDb }));
      const markers = entries
        .filter((e) => e.hz !== null)
        .map((e) => ({ hz: e.hz, color: e.color }));
      updateOrCreateFftChart(fftCanvas, pts, markers, Number(pair.noise_db || 0) - normOffsetDb, colors);
    }
  }

  const waveCanvas = document.getElementById("dev-wave-canvas");
  if (waveCanvas && pair.waveform) {
    const { minPts, maxPts } = decimateEnvelopePoints(pair.waveform.min, pair.waveform.max, 400);
    updateOrCreateWaveChart(waveCanvas, minPts, maxPts, colors);
  }
}

let lastRenderedToneKey = "";

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

  if (!resBox) return;
  const res = store.dev.toneTestResult;
  const toneKey = res
    ? `${res.wav_filename || ""}:${res.measured_peak_hz}:${res.rms_dbfs}:${res.latency_ms}:${res.amplitude_applied}`
    : "";

  if (toneKey === lastRenderedToneKey) {
    return;
  }
  lastRenderedToneKey = toneKey;

  // Release any previous <audio> media decoder resources before changing or clearing DOM
  releaseAudioElement(resBox.querySelector("audio"));

  if (!res) {
    resBox.classList.add("hidden");
    resBox.innerHTML = "";
    return;
  }

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

let lastRenderedLogSeq = 0;
let lastLogResetCount = -1;
let consoleRafId = null;

function flushConsoleDrawerFrame() {
  consoleRafId = null;
  if (!store.dev.consoleOpen) return;

  const logEl = document.getElementById("dev-console-log");
  if (!logEl) return;

  const logs = store.dev.consoleLogs || [];
  if (store.dev.logResetCount !== lastLogResetCount) {
    lastLogResetCount = store.dev.logResetCount;
    lastRenderedLogSeq = 0;
    logEl.textContent = "";
  }

  if (!logs.length) {
    if (!logEl.dataset.empty) {
      logEl.textContent = "No live telemetry events logged in this browser session yet.";
      logEl.dataset.empty = "1";
    }
    return;
  }

  if (logEl.dataset.empty) {
    logEl.textContent = "";
    delete logEl.dataset.empty;
  }

  const fragment = document.createDocumentFragment();
  let appended = 0;
  for (let i = 0; i < logs.length; i += 1) {
    const entry = logs[i];
    if (entry.seq <= lastRenderedLogSeq) continue;
    const row = document.createElement("div");
    row.textContent = `[${entry.ts}] [${entry.kind}] ${entry.text}`;
    fragment.appendChild(row);
    lastRenderedLogSeq = entry.seq;
    appended += 1;
  }

  if (appended > 0) {
    logEl.appendChild(fragment);
    while (logEl.childElementCount > 300 && logEl.firstChild) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function renderConsoleDrawer() {
  const body = document.getElementById("dev-console-body");
  const toggleBtn = document.getElementById("btn-toggle-console");
  if (body) body.classList.toggle("hidden", !store.dev.consoleOpen);
  if (toggleBtn) toggleBtn.textContent = store.dev.consoleOpen ? "Hide Console" : "Show Console";

  if (!store.dev.consoleOpen) {
    return;
  }

  if (consoleRafId === null) {
    consoleRafId = requestAnimationFrame(flushConsoleDrawerFrame);
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

  // Single delegated listener for pair selection tabs
  document.getElementById("dev-pair-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".dev-pair-btn");
    if (!btn) return;
    store.dev.selectedPairIndex = Number(btn.dataset.idx);
    notify("dev_metrics");
  });

  // Bar Chart vs Continuous Spectrum toggle
  document.getElementById("dev-chart-mode-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".dev-mode-btn");
    if (!btn) return;
    const mode = btn.dataset.mode === "spectrum" ? "spectrum" : "bars";
    if (mode === devChartMode) return;
    devChartMode = mode;
    document.querySelectorAll("#dev-chart-mode-tabs .dev-mode-btn").forEach((b) => {
      const active = b.dataset.mode === devChartMode;
      b.classList.toggle("btn-primary", active);
      b.classList.toggle("btn-outline", !active);
    });
    notify("dev_metrics");
  });

  // Tone Test Form
  document.getElementById("dev-tone-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    store.dev.toneTestBusy = true;
    store.dev.toneTestError = null;
    notify("dev_tone");

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
      notify("dev_tone");
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
    notify("dev_logs");
  });
  document.getElementById("btn-clear-console").addEventListener("click", () => {
    clearDevLogs();
    notify("dev_logs");
  });
}

export function clearDevChartsBeforeThemeSwap() {
  lastSpectrumRenderKey = "";
}
