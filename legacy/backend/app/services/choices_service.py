from __future__ import annotations

import random
from typing import Any

from fastapi.responses import Response

from ..content_loader import load_presentation
from ..state import ChoicesPollState, STATE


def _load_choice_node(poll_id: str) -> dict | None:
    try:
        pres = load_presentation()
    except Exception:
        return None
    for n in pres.payload.get("nodes", []) or []:
        if n.get("id") == poll_id and n.get("type") == "choices":
            return n
    return None


def ensure_choice_state(poll_id: str) -> tuple[ChoicesPollState | None, dict | None]:
    meta = _load_choice_node(poll_id)
    if not meta:
        return None, None
    opts = meta.get("options") or []

    state = STATE.choices.setdefault(
        poll_id,
        ChoicesPollState(
            accepting=False,
            votes={},
            question=str(meta.get("question", "")),
            bullets=meta.get("bullets"),
        ),
    )

    # Clean votes to only include current option ids.
    cleaned: dict[str, int] = {}
    for opt in opts:
        oid = str((opt or {}).get("id") or "").strip()
        if not oid:
            continue
        cleaned[oid] = int(state.votes.get(oid, 0))
    state.votes = cleaned
    state.question = str(meta.get("question", state.question or ""))
    state.bullets = meta.get("bullets", state.bullets)

    return state, meta


def compute_choices_state_payload(poll_id: str) -> dict | Response:
    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")

    votes = state.votes or {}
    opts = meta.get("options") or []

    total = 0
    for v in votes.values():
        try:
            total += int(v)
        except Exception:
            continue

    out_opts = []
    for opt in opts:
        opt = opt or {}
        oid = str(opt.get("id") or "").strip()
        if not oid:
            continue
        count = int(votes.get(oid, 0))
        pct = (count / total * 100.0) if total > 0 else 0.0
        out_opts.append(
            {
                "id": oid,
                "label": opt.get("label", ""),
                "color": opt.get("color"),
                "votes": count,
                "percent": pct,
            }
        )

    return {
        "pollId": poll_id,
        "question": meta.get("question", ""),
        "bullets": meta.get("bullets"),
        "chart": meta.get("chart") or "pie",
        "options": out_opts,
        "accepting": bool(state.accepting),
        "totalVotes": total,
    }


def simulate_votes(poll_id: str, users: Any, reset_votes: bool) -> dict | Response:
    try:
        users_i = int(users)
    except Exception:
        users_i = 30
    users_i = max(0, min(2000, users_i))

    state, meta = ensure_choice_state(poll_id)
    if not state or not meta:
        return Response(status_code=404, content="Unknown pollId", media_type="text/plain")

    opts = meta.get("options") or []
    ids: list[str] = []
    for opt in opts:
        oid = str((opt or {}).get("id") or "").strip()
        if oid:
            ids.append(oid)
    if not ids:
        return Response(status_code=400, content="No options", media_type="text/plain")

    # Always keep accepting unchanged (do NOT start/stop).
    if reset_votes:
        votes = {oid: 0 for oid in ids}
    else:
        votes = dict(state.votes or {})
        for oid in ids:
            votes.setdefault(oid, 0)

    for _ in range(users_i):
        oid = random.choice(ids)
        votes[oid] = int(votes.get(oid, 0)) + 1

    state.votes = votes
    return {"ok": True, "pollId": poll_id, "users": users_i}

