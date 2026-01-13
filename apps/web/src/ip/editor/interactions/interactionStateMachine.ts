import type { Engine } from "@interactive/engine";

export type Tool = "select" | "text" | "bullets" | "arrow" | "line";

export type CompositeState = { id: string | null; kind: "timer" | "sound" | "graph" | "choices"; path: string } | null;

export type InteractionDeps = {
  stage: HTMLElement;
  engine: Engine;
  getAppMode: () => "edit" | "live";
  getTool: () => Tool;
  getCompositeState: () => CompositeState;

  // Segment placement controller (to be refactored)
  placement: {
    onPointerDown: (ev: PointerEvent) => boolean;
    onPointerMove: (ev: PointerEvent) => boolean;
    onContextMenu: (ev: MouseEvent) => boolean;
    onKeyDown: (ev: KeyboardEvent) => boolean;
  };

  // Composite edit controller (to be refactored)
  composite: {
    onPointerDownCapture?: (ev: PointerEvent) => boolean;
    onPointerMoveCapture?: (ev: PointerEvent) => boolean;
    onPointerUpCapture?: (ev: PointerEvent) => boolean;
    onPointerCancelCapture?: (ev: PointerEvent) => boolean;
  };

  // Main select/drag controller (currently lives in bootstrap; migrated via handler callbacks)
  select?: {
    onStagePointerDownCapture?: (ev: PointerEvent) => void;
    onStagePointerDownBubble?: (ev: PointerEvent) => void;
    onStagePointerMoveBubble?: (ev: PointerEvent) => void;
    onWindowPointerDownCapture?: (ev: PointerEvent) => void;
    onWindowPointerMoveCapture?: (ev: PointerEvent) => void;
    onWindowPointerUpCapture?: (ev: PointerEvent) => void;
    onWindowPointerCancelCapture?: (ev: PointerEvent) => void;
  };
};

export type InteractionStateMachine = {
  attach: () => () => void;
};

/**
 * Central event router: ONE coherent pipeline.
 *
 * Rules:
 * - Live mode: ignore editing interactions.
 * - If a placement tool is active, placement owns the interaction (no selection/drag).
 * - If composite edit is active, composite owns the interaction.
 *
 * This module will be extended as we migrate more logic out of bootstrap.
 */
export function createInteractionStateMachine(deps: InteractionDeps): InteractionStateMachine {
  const { stage } = deps;

  const onPointerDownCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;

    // Composite edit has highest priority.
    if (deps.getCompositeState()?.id) {
      const handled = deps.composite.onPointerDownCapture?.(ev) ?? false;
      if (handled) return;
    }

    // Placement tools own the interaction when active.
    if (deps.getTool() !== "select") {
      const handled = deps.placement.onPointerDown(ev);
      if (handled) return;
      return;
    }

    // Select/drag intent (capture phase).
    deps.select?.onStagePointerDownCapture?.(ev);
  };

  const onPointerDownBubble = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (ev.defaultPrevented) return;
    if (deps.getTool() !== "select") return;
    deps.select?.onStagePointerDownBubble?.(ev);
  };

  const onPointerMoveCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;

    if (deps.getCompositeState()?.id) {
      const handled = deps.composite.onPointerMoveCapture?.(ev) ?? false;
      if (handled) return;
    }

    if (deps.getTool() !== "select") {
      const handled = deps.placement.onPointerMove(ev);
      if (handled) return;
      return;
    }
  };

  const onPointerMoveBubble = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") return;
    deps.select?.onStagePointerMoveBubble?.(ev);
  };

  const onWindowPointerMoveCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") return;
    deps.select?.onWindowPointerMoveCapture?.(ev);
  };

  const onWindowPointerDownCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") return;
    deps.select?.onWindowPointerDownCapture?.(ev);
  };

  const onPointerUpCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getCompositeState()?.id) {
      const handled = deps.composite.onPointerUpCapture?.(ev) ?? false;
      if (handled) return;
    }
    if (deps.getTool() === "select") deps.select?.onWindowPointerUpCapture?.(ev);
  };

  const onPointerCancelCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getCompositeState()?.id) {
      const handled = deps.composite.onPointerCancelCapture?.(ev) ?? false;
      if (handled) return;
    }
    if (deps.getTool() === "select") deps.select?.onWindowPointerCancelCapture?.(ev);
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") {
      const handled = deps.placement.onContextMenu(ev);
      if (handled) return;
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") {
      const handled = deps.placement.onKeyDown(ev);
      if (handled) return;
    }
  };

  const attach = () => {
    stage.addEventListener("pointerdown", onPointerDownCapture, { capture: true });
    stage.addEventListener("pointerdown", onPointerDownBubble);
    stage.addEventListener("pointermove", onPointerMoveCapture, { capture: true });
    stage.addEventListener("pointermove", onPointerMoveBubble);
    window.addEventListener("pointerdown", onWindowPointerDownCapture, { capture: true });
    window.addEventListener("pointermove", onWindowPointerMoveCapture, { capture: true });
    window.addEventListener("pointerup", onPointerUpCapture, { capture: true });
    window.addEventListener("pointercancel", onPointerCancelCapture, { capture: true });
    stage.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      stage.removeEventListener("pointerdown", onPointerDownCapture, { capture: true } as any);
      stage.removeEventListener("pointerdown", onPointerDownBubble as any);
      stage.removeEventListener("pointermove", onPointerMoveCapture, { capture: true } as any);
      stage.removeEventListener("pointermove", onPointerMoveBubble as any);
      window.removeEventListener("pointerdown", onWindowPointerDownCapture, { capture: true } as any);
      window.removeEventListener("pointermove", onWindowPointerMoveCapture, { capture: true } as any);
      window.removeEventListener("pointerup", onPointerUpCapture, { capture: true } as any);
      window.removeEventListener("pointercancel", onPointerCancelCapture, { capture: true } as any);
      stage.removeEventListener("contextmenu", onContextMenu as any);
      window.removeEventListener("keydown", onKeyDown as any);
    };
  };

  return { attach };
}

