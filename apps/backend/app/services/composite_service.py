from __future__ import annotations

import csv
from typing import Any

from fastapi.responses import Response

from ..config import PRESENTATION_DIR


def save_composite(payload: dict[str, Any]) -> dict | Response:
    """
    Generic composite save for any node that has a `groups/<compositeDir>/` folder.

    Payload:
      { "compositePath": "<path>" OR "compositeDir": "<name>",
        "geoms": { "<id>": {x,y,w,h,rotationDeg,anchor,align,parent?...} },
        "elementsText"?: "..." }
    """
    composite_path = str(payload.get("compositePath") or payload.get("compositeDir") or "").strip()
    geoms = payload.get("geoms")
    elements_text = payload.get("elementsText")
    elements_pr = payload.get("elementsPr")
    if not composite_path:
        return Response(status_code=400, content="Missing compositePath", media_type="text/plain")

    parts = [p for p in composite_path.replace("\\", "/").split("/") if p.strip()]
    if not parts:
        return Response(status_code=400, content="Invalid compositePath", media_type="text/plain")
    for part in parts:
        if not part.replace("_", "").replace("-", "").isalnum():
            return Response(status_code=400, content="Invalid compositePath segment", media_type="text/plain")
    if not isinstance(geoms, dict):
        return Response(status_code=400, content="Missing geoms", media_type="text/plain")

    comp_dir = PRESENTATION_DIR / "groups"
    for part in parts:
        comp_dir = comp_dir / part
    comp_dir.mkdir(parents=True, exist_ok=True)
    # Back-compat:
    # - timer composite uses elements.txt
    # - newer composites (e.g. choices/wheel) can use elements.pr
    if isinstance(elements_text, str):
        (comp_dir / "elements.txt").write_text(elements_text, encoding="utf-8")
    if isinstance(elements_pr, str):
        (comp_dir / "elements.pr").write_text(elements_pr, encoding="utf-8")

    out_path = comp_dir / "geometries.csv"
    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align", "parent"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for gid, g in geoms.items():
            if not isinstance(g, dict):
                continue
            w.writerow(
                {
                    "id": gid,
                    "view": "composite",
                    "x": g.get("x", ""),
                    "y": g.get("y", ""),
                    "w": g.get("w", ""),
                    "h": g.get("h", ""),
                    "rotationDeg": g.get("rotationDeg", ""),
                    "anchor": g.get("anchor", ""),
                    "align": g.get("align", ""),
                    "parent": g.get("parent", ""),
                }
            )
    return {"ok": True, "compositePath": "/".join(parts)}

