from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class WebcamModuleAdapter:
  module_type = "webcam"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: WebcamSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "webcamId": base_id,
      "transform": transform,
    }
    if getattr(spec, "bg_color", None):
      group_node["bgColor"] = spec.bg_color
    if getattr(spec, "bg_alpha", None) is not None:
      group_node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      group_node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      group_node["bgRadius"] = spec.bg_radius
    ctx.apply_element_defaults(group_node, "webcam")
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    local_override = ctx.local_override_factory(base_id)
    rec_label = str(getattr(spec, "rec_label", None) or (spec.labels[0] if spec.labels else "") or "Rec")
    shot_label = str(getattr(spec, "shot_label", None) or (spec.labels[1] if spec.labels and len(spec.labels) > 1 else "") or "Shot")

    camera_local = local_override(
      f"{base_id}_camera",
      {"x": 0.5, "y": 0.4, "w": 0.92, "h": 0.7, "rotationDeg": 0, "anchor": "centerCenter"},
    )
    camera_node: dict[str, Any] = {
      "id": f"{base_id}_camera",
      "type": "camera",
      "space": space,
      "groupId": base_id,
      "webcamId": base_id,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(camera_local),
      "groupLocal": camera_local,
    }
    if spec.device_id:
      camera_node["deviceId"] = spec.device_id
    ctx.append_node(camera_node, view_id=view_id, space=space, layer=layer)

    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.5, "y": 0.86, "w": 0.92, "h": 0.18, "rotationDeg": 0, "anchor": "centerCenter"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "playerId": base_id,
      "webcamId": base_id,
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": [rec_label, shot_label],
      "templates": [rec_label, shot_label],
      "actions": ["rec", "shot"],
    }
    ctx.apply_element_defaults(buttons_node, "buttons")
    if spec.h_splits:
      buttons_node["hSplits"] = [float(x) for x in spec.h_splits]
    if spec.v_splits:
      buttons_node["vSplits"] = [float(x) for x in spec.v_splits]
    if spec.rows is not None:
      buttons_node["rows"] = int(spec.rows)
    if spec.cols is not None:
      buttons_node["cols"] = int(spec.cols)
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)
