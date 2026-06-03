import "./style.css";
import "katex/dist/katex.min.css";

import { installGlobalErrorHandlers } from "./core/errors";
import { createStore, activeView, fitCameraToScreen, refreshCameraFit } from "./core/store";
import { attachStateMachine } from "./core/stateMachine";
import { canPersistToServer, createTransport, persistGeometry } from "./core/transport";
import { loadEmbeddedModel } from "./core/embeddedModel";
import { drawGrid, type ViewGridOptions } from "./render/grid";
import { createScene, renderScene } from "./render/scene";
import type { AppMode } from "./core/mode";

installGlobalErrorHandlers();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

const stage = document.createElement("div");
stage.className = "stage";

const canvas = document.createElement("canvas");
canvas.className = "stage-canvas";

const overlay = document.createElement("div");
overlay.className = "stage-overlay";


stage.append(canvas, overlay);
app.replaceChildren(stage);

const embedded = loadEmbeddedModel();
const store = createStore(embedded ?? undefined);
const scene = createScene(overlay);
const sm = attachStateMachine({ stage, overlay, store });
const transport = createTransport(store);
transport.start();

const toolbar = document.createElement("div");
toolbar.className = "stage-toolbar";
const modeSwitch = document.createElement("div");
modeSwitch.className = "mode-switch";
const modeLive = document.createElement("button");
modeLive.type = "button";
modeLive.textContent = "Go Live";
const modeScreen = document.createElement("button");
modeScreen.type = "button";
modeScreen.textContent = "Edit Screen";
modeSwitch.append(modeLive, modeScreen);
toolbar.append(modeSwitch);
stage.appendChild(toolbar);

const requestStageFullscreen = () => {
  try {
    if (!document.fullscreenElement) {
      stage.requestFullscreen().catch(() => {});
    }
  } catch {}
};
const exitFullscreen = () => {
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  } catch {}
};

const setMode = (m: AppMode) => {
  const prev = store.mode;
  store.mode = m;
  store.selectedId = null;
  store.selectedIds = [];
  if (m === "live") {
    store.activeGroupId = null;
    window.dispatchEvent(new CustomEvent("ip-clear-selection"));
  }
  if (m === "live") requestStageFullscreen();
  if (prev === "live" && m !== "live") exitFullscreen();
};

const syncModeUi = () => {
  document.body.dataset.ipMode = store.mode;
  toolbar.style.display = store.mode === "live" ? "none" : "";
  if (store.activeGroupId) {
    modeScreen.textContent = "Exit Group Edit";
  } else {
    modeScreen.textContent = store.mode === "screen-edit" ? "Exit Screen Edit" : "Edit Screen";
  }
};
syncModeUi();

modeLive.addEventListener("click", () => setMode("live"));
modeScreen.addEventListener("click", () => {
  if (store.activeGroupId) {
    window.dispatchEvent(new CustomEvent("ip-exit-group-edit"));
    return;
  }
  setMode(store.mode === "screen-edit" ? "edit" : "screen-edit");
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && store.mode === "live") {
    setMode("edit");
  }
});
window.addEventListener("fullscreenchange", () => {
  const isStageFullscreen = document.fullscreenElement === stage;
  if (isStageFullscreen) return;
  if (store.mode === "live") {
    const pendingMic = Boolean((window as any).__ip_micPermissionPending);
    if (pendingMic) return;
    requestStageFullscreen();
  }
});

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D context unavailable");

const resize = () => {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  store.screen = { w: r.width, h: r.height };
  refreshCameraFit(store);
};

const anchorFrac = (anchor: string | undefined) => {
  switch (anchor) {
    case "topLeft":
      return { ax: 0, ay: 0 };
    case "topCenter":
      return { ax: 0.5, ay: 0 };
    case "topRight":
      return { ax: 1, ay: 0 };
    case "centerLeft":
      return { ax: 0, ay: 0.5 };
    case "centerCenter":
      return { ax: 0.5, ay: 0.5 };
    case "centerRight":
      return { ax: 1, ay: 0.5 };
    case "bottomLeft":
      return { ax: 0, ay: 1 };
    case "bottomCenter":
      return { ax: 0.5, ay: 1 };
    case "bottomRight":
      return { ax: 1, ay: 1 };
    default:
      return { ax: 0.5, ay: 0.5 };
  }
};

const SCREEN_SPACE_META_ID = "__screen_space__";
let didPersistScreenSpaceMeta = false;

const groupLocalToWorldPoint = (group: any, p: { x: number; y: number }) => {
  const t = group?.transform ?? {};
  const { ax, ay } = anchorFrac(String(t.anchor ?? "centerCenter"));
  const rot = (Number(t.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const scaleX = Math.max(1e-9, Number(t.w ?? 0));
  const scaleY = Math.max(1e-9, Number(t.h ?? 0));
  const lx = (p.x - ax) * scaleX;
  const ly = (p.y - ay) * scaleY;
  const dx = lx * cos - ly * sin;
  const dy = lx * sin + ly * cos;
  return { x: Number(t.x ?? 0) + dx, y: Number(t.y ?? 0) + dy };
};

const syncArrowTransform = (node: any) => {
  const s = node.start ?? { x: 0, y: 0.5 };
  const e = node.end ?? { x: 1, y: 0.5 };
  const minX = Math.min(s.x, e.x);
  const minY = Math.min(s.y, e.y);
  const maxX = Math.max(s.x, e.x);
  const maxY = Math.max(s.y, e.y);
  node.transform = {
    ...(node.transform ?? {}),
    x: minX,
    y: minY,
    w: Math.max(1e-9, maxX - minX),
    h: Math.max(1e-9, maxY - minY),
    rotationDeg: 0,
    anchor: "topLeft",
  };
};

const normalizeScreenNodes = () => {
  const defaults = (store.model as any).defaults ?? {};
  const designW = (store.model as any).defaults?.designWidth ?? 1920;
  const designH = (store.model as any).defaults?.designHeight ?? 1080;
  store.screenSpaceMode = "normalized";
  (store.model as any).defaults = { ...defaults, screenSpace: "normalized" };
  if (canPersistToServer() && !didPersistScreenSpaceMeta) {
    void persistGeometry({
      id: SCREEN_SPACE_META_ID,
      viewId: "screen_main",
      space: "screen",
      transform: { x: 0.5, y: 0.5, w: 1, h: 1, rotationDeg: 1, anchor: "centerCenter" },
    });
    didPersistScreenSpaceMeta = true;
  }

  // Clamp screen-space nodes so their bounds do not exceed the screen.
  const minX = 0;
  const maxX = 1;
  const minY = 0;
  const maxY = 1;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  for (const node of store.model.nodes as any[]) {
    if (node?.space !== "screen" || !node?.transform || node?.type === "arrow") continue;
    const t = node.transform;
    const { ax, ay } = anchorFrac(t.anchor);
    const minPx = 8;
    // Keep min sizes stable across window resize to avoid hysteresis.
    const minW = minPx / Math.max(1e-9, designW);
    const minH = minPx / Math.max(1e-9, designH);
    if (node.type === "text" || node.type === "bullets") {
      const fontPx = Math.max(1, Number(node.fontPx ?? 16));
      const textMinH = (fontPx * 1.2) / Math.max(1e-9, designH);
      t.h = Math.max(t.h, textMinH, minH);
      t.w = Math.max(t.w, (fontPx * 1.6) / Math.max(1e-9, designW), minW);
    } else {
      t.w = Math.max(t.w, minW);
      t.h = Math.max(t.h, minH);
    }
    const wNormX = t.w;
    const hNormY = t.h;
    const minXAnchor = minX + ax * wNormX;
    const maxXAnchor = maxX - (1 - ax) * wNormX;
    // Y is down with normalized coords.
    const minYAnchor = minY + ay * hNormY;
    const maxYAnchor = maxY - (1 - ay) * hNormY;
    const nextX = minXAnchor > maxXAnchor ? (minXAnchor + maxXAnchor) / 2 : clamp(t.x, minXAnchor, maxXAnchor);
    const nextY = minYAnchor > maxYAnchor ? (minYAnchor + maxYAnchor) / 2 : clamp(t.y, minYAnchor, maxYAnchor);
    if (nextX === t.x && nextY === t.y) continue;
    t.x = nextX;
    t.y = nextY;
  }
};

const normalizeGroupNodes = () => {
  const byId = new Map((store.model.nodes as any[]).map((n) => [String(n?.id ?? ""), n]));
  for (const node of store.model.nodes as any[]) {
    if (!node?.transform || node.space !== "group" || !node.groupId || node.__groupUnpacked) continue;
    const group = byId.get(String(node.groupId));
    if (!group?.transform) continue;
    const groupSpace = group.space ?? node.space;
    if (node.type === "arrow") {
      const s = groupLocalToWorldPoint(group, node.start ?? { x: 0, y: 0.5 });
      const e = groupLocalToWorldPoint(group, node.end ?? { x: 1, y: 0.5 });
      node.start = s;
      node.end = e;
      syncArrowTransform(node);
    } else {
      const anchorWorld = groupLocalToWorldPoint(group, { x: node.transform.x, y: node.transform.y });
      const scale = Math.max(1e-9, Number(group.transform.w ?? 0));
      node.transform.x = anchorWorld.x;
      node.transform.y = anchorWorld.y;
      node.transform.w = node.transform.w * scale;
      node.transform.h = node.transform.h * scale;
      node.transform.rotationDeg = Number(node.transform.rotationDeg ?? 0) + Number(group.transform.rotationDeg ?? 0);
    }
    node.space = groupSpace;
    node.__groupUnpacked = true;
  }
};

const normalizeWorldNodes = () => {
  const designW = (store.model as any).defaults?.designWidth ?? 1920;
  const maxReasonable = 10; // data coords are normalized around width=1
  for (const node of store.model.nodes as any[]) {
    if (!node?.transform || node.space === "screen") continue;
    if (node.__worldNormalized) continue;
    const t = node.transform;
    let { x, y, w, h } = t;
    let rounds = 0;
    while ((Math.abs(x) > maxReasonable || Math.abs(y) > maxReasonable || w > maxReasonable || h > maxReasonable) && rounds < 2) {
      x /= designW;
      y /= designW;
      w /= designW;
      h /= designW;
      rounds += 1;
    }
    if (rounds > 0) {
      t.x = x;
      t.y = y;
      t.w = w;
      t.h = h;
    }
    node.__worldNormalized = true;
  }
};

const updateCameraTween = (now: number) => {
  const tween = store.cameraTween;
  if (!tween || !tween.segments.length) return;
  const seg = tween.segments[tween.idx];
  if (!seg) {
    store.cameraTween = null;
    store.cameraOverride = null;
    store.transitionFromViewId = null;
    store.transitionToViewId = null;
    return;
  }
  const t = (now - seg.startMs) / Math.max(1, seg.durationMs);
  const raw = Math.max(0, Math.min(1, t));
  const p = seg.easing === "cos2" ? Math.pow(Math.sin((raw * Math.PI) / 2), 2) : raw;
  const lerp = (a: number, b: number) => a + (b - a) * p;
  store.cameraOverride = {
    cx: lerp(seg.from.cx, seg.to.cx),
    cy: lerp(seg.from.cy, seg.to.cy),
    zoom: lerp(seg.from.zoom, seg.to.zoom),
  };
  if (p >= 1) {
    tween.idx += 1;
    if (tween.idx >= tween.segments.length) {
      store.cameraTween = null;
      store.cameraOverride = null;
      store.transitionFromViewId = null;
      store.transitionToViewId = null;
    } else {
      tween.segments[tween.idx]!.startMs = now;
    }
  }
};

const tick = () => {
  const now = performance.now();
  const r = stage.getBoundingClientRect();
  const screen = { w: r.width, h: r.height };
  store.screen = screen;
  normalizeScreenNodes();
  normalizeGroupNodes();
  normalizeWorldNodes();
  refreshCameraFit(store);
  updateCameraTween(now);
  const view = activeView(store);
  const cam = store.cameraOverride ?? fitCameraToScreen(view.camera, store);
  let gridCamLocal = cam;
  let gridBaseWorld: number | { x: number; y: number } | undefined;
  let gridOriginWorld: { x: number; y: number } | undefined;
  {
    gridBaseWorld = { x: 0.1, y: 0.1 };
    gridOriginWorld = { x: 0, y: 0 };
  }
  if (store.activeGroupId) {
    const group = store.model.nodes.find((n: any) => String((n as any).id) === String(store.activeGroupId)) as any;
    if (group?.transform) {
      const gw = Math.max(1e-9, Number(group.transform.w ?? 0));
      const gh = Math.max(1e-9, Number(group.transform.h ?? 0));
      const { ax, ay } = anchorFrac(String(group.transform.anchor ?? "centerCenter"));
      const left = Number(group.transform.x ?? 0) - ax * gw;
      const top = Number(group.transform.y ?? 0) - ay * gh;
      gridBaseWorld = { x: gw / 10, y: gh / 10 };
      gridOriginWorld = { x: left, y: top };
    }
  }
  const designW = (store.model as any).defaults?.designWidth ?? 1920;
  const designH = (store.model as any).defaults?.designHeight ?? 1080;
  const viewGrid: ViewGridOptions = {
      enabled: store.mode !== "live",
      viewCam: gridCamLocal,
      designW,
      designH,
      gridBaseWorld,
      gridOriginWorld,
    };
  drawGrid(ctx, screen, cam, {
    viewGrid,
    viewBoxes: [],
  });
  renderScene(scene, store, screen, now);
  sm.frame();
  syncModeUi();
  requestAnimationFrame(tick);
};

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);
