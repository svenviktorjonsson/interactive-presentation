import type { Engine } from "@interactive/engine";

export type CompositeKind = "timer" | "sound" | "choices" | "graph";

export type CompositeRect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

function localPtForRect(rect: { left: number; top: number; width: number; height: number }, rotDeg: number, clientX: number, clientY: number) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const a = (-rotDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return { lx, ly, hw: rect.width / 2, hh: rect.height / 2 };
}

function isPointInRotatedRectClient(
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  rotDeg: number,
  clientX: number,
  clientY: number
) {
  const { lx, ly, hw, hh } = localPtForRect(rect, rotDeg, clientX, clientY);
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

function collectCompositeRectsClient(type: "timer" | "sound" | "graph", nodeEl: HTMLElement, layer: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  // For graphs, the visible "content" is primarily the composite sub-elements (plot + labels).
  // The node element itself can be a larger invisible container, which creates a confusing "ghost" selection box.
  if (type !== "graph") rects.push(nodeEl.getBoundingClientRect());

  for (const sub of Array.from(layer.querySelectorAll<HTMLElement>(".comp-sub"))) {
    const subId = String(sub.dataset.subId ?? "");
    const kind = String(sub.dataset.kind ?? "");
    if (
      kind === "plot-region" ||
      // In timer/sound, the plot region is an internal helper; don't let it define the outer bbox.
      // In graph, the plot group *is* the main visible content and SHOULD be included.
      (type !== "graph" && subId === "plot") ||
      (type === "timer" && sub.classList.contains("timer-sub-plot")) ||
      (type === "sound" && sub.classList.contains("sound-sub-plot")) ||
      // Graph axis arrow hitboxes are invisible and should not affect the visible outer selection box.
      (type === "graph" && kind === "plot-arrow")
    ) {
      continue;
    }
    const sr = sub.getBoundingClientRect();
    if (!(sr.width > 0.5 && sr.height > 0.5)) continue;
    rects.push(sr);
    for (const btn of Array.from(sub.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const br = btn.getBoundingClientRect();
      if (!(br.width > 0.5 && br.height > 0.5)) continue;
      rects.push(br);
    }
  }

  if (type === "timer" || type === "sound") {
    const headerSel = type === "timer" ? ".timer-header" : ".sound-header";
    const headerEl = nodeEl.querySelector<HTMLElement>(headerSel);
    if (headerEl) {
      const hr = headerEl.getBoundingClientRect();
      if (hr.width > 0.5 && hr.height > 0.5) rects.push(hr);
      for (const btn of Array.from(headerEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
        const br = btn.getBoundingClientRect();
        if (!(br.width > 0.5 && br.height > 0.5)) continue;
        rects.push(br);
      }
    }
  }

  for (const btn of Array.from(nodeEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
    const br = btn.getBoundingClientRect();
    if (!(br.width > 0.5 && br.height > 0.5)) continue;
    rects.push(br);
  }

  return rects;
}

function orientedUnionRectClient(nodeEl: HTMLElement, rotDeg: number, rects: DOMRect[]) {
  const rr = nodeEl.getBoundingClientRect();
  const cx0 = rr.left + rr.width / 2;
  const cy0 = rr.top + rr.height / 2;
  const a = (-rotDeg * Math.PI) / 180; // client -> local
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const addPt = (x: number, y: number) => {
    const dx = x - cx0;
    const dy = y - cy0;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    minX = Math.min(minX, lx);
    minY = Math.min(minY, ly);
    maxX = Math.max(maxX, lx);
    maxY = Math.max(maxY, ly);
  };

  for (const r of rects) {
    addPt(r.left, r.top);
    addPt(r.right, r.top);
    addPt(r.right, r.bottom);
    addPt(r.left, r.bottom);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { left: rr.left, top: rr.top, width: rr.width, height: rr.height, right: rr.right, bottom: rr.bottom };
  }

  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const cxl = (minX + maxX) / 2;
  const cyl = (minY + maxY) / 2;

  const af = (rotDeg * Math.PI) / 180;
  const cosf = Math.cos(af);
  const sinf = Math.sin(af);
  const dcx = cxl * cosf - cyl * sinf;
  const dcy = cxl * sinf + cyl * cosf;
  const cx = cx0 + dcx;
  const cy = cy0 + dcy;

  const left = cx - w / 2;
  const top = cy - h / 2;
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}

export function createCompositeHitTest(opts: {
  engine: Engine;
  ensureTimerCompositeLayer: (engine: Engine, id: string) => HTMLElement | null;
  ensureSoundCompositeLayer: (engine: Engine, id: string) => HTMLElement | null;
  ensureGraphCompositeLayer: (engine: Engine, id: string) => HTMLElement | null;
}) {
  const effectiveNodeRectClient = (nodeEl: HTMLElement, node: any) => {
    const type = String(node?.type ?? "");
    if (type !== "timer" && type !== "sound" && type !== "graph") return null;
    const rootId = String(node?.id ?? nodeEl.dataset.nodeId ?? "");
    if (!rootId) return null;
    const layer =
      type === "timer"
        ? opts.ensureTimerCompositeLayer(opts.engine, rootId)
        : type === "sound"
          ? opts.ensureSoundCompositeLayer(opts.engine, rootId)
          : opts.ensureGraphCompositeLayer(opts.engine, rootId);
    if (!layer) return null;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const rects = collectCompositeRectsClient(type as any, nodeEl, layer);
    const u = orientedUnionRectClient(nodeEl, rotDeg, rects);
    return { ...u, layer };
  };

  const pickCompositeRootAtClientPoint = (model: any, x: number, y: number) => {
    let best: { id: string; kind: CompositeKind; area: number } | null = null;
    for (const n of model?.nodes ?? []) {
      const kind = String(n?.type ?? "");
      if (kind !== "timer" && kind !== "sound" && kind !== "choices" && kind !== "graph") continue;
      const el = opts.engine.getNodeElement(String(n.id));
      if (!el) continue;
      const rotDeg = Number(n?.transform?.rotationDeg ?? 0) || 0;
      const eff = kind === "choices" ? null : effectiveNodeRectClient(el, n);
      const r = eff ?? (el.getBoundingClientRect() as any);
      const rc: any = { left: r.left, top: r.top, right: r.right ?? r.left + r.width, bottom: r.bottom ?? r.top + r.height, width: r.width, height: r.height };
      if (!isPointInRotatedRectClient(rc, rotDeg, x, y)) continue;
      const area = Math.max(1, rc.width * rc.height);
      if (!best || area < best.area) best = { id: String(n.id), kind: kind as any, area };
    }
    return best;
  };

  return { effectiveNodeRectClient, pickCompositeRootAtClientPoint };
}

