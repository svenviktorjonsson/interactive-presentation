import type { PresentationModel } from "@interactive/content";
import type { DomNodeHandle } from "./renderer/domNodes";
import { createDomNode, layoutDomNodes } from "./renderer/domNodes";
import { clampZoom, screenToWorld, worldToScreen } from "./camera";

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
    // While in composite/group edit mode, the app layer owns pointer routing (select/drag/pan).
    // Letting the engine also start a camera pan here causes "drag looks like pan" conflicts.
    if ((window as any).__ip_compositeEditing) return;
    // If the user is manipulating a node/handle, do not start panning.
    const t = ev.target as Element | null;
    if (
      t?.closest(".node") ||
      // Composite/group edit sub-elements live outside the `.node` subtree in some cases
      // and must behave like normal draggable elements (i.e. do not start background pan).
      t?.closest(".comp-sub") ||
      t?.closest(".ip-composite-selection") ||
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
    try {
      this.draw();
    } catch (err) {
      // Fail loudly: a render-loop exception otherwise looks like "loading forever".
      // eslint-disable-next-line no-console
      console.error("[ip] render loop crashed", err);
      try {
        this.overlayEl.innerText = `Render error: ${String(err)}`;
        (this.overlayEl.style as any).color = "white";
        this.overlayEl.style.padding = "16px";
        this.overlayEl.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace";
        this.overlayEl.style.whiteSpace = "pre-wrap";
        this.overlayEl.style.background = "rgba(120, 20, 20, 0.65)";
      } catch {
        // ignore
      }
      return;
    }
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

  /**
   * Render arrow/line nodes onto the canvas (pixel-perfect).
   * DOM nodes still exist for selection + handles; this is visuals only.
   */
  private drawSegmentsLayer() {
    const model = this.model;
    if (!model) return;
    const ctx = this.ctx;

    const anchorOffsetPx = (anchor: string | undefined, wPx: number, hPx: number) => {
      switch (anchor) {
        case "center":
        case "centerCenter":
          return { dx: -wPx / 2, dy: -hPx / 2 };
        case "top":
        case "topCenter":
          return { dx: -wPx / 2, dy: 0 };
        case "bottom":
        case "bottomCenter":
          return { dx: -wPx / 2, dy: -hPx };
        case "left":
        case "centerLeft":
          return { dx: 0, dy: -hPx / 2 };
        case "right":
        case "centerRight":
          return { dx: -wPx, dy: -hPx / 2 };
        case "topRight":
          return { dx: -wPx, dy: 0 };
        case "bottomLeft":
          return { dx: 0, dy: -hPx };
        case "bottomRight":
          return { dx: -wPx, dy: -hPx };
        case "topLeft":
        default:
          return { dx: 0, dy: 0 };
      }
    };

    // Parent/group transforms: mirror the resolver from layoutDomNodes.
    const byId = new Map((model.nodes as any[]).map((n) => [n.id, n]));
    const memoWorld = new Map<string, any>();
    const resolving = new Set<string>();
    const resolveWorldTransform = (node: any): any => {
      if (!node || node.space !== "world") return node?.transform;
      if (memoWorld.has(node.id)) return memoWorld.get(node.id);
      if (resolving.has(node.id)) return node.transform;
      resolving.add(node.id);

      const parentId = String(node.parentId ?? "").trim();
      if (!parentId) {
        resolving.delete(node.id);
        memoWorld.set(node.id, node.transform);
        return node.transform;
      }
      const parent = byId.get(parentId) as any;
      if (!parent) {
        resolving.delete(node.id);
        memoWorld.set(node.id, node.transform);
        return node.transform;
      }
      const pt = resolveWorldTransform(parent);
      const pr = (pt?.rotationDeg ?? 0) * (Math.PI / 180);
      const cos = Math.cos(pr);
      const sin = Math.sin(pr);
      const scale = Math.max(1e-6, Number(pt?.h ?? 1));
      const lt = node.transform ?? { x: 0, y: 0, w: 0.1, h: 0.05 };
      const lx = Number(lt.x ?? 0) * scale;
      const ly = Number(lt.y ?? 0) * scale;
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;
      const rotDeg = (pt?.rotationDeg ?? 0) + (lt.rotationDeg ?? 0);
      const out = {
        x: Number(pt?.x ?? 0) + rx,
        y: Number(pt?.y ?? 0) + ry,
        w: Number(lt.w ?? 0.1) * scale,
        h: Number(lt.h ?? 0.05) * scale,
        rotationDeg: rotDeg,
        anchor: lt.anchor ?? pt?.anchor ?? "topLeft"
      };
      resolving.delete(node.id);
      memoWorld.set(node.id, out);
      return out;
    };

    const drawLine = (
      p1: { x: number; y: number },
      p2: { x: number; y: number },
      strokePx: number,
      color: string,
      opacity: number,
      selected: boolean
    ) => {
      if (selected) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity) * 0.55;
        ctx.strokeStyle = "rgba(110,168,255,0.95)";
        ctx.lineWidth = strokePx + 10;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = color;
      ctx.lineWidth = strokePx;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    };

    const drawArrow = (
      p1: { x: number; y: number },
      p2: { x: number; y: number },
      strokePx: number,
      color: string,
      opacity: number,
      selected: boolean
    ) => {
      const vx = p2.x - p1.x;
      const vy = p2.y - p1.y;
      const len = Math.max(1e-6, Math.hypot(vx, vy));
      const ux = vx / len;
      const uy = vy / len;
      const pxu = -uy;
      const pyu = ux;

      // Match the preview: base width = 4x stroke, head length = 5x stroke.
      const headW = 4 * strokePx;
      const headL = 5 * strokePx;
      const baseX = p2.x - ux * headL;
      const baseY = p2.y - uy * headL;

      if (selected) {
        // Glow: slightly thicker shaft + head.
        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity) * 0.55;
        ctx.strokeStyle = "rgba(110,168,255,0.95)";
        ctx.fillStyle = "rgba(110,168,255,0.95)";
        ctx.lineWidth = strokePx + 10;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(baseX, baseY);
        ctx.stroke();
        const blXg = baseX + pxu * ((headW + 10) / 2);
        const blYg = baseY + pyu * ((headW + 10) / 2);
        const brXg = baseX - pxu * ((headW + 10) / 2);
        const brYg = baseY - pyu * ((headW + 10) / 2);
        ctx.beginPath();
        ctx.moveTo(blXg, blYg);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(brXg, brYg);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = strokePx;
      ctx.lineCap = "round";

      // Shaft ends at the base of the arrowhead.
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();

      // Head triangle.
      const blX = baseX + pxu * (headW / 2);
      const blY = baseY + pyu * (headW / 2);
      const brX = baseX - pxu * (headW / 2);
      const brY = baseY - pyu * (headW / 2);
      ctx.beginPath();
      ctx.moveTo(blX, blY);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(brX, brY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    for (const n of model.nodes as any[]) {
      if (!n || (n.type !== "arrow" && n.type !== "line")) continue;
      if (n.visible === false) continue;

      const color = String(n.color ?? "white");
      const opacity = typeof n.opacity === "number" ? Math.max(0, Math.min(1, n.opacity)) : 1;
      // In Screen Edit mode, dim any world-space elements (including canvas-rendered arrow/line).
      // In Composite (group) edit mode, dim any nodes that the app layer marked as "disabled" via ip-dim-node.
      const domEl = this.domNodes.get(String(n.id))?.el ?? null;
      const isDimmedByUi = !!domEl?.classList?.contains("ip-dim-node");
      const finalOpacity =
        (window as any).__ip_screenEditing && n.space === "world"
          ? opacity * 0.1
          : (window as any).__ip_compositeEditing && isDimmedByUi
            ? opacity * 0.1
            : opacity;
      const wRaw = Number(n.width ?? 4);
      const selected = document.documentElement.dataset.ipMode === "edit"
        ? !!this.domNodes.get(String(n.id))?.el?.classList?.contains("is-selected")
        : false;

      const t = n.space === "world" ? resolveWorldTransform(n) : n.transform;
      if (!t) continue;

      let rectPx: { x: number; y: number; w: number; h: number; rotDeg: number };
      if (n.space === "world") {
        const wPx = Number(t.w ?? 1) * this.camera.zoom;
        const hPx = Number(t.h ?? 1) * this.camera.zoom;
        const p = worldToScreen({ x: Number(t.x ?? 0), y: Number(t.y ?? 0) }, this.camera, this.screen);
        const { dx, dy } = anchorOffsetPx(t.anchor, wPx, hPx);
        rectPx = { x: p.x + dx, y: p.y + dy, w: wPx, h: hPx, rotDeg: Number(t.rotationDeg ?? 0) };
      } else {
        const sx = Number(t.x ?? 0);
        const sy = Number(t.y ?? 0);
        const sw = Number(t.w ?? 0.2);
        const sh = Number(t.h ?? 0.1);
        const wPx = sw * this.screen.w;
        const hPx = sh * this.screen.h;
        const { dx, dy } = anchorOffsetPx(t.anchor, wPx, hPx);
        rectPx = { x: sx * this.screen.w + dx, y: sy * this.screen.h + dy, w: wPx, h: hPx, rotDeg: Number(t.rotationDeg ?? 0) };
      }

      if (!(rectPx.w >= 1 && rectPx.h >= 1)) continue;

      const from = n.from ?? { x: 0, y: 0.5 };
      const to = n.to ?? { x: 1, y: 0.5 };

      const p1l = { x: Number(from.x ?? 0) * rectPx.w, y: Number(from.y ?? 0.5) * rectPx.h };
      const p2l = { x: Number(to.x ?? 1) * rectPx.w, y: Number(to.y ?? 0.5) * rectPx.h };

      // Apply rotation around rect center (matches DOM default transform-origin: 50% 50%).
      const a = (rectPx.rotDeg * Math.PI) / 180;
      const cx = rectPx.w / 2;
      const cy = rectPx.h / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const rot = (p: { x: number; y: number }) => {
        const x0 = p.x - cx;
        const y0 = p.y - cy;
        return { x: cx + x0 * cos - y0 * sin, y: cy + x0 * sin + y0 * cos };
      };
      const p1r = a ? rot(p1l) : p1l;
      const p2r = a ? rot(p2l) : p2l;
      const p1 = { x: rectPx.x + p1r.x, y: rectPx.y + p1r.y };
      const p2 = { x: rectPx.x + p2r.x, y: rectPx.y + p2r.y };

      // Stroke width rules:
      // - <= 1: fraction of min(w,h) (in px at render time)
      // - > 1:
      //   - world space: treat as "px at zoom=1" (scale with camera.zoom)
      //   - screen space: treat as CSS px
      const strokePx =
        wRaw <= 1
          ? Math.max(1, wRaw * Math.max(1, Math.min(rectPx.w, rectPx.h)))
          : Math.max(1, wRaw * (n.space === "world" ? this.camera.zoom : 1));

      if (n.type === "arrow") drawArrow(p1, p2, strokePx, color, finalOpacity, selected);
      else drawLine(p1, p2, strokePx, color, finalOpacity, selected);
    }
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

    // Draw arrows/lines onto the canvas BEFORE laying out DOM nodes.
    this.drawSegmentsLayer();

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


