import { cursorForResize } from "./cursors";

export const createSelectionRuntime = (deps: {
  store: any;
  stage: HTMLElement;
  overlay: HTMLElement;
  groupDescendants: (groupId: string) => any[];
  isInteractive: (node: any) => boolean;
  cameraForScreen: () => any;
  worldToScreen: (p: { x: number; y: number }, cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  worldToScreenScale: (cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  screenSpaceToPx: (p: { x: number; y: number }, screen: { w: number; h: number }) => { x: number; y: number };
  screenSpaceSizeToPx: (w: number, h: number, screen: { w: number; h: number }) => { wPx: number; hPx: number };
  screenPxToSpace: (px: number, py: number, screen: { w: number; h: number }) => { x: number; y: number };
  screenToWorld: (p: { x: number; y: number }, cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  anchorFrac: (anchor: any) => { ax: number; ay: number };
  isNodeInteractiveInMode: (mode: string, node: any) => boolean;
  cursorAngleYourForHandle: (rotYour: number, handle: any) => number;
  cursorForRotate: (deg: number) => string;
  toSvgAngle: (angle: number) => number;
  snapAngle: (deg: number, stepDeg: number) => number;
}) => {
  const distPointToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const denom = abx * abx + aby * aby;
    if (denom <= 1e-9) return Math.hypot(apx, apy);
    let t = (apx * abx + apy * aby) / denom;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    return Math.hypot(px - cx, py - cy);
  };

  const arrowLineHitPx = (node: any) => {
    const strokePx = Math.max(1, Number(node?.strokePx ?? 4));
    return Math.max(20, strokePx * 2.5);
  };

  const groupVisibleRectPx = (groupId: string) => {
    const groupNode = deps.store.model.nodes.find((n: any) => String(n.id) === String(groupId)) as any;
    if (!groupNode || groupNode.type !== "group") return null;
    const descendantRects = deps.groupDescendants(groupId)
      .map((child: any) => deps.overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(String(child.id))}"]`))
      .filter((el): el is HTMLElement => !!el && el.style.display !== "none")
      .map((el) => el.getBoundingClientRect());
    if (!descendantRects.length) return null;
    const stageRect = deps.stage.getBoundingClientRect();
    const minLeft = Math.min(...descendantRects.map((r) => r.left));
    const minTop = Math.min(...descendantRects.map((r) => r.top));
    const maxRight = Math.max(...descendantRects.map((r) => r.right));
    const maxBottom = Math.max(...descendantRects.map((r) => r.bottom));
    return {
      left: minLeft - stageRect.left,
      top: minTop - stageRect.top,
      right: maxRight - stageRect.left,
      bottom: maxBottom - stageRect.top,
      width: Math.max(1, maxRight - minLeft),
      height: Math.max(1, maxBottom - minTop),
      midX: (minLeft + maxRight) / 2 - stageRect.left,
      midY: (minTop + maxBottom) / 2 - stageRect.top,
    };
  };

  const localForNodePx = (node: any, clientX: number, clientY: number) => {
    const cam = deps.cameraForScreen();
    const sr = deps.stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;
    if (node?.type === "group") {
      const visibleRect = groupVisibleRectPx(String(node.id));
      if (visibleRect) {
        return {
          left: -visibleRect.width / 2,
          right: visibleRect.width / 2,
          top: -visibleRect.height / 2,
          bottom: visibleRect.height / 2,
          lx: px - visibleRect.midX,
          ly: py - visibleRect.midY,
          rotDeg: 0,
          zoom: 1,
        };
      }
    }
    const isWorld = node.space !== "screen";
    const zoom = isWorld ? cam.zoom : 1;
    const worldScale = deps.worldToScreenScale(cam, screen);
    const sizePx = isWorld
      ? { wPx: node.transform.w * worldScale.x, hPx: node.transform.h * worldScale.y }
      : deps.screenSpaceSizeToPx(node.transform.w, node.transform.h, screen);
    const { ax, ay } = deps.anchorFrac(node.transform.anchor);
    const left = -ax * sizePx.wPx;
    const right = (1 - ax) * sizePx.wPx;
    const top = -ay * sizePx.hPx;
    const bottom = (1 - ay) * sizePx.hPx;
    const anchorScreen = isWorld
      ? deps.worldToScreen({ x: node.transform.x, y: node.transform.y }, cam, screen)
      : deps.screenSpaceToPx({ x: node.transform.x, y: node.transform.y }, screen);
    const dx = px - anchorScreen.x;
    const dy = py - anchorScreen.y;
    const rot = (node.transform.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      left,
      right,
      top,
      bottom,
      lx: dx * cos + dy * sin,
      ly: -dx * sin + dy * cos,
      rotDeg: node.transform.rotationDeg,
      zoom,
    };
  };

  const arrowEndpointsScreen = (node: any) => {
    const cam = deps.cameraForScreen();
    const sr = deps.stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const start = node.start ?? { x: 0, y: 0.5 };
    const end = node.end ?? { x: 1, y: 0.5 };
    const toScreen = (p: { x: number; y: number }) =>
      node.space !== "screen"
        ? deps.worldToScreen({ x: p.x, y: p.y }, cam, screen)
        : deps.screenSpaceToPx({ x: p.x, y: p.y }, screen);
    const s = toScreen(start);
    const e = toScreen(end);
    return { start: { x: s.x, y: s.y }, end: { x: e.x, y: e.y } };
  };

  const arrowPointFromClient = (node: any, clientX: number, clientY: number) => {
    const cam = deps.cameraForScreen();
    const sr = deps.stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;
    if (node.space !== "screen") return deps.screenToWorld({ x: px, y: py }, cam, screen);
    const sp = deps.screenPxToSpace(px, py, screen);
    return { x: sp.x, y: sp.y };
  };

  const pickNodeNearClientPoint = (clientX: number, clientY: number): string | null => {
    const cam = deps.cameraForScreen();
    const sr = deps.stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;
    let best: { id: string; z: number; order: number; area: number; isArrow: boolean } | null = null;
    for (let i = 0; i < deps.store.model.nodes.length; i++) {
      const n: any = deps.store.model.nodes[i];
      if (!n || n.visible === false) continue;
      if (!deps.isInteractive(n)) continue;
      if (n.type === "arrow") {
        const ends = arrowEndpointsScreen(n);
        const hit = distPointToSegment(px, py, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
        const threshold = arrowLineHitPx(n);
        if (hit > threshold) continue;
        const z = Number(n.zIndex ?? 0);
        if (!best || 0 < best.area || (best.area === 0 && (z > best.z || (z === best.z && (!best.isArrow || i > best.order))))) {
          best = { id: String(n.id), z, order: i, area: 0, isArrow: true };
        }
        continue;
      }
      const isWorld = n.space !== "screen";
      let left: number, right: number, top: number, bottom: number, lx: number, ly: number;
      if (n.type === "group") {
        const visibleRect = groupVisibleRectPx(String(n.id));
        if (!visibleRect) continue;
        left = -visibleRect.width / 2;
        right = visibleRect.width / 2;
        top = -visibleRect.height / 2;
        bottom = visibleRect.height / 2;
        lx = px - visibleRect.midX;
        ly = py - visibleRect.midY;
      } else {
        const worldScale = deps.worldToScreenScale(cam, screen);
        const sizePx = isWorld
          ? { wPx: n.transform.w * worldScale.x, hPx: n.transform.h * worldScale.y }
          : deps.screenSpaceSizeToPx(n.transform.w, n.transform.h, screen);
        const { ax, ay } = deps.anchorFrac(n.transform.anchor);
        left = -ax * sizePx.wPx;
        right = (1 - ax) * sizePx.wPx;
        top = -ay * sizePx.hPx;
        bottom = (1 - ay) * sizePx.hPx;
        const anchorScreen = isWorld
          ? deps.worldToScreen({ x: n.transform.x, y: n.transform.y }, cam, screen)
          : deps.screenSpaceToPx({ x: n.transform.x, y: n.transform.y }, screen);
        const dx = px - anchorScreen.x;
        const dy = py - anchorScreen.y;
        const rot = (n.transform.rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        lx = dx * cos + dy * sin;
        ly = -dx * sin + dy * cos;
      }
      const OUTSIDE = 20;
      if (!(lx >= left - OUTSIDE && lx <= right + OUTSIDE && ly >= top - OUTSIDE && ly <= bottom + OUTSIDE)) continue;
      const z = Number(n.zIndex ?? 0);
      const area = Math.max(1e-9, (right - left) * (bottom - top));
      if (!best || area < best.area || (area === best.area && (z > best.z || (z === best.z && !best.isArrow && i > best.order)))) {
        best = { id: String(n.id), z, order: i, area, isArrow: false };
      }
    }
    return best?.id ?? null;
  };

  const hitVirtualHandleAtClientPoint = (clientX: number, clientY: number, nodeId: string | null): { id: any; d2: number } | null => {
    if (!nodeId) return null;
    const node: any = deps.store.model.nodes.find((n: any) => n.id === nodeId);
    if (!node || !deps.isInteractive(node)) return null;
    const { left, right, top, bottom, lx, ly } = localForNodePx(node, clientX, clientY);
    const { ax, ay } = deps.anchorFrac(node.transform.anchor);
    const INSIDE = 8;
    const OUTSIDE = 15;
    const boxW = right - left;
    const boxH = bottom - top;
    const CORNER_ALONG = Math.max(6, Math.min(20, Math.min(boxW, boxH) / 3));
    const SIDE_ROTATE_ZONE = 18;
    const SIDE_SCALE_ZONE = 18;
    const SIDE_ANCHOR_ZONE = 14;
    const hideW = ax <= 1e-9;
    const hideE = ax >= 1 - 1e-9;
    const hideN = ay <= 1e-9;
    const hideS = ay >= 1 - 1e-9;
    const inYRange = ly >= top - OUTSIDE && ly <= bottom + OUTSIDE;
    const inXRange = lx >= left - OUTSIDE && lx <= right + OUTSIDE;
    const inLeftBand = !hideW && inYRange && lx >= left - OUTSIDE && lx <= left + INSIDE;
    const inRightBand = !hideE && inYRange && lx <= right + OUTSIDE && lx >= right - INSIDE;
    const inTopBand = !hideN && inXRange && ly >= top - OUTSIDE && ly <= top + INSIDE;
    const inBottomBand = !hideS && inXRange && ly <= bottom + OUTSIDE && ly >= bottom - INSIDE;
    const candidates: Array<{ id: any; d2: number }> = [];
    const push = (hid: any, ddx: number, ddy: number) => candidates.push({ id: hid, d2: ddx * ddx + ddy * ddy });
    const pushSideResize = (hid: "w" | "e", edgeX: number, y0: number, y1: number) => {
      if (y1 <= y0) return;
      const clampedY = Math.max(y0, Math.min(y1, ly));
      push(hid, lx - edgeX, ly - clampedY);
    };
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;
    const pushCompactSideSlots = (side: "left" | "right", edgeX: number, topHandle: any, anchorHandle: any, bottomHandle: any) => {
      const topResizeY = (top + midY) / 2;
      const bottomResizeY = (midY + bottom) / 2;
      const resizeHandle = side === "left" ? "w" : "e";
      push(topHandle, lx - edgeX, ly - top);
      push(resizeHandle, lx - edgeX, ly - topResizeY);
      push(anchorHandle, lx - edgeX, ly - midY);
      push(resizeHandle, lx - edgeX, ly - bottomResizeY);
      push(bottomHandle, lx - edgeX, ly - bottom);
    };
    if (inTopBand) {
      const alongL = lx - left;
      const alongR = right - lx;
      if (alongL <= CORNER_ALONG) push("nw", lx - left, ly - top);
      else if (alongR <= CORNER_ALONG) push("ne", lx - right, ly - top);
      else push("n", lx - midX, ly - top);
    }
    if (inBottomBand) {
      const alongL = lx - left;
      const alongR = right - lx;
      if (alongL <= CORNER_ALONG) push("sw", lx - left, ly - bottom);
      else if (alongR <= CORNER_ALONG) push("se", lx - right, ly - bottom);
      else push("s", lx - midX, ly - bottom);
    }
    if (inLeftBand) {
      const alongT = ly - top;
      const alongB = bottom - ly;
      const topResizeStart = top + SIDE_ROTATE_ZONE;
      const topResizeEnd = midY - SIDE_ANCHOR_ZONE;
      const bottomResizeStart = midY + SIDE_ANCHOR_ZONE;
      const bottomResizeEnd = bottom - SIDE_SCALE_ZONE;
      if (boxH <= SIDE_ROTATE_ZONE + SIDE_SCALE_ZONE + SIDE_ANCHOR_ZONE * 2) pushCompactSideSlots("left", left, "nw", "anchor:centerLeft", "sw");
      else if (alongT <= SIDE_ROTATE_ZONE) push("nw", lx - left, ly - top);
      else if (alongB <= SIDE_SCALE_ZONE) push("sw", lx - left, ly - bottom);
      else if (Math.abs(ly - midY) <= SIDE_ANCHOR_ZONE) push("anchor:centerLeft", lx - left, ly - midY);
      else {
        pushSideResize("w", left, topResizeStart, topResizeEnd);
        pushSideResize("w", left, bottomResizeStart, bottomResizeEnd);
      }
    }
    if (inRightBand) {
      const alongT = ly - top;
      const alongB = bottom - ly;
      const topResizeStart = top + SIDE_ROTATE_ZONE;
      const topResizeEnd = midY - SIDE_ANCHOR_ZONE;
      const bottomResizeStart = midY + SIDE_ANCHOR_ZONE;
      const bottomResizeEnd = bottom - SIDE_SCALE_ZONE;
      if (boxH <= SIDE_ROTATE_ZONE + SIDE_SCALE_ZONE + SIDE_ANCHOR_ZONE * 2) pushCompactSideSlots("right", right, "ne", "anchor:centerRight", "se");
      else if (alongT <= SIDE_ROTATE_ZONE) push("ne", lx - right, ly - top);
      else if (alongB <= SIDE_SCALE_ZONE) push("se", lx - right, ly - bottom);
      else if (Math.abs(ly - midY) <= SIDE_ANCHOR_ZONE) push("anchor:centerRight", lx - right, ly - midY);
      else {
        pushSideResize("e", right, topResizeStart, topResizeEnd);
        pushSideResize("e", right, bottomResizeStart, bottomResizeEnd);
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d2 - b.d2);
    return candidates[0]!;
  };

  const hitNodeId = (ev: PointerEvent): string | null => {
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.(".text-editor")) return null;
    return pickNodeNearClientPoint(ev.clientX, ev.clientY);
  };

  const hitHandle = (ev: PointerEvent): any | null => {
    const t = ev.target as HTMLElement | null;
    const h = t?.closest?.("[data-handle-id]") as HTMLElement | null;
    return h?.dataset?.handleId ?? null;
  };

  const updateHoverCursorAtClientPoint = (clientX: number, clientY: number, ev?: PointerEvent | null) => {
    if (deps.store.mode === "live") {
      const hoverId = pickNodeNearClientPoint(clientX, clientY);
      const hoverNode = hoverId ? (deps.store.model.nodes.find((n: any) => n.id === hoverId) as any) : null;
      if (!hoverNode || !deps.isNodeInteractiveInMode("live", hoverNode)) {
        deps.overlay.style.cursor = "";
        return;
      }
    }
    const selectedIds = deps.store.selectedIds ?? [];
    if (!selectedIds.length) {
      deps.overlay.style.cursor = "";
      return;
    }
    let best: { nodeId: string; h: { id: any; d2: number } } | null = null;
    for (const nodeId of selectedIds) {
      const h = hitVirtualHandleAtClientPoint(clientX, clientY, nodeId);
      if (!h) continue;
      if (!best || h.d2 < best.h.d2) best = { nodeId, h };
    }
    const nodeId = best?.nodeId ?? deps.store.selectedId ?? selectedIds[0]!;
    const next = (ev ? hitHandle(ev) : null) ?? best?.h ?? hitVirtualHandleAtClientPoint(clientX, clientY, nodeId);
    const handleId = (next as any)?.id ? (next as any).id : next;
    const nodeForCursor = nodeId ? (deps.store.model.nodes.find((n: any) => n.id === nodeId) as any) : null;
    const allowTransformCursor = nodeForCursor?.type !== "arrow";
    if (allowTransformCursor && handleId && String(handleId).startsWith("anchor:")) {
      deps.overlay.style.cursor = "pointer";
      return;
    }
    if (allowTransformCursor && nodeId && handleId && !String(handleId).startsWith("anchor:")) {
      const rotYour = -nodeForCursor.transform.rotationDeg;
      const isRotateCorner = handleId === "nw" || handleId === "ne";
      const angleYour = deps.cursorAngleYourForHandle(rotYour, handleId as any);
      deps.overlay.style.cursor = isRotateCorner
        ? deps.cursorForRotate(deps.toSvgAngle(angleYour))
        : cursorForResize(deps.toSvgAngle(deps.snapAngle(angleYour, 45)));
      return;
    }
    if (nodeId) {
      const node = deps.store.model.nodes.find((n: any) => n.id === nodeId) as any;
      if (node?.type === "arrow") {
        const ends = arrowEndpointsScreen(node);
        const dStart = Math.hypot(clientX - ends.start.x, clientY - ends.start.y);
        const dEnd = Math.hypot(clientX - ends.end.x, clientY - ends.end.y);
        const lineHit = distPointToSegment(clientX, clientY, ends.start.x, ends.start.y, ends.end.x, ends.end.y);
        const lineThreshold = arrowLineHitPx(node);
        const arrowLen = Math.hypot(ends.end.x - ends.start.x, ends.end.y - ends.start.y);
        const preferLine = arrowLen <= 20 && lineHit <= lineThreshold && lineHit <= Math.min(dStart, dEnd);
        deps.overlay.style.cursor = preferLine || lineHit <= lineThreshold ? "grab" : dStart <= 20 || dEnd <= 20 ? "pointer" : "";
        return;
      }
      deps.overlay.style.cursor = "grab";
      return;
    }
    deps.overlay.style.cursor = "";
  };

  return {
    distPointToSegment,
    arrowLineHitPx,
    groupVisibleRectPx,
    localForNodePx,
    arrowEndpointsScreen,
    arrowPointFromClient,
    pickNodeNearClientPoint,
    hitVirtualHandleAtClientPoint,
    hitNodeId,
    hitHandle,
    updateHoverCursorAtClientPoint,
  };
};
