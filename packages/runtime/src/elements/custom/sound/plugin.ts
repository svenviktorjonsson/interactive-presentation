import type { ElementPlugin, FrameContext, RuntimeContext } from "../../../runtime/types";
import { drawSoundNode } from "./render";
import { ensureSoundCompositeLayer, layoutSoundCompositeTexts, renderSoundCompositeArrows, renderSoundCompositeButtons, renderSoundCompositeTexts } from "./ui";

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

let __soundState: SoundState | null = null;
let __handlersAttached = false;
let __lastPollMs = 0;

function ensureSoundStateDefaults(prev: SoundState | null): SoundState {
  return {
    enabled: prev?.enabled ?? false,
    computeSpectrum: prev?.computeSpectrum ?? true,
    computePressure: prev?.computePressure ?? false,
    seq: prev?.seq ?? 0,
    sampleRateHz: prev?.sampleRateHz ?? 48_000,
    windowMs: prev?.windowMs ?? 10,
    pressure10ms: prev?.pressure10ms ?? [],
    spectrum: prev?.spectrum ?? { freqHz: [], magDb: [] },
    error: prev?.error ?? null,
    serverTimeMs: prev?.serverTimeMs ?? 0,
  };
}

async function fetchSoundState(BACKEND: string): Promise<SoundState | null> {
  try {
    const res = await fetch(`${BACKEND}/api/sound/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SoundState;
  } catch {
    return null;
  }
}

function attachSoundHandlers(ctx: RuntimeContext) {
  if (__handlersAttached) return;
  __handlersAttached = true;

  ctx.stage.addEventListener("click", (ev) => {
    if (ctx.getAppMode() !== "live") return;
    if ((window as any).__ip_compositeEditing) return;
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const nodeEl = btn.closest<HTMLElement>(".node-sound");
    if (!nodeEl || !action) return;

    if (action === "sound-toggle") {
      const prev = __soundState ?? null;
      const st0 = ensureSoundStateDefaults(prev);
      const running = !!st0.enabled;
      const modeNow = (nodeEl.dataset.mode ?? "spectrum").toLowerCase() === "pressure" ? "pressure" : "spectrum";

      if (running) {
        __soundState = { ...st0, enabled: false };
        void fetch(`${ctx.BACKEND}/api/sound/pause`, { method: "POST" }).finally(async () => {
          const st = await fetchSoundState(ctx.BACKEND);
          if (st) __soundState = st;
        });
      } else {
        __soundState = { ...st0, enabled: true, error: null };
        void fetch(`${ctx.BACKEND}/api/sound/mode`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: modeNow }),
        })
          .catch(() => {})
          .finally(() => {
            void fetch(`${ctx.BACKEND}/api/sound/start`, { method: "POST" }).finally(async () => {
              const st = await fetchSoundState(ctx.BACKEND);
              if (st) __soundState = st;
              else __soundState = { ...ensureSoundStateDefaults(__soundState), enabled: false, error: "Sound backend unreachable" };
            });
          });
      }
      ev.preventDefault();
      return;
    }

    if (action === "sound-reset") {
      const prev = __soundState ?? null;
      const st0 = ensureSoundStateDefaults(prev);
      __soundState = { ...st0, enabled: false, seq: 0, pressure10ms: [], spectrum: { freqHz: [], magDb: [] }, error: null };
      void fetch(`${ctx.BACKEND}/api/sound/reset`, { method: "POST" }).finally(async () => {
        const st = await fetchSoundState(ctx.BACKEND);
        if (st) __soundState = st;
      });
      ev.preventDefault();
      return;
    }

    if (action === "sound-mode-toggle") {
      const cur = (nodeEl.dataset.mode ?? "spectrum").toLowerCase();
      const next = cur === "pressure" ? "spectrum" : "pressure";
      nodeEl.dataset.mode = next;
      void fetch(`${ctx.BACKEND}/api/sound/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      }).catch(() => {});
      ev.preventDefault();
      return;
    }
  });
}

export function createSoundPlugin(): ElementPlugin {
  return {
    type: "sound",
    onModel: (ctx) => {
      attachSoundHandlers(ctx);
      // Ensure composite layers exist so axes/labels are visible even before polling.
      const model = ctx.engine.getModel();
      for (const n of (model?.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "sound") continue;
        const id = String(n.id ?? "");
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;
        ensureSoundCompositeLayer(ctx.engine, id);
      }
    },
    onFrame: async (ctx: FrameContext) => {
      // Poll ~10x/sec in live while enabled; otherwise poll ~2x/sec.
      if (ctx.getAppMode() === "live") {
        const now = performance.now();
        const interval = __soundState?.enabled ? 100 : 500;
        if (now - __lastPollMs > interval) {
          __lastPollMs = now;
          const st = await fetchSoundState(ctx.BACKEND);
          if (st) __soundState = st;
        }
      }

      const st = __soundState ?? ensureSoundStateDefaults(null);
      for (const n of (ctx.model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "sound") continue;
        const id = String(n.id ?? "");
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;
        drawSoundNode(el, st);

        const layer = ensureSoundCompositeLayer(ctx.engine, id);
        if (layer) {
          renderSoundCompositeArrows(el, layer);
          layoutSoundCompositeTexts(el, layer);
          // Basic bindings (extend as needed)
          const peakDb = (() => {
            const mags = st.spectrum?.magDb ?? [];
            const v = Math.max(...mags.map((x) => (typeof x === "number" ? x : Number(x))));
            return Number.isFinite(v) ? v.toFixed(1) : "-";
          })();
          const mode = (el.dataset.mode ?? "spectrum").toLowerCase();
          const data: Record<string, string | number> = {
            peak: peakDb,
            mode,
          };
          renderSoundCompositeTexts(el, layer, data);
          renderSoundCompositeButtons(el, layer, data);
        }
      }
    },
    onStopInteractiveSessions: (ctx) => {
      const prev = __soundState ?? null;
      const st0 = ensureSoundStateDefaults(prev);
      if (!st0.enabled) return;
      __soundState = { ...st0, enabled: false };
      void fetch(`${ctx.BACKEND}/api/sound/pause`, { method: "POST" }).catch(() => {});
    },
  };
}

