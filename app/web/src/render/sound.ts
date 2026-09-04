import type { Store } from "../core/store";

type SoundMode = "spectrum" | "time";

type TableOutput = { tableId: string; col: number } | null;

type SoundLinks = {
  id: string;
  root?: any;
  axis?: any;
  buttons?: any;
  modeButtons?: any;
  threshold?: any;
  xLabel?: any;
  yLabel?: any;
  peak?: any;
};

type SoundAudio = {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  pressureNode: AudioNode;
  gain: GainNode;
  freqData: Float32Array<ArrayBuffer>;
};

type SoundRuntime = {
  id: string;
  mode: SoundMode;
  running: boolean;
  hasRunOnce: boolean;
  windowS: number;
  sampleMs: number;
  threshold: number;
  peakLabel: string;
  peakList: string;
  fOutputCol: string;
  tOutputCol: string;
  color: string;
  lineWidth: number;
  runLabel: string;
  resumeLabel: string;
  pauseLabel: string;
  resetLabel: string;
  homeLabel: string;
  timeLabel: string;
  freqLabel: string;
  yLabel: string;
  fLabel: string;
  tLabel: string;
  fXLabel: string;
  fYLabel: string;
  tXLabel: string;
  tYLabel: string;
  freqButtonLabel: string;
  timeButtonLabel: string;
  maxPoints: number;
  pressure: Array<{ t: number; y: number }>;
  timeCursorS: number;
  lastSpectrumMs: number;
  lastTimeMs: number;
  lastPeakHz: number | null;
  lastPeakTimes: number[];
  lastEmittedTimeS: number;
  freqPeakActive: boolean;
  freqPeakMax: number;
  freqPeakRow: number | null;
  timePeakActive: boolean;
  timePeakRow: number | null;
  audio?: SoundAudio;
  error?: string | null;
  starting?: Promise<void> | null;
  needsViewReset: boolean;
};

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };

const TEMPLATE_RE = /\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}/g;
const soundRuntime = new Map<string, SoundRuntime>();
const soundButtons = new Map<string, string>();
let soundBusInstalled = false;
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

const normalizeMode = (raw: string | undefined | null): SoundMode => {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "time" || v === "pressure" || v === "intensity" ? "time" : "spectrum";
};

const parseTableOutput = (value: string): TableOutput => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const tableId = parts[0]?.trim();
  const col = Number(parts[1]);
  if (!tableId || !Number.isFinite(col) || col <= 0) return null;
  return { tableId, col: Math.floor(col) };
};

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

const emitFrequencyPeak = (rt: SoundRuntime, peakHz: number, peakNorm: number, peakDb: number) => {
  const store = activeStore;
  if (!store || store.mode !== "live") return;
  const targetX = parseTableOutput(rt.fOutputCol);
  const targetY = parseTableOutput(rt.tOutputCol);
  if (!targetX || !Number.isFinite(peakHz)) return;
  if (peakNorm >= rt.threshold) {
    if (!rt.freqPeakActive) {
      rt.freqPeakActive = true;
      rt.freqPeakMax = peakHz;
      rt.freqPeakRow = null;
    } else if (peakHz > rt.freqPeakMax) {
      rt.freqPeakMax = peakHz;
    }
    rt.freqPeakRow = upsertTableColumnValue(store, targetX, rt.freqPeakMax.toFixed(1), rt.freqPeakRow);
    if (targetY) {
      const dbText = Number.isFinite(peakDb) ? peakDb.toFixed(1) : "-";
      upsertTableColumnValue(store, targetY, dbText, rt.freqPeakRow);
    }
    return;
  }
  if (!rt.freqPeakActive) return;
  rt.freqPeakActive = false;
  rt.freqPeakMax = 0;
  rt.freqPeakRow = null;
};

const emitTimePeaks = (
  rt: SoundRuntime,
  windowStart: number,
  peaks: Array<{ t: number; yNorm: number; raw: number }>
) => {
  const store = activeStore;
  if (!store || store.mode !== "live") return;
  const targetY = resolveTimeOutput(store, rt);
  if (!targetY) return;
  const threshold = rt.threshold;
  let emitted = false;
  for (const peak of peaks) {
    if (peak.yNorm < threshold) continue;
    const absTime = windowStart + peak.t;
    if (absTime <= rt.lastEmittedTimeS + 1e-6) continue;
    upsertTableColumnValue(store, targetY, absTime.toFixed(3), null);
    rt.lastEmittedTimeS = absTime;
    emitted = true;
  }
  if (!emitted) return;
  rt.timePeakActive = true;
  rt.timePeakRow = null;
};

const getAudioContextCtor = () =>
  (window as any).AudioContext || (window as any).webkitAudioContext || null;

const ensureSoundBus = () => {
  if (soundBusInstalled || typeof window === "undefined") return;
  soundBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const action = String(detail?.action ?? "");
    if (!action.startsWith("sound-")) return;
    const store = activeStore;
    if (!store || store.mode !== "live") return;
    const btnId = String(detail?.id ?? "");
    const soundId = soundButtons.get(btnId) || (btnId.endsWith("_buttons") ? btnId.slice(0, -"_buttons".length) : "");
    if (!soundId) return;
    const rt = ensureRuntime(soundId);
    const setRootMode = (mode: SoundMode) => {
      const root = store.model.nodes.find(
        (n: any) => String(n?.soundId ?? "") === soundId && (n?.soundRole === "root" || n?.type === "group")
      ) as any;
      if (root) root.soundMode = mode;
    };
    if (action === "sound-toggle") {
      if (rt.running) void stopSound(rt);
      else void startSound(rt);
      return;
    }
    if (action === "sound-reset") {
      resetSound(rt);
      return;
    }
    if (action === "sound-mode-toggle") {
      const next = rt.mode === "spectrum" ? "time" : "spectrum";
      setSoundMode(rt, next);
      setRootMode(next);
      return;
    }
    if (action === "sound-mode-frequency") {
      setSoundMode(rt, "spectrum");
      setRootMode("spectrum");
      return;
    }
    if (action === "sound-mode-time") {
      setSoundMode(rt, "time");
      setRootMode("time");
      return;
    }
  });
};

const ensureRuntime = (id: string): SoundRuntime => {
  const existing = soundRuntime.get(id);
  if (existing) return existing;
  const rt: SoundRuntime = {
    id,
    mode: "spectrum",
    running: false,
    hasRunOnce: false,
    windowS: 30,
    sampleMs: 1,
    threshold: 0.5,
    peakLabel: "Peak t (s)",
    peakList: "-",
    fOutputCol: "",
    tOutputCol: "",
    color: "white",
    lineWidth: 1,
    runLabel: "Run",
    resumeLabel: "Resume",
    pauseLabel: "Pause",
    resetLabel: "Reset",
    homeLabel: "Home",
    timeLabel: "Time",
    freqLabel: "Frequency",
    yLabel: "",
    fLabel: "",
    tLabel: "",
    fXLabel: "",
    fYLabel: "",
    tXLabel: "",
    tYLabel: "",
    freqButtonLabel: "Frequency",
    timeButtonLabel: "Time",
    maxPoints: 2000,
    pressure: [],
    timeCursorS: 0,
    lastSpectrumMs: 0,
    lastTimeMs: 0,
    lastPeakHz: null,
    lastPeakTimes: [],
    lastEmittedTimeS: -Infinity,
    freqPeakActive: false,
    freqPeakMax: 0,
    freqPeakRow: null,
    timePeakActive: false,
    timePeakRow: null,
    error: null,
    starting: null,
    needsViewReset: true,
  };
  soundRuntime.set(id, rt);
  return rt;
};

const createPressureNode = async (
  ctx: AudioContext,
  windowMs: number,
  onValues: (values: number[]) => void
) => {
  const AudioWorkletNodeCtor = (window as any).AudioWorkletNode as typeof AudioWorkletNode | undefined;
  if (ctx.audioWorklet && AudioWorkletNodeCtor) {
    const code = `
class IPSoundRms extends AudioWorkletProcessor {
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
registerProcessor("ip-sound-rms", IPSoundRms);
`;
    try {
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNodeCtor(ctx, "ip-sound-rms", {
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
      console.warn("[sound] audio worklet unavailable, falling back to ScriptProcessor", err);
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

const setupAudio = async (rt: SoundRuntime) => {
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    analyser.smoothingTimeConstant = 0.35;
    const freqData = new Float32Array(analyser.frequencyBinCount) as Float32Array<ArrayBuffer>;
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
    source.connect(analyser);
    source.connect(pressureNode);
    analyser.connect(gain);
    pressureNode.connect(gain);
    gain.connect(ctx.destination);
    rt.audio = { ctx, stream, source, analyser, pressureNode, gain, freqData };
  })();
  try {
    await rt.starting;
  } finally {
    rt.starting = null;
  }
};

const startSound = async (rt: SoundRuntime) => {
  rt.error = null;
  try {
    await setupAudio(rt);
  } catch (err) {
    rt.error = "Microphone unavailable";
    console.warn("[sound] setup failed", err);
    return;
  }
  if (!rt.audio) return;
  try {
    await rt.audio.ctx.resume();
  } catch (err) {
    rt.error = "Audio resume failed";
    console.warn("[sound] resume failed", err);
  }
  rt.running = true;
  rt.hasRunOnce = true;
};

const stopSound = async (rt: SoundRuntime) => {
  if (!rt.audio) {
    rt.running = false;
    return;
  }
  try {
    await rt.audio.ctx.suspend();
  } catch (err) {
    console.warn("[sound] suspend failed", err);
  }
  rt.running = false;
};

const shutdownSound = (rt: SoundRuntime) => {
  if (!rt.audio) return;
  try {
    rt.audio.source.disconnect();
    rt.audio.analyser.disconnect();
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

const resetSound = (rt: SoundRuntime) => {
  rt.running = false;
  rt.hasRunOnce = false;
  rt.pressure = [];
  rt.timeCursorS = 0;
  rt.lastPeakHz = null;
  rt.lastPeakTimes = [];
  rt.lastEmittedTimeS = -Infinity;
  rt.freqPeakActive = false;
  rt.freqPeakMax = 0;
  rt.freqPeakRow = null;
  rt.timePeakActive = false;
  rt.timePeakRow = null;
  rt.needsViewReset = true;
  const axisId = `${rt.id}_axis`;
  (window as any).ipAxisStream?.clear(axisId);
  (window as any).ipAxisStream?.resetView?.(axisId);
};

const setSoundMode = (rt: SoundRuntime, mode: SoundMode) => {
  if (rt.mode === mode) return;
  rt.mode = mode;
  rt.lastPeakHz = null;
  rt.lastPeakTimes = [];
  rt.lastEmittedTimeS = -Infinity;
  rt.freqPeakActive = false;
  rt.freqPeakMax = 0;
  rt.freqPeakRow = null;
  rt.needsViewReset = true;
  const axisId = `${rt.id}_axis`;
  (window as any).ipAxisStream?.clear(axisId);
};

const resolveSoundLinks = (store: Store) => {
  const links = new Map<string, SoundLinks>();
  soundButtons.clear();
  for (const node of store.model.nodes as any[]) {
    const sid = String(node?.soundId ?? "");
    if (!sid) continue;
    const entry = links.get(sid) ?? { id: sid };
    if (node.type === "group" || node.soundRole === "root") entry.root = node;
    if (node.soundRole === "axis" && node.type === "axis") entry.axis = node;
    if (node.soundRole === "buttons" && node.type === "buttons") {
      entry.buttons = node;
      soundButtons.set(String(node.id ?? ""), sid);
    }
    if (node.soundRole === "mode-buttons" && node.type === "buttons") {
      entry.modeButtons = node;
      soundButtons.set(String(node.id ?? ""), sid);
    }
    if (node.soundRole === "threshold" && node.type === "slider") {
      entry.threshold = node;
    }
    if (node.type === "text") {
      const nid = String(node.id ?? "");
      if (nid.endsWith("_x_label")) entry.xLabel = node;
      else if (nid.endsWith("_y_label")) entry.yLabel = node;
      else if (nid.endsWith("_peak")) entry.peak = node;
    }
    links.set(sid, entry);
  }
  return links;
};

const applyAxisDefaults = (rt: SoundRuntime, links: SoundLinks) => {
  const axis = links.axis;
  if (!axis) return;
  const windowS = Math.max(0.5, rt.windowS);
  const timeWindowS = windowS;
  const maxPoints = Math.max(200, Math.round((windowS * 1000) / Math.max(0.5, rt.sampleMs)));
  rt.maxPoints = maxPoints;
  axis.maxPoints = maxPoints;
  axis.padPx = Number(axis.padPx ?? 40);
  axis.clamp = true;
  axis.limits =
    rt.mode === "time"
      ? { xMin: 0, xMax: timeWindowS, yMin: 0, yMax: 1.1 }
      : { xMin: 0, xMax: 3000, yMin: 0, yMax: 1.1 };
  if (rt.needsViewReset) {
    const view = axis.limits as AxisView;
    (window as any).ipAxisStream?.setView?.(String(axis.id ?? ""), view);
    rt.needsViewReset = false;
  }
};

const updateLabels = (rt: SoundRuntime, links: SoundLinks) => {
  const runPauseResume = rt.running ? rt.pauseLabel : rt.hasRunOnce ? rt.resumeLabel : rt.runLabel;
  const modeToggle = rt.mode === "spectrum" ? rt.timeLabel : rt.freqLabel;
  const fLabelTpl = rt.fLabel || "{{freqLabel}}";
  const tLabelTpl = rt.tLabel || "{{timeLabel}}";
  const freqLabel = formatTemplate(fLabelTpl, { freqLabel: rt.freqLabel, timeLabel: rt.timeLabel });
  const timeLabel = formatTemplate(tLabelTpl, { freqLabel: rt.freqLabel, timeLabel: rt.timeLabel });
  const fXLabelTpl = rt.fXLabel || rt.fLabel || "{{freqLabel}}";
  const tXLabelTpl = rt.tXLabel || rt.tLabel || "{{timeLabel}}";
  const fYLabelTpl = rt.fYLabel || rt.yLabel || "Normalized Intensity";
  const tYLabelTpl = rt.tYLabel || rt.yLabel || "Normalized Intensity";
  const freqXLabel = formatTemplate(fXLabelTpl, { freqLabel, timeLabel });
  const timeXLabel = formatTemplate(tXLabelTpl, { freqLabel, timeLabel });
  const freqYLabel = formatTemplate(fYLabelTpl, { freqLabel, timeLabel });
  const timeYLabel = formatTemplate(tYLabelTpl, { freqLabel, timeLabel });
  const currentXLabel = rt.mode === "spectrum" ? freqXLabel : timeXLabel;
  const currentYLabel = rt.mode === "spectrum" ? freqYLabel : timeYLabel;
  const peakValue =
    rt.mode === "spectrum"
      ? rt.lastPeakHz != null
        ? rt.lastPeakHz.toFixed(1)
        : "-"
      : "-";
  const peakList =
    rt.mode === "spectrum"
      ? rt.lastPeakHz != null
        ? `${rt.lastPeakHz.toFixed(1)} Hz`
        : "-"
      : rt.lastPeakTimes.length
        ? rt.lastPeakTimes.slice(0, 12).map((t) => t.toFixed(3)).join(", ")
        : "-";
  rt.peakList = peakList;
  const data = {
    runPauseResume,
    runLabel: rt.runLabel,
    resumeLabel: rt.resumeLabel,
    pauseLabel: rt.pauseLabel,
    modeToggle,
    resetLabel: rt.resetLabel,
    homeLabel: rt.homeLabel,
    freqLabel,
    timeLabel,
    freqButtonLabel: rt.freqButtonLabel,
    timeButtonLabel: rt.timeButtonLabel,
    currentLabel: currentXLabel,
    currentXLabel,
    currentYLabel,
    xLabel: currentXLabel,
    yLabel: currentYLabel,
    fXLabel: freqXLabel,
    tXLabel: timeXLabel,
    fYLabel: freqYLabel,
    tYLabel: timeYLabel,
    peakLabel: rt.peakLabel,
    peakList,
    peakValue,
    peak: peakValue,
    value: peakValue,
  };
  const applyText = (node?: any) => {
    if (!node) return;
    const template = String(node.template ?? node.text ?? "");
    const next = formatTemplate(template, data);
    if (node.text !== next) node.text = next;
  };
  applyText(links.xLabel);
  applyText(links.yLabel);
  applyText(links.peak);
  if (links.buttons) {
    const templates = Array.isArray(links.buttons.templates)
      ? links.buttons.templates
      : Array.isArray(links.buttons.labels)
        ? links.buttons.labels
        : [];
    const labels = templates.map((tpl: string) => formatTemplate(tpl, data));
    links.buttons.labels = labels;
  }
  if (links.modeButtons) {
    const templates = Array.isArray(links.modeButtons.templates)
      ? links.modeButtons.templates
      : Array.isArray(links.modeButtons.labels)
        ? links.modeButtons.labels
        : [];
    const labels = templates.map((tpl: string) => formatTemplate(tpl, data));
    links.modeButtons.labels = labels;
    if (String(links.modeButtons.buttonsMode ?? "") === "radio") {
      links.modeButtons.buttonsState = [rt.mode === "spectrum", rt.mode === "time"];
    }
  }
};

const updateSpectrumSeries = (rt: SoundRuntime, links: SoundLinks, timeMs: number) => {
  if (!rt.audio || !links.axis) return;
  if (timeMs - rt.lastSpectrumMs < 40) return;
  rt.lastSpectrumMs = timeMs;
  const analyser = rt.audio.analyser;
  const freqData = rt.audio.freqData;
  analyser.getFloatFrequencyData(freqData);
  const sampleRate = rt.audio.ctx.sampleRate;
  const maxHz = Math.min(8000, sampleRate / 2);
  const binCount = freqData.length;
  const stride = Math.max(1, Math.floor(binCount / 256));
  const points: Array<{ x: number; y: number }> = [];
  let peakHz = 0;
  let peakDb = -1e9;
  let peakNorm = 0;
  for (let i = 0; i < binCount; i += stride) {
    const hz = (i / Math.max(1, binCount - 1)) * (sampleRate / 2);
    if (hz > maxHz + 1) break;
    const db = Number(freqData[i] ?? -120);
    const norm = Math.max(0, Math.min(1, (db + 120) / 120));
    points.push({ x: hz, y: norm });
    if (db > peakDb) {
      peakDb = db;
      peakHz = hz;
      peakNorm = norm;
    }
  }
  rt.lastPeakHz = Number.isFinite(peakHz) ? peakHz : null;
  emitFrequencyPeak(rt, peakHz, peakNorm, peakDb);
  const lineColor = "orange";
  (window as any).ipAxisStream?.push({
    axisId: String(links.axis.id ?? ""),
    type: "graph",
    seriesId: "spectrum",
    color: lineColor,
    lineWidth: rt.lineWidth,
    mode: "replace",
    points,
  });
};

const updateTimeSeries = (rt: SoundRuntime, links: SoundLinks, timeMs: number) => {
  if (!links.axis) return;
  if (timeMs - rt.lastTimeMs < 33) return;
  rt.lastTimeMs = timeMs;
  const current = rt.pressure;
  const yMaxView = Number((links.axis as any)?.limits?.yMax ?? 1.1);
  const yMaxSafe = Math.max(1e-6, yMaxView);
  const points = current.map((p) => ({
    x: p.t,
    y: Math.max(0, Math.min(1, p.y / yMaxSafe)),
  }));
  const peakTimes: number[] = [];
  const peakPairs: Array<{ t: number; yNorm: number; raw: number }> = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prevY = points[i - 1]!.y;
    const curY = points[i]!.y;
    const nextY = points[i + 1]!.y;
    if (curY >= prevY && curY > nextY) {
      peakTimes.push(points[i]!.x);
      peakPairs.push({ t: points[i]!.x, yNorm: curY, raw: current[i]?.y ?? curY * yMaxSafe });
    }
  }
  rt.lastPeakTimes = peakTimes;
  if (links.axis && activeStore) syncPeakHeader(activeStore, rt);
  emitTimePeaks(rt, 0, peakPairs);
  const axisLimits = (links.axis as any)?.limits as AxisView | undefined;
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
    seriesId: "pressure-prev",
    color: "rgba(255,255,255,0.0)",
    lineWidth: rt.lineWidth,
    mode: "replace",
    points: [],
  });
  const lineColor = "orange";
  (window as any).ipAxisStream?.push({
    axisId: String(links.axis.id ?? ""),
    type: "graph",
    seriesId: "pressure",
    color: lineColor,
    lineWidth: rt.lineWidth,
    mode: "replace",
    points,
  });
};

const syncRuntimeFromNodes = (rt: SoundRuntime, links: SoundLinks) => {
  const root = links.root;
  const nextMode = normalizeMode(root?.soundMode ?? root?.mode ?? rt.mode);
  const nextWindowS = Number(root?.soundWindowS ?? root?.windowS ?? rt.windowS);
  const nextSampleMs = Number(root?.soundSampleMs ?? root?.sampleMs ?? rt.sampleMs);
  const nextColor = String(root?.soundColor ?? root?.color ?? rt.color);
  const nextLineWidth = Number(root?.soundLineWidth ?? rt.lineWidth);
  const nextPeakLabel = String(root?.soundPeakLabel ?? root?.peakLabel ?? rt.peakLabel);
  const nextFOutputCol = String(root?.soundFOutputCol ?? rt.fOutputCol ?? "");
  const nextTOutputCol = String(root?.soundTOutputCol ?? rt.tOutputCol ?? "");
  const nextRunLabel = String(root?.soundRunLabel ?? root?.runLabel ?? rt.runLabel);
  const nextResumeLabel = String(root?.soundResumeLabel ?? root?.resumeLabel ?? rt.resumeLabel);
  const nextPauseLabel = String(root?.soundPauseLabel ?? root?.pauseLabel ?? rt.pauseLabel);
  const nextResetLabel = String(root?.soundResetLabel ?? root?.resetLabel ?? rt.resetLabel);
  const nextHomeLabel = String(root?.soundHomeLabel ?? root?.homeLabel ?? rt.homeLabel);
  const nextTimeLabel = String(root?.soundTimeLabel ?? root?.timeModeLabel ?? rt.timeLabel);
  const nextFreqLabel = String(root?.soundFreqLabel ?? root?.freqModeLabel ?? rt.freqLabel);
  const nextYLabel = String(root?.soundYLabel ?? rt.yLabel);
  const nextFLabel = String(root?.soundFLabel ?? rt.fLabel);
  const nextTLabel = String(root?.soundTLabel ?? rt.tLabel);
  const nextFXLabel = String(root?.soundFXLabel ?? rt.fXLabel);
  const nextFYLabel = String(root?.soundFYLabel ?? rt.fYLabel);
  const nextTXLabel = String(root?.soundTXLabel ?? rt.tXLabel);
  const nextTYLabel = String(root?.soundTYLabel ?? rt.tYLabel);
  const nextFreqButtonLabel = String(root?.soundFreqButtonLabel ?? rt.freqButtonLabel);
  const nextTimeButtonLabel = String(root?.soundTimeButtonLabel ?? rt.timeButtonLabel);
  if (Number.isFinite(nextWindowS) && nextWindowS > 0 && nextWindowS !== rt.windowS) {
    rt.windowS = nextWindowS;
    rt.needsViewReset = true;
  }
  if (Number.isFinite(nextSampleMs) && nextSampleMs > 0 && nextSampleMs !== rt.sampleMs) {
    rt.sampleMs = nextSampleMs;
    rt.needsViewReset = true;
    if (rt.running) {
      shutdownSound(rt);
      void startSound(rt);
    }
  }
  if (nextColor && nextColor !== rt.color) rt.color = nextColor;
  if (Number.isFinite(nextLineWidth) && nextLineWidth > 0 && nextLineWidth !== rt.lineWidth) rt.lineWidth = nextLineWidth;
  if (nextPeakLabel && nextPeakLabel !== rt.peakLabel) rt.peakLabel = nextPeakLabel;
  if (nextRunLabel && nextRunLabel !== rt.runLabel) rt.runLabel = nextRunLabel;
  if (nextResumeLabel && nextResumeLabel !== rt.resumeLabel) rt.resumeLabel = nextResumeLabel;
  if (nextPauseLabel && nextPauseLabel !== rt.pauseLabel) rt.pauseLabel = nextPauseLabel;
  if (nextResetLabel && nextResetLabel !== rt.resetLabel) rt.resetLabel = nextResetLabel;
  if (nextHomeLabel && nextHomeLabel !== rt.homeLabel) rt.homeLabel = nextHomeLabel;
  if (nextTimeLabel && nextTimeLabel !== rt.timeLabel) rt.timeLabel = nextTimeLabel;
  if (nextFreqLabel && nextFreqLabel !== rt.freqLabel) rt.freqLabel = nextFreqLabel;
  if (nextYLabel && nextYLabel !== rt.yLabel) rt.yLabel = nextYLabel;
  if (nextFLabel && nextFLabel !== rt.fLabel) rt.fLabel = nextFLabel;
  if (nextTLabel && nextTLabel !== rt.tLabel) rt.tLabel = nextTLabel;
  if (nextFXLabel && nextFXLabel !== rt.fXLabel) rt.fXLabel = nextFXLabel;
  if (nextFYLabel && nextFYLabel !== rt.fYLabel) rt.fYLabel = nextFYLabel;
  if (nextTXLabel && nextTXLabel !== rt.tXLabel) rt.tXLabel = nextTXLabel;
  if (nextTYLabel && nextTYLabel !== rt.tYLabel) rt.tYLabel = nextTYLabel;
  if (nextFreqButtonLabel && nextFreqButtonLabel !== rt.freqButtonLabel) rt.freqButtonLabel = nextFreqButtonLabel;
  if (nextTimeButtonLabel && nextTimeButtonLabel !== rt.timeButtonLabel) rt.timeButtonLabel = nextTimeButtonLabel;
  if (nextFOutputCol !== rt.fOutputCol) rt.fOutputCol = nextFOutputCol;
  if (nextTOutputCol !== rt.tOutputCol) rt.tOutputCol = nextTOutputCol;
  if (nextMode !== rt.mode) setSoundMode(rt, nextMode);
};

const resolveTimeOutput = (store: Store, rt: SoundRuntime): TableOutput => {
  const explicit = parseTableOutput(rt.tOutputCol);
  if (explicit) return explicit;
  const placeholder = "{{peakLabel}}";
  for (const node of store.model.nodes as any[]) {
    if (node?.type !== "table") continue;
    const tableId = String(node?.id ?? "");
    if (!tableId) continue;
    const headers = Array.isArray(node.hHeader) ? node.hHeader.map((v: any) => String(v ?? "")) : [];
    const idx = headers.findIndex((h: string) => h.includes(placeholder));
    if (idx < 0) continue;
    const nextHeaders = headers.slice();
    nextHeaders[idx] = rt.peakLabel;
    node.hHeader = nextHeaders;
    return { tableId, col: idx + 1 };
  }
  return null;
};

const syncPeakHeader = (store: Store, rt: SoundRuntime) => {
  const placeholder = "{{peakLabel}}";
  for (const node of store.model.nodes as any[]) {
    if (node?.type !== "table") continue;
    const headers = Array.isArray(node.hHeader) ? node.hHeader.map((v: any) => String(v ?? "")) : [];
    const idx = headers.findIndex((h: string) => h.includes(placeholder));
    if (idx < 0) continue;
    const nextHeaders = headers.slice();
    nextHeaders[idx] = rt.peakLabel;
    node.hHeader = nextHeaders;
  }
};

export const updateSoundNodes = (store: Store, timeMs: number) => {
  activeStore = store;
  ensureSoundBus();
  const linksById = resolveSoundLinks(store);
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
      (links.axis as any).__soundRunning = rt.running;
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
      if (rt.running) void stopSound(rt);
      shutdownSound(rt);
    }
    updateLabels(rt, links);
    if (!live || !visibleInLive || !rt.running) continue;
    if (rt.mode === "spectrum") updateSpectrumSeries(rt, links, timeMs);
    else updateTimeSeries(rt, links, timeMs);
  }
  for (const id of Array.from(soundRuntime.keys())) {
    if (!linksById.has(id)) {
      shutdownSound(soundRuntime.get(id)!);
      soundRuntime.delete(id);
    }
  }
};
