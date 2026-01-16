from __future__ import annotations

import math
import time

from fastapi.responses import Response

from ..state import STATE


def timer_stats() -> dict:
    n = len(STATE.timer.samples_ms)
    if n <= 0:
        return {"n": 0, "meanMs": None, "sigmaMs": None}
    mean = sum(STATE.timer.samples_ms) / n
    if n <= 1:
        return {"n": n, "meanMs": mean, "sigmaMs": 0.0}
    var = sum((x - mean) ** 2 for x in STATE.timer.samples_ms) / (n - 1)
    return {"n": n, "meanMs": mean, "sigmaMs": math.sqrt(max(0.0, var))}


def timer_state_payload() -> dict:
    return {
        "accepting": STATE.timer.accepting,
        "samplesMs": STATE.timer.samples_ms[-500:],
        "stats": timer_stats(),
        "serverTimeMs": int(time.time() * 1000),
    }


def submit_duration_ms(payload: dict) -> tuple[dict | Response, float | None]:
    """
    Returns (error_response_or_ok_dict, ms_or_none).
    """
    if not STATE.timer.accepting:
        return Response(status_code=409, content="Not accepting", media_type="text/plain"), None
    try:
        ms = float(payload.get("durationMs"))
    except Exception:
        return Response(status_code=400, content="Missing durationMs", media_type="text/plain"), None
    if not (0 <= ms <= 60_000):
        return Response(status_code=400, content="Out of range", media_type="text/plain"), None
    return {"ok": True}, ms

