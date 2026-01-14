import type { Store } from "../core/store";
import { activeView } from "../core/store";
import { anchorOffsetPx, worldToScreen } from "../core/geom";
import type { Node } from "../core/model";
import { renderTextWithKatexToHtml } from "./textMath";

type DomNodeHandle = { id: string; el: HTMLElement; update: () => void; destroy: () => void };

export type Scene = {
  overlay: HTMLElement;
  domNodes: Map<string, DomNodeHandle>;
};

export function createScene(overlay: HTMLElement): Scene {
  return { overlay, domNodes: new Map() };
}

export function renderScene(scene: Scene, store: Store, screen: { w: number; h: number }) {
  const cam = activeView(store).camera;
  const byId = new Set(store.model.nodes.map((n) => n.id));

  // remove stale
  for (const [id, h] of Array.from(scene.domNodes.entries())) {
    if (!byId.has(id)) {
      h.destroy();
      scene.domNodes.delete(id);
    }
  }

  for (const node of store.model.nodes) {
    if (!node.visible) continue;
    let handle = scene.domNodes.get(node.id);
    if (!handle) {
      const el = document.createElement("div");
      el.classList.add("node");
      el.dataset.nodeId = node.id;
      el.dataset.nodeType = node.type;
      if (node.type === "text") {
        el.classList.add("node-text");
        const content = document.createElement("div");
        content.className = "node-text-content";
        const inner = document.createElement("div");
        inner.className = "node-text-inner";
        content.appendChild(inner);
        el.appendChild(content);
      }
      scene.overlay.appendChild(el);
      handle = { id: node.id, el, update: () => {}, destroy: () => el.remove() };
      scene.domNodes.set(node.id, handle);
    }

    handle.update = () => updateNodeDom(handle!.el, node, cam, screen);
    handle.update();
    handle.el.classList.toggle("is-selected", store.selectedId === node.id);
  }
}

function updateNodeDom(
  el: HTMLElement,
  node: Node,
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
) {
  el.style.opacity = String(node.opacity ?? 1);
  el.style.display = node.visible === false ? "none" : "block";
  el.style.zIndex = String((node as any).zIndex ?? 0);

  if (node.space !== "world") return;
  const wPx = node.transform.w * camera.zoom;
  const hPx = node.transform.h * camera.zoom;
  const p = worldToScreen({ x: node.transform.x, y: node.transform.y }, camera, screen);
  const { dx, dy } = anchorOffsetPx(node.transform.anchor, wPx, hPx);

  el.style.left = `${p.x + dx}px`;
  el.style.top = `${p.y + dy}px`;
  el.style.width = `${wPx}px`;
  el.style.height = `${hPx}px`;
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

  if (node.type === "text") {
    // IMPORTANT: never overwrite `el.innerHTML` here (it would delete selection handles).
    const content = el.querySelector<HTMLElement>(".node-text-content");
    const inner = el.querySelector<HTMLElement>(".node-text-inner");
    if (!content || !inner) throw new Error("[next] text node missing content wrappers");

    el.style.color = node.color;
    el.style.fontSize = `${Math.max(1, node.fontPx * camera.zoom)}px`;
    el.style.lineHeight = "1.15";

    const raw = String(node.text ?? "");
    if ((el.dataset as any).rawText !== raw) {
      (el.dataset as any).rawText = raw;
      inner.innerHTML = renderTextWithKatexToHtml(raw);
    }

    // Default behavior: bounding box should include all rendered text.
    // If content doesn't fit, grow the world-space transform.
    const padPx = 12;
    // IMPORTANT:
    // Do NOT use getBoundingClientRect() here: it changes under rotation (axis-aligned bbox),
    // which causes flicker/jumps during rotation. scrollWidth/scrollHeight are rotation-invariant.
    const needWpx = Math.ceil(inner.scrollWidth + padPx * 2);
    const needHpx = Math.ceil(inner.scrollHeight + padPx * 2);
    // Hysteresis: only grow when we're meaningfully too small.
    if (needWpx > wPx + 2 || needHpx > hPx + 2) {
      node.transform.w = Math.max(node.transform.w, needWpx / camera.zoom);
      node.transform.h = Math.max(node.transform.h, needHpx / camera.zoom);
    }
  }
}

