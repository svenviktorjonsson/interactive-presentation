from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from ..pr.parser import PresentationSpec
from ..pr.persist import GeometryRow

WorkspaceDocument = Literal["presentation", "notes"]


@dataclass(frozen=True)
class PresentationWorkspaceSnapshot:
  base_dir: Path
  presentation_spec: PresentationSpec
  notes_spec: PresentationSpec | None = None


class PresentationWorkspace(Protocol):
  root_pr: Path
  presentation_dir: Path
  notes_pr: Path
  media_dir: Path
  groups_dir: Path

  def load_snapshot(self) -> PresentationWorkspaceSnapshot: ...

  def load_spec(self, doc: WorkspaceDocument = "presentation") -> PresentationSpec: ...

  def pr_path(self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None) -> Path: ...

  def geometry_path(self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None) -> Path: ...

  def group_dir(self, group_id: str) -> Path: ...

  def ensure_group_files(self, group_id: str) -> Path: ...

  def load_geometries(
    self, doc: WorkspaceDocument = "presentation", *, group_id: str | None = None
  ) -> dict[tuple[str, str], GeometryRow]: ...

  def cleanup_orphan_group_dirs(self) -> None: ...

  def persist_text(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    text_id: str,
    text: str,
    align: str | None = None,
    bg_color: str | None = None,
    bg_alpha: float | None = None,
    bg_padding: float | None = None,
    bg_radius: float | None = None,
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def persist_buttons(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    buttons_id: str,
    labels: list[str],
    actions: list[str],
    buttons_mode: str | None = None,
    h_splits: list[float] | None = None,
    v_splits: list[float] | None = None,
    rows: int | None = None,
    cols: int | None = None,
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def persist_bullets(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    bullets_id: str,
    text: str,
    bullets_type: str | None = None,
    align: str | None = None,
    bg_color: str | None = None,
    bg_alpha: float | None = None,
    bg_padding: float | None = None,
    bg_radius: float | None = None,
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def persist_table(self, *, doc: WorkspaceDocument, view_id: str, table_id: str, space: str | None = None, group_id: str | None = None, **kwargs: Any) -> None: ...

  def persist_image(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    image_id: str,
    src: str | None,
    bg_color: str | None = None,
    bg_alpha: float | None = None,
    bg_padding: float | None = None,
    bg_radius: float | None = None,
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def persist_arrow(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    arrow_id: str,
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
    color: str | None = None,
    stroke_px: float | None = None,
    bg_color: str | None = None,
    bg_alpha: float | None = None,
    bg_padding: float | None = None,
    bg_radius: float | None = None,
    space: str | None = None,
    group_id: str | None = None,
    z_index: int | None = None,
  ) -> None: ...

  def persist_join(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    join_id: str,
    text: str,
    fields: list[str],
    color: str | None = None,
    bg_color: str | None = None,
    bg_alpha: float | None = None,
    bg_padding: float | None = None,
    bg_radius: float | None = None,
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def persist_geometry(
    self,
    *,
    doc: WorkspaceDocument,
    geom: GeometryRow,
    group_id: str | None = None,
    preserve_existing_font_px: bool = False,
  ) -> None: ...

  def persist_group(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    group_id: str,
    space: str | None = None,
    parent_group_id: str | None = None,
  ) -> None: ...

  def persist_element(
    self,
    *,
    doc: WorkspaceDocument,
    view_id: str,
    elem_type: str,
    elem_id: str,
    attrs: dict[str, Any],
    space: str | None = None,
    group_id: str | None = None,
  ) -> None: ...

  def delete_nodes(self, *, doc: WorkspaceDocument, ids: list[str], group_id: str | None = None) -> None: ...
