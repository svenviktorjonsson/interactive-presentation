import type { Store } from "../core/store";

type Snapshot = { model: any; activeViewId: string; selectedId: string | null; selectedIds: string[] };

type TransformDeps = {
  store: Store & { activeViewId: string; selectedId: string | null; selectedIds: string[]; model: { nodes: any[] } };
  stage: HTMLElement;
  overlay: HTMLElement;
  dragStartPx: number;
  rotSnapDeg: number;
  cameraForScreen: () => { cx: number; cy: number; zoom: number };
  cameraForEdit: () => { cx: number; cy: number; zoom: number };
  groupDescendants: (groupId: string) => any[];
  groupVisibleRectPx: (groupId: string) => { midX: number; midY: number; width: number; height: number } | null;
  snapshotNow: () => Snapshot;
  pushUndo: (snap: Snapshot) => void;
  updateHandles: () => void;
  bumpZIndex: (targetIds: string[]) => void;
  screenToWorld: (p: { x: number; y: number }, cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  worldToScreen: (p: { x: number; y: number }, cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  worldToScreenScale: (cam: any, screen: { w: number; h: number }) => { x: number; y: number };
  screenSpaceToPx: (p: { x: number; y: number }, screen: { w: number; h: number }) => { x: number; y: number };
  anchorFrac: (anchor: any) => { ax: number; ay: number };
  snapTo: (v: number, step: number) => number;
  gridMajorStepWorld: (zoom: number, screenW: number) => number;
  cursorAngleYourForHandle: (rotYour: number, handle: any) => number;
  toSvgAngle: (yourAngleDeg: number) => number;
  cursorForRotate: (deg: number) => string;
  syncArrowTransform: (node: any) => void;
  docForNode: (node: any) => "presentation" | "notes";
  persistViewIdForNode: (node: any, activeViewId: string) => string;
  normalizeTransformForPersist: (store: Store, transform: any, viewId: string, space: string | undefined, groupId?: string | null) => any;
  normalizePointForPersist: (store: Store, point: { x: number; y: number }, viewId: string, space: string | undefined, groupId?: string | null) => { x: number; y: number };
  persistGeometry: (payload: any) => Promise<unknown> | void;
  persistArrow: (payload: any) => Promise<unknown> | void;
  bgPayload: (node: any) => Record<string, unknown>;
};

export const createTransformRuntime = (deps: TransformDeps) => {
  const groupChildStartsFor = (node: any) =>
    node.type === "group"
      ? deps.groupDescendants(node.id).map((n: any) => ({
          id: String(n.id),
          x: n.transform.x,
          y: n.transform.y,
          w: n.transform.w,
          h: n.transform.h,
          rotationDeg: n.transform.rotationDeg,
          fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : 0,
        }))
      : undefined;

  const buildTargetIds = (node: any) => {
    const id = String(node.id);
    const baseTargets = (deps.store.selectedIds?.length ? deps.store.selectedIds : [id]).includes(id)
      ? (deps.store.selectedIds?.length ? deps.store.selectedIds : [id])
      : [id];
    const groupChildIds = node.type === "group" ? deps.groupDescendants(node.id).map((n) => String(n.id)) : [];
    return Array.from(new Set([...baseTargets.map(String), ...groupChildIds]));
  };

  const createMoveOwner = (nodeId: string, ev: PointerEvent) => {
    const node = deps.store.model.nodes.find((n) => n.id === nodeId) as any;
    if (!node) return null;
    const targetIds = buildTargetIds(node);
    return {
      kind: "move",
      pointerId: ev.pointerId,
      nodeId,
      targetIds,
      zBumped: false,
      starts: targetIds
        .map((tid) => deps.store.model.nodes.find((n) => n.id === tid))
        .filter((n): n is any => !!n)
        .map((n) => ({
          id: String(n.id),
          x: n.transform.x,
          y: n.transform.y,
          start: n.type === "arrow" ? { ...(n.start ?? { x: 0, y: 0.5 }) } : undefined,
          end: n.type === "arrow" ? { ...(n.end ?? { x: 1, y: 0.5 }) } : undefined,
        })),
      groupChildStarts: groupChildStartsFor(node),
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startX: node.transform.x,
      startY: node.transform.y,
      dirty: false,
      startSnapshot: deps.snapshotNow(),
    };
  };

  const createRotateOwner = (nodeId: string, handle: any, ev: PointerEvent) => {
    const node = deps.store.model.nodes.find((n) => n.id === nodeId) as any;
    if (!node) return null;
    const cam = deps.cameraForScreen();
    const r = deps.stage.getBoundingClientRect();
    const screen = { w: r.width, h: r.height };
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    const wp = node.space !== "screen" ? deps.screenToWorld({ x: sx, y: sy }, cam, screen) : null;
    const ang0 =
      node.space === "screen"
        ? (() => {
            const anchorPx = deps.screenSpaceToPx({ x: node.transform.x, y: node.transform.y }, screen);
            return Math.atan2(sy - anchorPx.y, sx - anchorPx.x);
          })()
        : Math.atan2(wp!.y - node.transform.y, wp!.x - node.transform.x);
    const targetIds = buildTargetIds(node);
    return {
      kind: "rotate",
      pointerId: ev.pointerId,
      nodeId,
      targetIds,
      starts: targetIds
        .map((tid) => deps.store.model.nodes.find((n) => n.id === tid))
        .filter((n): n is any => !!n)
        .map((n) => ({ id: String(n.id), rotationDeg: n.transform.rotationDeg, x: n.transform.x, y: n.transform.y })),
      groupChildStarts: groupChildStartsFor(node),
      groupStart: node.type === "group" ? { x: node.transform.x, y: node.transform.y, w: node.transform.w, h: node.transform.h, rotationDeg: node.transform.rotationDeg } : undefined,
      corner: handle,
      startAngleRad: ang0,
      startRotationDeg: node.transform.rotationDeg,
      dirty: false,
      startSnapshot: deps.snapshotNow(),
    };
  };

  const createResizeOwner = (nodeId: string, handle: any, ev: PointerEvent) => {
    const node = deps.store.model.nodes.find((n) => n.id === nodeId) as any;
    if (!node) return null;
    const targetIds = buildTargetIds(node);
    for (const tid of targetIds) {
      const n = deps.store.model.nodes.find((x) => x.id === tid) as any;
      if (!n) continue;
      n.__resizing = true;
      n.__resizeHandle = handle;
      if (n.type === "text" || n.type === "bullets") n.__manualResize = true;
    }
    const groupVisualStart = node.type === "group" ? deps.groupVisibleRectPx(String(node.id)) : undefined;
    return {
      kind: "resize",
      pointerId: ev.pointerId,
      nodeId,
      targetIds,
      starts: targetIds
        .map((tid) => deps.store.model.nodes.find((n) => n.id === tid))
        .filter((n): n is any => !!n)
        .map((n) => ({ id: String(n.id), w: n.transform.w, h: n.transform.h, fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : 0 })),
      groupChildStarts: groupChildStartsFor(node),
      groupStart: node.type === "group" ? { x: node.transform.x, y: node.transform.y, w: node.transform.w, h: node.transform.h, rotationDeg: node.transform.rotationDeg } : undefined,
      groupVisualStart: groupVisualStart ? { midX: groupVisualStart.midX, midY: groupVisualStart.midY, width: groupVisualStart.width, height: groupVisualStart.height } : undefined,
      handle,
      startW: node.transform.w,
      startH: node.transform.h,
      startFontPx: node.type === "text" || node.type === "bullets" ? node.fontPx : 0,
      dirty: false,
      startSnapshot: deps.snapshotNow(),
    };
  };

  const applyPointerMove = (owner: any, ev: PointerEvent) => {
    if (!owner || (owner.kind !== "move" && owner.kind !== "rotate" && owner.kind !== "resize")) return false;
    if (owner.pointerId !== ev.pointerId) return false;
    if ((ev.buttons & 1) === 0) return false;
    if (owner.kind === "move") {
      const cam = deps.cameraForScreen();
      const dx = ev.clientX - owner.startClientX;
      const dy = ev.clientY - owner.startClientY;
      if (!owner.dirty) {
        if (Math.hypot(dx, dy) < deps.dragStartPx) return true;
        owner.dirty = true;
        if (!owner.zBumped) {
          deps.bumpZIndex(owner.targetIds ?? [String(owner.nodeId)]);
          owner.zBumped = true;
        }
      }
      const sr = deps.stage.getBoundingClientRect();
      const screen = { w: sr.width, h: sr.height };
      const primary = deps.store.model.nodes.find((n) => n.id === owner.nodeId) as any;
      const isScreen = primary?.space === "screen";
      let dX = isScreen ? dx / Math.max(1e-9, screen.w) : dx / Math.max(1e-9, cam.zoom * screen.w);
      let dY = isScreen ? dy / Math.max(1e-9, screen.h) : dy / Math.max(1e-9, cam.zoom * screen.h);
      if (ev.shiftKey) {
        if (isScreen) {
          const snapPx = 10;
          const nxRel = deps.snapTo((owner.startX + dX) * screen.w, snapPx) / Math.max(1e-9, screen.w);
          const nyRel = deps.snapTo((owner.startY + dY) * screen.h, snapPx) / Math.max(1e-9, screen.h);
          dX = nxRel - owner.startX;
          dY = nyRel - owner.startY;
        } else {
          const step = deps.gridMajorStepWorld(deps.cameraForEdit().zoom, screen.w);
          const nx = deps.snapTo(owner.startX + dX, step);
          const ny = deps.snapTo(owner.startY + dY, step);
          dX = nx - owner.startX;
          dY = ny - owner.startY;
        }
      }
      for (const s of owner.starts) {
        const node = deps.store.model.nodes.find((n) => n.id === s.id) as any;
        if (!node) continue;
        if (node.type === "arrow") {
          const sStart = s.start ?? node.start ?? { x: 0, y: 0.5 };
          const sEnd = s.end ?? node.end ?? { x: 1, y: 0.5 };
          node.start = { x: sStart.x + dX, y: sStart.y + dY };
          node.end = { x: sEnd.x + dX, y: sEnd.y + dY };
          deps.syncArrowTransform(node);
          continue;
        }
        node.transform.x = s.x + dX;
        node.transform.y = s.y + dY;
      }
      if (owner.groupChildStarts?.length) {
        for (const st of owner.groupChildStarts) {
          const node = deps.store.model.nodes.find((n) => n.id === st.id) as any;
          if (!node) continue;
          node.transform.x = st.x + dX;
          node.transform.y = st.y + dY;
        }
      }
      deps.updateHandles();
      return true;
    }
    if (owner.kind === "rotate") {
      const node = deps.store.model.nodes.find((n) => n.id === owner.nodeId) as any;
      if (!node) return true;
      const cam = deps.cameraForScreen();
      const r = deps.stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const ang1 =
        node.space === "screen"
          ? (() => {
              const anchorPx = deps.screenSpaceToPx({ x: node.transform.x, y: node.transform.y }, screen);
              return Math.atan2(sy - anchorPx.y, sx - anchorPx.x);
            })()
          : (() => {
              const wp = deps.screenToWorld({ x: sx, y: sy }, cam, screen);
              return Math.atan2(wp.y - node.transform.y, wp.x - node.transform.x);
            })();
      const d = ((ang1 - owner.startAngleRad) * 180) / Math.PI;
      let nextDeg = owner.startRotationDeg + d;
      if (ev.shiftKey) nextDeg = deps.snapTo(nextDeg, deps.rotSnapDeg);
      const deltaDeg = nextDeg - owner.startRotationDeg;
      if (node.type === "group" && owner.groupChildStarts && owner.groupStart) {
        for (const s of owner.starts) {
          const n = deps.store.model.nodes.find((x) => x.id === s.id) as any;
          if (!n) continue;
          n.transform.rotationDeg = s.rotationDeg + deltaDeg;
        }
        const rot = (deltaDeg * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        for (const st of owner.groupChildStarts) {
          const n = deps.store.model.nodes.find((x) => x.id === st.id) as any;
          if (!n) continue;
          const dx = st.x - owner.groupStart.x;
          const dy = st.y - owner.groupStart.y;
          n.transform.x = owner.groupStart.x + dx * cos - dy * sin;
          n.transform.y = owner.groupStart.y + dx * sin + dy * cos;
        }
      } else {
        for (const s of owner.starts) {
          const n = deps.store.model.nodes.find((x) => x.id === s.id) as any;
          if (!n) continue;
          n.transform.rotationDeg = s.rotationDeg + deltaDeg;
        }
      }
      owner.dirty = true;
      const rotYour = -(owner.startRotationDeg + deltaDeg);
      const yourAngle = deps.cursorAngleYourForHandle(rotYour, owner.corner);
      deps.overlay.style.cursor = deps.cursorForRotate(deps.toSvgAngle(yourAngle));
      deps.updateHandles();
      return true;
    }
    if (owner.kind === "resize") {
      const node = deps.store.model.nodes.find((n) => n.id === owner.nodeId) as any;
      if (!node) return true;
      const t = node.transform;
      const cam = deps.cameraForScreen();
      const r = deps.stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const clientPxX = ev.clientX - r.left;
      const clientPxY = ev.clientY - r.top;
      const isScreen = node.space === "screen";
      const scaleW = Math.max(1e-9, screen.w);
      const scaleH = Math.max(1e-9, screen.h);
      const worldScale = deps.worldToScreenScale(cam, screen);
      const useVisualGroupBox = Boolean(node.type === "group" && owner.groupVisualStart);
      const rot = useVisualGroupBox ? 0 : (t.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const startWpx = useVisualGroupBox ? Math.max(1e-9, owner.groupVisualStart.width) : isScreen ? owner.startW * scaleW : owner.startW * worldScale.x;
      const startHpx = useVisualGroupBox ? Math.max(1e-9, owner.groupVisualStart.height) : isScreen ? owner.startH * scaleH : owner.startH * worldScale.y;
      const anchorPx = useVisualGroupBox
        ? { x: owner.groupVisualStart.midX, y: owner.groupVisualStart.midY }
        : isScreen
          ? deps.screenSpaceToPx({ x: t.x, y: t.y }, screen)
          : deps.worldToScreen({ x: t.x, y: t.y }, cam, screen);
      const dxw = clientPxX - anchorPx.x;
      const dyw = clientPxY - anchorPx.y;
      const lx = dxw * cos + dyw * sin;
      const ly = -dxw * sin + dyw * cos;
      const { ax, ay } = useVisualGroupBox ? { ax: 0.5, ay: 0.5 } : deps.anchorFrac(t.anchor);
      const hnd = owner.handle;
      const applyGroupResize = (sx: number, sy: number) => {
        if (node.type !== "group" || !owner.groupChildStarts || !owner.groupStart) return;
        const rotG = (owner.groupStart.rotationDeg * Math.PI) / 180;
        const cosG = Math.cos(rotG);
        const sinG = Math.sin(rotG);
        for (const st of owner.groupChildStarts) {
          const n = deps.store.model.nodes.find((x) => x.id === st.id) as any;
          if (!n) continue;
          const dx = st.x - owner.groupStart.x;
          const dy = st.y - owner.groupStart.y;
          const lx = dx * cosG + dy * sinG;
          const ly = -dx * sinG + dy * cosG;
          const lx2 = lx * sx;
          const ly2 = ly * sy;
          const dx2 = lx2 * cosG - ly2 * sinG;
          const dy2 = lx2 * sinG + ly2 * cosG;
          n.transform.x = owner.groupStart.x + dx2;
          n.transform.y = owner.groupStart.y + dy2;
          n.transform.w = Math.max(1e-9, st.w * sx);
          n.transform.h = Math.max(1e-9, st.h * sy);
          if (n.type === "text" || n.type === "bullets") n.fontPx = Math.max(1, st.fontPx * sx);
        }
      };
      const isCorner = hnd === "nw" || hnd === "ne" || hnd === "sw" || hnd === "se";
      const minWpx = 25;
      const minHpx = 25;
      if (isCorner) {
        const xMin0 = -ax * startWpx;
        const xMax0 = (1 - ax) * startWpx;
        const yMin0 = -ay * startHpx;
        const yMax0 = (1 - ay) * startHpx;
        const cornerVec = hnd === "nw" ? { x: xMin0, y: yMin0 } : hnd === "ne" ? { x: xMax0, y: yMin0 } : hnd === "sw" ? { x: xMin0, y: yMax0 } : { x: xMax0, y: yMax0 };
        const denom = cornerVec.x * cornerVec.x + cornerVec.y * cornerVec.y;
        if (denom > 1e-9) {
          let s = (lx * cornerVec.x + ly * cornerVec.y) / denom;
          const minW = isScreen ? minWpx / scaleW : minWpx / Math.max(1e-9, cam.zoom * screen.w);
          const minH = isScreen ? minHpx / scaleH : minHpx / Math.max(1e-9, cam.zoom * screen.h);
          const sMin = Math.max(minW / Math.max(1e-9, owner.startW), minH / Math.max(1e-9, owner.startH));
          if (!Number.isFinite(s)) s = 1;
          s = Math.max(sMin, s);
          if (ev.shiftKey) {
            const wSnapPx = deps.snapTo(startWpx * s, isScreen ? 10 : deps.gridMajorStepWorld(deps.cameraForEdit().zoom, screen.w));
            s = Math.max(sMin, wSnapPx / Math.max(1e-9, startWpx));
          }
          const nextW = Math.max(minW, owner.startW * s);
          const nextH = Math.max(minH, owner.startH * s);
          t.w = nextW;
          t.h = nextH;
          if (node.type === "text" || node.type === "bullets") node.fontPx = Math.max(1, owner.startFontPx * s);
          for (const st of owner.starts) {
            if (st.id === owner.nodeId) continue;
            const n = deps.store.model.nodes.find((x) => x.id === st.id) as any;
            if (!n) continue;
            n.transform.w = Math.max(minW, st.w * s);
            n.transform.h = Math.max(minH, st.h * s);
            if (n.type === "text" || n.type === "bullets") n.fontPx = Math.max(1, st.fontPx * s);
          }
          applyGroupResize(s, s);
          owner.dirty = true;
          deps.updateHandles();
          return true;
        }
      }
      const minW = isScreen ? minWpx / scaleW : minWpx / Math.max(1e-9, cam.zoom * screen.w);
      const minH = isScreen ? minHpx / scaleH : minHpx / Math.max(1e-9, cam.zoom * screen.h);
      const step = isScreen ? 10 : deps.gridMajorStepWorld(deps.cameraForEdit().zoom, screen.w);
      const lxTarget = ev.shiftKey ? deps.snapTo(lx, step) : lx;
      const lyTarget = ev.shiftKey ? deps.snapTo(ly, step) : ly;
      let wNew = startWpx;
      let hNew = startHpx;
      const eps = 1e-9;
      if (hnd === "e") wNew = lxTarget / Math.max(eps, 1 - ax);
      if (hnd === "w") wNew = -lxTarget / Math.max(eps, ax);
      if (hnd === "s") hNew = lyTarget / Math.max(eps, 1 - ay);
      if (hnd === "n") hNew = -lyTarget / Math.max(eps, ay);
      if (!Number.isFinite(wNew)) wNew = t.w;
      if (!Number.isFinite(hNew)) hNew = t.h;
      let finalWpx = startWpx;
      let finalHpx = startHpx;
      if (isScreen) {
        const usesW = hnd === "e" || hnd === "w";
        const usesH = hnd === "n" || hnd === "s";
        const wPx = Math.max(minWpx, usesW ? wNew : startWpx);
        const hPx = Math.max(minHpx, usesH ? hNew : startHpx);
        finalWpx = wPx;
        finalHpx = hPx;
        t.w = wPx / scaleW;
        t.h = hPx / scaleH;
      } else {
        const wWorld = wNew / Math.max(1e-9, worldScale.x);
        const hWorld = hNew / Math.max(1e-9, worldScale.y);
        t.w = Math.max(minW, wWorld);
        t.h = Math.max(minH, hWorld);
        finalWpx = t.w * worldScale.x;
        finalHpx = t.h * worldScale.y;
      }
      owner.dirty = true;
      const sx = t.w / Math.max(1e-9, owner.startW);
      const sy = t.h / Math.max(1e-9, owner.startH);
      for (const st of owner.starts) {
        if (st.id === owner.nodeId) continue;
        const n = deps.store.model.nodes.find((x) => x.id === st.id) as any;
        if (!n) continue;
        n.transform.w = Math.max(minW, st.w * sx);
        n.transform.h = Math.max(minH, st.h * sy);
        if ((n.type === "text" || n.type === "bullets") && isCorner) n.fontPx = Math.max(1, st.fontPx * sx);
      }
      if ((node.type === "text" || node.type === "bullets") && isCorner) {
        const sW = t.w / Math.max(1e-9, owner.startW);
        node.fontPx = Math.max(1, owner.startFontPx * sW);
      }
      applyGroupResize(finalWpx / Math.max(1e-9, startWpx), finalHpx / Math.max(1e-9, startHpx));
      deps.updateHandles();
      return true;
    }
    return false;
  };

  const finishPointerUp = (owner: any) => {
    if (!owner || (owner.kind !== "move" && owner.kind !== "rotate" && owner.kind !== "resize")) return false;
    if (owner.kind === "resize") {
      const ids: string[] = owner.targetIds ?? [];
      const handle = String(owner.handle ?? "");
      const isEdgeHandle = handle === "n" || handle === "s" || handle === "e" || handle === "w";
      for (const id of ids) {
        const n = deps.store.model.nodes.find((x) => x.id === id) as any;
        if (!n) continue;
        if (n.__resizing) delete n.__resizing;
        if (n.__resizeHandle) delete n.__resizeHandle;
        if (n.__manualResize) delete n.__manualResize;
        if (n.type === "buttons") {
          if (isEdgeHandle) n.__uiScaleLock = true;
          else delete n.__uiScaleLock;
        }
      }
    }
    if (owner.dirty && owner.startSnapshot) deps.pushUndo(owner.startSnapshot);
    if (owner.dirty) {
      if (owner.kind === "move" && !owner.zBumped) {
        const targetIds: string[] = owner.targetIds && owner.targetIds.length ? owner.targetIds : (owner.nodeId ? [String(owner.nodeId)] : []);
        deps.bumpZIndex(targetIds);
      }
      const baseIds: string[] = owner.targetIds ?? [owner.nodeId].filter(Boolean);
      const ownerNode = owner.nodeId ? deps.store.model.nodes.find((x) => x.id === owner.nodeId) : null;
      const persistIds = ownerNode && ownerNode.type === "group" ? [String(ownerNode.id)] : baseIds;
      for (const id of persistIds) {
        const n: any = deps.store.model.nodes.find((x) => x.id === id);
        if (!n) continue;
        const viewId = deps.persistViewIdForNode(n, deps.store.activeViewId);
        if (n.type !== "arrow") {
          const groupId = n.groupId ? String(n.groupId) : null;
          void deps.persistGeometry({
            id: String(n.id),
            viewId,
            transform: deps.normalizeTransformForPersist(deps.store, n.transform, viewId, n.space, groupId),
            fontPx: n.type === "text" || n.type === "bullets" ? n.fontPx : undefined,
            zIndex: n.zIndex,
            doc: deps.docForNode(n),
            space: groupId ? "group" : n.space,
            groupId,
          });
        }
        if (n.type === "arrow") {
          const groupId = n.groupId ? String(n.groupId) : null;
          const start = deps.normalizePointForPersist(deps.store, n.start ?? { x: 0, y: 0.5 }, viewId, n.space, groupId);
          const end = deps.normalizePointForPersist(deps.store, n.end ?? { x: 1, y: 0.5 }, viewId, n.space, groupId);
          const color = typeof n.color === "string" && n.color.includes(",") ? "white" : n.color;
          void deps.persistArrow({
            id: String(n.id),
            viewId,
            start,
            end,
            color,
            strokePx: n.strokePx,
            zIndex: n.zIndex,
            doc: deps.docForNode(n),
            space: groupId ? "group" : n.space,
            ...deps.bgPayload(n),
            groupId,
          });
        }
      }
    }
    deps.updateHandles();
    return true;
  };

  return {
    createMoveOwner,
    createRotateOwner,
    createResizeOwner,
    applyPointerMove,
    finishPointerUp,
  };
};
