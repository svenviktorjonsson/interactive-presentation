import type { Store } from "./store";
import { activeView } from "./store";
import { screenToWorld, worldToScreen } from "./geom";
import type { Anchor } from "./model";
import { createHandlesView, anchorFrac, type HandleId } from "../editor/handles";
import { cursorForResize, cursorForRotate } from "../editor/cursors";

type PointerOwner =
  | null
  | {
      kind: "move";
      pointerId: number;
      nodeId: string;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      dirty: boolean;
    }
  | {
      kind: "rotate";
      pointerId: number;
      nodeId: string;
      corner: "nw" | "ne";
      startAngleRad: number;
      startRotationDeg: number;
    }
  | {
      kind: "resize";
      pointerId: number;
      nodeId: string;
      handle: Exclude<HandleId, "rot">;
      startW: number;
      startH: number;
      startFontPx: number;
    };

const DRAG_START_PX = 3;
const GRID_STEP_WORLD = 10;
const ROT_SNAP_DEG = 15;

const snapTo = (v: number, step: number) => {
  if (!Number.isFinite(v) || !Number.isFinite(step) || step <= 0) return v;
  return Math.round(v / step) * step;
};

// Cursor angles are authored/understood in Viktor's coordinate system:
// - + angle is CCW
// - +y is up (mathematical)
//
// SVG/CSS are screen coordinates (+y down), so positive rotation appears clockwise.
// Mapping: svgAngle = -yourAngle
const toSvgAngle = (yourAngleDeg: number) => -yourAngleDeg;

const snapAngle = (deg: number, stepDeg: number) => snapTo(deg, stepDeg);

const cursorAngleYourForHandle = (rotYour: number, handle: Exclude<HandleId, "rot">) => {
  // Handle "orientation" angles expressed in Viktor coordinates (CCW-positive).
  // These are the same values validated in next/tools/cursors/raw-cursors.html.
  if (handle === "e" || handle === "w") return rotYour + 0;
  if (handle === "n" || handle === "s") return rotYour + 90;
  if (handle === "ne") return rotYour + 45;
  if (handle === "sw") return rotYour - 135;
  if (handle === "nw") return rotYour + 135;
  if (handle === "se") return rotYour - 45;
  return rotYour;
};

export function attachStateMachine(opts: { stage: HTMLElement; overlay: HTMLElement; store: Store }) {
  const { stage, overlay, store } = opts;
  let owner: PointerOwner = null;
  const handles = createHandlesView(overlay);

  const hitNodeId = (ev: PointerEvent): string | null => {
    const t = ev.target as HTMLElement | null;
    const el = t?.closest?.(".node") as HTMLElement | null;
    const id = String(el?.dataset?.nodeId ?? "");
    return id || null;
  };

  const hitHandle = (ev: PointerEvent): HandleId | null => {
    const t = ev.target as HTMLElement | null;
    const h = t?.closest?.("[data-handle-id]") as HTMLElement | null;
    return (h?.dataset?.handleId as HandleId | undefined) ?? null;
  };

  const pickNodeNearClientPoint = (clientX: number, clientY: number): string | null => {
    const cam = activeView(store).camera;
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;

    // Prefer highest zIndex.
    let best: { id: string; z: number; order: number } | null = null;
    for (let i = 0; i < store.model.nodes.length; i++) {
      const n: any = store.model.nodes[i];
      if (!n || n.visible === false || n.space !== "world") continue;
      const wPx = n.transform.w * cam.zoom;
      const hPx = n.transform.h * cam.zoom;
      const { ax, ay } = anchorFrac(n.transform.anchor);
      const left = -ax * wPx;
      const right = (1 - ax) * wPx;
      const top = -ay * hPx;
      const bottom = (1 - ay) * hPx;
      const anchorScreen = worldToScreen({ x: n.transform.x, y: n.transform.y }, cam, screen);
      const dx = px - anchorScreen.x;
      const dy = py - anchorScreen.y;
      const rot = (n.transform.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;

      const OUTSIDE = 20;
      const inExpanded = lx >= left - OUTSIDE && lx <= right + OUTSIDE && ly >= top - OUTSIDE && ly <= bottom + OUTSIDE;
      if (!inExpanded) continue;

      const z = Number(n.zIndex ?? 0);
      if (!best || z > best.z || (z === best.z && i > best.order)) best = { id: String(n.id), z, order: i };
    }
    return best?.id ?? null;
  };

  const localForNodePx = (node: any, clientX: number, clientY: number) => {
    const cam = activeView(store).camera;
    const sr = stage.getBoundingClientRect();
    const screen = { w: sr.width, h: sr.height };
    const px = clientX - sr.left;
    const py = clientY - sr.top;

    const wPx = node.transform.w * cam.zoom;
    const hPx = node.transform.h * cam.zoom;
    const { ax, ay } = anchorFrac(node.transform.anchor);
    const left = -ax * wPx;
    const right = (1 - ax) * wPx;
    const top = -ay * hPx;
    const bottom = (1 - ay) * hPx;

    const anchorScreen = worldToScreen({ x: node.transform.x, y: node.transform.y }, cam, screen);
    const dx = px - anchorScreen.x;
    const dy = py - anchorScreen.y;
    const rot = (node.transform.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return { left, right, top, bottom, lx, ly, rotDeg: node.transform.rotationDeg, zoom: cam.zoom };
  };

  const hitVirtualHandleAtClientPoint = (clientX: number, clientY: number, nodeId: string | null): HandleId | null => {
    if (!nodeId) return null;
    const node = store.model.nodes.find((n) => n.id === nodeId);
    if (!node || node.space !== "world") return null;
    const { left, right, top, bottom, lx, ly } = localForNodePx(node as any, clientX, clientY);
    const { ax, ay } = anchorFrac((node as any).transform.anchor);

    // Hover geometry
    const INSIDE = 5;
    const OUTSIDE = 20;
    const CORNER_ALONG = 20;

    // Disable anchor-side handles (same rule as existing UI)
    const hideW = ax <= 1e-9;
    const hideE = ax >= 1 - 1e-9;
    const hideN = ay <= 1e-9;
    const hideS = ay >= 1 - 1e-9;

    const inLeftBand = !hideW && lx >= left - OUTSIDE && lx <= left + INSIDE;
    const inRightBand = !hideE && lx <= right + OUTSIDE && lx >= right - INSIDE;
    const inTopBand = !hideN && ly >= top - OUTSIDE && ly <= top + INSIDE;
    const inBottomBand = !hideS && ly <= bottom + OUTSIDE && ly >= bottom - INSIDE;

    const candidates: Array<{ id: HandleId; d2: number }> = [];
    const push = (hid: HandleId, ddx: number, ddy: number) => candidates.push({ id: hid, d2: ddx * ddx + ddy * ddy });

    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    // Four sides, each split into 3 regions: corner | middle | corner.
    if (inTopBand) {
      const alongL = lx - left;
      const alongR = right - lx;
      if (alongL <= CORNER_ALONG) push("nw", lx - left, ly - top);
      else if (alongR <= CORNER_ALONG) push("ne", lx - right, ly - top);
      else push("n", lx - midX, ly - top); // middle: closest-to-center wins naturally
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
      if (alongT <= CORNER_ALONG) push("nw", lx - left, ly - top);
      else if (alongB <= CORNER_ALONG) push("sw", lx - left, ly - bottom);
      else push("w", lx - left, ly - midY);
    }
    if (inRightBand) {
      const alongT = ly - top;
      const alongB = bottom - ly;
      if (alongT <= CORNER_ALONG) push("ne", lx - right, ly - top);
      else if (alongB <= CORNER_ALONG) push("se", lx - right, ly - bottom);
      else push("e", lx - right, ly - midY);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d2 - b.d2);
    return candidates[0]!.id;
  };

  const updateHandles = () => {
    const id = store.selectedId;
    if (!id) {
      handles.hide();
      return;
    }
    const node = store.model.nodes.find((n) => n.id === id);
    const nodeEl = overlay.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(id)}"]`);
    if (!node || !nodeEl) {
      handles.hide();
      return;
    }
    handles.showFor(nodeEl, node.transform, node.transform.anchor);
  };

  const applyAnchorChange = (id: string, nextAnchor: Anchor) => {
    const node = store.model.nodes.find((n) => n.id === id);
    if (!node || node.space !== "world") return;
    const t = node.transform;
    const { ax: ax0, ay: ay0 } = anchorFrac(t.anchor);
    const { ax: ax1, ay: ay1 } = anchorFrac(nextAnchor);
    // Compute top-left in world from old anchor
    const tlx = t.x - ax0 * t.w;
    const tly = t.y - ay0 * t.h;
    // Recompute anchor position for new anchor keeping top-left fixed
    node.transform = { ...t, anchor: nextAnchor, x: tlx + ax1 * t.w, y: tly + ay1 * t.h };
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;

    // Handle clicks (anchor dots etc) take priority.
    const h = hitHandle(ev);
    if (h && h.startsWith("anchor:")) {
      const a = h.slice("anchor:".length) as Anchor;
      const id = store.selectedId ?? hitNodeId(ev);
      if (id) {
        store.selectedId = id;
        applyAnchorChange(id, a);
        updateHandles();
        ev.preventDefault();
        return;
      }
    }

    // Resize/rotate handles (DOM handle or virtual hover band)
    const targetId = store.selectedId ?? hitNodeId(ev) ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
    const hv = h && !h.startsWith("anchor:") ? h : hitVirtualHandleAtClientPoint(ev.clientX, ev.clientY, targetId);
    if (hv) {
      const id = targetId;
      if (!id) return;
      store.selectedId = id;
      const node = store.model.nodes.find((n) => n.id === id);
      if (!node || node.space !== "world") return;
      updateHandles();

      const cam = activeView(store).camera;
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const wp = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);

      // Rotation: use upper corners (nw/ne). No separate rotation handle.
      const isRotateCorner = hv === "nw" || hv === "ne";
      if (isRotateCorner) {
        const ang0 = Math.atan2(wp.y - node.transform.y, wp.x - node.transform.x);
        owner = { kind: "rotate", pointerId: ev.pointerId, nodeId: id, corner: hv as any, startAngleRad: ang0, startRotationDeg: node.transform.rotationDeg };
      } else {
        owner = {
          kind: "resize",
          pointerId: ev.pointerId,
          nodeId: id,
          handle: hv as any,
          startW: node.transform.w,
          startH: node.transform.h,
          startFontPx: node.type === "text" ? node.fontPx : 0,
        };
      }

      try {
        overlay.setPointerCapture(ev.pointerId);
      } catch (e) {
        console.error("[next][state] setPointerCapture failed", e);
      }
      ev.preventDefault();
      return;
    }

    const id = hitNodeId(ev);
    if (!id) {
      store.selectedId = null;
      updateHandles();
      return;
    }
    store.selectedId = id;
    const node = store.model.nodes.find((n) => n.id === id);
    if (!node || node.space !== "world") return;
    updateHandles();

    owner = {
      kind: "move",
      pointerId: ev.pointerId,
      nodeId: id,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startX: node.transform.x,
      startY: node.transform.y,
      dirty: false,
    };
    try {
      overlay.setPointerCapture(ev.pointerId);
    } catch (e) {
      console.error("[next][state] setPointerCapture failed", e);
    }
    ev.preventDefault();
  };

  const onPointerMove = (ev: PointerEvent) => {
    // Hover / cursors (only when not dragging)
    if (!owner) {
      const id = store.selectedId ?? pickNodeNearClientPoint(ev.clientX, ev.clientY);
      const next = hitHandle(ev) ?? hitVirtualHandleAtClientPoint(ev.clientX, ev.clientY, id);
      if (id && next && !next.startsWith("anchor:")) {
        const node = store.model.nodes.find((n) => n.id === id);
        if (node && node.space === "world") {
          // IMPORTANT: model rotationDeg currently behaves like screen/CSS rotation (CW-positive),
          // so convert to Viktor's CCW-positive system before computing cursor angles.
          const rotYour = -node.transform.rotationDeg;

          const isRotateCorner = next === "nw" || next === "ne";
          const angleYour = cursorAngleYourForHandle(rotYour, next as any);

          if (isRotateCorner) {
            // Rotation cursor should update continuously with box rotation.
            overlay.style.cursor = cursorForRotate(toSvgAngle(angleYour));
          } else {
            // Resize cursor orientation does not need continuous updates; snap to 45deg buckets.
            const snappedYour = snapAngle(angleYour, 45);
            overlay.style.cursor = cursorForResize(toSvgAngle(snappedYour));
          }
        } else {
          overlay.style.cursor = "";
        }
      } else {
        overlay.style.cursor = "";
      }
    }

    const o = owner;
    if (!o) return;
    if (o.pointerId !== ev.pointerId) return;
    if ((ev.buttons & 1) === 0) {
      owner = null;
      return;
    }
    if (o.kind === "move") {
      const cam = activeView(store).camera;
      const dx = ev.clientX - o.startClientX;
      const dy = ev.clientY - o.startClientY;
      if (!o.dirty) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        o.dirty = true;
      }
      const node = store.model.nodes.find((n) => n.id === o.nodeId);
      if (!node || node.space !== "world") return;
      let nx = o.startX + dx / cam.zoom;
      let ny = o.startY + dy / cam.zoom;
      if (ev.shiftKey) {
        nx = snapTo(nx, GRID_STEP_WORLD);
        ny = snapTo(ny, GRID_STEP_WORLD);
      }
      node.transform.x = nx;
      node.transform.y = ny;
      ev.preventDefault();
      updateHandles();
      return;
    }

    // Rotate about anchor point
    if (o.kind === "rotate") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId);
      if (!node || node.space !== "world") return;
      const cam = activeView(store).camera;
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const wp = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);
      const ang1 = Math.atan2(wp.y - node.transform.y, wp.x - node.transform.x);
      const d = ((ang1 - o.startAngleRad) * 180) / Math.PI;
      let nextDeg = o.startRotationDeg + d;
      if (ev.shiftKey) nextDeg = snapTo(nextDeg, ROT_SNAP_DEG);
      node.transform.rotationDeg = nextDeg;
      // Update cursor continuously during drag (otherwise it appears "stuck").
      {
        const rotYour = -node.transform.rotationDeg;
        const handle = o.corner;
        const yourAngle = cursorAngleYourForHandle(rotYour, handle);
        overlay.style.cursor = cursorForRotate(toSvgAngle(yourAngle));
      }
      ev.preventDefault();
      updateHandles();
      return;
    }

    // Resize in the element's local axis (anchor is fixed, rotation preserved)
    if (o.kind === "resize") {
      const node = store.model.nodes.find((n) => n.id === o.nodeId);
      if (!node || node.space !== "world") return;
      const t = node.transform;
      const cam = activeView(store).camera;
      const r = stage.getBoundingClientRect();
      const screen = { w: r.width, h: r.height };
      const wp = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cam, screen);

      const rot = (t.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const dxw = wp.x - t.x;
      const dyw = wp.y - t.y;
      // rotate by -rot
      const lx = dxw * cos + dyw * sin;
      const ly = -dxw * sin + dyw * cos;

      const { ax, ay } = anchorFrac(t.anchor);
      const hnd = o.handle;

      // Corner scaling must ALWAYS preserve aspect ratio.
      // Do uniform scale about the anchor (anchor point stays fixed).
      const isCorner = hnd === "nw" || hnd === "ne" || hnd === "sw" || hnd === "se";
      if (isCorner) {
        const xMin0 = -ax * o.startW;
        const xMax0 = (1 - ax) * o.startW;
        const yMin0 = -ay * o.startH;
        const yMax0 = (1 - ay) * o.startH;

        // Pick the corner direction vector for computing scale.
        const cornerVec = (() => {
          if (hnd === "nw") return { x: xMin0, y: yMin0 };
          if (hnd === "ne") return { x: xMax0, y: yMin0 };
          if (hnd === "sw") return { x: xMin0, y: yMax0 };
          return { x: xMax0, y: yMax0 }; // "se"
        })();

        const denom = cornerVec.x * cornerVec.x + cornerVec.y * cornerVec.y;
        if (denom > 1e-9) {
          let s = (lx * cornerVec.x + ly * cornerVec.y) / denom;
          // Minimum size constraint (uniform).
          const minW = 10;
          const minH = 10;
          const sMin = Math.max(minW / Math.max(1e-9, o.startW), minH / Math.max(1e-9, o.startH));
          if (!Number.isFinite(s)) s = 1;
          s = Math.max(sMin, s);

          // Shift snapping: quantize size without breaking aspect ratio.
          if (ev.shiftKey) {
            const wSnap = snapTo(o.startW * s, GRID_STEP_WORLD);
            s = Math.max(sMin, wSnap / Math.max(1e-9, o.startW));
          }

          t.w = Math.max(minW, o.startW * s);
          t.h = Math.max(minH, o.startH * s);
          if (node.type === "text") node.fontPx = Math.max(1, o.startFontPx * s);
          ev.preventDefault();
          updateHandles();
          return;
        }
      }

      const minW = 10;
      const minH = 10;

      // IMPORTANT (anchor compensation):
      // `t.x,t.y` is the anchor point, so dragging an edge must solve for the new size such that
      // the dragged edge position equals the cursor in LOCAL coords.
      //
      // Example: anchor=center => right edge = +0.5*w. To make the edge follow the cursor (lx),
      // we must set w = lx / 0.5 = 2*lx.
      const lxTarget = ev.shiftKey ? snapTo(lx, GRID_STEP_WORLD) : lx;
      const lyTarget = ev.shiftKey ? snapTo(ly, GRID_STEP_WORLD) : ly;

      let wNew = t.w;
      let hNew = t.h;
      const eps = 1e-9;
      if (hnd === "e") wNew = lxTarget / Math.max(eps, 1 - ax);
      if (hnd === "w") wNew = -lxTarget / Math.max(eps, ax);
      if (hnd === "s") hNew = lyTarget / Math.max(eps, 1 - ay);
      if (hnd === "n") hNew = -lyTarget / Math.max(eps, ay);

      if (!Number.isFinite(wNew)) wNew = t.w;
      if (!Number.isFinite(hNew)) hNew = t.h;
      t.w = Math.max(minW, wNew);
      t.h = Math.max(minH, hNew);

      // Text scaling rule: corners scale font, edges keep font constant.
      if (node.type === "text" && isCorner) {
        const sW = t.w / Math.max(1e-9, o.startW);
        node.fontPx = Math.max(1, o.startFontPx * sW);
      }

      ev.preventDefault();
      updateHandles();
      return;
    }
  };

  const onPointerUp = (ev: PointerEvent) => {
    if (!owner) return;
    if (owner.pointerId !== ev.pointerId) return;
    owner = null;
    updateHandles();
  };

  // Stage sizing relies on the stage element; overlay handles interaction.
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { capture: true });
  // Keep handles in sync on animation ticks (cheap for now; later replace with event-driven rendering).
  const raf = () => {
    updateHandles();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  return () => {
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp as any, { capture: true } as any);
    void stage;
  };
}

