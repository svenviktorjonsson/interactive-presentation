from __future__ import annotations

from ..adapters.join import JoinModuleAdapter
from ..interfaces import DesktopRuntimeUpdate, InteractiveGroupCapabilities, InteractiveGroupControllerContext, NodePatch, PhoneAction, PhoneElement, PhoneScreen
from ..module_base import InteractiveGroupModuleBase


class CustomCounterModule(InteractiveGroupModuleBase):
  module_type = "custom_counter"
  canonical_group_id = "counter_main"
  adapter_cls = JoinModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    phone_inputs=("counter_increment",),
    phone_outputs=("counter_controls",),
    audience_outputs=("counter_value",),
  )

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    state = self.state(group_id, ctx=ctx)
    value = int(state.get("value", 0) or 0)
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title="Counter",
      subtitle=f"Value: {value}",
      elements=(
        PhoneElement(
          kind="button",
          label="Increment",
          action=PhoneAction(kind="server", action_id="increment", group_id=group_id),
        ),
      ),
    )

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object]:
    if action_id != "increment":
      return self.error("unsupported action")
    state = self.state(group_id, ctx=ctx)
    value = int(state.get("value", 0) or 0) + 1
    state["value"] = value
    self.emit_desktop_update(
      DesktopRuntimeUpdate(
        node_patches=(
          NodePatch(node_id=f"{group_id}_value", patch={"text": str(value), "template": str(value)}),
        ),
      ),
      ctx=ctx,
    )
    return self.ok(value=value)
