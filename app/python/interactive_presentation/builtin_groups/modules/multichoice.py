from __future__ import annotations

from ..controllers import MultiChoiceGroupController
from ..adapters import MultiChoiceModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class MultiChoiceInteractiveGroupModule(MultiChoiceGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "mc_main"
  adapter_cls = MultiChoiceModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    phone_inputs=("multichoice_vote",),
    phone_outputs=("multichoice_prompt", "multichoice_results"),
    audience_outputs=("multichoice_results",),
  )


MODULE = MultiChoiceInteractiveGroupModule()
DEFINITION = MODULE.definition()
