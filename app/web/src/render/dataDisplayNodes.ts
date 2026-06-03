import type { Node } from "../core/model";
import type { Store } from "../core/store";

const DEFAULT_PALETTE = ["red", "green", "blue", "yellow", "cyan", "magenta"];

const toAlpha = (n: number, upper: boolean) => {
  let num = Math.max(1, Math.floor(n));
  let out = "";
  while (num > 0) {
    num -= 1;
    out = String.fromCharCode((num % 26) + (upper ? 65 : 97)) + out;
    num = Math.floor(num / 26);
  }
  return out;
};

const toRoman = (n: number, upper: boolean) => {
  const vals: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let num = Math.max(1, Math.floor(n));
  let out = "";
  for (const [value, token] of vals) {
    while (num >= value) {
      out += token;
      num -= value;
    }
  }
  return upper ? out : out.toLowerCase();
};

const formatChoiceLabel = (kindRaw: string, index: number) => {
  const kind = String(kindRaw || "A");
  const n = Math.max(1, index + 1);
  if (kind === "A") return toAlpha(n, true);
  if (kind === "a") return toAlpha(n, false);
  if (kind === "1") return String(n);
  if (kind === "I") return toRoman(n, true);
  if (kind === "i") return toRoman(n, false);
  return toAlpha(n, true);
};

const drawWheelCanvas = (
  canvas: HTMLCanvasElement,
  wheelSize: number,
  answers: any[],
  counts: number[],
  choiceType: string,
) => {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.floor(wheelSize * dpr));
  const ch = Math.max(1, Math.floor(wheelSize * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${wheelSize}px`;
    canvas.style.height = `${wheelSize}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[next] multichoice canvas missing context");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wheelSize, wheelSize);
  const cx = wheelSize / 2;
  const cy = wheelSize / 2;
  const r = Math.max(2, wheelSize / 2 - 2);
  const total = Math.max(1, answers.length);
  const weights: number[] = answers.map((_: any, idx: number) => Math.max(0, Number(counts[idx] ?? 0)));
  const hasWeights = weights.some((v: number) => v > 0);
  const totalWeight = hasWeights ? weights.reduce((a: number, b: number) => a + b, 0) : total;
  const labels = answers.map((_: any, idx: number) => formatChoiceLabel(choiceType, idx));
  if (!hasWeights) {
    for (let i = 0; i < total; i++) {
      const a0 = (i / total) * Math.PI * 2;
      const a1 = ((i + 1) / total) * Math.PI * 2;
      const colorRaw = String(answers[i]?.color ?? "");
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = colorRaw || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length] || `hsl(${(i / total) * 360}, 70%, 55%)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const mid = (a0 + a1) / 2;
      const tx = cx + Math.cos(mid) * r * 0.6;
      const ty = cy + Math.sin(mid) * r * 0.6;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.font = `${Math.max(10, r * 0.35)}px system-ui, -apple-system, Segoe UI, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labels[i] ?? "", tx, ty);
    }
    return;
  }
  const nonzeroIdx = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  if (nonzeroIdx.length === 1) {
    const i = nonzeroIdx[0] ?? 0;
    const colorRaw = String(answers[i]?.color ?? "");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = colorRaw || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length] || `hsl(${(i / total) * 360}, 70%, 55%)`;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = `${Math.max(10, r * 0.35)}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[i] ?? "", cx, cy);
    return;
  }
  let acc = 0;
  for (let i = 0; i < total; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    const frac = totalWeight > 0 ? w / totalWeight : 1 / total;
    const a0 = acc * Math.PI * 2;
    acc += frac;
    const a1 = acc * Math.PI * 2;
    const colorRaw = String(answers[i]?.color ?? "");
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = colorRaw || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length] || `hsl(${(i / total) * 360}, 70%, 55%)`;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const mid = (a0 + a1) / 2;
    const tx = cx + Math.cos(mid) * r * 0.6;
    const ty = cy + Math.sin(mid) * r * 0.6;
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.font = `${Math.max(10, r * 0.35)}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[i] ?? "", tx, ty);
  }
};

type TableDeps = {
  store: Store;
  cameraZoom: number;
  screen: { w: number; h: number };
  sizePx: () => { wPx: number; hPx: number };
  applyBox: () => void;
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
  renderKatex: (text: string, cache: string[]) => { html: string; cache: string[] };
};

type MultichoiceDeps = {
  sizePx: () => { wPx: number; hPx: number };
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
};

export const ensureTableNodeElement = (el: HTMLElement) => {
  el.classList.add("node-table");
  let wrap = el.querySelector<HTMLElement>(".table-wrap");
  let table = el.querySelector<HTMLTableElement>(".table-grid");
  let body = table?.querySelector("tbody");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "table-wrap";
    el.appendChild(wrap);
  }
  if (!table) {
    table = document.createElement("table");
    table.className = "table-grid";
    wrap.appendChild(table);
  }
  if (!body) {
    body = document.createElement("tbody");
    table.appendChild(body);
  }
};

export const ensureMultichoiceNodeElement = (el: HTMLElement) => {
  el.classList.add("node-multichoice");
  if (!el.querySelector(".multichoice-wheel")) {
    const wheel = document.createElement("div");
    wheel.className = "multichoice-wheel";
    const canvas = document.createElement("canvas");
    canvas.className = "multichoice-wheel-canvas";
    wheel.appendChild(canvas);
    const content = document.createElement("div");
    content.className = "multichoice-content";
    const question = document.createElement("div");
    question.className = "multichoice-question";
    const list = document.createElement("div");
    list.className = "multichoice-list";
    content.append(question, list);
    el.append(wheel, content);
  }
};

export const ensureWheelNodeElement = (el: HTMLElement) => {
  el.classList.add("node-wheel");
  if (!el.querySelector(".multichoice-wheel")) {
    const wheel = document.createElement("div");
    wheel.className = "multichoice-wheel";
    const canvas = document.createElement("canvas");
    canvas.className = "multichoice-wheel-canvas";
    wheel.appendChild(canvas);
    el.append(wheel);
  }
};

export const updateTableNode = (el: HTMLElement, node: Node, deps: TableDeps) => {
  const wrap = el.querySelector<HTMLElement>(".table-wrap");
  const table = el.querySelector<HTMLTableElement>(".table-grid");
  const body = table?.querySelector("tbody");
  if (!wrap || !table || !body) throw new Error("[next] table node missing table elements");
  const anyNode = node as any;
  const editable = Boolean(anyNode.editable ?? true);
  const allowEdit = editable && deps.store.mode === "live";
  const editing = allowEdit;
  el.dataset.editing = editing ? "1" : "0";
  el.dataset.editable = editable ? "1" : "0";

  const cells: string[][] = Array.isArray(anyNode.cells) ? anyNode.cells : [];
  const hHeader: string[] = Array.isArray(anyNode.hHeader) ? anyNode.hHeader : [];
  const vHeader: string[] = Array.isArray(anyNode.vHeader) ? anyNode.vHeader : [];
  const hStyle: Array<"left" | "center" | "right"> = Array.isArray(anyNode.hStyle) ? anyNode.hStyle : [];
  const headerRow = hHeader.length > 0;
  const headerCol = vHeader.length > 0;
  const rows = Math.max(1, Number(anyNode.rows ?? cells.length ?? 1));
  const cols = Math.max(1, Number(anyNode.cols ?? (cells[0]?.length ?? 0) ?? 1));
  const totalRows = rows + (headerRow ? 1 : 0);
  const totalCols = cols + (headerCol ? 1 : 0);
  const layoutKey = `${totalRows}x${totalCols}|${headerRow ? 1 : 0}|${headerCol ? 1 : 0}`;
  if ((el.dataset as any).tableLayout !== layoutKey) {
    (el.dataset as any).tableLayout = layoutKey;
    body.replaceChildren();
    for (let r = 0; r < totalRows; r += 1) {
      const tr = document.createElement("tr");
      for (let c = 0; c < totalCols; c += 1) {
        const td = document.createElement("td");
        td.className = "table-cell";
        td.dataset.row = String(r + 1);
        td.dataset.col = String(c + 1);
        if ((headerRow && r === 0) || (headerCol && c === 0)) td.classList.add("table-header");
        td.spellcheck = false;
        td.addEventListener("pointerdown", (ev) => {
          if (!allowEdit) return;
          ev.stopPropagation();
        });
        td.addEventListener("keydown", (ev) => {
          if (!td.isContentEditable) return;
          const row = Number(td.dataset.row ?? 0);
          const col = Number(td.dataset.col ?? 0);
          if (!row || !col) return;
          if (ev.key === "Escape") {
            (el.dataset as any).editing = "0";
            td.blur();
            ev.preventDefault();
            return;
          }
          if (ev.key === "Tab" || ev.key === "Enter") {
            ev.preventDefault();
            const dir = ev.key === "Tab"
              ? (ev.shiftKey ? { dr: 0, dc: -1 } : { dr: 0, dc: 1 })
              : (ev.shiftKey ? { dr: -1, dc: 0 } : { dr: 1, dc: 0 });
            const next = td.closest("tbody")?.querySelector<HTMLElement>(`.table-cell[data-row="${row + dir.dr}"][data-col="${col + dir.dc}"]`);
            if (next) {
              next.focus();
              if (next.textContent) {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(next);
                sel?.removeAllRanges();
                sel?.addRange(range);
              }
            }
          }
        });
        td.addEventListener("input", () => {
          const row = Number(td.dataset.row ?? 0);
          const col = Number(td.dataset.col ?? 0);
          if (!row || !col) return;
          const value = String(td.textContent ?? "");
          window.dispatchEvent(new CustomEvent("ip-table-edit", { detail: { id: String(node.id ?? ""), row, col, value } }));
        });
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  const rowsEls = Array.from(body.querySelectorAll("tr"));
  rowsEls.forEach((tr, r) => {
    const cellsEls = Array.from(tr.querySelectorAll<HTMLTableCellElement>("td.table-cell"));
    cellsEls.forEach((td, c) => {
      const isHeaderRow = headerRow && r === 0;
      const isHeaderCol = headerCol && c === 0;
      let text = "";
      if (isHeaderRow && isHeaderCol) text = "";
      else if (isHeaderRow) text = hHeader[c - (headerCol ? 1 : 0)] ?? "";
      else if (isHeaderCol) text = vHeader[r - (headerRow ? 1 : 0)] ?? "";
      else text = cells[r - (headerRow ? 1 : 0)]?.[c - (headerCol ? 1 : 0)] ?? "";
      const isHeaderCell = isHeaderRow || isHeaderCol;
      if (!editing && isHeaderCell) {
        const cache = ((td as any).__katexCache ?? []) as string[];
        const rendered = deps.renderKatex(text, cache);
        (td as any).__katexCache = rendered.cache;
        if (td.dataset.katexRaw !== text || td.innerHTML !== rendered.html) {
          td.dataset.katexRaw = text;
          td.innerHTML = rendered.html;
        }
      } else {
        if (td.dataset.katexRaw) {
          delete (td.dataset as any).katexRaw;
          delete (td as any).__katexCache;
        }
        if (!editing || document.activeElement !== td) {
          if (td.textContent !== text) td.textContent = text;
        }
      }
      const align = hStyle[c - (headerCol ? 1 : 0)];
      td.style.textAlign = align || "";
      td.contentEditable = editing ? "true" : "false";
      td.tabIndex = allowEdit ? 0 : -1;
    });
  });

  if (!el.dataset.tableSelectBound && allowEdit) {
    el.dataset.tableSelectBound = "1";
    const state = { active: false, startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    (el as any).__tableSelectState = state;
    const applySelection = () => {
      const minRow = Math.min(state.startRow, state.endRow);
      const maxRow = Math.max(state.startRow, state.endRow);
      const minCol = Math.min(state.startCol, state.endCol);
      const maxCol = Math.max(state.startCol, state.endCol);
      const cellsEls = Array.from(el.querySelectorAll<HTMLElement>(".table-cell"));
      for (const cell of cellsEls) {
        const r = Number(cell.dataset.row ?? 0);
        const c = Number(cell.dataset.col ?? 0);
        cell.classList.toggle("is-selected", r >= minRow && r <= maxRow && c >= minCol && c <= maxCol);
      }
    };
    table.addEventListener("pointerdown", (ev) => {
      if (deps.store.mode === "live" && !allowEdit) return;
      const cell = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".table-cell");
      if (!cell) return;
      const row = Number(cell.dataset.row ?? 0);
      const col = Number(cell.dataset.col ?? 0);
      if (!row || !col) return;
      state.active = true;
      state.startRow = row;
      state.startCol = col;
      state.endRow = row;
      state.endCol = col;
      applySelection();
      cell.focus();
      try {
        table.setPointerCapture(ev.pointerId);
      } catch {}
      ev.preventDefault();
    });
    table.addEventListener("pointermove", (ev) => {
      if ((el.dataset as any).editing !== "1" || !state.active) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cell = target?.closest<HTMLElement>(".table-cell");
      if (!cell) return;
      const row = Number(cell.dataset.row ?? 0);
      const col = Number(cell.dataset.col ?? 0);
      if (!row || !col || (row === state.endRow && col === state.endCol)) return;
      state.endRow = row;
      state.endCol = col;
      applySelection();
    });
    table.addEventListener("pointerup", (ev) => {
      if ((el.dataset as any).editing !== "1" || !state.active) return;
      state.active = false;
      try {
        table.releasePointerCapture(ev.pointerId);
      } catch {}
    });
    table.addEventListener("keydown", (ev) => {
      if ((el.dataset as any).editing !== "1") return;
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const selected = Array.from(el.querySelectorAll<HTMLElement>(".table-cell.is-selected"));
      if (!selected.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      for (const cell of selected) {
        const row = Number(cell.dataset.row ?? 0);
        const col = Number(cell.dataset.col ?? 0);
        if (!row || !col) continue;
        cell.textContent = "";
        window.dispatchEvent(new CustomEvent("ip-table-edit", { detail: { id: String(node.id ?? ""), row, col, value: "" } }));
      }
    });
  }

  const rawTextColor = String(anyNode.color ?? "").trim().toLowerCase();
  const rawBgColor = String(anyNode.bgColor ?? "").trim().toLowerCase();
  const usesLegacyLightDefaults =
    editable &&
    (rawTextColor === "" || rawTextColor === "black" || rawTextColor === "#000" || rawTextColor === "#000000") &&
    (rawBgColor === "" || rawBgColor === "white" || rawBgColor === "#fff" || rawBgColor === "#ffffff");
  const tableTextColor = usesLegacyLightDefaults ? "rgba(255,255,255,0.94)" : String(anyNode.color ?? "black");
  el.style.color = tableTextColor;
  el.style.setProperty("--table-text-color", tableTextColor);
  if (usesLegacyLightDefaults) {
    el.style.setProperty("--table-surface", "rgba(9, 14, 24, 0.94)");
    el.style.setProperty("--table-border-color", "rgba(162, 170, 186, 0.34)");
    el.style.setProperty("--table-grid-color", "rgba(162, 170, 186, 0.26)");
    el.style.setProperty("--table-header-bg", "rgba(255,255,255,0.06)");
    el.style.setProperty("--table-cell-bg", "rgba(255,255,255,0.015)");
    el.style.setProperty("--table-cell-edit-bg", "rgba(255,255,255,0.035)");
    el.style.setProperty("--table-cell-selected-bg", "rgba(132, 156, 204, 0.18)");
    el.style.setProperty("--table-cell-focus-ring", "rgba(188, 198, 220, 0.28)");
    el.style.setProperty("--table-shadow", "none");
  } else {
    el.style.removeProperty("--table-surface");
    el.style.removeProperty("--table-border-color");
    el.style.removeProperty("--table-grid-color");
    el.style.removeProperty("--table-header-bg");
    el.style.removeProperty("--table-cell-bg");
    el.style.removeProperty("--table-cell-edit-bg");
    el.style.removeProperty("--table-cell-selected-bg");
    el.style.removeProperty("--table-cell-focus-ring");
    el.style.removeProperty("--table-shadow");
  }
  const isScreen = node.space === "screen";
  const designW = (deps.store.model as any).defaults?.designWidth ?? 1920;
  const screenScale = deps.screen.w / Math.max(1e-9, designW);
  const fontPx = Math.max(1, Number(anyNode.fontPx ?? 16));
  const effectiveFont = isScreen ? fontPx * screenScale : fontPx * deps.cameraZoom;
  el.style.fontSize = `${Math.max(1, effectiveFont)}px`;
  const { wPx, hPx } = deps.sizePx();
  const tableBgColor = usesLegacyLightDefaults ? null : anyNode.bgColor;
  const tableBgAlpha = usesLegacyLightDefaults ? null : anyNode.bgAlpha;
  deps.applyBackground(el, tableBgColor, tableBgAlpha, anyNode.bgPadding, anyNode.bgRadius, wPx, hPx);
};

export const updateMultichoiceNode = (el: HTMLElement, node: Node, deps: MultichoiceDeps) => {
  const wheel = el.querySelector<HTMLElement>(".multichoice-wheel");
  const canvas = el.querySelector<HTMLCanvasElement>(".multichoice-wheel-canvas");
  const content = el.querySelector<HTMLElement>(".multichoice-content");
  const questionEl = el.querySelector<HTMLElement>(".multichoice-question");
  const list = el.querySelector<HTMLElement>(".multichoice-list");
  if (!wheel || !canvas || !content || !questionEl || !list) throw new Error("[next] multichoice node missing elements");
  const anyNode = node as any;
  const answersRaw = Array.isArray(anyNode.answers) ? anyNode.answers : [];
  const otherLabel = String(anyNode.otherLabel ?? "").trim();
  const otherLimit = Number(anyNode.otherLimit ?? NaN);
  const hasOther = !!otherLabel;
  const answers = hasOther ? [...answersRaw, { name: otherLabel, color: "", __other: true }] : answersRaw;
  const choiceType = String(anyNode.choiceType ?? anyNode.type ?? "A");
  const { wPx, hPx } = deps.sizePx();
  const wheelOnly = anyNode.showList === false && anyNode.showQuestion === false;
  const wheelSize = Math.max(24, wheelOnly ? Math.min(hPx, wPx) : Math.min(hPx, wPx * 0.45));
  wheel.style.width = `${wheelSize}px`;
  wheel.style.height = `${wheelSize}px`;
  content.style.width = wheelOnly ? `0px` : `${Math.max(0, wPx - wheelSize)}px`;
  content.style.height = `${hPx}px`;
  content.style.display = wheelOnly ? "none" : "";
  wheel.style.position = wheelOnly ? "absolute" : "";
  wheel.style.left = wheelOnly ? `${Math.max(0, (wPx - wheelSize) / 2)}px` : "";
  wheel.style.top = wheelOnly ? `${Math.max(0, (hPx - wheelSize) / 2)}px` : "";
  list.style.width = "100%";
  list.style.height = "100%";
  const questionText = String(anyNode.question ?? "").trim();
  const showQuestion = anyNode.showQuestion !== false;
  questionEl.textContent = questionText;
  questionEl.style.display = showQuestion && questionText ? "block" : "none";
  const counts = Array.isArray(anyNode.counts) ? anyNode.counts : [];
  drawWheelCanvas(canvas, wheelSize, answers, counts, choiceType);
  const labels = answers.map((_: any, idx: number) => formatChoiceLabel(choiceType, idx));
  const listKey = JSON.stringify({ answers, labels, otherLimit, showList: anyNode.showList !== false });
  if ((list.dataset as any).key !== listKey) {
    (list.dataset as any).key = listKey;
    const showList = anyNode.showList !== false;
    if (!showList) {
      list.replaceChildren();
      list.style.display = "none";
    } else {
      list.style.display = "";
      list.replaceChildren(
        ...answers.map((ans: any, idx: number) => {
          const row = document.createElement("div");
          row.className = "multichoice-item";
          const dot = document.createElement("span");
          dot.className = "multichoice-dot";
          const color = String(ans?.color ?? "");
          dot.style.background = color || DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length] || "white";
          const text = document.createElement("span");
          text.className = "multichoice-text";
          const label = String(labels[idx] ?? "").trim();
          const name = String(ans?.name ?? "").trim();
          text.textContent = ans?.__other ? name : `${label}: ${name}`.trim();
          row.append(dot, text);
          return row;
        }),
      );
    }
  }
  deps.applyBackground(el, anyNode.bgColor, anyNode.bgAlpha, anyNode.bgPadding, anyNode.bgRadius, wPx, hPx);
};

export const updateWheelNode = (el: HTMLElement, node: Node, deps: MultichoiceDeps) => {
  const wheel = el.querySelector<HTMLElement>(".multichoice-wheel");
  const canvas = el.querySelector<HTMLCanvasElement>(".multichoice-wheel-canvas");
  if (!wheel || !canvas) throw new Error("[next] wheel node missing elements");
  const anyNode = node as any;
  const answersRaw = Array.isArray(anyNode.answers) ? anyNode.answers : [];
  const otherLabel = String(anyNode.otherLabel ?? "").trim();
  const hasOther = !!otherLabel;
  const answers = hasOther ? [...answersRaw, { name: otherLabel, color: "", __other: true }] : answersRaw;
  const choiceType = String(anyNode.choiceType ?? anyNode.type ?? "A");
  const { wPx, hPx } = deps.sizePx();
  const wheelSize = Math.max(24, Math.min(hPx, wPx));
  wheel.style.width = `${wheelSize}px`;
  wheel.style.height = `${wheelSize}px`;
  const counts = Array.isArray(anyNode.counts) ? anyNode.counts : [];
  drawWheelCanvas(canvas, wheelSize, answers, counts, choiceType);
};
