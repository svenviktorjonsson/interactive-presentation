import { describe, expect, it, vi } from "vitest";
import { createEditorSessionRuntime } from "./editorSessionRuntime";

const makeStore = () =>
  ({
    model: { nodes: [{ id: "table1", type: "table", transform: {} }, { id: "text1", type: "text", transform: {} }], views: [] },
    activeViewId: "home",
    selectedId: "text1",
    selectedIds: ["text1"],
  }) as any;

describe("editorSessionRuntime", () => {
  it("restores snapshots and selection through the editor session seam", () => {
    const store = makeStore();
    const persistActiveViewId = vi.fn();
    const updateHandles = vi.fn();
    const applyTableCellUpdate = vi.fn();
    const runtime = createEditorSessionRuntime(store, {
      persistActiveViewId,
      updateHandles,
      applyTableCellUpdate,
    });

    const snap = runtime.snapshotNow();
    store.activeViewId = "other";
    store.selectedId = null;
    store.selectedIds = [];
    runtime.restoreSnapshot(snap);

    expect(store.activeViewId).toBe("home");
    expect(store.selectedId).toBe("text1");
    expect(store.selectedIds).toEqual(["text1"]);
    expect(persistActiveViewId).toHaveBeenCalled();
    expect(updateHandles).toHaveBeenCalled();
  });

  it("applies table updates and generic node patches through one session interface", () => {
    const store = makeStore();
    const applyTableCellUpdate = vi.fn();
    const runtime = createEditorSessionRuntime(store, {
      persistActiveViewId: vi.fn(),
      updateHandles: vi.fn(),
      applyTableCellUpdate,
    });

    runtime.applyTableRuntimeUpdate({ id: "table1", row: 2, col: 3, value: "42" });
    runtime.applyNodePatch({ id: "text1", patch: { text: "Hello", transform: { x: 1 } } });

    expect(applyTableCellUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "table1" }), 2, 3, "42");
    expect((store.model.nodes[1] as any).text).toBe("Hello");
    expect((store.model.nodes[1] as any).transform).toEqual({ x: 1 });
  });
});
