from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from flask import Flask, Response, request

from ..builtin_groups import InteractiveGroupControllerContext, build_builtin_group_module_registry
from ..presentation_workspace import FileSystemPresentationWorkspace
from .join_flow_resolver import JoinFlowResolver
from .join_flow_runtime import JoinFlowRuntime
from .phone_screen_renderer import render_phone_screen_page


def register_join_flow_routes(
  app: Flask,
  *,
  workspace: FileSystemPresentationWorkspace,
  presentation_dir: Path,
  runtime: JoinFlowRuntime,
) -> None:
  registry = build_builtin_group_module_registry()
  controllers = {
    definition.module_type: definition.controller
    for definition in registry.definitions().values()
    if definition.controller is not None
  }
  join_controller = controllers["join"]
  multichoice_controller = controllers["multichoice"]
  timer_controller = controllers["timer"]
  resolver = JoinFlowResolver(
    workspace=workspace,
    presentation_dir=presentation_dir,
    controllers=controllers,
    join_controller=join_controller,
  )

  def _ctx() -> InteractiveGroupControllerContext:
    return InteractiveGroupControllerContext(
      workspace=workspace,
      presentation_dir=presentation_dir,
      runtime=runtime,
      client_ip=_client_ip(),
    )

  def _client_ip() -> str:
    forwarded = str(request.headers.get("X-Forwarded-For", "") or "").split(",")[0].strip()
    return forwarded or str(request.remote_addr or "")

  def _render_join_page(join_id: str) -> str:
    screen_obj = join_controller.phone_screen(join_id, ctx=_ctx())
    if screen_obj is None:
      return "Join not found"
    return render_phone_screen_page(join_id=join_id, initial_screen=screen_obj.to_payload())

  @app.post("/update/multichoice")
  def update_multichoice():
    data = request.get_json(force=True, silent=False) or {}
    group_id = str(data.get("id", "")).strip()
    if not group_id:
      return Response("missing id", status=400, mimetype="text/plain")
    multichoice_controller.apply_runtime_update(group_id, data, ctx=_ctx())
    return Response(json.dumps({"ok": True, "kind": "multichoice"}), mimetype="application/json")

  @app.post("/update/timer")
  def update_timer():
    data = request.get_json(force=True, silent=False) or {}
    group_id = str(data.get("id", "")).strip()
    if not group_id:
      return Response("missing id", status=400, mimetype="text/plain")
    timer_controller.apply_runtime_update(group_id, data, ctx=_ctx())
    return Response(json.dumps({"ok": True, "kind": "timer"}), mimetype="application/json")

  @app.post("/update/table")
  def update_table():
    data = request.get_json(force=True, silent=False) or {}
    tid = str(data.get("id", "")).strip()
    if not tid:
      return Response("missing id", status=400, mimetype="text/plain")
    runtime.publish_event("table-update", data)
    return Response(json.dumps({"ok": True, "kind": "table"}), mimetype="application/json")

  @app.post("/update/interactive")
  def update_interactive():
    data = request.get_json(force=True, silent=False) or {}
    group_id = str(data.get("id", "") or data.get("groupId", "") or "").strip()
    module_type = str(data.get("moduleType", "") or data.get("module_type", "") or "").strip()
    if not group_id:
      return Response("missing id", status=400, mimetype="text/plain")
    if not module_type:
      return Response("missing moduleType", status=400, mimetype="text/plain")
    controller = controllers.get(module_type)
    if controller is None:
      return Response("unknown moduleType", status=404, mimetype="text/plain")
    result = controller.apply_runtime_update(group_id, data, ctx=_ctx())
    return Response(json.dumps({"ok": True, "kind": module_type, "screen": result}), mimetype="application/json")

  @app.get("/api/interactive/current")
  def interactive_current():
    join_id = str(request.args.get("joinId", "") or "").strip()
    joined = resolver.has_joined(join_id, _client_ip()) if join_id else False
    screen = resolver.current_screen(join_id=join_id, joined=joined, active_phone_screen=runtime.last_phone_screen, ctx=_ctx())
    if screen is not None:
      return Response(json.dumps({"ok": True, "joined": joined, "screen": screen.to_payload()}), mimetype="application/json")
    return Response(json.dumps({"ok": True, "joined": joined, "screen": None}), mimetype="application/json")

  @app.post("/api/interactive/<group_id>/action")
  def interactive_action(group_id: str):
    data = request.get_json(force=True, silent=False) or {}
    action_id = str(data.get("actionId", "") or "").strip()
    if not action_id:
      return Response("missing actionId", status=400, mimetype="text/plain")
    if resolver.find_join(group_id) is not None:
      result = join_controller.handle_phone_action(group_id, action_id, data, ctx=_ctx())
      return Response(json.dumps(result), mimetype="application/json")
    active = runtime.phone_screen(group_id)
    if active is None:
      return Response("group not active", status=404, mimetype="text/plain")
    module_type = str(active.get("moduleType", "") or "")
    controller = controllers.get(module_type)
    if controller is None:
      return Response("unsupported group controller", status=404, mimetype="text/plain")
    result = controller.handle_phone_action(group_id, action_id, data, ctx=_ctx())
    return Response(json.dumps(result), mimetype="application/json")

  @app.get("/api/multichoice/current")
  def multichoice_current():
    return Response(json.dumps({"ok": True, "prompt": runtime.last_multichoice_prompt}), mimetype="application/json")

  @app.get("/api/timer/current")
  def timer_current():
    return Response(json.dumps({"ok": True, "prompt": runtime.last_timer_prompt}), mimetype="application/json")

  @app.get("/api/timer/state")
  def timer_state():
    tid = str(request.args.get("id", "") or "").strip() or runtime.resolve_timer_id()
    if not tid:
      empty = {"accepting": False, "samplesMs": [], "stats": {"n": 0, "meanMs": None, "sigmaMs": None}, "lastSubmitMs": None}
      return Response(json.dumps(empty), mimetype="application/json")
    st = runtime.get_timer_state(tid)
    st["stats"] = runtime.timer_stats(list(st.get("samplesMs") or []))
    return Response(json.dumps(st), mimetype="application/json")

  @app.post("/api/timer/start")
  def timer_start():
    data = request.get_json(force=True, silent=True) or {}
    tid = runtime.resolve_timer_id(data)
    if not tid:
      return Response("missing timer id", status=404, mimetype="text/plain")
    result = timer_controller.handle_phone_action(tid, "start_timer", data, ctx=_ctx())
    return Response(json.dumps(result), mimetype="application/json")

  @app.post("/api/timer/stop")
  def timer_stop():
    data = request.get_json(force=True, silent=True) or {}
    tid = runtime.resolve_timer_id(data)
    if not tid:
      return Response("missing timer id", status=404, mimetype="text/plain")
    result = timer_controller.handle_phone_action(tid, "stop_timer", data, ctx=_ctx())
    return Response(json.dumps(result), mimetype="application/json")

  @app.post("/api/timer/reset")
  def timer_reset():
    data = request.get_json(force=True, silent=True) or {}
    tid = runtime.resolve_timer_id(data)
    if not tid:
      return Response("missing timer id", status=404, mimetype="text/plain")
    result = timer_controller.handle_phone_action(tid, "reset_timer", data, ctx=_ctx())
    return Response(json.dumps(result), mimetype="application/json")

  @app.get("/join/<join_id>")
  def join_page(join_id: str):
    if resolver.find_join(join_id) is None:
      return Response("Join not found", status=404, mimetype="text/plain")
    return Response(_render_join_page(join_id), mimetype="text/html")

  @app.post("/api/join/<join_id>")
  def join_submit(join_id: str):
    data = request.get_json(force=True, silent=False) or {}
    result = join_controller.handle_phone_action(join_id, "submit_join", {"values": data}, ctx=_ctx())
    if not result.get("ok"):
      return Response(str(result.get("error", "Join failed")), status=400, mimetype="text/plain")
    return Response("ok", mimetype="text/plain")

  @app.get("/api/join/<join_id>/check")
  def join_check(join_id: str):
    return Response(json.dumps({"joined": resolver.has_joined(join_id, _client_ip())}), mimetype="application/json")

  @app.post("/api/multichoice/<multichoice_id>")
  def multichoice_submit(multichoice_id: str):
    data = request.get_json(force=True, silent=False) or {}
    payload = {"choice": data.get("choice"), "other": data.get("other"), "values": data}
    result = multichoice_controller.handle_phone_action(multichoice_id, "submit_choice", payload, ctx=_ctx())
    if not result.get("ok"):
      return Response(str(result.get("error", "missing choice")), status=400, mimetype="text/plain")
    return Response("ok", mimetype="text/plain")

  @app.post("/api/timer/<timer_id>")
  def timer_submit(timer_id: str):
    data = request.get_json(force=True, silent=False) or {}
    action = str(data.get("action", "") or "").strip().lower()
    mapping = {
      "start": "start_timer",
      "stop": "stop_timer",
      "reset": "reset_timer",
      "submit": "submit_timer",
    }
    action_id = mapping.get(action, "")
    if not action_id:
      return Response("missing action", status=400, mimetype="text/plain")
    result = timer_controller.handle_phone_action(timer_id, action_id, data, ctx=_ctx())
    if not result.get("ok"):
      return Response(str(result.get("error", "timer action failed")), status=400, mimetype="text/plain")
    return Response("ok", mimetype="text/plain")

  @app.get("/events")
  def events():
    return Response(runtime.timer_events(request.remote_addr), mimetype="text/event-stream")
