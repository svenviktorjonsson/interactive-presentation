from __future__ import annotations

from ..controllers import ExperimentGroupController
from ..adapters import ExperimentModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class ExperimentInteractiveGroupModule(ExperimentGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "experiment_main"
  adapter_cls = ExperimentModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    phone_outputs=("table_entry",),
    audience_outputs=("table_fit", "table_entry"),
  )


MODULE = ExperimentInteractiveGroupModule()
DEFINITION = MODULE.definition()
