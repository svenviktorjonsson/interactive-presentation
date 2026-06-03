from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class PlayerModuleAdapter:
  module_type = "player"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: PlayerSpec,
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
      "playerId": base_id,
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
    ctx.apply_element_defaults(group_node, "player")
    ctx.apply_element_defaults(group_node, "video")
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    local_override = ctx.local_override_factory(base_id)
    play_label = str(getattr(spec, "play_label", None) or (spec.labels[0] if spec.labels else "") or "Play")
    pause_label = str(getattr(spec, "pause_label", None) or (spec.labels[1] if spec.labels and len(spec.labels) > 1 else "") or "Pause")
    labels_tpl = [play_label]
    labels = [format_template(value, {}) for value in labels_tpl]

    video_local = local_override(
      f"{base_id}_video",
      {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.6, "rotationDeg": 0, "anchor": "topLeft"},
    )
    video_node: dict[str, Any] = {
      "id": f"{base_id}_video",
      "type": "video",
      "space": space,
      "groupId": base_id,
      "playerId": base_id,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(video_local),
      "groupLocal": video_local,
      "src": _resolve_media_src(spec.src),
      "showControls": False,
    }
    if play_label:
      video_node["playLabel"] = play_label
    if pause_label:
      video_node["pauseLabel"] = pause_label
    if spec.thumbnail:
      video_node["thumbnail"] = _resolve_media_src(spec.thumbnail)
    if spec.poster:
      video_node["poster"] = _resolve_media_src(spec.poster)
    ctx.append_node(video_node, view_id=view_id, space=space, layer=layer)

    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.05, "y": 0.72, "w": 0.18, "h": 0.12, "rotationDeg": 0, "anchor": "topLeft"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "playerId": base_id,
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": labels,
      "templates": labels_tpl,
      "actions": ["toggle"],
    }
    if play_label:
      buttons_node["playLabel"] = play_label
    if pause_label:
      buttons_node["pauseLabel"] = pause_label
    ctx.apply_element_defaults(buttons_node, "buttons")
    if not spec.h_splits and not spec.v_splits and spec.rows is None and spec.cols is None:
      buttons_node["rows"] = 1
      buttons_node["cols"] = 1
    if spec.h_splits:
      buttons_node["hSplits"] = [float(x) for x in spec.h_splits]
    if spec.v_splits:
      buttons_node["vSplits"] = [float(x) for x in spec.v_splits]
    if spec.rows is not None:
      buttons_node["rows"] = int(spec.rows)
    if spec.cols is not None:
      buttons_node["cols"] = int(spec.cols)
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)

    slider_local = local_override(
      f"{base_id}_slider",
      {"x": 0.26, "y": 0.72, "w": 0.69, "h": 0.12, "rotationDeg": 0, "anchor": "topLeft"},
    )
    slider_node: dict[str, Any] = {
      "id": f"{base_id}_slider",
      "type": "slider",
      "space": space,
      "groupId": base_id,
      "playerId": base_id,
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(slider_local),
      "groupLocal": slider_local,
      "min": float(spec.slider_min) if spec.slider_min is not None else 0.0,
      "max": float(spec.slider_max) if spec.slider_max is not None else 1.0,
      "step": float(spec.slider_step) if spec.slider_step is not None else 0.001,
      "value": float(spec.slider_value) if spec.slider_value is not None else 0.0,
    }
    ctx.append_node(slider_node, view_id=view_id, space=space, layer=layer)
