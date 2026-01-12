type SoundState = {
  enabled: boolean;
  computeSpectrum: boolean;
  computePressure: boolean;
  seq: number;
  sampleRateHz: number;
  windowMs: number;
  pressure10ms: number[];
  spectrum: { freqHz: number[]; magDb: number[] };
  error?: string | null;
  serverTimeMs: number;
};

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };

export function drawSoundNode(el: HTMLElement, state: SoundState) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.sound-canvas");
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

  const mode = (el.dataset.mode ?? "spectrum").toLowerCase() === "pressure" ? "pressure" : "spectrum";
  const col = el.dataset.color ?? "white";
  const gridOn = String(el.dataset.grid ?? "").toLowerCase() === "true";

  const ox = PLOT_FRACS.leftF * W;
  const oy = PLOT_FRACS.bottomF * H;
  const xLen = (PLOT_FRACS.rightF - PLOT_FRACS.leftF) * W;
  const yLen = (PLOT_FRACS.bottomF - PLOT_FRACS.topF) * H;

  if (state.error) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `${Math.max(10, Math.round(12 * dpr))}px system-ui, sans-serif`;
    ctx.fillText(String(state.error), ox, 0.10 * H);
    return;
  }

  // Grid (simple)
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy - yLen, xLen, yLen);
  ctx.clip();

  if (mode === "pressure") {
    const ys = Array.isArray(state.pressure10ms) ? state.pressure10ms.slice(-3000) : [];
    if (ys.length >= 2) {
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const spanY = Math.max(1e-6, maxY - minY);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, 2 * dpr);
      ctx.beginPath();
      for (let i = 0; i < ys.length; i++) {
        const x = ox + (i / (ys.length - 1)) * xLen;
        const yv = (ys[i]! - minY) / spanY;
        const y = oy - yv * yLen;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // spectrum
  const f = state.spectrum?.freqHz ?? [];
  const m = state.spectrum?.magDb ?? [];
  const n = Math.min(f.length, m.length);
  if (n >= 2) {
    const maxHz = Math.max(1, ...f.map((x) => Number(x) || 0));
    const xMax = Math.min(8000, maxHz);
    const xMin = 0;
    const yMin = -120;
    const yMax = 0;
    const xSpan = Math.max(1e-9, xMax - xMin);
    const ySpan = Math.max(1e-9, yMax - yMin);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 2 * dpr);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const hz = Number(f[i]);
      const db = Number(m[i]);
      if (!Number.isFinite(hz) || !Number.isFinite(db)) continue;
      if (hz < xMin || hz > xMax) continue;
      const x = ox + ((hz - xMin) / xSpan) * xLen;
      const y = oy - ((db - yMin) / ySpan) * yLen;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
  }
  ctx.restore();
}

