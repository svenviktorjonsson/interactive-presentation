from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, Response

from ..config import WEB_DIST

router = APIRouter()


@router.get("/{full_path:path}")
def spa_fallback(full_path: str):
    # If we have a built frontend, serve index.html for any non-API path (SPA fallback).
    # Otherwise, return a helpful message.
    if full_path.startswith("api/"):
        return Response(status_code=404)

    if full_path.startswith("join"):
        return Response(status_code=404)

    index = WEB_DIST / "index.html"
    if index.exists():
        return FileResponse(index)

    return Response(
        content="Frontend not built. Run `npm -w apps/web run build` (or `poetry run python run_presentation.py`).",
        media_type="text/plain",
        status_code=503,
    )

