import type { Engine } from "@interactive/engine";

type CompositeEditKind = "timer" | "sound" | "choices" | "graph" | null;

export function createSelectionController(opts: {
  stage: HTMLElement;
  engine: Engine;
  selected: Set<string>;
  getAppMode: () => "edit" | "live";
  getCompositeEditState: () => { kind: CompositeEditKind; id: string | null };
  ensureHandles: (el: HTMLElement) => void;
  effectiveNodeRectClient: (nodeEl: HTMLElement, node: any) => { left: number; top: number; width: number; height: number } | null;
}) {
  let compositeSelBoxEl: HTMLDivElement | null = null;
  let compositeOverlayRaf: number | null = null;
  let lineGraphSelBoxes = new Map<string, HTMLDivElement>();
  let lineGraphOverlayRaf: number | null = null;
  let vertexRingSvg: SVGSVGElement | null = null;
  let vertexRing: SVGCircleElement | null = null;

  // Intentionally no logging (keeps editor responsive).
  const dbg = (_event: string, _data: any) => {};

  const ensureCompositeSelBoxEl = () => {
    if (compositeSelBoxEl) return compositeSelBoxEl;
    const d = document.createElement("div");
    d.className = "ip-composite-selection";
    d.style.position = "fixed";
    d.style.pointerEvents = "none";
    d.style.zIndex = "99997";
    d.style.display = "none";
    d.style.border = "2px solid rgba(110,168,255,0.65)";
    d.style.borderRadius = "6px";
    d.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.35)";
    d.style.transformOrigin = "50% 50%";
    // IMPORTANT: `position: fixed` inside a transformed ancestor behaves like `absolute`
    // (and can end up offscreen/invisible). The stage is frequently transformed for pan/zoom,
    // so mount this overlay on `document.body` to keep it truly viewport-fixed.
    document.body.appendChild(d);
    compositeSelBoxEl = d;
    return d;
  };

  const ensureLineGraphSelBoxEl = (seedId: string) => {
    const key = String(seedId ?? "");
    if (!key) return null;
    const existing = lineGraphSelBoxes.get(key);
    if (existing) return existing;
    const d = document.createElement("div");
    d.className = "ip-linegraph-selection";
    d.style.position = "fixed";
    d.style.pointerEvents = "auto"; // must be interactive (handles)
    d.style.zIndex = "99997";
    d.style.display = "none";
    d.style.border = "2px solid rgba(110,168,255,0.65)";
    d.style.borderRadius = "6px";
    d.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.35)";
    d.style.transformOrigin = "50% 50%";
    d.dataset.seedId = key;
    // Same reasoning as composite overlay: keep truly viewport-fixed.
    document.body.appendChild(d);
    lineGraphSelBoxes.set(key, d);
    return d;
  };

  const hideCompositeSelBox = () => {
    if (!compositeSelBoxEl) return;
    compositeSelBoxEl.style.display = "none";
  };

  const hideLineGraphSelBoxes = () => {
    for (const el of lineGraphSelBoxes.values()) el.style.display = "none";
  };

  const stopLineGraphSelectionBoxRaf = () => {
    if (lineGraphOverlayRaf == null) return;
    window.cancelAnimationFrame(lineGraphOverlayRaf);
    lineGraphOverlayRaf = null;
  };

  const ensureVertexRing = () => {
    if (vertexRingSvg && vertexRing) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ip-linegraph-vertex-ring");
    svg.style.position = "fixed";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "99998";
    svg.style.display = "none";
    svg.setAttribute("preserveAspectRatio", "none");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "0");
    c.setAttribute("cy", "0");
    c.setAttribute("r", "10");
    c.setAttribute("fill", "rgba(0,0,0,0)");
    c.setAttribute("stroke", "rgba(110,168,255,0.92)");
    c.setAttribute("stroke-width", "2");
    c.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(c);
    document.body.appendChild(svg);
    vertexRingSvg = svg;
    vertexRing = c;
  };

  const hideVertexRing = () => {
    if (!vertexRingSvg) return;
    vertexRingSvg.style.display = "none";
  };

  const refreshVertexRingOnce = () => {
    if (!vertexRingSvg || !vertexRing) return;
    const mode = String(opts.stage.dataset.lineGraphMode ?? "");
    const which = String(opts.stage.dataset.lineGraphVertexWhich ?? "");
    const id = String(opts.stage.dataset.lineGraphVertexLineId ?? "");
    if (mode !== "vertex" || !id || opts.selected.size !== 1 || !opts.selected.has(id)) {
      vertexRingSvg.style.display = "none";
      return;
    }
    const model = opts.engine.getModel();
    const node: any = model?.nodes?.find?.((n: any) => String(n.id) === id);
    const el = opts.engine.getNodeElement(id);
    if (!node || !el || String(node.type) !== "line") {
      vertexRingSvg.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (!(r.width > 0.5 && r.height > 0.5)) {
      vertexRingSvg.style.display = "none";
      return;
    }
    const fr = (node as any).from ?? { x: 0, y: 0.5 };
    const to = (node as any).to ?? { x: 1, y: 0.5 };
    const p1 = { x: r.left + Number(fr.x ?? 0) * r.width, y: r.top + Number(fr.y ?? 0.5) * r.height };
    const p2 = { x: r.left + Number(to.x ?? 1) * r.width, y: r.top + Number(to.y ?? 0.5) * r.height };
    const p = which === "p2" ? p2 : p1;
    vertexRingSvg.style.display = "block";
    vertexRingSvg.setAttribute("viewBox", `0 0 ${Math.max(1, window.innerWidth)} ${Math.max(1, window.innerHeight)}`);
    vertexRing.setAttribute("cx", String(p.x));
    vertexRing.setAttribute("cy", String(p.y));
  };

  const refreshCompositeSelectionBoxOnce = () => {
    if (!compositeSelBoxEl) return;
    const { kind, id: compositeEditId } = opts.getCompositeEditState();
    if (compositeEditId) return;
    if (opts.getAppMode() !== "edit") return;
    if (opts.selected.size !== 1) return;
    const model = opts.engine.getModel();
    if (!model) return;
    const id = Array.from(opts.selected)[0];
    const node: any = model.nodes.find((n: any) => String(n.id) === String(id));
    if (!node || (node.type !== "timer" && node.type !== "sound" && node.type !== "graph")) return;
    if (kind && kind !== "choices") {
      // When in composite edit, selection box is hidden anyway.
    }
    const el = opts.engine.getNodeElement(String(id));
    if (!el) return;
    const eff = opts.effectiveNodeRectClient(el, node);
    if (!eff || !(eff.width > 2 && eff.height > 2)) return;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    compositeSelBoxEl.style.display = "block";
    compositeSelBoxEl.style.left = `${eff.left}px`;
    compositeSelBoxEl.style.top = `${eff.top}px`;
    compositeSelBoxEl.style.width = `${eff.width}px`;
    compositeSelBoxEl.style.height = `${eff.height}px`;
    compositeSelBoxEl.style.transform = `rotate(${rotDeg}deg)`;
    compositeSelBoxEl.dataset.anchor = String((node as any)?.transform?.anchor ?? "centerCenter");
    opts.ensureHandles(compositeSelBoxEl);
  };

  const collectConnectedLineIdsByProximity = (seedId: string, model: any, space: string, parentId: string) => {
    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;
    const cell = tolPx;
    const keyFor = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const buckets = new Map<string, Array<{ id: string; x: number; y: number }>>();
    const endpointsById = new Map<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>();
    const lineIds: string[] = [];

    const put = (id: string, p: { x: number; y: number }) => {
      const k = keyFor(p.x, p.y);
      const arr = buckets.get(k) ?? [];
      arr.push({ id, x: p.x, y: p.y });
      buckets.set(k, arr);
    };

    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any).parentId ?? "").trim();
      if (pid !== String(parentId ?? "").trim()) continue;
      const id = String(n0.id ?? "");
      if (!id) continue;
      const el = opts.engine.getNodeElement(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0.5 && r.height > 0.5)) continue;
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
      const p1 = { x: r.left + Number(fr.x ?? 0) * r.width, y: r.top + Number(fr.y ?? 0.5) * r.height };
      const p2 = { x: r.left + Number(to.x ?? 1) * r.width, y: r.top + Number(to.y ?? 0.5) * r.height };
      endpointsById.set(id, { p1, p2 });
      lineIds.push(id);
      put(id, p1);
      put(id, p2);
    }

    if (!endpointsById.has(seedId)) return [seedId];

    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };
    const near = (a: { p1: any; p2: any }, b: { p1: any; p2: any }) => {
      return (
        dist2(a.p1, b.p1) <= tolPx2 ||
        dist2(a.p1, b.p2) <= tolPx2 ||
        dist2(a.p2, b.p1) <= tolPx2 ||
        dist2(a.p2, b.p2) <= tolPx2
      );
    };
    const neighborKeys = (p: { x: number; y: number }) => {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      const out: string[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(`${cx + dx},${cy + dy}`);
      return out;
    };

    const visited = new Set<string>();
    const q: string[] = [seedId];
    visited.add(seedId);
    while (q.length) {
      const cur = q.shift()!;
      const epCur = endpointsById.get(cur);
      if (!epCur) continue;
      const candIds = new Set<string>();
      for (const k of neighborKeys(epCur.p1)) for (const it of buckets.get(k) ?? []) candIds.add(it.id);
      for (const k of neighborKeys(epCur.p2)) for (const it of buckets.get(k) ?? []) candIds.add(it.id);
      for (const nid of candIds) {
        if (visited.has(nid)) continue;
        const epN = endpointsById.get(nid);
        if (!epN) continue;
        if (!near(epCur, epN)) continue;
        visited.add(nid);
        q.push(nid);
      }
    }
    return Array.from(visited);
  };

  const refreshLineGraphSelectionBoxesOnce = () => {
    if (!lineGraphSelBoxes.size) return;
    const { id: compositeEditId } = opts.getCompositeEditState();
    if (compositeEditId) return; // composite edit owns selection UI
    if (opts.getAppMode() !== "edit") return;
    if (String(opts.stage.dataset.lineGraphMode ?? "") === "vertex") return; // vertex mode: no bbox
    const model = opts.engine.getModel();
    if (!model) return;
    for (const [seedId, box] of lineGraphSelBoxes.entries()) {
      const seed: any = model.nodes.find((n: any) => String(n.id) === String(seedId));
      if (!seed || seed.type !== "line") {
        box.style.display = "none";
        continue;
      }
      const space = String(seed.space ?? "world");
      const parentId = String((seed as any).parentId ?? "").trim();
      const ids = collectConnectedLineIdsByProximity(String(seedId), model as any, space, parentId);
      // Single, unconnected line: no graph bbox (behave like arrow: glow only).
      if ((ids?.length ?? 0) <= 1) {
        box.style.display = "none";
        continue;
      }

      // Union client rects of all line nodes in the component.
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      let any = false;
      for (const id of ids) {
        const el = opts.engine.getNodeElement(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0.5 && r.height > 0.5)) continue;
        any = true;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      }
      if (!any) {
        box.style.display = "none";
        continue;
      }
      const w = Math.max(1, right - left);
      const h = Math.max(1, bottom - top);

      box.style.display = "block";
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      // Rotation for graph components is managed by the editor transform interaction; default 0.
      box.style.transform = `rotate(${Number(box.dataset.rotationDeg ?? "0") || 0}deg)`;
      box.dataset.anchor = String(box.dataset.anchor ?? "centerCenter");
      box.dataset.seedId = String(seedId);
      box.dataset.space = space;
      box.dataset.parentId = parentId;
      opts.ensureHandles(box);
    }
  };

  const startCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf != null) return;
    const loop = () => {
      compositeOverlayRaf = window.requestAnimationFrame(loop);
      if (!compositeSelBoxEl || compositeSelBoxEl.style.display === "none") return;
      refreshCompositeSelectionBoxOnce();
    };
    compositeOverlayRaf = window.requestAnimationFrame(loop);
  };

  const startLineGraphSelectionBoxRaf = () => {
    if (lineGraphOverlayRaf != null) return;
    const loop = () => {
      lineGraphOverlayRaf = window.requestAnimationFrame(loop);
      let anyVisible = false;
      for (const el of lineGraphSelBoxes.values()) {
        if (el.style.display !== "none") {
          anyVisible = true;
          break;
        }
      }
      if (!anyVisible) return;
      refreshLineGraphSelectionBoxesOnce();
    };
    lineGraphOverlayRaf = window.requestAnimationFrame(loop);
  };

  const stopCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf == null) return;
    window.cancelAnimationFrame(compositeOverlayRaf);
    compositeOverlayRaf = null;
  };

  window.addEventListener("resize", () => {
    refreshCompositeSelectionBoxOnce();
    refreshLineGraphSelectionBoxesOnce();
  });

  const applySelection = () => {
    const model = opts.engine.getModel();
    if (!model) {
      dbg("applySelection:skip", { reason: "no-model" });
      return;
    }
    const canShowTransformUi = opts.getAppMode() === "edit";
    const { kind: compositeEditKind, id: compositeEditTimerId } = opts.getCompositeEditState();
    dbg("applySelection:begin", {
      appMode: opts.getAppMode(),
      canShowTransformUi,
      selected: Array.from(opts.selected),
      selectedSize: opts.selected.size,
      compositeEdit: { kind: compositeEditKind, id: compositeEditTimerId },
    });
    hideCompositeSelBox();
    stopCompositeSelectionBoxRaf();
    hideLineGraphSelBoxes();
    stopLineGraphSelectionBoxRaf();
    hideVertexRing();
    // Drop any stale line graph boxes; we'll recreate those needed for the current selection.
    // (Avoids weird leftovers when selection changes from one component to another.)
    for (const el of lineGraphSelBoxes.values()) el.remove();
    lineGraphSelBoxes.clear();
    for (const n of model.nodes) {
      const el = opts.engine.getNodeElement(n.id);
      if (!el) continue;
      el.style.outline = "";
      el.style.outlineOffset = "";
      const isSel = canShowTransformUi && opts.selected.has(n.id);
      if (!canShowTransformUi) {
        el.querySelector(".handles")?.remove();
        continue;
      }
      // Always mark selection (multi-select must be visible).
      el.classList.toggle("is-selected", isSel);

      if (isSel && opts.selected.size === 1) {
        if ((compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph") && compositeEditTimerId && n.id === compositeEditTimerId) {
          dbg("selected:skip-handles", { id: n.id, type: (n as any)?.type, reason: "composite-root-while-composite-editing" });
          el.classList.toggle("is-selected", true);
          el.querySelector(".handles")?.remove();
        } else {
          if (n.type === "line") {
            // Lines: only show a graph-component bounding box if this line is part of a connected component (>1).
            const box = ensureLineGraphSelBoxEl(String(n.id));
            if (box) {
              box.dataset.anchor = "centerCenter";
              refreshLineGraphSelectionBoxesOnce();
              startLineGraphSelectionBoxRaf();
            }
            // Do NOT show per-line handles.
            el.querySelector(".handles")?.remove();
          } else if (n.type === "timer" || n.type === "sound" || n.type === "graph") {
            const eff = opts.effectiveNodeRectClient(el, n);
            if (eff && eff.width > 2 && eff.height > 2) {
              dbg("selected:composite-box", { id: n.id, type: n.type, eff, rotationDeg: Number((n as any)?.transform?.rotationDeg ?? 0) || 0 });
              const box = ensureCompositeSelBoxEl();
              box.style.display = "block";
              box.style.left = `${eff.left}px`;
              box.style.top = `${eff.top}px`;
              box.style.width = `${eff.width}px`;
              box.style.height = `${eff.height}px`;
              const rotDeg = Number((n as any)?.transform?.rotationDeg ?? 0) || 0;
              box.style.transform = `rotate(${rotDeg}deg)`;
              box.dataset.anchor = String((n as any)?.transform?.anchor ?? "centerCenter");
              // Composite selection uses the overlay box; do NOT also outline the node itself
              // (otherwise you get a "ghost" box that doesn't correspond to visible content).
              el.classList.toggle("is-selected", false);
              el.style.outline = "none";
              el.querySelector(".handles")?.remove();
              opts.ensureHandles(box);
              startCompositeSelectionBoxRaf();
            } else {
              dbg("selected:skip-composite-box", {
                id: n.id,
                type: n.type,
                reason: !eff ? "no-effective-rect" : "effective-rect-too-small",
                eff,
              });
              el.classList.toggle("is-selected", true);
            }
          } else {
            dbg("selected:ensureHandles", { id: n.id, type: (n as any)?.type });
            el.classList.toggle("is-selected", true);
            opts.ensureHandles(el);
          }
        }
      }
      if (!isSel || opts.selected.size !== 1) el.querySelector(".handles")?.remove();
    }

    // Multi-select line graphs:
    // render one bbox per disconnected component (only for components with >1 lines).
    if (canShowTransformUi && opts.selected.size > 1 && !compositeEditKind && !compositeEditTimerId) {
      const selectedLineIds = Array.from(opts.selected);
      const lineNodes: any[] = selectedLineIds
        .map((id) => model.nodes.find((n: any) => String(n.id) === String(id)))
        .filter((n: any) => n && String(n.type) === "line");

      const visited = new Set<string>();
      for (const n0 of lineNodes) {
        const seedId = String(n0.id);
        if (visited.has(seedId)) continue;
        const space = String(n0.space ?? "world");
        const parentId = String((n0 as any).parentId ?? "").trim();
        const ids = collectConnectedLineIdsByProximity(seedId, model as any, space, parentId);
        for (const id of ids) visited.add(id);
        if ((ids?.length ?? 0) <= 1) continue; // single line -> no bbox
        const box = ensureLineGraphSelBoxEl(seedId);
        if (box) {
          box.dataset.anchor = "centerCenter";
        }
      }
      if (lineGraphSelBoxes.size) {
        refreshLineGraphSelectionBoxesOnce();
        startLineGraphSelectionBoxRaf();
      }
    }

    // Vertex mode ring (single line endpoint drag).
    ensureVertexRing();
    refreshVertexRingOnce();
    dbg("applySelection:end", {
      compositeBoxVisible: compositeSelBoxEl ? compositeSelBoxEl.style.display : "n/a",
    });
  };

  const clearSelection = () => {
    opts.selected.clear();
    applySelection();
    for (const el of Array.from(opts.stage.querySelectorAll<HTMLElement>(".comp-sub.is-selected, .timer-sub.is-selected"))) {
      el.classList.remove("is-selected");
      el.querySelector(".handles")?.remove();
    }
  };

  return {
    applySelection,
    clearSelection,
    hideCompositeSelBox,
    refreshCompositeSelectionBoxOnce,
    startCompositeSelectionBoxRaf,
    stopCompositeSelectionBoxRaf,
  };
}

