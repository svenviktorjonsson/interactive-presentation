from __future__ import annotations

from ..adapters import PlayerModuleAdapter
from ..interfaces import InteractiveGroupCapabilities
from ..module_base import PassiveInteractiveGroupModule


class PlayerInteractiveGroupModule(PassiveInteractiveGroupModule):
  module_type = "player"
  canonical_group_id = "player_main"
  adapter_cls = PlayerModuleAdapter
  capabilities = InteractiveGroupCapabilities(group_edit=True, audience_outputs=("media_controls",))

  def __init__(self) -> None:
    super().__init__(self.module_type)


MODULE = PlayerInteractiveGroupModule()
DEFINITION = MODULE.definition()
