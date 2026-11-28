"""Clinical JSON record indexing, filtering, bilateral grouping, and safe retrieval."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class InvalidRecordPathError(ValueError):
    """Raised when a requested filename attempts path traversal or is invalid."""


class RecordsManager:
    """Manages reading, filtering, and bilateral grouping of JSON records in results_dir."""

    def __init__(self, results_dir: Path) -> None:
        self.results_dir = results_dir
        self._records_index: dict[str, tuple[int, dict[str, Any]]] = {}
        self._dev_runs_index: dict[str, tuple[int, dict[str, Any]]] = {}

    def _safe_resolve(self, filename: str, required_suffix: str = ".json") -> Path:
        if (
            not filename
            or "/" in filename
            or "\\" in filename
            or not filename.endswith(required_suffix)
        ):
            raise InvalidRecordPathError("Invalid record filename.")

        base = self.results_dir.resolve()
        candidate = (base / filename).resolve()
        if not candidate.is_relative_to(base) or candidate == base:
            raise InvalidRecordPathError("Access denied: path outside results directory.")
        return candidate

    def get_record(self, filename: str) -> dict[str, Any] | None:
        """Safely read and return a single JSON record by filename."""
        path = self._safe_resolve(filename, required_suffix=".json")
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

    def get_dev_spectrum(self, filename: str) -> dict[str, Any] | None:
        """Safely read and return a decimated FFT spectrum & envelope sidecar (-dev.json)."""
        path = self._safe_resolve(filename, required_suffix="-dev.json")
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

    def get_wav_path(self, filename: str) -> Path | None:
        """Safely resolve a WAV recording path inside results_dir."""
        path = self._safe_resolve(filename, required_suffix=".wav")
        if not path.is_file():
            return None
        return path

    def _collect_linked_artifacts(self, clinical_path: Path) -> list[Path]:
        """Collect validated -dev.json and .wav artifact paths belonging to clinical_path."""
        stem = clinical_path.name[: -len(".json")]
        candidate_names: set[str] = {f"{stem}-dev.json"}

        # Scan directory for matching <stem>-*.wav files
        if self.results_dir.exists():
            try:
                for entry in os.scandir(self.results_dir):
                    if (
                        entry.is_file()
                        and entry.name.startswith(f"{stem}-")
                        and entry.name.endswith(".wav")
                    ):
                        candidate_names.add(entry.name)
            except OSError:
                pass

        # Also inspect references embedded inside clinical JSON and -dev.json
        for probe_path, suffix in (
            (clinical_path, ".json"),
            (self.results_dir / f"{stem}-dev.json", "-dev.json"),
        ):
            if not probe_path.is_file():
                continue
            try:
                data = json.loads(probe_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            dev_ref = data.get("dev_telemetry_file")
            if dev_ref:
                candidate_names.add(Path(str(dev_ref)).name)
            for pair in data.get("pairs") or []:
                if isinstance(pair, dict) and pair.get("wav_file"):
                    candidate_names.add(Path(str(pair["wav_file"])).name)

        resolved_artifacts: list[Path] = []
        seen_paths: set[Path] = set()
        for name in sorted(candidate_names):
            suffix = "-dev.json" if name.endswith("-dev.json") else ".wav" if name.endswith(".wav") else ""
            if not suffix:
                continue
            try:
                artifact_path = self._safe_resolve(name, required_suffix=suffix)
            except InvalidRecordPathError:
                continue
            if artifact_path.is_file() and artifact_path not in seen_paths:
                seen_paths.add(artifact_path)
                resolved_artifacts.append(artifact_path)

        return resolved_artifacts

    def delete_records(
        self,
        filenames: list[str],
        delete_artifacts: bool = True,
    ) -> dict[str, Any]:
        """Delete one or more clinical JSON records and optionally their linked -dev.json/.wav files."""
        if not filenames:
            raise InvalidRecordPathError("No record filenames provided.")

        clinical_paths: list[Path] = []
        for filename in filenames:
            if filename.endswith("-dev.json"):
                raise InvalidRecordPathError("Expected clinical record filename, not -dev.json.")
            path = self._safe_resolve(filename, required_suffix=".json")
            clinical_paths.append(path)

        deleted_records: list[str] = []
        deleted_artifacts: list[str] = []

        for clinical_path in clinical_paths:
            if not clinical_path.is_file():
                continue

            artifacts = self._collect_linked_artifacts(clinical_path) if delete_artifacts else []
            clinical_path.unlink()
            deleted_records.append(clinical_path.name)
            self._records_index.pop(clinical_path.name, None)

            if delete_artifacts:
                for artifact_path in artifacts:
                    if artifact_path.is_file():
                        artifact_path.unlink()
                        deleted_artifacts.append(artifact_path.name)
                        self._dev_runs_index.pop(artifact_path.name, None)

        return {
            "deleted_records": deleted_records,
            "deleted_artifacts": deleted_artifacts,
            "kept_artifacts": not delete_artifacts,
        }

    def list_dev_runs(self, limit: int = 30) -> list[dict[str, Any]]:
        """List available -dev.json telemetry sidecar files sorted newest first."""
        if not self.results_dir.exists():
            self._dev_runs_index.clear()
            return []

        seen_files: set[str] = set()
        runs: list[dict[str, Any]] = []
        try:
            entries = list(os.scandir(self.results_dir))
        except OSError:
            return []

        for dir_entry in entries:
            name = dir_entry.name
            if not name.endswith("-dev.json") or not dir_entry.is_file():
                continue
            seen_files.add(name)
            try:
                st = dir_entry.stat()
                mtime_ns = st.st_mtime_ns
            except OSError:
                continue

            cached = self._dev_runs_index.get(name)
            if cached is not None and cached[0] == mtime_ns:
                runs.append(cached[1])
                continue

            try:
                data = json.loads(Path(dir_entry.path).read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
            except (OSError, json.JSONDecodeError):
                continue

            summary = {
                "filename": name,
                "session_id": str(data.get("session_id", "")),
                "patient_id": str(data.get("patient_id", "0")),
                "ear": str(data.get("ear", "left")),
                "sample_rate": int(data.get("sample_rate", 48000)),
                "pair_count": len(data.get("pairs", [])),
                "timestamp_ms": int(mtime_ns // 1_000_000),
            }
            self._dev_runs_index[name] = (mtime_ns, summary)
            runs.append(summary)

        for stale in list(self._dev_runs_index):
            if stale not in seen_files:
                del self._dev_runs_index[stale]

        runs.sort(key=lambda r: r["timestamp_ms"], reverse=True)
        return runs[: max(1, limit)]

    def list_records(
        self,
        search: str = "",
        verdict: str = "",
        ear: str = "",
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List stored sessions, grouping bilateral left/right files by shared session_id."""
        if not self.results_dir.exists():
            self._records_index.clear()
            return []

        seen_files: set[str] = set()
        raw_entries: list[dict[str, Any]] = []
        try:
            entries = list(os.scandir(self.results_dir))
        except OSError:
            return []

        for dir_entry in entries:
            name = dir_entry.name
            if not name.endswith(".json") or name.endswith("-dev.json") or not dir_entry.is_file():
                continue
            seen_files.add(name)
            try:
                st = dir_entry.stat()
                mtime_ns = st.st_mtime_ns
            except OSError:
                continue

            cached = self._records_index.get(name)
            if cached is not None and cached[0] == mtime_ns:
                raw_entries.append(cached[1])
                continue

            try:
                data = json.loads(Path(dir_entry.path).read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
            except (OSError, json.JSONDecodeError):
                continue

            compact_entry = {
                "filename": name,
                "session_id": data.get("session_id"),
                "patient_id": data.get("patient_id", "0"),
                "notes": data.get("notes", ""),
                "profile": data.get("profile", ""),
                "ear": data.get("ear", "left"),
                "verdict": data.get("verdict", "Refer"),
                "passed_count": data.get("passed_count", 0),
                "total_active_frequencies": data.get("total_active_frequencies", 0),
                "noise_check": data.get("noise_check", "noise-pass"),
                "fit_check_enabled": data.get("fit_check_enabled"),
                "fit_check_passed": data.get("fit_check_passed", True),
                "vol_calib_enabled": data.get("vol_calib_enabled"),
                "vol_calib_passed": data.get("vol_calib_passed", True),
                "total_duration_seconds": data.get("total_duration_seconds", 0.0),
                "timestamp": data.get("timestamp", ""),
                "timestamp_ms": data.get("timestamp_ms") or int(mtime_ns // 1_000_000),
                "frequencies": data.get("frequencies", []),
            }
            self._records_index[name] = (mtime_ns, compact_entry)
            raw_entries.append(compact_entry)

        for stale in list(self._records_index):
            if stale not in seen_files:
                del self._records_index[stale]

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
                "fit_check_enabled": entry.get("fit_check_enabled"),
                "fit_check_passed": entry.get("fit_check_passed", True),
                "vol_calib_enabled": entry.get("vol_calib_enabled"),
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
