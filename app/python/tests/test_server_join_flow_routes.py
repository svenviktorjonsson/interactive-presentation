from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from interactive_presentation.server.app import create_app


class JoinFlowRouteTests(unittest.TestCase):
  def _make_client(self) -> tuple[Path, object]:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text(
      "\n".join(
        [
          "join[id=join_main, fields={Name, Email}]: Welcome",
          "view[id=home]:",
          "",
        ]
      ),
      encoding="utf-8",
    )
    return root, create_app(str(root)).test_client()

  def test_join_page_renders_fields_from_presentation_workspace(self) -> None:
    _root, client = self._make_client()

    response = client.get("/join/join_main")

    self.assertEqual(response.status_code, 200)
    html = response.get_data(as_text=True)
    self.assertIn("Welcome", html)
    self.assertIn('input name="Name"', html)
    self.assertIn('input name="Email"', html)

  def test_join_submit_and_check_use_join_flow_runtime_seam(self) -> None:
    root, client = self._make_client()

    response = client.post("/api/join/join_main", json={"Name": "Ada", "Email": "ada@example.com"})

    self.assertEqual(response.status_code, 200)
    csv_path = root.parent / "user_info.csv"
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
      rows = list(csv.DictReader(handle))
    self.assertEqual(len(rows), 1)
    self.assertEqual(rows[0]["join_id"], "join_main")
    self.assertEqual(rows[0]["Name"], "Ada")
    self.assertEqual(rows[0]["Email"], "ada@example.com")

    check = client.get("/api/join/join_main/check", environ_base={"REMOTE_ADDR": rows[0]["ip"]})
    self.assertEqual(check.status_code, 200)
    self.assertEqual(check.get_json()["joined"], True)

  def test_multichoice_prompt_round_trips_through_current_endpoint(self) -> None:
    _root, client = self._make_client()

    update = client.post(
      "/update/multichoice",
      json={"id": "mc_main", "active": True, "round": 2, "question": "Pick", "answers": ["A", "B"], "labels": ["A", "B"]},
    )

    self.assertEqual(update.status_code, 200)
    current = client.get("/api/multichoice/current")
    self.assertEqual(current.status_code, 200)
    prompt = current.get_json()["prompt"]
    self.assertEqual(prompt["id"], "mc_main")
    self.assertEqual(prompt["round"], 2)

    interactive = client.get("/api/interactive/current?joinId=join_main")
    self.assertEqual(interactive.status_code, 200)
    payload = interactive.get_json()
    self.assertEqual(payload["joined"], False)
    self.assertEqual(payload["screen"]["moduleType"], "join")

  def test_timer_state_updates_after_submit_action(self) -> None:
    _root, client = self._make_client()

    update = client.post(
      "/update/timer",
      json={"id": "timer_main", "active": True, "running": False, "labels": {"start": "Start", "stop": "Stop", "reset": "Reset", "toggle": "Start"}},
    )
    self.assertEqual(update.status_code, 200)

    submit = client.post("/api/timer/timer_main", json={"action": "submit", "elapsedMs": 1532})
    self.assertEqual(submit.status_code, 200)

    state = client.get("/api/timer/state?id=timer_main")
    self.assertEqual(state.status_code, 200)
    payload = state.get_json()
    self.assertEqual(payload["lastSubmitMs"], 1532)
    self.assertEqual(payload["samplesMs"], [1532])
    self.assertEqual(payload["stats"]["n"], 1)

  def test_interactive_current_returns_join_screen_then_active_prompt(self) -> None:
    root, client = self._make_client()

    before = client.get("/api/interactive/current?joinId=join_main")
    self.assertEqual(before.status_code, 200)
    before_payload = before.get_json()
    self.assertEqual(before_payload["screen"]["moduleType"], "join")

    client.post("/api/join/join_main", json={"Name": "Ada", "Email": "ada@example.com"})
    with (root.parent / "user_info.csv").open("r", encoding="utf-8", newline="") as handle:
      rows = list(csv.DictReader(handle))
    ip = rows[0]["ip"]
    client.post(
      "/update/multichoice",
      json={"id": "mc_main", "active": True, "round": 3, "question": "Pick one", "answers": ["A", "B"]},
    )

    after = client.get("/api/interactive/current?joinId=join_main", environ_base={"REMOTE_ADDR": ip})
    self.assertEqual(after.status_code, 200)
    after_payload = after.get_json()
    self.assertEqual(after_payload["joined"], True)
    self.assertEqual(after_payload["screen"]["moduleType"], "multichoice")
    self.assertEqual(after_payload["screen"]["title"], "Pick one")

  def test_generic_interactive_action_submits_multichoice_vote(self) -> None:
    _root, client = self._make_client()

    client.post(
      "/update/multichoice",
      json={"id": "mc_main", "active": True, "round": 1, "question": "Pick", "answers": ["A", "B"]},
    )

    action = client.post(
      "/api/interactive/mc_main/action",
      json={"actionId": "submit_choice", "choice": "B", "values": {}},
    )

    self.assertEqual(action.status_code, 200)
    self.assertEqual(action.get_json()["ok"], True)

  def test_generic_interactive_update_supports_event_driven_modules(self) -> None:
    _root, client = self._make_client()

    update = client.post(
      "/update/interactive",
      json={
        "id": "sound_main",
        "moduleType": "sound",
        "screen": {
          "title": "Sound Controls",
          "subtitle": "Adjust capture",
          "active": True,
          "elements": [
            {
              "kind": "button",
              "label": "Toggle capture",
              "action": {"kind": "server", "actionId": "toggle_capture", "groupId": "sound_main"},
            }
          ],
        },
      },
    )

    self.assertEqual(update.status_code, 200)
    current = client.get("/api/interactive/current?joinId=join_main")
    self.assertEqual(current.status_code, 200)
    payload = current.get_json()
    self.assertEqual(payload["screen"]["moduleType"], "join")

    action = client.post(
      "/api/interactive/sound_main/action",
      json={"actionId": "toggle_capture", "values": {}},
    )
    self.assertEqual(action.status_code, 200)
    self.assertEqual(action.get_json()["ok"], True)

  def test_experiment_interactive_screen_and_submit_row(self) -> None:
    _root, client = self._make_client()

    update = client.post(
      "/update/interactive",
      json={
        "id": "experiment_main",
        "moduleType": "experiment",
        "fields": ["X", "Y"],
        "title": "Experiment Entry",
        "tableId": "experiment_main_table",
      },
    )
    self.assertEqual(update.status_code, 200)

    current = client.get("/api/interactive/current")
    self.assertEqual(current.status_code, 200)
    payload = current.get_json()
    self.assertEqual(payload["screen"]["moduleType"], "experiment")
    self.assertEqual(payload["screen"]["title"], "Experiment Entry")

    submit = client.post(
      "/api/interactive/experiment_main/action",
      json={"actionId": "submit_row", "values": {"X": "1.2", "Y": "3.4"}},
    )
    self.assertEqual(submit.status_code, 200)
    self.assertEqual(submit.get_json()["ok"], True)

  def test_webcam_interactive_update_produces_webcam_screen(self) -> None:
    _root, client = self._make_client()

    update = client.post(
      "/update/interactive",
      json={
        "id": "webcam_main",
        "moduleType": "webcam",
        "controls": [
          {"label": "Rec", "actionId": "rec"},
          {"label": "Shot", "actionId": "shot"},
        ],
      },
    )
    self.assertEqual(update.status_code, 200)

    action = client.post(
      "/api/interactive/webcam_main/action",
      json={"actionId": "shot", "values": {}},
    )
    self.assertEqual(action.status_code, 200)
    self.assertEqual(action.get_json()["ok"], True)


if __name__ == "__main__":
  unittest.main()
