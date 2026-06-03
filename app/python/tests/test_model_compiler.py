from __future__ import annotations

import unittest
from pathlib import Path

from interactive_presentation.model_compiler import DefaultPresentationModelCompiler
from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace
from interactive_presentation.server.app import create_app


class ModelCompilerRegressionTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls) -> None:
    repo_root = Path(__file__).resolve().parents[3]
    cls.deck_path = repo_root / "presentations" / "eoes_minimal_example" / "presentation.pr"
    cls.workspace = FileSystemPresentationWorkspace(cls.deck_path)
    cls.compiler = DefaultPresentationModelCompiler()

  def _compiled_nodes(self) -> dict[str, dict]:
    payload = self.compiler.compile(self.workspace.load_snapshot())
    return {str(node["id"]): node for node in payload["nodes"]}

  def test_multichoice_compiles_real_answers_and_labels(self) -> None:
    nodes = self._compiled_nodes()
    root = nodes["mc_main"]
    wheel = nodes["mc_main_wheel_canvas"]
    answers = nodes["mc_main_answers"]
    buttons = nodes["mc_main_buttons"]

    self.assertEqual([a["name"] for a in root["multichoiceAnswers"]], ["Alpha", "Beta", "Gamma", "Delta"])
    self.assertEqual([a["name"] for a in wheel["answers"]], ["Alpha", "Beta", "Gamma", "Delta"])
    self.assertEqual(
      [item["text"] for item in answers["items"]],
      ["{{item0}}", "{{item1}}", "{{item2}}", "{{item3}}"],
    )
    self.assertEqual(buttons["labels"], ["Start", "Reset"])

  def test_timer_compiles_non_placeholder_labels(self) -> None:
    nodes = self._compiled_nodes()
    self.assertEqual(nodes["timer_main_buttons"]["labels"], ["Start"])
    self.assertEqual(nodes["timer_main_x_label"]["text"], "Time (s)")
    self.assertEqual(nodes["timer_main_y_label"]["text"], "Progress")

  def test_remaining_custom_modules_compile_through_seam(self) -> None:
    nodes = self._compiled_nodes()
    self.assertEqual(nodes["join_main"]["type"], "join")
    self.assertEqual(nodes["player_main_video"]["type"], "video")
    self.assertEqual(nodes["player_main_slider"]["type"], "slider")
    self.assertEqual(nodes["pressure_main_axis"]["type"], "axis")
    self.assertEqual(nodes["pressure_main_table"]["type"], "table")
    self.assertEqual(nodes["spectrum_main_axis"]["type"], "axis")
    self.assertEqual(nodes["spectrum_main_buttons"]["type"], "buttons")
    self.assertEqual(nodes["webcam_main_camera"]["type"], "camera")
    self.assertEqual(nodes["webcam_main_buttons"]["type"], "buttons")

  def test_model_endpoint_uses_workspace_and_compiler_seams(self) -> None:
    app = create_app(str(self.deck_path))
    client = app.test_client()

    response = client.get("/model")
    self.assertEqual(response.status_code, 200)

    payload = response.get_json()
    nodes = {str(node["id"]): node for node in payload["nodes"]}
    self.assertEqual(
      [a["name"] for a in nodes["mc_main"]["multichoiceAnswers"]],
      ["Alpha", "Beta", "Gamma", "Delta"],
    )
    self.assertIn("publicBaseUrl", payload["defaults"])
    self.assertNotIn("/model", str(payload["defaults"]["publicBaseUrl"]))


if __name__ == "__main__":
  unittest.main()
