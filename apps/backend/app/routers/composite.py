from __future__ import annotations

from fastapi import APIRouter, Body

from ..services.composite_service import save_composite

router = APIRouter()


@router.post("/api/composite/save")
def composite_save(payload: dict = Body(...)):
    return save_composite(payload)

