from __future__ import annotations

import json
from collections.abc import Callable

from flask import Flask, Response, request

from ..model_compiler import DefaultPresentationModelCompiler
from ..presentation_workspace import FileSystemPresentationWorkspace


def register_model_routes(
  app: Flask,
  *,
  workspace: FileSystemPresentationWorkspace,
  compiler: DefaultPresentationModelCompiler,
  infer_public_base_url: Callable[[object], str],
) -> None:
  @app.get("/model")
  def model():
    workspace.cleanup_orphan_group_dirs()
    payload = compiler.compile(workspace.load_snapshot())
    base = infer_public_base_url(request)
    payload.setdefault("defaults", {})
    payload["defaults"]["publicBaseUrl"] = base
    return Response(json.dumps(payload), mimetype="application/json")
