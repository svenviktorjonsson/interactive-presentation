from __future__ import annotations

import csv
import json
import math
from urllib.parse import quote
from pathlib import Path
from typing import Any

from ..builtin_groups import build_builtin_group_defaults_resolver, build_builtin_group_module_registry
from ..model_compiler.composite_adapters import CompositeRenderContext
from .parser import (
  AxisSpec,
  ArrowSpec,
  ButtonsSpec,
  SliderSpec,
  PlayerSpec,
  WebcamSpec,
  SoundSpec,
  PressureSpec,
  SpectrumSpec,
  TimerSpec,
  TableSpec,
  ExperimentSpec,
  MultiChoiceSpec,
  WheelSpec,
  BulletsSpec,
  GroupSpec,
  ImageSpec,
  IframeSpec,
  JoinSpec,
  PresentationSpec,
  VideoSpec,
  parse_presentation_pr,
)
from .persist import load_geometries_csv
from .template import format_template


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


def _to_alpha(n: int, upper: bool) -> str:
  value = max(1, int(n))
  label = ""
  while value > 0:
    value -= 1
    ch = chr((value % 26) + (65 if upper else 97))
    label = f"{ch}{label}"
    value = value // 26
  return label


def _to_roman(n: int, upper: bool) -> str:
  value = max(1, int(n))
  out = ""
  mapping = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
  ]
  for v, ch in mapping:
    while value >= v:
      out += ch
      value -= v
  return out if upper else out.lower()


def format_choice_label(kind_raw: str, index: int) -> str:
  kind = str(kind_raw or "A")
  n = max(1, int(index) + 1)
  if kind == "A":
    return _to_alpha(n, True)
  if kind == "a":
    return _to_alpha(n, False)
  if kind == "1":
    return str(n)
  if kind == "I":
    return _to_roman(n, True)
  if kind == "i":
    return _to_roman(n, False)
  return _to_alpha(n, True)


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

  def _load_defaults(base: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in ("defaults.json", "default.json"):
      path = base / name
      if not path.exists():
        continue
      try:
        data = json.loads(path.read_text(encoding="utf-8"))
      except Exception:
        continue
      if not isinstance(data, dict):
        continue
      # Shallow merge with nested dict merge for "elements".
      for k, v in data.items():
        if k == "elements" and isinstance(v, dict):
          base_el = out.get("elements")
          if isinstance(base_el, dict):
            base_el.update(v)
          else:
            out[k] = dict(v)
        else:
          out[k] = v
    return out

  defaults_cfg = _load_defaults(base)
  design_w = float(defaults_cfg.get("designWidth", 1920.0) or 1920.0)
  design_h = float(defaults_cfg.get("designHeight", 1080.0) or 1080.0)
  element_defaults = defaults_cfg.get("elements") if isinstance(defaults_cfg.get("elements"), dict) else {}
  default_size_scale = float(defaults_cfg.get("defaultSizeScale", 0.5) or 0.5)

  def apply_element_defaults(node: dict[str, Any], type_key: str) -> None:
    if not isinstance(element_defaults, dict):
      return
    cfg = element_defaults.get(type_key)
    if not isinstance(cfg, dict):
      return
    for k, v in cfg.items():
      if k in node and node[k] is not None:
        continue
      node[k] = v

  def apply_default_size_scale(g: Any, w: float, h: float) -> tuple[float, float]:
    if g is not None or abs(default_size_scale - 1.0) < 1e-6:
      return w, h
    return w * default_size_scale, h * default_size_scale


  def normalize_authored_units(x: float, y: float, w: float, h: float, space: str) -> tuple[float, float, float, float]:
    if space == "screen" or space == "group":
      return x, y, w, h
    # Mixed units can happen; normalize per component when values look like px.
    if max(abs(x), abs(y), abs(w), abs(h)) > 2:
      x = x / design_w if abs(x) > 2 else x
      w = w / design_w if abs(w) > 2 else w
      y = y / design_h if abs(y) > 2 else y
      h = h / design_h if abs(h) > 2 else h
    return x, y, w, h
  view_cameras: dict[str, dict[str, float]] = {}

  def half_extents(cam: dict[str, float]) -> tuple[float, float]:
    z = float(cam.get("zoom", 1.0) or 1.0)
    return (0.5 / z), (0.5 / z)

  def resolve_base_camera(ref_view: str | None) -> dict[str, float]:
    if ref_view and ref_view in view_cameras:
      base_cam = view_cameras[ref_view]
    elif view_cameras:
      base_cam = list(view_cameras.values())[-1]
    else:
      base_cam = {"cx": 0.5, "cy": 0.5, "zoom": 1.0}
    return {"cx": float(base_cam["cx"]), "cy": float(base_cam["cy"]), "zoom": 1.0}

  def resolve_camera(view_id: str, ref_view: str | None, loc: str | None) -> dict[str, float]:
    base_cam = resolve_base_camera(ref_view)
    cam = {"cx": float(base_cam["cx"]), "cy": float(base_cam["cy"]), "zoom": 1.0}
    if not loc:
      return cam
    loc_norm = loc.strip().replace("_", "").replace("-", "").lower()
    if loc_norm in {"center", "origin"}:
      return cam
    hw, hh = half_extents(cam)
    dx = 0.0
    dy = 0.0
    if "right" in loc_norm or "east" in loc_norm:
      dx += 2.0 * hw
    if "left" in loc_norm or "west" in loc_norm:
      dx -= 2.0 * hw
    if "bottom" in loc_norm or "down" in loc_norm or "south" in loc_norm or "below" in loc_norm:
      dy += 2.0 * hh
    if "top" in loc_norm or "up" in loc_norm or "north" in loc_norm or "above" in loc_norm:
      dy -= 2.0 * hh
    cam["cx"] += dx
    cam["cy"] += dy
    return cam

  def _map_view_to_world(cam: dict[str, float], x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    # View-local coords: normalized [0..1], origin at top-left, +y down.
    view_w = 1.0 / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    view_h = 1.0 / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    xw = float(cam.get("cx", 0.0)) - view_w / 2 + x * view_w
    yw = float(cam.get("cy", 0.0)) - view_h / 2 + y * view_h
    ww = w * view_w
    hh = h * view_h
    return xw, yw, ww, hh

  def _map_view_point_to_world(cam: dict[str, float], x: float, y: float) -> tuple[float, float]:
    view_w = 1.0 / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    view_h = 1.0 / max(1e-9, float(cam.get("zoom", 1.0) or 1.0))
    xw = float(cam.get("cx", 0.0)) - view_w / 2 + x * view_w
    yw = float(cam.get("cy", 0.0)) - view_h / 2 + y * view_h
    return xw, yw

  def _anchor_frac(anchor: str | None) -> tuple[float, float]:
    a = (anchor or "centerCenter").strip()
    mapping = {
      "topLeft": (0.0, 0.0),
      "topCenter": (0.5, 0.0),
      "topRight": (1.0, 0.0),
      "centerLeft": (0.0, 0.5),
      "centerCenter": (0.5, 0.5),
      "centerRight": (1.0, 0.5),
      "bottomLeft": (0.0, 1.0),
      "bottomCenter": (0.5, 1.0),
      "bottomRight": (1.0, 1.0),
    }
    return mapping.get(a, (0.5, 0.5))

  def _group_local_to_world(group_t: dict[str, Any], p: dict[str, float]) -> dict[str, float]:
    ax, ay = _anchor_frac(str(group_t.get("anchor") or "centerCenter"))
    gw = float(group_t.get("w", 0.0) or 0.0)
    gh = float(group_t.get("h", 0.0) or 0.0)
    x0 = float(p.get("x", 0.0))
    y0 = float(p.get("y", 0.0))
    lx = (x0 - ax) * gw
    ly = (y0 - ay) * gh
    rot = float(group_t.get("rotationDeg", 0.0) or 0.0)
    rad = rot * 3.141592653589793 / 180.0
    cos = float(math.cos(rad))
    sin = float(math.sin(rad))
    dx = lx * cos - ly * sin
    dy = lx * sin + ly * cos
    return {"x": float(group_t.get("x", 0.0)) + dx, "y": float(group_t.get("y", 0.0)) + dy}

  def _normalize_local_top_left(local_t: dict[str, Any]) -> dict[str, Any]:
    anchor = str(local_t.get("anchor") or "centerCenter")
    ax, ay = _anchor_frac(anchor)
    w = float(local_t.get("w", 0.0) or 0.0)
    h = float(local_t.get("h", 0.0) or 0.0)
    x = float(local_t.get("x", 0.0) or 0.0) - ax * w
    y = float(local_t.get("y", 0.0) or 0.0) - ay * h
    out = dict(local_t)
    out["x"] = x
    out["y"] = y
    out["anchor"] = "topLeft"
    return out

  views: list[dict[str, Any]] = []
  if spec.views:
    for v in spec.views:
      base_cam = resolve_base_camera(v.ref_view)
      cam = resolve_camera(v.id, v.ref_view, v.loc)
      if not v.ref_view and not v.loc:
        cam = {**cam, "cx": 0.5, "cy": 0.5, "zoom": 1.0}
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
    views = [{"id": "home", "camera": {"cx": 0.5, "cy": 0.5, "zoom": 1.0}}]

  nodes: list[dict[str, Any]] = []

  def _lookup_geom(geom_map: dict[str, Any], elem_id: str, view_id: str | None) -> Any | None:
    base_key = (elem_id, view_id or "home")
    g = geom_map.get(base_key) or geom_map.get((elem_id, "home")) or geom_map.get((elem_id, ""))
    if g:
      return g
    g_screen = geom_map.get((elem_id, "screen_main"))
    if g_screen and str(getattr(g_screen, "space", "") or "") == "screen":
      return g_screen
    return None

  def _z_index_from_geom(g: Any) -> int:
    try:
      return int(getattr(g, "zIndex", 0) or 0)
    except Exception:
      return 0

  def apply_z_index_for_nodes(target_nodes: list[dict[str, Any]], geom_map: dict[str, Any], *, view_id_override: str | None = None) -> None:
    for n in target_nodes:
      node_id = str(n.get("id", "")).strip()
      if not node_id:
        continue
      view_id = view_id_override or n.get("viewId") or ("screen_main" if n.get("space") == "screen" else None)
      g = _lookup_geom(geom_map, node_id, view_id)
      if not g:
        continue
      n["zIndex"] = _z_index_from_geom(g)

  def _local_override_factory(group_id: str):
    group_geoms = load_geometries_csv(base / "groups" / group_id / "geometries.csv")
    module_type = builtin_group_instance_types.get(str(group_id))

    def _local_override(child_id: str, fallback: dict[str, Any]) -> dict[str, Any]:
      g0 = group_geoms.get((child_id, "group")) or group_geoms.get((child_id, "")) or group_geoms.get((child_id, "home"))
      if not g0:
        for (gid, _view), row in group_geoms.items():
          if gid == child_id:
            g0 = row
            break
      if not g0 and module_type:
        g0 = builtin_group_defaults.lookup_default_group_geom(module_type, str(group_id), child_id)
      if not g0:
        return fallback
      return {
        "x": float(g0.x),
        "y": float(g0.y),
        "w": float(g0.w),
        "h": float(g0.h),
        "rotationDeg": float(g0.rotationDeg),
        "anchor": str(g0.anchor),
      }

    return _local_override

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
      geom_view_id = view_id
      if force_space == "screen":
        geom_view_id = screen_id or "screen_main"
      g = _lookup_geom(geom_map, t.id, geom_view_id)
      space = force_space or (
        "screen" if getattr(t, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.1, "w": 0.3, "h": 0.08}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.22, "h": 0.03}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      rendered_text = format_template(t.text, {})
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
        "text": rendered_text,
        "template": t.text,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": (g.fontPx if (g and g.fontPx is not None) else 36),
      }
      align = getattr(t, "align", None)
      if align:
        n["align"] = align
      if getattr(t, "bg_color", None):
        n["bgColor"] = t.bg_color
      if getattr(t, "bg_alpha", None) is not None:
        n["bgAlpha"] = t.bg_alpha
      if getattr(t, "bg_padding", None) is not None:
        n["bgPadding"] = t.bg_padding
      if getattr(t, "bg_radius", None) is not None:
        n["bgRadius"] = t.bg_radius
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(t.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      apply_element_defaults(n, "text")
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

  composite_ctx = CompositeRenderContext(
    nodes=nodes,
    apply_element_defaults=apply_element_defaults,
    group_local_to_world=_group_local_to_world,
    local_override_factory=_local_override_factory,
    parse_bullet_lines=_parse_bullet_lines,
  )
  builtin_group_registry = build_builtin_group_module_registry()
  builtin_group_definitions = builtin_group_registry.definitions()
  builtin_group_defaults = build_builtin_group_defaults_resolver()
  builtin_group_instance_types: dict[str, str] = {}

  def _compile_builtin_group(module_type: str, spec: Any, *, transform: dict[str, Any], space: str, view_id: str | None, layer: str | None) -> None:
    definition = builtin_group_definitions[module_type]
    builtin_group_instance_types[str(getattr(spec, "id", "")).strip()] = module_type
    start_idx = len(nodes)
    definition.adapter.compile(
      composite_ctx,
      spec,
      transform=transform,
      space=space,
      view_id=view_id,
      layer=layer,
    )
    target_nodes = nodes[start_idx:]
    target_group_id = str(getattr(spec, "id", "")).strip()
    builtin_group_defaults.apply_item_overlay(module_type, target_group_id, target_nodes, format_template=format_template)
    builtin_group_defaults.apply_geometry_overlay(module_type, target_group_id, target_nodes)

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
      default_world = {"x": 0.5, "y": 0.5, "w": 0.25, "h": 0.12}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      rendered_text = format_template(b.text, {})
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
        "items": _parse_bullet_lines(rendered_text),
        "bullets": b.bullets or "1.a.",
        "rawText": rendered_text,
        "template": b.text,
        "fontPx": (g.fontPx if (g and g.fontPx is not None) else 36),
        "color": "rgba(255,255,255,0.92)",
      }
      align = getattr(b, "align", None)
      if align:
        n["align"] = align
      if getattr(b, "bg_color", None):
        n["bgColor"] = b.bg_color
      if getattr(b, "bg_alpha", None) is not None:
        n["bgAlpha"] = b.bg_alpha
      if getattr(b, "bg_padding", None) is not None:
        n["bgPadding"] = b.bg_padding
      if getattr(b, "bg_radius", None) is not None:
        n["bgRadius"] = b.bg_radius
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
      return src
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
      geom_view_id = view_id
      if force_space == "screen":
        geom_view_id = screen_id or "screen_main"
      g = _lookup_geom(geom_map, img.id, geom_view_id)
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
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
      if img.bg_padding is not None:
        n["bgPadding"] = img.bg_padding
      if img.bg_radius is not None:
        n["bgRadius"] = img.bg_radius
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(img.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def _resolve_iframe_src(frame: IframeSpec) -> str | None:
    src = (frame.src or "").strip()
    if src:
      if src.startswith(("http://", "https://")):
        return f"/iframe-proxy?url={quote(src, safe='')}"
      if src.startswith("/"):
        return src
      return src
    html = (frame.html or "").strip()
    if not html:
      return None
    return f"data:text/html;charset=utf-8,{quote(html, safe='')}"

  def add_iframes(
    iframes: list[IframeSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, frame in enumerate(iframes):
      geom_view_id = view_id
      if force_space == "screen":
        geom_view_id = screen_id or "screen_main"
      g = _lookup_geom(geom_map, frame.id, geom_view_id)
      space = force_space or (
        "screen" if getattr(frame, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      resolved = _resolve_iframe_src(frame)
      if not resolved:
        continue
      n: dict[str, Any] = {
        "id": frame.id,
        "type": "htmlFrame",
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
        "src": resolved,
      }
      if frame.bg_color:
        n["bgColor"] = frame.bg_color
      if frame.bg_alpha is not None:
        n["bgAlpha"] = frame.bg_alpha
      if frame.bg_padding is not None:
        n["bgPadding"] = frame.bg_padding
      if frame.bg_radius is not None:
        n["bgRadius"] = frame.bg_radius
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(frame.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def _resolve_video_src(raw: str | None) -> str | None:
    src = (raw or "").strip()
    if not src:
      return None
    if src.startswith(("http://", "https://", "/")):
      return src
    return f"/media/{src}"

  def add_videos(
    videos: list[VideoSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, v in enumerate(videos):
      geom_key = (v.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((v.id, "home")) or geom_map.get((v.id, ""))
      space = force_space or (
        "screen" if getattr(v, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.28, "h": 0.22}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.28, "h": 0.22}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
        "id": v.id,
        "type": "video",
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
        "src": _resolve_video_src(v.src),
      }
      if v.thumbnail:
        n["thumbnail"] = v.thumbnail
      if v.poster:
        n["poster"] = v.poster
      if v.bg_color:
        n["bgColor"] = v.bg_color
      if v.bg_alpha is not None:
        n["bgAlpha"] = v.bg_alpha
      if v.bg_padding is not None:
        n["bgPadding"] = v.bg_padding
      if v.bg_radius is not None:
        n["bgRadius"] = v.bg_radius
      apply_element_defaults(n, "video")
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(v.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_axes(
    axes: list[AxisSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    aspect = design_h / max(1e-9, design_w)
    for i, a in enumerate(axes):
      geom_key = (a.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((a.id, "home")) or geom_map.get((a.id, ""))
      space = force_space or (
        "screen" if getattr(a, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.0, "y": 0.0, "w": 0.6, "h": 0.35}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.6, "h": 0.35}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
      limits: dict[str, float] = {}
      if a.x_min is not None:
        limits["xMin"] = float(a.x_min)
      if a.x_max is not None:
        limits["xMax"] = float(a.x_max)
      if a.y_min is not None:
        limits["yMin"] = float(a.y_min)
      if a.y_max is not None:
        limits["yMax"] = float(a.y_max)
      n: dict[str, Any] = {
        "id": a.id,
        "type": "axis",
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
      }
      if limits:
        n["limits"] = limits
      if a.clamp is not None:
        n["clamp"] = bool(a.clamp)
      elif limits:
        n["clamp"] = True
      if a.pad_px is not None:
        n["padPx"] = float(a.pad_px)
      if a.max_points is not None:
        n["maxPoints"] = int(a.max_points)
      if getattr(a, "bins", None):
        n["bins"] = list(a.bins or [])
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(a.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_buttons(
    buttons: list[ButtonsSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    aspect = design_h / max(1e-9, design_w)
    for i, b in enumerate(buttons):
      geom_key = (b.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((b.id, "home")) or geom_map.get((b.id, ""))
      space = force_space or (
        "screen" if getattr(b, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.2, "w": 0.6, "h": 0.2}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.6, "h": 0.2}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
      label_templates = [str(x) for x in (b.labels or [])]
      labels = [format_template(x, {}) for x in label_templates]
      n: dict[str, Any] = {
        "id": b.id,
        "type": "buttons",
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
        "labels": labels,
        "templates": label_templates,
      }
      if getattr(b, "buttons_mode", None):
        n["buttonsMode"] = str(b.buttons_mode)
      if b.actions:
        n["actions"] = [str(x) for x in b.actions]
      if b.h_splits:
        n["hSplits"] = [float(x) for x in b.h_splits]
      if b.v_splits:
        n["vSplits"] = [float(x) for x in b.v_splits]
      if b.rows is not None:
        n["rows"] = int(b.rows)
      if b.cols is not None:
        n["cols"] = int(b.cols)
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(b.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_multichoices(
    multichoices: list[MultiChoiceSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for i, m in enumerate(multichoices):
      geom_key = (m.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((m.id, "home")) or geom_map.get((m.id, ""))
      space = force_space or (
        "screen" if getattr(m, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.4}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.4}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
      _compile_builtin_group(
        "multichoice",
        m,
        transform={
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_wheels(
    wheels: list[WheelSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for i, w in enumerate(wheels):
      geom_key = (w.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((w.id, "home")) or geom_map.get((w.id, ""))
      space = force_space or (
        "screen" if getattr(w, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.4, "h": 0.4}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.4, "h": 0.4}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "world":
        xw, yw, ww, hh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        xw = base_x
        yw = base_y
        ww = base_w
        hh = base_h
      answers_raw = list(getattr(w, "answers", None) or [])
      answers = [
        {"name": str(name), "color": str(color) if color is not None else ""}
        for name, color in answers_raw
      ]
      other_label = str(getattr(w, "other_label", "") or "")
      other_limit = getattr(w, "other_limit", None)
      choice_type = str(getattr(w, "choice_type", None) or "A")

      n: dict[str, Any] = {
        "id": w.id,
        "type": "wheel",
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
        "answers": answers,
        "choiceType": choice_type,
        "otherLabel": other_label,
        "otherLimit": other_limit,
        "showList": True,
        "showQuestion": True,
      }
      if view_id and space != "screen":
        n["viewId"] = view_id
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_tables(
    tables: list[TableSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for t in tables:
      geom_key = (t.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((t.id, "home")) or geom_map.get((t.id, ""))
      space = force_space or (
        "screen" if getattr(t, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.45, "w": 0.6, "h": 0.35}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.6, "h": 0.35}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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

      base_id = str(t.id)
      _local_override = _local_override_factory(base_id)
      cells_raw = [list(r) for r in (t.cells or [])]
      h_header = list(getattr(t, "h_header", None) or [])
      v_header = list(getattr(t, "v_header", None) or [])
      h_style = list(getattr(t, "h_style", None) or [])
      rows = int(t.rows) if t.rows is not None else len(cells_raw)
      cols = int(t.cols) if t.cols is not None else max([len(r) for r in cells_raw], default=0)
      rows = max(rows, len(cells_raw), len(v_header), 1)
      cols = max(cols, max([len(r) for r in cells_raw], default=0), len(h_header), 1)
      cells: list[list[str]] = [["" for _ in range(cols)] for _ in range(rows)]
      for r, row in enumerate(cells_raw):
        if r >= rows:
          break
        for c, val in enumerate(row):
          if c >= cols:
            break
          cells[r][c] = str(val)

      editable = bool(t.editable) if t.editable is not None else True
      table_node: dict[str, Any] = {
        "id": base_id,
        "type": "table",
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
        "rows": rows,
        "cols": cols,
        "cells": cells,
        "editable": editable,
        "hHeader": h_header,
        "vHeader": v_header,
        "hStyle": h_style,
      }
      if h_header and not h_style:
        table_node["hStyle"] = ["center" for _ in range(max(1, cols))]
      if getattr(t, "color", None):
        table_node["color"] = t.color
      if getattr(t, "bg_color", None):
        table_node["bgColor"] = t.bg_color
      if getattr(t, "bg_alpha", None) is not None:
        table_node["bgAlpha"] = t.bg_alpha
      if getattr(t, "bg_padding", None) is not None:
        table_node["bgPadding"] = t.bg_padding
      if getattr(t, "bg_radius", None) is not None:
        table_node["bgRadius"] = t.bg_radius
      apply_element_defaults(table_node, "table")
      if table_node.get("bgColor") is None:
        table_node["bgColor"] = "white"
      if table_node.get("color") is None:
        table_node["color"] = "black"
      if view_id and space != "screen":
        table_node["viewId"] = view_id
      if layer:
        table_node["layer"] = layer
      nodes.append(table_node)

  def add_sliders(
    sliders: list[SliderSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    aspect = design_h / max(1e-9, design_w)
    for i, s in enumerate(sliders):
      geom_key = (s.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((s.id, "home")) or geom_map.get((s.id, ""))
      space = force_space or (
        "screen" if getattr(s, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.15, "w": 0.6, "h": 0.08}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.6, "h": 0.08}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
        "id": s.id,
        "type": "slider",
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
      }
      if s.min_val is not None:
        n["min"] = float(s.min_val)
      if s.max_val is not None:
        n["max"] = float(s.max_val)
      if s.step is not None:
        n["step"] = float(s.step)
      if s.value is not None:
        n["value"] = float(s.value)
      if getattr(s, "values", None):
        vals = [float(v) for v in s.values if v is not None]
        if vals:
          n["values"] = vals
          if "min" not in n:
            n["min"] = min(vals)
          if "max" not in n:
            n["max"] = max(vals)
          if "value" not in n:
            n["value"] = vals[0]
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(s.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_players(
    players: list[PlayerSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    aspect = design_h / max(1e-9, design_w)
    for i, p in enumerate(players):
      geom_key = (p.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((p.id, "home")) or geom_map.get((p.id, ""))
      space = force_space or (
        "screen" if getattr(p, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.35, "w": 0.7, "h": 0.45}
      default_world = {"x": 0.5, "y": 0.45, "w": 0.7, "h": 0.45}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "player",
        p,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_sounds(
    sounds: list[SoundSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for s in sounds:
      geom_key = (s.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((s.id, "home")) or geom_map.get((s.id, ""))
      space = force_space or (
        "screen" if getattr(s, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.7, "h": 0.45}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.45}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "sound",
        s,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )
  def add_pressures(
    pressures: list[PressureSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for p in pressures:
      geom_key = (p.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((p.id, "home")) or geom_map.get((p.id, ""))
      space = force_space or (
        "screen" if getattr(p, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.6}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.6}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "pressure",
        p,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_spectra(
    spectra: list[SpectrumSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for s in spectra:
      geom_key = (s.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((s.id, "home")) or geom_map.get((s.id, ""))
      space = force_space or (
        "screen" if getattr(s, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.7, "h": 0.45}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.45}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "spectrum",
        s,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )
  def add_timers(
    timers: list[TimerSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for t in timers:
      geom_key = (t.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((t.id, "home")) or geom_map.get((t.id, ""))
      space = force_space or (
        "screen" if getattr(t, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.7, "h": 0.45}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.45}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "timer",
        t,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_experiments(
    experiments: list[ExperimentSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for e in experiments:
      geom_key = (e.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((e.id, "home")) or geom_map.get((e.id, ""))
      space = force_space or (
        "screen" if getattr(e, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.85, "h": 0.55}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.85, "h": 0.55}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "experiment",
        e,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_webcams(
    webcams: list[WebcamSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    aspect = design_h / max(1e-9, design_w)
    for i, w in enumerate(webcams):
      geom_key = (w.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((w.id, "home")) or geom_map.get((w.id, ""))
      space = force_space or (
        "screen" if getattr(w, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.7, "h": 0.45}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.7, "h": 0.45}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if space == "screen":
        if max(abs(base_x), abs(base_y), abs(base_w), abs(base_h)) > 2:
          base_x = base_x / design_w
          base_w = base_w / design_w
          base_y = base_y / design_h
          base_h = base_h / design_h
      if space == "world":
        gx, gy, gw, gh = _map_view_to_world(cam, base_x, base_y, base_w, base_h)
      else:
        gx = base_x
        gy = base_y
        gw = base_w
        gh = base_h
      _compile_builtin_group(
        "webcam",
        w,
        transform={
          "x": gx,
          "y": gy,
          "w": gw,
          "h": gh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )

  def add_cameras(
    cameras: list[CameraSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    for c in cameras:
      geom_key = (c.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((c.id, "home")) or geom_map.get((c.id, ""))
      space = force_space or (
        "screen" if getattr(c, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      if force_space is None and view_id and view_id != "screen_main":
        space = "world"
      default_screen = {"x": 0.5, "y": 0.4, "w": 0.28, "h": 0.22}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.28, "h": 0.22}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
        "id": c.id,
        "type": "camera",
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
      }
      if c.device_id:
        n["deviceId"] = c.device_id
      if c.bg_color:
        n["bgColor"] = c.bg_color
      if c.bg_alpha is not None:
        n["bgAlpha"] = c.bg_alpha
      if c.bg_padding is not None:
        n["bgPadding"] = c.bg_padding
      if c.bg_radius is not None:
        n["bgRadius"] = c.bg_radius
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(c.id)
      if anim:
        n.update(anim)
      if layer:
        n["layer"] = layer
      nodes.append(n)

  def add_groups(
    groups: list[GroupSpec],
    geom_map: dict[str, Any],
    *,
    layer: str | None,
    force_space: str | None = None,
    view_id: str | None = None,
    screen_id: str | None = None
  ) -> None:
    start_idx = len(nodes)
    for i, gspec in enumerate(groups):
      geom_key = (gspec.id, view_id or "home")
      g = geom_map.get(geom_key) or geom_map.get((gspec.id, "home")) or geom_map.get((gspec.id, ""))
      space = force_space or (
        "screen" if getattr(gspec, "space", "world") == "screen" else ((getattr(g, "space", None) or "world") if g else "world")
      )
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
        "id": gspec.id,
        "type": "group",
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
      }
      if view_id and space != "screen":
        n["viewId"] = view_id
      anim = animations.get(gspec.id)
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
      default_screen = {"x": 0.5, "y": 0.5, "w": 0.22, "h": 0.22}
      default_world = {"x": 0.5, "y": 0.5, "w": 0.22, "h": 0.22}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
      if base_w > 0 and g is None:
        base_h = base_w
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
      _compile_builtin_group(
        "join",
        j,
        transform={
          "x": xw,
          "y": yw,
          "w": ww,
          "h": hh,
          "rotationDeg": (g.rotationDeg if g else 0),
          "anchor": (g.anchor if g else "centerCenter"),
        },
        space=space,
        view_id=view_id,
        layer=layer,
      )
      anim = animations.get(j.id)
      if anim:
        nodes[-1].update(anim)

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
      default_world = {"x": 0.5, "y": 0.5, "w": 0.3, "h": 0.12}
      defaults = default_screen if space == "screen" else default_world
      cam = view_cameras.get(view_id or "", {"cx": 0.0, "cy": 0.0, "zoom": 1.0}) if view_id else {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
      base_x = float(g.x if g else defaults["x"])
      base_y = float(g.y if g else defaults["y"])
      base_w = float(g.w if g else defaults["w"])
      base_h = float(g.h if g else defaults["h"])
      base_w, base_h = apply_default_size_scale(g, base_w, base_h)
      base_x, base_y, base_w, base_h = normalize_authored_units(base_x, base_y, base_w, base_h, space)
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
        if space == "world":
          sxw, syw = _map_view_point_to_world(cam, start_pt[0], start_pt[1])
          exw, eyw = _map_view_point_to_world(cam, end_pt[0], end_pt[1])
          start_world = {"x": sxw, "y": syw}
          end_world = {"x": exw, "y": eyw}
        else:
          start_world = {"x": start_pt[0], "y": start_pt[1]}
          end_world = {"x": end_pt[0], "y": end_pt[1]}
      else:
        if g:
          sx, sy, ex, ey = float(g.x), float(g.y), float(g.w), float(g.h)
        else:
          sx, sy, ex, ey = 0.35, 0.5, 0.65, 0.5
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
      if getattr(a, "bg_padding", None) is not None:
        n["bgPadding"] = a.bg_padding
      if getattr(a, "bg_radius", None) is not None:
        n["bgRadius"] = a.bg_radius
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
  for frame in spec.iframes:
    add_iframes([frame], geoms, layer=None, view_id=frame.view_id or "home")
  for v in spec.videos:
    add_videos([v], geoms, layer=None, view_id=v.view_id or "home")
  for a in spec.axes:
    add_axes([a], geoms, layer=None, view_id=a.view_id or "home")
  for s in spec.sliders:
    add_sliders([s], geoms, layer=None, view_id=s.view_id or "home")
  for p in spec.players:
    add_players([p], geoms, layer=None, view_id=p.view_id or "home")
  for w in spec.webcams:
    add_webcams([w], geoms, layer=None, view_id=w.view_id or "home")
  for s in spec.sounds:
    add_sounds([s], geoms, layer=None, view_id=s.view_id or "home")
  for p in spec.pressures:
    add_pressures([p], geoms, layer=None, view_id=p.view_id or "home")
  for s in spec.spectra:
    add_spectra([s], geoms, layer=None, view_id=s.view_id or "home")
  for t in spec.timers:
    add_timers([t], geoms, layer=None, view_id=t.view_id or "home")
  for t in spec.tables:
    add_tables([t], geoms, layer=None, view_id=t.view_id or "home")
  for e in spec.experiments:
    add_experiments([e], geoms, layer=None, view_id=e.view_id or "home")
  for m in spec.multichoices:
    add_multichoices([m], geoms, layer=None, view_id=m.view_id or "home")
  for w in spec.wheels:
    add_wheels([w], geoms, layer=None, view_id=w.view_id or "home")
  for btn in spec.buttons:
    add_buttons([btn], geoms, layer=None, view_id=btn.view_id or "home")
  for c in spec.cameras:
    add_cameras([c], geoms, layer=None, view_id=c.view_id or "home")
  for g in spec.groups:
    add_groups([g], geoms, layer=None, view_id=g.view_id or "home")
  for screen in spec.screens:
    add_texts(screen.texts, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_bullets(screen.bullets, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_arrows(screen.arrows, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_joins(screen.joins, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_images(screen.images, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_iframes(screen.iframes, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_videos(screen.videos, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_cameras(screen.cameras, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_axes(screen.axes, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_sliders(screen.sliders, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_players(screen.players, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_webcams(screen.webcams, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_sounds(screen.sounds, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_pressures(screen.pressures, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_spectra(screen.spectra, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_timers(screen.timers, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_tables(screen.tables, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_experiments(screen.experiments, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_multichoices(screen.multichoices, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_wheels(screen.wheels, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_buttons(screen.buttons, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)
    add_groups(screen.groups, geoms, layer=None, force_space="screen", screen_id=screen.id, view_id=screen.id)

  apply_z_index_for_nodes(nodes, geoms)

  # Group children: load from groups/<id>/elements.pr + geometries.csv + animations.csv
  groups_dir = base / "groups"
  if groups_dir.exists():
    for group_node in [n for n in nodes if n.get("type") == "group"]:
      if str(group_node.get("multichoiceRole", "") or "") == "wheel-group":
        continue
      synthetic_group_root = any(
        str(group_node.get(key, "") or "").strip() == str(group_node.get("id", "") or "").strip()
        for key in ("soundId", "pressureId", "timerId", "experimentId", "multichoiceId", "playerId", "webcamId")
      )
      if synthetic_group_root:
        continue
      gid = str(group_node.get("id", "")).strip()
      if not gid:
        continue
      group_dir = groups_dir / gid
      elements_pr = group_dir / "elements.pr"
      if not elements_pr.exists():
        continue
      group_spec = parse_presentation_pr(elements_pr)
      group_geoms = load_geometries_csv(group_dir / "geometries.csv")
      group_anims, group_cues = _parse_animations_csv(group_dir / "animations.csv")
      animations.update(group_anims)
      animation_cues.extend(group_cues)

      group_texts = list(group_spec.texts)
      group_bullets = list(group_spec.bullets)
      group_arrows = list(group_spec.arrows)
      group_joins = list(group_spec.joins)
      group_images = list(group_spec.images)
      group_iframes = list(group_spec.iframes)
      group_videos = list(group_spec.videos)
      group_cameras = list(group_spec.cameras)
      group_buttons = list(group_spec.buttons)
      group_sliders = list(group_spec.sliders)
      group_players = list(group_spec.players)
      group_webcams = list(group_spec.webcams)
      group_sounds = list(group_spec.sounds)
      group_pressures = list(group_spec.pressures)
      group_spectra = list(group_spec.spectra)
      group_timers = list(group_spec.timers)
      group_tables = list(group_spec.tables)
      group_experiments = list(group_spec.experiments)
      group_multichoices = list(group_spec.multichoices)
      group_wheels = list(group_spec.wheels)
      for scr in group_spec.screens:
        group_texts.extend(scr.texts)
        group_bullets.extend(scr.bullets)
        group_arrows.extend(scr.arrows)
        group_joins.extend(scr.joins)
        group_images.extend(scr.images)
        group_iframes.extend(scr.iframes)
        group_videos.extend(scr.videos)
        group_cameras.extend(scr.cameras)
        group_buttons.extend(scr.buttons)
        group_sliders.extend(scr.sliders)
        group_players.extend(scr.players)
        group_webcams.extend(scr.webcams)
        group_sounds.extend(scr.sounds)
        group_pressures.extend(scr.pressures)
        group_spectra.extend(scr.spectra)
        group_timers.extend(scr.timers)
        group_tables.extend(scr.tables)
        group_experiments.extend(scr.experiments)
        group_multichoices.extend(scr.multichoices)
        group_wheels.extend(scr.wheels)

      start_idx = len(nodes)
      if group_texts:
        add_texts(group_texts, group_geoms, layer=None, force_space="group", view_id="group")
      if group_bullets:
        add_bullets(group_bullets, group_geoms, layer=None, force_space="group", view_id="group")
      if group_arrows:
        add_arrows(group_arrows, group_geoms, layer=None, force_space="group", view_id="group")
      if group_joins:
        add_joins(group_joins, group_geoms, layer=None, force_space="group", view_id="group")
      if group_images:
        add_images(group_images, group_geoms, layer=None, force_space="group", view_id="group")
      if group_iframes:
        add_iframes(group_iframes, group_geoms, layer=None, force_space="group", view_id="group")
      if group_videos:
        add_videos(group_videos, group_geoms, layer=None, force_space="group", view_id="group")
      if group_cameras:
        add_cameras(group_cameras, group_geoms, layer=None, force_space="group", view_id="group")
      if group_buttons:
        add_buttons(group_buttons, group_geoms, layer=None, force_space="group", view_id="group")
      if group_sliders:
        add_sliders(group_sliders, group_geoms, layer=None, force_space="group", view_id="group")
      if group_players:
        add_players(group_players, group_geoms, layer=None, force_space="group", view_id="group")
      if group_webcams:
        add_webcams(group_webcams, group_geoms, layer=None, force_space="group", view_id="group")
      if group_sounds:
        add_sounds(group_sounds, group_geoms, layer=None, force_space="group", view_id="group")
      if group_pressures:
        add_pressures(group_pressures, group_geoms, layer=None, force_space="group", view_id="group")
      if group_spectra:
        add_spectra(group_spectra, group_geoms, layer=None, force_space="group", view_id="group")
      if group_timers:
        add_timers(group_timers, group_geoms, layer=None, force_space="group", view_id="group")
      if group_tables:
        add_tables(group_tables, group_geoms, layer=None, force_space="group", view_id="group")
      if group_experiments:
        add_experiments(group_experiments, group_geoms, layer=None, force_space="group", view_id="group")
      if group_multichoices:
        add_multichoices(group_multichoices, group_geoms, layer=None, force_space="group", view_id="group")
      if group_wheels:
        add_wheels(group_wheels, group_geoms, layer=None, force_space="group", view_id="group")

      apply_z_index_for_nodes(nodes[start_idx:], group_geoms, view_id_override="group")

      group_space = str(group_node.get("space", "world") or "world")
      group_view = group_node.get("viewId")
      group_screen = group_node.get("screenId")
      group_t = group_node.get("transform") or {}
      group_w = float(group_t.get("w", 0.0) or 0.0)
      group_h = float(group_t.get("h", 0.0) or 0.0)
      scale_w = max(1e-9, group_w)
      scale_h = max(1e-9, group_h)
      group_rot = float(group_t.get("rotationDeg", 0.0) or 0.0)

      composite_role_map = {
        "sound": {
          "_axis": "axis",
          "_buttons": "buttons",
          "_mode_buttons": "mode-buttons",
          "_threshold": "threshold",
          "_x_label": "label",
          "_y_label": "label",
          "_peak": "label",
        },
        "pressure": {
          "_axis": "axis",
          "_buttons": "buttons",
          "_threshold": "threshold",
          "_x_label": "label",
          "_y_label": "label",
          "_peak": "label",
          "_table": "table",
        },
        "timer": {
          "_axis": "axis",
          "_buttons": "buttons",
          "_x_label": "label",
          "_y_label": "label",
          "_value": "label",
        },
        "experiment": {
          "_table": "table",
          "_axis": "axis",
          "_title": "title",
          "_x_label": "x-label",
          "_y_label": "y-label",
          "_fit_label": "fit-label",
          "_x_buttons": "x-buttons",
          "_y_buttons": "y-buttons",
          "_t_buttons": "t-buttons",
          "_fit_button": "fit-button",
          "_clear_button": "clear-button",
        },
        "multichoice": {
          "_wheel_canvas": "wheel",
          "_question": "question",
          "_answers": "answers",
          "_buttons": "buttons",
        },
      }
      for child in nodes[start_idx:]:
        child["groupId"] = gid
        child["space"] = group_space
        child_id = str(child.get("id", "") or "")
        for key, value in group_node.items():
          if key == "groupId" or not key.endswith("Id"):
            continue
          if value is None:
            continue
          if child.get(key) is None:
            child[key] = value
          comp_type = key[:-2]
          role_map = composite_role_map.get(comp_type)
          if role_map:
            for suffix, role in role_map.items():
              if child_id == f"{value}{suffix}":
                child[f"{comp_type}Role"] = role
        if group_space == "world":
          if group_view:
            child["viewId"] = group_view
        else:
          child.pop("viewId", None)
          if group_screen:
            child["screenId"] = group_screen
        if child.get("type") == "arrow":
          start_world = _group_local_to_world(group_t, child.get("start", {"x": 0.0, "y": 0.5}))
          end_world = _group_local_to_world(group_t, child.get("end", {"x": 1.0, "y": 0.5}))
          child["start"] = start_world
          child["end"] = end_world
          min_x = min(start_world["x"], end_world["x"])
          min_y = min(start_world["y"], end_world["y"])
          max_x = max(start_world["x"], end_world["x"])
          max_y = max(start_world["y"], end_world["y"])
          child["transform"] = {
            "x": min_x,
            "y": min_y,
            "w": max(1e-9, max_x - min_x),
            "h": max(1e-9, max_y - min_y),
            "rotationDeg": 0,
            "anchor": "topLeft",
          }
        else:
          lt = child.get("transform") or {}
          local_x = float(lt.get("x", 0.0))
          local_y = float(lt.get("y", 0.0))
          anchor_world = _group_local_to_world(group_t, {"x": local_x, "y": local_y})
          child["transform"] = {
            **lt,
            "x": anchor_world["x"],
            "y": anchor_world["y"],
            "w": float(lt.get("w", 0.0)) * scale_w,
            "h": float(lt.get("h", 0.0)) * scale_h,
            "rotationDeg": float(lt.get("rotationDeg", 0.0) or 0.0) + group_rot,
          }
      # If group children collide with root ids, keep the group versions.
      child_ids = {str(n.get("id", "")) for n in nodes[start_idx:]}
      if child_ids:
        pruned: list[dict[str, Any]] = []
        for idx, node in enumerate(nodes):
          node_id = str(node.get("id", ""))
          if idx < start_idx and node.get("type") != "group" and node_id in child_ids:
            continue
          pruned.append(node)
        nodes = pruned

  def _rect_from_transform(t: dict[str, Any]) -> tuple[float, float, float, float] | None:
    if not t:
      return None
    w = float(t.get("w", 0.0) or 0.0)
    h = float(t.get("h", 0.0) or 0.0)
    if w <= 0 or h <= 0:
      return None
    anchor = str(t.get("anchor") or "centerCenter")
    ax, ay = _anchor_frac(anchor)
    x = float(t.get("x", 0.0) or 0.0)
    y = float(t.get("y", 0.0) or 0.0)
    min_x = x - ax * w
    min_y = y - ay * h
    return (min_x, min_y, min_x + w, min_y + h)

  def _normalize_group_locals() -> None:
    groups_by_id = {str(n.get("id", "")): n for n in nodes if n.get("type") == "group"}
    children_by_group: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
      gid = str(n.get("groupId", "") or "")
      if gid and "groupLocal" in n:
        children_by_group.setdefault(gid, []).append(n)

    for gid, kids in children_by_group.items():
      group_node = groups_by_id.get(gid)
      if not group_node:
        continue
      group_t = group_node.get("transform") or {}
      group_w = float(group_t.get("w", 0.0) or 0.0)
      group_h = float(group_t.get("h", 0.0) or 0.0)
      group_rot = float(group_t.get("rotationDeg", 0.0) or 0.0)

      normalized: list[tuple[dict[str, Any], dict[str, Any]]] = []
      for child in kids:
        local_t = _normalize_local_top_left(dict(child.get("groupLocal") or {}))
        normalized.append((child, local_t))

      for child, local_t in normalized:
        local_x = float(local_t.get("x", 0.0))
        local_y = float(local_t.get("y", 0.0))
        anchor_world = _group_local_to_world(group_t, {"x": local_x, "y": local_y})
        child["groupLocal"] = local_t
        child["transform"] = {
          **local_t,
          "x": anchor_world["x"],
          "y": anchor_world["y"],
          "w": float(local_t.get("w", 0.0)) * max(1e-9, group_w),
          "h": float(local_t.get("h", 0.0)) * max(1e-9, group_h),
          "rotationDeg": float(local_t.get("rotationDeg", 0.0) or 0.0) + group_rot,
        }

  _normalize_group_locals()
  if notes_spec is not None:
    for t in notes_spec.texts:
      add_texts([t], notes_geoms, layer="live", view_id=t.view_id or "home")

  def _merge_view_refs(nodes_in: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes_in:
      node_id = str(n.get("id", "") or "")
      if not node_id:
        continue
      existing = by_id.get(node_id)
      if not existing:
        out.append(n)
        by_id[node_id] = n
        continue
      if "viewId" in n and n.get("viewId") is not None:
        existing.setdefault("viewIds", [])
        if existing.get("viewId") and existing.get("viewId") not in existing["viewIds"]:
          existing["viewIds"].append(existing["viewId"])
        if n.get("viewId") not in existing["viewIds"]:
          existing["viewIds"].append(n.get("viewId"))
      if "screenId" in n and n.get("screenId") is not None:
        existing.setdefault("screenIds", [])
        if existing.get("screenId") and existing.get("screenId") not in existing["screenIds"]:
          existing["screenIds"].append(existing["screenId"])
        if n.get("screenId") not in existing["screenIds"]:
          existing["screenIds"].append(n.get("screenId"))
    return out

  def _seed_group_files() -> None:
    groups_dir = base / "groups"
    groups_dir.mkdir(parents=True, exist_ok=True)
    geom_header = ["id", "view", "space", "zIndex", "x", "y", "w", "h", "rotationDeg", "anchor", "fontPx"]
    def _encode_text(s: str) -> str:
      return s.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    def _format_list(items: list[Any]) -> str:
      return "[" + ", ".join(_encode_text(str(x)) for x in items) + "]"
    def _format_map(items: list[tuple[Any, Any]]) -> str:
      parts: list[str] = []
      for k, v in items:
        parts.append(f"{_encode_text(str(k))}:{_encode_text(str(v))}")
      return "{" + ", ".join(parts) + "}"
    def _build_attrs(attrs: dict[str, Any]) -> str:
      parts: list[str] = []
      for key, val in attrs.items():
        if val is None:
          continue
        if isinstance(val, str):
          trimmed = val.strip()
          if trimmed.startswith(("[", "{", "(")):
            parts.append(f"{key}={trimmed}")
          else:
            parts.append(f"{key}={_encode_text(val)}")
        else:
          parts.append(f"{key}={val}")
      return ", ".join(parts)
    def _build_element_lines(child: dict[str, Any]) -> list[str]:
      etype = str(child.get("type", "") or "")
      eid = str(child.get("id", "") or "")
      if not etype or not eid:
        return []
      attrs: dict[str, Any] = {"id": eid}
      # Common styling/visibility properties every element may carry.
      if child.get("visible") is not None:
        attrs["visible"] = "true" if child.get("visible") else "false"
      if child.get("opacity") is not None:
        attrs["opacity"] = child.get("opacity")
      if child.get("bgColor"):
        attrs["bgColor"] = child.get("bgColor")
      if child.get("bgAlpha") is not None:
        attrs["bgAlpha"] = child.get("bgAlpha")
      if child.get("bgPadding") is not None:
        attrs["bgPadding"] = child.get("bgPadding")
      if child.get("bgRadius") is not None:
        attrs["bgRadius"] = child.get("bgRadius")
      if child.get("color"):
        attrs["color"] = child.get("color")
      lines: list[str] = []
      if etype == "axis":
        limits = child.get("limits") or {}
        attrs.update(
          {
            "xMin": limits.get("xMin"),
            "xMax": limits.get("xMax"),
            "yMin": limits.get("yMin"),
            "yMax": limits.get("yMax"),
            "clamp": child.get("clamp"),
            "padPx": child.get("padPx"),
            "maxPoints": child.get("maxPoints"),
          }
        )
        if child.get("bins"):
          attrs["bins"] = _format_list(child.get("bins"))
      elif etype == "buttons":
        labels = list(child.get("templates") or child.get("labels") or [])
        actions = list(child.get("actions") or [])
        items: list[tuple[Any, Any]] = []
        for idx, label in enumerate(labels):
          action = actions[idx] if idx < len(actions) else ""
          items.append((label, action))
        attrs["items"] = _format_map(items)
        mode = child.get("buttonsMode")
        if mode:
          attrs["type"] = mode
        if child.get("rows") is not None:
          attrs["rows"] = child.get("rows")
        if child.get("cols") is not None:
          attrs["cols"] = child.get("cols")
        if child.get("hSplits"):
          attrs["hSplits"] = _format_list(child.get("hSplits"))
        if child.get("vSplits"):
          attrs["vSplits"] = _format_list(child.get("vSplits"))
      elif etype == "slider":
        values = child.get("values")
        if isinstance(values, list) and values:
          attrs["values"] = "(" + ",".join(str(x) for x in values) + ")"
        else:
          attrs["min"] = child.get("min")
          attrs["max"] = child.get("max")
          attrs["step"] = child.get("step")
          if child.get("min") is not None and child.get("max") is not None and child.get("step") is not None:
            attrs["values"] = f"{child.get('min')}:{child.get('step')}:{child.get('max')}"
        if child.get("value") is not None:
          attrs["value"] = child.get("value")
        if child.get("orientation"):
          attrs["orientation"] = child.get("orientation")
      elif etype == "bullets":
        align = child.get("align")
        if align:
          attrs["align"] = align
        bullets_type = child.get("bullets")
        if bullets_type:
          attrs["type"] = bullets_type
        text = child.get("template") if child.get("template") is not None else child.get("rawText")
        content = str(text or "")
        if "\n" in content:
          lines.append(f"bullets[{_build_attrs(attrs)}]:")
          for row in content.splitlines():
            lines.append(_encode_text(row))
          lines.append("")
        elif content:
          lines.append(f"bullets[{_build_attrs(attrs)}]: {_encode_text(content)}")
        else:
          lines.append(f"bullets[{_build_attrs(attrs)}]")
        return lines
      elif etype == "text":
        align = child.get("align")
        if align:
          attrs["align"] = align
        text = child.get("template") if child.get("template") is not None else child.get("text", "")
        content = _encode_text(str(text or ""))
        lines.append(f"text[{_build_attrs(attrs)}]: {content}")
        return lines
      elif etype == "table":
        if child.get("rows") is not None:
          attrs["rows"] = child.get("rows")
        if child.get("cols") is not None:
          attrs["cols"] = child.get("cols")
        if child.get("editable") is not None:
          attrs["editable"] = "true" if child.get("editable") else "false"
        if child.get("hHeader"):
          attrs["hHeader"] = _format_list(child.get("hHeader"))
        if child.get("vHeader"):
          attrs["vHeader"] = _format_list(child.get("vHeader"))
        if child.get("hStyle"):
          attrs["hStyle"] = _format_list(child.get("hStyle"))
        if child.get("color"):
          attrs["color"] = child.get("color")
        if child.get("bgColor"):
          attrs["bgColor"] = child.get("bgColor")
        if child.get("bgAlpha") is not None:
          attrs["bgAlpha"] = child.get("bgAlpha")
        if child.get("bgPadding") is not None:
          attrs["bgPadding"] = child.get("bgPadding")
        if child.get("bgRadius") is not None:
          attrs["bgRadius"] = child.get("bgRadius")
        lines.append(f"table[{_build_attrs(attrs)}]:")
        cells = child.get("cells") or []
        for row in cells:
          if isinstance(row, list):
            lines.append(";".join(_encode_text(str(x)) for x in row))
        lines.append("")
        return lines
      elif etype == "video":
        if child.get("src"):
          attrs["src"] = child.get("src")
        if child.get("playLabel"):
          attrs["playLabel"] = child.get("playLabel")
        if child.get("pauseLabel"):
          attrs["pauseLabel"] = child.get("pauseLabel")
        if child.get("thumbnail"):
          attrs["thumbnail"] = child.get("thumbnail")
        if child.get("poster"):
          attrs["poster"] = child.get("poster")
      elif etype == "camera":
        if child.get("deviceId"):
          attrs["deviceId"] = child.get("deviceId")
      elif etype == "multichoice":
        if child.get("answers"):
          answers = []
          for ans in child.get("answers") or []:
            answers.append((ans.get("name", ""), ans.get("color", "")))
          attrs["answers"] = _format_map(answers)
        if child.get("choiceType"):
          attrs["type"] = child.get("choiceType")
        if child.get("otherLabel"):
          attrs["otherLabel"] = child.get("otherLabel")
        if child.get("otherLimit") is not None:
          attrs["otherLimit"] = child.get("otherLimit")
      line = f"{etype}[{_build_attrs(attrs)}]"
      lines.append(line)
      return lines
    def _extract_id(line: str) -> str | None:
      stripped = line.strip()
      if not stripped or stripped.startswith("#") or "[" not in stripped or "]" not in stripped:
        return None
      head = stripped.split(":", 1)[0]
      inner = head[head.find("[") + 1 : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      elem_id = str(kv.get("id", "") or kv.get("name", "")).strip()
      return elem_id or None
    for group_node in [n for n in nodes if n.get("type") == "group"]:
      gid = str(group_node.get("id", "") or "").strip()
      if not gid:
        continue
      group_dir = groups_dir / gid
      group_dir.mkdir(parents=True, exist_ok=True)
      elements_pr = group_dir / "elements.pr"
      geoms_csv = group_dir / "geometries.csv"
      anims_csv = group_dir / "animations.csv"
      if not anims_csv.exists():
        anims_csv.write_text("id,what,when,how,where,delayMs\n", encoding="utf-8")
      children = [
        c
        for c in nodes
        if str(c.get("groupId", "") or "") == gid and isinstance(c.get("groupLocal"), dict)
      ]
      if not children:
        continue
      children_by_id = {str(c.get("id", "")): c for c in children if str(c.get("id", ""))}
      elements_lines = elements_pr.read_text(encoding="utf-8").splitlines() if elements_pr.exists() else []
      elements_ids = [eid for eid in (_extract_id(line) for line in elements_lines) if eid]
      elements_empty = not elements_ids
      geoms_rows: list[dict[str, Any]] = []
      if geoms_csv.exists():
        with geoms_csv.open("r", encoding="utf-8", newline="") as f:
          reader = csv.DictReader(f)
          for row in reader:
            if str(row.get("id", "") or "").strip():
              geoms_rows.append(row)
      geoms_empty = len(geoms_rows) == 0

      if elements_empty:
        elements_ids = sorted(children_by_id.keys())
        lines: list[str] = []
        for eid in elements_ids:
          lines.extend(_build_element_lines(children_by_id[eid]))
        elements_pr.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
      if geoms_empty:
        with geoms_csv.open("w", encoding="utf-8", newline="") as f:
          writer = csv.DictWriter(f, fieldnames=geom_header)
          writer.writeheader()
          for eid in elements_ids:
            child = children_by_id.get(eid)
            if not child:
              raise ValueError(f"Group '{gid}' has element '{eid}' with no matching node for geometry.")
            local_t = child.get("groupLocal") or {}
            writer.writerow(
              {
                "id": eid,
                "view": "group",
                "space": "group",
                "zIndex": int(child.get("zIndex", 0) or 0),
                "x": float(local_t.get("x", 0.0) or 0.0),
                "y": float(local_t.get("y", 0.0) or 0.0),
                "w": float(local_t.get("w", 0.0) or 0.0),
                "h": float(local_t.get("h", 0.0) or 0.0),
                "rotationDeg": float(local_t.get("rotationDeg", 0.0) or 0.0),
                "anchor": str(local_t.get("anchor", "centerCenter") or "centerCenter"),
                "fontPx": "" if child.get("fontPx") is None else child.get("fontPx"),
              }
            )

      geoms_ids = {str(row.get("id", "")).strip() for row in geoms_rows if str(row.get("id", "")).strip()}
      if elements_ids and geoms_ids and set(elements_ids) != geoms_ids:
        # Auto-sync geometries to elements to avoid hard failures on mismatch.
        rows_by_id = {str(row.get("id", "")).strip(): row for row in geoms_rows if str(row.get("id", "")).strip()}
        with geoms_csv.open("w", encoding="utf-8", newline="") as f:
          writer = csv.DictWriter(f, fieldnames=geom_header)
          writer.writeheader()
          for eid in elements_ids:
            row = rows_by_id.get(eid)
            if row:
              writer.writerow(row)
              continue
            child = children_by_id.get(eid)
            if not child:
              raise ValueError(f"Group '{gid}' has element '{eid}' with no matching node for geometry.")
            local_t = child.get("groupLocal") or {}
            writer.writerow(
              {
                "id": eid,
                "view": "group",
                "space": "group",
                "x": float(local_t.get("x", 0.0) or 0.0),
                "y": float(local_t.get("y", 0.0) or 0.0),
                "w": float(local_t.get("w", 0.0) or 0.0),
                "h": float(local_t.get("h", 0.0) or 0.0),
                "rotationDeg": float(local_t.get("rotationDeg", 0.0) or 0.0),
                "anchor": str(local_t.get("anchor", "centerCenter") or "centerCenter"),
                "fontPx": "" if child.get("fontPx") is None else child.get("fontPx"),
              }
            )

  _seed_group_files()
  nodes = _merge_view_refs(nodes)
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

  screen_space = "normalized"
  defaults_out: dict[str, Any] = {
    "designWidth": design_w,
    "designHeight": design_h,
    "grid": {"enabled": True},
    "screenSpace": screen_space,
  }
  if "viewTransitionMs" in defaults_cfg:
    defaults_out["viewTransitionMs"] = defaults_cfg["viewTransitionMs"]
  if "pixelateSteps" in defaults_cfg:
    defaults_out["pixelateSteps"] = defaults_cfg["pixelateSteps"]
  if "publicBaseUrl" in defaults_cfg:
    defaults_out["publicBaseUrl"] = defaults_cfg["publicBaseUrl"]
  return {
    "defaults": defaults_out,
    "views": views,
    "nodes": nodes,
    "initialViewId": views[0]["id"] if views else "home",
    "animationCues": cues_with_view,
  }




