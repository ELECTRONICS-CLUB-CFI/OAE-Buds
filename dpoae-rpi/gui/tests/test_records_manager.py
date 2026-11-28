"""Tests for RecordsManager indexing, bilateral grouping, filtering, and path safety."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gui.app.records_manager import InvalidRecordPathError, RecordsManager


def _write_record(directory: Path, filename: str, payload: dict) -> None:
    (directory / filename).write_text(json.dumps(payload), encoding="utf-8")


def test_list_records_groups_bilateral_and_filters(tmp_path: Path) -> None:
    _write_record(
        tmp_path,
        "p1-left-1000.json",
        {
            "session_id": "sess_bilat_1",
            "patient_id": "alice_01",
            "ear": "left",
            "notes": "Calm infant",
            "timestamp": "2026-11-25 10:00:00",
            "timestamp_ms": 1000,
            "profile": "ugreen_80864_rpi5",
            "verdict": "Pass",
            "passed_count": 4,
            "total_active_frequencies": 4,
            "frequencies": [],
        },
    )
    _write_record(
        tmp_path,
        "p1-right-2000.json",
        {
            "session_id": "sess_bilat_1",
            "patient_id": "alice_01",
            "ear": "right",
            "notes": "",
            "timestamp": "2026-11-25 10:01:00",
            "timestamp_ms": 2000,
            "profile": "ugreen_80864_rpi5",
            "verdict": "Refer",
            "passed_count": 2,
            "total_active_frequencies": 4,
            "frequencies": [],
        },
    )
    _write_record(
        tmp_path,
        "p2-left-3000.json",
        {
            "session_id": "",
            "patient_id": "bob_02",
            "ear": "left",
            "notes": "CLI run",
            "timestamp": "2026-11-25 10:05:00",
            "timestamp_ms": 3000,
            "profile": "ugreen_80864_rpi5",
            "verdict": "Pass",
            "passed_count": 3,
            "total_active_frequencies": 4,
            "frequencies": [],
        },
    )

    mgr = RecordsManager(tmp_path)
    all_records = mgr.list_records()
    assert len(all_records) == 2

    # Sorted newest first: bob_02 (3000) then alice_01 (2000)
    assert all_records[0]["patient_id"] == "bob_02"
    assert all_records[0]["is_bilateral"] is False
    assert all_records[0]["overall_verdict"] == "Pass"

    alice = all_records[1]
    assert alice["patient_id"] == "alice_01"
    assert alice["session_id"] == "sess_bilat_1"
    assert alice["notes"] == "Calm infant"
    assert alice["is_bilateral"] is True
    assert alice["overall_verdict"] == "Refer"
    assert "left" in alice["ears"] and "right" in alice["ears"]

    # Search, verdict, and ear filters
    assert len(mgr.list_records(search="alice")) == 1
    assert len(mgr.list_records(verdict="Pass")) == 1
    assert len(mgr.list_records(ear="bilateral")) == 1
    assert len(mgr.list_records(ear="right")) == 1


def test_get_record_valid_missing_and_traversal(tmp_path: Path) -> None:
    _write_record(tmp_path, "valid.json", {"patient_id": "p1", "verdict": "Pass"})
    mgr = RecordsManager(tmp_path)

    loaded = mgr.get_record("valid.json")
    assert loaded is not None
    assert loaded["patient_id"] == "p1"

    assert mgr.get_record("does_not_exist.json") is None

    for bad_name in ("../secret.json", "../../etc/passwd", "sub/valid.json", "notes.txt", ""):
        with pytest.raises(InvalidRecordPathError):
            mgr.get_record(bad_name)


def test_list_records_and_dev_runs_mtime_cache_invalidation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_record(
        tmp_path,
        "p_cache-left-1000.json",
        {"patient_id": "cache_01", "ear": "left", "verdict": "Pass", "timestamp_ms": 1000},
    )
    _write_record(
        tmp_path,
        "p_cache-left-1000-dev.json",
        {"patient_id": "cache_01", "ear": "left", "pairs": [{"pair_index": 1}]},
    )

    mgr = RecordsManager(tmp_path)
    assert len(mgr.list_records()) == 1
    assert len(mgr.list_dev_runs()) == 1

    # Second call with unchanged mtimes must reuse cached entries without reading files again
    orig_read_text = Path.read_text

    def fail_if_called(self: Path, *args, **kwargs):
        raise AssertionError(f"Unexpected file read on cached mtime: {self}")

    monkeypatch.setattr(Path, "read_text", fail_if_called)
    assert len(mgr.list_records()) == 1
    assert len(mgr.list_dev_runs()) == 1

    # Modify file with a bumped mtime -> must re-read; delete file -> must prune cache
    monkeypatch.setattr(Path, "read_text", orig_read_text)
    rec_path = tmp_path / "p_cache-left-1000.json"
    _write_record(
        tmp_path,
        "p_cache-left-1000.json",
        {"patient_id": "cache_01_updated", "ear": "left", "verdict": "Refer", "timestamp_ms": 2000},
    )
    import os
    st = rec_path.stat()
    os.utime(rec_path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))

    updated = mgr.list_records()
    assert updated[0]["patient_id"] == "cache_01_updated"
    assert updated[0]["overall_verdict"] == "Refer"

    rec_path.unlink()
    assert mgr.list_records() == []


def test_delete_records_with_and_without_artifacts_and_validation(tmp_path: Path) -> None:
    # Record 1: delete clinical JSON + linked -dev.json + .wav files
    _write_record(
        tmp_path,
        "p_del-left-1000.json",
        {
            "patient_id": "del_01",
            "ear": "left",
            "verdict": "Pass",
            "timestamp_ms": 1000,
            "dev_telemetry_file": str(tmp_path / "p_del-left-1000-dev.json"),
        },
    )
    _write_record(
        tmp_path,
        "p_del-left-1000-dev.json",
        {
            "patient_id": "del_01",
            "ear": "left",
            "pairs": [{"pair_index": 1, "wav_file": str(tmp_path / "p_del-left-1000-2016.wav")}],
        },
    )
    (tmp_path / "p_del-left-1000-2016.wav").write_bytes(b"RIFFdata")

    # Record 2: delete clinical JSON only, keep WAV and -dev.json
    _write_record(
        tmp_path,
        "p_keep-right-2000.json",
        {"patient_id": "keep_02", "ear": "right", "verdict": "Refer", "timestamp_ms": 2000},
    )
    _write_record(
        tmp_path,
        "p_keep-right-2000-dev.json",
        {"patient_id": "keep_02", "ear": "right", "pairs": []},
    )
    (tmp_path / "p_keep-right-2000-2016.wav").write_bytes(b"RIFFkeep")

    mgr = RecordsManager(tmp_path)
    assert len(mgr.list_records()) == 2
    assert len(mgr.list_dev_runs()) == 2

    res1 = mgr.delete_records(["p_del-left-1000.json"], delete_artifacts=True)
    assert res1["deleted_records"] == ["p_del-left-1000.json"]
    assert set(res1["deleted_artifacts"]) == {"p_del-left-1000-dev.json", "p_del-left-1000-2016.wav"}
    assert not (tmp_path / "p_del-left-1000.json").exists()
    assert not (tmp_path / "p_del-left-1000-dev.json").exists()
    assert not (tmp_path / "p_del-left-1000-2016.wav").exists()

    res2 = mgr.delete_records(["p_keep-right-2000.json"], delete_artifacts=False)
    assert res2["deleted_records"] == ["p_keep-right-2000.json"]
    assert res2["deleted_artifacts"] == []
    assert res2["kept_artifacts"] is True
    assert not (tmp_path / "p_keep-right-2000.json").exists()
    assert (tmp_path / "p_keep-right-2000-dev.json").exists()
    assert (tmp_path / "p_keep-right-2000-2016.wav").exists()

    assert mgr.list_records() == []
    assert len(mgr.list_dev_runs()) == 1

    for bad in ("../escape.json", "p_keep-right-2000-dev.json", ""):
        with pytest.raises(InvalidRecordPathError):
            mgr.delete_records([bad])
