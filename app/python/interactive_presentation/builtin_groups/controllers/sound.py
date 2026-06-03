from __future__ import annotations

from .base import InteractiveGroupControllerBase
from ..interfaces import DesktopRuntimeUpdate, InteractiveGroupControllerContext, NodePatch, PhoneAction, PhoneElement, PhoneScreen


class SoundGroupController(InteractiveGroupControllerBase):
  module_type = "sound"

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    payload = self.current_screen_payload(group_id, ctx=ctx)
    if not payload or str(payload.get("moduleType", "") or "") != self.module_type:
      return None
    state = self.state(group_id, ctx=ctx)
    running = bool(state.get("running", False))
    controls = []
    for idx, control in enumerate(list(payload.get("controls") or [])):
      next_control = dict(control)
      if idx == 0 and str(next_control.get("actionId", "") or "").strip():
        next_control["label"] = str(
          next_control.get("pauseLabel" if running else "runLabel", "")
          or next_control.get("label", "")
          or ("Pause" if running else "Run")
        )
      controls.append(next_control)
    elements = [
      PhoneElement(
        kind="button",
        label=str(control.get("label", "") or "Action"),
        action=PhoneAction(
          kind="server",
          action_id=str(control.get("actionId", "") or ""),
          group_id=group_id,
        ),
      )
      for control in controls
      if str(control.get("actionId", "") or "").strip()
    ]
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title=str(payload.get("title", "") or "Sound Controls"),
      subtitle=str(payload.get("subtitle", "") or ""),
      elements=tuple(elements),
      active=bool(payload.get("active", True)),
    )

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object]:
    state = self.state(group_id, ctx=ctx)
    if action_id in {"toggle_capture", "sound-toggle"}:
      state["running"] = not bool(state.get("running", False))
    state["lastAction"] = action_id
    self.emit_desktop_update(
      DesktopRuntimeUpdate(
        node_patches=(
          NodePatch(
            node_id=f"{group_id}_peak",
            patch={
              "text": f"Phone: {action_id}",
              "template": f"Phone: {action_id}",
            },
          ),
        ),
      ),
      ctx=ctx,
    )
    self.emit_event(
      "sound-control",
      {"groupId": group_id, "actionId": action_id, "payload": payload},
      ctx=ctx,
    )
    return self.ok()

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object] | None:
    screen = {
      "groupId": group_id,
      "moduleType": self.module_type,
      "active": bool(payload.get("active", True)),
      "title": str(payload.get("title", "") or "Sound Controls"),
      "subtitle": str(payload.get("subtitle", "") or ""),
      "controls": list(payload.get("controls") or []),
    }
    state = self.state(group_id, ctx=ctx)
    if "running" in payload:
      state["running"] = bool(payload.get("running"))
    self.set_phone_screen_payload(group_id, screen if screen["active"] else None, ctx=ctx)
    return screen
