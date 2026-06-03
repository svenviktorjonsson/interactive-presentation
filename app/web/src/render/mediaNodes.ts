import type { Node } from "../core/model";
import type { Store } from "../core/store";

type MediaDeps = {
  mode: string;
  store: Store;
  sizePx: () => { wPx: number; hPx: number };
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
  inferPlayerId: (node: any) => string;
  ensurePlayerBus: () => void;
  playerLinks: Map<string, any>;
  youtubePlayers: Map<string, any>;
  youtubePortals: Map<string, HTMLDivElement>;
  parseYoutubeId: (src: string) => string | null;
  ensureYoutubePlayer: (nodeId: string, iframeEl: HTMLIFrameElement) => Promise<any>;
  ensureYoutubePortal: (nodeId: string, iframeEl: HTMLIFrameElement) => HTMLDivElement;
  releaseYoutubePortal: (nodeId: string, frame: HTMLElement, iframeEl: HTMLIFrameElement) => void;
  ensureVideoPoster: (src: string, timeSec: number) => Promise<string | null>;
  fitCameraToScreen: (camera: { cx: number; cy: number; zoom: number }, store: Store) => { cx: number; cy: number; zoom: number };
  resolveViewCamera: (store: Store, viewId: string) => { cx: number; cy: number; zoom: number };
  worldToScreenScale: (camera: { cx: number; cy: number; zoom: number }, screen: { w: number; h: number }) => { x: number; y: number };
  qrCache: Map<string, string>;
  qrPending: Map<string, Promise<string>>;
  qrToDataUrl: (url: string) => Promise<string>;
  iframePreviewAttempts: Map<string, number>;
  iframePreviewTimers: Map<string, number>;
  parseTimeToSeconds: (raw: string) => number | null;
};

export const ensureJoinNodeElement = (el: HTMLElement) => {
  el.classList.add("node-join");
  if (!el.querySelector(".node-join-qr")) {
    const qr = document.createElement("img");
    qr.className = "node-join-qr";
    qr.decoding = "async";
    qr.loading = "eager";
    qr.alt = "Join QR";
    qr.draggable = false;
    el.appendChild(qr);
  }
};

export const ensureHtmlFrameNodeElement = (el: HTMLElement) => {
  el.classList.add("node-iframe");
  if (el.querySelector(".iframe-frame")) return;
  const frame = document.createElement("div");
  frame.className = "iframe-frame";
  const iframe = document.createElement("iframe");
  iframe.className = "iframe";
  iframe.allow = "fullscreen";
  iframe.allowFullscreen = true;
  iframe.loading = "eager";
  iframe.referrerPolicy = "origin";
  const placeholder = document.createElement("div");
  placeholder.className = "iframe-placeholder";
  const previewImg = document.createElement("img");
  previewImg.className = "iframe-preview";
  previewImg.alt = "Iframe preview";
  const previewText = document.createElement("div");
  previewText.className = "iframe-preview-text";
  previewText.textContent = "Iframe preview (edit mode)";
  placeholder.append(previewImg, previewText);
  frame.appendChild(iframe);
  frame.appendChild(placeholder);
  el.appendChild(frame);
};

export const ensureVideoNodeElement = (el: HTMLElement) => {
  el.classList.add("node-video");
  if (el.querySelector(".video-frame")) return;
  const frame = document.createElement("div");
  frame.className = "video-frame";
  const video = document.createElement("video");
  video.className = "video";
  video.playsInline = true;
  video.preload = "metadata";
  const iframe = document.createElement("iframe");
  iframe.className = "video-embed";
  iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "origin";
  iframe.loading = "eager";
  const poster = document.createElement("img");
  poster.className = "video-poster";
  poster.loading = "eager";
  poster.decoding = "async";
  const controls = document.createElement("div");
  controls.className = "video-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "video-btn";
  btn.textContent = "Play";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.01";
  slider.value = "0";
  slider.className = "video-slider";
  controls.append(btn, slider);
  frame.append(video, iframe, poster);
  el.appendChild(frame);
  el.appendChild(controls);
};

export const updateJoinNode = (el: HTMLElement, node: Node, deps: MediaDeps) => {
  const qr = el.querySelector<HTMLImageElement>(".node-join-qr");
  if (!qr) throw new Error("[next] join node missing qr img");
  const joinId = String((node as any).id ?? "");
  const base = String((deps.store.model as any).defaults?.publicBaseUrl ?? window.location.origin).replace(/\/$/, "");
  const url = `${base}/join/${encodeURIComponent(joinId)}`;
  const cached = deps.qrCache.get(url);
  if (cached) {
    if (qr.dataset.src !== cached) {
      qr.dataset.src = cached;
      qr.src = cached;
    }
  } else if (!deps.qrPending.has(url)) {
    const pending = deps.qrToDataUrl(url).then((data: string) => {
      deps.qrCache.set(url, data);
      return data;
    });
    deps.qrPending.set(url, pending);
    pending.then((data: string) => {
      if (deps.qrCache.get(url) === data) {
        qr.dataset.src = data;
        qr.src = data;
      }
      deps.qrPending.delete(url);
    }).catch(() => {
      deps.qrPending.delete(url);
    });
  }
  const { wPx, hPx } = deps.sizePx();
  deps.applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
};

export const updateHtmlFrameNode = (el: HTMLElement, node: Node, deps: MediaDeps) => {
  el.style.display = "block";
  el.style.visibility = "visible";
  el.style.pointerEvents = deps.store.mode === "live" ? "auto" : "none";
  el.style.transform = "none";
  el.style.transformOrigin = "0% 0%";
  const iframe = el.querySelector<HTMLIFrameElement>(".iframe");
  const placeholder = el.querySelector<HTMLElement>(".iframe-placeholder");
  const previewImg = el.querySelector<HTMLImageElement>(".iframe-preview");
  const previewText = el.querySelector<HTMLElement>(".iframe-preview-text");
  if (!iframe) throw new Error("[next] iframe node missing iframe element");
  const nodeId = String((node as any).id ?? "");
  const src = String((node as any).src ?? "");
  if (iframe.dataset.src !== src) {
    iframe.dataset.src = src;
    iframe.src = src;
    if (previewImg) {
      previewImg.removeAttribute("src");
      previewImg.removeAttribute("data-preview-key");
      previewImg.removeAttribute("data-preview-ready");
    }
    if (nodeId) {
      deps.iframePreviewAttempts.delete(nodeId);
      const timer = deps.iframePreviewTimers.get(nodeId);
      if (timer) {
        window.clearTimeout(timer);
        deps.iframePreviewTimers.delete(nodeId);
      }
    }
  }
  const viewId = String((node as any).viewId ?? deps.store.activeViewId);
  const liveCam = deps.fitCameraToScreen(deps.resolveViewCamera(deps.store, viewId), deps.store);
  const captureScale = 1;
  const liveScale = deps.worldToScreenScale(liveCam, deps.store.screen);
  const wLive = node.space === "screen"
    ? Math.max(1, Math.round(node.transform.w * deps.store.screen.w))
    : Math.max(1, Math.round(node.transform.w * liveScale.x));
  const hLive = node.space === "screen"
    ? Math.max(1, Math.round(node.transform.h * deps.store.screen.h))
    : Math.max(1, Math.round(node.transform.h * liveScale.y));
  const clearPreviewTimer = () => {
    if (!nodeId) return;
    const timer = deps.iframePreviewTimers.get(nodeId);
    if (timer) {
      window.clearTimeout(timer);
      deps.iframePreviewTimers.delete(nodeId);
    }
  };
  const setPreviewError = (msg: string) => {
    clearPreviewTimer();
    if (nodeId) deps.iframePreviewAttempts.delete(nodeId);
    if (placeholder) placeholder.style.display = "flex";
    if (previewImg) previewImg.style.display = "none";
    if (previewText) previewText.textContent = msg;
    if (previewImg) {
      previewImg.dataset.previewReady = "error";
      previewImg.dataset.previewFailed = "1";
    }
  };
  const setPreviewImage = (srcUrl: string) => {
    if (!previewImg) return;
    clearPreviewTimer();
    if (nodeId) deps.iframePreviewAttempts.delete(nodeId);
    previewImg.style.display = "block";
    previewImg.dataset.previewReady = "0";
    previewImg.dataset.previewFailed = "0";
    previewImg.src = srcUrl;
    if (previewText) previewText.textContent = "";
    previewImg.onload = () => {
      const nw = previewImg.naturalWidth || 0;
      const nh = previewImg.naturalHeight || 0;
      const minW = Math.max(16, Math.round(wLive * 0.05));
      const minH = Math.max(16, Math.round(hLive * 0.05));
      if (nw < minW || nh < minH) {
        previewImg.removeAttribute("src");
        previewImg.removeAttribute("data-preview-key");
        previewImg.removeAttribute("data-preview-ready");
        schedulePreviewRetry();
        return;
      }
      previewImg.dataset.previewReady = "1";
      previewImg.dataset.previewFailed = "0";
    };
    previewImg.onerror = () => setPreviewError("Preview failed: image decode error");
  };
  const schedulePreviewRetry = () => {
    if (!nodeId) return;
    const attempts = deps.iframePreviewAttempts.get(nodeId) ?? 0;
    if (attempts >= 8) {
      setPreviewError("Preview failed: timed out");
      return;
    }
    if (deps.iframePreviewTimers.has(nodeId)) return;
    deps.iframePreviewAttempts.set(nodeId, attempts + 1);
    const timer = window.setTimeout(() => {
      deps.iframePreviewTimers.delete(nodeId);
      updatePreview();
    }, 400);
    deps.iframePreviewTimers.set(nodeId, timer);
  };
  const updatePreview = () => {
    if (!previewImg) return;
    const previewKey = src;
    if (previewImg.dataset.previewFailed === "1" && previewImg.dataset.previewKey === previewKey) return;
    if (previewImg.dataset.previewKey === previewKey && previewImg.dataset.previewReady === "1") return;
    previewImg.dataset.previewKey = previewKey;
    if (previewText && previewImg.dataset.previewReady !== "1") previewText.textContent = "Loading preview...";
    try {
      const doc = iframe.contentDocument;
      if (!doc || doc.readyState === "loading") {
        schedulePreviewRetry();
        return;
      }
      const canvas = doc.querySelector("canvas") as HTMLCanvasElement | null;
      if (canvas && typeof canvas.toDataURL === "function") {
        const minCanvasW = Math.max(64, Math.round(wLive * 0.2));
        const minCanvasH = Math.max(64, Math.round(hLive * 0.2));
        const rect = canvas.getBoundingClientRect();
        const cssW = rect.width || canvas.clientWidth || canvas.width;
        const cssH = rect.height || canvas.clientHeight || canvas.height;
        const targetW = Math.max(1, Math.round(cssW * captureScale));
        const targetH = Math.max(1, Math.round(cssH * captureScale));
        if (targetW >= minCanvasW && targetH >= minCanvasH) {
          const off = document.createElement("canvas");
          off.width = targetW;
          off.height = targetH;
          const ctx = off.getContext("2d");
          if (ctx) setPreviewImage((ctx.drawImage(canvas, 0, 0, targetW, targetH), off.toDataURL("image/png")));
          else setPreviewImage(canvas.toDataURL("image/png"));
          previewImg.dataset.previewKey = previewKey;
          return;
        }
      }
      const svg = doc.querySelector("svg") as SVGSVGElement | null;
      if (svg) {
        const viewBox = svg.viewBox?.baseVal;
        const svgRect = svg.getBoundingClientRect();
        const svgWidth = Math.max(svg.width?.baseVal?.value || 0, viewBox?.width || 0, svgRect.width || 0);
        const svgHeight = Math.max(svg.height?.baseVal?.value || 0, viewBox?.height || 0, svgRect.height || 0);
        const minSvgW = Math.max(64, Math.round(wLive * 0.2));
        const minSvgH = Math.max(64, Math.round(hLive * 0.2));
        if (svgWidth >= minSvgW && svgHeight >= minSvgH) {
          const serialized = new XMLSerializer().serializeToString(svg);
          const targetW = Math.max(1, Math.round(svgWidth * captureScale));
          const targetH = Math.max(1, Math.round(svgHeight * captureScale));
          const img = new Image();
          img.onload = () => {
            const off = document.createElement("canvas");
            off.width = targetW;
            off.height = targetH;
            const ctx = off.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, targetW, targetH);
              setPreviewImage(off.toDataURL("image/png"));
              previewImg.dataset.previewKey = previewKey;
            } else {
              setPreviewImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`);
              previewImg.dataset.previewKey = previewKey;
            }
          };
          img.onerror = () => setPreviewError("Preview failed: unable to render svg");
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
          return;
        }
      }
      const root = doc.documentElement as HTMLElement | null;
      if (root) {
        const fallbackWidth = Math.max(1, Math.round(wLive * captureScale));
        const fallbackHeight = Math.max(1, Math.round(hLive * captureScale));
        const rootWidth = root.scrollWidth || root.clientWidth || doc.body?.scrollWidth || doc.body?.clientWidth || 1;
        const rootHeight = root.scrollHeight || root.clientHeight || doc.body?.scrollHeight || doc.body?.clientHeight || 1;
        const width = Math.max(fallbackWidth, Math.round(rootWidth * captureScale));
        const height = Math.max(fallbackHeight, Math.round(rootHeight * captureScale));
        const styleText = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
        const forcedDark = [
          ":root{color-scheme:dark;background:#0b1020;color:rgba(255,255,255,0.92);}",
          "html,body{margin:0;background:#0b1020;color:rgba(255,255,255,0.92);}",
          "body{min-height:100%;}",
        ].join("");
        const body = doc.body;
        let bodyHtml = "";
        if (body) {
          const clone = body.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("script").forEach((el) => el.remove());
          const origCanvases = Array.from(body.querySelectorAll("canvas"));
          const cloneCanvases = Array.from(clone.querySelectorAll("canvas"));
          for (let i = 0; i < Math.min(origCanvases.length, cloneCanvases.length); i += 1) {
            const c = origCanvases[i];
            const cc = cloneCanvases[i];
            try {
              if (c.width > 2 && c.height > 2) {
                const img = doc.createElement("img");
                img.src = c.toDataURL("image/png");
                const w = Math.max(c.clientWidth || 0, c.width || 0);
                const h = Math.max(c.clientHeight || 0, c.height || 0);
                if (w) img.style.width = `${w}px`;
                if (h) img.style.height = `${h}px`;
                cc.replaceWith(img);
              }
            } catch {}
          }
          bodyHtml = new XMLSerializer().serializeToString(clone);
        }
        const html = bodyHtml || root.outerHTML;
        const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${forcedDark}\n${styleText}</style>${html}</div></foreignObject></svg>`;
        const img = new Image();
        img.onload = () => {
          const off = document.createElement("canvas");
          off.width = width;
          off.height = height;
          const ctx = off.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            setPreviewImage(off.toDataURL("image/png"));
            previewImg.dataset.previewKey = previewKey;
          }
        };
        img.onerror = () => setPreviewError("Preview failed: unable to render iframe HTML");
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDoc)}`;
        return;
      }
      if ((deps.iframePreviewAttempts.get(nodeId) ?? 0) >= 8) setPreviewError("Preview failed: no renderable content found");
      else schedulePreviewRetry();
    } catch {
      setPreviewError("Preview failed: blocked by browser security policy");
    }
  };
  if (!iframe.dataset.previewBound) {
    iframe.dataset.previewBound = "1";
    iframe.addEventListener("load", () => updatePreview());
  }
  if (deps.store.mode === "live") {
    if (placeholder) placeholder.style.display = "none";
    iframe.style.display = "block";
    iframe.style.visibility = "";
    iframe.style.opacity = "";
    iframe.style.pointerEvents = "";
    iframe.style.position = "";
    iframe.style.left = "";
    iframe.style.top = "";
    iframe.style.width = "";
    iframe.style.height = "";
  } else {
    iframe.style.display = "block";
    iframe.style.visibility = "visible";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.style.position = "";
    iframe.style.left = "";
    iframe.style.top = "";
    iframe.style.width = `${wLive}px`;
    iframe.style.height = `${hLive}px`;
    if (placeholder) placeholder.style.display = "flex";
    updatePreview();
  }
  const { wPx, hPx } = deps.sizePx();
  deps.applyBackground(el, (node as any).bgColor, (node as any).bgAlpha, (node as any).bgPadding, (node as any).bgRadius, wPx, hPx);
};

export const updateVideoNode = (el: HTMLElement, node: Node, deps: MediaDeps) => {
  el.style.display = "block";
  el.style.visibility = "visible";
  if (deps.store.mode === "live") el.style.pointerEvents = "auto";
  el.style.transform = "none";
  el.style.transformOrigin = "0% 0%";
  const anyNode = node as any;
  const frame = el.querySelector<HTMLElement>(".video-frame");
  const videoEl = el.querySelector<HTMLVideoElement>(".video");
  let iframeEl = el.querySelector<HTMLIFrameElement>(".video-embed") ?? ((el as any).__videoIframe as HTMLIFrameElement);
  const posterEl = el.querySelector<HTMLImageElement>(".video-poster");
  const controlsEl = el.querySelector<HTMLElement>(".video-controls");
  const btn = el.querySelector<HTMLButtonElement>(".video-btn");
  const slider = el.querySelector<HTMLInputElement>(".video-slider");
  if (!frame || !videoEl || !posterEl || !controlsEl || !btn || !slider) throw new Error("[next] video node missing elements");
  if (!iframeEl) {
    iframeEl = document.createElement("iframe");
    iframeEl.className = "video-embed";
    iframeEl.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    iframeEl.allowFullscreen = true;
    iframeEl.referrerPolicy = "origin";
    iframeEl.loading = "eager";
    frame.appendChild(iframeEl);
  }
  (el as any).__videoIframe = iframeEl;
  (el as any).__videoNode = node;
  const playerId = deps.inferPlayerId(anyNode);
  if (playerId) {
    deps.ensurePlayerBus();
    const link = deps.playerLinks.get(playerId) ?? {};
    link.videoEl = videoEl;
    link.videoNodeId = String(node.id);
    link.iframeEl = iframeEl;
    if (anyNode.playLabel) link.playLabel = String(anyNode.playLabel);
    if (anyNode.pauseLabel) link.pauseLabel = String(anyNode.pauseLabel);
    deps.playerLinks.set(playerId, link);
  }
  const src = String(anyNode.src ?? "").trim();
  const thumbRaw = String(anyNode.thumbnail ?? anyNode.poster ?? "").trim();
  const ytId = deps.parseYoutubeId(src);
  const isYoutube = !!ytId;
  const placeholderThumb = thumbRaw || (isYoutube ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : "");

  if (!el.dataset.videoBound) {
    el.dataset.videoBound = "1";
    btn.addEventListener("click", () => {
      const n: any = (el as any).__videoNode;
      const srcNow = String(n?.src ?? "");
      const ytNow = deps.parseYoutubeId(srcNow);
      if (ytNow) {
        const origin = encodeURIComponent(window.location.origin);
        const embed = `https://www.youtube.com/embed/${ytNow}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`;
        if (iframeEl!.dataset.src !== embed) {
          iframeEl!.dataset.src = embed;
          iframeEl!.src = embed;
          iframeEl!.dataset.loaded = "0";
          delete (iframeEl!.dataset as any).loadBound;
        }
        const player = deps.youtubePlayers.get(String(n.id));
        if (player) {
          const state = player.getPlayerState?.();
          if (state === 1) player.pauseVideo?.();
          else player.playVideo?.();
          return;
        }
        void deps.ensureYoutubePlayer(String(n.id), iframeEl!).then((p) => {
          const state = p?.getPlayerState?.();
          if (state === 1) p?.pauseVideo?.();
          else p?.playVideo?.();
        });
        return;
      }
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
    });
    slider.addEventListener("pointerdown", () => { slider.dataset.dragging = "1"; });
    slider.addEventListener("pointerup", () => { delete slider.dataset.dragging; });
    slider.addEventListener("input", () => {
      const n: any = (el as any).__videoNode;
      const srcNow = String(n?.src ?? "");
      const ytNow = deps.parseYoutubeId(srcNow);
      const val = Number(slider.value);
      if (!Number.isFinite(val)) return;
      if (ytNow) {
        const origin = encodeURIComponent(window.location.origin);
        const embed = `https://www.youtube.com/embed/${ytNow}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`;
        if (iframeEl!.dataset.src !== embed) {
          iframeEl!.dataset.src = embed;
          iframeEl!.src = embed;
          iframeEl!.dataset.loaded = "0";
          delete (iframeEl!.dataset as any).loadBound;
        }
        const player = deps.youtubePlayers.get(String(n.id));
        if (player) {
          player.seekTo?.(val, true);
          return;
        }
        void deps.ensureYoutubePlayer(String(n.id), iframeEl!).then((p) => p?.seekTo?.(val, true));
        return;
      }
      try { videoEl.currentTime = val; } catch {}
    });
  }
  if (deps.store.mode !== "live") {
    videoEl.style.display = "none";
    iframeEl.style.display = "none";
    controlsEl.style.display = "none";
    if (placeholderThumb) {
      if (posterEl.dataset.src !== placeholderThumb) posterEl.dataset.src = placeholderThumb;
      posterEl.src = placeholderThumb;
    }
    posterEl.style.display = "block";
  } else {
    posterEl.style.display = "none";
    controlsEl.style.display = "flex";
    videoEl.style.display = "";
    iframeEl.style.display = "";
  }
  const showControls = anyNode.showControls !== false;
  controlsEl.style.display = !showControls || isYoutube ? "none" : "flex";
  frame.style.height = isYoutube ? "100%" : "";

  if (isYoutube) {
    videoEl.style.display = "none";
    const portal = deps.ensureYoutubePortal(String(node.id), iframeEl);
    const livePointers = deps.store.mode === "live";
    portal.style.pointerEvents = livePointers ? "auto" : "none";
    let rect = frame.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 1 || rect.height < 1) rect = el.getBoundingClientRect();
    const root = portal.parentElement as HTMLElement | null;
    const rootRect = root && root !== document.body ? root.getBoundingClientRect() : null;
    portal.style.position = rootRect ? "absolute" : "fixed";
    const left = rootRect ? rect.left - rootRect.left : rect.left;
    const top = rootRect ? rect.top - rootRect.top : rect.top;
    portal.style.left = `${left}px`;
    portal.style.top = `${top}px`;
    portal.style.width = `${rect.width}px`;
    portal.style.height = `${rect.height}px`;
    portal.style.display = rect.width > 0 && rect.height > 0 ? "block" : "none";
    iframeEl.style.display = "block";
    iframeEl.style.position = "absolute";
    iframeEl.style.left = "0px";
    iframeEl.style.top = "0px";
    iframeEl.style.width = "100%";
    iframeEl.style.height = "100%";
    iframeEl.style.visibility = "visible";
    iframeEl.style.opacity = "1";
    iframeEl.style.zIndex = "2";
    iframeEl.style.pointerEvents = livePointers ? "auto" : "none";
    iframeEl.style.background = "transparent";
    frame.style.backgroundColor = "transparent";
    const origin = encodeURIComponent(window.location.origin);
    const embed = `https://www.youtube.com/embed/${ytId}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`;
    if (iframeEl.dataset.src !== embed) {
      iframeEl.dataset.src = embed;
      iframeEl.src = embed;
      iframeEl.dataset.loaded = "0";
      delete (iframeEl.dataset as any).loadBound;
    }
    if (!iframeEl.dataset.loadBound) {
      iframeEl.dataset.loadBound = "1";
      iframeEl.addEventListener("load", () => { iframeEl.dataset.loaded = "1"; }, { once: true });
      iframeEl.addEventListener("error", () => {}, { once: true });
    }
    const { wPx, hPx } = deps.sizePx();
    const aspect = 16 / 9;
    const frameStyle = getComputedStyle(frame);
    const padL = Number.parseFloat(frameStyle.paddingLeft) || 0;
    const padR = Number.parseFloat(frameStyle.paddingRight) || 0;
    const padT = Number.parseFloat(frameStyle.paddingTop) || 0;
    const padB = Number.parseFloat(frameStyle.paddingBottom) || 0;
    const innerW = Math.max(0, wPx - padL - padR);
    const innerH = Math.max(0, hPx - padT - padB);
    const containerRatio = innerW / Math.max(1e-9, innerH);
    let iw = innerW;
    let ih = innerH;
    if (containerRatio > aspect) {
      ih = innerH;
      iw = innerH * aspect;
    } else {
      iw = innerW;
      ih = innerW / aspect;
    }
    iframeEl.style.left = `${padL + (innerW - iw) / 2}px`;
    iframeEl.style.top = `${padT + (innerH - ih) / 2}px`;
    iframeEl.style.width = `${iw}px`;
    iframeEl.style.height = `${ih}px`;
  } else {
    iframeEl.style.display = "none";
    videoEl.style.display = "block";
    videoEl.controls = false;
    if (videoEl.dataset.src !== src) {
      videoEl.dataset.src = src;
      videoEl.src = src;
    }
    deps.releaseYoutubePortal(String(node.id), frame, iframeEl);
  }

  let posterUrl = "";
  const timeSec = deps.parseTimeToSeconds(thumbRaw);
  if (thumbRaw && timeSec == null) {
    const isUrl = thumbRaw.startsWith("http://") || thumbRaw.startsWith("https://") || thumbRaw.startsWith("/");
    posterUrl = isUrl ? thumbRaw : `/media/${thumbRaw}`;
  } else if (isYoutube && ytId) {
    posterUrl = `/yt-thumb/${ytId}`;
  }
  if (!posterUrl && timeSec != null && src && !isYoutube) {
    const key = `${src}::${timeSec}`;
    if (videoEl.dataset.posterKey !== key) {
      videoEl.dataset.posterKey = key;
      void deps.ensureVideoPoster(src, timeSec).then((data) => {
        if (!data) return;
        if (videoEl.dataset.posterKey === key) videoEl.poster = data;
      });
    }
  } else if (posterUrl) {
    videoEl.poster = posterUrl;
  }

  const { wPx, hPx } = deps.sizePx();
  deps.applyBackground(el, anyNode.bgColor, anyNode.bgAlpha, anyNode.bgPadding, anyNode.bgRadius, wPx, hPx);

  const ytPlayer = isYoutube ? deps.youtubePlayers.get(String(node.id)) : null;
  const ytState = isYoutube ? ytPlayer?.getPlayerState?.() : null;
  const ytCurrent = isYoutube ? Number(ytPlayer?.getCurrentTime?.() ?? 0) : 0;
  const isPlaying = isYoutube ? ytState === 1 : !videoEl.paused && !videoEl.ended;
  const playerIdForLabel = deps.inferPlayerId(anyNode);
  const labelLink = playerIdForLabel ? deps.playerLinks.get(playerIdForLabel) : null;
  const playLabel = String(anyNode.playLabel ?? labelLink?.playLabel ?? "Play");
  const pauseLabel = String(anyNode.pauseLabel ?? labelLink?.pauseLabel ?? "Pause");
  btn.textContent = isPlaying ? pauseLabel : playLabel;
  if (isYoutube) {
    const player = deps.youtubePlayers.get(String(node.id));
    const duration = Number(player?.getDuration?.() ?? 0);
    const current = Number(player?.getCurrentTime?.() ?? 0);
    slider.max = duration > 0 ? String(duration) : "1";
    if (!slider.dataset.dragging) slider.value = duration > 0 ? String(current) : "0";
  } else {
    const duration = Number(videoEl.duration ?? 0);
    const current = Number(videoEl.currentTime ?? 0);
    slider.max = duration > 0 ? String(duration) : "1";
    if (!slider.dataset.dragging) slider.value = duration > 0 ? String(current) : "0";
  }
  if (isYoutube) iframeEl.style.display = "block";
  if (posterUrl) {
    if (posterEl.dataset.src !== posterUrl) {
      posterEl.dataset.src = posterUrl;
      posterEl.src = posterUrl;
    }
  }
  const ytEnded = ytState === 0;
  const ytBeforeStart = !(ytCurrent > 0.02);
  const showPoster = !!posterUrl && (deps.mode !== "live" || !isPlaying || (isYoutube && (ytBeforeStart || ytEnded)));
  if (showPoster) {
    posterEl.style.display = "block";
    if (isYoutube) {
      frame.style.backgroundImage = `url("${posterUrl}")`;
      frame.style.backgroundSize = "contain";
      frame.style.backgroundPosition = "center";
      frame.style.backgroundRepeat = "no-repeat";
    }
  } else {
    posterEl.style.display = "none";
    frame.style.backgroundImage = "";
  }
};
