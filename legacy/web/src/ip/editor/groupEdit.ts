import type { Engine } from "@interactive/engine";

export function createGroupEditController(opts: {
  engine: Engine;
  stage: HTMLElement;
  getAppMode: () => "edit" | "live";
  isDescendantOf: (id: string, ancestorId: string, model: any) => boolean;
  clearSelection: () => void;
  exitScreenEdit: () => void;
  exitCompositeEdit: () => void;
  updateStageCursorFromClientPoint: (clientX: number, clientY: number) => void;
  onGroupEditIdChanged?: (activeGroupId: string | null) => void;
}) {
  const groupEditStack: string[] = [];
  let groupHiddenEls: HTMLElement[] = [];
  let groupRefEl: HTMLElement | null = null;

  const activeId = () => (groupEditStack.length > 0 ? groupEditStack[groupEditStack.length - 1]! : null);

  const notify = () => {
    try {
      opts.onGroupEditIdChanged?.(activeId());
    } catch {
      // ignore
    }
  };

  const refreshHoverCursor = () => {
    const mx = (window as any).__ip_lastMouseX;
    const my = (window as any).__ip_lastMouseY;
    if (typeof mx === "number" && typeof my === "number") opts.updateStageCursorFromClientPoint(mx, my);
  };

  const applyDimming = () => {
    const model = opts.engine.getModel();
    const gid = activeId();
    for (const e of groupHiddenEls) e.classList.remove("ip-dim-node");
    groupHiddenEls = [];
    if (groupRefEl) groupRefEl.classList.remove("ip-group-ref");
    groupRefEl = null;
    if (!gid || !model) return;
    for (const n of model.nodes as any[]) {
      const id = String(n?.id ?? "");
      if (!id) continue;
      const el = opts.engine.getNodeElement(id);
      if (!el) continue;
      if (id === gid) {
        el.classList.remove("ip-dim-node");
        el.classList.add("ip-group-ref");
        groupRefEl = el;
        continue;
      }
      const inSubtree = opts.isDescendantOf(id, gid, model);
      if (inSubtree) {
        el.classList.remove("ip-dim-node");
      } else {
        el.classList.add("ip-dim-node");
        groupHiddenEls.push(el);
      }
    }
  };

  const cleanupAll = () => {
    // Hard guarantee: restore interactivity for the whole stage.
    // This MUST be safe to call even if group edit isn't currently active
    // (e.g. stale `window.__ip_exitGroupEdit` reference).
    try {
      for (const el of Array.from(opts.stage.querySelectorAll<HTMLElement>(".node.ip-dim-node"))) {
        el.classList.remove("ip-dim-node");
      }
      for (const el of Array.from(opts.stage.querySelectorAll<HTMLElement>(".node.ip-group-ref"))) {
        el.classList.remove("ip-group-ref");
      }
      // Clear any stale inline pointer-event disabling.
      for (const el of Array.from(opts.stage.querySelectorAll<HTMLElement>(".node"))) {
        if (el.style.pointerEvents === "none") el.style.pointerEvents = "";
      }
    } catch {
      // ignore
    }

    for (const e of groupHiddenEls) e.classList.remove("ip-dim-node");
    groupHiddenEls = [];
    if (groupRefEl) groupRefEl.classList.remove("ip-group-ref");
    groupRefEl = null;

    const wrap = document.querySelector<HTMLElement>(".mode-toggle");
    const mode = (wrap?.dataset.mode ?? "edit").toLowerCase();
    const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (btn) btn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
    delete (window as any).__ip_exitGroupEdit;
    notify();
  };

  const exitOneLevel = () => {
    // IMPORTANT: this must be idempotent. A stale window hook should not permanently
    // block the mode toggle button.
    if (groupEditStack.length > 0) groupEditStack.pop();
    opts.clearSelection();
    applyDimming();
    if (groupEditStack.length === 0) {
      cleanupAll();
    }
    refreshHoverCursor();
    notify();
  };

  const enter = (groupId: string) => {
    if (opts.getAppMode() !== "edit") return;
    const model = opts.engine.getModel();
    const gid = String(groupId ?? "");
    if (!gid || !model) return;
    const node: any = model.nodes.find((n: any) => String(n.id) === gid);
    if (!node || String(node.type) !== "group") return;
    opts.exitScreenEdit();
    opts.exitCompositeEdit();
    if (groupEditStack[groupEditStack.length - 1] !== gid) groupEditStack.push(gid);
    opts.clearSelection();
    applyDimming();
    refreshHoverCursor();
    const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (modeBtn) modeBtn.textContent = "Exit group edit";
    (window as any).__ip_exitGroupEdit = exitOneLevel;
    notify();
  };

  return {
    activeId,
    enter,
    exitOneLevel,
    applyDimming,
  };
}

