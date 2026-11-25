"""Stage 4 End-to-End Verification against live ./gui/run_gui.sh server over real HTTP + SSE."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Iterator

import httpx


REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_GUI_SCRIPT = REPO_ROOT / "gui" / "run_gui.sh"
BINARY_PATH = REPO_ROOT / "build" / "dpoae-rpi"


def _get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_server(base_url: str, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{base_url}/api/status", timeout=1.0)
            if r.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"GUI server at {base_url} did not become ready within {timeout}s")


def _collect_sse_until(client: httpx.Client, base_url: str, stop_events: set[str], timeout: float = 15.0) -> list[dict]:
    collected: list[dict] = []
    deadline = time.monotonic() + timeout
    with client.stream("GET", f"{base_url}/api/telemetry/stream", timeout=timeout) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if time.monotonic() > deadline:
                raise TimeoutError(f"Timed out waiting for SSE events {stop_events}; got {[e.get('event') for e in collected]}")
            if not line.startswith("data: "):
                continue
            payload = json.loads(line.removeprefix("data: "))
            collected.append(payload)
            if payload.get("event") == "sync":
                sync_state = (payload.get("active_session") or {}).get("state")
                if sync_state in stop_events:
                    break
            if payload.get("event") in stop_events:
                break
    return collected


@contextmanager
def _running_gui_server(results_dir: Path) -> Iterator[str]:
    port = _get_free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
    env["OAE_GUI_HOST"] = "127.0.0.1"
    env["OAE_GUI_PORT"] = str(port)
    env["OAE_RESULTS_DIR"] = str(results_dir)

    proc = subprocess.Popen(
        ["bash", str(RUN_GUI_SCRIPT)],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        _wait_for_server(base_url)
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def test_e2e_run_gui_script_mock_workflows_and_reload_recovery(tmp_path: Path) -> None:
    with _running_gui_server(tmp_path / "results") as base_url:
        with httpx.Client(timeout=10.0) as client:
            # 1. Verify offline index + static assets + @media print rules over live TCP HTTP
            idx = client.get(f"{base_url}/")
            assert idx.status_code == 200
            assert "OAE Buds" in idx.text
            assert "print-only" in idx.text
            assert "no-print" in idx.text

            css_resp = client.get(f"{base_url}/static/css/app.css")
            assert css_resp.status_code == 200
            assert "@media print" in css_resp.text

            for asset in re.findall(r'(?:src|href)="(/static/[^"]+)"', idx.text):
                ar = client.get(f"{base_url}{asset}")
                assert ar.status_code == 200

            # 2. Single-ear Left Mock Screening with live SSE stream
            r_left = client.post(
                f"{base_url}/api/test/start",
                json={
                    "patient_id": "e2e_left_p1",
                    "ear": "left",
                    "workflow": "single",
                    "mock": True,
                    "fit_check": False,
                    "vol_calib": False,
                },
            )
            assert r_left.status_code == 200
            _collect_sse_until(client, base_url, {"completed", "error", "aborted"})
            left_status = client.get(f"{base_url}/api/status").json()["active_session"]
            assert left_status["state"] == "completed"
            assert left_status["left_result"]["verdict"] == "Pass"
            assert client.post(f"{base_url}/api/test/reset").status_code == 200

            # 3. Single-ear Right Mock Screening
            r_right = client.post(
                f"{base_url}/api/test/start",
                json={
                    "patient_id": "e2e_right_p2",
                    "ear": "right",
                    "workflow": "single",
                    "mock": True,
                    "fit_check": False,
                    "vol_calib": False,
                },
            )
            assert r_right.status_code == 200
            _collect_sse_until(client, base_url, {"completed", "error", "aborted"})
            right_status = client.get(f"{base_url}/api/status").json()["active_session"]
            assert right_status["state"] == "completed"
            assert right_status["right_result"]["ear"] == "right"
            assert client.post(f"{base_url}/api/test/reset").status_code == 200

            # 4. Guided Bilateral Workflow + Tablet Sleep / Reload Recovery
            r_bilat_1 = client.post(
                f"{base_url}/api/test/start",
                json={
                    "patient_id": "e2e_bilat_p3",
                    "notes": "E2E bilateral recovery test",
                    "ear": "left",
                    "workflow": "bilateral",
                    "mock": True,
                    "fit_check": True,
                    "vol_calib": True,
                },
            )
            assert r_bilat_1.status_code == 200
            bilat_session_id = r_bilat_1.json()["session_id"]

            _collect_sse_until(client, base_url, {"waiting_for_next_ear", "error", "aborted"})

            # Simulate tablet sleep/refresh: close SSE, call /api/status and reconnect fresh SSE
            hydrated = client.get(f"{base_url}/api/status").json()
            assert hydrated["active_session"]["state"] == "waiting_for_next_ear"
            assert hydrated["active_session"]["session_id"] == bilat_session_id
            assert hydrated["active_session"]["current_ear"] == "right"
            assert hydrated["active_session"]["left_result"]["verdict"] == "Pass"

            reconnect_events = _collect_sse_until(client, base_url, {"sync"})
            assert reconnect_events[0]["event"] == "sync"
            assert reconnect_events[0]["active_session"]["state"] == "waiting_for_next_ear"

            # Continue with Right ear under same session_id
            r_bilat_2 = client.post(
                f"{base_url}/api/test/start",
                json={
                    "session_id": bilat_session_id,
                    "patient_id": "e2e_bilat_p3",
                    "notes": "E2E bilateral recovery test",
                    "ear": "right",
                    "workflow": "bilateral",
                    "mock": True,
                    "fit_check": True,
                    "vol_calib": True,
                },
            )
            assert r_bilat_2.status_code == 200
            _collect_sse_until(client, base_url, {"completed", "error", "aborted"})

            final_status = client.get(f"{base_url}/api/status").json()["active_session"]
            assert final_status["state"] == "completed"
            assert final_status["left_result"] is not None
            assert final_status["right_result"] is not None

            # 5. Verify Past Records groups the bilateral test properly
            recs = client.get(f"{base_url}/api/records?search=e2e_bilat_p3").json()
            assert recs["count"] == 1
            rec = recs["records"][0]
            assert rec["is_bilateral"] is True
            assert rec["overall_verdict"] == "Pass"
            assert rec["notes"] == "E2E bilateral recovery test"
            assert "left" in rec["ears"] and "right" in rec["ears"]


def test_e2e_dev_mode_telemetry_spectrum_wav_and_safety(tmp_path: Path) -> None:
    results_dir = tmp_path / "results"
    with _running_gui_server(results_dir) as base_url:
        with httpx.Client(timeout=15.0) as client:
            # 1. Verify Developer Tab is hidden by default in served HTML & dev.js loads offline
            html = client.get(f"{base_url}/").text
            assert 'id="tab-btn-dev" class="tab-btn hidden"' in html
            assert 'id="panel-dev" class="tab-panel hidden' in html
            dev_js = client.get(f"{base_url}/static/js/dev.js")
            assert dev_js.status_code == 200
            assert not re.search(r"https?://", dev_js.text, re.IGNORECASE)

            # 2. Run screening with --dev-telemetry and overrides; check 409 lock during run
            start_resp = client.post(
                f"{base_url}/api/test/start",
                json={
                    "patient_id": "e2e_dev_p1",
                    "ear": "left",
                    "workflow": "single",
                    "mock": True,
                    "fit_check": False,
                    "vol_calib": False,
                    "dev_telemetry": True,
                    "overrides": {
                        "snr_threshold_db": 6.0,
                        "constant_tone_seconds": 3,
                    },
                },
            )
            assert start_resp.status_code == 200

            # Immediately probe /api/dev/tone-test while active (either 409 conflict if still running,
            # or 503 if mock finished before request; both confirm safety gating)
            probe = client.post(f"{base_url}/api/dev/tone-test", json={"channel": "left", "freq_hz": 1000})
            assert probe.status_code in (409, 503)

            _collect_sse_until(client, base_url, {"completed", "error", "aborted"})
            status_sess = client.get(f"{base_url}/api/status").json()["active_session"]
            assert status_sess["state"] == "completed"
            dev_file = status_sess["dev_file"]
            assert dev_file and dev_file.endswith("-dev.json")

            # 3. Verify clinical records exclude -dev.json while /api/dev/runs lists it
            clinical = client.get(f"{base_url}/api/records?search=e2e_dev_p1").json()
            assert clinical["count"] == 1
            runs = client.get(f"{base_url}/api/dev/runs").json()
            assert runs["count"] == 1
            assert runs["runs"][0]["filename"] == dev_file

            # 4. Verify spectrum markers, waveform envelope, and WAV streaming
            spec = client.get(f"{base_url}/api/dev/spectrum/{dev_file}").json()
            pair0 = spec["pairs"][0]
            assert pair0["f1"] == 1640
            assert pair0["f2"] == 2016
            assert pair0["oae_bin"] == 1264
            assert pair0["imd_bin"] == 2392
            assert len(pair0["spectrum"]["freqs_hz"]) == 512
            assert len(pair0["waveform"]["min"]) == 500
            assert "clipped_samples" in pair0

            wav_name = Path(pair0["wav_file"]).name
            wav_resp = client.get(f"{base_url}/api/dev/wav/{wav_name}")
            assert wav_resp.status_code == 200
            assert wav_resp.headers["content-type"].startswith("audio/wav")
            assert wav_resp.content[:4] == b"RIFF"

    # 5. Verify C++ hard amplitude safety clamp directly via --tone-test --amp 0.99
    proc = subprocess.run(
        [
            str(BINARY_PATH),
            "--config", str(REPO_ROOT / "config" / "oae_config.toml"),
            "--mock",
            "--tone-test",
            "--channel", "left",
            "--freq", "1000",
            "--duration", "0.5",
            "--amp", "0.99",
            "--out-dir", str(tmp_path / "tone_out"),
            "--json-stream",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    tone_ev = json.loads(proc.stdout.strip().splitlines()[-1])
    assert tone_ev["event"] == "tone_test_result"
    assert tone_ev["amplitude_requested"] == 0.99
    assert tone_ev["amplitude_applied"] == 0.60
    assert Path(tone_ev["wav_file"]).is_file()
