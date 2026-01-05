import type { PresentationModel } from "@interactive/content";
import { Engine, screenToWorld } from "@interactive/engine";
import { DEBUG_ANIM, dlog, BACKEND } from "./config";
import { fetchModel, preloadImageAssets, saveModel } from "./api/presentation";
import { uploadImageToMedia, loadImageSize } from "./api/media";
import { hydrateQrImages } from "./features/qr";
import { hydrateTextMath, renderTextToElement, renderTextWithKatexToHtml } from "./features/textMath";
import { drawTicksAndLabels, niceStepFromCandidates, prepareCanvas } from "./features/plot2d";
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

function _plotRectCss(nodeEl: HTMLElement) {
  const r = nodeEl.getBoundingClientRect();
  const ox = r.left + PLOT_FRACS.leftF * r.width;
  const oy = r.top + PLOT_FRACS.bottomF * r.height;
  const xLen = (PLOT_FRACS.rightF - PLOT_FRACS.leftF) * r.width;
  const yLen = (PLOT_FRACS.bottomF - PLOT_FRACS.topF) * r.height;
  const top = r.top + PLOT_FRACS.topF * r.height;
  const bottom = r.top + PLOT_FRACS.bottomF * r.height;
  return { r, ox, oy, xLen, yLen, top, bottom };
}

function _isInsidePlot(nodeEl: HTMLElement, clientX: number, clientY: number) {
  const { ox, xLen, top, bottom } = _plotRectCss(nodeEl);
  return clientX >= ox && clientX <= ox + xLen && clientY >= top && clientY <= bottom;
}

function _clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function _niceTicks(
  minV: number,
  maxV: number,
  targetTicks: number,
  candidates: number[],
  fmt: (v: number) => string
): Array<{ frac: number; label: string; value: number }> {
  const a = Number(minV);
  const b = Number(maxV);
  const span = Math.max(1e-12, b - a);
  const step = niceStepFromCandidates(span, targetTicks, candidates);
  // Use a stable tick start even for negative mins.
  const start = Math.ceil((a - 1e-12) / step) * step;
  const out: Array<{ frac: number; label: string; value: number }> = [];
  for (let v = start; v <= b + 1e-9; v += step) {
    const f = (v - a) / span;
    out.push({ frac: f, label: fmt(v), value: v });
    if (out.length > 200) break;
  }
  return out;
}

function _drawGrid(
  ctx: CanvasRenderingContext2D,
  plot: { ox: number; oy: number; xLen: number; yLen: number },
  dpr: number,
  xTicks: Array<{ xFrac: number }>,
  yTicks: Array<{ yFrac: number }>
) {
  const { ox, oy, xLen, yLen } = plot;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = Math.max(1, 1 * dpr);
  for (const t of xTicks) {
    const x = ox + t.xFrac * xLen;
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x, oy - yLen);
    ctx.stroke();
  }
  for (const t of yTicks) {
    const y = oy - t.yFrac * yLen;
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.lineTo(ox + xLen, y);
    ctx.stroke();
  }
  ctx.restore();
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

function drawChoicesPie(el: HTMLElement, opts: Array<{ color?: string; votes: number }>) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.choices-chart-canvas");
  if (!canvas) return;
  // Skip when hidden.
  if (el.offsetParent === null) return;
  const r = el.getBoundingClientRect();
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
  const r0 = Math.max(10, Math.min(W, H) / 2 - 4);
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
  const bullet = String(state?.bullets ?? (node?.bullets ?? "A"));
  const optsFromNode: Array<any> = Array.isArray(node?.options) ? node.options : [];
  const resultsVisible = true;
  el.dataset.resultsVisible = "1";

  if (question) question.textContent = state?.question || node?.question || "Poll";
  if (startBtn) startBtn.textContent = accepting ? "Stop" : "Run";
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
      if (opt.color) {
        swatch.style.background = opt.color;
        swatch.style.borderColor = opt.color;
      }
      const text = document.createElement("span");
      text.textContent = `${bulletFor(idx, bullet)} ${opt.label ?? `Option ${idx + 1}`}`;
      label.append(swatch, text);

      const meta = document.createElement("div");
      meta.className = "choices-meta";
      if (totalVotes <= 0) {
        meta.textContent = "-";
      } else {
        const pct = Math.round(opt.percent ?? 0);
        meta.textContent = `${opt.votes} vote${opt.votes === 1 ? "" : "s"} • ${pct}%`;
      }

      row.append(label, meta);
      list.appendChild(row);
    });
  }

  // Always render bullets + chart together (animations can hide/reveal if desired).
  const bulletsGroup = el.querySelector<HTMLElement>(".choices-bullets");
  const wheelGroup = el.querySelector<HTMLElement>(".choices-wheel-group");
  if (bulletsGroup) bulletsGroup.style.display = "flex";
  if (wheelGroup) wheelGroup.style.display = "block";

  const includeLimit = Number(node?.includeLimit ?? node?.minPct ?? node?.min ?? el.dataset.includeLimit ?? "3");
  const textInsideLimit = Number(node?.textInsideLimit ?? node?.minInsidePct ?? node?.minInside ?? el.dataset.textInsideLimit ?? "6");
  const otherLabel = String(node?.otherLabel ?? el.dataset.otherLabel ?? "Other") || "Other";

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
      big.push({ id: String(o.id ?? ""), color: o.color, votes: v, percent: totalVotes > 0 ? p : (NaN as any), label: o.label });
    }
  }
  if (otherVotes > 0) big.push({ id: "other", color: "rgba(255,255,255,0.35)", votes: otherVotes, percent: otherPercent, label: otherLabel });
  drawChoicesPie(el, big.map((o) => ({ color: o.color, votes: o.votes })));
  renderChoicesWheelOverlay(engine, String(node?.id ?? ""), big, { totalVotes, otherLabel, textInsideLimit });
}

function ensureChoicesWheelLayer(engine: Engine, pollId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === pollId) as any;
  const el = engine.getNodeElement(pollId);
  if (!node || !el) return null;
  const wheel = el.querySelector<HTMLElement>(".choices-wheel");
  if (!wheel) return null;

  let layer = wheel.querySelector<HTMLElement>(":scope > .choices-wheel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "choices-wheel-layer";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    wheel.style.position = wheel.style.position || "absolute";
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
    const templates: Record<string, string> = {};
    for (const ln0 of elementsPr.split(/\r?\n/)) {
      const ln = ln0.trim();
      if (!ln || ln.startsWith("#")) continue;
      const mt = ln.match(/^text\[name=(?<id>[a-zA-Z_]\w*)\]\s*:\s*(?<content>.*)$/);
      if (mt?.groups) templates[mt.groups.id] = mt.groups.content ?? "";
    }
    (layer as any).__templates = templates;
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
  const prep = prepareCanvas(el, canvas, { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 });
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

  const xTickVals = _niceTicks(xMin, xMax, 7, [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60], fmt);
  const xTicks = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
  const yTicks: Array<{ yFrac: number; label: string }> = [];
  // y is a fraction (0..1-ish). Show labels in %.
  const yTickVals = _niceTicks(yMin, yMax, 6, [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1], (v) => {
    const p = v * 100;
    const s = Math.abs(p - Math.round(p)) < 1e-9 ? String(Math.round(p)) : p.toFixed(1);
    return s.replace(/\.0$/, "");
  });
  for (const t of yTickVals) yTicks.push({ yFrac: t.frac, label: t.label });

  if (gridOn) _drawGrid(ctx, plot, dpr, xTicks, yTicks);

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

  drawTicksAndLabels({ ctx, plot, rectCss: r, dpr, lineWidthPx, xTicks, yTicks });

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

  const startBtn = el.querySelector<HTMLButtonElement>('button[data-action="timer-startstop"]');
  if (startBtn) startBtn.textContent = state.accepting ? "Stop" : "Start";

  // In global Edit mode, hide the timer overlay shading (data-rect background).
  const mode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  const bg = el.querySelector<HTMLElement>(".timer-overlay-bg");
  if (bg) bg.style.display = mode === "edit" ? "none" : "block";
}

function drawSoundNode(el: HTMLElement, state: SoundState) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.sound-canvas");
  if (!canvas) return;
  const prep = prepareCanvas(el, canvas, { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 });
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
    if (n <= 1) return;
    // Keep a bit of headroom so it doesn't look pegged.
    const maxYAuto = Math.max(1e-9, Math.max(...ys) * 1.05);

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
    const yMax = pr0?.yMax ?? maxYAuto;
    const xSpan = Math.max(1e-9, xMax - xMin);
    const ySpan = Math.max(1e-9, yMax - yMin);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 2 * dpr);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const xVal = (i / (n - 1)) * windowS;
      const xf = (xVal - xMin) / xSpan;
      const x = ox + xf * xLen;
      const yv = (ys[i] - yMin) / ySpan;
      const y = oy - yv * yLen;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Timer-like ticks/labels
    const lineWidthPx = 2;
    const fmtS = (v: number) => String(Math.round(v * 100) / 100).replace(/\.0+$/, "");
    const xTickVals = _niceTicks(xMin, xMax, 6, [0.5, 1, 2, 5, 10, 15, 30, 60], fmtS);
    const xTicks: Array<{ xFrac: number; label: string }> = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
    const yTickVals = _niceTicks(yMin, yMax, 6, [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1], (v) => {
      const s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      return s || "0";
    });
    const yTicks: Array<{ yFrac: number; label: string }> = yTickVals.map((t) => ({ yFrac: t.frac, label: t.label }));
    if (gridOn) _drawGrid(ctx, plot, dpr, xTicks, yTicks);
    drawTicksAndLabels({ ctx, plot, rectCss: r, dpr, lineWidthPx, xTicks, yTicks });
    return;
  }

  // spectrum
  const f = state.spectrum?.freqHz ?? [];
  const m = state.spectrum?.magDb ?? [];
  const n2 = Math.min(f.length, m.length);
  if (n2 <= 1) return;
  // Show up to 8kHz by default (good for speech); clamp if SR is lower.
  const maxHzAuto = Math.min(8000, Math.max(...f));
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
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, 2 * dpr);
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

  // Spectrum ticks (timer-like)
  {
    const lineWidthPx = 2;
    const xTickVals = _niceTicks(xMin, xMax, 6, [50, 100, 200, 500, 1000, 2000, 4000, 8000, 16000], (v) => String(Math.round(v)));
    const xTicks: Array<{ xFrac: number; label: string }> = xTickVals.map((t) => ({ xFrac: t.frac, label: t.label }));
    const yTickVals = _niceTicks(yMin, yMax, 6, [5, 10, 20, 30, 40, 60], (v) => String(Math.round(v)));
    const yTicks: Array<{ yFrac: number; label: string }> = yTickVals.map((t) => ({ yFrac: t.frac, label: t.label }));
    if (gridOn) _drawGrid(ctx, plot, dpr, xTicks, yTicks);
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
      ev.preventDefault();
      return;
    }
    if (action === "timer-reset") {
      await fetch(`${BACKEND}/api/timer/reset`, { method: "POST" });
      __timerState = await fetchTimerState();
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
        btn.textContent = (st0.seq ?? 0) > 0 ? "Resume" : "Run";
        void fetch(`${BACKEND}/api/sound/pause`, { method: "POST" }).finally(async () => {
          const st = await fetchSoundState();
          if (st) __soundState = st;
        });
      } else {
        (__soundState as any) = { ...st0, enabled: true, error: null };
        btn.textContent = "Pause";
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

function ensureTimerCompositeLayer(engine: Engine, timerId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => n.id === timerId) as any;
  const el = engine.getNodeElement(timerId);
  if (!node || !el) return null;

  const frame = el.querySelector<HTMLElement>(":scope .timer-frame");
  if (!frame) return null;

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

    const geoms: Record<string, any> = node.compositeGeometries ?? {};
    const text = String(node.elementsText ?? "");
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

      // arrow[name=id,from=(x,y),to=(x,y),color=...,width=...]
      const ma = ln.match(
        /^arrow\[name=(?<id>[a-zA-Z_]\w*),from=\((?<x0>-?(?:\d+\.?\d*|\.\d+)),(?<y0>-?(?:\d+\.?\d*|\.\d+))\),to=\((?<x1>-?(?:\d+\.?\d*|\.\d+)),(?<y1>-?(?:\d+\.?\d*|\.\d+))\)(?:,color=(?<color>[^,\]]+))?(?:,width=(?<width>-?(?:\d+\.?\d*|\.\d+)))?\]$/
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
    (layer as any).__elementsText = text;
  }

  return layer;
}

function renderTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
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
    const fontPx = Math.max(16, timerBox.height * h * 0.85);
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
    const fontPx = Math.max(16, timerBox.height * h * 0.85);
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

  // Map arrow coordinates in "data-rect space":
  // u in [0..1] across x, v in [0..1] up y. Allow >1 to extend beyond the rect.
  // This matches the plot area used by drawTimerNode().
  const leftF = 0.08;
  const rightF = 0.92;
  const topF = 0.10;
  const bottomF = 0.90;
  const ox = leftF * w;
  const oy = bottomF * h;
  const xLen = (rightF - leftF) * w;
  const yLen = (bottomF - topF) * h;
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
            const data: Record<string, string | number> = {
              name: n.id,
              mean: countN > 0 && st ? fmtS(st.stats.meanMs) : "-",
              sigma: countN > 1 && st ? fmtS(st.stats.sigmaMs) : "-",
              count: countN > 0 ? String(countN) : "-",
            };
            renderTimerCompositeTexts(el, layer, data);
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
      const st = __timerState;
      if (st) {
        const cur = engine.getModel();
        if (cur) {
          for (const n of cur.nodes) {
            if (n.type !== "timer") continue;
            const el = engine.getNodeElement(n.id);
            if (el) drawTimerNode(el, st);
          }
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
                renderSoundCompositeTexts(el, layer, data);
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
    };
  } catch {
    // fallback to polling
    window.setInterval(async () => {
      const st = await fetchSoundState();
      if (st) __soundState = st;
    }, 200);
  }
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

    const geoms: Record<string, any> = node.compositeGeometries ?? {};
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
        d.style.whiteSpace = "nowrap";
        d.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
        d.style.fontWeight = "400";
        d.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
        const rot = Number(g.rotationDeg ?? 0);
        if (rot) d.style.rotate = `${rot}deg`;
        layer.append(d);
        continue;
      }

      const ma = ln.match(
        /^arrow\[name=(?<id>[a-zA-Z_]\w*),from=\((?<x0>-?(?:\d+\.?\d*|\.\d+)),(?<y0>-?(?:\d+\.?\d*|\.\d+))\),to=\((?<x1>-?(?:\d+\.?\d*|\.\d+)),(?<y1>-?(?:\d+\.?\d*|\.\d+))\)(?:,color=(?<color>[^,\]]+))?(?:,width=(?<width>-?(?:\d+\.?\d*|\.\d+)))?\]$/
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
    (layer as any).__elementsText = text;
  }
  return layer;
}

function renderSoundCompositeTexts(soundEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .sound-sub-text"));
  const hPx = Number(soundEl.dataset.soundHpx ?? "0");
  const wPx = Number(soundEl.dataset.soundWpx ?? "0");
  const box = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : soundEl.getBoundingClientRect();
  const isGroupEditing = soundEl.dataset.compositeEditing === "1";
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

  const leftF = 0.08;
  const rightF = 0.92;
  const topF = 0.10;
  const bottomF = 0.90;
  const ox = leftF * w;
  const oy = bottomF * h;
  const xLen = (rightF - leftF) * w;
  const yLen = (bottomF - topF) * h;
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

type DragMode = "none" | "move" | "resize" | "rotate";

function getAppMode(): "edit" | "live" {
  const raw =
    (document.documentElement.dataset.ipMode ??
      document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ??
      "edit") + "";
  return raw.toLowerCase() === "live" ? "live" : "edit";
}

function ensureHandles(el: HTMLElement) {
  // Safety: never show transform UI in Live mode.
  if (getAppMode() !== "edit") {
    el.querySelector(":scope > .handles")?.remove();
    return null;
  }
  let handles = el.querySelector<HTMLDivElement>(":scope > .handles");

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

  if (handles) {
    updateAnchorDots(handles);
    return handles;
  }
  handles = document.createElement("div");
  handles.className = "handles";
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
  // - strips located 5..20px outside each edge for resize
  // - squares located 5..20px outside corners:
  //   - top corners: rotate
  //   - bottom corners: scale (diagonal)
  const px15 = "15px";
  const px20 = "20px";
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
    d.style.width = px15;
    d.style.height = px15;
    d.style.transform = "none";
    return d;
  };

  handles.append(
    // edge resize strips (outside)
    mkStrip("n", "0", `-${px20}`, "100%", px15, "edge edge-n"),
    mkStrip("e", "calc(100% + 5px)", "0", px15, "100%", "edge edge-e"),
    mkStrip("s", "0", "calc(100% + 5px)", "100%", px15, "edge edge-s"),
    mkStrip("w", `-${px20}`, "0", px15, "100%", "edge edge-w"),

    // corner squares (outside)
    mkCorner("rot-tl", `-${px20}`, `-${px20}`, "corner rot rot-tl"),
    mkCorner("rot-tr", "calc(100% + 5px)", `-${px20}`, "corner rot rot-tr"),
    mkCorner("sw", `-${px20}`, "calc(100% + 5px)", "corner scale scale-sw"),
    mkCorner("se", "calc(100% + 5px)", "calc(100% + 5px)", "corner scale scale-se")
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

  // Simple top toolbox (edit mode): pick what to place.
  let tool: "select" | "text" | "bullets" | "arrow" = "select";
  let arrowDraft:
    | null
    | {
        start: { x: number; y: number };
        space: "world" | "screen";
        previewEl: HTMLElement;
        lineEl: SVGLineElement;
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
    </svg>`
  };
  toolbox.append(
    mkToolBtn("select", "Select", ICON.select),
    mkToolBtn("text", "Text", ICON.text),
    mkToolBtn("bullets", "Bullets", ICON.bullets),
    mkToolBtn("arrow", "Arrow", ICON.arrow)
  );
  // Default active button
  (toolbox.querySelector<HTMLButtonElement>("button") as any)?.click?.();
  // Avoid duplicating if attachEditor is called multiple times.
  document.querySelector(".edit-toolbox")?.remove();
  document.body.appendChild(toolbox);

  const undoStack: PresentationModel[] = [];
  const redoStack: PresentationModel[] = [];
  const cloneModel = (m: PresentationModel): PresentationModel => JSON.parse(JSON.stringify(m)) as PresentationModel;

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

  const resolveSelectableId = (id0: string) => {
    const m = engine.getModel();
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

  // Context menu (edit mode): add nodes / group selection.
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.position = "fixed";
  menu.style.zIndex = "99999";
  menu.style.minWidth = "180px";
  menu.style.padding = "6px";
  menu.style.borderRadius = "10px";
  menu.style.border = "1px solid rgba(255,255,255,0.16)";
  menu.style.background = "rgba(15,17,24,0.96)";
  menu.style.boxShadow = "0 12px 40px rgba(0,0,0,0.45)";
  menu.style.display = "none";
  const hideMenu = () => (menu.style.display = "none");
  document.body.append(menu);
  window.addEventListener("pointerdown", (ev) => {
    if (menu.style.display !== "none" && !menu.contains(ev.target as any)) hideMenu();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideMenu();
  });

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

    const minSize = 10;
    const x0 = Math.min(from.x, to.x);
    const y0 = Math.min(from.y, to.y);
    const w0 = Math.max(minSize, Math.abs(to.x - from.x));
    const h0 = Math.max(minSize, Math.abs(to.y - from.y));
    const fx = (from.x - x0) / w0;
    const fy = (from.y - y0) / h0;
    const tx = (to.x - x0) / w0;
    const ty = (to.y - y0) / h0;

    const scr = engine.getScreen();
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
      width: 0.02,
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

  // Placement tool handler (capture) so it runs before selection/pan handlers.
  stage.addEventListener(
    "pointerdown",
    (ev) => {
      if (getAppMode() !== "edit") return;
      if (tool === "select") return;
      const t = ev.target as HTMLElement;
      // Don’t interfere with normal manipulation when clicking nodes/handles/UI.
      if (
        t.closest(".edit-toolbox") ||
        t.closest(".node") ||
        t.closest(".handles") ||
        t.closest(".modal") ||
        t.closest(".ctx-menu") ||
        t.closest(".mode-toggle")
      )
        return;

      const r = stage.getBoundingClientRect();
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const space: "world" | "screen" = screenEditMode ? "screen" : "world";
      const pos = space === "screen" ? screenPos : screenToWorld(screenPos, cam as any, scr as any);

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
      if (tool === "arrow") {
        // Create a lightweight preview overlay (not part of the model).
        const preview = document.createElement("div");
        preview.style.position = "absolute";
        preview.style.left = `${pos.x}px`;
        preview.style.top = `${pos.y}px`;
        preview.style.width = "1px";
        preview.style.height = "1px";
        preview.style.pointerEvents = "none";
        preview.style.overflow = "visible";

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "1");
        svg.setAttribute("height", "1");
        svg.setAttribute("viewBox", "0 0 100 100");
        (svg.style as any).overflow = "visible";

        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
        marker.setAttribute("id", "arrowhead-preview");
        marker.setAttribute("markerWidth", "10");
        marker.setAttribute("markerHeight", "10");
        marker.setAttribute("refX", "10");
        marker.setAttribute("refY", "5");
        marker.setAttribute("orient", "auto");
        marker.setAttribute("markerUnits", "strokeWidth");
        const pth = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pth.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
        pth.setAttribute("fill", "white");
        marker.appendChild(pth);
        defs.appendChild(marker);
        svg.appendChild(defs);

        const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
        ln.setAttribute("x1", "0");
        ln.setAttribute("y1", "0");
        ln.setAttribute("x2", "100");
        ln.setAttribute("y2", "0");
        ln.setAttribute("stroke", "white");
        ln.setAttribute("stroke-width", "2");
        ln.setAttribute("stroke-linecap", "round");
        ln.setAttribute("marker-end", "url(#arrowhead-preview)");
        svg.appendChild(ln);

        preview.appendChild(svg);
        // Use overlay for consistent positioning.
        const overlay = engine.getNodeElement("__nonexistent__")?.parentElement ?? stage.querySelector<HTMLElement>(".overlay") ?? stage;
        overlay.appendChild(preview);

        arrowDraft = { start: pos, space, previewEl: preview, lineEl: ln };
        (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
        ev.preventDefault();
        (ev as any).stopImmediatePropagation?.();
      }
    },
    { capture: true }
  );

  stage.addEventListener(
    "pointermove",
    (ev) => {
      if (!arrowDraft) return;
      const r = stage.getBoundingClientRect();
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const pos = arrowDraft.space === "screen" ? screenPos : screenToWorld(screenPos, cam as any, scr as any);
      const dx = pos.x - arrowDraft.start.x;
      const dy = pos.y - arrowDraft.start.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = (dx / len) * 100;
      const uy = (dy / len) * 100;
      arrowDraft.lineEl.setAttribute("x2", String(ux));
      arrowDraft.lineEl.setAttribute("y2", String(uy));
    },
    { capture: true }
  );

  stage.addEventListener(
    "pointerup",
    (ev) => {
      if (!arrowDraft) return;
      const r = stage.getBoundingClientRect();
      const cam = engine.getCamera();
      const scr = engine.getScreen();
      const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const end = arrowDraft.space === "screen" ? screenPos : screenToWorld(screenPos, cam as any, scr as any);
      const start = arrowDraft.start;
      arrowDraft.previewEl.remove();
      const space = arrowDraft.space;
      arrowDraft = null;
      void addArrowFromTo(start, end, { space });
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
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

  stage.addEventListener("contextmenu", (ev) => {
    const mode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
    if (mode !== "edit") return;
    ev.preventDefault();

    activeViewId = getActiveViewId();

    const r = stage.getBoundingClientRect();
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    if (screenEditMode) {
      lastContextScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      lastContextWorld = null;
    } else {
      lastContextWorld = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam as any, scr as any);
      lastContextScreen = null;
    }

    const target = ev.target as HTMLElement;
    const nodeEl = target.closest<HTMLElement>(".node");
    if (nodeEl?.dataset.nodeId) {
      const id = resolveSelectableId(nodeEl.dataset.nodeId);
      if (!selected.has(id)) {
        selected.clear();
        selected.add(id);
        applySelection();
      }
    }

    menu.replaceChildren();
    const mkItem = (label: string, enabled: boolean, onClick: () => Promise<void> | void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.width = "100%";
      b.style.textAlign = "left";
      b.style.padding = "10px 10px";
      b.style.border = "0";
      b.style.borderRadius = "8px";
      b.style.background = enabled ? "transparent" : "rgba(255,255,255,0.06)";
      b.style.color = enabled ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.40)";
      b.style.cursor = enabled ? "pointer" : "not-allowed";
      b.addEventListener("click", async () => {
        if (!enabled) return;
        hideMenu();
        await onClick();
      });
      b.addEventListener("pointerenter", () => {
        if (!enabled) return;
        b.style.background = "rgba(255,255,255,0.08)";
      });
      b.addEventListener("pointerleave", () => {
        b.style.background = enabled ? "transparent" : "rgba(255,255,255,0.06)";
      });
      return b;
    };

    const canAdd = screenEditMode ? !!lastContextScreen : !!lastContextWorld;

    menu.append(
      mkItem(
        "Add text",
        canAdd,
        () =>
          addTextAt(
            (screenEditMode ? lastContextScreen : lastContextWorld) || { x: 0, y: 0 },
            { space: screenEditMode ? "screen" : "world" }
          )
      ),
      mkItem(
        "Add bullets",
        canAdd,
        () =>
          addBulletsAt(
            (screenEditMode ? lastContextScreen : lastContextWorld) || { x: 0, y: 0 },
            { space: screenEditMode ? "screen" : "world" }
          )
      ),
      mkItem(
        "Add table",
        canAdd,
        () =>
          addTableAt(
            (screenEditMode ? lastContextScreen : lastContextWorld) || { x: 0, y: 0 },
            { space: screenEditMode ? "screen" : "world" }
          )
      ),
      mkItem("Add image…", canAdd, async () => {
        (window as any).__ip_pickImage?.(
          (screenEditMode ? lastContextScreen : lastContextWorld) || { x: 0, y: 0 },
          screenEditMode ? "screen" : "world"
        );
      }),
      mkItem("Group selection", selected.size >= 2, () => groupSelection())
    );

    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    menu.style.display = "block";
  });

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

  const cursorForHandle = (h: string | null) => {
    if (!h) return "";
    if (h === "rot" || h.startsWith("rot-")) return "grab";
    if (h === "n" || h === "s") return "ns-resize";
    if (h === "e" || h === "w") return "ew-resize";
    if (h === "nw" || h === "se") return "nwse-resize";
    if (h === "ne" || h === "sw") return "nesw-resize";
    return "";
  };
  const setBodyCursor = (c: string) => {
    document.documentElement.style.cursor = c || "";
  };

  const applySelection = () => {
    const model = engine.getModel();
    if (!model) return;
    const canShowTransformUi = getAppMode() === "edit";
    for (const n of model.nodes) {
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      const isSel = canShowTransformUi && selected.has(n.id);
      el.classList.toggle("is-selected", isSel);
      if (!canShowTransformUi) {
        el.querySelector(".handles")?.remove();
        continue;
      }
      if (isSel && selected.size === 1) {
        // While editing a composite (timer), never show handles for the composite itself.
        if (compositeEditTimerId && n.id === compositeEditTimerId) el.querySelector(".handles")?.remove();
        else ensureHandles(el);
      }
      if (!isSel || selected.size !== 1) el.querySelector(".handles")?.remove();
    }
  };

  const clearSelection = () => {
    selected.clear();
    applySelection();
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

  const deleteSelection = async () => {
    const model = engine.getModel();
    if (!model) return;
    if (selected.size === 0) return;
    const before = cloneModel(model);

    const del = new Set(selected);
    model.nodes = model.nodes.filter((n) => !del.has(n.id));
    for (const v of model.views) v.show = v.show.filter((id) => !del.has(id));
    engine.setModel(model);
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
      (window as any).__ip_clipboard = getSelectedNodes().map((n) => JSON.parse(JSON.stringify(n)));
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "x") {
      (window as any).__ip_clipboard = getSelectedNodes().map((n) => JSON.parse(JSON.stringify(n)));
      await deleteSelection();
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
  const compositeGeomsByPath: Record<string, any> = {};
  let compositeHiddenEls: HTMLElement[] = [];
  let compositeSelectedSubId: string | null = null;
  let compositeSelectedSubEl: HTMLElement | null = null;
  let compositeDragMode: "none" | "move" | "resize" | "rotate" = "none";
  let compositeActiveHandle: string | null = null;
  let compositeStart = { x: 0, y: 0 };
  let compositeStartGeom: any = null;
  let compositeGrabOff = { x: 0, y: 0 };
  let compositeStartAngleRad = 0;
  let compositeStartRotationDeg = 0;
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

  // Screen edit mode (edit only): isolate and edit screen-space nodes.
  exitScreenEdit = () => {
    if (!screenEditMode) return;
    for (const e of screenDimmedEls) {
      e.classList.remove("ip-dim-node");
      e.style.pointerEvents = "";
    }
    screenDimmedEls = [];
    screenEditMode = false;
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

  const enterTimerCompositeEdit = (timerId: string) => {
    // Avoid conflicting isolate modes.
    exitScreenEdit();
    compositeEditKind = "timer";
    compositeEditTimerId = timerId;
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
    // Seed editable geoms for this composite folder.
    compositeGeomsByPath[timerId] = (layer as any)?.__textGeoms ?? {};
    for (const sub of Array.from(layer?.querySelectorAll<HTMLElement>(".comp-sub") ?? [])) {
      sub.style.pointerEvents = "auto";
      sub.style.cursor = "grab";
      // Keep clean while editing (no frames).
      sub.style.border = "none";
      sub.style.background = "transparent";
      sub.style.borderRadius = "0";
      sub.style.padding = "0";
    }

    // Update mode button label while editing a group.
    const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (modeBtn) modeBtn.textContent = "Exit group edit";
    (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
    (window as any).__ip_compositeEditing = true;
  };

  const enterChoicesCompositeEdit = (pollId: string) => {
    // Avoid conflicting isolate modes.
    exitScreenEdit();
    compositeEditKind = "choices";
    compositeEditTimerId = pollId;
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

    // Make bullets the "main" editable element by default.
    const bulletsEl = el.querySelector<HTMLElement>(".choices-bullets.comp-sub");
    if (bulletsEl) {
      for (const e3 of Array.from(el.querySelectorAll<HTMLElement>(".comp-sub"))) e3.classList.remove("is-selected");
      bulletsEl.classList.add("is-selected");
      ensureHandles(bulletsEl);
      compositeEditPath = String(bulletsEl.dataset.compPath || pollId);
      compositeSelectedSubId = bulletsEl.dataset.subId ?? "bullets";
      compositeSelectedSubEl = bulletsEl;
    }

    const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (modeBtn) modeBtn.textContent = "Exit group edit";
    (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
    (window as any).__ip_compositeEditing = true;
  };

  const enterSoundCompositeEdit = (soundId: string) => {
    // Avoid conflicting isolate modes.
    exitScreenEdit();
    compositeEditKind = "sound";
    compositeEditTimerId = soundId;
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
    for (const sub of Array.from(layer?.querySelectorAll<HTMLElement>(".comp-sub") ?? [])) {
      sub.style.pointerEvents = "auto";
      sub.style.cursor = "grab";
      sub.style.border = "none";
      sub.style.background = "transparent";
      sub.style.borderRadius = "0";
      sub.style.padding = "0";
    }
    const modeBtn = document.querySelector<HTMLButtonElement>(".mode-toggle button");
    if (modeBtn) modeBtn.textContent = "Exit group edit";
    (window as any).__ip_exitCompositeEdit = exitTimerCompositeEdit;
    (window as any).__ip_compositeEditing = true;
  };

  const exitTimerCompositeEdit = () => {
    if (!compositeEditTimerId) return;
    const el = engine.getNodeElement(compositeEditTimerId);
    if (compositeEditKind === "timer") {
      const ov = el?.querySelector<HTMLElement>(".timer-overlay");
      if (ov) ov.style.display = "block";
      const layer = el?.querySelector<HTMLElement>(".timer-sub-layer");
      if (layer) layer.style.pointerEvents = "none";
    } else if (compositeEditKind === "sound") {
      const ov = el?.querySelector<HTMLElement>(".sound-overlay");
      if (ov) ov.style.display = "block";
      const layer = el?.querySelector<HTMLElement>(".sound-sub-layer");
      if (layer) layer.style.pointerEvents = "none";
      if (el) el.dataset.compositeEditing = "0";
    } else {
      const layer = el?.querySelector<HTMLElement>(".choices-sub-layer");
      // Keep interactive so dblclick on bullets enters group edit (no "screen edit" by accident).
      if (layer) layer.style.pointerEvents = "auto";
    }
    for (const e2 of compositeHiddenEls) e2.classList.remove("ip-dim-node");
    compositeHiddenEls = [];
    compositeEditTimerId = null;
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

      // Update the stored elements.txt (single-line text syntax).
      const src = String((layer as any).__elementsText ?? "");
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
      (layer as any).__elementsText = nextText;

      // Persist elementsText (and current geoms) to backend.
      const geoms: any = (layer as any).__textGeoms ?? {};
      void fetch(`${BACKEND}/api/composite/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compositePath: timerId, geoms, elementsText: nextText })
      });
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
      void fetch(`${BACKEND}/api/composite/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compositePath: `${pollId}/wheel`, geoms, elementsPr: nextText })
      });
      close();
    });
  };

  stage.addEventListener("dblclick", async (ev) => {
    // Hard block: Live mode must be resistant to any editing gestures.
    if (getAppMode() !== "edit") return;
    const target = ev.target as HTMLElement;

    // Background double-click behavior:
    // - If in group edit: exit group edit.
    // - Else if in screen edit: exit screen edit.
    // - Else: enter screen edit.
    if (!target.closest(".node") && !target.closest(".modal") && !target.closest(".ctx-menu") && !target.closest(".edit-toolbox")) {
      if ((window as any).__ip_exitCompositeEdit) {
        (window as any).__ip_exitCompositeEdit?.();
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
    const nodeEl = target.closest<HTMLElement>(".node");
    const id = nodeEl?.dataset.nodeId;
    if (!id) {
      return;
    }
    const model = engine.getModel();
    const node = model?.nodes.find((n) => n.id === id) as any;

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
    const sub = t.closest<HTMLElement>(".comp-sub");
    if (!sub) return;
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
    // Preserve cursor-to-anchor offset to avoid the “jump” on drag start.
    const px = (ev.clientX - box.left) / box.width;
    const py = (ev.clientY - box.top) / box.height;
    compositeGrabOff = { x: px - compositeStartGeom.x, y: py - compositeStartGeom.y };

    if (handleEl?.dataset.handle) {
      compositeActiveHandle = handleEl.dataset.handle;
      compositeDragMode = compositeActiveHandle === "rot" ? "rotate" : "resize";
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
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    // Prevent the normal selection/rotate handler from selecting the timer node while we're editing sub-elements.
    (ev as any).stopImmediatePropagation?.();
    ev.preventDefault();
  });

  stage.addEventListener("pointermove", (ev) => {
    // Hard block: Live mode must be resistant to any editing gestures.
    if (getAppMode() !== "edit") return;
    if (!compositeEditTimerId || compositeDragMode === "none" || !compositeSelectedSubEl || !compositeStartGeom) return;
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

    if (compositeDragMode === "move") {
      const px = (ev.clientX - box.left) / box.width;
      const py = (ev.clientY - box.top) / box.height;
      let nx = px - compositeGrabOff.x;
      let ny = py - compositeGrabOff.y;
      if (ev.shiftKey) {
        const step = 0.01;
        nx = Math.round(nx / step) * step;
        ny = Math.round(ny / step) * step;
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
      const forceUniform =
        compositeEditKind === "choices" && (sid === "wheel" || sid === "pie"); // keep wheel aspect

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

      // Back to anchor point
      const ap = topLeftToAnchorWorld(tlr, compositeStartGeom.anchor);
      rect = { x: ap.x, y: ap.y, w: tlr.w, h: tlr.h };

      sub.style.left = `${rect.x * 100}%`;
      sub.style.top = `${rect.y * 100}%`;
      sub.style.width = `${rect.w * 100}%`;
      sub.style.height = `${rect.h * 100}%`;
      if (sid) geoms[sid] = { ...(geoms[sid] ?? {}), x: rect.x, y: rect.y, w: rect.w, h: rect.h };

      // Choices composite: scale bullets content with its own sub-element size (so resizing bullets scales fonts).
      if (compositeEditKind === "choices" && sid === "bullets") {
        const baseW = Number(sub.dataset.baseW ?? String(compositeStartGeom.w ?? rect.w));
        const baseH = Number(sub.dataset.baseH ?? String(compositeStartGeom.h ?? rect.h));
        // Seed base sizes once (so scaling works both up and down).
        if (!Number.isFinite(Number(sub.dataset.baseW))) sub.dataset.baseW = String(baseW);
        if (!Number.isFinite(Number(sub.dataset.baseH))) sub.dataset.baseH = String(baseH);
        const sx = rect.w / Math.max(1e-9, baseW);
        const sy = rect.h / Math.max(1e-9, baseH);
        const localScale = Math.max(0.1, Math.min(sx, sy));
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
    if (compositeSelectedSubEl) compositeSelectedSubEl.style.cursor = "grab";

    // Persist composite geometries from the in-memory model (no DOM-rect measuring -> no jitter / size drift).
    const geoms: any = compositeGeomsByPath[compositeEditPath] ?? {};
    void fetch(`${BACKEND}/api/composite/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Save into the folder that owns the dragged element (supports nested folders).
      body: JSON.stringify({ compositePath: compositeEditPath, geoms })
    });

    compositeDragMode = "none";
    compositeActiveHandle = null;
    compositeStartGeom = null;
    setBodyCursor("");
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") (window as any).__ip_exitCompositeEdit?.();
  });

  stage.addEventListener("pointerdown", (ev) => {
    // Hard block: Live mode must be resistant to any editing gestures.
    if (getAppMode() !== "edit") return;
    const target = ev.target as HTMLElement;
    const anchorEl = target.closest<HTMLElement>(".anchor-dot");
    const handleEl = target.closest<HTMLElement>(".handle");
    const nodeEl = target.closest<HTMLElement>(".node");

    if (nodeEl?.dataset.nodeId) {
      const id = resolveSelectableId(nodeEl.dataset.nodeId);
      const model = engine.getModel();
      const node = model?.nodes.find((n) => n.id === id);
      // Only allow screen-space nodes in screen edit mode; block screen nodes when not in screen edit.
      if (screenEditMode && node && node.space !== "screen") {
        ev.preventDefault();
        return;
      }
      if (!screenEditMode && node && node.space === "screen") {
        ev.preventDefault();
        return;
      }

    // In composite edit mode:
    // - Timer/Sound: never select/rotate the composite root itself (edit sub-elements only).
    // - Choices: allow selecting/resizing the root (so the whole composite can be scaled).
    if ((compositeEditKind === "timer" || compositeEditKind === "sound") && compositeEditTimerId && id === compositeEditTimerId) {
      nodeEl.querySelector(".handles")?.remove();
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
        if (selected.has(n.id)) startNodesById[n.id] = JSON.parse(JSON.stringify(n));
      }
      start = { x: ev.clientX, y: ev.clientY };

      if (handleEl?.dataset.handle && selected.size === 1) {
        activeHandle = handleEl.dataset.handle;
        dragMode = activeHandle === "rot" || activeHandle.startsWith("rot-") ? "rotate" : "resize";
        setBodyCursor(cursorForHandle(activeHandle));
        if (dragMode === "rotate") {
          const r = nodeEl.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          startAngleRad = Math.atan2(ev.clientY - cy, ev.clientX - cx);
          startRotationDeg = node?.transform.rotationDeg ?? 0;
        }
      } else {
        dragMode = "move";
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

    if (dragMode === "move") {
      for (const id of selected) {
        const s = startNodesById[id];
        if (!s) continue;
        const sp = s.space ?? "world";
        const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
        const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);
        let nx = (s.transform?.x ?? 0) + ddx;
        let ny = (s.transform?.y ?? 0) + ddy;

        // Snap ONLY when Shift is held during dragging (requested).
        // Snap the anchor point (x,y) to active grid intersections for world-space nodes.
        if (ev.shiftKey && sp === "world") {
          const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
          const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
          nx = Math.round(nx / snapSpacing) * snapSpacing;
          ny = Math.round(ny / snapSpacing) * snapSpacing;
        }

        engine.updateNode(id, { transform: { x: nx, y: ny } as any } as any);
      }
      return;
    }

    if (selected.size !== 1) return;
    const onlyId = Array.from(selected)[0];
    const startNode = startNodesById[onlyId];
    if (!startNode) return;
    const t0 = startNode.transform;
    const sp = startNode.space ?? "world";

    if (dragMode === "rotate") {
      const el = engine.getNodeElement(onlyId);
      const r = el?.getBoundingClientRect();
      if (!r) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      const d = (a1 - startAngleRad) * (180 / Math.PI);
      let rot = startRotationDeg + d;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      engine.updateNode(onlyId, { transform: { rotationDeg: rot } as any } as any);
      return;
    }

    if (dragMode === "resize" && activeHandle) {
      const tl0 = anchorToTopLeftWorld(t0);
      let rect = { x: tl0.x, y: tl0.y, w: t0.w, h: t0.h };
      const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
      const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);
      const min = sp === "world" ? 5 : 0.01;
      const isCorner =
        activeHandle === "nw" || activeHandle === "ne" || activeHandle === "sw" || activeHandle === "se";

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

      if (isCorner) {
        const sx = activeHandle.includes("w") ? -ddx : ddx;
        const sy = activeHandle.includes("n") ? -ddy : ddy;
        const w1 = Math.max(min, t0.w + sx);
        const h1 = Math.max(min, t0.h + sy);
        const s = Math.max(w1 / Math.max(1e-9, t0.w), h1 / Math.max(1e-9, t0.h));
        rect.w = Math.max(min, t0.w * s);
        rect.h = Math.max(min, t0.h * s);
        if (activeHandle.includes("w")) rect.x = tl0.x + (t0.w - rect.w);
        if (activeHandle.includes("n")) rect.y = tl0.y + (t0.h - rect.h);

        // Corner scaling should scale text-like font size along with the box.
        if (isTextLike) {
          engine.updateNode(onlyId, { fontPx: Math.max(1, (startFontPx ?? 28) * s) } as any);
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

        // Edge resizing should NOT scale text font; initialize fontPx if missing so it stays stable.
        if (isTextLike && curNode?.fontPx == null) {
          engine.updateNode(onlyId, { fontPx: Math.max(1, startFontPx ?? 28) } as any);
        }
      }
      const anchored = topLeftToAnchorWorld(rect, t0.anchor);
      engine.updateNode(
        onlyId,
        {
          transform: { ...t0, x: anchored.x, y: anchored.y, w: rect.w, h: rect.h } as any
        } as any
      );
    }
  });

  stage.addEventListener("pointerup", async () => {
    dragMode = "none";
    activeHandle = null;
    setBodyCursor("");
    startNodesById = null;
    await commit(startSnapshot);
    startSnapshot = null;
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
    // Treat model camera.zoom as a "zoom factor" relative to fitting the design viewport height.
    const scr = engine.getScreen();
    const fit = scr.h / DESIGN_H;
    // Backend view layout uses DESIGN_W/DESIGN_H to place views one "design viewport" apart.
    // But when we fit height, the visible world width depends on the current aspect ratio.
    // Scale X offsets so adjacent views stay one viewport apart for any window size.
    const aspect = scr.w / Math.max(1, scr.h);
    const visibleWAtZoom1 = DESIGN_H * aspect;
    const xScale = visibleWAtZoom1 / Math.max(1, DESIGN_W);
    return {
      cx: baseViewCam.cx + (c.cx - baseViewCam.cx) * xScale,
      cy: baseViewCam.cy + (c.cy - baseViewCam.cy),
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


