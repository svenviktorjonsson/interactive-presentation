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
    # The DSL param splitter only uses commas at top-level inside `[...]`.
    # So we can keep values unquoted even with spaces, colons, slashes, etc.
    # We only MUST quote when the value could break the bracketed param list.
    #
    # Rules:
    # - quote if value contains a comma (param separator)
    # - quote if value contains ']' (would terminate the param list)
    # - quote if value contains newlines (keeps the DSL one-line header safe)
    if "," in s or "]" in s or "\n" in s or "\r" in s:
        return f'"{_safe_str(s)}"'
    return _safe_str(s)


def write_geometries_csv(path: Path, model: dict[str, Any]) -> None:
    """
    geometries.csv v1 (view-relative):
    id,view,x,y,w,h,rotationDeg,anchor,align
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align", "vAlign", "fontH", "parent"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        nodes = model.get("nodes", []) or []
        views = model.get("views", []) or []
        defaults = model.get("defaults") or {}

        node_to_view: dict[str, str] = {}
        view_center: dict[str, tuple[float, float]] = {}
        screen_views: set[str] = set()
        for v in views:
            vid = str(v.get("id", "home"))
            cam = v.get("camera") or {}
            view_center[vid] = (float(cam.get("cx", 0.0) or 0.0), float(cam.get("cy", 0.0) or 0.0))
            if v.get("screen"):
                screen_views.add(vid)
            for nid in v.get("show", []) or []:
                if nid not in node_to_view:
                    node_to_view[nid] = vid

        for n in nodes:
            t = n.get("transform") or {}
            design_h = float(defaults.get("designHeight", 1080.0) or 1080.0)
            node_id = str(n.get("id", ""))
            view_id = node_to_view.get(node_id, "home")
            is_screen = n.get("space") == "screen"
            
            # For screen-space nodes, keep them in their screen view
            if is_screen and view_id not in screen_views:
                # Find a screen view for this node
                for sv in screen_views:
                    view_id = sv
                    break
            
            cx, cy = view_center.get(view_id, (0.0, 0.0))
            parent_id = str(n.get("parentId") or "").strip()
            if parent_id:
                # Parent-relative normalized by parent.h; store as-is.
                xn = float(t.get("x", 0.0) or 0.0)
                yn = float(t.get("y", 0.0) or 0.0)
                wn = float(t.get("w", 0.1) or 0.1)
                hn = float(t.get("h", 0.05) or 0.05)
            elif is_screen:
                # Screen-space nodes: store normalized fractions in [0..1] relative to the runtime screen.
                xn = float(t.get("x", 0.0) or 0.0)
                yn = float(t.get("y", 0.0) or 0.0)
                wn = float(t.get("w", 0.2) or 0.2)
                hn = float(t.get("h", 0.1) or 0.1)
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
                    "id": node_id,
                    "view": view_id,
                    "x": xn,
                    "y": yn,
                    "w": wn,
                    "h": hn,
                    "rotationDeg": t.get("rotationDeg", ""),
                    "anchor": t.get("anchor", "topLeft"),
                    "align": n.get("align", ""),
                    "vAlign": n.get("vAlign", ""),
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
    Write presentation.pr (v1 canonical DSL format).
    """
    # New serializer with screen support
    nodes_by_id: dict[str, dict[str, Any]] = {n["id"]: n for n in model.get("nodes", []) if "id" in n}
    views: list[dict[str, Any]] = model.get("views", []) or [{"id": "home", "camera": {"cx": 0, "cy": 0, "zoom": 1}, "show": list(nodes_by_id.keys())}]

    lines: list[str] = []
    lines.append("# presentation.txt v1 (canonical)")
    lines.append("")

    def style_params(node: dict[str, Any]) -> list[str]:
        params: list[str] = []
        bg = (node.get("bgColor") or "").strip() if isinstance(node.get("bgColor"), str) else ""
        if bg:
            params.append(f"bgColor={_safe_str(bg)}")
        ba = node.get("bgAlpha")
        if isinstance(ba, (int, float)):
            params.append(f"bgAlpha={ba}")
        br = node.get("borderRadius")
        if isinstance(br, (int, float)):
            params.append(f"borderRadius={br}")
        return params

    def write_node(n: dict[str, Any]) -> None:
        node_id = n.get("id")
        t = n.get("type")
        if t == "text":
            params = [f"name={node_id}"] + style_params(n)
            lines.append(f"text[{','.join(params)}]:")
            content = (n.get("text") or "").rstrip("\n")
            if content:
                for ln in content.splitlines():
                    lines.append(_safe_str(ln))
            lines.append("")
            return
        if t == "qr":
            url = (n.get("url") or "/join").strip() or "/join"
            params = [f"name={node_id}"] + style_params(n)
            if url != "/join":
                params.append(f'url="{_safe_str(str(url))}"')
            lines.append(f"qr[{','.join(params)}]")
            return
        if t == "htmlFrame":
            src = n.get("src")
            params = [f"name={node_id}"] + style_params(n)
            if src:
                params.append(f'src="{_safe_str(str(src))}"')
            lines.append(f"iframe[{','.join(params)}]")
            return
        if t == "video":
            src = n.get("src")
            params = [f"name={node_id}"] + style_params(n)
            if src:
                params.append(f"src={_fmt_param_value(src)}")
            thumb = n.get("thumbnail") or n.get("poster")
            if thumb:
                params.append(f"thumbnail={_fmt_param_value(thumb)}")
            lines.append(f"video[{','.join(params)}]")
            return
        if t == "image":
            src = n.get("src")
            params = [f"name={node_id}"] + style_params(n)
            if src and str(src) != f"/media/{node_id}.png":
                params.append(f'file="{_safe_str(str(src))}"')
            lines.append(f"image[{','.join(params)}]")
            return
        if t == "bullets":
            bullet_style = (n.get("bullets") or "").strip()
            params = [f"name={node_id}"] + style_params(n)
            if bullet_style:
                params.append(f"type={_safe_str(str(bullet_style))}")
            lines.append(f"bullets[{','.join(params)}]:")
            for item in n.get("items", []) or []:
                lines.append(_safe_str(str(item)))
            lines.append("")
            return
        if t == "table":
            delim = n.get("delimiter") or ";"
            params = [f"name={node_id}", f'delim="{_safe_str(str(delim))}"'] + style_params(n)
            hs = n.get("hstyle")
            vs = n.get("vstyle")
            if isinstance(hs, str) and hs.strip():
                params.append(f"hstyle={_fmt_param_value(hs.strip())}")
            if isinstance(vs, str) and vs.strip():
                params.append(f"vstyle={_fmt_param_value(vs.strip())}")
            lines.append(f"table[{','.join(params)}]:")
            for row in n.get("rows", []) or []:
                lines.append(_safe_str(delim.join([str(c) for c in row])))
            lines.append("")
            return
        if t == "graph":
            params = [f"name={node_id}"] + style_params(n)
            xs = n.get("xSource")
            ys = n.get("ySource")
            if isinstance(xs, str) and xs.strip():
                params.append(f"xSource={_fmt_param_value(xs.strip())}")
            if isinstance(ys, str) and ys.strip():
                params.append(f"ySource={_fmt_param_value(ys.strip())}")
            xl = n.get("xLabel")
            yl = n.get("yLabel")
            if isinstance(xl, str) and xl.strip():
                params.append(f"xLabel={_fmt_param_value(xl.strip())}")
            if isinstance(yl, str) and yl.strip():
                params.append(f"yLabel={_fmt_param_value(yl.strip())}")
            grid = n.get("grid")
            if isinstance(grid, str) and grid.strip():
                params.append(f"grid={_safe_str(grid.strip())}")
            col = n.get("color") or n.get("stroke")
            if isinstance(col, str) and col.strip():
                params.append(f"color={_fmt_param_value(col.strip())}")
            lines.append(f"graph[{','.join(params)}]")
            return
        if t == "arrow":
            params = [f"name={node_id}"] + style_params(n)
            fr = n.get("from") or {}
            to = n.get("to") or {}
            fx = float(fr.get("x", 0.0) or 0.0)
            fy = float(fr.get("y", 0.5) or 0.5)
            tx = float(to.get("x", 1.0) or 1.0)
            ty = float(to.get("y", 0.5) or 0.5)
            params.append(f"from=({_fmt_param_value(fx)},{_fmt_param_value(fy)})")
            params.append(f"to=({_fmt_param_value(tx)},{_fmt_param_value(ty)})")
            col = n.get("color") or n.get("stroke")
            if isinstance(col, str) and col.strip():
                params.append(f"color={_fmt_param_value(col.strip())}")
            if isinstance(n.get("width"), (int, float)):
                params.append(f"width={_fmt_param_value(n.get('width'))}")
            lines.append(f"arrow[{','.join(params)}]")
            return
        if t == "line":
            params = [f"name={node_id}"] + style_params(n)
            fr = n.get("from") or {}
            to = n.get("to") or {}
            fx = float(fr.get("x", 0.0) or 0.0)
            fy = float(fr.get("y", 0.5) or 0.5)
            tx = float(to.get("x", 1.0) or 1.0)
            ty = float(to.get("y", 0.5) or 0.5)
            params.append(f"from=({_fmt_param_value(fx)},{_fmt_param_value(fy)})")
            params.append(f"to=({_fmt_param_value(tx)},{_fmt_param_value(ty)})")
            col = n.get("color") or n.get("stroke")
            if isinstance(col, str) and col.strip():
                params.append(f"color={_fmt_param_value(col.strip())}")
            if isinstance(n.get("width"), (int, float)):
                params.append(f"width={_fmt_param_value(n.get('width'))}")
            p1j = n.get("p1Join")
            p2j = n.get("p2Join")
            if isinstance(p1j, str) and p1j.strip():
                params.append(f"p1Join={_fmt_param_value(p1j.strip())}")
            if isinstance(p2j, str) and p2j.strip():
                params.append(f"p2Join={_fmt_param_value(p2j.strip())}")
            lines.append(f"lines[{','.join(params)}]")
            return
        if t == "sound":
            params = [f"name={node_id}"] + style_params(n)
            mode = n.get("mode")
            if isinstance(mode, str) and mode.strip():
                params.append(f"mode={_fmt_param_value(mode.strip())}")
            if isinstance(n.get("windowS"), (int, float)):
                params.append(f"windowS={_fmt_param_value(n.get('windowS'))}")
            if bool(n.get("grid")):
                params.append("grid=on")
            col = n.get("color")
            if isinstance(col, str) and col.strip():
                params.append(f"color={_fmt_param_value(col.strip())}")
            lines.append(f"sound[{','.join(params)}]")
            return
        if t == "choices":
            params = [f"name={node_id}"] + style_params(n)
            chart = n.get("chart") or "pie"
            if chart:
                params.append(f"type={_safe_str(str(chart))}")
            bullets = (n.get("bullets") or "").strip()
            if bullets:
                params.append(f"bullets={_safe_str(str(bullets))}")
            # Optional pie labeling controls
            if isinstance(n.get("includeLimit"), (int, float)):
                params.append(f"includeLimit={_fmt_param_value(n.get('includeLimit'))}")
            if isinstance(n.get("textInsideLimit"), (int, float)):
                params.append(f"textInsideLimit={_fmt_param_value(n.get('textInsideLimit'))}")
            if isinstance(n.get("otherLabel"), str) and n.get("otherLabel"):
                params.append(f"otherLabel={_fmt_param_value(n.get('otherLabel'))}")
            opts = n.get("options") or []
            opt_parts: list[str] = []
            # Handle options as list of dicts (standard format)
            if isinstance(opts, list):
                for opt in opts:
                    if not isinstance(opt, dict):
                        continue
                    label = str(opt.get("label") or "").strip()
                    color = str(opt.get("color") or "").strip()
                    if not label:
                        continue
                    if color:
                        opt_parts.append(f"{_safe_str(label)}:{_safe_str(color)}")
                    else:
                        opt_parts.append(_safe_str(label))
            if opt_parts:
                params.append("choices={" + ",".join(opt_parts) + "}")
            lines.append(f"choices[{','.join(params)}]:")
            question = (n.get("question") or "").rstrip("\n")
            if question:
                for ln in question.splitlines():
                    lines.append(_safe_str(ln))
            lines.append("")
            return
        if t == "group":
            params = [f"name={node_id}"] + style_params(n)
            lines.append(f"group[{','.join(params)}]")
            return
        if t == "timer":
            params = [f"name={node_id}"]
            args = n.get("args") if isinstance(n.get("args"), dict) else {}
            if "showTime" not in args and "showTime" in n:
                args["showTime"] = 1 if bool(n.get("showTime")) else 0
            if "grid" not in args and "grid" in n:
                args["grid"] = "on" if bool(n.get("grid")) else "off"
            if "barColor" not in args and n.get("barColor"):
                args["barColor"] = n.get("barColor")
            if "lineColor" not in args and n.get("lineColor"):
                args["lineColor"] = n.get("lineColor")
            if "lineWidth" not in args and isinstance(n.get("lineWidth"), (int, float)):
                args["lineWidth"] = n.get("lineWidth")
            if "stat" not in args and n.get("stat"):
                args["stat"] = n.get("stat")
            if "min" not in args and isinstance(n.get("minS"), (int, float)):
                args["min"] = n.get("minS")
            if "max" not in args and isinstance(n.get("maxS"), (int, float)):
                args["max"] = n.get("maxS")
            if "binSize" not in args and isinstance(n.get("binSizeS"), (int, float)):
                args["binSize"] = n.get("binSizeS")
            for k in sorted([k for k in args.keys() if k != "name"]):
                params.append(f"{_safe_str(str(k))}={_fmt_param_value(args.get(k))}")
            lines.append(f"timer[{','.join(params)}]")
            return
        raise ValueError(f"write_presentation_txt: unsupported node type {t!r} (id={node_id!r})")

    # Emit screen views first (views marked screen=True), preserving order.
    for v in views:
        if not v.get("screen"):
            continue
        vid = v.get("id", "screen")
        lines.append(f"screen[name={_safe_str(str(vid))}]:")
        lines.append("")
        for node_id in v.get("show", []):
            n = nodes_by_id.get(node_id)
            if not n or n.get("space") != "screen":
                continue
            write_node(n)
        lines.append("")

    # Emit normal views.
    for v in views:
        if v.get("screen"):
            continue
        vid = v.get("id", "home")
        view_params = [f"name={vid}"]

        cam_spec = v.get("cameraSpec")
        if isinstance(cam_spec, dict) and cam_spec:
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
            if not n or n.get("space") == "screen":
                continue
            write_node(n)

        lines.append("")

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


