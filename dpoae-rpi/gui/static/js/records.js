/**
 * Past Records Browser, Filter Search, Detail Modal, and JSON Export
 */

import { store, notify, hydrateFromServer } from "./store.js";
import { buildEarCardHtml, destroyChart, escapeHtml, renderDpGramChart } from "./dpgram_chart.js";
import { fetchDevRuns } from "./dev.js";

let currentModalRecord = null;
let pendingDeleteRequest = null;
let lastRecordsSignature = "";

export async function fetchRecords() {
  store.records.loading = true;
  notify("records");

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
    notify("records");
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

  const hasBothEars = Boolean(leftFull && rightFull);
  if (leftFull) {
    html += buildEarCardHtml(leftFull, "modal-chart-left", minReq, {
      deleteFilename: hasBothEars ? ears.left?.filename : null,
    });
  }
  if (rightFull) {
    html += buildEarCardHtml(rightFull, "modal-chart-right", minReq, {
      deleteFilename: hasBothEars ? ears.right?.filename : null,
    });
  }
  body.innerHTML = html;

  if (leftFull) renderDpGramChart("modal-chart-left", leftFull.frequencies, snrThresh);
  if (rightFull) renderDpGramChart("modal-chart-right", rightFull.frequencies, snrThresh);
}

function getGroupFilenames(group) {
  const ears = group?.ears || {};
  return Object.values(ears)
    .map((e) => e?.filename)
    .filter(Boolean);
}

function openDeleteConfirmModal({ title, summaryHtml, filenames, deletedEar = null }) {
  if (!filenames || !filenames.length) return;
  pendingDeleteRequest = { filenames, deletedEar };

  const modal = document.getElementById("delete-confirm-modal");
  const titleEl = document.getElementById("delete-confirm-title");
  const summaryEl = document.getElementById("delete-confirm-summary");
  const keepCb = document.getElementById("delete-keep-artifacts");
  const errEl = document.getElementById("delete-confirm-error");
  const confirmBtn = document.getElementById("btn-delete-confirm");

  titleEl.textContent = title || "Delete Screening Record?";
  summaryEl.innerHTML = summaryHtml;
  keepCb.checked = false;
  errEl.classList.add("hidden");
  errEl.textContent = "";
  confirmBtn.disabled = false;
  confirmBtn.textContent = "Delete";
  modal.classList.remove("hidden");
}

function closeDeleteConfirmModal() {
  pendingDeleteRequest = null;
  document.getElementById("delete-confirm-modal").classList.add("hidden");
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

  const items = store.records.items || [];
  const sig = `${Boolean(store.records.loading)}:${items
    .map((i) => `${i.group_id}|${i.timestamp_ms}|${i.overall_verdict}|${Object.keys(i.ears || {}).join(",")}`)
    .join(";")}`;
  if (sig === lastRecordsSignature) {
    return;
  }
  lastRecordsSignature = sig;

  if (store.records.loading && !items.length) {
    container.innerHTML = '<p class="muted">Loading records...</p>';
    return;
  }

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
            <div class="table-actions">
              <button type="button" class="btn btn-outline btn-sm btn-view-record" data-idx="${idx}">View</button>
              <button type="button" class="btn btn-danger btn-sm btn-delete-record" data-idx="${idx}">Delete</button>
            </div>
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
}

export function initRecords() {
  // Single delegated click listener instead of rebinding per row on every render
  document.getElementById("records-list").addEventListener("click", (e) => {
    const viewBtn = e.target.closest(".btn-view-record");
    if (viewBtn) {
      const idx = Number(viewBtn.dataset.idx);
      const item = store.records.items[idx];
      if (item) openRecordModal(item);
      return;
    }

    const delBtn = e.target.closest(".btn-delete-record");
    if (delBtn) {
      const idx = Number(delBtn.dataset.idx);
      const item = store.records.items[idx];
      if (!item) return;
      const filenames = getGroupFilenames(item);
      const earsLabel = item.is_bilateral
        ? "Bilateral (Left & Right)"
        : Object.keys(item.ears || {}).map((k) => k.toUpperCase()).join(", ");
      openDeleteConfirmModal({
        title: "Delete Screening Session?",
        summaryHtml: `Delete record for patient <strong>${escapeHtml(item.patient_id)}</strong> (${escapeHtml(
          earsLabel
        )}, ${escapeHtml(item.timestamp || "—")})?`,
        filenames,
      });
    }
  });

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
    currentModalRecord = null;
    destroyChart("modal-chart-left");
    destroyChart("modal-chart-right");
  };
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.getElementById("modal-body").addEventListener("click", (e) => {
    const earDelBtn = e.target.closest(".btn-delete-ear");
    if (!earDelBtn || !currentModalRecord) return;
    const filename = earDelBtn.dataset.filename;
    const ear = earDelBtn.dataset.ear || "";
    if (!filename) return;
    openDeleteConfirmModal({
      title: `Delete ${ear.toUpperCase()} Ear Record?`,
      summaryHtml: `Delete only the <strong>${escapeHtml(ear.toUpperCase())}</strong> ear result for patient <strong>${escapeHtml(
        currentModalRecord.patient_id
      )}</strong>? The other ear in this session will be kept.`,
      filenames: [filename],
      deletedEar: ear,
    });
  });

  document.getElementById("modal-delete-btn").addEventListener("click", () => {
    if (!currentModalRecord) return;
    const filenames = getGroupFilenames(currentModalRecord);
    const earsLabel = currentModalRecord.is_bilateral
      ? "Bilateral (Left & Right)"
      : Object.keys(currentModalRecord.ears || {}).map((k) => k.toUpperCase()).join(", ");
    openDeleteConfirmModal({
      title: "Delete Screening Session?",
      summaryHtml: `Delete session for patient <strong>${escapeHtml(
        currentModalRecord.patient_id
      )}</strong> (${escapeHtml(earsLabel)}, ${escapeHtml(currentModalRecord.timestamp || "—")})?`,
      filenames,
    });
  });

  const delConfirmModal = document.getElementById("delete-confirm-modal");
  document.getElementById("btn-delete-cancel").addEventListener("click", closeDeleteConfirmModal);
  delConfirmModal.addEventListener("click", (e) => {
    if (e.target === delConfirmModal) closeDeleteConfirmModal();
  });
  document.getElementById("btn-delete-confirm").addEventListener("click", async () => {
    if (!pendingDeleteRequest) return;
    const { filenames, deletedEar } = pendingDeleteRequest;
    const keepArtifacts = Boolean(document.getElementById("delete-keep-artifacts").checked);
    const errEl = document.getElementById("delete-confirm-error");
    const confirmBtn = document.getElementById("btn-delete-confirm");

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting...";
    errEl.classList.add("hidden");

    try {
      const resp = await fetch("/api/records/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filenames,
          delete_artifacts: !keepArtifacts,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(body.detail || `Failed to delete record (HTTP ${resp.status})`);
      }

      const deletedDev = new Set(body.deleted_artifacts || []);
      const wasModalOpen = !modal.classList.contains("hidden") && currentModalRecord;
      const modalGroupId = currentModalRecord?.group_id;

      closeDeleteConfirmModal();
      await fetchRecords();
      await hydrateFromServer();

      if (store.settings.dev_mode && !keepArtifacts) {
        if (store.dev.selectedRunFilename && deletedDev.has(store.dev.selectedRunFilename)) {
          store.dev.selectedRunFilename = null;
          store.dev.spectrumData = null;
        }
        fetchDevRuns();
      }

      if (wasModalOpen) {
        if (deletedEar) {
          const updatedGroup = (store.records.items || []).find((g) => g.group_id === modalGroupId);
          if (updatedGroup && Object.keys(updatedGroup.ears || {}).length > 0) {
            await openRecordModal(updatedGroup);
            return;
          }
        }
        closeModal();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!delConfirmModal.classList.contains("hidden")) {
        closeDeleteConfirmModal();
      } else if (!modal.classList.contains("hidden")) {
        closeModal();
      }
    }
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
