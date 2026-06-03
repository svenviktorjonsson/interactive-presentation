from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from interactive_presentation.builtin_groups import (
  FileSystemBuiltinGroupDefaultsSource,
  build_builtin_group_defaults_resolver,
  build_builtin_group_module_registry,
)
from interactive_presentation.builtin_groups.modules.sound import MODULE as SOUND_MODULE
from interactive_presentation.model_compiler import DefaultPresentationModelCompiler
from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace


class BuiltinGroupDefaultsTests(unittest.TestCase):
  def test_registry_exposes_interactive_group_capabilities(self) -> None:
    registry = build_builtin_group_module_registry()
    definitions = registry.definitions()

    self.assertIn("spectrum", definitions)
    self.assertIn("sound", definitions)
    self.assertEqual(definitions["spectrum"].canonical_group_id, "spectrum_main")
    self.assertIn("sensor_stream", definitions["spectrum"].capabilities.sensor_inputs)
    self.assertEqual(definitions["timer"].capabilities.phone_inputs, ("timer_submission",))
    self.assertIn("timer_prompt", definitions["timer"].capabilities.phone_outputs)
    self.assertIn("sensor_stream", definitions["spectrum"].capabilities.join_flow_inputs)
    self.assertIn("spectrum_peak", definitions["spectrum"].capabilities.audience_outputs)
    self.assertIsNotNone(definitions["join"].controller)
    self.assertIsNotNone(definitions["multichoice"].controller)
    self.assertIsNotNone(definitions["timer"].controller)
    self.assertIsNotNone(definitions["experiment"].controller)
    self.assertIsNotNone(definitions["sound"].controller)
    self.assertIsNotNone(definitions["webcam"].controller)
    self.assertIsNotNone(definitions["player"].controller)
    self.assertIsNotNone(definitions["pressure"].controller)
    self.assertIsNotNone(definitions["spectrum"].controller)

  def test_compiler_uses_builtin_group_defaults_when_deck_has_no_group_ledgers(self) -> None:
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      deck_dir = root / "spectrum_only"
      deck_dir.mkdir(parents=True, exist_ok=True)
      (deck_dir / "presentation.pr").write_text(
        "\n".join(
          [
            "text[id=title, align=left]: Spectrum fallback",
            "",
            "view[id=spectrum_view]:",
            "spectrum[id=spectrum_main, color=white, lineWidth=1, runLabel=Run, resumeLabel=Resume, pauseLabel=Pause, fLabel=Frequency, fXLabel=Frequency (Hz), fYLabel=Normalized Intensity, windowS=30, sampleMs=1, yLabel=Normalized Intensity]",
            "",
          ]
        ),
        encoding="utf-8",
      )
      (deck_dir / "geometries.csv").write_text(
        "\n".join(
          [
            "id,view,space,zIndex,x,y,w,h,rotationDeg,anchor,fontPx",
            "__screen_space__,screen_main,screen,0,0.5,0.5,1.0,1.0,1.0,centerCenter,",
            "title,screen_main,screen,0,0.03,0.04,0.3,0.05,0.0,topLeft,32.0",
            "spectrum_main,spectrum_view,world,0,0.5,0.5,0.92,0.82,0.0,centerCenter,",
          ]
        ),
        encoding="utf-8",
      )

      workspace = FileSystemPresentationWorkspace(deck_dir / "presentation.pr")
      compiler = DefaultPresentationModelCompiler()
      payload = compiler.compile(workspace.load_snapshot())
      nodes = {str(node["id"]): node for node in payload["nodes"]}

      self.assertEqual(nodes["spectrum_main_peak"]["align"], "center")
      self.assertEqual(nodes["spectrum_main_peak"]["template"], "Peak {{peak}} Hz")
      self.assertEqual(nodes["spectrum_main_x_label"]["align"], "center")
      self.assertEqual(nodes["spectrum_main_buttons"]["type"], "buttons")

  def test_defaults_source_reads_shared_workbench_groups(self) -> None:
    defaults = FileSystemBuiltinGroupDefaultsSource()
    self.assertEqual(defaults.canonical_group_id("sound"), "sound_main")
    self.assertTrue(defaults.load_group_geometries("sound"))
    self.assertIsNotNone(defaults.load_group_spec("spectrum"))

  def test_interactive_group_module_base_builds_definition_from_module_instance(self) -> None:
    definition = SOUND_MODULE.definition()

    self.assertEqual(definition.module_type, "sound")
    self.assertEqual(definition.canonical_group_id, "sound_main")
    self.assertIs(definition.controller, SOUND_MODULE)

  def test_defaults_resolver_maps_canonical_group_children_to_instance_ids(self) -> None:
    resolver = build_builtin_group_defaults_resolver()
    nodes = [
      {"id": "spectrum_main_peak", "type": "text", "text": "", "align": "left"},
      {"id": "spectrum_main_buttons", "type": "buttons", "labels": []},
    ]

    resolver.apply_item_overlay("spectrum", "spectrum_main", nodes, format_template=lambda text, _: text)
    resolver.apply_geometry_overlay("spectrum", "spectrum_main", nodes)

    self.assertEqual(nodes[0]["template"], "Peak {{peak}} Hz")
    self.assertEqual(nodes[0]["align"], "center")
    self.assertIn("labels", nodes[1])


if __name__ == "__main__":
  unittest.main()
