from __future__ import annotations

import csv
import datetime as dt

from .base import InteractiveGroupControllerBase
from ..interfaces import InteractiveGroupControllerContext, PhoneAction, PhoneElement, PhoneScreen


class JoinGroupController(InteractiveGroupControllerBase):
  module_type = "join"

  def _find_join_spec(self, join_id: str, *, ctx: InteractiveGroupControllerContext):
    pr = ctx.workspace.load_spec("presentation")
    for j in pr.joins:
      if j.id == join_id:
        return j
    for screen in pr.screens:
      for j in screen.joins:
        if j.id == join_id:
          return j
    return None

  def _input_type(self, name: str) -> str:
    n = str(name or "").lower()
    if "email" in n:
      return "email"
    if "år" in n or "year" in n or "birth" in n:
      return "number"
    return "text"

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    spec = self._find_join_spec(group_id, ctx=ctx)
    if spec is None:
      return None
    fields = tuple(
      PhoneElement(
        kind="field",
        name=str(field),
        label=str(field),
        input_type=self._input_type(str(field)),
        required=True,
      )
      for field in list(spec.fields or [])
    )
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title="Join",
      subtitle=str(spec.text or ""),
      elements=(
        *fields,
        PhoneElement(
          kind="button",
          label="Join",
          action=PhoneAction(kind="server", action_id="submit_join", group_id=group_id),
        ),
      ),
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
    if action_id != "submit_join":
      return self.error("unsupported action")
    spec = self._find_join_spec(group_id, ctx=ctx)
    if spec is None:
      return self.error("join not found")
    fields = [str(f) for f in list(spec.fields or [])]
    values = payload.get("values") or {}
    if not isinstance(values, dict):
      values = {}
    out = {field: str(values.get(field, "") or "") for field in fields}
    out["join_id"] = group_id
    out["timestamp"] = dt.datetime.now(dt.UTC).isoformat()
    out["ip"] = ctx.client_ip
    csv_path = ctx.presentation_dir / "user_info.csv"
    write_header = not csv_path.exists()
    with csv_path.open("a", encoding="utf-8", newline="") as handle:
      writer = csv.DictWriter(handle, fieldnames=["timestamp", "join_id", "ip", *fields])
      if write_header:
        writer.writeheader()
      writer.writerow(out)
    return self.ok(joined=True)

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, object],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, object] | None:
    return None
