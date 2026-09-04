from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class PressureModuleAdapter:
  module_type = "pressure"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: PressureSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    window_s = float(getattr(spec, "window_s", None) or 30.0)
    sample_ms = float(getattr(spec, "sample_ms", None) or 1.0)
    color = str(getattr(spec, "color", "") or "white")
    line_width = float(getattr(spec, "line_width", None) or 1.0)
    x_label = str(getattr(spec, "x_label", None) or "Time (s)")
    y_label = str(getattr(spec, "y_label", None) or "Pressure")
    peak_label = str(getattr(spec, "peak_label", None) or "Peak t (s)")
    run_label = str(getattr(spec, "run_label", None) or "Run")
    resume_label = str(getattr(spec, "resume_label", None) or "Resume")
    pause_label = str(getattr(spec, "pause_label", None) or "Pause")
    reset_label = str(getattr(spec, "reset_label", None) or "Reset")

    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "pressureId": base_id,
      "pressureRole": "root",
      "pressureWindowS": window_s,
      "pressureSampleMs": sample_ms,
      "pressureColor": color,
      "pressureLineWidth": line_width,
      "pressureRunLabel": run_label,
      "pressureResumeLabel": resume_label,
      "pressurePauseLabel": pause_label,
      "pressureResetLabel": reset_label,
      "pressureXLabel": x_label,
      "pressureYLabel": y_label,
      "pressurePeakLabel": peak_label,
    }
    if getattr(spec, "bg_color", None):
      group_node["bgColor"] = spec.bg_color
    if getattr(spec, "bg_alpha", None) is not None:
      group_node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      group_node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      group_node["bgRadius"] = spec.bg_radius
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    local_override = ctx.local_override_factory(base_id)
    max_points = int(max(200, min(10_000, (window_s * 1000.0) / max(1e-6, sample_ms))))
    axis_local = local_override(
      f"{base_id}_axis",
      {"x": 0.0, "y": 0.1437880536957677, "w": 0.7301225711717918, "h": 0.8562119463042323, "rotationDeg": 0, "anchor": "topLeft"},
    )
    axis_node: dict[str, Any] = {
      "id": f"{base_id}_axis",
      "type": "axis",
      "space": space,
      "groupId": base_id,
      "pressureId": base_id,
      "pressureRole": "axis",
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(axis_local),
      "groupLocal": axis_local,
      "limits": {"xMin": 0.0, "xMax": window_s, "yMin": 0.0, "yMax": 1.1},
      "clamp": True,
      "padPx": 40,
      "lineWidth": line_width,
      "maxPoints": max_points,
    }
    ctx.append_node(axis_node, view_id=view_id, space=space, layer=layer)

    tpl_data = {"runPauseResume": run_label, "resetLabel": reset_label, "xLabel": x_label, "yLabel": y_label, "peakLabel": peak_label}
    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.12660755594922043, "y": 0.0023648634072202515, "w": 0.15017711947865328, "h": 0.0845995902030589, "rotationDeg": 0, "anchor": "topLeft"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "pressureId": base_id,
      "pressureRole": "buttons",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": [format_template("{{runPauseResume}}", tpl_data), format_template("{{resetLabel}}", tpl_data)],
      "templates": ["{{runPauseResume}}", "{{resetLabel}}"],
      "actions": ["pressure-toggle", "pressure-reset"],
      "buttonsMode": "click",
      "rows": 1,
      "cols": 2,
    }
    ctx.apply_element_defaults(buttons_node, "buttons")
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)

    threshold_local = local_override(
      f"{base_id}_threshold",
      {"x": 0.294, "y": 0.012, "w": 0.32, "h": 0.06, "rotationDeg": 0, "anchor": "topLeft"},
    )
    threshold_node: dict[str, Any] = {
      "id": f"{base_id}_threshold",
      "type": "slider",
      "space": space,
      "groupId": base_id,
      "pressureId": base_id,
      "pressureRole": "threshold",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(threshold_local),
      "groupLocal": threshold_local,
      "min": 0.0,
      "max": 1.0,
      "step": 0.01,
      "value": 0.5,
      "orientation": "horizontal",
    }
    ctx.append_node(threshold_node, view_id=view_id, space=space, layer=layer)

    def _text_node(node_id: str, template: str, local_t: dict[str, Any], *, align: str = "center", font_px: float = 34.0) -> dict[str, Any]:
      return {
        "id": node_id,
        "type": "text",
        "space": space,
        "groupId": base_id,
        "pressureId": base_id,
        "pressureRole": "label",
        "zIndex": 2,
        "visible": True,
        "opacity": 1,
        "transform": child_transform(local_t),
        "groupLocal": local_t,
        "text": format_template(template, tpl_data),
        "template": template,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": font_px,
        "align": align,
      }

    ctx.append_node(
      _text_node(
        f"{base_id}_x_label",
        "{{xLabel}}",
        local_override(
          f"{base_id}_x_label",
          {"x": 0.20362784919063148, "y": 0.930868235814702, "w": 0.33995807476885903, "h": 0.07657829787155672, "rotationDeg": 0, "anchor": "topLeft"},
        ),
      ),
      view_id=view_id,
      space=space,
      layer=layer,
    )
    ctx.append_node(
      _text_node(
        f"{base_id}_y_label",
        "{{yLabel}}",
        local_override(
          f"{base_id}_y_label",
          {"x": 0.0025537745269467935, "y": 0.5228656882315988, "w": 0.16778503389913302, "h": 0.06830016458244109, "rotationDeg": -90, "anchor": "topLeft"},
        ),
      ),
      view_id=view_id,
      space=space,
      layer=layer,
    )

    table_local = local_override(
      f"{base_id}_table",
      {"x": 0.76, "y": 0.16, "w": 0.23, "h": 0.7, "rotationDeg": 0, "anchor": "topLeft"},
    )
    table_node: dict[str, Any] = {
      "id": f"{base_id}_table",
      "type": "table",
      "space": space,
      "groupId": base_id,
      "pressureId": base_id,
      "pressureRole": "table",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(table_local),
      "groupLocal": table_local,
      "rows": 12,
      "cols": 1,
      "editable": True,
      "hHeader": [peak_label],
      "hStyle": ["center"],
      "bgColor": "white",
      "color": "black",
    }
    ctx.apply_element_defaults(table_node, "table")
    if table_node.get("bgColor") is None:
      table_node["bgColor"] = "white"
    if table_node.get("color") is None:
      table_node["color"] = "black"
    ctx.append_node(table_node, view_id=view_id, space=space, layer=layer)
