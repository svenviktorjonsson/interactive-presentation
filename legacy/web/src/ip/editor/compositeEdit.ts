/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
// Extracted from bootstrap.ts (composite edit + screen edit)
// NOTE: Still intentionally flexible typing; goal is strict TS compile without suppressing typechecking.
import type { Engine } from "@interactive/engine";

export type CompositeKind = "timer" | "choices" | "sound" | "graph";

export type CompositeState = { id: string | null; kind: CompositeKind; path: string };

export type CompositeEditController = {
  enterCompositeEdit: (type: CompositeKind, id: string) => void;
  exitCompositeEdit: () => void;
  enterScreenEdit: () => void;
  exitScreenEdit: () => void;
  isScreenEditMode: () => boolean;
  getCompositeState: () => CompositeState;
  handlers?: {
    onPointerDownCapture: (ev: PointerEvent) => boolean;
    onPointerMoveCapture: (ev: PointerEvent) => boolean;
    onPointerUpCapture: (ev: PointerEvent) => boolean;
    onPointerCancelCapture: (ev: PointerEvent) => boolean;
  };
};

export type CompositeEditControllerDeps = {
  engine: Engine;
  stage: HTMLElement;
  BACKEND: string;
  getAppMode: () => "edit" | "live";
  cloneModel: (m: any) => any;
  commit: (before: any | null) => Promise<void>;

  selected: Set<string>;
  clearSelection: () => void;
  applySelection: () => void;
  openEditorModal: (nodeId: string) => Promise<void>;
  ensureHandles: (el: HTMLElement) => void;
  cursorForHandle: (h: string | null, rotDeg?: number) => string;
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
  const cloneModel: (m: any) => any = o.cloneModel;
  const commit: (before: any | null) => Promise<void> = o.commit;

  const selected: Set<string> = o.selected;
  const clearSelection: () => void = o.clearSelection;
  const applySelection: () => void = o.applySelection;
  const openEditorModal: (nodeId: string) => Promise<void> = o.openEditorModal;
  const ensureHandles: (el: HTMLElement) => void = o.ensureHandles;
  const cursorForHandle: (h: string | null, rotDeg?: number) => string = o.cursorForHandle;
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
  let screenRegularDimmedEls: HTMLElement[] = [];
  let enterScreenEdit: () => void = () => {};
  let exitScreenEdit: () => void = () => {};

  const clearDimmed = (els: HTMLElement[]) => {
    for (const e of els) {
      e.classList.remove("ip-dim-node");
      if (e.style.pointerEvents === "none") e.style.pointerEvents = "";
    }
    els.length = 0;
  };

  const applyScreenEditDimming = (isScreenEdit: boolean) => {
    // Only apply dimming in regular edit mode; live mode should show everything.
    if (getAppMode() !== "edit") {
      clearDimmed(screenDimmedEls);
      clearDimmed(screenRegularDimmedEls);
      return;
    }
    const model = engine.getModel();
    if (!model) return;
    if (isScreenEdit) {
      clearDimmed(screenRegularDimmedEls);
      clearDimmed(screenDimmedEls);
      for (const n of model.nodes ?? []) {
        const el = engine.getNodeElement(n.id);
        if (!el) continue;
        if (n.space === "screen") {
          el.classList.remove("ip-dim-node");
          el.style.pointerEvents = "auto";
          continue;
        }
        el.classList.add("ip-dim-node");
        el.style.pointerEvents = "none";
        screenDimmedEls.push(el);
      }
      return;
    }
    clearDimmed(screenDimmedEls);
    clearDimmed(screenRegularDimmedEls);
    for (const n of model.nodes ?? []) {
      if (n.space !== "screen") continue;
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      el.classList.add("ip-dim-node");
      el.style.pointerEvents = "none";
      screenRegularDimmedEls.push(el);
    }
  };

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
let compositeDragMode: "none" | "move" | "resize" | "rotate" | "arrow" | "split" = "none";
let compositeActiveHandle: string | null = null;
let compositeStart = { x: 0, y: 0 };
let compositeStartGeom: any = null;
let compositeGrabOff = { x: 0, y: 0 };
let compositeStartAngleRad = 0;
let compositeStartRotationDeg = 0;

// Undo/redo integration:
// - Capture a snapshot at drag start
// - Commit ONE history entry on pointerup if anything actually changed
let compositeBeforeModel: any | null = null;
let compositeDirty = false;
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

let compositeSplitDrag:
  | null
  | {
      subId: string;
      dir: "v" | "h";
      idx: number;
      start: number[];
      boxEl: HTMLElement;
      rotDeg: number;
    } = null;

const _escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const _quoteIfNeeded = (s0: string) => {
  const s = String(s0 ?? "");
  const needs = s.length === 0 || /[,\]\r\n]/.test(s);
  if (!needs) return s;
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

const _fmtPrList = (items: string[]) => `[${items.map(_quoteIfNeeded).join(", ")}]`;

const _fmtNumList = (items: number[]) => {
  const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
  return `[${(items ?? []).map((n) => fmt(Number(n))).join(", ")}]`;
};

const _readJsonArr = (raw: any): any[] => {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const _updateButtonsElementsPr = (
  layer: HTMLElement,
  subId: string,
  patch: Partial<{
    labels: string[];
    actions: string[];
    vSplits: number[];
    hSplits: number[];
    fontScale: number;
    orientation: string;
  }>
) => {
  const src = String((layer as any).__elementsPr ?? "");
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  const idEsc = _escapeRe(subId);
  const isThisButtonsLine = (ln: string) => /^\s*buttons\[/.test(ln) && new RegExp(`\\bname=${idEsc}\\b`).test(ln);
  let replaced = false;
  for (const ln of lines) {
    if (!replaced && isThisButtonsLine(ln)) {
      const orientation = String(patch.orientation ?? (ln.match(/\borientation=([a-zA-Z]+)/)?.[1] ?? "h"));
      const labels = patch.labels ?? _readJsonArr((layer.querySelector<HTMLElement>(`.comp-sub[data-sub-id="${subId}"]`) as any)?.dataset?.templates).map(String);
      const actions = patch.actions ?? _readJsonArr((layer.querySelector<HTMLElement>(`.comp-sub[data-sub-id="${subId}"]`) as any)?.dataset?.actions).map(String);
      const vSplits = patch.vSplits ?? _readJsonArr((layer.querySelector<HTMLElement>(`.comp-sub[data-sub-id="${subId}"]`) as any)?.dataset?.vSplits).map(Number);
      const hSplits = patch.hSplits ?? _readJsonArr((layer.querySelector<HTMLElement>(`.comp-sub[data-sub-id="${subId}"]`) as any)?.dataset?.hSplits).map(Number);
      const fontScale0 = patch.fontScale ?? Number((layer.querySelector<HTMLElement>(`.comp-sub[data-sub-id="${subId}"]`) as any)?.dataset?.fontScale ?? "1");
      const fontScale = Number.isFinite(Number(fontScale0)) && Number(fontScale0) > 0 ? Number(fontScale0) : 1;

      const parts: string[] = [
        `name=${subId}`,
        `orientation=${orientation}`,
        `labels=${_fmtPrList(labels.map(String))}`,
        `actions=${_fmtPrList(actions.map(String))}`,
      ];
      if (Array.isArray(vSplits) && vSplits.length) parts.push(`vSplits=${_fmtNumList(vSplits.map(Number))}`);
      if (Array.isArray(hSplits) && hSplits.length) parts.push(`hSplits=${_fmtNumList(hSplits.map(Number))}`);
      if (fontScale !== 1) parts.push(`fontScale=${String(Math.round(fontScale * 1e6) / 1e6)}`);
      out.push(`buttons[${parts.join(", ")}]`);
      replaced = true;
    } else {
      out.push(ln);
    }
  }
  if (!replaced) {
    const labels = patch.labels ?? [];
    const actions = patch.actions ?? [];
    const vSplits = patch.vSplits ?? [];
    const hSplits = patch.hSplits ?? [];
    const fontScale0 = patch.fontScale ?? 1;
    const fontScale = Number.isFinite(Number(fontScale0)) && Number(fontScale0) > 0 ? Number(fontScale0) : 1;
    const orientation = String(patch.orientation ?? "h");
    const parts: string[] = [
      `name=${subId}`,
      `orientation=${orientation}`,
      `labels=${_fmtPrList(labels.map(String))}`,
      `actions=${_fmtPrList(actions.map(String))}`,
    ];
    if (vSplits.length) parts.push(`vSplits=${_fmtNumList(vSplits.map(Number))}`);
    if (hSplits.length) parts.push(`hSplits=${_fmtNumList(hSplits.map(Number))}`);
    if (fontScale !== 1) parts.push(`fontScale=${String(Math.round(fontScale * 1e6) / 1e6)}`);
    out.push(`buttons[${parts.join(", ")}]`);
  }
  (layer as any).__elementsPr = out.join("\n");
};

const _syncCompositeRootToModel = (engine: Engine, rootId: string, patch: Partial<any>) => {
  try {
    const model = engine.getModel() as any;
    if (!model) return;
    const n = (model.nodes ?? []).find((x: any) => String(x?.id ?? "") === String(rootId));
    if (!n) return;
    Object.assign(n, patch);
  } catch {
    // ignore
  }
};

const cssTranslateForAnchor = (anchor: string) => {
  const a = String(anchor || "centerCenter");
  switch (a) {
    case "topLeft":
      return "translate(0%, 0%)";
    case "topCenter":
      return "translate(-50%, 0%)";
    case "topRight":
      return "translate(-100%, 0%)";
    case "centerLeft":
      return "translate(0%, -50%)";
    case "center":
    case "centerCenter":
      return "translate(-50%, -50%)";
    case "centerRight":
      return "translate(-100%, -50%)";
    case "bottomLeft":
      return "translate(0%, -100%)";
    case "bottomCenter":
      return "translate(-50%, -100%)";
    case "bottomRight":
      return "translate(-100%, -100%)";
    default:
      return "translate(-50%, -50%)";
  }
};

const cssTransformOriginForAnchor = (anchor: string) => {
  const a = String(anchor || "centerCenter");
  switch (a) {
    case "topLeft":
      return "0% 0%";
    case "topCenter":
      return "50% 0%";
    case "topRight":
      return "100% 0%";
    case "centerLeft":
      return "0% 50%";
    case "center":
    case "centerCenter":
      return "50% 50%";
    case "centerRight":
      return "100% 50%";
    case "bottomLeft":
      return "0% 100%";
    case "bottomCenter":
      return "50% 100%";
    case "bottomRight":
      return "100% 100%";
    default:
      return "50% 50%";
  }
};

const parseRotateDegFromTransform = (cssTransform: string | null | undefined) => {
  const s = String(cssTransform ?? "");
  const m = s.match(/rotate\(\s*([\-0-9.]+)\s*deg\s*\)/i);
  if (!m) return 0;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : 0;
};

const applyAnchorTransformCss = (el: HTMLElement) => {
  const a = String(el.dataset.anchor ?? "centerCenter");
  el.style.transformOrigin = cssTransformOriginForAnchor(a);
  const rot = Number(el.dataset.rotationDeg ?? "") || parseRotateDegFromTransform(el.style.transform) || 0;
  el.dataset.rotationDeg = String(rot);
  // IMPORTANT: keep translate + rotate in a single transform so translate isn't rotated.
  el.style.transform = `${cssTranslateForAnchor(a)} rotate(${rot}deg)`;
};

const _normalizeAnchor = (a: string | undefined) => {
  const s = String(a || "centerCenter");
  if (s === "top") return "topCenter";
  if (s === "bottom") return "bottomCenter";
  if (s === "left") return "centerLeft";
  if (s === "right") return "centerRight";
  if (s === "center") return "centerCenter";
  return s;
};

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
  compositeSplitDrag = null;
  // NOTE: plot-arrow SVG overlays are deprecated. Axis arrows are real `arrow` nodes now.
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
  screenEditMode = false;
  clearDimmed(screenDimmedEls);
  try {
    onScreenEditModeChanged?.(false);
  } catch {}
  delete (window as any).__ip_screenEditing;
  const wrap = document.querySelector<HTMLElement>(".mode-toggle");
  const modeNow = (wrap?.dataset.mode ?? "edit").toLowerCase();
  const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
  if (btn) btn.textContent = modeNow === "edit" ? "Switch to Live" : "Switch to Edit";
  const hint = document.querySelector<HTMLElement>(".mode-toggle .hint");
  if (hint) {
    hint.textContent = modeNow === "edit" ? "Edit: drag/resize/rotate • double-click edit" : "Live: left/right step, up/down view • editing disabled";
    hint.style.display = "";
  }
  delete (window as any).__ip_exitScreenEdit;
  applyScreenEditDimming(false);
  // If mode just changed, defer a re-sync so we read the updated mode state.
  Promise.resolve().then(() => {
    if (!screenEditMode) applyScreenEditDimming(false);
  });
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
    if (n.space === "screen") {
      // Snap underlying transform into a "half-visible" region so it's draggable immediately.
      const t0: any = (n as any).transform ?? {};
      const t1 = clampScreenTransform(t0);
      if (t1.x !== t0.x || t1.y !== t0.y) {
        engine.updateNode(n.id, { transform: { x: t1.x, y: t1.y } as any } as any);
      }
    }
  }
  applyScreenEditDimming(true);
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
    exitCompositeEdit();
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

const exitCompositeEdit = () => {
  if (!compositeEditTimerId) return;
  // Root exit: leave composite editing entirely, regardless of nesting level.
  // Each kind sets the appropriate `__ip_exitCompositeEdit` hook today; we keep that for backwards compat,
  // but the host should call this function instead of relying on window globals.
  try {
    const fn = (window as any).__ip_exitCompositeEdit;
    if (typeof fn === "function") {
      fn();
      return;
    }
  } catch {
    // ignore
  }
  // If for some reason the hook isn't present, fall back to kind-specific exits where possible.
  // (These functions are defined in this module.)
  try {
    exitTimerCompositeEdit();
  } catch {
    // ignore
  }
};

const enterGraphCompositeEdit = (graphId: string) => {
  // Intentionally quiet (no logging).
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
    // Keep child nodes (e.g. axis arrows) interactive during composite edit.
    if (String((n as any).parentId ?? "") === graphId) continue;
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
    //
    // IMPORTANT:
    // The axis arrows use separate `.comp-sub[data-kind="plot-arrow"]` hitboxes that are children of the plot group.
    // If we disable pointer-events on the plot group, those arrow hitboxes become unselectable.
    if (sub.dataset.kind === "plot-region") {
      sub.style.pointerEvents = "none";
      sub.style.cursor = "default";
      sub.style.background = "transparent";
      sub.style.outline = "none";
      sub.style.opacity = "1";
    } else if (sub.dataset.subId === "plot") {
      // Treat as background (panning logic already ignores selecting `plot`), but keep events enabled for children.
      sub.style.pointerEvents = "auto";
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
  // Intentionally quiet (no logging).
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
    // Keep child nodes (e.g. axis arrows) interactive during composite edit.
    if (String((n as any).parentId ?? "") === timerId) continue;
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
    // Intentionally quiet (no logging).
  }

  // Debug: verify composite texts are actually interactive right after entry.
  // Enable with: localStorage.setItem("ip_debug_timer_text_pe", "1")
  // (removed)
};

const enterChoicesCompositeEdit = (pollId: string) => {
  // Intentionally quiet (no logging).
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
  // Intentionally quiet (no logging).
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
    // Keep child nodes (e.g. axis arrows) interactive during composite edit.
    if (String((n as any).parentId ?? "") === soundId) continue;
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
  // MUST be idempotent and MUST NOT throw: if it throws, the editor can get stuck in a
  // "compositeState.id != null" mode where selection is disabled.
  try {
    // Always stop any active composite pan/cursor override.
    stopCompositePan();
    // Clear last composite id marker (avoids restoring after setModel when not editing).
    delete (engine as any).__ip_lastCompositeId;
    delete (window as any).__ip_compositeEditId;
    delete (window as any).__ip_compositeEditKind;

    if (compositeEditTimerId) {
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
    }
    for (const e2 of compositeHiddenEls) e2.classList.remove("ip-dim-node");
    compositeHiddenEls = [];

    // Hard guarantee: restore interactivity even if engine.setModel recreated DOM nodes while editing.
    try {
      for (const el2 of Array.from(stage.querySelectorAll<HTMLElement>(".node.ip-dim-node"))) {
        el2.classList.remove("ip-dim-node");
      }
      for (const sub of Array.from(stage.querySelectorAll<HTMLElement>(".comp-sub.ip-composite-dim"))) {
        sub.classList.remove("ip-composite-dim");
        sub.style.pointerEvents = "";
      }
    } catch {
      // ignore
    }
  } finally {
    compositeEditTimerId = null;
    compositeEditPath = "";
    compositePathStack.length = 0;
    compositeDrag = null;
    compositeDragMode = "none";
    compositeActiveHandle = null;
    compositeSelectedSubId = null;
    compositeSelectedSubEl = null;
    // Restore mode button label (based on dataset.mode)
    try {
      const wrap = document.querySelector<HTMLElement>(".mode-toggle");
      const mode = (wrap?.dataset.mode ?? "edit").toLowerCase();
      const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
      if (btn) btn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
    } catch {}
    delete (window as any).__ip_exitCompositeEdit;
    delete (window as any).__ip_compositeEditing;
    delete (window as any).__ip_cancelCompositePan;
    // IMPORTANT: host state must be notified, otherwise selection/cursor keep thinking we're in composite edit.
    try {
      syncCompositeState();
    } catch {}
  }
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
    const before = cloneModel(engine.getModel());
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
    _syncCompositeRootToModel(engine, timerId, { elementsText: nextText });

    // Persist elements.pr (and current geoms) to backend.
    const geoms: any = (layer as any).__textGeoms ?? {};
    void _debugCompositeSaveFetch(
      `${BACKEND}/api/composite/save`,
      { compositePath: timerId, geoms, elementsPr: nextText },
      { kind: "timer", where: "text-editor-save", compositePath: timerId }
    );
    void commit(before);
    close();
  });
};

const openCompositeButtonsEditor = (kind: "timer" | "sound", compId: string, subEl: HTMLElement) => {
  const layer =
    kind === "timer"
      ? engine.getNodeElement(compId)?.querySelector<HTMLElement>(".timer-sub-layer")
      : engine.getNodeElement(compId)?.querySelector<HTMLElement>(".sound-sub-layer");
  if (!layer) return;
  const subId = subEl.dataset.subId ?? "";
  if (!subId) return;

  const labels0 = _readJsonArr(subEl.dataset.templates).map(String);
  const actions0 = _readJsonArr(subEl.dataset.actions).map(String);
  const vSplits0 = _readJsonArr(subEl.dataset.vSplits).map(Number);
  const hSplits0 = _readJsonArr(subEl.dataset.hSplits).map(Number);
  const fontScale0 = Number(subEl.dataset.fontScale ?? "1") || 1;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.width = "min(920px, calc(100vw - 40px))";
  modal.style.height = "min(680px, calc(100vh - 40px))";

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<div class="modal-title">Edit buttons: <code>${subId}</code></div>`;

  const body = document.createElement("div");
  body.style.padding = "14px";
  body.style.display = "grid";
  body.style.gridTemplateRows = "auto auto 1fr";
  body.style.gap = "12px";

  const layout = document.createElement("div");
  layout.className = "field";
  layout.innerHTML = `<label>Layout</label>`;
  const layoutRow = document.createElement("div");
  layoutRow.style.display = "flex";
  layoutRow.style.flexWrap = "wrap";
  layoutRow.style.gap = "10px";
  layoutRow.style.alignItems = "center";

  const btn1xN = document.createElement("button");
  btn1xN.className = "btn";
  btn1xN.textContent = "Preset: 1×N";
  const btn2x2 = document.createElement("button");
  btn2x2.className = "btn";
  btn2x2.textContent = "Preset: 2×2";

  const vInp = document.createElement("input");
  vInp.className = "input";
  vInp.placeholder = "vSplits (0..1): e.g. 0.5";
  vInp.value = vSplits0.join(", ");
  vInp.style.flex = "1";
  const hInp = document.createElement("input");
  hInp.className = "input";
  hInp.placeholder = "hSplits (0..1): e.g. 0.5";
  hInp.value = hSplits0.join(", ");
  hInp.style.flex = "1";

  layoutRow.append(btn1xN, btn2x2);
  layout.append(layoutRow, vInp, hInp);

  const table = document.createElement("div");
  table.className = "field";
  table.innerHTML = `<label>Buttons (template + action)</label>`;
  const rows = document.createElement("div");
  rows.style.display = "grid";
  rows.style.gridTemplateColumns = "1fr 1fr";
  rows.style.gap = "8px 10px";

  const labelInputs: HTMLInputElement[] = [];
  const actionInputs: HTMLInputElement[] = [];
  const n = Math.max(labels0.length, actions0.length, 1);
  for (let i = 0; i < n; i++) {
    const li = document.createElement("input");
    li.className = "input";
    li.placeholder = `Button ${i + 1} template`;
    li.value = String(labels0[i] ?? "");
    const ai = document.createElement("input");
    ai.className = "input";
    ai.placeholder = `Button ${i + 1} action`;
    ai.value = String(actions0[i] ?? "");
    labelInputs.push(li);
    actionInputs.push(ai);
    rows.append(li, ai);
  }
  table.append(rows);

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
  body.append(layout, table);
  backdrop.append(modal);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  btnCancel.addEventListener("click", close);
  modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) close();
  });

  const parseSplits = (s: string) => {
    const nums = s
      .split(",")
      .map((t) => Number(t.trim()))
      .filter((x) => Number.isFinite(x))
      .map((x) => Math.max(0.05, Math.min(0.95, x)));
    nums.sort((a, b) => a - b);
    const out: number[] = [];
    for (const n of nums) {
      if (out.length === 0 || Math.abs(out[out.length - 1]! - n) > 1e-6) out.push(n);
    }
    return out;
  };

  btn1xN.addEventListener("click", () => {
    vInp.value = "";
    hInp.value = "";
  });
  btn2x2.addEventListener("click", () => {
    vInp.value = "0.5";
    hInp.value = "0.5";
  });

  btnSave.addEventListener("click", () => {
    const before = cloneModel(engine.getModel());
    const labels = labelInputs.map((x) => x.value).filter((s) => String(s ?? "").trim().length > 0);
    const actions = actionInputs.map((x) => x.value).slice(0, labels.length);
    const vSplits = parseSplits(vInp.value);
    const hSplits = parseSplits(hInp.value);

    const fontScaleNow = Number(subEl.dataset.fontScale ?? String(fontScale0)) || 1;
    subEl.dataset.templates = JSON.stringify(labels);
    subEl.dataset.actions = JSON.stringify(actions);
    subEl.dataset.vSplits = JSON.stringify(vSplits);
    subEl.dataset.hSplits = JSON.stringify(hSplits);
    subEl.dataset.fontScale = String(fontScaleNow);

    _updateButtonsElementsPr(layer, subId, { labels, actions, vSplits, hSplits, fontScale: fontScaleNow });
    _syncCompositeRootToModel(engine, compId, { elementsText: String((layer as any).__elementsPr ?? "") });

    // Persist elements.pr + current geoms.
    const geoms: any = compositeGeomsByPath[compId] ?? (layer as any).__textGeoms ?? {};
    void _debugCompositeSaveFetch(
      `${BACKEND}/api/composite/save`,
      { compositePath: compId, geoms, elementsPr: String((layer as any).__elementsPr ?? "") },
      { kind, where: "buttons-editor-save", compositePath: compId }
    );
    void commit(before);
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
  const dbg = false;
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
      // no logging
      if (!hit) continue;
      const area = Math.max(1, rc.width * rc.height);
      if (!best || area < best.area) best = { id: String(n.id), kind: kind as any, area };
    }
    if (best) {
      // no logging
      if (best.kind === "timer") enterTimerCompositeEdit(best.id);
      else if (best.kind === "sound") enterSoundCompositeEdit(best.id);
    else if (best.kind === "graph") enterGraphCompositeEdit(best.id);
      else enterChoicesCompositeEdit(best.id);
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
    // no logging
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
    if (groupEdit?.activeId?.()) {
      groupEdit?.exitOneLevel?.();
      ev.preventDefault();
      return;
    }
    if (compositeEditTimerId) {
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

const onCompositePointerDownCaptureDrag = (ev: PointerEvent) => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId) return;
  const t = ev.target as HTMLElement;
  // State rule: during composite edit, composite-sub dragging must never intercept "real node" interactions.
  // Axis arrows are real child nodes (`.node`) and must behave like any other element (select + drag via main pipeline).
  const clickedNode = t.closest<HTMLElement>(".node");
  if (clickedNode) {
    const clickedId = String(clickedNode.dataset.nodeId ?? "");
    if (clickedId && clickedId !== String(compositeEditTimerId)) return;
  }
  const dbgButtons = false;
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
  // Intentionally quiet (no logging).
  if (!sub) return;

  // Composite sub-elements: implement our own "double click" for sub editing.
  // Native dblclick can be suppressed by pointer capture + preventDefault during composite drag.
  // This makes timer/sound/graph editing consistent.
  const isSubText = sub.classList.contains("timer-sub-text") || sub.classList.contains("sound-sub-text") || sub.classList.contains("graph-sub-text");
  const isSubButtons = sub.classList.contains("timer-sub-buttons") || sub.classList.contains("sound-sub-buttons");
  if ((isSubText || isSubButtons) && compositeEditTimerId) {
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
      } else if (sub.classList.contains("timer-sub-buttons") && compositeEditKind === "timer") {
        openCompositeButtonsEditor("timer", compositeEditTimerId, sub);
      } else if (sub.classList.contains("sound-sub-buttons") && compositeEditKind === "sound") {
        openCompositeButtonsEditor("sound", compositeEditTimerId, sub);
      }
      (ev as any).stopImmediatePropagation?.();
      ev.preventDefault();
      return;
    }
  }
  // Intentionally quiet (no logging).
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
  // Ensure DOM anchor matches stored geom anchor so handles + resizing math match what the user sees.
  // (Some composite renderers historically used translate(-50%,-50%) unconditionally.)
  if (subId) {
    const geoms: Record<string, any> = (compositeGeomsByPath[compositeEditPath] ??= {});
    const g0 = geoms[subId] ?? {};
    sub.dataset.anchor = String(g0.anchor ?? sub.dataset.anchor ?? "centerCenter");
  } else {
    sub.dataset.anchor = String(sub.dataset.anchor ?? "centerCenter");
  }
  applyAnchorTransformCss(sub);
  // NOTE: plot-arrow SVG overlays are deprecated. Axis arrows are real `arrow` nodes now.

  ensureHandles(sub);

  // Parent-relative coordinates:
  // - Always normalize within the composite "data region" layer, not the full node element.
  //   (Using the full node bbox causes translation/rotation drift because the editable sub-layer
  //    can be inset from the node and can have different transforms.)
  // - If compPath is nested (e.g. "<id>/bullets"), normalize within that group's box within the layer.
  const layerBoxEl =
    compositeEditKind === "timer"
      ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
      : compositeEditKind === "sound"
        ? timerEl.querySelector<HTMLElement>(".sound-sub-layer")
        : compositeEditKind === "graph"
          ? timerEl.querySelector<HTMLElement>(".graph-sub-layer")
          : timerEl.querySelector<HTMLElement>(".choices-sub-layer");
  const baseBoxEl = layerBoxEl ?? timerEl;
  const groupBoxEl = compositeEditPath.includes("/")
    ? (baseBoxEl.querySelector<HTMLElement>(`[data-group-path="${compositeEditPath}"]`) ?? baseBoxEl)
    : baseBoxEl;
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
    // Re-anchor without any visible "jump":
    // Use DOMRects to compute the required left/top compensation in the CURRENT composite coordinate system.
    // This is robust to rotation and to transform function order.
    const newAnchor = _normalizeAnchor(anchorEl.dataset.anchor);
    const x0 = Number(sub.style.left.replace("%", "")) / 100;
    const y0 = Number(sub.style.top.replace("%", "")) / 100;

    const pre = sub.getBoundingClientRect();
    sub.dataset.anchor = newAnchor;
    applyAnchorTransformCss(sub);
    const post = sub.getBoundingClientRect();

    const dxPx = pre.left - post.left;
    const dyPx = pre.top - post.top;
    const x1 = x0 + dxPx / Math.max(1e-9, box.width);
    const y1 = y0 + dyPx / Math.max(1e-9, box.height);

    sub.style.left = `${x1 * 100}%`;
    sub.style.top = `${y1 * 100}%`;
    ensureHandles(sub);

    if (subId) {
      if (isChoicesWheelLabel) {
        const ox = x1 - baseX;
        const oy = y1 - baseY;
        geoms[subId] = { ...(geoms[subId] ?? {}), x: ox, y: oy, anchor: newAnchor };
      } else {
        geoms[subId] = { ...(geoms[subId] ?? {}), x: x1, y: y1, anchor: newAnchor };
      }
    }
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
    return;
  }

  compositeStart = { x: ev.clientX, y: ev.clientY };
  const xStyle = Number(sub.style.left.replace("%", "")) / 100;
  const yStyle = Number(sub.style.top.replace("%", "")) / 100;
  const wStyle = Number(sub.style.width.replace("%", "")) / 100;
  const hStyle = Number(sub.style.height.replace("%", "")) / 100;
  compositeStartGeom = {
    // Source of truth is the stored geom (prevents jitter from DOM rect measurement).
    x: Number(
      Number.isFinite(isChoicesWheelLabel ? baseX + Number(g0.x ?? NaN) : Number(g0.x ?? NaN))
        ? isChoicesWheelLabel
          ? baseX + Number(g0.x ?? 0)
          : Number(g0.x ?? 0)
        : Number.isFinite(xStyle)
          ? xStyle
          : (r.left + r.width / 2 - box.left) / box.width
    ),
    y: Number(
      Number.isFinite(isChoicesWheelLabel ? baseY + Number(g0.y ?? NaN) : Number(g0.y ?? NaN))
        ? isChoicesWheelLabel
          ? baseY + Number(g0.y ?? 0)
          : Number(g0.y ?? 0)
        : Number.isFinite(yStyle)
          ? yStyle
          : (r.top + r.height / 2 - box.top) / box.height
    ),
    w: Number(Number.isFinite(Number(g0.w ?? NaN)) ? Number(g0.w) : Number.isFinite(wStyle) ? wStyle : r.width / box.width),
    h: Number(Number.isFinite(Number(g0.h ?? NaN)) ? Number(g0.h) : Number.isFinite(hStyle) ? hStyle : r.height / box.height),
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

  // Button split lines: drag to adjust vSplits/hSplits (layout) inside the buttons box.
  const splitEl = t.closest<HTMLElement>(".ip-btn-split");
  if (splitEl?.dataset?.kind === "button-split" && (sub.classList.contains("timer-sub-buttons") || sub.classList.contains("sound-sub-buttons"))) {
    const dir = (splitEl.dataset.dir === "h" ? "h" : "v") as "v" | "h";
    const idx = Number(splitEl.dataset.idx ?? "0") || 0;
    const rect = sub.getBoundingClientRect();
    const rotDeg = Number(sub.dataset.rotationDeg ?? compositeStartGeom.rotationDeg ?? 0) || 0;
    const nBtns = sub.querySelectorAll("button.ip-controlbtn").length;
    const defaultSplits = (n: number) => (n > 1 ? Array.from({ length: n - 1 }, (_, i) => (i + 1) / n) : []);
    const start =
      dir === "v"
        ? (_readJsonArr(sub.dataset.vSplits).map(Number).filter((x) => Number.isFinite(x)) as number[])
        : (_readJsonArr(sub.dataset.hSplits).map(Number).filter((x) => Number.isFinite(x)) as number[]);
    const seed = start.length ? start : defaultSplits(nBtns);

    compositeStart = { x: ev.clientX, y: ev.clientY };
    compositeDragMode = "split";
    compositeBeforeModel = cloneModel(engine.getModel());
    compositeDirty = false;
    (window as any).__ip_compositeDragging = true;
    compositeSplitDrag = { subId: subId || String(sub.dataset.subId ?? ""), dir, idx, start: seed.slice(), boxEl: sub, rotDeg };
    setBodyCursor(dir === "v" ? "col-resize" : "row-resize");
    stage.setPointerCapture?.(ev.pointerId);
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
    return;
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
    compositeBeforeModel = cloneModel(engine.getModel());
    compositeDirty = false;
    (window as any).__ip_compositeDragging = true;
    setBodyCursor(cursorForHandle(compositeActiveHandle, compositeStartGeom.rotationDeg));
    if (compositeDragMode === "rotate") {
      // Rotate around the anchor point (x,y) within the active composite box.
      const ax = box.left + compositeStartGeom.x * box.width;
      const ay = box.top + compositeStartGeom.y * box.height;
      compositeStartAngleRad = Math.atan2(ev.clientY - ay, ev.clientX - ax);
      compositeStartRotationDeg = compositeStartGeom.rotationDeg;
    }
  } else {
    compositeDragMode = "move";
    compositeBeforeModel = cloneModel(engine.getModel());
    compositeDirty = false;
    (window as any).__ip_compositeDragging = true;
    sub.style.cursor = "grabbing";
  }
  // no logging
  // Capture on stage so dragging continues even when the pointer leaves the element/hit region.
  stage.setPointerCapture?.(ev.pointerId);
  // Prevent the normal selection/rotate handler from selecting the timer node while we're editing sub-elements.
  (ev as any).stopImmediatePropagation?.();
  ev.preventDefault();
};

const onCompositePointerMoveCaptureDrag = (ev: PointerEvent) => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId || compositeDragMode === "none" || !compositeSelectedSubEl || !compositeStartGeom) return;
  // no logging
  const timerEl = engine.getNodeElement(compositeEditTimerId);
  if (!timerEl) return;
  const sub = compositeSelectedSubEl;
  const layerBoxEl =
    compositeEditKind === "timer"
      ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
      : compositeEditKind === "sound"
        ? timerEl.querySelector<HTMLElement>(".sound-sub-layer")
        : compositeEditKind === "graph"
          ? timerEl.querySelector<HTMLElement>(".graph-sub-layer")
          : timerEl.querySelector<HTMLElement>(".choices-sub-layer");
  const baseBoxEl = layerBoxEl ?? timerEl;
  const groupBoxEl = compositeEditPath.includes("/")
    ? (baseBoxEl.querySelector<HTMLElement>(`[data-group-path="${compositeEditPath}"]`) ?? baseBoxEl)
    : baseBoxEl;
  const box = groupBoxEl.getBoundingClientRect();
  const geoms: Record<string, any> = (compositeGeomsByPath[compositeEditPath] ??= {});
  const sid = sub.dataset.subId ?? "";
  const baseX = Number(sub.dataset.baseX ?? "NaN");
  const baseY = Number(sub.dataset.baseY ?? "NaN");
  const isChoicesWheelLabel =
    compositeEditKind === "choices" && compositeEditPath.endsWith("/wheel") && Number.isFinite(baseX) && Number.isFinite(baseY);
  const dx = (ev.clientX - compositeStart.x) / box.width;
  const dy = (ev.clientY - compositeStart.y) / box.height;
  // Dead-zone: prevent tiny accidental nudges.
  // Only start applying changes once the pointer has moved meaningfully.
  const DRAG_START_PX = 3.0;
  if (!compositeDirty) {
    const movedPx = Math.hypot(ev.clientX - compositeStart.x, ev.clientY - compositeStart.y);
    if (movedPx < DRAG_START_PX) return;
    compositeDirty = true;
  }

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
    // Keep model in sync so undo/redo restores elements.pr changes.
    // Defer model syncing to pointerup to avoid rebuilding DOM mid-drag.

    if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
    else renderSoundCompositeArrows(timerEl, layer);
    return;
  }

  if (compositeDragMode === "split" && compositeSplitDrag) {
    const sd = compositeSplitDrag;
    const sub = sd.boxEl;
    const sid2 = sd.subId || sub.dataset.subId || "";
    if (!sid2) return;
    const r = sub.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const aInv = (-sd.rotDeg * Math.PI) / 180;
    const cInv = Math.cos(aInv);
    const sInv = Math.sin(aInv);
    const dx0 = ev.clientX - cx;
    const dy0 = ev.clientY - cy;
    const lx = dx0 * cInv - dy0 * sInv;
    const ly = dx0 * sInv + dy0 * cInv;
    // IMPORTANT: account for grid gaps.
    // Splits are defined in "track fraction" space (excluding gaps), not raw box fraction.
    const xTotal = lx + r.width / 2;
    const yTotal = ly + r.height / 2;
    const grid = sub.querySelector<HTMLElement>(":scope > .ip-buttons-grid");
    const cs = grid ? getComputedStyle(grid) : null;
    const gapX = Math.max(0, Number.parseFloat(cs?.columnGap ?? "") || Number.parseFloat(cs?.gap ?? "") || 10);
    const gapY = Math.max(0, Number.parseFloat(cs?.rowGap ?? "") || Number.parseFloat(cs?.gap ?? "") || 10);
    const nTracks = sd.start.length + 1;
    const availW = Math.max(1, r.width - gapX * Math.max(0, nTracks - 1));
    const availH = Math.max(1, r.height - gapY * Math.max(0, nTracks - 1));
    const frac0 =
      sd.dir === "v"
        ? (xTotal - gapX * (sd.idx + 0.5)) / Math.max(1e-9, availW)
        : (yTotal - gapY * (sd.idx + 0.5)) / Math.max(1e-9, availH);

    const minGap = 0.06;
    const splits = sd.start.slice();
    const i = Math.max(0, Math.min(splits.length - 1, sd.idx));
    const lo = i === 0 ? minGap : splits[i - 1]! + minGap;
    const hi = i === splits.length - 1 ? 1 - minGap : splits[i + 1]! - minGap;
    const frac = Math.max(lo, Math.min(hi, Math.max(minGap, Math.min(1 - minGap, frac0))));
    splits[i] = frac;

    if (sd.dir === "v") sub.dataset.vSplits = JSON.stringify(splits);
    else sub.dataset.hSplits = JSON.stringify(splits);

    if (compositeEditKind === "timer" || compositeEditKind === "sound") {
      const rootLayer =
        compositeEditKind === "timer"
          ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
          : timerEl.querySelector<HTMLElement>(".sound-sub-layer");
      if (rootLayer) {
        _updateButtonsElementsPr(rootLayer, sid2, sd.dir === "v" ? { vSplits: splits } : { hSplits: splits });
        // Defer model syncing to pointerup to avoid rebuilding DOM mid-drag.
      }
    }
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
    // Rotate around the anchor point (x,y) within the active composite box.
    const ax = box.left + compositeStartGeom.x * box.width;
    const ay = box.top + compositeStartGeom.y * box.height;
    const a1 = Math.atan2(ev.clientY - ay, ev.clientX - ax);
    const ddeg = (a1 - compositeStartAngleRad) * (180 / Math.PI);
    let rot = compositeStartRotationDeg + ddeg;
    if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
    sub.dataset.rotationDeg = String(rot);
    applyAnchorTransformCss(sub);
    // Refresh hover cursor arrows (they depend on current rotation).
    // Without this, the handle DOM can keep stale cursor styles until the next unrelated refresh.
    ensureHandles(sub);
    if (sid) geoms[sid] = { ...(geoms[sid] ?? {}), rotationDeg: rot };
    // Keep the drag cursor aligned with the current rotation.
    if (compositeActiveHandle) setBodyCursor(cursorForHandle(compositeActiveHandle, rot));
    return;
  }

  if (compositeDragMode === "resize" && compositeActiveHandle) {
    // Resize in normalized composite coords.
    // IMPORTANT: for rotated sub-elements, project mouse delta into the element's local axes
    // so dragging feels visually correct (same principle as root-mode resizing).
    const rect0 = { x: compositeStartGeom.x, y: compositeStartGeom.y, w: compositeStartGeom.w, h: compositeStartGeom.h };
    const minW = 0.01;
    const minH = 0.01;
    const hnd = compositeActiveHandle;
    const isCorner = hnd === "nw" || hnd === "ne" || hnd === "sw" || hnd === "se";
    const forceUniform = compositeEditKind === "choices" && (sid === "wheel" || sid === "pie"); // keep wheel aspect
    const forceWheelCircle = compositeEditKind === "choices" && sid === "wheel";

    const rotDeg = Number(compositeStartGeom?.rotationDeg ?? 0) || 0;
    const aInv = (-rotDeg * Math.PI) / 180; // world -> local
    const cInv = Math.cos(aInv);
    const sInv = Math.sin(aInv);
    const dxL = dx * cInv - dy * sInv;
    const dyL = dx * sInv + dy * cInv;
    const aFwd = (rotDeg * Math.PI) / 180; // local -> world
    const cF = Math.cos(aFwd);
    const sF = Math.sin(aFwd);
    const localToWorldDelta = (lx: number, ly: number) => ({ x: lx * cF - ly * sF, y: lx * sF + ly * cF });

    const normalizeAnchor = (a: string | undefined) => {
      if (!a) return "centerCenter";
      if (a === "top") return "topCenter";
      if (a === "bottom") return "bottomCenter";
      if (a === "left") return "centerLeft";
      if (a === "right") return "centerRight";
      if (a === "center") return "centerCenter";
      return a;
    };
    const aN = normalizeAnchor(compositeStartGeom.anchor);
    const ax = aN.endsWith("Left") ? 0 : aN.endsWith("Right") ? 1 : 0.5;
    const ay = aN.startsWith("Top") ? 0 : aN.startsWith("Bottom") ? 1 : 0.5;
    const denomE = Math.max(0, 1 - ax);
    const denomW = Math.max(0, ax);
    const denomS = Math.max(0, 1 - ay);
    const denomN = Math.max(0, ay);
    const wFromE = denomE > 1e-9 ? ((denomE * rect0.w + dxL) / denomE) : rect0.w;
    const wFromW = denomW > 1e-9 ? ((denomW * rect0.w - dxL) / denomW) : rect0.w;
    const hFromS = denomS > 1e-9 ? ((denomS * rect0.h + dyL) / denomS) : rect0.h;
    const hFromN = denomN > 1e-9 ? ((denomN * rect0.h - dyL) / denomN) : rect0.h;

    let wNew = rect0.w;
    let hNew = rect0.h;

    if (isCorner || forceUniform) {
      const wc = hnd.includes("e") ? wFromE : hnd.includes("w") ? wFromW : rect0.w;
      const hc = hnd.includes("s") ? hFromS : hnd.includes("n") ? hFromN : rect0.h;
      let s = Math.max(wc / Math.max(1e-9, rect0.w), hc / Math.max(1e-9, rect0.h));
      if (ev.shiftKey) {
        const step = 0.05;
        s = Math.max(step, Math.round(s / step) * step);
      }
      wNew = Math.max(minW, rect0.w * s);
      hNew = Math.max(minH, rect0.h * s);
    } else {
      if (hnd.includes("e")) wNew = Math.max(minW, wFromE);
      if (hnd.includes("w")) wNew = Math.max(minW, wFromW);
      if (hnd.includes("s")) hNew = Math.max(minH, hFromS);
      if (hnd.includes("n")) hNew = Math.max(minH, hFromN);
    }

    if (forceWheelCircle) {
      // Pixel-square enforcement:
      // wFrac*boxW == hFrac*boxH  =>  wFrac == hFrac*(boxH/boxW)
      const sPx = Math.max(8, Math.max(wNew * box.width, hNew * box.height));
      wNew = sPx / box.width;
      hNew = sPx / box.height;
    }

    const rect = { x: rect0.x, y: rect0.y, w: wNew, h: hNew };

    // Keep anchor position fixed; only size changes.
    sub.style.left = `${rect0.x * 100}%`;
    sub.style.top = `${rect0.y * 100}%`;
    sub.style.width = `${rect.w * 100}%`;
    sub.style.height = `${rect.h * 100}%`;
    applyAnchorTransformCss(sub);
    if (sid) geoms[sid] = { ...(geoms[sid] ?? {}), x: rect.x, y: rect.y, w: rect.w, h: rect.h };

    // Buttons: edge-resize should NOT affect font size.
    // We implement this by compensating fontScale inversely when changing height via n/s handles.
    if ((sub.classList.contains("timer-sub-buttons") || sub.classList.contains("sound-sub-buttons")) && !isCorner) {
      const isVerticalEdge = hnd === "n" || hnd === "s";
      if (isVerticalEdge) {
        const fs0 = Number(sub.dataset.fontScale ?? "1") || 1;
        const nextFs = Math.max(0.1, fs0 * (rect0.h / Math.max(1e-9, rect.h)));
        sub.dataset.fontScale = String(Math.round(nextFs * 1e6) / 1e6);
        if (compositeEditKind === "timer" || compositeEditKind === "sound") {
          const rootLayer =
            compositeEditKind === "timer"
              ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
              : timerEl.querySelector<HTMLElement>(".sound-sub-layer");
          if (rootLayer && sid) _updateButtonsElementsPr(rootLayer, sid, { fontScale: nextFs });
        }
      }
    }

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
};

const onCompositePointerUpCaptureDrag = (_ev: PointerEvent) => {
  // Hard block: Live mode must be resistant to any editing gestures.
  if (getAppMode() !== "edit") return;
  if (!compositeEditTimerId) return;
  const timerEl = engine.getNodeElement(compositeEditTimerId);
  if (!timerEl) return;
  // Only persist when a drag actually happened; otherwise we'll spam saves and may send an empty path.
  if (compositeDragMode === "none") return;
  if (!compositeEditPath) return;
  if (compositeSelectedSubEl) compositeSelectedSubEl.style.cursor = "grab";

  const before = compositeBeforeModel;
  const shouldPersist = !!compositeDirty;

  if (!shouldPersist) {
    // No-op click: don't save, don't create history entries.
    compositeDragMode = "none";
    compositeActiveHandle = null;
    compositeStartGeom = null;
    compositeArrowDrag = null;
    compositeSplitDrag = null;
    (window as any).__ip_compositeDragging = false;
    setBodyCursor("");
    stage.style.cursor = "";
    compositeBeforeModel = null;
    compositeDirty = false;
    return;
  }

  // Persist composite geometries from the in-memory model (no DOM-rect measuring -> no jitter / size drift).
  const geoms: any = compositeGeomsByPath[compositeEditPath] ?? {};
  const payload: any = { compositePath: compositeEditPath, geoms };
  // Always persist geoms for the ACTIVE level.
  void _debugCompositeSaveFetch(`${BACKEND}/api/composite/save`, payload, {
    kind: compositeEditKind,
    where: "composite-pointerup",
    compositePath: compositeEditPath
  });

  // Keep the in-memory engine model in sync too, so deselecting/exiting edit doesn't "snap back"
  // to stale compositeGeometriesByPath values until the next reload.
  try {
    const model = engine.getModel() as any;
    const rootId = String(compositeEditTimerId ?? "");
    if (model && rootId) {
      const n = (model.nodes ?? []).find((x: any) => String(x?.id ?? "") === rootId);
      if (n) {
        const rel0 = compositeEditPath.startsWith(rootId) ? compositeEditPath.slice(rootId.length) : "";
        const rel = rel0.startsWith("/") ? rel0.slice(1) : rel0;
        const key = rel || "";
        (n.compositeGeometriesByPath ??= {});
        (n.compositeGeometriesByPath as any)[key] = geoms;
        // Back-compat: keep compositeGeometries (root) aligned.
        if (key === "") n.compositeGeometries = geoms;
      }
    }
  } catch {
    // ignore
  }

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
      _syncCompositeRootToModel(engine, compositeEditTimerId, { elementsText: elementsPr });
    }
  }

  compositeDragMode = "none";
  compositeActiveHandle = null;
  compositeStartGeom = null;
  compositeArrowDrag = null;
  compositeSplitDrag = null;
  (window as any).__ip_compositeDragging = false;
  setBodyCursor("");
  // Ensure the per-handle hover cursor can take effect immediately after drag.
  stage.style.cursor = "";
  compositeDirty = false;
  compositeBeforeModel = null;
  // Commit ONE undo step for this entire drag.
  void commit(before);
};

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
  // Keep selection while panning (do not deselect).
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

// Expose a cancel hook so global Escape can reliably stop panning
// (composite pan is managed inside this module, not in bootstrap).
// Composite pan is routed through the central interaction state machine.
(window as any).__ip_cancelCompositePan = () => stopCompositePan();
const onCompositePointerDownCapturePan = (ev: PointerEvent) => {
    if (getAppMode() !== "edit") return;
    if (!compositeEditTimerId) return;
    if (ev.button !== 0) return;
    if (compositePan) return;
    // If the user is actively manipulating a sub-element/handle, do NOT pan.
    const t = ev.target as HTMLElement;
    if (t.closest(".handle") || t.closest(".anchor-dot")) return;

    // IMPORTANT:
    // Axis arrows are now REAL `.node-arrow` elements (child nodes with parentId=compositeEditTimerId).
    // If the user clicks such a node, do NOT hijack it into composite panning.
    const clickedNode = t.closest<HTMLElement>(".node");
    if (clickedNode) {
      const clickedId = String(clickedNode.dataset.nodeId ?? "");
      if (clickedId && clickedId !== String(compositeEditTimerId)) {
        // Allow normal editor selection/drag pipeline to handle it.
        return;
      }
    }

    const rootEl = engine.getNodeElement(compositeEditTimerId);
    if (!rootEl) return;

    // IMPORTANT:
    // Do NOT use the raw event target to decide pan vs select; disabled layers (canvas/plot)
    // may be the event target even when a selectable `.comp-sub` is geometrically under the cursor.
    // Instead: pick the smallest composite sub by bbox and only pan if nothing selectable exists.
  const picked = _pickSmallestCompositeSub(rootEl, ev.clientX, ev.clientY, { activeCompPath: compositeEditPath });
    const kind = String(picked?.dataset.kind ?? "");
    const subId = String(picked?.dataset.subId ?? "");
    const dbg = false;
    // Treat the plot group itself as non-selectable "background" (pan region) for timer/sound/graph.
    // Otherwise a pan-start click would select `plot` and appear to "deselect" the current sub.
    const isPlotGroup = subId === "plot" && (compositeEditKind === "timer" || compositeEditKind === "sound" || compositeEditKind === "graph");

    if (picked && kind !== "plot-region" && !isPlotGroup) {
      // Any normal selectable sub (text/buttons/etc): do NOT pan.
      // NOTE: most selectable elements don't set data-kind, so `kind === ""` is normal here.
      return;
    }

    // No selectable sub under cursor (or plot-region / non-endpoint arrow): pan.
    startCompositePan(ev);
    // no logging
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
};
const onCompositePointerMoveCapturePan = (ev: PointerEvent) => {
    if (!compositePan) return;
    if (getAppMode() !== "edit") return;
    if (!compositeEditTimerId) return;
    // Hard invariant: panning must never continue unless the left button is down.
    // This prevents "stuck pan" if a pointerup is missed or swallowed by any path.
    if ((ev.buttons & 1) === 0 || ev.pointerId !== compositePan.pointerId) {
      stopCompositePan();
      return;
    }
    const cam = engine.getCamera();
    const dx = ev.clientX - compositePan.lastX;
    const dy = ev.clientY - compositePan.lastY;
    compositePan.lastX = ev.clientX;
    compositePan.lastY = ev.clientY;
    engine.setCamera({ cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom, zoom: cam.zoom });
    ev.preventDefault();
};

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
    exitCompositeEdit,
    enterScreenEdit,
    exitScreenEdit,
    isScreenEditMode: () => !!screenEditMode,
    getCompositeState: () => ({ id: compositeEditTimerId, kind: compositeEditKind, path: compositeEditPath }),
    handlers: {
      onPointerDownCapture: (ev) => {
        if (!compositeEditTimerId) return false;
        const before = ev.defaultPrevented;
        onCompositePointerDownCaptureDrag(ev);
        if (ev.defaultPrevented && !before) return true;
        onCompositePointerDownCapturePan(ev);
        return ev.defaultPrevented;
      },
      onPointerMoveCapture: (ev) => {
        if (!compositeEditTimerId) return false;
        const before = ev.defaultPrevented;
        onCompositePointerMoveCaptureDrag(ev);
        if (ev.defaultPrevented && !before) return true;
        onCompositePointerMoveCapturePan(ev);
        return ev.defaultPrevented;
      },
      onPointerUpCapture: (ev) => {
        if (!compositeEditTimerId) return false;
        onCompositePointerUpCaptureDrag(ev);
        stopCompositePan();
        return true;
      },
      onPointerCancelCapture: (_ev) => {
        if (!compositeEditTimerId) return false;
        // Stop pan and clear transient drag state without persisting.
        stopCompositePan();
        compositeDragMode = "none";
        compositeActiveHandle = null;
        compositeStartGeom = null;
        compositeArrowDrag = null;
        compositeSplitDrag = null;
        (window as any).__ip_compositeDragging = false;
        setBodyCursor("");
        stage.style.cursor = "";
        compositeDirty = false;
        compositeBeforeModel = null;
        return true;
      },
    },
  };
}
