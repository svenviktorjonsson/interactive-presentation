from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class JoinModuleAdapter:
  module_type = "join"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: JoinSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    node: dict[str, Any] = {
      "id": spec.id,
      "type": "join",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "fields": list(spec.fields or []),
      "text": format_template(spec.text, {}),
      "template": spec.text,
    }
    if spec.color:
      node["color"] = spec.color
    if getattr(spec, "bg_color", None):
      node["bgColor"] = spec.bg_color
    if getattr(spec, "bg_alpha", None) is not None:
      node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      node["bgRadius"] = spec.bg_radius
    ctx.append_node(node, view_id=view_id, space=space, layer=layer)
