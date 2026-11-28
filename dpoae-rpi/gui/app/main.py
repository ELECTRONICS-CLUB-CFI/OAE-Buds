"""FastAPI application entry point for OAE Buds wireless web GUI."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .hardware import detect_audio_device, get_config_metadata, lock_alsa_mixer
from .records_manager import InvalidRecordPathError, RecordsManager
from .session_manager import (
    AudioDeviceNotFoundError,
    HardwareError,
    SessionConflictError,
    SessionManager,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


class _NoCacheStaticFiles(StaticFiles):
    """Serve static assets with Cache-Control: no-cache so updated ES modules revalidate."""

    async def get_response(self, path: str, scope: Any) -> Any:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


class StartTestRequest(BaseModel):
    session_id: str | None = None
    patient_id: str = Field(default="0", max_length=128)
    notes: str = Field(default="", max_length=512)
    ear: str = Field(default="left")
    workflow: str = Field(default="single")
    profile: str = Field(default="ugreen_80864_rpi5")
    mock: bool = False
    fit_check: bool = False
    vol_calib: bool = True
    dev_telemetry: bool = False
    overrides: dict[str, Any] | None = None


class ToneTestRequest(BaseModel):
    channel: str = Field(default="left")
    freq_hz: float = Field(default=1000.0, ge=50.0, le=20000.0)
    f2_hz: float | None = Field(default=None, ge=50.0, le=20000.0)
    duration_s: float = Field(default=2.0, ge=0.2, le=10.0)
    amplitude: float = Field(default=0.2, ge=0.0, le=1.0)


class DeleteRecordsRequest(BaseModel):
    filenames: list[str] = Field(min_length=1, max_length=20)
    delete_artifacts: bool = True


def create_app(
    repo_root: Path = REPO_ROOT,
    binary_path: Path | None = None,
    config_path: Path | None = None,
    results_dir: Path | None = None,
    static_dir: Path | None = None,
    cards_path: Path = Path("/proc/asound/cards"),
    mixer_locker=lock_alsa_mixer,
) -> FastAPI:
    resolved_binary = binary_path or (repo_root / "build" / "dpoae-rpi")
    resolved_config = config_path or (repo_root / "config" / "oae_config.toml")
    env_results = os.environ.get("OAE_RESULTS_DIR")
    resolved_results = results_dir or (Path(env_results) if env_results else (repo_root / "results"))
    resolved_static = static_dir or (repo_root / "gui" / "static")

    records_mgr = RecordsManager(resolved_results)
    session_mgr = SessionManager(
        binary_path=resolved_binary,
        config_path=resolved_config,
        results_dir=resolved_results,
        cards_path=cards_path,
        mixer_locker=mixer_locker,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await session_mgr.shutdown()

    app = FastAPI(title="OAE Buds Wireless Screening GUI", version="1.0.0", lifespan=lifespan)
    app.state.session_manager = session_mgr
    app.state.records_manager = records_mgr

    if resolved_static.is_dir():
        app.mount("/static", _NoCacheStaticFiles(directory=str(resolved_static)), name="static")

    @app.get("/")
    async def index() -> Any:
        index_html = resolved_static / "index.html"
        if index_html.is_file():
            return FileResponse(index_html, headers={"Cache-Control": "no-cache"})
        return JSONResponse({
            "service": "OAE Buds API",
            "status": "running",
            "message": "Frontend assets not yet deployed in gui/static/index.html.",
        })

    @app.get("/api/status")
    async def get_status() -> dict[str, Any]:
        audio = detect_audio_device(cards_path)
        cfg_meta = get_config_metadata(resolved_config)
        return {
            "server": "ok",
            "audio_device": audio.to_dict(),
            "config": cfg_meta,
            "active_session": session_mgr.get_status_snapshot(),
        }

    @app.get("/api/telemetry/stream")
    async def telemetry_stream(request: Request) -> StreamingResponse:
        async def event_generator():
            async with session_mgr.subscribe() as queue:
                # Immediately emit current session state for instant hydration on connect/wake
                initial_payload = {
                    "event": "sync",
                    "active_session": session_mgr.get_status_snapshot(),
                }
                yield f"data: {json.dumps(initial_payload)}\n\n"

                try:
                    while not session_mgr.is_shutting_down:
                        if await request.is_disconnected():
                            break
                        try:
                            event = await asyncio.wait_for(queue.get(), timeout=15.0)
                            if event is None:
                                break
                            yield f"data: {json.dumps(event)}\n\n"
                        except asyncio.TimeoutError:
                            # SSE comment keeps mobile proxies alive and probes dead sockets
                            yield ": keep-alive\n\n"
                except asyncio.CancelledError:
                    return

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post("/api/test/start")
    async def start_test(req: StartTestRequest) -> dict[str, Any]:
        try:
            return await session_mgr.start_test(
                patient_id=req.patient_id,
                ear=req.ear,
                workflow=req.workflow,
                profile=req.profile,
                mock=req.mock,
                fit_check=req.fit_check,
                vol_calib=req.vol_calib,
                notes=req.notes,
                session_id=req.session_id,
                dev_telemetry=req.dev_telemetry,
                overrides=req.overrides,
            )
        except SessionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except AudioDeviceNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (ValueError, FileNotFoundError, HardwareError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/test/stop")
    async def stop_test() -> dict[str, Any]:
        return await session_mgr.stop_test()

    @app.post("/api/test/reset")
    async def reset_session() -> dict[str, Any]:
        try:
            return await session_mgr.reset_session()
        except SessionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/records")
    async def list_records(
        search: str = Query(default="", max_length=128),
        verdict: str = Query(default="", max_length=32),
        ear: str = Query(default="", max_length=32),
        limit: int = Query(default=50, ge=1, le=500),
    ) -> dict[str, Any]:
        items = records_mgr.list_records(search=search, verdict=verdict, ear=ear, limit=limit)
        return {"records": items, "count": len(items)}

    @app.get("/api/records/{filename}")
    async def get_record(filename: str) -> dict[str, Any]:
        try:
            record = records_mgr.get_record(filename)
        except InvalidRecordPathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if record is None:
            raise HTTPException(status_code=404, detail="Record not found.")
        return record

    def _delete_record_files(filenames: list[str], delete_artifacts: bool) -> dict[str, Any]:
        sess = session_mgr.state
        if sess.state == "running":
            raise HTTPException(status_code=409, detail="Cannot delete records while a screening test is running.")

        if sess.state == "waiting_for_next_ear":
            active_names = {
                res.get("filename")
                for res in (sess.left_result, sess.right_result)
                if isinstance(res, dict) and res.get("filename")
            }
            if any(name in active_names for name in filenames):
                raise HTTPException(
                    status_code=409,
                    detail="Cannot delete an in-progress bilateral session while waiting for the next ear.",
                )

        try:
            res = records_mgr.delete_records(filenames, delete_artifacts=delete_artifacts)
        except InvalidRecordPathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if not res["deleted_records"]:
            raise HTTPException(status_code=404, detail="Record not found.")

        deleted_set = set(res["deleted_records"])
        if sess.state == "completed":
            if isinstance(sess.left_result, dict) and sess.left_result.get("filename") in deleted_set:
                sess.left_result = None
            if isinstance(sess.right_result, dict) and sess.right_result.get("filename") in deleted_set:
                sess.right_result = None
            if sess.left_result is None and sess.right_result is None:
                sess.state = "idle"
                sess.session_id = None

        return res

    @app.post("/api/records/delete")
    async def delete_records_batch(req: DeleteRecordsRequest) -> dict[str, Any]:
        return _delete_record_files(req.filenames, req.delete_artifacts)

    @app.delete("/api/records/{filename}")
    async def delete_single_record(
        filename: str,
        delete_artifacts: bool = Query(default=True),
    ) -> dict[str, Any]:
        return _delete_record_files([filename], delete_artifacts)

    @app.post("/api/hardware/verify")
    async def verify_hardware() -> dict[str, Any]:
        audio = detect_audio_device(cards_path)
        if not audio.connected or audio.card_index is None:
            return {
                "audio_device": audio.to_dict(),
                "mixer": {
                    "ok": False,
                    "actions": [],
                    "warnings": [],
                    "error": "USB audio adapter not detected in /proc/asound/cards.",
                },
            }

        mixer_res = await asyncio.to_thread(mixer_locker, audio.card_index)
        return {
            "audio_device": audio.to_dict(),
            "mixer": mixer_res,
        }

    @app.post("/api/dev/tone-test")
    async def dev_tone_test(req: ToneTestRequest) -> dict[str, Any]:
        try:
            return await session_mgr.run_tone_test(
                channel=req.channel,
                freq_hz=req.freq_hz,
                f2_hz=req.f2_hz,
                duration_s=req.duration_s,
                amplitude=req.amplitude,
            )
        except SessionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except AudioDeviceNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (ValueError, FileNotFoundError, HardwareError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/dev/runs")
    async def dev_list_runs(limit: int = Query(default=30, ge=1, le=200)) -> dict[str, Any]:
        runs = records_mgr.list_dev_runs(limit=limit)
        return {"runs": runs, "count": len(runs)}

    @app.get("/api/dev/wav/{filename}")
    async def dev_get_wav(filename: str) -> FileResponse:
        try:
            wav_path = records_mgr.get_wav_path(filename)
        except InvalidRecordPathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if wav_path is None:
            raise HTTPException(status_code=404, detail="WAV recording not found.")
        return FileResponse(wav_path, media_type="audio/wav", filename=filename)

    @app.get("/api/dev/spectrum/{filename}")
    async def dev_get_spectrum(filename: str) -> dict[str, Any]:
        try:
            data = records_mgr.get_dev_spectrum(filename)
        except InvalidRecordPathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if data is None:
            raise HTTPException(status_code=404, detail="Dev spectrum sidecar not found.")
        return data

    return app


app = create_app()
