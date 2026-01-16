import type { Engine } from "@interactive/engine";
import { anchorToTopLeftFrac } from "../../../utils/geom";
import { parseInlineParams } from "../../../utils/params";
import { applyDataBindings } from "../../../utils/template";
import { renderTextWithKatexToHtml } from "../../../utils/textMath";

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };

const normalizeAnchor = (a: string) => {
  const s = String(a || "centerCenter");
  if (s === "top") return "topCenter";
  if (s === "bottom") return "bottomCenter";
  if (s === "left") return "centerLeft";
  if (s === "right") return "centerRight";
  if (s === "center") return "centerCenter";
  return s;
};

const cssTranslateForAnchor = (anchor: string) => {
  switch (String(anchor || "centerCenter")) {
    case "topLeft":
      return "translate(0%, 0%)";
    case "topCenter":
      return "translate(-50%, 0%)";
    case "topRight":
      return "translate(-100%, 0%)";
    case "centerLeft":
      return "translate(0%, -50%)";
    case "center":
    case "centerCenter":
      return "translate(-50%, -50%)";
    case "centerRight":
      return "translate(-100%, -50%)";
    case "bottomLeft":
      return "translate(0%, -100%)";
    case "bottomCenter":
      return "translate(-50%, -100%)";
    case "bottomRight":
      return "translate(-100%, -100%)";
    default:
      return "translate(-50%, -50%)";
  }
};

const cssTransformOriginForAnchor = (anchor: string) => {
  switch (String(anchor || "centerCenter")) {
    case "topLeft":
      return "0% 0%";
    case "topCenter":
      return "50% 0%";
    case "topRight":
      return "100% 0%";
    case "centerLeft":
      return "0% 50%";
    case "center":
    case "centerCenter":
      return "50% 50%";
    case "centerRight":
      return "100% 50%";
    case "bottomLeft":
      return "0% 100%";
    case "bottomCenter":
      return "50% 100%";
    case "bottomRight":
      return "100% 100%";
    default:
      return "50% 50%";
  }
};

const applyGeomTransformCss = (el: HTMLElement, g: any) => {
  const anchor = normalizeAnchor(String(g?.anchor ?? el.dataset.anchor ?? "centerCenter"));
  const rot = Number(g?.rotationDeg ?? el.dataset.rotationDeg ?? 0) || 0;
  el.dataset.anchor = anchor;
  el.dataset.rotationDeg = String(rot);
  el.style.transformOrigin = cssTransformOriginForAnchor(anchor);
  // Single transform to avoid translate being rotated.
  el.style.transform = `${cssTranslateForAnchor(anchor)} rotate(${rot}deg)`;
};

function plotFracsForEl(el: HTMLElement) {
  const l = Number(el.dataset.plotLeftF ?? "");
  const r = Number(el.dataset.plotRightF ?? "");
  const t = Number(el.dataset.plotTopF ?? "");
  const b = Number(el.dataset.plotBottomF ?? "");
  if ([l, r, t, b].every((v) => Number.isFinite(v))) return { leftF: l, rightF: r, topF: t, bottomF: b };
  return PLOT_FRACS;
}

export function ensureGraphCompositeLayer(engine: Engine, graphId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === graphId) as any;
  const el = engine.getNodeElement(graphId);
  if (!node || !el) return null;

  const frame = el.querySelector<HTMLElement>(":scope > .timer-frame") ?? el;
  // Axis arrows extend slightly outside the plot region; ensure they are not clipped.
  frame.style.overflow = "visible";
  let layer = frame.querySelector<HTMLElement>(":scope > .graph-sub-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "graph-sub-layer";
    layer.dataset.graphId = graphId;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "3";
    frame.appendChild(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("graph-sub-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);

    const plotGroup = document.createElement("div");
    plotGroup.className = "graph-sub comp-sub comp-group graph-sub-plotgroup";
    plotGroup.dataset.subId = "plot";
    plotGroup.dataset.compPath = graphId;
    plotGroup.dataset.groupPath = `${graphId}/plot`;
    plotGroup.style.position = "absolute";
    plotGroup.style.pointerEvents = "none";
    plotGroup.style.overflow = "visible";
    plotGroup.style.zIndex = "10";
    plotGroup.style.background = "transparent";
    layer.append(plotGroup);
    (layer as any).__plotGroup = plotGroup;

    const mkArrowHit = (arrowId: string) => {
      const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer!;
      const h = document.createElement("div");
      h.className = "graph-sub graph-sub-arrow-hit comp-sub";
      h.dataset.subId = arrowId;
      h.dataset.compPath = graphId;
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
        d.className = "graph-sub graph-sub-text comp-sub";
        d.dataset.subId = sid;
        d.dataset.compPath = graphId;
        d.dataset.template = content;
        d.dataset.anchor = String(g.anchor ?? "centerCenter");
        const contentEl = document.createElement("div");
        contentEl.className = "graph-sub-content";
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
        applyGeomTransformCss(d, g);
        d.style.padding = "0";
        d.style.borderRadius = "0";
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
        layer.append(d);
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

    // Default axis arrows (selectable/editable via plot-arrow hitboxes).
    // Origin is (0,0) in plot coords (bottom-left).
    const ensureAxis = (id: "x_axis" | "y_axis", def: { x0: number; y0: number; x1: number; y1: number }) => {
      const existing = arrowSpecs.find((a) => String(a.id) === id);
      if (existing) return;
      arrowSpecs.push({ id, ...def, color: "white", width: 0.006 });
    };
    ensureAxis("x_axis", { x0: 0, y0: 0, x1: 1, y1: 0 });
    ensureAxis("y_axis", { x0: 0, y0: 0, x1: 0, y1: 1 });

    (layer as any).__arrowSpecs = arrowSpecs;
    (layer as any).__textGeoms = geoms;

    // Sync plot region geom -> plot fracs + plotGroup box
    const pg = geoms["plot"];
    const ptl = anchorToTopLeftFrac({ x: Number(pg.x), y: Number(pg.y), w: Number(pg.w), h: Number(pg.h), anchor: String(pg.anchor ?? "topLeft") });
    const leftF = ptl.x;
    const topF = ptl.y;
    const rightF = leftF + Number(pg.w);
    const bottomF = topF + Number(pg.h);
    el.dataset.plotLeftF = String(leftF);
    el.dataset.plotRightF = String(rightF);
    el.dataset.plotTopF = String(topF);
    el.dataset.plotBottomF = String(bottomF);
    plotGroup.style.left = `${leftF * 100}%`;
    plotGroup.style.top = `${topF * 100}%`;
    plotGroup.style.width = `${Number(pg.w) * 100}%`;
    plotGroup.style.height = `${Number(pg.h) * 100}%`;
    plotGroup.dataset.anchor = "topLeft";
    plotGroup.style.transform = "translate(0%, 0%)";
  }
  return layer;
}

export function layoutGraphCompositeTexts(graphEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .graph-sub-text"));
  const hPx = Number(graphEl.dataset.graphHpx ?? "0");
  const wPx = Number(graphEl.dataset.graphWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : graphEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.1);
    const fontPx = Math.max(1, box.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
  }
}

export function renderGraphCompositeTexts(graphEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .graph-sub-text"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "graph" && compositeId === String(graphEl.dataset.nodeId ?? "");
  const appMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  const interactive = appMode === "edit" && isGroupEditing;

  const hPx = Number(graphEl.dataset.graphHpx ?? "0");
  const wPx = Number(graphEl.dataset.graphWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : graphEl.getBoundingClientRect();

  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const x = Number(g.x ?? 0.5);
    const y = Number(g.y ?? 0.5);
    const w = Number(g.w ?? 0.4);
    const h = Number(g.h ?? 0.1);
    if (!interactive) {
      // In composite edit, geometry is controlled by the editor; don't overwrite it here.
      t.style.left = `${x * 100}%`;
      t.style.top = `${y * 100}%`;
      t.style.width = `${w * 100}%`;
      t.style.height = `${h * 100}%`;
      applyGeomTransformCss(t, g);
      t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
    }

    const fontPx = Math.max(1, box.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;

    const tpl = t.dataset.template ?? "";
    const resolved = applyDataBindings(tpl, data);
    const prev = t.dataset.rawText ?? "";
    if (prev !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope .graph-sub-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    t.style.pointerEvents = interactive ? "auto" : "none";
    t.style.cursor = interactive ? "grab" : "default";
  }
}

export function renderGraphCompositeArrows(graphEl: HTMLElement, layer: HTMLElement) {
  void graphEl;
  void layer;
  // Deprecated: axis arrows must be real `arrow` nodes (engine-drawn), not SVG overlays.
}

