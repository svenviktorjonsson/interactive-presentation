import type { PresentationModel } from "@interactive/content";
import { Engine, screenToWorld, worldToScreen } from "@interactive/engine";
import { DEBUG_ANIM, dlog, BACKEND } from "./config";
import { fetchModel, preloadImageAssets, saveModel } from "./api/presentation";
import { uploadImageToMedia, loadImageSize } from "./api/media";
import { hydrateQrImages } from "./features/qr";
import { Runtime, createGraphPlugin, createTimerPlugin, createChoicesPlugin, createSoundPlugin, createTablePlugin, ensureGraphCompositeLayer, renderGraphCompositeArrows, renderGraphCompositeTexts, layoutGraphCompositeTexts, ensureTimerCompositeLayer, renderTimerCompositeArrows, renderTimerCompositeButtons, renderTimerCompositeTexts, layoutTimerCompositeTexts, ensureSoundCompositeLayer, renderSoundCompositeArrows, renderSoundCompositeTexts, renderSoundCompositeButtons, layoutSoundCompositeTexts, hydrateTextMath, renderTextToElement, renderTextWithKatexToHtml, drawGrid, drawTicksAndLabels, fixedTicks, mergeTickAnchors, niceTicks, prepareCanvas } from "@interactive/runtime";
import { buildShell } from "./ui/shell";
import { createSegmentPlacementController } from "./editor/tools/segmentPlacement";
import { createInteractionStateMachine } from "./editor/interactions/interactionStateMachine";
import { createLineGraphDrag } from "./editor/interactions/lineGraphDrag";
import { createGroupEditController } from "./editor/groupEdit";
import { createSelectionController } from "./editor/selection";
import { createCursorController } from "./editor/cursor";
import { createCompositeHitTest } from "./editor/composites/hitTest";
import { openNodeEditorModal } from "./editor/modalEditor";
import { createHistoryController } from "./editor/history";
import { attachKeyboardShortcuts } from "./editor/keyboard";
import { attachCompositeEditController } from "./editor/compositeEdit";

const cloneModel = (m: PresentationModel): PresentationModel => JSON.parse(JSON.stringify(m)) as PresentationModel;
// Screen edit state (shared across handlers)
let screenEditMode = false;
let screenDimmedEls: HTMLElement[] = [];
let lastContextScreen: { x: number; y: number } | null = null;
let enterScreenEdit: () => void = () => {};
let exitScreenEdit: () => void = () => {};
// Isolate-mode transition hooks (set by attachEditor when active).
let exitCompositeEdit: () => void = () => {};
let isCompositeEditing: () => boolean = () => false;
let exitGroupEdit: () => void = () => {};
let isGroupEditing: () => boolean = () => false;

// Table editing (single-click, Excel-like)
// Presentation started state: controls whether polling for timer/choices happens.
// Only true in Live mode; false in Edit mode. Defaults to false on app load.
let presentationStarted = false;
let __soundState: any = null;
let __soundStreamStarted = false;

type PlotRanges = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Whether the user has interacted (pan/zoom) */
  user: boolean;
};

const __plotRanges = new Map<string, PlotRanges>();
let __plotDrag:
  | {
      key: string;
      kind: "timer" | "sound-spectrum" | "sound-pressure";
      xMin: number;
      xMax: number;
      yMin: number;
      yMax: number;
      startClientX: number;
      startClientY: number;
      rect: DOMRect;
    }
  | null = null;

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };
// Canonical composite layout: sound should match timer "base class" positions.
const CANON_COMPOSITE_Y_LABEL = { x: -0.17038335565784135, y: 0.11719580843509136, anchor: "centerCenter", align: "center" };
const CANON_COMPOSITE_STATS = { x: 0.5028738858079436, y: 0.055646919385237144, anchor: "topCenter", align: "center" };

function _plotFracsForEl(el: HTMLElement) {
  const lf = Number(el.dataset.plotLeftF ?? "NaN");
  const rf = Number(el.dataset.plotRightF ?? "NaN");
  const tf = Number(el.dataset.plotTopF ?? "NaN");
  const bf = Number(el.dataset.plotBottomF ?? "NaN");
  if ([lf, rf, tf, bf].every((v) => Number.isFinite(v))) {
    // Clamp lightly to avoid hard breakage if user drags outside.
    const leftF = Math.max(-2, Math.min(3, lf));
    const rightF = Math.max(-2, Math.min(3, rf));
    const topF = Math.max(-2, Math.min(3, tf));
    const bottomF = Math.max(-2, Math.min(3, bf));
    return { leftF, rightF, topF, bottomF };
  }
  return PLOT_FRACS;
}

function _pickSmallestCompositeSub(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  opts?: { activeCompPath?: string | null; excludeEl?: HTMLElement | null }
) {
  // Search across the whole composite root, not just a specific layer:
  // - allows selecting nested comp-subs (e.g. wheel labels)
  // - allows selecting fully covered elements (smallest bbox wins)
  const subs = Array.from(root.querySelectorAll<HTMLElement>(".comp-sub"));
  // IMPORTANT: plot-arrow hitboxes are helper overlays; they must NEVER steal selection
  // from normal editable elements (text/buttons). If nothing else is under the cursor,
  // then we can fall back to arrows.
  let bestNormal: { el: HTMLElement; area: number; z: number; order: number } | null = null;
  let bestArrow: { el: HTMLElement; area: number; z: number; order: number } | null = null;
  const rootId = String((root as any)?.dataset?.nodeId ?? "");
  for (let i = 0; i < subs.length; i++) {
    const el = subs[i];
    if (opts?.excludeEl && el === opts.excludeEl) continue;
    const activePath = String(opts?.activeCompPath ?? "");
    if (activePath) {
      const p = String(el.dataset.compPath ?? "");
      // In a nested composite level, ONLY allow selecting elements whose compPath matches that level.
      if (p !== activePath) {
        // Exception: axis arrow hitboxes (plot-arrow) are authored in the root `elements.pr`
        // but live geometrically in the plot coordinate system. Allow selecting them while
        // editing the plot level as well.
        const kind0 = String(el.dataset.kind ?? "");
        const isPlotArrow = kind0 === "plot-arrow";
        const isPlotLevel = !!rootId && activePath === `${rootId}/plot`;
        const isRootPath = !!rootId && p === rootId;
        if (!(isPlotArrow && isPlotLevel && isRootPath)) continue;
      }
    }
    // Hard-disable plot region overlays: they are internal helpers and should never be selectable.
    // (Older DOM could be missing dataset.kind, so also match by class/subId.)
    const subId = String(el.dataset.subId ?? "");
    const kind = String(el.dataset.kind ?? "");
    if (
      kind === "plot-region" ||
      subId === "plot" ||
      el.classList.contains("timer-sub-plot") ||
      el.classList.contains("sound-sub-plot")
    ) {
      continue;
    }
    // Ignore hidden nodes.
    // NOTE: `offsetParent` is unreliable for some positioned elements; prefer computed styles + bbox.
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || "1") <= 0) continue;
    const r = el.getBoundingClientRect();
    if (!(clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom)) continue;
    if (!(r.width > 0.5 && r.height > 0.5)) continue;
    const area = Math.max(1e-6, r.width * r.height);
    const zRaw = window.getComputedStyle(el).zIndex;
    const z = zRaw === "auto" ? 0 : Number(zRaw) || 0;
    const cand = { el, area, z, order: i };
    const isArrow = kind === "plot-arrow";
    const best = isArrow ? bestArrow : bestNormal;
    if (!best) {
      if (isArrow) bestArrow = cand;
      else bestNormal = cand;
    } else if (cand.area < best.area - 1e-6) {
      if (isArrow) bestArrow = cand;
      else bestNormal = cand;
    } else if (Math.abs(cand.area - best.area) <= 1e-6) {
      if (cand.z > best.z) {
        if (isArrow) bestArrow = cand;
        else bestNormal = cand;
      } else if (cand.z === best.z && cand.order > best.order) {
        if (isArrow) bestArrow = cand;
        else bestNormal = cand; // later in DOM = on top
      }
    }
  }
  return bestNormal?.el ?? bestArrow?.el ?? null;
}

function _plotRectCss(nodeEl: HTMLElement) {
  const r = nodeEl.getBoundingClientRect();
  const fr = _plotFracsForEl(nodeEl);
  const ox = r.left + fr.leftF * r.width;
  const oy = r.top + fr.bottomF * r.height;
  const xLen = (fr.rightF - fr.leftF) * r.width;
  const yLen = (fr.bottomF - fr.topF) * r.height;
  const top = r.top + fr.topF * r.height;
  const bottom = r.top + fr.bottomF * r.height;
  return { r, ox, oy, xLen, yLen, top, bottom };
}

function _isInsidePlot(nodeEl: HTMLElement, clientX: number, clientY: number) {
  const { ox, xLen, top, bottom } = _plotRectCss(nodeEl);
  return clientX >= ox && clientX <= ox + xLen && clientY >= top && clientY <= bottom;
}

function _clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type SoundState = {
  enabled: boolean;
  computeSpectrum?: boolean;
  computePressure?: boolean;
  seq: number;
  sampleRateHz: number;
  windowMs: number;
  pressure10ms: number[];
  spectrum: { freqHz: number[]; magDb: number[] };
  error?: string | null;
  serverTimeMs: number;
};

function ensureSoundStateDefaults(prev: SoundState | null): SoundState {
  return {
    enabled: prev?.enabled ?? false,
    computeSpectrum: prev?.computeSpectrum ?? true,
    computePressure: prev?.computePressure ?? false,
    seq: prev?.seq ?? 0,
    sampleRateHz: prev?.sampleRateHz ?? 48_000,
    windowMs: prev?.windowMs ?? 10,
    pressure10ms: prev?.pressure10ms ?? [],
    spectrum: prev?.spectrum ?? { freqHz: [], magDb: [] },
    error: prev?.error ?? null,
    serverTimeMs: prev?.serverTimeMs ?? 0,
  };
}

async function fetchSoundState(): Promise<SoundState | null> {
  try {
    const res = await fetch(`${BACKEND}/api/sound/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SoundState;
  } catch {
    return null;
  }
}

function runPauseResumeLabel(isRunning: boolean, hasRunOnce: boolean) {
  if (isRunning) return "Pause";
  return hasRunOnce ? "Resume" : "Run";
}

function _getHasRunOnce(el: HTMLElement) {
  return String(el.dataset.hasRunOnce ?? "0") === "1";
}

function _setHasRunOnce(el: HTMLElement, v: boolean) {
  el.dataset.hasRunOnce = v ? "1" : "0";
}

function _parseChoicesBulletsSpec(elementsText: string): { type?: string; items: string[] } {
  // Read bullets[...] spec + its content block from the choices root elementsText.
  // Example:
  //   bullets[name=bullets,type=A]:
  //   Biologi
  //   Kemi
  const out: { type?: string; items: string[] } = { items: [] };
  const lines = String(elementsText ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln0 = lines[i] ?? "";
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^bullets\[(?<params>[^\]]+)\](?<colon>\s*:)?\s*$/);
    if (!m?.groups?.params) continue;
    const params = _parseInlineParams(m.groups.params);
    const name = String(params.name ?? "").trim();
    if (name && name !== "bullets") continue;
    const t = String(params.type ?? params.bullets ?? "").trim();
    if (t) out.type = t;

    if (m.groups.colon) {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j] ?? "";
        const s = raw.trim();
        if (!s || s.startsWith("#")) continue;
        // Stop at next element header.
        if (/^[a-zA-Z_]\w*\[/.test(s)) break;
        items.push(s);
      }
      out.items = items;
    }
    break;
  }
  return out;
}

function _parseChoicesWheelSpec(elementsText: string): { otherLabel?: string; minLevel?: number; textInsideLimit?: number } {
  const out: { otherLabel?: string; minLevel?: number; textInsideLimit?: number } = {};
  for (const ln0 of String(elementsText ?? "").split(/\r?\n/)) {
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^wheel\[(?<params>[^\]]+)\]\s*$/);
    if (!m?.groups?.params) continue;
    const params = _parseInlineParams(m.groups.params);
    const name = String(params.name ?? "").trim();
    if (name && name !== "wheel") continue;
    const ol = String(params.otherLabel ?? "").trim();
    if (ol) out.otherLabel = ol;
    const min = Number(params.minLevel ?? params.includeLimit ?? params.minPct ?? params.min ?? NaN);
    if (Number.isFinite(min)) out.minLevel = min;
    const ti = Number(params.textInsideLimit ?? params.minInsidePct ?? params.minInside ?? NaN);
    if (Number.isFinite(ti)) out.textInsideLimit = ti;
    break;
  }
  return out;
}

function _parseWheelElementsPr(elementsPr: string): { templates: Record<string, string>; colors: Record<string, string> } {
  const templates: Record<string, string> = {};
  const colors: Record<string, string> = {};
  for (const ln0 of String(elementsPr ?? "").split(/\r?\n/)) {
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;
    const mt = ln.match(/^text\[(?<params>[^\]]+)\]\s*:\s*(?<content>.*)$/);
    if (!mt?.groups?.params) continue;
    const params = _parseInlineParams(mt.groups.params);
    const id = String(params.name ?? "").trim();
    if (!id) continue;
    templates[id] = mt.groups.content ?? "";
    const col = String(params.color ?? "").trim();
    if (col) colors[id] = col;
  }
  return { templates, colors };
}

function ensureChoicesWheelLayer(engine: Engine, pollId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === pollId) as any;
  const el = engine.getNodeElement(pollId);
  if (!node || !el) return null;
  const wheel = el.querySelector<HTMLElement>(".choices-wheel");
  if (!wheel) return null;
  // Hard guarantee: the wheel element fills its parent wheelGroup box.
  wheel.style.position = "absolute";
  wheel.style.inset = "0";

  let layer = wheel.querySelector<HTMLElement>(":scope > .choices-wheel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "choices-wheel-layer";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    wheel.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("choices-wheel-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);
  }

  const elementsPr = String(node.wheelElementsPr ?? "");
  const prev = String((layer as any).__elementsPr ?? "");
  if (elementsPr !== prev) {
    (layer as any).__elementsPr = elementsPr;
    const parsed = _parseWheelElementsPr(elementsPr);
    (layer as any).__templates = parsed.templates;
    (layer as any).__colors = parsed.colors;
  }

  // Geoms for wheel internals are stored in compositeGeometriesByPath["wheel"].
  const geoms: Record<string, any> = (node.compositeGeometriesByPath?.wheel ?? {}) as any;
  (layer as any).__wheelGeoms = geoms;

  return layer;
}

function renderChoicesWheelOverlay(
  engine: Engine,
  pollId: string,
  slices: Array<{ id: string; color?: string; votes: number; percent: number; label: string }>,
  opts: { totalVotes: number; otherLabel: string; textInsideLimit: number }
) {
  if (!pollId) return;
  const layer = ensureChoicesWheelLayer(engine, pollId);
  if (!layer) return;

  const svg = layer.querySelector<SVGSVGElement>(":scope > .choices-wheel-svg");
  if (!svg) return;

  const templates: Record<string, string> = (layer as any).__templates ?? {};
  const geoms: Record<string, any> = (layer as any).__wheelGeoms ?? {};

  const wheelEl = layer.parentElement as HTMLElement;
  const box = wheelEl.getBoundingClientRect();
  const fontBase = Math.max(18, box.height * 0.055);

  const textElsById = new Map<string, HTMLElement>();
  for (const t of Array.from(layer.querySelectorAll<HTMLElement>(":scope > .choices-wheel-text"))) {
    const sid = t.dataset.subId ?? "";
    if (sid) textElsById.set(sid, t);
  }

  const ensureTextEl = (sid: string) => {
    let t = textElsById.get(sid);
    if (t) return t;
    t = document.createElement("div");
    t.className = "choices-wheel-text comp-sub";
    t.dataset.subId = sid;
    t.dataset.compPath = `${pollId}/wheel`;
    t.dataset.anchor = "centerCenter";
    // Stable content child (so selection handles don't get wiped by innerHTML).
    const content = document.createElement("div");
    content.className = "choices-wheel-text-content";
    content.style.width = "100%";
    content.style.height = "100%";
    content.style.display = "grid";
    content.style.placeItems = "center";
    t.append(content);
    t.style.position = "absolute";
    t.style.pointerEvents = "none";
    t.style.userSelect = "none";
    t.style.background = "transparent";
    t.style.border = "none";
    t.style.padding = "0";
    t.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
    t.style.fontWeight = "700";
    t.style.color = "rgba(255,255,255,0.92)";
    t.style.transform = "translate(-50%, -50%)";
    layer.append(t);
    textElsById.set(sid, t);
    return t;
  };

  // Determine render order around the circle.
  const total = Math.max(0, slices.reduce((s, o) => s + Math.max(0, o.votes || 0), 0));
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

  // Hide everything by default; show only current slices.
  for (const t of Array.from(layer.querySelectorAll<HTMLElement>(":scope > .choices-wheel-text"))) {
    t.style.display = "none";
  }

  let a0 = -Math.PI / 2;
  for (const s of slices) {
    const val = Math.max(0, s.votes || 0);
    if (total <= 0 || val <= 0) continue;
    const frac = val / total;
    const a1 = a0 + frac * Math.PI * 2;
    const mid = (a0 + a1) / 2;

    const pct = Number.isFinite(s.percent) ? s.percent : frac * 100;
    const inside = Number.isFinite(opts.textInsideLimit) ? pct >= opts.textInsideLimit : true;

    const sid = String(s.id || "other");
    const t = ensureTextEl(sid);
    t.style.display = "block";

    const g = geoms[sid] ?? { x: 0, y: 0, w: 0.36, h: 0.10, rotationDeg: 0, anchor: "centerCenter", align: "center" };
    const dx = Number(g.x ?? 0);
    const dy = Number(g.y ?? 0);
    const w = Number(g.w ?? 0.36);
    const h = Number(g.h ?? 0.10);

    // Base anchor point in wheel-local normalized coords.
    // Radius is in [0..0.5] (0.5 == edge of the wheel box).
    const rInside = 0.28;
    const rOutside = 0.62;
    const baseR = inside ? rInside : rOutside;
    const baseX = 0.5 + Math.cos(mid) * baseR;
    const baseY = 0.5 + Math.sin(mid) * baseR;

    const x = baseX + dx;
    const y = baseY + dy;
    t.dataset.baseX = String(baseX);
    t.dataset.baseY = String(baseY);

    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    t.style.rotate = `${Number(g.rotationDeg ?? 0)}deg`;
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
    t.style.fontSize = `${Math.max(14, fontBase)}px`;
    t.style.lineHeight = `${Math.max(14, fontBase)}px`;
    t.style.pointerEvents = (window as any).__ip_compositeEditing ? "auto" : "none";

    const tpl = String(t.dataset.template ?? templates[sid] ?? "{{label}} ({{percent}}%)");
    t.dataset.template = tpl;
    const noVotes = !(opts.totalVotes > 0);
    const resolved = applyDataBindings(tpl, {
      label: s.label,
      percent: noVotes ? "-" : Math.round(pct),
      votes: noVotes ? "-" : s.votes,
      totalVotes: noVotes ? "-" : opts.totalVotes
    });
    const prevTxt = t.dataset.rawText ?? "";
    if (prevTxt !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope > .choices-wheel-text-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    if (!inside) {
      const rEdge = 0.46;
      const x0 = 0.5 + Math.cos(mid) * rEdge;
      const y0 = 0.5 + Math.sin(mid) * rEdge;
      lines.push({ x0, y0, x1: x, y1: y });
    }

    a0 = a1;
  }

  // Render arrows for outside labels.
  svg.replaceChildren();
  const strokeW = Math.max(2, (window.devicePixelRatio || 1) * 2.5);
  for (const ln of lines) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", `${ln.x0 * 100}%`);
    line.setAttribute("y1", `${ln.y0 * 100}%`);
    line.setAttribute("x2", `${ln.x1 * 100}%`);
    line.setAttribute("y2", `${ln.y1 * 100}%`);
    line.setAttribute("stroke", "rgba(255,255,255,0.92)");
    line.setAttribute("stroke-width", `${strokeW}`);
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  }
}

function _randn01() {
  // Box–Muller transform
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function drawSoundNode(el: HTMLElement, state: SoundState) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.sound-canvas");
  if (!canvas) return;
  // Use shared plot rect fractions (same for all graph-like nodes).
  const prep = prepareCanvas(el, canvas, _plotFracsForEl(el));
  if (!prep) return;
  const { ctx, dpr, rect: r, plot, H } = prep;
  const { ox, oy, xLen, yLen } = plot;

  const mode = (el.dataset.mode ?? "spectrum").toLowerCase();
  const col = el.dataset.color ?? "white";
  const windowS = Math.max(1, Number(el.dataset.windowS ?? "30") || 30);
  const gridOn = String(el.dataset.grid ?? "").toLowerCase() === "true";

  // Title / error
  if (state.error) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `${Math.max(10, Math.round(12 * dpr))}px system-ui, sans-serif`;
    ctx.fillText(String(state.error), ox, 0.10 * H);
    return;
  }
  // When paused, still draw the last buffers (frozen plot).

  if (mode === "pressure") {
    const ys0 = state.pressure10ms ?? [];
    const nKeep = Math.max(2, Math.min(ys0.length, Math.round(windowS * 100)));
    const ys = ys0.slice(-nKeep);
    const n = ys.length;
    // Keep a bit of headroom so it doesn't look pegged.
    // If no data yet, treat it as a normalized 0..1 axis (so ticks show immediately).
    const maxYAuto = n > 0 ? Math.max(1e-9, Math.max(...ys) * 1.05) : 1;

    const id = el.dataset.nodeId ?? "sound";
    const key = `sound:${id}:pressure`;
    const pr0 = __plotRanges.get(key);
    let xMin = pr0?.xMin ?? 0;
    let xMax = pr0?.xMax ?? windowS;
    const xSpan0 = Math.max(1e-9, xMax - xMin);
    if (xSpan0 > windowS) {
      xMin = 0;
      xMax = windowS;
    } else {
      xMin = _clamp(xMin, 0, windowS - 1e-9);
      xMax = _clamp(xMax, xMin + 1e-6, windowS);
    }
    const yMin = pr0?.yMin ?? 0;
    const yMax = pr0?.yMax ?? Math.max(1, maxYAuto);
    const xSpan = Math.max(1e-9, xMax - xMin);
    const ySpan = Math.max(1e-9, yMax - yMin);
    // Clip ALL data rendering to plot rect.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy - yLen, xLen, yLen);
    ctx.clip();

    // Time series should keep a fixed window [0..windowS] and "wrap" like an oscilloscope:
    // - before it is filled, it grows to the right (does not stretch to fill full x)
    // - once filled, new samples overwrite from left again (no sliding x-axis)
    const dtS = 0.01; // 10ms resolution
    const N = Math.max(2, Math.round(windowS / dtS));
    const seq = Number((state as any).seq ?? 0);

    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 2 * dpr);

    const drawSegment = (i0: number, i1: number, yArr: number[]) => {
      let started = false;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const yRaw = yArr[i];
        if (!Number.isFinite(yRaw)) continue;
        const xVal = i * dtS;
        // Respect current pan/zoom x-range.
        if (xVal < xMin || xVal > xMax) continue;
        const xf = (xVal - xMin) / xSpan;
        const x = ox + xf * xLen;
        const yv = (yRaw - yMin) / ySpan;
        const y = oy - yv * yLen;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) ctx.stroke();
    };

    if (ys.length < N) {
      // Not filled: plot only actual samples at their true x positions.
      if (ys.length >= 2) drawSegment(0, ys.length - 1, ys);
    } else {
      // Filled: map last N samples into a ring indexed by (seq % N).
      const ring: number[] = new Array(N).fill(Number.NaN);
      const k = Math.min(N, ys.length);
      const startPos = (((seq - k) % N) + N) % N; // ring pos of ys[0]
      for (let i = 0; i < k; i++) {
        ring[(startPos + i) % N] = ys[i];
      }
      const writePos = ((seq % N) + N) % N; // next write position; wrap point in plot
      // Draw two segments so we don't connect across the wrap discontinuity.
      if (writePos <= N - 1) drawSegment(writePos, N - 1, ring);
      if (writePos > 0) drawSegment(0, writePos - 1, ring);
    }

    // Timer-like ticks/labels
    const lineWidthPx = 2;
    const fmtS = (v: number) => String(Math.round(v * 100) / 100).replace(/\.0+$/, "");
    const user = !!pr0?.user;
    // Default behavior: show fixed "start view" ticks immediately (even before data arrives).
    // When user pans/zooms, switch to adaptive ticks based on the current view range.
    const xTickVals = user
      ? mergeTickAnchors(niceTicks(xMin, xMax, 6, [0.5, 1, 2, 5, 10, 15, 30, 60], fmtS), xMin, xMax, [0], fmtS)
      : fixedTicks(0, windowS, 1, (v) => String(Math.round(v)));
    const xTicks: Array<{ xFrac: number; label: string }> = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));

    const fmtAmp = (v: number) => {
      const s = (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "");
      return s;
    };
    const yTickVals = user
      ? mergeTickAnchors(
          niceTicks(yMin, yMax, 6, [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1], (v) => {
            const s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
            return s || "0";
          }),
          yMin,
          yMax,
          [0],
          (v) => {
            const s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
            return s || "0";
          }
        )
      : fixedTicks(0, 1, 0.1, fmtAmp);
    const yTicks: Array<{ yFrac: number; label: string }> = yTickVals.map((t) => ({ yFrac: t.frac, label: t.label }));

    if (gridOn) drawGrid(ctx, plot, dpr, xTicks, yTicks);
    ctx.restore(); // end clip
    drawTicksAndLabels({ ctx, plot, rectCss: r, dpr, lineWidthPx, xTicks, yTicks });
    return;
  }

  // spectrum
  const f = state.spectrum?.freqHz ?? [];
  const m = state.spectrum?.magDb ?? [];
  const n2 = Math.min(f.length, m.length);
  // Show up to 8kHz by default (good for speech); clamp if SR is lower.
  const maxHzAuto = Math.min(8000, Math.max(1, ...f.map((x) => Number(x) || 0)));
  const minDbAuto = -120;
  const maxDbAuto = 0;

  const id = el.dataset.nodeId ?? "sound";
  const key = `sound:${id}:spectrum`;
  const pr0 = __plotRanges.get(key);
  let xMin = pr0?.xMin ?? 0;
  let xMax = pr0?.xMax ?? maxHzAuto;
  xMin = _clamp(xMin, 0, Math.max(1e-6, maxHzAuto - 1e-9));
  xMax = _clamp(xMax, xMin + 1e-6, maxHzAuto);
  let yMin = pr0?.yMin ?? minDbAuto;
  let yMax = pr0?.yMax ?? maxDbAuto;
  yMin = _clamp(yMin, minDbAuto, maxDbAuto - 1e-6);
  yMax = _clamp(yMax, yMin + 1e-6, maxDbAuto);
  const xSpan = Math.max(1e-9, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);
  // Clip ALL data rendering to plot rect.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy - yLen, xLen, yLen);
  ctx.clip();

  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, 2 * dpr);
  if (n2 >= 2) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n2; i++) {
      const hz = f[i];
      if (hz < xMin || hz > xMax) continue;
      const t = (hz - xMin) / xSpan;
      const x = ox + t * xLen;
      const db = Math.max(yMin, Math.min(yMax, m[i]));
      const yv = (db - yMin) / ySpan;
      const y = oy - yv * yLen;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // Spectrum ticks (timer-like)
  {
    const lineWidthPx = 2;
    const xTickVals = niceTicks(xMin, xMax, 6, [50, 100, 200, 500, 1000, 2000, 4000, 8000, 16000], (v) => String(Math.round(v)));
    const xTicks: Array<{ xFrac: number; label: string }> = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
    const yTickVals = niceTicks(yMin, yMax, 6, [5, 10, 20, 30, 40, 60], (v) => String(Math.round(v)));
    const yTicks: Array<{ yFrac: number; label: string }> = yTickVals.map((t) => ({ yFrac: t.frac, label: t.label }));
    if (gridOn) drawGrid(ctx, plot, dpr, xTicks, yTicks);
    ctx.restore(); // end clip
    drawTicksAndLabels({ ctx, plot, rectCss: r, dpr, lineWidthPx, xTicks, yTicks });
  }
}

let __plotPanZoomAttached = false;
function attachPlotPanZoom(stage: HTMLElement) {
  if (__plotPanZoomAttached) return;
  __plotPanZoomAttached = true;

  const plotInfo = (nodeEl: HTMLElement) => {
    const id = nodeEl.dataset.nodeId ?? "node";
    const type = (nodeEl.dataset.nodeType ?? "").toLowerCase();
    if (type === "timer") {
      const baseMinS = Number(nodeEl.dataset.minS ?? "0");
      const baseMaxS = Number(nodeEl.dataset.maxS ?? "40");
      // Timer state is now owned by the runtime `timer` plugin, so we don't have access
      // to samples here. Use a stable default so panning/zooming still works.
      const yMaxAuto = 1;

      const key = `timer:${id}`;
      const pr0 = __plotRanges.get(key);
      return {
        key,
        kind: "timer" as const,
        bounds: { xMin: baseMinS, xMax: baseMaxS, yMin: 0, yMax: 1 },
        current: pr0 ?? { xMin: baseMinS, xMax: baseMaxS, yMin: 0, yMax: yMaxAuto, user: false },
      };
    }
    if (type === "sound") {
      const mode = (nodeEl.dataset.mode ?? "spectrum").toLowerCase() === "pressure" ? "pressure" : "spectrum";
      if (mode === "pressure") {
        const windowS = Math.max(1, Number(nodeEl.dataset.windowS ?? "30") || 30);
        // Sound state is now owned by the runtime `sound` plugin.
        // Use stable defaults here so plot navigation doesn't depend on plugin internals.
        const maxYAuto = 1;

        const key = `sound:${id}:pressure`;
        const pr0 = __plotRanges.get(key);
        return {
          key,
          kind: "sound-pressure" as const,
          bounds: { xMin: 0, xMax: windowS, yMin: 0, yMax: Number.POSITIVE_INFINITY },
          current: pr0 ?? { xMin: 0, xMax: windowS, yMin: 0, yMax: maxYAuto, user: false },
        };
      }
      const maxHzAuto = 8000;
      const key = `sound:${id}:spectrum`;
      const pr0 = __plotRanges.get(key);
      return {
        key,
        kind: "sound-spectrum" as const,
        bounds: { xMin: 0, xMax: maxHzAuto, yMin: -120, yMax: 0 },
        current: pr0 ?? { xMin: 0, xMax: maxHzAuto, yMin: -120, yMax: 0, user: false },
      };
    }
    return null;
  };

  stage.addEventListener(
    "wheel",
    (ev) => {
      if (getAppMode() !== "live") return;
      const t = ev.target as HTMLElement;
      const nodeEl = t.closest<HTMLElement>(".node-timer, .node-sound");
      if (!nodeEl) return;
      if (!_isInsidePlot(nodeEl, ev.clientX, ev.clientY)) return;
      const info = plotInfo(nodeEl);
      if (!info) return;

      const { ox, oy, xLen, yLen } = _plotRectCss(nodeEl);
      if (!(xLen > 1 && yLen > 1)) return;

      const xFrac = _clamp((ev.clientX - ox) / xLen, 0, 1);
      const yFrac = _clamp((oy - ev.clientY) / yLen, 0, 1);

      const cur = info.current;
      const xSpan = Math.max(1e-9, cur.xMax - cur.xMin);
      const ySpan = Math.max(1e-9, cur.yMax - cur.yMin);
      const xCursor = cur.xMin + xFrac * xSpan;
      const yCursor = cur.yMin + yFrac * ySpan;

      const z = _clamp(Math.exp(-ev.deltaY * 0.001), 0.2, 5);
      const zoomX = ev.shiftKey ? 1 : z;
      const zoomY = ev.shiftKey ? z : (ev.ctrlKey ? z : 1);

      const newXSpan = xSpan / zoomX;
      const newYSpan = ySpan / zoomY;
      let nx0 = xCursor - xFrac * newXSpan;
      let nx1 = nx0 + newXSpan;
      let ny0 = yCursor - yFrac * newYSpan;
      let ny1 = ny0 + newYSpan;

      // Clamp to bounds
      {
        const b0 = info.bounds.xMin;
        const b1 = info.bounds.xMax;
        const spanB = Math.max(1e-9, b1 - b0);
        const spanN = Math.max(1e-9, nx1 - nx0);
        if (spanN > spanB) {
          nx0 = b0;
          nx1 = b1;
        } else {
          nx0 = _clamp(nx0, b0, b1 - spanN);
          nx1 = nx0 + spanN;
        }
      }
      ny0 = Math.max(info.bounds.yMin, ny0);
      ny1 = Math.min(info.bounds.yMax, ny1);
      if (!(ny1 > ny0 + 1e-9)) {
        ny0 = cur.yMin;
        ny1 = cur.yMax;
      }

      __plotRanges.set(info.key, { xMin: nx0, xMax: nx1, yMin: ny0, yMax: ny1, user: true });
      ev.preventDefault();
    },
    { passive: false }
  );

  stage.addEventListener("pointerdown", (ev) => {
    if (getAppMode() !== "live") return;
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    const nodeEl = t.closest<HTMLElement>(".node-timer, .node-sound");
    if (!nodeEl) return;
    if (!_isInsidePlot(nodeEl, ev.clientX, ev.clientY)) return;
    const info = plotInfo(nodeEl);
    if (!info) return;
    const pr = _plotRectCss(nodeEl);
    __plotDrag = {
      key: info.key,
      kind: info.kind,
      xMin: info.current.xMin,
      xMax: info.current.xMax,
      yMin: info.current.yMin,
      yMax: info.current.yMax,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      rect: pr.r,
    };
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });

  stage.addEventListener("pointermove", (ev) => {
    if (!__plotDrag) return;
    if (getAppMode() !== "live") return;
    const dxPx = ev.clientX - __plotDrag.startClientX;
    const dyPx = ev.clientY - __plotDrag.startClientY;
    const r = __plotDrag.rect;
    const xLen = (PLOT_FRACS.rightF - PLOT_FRACS.leftF) * r.width;
    const yLen = (PLOT_FRACS.bottomF - PLOT_FRACS.topF) * r.height;
    if (!(xLen > 1 && yLen > 1)) return;
    const xSpan = Math.max(1e-9, __plotDrag.xMax - __plotDrag.xMin);
    const ySpan = Math.max(1e-9, __plotDrag.yMax - __plotDrag.yMin);

    let nx0 = __plotDrag.xMin - (dxPx / xLen) * xSpan;
    let nx1 = __plotDrag.xMax - (dxPx / xLen) * xSpan;
    let ny0 = __plotDrag.yMin + (dyPx / yLen) * ySpan;
    let ny1 = __plotDrag.yMax + (dyPx / yLen) * ySpan;

    // Clamp using current plot bounds (re-resolve from the element each time)
    const t = ev.target as HTMLElement;
    const nodeEl = t.closest<HTMLElement>(".node-timer, .node-sound");
    if (nodeEl) {
      const info = plotInfo(nodeEl);
      if (info && info.key === __plotDrag.key) {
        const b0 = info.bounds.xMin;
        const b1 = info.bounds.xMax;
        const spanB = Math.max(1e-9, b1 - b0);
        const spanN = Math.max(1e-9, nx1 - nx0);
        if (spanN > spanB) {
          nx0 = b0;
          nx1 = b1;
        } else {
          nx0 = _clamp(nx0, b0, b1 - spanN);
          nx1 = nx0 + spanN;
        }
        ny0 = Math.max(info.bounds.yMin, ny0);
        ny1 = Math.min(info.bounds.yMax, ny1);
      }
    }

    __plotRanges.set(__plotDrag.key, { xMin: nx0, xMax: nx1, yMin: ny0, yMax: ny1, user: true });
    ev.preventDefault();
  });

  const endDrag = () => {
    __plotDrag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
}

function attachSoundNodeHandlers(stage: HTMLElement) {
  stage.addEventListener("click", (ev) => {
    // In Edit mode, sound buttons should not be interactive (it interferes with editing).
    if (getAppMode() !== "live") return;
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const nodeEl = btn.closest<HTMLElement>(".node-sound");
    if (!nodeEl) return;
    if (action === "sound-toggle") {
      const prev = (__soundState as SoundState | null) ?? null;
      const st0 = ensureSoundStateDefaults(prev);
      const running = !!st0.enabled;
      const modeNow = (nodeEl.dataset.mode ?? "spectrum").toLowerCase() === "pressure" ? "pressure" : "spectrum";

      // Instant UI feedback (optimistic), but also reconcile with backend state.
      if (running) {
        (__soundState as any) = { ...st0, enabled: false };
        const hasRunOnce = _getHasRunOnce(nodeEl) || (st0.seq ?? 0) > 0;
        btn.textContent = runPauseResumeLabel(false, hasRunOnce);
        void fetch(`${BACKEND}/api/sound/pause`, { method: "POST" }).finally(async () => {
          const st = await fetchSoundState();
          if (st) __soundState = st;
        });
      } else {
        (__soundState as any) = { ...st0, enabled: true, error: null };
        btn.textContent = "Pause";
        _setHasRunOnce(nodeEl, true);
        // Ensure backend computes the active mode when we start.
        void fetch(`${BACKEND}/api/sound/mode`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: modeNow }),
        })
          .catch(() => {})
          .finally(() => {
            void fetch(`${BACKEND}/api/sound/start`, { method: "POST" }).finally(async () => {
              // Reconcile quickly so UI doesn't snap back to Run if start didn't take.
              const st = await fetchSoundState();
              if (st) __soundState = st;
              else (__soundState as any) = { ...ensureSoundStateDefaults(__soundState as any), enabled: false, error: "Sound backend unreachable" };
            });
          });
      }
      ev.preventDefault();
      return;
    }
    if (action === "sound-reset") {
      // Instant UI feedback
      const prev = (__soundState as SoundState | null) ?? null;
      const st0 = ensureSoundStateDefaults(prev);
      (__soundState as any) = { ...st0, enabled: false, seq: 0, pressure10ms: [], spectrum: { freqHz: [], magDb: [] }, error: null };
      _setHasRunOnce(nodeEl, false);
      const toggleBtn = nodeEl.querySelector<HTMLButtonElement>('button[data-action="sound-toggle"]');
      if (toggleBtn) toggleBtn.textContent = "Run";
      void fetch(`${BACKEND}/api/sound/reset`, { method: "POST" }).finally(async () => {
        const st = await fetchSoundState();
        if (st) __soundState = st;
      });
      ev.preventDefault();
      return;
    }
    if (action === "sound-mode-toggle") {
      const cur = (nodeEl.dataset.mode ?? "spectrum").toLowerCase();
      const next = cur === "pressure" ? "spectrum" : "pressure";
      nodeEl.dataset.mode = next;
      // Button text describes where we will go next.
      btn.textContent = next === "pressure" ? "As Spectrum" : "As Time Series";
      // Tell backend to pause the inactive computation to save CPU.
      void fetch(`${BACKEND}/api/sound/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
  });
}

function applyDataBindings(template: string, data: Record<string, string | number>) {
  return template.replaceAll(/\{\{([a-zA-Z_][\w.]*)\}\}/g, (_m, key) => {
    const v = (data as any)[key];
    if (v === undefined || v === null) return "-";
    if (typeof v === "number" && !Number.isFinite(v)) return "-";
    return String(v);
  });
}

function _parseInlineParams(s: string): Record<string, string> {
  // Split on commas, but NOT inside quotes or balanced groups.
  const out: Record<string, string> = {};
  let buf = "";
  let inQuotes = false;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  const parts: string[] = [];
  for (const ch of String(s ?? "")) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "{") brace += 1;
      else if (ch === "}") brace = Math.max(0, brace - 1);
      else if (ch === "[") bracket += 1;
      else if (ch === "]") bracket = Math.max(0, bracket - 1);
      else if (ch === "(") paren += 1;
      else if (ch === ")") paren = Math.max(0, paren - 1);
    }
    if (ch === "," && !inQuotes && brace === 0 && bracket === 0 && paren === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function _parseList(raw: string | undefined): string[] {
  let s = String(raw ?? "").trim();
  // Strip surrounding braces/brackets generously (handles {{...}}, {...}, [...])
  while (s && (s[0] === "{" || s[0] === "[") && (s[s.length - 1] === "}" || s[s.length - 1] === "]")) {
    s = s.slice(1, -1).trim();
  }
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let brace = 0;
  for (const ch of s) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "{") brace += 1;
      else if (ch === "}") brace = Math.max(0, brace - 1);
    }
    if (ch === "," && !inQuotes && brace === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.map((x) => {
    let t = x.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    return t;
  });
}

// Sound streaming moved to @interactive/runtime.
let __graphRafStarted = false;
function getGraphTimerCanvas(nodeEl: HTMLElement) {
  // Graph reuses the timer base widget DOM (timer-frame + timer-canvas).
  // The engine creates the canvas; if it's missing for any reason, skip drawing.
  return nodeEl.querySelector<HTMLCanvasElement>(":scope canvas.timer-canvas");
}

// Graph composite UI moved to @interactive/runtime.

// Graph rendering moved to @interactive/runtime (plugin-based).

// Sound composite UI moved to @interactive/runtime.
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function gridSpacingForZoom(zoom: number, baseWorld = 100) {
  const logz = Math.log10(Math.max(1e-9, zoom));
  const n = Math.floor(logz);
  const frac = logz - n;
  const t = smoothstep(0.25, 0.75, frac);
  const spacing0 = baseWorld / Math.pow(10, n);
  const spacing1 = baseWorld / Math.pow(10, n + 1);
  return { spacing0, spacing1, t };
}

type DragMode = "none" | "move" | "resize" | "rotate" | "line" | "graph";

const _cursorSvgCss = (svg: string, hotX: number, hotY: number, fallback: string) => {
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  return `url("data:image/svg+xml,${encoded}") ${hotX} ${hotY}, ${fallback}`;
};

const _clampDeg360 = (deg: number) => {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
};

const _cursorSvgHeader = (w: number, h: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;

const _doubleArrowPath = (opts: { headL: number; headW: number }) => `M0 0 L${opts.headL} ${opts.headW / 2} L0 ${opts.headW} Z`;

const resizeCursorCss = (() => {
  // Custom resize cursor: double-headed arrow. We rotate it so it matches the node's local axis.
  // 32x32, centered hotspot.
  const cache = new Map<number, string>();
  const svgForDeg = (deg: number) => {
    const d = _clampDeg360(deg);
    const cx = 16;
    const cy = 16;
    const stroke = "rgba(255,255,255,0.92)";
    const strokeOutline = "rgba(0,0,0,0.65)";
    const strokeW = 2.9;
    // Arrow geometry (horizontal base, then rotate).
    const x0 = 6.5;
    const x1 = 25.5;
    const headL = 6.2;
    const headW = 7.2;
    const tri = _doubleArrowPath({ headL, headW });
    return `${_cursorSvgHeader(32, 32)}
  <g transform="rotate(${d.toFixed(2)} ${cx} ${cy})">
    <line x1="${x0}" y1="${cy}" x2="${x1}" y2="${cy}" stroke="${strokeOutline}" stroke-width="${strokeW + 1.8}" stroke-linecap="round"/>
    <line x1="${x0}" y1="${cy}" x2="${x1}" y2="${cy}" stroke="${stroke}" stroke-width="${strokeW}" stroke-linecap="round"/>
    <g transform="translate(${x0} ${cy}) rotate(180) translate(0 ${-headW / 2})">
      <path d="${tri}" fill="${strokeOutline}"/>
      <path d="${tri}" fill="${stroke}" transform="translate(0 0) scale(0.92) translate(0.2 0.3)"/>
    </g>
    <g transform="translate(${x1} ${cy}) rotate(0) translate(0 ${-headW / 2})">
      <path d="${tri}" fill="${strokeOutline}"/>
      <path d="${tri}" fill="${stroke}" transform="translate(0 0) scale(0.92) translate(0.2 0.3)"/>
    </g>
  </g>
</svg>`;
  };
  return (deg: number) => {
    const bucket = Math.round(_clampDeg360(deg) / 5) * 5;
    const cached = cache.get(bucket);
    if (cached) return cached;
    const svg = svgForDeg(bucket);
    const css = _cursorSvgCss(svg, 16, 16, "default");
    cache.set(bucket, css);
    return css;
  };
})();

const rotationCursorCss = (() => {
  // Custom cursor (SVG) so the rotation cursor can be rotated with the element.
  // Shape: a HALF CIRCLE with arrowheads at both ends (arrowheads point left in local cursor coords).
  const cache = new Map<string, string>();
  const clampDeg = (deg: number) => {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  };
  const svgForDeg = (deg: number, mirrorX: boolean) => {
    const d = clampDeg(deg);
    const cx = 16;
    const cy = 16;
    const r = 10.5;
    const stroke = "rgba(255,255,255,0.92)";
    const strokeOutline = "rgba(0,0,0,0.65)";
    const strokeW = 2.9;
    // Match the straight resize cursor heads.
    const headL = 6.2;
    const headW = 7.2;
    const tri = _doubleArrowPath({ headL, headW });

    // Half-circle on the RIGHT side: from bottom -> top using 2 cubic Beziers.
    // This makes the arrowheads/tangents unambiguous and avoids SVG arc sweep ambiguity.
    const k = 0.5522847498 * r;
    const xC = cx;
    const yTop = cy - r;
    const yBot = cy + r;
    const xRight = cx + r;

    const p0 = { x: xC, y: yBot };
    const c1 = { x: xC + k, y: yBot };
    const c2 = { x: xRight, y: cy + k };
    const p1 = { x: xRight, y: cy };
    const c3 = { x: xRight, y: cy - k };
    const c4 = { x: xC + k, y: yTop };
    const p2 = { x: xC, y: yTop };

    // IMPORTANT: only ONE transform attribute; combine rotate+mirror into a single transform string.
    // (Duplicate attributes break the SVG and the browser falls back to the cursor fallback.)
    const tf = mirrorX ? `rotate(${d.toFixed(2)} ${cx} ${cy}) translate(32 0) scale(-1 1)` : `rotate(${d.toFixed(2)} ${cx} ${cy})`;
    return `${_cursorSvgHeader(32, 32)}
  <g transform="${tf}">
    <path d="M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}
             C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}
             C ${c3.x.toFixed(2)} ${c3.y.toFixed(2)} ${c4.x.toFixed(2)} ${c4.y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}"
          fill="none" stroke="${strokeOutline}" stroke-width="${strokeW + 1.8}" stroke-linecap="round"/>
    <path d="M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}
             C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}
             C ${c3.x.toFixed(2)} ${c3.y.toFixed(2)} ${c4.x.toFixed(2)} ${c4.y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}"
          fill="none" stroke="${stroke}" stroke-width="${strokeW}" stroke-linecap="round"/>

    <!-- Arrowheads at both ends, pointing LEFT in local cursor coords -->
    <g transform="translate(${p0.x.toFixed(2)} ${p0.y.toFixed(2)}) rotate(180) translate(0 ${-(headW / 2).toFixed(2)})">
      <path d="${tri}" fill="${strokeOutline}"/>
      <path d="${tri}" fill="${stroke}" transform="translate(0 0) scale(0.92) translate(0.2 0.3)"/>
    </g>
    <g transform="translate(${p2.x.toFixed(2)} ${p2.y.toFixed(2)}) rotate(180) translate(0 ${-(headW / 2).toFixed(2)})">
      <path d="${tri}" fill="${strokeOutline}"/>
      <path d="${tri}" fill="${stroke}" transform="translate(0 0) scale(0.92) translate(0.2 0.3)"/>
    </g>
  </g>
</svg>`;
  };
  return (deg: number, opts?: { mirrorX?: boolean }) => {
    const mirrorX = !!opts?.mirrorX;
    const bucket = Math.round(clampDeg(deg) / 5) * 5;
    const key = `${bucket}:${mirrorX ? "mx" : "n"}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const svg = svgForDeg(bucket, mirrorX);
    const css = _cursorSvgCss(svg, 16, 16, "grab");
    cache.set(key, css);
    return css;
  };
})();

function getAppMode(): "edit" | "live" {
  const raw =
    (document.documentElement.dataset.ipMode ??
      document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ??
      "edit") + "";
  return raw.toLowerCase() === "live" ? "live" : "edit";
}

function ipDebugEnabled(_flag: string) {
  // Logging is intentionally disabled in this workspace.
  return false;
}

async function _debugCompositeSaveFetch(url: string, payload: any, ctx: Record<string, any>) {
  const dbg = ipDebugEnabled("ip_debug_composite_save");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // Always surface errors (but keep payload out unless debug is enabled).
      // eslint-disable-next-line no-console
      console.error("[ip][composite][save] failed", { status: res.status, statusText: res.statusText, ctx, body: txt });
      if (dbg) {
        // eslint-disable-next-line no-console
        console.error("[ip][composite][save] payload", payload);
      }
    } else if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][composite][save] ok", { ctx });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[ip][composite][save] error", { ctx, err });
    if (dbg) {
      // eslint-disable-next-line no-console
      console.error("[ip][composite][save] payload", payload);
    }
  }
}

function ensureHandles(el: HTMLElement) {
  const dbgAnchorsEnabled = () => false;
  const dbgAnchorsStack = () => false;
  // Throttle anchor logging: selection overlays refresh in a RAF loop, otherwise logs spam.
  const __ip_anchorLogState: WeakMap<HTMLElement, { ts: number; sig: string }> =
    ((window as any).__ip_anchorLogState ??= new WeakMap());

  const logAnchors = (_event: string, _extra: any = {}) => {};

  // Safety: never show transform UI in Live mode.
  if (getAppMode() !== "edit") {
    el.querySelector(":scope > .handles")?.remove();
    logAnchors("ensureHandles:skip-live");
    return null;
  }

  // Composite roots (timer/sound/graph) should NOT render node-level handles.
  // Their selection/transform UI is rendered via the viewport-fixed composite selection overlay box instead.
  // If we allow node-level handles too, you get "double anchors" (overlay + node).
  //
  // NOTE: `ensureHandles` is defined at module scope (no access to `engine` here), so detect composites by DOM.
  if (!el.classList.contains("ip-composite-selection")) {
    const isCompositeRoot =
      !!el.querySelector(":scope > .timer-sub-layer, :scope > .sound-sub-layer, :scope > .graph-sub-layer") ||
      // Some composites mount their sub-layer under an inner frame element.
      !!el.querySelector(":scope > .timer-frame > .timer-sub-layer, :scope > .sound-frame > .sound-sub-layer, :scope > .timer-frame > .graph-sub-layer");
    if (isCompositeRoot) {
      el.querySelector(":scope > .handles")?.remove();
      logAnchors("ensureHandles:skip-composite-root-node", { reason: "dom-detected" });
      return null;
    }
  }
  let handles = el.querySelector<HTMLDivElement>(":scope > .handles");

  // Special-case: arrows/lines are edited via control points, not bounding-box resize/rotate.
  const isSegment = el.classList.contains("node-arrow") || el.classList.contains("node-line");
  if (isSegment) {
    // Simplest UX: no visible handle points ("rings").
    // Endpoints are draggable by proximity (see stage pointerdown handler).
    el.querySelector(":scope > .handles")?.remove();
    logAnchors("ensureHandles:skip-segment");
    return null;
  }

  const normalizeAnchor = (a: string | undefined) => {
    if (!a) return "topLeft";
    if (a === "top") return "topCenter";
    if (a === "bottom") return "bottomCenter";
    if (a === "left") return "centerLeft";
    if (a === "right") return "centerRight";
    if (a === "center") return "centerCenter";
    return a;
  };

  const anchorFrac = (a0: string | undefined) => {
    const a = normalizeAnchor(a0);
    const ax = a.endsWith("Left") ? 0 : a.endsWith("Right") ? 1 : 0.5;
    const ay = a.startsWith("Top") ? 0 : a.startsWith("Bottom") ? 1 : 0.5;
    return { ax, ay, a };
  };

  // Hide resize/scale handles that lie on the anchored edge/corner.
  // Scaling "from" the anchored edge is meaningless because the anchor is the pivot/fixed point.
  // Rotation handles remain visible.
  const updateHandleVisibility = (root: HTMLElement) => {
    const { ax, ay } = anchorFrac(el.dataset.anchor);
    const hide = new Set<string>();
    if (ay === 0) hide.add("n");
    if (ay === 1) hide.add("s");
    if (ax === 0) hide.add("w");
    if (ax === 1) hide.add("e");
    if (ax === 0 && ay === 1) hide.add("sw");
    if (ax === 1 && ay === 1) hide.add("se");
    for (const h of Array.from(root.querySelectorAll<HTMLElement>(".handle"))) {
      const name = String(h.dataset.handle ?? "");
      const isRotate = name === "rot" || name.startsWith("rot-");
      if (isRotate) {
        h.style.display = "";
        h.style.pointerEvents = "";
        continue;
      }
      const shouldHide = hide.has(name);
      h.style.display = shouldHide ? "none" : "";
      h.style.pointerEvents = shouldHide ? "none" : "";
    }
  };

  const updateAnchorDots = (root: HTMLElement) => {
    const current = normalizeAnchor(el.dataset.anchor);
    for (const dot of Array.from(root.querySelectorAll<HTMLElement>(".anchor-dot"))) {
      dot.classList.toggle("is-current", dot.dataset.anchor === current);
    }
  };

  // Rotate cursor directions with the node rotation (fixes e.g. rotated y-label edge cursors).
  const parseRotateDeg = (cssTransform: string | null | undefined) => {
    // Prefer the modern rotate property when present (composite sub-elements use `style.rotate = "Xdeg"`).
    const r0 = String((el as any)?.style?.rotate ?? "").trim();
    const m0 = r0.match(/^\s*([\-0-9.]+)\s*deg\s*$/i);
    if (m0) {
      const v0 = Number(m0[1]);
      if (Number.isFinite(v0)) return v0;
    }
    const s = String(cssTransform ?? "");
    const m = s.match(/rotate\(\s*([\-0-9.]+)\s*deg\s*\)/i);
    if (!m) return 0;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : 0;
  };
  const normDeg = (deg: number) => {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  };
  const rotVec = (x: number, y: number, deg: number) => {
    const a = (normDeg(deg) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // Coordinate system: x right, y down. Positive deg is clockwise (CSS rotate()).
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  };
  const cursorForHandleRotated = (handle: string, rotDeg: number) => {
    if (!handle) return "";
    // Note: SVG/CSS rotation is clockwise in screen coords (y down).
    // The UX spec here is in the usual math convention (CCW positive),
    // so we flip the sign for these corner offsets.
    if (handle === "rot-tr") return rotationCursorCss(rotDeg - 45);
    // Top-left should be counter-clockwise vs top-right in the user's convention
    // (i.e. -90° in SVG/CSS coords relative to top-right), so use -135° total.
    // IMPORTANT: do NOT mirror here; mirroring flips the perceived direction.
    if (handle === "rot-tl") return rotationCursorCss(rotDeg - 135);
    if (handle === "rot" || handle.startsWith("rot-")) return rotationCursorCss(rotDeg);
    if (handle === "n" || handle === "s" || handle === "e" || handle === "w") {
      // Local axis angle (deg) + node rotation.
      // Our double-arrow cursor is drawn horizontally by default (0deg).
      const axis = handle === "n" || handle === "s" ? 90 : 0;
      return resizeCursorCss(rotDeg + axis);
    }
    if (handle === "nw" || handle === "ne" || handle === "sw" || handle === "se") {
      // Diagonal axis in local space, then rotate with the node.
      // se/nw => 45deg; sw/ne => 135deg (in screen coords with y down).
      const axis = handle === "se" || handle === "nw" ? 45 : 135;
      return resizeCursorCss(rotDeg + axis);
    }
    return "";
  };
  const updateHandleCursors = (root: HTMLElement) => {
    const rotDeg = parseRotateDeg(el.style.transform);
    for (const h of Array.from(root.querySelectorAll<HTMLElement>(".handle"))) {
      const name = String(h.dataset.handle ?? "");
      const c = cursorForHandleRotated(name, rotDeg);
      if (c) h.style.setProperty("cursor", c, "important");
    }
  };

  if (handles) {
    if (!isSegment) {
      updateAnchorDots(handles);
      updateHandleCursors(handles);
      updateHandleVisibility(handles);
      logAnchors("ensureHandles:update-existing", {
        nAnchorDots: handles.querySelectorAll(".anchor-dot").length,
        nHandles: handles.querySelectorAll(".handle").length,
      });
      return handles;
    }
    // Update segment control point positions from dataset (set by renderer update).
    const fx = Number(el.dataset.fromX ?? "0");
    const fy = Number(el.dataset.fromY ?? "0.5");
    const tx = Number(el.dataset.toX ?? "1");
    const ty = Number(el.dataset.toY ?? "0.5");
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2;
    const p1 = handles.querySelector<HTMLElement>(':scope > .handle.point[data-handle="p1"]');
    const p2 = handles.querySelector<HTMLElement>(':scope > .handle.point[data-handle="p2"]');
    const pm = handles.querySelector<HTMLElement>(':scope > .handle.point[data-handle="mid"]');
    if (p1) {
      p1.style.left = `${fx * 100}%`;
      p1.style.top = `${fy * 100}%`;
    }
    if (p2) {
      p2.style.left = `${tx * 100}%`;
      p2.style.top = `${ty * 100}%`;
    }
    if (pm) {
      pm.style.left = `${mx * 100}%`;
      pm.style.top = `${my * 100}%`;
    }
    return handles;
  }
  handles = document.createElement("div");
  handles.className = isSegment ? "handles handles-line" : "handles";

  if (isSegment) {
    // unreachable due to early return above; keep for safety
    return null;
  }
  const mk = (name: string, left: string, top: string, cls = "") => {
    const h = document.createElement("div");
    h.className = `handle ${cls}`.trim();
    h.dataset.handle = name;
    h.style.left = left;
    h.style.top = top;
    h.style.transform = "translate(-50%, -50%)";
    return h;
  };
  // Hover regions (in the node's local coordinate system; they rotate with the node):
  // - anchor dots: "finger" (pointer) ONLY when directly over the dot element
  // - resize/rotate: within 20px on either side of the selection outline (inside + outside)
  //
  // This is implemented as invisible hit-regions centered on the outline:
  // - edges: a 40px thick band, positioned -20..+20 around each edge
  // - corners: a 40x40 square, centered on each corner
  const HIT_HALF_PX = 20;
  const pxHalf = `${HIT_HALF_PX}px`;
  const pxBand = `${HIT_HALF_PX * 2}px`;
  // Exclude corner squares so corners always win (uniform scale/rotate).
  const edgeLen = `calc(100% - (${pxHalf} * 2))`;
  const mkStrip = (name: string, left: string, top: string, w: string, h: string, cls = "") => {
    const d = document.createElement("div");
    d.className = `handle ${cls}`.trim();
    d.dataset.handle = name;
    d.style.left = left;
    d.style.top = top;
    d.style.width = w;
    d.style.height = h;
    d.style.transform = "none";
    return d;
  };
  const mkCorner = (name: string, left: string, top: string, cls = "") => {
    const d = document.createElement("div");
    d.className = `handle ${cls}`.trim();
    d.dataset.handle = name;
    d.style.left = left;
    d.style.top = top;
    d.style.width = pxBand;
    d.style.height = pxBand;
    d.style.transform = "none";
    return d;
  };
  const mkMid = (name: string, left: string, top: string, cls = "") => {
    const d = document.createElement("div");
    d.className = `handle ${cls}`.trim();
    d.dataset.handle = name;
    d.style.left = left;
    d.style.top = top;
    d.style.width = pxBand;
    d.style.height = pxBand;
    d.style.transform = "translate(-50%, -50%)";
    return d;
  };

  handles.append(
    // edge resize strips (centered on the outline: -20..+20 px)
    mkStrip("n", pxHalf, `-${pxHalf}`, edgeLen, pxBand, "edge edge-n"),
    mkStrip("e", `calc(100% - ${pxHalf})`, pxHalf, pxBand, edgeLen, "edge edge-e"),
    mkStrip("s", pxHalf, `calc(100% - ${pxHalf})`, edgeLen, pxBand, "edge edge-s"),
    mkStrip("w", `-${pxHalf}`, pxHalf, pxBand, edgeLen, "edge edge-w"),

    // corner squares (centered on each corner: -20..+20 px)
    mkCorner("rot-tl", `-${pxHalf}`, `-${pxHalf}`, "corner rot rot-tl"),
    mkCorner("rot-tr", `calc(100% - ${pxHalf})`, `-${pxHalf}`, "corner rot rot-tr"),
    mkCorner("sw", `-${pxHalf}`, `calc(100% - ${pxHalf})`, "corner scale scale-sw"),
    mkCorner("se", `calc(100% - ${pxHalf})`, `calc(100% - ${pxHalf})`, "corner scale scale-se")
  );

  // Edge-center hit zones (same 20px rule): these ensure that even for very thin boxes,
  // hovering near the *middle* of an edge yields the horizontal/vertical resize cursor,
  // instead of being dominated by overlapping corner hit zones.
  //
  // They intentionally reuse the same handles ("n/e/s/w") so pointerdown resize behavior is unchanged.
  // Appended AFTER corners so they win in stacking order.
  handles.append(
    mkMid("n", "50%", `-${pxHalf}`, "edge edge-n"),
    mkMid("s", "50%", `calc(100% - ${pxHalf})`, "edge edge-s"),
    mkMid("w", `-${pxHalf}`, "50%", "edge edge-w"),
    mkMid("e", `calc(100% - ${pxHalf})`, "50%", "edge edge-e")
  );

  const mkAnchor = (anchor: string, left: string, top: string) => {
    const d = document.createElement("div");
    d.className = "anchor-dot";
    d.dataset.anchor = anchor;
    d.style.left = left;
    d.style.top = top;
    return d;
  };
  // 6-point anchors (requested)
  handles.append(
    mkAnchor("topLeft", "0%", "0%"),
    mkAnchor("topCenter", "50%", "0%"),
    mkAnchor("topRight", "100%", "0%"),
    mkAnchor("centerLeft", "0%", "50%"),
    mkAnchor("centerCenter", "50%", "50%"),
    mkAnchor("centerRight", "100%", "50%"),
    mkAnchor("bottomLeft", "0%", "100%"),
    mkAnchor("bottomCenter", "50%", "100%"),
    mkAnchor("bottomRight", "100%", "100%")
  );

  el.appendChild(handles);
  updateAnchorDots(handles);
  updateHandleCursors(handles);
  updateHandleVisibility(handles);
  logAnchors("ensureHandles:create", {
    nAnchorDots: handles.querySelectorAll(".anchor-dot").length,
    nHandles: handles.querySelectorAll(".handle").length,
  });
  return handles;
}

function anchorToTopLeftWorld(t: { x: number; y: number; w: number; h: number; anchor?: string }) {
  const a = (t.anchor ?? "topLeft") === "top" ? "topCenter" : (t.anchor ?? "topLeft") === "bottom" ? "bottomCenter" : t.anchor ?? "topLeft";
  switch (a) {
    case "center":
    case "centerCenter":
      return { x: t.x - t.w / 2, y: t.y - t.h / 2 };
    case "topCenter":
      return { x: t.x - t.w / 2, y: t.y };
    case "bottomCenter":
      return { x: t.x - t.w / 2, y: t.y - t.h };
    case "centerLeft":
      return { x: t.x, y: t.y - t.h / 2 };
    case "centerRight":
      return { x: t.x - t.w, y: t.y - t.h / 2 };
    case "left":
      return { x: t.x, y: t.y - t.h / 2 };
    case "right":
      return { x: t.x - t.w, y: t.y - t.h / 2 };
    case "topRight":
      return { x: t.x - t.w, y: t.y };
    case "bottomLeft":
      return { x: t.x, y: t.y - t.h };
    case "bottomRight":
      return { x: t.x - t.w, y: t.y - t.h };
    case "topLeft":
    default:
      return { x: t.x, y: t.y };
  }
}

function topLeftToAnchorWorld(rect: { x: number; y: number; w: number; h: number }, anchor?: string) {
  const a = (anchor ?? "topLeft") === "top" ? "topCenter" : (anchor ?? "topLeft") === "bottom" ? "bottomCenter" : anchor ?? "topLeft";
  switch (a) {
    case "center":
    case "centerCenter":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    case "topCenter":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "bottomCenter":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "centerLeft":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "centerRight":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "topRight":
      return { x: rect.x + rect.w, y: rect.y };
    case "bottomLeft":
      return { x: rect.x, y: rect.y + rect.h };
    case "bottomRight":
      return { x: rect.x + rect.w, y: rect.y + rect.h };
    case "topLeft":
    default:
      return { x: rect.x, y: rect.y };
  }
}

function attachEditor(
  stage: HTMLElement,
  engine: Engine,
  history: ReturnType<typeof createHistoryController>,
  setApplySelection: (fn: () => void) => void
) {
  const selected = new Set<string>();
  const debugSelectionEnabled = () => {
    try {
      return localStorage.getItem("ip_debug_selection") === "1";
    } catch {
      return false;
    }
  };
  // Intentionally no debug event logging (keeps editor responsive).
  const ensureStopPropagationDebug = () => {};
  // Selection controller is created later (after `effectiveNodeRectClient` is defined).
  let selection: ReturnType<typeof createSelectionController> | null = null;
  let lastContextWorld: { x: number; y: number } | null = null;
  let activeViewId: string = stage.dataset.viewId || "home";
  // Used for paste placement (Ctrl+V): keep last pointer position in client coords.
  // Stored on window so the key handler can access it without threading state through every closure.
  (window as any).__ip_lastMouseX = (window as any).__ip_lastMouseX ?? null;
  (window as any).__ip_lastMouseY = (window as any).__ip_lastMouseY ?? null;
  stage.addEventListener(
    "pointermove",
    (ev) => {
      if (getAppMode() !== "edit") return;
      (window as any).__ip_lastMouseX = ev.clientX;
      (window as any).__ip_lastMouseY = ev.clientY;
    },
    { passive: true }
  );

  ensureStopPropagationDebug();
  // (pointer debug listeners removed)

  // Simple top toolbox (edit mode): pick what to place.
  type Tool = "select" | "text" | "bullets" | "arrow" | "line";
  let tool: Tool = "select";
  // Default color for newly created text/lines/arrows.
  let drawColor = (() => {
    try {
      const v = String(localStorage.getItem("ip_drawColor") ?? "").trim();
      return v && /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff";
    } catch {
      return "#ffffff";
    }
  })();
  // Single source of truth for tool state:
  // - `tool` variable (fast in JS)
  // - `stage.dataset.tool` (debuggable + readable from other modules)
  // - toolbar button visuals
  const setTool = (next: Tool) => {
    tool = next;
    stage.dataset.tool = next;
    // Only style actual tool buttons; other buttons (e.g. color picker) manage their own visuals.
    const buttons = Array.from(toolbox.querySelectorAll<HTMLButtonElement>("button[data-tool-id]"));
    for (const b of buttons) {
      const active = String(b.dataset.toolId ?? "") === next;
      b.dataset.active = active ? "1" : "0";
      b.style.background = active ? "rgba(110,168,255,0.22)" : "rgba(255,255,255,0.06)";
      b.style.borderColor = active ? "rgba(110,168,255,0.36)" : "rgba(255,255,255,0.16)";
    }
    // Draw-mode isolation: never keep a selection active while placing.
    if (next !== "select") clearSelectionImmediate();
  };
  const getTool = (): Tool => (String(stage.dataset.tool ?? tool) as Tool) || "select";
  // Segment placement draft state is owned by the extracted segment placement tool.
  const toolbox = document.createElement("div");
  toolbox.className = "edit-toolbox";
  toolbox.style.position = "fixed";
  toolbox.style.left = "50%";
  toolbox.style.top = "10px";
  toolbox.style.transform = "translateX(-50%)";
  toolbox.style.zIndex = "99998";
  toolbox.style.display = "flex";
  toolbox.style.gap = "8px";
  toolbox.style.padding = "8px";
  toolbox.style.borderRadius = "12px";
  toolbox.style.border = "1px solid rgba(255,255,255,0.16)";
  toolbox.style.background = "rgba(15,17,24,0.92)";
  toolbox.style.backdropFilter = "blur(8px)";
  toolbox.style.pointerEvents = "auto";
  // Keep toolbox clicks local (but don't block the button itself).
  toolbox.addEventListener("pointerdown", (e) => e.stopPropagation());
  toolbox.addEventListener("click", (e) => e.stopPropagation());

  const clearSelectionImmediate = () => {
    // Tool switching happens before the selection controller is created.
    // Still clear any visible selection chrome so draw mode is "pure".
    try {
      selected.clear();
      // Remove node-level handles (if any already exist).
      for (const h of Array.from(stage.querySelectorAll<HTMLElement>(".handles"))) h.remove();
      // Remove any overlay boxes created by selection controller (mounted on body).
      document.querySelector<HTMLElement>(".ip-composite-selection")?.remove();
      document.querySelector<HTMLElement>(".ip-linegraph-selection")?.remove();
      // Clear CSS selection class.
      for (const el of Array.from(stage.querySelectorAll<HTMLElement>(".node.is-selected"))) el.classList.remove("is-selected");
    } catch {
      // ignore
    }
  };

  const mkToolBtn = (id: typeof tool, label: string, iconHtml: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = iconHtml;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.style.border = "1px solid rgba(255,255,255,0.16)";
    b.style.borderRadius = "10px";
    b.style.width = "44px";
    b.style.height = "40px";
    b.style.padding = "0";
    b.style.background = "rgba(255,255,255,0.06)";
    b.style.color = "rgba(255,255,255,0.92)";
    b.style.fontWeight = "800";
    b.style.display = "grid";
    (b.style as any).placeItems = "center";
    b.addEventListener("click", () => {
      setTool(id);
    });
    return b;
  };

  const ICON = {
    select: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 3l8 18 2.2-6.2L21 12 4 3z" fill="currentColor" opacity="0.92"/>
    </svg>`,
    text: `<span style="display:inline-grid;place-items:center;border:1px dashed rgba(255,255,255,0.55);border-radius:6px;padding:2px 6px;font-weight:900;line-height:1;">Aa</span>`,
    bullets: `<svg width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden="true">
      <circle cx="3" cy="4" r="1.4" fill="currentColor" opacity="0.92"/>
      <circle cx="3" cy="9" r="1.4" fill="currentColor" opacity="0.92"/>
      <circle cx="3" cy="14" r="1.4" fill="currentColor" opacity="0.92"/>
      <path d="M7 4h14M7 9h14M7 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.92"/>
    </svg>`,
    arrow: `<svg width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden="true">
      <path d="M2 9h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M12 4l6 5-6 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    line: `<svg width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden="true">
      <path d="M2 9h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`
  };
  const btnSelect = mkToolBtn("select", "Select", ICON.select);
  const btnText = mkToolBtn("text", "Text", ICON.text);
  const btnBullets = mkToolBtn("bullets", "Bullets", ICON.bullets);
  const btnArrow = mkToolBtn("arrow", "Arrow", ICON.arrow);
  const btnLine = mkToolBtn("line", "Line", ICON.line);
  btnSelect.dataset.toolId = "select";
  btnText.dataset.toolId = "text";
  btnBullets.dataset.toolId = "bullets";
  btnArrow.dataset.toolId = "arrow";
  btnLine.dataset.toolId = "line";
  const btnColor = document.createElement("button");
  btnColor.type = "button";
  btnColor.title = "Default color for new text/lines/arrows";
  btnColor.setAttribute("aria-label", "Default draw color");
  btnColor.style.border = "1px solid rgba(255,255,255,0.16)";
  btnColor.style.borderRadius = "10px";
  btnColor.style.width = "44px";
  btnColor.style.height = "40px";
  btnColor.style.padding = "0";
  // Fill the entire button with the chosen color (no margins).
  btnColor.style.background = drawColor;
  btnColor.style.color = "rgba(255,255,255,0.92)";
  btnColor.style.display = "grid";
  (btnColor.style as any).placeItems = "center";
  btnColor.style.position = "relative";
  btnColor.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,0.35)";

  // Hidden native color input (so we get OS picker).
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = drawColor;
  colorInput.style.position = "absolute";
  colorInput.style.inset = "0";
  colorInput.style.opacity = "0";
  colorInput.style.cursor = "pointer";
  colorInput.style.border = "none";
  colorInput.style.padding = "0";
  colorInput.addEventListener("input", () => {
    const v = String(colorInput.value ?? "").trim();
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    drawColor = v;
    stage.dataset.drawColor = v;
    btnColor.style.background = v;
    try {
      localStorage.setItem("ip_drawColor", v);
    } catch {}
  });
  btnColor.appendChild(colorInput);

  toolbox.append(btnSelect, btnText, btnBullets, btnArrow, btnLine, btnColor);
  // Default active tool (avoid relying on synthetic click)
  setTool("select");
  stage.dataset.drawColor = drawColor;
  // Avoid duplicating if attachEditor is called multiple times.
  document.querySelector(".edit-toolbox")?.remove();
  document.body.appendChild(toolbox);

  // If the engine model is replaced while we're in isolate modes (composite edit / group edit / screen edit),
  // the engine recreates DOM nodes, which can drop dataset/class-based interaction state.
  // Wrap setModel once to re-apply those states deterministically after any setModel().
  const anyEngine = engine as any;
  if (!anyEngine.__ip_setModelWrapped) {
    anyEngine.__ip_setModelWrapped = true;
    const origSetModel = engine.setModel.bind(engine);
    engine.setModel = ((m: any) => {
      origSetModel(m);
      try {
        // Re-apply regular group edit dimming (if active).
        const gid = activeGroupEditId?.();
        if (gid) {
          // Restore group edit dimming after model replacement.
          try {
            (anyEngine.__ip_applyGroupEditDimming ?? null)?.();
          } catch {}
        }
        // Re-apply composite edit marker + layer pointer-events (if active).
        const compositeId =
          typeof (window as any).__ip_compositeEditing === "boolean" && (window as any).__ip_compositeEditing
            ? (anyEngine.__ip_lastCompositeId ?? null)
            : null;
        const id = String(compositeId ?? "");
        if (id) {
          const el = engine.getNodeElement(id);
          if (el && el.dataset.compositeEditing !== "1") {
            const prev = el.dataset.compositeEditing;
            el.dataset.compositeEditing = "1";
            const layer =
              el.querySelector<HTMLElement>(".timer-sub-layer") ?? el.querySelector<HTMLElement>(".sound-sub-layer") ?? null;
            if (layer) layer.style.pointerEvents = "auto";
            void prev;
          }
        }
      } catch {
        // ignore
      }
    }) as any;
  }

  const getActiveViewId = () => stage.dataset.viewId || activeViewId || "home";

  const nextId = (prefix: string) => {
    const m = engine.getModel();
    const ids = new Set((m?.nodes ?? []).map((n) => n.id));
    for (let i = 1; i < 10000; i++) {
      const id = `${prefix}${i}`;
      if (!ids.has(id)) return id;
    }
    return `${prefix}${Date.now()}`;
  };

  const anchorOffsetPxLocal = (anchor: string | undefined, w: number, h: number) => {
    switch (anchor) {
      case "center":
      case "centerCenter":
        return { dx: -w / 2, dy: -h / 2 };
      case "top":
      case "topCenter":
        return { dx: -w / 2, dy: 0 };
      case "bottom":
      case "bottomCenter":
        return { dx: -w / 2, dy: -h };
      case "left":
      case "centerLeft":
        return { dx: 0, dy: -h / 2 };
      case "right":
      case "centerRight":
        return { dx: -w, dy: -h / 2 };
      case "topRight":
        return { dx: -w, dy: 0 };
      case "bottomLeft":
        return { dx: 0, dy: -h };
      case "bottomRight":
        return { dx: -w, dy: -h };
      case "topLeft":
      default:
        return { dx: 0, dy: 0 };
    }
  };

  const rectCornersWorld = (t: any) => {
    const w = Number(t.w ?? 0);
    const h = Number(t.h ?? 0);
    const { dx, dy } = anchorOffsetPxLocal(t.anchor, w, h);
    const rot = (Number(t.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const ax = Number(t.x ?? 0);
    const ay = Number(t.y ?? 0);
    const pts = [
      { x: dx, y: dy },
      { x: dx + w, y: dy },
      { x: dx + w, y: dy + h },
      { x: dx, y: dy + h }
    ];
    return pts.map((p) => ({ x: ax + p.x * cos - p.y * sin, y: ay + p.x * sin + p.y * cos }));
  };

  // Regular group edit (node type "group"):
  // Outside group edit, clicks on children resolve to the top-most group for ergonomics.
  // Inside group edit, children should be directly selectable/editable.
  const isDescendantOf = (id0: string, ancestorId: string, model: any) => {
    const seen = new Set<string>();
    let id = String(id0 ?? "");
    const anc = String(ancestorId ?? "");
    if (!id || !anc) return false;
    while (true) {
      if (id === anc) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const n: any = model?.nodes?.find((x: any) => String(x.id) === id);
      const p = String(n?.parentId ?? "").trim();
      if (!p) return false;
      id = p;
    }
  };
  let groupEdit: ReturnType<typeof createGroupEditController> | null = null;
  const activeGroupEditId = () => groupEdit?.activeId?.() ?? null;

  const resolveSelectableId = (id0: string) => {
    const m = engine.getModel();
    const gid = activeGroupEditId();
    // In group edit mode: do NOT bubble selection to the parent group.
    if (gid && m && isDescendantOf(id0, gid, m)) return String(id0);
    let id = id0;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(id)) return id0;
      seen.add(id);
      const n: any = m?.nodes.find((x) => x.id === id);
      const p = String(n?.parentId ?? "").trim();
      if (!p) return id;
      id = p;
    }
  };

  // --- Parent/group transforms (mirror engine layout) ---
  const _worldTransformForId = (id0: string, model: any, memo?: Map<string, any>, resolving?: Set<string>): any => {
    const id = String(id0 ?? "");
    if (!id || !model) return null;
    const mm = memo ?? new Map<string, any>();
    const rs = resolving ?? new Set<string>();
    if (mm.has(id)) return mm.get(id);
    if (rs.has(id)) return null;
    rs.add(id);
    const node: any = model.nodes.find((n: any) => String(n.id) === id);
    if (!node || node.space !== "world") {
      rs.delete(id);
      mm.set(id, node?.transform ?? null);
      return node?.transform ?? null;
    }
    const parentId = String(node.parentId ?? "").trim();
    if (!parentId) {
      rs.delete(id);
      mm.set(id, node.transform ?? null);
      return node.transform ?? null;
    }
    const pt = _worldTransformForId(parentId, model, mm, rs) ?? (model.nodes.find((n: any) => String(n.id) === parentId) as any)?.transform;
    const pr = (Number(pt?.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(pr);
    const sin = Math.sin(pr);
    const scale = Math.max(1e-6, Number(pt?.h ?? 1));
    const lt = node.transform ?? { x: 0, y: 0, w: 0.1, h: 0.05 };
    const lx = Number(lt.x ?? 0) * scale;
    const ly = Number(lt.y ?? 0) * scale;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    const out = {
      x: Number(pt?.x ?? 0) + rx,
      y: Number(pt?.y ?? 0) + ry,
      w: Number(lt.w ?? 0.1) * scale,
      h: Number(lt.h ?? 0.05) * scale,
      rotationDeg: Number(pt?.rotationDeg ?? 0) + Number(lt.rotationDeg ?? 0),
      anchor: lt.anchor ?? pt?.anchor ?? "topLeft"
    };
    rs.delete(id);
    mm.set(id, out);
    return out;
  };

  const _uiNodeForId = (id: string, model: any) => {
    const node: any = model?.nodes?.find((n: any) => String(n.id) === String(id));
    if (!node) return { node: null, ui: null, parentWorld: null };
    const parentId = String(node.parentId ?? "").trim();
    if (!parentId || node.space !== "world") return { node, ui: node, parentWorld: null };
    const memo = new Map<string, any>();
    const worldT = _worldTransformForId(id, model, memo, new Set<string>());
    const parentWorld = _worldTransformForId(parentId, model, memo, new Set<string>());
    const ui = { ...node, transform: worldT ?? node.transform };
    return { node, ui, parentWorld };
  };

  const _worldPointToLocal = (parentWorld: any, worldX: number, worldY: number) => {
    const pr = (Number(parentWorld?.rotationDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(pr);
    const sin = Math.sin(pr);
    const scale = Math.max(1e-6, Number(parentWorld?.h ?? 1));
    const dx = worldX - Number(parentWorld?.x ?? 0);
    const dy = worldY - Number(parentWorld?.y ?? 0);
    const lx = (dx * cos + dy * sin) / scale;
    const ly = (-dx * sin + dy * cos) / scale;
    return { x: lx, y: ly };
  };

  const _toLocalTransformFromWorld = (worldT: any, parentWorld: any, localAnchor: string | undefined) => {
    if (!parentWorld) return worldT;
    const p = _worldPointToLocal(parentWorld, Number(worldT?.x ?? 0), Number(worldT?.y ?? 0));
    const scale = Math.max(1e-6, Number(parentWorld?.h ?? 1));
    return {
      x: p.x,
      y: p.y,
      w: Number(worldT?.w ?? 0.1) / scale,
      h: Number(worldT?.h ?? 0.05) / scale,
      rotationDeg: Number(worldT?.rotationDeg ?? 0) - Number(parentWorld?.rotationDeg ?? 0),
      anchor: localAnchor ?? "topLeft"
    };
  };

  // Context menu removed (toolbar replaces it).

  const addTextAt = async (
    pos: { x: number; y: number },
    opts?: { space?: "world" | "screen" }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("text");
    const space = opts?.space === "screen" ? "screen" : "world";
    const isScreen = space === "screen";
    const scr = engine.getScreen();
    const pxToFrac = (p: { x: number; y: number }) =>
      scr.w > 0 && scr.h > 0 ? { x: p.x / scr.w, y: p.y / scr.h } : { x: 0, y: 0 };
    const node: any = {
      id,
      type: "text",
      space,
      text: "New text",
      color: drawColor,
      align: "center",
      transform: {
        x: isScreen ? pxToFrac(pos).x : pos.x,
        y: isScreen ? pxToFrac(pos).y : pos.y,
        // Screen-space sizes are normalized; derive from current pixel size targets.
        w: isScreen ? 420 / Math.max(1, scr.w) : 520,
        h: isScreen ? 80 / Math.max(1, scr.h) : 80,
        anchor: "centerCenter",
        rotationDeg: 0
      }
    };
    model.nodes.push(node);
    if (isScreen) {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    hydrateTextMath(engine, model);
    selected.clear();
    selected.add(id);
    applySelection();
    await commit(before);
  };

  const addTableAt = async (
    pos: { x: number; y: number },
    opts?: { space?: "world" | "screen" }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("table");
    const space = opts?.space === "screen" ? "screen" : "world";
    const isScreen = space === "screen";
    const scr = engine.getScreen();
    const pxToFrac = (p: { x: number; y: number }) =>
      scr.w > 0 && scr.h > 0 ? { x: p.x / scr.w, y: p.y / scr.h } : { x: 0, y: 0 };
    const node: any = {
      id,
      type: "table",
      space,
      delimiter: ";",
      hstyle: "||c|c|c|c||",
      vstyle: "|b||c|...|",
      // Default: 20 rows x 4 columns, empty (Excel-like data entry).
      rows: Array.from({ length: 20 }, () => Array.from({ length: 4 }, () => "")),
      transform: {
        x: isScreen ? pxToFrac(pos).x : pos.x,
        y: isScreen ? pxToFrac(pos).y : pos.y,
        w: isScreen ? 520 / Math.max(1, scr.w) : 720,
        h: isScreen ? 260 / Math.max(1, scr.h) : 320,
        anchor: "centerCenter",
        rotationDeg: 0
      }
    };
    model.nodes.push(node);
    if (isScreen) {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    hydrateTextMath(engine, model);
    selected.clear();
    selected.add(id);
    applySelection();
    await commit(before);
  };

  const addBulletsAt = async (
    pos: { x: number; y: number },
    opts?: { space?: "world" | "screen" }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("bullets");
    const space = opts?.space === "screen" ? "screen" : "world";
    const isScreen = space === "screen";
    const scr = engine.getScreen();
    const pxToFrac = (p: { x: number; y: number }) =>
      scr.w > 0 && scr.h > 0 ? { x: p.x / scr.w, y: p.y / scr.h } : { x: 0, y: 0 };
    const node: any = {
      id,
      type: "bullets",
      space,
      bullets: "A",
      items: ["First", "Second", "Third"],
      fontPx: 22,
      color: drawColor,
      transform: {
        x: isScreen ? pxToFrac(pos).x : pos.x,
        y: isScreen ? pxToFrac(pos).y : pos.y,
        w: isScreen ? 520 / Math.max(1, scr.w) : 520,
        h: isScreen ? 220 / Math.max(1, scr.h) : 220,
        anchor: "centerCenter",
        rotationDeg: 0
      }
    };
    model.nodes.push(node);
    if (isScreen) {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    hydrateTextMath(engine, model);
    selected.clear();
    selected.add(id);
    applySelection();
    await commit(before);
  };

  const addArrowFromTo = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { space?: "world" | "screen" }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("arrow");
    const space = opts?.space === "screen" ? "screen" : "world";

    // Fit a bbox around the two clicked points, with padding, so the clicked points are
    // the true endpoints even when we need a minimum bbox thickness (avoids the "always diagonal" feel).
    const wPx = 4; // default stroke px
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const padPx = 24; // visual padding so endpoints aren't stuck on bbox edges
    const pad = space === "world" ? padPx / Math.max(1e-9, cam.zoom) : padPx;
    const minSize = space === "world" ? 10 : 10; // in the same units as from/to

    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const w0 = Math.max(minSize, dx + 2 * pad);
    const h0 = Math.max(minSize, dy + 2 * pad);
    const x0 = cx - w0 / 2;
    const y0 = cy - h0 / 2;

    const fx = (from.x - x0) / w0;
    const fy = (from.y - y0) / h0;
    const tx = (to.x - x0) / w0;
    const ty = (to.y - y0) / h0;

    const xN = space === "screen" ? x0 / Math.max(1, scr.w) : x0;
    const yN = space === "screen" ? y0 / Math.max(1, scr.h) : y0;
    const wN = space === "screen" ? w0 / Math.max(1, scr.w) : w0;
    const hN = space === "screen" ? h0 / Math.max(1, scr.h) : h0;

    const node: any = {
      id,
      type: "arrow",
      space,
      from: { x: fx, y: fy },
      to: { x: tx, y: ty },
      color: drawColor,
      width: wPx,
      transform: { x: xN, y: yN, w: wN, h: hN, anchor: "topLeft", rotationDeg: 0 }
    };
    model.nodes.push(node);

    if (space === "screen") {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    hydrateTextMath(engine, model);
    selected.clear();
    selected.add(id);
    applySelection();
    await commit(before);
  };

  const addLineFromTo = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { space?: "world" | "screen"; select?: boolean }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("line");
    const space = opts?.space === "screen" ? "screen" : "world";
    const selectNew = opts?.select !== false;

    const wPx = 4; // default stroke px
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const padPx = 24;
    const pad = space === "world" ? padPx / Math.max(1e-9, cam.zoom) : padPx;
    const minSize = space === "world" ? 10 : 10;

    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const w0 = Math.max(minSize, dx + 2 * pad);
    const h0 = Math.max(minSize, dy + 2 * pad);
    const x0 = cx - w0 / 2;
    const y0 = cy - h0 / 2;

    const fx = (from.x - x0) / w0;
    const fy = (from.y - y0) / h0;
    const tx = (to.x - x0) / w0;
    const ty = (to.y - y0) / h0;

    const xN = space === "screen" ? x0 / Math.max(1, scr.w) : x0;
    const yN = space === "screen" ? y0 / Math.max(1, scr.h) : y0;
    const wN = space === "screen" ? w0 / Math.max(1, scr.w) : w0;
    const hN = space === "screen" ? h0 / Math.max(1, scr.h) : h0;

    // Persist connectivity between line segments via junction IDs.
    // - Each endpoint gets a join ID (p1Join / p2Join).
    // - If the endpoint is close to an existing endpoint, reuse its join ID (creating it if missing).
    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;
    // Keep joins within the same parentId so connected components behave like a single graph
    // even inside groups.
    const newParentId = String(activeGroupEditId() ?? "").trim();
    const ensureJoin = (n0: any, key: "p1Join" | "p2Join") => {
      const v = String(n0?.[key] ?? "").trim();
      if (v) return v;
      const j = nextId("j");
      (n0 as any)[key] = j;
      return j;
    };
    const endpointUiPt = (n0: any, which: "p1" | "p2") => {
      const { ui } = _uiNodeForId(String(n0.id), model);
      const tN = (ui as any)?.transform ?? n0.transform ?? {};
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const tt = (n0 as any).to ?? { x: 1, y: 0.5 };
      const tl = anchorToTopLeftWorld({
        x: Number(tN.x ?? 0),
        y: Number(tN.y ?? 0),
        w: Number(tN.w ?? 1),
        h: Number(tN.h ?? 1),
        anchor: tN.anchor ?? "topLeft"
      } as any);
      const w = Math.max(1e-9, Number(tN.w ?? 1));
      const h = Math.max(1e-9, Number(tN.h ?? 1));
      const p1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
      const p2 = { x: tl.x + Number(tt.x ?? 1) * w, y: tl.y + Number(tt.y ?? 0) * h };
      return which === "p1" ? p1 : p2;
    };
    const uiToScreen = (sp: "world" | "screen", p: { x: number; y: number }) =>
      sp === "world" ? worldToScreen(p, cam as any, scr as any) : { x: p.x * scr.w, y: p.y * scr.h };

    // New endpoints in screen pixels (stable distance metric)
    const newP1s = space === "world" ? worldToScreen(from, cam as any, scr as any) : { x: from.x, y: from.y };
    const newP2s = space === "world" ? worldToScreen(to, cam as any, scr as any) : { x: to.x, y: to.y };

    const pickExistingJoin = (pScreen: { x: number; y: number }) => {
      let best: { n0: any; end: "p1" | "p2"; d2: number } | null = null;
      for (const n0 of model.nodes as any[]) {
        if (!n0 || String(n0.type) !== "line") continue;
        if (String(n0.space ?? "world") !== space) continue;
        const pid = String((n0 as any).parentId ?? "").trim();
        if (pid !== newParentId) continue;
        const q1 = endpointUiPt(n0, "p1");
        const q2 = endpointUiPt(n0, "p2");
        const q1s = uiToScreen(space, q1);
        const q2s = uiToScreen(space, q2);
        const d1 = (q1s.x - pScreen.x) ** 2 + (q1s.y - pScreen.y) ** 2;
        const d2 = (q2s.x - pScreen.x) ** 2 + (q2s.y - pScreen.y) ** 2;
        if (d1 <= tolPx2 && (!best || d1 < best.d2)) best = { n0, end: "p1", d2: d1 };
        if (d2 <= tolPx2 && (!best || d2 < best.d2)) best = { n0, end: "p2", d2: d2 };
      }
      if (!best) return null;
      const key = best.end === "p1" ? "p1Join" : "p2Join";
      return ensureJoin(best.n0, key);
    };

    const p1Join = pickExistingJoin(newP1s) ?? nextId("j");
    const p2Join = pickExistingJoin(newP2s) ?? nextId("j");

    const node: any = {
      id,
      type: "line",
      space,
      from: { x: fx, y: fy },
      to: { x: tx, y: ty },
      color: drawColor,
      width: wPx,
      p1Join,
      p2Join,
      ...(newParentId ? { parentId: newParentId } : {}),
      transform: { x: xN, y: yN, w: wN, h: hN, anchor: "topLeft", rotationDeg: 0 }
    };
    model.nodes.push(node);

    if (space === "screen") {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    hydrateTextMath(engine, model);
    if (selectNew) {
    selected.clear();
    selected.add(id);
    applySelection();
    }
    await commit(before);
  };

  // Table click-away commit is handled by the runtime `table` plugin.

  const addImageAt = async (
    pos: { x: number; y: number },
    file: File,
    opts?: { space?: "world" | "screen" }
  ) => {
    const model = engine.getModel();
    if (!model) return;
    const before = cloneModel(model);
    const id = nextId("image");
    const space = opts?.space === "screen" ? "screen" : "world";
    const isScreen = space === "screen";
    const scr = engine.getScreen();
    const pxToFrac = (p: { x: number; y: number }) =>
      scr.w > 0 && scr.h > 0 ? { x: p.x / scr.w, y: p.y / scr.h } : { x: 0, y: 0 };

    const up = await uploadImageToMedia(file);
    const size = await loadImageSize(up.src);

    const baseW = isScreen ? 420 : 520;
    const baseH = isScreen ? 260 : 320;
    const ratio = size && size.w > 0 ? size.h / size.w : baseH / baseW;
    const w = baseW;
    const h = Math.max(40, Math.round(w * ratio));

    const node: any = {
      id,
      type: "image",
      space,
      src: up.src,
      transform: {
        x: isScreen ? pxToFrac(pos).x : pos.x,
        y: isScreen ? pxToFrac(pos).y : pos.y,
        w: isScreen ? w / Math.max(1, scr.w) : w,
        h: isScreen ? h / Math.max(1, scr.h) : h,
        anchor: "centerCenter",
        rotationDeg: 0
      }
    };
    model.nodes.push(node);
    if (isScreen) {
      for (const v of model.views) {
        if (!v.show.includes(id)) v.show.push(id);
      }
    } else {
      const viewId = getActiveViewId();
      const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
      if (view && !view.show.includes(id)) view.show.push(id);
    }
    engine.setModel(cloneModel(model));
    preloadImageAssets(model);
    selected.clear();
    selected.add(id);
    applySelection();
    await commit(before);
  };

  // Single persistent image picker for context menu (avoid creating one per right-click).
  const imagePicker = document.createElement("input");
  imagePicker.type = "file";
  imagePicker.accept = "image/*";
  imagePicker.multiple = false;
  imagePicker.style.display = "none";
  stage.appendChild(imagePicker);
  let pendingImagePick: { pos: { x: number; y: number }; space: "world" | "screen" } | null = null;
  (window as any).__ip_pickImage = (pos: { x: number; y: number }, space: "world" | "screen") => {
    pendingImagePick = { pos, space };
    imagePicker.click();
  };
  imagePicker.addEventListener("change", async () => {
    const f = imagePicker.files?.[0];
    imagePicker.value = "";
    if (!f || !pendingImagePick) return;
    const { pos, space } = pendingImagePick;
    pendingImagePick = null;
    await addImageAt(pos, f, { space });
  });

  const groupSelection = async () => {
    const model = engine.getModel();
    if (!model) return;
    const ids = Array.from(selected);
    if (ids.length < 2) return;
    const nodesById = new Map(model.nodes.map((n: any) => [n.id, n]));
    const nodes = ids.map((id) => nodesById.get(id)).filter(Boolean) as any[];
    if (nodes.length < 2) return;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      const cs = rectCornersWorld(n.transform);
      for (const p of cs) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const gw = Math.max(10, maxX - minX);
    const gh = Math.max(10, maxY - minY);
    const gx = (minX + maxX) / 2;
    const gy = (minY + maxY) / 2;
    const gid = nextId("group");

    const before = cloneModel(model);
    const groupNode: any = {
      id: gid,
      type: "group",
      space: "world",
      transform: { x: gx, y: gy, w: gw, h: gh, anchor: "centerCenter", rotationDeg: 0 }
    };
    model.nodes.push(groupNode);

    const viewId = getActiveViewId();
    const view = model.views.find((v) => v.id === viewId) ?? model.views[0];
    if (view && !view.show.includes(gid)) view.show.unshift(gid);

    for (const n of nodes) {
      const t = n.transform ?? {};
      n.parentId = gid;
      n.transform = {
        ...t,
        x: (Number(t.x ?? 0) - gx) / gh,
        y: (Number(t.y ?? 0) - gy) / gh,
        w: Number(t.w ?? 1) / gh,
        h: Number(t.h ?? 1) / gh
      };
      delete n.fontPx;
    }

    engine.setModel(cloneModel(model));
    selected.clear();
    selected.add(gid);
    applySelection();
    await commit(before);
  };

  // (context menu removed)

  // Drag-and-drop image upload (edit mode)
  stage.addEventListener("dragover", (ev) => {
    const mode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
    if (mode !== "edit") return;
    ev.preventDefault();
  });
  stage.addEventListener("drop", async (ev) => {
    const mode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
    if (mode !== "edit") return;
    ev.preventDefault();

    const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;

    const r = stage.getBoundingClientRect();
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const basePos = screenEditMode ? screenPos : screenToWorld(screenPos, cam as any, scr as any);
    const space: "world" | "screen" = screenEditMode ? "screen" : "world";

    // Drop multiple images with a small offset so they don't stack perfectly.
    for (let i = 0; i < files.length; i++) {
      const off = 16 * i;
      await addImageAt({ x: basePos.x + off, y: basePos.y + off }, files[i], { space });
    }
  });

  let dragMode: DragMode = "none";
  let activeHandle: string | null = null;
  let start = { x: 0, y: 0 };
  let startSnapshot: PresentationModel | null = null;
  let startNodesById: Record<string, any> | null = null;
  // Only push to undo history when the model actually changed due to a drag/resize/rotate.
  // Otherwise, selection clicks would spam history (bad ctrl+z/ctrl+y UX).
  let dragDirty = false;
  let startAngleRad = 0;
  let startRotationDeg = 0;
  const lineGraphDrag = createLineGraphDrag({
    engine,
    gridSpacingForZoom,
    worldToScreen,
    anchorToTopLeftWorld,
    uiNodeForId: _uiNodeForId,
    toLocalTransformFromWorld: _toLocalTransformFromWorld,
  });
  // For composite-heavy nodes (timer/sound) we delay starting drag until the user actually moves,
  // otherwise the immediate pointerdown preventDefault can suppress native dblclick.
  let pendingCompositeDrag:
    | null
    | {
        pointerId: number;
        id: string;
        node: any;
        nodeEl: HTMLElement;
        startClientX: number;
        startClientY: number;
        hnd: string | null;
      } = null;

  // Line-graph (polyline) rigid transform box drag state.
  // (The selection overlay is mounted on document.body, so events are handled on window capture.)
  let lineGraphBoxDrag:
    | null
    | {
        pointerId: number;
        seedId: string;
        handle: string; // "move" | resize handle ("n/s/e/w/se/sw/...") | "rot-*"
        startClientX: number;
        startClientY: number;
        centerClientX: number;
        centerClientY: number;
        before: PresentationModel | null;
        startNodesById: Record<string, any>;
        dirty: boolean;
      } = null;
  const isLineGraphBoxTarget = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.(".ip-linegraph-selection") as HTMLElement | null;

  // Right-button marquee selection state (rect select, in client coords).
  let rectSelect:
    | null
    | {
        pointerId: number;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        el: HTMLDivElement;
        dirty: boolean;
        shiftKey: boolean;
        ctrlKey: boolean;
      } = null;
  let lastCompositeClick:
    | null
    | {
        id: string;
        tMs: number;
        x: number;
        y: number;
      } = null;

  const cursorForHandle = (h: string | null) => {
    if (!h) return "";
    if (h === "rot" || h.startsWith("rot-")) return rotationCursorCss(0);
    if (h === "n" || h === "s") return resizeCursorCss(90);
    if (h === "e" || h === "w") return resizeCursorCss(0);
    if (h === "nw" || h === "se") return resizeCursorCss(45);
    if (h === "ne" || h === "sw") return resizeCursorCss(135);
    return "";
  };
  const cursorForHandleWithRotation = (h: string | null, rotDeg: number) => {
    if (!h) return "";
    if (h === "rot-tr") return rotationCursorCss(rotDeg - 45);
    if (h === "rot-tl") return rotationCursorCss(rotDeg - 135);
    if (h === "rot" || h.startsWith("rot-")) return rotationCursorCss(rotDeg);
    const norm = (deg: number) => {
      let d = deg % 360;
      if (d < 0) d += 360;
      return d;
    };
    const rotVec = (x: number, y: number, deg: number) => {
      const a = (norm(deg) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      return { x: x * cos - y * sin, y: x * sin + y * cos };
    };
    if (h === "n" || h === "s" || h === "e" || h === "w") {
      const axis = h === "n" || h === "s" ? 90 : 0;
      return resizeCursorCss(rotDeg + axis);
    }
    if (h === "nw" || h === "ne" || h === "sw" || h === "se") {
      const axis = h === "se" || h === "nw" ? 45 : 135;
      return resizeCursorCss(rotDeg + axis);
    }
    return cursorForHandle(h);
  };
  const setBodyCursor = (c: string) => {
    // IMPORTANT: cursor is resolved from the *element under the pointer*.
    // During drags, many elements set `cursor: grab`, which can override the closed-hand cursor.
    // To guarantee the cursor stays "closed hand" until pointerup, we apply a global force-cursor class.
    const cur = c || "";
    const root = document.documentElement;
    if (cur) {
      root.classList.add("ip-force-cursor");
      root.style.setProperty("--ip-force-cursor", cur);
    } else {
      root.classList.remove("ip-force-cursor");
      root.style.removeProperty("--ip-force-cursor");
    }
    root.style.cursor = cur;
    document.body.style.cursor = cur;
    stage.style.cursor = cur;
  };

  // Selection chrome (handles + composite selection box) is owned by the selection controller.

  // Cursor controller is created later (after hit-testing helpers are defined).
  let cursor: ReturnType<typeof createCursorController> | null = null;
  const updateStageCursorFromClientPoint = (clientX: number, clientY: number) => {
    if (!cursor) {
      if (getAppMode() !== "edit") stage.style.cursor = "";
      return;
    }
    cursor.updateFromClientPoint(clientX, clientY);
  };

  const localPtForRect = (rect: { left: number; top: number; width: number; height: number }, rotDeg: number, clientX: number, clientY: number) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const a = (-rotDeg * Math.PI) / 180; // inverse (screen -> local)
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return { lx, ly, hw: rect.width / 2, hh: rect.height / 2, cx, cy };
  };

  const isPointInRotatedRectClient = (rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }, rotDeg: number, clientX: number, clientY: number) => {
    const { lx, ly, hw, hh } = localPtForRect(rect, rotDeg, clientX, clientY);
    return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
  };

  const compHit = createCompositeHitTest({
    engine,
    ensureTimerCompositeLayer,
    ensureSoundCompositeLayer,
    ensureGraphCompositeLayer,
  });
  const effectiveNodeRectClient = compHit.effectiveNodeRectClient;
  const pickCompositeRootAtClientPoint = compHit.pickCompositeRootAtClientPoint;

  // Selection UI chrome (handles + composite selection box)
  selection = createSelectionController({
    stage,
    engine,
    selected,
    getAppMode,
    getCompositeEditState: () => ({ kind: compositeState.kind as any, id: compositeState.id as any }),
    ensureHandles: (el) => ensureHandles(el),
    effectiveNodeRectClient,
  });

  const isPointInsideNodeInteriorForNode = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const R = 20;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const eff = effectiveNodeRectClient(nodeEl, node);
    const rect = eff ?? nodeEl.getBoundingClientRect();
    const { lx, ly, hw, hh } = localPtForRect(rect, rotDeg, clientX, clientY);
    return Math.abs(lx) <= hw - R && Math.abs(ly) <= hh - R;
  };

  const normalizeAnchor = (a: string | undefined) => {
    if (!a) return "topLeft";
    if (a === "top") return "topCenter";
    if (a === "bottom") return "bottomCenter";
    if (a === "left") return "centerLeft";
    if (a === "right") return "centerRight";
    if (a === "center") return "centerCenter";
    return a;
  };

  const hiddenResizeHandlesForAnchor = (a0: string | undefined) => {
    const a = normalizeAnchor(a0);
    const ax = a.endsWith("Left") ? 0 : a.endsWith("Right") ? 1 : 0.5;
    const ay = a.startsWith("Top") ? 0 : a.startsWith("Bottom") ? 1 : 0.5;
    const hide = new Set<string>();
    // Hide resize edges that coincide with the anchor edge.
    if (ay === 0) hide.add("n");
    if (ay === 1) hide.add("s");
    if (ax === 0) hide.add("w");
    if (ax === 1) hide.add("e");
    // Hide scale corners that coincide with the anchor corner.
    // (We only have bottom scale corners in the UI: sw/se.)
    if (ax === 0 && ay === 1) hide.add("sw");
    if (ax === 1 && ay === 1) hide.add("se");
    return hide;
  };

  const isInForbiddenResizeBand = (rect: { left: number; top: number; width: number; height: number }, rotDeg: number, anchor: string | undefined, clientX: number, clientY: number) => {
    const hidden = hiddenResizeHandlesForAnchor(anchor);
    if (hidden.size === 0) return false;
    const R = 20;
    const { lx, ly, hw, hh } = localPtForRect(rect as any, rotDeg, clientX, clientY);
    const xMin = -hw + R;
    const xMax = hw - R;
    const yMin = -hh + R;
    const yMax = hh - R;
    // Corners (only scale corners exist: sw/se)
    if (hidden.has("sw")) {
      const d = Math.hypot(lx - (-hw), ly - hh);
      if (d <= R) return true;
    }
    if (hidden.has("se")) {
      const d = Math.hypot(lx - hw, ly - hh);
      if (d <= R) return true;
    }
    // Edges (exclude corners like the normal hit test)
    if (xMax >= xMin) {
      const dt = Math.abs(ly - (-hh));
      if (hidden.has("n") && dt <= R && lx >= xMin && lx <= xMax) return true;
      const db = Math.abs(ly - hh);
      if (hidden.has("s") && db <= R && lx >= xMin && lx <= xMax) return true;
    }
    if (yMax >= yMin) {
      const dl = Math.abs(lx - (-hw));
      if (hidden.has("w") && dl <= R && ly >= yMin && ly <= yMax) return true;
      const dr = Math.abs(lx - hw);
      if (hidden.has("e") && dr <= R && ly >= yMin && ly <= yMax) return true;
    }
    return false;
  };

  const hitTestTransformHandleForNode = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const eff = effectiveNodeRectClient(nodeEl, node);
    if (!eff) return hitTestTransformHandle(nodeEl, node, clientX, clientY);
    // Re-run the same math as hitTestTransformHandle but against the effective rect size/center.
    const R = 20;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    // IMPORTANT: if the pointer is in a forbidden resize band (anchor side), do NOT fall back to the opposite edge.
    if (isInForbiddenResizeBand(eff as any, rotDeg, node?.transform?.anchor, clientX, clientY)) return null;
    const { lx, ly, hw, hh } = localPtForRect(eff, rotDeg, clientX, clientY);
    type Cand = { handle: string; d: number };
    const cands: Cand[] = [];
    const hidden = hiddenResizeHandlesForAnchor(node?.transform?.anchor);
    const addCorner = (handle: string, x: number, y: number) => {
      if (hidden.has(handle)) return;
      const d = Math.hypot(lx - x, ly - y);
      if (d <= R) cands.push({ handle, d });
    };
    addCorner("rot-tl", -hw, -hh);
    addCorner("rot-tr", hw, -hh);
    addCorner("sw", -hw, hh);
    addCorner("se", hw, hh);
    const xMin = -hw + R;
    const xMax = hw - R;
    const yMin = -hh + R;
    const yMax = hh - R;
    if (xMax >= xMin) {
      const dt = Math.abs(ly - (-hh));
      if (dt <= R && lx >= xMin && lx <= xMax && !hidden.has("n")) cands.push({ handle: "n", d: dt });
      const db = Math.abs(ly - hh);
      if (db <= R && lx >= xMin && lx <= xMax && !hidden.has("s")) cands.push({ handle: "s", d: db });
    }
    if (yMax >= yMin) {
      const dl = Math.abs(lx - (-hw));
      if (dl <= R && ly >= yMin && ly <= yMax && !hidden.has("w")) cands.push({ handle: "w", d: dl });
      const dr = Math.abs(lx - hw);
      if (dr <= R && ly >= yMin && ly <= yMax && !hidden.has("e")) cands.push({ handle: "e", d: dr });
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0].handle;
  };

  // Arrow/line hit-testing (screen space):
  // - endpoint balls: radius 20px around each endpoint
  // - translate region: within 20px of the segment, excluding the endpoint balls
  // - closest wins
  const hitTestSegmentHandle = (nodeEl: HTMLElement, clientX: number, clientY: number) => {
    const R = 20;
    const r = nodeEl.getBoundingClientRect();
    const fx = Number(nodeEl.dataset.fromX ?? "0");
    const fy = Number(nodeEl.dataset.fromY ?? "0.5");
    const tx = Number(nodeEl.dataset.toX ?? "1");
    const ty = Number(nodeEl.dataset.toY ?? "0.5");
    const p1 = { x: r.left + fx * r.width, y: r.top + fy * r.height };
    const p2 = { x: r.left + tx * r.width, y: r.top + ty * r.height };

    const d1 = Math.hypot(clientX - p1.x, clientY - p1.y);
    const d2 = Math.hypot(clientX - p2.x, clientY - p2.y);

    type Cand = { handle: "p1" | "p2" | "mid"; d: number };
    const cands: Cand[] = [];
    if (d1 <= R) cands.push({ handle: "p1", d: d1 });
    if (d2 <= R) cands.push({ handle: "p2", d: d2 });

    const vx = p2.x - p1.x;
    const vy = p2.y - p1.y;
    const len = Math.hypot(vx, vy);
    if (len > 1e-6) {
      // closest distance to segment
      let t = ((clientX - p1.x) * vx + (clientY - p1.y) * vy) / (len * len);
      t = Math.max(0, Math.min(1, t));
      const proj = { x: p1.x + vx * t, y: p1.y + vy * t };
      const dLine = Math.hypot(clientX - proj.x, clientY - proj.y);
      const tMin = Math.min(0.5, R / len);
      const tMax = Math.max(0.5, 1 - R / len);
      if (dLine <= R && t >= tMin && t <= tMax) cands.push({ handle: "mid", d: dLine });
    }

    if (cands.length === 0) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0].handle;
  };

  // Connected component for lines, based on endpoint proximity in screen space.
  // (We intentionally do NOT use join ids here: join ids can be stale or reused across disconnected graphs.)
  const collectConnectedLineIdsByProximity = (seedId: string, model: any) => {
    const seed = model?.nodes?.find?.((n: any) => String(n?.id ?? "") === String(seedId));
    if (!seed || String(seed.type) !== "line") return [String(seedId)];
    const space = String(seed.space ?? "world");
    const parentId = String((seed as any).parentId ?? "").trim();

    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;
    const cell = tolPx;
    const keyFor = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const buckets = new Map<string, Array<{ id: string; x: number; y: number }>>();
    const endpointsById = new Map<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>();

    const put = (id: string, p: { x: number; y: number }) => {
      const k = keyFor(p.x, p.y);
      const arr = buckets.get(k) ?? [];
      arr.push({ id, x: p.x, y: p.y });
      buckets.set(k, arr);
    };

    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any).parentId ?? "").trim();
      if (pid !== parentId) continue;
      const id = String(n0.id ?? "");
      if (!id) continue;
      const el = engine.getNodeElement(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0.5 && r.height > 0.5)) continue;
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
      const p1 = { x: r.left + Number(fr.x ?? 0) * r.width, y: r.top + Number(fr.y ?? 0.5) * r.height };
      const p2 = { x: r.left + Number(to.x ?? 1) * r.width, y: r.top + Number(to.y ?? 0.5) * r.height };
      endpointsById.set(id, { p1, p2 });
      put(id, p1);
      put(id, p2);
    }

    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };
    const near = (a: { p1: any; p2: any }, b: { p1: any; p2: any }) => {
      return (
        dist2(a.p1, b.p1) <= tolPx2 ||
        dist2(a.p1, b.p2) <= tolPx2 ||
        dist2(a.p2, b.p1) <= tolPx2 ||
        dist2(a.p2, b.p2) <= tolPx2
      );
    };
    const neighborKeys = (p: { x: number; y: number }) => {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      const out: string[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(`${cx + dx},${cy + dy}`);
      return out;
    };

    const sid = String(seedId);
    if (!endpointsById.has(sid)) return [sid];
    const visited = new Set<string>();
    const q: string[] = [sid];
    visited.add(sid);
    while (q.length) {
      const cur = q.shift()!;
      const epCur = endpointsById.get(cur);
      if (!epCur) continue;
      const candIds = new Set<string>();
      for (const k of neighborKeys(epCur.p1)) for (const it of buckets.get(k) ?? []) candIds.add(it.id);
      for (const k of neighborKeys(epCur.p2)) for (const it of buckets.get(k) ?? []) candIds.add(it.id);
      for (const nid of candIds) {
        if (visited.has(nid)) continue;
        const epN = endpointsById.get(nid);
        if (!epN) continue;
        if (!near(epCur, epN)) continue;
        visited.add(nid);
        q.push(nid);
      }
    }
    return Array.from(visited);
  };

  const setLineGraphMode = (mode: "" | "graph" | "vertex", id?: string, which?: "p1" | "p2") => {
    if (!mode) {
      delete (stage.dataset as any).lineGraphMode;
      delete (stage.dataset as any).lineGraphVertexLineId;
      delete (stage.dataset as any).lineGraphVertexWhich;
      return;
    }
    stage.dataset.lineGraphMode = mode;
    if (mode === "vertex") {
      stage.dataset.lineGraphVertexLineId = String(id ?? "");
      stage.dataset.lineGraphVertexWhich = String(which ?? "");
    } else {
      delete (stage.dataset as any).lineGraphVertexLineId;
      delete (stage.dataset as any).lineGraphVertexWhich;
    }
  };

  // Hover cursor controller (smallest-hit picking, arrows/lines, composite edit affordances)
  cursor = createCursorController({
    stage,
    engine,
    selected,
    getAppMode,
    getTool: () => getTool(),
    // IMPORTANT:
    // Cursor controller must not fight composite/group edit dragging.
    // Composite edit drag state lives in the composite controller (separate from `dragMode`),
    // so we mirror it via a window flag.
    getDragMode: () => (dragMode !== "none" ? dragMode : (window as any).__ip_compositeDragging ? "composite" : "none"),
    getCompositeEditId: () => (compositeState.id ? String(compositeState.id) : null),
    isScreenEditMode: () => !!screenEditMode,
    activeGroupEditId,
    isDescendantOf,
    resolveSelectableId,
    uiNodeForId: (id, model) => _uiNodeForId(id, model),
    hitTestSegmentHandle,
    hitTestTransformHandleForNode,
    isPointInsideNodeInteriorForNode,
    cursorForHandleWithRotation,
    effectiveNodeRectClient,
  });

  const localPtForNode = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const w = Math.max(1, nodeEl.clientWidth);
    const h = Math.max(1, nodeEl.clientHeight);
    const rect = nodeEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const a = (-rotDeg * Math.PI) / 180; // inverse (screen -> local)
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return { lx, ly, hw: w / 2, hh: h / 2, rotDeg };
  };

  const isPointInsideNodeInterior = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    // "Interior" excludes the 20px border band used for resize/rotate hit-testing.
    const R = 20;
    const { lx, ly, hw, hh } = localPtForNode(nodeEl, node, clientX, clientY);
    return Math.abs(lx) <= hw - R && Math.abs(ly) <= hh - R;
  };

  // Hit-test the selection outline in the node's LOCAL (rotated) coordinate system.
  // Rules:
  // - Corner "balls": radius 20px around each corner
  //   - top corners => rotation handles (rot-tl/rot-tr)
  //   - bottom corners => scale handles (sw/se)
  // - Edges: within 20px inside/outside the border (a 40px band centered on the edge line),
  //          but ONLY inside a segment tangential to the corner balls (exclude the end balls).
  // - If multiple regions overlap, the closest one wins.
  const hitTestTransformHandle = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const R = 20; // px
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const rect = nodeEl.getBoundingClientRect();
    // IMPORTANT: if the pointer is in a forbidden resize band (anchor side), do NOT fall back to the opposite edge.
    if (isInForbiddenResizeBand(rect as any, rotDeg, node?.transform?.anchor, clientX, clientY)) return null;
    const { lx, ly, hw, hh } = localPtForRect(rect as any, rotDeg, clientX, clientY);

    type Cand = { handle: string; d: number };
    const cands: Cand[] = [];
    const hidden = hiddenResizeHandlesForAnchor(node?.transform?.anchor);

    const addCorner = (handle: string, x: number, y: number) => {
      if (hidden.has(handle)) return;
      const d = Math.hypot(lx - x, ly - y);
      if (d <= R) cands.push({ handle, d });
    };
    // Corners
    addCorner("rot-tl", -hw, -hh);
    addCorner("rot-tr", hw, -hh);
    addCorner("sw", -hw, hh);
    addCorner("se", hw, hh);

    // Edge segments exclude the corner balls: tangent points are at +/-R along each edge.
    const xMin = -hw + R;
    const xMax = hw - R;
    const yMin = -hh + R;
    const yMax = hh - R;
    if (xMax >= xMin) {
      const dt = Math.abs(ly - (-hh));
      if (dt <= R && lx >= xMin && lx <= xMax && !hidden.has("n")) cands.push({ handle: "n", d: dt });
      const db = Math.abs(ly - hh);
      if (db <= R && lx >= xMin && lx <= xMax && !hidden.has("s")) cands.push({ handle: "s", d: db });
    }
    if (yMax >= yMin) {
      const dl = Math.abs(lx - (-hw));
      if (dl <= R && ly >= yMin && ly <= yMax && !hidden.has("w")) cands.push({ handle: "w", d: dl });
      const dr = Math.abs(lx - hw);
      if (dr <= R && ly >= yMin && ly <= yMax && !hidden.has("e")) cands.push({ handle: "e", d: dr });
    }

    if (cands.length === 0) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0].handle;
  };

  // Capture-phase intent handler: if the pointer is over a selected node's interaction region,
  // force that action and prevent background pan handlers from starting.
  function onStagePointerDownCaptureSelect(ev: PointerEvent) {
      if (getAppMode() !== "edit") return;
      ensureNoStaleIsolateModes("stage:pointerdown:capture");
      if (tool !== "select") return;
      if (ev.button !== 0) return;
      if (dragMode !== "none") return;

      const anchorEl = (ev.target as HTMLElement).closest?.(".anchor-dot");
      if (anchorEl) return; // let anchor click logic handle it

      // Multi-select gestures (ctrl/shift) must not be intercepted by capture-phase drag/resize logic.
      // Let bubble-phase selection toggling handle these clicks.
      if (ev.ctrlKey || ev.shiftKey) return;

      // Critical: while editing timer/sound/graph composites, do NOT let the normal node selection/drag handler run
      // for the composite ROOT (comp-sub owns editing). However, child nodes (e.g. axis arrow nodes) must remain
      // editable like any other element.
      if (compositeState.id && (compositeState.kind === "timer" || compositeState.kind === "sound" || compositeState.kind === "graph")) {
        const rawId = (ev.target as HTMLElement).closest<HTMLElement>(".node")?.dataset.nodeId ?? "";
        if (!rawId) return;
        const model0 = engine.getModel();
        const n0: any = model0?.nodes?.find?.((n: any) => String(n?.id ?? "") === String(rawId));
        // Allow ONLY children of the composite root to use the normal drag pipeline.
        if (!n0 || String(n0.parentId ?? "") !== String(compositeState.id)) return;
      }

      const model = engine.getModel();
      if (!model) return;

      // Prefer the node directly under the pointer (supports "mousedown selects + drags" for unselected text).
      let hoveredNodeEl = (ev.target as HTMLElement).closest<HTMLElement>(".node");
      let hoveredRawId = hoveredNodeEl?.dataset.nodeId ?? "";
      let hoveredId = hoveredRawId ? resolveSelectableId(hoveredRawId) : "";
      let hasHovered = !!hoveredId;
      // If selection was bubbled to an ancestor (e.g. a group root), ensure we also use the
      // ancestor element for hit-testing. Otherwise we end up applying group interactions using
      // a child bbox, which makes inner elements appear interactive in root mode.
      if (hasHovered && hoveredRawId && hoveredId && hoveredId !== hoveredRawId) {
        const bubbledEl = engine.getNodeElement(hoveredId);
        if (bubbledEl) hoveredNodeEl = bubbledEl;
        hoveredRawId = hoveredId;
      }

      // If we didn't hit a `.node` element, try composite hit-testing against their effective outer rects.
      if (!hasHovered) {
        const best = pickCompositeRootAtClientPoint(model as any, ev.clientX, ev.clientY);
        if (best) {
          hoveredId = best.id;
          hoveredNodeEl = engine.getNodeElement(best.id);
          hoveredRawId = hoveredId;
          hasHovered = !!hoveredId && !!hoveredNodeEl;
        }
      }

      const selectId = () => {
        if (!hoveredId) return;
        if (ev.ctrlKey || ev.shiftKey) return; // preserve multi-select semantics
        if (!(selected.size === 1 && selected.has(hoveredId))) {
          selectOne(hoveredId);
        }
      };

      if (hasHovered) selectId();

      // Determine which node we're acting on:
      // - if pointer is over a node element, act on that node
      // - else, fall back to the currently selected node (so the 20px outside-border band still works)
      const activeId =
        hasHovered ? hoveredId : selected.size === 1 ? Array.from(selected)[0] : "";
      if (!activeId) return;

      const node: any = model.nodes.find((n: any) => n.id === activeId);
      const nodeEl = hasHovered ? hoveredNodeEl! : engine.getNodeElement(activeId);
      if (!node || !nodeEl) return;

      // Composite roots: implement our own "double click" detection (native dblclick can be suppressed by pointer handling).
      if (!compositeState.id && (node.type === "timer" || node.type === "sound" || node.type === "choices" || node.type === "graph")) {
        const now = performance.now();
        const prev = lastCompositeClick;
        const dt = prev && prev.id === activeId ? now - prev.tMs : Infinity;
        const d = prev && prev.id === activeId ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
        const isDouble = dt <= 350 && d <= 6;
        lastCompositeClick = { id: activeId, tMs: now, x: ev.clientX, y: ev.clientY };

        if (isDouble) {
          lastCompositeClick = null;
          if (node.type === "timer" || node.type === "sound" || node.type === "graph" || node.type === "choices") {
            compositeCtrl.enterCompositeEdit?.(node.type, String(activeId));
          }
          ev.preventDefault();
          (ev as any).stopImmediatePropagation?.();
          return;
        }
      }

      // Arrow/line: handle line-graph semantics in capture phase too (so bubble phase is not required).
      if (node.type === "arrow" || node.type === "line") {
        const seg = hitTestSegmentHandle(nodeEl, ev.clientX, ev.clientY);

        // For arrows we only act inside the segment hit region.
        if (node.type === "arrow") {
          if (!seg) return;
          startSnapshot = cloneModel(model);
          dragDirty = false;
          startNodesById = { [activeId]: JSON.parse(JSON.stringify(node)) };
          start = { x: ev.clientX, y: ev.clientY };
          activeHandle = seg;
          dragMode = "line";
          setBodyCursor("grabbing");
          stage.setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          (ev as any).stopImmediatePropagation?.();
          return;
        }

        // Lines: ALWAYS behave like a connected graph.
        // - dragging segment body moves whole component rigidly
        // - dragging an endpoint moves that junction and keeps all connected endpoints attached
        // - dragging anywhere else inside the line's bbox also moves the whole component
      // Selection behavior:
      // - clicking the segment body selects the whole connected component (all lines glow + move together)
      // - clicking an endpoint selects just this line (vertex drag mode; no bbox)
        startSnapshot = cloneModel(model);
        dragDirty = false;
        startNodesById = { [activeId]: JSON.parse(JSON.stringify(node)) };
        start = { x: ev.clientX, y: ev.clientY };

      if (seg === "p1" || seg === "p2") {
        setLineGraphMode("vertex", activeId, seg);
      } else {
        setLineGraphMode("graph", activeId);
        // Clicking segment body selects full connected component (no modifiers).
        const ids = collectConnectedLineIdsByProximity(activeId, model);
        if (ids.length > 0) {
          selected.clear();
          for (const id of ids) selected.add(String(id));
          applySelection();
        }
      }

      if (seg === "mid" || !seg) {
          const r = nodeEl.getBoundingClientRect();
          const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
          if (!seg && !inside) return;
          const g = lineGraphDrag.startGraphDrag({ id: activeId, model, startNodesById });
          if (g) {
            dragMode = "graph";
            activeHandle = null;
            setBodyCursor("grabbing");
            stage.setPointerCapture?.(ev.pointerId);
            ev.preventDefault();
            (ev as any).stopImmediatePropagation?.();
            return;
          }
          // Fallback: if graph drag can't initialize for some reason, treat as simple line drag.
          activeHandle = seg ?? "mid";
          dragMode = "line";
          setBodyCursor("grabbing");
          stage.setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          (ev as any).stopImmediatePropagation?.();
          return;
        }

        // Endpoint drag: start junction linkage.
        activeHandle = seg;
        dragMode = "line";
        setBodyCursor("grabbing");
        lineGraphDrag.startJunctionDrag({ id: activeId, model, startNodesById });
        stage.setPointerCapture?.(ev.pointerId);
        ev.preventDefault();
        (ev as any).stopImmediatePropagation?.();
        return;
      }

      // Boxes: if inside interior OR on handle band, start manipulation and block pan.
      const hnd = hitTestTransformHandleForNode(nodeEl, node, ev.clientX, ev.clientY);
      const inside = (() => {
        // Use the effective bbox for composites so the "outer box" behaves like a normal node.
        const eff = effectiveNodeRectClient(nodeEl, node);
        if (eff) return isPointInRotatedRectClient(eff as any, Number(node?.transform?.rotationDeg ?? 0) || 0, ev.clientX, ev.clientY);
        const { lx, ly, hw, hh } = localPtForRect(nodeEl.getBoundingClientRect(), Number(node?.transform?.rotationDeg ?? 0) || 0, ev.clientX, ev.clientY);
        return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
      })();
      if (!hnd && !inside) return;

      // Text + bullets: if the anchor is on the hovered edge/corner, dragging that side should be a no-op.
      // (Avoid "resizing from the opposite side" for very thin boxes when the forbidden edge is disabled.)
      if (!hnd && inside && (node.type === "text" || node.type === "bullets")) {
        const eff = effectiveNodeRectClient(nodeEl, node);
        const r = (eff as any) ?? nodeEl.getBoundingClientRect();
        const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
        if (isInForbiddenResizeBand(r as any, rotDeg, node?.transform?.anchor, ev.clientX, ev.clientY)) {
          // Do not start move from a disabled resize band; user can drag interior to move instead.
          return;
        }
      }

      // Composite roots: block pan, but DO NOT start drag immediately (lets native dblclick fire).
      if ((node.type === "timer" || node.type === "sound") && !compositeState.id) {
        pendingCompositeDrag = {
          pointerId: ev.pointerId,
          id: activeId,
          node,
          nodeEl,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          hnd
        };
        // Still block background pan.
        ev.preventDefault();
        // Capture the pointer immediately so subsequent moves are routed through the stage,
        // which is required for our stage-level drag handlers to work reliably.
        try {
          stage.setPointerCapture?.(ev.pointerId);
        } catch {}
        (ev as any).stopImmediatePropagation?.();
        return;
      }

      startSnapshot = cloneModel(model);
      dragDirty = false;
      startNodesById = { [activeId]: JSON.parse(JSON.stringify(node)) };
      start = { x: ev.clientX, y: ev.clientY };

      if (hnd) {
        activeHandle = hnd;
        dragMode = activeHandle.startsWith("rot-") ? "rotate" : "resize";
        setBodyCursor(cursorForHandleWithRotation(activeHandle, Number(node?.transform?.rotationDeg ?? 0)));
        if (dragMode === "rotate") {
          // Rotate around anchor point (x,y) which is the node's transform reference.
          const tUse: any = (() => {
            // For grouped nodes, rotate about their world anchor.
            const { ui } = _uiNodeForId(String(node.id), model);
            return (ui as any)?.transform ?? node.transform ?? {};
          })();
          const cam = engine.getCamera();
          const scr = engine.getScreen();
          const stageRect = stage.getBoundingClientRect();
          const anchorClient =
            String(node.space ?? "world") === "screen"
              ? { x: stageRect.left + Number(tUse.x ?? 0) * Math.max(1, scr.w), y: stageRect.top + Number(tUse.y ?? 0) * Math.max(1, scr.h) }
              : (() => {
                  const p = worldToScreen({ x: Number(tUse.x ?? 0), y: Number(tUse.y ?? 0) }, cam as any, scr as any);
                  return { x: stageRect.left + p.x, y: stageRect.top + p.y };
                })();
          startAngleRad = Math.atan2(ev.clientY - anchorClient.y, ev.clientX - anchorClient.x);
          startRotationDeg = Number(node?.transform?.rotationDeg ?? 0);
        }
      } else {
        activeHandle = null;
        dragMode = "move";
        setBodyCursor("grabbing");
      }

      stage.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
  }

  // If a composite root is pending drag, wait until the user actually moves before starting drag.
  function onWindowPointerMoveCaptureSelect(ev: PointerEvent) {
    // Right-button marquee selection drag.
    if (rectSelect) {
      if (getAppMode() !== "edit") return;
      if (tool !== "select") return;
      if (ev.pointerId !== rectSelect.pointerId) return;
      if (!(ev.buttons & 2)) return;
      rectSelect.lastX = ev.clientX;
      rectSelect.lastY = ev.clientY;
      const dx = rectSelect.lastX - rectSelect.startX;
      const dy = rectSelect.lastY - rectSelect.startY;
      const DRAG_START_PX = 3.0;
      if (!rectSelect.dirty) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        rectSelect.dirty = true;
        rectSelect.el.style.display = "block";
      }
      const l = Math.min(rectSelect.startX, rectSelect.lastX);
      const t = Math.min(rectSelect.startY, rectSelect.lastY);
      const r = Math.max(rectSelect.startX, rectSelect.lastX);
      const b = Math.max(rectSelect.startY, rectSelect.lastY);
      rectSelect.el.style.left = `${l}px`;
      rectSelect.el.style.top = `${t}px`;
      rectSelect.el.style.width = `${Math.max(1, r - l)}px`;
      rectSelect.el.style.height = `${Math.max(1, b - t)}px`;
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
      return;
    }

    // Line-graph selection box drag (move/scale/rotate whole component).
    if (lineGraphBoxDrag) {
      if (getAppMode() !== "edit") return;
      if (tool !== "select") return;
      if (ev.pointerId !== lineGraphBoxDrag.pointerId) return;
      if (!(ev.buttons & 1)) return;
      const dx = ev.clientX - lineGraphBoxDrag.startClientX;
      const dy = ev.clientY - lineGraphBoxDrag.startClientY;
      const DRAG_START_PX = 3.0;
      if (!lineGraphBoxDrag.dirty) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        lineGraphBoxDrag.dirty = true;
      }
      lineGraphDrag.applyGraphBoxDrag({
        activeHandle: lineGraphBoxDrag.handle,
        dxClient: dx,
        dyClient: dy,
        startClientX: lineGraphBoxDrag.startClientX,
        startClientY: lineGraphBoxDrag.startClientY,
        clientX: ev.clientX,
        clientY: ev.clientY,
        centerClientX: lineGraphBoxDrag.centerClientX,
        centerClientY: lineGraphBoxDrag.centerClientY,
        startNodesById: lineGraphBoxDrag.startNodesById,
      });
      applySelection();
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
      return;
    }

      if (!pendingCompositeDrag) return;
      if (getAppMode() !== "edit") return;
      if (tool !== "select") return;
      if (dragMode !== "none") return;
      // IMPORTANT: do not start a drag after the mouse button was released.
      if (!(ev.buttons & 1)) return;
      if (ev.pointerId !== pendingCompositeDrag.pointerId) return;

      const dx = ev.clientX - pendingCompositeDrag.startClientX;
      const dy = ev.clientY - pendingCompositeDrag.startClientY;
      const dist = Math.hypot(dx, dy);
      if (dist < 3) return;

      const model = engine.getModel();
      if (!model) return;
      const id = pendingCompositeDrag.id;
      const node: any = model.nodes.find((n: any) => n.id === id) ?? pendingCompositeDrag.node;
      const nodeEl = engine.getNodeElement(id) ?? pendingCompositeDrag.nodeEl;
      if (!node || !nodeEl) return;

      // Start drag now (and suppress native click/dblclick from this point).
      startSnapshot = cloneModel(model);
      startNodesById = { [id]: JSON.parse(JSON.stringify(node)) };
      start = { x: pendingCompositeDrag.startClientX, y: pendingCompositeDrag.startClientY };

      const hnd = pendingCompositeDrag.hnd;
      if (hnd) {
        activeHandle = hnd;
        dragMode = activeHandle.startsWith("rot-") ? "rotate" : "resize";
        setBodyCursor(cursorForHandleWithRotation(activeHandle, Number(node?.transform?.rotationDeg ?? 0)));
        if (dragMode === "rotate") {
          // Rotate around anchor point (x,y) which is the node's transform reference.
          const tUse: any = (() => {
            const { ui } = _uiNodeForId(String(node.id), model);
            return (ui as any)?.transform ?? node.transform ?? {};
          })();
          const cam = engine.getCamera();
          const scr = engine.getScreen();
          const stageRect = stage.getBoundingClientRect();
          const anchorClient =
            String(node.space ?? "world") === "screen"
              ? { x: stageRect.left + Number(tUse.x ?? 0) * Math.max(1, scr.w), y: stageRect.top + Number(tUse.y ?? 0) * Math.max(1, scr.h) }
              : (() => {
                  const p = worldToScreen({ x: Number(tUse.x ?? 0), y: Number(tUse.y ?? 0) }, cam as any, scr as any);
                  return { x: stageRect.left + p.x, y: stageRect.top + p.y };
                })();
          startAngleRad = Math.atan2(start.y - anchorClient.y, start.x - anchorClient.x);
          startRotationDeg = Number(node?.transform?.rotationDeg ?? 0);
        }
      } else {
        activeHandle = null;
        dragMode = "move";
        setBodyCursor("grabbing");
      }

      pendingCompositeDrag = null;
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
  }

  const finishDrag = async () => {
    // Always clear pending composite drag.
    pendingCompositeDrag = null;
    lineGraphDrag.reset();
    if (dragMode === "none" && !startSnapshot) return;
    dragMode = "none";
    activeHandle = null;
    setBodyCursor("");
    startNodesById = null;
    const before = startSnapshot;
    startSnapshot = null;
    if (dragDirty) await commit(before);
    dragDirty = false;
    // Clear line-graph vertex mode after any drag completes.
    try {
      setLineGraphMode("");
    } catch {}
    // If the mouse hasn't moved since a snapped rotation, refresh hover cursor immediately.
    const mx = (window as any).__ip_lastMouseX;
    const my = (window as any).__ip_lastMouseY;
    if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
    // Also refresh handle cursor styles for the currently selected node.
    if (selected.size === 1) {
      const id = Array.from(selected)[0];
      const el = engine.getNodeElement(id);
      const model = engine.getModel();
      const n: any = model?.nodes.find((nn) => nn.id === id);
      if (n?.type === "timer" || n?.type === "sound" || n?.type === "graph") applySelection();
      else if (el) ensureHandles(el);
    }
  };

  const cancelInteractions = () => {
    // Cancel "in-flight" pointer interactions without committing anything.
    // This is intentionally conservative and only touches transient interaction state.
    const hadAny =
      dragMode !== "none" ||
      activeHandle != null ||
      pendingCompositeDrag != null ||
      startSnapshot != null ||
      startNodesById != null;

    if (!hadAny) return false;

    pendingCompositeDrag = null;
    lineGraphDrag.reset();
    dragMode = "none";
    activeHandle = null;
    startNodesById = null;
    startSnapshot = null;
    // Clear any transient line-graph selection mode (vertex/graph).
    try {
      setLineGraphMode("");
    } catch {}
    // Clear body cursor override (stage + document cursor)
    setBodyCursor("");
    // Refresh hover cursor immediately if we have a last mouse point.
    try {
      const mx = (window as any).__ip_lastMouseX;
      const my = (window as any).__ip_lastMouseY;
      if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
    } catch {}
    return true;
  };

  // Hover cursor based on hit-test (so we don't depend on DOM overlap ordering).
  function onStagePointerMoveHoverSelect(ev: PointerEvent) {
    if (getAppMode() !== "edit") return;
    if (dragMode !== "none") return;
    if (tool !== "select") return;
    updateStageCursorFromClientPoint(ev.clientX, ev.clientY);
  }

  function onWindowPointerDownCaptureSelect(ev: PointerEvent) {
    if (getAppMode() !== "edit") return;
    if (tool !== "select") return;
    if (dragMode !== "none") return;
    if (compositeState.id) return;

    const isStageEventForSelect = () => {
      const t = ev.target as HTMLElement | null;
      try {
        const uiHit = t?.closest?.(
          ".edit-toolbox, .mode-toggle, .modal, .modal-backdrop, .tabs, .tab, .modal-header, .modal-body, .modal-footer"
        );
        if (uiHit) return false;
      } catch {}
      try {
        if (t && stage.contains(t)) return true;
      } catch {}
      try {
        const r = stage.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      } catch {
        return false;
      }
    };

    // Right-button marquee selection (rect select).
    if (ev.button === 2) {
      if (!isStageEventForSelect()) return;
      const el = (() => {
        let d = document.querySelector<HTMLDivElement>(".ip-rect-selection");
        if (d) return d;
        d = document.createElement("div");
        d.className = "ip-rect-selection";
        d.style.position = "fixed";
        d.style.pointerEvents = "none";
        d.style.zIndex = "99996";
        d.style.display = "none";
        d.style.border = "1px dashed rgba(110,168,255,0.85)";
        d.style.background = "rgba(110,168,255,0.12)";
        d.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.35)";
        d.style.borderRadius = "4px";
        document.body.appendChild(d);
        return d;
      })();

      rectSelect = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        lastX: ev.clientX,
        lastY: ev.clientY,
        el,
        dirty: false,
        shiftKey: !!ev.shiftKey,
        ctrlKey: !!ev.ctrlKey,
      };
      try {
        stage.setPointerCapture?.(ev.pointerId);
      } catch {}
      // Do NOT stop propagation: right-click should still clear selection on background in bubble phase.
      // Context menu is disabled separately.
      ev.preventDefault();
      return;
    }

    if (ev.button !== 0) return;

    const box = isLineGraphBoxTarget(ev.target);
    if (!box) return;
    const seedId = String(box.dataset.seedId ?? "");
    if (!seedId) return;
    const model = engine.getModel();
    if (!model) return;
    const seed: any = model.nodes.find((n: any) => String(n.id) === String(seedId));
    if (!seed || seed.type !== "line") return;

    const hEl = (ev.target as HTMLElement).closest<HTMLElement>(".handle");
    const handle = String(hEl?.dataset.handle ?? "move") || "move";
    const r = box.getBoundingClientRect();
    const centerClientX = r.left + r.width / 2;
    const centerClientY = r.top + r.height / 2;

    const before = cloneModel(model);
    const startNodesById2: Record<string, any> = {};
    // Seed only; startGraphBoxDrag will expand it.
    const snap = JSON.parse(JSON.stringify(seed));
    const pid = String((seed as any)?.parentId ?? "").trim();
    if (pid && (seed as any)?.space === "world") {
      const { ui, parentWorld } = _uiNodeForId(String(seedId), model);
      (snap as any).__ui = { worldT: (ui as any)?.transform ?? null, parentWorldT: parentWorld ?? null };
    }
    startNodesById2[seedId] = snap;

    const g = lineGraphDrag.startGraphBoxDrag({ id: seedId, model, startNodesById: startNodesById2 });
    if (!g) return;

    lineGraphBoxDrag = {
      pointerId: ev.pointerId,
      seedId,
      handle,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      centerClientX,
      centerClientY,
      before,
      startNodesById: startNodesById2,
      dirty: false,
    };

    try {
      box.setPointerCapture?.(ev.pointerId);
    } catch {}
    setBodyCursor("grabbing");
    ev.preventDefault();
    (ev as any).stopImmediatePropagation?.();
  }

  const applySelection = () => selection?.applySelection?.();
  const clearSelection = () => selection?.clearSelection?.();
  setApplySelection(applySelection);

  // Group edit controller (stack + dimming + enter/exit)
  groupEdit = createGroupEditController({
    engine,
    stage,
    getAppMode,
    isDescendantOf,
    clearSelection,
    exitScreenEdit,
    exitCompositeEdit: () => void exitCompositeEdit(),
    updateStageCursorFromClientPoint,
    onGroupEditIdChanged: () => {
      // Transition rule: entering/leaving group edit always forces Select tool,
      // and clears any transient pointer interaction state (drag/draw).
      try {
        cancelInteractions();
      } catch {}
      try {
        setTool("select");
      } catch {}
    },
  });
  // Expose group-edit transitions to the outer mode toggles (central routing).
  exitGroupEdit = () => void groupEdit?.exitOneLevel?.();
  isGroupEditing = () => !!activeGroupEditId();
  // Used by the engine setModel wrapper to restore dimming after model replacement.
  (engine as any).__ip_applyGroupEditDimming = () => groupEdit?.applyDimming?.();

  // Segment placement controller (handlers only; state machine owns DOM events).
  const placement = createSegmentPlacementController({
    stage,
    engine,
    getAppMode,
    getTool: () => getTool(),
    getSpace: () => (screenEditMode ? "screen" : "world"),
    addTextAt: (pos, o) => void addTextAt(pos, o),
    addBulletsAt: (pos, o) => void addBulletsAt(pos, o),
    addArrowFromTo: (from, to, o) => void addArrowFromTo(from, to, o),
    addLineFromTo: (from, to, o) => void addLineFromTo(from, to, o),
    clearSelection,
    gridSpacingForZoom,
    screenToWorld,
    worldToScreen,
    anchorToTopLeftWorld,
    uiNodeForId: _uiNodeForId,
  });

  // Central interaction router (single coherent pipeline for placement/composite/select).
  createInteractionStateMachine({
    stage,
    engine,
    getAppMode,
    getTool: () => getTool(),
    setTool,
    getCompositeState: () => (compositeState?.id ? compositeState : null) as any,
    debug: {
      getState: () => ({
        // core editor state
        mode: getAppMode(),
        tool,
        screenEditMode,
        compositeState,
        groupEditId: activeGroupEditId(),
        // selection/drag
        selected: Array.from(selected),
        dragMode,
        activeHandle,
        hasStartSnapshot: !!startSnapshot,
        hasStartNodesById: !!startNodesById,
        dragDirty,
        pendingCompositeDrag: !!pendingCompositeDrag,
      }),
    },
    placement: {
      onPointerDown: (ev) => placement.onPointerDown(ev),
      onPointerMove: (ev) => placement.onPointerMove(ev),
      onPointerUp: (ev) => placement.onPointerUp(ev),
      onContextMenu: (ev) => placement.onContextMenu(ev),
      onKeyDown: (ev) => placement.onKeyDown(ev),
    },
    composite: {
      onPointerDownCapture: (ev) => compositeCtrl.handlers?.onPointerDownCapture?.(ev) ?? false,
      onPointerMoveCapture: (ev) => compositeCtrl.handlers?.onPointerMoveCapture?.(ev) ?? false,
      onPointerUpCapture: (ev) => compositeCtrl.handlers?.onPointerUpCapture?.(ev) ?? false,
      onPointerCancelCapture: (ev) => compositeCtrl.handlers?.onPointerCancelCapture?.(ev) ?? false,
    },
    select: {
      onStagePointerDownCapture: onStagePointerDownCaptureSelect,
      onStagePointerDownBubble: onStagePointerDownBubbleSelect,
      onStagePointerMoveBubble: (ev) => {
        // Merge hover + drag into one bubble handler.
        onStagePointerMoveHoverSelect(ev);
        onStagePointerMoveBubbleSelect(ev);
      },
      onWindowPointerDownCapture: onWindowPointerDownCaptureSelect,
      onWindowPointerMoveCapture: onWindowPointerMoveCaptureSelect,
      onWindowPointerUpCapture: onWindowPointerUpCaptureSelect,
      onWindowPointerCancelCapture: onWindowPointerCancelCaptureSelect,
    },
  }).attach();

  // Line-graph (polyline) rigid transform box is handled via the central state machine:
  // see onWindowPointerDownCaptureSelect / onWindowPointerMoveCaptureSelect / onWindowPointerUpCaptureSelect.
  // Group edit behavior is handled by `groupEdit` (see `createGroupEditController`).

  const selectOne = (id: string) => {
    selected.clear();
    selected.add(id);
    applySelection();
  };

  const addSelect = (id: string) => {
    selected.add(id);
    applySelection();
  };

  const toggleSelect = (id: string) => {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    applySelection();
  };

  const getSelectedNodes = () => {
    const model = engine.getModel();
    if (!model) return [];
    return model.nodes.filter((n) => selected.has(n.id));
  };

  const commit = async (before: PresentationModel | null) => history.commit(before);

  // Table Excel-like editing moved to @interactive/runtime (table plugin).

  const openEditorModal = async (nodeId: string) => {
    await openNodeEditorModal({
      engine,
      nodeId,
      cloneModel,
      applySelection,
      commit,
      hydrateQrImages,
      hydrateTextMath,
      renderTextWithKatexToHtml,
    });
  };

  attachKeyboardShortcuts({
    engine,
    stage,
    getAppMode,
    isScreenEditMode: () => !!screenEditMode,
    selected,
    clearSelection,
    selectAllInActiveContext: () => {
      if (getAppMode() !== "edit") return;
      const model = engine.getModel();
      if (!model) return;
      if (compositeState.id) return; // composite edit owns selection

      const activeViewId = getActiveViewId();
      const activeView = model.views.find((v) => String(v.id) === String(activeViewId)) ?? model.views[0];
      const show = new Set<string>((activeView?.show ?? []).map((x: any) => String(x)));
      const gid = activeGroupEditId();

      const hits = new Set<string>();
      for (const n0 of model.nodes as any[]) {
        const rawId = String(n0?.id ?? "");
        if (!rawId) continue;

        // Respect screen edit mode.
        const space = String(n0?.space ?? "world");
        if (screenEditMode) {
          if (space !== "screen") continue;
        } else {
          if (space === "screen") continue;
        }

        // Respect group edit mode: only descendants (exclude the group root).
        if (gid) {
          if (rawId === gid) continue;
          if (!isDescendantOf(rawId, gid, model)) continue;
        }

        // Respect view membership (view-local selection).
        if (show.size && !show.has(rawId)) continue;

        // Must be rendered and not dimmed by isolate modes.
        const el = engine.getNodeElement(rawId);
        if (!el) continue;
        if (el.classList.contains("ip-dim-node")) continue;

        hits.add(resolveSelectableId(rawId));
      }

      selected.clear();
      for (const id of hits) if (id) selected.add(id);
      applySelection();
    },
    cancelInteractions,
    cloneModel,
    commit,
    hydrateQrImages,
    hydrateTextMath,
    applySelection,
    saveModel,
    history,
    screenToWorld,
    anchorToTopLeftWorld,
    rectCornersWorld,
    getActiveViewId,
    nextId,
    updateStageCursorFromClientPoint,
  });

  // Composite edit manager (timer/choices/sound/graph) + screen edit manager extracted into a controller.
  // We keep a mirrored state here so other controllers (cursor/selection/pointerdown) can query it cheaply.
  let compositeState: { id: string | null; kind: "timer" | "choices" | "sound" | "graph"; path: string } = {
    id: null,
    kind: "timer",
    path: "",
  };

  const dbgFlow = (_event: string, _data: any) => {};

  const hardRestoreInteractivity = (reason: string) => {
    // Emergency cleanup for "stuck in pan-only" states.
    // Safe to call repeatedly.
    try {
      for (const el of Array.from(stage.querySelectorAll<HTMLElement>(".node.ip-dim-node"))) el.classList.remove("ip-dim-node");
      for (const el of Array.from(stage.querySelectorAll<HTMLElement>(".node.ip-group-ref"))) el.classList.remove("ip-group-ref");
      for (const el of Array.from(stage.querySelectorAll<HTMLElement>(".node"))) {
        if (el.style.pointerEvents === "none") el.style.pointerEvents = "";
      }
    } catch {}
    try {
      delete (window as any).__ip_exitCompositeEdit;
      delete (window as any).__ip_compositeEditing;
      delete (window as any).__ip_cancelCompositePan;
      delete (window as any).__ip_exitGroupEdit;
      delete (window as any).__ip_exitScreenEdit;
      delete (window as any).__ip_compositeEditId;
      delete (window as any).__ip_compositeEditKind;
    } catch {}
    compositeState = { id: null, kind: "timer", path: "" };
    dbgFlow("hardRestoreInteractivity", {
      reason,
      tool,
      dragMode,
      activeHandle,
      compositeState,
      screenEditMode,
    });
    // Ensure cursor isn't stuck in grabbing.
    try {
      setBodyCursor("");
    } catch {}
  };

  const ensureNoStaleIsolateModes = (where: string) => {
    const w: any = window as any;
    const gid = activeGroupEditId();
    const compositeId = compositeState?.id ? String(compositeState.id) : "";
    const compositeEl = compositeId ? engine.getNodeElement(compositeId) : null;
    const compositeMarked = compositeEl?.dataset?.compositeEditing === "1";

    // Single source of truth:
    // The editor's `compositeState` decides whether composite editing is active.
    // Several subsystems (engine pan gate, CSS selectors, etc.) still read window globals.
    // Mirror state -> globals here to prevent drift (which causes "canvas eats clicks" / pan conflicts).
    try {
      if (compositeId) {
        w.__ip_compositeEditing = true;
        w.__ip_compositeEditId = compositeId;
        w.__ip_compositeEditKind = String(compositeState.kind ?? "");
      } else {
        delete w.__ip_compositeEditing;
        delete w.__ip_compositeEditId;
        delete w.__ip_compositeEditKind;
        // Composite pan cancel hook is only meaningful while editing.
        delete w.__ip_cancelCompositePan;
      }
    } catch {}
    const hasCompositeSignals = !!w.__ip_exitCompositeEdit || !!w.__ip_compositeEditing || !!w.__ip_cancelCompositePan || !!w.__ip_compositeEditId || !!w.__ip_compositeEditKind || !!compositeId;
    const staleComposite = hasCompositeSignals && (!compositeId || !compositeEl || !compositeMarked);
    const staleGroup = !!w.__ip_exitGroupEdit && !gid;
    const staleScreen = !!w.__ip_exitScreenEdit && !screenEditMode;

    if (!staleComposite && !staleGroup && !staleScreen) return;

    dbgFlow("staleIsolateDetected", {
      where,
      gid,
      compositeId,
      compositeMarked,
      staleComposite,
      staleGroup,
      staleScreen,
      hooks: {
        exitComposite: !!w.__ip_exitCompositeEdit,
        compositeEditing: !!w.__ip_compositeEditing,
        cancelCompositePan: !!w.__ip_cancelCompositePan,
        exitGroup: !!w.__ip_exitGroupEdit,
        exitScreen: !!w.__ip_exitScreenEdit,
        compositeEditId: String(w.__ip_compositeEditId ?? ""),
        compositeEditKind: String(w.__ip_compositeEditKind ?? ""),
      },
    });

    // Try graceful exits first (idempotent).
    try {
      if (w.__ip_exitCompositeEdit) w.__ip_exitCompositeEdit();
    } catch {}
    try {
      if (w.__ip_exitGroupEdit) w.__ip_exitGroupEdit();
    } catch {}
    try {
      if (w.__ip_exitScreenEdit) w.__ip_exitScreenEdit();
    } catch {}

    // If still inconsistent, hard restore.
    const compositeId2 = compositeState?.id ? String(compositeState.id) : "";
    const compositeEl2 = compositeId2 ? engine.getNodeElement(compositeId2) : null;
    const compositeMarked2 = compositeEl2?.dataset?.compositeEditing === "1";
    const stillStaleComposite = (!!w.__ip_exitCompositeEdit || !!w.__ip_compositeEditing || !!w.__ip_cancelCompositePan || !!compositeId2) && (!compositeId2 || !compositeEl2 || !compositeMarked2);
    const stillStaleGroup = !!w.__ip_exitGroupEdit && !activeGroupEditId();
    const stillStaleScreen = !!w.__ip_exitScreenEdit && !screenEditMode;
    if (stillStaleComposite || stillStaleGroup || stillStaleScreen) {
      hardRestoreInteractivity(`stale isolate after graceful exit @ ${where}`);
    }
  };

  const compositeCtrl = attachCompositeEditController({
    engine,
    stage,
    BACKEND,
    getAppMode,
    cloneModel,
    commit,
    // editor state/ops
    selected,
    clearSelection,
    applySelection,
    openEditorModal,
    ensureHandles: (el: HTMLElement) => ensureHandles(el),
    cursorForHandle: (h: string | null, rotDeg?: number) => cursorForHandleWithRotation(h, Number(rotDeg ?? 0)),
    setBodyCursor,
    screenToWorld,
    gridSpacingForZoom,
    anchorToTopLeftWorld,
    topLeftToAnchorWorld,
    // composite deps (from bootstrap/runtime)
    effectiveNodeRectClient,
    isPointInRotatedRectClient,
    _plotRectCss,
    _debugCompositeSaveFetch,
    ensureTimerCompositeLayer,
    ensureSoundCompositeLayer,
    ensureGraphCompositeLayer,
    renderTimerCompositeArrows,
    renderSoundCompositeArrows,
    renderGraphCompositeArrows,
    ensureChoicesWheelLayer,
    applyDataBindings,
    renderTextWithKatexToHtml,
    _pickSmallestCompositeSub,
    // group edit integration
    groupEdit,
    // state sinks
    onCompositeState: (st: any) => {
      compositeState = {
        id: st?.id != null ? String(st.id) : null,
        kind: (st?.kind ?? "timer") as any,
        path: st?.path != null ? String(st.path) : "",
      };
      // Mirror composite state to window globals (engine/CSS gate).
      try {
        const w: any = window as any;
        if (compositeState.id) {
          w.__ip_compositeEditing = true;
          w.__ip_compositeEditId = String(compositeState.id);
          w.__ip_compositeEditKind = String(compositeState.kind ?? "");
        } else {
          delete w.__ip_compositeEditing;
          delete w.__ip_compositeEditId;
          delete w.__ip_compositeEditKind;
          delete w.__ip_cancelCompositePan;
        }
      } catch {}
      // Transition rule: entering/leaving composite edit always forces Select tool,
      // and clears any transient pointer interaction state (drag/draw).
      try {
        cancelInteractions();
      } catch {}
      try {
        setTool("select");
      } catch {}
    },
    onScreenEditModeChanged: (v: boolean) => {
      screenEditMode = !!v;
      // Transition rule: entering/leaving screen edit always forces Select tool,
      // and clears any transient pointer interaction state (drag/draw).
      try {
        cancelInteractions();
      } catch {}
      try {
        setTool("select");
      } catch {}
    },
  });
  // Expose composite-edit transitions to the outer mode toggles (central routing).
  exitCompositeEdit = () => void compositeCtrl.exitCompositeEdit();
  isCompositeEditing = () => !!compositeState?.id;

  // Keep legacy exports used elsewhere in bootstrap.
  enterScreenEdit = compositeCtrl.enterScreenEdit;
  exitScreenEdit = compositeCtrl.exitScreenEdit;

  // Composite edit + screen edit handlers extracted into `editor/compositeEdit.ts`.

  // Excel-like table editing moved to the runtime `table` plugin.

  function onStagePointerDownBubbleSelect(ev: PointerEvent) {
    // Hard block: Live mode must be resistant to any editing gestures.
    if (getAppMode() !== "edit") return;
    ensureNoStaleIsolateModes("stage:pointerdown:bubble");
    // When a placement tool is active, NEVER run selection/drag logic here.
    // The placement tool owns the interaction in capture phase.
    if (tool !== "select") return;
    const target = ev.target as HTMLElement;
    const anchorEl = target.closest<HTMLElement>(".anchor-dot");
    const nodeEl = target.closest<HTMLElement>(".node");
    const compSubEl = target.closest<HTMLElement>(".comp-sub");

    // Composite edit rule (timer/sound/graph):
    // the composite ROOT is a non-interactive reference frame while editing internals.
    // A plain left click on the composite background must NOT select the root (no bbox), it should behave like background.
    if (
      compositeState?.id &&
      (compositeState.kind === "timer" || compositeState.kind === "sound" || compositeState.kind === "graph") &&
      !target.closest(".handle") &&
      !anchorEl &&
      !compSubEl
    ) {
      const raw = String(nodeEl?.dataset?.nodeId ?? "");
      // If we're over the root itself (or not over any node), treat as background.
      if (!raw || raw === String(compositeState.id)) {
        ev.preventDefault();
        return;
      }
    }

    // Use smallest-hit node picking based on DOM hit stack (`elementsFromPoint`).
    // IMPORTANT: when clicking handles/anchor dots we must not re-pick.
    const rawPicked = !target.closest(".handle") && !anchorEl ? (() => {
      const model = engine.getModel();
      if (!model) return null;
      const gid = activeGroupEditId();
      const els = (document.elementsFromPoint?.(ev.clientX, ev.clientY) ?? []) as HTMLElement[];
      let best: { id: string; size: number; order: number } | null = null;
      for (let i = 0; i < els.length; i++) {
        const e = els[i] as any;
        const nodeEl = (e?.closest?.(".node") as HTMLElement | null) ?? null;
        if (!nodeEl?.dataset?.nodeId) continue;
        const rawId = String(nodeEl.dataset.nodeId ?? "");
        if (!rawId) continue;
        // Composite edit: never pick the composite root as a selectable target (it is a reference frame).
        if (
          compositeState?.id &&
          (compositeState.kind === "timer" || compositeState.kind === "sound" || compositeState.kind === "graph") &&
          rawId === String(compositeState.id)
        ) {
          continue;
        }
        if (gid) {
          if (rawId === gid) continue;
          if (!isDescendantOf(rawId, gid, model)) continue;
        }
        const n0: any = model.nodes.find((n: any) => String(n.id) === rawId);
        if (!n0) continue;
        if (screenEditMode) {
          if (String(n0?.space ?? "world") !== "screen") continue;
        } else {
          if (String(n0?.space ?? "world") === "screen") continue;
        }
        const r0 = nodeEl.getBoundingClientRect();
        if (!(r0.width > 0.5 && r0.height > 0.5)) continue;
        const type = String(n0?.type ?? "");
        let size = Math.max(1e-6, r0.width * r0.height);
        if (type === "arrow" || type === "line") {
          const seg = hitTestSegmentHandle(nodeEl, ev.clientX, ev.clientY);
          // Lines require segment proximity (graph semantics). Arrows behave like normal elements:
          // clicking anywhere on the arrow node selects it, even if not within the 20px segment band.
          if (type === "line" && !seg) continue;
          const fx = Number(nodeEl.dataset.fromX ?? "0");
          const fy = Number(nodeEl.dataset.fromY ?? "0.5");
          const tx = Number(nodeEl.dataset.toX ?? "1");
          const ty = Number(nodeEl.dataset.toY ?? "0.5");
          const p1 = { x: r0.left + fx * r0.width, y: r0.top + fy * r0.height };
          const p2 = { x: r0.left + tx * r0.width, y: r0.top + ty * r0.height };
          const lenPx = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
          const wRaw = Number((n0 as any)?.width ?? 4);
          const cam = engine.getCamera();
          const strokePx =
            wRaw <= 1
              ? Math.max(1, wRaw * Math.max(1, Math.min(r0.width, r0.height)))
              : Math.max(1, wRaw * (String((n0 as any)?.space ?? "world") === "world" ? Number(cam.zoom ?? 1) : 1));
          size = Math.max(1e-6, lenPx * strokePx);
        }
        const cand = { id: rawId, size, order: i };
        if (!best) best = cand;
        else if (cand.size < best.size - 1e-6) best = cand;
        else if (Math.abs(cand.size - best.size) <= 1e-6) {
          if (cand.order < best.order) best = cand;
        }
      }
      return best?.id ?? null;
    })() : null;

    const rawIdFromDom = nodeEl?.dataset.nodeId ? String(nodeEl.dataset.nodeId) : "";
    const rawId = rawPicked ?? rawIdFromDom;
    if (rawId) {
      const id = resolveSelectableId(rawId);
      // In regular group-edit, clicking the active group root itself should behave like background
      // (so a click on "empty space" clears selection instead of re-selecting the group).
      const gid = activeGroupEditId();
      if (gid && id === gid && !ev.shiftKey && !ev.ctrlKey && !target.closest(".handle") && !target.closest(".anchor-dot")) {
        // Left-click should keep current selection.
        // Right-click clear is handled on right-button up (only if no marquee drag occurred).
        ev.preventDefault();
        return;
      }
      const model = engine.getModel();
      const { node: rawNode, ui: node } = model ? _uiNodeForId(id, model) : { node: null, ui: null };
      const pickedEl = engine.getNodeElement(id) ?? nodeEl;
      // Only allow screen-space nodes in screen edit mode; block screen nodes when not in screen edit.
      if (screenEditMode && node && node.space !== "screen") {
        ev.preventDefault();
        return;
      }
      if (!screenEditMode && node && node.space === "screen") {
        ev.preventDefault();
        return;
      }

    // Composite sub-elements (including axis arrows) are handled by the composite-sub pointerdown handler above.

    // In composite edit mode:
    // - Timer/Sound: never select/rotate the composite root itself (edit sub-elements only).
    // - Choices: allow selecting/resizing the root (so the whole composite can be scaled).
    if ((compositeState.kind === "timer" || compositeState.kind === "sound" || compositeState.kind === "graph") && compositeState.id && id === compositeState.id) {
      pickedEl?.querySelector?.(".handles")?.remove?.();
      ev.preventDefault();
      return;
    }

      // Anchor-dot should be a single click action (no extra click needed).
      // Do this BEFORE selection toggling (which may recreate handles).
      if (anchorEl?.dataset.anchor) {
        if (selected.size !== 1 || !selected.has(id)) {
          selectOne(id);
        }
        const model = engine.getModel();
        const node = model?.nodes.find((n) => n.id === id);
        if (!node) return;
        const before = model ? cloneModel(model) : null;

        const newAnchor = anchorEl.dataset.anchor;
        const t0 = node.transform;
        const tl0 = anchorToTopLeftWorld(t0);
        const rect = { x: tl0.x, y: tl0.y, w: t0.w, h: t0.h };
        const newPos = topLeftToAnchorWorld(rect, newAnchor);
        // IMPORTANT: clicking an anchor dot should ONLY change the anchor (no grid snapping).
        engine.updateNode(id, { transform: { ...t0, x: newPos.x, y: newPos.y, anchor: newAnchor } as any } as any);
        // Force immediate visual refresh of anchor dots (don't wait for the next render tick).
        const el = engine.getNodeElement(id);
        if (el) {
          el.dataset.anchor = newAnchor;
          ensureHandles(el); // will update current red anchor dot
        }
        applySelection();
        void commit(before);
        dragMode = "none";
        activeHandle = null;
        startNodesById = null;
        startSnapshot = null;
        ev.preventDefault();
        return;
      }

      if (ev.ctrlKey) toggleSelect(id);
      else if (ev.shiftKey) addSelect(id);
      else {
        // If you're already multi-selected and click-drag one of the selected nodes,
        // keep the selection (so the whole selection moves).
        if (!selected.has(id)) selectOne(id);
        else applySelection();
      }

      // Modifier clicks are for selection only (no immediate drag/resize/rotate start).
      if (ev.ctrlKey || ev.shiftKey) {
        ev.preventDefault();
        return;
      }

      startSnapshot = model ? cloneModel(model) : null;
      startNodesById = {};
      for (const n of model?.nodes ?? []) {
        if (selected.has(n.id)) {
          const snap = JSON.parse(JSON.stringify(n));
          // For grouped nodes, store UI/world transform + parent world transform at drag start.
          const pid = String((n as any)?.parentId ?? "").trim();
          if (pid && (n as any)?.space === "world") {
            const { ui, parentWorld } = _uiNodeForId(String(n.id), model);
            (snap as any).__ui = { worldT: (ui as any)?.transform ?? null, parentWorldT: parentWorld ?? null };
          }
          startNodesById[n.id] = snap;
        }
      }
      start = { x: ev.clientX, y: ev.clientY };

      // Special-case arrow/line: edit as a segment with 2 endpoints + midpoint (no bbox resize/rotate).
      if (selected.size === 1 && (node as any)?.type && ((node as any).type === "arrow" || (node as any).type === "line")) {
        // Hit regions:
        // - endpoint balls: radius 20px
        // - translate band: within 20px of segment, excluding endpoint balls
        // - closest wins
        const hnd = pickedEl ? hitTestSegmentHandle(pickedEl, ev.clientX, ev.clientY) : null;
        if (hnd) {
          // For line graphs:
          // - dragging an endpoint moves that junction (and all connected endpoints)
          // - dragging the segment body moves the whole connected component rigidly
          if ((node as any)?.type === "line" && hnd === "mid" && model && startNodesById) {
            const g = lineGraphDrag.startGraphDrag({ id, model, startNodesById });
            if (g) {
              dragMode = "graph";
              activeHandle = null;
              setBodyCursor("grabbing");
              (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
              ev.preventDefault();
              return;
            }
          }

          activeHandle = hnd;
          dragMode = "line";
          setBodyCursor("grabbing");
          // Junction behavior for polylines (shared endpoints via join IDs / proximity).
          if ((node as any)?.type === "line" && model && startNodesById) {
            lineGraphDrag.startJunctionDrag({ id, model, startNodesById });
          }
          (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          return;
        }
        // If the user didn't hit the segment/handles, fall back to normal move behavior for arrows.
        // (Lines keep their graph-drag fallback below.)
        if ((node as any)?.type === "arrow") {
          dragMode = "move";
          activeHandle = null;
          setBodyCursor("grabbing");
          (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          return;
        }
        // Not close enough to the segment.
        // For lines, treat this as "graph drag" (drag the whole connected component of lines).
        if ((node as any)?.type === "line" && model && startNodesById) {
          const g = lineGraphDrag.startGraphDrag({ id, model, startNodesById });
          if (g) {
            dragMode = "graph";
            activeHandle = null;
            setBodyCursor("grabbing");
            (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
            ev.preventDefault();
            return;
          }
        }
        // Otherwise fall back to normal move behavior.
      } else if (selected.size === 1 && pickedEl) {
        const hnd = hitTestTransformHandle(pickedEl, node, ev.clientX, ev.clientY);
        if (hnd) {
          activeHandle = hnd;
          dragMode = activeHandle === "rot" || activeHandle.startsWith("rot-") ? "rotate" : "resize";
          setBodyCursor(cursorForHandleWithRotation(activeHandle, Number((node as any)?.transform?.rotationDeg ?? 0)));
          if (dragMode === "rotate") {
            const r = pickedEl.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            startAngleRad = Math.atan2(ev.clientY - cy, ev.clientX - cx);
            startRotationDeg = (node as any)?.transform?.rotationDeg ?? 0;
          }
          (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          return;
        }
      } else {
        dragMode = "move";
        setBodyCursor("grabbing");
      }

      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      return;
    }

    // Left-click on background keeps selection.
    // Right-click clear is handled on right-button up (only if no marquee drag occurred).
  }

  function onStagePointerMoveBubbleSelect(ev: PointerEvent) {
    // Placement tools own pointer interactions.
    if (tool !== "select") return;
    if (selected.size === 0 || dragMode === "none" || !startNodesById) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    // Dead-zone: prevent tiny accidental nudges.
    // Only start applying changes once the pointer has moved meaningfully.
    const DRAG_START_PX = 3.0;
    if (!dragDirty) {
      const movedPx = Math.hypot(dx, dy);
      if (movedPx < DRAG_START_PX) return;
      dragDirty = true;
    }
    const cam = engine.getCamera();
    const scr = engine.getScreen();

    if (dragMode === "graph") {
      lineGraphDrag.applyGraphDrag({ dxClient: dx, dyClient: dy, shiftKey: ev.shiftKey, startNodesById });
      applySelection();
      return;
    }

    if (dragMode === "line" && selected.size === 1) {
      const onlyId = Array.from(selected)[0];
      const h =
        activeHandle === "p1" || activeHandle === "p2"
          ? (activeHandle as "p1" | "p2")
          : ("mid" as const);
      lineGraphDrag.applyLineHandleDrag({ id: onlyId, activeHandle: h, dxClient: dx, dyClient: dy, shiftKey: ev.shiftKey, startNodesById });
      applySelection();
      return;
    }

    if (dragMode === "move") {
      for (const id of selected) {
        const s = startNodesById[id];
        if (!s) continue;
        const sp = s.space ?? "world";
        const ddxW = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
        const ddyW = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);
        const ui0: any = (s as any).__ui ?? null;
        const parentWorldT: any = ui0?.parentWorldT ?? null;
        const t0: any = ui0?.worldT ?? s.transform ?? {};
        let nxW = Number(t0.x ?? 0) + ddxW;
        let nyW = Number(t0.y ?? 0) + ddyW;

        // Snap ONLY when Shift is held during dragging (requested).
        // Snap the anchor point (x,y) to active grid intersections for world-space nodes.
        if (ev.shiftKey && sp === "world") {
          const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
          const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
          nxW = Math.round(nxW / snapSpacing) * snapSpacing;
          nyW = Math.round(nyW / snapSpacing) * snapSpacing;
        }

        if (parentWorldT && sp === "world") {
          const lp = _worldPointToLocal(parentWorldT, nxW, nyW);
          engine.updateNode(id, { transform: { x: lp.x, y: lp.y } as any } as any);
        } else {
          engine.updateNode(id, { transform: { x: nxW, y: nyW } as any } as any);
        }
      }
      return;
    }

    if (selected.size !== 1) return;
    const onlyId = Array.from(selected)[0];
    const startNode = startNodesById[onlyId];
    if (!startNode) return;
    const ui0: any = (startNode as any).__ui ?? null;
    const parentWorldT: any = ui0?.parentWorldT ?? null;
    const t0 = (ui0?.worldT ?? startNode.transform) as any;
    const sp = startNode.space ?? "world";
    const anchorClientFromWorldOrScreen = (t: any) => {
      const stageRect = stage.getBoundingClientRect();
      if (sp === "screen") {
        // Screen-space x/y are normalized fractions (anchor point).
        return {
          x: stageRect.left + Number(t?.x ?? 0) * Math.max(1, scr.w),
          y: stageRect.top + Number(t?.y ?? 0) * Math.max(1, scr.h),
        };
      }
      // World-space x/y are in world coordinates (anchor point). Convert via camera.
      const p = worldToScreen({ x: Number(t?.x ?? 0), y: Number(t?.y ?? 0) }, cam as any, scr as any);
      return { x: stageRect.left + p.x, y: stageRect.top + p.y };
    };
    const normalizeAnchor = (a: string | undefined) => {
      if (!a) return "topLeft";
      if (a === "top") return "topCenter";
      if (a === "bottom") return "bottomCenter";
      if (a === "left") return "centerLeft";
      if (a === "right") return "centerRight";
      if (a === "center") return "centerCenter";
      return a;
    };
    const anchorFrac = (a0: string | undefined) => {
      const a = normalizeAnchor(a0);
      const ax = a.endsWith("Left") ? 0 : a.endsWith("Right") ? 1 : 0.5;
      const ay = a.startsWith("Top") ? 0 : a.startsWith("Bottom") ? 1 : 0.5;
      return { ax, ay };
    };

    if (dragMode === "rotate") {
      const el = engine.getNodeElement(onlyId);
      const curModel = engine.getModel();
      const curNode: any = curModel?.nodes.find((n) => n.id === onlyId);
      const ac = anchorClientFromWorldOrScreen(t0);
      const a1 = Math.atan2(ev.clientY - ac.y, ev.clientX - ac.x);
      const d = (a1 - startAngleRad) * (180 / Math.PI);
      let rot = startRotationDeg + d;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      if (parentWorldT && sp === "world") {
        const parentRot = Number(parentWorldT?.rotationDeg ?? 0) || 0;
        engine.updateNode(onlyId, { transform: { rotationDeg: rot - parentRot } as any } as any);
      } else {
      engine.updateNode(onlyId, { transform: { rotationDeg: rot } as any } as any);
      }
      // Keep cursor angle in sync while snapping (otherwise it can look “stuck” until the next hover event).
      if (activeHandle) setBodyCursor(cursorForHandleWithRotation(activeHandle, rot));
      // Refresh selection chrome for composites without recreating node-level handles (which causes "double anchors").
      if (curNode?.type === "timer" || curNode?.type === "sound" || curNode?.type === "graph") applySelection();
      else if (el) ensureHandles(el);
      return;
    }

    if (dragMode === "resize" && activeHandle) {
      const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
      const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);
      const minW = sp === "world" ? 5 : 0.01;
      const minH = sp === "world" ? 5 : 0.01;

      // IMPORTANT: resizing should follow the VISUAL direction for rotated nodes.
      // Project mouse delta into the node's local (unrotated) coordinate system.
      const rotDeg = Number(t0?.rotationDeg ?? 0) || 0;
      const aInv = (-rotDeg * Math.PI) / 180; // world -> local (same convention as localPtForNode)
      const cInv = Math.cos(aInv);
      const sInv = Math.sin(aInv);
      const ddxL = ddx * cInv - ddy * sInv;
      const ddyL = ddx * sInv + ddy * cInv;
      const aFwd = (rotDeg * Math.PI) / 180; // local -> world
      const cF = Math.cos(aFwd);
      const sF = Math.sin(aFwd);
      const localToWorldDelta = (lx: number, ly: number) => ({ x: lx * cF - ly * sF, y: lx * sF + ly * cF });

      const curModel = engine.getModel();
      const curNode: any = curModel?.nodes.find((n) => n.id === onlyId);
      // Text-like scaling should apply to:
      // - text nodes (fontPx)
      // - bullets nodes (fontPx)
      // - choices nodes: scale internal UI via --ui-scale using fontPx as a multiplier baseline
      const isTextLike = curNode?.type === "text" || curNode?.type === "bullets" || curNode?.type === "choices";
      // IMPORTANT: base font must come from the drag start snapshot to avoid inversion/jitter.
      // For choices, use a stable baseline that maps to --ui-scale=1.
      const startFontPx =
        isTextLike && startNode != null
          ? curNode?.type === "choices"
            ? Number((startNode as any).fontPx ?? 24)
            : Number((startNode as any).fontPx ?? (t0.h ?? 40) * 0.6)
          : null;

      // Corner scaling:
      // - Text: scale on BOTH bottom corners (sw/se)
      // - Bullets: scale ONLY on bottom-right (se) to behave like a "text region" where edge resizes
      //            change wrapping/rows, and one corner scales the whole thing.
      const isScaleCorner =
        activeHandle === "sw" || activeHandle === "se"
          ? curNode?.type === "bullets"
            ? activeHandle === "se"
            : true
          : false;

      const snapSpacingWorld =
        ev.shiftKey && sp === "world"
          ? (() => {
              const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
              return t >= 0.5 ? spacing1 : spacing0;
            })()
          : null;
      const snapWorld = (v: number) => {
        const s = snapSpacingWorld;
        if (!(s && s > 0)) return v;
        return Math.round(v / s) * s;
      };

      // Resize/scale is anchored: anchor point stays fixed (x,y are anchor coords).
      const { ax, ay } = anchorFrac(t0.anchor);
      const w0 = Number(t0.w ?? 0);
      const h0 = Number(t0.h ?? 0);
      let w1 = w0;
      let h1 = h0;

      const canW = (v: number) => Math.max(minW, Number.isFinite(v) ? v : w0);
      const canH = (v: number) => Math.max(minH, Number.isFinite(v) ? v : h0);

      const denomE = Math.max(0, 1 - ax);
      const denomW = Math.max(0, ax);
      const denomS = Math.max(0, 1 - ay);
      const denomN = Math.max(0, ay);

      const wFromE = denomE > 1e-9 ? ((denomE * w0 + ddxL) / denomE) : w0;
      const wFromW = denomW > 1e-9 ? ((denomW * w0 - ddxL) / denomW) : w0;
      const hFromS = denomS > 1e-9 ? ((denomS * h0 + ddyL) / denomS) : h0;
      const hFromN = denomN > 1e-9 ? ((denomN * h0 - ddyL) / denomN) : h0;

      if (isScaleCorner) {
        // Uniform scaling about the anchor point.
        const wc = activeHandle.includes("e") ? wFromE : activeHandle.includes("w") ? wFromW : w0;
        const hc = activeHandle.includes("s") ? hFromS : activeHandle.includes("n") ? hFromN : h0;
        const sRaw = Math.max(wc / Math.max(1e-9, w0), hc / Math.max(1e-9, h0));
        let sUse = sRaw;
        if (snapSpacingWorld) {
          const wSn = Math.max(minW, snapWorld(w0 * sRaw));
          const hSn = Math.max(minH, snapWorld(h0 * sRaw));
          const sFromW = wSn / Math.max(1e-9, w0);
          const sFromH = hSn / Math.max(1e-9, h0);
          sUse = Math.abs(sFromW - sRaw) <= Math.abs(sFromH - sRaw) ? sFromW : sFromH;
        }
        w1 = canW(w0 * sUse);
        h1 = canH(h0 * sUse);
        if (isTextLike) {
          engine.updateNode(onlyId, { fontPx: Math.max(1, (startFontPx ?? 28) * (w1 / Math.max(1e-9, w0))) } as any);
        }
      } else {
        // Edge resize about the anchor point.
        if (activeHandle.includes("e")) w1 = canW(wFromE);
        if (activeHandle.includes("w")) w1 = canW(wFromW);
        if (activeHandle.includes("s")) h1 = canH(hFromS);
        if (activeHandle.includes("n")) h1 = canH(hFromN);
        // Edge resizing should NOT scale text font; initialize fontPx if missing so it stays stable.
        if (isTextLike && curNode?.fontPx == null) {
          engine.updateNode(onlyId, { fontPx: Math.max(1, startFontPx ?? 28) } as any);
        }
      }

      const worldOut = { ...t0, x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: w1, h: h1 } as any;
      if (parentWorldT && sp === "world") {
        const localAnchor = String((startNode as any)?.transform?.anchor ?? worldOut.anchor ?? "topLeft");
        const localOut = _toLocalTransformFromWorld(worldOut, parentWorldT, localAnchor);
        engine.updateNode(onlyId, { transform: { ...((startNode as any)?.transform ?? {}), ...localOut } as any } as any);
      } else {
        engine.updateNode(onlyId, { transform: worldOut as any } as any);
      }
    }
  }

  // Finish drag reliably even if pointerup happens outside the stage.
  function onWindowPointerUpCaptureSelect(ev: PointerEvent) {
    if (rectSelect && ev.pointerId === rectSelect.pointerId) {
      const rs = rectSelect;
      rectSelect = null;
      try {
        rs.el.style.display = "none";
      } catch {}

      // Right-click without marquee drag: clear selection on mouse up.
      if (!rs.dirty && ev.button === 2 && !rs.shiftKey && !rs.ctrlKey) {
        clearSelection();
        ev.preventDefault();
        return;
      }

      if (rs.dirty && getAppMode() === "edit" && tool === "select" && !compositeState.id) {
        const model = engine.getModel();
        if (model) {
          const activeViewId = getActiveViewId();
          const activeView = model.views.find((v) => String(v.id) === String(activeViewId)) ?? model.views[0];
          const show = new Set<string>((activeView?.show ?? []).map((x: any) => String(x)));
          const gid = activeGroupEditId();

          const l = Math.min(rs.startX, rs.lastX);
          const t = Math.min(rs.startY, rs.lastY);
          const r = Math.max(rs.startX, rs.lastX);
          const b = Math.max(rs.startY, rs.lastY);

          const hit = (rr: DOMRect) => rr.right >= l && rr.left <= r && rr.bottom >= t && rr.top <= b;

          const picked = new Set<string>();
          for (const n0 of model.nodes as any[]) {
            const rawId = String(n0?.id ?? "");
            if (!rawId) continue;

            const space = String(n0?.space ?? "world");
            if (screenEditMode) {
              if (space !== "screen") continue;
            } else {
              if (space === "screen") continue;
            }

            if (gid) {
              if (rawId === gid) continue;
              if (!isDescendantOf(rawId, gid, model)) continue;
            }

            if (show.size && !show.has(rawId)) continue;

            const el = engine.getNodeElement(rawId);
            if (!el) continue;
            if (el.classList.contains("ip-dim-node")) continue;
            const rr = el.getBoundingClientRect();
            if (!(rr.width > 0.5 && rr.height > 0.5)) continue;
            if (!hit(rr)) continue;

            picked.add(resolveSelectableId(rawId));
          }

          if (rs.ctrlKey) {
            for (const id of picked) {
              if (!id) continue;
              if (selected.has(id)) selected.delete(id);
              else selected.add(id);
            }
          } else if (rs.shiftKey) {
            for (const id of picked) if (id) selected.add(id);
          } else {
            selected.clear();
            for (const id of picked) if (id) selected.add(id);
          }
          applySelection();
        }
      }

      ev.preventDefault();
      return;
    }

    if (lineGraphBoxDrag) {
      const before = lineGraphBoxDrag.before;
      const dirty = lineGraphBoxDrag.dirty;
      lineGraphBoxDrag = null;
      setBodyCursor("");
      try {
        if (dirty) void commit(before);
      } catch {}
    }
    void finishDrag();
  }
  function onWindowPointerCancelCaptureSelect(_ev: PointerEvent) {
    // Cancel should not commit.
    lineGraphBoxDrag = null;
    if (rectSelect) {
      try {
        rectSelect.el.style.display = "none";
      } catch {}
      rectSelect = null;
    }
    try {
      setLineGraphMode("");
    } catch {}
    pendingCompositeDrag = null;
    dragMode = "none";
    activeHandle = null;
    setBodyCursor("");
    startNodesById = null;
    startSnapshot = null;
    dragDirty = false;
    const mx = (window as any).__ip_lastMouseX;
    const my = (window as any).__ip_lastMouseY;
    if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
  }
}

async function main() {
  const { canvas, overlay, stage } = buildShell();
  const engine = new Engine({ canvas, overlayEl: overlay, hitTestEl: stage });
  engine.mount();

  // Shared edit history across runtime plugins + editor keyboard shortcuts.
  let applySelectionRef = () => {};
  const history = createHistoryController({
    engine,
    cloneModel,
    saveModel,
    hydrateQrImages,
    hydrateTextMath,
    applySelection: () => applySelectionRef(),
  });

  // New runtime plugin system (library): element behavior is registered here,
  // so the host app stays thin and elements are reusable.
  const runtime = new Runtime({
    engine,
    stage,
    BACKEND,
    getAppMode: () => ((document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase() as any),
    onCommit: async (before) => {
      // Runtime plugins that mutate the model in Edit mode (e.g. table cell edits) call this.
      await history.commit(before);
    },
  });
  runtime.register(createGraphPlugin());
  runtime.register(createTimerPlugin());
  runtime.register(createChoicesPlugin());
  runtime.register(createSoundPlugin());
  runtime.register(createTablePlugin());
  runtime.startFrameLoop();

  if (DEBUG_ANIM) dlog("debugAnim=1 enabled");

  const model = await fetchModel();
  // Ensure plot axis arrows are REAL `arrow` nodes (not custom SVG overlays).
  // This guarantees consistent arrowhead geometry and makes them editable like normal elements.
  const ensurePlotAxisArrows = (m: any) => {
    if (!m || !Array.isArray(m.nodes)) return;
    const nodes: any[] = m.nodes;
    const hasId = new Set(nodes.map((n) => String(n?.id ?? "")));
    const PLOT = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };
    const mk = (parent: any, which: "x" | "y") => {
      const pid = String(parent?.id ?? "");
      if (!pid) return;
      const id = `${pid}__${which}_axis`;
      const space = String(parent?.space ?? "world");
      // IMPORTANT:
      // Child nodes in world-space groups use a UNIFORM scale based on the parent's height (engine resolveWorldTransform),
      // so local coordinates are in "parent height units" and X also scales by parent.h.
      // To place a child node at a fraction of the parent's WIDTH, we must multiply by aspect = parent.w/parent.h.
      const pt = parent?.transform ?? { w: 1, h: 1 };
      const aspect = Math.max(1e-9, Number(pt.w ?? 1)) / Math.max(1e-9, Number(pt.h ?? 1));
      const plotWF = PLOT.rightF - PLOT.leftF;
      const plotHF = PLOT.bottomF - PLOT.topF;
      const x = PLOT.leftF * aspect;
      const y = PLOT.topF;
      const w = plotWF * aspect;
      const h = plotHF;
      // Plot coordinate system for all data-region plots:
      // - origin = bottom-left of the data region
      // - x unit = data region WIDTH (so x spans [0..1])
      // - keep aspect equal by using the SAME unit for y
      //   => y spans [0 .. (height/width)] in "width units"
      const yMax = h / Math.max(1e-9, w);
      // Map plot coords (u in [0..1], vUp in [0..yMax]) -> arrow local coords (x in [0..1], yDown in [0..1]).
      const mapY = (vUp: number) => 1 - Math.max(0, Math.min(1, vUp / Math.max(1e-9, yMax)));
      const from = which === "x" ? { x: 0, y: mapY(0) } : { x: 0, y: mapY(0) };
      const to = which === "x" ? { x: 1, y: mapY(0) } : { x: 0, y: mapY(yMax) };
      const existing = nodes.find((n) => String(n?.id ?? "") === id) as any;
      const seedDefaults = (n: any) => {
        n.space = space;
        n.parentId = pid;
        n.visible = true;
        n.opacity = 1;
        n.zIndex = (Number(parent?.zIndex ?? 0) || 0) + 5;
        n.transform = { x, y, w, h, rotationDeg: 0, anchor: "topLeft" };
        n.from = from;
        n.to = to;
        n.color = String(parent?.color ?? "white") || "white";
        n.width = 2;
      };
      if (!existing) {
        const nn: any = { id, type: "arrow" };
        seedDefaults(nn);
        nodes.push(nn);
        hasId.add(id);
        return;
      }
      // Migration: if the axis node still has the old incorrect "square-assuming" defaults,
      // re-seed it to the corrected aspect-aware defaults. If the user has moved it, leave it alone.
      const t0 = existing.transform ?? {};
      const near = (a: any, b: any) => Math.abs(Number(a ?? NaN) - Number(b ?? NaN)) <= 1e-6;
      const looksOld =
        String(existing?.parentId ?? "") === pid &&
        String(existing?.type ?? "") === "arrow" &&
        String(existing?.space ?? "") === space &&
        String(t0?.anchor ?? "") === "topLeft" &&
        Number(t0?.rotationDeg ?? 0) === 0 &&
        // old defaults were fractions directly (x=0.08,y=0.10,w=0.84,h=0.8)
        near(t0.x, PLOT.leftF) &&
        near(t0.y, PLOT.topF) &&
        near(t0.w, plotWF) &&
        near(t0.h, plotHF);
      if (looksOld) {
        seedDefaults(existing);
      } else {
        // Keep user geometry, but ensure endpoints follow the plot coordinate convention.
        existing.from = from;
        existing.to = to;
      }
    };
    for (const n of nodes) {
      const t = String(n?.type ?? "");
      if (t !== "timer" && t !== "sound" && t !== "graph") continue;
      mk(n, "x");
      mk(n, "y");
    }
  };
  ensurePlotAxisArrows(model as any);
  preloadImageAssets(model);
  engine.setModel(model);
  runtime.onModel(model);

  // Sync plot axis arrow *defaults* to the actual DOM plot-region geometry.
  //
  // Rationale:
  // The timer/sound/graph runtime layout may not match the hardcoded fractions used for initial seeding
  // (e.g. aspect constraints, headers, responsive sizing). The *coordinate system basis* must be the real
  // plot/data-region rectangle that the user sees. We therefore measure the `.comp-sub[data-kind="plot-region"]`
  // element and migrate axis arrow transforms ONLY if the arrows still have default geometry.
  //
  // This runs a few frames after mount to allow the runtime to lay out the DOM.
  (() => {
    const near = (a: any, b: any, eps = 1e-6) => Math.abs(Number(a ?? NaN) - Number(b ?? NaN)) <= eps;
    const isDefaultAxisTransform = (axisT: any, parentT: any) => {
      const t0 = axisT ?? {};
      const pt = parentT ?? {};
      const aspect = Math.max(1e-9, Number(pt.w ?? 1)) / Math.max(1e-9, Number(pt.h ?? 1));
      const plotWF = 0.92 - 0.08;
      const plotHF = 0.90 - 0.10;
      const seedNew = { x: 0.08 * aspect, y: 0.10, w: plotWF * aspect, h: plotHF };
      const seedOld = { x: 0.08, y: 0.10, w: plotWF, h: plotHF }; // legacy (square-assuming)
      const basic =
        String(t0.anchor ?? "topLeft") === "topLeft" &&
        Number(t0.rotationDeg ?? 0) === 0 &&
        ((near(t0.x, seedNew.x) && near(t0.y, seedNew.y) && near(t0.w, seedNew.w) && near(t0.h, seedNew.h)) ||
          (near(t0.x, seedOld.x) && near(t0.y, seedOld.y) && near(t0.w, seedOld.w) && near(t0.h, seedOld.h)));
      return basic;
    };
    const syncOnce = () => {
      const m0: any = engine.getModel();
      if (!m0?.nodes) return { progressed: false, done: false };
      let progressed = false;
      let done = true;
      for (const n of m0.nodes as any[]) {
        const type = String(n?.type ?? "");
        if (type !== "timer" && type !== "sound" && type !== "graph") continue;
        const id = String(n?.id ?? "");
        if (!id) continue;
        const rootEl = engine.getNodeElement(id);
        if (!rootEl) {
          done = false;
          continue;
        }
        // The visible data region is rendered as an overlay background in the engine DOM.
        // Use that geometry as the axis coordinate system basis.
        const plotSel = type === "sound" ? ".sound-overlay-bg" : ".timer-overlay-bg";
        const plotEl = rootEl.querySelector<HTMLElement>(plotSel);
        if (!plotEl) {
          done = false;
          continue;
        }
        const pr = rootEl.getBoundingClientRect();
        const rr = plotEl.getBoundingClientRect();
        if (!(pr.height > 2 && rr.width > 2 && rr.height > 2)) {
          done = false;
          continue;
        }
        // Child transforms are in "parent height units" (uniform scaling), so normalize by parentRect.height.
        const domT = {
          x: (rr.left - pr.left) / pr.height,
          y: (rr.top - pr.top) / pr.height,
          w: rr.width / pr.height,
          h: rr.height / pr.height,
          anchor: "topLeft",
        };
        const xId = `${id}__x_axis`;
        const yId = `${id}__y_axis`;
        const xNode: any = m0.nodes.find((nn: any) => String(nn?.id ?? "") === xId);
        const yNode: any = m0.nodes.find((nn: any) => String(nn?.id ?? "") === yId);
        if (xNode?.type === "arrow" && String(xNode?.parentId ?? "") === id) {
          if (isDefaultAxisTransform(xNode.transform, n.transform)) {
            engine.updateNode(xId, { transform: { ...(xNode.transform ?? {}), ...domT } as any } as any);
            progressed = true;
          }
        }
        if (yNode?.type === "arrow" && String(yNode?.parentId ?? "") === id) {
          if (isDefaultAxisTransform(yNode.transform, n.transform)) {
            engine.updateNode(yId, { transform: { ...(yNode.transform ?? {}), ...domT } as any } as any);
            progressed = true;
          }
        }
      }
      return { progressed, done };
    };

    let tries = 0;
    const tick = () => {
      tries++;
      const { done } = syncOnce();
      // Stop when we successfully found plot regions for all relevant composites,
      // or after a reasonable number of frames.
      if (done || tries >= 60) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  dlog("loaded model", {
    views: model.views?.map((v) => ({ id: v.id, show: v.show?.slice?.(0, 50) })),
    animationCues: (model as any).animationCues
  });

  const viewsInOrder = model.views;
  let viewIdx = Math.max(0, viewsInOrder.findIndex((v) => v.id === model.initialViewId));
  let camTweenTimer: number | null = null;

  attachEditor(stage, engine, history, (fn) => {
    applySelectionRef = fn;
  });

  const DESIGN_H = (model as any).defaults?.designHeight ?? 1080;
  const DESIGN_W = (model as any).defaults?.designWidth ?? 1920;
  const baseViewCam = (viewsInOrder[0] as any)?.camera ?? { cx: 0, cy: 0, zoom: 1 };
  const toActualCamera = (c: { cx: number; cy: number; zoom: number }) => {
    // Treat model camera.zoom as a "zoom factor" relative to fitting the design viewport.
    // Fit BOTH width+height so authored defaults stay inside the view for any window size.
    const scr = engine.getScreen();
    const fit = Math.min(scr.h / DESIGN_H, scr.w / DESIGN_W);
    return {
      // IMPORTANT: keep cx/cy in the same world space as nodes. Scaling camera centers without
      // scaling node positions causes view content to drift offscreen.
      cx: c.cx,
      cy: c.cy,
      zoom: c.zoom * fit,
    };
  };

  const setView = (idx: number, animate: boolean) => {
    const prevIdx = viewIdx;
    viewIdx = Math.max(0, Math.min(viewsInOrder.length - 1, idx));
    const v = viewsInOrder[viewIdx];
    const prevView = viewsInOrder[prevIdx];
    if (!v) return;

    // If we leave a view, stop any running interactive sessions (acts like pressing Stop).
    // This prevents "dangling" accepting states when the presenter navigates away.
    if (presentationStarted && prevView?.id && v.id !== prevView.id) {
      runtime.stopInteractiveSessions();
    }

    // Expose current view to the editor layer (context menu uses this).
    stage.dataset.viewId = v.id;
    stage.dataset.viewIdx = String(viewIdx);
    if (camTweenTimer != null) window.clearTimeout(camTweenTimer);
    camTweenTimer = null;

    if (!animate) {
      engine.setCamera(toActualCamera(v.camera));
      return;
    }

    // Transition rule:
    // - Always translate from old center -> new center.
    // - If we need to zoom out to fit BOTH the old view rect and new view rect on screen,
    //   do a two-stage zoom: out-to-fit-union, then in-to-target.
    // - If the new view is already "in view" (no union-fit zoom-out needed), just tween directly.
    // Manual pan/zoom must NOT affect which view is "next",
    // but the transition should start from the CURRENT camera (no snapping).
    const from = engine.getCamera();
    const to = toActualCamera(v.camera);
    const scr = engine.getScreen();

    const rectOf = (c: { cx: number; cy: number; zoom: number }) => {
      const hw = scr.w / 2 / c.zoom;
      const hh = scr.h / 2 / c.zoom;
      return { left: c.cx - hw, right: c.cx + hw, top: c.cy - hh, bottom: c.cy + hh };
    };

    const r0 = rectOf(from);
    const r1 = rectOf(to);
    const left = Math.min(r0.left, r1.left);
    const right = Math.max(r0.right, r1.right);
    const top = Math.min(r0.top, r1.top);
    const bottom = Math.max(r0.bottom, r1.bottom);
    const unionW = Math.max(1e-9, right - left);
    const unionH = Math.max(1e-9, bottom - top);
    const zoomToFitUnion = Math.min(scr.w / unionW, scr.h / unionH);

    const needZoomOut = zoomToFitUnion < Math.min(from.zoom, to.zoom) - 1e-6;
    const transitionMs = (v as any).transitionMs ?? (model as any).defaults?.viewTransitionMs ?? 4000;
    if (!needZoomOut) {
      engine.transitionToCamera(to, transitionMs);
      return;
    }

    const mid = { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, zoom: zoomToFitUnion };
    const half = Math.max(1, Math.floor(transitionMs / 2));
    engine.transitionToCamera(mid, half);
    camTweenTimer = window.setTimeout(() => engine.transitionToCamera(to, transitionMs - half), half);
  };
  setView(viewIdx, false);

  await hydrateQrImages(engine, model);
  hydrateTextMath(engine, model);
  // Timer is handled by the runtime plugin system (see runtime.register(createTimerPlugin())).
  // Choices is handled by the runtime plugin system (see runtime.register(createChoicesPlugin())).
  // Sound is handled by the runtime plugin system (see runtime.register(createSoundPlugin())).
  // Graph is now handled by the runtime plugin system (see runtime.register(createGraphPlugin())).
  attachPlotPanZoom(stage);

  // Mode toggle: Edit vs Live
  const modeWrap = document.createElement("div");
  modeWrap.className = "mode-toggle";
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  const modeHint = document.createElement("div");
  modeHint.className = "hint";
  modeWrap.append(modeBtn, modeHint);
  stage.appendChild(modeWrap);

  let detach: (() => void) | null = null;
  let mode: "edit" | "live" = (localStorage.getItem("ip_mode") as any) === "live" ? "live" : "edit";

  const applyMode = () => {
    // Always leave any edit sub-modes before toggling.
    try {
      exitCompositeEdit();
    } catch {}
    try {
      while (isGroupEditing()) exitGroupEdit();
    } catch {}
    exitScreenEdit();
    localStorage.setItem("ip_mode", mode);
    modeWrap.dataset.mode = mode;
    document.documentElement.dataset.ipMode = mode;
    modeBtn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
    modeHint.textContent =
      mode === "live" ? "Live: left/right step, up/down view • editing disabled" : "Edit: drag/resize/rotate • double-click edit";

    detach?.();
    detach = null;

    // Hard guarantee: strip any leftover selection/transform UI when entering Live.
    if (mode === "live") {
      document.documentElement.style.cursor = "";
      document.querySelector(".edit-toolbox")?.remove();
      for (const h of Array.from(stage.querySelectorAll<HTMLElement>(".handles"))) h.remove();
      for (const n of Array.from(stage.querySelectorAll<HTMLElement>(".node.is-selected"))) n.classList.remove("is-selected");
      for (const s of Array.from(stage.querySelectorAll<HTMLElement>(".timer-sub.is-selected, .comp-sub.is-selected")))
        s.classList.remove("is-selected");
    }

    if (mode === "edit") {
      // Stop polling in edit mode
      presentationStarted = false;
      engine.setPanZoomEnabled(true);
      engine.setAnimationsEnabled(false);
      // In edit, show EVERYTHING (across all views) on the infinite surface.
      for (const n of model.nodes) n.visible = true;
      engine.setModel(model);
      void hydrateQrImages(engine, model).then(() => hydrateTextMath(engine, model));
      // Timer is handled by the runtime plugin system.
      // Choices is handled by the runtime plugin system.
      // Sound is handled by the runtime plugin system.
      runtime.onModel(model);
      attachEditor(stage, engine, history, (fn) => {
        applySelectionRef = fn;
      });
      return;
    }

    // Live mode: enable polling
    presentationStarted = true;
    engine.setPanZoomEnabled(false);
    engine.setAnimationsEnabled(true);
    // When switching into Live, choose the view closest to the *current* camera center
    // (so presenters can pan around in Edit and start Live from the nearest authored view).
    {
      const cam = engine.getCamera();
      let bestIdx = viewIdx;
      let bestD2 = Number.POSITIVE_INFINITY;
      for (let i = 0; i < viewsInOrder.length; i++) {
        const v = viewsInOrder[i] as any;
        if (!v || !v.camera) continue; // skip screen views / malformed
        const dx = Number(cam.cx ?? 0) - Number(v.camera.cx ?? 0);
        const dy = Number(cam.cy ?? 0) - Number(v.camera.cy ?? 0);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = i;
        }
      }
      // Snap to the chosen view camera (no smooth transition).
      setView(bestIdx, false);
    }

    const allCues = (model as any).animationCues as Array<{ id: string; when: "enter" | "exit" }> | undefined;
    let showSet = new Set<string>();
    let cues: Array<{ id: string; when: "enter" | "exit" }> = [];

    const rebuildForCurrentView = () => {
      const vcur = viewsInOrder[viewIdx];
      showSet = new Set(vcur?.show ?? []);
      cues = (allCues ?? []).filter((c) => showSet.has(c.id));
    };
    rebuildForCurrentView();

    // (debug logging removed)
    let cueIdx = 0;
    const pendingHide = new Map<string, number>();

    const clearPendingHide = (id: string) => {
      const t = pendingHide.get(id);
      if (t != null) window.clearTimeout(t);
      pendingHide.delete(id);
    };

    const hideWithOptionalExit = (id: string) => {
      const m = engine.getModel();
      const node = (m?.nodes.find((n) => n.id === id) as any) ?? null;
      const dis = node?.disappear;
      const el = engine.getNodeElement(id);
      clearPendingHide(id);
      dlog("hide", id, { hasExit: !!(dis && dis.kind && dis.kind !== "none"), disKind: dis?.kind });

      if (el && dis && dis.kind && dis.kind !== "none") {
        // Start exit animation; keep visible until finished, then hide.
        (el.dataset as any).exitStartMs = String(engine.getTimeMs());
        engine.updateNode(id, { visible: true } as any);

        const dur = Number(dis.durationMs ?? 0);
        const delay = Number(dis.delayMs ?? 0);
        const total = Math.max(0, delay + dur);
        const timeoutId = window.setTimeout(() => {
          engine.updateNode(id, { visible: false } as any);
          clearPendingHide(id);
        }, total);
        pendingHide.set(id, timeoutId);
      } else {
        engine.updateNode(id, { visible: false } as any);
      }
    };

    const showWithOptionalEnter = (id: string, restartEnter: boolean) => {
      clearPendingHide(id);
      engine.updateNode(id, { visible: true } as any);
      if (!restartEnter) return;
      const m = engine.getModel();
      const node = (m?.nodes.find((n) => n.id === id) as any) ?? null;
      const ap = node?.appear;
      const el = engine.getNodeElement(id);
      dlog("show", id, { restartEnter, hasEnter: !!(ap && ap.kind && ap.kind !== "none"), apKind: ap?.kind });
      if (el && ap && ap.kind && ap.kind !== "none") {
        delete (el.dataset as any).animInStartMs;
        delete (el.dataset as any).exitStartMs;
        // Reset pixelate latch so pixelate can replay when explicitly re-entered.
        delete (el.dataset as any).pixAnimStartMs;
        delete (el.dataset as any).pixAnimDone;
        // Hint the renderer to start pixelate as soon as the image is ready.
        if (ap.kind === "pixelate") (el.dataset as any).pixPending = "1";
      }
    };

    const applyBaseline = (preserveExisting: boolean) => {
      rebuildForCurrentView();
      // Baseline: anything WITHOUT an enter cue is visible immediately.
      const enterIds = new Set(cues.filter((c) => c.when === "enter").map((c) => c.id));
      // Safety: if a node has appear spec (from animations.csv) but cue list is missing for any reason,
      // still treat it as an "enter-controlled" node.
      const m = engine.getModel();
      const visibleNow = new Set<string>();
      for (const n of m?.nodes ?? []) if (n.visible !== false) visibleNow.add(n.id);
      for (const n of m?.nodes ?? []) {
        const ap: any = (n as any).appear;
        if (showSet.has(n.id) && ap && ap.kind && ap.kind !== "none") enterIds.add(n.id);
      }

      // Live semantics:
      // - Never hide previously shown nodes when navigating views unless an explicit EXIT cue hides them.
      // - When preserveExisting=true (view change), only manage nodes in this view:
      //   - non-enter nodes become visible
      //   - enter nodes become hidden ONLY if not already visible (i.e. not shown before)
      for (const id of showSet) {
        const enterControlled = enterIds.has(id);
        const alreadyVisible = visibleNow.has(id);
        if (!enterControlled) {
          engine.updateNode(id, { visible: true } as any);
        } else if (!alreadyVisible) {
          engine.updateNode(id, { visible: false } as any);
        } else if (!preserveExisting) {
          // At Live start, allow baseline to hide enter-controlled items (fresh run).
          engine.updateNode(id, { visible: false } as any);
        }
      }
      const m2 = engine.getModel();
      if (m2) void hydrateQrImages(engine, m2).then(() => hydrateTextMath(engine, m2));
    };

    const stepForward = () => {
      rebuildForCurrentView();
      if (cueIdx >= cues.length) return;
      const cue = cues[cueIdx++];
      dlog("cue forward", cueIdx - 1, cue);
      if (cue.when === "enter") {
        showWithOptionalEnter(cue.id, true);
        if (cue.id === "join_qr") {
          const el = engine.getNodeElement("join_qr");
          const img = el?.querySelector<HTMLImageElement>("img.image");
          const canvas = el?.querySelector<HTMLCanvasElement>("canvas.image-canvas");
        }
      } else {
        hideWithOptionalExit(cue.id);
      }
    };

    const stepBack = () => {
      rebuildForCurrentView();
      if (cueIdx <= 0) return;
      const cue = cues[--cueIdx];
      dlog("cue back", cueIdx, cue);
      // Undo cue:
      if (cue.when === "enter") {
        // Remove what we previously entered.
        hideWithOptionalExit(cue.id);
      } else {
        // Restore what we previously exited.
        showWithOptionalEnter(cue.id, true);
      }
    };

    // Start at baseline; cues then drive changes.
    cueIdx = 0;
    applyBaseline(false);

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onMouseDown = (e: MouseEvent) => {
      // When interacting with plots, don't treat clicks as navigation.
      const hit = (e.target as HTMLElement | null)?.closest<HTMLElement>(".node-timer, .node-sound");
      if (hit && _isInsidePlot(hit, e.clientX, e.clientY)) return;
      // left click = back, right click = forward
      if (e.button === 0) {
        stepBack();
      } else if (e.button === 2) {
        stepForward();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepForward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepBack();
      } else if (e.key === "ArrowDown") {
        dlog("nav down", { from: viewsInOrder[viewIdx]?.id, to: viewsInOrder[Math.min(viewsInOrder.length - 1, viewIdx + 1)]?.id });
        setView(viewIdx + 1, true);
        // reset baseline+cue index for the new view
        cueIdx = 0;
        applyBaseline(true);
      } else if (e.key === "ArrowUp") {
        dlog("nav up", { from: viewsInOrder[viewIdx]?.id, to: viewsInOrder[Math.max(0, viewIdx - 1)]?.id });
        setView(viewIdx - 1, true);
        cueIdx = 0;
        applyBaseline(true);
      }
    };

    stage.addEventListener("contextmenu", onContextMenu);
    stage.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    detach = () => {
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  };

  modeBtn.addEventListener("click", () => {
    // IMPORTANT: stale `__ip_exit*` hooks can remain if their internal state was reset.
    // If the button label indicates "Switch to ...", we should not be blocked by stale hooks.
    const label = (modeBtn.textContent ?? "").toLowerCase();
    const intendsToggle = label.includes("switch to");

    const tryExit = (kind: "composite" | "group" | "screen", behavior: "exit" | "toggle") => {
      const wasActive = kind === "composite" ? isCompositeEditing() : kind === "group" ? isGroupEditing() : !!screenEditMode;
      if (!wasActive) return false;
      try {
        if (kind === "composite") exitCompositeEdit();
        else if (kind === "group") while (isGroupEditing()) exitGroupEdit();
        else if (kind === "screen") exitScreenEdit();
      } catch {}
      if (behavior === "exit") return true;
      // Toggle-mode cleanup: only return early if still active.
      const stillActive = kind === "composite" ? isCompositeEditing() : kind === "group" ? isGroupEditing() : !!screenEditMode;
      return stillActive;
    };

    if (!intendsToggle) {
      if (tryExit("composite", "exit")) return;
      if (tryExit("group", "exit")) return;
      if (tryExit("screen", "exit")) return;
    } else {
      // Clean up any stale hooks, but don't return unless they remain active.
      if (tryExit("composite", "toggle")) return;
      if (tryExit("group", "toggle")) return;
      if (tryExit("screen", "toggle")) return;
    }

    mode = mode === "edit" ? "live" : "edit";
    applyMode();
  });

  // Keep view layout stable across window resizes:
  // the next view should always be just outside the visible viewport.
  window.addEventListener("resize", () => {
    if ((modeWrap.dataset.mode ?? "edit").toLowerCase() !== "live") return;
    const v = viewsInOrder[viewIdx];
    if (!v) return;
    engine.setCamera(toActualCamera(v.camera));
  });

  // Keyboard shortcuts:
  // - Ctrl+E: switch to Edit
  // - Ctrl+L: switch to Live
  window.addEventListener("keydown", (ev) => {
    if (!ev.ctrlKey) return;
    const k = (ev.key || "").toLowerCase();
    // Don't steal shortcuts while typing.
    const ae = document.activeElement as HTMLElement | null;
    const tag = (ae?.tagName || "").toLowerCase();
    const isTyping = !!ae && (tag === "input" || tag === "textarea" || (ae as any).isContentEditable);
    if (isTyping) return;
    if (k === "e") {
      mode = "edit";
      applyMode();
      ev.preventDefault();
      return;
    }
    if (k === "l") {
      mode = "live";
      applyMode();
      ev.preventDefault();
      return;
    }
  });

  modeBtn.addEventListener("click", () => {
    // IMPORTANT: stale `__ip_exit*` hooks can remain if their internal state was reset.
    // If the button label indicates "Switch to ...", we should not be blocked by stale hooks.
    const label = (modeBtn.textContent ?? "").toLowerCase();
    const intendsToggle = label.includes("switch to");

    const tryExit = (kind: "composite" | "group" | "screen", behavior: "exit" | "toggle") => {
      const wasActive = kind === "composite" ? isCompositeEditing() : kind === "group" ? isGroupEditing() : !!screenEditMode;
      if (!wasActive) return false;
      try {
        if (kind === "composite") exitCompositeEdit();
        else if (kind === "group") while (isGroupEditing()) exitGroupEdit();
        else if (kind === "screen") exitScreenEdit();
      } catch {}
      if (behavior === "exit") return true;
      // Toggle-mode cleanup: only return early if still active.
      const stillActive = kind === "composite" ? isCompositeEditing() : kind === "group" ? isGroupEditing() : !!screenEditMode;
      return stillActive;
    };

    if (!intendsToggle) {
      if (tryExit("composite", "exit")) return;
      if (tryExit("group", "exit")) return;
      if (tryExit("screen", "exit")) return;
    } else {
      // Clean up any stale hooks, but don't return unless they remain active.
      if (tryExit("composite", "toggle")) return;
      if (tryExit("group", "toggle")) return;
      if (tryExit("screen", "toggle")) return;
    }

    mode = mode === "edit" ? "live" : "edit";
    applyMode();
  });

  applyMode();
}

export async function bootstrap() {
  try {
    await main();
  } catch (err) {
    // Always surface unexpected errors.
    // eslint-disable-next-line no-console
    console.error(err);
    const app = document.querySelector<HTMLDivElement>("#app");
    if (app) app.textContent = String(err);
  }
}


