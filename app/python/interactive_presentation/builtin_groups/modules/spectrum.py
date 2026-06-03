from __future__ import annotations

from ..adapters import SpectrumModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import PassiveInteractiveGroupModule


class SpectrumInteractiveGroupModule(PassiveInteractiveGroupModule):
  module_type = "spectrum"
  canonical_group_id = "spectrum_main"
  adapter_cls = SpectrumModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    sensor_inputs=("sensor_stream",),
    audience_outputs=("spectrum_graph", "spectrum_peak"),
  )

  def __init__(self) -> None:
    super().__init__(self.module_type)


MODULE = SpectrumInteractiveGroupModule()
DEFINITION = MODULE.definition()
