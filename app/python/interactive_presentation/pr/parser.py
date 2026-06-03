from __future__ import annotations

import ast
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
  bg_padding: float | None = None
  bg_radius: float | None = None


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
  bg_padding: float | None = None
  bg_radius: float | None = None


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
  bg_padding: float | None = None
  bg_radius: float | None = None


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
  bg_padding: float | None = None
  bg_radius: float | None = None


@dataclass(frozen=True)
class ScreenSpec:
  id: str
  texts: list[TextSpec]
  bullets: list[BulletsSpec]
  arrows: list["ArrowSpec"]
  joins: list["JoinSpec"]
  images: list["ImageSpec"]
  iframes: list["IframeSpec"]
  videos: list["VideoSpec"]
  cameras: list["CameraSpec"]
  axes: list["AxisSpec"]
  buttons: list["ButtonsSpec"]
  sliders: list["SliderSpec"]
  players: list["PlayerSpec"]
  webcams: list["WebcamSpec"]
  groups: list["GroupSpec"]
  sounds: list["SoundSpec"]
  pressures: list["PressureSpec"]
  spectra: list["SpectrumSpec"]
  timers: list["TimerSpec"]
  tables: list["TableSpec"]
  experiments: list["ExperimentSpec"]
  multichoices: list["MultiChoiceSpec"]
  wheels: list["WheelSpec"]


@dataclass(frozen=True)
class ImageSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  src: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None


@dataclass(frozen=True)
class IframeSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  src: str | None = None
  html: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None


@dataclass(frozen=True)
class VideoSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  src: str | None = None
  thumbnail: str | None = None
  poster: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None


@dataclass(frozen=True)
class CameraSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  device_id: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None


@dataclass(frozen=True)
class AxisSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  x_min: float | None = None
  x_max: float | None = None
  y_min: float | None = None
  y_max: float | None = None
  clamp: bool | None = None
  pad_px: float | None = None
  max_points: int | None = None
  bins: list[float] | None = None


@dataclass(frozen=True)
class ButtonsSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  labels: list[str] | None = None
  actions: list[str] | None = None
  buttons_mode: str | None = None
  h_splits: list[float] | None = None
  v_splits: list[float] | None = None
  rows: int | None = None
  cols: int | None = None


@dataclass(frozen=True)
class SliderSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  min_val: float | None = None
  max_val: float | None = None
  step: float | None = None
  value: float | None = None
  values: list[float] | None = None


@dataclass(frozen=True)
class PlayerSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  src: str | None = None
  thumbnail: str | None = None
  poster: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  labels: list[str] | None = None
  actions: list[str] | None = None
  play_label: str | None = None
  pause_label: str | None = None
  h_splits: list[float] | None = None
  v_splits: list[float] | None = None
  rows: int | None = None
  cols: int | None = None
  slider_min: float | None = None
  slider_max: float | None = None
  slider_step: float | None = None
  slider_value: float | None = None


@dataclass(frozen=True)
class WebcamSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  device_id: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  labels: list[str] | None = None
  actions: list[str] | None = None
  rec_label: str | None = None
  shot_label: str | None = None
  h_splits: list[float] | None = None
  v_splits: list[float] | None = None
  rows: int | None = None
  cols: int | None = None


@dataclass(frozen=True)
class SoundSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  mode: str | None = None
  window_s: float | None = None
  sample_ms: float | None = None
  color: str | None = None
  line_width: float | None = None
  y_label: str | None = None
  f_label: str | None = None
  t_label: str | None = None
  f_x_label: str | None = None
  f_y_label: str | None = None
  t_x_label: str | None = None
  t_y_label: str | None = None
  peak_label: str | None = None
  f_output_col: str | None = None
  t_output_col: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  run_label: str | None = None
  resume_label: str | None = None
  pause_label: str | None = None
  reset_label: str | None = None
  home_label: str | None = None
  freq_mode_label: str | None = None
  time_mode_label: str | None = None
  freq_button_label: str | None = None
  time_button_label: str | None = None
  h_splits: list[float] | None = None
  v_splits: list[float] | None = None
  rows: int | None = None
  cols: int | None = None


@dataclass(frozen=True)
class PressureSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  window_s: float | None = None
  sample_ms: float | None = None
  color: str | None = None
  line_width: float | None = None
  x_label: str | None = None
  y_label: str | None = None
  peak_label: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  run_label: str | None = None
  resume_label: str | None = None
  pause_label: str | None = None


@dataclass(frozen=True)
class SpectrumSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  window_s: float | None = None
  sample_ms: float | None = None
  color: str | None = None
  line_width: float | None = None
  y_label: str | None = None
  f_label: str | None = None
  f_x_label: str | None = None
  f_y_label: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  run_label: str | None = None
  resume_label: str | None = None
  pause_label: str | None = None
  x_min: float | None = None
  x_max: float | None = None
  y_min: float | None = None
  y_max: float | None = None


@dataclass(frozen=True)
class TableSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  rows: int | None = None
  cols: int | None = None
  editable: bool | None = None
  h_header: list[str] | None = None
  v_header: list[str] | None = None
  h_style: list[str] | None = None
  color: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  cells: list[list[str]] | None = None


@dataclass(frozen=True)
class ExperimentSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  title: str | None = None
  transforms: list[str] | None = None
  fit_label: str | None = None
  fit_button_label: str | None = None
  clear_label: str | None = None
  line_color: str | None = None
  data_color: str | None = None
  rows: int | None = None
  cols: int | None = None
  editable: bool | None = None
  h_header: list[str] | None = None
  v_header: list[str] | None = None
  h_style: list[str] | None = None
  table_bg_color: str | None = None
  axis_bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  cells: list[list[str]] | None = None


@dataclass(frozen=True)
class TimerSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  duration_s: float | None = None
  sample_ms: float | None = None
  bins: list[float] | None = None
  show_time: bool | None = None
  debug: bool | None = None
  stat: str | None = None
  color: str | None = None
  bar_color: str | None = None
  bg_color: str | None = None
  bg_alpha: float | None = None
  bg_padding: float | None = None
  bg_radius: float | None = None
  start_label: str | None = None
  stop_label: str | None = None
  reset_label: str | None = None
  x_label: str | None = None
  y_label: str | None = None
  value_label: str | None = None
  h_splits: list[float] | None = None
  v_splits: list[float] | None = None
  rows: int | None = None
  cols: int | None = None


@dataclass(frozen=True)
class MultiChoiceSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  answers: list[tuple[str, str]] | None = None
  choice_type: str | None = None
  question: str | None = None
  other_label: str | None = None
  other_limit: float | None = None
  start_label: str | None = None
  stop_label: str | None = None
  reset_label: str | None = None
  show_wheel: bool | None = None


@dataclass(frozen=True)
class WheelSpec:
  id: str
  space: str = "world"
  view_id: str | None = None
  answers: list[tuple[str, str]] | None = None
  choice_type: str | None = None
  question: str | None = None
  other_label: str | None = None
  other_limit: float | None = None


@dataclass(frozen=True)
class GroupSpec:
  id: str
  space: str = "world"
  view_id: str | None = None


@dataclass(frozen=True)
class PresentationSpec:
  views: list[ViewSpec]
  texts: list[TextSpec]
  bullets: list[BulletsSpec]
  arrows: list[ArrowSpec]
  joins: list[JoinSpec]
  images: list[ImageSpec]
  iframes: list[IframeSpec]
  videos: list[VideoSpec]
  cameras: list[CameraSpec]
  axes: list[AxisSpec]
  buttons: list[ButtonsSpec]
  sliders: list[SliderSpec]
  players: list[PlayerSpec]
  webcams: list[WebcamSpec]
  sounds: list[SoundSpec]
  pressures: list[PressureSpec]
  spectra: list[SpectrumSpec]
  timers: list[TimerSpec]
  tables: list[TableSpec]
  experiments: list[ExperimentSpec]
  multichoices: list[MultiChoiceSpec]
  wheels: list[WheelSpec]
  groups: list[GroupSpec]
  screens: list[ScreenSpec]


def _parse_float(raw: str | None) -> float | None:
  if raw is None:
    return None
  value = str(raw).strip()
  if not value:
    return None
  try:
    return float(value)
  except ValueError:
    return None


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
    return PresentationSpec(
      views=[ViewSpec(id="home")],
      texts=[],
      bullets=[],
      arrows=[],
      joins=[],
      images=[],
      iframes=[],
      videos=[],
      cameras=[],
      axes=[],
      buttons=[],
      sliders=[],
      players=[],
      webcams=[],
      sounds=[],
      pressures=[],
      spectra=[],
      timers=[],
      tables=[],
      experiments=[],
      multichoices=[],
      wheels=[],
      groups=[],
      screens=[],
    )
  s = p.read_text(encoding="utf-8")
  views: list[ViewSpec] = []
  texts: list[TextSpec] = []
  bullets: list[BulletsSpec] = []
  arrows: list[ArrowSpec] = []
  joins: list[JoinSpec] = []
  images: list[ImageSpec] = []
  iframes: list[IframeSpec] = []
  videos: list[VideoSpec] = []
  cameras: list[CameraSpec] = []
  axes: list[AxisSpec] = []
  buttons: list[ButtonsSpec] = []
  sliders: list[SliderSpec] = []
  players: list[PlayerSpec] = []
  webcams: list[WebcamSpec] = []
  sounds: list[SoundSpec] = []
  pressures: list[PressureSpec] = []
  spectra: list[SpectrumSpec] = []
  timers: list[TimerSpec] = []
  tables: list[TableSpec] = []
  experiments: list[ExperimentSpec] = []
  multichoices: list[MultiChoiceSpec] = []
  wheels: list[WheelSpec] = []
  wheels: list[WheelSpec] = []
  groups: list[GroupSpec] = []
  screens: list[ScreenSpec] = []
  raw_lines = s.splitlines()
  def _is_header_start(line: str) -> bool:
    stripped = line.lstrip()
    if not stripped:
      return False
    for name in (
      "screen",
      "view",
      "text",
      "image",
      "iframe",
      "bullets",
      "arrow",
      "join",
      "sound",
      "spectrum",
      "multichoice",
      "wheel",
      "timer",
      "webcam",
      "player",
      "video",
      "table",
      "experiment",
      "group",
      "buttons",
      "button",
      "slider",
      "axis",
      "camera",
      "graph",
      "lines",
      "line",
      "choices",
      "poll",
      "audio",
      "shape",
      "input",
    ):
      if stripped.startswith(f"{name}["):
        return True
    return False
  lines: list[str] = []
  buf: list[str] = []
  bracket_balance = 0
  for raw in raw_lines:
    if not buf:
      if _is_header_start(raw) and raw.count("[") > raw.count("]"):
        buf = [raw.strip()]
        bracket_balance = raw.count("[") - raw.count("]")
        continue
      lines.append(raw)
      continue
    # we are inside a multi-line header
    buf.append(raw.strip())
    bracket_balance += raw.count("[") - raw.count("]")
    if bracket_balance <= 0:
      lines.append(" ".join([x for x in buf if x]))
      buf = []
      bracket_balance = 0
  if buf:
    lines.append(" ".join([x for x in buf if x]))
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
  element_headers = (
    "view[",
    "text[",
    "image[",
    "iframe[",
    "video[",
    "bullets[",
    "arrow[",
    "join[",
    "sound[",
    "pressure[",
    "spectrum[",
    "timer[",
    "table[",
    "experiment[",
    "multichoice[",
    "wheel[",
    "axis[",
    "camera[",
    "buttons[",
    "slider[",
    "player[",
    "webcam[",
    "group[",
  )
  def _strip_list_prefix(raw: str) -> str:
    s = raw.lstrip()
    if not s:
      return s
    i = 0
    while i < len(s) and s[i].isdigit():
      i += 1
    if i > 0 and i < len(s) and s[i] in (".", ")"):
      j = i + 1
      if j < len(s) and s[j].isspace():
        return s[j:].lstrip()
    if s[0] in ("-", "*", "+"):
      rest = s[1:]
      if rest and rest[0].isspace():
        return rest.lstrip()
    return s
  def _is_element_header(raw: str) -> bool:
    candidate = _strip_list_prefix(raw)
    return candidate.startswith(element_headers) and "]" in candidate
  def ensure_screen() -> ScreenSpec:
    nonlocal current_screen, current_screen_id, screen_counter
    if current_screen is None:
      screen_counter += 1
      sid = current_screen_id or default_screen_id or f"screen_{screen_counter}"
      current_screen = ScreenSpec(
        id=sid,
        texts=[],
        bullets=[],
        arrows=[],
        joins=[],
        images=[],
        iframes=[],
        videos=[],
        cameras=[],
        axes=[],
        buttons=[],
        sliders=[],
        players=[],
        webcams=[],
        groups=[],
        sounds=[],
        pressures=[],
        spectra=[],
        timers=[],
        tables=[],
        experiments=[],
        multichoices=[],
        wheels=[],
      )
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
    quote_char: str | None = None
    prev = ""
    for ch in inner:
      if ch in ("'", '"') and prev != "\\":
        if quote_char is None:
          quote_char = ch
        elif quote_char == ch:
          quote_char = None
      if quote_char is None and ch in "{([":
        depth += 1
      elif quote_char is None and ch in "})]":
        depth = max(0, depth - 1)
      if ch == "," and depth == 0 and quote_char is None:
        part = "".join(buf).strip()
        if part:
          parts.append(part)
        buf = []
        prev = ch
        continue
      buf.append(ch)
      prev = ch
    tail = "".join(buf).strip()
    if tail:
      parts.append(tail)
    return parts
  def _find_unquoted(s: str, target: str, *, start: int = 0) -> int:
    quote_char: str | None = None
    i = start
    while i < len(s):
      ch = s[i]
      if ch in ("'", '"') and (i == 0 or s[i - 1] != "\\"):
        if quote_char is None:
          quote_char = ch
        elif quote_char == ch:
          quote_char = None
      if quote_char is None and ch == target:
        return i
      i += 1
    return -1
  def _arglist_complete(line: str) -> bool:
    open_idx = _find_unquoted(line, "[")
    if open_idx < 0:
      return True
    close_idx = _find_unquoted(line, "]", start=open_idx + 1)
    return close_idx >= 0
  def _merge_arglist_lines(src: list[str], start_idx: int) -> tuple[str, int]:
    line = src[start_idx].rstrip("\n")
    if _arglist_complete(line):
      return line, start_idx
    merged = line
    idx = start_idx
    while idx + 1 < len(src):
      idx += 1
      next_line = src[idx].strip()
      merged = f"{merged} {next_line}" if next_line else f"{merged} "
      if _arglist_complete(merged):
        break
    return merged, idx
  def _parse_fields(raw: str) -> list[str]:
    s = str(raw or "").strip()
    if s.startswith("{") and s.endswith("}"):
      s = s[1:-1]
    return [p.strip() for p in s.split(",") if p.strip()]

  def _parse_list(raw: str | None) -> list[str]:
    s = str(raw or "").strip()
    if s.startswith("[") and s.endswith("]"):
      s = s[1:-1]
    if not s:
      return []
    items: list[str] = []
    buf: list[str] = []
    depth = 0
    quote_char: str | None = None
    i = 0
    while i < len(s):
      ch = s[i]
      if ch in ("'", '"') and (i == 0 or s[i - 1] != "\\"):
        if quote_char is None:
          quote_char = ch
        elif quote_char == ch:
          quote_char = None
        i += 1
        continue
      if quote_char is None:
        if ch in "[{(":
          depth += 1
        elif ch in "]})":
          depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
          item = "".join(buf).strip()
          if item:
            items.append(item)
          buf = []
          i += 1
          continue
      buf.append(ch)
      i += 1
    tail = "".join(buf).strip()
    if tail:
      items.append(tail)
    cleaned: list[str] = []
    for x in items:
      token = x.strip()
      if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        token = token[1:-1].replace("\\'", "'").replace('\\"', '"')
      cleaned.append(token)
    return cleaned

  def _parse_kv_map(raw: str | None) -> list[tuple[str, str]]:
    s = str(raw or "").strip()
    if s.startswith("{") and s.endswith("}"):
      s = s[1:-1]
    if not s:
      return []
    items: list[str] = []
    buf: list[str] = []
    depth = 0
    quote_char: str | None = None
    i = 0
    while i < len(s):
      ch = s[i]
      if ch in ("'", '"') and (i == 0 or s[i - 1] != "\\"):
        if quote_char is None:
          quote_char = ch
        elif quote_char == ch:
          quote_char = None
        i += 1
        continue
      if quote_char is None:
        if ch in "[{(":
          depth += 1
        elif ch in "]})":
          depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
          part = "".join(buf).strip()
          if part:
            items.append(part)
          buf = []
          i += 1
          continue
      buf.append(ch)
      i += 1
    tail = "".join(buf).strip()
    if tail:
      items.append(tail)
    out: list[tuple[str, str]] = []
    for item in items:
      if ":" not in item:
        continue
      k, v = item.split(":", 1)
      out.append((k.strip().strip("\"'"), v.strip().strip("\"'")))
    return out

  def _parse_num_list(raw: str | None) -> list[float] | None:
    items = _parse_list(raw)
    if not items:
      return None
    out: list[float] = []
    for it in items:
      try:
        out.append(float(it))
      except ValueError:
        continue
    return out or None

  def _parse_values(raw: str | None) -> list[float] | None:
    s = str(raw or "").strip()
    if not s:
      return None
    if s.startswith("(") and s.endswith(")"):
      s = s[1:-1]
    if ":" in s:
      return _parse_bins(s)
    return _parse_num_list(s)
  def _parse_bins(raw: str | None) -> list[float] | None:
    if raw is None:
      return None
    s = str(raw).strip()
    if not s:
      return None
    if ":" in s:
      parts = [p.strip() for p in s.split(":") if p.strip()]
      if len(parts) >= 2:
        try:
          start = float(parts[0])
          if len(parts) == 2:
            step = 1.0
            end = float(parts[1])
          else:
            step = float(parts[1])
            end = float(parts[2])
          if step == 0:
            return None
          values: list[float] = []
          v = start
          if step > 0:
            while v <= end + 1e-9:
              values.append(v)
              v += step
          else:
            while v >= end - 1e-9:
              values.append(v)
              v += step
          return values or None
        except ValueError:
          return None
    if (s.startswith("(") and s.endswith(")")) or (s.startswith("[") and s.endswith("]")):
      inner = s[1:-1]
      parts = [p.strip() for p in inner.split(",") if p.strip()]
      out: list[float] = []
      for part in parts:
        try:
          out.append(float(part))
        except ValueError:
          continue
      return out or None
    return None
  def _parse_bool(raw: str | None) -> bool | None:
    if raw is None:
      return None
    s = str(raw).strip().lower()
    if s in {"1", "true", "yes", "on"}:
      return True
    if s in {"0", "false", "no", "off"}:
      return False
    return None
  def _parse_header_list(raw: str | None) -> list[str] | None:
    if raw is None:
      return None
    s = str(raw).strip()
    if not s:
      return None
    if "|" in s:
      parts = [p.strip() for p in s.split("|")]
      parts = [p for p in parts if p]
      return parts or None
    if s.startswith("{") and s.endswith("}"):
      s = s[1:-1]
      parts = [p.strip() for p in s.split(",") if p.strip()]
      return parts or None
    items = _parse_list(s)
    return items or None
  def _parse_style_list(raw: str | None) -> list[str] | None:
    if raw is None:
      return None
    s = str(raw).strip()
    if not s:
      return None
    parts = [p.strip() for p in s.split("|")] if "|" in s else [p.strip() for p in s.split(",")]
    out: list[str] = []
    for part in parts:
      token = part.strip().lower()
      if not token:
        continue
      if token.startswith("l"):
        out.append("left")
      elif token.startswith("c"):
        out.append("center")
      elif token.startswith("r"):
        out.append("right")
    return out or None
  def _parse_table_cells(raw: str | None) -> list[list[str]] | None:
    if raw is None:
      return None
    rows: list[list[str]] = []
    for line in str(raw).splitlines():
      s = line.strip()
      if not s or s.startswith("#"):
        continue
      parts = [p.strip() for p in s.split(";")]
      rows.append([decode_text_field(p) for p in parts])
    return rows or None
  def _parse_answers(raw: str | None) -> list[tuple[str, str]] | None:
    if raw is None:
      return None
    s = str(raw).strip()
    if not s:
      return None
    def _unquote(value: str) -> str:
      text = str(value).strip()
      if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1].strip()
      if text.startswith(("'", '"')):
        text = text[1:].strip()
      if text.endswith(("'", '"')):
        text = text[:-1].strip()
      return text
    try:
      parsed = ast.literal_eval(s)
    except Exception:
      parsed = None
    if isinstance(parsed, list):
      out: list[tuple[str, str]] = []
      for item in parsed:
        if isinstance(item, dict):
          out.append((_unquote(str(item.get("name", ""))), _unquote(str(item.get("color", "")))))
          continue
        if isinstance(item, (list, tuple)) and item:
          name = _unquote(str(item[0]))
          color = _unquote(str(item[1])) if len(item) > 1 else ""
          out.append((name, color))
          continue
        if isinstance(item, str):
          try:
            nested = ast.literal_eval(item)
          except Exception:
            nested = None
          if isinstance(nested, dict):
            out.append((_unquote(str(nested.get("name", ""))), _unquote(str(nested.get("color", "")))))
          else:
            out.append((_unquote(item), ""))
      cleaned = [(name, color) for name, color in out if name]
      return cleaned or None
    if s.startswith("{") and s.endswith("}"):
      s = s[1:-1]
    parts = [p.strip() for p in s.split(",") if p.strip()]
    out: list[tuple[str, str]] = []
    for part in parts:
      if ":" in part:
        name, color = part.split(":", 1)
        out.append((_unquote(name), _unquote(color)))
      else:
        out.append((_unquote(part), ""))
    return out or None

  def _parse_answer_lines(raw: str | None) -> list[tuple[str, str]] | None:
    if raw is None:
      return None
    lines = []
    for line in str(raw).splitlines():
      s = line.strip()
      if not s or s.startswith("#"):
        continue
      if s[0] in "-*•":
        s = s[1:].strip()
      if not s:
        continue
      name = s
      color = ""
      if ":" in s:
        left, right = s.split(":", 1)
        if left.strip() and right.strip():
          name = left.strip()
          color = right.strip()
      lines.append((name, color))
    return lines or None
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
    raw, i = _merge_arglist_lines(lines, i)
    line = raw.strip()
    if not line or line.startswith("#"):
      i += 1
      continue
    if line.startswith("view[") and line.endswith(("]", "]:")):
      inner = line[line.find("[") + 1 : line.rfind("]")]
      # super-minimal: id=... or name=...
      parts = _split_attrs(inner)
      kv = {k.strip(): v.strip() for k, v in (x.split("=", 1) for x in parts if "=" in x)}
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
      parts = _split_attrs(inner)
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
            if _is_element_header(nxt):
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
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        text_spec = TextSpec(
          id=tid,
          text=decode_text_field(body.strip()),
          space=current_space,
          align=align,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
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
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("image[") and "]" in line:
      head = line
      inner = head[len("image[") : head.rfind("]")]
      parts = _split_attrs(inner)
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
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        img_spec = ImageSpec(
          id=iid,
          space=current_space,
          src=src,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.images.append(img_spec)
        else:
          view_id = current_view_id or "home"
          images.append(
            ImageSpec(
              id=iid,
              space="world",
              view_id=view_id,
              src=src,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("iframe[") and "]" in line:
      body = ""
      head = line
      close_idx = line.find("]")
      if close_idx != -1 and close_idx + 1 < len(line) and line[close_idx + 1] == ":":
        head = line[:close_idx + 1]
        body = line[close_idx + 2 :]
      inner = head[len("iframe[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      fid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if fid:
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
            if _is_element_header(nxt):
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        src = str(kv.get("src", "") or kv.get("url", "") or kv.get("page", "")).strip() or None
        space_raw = str(kv.get("space", "")).strip().lower()
        space_override = space_raw if space_raw in {"screen", "world"} else None
        html = str(kv.get("html", "") or kv.get("srcdoc", "")).strip() or None
        if not html and body.strip():
          html = decode_text_field(body.strip())
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        iframe_spec = IframeSpec(
          id=fid,
          space=space_override or current_space,
          src=src,
          html=html,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
        )
        if (space_override or current_space) == "screen":
          screen = ensure_screen()
          screen.iframes.append(iframe_spec)
        else:
          view_id = current_view_id or "home"
          iframes.append(
            IframeSpec(
              id=fid,
              space=space_override or "world",
              view_id=view_id,
              src=src,
              html=html,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("video[") and "]" in line:
      head = line
      inner = head[len("video[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      vid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if vid:
        src = str(kv.get("src", "") or kv.get("url", "") or kv.get("file", "")).strip() or None
        thumbnail = str(kv.get("thumbnail", "")).strip() or None
        poster = str(kv.get("poster", "") or kv.get("thumb", "")).strip() or None
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        video_spec = VideoSpec(
          id=vid,
          space=current_space,
          src=src,
          thumbnail=thumbnail,
          poster=poster,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.videos.append(video_spec)
        else:
          view_id = current_view_id or "home"
          videos.append(
            VideoSpec(
              id=vid,
              space="world",
              view_id=view_id,
              src=src,
              thumbnail=thumbnail,
              poster=poster,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("axis[") and "]" in line:
      head = line
      inner = head[len("axis[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      aid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if aid:
        x_min = _parse_float(kv.get("xMin") or kv.get("xmin") or kv.get("minX"))
        x_max = _parse_float(kv.get("xMax") or kv.get("xmax") or kv.get("maxX"))
        y_min = _parse_float(kv.get("yMin") or kv.get("ymin") or kv.get("minY"))
        y_max = _parse_float(kv.get("yMax") or kv.get("ymax") or kv.get("maxY"))
        clamp_raw = str(kv.get("clamp", "")).strip().lower()
        clamp = None
        if clamp_raw in {"1", "true", "yes", "on"}:
          clamp = True
        elif clamp_raw in {"0", "false", "no", "off"}:
          clamp = False
        pad_px = _parse_float(kv.get("padPx") or kv.get("padding") or kv.get("pad"))
        max_points_raw = str(kv.get("maxPoints", "") or kv.get("max", "")).strip()
        max_points = int(float(max_points_raw)) if max_points_raw else None
        bins = _parse_bins(kv.get("bins") or kv.get("binEdges") or kv.get("edges"))
        axis_spec = AxisSpec(
          id=aid,
          space=current_space,
          x_min=x_min,
          x_max=x_max,
          y_min=y_min,
          y_max=y_max,
          clamp=clamp,
          pad_px=pad_px,
          max_points=max_points,
          bins=bins,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.axes.append(axis_spec)
        else:
          view_id = current_view_id or "home"
          axes.append(
            AxisSpec(
              id=aid,
              space="world",
              view_id=view_id,
              x_min=x_min,
              x_max=x_max,
              y_min=y_min,
              y_max=y_max,
              clamp=clamp,
              pad_px=pad_px,
              max_points=max_points,
              bins=bins,
            )
          )
      i += 1
      continue
    if line.startswith("buttons[") and "]" in line:
      head = line
      inner = head[len("buttons[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      bid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if bid:
        labels = _parse_list(kv.get("labels") or kv.get("templates"))
        actions = _parse_list(kv.get("actions"))
        items = _parse_kv_map(kv.get("items") or kv.get("item"))
        if items and (not labels or not actions):
          labels = [k for k, _ in items]
          actions = [v for _, v in items]
        buttons_mode = str(kv.get("type", "") or kv.get("mode", "")).strip().lower() or None
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        h_splits = _parse_num_list(kv.get("hSplits") or kv.get("hsplits") or kv.get("hSplit") or kv.get("splitsH"))
        v_splits = _parse_num_list(kv.get("vSplits") or kv.get("vsplits") or kv.get("vSplit") or kv.get("splitsV"))
        buttons_spec = ButtonsSpec(
          id=bid,
          space=current_space,
          labels=labels or None,
          actions=actions or None,
          buttons_mode=buttons_mode,
          h_splits=h_splits,
          v_splits=v_splits,
          rows=rows,
          cols=cols,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.buttons.append(buttons_spec)
        else:
          view_id = current_view_id or "home"
          buttons.append(
            ButtonsSpec(
              id=bid,
              space="world",
              view_id=view_id,
              labels=labels or None,
              actions=actions or None,
              buttons_mode=buttons_mode,
              h_splits=h_splits,
              v_splits=v_splits,
              rows=rows,
              cols=cols,
            )
          )
      i += 1
      continue
    if line.startswith("slider[") and "]" in line:
      head = line
      inner = head[len("slider[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      sid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if sid:
        min_val = _parse_float(kv.get("min") or kv.get("minVal"))
        max_val = _parse_float(kv.get("max") or kv.get("maxVal"))
        step = _parse_float(kv.get("step"))
        value = _parse_float(kv.get("value"))
        values = _parse_values(kv.get("values") or kv.get("vals") or kv.get("valueList"))
        slider_spec = SliderSpec(
          id=sid,
          space=current_space,
          min_val=min_val,
          max_val=max_val,
          step=step,
          value=value,
          values=values,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.sliders.append(slider_spec)
        else:
          view_id = current_view_id or "home"
          sliders.append(
            SliderSpec(
              id=sid,
              space="world",
              view_id=view_id,
              min_val=min_val,
              max_val=max_val,
              step=step,
              value=value,
              values=values,
            )
          )
      i += 1
      continue
    if line.startswith("player[") and "]" in line:
      head = line
      inner = head[len("player[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      pid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if pid:
        src = str(kv.get("src", "") or kv.get("url", "") or kv.get("file", "")).strip() or None
        thumbnail = str(kv.get("thumbnail", "")).strip() or None
        poster = str(kv.get("poster", "") or kv.get("thumb", "")).strip() or None
        f_output_col = str(kv.get("fOutputCol", "") or kv.get("f_output_col", "")).strip() or None
        t_output_col = str(kv.get("tOutputCol", "") or kv.get("t_output_col", "")).strip() or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        labels = _parse_list(kv.get("labels") or kv.get("templates"))
        play_label = str(kv.get("play_label", "") or kv.get("playLabel", "")).strip() or None
        pause_label = str(kv.get("pause_label", "") or kv.get("pauseLabel", "")).strip() or None
        if labels:
          play_label = str(labels[0] or "").strip() or play_label
          pause_label = str(labels[1] or "").strip() or pause_label
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        h_splits = _parse_num_list(kv.get("hSplits") or kv.get("hsplits") or kv.get("hSplit") or kv.get("splitsH"))
        v_splits = _parse_num_list(kv.get("vSplits") or kv.get("vsplits") or kv.get("vSplit") or kv.get("splitsV"))
        slider_min = _parse_float(kv.get("sliderMin") or kv.get("sMin"))
        slider_max = _parse_float(kv.get("sliderMax") or kv.get("sMax"))
        slider_step = _parse_float(kv.get("sliderStep") or kv.get("sStep"))
        slider_value = _parse_float(kv.get("sliderValue") or kv.get("sValue"))
        player_spec = PlayerSpec(
          id=pid,
          space=current_space,
          src=src,
          thumbnail=thumbnail,
          poster=poster,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          labels=labels or None,
          play_label=play_label,
          pause_label=pause_label,
          h_splits=h_splits,
          v_splits=v_splits,
          rows=rows,
          cols=cols,
          slider_min=slider_min,
          slider_max=slider_max,
          slider_step=slider_step,
          slider_value=slider_value,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.players.append(player_spec)
        else:
          view_id = current_view_id or "home"
          players.append(
            PlayerSpec(
              id=pid,
              space="world",
              view_id=view_id,
              src=src,
              thumbnail=thumbnail,
              poster=poster,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              labels=labels or None,
              play_label=play_label,
              pause_label=pause_label,
              h_splits=h_splits,
              v_splits=v_splits,
              rows=rows,
              cols=cols,
              slider_min=slider_min,
              slider_max=slider_max,
              slider_step=slider_step,
              slider_value=slider_value,
            )
          )
      i += 1
      continue
    if line.startswith("webcam[") and "]" in line:
      head = line
      inner = head[len("webcam[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      wid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if wid:
        device_id = str(kv.get("deviceId", "") or kv.get("device", "")).strip() or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        labels = _parse_list(kv.get("labels") or kv.get("templates"))
        rec_label = str(kv.get("rec_label", "") or kv.get("recLabel", "")).strip() or None
        shot_label = str(kv.get("shot_label", "") or kv.get("shotLabel", "")).strip() or None
        if labels:
          rec_label = str(labels[0] or "").strip() or rec_label
          shot_label = str(labels[1] or "").strip() or shot_label
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        h_splits = _parse_num_list(kv.get("hSplits") or kv.get("hsplits") or kv.get("hSplit") or kv.get("splitsH"))
        v_splits = _parse_num_list(kv.get("vSplits") or kv.get("vsplits") or kv.get("vSplit") or kv.get("splitsV"))
        webcam_spec = WebcamSpec(
          id=wid,
          space=current_space,
          device_id=device_id,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          labels=labels or None,
          rec_label=rec_label,
          shot_label=shot_label,
          h_splits=h_splits,
          v_splits=v_splits,
          rows=rows,
          cols=cols,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.webcams.append(webcam_spec)
        else:
          view_id = current_view_id or "home"
          webcams.append(
            WebcamSpec(
              id=wid,
              space="world",
              view_id=view_id,
              device_id=device_id,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              labels=labels or None,
              rec_label=rec_label,
              shot_label=shot_label,
              h_splits=h_splits,
              v_splits=v_splits,
              rows=rows,
              cols=cols,
            )
          )
      i += 1
      continue
    if line.startswith("spectrum[") and "]" in line:
      head = line
      inner = head[len("spectrum[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      sid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if sid:
        window_s = _parse_float(kv.get("windowS") or kv.get("window") or kv.get("windowSec"))
        sample_ms = _parse_float(kv.get("sampleMs") or kv.get("sample") or kv.get("windowMs"))
        color = str(kv.get("color", "") or kv.get("lineColor", "")).strip() or None
        line_width = _parse_float(kv.get("lineWidth") or kv.get("line_width") or kv.get("strokePx") or kv.get("stroke"))
        x_label = decode_text_field(str(kv.get("xLabel", "") or kv.get("x_label", "")).strip()) or None
        y_label = decode_text_field(str(kv.get("yLabel", "") or kv.get("y_label", "")).strip()) or None
        f_label = decode_text_field(str(kv.get("fLabel", "") or kv.get("f_label", "")).strip()) or None
        f_x_label = decode_text_field(str(kv.get("fXLabel", "") or kv.get("fxLabel", "") or kv.get("f_x_label", "")).strip()) or None
        if x_label:
          f_x_label = x_label
        f_y_label = decode_text_field(str(kv.get("fYLabel", "") or kv.get("fyLabel", "") or kv.get("f_y_label", "")).strip()) or None
        run_label = str(kv.get("run_label", "") or kv.get("runLabel", "")).strip() or None
        resume_label = str(kv.get("resume_label", "") or kv.get("resumeLabel", "")).strip() or None
        pause_label = str(kv.get("pause_label", "") or kv.get("pauseLabel", "")).strip() or None
        x_min = _parse_float(kv.get("xMin") or kv.get("x_min"))
        x_max = _parse_float(kv.get("xMax") or kv.get("x_max"))
        y_min = _parse_float(kv.get("yMin") or kv.get("y_min"))
        y_max = _parse_float(kv.get("yMax") or kv.get("y_max"))
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        spec = SpectrumSpec(
          id=sid,
          space=current_space,
          window_s=window_s,
          sample_ms=sample_ms,
          color=color,
          line_width=line_width,
          y_label=y_label,
          f_label=f_label,
          f_x_label=f_x_label,
          f_y_label=f_y_label,
          run_label=run_label,
          resume_label=resume_label,
          pause_label=pause_label,
          x_min=x_min,
          x_max=x_max,
          y_min=y_min,
          y_max=y_max,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.spectra.append(spec)
        else:
          view_id = current_view_id or "home"
          spectra.append(
            SpectrumSpec(
              id=sid,
              space="world",
              view_id=view_id,
              window_s=window_s,
              sample_ms=sample_ms,
              color=color,
              line_width=line_width,
              y_label=y_label,
              f_label=f_label,
              f_x_label=f_x_label,
              f_y_label=f_y_label,
              run_label=run_label,
              resume_label=resume_label,
              pause_label=pause_label,
              x_min=x_min,
              x_max=x_max,
              y_min=y_min,
              y_max=y_max,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("sound[") and "]" in line:
      head = line
      inner = head[len("sound[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      sid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if sid:
        mode_raw = str(kv.get("mode", "") or "").strip().lower()
        if mode_raw in {"time", "pressure", "intensity"}:
          mode = "time"
        else:
          mode = "spectrum"
        window_s = _parse_float(kv.get("windowS") or kv.get("window") or kv.get("windowSec"))
        sample_ms = _parse_float(kv.get("sampleMs") or kv.get("sample") or kv.get("windowMs"))
        color = str(kv.get("color", "") or kv.get("lineColor", "")).strip() or None
        line_width = _parse_float(kv.get("lineWidth") or kv.get("line_width") or kv.get("strokePx") or kv.get("stroke"))
        y_label = decode_text_field(str(kv.get("yLabel", "") or kv.get("y_label", "")).strip()) or None
        f_label = decode_text_field(str(kv.get("fLabel", "") or kv.get("f_label", "")).strip()) or None
        t_label = decode_text_field(str(kv.get("tLabel", "") or kv.get("t_label", "")).strip()) or None
        f_x_label = decode_text_field(str(kv.get("fXLabel", "") or kv.get("fxLabel", "") or kv.get("f_x_label", "")).strip()) or None
        f_y_label = decode_text_field(str(kv.get("fYLabel", "") or kv.get("fyLabel", "") or kv.get("f_y_label", "")).strip()) or None
        t_x_label = decode_text_field(str(kv.get("tXLabel", "") or kv.get("txLabel", "") or kv.get("t_x_label", "")).strip()) or None
        t_y_label = decode_text_field(str(kv.get("tYLabel", "") or kv.get("tyLabel", "") or kv.get("t_y_label", "")).strip()) or None
        peak_label = decode_text_field(str(kv.get("peakLabel", "") or kv.get("peak_label", "")).strip()) or None
        f_output_col = str(kv.get("fOutputCol", "") or kv.get("f_output_col", "") or kv.get("fOutput", "")).strip() or None
        t_output_col = str(kv.get("tOutputCol", "") or kv.get("t_output_col", "") or kv.get("tOutput", "")).strip() or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        run_label = str(kv.get("run_label", "") or kv.get("runLabel", "")).strip() or None
        resume_label = str(kv.get("resume_label", "") or kv.get("resumeLabel", "")).strip() or None
        pause_label = str(kv.get("pause_label", "") or kv.get("pauseLabel", "")).strip() or None
        reset_label = str(kv.get("reset_label", "") or kv.get("resetLabel", "")).strip() or None
        home_label = str(kv.get("home_label", "") or kv.get("homeLabel", "")).strip() or None
        freq_mode_label = str(kv.get("freqModeLabel", "") or kv.get("freq_mode_label", "")).strip() or None
        time_mode_label = str(kv.get("timeModeLabel", "") or kv.get("time_mode_label", "")).strip() or None
        freq_button_label = str(kv.get("freqButtonLabel", "") or kv.get("freq_button_label", "")).strip() or None
        time_button_label = str(kv.get("timeButtonLabel", "") or kv.get("time_button_label", "")).strip() or None
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        h_splits = _parse_num_list(kv.get("hSplits") or kv.get("hsplits") or kv.get("hSplit") or kv.get("splitsH"))
        v_splits = _parse_num_list(kv.get("vSplits") or kv.get("vsplits") or kv.get("vSplit") or kv.get("splitsV"))
        sound_spec = SoundSpec(
          id=sid,
          space=current_space,
          mode=mode,
          window_s=window_s,
          sample_ms=sample_ms,
          color=color,
          line_width=line_width,
          y_label=y_label,
          f_label=f_label,
          t_label=t_label,
          f_x_label=f_x_label,
          f_y_label=f_y_label,
          t_x_label=t_x_label,
          t_y_label=t_y_label,
          peak_label=peak_label,
          f_output_col=f_output_col,
          t_output_col=t_output_col,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          run_label=run_label,
          resume_label=resume_label,
          pause_label=pause_label,
          reset_label=reset_label,
          home_label=home_label,
          freq_mode_label=freq_mode_label,
          time_mode_label=time_mode_label,
          freq_button_label=freq_button_label,
          time_button_label=time_button_label,
          h_splits=h_splits,
          v_splits=v_splits,
          rows=rows,
          cols=cols,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.sounds.append(sound_spec)
        else:
          view_id = current_view_id or "home"
          sounds.append(
            SoundSpec(
              id=sid,
              space="world",
              view_id=view_id,
              mode=mode,
              window_s=window_s,
              sample_ms=sample_ms,
              color=color,
              line_width=line_width,
              y_label=y_label,
              f_label=f_label,
              t_label=t_label,
              f_x_label=f_x_label,
              f_y_label=f_y_label,
              t_x_label=t_x_label,
              t_y_label=t_y_label,
              peak_label=peak_label,
              f_output_col=f_output_col,
              t_output_col=t_output_col,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              run_label=run_label,
              resume_label=resume_label,
              pause_label=pause_label,
              reset_label=reset_label,
              home_label=home_label,
              freq_mode_label=freq_mode_label,
              time_mode_label=time_mode_label,
              freq_button_label=freq_button_label,
              time_button_label=time_button_label,
              h_splits=h_splits,
              v_splits=v_splits,
              rows=rows,
              cols=cols,
            )
          )
      i += 1
      continue
    if line.startswith("pressure[") and "]" in line:
      head = line
      inner = head[len("pressure[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      sid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if sid:
        window_s = _parse_float(kv.get("windowS") or kv.get("window") or kv.get("windowSec"))
        sample_ms = _parse_float(kv.get("sampleMs") or kv.get("sample") or kv.get("windowMs"))
        color = str(kv.get("color", "") or kv.get("lineColor", "")).strip() or None
        line_width = _parse_float(kv.get("lineWidth") or kv.get("line_width") or kv.get("strokePx") or kv.get("stroke"))
        x_label = decode_text_field(str(kv.get("xLabel", "") or kv.get("x_label", "")).strip()) or None
        y_label = decode_text_field(str(kv.get("yLabel", "") or kv.get("y_label", "")).strip()) or None
        peak_label = decode_text_field(str(kv.get("peakLabel", "") or kv.get("peak_label", "")).strip()) or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        run_label = str(kv.get("run_label", "") or kv.get("runLabel", "")).strip() or None
        resume_label = str(kv.get("resume_label", "") or kv.get("resumeLabel", "")).strip() or None
        pause_label = str(kv.get("pause_label", "") or kv.get("pauseLabel", "")).strip() or None
        pressure_spec = PressureSpec(
          id=sid,
          space=current_space,
          window_s=window_s,
          sample_ms=sample_ms,
          color=color,
          line_width=line_width,
          x_label=x_label,
          y_label=y_label,
          peak_label=peak_label,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          run_label=run_label,
          resume_label=resume_label,
          pause_label=pause_label,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.pressures.append(pressure_spec)
        else:
          view_id = current_view_id or "home"
          pressures.append(
            PressureSpec(
              id=sid,
              space="world",
              view_id=view_id,
              window_s=window_s,
              sample_ms=sample_ms,
              color=color,
              line_width=line_width,
              x_label=x_label,
              y_label=y_label,
              peak_label=peak_label,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              run_label=run_label,
              resume_label=resume_label,
              pause_label=pause_label,
            )
          )
      i += 1
      continue
    if line.startswith("timer[") and "]" in line:
      head = line
      inner = head[len("timer[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      tid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if tid:
        duration_s = _parse_float(kv.get("durationS") or kv.get("duration") or kv.get("durationSec") or kv.get("seconds") or kv.get("sec"))
        duration_ms = _parse_float(kv.get("durationMs") or kv.get("durationMS") or kv.get("ms"))
        if duration_s is None and duration_ms is not None:
          duration_s = duration_ms / 1000.0
        sample_ms = _parse_float(kv.get("sampleMs") or kv.get("sample") or kv.get("tickMs"))
        bins = _parse_bins(kv.get("bins") or kv.get("binEdges") or kv.get("edges"))
        show_time = _parse_bool(kv.get("showTime") or kv.get("show_time"))
        debug = _parse_bool(kv.get("debug"))
        stat = str(kv.get("stat", "")).strip() or None
        color = str(kv.get("color", "") or kv.get("lineColor", "")).strip() or None
        bar_color = str(kv.get("barColor", "") or kv.get("bar_color", "")).strip() or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        start_label = decode_text_field(str(kv.get("startLabel", "") or kv.get("start_label", "")).strip()) or None
        stop_label = decode_text_field(str(kv.get("stopLabel", "") or kv.get("stop_label", "")).strip()) or None
        reset_label = decode_text_field(str(kv.get("resetLabel", "") or kv.get("reset_label", "")).strip()) or None
        x_label = decode_text_field(str(kv.get("xLabel", "") or kv.get("x_label", "")).strip()) or None
        y_label = decode_text_field(str(kv.get("yLabel", "") or kv.get("y_label", "")).strip()) or None
        value_label = decode_text_field(str(kv.get("valueLabel", "") or kv.get("value_label", "")).strip()) or None
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        h_splits = _parse_num_list(kv.get("hSplits") or kv.get("hsplits") or kv.get("hSplit") or kv.get("splitsH"))
        v_splits = _parse_num_list(kv.get("vSplits") or kv.get("vsplits") or kv.get("vSplit") or kv.get("splitsV"))
        timer_spec = TimerSpec(
          id=tid,
          space=current_space,
          duration_s=duration_s,
          sample_ms=sample_ms,
          bins=bins,
          show_time=show_time,
          debug=debug,
          stat=stat,
          color=color,
          bar_color=bar_color,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          start_label=start_label,
          stop_label=stop_label,
          reset_label=reset_label,
          x_label=x_label,
          y_label=y_label,
          value_label=value_label,
          h_splits=h_splits,
          v_splits=v_splits,
          rows=rows,
          cols=cols,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.timers.append(timer_spec)
        else:
          view_id = current_view_id or "home"
          timers.append(
            TimerSpec(
              id=tid,
              space="world",
              view_id=view_id,
              duration_s=duration_s,
              sample_ms=sample_ms,
              bins=bins,
              show_time=show_time,
              debug=debug,
              stat=stat,
              color=color,
              bar_color=bar_color,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              start_label=start_label,
              stop_label=stop_label,
              reset_label=reset_label,
              x_label=x_label,
              y_label=y_label,
              value_label=value_label,
              h_splits=h_splits,
              v_splits=v_splits,
              rows=rows,
              cols=cols,
            )
          )
      i += 1
      continue
    if line.startswith("multichoice[") and "]" in line:
      close_idx = line.rfind("]")
      head = line[: close_idx + 1]
      tail = line[close_idx + 1 :]
      body = tail[1:] if tail.lstrip().startswith(":") else ""
      inner = head[len("multichoice[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      mid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if mid:
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
            if _is_element_header(nxt):
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        answers = _parse_answers(kv.get("answers") or kv.get("answer"))
        choice_type = str(kv.get("type", "") or kv.get("choiceType", "")).strip() or None
        question = decode_text_field(body.strip()) or decode_text_field(str(kv.get("question", "")).strip()) or None
        other_label = decode_text_field(str(kv.get("otherLabel", "") or kv.get("other_label", "")).strip()) or None
        other_limit = _parse_float(kv.get("otherLimit", "") or kv.get("other_limit", ""))
        start_label = decode_text_field(str(kv.get("startLabel", "") or kv.get("start_label", "")).strip()) or None
        stop_label = decode_text_field(str(kv.get("stopLabel", "") or kv.get("stop_label", "")).strip()) or None
        reset_label = decode_text_field(str(kv.get("resetLabel", "") or kv.get("reset_label", "")).strip()) or None
        show_wheel = _parse_bool(kv.get("showWheel") or kv.get("show_wheel") or kv.get("wheel"))
        mc_spec = MultiChoiceSpec(
          id=mid,
          space=current_space,
          answers=answers,
          choice_type=choice_type,
          question=question,
          other_label=other_label,
          other_limit=other_limit,
          start_label=start_label,
          stop_label=stop_label,
          reset_label=reset_label,
          show_wheel=show_wheel,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.multichoices.append(mc_spec)
        else:
          view_id = current_view_id or "home"
          multichoices.append(
            MultiChoiceSpec(
              id=mid,
              space="world",
              view_id=view_id,
              answers=answers,
              choice_type=choice_type,
              question=question,
              other_label=other_label,
              other_limit=other_limit,
              start_label=start_label,
              stop_label=stop_label,
              reset_label=reset_label,
              show_wheel=show_wheel,
            )
          )
      i += 1
      continue
    if line.startswith("wheel[") and "]" in line:
      close_idx = line.rfind("]")
      head = line[: close_idx + 1]
      inner = head[len("wheel[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      wid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if wid:
        answers = _parse_answers(kv.get("answers") or kv.get("answer"))
        choice_type = str(kv.get("type", "") or kv.get("choiceType", "")).strip() or None
        other_label = decode_text_field(str(kv.get("otherLabel", "") or kv.get("other_label", "")).strip()) or None
        other_limit = _parse_float(kv.get("otherLimit", "") or kv.get("other_limit", ""))
        wheel_spec = WheelSpec(
          id=wid,
          space=current_space,
          answers=answers,
          choice_type=choice_type,
          other_label=other_label,
          other_limit=other_limit,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.wheels.append(wheel_spec)
        else:
          view_id = current_view_id or "home"
          wheels.append(
            WheelSpec(
              id=wid,
              space="world",
              view_id=view_id,
              answers=answers,
              choice_type=choice_type,
              question=question,
              other_label=other_label,
              other_limit=other_limit,
            )
          )
      i += 1
      continue
    if line.startswith("camera[") and "]" in line:
      head = line
      inner = head[len("camera[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      cid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if cid:
        device_id = str(kv.get("deviceId", "") or kv.get("device", "")).strip() or None
        bg_color = str(kv.get("bgColor", "")).strip() or None
        bg_alpha_raw = str(kv.get("bgAlpha", "")).strip()
        try:
          bg_alpha = float(bg_alpha_raw) if bg_alpha_raw else None
        except ValueError:
          bg_alpha = None
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        camera_spec = CameraSpec(
          id=cid,
          space=current_space,
          device_id=device_id,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.cameras.append(camera_spec)
        else:
          view_id = current_view_id or "home"
          cameras.append(
            CameraSpec(
              id=cid,
              space="world",
              view_id=view_id,
              device_id=device_id,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("group[") and "]" in line:
      head = line
      inner = head[len("group[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      gid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if gid:
        group_spec = GroupSpec(id=gid, space=current_space)
        if current_space == "screen":
          screen = ensure_screen()
          screen.groups.append(group_spec)
        else:
          view_id = current_view_id or "home"
          groups.append(GroupSpec(id=gid, space="world", view_id=view_id))
      i += 1
      continue
    if line.startswith("arrow[") and "]" in line:
      head = line
      inner = head[len("arrow[") : head.rfind("]")]
      parts = _split_attrs(inner)
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
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        arrow_spec = ArrowSpec(
          id=aid,
          start=start,
          end=end,
          space=current_space,
          color=color,
          stroke_px=stroke_px,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
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
              bg_padding=bg_padding,
              bg_radius=bg_radius,
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
            if _is_element_header(nxt):
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
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        join_spec = JoinSpec(
          id=jid,
          fields=fields,
          text=decode_text_field(body.strip()),
          space=current_space,
          color=color,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
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
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("bullets[") and "]" in line:
      head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
      inner = head[len("bullets[") : head.rfind("]")]
      parts = _split_attrs(inner)
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
            if _is_element_header(nxt):
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
        bg_padding = _parse_float(kv.get("bgPadding", ""))
        bg_radius = _parse_float(kv.get("bgRadius", ""))
        bullets_type = str(kv.get("type", "")).strip() or None
        bullet_spec = BulletsSpec(
          id=bid,
          text=decode_text_field(body.strip()),
          bullets=bullets_type,
          space=current_space,
          align=align,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
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
              bg_padding=bg_padding,
              bg_radius=bg_radius,
            )
          )
      i += 1
      continue
    if line.startswith("table[") and "]" in line:
      head, body = (line.split(":", 1) + [""])[:2] if ":" in line else (line, "")
      inner = head[len("table[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      tid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if tid:
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
            if nxt.startswith(
              (
                "view[",
                "text[",
                "image[",
                "bullets[",
                "table[",
                "sound[",
                "spectrum[",
                "arrow[",
                "join[",
                "multichoice[",
                "wheel[",
                "timer[",
              )
            ) and "]" in nxt:
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        editable = _parse_bool(kv.get("editable") or kv.get("edit"))
        h_header = _parse_header_list(kv.get("hHeader") or kv.get("h_header"))
        v_header = _parse_header_list(kv.get("vHeader") or kv.get("v_header"))
        h_style = _parse_style_list(kv.get("hStyle") or kv.get("h_style"))
        color = str(kv.get("color", "") or kv.get("textColor", "")).strip() or None
        bg_color = str(kv.get("bgColor", "") or kv.get("bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        cells = _parse_table_cells(body.strip() if body else None)
        table_spec = TableSpec(
          id=tid,
          space=current_space,
          rows=rows,
          cols=cols,
          editable=editable,
          h_header=h_header,
          v_header=v_header,
          h_style=h_style,
          color=color,
          bg_color=bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          cells=cells,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.tables.append(table_spec)
        else:
          view_id = current_view_id or "home"
          tables.append(
            TableSpec(
              id=tid,
              space="world",
              view_id=view_id,
              rows=rows,
              cols=cols,
              editable=editable,
              h_header=h_header,
              v_header=v_header,
              h_style=h_style,
              color=color,
              bg_color=bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              cells=cells,
            )
          )
      i += 1
      continue
    if line.startswith("experiment["):
      head_line = line
      head_end = i
      if "]" not in head_line:
        j = i + 1
        while j < len(lines):
          nxt_raw = lines[j]
          head_line = head_line.rstrip("\n") + " " + nxt_raw.strip("\n")
          head_end = j
          if "]" in nxt_raw:
            break
          j += 1
      if "]" not in head_line:
        i += 1
        continue
      close_idx = head_line.rfind("]")
      head = head_line[: close_idx + 1]
      tail = head_line[close_idx + 1 :]
      body = tail[1:] if tail.lstrip().startswith(":") else ""
      inner = head[len("experiment[") : head.rfind("]")]
      parts = _split_attrs(inner)
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      eid = str(kv.get("id", "") or kv.get("name", "")).strip()
      if eid:
        if not body.strip():
          j = head_end + 1
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
            if nxt.startswith(
              (
                "view[",
                "text[",
                "image[",
                "bullets[",
                "table[",
                "experiment[",
                "sound[",
                "spectrum[",
                "arrow[",
                "join[",
                "multichoice[",
                "wheel[",
                "timer[",
              )
            ) and "]" in nxt:
              break
            body_lines.append(nxt_raw.rstrip("\n"))
            j += 1
          if body_lines:
            body = "\n".join(body_lines)
            i = j - 1
          else:
            i = head_end
        rows_raw = str(kv.get("rows", "") or "").strip()
        cols_raw = str(kv.get("cols", "") or "").strip()
        rows = int(float(rows_raw)) if rows_raw else None
        cols = int(float(cols_raw)) if cols_raw else None
        editable = _parse_bool(kv.get("editable") or kv.get("edit"))
        h_header = _parse_header_list(kv.get("hHeader") or kv.get("h_header"))
        v_header = _parse_header_list(kv.get("vHeader") or kv.get("v_header"))
        h_style = _parse_style_list(kv.get("hStyle") or kv.get("h_style"))
        title = decode_text_field(str(kv.get("title", "") or kv.get("nameLabel", "")).strip()) or None
        transforms = _parse_header_list(kv.get("transforms") or kv.get("transform"))
        fit_label = decode_text_field(str(kv.get("fitLabel", "") or kv.get("fit_label", "")).strip()) or None
        fit_button_label = decode_text_field(str(kv.get("fitButtonLabel", "") or kv.get("fit_button_label", "")).strip()) or None
        clear_label = decode_text_field(str(kv.get("clearLabel", "") or kv.get("clear_label", "")).strip()) or None
        line_color = str(kv.get("lineColor", "") or kv.get("line_color", "")).strip() or None
        data_color = str(kv.get("dataColor", "") or kv.get("data_color", "")).strip() or None
        table_bg_color = str(kv.get("tableBgColor", "") or kv.get("table_bg_color", "")).strip() or None
        axis_bg_color = str(kv.get("axisBgColor", "") or kv.get("axis_bg_color", "")).strip() or None
        bg_alpha = _parse_float(kv.get("bgAlpha") or kv.get("bg_alpha"))
        bg_padding = _parse_float(kv.get("bgPadding") or kv.get("bg_padding"))
        bg_radius = _parse_float(kv.get("bgRadius") or kv.get("bg_radius"))
        cells = _parse_table_cells(body.strip() if body else None)
        exp_spec = ExperimentSpec(
          id=eid,
          space=current_space,
          title=title,
          transforms=transforms,
          fit_label=fit_label,
          fit_button_label=fit_button_label,
          clear_label=clear_label,
          line_color=line_color,
          data_color=data_color,
          rows=rows,
          cols=cols,
          editable=editable,
          h_header=h_header,
          v_header=v_header,
          h_style=h_style,
          table_bg_color=table_bg_color,
          axis_bg_color=axis_bg_color,
          bg_alpha=bg_alpha,
          bg_padding=bg_padding,
          bg_radius=bg_radius,
          cells=cells,
        )
        if current_space == "screen":
          screen = ensure_screen()
          screen.experiments.append(exp_spec)
        else:
          view_id = current_view_id or "home"
          experiments.append(
            ExperimentSpec(
              id=eid,
              space="world",
              view_id=view_id,
              title=title,
              transforms=transforms,
              fit_label=fit_label,
              fit_button_label=fit_button_label,
              clear_label=clear_label,
              line_color=line_color,
              data_color=data_color,
              rows=rows,
              cols=cols,
              editable=editable,
              h_header=h_header,
              v_header=v_header,
              h_style=h_style,
              table_bg_color=table_bg_color,
              axis_bg_color=axis_bg_color,
              bg_alpha=bg_alpha,
              bg_padding=bg_padding,
              bg_radius=bg_radius,
              cells=cells,
            )
          )
      i += 1
      continue
    i += 1
  if not views:
    views = [ViewSpec(id="home")]
  return PresentationSpec(
    views=views,
    texts=texts,
    bullets=bullets,
    arrows=arrows,
    joins=joins,
    images=images,
    iframes=iframes,
    videos=videos,
    cameras=cameras,
    axes=axes,
    buttons=buttons,
    sliders=sliders,
    players=players,
    webcams=webcams,
    sounds=sounds,
    pressures=pressures,
    spectra=spectra,
    timers=timers,
    tables=tables,
    experiments=experiments,
    multichoices=multichoices,
    wheels=wheels,
    groups=groups,
    screens=screens,
  )
