from __future__ import annotations

from .base import InteractiveGroupControllerBase
from ..interfaces import DesktopRuntimeUpdate, InteractiveGroupControllerContext, NodePatch, PhoneAction, PhoneElement, PhoneScreen


class WebcamGroupController(InteractiveGroupControllerBase):
  module_type = "webcam"

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    payload = self.current_screen_payload(group_id, ctx=ctx)
    if not payload or str(payload.get("moduleType", "") or "") != self.module_type:
      return None
    state = self.state(group_id, ctx=ctx)
    recording = bool(state.get("recording", False))
    controls = []
    for idx, control in enumerate(list(payload.get("controls") or [])):
      next_control = dict(control)
      if idx == 0 and str(next_control.get("actionId", "") or "").strip():
        next_control["label"] = str(
          next_control.get("stopLabel" if recording else "recLabel", "")
          or next_control.get("label", "")
          or ("Stop" if recording else "Rec")
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
      title=str(payload.get("title", "") or "Camera Controls"),
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
    if action_id == "rec":
      state["recording"] = not bool(state.get("recording", False))
      self.emit_desktop_update(
        DesktopRuntimeUpdate(
          node_patches=(
            NodePatch(
              node_id=f"{group_id}_buttons",
              patch={
                "labels": ["Stop" if state["recording"] else "Rec", "Shot"],
              },
            ),
          ),
        ),
        ctx=ctx,
      )
    elif action_id == "shot":
      self.emit_desktop_update(
        DesktopRuntimeUpdate(
          node_patches=(
            NodePatch(
              node_id=f"{group_id}_camera",
              patch={
                "cameraFlash": int(state.get("cameraFlash", 0) or 0) + 1,
              },
            ),
          ),
        ),
        ctx=ctx,
      )
    self.emit_event(
      "webcam-control",
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
      "title": str(payload.get("title", "") or "Camera Controls"),
      "subtitle": str(payload.get("subtitle", "") or ""),
      "controls": list(payload.get("controls") or []),
    }
    state = self.state(group_id, ctx=ctx)
    if "recording" in payload:
      state["recording"] = bool(payload.get("recording"))
    self.set_phone_screen_payload(group_id, screen if screen["active"] else None, ctx=ctx)
    return screen
