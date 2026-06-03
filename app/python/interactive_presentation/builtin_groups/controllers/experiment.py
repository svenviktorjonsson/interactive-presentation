from __future__ import annotations

from .base import InteractiveGroupControllerBase
from ..interfaces import DesktopRuntimeUpdate, InteractiveGroupControllerContext, NodePatch, PhoneAction, PhoneElement, PhoneScreen


class ExperimentGroupController(InteractiveGroupControllerBase):
  module_type = "experiment"

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    payload = self.current_screen_payload(group_id, ctx=ctx)
    if not payload or str(payload.get("moduleType", "") or "") != self.module_type:
      return None
    state = self.state(group_id, ctx=ctx)
    entries = int(state.get("entries", 0) or 0)
    fields = [str(x) for x in list(payload.get("fields") or [])]
    title = str(payload.get("title", "") or "Experiment Entry")
    subtitle = str(payload.get("subtitle", "") or "")
    if entries > 0:
      subtitle = f"{subtitle} Entries: {entries}".strip()
    submit_label = str(payload.get("submitLabel", "") or "Submit")
    elements = [
      PhoneElement(
        kind="field",
        name=field,
        label=field,
        input_type="text",
        required=True,
      )
      for field in fields
    ]
    elements.append(
      PhoneElement(
        kind="button",
        label=submit_label,
        action=PhoneAction(kind="server", action_id="submit_row", group_id=group_id),
      )
    )
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title=title,
      subtitle=subtitle,
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
    if action_id != "submit_row":
      return self.error("unsupported action")
    screen = self.current_screen_payload(group_id, ctx=ctx) or {}
    fields = [str(x) for x in list(screen.get("fields") or [])]
    table_id = str(screen.get("tableId", "") or f"{group_id}_table")
    values = payload.get("values") or {}
    if not isinstance(values, dict):
      values = {}
    state = self.state(group_id, ctx=ctx)
    next_row = int(state.get("nextRow", 1) or 1)
    entries = int(state.get("entries", 0) or 0) + 1
    for index, field in enumerate(fields, start=1):
      self.emit_event(
        "table-update",
        {
          "id": table_id,
          "row": next_row,
          "col": index,
          "value": str(values.get(field, "") or ""),
        },
        ctx=ctx,
      )
    state["nextRow"] = next_row + 1
    state["entries"] = entries
    self.emit_desktop_update(
      DesktopRuntimeUpdate(
        node_patches=(
          NodePatch(
            node_id=f"{group_id}_fit_label",
            patch={
              "text": f"Entries: {entries}",
              "template": f"Entries: {entries}",
            },
          ),
        ),
      ),
      ctx=ctx,
    )
    return self.ok(row=next_row)

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
      "title": str(payload.get("title", "") or "Experiment Entry"),
      "subtitle": str(payload.get("subtitle", "") or ""),
      "fields": [str(x) for x in list(payload.get("fields") or payload.get("columns") or [])],
      "submitLabel": str(payload.get("submitLabel", "") or "Submit"),
      "tableId": str(payload.get("tableId", "") or f"{group_id}_table"),
    }
    self.set_phone_screen_payload(group_id, screen if screen["active"] else None, ctx=ctx)
    return screen
