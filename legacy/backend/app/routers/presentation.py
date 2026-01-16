from __future__ import annotations

from fastapi import APIRouter, Request

from ..services.presentation_service import get_presentation_payload

router = APIRouter()


@router.get("/api/presentation")
def get_presentation(request: Request):
    return get_presentation_payload(request)

