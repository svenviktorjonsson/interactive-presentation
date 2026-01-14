export function drawGrid(
  ctx: CanvasRenderingContext2D,
  screen: { w: number; h: number },
  camera: { cx: number; cy: number; zoom: number }
) {
  // IMPORTANT:
  // Keep the canvas transparent so the nice CSS background shading (body gradients)
  // remains visible. Only draw grid lines on top.
  ctx.clearRect(0, 0, screen.w, screen.h);

  const minor = "rgba(255,255,255,0.06)";
  const major = "rgba(255,255,255,0.10)";

  // Grid in world px. Keep density roughly stable by scaling with zoom.
  const base = 100;
  const step = Math.max(10, base * camera.zoom);
  const majorEvery = 5;

  // Convert screen (0,0) to world to find phase.
  const worldLeft = camera.cx - screen.w / (2 * camera.zoom);
  const worldTop = camera.cy - screen.h / (2 * camera.zoom);

  const startX = Math.floor(worldLeft / base) * base;
  const startY = Math.floor(worldTop / base) * base;

  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string) => {
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.lineWidth = 1;

  const nX = Math.ceil(screen.w / step) + 4;
  const nY = Math.ceil(screen.h / step) + 4;

  for (let ix = -2; ix < nX; ix++) {
    const wx = startX + ix * base;
    const sx = (wx - camera.cx) * camera.zoom + screen.w / 2;
    const isMajor = Math.round(wx / base) % majorEvery === 0;
    line(sx, 0, sx, screen.h, isMajor ? major : minor);
  }
  for (let iy = -2; iy < nY; iy++) {
    const wy = startY + iy * base;
    const sy = (wy - camera.cy) * camera.zoom + screen.h / 2;
    const isMajor = Math.round(wy / base) % majorEvery === 0;
    line(0, sy, screen.w, sy, isMajor ? major : minor);
  }
}

