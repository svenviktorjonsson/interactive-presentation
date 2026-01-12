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
    opts.stage.appendChild(d);
    compositeSelBoxEl = d;
    return d;
  };

  const hideCompositeSelBox = () => {
    if (!compositeSelBoxEl) return;
    compositeSelBoxEl.style.display = "none";
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

  const startCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf != null) return;
    const loop = () => {
      compositeOverlayRaf = window.requestAnimationFrame(loop);
      if (!compositeSelBoxEl || compositeSelBoxEl.style.display === "none") return;
      refreshCompositeSelectionBoxOnce();
    };
    compositeOverlayRaf = window.requestAnimationFrame(loop);
  };

  const stopCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf == null) return;
    window.cancelAnimationFrame(compositeOverlayRaf);
    compositeOverlayRaf = null;
  };

  window.addEventListener("resize", () => {
    refreshCompositeSelectionBoxOnce();
  });

  const applySelection = () => {
    const model = opts.engine.getModel();
    if (!model) return;
    const canShowTransformUi = opts.getAppMode() === "edit";
    const { kind: compositeEditKind, id: compositeEditTimerId } = opts.getCompositeEditState();
    hideCompositeSelBox();
    stopCompositeSelectionBoxRaf();
    for (const n of model.nodes) {
      const el = opts.engine.getNodeElement(n.id);
      if (!el) continue;
      el.style.outline = "";
      el.style.outlineOffset = "";
      const isSel = canShowTransformUi && opts.selected.has(n.id);
      el.classList.toggle("is-selected", isSel);
      if (!canShowTransformUi) {
        el.querySelector(".handles")?.remove();
        continue;
      }
      if (isSel && opts.selected.size === 1) {
        if ((compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph") && compositeEditTimerId && n.id === compositeEditTimerId) {
          el.querySelector(".handles")?.remove();
        } else {
          if (n.type === "timer" || n.type === "sound" || n.type === "graph") {
            const eff = opts.effectiveNodeRectClient(el, n);
            if (eff && eff.width > 2 && eff.height > 2) {
              const box = ensureCompositeSelBoxEl();
              box.style.display = "block";
              box.style.left = `${eff.left}px`;
              box.style.top = `${eff.top}px`;
              box.style.width = `${eff.width}px`;
              box.style.height = `${eff.height}px`;
              const rotDeg = Number((n as any)?.transform?.rotationDeg ?? 0) || 0;
              box.style.transform = `rotate(${rotDeg}deg)`;
              box.dataset.anchor = String((n as any)?.transform?.anchor ?? "centerCenter");
              el.style.outline = "none";
              el.querySelector(".handles")?.remove();
              opts.ensureHandles(box);
              startCompositeSelectionBoxRaf();
            }
          } else {
            opts.ensureHandles(el);
          }
        }
      }
      if (!isSel || opts.selected.size !== 1) el.querySelector(".handles")?.remove();
    }
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

