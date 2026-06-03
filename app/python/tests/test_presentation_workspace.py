from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from interactive_presentation.presentation_workspace import FileSystemPresentationWorkspace


class PresentationWorkspaceTests(unittest.TestCase):
  def test_group_persistence_writes_into_group_workspace_files(self) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
      root = Path(tmp_dir) / "presentation.pr"
      root.write_text("view[id=home]:\n", encoding="utf-8")

      workspace = FileSystemPresentationWorkspace(root)
      workspace.ensure_group_files("mc_main")
      workspace.persist_bullets(
        doc="presentation",
        view_id="group",
        bullets_id="mc_main_answers",
        text="{{item0}}\n{{item1}}\n{{item2}}\n{{item3}}",
        bullets_type="A.",
        align="left",
        group_id="mc_main",
      )

      group_elements = workspace.group_dir("mc_main") / "elements.pr"
      rendered = group_elements.read_text(encoding="utf-8")
      self.assertIn("{{item0}}", rendered)
      self.assertIn("{{item3}}", rendered)
      self.assertNotIn("\n-\n-\n-\n-\n", rendered)

  def test_workspace_resolves_presentation_and_notes_paths(self) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
      root = Path(tmp_dir) / "presentation.pr"
      root.write_text("view[id=home]:\n", encoding="utf-8")
      workspace = FileSystemPresentationWorkspace(root)

      self.assertEqual(workspace.pr_path("presentation"), root.resolve())
      self.assertEqual(workspace.pr_path("notes"), (root.parent / "notes.pr").resolve())
      self.assertEqual(workspace.geometry_path("presentation").resolve(), (root.parent / "geometries.csv").resolve())
      self.assertEqual(workspace.geometry_path("notes").resolve(), (root.parent / "notes_geometries.csv").resolve())

  def test_delete_nodes_removes_group_workspace_and_geometry_rows(self) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
      root = Path(tmp_dir) / "presentation.pr"
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
      workspace = FileSystemPresentationWorkspace(root)
      workspace.ensure_group_files("group_main")
      workspace.geometry_path("presentation").write_text(
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

      workspace.delete_nodes(doc="presentation", ids=["title_main", "group_main"])

      rendered = root.read_text(encoding="utf-8")
      self.assertNotIn("text[id=title_main]", rendered)
      self.assertNotIn("group[id=group_main]", rendered)
      self.assertFalse(workspace.group_dir("group_main").exists())
      rows = workspace.load_geometries("presentation")
      self.assertEqual(rows, {})


if __name__ == "__main__":
  unittest.main()
