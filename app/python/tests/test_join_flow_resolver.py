from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from interactive_presentation.builtin_groups import InteractiveGroupControllerContext, build_builtin_group_module_registry
from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace
from interactive_presentation.server.join_flow_resolver import JoinFlowResolver
from interactive_presentation.server.join_flow_runtime import JoinFlowRuntime


class JoinFlowResolverTests(unittest.TestCase):
  def _resolver(self) -> tuple[Path, JoinFlowResolver, JoinFlowRuntime]:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text("join[id=join_main, fields={Name}]: Welcome\nview[id=home]:\n", encoding="utf-8")
    workspace = FileSystemPresentationWorkspace(root)
    runtime = JoinFlowRuntime()
    registry = build_builtin_group_module_registry()
    controllers = {
      definition.module_type: definition.controller
      for definition in registry.definitions().values()
      if definition.controller is not None
    }
    resolver = JoinFlowResolver(
      workspace=workspace,
      presentation_dir=root.parent,
      controllers=controllers,
      join_controller=controllers["join"],
    )
    return root, resolver, runtime

  def test_resolver_finds_join_and_join_status(self) -> None:
    root, resolver, _runtime = self._resolver()
    self.assertEqual(resolver.find_join("join_main")["id"], "join_main")

    csv_path = root.parent / "user_info.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
      writer = csv.DictWriter(handle, fieldnames=["join_id", "ip"])
      writer.writeheader()
      writer.writerow({"join_id": "join_main", "ip": "127.0.0.1"})

    self.assertTrue(resolver.has_joined("join_main", "127.0.0.1"))

  def test_resolver_chooses_join_screen_before_active_prompt(self) -> None:
    root, resolver, runtime = self._resolver()
    ctx = InteractiveGroupControllerContext(
      workspace=FileSystemPresentationWorkspace(root),
      presentation_dir=root.parent,
      runtime=runtime,
      client_ip="127.0.0.1",
    )

    runtime.set_phone_screen("mc_main", "multichoice", {"title": "Pick", "active": True, "answers": ["A"]})
    screen = resolver.current_screen(join_id="join_main", joined=False, active_phone_screen=runtime.last_phone_screen, ctx=ctx)

    self.assertIsNotNone(screen)
    self.assertEqual(screen.module_type, "join")


if __name__ == "__main__":
  unittest.main()
