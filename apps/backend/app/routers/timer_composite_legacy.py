from __future__ import annotations

import csv

from fastapi import APIRouter, Body
from fastapi.responses import Response

from ..config import PRESENTATION_DIR

router = APIRouter()

def _format_pr_list_commas(text: str) -> str:
    # Keep behavior aligned with /api/composite/save: `[a,b]` -> `[a, b]`.
    s = str(text or "")
    out: list[str] = []
    in_quotes = False
    brace = 0
    paren = 0
    bracket = 0
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == '"':
            in_quotes = not in_quotes
            out.append(ch)
            i += 1
            continue
        if not in_quotes:
            if ch == "{":
                brace += 1
            elif ch == "}":
                brace = max(0, brace - 1)
            elif ch == "(":
                paren += 1
            elif ch == ")":
                paren = max(0, paren - 1)
            elif ch == "[":
                bracket += 1
            elif ch == "]":
                bracket = max(0, bracket - 1)
        if ch == "," and bracket > 0 and not in_quotes and brace == 0 and paren == 0:
            out.append(ch)
            j = i + 1
            if j < len(s) and s[j] not in (" ", "\t", "\r", "\n", "]"):
                out.append(" ")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


@router.post("/api/timer/composite/save")
def timer_composite_save(payload: dict = Body(...)):
    """
    Legacy endpoint kept for compatibility.

    Save composite-local geometries for timer sub-elements into:
    presentations/default/groups/<compositeDir>/geometries.csv

    Payload:
      { "compositeDir": "<name>", "geoms": { "<id>": {x,y,w,h,rotationDeg,anchor,align} }, "elementsText"?: "..." }
    """
    composite_dir = str(payload.get("compositeDir") or "").strip()
    geoms = payload.get("geoms")
    elements_text = payload.get("elementsText")
    if not composite_dir:
        return Response(status_code=400, content="Missing compositeDir", media_type="text/plain")
    if not composite_dir.replace("_", "").replace("-", "").isalnum():
        return Response(status_code=400, content="Invalid compositeDir", media_type="text/plain")
    if not isinstance(geoms, dict):
        return Response(status_code=400, content="Missing geoms", media_type="text/plain")

    timer_dir = PRESENTATION_DIR / "groups" / composite_dir
    timer_dir.mkdir(parents=True, exist_ok=True)
    out_path = timer_dir / "geometries.csv"
    # Legacy endpoint: treat elementsText as `.pr` content and persist to elements.pr.
    if isinstance(elements_text, str):
        (timer_dir / "elements.pr").write_text(_format_pr_list_commas(elements_text), encoding="utf-8")

    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for gid, g in geoms.items():
            if not isinstance(g, dict):
                continue
            w.writerow(
                {
                    "id": gid,
                    "view": "timer",
                    "x": g.get("x", 0),
                    "y": g.get("y", 0),
                    "w": g.get("w", 0.2),
                    "h": g.get("h", 0.1),
                    "rotationDeg": g.get("rotationDeg", 0),
                    "anchor": g.get("anchor", "topLeft"),
                    "align": g.get("align", ""),
                }
            )

    return {"ok": True, "path": str(out_path)}

