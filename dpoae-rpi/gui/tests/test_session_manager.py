"""Tests for SessionManager subprocess supervision, NDJSON streaming, concurrency lock, and bilateral workflow."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from gui.app.records_manager import RecordsManager
from gui.app.session_manager import (
    AudioDeviceNotFoundError,
    SessionConflictError,
    SessionManager,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
BINARY_PATH = REPO_ROOT / "build" / "dpoae-rpi"
CONFIG_PATH = REPO_ROOT / "config" / "oae_config.toml"


def test_single_ear_mock_session_lifecycle(tmp_path: Path) -> None:
    async def scenario() -> None:
        mgr = SessionManager(BINARY_PATH, CONFIG_PATH, tmp_path)
        events: list[dict] = []

        async with mgr.subscribe() as queue:
            res = await mgr.start_test(
                patient_id="gui_test_01",
                ear="left",
                workflow="single",
                mock=True,
                fit_check=True,
                vol_calib=True,
                notes="Single ear mock test",
            )
            assert res["status"] == "started"
            session_id = res["session_id"]

            await mgr.wait_for_idle_or_finish(timeout=15.0)
            while not queue.empty():
                events.append(queue.get_nowait())

        event_names = [e["event"] for e in events]
        assert "started" in event_names
        assert "phase_changed" in event_names
        assert "fit_check_result" in event_names
        assert "vol_calib_result" in event_names
        assert "frequency_measuring" in event_names
        assert "artifact_status" in event_names
        assert "frequency_result" in event_names
        assert "completed" in event_names

        snap = mgr.get_status_snapshot()
        assert snap["state"] == "completed"
        assert snap["session_id"] == session_id
        assert snap["left_result"] is not None
        assert snap["left_result"]["verdict"] == "Pass"
        assert len(snap["frequencies_done"]) == 4

        # Verify persisted JSON on disk includes session_id & notes
        records = RecordsManager(tmp_path).list_records()
        assert len(records) == 1
        assert records[0]["session_id"] == session_id
        assert records[0]["notes"] == "Single ear mock test"

    asyncio.run(scenario())


def test_guided_bilateral_workflow(tmp_path: Path) -> None:
    async def scenario() -> None:
        mgr = SessionManager(BINARY_PATH, CONFIG_PATH, tmp_path)
        events: list[dict] = []

        async with mgr.subscribe() as queue:
            res1 = await mgr.start_test(
                patient_id="bilat_01",
                ear="left",
                workflow="bilateral",
                mock=True,
                fit_check=False,
                vol_calib=False,
                notes="Bilateral screening",
            )
            session_id = res1["session_id"]
            await mgr.wait_for_idle_or_finish(timeout=15.0)

            snap_mid = mgr.get_status_snapshot()
            assert snap_mid["state"] == "waiting_for_next_ear"
            assert snap_mid["current_ear"] == "right"
            assert snap_mid["left_result"] is not None
            assert snap_mid["right_result"] is None

            # Continue with Right ear under same session_id
            res2 = await mgr.start_test(
                patient_id="bilat_01",
                ear="right",
                workflow="bilateral",
                mock=True,
                fit_check=False,
                vol_calib=False,
                notes="Bilateral screening",
                session_id=session_id,
            )
            assert res2["session_id"] == session_id
            await mgr.wait_for_idle_or_finish(timeout=15.0)

            while not queue.empty():
                events.append(queue.get_nowait())

        assert any(e["event"] == "waiting_for_next_ear" for e in events)

        snap_end = mgr.get_status_snapshot()
        assert snap_end["state"] == "completed"
        assert snap_end["left_result"] is not None
        assert snap_end["right_result"] is not None

        records = RecordsManager(tmp_path).list_records()
        assert len(records) == 1
        assert records[0]["is_bilateral"] is True
        assert records[0]["overall_verdict"] == "Pass"

    asyncio.run(scenario())


def test_single_ear_then_test_other_ear_preserves_first_ear(tmp_path: Path) -> None:
    async def scenario() -> None:
        mgr = SessionManager(BINARY_PATH, CONFIG_PATH, tmp_path)
        res1 = await mgr.start_test(
            patient_id="other_ear_01",
            ear="left",
            workflow="single",
            mock=True,
            fit_check=False,
            vol_calib=False,
        )
        session_id = res1["session_id"]
        await mgr.wait_for_idle_or_finish(timeout=15.0)
        assert mgr.get_status_snapshot()["state"] == "completed"

        await mgr.start_test(
            patient_id="other_ear_01",
            ear="right",
            workflow="bilateral",
            mock=True,
            fit_check=False,
            vol_calib=False,
            session_id=session_id,
        )
        await mgr.wait_for_idle_or_finish(timeout=15.0)
        snap = mgr.get_status_snapshot()
        assert snap["state"] == "completed"
        assert snap["left_result"] is not None
        assert snap["right_result"] is not None

    asyncio.run(scenario())


def test_concurrency_lock_and_sigterm_abort(tmp_path: Path) -> None:
    # Create a tiny slow executable script simulating a running engine
    slow_bin = tmp_path / "slow_dpoae.py"
    slow_bin.write_text(
        f"#!{sys.executable}\n"
        "import signal, sys, time, json\n"
        "def on_term(s, f):\n"
        "    print(json.dumps({'event': 'aborted', 'reason': 'SIGTERM received'}), flush=True)\n"
        "    sys.exit(130)\n"
        "signal.signal(signal.SIGTERM, on_term)\n"
        "print(json.dumps({'event': 'started', 'total_pairs': 4}), flush=True)\n"
        "while True:\n"
        "    time.sleep(0.05)\n",
        encoding="utf-8",
    )
    slow_bin.chmod(0o755)

    async def scenario() -> None:
        mgr = SessionManager(slow_bin, CONFIG_PATH, tmp_path)
        await mgr.start_test(patient_id="slow_p1", mock=True)

        # Concurrency check: second start must fail with SessionConflictError
        with pytest.raises(SessionConflictError):
            await mgr.start_test(patient_id="slow_p2", mock=True)

        # Graceful SIGTERM stop
        stop_res = await mgr.stop_test()
        assert stop_res["status"] == "aborted"
        assert mgr.get_status_snapshot()["state"] == "aborted"

    asyncio.run(scenario())


def test_live_mode_requires_usb_audio_and_locks_mixer(tmp_path: Path) -> None:
    missing_cards = tmp_path / "no_cards"
    missing_cards.write_text(" 0 [vc4hdmi0]: vc4-hdmi\n", encoding="utf-8")

    valid_cards = tmp_path / "cards"
    valid_cards.write_text(" 3 [Device]: USB-Audio - UGREEN Audio\n", encoding="utf-8")

    mixer_calls: list[int] = []

    def fake_mixer(card_idx: int) -> dict:
        mixer_calls.append(card_idx)
        return {"ok": True, "card_index": card_idx, "actions": ["locked"], "warnings": [], "error": None}

    async def scenario() -> None:
        mgr_no_hw = SessionManager(BINARY_PATH, CONFIG_PATH, tmp_path, cards_path=missing_cards)
        with pytest.raises(AudioDeviceNotFoundError):
            await mgr_no_hw.start_test(patient_id="live_01", mock=False)

        # With valid card present, mixer locker is invoked automatically before launch
        # Use a fast dummy binary so we don't try to open real ALSA in CI sandbox
        dummy_bin = tmp_path / "dummy_live.py"
        dummy_bin.write_text(
            f"#!{sys.executable}\n"
            "import json\n"
            "print(json.dumps({'event': 'completed', 'verdict': 'Pass', 'passed_count': 4, 'total_active_frequencies': 4}), flush=True)\n",
            encoding="utf-8",
        )
        dummy_bin.chmod(0o755)

        mgr_hw = SessionManager(
            dummy_bin,
            CONFIG_PATH,
            tmp_path,
            cards_path=valid_cards,
            mixer_locker=fake_mixer,
        )
        await mgr_hw.start_test(patient_id="live_02", mock=False)
        await mgr_hw.wait_for_idle_or_finish(timeout=5.0)
        assert mixer_calls == [3]

    asyncio.run(scenario())
