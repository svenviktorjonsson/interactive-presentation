from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from flask import Flask

from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace
from interactive_presentation.server.join_flow_runtime import JoinFlowRuntime
from interactive_presentation.server.runtime_update_routes import register_runtime_update_routes


class RuntimeUpdateRouteTests(unittest.TestCase):
  def _make_client(self) -> tuple[list[tuple[str, dict]], object]:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text(
      "\n".join(
        [
          "text[id=title]: Hello {{name}}",
          "buttons[id=controls, labels={Run {{name}}, Stop}]:",
          "view[id=home]:",
          "",
        ]
      ),
      encoding="utf-8",
    )
    runtime = JoinFlowRuntime()
    published: list[tuple[str, dict]] = []

    def capture(node_id: str, patch: dict):
      published.append((node_id, dict(patch)))

    runtime.publish_node_patch = capture  # type: ignore[method-assign]
    app = Flask(__name__)
    register_runtime_update_routes(
      app,
      workspace=FileSystemPresentationWorkspace(root),
      runtime=runtime,
    )
    return published, app.test_client()

  def test_update_text_uses_typed_node_patch(self) -> None:
    published, client = self._make_client()

    response = client.post("/update/text", json={"id": "title", "data": {"name": "Ada"}})

    self.assertEqual(response.status_code, 200)
    self.assertEqual(published, [("title", {"text": "Hello Ada"})])

  def test_update_buttons_uses_typed_node_patch(self) -> None:
    published, client = self._make_client()

    response = client.post("/update/text", json={"id": "controls", "data": {"name": "Ada"}})

    self.assertEqual(response.status_code, 200)
    self.assertEqual(len(published), 1)
    self.assertEqual(published[0][0], "controls")
    labels = published[0][1]["labels"]
    self.assertTrue(isinstance(labels, list) and labels)
    self.assertIn("Ada", str(labels[0]))


if __name__ == "__main__":
  unittest.main()
