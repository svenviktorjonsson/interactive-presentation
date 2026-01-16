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

    # Helpful diagnostics (returned to the browser so it's obvious *what path* the backend is using).
    try:
        dist_exists = WEB_DIST.exists()
        assets_exists = (WEB_DIST / "assets").exists()
        index_stat = "missing"
        if index.exists():
            index_stat = "exists"
    except Exception as e:
        dist_exists = False
        assets_exists = False
        index_stat = f"error: {type(e).__name__}"

    return Response(
        content=(
            "Frontend not built. Run `npm run build:web` "
            "(or `npm --prefix app/web run build`, or `poetry run python scripts/run_presentation.py`)."
            "\n\n"
            f"WEB_DIST: {WEB_DIST}\n"
            f"WEB_DIST exists: {dist_exists}\n"
            f"WEB_DIST/assets exists: {assets_exists}\n"
            f"WEB_DIST/index.html: {index_stat}\n"
        ),
        media_type="text/plain",
        status_code=503,
    )

