import type { Engine } from "@interactive/engine";

type Tool = "select" | string;

export function createCursorController(opts: {
  stage: HTMLElement;
  engine: Engine;
  selected: Set<string>;
  getAppMode: () => "edit" | "live";
  getTool: () => Tool;
  getDragMode: () => string;
  getCompositeEditId: () => string | null;
  isScreenEditMode: () => boolean;
  activeGroupEditId: () => string | null;
  isDescendantOf: (id: string, ancestorId: string, model: any) => boolean;
  resolveSelectableId: (id: string) => string;
  uiNodeForId: (id: string, model: any) => { ui: any };
  hitTestSegmentHandle: (nodeEl: HTMLElement, clientX: number, clientY: number) => string | null;
  hitTestTransformHandleForNode: (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => string | null;
  isPointInsideNodeInteriorForNode: (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => boolean;
  cursorForHandleWithRotation: (handle: string | null, rotDeg: number) => string;
  effectiveNodeRectClient: (nodeEl: HTMLElement, node: any) => { left: number; top: number; width: number; height: number; right?: number; bottom?: number } | null;
}) {
  const localPtForRect = (rect: { left: number; top: number; width: number; height: number }, rotDeg: number, clientX: number, clientY: number) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const a = (-rotDeg * Math.PI) / 180; // inverse (screen -> local)
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return { lx, ly, hw: rect.width / 2, hh: rect.height / 2, cx, cy };
  };

  const isPointInRotatedRectClient = (
    rect: { left: number; top: number; width: number; height: number; right?: number; bottom?: number },
    rotDeg: number,
    clientX: number,
    clientY: number
  ) => {
    const { lx, ly, hw, hh } = localPtForRect(rect, rotDeg, clientX, clientY);
    return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
  };

  const pickSmallestRawNodeIdAtClientPoint = (model0: any, x: number, y: number): string | null => {
    if (!model0) return null;
    const gid = opts.activeGroupEditId();
    const els = (document.elementsFromPoint?.(x, y) ?? []) as HTMLElement[];
    let best: { id: string; size: number; order: number } | null = null;
    for (let i = 0; i < els.length; i++) {
      const e = els[i] as any;
      const nodeEl = (e?.closest?.(".node") as HTMLElement | null) ?? null;
      if (!nodeEl?.dataset?.nodeId) continue;
      const rawId = String(nodeEl.dataset.nodeId ?? "");
      if (!rawId) continue;
      if (gid) {
        if (rawId === gid) continue;
        if (!opts.isDescendantOf(rawId, gid, model0)) continue;
      }
      const n0: any = model0.nodes.find((n: any) => String(n.id) === rawId);
      if (!n0) continue;
      if (opts.isScreenEditMode()) {
        if (String(n0?.space ?? "world") !== "screen") continue;
      } else {
        if (String(n0?.space ?? "world") === "screen") continue;
      }
      const type = String(n0?.type ?? "");
      const r0 = nodeEl.getBoundingClientRect();
      if (!(r0.width > 0.5 && r0.height > 0.5)) continue;
      let size = Math.max(1e-6, r0.width * r0.height);
      if (type === "arrow" || type === "line") {
        const seg = opts.hitTestSegmentHandle(nodeEl, x, y);
        if (!seg) continue;
        const fx = Number(nodeEl.dataset.fromX ?? "0");
        const fy = Number(nodeEl.dataset.fromY ?? "0.5");
        const tx = Number(nodeEl.dataset.toX ?? "1");
        const ty = Number(nodeEl.dataset.toY ?? "0.5");
        const p1 = { x: r0.left + fx * r0.width, y: r0.top + fy * r0.height };
        const p2 = { x: r0.left + tx * r0.width, y: r0.top + ty * r0.height };
        const lenPx = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const wRaw = Number((n0 as any)?.width ?? 4);
        const cam = opts.engine.getCamera();
        const strokePx =
          wRaw <= 1
            ? Math.max(1, wRaw * Math.max(1, Math.min(r0.width, r0.height)))
            : Math.max(1, wRaw * (String((n0 as any)?.space ?? "world") === "world" ? Number(cam.zoom ?? 1) : 1));
        size = Math.max(1e-6, lenPx * strokePx);
      }
      const cand = { id: rawId, size, order: i };
      if (!best) best = cand;
      else if (cand.size < best.size - 1e-6) best = cand;
      else if (Math.abs(cand.size - best.size) <= 1e-6) {
        if (cand.order < best.order) best = cand;
      }
    }
    return best?.id ?? null;
  };

  const updateFromClientPoint = (clientX: number, clientY: number) => {
    if (opts.getAppMode() !== "edit") {
      opts.stage.style.cursor = "";
      return;
    }
    if (opts.getDragMode() !== "none") return;
    if (opts.getTool() !== "select") {
      opts.stage.style.cursor = "";
      return;
    }

    const elAt = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!elAt) {
      opts.stage.style.cursor = "";
      return;
    }
    if (elAt.closest(".edit-toolbox") || elAt.closest(".modal") || elAt.closest(".mode-toggle")) {
      opts.stage.style.cursor = "";
      return;
    }
    const anchorEl = elAt.closest<HTMLElement>(".anchor-dot");
    if (anchorEl) {
      opts.stage.style.cursor = "pointer";
      return;
    }

    if (opts.getCompositeEditId()) {
      const handleEl = elAt.closest<HTMLElement>(".handle");
      if (!handleEl) {
        const sub = elAt.closest<HTMLElement>(".comp-sub");
        const kind = String(sub?.dataset.kind ?? "");
        if (sub && kind !== "plot-region") {
          opts.stage.style.cursor = "grab";
          return;
        }
      }
    }

    const model = opts.engine.getModel();

    if (model) {
      const rawPicked = pickSmallestRawNodeIdAtClientPoint(model, clientX, clientY);
      const id = rawPicked ? opts.resolveSelectableId(rawPicked) : "";
      const nodeEl = id ? opts.engine.getNodeElement(id) : null;
      const { ui: node } = id ? opts.uiNodeForId(id, model) : { ui: null as any };
      if (node && nodeEl) {
        if (node.type === "arrow" || node.type === "line") {
          const seg = opts.hitTestSegmentHandle(nodeEl, clientX, clientY);
          opts.stage.style.cursor = seg ? "grab" : "";
          return;
        }

        if (opts.selected.size === 1 && opts.selected.has(id)) {
          const hnd = opts.hitTestTransformHandleForNode(nodeEl, node, clientX, clientY);
          if (hnd) {
            opts.stage.style.cursor = opts.cursorForHandleWithRotation(hnd, Number(node?.transform?.rotationDeg ?? 0));
            return;
          }
          opts.stage.style.cursor = opts.isPointInsideNodeInteriorForNode(nodeEl, node, clientX, clientY) ? "grab" : "";
          return;
        }

        const eff = opts.effectiveNodeRectClient(nodeEl, node);
        if (eff) {
          opts.stage.style.cursor = isPointInRotatedRectClient(eff, Number(node?.transform?.rotationDeg ?? 0), clientX, clientY) ? "grab" : "";
        } else {
          const { lx, ly, hw, hh } = localPtForRect(nodeEl.getBoundingClientRect(), Number(node?.transform?.rotationDeg ?? 0), clientX, clientY);
          opts.stage.style.cursor = Math.abs(lx) <= hw && Math.abs(ly) <= hh ? "grab" : "";
        }
        return;
      }
    }

    if (opts.selected.size === 1 && model) {
      const id = Array.from(opts.selected)[0];
      const { ui: node } = opts.uiNodeForId(id, model);
      const nodeEl = opts.engine.getNodeElement(id);
      if (node && nodeEl) {
        if (node.type === "arrow" || node.type === "line") {
          const seg = opts.hitTestSegmentHandle(nodeEl, clientX, clientY);
          opts.stage.style.cursor = seg ? "grab" : "";
          return;
        }
        const hnd = opts.hitTestTransformHandleForNode(nodeEl, node, clientX, clientY);
        if (hnd) {
          opts.stage.style.cursor = opts.cursorForHandleWithRotation(hnd, Number(node?.transform?.rotationDeg ?? 0));
          return;
        }
        const eff = opts.effectiveNodeRectClient(nodeEl, node);
        if (eff) {
          opts.stage.style.cursor = isPointInRotatedRectClient(eff, Number(node?.transform?.rotationDeg ?? 0), clientX, clientY) ? "grab" : "";
          return;
        }
        opts.stage.style.cursor = "";
        return;
      }
    }

    opts.stage.style.cursor = "";
  };

  return { updateFromClientPoint };
}

