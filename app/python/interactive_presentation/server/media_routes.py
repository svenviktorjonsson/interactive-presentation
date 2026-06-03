from __future__ import annotations

import json
import mimetypes
import re
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Flask, Response, request, send_from_directory


def register_media_routes(
  app: Flask,
  *,
  presentation_dir: Path,
  web_dist: Path,
) -> None:
  @app.get("/")
  def index():
    return send_from_directory(web_dist, "index.html")

  @app.get("/assets/<path:p>")
  def assets(p: str):
    assets_dir = (web_dist / "assets").resolve()
    target = (assets_dir / p).resolve()
    if not str(target).startswith(str(assets_dir)) or not target.exists():
      return ("", 404)
    data = target.read_bytes()
    mime, _ = mimetypes.guess_type(str(target))
    return Response(data, mimetype=mime or "application/octet-stream")

  @app.get("/yt-thumb/<video_id>")
  def yt_thumb(video_id: str):
    vid = (video_id or "").strip()
    if not vid or "/" in vid or ".." in vid:
      return Response("bad id", status=400, mimetype="text/plain")
    url = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    try:
      with urllib.request.urlopen(url) as res:
        data = res.read()
      return Response(data, mimetype="image/jpeg")
    except Exception:
      return Response("not found", status=404, mimetype="text/plain")

  @app.get("/media/<path:p>")
  def media(p: str):
    media_dir = presentation_dir / "media"
    return send_from_directory(media_dir, p)

  @app.get("/iframe-proxy")
  def iframe_proxy():
    target = str(request.args.get("url", "") or "").strip()
    if not target:
      return Response("missing url", status=400, mimetype="text/plain")
    if not (target.startswith("http://") or target.startswith("https://")):
      return Response("invalid url", status=400, mimetype="text/plain")

    def inject_base(html: str, base_url: str) -> str:
      if re.search(r"<base\s", html, flags=re.IGNORECASE):
        return html
      base_tag = f'<base href="{base_url}">'
      head_match = re.search(r"<head[^>]*>", html, flags=re.IGNORECASE)
      if head_match:
        insert_at = head_match.end()
        return html[:insert_at] + base_tag + html[insert_at:]
      return base_tag + html

    def fetch(url: str):
      req = urllib.request.Request(
        url,
        headers={"User-Agent": "interactive-presentation/iframe-proxy"},
        method="GET",
      )
      with urllib.request.urlopen(req, timeout=10) as res:
        data = res.read()
        if data is None:
          data = b""
        if len(data) > 10 * 1024 * 1024:
          return None, Response("content too large", status=413, mimetype="text/plain")
        ctype = res.headers.get("Content-Type") or "text/html"
      if "text/html" in ctype or "application/xhtml+xml" in ctype:
        html = data.decode("utf-8", errors="ignore")
        html = inject_base(html, url)
        data = html.encode("utf-8")
        ctype = "text/html; charset=utf-8"
      return (data, ctype), None

    try:
      out, err = fetch(target)
      if err:
        return err
      return Response(out[0], mimetype=out[1])
    except Exception as exc:
      parsed = urllib.parse.urlparse(target)
      host = (parsed.hostname or "").lower()
      if parsed.scheme == "https" and host in {"localhost", "127.0.0.1", "::1"}:
        retry = parsed._replace(scheme="http")
        retry_url = urllib.parse.urlunparse(retry)
        try:
          out, err = fetch(retry_url)
          if err:
            return err
          return Response(out[0], mimetype=out[1])
        except Exception as exc2:
          return Response(f"proxy error: {exc2}", status=502, mimetype="text/plain")
      return Response(f"proxy error: {exc}", status=502, mimetype="text/plain")

  @app.post("/api/media/upload")
  def upload_media():
    f = request.files.get("file")
    if not f:
      return Response("missing file", status=400, mimetype="text/plain")
    ct = (f.content_type or "").lower()
    name = (f.filename or "image").strip()
    safe = "".join(ch for ch in name if ch.isalnum() or ch in ("-", "_", ".", " ")).strip().replace(" ", "_")
    if not safe or safe.startswith("."):
      safe = "image"
    ext = safe.rsplit(".", 1)[1].lower() if "." in safe else ""
    is_image = ct.startswith("image/")
    is_video = ct.startswith("video/")
    is_html = ct in {"text/html", "application/xhtml+xml"}
    if not (is_image or is_video or is_html):
      if ext in {"png", "jpg", "jpeg", "gif", "webp"}:
        is_image = True
      elif ext in {"mp4", "webm", "mov", "m4v", "ogv"}:
        is_video = True
      elif ext in {"html", "htm"}:
        is_html = True
    if not (is_image or is_video or is_html):
      return Response("Only image/*, video/*, or html is allowed", status=400, mimetype="text/plain")
    if "." not in safe:
      if is_html:
        ext = "html"
      else:
        ext = ct.split("/", 1)[1].split(";", 1)[0].strip()
        if ext == "jpeg":
          ext = "jpg"
        if ext == "quicktime":
          ext = "mov"
      safe = f"{safe}.{ext or 'bin'}"
    base = safe.rsplit(".", 1)[0]
    ext = safe.rsplit(".", 1)[1]
    media_dir = presentation_dir / "media"
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
    return Response(
      json.dumps({"ok": True, "src": f"/media/{out.name}", "filename": out.name, "contentType": ct}),
      mimetype="application/json",
    )

  @app.get("/<path:p>")
  def media_alias(p: str):
    media_dir = presentation_dir / "media"
    target = (media_dir / p).resolve()
    if not str(target).startswith(str(media_dir.resolve())) or not target.exists():
      return ("", 404)
    return send_from_directory(media_dir, p)
