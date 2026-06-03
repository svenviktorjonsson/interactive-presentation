import type { Node } from "../core/model";

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };

type AxisState = {
  view: AxisView;
  limits: AxisView | null;
  clamp: boolean;
  padPx: number;
};

type CameraDeps = {
  mode: string;
  storeMode: () => string;
  playerLinks: Map<string, { playLabel?: string; pauseLabel?: string }>;
  webcamLinks: Map<string, { shot?: () => void; toggleRec?: () => void }>;
  cameraStreams: Map<string, MediaStream>;
  cameraRecorders: Map<string, { rec: MediaRecorder; chunks: BlobPart[] }>;
  cameraErrors: Map<string, string>;
  cameraErrorDetails: Map<string, string>;
  cameraPreviewCooldown: Map<string, number>;
  ensureCameraStream: (nodeId: string, opts: { deviceId?: string }) => Promise<MediaStream>;
  stopCameraStream: (nodeId: string) => void;
  ensureWebcamBus: () => void;
  logCameraDebug: (msg: string, data?: Record<string, unknown>) => void;
  sizePx: () => { wPx: number; hPx: number };
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
};

type AxisDeps = {
  mode: string;
  getAxisState: (node: Node) => AxisState;
  clampAxisView: (view: AxisView, limits: AxisView | null, clamp: boolean) => AxisView;
  renderAxisNode: (ctx: CanvasRenderingContext2D, el: HTMLElement, node: Node, timeMs: number) => void;
  sizePx: () => { wPx: number; hPx: number };
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
};

export const ensureAxisNodeElement = (el: HTMLElement) => {
  el.classList.add("node-axis");
  if (!el.querySelector(".axis-canvas")) {
    const canvas = document.createElement("canvas");
    canvas.className = "axis-canvas";
    el.appendChild(canvas);
  }
};

export const ensureCameraNodeElement = (el: HTMLElement) => {
  el.classList.add("node-camera");
  if (el.querySelector(".camera-frame")) return;
  const frame = document.createElement("div");
  frame.className = "camera-frame";
  const video = document.createElement("video");
  video.className = "camera-video";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const freeze = document.createElement("img");
  freeze.className = "camera-freeze";
  freeze.alt = "";
  freeze.draggable = false;
  const error = document.createElement("div");
  error.className = "camera-error";
  const errorMsg = document.createElement("div");
  errorMsg.className = "camera-error-msg";
  const errorDetail = document.createElement("div");
  errorDetail.className = "camera-error-detail";
  const errorRetry = document.createElement("button");
  errorRetry.type = "button";
  errorRetry.className = "camera-error-retry";
  errorRetry.textContent = "Retry camera";
  error.append(errorMsg, errorDetail, errorRetry);
  frame.append(video, freeze, error);
  el.appendChild(frame);
};

export const updateAxisNode = (
  el: HTMLElement,
  node: Node,
  timeMs: number,
  deps: AxisDeps,
) => {
  const canvas = el.querySelector<HTMLCanvasElement>(".axis-canvas");
  if (!canvas) throw new Error("[next] axis node missing canvas");
  if (!el.dataset.axisBound) {
    el.dataset.axisBound = "1";
    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let startView: AxisView | null = null;
    const getPlotMetrics = () => {
      const rect = canvas.getBoundingClientRect();
      const st = deps.getAxisState(node);
      const uiScale = Number(el.style.getPropertyValue("--node-ui-scale")) || 1;
      const pad = Math.max(18, st.padPx * uiScale);
      const left = pad;
      const right = Math.max(left + 1, rect.width - pad);
      const top = pad;
      const bottom = Math.max(top + 1, rect.height - pad);
      return { rect, st, left, right, top, bottom, w: right - left, h: bottom - top };
    };
    const canAxisInteract = () =>
      deps.mode === "live" && (!(node as any).soundId || !(node as any).__soundRunning);
    const onPointerDown = (ev: PointerEvent) => {
      if (!canAxisInteract()) return;
      if (ev.button !== 0) return;
      const plot = getPlotMetrics();
      const x = ev.clientX - plot.rect.left;
      const y = ev.clientY - plot.rect.top;
      if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) return;
      isPanning = true;
      startX = ev.clientX;
      startY = ev.clientY;
      startView = { ...plot.st.view };
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!isPanning || !startView) return;
      const plot = getPlotMetrics();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const rangeX = startView.xMax - startView.xMin;
      const rangeY = startView.yMax - startView.yMin;
      const lockY = String((node as any).pressureRole ?? "") === "axis" && !!(node as any).pressureId;
      const next: AxisView = {
        xMin: startView.xMin - (dx / Math.max(1, plot.w)) * rangeX,
        xMax: startView.xMax - (dx / Math.max(1, plot.w)) * rangeX,
        yMin: lockY ? startView.yMin : startView.yMin - (dy / Math.max(1, plot.h)) * rangeY,
        yMax: lockY ? startView.yMax : startView.yMax - (dy / Math.max(1, plot.h)) * rangeY,
      };
      plot.st.view = deps.clampAxisView(next, plot.st.limits, plot.st.clamp);
      ev.preventDefault();
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (!isPanning) return;
      isPanning = false;
      startView = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {}
      ev.preventDefault();
    };
    const onWheel = (ev: WheelEvent) => {
      if (!canAxisInteract()) return;
      const plot = getPlotMetrics();
      const x = ev.clientX - plot.rect.left;
      const y = ev.clientY - plot.rect.top;
      if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) return;
      const v = plot.st.view;
      const rangeX = v.xMax - v.xMin;
      const rangeY = v.yMax - v.yMin;
      const px = x - plot.left;
      const py = y - plot.top;
      const ax = v.xMin + (px / Math.max(1, plot.w)) * rangeX;
      const ay = v.yMax - (py / Math.max(1, plot.h)) * rangeY;
      const zoom = Math.exp(ev.deltaY * 0.001);
      const lockY = String((node as any).pressureRole ?? "") === "axis" && !!(node as any).pressureId;
      const next: AxisView = {
        xMin: ax - (ax - v.xMin) * zoom,
        xMax: ax + (v.xMax - ax) * zoom,
        yMin: lockY ? v.yMin : ay - (ay - v.yMin) * zoom,
        yMax: lockY ? v.yMax : ay + (v.yMax - ay) * zoom,
      };
      plot.st.view = deps.clampAxisView(next, plot.st.limits, plot.st.clamp);
      ev.preventDefault();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
  }
  const ctx = canvas.getContext("2d");
  if (ctx) deps.renderAxisNode(ctx, el, node, timeMs);
  const { wPx, hPx } = deps.sizePx();
  deps.applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
};

export const updateCameraNode = async (
  el: HTMLElement,
  node: Node,
  deps: CameraDeps,
) => {
  const anyNode = node as any;
  const frame = el.querySelector<HTMLElement>(".camera-frame");
  const videoEl = el.querySelector<HTMLVideoElement>(".camera-video");
  const freezeEl = el.querySelector<HTMLImageElement>(".camera-freeze");
  const errorEl = el.querySelector<HTMLElement>(".camera-error");
  const errorMsgEl = el.querySelector<HTMLElement>(".camera-error-msg");
  const errorDetailEl = el.querySelector<HTMLElement>(".camera-error-detail");
  const errorRetryBtn = el.querySelector<HTMLButtonElement>(".camera-error-retry");
  if (!frame || !videoEl || !freezeEl) throw new Error("[next] camera node missing elements");

  (el as any).__cameraNode = node;
  const id = String(anyNode.id ?? "");
  const deviceId = String(anyNode.deviceId ?? "");
  const key = `${id}::${deviceId}`;
  if (videoEl.dataset.streamKey !== key) {
    videoEl.dataset.streamKey = key;
    deps.stopCameraStream(id);
    videoEl.srcObject = null;
  }
  const isLive = deps.mode === "live";
  const isWebcam = Boolean(anyNode.webcamId);
  if (errorEl) {
    const msg = deps.cameraErrors.get(id) ?? "";
    const detail = deps.cameraErrorDetails.get(id) ?? "";
    if (errorMsgEl) errorMsgEl.textContent = msg;
    if (errorDetailEl) errorDetailEl.textContent = detail;
    errorEl.style.display = msg ? "flex" : "none";
  }
  const now = performance.now();
  const cooldownUntil = deps.cameraPreviewCooldown.get(key) ?? 0;
  const autoPreview = Boolean(anyNode.autoPreview ?? !isWebcam);
  if (isLive && autoPreview && now >= cooldownUntil && !deps.cameraRecorders.has(id) && !videoEl.srcObject && !videoEl.dataset.autoPreviewPending) {
    videoEl.dataset.autoPreviewPending = "1";
    void deps.ensureCameraStream(id, { deviceId: anyNode.deviceId })
      .then((stream) => {
        if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
        return videoEl.play().catch(() => {});
      })
      .catch((err) => {
        const name = String((err as any)?.name ?? "");
        const delayMs = name === "NotAllowedError" ? 20000 : 5000;
        deps.cameraPreviewCooldown.set(key, performance.now() + delayMs);
        const msg =
          name === "NotReadableError" ? "Camera busy or unavailable" :
          name === "NotAllowedError" ? "Camera permission denied" :
          "Camera failed to start";
        if (deps.cameraErrors.get(id) !== msg) {
          deps.cameraErrors.set(id, msg);
          console.warn("[camera] preview failed", { id, name });
        }
        void navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
          const cams = devices.filter((d) => d.kind === "videoinput");
          const labels = cams.map((d) => d.label).filter(Boolean);
          const detail = `Devices: ${cams.length}${labels.length ? ` (${labels.join(", ")})` : ""}`;
          deps.cameraErrorDetails.set(id, detail);
          deps.logCameraDebug("devices", {
            nodeId: id,
            count: cams.length,
            devices: cams.map((d) => ({ label: d.label, deviceId: d.deviceId })),
          });
        }).catch(() => {});
      })
      .finally(() => {
        delete videoEl.dataset.autoPreviewPending;
      });
  }
  if (!isLive) {
    deps.stopCameraStream(id);
    videoEl.srcObject = null;
  }
  if (!el.dataset.cameraBound) {
    el.dataset.cameraBound = "1";
    if (errorRetryBtn) {
      errorRetryBtn.addEventListener("click", () => {
        if (deps.storeMode() !== "live") return;
        deps.cameraErrors.delete(id);
        deps.cameraErrorDetails.delete(id);
        deps.cameraPreviewCooldown.delete(key);
        void deps.ensureCameraStream(id, { deviceId: anyNode.deviceId })
          .then((stream) => {
            if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
            return videoEl.play().catch(() => {});
          })
          .catch((err) => {
            const name = String((err as any)?.name ?? "");
            const msg = name === "NotReadableError" ? "Camera busy or unavailable" : "Camera failed to start";
            deps.cameraErrors.set(id, msg);
          });
      });
    }
    const resolveWebcamLabels = () => {
      if (!isWebcam) return { rec: "Rec", stop: "Stop", shot: "Shot" };
      const webcamId = String(anyNode.webcamId ?? "");
      const link = webcamId ? deps.playerLinks.get(webcamId) : null;
      const rec = String(link?.playLabel ?? anyNode.recLabel ?? "Rec");
      const stop = String(link?.pauseLabel ?? anyNode.stopLabel ?? "Stop");
      const shot = String(anyNode.shotLabel ?? "Shot");
      return { rec, stop, shot };
    };
    const updateWebcamButtons = (isActive: boolean) => {
      if (!isWebcam) return;
      const webcamId = String(anyNode.webcamId ?? "");
      if (!webcamId) return;
      const labels = resolveWebcamLabels();
      const recLabel = isActive ? labels.stop : labels.rec;
      const nodes = ((window as any).__ipStoreNodes ?? []) as any[];
      for (const n of nodes) {
        if (n?.type !== "buttons") continue;
        const nodeId = String(n?.id ?? "");
        const nodeWebcamId = String(n?.playerId ?? "");
        if (nodeWebcamId !== webcamId && nodeId !== `${webcamId}_buttons`) continue;
        const nextLabels = [recLabel, labels.shot];
        n.labels = nextLabels;
        if (Array.isArray(n.templates)) n.templates = nextLabels;
      }
    };
    const setRecUi = (isActive: boolean) => updateWebcamButtons(isActive);
    const ensureVideoReady = () =>
      new Promise<void>((resolve) => {
        if (videoEl.readyState >= 2) return resolve();
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          videoEl.removeEventListener("loadeddata", onReady);
          videoEl.removeEventListener("canplay", onReady);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        videoEl.addEventListener("loadeddata", onReady, { once: true });
        videoEl.addEventListener("canplay", onReady, { once: true });
        setTimeout(() => {
          cleanup();
          resolve();
        }, 1000);
      });
    const setFreeze = (url: string | null, resume: boolean = true) => {
      const prev = freezeEl.dataset.freezeUrl;
      if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      if (url) {
        freezeEl.dataset.freezeUrl = url;
        freezeEl.src = url;
        freezeEl.style.display = "block";
        videoEl.pause();
      } else {
        freezeEl.dataset.freezeUrl = "";
        freezeEl.removeAttribute("src");
        freezeEl.style.display = "none";
        if (resume) void videoEl.play().catch(() => {});
      }
    };
    const captureFrame = async (): Promise<Blob | null> => {
      try {
        await ensureVideoReady();
        const w = Math.max(1, videoEl.videoWidth || 0);
        const h = Math.max(1, videoEl.videoHeight || 0);
        if (w <= 1 && h <= 1) return null;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(videoEl, 0, 0, w, h);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
      } catch {
        return null;
      }
    };
    const doShot = async () => {
      if (deps.storeMode() !== "live") return;
      const n: any = (el as any).__cameraNode;
      const currentId = String(n?.id ?? "");
      if (!currentId) return;
      const hadStream = deps.cameraStreams.has(currentId);
      try {
        const stream = await deps.ensureCameraStream(currentId, { deviceId: n?.deviceId });
        if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        deps.cameraErrors.delete(currentId);
      } catch (err) {
        const name = String((err as any)?.name ?? "");
        const msg = name === "NotReadableError" ? "Camera busy or unavailable" : "Camera failed to start";
        if (deps.cameraErrors.get(currentId) !== msg) {
          deps.cameraErrors.set(currentId, msg);
          console.warn("[camera] stream failed", { id: currentId, name });
        }
        deps.cameraErrorDetails.delete(currentId);
        return;
      }
      const blob = await captureFrame();
      if (!blob) return;
      try {
        if (!navigator.clipboard || !("write" in navigator.clipboard) || typeof ClipboardItem === "undefined") {
          throw new Error("Clipboard image write not supported.");
        }
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } catch (err) {
        console.error("[next][camera] failed to copy screenshot", err);
      } finally {
        if (!hadStream) {
          deps.stopCameraStream(currentId);
          videoEl.srcObject = null;
        }
      }
    };
    const doToggleRec = async () => {
      if (deps.storeMode() !== "live") return;
      const n: any = (el as any).__cameraNode;
      const currentId = String(n?.id ?? "");
      if (!currentId) return;
      const active = deps.cameraRecorders.get(currentId);
      if (active) {
        try {
          active.rec.stop();
        } catch {}
        setRecUi(false);
        return;
      }
      try {
        const stream = await deps.ensureCameraStream(currentId, { deviceId: n?.deviceId });
        if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
        const chunks: BlobPart[] = [];
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = async () => {
          setFreeze(null, false);
          const blob = new Blob(chunks, { type: "video/webm" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `camera_${currentId}_${Date.now()}.webm`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          deps.cameraRecorders.delete(currentId);
          setRecUi(false);
          deps.stopCameraStream(currentId);
          videoEl.srcObject = null;
        };
        deps.cameraRecorders.set(currentId, { rec, chunks });
        setFreeze(null);
        rec.start();
        setRecUi(true);
        deps.cameraErrors.delete(currentId);
      } catch (err) {
        const name = String((err as any)?.name ?? "");
        const msg = name === "NotReadableError" ? "Camera busy or unavailable" : "Recording failed";
        if (deps.cameraErrors.get(currentId) !== msg) {
          deps.cameraErrors.set(currentId, msg);
          console.warn("[camera] record failed", { id: currentId, name });
        }
        deps.cameraErrorDetails.delete(currentId);
        setRecUi(false);
      }
    };
    const webcamId = String((node as any).webcamId ?? "");
    if (webcamId) {
      deps.ensureWebcamBus();
      deps.webcamLinks.set(webcamId, { shot: () => void doShot(), toggleRec: () => void doToggleRec() });
    }
  }
  const { wPx, hPx } = deps.sizePx();
  deps.applyBackground(el, anyNode.bgColor, anyNode.bgAlpha, anyNode.bgPadding, anyNode.bgRadius, wPx, hPx);
};
