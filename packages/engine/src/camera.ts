export interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

export interface ScreenSize {
  w: number;
  h: number;
}

export function worldToScreen(p: { x: number; y: number }, camera: Camera, screen: ScreenSize) {
  return {
    x: (p.x - camera.cx) * camera.zoom + screen.w / 2,
    y: (p.y - camera.cy) * camera.zoom + screen.h / 2
  };
}

export function screenToWorld(p: { x: number; y: number }, camera: Camera, screen: ScreenSize) {
  return {
    x: (p.x - screen.w / 2) / camera.zoom + camera.cx,
    y: (p.y - screen.h / 2) / camera.zoom + camera.cy
  };
}

export function clampZoom(z: number) {
  return Math.max(0.02, Math.min(40, z));
}


