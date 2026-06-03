from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..builtin_groups import InteractiveGroupController, InteractiveGroupControllerContext
from ..presentation_workspace import FileSystemPresentationWorkspace


@dataclass(frozen=True)
class JoinFlowResolver:
  workspace: FileSystemPresentationWorkspace
  presentation_dir: Path
  controllers: dict[str, InteractiveGroupController]
  join_controller: InteractiveGroupController

  def find_join(self, join_id: str) -> dict[str, Any] | None:
    pr = self.workspace.load_spec("presentation")
    for j in pr.joins:
      if j.id == join_id:
        return {"id": j.id, "fields": list(j.fields or []), "text": j.text}
    for screen in pr.screens:
      for j in screen.joins:
        if j.id == join_id:
          return {"id": j.id, "fields": list(j.fields or []), "text": j.text}
    return None

  def has_joined(self, join_id: str, ip: str) -> bool:
    if not ip:
      return False
    csv_path = self.presentation_dir / "user_info.csv"
    if not csv_path.exists():
      return False
    try:
      with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
          if str(row.get("join_id", "") or "") != join_id:
            continue
          if str(row.get("ip", "") or "") == ip:
            return True
    except Exception:
      return False
    return False

  def current_screen(
    self,
    *,
    join_id: str,
    joined: bool,
    active_phone_screen: dict[str, Any] | None,
    ctx: InteractiveGroupControllerContext,
  ):
    if join_id and not joined:
      return self.join_controller.phone_screen(join_id, ctx=ctx)
    if active_phone_screen:
      module_type = str(active_phone_screen.get("moduleType", "") or "")
      group_id = str(active_phone_screen.get("groupId", "") or active_phone_screen.get("id", "") or "")
      controller = self.controllers.get(module_type)
      if controller is not None and group_id:
        return controller.phone_screen(group_id, ctx=ctx)
    return None
