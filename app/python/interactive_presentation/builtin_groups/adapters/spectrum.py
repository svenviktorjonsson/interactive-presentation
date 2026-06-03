from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class SpectrumModuleAdapter:
  module_type = "spectrum"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: SpectrumSpec,
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
    run_label = str(getattr(spec, "run_label", None) or "Run")
    resume_label = str(getattr(spec, "resume_label", None) or "Resume")
    pause_label = str(getattr(spec, "pause_label", None) or "Pause")
    y_label = str(getattr(spec, "y_label", None) or "Normalized Intensity")
    f_label = str(getattr(spec, "f_label", None) or "Frequency")
    f_x_label = str(getattr(spec, "f_x_label", None) or "Frequency (Hz)")
    f_y_label = str(getattr(spec, "f_y_label", None) or "")
    x_min = float(getattr(spec, "x_min", None) or 0.0)
    x_max = float(getattr(spec, "x_max", None) or 3000.0)
    y_min = float(getattr(spec, "y_min", None) or 0.0)
    y_max = float(getattr(spec, "y_max", None) or 1.1)

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
      "soundMode": "spectrum",
      "soundWindowS": window_s,
      "soundSampleMs": sample_ms,
      "soundColor": color,
      "soundLineWidth": line_width,
      "soundRunLabel": run_label,
      "soundResumeLabel": resume_label,
      "soundPauseLabel": pause_label,
      "soundResetLabel": "Reset",
      "soundHomeLabel": "Home",
      "soundFreqLabel": f_label,
      "soundTimeLabel": "Time",
      "soundYLabel": y_label,
      "soundFLabel": f_label,
      "soundTLabel": "Time",
      "soundFXLabel": f_x_label,
      "soundFYLabel": f_y_label,
      "soundTXLabel": "",
      "soundTYLabel": "",
      "soundFreqButtonLabel": f_label,
      "soundTimeButtonLabel": "Time",
      "soundFOutputCol": "",
      "soundTOutputCol": "",
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
    axis_local = local_override(
      f"{base_id}_axis",
      {"x": -0.003351995064421631, "y": 0.21111865646529065, "w": 0.9583333333333334, "h": 1.1238338341254903, "rotationDeg": 0, "anchor": "topLeft"},
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
      "limits": {"xMin": x_min, "xMax": x_max, "yMin": y_min, "yMax": y_max},
      "clamp": True,
      "padPx": 40,
      "lineWidth": line_width,
      "maxPoints": max_points,
    }
    ctx.append_node(axis_node, view_id=view_id, space=space, layer=layer)

    tpl_data = {
      "runPauseResume": run_label,
      "freqLabel": f_label,
      "timeLabel": "Time",
      "xLabel": f_x_label or "Frequency (Hz)",
      "yLabel": y_label,
      "fLabel": f_label,
      "value": "-",
    }
    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.12660755594922043, "y": 0.0023648634072202515, "w": 0.15017711947865328, "h": 0.0845995902030589, "rotationDeg": 0, "anchor": "topLeft"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "soundId": base_id,
      "soundRole": "buttons",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": [format_template("{{runPauseResume}}", tpl_data)],
      "templates": ["{{runPauseResume}}"],
      "actions": ["sound-toggle"],
      "buttonsMode": "click",
      "rows": 1,
      "cols": 1,
    }
    ctx.apply_element_defaults(buttons_node, "buttons")
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)

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
        f_x_label or "Frequency (Hz)",
        local_override(
          f"{base_id}_x_label",
          {"x": 0.20362784919063148, "y": 0.930868235814702, "w": 0.33995807476885903, "h": 0.07657829787155672, "rotationDeg": 0, "anchor": "topLeft"},
        ),
        align="center",
        font_px=34.0,
      ),
      _text_node(
        f"{base_id}_y_label",
        y_label,
        local_override(
          f"{base_id}_y_label",
          {"x": 0.0025537745269467935, "y": 0.5228656882315988, "w": 0.16778503389913302, "h": 0.06830016458244109, "rotationDeg": -90, "anchor": "topLeft"},
        ),
        align="center",
        font_px=34.0,
      ),
      _text_node(
        f"{base_id}_peak",
        "Peak {{peak}} Hz",
        local_override(
          f"{base_id}_peak",
          {"x": 0.30366115145382594, "y": 0.0, "w": 0.19902307568578703, "h": 0.08902939967130741, "rotationDeg": 0, "anchor": "topLeft"},
        ),
        align="right",
        font_px=32.0,
      ),
    ):
      ctx.append_node(node, view_id=view_id, space=space, layer=layer)
