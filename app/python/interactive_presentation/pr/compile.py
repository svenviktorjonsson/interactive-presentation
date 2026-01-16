from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from .parser import ArrowSpec, BulletsSpec, ImageSpec, JoinSpec, PresentationSpec
from .persist import load_geometries_csv


def _parse_animations_csv(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
  """
  animations.csv v0 columns:
  id,what,when,how,where,delayMs
  """
  if not path.exists():
    return {}, []
  out: dict[str, dict[str, Any]] = {}
  cues: list[dict[str, Any]] = []
  with path.open("r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
      node_id = (row.get("id") or "").strip()
      if not node_id:
        continue
      what_raw = (row.get("what") or "").strip().lower() or "enter"
      when_raw = (row.get("when") or "").strip().lower() or "next"
      how_raw = (row.get("how") or "").strip().lower() or "none"
      if ":" in how_raw:
        how, how_data = [x.strip() for x in how_raw.split(":", 1)]
      else:
        how, how_data = how_raw, ""
      if how == "none":
        continue
      allowed = {"sudden", "fade", "pixelate", "move"}
      if how not in allowed:
        continue
      a: dict[str, Any] = {"kind": how}
      delay = (row.get("delayMs") or "").strip()
      if delay:
        a["delayMs"] = int(float(delay))
      if how == "fade" and how_data:
        try:
          a["borderPx"] = float(how_data)
        except ValueError:
          pass
      if how == "move" and how_data:
        try:
          a["distancePx"] = float(how_data)
        except ValueError:
          pass

      where_raw = (row.get("where") or "").strip()
      if where_raw:
        if ":" in where_raw:
          dir_part, speed_part = [x.strip() for x in where_raw.split(":", 1)]
          if dir_part:
            a["where"] = dir_part
          if speed_part:
            try:
              a["speedPxS"] = float(speed_part)
            except ValueError:
              pass
        else:
          a["where"] = where_raw
      out.setdefault(node_id, {})
      # Use a single animation spec for both enter/exit; runtime decides based on cue.what.
      out[node_id]["appear"] = a
      out[node_id]["disappear"] = a
      cue_what = what_raw if what_raw in {"enter", "exit"} else "enter"
      cue_when = when_raw if when_raw in {"same", "after", "next"} else "next"
      cues.append({"id": node_id, "what": cue_what, "when": cue_when})
  return out, cues


def compile_model_payload(spec: PresentationSpec, base_dir: str | Path, *, notes_spec: PresentationSpec | None = None) -> dict[str, Any]:
  """
  Compile minimal `PresentationSpec` to a client ModelPayload JSON.
  For now:
  - 1 view camera
  - text nodes placed with a simple default transform
  """
  base = Path(base_dir)
  geoms = load_geometries_csv(base / "geometries.csv")
  notes_geoms = load_geometries_csv(base / "notes_geometries.csv") if notes_spec is not None else {}
  animations, animation_cues = _parse_animations_csv(base / "animations.csv")
  media_dir = base / "media"

  design_w = 1920.0
  design_h = 1080.0
  view_cameras: dict[str, dict[str, float]] = {}

  def half_extents(cam: dict[str, float]) -> tuple[float, float]:
    z = float(cam.get("zoom", 1.0) or 1.0)
    return (design_w / 2.0) / z, (design_h / 2.0) / z

  def resolve_camera(view_id: str, ref_view: str | None, loc: str | None) -> dict[str, float]:
    if ref_view and ref_view in view_cameras:
      base_cam = view_cameras[ref_view]
    elif view_cameras:
      base_cam = list(view_cameras.values())[-1]
    else:
      base_cam = {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
    cam = {"cx": float(base_cam["cx"]), "cy": float(base_cam["cy"]), "zoom": float(base_cam["zoom"])}
    if not loc:
      return cam
    loc_norm = loc.strip().replace("_", "").replace("-", "").lower()
    if loc_norm in {"center", "origin"}:
      return cam
    hw, hh = half_extents(cam)
    dx = 0.0
    dy = 0.0
    if "right" in loc_norm:
      dx += 2.0 * hw
    if "left" in loc_norm:
      dx -= 2.0 * hw
    if "bottom" in loc_norm or "down" in loc_norm:
      dy += 2.0 * hh
    if "top" in loc_norm or "up" in loc_norm:
      dy -= 2.0 * hh
    cam["cx"] += dx
    cam["cy"] += dy
    return cam

  def _map_view_to_world(cam: dict[str, float], x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    # View-local coords: width=1, height=design_h/design_w, origin at bottom-left.
    aspect = design_h / design_w
    view_w = design_w / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    view_h = design_h / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    xw = float(cam.get("cx", 0.0)) - view_w / 2 + x * view_w
    yw = float(cam.get("cy", 0.0)) - view_h / 2 + (y / max(1e-9, aspect)) * view_h
    ww = w * view_w
    hh = (h / max(1e-9, aspect)) * view_h
    return xw, yw, ww, hh

  def _map_view_point_to_world(cam: dict[str, float], x: float, y: float) -> tuple[float, float]:
    aspect = design_h / design_w
    view_w = design_w / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    view_h = design_h / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    xw = float(cam.get("cx", 0.0)) - view_w / 2 + x * view_w
    yw = float(cam.get("cy", 0.0)) - view_h / 2 + (y / max(1e-9, aspect)) * view_h
    return xw, yw

  views: list[dict[str, Any]] = []
  if spec.views:
    for v in spec.views:
      cam = resolve_camera(v.id, v.ref_view, v.loc)
      view_cameras[v.id] = cam
      row: dict[str, Any] = {"id": v.id, "camera": cam}
      if v.ref_view:
        row["refView"] = v.ref_view
      if v.loc:
        row["loc"] = v.loc
      if v.duration_ms is not None:
        row["durationMs"] = v.duration_ms
      # screenId no longer used in runtime (single screen)
      views.append(row)
  if not views:
    views = [{"id": "home", "camera": {"cx": 0.0, "cy": 0.0, "zoom": 1.0}}]

  nodes: list[dict[str, Any]] = []

  def add_texts(
    texts: list[Any],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, t in enumerate(texts):
      geom_key = (t.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((t.id, "home")) or geom_map.get((t.id, ""))
      space = force_space or (
        "screen" if getattr(t, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.1, "w": 0.3, "h": 0.08}
      default_world = {"x": 0.5, "y": 0.28, "w": 0.22, "h": 0.03}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      if space == "screen":
        # Heuristic: if authored in pixels, normalize against the design size.
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      n: dict[str, Any] = {
        "id": t.id,
        "type": "text",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        "text": t.text,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": (g.fontPx if (g and g.fontPx is not None) else 32),
      }
      align = getattr(t, "align", None)
      if align:
        n["align"] = align
      if getattr(t, "bg_color", None):
        n["bgColor"] = t.bg_color
      if getattr(t, "bg_alpha", None) is not None:
        n["bgAlpha"] = t.bg_alpha
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(t.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def _parse_bullet_lines(text: str) -> list[dict[str, Any]]:
    lines = text.splitlines()
    out: list[dict[str, Any]] = []
    for raw in lines:
      if raw == "":
        out.append({"text": "", "indent": 0})
        continue
      tabs = 0
      spaces = 0
      for ch in raw:
        if ch == "\t":
          tabs += 1
        elif ch == " ":
          spaces += 1
        else:
          break
      indent = tabs + (spaces // 2)
      content = raw.lstrip(" \t")
      out.append({"text": content, "indent": indent})
    return out

  def add_bullets(
    bullets: list[BulletsSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, b in enumerate(bullets):
      geom_key = (b.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((b.id, "home")) or geom_map.get((b.id, ""))
      space = force_space or (
        "screen" if getattr(b, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.4, "h": 0.2}
      default_world = {"x": 0.5, "y": 0.18, "w": 0.25, "h": 0.12}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      if space == "screen":
        # Heuristic: if authored in pixels, normalize against the design size.
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      n: dict[str, Any] = {
        "id": b.id,
        "type": "bullets",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        "items": _parse_bullet_lines(b.text),
        "bullets": b.bullets or "1.a.",
        "rawText": b.text,
        "fontPx": (g.fontPx if (g and g.fontPx is not None) else 32),
        "color": "rgba(255,255,255,0.92)",
      }
      align = getattr(b, "align", None)
      if align:
        n["align"] = align
      if getattr(b, "bg_color", None):
        n["bgColor"] = b.bg_color
      if getattr(b, "bg_alpha", None) is not None:
        n["bgAlpha"] = b.bg_alpha
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(b.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def _resolve_image_src(img: ImageSpec) -> str | None:
    src = (img.src or "").strip()
    if src:
      if src.startswith(("http://", "https://", "/")):
        return src
      return f"/media/{src}"
    # If id already contains an extension and exists, use it.
    if media_dir.exists():
      candidate = media_dir / img.id
      if candidate.exists():
        return f"/media/{candidate.name}"
    # Try common extensions by id.
    exts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]
    for ext in exts:
      candidate = media_dir / f"{img.id}{ext}"
      if candidate.exists():
        return f"/media/{candidate.name}"
    # Fallback to /media/<id>
    return f"/media/{img.id}"

  def add_images(
    images: list[ImageSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, img in enumerate(images):
      geom_key = (img.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((img.id, "home")) or geom_map.get((img.id, ""))
      space = force_space or (
        "screen" if getattr(img, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      if space == "screen":
        # Heuristic: if authored in pixels, normalize against the design size.
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      n: dict[str, Any] = {
        "id": img.id,
        "type": "image",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        "src": _resolve_image_src(img),
      }
      if img.bg_color:
        n["bgColor"] = img.bg_color
      if img.bg_alpha is not None:
        n["bgAlpha"] = img.bg_alpha
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(img.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_joins(
    joins: list[JoinSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, j in enumerate(joins):
      geom_key = (j.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((j.id, "home")) or geom_map.get((j.id, ""))
      space = force_space or (
        "screen" if getattr(j, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.22, "h": 0.22}
      default_world = {"x": 0.5, "y": 0.2, "w": 0.22, "h": 0.22}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      n: dict[str, Any] = {
        "id": j.id,
        "type": "join",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        "fields": list(j.fields or []),
        "text": j.text,
      }
      if j.color:
        n["color"] = j.color
      if getattr(j, "bg_color", None):
        n["bgColor"] = j.bg_color
      if getattr(j, "bg_alpha", None) is not None:
        n["bgAlpha"] = j.bg_alpha
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(j.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_arrows(
    arrows: list[ArrowSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, a in enumerate(arrows):
      geom_key = (a.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((a.id, "home")) or geom_map.get((a.id, ""))
      space = force_space or (
        "screen" if getattr(a, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.3, "h": 0.12}
      default_world = {"x": 0.5, "y": 0.2, "w": 0.3, "h": 0.12}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      # Arrow endpoints:
      use_pr_points = a.start is not None or a.end is not None
      if use_pr_points:
        start_pt = (a.start[0] if a.start else 0, a.start[1] if a.start else 0.5)
        end_pt = (a.end[0] if a.end else 1, a.end[1] if a.end else 0.5)
        start_world = {"x": start_pt[0], "y": start_pt[1]}
        end_world = {"x": end_pt[0], "y": end_pt[1]}
      else:
        if g:
          sx, sy, ex, ey = float(g.x), float(g.y), float(g.w), float(g.h)
        else:
          sx, sy, ex, ey = 0.35, 0.2, 0.65, 0.2
        if space == "world":
          sxw, syw = _map_view_point_to_world(cam, sx, sy)
          exw, eyw = _map_view_point_to_world(cam, ex, ey)
        else:
          sxw, syw = sx, sy
          exw, eyw = ex, ey
        start_world = {"x": sxw, "y": syw}
        end_world = {"x": exw, "y": eyw}

      min_x = min(start_world["x"], end_world["x"])
      min_y = min(start_world["y"], end_world["y"])
      max_x = max(start_world["x"], end_world["x"])
      max_y = max(start_world["y"], end_world["y"])
      box_w = max(1e-9, max_x - min_x)
      box_h = max(1e-9, max_y - min_y)

      n: dict[str, Any] = {
        "id": a.id,
        "type": "arrow",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": {
          "x": min_x if use_pr_points else min_x,
          "y": min_y if use_pr_points else min_y,
          "w": box_w,
          "h": box_h,
          "rotationDeg": 0,
          "anchor": "topLeft",
        },
        "start": start_world,
        "end": end_world,
      }
      if a.color:
        n["color"] = a.color
      if a.stroke_px is not None:
        n["strokePx"] = a.stroke_px
      if getattr(a, "bg_color", None):
        n["bgColor"] = a.bg_color
      if getattr(a, "bg_alpha", None) is not None:
        n["bgAlpha"] = a.bg_alpha
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(a.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  for t in spec.texts:
    add_texts([t], geoms, layer=None, view_id=t.view_id or "home")
  for b in spec.bullets:
    add_bullets([b], geoms, layer=None, view_id=b.view_id or "home")
  for a in spec.arrows:
    add_arrows([a], geoms, layer=None, view_id=a.view_id or "home")
  for j in spec.joins:
    add_joins([j], geoms, layer=None, view_id=j.view_id or "home")
  for img in spec.images:
    add_images([img], geoms, layer=None, view_id=img.view_id or "home")
  for screen in spec.screens:
    add_texts(screen.texts, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_bullets(screen.bullets, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_arrows(screen.arrows, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_joins(screen.joins, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_images(screen.images, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
  if notes_spec is not None:
    for t in notes_spec.texts:
      add_texts([t], notes_geoms, layer="live", view_id=t.view_id or "home")

  node_by_id = {n["id"]: n for n in nodes}
  cues_with_view: list[dict[str, Any]] = []
  for cue in animation_cues:
    row = dict(cue)
    n = node_by_id.get(row.get("id", ""))
    if n:
      if "viewId" in n:
        row["viewId"] = n["viewId"]
      if "screenId" in n:
        row["screenId"] = n["screenId"]
    cues_with_view.append(row)

  return {
    "defaults": {"designWidth": 1920, "designHeight": 1080, "grid": {"enabled": True}},
    "views": views,
    "nodes": nodes,
    "initialViewId": views[0]["id"] if views else "home",
    "animationCues": cues_with_view,
  }

