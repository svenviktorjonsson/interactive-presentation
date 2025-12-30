from __future__ import annotations

import csv
from pathlib import Path
from typing import Any


def _safe_str(s: str) -> str:
    # Keep the DSL parser simple for now: avoid embedded quotes.
    return s.replace('"', "'")


def write_geometries_csv(path: Path, model: dict[str, Any]) -> None:
    """
    geometries.csv v1 (view-relative):
    id,view,x,y,w,h,rotationDeg,anchor,align
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align"]
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
            # Convert world pixels -> view-relative normalized coords.
            # We use the "design viewport" height as 1.0 unit.
            design_h = float(defaults.get("designHeight", 1080.0) or 1080.0)
            view_id = node_to_view.get(str(n.get("id", "")), "home")
            cx, cy = view_center.get(view_id, (0.0, 0.0))
            xn = (float(t.get("x", 0.0) or 0.0) - cx) / design_h
            yn = (float(t.get("y", 0.0) or 0.0) - cy) / design_h
            wn = float(t.get("w", 100.0) or 100.0) / design_h
            hn = float(t.get("h", 50.0) or 50.0) / design_h
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

        lines.append("")  # spacer between views

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


