import type { Store } from "./store";
import { activeView, fitCameraToScreen, resolveViewCamera } from "./store";
import { screenToWorld, worldToScreen } from "./geom";
import type { Anchor, Transform } from "./model";
import type { Model } from "./model";
import {
  persistArrow,
  persistBullets,
  persistDelete,
  persistGeometry,
  persistImage,
  persistJoin,
  persistText,
  uploadImageFile,
} from "./transport";
import { isNodeInteractiveInMode } from "./mode";
import { createHandlesView, anchorFrac, type HandleId } from "../editor/handles";
import { cursorForResize, cursorForRotate } from "../editor/cursors";

type PointerOwner =
  | null
  | {
      kind: "move";
      pointerId: number;
      nodeId: string;
      targetIds: string[];
      starts: Array<{ id: string; x: number; y: number }>;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      dirty: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startCx: number;
      startCy: number;
    }
  | {
      kind: "rselect";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      dirty: boolean;
      startSnapshot: Snapshot;
    }
  | {
      kind: "rotate";
      pointerId: number;
      nodeId: string;
      targetIds: string[];
      starts: Array<{ id: string; rotationDeg: number }>;
      corner: "nw" | "ne";
      startAngleRad: number;
      startRotationDeg: number;
      dirty: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "resize";
      pointerId: number;
      nodeId: string;
      targetIds: string[];
      starts: Array<{ id: string; w: number; h: number; fontPx: number }>;
      handle: Exclude<HandleId, "rot">;
      startW: number;
      startH: number;
      startFontPx: number;
      dirty: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "arrow-move";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startStart: { x: number; y: number };
      startEnd: { x: number; y: number };
      dirty: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "arrow-end";
      pointerId: number;
      nodeId: string;
      endId: "start" | "end";
      dirty: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "arrow-create";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      dirty: boolean;
      startSnapshot: Snapshot | null;
    };

type Snapshot = { model: Model; activeViewId: string; selectedId: string | null; selectedIds: string[] };
type TextAlign = "left" | "center" | "right";

const DRAG_START_PX = 3;
const GRID_BASE_WORLD = 1;
const GRID_MAJOR_TARGET_PX = 225;
const ROT_SNAP_DEG = 15;

const snapTo = (v: number, step: number) => {
  if (!Number.isFinite(v) || !Number.isFinite(step) || step <= 0) return v;
  return Math.round(v / step) * step;
};

const gridMajorStepWorld = (zoom: number) => {
  const z = Math.max(1e-6, zoom);
  const raw = GRID_MAJOR_TARGET_PX / (GRID_BASE_WORLD * z);
  const k = Math.round(Math.log10(Math.max(1e-9, raw)));
  const kClamped = Math.max(-10, Math.min(10, k));
  return GRID_BASE_WORLD * Math.pow(10, kClamped);
};

const parseBulletIndent = (line: string) => {
  let tabs = 0;
  let spaces = 0;
  for (const ch of line) {
    if (ch === "\t") tabs += 1;
    else if (ch === " ") spaces += 1;
    else break;
  }
  return { indent: tabs + Math.floor(spaces / 2), leadChars: tabs + spaces };
};

const bulletSpecForLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^[-.>]\s+/.test(trimmed)) return trimmed[0]!;
  const m = trimmed.match(/^(\d+|[A-Za-z])([.)])\s+/);
  if (!m) return null;
  const token = m[1]!;
  const sep = m[2]!;
  if (/^\d+$/.test(token)) return `1${sep}`;
  if (token >= "A" && token <= "Z") return `A${sep}`;
  return `a${sep}`;
};

const stripBulletMarker = (line: string) => {
  const trimmed = line.trimStart();
  if (/^[-.>]\s+/.test(trimmed)) return trimmed.replace(/^[-.>]\s+/, "");
  const m = trimmed.match(/^(\d+|[A-Za-z])[.)]\s+/);
  if (m) return trimmed.replace(/^(\d+|[A-Za-z])[.)]\s+/, "");
  return line;
};

const bulletsItemsToRaw = (items: Array<{ text: string; indent: number }>) => {
  return items.map((item) => `${"\t".repeat(Math.max(0, item.indent || 0))}${item.text}`).join("\n");
};

const toAlpha = (n: number, upper: boolean) => {
  let v = Math.max(1, Math.floor(n));
  let out = "";
  while (v > 0) {
    v -= 1;
    out = String.fromCharCode((v % 26) + 97) + out;
    v = Math.floor(v / 26);
  }
  return upper ? out.toUpperCase() : out;
};

const toRoman = (n: number, upper: boolean) => {
  let v = Math.max(1, Math.floor(n));
  const map: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let out = "";
  for (const [val, sym] of map) {
    while (v >= val) {
      out += sym;
      v -= val;
    }
  }
  return upper ? out.toUpperCase() : out;
};

const formatOrderedLabel = (token: string, value: number, sep: string) => {
  const suffix = sep === "-" ? "–" : sep === ")" ? ")" : ".";
  if (token === "1") return `${value}${suffix}`;
  if (token === "a") return `${toAlpha(value, false)}${suffix}`;
  if (token === "A") return `${toAlpha(value, true)}${suffix}`;
  if (token === "i") return `${toRoman(value, false)}${suffix}`;
  if (token === "I") return `${toRoman(value, true)}${suffix}`;
  return `${value}${suffix}`;
};

const buildBulletMarker = (specRaw: string, counters: number[], indent: number) => {
  const spec = specRaw.trim();
  if (!spec) return "";
  const unordered = spec.length === 1 && ["-", ".", ">"].includes(spec);
  if (unordered) {
    const glyph = spec === "-" ? "–" : spec === ">" ? "›" : "•";
    return `${glyph}`;
  }
  const sep = [".", ")", "-"].includes(spec[spec.length - 1] ?? "") ? spec[spec.length - 1] : ".";
  const tokenRaw = sep && spec.endsWith(sep) ? spec.slice(0, -1) : spec;
  const tokens = tokenRaw.split(".").map((t) => t.trim()).filter(Boolean);
  const token = tokens[Math.min(indent, tokens.length - 1)] ?? "1";
  const count = counters[indent] ?? 1;
  return formatOrderedLabel(token, count, sep);
};

const parseBulletEditorValue = (value: string) => {
  const lines = value.split("\n");
  const items: Array<{ text: string; indent: number }> = [];
  let spec: string | null = null;
  for (const line of lines) {
    if (line === "") {
      items.push({ text: "", indent: 0 });
      continue;
    }
    const { indent } = parseBulletIndent(line);
    const content = line.replace(/^[\t ]+/, "");
    if (!spec) {
      const found = bulletSpecForLine(content);
      if (found) spec = found;
    }
    const raw = stripBulletMarker(content);
    items.push({ text: raw, indent });
  }
  const rawText = bulletsItemsToRaw(items);
  return { items, rawText, spec };
};

const mergeBulletSpec = (existingRaw: string | undefined, parsed: string | null) => {
  if (!parsed) return existingRaw || null;
  if (parsed.length === 1 && ["-", ".", ">"].includes(parsed)) return parsed;
  const existing = (existingRaw || "").trim();
  const sep = [".", ")", "-"].includes(parsed[parsed.length - 1] ?? "") ? parsed[parsed.length - 1] : ".";
  const token = parsed.replace(/[.)-]$/, "");
  if (!existing) return `${token}${sep}`;
  if (existing.length === 1 && ["-", ".", ">"].includes(existing)) return `${token}${sep}`;
  const existingSep = [".", ")", "-"].includes(existing[existing.length - 1] ?? "") ? existing[existing.length - 1] : ".";
  const tokenRaw = existingSep && existing.endsWith(existingSep) ? existing.slice(0, -1) : existing;
  const tokens = tokenRaw.split(".").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return `${token}${sep}`;
  tokens[0] = token;
  return `${tokens.join(".")}${sep}`;
};

const renderBulletEditorValue = (items: Array<{ text: string; indent: number }>, spec: string) => {
  const lines: string[] = [];
  const counters: number[] = [];
  for (const item of items) {
    const indent = Math.max(0, item.indent || 0);
    while (counters.length <= indent) counters.push(0);
    counters[indent] += 1;
    for (let i = indent + 1; i < counters.length; i++) counters[i] = 0;
    const marker = buildBulletMarker(spec, counters, indent);
    const pad = "\t".repeat(indent);
    const markerText = marker ? `${marker} ` : "";
    lines.push(`${pad}${markerText}${item.text}`);
  }
  return lines.join("\n");
};

const mapCaretToRaw = (value: string, pos: number) => {
  const lines = value.split("\n");
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = acc;
    const lineEnd = acc + line.length;
    if (pos <= lineEnd) {
      const content = line.replace(/^[\t ]+/, "");
      const raw = stripBulletMarker(content);
      const markerLen = content.length - raw.length;
      const indentChars = line.length - content.length;
      const col = Math.max(0, pos - lineStart - indentChars - markerLen);
      return { line: i, col };
    }
    acc = lineEnd + 1;
  }
  return { line: lines.length - 1, col: 0 };
};

const mapRawToCaret = (value: string, target: { line: number; col: number }) => {
  const lines = value.split("\n");
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === target.line) {
      const content = line.replace(/^[\t ]+/, "");
      const raw = stripBulletMarker(content);
      const markerLen = content.length - raw.length;
      const indentChars = line.length - content.length;
      const col = Math.max(0, Math.min(raw.length, target.col));
      return acc + indentChars + markerLen + col;
    }
    acc += line.length + 1;
  }
  return Math.max(0, acc - 1);
};

const normalizeTransformForPersist = (store: Store, transform: Transform, viewId: string, space: string | undefined) => {
  if (space !== "world") return transform;
  const cam = resolveViewCamera(store, viewId);
  const designW = (store.model as any).defaults?.designWidth ?? 1920;
  const designH = (store.model as any).defaults?.designHeight ?? 1080;
  const viewW = designW / Math.max(1e-9, cam.zoom || 1);
  const viewH = designH / Math.max(1e-9, cam.zoom || 1);
  const left = cam.cx - viewW / 2;
  const bottom = cam.cy - viewH / 2;
  const aspect = designH / designW;
  return {
    ...transform,
    x: (transform.x - left) / viewW,
    y: ((transform.y - bottom) / viewH) * aspect,
    w: transform.w / viewW,
    h: (transform.h / viewH) * aspect,
  };
};

// Cursor angles are authored/understood in Viktor's coordinate system:
// - + angle is CCW
// - +y is up (mathematical)
//
// SVG/CSS are screen coordinates (+y down), so positive rotation appears clockwise.
// Mapping: svgAngle = -yourAngle
const toSvgAngle = (yourAngleDeg: number) => -yourAngleDeg;

const snapAngle = (deg: number, stepDeg: number) => snapTo(deg, stepDeg);

const cursorAngleYourForHandle = (rotYour: number, handle: Exclude<HandleId, "rot">) => {
  // Handle "orientation" angles expressed in Viktor coordinates (CCW-positive).
  // These are the same values validated in app/tools/cursors/raw-cursors.html.
  if (handle === "e" || handle === "w") return rotYour + 0;
  if (handle === "n" || handle === "s") return rotYour + 90;
  if (handle === "ne") return rotYour + 45;
  if (handle === "sw") return rotYour - 135;
  if (handle === "nw") return rotYour + 135;
  if (handle === "se") return rotYour - 45;
  return rotYour;
};

export function attachStateMachine(opts: { stage: HTMLElement; overlay: HTMLElement; store: Store }) {
  const { stage, overlay, store } = opts;
  let owner: PointerOwner = null;
  const handles = createHandlesView(overlay);
  // "Armed leave" tracking: if the overlay is already under the mouse on load,
  // some browsers won't fire pointerenter until you move. We only want to react
  // to pointerleave after we've *actually* observed an enter at least once.
  let overlayEverEntered = false;
  let overlayIsOver = false;
  let lastClient: { x: number; y: number } | null = null;
  const isInteractive = (node: any) => isNodeInteractiveInMode(store.mode, node as any);
  const docForNode = (node: any): "presentation" | "notes" => ((node as any).layer === "live" ? "notes" : "presentation");
  const groupIdsByDoc = (ids: string[]) => {
    const by: Record<"presentation" | "notes", string[]> = { presentation: [], notes: [] };
    for (const id of ids) {
      const n: any = store.model.nodes.find((x) => String(x?.id ?? "") === String(id));
      if (!n) continue;
      by[docForNode(n)].push(String(id));
    }
    return by;
  };

  const activeViewRef = () => {
    const v = store.model.views.find((x) => x.id === store.activeViewId);
    return v ?? store.model.views[0]!;
  };

  const cameraForScreen = () => {
    if (store.cameraOverride) return store.cameraOverride;
    return fitCameraToScreen(resolveViewCamera(store, store.activeViewId), store);
  };

  const cameraForEdit = () => store.cameraOverride ?? fitCameraToScreen(resolveViewCamera(store, store.activeViewId), store);

  const liveCueIndexByView = new Map<string, number>();
  let lastMode: "edit" | "screen-edit" | "live" = store.mode;

  const isNodeForView = (node: any, viewId: string, screenId?: string) => {
    const nodeScreen = node?.screenId;
    const nodeView = node?.viewId;
    if (nodeScreen != null) return nodeScreen === screenId;
    if (nodeView != null) return nodeView === viewId;
    return true;
  };

  const viewCues = (viewId: string) => {
    const cues = store.model.animationCues ?? [];
    const filtered = cues.filter((c) => {
      if (c.screenId != null) return false;
      if (c.viewId != null) return c.viewId === viewId;
      return true;
    });
    const viewOrder = new Map<string, number>();
    for (let i = 0; i < store.model.views.length; i++) {
      viewOrder.set(store.model.views[i]!.id, i);
    }
    return filtered
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) => {
        const aV = a.c.viewId;
        const bV = b.c.viewId;
        if (aV && bV) {
          const aIdx = viewOrder.get(aV) ?? 0;
          const bIdx = viewOrder.get(bV) ?? 0;
          if (aIdx !== bIdx) return aIdx - bIdx;
        } else if (aV && !bV) {
          return -1;
        } else if (!aV && bV) {
          return 1;
        }
        return a.idx - b.idx;
      })
      .map((x) => x.c);
  };

  let pendingAuto: { viewId: string; index: number; runAtMs: number } | null = null;

  const startViewTransition = (fromCam: { cx: number; cy: number; zoom: number }, toCam: { cx: number; cy: number; zoom: number }, durationMs: number) => {
    const now = performance.now();
    store.cameraOverride = { ...fromCam };
    store.cameraTween = {
      idx: 0,
      segments: [{ from: { ...fromCam }, to: { ...toCam }, durationMs, startMs: now, easing: "cos2" }],
    };
  };

  const initLiveView = (viewId: string, animate = false, resetCues = false) => {
    const v = store.model.views.find((x) => x.id === viewId) ?? store.model.views[0];
    if (!v) return;
    const baseFrom = store.cameraOverride ?? resolveViewCamera(store, store.activeViewId);
    const fromCam = store.cameraOverride ? baseFrom : fitCameraToScreen(baseFrom, store);
    const durationMs = (v as any).durationMs ?? (store.model as any).defaults?.viewTransitionMs ?? 1200;
    if (animate) {
      store.transitionFromViewId = store.activeViewId;
      store.transitionToViewId = v.id;
    } else {
      store.transitionFromViewId = null;
      store.transitionToViewId = null;
    }
    store.activeViewId = v.id;
    if (animate) {
      const target = fitCameraToScreen(resolveViewCamera(store, v.id), store);
      startViewTransition(fromCam, { ...target, zoom: fromCam.zoom }, durationMs);
    }
    else {
      store.cameraOverride = null;
      store.cameraTween = null;
    }
    const cues = viewCues(v.id);
    const existingIdx = liveCueIndexByView.get(v.id);
    const nextIdx = resetCues ? 0 : existingIdx != null ? existingIdx : 0;
    resetViewToCueIndex(cues, nextIdx);
    liveCueIndexByView.set(v.id, nextIdx);
    pendingAuto = null;
  };

  const showNode = (node: any, timeMs: number) => {
    node.visible = true;
    node.__exitStartMs = null;
    node.__suppressAppear = false;
    node.__appearedOnce = false;
    if (node.appear) node.__forceAppearMs = timeMs;
  };

  const exitNode = (node: any, timeMs: number) => {
    node.visible = true;
    node.__exitStartMs = timeMs;
  };

  const animDurationMs = (node: any, isExit: boolean) => {
    const anim = isExit ? node.disappear : node.appear;
    if (!anim || !anim.kind) return 0;
    const kind = String(anim.kind);
    const delay = Number(anim.delayMs ?? 0);
    const cam = cameraForScreen();
    const screenW = Math.max(1e-9, store.screen?.w ?? 1);
    const screenH = Math.max(1e-9, store.screen?.h ?? 1);
    const wPx = node.space === "world" ? node.transform.w * cam.zoom : node.transform.w * screenW;
    const hPx = node.space === "world" ? node.transform.h * cam.zoom : node.transform.h * screenH;
    const whereRaw = String(node.where ?? anim.where ?? "");
    const where = whereRaw === "null" || whereRaw === "none" ? "" : whereRaw;
    const axisSize = where === "top" || where === "bottom" ? hPx : where === "left" || where === "right" ? wPx : Math.max(wPx, hPx);
    const toAnimPx = (v: any) => {
      const num = Number(v);
      if (!Number.isFinite(num)) return null;
      return Math.abs(num) <= 1 ? num * screenW : num;
    };
    const toAnimSpeed = (v: any) => {
      const num = Number(v);
      if (!Number.isFinite(num) || num <= 0) return null;
      return num <= 1 ? num * screenW : num;
    };
    if (kind === "sudden") return delay;
    if (kind === "fade") {
      const borderPx = toAnimPx(anim.borderPx) ?? 0;
      if (!where || borderPx <= 0) return delay;
      const speed = toAnimSpeed(anim.speedPxS);
      if (speed && speed > 0) return delay + (axisSize / speed) * 1000;
      const dur = Number(anim.durationMs ?? 0);
      return delay + (dur > 0 ? dur : 0);
    }
    if (kind === "move") {
      const distance = toAnimPx(anim.distancePx) ?? axisSize;
      const speed = toAnimSpeed(anim.speedPxS);
      if (speed && speed > 0) return delay + (distance / speed) * 1000;
      const dur = Number(anim.durationMs ?? 0);
      return delay + (dur > 0 ? dur : 0);
    }
    if (kind === "pixelate") {
      const dur = Number(anim.durationMs ?? 0);
      return delay + (dur > 0 ? dur : 800);
    }
    return delay;
  };

  const runCueBatch = (cues: any[], startIdx: number, nowMs: number) => {
    let idx = startIdx;
    let batchDuration = 0;
    const v = activeView(store);
    const screenId = (v as any).screenId;
    while (idx < cues.length) {
      const cue = cues[idx]!;
      if (idx > startIdx && cue.when !== "same") break;
      const node = store.model.nodes.find((n: any) => String(n.id) === String(cue.id));
      if (node && node.space !== "screen" && isNodeForView(node, v.id, screenId)) {
        const isExit = cue.what === "exit";
        if (isExit) exitNode(node, nowMs);
        else showNode(node, nowMs);
        batchDuration = Math.max(batchDuration, animDurationMs(node, isExit));
      }
      idx += 1;
    }
    return { nextIdx: idx, batchDuration };
  };

  const resetViewToCueIndex = (cues: any[], nextIndex: number) => {
    const v = activeView(store);
    const viewId = v.id;
    const enterIds = new Set(cues.filter((c) => c.what === "enter").map((c) => String(c.id)));
    const exitIds = new Set(cues.filter((c) => c.what === "exit").map((c) => String(c.id)));
    for (const n of store.model.nodes as any[]) {
      if (n.space === "screen") continue;
      if (!isNodeForView(n, viewId)) {
        n.visible = false;
        (n as any).__exitStartMs = null;
        continue;
      }
      if (enterIds.has(String(n.id))) n.visible = false;
      else if (exitIds.has(String(n.id))) n.visible = true;
      else n.visible = true;
      (n as any).__exitStartMs = null;
      (n as any).__suppressAppear = true;
      (n as any).__appearedOnce = true;
    }
    for (let i = 0; i < Math.max(0, nextIndex); i++) {
      const cue = cues[i]!;
      const node = store.model.nodes.find((n: any) => String(n.id) === String(cue.id));
      if (!node || node.space === "screen" || !isNodeForView(node, viewId)) continue;
      if (cue.what === "exit") node.visible = false;
      else node.visible = true;
      (node as any).__exitStartMs = null;
      (node as any).__suppressAppear = true;
      (node as any).__appearedOnce = true;
    }
  };
  let activeTextEditor:
    | {
        nodeId: string;
        el: HTMLTextAreaElement;
        errEl: HTMLDivElement;
        alignEl: HTMLDivElement;
        alignDots: Record<TextAlign, HTMLButtonElement>;
        prevText: string;
        everEntered: boolean;
        startSnapshot: Snapshot;
      }
    | null = null;
  // When we create a new text node from typing, the DOM/editor may appear on the next frame.
  // During that gap, route keystrokes (including Space) into that new node.
  let pendingTextEdit: { nodeId: string } | null = null;
  let lastClick: { atMs: number; nodeId: string; x: number; y: number } | null = null;
  let lastCanvasClick: { atMs: number; x: number; y: number } | null = null;
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  type ClipboardNode = { node: any; relAnchor: { dx: number; dy: number } };
  type Clipboard = { nodes: ClipboardNode[]; primaryType: string };
  let internalClipboard: Clipboard | null = null;
  let lastPasteClient: { x: number; y: number } | null = null;
  let pasteNudgeSteps = 0;
  const marquee = document.createElement("div");
  marquee.className = "marquee";
  marquee.style.display = "none";
  overlay.appendChild(marquee);

  const relayoutActiveTextEditor = () => {
    const ed = activeTextEditor;
    if (!ed) return;
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(ed.nodeId)}"]`);
    if (!nodeEl) return;
    const nr = nodeEl.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();
    const left = nr.left - or.left;
    const width = nr.width;

    // Keep editor width glued to bbox width.
    ed.el.style.left = `${left}px`;
    ed.el.style.width = `${width}px`;

    // Rows: one more than number of lines (min 2).
    const lines = String(ed.el.value ?? "").split("\n").length;
    ed.el.rows = Math.max(2, lines + 1);

    // Place just above bbox.
    const h = ed.el.getBoundingClientRect().height;
    const top = Math.max(8, nr.top - or.top - h - 6);
    ed.el.style.top = `${top}px`;

    ed.errEl.style.left = ed.el.style.left;
    ed.errEl.style.width = ed.el.style.width;
    ed.errEl.style.top = `${top + h + 4}px`;

    ed.alignEl.style.left = ed.el.style.left;
    ed.alignEl.style.top = ed.el.style.top;
    ed.alignEl.style.width = ed.el.style.width;
    ed.alignEl.style.height = "0px";
  };

  const cloneModel = (m: Model): Model => {
    const sc: any = (globalThis as any).structuredClone;
    if (typeof sc === "function") return sc(m);
    return JSON.parse(JSON.stringify(m)) as Model;
  };

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

  const persistModelToFiles = (prevIds: Set<string>) => {
    const currentIds = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
    const removed = Array.from(prevIds).filter((id) => !currentIds.has(id));
    if (removed.length) {
      const by = groupIdsByDoc(removed);
      if (by.presentation.length) void persistDelete({ ids: by.presentation, doc: "presentation" });
      if (by.notes.length) void persistDelete({ ids: by.notes, doc: "notes" });
    }
    for (const n of store.model.nodes as any[]) {
      if (!n) continue;
      const viewId = n.space === "screen" ? "screen_main" : String(n.viewId ?? store.activeViewId ?? "home");
      const doc = docForNode(n);
      if (n.type === "text") {
        void persistText({ id: String(n.id), viewId, text: String(n.text ?? ""), doc, space: n.space, align: normalizeAlign(n.align) });
      } else if (n.type === "bullets") {
        void persistBullets({
          id: String(n.id),
          viewId,
          text: String(n.rawText ?? ""),
          bullets: String(n.bullets ?? ""),
          doc,
          space: n.space,
          align: normalizeAlign(n.align),
        });
      } else if (n.type === "image") {
        void persistImage({ id: String(n.id), viewId, src: n.src, doc, space: n.space });
      } else if (n.type === "join") {
        void persistJoin({
          id: String(n.id),
          viewId,
          text: String(n.text ?? ""),
          fields: Array.isArray(n.fields) ? n.fields : [],
          doc,
          space: n.space,
        });
      } else if (n.type === "arrow") {
        const start = normalizePointForPersist(n.start ?? { x: 0, y: 0.5 }, viewId, n.space);
        const end = normalizePointForPersist(n.end ?? { x: 1, y: 0.5 }, viewId, n.space);
        const color = typeof n.color === "string" && n.color.includes(",") ? "white" : n.color;
        void persistArrow({
          id: String(n.id),
          viewId,
          start,
          end,
          color,
          strokePx: n.strokePx,
          doc,
          space: n.space,
        });
      }
      if (n.type !== "arrow") {
        void persistGeometry({
          id: String(n.id),
          viewId,
          transform: normalizeTransformForPersist(store, n.transform, viewId, n.space),
          fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
          doc,
          space: n.space,
        });
      }
    }
  };

  const restoreSnapshot = (snap: Snapshot) => {
    store.model = cloneModel(snap.model);
    store.activeViewId = snap.activeViewId;
    store.selectedId = snap.selectedId;
    store.selectedIds = [...(snap.selectedIds ?? (snap.selectedId ? [snap.selectedId] : []))];
    updateHandles();
  };

  const newId = (prefix = "n") => {
    const existing = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
    const mk = () => {
      const c: any = (globalThis as any).crypto;
      if (c?.randomUUID) return `${prefix}_${c.randomUUID().slice(0, 8)}`;
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    };
    let id = mk();
    // Extremely unlikely loop, but keep it correct.
    while (existing.has(id)) id = mk();
    return id;
  };

  const normalizeAlign = (value: any): TextAlign => {
    if (value === "left" || value === "center" || value === "right") return value;
    return "left";
  };

  const updateEditorAlignUi = (ed: NonNullable<typeof activeTextEditor>, align: TextAlign) => {
    ed.el.style.textAlign = align;
    (["left", "center", "right"] as TextAlign[]).forEach((key) => {
      ed.alignDots[key].classList.toggle("is-current", key === align);
    });
  };

  const applyNodeAlign = (nodeId: string, align: TextAlign) => {
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    if (!node || (node.type !== "text" && node.type !== "bullets")) return;
    node.align = align;
    if (activeTextEditor && activeTextEditor.nodeId === nodeId) {
      updateEditorAlignUi(activeTextEditor, align);
    }
    const persistViewId = node.space === "screen" ? "screen_main" : store.activeViewId;
    if (node.type === "text") {
      void persistText({
        id: String(node.id),
        viewId: persistViewId,
        text: String(node.text ?? ""),
        doc: docForNode(node),
        space: node.space,
        align,
      });
    } else if (node.type === "bullets") {
      void persistBullets({
        id: String(node.id),
        viewId: persistViewId,
        text: String(node.rawText ?? ""),
        bullets: String(node.bullets ?? ""),
        doc: docForNode(node),
        space: node.space,
        align,
      });
    }
  };

  const clearSelection = () => {
    store.selectedId = null;
    store.selectedIds = [];
    updateHandles();
  };

  const setSingleSelection = (id: string | null) => {
    store.selectedId = id;
    store.selectedIds = id ? [id] : [];
    updateHandles();
  };

  const setMultiSelection = (ids: string[], preferredPrimary?: string | null) => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    store.selectedIds = uniq;
    if (preferredPrimary && uniq.includes(preferredPrimary)) {
      store.selectedId = preferredPrimary;
    } else {
      store.selectedId = uniq[0] ?? null;
    }
    updateHandles();
  };

  const screenAabbForNode = (node: any) => {
    if (node.type === "arrow") {
      const ends = arrowEndpointsScreen(node);
      const minX = Math.min(ends.start.x, ends.end.x);
      const maxX = Math.max(ends.start.x, ends.end.x);
      const minY = Math.min(ends.start.y, ends.end.y);
      const maxY = Math.max(ends.start.y, ends.end.y);
      return { minX, minY, maxX, maxY };
    }
    const cam = cameraForScreen();
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const { ax, ay } = anchorFrac(node.transform.anchor);
    const isWorld = node.space === "world";
    const w = isWorld ? node.transform.w * cam.zoom : node.transform.w * screen.w;
    const h = isWorld ? node.transform.h * cam.zoom : node.transform.h * screen.h;
    const xMin = -ax * w;
    const xMax = (1 - ax) * w;
    const yMin = -ay * h;
    const yMax = (1 - ay) * h;
    const rot = (node.transform.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners = [
      { x: xMin, y: yMin },
      { x: xMax, y: yMin },
      { x: xMax, y: yMax },
      { x: xMin, y: yMax },
    ].map((p) => {
      if (isWorld) {
        const wx = node.transform.x + p.x * cos - p.y * sin;
        const wy = node.transform.y + p.x * sin + p.y * cos;
        return worldToScreen({ x: wx, y: wy }, cam, screen);
      }
      const axPx = node.transform.x * screen.w;
      const ayPx = (1 - node.transform.y) * screen.h;
      const sx = axPx + p.x * cos - p.y * sin;
      const sy = ayPx + p.x * sin + p.y * cos;
      return { x: sx, y: sy };
    });
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    return { minX, minY, maxX, maxY };
  };

  const createTextNodeAtClientPoint = (clientX: number, clientY: number, initialText: string) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const id = newId("t");
    const defaultWpx = 250;
    const defaultHpx = 80;
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const relX = (clientX - r.left) / Math.max(1e-9, r.width);
    const relY = 1 - (clientY - r.top) / Math.max(1e-9, r.height);
    const n: any = {
      id,
      type: "text",
      space: isScreen ? "screen" : "world",
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        // world: world units; screen: relative coords (0..1) with origin bottom-left
        x: isScreen ? relX : wp!.x,
        y: isScreen ? relY : wp!.y,
        // world: size stored in world units derived from px; screen: store in relative coords
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / cam.zoom,
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / cam.zoom,
        rotationDeg: 0,
        anchor: "centerCenter",
      },
      text: initialText,
      color: "rgba(255,255,255,0.92)",
      fontPx: 32,
      align: "left",
    };
    store.model.nodes.push(n);
    setSingleSelection(id);
    // Persist creation: element in .pr and geometry in geometries.csv
    const doc = docForNode(n);
    const persistViewId = isScreen ? "screen_main" : store.activeViewId;
    void persistText({ id: String(id), viewId: persistViewId, text: String(initialText), doc, space: n.space, align: n.align });
    void persistGeometry({
      id: String(id),
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space),
      fontPx: n.fontPx,
      doc,
      space: n.space,
    });
    return id;
  };

  const createImageNodeAtClientPoint = (clientX: number, clientY: number, opts: { src: string; filename?: string; aspect?: number }) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const relX = (clientX - r.left) / Math.max(1e-9, r.width);
    const relY = 1 - (clientY - r.top) / Math.max(1e-9, r.height);
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const baseName = String(opts.filename ?? "image").replace(/\.[^/.]+$/, "");
    const safeBase = baseName.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
    const existing = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
    let id = safeBase;
    let i = 2;
    while (existing.has(id)) {
      id = `${safeBase}_${i}`;
      i += 1;
    }
    const defaultWpx = 240;
    const aspect = Math.max(1e-6, Number(opts.aspect ?? 1));
    const defaultHpx = defaultWpx / aspect;
    const n: any = {
      id,
      type: "image",
      space: isScreen ? "screen" : "world",
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        x: isScreen ? relX : wp!.x,
        y: isScreen ? relY : wp!.y,
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / cam.zoom,
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / cam.zoom,
        rotationDeg: 0,
        anchor: "centerCenter",
      },
      src: opts.src,
    };
    if (isScreen) n.screenId = "screen_main";
    else n.viewId = store.activeViewId;
    store.model.nodes.push(n);
    setSingleSelection(id);
    const doc = docForNode(n);
    const persistViewId = isScreen ? "screen_main" : store.activeViewId;
    void persistImage({ id, viewId: persistViewId, src: n.src, doc, space: n.space });
    void persistGeometry({
      id,
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space),
      doc,
      space: n.space,
    });
    return id;
  };

  const updateHoverCursorAtClientPoint = (clientX: number, clientY: number, ev?: PointerEvent | null) => {
    const selectedIds = store.selectedIds ?? [];
    if (!selectedIds.length) {
      overlay.style.cursor = "";
      return;
    }

    // If multiple items are selected, choose the best handle hit among them.
    let best: { nodeId: string; h: { id: HandleId; d2: number } } | null = null;
    for (const nodeId of selectedIds) {
      const h = hitVirtualHandleAtClientPoint(clientX, clientY, nodeId);
      if (!h) continue;
      if (!best || h.d2 < best.h.d2) best = { nodeId, h };
    }

    const nodeId = best?.nodeId ?? store.selectedId ?? selectedIds[0]!;
    const next = (ev ? hitHandle(ev) : null) ?? best?.h ?? hitVirtualHandleAtClientPoint(clientX, clientY, nodeId);
    const handleId = (next as any)?.id ? (next as any).id : (next as any);

    if (nodeId) {
      const node = store.model.nodes.find((n) => n.id === nodeId) as any;
      if (node?.type === "arrow") {
        const ends = arrowEndpointsScreen(node);
        const endRadius = 20;
        const dStart = Math.hypot(clientX - ends.start.x, clientY - ends.start.y);
        const dEnd = Math.hypot(clientX - ends.end.x, clientY - ends.end.y);
        if (dStart <= endRadius || dEnd <= endRadius) {
          overlay.style.cursor = "pointer";
          return;
        }
        const lineHit = distPointToSegment(clientX, clientY, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
        if (lineHit <= arrowLineHitPx(node)) {
          overlay.style.cursor = "grab";
          return;
        }
      }
    }

    if (handleId && String(handleId).startsWith("anchor:")) {
      overlay.style.cursor = "pointer";
      return;
    }

    if (handleId && String(handleId).startsWith("anchor:")) {
      overlay.style.cursor = "pointer";
      return;
    }

    if (nodeId && handleId && !String(handleId).startsWith("anchor:")) {
      const node = store.model.nodes.find((n) => n.id === nodeId);
      if (node) {
        // IMPORTANT: model rotationDeg currently behaves like screen/CSS rotation (CW-positive),
        // so convert to Viktor's CCW-positive system before computing cursor angles.
        const rotYour = -node.transform.rotationDeg;
        const isRotateCorner = handleId === "nw" || handleId === "ne";
        const angleYour = cursorAngleYourForHandle(rotYour, handleId as any);
        if (isRotateCorner) {
          overlay.style.cursor = cursorForRotate(toSvgAngle(angleYour));
        } else {
          overlay.style.cursor = cursorForResize(toSvgAngle(snapAngle(angleYour, 45)));
        }
        return;
      }
    }
    overlay.style.cursor = "";
  };

  const onOverlayPointerEnter = () => {
    overlayEverEntered = true;
    overlayIsOver = true;
  };
  const onOverlayPointerLeave = () => {
    overlayIsOver = false;
    if (!overlayEverEntered) return;
    if (!owner) overlay.style.cursor = "";
  };

  const hitNodeId = (ev: PointerEvent): string | null => {
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.(".text-editor")) return null;
    const el = t?.closest?.(".node") as HTMLElement | null;
    const id = String(el?.dataset?.nodeId ?? "");
    if (!id) return null;
    const node = store.model.nodes.find((n) => n.id === id) as any;
    if (!node) return null;
    if (node.type === "arrow") {
      const ends = arrowEndpointsScreen(node);
      const hit = distPointToSegment(ev.clientX, ev.clientY, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
      const threshold = arrowLineHitPx(node);
      if (hit > threshold) return null;
    }
    return isInteractive(node) ? id : null;
  };

  const hitHandle = (ev: PointerEvent): HandleId | null => {
    const t = ev.target as HTMLElement | null;
    const h = t?.closest?.("[data-handle-id]") as HTMLElement | null;
    return (h?.dataset?.handleId as HandleId | undefined) ?? null;
  };

  const pickNodeNearClientPoint = (clientX: number, clientY: number): string | null => {
    const cam = cameraForScreen();
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;

    // Prefer highest zIndex.
    let best: { id: string; z: number; order: number } | null = null;
    for (let i = 0; i < store.model.nodes.length; i++) {
      const n: any = store.model.nodes[i];
      if (!n || n.visible === false) continue;
      if (!isInteractive(n)) continue;
      if (n.type === "arrow") {
        const ends = arrowEndpointsScreen(n);
        const hit = distPointToSegment(px, py, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
        const threshold = arrowLineHitPx(n);
        if (hit > threshold) continue;
        const z = Number(n.zIndex ?? 0);
        if (!best || z > best.z || (z === best.z && i > best.order)) best = { id: String(n.id), z, order: i };
        continue;
      }
      const isWorld = n.space === "world";
      const wPx = isWorld ? n.transform.w * cam.zoom : n.transform.w * screen.w;
      const hPx = isWorld ? n.transform.h * cam.zoom : n.transform.h * screen.h;
      const { ax, ay } = anchorFrac(n.transform.anchor);
      const left = -ax * wPx;
      const right = (1 - ax) * wPx;
      const top = -ay * hPx;
      const bottom = (1 - ay) * hPx;
      const anchorScreen = isWorld
        ? worldToScreen({ x: n.transform.x, y: n.transform.y }, cam, screen)
        : { x: n.transform.x * screen.w, y: (1 - n.transform.y) * screen.h };
      const dx = px - anchorScreen.x;
      const dy = py - anchorScreen.y;
      const rot = (n.transform.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;

      const OUTSIDE = 20;
      const inExpanded = lx >= left - OUTSIDE && lx <= right + OUTSIDE && ly >= top - OUTSIDE && ly <= bottom + OUTSIDE;
      if (!inExpanded) continue;

      const z = Number(n.zIndex ?? 0);
      if (!best || z > best.z || (z === best.z && i > best.order)) best = { id: String(n.id), z, order: i };
    }
    return best?.id ?? null;
  };

  const localForNodePx = (node: any, clientX: number, clientY: number) => {
    const cam = cameraForScreen();
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;

    const isWorld = node.space === "world";
    const zoom = isWorld ? cam.zoom : 1;
    const wPx = isWorld ? node.transform.w * cam.zoom : node.transform.w * screen.w;
    const hPx = isWorld ? node.transform.h * cam.zoom : node.transform.h * screen.h;
    const { ax, ay } = anchorFrac(node.transform.anchor);
    const left = -ax * wPx;
    const right = (1 - ax) * wPx;
    const top = -ay * hPx;
    const bottom = (1 - ay) * hPx;

    const anchorScreen = isWorld
      ? worldToScreen({ x: node.transform.x, y: node.transform.y }, cam, screen)
      : { x: node.transform.x * screen.w, y: (1 - node.transform.y) * screen.h };
    const dx = px - anchorScreen.x;
    const dy = py - anchorScreen.y;
    const rot = (node.transform.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return { left, right, top, bottom, lx, ly, rotDeg: node.transform.rotationDeg, zoom };
  };

  const arrowEndpointsScreen = (node: any) => {
    const cam = cameraForScreen();
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const start = node.start ?? { x: 0, y: 0.5 };
    const end = node.end ?? { x: 1, y: 0.5 };
    const toScreen = (p: { x: number; y: number }) =>
      node.space === "world"
        ? worldToScreen({ x: p.x, y: p.y }, cam, screen)
        : { x: p.x * screen.w, y: (1 - p.y) * screen.h };
    const s = toScreen(start);
    const e = toScreen(end);
    return {
      start: { x: s.x, y: s.y },
      end: { x: e.x, y: e.y },
    };
  };

  const arrowPointFromClient = (node: any, clientX: number, clientY: number) => {
    const cam = cameraForScreen();
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;
    if (node.space === "world") {
      return screenToWorld({ x: px, y: py }, cam, screen);
    }
    return { x: px / Math.max(1e-9, screen.w), y: 1 - py / Math.max(1e-9, screen.h) };
  };

  const normalizePointForPersist = (p: { x: number; y: number }, viewId: string, space: string | undefined) => {
    if (space !== "world") return p;
    const cam = resolveViewCamera(store, viewId);
    const designW = (store.model as any).defaults?.designWidth ?? 1920;
    const designH = (store.model as any).defaults?.designHeight ?? 1080;
    const viewW = designW / Math.max(1e-9, cam.zoom || 1);
    const viewH = designH / Math.max(1e-9, cam.zoom || 1);
    const left = cam.cx - viewW / 2;
    const bottom = cam.cy - viewH / 2;
    const aspect = designH / designW;
    return {
      x: (p.x - left) / viewW,
      y: ((p.y - bottom) / viewH) * aspect,
    };
  };

  const updateArrowFromClientDrag = (node: any, startX: number, startY: number, endX: number, endY: number) => {
    const start = arrowPointFromClient(node, startX, startY);
    const end = arrowPointFromClient(node, endX, endY);
    node.start = start;
    node.end = end;
    syncArrowTransform(node);
  };

  const syncArrowTransform = (node: any) => {
    const s = node.start ?? { x: 0, y: 0.5 };
    const e = node.end ?? { x: 1, y: 0.5 };
    const minX = Math.min(s.x, e.x);
    const minY = Math.min(s.y, e.y);
    const maxX = Math.max(s.x, e.x);
    const maxY = Math.max(s.y, e.y);
    node.transform = {
      ...(node.transform ?? {}),
      x: minX,
      y: minY,
      w: Math.max(1e-9, maxX - minX),
      h: Math.max(1e-9, maxY - minY),
      rotationDeg: 0,
      anchor: "topLeft",
    };
  };

  const distPointToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const denom = abx * abx + aby * aby;
    if (denom <= 1e-9) return Math.hypot(apx, apy);
    let t = (apx * abx + apy * aby) / denom;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    return Math.hypot(px - cx, py - cy);
  };

  const arrowLineHitPx = (node: any) => {
    const strokePx = Math.max(1, Number(node?.strokePx ?? 4));
    return Math.max(12, strokePx * 2.5);
  };

  const hitVirtualHandleAtClientPoint = (
    clientX: number,
    clientY: number,
    nodeId: string | null
  ): { id: HandleId; d2: number } | null => {
    if (!nodeId) return null;
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    if (!isInteractive(node)) return null;
    const { left, right, top, bottom, lx, ly } = localForNodePx(node as any, clientX, clientY);
    const { ax, ay } = anchorFrac((node as any).transform.anchor);

    // Hover geometry
    const INSIDE = 5;
    const OUTSIDE = 20;
    const CORNER_ALONG = 20;

    // Disable anchor-side handles (same rule as existing UI)
    const hideW = ax <= 1e-9;
    const hideE = ax >= 1 - 1e-9;
    const hideN = ay <= 1e-9;
    const hideS = ay >= 1 - 1e-9;

    // IMPORTANT: band hit-tests must constrain BOTH axes.
    // Otherwise you'd get a cursor "anywhere" along a band axis (looks like OR instead of AND).
    const inYRange = ly >= top - OUTSIDE && ly <= bottom + OUTSIDE;
    const inXRange = lx >= left - OUTSIDE && lx <= right + OUTSIDE;
    const inLeftBand = !hideW && inYRange && lx >= left - OUTSIDE && lx <= left + INSIDE;
    const inRightBand = !hideE && inYRange && lx <= right + OUTSIDE && lx >= right - INSIDE;
    const inTopBand = !hideN && inXRange && ly >= top - OUTSIDE && ly <= top + INSIDE;
    const inBottomBand = !hideS && inXRange && ly <= bottom + OUTSIDE && ly >= bottom - INSIDE;

    const candidates: Array<{ id: HandleId; d2: number }> = [];
    const push = (hid: HandleId, ddx: number, ddy: number) => candidates.push({ id: hid, d2: ddx * ddx + ddy * ddy });

    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    // Four sides, each split into 3 regions: corner | middle | corner.
    if (inTopBand) {
      const alongL = lx - left;
      const alongR = right - lx;
      if (alongL <= CORNER_ALONG) push("nw", lx - left, ly - top);
      else if (alongR <= CORNER_ALONG) push("ne", lx - right, ly - top);
      else push("n", lx - midX, ly - top); // middle: closest-to-center wins naturally
    }
    if (inBottomBand) {
      const alongL = lx - left;
      const alongR = right - lx;
      if (alongL <= CORNER_ALONG) push("sw", lx - left, ly - bottom);
      else if (alongR <= CORNER_ALONG) push("se", lx - right, ly - bottom);
      else push("s", lx - midX, ly - bottom);
    }
    if (inLeftBand) {
      const alongT = ly - top;
      const alongB = bottom - ly;
      if (alongT <= CORNER_ALONG) push("nw", lx - left, ly - top);
      else if (alongB <= CORNER_ALONG) push("sw", lx - left, ly - bottom);
      else push("w", lx - left, ly - midY);
    }
    if (inRightBand) {
      const alongT = ly - top;
      const alongB = bottom - ly;
      if (alongT <= CORNER_ALONG) push("ne", lx - right, ly - top);
      else if (alongB <= CORNER_ALONG) push("se", lx - right, ly - bottom);
      else push("e", lx - right, ly - midY);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d2 - b.d2);
    return candidates[0]!;
  };

  const updateHandles = () => {
    const id = store.selectedId;
    if (!id) {
      handles.hide();
      return;
    }
    const node = store.model.nodes.find((n) => n.id === id);
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(id)}"]`);
    if (!node || !nodeEl || node.type === "arrow") {
      handles.hide();
      return;
    }
    handles.showFor(nodeEl, node.transform, node.transform.anchor);
  };

  const applyAnchorChange = (id: string, nextAnchor: Anchor) => {
    const node = store.model.nodes.find((n) => n.id === id);
    if (!node) return;
    const t = node.transform;
    const { ax: ax0, ay: ay0 } = anchorFrac(t.anchor);
    const { ax: ax1, ay: ay1 } = anchorFrac(nextAnchor);
    const rot = (t.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    if (node.space === "screen") {
      const sr = stage.getBoundingClientRect();
      const screen = { w: sr.width, h: sr.height };
      const anchorPxX = t.x * screen.w;
      const anchorPxY = (1 - t.y) * screen.h;
      const wPx = t.w * screen.w;
      const hPx = t.h * screen.h;
      const v0x = -ax0 * wPx;
      const v0y = -ay0 * hPx;
      const tlx = anchorPxX + v0x * cos - v0y * sin;
      const tly = anchorPxY + v0x * sin + v0y * cos;
      const v1x = -ax1 * wPx;
      const v1y = -ay1 * hPx;
      const nextAnchorPxX = tlx - (v1x * cos - v1y * sin);
      const nextAnchorPxY = tly - (v1x * sin + v1y * cos);
      node.transform = {
        ...t,
        anchor: nextAnchor,
        x: nextAnchorPxX / Math.max(1e-9, screen.w),
        y: 1 - nextAnchorPxY / Math.max(1e-9, screen.h),
      };
      return;
    }
    // Compute top-left in world from old anchor (rotation aware)
    const v0x = -ax0 * t.w;
    const v0y = -ay0 * t.h;
    const tlx = t.x + v0x * cos - v0y * sin;
    const tly = t.y + v0x * sin + v0y * cos;
    const v1x = -ax1 * t.w;
    const v1y = -ay1 * t.h;
    const nextX = tlx - (v1x * cos - v1y * sin);
    const nextY = tly - (v1x * sin + v1y * cos);
    node.transform = { ...t, anchor: nextAnchor, x: nextX, y: nextY };
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (store.mode === "live") {
      if (ev.button === 1 || ev.button === 0) {
        ev.preventDefault();
        return;
      }
    }
    // Keep mouse position updated even if the user clicks without moving.
    lastClient = { x: ev.clientX, y: ev.clientY };
    // Pan: middle mouse only (no Space-pan).
    if (ev.button === 1) {
      const cam = cameraForEdit();
      if (!store.cameraOverride) store.cameraOverride = { ...cam };
      owner = { kind: "pan", pointerId: ev.pointerId, startClientX: ev.clientX, startClientY: ev.clientY, startCx: cam.cx, startCy: cam.cy };
      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      overlay.style.cursor = "grabbing";
      ev.preventDefault();
      return;
    }
    // Right-drag marquee selection OR right-click clear selection.
    if (ev.button === 2) {
      // Right click outside the editor should commit+close it (same gesture as clear selection).
      if (activeTextEditor && !(ev.target as HTMLElement | null)?.closest?.(".text-editor")) {
        closeTextEditor({ commit: true });
      }
      owner = {
        kind: "rselect",
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        dirty: false,
        startSnapshot: snapshotNow(),
      };
      marquee.style.display = "none";
      marquee.style.left = "0px";
      marquee.style.top = "0px";
      marquee.style.width = "0px";
      marquee.style.height = "0px";
      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    if ((ev.target as HTMLElement | null)?.closest?.(".text-editor")) return;

    // Pan with left-drag on empty canvas.
    {
      const h = hitHandle(ev);
      const targetId = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      if (!h && !targetId) {
        if (!(ev.ctrlKey && store.mode !== "live")) {
          const cam = cameraForEdit();
          if (!store.cameraOverride) store.cameraOverride = { ...cam };
          owner = {
            kind: "pan",
            pointerId: ev.pointerId,
            startClientX: ev.clientX,
            startClientY: ev.clientY,
            startCx: cam.cx,
            startCy: cam.cy,
          };
          try {
            overlay.setPointerCapture(ev.pointerId);
          } catch (e) {
            console.error("[next][state] setPointerCapture failed", e);
          }
          overlay.style.cursor = "grabbing";
          ev.preventDefault();
          return;
        }
      }
    }

    // Double-click empty canvas toggles screen-edit.
    // (Native dblclick won't fire reliably since we preventDefault on pointer events.)
    {
      const h = hitHandle(ev);
      const targetId = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      if (!h && !targetId) {
        const now = performance.now();
        const prev = lastCanvasClick;
        const dt = prev ? now - prev.atMs : Infinity;
        const dpx = prev ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
        if (prev && dt < 420 && dpx < 10) {
          lastCanvasClick = null;
          store.mode = store.mode === "screen-edit" ? "edit" : "screen-edit";
          clearSelection();
          ev.preventDefault();
          return;
        }
        lastCanvasClick = { atMs: now, x: ev.clientX, y: ev.clientY };
      } else {
        lastCanvasClick = null;
      }
    }

    // Manual "double click" detection: native dblclick won't fire reliably since we
    // preventDefault on pointer events (which can cancel click/dblclick synthesis).
    // Only trigger when clicking on a TEXT node body (not handles) with minimal movement.
    {
      const targetId = store.selectedId ?? hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      const h = hitHandle(ev);
      const hvHit = h && !h.startsWith("anchor:") ? ({ id: h, d2: 0 } as any) : hitVirtualHandleAtClientPoint(ev.clientX, ev.clientY, targetId);
      const hv = hvHit?.id ?? null;
      if (!hv && targetId) {
        const node: any = store.model.nodes.find((n) => n.id === targetId);
        if (node && (node.type === "text" || node.type === "bullets")) {
          const now = performance.now();
          const prev = lastClick;
          const dt = prev ? now - prev.atMs : Infinity;
          const dpx = prev ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
          if (prev && prev.nodeId === targetId && dt < 420 && dpx < 6) {
            setSingleSelection(targetId);
            owner = null;
            // open editor
            // (defined below in this scope)
            openTextEditorForNode(targetId);
            lastClick = null;
            ev.preventDefault();
            return;
          }
          lastClick = { atMs: now, nodeId: targetId, x: ev.clientX, y: ev.clientY };
        } else {
          lastClick = null;
        }
      }
    }

    // Handle clicks (anchor dots etc) take priority.
    const h = hitHandle(ev);
    if (h && h.startsWith("anchor:")) {
      const a = h.slice("anchor:".length) as Anchor;
      const id = store.selectedId ?? hitNodeId(ev);
      if (id) {
        pushUndo(snapshotNow());
        setSingleSelection(id);
        applyAnchorChange(id, a);
        ev.preventDefault();
        return;
      }
    }

    // Ctrl+drag on empty space creates a new arrow (edit modes only).
    if (store.mode !== "live" && ev.button === 0 && ev.ctrlKey) {
      const hitId = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      if (!hitId) {
        const snap = snapshotNow();
        const isScreen = store.mode === "screen-edit";
        const id = newId("arrow");
        const n: any = {
          id,
          type: "arrow",
          space: isScreen ? "screen" : "world",
          zIndex: 0,
          visible: true,
          opacity: 1,
          transform: { x: 0, y: 0, w: 0, h: 0, rotationDeg: 0, anchor: "topLeft" },
          start: { x: 0, y: 0.5 },
          end: { x: 1, y: 0.5 },
          color: "white",
          strokePx: 4,
        };
        if (isScreen) n.screenId = "screen_main";
        else n.viewId = store.activeViewId;
        store.model.nodes.push(n);
        setSingleSelection(id);
        updateArrowFromClientDrag(n, ev.clientX, ev.clientY, ev.clientX, ev.clientY);
        owner = {
          kind: "arrow-create",
          pointerId: ev.pointerId,
          nodeId: id,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          dirty: true,
          startSnapshot: snap,
        };
        try {
          overlay.setPointerCapture(ev.pointerId);
        } catch (e) {
          console.error("[next][state] setPointerCapture failed", e);
        }
        ev.preventDefault();
        return;
      }
    }

    // Arrow endpoint / center dragging.
    {
      const targetId = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY) ?? store.selectedId;
      if (targetId) {
        const node: any = store.model.nodes.find((n) => n.id === targetId);
        if (node?.type === "arrow") {
          setSingleSelection(targetId);
          const ends = arrowEndpointsScreen(node);
          const endRadius = 20;
          const dStart = Math.hypot(ev.clientX - ends.start.x, ev.clientY - ends.start.y);
          const dEnd = Math.hypot(ev.clientX - ends.end.x, ev.clientY - ends.end.y);
          if (dStart <= endRadius || dEnd <= endRadius) {
            const endId = dStart <= dEnd ? "start" : "end";
            owner = {
              kind: "arrow-end",
              pointerId: ev.pointerId,
              nodeId: targetId,
              endId,
              dirty: false,
              startSnapshot: snapshotNow(),
            };
            try {
              overlay.setPointerCapture(ev.pointerId);
            } catch (e) {
              console.error("[next][state] setPointerCapture failed", e);
            }
            ev.preventDefault();
            return;
          }
          const lineHit = distPointToSegment(ev.clientX, ev.clientY, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
          if (lineHit <= arrowLineHitPx(node)) {
            owner = {
              kind: "arrow-move",
              pointerId: ev.pointerId,
              nodeId: targetId,
              startClientX: ev.clientX,
              startClientY: ev.clientY,
              startStart: { x: node.start?.x ?? 0, y: node.start?.y ?? 0.5 },
              startEnd: { x: node.end?.x ?? 1, y: node.end?.y ?? 0.5 },
              dirty: false,
              startSnapshot: snapshotNow(),
            };
            try {
              overlay.setPointerCapture(ev.pointerId);
            } catch (e) {
              console.error("[next][state] setPointerCapture failed", e);
            }
            overlay.style.cursor = "grabbing";
            ev.preventDefault();
            return;
          }
        }
      }
    }

    // Resize/rotate handles are only active for the currently selected node.
    const targetId = store.selectedId ?? hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
    const hvHit = h && !h.startsWith("anchor:") ? ({ id: h, d2: 0 } as any) : hitVirtualHandleAtClientPoint(ev.clientX, ev.clientY, targetId);
    const hv = hvHit?.id ?? null;
    if (hv) {
      const id = targetId;
      if (!id) return;
      // If interacting with an already-selected node, keep the multi-selection but make it primary.
      if ((store.selectedIds ?? []).includes(id)) {
        store.selectedId = id;
        updateHandles();
      } else {
        setSingleSelection(id);
      }
      const node = store.model.nodes.find((n) => n.id === id);
      if (!node) return;
      // handles already updated via setSingleSelection

      const cam = cameraForScreen();
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const wp = node.space === "world" ? screenToWorld({ x: sx, y: sy }, cam, screen) : null;

      // Rotation: use upper corners (nw/ne). No separate rotation handle.
      const isRotateCorner = hv === "nw" || hv === "ne";
      if (isRotateCorner) {
        const ang0 =
          node.space === "screen"
            ? Math.atan2(sy - (1 - node.transform.y) * screen.h, sx - node.transform.x * screen.w)
            : Math.atan2(wp!.y - node.transform.y, wp!.x - node.transform.x);
        const targetIds = (store.selectedIds?.length ? store.selectedIds : [id]).includes(id)
          ? (store.selectedIds?.length ? store.selectedIds : [id])
          : [id];
        const starts = targetIds
          .map((tid) => store.model.nodes.find((n) => n.id === tid))
          .filter((n): n is any => !!n)
          .map((n) => ({ id: String(n.id), rotationDeg: n.transform.rotationDeg }));
        owner = {
          kind: "rotate",
          pointerId: ev.pointerId,
          nodeId: id,
          targetIds,
          starts,
          corner: hv as any,
          startAngleRad: ang0,
          startRotationDeg: node.transform.rotationDeg,
          dirty: false,
          startSnapshot: snapshotNow(),
        };
      } else {
        const targetIds = (store.selectedIds?.length ? store.selectedIds : [id]).includes(id)
          ? (store.selectedIds?.length ? store.selectedIds : [id])
          : [id];
        const starts = targetIds
          .map((tid) => store.model.nodes.find((n) => n.id === tid))
          .filter((n): n is any => !!n)
          .map((n) => ({
            id: String(n.id),
            w: n.transform.w,
            h: n.transform.h,
            fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : 0,
          }));
        owner = {
          kind: "resize",
          pointerId: ev.pointerId,
          nodeId: id,
          targetIds,
          starts,
          handle: hv as any,
          startW: node.transform.w,
          startH: node.transform.h,
          startFontPx: node.type === "text" || node.type === "bullets" ? node.fontPx : 0,
          dirty: false,
          startSnapshot: snapshotNow(),
        };
      }

      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      ev.preventDefault();
      return;
    }

    const id = hitNodeId(ev);
    if (!id) {
      if (ev.ctrlKey && store.mode !== "live") {
        // Ctrl-drag is reserved for arrow creation; avoid panning.
        ev.preventDefault();
        return;
      }
      // IMPORTANT: left click does NOT cancel selection.
      // Only right click clears selection (see rselect pointerup).
      // Left drag on empty canvas pans.
      const cam = cameraForEdit();
      if (!store.cameraOverride) store.cameraOverride = { ...cam };
      owner = { kind: "pan", pointerId: ev.pointerId, startClientX: ev.clientX, startClientY: ev.clientY, startCx: cam.cx, startCy: cam.cy };
      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      overlay.style.cursor = "grabbing";
      ev.preventDefault();
      return;
    }
    // Selection logic:
    // - Shift-click: union (add)
    // - Ctrl-click: toggle
    // - Plain click:
    //   - if clicking an already-selected node: keep selection, just make it primary
    //   - otherwise: single selection
    {
      const base = new Set(store.selectedIds ?? []);
      let next = base;
      if (ev.ctrlKey) {
        next = new Set(base);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else if (ev.shiftKey) {
        next = new Set(base);
        next.add(id);
      } else {
        next = base.has(id) ? new Set(base) : new Set([id]);
      }

      const nextArr = Array.from(next);
      // Make the clicked element the primary selection if it remains selected,
      // so dragging after a shift/ctrl click feels intuitive.
      const preferredPrimary = next.has(id) ? id : store.selectedId;
      if (nextArr.length === 0) clearSelection();
      else setMultiSelection(nextArr, preferredPrimary ?? null);
    }

    const nodeIdForMove = store.selectedId;
    if (!nodeIdForMove) return;
    const node = store.model.nodes.find((n) => n.id === nodeIdForMove);
    if (!node) return;

    owner = {
      kind: "move",
      pointerId: ev.pointerId,
      nodeId: nodeIdForMove,
      targetIds: (store.selectedIds?.length ? store.selectedIds : [nodeIdForMove]).includes(nodeIdForMove)
        ? (store.selectedIds?.length ? store.selectedIds : [nodeIdForMove])
        : [nodeIdForMove],
      starts: (store.selectedIds?.length ? store.selectedIds : [nodeIdForMove])
        .map((tid) => store.model.nodes.find((n) => n.id === tid))
        .filter((n): n is any => !!n)
        .map((n) => ({ id: String(n.id), x: n.transform.x, y: n.transform.y })),
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startX: node.transform.x,
      startY: node.transform.y,
      dirty: false,
      startSnapshot: snapshotNow(),
    };
    try {
      overlay.setPointerCapture(ev.pointerId);
    } catch (e) {
      console.error("[next][state] setPointerCapture failed", e);
    }
    ev.preventDefault();
  };

  const onPointerMove = (ev: PointerEvent) => {
    lastClient = { x: ev.clientX, y: ev.clientY };
    // Allow panning even while a text editor is open; do not auto-close during a pan gesture.
    if (owner?.kind === "pan") {
      const o = owner;
      if (!o || o.pointerId !== ev.pointerId) return;
      if (ev.buttons === 0) {
        owner = null;
        overlay.style.cursor = "";
        return;
      }
      const actualCam = cameraForEdit();
      const dx = ev.clientX - o.startClientX;
      const dy = ev.clientY - o.startClientY;
      const next = { cx: o.startCx - dx / actualCam.zoom, cy: o.startCy - dy / actualCam.zoom, zoom: actualCam.zoom };
      store.cameraOverride = next;
      ev.preventDefault();
      return;
    }

    if (activeTextEditor) {
      // Armed leave-to-save: only close when the pointer has actually entered the editor once.
      const inEditor = !!(ev.target as HTMLElement | null)?.closest?.(".text-editor");
      if (inEditor) activeTextEditor.everEntered = true;
      if (!inEditor) {
        const margin = 20;
        const r = activeTextEditor.el.getBoundingClientRect();
        const withinMargin =
          ev.clientX >= r.left - margin &&
          ev.clientX <= r.right + margin &&
          ev.clientY >= r.top - margin &&
          ev.clientY <= r.bottom + margin;
        if (withinMargin) return;
        // IMPORTANT: if the user is dragging (selecting text) and leaves the editor,
        // do NOT close. Also "disarm" so they must re-enter before a later leave will close.
        if ((ev.buttons & 1) !== 0) {
          if (activeTextEditor.everEntered) activeTextEditor.everEntered = false;
          return;
        }
        if (activeTextEditor.everEntered) closeTextEditor({ commit: true });
      }
      return;
    }
    // Hover / cursors (only when not dragging)
    if (!owner) {
      updateHoverCursorAtClientPoint(ev.clientX, ev.clientY, ev);
    }

    const o = owner;
    if (!o) return;
    if (o.pointerId !== ev.pointerId) return;
    if (o.kind === "rselect") {
      const dx = ev.clientX - o.startClientX;
      const dy = ev.clientY - o.startClientY;
      if (!o.dirty) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        o.dirty = true;
      }
      const or = overlay.getBoundingClientRect();
      const x0 = o.startClientX - or.left;
      const y0 = o.startClientY - or.top;
      const x1 = ev.clientX - or.left;
      const y1 = ev.clientY - or.top;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      marquee.style.display = "block";
      marquee.style.left = `${left}px`;
      marquee.style.top = `${top}px`;
      marquee.style.width = `${w}px`;
      marquee.style.height = `${h}px`;
      ev.preventDefault();
      return;
    }
    if ((ev.buttons & 1) === 0) {
      owner = null;
      return;
    }
    if (o.kind === "arrow-move") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId) as any;
      if (!node) return;
      const cam = cameraForScreen();
      const dx = ev.clientX - o.startClientX;
      const dy = ev.clientY - o.startClientY;
      const sr = stage.getBoundingClientRect();
      const screen = { w: sr.width, h: sr.height };
      if (node.space === "screen") {
        const dX = dx / Math.max(1e-9, screen.w);
        const dY = -dy / Math.max(1e-9, screen.h);
        node.start = { x: o.startStart.x + dX, y: o.startStart.y + dY };
        node.end = { x: o.startEnd.x + dX, y: o.startEnd.y + dY };
      } else {
        const dX = dx / cam.zoom;
        const dY = dy / cam.zoom;
        node.start = { x: o.startStart.x + dX, y: o.startStart.y + dY };
        node.end = { x: o.startEnd.x + dX, y: o.startEnd.y + dY };
      }
      syncArrowTransform(node);
      o.dirty = true;
      ev.preventDefault();
      updateHandles();
      return;
    }
    if (o.kind === "arrow-end") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId) as any;
      if (!node) return;
      const next = arrowPointFromClient(node, ev.clientX, ev.clientY);
      if (o.endId === "start") node.start = next;
      else node.end = next;
      syncArrowTransform(node);
      o.dirty = true;
      ev.preventDefault();
      updateHandles();
      return;
    }
    if (o.kind === "arrow-create") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId) as any;
      if (!node) return;
      updateArrowFromClientDrag(node, o.startClientX, o.startClientY, ev.clientX, ev.clientY);
      o.dirty = true;
      ev.preventDefault();
      updateHandles();
      return;
    }
    if (o.kind === "move") {
      const cam = cameraForScreen();
      const dx = ev.clientX - o.startClientX;
      const dy = ev.clientY - o.startClientY;
      if (!o.dirty) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        o.dirty = true;
      }
      // Move all selected nodes by the same delta (world or screen).
      const sr = stage.getBoundingClientRect();
      const screen = { w: sr.width, h: sr.height };
      const primary = store.model.nodes.find((n) => n.id === o.nodeId) as any;
      const isScreen = primary?.space === "screen";
      let dX = isScreen ? dx / Math.max(1e-9, screen.w) : dx / cam.zoom;
      // Screen-space uses bottom-left coords, so dragging down decreases y.
      let dY = isScreen ? -dy / Math.max(1e-9, screen.h) : dy / cam.zoom;
      if (ev.shiftKey) {
        if (isScreen) {
          const snapPx = 10;
          const nxRel = snapTo((o.startX + dX) * screen.w, snapPx) / Math.max(1e-9, screen.w);
          const nyRel = snapTo((o.startY + dY) * screen.h, snapPx) / Math.max(1e-9, screen.h);
          dX = nxRel - o.startX;
          dY = nyRel - o.startY;
        } else {
          const step = gridMajorStepWorld(cameraForEdit().zoom);
          const nx = snapTo(o.startX + dX, step);
          const ny = snapTo(o.startY + dY, step);
          dX = nx - o.startX;
          dY = ny - o.startY;
        }
      }
      for (const s of o.starts) {
        const node = store.model.nodes.find((n) => n.id === s.id) as any;
        if (!node) continue;
        node.transform.x = s.x + dX;
        node.transform.y = s.y + dY;
      }
      ev.preventDefault();
      updateHandles();
      return;
    }

    // Rotate about anchor point
    if (o.kind === "rotate") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId);
      if (!node) return;
      const cam = cameraForScreen();
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const ang1 =
        (node as any).space === "screen"
          ? Math.atan2(sy - (1 - node.transform.y) * screen.h, sx - node.transform.x * screen.w)
          : (() => {
              const wp = screenToWorld({ x: sx, y: sy }, cam, screen);
              return Math.atan2(wp.y - node.transform.y, wp.x - node.transform.x);
            })();
      const d = ((ang1 - o.startAngleRad) * 180) / Math.PI;
      let nextDeg = o.startRotationDeg + d;
      if (ev.shiftKey) nextDeg = snapTo(nextDeg, ROT_SNAP_DEG);
      const deltaDeg = nextDeg - o.startRotationDeg;
      for (const s of o.starts) {
        const n = store.model.nodes.find((x) => x.id === s.id);
        if (!n) continue;
        n.transform.rotationDeg = s.rotationDeg + deltaDeg;
      }
      o.dirty = true;
      // Update cursor continuously during drag (otherwise it appears "stuck").
      {
        const rotYour = -(o.startRotationDeg + deltaDeg);
        const handle = o.corner;
        const yourAngle = cursorAngleYourForHandle(rotYour, handle);
        overlay.style.cursor = cursorForRotate(toSvgAngle(yourAngle));
      }
      ev.preventDefault();
      updateHandles();
      return;
    }

    // Resize in the element's local axis (anchor is fixed, rotation preserved)
    if (o.kind === "resize") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId);
      if (!node) return;
      const t = node.transform;
      const cam = cameraForScreen();
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const clientPxX = ev.clientX - r.left;
      const clientPxY = ev.clientY - r.top;

      const rot = (t.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const isScreen = (node as any).space === "screen";
      const scaleW = Math.max(1e-9, screen.w);
      const scaleH = Math.max(1e-9, screen.h);
      const startWpx = isScreen ? o.startW * scaleW : o.startW;
      const startHpx = isScreen ? o.startH * scaleH : o.startH;
      const wp = !isScreen ? screenToWorld({ x: clientPxX, y: clientPxY }, cam, screen) : null;
      const dxw = isScreen ? clientPxX - t.x * screen.w : wp!.x - t.x;
      const dyw = isScreen ? clientPxY - (1 - t.y) * screen.h : wp!.y - t.y;
      // rotate by -rot
      const lx = dxw * cos + dyw * sin;
      const ly = -dxw * sin + dyw * cos;

      const { ax, ay } = anchorFrac(t.anchor);
      const hnd = o.handle;

      // Corner scaling must ALWAYS preserve aspect ratio.
      // Do uniform scale about the anchor (anchor point stays fixed).
      const isCorner = hnd === "nw" || hnd === "ne" || hnd === "sw" || hnd === "se";
      if (isCorner) {
        const xMin0 = -ax * startWpx;
        const xMax0 = (1 - ax) * startWpx;
        const yMin0 = -ay * startHpx;
        const yMax0 = (1 - ay) * startHpx;

        // Pick the corner direction vector for computing scale.
        const cornerVec = (() => {
          if (hnd === "nw") return { x: xMin0, y: yMin0 };
          if (hnd === "ne") return { x: xMax0, y: yMin0 };
          if (hnd === "sw") return { x: xMin0, y: yMax0 };
          return { x: xMax0, y: yMax0 }; // "se"
        })();

        const denom = cornerVec.x * cornerVec.x + cornerVec.y * cornerVec.y;
        if (denom > 1e-9) {
          let s = (lx * cornerVec.x + ly * cornerVec.y) / denom;
          // Minimum size constraint (uniform).
          const minWpx = 10;
          const minHpx = 10;
          const minW = isScreen ? minWpx / scaleW : minWpx;
          const minH = isScreen ? minHpx / scaleH : minHpx;
          const sMin = Math.max(minW / Math.max(1e-9, o.startW), minH / Math.max(1e-9, o.startH));
          if (!Number.isFinite(s)) s = 1;
          s = Math.max(sMin, s);

          // Shift snapping: quantize size without breaking aspect ratio.
          if (ev.shiftKey) {
            const wSnapPx = snapTo(startWpx * s, isScreen ? 10 : gridMajorStepWorld(cameraForEdit().zoom));
            s = Math.max(sMin, wSnapPx / Math.max(1e-9, startWpx));
          }

          const nextW = Math.max(minW, o.startW * s);
          const nextH = Math.max(minH, o.startH * s);
          t.w = nextW;
          t.h = nextH;
          if (node.type === "text" || node.type === "bullets") node.fontPx = Math.max(1, o.startFontPx * s);
          // Apply same uniform scale to all selected nodes around their own anchors.
          for (const st of o.starts) {
            if (st.id === o.nodeId) continue;
            const n = store.model.nodes.find((x) => x.id === st.id);
            if (!n) continue;
            n.transform.w = Math.max(minW, st.w * s);
            n.transform.h = Math.max(minH, st.h * s);
            if (n.type === "text" || n.type === "bullets") n.fontPx = Math.max(1, st.fontPx * s);
          }
          o.dirty = true;
          ev.preventDefault();
          updateHandles();
          return;
        }
      }

      const minWpx = 10;
      const minHpx = 10;
      const minW = isScreen ? minWpx / scaleW : minWpx;
      const minH = isScreen ? minHpx / scaleH : minHpx;

      // IMPORTANT (anchor compensation):
      // `t.x,t.y` is the anchor point, so dragging an edge must solve for the new size such that
      // the dragged edge position equals the cursor in LOCAL coords.
      //
      // Example: anchor=center => right edge = +0.5*w. To make the edge follow the cursor (lx),
      // we must set w = lx / 0.5 = 2*lx.
      const step = isScreen ? 10 : gridMajorStepWorld(cameraForEdit().zoom);
      const lxTarget = ev.shiftKey ? snapTo(lx, step) : lx;
      const lyTarget = ev.shiftKey ? snapTo(ly, step) : ly;

      let wNew = t.w;
      let hNew = t.h;
      const eps = 1e-9;
      if (hnd === "e") wNew = lxTarget / Math.max(eps, 1 - ax);
      if (hnd === "w") wNew = -lxTarget / Math.max(eps, ax);
      if (hnd === "s") hNew = lyTarget / Math.max(eps, 1 - ay);
      if (hnd === "n") hNew = -lyTarget / Math.max(eps, ay);

      if (!Number.isFinite(wNew)) wNew = t.w;
      if (!Number.isFinite(hNew)) hNew = t.h;
      if (isScreen) {
        const wPx = Math.max(minWpx, wNew);
        const hPx = Math.max(minHpx, hNew);
        t.w = wPx / scaleW;
        t.h = hPx / scaleH;
      } else {
        t.w = Math.max(minW, wNew);
        t.h = Math.max(minH, hNew);
      }
      o.dirty = true;

      // Apply resize ratios to all selected nodes around their own anchors.
      const sx = t.w / Math.max(1e-9, o.startW);
      const sy = t.h / Math.max(1e-9, o.startH);
      for (const st of o.starts) {
        if (st.id === o.nodeId) continue;
        const n = store.model.nodes.find((x) => x.id === st.id);
        if (!n) continue;
        n.transform.w = Math.max(minW, st.w * sx);
        n.transform.h = Math.max(minH, st.h * sy);
        // Text scaling rule: corners scale font, edges keep font constant.
        if ((n.type === "text" || n.type === "bullets") && isCorner) n.fontPx = Math.max(1, st.fontPx * sx);
      }

      // Text scaling rule: corners scale font, edges keep font constant.
      if ((node.type === "text" || node.type === "bullets") && isCorner) {
        const sW = t.w / Math.max(1e-9, o.startW);
        node.fontPx = Math.max(1, o.startFontPx * sW);
      }

      ev.preventDefault();
      updateHandles();
      return;
    }
  };
  // Track mouse position even when outside the overlay, so keyboard shortcuts (copy/paste)
  // use the true mouse delta instead of a stale lastClient.
  const onWindowPointerMove = (ev: PointerEvent) => {
    lastClient = { x: ev.clientX, y: ev.clientY };
  };

  const onPointerUp = (ev: PointerEvent) => {
    if (!owner) return;
    if (owner.pointerId !== ev.pointerId) return;
    if (owner.kind === "rselect") {
      marquee.style.display = "none";
      const wasDirty = owner.dirty;
      if (!wasDirty) {
        // Right click: clear selection.
        if (store.selectedId || (store.selectedIds?.length ?? 0) > 0) pushUndo(owner.startSnapshot);
        clearSelection();
        owner = null;
        return;
      }
      const or = overlay.getBoundingClientRect();
      const endClientX = lastClient?.x ?? ev.clientX;
      const endClientY = lastClient?.y ?? ev.clientY;
      const x0 = owner.startClientX - or.left;
      const y0 = owner.startClientY - or.top;
      const x1 = endClientX - or.left;
      const y1 = endClientY - or.top;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const right = Math.max(x0, x1);
      const bottom = Math.max(y0, y1);

      const hits: string[] = [];
      for (const n of store.model.nodes as any[]) {
        if (!n || n.visible === false) continue;
        if (!isInteractive(n)) continue;
        const bb = screenAabbForNode(n);
        const overlap = bb.maxX >= left && bb.minX <= right && bb.maxY >= top && bb.minY <= bottom;
        if (overlap) hits.push(String(n.id));
      }

      const prevPrimary = store.selectedId;
      const base = new Set(store.selectedIds ?? []);
      let next: Set<string>;
      if (ev.ctrlKey) {
        next = new Set(base);
        for (const id of hits) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
      } else if (ev.shiftKey) {
        next = new Set(base);
        for (const id of hits) next.add(id);
      } else {
        next = new Set(hits);
      }

      const nextArr = Array.from(next);
      pushUndo(owner.startSnapshot);
      setMultiSelection(nextArr, prevPrimary);
      owner = null;
      return;
    }
    // Record undo snapshot once per completed gesture.
    if ((owner as any).dirty && (owner as any).startSnapshot) pushUndo((owner as any).startSnapshot);
    if ((owner as any).kind === "pan") overlay.style.cursor = "";
    // Persist geometry after committed transform gestures.
    if ((owner as any).dirty) {
      const ids: string[] = (owner as any).targetIds ?? [(owner as any).nodeId].filter(Boolean);
      for (const id of ids) {
        const n: any = store.model.nodes.find((x) => x.id === id);
        if (!n) continue;
        const viewId = n.space === "screen" ? "screen_main" : store.activeViewId;
        if (n.type !== "arrow") {
          void persistGeometry({
            id: String(n.id),
            viewId,
            transform: normalizeTransformForPersist(store, n.transform, viewId, n.space),
            fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
            doc: docForNode(n),
            space: n.space,
          });
        }
        if (n.type === "arrow") {
          const start = normalizePointForPersist(n.start ?? { x: 0, y: 0.5 }, viewId, n.space);
          const end = normalizePointForPersist(n.end ?? { x: 1, y: 0.5 }, viewId, n.space);
          const color = typeof n.color === "string" && n.color.includes(",") ? "white" : n.color;
          void persistArrow({
            id: String(n.id),
            viewId,
            start,
            end,
            color,
            strokePx: n.strokePx,
            doc: docForNode(n),
            space: n.space,
          });
        }
      }
    }
    owner = null;
    updateHandles();
    // Refresh cursor immediately; don't require a "leave and re-enter" or a tiny mouse move.
    if (overlayIsOver && lastClient) updateHoverCursorAtClientPoint(lastClient.x, lastClient.y, null);
  };

  const onDragOver = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    if (store.mode === "live") return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    if (store.mode === "live") return;
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer.files).filter((f) => (f.type || "").startsWith("image/"));
    if (!files.length) return;
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    const file = files[0]!;
    void (async () => {
      const uploaded = await uploadImageFile(file);
      const img = new Image();
      img.decoding = "async";
      img.src = uploaded.src;
      const aspect = await new Promise<number>((resolve) => {
        img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
        img.onerror = () => resolve(1);
      });
      createImageNodeAtClientPoint(clientX, clientY, { src: uploaded.src, filename: uploaded.filename, aspect });
    })();
  };

  const onWheel = (ev: WheelEvent) => {
    if (activeTextEditor) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    // Zoom with wheel (trackpad/mouse). Prevent page scroll.
    ev.preventDefault();
    const actualCam = cameraForEdit();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    // World under cursor before zoom
    const wx = (sx - screen.w / 2) / actualCam.zoom + actualCam.cx;
    const wy = (sy - screen.h / 2) / actualCam.zoom + actualCam.cy;
    const scale = Math.exp(-ev.deltaY * 0.0012);
    // No practical max-zoom; allow extreme zooming. Rendering already clamps text to >= 1px.
    const nextActualZoom = Math.max(1e-4, Math.min(1e4, actualCam.zoom * scale));
    // Adjust camera center so (wx,wy) stays under cursor
    store.cameraOverride = {
      cx: wx - (sx - screen.w / 2) / nextActualZoom,
      cy: wy - (sy - screen.h / 2) / nextActualZoom,
      zoom: nextActualZoom,
    };
  };

  function closeTextEditor(opts?: { commit?: boolean }) {
    const ed = activeTextEditor;
    if (!ed) return;
    const node: any = store.model.nodes.find((n) => n.id === ed.nodeId);
    if (node && node.type === "text") {
      node.text = opts?.commit ? ed.el.value : ed.prevText;
    }
    if (node && node.type === "bullets") {
      const rawValue = opts?.commit ? ed.el.value : ed.prevText;
      const parsed = parseBulletEditorValue(rawValue);
      const nextSpec = mergeBulletSpec(node.bullets, parsed.spec);
      if (nextSpec) node.bullets = nextSpec;
      node.rawText = parsed.rawText;
      node.items = parsed.items;
    }
    if (opts?.commit && ed.el.value !== ed.prevText) pushUndo(ed.startSnapshot);
    if (opts?.commit && node && node.type === "text") {
      const persistViewId = node.space === "screen" ? "screen_main" : store.activeViewId;
      void persistText({
        id: String(node.id),
        viewId: persistViewId,
        text: String(node.text ?? ""),
        doc: docForNode(node),
        space: node.space,
        align: normalizeAlign((node as any).align),
      });
    }
    if (opts?.commit && node && node.type === "bullets") {
      const persistViewId = node.space === "screen" ? "screen_main" : store.activeViewId;
      void persistBullets({
        id: String(node.id),
        viewId: persistViewId,
        text: String(node.rawText ?? ""),
        bullets: String(node.bullets ?? ""),
        doc: docForNode(node),
        space: node.space,
        align: normalizeAlign((node as any).align),
      });
    }
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(ed.nodeId)}"]`);
    if (nodeEl) delete (nodeEl.dataset as any).editing;
    // Make close idempotent and avoid re-entrant remove() during blur.
    activeTextEditor = null;
    const el = ed.el;
    (el.dataset as any).closing = "1";
    requestAnimationFrame(() => {
      try {
        if (el.isConnected) el.remove();
      } catch (e) {
        console.error("[next][textEdit] failed to remove textarea", e);
      }
    });
    ed.errEl.remove();
    ed.alignEl.remove();
    updateHandles();
  }

  function openTextEditorForNode(nodeId: string, opts?: { selectAll?: boolean }, attempt = 0) {
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    if (!node || (node.type !== "text" && node.type !== "bullets")) return;
    if (activeTextEditor) closeTextEditor({ commit: true });

    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!nodeEl) {
      // If we just created the node, the DOM may not exist until the next render tick.
      if (attempt < 6) {
        requestAnimationFrame(() => openTextEditorForNode(nodeId, opts, attempt + 1));
        return;
      }
      throw new Error(`[next] missing node element for text edit: ${nodeId}`);
    }
    (nodeEl.dataset as any).editing = "1";

    const nr = nodeEl.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();

    const ta = document.createElement("textarea");
    ta.className = "text-editor";
    if (node.type === "bullets") {
      const items = Array.isArray(node.items) ? node.items : parseBulletEditorValue(String(node.rawText ?? "")).items;
      const spec = String(node.bullets ?? "1.");
      ta.value = renderBulletEditorValue(items, spec);
    } else {
      ta.value = String(node.text ?? "");
    }
    ta.spellcheck = false;
    ta.wrap = "soft";
    ta.rows = 2;
    ta.style.position = "absolute";
    const left = nr.left - or.left;
    const width = nr.width;
    // Start as ~2 lines tall, then auto-grow with wrapping while typing.
    const top = Math.max(8, nr.top - or.top - 6); // we'll subtract actual height after measuring
    ta.style.left = `${left}px`;
    ta.style.top = `${top}px`;
    ta.style.width = `${width}px`;
    ta.style.zIndex = "2000";
    // Editor uses a fixed monospace size (see CSS), so don't inherit zoom-scaled node font.

    overlay.appendChild(ta);
    const err = document.createElement("div");
    err.className = "text-editor-error";
    err.style.position = "absolute";
    err.style.left = ta.style.left;
    err.style.top = ta.style.top;
    err.style.width = ta.style.width;
    err.style.zIndex = "2001";
    overlay.appendChild(err);

    const align = normalizeAlign((node as any).align);
    (node as any).align = align;
    ta.style.textAlign = align;
    const alignEl = document.createElement("div");
    alignEl.className = "text-editor-anchors";
    alignEl.style.position = "absolute";
    alignEl.style.zIndex = "2500";
    alignEl.style.pointerEvents = "none";
    const makeAlignDot = (key: TextAlign, leftPct: number) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "anchor-dot";
      btn.dataset.align = key;
      btn.style.position = "absolute";
      btn.style.left = `${leftPct}%`;
      btn.style.top = "0%";
      btn.style.transform = "translate(-50%, -50%)";
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyNodeAlign(nodeId, key);
        ta.focus();
      });
      return btn;
    };
    const alignDots: Record<TextAlign, HTMLButtonElement> = {
      left: makeAlignDot("left", 0),
      center: makeAlignDot("center", 50),
      right: makeAlignDot("right", 100),
    };
    alignEl.addEventListener("mousedown", (e) => e.preventDefault());
    alignEl.append(alignDots.left, alignDots.center, alignDots.right);
    overlay.appendChild(alignEl);

    activeTextEditor = {
      nodeId,
      el: ta,
      errEl: err,
      alignEl,
      alignDots,
      prevText: ta.value,
      everEntered: false,
      startSnapshot: snapshotNow(),
    };
    if (pendingTextEdit?.nodeId === nodeId) pendingTextEdit = null;
    updateEditorAlignUi(activeTextEditor, align);

    const updateRows = () => {
      const lines = String(ta.value ?? "").split("\n").length;
      // "one more row than there are text" => minimum 2 rows.
      ta.rows = Math.max(2, lines + 1);
    };

    const layout = () => {
      updateRows();
      const nr2 = nodeEl.getBoundingClientRect();
      const or2 = overlay.getBoundingClientRect();
      // IMPORTANT: editor width follows the node's bbox width exactly.
      const left2 = nr2.left - or2.left;
      const width2 = nr2.width;
      ta.style.left = `${left2}px`;
      ta.style.width = `${width2}px`;

      const taH = ta.getBoundingClientRect().height;
      const desiredTop = Math.max(8, nr2.top - or2.top - taH - 6);
      ta.style.top = `${desiredTop}px`;
      err.style.left = ta.style.left;
      err.style.top = `${desiredTop + taH + 4}px`;
      err.style.width = ta.style.width;
      alignEl.style.left = ta.style.left;
      alignEl.style.top = ta.style.top;
      alignEl.style.width = ta.style.width;
      alignEl.style.height = "0px";
    };

    requestAnimationFrame(() => {
      ta.focus();
      const selectAll = opts?.selectAll ?? true;
      if (selectAll) ta.setSelectionRange(0, ta.value.length);
      else ta.setSelectionRange(ta.value.length, ta.value.length);
      layout();
      err.style.display = "none";
    });

    ta.addEventListener("input", () => {
      const n: any = store.model.nodes.find((x) => x.id === nodeId);
      if (!n) return;
      if (n.type === "text") {
        n.text = ta.value; // live preview as you type
        const firstLine = String(ta.value ?? "").split("\n")[0] ?? "";
        const bulletSpec = bulletSpecForLine(firstLine);
        if (bulletSpec) {
          const parsed = parseBulletEditorValue(String(ta.value ?? ""));
          n.type = "bullets";
          n.bullets = mergeBulletSpec(undefined, parsed.spec ?? bulletSpec) || bulletSpec;
          n.rawText = parsed.rawText;
          n.items = parsed.items;
          ta.value = renderBulletEditorValue(parsed.items, n.bullets || "1.");
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      } else if (n.type === "bullets") {
        const startRaw = mapCaretToRaw(ta.value, ta.selectionStart ?? 0);
        const endRaw = mapCaretToRaw(ta.value, ta.selectionEnd ?? 0);
        const parsed = parseBulletEditorValue(ta.value);
        const nextSpec = mergeBulletSpec(n.bullets, parsed.spec);
        if (nextSpec) n.bullets = nextSpec;
        n.rawText = parsed.rawText;
        n.items = parsed.items;
        const display = renderBulletEditorValue(parsed.items, n.bullets || parsed.spec || "1.");
        if (display !== ta.value) {
          ta.value = display;
          const nextStart = mapRawToCaret(display, startRaw);
          const nextEnd = mapRawToCaret(display, endRaw);
          ta.setSelectionRange(nextStart, nextEnd);
        }
      }
      // Layout is synced from the main render frame hook (after renderScene).

      // Show KaTeX errors in the editor (output stays last-good).
      const nodeEl2 = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(nodeId)}"]`);
      const errsJson = String((nodeEl2?.dataset as any)?.katexErrors ?? "");
      if (errsJson) {
        err.textContent = errsJson;
        err.style.display = "block";
      } else {
        err.textContent = "";
        err.style.display = "none";
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTextEditor({ commit: false });
        return;
      }
      if (e.key === "Tab") {
        const n: any = store.model.nodes.find((x) => x.id === nodeId);
        if (n && n.type === "bullets") {
          e.preventDefault();
          const value = ta.value;
          const start = ta.selectionStart ?? 0;
          const end = ta.selectionEnd ?? 0;
          const lines = value.split("\n");
          const lineStartIdx = value.slice(0, start).split("\n").length - 1;
          const lineEndIdx = value.slice(0, end).split("\n").length - 1;
          let delta = 0;
          for (let i = lineStartIdx; i <= lineEndIdx; i++) {
            const line = lines[i] ?? "";
            if (e.shiftKey) {
              if (line.startsWith("\t")) {
                lines[i] = line.slice(1);
                if (i === lineStartIdx) delta -= 1;
              } else if (line.startsWith("  ")) {
                lines[i] = line.slice(2);
                if (i === lineStartIdx) delta -= 2;
              }
            } else {
              lines[i] = `\t${line}`;
              if (i === lineStartIdx) delta += 1;
            }
          }
          ta.value = lines.join("\n");
          ta.selectionStart = Math.max(0, start + delta);
          ta.selectionEnd = Math.max(0, end + delta);
          ta.dispatchEvent(new Event("input"));
          return;
        }
      }
      if (e.key === "Enter") {
        const n: any = store.model.nodes.find((x) => x.id === nodeId);
        if (n && n.type === "bullets") {
          e.preventDefault();
          const value = ta.value;
          const start = ta.selectionStart ?? 0;
          const lines = value.split("\n");
          const lineIdx = value.slice(0, start).split("\n").length - 1;
          const current = lines[lineIdx] ?? "";
          const { indent } = parseBulletIndent(current);
          const parsed = parseBulletEditorValue(value);
          const spec = parsed.spec || n.bullets || "1.";
          const counters: number[] = [];
          for (let i = 0; i <= lineIdx; i++) {
            const item = parsed.items[i] ?? { text: "", indent: 0 };
            while (counters.length <= item.indent) counters.push(0);
            counters[item.indent] += 1;
            for (let j = item.indent + 1; j < counters.length; j++) counters[j] = 0;
          }
          while (counters.length <= indent) counters.push(0);
          counters[indent] += 1;
          for (let j = indent + 1; j < counters.length; j++) counters[j] = 0;
          const marker = buildBulletMarker(spec, counters, indent);
          const prefix = `${"\t".repeat(indent)}${marker ? `${marker} ` : ""}`;
          const insert = `\n${prefix}`;
          const before = value.slice(0, start);
          const after = value.slice(ta.selectionEnd ?? start);
          ta.value = before + insert + after;
          const nextPos = before.length + insert.length;
          ta.setSelectionRange(nextPos, nextPos);
          ta.dispatchEvent(new Event("input"));
          return;
        }
      }
      // Enter commits (Shift+Enter inserts newline).
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        closeTextEditor({ commit: true });
        return;
      }
    };
    const onBlur = () => {
      // If close already started (e.g. via Enter), do nothing.
      if ((ta.dataset as any).closing === "1") return;
      closeTextEditor({ commit: true });
    };
    ta.addEventListener("keydown", onKeyDown);
    ta.addEventListener("blur", onBlur, { once: true });

    // Note: leave-to-save is handled centrally in onPointerMove so it's reliably "armed"
    // even if the textarea appears under the cursor without firing pointerenter.

    // No manual resize handle: width follows the node bbox while typing.
  }

  // Stage sizing relies on the stage element; overlay handles interaction.
  overlay.addEventListener("pointerenter", onOverlayPointerEnter);
  overlay.addEventListener("pointerleave", onOverlayPointerLeave);
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("contextmenu", (e) => e.preventDefault());
  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("dragover", onDragOver);
  overlay.addEventListener("drop", onDrop);
  const onKeyDown = (ev: KeyboardEvent) => {
    // If focus is inside the textarea editor, NEVER treat Space as pan etc.
    const target = ev.target as HTMLElement | null;
    if (activeTextEditor || target?.closest?.(".text-editor")) return;

    // If we're in the short window after type-to-create but before the textarea is mounted,
    // keep routing keys into that new text node (including Space/Backspace).
    if (pendingTextEdit && !activeTextEditor) {
      const pend = pendingTextEdit;
      const node: any = store.model.nodes.find((n) => n.id === pend.nodeId);
      if (!node || node.type !== "text") {
        pendingTextEdit = null;
      } else {
        if (ev.key === "Backspace") {
          ev.preventDefault();
          node.text = String(node.text ?? "").slice(0, -1);
          return;
        }
        if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
          ev.preventDefault();
          node.text = String(node.text ?? "") + ev.key;
          return;
        }
      }
    }

    if (store.mode === "live") {
      const v = activeView(store);
      const now = performance.now();
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const views = store.model.views;
        if (!views.length) return;
        const idx = Math.max(0, views.findIndex((x) => x.id === v.id));
        const nextIdx = ev.key === "ArrowDown" ? Math.min(views.length - 1, idx + 1) : Math.max(0, idx - 1);
        const next = views[nextIdx] ?? views[0]!;
        initLiveView(next.id, true, false);
        return;
      }
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        pendingAuto = null;
        const cues = viewCues(v.id);
        if (!cues.length) return;
        const idx = liveCueIndexByView.get(v.id) ?? 0;
        if (ev.key === "ArrowRight") {
          if (idx >= cues.length) return;
          const batch = runCueBatch(cues, idx, now);
          liveCueIndexByView.set(v.id, batch.nextIdx);
          if (batch.nextIdx < cues.length && cues[batch.nextIdx]!.when === "after") {
            pendingAuto = { viewId: v.id, index: batch.nextIdx, runAtMs: now + batch.batchDuration };
          }
        } else {
          if (idx <= 0) return;
          let start = idx - 1;
          while (start > 0 && cues[start]!.when === "same") start -= 1;
          let end = start;
          while (end + 1 < cues.length && cues[end + 1]!.when === "same") end += 1;
          resetViewToCueIndex(cues, start);
          liveCueIndexByView.set(v.id, start);
        }
        return;
      }
      return;
    }

    // Type-to-create: typing starts a new text field at the cursor.
    // (Uses the same editing flow as double-click editing.)
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) {
      const ch = ev.key;
      // Printable single-character keys only (avoid Enter/Tab/Escape etc.)
      if (ch.length === 1 && ch !== " " && ch !== "\t") {
        const pt = lastClient;
        const r = stage.getBoundingClientRect();
        const cx = pt?.x ?? r.left + r.width / 2;
        const cy = pt?.y ?? r.top + r.height / 2;
        pushUndo(snapshotNow());
        const id = createTextNodeAtClientPoint(cx, cy, ch);
        pendingTextEdit = { nodeId: id };
        openTextEditorForNode(id, { selectAll: false });
        ev.preventDefault();
        return;
      }
    }

    const mod = ev.ctrlKey || ev.metaKey;
    // Delete selected nodes (when not editing text).
    if (!mod && (ev.key === "Delete" || ev.key === "Backspace")) {
      if ((store.selectedIds?.length ?? 0) > 0) {
        ev.preventDefault();
        pushUndo(snapshotNow());
        const sel = Array.from(new Set(store.selectedIds.map(String)));
        const by = groupIdsByDoc(sel);
        if (by.presentation.length) void persistDelete({ ids: by.presentation, doc: "presentation" });
        if (by.notes.length) void persistDelete({ ids: by.notes, doc: "notes" });
        const selSet = new Set(sel);
        store.model.nodes = store.model.nodes.filter((n: any) => !selSet.has(String(n.id)));
        clearSelection();
      }
      return;
    }
    if (!mod) return;

    const k = ev.key.toLowerCase();
    const code = String(ev.code ?? "");
    const isUndoKey = k === "z" || code === "KeyZ";
    const isRedoKey = k === "y" || code === "KeyY";

    // Undo / redo
    if (isUndoKey && !ev.shiftKey) {
      ev.preventDefault();
      const snap = undoStack.pop();
      if (!snap) return;
      const prevIds = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
      redoStack.push(snapshotNow());
      restoreSnapshot(snap);
      persistModelToFiles(prevIds);
      return;
    }
    if (isRedoKey || (isUndoKey && ev.shiftKey)) {
      ev.preventDefault();
      const snap = redoStack.pop();
      if (!snap) return;
      const prevIds = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
      undoStack.push(snapshotNow());
      restoreSnapshot(snap);
      persistModelToFiles(prevIds);
      return;
    }

    const selectedId = store.selectedId;

    // Copy / cut
    if (k === "c" || k === "x") {
      const ids = (store.selectedIds?.length ? store.selectedIds : selectedId ? [selectedId] : []).filter(Boolean);
      if (!ids.length) return;
      ev.preventDefault();
      const primaryId = selectedId && ids.includes(selectedId) ? selectedId : ids[0]!;
      const primary = store.model.nodes.find((n) => n.id === primaryId) as any;
      if (!primary) return;
      const px = Number(primary.transform?.x) || 0;
      const py = Number(primary.transform?.y) || 0;

      const nodes: ClipboardNode[] = ids
        .map((id) => store.model.nodes.find((n) => n.id === id) as any)
        .filter((n) => !!n)
        .map((n) => {
          const cx = Number(n.transform?.x) || 0;
          const cy = Number(n.transform?.y) || 0;
          return { node: cloneModel(n), relAnchor: { dx: cx - px, dy: cy - py } };
        });
      internalClipboard = { nodes, primaryType: String(primary.type ?? "n") };
      // Reset paste nudge tracking when making a new copy.
      lastPasteClient = null;
      pasteNudgeSteps = 0;
      if (k === "x") {
        pushUndo(snapshotNow());
        const by = groupIdsByDoc(ids.map(String));
        if (by.presentation.length) void persistDelete({ ids: by.presentation, doc: "presentation" });
        if (by.notes.length) void persistDelete({ ids: by.notes, doc: "notes" });
        store.model.nodes = store.model.nodes.filter((n) => !ids.includes(String((n as any).id)));
        clearSelection();
      }
      return;
    }

    // Paste
    if (k === "v") {
      if (!internalClipboard) return;
      ev.preventDefault();
      pushUndo(snapshotNow());
      const cam = cameraForScreen();
      const r = stage.getBoundingClientRect();
      const cx = lastClient?.x ?? r.left + r.width / 2;
      const cy = lastClient?.y ?? r.top + r.height / 2;

      // If you keep pasting without moving the mouse, nudge by +50px,+50px each time to separate.
      if (lastPasteClient && Math.abs(cx - lastPasteClient.x) < 0.5 && Math.abs(cy - lastPasteClient.y) < 0.5) {
        pasteNudgeSteps += 1;
      } else {
        pasteNudgeSteps = 0;
      }
      lastPasteClient = { x: cx, y: cy };
      const nudgePx = 50 * pasteNudgeSteps;
      const nudgeWorldX = nudgePx / cam.zoom;
      const nudgeWorldY = nudgePx / cam.zoom;

      // Place primary anchor exactly at mouse cursor (plus optional repeated-paste nudge).
      const screen = { w: r.width, h: r.height };
      const cursorRel = {
        x: (cx - r.left) / Math.max(1e-9, screen.w),
        y: 1 - (cy - r.top) / Math.max(1e-9, screen.h),
      };
      const cursorWorld = screenToWorld({ x: cx - r.left, y: cy - r.top }, cam, screen);

      const newIds: string[] = [];
      for (const item of internalClipboard.nodes) {
        const n: any = cloneModel(item.node);
        n.id = newId(String(n.type ?? internalClipboard.primaryType ?? "n"));
        if (n.transform) {
          if (n.space === "screen") {
            n.transform.x = cursorRel.x + nudgePx / Math.max(1e-9, screen.w) + item.relAnchor.dx;
            // downwards nudge should reduce y in bottom-left coords
            n.transform.y = cursorRel.y - nudgePx / Math.max(1e-9, screen.h) + item.relAnchor.dy;
          } else {
            n.transform.x = cursorWorld.x + nudgeWorldX + item.relAnchor.dx;
            n.transform.y = cursorWorld.y + nudgeWorldY + item.relAnchor.dy;
          }
        }
        store.model.nodes.push(n);
        newIds.push(n.id);
        // Persist paste as creation (text + geometry)
        const doc = docForNode(n);
        const persistViewId = n.space === "screen" ? "screen_main" : store.activeViewId;
        if (n.type === "text") {
          void persistText({
            id: String(n.id),
            viewId: persistViewId,
            text: String(n.text ?? ""),
            doc,
            space: n.space,
            align: normalizeAlign((n as any).align),
          });
        }
        if (n.type === "bullets") {
          void persistBullets({
            id: String(n.id),
            viewId: persistViewId,
            text: String(n.rawText ?? ""),
            bullets: String(n.bullets ?? ""),
            doc,
            space: n.space,
            align: normalizeAlign((n as any).align),
          });
        }
        void persistGeometry({
          id: String(n.id),
          viewId: persistViewId,
          transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space),
          fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
          doc,
          space: n.space,
        });
      }
      setMultiSelection(newIds, newIds[0] ?? null);
      return;
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    void ev;
  };
  window.addEventListener("pointerup", onPointerUp, { capture: true });
  window.addEventListener("pointermove", onWindowPointerMove, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  // Frame hook: call this once per render frame (after renderScene) so any DOM size
  // changes are already applied, avoiding "floating" editor/handles.
  const frame = () => {
    if (store.mode !== lastMode) {
      if (store.mode === "live") {
        const currentCam = store.cameraOverride ?? activeViewRef().camera;
        let best = store.model.views[0];
        let bestD2 = Number.POSITIVE_INFINITY;
        for (const v of store.model.views) {
          const cam = resolveViewCamera(store, v.id);
          const dx = Number(currentCam.cx ?? 0) - Number(cam.cx ?? 0);
          const dy = Number(currentCam.cy ?? 0) - Number(cam.cy ?? 0);
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = v;
          }
        }
        initLiveView(best?.id ?? store.activeViewId, false, true);
      } else if (lastMode === "live") {
        for (const n of store.model.nodes as any[]) {
          n.visible = true;
          (n as any).__exitStartMs = null;
        }
      }
      lastMode = store.mode;
    }
    if (store.mode !== "live") {
      for (const n of store.model.nodes as any[]) {
        n.visible = true;
        (n as any).__exitStartMs = null;
      }
    }
    if (store.mode === "live" && pendingAuto) {
      const now = performance.now();
      if (now >= pendingAuto.runAtMs && store.activeViewId === pendingAuto.viewId) {
        const v = activeView(store);
        const cues = viewCues(v.id);
        const batch = runCueBatch(cues, pendingAuto.index, now);
        liveCueIndexByView.set(v.id, batch.nextIdx);
        if (batch.nextIdx < cues.length && cues[batch.nextIdx]!.when === "after") {
          pendingAuto = { viewId: v.id, index: batch.nextIdx, runAtMs: now + batch.batchDuration };
        } else {
          pendingAuto = null;
        }
      }
    }
    updateHandles();
    relayoutActiveTextEditor();
  };

  const detach = () => {
    overlay.removeEventListener("pointerenter", onOverlayPointerEnter);
    overlay.removeEventListener("pointerleave", onOverlayPointerLeave);
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("wheel", onWheel as any);
    overlay.removeEventListener("dragover", onDragOver as any);
    overlay.removeEventListener("drop", onDrop as any);
    window.removeEventListener("pointerup", onPointerUp as any, { capture: true } as any);
    window.removeEventListener("pointermove", onWindowPointerMove as any, { capture: true } as any);
    window.removeEventListener("keydown", onKeyDown as any, { capture: true } as any);
    window.removeEventListener("keyup", onKeyUp as any, { capture: true } as any);
    void stage;
  };
  return { frame, detach };
}

