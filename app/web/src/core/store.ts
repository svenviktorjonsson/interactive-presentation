import type { Model } from "./model";
import { defaultModel } from "./model";
import type { AppMode } from "./mode";

export type Store = {
  model: Model;
  activeViewId: string;
  selectedId: string | null;
  selectedIds: string[];
  activeGroupId: string | null;
  mode: AppMode;
  screen: { w: number; h: number };
  cameraFit: number;
  screenSpaceMode: "normalized";
  cameraOverride: { cx: number; cy: number; zoom: number } | null;
  cameraTween:
    | null
    | {
        idx: number;
        segments: Array<{
          from: { cx: number; cy: number; zoom: number };
          to: { cx: number; cy: number; zoom: number };
          durationMs: number;
          startMs: number;
          easing?: "cos2";
        }>;
      };
  transitionFromViewId: string | null;
  transitionToViewId: string | null;
};

const activeViewStorageKey = () => {
  try {
    return `ip:active-view:${window.location.origin}${window.location.pathname}`;
  } catch {
    return "ip:active-view";
  }
};

const validViewId = (model: Model, candidate: string | null | undefined) => {
  const viewId = String(candidate ?? "").trim();
  if (!viewId) return null;
  return (model.views ?? []).some((view) => String(view.id) === viewId) ? viewId : null;
};

export function restorePersistedActiveViewId(model: Model): string | null {
  try {
    return validViewId(model, window.localStorage.getItem(activeViewStorageKey()));
  } catch {
    return null;
  }
}

export function resolveInitialActiveViewId(model: Model, preferred?: string | null): string {
  return (
    validViewId(model, preferred)
    ?? restorePersistedActiveViewId(model)
    ?? validViewId(model, model.initialViewId)
    ?? validViewId(model, model.views[0]?.id)
    ?? "home"
  );
}

export function persistActiveViewId(store: Store): void {
  try {
    const next = validViewId(store.model, store.activeViewId);
    if (!next) return;
    window.localStorage.setItem(activeViewStorageKey(), next);
  } catch {}
}

export function createStore(initialModel?: Model): Store {
  const model = initialModel ?? defaultModel();
  const activeViewId = resolveInitialActiveViewId(model);
  return {
    model,
    activeViewId,
    selectedId: null,
    selectedIds: [],
    activeGroupId: null,
    mode: "edit",
    screen: { w: 1, h: 1 },
    cameraFit: 1,
    screenSpaceMode: "normalized",
    cameraOverride: null,
    cameraTween: null,
    transitionFromViewId: null,
    transitionToViewId: null,
  };
}

export function computeCameraFit(store: Store) {
  void store;
  // Data coords are normalized to screen width; no extra fit scaling needed.
  return 1;
}

export function fitCameraToScreen(
  camera: { cx: number; cy: number; zoom: number },
  store: Store
): { cx: number; cy: number; zoom: number } {
  const fit = computeCameraFit(store);
  return { cx: camera.cx, cy: camera.cy, zoom: camera.zoom * fit };
}

export function refreshCameraFit(store: Store) {
  const nextFit = computeCameraFit(store);
  const prevFit = Number.isFinite(store.cameraFit) && store.cameraFit > 0 ? store.cameraFit : nextFit;
  const scale = nextFit / Math.max(1e-9, prevFit);
  if (Math.abs(scale - 1) < 1e-6) {
    store.cameraFit = nextFit;
    return;
  }
  if (store.cameraOverride) {
    store.cameraOverride = { ...store.cameraOverride, zoom: store.cameraOverride.zoom * scale };
  }
  if (store.cameraTween?.segments?.length) {
    for (const seg of store.cameraTween.segments) {
      seg.from.zoom *= scale;
      seg.to.zoom *= scale;
    }
  }
  store.cameraFit = nextFit;
}

export function activeView(store: Store) {
  const v = store.model.views.find((x) => x.id === store.activeViewId);
  const view = v ?? store.model.views[0]!;
  if (store.cameraOverride) {
    return { ...view, camera: store.cameraOverride };
  }
  return { ...view, camera: resolveViewCamera(store, view.id) };
}

export function resolveViewCamera(store: Store, viewId: string) {
  const views = store.model.views;
  const idx = views.findIndex((x) => x.id === viewId);
  const view = views[idx] ?? views[0];
  if (!view) return { cx: 0.5, cy: 0.5, zoom: 1 };
  const loc = (view as any).loc as string | undefined;
  const refView = (view as any).refView as string | undefined;
  if (!loc && !refView) return { ...view.camera };

  const memo = new Map<string, { cx: number; cy: number; zoom: number }>();
  const resolving = new Set<string>();

  const resolve = (id: string): { cx: number; cy: number; zoom: number } => {
    if (memo.has(id)) return memo.get(id)!;
    if (resolving.has(id)) return { ...view.camera };
    resolving.add(id);
    const vi = views.findIndex((x) => x.id === id);
    const v = views[vi] ?? views[0];
    if (!v) {
      resolving.delete(id);
      return { cx: 0, cy: 0, zoom: 1 };
    }
    const vLoc = (v as any).loc as string | undefined;
    const vRef = (v as any).refView as string | undefined;
    if (!vLoc && !vRef) {
      const out = { ...v.camera };
      memo.set(id, out);
      resolving.delete(id);
      return out;
    }
    const baseId = vRef ?? (vLoc && vi > 0 ? views[vi - 1]?.id : undefined);
    const base = baseId ? resolve(baseId) : { ...v.camera };
    if (!vLoc) {
      const out = { ...base, zoom: v.camera.zoom ?? base.zoom };
      memo.set(id, out);
      resolving.delete(id);
      return out;
    }
    const locNorm = vLoc.trim().replace(/[_-]/g, "").toLowerCase();
    const hw = 0.5 / Math.max(1e-9, base.zoom);
    const hh = 0.5 / Math.max(1e-9, base.zoom);
    let dx = 0;
    let dy = 0;
    if (locNorm.includes("right") || locNorm.includes("east")) dx += 2 * hw;
    if (locNorm.includes("left") || locNorm.includes("west")) dx -= 2 * hw;
    if (locNorm.includes("bottom") || locNorm.includes("down") || locNorm.includes("south") || locNorm.includes("below")) {
      dy += 2 * hh;
    }
    if (locNorm.includes("top") || locNorm.includes("up") || locNorm.includes("north") || locNorm.includes("above")) {
      dy -= 2 * hh;
    }
    const out = { cx: base.cx + dx, cy: base.cy + dy, zoom: v.camera.zoom ?? base.zoom };
    memo.set(id, out);
    resolving.delete(id);
    return out;
  };

  return resolve(viewId);
}
