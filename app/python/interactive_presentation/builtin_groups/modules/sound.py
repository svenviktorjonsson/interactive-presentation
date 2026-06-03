from __future__ import annotations

from ..controllers import SoundGroupController
from ..adapters import SoundModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class SoundInteractiveGroupModule(SoundGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "sound_main"
  adapter_cls = SoundModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    sensor_inputs=("sound_capture",),
    phone_outputs=("sound_controls",),
    audience_outputs=("sound_spectrum", "sound_time_series", "sound_peak"),
  )


MODULE = SoundInteractiveGroupModule()
DEFINITION = MODULE.definition()
