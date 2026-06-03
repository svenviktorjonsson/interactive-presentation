from __future__ import annotations

from dataclasses import dataclass

from .interfaces import BuiltinGroupModuleDefinition, BuiltinGroupModuleRegistry
from .modules import (
  EXPERIMENT_DEFINITION,
  JOIN_DEFINITION,
  MULTICHOICE_DEFINITION,
  PLAYER_DEFINITION,
  PRESSURE_DEFINITION,
  SOUND_DEFINITION,
  SPECTRUM_DEFINITION,
  TIMER_DEFINITION,
  WEBCAM_DEFINITION,
)


@dataclass(frozen=True)
class StaticBuiltinGroupModuleRegistry(BuiltinGroupModuleRegistry):
  _definitions: dict[str, BuiltinGroupModuleDefinition]

  def definitions(self) -> dict[str, BuiltinGroupModuleDefinition]:
    return dict(self._definitions)

  def definition_for(self, module_type: str) -> BuiltinGroupModuleDefinition | None:
    return self._definitions.get(str(module_type))


def build_builtin_group_module_registry() -> BuiltinGroupModuleRegistry:
  definitions = {
    definition.module_type: definition
    for definition in (
      JOIN_DEFINITION,
      MULTICHOICE_DEFINITION,
      PLAYER_DEFINITION,
      TIMER_DEFINITION,
      EXPERIMENT_DEFINITION,
      PRESSURE_DEFINITION,
      SOUND_DEFINITION,
      SPECTRUM_DEFINITION,
      WEBCAM_DEFINITION,
    )
  }
  return StaticBuiltinGroupModuleRegistry(definitions)
