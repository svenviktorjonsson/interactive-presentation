from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol

from ...pr.parser import (
  ExperimentSpec,
  JoinSpec,
  MultiChoiceSpec,
  PlayerSpec,
  PressureSpec,
  SoundSpec,
  SpectrumSpec,
  TimerSpec,
  WebcamSpec,
)
from ...pr.template import format_template


@dataclass
class CompositeRenderContext:
  nodes: list[dict[str, Any]]
  apply_element_defaults: Callable[[dict[str, Any], str], None]
  group_local_to_world: Callable[[dict[str, Any], dict[str, float]], dict[str, float]]
  local_override_factory: Callable[[str], Callable[[str, dict[str, Any]], dict[str, Any]]]
  parse_bullet_lines: Callable[[str], list[dict[str, Any]]]

  def append_node(self, node: dict[str, Any], *, view_id: str | None, space: str, layer: str | None) -> None:
    if view_id and space != "screen":
      node["viewId"] = view_id
    if layer:
      node["layer"] = layer
    self.nodes.append(node)


class CompositeModuleAdapter(Protocol):
  module_type: str

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: Any,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None: ...


def _child_transformer(
  ctx: CompositeRenderContext,
  group_t: dict[str, Any],
) -> Callable[[dict[str, Any]], dict[str, Any]]:
  group_w = float(group_t.get("w", 0.0) or 0.0)
  group_h = float(group_t.get("h", 0.0) or 0.0)
  group_rot = float(group_t.get("rotationDeg", 0.0) or 0.0)

  def _child_transform(local_t: dict[str, Any]) -> dict[str, Any]:
    local_x = float(local_t.get("x", 0.0))
    local_y = float(local_t.get("y", 0.0))
    anchor_world = ctx.group_local_to_world(group_t, {"x": local_x, "y": local_y})
    return {
      **local_t,
      "x": anchor_world["x"],
      "y": anchor_world["y"],
      "w": float(local_t.get("w", 0.0)) * max(1e-9, group_w),
      "h": float(local_t.get("h", 0.0)) * max(1e-9, group_h),
      "rotationDeg": float(local_t.get("rotationDeg", 0.0) or 0.0) + group_rot,
    }

  return _child_transform


def _resolve_media_src(raw: str | None) -> str | None:
  src = str(raw or "").strip()
  if not src:
    return None
  if src.startswith(("http://", "https://", "/")):
    return src
  return f"/media/{src}"


