# OAE Buds — Wireless Clinical & Lab Web GUI

100% offline, zero-build web interface for the **OAE Buds** C++20 DPOAE hearing screening engine on a headless **Raspberry Pi 5**. Designed to be served over a local Wi-Fi hotspot or LAN and operated from any tablet, smartphone, or laptop browser.

---

## 1. Architecture Overview

* **Backend (`gui/app/`)**: Python **FastAPI + Uvicorn** server supervising the native `build/dpoae-rpi` binary via `asyncio.create_subprocess_exec` with `--json-stream` (NDJSON) telemetry and **Server-Sent Events (SSE)** streaming.
* **Frontend (`gui/static/`)**: Zero-build **Vanilla HTML5 + ES6 modules + self-contained CSS** with locally vendored `chart.umd.min.js`. **Zero external CDN requests**—works completely offline on an air-gapped Raspberry Pi hotspot.
* **Resilience & Safety**:
  * In-memory active session hydration (`GET /api/status`) survives tablet sleep, screen locks, and browser refreshes.
  * Shared `asyncio.Lock` hardware mutex prevents concurrent tests (`409 Conflict`) on the single UGREEN USB audio card.
  * Non-sudo `amixer` gain locking executes automatically before live screenings and tone tests.
  * Graceful `SIGTERM` → `SIGKILL` stop handling cleanly stops ALSA duplex playback.

---

## 2. Quick Setup & Installation

Run the one-command GUI setup script from the `dpoae-rpi/` repository root:

```bash
bash gui/setup_gui.sh
```

This script automatically:
1. Installs system packages (`python3-venv`, `python3-pip`, `alsa-utils`, `curl`, plus `scripts/setup_rpi.sh` dependencies).
2. Configures and builds `build/dpoae-rpi` if it is not already compiled.
3. Creates `gui/.venv` and installs all Python packages from `gui/requirements.txt`.
4. Verifies `gui/static/vendor/chart.umd.min.js` (for 100% offline hotspot operation) and creates `results/`.
5. Adds the current user to the Linux `audio` group so `amixer` gain locking works without `sudo` (and locks the UGREEN 80864 mixer if currently plugged in).

> **Note:** If you were newly added to the `audio` group, log out and back in (or reboot) before running live audio screenings.

### Setup Options

| Flag | Description |
|---|---|
| `--skip-apt` | Skip `apt-get` system package installation (use if dependencies are already installed) |
| `--rebuild` | Force a fresh CMake configure and build of `build/dpoae-rpi` |
| `--with-systemd` | Install and enable `oae-gui.service` to start the Web GUI automatically on boot |

---

## 3. Starting the GUI

Launch the server from `dpoae-rpi/`:
```bash
./gui/run_gui.sh
```

Then open **`http://<raspberry-pi-ip>:8000`** (or **`http://localhost:8000`** locally) in a browser on your tablet, phone, or laptop.

### Optional Environment Variables
| Variable | Default | Description |
|---|---|---|
| `OAE_GUI_HOST` | `0.0.0.0` | Bind interface address |
| `OAE_GUI_PORT` | `8000` | HTTP server port |
| `OAE_RESULTS_DIR` | `./results` | Directory for clinical JSON, `-dev.json`, and WAV files |

---

## 4. Clinical Features

### Tab 1: New Screening
* **Protocols**: **Guided Bilateral** (runs Left Ear $\rightarrow$ prompts clinician to move probe $\rightarrow$ runs Right Ear), **Left Ear Only**, or **Right Ear Only**.
* **Mock / Demo Mode**: Toggle offline synthetic screening without USB audio hardware connected.
* **Live Progress View**: Displays active phase (`fit_check`, `vol_calib`, or `frequency_sweep`), pair progress (`Pair X of 4`), elapsed time, artifact retry badge, and an **Abort** button.
* **Clinical Results**: High-contrast **PASS / REFER** banners, interactive Chart.js **DP-Gram** (with dynamic frequency-relative `Noise + SNR Threshold` shading), detailed frequency table, **Print / Save PDF** (`@media print` white-paper layout), and **Download JSON**.

### Tab 2: Past Records
* Indexes `./results/*.json` (excluding `*-dev.json` sidecar files).
* Groups Left and Right ear tests sharing a `session_id` into unified bilateral patient records.
* Search by Patient ID / Session ID / Notes, filter by Verdict or Ear, inspect historical DP-Grams, print, or download JSON.

### Tab 3: Settings & Diag
* **Appearance Theme**: **Auto (Follow Device)**, **Light Mode**, or **Dark Mode** (also toggleable from the top header bar). Printing automatically switches charts and CSS to light paper contrast.
* **Hardware Profile & Options**: Select TOML profile (`ugreen_80864_rpi5`, etc.) and toggle `--fit-check` / `--vol-calib`.
* **Audio Diagnostics**: Live detection of the UGREEN / USB audio card from `/proc/asound/cards` and manual **Verify & Lock ALSA Mixer** button.

---

## 5. Developer / Lab Mode (Opt-In)

Developer Mode is **hidden by default** in clinical mode.

1. Unlock it in **Settings & Diag** via **Developer / Lab Mode** (or by visiting `?dev=1`), and confirm the **I Understand — Unlock Dev Mode** safety prompt.
2. Open the **Dev / Lab** tab:
   * **FFT Spectrum & Waveform Inspector**: Auto-loads the latest `--dev-telemetry` sidecar (`*-dev.json`), provides a **Recent Dev Runs** selector and Pair 1–4 tabs, plots 512 FFT bins (`500 Hz – 6 kHz`) with $f_1$, $f_2$, $2f_1 - f_2$ (OAE), IMD, and Noise Floor markers, displays a 500-point min/max PCM waveform envelope, `Peak dBFS` / `RMS dBFS` / `Clipped Samples` badges, and plays pair WAV recordings via `<audio controls>`.
   * **Manual Tone & Loopback Bench Test**: Requires live USB audio hardware (`503` if disconnected, `409` if a test is running). Plays Left, Right, or Dual-Tone signals (hard-clamped in C++ to `0.60` max amplitude), reports measured peak frequency, dBFS, clipping, latency, and provides inline WAV playback.
   * **DSP Parameter Overrides**: Temporarily override `snr_threshold_db`, `constant_tone_seconds`, `pass_rule_min_frequencies`, `amp_threshold`, and `art_threshold_db` when **Use Parameter Overrides** is explicitly checked (indicated by a warning banner on Tab 1).
   * **Live Telemetry & stderr Console**: Ephemeral collapsible drawer streaming executed CLI `argv`, `stderr` lines, and raw NDJSON events over SSE.

For a step-by-step hardware testing checklist using Dev Mode, see [GUI_IMPLEMENTATION_PLAN.md](GUI_IMPLEMENTATION_PLAN.md).

---

## 6. REST & SSE API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serves `static/index.html` |
| `GET` | `/api/status` | Returns server health, USB audio status, config metadata, and resumable `active_session` state |
| `GET` | `/api/telemetry/stream` | Server-Sent Events (`text/event-stream`) live telemetry stream |
| `POST` | `/api/test/start` | Starts a screening run (`409` if busy, `503` if live audio missing) |
| `POST` | `/api/test/stop` | Gracefully stops active run (`SIGTERM` $\rightarrow$ `SIGKILL`) or cancels bilateral wait |
| `POST` | `/api/test/reset` | Resets completed/aborted session state back to `idle` |
| `GET` | `/api/records` | Lists grouped clinical records (`?search=`, `?verdict=`, `?ear=`, `?limit=`) |
| `GET` | `/api/records/{filename}` | Fetches a validated clinical `.json` record |
| `POST` | `/api/hardware/verify` | Checks `/proc/asound/cards` and applies non-sudo `amixer` lock |
| `POST` | `/api/dev/tone-test` | Runs live-hardware `--tone-test` under the hardware mutex (`409` if busy, `503` if disconnected) |
| `GET` | `/api/dev/runs` | Lists available `*-dev.json` sidecar files |
| `GET` | `/api/dev/spectrum/{filename}` | Fetches decimated FFT spectrum and waveform envelope `-dev.json` |
| `GET` | `/api/dev/wav/{filename}` | Streams validated `.wav` recording (`audio/wav`) |

---

## 7. Running Tests

Run the full Python GUI test suite (unit, API, SSE, static offline compliance, and live `./gui/run_gui.sh` E2E tests):
```bash
gui/.venv/bin/python -m pytest -v gui/tests
```

---

## 8. Directory Structure

```
gui/
├── README.md                     # This file
├── GUI_IMPLEMENTATION_PLAN.md    # Architecture & staged implementation specification
├── requirements.txt              # FastAPI, Uvicorn, Pydantic, pytest, httpx
├── setup_gui.sh                  # One-command dependency & configuration setup script
├── run_gui.sh                    # Server launcher script
├── app/
│   ├── main.py                   # FastAPI app, REST routes, SSE telemetry stream
│   ├── session_manager.py        # Subprocess supervisor, NDJSON/stderr streaming, mutex
│   ├── records_manager.py        # Record indexing, bilateral grouping, path-safe retrieval
│   └── hardware.py               # /proc/asound/cards detection, amixer lock, TOML reader
├── static/
│   ├── index.html                # Single-page dashboard shell
│   ├── css/app.css               # Offline responsive stylesheet (Light, Dark, @media print)
│   ├── vendor/chart.umd.min.js   # Locally vendored Chart.js v4.4.7
│   └── js/
│       ├── store.js              # Central reactive state, localStorage & theme sync
│       ├── app.js                # Navigation, header badges, print & wake hydration hooks
│       ├── screening.js          # Screening workflow, SSE client, elapsed timer
│       ├── dpgram_chart.js       # DP-Gram Chart.js renderer & shared ear result cards
│       ├── records.js            # Past records browser & modal inspector
│       ├── settings.js           # Settings, theme, mixer check & Dev Mode unlock
│       └── dev.js                # Developer / Lab tab (FFT, waveform, tone test, console)
└── tests/
    ├── test_api.py
    ├── test_dev_backend.py
    ├── test_e2e_server.py
    ├── test_hardware.py
    ├── test_records_manager.py
    ├── test_session_manager.py
    └── test_static_frontend.py
```
