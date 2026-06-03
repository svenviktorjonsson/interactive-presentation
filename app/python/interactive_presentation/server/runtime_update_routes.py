from __future__ import annotations

import json
from typing import Any

from flask import Flask, Response, request

from ..builtin_groups import DesktopRuntimeUpdate, NodePatch
from ..pr.template import format_template
from ..presentation_workspace import FileSystemPresentationWorkspace
from .join_flow_runtime import JoinFlowRuntime


def register_runtime_update_routes(
  app: Flask,
  *,
  workspace: FileSystemPresentationWorkspace,
  runtime: JoinFlowRuntime,
) -> None:
  def _parse_bullet_lines(raw: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ln in str(raw or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
      if not ln.strip():
        continue
      tabs = len(ln) - len(ln.lstrip("\t"))
      spaces = len(ln) - len(ln.lstrip(" "))
      indent = tabs + (spaces // 2)
      content = ln.lstrip(" \t")
      out.append({"text": content, "indent": indent})
    return out

  def _publish_desktop_update(update: DesktopRuntimeUpdate) -> None:
    for node_patch in update.node_patches:
      runtime.publish_node_patch(node_patch.node_id, dict(node_patch.patch))

  @app.post("/update/text")
  def update_text():
    data = request.get_json(force=True, silent=False)
    tid = str(data.get("id", "")).strip()
    payload = data.get("data") or {}
    if not tid:
      return Response("missing id", status=400, mimetype="text/plain")
    pr = workspace.load_spec("presentation")

    def iter_texts():
      for t in pr.texts:
        yield t
      for scr in pr.screens:
        for t in scr.texts:
          yield t

    def iter_bullets():
      for b in pr.bullets:
        yield b
      for scr in pr.screens:
        for b in scr.bullets:
          yield b

    def iter_joins():
      for j in pr.joins:
        yield j
      for scr in pr.screens:
        for j in scr.joins:
          yield j

    def iter_buttons():
      for b in pr.buttons:
        yield b
      for scr in pr.screens:
        for b in scr.buttons:
          yield b

    for t in iter_texts():
      if str(t.id) == tid:
        text = format_template(t.text, payload)
        _publish_desktop_update(
          DesktopRuntimeUpdate(
            node_patches=(NodePatch(node_id=tid, patch={"text": text}),),
          )
        )
        return Response(json.dumps({"ok": True, "kind": "text"}), mimetype="application/json")
    for b in iter_bullets():
      if str(b.id) == tid:
        raw = format_template(b.text, payload)
        items = _parse_bullet_lines(raw)
        _publish_desktop_update(
          DesktopRuntimeUpdate(
            node_patches=(NodePatch(node_id=tid, patch={"rawText": raw, "items": items}),),
          )
        )
        return Response(json.dumps({"ok": True, "kind": "bullets"}), mimetype="application/json")
    for j in iter_joins():
      if str(j.id) == tid:
        text = format_template(j.text, payload)
        _publish_desktop_update(
          DesktopRuntimeUpdate(
            node_patches=(NodePatch(node_id=tid, patch={"text": text}),),
          )
        )
        return Response(json.dumps({"ok": True, "kind": "join"}), mimetype="application/json")
    for btn in iter_buttons():
      if str(btn.id) == tid:
        templates = list(btn.labels or [])
        labels = [format_template(x, payload) for x in templates]
        _publish_desktop_update(
          DesktopRuntimeUpdate(
            node_patches=(NodePatch(node_id=tid, patch={"labels": labels}),),
          )
        )
        return Response(json.dumps({"ok": True, "kind": "buttons"}), mimetype="application/json")
    return Response("not found", status=404, mimetype="text/plain")
