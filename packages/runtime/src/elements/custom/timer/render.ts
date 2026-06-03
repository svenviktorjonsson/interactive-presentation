// Timer rendering is currently migrated from the host app into runtime.
// Next step of the refactor will be to decompose this into standard components (axis, bars, dots).

type TimerState = {
  accepting: boolean;
  samplesMs: number[];
  stats: { n: number; meanMs: number | null; sigmaMs: number | null };
  lastSubmitMs?: number | null;
};

export function drawTimerNode(el: HTMLElement, state: TimerState) {
  // The engine creates a timer DOM node containing canvas.timer-canvas
  const canvas = el.querySelector<HTMLCanvasElement>(":scope canvas.timer-canvas");
  if (!canvas) return;
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(2, Math.round(r.width * dpr));
  const H = Math.max(2, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Use the timer node’s existing dataset styling (set by engine node updater)
  const showTime = String(el.dataset.showTime ?? "false") === "true";
  const gridOn = String(el.dataset.grid ?? "false") === "true";
  const barColor = String(el.dataset.barColor ?? "orange");
  const lineColor = String(el.dataset.lineColor ?? "green");
  const stat = String(el.dataset.stat ?? "").trim().toLowerCase();

  // Plot rect (same as plot2d PLOT_FRACS)
  const leftF = 0.08;
  const rightF = 0.92;
  const topF = 0.10;
  const bottomF = 0.90;
  const ox = leftF * W;
  const oy = bottomF * H;
  const xLen = (rightF - leftF) * W;
  const yLen = (bottomF - topF) * H;

  // Background fill (data region only)
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(ox, oy - yLen, xLen, yLen);
  ctx.restore();

  // Grid
  if (gridOn) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(1, 1 * dpr);
    const nx = 6;
    const ny = 6;
    for (let i = 0; i <= nx; i++) {
      const x = ox + (i / nx) * xLen;
      ctx.beginPath();
      ctx.moveTo(x, oy);
      ctx.lineTo(x, oy - yLen);
      ctx.stroke();
    }
    for (let i = 0; i <= ny; i++) {
      const y = oy - (i / ny) * yLen;
      ctx.beginPath();
      ctx.moveTo(ox, y);
      ctx.lineTo(ox + xLen, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  const samples = Array.isArray(state?.samplesMs) ? state.samplesMs : [];
  const binsFromDataset = (() => {
    const raw = String(el.dataset.bins ?? "").trim();
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      const nums = arr.map((v) => Number(v)).filter((v) => Number.isFinite(v));
      if (nums.length < 2) return null;
      nums.sort((a, b) => a - b);
      const out: number[] = [];
      for (const v of nums) if (out.length === 0 || Math.abs(out[out.length - 1]! - v) > 1e-9) out.push(v);
      return out.length >= 2 ? out : null;
    } catch {
      return null;
    }
  })();
  const minS = Number(el.dataset.minS ?? "");
  const maxS = Number(el.dataset.maxS ?? "");
  const binSizeS = Number(el.dataset.binSizeS ?? "");
  const minMsFromSpec = Number.isFinite(minS) ? minS * 1000 : null;
  const maxMsFromSpec = Number.isFinite(maxS) ? maxS * 1000 : null;
  const binSizeMsFromSpec = Number.isFinite(binSizeS) ? binSizeS * 1000 : null;

  const samplesMin = samples.length ? Math.min(...samples) : 0;
  const samplesMax = samples.length ? Math.max(...samples) : 0;
  let min = Number.isFinite(minMsFromSpec as number) ? (minMsFromSpec as number) : samplesMin;
  let max = Number.isFinite(maxMsFromSpec as number) ? (maxMsFromSpec as number) : samplesMax;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    min = 0;
    max = Math.max(1, samplesMax);
  }

  let binEdges: number[] | null = binsFromDataset;
  if (!binEdges && Number.isFinite(binSizeMsFromSpec as number) && (binSizeMsFromSpec as number) > 0) {
    const binSizeMs = binSizeMsFromSpec as number;
    const spanMs = Math.max(1, max - min);
    const bins = Math.max(1, Math.round(spanMs / binSizeMs));
    const step = spanMs / bins;
    binEdges = Array.from({ length: bins + 1 }, (_, i) => min + i * step);
  }
  if (!binEdges) {
    const bins = 30;
    const spanMs = Math.max(1, max - min);
    const step = spanMs / bins;
    binEdges = Array.from({ length: bins + 1 }, (_, i) => min + i * step);
  }

  const counts = new Array(Math.max(1, binEdges.length - 1)).fill(0);
  for (const v0 of samples) {
    const v = Number(v0);
    if (!Number.isFinite(v)) continue;
    if (v < binEdges[0]! || v > binEdges[binEdges.length - 1]!) continue;
    let idx = 0;
    // Linear scan is fine for small bin counts.
    for (let i = 0; i < binEdges.length - 1; i++) {
      const a = binEdges[i]!;
      const b = binEdges[i + 1]!;
      const inBin = i === binEdges.length - 2 ? v >= a && v <= b : v >= a && v < b;
      if (inBin) {
        idx = i;
        break;
      }
    }
    counts[idx] += 1;
  }

  const maxC = Math.max(1, ...counts);
  ctx.save();
  ctx.fillStyle = barColor;
  for (let i = 0; i < counts.length; i++) {
    const h = (counts[i] / maxC) * yLen;
    const x0 = binEdges[i]!;
    const x1 = binEdges[i + 1]!;
    const f0 = (x0 - min) / Math.max(1, max - min);
    const f1 = (x1 - min) / Math.max(1, max - min);
    const x = ox + f0 * xLen;
    const w = (f1 - f0) * xLen;
    ctx.fillRect(x, oy - h, Math.max(1, w - 1 * dpr), h);
  }
  ctx.restore();

  // Optional time label (top-left)
  if (showTime) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = `${Math.round(Math.max(12, r.height * 0.03) * dpr)}px KaTeX_Main, Times New Roman, serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lastSubmitMs = typeof state?.lastSubmitMs === "number" ? state.lastSubmitMs : null;
    const submitLabel = lastSubmitMs !== null ? `Submit: ${(lastSubmitMs / 1000).toFixed(2)}s` : "Stopped";
    ctx.fillText(state?.accepting ? "Running" : submitLabel, ox + 8 * dpr, oy - yLen + 8 * dpr);
    ctx.restore();
  }

  // Gaussian overlay (uses timer stats from backend)
  const mean = state?.stats?.meanMs;
  const sigma = state?.stats?.sigmaMs;
  if (stat === "gaussian" && typeof mean === "number" && typeof sigma === "number" && sigma > 1e-6 && samples.length) {
    const n = 120;
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(2, 2 * dpr);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const xVal = min + t * Math.max(1, max - min);
      const z = (xVal - mean) / sigma;
      const yVal = Math.exp(-0.5 * z * z);
      const x = ox + t * xLen;
      const y = oy - yVal * yLen;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

