import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

export type AppMode = "edit" | "live";

export type RuntimeContext = {
  engine: Engine;
  stage: HTMLElement;
  getAppMode: () => AppMode;
  BACKEND: string;
  /**
   * Optional host callback for persisting editor changes (undo/redo + save).
   * Plugins should call this with a "before" snapshot when they mutate the model in Edit mode.
   */
  onCommit?: (before: PresentationModel) => Promise<void> | void;
};

export type FrameContext = RuntimeContext & {
  model: PresentationModel;
  timeMs: number;
};

export type ElementPlugin = {
  /** Node type this plugin owns (e.g. "graph", "timer"). */
  type: string;
  /** Called once after model is set/changed (for attaching DOM layers, etc). */
  onModel?: (ctx: RuntimeContext, model: PresentationModel) => void;
  /** Called every frame; plugin may render or update DOM. */
  onFrame?: (ctx: FrameContext) => void;
  /**
   * Called when the host app navigates away / stops an interactive session.
   * Plugins should stop polling/accepting states and persist anything needed.
   */
  onStopInteractiveSessions?: (ctx: RuntimeContext) => void;
};

