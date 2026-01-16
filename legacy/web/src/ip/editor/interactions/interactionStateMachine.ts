import type { Engine } from "@interactive/engine";

export type Tool = "select" | "text" | "bullets" | "arrow" | "line";

export type CompositeState = { id: string | null; kind: "timer" | "sound" | "graph" | "choices"; path: string } | null;

export type InteractionDeps = {
  stage: HTMLElement;
  engine: Engine;
  getAppMode: () => "edit" | "live";
  getTool: () => Tool;
  getCompositeState: () => CompositeState;
  setTool?: (tool: Tool) => void;

  // Segment placement controller (to be refactored)
  placement: {
    onPointerDown: (ev: PointerEvent) => boolean;
    onPointerMove: (ev: PointerEvent) => boolean;
    onPointerUp?: (ev: PointerEvent) => boolean;
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

  // Optional debug snapshot (provided by bootstrap).
  debug?: {
    getState?: () => any;
  };
};

export type InteractionStateMachine = {
  attach: () => () => void;
};

type PointerOwner = null | { kind: "placement" | "composite" | "select"; pointerId: number };

/**
 * Central event router: ONE coherent pipeline.
 *
 * Rules:
 * - Live mode: ignore editing interactions.
 * - If a placement tool is active, placement owns the interaction (no selection/drag/pan).
 * - Placement has priority over composite edit (draw-mode isolation).
 * - If composite edit is active (and tool=select), composite owns the interaction.
 *
 * This module will be extended as we migrate more logic out of bootstrap.
 */
export function createInteractionStateMachine(deps: InteractionDeps): InteractionStateMachine {
  const { stage } = deps;

  let pointerOwner: PointerOwner = null;

  const debugEnabled = () => {
    try {
      return (
        localStorage.getItem("ip_debug_state") === "1" ||
        (window as any).ip_debug_state === true ||
        String((window as any).ip_debug_state ?? "") === "1"
      );
    } catch {
      return false;
    }
  };

  const dbgClick = (ev: PointerEvent, where: string, extra?: any) => {
    if (!debugEnabled()) return;
    const t = ev.target as HTMLElement | null;
    const hit = (() => {
      try {
        const nodeEl = t?.closest?.(".node") as HTMLElement | null;
        const subEl = t?.closest?.(".comp-sub") as HTMLElement | null;
        return {
          node: nodeEl ? { id: String((nodeEl as any).dataset?.nodeId ?? ""), type: String((nodeEl as any).dataset?.nodeType ?? "") } : null,
          compSub: subEl
            ? { subId: String((subEl as any).dataset?.subId ?? ""), kind: String((subEl as any).dataset?.kind ?? ""), compPath: String((subEl as any).dataset?.compPath ?? "") }
            : null,
        };
      } catch {
        return null;
      }
    })();
    const state = (() => {
      try {
        return deps.debug?.getState?.() ?? null;
      } catch {
        return null;
      }
    })();
    // eslint-disable-next-line no-console
    console.log("[ip][dbg][state]", {
      where,
      appMode: deps.getAppMode(),
      tool: deps.getTool(),
      compositeState: deps.getCompositeState(),
      pointerOwner,
      pointer: { pointerId: ev.pointerId, button: ev.button, buttons: ev.buttons, clientX: ev.clientX, clientY: ev.clientY },
      target: t ? { tag: t.tagName, cls: String((t as any).className ?? ""), id: (t as any).id ?? "" } : null,
      hit,
      stageRect: (() => {
        try {
          const r = stage.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
        } catch {
          return null;
        }
      })(),
      hooks: {
        exitComposite: !!(window as any).__ip_exitCompositeEdit,
        compositeEditing: !!(window as any).__ip_compositeEditing,
        exitGroup: !!(window as any).__ip_exitGroupEdit,
        exitScreen: !!(window as any).__ip_exitScreenEdit,
      },
      state,
      extra: extra ?? null,
    });
  };

  // Determine whether the event should be treated as "canvas/stage interaction".
  // IMPORTANT: sometimes a fixed overlay (mounted on document.body) can intercept the event target
  // even though the pointer is visually over the stage. So we fall back to a client-rect check.
  const isStageEvent = (ev: { target: EventTarget | null; clientX?: number; clientY?: number }) => {
    const el = ev.target as HTMLElement | null;
    // NEVER treat UI chrome as stage events (otherwise draw-mode can swallow tool clicks).
    // Note: These elements can overlap the stage rect in screen space.
    try {
      const uiHit = el?.closest?.(
        ".edit-toolbox, .mode-toggle, .modal, .modal-backdrop, .tabs, .tab, .modal-header, .modal-body, .modal-footer"
      );
      if (uiHit) return false;
    } catch {}
    try {
      if (el && stage.contains(el)) return true;
    } catch {}
    const x = Number((ev as any).clientX);
    const y = Number((ev as any).clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    try {
      const r = stage.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    } catch {
      return false;
    }
  };

  const swallow = (ev: Event) => {
    try {
      ev.preventDefault();
    } catch {}
    try {
      (ev as any).stopImmediatePropagation?.();
    } catch {}
    try {
      ev.stopPropagation?.();
    } catch {}
  };

  const onPointerDownCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    dbgClick(ev, "stage:pointerdown:capture", { isStageEvent: isStageEvent(ev) });

    // Placement tools own the interaction when active.
    // This MUST be fully isolated: no selection/pan/drag should ever run in draw mode.
    if (deps.getTool() !== "select") {
      // Only swallow interactions originating on the stage/canvas.
      // Never block UI clicks (toolbox/mode button/etc).
      if (!isStageEvent(ev)) return;
      if (ev.button === 0) pointerOwner = { kind: "placement", pointerId: ev.pointerId };
      try {
        deps.placement.onPointerDown(ev);
        // Keep receiving moves even if pointer leaves stage while drawing.
        try {
          stage.setPointerCapture?.(ev.pointerId);
        } catch {}
      } finally {
        swallow(ev);
      }
      return;
    }

    // Composite edit (select tool only).
    if (deps.getCompositeState()?.id) {
      // State-machine rule: composite transitions only occur from stage/canvas events.
      // UI chrome events must never enter composite handling.
      if (!isStageEvent(ev)) return;
      const handled = deps.composite.onPointerDownCapture?.(ev) ?? false;
      dbgClick(ev, "stage:pointerdown:capture:after-composite", { handled, defaultPrevented: ev.defaultPrevented });
      if (handled) {
        pointerOwner = { kind: "composite", pointerId: ev.pointerId };
        dbgClick(ev, "stage:pointerdown:capture:routed", { to: "composite" });
        return;
      }
    }

    // Select/drag intent (capture phase).
    // State-machine rule: selection transitions only occur from stage/canvas events.
    if (!isStageEvent(ev)) return;
    pointerOwner = { kind: "select", pointerId: ev.pointerId };
    deps.select?.onStagePointerDownCapture?.(ev);
    dbgClick(ev, "stage:pointerdown:capture:routed", { to: "select", defaultPrevented: ev.defaultPrevented });
  };

  const onPointerDownBubble = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (ev.defaultPrevented) return;
    // Draw mode must never bubble into selection.
    if (deps.getTool() !== "select") return;
    // Bubble selection must also be stage/canvas-only.
    if (!isStageEvent(ev)) return;
    deps.select?.onStagePointerDownBubble?.(ev);
  };

  const onPointerMoveCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;

    // While drawing (or if a placement tool is active), swallow all stage moves to prevent panning/selection hover.
    if (deps.getTool() !== "select" || pointerOwner?.kind === "placement") {
      if (!isStageEvent(ev) && pointerOwner?.kind !== "placement") return;
      try {
        deps.placement.onPointerMove(ev);
      } finally {
        swallow(ev);
      }
      return;
    }

    if (deps.getCompositeState()?.id || pointerOwner?.kind === "composite") {
      const handled = deps.composite.onPointerMoveCapture?.(ev) ?? false;
      if (handled) return;
    }
  };

  const onPointerMoveBubble = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") return;
    if (!isStageEvent(ev)) return;
    deps.select?.onStagePointerMoveBubble?.(ev);
  };

  const onWindowPointerMoveCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    // Draw mode must not allow any window-level selection overlays to start/continue (e.g. graph box).
    if (deps.getTool() !== "select" || pointerOwner?.kind === "placement") return;
    deps.select?.onWindowPointerMoveCapture?.(ev);
  };

  const onWindowPointerDownCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    // Never swallow window-level pointerdown in draw mode; stage capture already isolates canvas clicks.
    deps.select?.onWindowPointerDownCapture?.(ev);
  };

  const onPointerUpCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    // Placement: do NOT block pointerup propagation (engine pan must always be able to stop).
    if (pointerOwner?.kind === "placement") {
      try {
        deps.placement.onPointerUp?.(ev);
      } catch {}
      if (pointerOwner.pointerId === ev.pointerId) pointerOwner = null;
      // Prevent default, but do NOT stop propagation.
      try {
        ev.preventDefault();
      } catch {}
      return;
    }

    if (deps.getCompositeState()?.id || pointerOwner?.kind === "composite") {
      const handled = deps.composite.onPointerUpCapture?.(ev) ?? false;
      if (handled) {
        if (pointerOwner?.pointerId === ev.pointerId) pointerOwner = null;
        return;
      }
    }

    // Always finish select-owned drags, even if the tool was changed mid-drag.
    if (pointerOwner?.kind === "select" && pointerOwner.pointerId === ev.pointerId) {
      deps.select?.onWindowPointerUpCapture?.(ev);
      pointerOwner = null;
      return;
    }

    if (deps.getTool() === "select") deps.select?.onWindowPointerUpCapture?.(ev);
    if (pointerOwner?.pointerId === ev.pointerId) pointerOwner = null;
  };

  const onPointerCancelCapture = (ev: PointerEvent) => {
    if (deps.getAppMode() !== "edit") return;
    // Ensure any select-owned drag state is cleared even if tool changed.
    if (pointerOwner?.kind === "select" && pointerOwner.pointerId === ev.pointerId) {
      deps.select?.onWindowPointerCancelCapture?.(ev);
      pointerOwner = null;
      return;
    }
    if (pointerOwner?.pointerId === ev.pointerId) pointerOwner = null;
    if (deps.getCompositeState()?.id) {
      const handled = deps.composite.onPointerCancelCapture?.(ev) ?? false;
      if (handled) return;
    }
    if (deps.getTool() === "select") deps.select?.onWindowPointerCancelCapture?.(ev);
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") {
      // Only isolate contextmenu on the stage/canvas.
      if (!isStageEvent(ev as any)) return;
      const handled = deps.placement.onContextMenu(ev);
      if (handled) {
        swallow(ev);
        return;
      }
      // No active draft to cancel -> exit draw mode back to select.
      try {
        deps.setTool?.("select");
      } catch {}
      swallow(ev);
      return;
    }
    // Select tool: disable default browser context menu on the canvas
    // (used by right-button marquee selection).
    if (isStageEvent(ev as any)) {
      swallow(ev);
      return;
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (deps.getAppMode() !== "edit") return;
    if (deps.getTool() !== "select") {
      // Only swallow if placement handled it. Otherwise, allow global shortcuts (Esc, ctrl+z, etc).
      const handled = deps.placement.onKeyDown(ev);
      if (handled) {
        swallow(ev);
        return;
      }
      // Esc with no active draft -> exit draw mode back to select.
      if (ev.key === "Escape") {
        try {
          deps.setTool?.("select");
        } catch {}
        swallow(ev);
        return;
      }
      return;
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

