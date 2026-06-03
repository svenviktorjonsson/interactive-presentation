from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from interactive_presentation.server.app import create_app


class PersistRouteTests(unittest.TestCase):
  def _make_client(self) -> tuple[Path, object]:
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text("view[id=home]:\n", encoding="utf-8")
    return root, create_app(str(root)).test_client()

  def test_persist_text_route_updates_presentation_source(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/persist/text",
      json={"id": "title_main", "viewId": "home", "text": "Hello workspace", "align": "center"},
    )

    self.assertEqual(response.status_code, 200)
    rendered = root.read_text(encoding="utf-8")
    self.assertIn("Hello workspace", rendered)
    self.assertIn("text[id=title_main, align=center]: Hello workspace", rendered)

  def test_persist_geometry_route_writes_geometry_csv(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/persist/geometry",
      json={
        "id": "title_main",
        "viewId": "home",
        "space": "world",
        "transform": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "rotationDeg": 5, "anchor": "centerCenter"},
        "fontPx": 24,
      },
    )

    self.assertEqual(response.status_code, 200)
    geom_path = root.parent / "geometries.csv"
    with geom_path.open("r", encoding="utf-8", newline="") as handle:
      rows = list(csv.DictReader(handle))
    self.assertEqual(len(rows), 1)
    self.assertEqual(rows[0]["id"], "title_main")
    self.assertEqual(rows[0]["x"], "0.1")
    self.assertEqual(rows[0]["fontPx"], "24.0")

  def test_persist_group_route_creates_group_workspace(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/persist/group",
      json={"id": "group_main", "viewId": "home", "space": "world"},
    )

    self.assertEqual(response.status_code, 200)
    group_dir = root.parent / "groups" / "group_main"
    self.assertTrue(group_dir.exists())
    self.assertTrue((group_dir / "elements.pr").exists())
    self.assertIn("group[id=group_main]", root.read_text(encoding="utf-8"))

  def test_persist_buttons_route_writes_button_configuration(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/persist/buttons",
      json={
        "id": "controls_main",
        "viewId": "home",
        "labels": ["Start", "Reset"],
        "actions": ["timer:start", "timer:reset"],
        "buttonsMode": "grid",
        "rows": 1,
        "cols": 2,
        "hSplits": [0.55, 0.45],
      },
    )

    self.assertEqual(response.status_code, 200)
    rendered = root.read_text(encoding="utf-8")
    self.assertIn("buttons[id=controls_main", rendered)
    self.assertIn("labels=[Start, Reset]", rendered)
    self.assertIn("actions=[timer:start, timer:reset]", rendered)
    self.assertIn("type=grid", rendered)
    self.assertIn("rows=1", rendered)
    self.assertIn("cols=2", rendered)
    self.assertIn("hSplits=[0.55, 0.45]", rendered)

  def test_persist_bullets_route_writes_multiline_bullets_block(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/persist/bullets",
      json={
        "id": "agenda_main",
        "viewId": "home",
        "text": "Alpha\nBeta\nGamma",
        "bullets": "A.",
        "align": "left",
        "bgColor": "#112233",
        "bgAlpha": 0.5,
      },
    )

    self.assertEqual(response.status_code, 200)
    rendered = root.read_text(encoding="utf-8")
    self.assertIn("bullets[id=agenda_main, type=A., align=left, bgColor=#112233, bgAlpha=0.5]:", rendered)
    self.assertIn("Alpha", rendered)
    self.assertIn("Beta", rendered)
    self.assertIn("Gamma", rendered)

  def test_persist_delete_route_removes_nodes_geometry_and_group_workspace(self) -> None:
    root, client = self._make_client()
    root.write_text(
      "\n".join(
        [
          "group[id=group_main]",
          "view[id=home]:",
          "text[id=title_main]: Hello",
          "",
        ]
      ),
      encoding="utf-8",
    )
    group_dir = root.parent / "groups" / "group_main"
    group_dir.mkdir(parents=True, exist_ok=True)
    (group_dir / "elements.pr").write_text("view[id=group]:\n", encoding="utf-8")
    geom_path = root.parent / "geometries.csv"
    geom_path.write_text(
      "\n".join(
        [
          "id,view,space,zIndex,x,y,w,h,rotationDeg,anchor,fontPx",
          "title_main,home,world,0,0.1,0.2,0.3,0.4,0,centerCenter,24",
          "group_main,home,world,1,0.0,0.0,0.5,0.5,0,topLeft,",
          "",
        ]
      ),
      encoding="utf-8",
    )

    response = client.post("/persist/delete", json={"ids": ["title_main", "group_main"]})

    self.assertEqual(response.status_code, 200)
    rendered = root.read_text(encoding="utf-8")
    self.assertNotIn("text[id=title_main]", rendered)
    self.assertNotIn("group[id=group_main]", rendered)
    self.assertFalse(group_dir.exists())
    with geom_path.open("r", encoding="utf-8", newline="") as handle:
      rows = list(csv.DictReader(handle))
    self.assertEqual(rows, [])


if __name__ == "__main__":
  unittest.main()
