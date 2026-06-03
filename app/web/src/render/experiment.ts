import type { Store } from "../core/store";

type ExperimentLinks = {
  id: string;
  root?: any;
  table?: any;
  axis?: any;
  xButtons?: any;
  yButtons?: any;
  tButtons?: any;
  fitButton?: any;
  clearButton?: any;
  title?: any;
  xLabel?: any;
  yLabel?: any;
  fitLabel?: any;
};

type ExperimentRuntime = {
  id: string;
  selectedX: number;
  selectedY: number;
  transformIndex: number;
  fitActive: boolean;
  fitA: number | null;
  fitB: number | null;
  lastDataKey: string;
};

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };

const TEMPLATE_RE = /\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}/g;
const experimentRuntime = new Map<string, ExperimentRuntime>();
const experimentButtons = new Map<string, { id: string; role: string }>();
let experimentBusInstalled = false;

const formatTemplate = (template: string, data: Record<string, unknown>) =>
  String(template).replace(TEMPLATE_RE, (_m, key, fmt) => {
    const raw = (data as any)[key];
    if (raw === null || raw === undefined) return "-";
    if (typeof raw === "number" && typeof fmt === "string") {
      const match = fmt.match(/\.([0-9]+)/);
      if (match) {
        const digits = Math.max(0, Math.min(10, Number(match[1]) || 0));
        return raw.toFixed(digits);
      }
    }
    return String(raw);
  });

const ensureRuntime = (id: string): ExperimentRuntime => {
  const existing = experimentRuntime.get(id);
  if (existing) return existing;
  const rt: ExperimentRuntime = {
    id,
    selectedX: 0,
    selectedY: 1,
    transformIndex: 0,
    fitActive: false,
    fitA: null,
    fitB: null,
    lastDataKey: "",
  };
  experimentRuntime.set(id, rt);
  return rt;
};

const resolveLinks = (store: Store) => {
  const links = new Map<string, ExperimentLinks>();
  experimentButtons.clear();
  for (const node of store.model.nodes as any[]) {
    const eid = String(node?.experimentId ?? "");
    if (!eid) continue;
    const entry = links.get(eid) ?? { id: eid };
    const role = String(node?.experimentRole ?? "");
    if (node.type === "group" && role === "root") entry.root = node;
    if (node.type === "table" && role === "table") entry.table = node;
    if (node.type === "axis" && role === "axis") entry.axis = node;
    if (node.type === "buttons") {
      if (role === "x-buttons") entry.xButtons = node;
      if (role === "y-buttons") entry.yButtons = node;
      if (role === "t-buttons") entry.tButtons = node;
      if (role === "fit-button") entry.fitButton = node;
      if (role === "clear-button") entry.clearButton = node;
      experimentButtons.set(String(node.id ?? ""), { id: eid, role });
    }
    if (node.type === "text") {
      if (role === "title") entry.title = node;
      if (role === "x-label") entry.xLabel = node;
      if (role === "y-label") entry.yLabel = node;
      if (role === "fit-label") entry.fitLabel = node;
    }
    links.set(eid, entry);
  }
  return links;
};

const transformX = (label: string, x: number) => {
  const kind = label.trim().toLowerCase();
  if (kind === "1/x") {
    if (x === 0) return null;
    return 1 / x;
  }
  if (kind === "x^2") return x * x;
  if (kind === "sqrt(x)") {
    if (x < 0) return null;
    return Math.sqrt(x);
  }
  if (kind === "1/sqrt(x)") {
    if (x <= 0) return null;
    return 1 / Math.sqrt(x);
  }
  if (kind === "ln(x)") {
    if (x <= 0) return null;
    return Math.log(x);
  }
  if (kind === "1/ln(x)") {
    if (x <= 0) return null;
    const v = Math.log(x);
    if (v === 0) return null;
    return 1 / v;
  }
  if (kind === "exp(x)") return Math.exp(x);
  return x;
};

const fitLinear = (xs: number[], ys: number[]) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;
  return { a, b };
};

const updateButtonsForHeaders = (node: any, labels: string[], mode: "radio" | "keep" | "click", selected: number) => {
  if (!node) return;
  node.buttonsMode = mode;
  node.labels = labels;
  node.actions = labels.map((_, idx) => {
    if (node.experimentRole === "x-buttons") return `experiment-x:${idx}`;
    if (node.experimentRole === "y-buttons") return `experiment-y:${idx}`;
    return String(node.actions?.[idx] ?? "");
  });
  if (node.experimentRole === "x-buttons") {
    node.rows = 1;
    node.cols = Math.max(1, labels.length);
  } else if (node.experimentRole === "y-buttons") {
    node.rows = Math.max(1, labels.length);
    node.cols = 1;
  } else if (node.experimentRole === "t-buttons") {
    node.rows = 1;
    node.cols = Math.max(1, labels.length);
  }
  if (mode === "radio") {
    node.buttonsState = labels.map((_, idx) => idx === selected);
  }
};

const transformLabelForButton = (labelRaw: string) => {
  const label = String(labelRaw || "").trim().toLowerCase();
  if (label === "sqrt(x)") return "\\sqrt{x}";
  if (label === "1/sqrt(x)") return "1/\\sqrt{x}";
  return String(labelRaw || "");
};

const updateTransformButtons = (
  node: any,
  transforms: string[],
  index: number,
  fitLabel?: string,
  clearLabel?: string
) => {
  if (!node) return;
  const labels = (transforms.length ? transforms.slice() : ["x"]).map(transformLabelForButton);
  const actions = labels.map((_label, idx) => `experiment-t:${idx}`);
  if (fitLabel) {
    labels.push(fitLabel);
    actions.push("experiment-fit");
  }
  if (clearLabel) {
    labels.push(clearLabel);
    actions.push("experiment-clear");
  }
  node.buttonsMode = "radio";
  node.labels = labels;
  node.actions = actions;
  node.buttonsState = actions.map((_a, idx) => idx === index);
};

const updateFitButton = (node: any, label: string) => {
  if (!node) return;
  node.buttonsMode = "click";
  node.labels = [label];
  node.actions = ["experiment-fit"];
};

const updateClearButton = (node: any, label: string) => {
  if (!node) return;
  node.buttonsMode = "click";
  node.labels = [label];
  node.actions = ["experiment-clear"];
};

const updateTextNode = (node: any, value: string) => {
  if (!node) return;
  if (node.text !== value) node.text = value;
};

const formatTransformLabel = (base: string, transform: string) => {
  const clean = String(base || "").trim();
  const label = String(transform || "").trim().toLowerCase();
  if (!clean) return "";
  if (label === "x") return clean;
  if (label === "1/x") return `1/\\left(${clean}\\right)`;
  if (label === "x^2") return `\\left(${clean}\\right)^2`;
  if (label === "sqrt(x)") return `\\sqrt{${clean}}`;
  if (label === "1/sqrt(x)") return `1/\\sqrt{${clean}}`;
  if (label === "ln(x)") return `\\ln\\left(${clean}\\right)`;
  if (label === "1/ln(x)") return `1/\\ln\\left(${clean}\\right)`;
  if (label === "exp(x)") return `\\exp\\left(${clean}\\right)`;
  return clean;
};

const updateAxisView = (axis: any, points: Array<{ x: number; y: number }>) => {
  if (!axis) return;
  axis.padPx = Number(axis.padPx ?? 40);
  if (axis.clamp == null) axis.clamp = true;
  if (!points.length) {
    axis.limits = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    (window as any).ipAxisStream?.setView?.(String(axis.id ?? ""), axis.limits as AxisView);
    return;
  }
  let minX = points[0]!.x;
  let maxX = points[0]!.x;
  let minY = points[0]!.y;
  let maxY = points[0]!.y;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const padX = Math.max(1e-6, (maxX - minX) * 0.1);
  const padY = Math.max(1e-6, (maxY - minY) * 0.1);
  axis.limits = { xMin: minX - padX, xMax: maxX + padX, yMin: minY - padY, yMax: maxY + padY };
  (window as any).ipAxisStream?.setView?.(String(axis.id ?? ""), axis.limits as AxisView);
};

const ensureExperimentBus = () => {
  if (experimentBusInstalled || typeof window === "undefined") return;
  experimentBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const btnId = String(detail?.id ?? "");
    const action = String(detail?.action ?? "");
    const idx = Number(detail?.index ?? -1);
    const meta = experimentButtons.get(btnId);
    if (!meta) return;
    const rt = ensureRuntime(meta.id);
    if (action.startsWith("experiment-x:")) {
      const val = Number(action.split(":")[1] ?? idx);
      if (Number.isFinite(val)) rt.selectedX = Math.max(0, val);
      return;
    }
    if (action.startsWith("experiment-y:")) {
      const val = Number(action.split(":")[1] ?? idx);
      if (Number.isFinite(val)) rt.selectedY = Math.max(0, val);
      return;
    }
    if (action.startsWith("experiment-t:")) {
      const val = Number(action.split(":")[1] ?? idx);
      if (Number.isFinite(val)) rt.transformIndex = Math.max(0, val);
      return;
    }
    if (action === "experiment-fit") {
      rt.fitActive = true;
      return;
    }
    if (action === "experiment-clear") {
      rt.fitActive = false;
      rt.fitA = null;
      rt.fitB = null;
      return;
    }
  });
};

export const updateExperimentNodes = (store: Store) => {
  ensureExperimentBus();
  const linksById = resolveLinks(store);
  for (const [id, links] of linksById) {
    const rt = ensureRuntime(id);
    const table = links.table;
    const axis = links.axis;
    if (!table || !axis) continue;
    const headers = Array.isArray(table.hHeader) ? table.hHeader : [];
    const transforms = Array.isArray(links.root?.experimentTransforms)
      ? links.root?.experimentTransforms
      : ["x"];
    const fitButtonLabel = String(links.root?.experimentFitButtonLabel ?? "Fit");
    const clearLabel = String(links.root?.experimentClearLabel ?? "Clear");
    const lineColor = String(links.root?.experimentLineColor ?? "rgba(255,255,255,0.85)");
    const dataColor = String(links.root?.experimentDataColor ?? "rgba(110,168,255,0.9)");
    const cols = Math.max(1, Number(table.cols ?? headers.length ?? 1), headers.length);
    if (Number(table.cols ?? 0) !== cols) table.cols = cols;
    if (rt.selectedX >= cols) rt.selectedX = 0;
    if (rt.selectedY >= cols) rt.selectedY = Math.min(1, Math.max(0, cols - 1));
    if (rt.transformIndex >= transforms.length) rt.transformIndex = 0;
    const defaultLabels = Array.from({ length: cols }, (_, i) => `Col ${i + 1}`);
    const normalizedHeaders = defaultLabels.map((fallback, i) => String(headers[i] ?? fallback));
    if (normalizedHeaders.some((label, i) => headers[i] !== label)) {
      table.hHeader = normalizedHeaders.slice();
    }
    const labels = normalizedHeaders;
    updateButtonsForHeaders(links.xButtons, labels, "radio", rt.selectedX);
    updateButtonsForHeaders(links.yButtons, labels, "radio", rt.selectedY);
    updateTransformButtons(links.tButtons, transforms, rt.transformIndex, fitButtonLabel, clearLabel);
    if (!links.tButtons) {
      updateFitButton(links.fitButton, fitButtonLabel);
      updateClearButton(links.clearButton, clearLabel);
    } else {
      if (links.fitButton) {
        links.fitButton.visible = false;
        links.fitButton.labels = [];
        links.fitButton.actions = [];
      }
      if (links.clearButton) {
        links.clearButton.visible = false;
        links.clearButton.labels = [];
        links.clearButton.actions = [];
      }
    }

    const cells: string[][] = Array.isArray(table.cells) ? table.cells : [];
    const points: Array<{ x: number; y: number }> = [];
    const xVals: number[] = [];
    const yVals: number[] = [];
    for (const row of cells) {
      const rawX = row?.[rt.selectedX];
      const rawY = row?.[rt.selectedY];
      const rawXStr = String(rawX ?? "").trim();
      const rawYStr = String(rawY ?? "").trim();
      if (!rawXStr || !rawYStr) continue;
      const x0 = Number.parseFloat(rawXStr);
      const y0 = Number.parseFloat(rawYStr);
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
      const x = transformX(String(transforms[rt.transformIndex] ?? "x"), x0);
      if (x == null || !Number.isFinite(x)) continue;
      points.push({ x, y: y0 });
      xVals.push(x);
      yVals.push(y0);
    }
    const dataKey = JSON.stringify({ points, sel: [rt.selectedX, rt.selectedY, rt.transformIndex], headers });
    if (dataKey !== rt.lastDataKey) {
      rt.lastDataKey = dataKey;
      updateAxisView(axis, points);
    }

    (window as any).ipAxisStream?.push({
      axisId: String(axis.id ?? ""),
      type: "scatter",
      seriesId: "experiment-data",
      color: dataColor,
      mode: "replace",
      points,
    });

    if (rt.fitActive) {
      const fit = fitLinear(xVals, yVals);
      rt.fitA = fit?.a ?? null;
      rt.fitB = fit?.b ?? null;
      if (fit && points.length) {
        const xs = points.map((p) => p.x);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const line = [
          { x: minX, y: fit.a * minX + fit.b },
          { x: maxX, y: fit.a * maxX + fit.b },
        ];
        (window as any).ipAxisStream?.push({
          axisId: String(axis.id ?? ""),
          type: "graph",
          seriesId: "experiment-fit",
          color: lineColor,
          mode: "replace",
          points: line,
        });
      }
    } else {
      rt.fitA = null;
      rt.fitB = null;
      (window as any).ipAxisStream?.push({
        axisId: String(axis.id ?? ""),
        type: "graph",
        seriesId: "experiment-fit",
        color: lineColor,
        mode: "replace",
        points: [],
      });
    }

    const title = String(links.root?.experimentTitle ?? links.root?.title ?? "");
    updateTextNode(links.title, title);
    const baseXLabel = labels[rt.selectedX] ?? "";
    const transformLabel = String(transforms[rt.transformIndex] ?? "x");
    updateTextNode(links.xLabel, formatTransformLabel(baseXLabel, transformLabel));
    updateTextNode(links.yLabel, labels[rt.selectedY] ?? "");
    const fitTpl = String(links.root?.experimentFitLabel ?? "y = {{a:.3f}}{{xPrime}} + {{b:.3f}}");
    const fitText =
      rt.fitActive && rt.fitA != null && rt.fitB != null
        ? formatTemplate(fitTpl, {
            a: rt.fitA,
            b: rt.fitB,
            xPrime: formatTransformLabel("x", transformLabel),
          })
        : "";
    updateTextNode(links.fitLabel, fitText);
  }
  for (const id of Array.from(experimentRuntime.keys())) {
    if (!linksById.has(id)) experimentRuntime.delete(id);
  }
};
