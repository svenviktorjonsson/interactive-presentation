import type { Model } from "../core/model";
import type { Store } from "../core/store";

export type Snapshot = {
  model: Model;
  activeViewId: string;
  selectedId: string | null;
  selectedIds: string[];
};

type EditorSessionRuntimeOptions = {
  updateHandles: () => void;
  persistActiveViewId: (store: Store) => void;
  applyTableCellUpdate: (node: any, row: number, col: number, value: string) => void;
};

const cloneModel = (m: Model): Model => {
  const sc: any = (globalThis as any).structuredClone;
  if (typeof sc === "function") return sc(m);
  return JSON.parse(JSON.stringify(m)) as Model;
};

export const createEditorSessionRuntime = (store: Store, options: EditorSessionRuntimeOptions) => {
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];

  const snapshotNow = (): Snapshot => ({
    model: cloneModel(store.model),
    activeViewId: store.activeViewId,
    selectedId: store.selectedId,
    selectedIds: [...(store.selectedIds ?? [])],
  });

  const pushUndo = (snap: Snapshot) => {
    undoStack.push(snap);
    redoStack.length = 0;
  };

  const restoreSnapshot = (snap: Snapshot) => {
    store.model = cloneModel(snap.model);
    store.activeViewId = snap.activeViewId;
    options.persistActiveViewId(store);
    store.selectedId = snap.selectedId;
    store.selectedIds = [...(snap.selectedIds ?? (snap.selectedId ? [snap.selectedId] : []))];
    options.updateHandles();
  };

  const clearSelection = () => {
    store.selectedId = null;
    store.selectedIds = [];
    options.updateHandles();
  };

  const setSingleSelection = (id: string | null) => {
    store.selectedId = id;
    store.selectedIds = id ? [id] : [];
    options.updateHandles();
  };

  const setMultiSelection = (ids: string[], preferredPrimary?: string | null) => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    store.selectedIds = uniq;
    if (preferredPrimary && uniq.includes(preferredPrimary)) {
      store.selectedId = preferredPrimary;
    } else {
      store.selectedId = uniq[0] ?? null;
    }
    options.updateHandles();
  };

  const applyTableRuntimeUpdate = (detail: any) => {
    const id = String(detail?.id ?? "");
    const row = Number(detail?.row ?? 0);
    const col = Number(detail?.col ?? 0);
    const value = String(detail?.value ?? "");
    if (!id || !row || !col) return;
    const node: any = store.model.nodes.find((n) => String(n.id) === id);
    if (!node || node.type !== "table") return;
    options.applyTableCellUpdate(node, row, col, value);
  };

  const applyNodePatch = (detail: any) => {
    const id = String(detail?.id ?? "");
    const patch = detail?.patch;
    if (!id || !patch || typeof patch !== "object") return;
    const node: any = store.model.nodes.find((n) => String(n.id) === id);
    if (!node) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "transform" && value && typeof value === "object") {
        node.transform = { ...(node.transform ?? {}), ...(value as Record<string, unknown>) };
        continue;
      }
      (node as any)[key] = value;
    }
  };

  return {
    undoStack,
    redoStack,
    snapshotNow,
    pushUndo,
    restoreSnapshot,
    clearSelection,
    setSingleSelection,
    setMultiSelection,
    applyTableRuntimeUpdate,
    applyNodePatch,
  };
};
