import type { Store } from "./store";
import { activeView, fitCameraToScreen, persistActiveViewId, resolveViewCamera } from "./store";
import { applyNodeAlign, editorStartAlignForNode, normalizeAlign, updateEditorAlignUi } from "../editor/textEditRuntime";
import type { ActiveTextEditor, TextAlign } from "../editor/textEditRuntime";
import { createGroupEditRuntime } from "../editor/groupEditRuntime";
import { createTransformRuntime } from "../editor/transformRuntime";
import { createSelectionRuntime } from "../editor/selectionRuntime";
import { createEditorSessionRuntime } from "../editor/editorSessionRuntime";
import type { Snapshot } from "../editor/editorSessionRuntime";
import {
  cameraForScreenPan,
  screenToWorld,
  worldRectToViewRect,
  worldToScreen,
  worldToScreenScale,
  worldToView,
} from "./geom";
import type { Anchor, Transform } from "./model";
import type { Model } from "./model";
import {
  persistArrow,
  persistButtons,
  persistBullets,
  persistDelete,
  persistGeometry,
  persistElement,
  persistGroup,
  persistImage,
  persistJoin,
  persistTable,
  persistText,
  publishTableUpdate,
  uploadImageFile,
  uploadMediaFile,
} from "./transport";
import { isNodeInteractiveInMode } from "./mode";
import { createHandlesView, anchorFrac, type HandleId } from "../editor/handles";
import { cursorForRotate } from "../editor/cursors";

type PointerOwner =
  | null
  | {
      kind: "move";
      pointerId: number;
      nodeId: string;
      targetIds: string[];
      starts: Array<{
        id: string;
        x: number;
        y: number;
        start?: { x: number; y: number };
        end?: { x: number; y: number };
      }>;
      groupChildStarts?: Array<{ id: string; x: number; y: number; w: number; h: number; rotationDeg: number; fontPx: number }>;
      groupStart?: { x: number; y: number; w: number; h: number; rotationDeg: number };
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      dirty: boolean;
      zBumped?: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startCx: number;
      startCy: number;
      startWorldX: number;
      startWorldY: number;
      startZoom: number;
    }
  | {
      kind: "rselect";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      dirty: boolean;
      startSnapshot: Snapshot;
      action?: "group" | "ungroup";
    }
  | {
      kind: "rotate";
      pointerId: number;
      nodeId: string;
      targetIds: string[];
      starts: Array<{ id: string; rotationDeg: number; x?: number; y?: number }>;
      groupChildStarts?: Array<{ id: string; x: number; y: number; w: number; h: number; rotationDeg: number; fontPx: number }>;
      groupStart?: { x: number; y: number; w: number; h: number; rotationDeg: number };
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
      groupChildStarts?: Array<{ id: string; x: number; y: number; w: number; h: number; rotationDeg: number; fontPx: number }>;
      groupStart?: { x: number; y: number; w: number; h: number; rotationDeg: number };
      groupVisualStart?: { midX: number; midY: number; width: number; height: number };
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
      zBumped?: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "arrow-end";
      pointerId: number;
      nodeId: string;
      endId: "start" | "end";
      dirty: boolean;
      zBumped?: boolean;
      startSnapshot: Snapshot | null;
    }
  | {
      kind: "arrow-create";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      dirty: boolean;
      zBumped?: boolean;
      startSnapshot: Snapshot | null;
    };

const DRAG_START_PX = 3;
const GRID_BASE_WORLD = 0.1;
const GRID_MAJOR_TARGET_PX = 225;
const ROT_SNAP_DEG = 15;

const snapTo = (v: number, step: number) => {
  if (!Number.isFinite(v) || !Number.isFinite(step) || step <= 0) return v;
  return Math.round(v / step) * step;
};

const gridMajorStepWorld = (zoom: number, screenW: number) => {
  const z = Math.max(1e-6, zoom * Math.max(1e-9, screenW));
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

const isElementLine = (line: string) => {
  const trimmed = line.trimStart();
  return /^(view|text|image|bullets|arrow|join|sound|multichoice|wheel|timer|webcam|player|video|iframe|table|experiment|group|buttons|button|slider|axis|camera)\[/.test(
    trimmed
  );
};

const bulletSpecForLine = (line: string) => {
  const trimmed = line.trimStart();
  if (!trimmed) return null;
  const unordered = trimmed.match(/^([-.>*•›–])(?:\s+|$)/);
  if (unordered) {
    const unorderedMap: Record<string, string> = {
      "-": "-",
      ".": ".",
      ">": ">",
      "*": "-",
      "•": ".",
      "›": ">",
      "–": "-",
    };
    return unorderedMap[unordered[1] ?? ""] ?? null;
  }
  const ordered = trimmed.match(/^(\d+|[Aa]|[ivxlcdm]+)([.)])?(?:\s+|$)/);
  if (!ordered) return null;
  const token = ordered[1] ?? "";
  const sep = ordered[2] ?? "";
  if (/^\d+$/.test(token)) return `1${sep}`;
  const roman = /^[ivxlcdm]+$/.test(token);
  if (roman) return `${token === token.toUpperCase() ? "I" : "i"}${sep}`;
  const isUpper = token[0] === token[0]?.toUpperCase();
  return `${isUpper ? "A" : "a"}${sep}`;
};

const bulletMarkerForLine = (line: string) => {
  const trimmed = line.trimStart();
  if (!trimmed) return null;
  const unordered = trimmed.match(/^([-.>*•›–])(?:\s+|$)/);
  if (unordered) {
    const unorderedMap: Record<string, string> = {
      "-": "-",
      ".": ".",
      ">": ">",
      "*": "-",
      "•": ".",
      "›": ">",
      "–": "-",
    };
    const spec = unorderedMap[unordered[1] ?? ""];
    return spec ? { kind: "unordered" as const, spec } : null;
  }
  const ordered = trimmed.match(/^(\d+|[Aa]|[ivxlcdm]+)([.)])?(?:\s+|$)/);
  if (!ordered) return null;
  const tokenRaw = ordered[1] ?? "";
  const sep = ordered[2] ?? "";
  if (/^\d+$/.test(tokenRaw)) return { kind: "ordered" as const, token: "1", sep };
  const roman = /^[ivxlcdm]+$/.test(tokenRaw);
  if (roman) return { kind: "ordered" as const, token: tokenRaw === tokenRaw.toUpperCase() ? "I" : "i", sep };
  return { kind: "ordered" as const, token: tokenRaw === tokenRaw.toUpperCase() ? "A" : "a", sep };
};

const stripBulletMarker = (line: string) => {
  const trimmed = line.trimStart();
  if (!trimmed) return line;
  let rest = trimmed;
  for (let i = 0; i < 4; i += 1) {
    const before = rest;
    // Unordered bullets.
    rest = rest.replace(/^(?:[-.>*•›–]\s*)+/, "");
    if (rest !== before) {
      rest = rest.replace(/^\s+/, "");
      continue;
    }
    // Ordered bullets (e.g. 1., A), i:, etc).
    const m = rest.match(/^(\d+|[Aa]|[ivxlcdm]+)([.)])(\s*|$)/);
    if (m) {
      rest = rest.slice(m[0].length).replace(/^\s+/, "");
      continue;
    }
    break;
  }
  if (rest !== trimmed) return rest;
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
  const suffix = sep === "-" ? "–" : sep === ")" ? ")" : sep === ":" ? ":" : sep === "" ? "" : ".";
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
  if (unordered) return spec;
  const sep = [".", ")", "-", ":"].includes(spec[spec.length - 1] ?? "") ? spec[spec.length - 1] : "";
  const tokenRaw = sep ? spec.slice(0, -1) : spec;
  const tokens = tokenRaw.split(".").map((t) => t.trim()).filter(Boolean);
  const rootToken = tokens[0] ?? "1";
  const defaultToken = (level: number) => {
    if (level <= 0) return rootToken;
    const isUpper = rootToken === rootToken.toUpperCase();
    const lower = rootToken.toLowerCase();
    if (lower === "1") {
      if (level === 1) return "a";
      if (level >= 2) return "i";
    }
    if (lower === "a") {
      return isUpper ? "I" : "i";
    }
    if (lower === "i") {
      return isUpper ? "I" : "i";
    }
    return rootToken;
  };
  while (tokens.length <= indent) {
    tokens.push(defaultToken(tokens.length));
  }
  const token = tokens[Math.min(indent, tokens.length - 1)] ?? "1";
  const count = counters[indent] ?? 1;
  return formatOrderedLabel(token, count, sep);
};

const parseBulletEditorValue = (value: string) => {
  const lines = value.split("\n");
  const items: Array<{ text: string; indent: number }> = [];
  let spec: string | null = null;
  for (const line of lines) {
    if (isElementLine(line)) break;
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
  const sep = [".", ")", "-", ":"].includes(parsed[parsed.length - 1] ?? "") ? parsed[parsed.length - 1] : "";
  const token = sep ? parsed.slice(0, -1) : parsed;
  if (!existing) return `${token}${sep}`;
  if (existing.length === 1 && ["-", ".", ">"].includes(existing)) return `${token}${sep}`;
  const existingSep = [".", ")", "-", ":"].includes(existing[existing.length - 1] ?? "") ? existing[existing.length - 1] : "";
  const tokenRaw = existingSep ? existing.slice(0, -1) : existing;
  const tokens = tokenRaw.split(".").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return `${token}${sep}`;
  tokens[0] = token;
  return `${tokens.join(".")}${sep}`;
};

const updateBulletSpecFromLines = (value: string, existingRaw: string | undefined) => {
  const lines = value.split("\n");
  let spec = existingRaw || "";
  for (const line of lines) {
    if (isElementLine(line)) break;
    if (!line.trim()) continue;
    const { indent } = parseBulletIndent(line);
    const content = line.replace(/^[\t ]+/, "");
    const marker = bulletMarkerForLine(content);
    if (!marker) continue;
    if (marker.kind === "unordered") return marker.spec;
    const sep = [".", ")", "-", ":"].includes(marker.sep) ? marker.sep : "";
    const existingSep =
      spec && [".", ")", "-", ":"].includes(spec[spec.length - 1] ?? "") ? spec[spec.length - 1] : "";
    const sepOut = sep || existingSep || ".";
    const tokenRaw = spec && existingSep ? spec.slice(0, -1) : spec;
    const tokens = tokenRaw ? tokenRaw.split(".").map((t) => t.trim()).filter(Boolean) : [];
    while (tokens.length <= indent) tokens.push(marker.token);
    tokens[indent] = marker.token;
    spec = `${tokens.join(".")}${sepOut}`;
  }
  return spec || null;
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

const groupAnchorLocal = (group: Transform) => {
  const { ax, ay } = anchorFrac(group.anchor);
  return { ax, ay };
};

const worldPointToGroupLocal = (group: Transform, p: { x: number; y: number }) => {
  const { ax, ay } = groupAnchorLocal(group);
  const rot = (group.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = p.x - group.x;
  const dy = p.y - group.y;
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const scaleX = Math.max(1e-9, group.w);
  const scaleY = Math.max(1e-9, group.h);
  return {
    x: ax + lx / scaleX,
    y: ay + ly / scaleY,
  };
};

const normalizeTransformForPersist = (
  store: Store,
  transform: Transform,
  viewId: string,
  space: string | undefined,
  groupId?: string | null
) => {
  if (groupId) {
    const group = store.model.nodes.find((n: any) => String(n.id) === String(groupId)) as any;
    if (group?.transform) {
      const localAnchor = worldPointToGroupLocal(group.transform, { x: transform.x, y: transform.y });
      const scaleX = Math.max(1e-9, group.transform.w);
      const scaleY = Math.max(1e-9, group.transform.h);
      return {
        ...transform,
        x: localAnchor.x,
        y: localAnchor.y,
        w: transform.w / scaleX,
        h: transform.h / scaleY,
        rotationDeg: transform.rotationDeg - group.transform.rotationDeg,
      };
    }
  }
  if (space === "screen") return transform;
  const cam = resolveViewCamera(store, viewId);
  const rect = worldRectToViewRect(
    { x: transform.x, y: transform.y, w: transform.w, h: transform.h },
    cam
  );
  return { ...transform, ...rect };
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
  let lastMarqueeSelectAt = 0;
  const isNodeInActiveGroup = (node: any) => {
    const activeGid = String(store.activeGroupId ?? "");
    const parentGid = String(node?.groupId ?? "");
    if (!activeGid) return !parentGid;
    let cursor = parentGid;
    while (cursor) {
      if (cursor === activeGid) return true;
      const next = store.model.nodes.find((n: any) => String(n?.id ?? "") === cursor) as any;
      cursor = String(next?.groupId ?? "");
    }
    return false;
  };
  const isInteractive = (node: any) => {
    const isEditableTable = node && node.type === "table" && node.editable !== false;
    const byMode = isNodeInteractiveInMode(store.mode, node as any) || isEditableTable;
    const byGroup = isEditableTable ? true : isNodeInActiveGroup(node);
    return byMode && byGroup;
  };
  const docForNode = (node: any): "presentation" | "notes" => ((node as any).layer === "live" ? "notes" : "presentation");
  const persistViewIdForNode = (node: any, fallbackViewId: string) => {
    if (node?.groupId) return "group";
    if (node?.space === "screen") return "screen_main";
    if (node?.viewId) return String(node.viewId);
    if (Array.isArray(node?.viewIds) && node.viewIds.length) return String(node.viewIds[0]);
    return String(fallbackViewId || "home");
  };
  const bgPayload = (node: any) => ({
    bgColor: node?.bgColor,
    bgAlpha: node?.bgAlpha,
    bgPadding: node?.bgPadding,
    bgRadius: node?.bgRadius,
  });
  const ensureTableCells = (node: any) => {
    const rows = Math.max(1, Number(node.rows ?? node.cells?.length ?? 1));
    const cols = Math.max(1, Number(node.cols ?? node.cells?.[0]?.length ?? 1));
    const cells: string[][] = Array.isArray(node.cells) ? node.cells.map((r: any) => Array.isArray(r) ? r.map((c: any) => String(c)) : []) : [];
    while (cells.length < rows) cells.push([]);
    for (let r = 0; r < rows; r += 1) {
      const row = cells[r] ?? [];
      while (row.length < cols) row.push("");
      cells[r] = row;
    }
    node.cells = cells;
    node.rows = rows;
    node.cols = cols;
  };
  const applyTableCellUpdate = (node: any, row: number, col: number, value: string) => {
    if (!node || node.type !== "table") return;
    const hHeader: string[] = Array.isArray(node.hHeader) ? node.hHeader : [];
    const vHeader: string[] = Array.isArray(node.vHeader) ? node.vHeader : [];
    const headerRow = hHeader.length > 0;
    const headerCol = vHeader.length > 0;
    if (row <= 0 || col <= 0) return;
    const r = row - 1;
    const c = col - 1;
    if (headerRow && r == 0) {
      if (headerCol && c == 0) return;
      const idx = c - (headerCol ? 1 : 0);
      while (hHeader.length <= idx) hHeader.push("");
      hHeader[idx] = value;
      node.hHeader = hHeader;
      return;
    }
    if (headerCol && c == 0) {
      const idx = r - (headerRow ? 1 : 0);
      while (vHeader.length <= idx) vHeader.push("");
      vHeader[idx] = value;
      node.vHeader = vHeader;
      return;
    }
    ensureTableCells(node);
    const rr = r - (headerRow ? 1 : 0);
    const cc = c - (headerCol ? 1 : 0);
    if (rr < 0 || cc < 0) return;
    while ((node.cells as string[][]).length <= rr) (node.cells as string[][]).push([]);
    while ((node.cells as string[][])[rr]!.length <= cc) (node.cells as string[][])[rr]!.push("");
    (node.cells as string[][])[rr]![cc] = value;
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

  const screenSpaceToPx = (p: { x: number; y: number }, screen: { w: number; h: number }) => ({
    // Screen-space: normalized [0,1] with +y down.
    x: p.x * screen.w,
    y: p.y * screen.h,
  });
  const screenSpaceSizeToPx = (w: number, h: number, screen: { w: number; h: number }) => ({
    wPx: w * screen.w,
    hPx: h * screen.h,
  });
  const screenPxToSpace = (px: number, py: number, screen: { w: number; h: number }) => ({
    x: px / Math.max(1e-9, screen.w),
    y: py / Math.max(1e-9, screen.h),
  });

  const liveCueIndexByView = new Map<string, number>();
  let lastMode: "edit" | "screen-edit" | "live" = store.mode;
  let preLiveViewId: string | null = null;
  let preLiveCameraOverride: { cx: number; cy: number; zoom: number } | null = null;
  let preLiveCameraTween: Store["cameraTween"] = null;

  const isNodeForView = (node: any, viewId: string, screenId?: string) => {
    const nodeScreen = node?.screenId;
    const nodeScreens = Array.isArray(node?.screenIds) ? node.screenIds : null;
    const nodeView = node?.viewId;
    const nodeViews = Array.isArray(node?.viewIds) ? node.viewIds : null;
    if (nodeScreens) return nodeScreens.includes(screenId);
    if (nodeScreen != null) return nodeScreen === screenId;
    if (nodeViews) return nodeViews.includes(viewId);
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
  let pendingLiveAction:
    | { viewId: string; kind: "cue-forward" | "cue-back"; index: number; runAtMs: number }
    | null = null;

  const startViewTransition = (fromCam: { cx: number; cy: number; zoom: number }, toCam: { cx: number; cy: number; zoom: number }, durationMs: number) => {
    const now = performance.now();
    store.cameraOverride = { ...fromCam };
    store.cameraTween = {
      idx: 0,
      segments: [{ from: { ...fromCam }, to: { ...toCam }, durationMs, startMs: now, easing: "cos2" }],
    };
  };

  const queueLiveActionAfterReset = (kind: "cue-forward" | "cue-back", index: number, now: number) => {
    if (!store.cameraOverride) return false;
    const v = activeView(store);
    const target = fitCameraToScreen(resolveViewCamera(store, v.id), store);
    const durationMs = (v as any).durationMs ?? (store.model as any).defaults?.viewTransitionMs ?? 800;
    startViewTransition(store.cameraOverride, target, durationMs);
    pendingLiveAction = { viewId: v.id, kind, index, runAtMs: now + durationMs };
    pendingAuto = null;
    return true;
  };

  const bumpZIndex = (targetIds: string[]) => {
    if (!targetIds.length) return;
    const excluded = new Set(targetIds.map(String));
    let maxZ = 0;
    for (const n of store.model.nodes as any[]) {
      if (!n) continue;
      const zid = Number(n.zIndex ?? 0);
      if (!excluded.has(String(n.id))) maxZ = Math.max(maxZ, zid);
    }
    let nextZ = maxZ + 1;
    for (const id of targetIds) {
      const n = store.model.nodes.find((x) => String(x.id) === String(id)) as any;
      if (!n) continue;
      n.zIndex = nextZ;
      nextZ += 1;
    }
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
    persistActiveViewId(store);
    if (animate) {
      const target = fitCameraToScreen(resolveViewCamera(store, v.id), store);
      startViewTransition(fromCam, { ...target, zoom: fromCam.zoom }, durationMs);
    }
    else {
      const target = fitCameraToScreen(resolveViewCamera(store, v.id), store);
      store.cameraOverride = target;
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
    const isScreen = node.space === "screen";
    const worldScale = worldToScreenScale(cam, { w: screenW, h: screenH });
    const wPx = isScreen ? node.transform.w * screenW : node.transform.w * worldScale.x;
    const hPx = isScreen ? node.transform.h * screenH : node.transform.h * worldScale.y;
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
    const hasCues = cues.length > 0;
    const enterIds = new Set(cues.filter((c) => c.what === "enter").map((c) => String(c.id)));
    const exitIds = new Set(cues.filter((c) => c.what === "exit").map((c) => String(c.id)));
    const inTransition = !!store.cameraTween && !!store.transitionFromViewId && !!store.transitionToViewId;
    for (const n of store.model.nodes as any[]) {
      if (n.space === "screen") {
        if (!hasCues) {
          n.visible = true;
          (n as any).__exitStartMs = null;
        }
        continue;
      }
      if (!isNodeForView(n, viewId)) {
        if (!inTransition) {
          n.visible = false;
          (n as any).__exitStartMs = null;
        }
        continue;
      }
      if (!hasCues) {
        n.visible = true;
        (n as any).__exitStartMs = null;
        (n as any).__suppressAppear = true;
        (n as any).__appearedOnce = true;
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
  let activeTextEditor: (ActiveTextEditor & { startSnapshot: Snapshot }) | null = null;
  let activeButtonsEditor:
    | {
        nodeId: string;
        el: HTMLTextAreaElement;
        prevText: string;
        startSnapshot: Snapshot;
      }
    | null = null;
  let activeTableEditor:
    | {
        nodeId: string;
        startSnapshot: Snapshot;
      }
    | null = null;
  // When we create a new text node from typing, the DOM/editor may appear on the next frame.
  // During that gap, route keystrokes (including Space) into that new node.
  let pendingTextEdit: { nodeId: string } | null = null;
  let lastClick: { atMs: number; nodeId: string; x: number; y: number } | null = null;
  let lastGroupClick: { atMs: number; nodeId: string; x: number; y: number } | null = null;
  let lastCanvasClick: { atMs: number; x: number; y: number } | null = null;
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

  const pointWithinRectMargin = (x: number, y: number, rect: DOMRect | undefined | null, margin: number) => {
    if (!rect) return false;
    return x >= rect.left - margin && x <= rect.right + margin && y >= rect.top - margin && y <= rect.bottom + margin;
  };

  const pointWithinActiveTextEditorChrome = (x: number, y: number) => {
    const ed = activeTextEditor;
    if (!ed) return false;
    if (pointWithinRectMargin(x, y, ed.el.getBoundingClientRect(), 20)) return true;
    for (const btn of Object.values(ed.alignDots)) {
      if (pointWithinRectMargin(x, y, btn.getBoundingClientRect(), 12)) return true;
    }
    return false;
  };

  const relayoutActiveButtonsEditor = () => {
    const ed = activeButtonsEditor;
    if (!ed) return;
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(ed.nodeId)}"]`);
    if (!nodeEl) return;
    const nr = nodeEl.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();
    const left = nr.left - or.left;
    const width = nr.width;
    ed.el.style.left = `${left}px`;
    ed.el.style.width = `${width}px`;
    const lines = String(ed.el.value ?? "").split("\n").length;
    ed.el.rows = Math.max(2, lines + 1);
    const h = ed.el.getBoundingClientRect().height;
    const top = Math.max(8, nr.top - or.top - h - 6);
    ed.el.style.top = `${top}px`;
  };

  const cloneModel = (m: Model): Model => {
    const sc: any = (globalThis as any).structuredClone;
    if (typeof sc === "function") return sc(m);
    return JSON.parse(JSON.stringify(m)) as Model;
  };

  const persistModelToFiles = (prevMeta: Map<string, { doc: "presentation" | "notes"; groupId: string | null }>) => {
    const currentIds = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
    const removed = Array.from(prevMeta.keys()).filter((id) => !currentIds.has(id));
    if (removed.length) {
      const deletesByDoc: Record<"presentation" | "notes", { root: string[]; groups: Map<string, string[]> }> = {
        presentation: { root: [], groups: new Map() },
        notes: { root: [], groups: new Map() },
      };
      for (const id of removed) {
        const meta = prevMeta.get(id);
        if (!meta) continue;
        if (meta.groupId) {
          const bucket = deletesByDoc[meta.doc].groups;
          if (!bucket.has(meta.groupId)) bucket.set(meta.groupId, []);
          bucket.get(meta.groupId)!.push(id);
        } else {
          deletesByDoc[meta.doc].root.push(id);
        }
      }
      for (const doc of ["presentation", "notes"] as const) {
        if (deletesByDoc[doc].root.length) void persistDelete({ ids: deletesByDoc[doc].root, doc });
        for (const [gid, ids] of deletesByDoc[doc].groups.entries()) {
          if (ids.length) void persistDelete({ ids, doc, groupId: gid });
        }
      }
    }
    for (const n of store.model.nodes as any[]) {
      if (!n) continue;
      const groupId = n.groupId ? String(n.groupId) : null;
      const viewId = groupId ? "group" : n.space === "screen" ? "screen_main" : String(n.viewId ?? store.activeViewId ?? "home");
      const doc = docForNode(n);
      if (n.type === "text") {
        void persistText({
          id: String(n.id),
          viewId,
          text: String(n.text ?? ""),
          doc,
          space: groupId ? "group" : n.space,
          align: normalizeAlign(n.align),
          ...bgPayload(n),
          groupId,
        });
      } else if (n.type === "bullets") {
        void persistBullets({
          id: String(n.id),
          viewId,
          text: String(n.rawText ?? ""),
          bullets: String(n.bullets ?? ""),
          doc,
          space: groupId ? "group" : n.space,
          align: normalizeAlign(n.align),
          ...bgPayload(n),
          groupId,
        });
      } else if (n.type === "image") {
        void persistImage({ id: String(n.id), viewId, src: n.src, doc, space: groupId ? "group" : n.space, groupId, ...bgPayload(n) });
      } else if (n.type === "join") {
        void persistJoin({
          id: String(n.id),
          viewId,
          text: String(n.text ?? ""),
          fields: Array.isArray(n.fields) ? n.fields : [],
          doc,
          space: groupId ? "group" : n.space,
          ...bgPayload(n),
          groupId,
        });
      } else if (n.type === "table") {
        void persistTable({
          id: String(n.id),
          viewId,
          cells: Array.isArray((n as any).cells) ? (n as any).cells : [],
          rows: Number((n as any).rows ?? undefined),
          cols: Number((n as any).cols ?? undefined),
          editable: Boolean((n as any).editable),
          hHeader: Array.isArray((n as any).hHeader) ? (n as any).hHeader : undefined,
          vHeader: Array.isArray((n as any).vHeader) ? (n as any).vHeader : undefined,
          hStyle: Array.isArray((n as any).hStyle) ? (n as any).hStyle : undefined,
          color: (n as any).color,
          doc,
          space: groupId ? "group" : n.space,
          ...bgPayload(n),
          groupId,
        });
      } else if (n.type === "arrow") {
        const start = normalizePointForPersist(store, n.start ?? { x: 0, y: 0.5 }, viewId, n.space, groupId);
        const end = normalizePointForPersist(store, n.end ?? { x: 1, y: 0.5 }, viewId, n.space, groupId);
        const color = typeof n.color === "string" && n.color.includes(",") ? "white" : n.color;
        void persistArrow({
          id: String(n.id),
          viewId,
          start,
          end,
          color,
          strokePx: n.strokePx,
          doc,
          space: groupId ? "group" : n.space,
          ...bgPayload(n),
          groupId,
        });
      }
      if (n.type !== "arrow") {
        void persistGeometry({
          id: String(n.id),
          viewId,
          transform: normalizeTransformForPersist(store, n.transform, viewId, n.space, groupId),
          fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
          doc,
          space: groupId ? "group" : n.space,
          groupId,
        });
      }
    }
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

  const sessionRuntime = createEditorSessionRuntime(store, {
    updateHandles: () => updateHandles(),
    persistActiveViewId,
    applyTableCellUpdate,
  });
  const {
    undoStack,
    redoStack,
    snapshotNow,
    pushUndo,
    restoreSnapshot,
    clearSelection,
    setSingleSelection,
    setMultiSelection,
  } = sessionRuntime;

  window.addEventListener("ip-clear-selection", () => {
    clearSelection();
  });

  const aabbForNodeInSpace = (node: any) => {
    if (node.type === "arrow") {
      const x = Number(node.transform?.x ?? 0);
      const y = Number(node.transform?.y ?? 0);
      const w = Number(node.transform?.w ?? 0);
      const h = Number(node.transform?.h ?? 0);
      return { minX: x, minY: y, maxX: x + w, maxY: y + h };
    }
    const { ax, ay } = anchorFrac(node.transform.anchor);
    const w = Number(node.transform.w ?? 0);
    const h = Number(node.transform.h ?? 0);
    const xMin = -ax * w;
    const xMax = (1 - ax) * w;
    const yMin = -ay * h;
    const yMax = (1 - ay) * h;
    const rot = (Number(node.transform.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const corners = [
      { x: xMin, y: yMin },
      { x: xMax, y: yMin },
      { x: xMax, y: yMax },
      { x: xMin, y: yMax },
    ].map((p) => ({
      x: node.transform.x + p.x * cos - p.y * sin,
      y: node.transform.y + p.x * sin + p.y * cos,
    }));
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

  const groupEdit = createGroupEditRuntime({
    store,
    newId,
    clearSelection,
    updateHandles: () => updateHandles(),
    setSingleSelection,
    setMultiSelection,
    snapshotNow,
    pushUndo,
    aabbForNodeInSpace: (node) => aabbForNodeInSpace(node),
    anchorFrac,
    docForNode,
    persistViewIdForNode,
    bgPayload,
    normalizeTransformForPersist,
    normalizePointForPersist: (storeArg, point, viewId, space, groupId) => normalizePointForPersist(storeArg, point, viewId, space, groupId),
    persistText,
    persistBullets,
    persistImage,
    persistJoin,
    persistArrow,
    persistGeometry,
    persistElement,
    persistGroup,
    persistDelete,
  });
  const {
    groupChildren,
    groupDescendants,
    enterGroupEdit,
    exitGroupEdit,
    createGroupFromSelection,
    canUngroupSelected,
    ungroupSelectedGroup,
  } = groupEdit;

  const selectionRuntime = createSelectionRuntime({
    store,
    stage,
    overlay,
    groupDescendants,
    isInteractive,
    cameraForScreen,
    worldToScreen,
    worldToScreenScale,
    screenSpaceToPx,
    screenSpaceSizeToPx,
    screenPxToSpace,
    screenToWorld,
    anchorFrac,
    isNodeInteractiveInMode: (mode, node) => isNodeInteractiveInMode(mode as any, node),
    cursorAngleYourForHandle,
    cursorForRotate,
    toSvgAngle,
    snapAngle,
  });
  const {
    distPointToSegment,
    arrowLineHitPx,
    groupVisibleRectPx,
    arrowEndpointsScreen,
    arrowPointFromClient,
    pickNodeNearClientPoint,
    hitVirtualHandleAtClientPoint,
    hitNodeId,
    hitHandle,
    updateHoverCursorAtClientPoint,
  } = selectionRuntime;

  const transformRuntime = createTransformRuntime({
    store,
    stage,
    overlay,
    dragStartPx: DRAG_START_PX,
    rotSnapDeg: ROT_SNAP_DEG,
    cameraForScreen,
    cameraForEdit,
    groupDescendants,
    groupVisibleRectPx,
    snapshotNow,
    pushUndo,
    updateHandles: () => updateHandles(),
    bumpZIndex,
    screenToWorld,
    worldToScreen,
    worldToScreenScale,
    screenSpaceToPx,
    anchorFrac,
    snapTo,
    gridMajorStepWorld,
    cursorAngleYourForHandle,
    toSvgAngle,
    cursorForRotate,
    syncArrowTransform: (node) => syncArrowTransform(node),
    docForNode,
    persistViewIdForNode,
    normalizeTransformForPersist,
    normalizePointForPersist: (storeArg, point, viewId, space, groupId) => normalizePointForPersist(storeArg, point, viewId, space, groupId),
    persistGeometry,
    persistArrow,
    bgPayload,
  });

  window.addEventListener("ip-exit-group-edit", () => {
    if (store.activeGroupId) exitGroupEdit();
  });


  const createTextNodeAtClientPoint = (clientX: number, clientY: number, initialText: string) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const id = newId("t");
    const defaultWpx = 250;
    const defaultHpx = 80;
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const groupId = store.activeGroupId;
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const rel = screenPxToSpace(clientX - r.left, clientY - r.top, screen);
    const n: any = {
      id,
      type: "text",
      space: isScreen ? "screen" : "world",
      ...(groupId ? { groupId } : null),
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        // world: world units; screen: normalized coords [0,1] with y down
        x: isScreen ? rel.x : wp!.x,
        y: isScreen ? rel.y : wp!.y,
        // world: size stored in world units derived from px; screen: store in normalized coords
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / Math.max(1e-9, cam.zoom * screen.w),
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / Math.max(1e-9, cam.zoom * screen.h),
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
    const persistViewId = persistViewIdForNode(n, store.activeViewId);
    void persistText({
      id: String(id),
      viewId: persistViewId,
      text: String(initialText),
      doc,
      space: groupId ? "group" : n.space,
      align: n.align,
      ...bgPayload(n),
      groupId,
    });
    void persistGeometry({
      id: String(id),
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space, groupId),
      fontPx: n.fontPx,
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    return id;
  };

  const createNodeIdFromFilename = (filename: string | undefined, fallback: string) => {
    const baseName = String(filename ?? fallback).replace(/\.[^/.]+$/, "");
    const safeBase = baseName.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
    const existing = new Set((store.model.nodes ?? []).map((n: any) => String(n?.id ?? "")));
    let id = safeBase;
    let i = 2;
    while (existing.has(id)) {
      id = `${safeBase}_${i}`;
      i += 1;
    }
    return id;
  };

  const createImageNodeAtClientPoint = (clientX: number, clientY: number, opts: { src: string; filename?: string; aspect?: number }) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const groupId = store.activeGroupId;
    const rel = screenPxToSpace(clientX - r.left, clientY - r.top, screen);
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const id = createNodeIdFromFilename(opts.filename, "image");
    const defaultWpx = 240;
    const aspect = Math.max(1e-6, Number(opts.aspect ?? 1));
    const defaultHpx = defaultWpx / aspect;
    const n: any = {
      id,
      type: "image",
      space: isScreen ? "screen" : "world",
      ...(groupId ? { groupId } : null),
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        x: isScreen ? rel.x : wp!.x,
        y: isScreen ? rel.y : wp!.y,
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / Math.max(1e-9, cam.zoom * screen.w),
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / Math.max(1e-9, cam.zoom * screen.h),
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
    const persistViewId = persistViewIdForNode(n, store.activeViewId);
    void persistImage({ id, viewId: persistViewId, src: n.src, doc, space: groupId ? "group" : n.space, groupId, ...bgPayload(n) });
    void persistGeometry({
      id,
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space, groupId),
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    return id;
  };

  const createVideoNodeAtClientPoint = (clientX: number, clientY: number, opts: { src: string; filename?: string; aspect?: number }) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const groupId = store.activeGroupId;
    const rel = screenPxToSpace(clientX - r.left, clientY - r.top, screen);
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const id = createNodeIdFromFilename(opts.filename, "video");
    const defaultWpx = 320;
    const aspect = Math.max(1e-6, Number(opts.aspect ?? 16 / 9));
    const defaultHpx = defaultWpx / aspect;
    const n: any = {
      id,
      type: "video",
      space: isScreen ? "screen" : "world",
      ...(groupId ? { groupId } : null),
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        x: isScreen ? rel.x : wp!.x,
        y: isScreen ? rel.y : wp!.y,
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / Math.max(1e-9, cam.zoom * screen.w),
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / Math.max(1e-9, cam.zoom * screen.h),
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
    const persistViewId = persistViewIdForNode(n, store.activeViewId);
    void persistElement({
      id,
      type: "video",
      viewId: persistViewId,
      attrs: { src: n.src, ...bgPayload(n) },
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    void persistGeometry({
      id: String(id),
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space, groupId),
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    return id;
  };

  const createHtmlFrameNodeAtClientPoint = (
    clientX: number,
    clientY: number,
    opts: { src: string; filename?: string; aspect?: number; html?: string }
  ) => {
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const mode = store.mode;
    const isScreen = mode === "screen-edit";
    const groupId = store.activeGroupId;
    const rel = screenPxToSpace(clientX - r.left, clientY - r.top, screen);
    const wp = !isScreen ? screenToWorld({ x: clientX - r.left, y: clientY - r.top }, cam, screen) : null;
    const id = createNodeIdFromFilename(opts.filename, "iframe");
    const defaultWpx = 320;
    const aspect = Math.max(1e-6, Number(opts.aspect ?? 16 / 9));
    const defaultHpx = defaultWpx / aspect;
    const n: any = {
      id,
      type: "htmlFrame",
      space: isScreen ? "screen" : "world",
      ...(groupId ? { groupId } : null),
      ...(mode === "live" ? { layer: "live" } : null),
      zIndex: 0,
      visible: true,
      opacity: 1,
      transform: {
        x: isScreen ? rel.x : wp!.x,
        y: isScreen ? rel.y : wp!.y,
        w: isScreen ? defaultWpx / Math.max(1e-9, screen.w) : defaultWpx / Math.max(1e-9, cam.zoom * screen.w),
        h: isScreen ? defaultHpx / Math.max(1e-9, screen.h) : defaultHpx / Math.max(1e-9, cam.zoom * screen.h),
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
    const persistViewId = persistViewIdForNode(n, store.activeViewId);
    void persistElement({
      id,
      type: "iframe",
      viewId: persistViewId,
      attrs: { ...(opts.html ? { html: opts.html } : { src: n.src }), ...bgPayload(n) },
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    void persistGeometry({
      id: String(id),
      viewId: persistViewId,
      transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space, groupId),
      doc,
      space: groupId ? "group" : n.space,
      groupId,
    });
    return id;
  };

  const loadImageAspect = (src: string) =>
    new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = Math.max(1, img.naturalWidth || img.width || 0);
        const h = Math.max(1, img.naturalHeight || img.height || 0);
        resolve(w > 0 && h > 0 ? w / h : 1);
      };
      img.onerror = () => resolve(1);
      img.src = src;
    });

  const loadVideoAspect = (src: string) =>
    new Promise<number>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        const w = Math.max(1, video.videoWidth || 0);
        const h = Math.max(1, video.videoHeight || 0);
        resolve(w > 0 && h > 0 ? w / h : 16 / 9);
      };
      video.onerror = () => resolve(16 / 9);
      video.src = src;
    });

  const pasteInternalAtClientPoint = (clientX: number, clientY: number) => {
    if (!internalClipboard) return;
    pushUndo(snapshotNow());
    const cam = cameraForScreen();
    const r = stage.getBoundingClientRect();
    const cx = clientX;
    const cy = clientY;
    const groupId = store.activeGroupId;

    // If you keep pasting without moving the mouse, nudge by +50px,+50px each time to separate.
    if (lastPasteClient && Math.abs(cx - lastPasteClient.x) < 0.5 && Math.abs(cy - lastPasteClient.y) < 0.5) {
      pasteNudgeSteps += 1;
    } else {
      pasteNudgeSteps = 0;
    }
    lastPasteClient = { x: cx, y: cy };
    const nudgePx = 50 * pasteNudgeSteps;
    const screen = { w: r.width, h: r.height };
    const nudgeWorldX = nudgePx / Math.max(1e-9, cam.zoom * screen.w);
    const nudgeWorldY = nudgePx / Math.max(1e-9, cam.zoom * screen.h);

    // Place primary anchor exactly at mouse cursor (plus optional repeated-paste nudge).
    const cursorRel = screenPxToSpace(cx - r.left, cy - r.top, screen);
    const cursorWorld = screenToWorld({ x: cx - r.left, y: cy - r.top }, cam, screen);

    const newIds: string[] = [];
    for (const item of internalClipboard.nodes) {
      const n: any = cloneModel(item.node);
      n.id = newId(String(n.type ?? internalClipboard.primaryType ?? "n"));
      if (groupId) n.groupId = groupId;
      if (n.type === "arrow") {
        const start = n.start ?? { x: 0, y: 0 };
        const end = n.end ?? { x: 0, y: 0 };
        const mid = { x: (Number(start.x) + Number(end.x)) / 2, y: (Number(start.y) + Number(end.y)) / 2 };
        const target =
          n.space === "screen"
            ? {
                x: cursorRel.x + nudgePx / Math.max(1e-9, screen.w) + item.relAnchor.dx,
                y: cursorRel.y + nudgePx / Math.max(1e-9, screen.h) + item.relAnchor.dy,
              }
            : { x: cursorWorld.x + nudgeWorldX + item.relAnchor.dx, y: cursorWorld.y + nudgeWorldY + item.relAnchor.dy };
        const dx = target.x - mid.x;
        const dy = target.y - mid.y;
        n.start = { x: Number(start.x) + dx, y: Number(start.y) + dy };
        n.end = { x: Number(end.x) + dx, y: Number(end.y) + dy };
      } else if (n.transform) {
        if (n.space === "screen") {
          n.transform.x = cursorRel.x + nudgePx / Math.max(1e-9, screen.w) + item.relAnchor.dx;
          n.transform.y = cursorRel.y + nudgePx / Math.max(1e-9, screen.h) + item.relAnchor.dy;
        } else {
          n.transform.x = cursorWorld.x + nudgeWorldX + item.relAnchor.dx;
          n.transform.y = cursorWorld.y + nudgeWorldY + item.relAnchor.dy;
        }
      }
      store.model.nodes.push(n);
      newIds.push(n.id);
      // Persist paste as creation (text + geometry)
      const doc = docForNode(n);
      const persistViewId = persistViewIdForNode(n, store.activeViewId);
      if (n.type === "text") {
        void persistText({
          id: String(n.id),
          viewId: persistViewId,
          text: String(n.text ?? ""),
          doc,
          space: groupId ? "group" : n.space,
          align: normalizeAlign((n as any).align),
          ...bgPayload(n),
          groupId,
        });
      }
      if (n.type === "bullets") {
        void persistBullets({
          id: String(n.id),
          viewId: persistViewId,
          text: String(n.rawText ?? ""),
          bullets: String(n.bullets ?? ""),
          doc,
          space: groupId ? "group" : n.space,
          align: normalizeAlign((n as any).align),
          ...bgPayload(n),
          groupId,
        });
      }
      void persistGeometry({
        id: String(n.id),
        viewId: persistViewId,
        transform: normalizeTransformForPersist(store, n.transform, persistViewId, n.space, groupId),
        fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
        doc,
        space: groupId ? "group" : n.space,
        groupId,
      });
    }
    setMultiSelection(newIds, newIds[0] ?? null);
  };

  const deleteSelectedNodes = () => {
    if ((store.selectedIds?.length ?? 0) <= 0) return;
    pushUndo(snapshotNow());
    const baseSel = Array.from(new Set(store.selectedIds.map(String)));
    const expanded = new Set(baseSel);
    for (const id of baseSel) {
      const node = store.model.nodes.find((n: any) => String(n.id) === String(id)) as any;
      if (node?.type === "group") {
        for (const child of groupChildren(node.id)) {
          expanded.add(String(child.id));
        }
      }
    }
    const deletesByDoc: Record<"presentation" | "notes", { root: string[]; groups: Map<string, string[]> }> = {
      presentation: { root: [], groups: new Map() },
      notes: { root: [], groups: new Map() },
    };
    for (const id of expanded) {
      const node = store.model.nodes.find((n: any) => String(n.id) === String(id)) as any;
      if (!node) continue;
      const doc = docForNode(node);
      const gid = node.groupId ? String(node.groupId) : null;
      if (gid) {
        if (!deletesByDoc[doc].groups.has(gid)) deletesByDoc[doc].groups.set(gid, []);
        deletesByDoc[doc].groups.get(gid)!.push(String(id));
      } else {
        deletesByDoc[doc].root.push(String(id));
      }
    }
    for (const doc of ["presentation", "notes"] as const) {
      if (deletesByDoc[doc].root.length) void persistDelete({ ids: deletesByDoc[doc].root, doc });
      for (const [gid, delIds] of deletesByDoc[doc].groups.entries()) {
        if (delIds.length) void persistDelete({ ids: delIds, doc, groupId: gid });
      }
    }
    store.model.nodes = store.model.nodes.filter((n) => !expanded.has(String((n as any).id)));
    clearSelection();
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


const normalizePointForPersist = (
  store: Store,
  p: { x: number; y: number },
  viewId: string,
  space: string | undefined,
  groupId?: string | null
) => {
  if (groupId) {
    const group = store.model.nodes.find((n: any) => String(n.id) === String(groupId)) as any;
    if (group?.transform) return worldPointToGroupLocal(group.transform, p);
  }
  if (space === "screen") return p;
  const cam = resolveViewCamera(store, viewId);
  return worldToView(p, cam);
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
    if (node.type === "group") {
      const descendantRects = groupDescendants(id)
        .map((child: any) =>
          overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(String(child.id))}"]`)
        )
        .filter((el): el is HTMLElement => !!el && el.style.display !== "none")
        .map((el) => el.getBoundingClientRect());
      if (descendantRects.length) {
        const overlayRect = overlay.getBoundingClientRect();
        const minLeft = Math.min(...descendantRects.map((r) => r.left));
        const minTop = Math.min(...descendantRects.map((r) => r.top));
        const maxRight = Math.max(...descendantRects.map((r) => r.right));
        const maxBottom = Math.max(...descendantRects.map((r) => r.bottom));
        handles.showForRect(
          {
            left: minLeft - overlayRect.left,
            top: minTop - overlayRect.top,
            width: Math.max(1, maxRight - minLeft),
            height: Math.max(1, maxBottom - minTop),
          },
          node.transform.anchor
        );
        return;
      }
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
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const isScreen = node.space === "screen";
    const cam = cameraForEdit();

    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(id)}"]`);
    const rect = nodeEl?.getBoundingClientRect() ?? null;
    const wantsExactText = node.type === "text" || node.type === "bullets";

    let wPx = isScreen ? t.w * screen.w : t.w * worldToScreenScale(cam, screen).x;
    let hPx = isScreen ? t.h * screen.h : t.h * worldToScreenScale(cam, screen).y;
    if (rect && wantsExactText) {
      const bw = Math.max(1, rect.width);
      const bh = Math.max(1, rect.height);
      const c = Math.abs(cos);
      const s = Math.abs(sin);
      const denom = c * c - s * s;
      if (Math.abs(denom) > 1e-4) {
        const w0 = (bw * c - bh * s) / denom;
        const h0 = (bh * c - bw * s) / denom;
        if (Number.isFinite(w0) && Number.isFinite(h0) && w0 > 0.5 && h0 > 0.5) {
          wPx = w0;
          hPx = h0;
        }
      }
    }

    const anchorPx = isScreen
      ? { x: t.x * screen.w, y: t.y * screen.h }
      : worldToScreen({ x: t.x, y: t.y }, cam, screen);

    const v0x = -ax0 * wPx;
    const v0y = -ay0 * hPx;
    const tlx = anchorPx.x + v0x * cos - v0y * sin;
    const tly = anchorPx.y + v0x * sin + v0y * cos;
    const v1x = -ax1 * wPx;
    const v1y = -ay1 * hPx;
    const nextAnchorPxX = tlx - (v1x * cos - v1y * sin);
    const nextAnchorPxY = tly - (v1x * sin + v1y * cos);
    if (isScreen) {
      node.transform = {
        ...t,
        anchor: nextAnchor,
        x: nextAnchorPxX / Math.max(1e-9, screen.w),
        y: nextAnchorPxY / Math.max(1e-9, screen.h),
      };
      return;
    }
    const nextWorld = screenToWorld({ x: nextAnchorPxX, y: nextAnchorPxY }, cam, screen);
    node.transform = { ...t, anchor: nextAnchor, x: nextWorld.x, y: nextWorld.y };
  };

  const onPointerDown = (ev: PointerEvent) => {
    const target = ev.target as HTMLElement | null;
    const inVideoControls = !!target?.closest?.(".video-controls");
    const inButtonsUi = !!target?.closest?.(".node-buttons") || !!target?.closest?.(".buttons-grid") || !!target?.closest?.(".buttons-btn");
    const inSliderUi = !!target?.closest?.(".node-slider") || !!target?.closest?.(".slider-input");
    const inLiveUi = inVideoControls || inButtonsUi || inSliderUi;
    if (store.mode === "live") {
      if (inLiveUi) return;
      // Allow ctrl-drag arrow creation and right-click deselect in live mode.
      if ((ev.button === 0 && ev.ctrlKey) || ev.button === 2) {
        // fall through to dedicated handlers below
      } else {
        const nodeEl = target?.closest?.(".node") as HTMLElement | null;
        const nodeId = nodeEl?.dataset?.nodeId ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
        const node = nodeId ? store.model.nodes.find((n) => String(n.id) === String(nodeId)) : null;
        const allowLiveTextEdit =
          node && node.type === "text" && String((node as any).pressureRole ?? "") === "peak";
        const allowLiveTableEdit = node && node.type === "table" && (node as any).editable !== false;
        if (!node || ((node as any).layer !== "live" && !allowLiveTextEdit && !allowLiveTableEdit)) return;
      }
    }
    if (inVideoControls) return;
    // Keep mouse position updated even if the user clicks without moving.
    lastClient = { x: ev.clientX, y: ev.clientY };
    // Pan: middle mouse only (no Space-pan).
    if (ev.button === 1) {
      if (store.mode === "live") {
        ev.preventDefault();
        return;
      }
      const cam = cameraForEdit();
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const startWorld = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);
      if (!store.cameraOverride) store.cameraOverride = { ...cam };
      owner = {
        kind: "pan",
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startCx: cam.cx,
        startCy: cam.cy,
        startWorldX: startWorld.x,
        startWorldY: startWorld.y,
        startZoom: cam.zoom,
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
    // Right click: open context menu only when clicking current selection; otherwise marquee-select.
    if (ev.button === 2) {
      // Right click outside the editor should commit+close it (same gesture as clear selection).
      if (activeTextEditor && !(ev.target as HTMLElement | null)?.closest?.(".text-editor")) {
        closeTextEditor({ commit: true });
      }
      if (activeButtonsEditor && !(ev.target as HTMLElement | null)?.closest?.(".text-editor")) {
        closeButtonsEditor({ commit: true });
      }
      if (activeTableEditor && !(ev.target as HTMLElement | null)?.closest?.(".table-cell")) {
        closeTableEditor();
      }
      const rightHit = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      const selectedSet = new Set(store.selectedIds ?? []);
      const clickedSelected = rightHit ? selectedSet.has(rightHit) || store.selectedId === rightHit : false;
      if (store.mode !== "live" && clickedSelected) return; // allow native context menu
      owner = {
        kind: "rselect",
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
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
    if (ev.button !== 0) return;
    const targetEl = ev.target as HTMLElement | null;
    if (targetEl?.closest?.(".text-editor")) return;
    const tableCell = targetEl?.closest?.(".table-cell");
    const tableNode = tableCell?.closest?.(".node") as HTMLElement | null;
    const tableEditing = tableNode?.dataset?.nodeType === "table" && tableNode.dataset.editing === "1";
    if (tableCell && tableEditing) return;
    if (activeButtonsEditor) return;
    if (activeTableEditor && !(ev.target as HTMLElement | null)?.closest?.(".table-cell")) {
      closeTableEditor();
    }

    // Pan with left-drag on empty canvas.
    {
      const h = hitHandle(ev);
      const targetId = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      if (!h && !targetId) {
        if (store.mode === "live") {
          if (!ev.ctrlKey) {
            ev.preventDefault();
            return;
          }
        }
        if (!ev.ctrlKey) {
          const cam = cameraForEdit();
          const r = stage.getBoundingClientRect();
          const screen = { w: r.width, h: r.height };
          const startWorld = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);
          if (!store.cameraOverride) store.cameraOverride = { ...cam };
          owner = {
            kind: "pan",
            pointerId: ev.pointerId,
            startClientX: ev.clientX,
            startClientY: ev.clientY,
            startCx: cam.cx,
            startCy: cam.cy,
            startWorldX: startWorld.x,
            startWorldY: startWorld.y,
            startZoom: cam.zoom,
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

    // Double-click empty canvas toggles screen-edit or exits group edit.
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
          if (store.activeGroupId) exitGroupEdit();
          else {
            store.mode = store.mode === "screen-edit" ? "edit" : "screen-edit";
            clearSelection();
          }
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
    // Group edit: double-click a group to enter, double-click canvas to exit.
    {
      const targetId = store.selectedId ?? hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      const h = hitHandle(ev);
      const hvHit = h && !h.startsWith("anchor:") ? ({ id: h, d2: 0 } as any) : hitVirtualHandleAtClientPoint(ev.clientX, ev.clientY, targetId);
      const hv = hvHit?.id ?? null;
      if (!hv && targetId) {
        const node: any = store.model.nodes.find((n) => n.id === targetId);
        if (node && node.type === "group") {
          const now = performance.now();
          const prev = lastGroupClick;
          const dt = prev ? now - prev.atMs : Infinity;
          const dpx = prev ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
          if (prev && prev.nodeId === targetId && dt < 420 && dpx < 6) {
            setSingleSelection(targetId);
            owner = null;
            enterGroupEdit(targetId);
            lastGroupClick = null;
            ev.preventDefault();
            return;
          }
          lastGroupClick = { atMs: now, nodeId: targetId, x: ev.clientX, y: ev.clientY };
        } else {
          lastGroupClick = null;
        }
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
        if (node && (node.type === "text" || node.type === "bullets" || node.type === "buttons" || node.type === "table")) {
          const now = performance.now();
          const prev = lastClick;
          const dt = prev ? now - prev.atMs : Infinity;
          const dpx = prev ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
          if (prev && prev.nodeId === targetId && dt < 420 && dpx < 6) {
            setSingleSelection(targetId);
            owner = null;
            // open editor
            // (defined below in this scope)
            if (node.type === "buttons") openButtonsEditorForNode(targetId);
            else if (node.type === "table") openTableEditorForNode(targetId);
            else openTextEditorForNode(targetId);
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

    // Ctrl+drag on empty space creates a new arrow (including live notes).
    if (ev.button === 0 && ev.ctrlKey) {
      const hitId = store.mode === "live" ? null : hitNodeId(ev);
      if (!hitId) {
        const snap = snapshotNow();
        const isScreen = store.mode === "screen-edit";
        const groupId = store.activeGroupId;
        const id = newId("arrow");
        const n: any = {
          id,
          type: "arrow",
          space: isScreen ? "screen" : "world",
          ...(groupId ? { groupId } : null),
          ...(store.mode === "live" ? { layer: "live" } : null),
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
          zBumped: false,
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
          if (ev.shiftKey || ev.ctrlKey) {
            // Allow modifier clicks to go through selection logic.
          } else {
            setSingleSelection(targetId);
            const ends = arrowEndpointsScreen(node);
            const endRadius = 20;
            const dStart = Math.hypot(ev.clientX - ends.start.x, ev.clientY - ends.start.y);
            const dEnd = Math.hypot(ev.clientX - ends.end.x, ev.clientY - ends.end.y);
            const lineHit = distPointToSegment(ev.clientX, ev.clientY, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
            const lineThreshold = arrowLineHitPx(node);
            const endOverlapPx = 20;
            const arrowLen = Math.hypot(ends.end.x - ends.start.x, ends.end.y - ends.start.y);
            const preferLine = arrowLen <= endOverlapPx && lineHit <= lineThreshold && lineHit <= Math.min(dStart, dEnd);
            if (preferLine) {
              owner = {
                kind: "arrow-move",
                pointerId: ev.pointerId,
                nodeId: targetId,
                startClientX: ev.clientX,
                startClientY: ev.clientY,
                startStart: { x: node.start?.x ?? 0, y: node.start?.y ?? 0.5 },
                startEnd: { x: node.end?.x ?? 1, y: node.end?.y ?? 0.5 },
                dirty: false,
                zBumped: false,
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
            if (dStart <= endRadius || dEnd <= endRadius) {
              const endId = dStart <= dEnd ? "start" : "end";
              owner = {
                kind: "arrow-end",
                pointerId: ev.pointerId,
                nodeId: targetId,
                endId,
                dirty: false,
                zBumped: false,
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
            if (lineHit <= lineThreshold) {
              owner = {
                kind: "arrow-move",
                pointerId: ev.pointerId,
                nodeId: targetId,
                startClientX: ev.clientX,
                startClientY: ev.clientY,
                startStart: { x: node.start?.x ?? 0, y: node.start?.y ?? 0.5 },
                startEnd: { x: node.end?.x ?? 1, y: node.end?.y ?? 0.5 },
                dirty: false,
                zBumped: false,
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

      if (String(hv).startsWith("anchor:")) {
        const a = String(hv).slice("anchor:".length) as Anchor;
        pushUndo(snapshotNow());
        applyAnchorChange(id, a);
        ev.preventDefault();
        return;
      }
      // Rotation: use upper corners (nw/ne). No separate rotation handle.
      const isRotateCorner = hv === "nw" || hv === "ne";
      if (isRotateCorner) {
        owner = transformRuntime.createRotateOwner(id, hv as any, ev) as any;
      } else {
        owner = transformRuntime.createResizeOwner(id, hv as any, ev) as any;
      }

      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      ev.preventDefault();
      return;
    }

    const id = hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
    if (!id && ev.shiftKey) {
      // Shift-click on empty space should not clear existing selection.
      ev.preventDefault();
      return;
    }
    if (!id) {
      if (store.mode === "live" && !ev.ctrlKey) {
        ev.preventDefault();
        return;
      }
      if (ev.ctrlKey) {
        // Ctrl-drag is reserved for arrow creation; avoid panning.
        ev.preventDefault();
        return;
      }
      // IMPORTANT: left click does NOT cancel selection.
      // Only right click clears selection (see rselect pointerup).
      // Left drag on empty canvas pans.
      const cam = cameraForEdit();
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const startWorld = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);
      if (!store.cameraOverride) store.cameraOverride = { ...cam };
      owner = {
        kind: "pan",
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startCx: cam.cx,
        startCy: cam.cy,
        startWorldX: startWorld.x,
        startWorldY: startWorld.y,
        startZoom: cam.zoom,
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
    if (!isInteractive(node)) return;
    owner = transformRuntime.createMoveOwner(nodeIdForMove, ev) as any;
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
      const r = stage.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      store.cameraOverride = cameraForScreenPan(
        { x: o.startWorldX, y: o.startWorldY },
        { x: sx, y: sy },
        { cx: o.startCx, cy: o.startCy, zoom: o.startZoom },
        { w: Math.max(1e-9, r.width), h: Math.max(1e-9, r.height) }
      );
      ev.preventDefault();
      return;
    }

    if (activeTextEditor) {
      const inEditor = !!(ev.target as HTMLElement | null)?.closest?.(".text-editor");
      if (inEditor) {
        activeTextEditor.everEntered = true;
        return;
      }
      const nodeMargin = 8;
      const nodeRect = overlay
        .querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(activeTextEditor.nodeId)}"]`)
        ?.getBoundingClientRect();
      const withinEditorMargin = pointWithinActiveTextEditorChrome(ev.clientX, ev.clientY);
      const withinNodeMargin = !!nodeRect &&
        ev.clientX >= nodeRect.left - nodeMargin &&
        ev.clientX <= nodeRect.right + nodeMargin &&
        ev.clientY >= nodeRect.top - nodeMargin &&
        ev.clientY <= nodeRect.bottom + nodeMargin;
      if (withinEditorMargin || withinNodeMargin) return;
      // If the user is dragging/selecting text and leaves the editor, do not close yet.
      if ((ev.buttons & 1) !== 0) {
        activeTextEditor.everEntered = false;
        return;
      }
      closeTextEditor({ commit: true });
      return;
    }
    if (activeButtonsEditor) {
      const inEditor = !!(ev.target as HTMLElement | null)?.closest?.(".text-editor");
      if (!inEditor) {
        const margin = 20;
        const r = activeButtonsEditor.el.getBoundingClientRect();
        const withinMargin =
          ev.clientX >= r.left - margin &&
          ev.clientX <= r.right + margin &&
          ev.clientY >= r.top - margin &&
          ev.clientY <= r.bottom + margin;
        if (!withinMargin && (ev.buttons & 1) === 0) closeButtonsEditor({ commit: true });
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
        const dY = dy / Math.max(1e-9, screen.h);
        node.start = { x: o.startStart.x + dX, y: o.startStart.y + dY };
        node.end = { x: o.startEnd.x + dX, y: o.startEnd.y + dY };
      } else {
        const dX = dx / Math.max(1e-9, cam.zoom * screen.w);
        const dY = dy / Math.max(1e-9, cam.zoom * screen.h);
        node.start = { x: o.startStart.x + dX, y: o.startStart.y + dY };
        node.end = { x: o.startEnd.x + dX, y: o.startEnd.y + dY };
      }
      syncArrowTransform(node);
      o.dirty = true;
      if (!(o as any).zBumped) {
        bumpZIndex([String(o.nodeId)]);
        (o as any).zBumped = true;
      }
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
      if (!(o as any).zBumped) {
        bumpZIndex([String(o.nodeId)]);
        (o as any).zBumped = true;
      }
      ev.preventDefault();
      updateHandles();
      return;
    }
    if (o.kind === "arrow-create") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId) as any;
      if (!node) return;
      updateArrowFromClientDrag(node, o.startClientX, o.startClientY, ev.clientX, ev.clientY);
      o.dirty = true;
      if (!(o as any).zBumped) {
        bumpZIndex([String(o.nodeId)]);
        (o as any).zBumped = true;
      }
      ev.preventDefault();
      updateHandles();
      return;
    }
    if (transformRuntime.applyPointerMove(o as any, ev)) {
      ev.preventDefault();
      return;
    }
  };
  // Track mouse position even when outside the overlay, so keyboard shortcuts (copy/paste)
  // use the true mouse delta instead of a stale lastClient.
  const onWindowPointerMove = (ev: PointerEvent) => {
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (!activeTextEditor) return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const inEditor = !!target?.closest?.(".text-editor");
    if (inEditor) return;
    const nodeMargin = 8;
    const nodeRect = overlay
      .querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(activeTextEditor.nodeId)}"]`)
      ?.getBoundingClientRect();
    const withinEditorMargin = pointWithinActiveTextEditorChrome(ev.clientX, ev.clientY);
    const withinNodeMargin = !!nodeRect &&
      ev.clientX >= nodeRect.left - nodeMargin &&
      ev.clientX <= nodeRect.right + nodeMargin &&
      ev.clientY >= nodeRect.top - nodeMargin &&
      ev.clientY <= nodeRect.bottom + nodeMargin;
    if (withinEditorMargin || withinNodeMargin) return;
    if ((ev.buttons & 1) !== 0) return;
    closeTextEditor({ commit: true });
  };

  const onPointerUp = (ev: PointerEvent) => {
    if (!owner) return;
    if (owner.pointerId !== ev.pointerId) return;
    if (owner.kind === "rselect") {
      marquee.style.display = "none";
      const wasDirty = owner.dirty;
      if (!wasDirty) {
        if (owner.action === "group") {
          createGroupFromSelection();
        } else if (owner.action === "ungroup") {
          ungroupSelectedGroup();
        } else {
          // Right click: clear selection.
          if (store.selectedId || (store.selectedIds?.length ?? 0) > 0) pushUndo(owner.startSnapshot);
          clearSelection();
        }
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
      const cam = cameraForScreen();
      const screen = { w: or.width, h: or.height };
      for (const n of store.model.nodes as any[]) {
        if (!n || n.visible === false) continue;
        if (!isInteractive(n)) continue;
        const isWorld = n.space !== "screen";
        const anchorScreen = isWorld
          ? worldToScreen({ x: n.transform.x, y: n.transform.y }, cam, screen)
          : screenSpaceToPx({ x: n.transform.x, y: n.transform.y }, screen);
        const inside =
          anchorScreen.x >= left &&
          anchorScreen.x <= right &&
          anchorScreen.y >= top &&
          anchorScreen.y <= bottom;
        if (inside) hits.push(String(n.id));
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
      lastMarqueeSelectAt = performance.now();
      owner = null;
      return;
    }
    if (transformRuntime.finishPointerUp(owner as any)) {
      owner = null;
      if (overlayIsOver && lastClient) updateHoverCursorAtClientPoint(lastClient.x, lastClient.y, null);
      return;
    }
    if ((owner as any).kind === "pan") overlay.style.cursor = "";
    owner = null;
    updateHandles();
    // Refresh cursor immediately; don't require a "leave and re-enter" or a tiny mouse move.
    if (overlayIsOver && lastClient) updateHoverCursorAtClientPoint(lastClient.x, lastClient.y, null);
  };

  const mediaKindForFile = (file: File): "image" | "video" | "html" | null => {
    const type = (file.type || "").toLowerCase();
    const name = String(file.name || "");
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
    if (type.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
    if (type === "text/html" || type === "application/xhtml+xml" || ["html", "htm"].includes(ext)) return "html";
    return null;
  };

  const handleMediaDrop = (ev: DragEvent) => {
    const files = Array.from(ev.dataTransfer?.files ?? []);
    const file = files.find((f) => mediaKindForFile(f)) ?? null;
    if (!file) return false;
    if (store.mode === "live") return true;
    ev.preventDefault();
    ev.stopPropagation();
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    const kind = mediaKindForFile(file);
    if (!kind) return false;
    void (async () => {
      if (kind === "html") {
        const html = await file.text();
        const src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
        createHtmlFrameNodeAtClientPoint(clientX, clientY, { src, filename: file.name, aspect: 16 / 9, html });
        return;
      }
      const uploaded = await uploadMediaFile(file);
      if (kind === "image") {
        const aspect = await loadImageAspect(uploaded.src);
        createImageNodeAtClientPoint(clientX, clientY, { src: uploaded.src, filename: uploaded.filename, aspect });
      } else if (kind === "video") {
        const aspect = await loadVideoAspect(uploaded.src);
        createVideoNodeAtClientPoint(clientX, clientY, { src: uploaded.src, filename: uploaded.filename, aspect });
      }
    })();
    return true;
  };

  const onDragOver = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    if (!Array.from(ev.dataTransfer.files).some((f) => mediaKindForFile(f))) return;
    if (store.mode === "live") return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    handleMediaDrop(ev);
  };

  const onWindowDragOver = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    if (!Array.from(ev.dataTransfer.files).some((f) => mediaKindForFile(f))) return;
    if (store.mode === "live") return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = "copy";
  };

  const onWindowDrop = (ev: DragEvent) => {
    if (!ev.dataTransfer?.files?.length) return;
    if (!handleMediaDrop(ev)) return;
  };

  const onWheel = (ev: WheelEvent) => {
    if (store.mode === "live") return;
    if (activeTextEditor || activeButtonsEditor) return;
    lastClient = { x: ev.clientX, y: ev.clientY };
    // Zoom with wheel (trackpad/mouse). Prevent page scroll.
    ev.preventDefault();
    const actualCam = cameraForEdit();
    const r = stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    // World under cursor before zoom
    const cursorWorld = screenToWorld({ x: sx, y: sy }, actualCam, screen);
    const cursorRel = screenToWorld({ x: sx, y: sy }, { cx: 0, cy: 0, zoom: 1 }, screen);
    const scale = Math.exp(-ev.deltaY * 0.0012);
    // No practical max-zoom; allow extreme zooming. Rendering already clamps text to >= 1px.
    const minZoom = 50 / Math.max(1e-9, screen.w);
    const nextActualZoom = Math.max(minZoom, Math.min(1e4, actualCam.zoom * scale));
    // Adjust camera center so (wx,wy) stays under cursor
    store.cameraOverride = {
      cx: cursorWorld.x - cursorRel.x / nextActualZoom,
      cy: cursorWorld.y - cursorRel.y / nextActualZoom,
      zoom: nextActualZoom,
    };
  };

  function closeTextEditor(opts?: { commit?: boolean }) {
    const ed = activeTextEditor;
    if (!ed) return;
    if ((ed.el.dataset as any).closing === "1") return;
    const node: any = store.model.nodes.find((n) => n.id === ed.nodeId);
    if (node && node.type === "text") {
      const next = opts?.commit ? ed.el.value : ed.prevText;
      node.template = next;
      node.text = next;
      (node as any).align = opts?.commit ? ed.currentAlign : editorStartAlignForNode(ed.startSnapshot, ed.nodeId);
      if (opts?.commit && String((node as any).pressureRole ?? "") === "peak") {
        (node as any).__manualText = true;
      }
    }
    if (node && node.type === "bullets") {
      const rawValue = opts?.commit ? ed.el.value : ed.prevText;
      const parsed = parseBulletEditorValue(rawValue);
      const nextSpec = mergeBulletSpec(node.bullets, parsed.spec);
      if (nextSpec) node.bullets = nextSpec;
      node.rawText = parsed.rawText;
      node.items = parsed.items;
      node.template = rawValue;
      (node as any).align = opts?.commit ? ed.currentAlign : editorStartAlignForNode(ed.startSnapshot, ed.nodeId);
    }
    const alignChanged = ed.currentAlign !== editorStartAlignForNode(ed.startSnapshot, ed.nodeId);
    if (opts?.commit && (ed.el.value !== ed.prevText || alignChanged)) pushUndo(ed.startSnapshot);
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(ed.nodeId)}"]`);
    const el = ed.el;
    const removeEditorChromeNow = () => {
      try {
        if (el.isConnected) el.remove();
      } catch (e) {
        console.error("[next][textEdit] failed to remove textarea", e);
      }
      ed.errEl.remove();
      ed.alignEl.remove();
    };
    const finalizeClose = () => {
      activeTextEditor = null;
      if (nodeEl) delete (nodeEl.dataset as any).editing;
      if (node) {
        if ((node as any).__manualResize) delete (node as any).__manualResize;
      }
      updateHandles();
    };
    const persistCommittedState = () => {
      if (!opts?.commit || !node) return;
      const groupId = node.groupId ? String(node.groupId) : null;
      const persistViewId = persistViewIdForNode(node, store.activeViewId);
      if (node.type === "text") {
        void persistText({
          id: String(node.id),
          viewId: persistViewId,
          text: String(node.text ?? ""),
          doc: docForNode(node),
          space: groupId ? "group" : node.space,
          align: normalizeAlign((node as any).align),
          ...bgPayload(node),
          groupId,
        });
      } else if (node.type === "bullets") {
        void persistBullets({
          id: String(node.id),
          viewId: persistViewId,
          text: String(node.rawText ?? ""),
          bullets: String(node.bullets ?? ""),
          doc: docForNode(node),
          space: groupId ? "group" : node.space,
          align: normalizeAlign((node as any).align),
          ...bgPayload(node),
          groupId,
        });
      }
      if (node.type === "text" || node.type === "bullets") {
        void persistGeometry({
          id: String(node.id),
          viewId: persistViewId,
          transform: normalizeTransformForPersist(store, node.transform, persistViewId, node.space, groupId),
          fontPx: (node as any).fontPx,
          doc: docForNode(node),
          space: groupId ? "group" : node.space,
          groupId,
        });
      }
    };
    (el.dataset as any).closing = "1";
    removeEditorChromeNow();
    if (opts?.commit && node && (node.type === "text" || node.type === "bullets")) {
      requestAnimationFrame(() => {
        persistCommittedState();
        finalizeClose();
      });
      return;
    }
    finalizeClose();
  }

  function closeButtonsEditor(opts?: { commit?: boolean }) {
    const ed = activeButtonsEditor;
    if (!ed) return;
    const node: any = store.model.nodes.find((n) => n.id === ed.nodeId);
    if (node && node.type === "buttons") {
      const rawValue = opts?.commit ? ed.el.value : ed.prevText;
      const labels: string[] = [];
      const actions: string[] = [];
      for (const line of String(rawValue).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(":");
        const label = (idx >= 0 ? trimmed.slice(0, idx) : trimmed).trim();
        const action = (idx >= 0 ? trimmed.slice(idx + 1) : "").trim();
        labels.push(label);
        actions.push(action);
      }
      node.templates = labels;
      node.labels = labels;
      node.actions = actions;
      if (opts?.commit && ed.el.value !== ed.prevText) {
        pushUndo(ed.startSnapshot);
        const groupId = node.groupId ? String(node.groupId) : null;
        const persistViewId = persistViewIdForNode(node, store.activeViewId);
        void persistButtons({
          id: String(node.id),
          viewId: persistViewId,
          labels,
          actions,
          buttonsMode: (node as any).buttonsMode,
          hSplits: node.hSplits,
          vSplits: node.vSplits,
          rows: node.rows,
          cols: node.cols,
          doc: docForNode(node),
          space: groupId ? "group" : node.space,
          groupId,
        });
      }
    }
    activeButtonsEditor = null;
    const el = ed.el;
    (el.dataset as any).closing = "1";
    requestAnimationFrame(() => {
      try {
        if (el.isConnected) el.remove();
      } catch (e) {
        console.error("[next][buttonsEdit] failed to remove textarea", e);
      }
    });
    updateHandles();
  }

  function openButtonsEditorForNode(nodeId: string, attempt = 0) {
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "buttons") return;
    if (activeTableEditor) closeTableEditor();
    if (activeTextEditor) closeTextEditor({ commit: true });
    if (activeButtonsEditor) closeButtonsEditor({ commit: true });

    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!nodeEl) {
      if (attempt < 6) {
        requestAnimationFrame(() => openButtonsEditorForNode(nodeId, attempt + 1));
        return;
      }
      throw new Error(`[next] missing node element for buttons edit: ${nodeId}`);
    }

    const labels = Array.isArray(node.templates) ? node.templates : Array.isArray(node.labels) ? node.labels : [];
    const actions = Array.isArray(node.actions) ? node.actions : [];
    const rows: string[] = [];
    const count = Math.max(labels.length, actions.length);
    for (let i = 0; i < count; i += 1) {
      const label = labels[i] ?? "";
      const action = actions[i] ?? "";
      rows.push(`${label}:${action}`);
    }
    const ta = document.createElement("textarea");
    ta.className = "text-editor";
    ta.value = rows.join("\n");
    ta.spellcheck = false;
    ta.wrap = "soft";
    ta.rows = Math.max(2, rows.length + 1);
    ta.style.position = "absolute";
    ta.style.zIndex = "2000";
    overlay.appendChild(ta);
    activeButtonsEditor = {
      nodeId,
      el: ta,
      prevText: ta.value,
      startSnapshot: snapshotNow(),
    };
    relayoutActiveButtonsEditor();
    ta.addEventListener("input", () => relayoutActiveButtonsEditor());
    ta.addEventListener("blur", () => closeButtonsEditor({ commit: true }), { once: true });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeButtonsEditor({ commit: false });
      }
    });
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
    });
  }

  const parseTableCandidate = (value: string) => {
    const lines = String(value ?? "")
      .split("\n")
      .map((line) => line.trim());
    const dataLines = lines.filter((line) => line && !line.startsWith("#"));
    if (!dataLines.length) return null;
    const semicolonCounts = dataLines.map((line) => (line.match(/;/g) || []).length);
    const totalSemis = semicolonCounts.reduce((sum, count) => sum + count, 0);
    const linesWithSemis = dataLines.filter((line) => line.includes(";")).length;
    if (totalSemis < 2 && !(linesWithSemis >= 1 && dataLines.length >= 2)) return null;
    const rows = dataLines.map((line) => line.split(";").map((cell) => cell.trim()));
    const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (cols < 2) return null;
    const cells = rows.map((row) => {
      const padded = row.slice();
      while (padded.length < cols) padded.push("");
      return padded;
    });
    return { rows: cells.length, cols, cells };
  };

  function openTextEditorForNode(nodeId: string, opts?: { selectAll?: boolean }, attempt = 0) {
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    if (!node || (node.type !== "text" && node.type !== "bullets")) return;
    if (activeTableEditor) closeTableEditor();
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
      const templateRaw = String((node as any).template ?? node.rawText ?? "");
      const items = Array.isArray(node.items) ? node.items : parseBulletEditorValue(templateRaw).items;
      const spec = String(node.bullets ?? "1.");
      ta.value = renderBulletEditorValue(items, spec);
    } else {
      ta.value = String((node as any).template ?? node.text ?? "");
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
        applyNodeAlign(store, nodeId, key, {
          activeEditor: activeTextEditor,
          persistViewIdForNode,
          docForNode,
          bgPayload,
          persistText,
          persistBullets,
        });
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
      currentAlign: align,
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
        const tableCandidate = parseTableCandidate(ta.value);
        if (tableCandidate) {
          const snapshot = activeTextEditor?.startSnapshot ?? snapshotNow();
          pushUndo(snapshot);
          n.type = "table";
          n.cells = tableCandidate.cells;
          n.rows = tableCandidate.rows;
          n.cols = tableCandidate.cols;
          n.editable = true;
          delete n.text;
          delete n.template;
          delete n.rawText;
          delete n.items;
          delete n.bullets;
          const groupId = n.groupId ? String(n.groupId) : null;
          const doc = docForNode(n);
          const persistViewId = persistViewIdForNode(n, store.activeViewId);
          void (async () => {
            await persistDelete({ ids: [String(n.id)], doc, groupId });
            await persistGeometry({
              id: String(n.id),
              viewId: persistViewId,
              transform: n.transform,
              fontPx: (n as any).fontPx,
              doc,
              space: groupId ? "group" : n.space,
              groupId,
            });
            await persistTable({
              id: String(n.id),
              viewId: persistViewId,
              cells: tableCandidate.cells,
              rows: tableCandidate.rows,
              cols: tableCandidate.cols,
              editable: true,
              doc,
              space: groupId ? "group" : n.space,
              ...bgPayload(n),
              groupId,
            });
          })();
          closeTextEditor({ commit: false });
          openTableEditorForNode(nodeId);
          return;
        }
        n.text = ta.value; // live preview as you type
      } else if (n.type === "bullets") {
        const startSel = ta.selectionStart ?? 0;
        const endSel = ta.selectionEnd ?? 0;
        // Keep bullet mode while editing markers; don't auto-convert to text.
        const startRaw = mapCaretToRaw(ta.value, startSel);
        const endRaw = mapCaretToRaw(ta.value, endSel);
        const value = ta.value;
        const lines = value.split("\n");
        let lineIdx = 0;
        let acc = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          const lineEnd = acc + line.length;
          if (startSel <= lineEnd) {
            lineIdx = i;
            break;
          }
          acc = lineEnd + 1;
        }
        const line = lines[lineIdx] ?? "";
        const content = line.replace(/^[\t ]+/, "");
        const raw = stripBulletMarker(content);
        const markerLen = content.length - raw.length;
        const indentChars = line.length - content.length;
        const caretInMarker = startSel <= acc + indentChars + markerLen;
        const parsed = parseBulletEditorValue(value);
        if (caretInMarker) {
          const derivedSpec = updateBulletSpecFromLines(line, n.bullets);
          if (derivedSpec) n.bullets = derivedSpec;
          else n.bullets = ".";
        } else if (!n.bullets && parsed.spec) {
          n.bullets = parsed.spec;
        }
        n.rawText = parsed.rawText;
        n.items = parsed.items;
        const hasMarkers = value
          .split("\n")
          .some((line) => line.trim() && !isElementLine(line) && !!bulletMarkerForLine(line));
        if (!hasMarkers) {
          n.type = "text";
          n.text = value;
          delete n.rawText;
          delete n.items;
          delete n.bullets;
          return;
        }
        const display = renderBulletEditorValue(parsed.items, n.bullets || parsed.spec || "1.");
        if (display !== ta.value) {
          ta.value = display;
          let nextStart = mapRawToCaret(display, startRaw);
          let nextEnd = mapRawToCaret(display, endRaw);
          if (caretInMarker && markerLen > 0 && !bulletMarkerForLine(content)) {
            nextStart = Math.max(0, nextStart - 1);
            nextEnd = Math.max(0, nextEnd - 1);
          }
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
        if (n && n.type === "text") {
          const value = ta.value;
          const start = ta.selectionStart ?? 0;
          const lineIdx = value.slice(0, start).split("\n").length - 1;
          const current = (value.split("\n")[lineIdx] ?? "").trim();
          const bulletSpec = bulletSpecForLine(current);
          if (bulletSpec) {
            e.preventDefault();
            const parsed = parseBulletEditorValue(value);
            n.type = "bullets";
            const derivedSpec = updateBulletSpecFromLines(value, undefined);
            n.bullets = mergeBulletSpec(undefined, derivedSpec ?? parsed.spec ?? bulletSpec) || bulletSpec;
            n.rawText = parsed.rawText;
            n.items = parsed.items;
            ta.value = renderBulletEditorValue(parsed.items, n.bullets || "1.");
            const nextStart = mapRawToCaret(ta.value, mapCaretToRaw(value, start));
            ta.setSelectionRange(nextStart, nextStart);
            // Now that we are bullets, fall through to insert the next marker.
          }
        }
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

  function openTableEditorForNode(nodeId: string, opts?: { seed?: string }, attempt = 0) {
    if (store.mode !== "live") return;
    const node: any = store.model.nodes.find((n) => n.id === nodeId);
    const allowPressureTable = node && String(node.pressureRole ?? "") === "table";
    if (!node || node.type !== "table" || (node.editable === false && !allowPressureTable)) return;
    if (activeTableEditor) closeTableEditor();
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!nodeEl) {
      if (attempt < 6) {
        requestAnimationFrame(() => openTableEditorForNode(nodeId, opts, attempt + 1));
        return;
      }
      throw new Error(`[next] missing node element for table edit: ${nodeId}`);
    }
    (nodeEl.dataset as any).editing = "1";
    activeTableEditor = { nodeId, startSnapshot: snapshotNow() };
    requestAnimationFrame(() => {
      const cell = nodeEl.querySelector<HTMLElement>(".table-cell");
      if (!cell) return;
      if (opts?.seed) {
        const existing = String(cell.textContent ?? "");
        cell.textContent = existing ? `${existing}${opts.seed}` : opts.seed;
        window.dispatchEvent(
          new CustomEvent("ip-table-edit", {
            detail: {
              id: nodeId,
              row: Number(cell.dataset.row ?? 1),
              col: Number(cell.dataset.col ?? 1),
              value: String(cell.textContent ?? ""),
            },
          })
        );
      }
      cell.focus();
    });
  }

  function closeTableEditor() {
    if (!activeTableEditor) return;
    const nodeId = activeTableEditor.nodeId;
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (nodeEl) (nodeEl.dataset as any).editing = "0";
    activeTableEditor = null;
  }

  // Stage sizing relies on the stage element; overlay handles interaction.
  overlay.addEventListener("pointerenter", onOverlayPointerEnter);
  overlay.addEventListener("pointerleave", onOverlayPointerLeave);
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("contextmenu", (e) => {
    if (store.mode === "live") {
      clearSelection();
      e.preventDefault();
      return;
    }
    if (performance.now() - lastMarqueeSelectAt < 500) {
      e.preventDefault();
      return;
    }
    const rightHit = pickNodeNearClientPoint(e.clientX, e.clientY);
    const selectedSet = new Set(store.selectedIds ?? []);
    const clickedSelected = rightHit ? selectedSet.has(rightHit) || store.selectedId === rightHit : false;
    if (!clickedSelected) {
      clearSelection();
      e.preventDefault();
    }
  });
  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("dragover", onDragOver);
  overlay.addEventListener("drop", onDrop);
  window.addEventListener("dragover", onWindowDragOver as any, { capture: true });
  window.addEventListener("drop", onWindowDrop as any, { capture: true });
  window.addEventListener("ip-table-edit", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const id = String(detail?.id ?? "");
    const row = Number(detail?.row ?? 0);
    const col = Number(detail?.col ?? 0);
    const value = String(detail?.value ?? "");
    if (!id || !row || !col) return;
    const node: any = store.model.nodes.find((n) => String(n.id) === id);
    if (!node || node.type !== "table") return;
    applyTableCellUpdate(node, row, col, value);
    const doc = docForNode(node);
    const groupId = node.groupId ? String(node.groupId) : null;
    const viewId = groupId ? "group" : node.space === "screen" ? "screen_main" : store.activeViewId;
    if (store.mode !== "live") {
      void persistTable({
        id,
        viewId,
        cells: Array.isArray(node.cells) ? node.cells : [],
        rows: Number(node.rows ?? undefined),
        cols: Number(node.cols ?? undefined),
        editable: Boolean(node.editable),
        hHeader: Array.isArray(node.hHeader) ? node.hHeader : undefined,
        vHeader: Array.isArray(node.vHeader) ? node.vHeader : undefined,
        hStyle: Array.isArray(node.hStyle) ? node.hStyle : undefined,
        color: node.color,
        doc,
        space: groupId ? "group" : node.space,
        groupId,
        ...bgPayload(node),
      }).catch(() => {});
    }
    if (store.mode !== "live") {
      void publishTableUpdate({ id, row, col, value }).catch(() => {});
    }
  });
  window.addEventListener("ip-table-update", (ev: Event) => {
    sessionRuntime.applyTableRuntimeUpdate((ev as CustomEvent).detail);
  });
  window.addEventListener("ip-node-patch", (ev: Event) => {
    sessionRuntime.applyNodePatch((ev as CustomEvent).detail);
  });
  const onPaste = async (ev: ClipboardEvent) => {
    const target = ev.target as HTMLElement | null;
    const tableCell = target?.closest?.(".table-cell");
    const tableNode = tableCell?.closest?.(".node") as HTMLElement | null;
    const tableEditing = tableNode?.dataset?.nodeType === "table" && tableNode.dataset.editing === "1";
    if (activeTextEditor || activeButtonsEditor || activeTableEditor || target?.closest?.(".text-editor") || (tableCell && tableEditing)) return;
    const items = Array.from(ev.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    const text = (ev.clipboardData?.getData("text/plain") ?? "").trim();
    const r = stage.getBoundingClientRect();
    const cx = lastClient?.x ?? r.left + r.width / 2;
    const cy = lastClient?.y ?? r.top + r.height / 2;
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (!file) return;
      ev.preventDefault();
      try {
        const uploaded = await uploadImageFile(file);
        const aspect = await loadImageAspect(uploaded.src);
        pushUndo(snapshotNow());
        createImageNodeAtClientPoint(cx, cy, { src: uploaded.src, filename: uploaded.filename, aspect });
      } catch (err) {
        console.error("[next][paste] failed to paste image", err);
      }
      return;
    }
    if (text) {
      ev.preventDefault();
      pushUndo(snapshotNow());
      const id = createTextNodeAtClientPoint(cx, cy, text);
      pendingTextEdit = { nodeId: id };
      openTextEditorForNode(id, { selectAll: false });
      return;
    }
    if (internalClipboard) {
      ev.preventDefault();
      pasteInternalAtClientPoint(cx, cy);
    }
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    // If focus is inside the textarea editor, NEVER treat Space as pan etc.
    const target = ev.target as HTMLElement | null;
    const tableCell = target?.closest?.(".table-cell");
    const tableNode = tableCell?.closest?.(".node") as HTMLElement | null;
    const tableEditing = tableNode?.dataset?.nodeType === "table" && tableNode.dataset.editing === "1";
    if (activeTextEditor || activeButtonsEditor || activeTableEditor || target?.closest?.(".text-editor") || (tableCell && tableEditing)) return;

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

    const modSelectAll = ev.ctrlKey || ev.metaKey;
    if (modSelectAll && (ev.key === "a" || ev.code === "KeyA")) {
      ev.preventDefault();
      const view = activeViewRef();
      const screenId = (view as any).screenId ?? "screen_main";
      const viewId = view.id;
      const ids = store.model.nodes
        .filter((n: any) => isNodeInActiveGroup(n))
        .filter((n: any) => (store.mode === "live" ? n.layer === "live" : n.layer !== "live"))
        .filter((n: any) => {
          if (store.mode === "screen-edit") {
            return n.space === "screen" && String(n.screenId ?? "screen_main") === String(screenId);
          }
          if (n.space === "screen") {
            return String(n.screenId ?? "screen_main") === String(screenId);
          }
          return isNodeForView(n, viewId, screenId);
        })
        .map((n: any) => String(n.id));
      store.selectedIds = ids;
      store.selectedId = ids[0] ?? null;
      return;
    }

    if (store.mode === "live") {
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        deleteSelectedNodes();
        return;
      }
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
        if (queueLiveActionAfterReset(ev.key === "ArrowRight" ? "cue-forward" : "cue-back", idx, now)) {
          return;
        }
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
      // Type-to-create notes in live mode.
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) {
        const ch = ev.key;
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
      if (!ev.ctrlKey && !ev.metaKey) return;
    }

    // Type-to-edit: typing while a table is selected opens inline table editing.
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) {
      const selected = store.selectedId
        ? (store.model.nodes.find((n: any) => String(n.id) === String(store.selectedId)) as any)
        : null;
      const ch = ev.key;
      if (selected?.type === "table" && ch.length === 1 && ch !== " " && ch !== "\t") {
        openTableEditorForNode(String(selected.id), { seed: ch });
        ev.preventDefault();
        return;
      }
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
      ev.preventDefault();
      deleteSelectedNodes();
      return;
    }
    if (!mod) return;

    const k = ev.key.toLowerCase();
    const code = String(ev.code ?? "");
    const isUndoKey = k === "z" || code === "KeyZ";
    const isRedoKey = k === "y" || code === "KeyY";

    if (k === "g" || code === "KeyG") {
      ev.preventDefault();
      if (canUngroupSelected()) {
        ungroupSelectedGroup();
      } else if ((store.selectedIds?.length ?? 0) > 1) {
        createGroupFromSelection();
      }
      return;
    }

    // Undo / redo
    if (isUndoKey && !ev.shiftKey) {
      ev.preventDefault();
      const snap = undoStack.pop();
      if (!snap) return;
      const prevMeta = new Map(
        (store.model.nodes ?? []).map((n: any) => [
          String(n?.id ?? ""),
          { doc: docForNode(n), groupId: n?.groupId ? String(n.groupId) : null },
        ])
      );
      redoStack.push(snapshotNow());
      restoreSnapshot(snap);
      persistModelToFiles(prevMeta);
      return;
    }
    if (isRedoKey || (isUndoKey && ev.shiftKey)) {
      ev.preventDefault();
      const snap = redoStack.pop();
      if (!snap) return;
      const prevMeta = new Map(
        (store.model.nodes ?? []).map((n: any) => [
          String(n?.id ?? ""),
          { doc: docForNode(n), groupId: n?.groupId ? String(n.groupId) : null },
        ])
      );
      undoStack.push(snapshotNow());
      restoreSnapshot(snap);
      persistModelToFiles(prevMeta);
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
    const anchorForNode = (n: any) => {
      if (n?.type === "arrow") {
        const start = n.start ?? { x: 0, y: 0 };
        const end = n.end ?? { x: 0, y: 0 };
        return { x: (Number(start.x) + Number(end.x)) / 2, y: (Number(start.y) + Number(end.y)) / 2 };
      }
      return { x: Number(n?.transform?.x) || 0, y: Number(n?.transform?.y) || 0 };
    };
    const primaryAnchor = anchorForNode(primary);
    const px = primaryAnchor.x;
    const py = primaryAnchor.y;

      const nodes: ClipboardNode[] = ids
        .map((id) => store.model.nodes.find((n) => n.id === id) as any)
        .filter((n) => !!n)
        .map((n) => {
          const anchor = anchorForNode(n);
          return { node: cloneModel(n), relAnchor: { dx: anchor.x - px, dy: anchor.y - py } };
        });
      internalClipboard = { nodes, primaryType: String(primary.type ?? "n") };
      // Reset paste nudge tracking when making a new copy.
      lastPasteClient = null;
      pasteNudgeSteps = 0;
      if (k === "x") {
        pushUndo(snapshotNow());
        const expanded = new Set(ids.map(String));
        for (const id of ids) {
          const node = store.model.nodes.find((n: any) => String(n.id) === String(id)) as any;
          if (node?.type === "group") {
            for (const child of groupChildren(node.id)) {
              expanded.add(String(child.id));
            }
          }
        }
        const deletesByDoc: Record<"presentation" | "notes", { root: string[]; groups: Map<string, string[]> }> = {
          presentation: { root: [], groups: new Map() },
          notes: { root: [], groups: new Map() },
        };
        for (const id of expanded) {
          const node = store.model.nodes.find((n: any) => String(n.id) === String(id)) as any;
          if (!node) continue;
          const doc = docForNode(node);
          const gid = node.groupId ? String(node.groupId) : null;
          if (gid) {
            if (!deletesByDoc[doc].groups.has(gid)) deletesByDoc[doc].groups.set(gid, []);
            deletesByDoc[doc].groups.get(gid)!.push(String(id));
          } else {
            deletesByDoc[doc].root.push(String(id));
          }
        }
        for (const doc of ["presentation", "notes"] as const) {
          if (deletesByDoc[doc].root.length) void persistDelete({ ids: deletesByDoc[doc].root, doc });
          for (const [gid, delIds] of deletesByDoc[doc].groups.entries()) {
            if (delIds.length) void persistDelete({ ids: delIds, doc, groupId: gid });
          }
        }
        store.model.nodes = store.model.nodes.filter((n) => !expanded.has(String((n as any).id)));
        clearSelection();
      }
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
  window.addEventListener("paste", onPaste, { capture: true });
  // Frame hook: call this once per render frame (after renderScene) so any DOM size
  // changes are already applied, avoiding "floating" editor/handles.
  const frame = () => {
    if (store.cameraOverride && store.mode !== "live") {
      const z = Number(store.cameraOverride.zoom);
      if (!Number.isFinite(z) || z <= 0) {
        store.cameraOverride = null;
        store.cameraTween = null;
      }
    }
    if (store.mode !== lastMode) {
      if (store.mode === "live") {
        if (activeTextEditor) closeTextEditor({ commit: true });
        if (activeButtonsEditor) closeButtonsEditor({ commit: true });
        if (activeTableEditor) closeTableEditor();
        clearSelection();
        owner = null;
        overlay.style.cursor = "";
        marquee.style.display = "none";
        if (preLiveViewId == null) {
          preLiveViewId = store.activeViewId;
          preLiveCameraOverride = store.cameraOverride ? { ...store.cameraOverride } : null;
          preLiveCameraTween = store.cameraTween ? { ...store.cameraTween, segments: [...store.cameraTween.segments] } : null;
        }
        const currentCam = cameraForEdit();
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
        const liveViewId = best?.id ?? (store.activeViewId || store.model.views[0]?.id);
        initLiveView(liveViewId, false, true);
      } else if (lastMode === "live") {
        if (preLiveViewId != null) {
          store.activeViewId = preLiveViewId;
          persistActiveViewId(store);
          store.cameraOverride = preLiveCameraOverride;
          store.cameraTween = preLiveCameraTween;
          store.transitionFromViewId = null;
          store.transitionToViewId = null;
          preLiveViewId = null;
          preLiveCameraOverride = null;
          preLiveCameraTween = null;
        }
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
    if (store.mode === "live" && pendingLiveAction) {
      const now = performance.now();
      if (now >= pendingLiveAction.runAtMs && store.activeViewId === pendingLiveAction.viewId) {
        const v = activeView(store);
        const cues = viewCues(v.id);
        const idx = pendingLiveAction.index;
        if (pendingLiveAction.kind === "cue-forward") {
          if (idx < cues.length) {
            const batch = runCueBatch(cues, idx, now);
            liveCueIndexByView.set(v.id, batch.nextIdx);
            if (batch.nextIdx < cues.length && cues[batch.nextIdx]!.when === "after") {
              pendingAuto = { viewId: v.id, index: batch.nextIdx, runAtMs: now + batch.batchDuration };
            } else {
              pendingAuto = null;
            }
          }
        } else {
          if (idx > 0) {
            let start = idx - 1;
            while (start > 0 && cues[start]!.when === "same") start -= 1;
            let end = start;
            while (end + 1 < cues.length && cues[end + 1]!.when === "same") end += 1;
            resetViewToCueIndex(cues, start);
            liveCueIndexByView.set(v.id, start);
          }
        }
        pendingLiveAction = null;
      }
    }
    updateHandles();
    relayoutActiveTextEditor();
    relayoutActiveButtonsEditor();
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
    window.removeEventListener("paste", onPaste as any, { capture: true } as any);
    window.removeEventListener("dragover", onWindowDragOver as any, { capture: true } as any);
    window.removeEventListener("drop", onWindowDrop as any, { capture: true } as any);
    void stage;
  };
  return { frame, detach };
}
