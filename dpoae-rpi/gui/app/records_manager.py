"""Clinical JSON record indexing, filtering, bilateral grouping, and safe retrieval."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class InvalidRecordPathError(ValueError):
    """Raised when a requested filename attempts path traversal or is invalid."""


class RecordsManager:
    """Manages reading, filtering, and bilateral grouping of JSON records in results_dir."""

    def __init__(self, results_dir: Path) -> None:
        self.results_dir = results_dir

    def _safe_resolve(self, filename: str) -> Path:
        if not filename or "/" in filename or "\\" in filename or not filename.endswith(".json"):
            raise InvalidRecordPathError("Invalid record filename.")

        base = self.results_dir.resolve()
        candidate = (base / filename).resolve()
        if not candidate.is_relative_to(base) or candidate == base:
            raise InvalidRecordPathError("Access denied: path outside results directory.")
        return candidate

    def get_record(self, filename: str) -> dict[str, Any] | None:
        """Safely read and return a single JSON record by filename."""
        path = self._safe_resolve(filename)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("filename", filename)
                return data
        except (OSError, json.JSONDecodeError):
            return None
        return None

    def list_records(
        self,
        search: str = "",
        verdict: str = "",
        ear: str = "",
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List stored sessions, grouping bilateral left/right files by shared session_id."""
        if not self.results_dir.exists():
            return []

        raw_entries: list[dict[str, Any]] = []
        for path in self.results_dir.glob("*.json"):
            if not path.is_file():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
            except (OSError, json.JSONDecodeError):
                continue

            data["filename"] = path.name
            if not data.get("timestamp_ms"):
                data["timestamp_ms"] = int(path.stat().st_mtime * 1000)
            raw_entries.append(data)

        # Group by session_id when non-empty; otherwise treat each file as its own group
        groups: dict[str, dict[str, Any]] = {}
        for entry in raw_entries:
            sess_id = str(entry.get("session_id") or "").strip()
            group_key = sess_id if sess_id else f"file:{entry['filename']}"

            ear_name = str(entry.get("ear", "left")).lower()
            if ear_name not in ("left", "right"):
                ear_name = "left"

            ear_summary = {
                "filename": entry["filename"],
                "ear": ear_name,
                "verdict": entry.get("verdict", "Refer"),
                "passed_count": entry.get("passed_count", 0),
                "total_active_frequencies": entry.get("total_active_frequencies", 0),
                "noise_check": entry.get("noise_check", "noise-pass"),
                "fit_check_passed": entry.get("fit_check_passed", True),
                "vol_calib_passed": entry.get("vol_calib_passed", True),
                "total_duration_seconds": entry.get("total_duration_seconds", 0.0),
                "timestamp": entry.get("timestamp", ""),
                "timestamp_ms": entry.get("timestamp_ms", 0),
                "frequencies": entry.get("frequencies", []),
            }

            if group_key not in groups:
                groups[group_key] = {
                    "group_id": sess_id if sess_id else entry["filename"],
                    "session_id": sess_id,
                    "patient_id": str(entry.get("patient_id", "0")),
                    "notes": str(entry.get("notes", "")),
                    "profile": str(entry.get("profile", "")),
                    "timestamp": str(entry.get("timestamp", "")),
                    "timestamp_ms": int(entry.get("timestamp_ms", 0)),
                    "ears": {},
                }

            grp = groups[group_key]
            # Keep newest timestamp for the group and merge notes if empty
            if int(entry.get("timestamp_ms", 0)) > grp["timestamp_ms"]:
                grp["timestamp_ms"] = int(entry.get("timestamp_ms", 0))
                grp["timestamp"] = str(entry.get("timestamp", ""))
            if not grp["notes"] and entry.get("notes"):
                grp["notes"] = str(entry["notes"])

            grp["ears"][ear_name] = ear_summary

        # Finalize computed group fields and apply filters
        search_q = search.strip().lower()
        verdict_q = verdict.strip().lower()
        ear_q = ear.strip().lower()

        results: list[dict[str, Any]] = []
        for grp in groups.values():
            ears_dict = grp["ears"]
            grp["is_bilateral"] = ("left" in ears_dict and "right" in ears_dict)

            verdicts = [e["verdict"] for e in ears_dict.values()]
            if all(v == "Pass" for v in verdicts) and verdicts:
                grp["overall_verdict"] = "Pass"
            elif any(v == "Aborted" for v in verdicts):
                grp["overall_verdict"] = "Aborted"
            else:
                grp["overall_verdict"] = "Refer"

            if search_q:
                haystack = " ".join([
                    grp["patient_id"],
                    grp["notes"],
                    grp["session_id"],
                ]).lower()
                if search_q not in haystack:
                    continue

            if verdict_q and grp["overall_verdict"].lower() != verdict_q:
                continue

            if ear_q:
                if ear_q == "bilateral" and not grp["is_bilateral"]:
                    continue
                if ear_q in ("left", "right") and ear_q not in ears_dict:
                    continue

            results.append(grp)

        results.sort(key=lambda r: r["timestamp_ms"], reverse=True)
        return results[: max(1, limit)]
