from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from ..pr.parser import PresentationSpec, parse_presentation_pr
from ..pr.persist import (
  GeometryRow,
  delete_geometry_rows,
  delete_nodes_from_pr,
  ensure_group_files,
  load_geometries_csv,
  upsert_arrow_in_pr,
  upsert_bullets_in_pr,
  upsert_buttons_in_pr,
  upsert_element_in_pr,
  upsert_geometry_row,
  upsert_group_in_pr,
  upsert_image_in_pr,
  upsert_join_in_pr,
  upsert_table_in_pr,
  upsert_text_in_pr,
)
from .interfaces import PresentationWorkspaceSnapshot, WorkspaceDocument


class FileSystemPresentationWorkspace:
  def __init__(self, presentation_pr: str | Path):
    self.root_pr = Path(presentation_pr).resolve()
    self.presentation_dir = self.root_pr.parent
    self.notes_pr = self.presentation_dir / "notes.pr"
    self.media_dir = self.presentation_dir / "media"
    self.groups_dir = self.presentation_dir / "groups"

  def load_snapshot(self) -> PresentationWorkspaceSnapshot:
    return PresentationWorkspaceSnapshot(
      base_dir=self.presentation_dir,
      presentation_spec=self.load_spec("presentation"),
      notes_spec=self.load_spec("notes"),
    )

  def load_spec(self, doc: WorkspaceDocument = "presentation") -> PresentationSpec:
    return parse_presentation_pr(self.pr_path(doc))

  def pr_path(self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None) -> Path:
    if group_id:
      self.ensure_group_files(group_id)
      return self.group_dir(group_id) / "elements.pr"
    return self.notes_pr if doc == "notes" else self.root_pr

  def geometry_path(self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None) -> Path:
    if group_id:
      self.ensure_group_files(group_id)
      return self.group_dir(group_id) / "geometries.csv"
    return self.presentation_dir / ("notes_geometries.csv" if doc == "notes" else "geometries.csv")

  def group_dir(self, group_id: str) -> Path:
    return self.groups_dir / str(group_id).strip()

  def ensure_group_files(self, group_id: str) -> Path:
    group_dir = self.group_dir(group_id)
    ensure_group_files(group_dir)
    return group_dir

  def load_geometries(
    self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None
  ) -> dict[tuple[str, str], GeometryRow]:
    return load_geometries_csv(self.geometry_path(doc, group_id=group_id))

  def cleanup_orphan_group_dirs(self) -> None:
    if not self.groups_dir.exists():
      return
    active_ids = self._collect_group_ids(self.root_pr, set())
    if self.notes_pr.exists():
      active_ids = self._collect_group_ids(self.notes_pr, active_ids)
    for entry in self.groups_dir.iterdir():
      if not entry.is_dir():
        continue
      name = entry.name
      if name.startswith("."):
        continue
      if name not in active_ids:
        shutil.rmtree(entry, ignore_errors=True)

  def persist_text(self, *, doc: WorkspaceDocument, view_id: str, text_id: str, text: str, align: str | None = None, bg_color: str | None = None, bg_alpha: float | None = None, bg_padding: float | None = None, bg_radius: float | None = None, space: str | None = None, group_id: str | None = None) -> None:
    upsert_text_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      text_id=text_id,
      text=text,
      align=align,
      bg_color=bg_color,
      bg_alpha=bg_alpha,
      bg_padding=bg_padding,
      bg_radius=bg_radius,
      space=space,
    )

  def persist_buttons(self, *, doc: WorkspaceDocument, view_id: str, buttons_id: str, labels: list[str], actions: list[str], buttons_mode: str | None = None, h_splits: list[float] | None = None, v_splits: list[float] | None = None, rows: int | None = None, cols: int | None = None, space: str | None = None, group_id: str | None = None) -> None:
    upsert_buttons_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      buttons_id=buttons_id,
      labels=labels,
      actions=actions,
      buttons_mode=buttons_mode,
      h_splits=h_splits,
      v_splits=v_splits,
      rows=rows,
      cols=cols,
      space=space,
    )

  def persist_bullets(self, *, doc: WorkspaceDocument, view_id: str, bullets_id: str, text: str, bullets_type: str | None = None, align: str | None = None, bg_color: str | None = None, bg_alpha: float | None = None, bg_padding: float | None = None, bg_radius: float | None = None, space: str | None = None, group_id: str | None = None) -> None:
    upsert_bullets_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      bullets_id=bullets_id,
      text=text,
      bullets_type=bullets_type,
      align=align,
      bg_color=bg_color,
      bg_alpha=bg_alpha,
      bg_padding=bg_padding,
      bg_radius=bg_radius,
      space=space,
    )

  def persist_table(self, *, doc: WorkspaceDocument, view_id: str, table_id: str, space: str | None = None, group_id: str | None = None, **kwargs: Any) -> None:
    upsert_table_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      table_id=table_id,
      space=space,
      **kwargs,
    )

  def persist_image(self, *, doc: WorkspaceDocument, view_id: str, image_id: str, src: str | None, bg_color: str | None = None, bg_alpha: float | None = None, bg_padding: float | None = None, bg_radius: float | None = None, space: str | None = None, group_id: str | None = None) -> None:
    upsert_image_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      image_id=image_id,
      src=src,
      bg_color=bg_color,
      bg_alpha=bg_alpha,
      bg_padding=bg_padding,
      bg_radius=bg_radius,
      space=space,
    )

  def persist_arrow(self, *, doc: WorkspaceDocument, view_id: str, arrow_id: str, start_xy: tuple[float, float], end_xy: tuple[float, float], color: str | None = None, stroke_px: float | None = None, bg_color: str | None = None, bg_alpha: float | None = None, bg_padding: float | None = None, bg_radius: float | None = None, space: str | None = None, group_id: str | None = None, z_index: int | None = None) -> None:
    geom_path = self.geometry_path(doc, group_id=group_id)
    if z_index is None:
      existing = load_geometries_csv(geom_path).get((arrow_id, view_id))
      z_index = int(getattr(existing, "zIndex", 0) or 0) if existing else 0
    upsert_geometry_row(
      geom_path,
      GeometryRow(
        id=arrow_id,
        view=view_id,
        space=space or "world",
        zIndex=z_index,
        x=start_xy[0],
        y=start_xy[1],
        w=end_xy[0],
        h=end_xy[1],
        rotationDeg=0,
        anchor="topLeft",
        fontPx=None,
      ),
    )
    upsert_arrow_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      arrow_id=arrow_id,
      color=color,
      stroke_px=stroke_px,
      bg_color=bg_color,
      bg_alpha=bg_alpha,
      bg_padding=bg_padding,
      bg_radius=bg_radius,
      space=space,
    )

  def persist_join(self, *, doc: WorkspaceDocument, view_id: str, join_id: str, text: str, fields: list[str], color: str | None = None, bg_color: str | None = None, bg_alpha: float | None = None, bg_padding: float | None = None, bg_radius: float | None = None, space: str | None = None, group_id: str | None = None) -> None:
    upsert_join_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      join_id=join_id,
      text=text,
      fields=fields,
      color=color,
      bg_color=bg_color,
      bg_alpha=bg_alpha,
      bg_padding=bg_padding,
      bg_radius=bg_radius,
      space=space,
    )

  def persist_geometry(self, *, doc: WorkspaceDocument, geom: GeometryRow, group_id: str | None = None, preserve_existing_font_px: bool = False) -> None:
    geom_path = self.geometry_path(doc, group_id=group_id)
    final_geom = geom
    if preserve_existing_font_px and geom.fontPx is None:
      existing = load_geometries_csv(geom_path).get((geom.id, geom.view))
      if existing and existing.fontPx is not None:
        final_geom = GeometryRow(
          id=geom.id,
          view=geom.view,
          space=geom.space,
          zIndex=geom.zIndex,
          x=geom.x,
          y=geom.y,
          w=geom.w,
          h=geom.h,
          rotationDeg=geom.rotationDeg,
          anchor=geom.anchor,
          fontPx=existing.fontPx,
        )
    upsert_geometry_row(geom_path, final_geom)

  def persist_group(self, *, doc: WorkspaceDocument, view_id: str, group_id: str, space: str | None = None, parent_group_id: str | None = None) -> None:
    upsert_group_in_pr(self.pr_path(doc, group_id=parent_group_id), view_id=view_id, group_id=group_id, space=space)
    self.ensure_group_files(group_id)
    self.cleanup_orphan_group_dirs()

  def persist_element(self, *, doc: WorkspaceDocument, view_id: str, elem_type: str, elem_id: str, attrs: dict[str, Any], space: str | None = None, group_id: str | None = None) -> None:
    upsert_element_in_pr(
      self.pr_path(doc, group_id=group_id),
      view_id=view_id,
      elem_type=elem_type,
      elem_id=elem_id,
      attrs=attrs,
      space=space,
    )

  def delete_nodes(self, *, doc: WorkspaceDocument, ids: list[str], group_id: str | None = None) -> None:
    delete_nodes_from_pr(self.pr_path(doc, group_id=group_id), ids=ids)
    delete_geometry_rows(self.geometry_path(doc, group_id=group_id), ids)
    for maybe_group_id in ids:
      group_dir = self.group_dir(maybe_group_id)
      if group_dir.exists():
        shutil.rmtree(group_dir, ignore_errors=True)
    self.cleanup_orphan_group_dirs()

  def _collect_group_ids(self, pr_path: Path, seen: set[str]) -> set[str]:
    spec = parse_presentation_pr(pr_path)
    group_ids = {g.id for g in spec.groups}
    for screen in spec.screens:
      group_ids.update(g.id for g in screen.groups)
      group_ids.update(str(s.id) for s in screen.sounds)
      group_ids.update(str(s.id) for s in screen.spectra)
      group_ids.update(str(p.id) for p in screen.players)
      group_ids.update(str(w.id) for w in screen.webcams)
      group_ids.update(str(t.id) for t in screen.timers)
      group_ids.update(str(m.id) for m in screen.multichoices)
      group_ids.update(str(e.id) for e in screen.experiments)
      group_ids.update(str(w.id) for w in screen.wheels)
    group_ids.update(str(s.id) for s in spec.sounds)
    group_ids.update(str(s.id) for s in spec.spectra)
    group_ids.update(str(p.id) for p in spec.players)
    group_ids.update(str(w.id) for w in spec.webcams)
    group_ids.update(str(t.id) for t in spec.timers)
    group_ids.update(str(m.id) for m in spec.multichoices)
    group_ids.update(str(e.id) for e in spec.experiments)
    group_ids.update(str(w.id) for w in spec.wheels)
    for group_id in group_ids:
      if group_id in seen:
        continue
      seen.add(group_id)
      group_elements = self.group_dir(group_id) / "elements.pr"
      if group_elements.exists():
        self._collect_group_ids(group_elements, seen)
    return seen
