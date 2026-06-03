from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..pr.persist import GeometryRow


class BuiltinGroupModuleAdapter(Protocol):
  module_type: str

  def compile(
    self,
    ctx: Any,
    spec: Any,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None: ...


@dataclass(frozen=True)
class PhoneAction:
  kind: str
  action_id: str | None = None
  group_id: str | None = None
  payload: dict[str, Any] = field(default_factory=dict)

  def to_payload(self) -> dict[str, Any]:
    return asdict(self)


@dataclass(frozen=True)
class PhoneOption:
  id: str
  label: str
  color: str | None = None
  other: bool = False

  def to_payload(self) -> dict[str, Any]:
    return asdict(self)


@dataclass(frozen=True)
class PhoneElement:
  kind: str
  id: str | None = None
  text: str | None = None
  label: str | None = None
  name: str | None = None
  input_type: str | None = None
  placeholder: str | None = None
  required: bool = False
  value: str | None = None
  options: tuple[PhoneOption, ...] = ()
  action: PhoneAction | None = None
  actions: tuple[PhoneAction, ...] = ()
  props: dict[str, Any] = field(default_factory=dict)

  def to_payload(self) -> dict[str, Any]:
    payload = asdict(self)
    if self.action is not None:
      payload["action"] = self.action.to_payload()
    if self.actions:
      payload["actions"] = [action.to_payload() for action in self.actions]
    if self.options:
      payload["options"] = [option.to_payload() for option in self.options]
    return payload


@dataclass(frozen=True)
class PhoneScreen:
  module_type: str
  group_id: str
  title: str
  subtitle: str = ""
  elements: tuple[PhoneElement, ...] = ()
  active: bool = True

  def to_payload(self) -> dict[str, Any]:
    return {
      "moduleType": self.module_type,
      "groupId": self.group_id,
      "title": self.title,
      "subtitle": self.subtitle,
      "active": self.active,
      "elements": [element.to_payload() for element in self.elements],
    }


@dataclass(frozen=True)
class NodePatch:
  node_id: str
  patch: dict[str, Any] = field(default_factory=dict)

  def to_payload(self) -> dict[str, Any]:
    return {
      "id": self.node_id,
      "patch": dict(self.patch),
    }


@dataclass(frozen=True)
class DesktopRuntimeUpdate:
  node_patches: tuple[NodePatch, ...] = ()

  def to_payload(self) -> dict[str, Any]:
    return {
      "nodePatches": [node_patch.to_payload() for node_patch in self.node_patches],
    }


@dataclass(frozen=True)
class InteractiveGroupControllerContext:
  workspace: Any
  presentation_dir: Path
  runtime: Any
  client_ip: str = ""


class InteractiveGroupController(Protocol):
  module_type: str

  def phone_screen(self, group_id: str, *, ctx: InteractiveGroupControllerContext) -> PhoneScreen | None: ...

  def handle_phone_action(
    self,
    group_id: str,
    action_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any]: ...

  def apply_runtime_update(
    self,
    group_id: str,
    payload: dict[str, Any],
    *,
    ctx: InteractiveGroupControllerContext,
  ) -> dict[str, Any] | None: ...


@dataclass(frozen=True)
class InteractiveGroupCapabilities:
  group_edit: bool = True
  sensor_inputs: tuple[str, ...] = ()
  phone_inputs: tuple[str, ...] = ()
  phone_outputs: tuple[str, ...] = ()
  audience_outputs: tuple[str, ...] = ()

  @property
  def join_flow_inputs(self) -> tuple[str, ...]:
    return (*self.sensor_inputs, *self.phone_inputs)


@dataclass(frozen=True)
class BuiltinGroupModuleDefinition:
  module_type: str
  canonical_group_id: str
  adapter: BuiltinGroupModuleAdapter
  capabilities: InteractiveGroupCapabilities = field(default_factory=InteractiveGroupCapabilities)
  controller: InteractiveGroupController | None = None


class BuiltinGroupModuleRegistry(Protocol):
  def definitions(self) -> dict[str, BuiltinGroupModuleDefinition]: ...

  def definition_for(self, module_type: str) -> BuiltinGroupModuleDefinition | None: ...


class BuiltinGroupDefaultsSource(Protocol):
  def defaults_root(self) -> Path: ...

  def canonical_group_id(self, module_type: str) -> str | None: ...

  def load_group_geometries(self, module_type: str) -> dict[tuple[str, str], GeometryRow]: ...

  def load_group_spec(self, module_type: str) -> Any | None: ...
