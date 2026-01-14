from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator

from flask import Flask, Response, send_from_directory

from ..pr.parser import parse_presentation_pr
from ..pr.compile import compile_model_payload


def create_app(presentation_pr: str) -> Flask:
  root = Path(presentation_pr).resolve()
  pres_dir = root.parent
  web_dist = (Path(__file__).resolve().parents[3] / "web" / "dist").resolve()

  app = Flask(__name__, static_folder=None)

  @app.get("/")
  def index():
    return send_from_directory(web_dist, "index.html")

  @app.get("/assets/<path:p>")
  def assets(p: str):
    return send_from_directory(web_dist / "assets", p)

  @app.get("/model")
  def model():
    pr = parse_presentation_pr(root)
    payload = compile_model_payload(pr, base_dir=pres_dir)
    return Response(json.dumps(payload), mimetype="application/json")

  @app.get("/events")
  def events():
    # SSE stream for interactive updates.
    # IMPORTANT: do not mutate the model on connect (it breaks basic .pr testing).
    def gen() -> Iterator[str]:
      # Keepalive only (prevents some proxies from buffering forever).
      # Client can ignore.
      yield ": ok\n\n"

    return Response(gen(), mimetype="text/event-stream")

  return app


def run_server(presentation_pr: str, port: int = 8000) -> None:
  app = create_app(presentation_pr)
  host = os.environ.get("IP_HOST", "127.0.0.1")
  app.run(host=host, port=port, debug=False, threaded=True)

