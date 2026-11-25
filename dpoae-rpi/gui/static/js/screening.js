/**
 * Screening Controller: Setup, Guided Bilateral Flow, SSE Telemetry, Elapsed Timer, & Results
 */

import { store, notify, updateSettings, hydrateFromServer, getEffectiveTheme, appendDevLog } from "./store.js";
import { buildEarCardHtml, destroyChart, escapeHtml, renderDpGramChart } from "./dpgram_chart.js";
import { fetchDevRuns, loadDevSpectrum } from "./dev.js";

let eventSource = null;
let elapsedTimerHandle = null;
let selectedWorkflow = "bilateral";
let selectedEar = "left";

function formatElapsed(seconds) {
  const secs = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function stopElapsedTicker() {
  if (elapsedTimerHandle !== null) {
    clearInterval(elapsedTimerHandle);
    elapsedTimerHandle = null;
  }
}

function ensureElapsedTicker() {
  if (store.activeSession.state === "running") {
    if (elapsedTimerHandle === null) {
      elapsedTimerHandle = setInterval(() => {
        if (store.activeSession.state === "running") {
          store.activeSession.elapsed_seconds = Number(store.activeSession.elapsed_seconds || 0) + 1;
          const el = document.getElementById("run-elapsed");
          if (el) el.textContent = formatElapsed(store.activeSession.elapsed_seconds);
        } else {
          stopElapsedTicker();
        }
      }, 1000);
    }
  } else {
    stopElapsedTicker();
  }
}

function handleTelemetryEvent(ev) {
  if (!ev || !ev.event) return;
  const s = store.activeSession;

  if (store.settings.dev_mode && ev.event !== "sync") {
    if (ev.event === "cmd") {
      appendDevLog("CMD", (ev.argv || []).join(" "));
    } else if (ev.event === "stderr") {
      appendDevLog("STDERR", ev.line || "");
    } else {
      appendDevLog(ev.event.toUpperCase(), JSON.stringify(ev));
    }
  }

  switch (ev.event) {
    case "sync":
      if (ev.active_session) {
        store.activeSession = ev.active_session;
      }
      break;

    case "started":
      s.state = "running";
      s.session_id = ev.session_id ?? s.session_id;
      s.patient_id = ev.patient_id ?? s.patient_id;
      s.current_ear = ev.ear ?? s.current_ear;
      s.total_frequencies = ev.total_pairs ?? s.total_frequencies ?? 4;
      s.frequencies_done = [];
      s.current_frequency_index = 0;
      s.elapsed_seconds = 0;
      break;

    case "phase_changed":
      s.current_phase = ev.phase;
      break;

    case "fit_check_result":
      s.fit_check_passed = Boolean(ev.passed);
      break;

    case "vol_calib_result":
      s.vol_calib_passed = Boolean(ev.passed);
      break;

    case "frequency_measuring":
      s.current_frequency_index = Number(ev.pair_index || 0);
      s.total_frequencies = Number(ev.total_pairs || s.total_frequencies || 4);
      s.current_f1 = ev.f1;
      s.current_f2 = ev.f2;
      s.artifact_status = { status: "clear", segments_accepted: 0, segments_rejected: 0 };
      break;

    case "artifact_status":
      s.artifact_status = ev;
      break;

    case "frequency_result":
      s.frequencies_done = [...(s.frequencies_done || []), ev];
      break;

    case "completed":
      if (ev.summary) {
        if (ev.ear === "left") s.left_result = ev.summary;
        if (ev.ear === "right") s.right_result = ev.summary;
      }
      if (ev.dev_filename) {
        s.dev_file = ev.dev_filename;
        if (store.settings.dev_mode) {
          fetchDevRuns().then(() => loadDevSpectrum(ev.dev_filename));
        }
      }
      if (s.workflow === "bilateral" && ev.ear === "left" && !s.right_result) {
        s.state = "waiting_for_next_ear";
        s.current_ear = "right";
      } else {
        s.state = "completed";
      }
      break;

    case "waiting_for_next_ear":
      s.state = "waiting_for_next_ear";
      s.current_ear = ev.next_ear || "right";
      if (ev.left_result) s.left_result = ev.left_result;
      break;

    case "aborted":
      s.state = "aborted";
      s.error_message = ev.reason || "Screening aborted";
      break;

    case "error":
      s.state = "error";
      s.error_message = ev.message || "Engine error occurred";
      break;

    case "reset":
      hydrateFromServer();
      return;

    default:
      break;
  }

  notify();
}

export function connectTelemetry() {
  if (eventSource) {
    eventSource.close();
  }
  const url = `${window.location.origin}/api/telemetry/stream`;
  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    store.sseConnected = true;
    notify();
  };

  eventSource.onmessage = (msg) => {
    store.sseConnected = true;
    store.serverOnline = true;
    try {
      const payload = JSON.parse(msg.data);
      handleTelemetryEvent(payload);
    } catch (err) {
      console.error("Failed to parse SSE payload:", err);
    }
  };

  eventSource.onerror = () => {
    store.sseConnected = false;
    notify();
  };
}

async function startScreeningRequest(payload) {
  const errBox = document.getElementById("setup-error");
  if (errBox) errBox.classList.add("hidden");

  try {
    const resp = await fetch("/api/test/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(body.detail || `Failed to start test (HTTP ${resp.status})`);
    }
    await hydrateFromServer();
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
    }
  }
}

function buildStartPayload(base) {
  const devMode = Boolean(store.settings.dev_mode);
  const ovEnabled = devMode && Boolean(store.settings.dev_overrides_enabled);
  return {
    ...base,
    dev_telemetry: devMode,
    overrides: ovEnabled ? store.settings.dev_overrides || {} : null,
  };
}

function renderSetupView() {
  const mockToggle = document.getElementById("setup-mock-toggle");
  const hwWarning = document.getElementById("setup-hw-warning");
  const ovPill = document.getElementById("setup-dev-overrides-pill");
  const startBtn = document.getElementById("btn-start-test");

  if (mockToggle) {
    mockToggle.checked = Boolean(store.settings.mock);
  }

  const liveBlocked = !store.settings.mock && !store.audioDevice.connected;
  if (hwWarning) {
    hwWarning.classList.toggle("hidden", !liveBlocked);
  }
  if (ovPill) {
    const activeOv = Boolean(store.settings.dev_mode && store.settings.dev_overrides_enabled);
    ovPill.classList.toggle("hidden", !activeOv);
    if (activeOv) {
      const ov = store.settings.dev_overrides || {};
      ovPill.innerHTML = `<strong>Dev Overrides Active:</strong> SNR=${ov.snr_threshold_db ?? store.config.snr_threshold_db} dB, Tone=${ov.constant_tone_seconds ?? store.config.constant_tone_seconds}s, MinPass=${ov.pass_rule_min_frequencies ?? store.config.pass_rule_min_frequencies}`;
    }
  }
  if (startBtn) {
    startBtn.disabled = liveBlocked;
  }
}

function renderRunningView() {
  const s = store.activeSession;
  document.getElementById("run-ear-pill").textContent = `${String(s.current_ear || "left").toUpperCase()} EAR`;

  const wfPill = document.getElementById("run-workflow-pill");
  if (s.workflow === "bilateral") {
    wfPill.textContent = s.current_ear === "right" ? "Bilateral 2 / 2" : "Bilateral 1 / 2";
  } else {
    wfPill.textContent = "Single Ear";
  }

  document.getElementById("run-patient-title").textContent = `Patient: ${s.patient_id || "0"}`;
  document.getElementById("run-elapsed").textContent = formatElapsed(s.elapsed_seconds);

  const phaseTitle = document.getElementById("run-phase-title");
  const phaseSub = document.getElementById("run-phase-subtitle");
  if (s.current_phase === "fit_check") {
    phaseTitle.textContent = "Probe Seal Check (226 Hz Tone)";
    phaseSub.textContent = "Verifying acoustic ear-canal seal...";
  } else if (s.current_phase === "vol_calib") {
    phaseTitle.textContent = "In-Ear Volume Calibration";
    phaseSub.textContent = "Measuring ear canal acoustics & chirp latency...";
  } else if (s.current_frequency_index > 0) {
    phaseTitle.textContent = `Measuring Pair ${s.current_frequency_index} of ${s.total_frequencies}`;
    phaseSub.textContent = `Stimulus f1 = ${s.current_f1 || "—"} Hz, f2 = ${s.current_f2 || "—"} Hz`;
  } else {
    phaseTitle.textContent = "Initializing DPOAE Sweep...";
    phaseSub.textContent = "Opening duplex audio interface...";
  }

  const total = Math.max(1, Number(s.total_frequencies || 4));
  const doneCount = (s.frequencies_done || []).length;
  let pct = Math.round((doneCount / total) * 100);
  if (s.current_phase === "frequency_sweep" && s.current_frequency_index > doneCount) {
    pct = Math.max(pct, Math.round(((s.current_frequency_index - 0.5) / total) * 100));
  }
  pct = Math.min(100, Math.max(0, pct));

  document.getElementById("run-progress-bar").style.width = `${pct}%`;
  document.getElementById("run-progress-pct").textContent = `${pct}%`;

  const artBadge = document.getElementById("run-artifact-badge");
  const art = s.artifact_status;
  if (art && Number(art.segments_rejected || 0) > 0) {
    artBadge.className = "badge badge-warning";
    artBadge.textContent = `Artifact Detected (${art.segments_rejected} rejected)`;
  } else {
    artBadge.className = "badge badge-success";
    artBadge.textContent = "Clear — Measuring";
  }

  const pillsGrid = document.getElementById("run-freq-pills");
  const pillsHtml = [];
  for (let i = 1; i <= total; i++) {
    const done = (s.frequencies_done || []).find((f) => Number(f.pair_index) === i);
    if (done) {
      const cls = done.pass ? "pass" : "refer";
      pillsHtml.push(`<div class="freq-pill ${cls}"><strong>${done.f2} Hz</strong><div>${done.pass ? "PASS" : "REFER"} (${Number(done.snr_db).toFixed(1)} dB)</div></div>`);
    } else if (s.current_frequency_index === i) {
      pillsHtml.push(`<div class="freq-pill active"><strong>${s.current_f2 || `Pair ${i}`} Hz</strong><div>Measuring...</div></div>`);
    } else {
      pillsHtml.push(`<div class="freq-pill"><strong>Pair ${i}</strong><div>Pending</div></div>`);
    }
  }
  pillsGrid.innerHTML = pillsHtml.join("");
}

function renderBilateralWaitView() {
  const s = store.activeSession;
  const left = s.left_result;
  const box = document.getElementById("bilateral-left-summary");
  if (left) {
    const cls = left.verdict === "Pass" ? "verdict-pass" : "verdict-refer";
    box.innerHTML = `
      <div class="verdict-banner ${cls}">
        <strong>LEFT EAR: ${escapeHtml(left.verdict).toUpperCase()}</strong>
        <span>${left.passed_count} / ${left.total_active_frequencies} Passed</span>
      </div>
    `;
  } else {
    box.innerHTML = "";
  }
}

let lastRenderedResultKey = "";

function renderResultsView() {
  const s = store.activeSession;
  const alertCard = document.getElementById("results-alert-card");
  const reportCard = document.getElementById("results-report-card");

  if (s.state === "aborted" || s.state === "error") {
    alertCard.classList.remove("hidden");
    reportCard.classList.add("hidden");
    document.getElementById("results-alert-title").textContent =
      s.state === "aborted" ? "Screening Aborted" : "Screening Error";
    document.getElementById("results-alert-msg").textContent =
      s.error_message || "The screening test did not complete.";
    lastRenderedResultKey = "";
    return;
  }

  alertCard.classList.add("hidden");
  reportCard.classList.remove("hidden");

  const activeTheme = document.documentElement.getAttribute("data-theme") || getEffectiveTheme();
  const resultKey = `${s.session_id}:${Boolean(s.left_result)}:${Boolean(s.right_result)}:${activeTheme}`;
  if (resultKey === lastRenderedResultKey) {
    return;
  }
  lastRenderedResultKey = resultKey;

  document.getElementById("res-patient-heading").textContent = `Patient: ${s.patient_id || "0"}`;
  const notesText = s.notes ? ` • Notes: ${s.notes}` : "";
  document.getElementById("res-meta-sub").textContent = `Session: ${s.session_id || "—"} • Profile: ${s.profile}${notesText}`;
  document.getElementById("print-meta").textContent =
    `Patient ID: ${s.patient_id} | Session: ${s.session_id} | Profile: ${s.profile} | Date: ${
      (s.right_result || s.left_result || {}).timestamp || new Date().toLocaleString()
    }${s.notes ? ` | Notes: ${s.notes}` : ""}`;

  const testOtherBtn = document.getElementById("btn-test-other-ear");
  if (Boolean(s.left_result) !== Boolean(s.right_result)) {
    const nextEar = s.left_result ? "Right" : "Left";
    testOtherBtn.textContent = `Test ${nextEar} Ear`;
    testOtherBtn.classList.remove("hidden");
  } else {
    testOtherBtn.classList.add("hidden");
  }

  const container = document.getElementById("results-ears-container");
  const minReq = store.config.pass_rule_min_frequencies || 3;
  const snrThresh = store.config.snr_threshold_db || 7.0;

  destroyChart("chart-result-left");
  destroyChart("chart-result-right");

  let html = "";
  if (s.left_result) {
    html += buildEarCardHtml(s.left_result, "chart-result-left", minReq);
  }
  if (s.right_result) {
    html += buildEarCardHtml(s.right_result, "chart-result-right", minReq);
  }
  container.innerHTML = html;

  if (s.left_result) {
    renderDpGramChart("chart-result-left", s.left_result.frequencies, snrThresh);
  }
  if (s.right_result) {
    renderDpGramChart("chart-result-right", s.right_result.frequencies, snrThresh);
  }
}

export function renderScreening() {
  const s = store.activeSession;
  const viewSetup = document.getElementById("view-setup");
  const viewRunning = document.getElementById("view-running");
  const viewWait = document.getElementById("view-bilateral-wait");
  const viewResults = document.getElementById("view-results");

  viewSetup.classList.toggle("hidden", s.state !== "idle");
  viewRunning.classList.toggle("hidden", s.state !== "running");
  viewWait.classList.toggle("hidden", s.state !== "waiting_for_next_ear");
  viewResults.classList.toggle(
    "hidden",
    !["completed", "aborted", "error"].includes(s.state)
  );

  ensureElapsedTicker();

  if (s.state === "idle") {
    lastRenderedResultKey = "";
    renderSetupView();
  } else if (s.state === "running") {
    renderRunningView();
  } else if (s.state === "waiting_for_next_ear") {
    renderBilateralWaitView();
  } else {
    renderResultsView();
  }
}

export function initScreening() {
  // Segmented workflow buttons
  const segBtns = document.querySelectorAll("#workflow-selector .seg-btn");
  segBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      segBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedWorkflow = btn.dataset.workflow || "bilateral";
      selectedEar = btn.dataset.ear || "left";
    });
  });

  // Setup mock toggle sync
  const setupMock = document.getElementById("setup-mock-toggle");
  setupMock.addEventListener("change", (e) => {
    updateSettings({ mock: Boolean(e.target.checked) });
  });

  // Start test form
  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const patientId = document.getElementById("input-patient-id").value.trim();
    const notes = document.getElementById("input-notes").value.trim();
    if (!patientId) return;

    await startScreeningRequest(
      buildStartPayload({
        patient_id: patientId,
        notes,
        ear: selectedEar,
        workflow: selectedWorkflow,
        profile: store.settings.profile,
        mock: store.settings.mock,
        fit_check: store.settings.fit_check,
        vol_calib: store.settings.vol_calib,
      })
    );
  });

  // Stop test
  document.getElementById("btn-stop-test").addEventListener("click", async () => {
    await fetch("/api/test/stop", { method: "POST" });
    await hydrateFromServer();
  });

  // Guided Bilateral Continue (Right Ear)
  document.getElementById("btn-continue-right").addEventListener("click", async () => {
    const s = store.activeSession;
    await startScreeningRequest(
      buildStartPayload({
        session_id: s.session_id,
        patient_id: s.patient_id,
        notes: s.notes,
        ear: "right",
        workflow: "bilateral",
        profile: s.profile || store.settings.profile,
        mock: s.mock,
        fit_check: s.fit_check,
        vol_calib: s.vol_calib,
      })
    );
  });

  // Finish Bilateral Early with Left Ear Only
  document.getElementById("btn-cancel-bilateral").addEventListener("click", () => {
    store.activeSession.state = "completed";
    notify();
  });

  // Reset buttons
  const resetHandler = async () => {
    await fetch("/api/test/reset", { method: "POST" });
    await hydrateFromServer();
  };
  document.getElementById("btn-reset-from-alert").addEventListener("click", resetHandler);
  document.getElementById("btn-new-screening").addEventListener("click", resetHandler);

  // Test opposite ear from single-ear result
  document.getElementById("btn-test-other-ear").addEventListener("click", async () => {
    const s = store.activeSession;
    const nextEar = s.left_result ? "right" : "left";
    await startScreeningRequest(
      buildStartPayload({
        session_id: s.session_id,
        patient_id: s.patient_id,
        notes: s.notes,
        ear: nextEar,
        workflow: "bilateral",
        profile: s.profile || store.settings.profile,
        mock: s.mock,
        fit_check: s.fit_check,
        vol_calib: s.vol_calib,
      })
    );
  });

  // Print / Save PDF
  document.getElementById("btn-print-report").addEventListener("click", () => {
    window.print();
  });

  // Download JSON
  document.getElementById("btn-download-json").addEventListener("click", () => {
    const s = store.activeSession;
    const bundle = {
      session_id: s.session_id,
      patient_id: s.patient_id,
      notes: s.notes,
      left_ear: s.left_result,
      right_ear: s.right_result,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.patient_id || "oae"}-${s.session_id || "result"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
