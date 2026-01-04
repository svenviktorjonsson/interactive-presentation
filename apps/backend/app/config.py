from __future__ import annotations

import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_DIST = REPO_ROOT / "apps" / "web" / "dist"
ASSETS_DIR = WEB_DIST / "assets"

PRESENTATION_DIR = REPO_ROOT / "presentations" / "default"
MEDIA_DIR = PRESENTATION_DIR / "media"


def public_base_url(fallback: str) -> str:
    """
    Public base URL for QR links (phones scanning QR codes).
    Prefer PUBLIC_BASE_URL env var, otherwise fall back to request.base_url.
    """
    return (os.environ.get("PUBLIC_BASE_URL") or fallback).rstrip("/")


DEV_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

