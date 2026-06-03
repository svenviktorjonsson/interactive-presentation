from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..interfaces import (
  DesktopRuntimeUpdate,
  InteractiveGroupControllerContext,
  NodePatch,
  PhoneAction,
  PhoneElement,
  PhoneOption,
  PhoneScreen,
)


def _action_from_payload(payload: dict[str, Any] | None) -> PhoneAction | None:
  if not isinstance(payload, dict):
    return None
  return PhoneAction(
    kind=str(payload.get("kind", "") or ""),
    action_id=str(payload.get("action_id", "") or payload.get("actionId", "") or "") or None,
    group_id=str(payload.get("group_id", "") or payload.get("groupId", "") or "") or None,
    payload=dict(payload.get("payload") or {}),
  )


def phone_screen_from_payload(payload: dict[str, Any]) -> PhoneScreen:
  def to_option(raw: dict[str, Any]) -> PhoneOption:
    return PhoneOption(
      id=str(raw.get("id", "") or ""),
      label=str(raw.get("label", "") or ""),
      color=str(raw.get("color", "") or "") or None,
      other=bool(raw.get("other", False)),
    )

  def to_element(raw: dict[str, Any]) -> PhoneElement:
    return PhoneElement(
      kind=str(raw.get("kind", "") or ""),
      id=str(raw.get("id", "") or "") or None,
      text=str(raw.get("text", "") or "") or None,
      label=str(raw.get("label", "") or "") or None,
      name=str(raw.get("name", "") or "") or None,
      input_type=str(raw.get("input_type", "") or raw.get("inputType", "") or "") or None,
      placeholder=str(raw.get("placeholder", "") or "") or None,
      required=bool(raw.get("required", False)),
      value=str(raw.get("value", "") or "") or None,
      options=tuple(to_option(opt) for opt in list(raw.get("options") or [])),
      action=_action_from_payload(raw.get("action")),
      actions=tuple(
        action
        for action in (_action_from_payload(action_raw) for action_raw in list(raw.get("actions") or []))
        if action is not None
      ),
      props=dict(raw.get("props") or {}),
    )

  return PhoneScreen(
    module_type=str(payload.get("moduleType", "") or payload.get("module_type", "") or ""),
    group_id=str(payload.get("groupId", "") or payload.get("group_id", "") or payload.get("id", "") or ""),
    title=str(payload.get("title", "") or ""),
    subtitle=str(payload.get("subtitle", "") or ""),
    elements=tuple(to_element(element_raw) for element_raw in list(payload.get("elements") or [])),
    active=bool(payload.get("active", True)),
  )


def publish_desktop_runtime_update(
  ctx: InteractiveGroupControllerContext,
  update: DesktopRuntimeUpdate,
) -> None:
  for node_patch in update.node_patches:
    ctx.runtime.publish_node_patch(node_patch.node_id, dict(node_patch.patch))


@dataclass
class InteractiveGroupControllerBase:
  module_type: str = field(init=False, default="")

  def state(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> dict[str, Any]:
    return ctx.runtime.interactive_state(group_id)

  def current_screen_payload(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> dict[str, Any] | None:
    payload = ctx.runtime.phone_screen(group_id)
    if not payload or str(payload.get("moduleType", "") or "") != self.module_type:
      return None
    return payload

  def current_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    payload = self.current_screen_payload(group_id, ctx=ctx)
    if payload is None:
      return None
    return phone_screen_from_payload(payload)

  def set_phone_screen_payload(
    self,
    group_id: str,
    payload: dict[str, Any] | None,
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any] | None:
    if payload is None:
      ctx.runtime.set_phone_screen(group_id, self.module_type, None)
      return None
    screen_payload = dict(payload)
    screen_payload["groupId"] = group_id
    screen_payload["moduleType"] = self.module_type
    active = bool(screen_payload.get("active", True))
    if active:
      ctx.runtime.set_phone_screen(group_id, self.module_type, screen_payload)
    else:
      ctx.runtime.set_phone_screen(group_id, self.module_type, None)
    return screen_payload

  def emit_event(self, name: str, payload: dict[str, Any], *, ctx: InteractiveGroupControllerContext) -> None:
    ctx.runtime.publish_event(name, payload)

  def emit_desktop_update(self, update: DesktopRuntimeUpdate, *, ctx: InteractiveGroupControllerContext) -> None:
    publish_desktop_runtime_update(ctx, update)

  def ok(self, **payload: Any) -> dict[str, Any]:
    return {"ok": True, **payload}

  def error(self, message: str, **payload: Any) -> dict[str, Any]:
    return {"ok": False, "error": message, **payload}

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    return self.current_screen(group_id, ctx=ctx)

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any]:
    return self.error(f"{self.module_type} has no phone actions")

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any] | None:
    return None


class PassiveInteractiveGroupController(InteractiveGroupControllerBase):
  def __init__(self, module_type: str) -> None:
    self.module_type = module_type


class EventDrivenInteractiveGroupController(InteractiveGroupControllerBase):
  def __init__(self, module_type: str, action_event: str = "interactive-action") -> None:
    self.module_type = module_type
    self.action_event = action_event

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any]:
    self.emit_event(
      self.action_event,
      {
        "moduleType": self.module_type,
        "groupId": group_id,
        "actionId": action_id,
        "payload": payload,
      },
      ctx=ctx,
    )
    return self.ok()

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any] | None:
    return self.set_phone_screen_payload(group_id, dict(payload.get("screen") or payload), ctx=ctx)
