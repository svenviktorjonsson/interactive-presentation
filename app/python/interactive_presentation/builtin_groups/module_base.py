from __future__ import annotations

from typing import TypeVar

from .controllers import EventDrivenInteractiveGroupController, InteractiveGroupControllerBase, PassiveInteractiveGroupController
from .interfaces import BuiltinGroupModuleAdapter, BuiltinGroupModuleDefinition, InteractiveGroupCapabilities

AdapterT = TypeVar("AdapterT", bound=BuiltinGroupModuleAdapter)


class InteractiveGroupModuleBase(InteractiveGroupControllerBase):
  canonical_group_id: str = ""
  adapter_cls: type[AdapterT] | None = None
  capabilities = InteractiveGroupCapabilities()

  def build_adapter(self) -> BuiltinGroupModuleAdapter:
    adapter_cls = self.adapter_cls
    if adapter_cls is None:
      raise ValueError(f"{type(self).__name__} is missing adapter_cls")
    return adapter_cls()

  def definition(self) -> BuiltinGroupModuleDefinition:
    if not self.module_type:
      raise ValueError(f"{type(self).__name__} is missing module_type")
    if not self.canonical_group_id:
      raise ValueError(f"{type(self).__name__} is missing canonical_group_id")
    return BuiltinGroupModuleDefinition(
      module_type=self.module_type,
      canonical_group_id=self.canonical_group_id,
      adapter=self.build_adapter(),
      controller=self,
      capabilities=self.capabilities,
    )


class PassiveInteractiveGroupModule(PassiveInteractiveGroupController, InteractiveGroupModuleBase):
  pass


class EventDrivenInteractiveGroupModule(EventDrivenInteractiveGroupController, InteractiveGroupModuleBase):
  pass
