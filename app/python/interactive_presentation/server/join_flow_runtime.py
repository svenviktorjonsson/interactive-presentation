from __future__ import annotations

import json
import math
import threading
from queue import Empty, Queue
from typing import Any, Iterator


class JoinFlowRuntime:
  def __init__(self) -> None:
    self._subscribers: list[Queue[str]] = []
    self._subscribers_lock = threading.Lock()
    self._last_multichoice_prompt: dict[str, Any] | None = None
    self._last_timer_prompt: dict[str, Any] | None = None
    self._last_phone_screen: dict[str, Any] | None = None
    self._phone_screens_by_id: dict[str, dict[str, Any]] = {}
    self._interactive_state_by_id: dict[str, dict[str, Any]] = {}
    self._timer_state_by_id: dict[str, dict[str, Any]] = {}
    self._timer_last_active_id: str | None = None

  @property
  def last_multichoice_prompt(self) -> dict[str, Any] | None:
    return self._last_multichoice_prompt

  @property
  def last_timer_prompt(self) -> dict[str, Any] | None:
    return self._last_timer_prompt

  @property
  def last_phone_screen(self) -> dict[str, Any] | None:
    return self._last_phone_screen

  def phone_screen(self, group_id: str) -> dict[str, Any] | None:
    return self._phone_screens_by_id.get(str(group_id or "").strip())

  def set_phone_screen(self, group_id: str, module_type: str, payload: dict[str, Any] | None) -> None:
    gid = str(group_id or "").strip()
    if not gid:
      return
    if payload is None:
      self._phone_screens_by_id.pop(gid, None)
      if self._last_phone_screen and str(self._last_phone_screen.get("groupId", "") or self._last_phone_screen.get("id", "")) == gid:
        self._last_phone_screen = None
        self.publish_event("interactive-screen", {"active": False, "groupId": gid, "moduleType": module_type})
      return
    screen = dict(payload)
    screen["groupId"] = gid
    screen["moduleType"] = str(module_type or screen.get("moduleType") or "")
    self._phone_screens_by_id[gid] = screen
    self._last_phone_screen = screen
    self.publish_event("interactive-screen", screen)

  def interactive_state(self, group_id: str) -> dict[str, Any]:
    gid = str(group_id or "").strip()
    state = self._interactive_state_by_id.get(gid)
    if state is None:
      state = {}
      self._interactive_state_by_id[gid] = state
    return state

  def publish_node_patch(self, node_id: str, patch: dict[str, Any]) -> None:
    nid = str(node_id or "").strip()
    if not nid:
      return
    self.publish_event("node-patch", {"id": nid, "patch": dict(patch or {})})

  def publish_event(self, name: str, payload: dict[str, Any]) -> None:
    if name == "multichoice-prompt":
      self._last_multichoice_prompt = dict(payload)
    if name == "timer-prompt":
      self._last_timer_prompt = dict(payload)
      print(f"[sse] timer-prompt active={payload.get('active')} id={payload.get('id')}")
    if name == "interactive-screen":
      self._last_phone_screen = dict(payload)
    msg = f"event: {name}\n" + f"data: {json.dumps(payload)}\n\n"
    with self._subscribers_lock:
      if name == "timer-prompt":
        print(f"[sse] timer-prompt subscribers={len(self._subscribers)}")
      for q in list(self._subscribers):
        try:
          q.put_nowait(msg)
        except Exception:
          continue

  def timer_stats(self, samples_ms: list[int]) -> dict[str, Any]:
    nums = [int(x) for x in samples_ms if isinstance(x, (int, float))]
    n = len(nums)
    if n <= 0:
      return {"n": 0, "meanMs": None, "sigmaMs": None}
    mean = sum(nums) / n
    if n <= 1:
      return {"n": n, "meanMs": mean, "sigmaMs": None}
    var = sum((x - mean) ** 2 for x in nums) / n
    return {"n": n, "meanMs": mean, "sigmaMs": math.sqrt(var)}

  def get_timer_state(self, timer_id: str) -> dict[str, Any]:
    st = self._timer_state_by_id.get(timer_id)
    if st is None:
      st = {"accepting": False, "samplesMs": [], "stats": {"n": 0, "meanMs": None, "sigmaMs": None}, "lastSubmitMs": None}
      self._timer_state_by_id[timer_id] = st
    return st

  def resolve_timer_id(self, data: dict | None = None) -> str | None:
    if data:
      tid = str(data.get("id", "") or "").strip()
      if tid:
        self._timer_last_active_id = tid
        return tid
    if self._timer_last_active_id:
      return self._timer_last_active_id
    if self._last_timer_prompt and str(self._last_timer_prompt.get("id", "")).strip():
      return str(self._last_timer_prompt.get("id")).strip()
    return None

  def mark_timer_active(self, timer_id: str) -> None:
    tid = str(timer_id or "").strip()
    if tid:
      self._timer_last_active_id = tid

  def reset_timer_state(self, timer_id: str) -> dict[str, Any]:
    st = self.get_timer_state(timer_id)
    st["accepting"] = False
    st["samplesMs"] = []
    st["lastSubmitMs"] = None
    st["stats"] = {"n": 0, "meanMs": None, "sigmaMs": None}
    self.mark_timer_active(timer_id)
    return st

  def timer_events(self, client_addr: str | None) -> Iterator[str]:
    q: Queue[str] = Queue()
    with self._subscribers_lock:
      self._subscribers.append(q)
      print(f"[sse] client connected addr={client_addr} subscribers={len(self._subscribers)}")
      print(f"[sse] client connected subscribers={len(self._subscribers)}")
    try:
      if self._last_multichoice_prompt is not None:
        yield f"event: multichoice-prompt\n" + f"data: {json.dumps(self._last_multichoice_prompt)}\n\n"
      if self._last_timer_prompt is not None and self._last_timer_prompt.get("active"):
        yield f"event: timer-prompt\n" + f"data: {json.dumps(self._last_timer_prompt)}\n\n"
      if self._last_phone_screen is not None:
        yield f"event: interactive-screen\n" + f"data: {json.dumps(self._last_phone_screen)}\n\n"
      yield ": ok\n\n"
      while True:
        try:
          msg = q.get(timeout=15)
          yield msg
        except Empty:
          yield ": keepalive\n\n"
    finally:
      with self._subscribers_lock:
        if q in self._subscribers:
          self._subscribers.remove(q)
          print(f"[sse] client disconnected addr={client_addr} subscribers={len(self._subscribers)}")
          print(f"[sse] client disconnected subscribers={len(self._subscribers)}")
