from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class TimerModuleAdapter:
  module_type = "timer"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: TimerSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    local_override = ctx.local_override_factory(base_id)
    duration_s = float(getattr(spec, "duration_s", None) or 10.0)
    sample_ms = float(getattr(spec, "sample_ms", None) or 100.0)
    bins = list(getattr(spec, "bins", None) or [])
    show_time = getattr(spec, "show_time", None)
    debug = getattr(spec, "debug", None)
    stat = str(getattr(spec, "stat", None) or "")
    color = str(getattr(spec, "color", None) or "white")
    bar_color = str(getattr(spec, "bar_color", None) or "")
    start_label = str(getattr(spec, "start_label", None) or "Start")
    stop_label = str(getattr(spec, "stop_label", None) or "Stop")
    reset_label = str(getattr(spec, "reset_label", None) or "Reset")
    x_label = str(getattr(spec, "x_label", None) or "Time (s)")
    y_label = str(getattr(spec, "y_label", None) or "Progress")
    value_label = str(getattr(spec, "value_label", None) or "{{elapsed:.2f}} s")

    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "timerId": base_id,
      "timerRole": "root",
      "timerDurationS": duration_s,
      "timerSampleMs": sample_ms,
      "timerShowTime": True if show_time is None else bool(show_time),
      "timerDebug": bool(debug) if debug is not None else False,
      "timerStat": stat,
      "timerColor": color,
      "timerBarColor": bar_color,
      "timerStartLabel": start_label,
      "timerStopLabel": stop_label,
      "timerResetLabel": reset_label,
      "timerXLabel": x_label,
      "timerYLabel": y_label,
      "timerValueLabel": value_label,
    }
    if getattr(spec, "bg_color", None):
      group_node["bgColor"] = spec.bg_color
    if getattr(spec, "bg_alpha", None) is not None:
      group_node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      group_node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      group_node["bgRadius"] = spec.bg_radius
    ctx.apply_element_defaults(group_node, "timer")
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    max_points = int(max(200, min(10_000, (duration_s * 1000.0) / max(1.0, sample_ms))))
    axis_local = local_override(f"{base_id}_axis", {"x": 0.5, "y": 0.62, "w": 0.92, "h": 0.64, "rotationDeg": 0, "anchor": "centerCenter"})
    axis_node: dict[str, Any] = {
      "id": f"{base_id}_axis",
      "type": "axis",
      "space": space,
      "groupId": base_id,
      "timerId": base_id,
      "timerRole": "axis",
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(axis_local),
      "groupLocal": axis_local,
      "limits": {"xMin": 0.0, "xMax": max(1e-3, duration_s), "yMin": 0.0, "yMax": 1.0},
      "clamp": True,
      "padPx": 40,
      "maxPoints": max_points,
    }
    if bins:
      axis_node["bins"] = bins
    ctx.append_node(axis_node, view_id=view_id, space=space, layer=layer)

    tpl_data = {
      "toggleLabel": start_label,
      "startLabel": start_label,
      "stopLabel": stop_label,
      "resetLabel": reset_label,
      "xLabel": x_label,
      "yLabel": y_label,
      "elapsed": 0,
      "duration": duration_s,
      "remaining": duration_s,
      "progressPct": 0,
    }
    labels_tpl = ["{{toggleLabel}}"]
    labels = [format_template(template, tpl_data) for template in labels_tpl]
    actions = ["timer-toggle"]
    if debug:
      labels_tpl.append("Test")
      labels.append("Test")
      actions.append("timer-debug")
    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.5, "y": 0.5, "w": 0.6, "h": 0.22, "rotationDeg": 0, "anchor": "centerCenter"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "timerId": base_id,
      "timerRole": "buttons",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": labels,
      "templates": labels_tpl,
      "actions": actions,
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
    if debug and spec.rows is None and spec.cols is None and not spec.h_splits and not spec.v_splits:
      buttons_node["rows"] = 1
      buttons_node["cols"] = 2
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)

    def _timer_text_node(node_id: str, template: str, local_t: dict[str, Any], *, align: str = "center", font_px: float = 34.0) -> dict[str, Any]:
      resolved_local = local_override(node_id, local_t)
      return {
        "id": node_id,
        "type": "text",
        "space": space,
        "groupId": base_id,
        "timerId": base_id,
        "timerRole": "label",
        "zIndex": 2,
        "visible": True,
        "opacity": 1,
        "transform": child_transform(resolved_local),
        "groupLocal": resolved_local,
        "text": format_template(template, tpl_data),
        "template": template,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": font_px,
        "align": align,
      }

    for node in (
      _timer_text_node(
        f"{base_id}_x_label",
        "{{xLabel}}",
        {"x": 0.5, "y": 0.42, "w": 0.6, "h": 0.08, "rotationDeg": 0, "anchor": "centerCenter"},
        align="center",
        font_px=32.0,
      ),
      _timer_text_node(
        f"{base_id}_y_label",
        "{{yLabel}}",
        {"x": 0.03, "y": 0.62, "w": 0.08, "h": 0.4, "rotationDeg": -90, "anchor": "centerCenter"},
        align="center",
        font_px=32.0,
      ),
      _timer_text_node(
        f"{base_id}_value",
        value_label,
        {"x": 0.85, "y": 0.92, "w": 0.3, "h": 0.08, "rotationDeg": 0, "anchor": "centerCenter"},
        align="right",
        font_px=32.0,
      ),
      _timer_text_node(
        f"{base_id}_stats",
        r"\mu={{mu:.2f}} \sigma={{sigma:.2f}}",
        {"x": 0.5, "y": 0.06, "w": 0.7, "h": 0.08, "rotationDeg": 0, "anchor": "centerCenter"},
        align="center",
        font_px=28.0,
      ),
    ):
      ctx.append_node(node, view_id=view_id, space=space, layer=layer)
