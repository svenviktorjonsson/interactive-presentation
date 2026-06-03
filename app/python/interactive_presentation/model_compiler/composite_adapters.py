from __future__ import annotations

from ..builtin_groups.adapters import (
  CompositeModuleAdapter,
  CompositeRenderContext,
  ExperimentModuleAdapter,
  JoinModuleAdapter,
  MultiChoiceModuleAdapter,
  PlayerModuleAdapter,
  PressureModuleAdapter,
  SoundModuleAdapter,
  SpectrumModuleAdapter,
  TimerModuleAdapter,
  WebcamModuleAdapter,
)

__all__ = [
  "CompositeModuleAdapter",
  "CompositeRenderContext",
  "ExperimentModuleAdapter",
  "JoinModuleAdapter",
  "MultiChoiceModuleAdapter",
  "PlayerModuleAdapter",
  "PressureModuleAdapter",
  "SoundModuleAdapter",
  "SpectrumModuleAdapter",
  "TimerModuleAdapter",
  "WebcamModuleAdapter",
  "build_default_composite_adapters",
]


def build_default_composite_adapters() -> dict[str, CompositeModuleAdapter]:
  return {
    "join": JoinModuleAdapter(),
    "multichoice": MultiChoiceModuleAdapter(),
    "player": PlayerModuleAdapter(),
    "pressure": PressureModuleAdapter(),
    "sound": SoundModuleAdapter(),
    "spectrum": SpectrumModuleAdapter(),
    "timer": TimerModuleAdapter(),
    "experiment": ExperimentModuleAdapter(),
    "webcam": WebcamModuleAdapter(),
  }
