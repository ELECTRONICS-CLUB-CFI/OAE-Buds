/**
 * Chart.js DP-Gram Renderer & Shared Clinical Ear Result Card Helper
 */

const chartRegistry = new Map();

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function destroyChart(canvasId) {
  const existing = chartRegistry.get(canvasId);
  if (existing) {
    existing.destroy();
    chartRegistry.delete(canvasId);
  }
}

export function renderDpGramChart(canvasId, frequencies, snrThresholdDb = 7.0) {
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof window.Chart === "undefined") {
    return;
  }

  const freqs = Array.isArray(frequencies) ? frequencies : [];
  if (freqs.length === 0) {
    return;
  }

  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark";

  const labels = freqs.map((f) => `${f.f2} Hz`);
  const signalData = freqs.map((f) => Number(f.signal_db));
  const noiseData = freqs.map((f) => Number(f.noise_db));
  const thresholdData = freqs.map((f) => Number((Number(f.noise_db) + Number(snrThresholdDb)).toFixed(1)));
  const pointColors = freqs.map((f) => (f.pass ? (isDark ? "#4ade80" : "#15803d") : (isDark ? "#f87171" : "#b91c1c")));

  const gridColor = isDark ? "#334155" : "#e2e8f0";
  const tickColor = isDark ? "#cbd5e1" : "#334155";
  const noiseLineColor = isDark ? "#94a3b8" : "#64748b";
  const noisePointBg = isDark ? "#111827" : "#ffffff";
  const signalLineColor = isDark ? "#2dd4bf" : "#0f766e";
  const pointBorderColor = isDark ? "#111827" : "#ffffff";
  const threshLineColor = isDark ? "rgba(74, 222, 128, 0.65)" : "rgba(21, 128, 61, 0.55)";
  const threshFillColor = isDark ? "rgba(20, 184, 166, 0.16)" : "rgba(16, 185, 129, 0.14)";

  const chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Noise Floor (dB)",
          data: noiseData,
          borderColor: noiseLineColor,
          backgroundColor: noisePointBg,
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 5,
          pointBackgroundColor: noisePointBg,
          pointBorderColor: noiseLineColor,
          pointBorderWidth: 2,
          tension: 0.15,
          fill: false,
        },
        {
          label: `Pass Threshold (Noise + ${snrThresholdDb} dB)`,
          data: thresholdData,
          borderColor: threshLineColor,
          backgroundColor: threshFillColor,
          borderWidth: 1.5,
          borderDash: [2, 3],
          pointRadius: 0,
          tension: 0.15,
          fill: "-1",
        },
        {
          label: "DPOAE Signal (2f1 - f2)",
          data: signalData,
          borderColor: signalLineColor,
          backgroundColor: signalLineColor,
          borderWidth: 3,
          pointRadius: 6,
          pointHoverRadius: 8,
          pointBackgroundColor: pointColors,
          pointBorderColor,
          pointBorderWidth: 2,
          tension: 0.15,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      devicePixelRatio: Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 1.5),
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 14, padding: 14, color: tickColor },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            afterBody(items) {
              if (!items.length) return "";
              const idx = items[0].dataIndex;
              const f = freqs[idx];
              if (!f) return "";
              return `SNR: ${Number(f.snr_db).toFixed(1)} dB (${f.pass ? "PASS" : "REFER"})`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Stimulus f2 Frequency", color: tickColor },
          ticks: { color: tickColor },
          grid: { color: gridColor },
        },
        y: {
          title: { display: true, text: "Level (dB)", color: tickColor },
          ticks: { color: tickColor },
          grid: { color: gridColor },
        },
      },
    },
  });

  chartRegistry.set(canvasId, chart);
}

export function buildEarCardHtml(summary, canvasId, minRequired = 3, options = {}) {
  if (!summary) return "";
  const earLabel = String(summary.ear || "left").toUpperCase();
  const isPass = summary.verdict === "Pass";
  const bannerCls = isPass ? "verdict-pass" : "verdict-refer";
  const verdictLabel = isPass ? "PASS" : "REFER";
  const passedCount = summary.passed_count ?? 0;
  const totalFreqs = summary.total_active_frequencies ?? (summary.frequencies ? summary.frequencies.length : 0);
  const freqs = Array.isArray(summary.frequencies) ? summary.frequencies : [];
  const deleteEarBtnHtml = options.deleteFilename
    ? `<button type="button" class="btn btn-danger btn-sm btn-delete-ear no-print" data-filename="${escapeHtml(
        options.deleteFilename
      )}" data-ear="${escapeHtml(summary.ear || earLabel.toLowerCase())}">Delete ${earLabel} Ear</button>`
    : "";

  const rowsHtml = freqs
    .map((f) => {
      const statusBadge = f.pass
        ? '<span class="badge badge-success">PASS</span>'
        : '<span class="badge badge-danger">REFER</span>';
      return `
        <tr>
          <td><strong>${escapeHtml(f.f2)} Hz</strong></td>
          <td>${escapeHtml(f.f1)} Hz</td>
          <td>${escapeHtml(f.oae_bin ?? "-")} Hz</td>
          <td>${Number(f.signal_db).toFixed(1)}</td>
          <td>${Number(f.noise_db).toFixed(1)}</td>
          <td><strong>${Number(f.snr_db).toFixed(1)}</strong></td>
          <td>${escapeHtml(f.segments_rejected ?? 0)}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    })
    .join("");

  const fitBadgeHtml =
    summary.fit_check_enabled === false
      ? '<span class="badge badge-neutral">Fit Check: Skipped</span>'
      : summary.fit_check_passed === false
        ? '<span class="badge badge-danger">Fit Check: NOT SEALED (Fail)</span>'
        : '<span class="badge badge-success">Fit Check: SEALED (Pass)</span>';

  const calibBadgeHtml =
    summary.vol_calib_enabled === false
      ? '<span class="badge badge-neutral">Vol Calib: Skipped</span>'
      : summary.vol_calib_passed === false
        ? '<span class="badge badge-danger">Vol Calib: Failed</span>'
        : '<span class="badge badge-success">Vol Calib: Pass</span>';

  const noiseBadgeHtml =
    summary.noise_check === "retry"
      ? '<span class="badge badge-warning">Ambient Noise: Retry</span>'
      : '<span class="badge badge-success">Ambient Noise: Pass</span>';

  return `
    <div class="card ear-result-card">
      <div class="verdict-banner ${bannerCls}">
        <div>
          <span class="pill pill-neutral">${earLabel} EAR</span>
          <h3 class="verdict-title">VERDICT: ${verdictLabel}</h3>
        </div>
        <div class="table-actions">
          <div class="verdict-sub">
            ${passedCount} of ${totalFreqs} Frequencies Passed (Min Required: ${minRequired})
          </div>
          ${deleteEarBtnHtml}
        </div>
      </div>

      <div class="dev-metrics-row" style="margin-bottom: 0.9rem;">
        ${fitBadgeHtml}
        ${calibBadgeHtml}
        ${noiseBadgeHtml}
      </div>

      <div class="chart-box">
        <canvas id="${escapeHtml(canvasId)}"></canvas>
      </div>

      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>f2</th>
              <th>f1</th>
              <th>DP Bin</th>
              <th>Signal (dB)</th>
              <th>Noise (dB)</th>
              <th>SNR (dB)</th>
              <th>Rejected</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="8" class="muted">No frequency data recorded.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
