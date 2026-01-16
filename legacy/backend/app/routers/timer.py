from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import Response

from ..services.timer_service import submit_duration_ms, timer_state_payload
from ..state import STATE

router = APIRouter()


@router.get("/api/timer/state")
def timer_state():
    return timer_state_payload()


@router.post("/api/timer/start")
def timer_start():
    STATE.timer.accepting = True
    return {"ok": True}


@router.post("/api/timer/stop")
def timer_stop():
    STATE.timer.accepting = False
    return {"ok": True}


@router.post("/api/timer/reset")
def timer_reset():
    STATE.timer.samples_ms = []
    return {"ok": True}


@router.post("/api/timer/submit")
def timer_submit(payload: dict = Body(...)):
    res, ms = submit_duration_ms(payload)
    if isinstance(res, Response):
        return res
    assert ms is not None
    STATE.timer.samples_ms.append(ms)
    return res

