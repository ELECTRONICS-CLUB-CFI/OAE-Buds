# OAE Buds — Web GUI Implementation Specification (Production Architecture)

> **Target Platform**: Headless Raspberry Pi 5 (Raspberry Pi OS 64-bit)  
> **Client Access**: Wireless via any Tablet / Smartphone / Laptop Browser over local Wi-Fi Hotspot or LAN  
> **Backend**: Python 3 (FastAPI + Uvicorn) with Server-Sent Events (SSE) Telemetry & REST API  
> **Frontend**: 100% Offline, Zero-Build Single Page Application (Vanilla HTML5 + ES6 + Local Chart.js + Pure CSS)  
> **Screening Engine**: Native C++20 `dpoae-rpi` CLI / `liboae_core` (with `--json-stream`, `--dev-telemetry`, and `--tone-test`)

---

## 1. System Architecture & Component Diagram

```
+-----------------------------------------------------------------------------------------------+
|                    Clinician Client Device (Tablet / Smartphone / Laptop)                     |
|                                                                                               |
|   +---------------------------------------------------------------------------------------+   |
|   |                          Browser (Safari / Chrome / Firefox)                          |   |
|   |                                                                                       |   |
|   | [ Tab 1: Screening ]   [ Tab 2: Records ]   [ Tab 3: Settings ]  [ Tab 4: Dev / Lab* ]|   |
|   | - Patient & Notes      - Search Patient ID  - USB Audio Badge    - FFT Spectrum Plot  |   |
|   | - Guided Bilateral     - Bilateral Grouping - Mock / Live Toggle - Waveform & Clipping|   |
|   | - Step Progress        - DP-Gram Inspect    - Profile Selector   - Manual Tone Test   |   |
|   | - Elapsed Time/Status  - JSON Download      - Mixer Check/Reset  - WAV Audio Player   |   |
|   | - DP-Gram (Chart.js)   - Print / Save PDF   - Dev Mode Toggle    - Live Log Console   |   |
|   | - Wake Hydration       - Central State (`store.js`)              - Param Overrides    |   |
|   +-------------------------------------------^-------------------------------------------+   |
+-----------------------------------------------|-----------------------------------------------+
                                                | Local Network (Air-Gapped Hotspot or LAN)
                                                | HTTP REST & Server-Sent Events (SSE)
                                                v
+-----------------------------------------------------------------------------------------------+
|                                    Raspberry Pi 5 (Headless)                                  |
|                                                                                               |
|   +---------------------------------------------------------------------------------------+   |
|   |                          FastAPI Application Server (Port 8000)                       |   |
|   |                                                                                       |   |
|   |   - Static File Server   : Serves offline-vendored HTML/JS/CSS & Chart.js             |   |
|   |   - Hardware Mutex       : `asyncio.Lock` ensures single-device test concurrency      |   |
|   |   - Hardware Monitor     : Live detection of UGREEN 80864 in `/proc/asound/cards`     |   |
|   |   - Auto-Mixer Guardian  : Verifies & applies ALSA mixer gains before every live test  |   |
|   |   - Session Supervisor   : Spawns `dpoae-rpi --json-stream` via `create_subprocess_exec`|
|   |   - State Persistence    : In-memory active session state survives tablet sleep/wake  |   |
|   |   - SSE Telemetry Stream : Broadcasts real-time events (+ `stderr` in Dev Mode)       |   |
|   +-------------------------------------------^-------------------------------------------+   |
|                                               |                                               |
|                                               v                                               |
|   +---------------------------------------------------------------------------------------+   |
|   |                           Native C++ Engine (`dpoae-rpi`)                             |   |
|   |                                                                                       |   |
|   |   - NDJSON Stream Engine : `--json-stream` emits flushed JSON lines per event         |   |
|   |   - Dev Telemetry & Bench: `--dev-telemetry` (FFT/clip stats) & `--tone-test` loopback|   |
|   |   - Audio I/O            : ALSA Duplex via Miniaudio (UGREEN 80864 48 kHz / 16-bit)   |   |
|   |   - Signal Generation    : Dual-tone stereophonic f1/f2, chirps, 226 Hz probe tone    |   |
|   |   - DSP Engine           : Bluestein FFT, SNR calculation, `ampCheck` rejection       |   |
|   |   - Acoustic Safety      : Hard output ceiling & immediate mute/ALSA release on SIGTERM|  |
|   |   - Storage              : Writes uncompressed mono WAVs and structured JSON records  |   |
|   +---------------------------------------------------------------------------------------+   |
+-----------------------------------------------------------------------------------------------+
* Tab 4 (Dev / Lab) is hidden by default and unlocked via Settings toggle or `?dev=1` URL param.
```

---

## 2. Critical Production Architecture Decisions (Gemini Review Revisions)

### 2.1 100% Offline Hotspot Operation (Zero External CDNs)
- **Problem**: In field testing, the Pi operates as an air-gapped Wi-Fi hotspot without internet access. Any remote CDN script (Tailwind CDN, Chart.js CDN, Google Fonts, remote icons) will fail to load, resulting in an unstyled page and broken charts.
- **Solution**:
  - Vendor `chart.umd.min.js` locally in `gui/static/vendor/chart.umd.min.js`.
  - Self-contained, responsive CSS stylesheet (`gui/static/css/app.css`) using standard modern flex/grid layouts and CSS custom properties (no Node.js build step needed).
  - Use lightweight inline SVGs for all icons (~8 icons for play, stop, ear, check, warning, settings, history, print).

### 2.2 C++ `stdout` Block-Buffering Prevention (`--json-stream`)
- **Problem**: Spawning a subprocess with `stdout=PIPE` triggers C standard library 4 KB block-buffering. Without explicit flushes, stdout lines won't reach Python until the buffer fills or the test exits, completely freezing UI progress.
- **Solution**:
  - Add native `--json-stream` flag to `dpoae-rpi` that outputs Newline-Delimited JSON (`NDJSON`) and explicitly flushes after every event (`std::cout << ... << "\n" << std::flush;`).
  - Python reads lines asynchronously via `stream_reader.readline()`, avoiding fragile regex parsing.
  - As defense-in-depth, execution is invoked via standard argument arrays using `asyncio.create_subprocess_exec()`.

### 2.3 Resilient Telemetry: Server-Sent Events (SSE) over WebSockets
- **Problem**: WebSockets require bidirectional socket management, manual reconnection logic, ping/pong heartbeats, and an additional Python package dependency. When a mobile device sleeps or changes tabs, WebSockets drop and stay disconnected.
- **Solution**:
  - Use standard HTTP **Server-Sent Events** (`/api/telemetry/stream`) via FastAPI's `StreamingResponse(..., media_type="text/event-stream")`.
  - The browser's native `EventSource` automatically handles reconnection with zero custom JS boilerplate.
  - Client actions (`start`, `stop`) are simple, predictable REST `POST` requests.

### 2.4 State Recovery on Tablet Sleep / Browser Refresh
- **Problem**: If an iPad/phone screen locks during a test or between ears in a bilateral workflow, reloading the page must not wipe out the ongoing test or intermediate results.
- **Solution**:
  - `GET /api/status` returns the complete active session state:
    ```json
    {
      "server": "ok",
      "audio_device": { "connected": true, "name": "UGREEN 80864" },
      "active_session": {
        "session_id": "sess_8f93a1c2",
        "state": "running", // "idle" | "running" | "waiting_for_next_ear" | "completed"
        "patient_id": "subject_101",
        "notes": "Routine screening",
        "workflow": "bilateral", // "single" | "bilateral"
        "current_ear": "left",
        "current_phase": "frequency_sweep", // "fit_check" | "vol_calib" | "frequency_sweep"
        "current_frequency_index": 2,
        "total_frequencies": 4,
        "elapsed_seconds": 12,
        "frequencies_done": [ ... ],
        "left_result": { ... },
        "right_result": null
      }
    }
    ```
  - On page load or reconnect, `store.js` calls `GET /api/status` and immediately hydrates the UI to the exact state.

### 2.5 Automated Pre-Test ALSA Mixer Locking
- **Problem**: Asking clinicians to remember a manual "Lock Mixer" button in Settings is prone to human error. Also, calling `sudo alsactl store` from a web process fails if `sudo` requires a password.
- **Solution**:
  - In `session_manager.py`, before launching any live audio test, Python automatically executes `amixer` commands for card index (setting Mic to 100%, Capture to 100%, Playback to 100%, AGC off, Sidetone muted).
  - `amixer` only requires membership in the Linux `audio` group (no `sudo` required).
  - Settings tab provides a read-only hardware health check with an optional "Verify Audio" button.

### 2.6 Realistic Progress Telemetry (No Hard Countdown Timer)
- **Problem**: With `ampCheck` artifact rejection, noisy time segments are rejected and repeated. A fixed countdown timer (e.g. `14s remaining`) will hit `0s` prematurely during noisy tests, confusing clinicians.
- **Solution**:
  - Display **Elapsed Time** (`00:14`), **Step Stepper** (`Pair 2 of 4: 2953 Hz`), and a dynamic **Noise / Artifact Status Indicator**:
    - `"Clear — Measuring"` (Green badge)
    - `"Noise Detected — Retrying segment..."` (Amber badge)

### 2.7 Native Browser Print / PDF Reporting (`window.print()`)
- **Problem**: Raw JSON files are useless for healthcare records, but generating PDFs on the backend requires heavy dependencies (`weasyprint`, `cairo`, `reportlab`, `wkhtmltopdf`).
- **Solution**:
  - Design a dedicated `@media print` CSS layout for the Results view.
  - A `[ Print / Save PDF ]` button simply triggers `window.print()`.
  - Tablets (iOS / Android) and laptops natively format this into a clinical 1-page PDF report with patient demographics, test parameters, high-resolution DP-gram chart, and result summary table.
  - JSON record download remains available as a secondary developer/archive button.

### 2.8 Single-Hardware Concurrency Lock
- **Problem**: Multiple devices or browser tabs connected to the Pi could trigger concurrent tests, corrupting the single ALSA duplex audio stream.
- **Solution**:
  - `session_manager.py` enforces an `asyncio.Lock()`. If a test is in progress, any secondary `POST /api/test/start` or `POST /api/dev/tone-test` immediately receives `HTTP 409 Conflict` with `{ "error": "A screening test is already active." }`.

### 2.9 Acoustic Safety & Clean Subprocess Termination
- **Problem**: Abruptly terminating an audio test can leave a continuous tone sounding in the patient's ear or lock the ALSA device (`EBUSY`).
- **Solution**:
  - On `POST /api/test/stop`, Python sends `SIGTERM` to `dpoae-rpi`.
  - `dpoae-rpi` traps `SIGTERM`/`SIGINT`, immediately stops the audio engine stream, releases ALSA devices, and exits.
  - Python allows a 2-second grace timeout before escalating to `SIGKILL`.

### 2.10 Developer / Lab Mode (Opt-In Diagnostics & Guardrails)
- **Problem**: During hardware bring-up and DSP tuning, developers need to inspect full FFT spectra, mic clipping, raw WAV recordings, and manual speaker/mic loopback tones—without cluttering the clinical UI or overloading the Pi's Wi-Fi/browser with raw 48 kHz audio streams.
- **Solution**:
  - **Opt-In Activation with Safety Confirmation**: Hidden by default; enabled via a toggle in Settings (or `?dev=1` query param), which displays a confirmation prompt (*"I understand..."*) before unlocking **Tab 4: Developer / Lab** and persisting the unlock in `localStorage`.
  - **Explicit Override Guard**: Parameter overrides only apply to screening runs when an explicit **"Use Parameter Overrides"** checkbox is checked in Tab 4, paired with a visible **"Dev Overrides Active"** warning pill on Tab 1.
  - **Bandwidth Guardrails**: Never stream raw 48 kHz PCM over SSE. Emit lightweight summary stats (peak dBFS, RMS, clipped sample count) via SSE, and fetch decimated FFT spectrum arrays (~512 bins in 500 Hz–6 kHz), downsampled waveform envelopes (~500 points), and WAV files on demand via REST.
  - **Zero Clinical Overhead**: Extra spectrum/envelope serialization in C++ is gated behind `--dev-telemetry`.
  - **Hardware-Only Tone Test & Safety Ceiling**: `POST /api/dev/tone-test` requires a live USB audio device (returning `503` if disconnected), and `dpoae-rpi` enforces a hard maximum output amplitude clamp (`0.60`) in C++.
  - **Ephemeral Live Console**: `cmd`, `stderr`, and raw NDJSON events stream live over SSE into a collapsible console drawer without retaining persistent log buffers across page refreshes.

---

## 3. Directory Layout & File Responsibilities

```
dpoae-rpi/
├── gui/
│   ├── GUI_IMPLEMENTATION_PLAN.md      # Master specification (this document)
│   ├── requirements.txt                # fastapi, uvicorn, pydantic
│   ├── run_gui.sh                      # Launcher script (checks dependencies & starts uvicorn)
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                     # FastAPI application, routes, and SSE streaming
│   │   ├── session_manager.py          # Process runner, NDJSON parser, ALSA mixer locking, mutex
│   │   ├── records_manager.py          # Reads, indexes, filters, and pairs bilateral JSON records
│   │   └── hardware.py                 # ALSA sound card detection (/proc/asound/cards) & amixer
│   └── static/
│       ├── index.html                  # Single-page clinical dashboard shell
│       ├── vendor/
│       │   └── chart.umd.min.js        # Vendored offline Chart.js
│       ├── css/
│       │   └── app.css                 # 100% self-contained responsive CSS & @media print styles
│       └── js/
│           ├── store.js                # Centralized reactive state store & API hydration
│           ├── app.js                  # Main navigation, tab switching, audio status poller
│           ├── screening.js            # Start/stop, Guided Bilateral flow, SSE event listeners
│           ├── dpgram_chart.js         # Chart.js DP-Gram rendering with relative SNR fill
│           ├── records.js              # Historical records list, search, view modal, JSON export
│           ├── settings.js             # Mock toggle, profile select, audio check, Dev Mode toggle
│           └── dev.js                  # Dev/Lab tab: FFT spectrum, waveform, tone test, WAV player, logs
```

---

## 4. C++ Engine Extension: `--json-stream`, `--dev-telemetry` & `--tone-test`

### 4.1 `--json-stream` NDJSON Protocol
To eliminate stdout block-buffering and fragile regex parsing, `dpoae-rpi` will accept `--json-stream`. When active, every key event is output on stdout as a single JSON line followed by `std::flush`:

```json
{"event": "started", "patient_id": "subject_101", "ear": "left", "profile": "ugreen_80864_rpi5", "timestamp": "2026-11-22 23:30:00"}
{"event": "phase_changed", "phase": "fit_check"}
{"event": "fit_check_result", "passed": true, "rms": 342.1}
{"event": "phase_changed", "phase": "vol_calib"}
{"event": "vol_calib_result", "passed": true, "chirp_latency_ms": 0.0}
{"event": "phase_changed", "phase": "frequency_sweep"}
{"event": "frequency_measuring", "pair_index": 1, "total_pairs": 4, "f1": 1640, "f2": 2016}
{"event": "artifact_status", "pair_index": 1, "segments_accepted": 3, "segments_rejected": 0, "status": "clear"}
{"event": "frequency_result", "pair_index": 1, "f1": 1640, "f2": 2016, "oae_bin": 1264, "signal_db": 18.2, "noise_db": 4.1, "snr_db": 14.1, "pass": true}
{"event": "completed", "verdict": "Pass", "passed_count": 4, "total_active_frequencies": 4, "duration_seconds": 20.45, "json_file": "results/subject_101-left-1795338426.json"}
```

If an error or abort occurs:
```json
{"event": "aborted", "reason": "SIGTERM received"}
{"event": "error", "message": "Could not open ALSA duplex audio interface"}
```

### 4.2 `--dev-telemetry` Flag
When passed alongside `--json-stream`:
- Emits lightweight audio health metrics (`peak_dbfs`, `rms_dbfs`, `clipped_samples`) per frequency pair.
- Writes a sidecar spectrum/envelope JSON file (e.g., `results/<run>-dev.json`) containing decimated FFT magnitude bins (500 Hz–6 kHz, ~512 points) with $f_1$, $f_2$, $2f_1 - f_2$, and noise-floor bin markers, plus a ~500-point min/max time-domain waveform envelope.

### 4.3 `--tone-test` Bench Subcommand
Executes a short duplex playback + capture sanity check (e.g., `--tone-test --channel left --freq 1000 --duration 2 --amp 0.2 --json-stream`), clamping amplitude to a hard C++ safety ceiling and emitting:
```json
{"event": "tone_test_result", "channel": "left", "target_hz": 1000, "measured_peak_hz": 1000.2, "rms_dbfs": -18.4, "peak_dbfs": -12.1, "clipped_samples": 0, "latency_ms": 11.4, "wav_file": "results/tone-test-1795338500.wav"}
```

---

## 5. REST & SSE API Specification

### 5.1 System & State Endpoints
- **`GET /api/status`**:
  - Returns hardware audio card connection status and current active session state (for hydration on wake/reload).
- **`GET /api/telemetry/stream`**:
  - Server-Sent Events (SSE) stream (`text/event-stream`). Emits real-time NDJSON events as they occur. When Dev Mode is active, also emits `{"event": "stderr", "line": "..."}` and `{"event": "cmd", "argv": [...]}`.

### 5.2 Screening Execution Endpoints
- **`POST /api/test/start`**:
  - Request body:
    ```json
    {
      "session_id": "sess_8f93a1c2",
      "patient_id": "subject_101",
      "notes": "Routine screening",
      "ear": "left",
      "workflow": "bilateral", // "single" | "bilateral"
      "profile": "ugreen_80864_rpi5",
      "mock": false,
      "fit_check": false,
      "vol_calib": false,
      "dev_telemetry": false,
      "overrides": {} // Optional Dev Mode parameter overrides
    }
    ```
  - Response: `200 OK` `{ "status": "started", "session_id": "..." }` or `409 Conflict` if busy.
- **`POST /api/test/stop`**:
  - Request body: `{ "session_id": "sess_8f93a1c2" }`.
  - Response: `200 OK` `{ "status": "stopping" }`.

### 5.3 Records Endpoints
- **`GET /api/records`**:
  - Query params: `?search=subject&limit=50`.
  - Returns array of summarized session records, grouped by `session_id` when bilateral.
- **`GET /api/records/{filename}`**:
  - Validates path is strictly within `./results/` (prevents path traversal).
  - Returns raw JSON clinical record.

### 5.4 Hardware & Diagnostics Endpoints
- **`POST /api/hardware/verify`**:
  - Checks `/proc/asound/cards` and runs `amixer` to verify gain lock without `sudo`.
  - Returns card name, gain levels, and status.

### 5.5 Developer & Lab Endpoints
- **`POST /api/dev/tone-test`**:
  - Acquires the same `asyncio.Lock` hardware mutex (returns `409 Conflict` if a screening is active) and requires live USB audio hardware (`503` if disconnected; locks ALSA mixer automatically).
  - Body: `{ "channel": "left" | "right" | "both", "freq_hz": 1000, "f2_hz": null, "duration_s": 2, "amplitude": 0.2 }`.
  - Runs `dpoae-rpi --tone-test --json-stream` and returns measured peak frequency, RMS/peak dBFS, clipping count, latency, and WAV filename.
- **`GET /api/dev/runs`**:
  - Lists available `*-dev.json` sidecar files in `./results/` (newest first) for the Recent Dev Runs selector.
- **`GET /api/dev/wav/{filename}`**:
  - Validates path is strictly within `./results/` and ends with `.wav`.
  - Streams uncompressed WAV via `FileResponse` for browser `<audio controls>` playback or download.
- **`GET /api/dev/spectrum/{filename}`**:
  - Validates path is strictly within `./results/` and ends with `-dev.json`.
  - Returns the decimated FFT spectrum bins and waveform envelope JSON generated by `--dev-telemetry`.

---

## 6. Implementation Stages & Verification Checklist

- [x] **Stage 1: C++ `--json-stream` NDJSON Support**:
  - Add `--json-stream` CLI flag to [src/main.cpp](file:///home/jashu/OAEBUDS/OAE-Buds/dpoae-rpi/src/main.cpp) and [src/session_runner.cpp](file:///home/jashu/OAEBUDS/OAE-Buds/dpoae-rpi/src/session_runner.cpp).
  - Emit JSON lines with `std::flush` for all phases and results.
  - Implement clean `SIGTERM`/`SIGINT` stream shutdown.
- [x] **Stage 2: Backend Services (`gui/app/`)**:
  - Create `gui/requirements.txt` (`fastapi`, `uvicorn`, `pydantic`).
  - Implement `hardware.py` (ALSA card detection & non-sudo `amixer` gain locking).
  - Implement `session_manager.py` (`asyncio.Lock` concurrency, `create_subprocess_exec`, NDJSON parser, active state tracking).
  - Implement `records_manager.py` (safe file reading, bilateral session grouping, metadata extraction).
  - Implement `main.py` (FastAPI app, REST routes, SSE endpoint, static file serving).
- [x] **Stage 3: Offline Frontend Client (`gui/static/`)**:
  - Vendor `gui/static/vendor/chart.umd.min.js`.
  - Write `gui/static/css/app.css` (modern, responsive, pure CSS with `@media print` rules).
  - Implement `store.js` (central state store + `/api/status` hydration).
  - Implement `app.js` (tab navigation, header audio status badge).
  - Implement `screening.js` (patient form, Guided Bilateral stepper, SSE listener, elapsed timer).
  - Implement `dpgram_chart.js` (Chart.js DP-Gram with frequency-relative SNR shading).
  - Implement `records.js` (history table, search filter, detail modal, JSON download).
  - Implement `settings.js` (profile selector, mock toggle, audio verification).
- [x] **Stage 4: End-to-End Verification**:
  - Test server startup via `./gui/run_gui.sh`.
  - Test complete Mock Mode screening via Web UI (Left Ear, Right Ear, and Guided Bilateral).
  - Verify tablet sleep/reload recovery (reconnects and resumes UI state seamlessly).
  - Verify `@media print` clinical report layout.
  - Verify offline hotspot execution (no external HTTP network calls).
- [x] **Stage 5: C++ Developer Telemetry & Tone-Test CLI (`dpoae-rpi`)**:
  - Add `--dev-telemetry` flag to compute and write decimated FFT magnitude spectra (500 Hz–6 kHz), peak/RMS dBFS, clipped sample counts, and ~500-point waveform envelopes to a sidecar JSON file.
  - Add `--tone-test` subcommand supporting Left/Right/Both channel routing, single-tone or $f_1/f_2$ playback, duplex recording, and peak frequency / latency measurement.
  - Enforce a hard maximum output amplitude ceiling in C++ for acoustic safety.
- [x] **Stage 6: Backend Developer Endpoints & `stderr` Streaming (`gui/app/`)**:
  - Update `session_manager.py` to support `--dev-telemetry`, CLI parameter overrides (`--snr-threshold`, `--tone-seconds`, `--min-pass-freqs`, `--amp-threshold`, `--art-threshold`), and async `stderr` reading (emitting `{"event": "stderr", "line": "..."}` and executed `argv` over SSE).
  - Add `POST /api/dev/tone-test` sharing the `asyncio.Lock` hardware mutex (`409 Conflict` when busy, `503` when USB audio disconnected) and auto-locking ALSA mixer.
  - Add `GET /api/dev/runs` (excluding `*-dev.json` from clinical `GET /api/records` list), path-validated `GET /api/dev/wav/{filename}` (`FileResponse`), and `GET /api/dev/spectrum/{filename}` endpoints in `main.py`.
- [x] **Stage 7: Frontend Developer / Lab Tab (`gui/static/js/dev.js`)**:
  - Add opt-in Developer Mode toggle in `settings.js` (plus `?dev=1` URL activation) gated by a confirmation prompt (*"I understand..."*) persisted in `localStorage` to show/hide **Tab 4: Developer / Lab**.
  - Build **FFT Spectrum Inspector** (auto-loads latest run + Recent Dev Runs selector, frequency pair 1–4 tabs, Chart.js plot with $f_1$, $f_2$, $2f_1 - f_2$, and noise-floor markers) and **Waveform & Clipping Panel** (Peak/RMS dBFS, clip count, min/max envelope, pair WAV `<audio controls>`).
  - Build **Manual Tone & Loopback Bench Test** form with channel/frequency/duration/amplitude controls and **WAV Audio Player**.
  - Add **Parameter Overrides** form with explicit **"Use Parameter Overrides"** checkbox and **"Dev Overrides Active"** warning pill on Tab 1, plus collapsible ephemeral **Live Telemetry & `stderr` Console**.
- [x] **Stage 8: Developer Mode Verification & Safety Testing**:
  - Verify Developer Mode remains completely hidden in default clinical mode.
  - Verify `POST /api/dev/tone-test` returns `409 Conflict` if a screening test is running, and confirm C++ clamps out-of-range amplitude values.
  - Verify FFT spectrum markers ($f_1$, $f_2$, $2f_1 - f_2$), waveform clipping metrics, and WAV playback work offline on a tablet/laptop browser.
  - Verify live `stderr` and raw NDJSON events stream cleanly in the console drawer without lagging the UI.