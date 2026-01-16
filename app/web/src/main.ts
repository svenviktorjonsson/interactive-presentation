import "./style.css";
import "katex/dist/katex.min.css";

import { installGlobalErrorHandlers } from "./core/errors";
import { createStore, activeView, fitCameraToScreen, refreshCameraFit } from "./core/store";
import { attachStateMachine } from "./core/stateMachine";
import { createTransport } from "./core/transport";
import { loadEmbeddedModel } from "./core/embeddedModel";
import { drawGrid } from "./render/grid";
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
modeLive.textContent = "Live";
const modeView = document.createElement("button");
modeView.type = "button";
modeView.textContent = "Edit";
const modeScreen = document.createElement("button");
modeScreen.type = "button";
modeScreen.textContent = "Screen";
modeSwitch.append(modeLive, modeView, modeScreen);
toolbar.append(modeSwitch);
stage.appendChild(toolbar);

const setMode = (m: AppMode) => {
  store.mode = m;
  store.selectedId = null;
  store.selectedIds = [];
};

const syncModeUi = () => {
  document.body.dataset.ipMode = store.mode;
  modeLive.classList.toggle("is-active", store.mode === "live");
  modeView.classList.toggle("is-active", store.mode === "edit");
  modeScreen.classList.toggle("is-active", store.mode === "screen-edit");
};
syncModeUi();

modeLive.addEventListener("click", () => setMode("live"));
modeView.addEventListener("click", () => setMode("edit"));
modeScreen.addEventListener("click", () => setMode("screen-edit"));

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
  refreshCameraFit(store);
  updateCameraTween(now);
  const view = activeView(store);
  const cam = store.cameraOverride ?? fitCameraToScreen(view.camera, store);
  drawGrid(ctx, screen, cam);
  renderScene(scene, store, screen, now);
  sm.frame();
  syncModeUi();
  requestAnimationFrame(tick);
};

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);
