import type { Engine } from "@interactive/engine";

export type Tool = "select" | "text" | "bullets" | "arrow" | "line";
export type Space = "world" | "screen";

export type SegmentPlacementController = {
  onPointerDown: (ev: PointerEvent) => boolean;
  onPointerMove: (ev: PointerEvent) => boolean;
  onKeyDown: (ev: KeyboardEvent) => boolean;
  onContextMenu: (ev: MouseEvent) => boolean;
  destroy: () => void;
};

export function createSegmentPlacementController(opts: {
  stage: HTMLElement;
  engine: Engine;
  getAppMode: () => "edit" | "live";
  getTool: () => Tool;
  getSpace: () => Space;
  addTextAt: (pos: { x: number; y: number }, opts?: { space?: Space }) => void;
  addBulletsAt: (pos: { x: number; y: number }, opts?: { space?: Space }) => void;
  addArrowFromTo: (from: { x: number; y: number }, to: { x: number; y: number }, opts?: { space?: Space }) => void;
  addLineFromTo: (from: { x: number; y: number }, to: { x: number; y: number }, opts?: { space?: Space; select?: boolean }) => void;
  clearSelection: () => void;
  gridSpacingForZoom: (zoom: number) => { spacing0: number; spacing1: number; t: number };
  screenToWorld: (p: { x: number; y: number }, cam: any, scr: any) => { x: number; y: number };
  worldToScreen: (p: { x: number; y: number }, cam: any, scr: any) => { x: number; y: number };
  anchorToTopLeftWorld: (t: { x: number; y: number; w: number; h: number; anchor?: string }) => { x: number; y: number };
  uiNodeForId: (id: string, model: any) => { ui: any };
}): SegmentPlacementController {
  const { stage, engine } = opts;

  // Hover ring (vertex hint) while drawing line graphs.
  let hoverSvg: SVGSVGElement | null = null;
  let hoverRing: SVGCircleElement | null = null;

  let segmentDraft:
    | null
    | {
        // Start/end are in the chosen model space:
        // - world: world coordinates
        // - screen: normalized fractions (0..1) to stay stable under resize
        // `origin` is the first point in a polyline draft (used for closing).
        origin: { x: number; y: number };
        start: { x: number; y: number };
        space: Space;
        // For preview we render in overlay pixels.
        lastEndScreen: { x: number; y: number };
        previewSvg: SVGSVGElement;
        lineEl: SVGLineElement;
        startDot: SVGCircleElement;
        endDot: SVGCircleElement;
        kind: "arrow" | "line";
        nSegments: number;
      } = null;

  // IMPORTANT: `engine.setModel()` clears the engine overlay DOM subtree.
  // The segment-draft preview must live OUTSIDE that subtree, otherwise it disappears after the first segment.
  const getDraftLayerEl = () => {
    let el = stage.querySelector<HTMLElement>(".ip-draft-layer");
    if (!el) {
      el = document.createElement("div");
      el.className = "ip-draft-layer";
      el.style.position = "absolute";
      el.style.inset = "0";
      el.style.pointerEvents = "none";
      el.style.zIndex = "2"; // above the engine overlay (z=1)
      stage.appendChild(el);
    }
    return el;
  };

  const ensureHoverRing = () => {
    const overlay = getDraftLayerEl();
    if (!hoverSvg) {
      hoverSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      hoverSvg.style.position = "absolute";
      hoverSvg.style.inset = "0";
      hoverSvg.style.width = "100%";
      hoverSvg.style.height = "100%";
      hoverSvg.style.overflow = "visible";
      hoverSvg.style.pointerEvents = "none";
      hoverSvg.setAttribute("preserveAspectRatio", "none");
      overlay.appendChild(hoverSvg);
    }
    if (!hoverRing) {
      hoverRing = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hoverRing.setAttribute("cx", "0");
      hoverRing.setAttribute("cy", "0");
      hoverRing.setAttribute("r", "10");
      hoverRing.setAttribute("fill", "rgba(0,0,0,0)");
      hoverRing.setAttribute("stroke", "rgba(110,168,255,0.92)");
      hoverRing.setAttribute("stroke-width", "2");
      hoverRing.setAttribute("vector-effect", "non-scaling-stroke");
      hoverRing.style.display = "none";
      hoverSvg.appendChild(hoverRing);
    }
    const w = Math.max(1, overlay.clientWidth);
    const h = Math.max(1, overlay.clientHeight);
    hoverSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  };

  const setHoverRing = (pScreen: { x: number; y: number } | null) => {
    if (!hoverRing) return;
    if (!pScreen) {
      hoverRing.style.display = "none";
      return;
    }
    hoverRing.setAttribute("cx", String(pScreen.x));
    hoverRing.setAttribute("cy", String(pScreen.y));
    hoverRing.style.display = "";
  };

  const snapWorldPoint = (p: { x: number; y: number }, cam: any) => {
    const { spacing0, spacing1, t } = opts.gridSpacingForZoom(Number(cam?.zoom ?? 1));
    const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
    const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
    return { x: snap(p.x), y: snap(p.y) };
  };

  const toModelPoint = (screenPx: { x: number; y: number }, space: Space, cam: any, scr: any) => {
    if (space === "world") return opts.screenToWorld(screenPx, cam as any, scr as any);
    // Screen-space nodes use normalized fractions in the model.
    return { x: screenPx.x / Math.max(1, Number(scr?.w ?? 1)), y: screenPx.y / Math.max(1, Number(scr?.h ?? 1)) };
  };

  const toScreenPx = (modelPt: { x: number; y: number }, space: Space, cam: any, scr: any) => {
    if (space === "world") return opts.worldToScreen(modelPt, cam as any, scr as any);
    return { x: modelPt.x * Math.max(1, Number(scr?.w ?? 1)), y: modelPt.y * Math.max(1, Number(scr?.h ?? 1)) };
  };

  const toCommitPoint = (modelPt: { x: number; y: number }, space: Space, scr: any) => {
    // addLineFromTo/addArrowFromTo expect:
    // - world: world coords
    // - screen: overlay pixels
    if (space === "world") return modelPt;
    return { x: modelPt.x * Math.max(1, Number(scr?.w ?? 1)), y: modelPt.y * Math.max(1, Number(scr?.h ?? 1)) };
  };

  const makeSegmentPreview = (kind: "arrow" | "line", overlay: HTMLElement) => {
    const WHITE = "rgba(255,255,255,0.92)";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    // Keep preview coordinates 1:1 with overlay pixels (no aspect letterboxing).
    svg.setAttribute("preserveAspectRatio", "none");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    if (kind === "arrow") {
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      marker.setAttribute("id", "arrowhead-preview");
      // Match engine arrow sizing:
      // - head height == 4 * strokeWidth  (stroke=4 => 16px)
      // - head length == 5 * strokeWidth  (stroke=4 => 20px)
      marker.setAttribute("markerUnits", "strokeWidth");
      marker.setAttribute("markerWidth", "5");
      marker.setAttribute("markerHeight", "4");
      marker.setAttribute("refX", "5");
      marker.setAttribute("refY", "2");
      marker.setAttribute("orient", "auto");
      const pth = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pth.setAttribute("d", "M 0 0 L 5 2 L 0 4 z");
      pth.setAttribute("fill", WHITE);
      marker.appendChild(pth);
      defs.appendChild(marker);
    }
    svg.appendChild(defs);

    const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
    ln.setAttribute("x1", "0");
    ln.setAttribute("y1", "0");
    ln.setAttribute("x2", "0");
    ln.setAttribute("y2", "0");
    ln.setAttribute("stroke", WHITE);
    ln.setAttribute("stroke-width", "4");
    ln.setAttribute("stroke-linecap", "round");
    ln.setAttribute("stroke-dasharray", "10 10");
    ln.setAttribute("vector-effect", "non-scaling-stroke");
    if (kind === "arrow") ln.setAttribute("marker-end", "url(#arrowhead-preview)");
    svg.appendChild(ln);

    const mkDot = () => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", "0");
      c.setAttribute("cy", "0");
      c.setAttribute("r", "6");
      c.setAttribute("fill", "rgba(15,17,24,0.35)");
      c.setAttribute("stroke", WHITE);
      c.setAttribute("stroke-width", "2");
      c.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(c);
      return c;
    };
    const startDot = mkDot();
    const endDot = mkDot();

    // Keep viewBox in sync with overlay pixels to avoid angle distortion.
    const syncViewBox = () => {
      const w = Math.max(1, overlay.clientWidth);
      const h = Math.max(1, overlay.clientHeight);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    };
    syncViewBox();

    overlay.appendChild(svg);
    return { svg, lineEl: ln, startDot, endDot, syncViewBox };
  };

  const updateSegmentPreview = (draft: NonNullable<typeof segmentDraft>, endScreen: { x: number; y: number }) => {
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const startScreen = toScreenPx(draft.start, draft.space, cam as any, scr as any);
    draft.lineEl.setAttribute("x1", String(startScreen.x));
    draft.lineEl.setAttribute("y1", String(startScreen.y));
    draft.lineEl.setAttribute("x2", String(endScreen.x));
    draft.lineEl.setAttribute("y2", String(endScreen.y));
    draft.startDot.setAttribute("cx", String(startScreen.x));
    draft.startDot.setAttribute("cy", String(startScreen.y));
    draft.endDot.setAttribute("cx", String(endScreen.x));
    draft.endDot.setAttribute("cy", String(endScreen.y));
    draft.lastEndScreen = endScreen;
  };

  const collectLineJunctions = (modelNow: any, space: Space) => {
    const junctions: Array<{ x: number; y: number }> = [];
    for (const n0 of (modelNow?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const { ui } = opts.uiNodeForId(String(n0.id), modelNow);
      const tN = (ui as any)?.transform ?? n0.transform ?? {};
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
      // NOTE: For screen space, tN.x/y/w/h are normalized fractions. Anchor math is identical.
      const tl = opts.anchorToTopLeftWorld({
        x: Number(tN.x ?? 0),
        y: Number(tN.y ?? 0),
        w: Number(tN.w ?? 1),
        h: Number(tN.h ?? 1),
        anchor: tN.anchor ?? "topLeft",
      });
      const w = Math.max(1e-9, Number(tN.w ?? 1));
      const h = Math.max(1e-9, Number(tN.h ?? 1));
      const q1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
      const q2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };
      junctions.push(q1, q2);
    }
    return junctions;
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (opts.getAppMode() !== "edit") return;
    const tool = opts.getTool();
    if (tool === "select") return;
    // Only left click should start/commit drawing. Right click cancels (handled by contextmenu).
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    const isSegmentTool = tool === "arrow" || tool === "line";
    // Don’t interfere with normal manipulation when clicking nodes/handles/UI.
    if (t.closest(".edit-toolbox") || t.closest(".modal") || t.closest(".mode-toggle")) return;
    if (t.closest(".handles") || t.closest(".anchor-dot")) return;

    // Draw mode must be fully isolated:
    // no selection, no pan, no drags of existing nodes. Placement owns the pointer event.
    ev.preventDefault();
    (ev as any).stopImmediatePropagation?.();

    const nodeHit = t.closest<HTMLElement>(".node");
    if (nodeHit) {
      // For text/bullets placement: never place when clicking existing nodes.
      if (!isSegmentTool) return;
      // For line/arrow placement: allow placing even "on top of" other nodes.
      // When a placement tool is active, the user's intent is to add a segment, not pan/drag existing nodes.
    }

    const r = stage.getBoundingClientRect();
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const space = opts.getSpace();
    let pos = toModelPoint(screenPos, space, cam as any, scr as any);

    if (tool === "text") {
      opts.addTextAt(pos, { space });
      return;
    }
    if (tool === "bullets") {
      opts.addBulletsAt(pos, { space });
      return;
    }
    if (tool === "arrow" || tool === "line") {
      const kind: "arrow" | "line" = tool === "line" ? "line" : "arrow";
      const overlay = getDraftLayerEl();

      // Shift snapping while placing:
      // - world: snap to junction if closer than grid; otherwise grid
      // - screen: snap to junction within tolerance
      {
        const modelNow = engine.getModel();
        const tolPx = 12;
        const tolPx2 = tolPx * tolPx;
        const toScreenPt = (p: { x: number; y: number }) => toScreenPx(p, space, cam as any, scr as any);
        const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          return dx * dx + dy * dy;
        };

        const junctions = collectLineJunctions(modelNow, space);
        const ps = toScreenPt(pos as any);
        let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
        for (const j of junctions) {
          const d2 = dist2px(toScreenPt(j), ps);
          if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
        }

        // Also consider the current draft start/origin (closing).
        if (segmentDraft && segmentDraft.space === space) {
          const dStart2 = dist2px(toScreenPt(segmentDraft.start), ps);
          const dOrigin2 = dist2px(toScreenPt(segmentDraft.origin), ps);
          const bestDraft =
            dStart2 <= dOrigin2 ? { p: segmentDraft.start, d2: dStart2 } : { p: segmentDraft.origin, d2: dOrigin2 };
          if (!bestJ || bestDraft.d2 < bestJ.d2) bestJ = bestDraft;
        }

        // CRITICAL (requested):
        // If the user clicks near an existing vertex, ALWAYS snap the click to that vertex so the new edge
        // reuses the same join id (merging instead of creating a "new" vertex).
        // Shift is then used for grid snapping when NOT close to a vertex.
        if (kind === "line" && bestJ && bestJ.d2 <= tolPx2) {
          pos = bestJ.p as any;
        }

        if (ev.shiftKey) {
          if (space === "world") {
            const gridPt = snapWorldPoint(pos as any, cam as any);
            const gridD2 = dist2px(toScreenPt(gridPt), ps);
            if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) pos = bestJ.p as any;
            else pos = gridPt as any;
          } else {
            if (bestJ && bestJ.d2 <= tolPx2) pos = bestJ.p as any;
          }
        }
      }

      const posScreen = toScreenPx(pos as any, space, cam as any, scr as any);

      if (!segmentDraft) {
        // First click: set the base anchor and start showing dashed hover preview.
        const { svg, lineEl, startDot, endDot, syncViewBox } = makeSegmentPreview(kind, overlay);
        segmentDraft = { origin: pos, start: pos, space, lastEndScreen: posScreen, previewSvg: svg, lineEl, startDot, endDot, kind, nSegments: 0 };
        syncViewBox();
        updateSegmentPreview(segmentDraft, posScreen);
      } else {
        // Next click: commit node to the model.
        if (segmentDraft.kind !== kind || segmentDraft.space !== space) {
          // If the user switched tool/space mid-draft, cancel and restart cleanly.
          segmentDraft.previewSvg.remove();
          segmentDraft = null;
          const { svg, lineEl, startDot, endDot, syncViewBox } = makeSegmentPreview(kind, overlay);
          segmentDraft = { origin: pos, start: pos, space, lastEndScreen: posScreen, previewSvg: svg, lineEl, startDot, endDot, kind, nSegments: 0 };
          syncViewBox();
          updateSegmentPreview(segmentDraft, posScreen);
        } else {
          const start = segmentDraft.start;
          if (kind === "line") {
            // Polyline behavior:
            // - clicking back onto the start point should FINISH (close or cancel),
            //   not create a zero-length segment that leaves the preview "stuck".
            const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              return dx * dx + dy * dy;
            };
            const CLOSE_TOL_PX2 = 12 * 12;
            const startScreenNow = toScreenPx(segmentDraft.start, space, cam as any, scr as any);
            const originScreenNow = toScreenPx(segmentDraft.origin, space, cam as any, scr as any);
            const isOnStart = dist2(posScreen, startScreenNow) <= CLOSE_TOL_PX2;
            const isOnOrigin = dist2(posScreen, originScreenNow) <= CLOSE_TOL_PX2;

            // If user clicks same point as current start:
            // - if no segments yet, treat as cancel (exit draft)
            // - otherwise ignore (no-op)
            if (isOnStart) {
              if (segmentDraft.nSegments === 0) {
                segmentDraft.previewSvg.remove();
                segmentDraft = null;
              }
              // else: keep drafting (no-op) to avoid emitting zero-length segment
            } else if (isOnOrigin && segmentDraft.nSegments > 0) {
              // Close: add final segment to origin and finish draft.
              opts.addLineFromTo(toCommitPoint(start, space, scr), toCommitPoint(segmentDraft.origin, space, scr), { space, select: true });
              segmentDraft.previewSvg.remove();
              segmentDraft = null;
            } else {
              // Normal segment: commit and continue drafting.
              opts.addLineFromTo(toCommitPoint(start, space, scr), toCommitPoint(pos, space, scr), { space, select: false });
              segmentDraft.start = pos;
              segmentDraft.nSegments += 1;
              updateSegmentPreview(segmentDraft, posScreen);
            }
          } else {
            // Arrow behavior: single segment, then stop.
            segmentDraft.previewSvg.remove();
            segmentDraft = null;
            opts.addArrowFromTo(toCommitPoint(start, space, scr), toCommitPoint(pos, space, scr), { space });
          }
        }
      }
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
    }
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (opts.getAppMode() !== "edit") return;
    const tool = opts.getTool();
    const canShow = tool === "line" || (segmentDraft && segmentDraft.kind === "line");
    if (!canShow) return;
    // While in draw mode (or with an active draft), suppress all other interactions (pan/selection).
    if (tool !== "select") {
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
    }
    const r = stage.getBoundingClientRect();
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const screenPos = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    const space = segmentDraft ? segmentDraft.space : opts.getSpace();
    ensureHoverRing();
    let pos = toModelPoint(screenPos, space, cam as any, scr as any);
    const modelNow = engine.getModel();
    const tolPx = 12;
    const tolPx2 = tolPx * tolPx;
    const toScreenPt = (p: { x: number; y: number }) => toScreenPx(p, space, cam as any, scr as any);
    const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };

    const junctions = collectLineJunctions(modelNow, space);
    const ps = toScreenPt(pos as any);
    let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
    for (const j of junctions) {
      const d2 = dist2px(toScreenPt(j), ps);
      if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
    }
    // Also consider the current draft start/origin (closing).
    if (segmentDraft && segmentDraft.space === space) {
      const dStart2 = dist2px(toScreenPt(segmentDraft.start), ps);
      const dOrigin2 = dist2px(toScreenPt(segmentDraft.origin), ps);
      const bestDraft = dStart2 <= dOrigin2 ? { p: segmentDraft.start, d2: dStart2 } : { p: segmentDraft.origin, d2: dOrigin2 };
      if (!bestJ || bestDraft.d2 < bestJ.d2) bestJ = bestDraft;
    }

    // Always show the hover ring when close to a vertex/junction (even without Shift).
    if (bestJ && bestJ.d2 <= tolPx2) setHoverRing(toScreenPt(bestJ.p));
    else setHoverRing(null);

    // Shift: snap to vertex/junction (prefer over grid).
    if (ev.shiftKey) {
      if (space === "world") {
        const gridPt = snapWorldPoint(pos as any, cam as any);
        const gridD2 = dist2px(toScreenPt(gridPt), ps);
        if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) pos = bestJ.p as any;
        else pos = gridPt as any;
      } else {
        if (bestJ && bestJ.d2 <= tolPx2) pos = bestJ.p as any;
      }
    }

    if (segmentDraft) {
      const posScreen = toScreenPx(pos as any, segmentDraft.space, cam as any, scr as any);
      // Keep preview stroke matching final canvas stroke scaling (world space scales with zoom).
      const z = segmentDraft.space === "world" ? Number(cam.zoom ?? 1) : 1;
      const previewStroke = 4 * z;
      segmentDraft.lineEl.setAttribute("stroke-width", String(previewStroke));
      segmentDraft.lineEl.setAttribute("stroke-dasharray", `${10 * z} ${10 * z}`);
      // Keep viewBox stable with overlay resizing.
      const overlay = getDraftLayerEl();
      const w = Math.max(1, overlay.clientWidth);
      const h = Math.max(1, overlay.clientHeight);
      segmentDraft.previewSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      updateSegmentPreview(segmentDraft, posScreen);
      // While a segment draft is active, never let background pan handlers run.
      ev.preventDefault();
      (ev as any).stopImmediatePropagation?.();
    }
  };

  // Keep preview stable under resize (update viewBox + recompute start point mapping).
  const ro = new ResizeObserver(() => {
    try {
      if (!segmentDraft) return;
      const overlay = getDraftLayerEl();
      const w = Math.max(1, overlay.clientWidth);
      const h = Math.max(1, overlay.clientHeight);
      segmentDraft.previewSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      updateSegmentPreview(segmentDraft, segmentDraft.lastEndScreen);
    } catch {
      // ignore
    }
  });
  try {
    ro.observe(getDraftLayerEl());
  } catch {
    // ignore
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    if (segmentDraft) {
      segmentDraft.previewSvg.remove();
      segmentDraft = null;
      ev.preventDefault();
    }
  };

  const onContextMenu = (ev: MouseEvent) => {
    if (opts.getAppMode() !== "edit") return;
    ev.preventDefault();
    if (segmentDraft) {
      segmentDraft.previewSvg.remove();
      segmentDraft = null;
      return; // cancel preview only
    }
    opts.clearSelection();
  };

  const destroy = () => {
    try {
      if (segmentDraft) segmentDraft.previewSvg.remove();
    } catch {}
    segmentDraft = null;
    try {
      ro.disconnect();
    } catch {}
    try {
      if (hoverSvg) hoverSvg.remove();
    } catch {}
    hoverSvg = null;
    hoverRing = null;
  };

  return {
    onPointerDown: (ev) => (onPointerDown(ev), !!(ev as any).defaultPrevented),
    onPointerMove: (ev) => (onPointerMove(ev), !!(ev as any).defaultPrevented),
    onKeyDown: (ev) => (onKeyDown(ev), !!(ev as any).defaultPrevented),
    onContextMenu: (ev) => (onContextMenu(ev), !!(ev as any).defaultPrevented),
    destroy,
  };
}
