import type { Node } from "../core/model";

type PlayerLink = {
  videoEl?: HTMLVideoElement;
  iframeEl?: HTMLIFrameElement;
  sliderEl?: HTMLInputElement;
  videoNodeId?: string;
  playLabel?: string;
  pauseLabel?: string;
};

type WebcamLink = { shot?: () => void; toggleRec?: () => void };

type ButtonsRuntimeState = {
  count: number;
  colWeights: number[];
  rowWeights: number[];
  colSpace: number;
  rowSpace: number;
  mode: string;
};

type ControlNodeDeps = {
  mode: string;
  inferPlayerId: (node: any) => string;
  ensurePlayerBus: () => void;
  youtubePlayers: Map<string, any>;
  playerLinks: Map<string, PlayerLink>;
  webcamLinks: Map<string, WebcamLink>;
  renderKatex: (text: string) => string;
  persistButtons: (payload: {
    id: string;
    viewId: string;
    labels: string[];
    actions: string[];
    buttonsMode?: "keep" | "click" | "radio";
    hSplits?: number[];
    vSplits?: number[];
    rows?: number;
    cols?: number;
    doc?: "presentation" | "notes";
    space?: "world" | "screen" | "group";
    groupId?: string | null;
  }) => Promise<void>;
};

export const ensureSliderNodeElement = (el: HTMLElement) => {
  el.classList.add("node-slider");
  let input = el.querySelector<HTMLInputElement>(".slider-input");
  if (!input) {
    input = document.createElement("input");
    input.type = "range";
    input.className = "slider-input";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = "0";
    el.appendChild(input);
  }
};

export const ensureButtonsNodeElement = (el: HTMLElement) => {
  el.classList.add("node-buttons");
  let grid = el.querySelector<HTMLElement>(".buttons-grid");
  let splits = el.querySelector<HTMLElement>(".buttons-splits");
  if (!grid) {
    grid = document.createElement("div");
    grid.className = "buttons-grid";
    el.appendChild(grid);
  }
  if (!splits) {
    splits = document.createElement("div");
    splits.className = "buttons-splits";
    el.appendChild(splits);
  }
};

export const updateButtonsControlNode = (
  el: HTMLElement,
  node: Node,
  deps: ControlNodeDeps,
) => {
  const grid = el.querySelector<HTMLElement>(".buttons-grid");
  const splitsLayer = el.querySelector<HTMLElement>(".buttons-splits");
  if (!grid || !splitsLayer) throw new Error("[next] buttons node missing grid");
  const anyNode = node as any;
  (el as any).__buttonsNode = node;
  const labels = Array.isArray(anyNode.labels) ? anyNode.labels : (anyNode.templates ?? []);
  const actions = Array.isArray(anyNode.actions) ? anyNode.actions : [];
  const buttonsMode = String(anyNode.buttonsMode ?? "click");
  const hSplits = Array.isArray(anyNode.hSplits) ? anyNode.hSplits : null;
  const vSplits = Array.isArray(anyNode.vSplits) ? anyNode.vSplits : null;
  let cols = Number(anyNode.cols ?? 0) || 0;
  let rows = Number(anyNode.rows ?? 0) || 0;
  if (!cols && hSplits?.length) cols = hSplits.length;
  if (!rows && vSplits?.length) rows = vSplits.length;
  const count = Math.max(labels.length, actions.length, cols && rows ? cols * rows : labels.length || 1);
  if (!cols && rows) cols = Math.max(1, Math.ceil(count / rows));
  if (!rows && cols) rows = Math.max(1, Math.ceil(count / cols));
  if (!cols) cols = Math.max(1, count);
  if (!rows) rows = 1;
  const colWeights = (hSplits && hSplits.length ? hSplits : Array(cols).fill(1)).map((w: number) => Number(w));
  const rowWeights = (vSplits && vSplits.length ? vSplits : Array(rows).fill(1)).map((w: number) => Number(w));
  grid.style.gridTemplateColumns = colWeights.map((w: number) => `${Math.max(0.01, w)}fr`).join(" ");
  grid.style.gridTemplateRows = rowWeights.map((w: number) => `${Math.max(0.01, w)}fr`).join(" ");

  const existing = Array.from(grid.querySelectorAll<HTMLButtonElement>("button.buttons-btn"));
  while (existing.length < count) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "buttons-btn";
    const label = document.createElement("span");
    label.className = "buttons-btn-label";
    btn.appendChild(label);
    grid.appendChild(btn);
    existing.push(btn);
  }
  while (existing.length > count) {
    existing.pop()?.remove();
  }

  const playerId = deps.inferPlayerId(anyNode);
  let playerPlayLabel = "";
  let playerPauseLabel = "";
  let playerIsPlaying = false;
  const isPlayerToggle =
    playerId && actions.length === 1 && String(actions[0] ?? "").toLowerCase() === "toggle";
  if (playerId) {
    deps.ensurePlayerBus();
    const link = deps.playerLinks.get(playerId) ?? {};
    playerPlayLabel = String(anyNode.playLabel ?? link.playLabel ?? labels[0] ?? "Play");
    playerPauseLabel = String(anyNode.pauseLabel ?? link.pauseLabel ?? labels[1] ?? "Pause");
    const yt = link.videoNodeId ? deps.youtubePlayers.get(String(link.videoNodeId)) : null;
    const ytState = yt?.getPlayerState?.();
    if (yt) playerIsPlaying = ytState === 1;
    else if (link.videoEl) playerIsPlaying = !link.videoEl.paused && !link.videoEl.ended;
    link.playLabel = playerPlayLabel;
    link.pauseLabel = playerPauseLabel;
    deps.playerLinks.set(playerId, link);
  }

  const stateArr: boolean[] = Array.isArray(anyNode.buttonsState) ? anyNode.buttonsState : [];
  if (buttonsMode !== "click" && stateArr.length !== count) {
    anyNode.buttonsState = Array.from({ length: count }, (_, i) => Boolean(stateArr[i]));
  }
  const escapeLatexText = (s: string) =>
    s
      .replaceAll("\\", "\\textbackslash{}")
      .replaceAll("{", "\\{")
      .replaceAll("}", "\\}")
      .replaceAll("$", "\\$")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_")
      .replaceAll("#", "\\#")
      .replaceAll("&", "\\&")
      .replaceAll("^", "\\^{}");
  const toKatexLabel = (s: string) => {
    const raw = String(s ?? "");
    if (raw.includes("$")) return raw;
    if (/(?:\\[a-zA-Z]+|[_^])/.test(raw)) return `$${raw}$`;
    return `$\\text{${escapeLatexText(raw)}}$`;
  };
  existing.forEach((btn, idx) => {
    let label = labels[idx] ?? "-";
    const action = actions[idx] ?? "";
    if (isPlayerToggle && idx === 0) {
      label = playerIsPlaying ? playerPauseLabel : playerPlayLabel;
    }
    const katexLabel = toKatexLabel(label);
    if (btn.dataset.label !== label) {
      btn.dataset.label = label;
      const inner = btn.querySelector<HTMLElement>(".buttons-btn-label");
      if (inner) inner.innerHTML = deps.renderKatex(katexLabel);
    }
    btn.dataset.action = action;
    btn.dataset.index = String(idx);
    if (buttonsMode !== "click") {
      const pressed = Boolean(anyNode.buttonsState?.[idx]);
      btn.classList.toggle("is-pressed", pressed);
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    } else {
      btn.classList.remove("is-pressed");
      btn.removeAttribute("aria-pressed");
    }
  });

  const rect = el.getBoundingClientRect();
  const rowCount = rowWeights.length;
  const baseCellH = rect.height / Math.max(1, rowCount);
  const padPx = Math.max(1, baseCellH * 0.05);
  const gapPx = Math.max(1, baseCellH * 0.03);
  const fontPx = Math.max(12, baseCellH * 0.6);
  for (const btn of existing) {
    btn.style.fontSize = `${fontPx}px`;
    btn.style.lineHeight = "1.1";
    btn.style.padding = `${padPx}px`;
  }
  const pad = padPx;
  const gap = gapPx;
  const innerW = Math.max(1, rect.width - pad * 2);
  const innerH = Math.max(1, rect.height - pad * 2);
  const colCount = colWeights.length;
  const colTotal = colWeights.reduce((a: number, b: number) => a + Math.max(0.01, b), 0);
  const rowTotal = rowWeights.reduce((a: number, b: number) => a + Math.max(0.01, b), 0);
  const colSpace = Math.max(1, innerW - gap * Math.max(0, colCount - 1));
  const rowSpace = Math.max(1, innerH - gap * Math.max(0, rowCount - 1));
  const colWidths = colWeights.map((w: number) => (Math.max(0.01, w) / colTotal) * colSpace);
  const rowHeights = rowWeights.map((w: number) => (Math.max(0.01, w) / rowTotal) * rowSpace);
  (el as any).__buttonsRuntime = {
    count,
    colWeights,
    rowWeights,
    colSpace,
    rowSpace,
    mode: deps.mode,
  } satisfies ButtonsRuntimeState;

  const ensureLine = (cls: string) => {
    const line = document.createElement("div");
    line.className = `buttons-split ${cls}`;
    splitsLayer.appendChild(line);
    return line;
  };
  const hasCustomSplits = !!((hSplits && hSplits.length) || (vSplits && vSplits.length));
  const vLines = Array.from(splitsLayer.querySelectorAll<HTMLElement>(".buttons-split.vertical"));
  const hLines = Array.from(splitsLayer.querySelectorAll<HTMLElement>(".buttons-split.horizontal"));
  const wantedVLines = hasCustomSplits ? Math.max(0, colCount - 1) : 0;
  const wantedHLines = hasCustomSplits ? Math.max(0, rowCount - 1) : 0;
  while (vLines.length < wantedVLines) vLines.push(ensureLine("vertical"));
  while (vLines.length > wantedVLines) vLines.pop()?.remove();
  while (hLines.length < wantedHLines) hLines.push(ensureLine("horizontal"));
  while (hLines.length > wantedHLines) hLines.pop()?.remove();

  let accX = pad;
  vLines.forEach((line, idx) => {
    accX += colWidths[idx] + gap / 2;
    line.style.left = `${accX}px`;
    line.style.top = `${pad}px`;
    line.style.height = `${innerH}px`;
    line.dataset.axis = "x";
    line.dataset.index = String(idx);
    accX += gap / 2;
  });
  let accY = pad;
  hLines.forEach((line, idx) => {
    accY += rowHeights[idx] + gap / 2;
    line.style.top = `${accY}px`;
    line.style.left = `${pad}px`;
    line.style.width = `${innerW}px`;
    line.dataset.axis = "y";
    line.dataset.index = String(idx);
    accY += gap / 2;
  });

  const bindSplitLine = (line: HTMLElement) => {
    if (line.dataset.bound) return;
    line.dataset.bound = "1";
    line.addEventListener("pointerdown", (ev) => {
      const runtime = (el as any).__buttonsRuntime as ButtonsRuntimeState | undefined;
      if (!runtime || runtime.mode === "live") return;
      ev.preventDefault();
      const axis = String(line.dataset.axis ?? "x");
      const idx = Number(line.dataset.index ?? "0");
      const n: any = (el as any).__buttonsNode;
      const startWeights = {
        cols: (Array.isArray(n.hSplits) ? n.hSplits.slice() : runtime.colWeights.slice()).map((v: number) => Number(v)),
        rows: (Array.isArray(n.vSplits) ? n.vSplits.slice() : runtime.rowWeights.slice()).map((v: number) => Number(v)),
      };
      const startX = ev.clientX;
      const startY = ev.clientY;
      line.setPointerCapture(ev.pointerId);
      const minWeight = 0.1;
      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (axis === "x") {
          const total = startWeights.cols.reduce((a: number, b: number) => a + Math.max(minWeight, b), 0);
          const delta = (dx / Math.max(1, runtime.colSpace)) * total;
          const next = startWeights.cols.slice();
          next[idx] = Math.max(minWeight, next[idx] + delta);
          next[idx + 1] = Math.max(minWeight, next[idx + 1] - delta);
          const norm = next.reduce((a: number, b: number) => a + b, 0) / total;
          n.hSplits = next.map((v: number) => v / Math.max(1e-6, norm));
        } else {
          const total = startWeights.rows.reduce((a: number, b: number) => a + Math.max(minWeight, b), 0);
          const delta = (dy / Math.max(1, runtime.rowSpace)) * total;
          const next = startWeights.rows.slice();
          next[idx] = Math.max(minWeight, next[idx] + delta);
          next[idx + 1] = Math.max(minWeight, next[idx + 1] - delta);
          const norm = next.reduce((a: number, b: number) => a + b, 0) / total;
          n.vSplits = next.map((v: number) => v / Math.max(1e-6, norm));
        }
      };
      const onUp = () => {
        line.removeEventListener("pointermove", onMove);
        line.removeEventListener("pointerup", onUp);
        line.removeEventListener("pointercancel", onUp);
        try {
          line.releasePointerCapture(ev.pointerId);
        } catch {}
        const storeMode = document.body.dataset.ipMode ?? "edit";
        if (storeMode !== "live") {
          const groupId = n.groupId ? String(n.groupId) : null;
          const persistViewId = groupId ? "group" : n.space === "screen" ? "screen_main" : n.viewId ?? "";
          if (persistViewId) {
            void deps.persistButtons({
              id: String(n.id),
              viewId: persistViewId,
              labels: Array.isArray(n.templates) ? n.templates : Array.isArray(n.labels) ? n.labels : [],
              actions: Array.isArray(n.actions) ? n.actions : [],
              buttonsMode: n.buttonsMode,
              hSplits: n.hSplits,
              vSplits: n.vSplits,
              rows: n.rows,
              cols: n.cols,
              space: groupId ? "group" : n.space,
              groupId,
            });
          }
        }
      };
      line.addEventListener("pointermove", onMove);
      line.addEventListener("pointerup", onUp, { once: true });
      line.addEventListener("pointercancel", onUp, { once: true });
    });
  };
  vLines.forEach(bindSplitLine);
  hLines.forEach(bindSplitLine);

  if (!grid.dataset.bound) {
    grid.dataset.bound = "1";
    grid.addEventListener("click", (ev) => {
      const modeNow = document.body.dataset.ipMode ?? "edit";
      if (modeNow !== "live") return;
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("button.buttons-btn");
      if (!btn) return;
      const n: any = (el as any).__buttonsNode;
      const idx = Number(btn.dataset.index ?? "0") || 0;
      const actionRaw = String(btn.dataset.action ?? "");
      const actionLower = actionRaw.toLowerCase();
      const currentLabels = Array.isArray(n.labels) ? n.labels : (n.templates ?? []);
      const currentActions = Array.isArray(n.actions) ? n.actions : [];
      const currentCount = Math.max(currentLabels.length, currentActions.length, Number(n.cols ?? 0) * Number(n.rows ?? 0), 1);
      const mode = String(n?.buttonsMode ?? "click");
      if (mode === "keep") {
        const state = Array.isArray(n.buttonsState) ? n.buttonsState.slice() : Array(currentCount).fill(false);
        state[idx] = !state[idx];
        n.buttonsState = state;
      } else if (mode === "radio") {
        const state = Array(currentCount).fill(false);
        state[idx] = true;
        n.buttonsState = state;
      }
      const playerId2 = deps.inferPlayerId(n);
      const webcamLink = playerId2 ? deps.webcamLinks.get(playerId2) : null;
      if (webcamLink && (actionLower === "rec" || actionLower === "record" || actionLower === "toggle-rec")) {
        webcamLink.toggleRec?.();
        return;
      }
      if (webcamLink && (actionLower === "shot" || actionLower === "screenshot")) {
        webcamLink.shot?.();
        return;
      }
      const detail = {
        id: String(n?.id ?? ""),
        playerId: playerId2,
        index: idx,
        action: actionRaw,
        label: String(btn.dataset.label ?? ""),
      };
      console.log("[player] buttons click", detail);
      window.dispatchEvent(new CustomEvent("ip-buttons-action", { detail }));
    });
  }
};

export const updateSliderControlNode = (
  el: HTMLElement,
  node: Node,
  deps: Pick<ControlNodeDeps, "inferPlayerId" | "ensurePlayerBus" | "playerLinks">,
) => {
  const input = el.querySelector<HTMLInputElement>(".slider-input");
  if (!input) throw new Error("[next] slider node missing input");
  const anyNode = node as any;
  (el as any).__sliderNode = node;
  const vertical =
    String(anyNode.orientation ?? "") === "vertical" ||
    Boolean(anyNode.vertical) ||
    String(anyNode.soundRole ?? "") === "threshold";
  el.classList.toggle("is-vertical", vertical);
  if (vertical) input.setAttribute("orient", "vertical");
  else input.removeAttribute("orient");

  const valuesRaw = Array.isArray(anyNode.values) ? anyNode.values : null;
  const values = valuesRaw
    ? valuesRaw.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v))
    : [];
  if (values.length) {
    const current = Number(anyNode.value ?? values[0]);
    let idx = values.findIndex((v: number) => v === current);
    if (idx < 0) {
      let best = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < values.length; i += 1) {
        const diff = Math.abs(values[i]! - current);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      idx = best;
    }
    input.min = "0";
    input.max = String(Math.max(0, values.length - 1));
    input.step = "1";
    if (!input.dataset.dragging) input.value = String(idx);
  } else {
    const min = Number(anyNode.min ?? 0);
    const max = Number(anyNode.max ?? 1);
    const step = Number(anyNode.step ?? 0.01);
    const value = Number(anyNode.value ?? 0);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    if (!input.dataset.dragging) input.value = String(value);
  }

  const playerId = deps.inferPlayerId(anyNode);
  if (playerId) {
    deps.ensurePlayerBus();
    const link = deps.playerLinks.get(playerId) ?? {};
    link.sliderEl = input;
    deps.playerLinks.set(playerId, link);
  }

  if (!input.dataset.bound) {
    input.dataset.bound = "1";
    input.addEventListener("pointerdown", () => {
      input.dataset.dragging = "1";
    });
    input.addEventListener("pointerup", () => {
      delete input.dataset.dragging;
    });
    input.addEventListener("input", () => {
      const n: any = (el as any).__sliderNode;
      const val = Number(input.value);
      const values2 = Array.isArray(n?.values) ? n.values : null;
      let valueOut = val;
      if (values2 && values2.length) {
        const idx = Math.max(0, Math.min(values2.length - 1, Math.round(val)));
        valueOut = Number(values2[idx] ?? values2[0]);
        n.value = valueOut;
      } else if (Number.isFinite(val)) {
        n.value = val;
      }
      window.dispatchEvent(
        new CustomEvent("ip-slider-change", {
          detail: {
            id: String(n?.id ?? ""),
            playerId: deps.inferPlayerId(n),
            value: valueOut,
          },
        }),
      );
    });
  }
};
