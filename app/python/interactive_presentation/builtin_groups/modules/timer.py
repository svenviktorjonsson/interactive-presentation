from __future__ import annotations

from ..controllers import TimerGroupController
from ..adapters import TimerModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class TimerInteractiveGroupModule(TimerGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "timer_main"
  adapter_cls = TimerModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    phone_inputs=("timer_submission",),
    phone_outputs=("timer_prompt", "timer_status"),
    audience_outputs=("timer_results",),
  )


MODULE = TimerInteractiveGroupModule()
DEFINITION = MODULE.definition()
