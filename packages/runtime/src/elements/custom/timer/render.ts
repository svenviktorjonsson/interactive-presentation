// Timer rendering is currently migrated from the host app into runtime.
// Next step of the refactor will be to decompose this into standard components (axis, bars, dots).

type TimerState = {
  accepting: boolean;
  samplesMs: number[];
  stats: { n: number; meanMs: number | null; sigmaMs: number | null };
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

  // Very simple histogram placeholder (kept minimal for now).
  const samples = Array.isArray(state?.samplesMs) ? state.samplesMs : [];
  if (samples.length) {
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const span = Math.max(1, max - min);
    const bins = 30;
    const counts = new Array(bins).fill(0);
    for (const v0 of samples) {
      const v = Number(v0);
      if (!Number.isFinite(v)) continue;
      const f = Math.max(0, Math.min(0.999999, (v - min) / span));
      const i = Math.floor(f * bins);
      counts[i] += 1;
    }
    const maxC = Math.max(1, ...counts);
    ctx.save();
    ctx.fillStyle = barColor;
    for (let i = 0; i < bins; i++) {
      const h = (counts[i] / maxC) * yLen;
      const x = ox + (i / bins) * xLen;
      const w = xLen / bins;
      ctx.fillRect(x, oy - h, Math.max(1, w - 1 * dpr), h);
    }
    ctx.restore();
  }

  // Optional time label (top-left)
  if (showTime) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = `${Math.round(Math.max(12, r.height * 0.03) * dpr)}px KaTeX_Main, Times New Roman, serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(state?.accepting ? "Running" : "Stopped", ox + 8 * dpr, oy - yLen + 8 * dpr);
    ctx.restore();
  }

  // Simple line (mean marker)
  const mean = state?.stats?.meanMs;
  if (typeof mean === "number" && Number.isFinite(mean) && samples.length) {
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const span = Math.max(1, max - min);
    const f = Math.max(0, Math.min(1, (mean - min) / span));
    const x = ox + f * xLen;
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(2, 2 * dpr);
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x, oy - yLen);
    ctx.stroke();
    ctx.restore();
  }
}

