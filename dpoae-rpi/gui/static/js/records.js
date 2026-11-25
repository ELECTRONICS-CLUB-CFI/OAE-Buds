/**
 * Past Records Browser, Filter Search, Detail Modal, and JSON Export
 */

import { store, notify } from "./store.js";
import { buildEarCardHtml, destroyChart, escapeHtml, renderDpGramChart } from "./dpgram_chart.js";

let currentModalRecord = null;

export async function fetchRecords() {
  store.records.loading = true;
  notify();

  const params = new URLSearchParams();
  if (store.records.search) params.set("search", store.records.search);
  if (store.records.verdict) params.set("verdict", store.records.verdict);
  if (store.records.ear) params.set("ear", store.records.ear);
  params.set("limit", "50");

  try {
    const resp = await fetch(`/api/records?${params.toString()}`, { cache: "no-store" });
    if (resp.ok) {
      const body = await resp.json();
      store.records.items = body.records || [];
    }
  } catch (err) {
    console.error("Failed to fetch records:", err);
  } finally {
    store.records.loading = false;
    notify();
  }
}

async function openRecordModal(group) {
  currentModalRecord = group;
  const modal = document.getElementById("record-modal");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");

  title.textContent = `Patient: ${group.patient_id} (${group.timestamp || ""})`;
  body.innerHTML = '<p class="muted">Loading record details...</p>';
  modal.classList.remove("hidden");

  destroyChart("modal-chart-left");
  destroyChart("modal-chart-right");

  const ears = group.ears || {};
  const minReq = store.config.pass_rule_min_frequencies || 3;
  const snrThresh = store.config.snr_threshold_db || 7.0;

  let leftFull = null;
  let rightFull = null;

  if (ears.left?.filename) {
    const r = await fetch(`/api/records/${encodeURIComponent(ears.left.filename)}`);
    if (r.ok) leftFull = await r.json();
  }
  if (ears.right?.filename) {
    const r = await fetch(`/api/records/${encodeURIComponent(ears.right.filename)}`);
    if (r.ok) rightFull = await r.json();
  }

  currentModalRecord._full = { left: leftFull, right: rightFull };

  let html = `
    <div class="print-header print-only">
      <h1>OAE Buds — Clinical Screening Record</h1>
      <div class="print-meta">Patient: ${escapeHtml(group.patient_id)} | Session: ${escapeHtml(group.session_id || "—")} | Date: ${escapeHtml(group.timestamp)}</div>
    </div>
    <p class="muted" style="margin-bottom: 1rem;">
      Session ID: <strong>${escapeHtml(group.session_id || "Single Run")}</strong>
      ${group.notes ? ` • Notes: ${escapeHtml(group.notes)}` : ""}
    </p>
  `;

  if (leftFull) html += buildEarCardHtml(leftFull, "modal-chart-left", minReq);
  if (rightFull) html += buildEarCardHtml(rightFull, "modal-chart-right", minReq);
  body.innerHTML = html;

  if (leftFull) renderDpGramChart("modal-chart-left", leftFull.frequencies, snrThresh);
  if (rightFull) renderDpGramChart("modal-chart-right", rightFull.frequencies, snrThresh);
}

export function refreshOpenModalCharts() {
  const modal = document.getElementById("record-modal");
  if (!modal || modal.classList.contains("hidden") || !currentModalRecord?._full) {
    return;
  }
  const snrThresh = store.config.snr_threshold_db || 7.0;
  const { left, right } = currentModalRecord._full;
  if (left) renderDpGramChart("modal-chart-left", left.frequencies, snrThresh);
  if (right) renderDpGramChart("modal-chart-right", right.frequencies, snrThresh);
}

export function renderRecords() {
  const container = document.getElementById("records-list");
  if (!container) return;

  if (store.records.loading && !store.records.items.length) {
    container.innerHTML = '<p class="muted">Loading records...</p>';
    return;
  }

  const items = store.records.items || [];
  if (!items.length) {
    container.innerHTML = '<p class="muted">No screening records match the current filter.</p>';
    return;
  }

  const rows = items
    .map((item, idx) => {
      const verdictCls = item.overall_verdict === "Pass" ? "badge-success" : "badge-danger";
      const earsList = Object.keys(item.ears || {}).map((e) => e.toUpperCase()).join(" & ");
      const earTag = item.is_bilateral ? "Bilateral (L + R)" : earsList || "—";
      return `
        <tr>
          <td>${escapeHtml(item.timestamp || "—")}</td>
          <td><strong>${escapeHtml(item.patient_id)}</strong></td>
          <td>${escapeHtml(earTag)}</td>
          <td><span class="badge ${verdictCls}">${escapeHtml(item.overall_verdict)}</span></td>
          <td>${escapeHtml(item.notes || "—")}</td>
          <td>
            <button type="button" class="btn btn-outline btn-sm btn-view-record" data-idx="${idx}">View</button>
          </td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Patient ID</th>
            <th>Ears Tested</th>
            <th>Verdict</th>
            <th>Notes</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  container.querySelectorAll(".btn-view-record").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const item = store.records.items[idx];
      if (item) openRecordModal(item);
    });
  });
}

export function initRecords() {
  let searchDebounce = null;
  document.getElementById("records-search").addEventListener("input", (e) => {
    store.records.search = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(fetchRecords, 250);
  });

  document.getElementById("records-verdict-filter").addEventListener("change", (e) => {
    store.records.verdict = e.target.value;
    fetchRecords();
  });

  document.getElementById("records-ear-filter").addEventListener("change", (e) => {
    store.records.ear = e.target.value;
    fetchRecords();
  });

  document.getElementById("btn-refresh-records").addEventListener("click", fetchRecords);

  // Modal controls
  const modal = document.getElementById("record-modal");
  const closeModal = () => {
    modal.classList.add("hidden");
    destroyChart("modal-chart-left");
    destroyChart("modal-chart-right");
  };
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  document.getElementById("modal-print-btn").addEventListener("click", () => {
    window.print();
  });

  document.getElementById("modal-download-btn").addEventListener("click", () => {
    if (!currentModalRecord) return;
    const payload = currentModalRecord._full || currentModalRecord;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentModalRecord.patient_id || "oae"}-${currentModalRecord.group_id || "record"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
