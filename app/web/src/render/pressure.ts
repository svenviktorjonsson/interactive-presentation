import type { Store } from "../core/store";

type TableOutput = { tableId: string; col: number } | null;

type PressureLinks = {
  id: string;
  root?: any;
  axis?: any;
  buttons?: any;
  threshold?: any;
  xLabel?: any;
  yLabel?: any;
  peak?: any;
};

type PressureAudio = {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  pressureNode: AudioNode;
  gain: GainNode;
};

type PressureRuntime = {
  id: string;
  running: boolean;
  hasRunOnce: boolean;
  windowS: number;
  sampleMs: number;
  threshold: number;
  peakLabel: string;
  peakList: string;
  color: string;
  lineWidth: number;
  runLabel: string;
  resumeLabel: string;
  pauseLabel: string;
  resetLabel: string;
  xLabel: string;
  yLabel: string;
  maxPoints: number;
  pressure: Array<{ t: number; y: number }>;
  timeCursorS: number;
  lastTimeMs: number;
  lastPeakTimes: number[];
  lastEmittedTimeS: number;
  lastProcessedTimeS: number;
  timePeakActive: boolean;
  timePeakRow: number | null;
  audio?: PressureAudio;
  error?: string | null;
  starting?: Promise<void> | null;
  needsViewReset: boolean;
};

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };

const TEMPLATE_RE = /\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}/g;
const MIN_PEAK_SEP_MS = 10;
const pressureRuntime = new Map<string, PressureRuntime>();
const pressureButtons = new Map<string, string>();
let pressureBusInstalled = false;
let activeStore: Store | null = null;

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

const upsertTableColumnValue = (
  store: Store,
  target: TableOutput,
  value: string,
  rowIndex: number | null
) => {
  if (!target) return null;
  const active = document.activeElement as HTMLElement | null;
  if (active && active.classList?.contains("table-cell")) {
    active.blur();
  }
  const table = store.model.nodes.find((n) => String((n as any).id ?? "") === target.tableId);
  if (!table || (table as any).type !== "table") return null;
  const anyTable = table as any;
  const rows = Math.max(1, Number(anyTable.rows ?? anyTable.cells?.length ?? 1));
  const cols = Math.max(1, Number(anyTable.cols ?? anyTable.cells?.[0]?.length ?? 1));
  const cells: string[][] = Array.isArray(anyTable.cells)
    ? anyTable.cells.map((r: any) => (Array.isArray(r) ? r.map((c: any) => String(c ?? "")) : []))
    : [];
  while (cells.length < rows) cells.push([]);
  for (let r = 0; r < cells.length; r += 1) {
    const row = cells[r] ?? [];
    while (row.length < cols) row.push("");
    cells[r] = row;
  }
  const colIndex = Math.min(cols - 1, Math.max(0, target.col - 1));
  let nextRow = rowIndex;
  if (nextRow == null || nextRow < 0 || nextRow >= cells.length) {
    nextRow = cells.findIndex((row) => String(row?.[colIndex] ?? "").trim() === "");
    if (nextRow < 0) {
      nextRow = cells.length;
      const newRow: string[] = [];
      while (newRow.length < cols) newRow.push("");
      cells.push(newRow);
    }
  }
  cells[nextRow]![colIndex] = value;
  anyTable.cells = cells;
  anyTable.rows = Math.max(rows, cells.length);
  anyTable.cols = Math.max(cols, cols);
  return nextRow;
};

const getAudioContextCtor = () =>
  (window as any).AudioContext || (window as any).webkitAudioContext || null;

const createPressureNode = async (
  ctx: AudioContext,
  windowMs: number,
  onValues: (values: number[]) => void
) => {
  const AudioWorkletNodeCtor = (window as any).AudioWorkletNode as typeof AudioWorkletNode | undefined;
  if (ctx.audioWorklet && AudioWorkletNodeCtor) {
    const code = `
class IPPressureRms extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const winMs = Math.max(0.5, Number(opts?.processorOptions?.windowMs ?? 1));
    this.windowSamples = Math.max(1, Math.round(sampleRate * (winMs / 1000)));
    this.acc = 0;
    this.count = 0;
    this.pending = [];
    this.flushEvery = Math.max(1, Math.round(20 / winMs));
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input && input[0] && output && output[0]) {
      output[0].set(input[0]);
    }
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      this.acc += x * x;
      this.count += 1;
      if (this.count >= this.windowSamples) {
        const rms = Math.sqrt(this.acc / this.count);
        this.pending.push(rms);
        this.acc = 0;
        this.count = 0;
        if (this.pending.length >= this.flushEvery) {
          this.port.postMessage({ type: "pressure", values: this.pending });
          this.pending = [];
        }
      }
    }
    return true;
  }
}
registerProcessor("ip-pressure-rms", IPPressureRms);
`;
    try {
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNodeCtor(ctx, "ip-pressure-rms", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { windowMs },
      });
      node.port.onmessage = (ev) => {
        const data = ev.data || {};
        if (data.type === "pressure" && Array.isArray(data.values) && data.values.length) {
          onValues(data.values.map((v: any) => Number(v)));
        }
      };
      return node as AudioNode;
    } catch (err) {
      console.warn("[pressure] audio worklet unavailable, falling back to ScriptProcessor", err);
    }
  }

  const bufferSize = 1024;
  const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
  const windowSamples = Math.max(1, Math.round(ctx.sampleRate * (windowMs / 1000)));
  let acc = 0;
  let count = 0;
  let pending: number[] = [];
  processor.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      const x = input[i] ?? 0;
      acc += x * x;
      count += 1;
      if (count >= windowSamples) {
        pending.push(Math.sqrt(acc / count));
        acc = 0;
        count = 0;
        if (pending.length >= 8) {
          const next = pending;
          pending = [];
          onValues(next);
        }
      }
    }
  };
  return processor;
};

const setupAudio = async (rt: PressureRuntime) => {
  if (rt.audio) return;
  if (rt.starting) return rt.starting;
  const AudioCtx = getAudioContextCtor();
  if (!AudioCtx) {
    rt.error = "AudioContext unsupported";
    return;
  }
  rt.starting = (async () => {
    const w = window as any;
    w.__ip_micPermissionPending = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } finally {
      w.__ip_micPermissionPending = false;
    }
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    const source = ctx.createMediaStreamSource(stream);
    const pressureNode = await createPressureNode(ctx, rt.sampleMs, (values) => {
      if (!rt.running) return;
      const dt = rt.sampleMs / 1000;
      const windowS = Math.max(1e-6, rt.windowS);
      for (const v of values) {
        const nextT = rt.timeCursorS + dt;
        if (nextT > windowS) {
          rt.timeCursorS = 0;
          rt.pressure = [];
          rt.lastPeakTimes = [];
          rt.lastEmittedTimeS = -Infinity;
          rt.lastProcessedTimeS = -Infinity;
          rt.timePeakActive = false;
          rt.timePeakRow = null;
        } else {
          rt.timeCursorS = nextT;
        }
        rt.pressure.push({ t: rt.timeCursorS, y: Math.max(0, Number(v) || 0) });
      }
      const maxPoints = rt.maxPoints;
      while (rt.pressure.length > maxPoints) rt.pressure.shift();
    });
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(pressureNode);
    pressureNode.connect(gain);
    gain.connect(ctx.destination);
    rt.audio = { ctx, stream, source, pressureNode, gain };
  })();
  try {
    await rt.starting;
  } finally {
    rt.starting = null;
  }
};

const startPressure = async (rt: PressureRuntime) => {
  rt.error = null;
  try {
    await setupAudio(rt);
  } catch (err) {
    rt.error = "Microphone unavailable";
    console.warn("[pressure] setup failed", err);
    return;
  }
  if (!rt.audio) return;
  try {
    await rt.audio.ctx.resume();
  } catch (err) {
    rt.error = "Audio resume failed";
    console.warn("[pressure] resume failed", err);
  }
  rt.running = true;
  rt.hasRunOnce = true;
};

const stopPressure = async (rt: PressureRuntime) => {
  if (!rt.audio) {
    rt.running = false;
    return;
  }
  try {
    await rt.audio.ctx.suspend();
  } catch (err) {
    console.warn("[pressure] suspend failed", err);
  }
  rt.running = false;
};

const shutdownPressure = (rt: PressureRuntime) => {
  if (!rt.audio) return;
  try {
    rt.audio.source.disconnect();
    rt.audio.pressureNode.disconnect();
    rt.audio.gain.disconnect();
  } catch {}
  try {
    rt.audio.stream.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    void rt.audio.ctx.close();
  } catch {}
  rt.audio = undefined;
  rt.running = false;
};

const resetPressure = (rt: PressureRuntime) => {
  rt.running = false;
  rt.hasRunOnce = false;
  rt.pressure = [];
  rt.timeCursorS = 0;
  rt.lastPeakTimes = [];
  rt.lastEmittedTimeS = -Infinity;
  rt.lastProcessedTimeS = -Infinity;
  rt.timePeakActive = false;
  rt.timePeakRow = null;
  rt.needsViewReset = true;
  const axisId = `${rt.id}_axis`;
  (window as any).ipAxisStream?.clear(axisId);
  (window as any).ipAxisStream?.resetView?.(axisId);
};

const ensurePressureBus = () => {
  if (pressureBusInstalled || typeof window === "undefined") return;
  pressureBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const action = String(detail?.action ?? "");
    if (action !== "pressure-toggle" && action !== "pressure-reset") return;
    const store = activeStore;
    if (!store || store.mode !== "live") return;
    const btnId = String(detail?.id ?? "");
    const pressureId = pressureButtons.get(btnId) || (btnId.endsWith("_buttons") ? btnId.slice(0, -"_buttons".length) : "");
    if (!pressureId) return;
    const rt = ensureRuntime(pressureId);
    if (action === "pressure-reset") {
      resetPressure(rt);
      void stopPressure(rt);
      return;
    }
    if (rt.running) void stopPressure(rt);
    else void startPressure(rt);
  });
};

const ensureRuntime = (id: string): PressureRuntime => {
  const existing = pressureRuntime.get(id);
  if (existing) return existing;
  const rt: PressureRuntime = {
    id,
    running: false,
    hasRunOnce: false,
    windowS: 30,
    sampleMs: 1,
    threshold: 0.5,
    peakLabel: "Peak t (s)",
    peakList: "-",
    color: "white",
    lineWidth: 1,
    runLabel: "Run",
    resumeLabel: "Resume",
    pauseLabel: "Pause",
    resetLabel: "Reset",
    xLabel: "Time (s)",
    yLabel: "Pressure",
    maxPoints: 2000,
    pressure: [],
    timeCursorS: 0,
    lastTimeMs: 0,
    lastPeakTimes: [],
    lastEmittedTimeS: -Infinity,
    lastProcessedTimeS: -Infinity,
    timePeakActive: false,
    timePeakRow: null,
    error: null,
    starting: null,
    needsViewReset: true,
  };
  pressureRuntime.set(id, rt);
  return rt;
};

const resolvePressureLinks = (store: Store) => {
  const links = new Map<string, PressureLinks>();
  pressureButtons.clear();
  for (const node of store.model.nodes as any[]) {
    const pid = String(node?.pressureId ?? "");
    if (!pid) continue;
    const entry = links.get(pid) ?? { id: pid };
    if (node.type === "group" && node.pressureRole === "root") entry.root = node;
    if (node.pressureRole === "axis" && node.type === "axis") entry.axis = node;
    if (node.pressureRole === "buttons" && node.type === "buttons") {
      entry.buttons = node;
      pressureButtons.set(String(node.id ?? ""), pid);
    }
    if (node.pressureRole === "threshold" && node.type === "slider") {
      entry.threshold = node;
    }
    if (node.type === "text") {
      const nid = String(node.id ?? "");
      if (nid.endsWith("_x_label")) entry.xLabel = node;
      else if (nid.endsWith("_y_label")) entry.yLabel = node;
      else if (nid.endsWith("_peak")) entry.peak = node;
    }
    links.set(pid, entry);
  }
  return links;
};

const applyAxisDefaults = (rt: PressureRuntime, links: PressureLinks) => {
  const axis = links.axis;
  if (!axis) return;
  const windowS = Math.max(0.5, rt.windowS);
  const maxPoints = Math.max(200, Math.round((windowS * 1000) / Math.max(0.5, rt.sampleMs)));
  rt.maxPoints = maxPoints;
  axis.maxPoints = maxPoints;
  axis.padPx = Number(axis.padPx ?? 40);
  axis.clamp = true;
  axis.limits = { xMin: 0, xMax: windowS, yMin: 0, yMax: 1 };
  if (rt.needsViewReset) {
    const view = axis.limits as AxisView;
    (window as any).ipAxisStream?.setView?.(String(axis.id ?? ""), view);
    rt.needsViewReset = false;
  }
};

const updateLabels = (rt: PressureRuntime, links: PressureLinks) => {
  const runPauseResume = rt.running ? rt.pauseLabel : rt.hasRunOnce ? rt.resumeLabel : rt.runLabel;
  const peakList = rt.lastPeakTimes.length
    ? rt.lastPeakTimes.slice(0, 12).map((t) => t.toFixed(3)).join(", ")
    : "-";
  rt.peakList = peakList;
  const data = {
    runPauseResume,
    runLabel: rt.runLabel,
    resumeLabel: rt.resumeLabel,
    pauseLabel: rt.pauseLabel,
    resetLabel: rt.resetLabel,
    xLabel: rt.xLabel,
    yLabel: rt.yLabel,
    peakLabel: rt.peakLabel,
    peakList,
  };
  const applyText = (node?: any) => {
    if (!node) return;
    const template = String(node.template ?? node.text ?? "");
    const next = formatTemplate(template, data);
    if (node.text !== next) node.text = next;
  };
  applyText(links.xLabel);
  applyText(links.yLabel);
  if (links.peak) {
    const peakNode = links.peak as any;
    if (!peakNode.__manualText) applyText(peakNode);
  }
  if (links.buttons) {
    const templates = Array.isArray(links.buttons.templates)
      ? links.buttons.templates
      : Array.isArray(links.buttons.labels)
        ? links.buttons.labels
        : [];
    const labels = templates.map((tpl: string) => formatTemplate(tpl, data));
    links.buttons.labels = labels;
  }
};

const updateTimeSeries = (rt: PressureRuntime, links: PressureLinks, timeMs: number) => {
  if (!links.axis) return;
  if (timeMs - rt.lastTimeMs < 33) return;
  rt.lastTimeMs = timeMs;
  const current = rt.pressure;
  const yMaxView = Number((links.axis as any)?.limits?.yMax ?? 1);
  const yMaxSafe = Math.max(1e-6, yMaxView);
  const points = current.map((p) => ({
    x: p.t,
    y: Math.max(0, Math.min(1, p.y / yMaxSafe)),
  }));
  const peakTimes: number[] = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prevY = points[i - 1]!.y;
    const curY = points[i]!.y;
    const nextY = points[i + 1]!.y;
    if (curY >= prevY && curY > nextY) {
      peakTimes.push(points[i]!.x);
    }
  }
  rt.lastPeakTimes = peakTimes;
  if (links.axis && activeStore) syncPeakHeader(activeStore, rt);
  const store = activeStore;
  const targetY = store && store.mode === "live" ? resolveTimeOutput(store, rt) : null;
  let lastProcessed = rt.lastProcessedTimeS;
  const minPeakSepS = MIN_PEAK_SEP_MS / 1000;
  for (const p of points) {
    if (p.x <= lastProcessed + 1e-6) continue;
    if (p.y >= rt.threshold) {
      if (!rt.timePeakActive && targetY && p.x > rt.lastEmittedTimeS + minPeakSepS) {
        upsertTableColumnValue(store!, targetY, p.x.toFixed(3), null);
        rt.lastEmittedTimeS = p.x;
        rt.timePeakRow = null;
      }
      rt.timePeakActive = true;
    } else {
      rt.timePeakActive = false;
    }
    lastProcessed = p.x;
  }
  rt.lastProcessedTimeS = lastProcessed;
  const axisLimits = (links.axis as any)?.limits as AxisView | undefined;
  if (axisLimits) {
    axisLimits.yMin = 0;
    axisLimits.yMax = 1;
  }
  const xMin = Number(axisLimits?.xMin ?? 0);
  const xMax = Number(axisLimits?.xMax ?? rt.windowS);
  (window as any).ipAxisStream?.push({
    axisId: String(links.axis.id ?? ""),
    type: "graph",
    seriesId: "pressure-threshold",
    color: "rgba(255,0,0,0.85)",
    lineWidth: 2,
    dash: [6, 6],
    mode: "replace",
    points: [
      { x: xMin, y: rt.threshold },
      { x: xMax, y: rt.threshold },
    ],
  });
  (window as any).ipAxisStream?.push({
    axisId: String(links.axis.id ?? ""),
    type: "graph",
    seriesId: "pressure",
    color: "orange",
    lineWidth: rt.lineWidth,
    mode: "replace",
    points,
  });
};

const syncRuntimeFromNodes = (rt: PressureRuntime, links: PressureLinks) => {
  const root = links.root ?? {};
  const nextWindowS = Number(root?.pressureWindowS ?? root?.windowS ?? rt.windowS);
  const nextSampleMs = Number(root?.pressureSampleMs ?? root?.sampleMs ?? rt.sampleMs);
  const nextColor = String(root?.pressureColor ?? root?.color ?? rt.color);
  const nextLineWidth = Number(root?.pressureLineWidth ?? rt.lineWidth);
  const nextRunLabel = String(root?.pressureRunLabel ?? root?.runLabel ?? rt.runLabel);
  const nextResumeLabel = String(root?.pressureResumeLabel ?? root?.resumeLabel ?? rt.resumeLabel);
  const nextPauseLabel = String(root?.pressurePauseLabel ?? root?.pauseLabel ?? rt.pauseLabel);
  const nextResetLabel = String(root?.pressureResetLabel ?? root?.resetLabel ?? rt.resetLabel);
  const nextXLabel = String(root?.pressureXLabel ?? root?.xLabel ?? rt.xLabel);
  const nextYLabel = String(root?.pressureYLabel ?? root?.yLabel ?? rt.yLabel);
  const nextPeakLabel = String(root?.pressurePeakLabel ?? root?.peakLabel ?? rt.peakLabel);
  if (Number.isFinite(nextWindowS) && nextWindowS > 0 && nextWindowS !== rt.windowS) {
    rt.windowS = nextWindowS;
    rt.needsViewReset = true;
  }
  if (Number.isFinite(nextSampleMs) && nextSampleMs > 0 && nextSampleMs !== rt.sampleMs) {
    rt.sampleMs = nextSampleMs;
    rt.needsViewReset = true;
    if (rt.running) {
      shutdownPressure(rt);
      void startPressure(rt);
    }
  }
  if (nextColor && nextColor !== rt.color) rt.color = nextColor;
  if (Number.isFinite(nextLineWidth) && nextLineWidth > 0 && nextLineWidth !== rt.lineWidth) rt.lineWidth = nextLineWidth;
  if (nextRunLabel && nextRunLabel !== rt.runLabel) rt.runLabel = nextRunLabel;
  if (nextResumeLabel && nextResumeLabel !== rt.resumeLabel) rt.resumeLabel = nextResumeLabel;
  if (nextPauseLabel && nextPauseLabel !== rt.pauseLabel) rt.pauseLabel = nextPauseLabel;
  if (nextResetLabel && nextResetLabel !== rt.resetLabel) rt.resetLabel = nextResetLabel;
  if (nextXLabel && nextXLabel !== rt.xLabel) rt.xLabel = nextXLabel;
  if (nextYLabel && nextYLabel !== rt.yLabel) rt.yLabel = nextYLabel;
  if (nextPeakLabel && nextPeakLabel !== rt.peakLabel) rt.peakLabel = nextPeakLabel;
};

const resolveTimeOutput = (store: Store, rt: PressureRuntime): TableOutput => {
  const placeholder = "{{peakLabel}}";
  for (const node of store.model.nodes as any[]) {
    if (node?.type !== "table") continue;
    if (String(node?.pressureId ?? node?.groupId ?? "") !== rt.id) continue;
    const tableId = String(node?.id ?? "");
    if (!tableId) continue;
    const headers = Array.isArray(node.hHeader) ? node.hHeader.map((v: any) => String(v ?? "")) : [];
    let idx = headers.findIndex((h: string) => h.includes(placeholder));
    if (idx < 0) {
      idx = headers.findIndex((h: string) => h.trim() === rt.peakLabel);
    } else {
      const nextHeaders = headers.slice();
      nextHeaders[idx] = rt.peakLabel;
      node.hHeader = nextHeaders;
    }
    if (idx < 0) continue;
    return { tableId, col: idx + 1 };
  }
  return null;
};

const syncPeakHeader = (store: Store, rt: PressureRuntime) => {
  const placeholder = "{{peakLabel}}";
  for (const node of store.model.nodes as any[]) {
    if (node?.type !== "table") continue;
    if (String(node?.pressureId ?? node?.groupId ?? "") !== rt.id) continue;
    const headers = Array.isArray(node.hHeader) ? node.hHeader.map((v: any) => String(v ?? "")) : [];
    const idx = headers.findIndex((h: string) => h.includes(placeholder));
    if (idx < 0) continue;
    const nextHeaders = headers.slice();
    nextHeaders[idx] = rt.peakLabel;
    node.hHeader = nextHeaders;
  }
};

export const updatePressureNodes = (store: Store, timeMs: number) => {
  activeStore = store;
  ensurePressureBus();
  const linksById = resolvePressureLinks(store);
  const live = store.mode === "live";
  for (const [id, links] of linksById) {
    const rt = ensureRuntime(id);
    syncRuntimeFromNodes(rt, links);
    if (links.threshold) {
      const thresholdNode = links.threshold as any;
      const rawValue = Number(thresholdNode?.value ?? rt.threshold);
      const min = Number(thresholdNode?.min ?? 0);
      const max = Number(thresholdNode?.max ?? 1);
      let normalized = rawValue;
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        normalized = (rawValue - min) / (max - min);
      }
      if (Number.isFinite(normalized)) {
        rt.threshold = Math.max(0, Math.min(1, normalized));
      }
    }
    applyAxisDefaults(rt, links);
    if (links.axis) {
      (links.axis as any).__pressureRunning = rt.running;
    }
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
    if (!live || !visibleInLive) {
      if (rt.running) void stopPressure(rt);
      shutdownPressure(rt);
    }
    updateLabels(rt, links);
    if (!live || !visibleInLive || !rt.running) continue;
    updateTimeSeries(rt, links, timeMs);
  }
  for (const id of Array.from(pressureRuntime.keys())) {
    if (!linksById.has(id)) {
      shutdownPressure(pressureRuntime.get(id)!);
      pressureRuntime.delete(id);
    }
  }
};
