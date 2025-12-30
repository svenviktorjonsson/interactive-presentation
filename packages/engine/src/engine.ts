import type { PresentationModel } from "@interactive/content";
import type { DomNodeHandle } from "./renderer/domNodes";
import { createDomNode, layoutDomNodes } from "./renderer/domNodes";
import { clampZoom, screenToWorld } from "./camera";

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  overlayEl: HTMLElement;
  hitTestEl?: HTMLElement;
}

export class Engine {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlayEl: HTMLElement;
  private readonly hitTestEl: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;

  private model: PresentationModel | null = null;
  private domNodes = new Map<string, DomNodeHandle>();

  private camera = { cx: 0, cy: 0, zoom: 1 };
  private screen = { w: 0, h: 0 };

  private isPanning = false;
  private lastPointer: { x: number; y: number } | null = null;
  private startedAtMs = 0;
  private panZoomEnabled = true;
  private animationsEnabled = true;

  private cameraTween:
    | null
    | {
        startMs: number;
        durationMs: number;
        from: { cx: number; cy: number; zoom: number };
        to: { cx: number; cy: number; zoom: number };
      } = null;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.overlayEl = opts.overlayEl;
    this.hitTestEl = opts.hitTestEl ?? opts.canvas;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context not available");
    this.ctx = ctx;

    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  mount() {
    this.startedAtMs = performance.now();
    window.addEventListener("resize", this.handleResize);
    this.hitTestEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.hitTestEl.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.handleResize();
    requestAnimationFrame(this.tick);
  }

  unmount() {
    window.removeEventListener("resize", this.handleResize);
    this.hitTestEl.removeEventListener("wheel", this.onWheel);
    this.hitTestEl.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
  }

  setModel(model: PresentationModel) {
    this.model = model;
    // Create DOM handles for screen-space nodes (text etc.)
    this.domNodes.clear();
    this.overlayEl.innerHTML = "";
    for (const node of model.nodes) {
      const handle = createDomNode(node);
      if (handle) this.domNodes.set(node.id, handle);
    }
  }

  getModel() {
    return this.model;
  }

  getCamera() {
    return { ...this.camera };
  }

  getScreen() {
    return { ...this.screen };
  }

  getTimeMs() {
    return performance.now() - this.startedAtMs;
  }

  getNodeElement(id: string): HTMLElement | null {
    return this.domNodes.get(id)?.el ?? null;
  }

  updateNode(id: string, patch: Partial<PresentationModel["nodes"][number]>) {
    if (!this.model) return;
    const idx = this.model.nodes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    // Shallow merge + deep merge transform
    const prev = this.model.nodes[idx] as any;
    const next: any = { ...prev, ...patch };
    if (patch && (patch as any).transform) {
      next.transform = { ...(prev.transform ?? {}), ...(patch as any).transform };
    }
    this.model.nodes[idx] = next;
  }

  setCamera(camera: { cx: number; cy: number; zoom: number }) {
    // If we're snapping the camera, cancel any in-flight transition tween.
    this.cameraTween = null;
    this.camera = { ...camera, zoom: clampZoom(camera.zoom) };
  }

  setPanZoomEnabled(enabled: boolean) {
    this.panZoomEnabled = enabled;
  }

  setAnimationsEnabled(enabled: boolean) {
    this.animationsEnabled = enabled;
  }

  transitionToCamera(to: { cx: number; cy: number; zoom: number }, durationMs = 850) {
    this.cameraTween = {
      startMs: performance.now(),
      durationMs,
      from: { ...this.camera },
      to: { ...to, zoom: clampZoom(to.zoom) }
    };
  }

  private handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.screen = { w: rect.width, h: rect.height };
  }

  private onWheel(ev: WheelEvent) {
    if (!this.panZoomEnabled) return;
    ev.preventDefault();

    const r = this.hitTestEl.getBoundingClientRect();
    const mouse = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const before = screenToWorld(mouse, this.camera, this.screen);

    const zoomFactor = Math.exp(-ev.deltaY * 0.0012);
    const nextZoom = clampZoom(this.camera.zoom * zoomFactor);
    this.camera.zoom = nextZoom;

    const after = screenToWorld(mouse, this.camera, this.screen);
    // Keep the world point under the cursor stable:
    this.camera.cx += before.x - after.x;
    this.camera.cy += before.y - after.y;
  }

  private onPointerDown(ev: PointerEvent) {
    if (ev.button !== 0) return;
    if (!this.panZoomEnabled) return;
    // If the user is manipulating a node/handle, do not start panning.
    const t = ev.target as Element | null;
    if (
      t?.closest(".node") ||
      t?.closest(".handle") ||
      t?.closest(".modal") ||
      t?.closest(".fs-prompt") ||
      t?.closest(".mode-toggle")
    )
      return;
    this.isPanning = true;
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    try {
      (this.hitTestEl as any).setPointerCapture?.(ev.pointerId);
    } catch {
      // ignore
    }
  }

  private onPointerMove(ev: PointerEvent) {
    if (!this.isPanning || !this.lastPointer) return;
    const dx = ev.clientX - this.lastPointer.x;
    const dy = ev.clientY - this.lastPointer.y;
    this.lastPointer = { x: ev.clientX, y: ev.clientY };

    // Pan camera by screen delta (convert to world delta)
    this.camera.cx -= dx / this.camera.zoom;
    this.camera.cy -= dy / this.camera.zoom;
  }

  private onPointerUp() {
    this.isPanning = false;
    this.lastPointer = null;
  }

  private tick() {
    this.draw();
    requestAnimationFrame(this.tick);
  }

  private smoothstep(edge0: number, edge1: number, x: number) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  private drawGridLayer(spacingWorld: number, alpha: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;

    const leftWorld = this.camera.cx - this.screen.w / 2 / this.camera.zoom;
    const rightWorld = this.camera.cx + this.screen.w / 2 / this.camera.zoom;
    const topWorld = this.camera.cy - this.screen.h / 2 / this.camera.zoom;
    const botWorld = this.camera.cy + this.screen.h / 2 / this.camera.zoom;

    const x0 = Math.floor(leftWorld / spacingWorld) * spacingWorld;
    const y0 = Math.floor(topWorld / spacingWorld) * spacingWorld;

    for (let x = x0; x <= rightWorld; x += spacingWorld) {
      const sx = (x - this.camera.cx) * this.camera.zoom + this.screen.w / 2;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.screen.h);
      ctx.stroke();
    }

    for (let y = y0; y <= botWorld; y += spacingWorld) {
      const sy = (y - this.camera.cy) * this.camera.zoom + this.screen.h / 2;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(this.screen.w, sy);
      ctx.stroke();
    }

    ctx.restore();
  }

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.screen.w, this.screen.h);

    // Camera tween
    if (this.cameraTween) {
      const now = performance.now();
      const t = (now - this.cameraTween.startMs) / this.cameraTween.durationMs;
      const p = Math.max(0, Math.min(1, t));
      // Cosine-squared blend:
      // value = A*cos^2(pi*x/2) + B*sin^2(pi*x/2), x in [0,1]
      // Equivalent weight for B: w = sin^2(pi*x/2)
      const s = Math.sin((Math.PI * p) / 2);
      const w = s * s;
      this.camera = {
        cx: this.cameraTween.from.cx * (1 - w) + this.cameraTween.to.cx * w,
        cy: this.cameraTween.from.cy * (1 - w) + this.cameraTween.to.cy * w,
        zoom: this.cameraTween.from.zoom * (1 - w) + this.cameraTween.to.zoom * w
      };
      if (p >= 1) this.cameraTween = null;
    }

    // Minimal background grid (world space) to make pan/zoom feel real.
    {
      const baseWorld = 100;
      const logz = Math.log10(Math.max(1e-9, this.camera.zoom));
      const n = Math.floor(logz);
      const frac = logz - n;
      const t = this.smoothstep(0.25, 0.75, frac);

      const spacing0 = baseWorld / Math.pow(10, n);
      const spacing1 = baseWorld / Math.pow(10, n + 1);

      // Fade between grids around each decade transition.
      const baseAlpha = 0.28;
      this.drawGridLayer(spacing0, baseAlpha * (1 - t));
      this.drawGridLayer(spacing1, baseAlpha * t);
    }

    if (!this.model) return;

    // Screen-space DOM nodes
    layoutDomNodes({
      model: this.model,
      domNodes: this.domNodes,
      overlayEl: this.overlayEl,
      camera: this.camera,
      screen: this.screen,
      timeMs: performance.now() - this.startedAtMs,
      animationsEnabled: this.animationsEnabled
    });
  }
}


