import type { Store } from "../core/store";
import { publishTimerPrompt } from "../core/transport";

type TimerLinks = {
  id: string;
  root?: any;
  axis?: any;
  buttons?: any;
  xLabel?: any;
  yLabel?: any;
  value?: any;
  stats?: any;
};

type TimerRuntime = {
  id: string;
  accepting: boolean;
  stat: string;
  color: string;
  barColor: string;
  startLabel: string;
  stopLabel: string;
  resetLabel: string;
  xLabel: string;
  yLabel: string;
  showTime: boolean;
  debug: boolean;
  title: string;
  samples: number[];
  mu: number | null;
  sigma: number | null;
  lastPromptKey: string;
  needsViewReset: boolean;
};

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };

const TEMPLATE_RE = /\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}/g;
const timerRuntime = new Map<string, TimerRuntime>();
const timerButtons = new Map<string, string>();
let timerBusInstalled = false;
let activeStore: Store | null = null;
const debugTimers = new Map<string, number>();

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

const ensureRuntime = (id: string): TimerRuntime => {
  const existing = timerRuntime.get(id);
  if (existing) return existing;
  const rt: TimerRuntime = {
    id,
    accepting: false,
    stat: "gaussian",
    color: "white",
    barColor: "",
    startLabel: "Start",
    stopLabel: "Stop",
    resetLabel: "Reset",
    xLabel: "Time (s)",
    yLabel: "Progress",
    showTime: false,
    debug: false,
    title: "Timer",
    samples: [],
    mu: null,
    sigma: null,
    lastPromptKey: "",
    needsViewReset: true,
  };
  timerRuntime.set(id, rt);
  return rt;
};

const resolveLinks = (store: Store) => {
  const links = new Map<string, TimerLinks>();
  timerButtons.clear();
  for (const node of store.model.nodes as any[]) {
    const tid = String(node?.timerId ?? "");
    if (!tid) continue;
    const entry = links.get(tid) ?? { id: tid };
    if (node.type === "group" && node.timerRole === "root") entry.root = node;
    if (node.timerRole === "axis" && node.type === "axis") entry.axis = node;
    if (node.timerRole === "buttons" && node.type === "buttons") {
      entry.buttons = node;
      timerButtons.set(String(node.id ?? ""), tid);
    }
    if (node.type === "text") {
      const nid = String(node.id ?? "");
      if (nid.endsWith("_x_label")) entry.xLabel = node;
      else if (nid.endsWith("_y_label")) entry.yLabel = node;
      else if (nid.endsWith("_value")) entry.value = node;
      else if (nid.endsWith("_stats")) entry.stats = node;
    }
    links.set(tid, entry);
  }
  return links;
};

const computeStats = (samples: number[]) => {
  const n = samples.length;
  if (n < 2) return { mu: null, sigma: null };
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const mu = sum / n;
  let varSum = 0;
  for (const v of samples) varSum += (v - mu) ** 2;
  const sigma = Math.sqrt(varSum / n);
  if (!Number.isFinite(mu) || !Number.isFinite(sigma)) return { mu: null, sigma: null };
  return { mu, sigma };
};

const getAxisXMax = (rt: TimerRuntime, links: TimerLinks) => {
  const binsRaw = (links.axis?.bins ?? links.axis?.binEdges ?? links.axis?.edges) as unknown;
  const bins = Array.isArray(binsRaw) ? binsRaw.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];
  if (bins.length >= 2) {
    const min = Math.min(...bins);
    const max = Math.max(...bins);
    if (Number.isFinite(max)) return { xMin: min, xMax: max };
  }
  if (rt.samples.length) {
    const max = Math.max(...rt.samples);
    return { xMin: 0, xMax: Math.max(1, max) };
  }
  return { xMin: 0, xMax: 10 };
};

const syncRuntimeFromNodes = (rt: TimerRuntime, links: TimerLinks) => {
  const root = links.root ?? {};
  const nextStat = String(root.timerStat ?? root.stat ?? rt.stat);
  const nextColor = String(root.timerColor ?? root.color ?? rt.color);
  const nextBarColor = String(root.timerBarColor ?? root.barColor ?? rt.barColor);
  const nextStartLabel = String(root.timerStartLabel ?? root.startLabel ?? rt.startLabel);
  const nextStopLabel = String(root.timerStopLabel ?? root.stopLabel ?? rt.stopLabel);
  const nextResetLabel = String(root.timerResetLabel ?? root.resetLabel ?? rt.resetLabel);
  const nextXLabel = String(root.timerXLabel ?? root.xLabel ?? rt.xLabel);
  const nextYLabel = String(root.timerYLabel ?? root.yLabel ?? rt.yLabel);
  const nextShowTime = typeof root.timerShowTime === "boolean" ? root.timerShowTime : rt.showTime;
  const nextDebug = typeof root.timerDebug === "boolean" ? root.timerDebug : rt.debug;
  const nextTitle = String(root.timerTitle ?? root.title ?? rt.title);
  if (nextStat && nextStat !== rt.stat) rt.stat = nextStat;
  if (nextColor && nextColor !== rt.color) rt.color = nextColor;
  if (nextBarColor && nextBarColor !== rt.barColor) rt.barColor = nextBarColor;
  if (nextStartLabel && nextStartLabel !== rt.startLabel) rt.startLabel = nextStartLabel;
  if (nextStopLabel && nextStopLabel !== rt.stopLabel) rt.stopLabel = nextStopLabel;
  if (nextResetLabel && nextResetLabel !== rt.resetLabel) rt.resetLabel = nextResetLabel;
  if (nextXLabel && nextXLabel !== rt.xLabel) rt.xLabel = nextXLabel;
  if (nextYLabel && nextYLabel !== rt.yLabel) rt.yLabel = nextYLabel;
  if (typeof nextShowTime === "boolean") rt.showTime = nextShowTime;
  if (typeof nextDebug === "boolean") rt.debug = nextDebug;
  if (nextTitle && nextTitle !== rt.title) rt.title = nextTitle;
};

const applyAxisDefaults = (rt: TimerRuntime, links: TimerLinks) => {
  const axis = links.axis;
  if (!axis) return;
  axis.padPx = Number(axis.padPx ?? 40);
  axis.clamp = true;
  const { xMin, xMax } = getAxisXMax(rt, links);
  axis.limits = { xMin, xMax, yMin: 0, yMax: 1 };
  if (rt.needsViewReset) {
    const view = axis.limits as AxisView;
    (window as any).ipAxisStream?.setView?.(String(axis.id ?? ""), view);
    rt.needsViewReset = false;
  }
};

const formatRuntimeData = (rt: TimerRuntime) => {
  return { mu: rt.mu, sigma: rt.sigma, count: rt.samples.length };
};

const updateLabels = (rt: TimerRuntime, links: TimerLinks, timeMs: number) => {
  const toggleLabel = rt.accepting ? rt.stopLabel : rt.startLabel;
  const data = {
    toggleLabel,
    startLabel: rt.startLabel,
    stopLabel: rt.stopLabel,
    resetLabel: rt.resetLabel,
    xLabel: rt.xLabel,
    yLabel: rt.yLabel,
    ...formatRuntimeData(rt),
  };
  const applyText = (node?: any, valueOverride?: string) => {
    if (!node) return;
    const template = String(node.template ?? node.text ?? "");
    const next = valueOverride != null ? valueOverride : formatTemplate(template, data);
    if (node.text !== next) node.text = next;
  };
  applyText(links.xLabel, rt.xLabel);
  applyText(links.yLabel, rt.yLabel);
  if (links.value) {
    const baseColor = String((links.value as any).__baseColor ?? (links.value as any).color ?? "rgba(255,255,255,0.92)");
    (links.value as any).__baseColor = baseColor;
    const hasRun = rt.samples.length > 0;
    const dots = ".".repeat(Math.floor(timeMs / 300) % 4);
    const statusText = rt.accepting ? `Running${dots}` : hasRun ? "Stopped" : "Ready";
    if ((links.value as any).text !== statusText) (links.value as any).text = statusText;
    (links.value as any).color = rt.accepting ? "rgba(110,255,110,0.95)" : baseColor;
  }
  applyText(links.stats);
  if (links.buttons) {
    const templates = Array.isArray(links.buttons.templates)
      ? links.buttons.templates
      : Array.isArray(links.buttons.labels)
        ? links.buttons.labels
        : [];
    const actions = Array.isArray(links.buttons.actions) ? links.buttons.actions : [];
    if (rt.debug) {
      if (!actions.includes("timer-debug")) {
        actions.push("timer-debug");
        templates.push("Test");
      }
      if (!links.buttons.hSplits && !links.buttons.vSplits) {
        links.buttons.rows = 1;
        links.buttons.cols = Math.max(2, Number(links.buttons.cols ?? 1));
      }
    } else {
      const filteredTemplates: string[] = [];
      const filteredActions: string[] = [];
      for (let i = 0; i < Math.max(templates.length, actions.length); i += 1) {
        const action = String(actions[i] ?? "");
        if (action === "timer-debug") continue;
        filteredTemplates.push(String(templates[i] ?? ""));
        filteredActions.push(action);
      }
      templates.length = 0;
      templates.push(...filteredTemplates);
      actions.length = 0;
      actions.push(...filteredActions);
      if (!links.buttons.hSplits && !links.buttons.vSplits) {
        links.buttons.rows = 1;
        links.buttons.cols = 1;
      }
    }
    const labels = templates.map((tpl: string) => formatTemplate(tpl, data));
    links.buttons.labels = labels;
    links.buttons.templates = templates;
    links.buttons.actions = actions;
  }
};

const gaussianSample = (mean: number, sigma: number) => {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.max(1e-9, Math.random());
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z0 * sigma;
};

const simulateTimerSubmits = (rt: TimerRuntime, links: TimerLinks, count = 40) => {
  const { xMin, xMax } = getAxisXMax(rt, links);
  const span = Math.max(0.5, xMax - xMin);
  const mean = xMin + span * 0.6;
  const sigma = Math.max(0.05, span / 6);
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let v = gaussianSample(mean, sigma);
    if (!Number.isFinite(v)) v = mean;
    v = Math.max(xMin, Math.min(xMax, v));
    samples.push(v);
  }

  const baseDelayMs = 120;
  const timerId = rt.id;
  if (debugTimers.has(timerId)) return;
  const totalMs = Math.max(1, count * baseDelayMs + 300);
  debugTimers.set(timerId, totalMs);
  samples.forEach((sample, idx) => {
    const jitter = Math.round((Math.random() - 0.5) * 80);
    const delay = idx * baseDelayMs + jitter;
    window.setTimeout(() => {
      void fetch(`/api/timer/${timerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", elapsedMs: Math.round(sample * 1000) }),
      }).catch(() => {});
    }, Math.max(0, delay));
  });
  window.setTimeout(() => debugTimers.delete(timerId), totalMs);
};

const updateSeries = (rt: TimerRuntime, links: TimerLinks) => {
  if (!links.axis) return;
  const axisId = String(links.axis.id ?? "");
  const binsRaw = (links.axis?.bins ?? links.axis?.binEdges ?? links.axis?.edges) as unknown;
  const bins = Array.isArray(binsRaw) ? binsRaw.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];
  const samples = rt.samples;
  let binEdges: number[] = [];
  if (bins.length >= 2) {
    binEdges = bins.slice().sort((a, b) => a - b);
  } else {
    const min = samples.length ? Math.min(...samples) : 0;
    const max = samples.length ? Math.max(...samples) : 1;
    const span = Math.max(1e-6, max - min);
    const n = 12;
    const step = span / n;
    binEdges = Array.from({ length: n + 1 }, (_, i) => min + i * step);
  }
  const counts = new Array(Math.max(1, binEdges.length - 1)).fill(0);
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    if (v < binEdges[0]! || v > binEdges[binEdges.length - 1]!) continue;
    let idx = 0;
    for (let i = 0; i < binEdges.length - 1; i += 1) {
      const lo = binEdges[i]!;
      const hi = binEdges[i + 1]!;
      const inBin = i === binEdges.length - 2 ? v >= lo && v <= hi : v >= lo && v < hi;
      if (inBin) {
        idx = i;
        break;
      }
    }
    counts[idx] += 1;
  }
  const maxCount = Math.max(1, ...counts);
  const points = counts.map((c, i) => {
    const x0 = binEdges[i]!;
    const x1 = binEdges[i + 1]!;
    const x = (x0 + x1) / 2;
    return { x, y: c / maxCount };
  });
  (window as any).ipAxisStream?.push({
    axisId,
    type: "bar",
    seriesId: "timer-bar",
    color: rt.barColor || rt.color,
    mode: "replace",
    points,
  });

  const stat = String(rt.stat ?? "").trim().toLowerCase();
  const mu = rt.mu;
  const sigma = rt.sigma;
  const { xMin, xMax } = getAxisXMax(rt, links);
  if (stat === "gaussian" && typeof mu === "number" && typeof sigma === "number" && sigma > 1e-6 && xMax > xMin) {
    const n = 80;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= n; i++) {
      const x = xMin + (i / n) * (xMax - xMin);
      const z = (x - mu) / sigma;
      const y = Math.exp(-0.5 * z * z);
      pts.push({ x, y });
    }
    (window as any).ipAxisStream?.push({
      axisId,
      type: "graph",
      seriesId: "timer-gaussian",
      color: rt.color,
      mode: "replace",
      points: pts,
    });
  } else {
    (window as any).ipAxisStream?.push({
      axisId,
      type: "graph",
      seriesId: "timer-gaussian",
      color: rt.color,
      mode: "replace",
      points: [],
    });
  }
};

const recordSampleMs = (rt: TimerRuntime, elapsedMs: number) => {
  const sampleS = Math.max(0, elapsedMs / 1000);
  if (!Number.isFinite(sampleS) || sampleS <= 0) return;
  rt.samples.push(sampleS);
  const maxSamples = 5000;
  while (rt.samples.length > maxSamples) rt.samples.shift();
};

const resetTimer = (rt: TimerRuntime) => {
  rt.accepting = false;
  rt.samples = [];
  rt.mu = null;
  rt.sigma = null;
  rt.needsViewReset = true;
  rt.lastPromptKey = "";
  const axisId = `${rt.id}_axis`;
  (window as any).ipAxisStream?.clear(axisId);
};

const buildTimerPrompt = (rt: TimerRuntime, active: boolean) => ({
  id: rt.id,
  active,
  running: rt.accepting,
  elapsedMs: 0,
  labels: {
    start: rt.startLabel,
    stop: rt.stopLabel,
    reset: rt.resetLabel,
    toggle: rt.accepting ? rt.stopLabel : rt.startLabel,
  },
  xLabel: rt.xLabel,
  yLabel: rt.yLabel,
  value: "",
  showTime: rt.showTime,
  title: rt.title || "Timer",
});

const emitTimerPrompt = (rt: TimerRuntime, active: boolean) => {
  const payload = buildTimerPrompt(rt, active);
  const key = JSON.stringify(payload);
  if (key === rt.lastPromptKey) return;
  rt.lastPromptKey = key;
  console.log("[timer] publish prompt", payload);
  void publishTimerPrompt(payload).catch((err) => {
    console.error("[next] failed to publish timer prompt", err);
  });
};

const ensureTimerBus = () => {
  if (timerBusInstalled || typeof window === "undefined") return;
  timerBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const action = String(detail?.action ?? "");
    if (!action.startsWith("timer-")) return;
    const store = activeStore;
    if (!store || store.mode !== "live") return;
    const btnId = String(detail?.id ?? "");
    const timerId = timerButtons.get(btnId) || (btnId.endsWith("_buttons") ? btnId.slice(0, -"_buttons".length) : "");
    if (!timerId) return;
    const rt = ensureRuntime(timerId);
    if (action === "timer-toggle") {
      rt.accepting = !rt.accepting;
      emitTimerPrompt(rt, rt.accepting);
      return;
    }
    if (action === "timer-debug") {
      const links = resolveLinks(store).get(timerId);
      if (links) simulateTimerSubmits(rt, links, 40);
      return;
    }
    if (action === "timer-reset") {
      resetTimer(rt);
      emitTimerPrompt(rt, false);
    }
  });
  window.addEventListener("ip-timer-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const id = String(detail?.id ?? "");
    if (!id) return;
    const action = String(detail?.action ?? "");
    const rt = ensureRuntime(id);
    if (action === "start") {
      rt.accepting = true;
      emitTimerPrompt(rt, true);
    } else if (action === "stop") {
      rt.accepting = false;
      emitTimerPrompt(rt, false);
    } else if (action === "toggle") {
      rt.accepting = !rt.accepting;
      emitTimerPrompt(rt, rt.accepting);
    } else if (action === "reset") {
      resetTimer(rt);
      emitTimerPrompt(rt, false);
    } else if (action === "submit") {
      const elapsedMs = Number(detail?.elapsedMs ?? NaN);
      if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
        recordSampleMs(rt, elapsedMs);
      }
    }
  });
};

export const updateTimerNodes = (store: Store, timeMs: number) => {
  activeStore = store;
  ensureTimerBus();
  const linksById = resolveLinks(store);
  const live = store.mode === "live";
  for (const [id, links] of linksById) {
    const rt = ensureRuntime(id);
    syncRuntimeFromNodes(rt, links);
    applyAxisDefaults(rt, links);
    const root = links.root;
    const visibleInLive = (() => {
      if (!root) return true;
      if (root.space === "screen") return true;
      const viewId = String(root.viewId ?? "");
      if (!viewId) return true;
      if (store.mode !== "live" && store.cameraTween && store.transitionFromViewId && store.transitionToViewId) {
        return viewId === store.transitionFromViewId || viewId === store.transitionToViewId;
      }
      return viewId === store.activeViewId;
    })();
    const stats = computeStats(rt.samples);
    rt.mu = stats.mu;
    rt.sigma = stats.sigma;
    updateLabels(rt, links, timeMs);
    if (live && visibleInLive) {
      updateSeries(rt, links);
    }
  }
  for (const id of Array.from(timerRuntime.keys())) {
    if (!linksById.has(id)) {
      const axisId = `${id}_axis`;
      (window as any).ipAxisStream?.clear(axisId);
      timerRuntime.delete(id);
    }
  }
};
