from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from .interfaces import BuiltinGroupDefaultsSource
from ..pr.parser import parse_presentation_pr
from ..pr.persist import GeometryRow, load_geometries_csv


class FileSystemBuiltinGroupDefaultsSource(BuiltinGroupDefaultsSource):
  def __init__(self, defaults_root: str | Path | None = None, *, canonical_group_ids: dict[str, str] | None = None):
    repo_root = Path(__file__).resolve().parents[4]
    self._defaults_root = Path(defaults_root) if defaults_root else repo_root / "presentations" / "defaults_workbench" / "groups"
    self._canonical_group_ids = dict(canonical_group_ids or {
      "join": "join_main",
      "multichoice": "mc_main",
      "player": "player_main",
      "timer": "timer_main",
      "experiment": "experiment_main",
      "pressure": "pressure_main",
      "sound": "sound_main",
      "spectrum": "spectrum_main",
      "webcam": "webcam_main",
    })

  def defaults_root(self) -> Path:
    return self._defaults_root

  def canonical_group_id(self, module_type: str) -> str | None:
    return self._canonical_group_ids.get(str(module_type))

  def _group_dir(self, module_type: str) -> Path | None:
    canonical_id = self.canonical_group_id(module_type)
    if not canonical_id:
      return None
    group_dir = self._defaults_root / canonical_id
    return group_dir if group_dir.exists() else None

  @lru_cache(maxsize=None)
  def load_group_geometries(self, module_type: str) -> dict[tuple[str, str], GeometryRow]:
    group_dir = self._group_dir(module_type)
    if not group_dir:
      return {}
    return load_geometries_csv(group_dir / "geometries.csv")

  @lru_cache(maxsize=None)
  def load_group_spec(self, module_type: str) -> Any | None:
    group_dir = self._group_dir(module_type)
    if not group_dir:
      return None
    elements_pr = group_dir / "elements.pr"
    if not elements_pr.exists():
      return None
    return parse_presentation_pr(elements_pr)
