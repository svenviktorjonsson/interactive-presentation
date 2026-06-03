from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from interactive_presentation.builtin_groups import InteractiveGroupControllerContext
from interactive_presentation.builtin_groups.controllers import (
  EventDrivenInteractiveGroupController,
  InteractiveGroupControllerBase,
  PassiveInteractiveGroupController,
)
from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace
from interactive_presentation.server.join_flow_runtime import JoinFlowRuntime


class _DummyController(InteractiveGroupControllerBase):
  module_type = "dummy"


class InteractiveGroupControllerBaseTests(unittest.TestCase):
  def _ctx(self) -> InteractiveGroupControllerContext:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text("view[id=home]:\n", encoding="utf-8")
    return InteractiveGroupControllerContext(
      workspace=FileSystemPresentationWorkspace(root),
      presentation_dir=root.parent,
      runtime=JoinFlowRuntime(),
      client_ip="127.0.0.1",
    )

  def test_set_phone_screen_payload_normalizes_group_and_module(self) -> None:
    controller = _DummyController()
    ctx = self._ctx()

    payload = controller.set_phone_screen_payload("g1", {"title": "Hello", "active": True}, ctx=ctx)

    self.assertIsNotNone(payload)
    self.assertEqual(payload["groupId"], "g1")
    self.assertEqual(payload["moduleType"], "dummy")
    self.assertEqual(ctx.runtime.phone_screen("g1")["moduleType"], "dummy")

  def test_ok_and_error_helpers_return_standard_shapes(self) -> None:
    controller = _DummyController()

    self.assertEqual(controller.ok(value=1), {"ok": True, "value": 1})
    self.assertEqual(controller.error("bad"), {"ok": False, "error": "bad"})

  def test_lightweight_controller_helpers_keep_module_type_constructor(self) -> None:
    passive = PassiveInteractiveGroupController("player")
    event_driven = EventDrivenInteractiveGroupController("sound", action_event="sound-control")

    self.assertEqual(passive.module_type, "player")
    self.assertEqual(event_driven.module_type, "sound")
    self.assertEqual(event_driven.action_event, "sound-control")


if __name__ == "__main__":
  unittest.main()
