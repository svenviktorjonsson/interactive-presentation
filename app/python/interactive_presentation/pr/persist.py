from __future__ import annotations

import csv
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_lock = threading.Lock()


@dataclass(frozen=True)
class GeometryRow:
  id: str
  view: str
  # "world" => x/y/w/h are view-relative in normalized [0..1] units, origin top-left.
  # "screen" => x/y/w/h are relative (0..1 with origin bottom-left)
  space: str
  zIndex: int
  x: float
  y: float
  w: float
  h: float
  rotationDeg: float
  anchor: str
  fontPx: float | None = None


GEOM_HEADER = ["id", "view", "space", "zIndex", "x", "y", "w", "h", "rotationDeg", "anchor", "fontPx"]


def _decode_text_from_pr(s: str) -> str:
  # Minimal escaping: store newlines as literal \n in the .pr file.
  return s.replace("\\n", "\n")


def _encode_text_for_pr(s: str) -> str:
  return s.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")


def _split_attrs(inner: str) -> list[str]:
  parts: list[str] = []
  buf: list[str] = []
  depth = 0
  for ch in inner:
    if ch == "{":
      depth += 1
    elif ch == "}":
      depth = max(0, depth - 1)
    if ch == "," and depth == 0:
      part = "".join(buf).strip()
      if part:
        parts.append(part)
      buf = []
      continue
    buf.append(ch)
  tail = "".join(buf).strip()
  if tail:
    parts.append(tail)
  return parts


def _format_pr_list(items: list[str]) -> str:
  out: list[str] = []
  for raw in items:
    s = str(raw)
    needs_quote = (s == "") or ("," in s) or ("]" in s) or ("\n" in s) or ("\r" in s)
    if needs_quote:
      s = s.replace("'", "\\'")
      out.append(f"'{s}'")
    else:
      out.append(s)
  return "[" + ", ".join(out) + "]"


def load_geometries_csv(path: str | Path) -> dict[tuple[str, str], GeometryRow]:
  p = Path(path)
  if not p.exists():
    return {}
  out: dict[tuple[str, str], GeometryRow] = {}
  with p.open("r", encoding="utf-8", newline="") as f:
    r = csv.DictReader(f)
    for row in r:
      rid = str(row.get("id", "")).strip()
      if not rid:
        continue
      try:
        # Backwards compatible with older files that don't have `space`.
        space = str(row.get("space", "") or "world").strip() or "world"
        view = str(row.get("view", "") or "home").strip() or "home"
        z_index_raw = row.get("zIndex")
        z_index = int(float(z_index_raw)) if str(z_index_raw or "").strip() else 0
        out[(rid, view)] = GeometryRow(
          id=rid,
          view=view,
          space=space,
          zIndex=z_index,
          x=float(row.get("x", 0) or 0),
          y=float(row.get("y", 0) or 0),
          w=float(row.get("w", 0) or 0),
          h=float(row.get("h", 0) or 0),
          rotationDeg=float(row.get("rotationDeg", 0) or 0),
          anchor=str(row.get("anchor", "") or "centerCenter"),
          fontPx=float(row["fontPx"]) if str(row.get("fontPx", "")).strip() else None,
        )
      except Exception:
        # Ignore malformed rows; development should surface errors elsewhere.
        continue
  return out


def upsert_geometry_row(path: str | Path, geom: GeometryRow) -> None:
  p = Path(path)
  with _lock:
    rows = load_geometries_csv(p)
    rows[(geom.id, geom.view)] = geom
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8", newline="") as f:
      w = csv.DictWriter(f, fieldnames=GEOM_HEADER)
      w.writeheader()
      for key in sorted(rows.keys()):
        r = rows[key]
        w.writerow(
          {
            "id": r.id,
            "view": r.view,
            "space": getattr(r, "space", "world") or "world",
            "zIndex": getattr(r, "zIndex", 0) or 0,
            "x": r.x,
            "y": r.y,
            "w": r.w,
            "h": r.h,
            "rotationDeg": r.rotationDeg,
            "anchor": r.anchor,
            "fontPx": "" if r.fontPx is None else r.fontPx,
          }
        )


def delete_geometry_rows(path: str | Path, ids: list[str]) -> None:
  p = Path(path)
  with _lock:
    rows = load_geometries_csv(p)
    if ids:
      to_drop = {str(x) for x in ids}
      rows = {k: v for k, v in rows.items() if v.id not in to_drop}
    if not p.exists() and not rows:
      return
    with p.open("w", encoding="utf-8", newline="") as f:
      w = csv.DictWriter(f, fieldnames=GEOM_HEADER)
      w.writeheader()
      for key in sorted(rows.keys()):
        r = rows[key]
        w.writerow(
          {
            "id": r.id,
            "view": r.view,
            "space": getattr(r, "space", "world") or "world",
            "zIndex": getattr(r, "zIndex", 0) or 0,
            "x": r.x,
            "y": r.y,
            "w": r.w,
            "h": r.h,
            "rotationDeg": r.rotationDeg,
            "anchor": r.anchor,
            "fontPx": "" if r.fontPx is None else r.fontPx,
          }
        )


def ensure_group_files(group_dir: str | Path) -> None:
  p = Path(group_dir)
  p.mkdir(parents=True, exist_ok=True)
  elements = p / "elements.pr"
  if not elements.exists():
    elements.write_text("", encoding="utf-8")
  geoms = p / "geometries.csv"
  if not geoms.exists():
    with geoms.open("w", encoding="utf-8", newline="") as f:
      w = csv.DictWriter(f, fieldnames=GEOM_HEADER)
      w.writeheader()
  anims = p / "animations.csv"
  if not anims.exists():
    anims.write_text("id,what,when,how,where,delayMs\n", encoding="utf-8")


def upsert_text_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  text_id: str,
  text: str,
  align: str | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_text_id(line: str, tid: str) -> bool:
    if not line.startswith("text[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == tid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None
  def _skip_block(lines: list[str], start_idx: int) -> int:
    j = start_idx + 1
    saw_body = False
    while j < len(lines):
      nxt_raw = lines[j]
      nxt = nxt_raw.strip()
      if not nxt:
        if saw_body:
          j += 1
          break
        j += 1
        continue
      if nxt.startswith("#"):
        j += 1
        continue
      if nxt.startswith(("view[", "text[", "image[", "bullets[", "sound[")) and "]" in nxt:
        break
      saw_body = True
      j += 1
    return j
  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    in_view = False
    saw_view = False
    replaced = False
    params = [f"id={text_id}"]
    align_norm = str(align or "").strip().lower()
    if align_norm in {"left", "center", "right"}:
      params.append(f"align={align_norm}")
    if bg_color:
      params.append(f"bgColor={bg_color}")
    if bg_alpha is not None:
      params.append(f"bgAlpha={bg_alpha}")
    if bg_padding is not None:
      params.append(f"bgPadding={bg_padding}")
    if bg_radius is not None:
      params.append(f"bgRadius={bg_radius}")
    target_head = f"text[{', '.join(params)}]"
    view_head = f"view[id={view_id}]:"
    insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
    if insert_before_view:
      i = 0
      while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if _line_matches_text_id(line, text_id):
          out.append(f"{target_head}: {_encode_text_for_pr(text)}")
          replaced = True
          head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
          if not body.strip():
            i = _skip_block(lines, i)
            continue
          i += 1
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(f"{target_head}: {_encode_text_for_pr(text)}")
            replaced = True
          out.append(raw)
          out.extend(lines[i + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
        i += 1
      if not replaced:
        out.append(f"{target_head}: {_encode_text_for_pr(text)}")
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return
    i = 0
    while i < len(lines):
      raw = lines[i]
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        i += 1
        continue
      if in_view and line.startswith("text[") and "]" in line and ":" in line and _line_matches_text_id(line, text_id):
        out.append(f"{target_head}: {_encode_text_for_pr(text)}")
        replaced = True
        head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
        if not body.strip():
          i = _skip_block(lines, i)
          continue
        i += 1
        continue
      out.append(raw)
      i += 1

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      # Append into the requested view if present, else at end.
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(f"{target_head}: {_encode_text_for_pr(text)}")
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(f"{target_head}: {_encode_text_for_pr(text)}")
        inserted_flag = True
      if not inserted_flag:
        inserted.append(f"{target_head}: {_encode_text_for_pr(text)}")
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_image_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  image_id: str,
  src: str | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_image_id(line: str, iid: str) -> bool:
    if not line.startswith("image[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    img_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return img_id == iid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False
    head = f"image[id={image_id}]"
    params: list[str] = [f"id={image_id}"]
    if src:
      params.append(f"src={src}")
    if bg_color:
      params.append(f"bgColor={bg_color}")
    if bg_alpha is not None:
      params.append(f"bgAlpha={bg_alpha}")
    if bg_padding is not None:
      params.append(f"bgPadding={bg_padding}")
    if bg_radius is not None:
      params.append(f"bgRadius={bg_radius}")
    image_line = f"image[{', '.join(params)}]"
    view_head = f"view[id={view_id}]:"
    insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
    if insert_before_view:
      for idx, raw in enumerate(lines):
        line = raw.strip()
        if _line_matches_image_id(line, image_id):
          out.append(image_line)
          replaced = True
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(image_line)
            replaced = True
          out.append(raw)
          out.extend(lines[idx + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
      if not replaced:
        out.append(image_line)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return
    for raw in lines:
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        continue
      if in_view and _line_matches_image_id(line, image_id):
        out.append(image_line)
        replaced = True
        continue
      out.append(raw)

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(image_line)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(image_line)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(image_line)
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_group_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  group_id: str,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_group_id(line: str, gid: str) -> bool:
    if not line.startswith("group[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == gid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False
    group_line = f"group[id={group_id}]"
    view_head = f"view[id={view_id}]:"
    insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
    if insert_before_view:
      for idx, raw in enumerate(lines):
        line = raw.strip()
        if _line_matches_group_id(line, group_id):
          out.append(group_line)
          replaced = True
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(group_line)
            replaced = True
          out.append(raw)
          out.extend(lines[idx + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
      if not replaced:
        out.append(group_line)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return
    for raw in lines:
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        continue
      if in_view and _line_matches_group_id(line, group_id):
        out.append(group_line)
        replaced = True
        continue
      out.append(raw)

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(group_line)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(group_line)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(group_line)
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def _format_element_value(value: Any) -> str | None:
  if value is None:
    return None
  if isinstance(value, bool):
    return "true" if value else "false"
  if isinstance(value, (int, float)):
    return str(value)
  if isinstance(value, (list, tuple)):
    return _format_pr_list([_encode_text_for_pr(str(x)) for x in value])
  if isinstance(value, dict):
    items: list[str] = []
    for k, v in value.items():
      items.append(f"{_encode_text_for_pr(str(k))}:{_encode_text_for_pr(str(v))}")
    return "{" + ", ".join(items) + "}"
  return _encode_text_for_pr(str(value))


def upsert_element_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  elem_type: str,
  elem_id: str,
  attrs: dict[str, Any] | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  if not elem_type:
    return
  tag = f"{elem_type}["
  def _line_matches_elem_id(line: str, eid: str) -> bool:
    if not line.startswith(tag) or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in _split_attrs(inner) if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == eid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None
  def _merge_params(line: str) -> dict[str, Any]:
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in _split_attrs(inner) if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    merged: dict[str, Any] = dict(kv)
    if attrs:
      for k, v in attrs.items():
        if v is None:
          continue
        merged[str(k)] = v
    merged["id"] = elem_id
    return merged
  def _build_line(merged: dict[str, Any]) -> str:
    params: list[str] = []
    params.append(f"id={elem_id}")
    for key in sorted(k for k in merged.keys() if k not in {"id", "name"}):
      val = _format_element_value(merged[key])
      if val is None or val == "":
        continue
      params.append(f"{key}={val}")
    return f"{elem_type}[{', '.join(params)}]"

  insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
  view_head = f"view[id={view_id}]:"

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False

    if insert_before_view:
      for idx, raw in enumerate(lines):
        line = raw.strip()
        if _line_matches_elem_id(line, elem_id):
          out.append(_build_line(_merge_params(line)))
          replaced = True
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(_build_line({"id": elem_id, **(attrs or {})}))
            replaced = True
          out.append(raw)
          out.extend(lines[idx + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
      if not replaced:
        out.append(_build_line({"id": elem_id, **(attrs or {})}))
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    for raw in lines:
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        continue
      if in_view and _line_matches_elem_id(line, elem_id):
        out.append(_build_line(_merge_params(line)))
        replaced = True
        continue
      out.append(raw)

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(_build_line({"id": elem_id, **(attrs or {})}))
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(_build_line({"id": elem_id, **(attrs or {})}))
        inserted_flag = True
      if not inserted_flag:
        inserted.append(_build_line({"id": elem_id, **(attrs or {})}))
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_arrow_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  arrow_id: str,
  color: str | None = None,
  stroke_px: float | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_arrow_id(line: str, aid: str) -> bool:
    if not line.startswith("arrow[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == aid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None

  params: list[str] = [f"id={arrow_id}"]
  if color and "," not in color:
    params.append(f"color={color}")
  if stroke_px is not None:
    params.append(f"strokePx={stroke_px}")
  if bg_color:
    params.append(f"bgColor={bg_color}")
  if bg_alpha is not None:
    params.append(f"bgAlpha={bg_alpha}")
  if bg_padding is not None:
    params.append(f"bgPadding={bg_padding}")
  if bg_radius is not None:
    params.append(f"bgRadius={bg_radius}")
  arrow_line = f"arrow[{', '.join(params)}]"
  insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
  view_head = f"view[id={view_id}]:"

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False

    if insert_before_view:
      for idx, raw in enumerate(lines):
        line = raw.strip()
        if _line_matches_arrow_id(line, arrow_id):
          out.append(arrow_line)
          replaced = True
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(arrow_line)
            replaced = True
          out.append(raw)
          out.extend(lines[idx + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
      if not replaced:
        out.append(arrow_line)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    for raw in lines:
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        continue
      if in_view and _line_matches_arrow_id(line, arrow_id):
        out.append(arrow_line)
        replaced = True
        continue
      out.append(raw)

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(arrow_line)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(arrow_line)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(arrow_line)
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_bullets_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  bullets_id: str,
  text: str,
  bullets_type: str | None = None,
  align: str | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_bullets_id(line: str, bid: str) -> bool:
    if not line.startswith("bullets[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == bid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None
  def _skip_block(lines: list[str], start_idx: int) -> int:
    j = start_idx + 1
    saw_body = False
    while j < len(lines):
      nxt_raw = lines[j]
      nxt = nxt_raw.strip()
      if not nxt:
        if saw_body:
          j += 1
          break
        j += 1
        continue
      if nxt.startswith("#"):
        j += 1
        continue
      if nxt.startswith(("view[", "text[", "image[", "bullets[", "sound[")) and "]" in nxt:
        break
      saw_body = True
      j += 1
    return j

  params: list[str] = [f"id={bullets_id}"]
  if bullets_type:
    params.append(f"type={bullets_type}")
  align_norm = str(align or "").strip().lower()
  if align_norm in {"left", "center", "right"}:
    params.append(f"align={align_norm}")
  if bg_color:
    params.append(f"bgColor={bg_color}")
  if bg_alpha is not None:
    params.append(f"bgAlpha={bg_alpha}")
  if bg_padding is not None:
    params.append(f"bgPadding={bg_padding}")
  if bg_radius is not None:
    params.append(f"bgRadius={bg_radius}")
  head = f"bullets[{', '.join(params)}]"
  body_lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
  view_head = f"view[id={view_id}]:"
  insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False

    if insert_before_view:
      i = 0
      while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if _line_matches_bullets_id(line, bullets_id):
          out.append(f"{head}:")
          if body_lines:
            out.extend(body_lines)
          out.append("")
          replaced = True
          head_line, body_line = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
          if not body_line.strip():
            i = _skip_block(lines, i)
            continue
          i += 1
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(f"{head}:")
            if body_lines:
              out.extend(body_lines)
            out.append("")
            replaced = True
          out.append(raw)
          out.extend(lines[i + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
        i += 1
      if not replaced:
        out.append(f"{head}:")
        if body_lines:
          out.extend(body_lines)
        out.append("")
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    i = 0
    while i < len(lines):
      raw = lines[i]
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        i += 1
        continue
      if in_view and _line_matches_bullets_id(line, bullets_id):
        out.append(f"{head}:")
        if body_lines:
          out.extend(body_lines)
        out.append("")
        replaced = True
        head_line, body_line = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
        if not body_line.strip():
          i = _skip_block(lines, i)
          continue
        i += 1
        continue
      out.append(raw)
      i += 1

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(f"{head}:")
            if body_lines:
              inserted.extend(body_lines)
            inserted.append("")
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(f"{head}:")
        if body_lines:
          inserted.extend(body_lines)
        inserted.append("")
        inserted_flag = True
      if not inserted_flag:
        inserted.append(f"{head}:")
        if body_lines:
          inserted.extend(body_lines)
        inserted.append("")
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_table_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  table_id: str,
  cells: list[list[str]],
  rows: int | None = None,
  cols: int | None = None,
  editable: bool | None = None,
  h_header: list[str] | None = None,
  v_header: list[str] | None = None,
  h_style: list[str] | None = None,
  color: str | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_table_id(line: str, tid: str) -> bool:
    if not line.startswith("table[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == tid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None
  def _skip_block(lines: list[str], start_idx: int) -> int:
    j = start_idx + 1
    saw_body = False
    while j < len(lines):
      nxt_raw = lines[j]
      nxt = nxt_raw.strip()
      if not nxt:
        if saw_body:
          j += 1
          break
        j += 1
        continue
      if nxt.startswith("#"):
        j += 1
        continue
      if nxt.startswith(("view[", "text[", "image[", "bullets[", "table[", "sound[", "group[")) and "]" in nxt:
        break
      saw_body = True
      j += 1
    return j

  params: list[str] = [f"id={table_id}"]
  if rows is not None:
    params.append(f"rows={rows}")
  if cols is not None:
    params.append(f"cols={cols}")
  if editable is not None:
    params.append(f"editable={str(bool(editable)).lower()}")
  if h_header:
    params.append(f"hHeader={_format_pr_list(h_header)}")
  if v_header:
    params.append(f"vHeader={_format_pr_list(v_header)}")
  if h_style:
    tokens: list[str] = []
    for raw in h_style:
      s = str(raw).strip().lower()
      if s.startswith("l"):
        tokens.append("l")
      elif s.startswith("c"):
        tokens.append("c")
      elif s.startswith("r"):
        tokens.append("r")
    if tokens:
      style = "| " + " | ".join(tokens) + " |"
      params.append(f"hStyle={style}")
  if color:
    params.append(f"color={color}")
  if bg_color:
    params.append(f"bgColor={bg_color}")
  if bg_alpha is not None:
    params.append(f"bgAlpha={bg_alpha}")
  if bg_padding is not None:
    params.append(f"bgPadding={bg_padding}")
  if bg_radius is not None:
    params.append(f"bgRadius={bg_radius}")
  head = f"table[{', '.join(params)}]:"
  body_lines = [";".join(_encode_text_for_pr(str(c)) for c in row) for row in cells]
  view_head = f"view[id={view_id}]:"
  insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False

    if insert_before_view:
      i = 0
      while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if _line_matches_table_id(line, table_id):
          out.append(head)
          out.extend(body_lines)
          replaced = True
          head_line, body_line = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
          if not body_line.strip():
            i = _skip_block(lines, i)
            continue
          i += 1
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(head)
            out.extend(body_lines)
            replaced = True
          out.append(raw)
          out.extend(lines[i + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
        i += 1
      if not replaced:
        out.append(head)
        out.extend(body_lines)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    i = 0
    while i < len(lines):
      raw = lines[i]
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        i += 1
        continue
      if in_view and _line_matches_table_id(line, table_id):
        out.append(head)
        out.extend(body_lines)
        replaced = True
        head_line, body_line = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
        if not body_line.strip():
          i = _skip_block(lines, i)
          continue
        i += 1
        continue
      out.append(raw)
      i += 1

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(head)
            inserted.extend(body_lines)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(head)
        inserted.extend(body_lines)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(head)
        inserted.extend(body_lines)
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def upsert_join_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  join_id: str,
  text: str,
  fields: list[str] | None = None,
  color: str | None = None,
  bg_color: str | None = None,
  bg_alpha: float | None = None,
  bg_padding: float | None = None,
  bg_radius: float | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)

  def _line_matches_join_id(line: str, jid: str) -> bool:
    if not line.startswith("join[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = _split_attrs(inner)
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == jid

  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None

  params: list[str] = [f"id={join_id}"]
  if fields:
    fields_str = ", ".join([str(f).strip() for f in fields if str(f).strip()])
    if fields_str:
      params.append(f"fields={{{fields_str}}}")
  if color and "," not in color:
    params.append(f"color={color}")
  if bg_color:
    params.append(f"bgColor={bg_color}")
  if bg_alpha is not None:
    params.append(f"bgAlpha={bg_alpha}")
  if bg_padding is not None:
    params.append(f"bgPadding={bg_padding}")
  if bg_radius is not None:
    params.append(f"bgRadius={bg_radius}")
  head = f"join[{', '.join(params)}]:"
  body = _encode_text_for_pr(text or "")
  join_line = f"{head} {body}".rstrip()

  insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
  view_head = f"view[id={view_id}]:"

  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    in_view = False
    saw_view = False

    if insert_before_view:
      for idx, raw in enumerate(lines):
        line = raw.strip()
        if _line_matches_join_id(line, join_id):
          out.append(join_line)
          replaced = True
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(join_line)
            replaced = True
          out.append(raw)
          out.extend(lines[idx + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
      if not replaced:
        out.append(join_line)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    for raw in lines:
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        continue
      if in_view and _line_matches_join_id(line, join_id):
        out.append(join_line)
        replaced = True
        continue
      out.append(raw)

    if not saw_view:
      out.append("")
      out.append(view_head)
      saw_view = True

    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(join_line)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(join_line)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(join_line)
      out = inserted

    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

def upsert_buttons_in_pr(
  pr_path: str | Path,
  *,
  view_id: str,
  buttons_id: str,
  labels: list[str] | None,
  actions: list[str] | None,
  buttons_mode: str | None = None,
  h_splits: list[float] | None = None,
  v_splits: list[float] | None = None,
  rows: int | None = None,
  cols: int | None = None,
  space: str | None = None
) -> None:
  p = Path(pr_path)
  def _line_matches_buttons_id(line: str, bid: str) -> bool:
    if not line.startswith("buttons[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id == bid
  def _view_id_from_line(line: str) -> str | None:
    if not line.startswith("view[") or "]" not in line:
      return None
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    vid = str(kv.get("id", "") or kv.get("name", "")).strip()
    return vid or None
  with _lock:
    if not p.exists():
      p.parent.mkdir(parents=True, exist_ok=True)
      p.write_text(f"view[id={view_id or 'home'}]\n", encoding="utf-8")
    lines = p.read_text(encoding="utf-8").splitlines()
    params = [f"id={buttons_id}"]
    if labels is not None:
      params.append(f"labels={_format_pr_list(labels)}")
    if actions is not None:
      params.append(f"actions={_format_pr_list(actions)}")
    if buttons_mode:
      params.append(f"type={buttons_mode}")
    if h_splits:
      params.append(f"hSplits={_format_pr_list([str(x) for x in h_splits])}")
    if v_splits:
      params.append(f"vSplits={_format_pr_list([str(x) for x in v_splits])}")
    if rows is not None:
      params.append(f"rows={int(rows)}")
    if cols is not None:
      params.append(f"cols={int(cols)}")
    target_line = f"buttons[{', '.join(params)}]"
    insert_before_view = (space in {"screen", "group"}) or (view_id == "screen_main")
    out: list[str] = []
    replaced = False
    if insert_before_view:
      i = 0
      while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if _line_matches_buttons_id(line, buttons_id):
          out.append(target_line)
          replaced = True
          i += 1
          continue
        if _view_id_from_line(line):
          if not replaced:
            out.append(target_line)
            replaced = True
          out.append(raw)
          out.extend(lines[i + 1 :])
          p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
          return
        out.append(raw)
        i += 1
      if not replaced:
        out.append(target_line)
      p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
      return

    i = 0
    in_view = False
    saw_view = False
    while i < len(lines):
      raw = lines[i]
      line = raw.strip()
      view_line_id = _view_id_from_line(line)
      if view_line_id:
        in_view = view_line_id == view_id
        if in_view:
          saw_view = True
        out.append(raw)
        i += 1
        continue
      if in_view and line.startswith("buttons[") and "]" in line and _line_matches_buttons_id(line, buttons_id):
        out.append(target_line)
        replaced = True
        i += 1
        continue
      out.append(raw)
      i += 1
    if not saw_view:
      out.append("")
      out.append(f"view[id={view_id}]:")
      saw_view = True
    if saw_view and not replaced:
      inserted: list[str] = []
      in_view = False
      inserted_flag = False
      for raw in out:
        line = raw.strip()
        view_line_id = _view_id_from_line(line)
        if view_line_id:
          if in_view and not inserted_flag:
            inserted.append(target_line)
            inserted_flag = True
          in_view = view_line_id == view_id
          inserted.append(raw)
          continue
        inserted.append(raw)
      if in_view and not inserted_flag:
        inserted.append(target_line)
        inserted_flag = True
      if not inserted_flag:
        inserted.append(target_line)
      out = inserted
    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def delete_nodes_from_pr(pr_path: str | Path, *, ids: list[str]) -> None:
  p = Path(pr_path)
  to_remove = {f"text[id={tid}]" for tid in ids}
  ids_set = {str(tid) for tid in ids}
  def _line_matches_text_id(line: str) -> bool:
    if not line.startswith("text[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _skip_text_block(lines: list[str], start_idx: int) -> int:
    j = start_idx + 1
    saw_body = False
    while j < len(lines):
      nxt_raw = lines[j]
      nxt = nxt_raw.strip()
      if not nxt:
        if saw_body:
          j += 1
          break
        j += 1
        continue
      if nxt.startswith("#"):
        j += 1
        continue
      if nxt.startswith(("view[", "text[", "image[", "bullets[", "table[", "experiment[", "arrow[", "join[", "video[", "group[", "sound[")) and "]" in nxt:
        break
      saw_body = True
      j += 1
    return j
  def _line_matches_bullets_id(line: str) -> bool:
    if not line.startswith("bullets[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_image_id(line: str) -> bool:
    if not line.startswith("image[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    img_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return img_id in ids_set
  def _line_matches_arrow_id(line: str) -> bool:
    if not line.startswith("arrow[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_join_id(line: str) -> bool:
    if not line.startswith("join[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_group_id(line: str) -> bool:
    if not line.startswith("group[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_sound_id(line: str) -> bool:
    if not line.startswith("sound[") or "]" not in line:
      return False
    inner = line[line.find("[") + 1 : line.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_table_id(line: str) -> bool:
    if not line.startswith("table[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  def _line_matches_experiment_id(line: str) -> bool:
    if not line.startswith("experiment[") or "]" not in line:
      return False
    head = line.split(":", 1)[0]
    inner = head[head.find("[") + 1 : head.rfind("]")]
    parts = [x.strip() for x in inner.split(",") if x.strip()]
    kv = dict(x.split("=", 1) for x in parts if "=" in x)
    row_id = str(kv.get("id", "") or kv.get("name", "")).strip()
    return row_id in ids_set
  with _lock:
    if not p.exists():
      return
    lines = p.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
      raw = lines[i]
      line = raw.strip()
      if _line_matches_text_id(line):
        # Remove header and any following text block.
        i = _skip_text_block(lines, i)
        continue
      if line.startswith("image[") and "]" in line and ":" not in line:
        if _line_matches_image_id(line):
          i += 1
          continue
      if line.startswith("bullets[") and "]" in line:
        if _line_matches_bullets_id(line):
          i += 1
          continue
      if line.startswith("table[") and "]" in line:
        if _line_matches_table_id(line):
          i = _skip_text_block(lines, i)
          continue
      if line.startswith("experiment[") and "]" in line:
        if _line_matches_experiment_id(line):
          i = _skip_text_block(lines, i)
          continue
      if line.startswith("arrow[") and "]" in line:
        if _line_matches_arrow_id(line):
          i += 1
          continue
      if line.startswith("join[") and "]" in line:
        if _line_matches_join_id(line):
          i += 1
          continue
      if line.startswith("group[") and "]" in line:
        if _line_matches_group_id(line):
          i += 1
          continue
      if line.startswith("sound[") and "]" in line:
        if _line_matches_sound_id(line):
          i += 1
          continue
      out.append(raw)
      i += 1
    p.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


def decode_text_field(text: str) -> str:
  return _decode_text_from_pr(text)

