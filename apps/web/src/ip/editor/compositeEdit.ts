/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
// Extracted from bootstrap.ts (composite edit + screen edit)
// NOTE: Still intentionally flexible typing; goal is strict TS compile without suppressing typechecking.
import type { Engine } from "@interactive/engine";

export type CompositeKind = "timer" | "choices" | "sound" | "graph";

export type CompositeState = { id: string | null; kind: CompositeKind; path: string };

export type CompositeEditController = {
  enterCompositeEdit: (type: CompositeKind, id: string) => void;
  enterScreenEdit: () => void;
  exitScreenEdit: () => void;
  isScreenEditMode: () => boolean;
  getCompositeState: () => CompositeState;
};

export type CompositeEditControllerDeps = {
  engine: Engine;
  stage: HTMLElement;
  BACKEND: string;
  getAppMode: () => "edit" | "live";

  selected: Set<string>;
  clearSelection: () => void;
  applySelection: () => void;
  openEditorModal: (nodeId: string) => Promise<void>;
  ensureHandles: (el: HTMLElement) => void;
  cursorForHandle: (h: string | null) => string;
  setBodyCursor: (v: string) => void;

  screenToWorld: (...args: any[]) => any;
  gridSpacingForZoom: (...args: any[]) => any;
  anchorToTopLeftWorld: (...args: any[]) => any;
  topLeftToAnchorWorld: (...args: any[]) => any;

  effectiveNodeRectClient: (...args: any[]) => any;
  isPointInRotatedRectClient: (...args: any[]) => any;
  _plotRectCss: (...args: any[]) => any;
  _debugCompositeSaveFetch: (...args: any[]) => any;

  ensureTimerCompositeLayer: (...args: any[]) => any;
  ensureSoundCompositeLayer: (...args: any[]) => any;
  ensureGraphCompositeLayer: (...args: any[]) => any;

  renderTimerCompositeArrows: (...args: any[]) => any;
  renderSoundCompositeArrows: (...args: any[]) => any;
  renderGraphCompositeArrows: (...args: any[]) => any;

  ensureChoicesWheelLayer: (...args: any[]) => any;
  applyDataBindings: (...args: any[]) => any;
  renderTextWithKatexToHtml: (...args: any[]) => any;
  _pickSmallestCompositeSub: (...args: any[]) => any;

  groupEdit?: any;

  onCompositeState?: (st: CompositeState) => void;
  onScreenEditModeChanged?: (v: boolean) => void;
};

export function attachCompositeEditController(opts: CompositeEditControllerDeps): CompositeEditController {
  // Destructure via a temporary `o:any` to keep TS from narrowing `opts` too aggressively
  // while we gradually replace any-typed dependencies with real typed ones.
  const o = opts as any;
  const engine: Engine = o.engine;
  const stage: HTMLElement = o.stage;
  const BACKEND: string = o.BACKEND;
  const getAppMode: () => "edit" | "live" = o.getAppMode;

  const selected: Set<string> = o.selected;
  const clearSelection: () => void = o.clearSelection;
  const applySelection: () => void = o.applySelection;
  const openEditorModal: (nodeId: string) => Promise<void> = o.openEditorModal;
  const ensureHandles: (el: HTMLElement) => void = o.ensureHandles;
  const cursorForHandle: (h: string | null) => string = o.cursorForHandle;
  const setBodyCursor: (v: string) => void = o.setBodyCursor;

  const screenToWorld: any = o.screenToWorld;
  const gridSpacingForZoom: any = o.gridSpacingForZoom;
  const anchorToTopLeftWorld: any = o.anchorToTopLeftWorld;
  const topLeftToAnchorWorld: any = o.topLeftToAnchorWorld;

  const effectiveNodeRectClient: any = o.effectiveNodeRectClient;
  const isPointInRotatedRectClient: any = o.isPointInRotatedRectClient;
  const _plotRectCss: any = o._plotRectCss;
  const _debugCompositeSaveFetch: any = o._debugCompositeSaveFetch;

  const ensureTimerCompositeLayer: any = o.ensureTimerCompositeLayer;
  const ensureSoundCompositeLayer: any = o.ensureSoundCompositeLayer;
  const ensureGraphCompositeLayer: any = o.ensureGraphCompositeLayer;

  const renderTimerCompositeArrows: any = o.renderTimerCompositeArrows;
  const renderSoundCompositeArrows: any = o.renderSoundCompositeArrows;
  const renderGraphCompositeArrows: any = o.renderGraphCompositeArrows;

  const ensureChoicesWheelLayer: any = o.ensureChoicesWheelLayer;
  const applyDataBindings: any = o.applyDataBindings;
  const renderTextWithKatexToHtml: any = o.renderTextWithKatexToHtml;
  const _pickSmallestCompositeSub: any = o._pickSmallestCompositeSub;

  const groupEdit: any = o.groupEdit;
  const onCompositeState: ((st: CompositeState) => void) | undefined = o.onCompositeState;
  const onScreenEditModeChanged: ((v: boolean) => void) | undefined = o.onScreenEditModeChanged;

  const ipDebugEnabled = (flag: string) => {
    try {
      return localStorage.getItem(flag) === "1";
    } catch {
      return false;
    }
  };

  // Screen edit state (kept here; host can also mirror if it wants).
  let screenEditMode = false;
  let screenDimmedEls: HTMLElement[] = [];
  let enterScreenEdit: () => void = () => {};
  let exitScreenEdit: () => void = () => {};

  const syncCompositeState = () => {
    try {
      onCompositeState?.({ id: compositeEditTimerId, kind: compositeEditKind, path: compositeEditPath });
    } catch {
      // ignore
    }
  };

// Composite edit mode (timer/choices): allow editing sub-elements without opening the regular modal.
let compositeEditTimerId: string | null = null; // composite root node id
let compositeEditKind: "timer" | "choices" | "sound" | "graph" = "timer";
let compositeEditPath: string = "";
const compositePathStack: string[] = [];
const compositeGeomsByPath: Record<string, any> = {};
let compositeHiddenEls: HTMLElement[] = [];
let compositeSelectedSubId: string | null = null;
let compositeSelectedSubEl: HTMLElement | null = null;
let compositeDragMode: "none" | "move" | "resize" | "rotate" | "arrow" = "none";
let compositeActiveHandle: string | null = null;
let compositeStart = { x: 0, y: 0 };
let compositeStartGeom: any = null;
let compositeGrabOff = { x: 0, y: 0 };
let compositeStartAngleRad = 0;
let compositeStartRotationDeg = 0;
let compositeArrowDrag:
  | null
  | {
      arrowId: string;
      end: "p1" | "p2" | "mid";
      // Start point in client space (for hover thresholding)
      startClientX: number;
      startClientY: number;
      // For mid-drag (translate), keep initial arrow endpoints in plot coords.
      startX0?: number;
      startY0?: number;
      startX1?: number;
      startY1?: number;
    } = null;
let compositeDrag:
  | null
  | {
      subId: string;
      startX: number;
      startY: number;
      startL: number;
      startT: number;
      box: DOMRect;
    } = null;

const clearCompositeSubSelection = () => {
  if (!compositeEditTimerId) return;
  const rootEl = engine.getNodeElement(compositeEditTimerId);
  if (!rootEl) return;
  // Clear selection chrome + state.
  for (const e of Array.from(rootEl.querySelectorAll<HTMLElement>(".comp-sub.is-selected"))) {
    e.classList.remove("is-selected");
    e.querySelector(":scope > .handles")?.remove();
  }
  compositeSelectedSubId = null;
  compositeSelectedSubEl = null;
  compositeDragMode = "none";
  compositeActiveHandle = null;
  compositeStartGeom = null;
  compositeArrowDrag = null;
  // Clear plot-arrow glow (rendered on SVG), if any.
  const layer =
    compositeEditKind === "timer"
      ? rootEl.querySelector<HTMLElement>(".timer-sub-layer")
      : compositeEditKind === "sound"
        ? rootEl.querySelector<HTMLElement>(".sound-sub-layer")
        : null;
  if (layer) {
    delete (layer.dataset as any).selectedPlotArrowId;
    if (compositeEditKind === "timer") renderTimerCompositeArrows(rootEl, layer);
    else if (compositeEditKind === "sound") renderSoundCompositeArrows(rootEl, layer);
  }
};

const compositeOuterRectClient = (rootEl: HTMLElement, layer: HTMLElement) => {
  // Union bbox for the composite root + all its internal sub-elements (labels, buttons, plot, arrow hits).
  // This is used to:
  // - decide whether a double-click is "background" (screen edit) vs "inside a node"
  // - gate group-edit interactions so you can't click inside the group but outside its bbox
  const rr = rootEl.getBoundingClientRect();
  let l = rr.left,
    t = rr.top,
    r = rr.right,
    b = rr.bottom;
  for (const sub of Array.from((layer as HTMLElement).querySelectorAll<HTMLElement>(".comp-sub"))) {
    const sr = sub.getBoundingClientRect();
    // Skip absurd rects (e.g. detached/hidden)
    if (!(sr.width > 0.5 && sr.height > 0.5)) continue;
    l = Math.min(l, sr.left);
    t = Math.min(t, sr.top);
    r = Math.max(r, sr.right);
    b = Math.max(b, sr.bottom);
    // Include actual button rects (background/padding/border are on the button itself).
    for (const btn of Array.from(sub.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const br = btn.getBoundingClientRect();
      if (!(br.width > 0.5 && br.height > 0.5)) continue;
      l = Math.min(l, br.left);
      t = Math.min(t, br.top);
      r = Math.max(r, br.right);
      b = Math.max(b, br.bottom);
    }
  }
  return { left: l, top: t, right: r, bottom: b };
};

const isInRect = (rc: { left: number; top: number; right: number; bottom: number }, x: number, y: number) =>
  x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom;

// Screen edit mode (edit only): isolate and edit screen-space nodes.
exitScreenEdit = () => {
  if (!screenEditMode) return;
  for (const e of screenDimmedEls) {
    e.classList.remove("ip-dim-node");
    e.style.pointerEvents = "";
  }
  screenDimmedEls = [];
  screenEditMode = false;
  try {
    onScreenEditModeChanged?.(false);
  } catch {}
  delete (window as any).__ip_screenEditing;
  const wrap = document.querySelector<HTMLElement>(".mode-toggle");
  const modeNow = (wrap?.dataset.mode ?? "edit").toLowerCase();
  const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (btn) btn.textContent = modeNow === "edit" ? "Switch to Live" : "Switch to Edit";
  const hint = document.querySelector<HTMLElement>(".mode-toggle .hint");
  if (hint) hint.textContent = modeNow === "edit" ? "Edit: drag/resize/rotate • double-click edit" : "Live: left/right step, up/down view • editing disabled";
  delete (window as any).__ip_exitScreenEdit;
};

enterScreenEdit = () => {
  const currentMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  if (currentMode !== "edit") return;
  exitScreenEdit();
  clearSelection();
  screenEditMode = true;
  try {
    onScreenEditModeChanged?.(true);
  } catch {}
  (window as any).__ip_screenEditing = true;
  const model = engine.getModel();
  const clampScreenTransform = (t: any) => {
    const w = Number(t.w ?? 0.2);
    const h = Number(t.h ?? 0.1);
    const anchor = String(t.anchor ?? "topLeft");
    const tl0 = anchorToTopLeftWorld({ x: Number(t.x ?? 0), y: Number(t.y ?? 0), w, h, anchor } as any);
    const tlx = Math.max(-0.5 * w, Math.min(1 - 0.5 * w, tl0.x));
    const tly = Math.max(-0.5 * h, Math.min(1 - 0.5 * h, tl0.y));
    const ap = topLeftToAnchorWorld({ x: tlx, y: tly, w, h }, anchor);
    return { ...t, x: ap.x, y: ap.y };
  };
  for (const n of model?.nodes ?? []) {
    const el = engine.getNodeElement(n.id);
    if (!el) continue;
    if (n.space === "screen") {
      el.style.pointerEvents = "auto";
      // Snap underlying transform into a "half-visible" region so it's draggable immediately.
      const t0: any = (n as any).transform ?? {};
      const t1 = clampScreenTransform(t0);
      if (t1.x !== t0.x || t1.y !== t0.y) {
        engine.updateNode(n.id, { transform: { x: t1.x, y: t1.y } as any } as any);
      }
      continue;
    }
    el.classList.add("ip-dim-node");
    el.style.pointerEvents = "none";
    screenDimmedEls.push(el);
  }
  const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (btn) btn.textContent = "Exit Screen Edit Mode";
  const hint = document.querySelector<HTMLElement>(".mode-toggle .hint");
  if (hint) hint.textContent = "Screen Edit Mode: editing screen-space elements only";
  (window as any).__ip_exitScreenEdit = exitScreenEdit;
};

const applyCompositeLevelDimming = () => {
  if (!compositeEditTimerId) return;
  const rootEl = engine.getNodeElement(compositeEditTimerId);
  if (!rootEl) return;
  const activeBox =
    rootEl.querySelector<HTMLElement>(`[data-group-path="${compositeEditPath}"]`) ??
    rootEl;
  // Dim and disable pointer events for elements outside the active box.
  // IMPORTANT: do NOT disable pointer events on the active box, or its descendants won't be interactive.
  for (const sub of Array.from(rootEl.querySelectorAll<HTMLElement>(".comp-sub"))) {
    const inActiveBox = activeBox.contains(sub);
    sub.classList.toggle("ip-composite-dim", !inActiveBox);
    // Ensure we restore pointer-events when moving back up levels.
    sub.style.pointerEvents = inActiveBox ? "auto" : "none";
  }
  // Also dim non-comp-sub content outside the active box (e.g. underlying chart layers).
  // Keep this light: just add a dataset marker for CSS hooks if needed.
  rootEl.dataset.compositeLevel = compositeEditPath;
};

const enterCompositeLevel = (path: string) => {
  if (!compositeEditTimerId) return;
  const p = String(path || compositeEditTimerId);
  if (!p) return;
  // Normalize stack root.
  if (compositePathStack.length === 0) compositePathStack.push(String(compositeEditTimerId));
  if (compositePathStack[compositePathStack.length - 1] !== p) compositePathStack.push(p);
  compositeEditPath = p;
  (window as any).__ip_dbg_compositeEditPath = compositeEditPath;
  compositeSelectedSubId = null;
  compositeSelectedSubEl = null;
  // Clear any selection chrome.
  const rootEl = engine.getNodeElement(compositeEditTimerId);
  if (rootEl) {
    for (const e of Array.from(rootEl.querySelectorAll<HTMLElement>(".comp-sub"))) {
      e.classList.remove("is-selected");
      e.querySelector(":scope > .handles")?.remove();
    }
  }
  applyCompositeLevelDimming();
  syncCompositeState();
};

const exitCompositeLevel = () => {
  if (!compositeEditTimerId) return;
  if (compositePathStack.length <= 1) {
    (window as any).__ip_exitCompositeEdit?.();
    return;
  }
  compositePathStack.pop();
  compositeEditPath = compositePathStack[compositePathStack.length - 1] ?? String(compositeEditTimerId);
  (window as any).__ip_dbg_compositeEditPath = compositeEditPath;
  compositeSelectedSubId = null;
  compositeSelectedSubEl = null;
  const rootEl = engine.getNodeElement(compositeEditTimerId);
  if (rootEl) {
    for (const e of Array.from(rootEl.querySelectorAll<HTMLElement>(".comp-sub"))) {
      e.classList.remove("is-selected");
      e.querySelector(":scope > .handles")?.remove();
    }
  }
  applyCompositeLevelDimming();
  syncCompositeState();
};

const enterGraphCompositeEdit = (graphId: string) => {
  const dbg = ipDebugEnabled("ip_debug_dblclick");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][dblclick] enterGraphCompositeEdit()", { graphId });
  }
  // Avoid conflicting isolate modes.
  exitScreenEdit();
  compositeEditKind = "graph";
  compositeEditTimerId = graphId;
  (engine as any).__ip_lastCompositeId = graphId;
  (window as any).__ip_compositeEditId = graphId;
  (window as any).__ip_compositeEditKind = "graph";
  clearSelection();
  const el = engine.getNodeElement(graphId);
  if (!el) return;
  el.querySelector(".handles")?.remove();

  // Isolate: dim all other nodes in the scene.
  compositeHiddenEls = [];
  const model = engine.getModel();
  for (const n of model?.nodes ?? []) {
    if (n.id === graphId) continue;
    const e2 = engine.getNodeElement(n.id);
    if (!e2) continue;
    e2.classList.add("ip-dim-node");
    compositeHiddenEls.push(e2);
  }

  const layer = ensureGraphCompositeLayer(engine, graphId);
  if (layer) layer.style.pointerEvents = "auto";
  el.dataset.compositeEditing = "1";
  compositeGeomsByPath[graphId] = (layer as any)?.__textGeoms ?? {};

  const graphSubs = Array.from(((layer as HTMLElement | null)?.querySelectorAll?.(".comp-sub") ?? []) as NodeListOf<HTMLElement>);
  for (const sub of graphSubs) {
    // Lock the plot/data reference region.
    if (sub.dataset.subId === "plot" || sub.dataset.kind === "plot-region") {
      sub.style.pointerEvents = "none";
      sub.style.cursor = "default";
      sub.style.background = "transparent";
      sub.style.outline = "none";
      sub.style.opacity = "1";
    } else {
      sub.style.pointerEvents = "auto";
      sub.style.cursor = "grab";
    }
    sub.style.border = "none";
    if (sub.dataset.kind !== "plot-region") sub.style.background = "transparent";
    sub.style.borderRadius = "0";
    sub.style.padding = "0";
  }

  const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (modeBtn) modeBtn.textContent = "Exit group edit";
  (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
  (window as any).__ip_compositeEditing = true;
  compositeEditPath = graphId;
  (window as any).__ip_dbg_compositeEditPath = compositeEditPath;
  compositePathStack.length = 0;
  compositePathStack.push(graphId);
  applyCompositeLevelDimming();
  syncCompositeState();
};

const enterTimerCompositeEdit = (timerId: string) => {
  const dbg = ipDebugEnabled("ip_debug_dblclick");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][dblclick] enterTimerCompositeEdit()", { timerId });
  }
  // Avoid conflicting isolate modes.
  exitScreenEdit();
  compositeEditKind = "timer";
  compositeEditTimerId = timerId;
  // Track for debugging + for restoring state if engine.setModel recreates DOM.
  (engine as any).__ip_lastCompositeId = timerId;
  (window as any).__ip_compositeEditId = timerId;
  (window as any).__ip_compositeEditKind = "timer";
  clearSelection();
  const el = engine.getNodeElement(timerId);
  if (!el) return;
  // Remove regular selection handles while in composite editing.
  el.querySelector(".handles")?.remove();
  // Hide the faint overlay entirely so sub-elements appear clean (as if directly on the canvas).
  const ov = el.querySelector<HTMLElement>(".timer-overlay");
  if (ov) ov.style.display = "none";
  // Keep timer buttons visible in composite edit mode.

  // Isolate: dim all other nodes in the scene.
  compositeHiddenEls = [];
  const model = engine.getModel();
  for (const n of model?.nodes ?? []) {
    if (n.id === timerId) continue;
    const e2 = engine.getNodeElement(n.id);
    if (!e2) continue;
    e2.classList.add("ip-dim-node");
    compositeHiddenEls.push(e2);
  }
  const layer = ensureTimerCompositeLayer(engine, timerId);
  if (layer) layer.style.pointerEvents = "auto";
  // Mark composite editing so CSS can optionally gray out non-editable parts.
  el.dataset.compositeEditing = "1";
  // Seed editable geoms for this composite folder.
  // Root path == timerId; nested plot level == `${timerId}/plot`.
  compositeGeomsByPath[timerId] = (layer as any)?.__textGeoms ?? {};
  const byPath: any = (engine.getModel()?.nodes.find((n: any) => String(n.id) === String(timerId)) as any)?.compositeGeometriesByPath ?? {};
  compositeGeomsByPath[`${timerId}/plot`] = byPath["plot"] ?? {};
  const timerSubs = Array.from(((layer as HTMLElement | null)?.querySelectorAll?.(".comp-sub") ?? []) as NodeListOf<HTMLElement>);
  for (const sub of timerSubs) {
    // Lock the plot/data reference region: it's the coordinate system basis for everything else.
    if (sub.dataset.kind === "plot-region") {
      sub.style.pointerEvents = "none";
      sub.style.cursor = "default";
      // IMPORTANT:
      // The plot region is an internal helper (not authored in elements.pr).
      // Keep it invisible in composite edit to avoid confusing "ghost element" selection boxes.
      sub.style.background = "transparent";
      sub.style.outline = "none";
      sub.style.outlineOffset = "0px";
      sub.style.opacity = "1";
    } else {
      sub.style.pointerEvents = "auto";
      sub.style.cursor = "grab";
    }
    // Keep clean while editing (no frames).
    sub.style.border = "none";
    if (sub.dataset.kind !== "plot-region") sub.style.background = "transparent";
    sub.style.borderRadius = "0";
    sub.style.padding = "0";
  }

  // Update mode button label while editing a group.
  const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (modeBtn) modeBtn.textContent = "Exit group edit";
  (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
  (window as any).__ip_compositeEditing = true;
  compositeEditPath = timerId;
  (window as any).__ip_dbg_compositeEditPath = compositeEditPath;
  compositePathStack.length = 0;
  compositePathStack.push(timerId);
  applyCompositeLevelDimming();
  syncCompositeState();
  // If we ever end up in a nested level on entry, warn (this used to cause "grayed out" labels).
  if (String(compositeEditPath).includes("/")) {
    // eslint-disable-next-line no-console
    console.warn("[ip][dbg] timer composite entered with nested path (unexpected)", { timerId, compositeEditPath });
  }

  // Debug: verify composite texts are actually interactive right after entry.
  // Enable with: localStorage.setItem("ip_debug_timer_text_pe", "1")
  try {
    const dbgPe = localStorage.getItem("ip_debug_timer_text_pe") === "1";
    if (dbgPe) {
      const layerNow = el.querySelector<HTMLElement>(".timer-sub-layer");
      const texts = Array.from(layerNow?.querySelectorAll<HTMLElement>(".timer-sub-text") ?? []);
      const sample = texts.slice(0, 6).map((t) => ({
        id: t.dataset.subId,
        pe: t.style.pointerEvents,
        cursor: t.style.cursor,
        dim: t.classList.contains("ip-composite-dim"),
      }));
      // eslint-disable-next-line no-console
      console.log("[ip][dbg][timer-text-pe] after-enter", {
        timerId,
        appMode: getAppMode(),
        compositeEditing: el.dataset.compositeEditing,
        nTexts: texts.length,
        sample,
      });
    }
  } catch {
    // ignore
  }
};

const enterChoicesCompositeEdit = (pollId: string) => {
  const dbg = ipDebugEnabled("ip_debug_dblclick");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][dblclick] enterChoicesCompositeEdit()", { pollId });
  }
  // Avoid conflicting isolate modes.
  exitScreenEdit();
  compositeEditKind = "choices";
  compositeEditTimerId = pollId;
  (engine as any).__ip_lastCompositeId = pollId;
  (window as any).__ip_compositeEditId = pollId;
  (window as any).__ip_compositeEditKind = "choices";
  const el = engine.getNodeElement(pollId);
  if (!el) return;
  // Start with sub-element editing (root remains selectable via click/drag on the node itself).
  clearSelection();

  // No separate "results view" anymore; keep the normal live layout while editing.
  el.dataset.resultsVisible = "1";
  // Rendering is now handled by the runtime `choices` plugin.

  // Isolate: dim all other nodes.
  compositeHiddenEls = [];
  const model = engine.getModel();
  for (const n of model?.nodes ?? []) {
    if (n.id === pollId) continue;
    const e2 = engine.getNodeElement(n.id);
    if (!e2) continue;
    e2.classList.add("ip-dim-node");
    compositeHiddenEls.push(e2);
  }

  const layer = el.querySelector<HTMLElement>(".choices-sub-layer");
  if (layer) layer.style.pointerEvents = "auto";
  // Mark composite editing so CSS can gray out non-editable parts (buttons + pie).
  el.dataset.compositeEditing = "1";
  // Seed editable geoms for nested folders from the model.
  const m = engine.getModel();
  const node = m?.nodes.find((n: any) => n.id === pollId);
  const byPath = (node as any)?.compositeGeometriesByPath ?? {};
  compositeGeomsByPath[pollId] = byPath[""] ?? {};
  compositeGeomsByPath[`${pollId}/wheel`] = byPath["wheel"] ?? {};
  const soundSubs = Array.from(((layer as HTMLElement | null)?.querySelectorAll?.(".comp-sub") ?? []) as NodeListOf<HTMLElement>);
  for (const sub of soundSubs) {
    sub.style.pointerEvents = "auto";
    sub.style.cursor = "grab";
    sub.style.border = "none";
    sub.style.background = "transparent";
    sub.style.borderRadius = "0";
    sub.style.padding = "0";
  }

  // Do not auto-select the root node here.
  // In group edit, the primary workflow is selecting/moving bullets and wheel independently.
  // (Root selection is still possible by clicking the node outside sub-elements.)

  const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (modeBtn) modeBtn.textContent = "Exit group edit";
  (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
  (window as any).__ip_compositeEditing = true;
  compositeEditPath = pollId;
  compositePathStack.length = 0;
  compositePathStack.push(pollId);
  applyCompositeLevelDimming();
  syncCompositeState();
};

const enterSoundCompositeEdit = (soundId: string) => {
  const dbg = ipDebugEnabled("ip_debug_dblclick");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][dblclick] enterSoundCompositeEdit()", { soundId });
  }
  // Avoid conflicting isolate modes.
  exitScreenEdit();
  compositeEditKind = "sound";
  compositeEditTimerId = soundId;
  (engine as any).__ip_lastCompositeId = soundId;
  (window as any).__ip_compositeEditId = soundId;
  (window as any).__ip_compositeEditKind = "sound";
  clearSelection();
  const el = engine.getNodeElement(soundId);
  if (!el) return;
  el.querySelector(".handles")?.remove();
  el.dataset.compositeEditing = "1";
  const ov = el.querySelector<HTMLElement>(".sound-overlay");
  if (ov) ov.style.display = "none";

  compositeHiddenEls = [];
  const model = engine.getModel();
  for (const n of model?.nodes ?? []) {
    if (n.id === soundId) continue;
    const e2 = engine.getNodeElement(n.id);
    if (!e2) continue;
    e2.classList.add("ip-dim-node");
    compositeHiddenEls.push(e2);
  }
  const layer = ensureSoundCompositeLayer(engine, soundId);
  if (layer) layer.style.pointerEvents = "auto";
  compositeGeomsByPath[soundId] = (layer as any)?.__textGeoms ?? {};
  const byPath: any = (engine.getModel()?.nodes.find((n: any) => String(n.id) === String(soundId)) as any)?.compositeGeometriesByPath ?? {};
  compositeGeomsByPath[`${soundId}/plot`] = byPath["plot"] ?? {};
  const soundSubs2 = Array.from(((layer as HTMLElement | null)?.querySelectorAll?.(".comp-sub") ?? []) as NodeListOf<HTMLElement>);
  for (const sub of soundSubs2) {
    if (sub.dataset.kind === "plot-region") {
      sub.style.pointerEvents = "none";
      sub.style.cursor = "default";
      // Keep it invisible; plot is internal and not authored in elements.pr.
      sub.style.background = "transparent";
      sub.style.outline = "none";
      sub.style.outlineOffset = "0px";
      sub.style.opacity = "1";
    } else {
      sub.style.pointerEvents = "auto";
      sub.style.cursor = "grab";
    }
    sub.style.border = "none";
    sub.style.background = "transparent";
    sub.style.borderRadius = "0";
    sub.style.padding = "0";
  }
  const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (modeBtn) modeBtn.textContent = "Exit group edit";
  (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
  (window as any).__ip_compositeEditing = true;
  compositeEditPath = soundId;
  compositePathStack.length = 0;
  compositePathStack.push(soundId);
  applyCompositeLevelDimming();
  syncCompositeState();
};

const exitTimerCompositeEdit = () => {
  if (!compositeEditTimerId) return;
  // Clear last composite id marker (avoids restoring after setModel when not editing).
  delete (engine as any).__ip_lastCompositeId;
  delete (window as any).__ip_compositeEditId;
  delete (window as any).__ip_compositeEditKind;
  const el = engine.getNodeElement(compositeEditTimerId);
  // Hard guarantee: strip any leftover sub-element selection chrome when exiting group edit.
  if (el) {
    for (const sub of Array.from(el.querySelectorAll<HTMLElement>(".comp-sub.is-selected, .timer-sub.is-selected"))) {
      sub.classList.remove("is-selected");
      sub.querySelector(".handles")?.remove();
    }
  }
  if (compositeEditKind === "timer") {
    const ov = el?.querySelector<HTMLElement>(".timer-overlay");
    if (ov) ov.style.display = "block";
    const layer = el?.querySelector<HTMLElement>(".timer-sub-layer");
    if (layer) {
      layer.style.pointerEvents = "none";
      delete (layer.dataset as any).selectedPlotArrowId;
    }
    if (el) el.dataset.compositeEditing = "0";
  } else if (compositeEditKind === "sound") {
    const ov = el?.querySelector<HTMLElement>(".sound-overlay");
    if (ov) ov.style.display = "block";
    const layer = el?.querySelector<HTMLElement>(".sound-sub-layer");
    if (layer) {
      layer.style.pointerEvents = "none";
      delete (layer.dataset as any).selectedPlotArrowId;
    }
    if (el) el.dataset.compositeEditing = "0";
  } else if (compositeEditKind === "graph") {
    const layer = el?.querySelector<HTMLElement>(".graph-sub-layer");
    if (layer) {
      layer.style.pointerEvents = "none";
      delete (layer.dataset as any).selectedPlotArrowId;
    }
    if (el) el.dataset.compositeEditing = "0";
  } else {
    const layer = el?.querySelector<HTMLElement>(".choices-sub-layer");
    // Keep interactive so dblclick on bullets enters group edit (no "screen edit" by accident).
    if (layer) layer.style.pointerEvents = "auto";
    if (el) el.dataset.compositeEditing = "0";
  }
  for (const e2 of compositeHiddenEls) e2.classList.remove("ip-dim-node");
  compositeHiddenEls = [];
  compositeEditTimerId = null;
  compositeEditPath = "";
  compositePathStack.length = 0;
  compositeDrag = null;
  compositeDragMode = "none";
  compositeActiveHandle = null;
  compositeSelectedSubId = null;
  compositeSelectedSubEl = null;
  // Restore mode button label (based on dataset.mode)
  const wrap = document.querySelector<HTMLElement>(".mode-toggle");
  const mode = (wrap?.dataset.mode ?? "edit").toLowerCase();
  const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (btn) btn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
  delete (window as any).__ip_exitCompositeEdit;
  delete (window as any).__ip_compositeEditing;
};

const openCompositeTextEditor = (timerId: string, subEl: HTMLElement) => {
  const layer = engine.getNodeElement(timerId)?.querySelector<HTMLElement>(".timer-sub-layer");
  if (!layer) return;
  const subId = subEl.dataset.subId ?? "";
  if (!subId) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "min(820px, calc(100vw - 40px))";
  modal.style.height = "min(520px, calc(100vh - 40px))";

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<div class="modal-title">Edit text: <code>${subId}</code></div>`;
  const body = document.createElement("div");
  body.style.padding = "14px";
  body.style.display = "grid";
  body.style.gridTemplateRows = "auto 1fr";
  body.style.gap = "12px";

  const taWrap = document.createElement("div");
  taWrap.className = "field";
  taWrap.innerHTML = `<label>Text</label>`;
  const ta = document.createElement("textarea");
  ta.value = subEl.dataset.template ?? "";
  ta.style.width = "100%";
  ta.style.height = "120px";
  ta.style.resize = "vertical";
  taWrap.append(ta);

  const preview = document.createElement("div");
  preview.className = "field";
  preview.innerHTML = `<label>Preview</label>`;
  const pv = document.createElement("div");
  pv.style.border = "1px solid rgba(255,255,255,0.12)";
  pv.style.borderRadius = "12px";
  pv.style.padding = "12px";
  pv.style.minHeight = "120px";
  pv.style.background = "rgba(255,255,255,0.04)";
  pv.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
  pv.style.fontWeight = "400";
  preview.append(pv);

  const renderPreview = () => {
    // In previews, substitute {{name}} with the parent/composite id.
    const templ = applyDataBindings(ta.value, { name: timerId, mean: "-", sigma: "-", count: "-" });
    pv.innerHTML = renderTextWithKatexToHtml(templ).replaceAll("\n", "<br/>");
  };
  ta.addEventListener("input", renderPreview);
  renderPreview();

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";
  footer.style.gap = "10px";
  footer.style.padding = "12px 14px";
  footer.style.borderTop = "1px solid rgba(255,255,255,0.12)";
  const btnCancel = document.createElement("button");
  btnCancel.className = "btn";
  btnCancel.textContent = "Cancel";
  const btnSave = document.createElement("button");
  btnSave.className = "btn primary";
  btnSave.textContent = "Save";
  footer.append(btnCancel, btnSave);

  modal.append(header, body, footer);
  body.append(taWrap, preview);
  backdrop.append(modal);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  btnCancel.addEventListener("click", close);
  modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) close();
  });

  btnSave.addEventListener("click", () => {
    const newText = ta.value.replaceAll("\r\n", "\n");
    subEl.dataset.template = newText;

    // Update the stored elements.pr (single-line text syntax).
    const src = String((layer as any).__elementsPr ?? "");
    const lines = src.split(/\r?\n/);
    const out: string[] = [];
    const re = new RegExp(`^\\s*text\\[name=${subId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*:\\s*(.*)$`);
    let replaced = false;
    for (const ln of lines) {
      if (!replaced && re.test(ln)) {
        out.push(`text[name=${subId}]: ${newText.replaceAll("\n", " ")}`);
        replaced = true;
      } else {
        out.push(ln);
      }
    }
    const nextText = out.join("\n");
    (layer as any).__elementsPr = nextText;

    // Persist elements.pr (and current geoms) to backend.
    const geoms: any = (layer as any).__textGeoms ?? {};
    void _debugCompositeSaveFetch(
      `${BACKEND}/api/composite/save`,
      { compositePath: timerId, geoms, elementsPr: nextText },
      { kind: "timer", where: "text-editor-save", compositePath: timerId }
    );
    close();
  });
};

const openChoicesWheelTextEditor = (pollId: string, subEl: HTMLElement) => {
  const layer = ensureChoicesWheelLayer(engine, pollId);
  if (!layer) return;
  const subId = subEl.dataset.subId ?? "";
  if (!subId) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "min(820px, calc(100vw - 40px))";
  modal.style.height = "min(520px, calc(100vh - 40px))";

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<div class="modal-title">Edit wheel text: <code>${subId}</code></div>`;
  const body = document.createElement("div");
  body.style.padding = "14px";
  body.style.display = "grid";
  body.style.gridTemplateRows = "auto 1fr";
  body.style.gap = "12px";

  const taWrap = document.createElement("div");
  taWrap.className = "field";
  taWrap.innerHTML = `<label>Template</label>`;
  const ta = document.createElement("textarea");
  ta.value = subEl.dataset.template ?? "";
  ta.style.width = "100%";
  ta.style.height = "120px";
  ta.style.resize = "vertical";
  taWrap.append(ta);

  const preview = document.createElement("div");
  preview.className = "field";
  preview.innerHTML = `<label>Preview</label>`;
  const pv = document.createElement("div");
  pv.style.border = "1px solid rgba(255,255,255,0.12)";
  pv.style.borderRadius = "12px";
  pv.style.padding = "12px";
  pv.style.minHeight = "120px";
  pv.style.background = "rgba(255,255,255,0.04)";
  pv.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
  pv.style.fontWeight = "700";
  preview.append(pv);

  const renderPreview = () => {
    const templ = applyDataBindings(ta.value, { label: "Option", percent: 42, votes: 12, totalVotes: 30 });
    pv.innerHTML = renderTextWithKatexToHtml(templ).replaceAll("\n", "<br/>");
  };
  ta.addEventListener("input", renderPreview);
  renderPreview();

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";
  footer.style.gap = "10px";
  footer.style.padding = "12px 14px";
  footer.style.borderTop = "1px solid rgba(255,255,255,0.12)";
  const btnCancel = document.createElement("button");
  btnCancel.className = "btn";
  btnCancel.textContent = "Cancel";
  const btnSave = document.createElement("button");
  btnSave.className = "btn primary";
  btnSave.textContent = "Save";
  footer.append(btnCancel, btnSave);

  modal.append(header, body, footer);
  body.append(taWrap, preview);
  backdrop.append(modal);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  btnCancel.addEventListener("click", close);
  modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) close();
  });

  btnSave.addEventListener("click", () => {
    const newText = ta.value.replaceAll("\r\n", "\n");
    subEl.dataset.template = newText;

    // Update the stored elements.pr (single-line text syntax).
    const src = String((layer as any).__elementsPr ?? "");
    const lines = src.split(/\r?\n/);
    const out: string[] = [];
    const re = new RegExp(`^\\s*text\\[name=${subId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*:\\s*(.*)$`);
    let replaced = false;
    for (const ln of lines) {
      if (!replaced && re.test(ln)) {
        out.push(`text[name=${subId}]: ${newText.replaceAll("\n", " ")}`);
        replaced = true;
      } else {
        out.push(ln);
      }
    }
    if (!replaced) out.push(`text[name=${subId}]: ${newText.replaceAll("\n", " ")}`);
    const nextText = out.join("\n").replaceAll("\r\n", "\n");
    (layer as any).__elementsPr = nextText;

    // Persist elements.pr (and current geoms) to backend.
    const geoms: any = compositeGeomsByPath[`${pollId}/wheel`] ?? (layer as any).__wheelGeoms ?? {};
    void _debugCompositeSaveFetch(
      `${BACKEND}/api/composite/save`,
      { compositePath: `${pollId}/wheel`, geoms, elementsPr: nextText },
      { kind: "choices", where: "wheel-text-editor-save", compositePath: `${pollId}/wheel` }
    );
    close();
  });
};

stage.addEventListener("dblclick", async (ev) => {
  const dbg = ipDebugEnabled("ip_debug_dblclick");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][dblclick] fired", {
      appMode: getAppMode(),
      client: { x: ev.clientX, y: ev.clientY },
      button: (ev as any).button,
      detail: (ev as any).detail,
      targetTag: (ev.target as any)?.tagName,
      targetClass: (ev.target as any)?.className,
      compositeEditTimerId,
      compositeEditKind,
      screenEditMode,
      selected: Array.from(selected)
    });
  }
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  const target = ev.target as HTMLElement;
  // Use dataset selector (more reliable than `.node` which can be missing on inner elements).
  // NOTE: for composite-heavy nodes (timer/sound), sub-elements may not be within a `.node` DOM subtree.
  // So we ALSO fall back to a geometry hit-test across all node bounding boxes.
  const hitNodeEl = target.closest<HTMLElement>("[data-node-id], .node");
  const model = engine.getModel();
  // Composite roots: always prioritize entering group edit when dblclicking inside their effective bbox,
  // even if the underlying DOM hit-test doesn't resolve cleanly (e.g. clicking through overlay chrome/canvas).
  if (!compositeEditTimerId && model) {
    const x = ev.clientX;
    const y = ev.clientY;
  let best: { id: string; kind: "timer" | "sound" | "choices" | "graph"; area: number } | null = null;
    for (const n of model.nodes as any[]) {
      const kind = String(n?.type ?? "");
    if (kind !== "timer" && kind !== "sound" && kind !== "choices" && kind !== "graph") continue;
      const el = engine.getNodeElement(String(n.id));
      if (!el) continue;
      const rotDeg = Number(n?.transform?.rotationDeg ?? 0) || 0;
      const eff = kind === "choices" ? null : effectiveNodeRectClient(el, n);
      const r = eff ?? (el.getBoundingClientRect() as any);
      const rc: any = { left: r.left, top: r.top, right: r.right ?? r.left + r.width, bottom: r.bottom ?? r.top + r.height, width: r.width, height: r.height };
      const hit = isPointInRotatedRectClient(rc, rotDeg, x, y);
      if (dbg) {
        // eslint-disable-next-line no-console
        console.log("[ip][dblclick] candidate", {
          id: String(n.id),
          type: kind,
          rotDeg,
          hit,
          rect: { left: rc.left, top: rc.top, width: rc.width, height: rc.height }
        });
      }
      if (!hit) continue;
      const area = Math.max(1, rc.width * rc.height);
      if (!best || area < best.area) best = { id: String(n.id), kind: kind as any, area };
    }
    if (best) {
      if (dbg) {
        // eslint-disable-next-line no-console
        console.log("[ip][dblclick] entering composite edit", best);
      }
      if (best.kind === "timer") enterTimerCompositeEdit(best.id);
      else if (best.kind === "sound") enterSoundCompositeEdit(best.id);
    else if (best.kind === "graph") enterGraphCompositeEdit(best.id);
      else enterChoicesCompositeEdit(best.id);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
    if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][dblclick] no composite root hit");
    }
  }

  // If a composite root (timer/sound/choices) is selected, double-clicking within its OUTER selection
  // box should always enter group edit (even if the click target is the overlay selection chrome).
  if (!compositeEditTimerId && model && selected.size === 1) {
    const selId = Array.from(selected)[0];
    const selNode: any = model.nodes.find((n: any) => String(n.id) === String(selId));
    const selEl = selNode ? engine.getNodeElement(String(selNode.id)) : null;
    if (selNode && selEl && (selNode.type === "timer" || selNode.type === "sound" || selNode.type === "graph")) {
      const eff = effectiveNodeRectClient(selEl, selNode);
      const rotDeg = Number(selNode?.transform?.rotationDeg ?? 0) || 0;
      if (eff && isPointInRotatedRectClient(eff as any, rotDeg, ev.clientX, ev.clientY)) {
        if (selNode.type === "timer") enterTimerCompositeEdit(String(selNode.id));
        else enterSoundCompositeEdit(String(selNode.id));
        if (selNode.type === "graph") enterGraphCompositeEdit(String(selNode.id));
        (ev as any).stopImmediatePropagation?.();
        ev.preventDefault();
        return;
      }
    }
    if (selNode && selEl && selNode.type === "choices") {
      const r = selEl.getBoundingClientRect();
      const rotDeg = Number(selNode?.transform?.rotationDeg ?? 0) || 0;
      const rc: any = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      if (isPointInRotatedRectClient(rc, rotDeg, ev.clientX, ev.clientY)) {
        enterChoicesCompositeEdit(String(selNode.id));
        (ev as any).stopImmediatePropagation?.();
        ev.preventDefault();
        return;
      }
    }
  }
  const hitNodeIdByRect = (() => {
    if (!model) return null;
    // Prefer the deepest DOM element if it has a node id.
    const domId = (hitNodeEl as any)?.dataset?.nodeId ?? (hitNodeEl as any)?.dataset?.nodeId;
    if (domId) return String(domId);
    const x = ev.clientX;
    const y = ev.clientY;
    let best: { id: string; area: number } | null = null;
    for (const n of model.nodes as any[]) {
      const el = engine.getNodeElement(String(n.id));
      if (!el) continue;
      const rotDeg = Number(n?.transform?.rotationDeg ?? 0) || 0;
      // Use rotated hit-testing so this works for rotated nodes AND composites.
      const eff = effectiveNodeRectClient(el, n);
      const r = eff ?? (el.getBoundingClientRect() as any);
      const rc: any = { left: r.left, top: r.top, right: r.right ?? r.left + r.width, bottom: r.bottom ?? r.top + r.height, width: r.width, height: r.height };
      if (!isPointInRotatedRectClient(rc, rotDeg, x, y)) continue;
      const area = Math.max(1, rc.width * rc.height);
      if (!best || area < best.area) best = { id: String(n.id), area };
    }
    return best?.id ?? null;
  })();
  const hitAnyBBox = !!hitNodeIdByRect;

  // Background double-click behavior:
  // - If in group edit: exit group edit.
  // - Else if in screen edit: exit screen edit.
  // - Else: enter screen edit.
  // IMPORTANT: only treat as "background" if the click is OUTSIDE ALL node bounding boxes.
  if (!hitAnyBBox && !target.closest(".modal") && !target.closest(".ctx-menu") && !target.closest(".edit-toolbox")) {
    // Regular group edit: background dblclick steps back one level (or exits).
    if ((window as any).__ip_exitGroupEdit) {
      groupEdit?.exitOneLevel?.();
      ev.preventDefault();
      return;
    }
    if ((window as any).__ip_exitCompositeEdit) {
      // Nested composite editing: background dblclick steps back one level.
      // If we're already at the root level, this exits group edit.
      exitCompositeLevel();
      ev.preventDefault();
      return;
    }
    if (screenEditMode) {
      exitScreenEdit();
      ev.preventDefault();
      return;
    }
    const currentMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
    if (currentMode === "edit") {
      enterScreenEdit();
      ev.preventDefault();
    }
    return;
  }

  // Regular group edit mode:
  // - If already in group edit: double-click a group to enter nested group edit.
  // - If not in group edit: double-click a group node to enter group edit.
  if (model && hitNodeIdByRect) {
    const rawId = String(hitNodeIdByRect);
    const node: any = model.nodes.find((n: any) => String(n.id) === rawId);
    if (node?.type === "group") {
      groupEdit?.enter?.(rawId);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }

  // In composite edit mode, double-clicking a sub-text should open the text editor (not re-enter composite mode).
  if (compositeEditTimerId && compositeEditKind === "timer") {
    const sub = target.closest<HTMLElement>(".timer-sub-text");
    if (sub) {
      openCompositeTextEditor(compositeEditTimerId, sub);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }
  if (compositeEditTimerId && compositeEditKind === "graph") {
    const sub = target.closest<HTMLElement>(".graph-sub-text");
    if (sub) {
      // Graph uses the same save endpoint as other composites; we persist the edited line into elements.pr.
      const graphId = compositeEditTimerId;
      const layer = engine.getNodeElement(graphId)?.querySelector<HTMLElement>(".graph-sub-layer");
      if (!layer) return;
      const subId = sub.dataset.subId ?? "";
      if (!subId) return;

      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.style.width = "min(820px, calc(100vw - 40px))";
      modal.style.height = "min(520px, calc(100vh - 40px))";

      const header = document.createElement("div");
      header.className = "modal-header";
      header.innerHTML = `<div class="modal-title">Edit text: <code>${subId}</code></div>`;
      const body = document.createElement("div");
      body.style.padding = "14px";
      body.style.display = "grid";
      body.style.gridTemplateRows = "auto 1fr";
      body.style.gap = "12px";

      const taWrap = document.createElement("div");
      taWrap.className = "field";
      taWrap.innerHTML = `<label>Text</label>`;
      const ta = document.createElement("textarea");
      ta.value = sub.dataset.template ?? "";
      ta.style.width = "100%";
      ta.style.height = "120px";
      ta.style.resize = "vertical";
      taWrap.append(ta);

      const preview = document.createElement("div");
      preview.className = "field";
      preview.innerHTML = `<label>Preview</label>`;
      const pv = document.createElement("div");
      pv.style.border = "1px solid rgba(255,255,255,0.12)";
      pv.style.borderRadius = "12px";
      pv.style.padding = "12px";
      pv.style.minHeight = "120px";
      pv.style.background = "rgba(255,255,255,0.04)";
      pv.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
      pv.style.fontWeight = "400";
      preview.append(pv);

      const m0 = engine.getModel();
      const n0: any = m0?.nodes.find((n: any) => String(n.id) === String(graphId));
      const renderPreview = () => {
        const templ = applyDataBindings(ta.value, { name: graphId, xLabel: n0?.xLabel ?? "x", yLabel: n0?.yLabel ?? "y" });
        pv.innerHTML = renderTextWithKatexToHtml(templ).replaceAll("\n", "<br/>");
      };
      ta.addEventListener("input", renderPreview);
      renderPreview();

      const footer = document.createElement("div");
      footer.style.display = "flex";
      footer.style.justifyContent = "flex-end";
      footer.style.gap = "10px";
      footer.style.padding = "12px 14px";
      footer.style.borderTop = "1px solid rgba(255,255,255,0.12)";
      const btnCancel = document.createElement("button");
      btnCancel.className = "btn";
      btnCancel.textContent = "Cancel";
      const btnSave = document.createElement("button");
      btnSave.className = "btn primary";
      btnSave.textContent = "Save";
      footer.append(btnCancel, btnSave);

      modal.append(header, body, footer);
      body.append(taWrap, preview);
      backdrop.append(modal);
      document.body.append(backdrop);

      const close = () => backdrop.remove();
      btnCancel.addEventListener("click", close);
      modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      backdrop.addEventListener("pointerdown", (ev) => {
        if (ev.target === backdrop) close();
      });

      btnSave.addEventListener("click", () => {
        const newText = ta.value.replaceAll("\r\n", "\n");
        sub.dataset.template = newText;

        const src = String((layer as any).__elementsPr ?? "");
        const lines = src.split(/\r?\n/);
        const out: string[] = [];
        const re = new RegExp(`^\\s*text\\[name=${subId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\]\\s*:\\s*(.*)$`);
        let replaced = false;
        for (const ln of lines) {
          if (!replaced && re.test(ln)) {
            out.push(`text[name=${subId}]: ${newText.replaceAll("\n", " ")}`);
            replaced = true;
          } else {
            out.push(ln);
          }
        }
        if (!replaced) out.push(`text[name=${subId}]: ${newText.replaceAll("\n", " ")}`);
        const nextText = out.join("\n").replaceAll("\r\n", "\n");
        (layer as any).__elementsPr = nextText;

        const geoms: any = (layer as any).__textGeoms ?? {};
        void _debugCompositeSaveFetch(
          `${BACKEND}/api/composite/save`,
          { compositePath: graphId, geoms, elementsPr: nextText },
          { kind: "graph", where: "text-editor-save", compositePath: graphId }
        );
        close();
      });

      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }
  if (compositeEditTimerId && compositeEditKind === "choices") {
    // Nested levels: double-click a group container to enter its coordinate system.
    const grp = target.closest<HTMLElement>(".comp-sub");
    if (grp?.dataset.groupPath) {
      enterCompositeLevel(String(grp.dataset.groupPath));
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
    // Double-clicking the bullets element should open the regular editor for the choices node.
    const bulletsEl = target.closest<HTMLElement>(".choices-bullets");
    if (bulletsEl) {
      await openEditorModal(compositeEditTimerId);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
    const sub = target.closest<HTMLElement>(".choices-wheel-text");
    if (sub) {
      openChoicesWheelTextEditor(compositeEditTimerId, sub);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }
  // NOTE:
  // We intentionally DO NOT support nested composite-level editing for timer/sound via dblclick.
  // It was easy to enter the plot level accidentally, which dims/disables the outer labels and feels "broken".
  // Timer/sound composite edit is a single-level workflow (root-only).
  const id = hitNodeIdByRect;
  if (!id || !model) return;
  const node = model.nodes.find((n: any) => String(n.id) === String(id)) as any;

  // Block editing screen elements when not in screen edit mode
  if (!screenEditMode && node && node.space === "screen") {
    ev.preventDefault();
    return;
  }
  // Block editing non-screen elements when in screen edit mode
  if (screenEditMode && node && node.space !== "screen") {
    ev.preventDefault();
    return;
  }

  if (node?.type === "timer") {
    enterTimerCompositeEdit(id);
    ev.preventDefault();
    return;
  }
  if (node?.type === "choices") {
    enterChoicesCompositeEdit(id);
    ev.preventDefault();
    return;
  }
  if (node?.type === "sound") {
    enterSoundCompositeEdit(id);
    ev.preventDefault();
    return;
  }
  if (node?.type === "graph") {
    enterGraphCompositeEdit(id);
    ev.preventDefault();
    return;
  }
  await openEditorModal(id);
});

stage.addEventListener("pointerdown", (ev) => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId) return;
  const t = ev.target as HTMLElement;
  const rootEl = engine.getNodeElement(compositeEditTimerId);
  if (!rootEl) return;
  const layer =
    compositeEditKind === "timer"
      ? rootEl.querySelector<HTMLElement>(".timer-sub-layer")
      : compositeEditKind === "sound"
        ? rootEl.querySelector<HTMLElement>(".sound-sub-layer")
        : compositeEditKind === "graph"
          ? rootEl.querySelector<HTMLElement>(".graph-sub-layer")
        : rootEl.querySelector<HTMLElement>(".choices-sub-layer");
  if (!layer) return;
  // Do NOT enforce a separate composite bbox gate here.
  // It causes valid sub-elements that extend outside the plot/data region to become non-interactive.
  // Background/disabled interactions are handled explicitly elsewhere (compositePan + plot-region/plot-arrow rules).
  // When grabbing resize/rotate handles, NEVER re-pick: handles can sit outside the sub rect,
  // and re-picking makes unrelated elements (e.g. wheel) appear "connected".
  const handleHit = t.closest<HTMLElement>(".handle, .handles, .anchor-dot");
  const directSub = t.closest<HTMLElement>(".comp-sub");
  const sub =
    handleHit && directSub
      ? directSub
      : _pickSmallestCompositeSub(rootEl, ev.clientX, ev.clientY, { activeCompPath: compositeEditPath });
  if (!sub) return;

  // Composite sub-elements: implement our own "double click" for sub-text editing.
  // Native dblclick can be suppressed by pointer capture + preventDefault during composite drag.
  // This makes timer/sound/graph text editing consistent.
  if ((sub.classList.contains("timer-sub-text") || sub.classList.contains("sound-sub-text") || sub.classList.contains("graph-sub-text")) && compositeEditTimerId) {
    const now = performance.now();
    const sid = String(sub.dataset.subId ?? "");
    const prev = (stage as any).__ip_lastCompositeSubClick as
      | { compId: string; subId: string; tMs: number; x: number; y: number }
      | null
      | undefined;
    const dt = prev && prev.compId === compositeEditTimerId && prev.subId === sid ? now - prev.tMs : Infinity;
    const d = prev && prev.compId === compositeEditTimerId && prev.subId === sid ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
    const isDouble = dt <= 350 && d <= 6;
    (stage as any).__ip_lastCompositeSubClick = { compId: compositeEditTimerId, subId: sid, tMs: now, x: ev.clientX, y: ev.clientY };
    if (isDouble) {
      (stage as any).__ip_lastCompositeSubClick = null;
      if (sub.classList.contains("timer-sub-text") && compositeEditKind === "timer") {
        openCompositeTextEditor(compositeEditTimerId, sub);
      } else if (sub.classList.contains("graph-sub-text") && compositeEditKind === "graph") {
        // Reuse the dblclick handler behavior by dispatching a dblclick event won’t work reliably,
        // so we call the same editor path directly (implemented in the dblclick handler).
        const fake = new MouseEvent("dblclick", { clientX: ev.clientX, clientY: ev.clientY, bubbles: true, cancelable: true });
        // Let the existing stage dblclick handler open the graph text editor (it checks compositeEditKind/id).
        stage.dispatchEvent(fake);
      } else if (sub.classList.contains("sound-sub-text") && compositeEditKind === "sound") {
        // Sound composite doesn't currently have a dedicated text editor; fall back to no-op for now.
      }
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }
  const dbg = ipDebugEnabled("ip_debug_composite_drag");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][composite][drag] pointerdown pick", {
      activePath: compositeEditPath,
      targetCls: String((t as any)?.className ?? ""),
      picked: { subId: sub.dataset.subId, kind: sub.dataset.kind, compPath: sub.dataset.compPath, cls: sub.className },
      client: { x: ev.clientX, y: ev.clientY },
    });
  }
  // Lock plot/data region (reference system) in group edit: not selectable/movable.
  if (sub.dataset.kind === "plot-region") {
    // Treat non-editable/disabled sub-elements as background: allow panning.
    return;
  }
  // If the user is grabbing the root node handles, let the normal editor handle it.
  if (t.closest(".node > .handles")) return;
  // When selecting a sub-element, clear root selection so the transform UI follows the sub-element.
  clearSelection();
  compositeEditPath = String(sub.dataset.compPath || compositeEditTimerId);
  const timerEl = engine.getNodeElement(compositeEditTimerId);
  if (!timerEl) return;
  const subId = sub.dataset.subId ?? "";
  compositeSelectedSubId = subId;
  compositeSelectedSubEl = sub;
  for (const e of Array.from(timerEl.querySelectorAll<HTMLElement>(".comp-sub"))) e.classList.remove("is-selected");
  sub.classList.add("is-selected");
  // If selecting anything other than a plot-arrow, clear plot-arrow selection glow.
  if (!(sub.dataset.kind === "plot-arrow" && (compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph"))) {
    delete (layer.dataset as any).selectedPlotArrowId;
    if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
    else if (compositeEditKind === "sound") renderSoundCompositeArrows(timerEl, layer);
    else if (compositeEditKind === "graph") renderGraphCompositeArrows(timerEl, layer);
  }

  // Composite axis arrows (timer/sound): drag endpoints in plot coords (no bbox handles).
  if ((compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph") && sub.dataset.kind === "plot-arrow") {
    const specs: any[] = (layer as any).__arrowSpecs ?? [];
    if (!Array.isArray(specs) || specs.length === 0) return;
    const requestedArrowId = String(sub.dataset.arrowId ?? "");
    // Store selection for rendering (glow on SVG line, no bbox).
    if (requestedArrowId) {
      layer.dataset.selectedPlotArrowId = requestedArrowId;
      if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
      else if (compositeEditKind === "sound") renderSoundCompositeArrows(timerEl, layer);
      else renderGraphCompositeArrows(timerEl, layer);
    } else {
      delete (layer.dataset as any).selectedPlotArrowId;
    }
    const { ox, oy, xLen, yLen } = _plotRectCss(timerEl);
    const toClient = (u: number, vUp: number) => ({ x: ox + u * xLen, y: oy - vUp * yLen });
    const px = ev.clientX;
    const py = ev.clientY;
    let best: { id: string; end: "p1" | "p2"; d2: number } | null = null;
    for (const a of specs) {
      const id = String(a?.id ?? "");
      if (!id) continue;
      if (requestedArrowId && id !== requestedArrowId) continue;
      const p1 = toClient(Number(a.x0 ?? 0), Number(a.y0 ?? 0));
      const p2 = toClient(Number(a.x1 ?? 1), Number(a.y1 ?? 0));
      const d1 = (p1.x - px) ** 2 + (p1.y - py) ** 2;
      const d2 = (p2.x - px) ** 2 + (p2.y - py) ** 2;
      const pick = d1 <= d2 ? { id, end: "p1" as const, d2: d1 } : { id, end: "p2" as const, d2 };
      if (!best || pick.d2 < best.d2) best = pick;
    }
    const THRESH_PX = 32;
    const nearEndpoint = !!best && best.d2 <= THRESH_PX * THRESH_PX;
    const arrowId = requestedArrowId || best?.id || "";
    if (!arrowId) return;
    const spec = specs.find((a: any) => String(a?.id ?? "") === arrowId);
    if (!spec) return;
    compositeEditPath = compositeEditTimerId;
    compositeStartGeom = { x: 0, y: 0, w: 1, h: 1, rotationDeg: 0, anchor: "topLeft", align: "left" };
    compositeStart = { x: ev.clientX, y: ev.clientY };
    compositeDragMode = "arrow";
    compositeArrowDrag = nearEndpoint
      ? { arrowId, end: best!.end, startClientX: ev.clientX, startClientY: ev.clientY }
      : {
          // Mid-drag: translate the whole arrow in plot coords.
          arrowId,
          end: "mid",
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startX0: Number(spec.x0 ?? 0),
          startY0: Number(spec.y0 ?? 0),
          startX1: Number(spec.x1 ?? 1),
          startY1: Number(spec.y1 ?? 0)
        };
    setBodyCursor(nearEndpoint ? "crosshair" : "grabbing");
    stage.setPointerCapture?.(ev.pointerId);
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
    return;
  }

  ensureHandles(sub);

  // Parent-relative coordinates:
  // - If compPath is nested (e.g. "<id>/bullets"), normalize within that group's box.
  // - Otherwise normalize within the root node box.
  const groupBoxEl =
    compositeEditPath.includes("/")
      ? (timerEl.querySelector<HTMLElement>(`[data-group-path="${compositeEditPath}"]`) ?? timerEl)
      : timerEl;
  const box = groupBoxEl.getBoundingClientRect();

  const geoms: Record<string, any> = (compositeGeomsByPath[compositeEditPath] ??= {});
  const g0 = geoms[subId] ?? {};
  const r = sub.getBoundingClientRect();
  const baseX = Number(sub.dataset.baseX ?? "NaN");
  const baseY = Number(sub.dataset.baseY ?? "NaN");
  const isChoicesWheelLabel =
    compositeEditKind === "choices" && compositeEditPath.endsWith("/wheel") && Number.isFinite(baseX) && Number.isFinite(baseY);
  const handleEl = t.closest<HTMLElement>(".handle");
  const anchorEl = t.closest<HTMLElement>(".anchor-dot");
  if (anchorEl?.dataset.anchor) {
    // Re-anchor without snapping (keep top-left fixed)
    const newAnchor = anchorEl.dataset.anchor;
    const startAnchor = sub.dataset.anchor ?? "centerCenter";
    const x = Number(sub.style.left.replace("%", "")) / 100;
    const y = Number(sub.style.top.replace("%", "")) / 100;
    const w = Number(sub.style.width.replace("%", "")) / 100;
    const h = Number(sub.style.height.replace("%", "")) / 100;
    const topLeft = anchorToTopLeftWorld({ x, y, w, h, anchor: startAnchor } as any);
    const newPos = topLeftToAnchorWorld({ x: topLeft.x, y: topLeft.y, w, h }, newAnchor);
    sub.dataset.anchor = newAnchor;
    sub.style.left = `${newPos.x * 100}%`;
    sub.style.top = `${newPos.y * 100}%`;
    ensureHandles(sub);
    // For dynamic wheel labels, store offsets from the computed base anchor (not absolute coords).
    if (isChoicesWheelLabel && subId) {
      const ox = newPos.x - baseX;
      const oy = newPos.y - baseY;
      geoms[subId] = { ...(geoms[subId] ?? {}), x: ox, y: oy, anchor: newAnchor };
    }
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
    return;
  }

  compositeStart = { x: ev.clientX, y: ev.clientY };
  compositeStartGeom = {
    // Source of truth is the stored geom (prevents jitter from DOM rect measurement).
    x: Number(
      isChoicesWheelLabel
        ? baseX + Number(g0.x ?? (r.left + r.width / 2 - box.left) / box.width - baseX)
        : (g0.x ?? (r.left + r.width / 2 - box.left) / box.width)
    ),
    y: Number(
      isChoicesWheelLabel
        ? baseY + Number(g0.y ?? (r.top + r.height / 2 - box.top) / box.height - baseY)
        : (g0.y ?? (r.top + r.height / 2 - box.top) / box.height)
    ),
    w: Number(g0.w ?? r.width / box.width),
    h: Number(g0.h ?? r.height / box.height),
    rotationDeg: Number(g0.rotationDeg ?? (Number((sub.style.rotate || "0deg").replace("deg", "")) || 0)),
    anchor: String(g0.anchor ?? sub.dataset.anchor ?? "centerCenter"),
    align: String(g0.align ?? (sub.style.textAlign || "center"))
  };
  // Hard guarantee: the choices wheel group must ALWAYS render as a true circle.
  // That means the wheel box must be pixel-square, which requires wFrac != hFrac when the parent box isn't square.
  if (compositeEditKind === "choices" && subId === "wheel") {
    const aspect = box.width / Math.max(1e-9, box.height);
    const wPx = compositeStartGeom.w * box.width;
    const hPx = compositeStartGeom.h * box.height;
    const sPx = Math.max(8, Math.min(wPx, hPx));
    const wFrac = sPx / box.width;
    const hFrac = sPx / box.height;
    compositeStartGeom.w = wFrac;
    compositeStartGeom.h = hFrac;
    sub.style.width = `${wFrac * 100}%`;
    sub.style.height = `${hFrac * 100}%`;
    // Keep anchor point stable; store the corrected square-in-pixels fractions.
    if (subId) geoms[subId] = { ...(geoms[subId] ?? {}), w: wFrac, h: hFrac };
    // (aspect is only used for reasoning; wFrac/hFrac already encode it)
    void aspect;
  }
  // Preserve cursor-to-anchor offset to avoid the “jump” on drag start.
  const px = (ev.clientX - box.left) / box.width;
  const py = (ev.clientY - box.top) / box.height;
  compositeGrabOff = { x: px - compositeStartGeom.x, y: py - compositeStartGeom.y };

  if (handleEl?.dataset.handle) {
    compositeActiveHandle = handleEl.dataset.handle;
    // Handle naming matches `ensureHandles()`:
    // - rot / rot-tl / rot-tr => rotate
    // - n/e/s/w/sw/se => resize
    compositeDragMode = compositeActiveHandle === "rot" || compositeActiveHandle.startsWith("rot-") ? "rotate" : "resize";
    setBodyCursor(cursorForHandle(compositeActiveHandle));
    if (compositeDragMode === "rotate") {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      compositeStartAngleRad = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      compositeStartRotationDeg = compositeStartGeom.rotationDeg;
    }
  } else {
    compositeDragMode = "move";
    sub.style.cursor = "grabbing";
  }
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][composite][drag] start", {
      mode: compositeDragMode,
      handle: compositeActiveHandle,
      subId,
      path: compositeEditPath,
    });
  }
  // Capture on stage so dragging continues even when the pointer leaves the element/hit region.
  stage.setPointerCapture?.(ev.pointerId);
  // Prevent the normal selection/rotate handler from selecting the timer node while we're editing sub-elements.
  (ev as any).stopImmediatePropagation?.();
  ev.preventDefault();
});

stage.addEventListener("pointermove", (ev) => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId || compositeDragMode === "none" || !compositeSelectedSubEl || !compositeStartGeom) return;
  const dbg = ipDebugEnabled("ip_debug_composite_drag");
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log("[ip][composite][drag] move", {
      mode: compositeDragMode,
      subId: compositeSelectedSubEl?.dataset?.subId,
      path: compositeEditPath,
      client: { x: ev.clientX, y: ev.clientY },
    });
  }
  const timerEl = engine.getNodeElement(compositeEditTimerId);
  if (!timerEl) return;
  const sub = compositeSelectedSubEl;
  const groupBoxEl =
    compositeEditPath.includes("/")
      ? (timerEl.querySelector<HTMLElement>(`[data-group-path="${compositeEditPath}"]`) ?? timerEl)
      : timerEl;
  const box = groupBoxEl.getBoundingClientRect();
  const geoms: Record<string, any> = (compositeGeomsByPath[compositeEditPath] ??= {});
  const sid = sub.dataset.subId ?? "";
  const baseX = Number(sub.dataset.baseX ?? "NaN");
  const baseY = Number(sub.dataset.baseY ?? "NaN");
  const isChoicesWheelLabel =
    compositeEditKind === "choices" && compositeEditPath.endsWith("/wheel") && Number.isFinite(baseX) && Number.isFinite(baseY);
  const dx = (ev.clientX - compositeStart.x) / box.width;
  const dy = (ev.clientY - compositeStart.y) / box.height;

  if (compositeDragMode === "arrow" && compositeArrowDrag) {
    const cad = compositeArrowDrag;
    if (!(compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph")) return;
    const layer =
      compositeEditKind === "timer"
        ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
        : compositeEditKind === "sound"
          ? timerEl.querySelector<HTMLElement>(".sound-sub-layer")
          : timerEl.querySelector<HTMLElement>(".graph-sub-layer");
    if (!layer) return;
    const specs: any[] = (layer as any).__arrowSpecs ?? [];
    if (!Array.isArray(specs) || specs.length === 0) return;
    const spec = specs.find((a: any) => String(a?.id ?? "") === cad.arrowId);
    if (!spec) return;

    const { ox, oy, xLen, yLen } = _plotRectCss(timerEl);
    const clampU = (u: number) => Math.max(-1, Math.min(2, u));
    if (cad.end === "mid") {
      const du = (ev.clientX - cad.startClientX) / Math.max(1e-9, xLen);
      const dv = (cad.startClientY - ev.clientY) / Math.max(1e-9, yLen); // vUp delta
      const x0 = Number(cad.startX0 ?? spec.x0 ?? 0);
      const y0 = Number(cad.startY0 ?? spec.y0 ?? 0);
      const x1 = Number(cad.startX1 ?? spec.x1 ?? 1);
      const y1 = Number(cad.startY1 ?? spec.y1 ?? 0);
      spec.x0 = clampU(x0 + du);
      spec.y0 = clampU(y0 + dv);
      spec.x1 = clampU(x1 + du);
      spec.y1 = clampU(y1 + dv);
    } else {
    const u = (ev.clientX - ox) / Math.max(1e-9, xLen);
    const vUp = (oy - ev.clientY) / Math.max(1e-9, yLen);
      const uu = clampU(u);
      const vv = clampU(vUp);
    if (cad.end === "p1") {
      spec.x0 = uu;
      spec.y0 = vv;
    } else {
      spec.x1 = uu;
      spec.y1 = vv;
      }
    }

    const fmt = (n: number) => {
      if (!Number.isFinite(n)) return "0";
      const t = Math.round(n * 1e6) / 1e6;
      return String(t);
    };
    const id = String(spec.id ?? "");
    const color = String(spec.color ?? "white");
    const width = Number.isFinite(Number(spec.width)) ? Number(spec.width) : 0.006;
    const nextLine = `arrow[name=${id},from=(${fmt(spec.x0)},${fmt(spec.y0)}),to=(${fmt(spec.x1)},${fmt(spec.y1)}),color=${color},width=${fmt(width)}]`;

    const src = String((layer as any).__elementsPr ?? "");
    const lines = src.split(/\\r?\\n/);
    const out: string[] = [];
    const re = new RegExp(`^\\\\s*arrow\\\\[name=${id.replace(/[.*+?^${}()|[\\\\]\\\\\\\\]/g, "\\\\$&")},.*\\\\]\\\\s*$`);
    let replaced = false;
    for (const ln of lines) {
      if (!replaced && re.test(ln.trim())) {
        out.push(nextLine);
        replaced = true;
      } else {
        out.push(ln);
      }
    }
    if (!replaced) out.push(nextLine);
    // IMPORTANT: join with REAL newlines. Using "\\n" writes literal backslash-n into elements.pr,
    // which then explodes into invalid PR content on subsequent edits.
    (layer as any).__elementsPr = out.join("\n");

    if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
    else renderSoundCompositeArrows(timerEl, layer);
    return;
  }

  if (compositeDragMode === "move") {
    const px = (ev.clientX - box.left) / box.width;
    const py = (ev.clientY - box.top) / box.height;
    let nx = px - compositeGrabOff.x;
    let ny = py - compositeGrabOff.y;
    if (ev.shiftKey) {
      // Snap to WORLD grid (same as root mode), projected into the active composite level box.
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const stageRect = stage.getBoundingClientRect();
      // Box top-left in stage screen coords:
      const boxTLScreen = { x: box.left - stageRect.left, y: box.top - stageRect.top };
      const boxTLWorld = screenToWorld(boxTLScreen, cam as any, scr as any);
      const worldW = box.width / Math.max(1e-9, cam.zoom);
      const worldH = box.height / Math.max(1e-9, cam.zoom);
      // Current anchor in world coords:
      const axW = boxTLWorld.x + nx * worldW;
      const ayW = boxTLWorld.y + ny * worldH;
      const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
      const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
      const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
      const sxW = snap(axW);
      const syW = snap(ayW);
      nx = (sxW - boxTLWorld.x) / Math.max(1e-9, worldW);
      ny = (syW - boxTLWorld.y) / Math.max(1e-9, worldH);
    }
    sub.style.left = `${nx * 100}%`;
    sub.style.top = `${ny * 100}%`;
    if (sid) {
      if (isChoicesWheelLabel) geoms[sid] = { ...(geoms[sid] ?? {}), x: nx - baseX, y: ny - baseY };
      else geoms[sid] = { ...(geoms[sid] ?? {}), x: nx, y: ny };
    }
    return;
  }

  if (compositeDragMode === "rotate") {
    const r = sub.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
    const ddeg = (a1 - compositeStartAngleRad) * (180 / Math.PI);
    let rot = compositeStartRotationDeg + ddeg;
    if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
    sub.style.rotate = `${rot}deg`;
    if (sid) geoms[sid] = { ...(geoms[sid] ?? {}), rotationDeg: rot };
    return;
  }

  if (compositeDragMode === "resize" && compositeActiveHandle) {
    // Resize in normalized timer coords (ignoring rotation, like the main editor).
    let rect = { x: compositeStartGeom.x, y: compositeStartGeom.y, w: compositeStartGeom.w, h: compositeStartGeom.h };
    const min = 0.01;
    const hnd = compositeActiveHandle;
    const isCorner = hnd === "nw" || hnd === "ne" || hnd === "sw" || hnd === "se";
    const forceUniform = compositeEditKind === "choices" && (sid === "wheel" || sid === "pie"); // keep wheel aspect
    const forceWheelCircle = compositeEditKind === "choices" && sid === "wheel";

    // Convert anchor-point rect -> top-left rect for resizing math
    const tl = anchorToTopLeftWorld({ ...rect, anchor: compositeStartGeom.anchor } as any);
    let tlr = { x: tl.x, y: tl.y, w: rect.w, h: rect.h };

    if (isCorner || forceUniform) {
      // Uniform scale for bottom corners (equal aspect ratio)
      const sx =
        hnd.includes("w") ? -dx : hnd.includes("e") ? dx : 0;
      const sy =
        hnd.includes("n") ? -dy : hnd.includes("s") ? dy : 0;
      const w1 = Math.max(min, rect.w + sx);
      const h1 = Math.max(min, rect.h + sy);
      // If we're forcing uniform scaling from an edge, scale from that axis only.
      let s = isCorner ? Math.max(w1 / Math.max(1e-9, rect.w), h1 / Math.max(1e-9, rect.h)) : (sx !== 0 ? w1 / Math.max(1e-9, rect.w) : h1 / Math.max(1e-9, rect.h));
      if (ev.shiftKey) {
        const step = 0.05;
        s = Math.max(step, Math.round(s / step) * step);
      }
      tlr.w = Math.max(min, rect.w * s);
      tlr.h = Math.max(min, rect.h * s);
      if (hnd.includes("w")) tlr.x = tl.x + (rect.w - tlr.w);
      if (hnd.includes("n")) tlr.y = tl.y + (rect.h - tlr.h);
    } else {
      // Free edge resize (aspect ratio can change)
      if (hnd.includes("w")) {
        tlr.x += dx;
        tlr.w -= dx;
      }
      if (hnd.includes("e")) {
        tlr.w += dx;
      }
      if (hnd.includes("n")) {
        tlr.y += dy;
        tlr.h -= dy;
      }
      if (hnd.includes("s")) {
        tlr.h += dy;
      }
    }
    tlr.w = Math.max(min, tlr.w);
    tlr.h = Math.max(min, tlr.h);
    if (forceWheelCircle) {
      // Pixel-square enforcement:
      // wFrac*boxW == hFrac*boxH  =>  wFrac == hFrac*(boxH/boxW)
      const sPx = Math.max(8, Math.max(tlr.w * box.width, tlr.h * box.height));
      const wNew = sPx / box.width;
      const hNew = sPx / box.height;
      // Anchor opposite edges relative to the original top-left rect (tl).
      const w0 = rect.w;
      const h0 = rect.h;
      if (hnd.includes("w")) tlr.x = tl.x + (w0 - wNew);
      if (hnd.includes("n")) tlr.y = tl.y + (h0 - hNew);
      tlr.w = wNew;
      tlr.h = hNew;
    }

    // Back to anchor point
    const ap = topLeftToAnchorWorld(tlr, compositeStartGeom.anchor);
    rect = { x: ap.x, y: ap.y, w: tlr.w, h: tlr.h };

    sub.style.left = `${rect.x * 100}%`;
    sub.style.top = `${rect.y * 100}%`;
    sub.style.width = `${rect.w * 100}%`;
    sub.style.height = `${rect.h * 100}%`;
    if (sid) geoms[sid] = { ...(geoms[sid] ?? {}), x: rect.x, y: rect.y, w: rect.w, h: rect.h };

    // Choices composite: scale bullets content ONLY for corner scaling (pure scale).
    // Edge resizing should not change text layout; it should only change the box.
    if (compositeEditKind === "choices" && sid === "bullets" && isCorner) {
      const baseW = Number(sub.dataset.baseW ?? String(compositeStartGeom.w ?? rect.w));
      const baseH = Number(sub.dataset.baseH ?? String(compositeStartGeom.h ?? rect.h));
      // Seed base sizes once (so scaling works both up and down).
      if (!Number.isFinite(Number(sub.dataset.baseW))) sub.dataset.baseW = String(baseW);
      if (!Number.isFinite(Number(sub.dataset.baseH))) sub.dataset.baseH = String(baseH);
      const sx = rect.w / Math.max(1e-9, baseW);
      const sy = rect.h / Math.max(1e-9, baseH);
      // Use uniform scale factor (corner scaling is uniform when isCorner is true).
      // This keeps wrapping behavior stable: width/height/font scale together.
      const localScale = Math.max(0.1, Math.max(sx, sy));
      sub.style.setProperty("--local-scale", String(localScale));
    }
    return;
  }
});

stage.addEventListener("pointerup", () => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId) return;
  const timerEl = engine.getNodeElement(compositeEditTimerId);
  if (!timerEl) return;
  // Only persist when a drag actually happened; otherwise we'll spam saves and may send an empty path.
  if (compositeDragMode === "none") return;
  if (!compositeEditPath) return;
  if (compositeSelectedSubEl) compositeSelectedSubEl.style.cursor = "grab";

  // Persist composite geometries from the in-memory model (no DOM-rect measuring -> no jitter / size drift).
  const geoms: any = compositeGeomsByPath[compositeEditPath] ?? {};
  const payload: any = { compositePath: compositeEditPath, geoms };
  // Always persist geoms for the ACTIVE level.
  void _debugCompositeSaveFetch(`${BACKEND}/api/composite/save`, payload, {
    kind: compositeEditKind,
    where: "composite-pointerup",
    compositePath: compositeEditPath
  });

  // Timer/sound: axis arrow edits mutate the ROOT elements.pr regardless of which level is active.
  // (Arrows are currently authored in `groups/<id>/elements.pr`, not in `plot/elements.pr`.)
  if ((compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph") && compositeEditTimerId) {
    const layer =
      compositeEditKind === "timer"
        ? engine.getNodeElement(compositeEditTimerId)?.querySelector<HTMLElement>(".timer-sub-layer")
        : compositeEditKind === "sound"
          ? engine.getNodeElement(compositeEditTimerId)?.querySelector<HTMLElement>(".sound-sub-layer")
          : engine.getNodeElement(compositeEditTimerId)?.querySelector<HTMLElement>(".graph-sub-layer");
    const elementsPr = String((layer as any)?.__elementsPr ?? "");
    if (elementsPr.trim()) {
      void _debugCompositeSaveFetch(
        `${BACKEND}/api/composite/save`,
        { compositePath: compositeEditTimerId, geoms: compositeGeomsByPath[compositeEditTimerId] ?? {}, elementsPr },
        { kind: compositeEditKind, where: "composite-pointerup-elementsPr", compositePath: compositeEditTimerId }
      );
    }
  }

  compositeDragMode = "none";
  compositeActiveHandle = null;
  compositeStartGeom = null;
  compositeArrowDrag = null;
  setBodyCursor("");
});

// Composite edit background panning:
// When in group mode, dragging on "disabled"/non-editable parts should behave like background and pan.
// Examples:
// - timer/sound plot canvas region
// - plot-arrow hitboxes when not near endpoints
// - any empty space inside the isolated node
let compositePan:
  | null
  | {
      pointerId: number;
      lastX: number;
      lastY: number;
    } = null;
const startCompositePan = (ev: PointerEvent) => {
  // Treat background pan as "deselect current sub-element".
  // This matches normal editor behavior: click empty space clears selection.
  clearCompositeSubSelection();
  compositePan = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
  setBodyCursor("grabbing");
  try {
    stage.setPointerCapture?.(ev.pointerId);
  } catch {
    // ignore
  }
};
const stopCompositePan = () => {
  if (!compositePan) return;
  compositePan = null;
  setBodyCursor("");
};
stage.addEventListener(
  "pointerdown",
  (ev) => {
    if (getAppMode() !== "edit") return;
    if (!compositeEditTimerId) return;
    if (ev.button !== 0) return;
    if (compositePan) return;
    // If the user is actively manipulating a sub-element/handle, do NOT pan.
    const t = ev.target as HTMLElement;
    if (t.closest(".handle") || t.closest(".anchor-dot")) return;

    const rootEl = engine.getNodeElement(compositeEditTimerId);
    if (!rootEl) return;

    // IMPORTANT:
    // Do NOT use the raw event target to decide pan vs select; disabled layers (canvas/plot)
    // may be the event target even when a selectable `.comp-sub` is geometrically under the cursor.
    // Instead: pick the smallest composite sub by bbox and only pan if nothing selectable exists.
  const picked = _pickSmallestCompositeSub(rootEl, ev.clientX, ev.clientY, { activeCompPath: compositeEditPath });
    const kind = String(picked?.dataset.kind ?? "");
    const dbg = ipDebugEnabled("ip_debug_composite_hit");
    if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][composite][hit] pan-check", {
        activePath: compositeEditPath,
        picked: picked
          ? { subId: picked.dataset.subId, kind: picked.dataset.kind, compPath: picked.dataset.compPath, cls: picked.className }
          : null,
        client: { x: ev.clientX, y: ev.clientY },
      });
    }
    if (picked && kind !== "plot-region") {
    // Plot arrows: behave like normal arrows in root mode (selectable in the middle too).
      if (kind === "plot-arrow" && (compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph")) {
            return;
      } else {
        // Any normal selectable sub (text/buttons/etc): do NOT pan.
        // NOTE: most selectable elements don't set data-kind, so `kind === ""` is normal here.
        return;
      }
    }

    // No selectable sub under cursor (or plot-region / non-endpoint arrow): pan.
    startCompositePan(ev);
    if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][composite][hit] start-pan", { activePath: compositeEditPath });
    }
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
  },
  { capture: true }
);
stage.addEventListener(
  "pointermove",
  (ev) => {
    if (!compositePan) return;
    if (getAppMode() !== "edit") return;
    if (!compositeEditTimerId) return;
    const cam = engine.getCamera();
    const dx = ev.clientX - compositePan.lastX;
    const dy = ev.clientY - compositePan.lastY;
    compositePan.lastX = ev.clientX;
    compositePan.lastY = ev.clientY;
    engine.setCamera({ cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom, zoom: cam.zoom });
    ev.preventDefault();
  },
  { capture: true }
);
window.addEventListener("pointerup", () => stopCompositePan(), { capture: true });
window.addEventListener("pointercancel", () => stopCompositePan(), { capture: true });

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    (window as any).__ip_exitCompositeEdit?.();
    (window as any).__ip_exitGroupEdit?.();
  }
});


  // Public API back to the host.
  return {
    enterCompositeEdit: (type: string, id: string) => {
      const t = String(type);
      if (!id) return;
      if (t === "timer") enterTimerCompositeEdit(String(id));
      else if (t === "sound") enterSoundCompositeEdit(String(id));
      else if (t === "graph") enterGraphCompositeEdit(String(id));
      else if (t === "choices") enterChoicesCompositeEdit(String(id));
    },
    enterScreenEdit,
    exitScreenEdit,
    isScreenEditMode: () => !!screenEditMode,
    getCompositeState: () => ({ id: compositeEditTimerId, kind: compositeEditKind, path: compositeEditPath }),
  };
}
