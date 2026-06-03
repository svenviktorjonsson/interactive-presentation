from __future__ import annotations

from typing import Any, Protocol

from ..presentation_workspace import PresentationWorkspaceSnapshot


class PresentationModelCompiler(Protocol):
  def compile(self, snapshot: PresentationWorkspaceSnapshot) -> dict[str, Any]: ...
