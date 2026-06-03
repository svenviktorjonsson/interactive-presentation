from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class SoundModuleAdapter:
  module_type = "sound"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: SoundSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    mode_raw = str(getattr(spec, "mode", "") or "").strip().lower()
    mode = "time" if mode_raw in {"time", "pressure", "intensity"} else "spectrum"
    window_s = float(getattr(spec, "window_s", None) or 30.0)
    sample_ms = float(getattr(spec, "sample_ms", None) or 1.0)
    color = str(getattr(spec, "color", "") or "white")
    line_width = float(getattr(spec, "line_width", None) or 1.0)
    run_label = str(getattr(spec, "run_label", None) or "Run")
    resume_label = str(getattr(spec, "resume_label", None) or "Resume")
    pause_label = str(getattr(spec, "pause_label", None) or "Pause")
    reset_label = str(getattr(spec, "reset_label", None) or "Reset")
    home_label = str(getattr(spec, "home_label", None) or "Home")
    freq_mode_label = str(getattr(spec, "freq_mode_label", None) or "Frequency")
    time_mode_label = str(getattr(spec, "time_mode_label", None) or "Time")
    y_label = str(getattr(spec, "y_label", None) or "Normalized Intensity")
    f_label = str(getattr(spec, "f_label", None) or "Frequency")
    t_label = str(getattr(spec, "t_label", None) or "Time")
    f_x_label = str(getattr(spec, "f_x_label", None) or "")
    f_y_label = str(getattr(spec, "f_y_label", None) or "")
    t_x_label = str(getattr(spec, "t_x_label", None) or "")
    t_y_label = str(getattr(spec, "t_y_label", None) or "")
    peak_label = str(getattr(spec, "peak_label", None) or "")
    freq_button_label = str(getattr(spec, "freq_button_label", None) or freq_mode_label or "Frequency")
    time_button_label = str(getattr(spec, "time_button_label", None) or time_mode_label or "Time")
    f_output_col = str(getattr(spec, "f_output_col", None) or "")
    t_output_col = str(getattr(spec, "t_output_col", None) or "")

    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "soundId": base_id,
      "soundRole": "root",
      "soundMode": mode,
      "soundWindowS": window_s,
      "soundSampleMs": sample_ms,
      "soundColor": color,
      "soundLineWidth": line_width,
      "soundRunLabel": run_label,
      "soundResumeLabel": resume_label,
      "soundPauseLabel": pause_label,
      "soundResetLabel": reset_label,
      "soundHomeLabel": home_label,
      "soundFreqLabel": freq_mode_label,
      "soundTimeLabel": time_mode_label,
      "soundYLabel": y_label,
      "soundFLabel": f_label,
      "soundTLabel": t_label,
      "soundFXLabel": f_x_label,
      "soundFYLabel": f_y_label,
      "soundTXLabel": t_x_label,
      "soundTYLabel": t_y_label,
      "soundPeakLabel": peak_label,
      "soundFreqButtonLabel": freq_button_label,
      "soundTimeButtonLabel": time_button_label,
      "soundFOutputCol": f_output_col,
      "soundTOutputCol": t_output_col,
    }
    if getattr(spec, "bg_color", None):
      group_node["bgColor"] = spec.bg_color
    if getattr(spec, "bg_alpha", None) is not None:
      group_node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      group_node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      group_node["bgRadius"] = spec.bg_radius
    ctx.apply_element_defaults(group_node, "sound")
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    local_override = ctx.local_override_factory(base_id)
    max_points = int(max(200, min(10_000, (window_s * 1000.0) / max(1e-6, sample_ms))))
    axis_limits = {"xMin": 0.0, "xMax": window_s, "yMin": 0.0, "yMax": 1.1} if mode == "time" else {"xMin": 0.0, "xMax": 8000.0, "yMin": 0.0, "yMax": 1.1}

    axis_local = local_override(
      f"{base_id}_axis",
      {"x": 0.0, "y": 0.1437880536957677, "w": 0.7301225711717918, "h": 0.8562119463042323, "rotationDeg": 0, "anchor": "topLeft"},
    )
    axis_node: dict[str, Any] = {
      "id": f"{base_id}_axis",
      "type": "axis",
      "space": space,
      "groupId": base_id,
      "soundId": base_id,
      "soundRole": "axis",
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(axis_local),
      "groupLocal": axis_local,
      "limits": axis_limits,
      "clamp": True,
      "padPx": 40,
      "lineWidth": line_width,
      "maxPoints": max_points,
    }
    ctx.append_node(axis_node, view_id=view_id, space=space, layer=layer)

    tpl_data = {
      "runPauseResume": run_label,
      "resetLabel": reset_label,
      "modeToggle": time_mode_label if mode == "spectrum" else freq_mode_label,
      "freqButtonLabel": freq_button_label,
      "timeButtonLabel": time_button_label,
      "freqLabel": freq_mode_label,
      "timeLabel": time_mode_label,
      "xLabel": "Frequency (Hz)" if mode == "spectrum" else "Time (s)",
      "yLabel": y_label,
      "fLabel": f_label,
      "tLabel": t_label,
      "peakHz": "-",
    }

    run_labels_tpl = ["{{runPauseResume}}", "{{resetLabel}}", "{{homeLabel}}"]
    run_labels = [format_template(value, tpl_data) for value in run_labels_tpl]
    run_buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": -7.769966428172737e-05, "y": 0.11677726367740732, "w": 0.451647520230483, "h": 0.09930849736967487, "rotationDeg": 0, "anchor": "topLeft"},
    )
    run_buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "soundId": base_id,
      "soundRole": "buttons",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(run_buttons_local),
      "groupLocal": run_buttons_local,
      "labels": run_labels,
      "templates": run_labels_tpl,
      "actions": ["sound-toggle", "sound-reset", "sound-home"],
      "buttonsMode": "click",
    }
    ctx.apply_element_defaults(run_buttons_node, "buttons")
    if not spec.h_splits and not spec.v_splits and spec.rows is None and spec.cols is None:
      run_buttons_node["rows"] = 1
      run_buttons_node["cols"] = 3
    ctx.append_node(run_buttons_node, view_id=view_id, space=space, layer=layer)

    mode_labels_tpl = ["{{freqButtonLabel}}", "{{timeButtonLabel}}"]
    mode_labels = [format_template(value, tpl_data) for value in mode_labels_tpl]
    mode_buttons_local = local_override(
      f"{base_id}_mode_buttons",
      {"x": 0.7287970141347565, "y": 0.1948133569373341, "w": 0.44059884260270205, "h": 0.09180383459542484, "rotationDeg": 0, "anchor": "bottomCenter"},
    )
    mode_buttons_node: dict[str, Any] = {
      "id": f"{base_id}_mode_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "soundId": base_id,
      "soundRole": "mode-buttons",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(mode_buttons_local),
      "groupLocal": mode_buttons_local,
      "labels": mode_labels,
      "templates": mode_labels_tpl,
      "actions": ["sound-mode-frequency", "sound-mode-time"],
      "buttonsMode": "radio",
    }
    ctx.apply_element_defaults(mode_buttons_node, "buttons")
    if not spec.h_splits and not spec.v_splits and spec.rows is None and spec.cols is None:
      mode_buttons_node["rows"] = 1
      mode_buttons_node["cols"] = 2
    ctx.append_node(mode_buttons_node, view_id=view_id, space=space, layer=layer)

    threshold_local = local_override(
      f"{base_id}_threshold",
      {"x": 1.0063410801410928, "y": 0.210076801716217, "w": 0.04716071206855599, "h": 0.9766745977177839, "rotationDeg": 0, "anchor": "topCenter"},
    )
    threshold_node: dict[str, Any] = {
      "id": f"{base_id}_threshold",
      "type": "slider",
      "space": space,
      "groupId": base_id,
      "soundId": base_id,
      "soundRole": "threshold",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(threshold_local),
      "groupLocal": threshold_local,
      "min": 0.0,
      "max": 1.1,
      "step": 0.01,
      "value": 0.0,
      "orientation": "vertical",
    }
    ctx.append_node(threshold_node, view_id=view_id, space=space, layer=layer)

    def _text_node(node_id: str, template: str, local_t: dict[str, Any], *, align: str = "center", font_px: float = 36.0) -> dict[str, Any]:
      return {
        "id": node_id,
        "type": "text",
        "space": space,
        "groupId": base_id,
        "soundId": base_id,
        "soundRole": "label",
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

    for node in (
      _text_node(
        f"{base_id}_x_label",
        "{{currentLabel}}",
        local_override(
          f"{base_id}_x_label",
          {"x": 0.22555160745538927, "y": 1.1879287612445806, "w": 0.5659285448226717, "h": 0.12720192927382457, "rotationDeg": 0, "anchor": "topLeft"},
        ),
        align="center",
        font_px=34.0,
      ),
      _text_node(
        f"{base_id}_y_label",
        "{{yLabel}}",
        local_override(
          f"{base_id}_y_label",
          {"x": -0.0994431544759582, "y": 0.8548772982003209, "w": 0.18919534415321076, "h": 0.2272666197831786, "rotationDeg": -90, "anchor": "topLeft"},
        ),
        align="center",
        font_px=34.0,
      ),
      _text_node(
        f"{base_id}_peak",
        "{{peakLabel}}",
        local_override(
          f"{base_id}_peak",
          {"x": 0.6686860881725778, "y": 0.6957592148375864, "w": 0.33131391182742204, "h": 0.10450849563053895, "rotationDeg": 0, "anchor": "topLeft"},
        ),
        align="right",
        font_px=32.0,
      ),
    ):
      ctx.append_node(node, view_id=view_id, space=space, layer=layer)
