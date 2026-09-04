from __future__ import annotations

import unittest

from interactive_presentation.model_compiler.composite_adapters import (
  CompositeRenderContext,
  build_default_composite_adapters,
)
from interactive_presentation.pr.parser import (
  ExperimentSpec,
  JoinSpec,
  MultiChoiceSpec,
  PlayerSpec,
  PressureSpec,
  SoundSpec,
  SpectrumSpec,
  TimerSpec,
  WebcamSpec,
)


def _parse_bullet_lines(text: str) -> list[dict[str, int | str]]:
  return [{"text": line, "indent": 0} for line in text.splitlines()]


class CompositeAdapterTests(unittest.TestCase):
  def setUp(self) -> None:
    self.nodes: list[dict] = []
    self.ctx = CompositeRenderContext(
      nodes=self.nodes,
      apply_element_defaults=lambda node, _type_key: None,
      group_local_to_world=lambda group_t, p: {
        "x": float(group_t["x"]) + float(p["x"]) * float(group_t["w"]),
        "y": float(group_t["y"]) + float(p["y"]) * float(group_t["h"]),
      },
      local_override_factory=lambda _group_id: (lambda _child_id, fallback: fallback),
      parse_bullet_lines=_parse_bullet_lines,
    )
    self.adapters = build_default_composite_adapters()
    self.transform = {"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0, "rotationDeg": 0.0, "anchor": "centerCenter"}

  def test_multichoice_adapter_builds_expected_nodes(self) -> None:
    spec = MultiChoiceSpec(
      id="mc_test",
      question="Pick one",
      answers=[("Alpha", "red"), ("Beta", "blue")],
      start_label="Start",
      reset_label="Reset",
    )

    self.adapters["multichoice"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    ids = [node["id"] for node in self.nodes]
    self.assertEqual(
      ids,
      ["mc_test", "mc_test_wheel", "mc_test_wheel_canvas", "mc_test_question", "mc_test_answers", "mc_test_buttons"],
    )
    self.assertEqual(self.nodes[0]["multichoiceRole"], "root")
    self.assertEqual(self.nodes[2]["multichoiceRole"], "wheel")
    self.assertEqual(self.nodes[4]["items"], [{"text": "{{item0}}", "indent": 0}, {"text": "{{item1}}", "indent": 0}])

  def test_timer_adapter_builds_axis_buttons_and_labels(self) -> None:
    spec = TimerSpec(id="timer_test", duration_s=5.0, x_label="Time", y_label="Progress", value_label="{{elapsed}}")

    self.adapters["timer"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    ids = [node["id"] for node in self.nodes]
    self.assertEqual(
      ids,
      ["timer_test", "timer_test_axis", "timer_test_buttons", "timer_test_x_label", "timer_test_y_label", "timer_test_stats"],
    )
    self.assertEqual(self.nodes[1]["timerRole"], "axis")
    self.assertEqual(self.nodes[2]["actions"], ["timer-toggle", "timer-reset"])

  def test_experiment_adapter_builds_table_axis_text_and_buttons(self) -> None:
    spec = ExperimentSpec(
      id="exp_test",
      title="Experiment",
      transforms=["x", "1/x"],
      h_header=["Col 1", "Col 2"],
      cells=[["1", "2"]],
    )

    self.adapters["experiment"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    ids = [node["id"] for node in self.nodes]
    self.assertEqual(
      ids,
      [
        "exp_test",
        "exp_test_table",
        "exp_test_axis",
        "exp_test_title",
        "exp_test_x_label",
        "exp_test_y_label",
        "exp_test_fit_label",
        "exp_test_x_buttons",
        "exp_test_y_buttons",
        "exp_test_t_buttons",
      ],
    )
    self.assertEqual(self.nodes[1]["experimentRole"], "table")
    self.assertEqual(self.nodes[-1]["actions"], ["experiment-t:0", "experiment-t:1", "experiment-fit", "experiment-clear"])

  def test_player_adapter_builds_video_buttons_and_slider(self) -> None:
    spec = PlayerSpec(id="player_test", src="clip.mp4", play_label="Play", pause_label="Pause")

    self.adapters["player"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual([node["id"] for node in self.nodes], ["player_test", "player_test_video", "player_test_buttons", "player_test_slider"])
    self.assertEqual(self.nodes[1]["src"], "/media/clip.mp4")
    self.assertEqual(self.nodes[2]["actions"], ["toggle"])

  def test_pressure_adapter_builds_expected_children(self) -> None:
    spec = PressureSpec(id="pressure_test", x_label="Time", y_label="Pressure")

    self.adapters["pressure"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual(
      [node["id"] for node in self.nodes],
      ["pressure_test", "pressure_test_axis", "pressure_test_buttons", "pressure_test_threshold", "pressure_test_x_label", "pressure_test_y_label", "pressure_test_table"],
    )
    self.assertEqual(self.nodes[1]["pressureRole"], "axis")
    self.assertEqual(self.nodes[-1]["type"], "table")

  def test_webcam_adapter_builds_camera_and_buttons(self) -> None:
    spec = WebcamSpec(id="webcam_test", device_id="cam0", rec_label="Rec", shot_label="Shot")

    self.adapters["webcam"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual([node["id"] for node in self.nodes], ["webcam_test", "webcam_test_camera", "webcam_test_buttons"])
    self.assertEqual(self.nodes[1]["deviceId"], "cam0")
    self.assertEqual(self.nodes[2]["actions"], ["rec", "shot"])

  def test_join_adapter_builds_atomic_join_node(self) -> None:
    spec = JoinSpec(id="join_test", fields=["name", "email"], text="Hello {{name}}")

    self.adapters["join"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual([node["id"] for node in self.nodes], ["join_test"])
    self.assertEqual(self.nodes[0]["fields"], ["name", "email"])
    self.assertEqual(self.nodes[0]["template"], "Hello {{name}}")

  def test_sound_adapter_builds_axis_controls_threshold_and_labels(self) -> None:
    spec = SoundSpec(id="sound_test", mode="time", run_label="Run", reset_label="Reset", home_label="Home")

    self.adapters["sound"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual(
      [node["id"] for node in self.nodes],
      ["sound_test", "sound_test_axis", "sound_test_buttons", "sound_test_mode_buttons", "sound_test_threshold", "sound_test_x_label", "sound_test_y_label", "sound_test_peak"],
    )
    self.assertEqual(self.nodes[1]["soundRole"], "axis")
    self.assertEqual(self.nodes[2]["actions"], ["sound-toggle", "sound-reset", "sound-home"])
    self.assertEqual(self.nodes[3]["actions"], ["sound-mode-frequency", "sound-mode-time"])

  def test_spectrum_adapter_builds_axis_button_and_labels(self) -> None:
    spec = SpectrumSpec(id="spectrum_test", f_label="Frequency", f_x_label="Frequency (Hz)")

    self.adapters["spectrum"].compile(self.ctx, spec, transform=self.transform, space="world", view_id="home", layer=None)

    self.assertEqual(
      [node["id"] for node in self.nodes],
      ["spectrum_test", "spectrum_test_axis", "spectrum_test_buttons", "spectrum_test_x_label", "spectrum_test_y_label", "spectrum_test_peak"],
    )
    self.assertEqual(self.nodes[1]["soundRole"], "axis")
    self.assertEqual(self.nodes[2]["actions"], ["sound-toggle", "sound-reset"])


if __name__ == "__main__":
  unittest.main()
