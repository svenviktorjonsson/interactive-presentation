from __future__ import annotations

from ..adapters import PressureModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import PassiveInteractiveGroupModule


class PressureInteractiveGroupModule(PassiveInteractiveGroupModule):
  module_type = "pressure"
  canonical_group_id = "pressure_main"
  adapter_cls = PressureModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    sensor_inputs=("pressure_reading",),
    audience_outputs=("pressure_graph", "pressure_peak"),
  )

  def __init__(self) -> None:
    super().__init__(self.module_type)


MODULE = PressureInteractiveGroupModule()
DEFINITION = MODULE.definition()
