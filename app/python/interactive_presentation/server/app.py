from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import csv
import datetime as dt
import os
from flask import Flask, Response, request, send_from_directory

from ..pr.parser import parse_presentation_pr
from ..pr.compile import compile_model_payload
from ..pr.persist import (
  GeometryRow,
  delete_geometry_rows,
  delete_nodes_from_pr,
  upsert_arrow_in_pr,
  upsert_bullets_in_pr,
  upsert_geometry_row,
  upsert_image_in_pr,
  upsert_join_in_pr,
  upsert_text_in_pr,
)


def create_app(presentation_pr: str) -> Flask:
  root = Path(presentation_pr).resolve()
  pres_dir = root.parent
  notes_pr = pres_dir / "notes.pr"
  web_dist = (Path(__file__).resolve().parents[3] / "web" / "dist").resolve()

  app = Flask(__name__, static_folder=None)

  def _doc_from_payload(data: dict) -> str:
    d = str(data.get("doc", "") or "presentation").strip().lower()
    return "notes" if d == "notes" else "presentation"

  def _pr_path_for_doc(doc: str) -> Path:
    return notes_pr if doc == "notes" else root

  def _geom_path_for_doc(doc: str) -> Path:
    return pres_dir / ("notes_geometries.csv" if doc == "notes" else "geometries.csv")

  @app.get("/")
  def index():
    return send_from_directory(web_dist, "index.html")

  @app.get("/assets/<path:p>")
  def assets(p: str):
    return send_from_directory(web_dist / "assets", p)

  @app.get("/media/<path:p>")
  def media(p: str):
    media_dir = pres_dir / "media"
    return send_from_directory(media_dir, p)

  @app.get("/model")
  def model():
    pr = parse_presentation_pr(root)
    notes = parse_presentation_pr(notes_pr)
    payload = compile_model_payload(pr, base_dir=pres_dir, notes_spec=notes)
    base = (os.environ.get("PUBLIC_BASE_URL") or str(request.base_url)).rstrip("/")
    payload.setdefault("defaults", {})
    payload["defaults"]["publicBaseUrl"] = base
    return Response(json.dumps(payload), mimetype="application/json")

  @app.post("/persist/text")
  def persist_text():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    tid = str(data.get("id", "")).strip()
    txt = str(data.get("text", ""))
    align = str(data.get("align", "") or "").strip() or None
    view_id = str(data.get("viewId", "home")).strip() or "home"
    space = str(data.get("space", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    if not tid:
      return Response("missing id", status=400, mimetype="text/plain")
    upsert_text_in_pr(_pr_path_for_doc(doc), view_id=view_id, text_id=tid, text=txt, align=align, space=space)
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
    bg_alpha = data.get("bgAlpha", None)
    try:
      bg_alpha_val = float(bg_alpha) if bg_alpha is not None and str(bg_alpha).strip() != "" else None
    except Exception:
      bg_alpha_val = None
    view_id = str(data.get("viewId", "home")).strip() or "home"
    space = str(data.get("space", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    if not bid:
      return Response("missing id", status=400, mimetype="text/plain")
    upsert_bullets_in_pr(
      _pr_path_for_doc(doc),
      view_id=view_id,
      bullets_id=bid,
      text=txt,
      bullets_type=bullets_type,
      align=align,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      space=space,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/image")
  def persist_image():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    iid = str(data.get("id", "")).strip()
    view_id = str(data.get("viewId", "home")).strip() or "home"
    src = str(data.get("src", "") or "").strip() or None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha = data.get("bgAlpha", None)
    try:
      bg_alpha_val = float(bg_alpha) if bg_alpha is not None and str(bg_alpha).strip() != "" else None
    except Exception:
      bg_alpha_val = None
    space = str(data.get("space", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    if not iid:
      return Response("missing id", status=400, mimetype="text/plain")
    upsert_image_in_pr(
      _pr_path_for_doc(doc),
      view_id=view_id,
      image_id=iid,
      src=src,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      space=space,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/arrow")
  def persist_arrow():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    aid = str(data.get("id", "")).strip()
    view_id = str(data.get("viewId", "home")).strip() or "home"
    space = str(data.get("space", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
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
    stroke_raw = data.get("strokePx", None)
    try:
      stroke_px = float(stroke_raw) if stroke_raw is not None and str(stroke_raw).strip() != "" else None
    except Exception:
      stroke_px = None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha = data.get("bgAlpha", None)
    try:
      bg_alpha_val = float(bg_alpha) if bg_alpha is not None and str(bg_alpha).strip() != "" else None
    except Exception:
      bg_alpha_val = None
    if not aid:
      return Response("missing id", status=400, mimetype="text/plain")
    upsert_geometry_row(
      _geom_path_for_doc(doc),
      GeometryRow(
        id=aid,
        view=view_id,
        space=space or "world",
        x=start_xy[0],
        y=start_xy[1],
        w=end_xy[0],
        h=end_xy[1],
        rotationDeg=0,
        anchor="topLeft",
        fontPx=None,
      ),
    )
    upsert_arrow_in_pr(
      _pr_path_for_doc(doc),
      view_id=view_id,
      arrow_id=aid,
      color=color,
      stroke_px=stroke_px,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      space=space,
    )
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/join")
  def persist_join():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    jid = str(data.get("id", "")).strip()
    view_id = str(data.get("viewId", "home")).strip() or "home"
    space = str(data.get("space", "") or "").strip() or None
    if space == "screen":
      view_id = "screen_main"
    text = str(data.get("text", "") or "")
    fields = data.get("fields") or []
    color = str(data.get("color", "") or "").strip() or None
    if color and "," in color:
      color = None
    bg_color = str(data.get("bgColor", "") or "").strip() or None
    bg_alpha = data.get("bgAlpha", None)
    try:
      bg_alpha_val = float(bg_alpha) if bg_alpha is not None and str(bg_alpha).strip() != "" else None
    except Exception:
      bg_alpha_val = None
    if not jid:
      return Response("missing id", status=400, mimetype="text/plain")
    upsert_join_in_pr(
      _pr_path_for_doc(doc),
      view_id=view_id,
      join_id=jid,
      text=text,
      fields=[str(f) for f in fields if str(f).strip()],
      color=color,
      bg_color=bg_color,
      bg_alpha=bg_alpha_val,
      space=space,
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
    if space == "screen":
      view_id = "screen_main"
    if not gid:
      return Response("missing id", status=400, mimetype="text/plain")
    try:
      geom = GeometryRow(
        id=gid,
        view=view_id,
        space=space,
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
    upsert_geometry_row(_geom_path_for_doc(doc), geom)
    return Response("ok", mimetype="text/plain")

  def _find_join(join_id: str) -> dict | None:
    pr = parse_presentation_pr(root)
    for j in pr.joins:
      if j.id == join_id:
        return {
          "id": j.id,
          "fields": list(j.fields or []),
          "text": j.text,
        }
    return None

  @app.get("/join/<join_id>")
  def join_page(join_id: str):
    spec = _find_join(join_id)
    if not spec:
      return Response("Join not found", status=404, mimetype="text/plain")
    fields = spec.get("fields") or []
    desc = spec.get("text") or ""
    def input_type(name: str) -> str:
      n = name.lower()
      if "email" in n:
        return "email"
      if "år" in n or "year" in n or "birth" in n:
        return "number"
      return "text"
    rows = []
    for f in fields:
      itype = input_type(f)
      rows.append(
        f"""<label>{f}</label>
          <input name="{f}" type="{itype}" required />"""
      )
    fields_html = "\n".join(rows)
    html = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Join</title>
    <style>
      :root {{ color-scheme: dark; }}
      body {{ margin:0; background:#0b1020; color:rgba(255,255,255,0.92); font-family:system-ui,Segoe UI,Roboto,Arial; }}
      .wrap {{ min-height:100vh; display:grid; place-items:center; padding:24px; }}
      .card {{ width:min(520px, 100%); border:1px solid rgba(255,255,255,0.14); border-radius:16px; background:rgba(255,255,255,0.06); padding:18px; }}
      h1 {{ font-size:18px; margin:0 0 10px; }}
      p {{ margin:0 0 14px; color:rgba(255,255,255,0.7); }}
      label {{ display:block; font-size:12px; color:rgba(255,255,255,0.7); margin:10px 0 6px; }}
      input {{ width:100%; box-sizing:border-box; padding:10px 10px; border-radius:12px; border:1px solid rgba(255,255,255,0.14);
              background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.92); }}
      button {{ margin-top:14px; width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(110,168,255,0.34);
               background:rgba(110,168,255,0.22); color:rgba(255,255,255,0.92); font-weight:800; cursor:pointer; }}
      .ok {{ display:none; }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card" id="formCard">
        <h1>Join</h1>
        <p>{desc}</p>
        <form id="f">
          {fields_html}
          <button type="submit">Join</button>
        </form>
      </div>
      <div class="card ok" id="okCard">
        <h1>Stand by</h1>
        <p>You're connected.</p>
      </div>
    </div>
    <script>
      const f = document.getElementById('f');
      f.addEventListener('submit', async (e) => {{
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f).entries());
        const res = await fetch('/api/join/{join_id}', {{
          method:'POST',
          headers:{{'content-type':'application/json'}},
          body: JSON.stringify(data)
        }});
        if (res.ok) {{
          document.getElementById('formCard').style.display='none';
          document.getElementById('okCard').style.display='block';
        }} else {{
          alert('Join failed');
        }}
      }});
    </script>
  </body>
</html>"""
    return Response(html, mimetype="text/html")

  @app.post("/api/join/<join_id>")
  def join_submit(join_id: str):
    spec = _find_join(join_id)
    if not spec:
      return Response("Join not found", status=404, mimetype="text/plain")
    data = request.get_json(force=True, silent=False) or {}
    fields = spec.get("fields") or []
    out = {f: str(data.get(f, "") or "") for f in fields}
    out["join_id"] = join_id
    out["timestamp"] = dt.datetime.utcnow().isoformat()
    csv_path = pres_dir / "user_info.csv"
    write_header = not csv_path.exists()
    with csv_path.open("a", encoding="utf-8", newline="") as f:
      writer = csv.DictWriter(f, fieldnames=["timestamp", "join_id", *fields])
      if write_header:
        writer.writeheader()
      writer.writerow(out)
    return Response("ok", mimetype="text/plain")

  @app.post("/persist/delete")
  def persist_delete():
    data = request.get_json(force=True, silent=False)
    doc = _doc_from_payload(data)
    ids = [str(x).strip() for x in (data.get("ids") or []) if str(x).strip()]
    if not ids:
      return Response("missing ids", status=400, mimetype="text/plain")
    delete_nodes_from_pr(_pr_path_for_doc(doc), ids=ids)
    delete_geometry_rows(_geom_path_for_doc(doc), ids)
    return Response("ok", mimetype="text/plain")

  @app.post("/api/media/upload")
  def upload_media():
    f = request.files.get("file")
    if not f:
      return Response("missing file", status=400, mimetype="text/plain")
    ct = (f.content_type or "").lower()
    if not ct.startswith("image/"):
      return Response("Only image/* is allowed", status=400, mimetype="text/plain")
    name = (f.filename or "image").strip()
    safe = "".join(ch for ch in name if ch.isalnum() or ch in ("-", "_", ".", " ")).strip().replace(" ", "_")
    if not safe or safe.startswith("."):
      safe = "image"
    if "." not in safe:
      ext = ct.split("/", 1)[1].split(";", 1)[0].strip()
      if ext == "jpeg":
        ext = "jpg"
      safe = f"{safe}.{ext or 'png'}"
    base = safe.rsplit(".", 1)[0]
    ext = safe.rsplit(".", 1)[1]
    media_dir = pres_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    out = (media_dir / safe).resolve()
    if not str(out).startswith(str(media_dir.resolve())):
      return Response("invalid filename", status=400, mimetype="text/plain")
    i = 2
    while out.exists():
      out = (media_dir / f"{base}_{i}.{ext}").resolve()
      i += 1
    data = f.read()
    if data is None:
      data = b""
    if len(data) > 25 * 1024 * 1024:
      return Response("File too large", status=413, mimetype="text/plain")
    out.write_bytes(data)
    return Response(json.dumps({"ok": True, "src": f"/media/{out.name}", "filename": out.name, "contentType": ct}), mimetype="application/json")

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

