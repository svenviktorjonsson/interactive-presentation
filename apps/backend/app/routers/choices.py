from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import Response

from ..services.choices_service import compute_choices_state_payload, ensure_choice_state, simulate_votes
from ..state import STATE

router = APIRouter()


@router.get("/api/choices/state")
def choices_state(pollId: str):
    poll_id = (pollId or "").strip()
    return compute_choices_state_payload(poll_id)


@router.get("/api/choices/active")
def choices_active():
    # Return the first poll that is currently accepting votes.
    for pid, st in STATE.choices.items():
        if st.accepting:
            _, meta = ensure_choice_state(pid)
            if not meta:
                continue
            return {
                "pollId": pid,
                "question": meta.get("question", ""),
                "bullets": meta.get("bullets"),
                "chart": meta.get("chart") or "pie",
                "options": meta.get("options") or [],
            }
    return {}


@router.post("/api/choices/start")
def choices_start(payload: dict = Body(...)):
    poll_id = str(payload.get("pollId") or "").strip()
    reset_votes = bool(payload.get("reset", False))
    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")
    if reset_votes:
        votes: dict[str, int] = {}
        for opt in meta.get("options") or []:
            oid = str((opt or {}).get("id") or "").strip()
            if not oid:
                continue
            votes[oid] = 0
        state.votes = votes
    state.accepting = True
    return {"ok": True, "pollId": poll_id}


@router.post("/api/choices/stop")
def choices_stop(payload: dict = Body(...)):
    poll_id = str(payload.get("pollId") or "").strip()
    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")
    state.accepting = False
    return {"ok": True, "pollId": poll_id}


@router.post("/api/choices/reset")
def choices_reset(payload: dict = Body(...)):
    poll_id = str(payload.get("pollId") or "").strip()
    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")
    votes: dict[str, int] = {}
    for opt in meta.get("options") or []:
        oid = str((opt or {}).get("id") or "").strip()
        if not oid:
            continue
        votes[oid] = 0
    state.votes = votes
    return {"ok": True, "pollId": poll_id}


@router.post("/api/choices/simulate")
def choices_simulate(payload: dict = Body(...)):
    """
    Simulate votes WITHOUT opening the poll.
    This is used by the presenter "Test" button and must not affect phone standby.
    """
    poll_id = str(payload.get("pollId") or "").strip()
    users = payload.get("users", 30)
    reset_votes = bool(payload.get("reset", True))
    return simulate_votes(poll_id, users, reset_votes)


@router.post("/api/choices/vote")
def choices_vote(payload: dict = Body(...)):
    poll_id = str(payload.get("pollId") or "").strip()
    option_id = str(payload.get("optionId") or "").strip()
    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")
    if not state.accepting:
        return Response(status_code=409, content="Not accepting", media_type="text/plain")
    if option_id not in (state.votes or {}):
        return Response(status_code=400, content="Unknown optionId", media_type="text/plain")
    state.votes[option_id] = int(state.votes.get(option_id, 0)) + 1
    return {"ok": True, "pollId": poll_id, "optionId": option_id}

