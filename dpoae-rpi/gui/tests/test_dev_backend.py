"""Stage 6 tests for Developer Mode backend endpoints, --dev-telemetry, overrides, stderr SSE, and tone-test."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from gui.app.main import create_app
from gui.app.records_manager import RecordsManager
from gui.app.session_manager import SessionManager


REPO_ROOT = Path(__file__).resolve().parents[2]
BINARY_PATH = REPO_ROOT / "build" / "dpoae-rpi"
CONFIG_PATH = REPO_ROOT / "config" / "oae_config.toml"


def test_dev_telemetry_overrides_runs_spectrum_and_wav_endpoints(tmp_path: Path) -> None:
    results_dir = tmp_path / "results"

    async def scenario() -> tuple[str, str]:
        mgr = SessionManager(BINARY_PATH, CONFIG_PATH, results_dir)
        events: list[dict] = []

        async with mgr.subscribe() as queue:
            await mgr.start_test(
                patient_id="dev_p1",
                ear="left",
                workflow="single",
                mock=True,
                fit_check=False,
                vol_calib=False,
                dev_telemetry=True,
                overrides={
                    "snr_threshold_db": 6.5,
                    "constant_tone_seconds": 3,
                    "pass_rule_min_frequencies": 3,
                    "amp_threshold": 450,
                    "art_threshold_db": 3.5,
                },
            )
            await mgr.wait_for_idle_or_finish(timeout=15.0)
            while not queue.empty():
                events.append(queue.get_nowait())

        cmd_events = [e for e in events if e.get("event") == "cmd"]
        assert len(cmd_events) == 1
        argv = cmd_events[0]["argv"]
        assert "--dev-telemetry" in argv
        assert "--snr-threshold" in argv and "6.5" in argv
        assert "--tone-seconds" in argv and "3" in argv
        assert "--min-pass-freqs" in argv and "3" in argv
        assert "--amp-threshold" in argv and "450" in argv
        assert "--art-threshold" in argv and "3.5" in argv

        dev_events = [e for e in events if e.get("event") == "dev_telemetry"]
        assert len(dev_events) == 4
        assert "peak_dbfs" in dev_events[0]
        assert "clipped_samples" in dev_events[0]

        completed = next(e for e in events if e.get("event") == "completed")
        dev_filename = completed["dev_filename"]
        wav_files = list(results_dir.glob("*.wav"))
        assert len(wav_files) == 4
        return dev_filename, wav_files[0].name

    dev_filename, wav_name = asyncio.run(scenario())

    # Verify clinical list excludes *-dev.json while dev endpoints serve spectrum and WAV
    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=BINARY_PATH,
        config_path=CONFIG_PATH,
        results_dir=results_dir,
        cards_path=tmp_path / "missing_cards",
    )

    with TestClient(app) as client:
        clinical_recs = client.get("/api/records").json()
        assert clinical_recs["count"] == 1
        assert not clinical_recs["records"][0]["ears"]["left"]["filename"].endswith("-dev.json")

        runs = client.get("/api/dev/runs").json()
        assert runs["count"] == 1
        assert runs["runs"][0]["filename"] == dev_filename
        assert runs["runs"][0]["pair_count"] == 4

        spec = client.get(f"/api/dev/spectrum/{dev_filename}")
        assert spec.status_code == 200
        spec_json = spec.json()
        assert len(spec_json["pairs"]) == 4
        assert len(spec_json["pairs"][0]["spectrum"]["freqs_hz"]) == 512
        assert len(spec_json["pairs"][0]["waveform"]["min"]) == 500

        wav_resp = client.get(f"/api/dev/wav/{wav_name}")
        assert wav_resp.status_code == 200
        assert wav_resp.headers["content-type"].startswith("audio/wav")
        assert wav_resp.content[:4] == b"RIFF"

        # Path traversal & validation checks
        assert client.get("/api/dev/wav/not_a_wav.txt").status_code == 400
        assert client.get("/api/dev/wav/missing.wav").status_code == 404
        assert client.get("/api/dev/spectrum/regular.json").status_code == 400
        assert client.get("/api/dev/spectrum/missing-dev.json").status_code == 404


def test_stderr_streaming_over_sse(tmp_path: Path) -> None:
    stub_bin = tmp_path / "stderr_stub.py"
    stub_bin.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "print('ALSA debug line 1', file=sys.stderr, flush=True)\n"
        "print('ALSA debug line 2', file=sys.stderr, flush=True)\n"
        "print(json.dumps({'event': 'started', 'total_pairs': 4}), flush=True)\n"
        "print(json.dumps({'event': 'completed', 'verdict': 'Pass', 'passed_count': 4, 'total_active_frequencies': 4}), flush=True)\n",
        encoding="utf-8",
    )
    stub_bin.chmod(0o755)

    async def scenario() -> None:
        mgr = SessionManager(stub_bin, CONFIG_PATH, tmp_path)
        events: list[dict] = []
        async with mgr.subscribe() as queue:
            await mgr.start_test(patient_id="err_p1", mock=True, dev_telemetry=True)
            await mgr.wait_for_idle_or_finish(timeout=5.0)
            while not queue.empty():
                events.append(queue.get_nowait())

        batched_lines: list[str] = []
        for e in events:
            if e.get("event") == "stderr_batch":
                batched_lines.extend(e.get("lines", []))
            elif e.get("event") == "stderr":
                batched_lines.append(e.get("line", ""))
        assert any(e.get("event") == "stderr_batch" for e in events)
        assert "ALSA debug line 1" in batched_lines
        assert "ALSA debug line 2" in batched_lines

    asyncio.run(scenario())


def test_tone_test_endpoint_hardware_check_and_409_conflict(tmp_path: Path) -> None:
    results_dir = tmp_path / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    missing_cards = tmp_path / "no_cards"
    missing_cards.write_text(" 0 [vc4hdmi0]: vc4-hdmi\n", encoding="utf-8")

    # 1. Missing USB audio returns 503
    app_no_hw = create_app(
        repo_root=REPO_ROOT,
        binary_path=BINARY_PATH,
        config_path=CONFIG_PATH,
        results_dir=results_dir,
        cards_path=missing_cards,
    )
    with TestClient(app_no_hw) as client:
        r503 = client.post("/api/dev/tone-test", json={"channel": "left", "freq_hz": 1000})
        assert r503.status_code == 503

    # 2. Live USB audio present -> locks mixer & executes tone-test; 409 if screening active
    valid_cards = tmp_path / "cards"
    valid_cards.write_text(" 2 [Device]: USB-Audio - UGREEN USB Audio\n", encoding="utf-8")
    mixer_calls: list[int] = []

    def fake_mixer(card_idx: int) -> dict:
        mixer_calls.append(card_idx)
        return {"ok": True, "card_index": card_idx, "actions": ["locked"], "warnings": [], "error": None}

    stub_bin = tmp_path / "tone_stub.py"
    stub_bin.write_text(
        f"#!{sys.executable}\n"
        "import json, signal, sys, time\n"
        "from pathlib import Path\n"
        "signal.signal(signal.SIGTERM, lambda s, f: sys.exit(130))\n"
        "if '--tone-test' in sys.argv:\n"
        f"    wav = Path({str(results_dir)!r}) / 'tone-test-123.wav'\n"
        "    wav.write_bytes(b'RIFF' + b'\\x00' * 40)\n"
        "    print(json.dumps({'event': 'tone_test_result', 'channel': 'left', 'target_hz': 1000.0, 'measured_peak_hz': 1000.0, 'rms_dbfs': -18.0, 'peak_dbfs': -12.0, 'clipped_samples': 0, 'latency_ms': 10.0, 'wav_file': str(wav)}), flush=True)\n"
        "else:\n"
        "    print(json.dumps({'event': 'started', 'total_pairs': 4}), flush=True)\n"
        "    while True:\n"
        "        time.sleep(0.05)\n",
        encoding="utf-8",
    )
    stub_bin.chmod(0o755)

    app_hw = create_app(
        repo_root=REPO_ROOT,
        binary_path=stub_bin,
        config_path=CONFIG_PATH,
        results_dir=results_dir,
        cards_path=valid_cards,
        mixer_locker=fake_mixer,
    )

    with TestClient(app_hw) as client:
        ok_resp = client.post(
            "/api/dev/tone-test",
            json={"channel": "left", "freq_hz": 1000, "duration_s": 1.0, "amplitude": 0.25},
        )
        assert ok_resp.status_code == 200
        body = ok_resp.json()
        assert body["wav_filename"] == "tone-test-123.wav"
        assert mixer_calls == [2]

        # Start slow screening -> tone test must return 409 Conflict
        assert client.post("/api/test/start", json={"patient_id": "busy", "mock": True}).status_code == 200
        conflict_resp = client.post("/api/dev/tone-test", json={"channel": "left", "freq_hz": 1000})
        assert conflict_resp.status_code == 409
        assert client.post("/api/test/stop").status_code == 200
