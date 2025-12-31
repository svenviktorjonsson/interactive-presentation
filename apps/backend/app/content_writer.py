from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Any


def _safe_str(s: str) -> str:
    # Keep the DSL parser simple for now: avoid embedded quotes.
    return s.replace('"', "'")


def _fmt_param_value(v: Any) -> str:
    """
    Format a DSL parameter value.
    - numbers/bools are emitted raw
    - simple tokens are emitted raw
    - everything else is quoted
    """
    if v is None:
        return '""'
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        # Keep it compact
        try:
            fv = float(v)
            if abs(fv - round(fv)) < 1e-12:
                return str(int(round(fv)))
            return f"{fv:g}"
        except Exception:
            return _safe_str(str(v))
    s = str(v)
    if re.match(r"^[a-zA-Z0-9_.\-]+$", s):
        return _safe_str(s)
    return f'"{_safe_str(s)}"'


def write_geometries_csv(path: Path, model: dict[str, Any]) -> None:
    """
    geometries.csv v1 (view-relative):
    id,view,x,y,w,h,rotationDeg,anchor,align
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align", "fontH", "parent"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        nodes = model.get("nodes", []) or []
        views = model.get("views", []) or []
        defaults = model.get("defaults") or {}

        node_to_view: dict[str, str] = {}
        view_center: dict[str, tuple[float, float]] = {}
        for v in views:
            vid = str(v.get("id", "home"))
            cam = v.get("camera") or {}
            view_center[vid] = (float(cam.get("cx", 0.0) or 0.0), float(cam.get("cy", 0.0) or 0.0))
            for nid in v.get("show", []) or []:
                if nid not in node_to_view:
                    node_to_view[nid] = vid

        for n in nodes:
            t = n.get("transform") or {}
            design_h = float(defaults.get("designHeight", 1080.0) or 1080.0)
            view_id = node_to_view.get(str(n.get("id", "")), "home")
            cx, cy = view_center.get(view_id, (0.0, 0.0))
            parent_id = str(n.get("parentId") or "").strip()
            if parent_id:
                # Parent-relative normalized by parent.h; store as-is.
                xn = float(t.get("x", 0.0) or 0.0)
                yn = float(t.get("y", 0.0) or 0.0)
                wn = float(t.get("w", 0.1) or 0.1)
                hn = float(t.get("h", 0.05) or 0.05)
            else:
                # Root node: convert world pixels -> view-relative normalized coords.
                # We use the "design viewport" height as 1.0 unit.
                xn = (float(t.get("x", 0.0) or 0.0) - cx) / design_h
                yn = (float(t.get("y", 0.0) or 0.0) - cy) / design_h
                wn = float(t.get("w", 100.0) or 100.0) / design_h
                hn = float(t.get("h", 50.0) or 50.0) / design_h
            font_px = n.get("fontPx", None)
            font_h = ""
            try:
                if font_px is not None:
                    font_h = float(font_px) / design_h
            except Exception:
                font_h = ""
            w.writerow(
                {
                    "id": n.get("id", ""),
                    "view": view_id,
                    "x": xn,
                    "y": yn,
                    "w": wn,
                    "h": hn,
                    "rotationDeg": t.get("rotationDeg", ""),
                    "anchor": t.get("anchor", "topLeft"),
                    "align": n.get("align", ""),
                    "fontH": font_h,
                    "parent": parent_id,
                }
            )


def write_animations_csv(path: Path, nodes: list[dict[str, Any]]) -> None:
    """
    animations.csv v0:
    id,when,how,from,durationMs,delayMs
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["id", "when", "how", "from", "durationMs", "delayMs"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()

        def emit(node_id: str, phase: str, a: dict[str, Any] | None):
            if not a or not isinstance(a, dict):
                return
            anim_type = str(a.get("kind") or "none")
            if anim_type == "none":
                return

            from_val = a.get("from", "")
            border_frac = a.get("borderFrac", "")
            # Compact encoding to avoid a separate column:
            # fade supports `from="<dir>:<borderFrac>"` (e.g. "left:0.2")
            if anim_type == "fade" and from_val and border_frac != "" and border_frac is not None:
                try:
                    bf = float(border_frac)
                    # Default borderFrac is 0.2; omit it to keep the CSV compact.
                    if abs(bf - 0.2) > 1e-9:
                        from_val = f"{from_val}:{bf:g}"
                except Exception:
                    pass
            w.writerow(
                {
                    "id": node_id,
                    "when": phase,
                    "how": anim_type,
                    "from": from_val,
                    "durationMs": a.get("durationMs", ""),
                    "delayMs": a.get("delayMs", ""),
                }
            )

        for n in nodes:
            node_id = str(n.get("id", ""))
            emit(node_id, "enter", n.get("appear"))
            emit(node_id, "exit", n.get("disappear"))


def write_presentation_txt(path: Path, model: dict[str, Any]) -> None:
    """
    Canonical serializer for presentation.txt v1.
    Writes only what is needed to reconstruct content+views; geometry and animations live in CSV files.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    nodes_by_id: dict[str, dict[str, Any]] = {n["id"]: n for n in model.get("nodes", []) if "id" in n}
    views: list[dict[str, Any]] = model.get("views", []) or [{"id": "home", "camera": {"cx": 0, "cy": 0, "zoom": 1}, "show": list(nodes_by_id.keys())}]

    lines: list[str] = []
    lines.append("# presentation.txt v1 (canonical)")
    lines.append("")

    for v in views:
        vid = v.get("id", "home")
        view_params = [f"name={vid}"]

        cam_spec = v.get("cameraSpec")
        if isinstance(cam_spec, dict) and cam_spec:
            # Only the new syntax is allowed.
            ref_view = str(cam_spec.get("refView") or "").strip()
            loc = str(cam_spec.get("loc") or "").strip()
            if ref_view:
                view_params.append(f"refView={_safe_str(ref_view)}")
            if loc:
                view_params.append(f"loc={_safe_str(loc)}")
            dur = str(cam_spec.get("durationMs") or "").strip()
            if dur:
                view_params.append(f"durationMs={_safe_str(dur)}")

        lines.append(f"view[{','.join(view_params)}]:")

        show = v.get("show", [])
        for node_id in show:
            n = nodes_by_id.get(node_id)
            if not n:
                continue
            t = n.get("type")

            if t == "text":
                lines.append(f"text[name={node_id}]:")
                content = (n.get("text") or "").rstrip("\n")
                if content:
                    for ln in content.splitlines():
                        lines.append(_safe_str(ln))
                lines.append("")  # spacer
                continue

            if t == "qr":
                url = (n.get("url") or "/join").strip() or "/join"
                params = [f"name={node_id}"]
                # Do NOT persist the public tunnel URL into presentation.txt.
                # Treat /join as the default (QR is a special join node).
                if url != "/join":
                    params.append(f'url="{_safe_str(str(url))}"')
                lines.append(f"qr[{','.join(params)}]")
                continue

            if t == "htmlFrame":
                src = n.get("src")
                params = [f"name={node_id}"]
                if src:
                    params.append(f'src="{_safe_str(str(src))}"')
                lines.append(f"iframe[{','.join(params)}]")
                continue

            if t == "image":
                # Media-by-name: prefer the implicit /media/<name>.png convention
                src = n.get("src")
                params = [f"name={node_id}"]
                if src and str(src) != f"/media/{node_id}.png":
                    params.append(f'file="{_safe_str(str(src))}"')
                lines.append(f"image[{','.join(params)}]")
                continue

            if t == "bullets":
                lines.append(f"bullets[name={node_id}]:")
                for item in n.get("items", []) or []:
                    lines.append(_safe_str(str(item)))
                lines.append("")
                continue

            if t == "table":
                delim = n.get("delimiter") or ";"
                lines.append(f"table[name={node_id},delim=\"{_safe_str(str(delim))}\"]:")
                for row in n.get("rows", []) or []:
                    lines.append(_safe_str(delim.join([str(c) for c in row])))
                lines.append("")
                continue

            if t == "group":
                lines.append(f"group[name={node_id}]")
                continue

            if t == "timer":
                # Timer composite node. Persist its args so it can regenerate its composite folder.
                params = [f"name={node_id}"]
                # Prefer explicit args map (parsed from timer[...] in presentation.txt)
                args = n.get("args") if isinstance(n.get("args"), dict) else {}
                # Add canonical fields if present but missing from args.
                # (Backend loader stores min/max/binSize as minS/maxS/binSizeS in seconds.)
                if "showTime" not in args and "showTime" in n:
                    args["showTime"] = 1 if bool(n.get("showTime")) else 0
                if "barColor" not in args and n.get("barColor"):
                    args["barColor"] = n.get("barColor")
                if "lineColor" not in args and n.get("lineColor"):
                    args["lineColor"] = n.get("lineColor")
                if "stat" not in args and n.get("stat"):
                    args["stat"] = n.get("stat")
                if "min" not in args and isinstance(n.get("minS"), (int, float)):
                    args["min"] = n.get("minS")
                if "max" not in args and isinstance(n.get("maxS"), (int, float)):
                    args["max"] = n.get("maxS")
                if "binSize" not in args and isinstance(n.get("binSizeS"), (int, float)):
                    args["binSize"] = n.get("binSizeS")

                # Emit args (stable order, skip name)
                for k in sorted([k for k in args.keys() if k != "name"]):
                    params.append(f"{_safe_str(str(k))}={_fmt_param_value(args.get(k))}")
                lines.append(f"timer[{','.join(params)}]")
                continue

            # If we reach here, we have a node type we don't know how to serialize yet.
            # Fail loudly instead of silently dropping nodes from presentation.txt.
            raise ValueError(f"write_presentation_txt: unsupported node type {t!r} (id={node_id!r})")

        lines.append("")  # spacer between views

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


