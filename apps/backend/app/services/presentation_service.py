from __future__ import annotations

from typing import Any

from fastapi import Request

from ..config import public_base_url
from ..content_loader import load_presentation


def get_presentation_payload(request: Request) -> dict[str, Any]:
    pres = load_presentation()
    payload: dict[str, Any] = pres.payload

    # Make relative QR urls absolute based on a public base URL so scanning from a phone works.
    base = public_base_url(str(request.base_url))
    for n in payload.get("nodes", []) or []:
        if not isinstance(n, dict):
            continue
        if n.get("type") == "qr":
            url = n.get("url", "")
            if isinstance(url, str) and url.startswith("/"):
                n["url"] = base + url

    return payload

