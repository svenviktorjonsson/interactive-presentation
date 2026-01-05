import type { NodeModel, PresentationModel } from "@interactive/content";
import { worldToScreen } from "../camera";

export interface DomNodeHandle {
  id: string;
  el: HTMLElement;
  update: (node: NodeModel) => void;
  destroy: () => void;
}

type ControlButtonSpec = { label: string; action: string; primary?: boolean };

function createControlBar(opts: { className: string; buttonClass: string; buttons: ControlButtonSpec[] }) {
  const bar = document.createElement("div");
  bar.className = opts.className;
  bar.style.position = "absolute";
  bar.style.left = "0";
  bar.style.right = "0";
  bar.style.display = "flex";
  bar.style.alignItems = "center";
  bar.style.pointerEvents = "auto";
  const buttons: Record<string, HTMLButtonElement> = {};
  for (const b of opts.buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${opts.buttonClass}${b.primary ? " primary" : ""}`;
    btn.dataset.action = b.action;
    btn.textContent = b.label;
    bar.appendChild(btn);
    buttons[b.action] = btn;
  }
  return { bar, buttons };
}

function setCommonStyles(el: HTMLElement, node: NodeModel) {
  el.style.position = "absolute";
  el.style.pointerEvents = "auto";
  el.style.opacity = String(node.opacity ?? 1);
  el.style.display = node.visible === false ? "none" : "block";
  el.style.transformOrigin = "50% 50%";
  el.dataset.nodeId = node.id;
  el.dataset.nodeType = node.type;
  el.dataset.anchor = node.transform.anchor ?? "";
  const bg = (node as any).bgColor;
  const bgAlpha = (node as any).bgAlpha;
  if (bg) {
    el.style.background = normalizeBg(bg, bgAlpha);
  } else {
    el.style.background = "transparent";
  }
  if ((node as any).borderRadius != null) {
    const br = Number((node as any).borderRadius);
    if (Number.isFinite(br)) el.style.borderRadius = `${br}px`;
  } else {
    el.style.borderRadius = "";
  }
  el.classList.add("node");
}

function normalizeBg(bg: string, alpha?: number | null) {
  const a = typeof alpha === "number" && Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : null;
  const hex = bg.trim();
  if (hex.startsWith("#")) {
    // Support #RRGGBB or #RRGGBBAA
    if (hex.length === 7) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const finalA = a ?? 1;
      return `rgba(${r}, ${g}, ${b}, ${finalA})`;
    }
    if (hex.length === 9) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const aa = parseInt(hex.slice(7, 9), 16) / 255;
      const finalA = a ?? aa;
      return `rgba(${r}, ${g}, ${b}, ${finalA})`;
    }
    return hex;
  }
  // Support tuple "r,g,b" or "r,g,b,a"
  const tuple = hex.split(",").map((t) => t.trim());
  if (tuple.length === 3 || tuple.length === 4) {
    const [r, g, b, a0] = tuple;
    const r1 = Number(r);
    const g1 = Number(g);
    const b1 = Number(b);
    const a1 = tuple.length === 4 ? Number(a0) : null;
    if ([r1, g1, b1].every((v) => Number.isFinite(v))) {
      const finalA = a ?? (Number.isFinite(a1) ? a1 : 1);
      return `rgba(${r1}, ${g1}, ${b1}, ${finalA})`;
    }
  }
  // Fallback: let CSS parse it (e.g., named colors or rgba()).
  return a != null ? `color-mix(in srgb, ${bg} ${a * 100}%, transparent)` : bg;
}

function applyTransform(el: HTMLElement, node: NodeModel, px: { x: number; y: number; w: number; h: number }) {
  el.style.left = `${px.x}px`;
  el.style.top = `${px.y}px`;
  el.style.width = `${px.w}px`;
  el.style.height = `${px.h}px`;
  const rot = node.transform.rotationDeg ?? 0;
  el.style.transform = `rotate(${rot}deg)`;
}

function _stripGlobal(re: RegExp) {
  // Avoid stateful/global regex behavior in helpers.
  const flags = re.flags.replaceAll("g", "");
  return new RegExp(re.source, flags);
}

function _ensureGlobal(re: RegExp) {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

function expandEllipsisStyle(style: string, targetCount: number, alignRe: RegExp) {
  const s = String(style ?? "").trim();
  if (!s || !s.includes("...")) return s;
  const alignNoG = _stripGlobal(alignRe);
  const alignG = _ensureGlobal(alignRe);
  const [pre, post] = s.split("...", 2);
  const prefix = pre ?? "";
  const suffix = post ?? "";

  const countAlign = (x: string) => (x.match(alignG) ?? []).length;
  const prefixCount = countAlign(prefix);
  const suffixCount = countAlign(suffix);
  const remaining = targetCount - prefixCount - suffixCount;
  if (remaining <= 0) return s.replace("...", ""); // nothing to expand

  // Repeat segment = substring starting at the last alignment letter in the prefix.
  // Example: "b||c|" + "..." + "||" → repeat "c|" as needed.
  let segStart = -1;
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (alignNoG.test(prefix[i]!)) {
      segStart = i;
      break;
    }
  }
  if (segStart < 0) return s.replace("...", "");
  const repeatSeg = prefix.slice(segStart);
  return prefix + repeatSeg.repeat(remaining) + suffix;
}

function parseLineStyle(spec: string, alignRe: RegExp) {
  // Parse LaTeX-like specs into:
  // - align letters (order preserved)
  // - boundary thicknesses (count of '|' before each align letter, plus trailing bars)
  const s = String(spec ?? "");
  const alignNoG = _stripGlobal(alignRe);
  const aligns: string[] = [];
  const bounds: number[] = [];
  let bars = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "|") {
      bars += 1;
      continue;
    }
    if (alignNoG.test(ch)) {
      // Boundary before this align
      if (aligns.length === 0) bounds[0] = bars;
      else bounds[aligns.length] = bars;
      bars = 0;
      aligns.push(ch);
      continue;
    }
    // ignore other chars
  }
  bounds[aligns.length] = bars;
  return { aligns, bounds };
}

function getOrDefault<T>(arr: T[], idx: number, fallback: T) {
  return idx >= 0 && idx < arr.length ? arr[idx]! : fallback;
}

export function createDomNode(node: NodeModel): DomNodeHandle | null {
  if (node.type === "group") {
    const el = document.createElement("div");
    el.classList.add("node-group");
    el.style.boxSizing = "border-box";
    el.style.background = "transparent";
    // Allow selection handles to render outside bounds.
    el.style.overflow = "visible";
    setCommonStyles(el, node);
    const update = (n: NodeModel) => {
      if (n.type !== "group") return;
      setCommonStyles(el, n);
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }
  if (node.type === "text") {
    const el = document.createElement("div");
    el.classList.add("node-text");
    el.style.whiteSpace = "pre-wrap";
    el.style.color = "rgba(255,255,255,0.92)";
    el.style.fontSize = "28px";
    // Match KaTeX's \mathrm{...} look (regular weight Computer Modern–like roman).
    el.style.fontWeight = "400";
    el.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
    el.style.boxSizing = "border-box";
    // Support vertical alignment inside the text box without requiring app-layer wrappers.
    el.style.display = "flex";
    el.style.flexDirection = "column";

    // Keep a stable content child so app-layer KaTeX hydration can safely set innerHTML.
    const content = document.createElement("div");
    content.className = "node-text-content";
    content.style.width = "100%";
    el.appendChild(content);
    setCommonStyles(el, node);

    const update = (n: NodeModel) => {
      if (n.type !== "text") return;
      setCommonStyles(el, n);
      // Override setCommonStyles display=block so we can use flex for vertical alignment.
      el.style.display = n.visible === false ? "none" : "flex";
      const align = (n as any).align;
      el.style.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";

      const vAlign = String((n as any).vAlign ?? "top").toLowerCase();
      el.style.justifyContent = vAlign === "bottom" ? "flex-end" : vAlign === "center" ? "center" : "flex-start";
      // IMPORTANT:
      // The app layer may render KaTeX by setting el.innerHTML. Since this renderer runs every frame,
      // we must not overwrite innerHTML unless the raw text actually changed.
      const raw = (n as any).text ?? "";
      if (el.dataset.rawText !== raw) {
        el.dataset.rawText = raw;
        // Provide a plain-text fallback until the app layer re-hydrates math.
        content.textContent = raw;
      }
    };

    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "bullets") {
    const el = document.createElement("div");
    el.classList.add("node-bullets");
    setCommonStyles(el, node);

    const list = document.createElement("div");
    list.className = "bullets-list";
    el.appendChild(list);

    const markerFor = (idx: number, style: string) => {
      const i = idx + 1;
      switch (style) {
        case "a":
          return String.fromCharCode(96 + i) + ".";
        case "A":
          return String.fromCharCode(64 + i) + ".";
        case "1":
          return `${i}.`;
        case "X": {
          const romans = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
          return (romans[i - 1] ?? String(i)) + ".";
        }
        case "i": {
          const romans = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
          return (romans[i - 1] ?? String(i)).toString() + ".";
        }
        case ".":
          return "•";
        case "-":
          return "–";
        default:
          return "•";
      }
    };

    const renderItems = (items: string[], style: string) => {
      const fontPx = typeof (node as any).fontPx === "number" ? (node as any).fontPx : 22;
      el.style.fontSize = `${fontPx}px`;
      list.innerHTML = "";
      items.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "bullet-row";
        const marker = document.createElement("span");
        marker.className = "bullet-marker";
        marker.textContent = markerFor(idx, style);
        const body = document.createElement("span");
        body.className = "bullet-body";
        body.textContent = item ?? "";
        row.append(marker, body);
        list.appendChild(row);
      });
    };

    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "bullets") return;
      const style = (n as any).bullets ?? "A";
      const fontPx = typeof (n as any).fontPx === "number" ? (n as any).fontPx : 22;
      el.style.fontSize = `${fontPx}px`;
      renderItems((n as any).items ?? [], style);
    };

    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "table") {
    const el = document.createElement("div");
    el.classList.add("node-table");
    el.style.boxSizing = "border-box";
    el.style.overflow = "hidden";
    el.style.color = "rgba(255,255,255,0.92)";
    el.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
    el.style.fontWeight = "400";

    const table = document.createElement("table");
    table.className = "table-grid";
    table.style.width = "100%";
    table.style.height = "100%";
    // NOTE:
    // With `border-collapse: collapse`, many browsers will render `double` borders as a single thick line
    // due to border conflict resolution. We use `separate + borderSpacing=0` so `||` can reliably show
    // as a true double line.
    table.style.borderCollapse = "separate";
    table.style.borderSpacing = "0";
    table.style.tableLayout = "fixed";
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    el.appendChild(table);

    const render = (n: any) => {
      const rows: string[][] = Array.isArray(n.rows) ? n.rows : [];
      const colCount = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));

      const hs0 = String(n.hstyle ?? "");
      const vs0 = String(n.vstyle ?? "");
      const hs = expandEllipsisStyle(hs0, colCount, /[lcr]/);
      const vs = expandEllipsisStyle(vs0, rows.length, /[tcb]/);

      const hParsed = parseLineStyle(hs || `|${"c|".repeat(colCount)}`, /[lcr]/);
      const vParsed = parseLineStyle(vs || `|${"c|".repeat(rows.length)}`, /[tcb]/);

      const colAligns = Array.from({ length: colCount }, (_, i) => getOrDefault(hParsed.aligns, i, "c"));
      const colBounds = Array.from({ length: colCount + 1 }, (_, i) => getOrDefault(hParsed.bounds, i, 1));
      const rowAligns = Array.from({ length: rows.length }, (_, i) => getOrDefault(vParsed.aligns, i, "c"));
      const rowBounds = Array.from({ length: rows.length + 1 }, (_, i) => getOrDefault(vParsed.bounds, i, 0));

      const borderColor = "rgba(255,255,255,0.65)";
      // Border thickness semantics:
      // - "|"  => single line
      // - "||" => double line
      // CSS can render a true double border via `border-style: double` but it needs enough width
      // (>= 3px) to actually show as two lines.
      const borderCss = (bars: number) => {
        const n = Math.max(0, Math.floor(Number(bars) || 0));
        if (n <= 0) return "0px solid transparent";
        if (n === 1) return `1px solid ${borderColor}`;
        // n>=2: use double borders; scale width a bit with n but cap it.
        const px = Math.min(8, 3 + (n - 2) * 2); // 2 bars => 3px, 3 bars => 5px, 4 bars => 7px ...
        return `${px}px double ${borderColor}`;
      };

      tbody.innerHTML = "";
      rows.forEach((r, ri) => {
        const tr = document.createElement("tr");
        for (let ci = 0; ci < colCount; ci++) {
          const td = document.createElement("td");
          td.className = "table-cell";
          const raw = String((Array.isArray(r) ? r[ci] : "") ?? "");
          td.textContent = raw;
          td.dataset.raw = raw;
          td.style.padding = "6px 10px";
          td.style.overflow = "hidden";
          td.style.textOverflow = "ellipsis";
          td.style.whiteSpace = "nowrap";
          const a = colAligns[ci];
          td.style.textAlign = a === "l" ? "left" : a === "r" ? "right" : "center";
          const va = rowAligns[ri];
          td.style.verticalAlign = va === "t" ? "top" : va === "b" ? "bottom" : "middle";
          // Borders:
          td.style.borderLeft = borderCss(colBounds[ci]);
          td.style.borderTop = borderCss(rowBounds[ri]);
          if (ci === colCount - 1) td.style.borderRight = borderCss(colBounds[colCount]);
          if (ri === rows.length - 1) td.style.borderBottom = borderCss(rowBounds[rows.length]);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
    };

    setCommonStyles(el, node);
    const update = (n: NodeModel) => {
      if (n.type !== "table") return;
      setCommonStyles(el, n);
      const key = JSON.stringify({ rows: (n as any).rows ?? [], hstyle: (n as any).hstyle ?? "", vstyle: (n as any).vstyle ?? "" });
      if ((el.dataset as any).tableKey !== key) {
        (el.dataset as any).tableKey = key;
        render(n as any);
      }
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "qr") {
    // The actual QR image is generated by the app layer (qrcode lib) for now.
    const el = document.createElement("div");
    el.classList.add("node-qr");
    el.style.boxSizing = "border-box";

    const box = document.createElement("div");
    box.className = "qr-box";
    box.style.position = "relative";
    box.style.width = "100%";
    box.style.height = "100%";

    const canvas = document.createElement("canvas");
    canvas.className = "qr-canvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "none";
    (canvas.style as any).imageRendering = "pixelated";

    const img = document.createElement("img");
    img.className = "qr-img";
    img.alt = "QR";
    img.style.position = "absolute";
    img.style.inset = "0";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.display = "block";
    (img.style as any).imageRendering = "pixelated";
    box.append(canvas, img);
    el.append(box);

    setCommonStyles(el, node);
    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "qr") return;
      el.dataset.qrUrl = (n as any).url;
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "htmlFrame") {
    // Important: clicks inside the iframe won't bubble to the parent document.
    // We *want* that. Selection/resize should happen on the border area around the iframe.
    const el = document.createElement("div");
    el.classList.add("node-iframe");
    el.style.boxSizing = "border-box";
    el.style.position = "absolute";
    // Important: allow handles (rotate dot) to render outside the frame bounds.
    el.style.overflow = "visible";

    const frame = document.createElement("div");
    frame.className = "iframe-frame";

    const borderPx = 10;
    const iframe = document.createElement("iframe");
    iframe.className = "iframe";
    iframe.style.position = "absolute";
    iframe.style.left = `${borderPx}px`;
    iframe.style.top = `${borderPx}px`;
    iframe.style.right = `${borderPx}px`;
    iframe.style.bottom = `${borderPx}px`;
    iframe.style.width = `calc(100% - ${borderPx * 2}px)`;
    iframe.style.height = `calc(100% - ${borderPx * 2}px)`;
    iframe.style.border = "0";
    iframe.style.background = "transparent";
    iframe.loading = "lazy";

    frame.appendChild(iframe);
    el.appendChild(frame);
    setCommonStyles(el, node);

    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "htmlFrame") return;
      iframe.src = (n as any).src;
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "image") {
    const el = document.createElement("div");
    el.classList.add("node-image");
    el.style.boxSizing = "border-box";

    // Inner frame so we can clip rounded corners without clipping resize/rotate handles.
    const frame = document.createElement("div");
    frame.className = "image-frame";
    frame.style.position = "absolute";
    frame.style.inset = "0";
    frame.style.overflow = "hidden";
    frame.style.borderRadius = "12px";

    const canvas = document.createElement("canvas");
    canvas.className = "image-canvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "none";
    (canvas.style as any).imageRendering = "pixelated";

    const img = document.createElement("img");
    img.className = "image";
    img.alt = "image";
    img.style.position = "absolute";
    img.style.inset = "0";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.display = "block";
    img.decoding = "async";
    // Images are frequently used for critical UI (e.g. join QR).
    // Avoid any browser heuristics delaying load.
    img.loading = "eager";
    img.addEventListener("error", () => {
      // eslint-disable-next-line no-console
      console.warn("[ip] image failed to load", { id: node.id, src: (node as any).src });
    });
    (img.style as any).imageRendering = "pixelated";
    frame.append(canvas, img);
    el.append(frame);

    setCommonStyles(el, node);
    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "image") return;
      img.src = (n as any).src;
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "choices") {
    const el = document.createElement("div");
    el.classList.add("node-choices");
    el.style.boxSizing = "border-box";

    const frame = document.createElement("div");
    frame.className = "choices-frame";
    frame.style.position = "absolute";
    frame.style.inset = "0";
    frame.style.overflow = "visible";

    const layer = document.createElement("div");
    layer.className = "choices-sub-layer";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    // Important: allow clicks/dblclicks on bullets area to reach the node (edit mode).
    // Live mode editing is blocked at the controller layer; buttons still need to be clickable.
    layer.style.pointerEvents = "auto";

    // Root composite has exactly two sub-elements:
    // - bullets (plain element, no folder)
    // - wheel (group with its own folder)
    const bullets = document.createElement("div");
    bullets.className = "choices-sub comp-sub choices-bullets";
    bullets.dataset.subId = "bullets";
    bullets.dataset.compPath = `${node.id}`; // stored in groups/<id>/geometries.csv
    bullets.style.position = "absolute";
    bullets.style.overflow = "visible";
    bullets.style.pointerEvents = "auto";
    bullets.style.display = "block";

    const wheelGroup = document.createElement("div");
    wheelGroup.className = "choices-sub comp-sub comp-group choices-wheel-group";
    wheelGroup.dataset.subId = "wheel";
    wheelGroup.dataset.compPath = `${node.id}`; // stored in groups/<id>/geometries.csv
    wheelGroup.dataset.groupPath = `${node.id}/wheel`; // children stored in groups/<id>/wheel/
    wheelGroup.style.position = "absolute";
    wheelGroup.style.overflow = "visible";
    wheelGroup.style.pointerEvents = "auto";
    wheelGroup.style.display = "none"; // results hidden by default; app layer toggles

    const { bar: controlsBar } = createControlBar({
      className: "choices-headerbar",
      buttonClass: "choices-btn",
      buttons: [
        { label: "Start", action: "choices-startstop", primary: true },
        { label: "Show results", action: "choices-showResults" },
        { label: "Reset", action: "choices-reset" },
        { label: "Test", action: "choices-test" }
      ]
    });
    // Buttons are NOT a standard editable element; keep them attached to the main choices node.
    // Let CSS position this headerbar so it stays consistent in both bullets+wheel views.
    frame.appendChild(controlsBar);

    const title = document.createElement("div");
    title.className = "choices-question";
    title.textContent = "Poll";
    const list = document.createElement("div");
    list.className = "choices-list";
    // Inner wrapper: scale via transform for smooth zoom (no font-size jitter).
    const bulletsInner = document.createElement("div");
    bulletsInner.className = "choices-bullets-inner";
    bulletsInner.append(title, list);
    bullets.append(bulletsInner);

    // --- wheel group children (stored under <id>/wheel) ---
    const pie = document.createElement("div");
    pie.className = "choices-sub comp-sub choices-wheel";
    pie.dataset.subId = "pie";
    pie.dataset.compPath = `${node.id}/wheel`;
    pie.style.position = "absolute";
    pie.style.pointerEvents = "auto";
    const canvas = document.createElement("canvas");
    canvas.className = "choices-chart-canvas";
    pie.appendChild(canvas);
    wheelGroup.appendChild(pie);

    layer.append(bullets, wheelGroup);
    frame.append(layer);
    el.append(frame);
    setCommonStyles(el, node);

    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "choices") return;
      el.dataset.bullets = (n as any).bullets ?? "A";
      el.dataset.chart = (n as any).chart ?? "pie";
      // Back-compat aliases:
      // - includeLimit == minPct/min
      // - textInsideLimit == minInsidePct/minInside
      el.dataset.includeLimit = String((n as any).includeLimit ?? (n as any).minPct ?? (n as any).min ?? "");
      el.dataset.textInsideLimit = String((n as any).textInsideLimit ?? (n as any).minInsidePct ?? (n as any).minInside ?? "");
      el.dataset.otherLabel = String((n as any).otherLabel ?? "");
      title.textContent = (n as any).question ?? "Poll";
      // default hidden until Show results is pressed (app layer controls actual rendering)
      if (!el.dataset.resultsVisible) el.dataset.resultsVisible = "0";

      // Apply composite geometries if provided.
      const byPath: any = (n as any).compositeGeometriesByPath ?? {};
      const rootGeoms = byPath[""] ?? {};
      const wheelGeoms = byPath["wheel"] ?? {};

      const apply = (sub: HTMLElement, gAny: any, fallback: any) => {
        const g = gAny ?? fallback;
        const x = Number(g.x ?? 0);
        const y = Number(g.y ?? 0);
        const w = Number(g.w ?? 1);
        const h = Number(g.h ?? 1);
        const rot = Number(g.rotationDeg ?? 0);
        sub.style.left = `${x * 100}%`;
        sub.style.top = `${y * 100}%`;
        sub.style.width = `${w * 100}%`;
        sub.style.height = `${h * 100}%`;
        sub.style.rotate = `${rot}deg`;
        const anchor = String(g.anchor ?? "topLeft");
        sub.dataset.anchor = anchor;
        // Anchor transform (so x/y are anchor coordinates).
        const tx =
          anchor.endsWith("Right") ? "-100%" : anchor.endsWith("Center") ? "-50%" : "0%";
        const ty =
          anchor.startsWith("Bottom") ? "-100%" : anchor.startsWith("Center") ? "-50%" : "0%";
        sub.style.transform = `translate(${tx}, ${ty})`;
      };

      // Bullets and wheel both default to full-frame; app layer toggles which one is visible.
      apply(bullets, rootGeoms["bullets"], { x: 0.0, y: 0.0, w: 1.0, h: 1.0, anchor: "topLeft", rotationDeg: 0 });
      apply(wheelGroup, rootGeoms["wheel"], { x: 0.0, y: 0.0, w: 1.0, h: 1.0, anchor: "topLeft", rotationDeg: 0 });
      apply(pie, wheelGeoms["pie"], { x: 0.5, y: 0.5, w: 1.0, h: 1.0, anchor: "centerCenter", rotationDeg: 0 });
    };

    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  if (node.type === "timer") {
    const el = document.createElement("div");
    el.classList.add("node-timer");
    el.style.boxSizing = "border-box";

    const frame = document.createElement("div");
    frame.className = "timer-frame";
    frame.style.position = "absolute";
    frame.style.inset = "0";
    // Allow composite sub-elements (labels/arrows) to be placed outside 0..1 of the timer rect.
    // The timer "data rect" is still the timer node bounds; sub-elements may extend outside.
    frame.style.overflow = "visible";
    // The composite rect should be a plain rectangle (no rounding).
    frame.style.borderRadius = "0";

    // Overlay is only a faint background layer to indicate the timer composite rect.
    // Subcomponents (labels/arrows) are rendered as siblings elsewhere so hiding this overlay
    // shows a clean composite in edit mode.
    const overlay = document.createElement("div");
    overlay.className = "timer-overlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";

    const overlayBg = document.createElement("div");
    overlayBg.className = "timer-overlay-bg";
    overlayBg.style.position = "absolute";
    // Data region only (aligned with default axis arrows).
    // left=0.08, right=0.92, top=0.10, bottom=0.90
    overlayBg.style.left = "8%";
    overlayBg.style.right = "8%";
    overlayBg.style.top = "10%";
    overlayBg.style.bottom = "10%";
    overlayBg.style.background = "rgba(255,255,255,0.10)";
    overlayBg.style.borderRadius = "0";
    overlayBg.style.pointerEvents = "none";
    overlay.append(overlayBg);

    const { bar: header } = createControlBar({
      className: "timer-header",
      buttonClass: "timer-btn",
      buttons: [
        { label: "Start", action: "timer-startstop", primary: true },
        { label: "Reset", action: "timer-reset" },
        { label: "Test", action: "timer-test" }
      ]
    });
    // Buttons should live outside the timer "data rect" overlay. Place them above.
    // Scale header offsets with the timer's pixel size (set via --timer-scale / --ui-scale).
    header.style.top = "calc(-44px * var(--ui-scale, var(--timer-scale, 1)))";
    header.style.padding = "0 calc(10px * var(--ui-scale, var(--timer-scale, 1)))";
    (header.style as any).gap = "calc(10px * var(--ui-scale, var(--timer-scale, 1)))";

    const canvas = document.createElement("canvas");
    canvas.className = "timer-canvas";
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.borderRadius = "0";

    frame.append(overlay, canvas, header);
    el.append(frame);

    setCommonStyles(el, node);
    const update = (n: NodeModel) => {
      setCommonStyles(el, n);
      if (n.type !== "timer") return;
      el.dataset.showTime = String(!!(n as any).showTime);
      el.dataset.barColor = (n as any).barColor ?? "orange";
      el.dataset.lineColor = (n as any).lineColor ?? "green";
      el.dataset.stat = (n as any).stat ?? "gaussian";
      if (typeof (n as any).minS === "number") el.dataset.minS = String((n as any).minS);
      else delete (el.dataset as any).minS;
      if (typeof (n as any).maxS === "number") el.dataset.maxS = String((n as any).maxS);
      else delete (el.dataset as any).maxS;
      if (typeof (n as any).binSizeS === "number") el.dataset.binSizeS = String((n as any).binSizeS);
      else delete (el.dataset as any).binSizeS;
      el.dataset.compositeEditing = "0";
    };
    update(node);
    return { id: node.id, el, update, destroy: () => el.remove() };
  }

  return null;
}

function anchorOffsetPx(anchor: string | undefined, wPx: number, hPx: number) {
  switch (anchor) {
    case "center":
    case "centerCenter":
      return { dx: -wPx / 2, dy: -hPx / 2 };
    case "top":
    case "topCenter":
      return { dx: -wPx / 2, dy: 0 };
    case "bottom":
    case "bottomCenter":
      return { dx: -wPx / 2, dy: -hPx };
    case "left":
    case "centerLeft":
      return { dx: 0, dy: -hPx / 2 };
    case "right":
    case "centerRight":
      return { dx: -wPx, dy: -hPx / 2 };
    case "topRight":
      return { dx: -wPx, dy: 0 };
    case "bottomLeft":
      return { dx: 0, dy: -hPx };
    case "bottomRight":
      return { dx: -wPx, dy: -hPx };
    case "topLeft":
    default:
      return { dx: 0, dy: 0 };
  }
}

export function layoutDomNodes(args: {
  model: PresentationModel;
  domNodes: Map<string, DomNodeHandle>;
  overlayEl: HTMLElement;
  camera: { cx: number; cy: number; zoom: number };
  screen: { w: number; h: number };
  timeMs: number;
  animationsEnabled: boolean;
}) {
  const { model, domNodes, overlayEl, camera, screen, timeMs, animationsEnabled } = args;
  const debugAnim =
    new URLSearchParams(window.location.search).get("debugAnim") === "1" || localStorage.getItem("ip_debug_anim") === "1";
  const dlog = (...a: any[]) => {
    if (!debugAnim) return;
    // eslint-disable-next-line no-console
    console.log("[ip][anim]", ...a);
  };
  const dpr = window.devicePixelRatio || 1;

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const memoWorld = new Map<string, any>();
  const resolving = new Set<string>();

  const resolveWorldTransform = (node: any): any => {
    if (!node || node.space !== "world") return node?.transform;
    if (memoWorld.has(node.id)) return memoWorld.get(node.id);
    if (resolving.has(node.id)) return node.transform; // break cycles
    resolving.add(node.id);

    const parentId = String(node.parentId ?? "").trim();
    if (!parentId) {
      resolving.delete(node.id);
      memoWorld.set(node.id, node.transform);
      return node.transform;
    }

    const parent = byId.get(parentId) as any;
    if (!parent) {
      resolving.delete(node.id);
      memoWorld.set(node.id, node.transform);
      return node.transform;
    }

    const pt = resolveWorldTransform(parent);
    const pr = (pt?.rotationDeg ?? 0) * (Math.PI / 180);
    const cos = Math.cos(pr);
    const sin = Math.sin(pr);
    const scale = Math.max(1e-6, Number(pt?.h ?? 1));
    const lt = node.transform ?? { x: 0, y: 0, w: 0.1, h: 0.05 };
    const lx = Number(lt.x ?? 0) * scale;
    const ly = Number(lt.y ?? 0) * scale;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    const rotDeg = (pt?.rotationDeg ?? 0) + (lt.rotationDeg ?? 0);
    const out = {
      x: Number(pt?.x ?? 0) + rx,
      y: Number(pt?.y ?? 0) + ry,
      w: Number(lt.w ?? 0.1) * scale,
      h: Number(lt.h ?? 0.05) * scale,
      rotationDeg: rotDeg,
      anchor: lt.anchor ?? pt?.anchor ?? "topLeft"
    };
    resolving.delete(node.id);
    memoWorld.set(node.id, out);
    return out;
  };

  // Pixelate helper: `p` is expected to already be STEP-QUANTIZED (e.g. 0, 0.05, 0.10, ... 1.0).
  const setPixelate = (hostEl: HTMLElement, pxW: number, pxH: number, p: number, steps = 20) => {
    const canvas = hostEl.querySelector<HTMLCanvasElement>("canvas.qr-canvas, canvas.image-canvas");
    const img = hostEl.querySelector<HTMLImageElement>("img.qr-img, img.image");
    if (!canvas || !img) return;

    const pp = Math.max(0, Math.min(1, p));
    if (p >= 1) {
      canvas.style.display = "none";
      canvas.style.opacity = "0";
      img.style.opacity = "1";
      delete (hostEl.dataset as any).pixW;
      delete (hostEl.dataset as any).pixH;
      return;
    }

    // Important: if the image isn't loaded yet, keep fully transparent to avoid any "flash".
    if (!img.complete || img.naturalWidth <= 0) {
      canvas.style.display = "block";
      canvas.style.opacity = "0";
      img.style.opacity = "0";
      return;
    }

    // Alpha is step-quantized and synced to resolution.
    canvas.style.opacity = String(pp);
    canvas.style.display = "block";
    img.style.opacity = "0";

    // Main canvas always matches element resolution; we pixelate via a low-res offscreen canvas.
    const W = Math.max(2, Math.min(4096, Math.round(pxW * dpr)));
    const H = Math.max(2, Math.min(4096, Math.round(pxH * dpr)));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    // Resolution ramps up step-wise, synced to alpha.
    // Minimum resolution is 1/steps to match "1 step == 1/steps alpha".
    const resFactor = Math.max(1 / Math.max(1, steps), Math.min(1, pp));
    const smallW = Math.max(2, Math.round(W * resFactor));
    const smallH = Math.max(2, Math.round(H * resFactor));

    const anyHost = hostEl as any;
    let off: HTMLCanvasElement = anyHost.__pixOffscreen;
    if (!off) {
      off = document.createElement("canvas");
      anyHost.__pixOffscreen = off;
    }
    if (off.width !== smallW || off.height !== smallH) {
      off.width = smallW;
      off.height = smallH;
    }

    const offCtx = off.getContext("2d");
    const ctx = canvas.getContext("2d");
    if (!offCtx || !ctx) return;
    (offCtx as any).imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingEnabled = false;

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const s0 = Math.min(smallW / iw, smallH / ih);
    const dw0 = iw * s0;
    const dh0 = ih * s0;
    const dx0 = (smallW - dw0) / 2;
    const dy0 = (smallH - dh0) / 2;

    offCtx.clearRect(0, 0, smallW, smallH);
    offCtx.drawImage(img, dx0, dy0, dw0, dh0);

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, smallW, smallH, 0, 0, W, H);
  };

  for (const node of model.nodes) {
    const handle = domNodes.get(node.id);
    if (!handle) continue;

    // Logical visibility: if false, always hide (independent of culling).
    if (node.visible === false) {
      handle.el.style.display = "none";
      // IMPORTANT: still track visibility edges even when hidden, otherwise enter animations
      // may fail to reset state when a node is shown again.
      handle.el.dataset.prevVisible = "0";
      // Reset pixelate internal state + ensure inner media isn't left fully transparent.
      delete (handle.el.dataset as any).animInStartMs;
      delete (handle.el.dataset as any).pixAnimStartMs;
      delete (handle.el.dataset as any).pixAnimDone;
      delete (handle.el.dataset as any).pixPending;
      const canvas = handle.el.querySelector<HTMLCanvasElement>("canvas.qr-canvas, canvas.image-canvas");
      const img = handle.el.querySelector<HTMLImageElement>("img.qr-img, img.image");
      if (canvas) {
        canvas.style.display = "none";
        canvas.style.opacity = "0";
      }
      if (img) {
        img.style.opacity = "1";
      }
      handle.update(node);
      continue;
    }

    let px: { x: number; y: number; w: number; h: number };
    const nAny: any = node as any;
    const wt = node.space === "world" ? resolveWorldTransform(nAny) : node.transform;
    const nodeLayout: any = node.space === "world" ? { ...node, transform: wt } : node;

    if (nodeLayout.space === "world") {
      const wPx = nodeLayout.transform.w * camera.zoom;
      const hPx = nodeLayout.transform.h * camera.zoom;
      const p = worldToScreen({ x: nodeLayout.transform.x, y: nodeLayout.transform.y }, camera, screen);
      const { dx, dy } = anchorOffsetPx(nodeLayout.transform.anchor, wPx, hPx);
      px = { x: p.x + dx, y: p.y + dy, w: wPx, h: hPx };
    } else {
      px = { x: nodeLayout.transform.x, y: nodeLayout.transform.y, w: nodeLayout.transform.w, h: nodeLayout.transform.h };
    }

    // (removed) noisy join_qr layout diagnostics

    // Cull if < 1 px on either dimension.
    if (px.w < 1 || px.h < 1) {
      handle.el.style.display = "none";
      continue;
    }

    // Viewport culling (performance): don't lay out / redraw nodes that are off-screen.
    // NOTE: This does NOT change the node's logical visibility; it just avoids work.
    const marginPx = 80;
    const off =
      px.x + px.w < -marginPx ||
      px.y + px.h < -marginPx ||
      px.x > screen.w + marginPx ||
      px.y > screen.h + marginPx;
    if (off) {
      handle.el.style.display = "none";
      continue;
    }
    // (removed) noisy join_qr offscreen/onscreen diagnostics

    // Expose timer pixel size and scale for composite children/layout.
    if (nodeLayout.type === "timer") {
      const baseH = Math.max(1e-6, Number(nodeLayout.transform.h ?? 1));
      const uiScale = px.h / baseH;
      handle.el.style.setProperty("--timer-scale", String(uiScale));
      handle.el.style.setProperty("--ui-scale", String(uiScale));
      handle.el.dataset.timerWpx = String(px.w);
      handle.el.dataset.timerHpx = String(px.h);
    }
    if (nodeLayout.type === "choices") {
      const baseH = Math.max(1e-6, Number(nodeLayout.transform.h ?? 1));
      const uiScale = px.h / baseH;
      handle.el.style.setProperty("--ui-scale", String(uiScale));
    }

    if (!handle.el.isConnected) overlayEl.appendChild(handle.el);
    handle.el.style.display = "block";
    applyTransform(handle.el, nodeLayout, px);
    handle.update(nodeLayout);

    // Text sizing:
    // - `fontPx` (world/design px) is the persisted base size.
    // - camera zoom scales it into screen pixels.
    if (nodeLayout.type === "text") {
      // Use px.h/localH to get effective zoom for world nodes; keeps text stable in groups.
      const localH = Math.max(1e-9, Number(nodeLayout.transform.h ?? 0) || 0);
      const z = nodeLayout.space === "world" ? px.h / localH : 1;
      const baseFontPx = Math.max(1, Number((nodeLayout as any).fontPx ?? (nodeLayout.transform.h ?? 40) * 0.6));
      handle.el.style.fontSize = `${Math.max(1, baseFontPx * z)}px`;
    }
    if (nodeLayout.type === "table") {
      const localH = Math.max(1e-9, Number(nodeLayout.transform.h ?? 0) || 0);
      const z = nodeLayout.space === "world" ? px.h / localH : 1;
      const baseFontPx = Math.max(10, Number((nodeLayout as any).fontPx ?? 20));
      handle.el.style.fontSize = `${Math.max(10, baseFontPx * z)}px`;
    }

    // Intro animations (appear)
    const appear: any = (nodeLayout as any).appear;
    const disappear: any = (nodeLayout as any).disappear;

    // Detect visibility edges so enter animations start deterministically on "show".
    // This avoids timing-sensitive behavior (e.g. pressing ArrowRight before the image loads).
    // (typed as any) to avoid BaseNodeModel union oddities.
    const visNow = (node as any).visible !== false;
    const visPrev = handle.el.dataset.prevVisible === "1";
    if (visNow && !visPrev) {
      // Became visible: reset any prior animation state.
      delete (handle.el.dataset as any).animInStartMs;
      delete (handle.el.dataset as any).pixAnimStartMs;
      delete (handle.el.dataset as any).pixAnimDone;
      delete (handle.el.dataset as any).exitStartMs;
      dlog("visible->true reset", node.id, { timeMs });
    }
    handle.el.dataset.prevVisible = visNow ? "1" : "0";

    // Exit animation (driven by dataset.exitStartMs set by presenter controller)
    if (animationsEnabled && disappear && typeof disappear === "object" && disappear.kind && disappear.kind !== "none") {
      const exitStart = Number(handle.el.dataset.exitStartMs ?? "");
      if (!Number.isNaN(exitStart)) {
        const dur = Number(disappear.durationMs ?? 0);
        const delay = Number(disappear.delayMs ?? 0);
        const t = dur > 0 ? (timeMs - (exitStart + delay)) / dur : 1;
        const p = Math.max(0, Math.min(1, t));

        if (disappear.kind === "sudden") {
          // No visual effect; controller will hide immediately.
        } else if (disappear.kind === "fade") {
          const from = String(disappear.from ?? "all");
          const borderFrac = Math.max(0, Math.min(0.49, Number(disappear.borderFrac ?? 0.2)));
          // p=0 => fully visible, p=1 => fully gone.
          const front = (1 - p) * 100;
          const lead = Math.max(0, front - borderFrac * 100);

          if (from === "all") {
            handle.el.style.opacity = String(1 - p);
            (handle.el.style as any).maskImage = "";
            (handle.el.style as any).webkitMaskImage = "";
          } else {
            handle.el.style.opacity = "1";
            let mask = "";
            if (from === "left") {
              // Keep right side; fade boundary moves left->right while disappearing.
              mask = `linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
            } else if (from === "right") {
              const f = 100 - front;
              const l = Math.min(100, f + borderFrac * 100);
              mask = `linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
            } else if (from === "top") {
              mask = `linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
            } else if (from === "bottom") {
              const f = 100 - front;
              const l = Math.min(100, f + borderFrac * 100);
              mask = `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
            }
            (handle.el.style as any).maskImage = mask;
            (handle.el.style as any).webkitMaskImage = mask;
          }
        } else if (disappear.kind === "pixelate") {
          // Pixelate out by ramping DOWN resolution.
          setPixelate(handle.el, px.w, px.h, 1 - p);
          handle.el.style.opacity = "1";
          (handle.el.style as any).maskImage = "";
          (handle.el.style as any).webkitMaskImage = "";
        }

        if (p >= 1) {
          // Let controller flip node.visible=false; clear local state.
          delete (handle.el.dataset as any).exitStartMs;
          handle.el.style.opacity = "1";
          (handle.el.style as any).maskImage = "";
          (handle.el.style as any).webkitMaskImage = "";
          setPixelate(handle.el, px.w, px.h, 1);
        }

        // While exiting, skip enter animation
        handle.update(node);
        continue;
      }
    }

    if (animationsEnabled && appear && typeof appear === "object" && appear.kind && appear.kind !== "none") {
      // Some specs (e.g. authored via UI) might omit durationMs; treat that as a default
      // so animations don't silently become "instant".
      let dur = Number(appear.durationMs ?? 0);
      const delay = Number(appear.delayMs ?? 0);
      if (appear.kind === "pixelate" && dur <= 0) dur = 800;
      if (appear.kind === "fade" && dur <= 0) dur = 800;
      if (appear.kind === "sudden") {
        handle.el.style.opacity = "1";
        (handle.el.style as any).maskImage = "";
        (handle.el.style as any).webkitMaskImage = "";
      } else
      if (dur > 0) {
        if (!handle.el.dataset.animInStartMs) {
          // Store the absolute start time (in engine timeMs), not just the delay.
          handle.el.dataset.animInStartMs = String(timeMs + delay);
        }
        const start = Number(handle.el.dataset.animInStartMs ?? "0");
        const t = (timeMs - start) / dur;
        const p = Math.max(0, Math.min(1, t));

        if (appear.kind === "fade") {
          const from = String(appear.from ?? "all");
          const borderFrac = Math.max(0, Math.min(0.49, Number(appear.borderFrac ?? 0.2)));

          if (p >= 1) {
            handle.el.style.opacity = "1";
            (handle.el.style as any).maskImage = "";
            (handle.el.style as any).webkitMaskImage = "";
          } else if (from === "all") {
            handle.el.style.opacity = String(p);
            (handle.el.style as any).maskImage = "";
            (handle.el.style as any).webkitMaskImage = "";
          } else {
            handle.el.style.opacity = "1";
            const front = p * 100;
            const lead = Math.max(0, front - borderFrac * 100);

            let mask = "";
            if (from === "left") {
              mask = `linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
            } else if (from === "right") {
              const f = 100 - front;
              const l = Math.min(100, f + borderFrac * 100);
              mask = `linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
            } else if (from === "top") {
              mask = `linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
            } else if (from === "bottom") {
              const f = 100 - front;
              const l = Math.min(100, f + borderFrac * 100);
              mask = `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
            }

            (handle.el.style as any).maskImage = mask;
            (handle.el.style as any).webkitMaskImage = mask;
          }
        } else if (appear.kind === "pixelate") {
          // Pixelate must be strictly monotonic and step-synced.
          // We start the animation clock when the image is actually ready (loaded).
          const img = handle.el.querySelector<HTMLImageElement>("img.qr-img, img.image");
          const ready = !!img && img.complete && img.naturalWidth > 0;

          // If we already completed once for this visibility span, do not restart.
          if (handle.el.dataset.pixAnimDone === "1") {
            setPixelate(handle.el, px.w, px.h, 1);
            handle.el.style.opacity = "1";
            (handle.el.style as any).maskImage = "";
            (handle.el.style as any).webkitMaskImage = "";
            handle.update(node);
            continue;
          }

          // Use a dedicated clock so we don't fight with the generic animInStartMs used by fade.
          if (!handle.el.dataset.pixAnimStartMs) {
            // If Live cue requested pixelate but the image isn't ready yet, hold p=0 and DO NOT advance time.
            if (!ready) {
              setPixelate(handle.el, px.w, px.h, 0);
              handle.el.style.opacity = "1";
              (handle.el.style as any).maskImage = "";
              (handle.el.style as any).webkitMaskImage = "";
              handle.update(node);
              continue;
            }
            handle.el.dataset.pixAnimStartMs = String(timeMs + delay);
            dlog("pixelate start", node.id, { start: handle.el.dataset.pixAnimStartMs, dur, delay, px: { w: px.w, h: px.h } });
          }
          // If we were explicitly asked to pixelate (by cue) we start as soon as ready.
          if (handle.el.dataset.pixPending === "1" && ready && !handle.el.dataset.pixAnimStartMs) {
            delete (handle.el.dataset as any).pixPending;
            handle.el.dataset.pixAnimStartMs = String(timeMs + delay);
            dlog("pixelate start(pending)", node.id, { start: handle.el.dataset.pixAnimStartMs, dur, delay });
          }

          const startPix = Number(handle.el.dataset.pixAnimStartMs ?? "0");
          const elapsed = Math.max(0, timeMs - startPix);
          const steps = Math.max(2, Number((model as any).defaults?.pixelateSteps ?? 20));
          const stepDur = dur > 0 ? dur / steps : 0;
          const stepIdx = stepDur > 0 ? Math.max(0, Math.min(steps, Math.floor(elapsed / stepDur))) : steps;
          const stepP = stepIdx / steps;

          setPixelate(handle.el, px.w, px.h, stepP, steps);
          // (removed) noisy join_qr pixelate diagnostics
          if (stepIdx >= steps) {
            delete (handle.el.dataset as any).pixAnimStartMs;
            handle.el.dataset.pixAnimDone = "1";
            dlog("pixelate done", node.id, { timeMs });
          }

          handle.el.style.opacity = "1";
          (handle.el.style as any).maskImage = "";
          (handle.el.style as any).webkitMaskImage = "";
        }
      }
    }

    handle.update(node);
  }
}


