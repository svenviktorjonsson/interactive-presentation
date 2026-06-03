from __future__ import annotations

import re
from typing import Any


_TOKEN_RE = re.compile(r"\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}")


def _format_value(value: Any, fmt: str | None) -> str:
  if value is None:
    return "-"
  try:
    return format(value, fmt) if fmt else str(value)
  except Exception:
    return "-"


def format_template(template: str, data: dict[str, Any] | None) -> str:
  payload = data or {}

  def repl(match: re.Match[str]) -> str:
    key = match.group(1)
    fmt = match.group(2) or ""
    if key not in payload or payload[key] is None:
      return "-"
    return _format_value(payload.get(key), fmt)

  try:
    return _TOKEN_RE.sub(repl, str(template))
  except Exception:
    return str(template)
