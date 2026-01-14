import type { Anchor } from "./model";

export function anchorOffsetPx(anchor: Anchor, wPx: number, hPx: number): { dx: number; dy: number } {
  switch (anchor) {
    case "topLeft":
      return { dx: 0, dy: 0 };
    case "topCenter":
      return { dx: -wPx / 2, dy: 0 };
    case "topRight":
      return { dx: -wPx, dy: 0 };
    case "centerLeft":
      return { dx: 0, dy: -hPx / 2 };
    case "centerCenter":
      return { dx: -wPx / 2, dy: -hPx / 2 };
    case "centerRight":
      return { dx: -wPx, dy: -hPx / 2 };
    case "bottomLeft":
      return { dx: 0, dy: -hPx };
    case "bottomCenter":
      return { dx: -wPx / 2, dy: -hPx };
    case "bottomRight":
      return { dx: -wPx, dy: -hPx };
    default:
      return { dx: -wPx / 2, dy: -hPx / 2 };
  }
}

export function anchorOffsetWorld(anchor: Anchor, w: number, h: number): { dx: number; dy: number } {
  // Same as px version but in world units.
  return anchorOffsetPx(anchor, w, h);
}

export function worldToScreen(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { x: number; y: number } {
  return {
    x: (p.x - camera.cx) * camera.zoom + screen.w / 2,
    y: (p.y - camera.cy) * camera.zoom + screen.h / 2,
  };
}

export function screenToWorld(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { x: number; y: number } {
  return {
    x: (p.x - screen.w / 2) / camera.zoom + camera.cx,
    y: (p.y - screen.h / 2) / camera.zoom + camera.cy,
  };
}

