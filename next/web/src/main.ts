import "./style.css";
import "katex/dist/katex.min.css";

import { installGlobalErrorHandlers } from "./core/errors";
import { createStore, activeView } from "./core/store";
import { attachStateMachine } from "./core/stateMachine";
import { createTransport } from "./core/transport";
import { loadEmbeddedModel } from "./core/embeddedModel";
import { drawGrid } from "./render/grid";
import { createScene, renderScene } from "./render/scene";

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
attachStateMachine({ stage, overlay, store });
const transport = createTransport(store);
transport.start();

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D context unavailable");

const resize = () => {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

const tick = () => {
  const r = stage.getBoundingClientRect();
  const screen = { w: r.width, h: r.height };
  const cam = activeView(store).camera;
  drawGrid(ctx, screen, cam);
  renderScene(scene, store, screen);
  requestAnimationFrame(tick);
};

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);
