import type { Store } from "../core/store";
import QRCode from "qrcode";
import { activeView, fitCameraToScreen } from "../core/store";
import { anchorOffsetPx, worldToScreen } from "../core/geom";
import type { Node } from "../core/model";
import { renderTextWithKatexToHtmlCached } from "./textMath";
import { isNodeInteractiveInMode } from "../core/mode";

type DomNodeHandle = { id: string; el: HTMLElement; update: () => void; destroy: () => void };

export type Scene = {
  overlay: HTMLElement;
  domNodes: Map<string, DomNodeHandle>;
};

let colorProbe: HTMLElement | null = null;
const colorCache = new Map<string, string>();
const qrCache = new Map<string, string>();
const qrPending = new Map<string, Promise<string>>();

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

const applyBackground = (el: HTMLElement, colorRaw: string | undefined, alphaRaw: number | undefined) => {
  const color = String(colorRaw ?? "").trim();
  if (!color) {
    el.style.backgroundColor = "transparent";
    return;
  }
  const alphaVal = Number(alphaRaw);
  if (!Number.isFinite(alphaVal)) {
    el.style.backgroundColor = color;
    return;
  }
  const alpha = Math.max(0, Math.min(1, alphaVal > 1 ? alphaVal / 255 : alphaVal));
  const parsed = parseRgb(color) ?? parseRgb(resolveRgb(color));
  if (!parsed) {
    el.style.backgroundColor = color;
    return;
  }
  el.style.backgroundColor = `rgba(${toByte(parsed.r)}, ${toByte(parsed.g)}, ${toByte(parsed.b)}, ${alpha})`;
};

export function createScene(overlay: HTMLElement): Scene {
  return { overlay, domNodes: new Map() };
}

export function renderScene(scene: Scene, store: Store, screen: { w: number; h: number }, timeMs: number) {
  const view = activeView(store);
  const cam = store.cameraOverride ?? fitCameraToScreen(view.camera, store);
  const selectedSet = new Set(store.selectedIds ?? []);
  const byId = new Set(store.model.nodes.map((n) => n.id));

  // remove stale
  for (const [id, h] of Array.from(scene.domNodes.entries())) {
    if (!byId.has(id)) {
      h.destroy();
      scene.domNodes.delete(id);
    }
  }

  const isVisibleInLive = (node: Node) => {
    if (store.mode !== "live") return true;
    if (node.space === "screen") return true;
    const nodeView = (node as any).viewId;
    if (store.cameraTween && store.transitionFromViewId && store.transitionToViewId) {
      return nodeView === store.transitionFromViewId || nodeView === store.transitionToViewId;
    }
    if (nodeView != null) return nodeView === view.id;
    return true;
  };

  for (const node of store.model.nodes) {
    if (!isVisibleInLive(node)) continue;
    let handle = scene.domNodes.get(node.id);
    const ensureNodeElement = () => {
      const el = document.createElement("div");
      el.classList.add("node");
      el.dataset.nodeId = node.id;
      el.dataset.nodeType = node.type;
      el.dataset.nodeSpace = node.space;
      if ((node as any).layer) el.dataset.nodeLayer = String((node as any).layer);
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
      } else if (node.type === "join") {
        el.classList.add("node-join");
        const qr = document.createElement("img");
        qr.className = "node-join-qr";
        qr.decoding = "async";
        qr.loading = "eager";
        qr.alt = "Join QR";
        qr.draggable = false;
        el.appendChild(qr);
      } else if (node.type === "image") {
        el.classList.add("node-image");
        const img = document.createElement("img");
        img.className = "node-image-content";
        img.decoding = "async";
        img.loading = "eager";
        img.draggable = false;
        el.appendChild(img);
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
    handle.el.classList.toggle("is-selected", isSelected);
    const disableInMode = store.mode !== "live" && !isNodeInteractiveInMode(store.mode, node);
    handle.el.classList.toggle("is-disabled", disableInMode);
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

  const applyBox = () => {
    const isWorld = node.space === "world";
    const wPx = isWorld ? node.transform.w * camera.zoom : node.transform.w * screen.w;
    const hPx = isWorld ? node.transform.h * camera.zoom : node.transform.h * screen.h;
    const p = isWorld
      ? worldToScreen({ x: node.transform.x, y: node.transform.y }, camera, screen)
      : {
          // Screen-space uses relative coordinates (0..1), authored with origin at bottom-left.
          x: node.transform.x * screen.w,
          y: (1 - node.transform.y) * screen.h,
        };
    const { dx, dy } = anchorOffsetPx(node.transform.anchor, wPx, hPx);
    el.style.left = `${p.x + dx}px`;
    el.style.top = `${p.y + dy}px`;
    el.style.width = `${wPx}px`;
    el.style.height = `${hPx}px`;
  };
  applyBox();
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
    const wPx = node.space === "world" ? node.transform.w * camera.zoom : node.transform.w * screen.w;
    const hPx = node.space === "world" ? node.transform.h * camera.zoom : node.transform.h * screen.h;
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
      const wPx = node.space === "world" ? node.transform.w * camera.zoom : node.transform.w * screen.w;
      const hPx = node.space === "world" ? node.transform.h * camera.zoom : node.transform.h * screen.h;
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
    el.style.fontSize = `${Math.max(1, node.space === "world" ? node.fontPx * camera.zoom : node.fontPx)}px`;
    el.style.lineHeight = "1.15";
    const align = ((anyNode.align ?? "center") as string).toLowerCase() as "left" | "center" | "right";
    const justify =
      align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    content.style.display = "flex";
    content.style.alignItems = "center";
    content.style.justifyContent = justify;
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
    if (editing) {
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
      const effectiveZoom = isScreen ? 1 : Math.max(camera.zoom, 1 / fontPx);
      const needW = isScreen ? needWpx / screenW : needWpx / effectiveZoom;
      const needH = isScreen ? needHpx / screenH : needHpx / effectiveZoom;
      const epsW = isScreen ? 2 / screenW : 2 / effectiveZoom;
      const epsH = isScreen ? 2 / screenH : 2 / effectiveZoom;

      const w0 = node.transform.w;
      const h0 = node.transform.h;

      // Grow always when too small.
      if (needW > node.transform.w + epsW) node.transform.w = needW;
      if (needH > node.transform.h + epsH) node.transform.h = needH;

      // When selected, also allow shrinking back to tight bounds.
      // (This fixes "zoom out -> box expands -> zoom in -> box not tight".)
      const isSelected = el.classList.contains("is-selected");
      if (isSelected) {
        if (needW < node.transform.w - epsW * 2) node.transform.w = Math.max(isScreen ? 1 / screenW : 1, needW);
        if (needH < node.transform.h - epsH * 2) node.transform.h = Math.max(isScreen ? 1 / screenH : 1, needH);
      }

      // IMPORTANT: apply box immediately if we changed size this tick,
      // so selection outline never renders at the stale (too large) size.
      if (node.transform.w !== w0 || node.transform.h !== h0) applyBox();
    }
  }
  if (node.type === "bullets") {
    const content = el.querySelector<HTMLElement>(".node-bullets-content");
    if (!content) throw new Error("[next] bullets node missing content wrapper");
    const fontPx = Math.max(1, (node as any).fontPx ?? 16);
    el.style.color = String((node as any).color ?? "rgba(255,255,255,0.92)");
    el.style.fontSize = `${Math.max(1, node.space === "world" ? fontPx * camera.zoom : fontPx)}px`;
    el.style.lineHeight = "1.2";
    const raw = String((node as any).rawText ?? "");
    const items = (node as any).items as Array<{ text: string; indent: number }> | undefined;
    const bulletsSpec = String((node as any).bullets ?? "1.a.");
    const align = ((anyNode.align ?? "center") as string).toLowerCase() as "left" | "center" | "right";
    const alignSelf =
      align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    if (
      (content.dataset as any).rawText !== raw ||
      (content.dataset as any).align !== align ||
      !content.childElementCount
    ) {
      (content.dataset as any).rawText = raw;
      (content.dataset as any).align = align;
      content.replaceChildren(
        ...renderBulletLines(items ?? [], bulletsSpec, node.space === "screen" ? 16 : 20, align, alignSelf)
      );
    }
    const editing = (el.dataset as any).editing === "1";
    if (editing) {
      // Auto-resize like text nodes (only while editing).
      const padPx = 0;
      const needWpx = Math.ceil(content.scrollWidth + padPx * 2);
      const needHpx = Math.ceil(content.scrollHeight + padPx * 2);
      const isScreen = node.space === "screen";
      const screenW = Math.max(1e-9, screen.w);
      const screenH = Math.max(1e-9, screen.h);
      const effectiveZoom = isScreen ? 1 : Math.max(camera.zoom, 1 / fontPx);
      const needW = isScreen ? needWpx / screenW : needWpx / effectiveZoom;
      const needH = isScreen ? needHpx / screenH : needHpx / effectiveZoom;
      const epsW = isScreen ? 2 / screenW : 2 / effectiveZoom;
      const epsH = isScreen ? 2 / screenH : 2 / effectiveZoom;
      const w0 = node.transform.w;
      const h0 = node.transform.h;
      if (needW > node.transform.w + epsW) node.transform.w = needW;
      if (needH > node.transform.h + epsH) node.transform.h = needH;
      const isSelected = el.classList.contains("is-selected");
      if (isSelected) {
        if (needW < node.transform.w - epsW * 2) node.transform.w = Math.max(isScreen ? 1 / screenW : 1, needW);
        if (needH < node.transform.h - epsH * 2) node.transform.h = Math.max(isScreen ? 1 / screenH : 1, needH);
      }
      if (node.transform.w !== w0 || node.transform.h !== h0) applyBox();
    }
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha);
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
    const isWorld = node.space === "world";
    const sScreen = isWorld ? worldToScreen(start, camera, screen) : { x: start.x * screen.w, y: (1 - start.y) * screen.h };
    const eScreen = isWorld ? worldToScreen(end, camera, screen) : { x: end.x * screen.w, y: (1 - end.y) * screen.h };
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
  }
  if (node.type === "join") {
    const qr = el.querySelector<HTMLImageElement>(".node-join-qr");
    if (!qr) throw new Error("[next] join node missing qr img");
    const joinId = String((node as any).id ?? "");
    const base = String((store.model as any).defaults?.publicBaseUrl ?? window.location.origin).replace(/\/$/, "");
    const url = `${base}/join/${encodeURIComponent(joinId)}`;
    const cached = qrCache.get(url);
    if (cached) {
      if (qr.dataset.src !== cached) {
        qr.dataset.src = cached;
        qr.src = cached;
      }
    } else if (!qrPending.has(url)) {
      const pending = QRCode.toDataURL(url, {
        margin: 1,
        width: 512,
        color: { dark: "#000000ff", light: "#ffffffff" },
      }).then((data: string) => {
        qrCache.set(url, data);
        return data;
      });
      qrPending.set(url, pending);
      pending.then((data: string) => {
        if (qrCache.get(url) === data) {
          qr.dataset.src = data;
          qr.src = data;
        }
        qrPending.delete(url);
      }).catch(() => {
        qrPending.delete(url);
      });
    }
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha);
  }
  if (node.type === "image") {
    const img = el.querySelector<HTMLImageElement>(".node-image-content");
    if (!img) throw new Error("[next] image node missing img element");
    const src = String((node as any).src ?? "");
    if (img.dataset.src !== src) {
      img.dataset.src = src;
      img.src = src;
    }
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha);
  }
  if (node.type === "text") {
    applyBackground(el, (node as any).bgColor, (node as any).bgAlpha);
  }
}

function renderBulletLines(
  items: Array<{ text: string; indent: number }>,
  specRaw: string,
  indentPx: number,
  align: "left" | "center" | "right",
  alignSelf: "flex-start" | "center" | "flex-end"
): HTMLElement[] {
  const spec = specRaw.trim();
  if (!spec) return items.map((item) => renderBulletLine(item, "", indentPx, align, alignSelf));
  const unordered = spec.length === 1 && ["-", ".", ">"].includes(spec);
  if (unordered) {
    const glyph = spec === "-" ? "–" : spec === ">" ? "›" : "•";
    return items.map((item) => renderBulletLine(item, glyph, indentPx, align, alignSelf));
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
    return renderBulletLine(item, label, indentPx, align, alignSelf);
  });
}

function renderBulletLine(
  item: { text: string; indent: number },
  label: string,
  indentPx: number,
  align: "left" | "center" | "right",
  alignSelf: "flex-start" | "center" | "flex-end"
) {
  const row = document.createElement("div");
  row.className = "node-bullets-line";
  row.style.paddingLeft = `${Math.max(0, item.indent || 0) * indentPx}px`;
  row.style.alignSelf = "stretch";
  row.style.width = "100%";
  row.style.textAlign = align;
  row.textContent = label ? `${label} ${item.text}` : item.text;
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

