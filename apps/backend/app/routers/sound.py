from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import StreamingResponse

from ..services.sound_service import CAPTURE, sound_sse_events, sound_state_payload
from ..state import STATE

router = APIRouter()


@router.get("/api/sound/state")
def sound_state():
    return sound_state_payload()


@router.get("/api/sound/stream")
async def sound_stream():
    return StreamingResponse(sound_sse_events(min_interval_ms=50), media_type="text/event-stream")


@router.post("/api/sound/start")
def sound_start():
    CAPTURE.start()
    return {"ok": True}


@router.post("/api/sound/pause")
def sound_pause():
    CAPTURE.pause()
    return {"ok": True}


@router.post("/api/sound/stop")
def sound_stop():
    CAPTURE.stop()
    return {"ok": True}


@router.post("/api/sound/reset")
def sound_reset():
    # Reset should also put the system in the "Run" state (fresh start).
    CAPTURE.pause()
    CAPTURE.reset()
    return {"ok": True}


@router.post("/api/sound/mode")
def sound_mode(payload: dict = Body(...)):
    mode = str(payload.get("mode") or "").strip().lower()
    if mode == "pressure":
        STATE.sound.compute_pressure = True
        STATE.sound.compute_spectrum = False
    else:
        mode = "spectrum"
        STATE.sound.compute_pressure = False
        STATE.sound.compute_spectrum = True

    # If currently running, apply new config immediately.
    if STATE.sound.enabled:
        CAPTURE.start_if_needed()
    return {"ok": True, "mode": mode}

