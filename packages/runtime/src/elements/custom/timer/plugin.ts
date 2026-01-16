import type { ElementPlugin, FrameContext, RuntimeContext } from "../../../runtime/types";
import { ensureTimerCompositeLayer, layoutTimerCompositeTexts, renderTimerCompositeButtons, renderTimerCompositeTexts } from "./ui";
import { drawTimerNode } from "./render";

type TimerState = {
  accepting: boolean;
  samplesMs: number[];
  stats: { n: number; meanMs: number | null; sigmaMs: number | null };
};

let __timerPollStarted = false;
let __timerState: TimerState | null = null;
let __timerPollingEnabled = false;

async function fetchTimerState(BACKEND: string): Promise<TimerState | null> {
  try {
    const r = await fetch(`${BACKEND}/api/timer/state`);
    if (!r.ok) return null;
    return (await r.json()) as TimerState;
  } catch {
    return null;
  }
}

function runPauseResumeLabel(accepting: boolean, hasRunOnce: boolean) {
  if (!hasRunOnce) return "Run";
  return accepting ? "Pause" : "Resume";
}

function getHasRunOnce(timerEl: HTMLElement) {
  return timerEl.dataset.timerHasRunOnce === "1";
}
function setHasRunOnce(timerEl: HTMLElement, v: boolean) {
  timerEl.dataset.timerHasRunOnce = v ? "1" : "0";
}

function attachTimerHeaderHandlers(ctx: RuntimeContext) {
  if (__timerPollStarted) return;
  __timerPollStarted = true;

  ctx.stage.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button.ip-controlbtn");
    if (!btn) return;
    // Only in Live mode; never while composite/group editing
    if (ctx.getAppMode() !== "live") return;
    if ((window as any).__ip_compositeEditing) return;

    const action = btn.dataset.action ?? "";
    // Only timer header buttons here
    if (!action.startsWith("timer-")) return;

    const timerEl = btn.closest<HTMLElement>(".node-timer");
    const timerId = String(timerEl?.dataset.nodeId ?? "");
    if (!timerEl || !timerId) return;

    if (action === "timer-startstop") {
      const accepting = !!__timerState?.accepting;
      await fetch(`${ctx.BACKEND}/api/timer/${accepting ? "stop" : "start"}`, { method: "POST" }).catch(() => {});
      __timerState = await fetchTimerState(ctx.BACKEND);
      __timerPollingEnabled = !accepting;
      if (!accepting) setHasRunOnce(timerEl, true);
    } else if (action === "timer-reset") {
      await fetch(`${ctx.BACKEND}/api/timer/reset`, { method: "POST" }).catch(() => {});
      __timerState = await fetchTimerState(ctx.BACKEND);
      setHasRunOnce(timerEl, false);
    }
  });
}

export function createTimerPlugin(): ElementPlugin {
  return {
    type: "timer",
    onModel: (ctx, model) => {
      attachTimerHeaderHandlers(ctx);
      // Ensure composite layers exist once model is loaded (so labels/arrows are visible even before polling).
      for (const n of (model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "timer") continue;
        const id = String(n.id ?? "");
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;
        ensureTimerCompositeLayer(ctx.engine, id);
      }
    },
    onFrame: async (ctx: FrameContext) => {
      // Poll timer state only in Live mode.
      const live = ctx.getAppMode() === "live";
      if (live && (__timerPollingEnabled || !__timerState)) {
        // lightweight polling
        const st = await fetchTimerState(ctx.BACKEND);
        if (st) __timerState = st;
      }

      for (const n of (ctx.model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "timer") continue;
        const id = String(n.id ?? "");
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;
        const st = __timerState ?? { accepting: false, samplesMs: [], stats: { n: 0, meanMs: null, sigmaMs: null } };
        drawTimerNode(el, st);

        const layer = ensureTimerCompositeLayer(ctx.engine, id);
        if (layer) {
          layoutTimerCompositeTexts(el, layer);

          const fmtS = (ms: any) => {
            const v = typeof ms === "number" ? ms : Number(ms);
            if (!Number.isFinite(v)) return "-";
            return (v / 1000).toFixed(2);
          };
          const countN = st && Number.isFinite(st.stats.n) ? Number(st.stats.n) : 0;
          const hasRunOnce = getHasRunOnce(el);
          const accepting = !!st?.accepting;
          const data: Record<string, string | number> = {
            name: id,
            mean: countN > 0 && st ? fmtS(st.stats.meanMs) : "-",
            sigma: countN > 1 && st ? fmtS(st.stats.sigmaMs) : "-",
            count: countN > 0 ? String(countN) : "-",
            runPauseResume: runPauseResumeLabel(accepting, hasRunOnce),
          };
          renderTimerCompositeTexts(el, layer, data);
          renderTimerCompositeButtons(el, layer, data);
        }
      }
    }
    ,
    onStopInteractiveSessions: (ctx) => {
      __timerPollingEnabled = false;
      if (__timerState) __timerState.accepting = false;
      void fetch(`${ctx.BACKEND}/api/timer/stop`, { method: "POST" }).catch(() => {});
    }
  };
}

