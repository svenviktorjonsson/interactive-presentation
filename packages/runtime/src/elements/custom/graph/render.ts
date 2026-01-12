import type { FrameContext } from "../../../runtime/types";
import { drawGrid, drawTicksAndLabels, niceTicks, prepareCanvas } from "../../../utils/plot2d";

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };

function getTimerCanvas(nodeEl: HTMLElement) {
  return nodeEl.querySelector<HTMLCanvasElement>(":scope canvas.timer-canvas");
}

function parseSource(raw: any): { tableId: string; col: number } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^([a-zA-Z_]\w*)\.c(\d+)$/);
  if (!m) return null;
  const c1 = Number(m[2]);
  if (!Number.isFinite(c1) || c1 < 1) return null;
  return { tableId: m[1], col: c1 - 1 };
}

export function renderGraphCanvas(ctx: FrameContext, nodeEl: HTMLElement, n: any) {
  const canvas = getTimerCanvas(nodeEl);
  if (!canvas) return;
  const prep = prepareCanvas(nodeEl, canvas, PLOT_FRACS);
  if (!prep) return;
  const { ctx: g, rect: rectCss, dpr, plot } = prep;
  const { ox, oy, xLen, yLen } = plot;

  const xs = parseSource(n.xSource);
  const ys = parseSource(n.ySource);

  const pts: Array<{ x: number; y: number }> = [];
  if (xs && ys && xs.tableId === ys.tableId) {
    const tableNode: any = (ctx.model.nodes as any[]).find((nn: any) => String(nn?.id) === xs.tableId);
    const rows: any[][] = Array.isArray(tableNode?.rows) ? tableNode.rows : [];
    for (let r = 0; r < rows.length; r++) {
      const rr = rows[r] ?? [];
      const xs0 = String(rr?.[xs.col] ?? "").trim();
      const ys0 = String(rr?.[ys.col] ?? "").trim();
      if (!xs0 || !ys0) continue;
      const x0 = Number(xs0);
      const y0 = Number(ys0);
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
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
    const xSpan0 = Math.max(1e-9, xMax - xMin);
    const ySpan0 = Math.max(1e-9, yMax - yMin);
    xMin -= xSpan0 * 0.08;
    xMax += xSpan0 * 0.08;
    yMin -= ySpan0 * 0.08;
    yMax += ySpan0 * 0.08;
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

  if (String(n.grid ?? "on").toLowerCase() !== "off") drawGrid(g, plot, dpr, xTicks, yTicks);

  // Clip points to plot rect
  g.save();
  g.beginPath();
  g.rect(ox, oy - yLen, xLen, yLen);
  g.clip();
  const col = String(n.color ?? "white") || "white";
  const dotR = Math.max(2 * dpr, 3.5 * dpr);
  g.fillStyle = col;
  for (const p of pts) {
    const xf = (p.x - xMin) / xSpan;
    const yf = (p.y - yMin) / ySpan;
    const x = ox + xf * xLen;
    const y = oy - yf * yLen;
    g.beginPath();
    g.arc(x, y, dotR, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();

  drawTicksAndLabels({ ctx: g, plot, rectCss, dpr, lineWidthPx: 2, xTicks, yTicks });
}

