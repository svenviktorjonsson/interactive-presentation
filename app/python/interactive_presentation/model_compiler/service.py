from __future__ import annotations

from typing import Any

from ..pr.compile import compile_model_payload
from ..presentation_workspace import PresentationWorkspaceSnapshot


class DefaultPresentationModelCompiler:
  def compile(self, snapshot: PresentationWorkspaceSnapshot) -> dict[str, Any]:
    return compile_model_payload(
      snapshot.presentation_spec,
      base_dir=snapshot.base_dir,
      notes_spec=snapshot.notes_spec,
    )
