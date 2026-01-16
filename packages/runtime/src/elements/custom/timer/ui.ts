import type { Engine } from "@interactive/engine";
import { parseInlineParams, parseList } from "../../../utils/params";
import { applyDataBindings } from "../../../utils/template";
import { renderTextWithKatexToHtml } from "../../../utils/textMath";
import { anchorToTopLeftFrac } from "../../../utils/geom";

const PLOT_FRACS = { leftF: 0.08, rightF: 0.92, topF: 0.10, bottomF: 0.90 };

const normalizeAnchor = (a: string | undefined) => {
  if (!a) return "centerCenter";
  if (a === "top") return "topCenter";
  if (a === "bottom") return "bottomCenter";
  if (a === "left") return "centerLeft";
  if (a === "right") return "centerRight";
  if (a === "center") return "centerCenter";
  return a;
};

const cssTranslateForAnchor = (anchor: string) => {
  const a = normalizeAnchor(anchor);
  switch (a) {
    case "topLeft":
      return "translate(0%, 0%)";
    case "topCenter":
      return "translate(-50%, 0%)";
    case "topRight":
      return "translate(-100%, 0%)";
    case "centerLeft":
      return "translate(0%, -50%)";
    case "center":
    case "centerCenter":
      return "translate(-50%, -50%)";
    case "centerRight":
      return "translate(-100%, -50%)";
    case "bottomLeft":
      return "translate(0%, -100%)";
    case "bottomCenter":
      return "translate(-50%, -100%)";
    case "bottomRight":
      return "translate(-100%, -100%)";
    default:
      return "translate(-50%, -50%)";
  }
};

const cssTransformOriginForAnchor = (anchor: string) => {
  const a = normalizeAnchor(anchor);
  switch (a) {
    case "topLeft":
      return "0% 0%";
    case "topCenter":
      return "50% 0%";
    case "topRight":
      return "100% 0%";
    case "centerLeft":
      return "0% 50%";
    case "center":
    case "centerCenter":
      return "50% 50%";
    case "centerRight":
      return "100% 50%";
    case "bottomLeft":
      return "0% 100%";
    case "bottomCenter":
      return "50% 100%";
    case "bottomRight":
      return "100% 100%";
    default:
      return "50% 50%";
  }
};

const applyGeomTransformCss = (el: HTMLElement, g: any) => {
  const anchor = normalizeAnchor(String(g?.anchor ?? "centerCenter"));
  const rot = Number(g?.rotationDeg ?? 0) || 0;
  el.dataset.anchor = anchor;
  el.dataset.rotationDeg = String(rot);
  el.style.transformOrigin = cssTransformOriginForAnchor(anchor);
  // IMPORTANT:
  // Use a single `transform` so the anchor-translation is NOT rotated.
  // (With individual `rotate` property, translate happens before rotate and the translation gets rotated.)
  el.style.transform = `${cssTranslateForAnchor(anchor)} rotate(${rot}deg)`;
};

const parseSplits = (raw: unknown) => {
  const arr = Array.isArray(raw) ? (raw as any[]) : [];
  const nums = arr
    .map((x) => Number(String(x ?? "").trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0.05, Math.min(0.95, n)));
  nums.sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of nums) {
    if (out.length === 0 || Math.abs(out[out.length - 1]! - n) > 1e-6) out.push(n);
  }
  return out;
};

const splitFracsToCss = (splits0: number[], countFallback: number) => {
  const splits = (splits0 ?? []).filter((x) => x > 0 && x < 1);
  if (splits.length === 0) {
    const n = Math.max(1, Math.floor(countFallback));
    if (n <= 1) return ["1fr"];
    return Array.from({ length: n }, () => `1fr`);
  }
  const pts = [0, ...splits, 1];
  const fracs: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) fracs.push(Math.max(0.02, pts[i + 1]! - pts[i]!));
  // Use `fr` units so gaps are naturally excluded from track sizing.
  return fracs.map((f) => `${f}fr`);
};

export function ensureTimerCompositeLayer(engine: Engine, timerId: string) {
  const m = engine.getModel();
  const node = m?.nodes.find((n) => (n as any).id === timerId) as any;
  const el = engine.getNodeElement(timerId);
  if (!node || !el) return null;
  const frame = el.querySelector<HTMLElement>(".timer-frame");
  if (!frame) return null;
  // Axis arrows extend slightly outside the plot region; ensure they are not clipped.
  frame.style.overflow = "visible";

  let layer = frame.querySelector<HTMLElement>(":scope .timer-sub-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "timer-sub-layer";
    layer.dataset.timerId = timerId;
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    frame.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("timer-sub-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);

    const plotGroup = document.createElement("div");
    plotGroup.className = "timer-sub comp-sub comp-group timer-sub-plotgroup";
    plotGroup.dataset.subId = "plot";
    plotGroup.dataset.compPath = timerId;
    plotGroup.dataset.groupPath = `${timerId}/plot`;
    plotGroup.style.position = "absolute";
    plotGroup.style.pointerEvents = "none";
    plotGroup.style.overflow = "visible";
    plotGroup.style.zIndex = "10";
    plotGroup.style.background = "transparent";
    layer.append(plotGroup);
    (layer as any).__plotGroup = plotGroup;

    const mkArrowHit = (arrowId: string) => {
      const container = ((layer as any).__plotGroup as HTMLElement | null) ?? layer!;
      const h = document.createElement("div");
      h.className = "timer-sub timer-sub-arrow-hit comp-sub";
      h.dataset.subId = arrowId;
      h.dataset.compPath = timerId;
      h.dataset.kind = "plot-arrow";
      h.dataset.arrowId = arrowId;
      h.style.position = "absolute";
      h.style.pointerEvents = "none";
      h.style.zIndex = "20";
      container.append(h);
      return h;
    };
    mkArrowHit("x_axis");
    mkArrowHit("y_axis");

  }

  // Always sync sub-elements (text/buttons/arrows) from elements.pr.
  // IMPORTANT:
  // - buttons params often contain bracket-lists (labels=[...]) so the regex must be greedy to the LAST ']'.
  // - During composite edit, DOM is actively manipulated by the editor; do NOT overwrite transforms from stale model data.
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isEditingThis = !!(window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerId);
  const geoms: Record<string, any> = (node.compositeGeometriesByPath?.[""] ?? node.compositeGeometries ?? {}) as any;
  geoms["plot"] =
    geoms["plot"] ?? { x: PLOT_FRACS.leftF, y: PLOT_FRACS.topF, w: PLOT_FRACS.rightF - PLOT_FRACS.leftF, h: PLOT_FRACS.bottomF - PLOT_FRACS.topF, rotationDeg: 0, anchor: "topLeft", align: "left" };

  const nodeText = String(node.elementsText ?? "");
  // Only seed __elementsPr once; during editing we mutate __elementsPr locally and persist it.
  if (!String((layer as any).__elementsPr ?? "").trim()) (layer as any).__elementsPr = nodeText;
  const text = String((layer as any).__elementsPr ?? nodeText);
  const lines = text.split(/\r?\n/);
  const arrowSpecs: Array<{ id: string; x0: number; y0: number; x1: number; y1: number; color: string; width: number }> = [];
  const seenText = new Set<string>();
  const seenButtons = new Set<string>();

  const ensureTextEl = (sid: string, templ: string) => {
    let d = layer!.querySelector<HTMLElement>(`.timer-sub-text.comp-sub[data-sub-id="${sid}"]`);
    if (!d) {
      d = document.createElement("div");
      d.className = "timer-sub timer-sub-text comp-sub";
      d.dataset.subId = sid;
      d.dataset.compPath = timerId;
      const contentEl = document.createElement("div");
      contentEl.className = "timer-sub-content";
      contentEl.style.width = "100%";
      contentEl.style.height = "100%";
      contentEl.style.display = "grid";
      contentEl.style.placeItems = "center";
      d.append(contentEl);
      d.style.position = "absolute";
      d.style.padding = "0";
      d.style.border = "none";
      d.style.background = "transparent";
      d.style.color = "rgba(255,255,255,0.92)";
      d.style.userSelect = "none";
      d.style.pointerEvents = "none";
      d.style.zIndex = "30";
      d.style.whiteSpace = "nowrap";
      d.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
      d.style.fontWeight = "400";
      layer!.append(d);
    }
    d.dataset.template = templ;
    if (!isEditingThis) {
      const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.4, h: 0.1, rotationDeg: 0, anchor: "centerCenter", align: "center" };
      d.style.left = `${(g.x ?? 0.5) * 100}%`;
      d.style.top = `${(g.y ?? 0.5) * 100}%`;
      d.style.width = `${(g.w ?? 0.4) * 100}%`;
      d.style.height = `${(g.h ?? 0.1) * 100}%`;
      applyGeomTransformCss(d, g);
      d.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
    }
  };

  const ensureButtonsEl = (sid: string, paramsRaw: any) => {
    let boxEl = layer!.querySelector<HTMLElement>(`.timer-sub-buttons.comp-sub[data-sub-id="${sid}"]`);
    if (!boxEl) {
      boxEl = document.createElement("div");
      boxEl.className = "timer-sub timer-sub-buttons comp-chrome comp-sub";
      boxEl.dataset.subId = sid;
      boxEl.dataset.compPath = timerId;
      boxEl.style.position = "absolute";
      boxEl.style.padding = "0";
      boxEl.style.border = "none";
      boxEl.style.background = "transparent";
      boxEl.style.pointerEvents = "auto";
      boxEl.style.zIndex = "40";
      boxEl.style.userSelect = "none";
      const grid = document.createElement("div");
      grid.className = "ip-buttons-grid";
      grid.style.position = "absolute";
      grid.style.inset = "0";
      grid.style.display = "grid";
      grid.style.alignItems = "stretch";
      grid.style.justifyItems = "stretch";
      grid.style.gap = "10px";
      grid.style.padding = "0";
      grid.style.boxSizing = "border-box";
      boxEl.append(grid);
      layer!.append(boxEl);
    }

    const labels = parseList(paramsRaw.labels);
    const actions = parseList(paramsRaw.actions);
    const vSplits = parseSplits(parseList((paramsRaw as any).vSplits));
    const hSplits = parseSplits(parseList((paramsRaw as any).hSplits));
    const fontScale0 = Number(String((paramsRaw as any).fontScale ?? "1").trim());
    const fontScale = Number.isFinite(fontScale0) && fontScale0 > 0 ? fontScale0 : 1;
    boxEl.dataset.templates = JSON.stringify(labels);
    boxEl.dataset.actions = JSON.stringify(actions);
    boxEl.dataset.vSplits = JSON.stringify(vSplits);
    boxEl.dataset.hSplits = JSON.stringify(hSplits);
    boxEl.dataset.fontScale = String(fontScale);

    if (!isEditingThis) {
      const g = geoms[sid] ?? { x: 0.5, y: 0.5, w: 0.55, h: 0.1, rotationDeg: 0, anchor: "centerCenter", align: "center" };
      boxEl.style.left = `${(g.x ?? 0.5) * 100}%`;
      boxEl.style.top = `${(g.y ?? 0.5) * 100}%`;
      boxEl.style.width = `${(g.w ?? 0.55) * 100}%`;
      boxEl.style.height = `${(g.h ?? 0.1) * 100}%`;
      applyGeomTransformCss(boxEl, g);
    }

    // Rebuild button nodes (simple + safe).
    const grid = boxEl.querySelector<HTMLElement>(":scope > .ip-buttons-grid");
    if (grid) {
      const existing = Array.from(grid.querySelectorAll<HTMLButtonElement>(":scope > button.ip-controlbtn"));
      const needRebuild = existing.length !== labels.length || existing.some((b) => !b.querySelector(":scope > .ip-button-content"));
      if (needRebuild) {
        grid.replaceChildren();
        labels.forEach((tpl, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ip-controlbtn";
          btn.dataset.idx = String(idx + 1);
          btn.dataset.template = String(tpl ?? "");
          btn.dataset.action = String(actions[idx] ?? "");
          const contentEl = document.createElement("div");
          contentEl.className = "ip-button-content";
          btn.appendChild(contentEl);
          grid.append(btn);
        });
      } else {
        existing.forEach((btn, idx) => {
          btn.dataset.idx = String(idx + 1);
          btn.dataset.template = String(labels[idx] ?? "");
          btn.dataset.action = String(actions[idx] ?? "");
        });
      }
    }
  };

  for (const ln0 of lines) {
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;

    const mt = ln.match(/^text\[name=(?<id>[a-zA-Z_]\w*)\]\s*:\s*(?<content>.*)$/);
    if (mt?.groups) {
      const sid = mt.groups.id;
      const content = mt.groups.content ?? "";
      seenText.add(sid);
      ensureTextEl(sid, content);
      continue;
    }

    const mb = ln.match(/^buttons\[(?<params>.*)\]\s*$/);
    if (mb?.groups?.params) {
      const params = parseInlineParams(mb.groups.params);
      const sid = String(params.name ?? "").trim();
      if (!sid) continue;
      seenButtons.add(sid);
      ensureButtonsEl(sid, params);
      continue;
    }

    const ma = ln.match(/^arrow\[(?<params>.*)\]\s*$/);
    if (ma?.groups?.params) {
      const p = parseInlineParams(ma.groups.params);
      const sid = String(p.name ?? "").trim();
      if (!sid) continue;
      const vec = (raw: any, def: { x: number; y: number }) => {
        const s = String(raw ?? "").trim();
        const m2 = s.match(/^\(\s*([\-0-9.]+)\s*,\s*([\-0-9.]+)\s*\)\s*$/);
        if (!m2) return def;
        const x = Number(m2[1]);
        const y = Number(m2[2]);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : def;
      };
      const fr = vec(p.from, { x: 0, y: 0 });
      const to = vec(p.to, { x: 1, y: 0 });
      const col = String(p.color ?? "white") || "white";
      const w = Number(String(p.width ?? "").trim());
      arrowSpecs.push({ id: sid, x0: fr.x, y0: fr.y, x1: to.x, y1: to.y, color: col, width: Number.isFinite(w) ? w : 0.006 });
      continue;
    }
  }

  // Default axis arrows (selectable/editable via plot-arrow hitboxes).
  // Origin is (0,0) in plot coords (bottom-left).
  const ensureAxis = (id: "x_axis" | "y_axis", def: { x0: number; y0: number; x1: number; y1: number }) => {
    const existing = arrowSpecs.find((a: any) => String(a?.id ?? "") === id);
    if (existing) return;
    arrowSpecs.push({ id, ...def, color: "white", width: 0.006 });
  };
  ensureAxis("x_axis", { x0: 0, y0: 0, x1: 1, y1: 0 });
  ensureAxis("y_axis", { x0: 0, y0: 0, x1: 0, y1: 1 });

  // Remove stale sub-elements (if elements.pr removed them).
  for (const e of Array.from(layer.querySelectorAll<HTMLElement>(".timer-sub-text.comp-sub"))) {
    const sid = String(e.dataset.subId ?? "");
    if (sid && !seenText.has(sid)) e.remove();
  }
  for (const e of Array.from(layer.querySelectorAll<HTMLElement>(".timer-sub-buttons.comp-sub"))) {
    const sid = String(e.dataset.subId ?? "");
    if (sid && !seenButtons.has(sid)) e.remove();
  }

  (layer as any).__arrowSpecs = arrowSpecs;
  (layer as any).__textGeoms = geoms;
  return layer;
}

export function layoutTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : timerEl.getBoundingClientRect();
  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const h = Number(g.h ?? 0.1);
    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;
  }
}

export function renderTimerCompositeTexts(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-text"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  const interactive = appMode === "edit" && isGroupEditing;

  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : timerEl.getBoundingClientRect();

  for (const t of els) {
    const sid = t.dataset.subId ?? "";
    const g = geoms[sid] ?? {};
    const x = Number(g.x ?? 0.5);
    const y = Number(g.y ?? 0.5);
    const w = Number(g.w ?? 0.4);
    const h = Number(g.h ?? 0.1);
    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    applyGeomTransformCss(t, g);
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";

    const fontPx = Math.max(1, timerBox.height * h * 0.85);
    t.style.fontSize = `${fontPx}px`;
    t.style.lineHeight = `${fontPx}px`;

    const tpl = t.dataset.template ?? "";
    const resolved = applyDataBindings(tpl, data);
    const prev = t.dataset.rawText ?? "";
    if (prev !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope .timer-sub-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    t.style.pointerEvents = interactive ? "auto" : "none";
    t.style.cursor = interactive ? "grab" : "default";
  }
}

export function renderTimerCompositeButtons(timerEl: HTMLElement, layer: HTMLElement, data: Record<string, string | number>) {
  const els = Array.from(layer.querySelectorAll<HTMLElement>(":scope .timer-sub-buttons"));
  const compositeId = String((window as any).__ip_compositeEditId ?? "");
  const compositeKind = String((window as any).__ip_compositeEditKind ?? "");
  const isGroupEditing = (window as any).__ip_compositeEditing && compositeKind === "timer" && compositeId === String(timerEl.dataset.nodeId ?? "");
  const appMode = (document.querySelector<HTMLElement>(".mode-toggle")?.dataset.mode ?? "edit").toLowerCase();
  // Intentionally no console logging (keeps editor responsive).
  const hPx = Number(timerEl.dataset.timerHpx ?? "0");
  const wPx = Number(timerEl.dataset.timerWpx ?? "0");
  const timerBox = hPx > 0 && wPx > 0 ? { width: wPx, height: hPx } : timerEl.getBoundingClientRect();
  for (const boxEl of els) {
    const canSelectGroup = appMode === "edit" && isGroupEditing;
    boxEl.style.pointerEvents = appMode === "live" ? "auto" : canSelectGroup ? "auto" : "none";
    const grid = boxEl.querySelector<HTMLElement>(":scope > .ip-buttons-grid");
    const btns = Array.from(boxEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"));

    // In edit/group-edit, inner buttons must NEVER steal clicks (selection/dragging should work).
    // Relying on CSS only is brittle (data-ip-mode attribute / specificity).
    for (const b of btns) b.style.pointerEvents = canSelectGroup ? "none" : "auto";

    // Layout: use vSplits/hSplits if provided; otherwise default to 1xN.
    let vSplits: number[] = [];
    let hSplits: number[] = [];
    try {
      vSplits = JSON.parse(String(boxEl.dataset.vSplits ?? "[]"));
      hSplits = JSON.parse(String(boxEl.dataset.hSplits ?? "[]"));
    } catch {
      vSplits = [];
      hSplits = [];
    }
    const nBtns = btns.length;
    const cols = Math.max(1, (vSplits?.length ?? 0) + 1);
    const rows = Math.max(1, (hSplits?.length ?? 0) + 1);
    const enoughCells = rows * cols >= nBtns;
    const colCss = splitFracsToCss(enoughCells ? vSplits : [], enoughCells ? cols : nBtns);
    const rowCss = splitFracsToCss(enoughCells ? hSplits : [], enoughCells ? rows : 1);
    if (grid) {
      grid.style.gridTemplateColumns = colCss.join(" ");
      grid.style.gridTemplateRows = rowCss.join(" ");
    }

    // Divider lines (draggable) should ONLY be visible when:
    // - in composite/group edit, AND
    // - this buttons sub-element is selected.
    const showSplits = canSelectGroup && boxEl.classList.contains("is-selected");
    for (const old of Array.from(boxEl.querySelectorAll<HTMLElement>(":scope > .ip-btn-split"))) old.remove();
    if (!showSplits) {
      // Still update text content + layout, but no split chrome.
    } else {
    const mkSplit = (dir: "v" | "h", idx: number, frac: number) => {
      const d = document.createElement("div");
      d.className = `ip-btn-split ip-btn-split-${dir}`;
      d.dataset.kind = "button-split";
      d.dataset.dir = dir;
      d.dataset.idx = String(idx);
      d.dataset.subId = String(boxEl.dataset.subId ?? "");
      d.style.position = "absolute";
      d.style.zIndex = "50";
      d.style.pointerEvents = canSelectGroup ? "auto" : "none";
      d.style.background = "rgba(110,168,255,0.55)";
      d.style.borderRadius = "2px";
      const cs = grid ? getComputedStyle(grid) : null;
      const gapX = Math.max(0, Number.parseFloat(cs?.columnGap ?? "") || Number.parseFloat(cs?.gap ?? "") || 10);
      const gapY = Math.max(0, Number.parseFloat(cs?.rowGap ?? "") || Number.parseFloat(cs?.gap ?? "") || 10);
      const nColsEff = enoughCells ? cols : Math.max(1, nBtns);
      const nRowsEff = enoughCells ? rows : 1;
      const boxW = Math.max(1, boxEl.clientWidth);
      const boxH = Math.max(1, boxEl.clientHeight);
      const availW = Math.max(1, boxW - gapX * Math.max(0, nColsEff - 1));
      const availH = Math.max(1, boxH - gapY * Math.max(0, nRowsEff - 1));
      if (dir === "v") {
        // Place in the CENTER of the column gap between col idx and idx+1.
        const xPx = availW * frac + gapX * (idx + 0.5);
        d.style.left = `${xPx}px`;
        d.style.top = "0%";
        d.style.width = "6px";
        d.style.height = "100%";
        d.style.transform = "translate(-50%, 0%)";
        d.style.cursor = "col-resize";
      } else {
        d.style.left = "0%";
        // Place in the CENTER of the row gap between row idx and idx+1.
        const yPx = availH * frac + gapY * (idx + 0.5);
        d.style.top = `${yPx}px`;
        d.style.width = "100%";
        d.style.height = "6px";
        d.style.transform = "translate(0%, -50%)";
        d.style.cursor = "row-resize";
      }
      boxEl.appendChild(d);
    };
    if (enoughCells) {
      vSplits.forEach((p, i) => mkSplit("v", i, Number(p)));
      hSplits.forEach((p, i) => mkSplit("h", i, Number(p)));
    } else if (nBtns > 1) {
      // Default 1xN: show v-splits even if not persisted yet.
      for (let i = 1; i < nBtns; i++) mkSplit("v", i - 1, i / nBtns);
    }
    }

    // Font sizing:
    // - edges should not affect font size (handled in editor by adjusting fontScale on edge-resize)
    // - corners scale should affect font size (via h change, no fontScale compensation)
    const gH = Number(boxEl.style.height.replace("%", "")) / 100;
    const fontScale = Number(String(boxEl.dataset.fontScale ?? "1")) || 1;
    const fontPx = Math.max(12, timerBox.height * Math.max(0.02, gH) * 0.55 * fontScale);
    if (grid) grid.style.fontSize = `${fontPx}px`;
    for (const btn of btns) {
      (btn.style as any).fontSize = `${fontPx}px`;
    }

    for (const btn of Array.from(boxEl.querySelectorAll<HTMLButtonElement>("button.ip-controlbtn"))) {
      const tpl = btn.dataset.template ?? "";
      const resolved = applyDataBindings(tpl, data);
      const prev = btn.dataset.rawText ?? "";
      if (prev !== resolved) {
        btn.dataset.rawText = resolved;
        const contentEl = btn.querySelector<HTMLElement>(".ip-button-content");
        if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
      }
    }
    // Hide legacy header if present
    timerEl.querySelector<HTMLElement>(".timer-header")?.setAttribute("style", "display:none !important");
  }
}

export function renderTimerCompositeArrows(_timerEl: HTMLElement, _layer: HTMLElement) {
  // Deprecated: axis arrows must be real `arrow` nodes (engine-drawn), not SVG overlays.
}

export function syncTimerPlotRegion(timerEl: HTMLElement, layer: HTMLElement) {
  const geoms: Record<string, any> = (layer as any).__textGeoms ?? {};
  const pg = (geoms["plot"] ??= { x: PLOT_FRACS.leftF, y: PLOT_FRACS.topF, w: PLOT_FRACS.rightF - PLOT_FRACS.leftF, h: PLOT_FRACS.bottomF - PLOT_FRACS.topF, rotationDeg: 0, anchor: "topLeft", align: "left" });
  const ptl = anchorToTopLeftFrac({ x: Number(pg.x), y: Number(pg.y), w: Number(pg.w), h: Number(pg.h), anchor: String(pg.anchor ?? "topLeft") });
  const leftF = ptl.x;
  const topF = ptl.y;
  const rightF = leftF + Number(pg.w);
  const bottomF = topF + Number(pg.h);
  timerEl.dataset.plotLeftF = String(leftF);
  timerEl.dataset.plotRightF = String(rightF);
  timerEl.dataset.plotTopF = String(topF);
  timerEl.dataset.plotBottomF = String(bottomF);
  const plotGroup = (layer as any).__plotGroup as HTMLElement | null;
  if (plotGroup) {
    plotGroup.style.left = `${leftF * 100}%`;
    plotGroup.style.top = `${topF * 100}%`;
    plotGroup.style.width = `${Number(pg.w) * 100}%`;
    plotGroup.style.height = `${Number(pg.h) * 100}%`;
  }
}

