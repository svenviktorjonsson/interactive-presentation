from __future__ import annotations

import csv
import logging
from typing import Any

from fastapi.responses import Response

from ..config import PRESENTATION_DIR

logger = logging.getLogger("ip.composite_service")


def _format_pr_list_commas(text: str) -> str:
    """
    Ensure a space after commas inside bracket-lists: `[a,b]` -> `[a, b]`.
    Only affects commas at top-level inside `[...]` (not inside quotes or nested {}()/[]).
    """
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
            # If the next char is already whitespace or a closing bracket, keep as-is.
            if j < len(s) and s[j] not in (" ", "\t", "\r", "\n", "]"):
                out.append(" ")
            i += 1
            continue

        out.append(ch)
        i += 1

    return "".join(out)


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
        logger.warning("save_composite: 400 Missing compositePath (keys=%s)", sorted(payload.keys()))
        return Response(status_code=400, content="Missing compositePath", media_type="text/plain")

    parts = [p for p in composite_path.replace("\\", "/").split("/") if p.strip()]
    if not parts:
        logger.warning("save_composite: 400 Invalid compositePath (raw=%r)", composite_path)
        return Response(status_code=400, content="Invalid compositePath", media_type="text/plain")
    for part in parts:
        if not part.replace("_", "").replace("-", "").isalnum():
            logger.warning("save_composite: 400 Invalid compositePath segment (raw=%r part=%r)", composite_path, part)
            return Response(status_code=400, content="Invalid compositePath segment", media_type="text/plain")
    if not isinstance(geoms, dict):
        logger.warning("save_composite: 400 Missing geoms (compositePath=%r geomsType=%s)", composite_path, type(geoms).__name__)
        return Response(status_code=400, content="Missing geoms", media_type="text/plain")

    comp_dir = PRESENTATION_DIR / "groups"
    for part in parts:
        comp_dir = comp_dir / part
    comp_dir.mkdir(parents=True, exist_ok=True)
    # Back-compat:
    # - older clients may send `elementsText`; treat it as `.pr` content and save to elements.pr.
    if isinstance(elements_text, str):
        (comp_dir / "elements.pr").write_text(_format_pr_list_commas(elements_text), encoding="utf-8")
    if isinstance(elements_pr, str):
        (comp_dir / "elements.pr").write_text(_format_pr_list_commas(elements_pr), encoding="utf-8")

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

