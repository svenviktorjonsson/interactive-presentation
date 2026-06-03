from __future__ import annotations

from ..controllers import JoinGroupController
from ..adapters import JoinModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import InteractiveGroupModuleBase


class JoinInteractiveGroupModule(JoinGroupController, InteractiveGroupModuleBase):
  canonical_group_id = "join_main"
  adapter_cls = JoinModuleAdapter
  capabilities = InteractiveGroupCapabilities(
    group_edit=True,
    phone_inputs=("join_fields",),
    phone_outputs=("join_form",),
    audience_outputs=("join_qr",),
  )


MODULE = JoinInteractiveGroupModule()
DEFINITION = MODULE.definition()
