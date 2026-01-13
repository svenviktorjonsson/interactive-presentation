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
  let lineGraphSelBoxEl: HTMLDivElement | null = null;
  let lineGraphOverlayRaf: number | null = null;

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

  const ensureLineGraphSelBoxEl = () => {
    if (lineGraphSelBoxEl) return lineGraphSelBoxEl;
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
    // Same reasoning as composite overlay: keep truly viewport-fixed.
    document.body.appendChild(d);
    lineGraphSelBoxEl = d;
    return d;
  };

  const hideCompositeSelBox = () => {
    if (!compositeSelBoxEl) return;
    compositeSelBoxEl.style.display = "none";
  };

  const hideLineGraphSelBox = () => {
    if (!lineGraphSelBoxEl) return;
    lineGraphSelBoxEl.style.display = "none";
  };

  const stopLineGraphSelectionBoxRaf = () => {
    if (lineGraphOverlayRaf == null) return;
    window.cancelAnimationFrame(lineGraphOverlayRaf);
    lineGraphOverlayRaf = null;
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

  const refreshLineGraphSelectionBoxOnce = () => {
    if (!lineGraphSelBoxEl) return;
    const { id: compositeEditId } = opts.getCompositeEditState();
    if (compositeEditId) return; // composite edit owns selection UI
    if (opts.getAppMode() !== "edit") return;
    if (opts.selected.size !== 1) return;
    const model = opts.engine.getModel();
    if (!model) return;
    const seedId = Array.from(opts.selected)[0];
    const seed: any = model.nodes.find((n: any) => String(n.id) === String(seedId));
    if (!seed || seed.type !== "line") return;

    const space = String(seed.space ?? "world");
    const parentId = String((seed as any).parentId ?? "").trim();

    // Connected component by explicit join ids (p1Join/p2Join). If no joins exist, fall back to seed only.
    const joinToLines = new Map<string, string[]>();
    const joinsByLine = new Map<string, string[]>();
    for (const n0 of model.nodes as any[]) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any).parentId ?? "").trim();
      if (pid !== parentId) continue;
      const id = String(n0.id ?? "");
      if (!id) continue;
      const j1 = String((n0 as any).p1Join ?? "").trim();
      const j2 = String((n0 as any).p2Join ?? "").trim();
      const js = [j1, j2].filter(Boolean);
      if (!js.length) continue;
      joinsByLine.set(id, js);
      for (const j of js) {
        const arr = joinToLines.get(j) ?? [];
        arr.push(id);
        joinToLines.set(j, arr);
      }
    }

    let ids: string[] = [seedId];
    if (joinsByLine.size && joinToLines.size) {
      const visited = new Set<string>();
      const q: string[] = [seedId];
      visited.add(seedId);
      while (q.length) {
        const cur = q.shift()!;
        const js = joinsByLine.get(cur) ?? [];
        for (const j of js) {
          const neigh = joinToLines.get(j) ?? [];
          for (const nid of neigh) {
            if (visited.has(nid)) continue;
            visited.add(nid);
            q.push(nid);
          }
        }
      }
      ids = Array.from(visited);
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
    if (!any) return;
    const w = Math.max(1, right - left);
    const h = Math.max(1, bottom - top);

    lineGraphSelBoxEl.style.display = "block";
    lineGraphSelBoxEl.style.left = `${left}px`;
    lineGraphSelBoxEl.style.top = `${top}px`;
    lineGraphSelBoxEl.style.width = `${w}px`;
    lineGraphSelBoxEl.style.height = `${h}px`;
    // Rotation for graph components is managed by the editor transform interaction; default 0.
    lineGraphSelBoxEl.style.transform = `rotate(${Number(lineGraphSelBoxEl.dataset.rotationDeg ?? "0") || 0}deg)`;
    lineGraphSelBoxEl.dataset.anchor = String(lineGraphSelBoxEl.dataset.anchor ?? "centerCenter");
    lineGraphSelBoxEl.dataset.seedId = String(seedId);
    lineGraphSelBoxEl.dataset.space = space;
    lineGraphSelBoxEl.dataset.parentId = parentId;
    opts.ensureHandles(lineGraphSelBoxEl);
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
      if (!lineGraphSelBoxEl || lineGraphSelBoxEl.style.display === "none") return;
      refreshLineGraphSelectionBoxOnce();
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
    refreshLineGraphSelectionBoxOnce();
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
    hideLineGraphSelBox();
    stopLineGraphSelectionBoxRaf();
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
      if (isSel && opts.selected.size === 1) {
        if ((compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph") && compositeEditTimerId && n.id === compositeEditTimerId) {
          dbg("selected:skip-handles", { id: n.id, type: (n as any)?.type, reason: "composite-root-while-composite-editing" });
          el.classList.toggle("is-selected", true);
          el.querySelector(".handles")?.remove();
        } else {
          if (n.type === "line") {
            // Lines: show a graph-component bounding box (connected by p1Join/p2Join) to allow rigid transforms.
            const box = ensureLineGraphSelBoxEl();
            box.style.display = "block";
            // Default anchor for rigid transforms.
            box.dataset.anchor = "centerCenter";
            // Refresh immediately; then keep in sync via RAF (pan/zoom changes client rects).
            refreshLineGraphSelectionBoxOnce();
            startLineGraphSelectionBoxRaf();
            // Do NOT show per-line handles.
            el.classList.toggle("is-selected", true);
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
      if (!isSel) el.classList.toggle("is-selected", false);
    }
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

