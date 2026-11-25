"""Async subprocess supervisor, NDJSON telemetry broadcaster, and active session state manager."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from .hardware import detect_audio_device, lock_alsa_mixer


class SessionConflictError(RuntimeError):
    """Raised when attempting an operation while a screening test is already running."""


class AudioDeviceNotFoundError(RuntimeError):
    """Raised when live mode is requested but UGREEN / USB audio card is missing."""


class HardwareError(RuntimeError):
    """Raised when ALSA mixer configuration fails."""


@dataclass
class SessionState:
    session_id: str | None = None
    state: str = "idle"  # "idle" | "running" | "waiting_for_next_ear" | "completed" | "aborted" | "error"
    patient_id: str = ""
    notes: str = ""
    workflow: str = "single"  # "single" | "bilateral"
    current_ear: str | None = None
    profile: str = "ugreen_80864_rpi5"
    mock: bool = False
    fit_check: bool = False
    vol_calib: bool = True
    dev_telemetry: bool = False
    dev_file: str | None = None

    current_phase: str | None = None
    current_frequency_index: int = 0
    total_frequencies: int = 4
    current_f1: int | None = None
    current_f2: int | None = None
    artifact_status: dict[str, Any] | None = None
    started_at_monotonic: float | None = None
    final_elapsed_seconds: float = 0.0

    frequencies_done: list[dict[str, Any]] = field(default_factory=list)
    latest_dev_metrics: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=16))
    fit_check_passed: bool | None = None
    vol_calib_passed: bool | None = None
    left_result: dict[str, Any] | None = None
    right_result: dict[str, Any] | None = None
    error_message: str | None = None

    def elapsed_seconds(self) -> float:
        if self.state == "running" and self.started_at_monotonic is not None:
            return round(max(0.0, time.monotonic() - self.started_at_monotonic), 1)
        return round(self.final_elapsed_seconds, 1)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "state": self.state,
            "patient_id": self.patient_id,
            "notes": self.notes,
            "workflow": self.workflow,
            "current_ear": self.current_ear,
            "profile": self.profile,
            "mock": self.mock,
            "fit_check": self.fit_check,
            "vol_calib": self.vol_calib,
            "dev_telemetry": self.dev_telemetry,
            "dev_file": self.dev_file,
            "current_phase": self.current_phase,
            "current_frequency_index": self.current_frequency_index,
            "total_frequencies": self.total_frequencies,
            "current_f1": self.current_f1,
            "current_f2": self.current_f2,
            "artifact_status": self.artifact_status,
            "elapsed_seconds": self.elapsed_seconds(),
            "frequencies_done": list(self.frequencies_done),
            "latest_dev_metrics": list(self.latest_dev_metrics),
            "fit_check_passed": self.fit_check_passed,
            "vol_calib_passed": self.vol_calib_passed,
            "left_result": self.left_result,
            "right_result": self.right_result,
            "error_message": self.error_message,
        }


class SessionManager:
    """Supervises dpoae-rpi subprocesses and maintains resumable active session state."""

    def __init__(
        self,
        binary_path: Path,
        config_path: Path,
        results_dir: Path,
        cards_path: Path = Path("/proc/asound/cards"),
        mixer_locker=lock_alsa_mixer,
    ) -> None:
        self.binary_path = binary_path
        self.config_path = config_path
        self.results_dir = results_dir
        self.cards_path = cards_path
        self._mixer_locker = mixer_locker

        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._supervisor_task: asyncio.Task[None] | None = None
        self._stop_requested = False
        self._shutting_down = False
        self._subscribers: set[asyncio.Queue[dict[str, Any] | None]] = set()
        self.state = SessionState()

    @property
    def is_shutting_down(self) -> bool:
        return self._shutting_down

    def get_status_snapshot(self) -> dict[str, Any]:
        return self.state.to_dict()

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict[str, Any] | None]]:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=128)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def shutdown(self) -> None:
        """Stop any active subprocess and wake all SSE subscribers cleanly."""
        self._shutting_down = True
        await self.stop_test()
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    async def _broadcast(self, event: dict[str, Any]) -> None:
        stale: list[asyncio.Queue[dict[str, Any] | None]] = []
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale.append(queue)
        for q in stale:
            self._subscribers.discard(q)

    OVERRIDE_FLAGS: dict[str, tuple[str, type]] = {
        "snr_threshold_db": ("--snr-threshold", float),
        "constant_tone_seconds": ("--tone-seconds", int),
        "pass_rule_min_frequencies": ("--min-pass-freqs", int),
        "amp_threshold": ("--amp-threshold", int),
        "art_threshold_db": ("--art-threshold", float),
    }

    async def start_test(
        self,
        patient_id: str,
        ear: str = "left",
        workflow: str = "single",
        profile: str = "ugreen_80864_rpi5",
        mock: bool = False,
        fit_check: bool = False,
        vol_calib: bool = True,
        notes: str = "",
        session_id: str | None = None,
        dev_telemetry: bool = False,
        overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._lock.locked() or self.state.state == "running":
            raise SessionConflictError("A screening or hardware test is already active.")

        async with self._lock:
            if self.state.state == "running":
                raise SessionConflictError("A screening test is already active.")

            ear_norm = ear.strip().lower()
            if ear_norm not in ("left", "right"):
                raise ValueError("Ear must be 'left' or 'right'.")

            workflow_norm = workflow.strip().lower()
            if workflow_norm not in ("single", "bilateral"):
                raise ValueError("Workflow must be 'single' or 'bilateral'.")

            if not self.binary_path.is_file():
                raise FileNotFoundError(f"Screening binary not found at {self.binary_path}")

            if not mock:
                audio = detect_audio_device(self.cards_path)
                if not audio.connected or audio.card_index is None:
                    raise AudioDeviceNotFoundError(
                        "UGREEN 80864 USB Audio device not detected. Connect hardware or enable Mock Mode."
                    )
                mixer_res = await asyncio.to_thread(self._mixer_locker, audio.card_index)
                if not mixer_res.get("ok", False):
                    raise HardwareError(mixer_res.get("error") or "Failed to lock ALSA mixer settings.")

            self.results_dir.mkdir(parents=True, exist_ok=True)

            continuing_bilateral = (
                self.state.state in ("waiting_for_next_ear", "completed")
                and bool(session_id)
                and session_id == self.state.session_id
                and workflow_norm == "bilateral"
            )

            if continuing_bilateral:
                active_session_id = self.state.session_id
                prior_left = self.state.left_result
                prior_right = self.state.right_result
            else:
                active_session_id = (session_id or "").strip() or f"sess_{uuid.uuid4().hex[:8]}"
                prior_left = None
                prior_right = None
                if workflow_norm == "bilateral" and ear_norm != "left":
                    ear_norm = "left"

            self.state = SessionState(
                session_id=active_session_id,
                state="running",
                patient_id=patient_id.strip() or "0",
                notes=notes.strip(),
                workflow=workflow_norm,
                current_ear=ear_norm,
                profile=profile.strip() or "ugreen_80864_rpi5",
                mock=mock,
                fit_check=fit_check,
                vol_calib=vol_calib,
                dev_telemetry=dev_telemetry,
                started_at_monotonic=time.monotonic(),
                left_result=prior_left,
                right_result=prior_right,
            )
            self._stop_requested = False

            cmd = [
                str(self.binary_path),
                "--config", str(self.config_path),
                "--profile", self.state.profile,
                "--patient", self.state.patient_id,
                "--ear", ear_norm,
                "--out-dir", str(self.results_dir),
                "--session-id", active_session_id,
                "--notes", self.state.notes,
                "--json-stream",
                "--fit-check" if fit_check else "--no-fit-check",
                "--vol-calib" if vol_calib else "--no-vol-calib",
            ]
            if mock:
                cmd.append("--mock")
            if dev_telemetry:
                cmd.append("--dev-telemetry")

            if overrides:
                for key, value in overrides.items():
                    if value is None or key not in self.OVERRIDE_FLAGS:
                        continue
                    flag, caster = self.OVERRIDE_FLAGS[key]
                    try:
                        casted = caster(value)
                    except (TypeError, ValueError) as exc:
                        raise ValueError(f"Invalid override value for '{key}': {value}") from exc
                    cmd.extend([flag, str(casted)])

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._process = proc
            if dev_telemetry:
                await self._broadcast({"event": "cmd", "argv": cmd})

            self._supervisor_task = asyncio.create_task(
                self._supervise_process(proc, active_session_id, ear_norm, emit_dev_logs=dev_telemetry)
            )

            return {
                "status": "started",
                "session_id": active_session_id,
                "ear": ear_norm,
                "workflow": workflow_norm,
            }

    async def run_tone_test(
        self,
        channel: str = "left",
        freq_hz: float = 1000.0,
        f2_hz: float | None = None,
        duration_s: float = 2.0,
        amplitude: float = 0.2,
    ) -> dict[str, Any]:
        """Run a live-hardware duplex tone sanity check under the shared hardware mutex."""
        if self._lock.locked() or self.state.state == "running":
            raise SessionConflictError("Cannot run tone test while another screening or hardware test is active.")

        async with self._lock:
            if self.state.state == "running":
                raise SessionConflictError("A screening test is already active.")

            ch = channel.strip().lower()
            if ch not in ("left", "right", "both"):
                raise ValueError("Channel must be 'left', 'right', or 'both'.")

            if not self.binary_path.is_file():
                raise FileNotFoundError(f"Screening binary not found at {self.binary_path}")

            audio = detect_audio_device(self.cards_path)
            if not audio.connected or audio.card_index is None:
                raise AudioDeviceNotFoundError(
                    "Live USB audio hardware required for tone test. Connect UGREEN 80864 adapter."
                )

            mixer_res = await asyncio.to_thread(self._mixer_locker, audio.card_index)
            if not mixer_res.get("ok", False):
                raise HardwareError(mixer_res.get("error") or "Failed to lock ALSA mixer settings.")

            self.results_dir.mkdir(parents=True, exist_ok=True)

            cmd = [
                str(self.binary_path),
                "--config", str(self.config_path),
                "--tone-test",
                "--channel", ch,
                "--freq", str(freq_hz),
                "--duration", str(duration_s),
                "--amp", str(amplitude),
                "--out-dir", str(self.results_dir),
                "--json-stream",
            ]
            if f2_hz is not None and f2_hz > 0:
                cmd.extend(["--f2", str(f2_hz)])

            await self._broadcast({"event": "cmd", "argv": cmd})

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await proc.communicate()
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            if stderr_text:
                stderr_lines = [line for line in stderr_text.splitlines() if line]
                if stderr_lines:
                    await self._broadcast({"event": "stderr_batch", "lines": stderr_lines})

            result_ev: dict[str, Any] | None = None
            for raw_line in stdout_bytes.decode("utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(ev, dict) and ev.get("event") == "tone_test_result":
                    result_ev = ev
                    break
                if isinstance(ev, dict) and ev.get("event") == "error":
                    raise HardwareError(str(ev.get("message", "Tone test failed.")))

            if result_ev is None:
                raise HardwareError(stderr_text or f"Tone test failed (exit code {proc.returncode}).")

            wav_path = result_ev.get("wav_file") or ""
            result_ev["wav_filename"] = Path(wav_path).name if wav_path else None
            await self._broadcast(result_ev)
            return result_ev

    async def stop_test(self) -> dict[str, Any]:
        proc = self._process
        if self.state.state == "running" and proc is not None:
            self._stop_requested = True
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                    await proc.wait()
                except ProcessLookupError:
                    pass

            if self._supervisor_task is not None:
                try:
                    await asyncio.wait_for(self._supervisor_task, timeout=1.0)
                except asyncio.TimeoutError:
                    pass

            return {"status": "aborted", "session_id": self.state.session_id}

        if self.state.state == "waiting_for_next_ear":
            self.state.state = "aborted"
            await self._broadcast({
                "event": "aborted",
                "session_id": self.state.session_id,
                "reason": "Bilateral workflow cancelled by user",
            })
            return {"status": "aborted", "session_id": self.state.session_id}

        return {"status": "idle", "session_id": self.state.session_id}

    async def reset_session(self) -> dict[str, Any]:
        async with self._lock:
            if self.state.state == "running":
                raise SessionConflictError("Cannot reset while a screening test is running.")
            self.state = SessionState()
            await self._broadcast({"event": "reset"})
            return {"status": "idle"}

    async def wait_for_idle_or_finish(self, timeout: float = 10.0) -> None:
        """Helper for deterministic tests: await active supervisor task completion."""
        if self._supervisor_task is not None:
            await asyncio.wait_for(self._supervisor_task, timeout=timeout)

    def _load_saved_summary(self, json_file: str | None) -> dict[str, Any] | None:
        if not json_file:
            return None
        path = Path(json_file)
        if not path.is_file():
            candidate = self.results_dir / path.name
            if candidate.is_file():
                path = candidate
            else:
                return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data["filename"] = path.name
                return data
        except (OSError, json.JSONDecodeError):
            return None
        return None

    async def _stream_stderr(
        self,
        stream: asyncio.StreamReader | None,
        emit_dev_logs: bool,
        collected: list[str],
    ) -> None:
        if stream is None:
            return
        pending: list[str] = []
        last_flush = time.monotonic()

        async def flush() -> None:
            nonlocal last_flush
            if pending and emit_dev_logs:
                await self._broadcast({"event": "stderr_batch", "lines": list(pending)})
            pending.clear()
            last_flush = time.monotonic()

        while True:
            if pending:
                remaining = max(0.01, 0.2 - (time.monotonic() - last_flush))
                try:
                    raw_line = await asyncio.wait_for(stream.readline(), timeout=remaining)
                except asyncio.TimeoutError:
                    await flush()
                    continue
            else:
                raw_line = await stream.readline()

            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                continue
            collected.append(line)
            if emit_dev_logs:
                if not pending:
                    last_flush = time.monotonic()
                pending.append(line)
                if len(pending) >= 25 or (time.monotonic() - last_flush) >= 0.2:
                    await flush()

        if pending:
            await flush()

    async def _supervise_process(
        self,
        proc: asyncio.subprocess.Process,
        session_id: str,
        ear: str,
        emit_dev_logs: bool = False,
    ) -> None:
        terminal_event_seen = False
        stderr_lines: list[str] = []
        stderr_task = asyncio.create_task(
            self._stream_stderr(proc.stderr, emit_dev_logs, stderr_lines)
        )

        try:
            assert proc.stdout is not None
            while True:
                raw_line = await proc.stdout.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not isinstance(ev, dict):
                    continue

                event_name = ev.get("event")

                if event_name == "started":
                    self.state.total_frequencies = int(ev.get("total_pairs", self.state.total_frequencies))
                    await self._broadcast(ev)

                elif event_name == "phase_changed":
                    self.state.current_phase = ev.get("phase")
                    await self._broadcast(ev)

                elif event_name == "fit_check_result":
                    self.state.fit_check_passed = bool(ev.get("passed", False))
                    await self._broadcast(ev)

                elif event_name == "vol_calib_result":
                    self.state.vol_calib_passed = bool(ev.get("passed", False))
                    await self._broadcast(ev)

                elif event_name == "frequency_measuring":
                    self.state.current_frequency_index = int(ev.get("pair_index", 0))
                    self.state.total_frequencies = int(ev.get("total_pairs", self.state.total_frequencies))
                    self.state.current_f1 = ev.get("f1")
                    self.state.current_f2 = ev.get("f2")
                    self.state.artifact_status = {
                        "pair_index": self.state.current_frequency_index,
                        "segments_accepted": 0,
                        "segments_rejected": 0,
                        "status": "clear",
                    }
                    await self._broadcast(ev)

                elif event_name == "dev_telemetry":
                    compact_dev = {
                        "pair_index": ev.get("pair_index"),
                        "f1": ev.get("f1"),
                        "f2": ev.get("f2"),
                        "peak_dbfs": ev.get("peak_dbfs"),
                        "rms_dbfs": ev.get("rms_dbfs"),
                        "clipped_samples": ev.get("clipped_samples"),
                    }
                    self.state.latest_dev_metrics.append(compact_dev)
                    await self._broadcast(ev)

                elif event_name == "artifact_status":
                    self.state.artifact_status = ev
                    await self._broadcast(ev)

                elif event_name == "frequency_result":
                    self.state.frequencies_done.append(ev)
                    await self._broadcast(ev)

                elif event_name == "completed":
                    terminal_event_seen = True
                    if self.state.started_at_monotonic is not None:
                        self.state.final_elapsed_seconds = time.monotonic() - self.state.started_at_monotonic

                    dev_file_path = ev.get("dev_file")
                    if dev_file_path:
                        self.state.dev_file = Path(str(dev_file_path)).name

                    summary = self._load_saved_summary(ev.get("json_file"))
                    if summary is None:
                        summary = {
                            "session_id": session_id,
                            "patient_id": self.state.patient_id,
                            "ear": ear,
                            "notes": self.state.notes,
                            "verdict": ev.get("verdict", "Refer"),
                            "passed_count": ev.get("passed_count", 0),
                            "total_active_frequencies": ev.get("total_active_frequencies", 0),
                            "total_duration_seconds": ev.get("duration_seconds", 0.0),
                            "fit_check_passed": self.state.fit_check_passed if self.state.fit_check_passed is not None else True,
                            "vol_calib_passed": self.state.vol_calib_passed if self.state.vol_calib_passed is not None else True,
                            "frequencies": list(self.state.frequencies_done),
                        }

                    if ear == "left":
                        self.state.left_result = summary
                    else:
                        self.state.right_result = summary

                    ev_out = dict(ev)
                    ev_out["summary"] = summary
                    if self.state.dev_file:
                        ev_out["dev_filename"] = self.state.dev_file

                    if self.state.workflow == "bilateral" and ear == "left" and self.state.right_result is None:
                        self.state.state = "waiting_for_next_ear"
                        self.state.current_ear = "right"
                        await self._broadcast(ev_out)
                        await self._broadcast({
                            "event": "waiting_for_next_ear",
                            "session_id": session_id,
                            "completed_ear": "left",
                            "next_ear": "right",
                            "left_result": summary,
                        })
                    else:
                        self.state.state = "completed"
                        await self._broadcast(ev_out)

                elif event_name == "aborted":
                    terminal_event_seen = True
                    if self.state.started_at_monotonic is not None:
                        self.state.final_elapsed_seconds = time.monotonic() - self.state.started_at_monotonic
                    self.state.state = "aborted"
                    await self._broadcast(ev)

                elif event_name == "error":
                    terminal_event_seen = True
                    if self.state.started_at_monotonic is not None:
                        self.state.final_elapsed_seconds = time.monotonic() - self.state.started_at_monotonic
                    self.state.state = "error"
                    self.state.error_message = str(ev.get("message", "Unknown engine error"))
                    await self._broadcast(ev)

            return_code = await proc.wait()
            await stderr_task
            stderr_text = "\n".join(stderr_lines).strip()

            if not terminal_event_seen:
                if self.state.started_at_monotonic is not None:
                    self.state.final_elapsed_seconds = time.monotonic() - self.state.started_at_monotonic
                if self._stop_requested or return_code in (-15, -2, 130, 143):
                    self.state.state = "aborted"
                    await self._broadcast({
                        "event": "aborted",
                        "session_id": session_id,
                        "reason": "Screening test aborted",
                    })
                else:
                    self.state.state = "error"
                    self.state.error_message = stderr_text or f"Engine exited unexpectedly (code {return_code})"
                    await self._broadcast({
                        "event": "error",
                        "session_id": session_id,
                        "message": self.state.error_message,
                    })
        finally:
            if self._process is proc:
                self._process = None
