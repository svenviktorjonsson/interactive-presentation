from __future__ import annotations

import csv

from fastapi import APIRouter, Body
from fastapi.responses import Response

from ..config import PRESENTATION_DIR

router = APIRouter()


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
    if isinstance(elements_text, str):
        (timer_dir / "elements.txt").write_text(elements_text, encoding="utf-8")

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

