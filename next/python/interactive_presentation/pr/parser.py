from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ViewSpec:
  id: str


@dataclass(frozen=True)
class TextSpec:
  id: str
  text: str


@dataclass(frozen=True)
class PresentationSpec:
  views: list[ViewSpec]
  texts: list[TextSpec]


def parse_presentation_pr(path: str | Path) -> PresentationSpec:
  """
  Minimal `.pr` parser for Milestone 4:
  - view[id=home]
  - text[id=t1]: hello

  Everything else is ignored for now.
  """
  p = Path(path)
  s = p.read_text(encoding="utf-8")
  views: list[ViewSpec] = []
  texts: list[TextSpec] = []
  for raw in s.splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
      continue
    if line.startswith("view[") and line.endswith("]"):
      inner = line[len("view[") : -1]
      # super-minimal: id=...
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      vid = str(kv.get("id", "")).strip()
      if vid:
        views.append(ViewSpec(id=vid))
      continue
    if line.startswith("text[") and "]" in line and ":" in line:
      head, body = line.split(":", 1)
      inner = head[len("text[") : head.rfind("]")]
      parts = [x.strip() for x in inner.split(",") if x.strip()]
      kv = dict(x.split("=", 1) for x in parts if "=" in x)
      tid = str(kv.get("id", "")).strip()
      if tid:
        texts.append(TextSpec(id=tid, text=body.strip()))
      continue
  if not views:
    views = [ViewSpec(id="home")]
  return PresentationSpec(views=views, texts=texts)

