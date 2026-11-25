"""FastAPI application entry point for OAE Buds wireless web GUI."""

from __future__ import annotations

import asyncio
import json
import os
import time
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
        app.mount("/static", StaticFiles(directory=str(resolved_static)), name="static")

    @app.get("/")
    async def index() -> Any:
        index_html = resolved_static / "index.html"
        if index_html.is_file():
            return FileResponse(index_html)
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

                last_keepalive = time.monotonic()
                while not session_mgr.is_shutting_down:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=0.5)
                        if event is None:
                            break
                        yield f"data: {json.dumps(event)}\n\n"
                        last_keepalive = time.monotonic()
                    except asyncio.TimeoutError:
                        now = time.monotonic()
                        if now - last_keepalive >= 15.0:
                            # SSE comment keeps mobile proxies/connections alive
                            yield ": keep-alive\n\n"
                            last_keepalive = now

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

    return app


app = create_app()
