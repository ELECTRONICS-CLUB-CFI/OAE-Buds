# OAE Buds — Native C++ DPOAE Screening System for Raspberry Pi 5

Headless, high-performance C++20 port of the **OAE Buds** Distortion-Product Otoacoustic Emission (DPOAE) hearing screening software, designed for native execution on Raspberry Pi 5 with the **UGREEN 80864** USB audio interface, **Sony MDR-EX14AP** dynamic drivers, and **PUI Audio POM-2730L-HD-R** electret condenser microphone.

---

## 1. Hardware Architecture & Pinout

```
+-------------------------------------------------------------------------+
|                           Raspberry Pi 5                                |
|  - OS: Raspberry Pi OS Trixie Lite (64-bit)                            |
|  - Audio: UGREEN 80864 2-in-1 USB Audio Card (USB to 3.5mm TRRS)       |
+------------------------------------+------------------------------------+
                                     | USB 2.0 (Duplex 48 kHz / 16-bit)
                                     v
                  +--------------------------------------+
                  |   UGREEN 80864 (CTIA 3.5mm TRRS)     |
                  |  - Tip:      Left Playback   (f1)    |
                  |  - Ring 1:   Right Playback  (f2)    |
                  |  - Ring 2:   Ground                  |
                  |  - Sleeve:   Mic Input + Bias (2.5V) |
                  +------------------+-------------------+
                                     | Single 3.5mm TRRS
                                     v
                  +--------------------------------------+
                  |         Custom Probe Enclosure       |
                  |  - Driver 1 (L): Sony MDR-EX14AP (f1)|
                  |  - Driver 2 (R): Sony MDR-EX14AP (f2)|
                  |  - Mic: PUI Audio POM-2730L-HD-R     |
                  |  - Independent internal acoustic     |
                  |    sound tubes to probe tip          |
                  +--------------------------------------+
```

### Key Hardware Requirements:
1. **Acoustic Sound Tubes**: Driver 1 ($f_1$) and Driver 2 ($f_2$) **must not** mix in the earphone body. Independent sound tubes must guide the sound to the probe tip in the ear canal so that non-linear mixing occurs solely inside the cochlea.
2. **ALSA Mixer Locking**: Hardware Automatic Gain Control (AGC) must be disabled, and capture/playback gains locked to avoid dynamic distortion.

---

## 2. Quick Start on Raspberry Pi 5

### Step 1: Install Dependencies
On Raspberry Pi OS Trixie Lite, run the setup script:
```bash
cd dpoae-rpi
bash scripts/setup_rpi.sh
```
This installs `build-essential`, `g++` (GCC 14), `cmake`, `libasound2-dev` (ALSA), `libfftw3-dev`, `alsa-utils`, and Python utilities (`numpy`, `scipy`).

### Step 2: Lock ALSA Mixer Volumes
Run the mixer locking script to disable AGC, lock playback to 100%, and capture to 80%:
```bash
sudo bash scripts/lock_ugreen_80864.sh
```

### Step 3: Build
```bash
cmake -B build -S .
cmake --build build -j$(nproc)
```

### Step 4: Run Unit Tests
```bash
cd build
ctest --output-on-failure
```
All 5 test suites will run offline with 100% pass rate:
- `test_config_toml`: TOML profile loading and validation
- `test_signal_gen`: Chirp, sine, dual-tone stereo phase alignment
- `test_dsp_engine`: Bluestein FFT, SNR, artifact rejection with `ampCheck` bug fix
- `test_calibrator`: In-ear volume calibration and fit check
- `test_session_mock`: Multi-frequency session state machine, JSON & WAV writing

---

## 3. CLI Usage

The executable `dpoae-rpi` is a one-shot CLI tool that runs a complete screening session and exits with standard UNIX status codes (`0` for Pass, `2` for Refer, `1` for Error).

```bash
./build/dpoae-rpi [options]
```

### Command-Line Options:
| Flag | Description | Default |
|---|---|---|
| `--config <path>` | Path to TOML configuration | `config/oae_config.toml` |
| `--profile <name>`| Target hardware profile | `ugreen_80864_rpi5` |
| `--patient <id>`  | Patient/Subject identifier | `0` |
| `--ear <left\|right>` | Ear under test | `left` |
| `--out-dir <path>`| Directory for JSON and WAV outputs | `./results` |
| `--fit-check`     | Force 226 Hz probe seal check before test | Disabled by default |
| `--no-fit-check`  | Skip probe seal check | Default |
| `--vol-calib`     | Run in-ear volume calibration pulses | Disabled by default |
| `--no-vol-calib`  | Skip volume calibration | Default |
| `--mock`          | Offline simulation with synthetic OAE data | Disabled |
| `--quiet`         | Suppress verbose stdout logging | Verbose by default |
| `--help, -h`      | Show help message | |

### Example Run (Live Test on RPi5):
```bash
./build/dpoae-rpi --patient "subject_101" --ear "left" --out-dir "/var/log/oae_records"
```

### Example Run (Offline Dry-Run / CI):
```bash
./build/dpoae-rpi --mock --patient "test_user" --ear "right" --out-dir "./test_results"
```

---

## 4. Output Data Structure

For every test session, the tool generates:
1. **Uncompressed 16-bit Mono WAV Files**: Raw recordings for each measured frequency pair (e.g. `subject_101-left-1795338426-2016.wav`).
2. **Clinical JSON Summary** (e.g. `subject_101-left-1795338426.json`):
```json
{
  "patient_id": "subject_101",
  "ear": "left",
  "timestamp": "2026-11-22 14:37:06",
  "timestamp_ms": 1795338426635,
  "profile": "ugreen_80864_rpi5",
  "verdict": "Pass",
  "passed_count": 4,
  "total_active_frequencies": 4,
  "noise_check": "noise-pass",
  "fit_check_passed": true,
  "vol_calib_passed": true,
  "total_duration_seconds": 20.45,
  "frequencies": [
    {
      "f2": 2016,
      "f1": 1640,
      "oae_bin": 1264,
      "imd_bin": 2392,
      "signal_db": 18.2,
      "noise_db": 4.1,
      "snr_db": 14.1,
      "ambient_noise_db": -12.4,
      "segments_used": 4,
      "segments_rejected": 0,
      "pass": true
    }
  ]
}
```

---

## 5. Reference Sound Level Meter Calibration Procedure

To achieve clinical accuracy (65 dB SPL for $f_1$, 55 dB SPL for $f_2$ in the ear canal):

1. **Physical Setup**:
   - Insert probe into a calibrated 2cc acoustic ear coupler (e.g., IEC 60318-4 / GRAS 43AE).
   - Couple a calibrated Type 1 / Type 2 Sound Pressure Level (SPL) meter.
2. **Sweep Stimuli**:
   ```bash
   python3 scripts/calibration_sweep.py
   ```
   Plays 8 pure tones across 5 gain levels ($[0.03, 0.08, 0.15, 0.30, 0.60]$). Prompt asks for the SPL meter reading (in dB SPL) for each tone and writes `calibration_data.csv`.
3. **Compute Regression**:
   ```bash
   python3 scripts/fit_calibration.py calibration_data.csv
   ```
   Calculates the linear regression coefficients ($p_1, p_2$) and exponential coefficients ($a, b$) per frequency.
4. **Update Configuration**:
   Paste the generated calibration block into `config/oae_config.toml` under `[profiles.ugreen_80864_rpi5.calibration]`.

---

## 6. Passive Coupler Artifact Verification (Crosstalk Check)

Before conducting human trials:
1. Insert probe into a solid, passive earplug coupler (syringe with blu-tack or passive brass cavity).
2. Run full screening test:
   ```bash
   ./build/dpoae-rpi --patient "coupler_verification" --ear "left"
   ```
3. Inspect `signal_db` at $2f_1 - f_2$:
   - **Requirement**: Signal power at $2f_1 - f_2$ must be $< -15\text{ dB SPL}$ (or SNR $< 3\text{ dB}$).
   - If a peak $> -10\text{ dB SPL}$ appears, acoustic or electrical intermodulation is occurring. Separate driver wiring, ensure ground isolation, and verify that acoustic tubes remain physically isolated until the probe tip.

---

## 7. Configuration Reference (`config/oae_config.toml`)

- `[audio]`: 48 kHz, 16-bit PCM, 48000 process window, 48000 init trim (1 second).
- `[test]`: Clinical SNR threshold (7.0 dB), SPL threshold (-50.0 dB), duration (5 s), pass rule (minimum 3 of 4 active frequencies).
- `[artifact]`: Enabled by default; amplitude threshold (500), artifact threshold (4.0 dB).
- `[fit_check]`: Optional probe seal check (226 Hz tone, seal check threshold 200, occlusion threshold 500).
- `[vol_calib]`: Optional in-ear volume chirp latency recovery and pulse sweep.
- `[profiles]`: All original Android phone profiles (`sch`, `sch2`, `sch3`, `pixel_calib`, `doogee_calib`) preserved alongside the target `ugreen_80864_rpi5` profile.
