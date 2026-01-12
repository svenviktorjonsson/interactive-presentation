import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

export function attachKeyboardShortcuts(opts: {
  engine: Engine;
  stage: HTMLElement;
  getAppMode: () => "edit" | "live";
  isScreenEditMode: () => boolean;
  selected: Set<string>;
  cloneModel: (m: PresentationModel) => PresentationModel;
  commit: (before: PresentationModel | null) => Promise<void>;
  hydrateQrImages: (engine: Engine, model: PresentationModel) => Promise<void>;
  hydrateTextMath: (engine: Engine, model: PresentationModel) => void;
  applySelection: () => void;
  saveModel: (m: PresentationModel) => Promise<void>;
  history: { undo: () => Promise<boolean>; redo: () => Promise<boolean> };
  screenToWorld: (p: { x: number; y: number }, cam: any, scr: any) => { x: number; y: number };
  anchorToTopLeftWorld: (t: any) => { x: number; y: number };
  rectCornersWorld: (t: any) => { x: number; y: number }[];
  getActiveViewId: () => string;
  nextId: (prefix: string) => string;
}) {
  const deleteSelection = async () => {
    const model = opts.engine.getModel();
    if (!model) return;
    if (opts.selected.size === 0) return;
    const before = opts.cloneModel(model);

    const del = new Set(opts.selected);
    model.nodes = model.nodes.filter((n) => !del.has(n.id));
    for (const v of model.views) v.show = v.show.filter((id) => !del.has(id));
    opts.engine.setModel(opts.cloneModel(model));
    await opts.hydrateQrImages(opts.engine, model);
    opts.hydrateTextMath(opts.engine, model);
    opts.selected.clear();
    opts.applySelection();
    await opts.commit(before);
  };

  const onKey = async (ev: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || (document.activeElement as HTMLElement | null)?.isContentEditable;
    if (inInput) return;

    if (ev.key === "Escape") {
      if ((window as any).__ip_exitScreenEdit) {
        try {
          (window as any).__ip_exitScreenEdit();
        } catch {}
        ev.preventDefault();
        return;
      }
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === "z") {
      const ok = await opts.history.undo();
      if (ok) ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "y") {
      const ok = await opts.history.redo();
      if (ok) ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
      const model = opts.engine.getModel();
      const nodes = model?.nodes ?? [];
      const byId = new Map(nodes.map((n: any) => [String(n.id), n]));
      const selectedIds = new Set(Array.from(opts.selected));
      const allIds = new Set<string>(selectedIds);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes as any[]) {
          const pid = String(n.parentId ?? "").trim();
          if (pid && allIds.has(pid) && !allIds.has(String(n.id))) {
            allIds.add(String(n.id));
            changed = true;
          }
        }
      }
      const copied = Array.from(allIds)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((n: any) => JSON.parse(JSON.stringify(n)));

      const roots = copied.filter((n: any) => !String(n.parentId ?? "").trim() || !allIds.has(String(n.parentId ?? "").trim()));
      let bbox = null as null | { space: "world" | "screen"; cx: number; cy: number };
      try {
        if (roots.length) {
          const space = (roots[0]?.space ?? "world") === "screen" ? "screen" : "world";
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const cs = opts.rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          } else {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const t = n.transform ?? {};
              const x = Number(t.x ?? 0);
              const y = Number(t.y ?? 0);
              const w = Number(t.w ?? 0.2);
              const h = Number(t.h ?? 0.1);
              const tl = opts.anchorToTopLeftWorld({ x, y, w, h, anchor: String(t.anchor ?? "topLeft") } as any);
              minX = Math.min(minX, tl.x);
              minY = Math.min(minY, tl.y);
              maxX = Math.max(maxX, tl.x + w);
              maxY = Math.max(maxY, tl.y + h);
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          }
        }
      } catch {}
      (window as any).__ip_clipboard = { nodes: copied, bbox };
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "x") {
      const model = opts.engine.getModel();
      const nodes = model?.nodes ?? [];
      const byId = new Map(nodes.map((n: any) => [String(n.id), n]));
      const selectedIds = new Set(Array.from(opts.selected));
      const allIds = new Set<string>(selectedIds);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes as any[]) {
          const pid = String(n.parentId ?? "").trim();
          if (pid && allIds.has(pid) && !allIds.has(String(n.id))) {
            allIds.add(String(n.id));
            changed = true;
          }
        }
      }
      const copied = Array.from(allIds)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((n: any) => JSON.parse(JSON.stringify(n)));

      const roots = copied.filter((n: any) => !String(n.parentId ?? "").trim() || !allIds.has(String(n.parentId ?? "").trim()));
      let bbox = null as null | { space: "world" | "screen"; cx: number; cy: number };
      try {
        if (roots.length) {
          const space = (roots[0]?.space ?? "world") === "screen" ? "screen" : "world";
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const cs = opts.rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          } else {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const n of roots) {
              const t = n.transform ?? {};
              const x = Number(t.x ?? 0);
              const y = Number(t.y ?? 0);
              const w = Number(t.w ?? 0.2);
              const h = Number(t.h ?? 0.1);
              const tl = opts.anchorToTopLeftWorld({ x, y, w, h, anchor: String(t.anchor ?? "topLeft") } as any);
              minX = Math.min(minX, tl.x);
              minY = Math.min(minY, tl.y);
              maxX = Math.max(maxX, tl.x + w);
              maxY = Math.max(maxY, tl.y + h);
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) bbox = { space, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          }
        }
      } catch {}
      (window as any).__ip_clipboard = { nodes: copied, bbox };
      await deleteSelection();
      ev.preventDefault();
      return;
    }

    if (ev.ctrlKey && ev.key.toLowerCase() === "v") {
      const clip = (window as any).__ip_clipboard;
      const items: any[] = Array.isArray(clip) ? clip : Array.isArray(clip?.nodes) ? clip.nodes : [];
      if (items.length === 0) return;
      const model = opts.engine.getModel();
      if (!model) return;
      const before = opts.cloneModel(model);

      const cam = opts.engine.getCamera();
      const scr = opts.engine.getScreen();
      const stageRect = opts.stage.getBoundingClientRect();
      const mx = typeof (window as any).__ip_lastMouseX === "number" ? (window as any).__ip_lastMouseX : stageRect.left + stageRect.width / 2;
      const my = typeof (window as any).__ip_lastMouseY === "number" ? (window as any).__ip_lastMouseY : stageRect.top + stageRect.height / 2;
      const screenPos = { x: mx - stageRect.left, y: my - stageRect.top };
      const targetWorld = opts.isScreenEditMode() ? null : opts.screenToWorld(screenPos, cam as any, scr as any);
      const targetScreenFrac = scr.w > 0 && scr.h > 0 ? { x: screenPos.x / scr.w, y: screenPos.y / scr.h } : { x: 0.5, y: 0.5 };

      const oldIds = new Set(items.map((n) => String(n.id)));
      const idMap = new Map<string, string>();
      const newNodes: any[] = [];

      const prefixFor = (n: any) => String(n?.type ?? "node");

      for (const n of items) {
        const oldId = String(n.id);
        idMap.set(oldId, opts.nextId(prefixFor(n)));
      }

      const rootOldIds = items
        .filter((n) => {
          const pid = String(n.parentId ?? "").trim();
          return !pid || !oldIds.has(pid);
        })
        .map((n) => String(n.id));

      const bbox = clip?.bbox ?? null;
      const space = (bbox?.space ?? items[0]?.space ?? "world") === "screen" ? "screen" : "world";
      let baseCx = bbox?.cx ?? 0;
      let baseCy = bbox?.cy ?? 0;
      if (!bbox) {
        try {
          if (space === "world") {
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const oldId of rootOldIds) {
              const n = items.find((x) => String(x.id) === oldId);
              if (!n) continue;
              const cs = opts.rectCornersWorld(n.transform ?? {});
              for (const p of cs) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
              }
            }
            if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
              baseCx = (minX + maxX) / 2;
              baseCy = (minY + maxY) / 2;
            }
          } else {
            baseCx = targetScreenFrac.x;
            baseCy = targetScreenFrac.y;
          }
        } catch {}
      }

      let dxw = 0;
      let dyw = 0;
      let dxs = 0;
      let dys = 0;
      if (space === "world" && targetWorld) {
        dxw = targetWorld.x - baseCx;
        dyw = targetWorld.y - baseCy;
      } else if (space === "screen") {
        dxs = targetScreenFrac.x - baseCx;
        dys = targetScreenFrac.y - baseCy;
      } else {
        dxw = 40;
        dyw = 40;
      }

      for (const n0 of items) {
        const n = JSON.parse(JSON.stringify(n0));
        const oldId = String(n.id);
        const newId = idMap.get(oldId) ?? opts.nextId(prefixFor(n));
        n.id = newId;

        const pid = String(n.parentId ?? "").trim();
        if (pid && idMap.has(pid)) n.parentId = idMap.get(pid);
        else delete n.parentId;

        if (n.type === "timer" || n.type === "sound") n.compositeDir = newId;

        if (rootOldIds.includes(oldId)) {
          const t = n.transform ?? {};
          if ((n.space ?? "world") === "screen") n.transform = { ...t, x: Number(t.x ?? 0) + dxs, y: Number(t.y ?? 0) + dys };
          else n.transform = { ...t, x: Number(t.x ?? 0) + dxw, y: Number(t.y ?? 0) + dyw };
        }

        newNodes.push(n);
      }

      for (const n of newNodes) model.nodes.push(n);

      const activeView = model.views.find((v) => v.id === opts.getActiveViewId()) ?? model.views[0];
      for (const n of newNodes) {
        const id = String(n.id);
        const isScreen = (n.space ?? "world") === "screen";
        if (isScreen) {
          for (const v of model.views) if (!v.show.includes(id)) v.show.push(id);
        } else {
          if (activeView && !activeView.show.includes(id)) activeView.show.push(id);
        }
      }

      opts.engine.setModel(opts.cloneModel(model));
      await opts.hydrateQrImages(opts.engine, model);
      opts.hydrateTextMath(opts.engine, model);
      opts.selected.clear();
      for (const oldId of rootOldIds) {
        const nid = idMap.get(oldId);
        if (nid) opts.selected.add(nid);
      }
      opts.applySelection();
      await opts.commit(before);
      ev.preventDefault();
      return;
    }

    if (ev.key === "Delete" || ev.key === "Backspace") {
      await deleteSelection();
      ev.preventDefault();
      return;
    }
  };

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

