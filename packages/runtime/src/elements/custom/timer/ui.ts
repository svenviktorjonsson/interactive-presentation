import type { Engine } from "@interactive/engine";
import { parseInlineParams, parseList } from "../../../utils/params";
import { applyDataBindings } from "../../../utils/template";
import { renderTextWithKatexToHtml } from "../../../utils/textMath";
import { anchorToTopLeftFrac } from "../../../utils/geom";

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };

export function ensureTimerCompositeLayer(engine: Engine, timerId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === timerId) as any;
  const el = engine.getNodeElement(timerId);
  if (!node || !el) return null;
  const frame = el.querySelector<HTMLElement>(".timer-frame");
  if (!frame) return null;

  let layer = frame.querySelector<HTMLElement>(":scope .timer-sub-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "timer-sub-layer";
    layer.dataset.timerId = timerId;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    frame.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("timer-sub-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);

    const plotGroup = document.createElement("div");
    plotGroup.className = "timer-sub comp-sub comp-group timer-sub-plotgroup";
    plotGroup.dataset.subId = "plot";
    plotGroup.dataset.compPath = timerId;
    plotGroup.dataset.groupPath = `${timerId}/plot`;
    plotGroup.style.position = "absolute";
    plotGroup.style.pointerEvents = "none";
    plotGroup.style.zIndex = "10";
    plotGroup.style.background = "transparent";
    layer.append(plotGroup);
    (layer as any).__plotGroup = plotGroup;

    const mkArrowHit = (arrowId: string) => {
      const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer!;
      const h = document.createElement("div");
      h.className = "timer-sub timer-sub-arrow-hit comp-sub";
      h.dataset.subId = arrowId;
      h.dataset.compPath = timerId;
      h.dataset.kind = "plot-arrow";
      h.dataset.arrowId = arrowId;
      h.style.position = "absolute";
      h.style.pointerEvents = "none";
      h.style.zIndex = "20";
      container.append(h);
      return h;
    };
    mkArrowHit("x_axis");
    mkArrowHit("y_axis");

    const geoms: Record<string, any> = (node.compositeGeometriesByPath?.[""] ?? node.compositeGeometries ?? {}) as any;
    geoms["plot"] = geoms["plot"] ?? { x: PLOT_FRACS.leftF, y: PLOT_FRACS.topF, w: PLOT_FRACS.rightF - PLOT_FRACS.leftF, h: PLOT_FRACS.bottomF - PLOT_FRACS.topF, rotationDeg: 0, anchor: "topLeft", align: "left" };

    const text = String(node.elementsText ?? "");
    (layer as any).__elementsPr = text;
    const lines = text.split(/\r?\n/);
    const arrowSpecs: Array<{ id: string; x0: number; y0: number; x1: number; y1: number; color: string; width: number }> = [];
    for (const ln0 of lines) {
      const ln = ln0.trim();
      if (!ln || ln.startsWith("#")) continue;

      const mt = ln.match(/^text\[name=(?<id>[a-zA-Z_]\w*)\]\s*:\s*(?<content>.*)$/);
      if (mt?.groups) {
        const sid = mt.groups.id;
        const content = mt.groups.content ?? "";
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.4, h: 0.1, rotationDeg: 0, anchor: "centerCenter", align: "center" };
        const d = document.createElement("div");
        d.className = "timer-sub timer-sub-text comp-sub";
        d.dataset.subId = sid;
        d.dataset.compPath = timerId;
        d.dataset.template = content;
        const contentEl = document.createElement("div");
        contentEl.className = "timer-sub-content";
        contentEl.style.width = "100%";
        contentEl.style.height = "100%";
        contentEl.style.display = "grid";
        contentEl.style.placeItems = "center";
        d.append(contentEl);
        d.style.position = "absolute";
        d.style.left = `${(g.x ?? 0.5) * 100}%`;
        d.style.top = `${(g.y ?? 0.5) * 100}%`;
        d.style.width = `${(g.w ?? 0.4) * 100}%`;
        d.style.height = `${(g.h ?? 0.1) * 100}%`;
        d.style.transform = "translate(-50%, -50%)";
        d.style.padding = "0";
        d.style.border = "none";
        d.style.background = "transparent";
        d.style.color = "rgba(255,255,255,0.92)";
        d.style.userSelect = "none";
        d.style.pointerEvents = "none";
        d.style.zIndex = "30";
        d.style.whiteSpace = "nowrap";
        d.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
        d.style.fontWeight = "400";
        d.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
        const rot = Number(g.rotationDeg ?? 0);
        if (rot) d.style.rotate = `${rot}deg`;
        layer.append(d);
        continue;
      }

      const mb = ln.match(/^buttons\[(?<params>[^\]]+)\]$/);
      if (mb?.groups?.params) {
        const params = parseInlineParams(mb.groups.params);
        const sid = String(params.name ?? "").trim();
        if (!sid) continue;
        const labels = parseList(params.labels);
        const actions = parseList(params.actions);
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.55, h: 0.10, rotationDeg: 0, anchor: "centerCenter", align: "center" };

        const boxEl = document.createElement("div");
        boxEl.className = "timer-sub timer-sub-buttons comp-chrome comp-sub";
        boxEl.dataset.subId = sid;
        boxEl.dataset.compPath = timerId;
        boxEl.dataset.templates = JSON.stringify(labels);
        boxEl.dataset.actions = JSON.stringify(actions);
        boxEl.style.position = "absolute";
        boxEl.style.left = `${(g.x ?? 0.5) * 100}%`;
        boxEl.style.top = `${(g.y ?? 0.5) * 100}%`;
        boxEl.style.width = `${(g.w ?? 0.55) * 100}%`;
        boxEl.style.height = `${(g.h ?? 0.10) * 100}%`;
        boxEl.style.transform = "translate(-50%, -50%)";
        boxEl.style.padding = "0";
        boxEl.style.border = "none";
        boxEl.style.background = "transparent";
        boxEl.style.pointerEvents = "auto";
        boxEl.style.zIndex = "40";
        boxEl.style.userSelect = "none";

        // Reuse engine control button markup (bootstrap handles click by action)
        const row = document.createElement("div");
        row.className = "ip-buttons-row";
        row.style.display = "flex";
        row.style.flexDirection = "row";
        row.style.gap = "10px";
        row.style.alignItems = "center";
        row.style.justifyContent = "center";
        row.style.width = "100%";
        row.style.height = "100%";

        labels.forEach((tpl, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ip-controlbtn";
          btn.dataset.idx = String(idx + 1);
          btn.dataset.template = String(tpl ?? "");
          btn.dataset.action = String(actions[idx] ?? "");
          const contentEl = document.createElement("div");
          contentEl.className = "ip-button-content";
          btn.appendChild(contentEl);
          row.append(btn);
        });
        boxEl.append(row);
        layer.append(boxEl);
        continue;
      }

      const ma = ln.match(/^arrow\[(?<params>[^\]]+)\]$/);
      if (ma?.groups?.params) {
        const p = parseInlineParams(ma.groups.params);
        const sid = String(p.name ?? "").trim();
        if (!sid) continue;
        const vec = (raw: any, def: { x: number; y: number }) => {
          const s = String(raw ?? "").trim();
          const m2 = s.match(/^\(\s*([\-0-9.]+)\s*,\s*([\-0-9.]+)\s*\)\s*$/);
          if (!m2) return def;
          const x = Number(m2[1]);
          const y = Number(m2[2]);
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : def;
        };
        const fr = vec(p.from, { x: 0, y: 0 });
        const to = vec(p.to, { x: 1, y: 0 });
        const col = String(p.color ?? "white") || "white";
        const w = Number(String(p.width ?? "").trim());
        arrowSpecs.push({ id: sid, x0: fr.x, y0: fr.y, x1: to.x, y1: to.y, color: col, width: Number.isFinite(w) ? w : 0.006 });
        continue;
      }
    }
    (layer as any).__arrowSpecs = arrowSpecs;
    (layer as any).__textGeoms = geoms;
  }
  return layer;
}

export function layoutTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : timerEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.1);
    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
  }
}

export function renderTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  const interactive = appMode === "edit" && isGroupEditing;

  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : timerEl.getBoundingClientRect();

  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const x = Number(g.x ?? 0.5);
    const y = Number(g.y ?? 0.5);
    const w = Number(g.w ?? 0.4);
    const h = Number(g.h ?? 0.1);
    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    t.style.rotate = `${Number(g.rotationDeg ?? 0)}deg`;
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";

    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;

    const tpl = t.dataset.template ?? "";
    const resolved = applyDataBindings(tpl, data);
    const prev = t.dataset.rawText ?? "";
    if (prev !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope .timer-sub-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    t.style.pointerEvents = interactive ? "auto" : "none";
    t.style.cursor = interactive ? "grab" : "default";
  }
}

export function renderTimerCompositeButtons(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-buttons"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  for (const boxEl of els) {
    const canSelectGroup = appMode === "edit" && isGroupEditing;
    boxEl.style.pointerEvents = appMode === "live" ? "auto" : canSelectGroup ? "auto" : "none";
    for (const btn of Array.from(boxEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const tpl = btn.dataset.template ?? "";
      const resolved = applyDataBindings(tpl, data);
      const prev = btn.dataset.rawText ?? "";
      if (prev !== resolved) {
        btn.dataset.rawText = resolved;
        const contentEl = btn.querySelector<HTMLElement>(".ip-button-content");
        if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
      }
    }
    // Hide legacy header if present
    timerEl.querySelector<HTMLElement>(".timer-header")?.setAttribute("style", "display:none !important");
  }
}

export function renderTimerCompositeArrows(timerEl: HTMLElement, layer: HTMLElement) {
  const svg = layer.querySelector<SVGSVGElement>(":scope > .timer-sub-svg");
  if (!svg) return;
  const specs: any[] = (layer as any).__arrowSpecs ?? [];
  if (!Array.isArray(specs) || specs.length === 0) {
    svg.replaceChildren();
    return;
  }

  const cachedW = Number(timerEl.dataset.timerWpx ?? "0");
  const cachedH = Number(timerEl.dataset.timerHpx ?? "0");
  if (!(cachedW > 1 && cachedH > 1)) return;
  const w = cachedW;
  const h = cachedH;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const timerId = layer.dataset.timerId ?? "timer";
  const selectedArrowId = String((layer as any).dataset?.selectedPlotArrowId ?? "");

  const fr = PLOT_FRACS;
  const ox = fr.leftF * w;
  const oy = fr.bottomF * h;
  const xLen = (fr.rightF - fr.leftF) * w;
  const yLen = (fr.bottomF - fr.topF) * h;
  const mapX = (u: number) => ox + u * xLen;
  const mapY = (vUp: number) => oy - vUp * yLen;
  const dataMin = Math.max(1, Math.min(xLen, yLen));

  for (const a of specs) {
    const relW = typeof a.width === "number" && isFinite(a.width) ? a.width : 0.006;
    const lwPx = Math.max(0.5, Math.min(16, relW * dataMin));
    const headWPx = 3 * lwPx;
    const headLPx = 5 * lwPx;

    const x1 = mapX(Number(a.x0 ?? 0));
    const y1 = mapY(Number(a.y0 ?? 0));
    const x2 = mapX(Number(a.x1 ?? 1));
    const y2 = mapY(Number(a.y1 ?? 1));

    const plotGroup = (layer as any).__plotGroup as HTMLElement | null;
    const hit = (plotGroup ?? layer).querySelector<HTMLElement>(`:scope > .timer-sub-arrow-hit[data-arrow-id="${String(a.id ?? "")}"]`);
    if (hit) {
      const padPx = 24;
      const minX = Math.min(x1, x2) - padPx;
      const maxX = Math.max(x1, x2) + padPx;
      const minY = Math.min(y1, y2) - padPx;
      const maxY = Math.max(y1, y2) + padPx;
      hit.style.left = `${((minX - ox) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.top = `${((minY - (oy - yLen)) / Math.max(1e-9, yLen)) * 100}%`;
      hit.style.width = `${((maxX - minX) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.height = `${((maxY - minY) / Math.max(1e-9, yLen)) * 100}%`;
    }

    const markerId = `arrowhead-${timerId}-${a.id}`;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("markerWidth", String(headLPx));
    marker.setAttribute("markerHeight", String(headWPx));
    marker.setAttribute("refX", "0");
    marker.setAttribute("refY", String(headWPx / 2));
    marker.setAttribute("orient", "auto");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M0,0 L${headLPx},${headWPx / 2} L0,${headWPx} Z`);
    path.setAttribute("fill", a.color ?? "white");
    marker.append(path);
    defs.append(marker);

    const isSelected = selectedArrowId && String(a.id ?? "") === selectedArrowId;
    if (isSelected) {
      const glow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      glow.setAttribute("x1", String(x1));
      glow.setAttribute("y1", String(y1));
      glow.setAttribute("x2", String(x2));
      glow.setAttribute("y2", String(y2));
      glow.setAttribute("stroke", "rgba(110,168,255,0.95)");
      glow.setAttribute("stroke-width", String(Math.min(48, lwPx + 10)));
      glow.setAttribute("stroke-linecap", "round");
      g.append(glow);
    }

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", a.color ?? "white");
    line.setAttribute("stroke-width", String(lwPx));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", `url(#${markerId})`);
    g.append(line);
  }

  svg.replaceChildren(defs, g);
}

export function syncTimerPlotRegion(timerEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const pg = (geoms["plot"] ??= { x: PLOT_FRACS.leftF, y: PLOT_FRACS.topF, w: PLOT_FRACS.rightF - PLOT_FRACS.leftF, h: PLOT_FRACS.bottomF - PLOT_FRACS.topF, rotationDeg: 0, anchor: "topLeft", align: "left" });
  const ptl = anchorToTopLeftFrac({ x: Number(pg.x), y: Number(pg.y), w: Number(pg.w), h: Number(pg.h), anchor: String(pg.anchor ?? "topLeft") });
  const leftF = ptl.x;
  const topF = ptl.y;
  const rightF = leftF + Number(pg.w);
  const bottomF = topF + Number(pg.h);
  timerEl.dataset.plotLeftF = String(leftF);
  timerEl.dataset.plotRightF = String(rightF);
  timerEl.dataset.plotTopF = String(topF);
  timerEl.dataset.plotBottomF = String(bottomF);
  const plotGroup = (layer as any).__plotGroup as HTMLElement | null;
  if (plotGroup) {
    plotGroup.style.left = `${leftF * 100}%`;
    plotGroup.style.top = `${topF * 100}%`;
    plotGroup.style.width = `${Number(pg.w) * 100}%`;
    plotGroup.style.height = `${Number(pg.h) * 100}%`;
  }
}

