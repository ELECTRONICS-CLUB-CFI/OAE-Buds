"""End-to-end API tests for FastAPI backend endpoints, SSE streaming, concurrency, and security."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from gui.app.main import create_app


REPO_ROOT = Path(__file__).resolve().parents[2]
BINARY_PATH = REPO_ROOT / "build" / "dpoae-rpi"
CONFIG_PATH = REPO_ROOT / "config" / "oae_config.toml"


def test_status_and_hardware_verify_endpoints(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.write_text(" 1 [UGREEN]: USB-Audio - UGREEN USB Audio\n", encoding="utf-8")

    def fake_mixer(card_idx: int) -> dict:
        return {"ok": True, "card_index": card_idx, "actions": ["Mic locked 100%"], "warnings": [], "error": None}

    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=BINARY_PATH,
        config_path=CONFIG_PATH,
        results_dir=tmp_path / "results",
        cards_path=cards,
        mixer_locker=fake_mixer,
    )

    with TestClient(app) as client:
        resp = client.get("/api/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["server"] == "ok"
        assert body["audio_device"]["connected"] is True
        assert body["audio_device"]["card_index"] == 1
        assert body["active_session"]["state"] == "idle"
        assert body["config"]["snr_threshold_db"] == 7.0

        hw_resp = client.post("/api/hardware/verify")
        assert hw_resp.status_code == 200
        assert hw_resp.json()["mixer"]["ok"] is True


def test_mock_test_api_lifecycle_and_records_fetch(tmp_path: Path) -> None:
    results_dir = tmp_path / "results"
    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=BINARY_PATH,
        config_path=CONFIG_PATH,
        results_dir=results_dir,
        cards_path=tmp_path / "missing_cards",
    )

    with TestClient(app) as client:
        # Live mode without hardware returns 503
        live_fail = client.post("/api/test/start", json={"patient_id": "p1", "mock": False})
        assert live_fail.status_code == 503

        # Start mock test
        start_resp = client.post(
            "/api/test/start",
            json={
                "patient_id": "api_patient_1",
                "notes": "API integration check",
                "ear": "left",
                "workflow": "single",
                "mock": True,
                "fit_check": False,
                "vol_calib": False,
            },
        )
        assert start_resp.status_code == 200
        session_id = start_resp.json()["session_id"]

        # Poll status until completed (mock test finishes in < 1s)
        deadline = time.monotonic() + 10.0
        status_body = {}
        while time.monotonic() < deadline:
            status_body = client.get("/api/status").json()
            if status_body["active_session"]["state"] == "completed":
                break
            time.sleep(0.05)

        assert status_body["active_session"]["state"] == "completed"
        assert status_body["active_session"]["session_id"] == session_id
        assert status_body["active_session"]["left_result"]["verdict"] == "Pass"

        # List records and fetch raw JSON
        rec_list = client.get("/api/records?search=api_patient_1").json()
        assert rec_list["count"] == 1
        filename = rec_list["records"][0]["ears"]["left"]["filename"]

        rec_detail = client.get(f"/api/records/{filename}")
        assert rec_detail.status_code == 200
        assert rec_detail.json()["notes"] == "API integration check"

        # Path traversal / invalid file check
        bad_rec = client.get("/api/records/not_a_json.txt")
        assert bad_rec.status_code == 400

        # Reset back to idle
        reset_resp = client.post("/api/test/reset")
        assert reset_resp.status_code == 200
        assert client.get("/api/status").json()["active_session"]["state"] == "idle"


def test_api_conflict_409_and_stop(tmp_path: Path) -> None:
    slow_bin = tmp_path / "slow_api.py"
    slow_bin.write_text(
        f"#!{sys.executable}\n"
        "import signal, sys, time, json\n"
        "signal.signal(signal.SIGTERM, lambda s, f: sys.exit(130))\n"
        "print(json.dumps({'event': 'started', 'total_pairs': 4}), flush=True)\n"
        "while True:\n"
        "    time.sleep(0.05)\n",
        encoding="utf-8",
    )
    slow_bin.chmod(0o755)

    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=slow_bin,
        config_path=CONFIG_PATH,
        results_dir=tmp_path / "results",
        cards_path=tmp_path / "missing_cards",
    )

    with TestClient(app) as client:
        r1 = client.post("/api/test/start", json={"patient_id": "busy_p1", "mock": True})
        assert r1.status_code == 200

        r2 = client.post("/api/test/start", json={"patient_id": "busy_p2", "mock": True})
        assert r2.status_code == 409

        stop_resp = client.post("/api/test/stop")
        assert stop_resp.status_code == 200
        assert stop_resp.json()["status"] == "aborted"


def test_delete_records_api_and_active_session_conflict(tmp_path: Path) -> None:
    results_dir = tmp_path / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    (results_dir / "rec1-left-1000.json").write_text(
        json.dumps({"patient_id": "del_p1", "ear": "left", "verdict": "Pass", "timestamp_ms": 1000}),
        encoding="utf-8",
    )
    (results_dir / "rec1-left-1000-dev.json").write_text(
        json.dumps({"patient_id": "del_p1", "ear": "left", "pairs": []}),
        encoding="utf-8",
    )
    (results_dir / "rec1-left-1000-2016.wav").write_bytes(b"RIFF1")

    (results_dir / "rec2-right-2000.json").write_text(
        json.dumps({"patient_id": "del_p2", "ear": "right", "verdict": "Refer", "timestamp_ms": 2000}),
        encoding="utf-8",
    )
    (results_dir / "rec2-right-2000-dev.json").write_text(
        json.dumps({"patient_id": "del_p2", "ear": "right", "pairs": []}),
        encoding="utf-8",
    )
    (results_dir / "rec2-right-2000-2016.wav").write_bytes(b"RIFF2")

    slow_bin = tmp_path / "slow_del.py"
    slow_bin.write_text(
        f"#!{sys.executable}\n"
        "import signal, sys, time, json\n"
        "signal.signal(signal.SIGTERM, lambda s, f: sys.exit(130))\n"
        "print(json.dumps({'event': 'started', 'total_pairs': 4}), flush=True)\n"
        "while True:\n"
        "    time.sleep(0.05)\n",
        encoding="utf-8",
    )
    slow_bin.chmod(0o755)

    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=slow_bin,
        config_path=CONFIG_PATH,
        results_dir=results_dir,
        cards_path=tmp_path / "missing_cards",
    )

    with TestClient(app) as client:
        # While test is running, deleting must return 409 Conflict
        assert client.post("/api/test/start", json={"patient_id": "running", "mock": True}).status_code == 200
        c1 = client.post("/api/records/delete", json={"filenames": ["rec1-left-1000.json"], "delete_artifacts": True})
        assert c1.status_code == 409
        assert client.delete("/api/records/rec1-left-1000.json").status_code == 409
        assert client.post("/api/test/stop").status_code == 200

        # Delete rec1 with delete_artifacts=False -> keeps WAV and -dev.json
        d1 = client.post("/api/records/delete", json={"filenames": ["rec1-left-1000.json"], "delete_artifacts": False})
        assert d1.status_code == 200
        assert d1.json()["deleted_records"] == ["rec1-left-1000.json"]
        assert d1.json()["deleted_artifacts"] == []
        assert (results_dir / "rec1-left-1000-2016.wav").is_file()
        assert (results_dir / "rec1-left-1000-dev.json").is_file()

        # Delete rec2 via DELETE endpoint -> removes clinical JSON, -dev.json, and WAV
        d2 = client.delete("/api/records/rec2-right-2000.json")
        assert d2.status_code == 200
        assert d2.json()["deleted_records"] == ["rec2-right-2000.json"]
        assert not (results_dir / "rec2-right-2000.json").exists()
        assert not (results_dir / "rec2-right-2000-dev.json").exists()
        assert not (results_dir / "rec2-right-2000-2016.wav").exists()

        # Repeating delete returns 404; invalid name returns 400
        assert client.delete("/api/records/rec2-right-2000.json").status_code == 404
        assert client.delete("/api/records/bad-dev.json").status_code == 400


def test_sse_telemetry_stream_initial_sync_and_disconnect(tmp_path: Path) -> None:
    app = create_app(
        repo_root=REPO_ROOT,
        binary_path=BINARY_PATH,
        config_path=CONFIG_PATH,
        results_dir=tmp_path / "results",
        cards_path=tmp_path / "missing_cards",
    )

    async def read_first_sse_event() -> tuple[int, dict[str, str], dict]:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/telemetry/stream",
            "raw_path": b"/api/telemetry/stream",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
        }

        disconnected = asyncio.Event()
        status_code = 0
        resp_headers: dict[str, str] = {}
        first_payload: dict = {}

        async def receive():
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            nonlocal status_code, resp_headers, first_payload
            if message["type"] == "http.response.start":
                status_code = message["status"]
                resp_headers = {
                    k.decode("latin-1").lower(): v.decode("latin-1")
                    for k, v in message.get("headers", [])
                }
            elif message["type"] == "http.response.body":
                chunk = message.get("body", b"").decode("utf-8")
                for line in chunk.splitlines():
                    if line.startswith("data: ") and not first_payload:
                        first_payload = json.loads(line.removeprefix("data: "))
                        disconnected.set()

        await asyncio.wait_for(app(scope, receive, send), timeout=3.0)
        return status_code, resp_headers, first_payload

    status, headers, payload = asyncio.run(read_first_sse_event())
    assert status == 200
    assert "text/event-stream" in headers.get("content-type", "")
    assert payload["event"] == "sync"
    assert payload["active_session"]["state"] == "idle"
