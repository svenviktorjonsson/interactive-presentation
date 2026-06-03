from __future__ import annotations

from .base import InteractiveGroupControllerBase
from ..interfaces import (
  InteractiveGroupControllerContext,
  PhoneAction,
  PhoneElement,
  PhoneOption,
  PhoneScreen,
)


class MultiChoiceGroupController(InteractiveGroupControllerBase):
  module_type = "multichoice"
  _palette = ("#b4283d", "#167e34", "#1b4f9f", "#9d8619", "#2d8f96", "#7b3bb0")

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    prompt = self.current_screen_payload(group_id, ctx=ctx)
    if prompt is None or not prompt.get("active", True):
      return None
    answers = [str(x) for x in list(prompt.get("answers") or [])]
    other_label = str(prompt.get("otherLabel", "") or "").strip()
    options = tuple(
      PhoneOption(
        id=answer,
        label=answer,
        color=self._palette[idx % len(self._palette)],
      )
      for idx, answer in enumerate(answers)
    )
    elements: list[PhoneElement] = [
      PhoneElement(
        kind="choice_list",
        label="Options",
        options=options,
        action=PhoneAction(kind="server", action_id="submit_choice", group_id=group_id),
      )
    ]
    if other_label:
      elements.extend(
        [
          PhoneElement(kind="field", name="other", label=other_label, placeholder="Other..."),
          PhoneElement(
            kind="button",
            label=f"Send {other_label}",
            action=PhoneAction(kind="server", action_id="submit_other", group_id=group_id),
          ),
        ]
      )
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title=str(prompt.get("question") or "Choose"),
      subtitle="",
      elements=tuple(elements),
      active=True,
    )

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object]:
    values = payload.get("values") or {}
    if not isinstance(values, dict):
      values = {}
    choice = str(payload.get("choice") or values.get("choice") or "").strip()
    other = str(values.get("other") or payload.get("other") or "").strip()
    if action_id == "submit_other":
      screen = self.current_screen_payload(group_id, ctx=ctx) or {}
      other_label = str(screen.get("otherLabel", "") or "").strip()
      choice = other_label
    if not choice:
      return self.error("missing choice")
    self.emit_event("multichoice-vote", {"id": group_id, "choice": choice, "other": other}, ctx=ctx)
    return self.ok()

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object] | None:
    screen = {
      "id": group_id,
      "moduleType": self.module_type,
      "active": bool(payload.get("active")),
      "question": str(payload.get("question", "") or ""),
      "answers": [str(x) for x in list(payload.get("answers") or [])],
      "labels": [str(x) for x in list(payload.get("labels") or [])],
      "otherLabel": str(payload.get("otherLabel", "") or ""),
      "round": int(payload.get("round", 0) or 0),
    }
    self.set_phone_screen_payload(group_id, screen if screen["active"] else None, ctx=ctx)
    if screen["active"]:
      self.emit_event("multichoice-prompt", screen, ctx=ctx)
    return screen
