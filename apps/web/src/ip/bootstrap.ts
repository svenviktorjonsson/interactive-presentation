import type { PresentationModel } from "@interactive/content";
import { Engine, screenToWorld, worldToScreen } from "@interactive/engine";
import { DEBUG_ANIM, dlog, BACKEND } from "./config";
import { fetchModel, preloadImageAssets, saveModel } from "./api/presentation";
import { uploadImageToMedia, loadImageSize } from "./api/media";
import { hydrateQrImages } from "./features/qr";
import { hydrateTextMath, renderTextToElement, renderTextWithKatexToHtml } from "./features/textMath";
import { drawGrid, drawTicksAndLabels, fixedTicks, mergeTickAnchors, niceTicks, prepareCanvas } from "./features/plot2d";
import { buildShell } from "./ui/shell";


type TimerState = {
  accepting: boolean;
  samplesMs: number[];
  stats: { n: number; meanMs: number | null; sigmaMs: number | null };
};

let __timerPollStarted = false;
let __timerState: TimerState | null = null;
let __timerPollingEnabled = false;

type ChoiceOptionState = { id: string; label: string; color?: string; votes: number; percent: number };
type ChoicesState = {
  pollId: string;
  question: string;
  bullets?: string;
  chart?: string;
  options: ChoiceOptionState[];
  accepting: boolean;
  totalVotes: number;
};

let __choicesPollStarted = false;
const __choicesState: Record<string, ChoicesState | null> = {};
const __activeChoicesPollIds = new Set<string>();
// Choices are always rendered live (no separate "results mode").

// Screen edit state (shared across handlers)
let screenEditMode = false;
let screenDimmedEls: HTMLElement[] = [];
let lastContextScreen: { x: number; y: number } | null = null;
let enterScreenEdit: () => void = () => {};
let exitScreenEdit: () => void = () => {};

// Table editing (single-click, Excel-like)
let __activeTableEdit:
  | null
  | {
      tableId: string;
      row: number;
      col: number;
      td: HTMLTableCellElement;
      input: HTMLInputElement;
      beforeValue: string;
    } = null;

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

async function fetchTimerState(): Promise<TimerState | null> {
  try {
    const res = await fetch(`${BACKEND}/api/timer/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TimerState;
  } catch {
    return null;
  }
}

async function fetchChoicesState(pollId: string): Promise<ChoicesState | null> {
  if (!pollId) return null;
  try {
    const res = await fetch(`${BACKEND}/api/choices/state?pollId=${encodeURIComponent(pollId)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ChoicesState;
  } catch {
    return null;
  }
}

async function simulateChoicesVotes(pollId: string, opts: { users?: number } = {}) {
  const users = Math.max(1, Math.floor(opts.users ?? 30));
  // Simulate votes WITHOUT starting the poll (phones should remain in standby).
  await fetch(`${BACKEND}/api/choices/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pollId, users, reset: true }),
  });
}

function bulletFor(idx: number, style: string) {
  const i = idx + 1;
  if (style === "a") return String.fromCharCode(96 + i) + ".";
  if (style === "A") return String.fromCharCode(64 + i) + ".";
  if (style === "I") {
    const romans = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
    return (romans[i - 1] ?? String(i)) + ".";
  }
  return `${i}.`;
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

function drawChoicesPie(el: HTMLElement, opts: Array<{ color?: string; votes: number }>) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.choices-chart-canvas");
  if (!canvas) return;
  // Skip when hidden.
  if (el.offsetParent === null) return;
  const wheel = canvas.closest<HTMLElement>(".choices-wheel") ?? el;
  const r = wheel.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(30, Math.min(r.width, r.height)) * dpr;
  const W = Math.max(2, Math.round(size));
  const H = W;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const total = Math.max(0, opts.reduce((s, o) => s + Math.max(0, o.votes || 0), 0));
  const cx = W / 2;
  const cy = H / 2;
  // Make the wheel fill the selectable square more tightly
  // (so the selection box visually matches the wheel).
  const r0 = Math.max(10, Math.min(W, H) / 2 - 2);
  const borderW = Math.max(2, dpr * 4);
  const strokeCol = "rgba(255,255,255,0.92)";
  const ringCol = "rgba(255,255,255,0.92)";
  let start = -Math.PI / 2;
  const colors = ["#4caf50", "#e53935", "#1e88e5", "#ab47bc", "#00bcd4", "#fdd835", "#8d6e63"];
  const boundaries: number[] = [start];
  if (total > 0) {
    // Draw slices.
    opts.forEach((opt, idx) => {
      const val = Math.max(0, opt.votes || 0);
      if (val <= 0) return;
      const frac = val / total;
      const end = start + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r0, start, end);
      ctx.closePath();
      ctx.fillStyle = opt.color || colors[idx % colors.length];
      ctx.globalAlpha = 0.92;
      ctx.fill();
      boundaries.push(end);
      start = end;
    });
  }

  // Slice separators (thick white dividers).
  ctx.globalAlpha = 1;
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = borderW;
  for (const a of boundaries) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.stroke();
  }

  // Outer ring (always), thick.
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r0, 0, Math.PI * 2);
  ctx.strokeStyle = ringCol;
  ctx.lineWidth = borderW;
  ctx.stroke();
}

function renderChoicesNode(engine: Engine, el: HTMLElement, node: any, state: ChoicesState | null) {
  const question = el.querySelector<HTMLElement>(".choices-question");
  const list = el.querySelector<HTMLElement>(".choices-list");
  const total = el.querySelector<HTMLElement>(".choices-total");
  const startBtn = el.querySelector<HTMLButtonElement>('button[data-action="choices-startstop"]');
  const resetBtn = el.querySelector<HTMLButtonElement>('button[data-action="choices-reset"]');

  const accepting = !!state?.accepting;
  const choiceElText = String(node?.elementsText ?? "");
  const bulletSpec = _parseChoicesBulletsSpec(choiceElText);
  const wheelSpec = _parseChoicesWheelSpec(choiceElText);
  const bullet = String(state?.bullets ?? bulletSpec.type ?? (node?.bullets ?? "A"));
  const optsFromNode: Array<any> = Array.isArray(node?.options) ? node.options : [];
  const resultsVisible = true;
  el.dataset.resultsVisible = "1";

  if (question) question.textContent = state?.question || node?.question || "Poll";
  if (startBtn) {
    const hasRunOnce = _getHasRunOnce(el);
    startBtn.textContent = runPauseResumeLabel(accepting, hasRunOnce);
  }
  if (resetBtn) resetBtn.disabled = !optsFromNode.length;

  const options: Array<ChoiceOptionState> = optsFromNode.map((opt: any) => {
    const st = state?.options?.find((o) => o.id === opt.id);
    return {
      id: opt.id,
      label: opt.label,
      color: opt.color,
      votes: st?.votes ?? 0,
      percent: st?.percent ?? 0,
    };
  });

  const totalVotes = state?.totalVotes ?? options.reduce((s, o) => s + o.votes, 0);
  if (total) total.textContent = totalVotes > 0 ? `${totalVotes} vote${totalVotes === 1 ? "" : "s"}` : "-";

  if (list) {
    list.innerHTML = "";
    options.forEach((opt, idx) => {
      const row = document.createElement("div");
      row.className = "choices-row";
      const label = document.createElement("div");
      label.className = "choices-label";
      const swatch = document.createElement("span");
      swatch.className = "choices-swatch";
      // Allow wheel to override colors; keep bullets/wheel/pie consistent.
      const wheelParsed = _parseWheelElementsPr(String(node?.wheelElementsPr ?? ""));
      const col = wheelParsed.colors[String(opt.id ?? "")] ?? opt.color;
      if (col) {
        swatch.style.background = col;
        swatch.style.borderColor = col;
      }
      const text = document.createElement("span");
      // Bullets are explicit rows in elements.pr (no templating here).
      const rawItem = bulletSpec.items[idx] ?? String(opt.label ?? `Option ${idx + 1}`);
      text.textContent = `${bulletFor(idx, bullet)} ${rawItem}`;
      label.append(swatch, text);
      // No per-option vote/percent meta in the bullets list (keep it as regular bullets).
      row.append(label);
      list.appendChild(row);
    });
  }

  // Always render bullets + chart together (animations can hide/reveal if desired).
  const bulletsGroup = el.querySelector<HTMLElement>(".choices-bullets");
  const wheelGroup = el.querySelector<HTMLElement>(".choices-wheel-group");
  if (bulletsGroup) bulletsGroup.style.display = "flex";
  if (wheelGroup) wheelGroup.style.display = "block";

  const includeLimit = Number(
    wheelSpec.minLevel ??
      node?.includeLimit ??
      node?.minPct ??
      node?.min ??
      el.dataset.includeLimit ??
      "3"
  );
  const textInsideLimit = Number(
    wheelSpec.textInsideLimit ??
      node?.textInsideLimit ??
      node?.minInsidePct ??
      node?.minInside ??
      el.dataset.textInsideLimit ??
      "6"
  );
  const otherLabel = String(wheelSpec.otherLabel ?? node?.otherLabel ?? el.dataset.otherLabel ?? "Other") || "Other";

  // Wheel sub-elements define templates + optional color overrides.
  const wheelParsed = _parseWheelElementsPr(String(node?.wheelElementsPr ?? ""));
  const resolveSliceColor = (id: string, fallback: string | undefined) => wheelParsed.colors[id] ?? fallback;

  // Bucket tiny slices into "Other"
  const big: Array<{ id: string; color?: string; votes: number; percent: number; label: string }> = [];
  let otherVotes = 0;
  let otherPercent = 0;
  for (const o of options) {
    const p = Number(o.percent ?? 0);
    if (Number.isFinite(includeLimit) && p > 0 && p < includeLimit) {
      otherVotes += Number(o.votes ?? 0);
      otherPercent += p;
    } else {
      // If there are no votes yet, draw equal slices visually, but show "-" in labels.
      const v = totalVotes > 0 ? o.votes : 1;
      const id = String(o.id ?? "");
      big.push({
        id,
        color: resolveSliceColor(id, o.color),
        votes: v,
        percent: totalVotes > 0 ? p : (NaN as any),
        label: o.label
      });
    }
  }
  if (otherVotes > 0) {
    big.push({
      id: "other",
      color: resolveSliceColor("other", "rgba(255,255,255,0.35)"),
      votes: otherVotes,
      percent: otherPercent,
      label: otherLabel
    });
  }
  drawChoicesPie(el, big.map((o) => ({ color: o.color, votes: o.votes })));
  renderChoicesWheelOverlay(engine, String(node?.id ?? ""), big, { totalVotes, otherLabel, textInsideLimit });
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

async function simulateTimerSubmissions(timerEl: HTMLElement, opts?: { users?: number; durationMs?: number }) {
  const users = Math.max(1, Math.floor(opts?.users ?? 30));
  const totalMs = Math.max(250, Math.floor(opts?.durationMs ?? 5000));

  // Derive a sensible distribution from the configured domain.
  const minS = Number(timerEl.dataset.minS ?? "0");
  const maxS = Number(timerEl.dataset.maxS ?? "40");
  const span = Math.max(1e-6, maxS - minS);
  const muS = (minS + maxS) / 2;
  const sigmaS = span / 6; // ~99.7% within domain

  // Reset + start accepting so we exercise the exact same backend path as real phones.
  await fetch(`${BACKEND}/api/timer/reset`, { method: "POST" });
  await fetch(`${BACKEND}/api/timer/start`, { method: "POST" });

  const startedAt = performance.now();
  const promises: Promise<void>[] = [];
  for (let i = 0; i < users; i++) {
    const delay = (i / Math.max(1, users - 1)) * totalMs;
    const p = new Promise<void>((resolve) => {
      window.setTimeout(async () => {
        // Sample, clamp into domain.
        let s = muS + sigmaS * _randn01();
        if (!Number.isFinite(s)) s = muS;
        s = Math.max(minS, Math.min(maxS, s));
        const ms = s * 1000;
        try {
          await fetch(`${BACKEND}/api/timer/submit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ durationMs: ms }),
          });
        } finally {
          resolve();
        }
      }, delay);
    });
    promises.push(p);
  }

  await Promise.all(promises);
  await fetch(`${BACKEND}/api/timer/stop`, { method: "POST" });

  // Refresh local state once at the end (poll will also pick it up).
  __timerState = await fetchTimerState();

}

function drawTimerNode(el: HTMLElement, state: TimerState) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.timer-canvas");
  if (!canvas) return;
  // Use shared plot rect fractions (same for all graph-like nodes).
  const prep = prepareCanvas(el, canvas, _plotFracsForEl(el));
  if (!prep) return;
  const { ctx, dpr, rect: r, plot } = prep;
  const { ox, oy, xLen, yLen } = plot;

  // No border around the graph area. The data rect is an invisible reference;
  // only ticks/ticklabels should "stick out" of it.

  // Data
  const samples = state.samplesMs ?? [];
  const n = samples.length;
  const barColor = el.dataset.barColor ?? "orange";
  const lineColor = el.dataset.lineColor ?? "green";
  const lineWidthPx = Math.max(0.5, Number(el.dataset.lineWidth ?? "2"));
  const gridOn = String(el.dataset.grid ?? "").toLowerCase() === "true";

  // Domain and binning (seconds)
  const baseMinS = Number(el.dataset.minS ?? "0");
  const maxSDefault = Math.max(1, ...samples.map((x) => x / 1000));
  const baseMaxS = Number(el.dataset.maxS ?? String(Math.max(1, maxSDefault)));
  const binSizeS = Number(el.dataset.binSizeS ?? "0.5");
  const spanBase = Math.max(1e-9, baseMaxS - baseMinS);
  const bins = Math.max(1, Math.round(spanBase / binSizeS));
  const counts = new Array(bins).fill(0);
  for (const ms of samples) {
    const s = ms / 1000;
    const idx = Math.max(0, Math.min(bins - 1, Math.floor(((s - baseMinS) / spanBase) * bins)));
    counts[idx] += 1;
  }
  const perc = counts.map((c) => (n > 0 ? c / n : 0));

  // Bars
  // Normalize y so the view shows up to 1.1× the highest bar.
  const maxBar = Math.max(0, ...perc);
  const yMaxAuto = Math.max(1e-9, maxBar * 1.1);

  // Current view range (pan/zoom)
  const id = el.dataset.nodeId ?? "timer";
  const key = `timer:${id}`;
  const pr0 = __plotRanges.get(key);
  const xMin = pr0?.xMin ?? baseMinS;
  const xMax = pr0?.xMax ?? baseMaxS;
  const yMin = pr0?.yMin ?? 0;
  const yMax = pr0?.yMax ?? yMaxAuto;
  const xSpan = Math.max(1e-9, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);
  const yScale = yLen / ySpan;

  // Ticks + tick labels (KaTeX font) — drawn on the canvas layer.
  // X ticks are based on current view range (pan/zoom).
  const fmt = (v: number) => {
    // Avoid noisy decimals but keep bin edges like 20.5.
    const s = Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
    return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  };

  const xTickVals = niceTicks(xMin, xMax, 7, [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60], fmt);
  const xTicks = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
  const yTicks: Array<{ yFrac: number; label: string }> = [];
  // y is a fraction (0..1-ish). Show labels in %.
  const yTickVals = niceTicks(yMin, yMax, 6, [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1], (v) => {
    const p = v * 100;
    const s = Math.abs(p - Math.round(p)) < 1e-9 ? String(Math.round(p)) : p.toFixed(1);
    return s.replace(/\.0$/, "");
  });
  for (const t of yTickVals) yTicks.push({ yFrac: t.frac, label: t.label });

  // Clip ALL data rendering to the plot rect (ticks/labels may extend outside).
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy - yLen, xLen, yLen);
  ctx.clip();

  if (gridOn) drawGrid(ctx, plot, dpr, xTicks, yTicks);

  // Bars (draw in view coords)
  ctx.fillStyle = barColor;
  for (let i = 0; i < bins; i++) {
    const x0 = baseMinS + i * binSizeS;
    const x1 = x0 + binSizeS;
    if (x1 < xMin || x0 > xMax) continue;
    const hFrac = perc[i];
    const yv = (hFrac - yMin) / ySpan;
    const h = Math.max(0, yv) * yLen;
    const sx0 = ox + ((x0 - xMin) / xSpan) * xLen;
    const sw = (binSizeS / xSpan) * xLen;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(sx0 + sw * 0.08, oy - h, sw * 0.84, h);
  }
  ctx.globalAlpha = 1;

  // Gaussian overlay normalized 0..1
  // Draw in the SAME units as the bars: expected probability mass per bin.
  // This makes the curve pass through bar centers when the histogram matches the distribution.
  const mu = (state.stats.meanMs ?? 0) / 1000;
  const sigma = Math.max(1e-9, (state.stats.sigmaMs ?? 0) / 1000);
  if (n >= 2 && Number.isFinite(mu) && Number.isFinite(sigma) && sigma > 0) {
    const inv = 1 / (sigma * Math.sqrt(2 * Math.PI));
    const pdf = (x: number) => inv * Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidthPx * dpr;
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = xMin + (i / 200) * xSpan;
      // Approximate expected mass in a bin of width binSizeS at position x.
      const y = pdf(x) * binSizeS; // fraction (0..1-ish), comparable to bar heights
      const sx = ox + ((x - xMin) / xSpan) * xLen;
      const sy = oy - ((y - yMin) / ySpan) * yLen;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  ctx.restore(); // end clip
  // Draw ticks/labels OUTSIDE the clip so they can extend beyond the plot rect.
  drawTicksAndLabels({ ctx, plot, rectCss: r, dpr, lineWidthPx, xTicks, yTicks });

  const startBtn = el.querySelector<HTMLButtonElement>('button[data-action="timer-startstop"]');
  if (startBtn) {
    const hasRunOnce = _getHasRunOnce(el);
    startBtn.textContent = runPauseResumeLabel(state.accepting, hasRunOnce);
  }
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

      // Auto yMax from histogram (matches drawTimerNode closely).
      const samples = __timerState?.samplesMs ?? [];
      const n = samples.length;
      const binSizeS = Number(nodeEl.dataset.binSizeS ?? "0.5");
      const spanBase = Math.max(1e-9, baseMaxS - baseMinS);
      const bins = Math.max(1, Math.round(spanBase / binSizeS));
      const counts = new Array(bins).fill(0);
      for (const ms of samples) {
        const s = ms / 1000;
        const idx = Math.max(0, Math.min(bins - 1, Math.floor(((s - baseMinS) / spanBase) * bins)));
        counts[idx] += 1;
      }
      const perc = counts.map((c) => (n > 0 ? c / n : 0));
      const maxBar = Math.max(0, ...perc);
      const yMaxAuto = Math.max(1e-9, maxBar * 1.1);

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
        const ys0 = (__soundState as SoundState | null)?.pressure10ms ?? [];
        const nKeep = Math.max(2, Math.min(ys0.length, Math.round(windowS * 100)));
        const ys = ys0.slice(-nKeep);
        const maxYAuto = Math.max(1e-9, Math.max(0, ...ys) * 1.05);

        const key = `sound:${id}:pressure`;
        const pr0 = __plotRanges.get(key);
        return {
          key,
          kind: "sound-pressure" as const,
          bounds: { xMin: 0, xMax: windowS, yMin: 0, yMax: Number.POSITIVE_INFINITY },
          current: pr0 ?? { xMin: 0, xMax: windowS, yMin: 0, yMax: maxYAuto, user: false },
        };
      }
      const f = (__soundState as SoundState | null)?.spectrum?.freqHz ?? [];
      const maxHzAuto = Math.min(8000, Math.max(1, ...f.map((x) => Number(x) || 0)));
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

function attachChoicesHandlers(stage: HTMLElement, engine: Engine) {
  stage.addEventListener("click", async (ev) => {
    // In Edit mode, choices buttons should not be interactive (it interferes with editing).
    if (getAppMode() !== "live") return;
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action || !action.startsWith("choices-")) return;
    const nodeEl = btn.closest<HTMLElement>(".node-choices");
    const pollId = nodeEl?.dataset.nodeId ?? "";
    if (!pollId) return;
    if (action === "choices-startstop") {
      const accepting = !!__choicesState[pollId]?.accepting;
      await fetch(`${BACKEND}/api/choices/${accepting ? "stop" : "start"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Starting should reset to a clean, empty chart.
        body: JSON.stringify(accepting ? { pollId } : { pollId, reset: true }),
      });
      __choicesState[pollId] = await fetchChoicesState(pollId);
      if (!accepting && nodeEl) _setHasRunOnce(nodeEl, true);
      ev.preventDefault();
      return;
    }
    if (action === "choices-reset") {
      await fetch(`${BACKEND}/api/choices/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollId }),
      });
      __choicesState[pollId] = await fetchChoicesState(pollId);
      if (nodeEl) _setHasRunOnce(nodeEl, false);
      ev.preventDefault();
      return;
    }
    if (action === "choices-test") {
      // Debug-only: simulate votes without starting the poll.
      const model = engine.getModel();
      const node = model?.nodes.find((n: any) => n.id === pollId);
      if (!node || !(node as any).debug) return;
      btn.disabled = true;
      try {
        await simulateChoicesVotes(pollId, { users: 30 });
      } finally {
        btn.disabled = false;
      }
      __choicesState[pollId] = await fetchChoicesState(pollId);
      ev.preventDefault();
      return;
    }
  });
}

function ensureChoicesPolling(engine: Engine, model: PresentationModel, stage: HTMLElement) {
  const tick = async () => {
    const cur = engine.getModel();
    if (!cur) return;
    for (const n of cur.nodes as any[]) {
      if (n.type !== "choices") continue;
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      renderChoicesNode(engine, el, n, __choicesState[n.id] ?? null);
    }
  };

  if (!__choicesPollStarted) {
    __choicesPollStarted = true;
    attachChoicesHandlers(stage, engine);
    window.setInterval(() => void tick(), 250);
  }
}

function attachTimerNodeHandlers(stage: HTMLElement) {
  stage.addEventListener("click", async (ev) => {
    // In Edit mode, timer buttons should not be interactive (it interferes with editing).
    if (getAppMode() !== "live") return;
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;
    const timerEl = btn.closest<HTMLElement>(".node-timer") ?? undefined;
    if (action === "timer-startstop") {
      // toggle using last known state
      const accepting = !!__timerState?.accepting;
      await fetch(`${BACKEND}/api/timer/${accepting ? "stop" : "start"}`, { method: "POST" });
      __timerState = await fetchTimerState();
      __timerPollingEnabled = !accepting;
      if (!accepting && timerEl) _setHasRunOnce(timerEl, true);
      ev.preventDefault();
      return;
    }
    if (action === "timer-reset") {
      await fetch(`${BACKEND}/api/timer/reset`, { method: "POST" });
      __timerState = await fetchTimerState();
      if (timerEl) _setHasRunOnce(timerEl, false);
      ev.preventDefault();
      return;
    }
    if (action === "timer-test") {
      if (!timerEl) return;
      btn.disabled = true;
      try {
        __timerPollingEnabled = true;
        await simulateTimerSubmissions(timerEl, { users: 30, durationMs: 5000 });
      } finally {
        btn.disabled = false;
      }
      ev.preventDefault();
      return;
    }
  });
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

function ensureTimerCompositeLayer(engine: Engine, timerId: string) {
  const dbg = ipDebugEnabled("ip_debug_composite");
  const m = engine.getModel();
  const node = m?.nodes.find((n) => n.id === timerId) as any;
  const el = engine.getNodeElement(timerId);
  if (!node || !el) {
    if (dbg) {
      // eslint-disable-next-line no-console
      console.warn("[ip][composite] ensureTimerCompositeLayer: missing node/el", { timerId, hasNode: !!node, hasEl: !!el });
    }
    return null;
  }

  const frame = el.querySelector<HTMLElement>(":scope .timer-frame");
  if (!frame) {
    if (dbg) {
      // eslint-disable-next-line no-console
      console.warn("[ip][composite] ensureTimerCompositeLayer: missing .timer-frame", {
        timerId,
        nodeType: node?.type,
        elClass: el.className,
        childTags: Array.from(el.children).map((c) => (c as any)?.tagName)
      });
    }
    return null;
  }

  let layer = frame.querySelector<HTMLElement>(":scope .timer-sub-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "timer-sub-layer";
    layer.dataset.timerId = timerId;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    frame.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("timer-sub-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);

    // Plot group: a real nested composite level.
    // - root level can move/resize it (it's just another element)
    // - double-click enters `${timerId}/plot` where only plot internals are selectable
    const plotGroup = document.createElement("div");
    plotGroup.className = "timer-sub comp-sub comp-group timer-sub-plotgroup";
    plotGroup.dataset.subId = "plot";
    plotGroup.dataset.compPath = timerId;
    plotGroup.dataset.groupPath = `${timerId}/plot`;
    plotGroup.style.position = "absolute";
    plotGroup.style.pointerEvents = "none";
    plotGroup.style.zIndex = "10";
    plotGroup.style.background = "transparent";
    layer.append(plotGroup);
    (layer as any).__plotGroup = plotGroup;

    // Hit layers for axis arrows (editable in group edit mode) - one per arrow id.
    // These map 1:1 to arrow[...] specs (not special graphics).
    const mkArrowHit = (arrowId: string) => {
      const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer!;
      const h = document.createElement("div");
      h.className = "timer-sub timer-sub-arrow-hit comp-sub";
      h.dataset.subId = arrowId;
      // Axis arrows are authored in the root `groups/<id>/elements.pr` and should be editable
      // immediately when entering composite edit (no need to enter the nested plot level).
      h.dataset.compPath = timerId;
      h.dataset.kind = "plot-arrow";
      h.dataset.arrowId = arrowId;
      h.style.position = "absolute";
      // Sized by renderTimerCompositeArrows() (tight bbox).
      h.style.pointerEvents = "none";
      h.style.zIndex = "20";
      container.append(h);
      return h;
    };
    mkArrowHit("x_axis");
    mkArrowHit("y_axis");

    const geoms: Record<string, any> = (node.compositeGeometriesByPath?.[""] ?? node.compositeGeometries ?? {}) as any;
    // Default plot region = the canonical plot rect used by the renderer.
    geoms["plot"] = geoms["plot"] ?? {
      x: PLOT_FRACS.leftF,
      y: PLOT_FRACS.topF,
      w: PLOT_FRACS.rightF - PLOT_FRACS.leftF,
      h: PLOT_FRACS.bottomF - PLOT_FRACS.topF,
      rotationDeg: 0,
      anchor: "topLeft",
      align: "left",
    };
    const text = String(node.elementsText ?? "");
    if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][composite] timer elementsText", { timerId, chars: text.length, head: text.slice(0, 180) });
    }
    const lines = text.split(/\r?\n/);
    const arrowSpecs: Array<{
      id: string;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      color: string;
      width: number;
    }> = [];
    for (const ln0 of lines) {
      const ln = ln0.trim();
      if (!ln || ln.startsWith("#")) continue;

      // text[name=id]: content
      const mt = ln.match(/^text\[name=(?<id>[a-zA-Z_]\w*)\]\s*:\s*(?<content>.*)$/);
      if (mt?.groups) {
        const sid = mt.groups.id;
        const content = mt.groups.content ?? "";
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.4, h: 0.1, rotationDeg: 0, anchor: "centerCenter", align: "center" };
        const d = document.createElement("div");
        d.className = "timer-sub timer-sub-text comp-sub";
        d.dataset.subId = sid;
        d.dataset.compPath = timerId;
        d.dataset.template = content;
        // Keep a stable content child so KaTeX updates don't wipe selection handles.
        const contentEl = document.createElement("div");
        contentEl.className = "timer-sub-content";
        contentEl.style.width = "100%";
        contentEl.style.height = "100%";
        contentEl.style.display = "grid";
        contentEl.style.placeItems = "center";
        d.append(contentEl);
        d.style.position = "absolute";
        d.style.left = `${(g.x ?? 0.5) * 100}%`;
        d.style.top = `${(g.y ?? 0.5) * 100}%`;
        d.style.width = `${(g.w ?? 0.4) * 100}%`;
        d.style.height = `${(g.h ?? 0.1) * 100}%`;
        d.style.transform = "translate(-50%, -50%)";
        // Default should be clean (no per-element "pill" overlay).
        // In composite edit mode we can temporarily add outlines via JS if desired.
        d.style.padding = "0";
        d.style.borderRadius = "0";
        d.style.border = "none";
        d.style.background = "transparent";
        d.style.color = "rgba(255,255,255,0.92)";
        d.style.userSelect = "none";
        d.style.pointerEvents = "none";
        d.style.zIndex = "30";
        d.style.whiteSpace = "nowrap";
        // Match global text nodes (KaTeX roman)
        d.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
        d.style.fontWeight = "400";
        d.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
        const rot = Number(g.rotationDeg ?? 0);
        if (rot) d.style.rotate = `${rot}deg`;
        layer.append(d);
        continue;
      }

      // buttons[name=...,orientation=h|v,labels=[...]]
      const mb = ln.match(/^buttons\[(?<params>[^\]]+)\]$/);
      if (mb?.groups?.params) {
        const params = _parseInlineParams(mb.groups.params);
        const sid = String(params.name ?? "").trim();
        if (!sid) continue;
        const orient = (String(params.orientation ?? "h").trim().toLowerCase() === "v" ? "v" : "h") as "h" | "v";
        const labels = _parseList(params.labels);
        const actions = _parseList(params.actions);
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.55, h: 0.10, rotationDeg: 0, anchor: "centerCenter", align: "center" };

        const boxEl = document.createElement("div");
        // Buttons are special chrome by default: not editable in group edit.
        // Movable chrome: editable as a unit in group edit mode.
        boxEl.className = "timer-sub timer-sub-buttons comp-chrome comp-sub";
        boxEl.dataset.subId = sid;
        boxEl.dataset.compPath = timerId;
        boxEl.dataset.orientation = orient;
        boxEl.dataset.templates = JSON.stringify(labels);
        boxEl.dataset.actions = JSON.stringify(actions);

        boxEl.style.position = "absolute";
        boxEl.style.left = `${(g.x ?? 0.5) * 100}%`;
        boxEl.style.top = `${(g.y ?? 0.5) * 100}%`;
        boxEl.style.width = `${(g.w ?? 0.55) * 100}%`;
        boxEl.style.height = `${(g.h ?? 0.10) * 100}%`;
        boxEl.style.transform = "translate(-50%, -50%)";
        boxEl.style.padding = "0";
        boxEl.style.border = "none";
        boxEl.style.background = "transparent";
        boxEl.style.pointerEvents = "auto"; // clickable in live
        boxEl.style.zIndex = "40";
        boxEl.style.userSelect = "none";

        const row = document.createElement("div");
        row.className = "ip-buttons-row";
        row.style.display = "flex";
        row.style.flexDirection = orient === "v" ? "column" : "row";
        row.style.gap = "10px";
        row.style.alignItems = "center";
        row.style.justifyContent = "center";
        row.style.width = "100%";
        row.style.height = "100%";

        labels.forEach((tpl, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ip-controlbtn";
          btn.dataset.idx = String(idx + 1);
          btn.dataset.template = String(tpl ?? "");
          const contentEl = document.createElement("div");
          contentEl.className = "ip-button-content";
          btn.appendChild(contentEl);
          btn.addEventListener("click", async (ev) => {
            // Disable interaction while group editing.
            if (getAppMode() !== "live" || (window as any).__ip_compositeEditing) {
              return;
            }
            const evName = `${sid}-${idx + 1}`;
            window.dispatchEvent(new CustomEvent(evName, { detail: { id: sid, index: idx + 1, compPath: timerId } }));

            // Optional built-in action dispatch (reuses existing behavior).
            const action = actions[idx] ?? "";
            if (action === "timer-startstop") {
              const timerEl = engine.getNodeElement(timerId);
              const accepting = !!__timerState?.accepting;
              await fetch(`${BACKEND}/api/timer/${accepting ? "stop" : "start"}`, { method: "POST" });
              __timerState = await fetchTimerState();
              __timerPollingEnabled = !accepting;
              if (!accepting && timerEl) _setHasRunOnce(timerEl, true);
            } else if (action === "timer-reset") {
              const timerEl = engine.getNodeElement(timerId);
              await fetch(`${BACKEND}/api/timer/reset`, { method: "POST" });
              __timerState = await fetchTimerState();
              if (timerEl) _setHasRunOnce(timerEl, false);
            } else if (action === "timer-test") {
              const timerEl = engine.getNodeElement(timerId);
              if (timerEl) {
                btn.disabled = true;
                try {
                  __timerPollingEnabled = true;
                  await simulateTimerSubmissions(timerEl, { users: 30, durationMs: 5000 });
                } finally {
                  btn.disabled = false;
                }
              }
            }
          });
          row.appendChild(btn);
        });
        boxEl.appendChild(row);
        layer.appendChild(boxEl);
        continue;
      }

      // arrow[name=id,from=(x,y),to=(x,y),color=...,width=...]
      // Be whitespace-tolerant: elements.pr is user-authored and may contain spaces after commas.
      const ma = ln.match(
        /^arrow\[\s*name=(?<id>[a-zA-Z_]\w*)\s*,\s*from=\(\s*(?<x0>-?(?:\d+\.?\d*|\.\d+))\s*,\s*(?<y0>-?(?:\d+\.?\d*|\.\d+))\s*\)\s*,\s*to=\(\s*(?<x1>-?(?:\d+\.?\d*|\.\d+))\s*,\s*(?<y1>-?(?:\d+\.?\d*|\.\d+))\s*\)(?:\s*,\s*color=(?<color>[^,\]]+))?(?:\s*,\s*width=(?<width>-?(?:\d+\.?\d*|\.\d+)))?\s*\]\s*$/
      );
      if (ma?.groups) {
        const sid = ma.groups.id;
        arrowSpecs.push({
          id: sid,
          x0: Number(ma.groups.x0),
          y0: Number(ma.groups.y0),
          x1: Number(ma.groups.x1),
          y1: Number(ma.groups.y1),
          color: (ma.groups.color ?? "white").trim(),
          width: ma.groups.width == null ? 0.006 : Number(ma.groups.width)
        });
        continue;
      }
    }
    (layer as any).__arrowSpecs = arrowSpecs;
    (layer as any).__textGeoms = geoms;
    // This is .pr content (single-line "text[name=...]: ..." etc).
    (layer as any).__elementsPr = text;
  }

  // Ensure plot group exists for older layers.
  let plotGroup = (layer as any).__plotGroup as HTMLElement | null;
  if (!plotGroup) {
    plotGroup = layer.querySelector<HTMLElement>(":scope > .timer-sub-plotgroup");
    if (!plotGroup) {
      plotGroup = document.createElement("div");
      plotGroup.className = "timer-sub comp-sub comp-group timer-sub-plotgroup";
      plotGroup.dataset.subId = "plot";
      plotGroup.dataset.compPath = timerId;
      plotGroup.dataset.groupPath = `${timerId}/plot`;
      plotGroup.style.position = "absolute";
      plotGroup.style.pointerEvents = "none";
      plotGroup.style.zIndex = "10";
      plotGroup.style.background = "transparent";
      layer.append(plotGroup);
    }
    (layer as any).__plotGroup = plotGroup;
  }

  // Ensure per-axis hit layers exist even if the layer was created before we added them.
  const ensureHit = (arrowId: string) => {
    const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer;
    if (container.querySelector<HTMLElement>(`:scope > .timer-sub-arrow-hit[data-arrow-id="${arrowId}"]`)) return;
    const h = document.createElement("div");
    h.className = "timer-sub timer-sub-arrow-hit comp-sub";
    h.dataset.subId = arrowId;
    // See mkArrowHit(): axis arrows should be editable at the root composite level.
    h.dataset.compPath = timerId;
    h.dataset.kind = "plot-arrow";
    h.dataset.arrowId = arrowId;
    h.style.position = "absolute";
    // Sized by renderTimerCompositeArrows() (tight bbox).
    h.style.pointerEvents = "none";
    h.style.zIndex = "20";
    container.append(h);
  };
  ensureHit("x_axis");
  ensureHit("y_axis");

  // Sync plot region geom -> DOM box + dataset fracs so canvas/ticks follow it.
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? (node.compositeGeometries ?? {});
  const pg = (geoms["plot"] ??= {
    x: PLOT_FRACS.leftF,
    y: PLOT_FRACS.topF,
    w: PLOT_FRACS.rightF - PLOT_FRACS.leftF,
    h: PLOT_FRACS.bottomF - PLOT_FRACS.topF,
    rotationDeg: 0,
    anchor: "topLeft",
    align: "left",
  });
  const ptl = anchorToTopLeftWorld({ x: Number(pg.x), y: Number(pg.y), w: Number(pg.w), h: Number(pg.h), anchor: String(pg.anchor ?? "topLeft") } as any);
  const leftF = ptl.x;
  const topF = ptl.y;
  const rightF = leftF + Number(pg.w);
  const bottomF = topF + Number(pg.h);
  el.dataset.plotLeftF = String(leftF);
  el.dataset.plotRightF = String(rightF);
  el.dataset.plotTopF = String(topF);
  el.dataset.plotBottomF = String(bottomF);
  if (plotGroup) {
    plotGroup.style.left = `${leftF * 100}%`;
    plotGroup.style.top = `${topF * 100}%`;
    plotGroup.style.width = `${Number(pg.w) * 100}%`;
    plotGroup.style.height = `${Number(pg.h) * 100}%`;
    // Anchor is always topLeft for the plot reference box (simplifies nested coords).
    plotGroup.dataset.anchor = "topLeft";
    plotGroup.style.transform = "translate(0%, 0%)";
  }

  return layer;
}

function renderTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = getAppMode();
  // Prefer engine-provided pixel size to avoid reflow jitter; fall back to DOM rect.
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox =
    hPx > 0 && wPx > 0
      ? { width: wPx, height: hPx }
      : timerEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    // Size + position (allow outside 0..1)
    const x = Number(g.x ?? 0.5);
    const y = Number(g.y ?? 0.5);
    const w = Number(g.w ?? 0.4);
    const h = Number(g.h ?? 0.1);
    const anchor = String(g.anchor ?? t.dataset.anchor ?? "centerCenter");
    t.dataset.anchor = anchor;
    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    t.style.rotate = `${Number(g.rotationDeg ?? 0)}deg`;
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";

    // Font size scales with the element height on screen (use fractional rect height to avoid jitter).
    // Allow scaling all the way down to 1px (requested).
    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;

    const tpl = t.dataset.template ?? "";
    const resolved = applyDataBindings(tpl, data);
    const prev = t.dataset.rawText ?? "";
    if (prev !== resolved) {
      t.dataset.rawText = resolved;
      // Render KaTeX inline/display same as normal text nodes.
      const contentEl = t.querySelector<HTMLElement>(":scope .timer-sub-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    // Composite texts should only be interactive in group edit mode (Edit mode).
    // In Live mode they are display-only; in normal Edit mode they should not steal clicks from selecting the timer node.
    const interactive = appMode === "edit" && isGroupEditing;
    t.style.pointerEvents = interactive ? "auto" : "none";
    t.style.cursor = interactive ? "grab" : "default";

    // DEBUG (low-noise, but always-on when the bug happens):
    // If we are in timer composite edit, texts must never become non-interactive.
    // Log the first time we observe a violation for this timer element.
    if (!interactive && (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "")) {
      const key = `${compositeId}|${appMode}|${String(timerEl.dataset.compositeEditing ?? "")}`;
      const prev = (timerEl as any).__ip_dbg_bad_text_pe_key;
      if (prev !== key) {
        (timerEl as any).__ip_dbg_bad_text_pe_key = key;
        // eslint-disable-next-line no-console
        console.warn("[ip][bug] timer text became non-interactive during composite edit", {
          timerId: compositeId,
          appMode,
          winCompositeEditing: !!(window as any).__ip_compositeEditing,
          winCompositeKind: compositeKind,
          winCompositeId: compositeId,
          elCompositeEditing: timerEl.dataset.compositeEditing,
          textSubId: t.dataset.subId,
          computedPE: window.getComputedStyle(t).pointerEvents,
          inlinePE: t.style.pointerEvents,
          compositeEditPath: (window as any).__ip_dbg_compositeEditPath,
        });
      }
    }
  }
}

function renderTimerCompositeButtons(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-buttons"));
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox =
    hPx > 0 && wPx > 0
      ? { width: wPx, height: hPx }
      : timerEl.getBoundingClientRect();
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = getAppMode();
  for (const boxEl of els) {
    const sid = boxEl.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.10);
    const fontPx = Math.max(12, timerBox.height * h * 0.55);
    const scale = Math.max(0.6, Math.min(3, fontPx / 16));
    boxEl.style.setProperty("--control-scale", String(scale));
    // Interaction rules:
    // - Live: the real buttons must be clickable
    // - Edit (not group edit): do NOT steal clicks from selecting the timer node
    // - Edit + group edit: allow selecting/moving the button group as a composite sub-element
    const canSelectGroup = appMode === "edit" && isGroupEditing;
    boxEl.style.opacity = canSelectGroup ? "1" : "1";
    boxEl.style.pointerEvents = appMode === "live" ? "auto" : canSelectGroup ? "auto" : "none";

    for (const btn of Array.from(boxEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const tpl = btn.dataset.template ?? "";
      const resolved = applyDataBindings(tpl, data);
      const prev = btn.dataset.rawText ?? "";
      if (prev !== resolved) {
        btn.dataset.rawText = resolved;
        const contentEl = btn.querySelector<HTMLElement>(":scope > .ip-button-content");
        if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
      }
    }
    // Hide the legacy headerbar when composite buttons are present (avoid duplicates).
    timerEl.querySelector<HTMLElement>(".timer-header")?.setAttribute("style", "display:none !important");
  }
}

function layoutTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement) {
  // Layout-only: keep composite text scaling smooth during pan/zoom without re-rendering content.
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox =
    hPx > 0 && wPx > 0
      ? { width: wPx, height: hPx }
      : timerEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.1);
    // Keep font sizing in sync with on-screen timer rect continuously (fractional px, no rounding).
    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
  }
}

function renderTimerCompositeArrows(timerEl: HTMLElement, layer: HTMLElement) {
  const svg = layer.querySelector<SVGSVGElement>(":scope > .timer-sub-svg");
  if (!svg) return;
  const specs: any[] = (layer as any).__arrowSpecs ?? [];
  if (!Array.isArray(specs) || specs.length === 0) {
    svg.replaceChildren();
    return;
  }

  // Prefer cached timer size from engine; if unavailable or absurd, skip this frame.
  const cachedW = Number(timerEl.dataset.timerWpx ?? "0");
  const cachedH = Number(timerEl.dataset.timerHpx ?? "0");
  if (!(cachedW > 1 && cachedH > 1)) return;

  const doc = timerEl.ownerDocument?.documentElement;
  const scrW = Math.max(1, doc?.clientWidth ?? window.innerWidth ?? cachedW);
  const scrH = Math.max(1, doc?.clientHeight ?? window.innerHeight ?? cachedH);

  // If reported size is larger than the viewport by a lot, wait for a sane frame.
  if (cachedW > scrW * 1.2 || cachedH > scrH * 1.2) return;

  let w = Math.max(1, cachedW);
  let h = Math.max(1, cachedH);

  const prevW = Number(layer.dataset.stableW || "0");
  const prevH = Number(layer.dataset.stableH || "0");

  if (prevW > 0 && prevH > 0) {
    const jump = Math.max(w / prevW, prevW / w, h / prevH, prevH / h);
    if (!Number.isFinite(jump) || jump > 1.2) {
      w = prevW;
      h = prevH;
    }
  }

  const MAX_DIM = 4096;
  if (w > MAX_DIM || h > MAX_DIM) {
    const scale = MAX_DIM / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  layer.dataset.stableW = String(w);
  layer.dataset.stableH = String(h);

  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const timerId = layer.dataset.timerId ?? "timer";
  const selectedArrowId = String((layer as any).dataset?.selectedPlotArrowId ?? "");

  // Map arrow coordinates in "data-rect space":
  // u in [0..1] across x, v in [0..1] up y. Allow >1 to extend beyond the rect.
  // This matches the plot area used by drawTimerNode().
  const fr = _plotFracsForEl(timerEl);
  const ox = fr.leftF * w;
  const oy = fr.bottomF * h;
  const xLen = (fr.rightF - fr.leftF) * w;
  const yLen = (fr.bottomF - fr.topF) * h;
  const mapX = (u: number) => ox + u * xLen;
  const mapY = (vUp: number) => oy - vUp * yLen;

  const dataMin = Math.max(1, Math.min(xLen, yLen));

  for (const a of specs) {
    const relW = typeof a.width === "number" && isFinite(a.width) ? a.width : 0.006;
    // Scale with data rect to keep proportions; clamp to avoid extremes.
    const lwPx = Math.max(0.5, Math.min(16, relW * dataMin));
    const headWPx = 3 * lwPx;
    const headLPx = 5 * lwPx;

    const x1 = mapX(Number(a.x0 ?? 0));
    const y1 = mapY(Number(a.y0 ?? 0));
    const x2 = mapX(Number(a.x1 ?? 1));
    const y2 = mapY(Number(a.y1 ?? 1));

    // Keep a per-arrow hitbox in sync with the rendered arrow (smallest bbox wins in selection).
    const plotGroup = (layer as any).__plotGroup as HTMLElement | null;
    const hit = (plotGroup ?? layer).querySelector<HTMLElement>(
      `:scope > .timer-sub-arrow-hit[data-arrow-id="${String(a.id ?? "")}"]`
    );
    if (hit) {
      const padPx = 24;
      const minX = Math.min(x1, x2) - padPx;
      const maxX = Math.max(x1, x2) + padPx;
      const minY = Math.min(y1, y2) - padPx;
      const maxY = Math.max(y1, y2) + padPx;
      // Hitboxes live inside the plotGroup (nested level), so position them relative to plot rect.
      hit.style.left = `${((minX - ox) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.top = `${((minY - (oy - yLen)) / Math.max(1e-9, yLen)) * 100}%`;
      hit.style.width = `${((maxX - minX) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.height = `${((maxY - minY) / Math.max(1e-9, yLen)) * 100}%`;
    }

    const markerId = `arrowhead-${timerId}-${a.id}`;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("markerWidth", String(headLPx));
    marker.setAttribute("markerHeight", String(headWPx));
    // Attach the base of the arrowhead at the line end, so the arrowhead extends the line.
    marker.setAttribute("refX", "0");
    marker.setAttribute("refY", String(headWPx / 2));
    marker.setAttribute("orient", "auto");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // Base at x=0, tip at x=headLPx (extends beyond line end).
    path.setAttribute("d", `M0,0 L${headLPx},${headWPx / 2} L0,${headWPx} Z`);
    path.setAttribute("fill", a.color ?? "white");
    marker.append(path);
    defs.append(marker);

    const isSelected = selectedArrowId && String(a.id ?? "") === selectedArrowId;
    if (isSelected) {
      // Root-mode parity: draw a thick blue stroke behind the arrow (glow), like the canvas arrows.
      const glow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      glow.setAttribute("x1", String(x1));
      glow.setAttribute("y1", String(y1));
      glow.setAttribute("x2", String(x2));
      glow.setAttribute("y2", String(y2));
      glow.setAttribute("stroke", "rgba(110,168,255,0.95)");
      glow.setAttribute("stroke-width", String(Math.min(48, lwPx + 10)));
      glow.setAttribute("stroke-linecap", "round");
      g.append(glow);
    }

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", a.color ?? "white");
    line.setAttribute("stroke-width", String(lwPx));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", `url(#${markerId})`);
    g.append(line);
  }

  svg.replaceChildren(defs, g);
}

function ensureTimerPolling(engine: Engine, model: PresentationModel, stage: HTMLElement) {
  if (__timerPollStarted) return;
  __timerPollStarted = true;
  attachTimerNodeHandlers(stage);

  // Keep timer composite text sizing smooth while panning/zooming.
  // Polling updates content; this RAF loop updates only layout (font sizing) every frame.
  let __timerCompositeRafStarted = false;
  const startCompositeLayoutRaf = () => {
    if (__timerCompositeRafStarted) return;
    __timerCompositeRafStarted = true;
    const rafTick = () => {
      const cur = engine.getModel();
      if (cur) {
        for (const n of cur.nodes) {
          if (n.type !== "timer") continue;
          const el = engine.getNodeElement(n.id);
          if (!el) continue;
          const layer = ensureTimerCompositeLayer(engine, n.id);
          if (layer) {
            // Always draw axes/arrows + labels initially (even before timer is started).
            renderTimerCompositeArrows(el, layer);
            layoutTimerCompositeTexts(el, layer);
            const st = __timerState;
            const fmtS = (ms: any) => {
              const v = typeof ms === "number" ? ms : Number(ms);
              if (!Number.isFinite(v)) return "-";
              return (v / 1000).toFixed(2);
            };
            const countN = st && Number.isFinite(st.stats.n) ? Number(st.stats.n) : 0;
            const hasRunOnce = _getHasRunOnce(el);
            const accepting = !!st?.accepting;
            const data: Record<string, string | number> = {
              name: n.id,
              mean: countN > 0 && st ? fmtS(st.stats.meanMs) : "-",
              sigma: countN > 1 && st ? fmtS(st.stats.sigmaMs) : "-",
              count: countN > 0 ? String(countN) : "-",
              runPauseResume: runPauseResumeLabel(accepting, hasRunOnce),
            };
            renderTimerCompositeTexts(el, layer, data);
            renderTimerCompositeButtons(el, layer, data);
          }
        }
      }
      window.requestAnimationFrame(rafTick);
    };
    window.requestAnimationFrame(rafTick);
  };
  startCompositeLayoutRaf();

  // Keep canvas-based ticks/buttons in sync every frame using cached timer size.
  let __timerDrawRafStarted = false;
  const startTimerDrawRaf = () => {
    if (__timerDrawRafStarted) return;
    __timerDrawRafStarted = true;
    const rafDraw = () => {
      // Always draw: ticks/labels should be visible even before the timer is started
      // (and even when the backend is offline / not yet polled).
      const st: TimerState = __timerState ?? {
        accepting: false,
        samplesMs: [],
        stats: { n: 0, meanMs: null, sigmaMs: null },
      };
      const cur = engine.getModel();
      if (cur) {
        for (const n of cur.nodes) {
          if (n.type !== "timer") continue;
          const el = engine.getNodeElement(n.id);
          if (el) drawTimerNode(el, st);
        }
      }
      window.requestAnimationFrame(rafDraw);
    };
    window.requestAnimationFrame(rafDraw);
  };
  startTimerDrawRaf();

  const tick = async () => {
    // Only poll when presentation is started AND the interactive timer is actually running.
    if (!presentationStarted) return;
    if (!__timerPollingEnabled) return;
    const st = await fetchTimerState();
    if (st) __timerState = st;
    const cur = engine.getModel();
    if (!cur || !__timerState) return;
    const fmtS = (ms: any) => {
      const v = typeof ms === "number" ? ms : Number(ms);
      if (!Number.isFinite(v)) return "-";
      return (v / 1000).toFixed(2);
    };
    for (const n of cur.nodes) {
      if (n.type !== "timer") continue;
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      drawTimerNode(el, __timerState);
      const layer = ensureTimerCompositeLayer(engine, n.id);
      if (layer) renderTimerCompositeArrows(el, layer);
      if (layer) {
        const countN = Number.isFinite(__timerState.stats.n) ? Number(__timerState.stats.n) : 0;
        const data: Record<string, string | number> = {
          // Generic (per-composite) bindings: avoid timer.meanS; keep it as {{mean}}, {{sigma}}, {{n}}.
          name: n.id,
          mean: countN > 0 ? fmtS(__timerState.stats.meanMs) : "-",
          sigma: countN > 1 ? fmtS(__timerState.stats.sigmaMs) : "-",
          count: countN > 0 ? String(countN) : "-"
        };
        renderTimerCompositeTexts(el, layer, data);
        renderTimerCompositeButtons(el, layer, data);
      }
    }
  };

  // Kick immediately, then poll.
  window.setInterval(() => void tick(), 350);
}

function ensureSoundStreaming(engine: Engine, model: PresentationModel, stage: HTMLElement) {
  if (__soundStreamStarted) return;
  __soundStreamStarted = true;
  attachSoundNodeHandlers(stage);

  const setSoundUnavailable = (reason: string) => {
    const prev = (__soundState as SoundState | null) ?? null;
    const base = ensureSoundStateDefaults(prev);
    // Don't overwrite a real running state; only set helpful diagnostics.
    if (base.enabled) return;
    (__soundState as any) = { ...base, enabled: false, error: reason };
  };

  // Draw loop
  let rafStarted = false;
  const startDrawRaf = () => {
    if (rafStarted) return;
    rafStarted = true;
    const raf = () => {
      const st = __soundState as SoundState | null;
      if (st) {
        const cur = engine.getModel();
        if (cur) {
          for (const n of cur.nodes) {
            if ((n as any).type !== "sound") continue;
            const el = engine.getNodeElement((n as any).id);
            if (el) {
              // Update run/pause label based on global capture state
              const toggleBtn = el.querySelector<HTMLButtonElement>('button[data-action="sound-toggle"]');
              if (toggleBtn) {
                if (st?.enabled) toggleBtn.textContent = "Pause";
                else toggleBtn.textContent = (st?.seq ?? 0) > 0 ? "Resume" : "Run";
              }
              const resetBtn = el.querySelector<HTMLButtonElement>('button[data-action="sound-reset"]');
              if (resetBtn) resetBtn.disabled = !st?.enabled && !(st?.seq > 0);
              const modeBtn = el.querySelector<HTMLButtonElement>('button[data-action="sound-mode-toggle"]');
              if (modeBtn) {
                const cur = (el.dataset.mode ?? "spectrum").toLowerCase();
                modeBtn.textContent = cur === "pressure" ? "As Spectrum" : "As Time Series";
              }
              // Mode is a local UI toggle; default from node.dataset.mode if present.
              drawSoundNode(el, st);
              const layer = ensureSoundCompositeLayer(engine, (n as any).id);
              if (layer) {
                renderSoundCompositeArrows(el, layer);
                layoutSoundCompositeTexts(el, layer);
                const modeNow = (el.dataset.mode ?? "spectrum").toLowerCase();
                // Peak frequency (spectrum only)
                let peakHz: string | number = "-";
                if (modeNow === "spectrum") {
                  const f = st.spectrum?.freqHz ?? [];
                  const m = st.spectrum?.magDb ?? [];
                  let bestI = -1;
                  let best = -1e9;
                  for (let i = 1; i < Math.min(f.length, m.length); i++) {
                    const hz = Number(f[i]);
                    const db = Number(m[i]);
                    if (!Number.isFinite(hz) || !Number.isFinite(db)) continue;
                    if (hz < 20) continue;
                    if (db > best) {
                      best = db;
                      bestI = i;
                    }
                  }
                  if (bestI >= 0) peakHz = Math.round(Number(f[bestI]));
                }
                const data: Record<string, string> =
                  modeNow === "pressure"
                    ? { xLabel: "Time (s)", yLabel: "Pressure (RMS)", peakHz: "-" }
                    : { xLabel: "Frequency (Hz)", yLabel: "Magnitude (dB)", peakHz: String(peakHz) };
                const hasRunOnce = _getHasRunOnce(el) || (st?.seq ?? 0) > 0;
                (data as any).runPauseResume = runPauseResumeLabel(!!st?.enabled, hasRunOnce);
                const nextMode = modeNow === "pressure" ? "spectrum" : "pressure";
                (data as any).modeToggle = nextMode === "pressure" ? "As Time Series" : "As Spectrum";
                renderSoundCompositeTexts(el, layer, data);
                renderSoundCompositeButtons(el, layer, data);
              }
            }
          }
        }
      }
      window.requestAnimationFrame(raf);
    };
    window.requestAnimationFrame(raf);
  };
  startDrawRaf();

  // SSE stream (only meaningful in Live mode, but harmless in Edit)
  try {
    const es = new EventSource(`${BACKEND}/api/sound/stream`);
    es.onmessage = (ev) => {
      try {
        __soundState = JSON.parse(ev.data) as SoundState;
      } catch {
        // ignore
      }
    };
    es.onerror = async () => {
      // fallback: poll slowly if SSE fails
      const st = await fetchSoundState();
      if (st) __soundState = st;
      else {
        setSoundUnavailable(
          `Sound is not available (backend unreachable).\n` +
            `If you are running from GitHub Pages, the backend APIs do not exist.\n` +
            `Run the backend locally and point BACKEND to it.\n` +
            `BACKEND=${BACKEND}`
        );
      }
    };
  } catch {
    // fallback to polling
    window.setInterval(async () => {
      const st = await fetchSoundState();
      if (st) __soundState = st;
      else {
        setSoundUnavailable(
          `Sound is not available (backend unreachable).\n` +
            `If you are running from GitHub Pages, the backend APIs do not exist.\n` +
            `Run the backend locally and point BACKEND to it.\n` +
            `BACKEND=${BACKEND}`
        );
      }
    }, 200);
  }

  // Proactive diagnostic: if we never receive any sound state shortly after boot,
  // show a user-friendly message instead of a blank plot.
  window.setTimeout(() => {
    if (!__soundState) {
      setSoundUnavailable(
        `Sound is not available (no backend response).\n` +
          `If you are running from GitHub Pages, the backend APIs do not exist.\n` +
          `Run the backend locally and point BACKEND to it.\n` +
          `BACKEND=${BACKEND}`
      );
    }
  }, 1500);
}

let __graphRafStarted = false;
function ensureGraphRendering(engine: Engine) {
  if (__graphRafStarted) return;
  __graphRafStarted = true;

  const ensureGraphFrame = (nodeEl: HTMLElement) => {
    let frame = nodeEl.querySelector<HTMLElement>(":scope > .ip-graph-frame");
    if (!frame) {
      frame = document.createElement("div");
      frame.className = "ip-graph-frame";
      frame.style.position = "absolute";
      frame.style.inset = "0";
      frame.style.border = "1px solid rgba(255,255,255,0.14)";
      frame.style.borderRadius = "14px";
      frame.style.background = "rgba(15,17,24,0.55)";
      frame.style.boxShadow = "0 14px 40px rgba(0,0,0,0.35)";
      frame.style.overflow = "hidden";
      frame.style.pointerEvents = "none";
      nodeEl.appendChild(frame);
      // If the engine default node doesn't set positioning context, make sure it does.
      if (!nodeEl.style.position) nodeEl.style.position = "absolute";
    }
    return frame;
  };

  const ensureGraphCanvas = (nodeEl: HTMLElement) => {
    const frame = ensureGraphFrame(nodeEl);
    let c = frame.querySelector<HTMLCanvasElement>("canvas.ip-graph-canvas");
    if (!c) {
      c = document.createElement("canvas");
      c.className = "ip-graph-canvas";
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.pointerEvents = "none";
      frame.appendChild(c);
    }
    return c;
  };

  const drawAxisLabel = (ctx: CanvasRenderingContext2D, rectCss: DOMRect, dpr: number, x: number, y: number, text: string, rotRad = 0) => {
    const fontCssPx = Math.max(12, Math.min(64, rectCss.height * 0.032));
    const fontPx = Math.round(fontCssPx * dpr);
    ctx.save();
    ctx.font = `${fontPx}px KaTeX_Main, Times New Roman, serif`;
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.translate(x, y);
    if (rotRad) ctx.rotate(rotRad);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };

  const drawGraphNode = (nodeEl: HTMLElement, n: any, model: any) => {
    const canvas = ensureGraphCanvas(nodeEl);
    const prep = prepareCanvas(nodeEl, canvas, PLOT_FRACS);
    if (!prep) return;
    const { ctx, rect: rectCss, dpr, plot } = prep;
    const { ox, oy, xLen, yLen } = plot;

    const drawAxisArrows = () => {
      // Timer-like axis arrows (inside the plot rect).
      const col = "rgba(255,255,255,0.75)";
      const lw = Math.max(1, 2 * dpr);
      const headL = Math.max(10 * dpr, 14 * dpr);
      const headW = Math.max(7 * dpr, 10 * dpr);
      const extend = 0.02; // extend beyond plot a bit

      const drawArrow = (x0: number, y0: number, x1: number, y1: number) => {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.max(1e-6, Math.hypot(dx, dy));
        const ux = dx / len;
        const uy = dy / len;
        // Base of arrow head
        const bx = x1 - ux * headL;
        const by = y1 - uy * headL;
        // Perpendicular
        const px = -uy;
        const py = ux;

        ctx.save();
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = lw;
        ctx.lineCap = "round";
        // Shaft
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(bx, by);
        ctx.stroke();
        // Head
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(bx + px * (headW / 2), by + py * (headW / 2));
        ctx.lineTo(bx - px * (headW / 2), by - py * (headW / 2));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };

      // x-axis: left->right along bottom of plot
      drawArrow(ox, oy, ox + xLen * (1 + extend), oy);
      // y-axis: bottom->top along left of plot
      drawArrow(ox, oy, ox, oy - yLen * (1 + extend));
    };

    // Resolve sources.
    // Source syntax: "<tableId>[<colIdx>]" (0-based).
    const parseSource = (raw: any): { tableId: string; col: number } | null => {
      const s = String(raw ?? "").trim();
      if (!s) return null;
      const m = s.match(/^([a-zA-Z_]\w*)\[(\d+)\]$/);
      if (!m) return null;
      return { tableId: m[1], col: Number(m[2]) };
    };
    const xs = parseSource((n as any).xSource);
    const ys = parseSource((n as any).ySource);

    const pts: Array<{ x: number; y: number }> = [];
    if (xs && ys && xs.tableId === ys.tableId) {
      const tableNode: any = (model?.nodes ?? []).find((nn: any) => String(nn?.id) === xs.tableId);
      const rows: any[][] = Array.isArray(tableNode?.rows) ? tableNode.rows : [];
      for (let r = 0; r < rows.length; r++) {
        const rr = rows[r] ?? [];
        const x0 = Number(String(rr?.[xs.col] ?? "").trim());
        const y0 = Number(String(rr?.[ys.col] ?? "").trim());
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue; // skips header automatically
        pts.push({ x: x0, y: y0 });
      }
    }

    // Bounds (auto)
    let xMin = 0, xMax = 1, yMin = 0, yMax = 1;
    if (pts.length) {
      xMin = Math.min(...pts.map((p) => p.x));
      xMax = Math.max(...pts.map((p) => p.x));
      yMin = Math.min(...pts.map((p) => p.y));
      yMax = Math.max(...pts.map((p) => p.y));
      const xSpan = Math.max(1e-9, xMax - xMin);
      const ySpan = Math.max(1e-9, yMax - yMin);
      xMin -= xSpan * 0.08;
      xMax += xSpan * 0.08;
      yMin -= ySpan * 0.08;
      yMax += ySpan * 0.08;
    }
    const xSpan = Math.max(1e-9, xMax - xMin);
    const ySpan = Math.max(1e-9, yMax - yMin);

    const fmt = (v: number) => {
      const av = Math.abs(v);
      if (av >= 1000) return String(Math.round(v));
      if (av >= 10) return v.toFixed(1);
      return v.toFixed(2);
    };
    const xTickVals = niceTicks(xMin, xMax, 6, [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], fmt);
    const yTickVals = niceTicks(yMin, yMax, 6, [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], fmt);
    const xTicks: Array<{ xFrac: number; label: string }> = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
    const yTicks: Array<{ yFrac: number; label: string }> = yTickVals.map((t) => ({ yFrac: t.frac, label: t.label }));
    if (String(n.grid ?? "on").toLowerCase() !== "off") drawGrid(ctx, plot, dpr, xTicks, yTicks);

    // Clip points to plot rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy - yLen, xLen, yLen);
    ctx.clip();
    const col = String(n.color ?? "white") || "white";
    const dotR = Math.max(2 * dpr, 3.5 * dpr);
    ctx.fillStyle = col;
    for (const p of pts) {
      const xf = (p.x - xMin) / xSpan;
      const yf = (p.y - yMin) / ySpan;
      const x = ox + xf * xLen;
      const y = oy - yf * yLen;
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Axes (timer-like arrows) on top of the plot.
    drawAxisArrows();

    drawTicksAndLabels({ ctx, plot, rectCss, dpr, lineWidthPx: 2, xTicks, yTicks });

    // Axis labels
    const xLabel = String(n.xLabel ?? "x");
    const yLabel = String(n.yLabel ?? "y");
    // Place labels just outside the plot, but inside the node frame.
    drawAxisLabel(ctx, rectCss, dpr, ox + xLen / 2, Math.min(rectCss.height * dpr - 16 * dpr, oy + Math.max(28 * dpr, rectCss.height * 0.08 * dpr)), xLabel, 0);
    drawAxisLabel(ctx, rectCss, dpr, Math.max(16 * dpr, rectCss.width * 0.04 * dpr), oy - yLen / 2, yLabel, -Math.PI / 2);
  };

  const raf = () => {
    const cur = engine.getModel();
    if (cur) {
      for (const n of (cur.nodes as any[]) ?? []) {
        if (String((n as any)?.type ?? "") !== "graph") continue;
        const el = engine.getNodeElement(String((n as any).id));
        if (!el) continue;
        drawGraphNode(el, n, cur);
      }
    }
    window.requestAnimationFrame(raf);
  };
  window.requestAnimationFrame(raf);
}

function ensureSoundCompositeLayer(engine: Engine, soundId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === soundId) as any;
  const el = engine.getNodeElement(soundId);
  if (!node || !el) return null;
  const frame = el.querySelector<HTMLElement>(":scope .sound-frame");
  if (!frame) return null;

  let layer = frame.querySelector<HTMLElement>(":scope .sound-sub-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sound-sub-layer";
    layer.dataset.soundId = soundId;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    frame.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("sound-sub-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);

    // Plot group: nested composite level (soundId/plot).
    const plotGroup = document.createElement("div");
    plotGroup.className = "sound-sub comp-sub comp-group sound-sub-plotgroup";
    plotGroup.dataset.subId = "plot";
    plotGroup.dataset.compPath = soundId;
    plotGroup.dataset.groupPath = `${soundId}/plot`;
    plotGroup.style.position = "absolute";
    plotGroup.style.pointerEvents = "none";
    plotGroup.style.zIndex = "10";
    plotGroup.style.background = "transparent";
    layer.append(plotGroup);
    (layer as any).__plotGroup = plotGroup;

    // Hit layers for axis arrows (editable in group edit mode) - one per arrow id.
    // These are *not* special graphics; they map 1:1 to arrow[...] specs.
    // Positioned over the plot rect only, so selection outlines aren't huge.
    const mkArrowHit = (arrowId: string) => {
      const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer!;
      const h = document.createElement("div");
      h.className = "sound-sub sound-sub-arrow-hit comp-sub";
      h.dataset.subId = arrowId;
      // Axis arrows are authored in the root `groups/<id>/elements.pr` and should be editable
      // immediately when entering composite edit.
      h.dataset.compPath = soundId;
      h.dataset.kind = "plot-arrow";
      h.dataset.arrowId = arrowId;
      h.style.position = "absolute";
      // Sized by renderSoundCompositeArrows() (tight bbox).
      h.style.pointerEvents = "none";
      h.style.zIndex = "20";
      container.append(h);
      return h;
    };
    mkArrowHit("x_axis");
    mkArrowHit("y_axis");

    const geoms: Record<string, any> = (node.compositeGeometriesByPath?.[""] ?? node.compositeGeometries ?? {}) as any;
    // Enforce canonical positions for y_label + peak so sound matches timer.
    geoms["y_label"] = { ...(geoms["y_label"] ?? {}), ...CANON_COMPOSITE_Y_LABEL };
    geoms["peak"] = { ...(geoms["peak"] ?? {}), ...CANON_COMPOSITE_STATS };
    // Default plot region = the canonical plot rect used by the renderer.
    geoms["plot"] = geoms["plot"] ?? {
      x: PLOT_FRACS.leftF,
      y: PLOT_FRACS.topF,
      w: PLOT_FRACS.rightF - PLOT_FRACS.leftF,
      h: PLOT_FRACS.bottomF - PLOT_FRACS.topF,
      rotationDeg: 0,
      anchor: "topLeft",
      align: "left",
    };
    const text = String(node.elementsText ?? "");
    const lines = text.split(/\r?\n/);
    const arrowSpecs: Array<{ id: string; x0: number; y0: number; x1: number; y1: number; color: string; width: number }> = [];
    for (const ln0 of lines) {
      const ln = ln0.trim();
      if (!ln || ln.startsWith("#")) continue;

      const mt = ln.match(/^text\[name=(?<id>[a-zA-Z_]\w*)\]\s*:\s*(?<content>.*)$/);
      if (mt?.groups) {
        const sid = mt.groups.id;
        const content = mt.groups.content ?? "";
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.4, h: 0.1, rotationDeg: 0, anchor: "centerCenter", align: "center" };
        const d = document.createElement("div");
        d.className = "sound-sub sound-sub-text comp-sub";
        d.dataset.subId = sid;
        d.dataset.compPath = soundId;
        d.dataset.template = content;
        const contentEl = document.createElement("div");
        contentEl.className = "sound-sub-content";
        contentEl.style.width = "100%";
        contentEl.style.height = "100%";
        contentEl.style.display = "grid";
        contentEl.style.placeItems = "center";
        d.append(contentEl);
        d.style.position = "absolute";
        d.style.left = `${(g.x ?? 0.5) * 100}%`;
        d.style.top = `${(g.y ?? 0.5) * 100}%`;
        d.style.width = `${(g.w ?? 0.4) * 100}%`;
        d.style.height = `${(g.h ?? 0.1) * 100}%`;
        d.style.transform = "translate(-50%, -50%)";
        d.style.padding = "0";
        d.style.borderRadius = "0";
        d.style.border = "none";
        d.style.background = "transparent";
        d.style.color = "rgba(255,255,255,0.92)";
        d.style.userSelect = "none";
        d.style.pointerEvents = "none";
        d.style.zIndex = "30";
        d.style.whiteSpace = "nowrap";
        d.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
        d.style.fontWeight = "400";
        d.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
        const rot = Number(g.rotationDeg ?? 0);
        if (rot) d.style.rotate = `${rot}deg`;
        layer.append(d);
        continue;
      }

      // buttons[name=...,orientation=h|v,labels=[...]]
      const mb = ln.match(/^buttons\[(?<params>[^\]]+)\]$/);
      if (mb?.groups?.params) {
        const params = _parseInlineParams(mb.groups.params);
        const sid = String(params.name ?? "").trim();
        if (!sid) continue;
        const orient = (String(params.orientation ?? "h").trim().toLowerCase() === "v" ? "v" : "h") as "h" | "v";
        const labels = _parseList(params.labels);
        const actions = _parseList(params.actions);
        const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.55, h: 0.10, rotationDeg: 0, anchor: "centerCenter", align: "center" };

        const boxEl = document.createElement("div");
        // Movable chrome: editable as a unit in group edit mode.
        boxEl.className = "sound-sub sound-sub-buttons comp-chrome comp-sub";
        boxEl.dataset.subId = sid;
        boxEl.dataset.compPath = soundId;
        boxEl.dataset.orientation = orient;
        boxEl.dataset.templates = JSON.stringify(labels);
        boxEl.dataset.actions = JSON.stringify(actions);

        boxEl.style.position = "absolute";
        boxEl.style.left = `${(g.x ?? 0.5) * 100}%`;
        boxEl.style.top = `${(g.y ?? 0.5) * 100}%`;
        boxEl.style.width = `${(g.w ?? 0.55) * 100}%`;
        boxEl.style.height = `${(g.h ?? 0.10) * 100}%`;
        boxEl.style.transform = "translate(-50%, -50%)";
        boxEl.style.padding = "0";
        boxEl.style.border = "none";
        boxEl.style.background = "transparent";
        boxEl.style.pointerEvents = "auto";
        boxEl.style.zIndex = "40";
        boxEl.style.userSelect = "none";

        const row = document.createElement("div");
        row.className = "ip-buttons-row";
        row.style.display = "flex";
        row.style.flexDirection = orient === "v" ? "column" : "row";
        row.style.gap = "10px";
        row.style.alignItems = "center";
        row.style.justifyContent = "center";
        row.style.width = "100%";
        row.style.height = "100%";

        labels.forEach((tpl, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ip-controlbtn";
          btn.dataset.idx = String(idx + 1);
          btn.dataset.template = String(tpl ?? "");
          const contentEl = document.createElement("div");
          contentEl.className = "ip-button-content";
          btn.appendChild(contentEl);
          btn.addEventListener("click", (ev) => {
            if (getAppMode() !== "live" || (window as any).__ip_compositeEditing) {
              return;
            }
            const evName = `${sid}-${idx + 1}`;
            window.dispatchEvent(new CustomEvent(evName, { detail: { id: sid, index: idx + 1, compPath: soundId } }));

            const action = actions[idx] ?? "";
            if (!action) return;
            // Reuse the existing button-action handlers by synthesizing a click on the hidden header buttons when present.
            const root = engine.getNodeElement(soundId);
            if (!root) return;
            const btn2 = root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
            btn2?.click();
          });
          row.appendChild(btn);
        });
        boxEl.appendChild(row);
        layer.appendChild(boxEl);
        continue;
      }

      const ma = ln.match(
        /^arrow\[\s*name=(?<id>[a-zA-Z_]\w*)\s*,\s*from=\(\s*(?<x0>-?(?:\d+\.?\d*|\.\d+))\s*,\s*(?<y0>-?(?:\d+\.?\d*|\.\d+))\s*\)\s*,\s*to=\(\s*(?<x1>-?(?:\d+\.?\d*|\.\d+))\s*,\s*(?<y1>-?(?:\d+\.?\d*|\.\d+))\s*\)(?:\s*,\s*color=(?<color>[^,\]]+))?(?:\s*,\s*width=(?<width>-?(?:\d+\.?\d*|\.\d+)))?\s*\]\s*$/
      );
      if (ma?.groups) {
        const sid = ma.groups.id;
        arrowSpecs.push({
          id: sid,
          x0: Number(ma.groups.x0),
          y0: Number(ma.groups.y0),
          x1: Number(ma.groups.x1),
          y1: Number(ma.groups.y1),
          color: (ma.groups.color ?? "white").trim(),
          width: ma.groups.width == null ? 0.006 : Number(ma.groups.width),
        });
        continue;
      }
    }
    (layer as any).__arrowSpecs = arrowSpecs;
    (layer as any).__textGeoms = geoms;
    // This is .pr content (single-line "text[name=...]: ..." etc).
    (layer as any).__elementsPr = text;
  }

  // Ensure per-axis hit layers exist even if the layer was created before we added them.
  const ensureHit = (arrowId: string) => {
    const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer;
    if (container.querySelector<HTMLElement>(`:scope > .sound-sub-arrow-hit[data-arrow-id="${arrowId}"]`)) return;
    const h = document.createElement("div");
    h.className = "sound-sub sound-sub-arrow-hit comp-sub";
    h.dataset.subId = arrowId;
    // See mkArrowHit(): axis arrows should be editable at the root composite level.
    h.dataset.compPath = soundId;
    h.dataset.kind = "plot-arrow";
    h.dataset.arrowId = arrowId;
    h.style.position = "absolute";
    // Sized by renderSoundCompositeArrows() (tight bbox).
    h.style.pointerEvents = "none";
    h.style.zIndex = "20";
    container.append(h);
  };
  ensureHit("x_axis");
  ensureHit("y_axis");

  // Ensure plot group exists for older layers.
  let plotGroup = (layer as any).__plotGroup as HTMLElement | null;
  if (!plotGroup) {
    plotGroup = layer.querySelector<HTMLElement>(":scope > .sound-sub-plotgroup");
    if (!plotGroup) {
      plotGroup = document.createElement("div");
      plotGroup.className = "sound-sub comp-sub comp-group sound-sub-plotgroup";
      plotGroup.dataset.subId = "plot";
      plotGroup.dataset.compPath = soundId;
      plotGroup.dataset.groupPath = `${soundId}/plot`;
      plotGroup.style.position = "absolute";
      plotGroup.style.pointerEvents = "none";
      plotGroup.style.zIndex = "10";
      plotGroup.style.background = "transparent";
      layer.append(plotGroup);
    }
    (layer as any).__plotGroup = plotGroup;
  }

  // Sync plot region geom -> DOM box + dataset fracs so canvas/ticks follow it.
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? (node.compositeGeometries ?? {});
  const pg = (geoms["plot"] ??= {
    x: PLOT_FRACS.leftF,
    y: PLOT_FRACS.topF,
    w: PLOT_FRACS.rightF - PLOT_FRACS.leftF,
    h: PLOT_FRACS.bottomF - PLOT_FRACS.topF,
    rotationDeg: 0,
    anchor: "topLeft",
    align: "left",
  });
  const ptl = anchorToTopLeftWorld({ x: Number(pg.x), y: Number(pg.y), w: Number(pg.w), h: Number(pg.h), anchor: String(pg.anchor ?? "topLeft") } as any);
  const leftF = ptl.x;
  const topF = ptl.y;
  const rightF = leftF + Number(pg.w);
  const bottomF = topF + Number(pg.h);
  el.dataset.plotLeftF = String(leftF);
  el.dataset.plotRightF = String(rightF);
  el.dataset.plotTopF = String(topF);
  el.dataset.plotBottomF = String(bottomF);
  if (plotGroup) {
    plotGroup.style.left = `${leftF * 100}%`;
    plotGroup.style.top = `${topF * 100}%`;
    plotGroup.style.width = `${Number(pg.w) * 100}%`;
    plotGroup.style.height = `${Number(pg.h) * 100}%`;
    plotGroup.dataset.anchor = "topLeft";
    plotGroup.style.transform = "translate(0%, 0%)";
  }

  return layer;
}

function renderSoundCompositeTexts(soundEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .sound-sub-text"));
  const hPx = Number(soundEl.dataset.soundHpx ?? "0");
  const wPx = Number(soundEl.dataset.soundWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : soundEl.getBoundingClientRect();
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "sound" && compositeId === String(soundEl.dataset.nodeId ?? "");
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const x = Number(g.x ?? 0.5);
    const y = Number(g.y ?? 0.5);
    const w = Number(g.w ?? 0.4);
    const h = Number(g.h ?? 0.1);
    const anchor = String(g.anchor ?? t.dataset.anchor ?? "centerCenter");
    t.dataset.anchor = anchor;
    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    t.style.rotate = `${Number(g.rotationDeg ?? 0)}deg`;
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
    const fontPx = Math.max(16, box.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
    const tpl = t.dataset.template ?? "";
    const resolved = applyDataBindings(tpl, data);
    const prev = t.dataset.rawText ?? "";
    if (prev !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope > .sound-sub-content");
      if (contentEl) renderTextToElement(contentEl, resolved);
    }

    // Make ALL composite elements editable when in group edit mode.
    // (Otherwise they should not intercept pointer events.)
    t.style.pointerEvents = isGroupEditing ? "auto" : "none";
    t.style.cursor = isGroupEditing ? "grab" : "default";

    // Visibility should be controlled by animations, not by mode-specific hard hides.
  }
}

function renderSoundCompositeButtons(soundEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .sound-sub-buttons"));
  const hPx = Number(soundEl.dataset.soundHpx ?? "0");
  const wPx = Number(soundEl.dataset.soundWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : soundEl.getBoundingClientRect();
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "sound" && compositeId === String(soundEl.dataset.nodeId ?? "");
  const appMode = getAppMode();
  for (const boxEl of els) {
    const sid = boxEl.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.10);
    const fontPx = Math.max(12, box.height * h * 0.55);
    const scale = Math.max(0.6, Math.min(3, fontPx / 16));
    boxEl.style.setProperty("--control-scale", String(scale));
    // Interaction rules:
    // - Live: buttons must be clickable
    // - Edit (not group edit): do NOT steal clicks from selecting the sound node
    // - Edit + group edit: allow selecting/moving the button group as a composite sub-element
    const canSelectGroup = appMode === "edit" && isGroupEditing;
    boxEl.style.opacity = "1";
    boxEl.style.pointerEvents = appMode === "live" ? "auto" : canSelectGroup ? "auto" : "none";
    for (const btn of Array.from(boxEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const tpl = btn.dataset.template ?? "";
      const resolved = applyDataBindings(tpl, data);
      const prev = btn.dataset.rawText ?? "";
      if (prev !== resolved) {
        btn.dataset.rawText = resolved;
        const contentEl = btn.querySelector<HTMLElement>(":scope > .ip-button-content");
        if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
      }
    }
  }
  // Hide the legacy headerbar when composite buttons are present (avoid duplicates).
  soundEl.querySelector<HTMLElement>(".sound-header")?.setAttribute("style", "display:none !important");
}

function layoutSoundCompositeTexts(soundEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .sound-sub-text"));
  const hPx = Number(soundEl.dataset.soundHpx ?? "0");
  const wPx = Number(soundEl.dataset.soundWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : soundEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.1);
    const fontPx = Math.max(16, box.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
  }
}

function renderSoundCompositeArrows(soundEl: HTMLElement, layer: HTMLElement) {
  const svg = layer.querySelector<SVGSVGElement>(":scope > .sound-sub-svg");
  if (!svg) return;
  const specs: any[] = (layer as any).__arrowSpecs ?? [];
  if (!Array.isArray(specs) || specs.length === 0) {
    svg.replaceChildren();
    return;
  }
  const cachedW = Number(soundEl.dataset.soundWpx ?? "0");
  const cachedH = Number(soundEl.dataset.soundHpx ?? "0");
  if (!(cachedW > 1 && cachedH > 1)) return;
  let w = Math.max(1, cachedW);
  let h = Math.max(1, cachedH);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const soundId = layer.dataset.soundId ?? "sound";
  const selectedArrowId = String((layer as any).dataset?.selectedPlotArrowId ?? "");

  const fr = _plotFracsForEl(soundEl);
  const ox = fr.leftF * w;
  const oy = fr.bottomF * h;
  const xLen = (fr.rightF - fr.leftF) * w;
  const yLen = (fr.bottomF - fr.topF) * h;
  const mapX = (u: number) => ox + u * xLen;
  const mapY = (vUp: number) => oy - vUp * yLen;
  const dataMin = Math.max(1, Math.min(xLen, yLen));

  for (const a of specs) {
    const relW = typeof a.width === "number" && isFinite(a.width) ? a.width : 0.006;
    const lwPx = Math.max(0.5, Math.min(16, relW * dataMin));
    const headWPx = 3 * lwPx;
    const headLPx = 5 * lwPx;
    const x1 = mapX(Number(a.x0 ?? 0));
    const y1 = mapY(Number(a.y0 ?? 0));
    const x2 = mapX(Number(a.x1 ?? 1));
    const y2 = mapY(Number(a.y1 ?? 1));

    const plotGroup = (layer as any).__plotGroup as HTMLElement | null;
    const hit = (plotGroup ?? layer).querySelector<HTMLElement>(
      `:scope > .sound-sub-arrow-hit[data-arrow-id="${String(a.id ?? "")}"]`
    );
    if (hit) {
      const padPx = 24;
      const minX = Math.min(x1, x2) - padPx;
      const maxX = Math.max(x1, x2) + padPx;
      const minY = Math.min(y1, y2) - padPx;
      const maxY = Math.max(y1, y2) + padPx;
      hit.style.left = `${((minX - ox) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.top = `${((minY - (oy - yLen)) / Math.max(1e-9, yLen)) * 100}%`;
      hit.style.width = `${((maxX - minX) / Math.max(1e-9, xLen)) * 100}%`;
      hit.style.height = `${((maxY - minY) / Math.max(1e-9, yLen)) * 100}%`;
    }

    const markerId = `arrowhead-${soundId}-${a.id}`;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("markerWidth", String(headLPx));
    marker.setAttribute("markerHeight", String(headWPx));
    marker.setAttribute("refX", "0");
    marker.setAttribute("refY", String(headWPx / 2));
    marker.setAttribute("orient", "auto");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M0,0 L${headLPx},${headWPx / 2} L0,${headWPx} Z`);
    path.setAttribute("fill", a.color ?? "white");
    marker.append(path);
    defs.append(marker);
    const isSelected = selectedArrowId && String(a.id ?? "") === selectedArrowId;
    if (isSelected) {
      const glow = document.createElementNS("http://www.w3.org/2000/svg", "line");
      glow.setAttribute("x1", String(x1));
      glow.setAttribute("y1", String(y1));
      glow.setAttribute("x2", String(x2));
      glow.setAttribute("y2", String(y2));
      glow.setAttribute("stroke", "rgba(110,168,255,0.95)");
      glow.setAttribute("stroke-width", String(Math.min(48, lwPx + 10)));
      glow.setAttribute("stroke-linecap", "round");
      g.append(glow);
    }
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", a.color ?? "white");
    line.setAttribute("stroke-width", String(lwPx));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", `url(#${markerId})`);
    g.append(line);
  }
  svg.replaceChildren(defs, g);
}
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

function ipDebugEnabled(flag: string) {
  try {
    return (
      (localStorage.getItem(flag) === "1" ||
        (window as any)[flag] === true ||
        String((window as any)[flag] ?? "") === "1") ?? false
    );
  } catch {
    return false;
  }
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
      // Always log failures (otherwise 400s are impossible to debug from the UI).
      // eslint-disable-next-line no-console
      console.warn("[ip][composite][save] failed", { status: res.status, statusText: res.statusText, ctx, body: txt });
      if (dbg) {
        // eslint-disable-next-line no-console
        console.warn("[ip][composite][save] payload", payload);
      }
    } else if (dbg) {
      // eslint-disable-next-line no-console
      console.log("[ip][composite][save] ok", { ctx, payload });
    }
  } catch (err) {
    // Always log network errors too.
    // eslint-disable-next-line no-console
    console.warn("[ip][composite][save] error", { ctx, err });
    if (dbg) {
      // eslint-disable-next-line no-console
      console.warn("[ip][composite][save] payload", payload);
    }
  }
}

function ensureHandles(el: HTMLElement) {
  // Safety: never show transform UI in Live mode.
  if (getAppMode() !== "edit") {
    el.querySelector(":scope > .handles")?.remove();
    return null;
  }
  let handles = el.querySelector<HTMLDivElement>(":scope > .handles");

  // Special-case: arrows/lines are edited via control points, not bounding-box resize/rotate.
  const isSegment = el.classList.contains("node-arrow") || el.classList.contains("node-line");
  if (isSegment) {
    // Simplest UX: no visible handle points ("rings").
    // Endpoints are draggable by proximity (see stage pointerdown handler).
    el.querySelector(":scope > .handles")?.remove();
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

function attachEditor(stage: HTMLElement, engine: Engine) {
  const selected = new Set<string>();
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

  // Simple top toolbox (edit mode): pick what to place.
  let tool: "select" | "text" | "bullets" | "arrow" | "line" = "select";
  let segmentDraft:
    | null
    | {
        // Start/end are in the chosen model space (world or screen).
        start: { x: number; y: number };
        space: "world" | "screen";
        // For preview we render in screen pixels (overlay space), regardless of model space.
        startScreen: { x: number; y: number };
        previewSvg: SVGSVGElement;
        lineEl: SVGLineElement;
        startDot: SVGCircleElement;
        endDot: SVGCircleElement;
        kind: "arrow" | "line";
      } = null;
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
      tool = id;
      for (const x of Array.from(toolbox.querySelectorAll<HTMLButtonElement>("button"))) {
        x.dataset.active = x === b ? "1" : "0";
        x.style.background = x === b ? "rgba(110,168,255,0.22)" : "rgba(255,255,255,0.06)";
        x.style.borderColor = x === b ? "rgba(110,168,255,0.36)" : "rgba(255,255,255,0.16)";
      }
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
  toolbox.append(
    mkToolBtn("select", "Select", ICON.select),
    mkToolBtn("text", "Text", ICON.text),
    mkToolBtn("bullets", "Bullets", ICON.bullets),
    mkToolBtn("arrow", "Arrow", ICON.arrow),
    mkToolBtn("line", "Line", ICON.line)
  );
  // Default active button
  (toolbox.querySelector<HTMLButtonElement>("button") as any)?.click?.();
  // Avoid duplicating if attachEditor is called multiple times.
  document.querySelector(".edit-toolbox")?.remove();
  document.body.appendChild(toolbox);

  const undoStack: PresentationModel[] = [];
  const redoStack: PresentationModel[] = [];
  const cloneModel = (m: PresentationModel): PresentationModel => JSON.parse(JSON.stringify(m)) as PresentationModel;

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
          // applyGroupEditDimming is defined later in this closure; guard defensively.
          try {
            (anyEngine.__ip_applyGroupEditDimming ?? applyGroupEditDimming)?.();
          } catch {}
        }
        // Re-apply composite edit marker + layer pointer-events (if active).
        const cid = (window as any).__ip_compositeEditing ? (anyEngine.__ip_compositeEditTimerId ?? null) : null;
        // We don't have closure access to compositeEditTimerId here, so also probe the DOM for the marker.
        const compositeId =
          typeof (window as any).__ip_compositeEditing === "boolean" && (window as any).__ip_compositeEditing
            ? (anyEngine.__ip_lastCompositeId ?? null)
            : null;
        void cid;
        const id = String(compositeId ?? "");
        if (id) {
          const el = engine.getNodeElement(id);
          if (el && el.dataset.compositeEditing !== "1") {
            const prev = el.dataset.compositeEditing;
            el.dataset.compositeEditing = "1";
            const layer =
              el.querySelector<HTMLElement>(".timer-sub-layer") ?? el.querySelector<HTMLElement>(".sound-sub-layer") ?? null;
            if (layer) layer.style.pointerEvents = "auto";
            // eslint-disable-next-line no-console
            console.log("[ip][dbg] restored compositeEditing after setModel", { id, prev });
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
  const groupEditStack: string[] = [];
  let groupHiddenEls: HTMLElement[] = [];
  let groupRefEl: HTMLElement | null = null;
  const activeGroupEditId = () => (groupEditStack.length > 0 ? groupEditStack[groupEditStack.length - 1]! : null);
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
  let enterGroupEdit: (groupId: string) => void = () => {};
  let exitGroupEditLevel: () => void = () => {};

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
      hstyle: "||c|c|c||",
      vstyle: "|b||c|...|",
      rows: [
        ["C1", "C2", "C3"],
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"]
      ],
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
      color: "white",
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
    const newParentId = ""; // lines currently live at root; keep joins within the same parentId
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
      color: "white",
      width: wPx,
      p1Join,
      p2Join,
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

  // IMPORTANT: `engine.setModel()` clears the engine overlay DOM subtree.
  // The segment-draft preview must live OUTSIDE that subtree, otherwise it disappears after the first segment.
  const getDraftLayerEl = () => {
    let el = stage.querySelector<HTMLElement>(".ip-draft-layer");
    if (!el) {
      el = document.createElement("div");
      el.className = "ip-draft-layer";
      el.style.position = "absolute";
      el.style.inset = "0";
      el.style.pointerEvents = "none";
      el.style.zIndex = "2"; // above the engine overlay (z=1)
      stage.appendChild(el);
    }
    return el;
  };

  const snapWorldPoint = (p: { x: number; y: number }, cam: any) => {
    const { spacing0, spacing1, t } = gridSpacingForZoom(Number(cam?.zoom ?? 1));
    const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
    const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
    return { x: snap(p.x), y: snap(p.y) };
  };

  const makeSegmentPreview = (kind: "arrow" | "line", overlay: HTMLElement) => {
    const WHITE = "rgba(255,255,255,0.92)";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    // Keep preview coordinates 1:1 with overlay pixels (no aspect letterboxing).
    svg.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    if (kind === "arrow") {
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      marker.setAttribute("id", "arrowhead-preview");
      // Match engine arrow sizing:
      // - head height == 4 * strokeWidth  (stroke=4 => 16px)
      // - head length == 5 * strokeWidth  (stroke=4 => 20px)
      marker.setAttribute("markerUnits", "strokeWidth");
      marker.setAttribute("markerWidth", "5");
      marker.setAttribute("markerHeight", "4");
      marker.setAttribute("refX", "5");
      marker.setAttribute("refY", "2");
      marker.setAttribute("orient", "auto");
      const pth = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pth.setAttribute("d", "M 0 0 L 5 2 L 0 4 z");
      pth.setAttribute("fill", WHITE);
      marker.appendChild(pth);
      defs.appendChild(marker);
    }
    svg.appendChild(defs);

    const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
    ln.setAttribute("x1", "0");
    ln.setAttribute("y1", "0");
    ln.setAttribute("x2", "0");
    ln.setAttribute("y2", "0");
    ln.setAttribute("stroke", WHITE);
    ln.setAttribute("stroke-width", "4");
    ln.setAttribute("stroke-linecap", "round");
    ln.setAttribute("stroke-dasharray", "10 10");
    ln.setAttribute("vector-effect", "non-scaling-stroke");
    if (kind === "arrow") ln.setAttribute("marker-end", "url(#arrowhead-preview)");
    svg.appendChild(ln);

    const mkDot = () => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", "0");
      c.setAttribute("cy", "0");
      c.setAttribute("r", "6");
      c.setAttribute("fill", "rgba(15,17,24,0.35)");
      c.setAttribute("stroke", WHITE);
      c.setAttribute("stroke-width", "2");
      c.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(c);
      return c;
    };
    const startDot = mkDot();
    const endDot = mkDot();

    // Keep viewBox in sync with overlay pixels to avoid angle distortion.
    const syncViewBox = () => {
      const w = Math.max(1, overlay.clientWidth);
      const h = Math.max(1, overlay.clientHeight);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    };
    syncViewBox();

    overlay.appendChild(svg);
    return { svg, lineEl: ln, startDot, endDot, syncViewBox };
  };

  const updateSegmentPreview = (draft: NonNullable<typeof segmentDraft>, endScreen: { x: number; y: number }) => {
    draft.lineEl.setAttribute("x1", String(draft.startScreen.x));
    draft.lineEl.setAttribute("y1", String(draft.startScreen.y));
    draft.lineEl.setAttribute("x2", String(endScreen.x));
    draft.lineEl.setAttribute("y2", String(endScreen.y));
    draft.startDot.setAttribute("cx", String(draft.startScreen.x));
    draft.startDot.setAttribute("cy", String(draft.startScreen.y));
    draft.endDot.setAttribute("cx", String(endScreen.x));
    draft.endDot.setAttribute("cy", String(endScreen.y));
  };

  // Placement tool handler (capture) so it runs before selection/pan handlers.
  stage.addEventListener(
    "pointerdown",
    (ev) => {
      if (getAppMode() !== "edit") return;
      if (tool === "select") return;
      // Only left click should start/commit drawing. Right click cancels (handled by contextmenu).
      if (ev.button !== 0) return;
      const t = ev.target as HTMLElement;
      const isSegmentTool = tool === "arrow" || tool === "line";
      // Don’t interfere with normal manipulation when clicking nodes/handles/UI.
      if (
        t.closest(".edit-toolbox") ||
        (!isSegmentTool && t.closest(".node")) ||
        (!isSegmentTool && t.closest(".handles")) ||
        t.closest(".modal") ||
        t.closest(".mode-toggle")
      )
        return;

      const r = stage.getBoundingClientRect();
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const space: "world" | "screen" = screenEditMode ? "screen" : "world";
      let pos = space === "screen" ? screenPos : screenToWorld(screenPos, cam as any, scr as any);

      if (tool === "text") {
        void addTextAt(pos, { space });
        ev.preventDefault();
        (ev as any).stopImmediatePropagation?.();
        return;
      }
      if (tool === "bullets") {
        void addBulletsAt(pos, { space });
        ev.preventDefault();
        (ev as any).stopImmediatePropagation?.();
        return;
      }
      if (tool === "arrow" || tool === "line") {
        const kind: "arrow" | "line" = tool === "line" ? "line" : "arrow";
        const overlay = getDraftLayerEl();

        // Shift snapping while placing:
        // - world: snap to junction if closer than grid; otherwise grid
        // - screen: snap to junction within tolerance
        if (ev.shiftKey) {
          const modelNow = engine.getModel();
          const tolPx = 12;
          const tolPx2 = tolPx * tolPx;
          const toScreenPt = (p: { x: number; y: number }) =>
            space === "world" ? worldToScreen(p, cam as any, scr as any) : { x: p.x, y: p.y }; // already px in screen space
          const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            return dx * dx + dy * dy;
          };

          // Collect line endpoints in the same space.
          const junctions: Array<{ x: number; y: number }> = [];
          for (const n0 of (modelNow?.nodes as any[]) ?? []) {
            if (!n0 || String(n0.type) !== "line") continue;
            if (String(n0.space ?? "world") !== space) continue;
            const { ui } = modelNow ? _uiNodeForId(String(n0.id), modelNow) : { ui: null as any };
            const tN = (ui as any)?.transform ?? n0.transform ?? {};
            const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
            const to = (n0 as any).to ?? { x: 1, y: 0.5 };
            const tl = anchorToTopLeftWorld({ x: Number(tN.x ?? 0), y: Number(tN.y ?? 0), w: Number(tN.w ?? 1), h: Number(tN.h ?? 1), anchor: tN.anchor ?? "topLeft" } as any);
            const w = Math.max(1e-9, Number(tN.w ?? 1));
            const h = Math.max(1e-9, Number(tN.h ?? 1));
            const q1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
            const q2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };
            junctions.push(q1, q2);
          }

          // Nearest junction.
          const ps = toScreenPt(pos as any);
          let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
          for (const j of junctions) {
            const d2 = dist2px(toScreenPt(j), ps);
            if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
          }

          if (space === "world") {
            const gridPt = snapWorldPoint(pos as any, cam as any);
            const gridD2 = dist2px(toScreenPt(gridPt), ps);
            if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) pos = bestJ.p as any;
            else pos = gridPt as any;
          } else {
            if (bestJ && bestJ.d2 <= tolPx2) pos = bestJ.p as any;
          }
        }

        const posScreen = space === "screen" ? pos : worldToScreen(pos, cam as any, scr as any);

        if (!segmentDraft) {
          // First click: set the base anchor and start showing dashed hover preview.
          const { svg, lineEl, startDot, endDot, syncViewBox } = makeSegmentPreview(kind, overlay);
          segmentDraft = {
            start: pos,
            startScreen: posScreen,
            space,
            previewSvg: svg,
            lineEl,
            startDot,
            endDot,
            kind
          };
          syncViewBox();
          updateSegmentPreview(segmentDraft, posScreen);
        } else {
          // Next click: commit node to the model.
          if (segmentDraft.kind !== kind || segmentDraft.space !== space) {
            // If the user switched tool/space mid-draft, cancel and restart cleanly.
            segmentDraft.previewSvg.remove();
            segmentDraft = null;
            const { svg, lineEl, startDot, endDot, syncViewBox } = makeSegmentPreview(kind, overlay);
            segmentDraft = { start: pos, startScreen: posScreen, space, previewSvg: svg, lineEl, startDot, endDot, kind };
            syncViewBox();
            updateSegmentPreview(segmentDraft, posScreen);
          } else {
            const start = segmentDraft.start;
            // Commit a segment
            if (kind === "line") {
              // Polyline behavior: keep drafting; next segment starts at the previous endpoint.
              void addLineFromTo(start, pos, { space, select: false });
              segmentDraft.start = pos;
              segmentDraft.startScreen = posScreen;
              // Reset preview to a zero-length segment at the new anchor; pointermove will extend it.
              updateSegmentPreview(segmentDraft, posScreen);
            } else {
              // Arrow behavior: single segment, then stop.
            segmentDraft.previewSvg.remove();
            segmentDraft = null;
              void addArrowFromTo(start, pos, { space });
            }
          }
        }
        ev.preventDefault();
        (ev as any).stopImmediatePropagation?.();
      }
    },
    { capture: true }
  );

  stage.addEventListener(
    "pointermove",
    (ev) => {
      if (!segmentDraft) return;
      const r = stage.getBoundingClientRect();
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      let pos = segmentDraft.space === "screen" ? screenPos : screenToWorld(screenPos, cam as any, scr as any);
      if (ev.shiftKey) {
        const modelNow = engine.getModel();
        const tolPx = 12;
        const tolPx2 = tolPx * tolPx;
        const space: "world" | "screen" = segmentDraft.space;
        const toScreenPt = (p: { x: number; y: number }) =>
          space === "world" ? worldToScreen(p, cam as any, scr as any) : { x: p.x, y: p.y };
        const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          return dx * dx + dy * dy;
        };
        const junctions: Array<{ x: number; y: number }> = [];
        for (const n0 of (modelNow?.nodes as any[]) ?? []) {
          if (!n0 || String(n0.type) !== "line") continue;
          if (String(n0.space ?? "world") !== space) continue;
          const { ui } = modelNow ? _uiNodeForId(String(n0.id), modelNow) : { ui: null as any };
          const tN = (ui as any)?.transform ?? n0.transform ?? {};
          const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
          const to = (n0 as any).to ?? { x: 1, y: 0.5 };
          const tl = anchorToTopLeftWorld({ x: Number(tN.x ?? 0), y: Number(tN.y ?? 0), w: Number(tN.w ?? 1), h: Number(tN.h ?? 1), anchor: tN.anchor ?? "topLeft" } as any);
          const w = Math.max(1e-9, Number(tN.w ?? 1));
          const h = Math.max(1e-9, Number(tN.h ?? 1));
          const q1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
          const q2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };
          junctions.push(q1, q2);
        }
        const ps = toScreenPt(pos as any);
        let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
        for (const j of junctions) {
          const d2 = dist2px(toScreenPt(j), ps);
          if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
        }

        if (space === "world") {
          const gridPt = snapWorldPoint(pos as any, cam as any);
          const gridD2 = dist2px(toScreenPt(gridPt), ps);
          if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) pos = bestJ.p as any;
          else pos = gridPt as any;
        } else {
          if (bestJ && bestJ.d2 <= tolPx2) pos = bestJ.p as any;
        }
      }
      const posScreen = segmentDraft.space === "screen" ? pos : worldToScreen(pos, cam as any, scr as any);
      // Keep preview stroke matching final canvas stroke scaling (world space scales with zoom).
      const z = segmentDraft.space === "world" ? Number(cam.zoom ?? 1) : 1;
      const previewStroke = 4 * z;
      segmentDraft.lineEl.setAttribute("stroke-width", String(previewStroke));
      segmentDraft.lineEl.setAttribute("stroke-dasharray", `${10 * z} ${10 * z}`);
      // Keep viewBox stable with overlay resizing.
      const overlay = getDraftLayerEl();
      const w = Math.max(1, overlay.clientWidth);
      const h = Math.max(1, overlay.clientHeight);
      segmentDraft.previewSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      updateSegmentPreview(segmentDraft, posScreen);
    },
    { capture: true }
  );

  // Cancel draft on Escape (keep editor responsive).
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (segmentDraft) {
      segmentDraft.previewSvg.remove();
      segmentDraft = null;
      ev.preventDefault();
    }
  });

  // Right click: cancel any in-progress preview placement and clear selection.
  // (Toolbar replaces the right-click context menu.)
  stage.addEventListener("contextmenu", (ev) => {
    if (getAppMode() !== "edit") return;
    ev.preventDefault();
    if (segmentDraft) {
      segmentDraft.previewSvg.remove();
      segmentDraft = null;
      return; // cancel preview only
    }
    clearSelection();
  });

  // Ensure table edit is committed when clicking elsewhere (works in live+edit).
  window.addEventListener(
    "pointerdown",
    (ev) => {
      if (!__activeTableEdit) return;
      const t = ev.target as HTMLElement;
      if (t === __activeTableEdit.input || t.closest(".ip-table-input")) return;
      // If clicking inside the same cell, allow the input to handle it.
      if (t.closest("td.table-cell") === __activeTableEdit.td) return;
      void _endActiveTableEdit({ commit: true });
    },
    { capture: true }
  );

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
  let startAngleRad = 0;
  let startRotationDeg = 0;
  // When dragging a line junction (endpoint) or moving a whole segment,
  // move all coincident endpoints together so lines behave like a graph (shared junction nodes).
  let junctionDrag:
    | null
    | {
        movedId: string;
        space: "world" | "screen";
        // Links for each endpoint of the moved segment (so mid-drag keeps both junctions connected).
        p1Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>;
        p2Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>;
        // Candidate junctions for snap-to-graph (endpoints of other lines).
        junctions: Array<{ x: number; y: number }>;
      } = null;

  // When dragging far from the stroke (>20px), translate the entire connected component of lines ("graph drag").
  let graphDrag:
    | null
    | {
        ids: string[];
        space: "world" | "screen";
        // Reference point for snapping translation (in the same space units).
        ref: { x: number; y: number };
      } = null;

  const _collectConnectedLineIds = (
    seedId: string,
    model: any,
    space: "world" | "screen",
    cam: any,
    scr: any,
    parentId: string
  ) => {
    // Prefer explicit join IDs if present; fall back to proximity-based welding for legacy segments.
    const joinToLineIds = new Map<string, string[]>();
    const joinsByLineId = new Map<string, string[]>();
    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any)?.parentId ?? "").trim();
      if (pid !== String(parentId ?? "").trim()) continue;
      const nid = String(n0.id ?? "");
      if (!nid) continue;
      const j1 = String((n0 as any).p1Join ?? "").trim();
      const j2 = String((n0 as any).p2Join ?? "").trim();
      const js = [j1, j2].filter(Boolean);
      if (js.length) {
        joinsByLineId.set(nid, js);
        for (const j of js) {
          const arr = joinToLineIds.get(j) ?? [];
          arr.push(nid);
          joinToLineIds.set(j, arr);
        }
      }
    }
    const seedJoins = joinsByLineId.get(seedId) ?? [];
    if (seedJoins.length && joinToLineIds.size) {
      const visited = new Set<string>();
      const q: string[] = [seedId];
      visited.add(seedId);
      while (q.length) {
        const cur = q.shift()!;
        const js = joinsByLineId.get(cur) ?? [];
        for (const j of js) {
          const neigh = joinToLineIds.get(j) ?? [];
          for (const id of neigh) {
            if (visited.has(id)) continue;
            visited.add(id);
            q.push(id);
          }
        }
      }
      return Array.from(visited);
    }

    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;
    const cell = tolPx;

    const toScreenPt = (p: { x: number; y: number }) =>
      space === "world" ? worldToScreen(p, cam as any, scr as any) : { x: p.x * scr.w, y: p.y * scr.h };

    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };

    // Compute line endpoints in `space` units + their screen px projection.
    const lineIds: string[] = [];
    const endpointsById = new Map<string, { p1: { s: { x: number; y: number } }; p2: { s: { x: number; y: number } } }>();
    const buckets = new Map<string, Array<{ id: string; s: { x: number; y: number } }>>();
    const put = (id: string, s: { x: number; y: number }) => {
      const cx = Math.floor(s.x / cell);
      const cy = Math.floor(s.y / cell);
      const k = `${cx},${cy}`;
      const arr = buckets.get(k) ?? [];
      arr.push({ id, s });
      buckets.set(k, arr);
    };

    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any)?.parentId ?? "").trim();
      if (pid !== String(parentId ?? "").trim()) continue;

      const nid = String(n0.id ?? "");
      if (!nid) continue;
      lineIds.push(nid);

      const { ui } = _uiNodeForId(nid, model);
      const tN = (ui as any)?.transform ?? n0.transform ?? {};
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
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
      const p2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };
      const s1 = toScreenPt(p1);
      const s2 = toScreenPt(p2);
      endpointsById.set(nid, { p1: { s: s1 }, p2: { s: s2 } });
      put(nid, s1);
      put(nid, s2);
    }

    if (!endpointsById.has(seedId)) return [seedId];

    const visited = new Set<string>();
    const q: string[] = [seedId];
    visited.add(seedId);

    const neighborsFor = (s: { x: number; y: number }) => {
      const cx = Math.floor(s.x / cell);
      const cy = Math.floor(s.y / cell);
      const out: Array<{ id: string; s: { x: number; y: number } }> = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const k = `${cx + dx},${cy + dy}`;
          const arr = buckets.get(k);
          if (arr) out.push(...arr);
        }
      }
      return out;
    };

    while (q.length) {
      const cur = q.shift()!;
      const e = endpointsById.get(cur);
      if (!e) continue;
      const pts = [e.p1.s, e.p2.s];
      for (const p of pts) {
        for (const cand of neighborsFor(p)) {
          if (visited.has(cand.id)) continue;
          if (dist2(cand.s, p) <= tolPx2) {
            visited.add(cand.id);
            q.push(cand.id);
          }
        }
      }
    }

    return Array.from(visited);
  };
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
    if (h === "rot" || h.startsWith("rot-")) return "grab";
    if (h === "n" || h === "s") return "ns-resize";
    if (h === "e" || h === "w") return "ew-resize";
    if (h === "nw" || h === "se") return "nwse-resize";
    if (h === "ne" || h === "sw") return "nesw-resize";
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
    // IMPORTANT: element-level cursor (e.g. stage) overrides document cursor.
    // Keep them in sync so "closed hand" shows while dragging even when the pointer is over the stage.
    const cur = c || "";
    document.documentElement.style.cursor = cur;
    stage.style.cursor = cur;
  };

  // Composite selection box for composite-heavy nodes whose internal elements can extend outside the root rect.
  // This is the REAL bbox (union of all group elements), not a "proxy".
  let compositeSelBoxEl: HTMLDivElement | null = null;
  const ensureCompositeSelBoxEl = () => {
    if (compositeSelBoxEl) return compositeSelBoxEl;
    const d = document.createElement("div");
    d.className = "ip-composite-selection";
    // NOTE: This overlay must live INSIDE `stage` so pointer events bubble to the
    // stage-level editor handlers. If it's attached to `document.body`, parts of a
    // composite bbox that extend outside the stage won't be draggable/hoverable.
    d.style.position = "fixed";
    // IMPORTANT: this overlay must not swallow pointer events meant for composite sub-elements.
    // Handles remain interactive (they set pointer-events: auto).
    d.style.pointerEvents = "none";
    d.style.zIndex = "99997";
    d.style.display = "none";
    d.style.border = "2px solid rgba(110,168,255,0.65)";
    d.style.borderRadius = "6px";
    d.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.35)";
    d.style.transformOrigin = "50% 50%";
    stage.appendChild(d);
    compositeSelBoxEl = d;
    return d;
  };
  const hideCompositeSelBox = () => {
    if (!compositeSelBoxEl) return;
    compositeSelBoxEl.style.display = "none";
  };

  // Composite selection box is a fixed-position overlay, so it must be updated when the viewport/camera changes.
  // Normal nodes don't need this because their handles live inside the node DOM subtree.
  let compositeOverlayRaf: number | null = null;
  const refreshCompositeSelectionBoxOnce = () => {
    if (!compositeSelBoxEl) return;
    if (compositeEditTimerId) return;
    if (getAppMode() !== "edit") return;
    if (selected.size !== 1) return;
    const model = engine.getModel();
    if (!model) return;
    const id = Array.from(selected)[0];
    const node: any = model.nodes.find((n: any) => String(n.id) === String(id));
    if (!node || (node.type !== "timer" && node.type !== "sound")) return;
    const el = engine.getNodeElement(String(id));
    if (!el) return;
    const eff = effectiveNodeRectClient(el, node);
    if (!eff || !(eff.width > 2 && eff.height > 2)) return;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    compositeSelBoxEl.style.display = "block";
    compositeSelBoxEl.style.left = `${eff.left}px`;
    compositeSelBoxEl.style.top = `${eff.top}px`;
    compositeSelBoxEl.style.width = `${eff.width}px`;
    compositeSelBoxEl.style.height = `${eff.height}px`;
    compositeSelBoxEl.style.transform = `rotate(${rotDeg}deg)`;
    compositeSelBoxEl.dataset.anchor = String((node as any)?.transform?.anchor ?? "centerCenter");
    // Keep per-handle cursor rotation in sync (ensureHandles updates cursors based on `el.style.transform`).
    ensureHandles(compositeSelBoxEl);
  };
  const startCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf != null) return;
    const loop = () => {
      compositeOverlayRaf = window.requestAnimationFrame(loop);
      // Only refresh while a composite root is selected in root edit.
      if (!compositeSelBoxEl || compositeSelBoxEl.style.display === "none") return;
      refreshCompositeSelectionBoxOnce();
    };
    compositeOverlayRaf = window.requestAnimationFrame(loop);
  };
  const stopCompositeSelectionBoxRaf = () => {
    if (compositeOverlayRaf == null) return;
    window.cancelAnimationFrame(compositeOverlayRaf);
    compositeOverlayRaf = null;
  };
  window.addEventListener("resize", () => {
    // Ensure the overlay doesn't drift after viewport resizes.
    refreshCompositeSelectionBoxOnce();
  });

  const updateStageCursorFromClientPoint = (clientX: number, clientY: number) => {
    if (getAppMode() !== "edit") {
      stage.style.cursor = "";
      return;
    }
    if (dragMode !== "none") return;
    if (tool !== "select") {
      stage.style.cursor = "";
      return;
    }
    const elAt = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!elAt) {
      stage.style.cursor = "";
      return;
    }
    // If hovering interactive UI chrome, do not show editor cursors (avoid fighting with controls).
    if (elAt.closest(".edit-toolbox") || elAt.closest(".modal") || elAt.closest(".mode-toggle")) {
      stage.style.cursor = "";
      return;
    }
    const anchorEl = elAt.closest<HTMLElement>(".anchor-dot");
    if (anchorEl) {
      stage.style.cursor = "pointer";
      return;
    }
    // Composite/group edit: hovering sub-elements should feel like normal draggable elements.
    // (Handles already set their own cursors.)
    if (compositeEditTimerId) {
      const handleEl = elAt.closest<HTMLElement>(".handle");
      if (!handleEl) {
        const sub = elAt.closest<HTMLElement>(".comp-sub");
        const kind = String(sub?.dataset.kind ?? "");
        if (sub && kind !== "plot-region") {
          stage.style.cursor = "grab";
          return;
        }
      }
    }

    const model = engine.getModel();

    // Pick the smallest node under the cursor (root-mode behavior), but based on the browser's
    // hit-test stack (`elementsFromPoint`) so non-interactive reference boxes never affect picking/cursors.
    function pickSmallestRawNodeIdAtClientPoint(model0: any, x: number, y: number): string | null {
      if (!model0) return null;
      const gid = activeGroupEditId();
      const els = (document.elementsFromPoint?.(x, y) ?? []) as HTMLElement[];
      let best: { id: string; size: number; order: number } | null = null;
      for (let i = 0; i < els.length; i++) {
        const e = els[i] as any;
        const nodeEl = (e?.closest?.(".node") as HTMLElement | null) ?? null;
        if (!nodeEl?.dataset?.nodeId) continue;
        const rawId = String(nodeEl.dataset.nodeId ?? "");
        if (!rawId) continue;
        // Group edit scope: only descendants are interactive; group root is reference.
        if (gid) {
          if (rawId === gid) continue;
          if (!isDescendantOf(rawId, gid, model0)) continue;
        }
        const n0: any = model0.nodes.find((n: any) => String(n.id) === rawId);
        if (!n0) continue;
        // Screen edit scope
        if (screenEditMode) {
          if (String(n0?.space ?? "world") !== "screen") continue;
        } else {
          if (String(n0?.space ?? "world") === "screen") continue;
        }
        const type = String(n0?.type ?? "");
        const r0 = nodeEl.getBoundingClientRect();
        if (!(r0.width > 0.5 && r0.height > 0.5)) continue;
        let size = Math.max(1e-6, r0.width * r0.height);
        if (type === "arrow" || type === "line") {
          const seg = hitTestSegmentHandle(nodeEl, x, y);
          if (!seg) continue;
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
          // Tie: choose the topmost element (earlier in elementsFromPoint list).
          if (cand.order < best.order) best = cand;
        }
      }
      return best?.id ?? null;
    }

    // Prefer showing "grab" when hovering ANY node body, even if not selected.
    if (model) {
      const rawPicked = pickSmallestRawNodeIdAtClientPoint(model, clientX, clientY);
      const id = rawPicked ? resolveSelectableId(rawPicked) : "";
      const nodeEl = id ? engine.getNodeElement(id) : null;
      const { ui: node } = id ? _uiNodeForId(id, model) : { ui: null as any };
      if (node && nodeEl) {
        if (node.type === "arrow" || node.type === "line") {
          const seg = hitTestSegmentHandle(nodeEl, clientX, clientY);
          stage.style.cursor = seg ? "grab" : "";
          return;
        }

        // If hovering the selected node, keep handle cursors + interior grab.
        if (selected.size === 1 && selected.has(id)) {
          const hnd = hitTestTransformHandleForNode(nodeEl, node, clientX, clientY);
          if (hnd) {
            stage.style.cursor = cursorForHandleWithRotation(hnd, Number(node?.transform?.rotationDeg ?? 0));
            return;
          }
          stage.style.cursor = isPointInsideNodeInteriorForNode(nodeEl, node, clientX, clientY) ? "grab" : "";
          return;
        }

        // Unselected node: show grab anywhere inside its rect.
        const eff = effectiveNodeRectClient(nodeEl, node);
        if (eff) {
          stage.style.cursor = isPointInRotatedRectClient(eff, Number(node?.transform?.rotationDeg ?? 0), clientX, clientY) ? "grab" : "";
        } else {
          const { lx, ly, hw, hh } = localPtForRect(nodeEl.getBoundingClientRect(), Number(node?.transform?.rotationDeg ?? 0), clientX, clientY);
          stage.style.cursor = Math.abs(lx) <= hw && Math.abs(ly) <= hh ? "grab" : "";
        }
        return;
      }
    }

    // Fallback: if you're hovering OUTSIDE the selected node but within the 20px handle band,
    // still show handle cursors.
    if (selected.size === 1 && model) {
      const id = Array.from(selected)[0];
      const { ui: node } = _uiNodeForId(id, model);
      const nodeEl = engine.getNodeElement(id);
      if (node && nodeEl) {
        if (node.type === "arrow" || node.type === "line") {
          const seg = hitTestSegmentHandle(nodeEl, clientX, clientY);
          stage.style.cursor = seg ? "grab" : "";
          return;
        }
        const hnd = hitTestTransformHandleForNode(nodeEl, node, clientX, clientY);
        if (hnd) {
          stage.style.cursor = cursorForHandleWithRotation(hnd, Number(node?.transform?.rotationDeg ?? 0));
          return;
        }
        // If inside the effective composite rect (even if not over the inner `.node`), show grab.
        const eff = effectiveNodeRectClient(nodeEl, node);
        if (eff) {
          stage.style.cursor = isPointInRotatedRectClient(eff, Number(node?.transform?.rotationDeg ?? 0), clientX, clientY) ? "grab" : "";
          return;
        }
        stage.style.cursor = "";
        return;
      }
    }

    stage.style.cursor = "";
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

  const pickCompositeRootAtClientPoint = (model: any, x: number, y: number) => {
    let best: { id: string; kind: "timer" | "sound" | "choices"; area: number } | null = null;
    for (const n of model?.nodes ?? []) {
      const kind = String(n?.type ?? "");
      if (kind !== "timer" && kind !== "sound" && kind !== "choices") continue;
      const el = engine.getNodeElement(String(n.id));
      if (!el) continue;
      const rotDeg = Number(n?.transform?.rotationDeg ?? 0) || 0;
      const eff = kind === "choices" ? null : effectiveNodeRectClient(el, n);
      const r = eff ?? (el.getBoundingClientRect() as any);
      const rc: any = { left: r.left, top: r.top, right: r.right ?? r.left + r.width, bottom: r.bottom ?? r.top + r.height, width: r.width, height: r.height };
      if (!isPointInRotatedRectClient(rc, rotDeg, x, y)) continue;
      const area = Math.max(1, rc.width * rc.height);
      if (!best || area < best.area) best = { id: String(n.id), kind: kind as any, area };
    }
    return best;
  };

  function collectCompositeRectsClient(type: "timer" | "sound", nodeEl: HTMLElement, layer: HTMLElement): DOMRect[] {
    const rects: DOMRect[] = [];
    rects.push(nodeEl.getBoundingClientRect());

    // Composite sub-elements rendered in the overlay layer.
    for (const sub of Array.from(layer.querySelectorAll<HTMLElement>(".comp-sub"))) {
    // Ignore plot helper region; it must not affect bbox/hit-testing.
    const subId = String(sub.dataset.subId ?? "");
    const kind = String(sub.dataset.kind ?? "");
    if (
      kind === "plot-region" ||
      subId === "plot" ||
      sub.classList.contains("timer-sub-plot") ||
      sub.classList.contains("sound-sub-plot")
    ) {
      continue;
    }
      const sr = sub.getBoundingClientRect();
      if (!(sr.width > 0.5 && sr.height > 0.5)) continue;
      rects.push(sr);
      for (const btn of Array.from(sub.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
        const br = btn.getBoundingClientRect();
        if (!(br.width > 0.5 && br.height > 0.5)) continue;
        rects.push(br);
      }
    }

    // Legacy header bar (present when composite buttons are not used).
    const headerSel = type === "timer" ? ".timer-header" : ".sound-header";
    const headerEl = nodeEl.querySelector<HTMLElement>(headerSel);
    if (headerEl) {
      const hr = headerEl.getBoundingClientRect();
      if (hr.width > 0.5 && hr.height > 0.5) rects.push(hr);
      for (const btn of Array.from(headerEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
        const br = btn.getBoundingClientRect();
        if (!(br.width > 0.5 && br.height > 0.5)) continue;
        rects.push(br);
      }
    }

    // Fallback: include any control buttons inside the root node (covers future layout tweaks).
    for (const btn of Array.from(nodeEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const br = btn.getBoundingClientRect();
      if (!(br.width > 0.5 && br.height > 0.5)) continue;
      rects.push(br);
    }

    return rects;
  }

  function orientedUnionRectClient(nodeEl: HTMLElement, rotDeg: number, rects: DOMRect[]) {
    const rr = nodeEl.getBoundingClientRect();
    const cx0 = rr.left + rr.width / 2;
    const cy0 = rr.top + rr.height / 2;
    const a = (-rotDeg * Math.PI) / 180; // client -> local
    const cos = Math.cos(a);
    const sin = Math.sin(a);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const addPt = (x: number, y: number) => {
      const dx = x - cx0;
      const dy = y - cy0;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      minX = Math.min(minX, lx);
      minY = Math.min(minY, ly);
      maxX = Math.max(maxX, lx);
      maxY = Math.max(maxY, ly);
    };

    for (const r of rects) {
      addPt(r.left, r.top);
      addPt(r.right, r.top);
      addPt(r.right, r.bottom);
      addPt(r.left, r.bottom);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return { left: rr.left, top: rr.top, width: rr.width, height: rr.height, right: rr.right, bottom: rr.bottom };
    }

    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const cxl = (minX + maxX) / 2;
    const cyl = (minY + maxY) / 2;

    // local -> client
    const af = (rotDeg * Math.PI) / 180;
    const cosf = Math.cos(af);
    const sinf = Math.sin(af);
    const dcx = cxl * cosf - cyl * sinf;
    const dcy = cxl * sinf + cyl * cosf;
    const cx = cx0 + dcx;
    const cy = cy0 + dcy;

    const left = cx - w / 2;
    const top = cy - h / 2;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  }

  const effectiveNodeRectClient = (nodeEl: HTMLElement, node: any) => {
    // For timer/sound, include all internal comp-sub elements that may extend outside the root.
    // For other nodes, return null (use nodeEl rect).
    const type = String(node?.type ?? "");
    if (type !== "timer" && type !== "sound") return null;
    const rootId = String(node?.id ?? nodeEl.dataset.nodeId ?? "");
    if (!rootId) return null;
    const layer =
      type === "timer"
        ? ensureTimerCompositeLayer(engine, rootId)
        : ensureSoundCompositeLayer(engine, rootId);
    if (!layer) return null;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const rects = collectCompositeRectsClient(type as any, nodeEl, layer);
    const u = orientedUnionRectClient(nodeEl, rotDeg, rects);
    return { ...u, layer };
  };

  const isPointInsideNodeInteriorForNode = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const R = 20;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const eff = effectiveNodeRectClient(nodeEl, node);
    const rect = eff ?? nodeEl.getBoundingClientRect();
    const { lx, ly, hw, hh } = localPtForRect(rect, rotDeg, clientX, clientY);
    return Math.abs(lx) <= hw - R && Math.abs(ly) <= hh - R;
  };

  const hitTestTransformHandleForNode = (nodeEl: HTMLElement, node: any, clientX: number, clientY: number) => {
    const eff = effectiveNodeRectClient(nodeEl, node);
    if (!eff) return hitTestTransformHandle(nodeEl, node, clientX, clientY);
    // Re-run the same math as hitTestTransformHandle but against the effective rect size/center.
    const R = 20;
    const rotDeg = Number(node?.transform?.rotationDeg ?? 0) || 0;
    const { lx, ly, hw, hh } = localPtForRect(eff, rotDeg, clientX, clientY);
    type Cand = { handle: string; d: number };
    const cands: Cand[] = [];
    const addCorner = (handle: string, x: number, y: number) => {
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
      if (dt <= R && lx >= xMin && lx <= xMax) cands.push({ handle: "n", d: dt });
      const db = Math.abs(ly - hh);
      if (db <= R && lx >= xMin && lx <= xMax) cands.push({ handle: "s", d: db });
    }
    if (yMax >= yMin) {
      const dl = Math.abs(lx - (-hw));
      if (dl <= R && ly >= yMin && ly <= yMax) cands.push({ handle: "w", d: dl });
      const dr = Math.abs(lx - hw);
      if (dr <= R && ly >= yMin && ly <= yMax) cands.push({ handle: "e", d: dr });
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
    const { lx, ly, hw, hh } = localPtForNode(nodeEl, node, clientX, clientY);

    type Cand = { handle: string; d: number };
    const cands: Cand[] = [];

    const addCorner = (handle: string, x: number, y: number) => {
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
      if (dt <= R && lx >= xMin && lx <= xMax) cands.push({ handle: "n", d: dt });
      const db = Math.abs(ly - hh);
      if (db <= R && lx >= xMin && lx <= xMax) cands.push({ handle: "s", d: db });
    }
    if (yMax >= yMin) {
      const dl = Math.abs(lx - (-hw));
      if (dl <= R && ly >= yMin && ly <= yMax) cands.push({ handle: "w", d: dl });
      const dr = Math.abs(lx - hw);
      if (dr <= R && ly >= yMin && ly <= yMax) cands.push({ handle: "e", d: dr });
    }

    if (cands.length === 0) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0].handle;
  };

  // Capture-phase intent handler: if the pointer is over a selected node's interaction region,
  // force that action and prevent background pan handlers from starting.
  stage.addEventListener(
    "pointerdown",
    (ev) => {
      if (getAppMode() !== "edit") return;
      if (tool !== "select") return;
      if (ev.button !== 0) return;
      if (dragMode !== "none") return;

      const anchorEl = (ev.target as HTMLElement).closest?.(".anchor-dot");
      if (anchorEl) return; // let anchor click logic handle it

      // Critical: while editing timer/sound composites, do NOT let the normal node selection/drag handler run.
      // Otherwise it can select/drag the composite root in capture phase and stop propagation,
      // preventing sub-element selection (which looks like "clicking a label selects the full rect").
      if (compositeEditTimerId && (compositeEditKind === "timer" || compositeEditKind === "sound")) {
        return;
      }

      const model = engine.getModel();
      if (!model) return;

      // Prefer the node directly under the pointer (supports "mousedown selects + drags" for unselected text).
      let hoveredNodeEl = (ev.target as HTMLElement).closest<HTMLElement>(".node");
      let hoveredRawId = hoveredNodeEl?.dataset.nodeId ?? "";
      let hoveredId = hoveredRawId ? resolveSelectableId(hoveredRawId) : "";
      let hasHovered = !!hoveredId;

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
      if (!compositeEditTimerId && (node.type === "timer" || node.type === "sound" || node.type === "choices")) {
        const now = performance.now();
        const prev = lastCompositeClick;
        const dt = prev && prev.id === activeId ? now - prev.tMs : Infinity;
        const d = prev && prev.id === activeId ? Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) : Infinity;
        const isDouble = dt <= 350 && d <= 6;
        lastCompositeClick = { id: activeId, tMs: now, x: ev.clientX, y: ev.clientY };

        const dbg = ipDebugEnabled("ip_debug_dblclick");
        if (dbg) {
          // eslint-disable-next-line no-console
          console.log("[ip][dblclick] pointerdown composite", { id: activeId, type: node.type, dt, d, isDouble });
        }

        if (isDouble) {
          lastCompositeClick = null;
          if (node.type === "timer") enterTimerCompositeEdit(activeId);
          else if (node.type === "sound") enterSoundCompositeEdit(activeId);
          else enterChoicesCompositeEdit(activeId);
          ev.preventDefault();
          (ev as any).stopImmediatePropagation?.();
          return;
        }
      }

      // Arrow/line: only act if we're in the segment hit region.
      if (node.type === "arrow" || node.type === "line") {
        const seg = hitTestSegmentHandle(nodeEl, ev.clientX, ev.clientY);
        if (!seg) return;
        // Start drag immediately (blocks pan).
        startSnapshot = cloneModel(model);
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

      // Composite roots: block pan, but DO NOT start drag immediately (lets native dblclick fire).
      if ((node.type === "timer" || node.type === "sound") && !compositeEditTimerId) {
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
      startNodesById = { [activeId]: JSON.parse(JSON.stringify(node)) };
      start = { x: ev.clientX, y: ev.clientY };

      if (hnd) {
        activeHandle = hnd;
        dragMode = activeHandle.startsWith("rot-") ? "rotate" : "resize";
        setBodyCursor(cursorForHandleWithRotation(activeHandle, Number(node?.transform?.rotationDeg ?? 0)));
        if (dragMode === "rotate") {
          const eff = effectiveNodeRectClient(nodeEl, node);
          const r = (eff as any) ?? nodeEl.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          startAngleRad = Math.atan2(ev.clientY - cy, ev.clientX - cx);
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
    },
    { capture: true }
  );

  // If a composite root is pending drag, wait until the user actually moves before starting drag.
  window.addEventListener(
    "pointermove",
    (ev) => {
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
          const eff = effectiveNodeRectClient(nodeEl, node);
          const r = (eff as any) ?? nodeEl.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          startAngleRad = Math.atan2(start.y - cy, start.x - cx);
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
    },
    { capture: true }
  );

  const finishDrag = async () => {
    // Always clear pending composite drag.
    pendingCompositeDrag = null;
    junctionDrag = null;
    graphDrag = null;
    if (dragMode === "none" && !startSnapshot) return;
    dragMode = "none";
    activeHandle = null;
    setBodyCursor("");
    startNodesById = null;
    const before = startSnapshot;
    startSnapshot = null;
    await commit(before);
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
      if (n?.type === "timer" || n?.type === "sound") applySelection();
      else if (el) ensureHandles(el);
    }
  };

  // Hover cursor based on hit-test (so we don't depend on DOM overlap ordering).
  stage.addEventListener(
    "pointermove",
    (ev) => {
      if (getAppMode() !== "edit") return;
      if (dragMode !== "none") return;
      if (tool !== "select") return;
      updateStageCursorFromClientPoint(ev.clientX, ev.clientY);
    },
    { passive: true }
  );

  const applySelection = () => {
    const model = engine.getModel();
    if (!model) return;
    const canShowTransformUi = getAppMode() === "edit";
    // Default: hide composite selection unless a composite root needs it.
    hideCompositeSelBox();
    stopCompositeSelectionBoxRaf();
    for (const n of model.nodes) {
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      // Reset any per-node inline outline overrides (we'll re-apply selectively below).
      el.style.outline = "";
      el.style.outlineOffset = "";
      const isSel = canShowTransformUi && selected.has(n.id);
      el.classList.toggle("is-selected", isSel);
      if (!canShowTransformUi) {
        el.querySelector(".handles")?.remove();
        continue;
      }
      if (isSel && selected.size === 1) {
        // While editing a composite, timer/sound should edit sub-elements only (no root handles).
        if ((compositeEditKind === "timer" || compositeEditKind === "sound") && compositeEditTimerId && n.id === compositeEditTimerId)
          el.querySelector(".handles")?.remove();
        else {
          // Composite roots: draw selection using the effective bbox so buttons/labels are included.
          if (n.type === "timer" || n.type === "sound") {
            const eff = effectiveNodeRectClient(el, n);
            if (eff && eff.width > 2 && eff.height > 2) {
              const box = ensureCompositeSelBoxEl();
              box.style.display = "block";
              box.style.left = `${eff.left}px`;
              box.style.top = `${eff.top}px`;
              box.style.width = `${eff.width}px`;
              box.style.height = `${eff.height}px`;
              // Match node rotation (this drives both the box and its handles).
              const rotDeg = Number((n as any)?.transform?.rotationDeg ?? 0) || 0;
              box.style.transform = `rotate(${rotDeg}deg)`;
              box.dataset.anchor = String((n as any)?.transform?.anchor ?? "centerCenter");
              // IMPORTANT: this composite selection box is the ONLY visible selection box for timer/sound.
              // Hide the default node outline and remove its handles (we render handles on the composite box).
              el.style.outline = "none";
              el.querySelector(".handles")?.remove();
              ensureHandles(box);
              // Keep it synced during pan/zoom/viewport resize.
              startCompositeSelectionBoxRaf();
            }
            // (No node handles for timer/sound; handled by composite selection box.)
          } else {
            ensureHandles(el);
          }
        }
      }
      if (!isSel || selected.size !== 1) el.querySelector(".handles")?.remove();
    }
  };

  const clearSelection = () => {
    selected.clear();
    applySelection();
    // Also clear any leftover composite sub-element selection chrome.
    // (These can be selected via group edit mode and are not part of the root `selected` set.)
    for (const el of Array.from(stage.querySelectorAll<HTMLElement>(".comp-sub.is-selected, .timer-sub.is-selected"))) {
      el.classList.remove("is-selected");
      el.querySelector(".handles")?.remove();
    }
  };

  const applyGroupEditDimming = () => {
    const model = engine.getModel();
    const gid = activeGroupEditId();
    // Clear previous dimming.
    for (const e of groupHiddenEls) e.classList.remove("ip-dim-node");
    groupHiddenEls = [];
    if (groupRefEl) groupRefEl.classList.remove("ip-group-ref");
    groupRefEl = null;
    if (!gid || !model) return;
    for (const n of model.nodes as any[]) {
      const id = String(n?.id ?? "");
      if (!id) continue;
      const el = engine.getNodeElement(id);
      if (!el) continue;
      if (id === gid) {
        // The group root is a REFERENCE element in group edit:
        // - keep it visible (faint)
        // - never allow it to capture pointer events / selection
        el.classList.remove("ip-dim-node");
        el.classList.add("ip-group-ref");
        groupRefEl = el;
        continue;
      }
      const inSubtree = isDescendantOf(id, gid, model);
      if (inSubtree) {
        el.classList.remove("ip-dim-node");
      } else {
        el.classList.add("ip-dim-node");
        groupHiddenEls.push(el);
      }
    }
  };

  enterGroupEdit = (groupId: string) => {
    if (getAppMode() !== "edit") return;
    const model = engine.getModel();
    const gid = String(groupId ?? "");
    if (!gid || !model) return;
    const node: any = model.nodes.find((n: any) => String(n.id) === gid);
    if (!node || String(node.type) !== "group") return;
    // Avoid conflicting isolate modes.
    exitScreenEdit();
    (window as any).__ip_exitCompositeEdit?.();
    if (groupEditStack[groupEditStack.length - 1] !== gid) groupEditStack.push(gid);
    clearSelection();
    applyGroupEditDimming();
    // Refresh hover cursor immediately (so it matches root mode without needing a mouse move).
    {
      const mx = (window as any).__ip_lastMouseX;
      const my = (window as any).__ip_lastMouseY;
      if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
    }
    const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (modeBtn) modeBtn.textContent = "Exit group edit";
    (window as any).__ip_exitGroupEdit = exitGroupEditLevel;
  };

  exitGroupEditLevel = () => {
    if (groupEditStack.length === 0) return;
    groupEditStack.pop();
    clearSelection();
    applyGroupEditDimming();
    if (groupEditStack.length === 0) {
      for (const e of groupHiddenEls) e.classList.remove("ip-dim-node");
      groupHiddenEls = [];
      if (groupRefEl) groupRefEl.classList.remove("ip-group-ref");
      groupRefEl = null;
      const wrap = document.querySelector<HTMLElement>(".mode-toggle");
      const mode = (wrap?.dataset.mode ?? "edit").toLowerCase();
      const btn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
      if (btn) btn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
      delete (window as any).__ip_exitGroupEdit;
    }
    // Refresh hover cursor immediately after exit.
    {
      const mx = (window as any).__ip_lastMouseX;
      const my = (window as any).__ip_lastMouseY;
      if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
    }
  };

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

  const commit = async (before: PresentationModel | null) => {
    if (!before) return;
    const after = engine.getModel();
    if (!after) return;
    undoStack.push(before);
    redoStack.length = 0;
    await saveModel(after);
  };

  const _tableCellFlatIdx0 = (rows: any[][], row: number, col: number) => {
    let idx = 0;
    for (let r = 0; r < row; r++) idx += (rows?.[r]?.length ?? 0);
    return idx + col;
  };

  const _tableColCount = (rows: any[][]) => {
    const headerLen = Array.isArray(rows?.[0]) ? rows[0].length : 0;
    // Fallback: max row length
    const maxLen = Math.max(0, ...((rows ?? []) as any[]).map((r) => (Array.isArray(r) ? r.length : 0)));
    return Math.max(1, headerLen, maxLen);
  };

  const _ensureTableCellExists = (tableId: string, row: number, col: number) => {
    const model = engine.getModel();
    if (!model) return;
    const node: any = model.nodes.find((n: any) => String(n.id) === tableId);
    if (!node) return;
    const rows = (node.rows ?? []).map((r: any) => (Array.isArray(r) ? [...r] : [])) as string[][];
    const colCount = _tableColCount(rows as any);
    while (rows.length <= row) rows.push(new Array(colCount).fill(""));
    while ((rows[row]?.length ?? 0) < colCount) rows[row].push("");
    // Ensure at least up to `col`.
    while ((rows[row]?.length ?? 0) <= col) rows[row].push("");
    engine.updateNode(tableId, { rows } as any);
  };

  const _findTableCellTd = (tableId: string, row: number, col: number) => {
    const nodeEl = engine.getNodeElement(tableId);
    const table = nodeEl?.querySelector("table") as HTMLTableElement | null;
    const tr = table?.rows?.[row] ?? null;
    const td = (tr?.cells?.[col] as HTMLTableCellElement | undefined) ?? null;
    if (!td) return null;
    if (!td.classList.contains("table-cell")) td.classList.add("table-cell");
    return td;
  };

  const _gotoNextTableCell = async (tableId: string, row: number, col: number) => {
    const model = engine.getModel();
    const node: any = model?.nodes?.find?.((n: any) => String(n.id) === tableId);
    const rows = (node?.rows ?? []) as any[][];
    const colCount = _tableColCount(rows as any);
    let nr = row;
    let nc = col + 1;
    if (nc >= colCount) {
      nr = row + 1;
      nc = 0;
    }
    // Extend table if needed (wrap beyond last row).
    _ensureTableCellExists(tableId, nr, nc);
    // Allow engine to rebuild DOM before locating cell.
    await new Promise<void>((r) => setTimeout(() => r(), 0));
    const td2 = _findTableCellTd(tableId, nr, nc);
    if (td2) await _beginTableCellEdit(td2, tableId, nr, nc);
  };

  const _endActiveTableEdit = async (opts?: { commit?: boolean }) => {
    const a = __activeTableEdit;
    if (!a) return;
    __activeTableEdit = null;
    const td = a.td;
    const val = String(a.input.value ?? "");
    const shouldCommit = opts?.commit !== false;
    // Remove input first (engine updates may rebuild DOM).
    try {
      a.input.remove();
    } catch {}
    if (!shouldCommit) {
      (td.dataset as any).raw = a.beforeValue;
      renderTextToElement(td, a.beforeValue);
      return;
    }
    if (val === a.beforeValue) {
      (td.dataset as any).raw = val;
      renderTextToElement(td, val);
      return;
    }

    const model = engine.getModel();
    if (!model) return;
    const node: any = model.nodes.find((n: any) => String(n.id) === a.tableId);
    if (!node) return;

    const before = getAppMode() === "edit" ? cloneModel(model) : null;
    const rows = (node.rows ?? []).map((r: any) => (Array.isArray(r) ? [...r] : [])) as string[][];
    while (rows.length <= a.row) rows.push([]);
    while ((rows[a.row]?.length ?? 0) <= a.col) rows[a.row].push("");
    rows[a.row][a.col] = val;

    engine.updateNode(a.tableId, { rows } as any);
    // Re-hydrate math in table cells (engine sets data-raw on td).
    const after = engine.getModel();
    if (after) hydrateTextMath(engine, after);

    // Expose state for consumers.
    (window as any).__ip_tableData = (window as any).__ip_tableData ?? {};
    (window as any).__ip_tableData[a.tableId] = rows;

    // Dispatch a generic change event (listen by id) and include both flat and 2D indices.
    const cellIdx0 = _tableCellFlatIdx0(rows as any, a.row, a.col);
    const detail = { id: a.tableId, row: a.row, col: a.col, cellIdx: cellIdx0, index: cellIdx0 + 1, value: val };
    window.dispatchEvent(new CustomEvent(`${a.tableId}-change`, { detail }));
    // Persist only in edit mode.
    await commit(before);
  };

  const _beginTableCellEdit = async (td: HTMLTableCellElement, tableId: string, row: number, col: number) => {
    // Finish any previous edit first (commit).
    await _endActiveTableEdit({ commit: true });

    const raw = String((td.dataset as any).raw ?? td.textContent ?? "");
    td.innerHTML = "";

    const input = document.createElement("input");
    input.type = "text";
    input.value = raw;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.className = "ip-table-input";
    input.style.width = "100%";
    input.style.height = "100%";
    input.style.border = "none";
    input.style.outline = "none";
    input.style.background = "transparent";
    input.style.color = "rgba(255,255,255,0.95)";
    input.style.font = "inherit";
    input.style.padding = "0 6px";
    // Let selection/caret work even in live mode.
    (td.style as any).userSelect = "text";

    td.appendChild(input);
    __activeTableEdit = { tableId, row, col, td, input, beforeValue: raw };

    // Focus on next tick to ensure DOM is ready.
    queueMicrotask(() => {
      try {
        input.focus();
        input.select();
      } catch {}
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const cur = __activeTableEdit;
        if (!cur) return;
        void (async () => {
          const { tableId, row, col } = cur;
          await _endActiveTableEdit({ commit: true });
          await _gotoNextTableCell(tableId, row, col);
        })();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        void _endActiveTableEdit({ commit: false });
        return;
      }
    });
    input.addEventListener("blur", () => void _endActiveTableEdit({ commit: true }));
  };

  const deleteSelection = async () => {
    const model = engine.getModel();
    if (!model) return;
    if (selected.size === 0) return;
    const before = cloneModel(model);

    const del = new Set(selected);
    model.nodes = model.nodes.filter((n) => !del.has(n.id));
    for (const v of model.views) v.show = v.show.filter((id) => !del.has(id));
    // IMPORTANT: always pass a fresh object; some engine internals assume model identity changes.
    engine.setModel(cloneModel(model));
    await hydrateQrImages(engine, model);
    hydrateTextMath(engine, model);
    selected.clear();
    applySelection();
    await commit(before);
  };

  const openEditorModal = async (nodeId: string) => {
    const model = engine.getModel();
    if (!model) return;
    const node = model.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const before = cloneModel(model);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    backdrop.appendChild(modal);

    let activeTab: "data" | "geometry" | "animations" = "data";

    const header = document.createElement("div");
    header.className = "modal-header";
    header.innerHTML = `<div class="modal-title">Edit: ${node.type} (${node.id})</div>`;

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const tabData = document.createElement("button");
    tabData.className = "tab is-active";
    tabData.type = "button";
    tabData.textContent = "Data";
    const tabGeom = document.createElement("button");
    tabGeom.className = "tab";
    tabGeom.type = "button";
    tabGeom.textContent = "Geometry";
    const tabAnim = document.createElement("button");
    tabAnim.className = "tab";
    tabAnim.type = "button";
    tabAnim.textContent = "Animations";
    tabs.append(tabData, tabGeom, tabAnim);
    header.appendChild(tabs);

    const body = document.createElement("div");
    body.className = "modal-body";

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const btnCancel = document.createElement("button");
    btnCancel.className = "btn";
    btnCancel.type = "button";
    btnCancel.textContent = "Cancel";
    const btnSave = document.createElement("button");
    btnSave.className = "btn primary";
    btnSave.type = "button";
    btnSave.textContent = "Save";
    footer.append(btnCancel, btnSave);

    modal.append(header, body, footer);
    document.body.appendChild(backdrop);

    const state: any = JSON.parse(JSON.stringify(node));

    const render = () => {
      body.innerHTML = "";
      tabData.classList.toggle("is-active", activeTab === "data");
      tabGeom.classList.toggle("is-active", activeTab === "geometry");
      tabAnim.classList.toggle("is-active", activeTab === "animations");

      if (activeTab === "data") {
        // Common styling fields (all node types)
        const common = document.createElement("div");
        common.style.display = "grid";
        common.style.gridTemplateColumns = "repeat(2, 1fr)";
        common.style.gap = "12px";

        const mkText = (label: string, key: string, placeholder = "") => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "text";
          i.placeholder = placeholder;
          i.value = String(state[key] ?? "");
          i.addEventListener("input", () => (state[key] = i.value));
          f.appendChild(i);
          return f;
        };
        const mkNum = (label: string, key: string, opts?: { step?: string; min?: string; max?: string }) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "number";
          if (opts?.step) i.step = opts.step;
          if (opts?.min) i.min = opts.min;
          if (opts?.max) i.max = opts.max;
          i.value = state[key] == null || state[key] === "" ? "" : String(state[key]);
          i.addEventListener("input", () => {
            const v = i.value.trim();
            if (!v) delete state[key];
            else state[key] = Number(v);
          });
          f.appendChild(i);
          return f;
        };
        const mkBool = (label: string, key: string) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const wrap = document.createElement("div");
          wrap.style.display = "flex";
          wrap.style.alignItems = "center";
          wrap.style.gap = "10px";
          const i = document.createElement("input");
          i.type = "checkbox";
          i.checked = state[key] !== false;
          i.addEventListener("change", () => (state[key] = i.checked));
          const txt = document.createElement("div");
          txt.className = "preview";
          txt.style.padding = "8px 10px";
          txt.textContent = i.checked ? "on" : "off";
          i.addEventListener("change", () => (txt.textContent = i.checked ? "on" : "off"));
          wrap.append(i, txt);
          f.appendChild(wrap);
          return f;
        };

        common.append(
          mkText("bgColor", "bgColor", "e.g. #ff00ff / rgba(...) / 'red'"),
          mkNum("bgAlpha", "bgAlpha", { step: "0.05", min: "0", max: "1" }),
          mkNum("borderRadius", "borderRadius", { step: "1", min: "0" }),
          mkNum("opacity", "opacity", { step: "0.05", min: "0", max: "1" }),
          mkNum("zIndex", "zIndex", { step: "1" }),
          mkBool("visible", "visible")
        );
        body.appendChild(common);

        if (state.type === "text") {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>Text (use $$...$$ for KaTeX)</label>`;
          const ta = document.createElement("textarea");
          ta.value = state.text ?? "";
          ta.style.fontSize = "18px";
          ta.style.lineHeight = "1.35";
          const prev = document.createElement("div");
          prev.className = "preview";
          prev.innerHTML = renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
          ta.addEventListener("input", () => {
            state.text = ta.value;
            prev.innerHTML = renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
          });
          f.append(ta, prev);
          body.appendChild(f);
          return;
        }

        if (state.type === "qr") {
          const info = document.createElement("div");
          info.className = "field";
          info.innerHTML = `<label>Join QR</label><div class="preview">Default behavior: /join (public tunnel URL is injected at runtime).</div>`;
          body.append(info);
          body.append(mkText("url", "url", "/join"));
          return;
        }

        if (state.type === "image") {
          body.append(mkText("src", "src", "/media/<name>.png"));
          return;
        }

        if (state.type === "htmlFrame") {
          body.append(mkText("src", "src", "https://..."));
          return;
        }

        if (state.type === "video") {
          body.append(mkText("src", "src", "YouTube URL or /media/<file>.mp4 (or just <file>.mp4)"));
          body.append(mkText("thumbnail", "thumbnail", 'Optional: "MM:SS" / "HH:MM:SS" / "/media/thumb.jpg" / "https://..."'));
          return;
        }

        if (state.type === "bullets") {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>Bullet items (one per line)</label>`;
          const ta = document.createElement("textarea");
          ta.value = (state.items ?? []).join("\n");
          ta.style.fontSize = "18px";
          ta.style.lineHeight = "1.35";

          const styleWrap = document.createElement("div");
          styleWrap.className = "field";
          styleWrap.innerHTML = `<label>Marker style</label>`;
          const sel = document.createElement("select");
          ["A", "a", "1", "X", "i", ".", "-"].forEach((opt) => {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            if ((state as any).bullets === opt) o.selected = true;
            sel.appendChild(o);
          });

          ta.addEventListener("input", () => {
            state.items = ta.value.split(/\r?\n/);
          });
          sel.addEventListener("change", () => {
            (state as any).bullets = sel.value;
          });

          styleWrap.appendChild(sel);
          const fontWrap = document.createElement("div");
          fontWrap.className = "field";
          fontWrap.innerHTML = `<label>fontPx</label>`;
          const fontI = document.createElement("input");
          fontI.type = "number";
          fontI.step = "1";
          fontI.value = state.fontPx == null ? "" : String(state.fontPx);
          fontI.addEventListener("input", () => {
            const v = fontI.value.trim();
            if (!v) delete state.fontPx;
            else state.fontPx = Number(v);
          });
          fontWrap.append(fontI);

          f.append(ta, styleWrap, fontWrap);
          body.append(f);
          return;
        }

        if (state.type === "table") {
          const delimF = document.createElement("div");
          delimF.className = "field";
          delimF.innerHTML = `<label>delimiter</label>`;
          const delimI = document.createElement("input");
          delimI.type = "text";
          delimI.value = String(state.delimiter ?? ";");
          delimI.addEventListener("input", () => (state.delimiter = delimI.value || ";"));
          delimF.append(delimI);

          const rowsF = document.createElement("div");
          rowsF.className = "field";
          rowsF.innerHTML = `<label>rows (one row per line)</label>`;
          const ta = document.createElement("textarea");
          ta.value = (state.rows ?? []).map((r: any[]) => (r ?? []).join(String(state.delimiter ?? ";"))).join("\n");
          ta.style.fontSize = "16px";
          ta.style.lineHeight = "1.35";
          ta.addEventListener("input", () => {
            const delim = String(state.delimiter ?? ";") || ";";
            state.rows = ta.value
              .split(/\r?\n/)
              .filter((ln) => ln.length > 0)
              .map((ln) => ln.split(delim).map((c) => c.trim()));
          });
          rowsF.append(ta);
          body.append(delimF, rowsF);
          return;
        }

        if (state.type === "graph") {
          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";
          const mkText = (label: string, key: string, placeholder = "") => {
            const f = document.createElement("div");
            f.className = "field";
            f.innerHTML = `<label>${label}</label>`;
            const i = document.createElement("input");
            i.type = "text";
            i.placeholder = placeholder;
            i.value = String((state as any)[key] ?? "");
            i.addEventListener("input", () => ((state as any)[key] = i.value));
            f.appendChild(i);
            return f;
          };
          const mkSel = (label: string, key: string, opts: string[]) => {
            const f = document.createElement("div");
            f.className = "field";
            f.innerHTML = `<label>${label}</label>`;
            const s = document.createElement("select");
            for (const o0 of opts) {
              const o = document.createElement("option");
              o.value = o0;
              o.textContent = o0;
              s.appendChild(o);
            }
            s.value = String((state as any)[key] ?? opts[0]);
            s.addEventListener("change", () => ((state as any)[key] = s.value));
            f.appendChild(s);
            return f;
          };
          grid.append(
            mkText("color", "color", "white"),
            mkText("xSource", "xSource", "t_table[0]"),
            mkText("ySource", "ySource", "t_table[1]"),
            mkText("xLabel", "xLabel", "x"),
            mkText("yLabel", "yLabel", "y"),
            mkSel("grid", "grid", ["on", "off"])
          );
          body.append(grid);
          return;
        }

        if (state.type === "timer") {
          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";
          grid.append(
            mkBool("showTime", "showTime"),
            mkText("barColor", "barColor", "orange"),
            mkText("lineColor", "lineColor", "green"),
            mkNum("lineWidth", "lineWidth", { step: "0.5", min: "0" }),
            mkNum("minS", "minS", { step: "0.1" }),
            mkNum("maxS", "maxS", { step: "0.1" }),
            mkNum("binSizeS", "binSizeS", { step: "0.1", min: "0" })
          );
          const statF = document.createElement("div");
          statF.className = "field";
          statF.innerHTML = `<label>stat</label>`;
          const statS = document.createElement("select");
          for (const v of ["gaussian"]) {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = v;
            statS.appendChild(o);
          }
          statS.value = String(state.stat ?? "gaussian");
          statS.addEventListener("change", () => (state.stat = statS.value));
          statF.append(statS);
          body.append(grid, statF);
          return;
        }

        if (state.type === "arrow" || (state as any).type === "line") {
          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";
          grid.append(
            mkText("color", "color", "white"),
            mkNum("width", "width", { step: "0.5", min: "1" })
          );
          body.append(grid);
          return;
        }

        if (state.type === "choices") {
          const qF = document.createElement("div");
          qF.className = "field";
          qF.innerHTML = `<label>Question</label>`;
          const taQ = document.createElement("textarea");
          taQ.value = String(state.question ?? "");
          taQ.style.fontSize = "18px";
          taQ.style.lineHeight = "1.35";
          taQ.addEventListener("input", () => (state.question = taQ.value));
          qF.append(taQ);

          const grid = document.createElement("div");
          grid.style.display = "grid";
          grid.style.gridTemplateColumns = "repeat(2, 1fr)";
          grid.style.gap = "12px";

          const bulletsF = document.createElement("div");
          bulletsF.className = "field";
          bulletsF.innerHTML = `<label>bullets</label>`;
          const bulletsS = document.createElement("select");
          for (const b of ["A", "a", "1", "I"]) {
            const o = document.createElement("option");
            o.value = b;
            o.textContent = b;
            bulletsS.appendChild(o);
          }
          bulletsS.value = String(state.bullets ?? "A");
          bulletsS.addEventListener("change", () => (state.bullets = bulletsS.value));
          bulletsF.append(bulletsS);

          const chartF = document.createElement("div");
          chartF.className = "field";
          chartF.innerHTML = `<label>chart</label>`;
          const chartS = document.createElement("select");
          for (const c of ["pie"]) {
            const o = document.createElement("option");
            o.value = c;
            o.textContent = c;
            chartS.appendChild(o);
          }
          chartS.value = String(state.chart ?? "pie");
          chartS.addEventListener("change", () => (state.chart = chartS.value));
          chartF.append(chartS);

          grid.append(bulletsF, chartF);

          const optsF = document.createElement("div");
          optsF.className = "field";
          optsF.innerHTML = `<label>Options (one per line: label:color)</label>`;
          const ta = document.createElement("textarea");
          const curOpts: any[] = Array.isArray(state.options) ? state.options : [];
          ta.value = curOpts.map((o) => `${o?.label ?? ""}${o?.color ? ":" + o.color : ""}`).join("\n");
          ta.style.fontSize = "16px";
          ta.style.lineHeight = "1.35";
          const slug = (label: string) => {
            const s = String(label || "option").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
            return s || "option";
          };
          ta.addEventListener("input", () => {
            const lines = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const seen = new Set<string>();
            const out: any[] = [];
            for (const ln of lines) {
              const [labRaw, colRaw] = ln.includes(":") ? (ln.split(":", 2) as any) : [ln, ""];
              const label = String(labRaw ?? "").trim();
              const color = String(colRaw ?? "").trim();
              if (!label) continue;
              let id = slug(label);
              let n = 2;
              while (seen.has(id)) {
                id = `${slug(label)}${n++}`;
              }
              seen.add(id);
              out.push({ id, label, color: color || undefined });
            }
            state.options = out;
          });
          optsF.append(ta);

          body.append(qF, grid, optsF);
          return;
        }

        body.textContent = "No editable data for this node type.";
        return;
      }

      if (activeTab === "geometry") {
        const t = (state.transform ??= {});
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";

        const num = (label: string, key: string) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "number";
          i.value = String(t[key] ?? 0);
          i.addEventListener("input", () => (t[key] = Number(i.value)));
          f.appendChild(i);
          return f;
        };

        grid.append(num("x", "x"), num("y", "y"), num("w", "w"), num("h", "h"), num("rotationDeg", "rotationDeg"));

        const anchorF = document.createElement("div");
        anchorF.className = "field";
        anchorF.innerHTML = `<label>anchor</label>`;
        const anchorS = document.createElement("select");
        for (const a of [
          "topLeft",
          "topCenter",
          "topRight",
          "centerLeft",
          "centerCenter",
          "centerRight",
          "bottomLeft",
          "bottomCenter",
          "bottomRight"
        ]) {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          anchorS.appendChild(o);
        }
        anchorS.value = (t.anchor ?? "topLeft") === "top" ? "topCenter" : (t.anchor ?? "topLeft") === "bottom" ? "bottomCenter" : (t.anchor ?? "topLeft");
        anchorS.addEventListener("change", () => (t.anchor = anchorS.value));
        anchorF.appendChild(anchorS);

        const alignF = document.createElement("div");
        alignF.className = "field";
        alignF.innerHTML = `<label>alignment (text)</label>`;
        const alignS = document.createElement("select");
        for (const a of ["left", "center", "right"]) {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          alignS.appendChild(o);
        }
        alignS.value = state.align === "right" ? "right" : state.align === "center" ? "center" : "left";
        alignS.addEventListener("change", () => (state.align = alignS.value));
        alignF.appendChild(alignS);

        alignF.querySelector("label")!.textContent = "Horizontal alignment (text)";

        const vAlignF = document.createElement("div");
        vAlignF.className = "field";
        vAlignF.innerHTML = `<label>Vertical alignment (text)</label>`;
        const vAlignS = document.createElement("select");
        for (const a of ["top", "center", "bottom"]) {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          vAlignS.appendChild(o);
        }
        vAlignS.value = String(state.vAlign ?? "top");
        vAlignS.addEventListener("change", () => (state.vAlign = vAlignS.value));
        vAlignF.appendChild(vAlignS);

        body.append(grid, anchorF, alignF, vAlignF);
        return;
      }

      if (activeTab === "animations") {
        const mkAnimEditor = (label: string, key: "appear" | "disappear") => {
          const wrap = document.createElement("div");
          wrap.className = "field";
          wrap.innerHTML = `<label>${label}</label>`;

          const a = (state[key] ??= { kind: "none" });

          const typeS = document.createElement("select");
          for (const k of ["none", "sudden", "fade", "pixelate", "appear"]) {
            const o = document.createElement("option");
            o.value = k;
            o.textContent = k;
            typeS.appendChild(o);
          }
          typeS.value = String(a.kind ?? "none");
          typeS.addEventListener("change", () => {
            const v = typeS.value;
            if (v === "none") state[key] = { kind: "none" };
            else if (v === "sudden") state[key] = { kind: "sudden" };
            else if (v === "fade") state[key] = { kind: "fade", durationMs: 800, from: "all", borderFrac: 0.2, delayMs: 0 };
            else if (v === "pixelate") state[key] = { kind: "pixelate", durationMs: 800, delayMs: 0 };
            else if (v === "appear") state[key] = { kind: "appear", durationMs: 0 };
            render();
          });
          wrap.appendChild(typeS);

          const cur = state[key];
          if (cur?.kind === "fade") {
            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, 1fr)";
            grid.style.gap = "12px";

            const num = (lab: string, prop: string, step = "1") => {
              const f = document.createElement("div");
              f.className = "field";
              f.innerHTML = `<label>${lab}</label>`;
              const i = document.createElement("input");
              i.type = "number";
              i.step = step;
              i.value = String(cur[prop] ?? 0);
              i.addEventListener("input", () => (cur[prop] = Number(i.value)));
              f.appendChild(i);
              return f;
            };
            grid.append(num("durationMs", "durationMs", "10"), num("delayMs", "delayMs", "10"), num("borderFrac", "borderFrac", "0.05"));

            const fromF = document.createElement("div");
            fromF.className = "field";
            fromF.innerHTML = `<label>from</label>`;
            const fromS = document.createElement("select");
            for (const f of ["all", "left", "right", "top", "bottom"]) {
              const o = document.createElement("option");
              o.value = f;
              o.textContent = f;
              fromS.appendChild(o);
            }
            fromS.value = cur.from ?? "all";
            fromS.addEventListener("change", () => (cur.from = fromS.value));
            fromF.appendChild(fromS);

            wrap.append(grid, fromF);
          } else if (cur?.kind === "pixelate") {
            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, 1fr)";
            grid.style.gap = "12px";
            const num = (lab: string, prop: string) => {
              const f = document.createElement("div");
              f.className = "field";
              f.innerHTML = `<label>${lab}</label>`;
              const i = document.createElement("input");
              i.type = "number";
              i.step = "10";
              i.value = String(cur[prop] ?? 0);
              i.addEventListener("input", () => (cur[prop] = Number(i.value)));
              f.appendChild(i);
              return f;
            };
            grid.append(num("durationMs", "durationMs"), num("delayMs", "delayMs"));
            wrap.appendChild(grid);
          }

          return wrap;
        };

        body.append(mkAnimEditor("Enter (appear)", "appear"), mkAnimEditor("Exit (disappear)", "disappear"));
        return;
      }
    };

    const close = () => backdrop.remove();

    tabData.addEventListener("click", () => {
      activeTab = "data";
      render();
    });
    tabGeom.addEventListener("click", () => {
      activeTab = "geometry";
      render();
    });
    tabAnim.addEventListener("click", () => {
      activeTab = "animations";
      render();
    });

    btnCancel.addEventListener("click", () => close());
    // Close only on backdrop mouse-down (not mouse-up/click) to avoid accidental closes
    // when dragging outside and releasing.
    modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    backdrop.addEventListener("pointerdown", (ev) => {
      if (ev.target === backdrop) close();
    });

    btnSave.addEventListener("click", async () => {
      engine.updateNode(nodeId, state);
      const m2 = engine.getModel();
      if (m2) {
        await hydrateQrImages(engine, m2);
        hydrateTextMath(engine, m2);
      }
      applySelection();
      await commit(before);
      close();
    });

    (btnSave as HTMLButtonElement).focus();
    render();
  };

  const onKey = async (ev: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || (document.activeElement as HTMLElement | null)?.isContentEditable;
    if (inInput) return;

    if (ev.key === "Escape") {
      // Exit Screen Edit Mode via keyboard.
      if ((window as any).__ip_exitScreenEdit) {
        try {
          (window as any).__ip_exitScreenEdit();
        } catch {}
        ev.preventDefault();
        return;
      }
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "a") {
      // Intentionally not supported (avoid accidental "select all").
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") {
      const prev = undoStack.pop();
      if (!prev) return;
      const cur = engine.getModel();
      if (cur) redoStack.push(cloneModel(cur));
      engine.setModel(cloneModel(prev));
      await hydrateQrImages(engine, prev);
      hydrateTextMath(engine, prev);
      applySelection();
      await saveModel(prev);
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "y") {
      const next = redoStack.pop();
      if (!next) return;
      const cur = engine.getModel();
      if (cur) undoStack.push(cloneModel(cur));
      engine.setModel(cloneModel(next));
      await hydrateQrImages(engine, next);
      hydrateTextMath(engine, next);
      applySelection();
      await saveModel(next);
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
      // Copy: include selected nodes + any descendants (so groups paste as a whole).
      const model = engine.getModel();
      const nodes = model?.nodes ?? [];
      const byId = new Map(nodes.map((n: any) => [String(n.id), n]));
      const selectedIds = new Set(Array.from(selected));
      const allIds = new Set<string>(selectedIds);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes as any[]) {
          const pid = String(n.parentId ?? "").trim();
          if (pid && allIds.has(pid) && !allIds.has(String(n.id))) {
            allIds.add(String(n.id));
            changed = true;
          }
        }
      }
      const copied = Array.from(allIds)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((n: any) => JSON.parse(JSON.stringify(n)));
      // Compute a bounding box of root nodes (nodes whose parent isn't also copied).
      const roots = copied.filter((n: any) => !String(n.parentId ?? "").trim() || !allIds.has(String(n.parentId ?? "").trim()));
      let bbox = null as null | { space: "world" | "screen"; cx: number; cy: number };
      try {
        if (roots.length) {
          const space = (roots[0]?.space ?? "world") === "screen" ? "screen" : "world";
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const cs = rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          } else {
            // Screen-space: treat x/y as normalized and approximate bbox by anchor points.
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const t = n.transform ?? {};
              const x = Number(t.x ?? 0);
              const y = Number(t.y ?? 0);
              const w = Number(t.w ?? 0.2);
              const h = Number(t.h ?? 0.1);
              const tl = anchorToTopLeftWorld({ x, y, w, h, anchor: String(t.anchor ?? "topLeft") } as any);
              minX = Math.min(minX, tl.x);
              minY = Math.min(minY, tl.y);
              maxX = Math.max(maxX, tl.x + w);
              maxY = Math.max(maxY, tl.y + h);
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          }
        }
      } catch {}
      (window as any).__ip_clipboard = { nodes: copied, bbox };
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "x") {
      // Cut: copy first (same semantics as Ctrl+C), then delete selection.
      const model = engine.getModel();
      const nodes = model?.nodes ?? [];
      const byId = new Map(nodes.map((n: any) => [String(n.id), n]));
      const selectedIds = new Set(Array.from(selected));
      const allIds = new Set<string>(selectedIds);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes as any[]) {
          const pid = String(n.parentId ?? "").trim();
          if (pid && allIds.has(pid) && !allIds.has(String(n.id))) {
            allIds.add(String(n.id));
            changed = true;
          }
        }
      }
      const copied = Array.from(allIds)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((n: any) => JSON.parse(JSON.stringify(n)));
      const roots = copied.filter((n: any) => !String(n.parentId ?? "").trim() || !allIds.has(String(n.parentId ?? "").trim()));
      let bbox = null as null | { space: "world" | "screen"; cx: number; cy: number };
      try {
        if (roots.length) {
          const space = (roots[0]?.space ?? "world") === "screen" ? "screen" : "world";
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const cs = rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          } else {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const t = n.transform ?? {};
              const x = Number(t.x ?? 0);
              const y = Number(t.y ?? 0);
              const w = Number(t.w ?? 0.2);
              const h = Number(t.h ?? 0.1);
              const tl = anchorToTopLeftWorld({ x, y, w, h, anchor: String(t.anchor ?? "topLeft") } as any);
              minX = Math.min(minX, tl.x);
              minY = Math.min(minY, tl.y);
              maxX = Math.max(maxX, tl.x + w);
              maxY = Math.max(maxY, tl.y + h);
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          }
        }
      } catch {}
      (window as any).__ip_clipboard = { nodes: copied, bbox };
      await deleteSelection();
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "v") {
      const clip = (window as any).__ip_clipboard;
      const items: any[] = Array.isArray(clip) ? clip : Array.isArray(clip?.nodes) ? clip.nodes : [];
      if (items.length === 0) return;
      const model = engine.getModel();
      if (!model) return;
      const before = cloneModel(model);

      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const stageRect = stage.getBoundingClientRect();
      const mx = typeof (window as any).__ip_lastMouseX === "number" ? (window as any).__ip_lastMouseX : stageRect.left + stageRect.width / 2;
      const my = typeof (window as any).__ip_lastMouseY === "number" ? (window as any).__ip_lastMouseY : stageRect.top + stageRect.height / 2;
      const screenPos = { x: mx - stageRect.left, y: my - stageRect.top };
      const targetWorld = screenEditMode ? null : screenToWorld(screenPos, cam as any, scr as any);
      const targetScreenFrac =
        scr.w > 0 && scr.h > 0 ? { x: screenPos.x / scr.w, y: screenPos.y / scr.h } : { x: 0.5, y: 0.5 };

      const oldIds = new Set(items.map((n) => String(n.id)));
      const idMap = new Map<string, string>();
      const newNodes: any[] = [];

      const prefixFor = (n: any) => {
        const t = String(n?.type ?? "node");
        // keep ids readable and stable
        return t;
      };

      // Create new ids first
      for (const n of items) {
        const oldId = String(n.id);
        idMap.set(oldId, nextId(prefixFor(n)));
      }

      // Determine roots for positioning (don't move children independently)
      const rootOldIds = items
        .filter((n) => {
          const pid = String(n.parentId ?? "").trim();
          return !pid || !oldIds.has(pid);
        })
        .map((n) => String(n.id));

      // Compute bbox center from clipboard metadata (fallback to current root nodes)
      const bbox = clip?.bbox ?? null;
      const space = (bbox?.space ?? items[0]?.space ?? "world") === "screen" ? "screen" : "world";
      let baseCx = bbox?.cx ?? 0;
      let baseCy = bbox?.cy ?? 0;
      if (!bbox) {
        try {
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const oldId of rootOldIds) {
              const n = items.find((x) => String(x.id) === oldId);
              if (!n) continue;
              const cs = rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
              baseCx = (minX + maxX) / 2;
              baseCy = (minY + maxY) / 2;
            }
          } else {
            baseCx = targetScreenFrac.x;
            baseCy = targetScreenFrac.y;
          }
        } catch {}
      }

      // Compute delta to place near cursor; if we can't resolve cursor (or mismatch space), use a small offset.
      let dxw = 0;
      let dyw = 0;
      let dxs = 0;
      let dys = 0;
      if (space === "world" && targetWorld) {
        dxw = targetWorld.x - baseCx;
        dyw = targetWorld.y - baseCy;
      } else if (space === "screen") {
        dxs = targetScreenFrac.x - baseCx;
        dys = targetScreenFrac.y - baseCy;
      } else {
        // fallback offset (world)
        dxw = 40;
        dyw = 40;
      }

      for (const n0 of items) {
        const n = JSON.parse(JSON.stringify(n0));
        const oldId = String(n.id);
        const newId = idMap.get(oldId) ?? nextId(prefixFor(n));
        n.id = newId;

        // Remap parentId if the parent is also pasted.
        const pid = String(n.parentId ?? "").trim();
        if (pid && idMap.has(pid)) n.parentId = idMap.get(pid);
        else delete n.parentId;

        // If this is a composite-root node, make sure compositeDir follows the new id.
        if (n.type === "timer" || n.type === "sound") n.compositeDir = newId;

        // Offset only roots (children keep their parent-relative transforms).
        if (rootOldIds.includes(oldId)) {
          const t = n.transform ?? {};
          if ((n.space ?? "world") === "screen") {
            n.transform = { ...t, x: Number(t.x ?? 0) + dxs, y: Number(t.y ?? 0) + dys };
          } else {
            n.transform = { ...t, x: Number(t.x ?? 0) + dxw, y: Number(t.y ?? 0) + dyw };
          }
        }

        newNodes.push(n);
      }

      // Add to model
      for (const n of newNodes) model.nodes.push(n);

      // Add to views
      const activeView = model.views.find((v) => v.id === getActiveViewId()) ?? model.views[0];
      for (const n of newNodes) {
        const id = String(n.id);
        const isScreen = (n.space ?? "world") === "screen";
        if (isScreen) {
          for (const v of model.views) if (!v.show.includes(id)) v.show.push(id);
        } else {
          if (activeView && !activeView.show.includes(id)) activeView.show.push(id);
        }
      }

      engine.setModel(cloneModel(model));
      await hydrateQrImages(engine, model);
      hydrateTextMath(engine, model);
      selected.clear();
      // Select pasted roots (more ergonomic than selecting every child).
      for (const oldId of rootOldIds) {
        const nid = idMap.get(oldId);
        if (nid) selected.add(nid);
      }
      applySelection();
      await commit(before);
      ev.preventDefault();
      return;
    }

    if (ev.key === "Delete" || ev.key === "Backspace") {
      await deleteSelection();
      ev.preventDefault();
      return;
    }
  };

  window.addEventListener("keydown", onKey);

  // Composite edit mode (timer/choices): allow editing sub-elements without opening the regular modal.
  let compositeEditTimerId: string | null = null; // composite root node id
  let compositeEditKind: "timer" | "choices" | "sound" = "timer";
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
    for (const sub of Array.from(layer.querySelectorAll<HTMLElement>(".comp-sub"))) {
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
    for (const sub of Array.from(layer?.querySelectorAll<HTMLElement>(".comp-sub") ?? [])) {
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
    const m0 = engine.getModel();
    const n0: any = m0?.nodes.find((n: any) => n.id === pollId);
    if (n0) renderChoicesNode(engine, el, n0, __choicesState[pollId] ?? null);

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
    for (const sub of Array.from(layer?.querySelectorAll<HTMLElement>(".comp-sub") ?? [])) {
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
    for (const sub of Array.from(layer?.querySelectorAll<HTMLElement>(".comp-sub") ?? [])) {
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
      let best: { id: string; kind: "timer" | "sound" | "choices"; area: number } | null = null;
      for (const n of model.nodes as any[]) {
        const kind = String(n?.type ?? "");
        if (kind !== "timer" && kind !== "sound" && kind !== "choices") continue;
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
      if (selNode && selEl && (selNode.type === "timer" || selNode.type === "sound")) {
        const eff = effectiveNodeRectClient(selEl, selNode);
        const rotDeg = Number(selNode?.transform?.rotationDeg ?? 0) || 0;
        if (eff && isPointInRotatedRectClient(eff as any, rotDeg, ev.clientX, ev.clientY)) {
          if (selNode.type === "timer") enterTimerCompositeEdit(String(selNode.id));
          else enterSoundCompositeEdit(String(selNode.id));
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
        exitGroupEditLevel();
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
        enterGroupEdit(rawId);
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
    if (!(sub.dataset.kind === "plot-arrow" && (compositeEditKind === "timer" || compositeEditKind === "sound"))) {
      delete (layer.dataset as any).selectedPlotArrowId;
      if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
      else if (compositeEditKind === "sound") renderSoundCompositeArrows(timerEl, layer);
    }

    // Composite axis arrows (timer/sound): drag endpoints in plot coords (no bbox handles).
    if ((compositeEditKind === "timer" || compositeEditKind === "sound") && sub.dataset.kind === "plot-arrow") {
      const specs: any[] = (layer as any).__arrowSpecs ?? [];
      if (!Array.isArray(specs) || specs.length === 0) return;
      const requestedArrowId = String(sub.dataset.arrowId ?? "");
      // Store selection for rendering (glow on SVG line, no bbox).
      if (requestedArrowId) {
        layer.dataset.selectedPlotArrowId = requestedArrowId;
        if (compositeEditKind === "timer") renderTimerCompositeArrows(timerEl, layer);
        else renderSoundCompositeArrows(timerEl, layer);
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
      if (!(compositeEditKind === "timer" || compositeEditKind === "sound")) return;
      const layer =
        compositeEditKind === "timer"
          ? timerEl.querySelector<HTMLElement>(".timer-sub-layer")
          : timerEl.querySelector<HTMLElement>(".sound-sub-layer");
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
    if ((compositeEditKind === "timer" || compositeEditKind === "sound") && compositeEditTimerId) {
      const layer =
        compositeEditKind === "timer"
          ? engine.getNodeElement(compositeEditTimerId)?.querySelector<HTMLElement>(".timer-sub-layer")
          : engine.getNodeElement(compositeEditTimerId)?.querySelector<HTMLElement>(".sound-sub-layer");
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
        if (kind === "plot-arrow" && (compositeEditKind === "timer" || compositeEditKind === "sound")) {
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

  // Excel-like table editing: single click enters cell edit (also allowed in live mode).
  stage.addEventListener(
    "pointerdown",
    (ev) => {
      const t = ev.target as HTMLElement;
      const td = t.closest("td.table-cell") as HTMLTableCellElement | null;
      if (!td) return;
      const nodeEl = td.closest(".node") as HTMLElement | null;
      const tableId = String(nodeEl?.dataset?.nodeId ?? "");
      if (!tableId) return;

      // Don't allow table edits while a composite/group edit dimming state is active.
      if ((window as any).__ip_compositeEditing) return;

      // Resolve row/col by DOM position.
      const tr = td.parentElement as HTMLTableRowElement | null;
      const table = td.closest("table") as HTMLTableElement | null;
      if (!tr || !table) return;
      const row = (tr as any).rowIndex ?? Array.from(table.rows).indexOf(tr);
      const col = (td as any).cellIndex ?? Array.from(tr.children).indexOf(td);
      if (!(row >= 0 && col >= 0)) return;

      // Prevent stage selection/pan from interfering.
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();

      // Start editing on left click only.
      if (ev.button !== 0) return;
      void _beginTableCellEdit(td, tableId, row, col);
    },
    { capture: true }
  );

  stage.addEventListener("pointerdown", (ev) => {
    // Hard block: Live mode must be resistant to any editing gestures.
    if (getAppMode() !== "edit") return;
    const target = ev.target as HTMLElement;
    const anchorEl = target.closest<HTMLElement>(".anchor-dot");
    const nodeEl = target.closest<HTMLElement>(".node");
    const compSubEl = target.closest<HTMLElement>(".comp-sub");

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
          if (!seg) continue;
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
        clearSelection();
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
    if ((compositeEditKind === "timer" || compositeEditKind === "sound") && compositeEditTimerId && id === compositeEditTimerId) {
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
          activeHandle = hnd;
          dragMode = "line";
          setBodyCursor("grabbing");
          // Junction behavior for polylines:
          // - dragging an endpoint moves all coincident endpoints (shared junction)
          // - dragging the midpoint moves the segment AND any coincident endpoints at either end
          junctionDrag = null;
          if ((node as any)?.type === "line" && model) {
            const onlyId = id;
            const startNode: any = startNodesById?.[onlyId];
            const sp: "world" | "screen" = (startNode?.space ?? "world") === "screen" ? "screen" : "world";
            // Compute endpoints in the same coordinate system used by line editing (world units or screen fractions).
            const ui0: any = (startNode as any)?.__ui ?? null;
            const t0 = (ui0?.worldT ?? startNode?.transform ?? {}) as any;
            const from0 = startNode?.from ?? { x: 0, y: 0.5 };
            const to0 = startNode?.to ?? { x: 1, y: 0.5 };
            const tl0 = anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" } as any);
            const w0 = Math.max(1e-9, Number(t0.w ?? 1));
            const h0 = Math.max(1e-9, Number(t0.h ?? 1));
            const p1w = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
            const p2w = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };
            const camNow = engine.getCamera();
            const scrNow = engine.getScreen();
            const tolPx = 10; // junction weld tolerance in screen pixels
            const tolPx2 = tolPx * tolPx;

            const toScreenPt = (p: { x: number; y: number }) =>
              sp === "world" ? worldToScreen(p, camNow as any, scrNow as any) : { x: p.x * scrNow.w, y: p.y * scrNow.h };

            const p1s = toScreenPt(p1w);
            const p2s = toScreenPt(p2w);

            const p1Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }> = [];
            const p2Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }> = [];
            const junctions: Array<{ x: number; y: number }> = [];
            const j1 = String((startNode as any)?.p1Join ?? "").trim();
            const j2 = String((startNode as any)?.p2Join ?? "").trim();
            for (const n0 of model.nodes as any[]) {
              if (!n0 || String(n0.type) !== "line") continue;
              const nid = String(n0.id ?? "");
              if (!nid || nid === onlyId) continue;
              if (String(n0.space ?? "world") !== sp) continue;
              const { ui, parentWorld } = _uiNodeForId(nid, model);
              const tN = (ui as any)?.transform ?? n0.transform ?? {};
              const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
              const to = (n0 as any).to ?? { x: 1, y: 0.5 };
              const tl = anchorToTopLeftWorld({ x: Number(tN.x ?? 0), y: Number(tN.y ?? 0), w: Number(tN.w ?? 1), h: Number(tN.h ?? 1), anchor: tN.anchor ?? "topLeft" } as any);
              const w = Math.max(1e-9, Number(tN.w ?? 1));
              const h = Math.max(1e-9, Number(tN.h ?? 1));
              const q1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
              const q2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };

              // Collect snap-to-graph junction candidates.
              junctions.push(q1, q2);

              const nJ1 = String((n0 as any)?.p1Join ?? "").trim();
              const nJ2 = String((n0 as any)?.p2Join ?? "").trim();

              // Prefer join-id links if available.
              if (j1) {
                if (nJ1 && nJ1 === j1) p1Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
                else if (nJ2 && nJ2 === j1) p1Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
              }
              if (j2) {
                if (nJ1 && nJ1 === j2) p2Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
                else if (nJ2 && nJ2 === j2) p2Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
              }

              // Fallback to proximity links for legacy segments that have no join IDs.
              if (!j1 || !j2) {
                const q1s = toScreenPt(q1);
                const q2s = toScreenPt(q2);
                if (!j1) {
                  const d11 = (q1s.x - p1s.x) ** 2 + (q1s.y - p1s.y) ** 2;
                  const d12 = (q2s.x - p1s.x) ** 2 + (q2s.y - p1s.y) ** 2;
                  if (d11 <= tolPx2) p1Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
                  else if (d12 <= tolPx2) p1Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
                }
                if (!j2) {
                  const d21 = (q1s.x - p2s.x) ** 2 + (q1s.y - p2s.y) ** 2;
                  const d22 = (q2s.x - p2s.x) ** 2 + (q2s.y - p2s.y) ** 2;
                  if (d21 <= tolPx2) p2Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
                  else if (d22 <= tolPx2) p2Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
                }
              }
            }
            if (p1Links.length > 0 || p2Links.length > 0 || junctions.length > 0) junctionDrag = { movedId: onlyId, space: sp, p1Links, p2Links, junctions };
          }
          (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          return;
        }
        // Not close enough to the segment.
        // For lines, treat this as "graph drag" (drag the whole connected component of lines).
        if ((node as any)?.type === "line" && model) {
          const onlyId = id;
          const startNode: any = startNodesById?.[onlyId];
          const sp: "world" | "screen" = (startNode?.space ?? "world") === "screen" ? "screen" : "world";
          const parentId = String((startNode as any)?.parentId ?? "").trim();
          const camNow = engine.getCamera();
          const scrNow = engine.getScreen();
          const ids = _collectConnectedLineIds(onlyId, model, sp, camNow as any, scrNow as any, parentId);

          // Ensure we have start snapshots for all ids in the component (even if not selected).
          const idSet = new Set(ids);
          for (const n0 of model.nodes as any[]) {
            const nid = String(n0?.id ?? "");
            if (!nid || !idSet.has(nid)) continue;
            if (startNodesById[nid]) continue;
            const snap = JSON.parse(JSON.stringify(n0));
            const pid = String((n0 as any)?.parentId ?? "").trim();
            if (pid && (n0 as any)?.space === "world") {
              const { ui, parentWorld } = _uiNodeForId(String(nid), model);
              (snap as any).__ui = { worldT: (ui as any)?.transform ?? null, parentWorldT: parentWorld ?? null };
            }
            startNodesById[nid] = snap;
          }

          // Reference point for snapping translation: use seed p1.
          const ui0: any = (startNodesById[onlyId] as any)?.__ui ?? null;
          const t0 = (ui0?.worldT ?? (startNodesById[onlyId] as any)?.transform ?? {}) as any;
          const from0 = (startNodesById[onlyId] as any)?.from ?? { x: 0, y: 0.5 };
          const tl0 = anchorToTopLeftWorld({
            x: Number(t0.x ?? 0),
            y: Number(t0.y ?? 0),
            w: Number(t0.w ?? 1),
            h: Number(t0.h ?? 1),
            anchor: t0.anchor ?? "topLeft"
          } as any);
          const w0 = Math.max(1e-9, Number(t0.w ?? 1));
          const h0 = Math.max(1e-9, Number(t0.h ?? 1));
          const p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };

          graphDrag = { ids, space: sp, ref: p1 };
          dragMode = "graph";
          activeHandle = null;
          setBodyCursor("grabbing");
          (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
          ev.preventDefault();
          return;
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

    if (!ev.shiftKey && !ev.ctrlKey) clearSelection();
  });

  stage.addEventListener("pointermove", (ev) => {
    if (selected.size === 0 || dragMode === "none" || !startNodesById) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const cam = engine.getCamera();
    const scr = engine.getScreen();

    if (dragMode === "graph" && graphDrag) {
      const sp = graphDrag.space;
      let ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
      let ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);

      // Shift snap: snap translation using a reference point.
      if (ev.shiftKey && sp === "world") {
        const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
        const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
        const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
        const refNew = { x: graphDrag.ref.x + ddx, y: graphDrag.ref.y + ddy };
        const refSnap = { x: snap(refNew.x), y: snap(refNew.y) };
        ddx = refSnap.x - graphDrag.ref.x;
        ddy = refSnap.y - graphDrag.ref.y;
      }

      const idSet = new Set(graphDrag.ids);
      for (const id of graphDrag.ids) {
        const startNode: any = startNodesById[id];
        if (!startNode) continue;
        if (String(startNode.type ?? "") !== "line") continue;
        // Safety: only move the captured component
        if (!idSet.has(id)) continue;

        const ui0: any = (startNode as any).__ui ?? null;
        const parentWorldT: any = ui0?.parentWorldT ?? null;
        const t0 = (ui0?.worldT ?? startNode.transform ?? {}) as any;
        const from0 = startNode.from ?? { x: 0, y: 0.5 };
        const to0 = startNode.to ?? { x: 1, y: 0.5 };
        const tl0 = anchorToTopLeftWorld({
          x: Number(t0.x ?? 0),
          y: Number(t0.y ?? 0),
          w: Number(t0.w ?? 1),
          h: Number(t0.h ?? 1),
          anchor: t0.anchor ?? "topLeft"
        } as any);
        const w0 = Math.max(1e-9, Number(t0.w ?? 1));
        const h0 = Math.max(1e-9, Number(t0.h ?? 1));
        let p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
        let p2 = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };

        p1 = { x: p1.x + ddx, y: p1.y + ddy };
        p2 = { x: p2.x + ddx, y: p2.y + ddy };

        // Refit bbox around the translated endpoints.
        let minX = Math.min(p1.x, p2.x);
        let minY = Math.min(p1.y, p2.y);
        let maxX = Math.max(p1.x, p2.x);
        let maxY = Math.max(p1.y, p2.y);
        const minSize = sp === "world" ? 10 : 0.005;
        if (maxX - minX < minSize) {
          const cx = (minX + maxX) / 2;
          minX = cx - minSize / 2;
          maxX = cx + minSize / 2;
        }
        if (maxY - minY < minSize) {
          const cy = (minY + maxY) / 2;
          minY = cy - minSize / 2;
          maxY = cy + minSize / 2;
        }
        const w1 = maxX - minX;
        const h1 = maxY - minY;
        const fx = (p1.x - minX) / w1;
        const fy = (p1.y - minY) / h1;
        const tx = (p2.x - minX) / w1;
        const ty = (p2.y - minY) / h1;

        const worldOut = { x: minX, y: minY, w: w1, h: h1, anchor: "topLeft", rotationDeg: 0 } as any;
        const localOut = parentWorldT ? _toLocalTransformFromWorld(worldOut, parentWorldT, "topLeft") : worldOut;
        engine.updateNode(id, { transform: localOut as any, from: { x: fx, y: fy }, to: { x: tx, y: ty } } as any);
      }
      applySelection();
      return;
    }

    if (dragMode === "line" && selected.size === 1) {
      const onlyId = Array.from(selected)[0];
      const startNode: any = startNodesById[onlyId];
      if (!startNode) return;
      const sp = startNode.space ?? "world";
      const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
      const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);

      // Grouped nodes: use world transform for UI math, then convert back to local.
      const ui0: any = (startNode as any).__ui ?? null;
      const parentWorldT: any = ui0?.parentWorldT ?? null;
      const t0 = (ui0?.worldT ?? startNode.transform ?? {}) as any;
      const from0 = startNode.from ?? { x: 0, y: 0.5 };
      const to0 = startNode.to ?? { x: 1, y: 0.5 };
      const tl0 = anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" } as any);
      const w0 = Math.max(1e-9, Number(t0.w ?? 1));
      const h0 = Math.max(1e-9, Number(t0.h ?? 1));
      let p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
      let p2 = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };

      const hnd = activeHandle ?? "mid";
      if (hnd === "p1") {
        p1 = { x: p1.x + ddx, y: p1.y + ddy };
      } else if (hnd === "p2") {
        p2 = { x: p2.x + ddx, y: p2.y + ddy };
      } else {
        // mid: translate both
        p1 = { x: p1.x + ddx, y: p1.y + ddy };
        p2 = { x: p2.x + ddx, y: p2.y + ddy };
      }

      // Shift snapping:
      // - Endpoint drag: snap to existing junction if it's closer (in screen px) than the nearest grid point.
      // - Mid drag: keep existing grid snap behavior (translate both by a single snapped delta).
      if (ev.shiftKey) {
        const tolPx = 12;
        const tolPx2 = tolPx * tolPx;
        const toScreenPt = (p: { x: number; y: number }) =>
          sp === "world" ? worldToScreen(p, cam as any, scr as any) : { x: p.x * scr.w, y: p.y * scr.h };
        const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          return dx * dx + dy * dy;
        };

        const snapEndpoint = (p: { x: number; y: number }) => {
          const ps = toScreenPt(p);
          // Nearest junction (endpoints of other lines, collected on pointerdown).
          const js = junctionDrag?.junctions ?? [];
          let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
          for (const j of js) {
            const d2 = dist2px(toScreenPt(j), ps);
            if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
          }

          if (sp === "world") {
            const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
            const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
            const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
            const gridPt = { x: snap(p.x), y: snap(p.y) };
            const gridD2 = dist2px(toScreenPt(gridPt), ps);
            if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) return bestJ.p;
            return gridPt;
          }

          // Screen-space: no grid, just snap to nearest junction within tolerance.
          if (bestJ && bestJ.d2 <= tolPx2) return bestJ.p;
          return p;
        };

        if (hnd === "p1") {
          p1 = snapEndpoint(p1);
        } else if (hnd === "p2") {
          p2 = snapEndpoint(p2);
        } else if (sp === "world") {
          // Mid translate: preserve length+angle by applying a SINGLE translation snap offset (grid).
        const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
        const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
        const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
        const snapPt = (p: { x: number; y: number }) => ({ x: snap(p.x), y: snap(p.y) });
        const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          return dx * dx + dy * dy;
        };
          const s1 = snapPt(p1);
          const s2 = snapPt(p2);
          const d1 = dist2(p1, s1);
          const d2 = dist2(p2, s2);
          const dx = (d1 <= d2 ? s1.x - p1.x : s2.x - p2.x);
          const dy = (d1 <= d2 ? s1.y - p1.y : s2.y - p2.y);
          p1 = { x: p1.x + dx, y: p1.y + dy };
          p2 = { x: p2.x + dx, y: p2.y + dy };
        }
      }

      // Refit an axis-aligned bbox around the two points (keeps endpoints within [0..1]).
      let minX = Math.min(p1.x, p2.x);
      let minY = Math.min(p1.y, p2.y);
      let maxX = Math.max(p1.x, p2.x);
      let maxY = Math.max(p1.y, p2.y);
      const minSize = sp === "world" ? 10 : 0.005;
      if (maxX - minX < minSize) {
        const cx = (minX + maxX) / 2;
        minX = cx - minSize / 2;
        maxX = cx + minSize / 2;
      }
      if (maxY - minY < minSize) {
        const cy = (minY + maxY) / 2;
        minY = cy - minSize / 2;
        maxY = cy + minSize / 2;
      }
      const w1 = maxX - minX;
      const h1 = maxY - minY;
      const fx = (p1.x - minX) / w1;
      const fy = (p1.y - minY) / h1;
      const tx = (p2.x - minX) / w1;
      const ty = (p2.y - minY) / h1;

      const worldOut = { x: minX, y: minY, w: w1, h: h1, anchor: "topLeft", rotationDeg: 0 } as any;
      const localOut = parentWorldT ? _toLocalTransformFromWorld(worldOut, parentWorldT, "topLeft") : worldOut;
      engine.updateNode(onlyId, {
        transform: localOut as any,
        from: { x: fx, y: fy },
        to: { x: tx, y: ty }
      } as any);

      // Graph behavior: update any linked line endpoints so shared junctions move together.
      if (junctionDrag && junctionDrag.movedId === onlyId) {
        const applyNode = (nodeId: string, a: { x: number; y: number }, b: { x: number; y: number }, parentWorld: any | null) => {
          // Refit bbox + endpoints (same math as above)
          let minX = Math.min(a.x, b.x);
          let minY = Math.min(a.y, b.y);
          let maxX = Math.max(a.x, b.x);
          let maxY = Math.max(a.y, b.y);
          const minSize = sp === "world" ? 10 : 0.005;
          if (maxX - minX < minSize) {
            const cx = (minX + maxX) / 2;
            minX = cx - minSize / 2;
            maxX = cx + minSize / 2;
          }
          if (maxY - minY < minSize) {
            const cy = (minY + maxY) / 2;
            minY = cy - minSize / 2;
            maxY = cy + minSize / 2;
          }
          const w1 = maxX - minX;
          const h1 = maxY - minY;
          const fx = (a.x - minX) / w1;
          const fy = (a.y - minY) / h1;
          const tx = (b.x - minX) / w1;
          const ty = (b.y - minY) / h1;
          const worldOut = { x: minX, y: minY, w: w1, h: h1, anchor: "topLeft", rotationDeg: 0 } as any;
          const localOut = parentWorld ? _toLocalTransformFromWorld(worldOut, parentWorld, "topLeft") : worldOut;
          engine.updateNode(nodeId, { transform: localOut as any, from: { x: fx, y: fy }, to: { x: tx, y: ty } } as any);
        };
        const applyLinks = (links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>, movedNew: { x: number; y: number }) => {
          for (const l of links) {
            if (l.end === "p1") applyNode(l.id, movedNew, l.other, l.parentWorldT);
            else applyNode(l.id, l.other, movedNew, l.parentWorldT);
          }
        };

        if (hnd === "p1") {
          applyLinks(junctionDrag.p1Links, p1);
        } else if (hnd === "p2") {
          applyLinks(junctionDrag.p2Links, p2);
        } else {
          // Midpoint drag: preserve connectivity at BOTH endpoints.
          applyLinks(junctionDrag.p1Links, p1);
          applyLinks(junctionDrag.p2Links, p2);
        }
      }
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

    if (dragMode === "rotate") {
      const el = engine.getNodeElement(onlyId);
      const curModel = engine.getModel();
      const curNode: any = curModel?.nodes.find((n) => n.id === onlyId);
      const eff = el && (curNode?.type === "timer" || curNode?.type === "sound") ? effectiveNodeRectClient(el, curNode) : null;
      const r = (eff as any) ?? el?.getBoundingClientRect();
      if (!r) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
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
      if (curNode?.type === "timer" || curNode?.type === "sound") applySelection();
      else if (el) ensureHandles(el);
      return;
    }

    if (dragMode === "resize" && activeHandle) {
      const tl0 = anchorToTopLeftWorld(t0);
      let rect = { x: tl0.x, y: tl0.y, w: t0.w, h: t0.h };
      const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
      const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);
      const min = sp === "world" ? 5 : 0.01;

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

      if (isScaleCorner) {
        const sx = activeHandle.includes("w") ? -ddx : ddx;
        const sy = activeHandle.includes("n") ? -ddy : ddy;
        const w1 = Math.max(min, t0.w + sx);
        const h1 = Math.max(min, t0.h + sy);
        const sRaw = Math.max(w1 / Math.max(1e-9, t0.w), h1 / Math.max(1e-9, t0.h));

        // Corner scaling changes box size (including bullets).
        rect.w = Math.max(min, t0.w * sRaw);
        rect.h = Math.max(min, t0.h * sRaw);

        // Shift: snap uniform scale so the resulting box width/height lands on grid units.
        // Rule: snap when either dimension is close to a whole number of grid units; pick the closer snap.
        if (snapSpacingWorld) {
          const snappedW = Math.max(min, snapWorld(rect.w));
          const snappedH = Math.max(min, snapWorld(rect.h));
          const sFromW = snappedW / Math.max(1e-9, t0.w);
          const sFromH = snappedH / Math.max(1e-9, t0.h);
          const sUse = Math.abs(sFromW - sRaw) <= Math.abs(sFromH - sRaw) ? sFromW : sFromH;
          rect.w = Math.max(min, t0.w * sUse);
          rect.h = Math.max(min, t0.h * sUse);
        }

        // Corner scaling changes box size (including bullets).
        if (activeHandle.includes("w")) rect.x = tl0.x + (t0.w - rect.w);
        if (activeHandle.includes("n")) rect.y = tl0.y + (t0.h - rect.h);

        // Corner scaling should scale text-like font size along with the box.
        if (isTextLike) {
          const sUsed = rect.w / Math.max(1e-9, t0.w);
          engine.updateNode(onlyId, { fontPx: Math.max(1, (startFontPx ?? 28) * sUsed) } as any);
        }
      } else {
        // Edge handles: free resize
        if (activeHandle.includes("e")) rect.w = Math.max(min, t0.w + ddx);
        if (activeHandle.includes("s")) rect.h = Math.max(min, t0.h + ddy);
        if (activeHandle.includes("w")) {
          rect.x = tl0.x + ddx;
          rect.w = Math.max(min, t0.w - ddx);
        }
        if (activeHandle.includes("n")) {
          rect.y = tl0.y + ddy;
          rect.h = Math.max(min, t0.h - ddy);
        }

        // Shift: snap ONLY the moved edge to grid lines (world-space only).
        if (snapSpacingWorld) {
          // Snap x edges
          if (activeHandle.includes("e") && !activeHandle.includes("w")) {
            const right = rect.x + rect.w;
            const rightSn = snapWorld(right);
            rect.w = Math.max(min, rightSn - rect.x);
          }
          if (activeHandle.includes("w")) {
            const rightFixed = tl0.x + t0.w;
            const leftSn = snapWorld(rect.x);
            rect.x = leftSn;
            rect.w = Math.max(min, rightFixed - rect.x);
          }
          // Snap y edges
          if (activeHandle.includes("s") && !activeHandle.includes("n")) {
            const bottom = rect.y + rect.h;
            const bottomSn = snapWorld(bottom);
            rect.h = Math.max(min, bottomSn - rect.y);
          }
          if (activeHandle.includes("n")) {
            const bottomFixed = tl0.y + t0.h;
            const topSn = snapWorld(rect.y);
            rect.y = topSn;
            rect.h = Math.max(min, bottomFixed - rect.y);
          }
        }

        // Edge resizing should NOT scale text font; initialize fontPx if missing so it stays stable.
        if (isTextLike && curNode?.fontPx == null) {
          engine.updateNode(onlyId, { fontPx: Math.max(1, startFontPx ?? 28) } as any);
        }
      }
      const anchored = topLeftToAnchorWorld(rect, t0.anchor);
      const worldOut = { ...t0, x: anchored.x, y: anchored.y, w: rect.w, h: rect.h } as any;
      if (parentWorldT && sp === "world") {
        const localAnchor = String((startNode as any)?.transform?.anchor ?? worldOut.anchor ?? "topLeft");
        const localOut = _toLocalTransformFromWorld(worldOut, parentWorldT, localAnchor);
        engine.updateNode(onlyId, { transform: { ...((startNode as any)?.transform ?? {}), ...localOut } as any } as any);
      } else {
        engine.updateNode(onlyId, { transform: worldOut as any } as any);
      }
    }
  });

  // Finish drag reliably even if pointerup happens outside the stage.
  window.addEventListener("pointerup", () => {
    void finishDrag();
  });
  window.addEventListener("pointercancel", () => {
    // Cancel should not commit.
    pendingCompositeDrag = null;
    dragMode = "none";
    activeHandle = null;
    setBodyCursor("");
    startNodesById = null;
    startSnapshot = null;
    const mx = (window as any).__ip_lastMouseX;
    const my = (window as any).__ip_lastMouseY;
    if (typeof mx === "number" && typeof my === "number") updateStageCursorFromClientPoint(mx, my);
  });
}

async function main() {
  const { canvas, overlay, stage } = buildShell();
  const engine = new Engine({ canvas, overlayEl: overlay, hitTestEl: stage });
  engine.mount();

  if (DEBUG_ANIM) dlog("debugAnim=1 enabled");

  const model = await fetchModel();
  preloadImageAssets(model);
  engine.setModel(model);
  dlog("loaded model", {
    views: model.views?.map((v) => ({ id: v.id, show: v.show?.slice?.(0, 50) })),
    animationCues: (model as any).animationCues
  });

  const viewsInOrder = model.views;
  let viewIdx = Math.max(0, viewsInOrder.findIndex((v) => v.id === model.initialViewId));
  let camTweenTimer: number | null = null;

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
      // Timer: global accepting state
      if (__timerPollingEnabled || __timerState?.accepting) {
        __timerPollingEnabled = false;
        if (__timerState) __timerState.accepting = false;
        void fetch(`${BACKEND}/api/timer/stop`, { method: "POST" }).catch(() => {});
      }

      // Choices: stop any active polls we started
      for (const pollId of Array.from(__activeChoicesPollIds)) {
        __activeChoicesPollIds.delete(pollId);
        const st = __choicesState[pollId];
        if (st) st.accepting = false;
        void fetch(`${BACKEND}/api/choices/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pollId }),
        }).catch(() => {});
      }
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
  ensureTimerPolling(engine, model, stage);
  ensureChoicesPolling(engine, model, stage);
  ensureSoundStreaming(engine, model, stage);
  ensureGraphRendering(engine);
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
      (window as any).__ip_exitCompositeEdit?.();
    } catch {}
    try {
      (window as any).__ip_exitGroupEdit?.();
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
      ensureTimerPolling(engine, model, stage);
      ensureChoicesPolling(engine, model, stage);
      ensureSoundStreaming(engine, model, stage);
      ensureGraphRendering(engine);
      attachEditor(stage, engine);
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

    // Debug-only: diagnose missing join QR.
    if (DEBUG_ANIM) {
      try {
        const vcur = viewsInOrder[viewIdx];
        const hasJoin = showSet.has("join_qr");
        const hasCue = cues.some((c) => c.id === "join_qr" && c.when === "enter");
        if (hasJoin && !hasCue) {
          // eslint-disable-next-line no-console
          console.warn("[ip] join_qr is in view but has no enter cue; it will not animate in", { view: vcur?.id });
        }
        if (!hasJoin) {
          // eslint-disable-next-line no-console
          console.warn("[ip] join_qr is not part of the current view; it will not appear here", { view: vcur?.id });
        }
      } catch {}
    }
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
    // If we're editing a composite group, this button acts as "Exit group edit".
    if ((window as any).__ip_exitCompositeEdit) {
      try {
        (window as any).__ip_exitCompositeEdit();
      } catch {}
      return;
    }
    // Regular group edit should also use this button as "Exit group edit".
    if ((window as any).__ip_exitGroupEdit) {
      try {
        (window as any).__ip_exitGroupEdit();
      } catch {}
      return;
    }
    if ((window as any).__ip_exitScreenEdit) {
      try {
        (window as any).__ip_exitScreenEdit();
      } catch {}
      return;
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
    // eslint-disable-next-line no-console
    console.error(err);
    const app = document.querySelector<HTMLDivElement>("#app");
    if (app) app.textContent = String(err);
  }
}


