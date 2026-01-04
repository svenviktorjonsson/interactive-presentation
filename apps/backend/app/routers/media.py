from __future__ import annotations

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse, Response

from ..config import MEDIA_DIR
from ..services.media_service import upload_image

router = APIRouter()


@router.get("/media/{media_path:path}")
def media(media_path: str):
    # Serve presentation media (png images, videos, generated join QR, etc.)
    # Use no-store so overwriting a file (like join_qr.png) takes effect immediately.
    p = (MEDIA_DIR / media_path).resolve()
    if not str(p).startswith(str(MEDIA_DIR.resolve())):
        return Response(status_code=400)
    if not p.exists() or not p.is_file():
        return Response(status_code=404)
    return FileResponse(p, headers={"Cache-Control": "no-store"})


@router.post("/api/media/upload")
async def upload_media(file: UploadFile = File(...)):
    return await upload_image(file)

