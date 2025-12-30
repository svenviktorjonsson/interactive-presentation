import QRCode from "qrcode";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { PresentationModel } from "@interactive/content";
import { Engine } from "@interactive/engine";
import "./styles.css";

// When the backend serves the built frontend, same-origin fetch works.
// In dev (vite on :5173), it will still default to :8000 unless overridden.
const BACKEND = import.meta.env.VITE_BACKEND_URL ?? window.location.origin.replace(":5173", ":8000");

const DEBUG_ANIM =
  new URLSearchParams(window.location.search).get("debugAnim") === "1" || localStorage.getItem("ip_debug_anim") === "1";

function dlog(...args: any[]) {
  if (!DEBUG_ANIM) return;
  // eslint-disable-next-line no-console
  console.log("[ip][anim]", ...args);
}

function buildShell() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app not found");

  const stage = document.createElement("div");
  stage.className = "stage";

  const canvas = document.createElement("canvas");
  canvas.className = "canvas";

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  // Browsers won't auto-enter fullscreen without a user gesture; provide a 1-click prompt.
  const fs = document.createElement("div");
  fs.className = "fs-prompt";
  fs.innerHTML = `<button type="button">Enter fullscreen</button><div class="hint">If blocked, use F11</div>`;
  fs.querySelector("button")?.addEventListener("click", async () => {
    try {
      await document.documentElement.requestFullscreen();
      fs.remove();
    } catch {
      // If it fails, keep the prompt visible.
    }
  });

  stage.append(canvas, overlay, fs);
  app.append(stage);
  return { canvas, overlay, stage };
}

async function fetchModel(): Promise<PresentationModel> {
  const res = await fetch(`${BACKEND}/api/presentation`);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return (await res.json()) as PresentationModel;
}

async function saveModel(model: PresentationModel) {
  const res = await fetch(`${BACKEND}/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(model)
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
}

async function hydrateQrImages(engine: Engine, model: PresentationModel) {
  const qrNodes = model.nodes.filter((n) => n.type === "qr");
  for (const n of qrNodes) {
    if (n.type !== "qr") continue;
    const el = engine.getNodeElement(n.id);
    if (!el) continue;
    const img = el.querySelector<HTMLImageElement>(".qr-img");
    if (!img) continue;
    img.alt = `QR: ${n.url}`;
    img.src = await QRCode.toDataURL(n.url, {
      margin: 1,
      width: 512,
      // Use rgba() to avoid any ambiguity about 8-digit hex support.
      // Standard QR colors; pixelate animation controls fade-in.
      color: { dark: "#000000ff", light: "#ffffffff" }
    });
  }
}

type TimerState = {
  accepting: boolean;
  samplesMs: number[];
  stats: { n: number; meanMs: number | null; sigmaMs: number | null };
};

let __timerPollStarted = false;
let __timerState: TimerState | null = null;

async function fetchTimerState(): Promise<TimerState | null> {
  try {
    const res = await fetch(`${BACKEND}/api/timer/state`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TimerState;
  } catch {
    return null;
  }
}

function drawTimerNode(el: HTMLElement, state: TimerState) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.timer-canvas");
  if (!canvas) return;
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(2, Math.round(r.width * dpr));
  const H = Math.max(2, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const phi = 1.618;
  const m = 16 * dpr;
  const plotW = W - m * 2;
  const plotH = H - m * 2;
  const yLen = plotH * 0.78;
  const xLen = Math.min(plotW * 0.92, yLen * phi);
  const ox = m + (plotW * 0.08);
  const oy = m + (plotH * 0.90);

  // Axes
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox + xLen, oy);
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox, oy - yLen);
  ctx.stroke();

  const arrow = (x0: number, y0: number, x1: number, y1: number) => {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const L = 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - L * Math.cos(ang - Math.PI / 6), y1 - L * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x1 - L * Math.cos(ang + Math.PI / 6), y1 - L * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fill();
  };
  arrow(ox, oy, ox + xLen, oy);
  arrow(ox, oy, ox, oy - yLen);

  // Data
  const samples = state.samplesMs ?? [];
  const n = samples.length;
  const barColor = el.dataset.barColor ?? "orange";
  const lineColor = el.dataset.lineColor ?? "green";

  // Domain and binning (seconds)
  const minS = Number(el.dataset.minS ?? "0");
  const maxSDefault = Math.max(1, ...samples.map((x) => x / 1000));
  const maxS = Number(el.dataset.maxS ?? String(Math.max(1, maxSDefault)));
  const binSizeS = Number(el.dataset.binSizeS ?? "0.5");
  const span = Math.max(1e-9, maxS - minS);
  const bins = Math.max(1, Math.round(span / binSizeS));
  const counts = new Array(bins).fill(0);
  for (const ms of samples) {
    const s = ms / 1000;
    const idx = Math.max(0, Math.min(bins - 1, Math.floor(((s - minS) / span) * bins)));
    counts[idx] += 1;
  }
  const perc = counts.map((c) => (n > 0 ? c / n : 0));

  // Bars
  ctx.fillStyle = barColor;
  const bw = xLen / bins;
  for (let i = 0; i < bins; i++) {
    const h = perc[i] * yLen;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(ox + i * bw + bw * 0.08, oy - h, bw * 0.84, h);
  }
  ctx.globalAlpha = 1;

  // Gaussian overlay normalized 0..1
  const mu = (state.stats.meanMs ?? 0) / 1000;
  const sigma = Math.max(1e-6, (state.stats.sigmaMs ?? 0) / 1000);
  if (n >= 2 && sigma > 0) {
    const gauss = (x: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    // normalize to 1
    const gmax = gauss(mu);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = minS + (i / 200) * span;
      const y = gauss(x) / gmax; // 0..1
      const sx = ox + ((x - minS) / span) * xLen;
      const sy = oy - y * yLen;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  // Update presenter status label
  const statusEl = el.querySelector<HTMLElement>(".timer-status");
  const startBtn = el.querySelector<HTMLButtonElement>('button[data-action="timer-startstop"]');
  if (statusEl) statusEl.textContent = state.accepting ? "Running" : "Stopped";
  if (startBtn) startBtn.textContent = state.accepting ? "Stop" : "Start";
}

function attachTimerNodeHandlers(stage: HTMLElement) {
  stage.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;
    if (action === "timer-startstop") {
      // toggle using last known state
      const accepting = !!__timerState?.accepting;
      await fetch(`${BACKEND}/api/timer/${accepting ? "stop" : "start"}`, { method: "POST" });
      __timerState = await fetchTimerState();
      ev.preventDefault();
      return;
    }
    if (action === "timer-reset") {
      await fetch(`${BACKEND}/api/timer/reset`, { method: "POST" });
      __timerState = await fetchTimerState();
      ev.preventDefault();
      return;
    }
  });
}

function ensureTimerPolling(engine: Engine, model: PresentationModel, stage: HTMLElement) {
  if (__timerPollStarted) return;
  __timerPollStarted = true;
  attachTimerNodeHandlers(stage);

  const tick = async () => {
    const st = await fetchTimerState();
    if (st) __timerState = st;
    const cur = engine.getModel();
    if (!cur || !__timerState) return;
    for (const n of cur.nodes) {
      if (n.type !== "timer") continue;
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      drawTimerNode(el, __timerState);
    }
  };

  // Kick immediately, then poll.
  void tick();
  window.setInterval(() => void tick(), 350);
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function findNextDelimiter(text: string, delim: "$" | "$$", start: number) {
  const d = delim === "$$" ? "$$" : "$";
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (d === "$$") {
      if (text[i] === "$" && text[i + 1] === "$") return i;
    } else {
      if (text[i] === "$") return i;
    }
  }
  return -1;
}

function renderTextWithKatexToHtml(input: string) {
  // Supports inline $...$ and display $$...$$. No nesting. Escapes plain text.
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const nextDollar = input.indexOf("$", i);
    if (nextDollar === -1) {
      out.push(escapeHtml(input.slice(i)));
      break;
    }
    // plain text before delimiter
    out.push(escapeHtml(input.slice(i, nextDollar)));

    const isDisplay = input[nextDollar + 1] === "$";
    const delim: "$" | "$$" = isDisplay ? "$$" : "$";
    const start = nextDollar + (isDisplay ? 2 : 1);
    const end = findNextDelimiter(input, delim, start);
    if (end === -1) {
      // Unclosed: treat the rest as text.
      out.push(escapeHtml(input.slice(nextDollar)));
      break;
    }
    const expr = input.slice(start, end);
    try {
      out.push(
        katex.renderToString(expr, {
          displayMode: isDisplay,
          throwOnError: false,
          strict: "ignore"
        })
      );
    } catch {
      out.push(escapeHtml(input.slice(nextDollar, end + (isDisplay ? 2 : 1))));
    }
    i = end + (isDisplay ? 2 : 1);
  }

  return out.join("");
}

function hydrateTextMath(engine: Engine, model: PresentationModel) {
  for (const n of model.nodes) {
    if (n.type !== "text") continue;
    const el = engine.getNodeElement(n.id);
    if (!el) continue;
    // Render mixed text + math; keep newlines.
    const raw = n.text ?? "";
    // IMPORTANT: keep this in sync with the engine's per-frame text node updater.
    // If we don't set it, the next render tick may overwrite our KaTeX HTML with raw text (including '$').
    el.dataset.rawText = raw;
    el.innerHTML = renderTextWithKatexToHtml(raw).replaceAll("\n", "<br/>");
  }
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function gridSpacingForZoom(zoom: number, baseWorld = 100) {
  const logz = Math.log10(Math.max(1e-9, zoom));
  const n = Math.floor(logz);
  const frac = logz - n;
  const t = smoothstep(0.25, 0.75, frac);
  const spacing0 = baseWorld / Math.pow(10, n);
  const spacing1 = baseWorld / Math.pow(10, n + 1);
  return { spacing0, spacing1, t };
}

type DragMode = "none" | "move" | "resize" | "rotate";

function ensureHandles(el: HTMLElement) {
  let handles = el.querySelector<HTMLDivElement>(":scope > .handles");

  const normalizeAnchor = (a: string | undefined) => {
    if (!a) return "topLeft";
    if (a === "top") return "topCenter";
    if (a === "bottom") return "bottomCenter";
    if (a === "left") return "centerLeft";
    if (a === "right") return "centerRight";
    if (a === "center") return "centerCenter";
    return a;
  };

  const updateAnchorDots = (root: HTMLElement) => {
    const current = normalizeAnchor(el.dataset.anchor);
    for (const dot of Array.from(root.querySelectorAll<HTMLElement>(".anchor-dot"))) {
      dot.classList.toggle("is-current", dot.dataset.anchor === current);
    }
  };

  if (handles) {
    updateAnchorDots(handles);
    return handles;
  }
  handles = document.createElement("div");
  handles.className = "handles";
  const mk = (name: string, left: string, top: string, cls = "") => {
    const h = document.createElement("div");
    h.className = `handle ${cls}`.trim();
    h.dataset.handle = name;
    h.style.left = left;
    h.style.top = top;
    h.style.transform = "translate(-50%, -50%)";
    return h;
  };
  handles.append(
    mk("nw", "0%", "0%"),
    mk("n", "50%", "0%"),
    mk("ne", "100%", "0%"),
    mk("e", "100%", "50%"),
    mk("se", "100%", "100%"),
    mk("s", "50%", "100%"),
    mk("sw", "0%", "100%"),
    mk("w", "0%", "50%"),
    mk("rot", "50%", "-18px", "rotate")
  );

  const mkAnchor = (anchor: string, left: string, top: string) => {
    const d = document.createElement("div");
    d.className = "anchor-dot";
    d.dataset.anchor = anchor;
    d.style.left = left;
    d.style.top = top;
    return d;
  };
  // 6-point anchors (requested)
  handles.append(
    mkAnchor("topLeft", "0%", "0%"),
    mkAnchor("topCenter", "50%", "0%"),
    mkAnchor("topRight", "100%", "0%"),
    mkAnchor("centerLeft", "0%", "50%"),
    mkAnchor("centerCenter", "50%", "50%"),
    mkAnchor("centerRight", "100%", "50%"),
    mkAnchor("bottomLeft", "0%", "100%"),
    mkAnchor("bottomCenter", "50%", "100%"),
    mkAnchor("bottomRight", "100%", "100%")
  );

  el.appendChild(handles);
  updateAnchorDots(handles);
  return handles;
}

function anchorToTopLeftWorld(t: { x: number; y: number; w: number; h: number; anchor?: string }) {
  const a = (t.anchor ?? "topLeft") === "top" ? "topCenter" : (t.anchor ?? "topLeft") === "bottom" ? "bottomCenter" : t.anchor ?? "topLeft";
  switch (a) {
    case "center":
    case "centerCenter":
      return { x: t.x - t.w / 2, y: t.y - t.h / 2 };
    case "topCenter":
      return { x: t.x - t.w / 2, y: t.y };
    case "bottomCenter":
      return { x: t.x - t.w / 2, y: t.y - t.h };
    case "centerLeft":
      return { x: t.x, y: t.y - t.h / 2 };
    case "centerRight":
      return { x: t.x - t.w, y: t.y - t.h / 2 };
    case "left":
      return { x: t.x, y: t.y - t.h / 2 };
    case "right":
      return { x: t.x - t.w, y: t.y - t.h / 2 };
    case "topRight":
      return { x: t.x - t.w, y: t.y };
    case "bottomLeft":
      return { x: t.x, y: t.y - t.h };
    case "bottomRight":
      return { x: t.x - t.w, y: t.y - t.h };
    case "topLeft":
    default:
      return { x: t.x, y: t.y };
  }
}

function topLeftToAnchorWorld(rect: { x: number; y: number; w: number; h: number }, anchor?: string) {
  const a = (anchor ?? "topLeft") === "top" ? "topCenter" : (anchor ?? "topLeft") === "bottom" ? "bottomCenter" : anchor ?? "topLeft";
  switch (a) {
    case "center":
    case "centerCenter":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    case "topCenter":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "bottomCenter":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "centerLeft":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "centerRight":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "topRight":
      return { x: rect.x + rect.w, y: rect.y };
    case "bottomLeft":
      return { x: rect.x, y: rect.y + rect.h };
    case "bottomRight":
      return { x: rect.x + rect.w, y: rect.y + rect.h };
    case "topLeft":
    default:
      return { x: rect.x, y: rect.y };
  }
}

function attachEditor(stage: HTMLElement, engine: Engine) {
  const selected = new Set<string>();

  const undoStack: PresentationModel[] = [];
  const redoStack: PresentationModel[] = [];
  const cloneModel = (m: PresentationModel): PresentationModel => JSON.parse(JSON.stringify(m)) as PresentationModel;

  let dragMode: DragMode = "none";
  let activeHandle: string | null = null;
  let start = { x: 0, y: 0 };
  let startSnapshot: PresentationModel | null = null;
  let startNodesById: Record<string, any> | null = null;
  let startAngleRad = 0;
  let startRotationDeg = 0;

  const applySelection = () => {
    const model = engine.getModel();
    if (!model) return;
    for (const n of model.nodes) {
      const el = engine.getNodeElement(n.id);
      if (!el) continue;
      const isSel = selected.has(n.id);
      el.classList.toggle("is-selected", isSel);
      if (isSel && selected.size === 1) ensureHandles(el);
      if (!isSel || selected.size !== 1) el.querySelector(".handles")?.remove();
    }
  };

  const clearSelection = () => {
    selected.clear();
    applySelection();
  };

  const selectOne = (id: string) => {
    selected.clear();
    selected.add(id);
    applySelection();
  };

  const addSelect = (id: string) => {
    selected.add(id);
    applySelection();
  };

  const toggleSelect = (id: string) => {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    applySelection();
  };

  const getSelectedNodes = () => {
    const model = engine.getModel();
    if (!model) return [];
    return model.nodes.filter((n) => selected.has(n.id));
  };

  const commit = async (before: PresentationModel | null) => {
    if (!before) return;
    const after = engine.getModel();
    if (!after) return;
    undoStack.push(before);
    redoStack.length = 0;
    await saveModel(after);
  };

  const deleteSelection = async () => {
    const model = engine.getModel();
    if (!model) return;
    if (selected.size === 0) return;
    const before = cloneModel(model);

    const del = new Set(selected);
    model.nodes = model.nodes.filter((n) => !del.has(n.id));
    for (const v of model.views) v.show = v.show.filter((id) => !del.has(id));
    engine.setModel(model);
    await hydrateQrImages(engine, model);
    hydrateTextMath(engine, model);
    selected.clear();
    applySelection();
    await commit(before);
  };

  const openEditorModal = async (nodeId: string) => {
    const model = engine.getModel();
    if (!model) return;
    const node = model.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const before = cloneModel(model);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    backdrop.appendChild(modal);

    let activeTab: "data" | "geometry" | "animations" = "data";

    const header = document.createElement("div");
    header.className = "modal-header";
    header.innerHTML = `<div class="modal-title">Edit: ${node.type} (${node.id})</div>`;

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const tabData = document.createElement("button");
    tabData.className = "tab is-active";
    tabData.type = "button";
    tabData.textContent = "Data";
    const tabGeom = document.createElement("button");
    tabGeom.className = "tab";
    tabGeom.type = "button";
    tabGeom.textContent = "Geometry";
    const tabAnim = document.createElement("button");
    tabAnim.className = "tab";
    tabAnim.type = "button";
    tabAnim.textContent = "Animations";
    tabs.append(tabData, tabGeom, tabAnim);
    header.appendChild(tabs);

    const body = document.createElement("div");
    body.className = "modal-body";

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const btnCancel = document.createElement("button");
    btnCancel.className = "btn";
    btnCancel.type = "button";
    btnCancel.textContent = "Cancel";
    const btnSave = document.createElement("button");
    btnSave.className = "btn primary";
    btnSave.type = "button";
    btnSave.textContent = "Save";
    footer.append(btnCancel, btnSave);

    modal.append(header, body, footer);
    document.body.appendChild(backdrop);

    const state: any = JSON.parse(JSON.stringify(node));

    const render = () => {
      body.innerHTML = "";
      tabData.classList.toggle("is-active", activeTab === "data");
      tabGeom.classList.toggle("is-active", activeTab === "geometry");
      tabAnim.classList.toggle("is-active", activeTab === "animations");

      if (activeTab === "data") {
        if (state.type === "text") {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>Text (use $$...$$ for KaTeX)</label>`;
          const ta = document.createElement("textarea");
          ta.value = state.text ?? "";
          const prev = document.createElement("div");
          prev.className = "preview";
          prev.innerHTML = renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
          ta.addEventListener("input", () => {
            state.text = ta.value;
            prev.innerHTML = renderTextWithKatexToHtml(ta.value).replaceAll("\n", "<br/>");
          });
          f.append(ta, prev);
          body.appendChild(f);
          return;
        }

        if (state.type === "qr") {
          const info = document.createElement("div");
          info.className = "field";
          info.innerHTML = `<label>Join QR</label><div class="preview">This QR is a special join node.\nIt always points to /join (the public tunnel URL is injected at runtime).</div>`;
          body.append(info);
          return;
        }

        body.textContent = "No editable data for this node type yet.";
        return;
      }

      if (activeTab === "geometry") {
        const t = (state.transform ??= {});
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(2, 1fr)";
        grid.style.gap = "12px";

        const num = (label: string, key: string) => {
          const f = document.createElement("div");
          f.className = "field";
          f.innerHTML = `<label>${label}</label>`;
          const i = document.createElement("input");
          i.type = "number";
          i.value = String(t[key] ?? 0);
          i.addEventListener("input", () => (t[key] = Number(i.value)));
          f.appendChild(i);
          return f;
        };

        grid.append(num("x", "x"), num("y", "y"), num("w", "w"), num("h", "h"), num("rotationDeg", "rotationDeg"));

        const anchorF = document.createElement("div");
        anchorF.className = "field";
        anchorF.innerHTML = `<label>anchor</label>`;
        const anchorS = document.createElement("select");
        for (const a of [
          "topLeft",
          "topCenter",
          "topRight",
          "centerLeft",
          "centerCenter",
          "centerRight",
          "bottomLeft",
          "bottomCenter",
          "bottomRight"
        ]) {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          anchorS.appendChild(o);
        }
        anchorS.value = (t.anchor ?? "topLeft") === "top" ? "topCenter" : (t.anchor ?? "topLeft") === "bottom" ? "bottomCenter" : (t.anchor ?? "topLeft");
        anchorS.addEventListener("change", () => (t.anchor = anchorS.value));
        anchorF.appendChild(anchorS);

        const alignF = document.createElement("div");
        alignF.className = "field";
        alignF.innerHTML = `<label>alignment (text)</label>`;
        const alignS = document.createElement("select");
        for (const a of ["left", "center", "right"]) {
          const o = document.createElement("option");
          o.value = a;
          o.textContent = a;
          alignS.appendChild(o);
        }
        alignS.value = state.align === "right" ? "right" : state.align === "center" ? "center" : "left";
        alignS.addEventListener("change", () => (state.align = alignS.value));
        alignF.appendChild(alignS);

        const spaceF = document.createElement("div");
        spaceF.className = "field";
        spaceF.innerHTML = `<label>space</label>`;
        const spaceS = document.createElement("select");
        for (const s of ["world", "screen"]) {
          const o = document.createElement("option");
          o.value = s;
          o.textContent = s;
          spaceS.appendChild(o);
        }
        spaceS.value = state.space ?? "world";
        spaceS.addEventListener("change", () => (state.space = spaceS.value));
        spaceF.appendChild(spaceS);

        body.append(grid, anchorF, alignF, spaceF);
        return;
      }

      if (activeTab === "animations") {
        const mkAnimEditor = (label: string, key: "appear" | "disappear") => {
          const wrap = document.createElement("div");
          wrap.className = "field";
          wrap.innerHTML = `<label>${label}</label>`;

          const a = (state[key] ??= { kind: "none" });

          const typeS = document.createElement("select");
          for (const k of ["none", "direct", "fade", "pixelate", "appear"]) {
            const o = document.createElement("option");
            o.value = k;
            o.textContent = k;
            typeS.appendChild(o);
          }
          typeS.value = String(a.kind ?? "none");
          typeS.addEventListener("change", () => {
            const v = typeS.value;
            if (v === "none") state[key] = { kind: "none" };
            else if (v === "direct") state[key] = { kind: "direct" };
            else if (v === "fade") state[key] = { kind: "fade", durationMs: 800, from: "all", borderFrac: 0.2, delayMs: 0 };
            else if (v === "pixelate") state[key] = { kind: "pixelate", durationMs: 800, delayMs: 0 };
            else if (v === "appear") state[key] = { kind: "appear", durationMs: 0 };
            render();
          });
          wrap.appendChild(typeS);

          const cur = state[key];
          if (cur?.kind === "fade") {
            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, 1fr)";
            grid.style.gap = "12px";

            const num = (lab: string, prop: string, step = "1") => {
              const f = document.createElement("div");
              f.className = "field";
              f.innerHTML = `<label>${lab}</label>`;
              const i = document.createElement("input");
              i.type = "number";
              i.step = step;
              i.value = String(cur[prop] ?? 0);
              i.addEventListener("input", () => (cur[prop] = Number(i.value)));
              f.appendChild(i);
              return f;
            };
            grid.append(num("durationMs", "durationMs", "10"), num("delayMs", "delayMs", "10"), num("borderFrac", "borderFrac", "0.05"));

            const fromF = document.createElement("div");
            fromF.className = "field";
            fromF.innerHTML = `<label>from</label>`;
            const fromS = document.createElement("select");
            for (const f of ["all", "left", "right", "top", "bottom"]) {
              const o = document.createElement("option");
              o.value = f;
              o.textContent = f;
              fromS.appendChild(o);
            }
            fromS.value = cur.from ?? "all";
            fromS.addEventListener("change", () => (cur.from = fromS.value));
            fromF.appendChild(fromS);

            wrap.appendChild(grid, fromF);
          } else if (cur?.kind === "pixelate") {
            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, 1fr)";
            grid.style.gap = "12px";
            const num = (lab: string, prop: string) => {
              const f = document.createElement("div");
              f.className = "field";
              f.innerHTML = `<label>${lab}</label>`;
              const i = document.createElement("input");
              i.type = "number";
              i.step = "10";
              i.value = String(cur[prop] ?? 0);
              i.addEventListener("input", () => (cur[prop] = Number(i.value)));
              f.appendChild(i);
              return f;
            };
            grid.append(num("durationMs", "durationMs"), num("delayMs", "delayMs"));
            wrap.appendChild(grid);
          }

          return wrap;
        };

        body.append(mkAnimEditor("Enter (appear)", "appear"), mkAnimEditor("Exit (disappear)", "disappear"));
        return;
      }
    };

    const close = () => backdrop.remove();

    tabData.addEventListener("click", () => {
      activeTab = "data";
      render();
    });
    tabGeom.addEventListener("click", () => {
      activeTab = "geometry";
      render();
    });
    tabAnim.addEventListener("click", () => {
      activeTab = "animations";
      render();
    });

    btnCancel.addEventListener("click", () => close());
    // Close only on backdrop mouse-down (not mouse-up/click) to avoid accidental closes
    // when dragging outside and releasing.
    modal.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    backdrop.addEventListener("pointerdown", (ev) => {
      if (ev.target === backdrop) close();
    });

    btnSave.addEventListener("click", async () => {
      engine.updateNode(nodeId, state);
      const m2 = engine.getModel();
      if (m2) {
        await hydrateQrImages(engine, m2);
        hydrateTextMath(engine, m2);
      }
      applySelection();
      await commit(before);
      close();
    });

    (btnSave as HTMLButtonElement).focus();
    render();
  };

  const onKey = async (ev: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || (document.activeElement as HTMLElement | null)?.isContentEditable;
    if (inInput) return;

    if (ev.ctrlKey && ev.key.toLowerCase() === "a") {
      // Intentionally not supported (avoid accidental "select all").
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") {
      const prev = undoStack.pop();
      if (!prev) return;
      const cur = engine.getModel();
      if (cur) redoStack.push(cloneModel(cur));
      engine.setModel(cloneModel(prev));
      await hydrateQrImages(engine, prev);
      hydrateTextMath(engine, prev);
      applySelection();
      await saveModel(prev);
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "y") {
      const next = redoStack.pop();
      if (!next) return;
      const cur = engine.getModel();
      if (cur) undoStack.push(cloneModel(cur));
      engine.setModel(cloneModel(next));
      await hydrateQrImages(engine, next);
      hydrateTextMath(engine, next);
      applySelection();
      await saveModel(next);
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
      (window as any).__ip_clipboard = getSelectedNodes().map((n) => JSON.parse(JSON.stringify(n)));
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "x") {
      (window as any).__ip_clipboard = getSelectedNodes().map((n) => JSON.parse(JSON.stringify(n)));
      await deleteSelection();
      ev.preventDefault();
      return;
    }

    if (ev.key === "Delete" || ev.key === "Backspace") {
      await deleteSelection();
      ev.preventDefault();
      return;
    }
  };

  window.addEventListener("keydown", onKey);

  // Composite edit mode (timer): allow editing sub-elements (labels/arrows) without opening the regular modal.
  let compositeEditTimerId: string | null = null;
  let compositeDrag:
    | null
    | {
        subId: string;
        startX: number;
        startY: number;
        startL: number;
        startT: number;
        box: DOMRect;
      } = null;

  const ensureTimerSubElements = (timerEl: HTMLElement) => {
    let layer = timerEl.querySelector<HTMLElement>(":scope .timer-sub-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "timer-sub-layer";
      layer.style.position = "absolute";
      layer.style.inset = "0";
      layer.style.pointerEvents = "auto";

      const mk = (id: string, text: string, leftPct: number, topPct: number) => {
        const d = document.createElement("div");
        d.className = "timer-sub timer-sub-text";
        d.dataset.subId = id;
        d.textContent = text;
        d.style.position = "absolute";
        d.style.left = `${leftPct}%`;
        d.style.top = `${topPct}%`;
        d.style.transform = "translate(-50%, -50%)";
        d.style.padding = "6px 8px";
        d.style.borderRadius = "10px";
        d.style.border = "1px solid rgba(255,255,255,0.14)";
        d.style.background = "rgba(0,0,0,0.22)";
        d.style.color = "rgba(255,255,255,0.92)";
        d.style.cursor = "grab";
        d.style.userSelect = "none";
        d.style.pointerEvents = "auto";
        return d;
      };

      layer.append(mk("x_label", "Time (s)", 52, 92), mk("y_label", "Procentage (%)", 10, 45));
      timerEl.append(layer);
    }
    return layer;
  };

  const enterTimerCompositeEdit = (timerId: string) => {
    compositeEditTimerId = timerId;
    clearSelection();
    const el = engine.getNodeElement(timerId);
    if (!el) return;
    // Remove regular selection handles while in composite editing.
    el.querySelector(".handles")?.remove();
    ensureTimerSubElements(el).style.display = "block";
  };

  const exitTimerCompositeEdit = () => {
    if (!compositeEditTimerId) return;
    const el = engine.getNodeElement(compositeEditTimerId);
    el?.querySelector<HTMLElement>(".timer-sub-layer")?.setAttribute("style", "display:none");
    compositeEditTimerId = null;
    compositeDrag = null;
  };

  stage.addEventListener("dblclick", async (ev) => {
    const target = ev.target as HTMLElement;
    const nodeEl = target.closest<HTMLElement>(".node");
    const id = nodeEl?.dataset.nodeId;
    if (!id) return;
    const model = engine.getModel();
    const node = model?.nodes.find((n) => n.id === id) as any;
    if (node?.type === "timer") {
      enterTimerCompositeEdit(id);
      ev.preventDefault();
      return;
    }
    await openEditorModal(id);
  });

  stage.addEventListener("pointerdown", (ev) => {
    if (!compositeEditTimerId) return;
    const t = ev.target as HTMLElement;
    const sub = t.closest<HTMLElement>(".timer-sub");
    if (!sub) return;
    const timerEl = engine.getNodeElement(compositeEditTimerId);
    if (!timerEl) return;
    const box = timerEl.getBoundingClientRect();
    const r = sub.getBoundingClientRect();
    compositeDrag = {
      subId: sub.dataset.subId ?? "",
      startX: ev.clientX,
      startY: ev.clientY,
      startL: (r.left + r.width / 2 - box.left) / box.width,
      startT: (r.top + r.height / 2 - box.top) / box.height,
      box
    };
    sub.style.cursor = "grabbing";
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });

  stage.addEventListener("pointermove", (ev) => {
    if (!compositeDrag || !compositeEditTimerId) return;
    const timerEl = engine.getNodeElement(compositeEditTimerId);
    if (!timerEl) return;
    const sub = timerEl.querySelector<HTMLElement>(`.timer-sub[data-sub-id="${compositeDrag.subId}"]`);
    if (!sub) return;
    const dx = (ev.clientX - compositeDrag.startX) / compositeDrag.box.width;
    const dy = (ev.clientY - compositeDrag.startY) / compositeDrag.box.height;
    const nx = Math.max(0, Math.min(1, compositeDrag.startL + dx));
    const ny = Math.max(0, Math.min(1, compositeDrag.startT + dy));
    sub.style.left = `${nx * 100}%`;
    sub.style.top = `${ny * 100}%`;
  });

  stage.addEventListener("pointerup", () => {
    if (!compositeDrag) return;
    const timerEl = compositeEditTimerId ? engine.getNodeElement(compositeEditTimerId) : null;
    const sub = timerEl?.querySelector<HTMLElement>(`.timer-sub[data-sub-id="${compositeDrag.subId}"]`);
    if (sub) sub.style.cursor = "grab";
    compositeDrag = null;
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") exitTimerCompositeEdit();
  });

  stage.addEventListener("pointerdown", (ev) => {
    const target = ev.target as HTMLElement;
    const anchorEl = target.closest<HTMLElement>(".anchor-dot");
    const handleEl = target.closest<HTMLElement>(".handle");
    const nodeEl = target.closest<HTMLElement>(".node");

    if (nodeEl?.dataset.nodeId) {
      const id = nodeEl.dataset.nodeId;

      // Anchor-dot should be a single click action (no extra click needed).
      // Do this BEFORE selection toggling (which may recreate handles).
      if (anchorEl?.dataset.anchor) {
        if (selected.size !== 1 || !selected.has(id)) {
          selectOne(id);
        }
        const model = engine.getModel();
        const node = model?.nodes.find((n) => n.id === id);
        if (!node) return;
        const before = model ? cloneModel(model) : null;

        const newAnchor = anchorEl.dataset.anchor;
        const t0 = node.transform;
        const tl0 = anchorToTopLeftWorld(t0);
        const rect = { x: tl0.x, y: tl0.y, w: t0.w, h: t0.h };
        const newPos = topLeftToAnchorWorld(rect, newAnchor);
        // IMPORTANT: clicking an anchor dot should ONLY change the anchor (no grid snapping).
        engine.updateNode(id, { transform: { ...t0, x: newPos.x, y: newPos.y, anchor: newAnchor } as any } as any);
        // Force immediate visual refresh of anchor dots (don't wait for the next render tick).
        const el = engine.getNodeElement(id);
        if (el) {
          el.dataset.anchor = newAnchor;
          ensureHandles(el); // will update current red anchor dot
        }
        applySelection();
        void commit(before);
        dragMode = "none";
        activeHandle = null;
        startNodesById = null;
        startSnapshot = null;
        ev.preventDefault();
        return;
      }

      if (ev.ctrlKey) toggleSelect(id);
      else if (ev.shiftKey) addSelect(id);
      else {
        // If you're already multi-selected and click-drag one of the selected nodes,
        // keep the selection (so the whole selection moves).
        if (!selected.has(id)) selectOne(id);
        else applySelection();
      }

      const model = engine.getModel();
      const node = model?.nodes.find((n) => n.id === id);
      if (!node) return;
      startSnapshot = model ? cloneModel(model) : null;
      startNodesById = {};
      for (const n of model?.nodes ?? []) {
        if (selected.has(n.id)) startNodesById[n.id] = JSON.parse(JSON.stringify(n));
      }
      start = { x: ev.clientX, y: ev.clientY };

      if (handleEl?.dataset.handle && selected.size === 1) {
        activeHandle = handleEl.dataset.handle;
        dragMode = activeHandle === "rot" ? "rotate" : "resize";
        if (dragMode === "rotate") {
          const r = nodeEl.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          startAngleRad = Math.atan2(ev.clientY - cy, ev.clientX - cx);
          startRotationDeg = node.transform.rotationDeg ?? 0;
        }
      } else {
        dragMode = "move";
      }

      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      return;
    }

    if (!ev.shiftKey && !ev.ctrlKey) clearSelection();
  });

  stage.addEventListener("pointermove", (ev) => {
    if (selected.size === 0 || dragMode === "none" || !startNodesById) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const cam = engine.getCamera();

    if (dragMode === "move") {
      for (const id of selected) {
        const s = startNodesById[id];
        if (!s) continue;
        const sp = s.space ?? "world";
        const ddx = sp === "world" ? dx / cam.zoom : dx;
        const ddy = sp === "world" ? dy / cam.zoom : dy;
        let nx = (s.transform?.x ?? 0) + ddx;
        let ny = (s.transform?.y ?? 0) + ddy;

        // Snap ONLY when Shift is held during dragging (requested).
        // Snap the anchor point (x,y) to active grid intersections for world-space nodes.
        if (ev.shiftKey && sp === "world") {
          const { spacing0, spacing1, t } = gridSpacingForZoom(cam.zoom);
          const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
          nx = Math.round(nx / snapSpacing) * snapSpacing;
          ny = Math.round(ny / snapSpacing) * snapSpacing;
        }

        engine.updateNode(id, { transform: { x: nx, y: ny } as any } as any);
      }
      return;
    }

    if (selected.size !== 1) return;
    const onlyId = Array.from(selected)[0];
    const startNode = startNodesById[onlyId];
    if (!startNode) return;
    const t0 = startNode.transform;

    if (dragMode === "rotate") {
      const el = engine.getNodeElement(onlyId);
      const r = el?.getBoundingClientRect();
      if (!r) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      const d = (a1 - startAngleRad) * (180 / Math.PI);
      let rot = startRotationDeg + d;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      engine.updateNode(onlyId, { transform: { rotationDeg: rot } as any } as any);
      return;
    }

    if (dragMode === "resize" && activeHandle) {
      const tl0 = anchorToTopLeftWorld(t0);
      let rect = { x: tl0.x, y: tl0.y, w: t0.w, h: t0.h };
      const ddx = dx / cam.zoom;
      const ddy = dy / cam.zoom;
      const min = 5;
      const isCorner =
        activeHandle === "nw" || activeHandle === "ne" || activeHandle === "sw" || activeHandle === "se";

      if (isCorner) {
        const sx = activeHandle.includes("w") ? -ddx : ddx;
        const sy = activeHandle.includes("n") ? -ddy : ddy;
        const w1 = Math.max(min, t0.w + sx);
        const h1 = Math.max(min, t0.h + sy);
        const s = Math.max(w1 / Math.max(1e-9, t0.w), h1 / Math.max(1e-9, t0.h));
        rect.w = Math.max(min, t0.w * s);
        rect.h = Math.max(min, t0.h * s);
        if (activeHandle.includes("w")) rect.x = tl0.x + (t0.w - rect.w);
        if (activeHandle.includes("n")) rect.y = tl0.y + (t0.h - rect.h);
      } else {
        // Edge handles: free resize
        if (activeHandle.includes("e")) rect.w = Math.max(min, t0.w + ddx);
        if (activeHandle.includes("s")) rect.h = Math.max(min, t0.h + ddy);
        if (activeHandle.includes("w")) {
          rect.x = tl0.x + ddx;
          rect.w = Math.max(min, t0.w - ddx);
        }
        if (activeHandle.includes("n")) {
          rect.y = tl0.y + ddy;
          rect.h = Math.max(min, t0.h - ddy);
        }
      }
      const anchored = topLeftToAnchorWorld(rect, t0.anchor);
      engine.updateNode(onlyId, { transform: { ...t0, x: anchored.x, y: anchored.y, w: rect.w, h: rect.h } as any } as any);
    }
  });

  stage.addEventListener("pointerup", async () => {
    dragMode = "none";
    activeHandle = null;
    startNodesById = null;
    await commit(startSnapshot);
    startSnapshot = null;
  });
}

async function main() {
  const { canvas, overlay, stage } = buildShell();
  const engine = new Engine({ canvas, overlayEl: overlay, hitTestEl: stage });
  engine.mount();

  if (DEBUG_ANIM) dlog("debugAnim=1 enabled");

  const model = await fetchModel();
  engine.setModel(model);
  dlog("loaded model", {
    views: model.views?.map((v) => ({ id: v.id, show: v.show?.slice?.(0, 50) })),
    animationCues: (model as any).animationCues
  });

  const viewsInOrder = model.views;
  let viewIdx = Math.max(0, viewsInOrder.findIndex((v) => v.id === model.initialViewId));
  let camTweenTimer: number | null = null;

  const DESIGN_H = (model as any).defaults?.designHeight ?? 1080;
  const toActualCamera = (c: { cx: number; cy: number; zoom: number }) => {
    // Treat model camera.zoom as a "zoom factor" relative to fitting the design viewport height.
    const scr = engine.getScreen();
    const fit = scr.h / DESIGN_H;
    return { cx: c.cx, cy: c.cy, zoom: c.zoom * fit };
  };

  const setView = (idx: number, animate: boolean) => {
    const prevIdx = viewIdx;
    viewIdx = Math.max(0, Math.min(viewsInOrder.length - 1, idx));
    const v = viewsInOrder[viewIdx];
    const prevView = viewsInOrder[prevIdx];
    if (!v) return;
    if (camTweenTimer != null) window.clearTimeout(camTweenTimer);
    camTweenTimer = null;

    if (!animate) {
      engine.setCamera(toActualCamera(v.camera));
      return;
    }

    // Transition rule:
    // - Always translate from old center -> new center.
    // - If we need to zoom out to fit BOTH the old view rect and new view rect on screen,
    //   do a two-stage zoom: out-to-fit-union, then in-to-target.
    // - If the new view is already "in view" (no union-fit zoom-out needed), just tween directly.
    // Manual pan/zoom must NOT affect which view is "next",
    // but the transition should start from the CURRENT camera (no snapping).
    const from = engine.getCamera();
    const to = toActualCamera(v.camera);
    const scr = engine.getScreen();

    const rectOf = (c: { cx: number; cy: number; zoom: number }) => {
      const hw = scr.w / 2 / c.zoom;
      const hh = scr.h / 2 / c.zoom;
      return { left: c.cx - hw, right: c.cx + hw, top: c.cy - hh, bottom: c.cy + hh };
    };

    const r0 = rectOf(from);
    const r1 = rectOf(to);
    const left = Math.min(r0.left, r1.left);
    const right = Math.max(r0.right, r1.right);
    const top = Math.min(r0.top, r1.top);
    const bottom = Math.max(r0.bottom, r1.bottom);
    const unionW = Math.max(1e-9, right - left);
    const unionH = Math.max(1e-9, bottom - top);
    const zoomToFitUnion = Math.min(scr.w / unionW, scr.h / unionH);

    const needZoomOut = zoomToFitUnion < Math.min(from.zoom, to.zoom) - 1e-6;
    const transitionMs = (v as any).transitionMs ?? (model as any).defaults?.viewTransitionMs ?? 4000;
    if (!needZoomOut) {
      engine.transitionToCamera(to, transitionMs);
      return;
    }

    const mid = { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, zoom: zoomToFitUnion };
    const half = Math.max(1, Math.floor(transitionMs / 2));
    engine.transitionToCamera(mid, half);
    camTweenTimer = window.setTimeout(() => engine.transitionToCamera(to, transitionMs - half), half);
  };
  setView(viewIdx, false);

  await hydrateQrImages(engine, model);
  hydrateTextMath(engine, model);
  ensureTimerPolling(engine, model, stage);

  // Mode toggle: Edit vs Live
  const modeWrap = document.createElement("div");
  modeWrap.className = "mode-toggle";
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  const modeHint = document.createElement("div");
  modeHint.className = "hint";
  modeWrap.append(modeBtn, modeHint);
  stage.appendChild(modeWrap);

  let detach: (() => void) | null = null;
  let mode: "edit" | "live" = (localStorage.getItem("ip_mode") as any) === "live" ? "live" : "edit";

  const applyMode = () => {
    localStorage.setItem("ip_mode", mode);
    modeBtn.textContent = mode === "edit" ? "Switch to Live" : "Switch to Edit";
    modeHint.textContent =
      mode === "live" ? "Live: left/right step, up/down view • editing disabled" : "Edit: drag/resize/rotate • double-click edit";

    detach?.();
    detach = null;

    if (mode === "edit") {
      engine.setPanZoomEnabled(true);
      engine.setAnimationsEnabled(false);
      // In edit, show everything in current view immediately.
      const v = viewsInOrder[viewIdx];
      const show = new Set(v?.show ?? []);
      for (const n of model.nodes) n.visible = show.has(n.id);
      engine.setModel(model);
      void hydrateQrImages(engine, model).then(() => hydrateTextMath(engine, model));
      ensureTimerPolling(engine, model, stage);
      attachEditor(stage, engine);
      return;
    }

    // Live mode:
    engine.setPanZoomEnabled(false);
    engine.setAnimationsEnabled(true);

    const allCues = (model as any).animationCues as Array<{ id: string; when: "enter" | "exit" }> | undefined;
    let showSet = new Set<string>();
    let cues: Array<{ id: string; when: "enter" | "exit" }> = [];

    const rebuildForCurrentView = () => {
      const vcur = viewsInOrder[viewIdx];
      showSet = new Set(vcur?.show ?? []);
      cues = (allCues ?? []).filter((c) => showSet.has(c.id));
    };
    rebuildForCurrentView();
    let cueIdx = 0;
    const pendingHide = new Map<string, number>();

    const clearPendingHide = (id: string) => {
      const t = pendingHide.get(id);
      if (t != null) window.clearTimeout(t);
      pendingHide.delete(id);
    };

    const hideWithOptionalExit = (id: string) => {
      const m = engine.getModel();
      const node = (m?.nodes.find((n) => n.id === id) as any) ?? null;
      const dis = node?.disappear;
      const el = engine.getNodeElement(id);
      clearPendingHide(id);
      dlog("hide", id, { hasExit: !!(dis && dis.kind && dis.kind !== "none"), disKind: dis?.kind });

      if (el && dis && dis.kind && dis.kind !== "none") {
        // Start exit animation; keep visible until finished, then hide.
        (el.dataset as any).exitStartMs = String(engine.getTimeMs());
        engine.updateNode(id, { visible: true } as any);

        const dur = Number(dis.durationMs ?? 0);
        const delay = Number(dis.delayMs ?? 0);
        const total = Math.max(0, delay + dur);
        const timeoutId = window.setTimeout(() => {
          engine.updateNode(id, { visible: false } as any);
          clearPendingHide(id);
        }, total);
        pendingHide.set(id, timeoutId);
      } else {
        engine.updateNode(id, { visible: false } as any);
      }
    };

    const showWithOptionalEnter = (id: string, restartEnter: boolean) => {
      clearPendingHide(id);
      engine.updateNode(id, { visible: true } as any);
      if (!restartEnter) return;
      const m = engine.getModel();
      const node = (m?.nodes.find((n) => n.id === id) as any) ?? null;
      const ap = node?.appear;
      const el = engine.getNodeElement(id);
      dlog("show", id, { restartEnter, hasEnter: !!(ap && ap.kind && ap.kind !== "none"), apKind: ap?.kind });
      if (el && ap && ap.kind && ap.kind !== "none") {
        delete (el.dataset as any).animInStartMs;
        delete (el.dataset as any).exitStartMs;
        // Reset pixelate latch so pixelate can replay when explicitly re-entered.
        delete (el.dataset as any).pixAnimStartMs;
        delete (el.dataset as any).pixAnimDone;
        // Hint the renderer to start pixelate as soon as the image is ready.
        if (ap.kind === "pixelate") (el.dataset as any).pixPending = "1";
      }
    };

    const applyBaseline = () => {
      rebuildForCurrentView();
      // Baseline: anything WITHOUT an enter cue is visible immediately.
      const enterIds = new Set(cues.filter((c) => c.when === "enter").map((c) => c.id));
      // Safety: if a node has appear spec (from animations.csv) but cue list is missing for any reason,
      // still treat it as an "enter-controlled" node.
      const m = engine.getModel();
      for (const n of m?.nodes ?? []) {
        const ap: any = (n as any).appear;
        if (showSet.has(n.id) && ap && ap.kind && ap.kind !== "none") enterIds.add(n.id);
      }

      for (const id of showSet) {
        engine.updateNode(id, { visible: !enterIds.has(id) } as any);
      }
      const m2 = engine.getModel();
      if (m2) void hydrateQrImages(engine, m2).then(() => hydrateTextMath(engine, m2));
    };

    const stepForward = () => {
      rebuildForCurrentView();
      if (cueIdx >= cues.length) return;
      const cue = cues[cueIdx++];
      dlog("cue forward", cueIdx - 1, cue);
      if (cue.when === "enter") {
        showWithOptionalEnter(cue.id, true);
      } else {
        hideWithOptionalExit(cue.id);
      }
    };

    const stepBack = () => {
      rebuildForCurrentView();
      if (cueIdx <= 0) return;
      const cue = cues[--cueIdx];
      dlog("cue back", cueIdx, cue);
      // Undo cue:
      if (cue.when === "enter") {
        // Remove what we previously entered.
        hideWithOptionalExit(cue.id);
      } else {
        // Restore what we previously exited.
        showWithOptionalEnter(cue.id, true);
      }
    };

    // Start at baseline; cues then drive changes.
    cueIdx = 0;
    applyBaseline();

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onMouseDown = (e: MouseEvent) => {
      // left click = back, right click = forward
      if (e.button === 0) {
        stepBack();
      } else if (e.button === 2) {
        stepForward();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepForward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepBack();
      } else if (e.key === "ArrowDown") {
        dlog("nav down", { from: viewsInOrder[viewIdx]?.id, to: viewsInOrder[Math.min(viewsInOrder.length - 1, viewIdx + 1)]?.id });
        setView(viewIdx + 1, true);
        // reset baseline+cue index for the new view
        cueIdx = 0;
        applyBaseline();
      } else if (e.key === "ArrowUp") {
        dlog("nav up", { from: viewsInOrder[viewIdx]?.id, to: viewsInOrder[Math.max(0, viewIdx - 1)]?.id });
        setView(viewIdx - 1, true);
        cueIdx = 0;
        applyBaseline();
      }
    };

    stage.addEventListener("contextmenu", onContextMenu);
    stage.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    detach = () => {
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  };

  modeBtn.addEventListener("click", () => {
    mode = mode === "edit" ? "live" : "edit";
    applyMode();
  });

  applyMode();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  const app = document.querySelector<HTMLDivElement>("#app");
  if (app) app.textContent = String(err);
});


