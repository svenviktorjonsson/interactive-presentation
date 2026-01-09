export type PlotRectFracs = { leftF: number; rightF: number; topF: number; bottomF: number };

export type PlotRectPx = { ox: number; oy: number; xLen: number; yLen: number };

export type PreparedCanvas = {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  dpr: number;
  rect: DOMRect;
  plot: PlotRectPx;
};

export type Tick = { frac: number; label: string; value: number };

export function prepareCanvas(el: HTMLElement, canvas: HTMLCanvasElement, fracs: PlotRectFracs): PreparedCanvas | null {
  if (el.offsetParent === null) return null;
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(2, Math.round(r.width * dpr));
  const H = Math.max(2, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const ox = fracs.leftF * W;
  const oy = fracs.bottomF * H;
  const xLen = (fracs.rightF - fracs.leftF) * W;
  const yLen = (fracs.bottomF - fracs.topF) * H;
  return { ctx, W, H, dpr, rect: r, plot: { ox, oy, xLen, yLen } };
}

export function timerLikeTickFontPx(rectCss: DOMRect, dpr: number) {
  // Matches timer behavior closely.
  const fontCssPx = Math.max(12, Math.min(64, rectCss.height * 0.028));
  return { fontCssPx, fontPx: Math.round(fontCssPx * dpr) };
}

export function niceStepFromCandidates(maxValue: number, targetTicks = 6, candidates: number[]) {
  const target = Math.max(1e-9, maxValue / Math.max(1, targetTicks));
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1] ?? target;
}

export function niceTicks(
  minV: number,
  maxV: number,
  targetTicks: number,
  candidates: number[],
  fmt: (v: number) => string
): Tick[] {
  const a = Number(minV);
  const b = Number(maxV);
  const span = Math.max(1e-12, b - a);
  const step = niceStepFromCandidates(span, targetTicks, candidates);
  // Use a stable tick start even for negative mins.
  const start = Math.ceil((a - 1e-12) / step) * step;
  const out: Tick[] = [];
  for (let v = start; v <= b + 1e-9; v += step) {
    const f = (v - a) / span;
    out.push({ frac: f, label: fmt(v), value: v });
    if (out.length > 200) break;
  }
  return out;
}

export function fixedTicks(minV: number, maxV: number, step: number, fmt: (v: number) => string): Tick[] {
  const a = Number(minV);
  const b = Number(maxV);
  const span = Math.max(1e-12, b - a);
  const s = Math.max(1e-12, Math.abs(Number(step)));
  const n = Math.max(1, Math.round(span / s));
  const out: Tick[] = [];
  for (let i = 0; i <= n; i++) {
    // Avoid accumulating float error for 0.1, etc.
    const v = i === n ? b : a + i * s;
    const frac = (v - a) / span;
    out.push({ frac, label: fmt(v), value: v });
    if (out.length > 200) break;
  }
  return out;
}

export function mergeTickAnchors(ticks: Tick[], minV: number, maxV: number, anchors: number[], fmt: (v: number) => string): Tick[] {
  const a = Number(minV);
  const b = Number(maxV);
  const span = Math.max(1e-12, b - a);
  const out: Tick[] = [...ticks];
  const eps = Math.max(1e-9, span * 1e-9);
  for (const av0 of anchors) {
    const av = Number(av0);
    if (!(av >= a - eps && av <= b + eps)) continue;
    const already = out.some((t) => Math.abs(t.value - av) <= eps);
    if (already) continue;
    const frac = (av - a) / span;
    out.push({ frac, label: fmt(av), value: av });
  }
  out.sort((p, q) => p.value - q.value);
  return out;
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  plot: PlotRectPx,
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

export function drawTicksAndLabels(args: {
  ctx: CanvasRenderingContext2D;
  plot: PlotRectPx;
  rectCss: DOMRect;
  dpr: number;
  lineWidthPx: number;
  xTicks: Array<{ xFrac: number; label: string }>;
  yTicks: Array<{ yFrac: number; label: string }>;
}) {
  const { ctx, plot, rectCss, dpr, lineWidthPx, xTicks, yTicks } = args;
  const { ox, oy, xLen, yLen } = plot;

  const { fontCssPx, fontPx } = timerLikeTickFontPx(rectCss, dpr);
  const tickLen = Math.max(10 * dpr, Math.round(fontCssPx * 0.7 * dpr));

  ctx.save();
  ctx.font = `${fontPx}px KaTeX_Main, Times New Roman, serif`;
  ctx.fillStyle = "rgba(255,255,255,0.80)";
  ctx.strokeStyle = "rgba(255,255,255,0.32)";
  ctx.lineWidth = lineWidthPx * dpr;

  // X ticks
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of xTicks) {
    const x = ox + t.xFrac * xLen;
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x, oy + tickLen);
    ctx.stroke();
    ctx.fillText(t.label, x, oy + tickLen + 8 * dpr);
  }

  // Y ticks
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of yTicks) {
    const y = oy - t.yFrac * yLen;
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.lineTo(ox - tickLen, y);
    ctx.stroke();
    ctx.fillText(t.label, ox - tickLen - 10 * dpr, y);
  }

  ctx.restore();
}

