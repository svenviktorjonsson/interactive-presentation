from __future__ import annotations

import csv
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Presentation:
    payload: dict[str, Any]


def _repo_root() -> Path:
    # apps/backend/app/content_loader.py -> repo root
    return Path(__file__).resolve().parents[3]


def _load_defaults(pres_dir: Path) -> dict[str, Any]:
    defaults_path = pres_dir / "defaults.json"
    if not defaults_path.exists():
        return {"designWidth": 1920, "designHeight": 1080, "viewTransitionMs": 4000, "pixelateSteps": 20}
    try:
        obj = json.loads(defaults_path.read_text(encoding="utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("defaults.json must be an object")
        return {
            "designWidth": float(obj.get("designWidth", 1920)),
            "designHeight": float(obj.get("designHeight", 1080)),
            "viewTransitionMs": int(obj.get("viewTransitionMs", 4000)),
            "pixelateSteps": int(obj.get("pixelateSteps", 20)),
        }
    except Exception:
        # Fall back silently; keep the server resilient.
        return {"designWidth": 1920, "designHeight": 1080, "viewTransitionMs": 4000, "pixelateSteps": 20}


def _ensure_timer_composite_defaults(pres_dir: Path, composite_dir: str) -> None:
    """
    If the user deletes the timer folder, we regenerate a default composite.
    (This is groundwork; runtime expansion/editing comes next.)
    """
    # composite_dir is folder name under presentations/<pres>/groups/ (e.g. "timer1", "timer_fast").
    # Keep it safe.
    if not re.match(r"^[a-zA-Z0-9_][a-zA-Z0-9_\-]{0,63}$", composite_dir):
        raise ValueError(f"Invalid composite folder name: {composite_dir!r}")

    groups_dir = pres_dir / "groups"
    groups_dir.mkdir(parents=True, exist_ok=True)

    # Auto-migrate legacy layout: presentations/<pres>/<name>/ -> presentations/<pres>/groups/<name>/
    legacy_dir = pres_dir / composite_dir
    timer_dir = groups_dir / composite_dir
    if legacy_dir.exists() and not timer_dir.exists():
        try:
            shutil.move(str(legacy_dir), str(timer_dir))
        except Exception:
            # If move fails, fall back to using the new dir and regenerate defaults.
            pass

    timer_dir.mkdir(parents=True, exist_ok=True)

    # Regenerate defaults if folder (or any required file) is missing.
    elements_path = timer_dir / "elements.txt"
    geometries_path = timer_dir / "geometries.csv"
    animations_path = timer_dir / "animations.csv"
    if elements_path.exists() and geometries_path.exists() and animations_path.exists():
        return

    elements_path.write_text(
        "# timer composite elements (draft)\n"
        "# Delete the whole `groups/<name>/` folder to regenerate defaults.\n"
        "# Args passed to timer[...] can be used as {arg} placeholders here.\n"
        "\n"
        "# Default labels (editable in composite mode):\n"
        "text[name=x_label]: Time (s)\n"
        "text[name=y_label]: Procentage (%)\n"
        "\n"
        "# Stats label (auto-updated via {{...}} binding, editable/positionable):\n"
        # Use KaTeX commands (\mu/\sigma) instead of unicode glyphs. Placeholders use {{...}}.
        "text[name=stats]: $\\mu={{mean}}\\,\\mathrm{s}\\quad \\sigma={{sigma}}\\,\\mathrm{s}\\quad \\mathrm{count}={{count}}$\n"
        "\n"
        "# Default arrows (editable in composite mode):\n"
        # Extend axes slightly beyond the data rect (5%) and make them thinner by default.
        # NOTE: The renderer treats these as "data-rect coords" mapped to the plot region.
        # Origin is bottom-left of the data rect.
        "arrow[name=x_axis,from=(0,0),to=(1.05,0),color=white,width=0.006]\n"
        "arrow[name=y_axis,from=(0,0),to=(0,1.05),color=white,width=0.006]\n",
        encoding="utf-8",
    )
    geometries_path.write_text(
        "id,view,x,y,w,h,rotationDeg,anchor,align\n"
        # Labels are allowed outside 0..1 (composite supports it). Keep them small.
        "x_label,timer,0.50,1.06,0.50,0.08,0,topCenter,center\n"
        # Match the current timer1 layout used in the presentation.
        "y_label,timer,-0.15627517456611062,0.05482153612994739,0.40,0.08,-90,centerRight,center\n"
        "stats,timer,0.5028738858079436,0.055646919385237144,0.70,0.08,0,topCenter,center\n"
        "x_axis,timer,0,0,1,1,0,topLeft,\n"
        "y_axis,timer,0,0,1,1,0,topLeft,\n",
        encoding="utf-8",
    )
    animations_path.write_text(
        "id,when,how,from,durationMs,delayMs\n",
        encoding="utf-8",
    )


def _ensure_choices_composite_defaults(pres_dir: Path, composite_dir: str) -> None:
    """
    Create a default composite folder for choices nodes.
    This lets the presenter edit internal layout (buttons/bullets/wheel) without opening the modal.
    """
    if not re.match(r"^[a-zA-Z0-9_][a-zA-Z0-9_\-]{0,63}$", composite_dir):
        raise ValueError(f"Invalid composite folder name: {composite_dir!r}")

    groups_dir = pres_dir / "groups"
    groups_dir.mkdir(parents=True, exist_ok=True)
    comp_dir = groups_dir / composite_dir
    comp_dir.mkdir(parents=True, exist_ok=True)

    elements_path = comp_dir / "elements.txt"
    geometries_path = comp_dir / "geometries.csv"
    # Keep a minimal elements.txt for future expansion (wheel labels/arrows etc).
    if not elements_path.exists():
        elements_path.write_text(
            "# choices composite elements (draft)\n"
            "# This composite controls the internal layout of the choices node.\n"
            "# Sub-ids used by the frontend: buttons, bullets, wheel\n",
            encoding="utf-8",
        )

    # Folder nesting governs hierarchy:
    # groups/<pollId>/geometries.csv defines top-level child groups.
    # groups/<pollId>/bullets/geometries.csv defines bullets+buttons layout within that group.
    # groups/<pollId>/wheel/geometries.csv defines wheel layout within that group.
    bullets_dir = comp_dir / "bullets"
    wheel_dir = comp_dir / "wheel"
    bullets_dir.mkdir(parents=True, exist_ok=True)
    wheel_dir.mkdir(parents=True, exist_ok=True)

    if not geometries_path.exists():
        geometries_path.write_text(
            "id,view,x,y,w,h,rotationDeg,anchor,align,parent\n"
            # Two top-level groups side-by-side by default.
            "bullets,composite,0.00,0.00,0.46,1.00,0,topLeft,left,\n"
            "wheel,composite,0.52,0.00,0.48,1.00,0,topLeft,center,\n",
            encoding="utf-8",
        )
    if not (bullets_dir / "geometries.csv").exists():
        (bullets_dir / "geometries.csv").write_text(
            "id,view,x,y,w,h,rotationDeg,anchor,align,parent\n"
            # Allow y < 0 for button bar above bullets group.
            "buttons,composite,0.50,-0.10,1.00,0.18,0,topCenter,center,\n"
            "bullets,composite,0.00,0.00,1.00,1.00,0,topLeft,left,\n",
            encoding="utf-8",
        )
    if not (wheel_dir / "geometries.csv").exists():
        (wheel_dir / "geometries.csv").write_text(
            "id,view,x,y,w,h,rotationDeg,anchor,align,parent\n"
            "pie,composite,0.50,0.50,1.00,1.00,0,centerCenter,center,\n",
            encoding="utf-8",
        )


def _expand_placeholders(template: str, args: dict[str, Any]) -> str:
    """
    Replace {key} with args[key] for simple template expansion.
    Unknown keys are left as-is.
    """
    def repl(m: re.Match[str]) -> str:
        k = m.group(1)
        if k in args and args[k] is not None:
            return str(args[k])
        return m.group(0)

    return re.sub(r"\{([a-zA-Z_]\w*)\}", repl, template)


def _parse_presentation_txt(path: Path, *, design_w: float, design_h: float) -> dict[str, Any]:
    """
    presentation.txt v1 (draft), keyword blocks:

    view[name=<id>]:
    text[name=<nodeId>]:
      <multiline content>
    qr[name=<nodeId>,caption="..."]
    image[name=<nodeId>]
    iframe[name=<nodeId>,src="https://..."]
    bullets[name=<nodeId>]:
      item 1
      item 2
    table[name=<nodeId>]:
      a;b;c
      1;2;3

    Rules:
    - Lines starting with '#' are comments
    - name= is required for all blocks
    - A block with ':' consumes multiline content until the next header line
    """
    presentation_id = "default"
    views: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    initial_view_id: str | None = None

    if not path.exists():
        return {"id": presentation_id, "initialViewId": "home", "views": views, "nodes": []}

    header_re = re.compile(r"^(?P<kw>[a-zA-Z_]\w*)\[(?P<params>[^\]]+)\]\s*:?(?P<inline>.*)$")

    def parse_params(s: str) -> dict[str, str]:
        # Split on commas, but NOT inside quotes or balanced bracket groups.
        # This is required for e.g. choices={A:red,B:blue,...} which contains commas.
        out: dict[str, str] = {}
        buf = ""
        in_quotes = False
        brace_depth = 0   # {...}
        bracket_depth = 0 # [...]
        paren_depth = 0   # (...)
        parts: list[str] = []
        for ch in s:
            if ch == '"':
                in_quotes = not in_quotes
                buf += ch
                continue
            if not in_quotes:
                if ch == "{":
                    brace_depth += 1
                elif ch == "}":
                    brace_depth = max(0, brace_depth - 1)
                elif ch == "[":
                    bracket_depth += 1
                elif ch == "]":
                    bracket_depth = max(0, bracket_depth - 1)
                elif ch == "(":
                    paren_depth += 1
                elif ch == ")":
                    paren_depth = max(0, paren_depth - 1)

            if ch == "," and not in_quotes and brace_depth == 0 and bracket_depth == 0 and paren_depth == 0:
                parts.append(buf.strip())
                buf = ""
                continue
            buf += ch
        if buf.strip():
            parts.append(buf.strip())

        for part in parts:
            if "=" not in part:
                continue
            k, v = part.split("=", 1)
            k = k.strip()
            v = v.strip()
            if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
                v = v[1:-1]
            out[k] = v
        return out

    def parse_choice_options(raw: str | None) -> list[dict[str, str]]:
        if not raw:
            return []
        s = raw.strip()
        # Strip surrounding braces/brackets generously (handles {{...}}, {...}, [...])
        while s and s[0] in "{[" and s[-1] in "}]":
            s = s[1:-1].strip()

        # Split on commas not inside quotes.
        parts: list[str] = []
        buf = ""
        in_quotes = False
        for ch in s:
            if ch == '"':
                in_quotes = not in_quotes
                buf += ch
                continue
            if ch == "," and not in_quotes:
                parts.append(buf.strip())
                buf = ""
                continue
            buf += ch
        if buf.strip():
            parts.append(buf.strip())

        palette = ["#4caf50", "#e53935", "#1e88e5", "#ab47bc", "#00bcd4", "#fdd835", "#8d6e63"]
        opts: list[dict[str, str]] = []
        seen_ids: set[str] = set()

        def slug(label: str) -> str:
            s1 = re.sub(r"\s+", "_", label.strip())
            s1 = re.sub(r"[^a-zA-Z0-9_]", "", s1)
            return s1 or "option"

        for idx, part in enumerate(parts):
            if not part:
                continue
            if ":" in part:
                lab_raw, col_raw = part.split(":", 1)
            else:
                lab_raw, col_raw = part, ""
            label = lab_raw.strip()
            color = col_raw.strip() or palette[idx % len(palette)]
            if not label:
                continue
            opt_id = slug(label)
            # Ensure stable uniqueness even if labels repeat.
            base = opt_id
            n = 2
            while opt_id in seen_ids:
                opt_id = f"{base}{n}"
                n += 1
            seen_ids.add(opt_id)
            opts.append({"id": opt_id, "label": label, "color": color})
        return opts

    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    current_view: dict[str, Any] | None = None
    screen_mode = False
    screen_nodes: set[str] = set()
    screen_counter = 0

    def _apply_style_params(node: dict[str, Any], params: dict[str, str]) -> None:
        bg = (params.get("bgColor") or params.get("bg") or "").strip()
        if bg:
            node["bgColor"] = bg
        ba_raw = (params.get("bgAlpha") or "").strip()
        if ba_raw:
            try:
                node["bgAlpha"] = float(ba_raw)
            except ValueError:
                pass
        br_raw = (params.get("borderRadius") or params.get("rounded") or "").strip()
        if br_raw:
            try:
                node["borderRadius"] = float(br_raw)
            except ValueError:
                pass

    def _half_extents(cam: dict[str, float]) -> tuple[float, float]:
        z = float(cam.get("zoom", 1.0) or 1.0)
        return (design_w / 2.0) / z, (design_h / 2.0) / z

    view_cameras_by_id: dict[str, dict[str, float]] = {}
    prev_cam: dict[str, float] = {"cx": 0.0, "cy": 0.0, "zoom": 1.0}

    def _try_float(s: str | None) -> float | None:
        if not s:
            return None
        try:
            return float(s.strip())
        except ValueError:
            return None

    def _resolve_zoom_token(base: dict[str, float], token: str) -> dict[str, float] | None:
        tok = token.strip()
        if not tok:
            return None
        # in2LowerLeft, out2, inBottomRight, out
        m = re.match(r"^(in|out)(?P<n>\d+)?(?P<corner>[A-Za-z]+)?$", tok, flags=re.IGNORECASE)
        if not m:
            return None
        kind = (m.group(1) or "").lower()
        n = int(m.group("n") or "1")
        corner_raw = (m.group("corner") or "").strip()

        factor = 10**n
        z1 = float(base.get("zoom", 1.0) or 1.0) * (factor if kind == "in" else 1.0 / factor)
        cam1 = {"cx": float(base.get("cx", 0.0) or 0.0), "cy": float(base.get("cy", 0.0) or 0.0), "zoom": z1}

        if not corner_raw:
            return cam1

        # Normalize corner names.
        corner = corner_raw
        corner = corner.replace("Lower", "Bottom").replace("Upper", "Top")
        corner = corner[0].upper() + corner[1:]
        # Accept e.g. Bottomright
        corner = corner.replace("bottom", "Bottom").replace("top", "Top").replace("left", "Left").replace("right", "Right")

        hw0, hh0 = _half_extents(base)
        hw1, hh1 = _half_extents(cam1)
        dx = hw0 - hw1
        dy = hh0 - hh1

        if corner.endswith("Right"):
            cam1["cx"] += dx
        if corner.endswith("Left"):
            cam1["cx"] -= dx
        if corner.startswith("Bottom"):
            cam1["cy"] += dy
        if corner.startswith("Top"):
            cam1["cy"] -= dy
        return cam1

    def _resolve_view_camera(params: dict[str, str], base: dict[str, float]) -> tuple[dict[str, float], dict[str, str] | None]:
        """
        Preferred v2 syntax:
          view[name=...,refView=home,loc=right]

        - zoom is inherited from refView (fixed)
        - loc can be: right/left/up/down/topRight/topLeft/bottomRight/bottomLeft (also center/origin)

        Back-compat:
          view[name=...,cx=...,cy=...,zoom=...]
          view[name=...,ref=...,cx=right,...]
        """
        raw_ref_view = (params.get("refView") or "").strip()
        raw_loc = (params.get("loc") or "").strip()

        raw_cx = (params.get("cx") or "").strip()
        raw_cy = (params.get("cy") or "").strip()
        raw_zoom = (params.get("zoom") or "").strip()
        raw_ref = (params.get("ref") or "").strip()

        if raw_cx or raw_cy or raw_zoom or raw_ref:
            raise ValueError(
                "Legacy view camera params are no longer supported. "
                "Use view[name=...,refView=<id>,loc=<right|left|up|down|topRight|topLeft|bottomRight|bottomLeft>] "
                "and omit zoom/cx/cy/ref."
            )

        cam = {
            "cx": float(base.get("cx", 0.0) or 0.0),
            "cy": float(base.get("cy", 0.0) or 0.0),
            "zoom": float(base.get("zoom", 1.0) or 1.0),
        }
        spec: dict[str, str] = {}

        # Prefer new syntax when present.
        if raw_ref_view:
            spec["refView"] = raw_ref_view
        if raw_loc:
            spec["loc"] = raw_loc
        dur_raw = (params.get("durationMs") or params.get("duration") or "").strip()
        if dur_raw:
            spec["durationMs"] = dur_raw

        # New syntax: only position changes, zoom is fixed (inherited).
        if raw_loc:
            hw0, hh0 = _half_extents(cam)
            loc = raw_loc.strip()
            loc_norm = loc.replace("_", "").replace("-", "").lower()
            if loc_norm in {"center", "origin"}:
                return cam, (spec if spec else None)
            dx = 0.0
            dy = 0.0
            if "right" in loc_norm:
                dx += 2.0 * hw0
            if "left" in loc_norm:
                dx -= 2.0 * hw0
            if "bottom" in loc_norm or "down" in loc_norm:
                dy += 2.0 * hh0
            if "top" in loc_norm or "up" in loc_norm:
                dy -= 2.0 * hh0
            cam["cx"] += dx
            cam["cy"] += dy
            return cam, (spec if spec else None)

        raise ValueError(
            "Views after the first must specify refView=<id> and loc=<...>. "
            "Example: view[name=view2,refView=home,loc=right]:"
        )

    while i < len(lines):
        raw = lines[i]
        i += 1
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue

        m = header_re.match(stripped)
        if not m:
            raise ValueError(f"Invalid line (expected keyword[...]): {raw}")

        kw = m.group("kw")
        params = parse_params(m.group("params"))
        name = params.get("name")
        if not name:
            raise ValueError(f"Missing required name= in: {raw}")

        inline_after = (m.group("inline") or "").strip()
        has_colon = stripped.endswith(":") and not inline_after

        if kw == "screen":
            # Start a new screen segment; treated like a view but for screen-space nodes.
            screen_mode = True
            screen_counter += 1
            current_view = {"id": name or f"screen_{screen_counter}", "screen": True, "show": []}
            views.append(current_view)
            continue

        if kw == "view":
            screen_mode = False
            # Allow reusing an existing view name to jump back without redefining camera.
            existing = next((v for v in views if v.get("id") == name), None)
            if existing:
                current_view = existing
                prev_cam = view_cameras_by_id.get(name, prev_cam)
                continue

            if initial_view_id is None:
                # First view is the base view: no camera params allowed.
                extra = {k: v for k, v in params.items() if k != "name" and str(v).strip()}
                if extra:
                    raise ValueError(f"First view must not specify camera params. Remove: {sorted(extra.keys())}")
                cam = {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
                cam_spec = None
            else:
                ref_view = (params.get("refView") or "").strip()
                if not ref_view:
                    raise ValueError("Views after the first must include refView=<id>.")
                base = view_cameras_by_id.get(ref_view)
                if not base:
                    raise ValueError(f"Unknown refView={ref_view!r}. Known: {sorted(view_cameras_by_id.keys())}")
                cam, cam_spec = _resolve_view_camera(params, base)
            current_view = {"id": name, "camera": cam, "show": []}
            if cam_spec:
                current_view["cameraSpec"] = cam_spec
                # Optional per-view transition duration override
                dur_raw = str(cam_spec.get("durationMs") or "").strip()
                try:
                    if dur_raw:
                        current_view["transitionMs"] = int(float(dur_raw))
                except ValueError:
                    pass
            views.append(current_view)
            if initial_view_id is None:
                initial_view_id = name
            view_cameras_by_id[name] = cam
            prev_cam = cam
            continue

        if current_view is None and not screen_mode:
            raise ValueError(f"Block outside of any view: {raw}")

        if kw == "text":
            content_lines: list[str] = []
            inline = (m.group("inline") or "").strip()
            if inline:
                content_lines.append(inline)
            if has_colon:
                # Read until next header
                while i < len(lines):
                    peek = lines[i].strip()
                    if not peek or peek.startswith("#"):
                        content_lines.append(lines[i].rstrip("\n"))
                        i += 1
                        continue
                    if header_re.match(peek):
                        break
                    content_lines.append(lines[i].rstrip("\n"))
                    i += 1

            text = "\n".join([ln for ln in content_lines]).strip("\n")
            # View elements are world/data coordinates by default.
            nodes_by_id[name] = {"id": name, "type": "text", "space": "screen" if screen_mode else "world", "text": text}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        if kw == "qr":
            # View elements are world/data coordinates by default.
            # Captions are done via separate `text[...]` nodes (gives KaTeX/scaling for free).
            node = {"id": name, "type": "qr", "space": "world", "url": params.get("url", "/join")}
            nodes_by_id[name] = node
            current_view["show"].append(name)
            continue

        if kw == "image":
            # Media by name: default to /media/<name>.png
            src = params.get("src") or params.get("file") or f"/media/{name}.png"
            space = (params.get("space") or "world").strip() or "world"
            nodes_by_id[name] = {"id": name, "type": "image", "space": space if not screen_mode else "screen", "src": src}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        if kw == "iframe":
            src = params.get("src")
            if not src:
                raise ValueError(f"iframe requires src= in: {raw}")
            nodes_by_id[name] = {"id": name, "type": "htmlFrame", "space": "screen" if screen_mode else "world", "src": src}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        if kw == "timer":
            # Interactive timer / histogram node (rendered by the frontend; data via backend APIs).
            # Ensure the composite defaults exist only if a timer is actually used in the presentation.
            try:
                _ensure_timer_composite_defaults(path.parent, name)
            except Exception:
                pass
            show_time = (params.get("showTime") or "0").strip()
            bar_color = (params.get("barColor") or "orange").strip()
            line_color = (params.get("lineColor") or "green").strip()
            line_w_raw = (params.get("lineWidth") or "").strip()
            stat = (params.get("stat") or "gaussian").strip()
            min_s_raw = (params.get("min") or "").strip()
            max_s_raw = (params.get("max") or "").strip()
            bin_s_raw = (params.get("binSize") or "").strip()

            def fnum(v: str, default: float | None) -> float | None:
                if not v:
                    return default
                try:
                    return float(v)
                except ValueError:
                    return default

            min_s = fnum(min_s_raw, None)
            max_s = fnum(max_s_raw, None)
            bin_s = fnum(bin_s_raw, None)
            line_w = fnum(line_w_raw, None)
            if min_s is not None and max_s is not None and bin_s is not None and bin_s > 0:
                span = max_s - min_s
                # Must be compatible (divides evenly) within a small tolerance.
                bins = span / bin_s if span > 0 else 0
                if bins <= 0 or abs(bins - round(bins)) > 1e-6:
                    raise ValueError(f"timer[{name}] has incompatible min/max/binSize (span={span}, bin={bin_s})")

            nodes_by_id[name] = {
                "id": name,
                "type": "timer",
                "space": "world",
                "showTime": show_time == "1" or show_time.lower() in {"true", "yes", "on"},
                "barColor": bar_color,
                "lineColor": line_color,
                "lineWidth": line_w,
                "stat": stat,
                "minS": min_s,
                "maxS": max_s,
                "binSizeS": bin_s,
                "compositeDir": name,
                # Preserve raw args for templating
                "args": {k: v for k, v in params.items() if k != "name"},
            }

            # Expand composite template text (for the next "composite expansion" step).
            try:
                pres_dir = path.parent
                timer_dir = pres_dir / "groups" / str(nodes_by_id[name].get("compositeDir") or name)
                tpl_path = timer_dir / "elements.txt"
                if tpl_path.exists():
                    tpl = tpl_path.read_text(encoding="utf-8")
                    # Provide both raw params and normalized fields.
                    args_for_tpl: dict[str, Any] = dict(nodes_by_id[name]["args"])
                    args_for_tpl.update(
                        {
                            "showTime": int(nodes_by_id[name]["showTime"]),
                            "barColor": bar_color,
                            "lineColor": line_color,
                            "lineWidth": line_w,
                            "stat": stat,
                            "min": min_s,
                            "max": max_s,
                            "binSize": bin_s,
                        }
                    )
                    nodes_by_id[name]["elementsText"] = _expand_placeholders(tpl, args_for_tpl)
            except Exception:
                pass

            # Load composite-local geometries for editable sub-elements.
            try:
                pres_dir = path.parent
                g_path = (pres_dir / "groups" / str(nodes_by_id[name].get("compositeDir") or name) / "geometries.csv")
                if g_path.exists():
                    geoms: dict[str, Any] = {}
                    with g_path.open("r", encoding="utf-8", newline="") as f:
                        reader = csv.DictReader(f)
                        for row in reader:
                            sid = (row.get("id") or "").strip()
                            if not sid or sid.startswith("#"):
                                continue
                            try:
                                geoms[sid] = {
                                    "x": float((row.get("x") or "0").strip() or 0),
                                    "y": float((row.get("y") or "0").strip() or 0),
                                    "w": float((row.get("w") or "0.2").strip() or 0.2),
                                    "h": float((row.get("h") or "0.1").strip() or 0.1),
                                    "rotationDeg": float((row.get("rotationDeg") or "0").strip() or 0),
                                    "anchor": (row.get("anchor") or "topLeft").strip() or "topLeft",
                                    "align": (row.get("align") or "").strip(),
                                }
                            except Exception:
                                continue
                    nodes_by_id[name]["compositeGeometries"] = geoms
            except Exception:
                pass

            current_view["show"].append(name)
            continue

        if kw == "choices":
            # Ensure the choices composite defaults exist only if a choices node is actually used.
            try:
                _ensure_choices_composite_defaults(path.parent, name)
            except Exception:
                pass
            content_lines: list[str] = []
            if has_colon:
                while i < len(lines):
                    peek = lines[i].strip()
                    if not peek or peek.startswith("#"):
                        content_lines.append(lines[i].rstrip("\n"))
                        i += 1
                        continue
                    if header_re.match(peek):
                        break
                    content_lines.append(lines[i].rstrip("\n"))
                    i += 1

            question = "\n".join([ln for ln in content_lines]).strip("\n")
            chart_raw = (params.get("type") or params.get("chart") or "pieChart").strip()
            chart = "pie" if "pie" in chart_raw.lower() else "pie"
            bullet_style = (params.get("bullets") or "A").strip() or "A"
            options = parse_choice_options(params.get("choices"))
            nodes_by_id[name] = {
                "id": name,
                "type": "choices",
                "space": "world",
                "question": question,
                "chart": chart,
                "bullets": bullet_style,
                "options": options,
            }
            # Load composite-local geometries for editable sub-elements (folder-nested).
            try:
                pres_dir = path.parent
                base = pres_dir / "groups" / str(name)

                def load_geoms(csv_path: Path) -> dict[str, Any]:
                    if not csv_path.exists():
                        return {}
                    out: dict[str, Any] = {}
                    with csv_path.open("r", encoding="utf-8", newline="") as f:
                        reader = csv.DictReader(f)
                        for row in reader:
                            sid = (row.get("id") or "").strip()
                            if not sid or sid.startswith("#"):
                                continue
                            try:
                                out[sid] = {
                                    "x": float((row.get("x") or "0").strip() or 0),
                                    "y": float((row.get("y") or "0").strip() or 0),
                                    "w": float((row.get("w") or "1").strip() or 1),
                                    "h": float((row.get("h") or "1").strip() or 1),
                                    "rotationDeg": float((row.get("rotationDeg") or "0").strip() or 0),
                                    "anchor": (row.get("anchor") or "topLeft").strip() or "topLeft",
                                    "align": (row.get("align") or "").strip(),
                                    "parent": (row.get("parent") or "").strip(),
                                }
                            except Exception:
                                continue
                    return out

                nodes_by_id[name]["compositeGeometriesByPath"] = {
                    "": load_geoms(base / "geometries.csv"),
                    "bullets": load_geoms(base / "bullets" / "geometries.csv"),
                    "wheel": load_geoms(base / "wheel" / "geometries.csv"),
                }
            except Exception:
                pass
            current_view["show"].append(name)
            continue

        if kw == "bullets":
            items: list[str] = []
            if has_colon:
                while i < len(lines):
                    peek = lines[i].strip()
                    if not peek or peek.startswith("#"):
                        i += 1
                        continue
                    if header_re.match(peek):
                        break
                    raw_item = lines[i].strip()
                    # Strip leading common markers ("- ", "* ", etc.)
                    raw_item = re.sub(r"^[-*+]\s+", "", raw_item)
                    items.append(raw_item)
                    i += 1
            bullet_style = (params.get("type") or params.get("bullets") or "A").strip() or "A"
            # Normalize roman choice to "X" to distinguish from numeric "1".
            if bullet_style == "I":
                bullet_style = "X"
            nodes_by_id[name] = {"id": name, "type": "bullets", "space": "screen" if screen_mode else "world", "items": items, "bullets": bullet_style}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        if kw == "table":
            rows: list[list[str]] = []
            delim = params.get("delim", ";")
            if has_colon:
                while i < len(lines):
                    peek = lines[i].strip()
                    if not peek or peek.startswith("#"):
                        i += 1
                        continue
                    if header_re.match(peek):
                        break
                    rows.append([cell.strip() for cell in lines[i].split(delim)])
                    i += 1
            nodes_by_id[name] = {"id": name, "type": "table", "space": "screen" if screen_mode else "world", "rows": rows, "delimiter": delim}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        if kw == "group":
            # Pure grouping node. Geometry and parent/children are handled by geometries.csv (parentId).
            nodes_by_id[name] = {"id": name, "type": "group", "space": "screen" if screen_mode else "world"}
            _apply_style_params(nodes_by_id[name], params)
            if current_view:
                current_view["show"].append(name)
            else:
                screen_nodes.add(name)
            continue

        raise ValueError(f"Unknown keyword: {kw}")

    if not views:
        # Allow content with no explicit view: make a default view and show everything.
        views = [{"id": "home", "camera": {"cx": 0.0, "cy": 0.0, "zoom": 1.0}, "show": list(nodes_by_id.keys())}]
        initial_view_id = "home"

    return {
        "id": presentation_id,
        "initialViewId": initial_view_id or "home",
        "views": views,
        "nodes": list(nodes_by_id.values()),
    }


def _parse_geometries_csv(
    path: Path,
    *,
    views_by_id: dict[str, dict[str, Any]],
    node_view_hint: dict[str, str],
    design_w: float,
    design_h: float,
) -> dict[str, dict[str, Any]]:
    """
    geometries.csv v2 columns:
    - Root nodes (no parent): view-relative
      id,view,x,y,w,h,rotationDeg,anchor,align,fontH,parent
    - Child nodes (parent set): parent-relative normalized by parent.h
      (x/y/w/h are stored as-is; conversion to world is done client-side via parent transform)

    Semantics:
    - x/y are in "view-height units" relative to the view center:
      y in [-0.5..0.5] for the base view; x in [-aspect/2..aspect/2]
    - w/h are also in view-height units (so h=1 fills the entire view height)
    - `view` selects which view the geometry is relative to
    """
    if not path.exists():
        return {}

    def num(key: str, default: float = 0.0, row: dict[str, str] | None = None) -> float:
        raw = ((row or {}).get(key) or "").strip()
        return float(raw) if raw else default

    out: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            node_id = (row.get("id") or "").strip()
            if not node_id:
                continue

            view_id = (row.get("view") or "").strip() or node_view_hint.get(node_id) or "home"
            parent_id = (row.get("parent") or "").strip()
            view = views_by_id.get(view_id) or views_by_id.get("home") or {"camera": {"cx": 0.0, "cy": 0.0, "zoom": 1.0}}
            cam = view.get("camera") or {"cx": 0.0, "cy": 0.0, "zoom": 1.0}
            vcx = float(cam.get("cx", 0.0) or 0.0)
            vcy = float(cam.get("cy", 0.0) or 0.0)

            xn = num("x", 0.0, row)
            yn = num("y", 0.0, row)
            wn = num("w", 0.2, row)
            hn = num("h", 0.1, row)
            font_h = num("fontH", -1.0, row)
            if parent_id:
                # Parent-relative: store as-is (normalized units).
                xw, yw, ww, hw = xn, yn, wn, hn
            else:
                # Convert view-relative -> world pixels (design pixel world).
                xw = vcx + xn * design_h
                yw = vcy + yn * design_h
                ww = wn * design_h
                hw = hn * design_h

            # Determine space from view: if view is a screen view, this is screen-space
            is_screen_view = view.get("screen", False)
            g: dict[str, Any] = {
                "space": "screen" if is_screen_view else "world",
                "view": view_id,
                "transform": {"x": xw, "y": yw, "w": ww, "h": hw},
            }
            if parent_id:
                g["parentId"] = parent_id
            if font_h >= 0:
                g["fontPx"] = float(font_h) * design_h

            rot = (row.get("rotationDeg") or "").strip()
            if rot:
                g["transform"]["rotationDeg"] = float(rot)

            anchor = (row.get("anchor") or "").strip()
            if anchor:
                g["transform"]["anchor"] = anchor

            align = (row.get("align") or "").strip()
            if align:
                g["align"] = align

            v_align = (row.get("vAlign") or row.get("valign") or "").strip()
            if v_align:
                g["vAlign"] = v_align

            out[node_id] = g

    return out


def _parse_animations_csv(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """
    animations.csv v0 columns:
    id,when,how,from,durationMs,delayMs

    Notes:
    - Rows are omitted when there's no animation ("none")
    - For fade, `from` may include a border fraction like: left:0.2
    """
    if not path.exists():
        return {}, []

    out: dict[str, dict[str, Any]] = {}
    cues: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            node_id = (row.get("id") or "").strip()
            if not node_id:
                continue
            when = (row.get("when") or "").strip().lower()
            how = (row.get("how") or "").strip().lower() or "none"
            if how == "none" or when not in {"enter", "exit"}:
                continue

            # No back-compat: `direct` was renamed to `sudden`.
            if how == "direct":
                raise ValueError(f"{path}: animations.csv uses how=direct which is no longer supported; use how=sudden (id={node_id})")

            allowed = {"sudden", "fade", "pixelate", "appear"}
            if how not in allowed:
                raise ValueError(f"{path}: animations.csv has unsupported how={how!r} (id={node_id}); allowed: {sorted(allowed)}")

            # `how` is the animation type (sudden|fade|pixelate|appear).
            # `kind` is whether it is an enter or exit animation.
            a: dict[str, Any] = {"kind": how}
            dur = (row.get("durationMs") or "").strip()
            delay = (row.get("delayMs") or "").strip()
            if dur:
                a["durationMs"] = int(float(dur))
            if delay:
                a["delayMs"] = int(float(delay))
            from_raw = (row.get("from") or "").strip()
            if from_raw:
                # Allow compact encoding: "<dir>:<borderFrac>" (e.g. "left:0.2")
                if ":" in from_raw:
                    dir_part, border_part = from_raw.split(":", 1)
                    dir_part = dir_part.strip()
                    border_part = border_part.strip()
                    if dir_part:
                        a["from"] = dir_part
                    if border_part:
                        try:
                            a["borderFrac"] = float(border_part)
                        except ValueError:
                            pass
                else:
                    a["from"] = from_raw

            out.setdefault(node_id, {})
            if when == "enter":
                out[node_id]["appear"] = a
            else:
                out[node_id]["disappear"] = a

            # Preserve row order as the live "cue" order.
            cues.append({"id": node_id, "when": when})

    return out, cues


def load_presentation(presentation_dir: Path | None = None) -> Presentation:
    root = _repo_root()
    pres_dir = presentation_dir or (root / "presentations" / "default")
    defaults = _load_defaults(pres_dir)
    pres_path = pres_dir / "presentation.pr"
    if not pres_path.exists():
        pres_path = pres_dir / "presentation.txt"
    meta = _parse_presentation_txt(pres_path, design_w=float(defaults["designWidth"]), design_h=float(defaults["designHeight"]))
    geometries_path = pres_dir / "geometries.csv"
    animations_path = pres_dir / "animations.csv"
    if not geometries_path.exists():
        raise FileNotFoundError(f"Missing geometries.csv at {geometries_path}")
    if not animations_path.exists():
        raise FileNotFoundError(f"Missing animations.csv at {animations_path}")

    DESIGN_W = float(defaults["designWidth"])
    DESIGN_H = float(defaults["designHeight"])
    views_by_id: dict[str, dict[str, Any]] = {v["id"]: v for v in meta.get("views", []) if isinstance(v, dict) and "id" in v}
    node_view_hint: dict[str, str] = {}
    for v in meta.get("views", []) or []:
        for nid in v.get("show", []) or []:
            if nid not in node_view_hint:
                node_view_hint[nid] = v.get("id", "home")

    geometries = _parse_geometries_csv(
        geometries_path, views_by_id=views_by_id, node_view_hint=node_view_hint, design_w=DESIGN_W, design_h=DESIGN_H
    )
    animations, animation_cues = _parse_animations_csv(animations_path)

    nodes: list[dict[str, Any]] = []
    # Ensure screen-space nodes are only in their screen views; do not auto-add to other views.
    for node in meta["nodes"]:
        g = geometries.get(node["id"])
        a = animations.get(node["id"])
        if g:
            node["space"] = g.get("space", node.get("space", "world"))
            node["transform"] = g.get("transform", node.get("transform"))
            if "parentId" in g:
                node["parentId"] = g.get("parentId")
            if "align" in g:
                node["align"] = g.get("align")
            if "vAlign" in g:
                node["vAlign"] = g.get("vAlign")
            if "fontPx" in g:
                node["fontPx"] = g.get("fontPx")
        else:
            # Sensible defaults if geometry is missing
            if node.get("space") == "screen":
                node["transform"] = {"x": 16.0, "y": 16.0, "w": 220.0, "h": 90.0, "anchor": "topLeft"}
            elif node["type"] == "text":
                node["transform"] = {"x": 24.0, "y": 18.0, "w": 900.0, "h": 60.0, "anchor": "topLeft"}
            elif node["type"] == "qr":
                node["transform"] = {"x": 0.0, "y": 0.0, "w": 280.0, "h": 280.0, "anchor": "center"}
            else:
                node["transform"] = {"x": 0.0, "y": 0.0, "w": 100.0, "h": 50.0, "anchor": "topLeft"}

        if a:
            if "appear" in a:
                node["appear"] = a.get("appear")
            if "disappear" in a:
                node["disappear"] = a.get("disappear")
            # Allow overriding type from representation only if meta didn't set it (meta is source of truth)

        if "borderRadius" not in node and "borderRadius" in defaults:
            try:
                node["borderRadius"] = float(defaults.get("borderRadius"))
            except Exception:
                pass

        nodes.append(node)

    # Apply initial view visibility
    initial_view_id = meta["initialViewId"]
    initial_view = next((v for v in meta["views"] if v["id"] == initial_view_id), None)
    show = set(initial_view["show"]) if initial_view else set()
    for n in nodes:
        # Screen-space nodes should behave like an overlay layer: visible regardless of the active world view.
        # They are managed by `screen[...]` sections (screen views), which are not part of the initial world view's `show` list.
        if n.get("space") == "screen":
            n["visible"] = True
        else:
            n["visible"] = n["id"] in show

    payload = {
        "id": meta["id"],
        "nodes": nodes,
        "initialViewId": meta["initialViewId"],
        "views": meta["views"],
        "animationCues": animation_cues,
        "defaults": defaults,
    }
    return Presentation(payload=payload)


