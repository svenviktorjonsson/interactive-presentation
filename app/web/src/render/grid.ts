export function drawGrid(
  ctx: CanvasRenderingContext2D,
  screen: { w: number; h: number },
  camera: { cx: number; cy: number; zoom: number }
) {
  // IMPORTANT:
  // Keep the canvas transparent so the nice CSS background shading (body gradients)
  // remains visible. Only draw grid lines on top.
  ctx.clearRect(0, 0, screen.w, screen.h);

  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  const baseWorld = 1;
  const zoom = Math.max(1e-6, camera.zoom);
  const majorTargetPx = 225;
  const raw = majorTargetPx / (baseWorld * zoom);
  const log10 = Math.log10(Math.max(1e-9, raw));
  const k = Math.max(-10, Math.min(10, Math.floor(log10)));
  const t = log10 - k; // 0..1 for smooth transition between decades
  const majorStepWorld = baseWorld * Math.pow(10, k);
  const nextStepWorld = baseWorld * Math.pow(10, k + 1);
  const majorStepPx = majorStepWorld * zoom;
  const nextStepPx = nextStepWorld * zoom;

  const denseFade = (stepPx: number) => Math.max(0, Math.min(1, (stepPx - 8) / 18));
  const majorAlpha = 0.12 * denseFade(majorStepPx) * (1 - t);
  const nextAlpha = 0.12 * denseFade(nextStepPx) * t;

  const drawLines = (stepWorld: number, alpha: number) => {
    if (alpha <= 0.001) return;
    const stepPx = stepWorld * zoom;
    const stroke = `rgba(255,255,255,${alpha})`;
    const worldLeft = camera.cx - screen.w / (2 * zoom);
    const worldTop = camera.cy - screen.h / (2 * zoom);
    const startX = Math.floor(worldLeft / stepWorld) * stepWorld;
    const startY = Math.floor(worldTop / stepWorld) * stepWorld;
    const nX = Math.ceil(screen.w / stepPx) + 4;
    const nY = Math.ceil(screen.h / stepPx) + 4;
    for (let ix = -2; ix < nX; ix++) {
      const wx = startX + ix * stepWorld;
      const sx = (wx - camera.cx) * zoom + screen.w / 2;
      line(sx, 0, sx, screen.h, stroke, 1);
    }
    for (let iy = -2; iy < nY; iy++) {
      const wy = startY + iy * stepWorld;
      const sy = (wy - camera.cy) * zoom + screen.h / 2;
      line(0, sy, screen.w, sy, stroke, 1);
    }
  };

  drawLines(majorStepWorld, majorAlpha);
  drawLines(nextStepWorld, nextAlpha);
}

