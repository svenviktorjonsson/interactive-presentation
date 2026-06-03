from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from interactive_presentation.builtin_groups import InteractiveGroupControllerContext
from interactive_presentation.builtin_groups.examples.custom_counter import CustomCounterModule
from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace
from interactive_presentation.server.join_flow_runtime import JoinFlowRuntime


class CustomCounterModuleExampleTests(unittest.TestCase):
  def _ctx(self) -> tuple[InteractiveGroupControllerContext, JoinFlowRuntime]:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text("view[id=home]:\n", encoding="utf-8")
    runtime = JoinFlowRuntime()
    return (
      InteractiveGroupControllerContext(
        workspace=FileSystemPresentationWorkspace(root),
        presentation_dir=root.parent,
        runtime=runtime,
        client_ip="127.0.0.1",
      ),
      runtime,
    )

  def test_custom_counter_module_controls_phone_and_desktop_from_python(self) -> None:
    module = CustomCounterModule()
    ctx, runtime = self._ctx()

    screen = module.phone_screen("counter_main", ctx=ctx)

    self.assertIsNotNone(screen)
    self.assertEqual(screen.title, "Counter")
    self.assertEqual(screen.elements[0].label, "Increment")

    result = module.handle_phone_action("counter_main", "increment", {}, ctx=ctx)

    self.assertEqual(result["ok"], True)
    self.assertEqual(result["value"], 1)
    self.assertEqual(runtime.interactive_state("counter_main")["value"], 1)


if __name__ == "__main__":
  unittest.main()
