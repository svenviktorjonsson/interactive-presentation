from __future__ import annotations

import socket
from pathlib import Path
from typing import Any
import urllib.parse

import os
from flask import Flask

from ..model_compiler import DefaultPresentationModelCompiler
from ..presentation_workspace import FileSystemPresentationWorkspace
from .join_flow_routes import register_join_flow_routes
from .join_flow_runtime import JoinFlowRuntime
from .media_routes import register_media_routes
from .model_routes import register_model_routes
from .persist_routes import register_persist_routes
from .runtime_update_routes import register_runtime_update_routes


def _infer_public_base_url(req: Any) -> str:
  override = str(os.environ.get("PUBLIC_BASE_URL", "") or "").strip()
  if override:
    return override.rstrip("/")
  host_url = str(req.host_url or "").rstrip("/")
  parsed = urllib.parse.urlparse(host_url)
  host = (parsed.hostname or "").strip().lower()
  if host not in {"127.0.0.1", "localhost", "::1"}:
    return host_url
  lan_ip = None
  sock = None
  try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.connect(("8.8.8.8", 80))
    lan_ip = str(sock.getsockname()[0] or "").strip()
  except Exception:
    lan_ip = None
  finally:
    if sock is not None:
      try:
        sock.close()
      except Exception:
        pass
  if not lan_ip:
    return host_url
  netloc = lan_ip
  if parsed.port:
    netloc = f"{lan_ip}:{parsed.port}"
  scheme = parsed.scheme or "http"
  return urllib.parse.urlunparse((scheme, netloc, "", "", "", "")).rstrip("/")


def create_app(presentation_pr: str) -> Flask:
  root = Path(presentation_pr).resolve()
  workspace = FileSystemPresentationWorkspace(root)
  compiler = DefaultPresentationModelCompiler()
  pres_dir = workspace.presentation_dir
  web_dist = (Path(__file__).resolve().parents[3] / "web" / "dist").resolve()

  app = Flask(__name__, static_folder=None)
  join_flow_runtime = JoinFlowRuntime()
  register_media_routes(app, presentation_dir=pres_dir, web_dist=web_dist)
  register_model_routes(app, workspace=workspace, compiler=compiler, infer_public_base_url=_infer_public_base_url)
  register_persist_routes(app, workspace=workspace)
  register_runtime_update_routes(app, workspace=workspace, runtime=join_flow_runtime)
  register_join_flow_routes(app, workspace=workspace, presentation_dir=pres_dir, runtime=join_flow_runtime)

  return app


def run_server(presentation_pr: str, port: int = 8000) -> None:
  app = create_app(presentation_pr)
  host = os.environ.get("IP_HOST", "0.0.0.0")
  app.run(host=host, port=port, debug=False, threaded=True)
