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

export function viewRect(camera: { cx: number; cy: number; zoom: number }): {
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
} {
  const zoom = Math.max(1e-9, camera.zoom || 1);
  const width = 1 / zoom;
  const height = 1 / zoom;
  const left = camera.cx - width / 2;
  const top = camera.cy - height / 2;
  return { left, top, width, height, zoom };
}

export function worldToView(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number }
): { x: number; y: number } {
  const { left, top, width, height } = viewRect(camera);
  return {
    x: (p.x - left) / width,
    y: (p.y - top) / height,
  };
}

export function viewToWorld(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number }
): { x: number; y: number } {
  const { left, top, width, height } = viewRect(camera);
  return {
    x: left + p.x * width,
    y: top + p.y * height,
  };
}

export function worldRectToViewRect(
  r: { x: number; y: number; w: number; h: number },
  camera: { cx: number; cy: number; zoom: number }
): { x: number; y: number; w: number; h: number } {
  const { left, top, width, height } = viewRect(camera);
  return {
    x: (r.x - left) / width,
    y: (r.y - top) / height,
    w: r.w / width,
    h: r.h / height,
  };
}

export function worldToScreenScale(
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { x: number; y: number } {
  const { zoom } = viewRect(camera);
  return { x: zoom * screen.w, y: zoom * screen.h };
}

export function cameraForScreenPan(
  startWorld: { x: number; y: number },
  screenPos: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { cx: number; cy: number; zoom: number } {
  const { width, height, zoom } = viewRect(camera);
  const scaleX = screen.w / Math.max(1e-9, width);
  const scaleY = screen.h / Math.max(1e-9, height);
  const left = startWorld.x - screenPos.x / Math.max(1e-9, scaleX);
  const top = startWorld.y - screenPos.y / Math.max(1e-9, scaleY);
  return { cx: left + width / 2, cy: top + height / 2, zoom };
}

export function worldToScreen(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { x: number; y: number } {
  // World-space: normalized to view rect [0..1], origin at top-left, +y down.
  const { left, top, width, height } = viewRect(camera);
  return {
    x: ((p.x - left) / width) * screen.w,
    y: ((p.y - top) / height) * screen.h,
  };
}

export function screenToWorld(
  p: { x: number; y: number },
  camera: { cx: number; cy: number; zoom: number },
  screen: { w: number; h: number }
): { x: number; y: number } {
  const { left, top, width, height } = viewRect(camera);
  return {
    x: left + (p.x / Math.max(1e-9, screen.w)) * width,
    y: top + (p.y / Math.max(1e-9, screen.h)) * height,
  };
}

