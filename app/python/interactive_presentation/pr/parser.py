from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .persist import decode_text_field


@dataclass(frozen=True)
class ViewSpec:
  id: str
  ref_view: str | None = None
  loc: str | None = None
  duration_ms: int | None = None
  screen_id: str | None = None


@dataclass(frozen=True)
class TextSpec:
  id: str
  text: str
  space: str = "world"
  view_id: str | None = None
  align: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None


@dataclass(frozen=True)
class BulletsSpec:
  id: str
  text: str
  bullets: str | None = None
  space: str = "world"
  view_id: str | None = None
  align: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None


@dataclass(frozen=True)
class ArrowSpec:
  id: str
  start: tuple[float, float] | None = None
  end: tuple[float, float] | None = None
  space: str = "world"
  view_id: str | None = None
  color: str | None = None
  stroke_px: float | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None


@dataclass(frozen=True)
class JoinSpec:
  id: str
  fields: list[str]
  text: str
  space: str = "world"
  view_id: str | None = None
  color: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None


@dataclass(frozen=True)
class ScreenSpec:
  id: str
  texts: list[TextSpec]
  bullets: list[BulletsSpec]
  arrows: list["ArrowSpec"]
  joins: list["JoinSpec"]
  images: list["ImageSpec"]


@dataclass(frozen=True)
class ImageSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  src: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None


@dataclass(frozen=True)
class PresentationSpec:
  views: list[ViewSpec]
  texts: list[TextSpec]
  bullets: list[BulletsSpec]
  arrows: list[ArrowSpec]
  joins: list[JoinSpec]
  images: list[ImageSpec]
  screens: list[ScreenSpec]


def parse_presentation_pr(path: str | Path) -> PresentationSpec:
  """
  Minimal `.pr` parser for Milestone 4:
  - view[id=home]
  - text[id=t1]: hello
  - text before first view[] is treated as screen-space

  Everything else is ignored for now.
  """
  p = Path(path)
  if not p.exists():
    return PresentationSpec(views=[ViewSpec(id="home")], texts=[], bullets=[], arrows=[], joins=[], images=[], screens=[])
  s = p.read_text(encoding="utf-8")
  views: list[ViewSpec] = []
  texts: list[TextSpec] = []
  bullets: list[BulletsSpec] = []
  arrows: list[ArrowSpec] = []
  joins: list[JoinSpec] = []
  images: list[ImageSpec] = []
  screens: list[ScreenSpec] = []
  lines = s.splitlines()
  default_screen_id = "screen_main"
  current_space = "screen"
  current_view_id: str | None = None
  current_screen: ScreenSpec | None = None
  current_screen_id: str | None = None
  screen_counter = 0
  saw_first_view = False
  def _parse_align(kv: dict[str, str]) -> str | None:
    raw = str(kv.get("align", "")).strip().lower()
    return raw if raw in {"left", "center", "right"} else None
  def ensure_screen() -> ScreenSpec:
    nonlocal current_screen, current_screen_id, screen_counter
    if current_screen is None:
      screen_counter += 1
      sid = current_screen_id or default_screen_id or f"screen_{screen_counter}"
      current_screen = ScreenSpec(id=sid, texts=[], bullets=[], arrows=[], joins=[], images=[])
      screens.append(current_screen)
      current_screen_id = sid
    return current_screen
  def _parse_point(raw: str) -> tuple[float, float] | None:
    s = str(raw or "").strip()
    if not s:
      return None
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) != 2:
      return None
    try:
      return (float(parts[0]), float(parts[1]))
    except ValueError:
      return None

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
  def _parse_fields(raw: str) -> list[str]:
    s = str(raw or "").strip()
    if s.startswith("{") and s.endswith("}"):
      s = s[1:-1]
    return [p.strip() for p in s.split(",") if p.strip()]
    s = str(raw or "").strip()
    if not s:
      return None
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) != 2:
      return None
    try:
      return (float(parts[0]), float(parts[1]))
    except ValueError:
      return None
  i = 0
  while i < len(lines):
    raw = lines[i]
    line = raw.strip()
    if not line or line.startswith("#"):
      i += 1
      continue
    if line.startswith("view[") and line.endswith(("]", "]:")):
      inner = line[line.find("[") + 1 : line.rfind("]")]
      # super-minimal: id=... or name=...
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      vid = str(kv.get("id", "") or kv.get("name", "")).strip()
      saw_first_view = True
      if vid:
        ref_view = str(kv.get("refView", "") or kv.get("ref", "")).strip() or None
        loc = str(kv.get("loc", "")).strip() or None
        dur_raw = str(kv.get("durationMs", "") or kv.get("duration", "")).strip()
        dur_ms = int(float(dur_raw)) if dur_raw else None
        if current_screen_id is None and current_screen is not None:
          current_screen_id = current_screen.id
        views.append(ViewSpec(id=vid, ref_view=ref_view, loc=loc, duration_ms=dur_ms, screen_id=current_screen_id))
      current_space = "world"
      current_screen = None
      current_view_id = vid or current_view_id
      i += 1
      continue
    if line.startswith("text[") and "]" in line:
      head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
      inner = head[len("text[") : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      tid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if tid:
        if not body.strip():
          # Read a simple block until next header or blank line.
          j = i + 1
          body_lines: list[str] = []
          while j < len(lines):
            nxt_raw = lines[j]
            nxt = nxt_raw.strip()
            if not nxt:
              if body_lines:
                break
              j += 1
              continue
            if nxt.startswith("#"):
              j += 1
              continue
            if nxt.startswith(("view[", "text[", "image[", "bullets[")) and "]" in nxt:
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        align = _parse_align(kv)
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        text_spec = TextSpec(
          id=tid,
          text=decode_text_field(body.strip()),
          space=current_space,
          align=align,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.texts.append(text_spec)
        else:
          view_id = current_view_id or "home"
          texts.append(
            TextSpec(
              id=tid,
              text=text_spec.text,
              space="world",
              view_id=view_id,
              align=align,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
            )
          )
      i += 1
      continue
    if line.startswith("image[") and "]" in line:
      head = line
      inner = head[len("image[") : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      iid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if iid:
        src = str(kv.get("src", "") or kv.get("url", "")).strip() or None
        align = _parse_align(kv)
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        img_spec = ImageSpec(id=iid, space=current_space, src=src, bg_color=bg_color, bg_alpha=bg_alpha)
        if current_space == "screen":
          screen = ensure_screen()
          screen.images.append(img_spec)
        else:
          view_id = current_view_id or "home"
          images.append(ImageSpec(id=iid, space="world", view_id=view_id, src=src, bg_color=bg_color, bg_alpha=bg_alpha))
      i += 1
      continue
    if line.startswith("arrow[") and "]" in line:
      head = line
      inner = head[len("arrow[") : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      aid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if aid:
        start = _parse_point(kv.get("start", ""))
        end = _parse_point(kv.get("end", ""))
        color = str(kv.get("color", "")).strip() or None
        stroke_raw = str(kv.get("strokePx", "") or kv.get("stroke", "")).strip()
        try:
          stroke_px = float(stroke_raw) if stroke_raw else None
        except ValueError:
          stroke_px = None
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        arrow_spec = ArrowSpec(
          id=aid,
          start=start,
          end=end,
          space=current_space,
          color=color,
          stroke_px=stroke_px,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.arrows.append(arrow_spec)
        else:
          view_id = current_view_id or "home"
          arrows.append(
            ArrowSpec(
              id=aid,
              start=start,
              end=end,
              space="world",
              view_id=view_id,
              color=color,
              stroke_px=stroke_px,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
            )
          )
      i += 1
      continue
    if line.startswith("join[") and "]" in line:
      head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
      inner = head[len("join[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      jid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if jid:
        if not body.strip():
          j = i + 1
          body_lines: list[str] = []
          while j < len(lines):
            nxt_raw = lines[j]
            nxt = nxt_raw.strip()
            if not nxt:
              if body_lines:
                break
              j += 1
              continue
            if nxt.startswith("#"):
              j += 1
              continue
            if nxt.startswith(("view[", "text[", "image[", "bullets[", "arrow[", "join[")) and "]" in nxt:
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        fields = _parse_fields(kv.get("fields", ""))
        color = str(kv.get("color", "")).strip() or None
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        join_spec = JoinSpec(
          id=jid,
          fields=fields,
          text=decode_text_field(body.strip()),
          space=current_space,
          color=color,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.joins.append(join_spec)
        else:
          view_id = current_view_id or "home"
          joins.append(
            JoinSpec(
              id=jid,
              fields=fields,
              text=join_spec.text,
              space="world",
              view_id=view_id,
              color=color,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
            )
          )
      i += 1
      continue
    if line.startswith("bullets[") and "]" in line:
      head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
      inner = head[len("bullets[") : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      bid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if bid:
        if not body.strip():
          j = i + 1
          body_lines: list[str] = []
          while j < len(lines):
            nxt_raw = lines[j]
            nxt = nxt_raw.strip()
            if not nxt:
              if body_lines:
                break
              j += 1
              continue
            if nxt.startswith("#"):
              j += 1
              continue
            if nxt.startswith(("view[", "text[", "image[", "bullets[")) and "]" in nxt:
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        bullets_type = str(kv.get("type", "")).strip() or None
        bullet_spec = BulletsSpec(
          id=bid,
          text=decode_text_field(body.strip()),
          bullets=bullets_type,
          space=current_space,
          align=align,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.bullets.append(bullet_spec)
        else:
          view_id = current_view_id or "home"
          bullets.append(
            BulletsSpec(
              id=bid,
              text=bullet_spec.text,
              bullets=bullets_type,
              space="world",
              view_id=view_id,
              align=align,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
            )
          )
      i += 1
      continue
    i += 1
  if not views:
    views = [ViewSpec(id="home")]
  return PresentationSpec(views=views, texts=texts, bullets=bullets, arrows=arrows, joins=joins, images=images, screens=screens)

