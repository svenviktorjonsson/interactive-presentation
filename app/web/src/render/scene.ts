import type { Store } from "../core/store";
import QRCode from "qrcode";
import { activeView, fitCameraToScreen, resolveViewCamera } from "../core/store";
import { anchorOffsetPx, worldToScreen, worldToScreenScale } from "../core/geom";
import type { Node } from "../core/model";
import { renderTextWithKatexToHtmlCached } from "./textMath";
import { findNodeRenderAdapter } from "./nodeRenderRegistry";
import { updateBuiltinRenderModules } from "./moduleRegistry";
import { persistButtons } from "../core/transport";
import { isNodeInteractiveInMode } from "../core/mode";
import { sharedRenderRuntime } from "./renderRuntime";

type DomNodeHandle = { id: string; el: HTMLElement; update: () => void; destroy: () => void };

export type Scene = {
  overlay: HTMLElement;
  domNodes: Map<string, DomNodeHandle>;
};

let colorProbe: HTMLElement | null = sharedRenderRuntime.colorProbe;
const colorCache = sharedRenderRuntime.colorCache;
const qrCache = sharedRenderRuntime.qrCache;
const qrPending = sharedRenderRuntime.qrPending;
const videoPosterCache = sharedRenderRuntime.videoPosterCache;
const videoPosterPending = sharedRenderRuntime.videoPosterPending;
const youtubePlayers = sharedRenderRuntime.youtubePlayers;
const youtubePortals = sharedRenderRuntime.youtubePortals;
const cameraStreams = sharedRenderRuntime.cameraStreams;
const cameraRecorders = sharedRenderRuntime.cameraRecorders;
const cameraErrors = sharedRenderRuntime.cameraErrors;
const cameraErrorDetails = sharedRenderRuntime.cameraErrorDetails;
const cameraPreviewCooldown = sharedRenderRuntime.cameraPreviewCooldown;
const iframePreviewAttempts = sharedRenderRuntime.iframePreviewAttempts;
const iframePreviewTimers = sharedRenderRuntime.iframePreviewTimers;
const axisState = sharedRenderRuntime.axisState as Map<string, AxisState>;
const playerLinks = sharedRenderRuntime.playerLinks as Map<
  string,
  {
    videoEl?: HTMLVideoElement;
    iframeEl?: HTMLIFrameElement;
    sliderEl?: HTMLInputElement;
    videoNodeId?: string;
    playLabel?: string;
    pauseLabel?: string;
  }
>;
const webcamLinks = sharedRenderRuntime.webcamLinks as Map<string, { shot?: () => void; toggleRec?: () => void }>;

type AxisSeriesType = "bar" | "graph" | "scatter";
type AxisPoint = { x: number; y: number; w?: number };
type AxisSeries = {
  id: string;
  type: AxisSeriesType;
  points: AxisPoint[];
  color?: string;
  barWidth?: number;
  dash?: number[];
};
type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };
type AxisState = {
  view: AxisView;
  limits: AxisView | null;
  clamp: boolean;
  padPx: number;
  maxPoints: number;
  series: Map<string, AxisSeries>;
};
type AxisPacket = {
  axisId?: string;
  id?: string;
  type: AxisSeriesType;
  seriesId?: string;
  color?: string;
  points?: AxisPoint[];
  mode?: "append" | "replace" | "clear";
  barWidth?: number;
  lineWidth?: number;
  dash?: number[];
};

const AXIS_STREAM_EVENT = "ip-axis-data";

const inferPlayerId = (node: any): string => {
  const raw = String(node?.playerId ?? "").trim();
  if (raw) return raw;
  const id = String(node?.id ?? "").trim();
  if (!id) return "";
  if (id.endsWith("_video")) return id.slice(0, -"_video".length);
  if (id.endsWith("_buttons")) return id.slice(0, -"_buttons".length);
  if (id.endsWith("_slider")) return id.slice(0, -"_slider".length);
  return "";
};

const ensurePlayerBus = () => {
  if (sharedRenderRuntime.playerBusInstalled || typeof window === "undefined") return;
  sharedRenderRuntime.playerBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const id = String(detail?.id ?? "");
    const actionRaw = String(detail?.action ?? "").toLowerCase();
    const action = (() => {
      if (actionRaw === "hplay") return "play";
      if (actionRaw === "hpause") return "pause";
      if (actionRaw === "hstop") return "stop";
      if (actionRaw === "htoggle") return "toggle";
      return actionRaw;
    })();
    const playerId =
      String(detail?.playerId ?? "") || (id.endsWith("_buttons") ? id.slice(0, -"_buttons".length) : id);
    console.log("[player] buttons action", { id, playerId, actionRaw, action, detail });
    const link = playerLinks.get(playerId);
    const videoEl = link?.videoEl;
    const yt = link?.videoNodeId ? youtubePlayers.get(String(link.videoNodeId)) : null;
    const ensureYt = () =>
      link?.videoNodeId && link?.iframeEl ? ensureYoutubePlayer(String(link.videoNodeId), link.iframeEl) : null;
    if (action === "play") {
      if (yt) yt.playVideo?.();
      else {
        const pending = ensureYt();
        if (pending) void pending.then((p) => p?.playVideo?.());
        else void videoEl?.play().catch(() => {});
      }
      return;
    }
    if (action === "pause") {
      if (yt) yt.pauseVideo?.();
      else {
        const pending = ensureYt();
        if (pending) void pending.then((p) => p?.pauseVideo?.());
        else videoEl?.pause();
      }
      return;
    }
    if (action === "toggle") {
      if (yt) {
        const state = yt.getPlayerState?.();
        if (state === 1) yt.pauseVideo?.();
        else yt.playVideo?.();
      } else {
        const pending = ensureYt();
        if (pending) {
          void pending.then((p) => {
            const state = p?.getPlayerState?.();
            if (state === 1) p?.pauseVideo?.();
            else p?.playVideo?.();
          });
        } else if (videoEl) {
          if (videoEl.paused) void videoEl.play().catch(() => {});
          else videoEl.pause();
        }
      }
      return;
    }
    if (action === "stop") {
      if (yt) {
        yt.pauseVideo?.();
        yt.seekTo?.(0, true);
      } else if (videoEl) {
        videoEl.pause();
        videoEl.currentTime = 0;
      } else {
        const pending = ensureYt();
        if (pending) {
          void pending.then((p) => {
            p?.pauseVideo?.();
            p?.seekTo?.(0, true);
          });
        }
      }
      return;
    }
    const seekMatch = action.match(/^(seek|time):\s*([0-9.]+)$/);
    if (seekMatch) {
      const val = Number(seekMatch[2]);
      if (Number.isFinite(val)) {
        const dur = yt ? Number(yt.getDuration?.() ?? 0) : Number(videoEl?.duration ?? 0);
        if (seekMatch[1] === "seek" && dur > 0) {
          const t = Math.max(0, Math.min(dur, val * dur));
          if (yt) yt.seekTo?.(t, true);
          else {
            const pending = ensureYt();
            if (pending) void pending.then((p) => p?.seekTo?.(t, true));
            else if (videoEl) videoEl.currentTime = t;
          }
        } else {
          const t = Math.max(0, val);
          if (yt) yt.seekTo?.(t, true);
          else {
            const pending = ensureYt();
            if (pending) void pending.then((p) => p?.seekTo?.(t, true));
            else if (videoEl) videoEl.currentTime = t;
          }
        }
      }
      return;
    }
    const frameMatch = action.match(/^frame:\s*(-?\d+)$/);
    if (frameMatch) {
      const frame = Number(frameMatch[1]);
      if (Number.isFinite(frame) && videoEl) {
        const fps = 30;
        videoEl.currentTime = Math.max(0, videoEl.currentTime + frame / fps);
      }
    }
  });
  window.addEventListener("ip-slider-change", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const id = String(detail?.id ?? "");
    const playerId =
      String(detail?.playerId ?? "") || (id.endsWith("_slider") ? id.slice(0, -"_slider".length) : id);
    console.log("[player] slider change", { id, playerId, detail });
    const link = playerLinks.get(playerId);
    const videoEl = link?.videoEl;
    const yt = link?.videoNodeId ? youtubePlayers.get(String(link.videoNodeId)) : null;
    const ensureYt = () =>
      link?.videoNodeId && link?.iframeEl ? ensureYoutubePlayer(String(link.videoNodeId), link.iframeEl) : null;
    const min = Number(detail?.min ?? 0);
    const max = Number(detail?.max ?? 1);
    const value = Number(detail?.value ?? 0);
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    const frac = (value - min) / (max - min);
    const dur = yt ? Number(yt.getDuration?.() ?? 0) : Number(videoEl?.duration ?? 0);
    if (Number.isFinite(dur) && dur > 0) {
      const t = Math.max(0, Math.min(dur, frac * dur));
      if (yt) yt.seekTo?.(t, true);
      else {
        const pending = ensureYt();
        if (pending) void pending.then((p) => p?.seekTo?.(t, true));
        else if (videoEl) videoEl.currentTime = t;
      }
    }
  });
};

const ensureWebcamBus = () => {
  if (sharedRenderRuntime.webcamBusInstalled || typeof window === "undefined") return;
  sharedRenderRuntime.webcamBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const playerId = String(detail?.playerId ?? "");
    if (!playerId) return;
    const link = webcamLinks.get(playerId);
    if (!link) return;
    const action = String(detail?.action ?? "").toLowerCase();
    if (action === "shot" || action === "screenshot") {
      link.shot?.();
    } else if (action === "rec" || action === "record" || action === "toggle-rec") {
      link.toggleRec?.();
    }
  });
};

const ensureCameraStream = async (nodeId: string, opts: { deviceId?: string }) => {
  const existing = cameraStreams.get(nodeId);
  if (existing) {
    const liveTracks = existing.getTracks().filter((t) => t.readyState === "live");
    if (liveTracks.length) return existing;
    cameraStreams.delete(nodeId);
  }
  const constraints: MediaStreamConstraints = {
    video: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true,
    audio: false,
  };
  logCameraDebug("getUserMedia", { nodeId, constraints });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err: any) {
    const name = String(err?.name ?? "");
    logCameraDebug("getUserMedia failed", { nodeId, name, message: String(err?.message ?? "") });
    if (name === "NotReadableError") {
      stopAllCameraStreams();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (opts.deviceId && (name === "NotReadableError" || name === "OverconstrainedError" || name === "NotFoundError")) {
      logCameraDebug("retry without deviceId", { nodeId });
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } else if (name === "NotReadableError") {
      logCameraDebug("retry with same constraints", { nodeId });
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } else {
      throw err;
    }
  }
  cameraStreams.set(nodeId, stream);
  return stream;
};
const stopCameraStream = (nodeId: string) => {
  const stream = cameraStreams.get(nodeId);
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  cameraStreams.delete(nodeId);
};
const stopAllCameraStreams = () => {
  for (const id of Array.from(cameraStreams.keys())) {
    stopCameraStream(id);
  }
};

const logCameraDebug = (msg: string, data?: Record<string, unknown>) => {
  if (!(window as any).__ipDebugCamera) return;
  console.log(`[camera] ${msg}`, data ?? {});
};
const youtubePending = sharedRenderRuntime.youtubePending;
let youtubeApiPromise: Promise<any> | null = null;

const ensureColorProbe = () => {
  if (colorProbe) return colorProbe;
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "-99999px";
  el.style.top = "-99999px";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  colorProbe = el;
  sharedRenderRuntime.colorProbe = el;
  return el;
};

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

const parseRgb = (v: string) => {
  const raw = v.trim();
  if (!raw) return null;
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    const norm = hex.length === 3 || hex.length === 4 ? hex.split("").map((c) => c + c).join("") : hex;
    if (norm.length === 6 || norm.length === 8) {
      const r = parseInt(norm.slice(0, 2), 16);
      const g = parseInt(norm.slice(2, 4), 16);
      const b = parseInt(norm.slice(4, 6), 16);
      return { r, g, b };
    }
  }
  const m = raw.match(/^rgba?\((.+)\)$/i);
  if (m) {
    const parts = m[1].split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      const toNum = (p: string) => {
        if (p.endsWith("%")) return (parseFloat(p) / 100) * 255;
        return parseFloat(p);
      };
      const r = toNum(parts[0] ?? "0");
      const g = toNum(parts[1] ?? "0");
      const b = toNum(parts[2] ?? "0");
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
    }
  }
  const tuple = raw.match(/^\((.+)\)$/);
  if (tuple) {
    const parts = tuple[1].split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map((p) => Number(p));
      if (nums.every((n) => Number.isFinite(n))) {
        const max = Math.max(...nums.map((n) => Math.abs(n)));
        if (max <= 1) {
          return { r: nums[0] * 255, g: nums[1] * 255, b: nums[2] * 255 };
        }
        return { r: nums[0], g: nums[1], b: nums[2] };
      }
    }
  }
  return null;
};

const resolveRgb = (color: string) => {
  const cached = colorCache.get(color);
  if (cached) return cached;
  const probe = ensureColorProbe();
  probe.style.color = color;
  const computed = getComputedStyle(probe).color;
  colorCache.set(color, computed);
  return computed;
};

const parseTimeToSeconds = (raw: string) => {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => (p.includes(".") ? Number(p) : Number(p)));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return nums[0]! * 60 + nums[1]!;
  return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
};

const parseYoutubeId = (src: string) => {
  const s = src.trim();
  if (!s) return null;
  try {
    const u = new URL(s, window.location.origin);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return id || null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/embed\/([^/]+)/);
      if (m) return m[1] ?? null;
    }
  } catch {}
  return null;
};

const axisDefaultView = (): AxisView => ({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 });

const clampAxisView = (view: AxisView, limits: AxisView | null, clamp: boolean): AxisView => {
  const out = { ...view };
  const minRange = 1e-6;
  if (out.xMax - out.xMin < minRange) out.xMax = out.xMin + minRange;
  if (out.yMax - out.yMin < minRange) out.yMax = out.yMin + minRange;
  if (!clamp || !limits) return out;
  const hasX = Number.isFinite(limits.xMin) && Number.isFinite(limits.xMax);
  const hasY = Number.isFinite(limits.yMin) && Number.isFinite(limits.yMax);
  if (hasX) {
    const width = out.xMax - out.xMin;
    const limitW = limits.xMax - limits.xMin;
    if (limitW > minRange && width > limitW) {
      out.xMin = limits.xMin;
      out.xMax = limits.xMax;
    } else {
      if (out.xMin < limits.xMin) {
        out.xMax += limits.xMin - out.xMin;
        out.xMin = limits.xMin;
      }
      if (out.xMax > limits.xMax) {
        out.xMin -= out.xMax - limits.xMax;
        out.xMax = limits.xMax;
      }
    }
  }
  if (hasY) {
    const height = out.yMax - out.yMin;
    const limitH = limits.yMax - limits.yMin;
    if (limitH > minRange && height > limitH) {
      out.yMin = limits.yMin;
      out.yMax = limits.yMax;
    } else {
      if (out.yMin < limits.yMin) {
        out.yMax += limits.yMin - out.yMin;
        out.yMin = limits.yMin;
      }
      if (out.yMax > limits.yMax) {
        out.yMin -= out.yMax - limits.yMax;
        out.yMax = limits.yMax;
      }
    }
  }
  return out;
};

const getAxisState = (node: any): AxisState => {
  const id = String(node?.id ?? "");
  const existing = axisState.get(id);
  const limitsRaw = node?.limits ?? null;
  const limits = limitsRaw
    ? {
        xMin: Number(limitsRaw.xMin),
        xMax: Number(limitsRaw.xMax),
        yMin: Number(limitsRaw.yMin),
        yMax: Number(limitsRaw.yMax),
      }
    : null;
  const padPx = Number(node?.padPx ?? 40);
  const maxPoints = Math.max(10, Math.floor(Number(node?.maxPoints ?? 2000)));
  const clamp = node?.clamp ?? !!limitsRaw;
  if (existing) {
    existing.limits = limits;
    existing.padPx = padPx;
    existing.maxPoints = maxPoints;
    existing.clamp = !!clamp;
    if (limits) existing.view = clampAxisView(existing.view, limits, existing.clamp);
    return existing;
  }
  const fallback = axisDefaultView();
  const baseView = limits
    ? {
        xMin: Number.isFinite(limits.xMin) ? limits.xMin : fallback.xMin,
        xMax: Number.isFinite(limits.xMax) ? limits.xMax : fallback.xMax,
        yMin: Number.isFinite(limits.yMin) ? limits.yMin : fallback.yMin,
        yMax: Number.isFinite(limits.yMax) ? limits.yMax : fallback.yMax,
      }
    : fallback;
  const view = clampAxisView(baseView, limits, !!clamp);
  const st: AxisState = { view, limits, clamp: !!clamp, padPx, maxPoints, series: new Map() };
  axisState.set(id, st);
  return st;
};

const applyAxisPacket = (packet: AxisPacket) => {
  const axisId = String(packet.axisId ?? packet.id ?? "");
  if (!axisId) return;
  const state = axisState.get(axisId) ?? (() => {
    const st: AxisState = {
      view: axisDefaultView(),
      limits: null,
      clamp: false,
      padPx: 40,
      maxPoints: 2000,
      series: new Map(),
    };
    axisState.set(axisId, st);
    return st;
  })();
  const seriesId = String(packet.seriesId ?? packet.type ?? "series");
  const existing = state.series.get(seriesId) ?? { id: seriesId, type: packet.type, points: [] };
  existing.type = packet.type;
  if (packet.color) existing.color = packet.color;
  if (typeof packet.lineWidth === "number") (existing as any).lineWidth = packet.lineWidth;
  if (typeof packet.barWidth === "number") existing.barWidth = packet.barWidth;
  if (Array.isArray(packet.dash)) (existing as any).dash = packet.dash;
  const points = packet.points ?? [];
  const mode = packet.mode ?? "append";
  if (mode === "clear") {
    existing.points = [];
  } else if (mode === "replace") {
    existing.points = points.slice();
  } else {
    existing.points = existing.points.concat(points);
  }
  if (existing.points.length > state.maxPoints) {
    existing.points = existing.points.slice(existing.points.length - state.maxPoints);
  }
  state.series.set(seriesId, existing);
};

const ensureAxisStream = () => {
  if (typeof window === "undefined") return;
  const w = window as any;
  if (w.__ipAxisStreamInstalled) return;
  w.__ipAxisStreamInstalled = true;
  w.ipAxisStream = {
    push: (packet: AxisPacket) => applyAxisPacket(packet),
    clear: (axisId?: string, seriesId?: string) => {
      if (!axisId) {
        axisState.clear();
        return;
      }
      const st = axisState.get(String(axisId));
      if (!st) return;
      if (!seriesId) st.series.clear();
      else st.series.delete(String(seriesId));
    },
    setView: (axisId?: string, view?: Partial<AxisView>) => {
      if (!axisId || !view) return;
      const id = String(axisId);
      const st =
        axisState.get(id) ??
        (() => {
          const base: AxisState = { view: axisDefaultView(), limits: null, clamp: false, padPx: 40, maxPoints: 2000, series: new Map() };
          axisState.set(id, base);
          return base;
        })();
      const next = {
        xMin: Number.isFinite(Number(view.xMin)) ? Number(view.xMin) : st.view.xMin,
        xMax: Number.isFinite(Number(view.xMax)) ? Number(view.xMax) : st.view.xMax,
        yMin: Number.isFinite(Number(view.yMin)) ? Number(view.yMin) : st.view.yMin,
        yMax: Number.isFinite(Number(view.yMax)) ? Number(view.yMax) : st.view.yMax,
      };
      st.view = clampAxisView(next, st.limits, st.clamp);
    },
  };
  window.addEventListener(AXIS_STREAM_EVENT, (ev: Event) => {
    const detail = (ev as CustomEvent).detail as AxisPacket | undefined;
    if (detail) applyAxisPacket(detail);
  });
};

const niceStep = (range: number, targetTicks: number) => {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = [1, 2, 5, 10];
  for (const s of steps) {
    const step = s * pow;
    if (step >= raw) return step;
  }
  return 10 * pow;
};

const renderAxisNode = (ctx: CanvasRenderingContext2D, el: HTMLElement, node: any, timeMs: number) => {
  const canvas = el.querySelector<HTMLCanvasElement>(".axis-canvas");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = el.getBoundingClientRect();
  const wPx = Math.max(1, rect.width);
  const hPx = Math.max(1, rect.height);
  if (canvas.width !== Math.floor(wPx * dpr) || canvas.height !== Math.floor(hPx * dpr)) {
    canvas.width = Math.floor(wPx * dpr);
    canvas.height = Math.floor(hPx * dpr);
  }
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const state = getAxisState(node);
  const uiScale = Number(el.style.getPropertyValue("--node-ui-scale")) || 1;
  const pad = Math.max(18, state.padPx * uiScale);
  const plotLeft = pad;
  const plotRight = wPx - pad;
  const plotTop = pad;
  const plotBottom = hPx - pad;
  const plotW = Math.max(1, plotRight - plotLeft);
  const plotH = Math.max(1, plotBottom - plotTop);
  const view = state.view;

  const xToPx = (x: number) => plotLeft + ((x - view.xMin) / (view.xMax - view.xMin)) * plotW;
  const yToPx = (y: number) => plotBottom - ((y - view.yMin) / (view.yMax - view.yMin)) * plotH;

  ctx.clearRect(0, 0, wPx, hPx);
  ctx.fillStyle = "rgba(7, 10, 16, 0.6)";
  ctx.fillRect(0, 0, wPx, hPx);
  // Inner plot frame aligned with data region.
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.strokeRect(plotLeft, plotTop, plotW, plotH);

  const xRange = view.xMax - view.xMin;
  const yRange = view.yMax - view.yMin;
  const xStep = niceStep(xRange, 6);
  const yStep = niceStep(yRange, 6);
  ctx.font = `${Math.max(10, 12 * uiScale)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.strokeStyle = "rgba(255,255,255,0.08)";

  for (let x = Math.ceil(view.xMin / xStep) * xStep; x <= view.xMax + 1e-9; x += xStep) {
    const px = xToPx(x);
    ctx.beginPath();
    ctx.moveTo(px, plotTop);
    ctx.lineTo(px, plotBottom);
    ctx.stroke();
    const label = Number(x.toFixed(6)).toString();
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, px - tw / 2, plotBottom + Math.max(12, 14 * uiScale));
  }
  for (let y = Math.ceil(view.yMin / yStep) * yStep; y <= view.yMax + 1e-9; y += yStep) {
    const py = yToPx(y);
    ctx.beginPath();
    ctx.moveTo(plotLeft, py);
    ctx.lineTo(plotRight, py);
    ctx.stroke();
    const label = Number(y.toFixed(6)).toString();
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.max(2, plotLeft - tw - 6), py + Math.max(4, 4 * uiScale));
  }

  const palette = ["#7fb3ff", "#ff9f6e", "#8dd88a", "#ff6e6e", "#b68cff"];
  let seriesIndex = 0;
  // Clip data to plot region (inner frame).
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotW, plotH);
  ctx.clip();
  for (const series of state.series.values()) {
    const color = series.color ?? palette[seriesIndex % palette.length]!;
    seriesIndex += 1;
    if (series.type === "graph") {
      const seriesLineWidth = (series as any).lineWidth;
      const seriesDash = Array.isArray((series as any).dash) ? (series as any).dash : null;
      if (seriesDash) {
        ctx.setLineDash(seriesDash.map((v: number) => v * uiScale));
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, Number.isFinite(seriesLineWidth) ? seriesLineWidth : 1) * uiScale;
      ctx.beginPath();
      let started = false;
      for (const p of series.points) {
        const px = xToPx(p.x);
        const py = yToPx(p.y);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (series.type === "scatter") {
      ctx.fillStyle = color;
      const r = Math.max(2, 3 * uiScale);
      for (const p of series.points) {
        const px = xToPx(p.x);
        const py = yToPx(p.y);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (series.type === "bar") {
      ctx.fillStyle = color;
      const binsRaw = Array.isArray(node?.bins) ? (node.bins as number[]) : [];
      const bins = binsRaw.filter((v) => Number.isFinite(v)).map((v) => Number(v));
      const width = series.barWidth ?? xRange / Math.max(1, Math.min(50, series.points.length));
      for (let i = 0; i < series.points.length; i += 1) {
        const p = series.points[i]!;
        let xLeft: number | null = null;
        let xRight: number | null = null;
        if (bins.length >= 2) {
          if (bins.length === series.points.length + 1) {
            xLeft = bins[i] ?? null;
            xRight = bins[i + 1] ?? null;
          } else {
            for (let b = 0; b < bins.length - 1; b += 1) {
              const lo = bins[b]!;
              const hi = bins[b + 1]!;
              if (p.x >= lo && p.x <= hi) {
                xLeft = lo;
                xRight = hi;
                break;
              }
            }
          }
        }
        if (xLeft == null || xRight == null) {
          const half = width / 2;
          xLeft = p.x - half;
          xRight = p.x + half;
        }
        const x0 = xToPx(xLeft);
        const x1 = xToPx(xRight);
        const y0 = yToPx(Math.max(0, p.y));
        const y1 = yToPx(0);
        const left = Math.min(x0, x1);
        const right = Math.max(x0, x1);
        const top = Math.min(y0, y1);
        const height = Math.max(1, Math.abs(y1 - y0));
        ctx.fillRect(left, top, Math.max(1, right - left), height);
      }
    }
  }
  ctx.restore();

  void timeMs;
};

const ensureYoutubeApi = () => {
  if (youtubeApiPromise) return youtubeApiPromise;
  console.log("[player] loading YouTube API");
  youtubeApiPromise = new Promise((resolve) => {
    const existing = (window as any).YT;
    if (existing?.Player) return resolve(existing);
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    (window as any).onYouTubeIframeAPIReady = () => resolve((window as any).YT);
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
};

const ensureIframeLoaded = (iframe: HTMLIFrameElement) => {
  if (iframe.dataset.loaded === "1") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onLoad = () => {
      iframe.dataset.loaded = "1";
      resolve();
    };
    iframe.addEventListener("load", onLoad, { once: true });
  });
};

const ensureYoutubePlayer = (nodeId: string, iframe: HTMLIFrameElement) => {
  if (youtubePlayers.has(nodeId)) return Promise.resolve(youtubePlayers.get(nodeId));
  if (youtubePending.has(nodeId)) return youtubePending.get(nodeId)!;
  const p = ensureIframeLoaded(iframe).then(() =>
    ensureYoutubeApi().then(
      (YT) =>
        new Promise((resolve) => {
          console.log("[player] creating YT player", { nodeId, src: iframe.src });
          const player = new YT.Player(iframe, {
            playerVars: {
              origin: window.location.origin,
              playsinline: 1,
            },
            events: {
              onReady: () => {
                console.log("[player] YT ready", { nodeId });
                youtubePlayers.set(nodeId, player);
                resolve(player);
              },
              onError: (err: any) => {
                console.warn("[player] YT error", { nodeId, err });
              },
              onStateChange: (ev: any) => {
                console.log("[player] YT state", { nodeId, state: ev?.data });
              },
            },
          });
        })
    )
  );
  youtubePending.set(nodeId, p);
  return p;
};

const ensureVideoPoster = async (src: string, seconds: number) => {
  const key = `${src}::${seconds}`;
  if (videoPosterCache.has(key)) return videoPosterCache.get(key)!;
  if (videoPosterPending.has(key)) return videoPosterPending.get(key)!;
  const p = new Promise<string | null>((resolve) => {
    try {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.playsInline = true;
      v.src = src;
      v.addEventListener("loadedmetadata", () => {
        v.currentTime = Math.max(0, Math.min(seconds, v.duration || seconds));
      });
      v.addEventListener("seeked", () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth || 1;
          canvas.height = v.videoHeight || 1;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/jpeg", 0.85);
          videoPosterCache.set(key, data);
          resolve(data);
        } catch {
          resolve(null);
        }
      });
      v.addEventListener("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
  videoPosterPending.set(key, p);
  return p;
};

const applyBackground = (
  el: HTMLElement,
  colorRaw: string | undefined,
  alphaRaw: number | undefined,
  paddingRaw: number | undefined,
  radiusRaw: number | undefined,
  wPx: number,
  hPx: number
) => {
  const bg = el.querySelector<HTMLElement>(".node-bg");
  if (!bg) return;
  const color = String(colorRaw ?? "").trim();
  if (!color) {
    bg.style.display = "none";
    bg.style.backgroundColor = "transparent";
    return;
  }
  bg.style.display = "block";
  const alphaVal = Number(alphaRaw);
  const base = Math.max(1, wPx);
  const padVal = Number(paddingRaw);
  const radiusVal = Number(radiusRaw);
  const padIsRel = Number.isFinite(padVal) && Math.abs(padVal) <= 1;
  const radiusIsRel = Number.isFinite(radiusVal) && Math.abs(radiusVal) <= 1;
  // Relative values scale with box size; pixel values stay fixed on screen.
  const padPx = Number.isFinite(padVal) ? (padIsRel ? padVal * base : padVal) : 0;
  const radiusPx = Number.isFinite(radiusVal) ? (radiusIsRel ? radiusVal * base : radiusVal) : 0;
  const pad = Math.max(0, padPx);
  const maxRadius = Math.max(0, Math.min(wPx + pad * 2, hPx + pad * 2) / 2);
  const radius = Math.max(0, radiusIsRel ? radiusPx : Math.min(radiusPx, maxRadius));
  bg.style.left = `${-pad}px`;
  bg.style.top = `${-pad}px`;
  bg.style.width = `${wPx + pad * 2}px`;
  bg.style.height = `${hPx + pad * 2}px`;
  bg.style.borderRadius = radius > 0 ? `${radius + pad}px` : "0px";
  if (!Number.isFinite(alphaVal)) {
    bg.style.backgroundColor = color;
    return;
  }
  const alpha = Math.max(0, Math.min(1, alphaVal > 1 ? alphaVal / 255 : alphaVal));
  const parsed = parseRgb(color) ?? parseRgb(resolveRgb(color));
  if (!parsed) {
    bg.style.backgroundColor = color;
    return;
  }
  bg.style.backgroundColor = `rgba(${toByte(parsed.r)}, ${toByte(parsed.g)}, ${toByte(parsed.b)}, ${alpha})`;
};

const ensureYoutubePortal = (nodeId: string, iframe: HTMLIFrameElement) => {
  let portal = youtubePortals.get(nodeId);
  if (!portal) {
    portal = document.createElement("div");
    portal.className = "video-portal";
    portal.style.position = "fixed";
    portal.style.left = "0px";
    portal.style.top = "0px";
    portal.style.width = "0px";
    portal.style.height = "0px";
    portal.style.zIndex = "9999";
    portal.style.pointerEvents = "auto";
    youtubePortals.set(nodeId, portal);
  }
  const root = (document.fullscreenElement as HTMLElement | null) ?? document.body;
  if (portal.parentElement !== root) root.appendChild(portal);
  if (iframe.parentElement !== portal) portal.appendChild(iframe);
  return portal;
};

const releaseYoutubePortal = (nodeId: string, frame: HTMLElement, iframe: HTMLIFrameElement) => {
  const portal = youtubePortals.get(nodeId);
  if (!portal) return;
  if (iframe.parentElement === portal) frame.appendChild(iframe);
  portal.remove();
  youtubePortals.delete(nodeId);
};

export function createScene(overlay: HTMLElement): Scene {
  return { overlay, domNodes: new Map() };
}

export function renderScene(scene: Scene, store: Store, screen: { w: number; h: number }, timeMs: number) {
  ensureAxisStream();
  updateBuiltinRenderModules(store, timeMs);
  const view = activeView(store);
  const cam = store.cameraOverride ?? fitCameraToScreen(view.camera, store);
  const selectedSet = new Set(store.selectedIds ?? []);
  const byId = new Set(store.model.nodes.map((n) => n.id));
  const parentById = new Map(store.model.nodes.map((n: any) => [String(n.id), String(n.groupId ?? "")]));
  const nodeById = new Map(store.model.nodes.map((n: any) => [String(n.id), n]));

  // remove stale
  for (const [id, h] of Array.from(scene.domNodes.entries())) {
    if (!byId.has(id)) {
      h.destroy();
      scene.domNodes.delete(id);
    }
  }
  for (const [id, portal] of Array.from(youtubePortals.entries())) {
    if (!byId.has(id)) {
      portal.remove();
      youtubePortals.delete(id);
    }
  }

  const viewById = new Map(store.model.views.map((v) => [String(v.id), v]));
  const resolveVisibilityTarget = (node: any) => {
    let space = node?.space;
    let viewId = node?.viewId ?? null;
    let viewIds = Array.isArray(node?.viewIds) ? node.viewIds : null;
    let screenId = node?.screenId ?? null;
    let cursor: any = node;
    while (cursor?.groupId) {
      const parent = nodeById.get(String(cursor.groupId));
      if (!parent) break;
      const parentSpace = parent?.space;
      if (space === "group" || space == null) space = parentSpace;
      if (space === "screen") {
        screenId = String(parent?.screenId ?? screenId ?? "screen_main");
      }
      if (!viewIds && viewId == null) {
        const parentViewIds = Array.isArray(parent?.viewIds) ? parent.viewIds : null;
        if (parentViewIds) viewIds = parentViewIds;
        else if (parent?.viewId != null) viewId = parent.viewId;
      }
      cursor = parent;
    }
    return { space, screenId, viewId, viewIds };
  };

  const isVisibleInLive = (node: Node) => {
    if (store.mode !== "live") return true;
    if (node.type === "group") {
      const anyNode = node as any;
      const hasBg = Boolean(anyNode.bgColor) || anyNode.bgAlpha != null || anyNode.bgPadding != null || anyNode.bgRadius != null;
      return hasBg;
    }
    const target = resolveVisibilityTarget(node as any);
    if (target.space === "screen") {
      if (store.mode !== "live") return true;
      const nodeScreenId = String(target.screenId ?? "screen_main");
      if (store.cameraTween && store.transitionFromViewId && store.transitionToViewId) {
        const fromScreen = String((viewById.get(String(store.transitionFromViewId)) as any)?.screenId ?? "screen_main");
        const toScreen = String((viewById.get(String(store.transitionToViewId)) as any)?.screenId ?? "screen_main");
        return nodeScreenId === fromScreen || nodeScreenId === toScreen;
      }
      const activeScreenId = String((view as any)?.screenId ?? "screen_main");
      return nodeScreenId === activeScreenId;
    }
    const nodeView = target.viewId;
    const nodeViews = target.viewIds;
    if (store.cameraTween && store.transitionFromViewId && store.transitionToViewId) {
      if (nodeViews) {
        return (
          nodeViews.includes(store.transitionFromViewId) || nodeViews.includes(store.transitionToViewId)
        );
      }
      return nodeView === store.transitionFromViewId || nodeView === store.transitionToViewId;
    }
    if (nodeViews) return nodeViews.includes(view.id);
    if (nodeView != null) return nodeView === view.id;
    return false;
  };

  for (const node of store.model.nodes) {
    if (!isVisibleInLive(node)) {
      const hidden = scene.domNodes.get(node.id);
      if (hidden) hidden.el.style.display = "none";
      const portal = youtubePortals.get(String(node.id));
      if (portal) portal.style.display = "none";
      continue;
    }
    let handle = scene.domNodes.get(node.id);
    const ensureNodeElement = () => {
      const el = document.createElement("div");
      el.classList.add("node");
      el.dataset.nodeId = node.id;
      el.dataset.nodeType = node.type;
      el.dataset.nodeSpace = node.space;
      if ((node as any).layer) el.dataset.nodeLayer = String((node as any).layer);
      const bg = document.createElement("div");
      bg.className = "node-bg";
      el.appendChild(bg);
      const registeredAdapter = findNodeRenderAdapter(node.type);
      if (registeredAdapter) {
        registeredAdapter.ensure(el);
        return el;
      }
      if (node.type === "text") {
        el.classList.add("node-text");
        const content = document.createElement("div");
        content.className = "node-text-content";
        const inner = document.createElement("div");
        inner.className = "node-text-inner";
        content.appendChild(inner);
        el.appendChild(content);
      } else if (node.type === "bullets") {
        el.classList.add("node-bullets");
        const content = document.createElement("div");
        content.className = "node-bullets-content";
        el.appendChild(content);
      } else if (node.type === "arrow") {
        el.classList.add("node-arrow");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 1 1");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("overflow", "visible");
        svg.classList.add("node-arrow-svg");
        const glowLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        glowLine.classList.add("node-arrow-line-glow");
        const glowHead = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        glowHead.classList.add("node-arrow-head-glow");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("node-arrow-line");
        const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        head.classList.add("node-arrow-head");
        svg.appendChild(line);
        svg.appendChild(head);
        svg.appendChild(glowLine);
        svg.appendChild(glowHead);
        el.appendChild(svg);
      } else if (node.type === "image") {
        el.classList.add("node-image");
        const img = document.createElement("img");
        img.className = "node-image-content";
        img.decoding = "async";
        img.loading = "eager";
        img.draggable = false;
        el.appendChild(img);
      } else if (node.type === "group") {
        el.classList.add("node-group");
        const outline = document.createElement("div");
        outline.className = "group-selection-outline";
        el.appendChild(outline);
      }
      return el;
    };

    if (!handle) {
      const el = ensureNodeElement();
      scene.overlay.appendChild(el);
      handle = { id: node.id, el, update: () => {}, destroy: () => el.remove() };
      scene.domNodes.set(node.id, handle);
    } else if (handle.el.dataset.nodeType !== node.type) {
      // Node type changed (e.g. text -> bullets): rebuild DOM wrappers.
      const next = ensureNodeElement();
      handle.el.replaceWith(next);
      handle.el = next;
      handle.id = node.id;
      scene.domNodes.set(node.id, handle);
    }

    const isSelected = store.selectedId === node.id || selectedSet.has(node.id);
    const activeGroupId = store.activeGroupId;
    const isGroupRoot = !!activeGroupId && node.type === "group" && node.id === activeGroupId;
    const inGroup = (() => {
      if (!activeGroupId) return true;
      if (isGroupRoot) return true;
      let cursor = String((node as any).groupId ?? "");
      while (cursor) {
        if (cursor === String(activeGroupId)) return true;
        cursor = parentById.get(cursor) ?? "";
      }
      return false;
    })();
    handle.el.classList.toggle("is-selected", isSelected);
    handle.el.classList.toggle("is-group-dimmed", !!activeGroupId && !inGroup);
    handle.el.classList.toggle("is-group-root", isGroupRoot);
    if (node.type === "group") {
      handle.el.style.pointerEvents = store.mode === "live" ? "none" : "";
    }
    const hasGroupParent = !!String((node as any).groupId ?? "");
    const isEditableTable = node.type === "table" && (node as any).editable !== false;
    const isLiveLayer = String((node as any).layer ?? "") === "live";
    const disableForMode =
      store.mode !== "live" &&
      (!isNodeInteractiveInMode(store.mode, node) ||
        isLiveLayer ||
        ((!isEditableTable && !!activeGroupId && !inGroup) || (!isEditableTable && isGroupRoot)));
    const isPlayerControl =
      (node.type === "buttons" || node.type === "slider") && Boolean((node as any).playerId);
    const disableForGrouping = store.mode !== "live" && !activeGroupId && hasGroupParent && !isPlayerControl;
    handle.el.classList.toggle("is-disabled", disableForMode);
    if (disableForMode || disableForGrouping) {
      if (node.type === "axis" && store.mode === "live") handle.el.style.pointerEvents = "";
      else handle.el.style.pointerEvents = "none";
    } else {
      handle.el.style.pointerEvents = "";
    }
    handle.update = () => updateNodeDom(handle!.el, node, cam, screen, timeMs, store.mode, store);
    handle.update();
  }
}

function updateNodeDom(
  el: HTMLElement,
  node: Node,
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number },
  timeMs: number,
  mode: string,
  store: Store
) {
  if (!el.querySelector(".node-bg")) {
    const bg = document.createElement("div");
    bg.className = "node-bg";
    el.prepend(bg);
  }
  const anyNode = node as any;
  const exitStart = typeof anyNode.__exitStartMs === "number" ? anyNode.__exitStartMs : null;
  const visibleNow = node.visible || exitStart != null;
  if (!node.visible && exitStart == null) {
    anyNode.__appearedOnce = false;
    delete (el.dataset as any).animInStartMs;
  }
  el.style.opacity = String(node.opacity ?? 1);
  el.style.display = visibleNow ? "block" : "none";
  el.style.zIndex = String((node as any).zIndex ?? 0);

  const sizePx = () => {
    const isScreen = node.space === "screen";
    const worldScale = worldToScreenScale(camera, screen);
    const wPx = isScreen ? node.transform.w * screen.w : node.transform.w * worldScale.x;
    const hPx = isScreen ? node.transform.h * screen.h : node.transform.h * worldScale.y;
    return { wPx, hPx };
  };
  const applyBox = () => {
    const { wPx, hPx } = sizePx();
    const isWorld = node.space !== "screen";
    const p = isWorld
      ? worldToScreen({ x: node.transform.x, y: node.transform.y }, camera, screen)
      : {
          // Screen-space: normalized [0,1] with +y down.
          x: node.transform.x * screen.w,
          y: node.transform.y * screen.h,
        };
    const { dx, dy } = anchorOffsetPx(node.transform.anchor, wPx, hPx);
    el.style.left = `${p.x + dx}px`;
    el.style.top = `${p.y + dy}px`;
      el.style.width = `${wPx}px`;
      el.style.height = `${hPx}px`;
      // Scale node UI (buttons/controls) with element size.
      const minPx = Math.max(1, Math.min(wPx, hPx));
      const genericUiScale = Math.max(0.01, minPx / 300);
      let uiScale = genericUiScale;
      if (node.type === "buttons") {
        const anyNode = node as any;
        if (anyNode.__uiScaleBase == null) anyNode.__uiScaleBase = 1;
        const buttonsUiScale = Math.max(0.01, Math.min(wPx / 180, hPx / 40));
        uiScale = buttonsUiScale * Number(anyNode.__uiScaleBase ?? 1);
      }
      el.style.setProperty("--node-ui-scale", String(uiScale));
    };
  applyBox();
  const updateGroupSelectionOutline = () => {
    if (node.type !== "group") return;
    const outline = el.querySelector<HTMLElement>(".group-selection-outline");
    if (!outline) return;
    if (!el.classList.contains("is-selected")) {
      outline.style.display = "none";
      return;
    }
    const overlay = el.parentElement;
    if (!overlay) {
      outline.style.display = "none";
      return;
    }
    const nodeId = String(node.id ?? "");
    const isDescendantOfGroup = (candidate: any) => {
      let cursor = String(candidate?.groupId ?? "");
      while (cursor) {
        if (cursor === nodeId) return true;
        const parent = store.model.nodes.find((n) => String(n.id ?? "") === cursor);
        cursor = String((parent as any)?.groupId ?? "");
      }
      return false;
    };
    const descendantRects = (store.model.nodes as any[])
      .filter((candidate) => candidate?.id !== nodeId && isDescendantOfGroup(candidate))
      .map((candidate) =>
        overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(String(candidate.id ?? ""))}"]`)
      )
      .filter((child): child is HTMLElement => !!child && child.style.display !== "none")
      .map((child) => child.getBoundingClientRect());
    if (!descendantRects.length) {
      outline.style.display = "none";
      return;
    }
    const rootRect = el.getBoundingClientRect();
    const minLeft = Math.min(...descendantRects.map((r) => r.left));
    const minTop = Math.min(...descendantRects.map((r) => r.top));
    const maxRight = Math.max(...descendantRects.map((r) => r.right));
    const maxBottom = Math.max(...descendantRects.map((r) => r.bottom));
    outline.style.display = "block";
    outline.style.left = `${minLeft - rootRect.left}px`;
    outline.style.top = `${minTop - rootRect.top}px`;
    outline.style.width = `${Math.max(1, maxRight - minLeft)}px`;
    outline.style.height = `${Math.max(1, maxBottom - minTop)}px`;
  };
  updateGroupSelectionOutline();
  el.style.transformOrigin = (() => {
    const a = node.transform.anchor;
    if (a === "topLeft") return "0% 0%";
    if (a === "topCenter") return "50% 0%";
    if (a === "topRight") return "100% 0%";
    if (a === "centerLeft") return "0% 50%";
    if (a === "centerCenter") return "50% 50%";
    if (a === "centerRight") return "100% 50%";
    if (a === "bottomLeft") return "0% 100%";
    if (a === "bottomCenter") return "50% 100%";
    if (a === "bottomRight") return "100% 100%";
    return "50% 50%";
  })();
  el.style.transform = `rotate(${node.transform.rotationDeg}deg)`;
  el.style.translate = "0px 0px";
  el.style.filter = "";
  (el.style as any).maskImage = "";
  (el.style as any).webkitMaskImage = "";

  const allowAnim = mode === "live";
  const suppressAppear = !!(anyNode.__suppressAppear);
  const appear: any = (node as any).appear;
  const disappear: any = (node as any).disappear;
  const prevVisible = el.dataset.prevVisible === "1";
  if (visibleNow && !prevVisible) {
    delete (el.dataset as any).animInStartMs;
  }
  if (typeof anyNode.__forceAppearMs === "number") {
    el.dataset.animInStartMs = String(anyNode.__forceAppearMs);
    delete anyNode.__forceAppearMs;
  }
  el.dataset.prevVisible = visibleNow ? "1" : "0";

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const toAnimPx = (v: number | undefined) => {
    if (v == null) return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    return Math.abs(num) <= 1 ? num * screen.w : num;
  };
  const toAnimSpeedPxS = (v: number | undefined) => {
    if (v == null) return null;
    const num = Number(v);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num <= 1 ? num * screen.w : num;
  };
  const applyMask = (from: string, p: number, borderPx: number | undefined, sizePx: number) => {
    const px = Number.isFinite(borderPx) && borderPx != null ? Math.max(0, Number(borderPx)) : null;
    const bfRaw = px != null && sizePx > 0 ? px / sizePx : 0.2;
    const bf = Math.max(0, Math.min(0.49, bfRaw));
    const front = p * 100;
    const lead = Math.max(0, front - bf * 100);
    let mask = "";
    if (from === "left") {
      mask = `linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
    } else if (from === "right") {
      const f = 100 - front;
      const l = Math.min(100, f + bf * 100);
      mask = `linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
    } else if (from === "top") {
      mask = `linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${lead}%, rgba(0,0,0,0) ${front}%, rgba(0,0,0,0) 100%)`;
    } else if (from === "bottom") {
      const f = 100 - front;
      const l = Math.min(100, f + bf * 100);
      mask = `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${f}%, rgba(0,0,0,1) ${l}%, rgba(0,0,0,1) 100%)`;
    }
    (el.style as any).maskImage = mask || "";
    (el.style as any).webkitMaskImage = mask || "";
  };

  const moveOffsetPx = (from: string, distancePx: number, wPx: number, hPx: number) => {
    const dist = Number.isFinite(distancePx) ? distancePx : Math.max(wPx, hPx);
    let dx = 0;
    let dy = 0;
    if (from === "left") dx = -dist;
    if (from === "right") dx = dist;
    if (from === "top") dy = -dist;
    if (from === "bottom") dy = dist;
    return { dx, dy };
  };

  const speedDurationMs = (speedPxS: number | undefined, distancePx: number) => {
    const sp = Number(speedPxS);
    if (!Number.isFinite(sp) || sp <= 0) return null;
    return Math.max(1, (Math.max(0, distancePx) / sp) * 1000);
  };

  const axisSizePx = (from: string, wPx: number, hPx: number) => {
    if (from === "top" || from === "bottom") return hPx;
    if (from === "left" || from === "right") return wPx;
    return Math.max(wPx, hPx);
  };

  if (allowAnim && exitStart != null && disappear && typeof disappear === "object" && disappear.kind && disappear.kind !== "none") {
    const dur = Number(disappear.durationMs ?? 0);
    const delay = Number(disappear.delayMs ?? 0);
    const isScreen = node.space === "screen";
    const worldScale = worldToScreenScale(camera, screen);
    const wPx = isScreen ? node.transform.w * screen.w : node.transform.w * worldScale.x;
    const hPx = isScreen ? node.transform.h * screen.h : node.transform.h * worldScale.y;
    const fromRaw = String(disappear.where ?? "all");
    const from = fromRaw === "null" || fromRaw === "none" ? "all" : fromRaw;
    const movePx = toAnimPx(disappear.distancePx) ?? axisSizePx(from, wPx, hPx);
    const durMs =
      disappear.kind === "move" && disappear.speedPxS != null
        ? speedDurationMs(toAnimSpeedPxS(disappear.speedPxS) ?? 0, movePx) ?? 0
        : disappear.kind === "fade" && disappear.speedPxS != null && from !== "all"
          ? speedDurationMs(toAnimSpeedPxS(disappear.speedPxS) ?? 0, axisSizePx(from, wPx, hPx)) ?? 0
          : dur;
    const t = durMs > 0 ? (timeMs - (exitStart + delay)) / durMs : 1;
    const p = clamp01(t);
    const kind = String(disappear.kind);
    if (kind === "fade") {
      const borderPx = toAnimPx(disappear.borderPx) ?? 0;
      if (borderPx <= 0) {
        el.style.opacity = "0";
        (el.style as any).maskImage = "";
        (el.style as any).webkitMaskImage = "";
        if (p >= 1) {
          anyNode.__exitStartMs = null;
          node.visible = false;
          el.style.opacity = "1";
          el.style.filter = "";
          el.style.translate = "0px 0px";
          (el.style as any).maskImage = "";
          (el.style as any).webkitMaskImage = "";
        }
        return;
      }
      el.style.opacity = String(1 - p);
      if (from !== "all") {
        const sizePx = axisSizePx(from, wPx, hPx);
        applyMask(from, 1 - p, borderPx, sizePx);
      }
      else {
        (el.style as any).maskImage = "";
        (el.style as any).webkitMaskImage = "";
      }
    } else if (kind === "pixelate") {
      const blur = Math.max(0, (p) * 6);
      el.style.opacity = String(1 - p);
      el.style.filter = blur > 0 ? `blur(${blur}px)` : "";
    } else if (kind === "move") {
      const fromMoveRaw = String(disappear.where ?? "left");
      const fromMove = fromMoveRaw === "null" || fromMoveRaw === "none" ? "" : fromMoveRaw;
      const off = moveOffsetPx(fromMove, movePx, wPx, hPx);
      el.style.translate = `${off.dx * p}px ${off.dy * p}px`;
      el.style.opacity = String(1 - p);
    } else if (kind === "sudden") {
      // No visual effect
    }
    if (p >= 1) {
      anyNode.__exitStartMs = null;
      node.visible = false;
      el.style.opacity = "1";
      el.style.filter = "";
      el.style.translate = "0px 0px";
      (el.style as any).maskImage = "";
      (el.style as any).webkitMaskImage = "";
    }
  } else if (
    allowAnim &&
    !suppressAppear &&
    appear &&
    typeof appear === "object" &&
    appear.kind &&
    appear.kind !== "none" &&
    visibleNow &&
    (!anyNode.__appearedOnce || !!el.dataset.animInStartMs)
  ) {
    let dur = Number(appear.durationMs ?? 0);
    const delay = Number(appear.delayMs ?? 0);
    if (appear.kind === "fade" && dur <= 0) dur = 800;
    if (appear.kind === "pixelate" && dur <= 0) dur = 800;
    if (appear.kind === "move" && dur <= 0) dur = 800;
    if (appear.kind === "sudden" || dur <= 0) {
      el.style.opacity = "1";
      el.style.filter = "";
      el.style.translate = "0px 0px";
      (el.style as any).maskImage = "";
      (el.style as any).webkitMaskImage = "";
    } else {
      if (!el.dataset.animInStartMs) {
        el.dataset.animInStartMs = String(timeMs + delay);
      }
      const isScreen = node.space === "screen";
      const worldScale = worldToScreenScale(camera, screen);
      const wPx = isScreen ? node.transform.w * screen.w : node.transform.w * worldScale.x;
      const hPx = isScreen ? node.transform.h * screen.h : node.transform.h * worldScale.y;
      const fromRaw = String(appear.where ?? "all");
      const from = fromRaw === "null" || fromRaw === "none" ? "all" : fromRaw;
      if (appear.kind === "move" && appear.speedPxS != null) {
        const movePx = toAnimPx(appear.distancePx) ?? axisSizePx(from, wPx, hPx);
        dur = speedDurationMs(toAnimSpeedPxS(appear.speedPxS) ?? 0, movePx) ?? 0;
      }
      if (appear.kind === "fade" && appear.speedPxS != null && from !== "all") {
        dur = speedDurationMs(toAnimSpeedPxS(appear.speedPxS) ?? 0, axisSizePx(from, wPx, hPx)) ?? 0;
      }
      const start = Number(el.dataset.animInStartMs ?? "0");
      const t = dur > 0 ? (timeMs - start) / dur : 1;
      const p = clamp01(t);
      const kind = String(appear.kind);
      if (kind === "fade") {
        const borderPx = toAnimPx(appear.borderPx) ?? 0;
        if (borderPx <= 0) {
          el.style.opacity = "1";
          (el.style as any).maskImage = "";
          (el.style as any).webkitMaskImage = "";
          delete (el.dataset as any).animInStartMs;
          return;
        }
        el.style.opacity = String(p);
        if (from !== "all") {
          const sizePx = axisSizePx(from, wPx, hPx);
          applyMask(from, p, borderPx, sizePx);
        }
        else {
          (el.style as any).maskImage = "";
          (el.style as any).webkitMaskImage = "";
        }
      } else if (kind === "pixelate") {
        const blur = Math.max(0, (1 - p) * 6);
        el.style.opacity = String(p);
        el.style.filter = blur > 0 ? `blur(${blur}px)` : "";
      } else if (kind === "move") {
        const fromMoveRaw = String(appear.where ?? "left");
        const fromMove = fromMoveRaw === "null" || fromMoveRaw === "none" ? "" : fromMoveRaw;
        const dist = toAnimPx(appear.distancePx) ?? axisSizePx(fromMove, wPx, hPx);
        const off = moveOffsetPx(fromMove, dist, wPx, hPx);
        el.style.translate = `${off.dx * (1 - p)}px ${off.dy * (1 - p)}px`;
        el.style.opacity = String(p);
      }
      if (p >= 1) {
        delete (el.dataset as any).animInStartMs;
        el.style.opacity = "1";
        el.style.filter = "";
        el.style.translate = "0px 0px";
        (el.style as any).maskImage = "";
        (el.style as any).webkitMaskImage = "";
        anyNode.__appearedOnce = true;
      }
    }
  }

  if (node.type === "text") {
    // IMPORTANT: never overwrite `el.innerHTML` here (it would delete selection handles).
    const content = el.querySelector<HTMLElement>(".node-text-content");
    const inner = el.querySelector<HTMLElement>(".node-text-inner");
    if (!content || !inner) throw new Error("[next] text node missing content wrappers");

    el.style.color = node.color;
    const isScreen = node.space === "screen";
    const designW = (store.model as any).defaults?.designWidth ?? 1920;
    const screenScale = screen.w / Math.max(1e-9, designW);
    const fontPx = Math.max(1, (node as any).fontPx ?? 16);
    const effectiveFont = isScreen ? fontPx * screenScale : fontPx * camera.zoom;
    el.style.fontSize = `${Math.max(1, effectiveFont)}px`;
    el.style.lineHeight = "1.15";
    const align = ((anyNode.align ?? "center") as string).toLowerCase() as "left" | "center" | "right";
    const justify =
      align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    content.style.display = "flex";
    content.style.alignItems = "center";
    content.style.justifyContent = justify;
    inner.style.width = "100%";
    inner.style.textAlign = align;

    const raw = String(node.text ?? "");
    if ((el.dataset as any).rawText !== raw) {
      (el.dataset as any).rawText = raw;
      const preview = (el.dataset as any).editing === "1";
      let cache: string[] = [];
      try {
        cache = JSON.parse(String((inner.dataset as any).katexCache ?? "[]"));
        if (!Array.isArray(cache)) cache = [];
      } catch {
        cache = [];
      }
      const r = renderTextWithKatexToHtmlCached(raw, { preview, cache });
      (inner.dataset as any).katexCache = JSON.stringify(r.cache);
      (el.dataset as any).katexOk = r.ok ? "1" : "0";
      (el.dataset as any).katexErrors = r.errors.length ? JSON.stringify(r.errors) : "";
      // IMPORTANT: if KaTeX is invalid, keep showing the last-good output.
      if (r.ok) {
        inner.innerHTML = r.html;
        (inner.dataset as any).katexLastGood = r.html;
      } else {
        const lastGood = String((inner.dataset as any).katexLastGood ?? "");
        if (lastGood) inner.innerHTML = lastGood;
      }
    }

    const editing = (el.dataset as any).editing === "1";
    if (editing && !(anyNode as any).__resizing && !(anyNode as any).__manualResize) {
      // Default behavior (only while editing): bounding box should include all rendered text.
      // If content doesn't fit, grow the world-space transform.
      // IMPORTANT: when zoom is extremely small, text rendering clamps to >= 1px.
      // Use the *effective* zoom for text measurement, otherwise we'd expand world size
      // by 1/zoom and the box would never become tight again when zooming back in.
      const padPx = 0;
      // IMPORTANT:
      // Do NOT use getBoundingClientRect() here: it changes under rotation (axis-aligned bbox),
      // which causes flicker/jumps during rotation. scrollWidth/scrollHeight are rotation-invariant.
      const needWpx = Math.ceil(inner.scrollWidth + padPx * 2);
      const needHpx = Math.ceil(inner.scrollHeight + padPx * 2);
      const fontPx = Math.max(1, (node as any).fontPx ?? 16);
      const isScreen = node.space === "screen";
      const screenW = Math.max(1e-9, screen.w);
      const screenH = Math.max(1e-9, screen.h);
      const effectiveZoom = Math.max(camera.zoom, 1 / fontPx);
      const effectiveWorldPxX = effectiveZoom * screenW;
      const effectiveWorldPxY = effectiveZoom * screenH;
      const needW = isScreen ? needWpx / screenW : needWpx / effectiveWorldPxX;
      const needH = isScreen ? needHpx / screenH : needHpx / effectiveWorldPxY;
      const epsW = isScreen ? 2 / screenW : 2 / effectiveWorldPxX;
      const epsH = isScreen ? 2 / screenH : 2 / effectiveWorldPxY;
      const screenKey = `${screenW}x${screenH}`;
      const prevScreenKey = (el.dataset as any).screenKey;
      const allowShrink = prevScreenKey && prevScreenKey !== screenKey;
      (el.dataset as any).screenKey = screenKey;

      const w0 = node.transform.w;
      const h0 = node.transform.h;

      // Grow always when too small; allow shrink only on screen resize to avoid jitter while editing.
      if (needW > node.transform.w + epsW) node.transform.w = needW;
      else if (allowShrink && needW < node.transform.w - epsW) node.transform.w = needW;
      if (needH > node.transform.h + epsH) node.transform.h = needH;
      else if (allowShrink && needH < node.transform.h - epsH) node.transform.h = needH;

      // IMPORTANT: apply box immediately if we changed size this tick,
      // so selection outline never renders at the stale (too large) size.
      if (node.transform.w !== w0 || node.transform.h !== h0) applyBox();
    }
    const { wPx, hPx } = sizePx();
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
  }
  const renderCtx = {
    mode,
    timeMs,
    store,
    cameraZoom: camera.zoom,
    screen,
    sizePx,
    applyBox,
    applyBackground,
    renderKatex: (text: string, cache: string[]) => renderTextWithKatexToHtmlCached(text, { preview: false, cache }),
    inferPlayerId,
    ensurePlayerBus,
    youtubePlayers,
    youtubePortals,
    playerLinks,
    webcamLinks,
    persistButtons,
    getAxisState,
    clampAxisView,
    renderAxisNode,
    ensureCameraStream,
    stopCameraStream,
    ensureWebcamBus,
    cameraStreams,
    cameraRecorders,
    cameraErrors,
    cameraErrorDetails,
    cameraPreviewCooldown,
    logCameraDebug,
    parseYoutubeId,
    ensureYoutubePlayer,
    ensureYoutubePortal,
    releaseYoutubePortal,
    ensureVideoPoster,
    fitCameraToScreen,
    resolveViewCamera,
    worldToScreenScale,
    qrCache,
    qrPending,
    qrToDataUrl: (url: string) => QRCode.toDataURL(url, { margin: 1, width: 512, color: { dark: "#000000ff", light: "#ffffffff" } }),
    iframePreviewAttempts,
    iframePreviewTimers,
    parseTimeToSeconds,
  };
  if (node.type === "axis") {
    findNodeRenderAdapter("axis")?.update(el, node, renderCtx);
  }
  if (node.type === "buttons") {
    findNodeRenderAdapter("buttons")?.update(el, node, renderCtx);
  }
  if (node.type === "slider") {
    findNodeRenderAdapter("slider")?.update(el, node, renderCtx);
    const input = el.querySelector<HTMLInputElement>(".slider-input");
    const playerId = inferPlayerId(anyNode);
    if (input && playerId) {
      const link = playerLinks.get(playerId) ?? {};
      const yt = link.videoNodeId ? youtubePlayers.get(String(link.videoNodeId)) : null;
      const videoEl = link.videoEl;
      const valuesRaw = Array.isArray((anyNode as any).values) ? (anyNode as any).values : null;
      const values = valuesRaw
        ? valuesRaw.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v))
        : [];
      const min = Number((anyNode as any).min ?? 0);
      const max = Number((anyNode as any).max ?? 1);
      const setValueFromTime = (dur: number, cur: number) => {
        if (!Number.isFinite(dur) || dur <= 0) return;
        const frac = Math.max(0, Math.min(1, cur / dur));
        const target = min + frac * (max - min);
        if (values.length) {
          let best = 0;
          let bestDiff = Number.POSITIVE_INFINITY;
          for (let i = 0; i < values.length; i += 1) {
            const diff = Math.abs(values[i]! - target);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = i;
            }
          }
          input.value = String(best);
        } else {
          input.value = String(target);
        }
      };
      if (!input.dataset.dragging && max > min) {
        const dur = yt ? Number(yt.getDuration?.() ?? 0) : Number(videoEl?.duration ?? 0);
        const cur = yt ? Number(yt.getCurrentTime?.() ?? 0) : Number(videoEl?.currentTime ?? 0);
        setValueFromTime(dur, cur);
      }
      if (!yt && link.videoNodeId && link.iframeEl && !input.dataset.dragging) {
        void ensureYoutubePlayer(String(link.videoNodeId), link.iframeEl).then((p) => {
          const dur = Number(p?.getDuration?.() ?? 0);
          const cur = Number(p?.getCurrentTime?.() ?? 0);
          setValueFromTime(dur, cur);
        });
      }
    }
  }
  if (node.type === "camera") {
    findNodeRenderAdapter("camera")?.update(el, node, renderCtx);
  }
  if (node.type === "table") {
    findNodeRenderAdapter("table")?.update(el, node, renderCtx);
  }
  if (node.type === "bullets") {
    const content = el.querySelector<HTMLElement>(".node-bullets-content");
    if (!content) throw new Error("[next] bullets node missing content wrapper");
    const fontPx = Math.max(1, (node as any).fontPx ?? 16);
    el.style.color = String((node as any).color ?? "rgba(255,255,255,0.92)");
    const isScreen = node.space === "screen";
    const designW = (store.model as any).defaults?.designWidth ?? 1920;
    const screenScale = screen.w / Math.max(1e-9, designW);
    const effectiveFont = isScreen ? fontPx * screenScale : fontPx * camera.zoom;
    el.style.fontSize = `${Math.max(1, effectiveFont)}px`;
    el.style.lineHeight = "1.2";
    const raw = String((node as any).rawText ?? "");
    const items = (node as any).items as Array<{ text: string; indent: number }> | undefined;
    const bulletsSpec = String((node as any).bullets ?? "1.a.");
    const align = ((anyNode.align ?? "center") as string).toLowerCase() as "left" | "center" | "right";
    if (
      (content.dataset as any).rawText !== raw ||
      (content.dataset as any).align !== align ||
      !content.childElementCount
    ) {
      (content.dataset as any).rawText = raw;
      (content.dataset as any).align = align;
      const indentPx = isScreen ? 16 * screenScale : 20;
      content.replaceChildren(...renderBulletLines(items ?? [], bulletsSpec, indentPx, align));
    }
    const editing = (el.dataset as any).editing === "1";
    if (editing && !(anyNode as any).__resizing && !(anyNode as any).__manualResize) {
      // Auto-resize like text nodes (only while editing).
      const padPx = 0;
      const needWpx = Math.ceil(content.scrollWidth + padPx * 2);
      const needHpx = Math.ceil(content.scrollHeight + padPx * 2);
      const isScreen = node.space === "screen";
      const screenW = Math.max(1e-9, screen.w);
      const screenH = Math.max(1e-9, screen.h);
      const effectiveZoom = Math.max(camera.zoom, 1 / fontPx);
      const effectiveWorldPxX = effectiveZoom * screenW;
      const effectiveWorldPxY = effectiveZoom * screenH;
      const needW = isScreen ? needWpx / screenW : needWpx / effectiveWorldPxX;
      const needH = isScreen ? needHpx / screenH : needHpx / effectiveWorldPxY;
      const epsW = isScreen ? 2 / screenW : 2 / effectiveWorldPxX;
      const epsH = isScreen ? 2 / screenH : 2 / effectiveWorldPxY;
      const screenKey = `${screenW}x${screenH}`;
      const prevScreenKey = (el.dataset as any).screenKey;
      const allowShrink = prevScreenKey && prevScreenKey !== screenKey;
      (el.dataset as any).screenKey = screenKey;
      const w0 = node.transform.w;
      const h0 = node.transform.h;
      if (needW > node.transform.w + epsW) node.transform.w = needW;
      else if (allowShrink && needW < node.transform.w - epsW) node.transform.w = needW;
      if (needH > node.transform.h + epsH) node.transform.h = needH;
      else if (allowShrink && needH < node.transform.h - epsH) node.transform.h = needH;
      if (node.transform.w !== w0 || node.transform.h !== h0) applyBox();
    }
    const { wPx, hPx } = sizePx();
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
  }
  if (node.type === "multichoice") {
    findNodeRenderAdapter("multichoice")?.update(el, node, renderCtx);
  }
  if (node.type === "wheel") {
    findNodeRenderAdapter("wheel")?.update(el, node, renderCtx);
  }
  if (node.type === "arrow") {
    const svg = el.querySelector<SVGSVGElement>(".node-arrow-svg");
    const glowLine = el.querySelector<SVGLineElement>(".node-arrow-line-glow");
    const glowHead = el.querySelector<SVGPolygonElement>(".node-arrow-head-glow");
    const line = el.querySelector<SVGLineElement>(".node-arrow-line");
    const head = el.querySelector<SVGPolygonElement>(".node-arrow-head");
    if (!svg || !glowLine || !glowHead || !line || !head) throw new Error("[next] arrow node missing svg elements");
    const isSelected = el.classList.contains("is-selected");

    const start = (node as any).start ?? { x: 0, y: 0.5 };
    const end = (node as any).end ?? { x: 1, y: 0.5 };
    const isWorld = node.space !== "screen";
    const sScreen = isWorld ? worldToScreen(start, camera, screen) : { x: start.x * screen.w, y: start.y * screen.h };
    const eScreen = isWorld ? worldToScreen(end, camera, screen) : { x: end.x * screen.w, y: end.y * screen.h };
    const left = Math.min(sScreen.x, eScreen.x);
    const top = Math.min(sScreen.y, eScreen.y);
    const wPx = Math.max(1, Math.abs(eScreen.x - sScreen.x));
    const hPx = Math.max(1, Math.abs(eScreen.y - sScreen.y));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${wPx}px`;
    el.style.height = `${hPx}px`;
    el.style.transform = "none";
    el.style.transformOrigin = "0% 0%";
    svg.setAttribute("viewBox", `0 0 ${wPx} ${hPx}`);
    const sx = sScreen.x - left;
    const sy = sScreen.y - top;
    const ex = eScreen.x - left;
    const ey = eScreen.y - top;
    const strokePx = Math.max(1, Number((node as any).strokePx ?? 4));
    const stroke = String((node as any).color ?? "white");

    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-6 ? dx / len : 1;
    const uy = len > 1e-6 ? dy / len : 0;
    const headLen = 5 * strokePx;
    const headWidth = 4 * strokePx;
    const bx = ex - ux * headLen;
    const by = ey - uy * headLen;
    const nx = -uy;
    const ny = ux;
    const p1x = ex;
    const p1y = ey;
    const p2x = bx + nx * (headWidth / 2);
    const p2y = by + ny * (headWidth / 2);
    const p3x = bx - nx * (headWidth / 2);
    const p3y = by - ny * (headWidth / 2);

    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(bx));
    line.setAttribute("y2", String(by));
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", String(strokePx));
    line.setAttribute("stroke-linecap", "round");
    head.setAttribute("points", `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y}`);
    head.setAttribute("fill", stroke);

    const glowColor = "rgba(110,168,255,0.7)";
    glowLine.style.display = isSelected ? "block" : "none";
    glowHead.style.display = isSelected ? "block" : "none";
    const g2x = bx + nx * (headWidth / 2);
    const g2y = by + ny * (headWidth / 2);
    const g3x = bx - nx * (headWidth / 2);
    const g3y = by - ny * (headWidth / 2);

    glowLine.setAttribute("x1", String(sx));
    glowLine.setAttribute("y1", String(sy));
    glowLine.setAttribute("x2", String(bx));
    glowLine.setAttribute("y2", String(by));
    glowLine.setAttribute("stroke", glowColor);
    glowLine.setAttribute("stroke-width", String(strokePx));
    glowLine.setAttribute("stroke-linecap", "round");
    glowHead.setAttribute("points", `${p1x},${p1y} ${g2x},${g2y} ${g3x},${g3y}`);
    glowHead.setAttribute("fill", glowColor);
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
  }
  if (node.type === "join") {
    findNodeRenderAdapter("join")?.update(el, node, renderCtx);
  }
  if (node.type === "image") {
    const img = el.querySelector<HTMLImageElement>(".node-image-content");
    if (!img) throw new Error("[next] image node missing img element");
    const src = String((node as any).src ?? "");
    if (img.dataset.src !== src) {
      img.dataset.src = src;
      img.src = src;
    }
    const { wPx, hPx } = sizePx();
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
  }
  if (node.type === "htmlFrame") {
    findNodeRenderAdapter("htmlFrame")?.update(el, node, renderCtx);
  }
  if (node.type === "video") {
    findNodeRenderAdapter("video")?.update(el, node, renderCtx);
  }
  if (node.type === "group") {
    const { wPx, hPx } = sizePx();
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
  }
}

function renderBulletLines(
  items: Array<{ text: string; indent: number; color?: string; bgColor?: string }>,
  specRaw: string,
  indentPx: number,
  align: "left" | "center" | "right"
): HTMLElement[] {
  const spec = specRaw.trim();
  if (!spec) return items.map((item) => renderBulletLine(item, "", indentPx, align));
  const unordered = spec.length === 1 && ["-", ".", ">"].includes(spec);
  if (unordered) {
    const glyph = spec === "-" ? "–" : spec === ">" ? "›" : "•";
    return items.map((item) => renderBulletLine(item, glyph, indentPx, align));
  }
  const sep = [".", ")", "-"].includes(spec[spec.length - 1] ?? "") ? spec[spec.length - 1] : ".";
  const tokenRaw = sep && spec.endsWith(sep) ? spec.slice(0, -1) : spec;
  const tokens = tokenRaw.split(".").map((t) => t.trim()).filter(Boolean);
  const counters: number[] = [];
  return items.map((item) => {
    const level = Math.max(0, item.indent || 0);
    while (counters.length <= level) counters.push(0);
    counters[level] += 1;
    for (let i = level + 1; i < counters.length; i++) counters[i] = 0;
    const token = tokens[Math.min(level, tokens.length - 1)] ?? "1";
    const label = formatOrderedLabel(token, counters[level] || 1, sep);
    return renderBulletLine(item, label, indentPx, align);
  });
}

function renderBulletLine(
  item: { text: string; indent: number; color?: string; bgColor?: string },
  label: string,
  indentPx: number,
  align: "left" | "center" | "right"
) {
  const row = document.createElement("div");
  row.className = "node-bullets-line";
  const indentBase = Math.max(0, item.indent || 0) * indentPx;
  row.style.paddingLeft = `${indentBase}px`;
  row.style.alignSelf = "stretch";
  row.style.width = "100%";
  row.style.textAlign = align;
  if (item.color) row.style.color = item.color;
  if (item.bgColor) {
    row.style.backgroundColor = item.bgColor;
    row.style.borderRadius = "6px";
    row.style.padding = "2px 6px";
    row.style.paddingLeft = `${indentBase + 6}px`;
  }
  const content = String(item.text ?? "");
  const hasTab = content.includes("\t");
  if (hasTab) {
    const [leftRaw, rightRaw] = content.split("\t");
    row.style.display = "flex";
    row.style.alignItems = "baseline";
    row.style.justifyContent = "space-between";
    row.style.gap = "12px";
    row.style.textAlign = "left";
    const left = document.createElement("span");
    left.textContent = label ? `${label} ${leftRaw}` : leftRaw;
    const right = document.createElement("span");
    right.textContent = rightRaw ?? "";
    right.style.marginLeft = "auto";
    right.style.textAlign = "right";
    row.append(left, right);
  } else {
    row.textContent = label ? `${label} ${content}` : content;
  }
  return row;
}

function formatOrderedLabel(token: string, value: number, sep: string) {
  const suffix = sep === "-" ? "–" : sep === ")" ? ")" : ".";
  if (token === "1") return `${value}${suffix}`;
  if (token === "a") return `${toAlpha(value, false)}${suffix}`;
  if (token === "A") return `${toAlpha(value, true)}${suffix}`;
  if (token === "i") return `${toRoman(value, false)}${suffix}`;
  if (token === "I") return `${toRoman(value, true)}${suffix}`;
  return `${value}${suffix}`;
}

function toAlpha(n: number, upper: boolean) {
  let v = Math.max(1, Math.floor(n));
  let out = "";
  while (v > 0) {
    v -= 1;
    out = String.fromCharCode((v % 26) + 97) + out;
    v = Math.floor(v / 26);
  }
  return upper ? out.toUpperCase() : out;
}

function toRoman(n: number, upper: boolean) {
  let v = Math.max(1, Math.floor(n));
  const map: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let out = "";
  for (const [val, sym] of map) {
    while (v >= val) {
      out += sym;
      v -= val;
    }
  }
  return upper ? out.toUpperCase() : out;
}
