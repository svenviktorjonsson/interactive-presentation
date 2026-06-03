from __future__ import annotations

import datetime as dt

from .base import InteractiveGroupControllerBase
from ..interfaces import InteractiveGroupControllerContext, PhoneAction, PhoneElement, PhoneScreen


class TimerGroupController(InteractiveGroupControllerBase):
  module_type = "timer"

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None:
    prompt = self.current_screen_payload(group_id, ctx=ctx)
    if prompt is None or not prompt.get("active", True):
      return None
    labels = prompt.get("labels") or {}
    running = bool(prompt.get("running"))
    toggle_label = str(labels.get("stop" if running else "start") or ("Stop" if running else "Start"))
    return PhoneScreen(
      module_type=self.module_type,
      group_id=group_id,
      title=str(prompt.get("title") or "Timer"),
      subtitle="",
      elements=(
        PhoneElement(
          kind="stopwatch",
          id="timer_main",
          props={
            "startLabel": str(labels.get("start") or "Start"),
            "stopLabel": str(labels.get("stop") or "Stop"),
            "resetLabel": str(labels.get("reset") or "Reset"),
            "submitLabel": str(labels.get("submit") or "Submit"),
            "toggleLabel": toggle_label,
            "showTime": bool(prompt.get("showTime")),
            "running": running,
          },
          actions=(
            PhoneAction(kind="server", action_id="start_timer", group_id=group_id),
            PhoneAction(kind="server", action_id="stop_timer", group_id=group_id),
            PhoneAction(kind="server", action_id="reset_timer", group_id=group_id),
            PhoneAction(kind="server", action_id="submit_timer", group_id=group_id),
          ),
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
    st = ctx.runtime.get_timer_state(group_id)
    action_map = {
      "start_timer": "start",
      "stop_timer": "stop",
      "reset_timer": "reset",
      "submit_timer": "submit",
    }
    action = action_map.get(action_id, "")
    if not action:
      return self.error("unsupported action")
    elapsed_raw = payload.get("elapsedMs")
    elapsed_ms: int | None = None
    try:
      if elapsed_raw is not None:
        elapsed_ms = int(float(elapsed_raw))
    except Exception:
      elapsed_ms = None
    ctx.runtime.mark_timer_active(group_id)
    if action == "start":
      st["accepting"] = True
    elif action == "stop":
      st["accepting"] = False
    elif action == "reset":
      ctx.runtime.reset_timer_state(group_id)
    elif action == "submit" and elapsed_ms is not None:
      samples = list(st.get("samplesMs") or [])
      samples.append(elapsed_ms)
      st["samplesMs"] = samples
      st["lastSubmitMs"] = elapsed_ms
      st["stats"] = ctx.runtime.timer_stats(samples)
    self.emit_event(
      "timer-action",
      {
        "id": group_id,
        "action": action,
        "timeMs": int(dt.datetime.now(dt.UTC).timestamp() * 1000),
        **({"elapsedMs": elapsed_ms} if elapsed_ms is not None else {}),
      },
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
      "id": group_id,
      "moduleType": self.module_type,
      "active": bool(payload.get("active")),
      "running": bool(payload.get("running")),
      "title": str(payload.get("title", "") or "Timer"),
      "showTime": bool(payload.get("showTime")),
      "labels": dict(payload.get("labels") or {}),
    }
    self.set_phone_screen_payload(group_id, screen if screen["active"] else None, ctx=ctx)
    if screen["active"]:
      self.emit_event("timer-prompt", screen, ctx=ctx)
    return screen
