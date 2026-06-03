from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class MultiChoiceModuleAdapter:
  module_type = "multichoice"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: MultiChoiceSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    answers_raw = list(getattr(spec, "answers", None) or [])
    answers = [
      {"name": str(name), "color": str(color) if color is not None else ""}
      for name, color in answers_raw
    ]
    question = str(getattr(spec, "question", "") or "")
    other_label = str(getattr(spec, "other_label", "") or "")
    other_limit = getattr(spec, "other_limit", None)
    choice_type = str(getattr(spec, "choice_type", None) or "A")
    start_label = str(getattr(spec, "start_label", None) or "Start")
    stop_label = str(getattr(spec, "stop_label", None) or "Stop")
    reset_label = str(getattr(spec, "reset_label", None) or "Reset")
    show_wheel = getattr(spec, "show_wheel", None)

    if space == "group":
      groupless_node: dict[str, Any] = {
        "id": base_id,
        "type": "multichoice",
        "space": space,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": transform,
        "answers": answers,
        "choiceType": choice_type,
        "question": question,
        "otherLabel": other_label,
        "otherLimit": other_limit,
        "showList": True,
        "showQuestion": True,
      }
      ctx.apply_element_defaults(groupless_node, "multichoice")
      ctx.append_node(groupless_node, view_id=view_id, space=space, layer=layer)
      return

    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "multichoiceId": base_id,
      "multichoiceRole": "root",
      "multichoiceQuestion": question,
      "multichoiceAnswers": answers,
      "multichoiceChoiceType": choice_type,
      "multichoiceOtherLabel": other_label,
      "multichoiceOtherLimit": other_limit,
      "multichoiceStartLabel": start_label,
      "multichoiceStopLabel": stop_label,
      "multichoiceResetLabel": reset_label,
    }
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    local_override = ctx.local_override_factory(base_id)

    wheel_enabled = show_wheel is not False
    if wheel_enabled:
      wheel_group_id = f"{base_id}_wheel"
      wheel_group_local = local_override(
        f"{base_id}_wheel",
        {"x": 0.78, "y": 0.62, "w": 0.36, "h": 0.62, "rotationDeg": 0, "anchor": "centerCenter"},
      )
      wheel_group: dict[str, Any] = {
        "id": wheel_group_id,
        "type": "group",
        "space": space,
        "groupId": base_id,
        "zIndex": 0,
        "visible": True,
        "opacity": 1,
        "transform": child_transform(wheel_group_local),
        "groupLocal": wheel_group_local,
        "multichoiceId": base_id,
        "multichoiceRole": "wheel-group",
      }
      ctx.append_node(wheel_group, view_id=view_id, space=space, layer=layer)

      wheel_group_t = wheel_group["transform"]
      wheel_group_w = float(wheel_group_t.get("w", 0.0) or 0.0)
      wheel_group_h = float(wheel_group_t.get("h", 0.0) or 0.0)
      wheel_group_rot = float(wheel_group_t.get("rotationDeg", 0.0) or 0.0)
      wheel_side = min(wheel_group_w, wheel_group_h)

      def _wheel_child_transform(local_t: dict[str, Any]) -> dict[str, Any]:
        local_x = float(local_t.get("x", 0.0))
        local_y = float(local_t.get("y", 0.0))
        anchor_world = ctx.group_local_to_world(wheel_group_t, {"x": local_x, "y": local_y})
        local_scale = max(0.0, min(float(local_t.get("w", 1.0) or 1.0), float(local_t.get("h", 1.0) or 1.0)))
        side = max(1e-9, wheel_side) * local_scale
        return {
          **local_t,
          "x": anchor_world["x"],
          "y": anchor_world["y"],
          "w": side,
          "h": side,
          "rotationDeg": float(local_t.get("rotationDeg", 0.0) or 0.0) + wheel_group_rot,
        }

      wheel_local = {"x": 0.5, "y": 0.5, "w": 0.9, "h": 0.9, "rotationDeg": 0, "anchor": "centerCenter"}
      wheel_node: dict[str, Any] = {
        "id": f"{base_id}_wheel_canvas",
        "type": "multichoice",
        "space": space,
        "groupId": wheel_group_id,
        "multichoiceId": base_id,
        "multichoiceRole": "wheel",
        "zIndex": 1,
        "visible": True,
        "opacity": 1,
        "transform": _wheel_child_transform(wheel_local),
        "groupLocal": wheel_local,
        "answers": answers,
        "choiceType": choice_type,
        "otherLabel": other_label,
        "otherLimit": other_limit,
        "showList": False,
        "showQuestion": False,
      }
      ctx.apply_element_defaults(wheel_node, "multichoice")
      ctx.append_node(wheel_node, view_id=view_id, space=space, layer=layer)

    question_local = local_override(
      f"{base_id}_question",
      {"x": 0.06, "y": 0.06, "w": 0.6, "h": 0.12, "rotationDeg": 0, "anchor": "topLeft"},
    )
    question_node: dict[str, Any] = {
      "id": f"{base_id}_question",
      "type": "text",
      "space": space,
      "groupId": base_id,
      "multichoiceId": base_id,
      "multichoiceRole": "question",
      "zIndex": 2,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(question_local),
      "groupLocal": question_local,
      "text": format_template("{{question}}", {"question": question}),
      "template": "{{question}}",
      "color": "rgba(255,255,255,0.92)",
      "fontPx": 28,
      "align": "left",
    }
    ctx.append_node(question_node, view_id=view_id, space=space, layer=layer)

    display_answers = list(answers)
    if other_label:
      display_answers.append({"name": other_label, "color": "", "__other": True})
    bullets_text = "\n".join(f"{{{{item{idx}}}}}" for idx in range(len(display_answers))).strip()
    bullets_local = local_override(
      f"{base_id}_answers",
      {"x": 0.06, "y": 0.22, "w": 0.6, "h": 0.6, "rotationDeg": 0, "anchor": "topLeft"},
    )
    bullets_node: dict[str, Any] = {
      "id": f"{base_id}_answers",
      "type": "bullets",
      "space": space,
      "groupId": base_id,
      "multichoiceId": base_id,
      "multichoiceRole": "answers",
      "zIndex": 2,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(bullets_local),
      "groupLocal": bullets_local,
      "items": ctx.parse_bullet_lines(bullets_text),
      "bullets": "A.",
      "rawText": bullets_text,
      "template": bullets_text,
      "fontPx": 28,
      "color": "rgba(255,255,255,0.92)",
      "align": "left",
    }
    ctx.append_node(bullets_node, view_id=view_id, space=space, layer=layer)

    labels_tpl = ["{{toggleLabel}}", "{{resetLabel}}"]
    labels = [
      format_template(
        template,
        {"toggleLabel": start_label, "startLabel": start_label, "stopLabel": stop_label, "resetLabel": reset_label},
      )
      for template in labels_tpl
    ]
    buttons_local = local_override(
      f"{base_id}_buttons",
      {"x": 0.98, "y": 0.06, "w": 0.32, "h": 0.14, "rotationDeg": 0, "anchor": "topRight"},
    )
    buttons_node: dict[str, Any] = {
      "id": f"{base_id}_buttons",
      "type": "buttons",
      "space": space,
      "groupId": base_id,
      "multichoiceId": base_id,
      "multichoiceRole": "buttons",
      "zIndex": 3,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(buttons_local),
      "groupLocal": buttons_local,
      "labels": labels,
      "templates": labels_tpl,
      "actions": ["multichoice-toggle", "multichoice-reset"],
      "rows": 1,
      "cols": 2,
    }
    ctx.apply_element_defaults(buttons_node, "buttons")
    buttons_node.pop("hSplits", None)
    buttons_node.pop("vSplits", None)
    ctx.append_node(buttons_node, view_id=view_id, space=space, layer=layer)
