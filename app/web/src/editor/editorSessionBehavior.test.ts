import { describe, expect, it, vi } from "vitest";
import { createEditorSessionRuntime } from "./editorSessionRuntime";

describe("editor session behavior", () => {
  it("clears redo after a new undo snapshot and updates multi-selection locality", () => {
    const store = {
      model: { nodes: [], views: [] },
      activeViewId: "home",
      selectedId: null,
      selectedIds: [],
    } as any;
    const runtime = createEditorSessionRuntime(store, {
      persistActiveViewId: vi.fn(),
      updateHandles: vi.fn(),
      applyTableCellUpdate: vi.fn(),
    });

    runtime.pushUndo(runtime.snapshotNow());
    runtime.redoStack.push(runtime.snapshotNow());
    runtime.pushUndo(runtime.snapshotNow());
    runtime.setMultiSelection(["a", "b", "a"], "b");

    expect(runtime.redoStack).toHaveLength(0);
    expect(store.selectedIds).toEqual(["a", "b"]);
    expect(store.selectedId).toBe("b");
  });
});
