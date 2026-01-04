from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import ASSETS_DIR, DEV_CORS_ORIGINS
from .routers.choices import router as choices_router
from .routers.composite import router as composite_router
from .routers.health import router as health_router
from .routers.join_and_save import router as join_and_save_router
from .routers.media import router as media_router
from .routers.phone import router as phone_router
from .routers.presentation import router as presentation_router
from .routers.spa import router as spa_router
from .routers.timer import router as timer_router
from .routers.timer_composite_legacy import router as timer_composite_legacy_router

app = FastAPI(title="interactive-presentation-backend")

app.add_middleware(
    CORSMiddleware,
    # When serving the built frontend from this backend, this is same-origin and CORS doesn't matter.
    # Keep dev origins allowed for debugging.
    allow_origins=DEV_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(media_router)
app.include_router(composite_router)
app.include_router(presentation_router)
app.include_router(phone_router)
app.include_router(timer_router)
app.include_router(timer_composite_legacy_router)
app.include_router(choices_router)
app.include_router(join_and_save_router)

if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

# Keep SPA fallback last.
app.include_router(spa_router)


