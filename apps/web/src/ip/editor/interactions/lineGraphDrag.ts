import type { Engine } from "@interactive/engine";

type Space = "world" | "screen";

type JunctionDrag =
  | null
  | {
      movedId: string;
      space: Space;
      p1Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>;
      p2Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>;
      junctions: Array<{ x: number; y: number }>;
    };

type GraphDrag =
  | null
  | {
      ids: string[];
      space: Space;
      ref: { x: number; y: number };
    };

export function createLineGraphDrag(opts: {
  engine: Engine;
  gridSpacingForZoom: (zoom: number) => { spacing0: number; spacing1: number; t: number };
  worldToScreen: (p: { x: number; y: number }, cam: any, scr: any) => { x: number; y: number };
  anchorToTopLeftWorld: (t: { x: number; y: number; w: number; h: number; anchor?: string }) => { x: number; y: number };
  uiNodeForId: (id: string, model: any) => { ui: any; parentWorld: any | null };
  toLocalTransformFromWorld: (worldT: any, parentWorldT: any, anchor: string) => any;
}) {
  const { engine } = opts;

  let junctionDrag: JunctionDrag = null;
  let graphDrag: GraphDrag = null;

  const reset = () => {
    junctionDrag = null;
    graphDrag = null;
  };

  const collectConnectedLineIds = (
    seedId: string,
    model: any,
    space: Space,
    cam: any,
    scr: any,
    parentId: string
  ) => {
    // Prefer explicit join IDs if present; fall back to proximity-based welding for legacy segments.
    const joinToLineIds = new Map<string, string[]>();
    const joinsByLineId = new Map<string, string[]>();
    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any)?.parentId ?? "").trim();
      if (pid !== String(parentId ?? "").trim()) continue;
      const nid = String(n0.id ?? "");
      if (!nid) continue;
      const j1 = String((n0 as any).p1Join ?? "").trim();
      const j2 = String((n0 as any).p2Join ?? "").trim();
      const js = [j1, j2].filter(Boolean);
      if (js.length) {
        joinsByLineId.set(nid, js);
        for (const j of js) {
          const arr = joinToLineIds.get(j) ?? [];
          arr.push(nid);
          joinToLineIds.set(j, arr);
        }
      }
    }
    const seedJoins = joinsByLineId.get(seedId) ?? [];
    if (seedJoins.length && joinToLineIds.size) {
      const visited = new Set<string>();
      const q: string[] = [seedId];
      visited.add(seedId);
      while (q.length) {
        const cur = q.shift()!;
        const js = joinsByLineId.get(cur) ?? [];
        for (const j of js) {
          const neigh = joinToLineIds.get(j) ?? [];
          for (const id of neigh) {
            if (visited.has(id)) continue;
            visited.add(id);
            q.push(id);
          }
        }
      }
      return Array.from(visited);
    }

    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;
    const cell = tolPx;

    const toScreenPt = (p: { x: number; y: number }) =>
      space === "world" ? opts.worldToScreen(p, cam as any, scr as any) : { x: p.x * scr.w, y: p.y * scr.h };

    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy;
    };

    const lineIds: string[] = [];
    const endpointsById = new Map<string, { p1: { s: { x: number; y: number } }; p2: { s: { x: number; y: number } } }>();
    const buckets = new Map<string, Array<{ id: string; s: { x: number; y: number } }>>();
    const put = (id: string, s: { x: number; y: number }) => {
      const cx = Math.floor(s.x / cell);
      const cy = Math.floor(s.y / cell);
      const k = `${cx},${cy}`;
      const arr = buckets.get(k) ?? [];
      arr.push({ id, s });
      buckets.set(k, arr);
    };

    for (const n0 of (model?.nodes as any[]) ?? []) {
      if (!n0 || String(n0.type) !== "line") continue;
      if (String(n0.space ?? "world") !== space) continue;
      const pid = String((n0 as any)?.parentId ?? "").trim();
      if (pid !== String(parentId ?? "").trim()) continue;

      const nid = String(n0.id ?? "");
      if (!nid) continue;
      lineIds.push(nid);

      const { ui } = opts.uiNodeForId(nid, model);
      const tN = (ui as any)?.transform ?? n0.transform ?? {};
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
      const tl = opts.anchorToTopLeftWorld({
        x: Number(tN.x ?? 0),
        y: Number(tN.y ?? 0),
        w: Number(tN.w ?? 1),
        h: Number(tN.h ?? 1),
        anchor: tN.anchor ?? "topLeft",
      });
      const w = Math.max(1e-9, Number(tN.w ?? 1));
      const h = Math.max(1e-9, Number(tN.h ?? 1));
      const p1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
      const p2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };
      const s1 = toScreenPt(p1);
      const s2 = toScreenPt(p2);
      endpointsById.set(nid, { p1: { s: s1 }, p2: { s: s2 } });
      put(nid, s1);
      put(nid, s2);
    }

    if (!endpointsById.has(seedId)) return [seedId];

    const visited = new Set<string>();
    const q: string[] = [seedId];
    visited.add(seedId);

    const neighborsFor = (s: { x: number; y: number }) => {
      const cx = Math.floor(s.x / cell);
      const cy = Math.floor(s.y / cell);
      const out: Array<{ id: string; s: { x: number; y: number } }> = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const k = `${cx + dx},${cy + dy}`;
          const arr = buckets.get(k);
          if (arr) out.push(...arr);
        }
      }
      return out;
    };

    while (q.length) {
      const cur = q.shift()!;
      const e = endpointsById.get(cur);
      if (!e) continue;
      const pts = [e.p1.s, e.p2.s];
      for (const p of pts) {
        for (const cand of neighborsFor(p)) {
          if (visited.has(cand.id)) continue;
          if (dist2(cand.s, p) <= tolPx2) {
            visited.add(cand.id);
            q.push(cand.id);
          }
        }
      }
    }

    return Array.from(visited);
  };

  const startJunctionDrag = (args: { id: string; model: any; startNodesById: Record<string, any> }) => {
    junctionDrag = null;
    const { id, model, startNodesById } = args;
    const startNode: any = startNodesById?.[id];
    if (!startNode || !model) return;
    const sp: Space = (startNode?.space ?? "world") === "screen" ? "screen" : "world";

    const ui0: any = (startNode as any)?.__ui ?? null;
    const t0 = (ui0?.worldT ?? startNode?.transform ?? {}) as any;
    const from0 = startNode?.from ?? { x: 0, y: 0.5 };
    const to0 = startNode?.to ?? { x: 1, y: 0.5 };
    const tl0 = opts.anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" });
    const w0 = Math.max(1e-9, Number(t0.w ?? 1));
    const h0 = Math.max(1e-9, Number(t0.h ?? 1));
    const p1w = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
    const p2w = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };
    const camNow = engine.getCamera();
    const scrNow = engine.getScreen();
    const tolPx = 10;
    const tolPx2 = tolPx * tolPx;

    const toScreenPt = (p: { x: number; y: number }) =>
      sp === "world" ? opts.worldToScreen(p, camNow as any, scrNow as any) : { x: p.x * scrNow.w, y: p.y * scrNow.h };

    const p1s = toScreenPt(p1w);
    const p2s = toScreenPt(p2w);

    const p1Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }> = [];
    const p2Links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }> = [];
    const junctions: Array<{ x: number; y: number }> = [];
    const j1 = String((startNode as any)?.p1Join ?? "").trim();
    const j2 = String((startNode as any)?.p2Join ?? "").trim();

    for (const n0 of model.nodes as any[]) {
      if (!n0 || String(n0.type) !== "line") continue;
      const nid = String(n0.id ?? "");
      if (!nid || nid === id) continue;
      if (String(n0.space ?? "world") !== sp) continue;
      const { ui, parentWorld } = opts.uiNodeForId(nid, model);
      const tN = (ui as any)?.transform ?? n0.transform ?? {};
      const fr = (n0 as any).from ?? { x: 0, y: 0.5 };
      const to = (n0 as any).to ?? { x: 1, y: 0.5 };
      const tl = opts.anchorToTopLeftWorld({ x: Number(tN.x ?? 0), y: Number(tN.y ?? 0), w: Number(tN.w ?? 1), h: Number(tN.h ?? 1), anchor: tN.anchor ?? "topLeft" });
      const w = Math.max(1e-9, Number(tN.w ?? 1));
      const h = Math.max(1e-9, Number(tN.h ?? 1));
      const q1 = { x: tl.x + Number(fr.x ?? 0) * w, y: tl.y + Number(fr.y ?? 0) * h };
      const q2 = { x: tl.x + Number(to.x ?? 1) * w, y: tl.y + Number(to.y ?? 0) * h };

      junctions.push(q1, q2);

      const nJ1 = String((n0 as any)?.p1Join ?? "").trim();
      const nJ2 = String((n0 as any)?.p2Join ?? "").trim();

      if (j1) {
        if (nJ1 && nJ1 === j1) p1Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
        else if (nJ2 && nJ2 === j1) p1Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
      }
      if (j2) {
        if (nJ1 && nJ1 === j2) p2Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
        else if (nJ2 && nJ2 === j2) p2Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
      }

      if (!j1 || !j2) {
        const q1s = toScreenPt(q1);
        const q2s = toScreenPt(q2);
        if (!j1) {
          const d11 = (q1s.x - p1s.x) ** 2 + (q1s.y - p1s.y) ** 2;
          const d12 = (q2s.x - p1s.x) ** 2 + (q2s.y - p1s.y) ** 2;
          if (d11 <= tolPx2) p1Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
          else if (d12 <= tolPx2) p1Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
        }
        if (!j2) {
          const d21 = (q1s.x - p2s.x) ** 2 + (q1s.y - p2s.y) ** 2;
          const d22 = (q2s.x - p2s.x) ** 2 + (q2s.y - p2s.y) ** 2;
          if (d21 <= tolPx2) p2Links.push({ id: nid, end: "p1", other: q2, parentWorldT: parentWorld ?? null });
          else if (d22 <= tolPx2) p2Links.push({ id: nid, end: "p2", other: q1, parentWorldT: parentWorld ?? null });
        }
      }
    }

    if (p1Links.length > 0 || p2Links.length > 0 || junctions.length > 0) {
      junctionDrag = { movedId: id, space: sp, p1Links, p2Links, junctions };
    }
  };

  const startGraphDrag = (args: { id: string; model: any; startNodesById: Record<string, any> }) => {
    graphDrag = null;
    const { id, model, startNodesById } = args;
    const startNode: any = startNodesById?.[id];
    if (!startNode || !model) return null;
    const sp: Space = (startNode?.space ?? "world") === "screen" ? "screen" : "world";
    const parentId = String((startNode as any)?.parentId ?? "").trim();
    const camNow = engine.getCamera();
    const scrNow = engine.getScreen();
    const ids = collectConnectedLineIds(id, model, sp, camNow as any, scrNow as any, parentId);

    // Ensure we have start snapshots for all ids in the component (even if not selected).
    const idSet = new Set(ids);
    for (const n0 of model.nodes as any[]) {
      const nid = String(n0?.id ?? "");
      if (!nid || !idSet.has(nid)) continue;
      if (startNodesById[nid]) continue;
      const snap = JSON.parse(JSON.stringify(n0));
      const pid = String((n0 as any)?.parentId ?? "").trim();
      if (pid && (n0 as any)?.space === "world") {
        const { ui, parentWorld } = opts.uiNodeForId(String(nid), model);
        (snap as any).__ui = { worldT: (ui as any)?.transform ?? null, parentWorldT: parentWorld ?? null };
      }
      startNodesById[nid] = snap;
    }

    // Reference point for snapping translation: use seed p1.
    const ui0: any = (startNodesById[id] as any)?.__ui ?? null;
    const t0 = (ui0?.worldT ?? (startNodesById[id] as any)?.transform ?? {}) as any;
    const from0 = (startNodesById[id] as any)?.from ?? { x: 0, y: 0.5 };
    const tl0 = opts.anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" });
    const w0 = Math.max(1e-9, Number(t0.w ?? 1));
    const h0 = Math.max(1e-9, Number(t0.h ?? 1));
    const p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };

    graphDrag = { ids, space: sp, ref: p1 };
    return graphDrag;
  };

  const applyGraphDrag = (args: { dxClient: number; dyClient: number; shiftKey: boolean; startNodesById: Record<string, any> }) => {
    if (!graphDrag) return;
    const dx = args.dxClient;
    const dy = args.dyClient;
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const sp = graphDrag.space;
    let ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
    let ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);

    if (args.shiftKey && sp === "world") {
      const { spacing0, spacing1, t } = opts.gridSpacingForZoom(cam.zoom);
      const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
      const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
      const refNew = { x: graphDrag.ref.x + ddx, y: graphDrag.ref.y + ddy };
      const refSnap = { x: snap(refNew.x), y: snap(refNew.y) };
      ddx = refSnap.x - graphDrag.ref.x;
      ddy = refSnap.y - graphDrag.ref.y;
    }

    const idSet = new Set(graphDrag.ids);
    for (const id of graphDrag.ids) {
      const startNode: any = args.startNodesById[id];
      if (!startNode) continue;
      if (String(startNode.type ?? "") !== "line") continue;
      if (!idSet.has(id)) continue;

      const ui0: any = (startNode as any).__ui ?? null;
      const parentWorldT: any = ui0?.parentWorldT ?? null;
      const t0 = (ui0?.worldT ?? startNode.transform ?? {}) as any;
      const from0 = startNode.from ?? { x: 0, y: 0.5 };
      const to0 = startNode.to ?? { x: 1, y: 0.5 };
      const tl0 = opts.anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" });
      const w0 = Math.max(1e-9, Number(t0.w ?? 1));
      const h0 = Math.max(1e-9, Number(t0.h ?? 1));
      let p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
      let p2 = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };

      p1 = { x: p1.x + ddx, y: p1.y + ddy };
      p2 = { x: p2.x + ddx, y: p2.y + ddy };

      let minX = Math.min(p1.x, p2.x);
      let minY = Math.min(p1.y, p2.y);
      let maxX = Math.max(p1.x, p2.x);
      let maxY = Math.max(p1.y, p2.y);
      const minSize = sp === "world" ? 10 : 0.005;
      if (maxX - minX < minSize) {
        const cx = (minX + maxX) / 2;
        minX = cx - minSize / 2;
        maxX = cx + minSize / 2;
      }
      if (maxY - minY < minSize) {
        const cy = (minY + maxY) / 2;
        minY = cy - minSize / 2;
        maxY = cy + minSize / 2;
      }
      const w1 = maxX - minX;
      const h1 = maxY - minY;
      const fx = (p1.x - minX) / w1;
      const fy = (p1.y - minY) / h1;
      const tx = (p2.x - minX) / w1;
      const ty = (p2.y - minY) / h1;

      const worldOut = { x: minX, y: minY, w: w1, h: h1, anchor: "topLeft", rotationDeg: 0 } as any;
      const localOut = parentWorldT ? opts.toLocalTransformFromWorld(worldOut, parentWorldT, "topLeft") : worldOut;
      engine.updateNode(id, { transform: localOut as any, from: { x: fx, y: fy }, to: { x: tx, y: ty } } as any);
    }
  };

  const applyLineHandleDrag = (args: {
    id: string;
    activeHandle: "p1" | "p2" | "mid";
    dxClient: number;
    dyClient: number;
    shiftKey: boolean;
    startNodesById: Record<string, any>;
  }) => {
    const onlyId = args.id;
    const startNode: any = args.startNodesById[onlyId];
    if (!startNode) return;
    const cam = engine.getCamera();
    const scr = engine.getScreen();
    const sp: Space = (startNode.space ?? "world") === "screen" ? "screen" : "world";
    const dx = args.dxClient;
    const dy = args.dyClient;
    const ddx = sp === "world" ? dx / cam.zoom : dx / Math.max(1, scr.w);
    const ddy = sp === "world" ? dy / cam.zoom : dy / Math.max(1, scr.h);

    const ui0: any = (startNode as any).__ui ?? null;
    const parentWorldT: any = ui0?.parentWorldT ?? null;
    const t0 = (ui0?.worldT ?? startNode.transform ?? {}) as any;
    const from0 = startNode.from ?? { x: 0, y: 0.5 };
    const to0 = startNode.to ?? { x: 1, y: 0.5 };
    const tl0 = opts.anchorToTopLeftWorld({ x: Number(t0.x ?? 0), y: Number(t0.y ?? 0), w: Number(t0.w ?? 1), h: Number(t0.h ?? 1), anchor: t0.anchor ?? "topLeft" });
    const w0 = Math.max(1e-9, Number(t0.w ?? 1));
    const h0 = Math.max(1e-9, Number(t0.h ?? 1));
    let p1 = { x: tl0.x + Number(from0.x ?? 0) * w0, y: tl0.y + Number(from0.y ?? 0) * h0 };
    let p2 = { x: tl0.x + Number(to0.x ?? 1) * w0, y: tl0.y + Number(to0.y ?? 0) * h0 };

    const hnd = args.activeHandle ?? "mid";
    if (hnd === "p1") p1 = { x: p1.x + ddx, y: p1.y + ddy };
    else if (hnd === "p2") p2 = { x: p2.x + ddx, y: p2.y + ddy };
    else {
      p1 = { x: p1.x + ddx, y: p1.y + ddy };
      p2 = { x: p2.x + ddx, y: p2.y + ddy };
    }

    if (args.shiftKey) {
      const tolPx = 12;
      const tolPx2 = tolPx * tolPx;
      const toScreenPt = (p: { x: number; y: number }) =>
        sp === "world" ? opts.worldToScreen(p, cam as any, scr as any) : { x: p.x * scr.w, y: p.y * scr.h };
      const dist2px = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return dx * dx + dy * dy;
      };

      const snapEndpoint = (p: { x: number; y: number }) => {
        const ps = toScreenPt(p);
        const js = junctionDrag?.junctions ?? [];
        let bestJ: { p: { x: number; y: number }; d2: number } | null = null;
        for (const j of js) {
          const d2 = dist2px(toScreenPt(j), ps);
          if (!bestJ || d2 < bestJ.d2) bestJ = { p: j, d2 };
        }

        if (sp === "world") {
          const { spacing0, spacing1, t } = opts.gridSpacingForZoom(cam.zoom);
          const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
          const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
          const gridPt = { x: snap(p.x), y: snap(p.y) };
          const gridD2 = dist2px(toScreenPt(gridPt), ps);
          if (bestJ && bestJ.d2 <= tolPx2 && bestJ.d2 < gridD2 - 1e-6) return bestJ.p;
          return gridPt;
        }
        if (bestJ && bestJ.d2 <= tolPx2) return bestJ.p;
        return p;
      };

      if (hnd === "p1") p1 = snapEndpoint(p1);
      else if (hnd === "p2") p2 = snapEndpoint(p2);
      else if (sp === "world") {
        const { spacing0, spacing1, t } = opts.gridSpacingForZoom(cam.zoom);
        const snapSpacing = t >= 0.5 ? spacing1 : spacing0;
        const snap = (v: number) => Math.round(v / snapSpacing) * snapSpacing;
        const snapPt = (p: { x: number; y: number }) => ({ x: snap(p.x), y: snap(p.y) });
        const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          return dx * dx + dy * dy;
        };
        const s1 = snapPt(p1);
        const s2 = snapPt(p2);
        const d1 = dist2(p1, s1);
        const d2 = dist2(p2, s2);
        const dx = d1 <= d2 ? s1.x - p1.x : s2.x - p2.x;
        const dy = d1 <= d2 ? s1.y - p1.y : s2.y - p2.y;
        p1 = { x: p1.x + dx, y: p1.y + dy };
        p2 = { x: p2.x + dx, y: p2.y + dy };
      }
    }

    const applyNode = (nodeId: string, a: { x: number; y: number }, b: { x: number; y: number }, parentWorld: any | null) => {
      let minX = Math.min(a.x, b.x);
      let minY = Math.min(a.y, b.y);
      let maxX = Math.max(a.x, b.x);
      let maxY = Math.max(a.y, b.y);
      const minSize = sp === "world" ? 10 : 0.005;
      if (maxX - minX < minSize) {
        const cx = (minX + maxX) / 2;
        minX = cx - minSize / 2;
        maxX = cx + minSize / 2;
      }
      if (maxY - minY < minSize) {
        const cy = (minY + maxY) / 2;
        minY = cy - minSize / 2;
        maxY = cy + minSize / 2;
      }
      const w1 = maxX - minX;
      const h1 = maxY - minY;
      const fx = (a.x - minX) / w1;
      const fy = (a.y - minY) / h1;
      const tx = (b.x - minX) / w1;
      const ty = (b.y - minY) / h1;
      const worldOut = { x: minX, y: minY, w: w1, h: h1, anchor: "topLeft", rotationDeg: 0 } as any;
      const localOut = parentWorld ? opts.toLocalTransformFromWorld(worldOut, parentWorld, "topLeft") : worldOut;
      engine.updateNode(nodeId, { transform: localOut as any, from: { x: fx, y: fy }, to: { x: tx, y: ty } } as any);
    };

    // Apply main node
    applyNode(onlyId, p1, p2, parentWorldT);

    // Graph behavior: update any linked line endpoints so shared junctions move together.
    if (junctionDrag && junctionDrag.movedId === onlyId) {
      const applyLinks = (
        links: Array<{ id: string; end: "p1" | "p2"; other: { x: number; y: number }; parentWorldT: any | null }>,
        movedNew: { x: number; y: number }
      ) => {
        for (const l of links) {
          if (l.end === "p1") applyNode(l.id, movedNew, l.other, l.parentWorldT);
          else applyNode(l.id, l.other, movedNew, l.parentWorldT);
        }
      };

      if (hnd === "p1") applyLinks(junctionDrag.p1Links, p1);
      else if (hnd === "p2") applyLinks(junctionDrag.p2Links, p2);
      else {
        applyLinks(junctionDrag.p1Links, p1);
        applyLinks(junctionDrag.p2Links, p2);
      }
    }
  };

  return {
    reset,
    startJunctionDrag,
    startGraphDrag,
    applyGraphDrag,
    applyLineHandleDrag,
    getGraphDrag: () => graphDrag,
  };
}

