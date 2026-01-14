from __future__ import annotations

from pathlib import Path
from typing import Any

from .parser import PresentationSpec


def compile_model_payload(spec: PresentationSpec, base_dir: str | Path) -> dict[str, Any]:
  """
  Compile minimal `PresentationSpec` to a client ModelPayload JSON.
  For now:
  - 1 view camera
  - text nodes placed with a simple default transform
  """
  _ = Path(base_dir)  # reserved for future asset resolution

  views = [{"id": v.id, "camera": {"cx": 0, "cy": 0, "zoom": 1}} for v in spec.views]
  nodes: list[dict[str, Any]] = []
  for i, t in enumerate(spec.texts):
    nodes.append(
      {
        "id": t.id,
        "type": "text",
        "space": "world",
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": 0,
          "y": -50 * i,
          "w": 400,
          "h": 60,
          "rotationDeg": 0,
          "anchor": "centerCenter",
        },
        "text": t.text,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": 32,
      }
    )

  return {
    "defaults": {"designWidth": 1920, "designHeight": 1080, "grid": {"enabled": True}},
    "views": views,
    "nodes": nodes,
    "initialViewId": views[0]["id"] if views else "home",
  }

