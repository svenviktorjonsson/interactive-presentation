from __future__ import annotations

from typing import Any

from flask import Flask, Response, request

from ..pr.persist import GeometryRow
from ..presentation_workspace import FileSystemPresentationWorkspace


def register_persist_routes(
  app: Flask,
  *,
  workspace: FileSystemPresentationWorkspace,
) -> None:
  def _doc_from_payload(data: dict) -> str:
    d = str(data.get("doc", "") or "presentation").strip().lower()
    return "notes" if d == "notes" else "presentation"

  def _parse_optional_float(value: Any) -> float | None:
    try:
      return float(value) if value is not None and str(value).strip() != "" else None
    except Exception:
      return None

  def _normalize_view_id(data: dict) -> tuple[str, str | None, str | None]:
    view_id = str(data.get("viewId", "home")).strip() or "home"
    space = str(data.get("space", "") or "").strip() or None
    group_id = str(data.get("groupId", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    return view_id, space, group_id

  @app.post("/persist/text")
  def persist_text():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    tid = str(data.get("id", "")).strip()
    txt = str(data.get("text", ""))
    align = str(data.get("align", "") or "").strip() or None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    view_id, space, group_id = _normalize_view_id(data)
    if not tid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_text(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      text_id=tid,
      text=txt,
      align=align,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/buttons")
  def persist_buttons():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    bid = str(data.get("id", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    labels = data.get("labels")
    actions = data.get("actions")
    buttons_mode = str(data.get("buttonsMode", "") or data.get("type", "")).strip() or None
    h_splits = data.get("hSplits")
    v_splits = data.get("vSplits")
    rows = data.get("rows")
    cols = data.get("cols")
    if not bid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_buttons(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      buttons_id=bid,
      labels=[str(x) for x in (labels or [])],
      actions=[str(x) for x in (actions or [])],
      buttons_mode=buttons_mode,
      h_splits=[float(x) for x in (h_splits or [])] if h_splits is not None else None,
      v_splits=[float(x) for x in (v_splits or [])] if v_splits is not None else None,
      rows=int(rows) if rows is not None else None,
      cols=int(cols) if cols is not None else None,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/bullets")
  def persist_bullets():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    bid = str(data.get("id", "")).strip()
    txt = str(data.get("text", ""))
    bullets_type = str(data.get("bullets", "") or data.get("type", "")).strip() or None
    align = str(data.get("align", "") or "").strip() or None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    view_id, space, group_id = _normalize_view_id(data)
    if not bid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_bullets(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      bullets_id=bid,
      text=txt,
      bullets_type=bullets_type,
      align=align,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/table")
  def persist_table():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    tid = str(data.get("id", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    cells = data.get("cells") or []
    rows = data.get("rows")
    cols = data.get("cols")
    editable = data.get("editable")
    h_header = data.get("hHeader")
    v_header = data.get("vHeader")
    h_style = data.get("hStyle")
    color = str(data.get("color", "") or "").strip() or None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    if not tid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_table(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      table_id=tid,
      cells=[[str(c) for c in (row or [])] for row in (cells or [])],
      rows=int(rows) if rows is not None else None,
      cols=int(cols) if cols is not None else None,
      editable=bool(editable) if editable is not None else None,
      h_header=[str(x) for x in (h_header or [])] if h_header is not None else None,
      v_header=[str(x) for x in (v_header or [])] if v_header is not None else None,
      h_style=[str(x) for x in (h_style or [])] if h_style is not None else None,
      color=color,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/image")
  def persist_image():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    iid = str(data.get("id", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    src = str(data.get("src", "") or "").strip() or None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    if not iid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_image(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      image_id=iid,
      src=src,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/arrow")
  def persist_arrow():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    aid = str(data.get("id", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    start = data.get("start") or {}
    end = data.get("end") or {}
    try:
      start_xy = (float(start.get("x", 0)), float(start.get("y", 0.5)))
    except Exception:
      start_xy = (0.0, 0.5)
    try:
      end_xy = (float(end.get("x", 1)), float(end.get("y", 0.5)))
    except Exception:
      end_xy = (1.0, 0.5)
    color = str(data.get("color", "") or "").strip() or None
    if color and "," in color:
      color = None
    stroke_px = _parse_optional_float(data.get("strokePx"))
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    if not aid:
      return Response("missing id", status=400, mimetype="text/plain")
    z_index_raw = data.get("zIndex", None)
    z_index: int | None = None
    if z_index_raw is not None and str(z_index_raw).strip() != "":
      try:
        z_index = int(float(z_index_raw))
      except Exception:
        z_index = None
    workspace.persist_arrow(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      arrow_id=aid,
      start_xy=start_xy,
      end_xy=end_xy,
      color=color,
      stroke_px=stroke_px,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
      z_index=z_index,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/join")
  def persist_join():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    jid = str(data.get("id", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    text = str(data.get("text", "") or "")
    fields = data.get("fields") or []
    color = str(data.get("color", "") or "").strip() or None
    if color and "," in color:
      color = None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha_val = _parse_optional_float(data.get("bgAlpha"))
    bg_padding_val = _parse_optional_float(data.get("bgPadding"))
    bg_radius_val = _parse_optional_float(data.get("bgRadius"))
    if not jid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_join(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      join_id=jid,
      text=text,
      fields=[str(f) for f in fields if str(f).strip()],
      color=color,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      bg_padding=bg_padding_val,
      bg_radius=bg_radius_val,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/geometry")
  def persist_geometry():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    gid = str(data.get("id", "")).strip()
    view_id = str(data.get("viewId", "home")).strip() or "home"
    t = data.get("transform") or {}
    space = str(data.get("space", "") or t.get("space", "") or "world").strip() or "world"
    group_id = str(data.get("groupId", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    if not gid:
      return Response("missing id", status=400, mimetype="text/plain")
    z_index_raw = data.get("zIndex", None)
    z_index: int | None = None
    if z_index_raw is not None and str(z_index_raw).strip() != "":
      try:
        z_index = int(float(z_index_raw))
      except Exception:
        z_index = None
    if z_index is None:
      existing = workspace.load_geometries("notes" if doc == "notes" else "presentation", group_id=group_id).get((gid, view_id))
      z_index = int(getattr(existing, "zIndex", 0) or 0) if existing else 0
    try:
      geom = GeometryRow(
        id=gid,
        view=view_id,
        space=space,
        zIndex=z_index,
        x=float(t.get("x", 0)),
        y=float(t.get("y", 0)),
        w=float(t.get("w", 0)),
        h=float(t.get("h", 0)),
        rotationDeg=float(t.get("rotationDeg", 0)),
        anchor=str(t.get("anchor", "centerCenter")),
        fontPx=float(data.get("fontPx")) if data.get("fontPx") is not None else None,
      )
    except Exception as e:
      return Response(f"bad payload: {type(e).__name__}", status=400, mimetype="text/plain")
    workspace.persist_geometry(
      doc="notes" if doc == "notes" else "presentation",
      geom=geom,
      group_id=group_id,
      preserve_existing_font_px=True,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/group")
  def persist_group():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    gid = str(data.get("id", "")).strip()
    view_id, space, parent_group_id = _normalize_view_id(data)
    if not gid:
      return Response("missing id", status=400, mimetype="text/plain")
    workspace.persist_group(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      group_id=gid,
      space=space,
      parent_group_id=parent_group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/element")
  def persist_element():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    eid = str(data.get("id", "")).strip()
    elem_type = str(data.get("type", "")).strip()
    view_id, space, group_id = _normalize_view_id(data)
    attrs = data.get("attrs") or {}
    if not eid or not elem_type:
      return Response("missing id or type", status=400, mimetype="text/plain")
    workspace.persist_element(
      doc="notes" if doc == "notes" else "presentation",
      view_id=view_id,
      elem_type=elem_type,
      elem_id=eid,
      attrs=attrs,
      space=space,
      group_id=group_id,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/delete")
  def persist_delete():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    ids = [str(x).strip() for x in (data.get("ids") or []) if str(x).strip()]
    group_id = str(data.get("groupId", "") or "").strip() or None
    if not ids:
      return Response("missing ids", status=400, mimetype="text/plain")
    workspace.delete_nodes(doc="notes" if doc == "notes" else "presentation", ids=ids, group_id=group_id)
    return Response("ok", mimetype="text/plain")
