import { viewRect } from "../core/geom";

export type ViewGridOptions = {
  enabled: boolean;
  viewCam: { cx: number; cy: number; zoom: number };
  designW: number;
  designH: number;
  gridBaseWorld?: number | { x: number; y: number };
  gridOriginWorld?: { x: number; y: number };
};

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  screen: { w: number; h: number },
  camera: { cx: number; cy: number; zoom: number },
  opts?: {
    viewGrid?: ViewGridOptions;
    viewBoxes?: Array<{
      viewCam: { cx: number; cy: number; zoom: number };
      designW: number;
      designH: number;
    }>;
  }
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

  const viewGrid = opts?.viewGrid;
  if (!viewGrid?.enabled) return;
  const gridCam = viewGrid.viewCam ?? camera;
  const view = viewRect(gridCam);
  const viewLeft = view.left;
  const viewTop = view.top;
  const scaleX = screen.w / Math.max(1e-9, view.width);
  const scaleY = screen.h / Math.max(1e-9, view.height);
  const toScreenX = (wx: number) => (wx - viewLeft) * scaleX;
  const toScreenY = (wy: number) => (wy - viewTop) * scaleY;

  const drawLines = (
    stepWorldX: number,
    stepWorldY: number,
    alpha: number,
    origin?: { x: number; y: number },
    width = 1
  ) => {
    if (alpha <= 0.001) return;
    const stepPxX = stepWorldX * scaleX;
    const stepPxY = stepWorldY * scaleY;
    const stroke = `rgba(255,255,255,${alpha})`;
    const worldLeft = viewLeft;
    const worldTop = viewTop;
    const ox = origin?.x ?? 0;
    const oy = origin?.y ?? 0;
    const startX = Math.floor((worldLeft - ox) / stepWorldX) * stepWorldX + ox;
    const startY = Math.floor((worldTop - oy) / stepWorldY) * stepWorldY + oy;
    const nX = Math.ceil(screen.w / Math.max(1e-9, stepPxX)) + 4;
    const nY = Math.ceil(screen.h / Math.max(1e-9, stepPxY)) + 4;
    for (let ix = -2; ix < nX; ix++) {
      const wx = startX + ix * stepWorldX;
      const sx = toScreenX(wx);
      line(sx, 0, sx, screen.h, stroke, width);
    }
    for (let iy = -2; iy < nY; iy++) {
      const wy = startY + iy * stepWorldY;
      const sy = toScreenY(wy);
      line(0, sy, screen.w, sy, stroke, width);
    }
  };

  // Fade out dense lines: transparent at 25px, fully visible at 50px.
  const denseFade = (px: number) => Math.max(0, Math.min(1, (px - 25) / 25));
  const defaultBaseX = 0.1;
  const defaultBaseY = 0.1;
  const baseStepWorld = viewGrid.gridBaseWorld;
  const baseOrigin = viewGrid.gridOriginWorld ?? { x: 0, y: 0 };
  const baseStepWorldX = Math.max(
    1e-9,
    typeof baseStepWorld === "number" ? baseStepWorld : baseStepWorld?.x ?? defaultBaseX
  );
  const baseStepWorldY = Math.max(
    1e-9,
    typeof baseStepWorld === "number" ? baseStepWorld : baseStepWorld?.y ?? defaultBaseY
  );
  // Draw grid levels from 10^-5 to 10 (relative to base step).
  for (let k = -4; k <= 2; k += 1) {
    const scale = Math.pow(10, k);
    const stepWorldX = baseStepWorldX * scale;
    const stepWorldY = baseStepWorldY * scale;
    const stepPx = Math.min(stepWorldX * scaleX, stepWorldY * scaleY);
    const fade = denseFade(stepPx);
    const alphaBase = 0.12 * fade;
    const lineWidth = k === 1 ? 2 : 1;
    const stepOrigin = baseOrigin;
    // Ensure the base grid stays visible.
    const alpha =
      stepWorldX === 1 && stepWorldY === 1
        ? 1
        : k === 0
          ? Math.max(alphaBase, 0.22)
          : alphaBase;
    drawLines(stepWorldX, stepWorldY, alpha, stepOrigin, lineWidth);
  }

  // View boxes intentionally hidden to avoid extra overlay square.
}

