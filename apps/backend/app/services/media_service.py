from __future__ import annotations

from fastapi import UploadFile
from fastapi.responses import Response

from ..config import MEDIA_DIR


async def upload_image(file: UploadFile) -> dict | Response:
    """
    Upload an image into presentations/default/media and return its served src.
    """
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    ct = (file.content_type or "").lower()
    if not ct.startswith("image/"):
        return Response(status_code=400, content="Only image/* is allowed", media_type="text/plain")

    # Basic filename sanitization + uniqueness.
    name = (file.filename or "image").strip()
    safe = "".join(ch for ch in name if ch.isalnum() or ch in ("-", "_", ".", " ")).strip().replace(" ", "_")
    if not safe or safe.startswith("."):
        safe = "image"
    if "." not in safe:
        ext = ct.split("/", 1)[1].split(";", 1)[0].strip()
        if ext in {"jpeg"}:
            ext = "jpg"
        safe = f"{safe}.{ext or 'png'}"

    base = safe.rsplit(".", 1)[0]
    ext = safe.rsplit(".", 1)[1]
    out = (MEDIA_DIR / safe).resolve()
    if not str(out).startswith(str(MEDIA_DIR.resolve())):
        return Response(status_code=400, content="Invalid filename", media_type="text/plain")
    i = 2
    while out.exists():
        out = (MEDIA_DIR / f"{base}_{i}.{ext}").resolve()
        i += 1

    data = await file.read()
    if data is None:
        data = b""
    # 25MB limit
    if len(data) > 25 * 1024 * 1024:
        return Response(status_code=413, content="File too large", media_type="text/plain")

    out.write_bytes(data)
    return {"ok": True, "src": f"/media/{out.name}", "filename": out.name, "contentType": ct}

