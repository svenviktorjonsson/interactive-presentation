import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

export function createHistoryController(opts: {
  engine: Engine;
  cloneModel: (m: PresentationModel) => PresentationModel;
  saveModel: (m: PresentationModel) => Promise<void>;
  hydrateQrImages: (engine: Engine, model: PresentationModel) => Promise<void>;
  hydrateTextMath: (engine: Engine, model: PresentationModel) => void;
  applySelection: () => void;
}) {
  const undoStack: PresentationModel[] = [];
  const redoStack: PresentationModel[] = [];

  async function commit(before: PresentationModel | null) {
    if (!before) return;
    const after = opts.engine.getModel();
    if (!after) return;
    undoStack.push(before);
    redoStack.length = 0;
    await opts.saveModel(after);
  }

  async function undo() {
    const prev = undoStack.pop();
    if (!prev) return false;
    const cur = opts.engine.getModel();
    if (cur) redoStack.push(opts.cloneModel(cur));
    opts.engine.setModel(opts.cloneModel(prev));
    await opts.hydrateQrImages(opts.engine, prev);
    opts.hydrateTextMath(opts.engine, prev);
    opts.applySelection();
    await opts.saveModel(prev);
    return true;
  }

  async function redo() {
    const next = redoStack.pop();
    if (!next) return false;
    const cur = opts.engine.getModel();
    if (cur) undoStack.push(opts.cloneModel(cur));
    opts.engine.setModel(opts.cloneModel(next));
    await opts.hydrateQrImages(opts.engine, next);
    opts.hydrateTextMath(opts.engine, next);
    opts.applySelection();
    await opts.saveModel(next);
    return true;
  }

  return { commit, undo, redo };
}

