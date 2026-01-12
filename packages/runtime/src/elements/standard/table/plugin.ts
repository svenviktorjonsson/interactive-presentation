import type { ElementPlugin, RuntimeContext } from "../../../runtime/types";
import { cloneModel } from "../../../utils/model";
import { hydrateTextMath, renderTextToElement } from "../../../utils/textMath";

type ActiveTableEdit =
  | null
  | {
      tableId: string;
      row: number;
      col: number;
      td: HTMLTableCellElement;
      input: HTMLInputElement;
      beforeValue: string;
    };

let __active: ActiveTableEdit = null;
let __handlersAttached = false;

function tableColCount(rows: any[][]) {
  const headerLen = Array.isArray(rows?.[0]) ? rows[0].length : 0;
  const maxLen = Math.max(0, ...((rows ?? []) as any[]).map((r) => (Array.isArray(r) ? r.length : 0)));
  return Math.max(1, headerLen, maxLen);
}

function tableCellFlatIdx0(rows: any[][], row: number, col: number) {
  let idx = 0;
  for (let r = 0; r < row; r++) idx += (rows?.[r]?.length ?? 0);
  return idx + col;
}

function ensureTableCellExists(ctx: RuntimeContext, tableId: string, row: number, col: number) {
  const model = ctx.engine.getModel();
  if (!model) return;
  const node: any = model.nodes.find((n: any) => String(n.id) === tableId);
  if (!node) return;
  const rows = (node.rows ?? []).map((r: any) => (Array.isArray(r) ? [...r] : [])) as string[][];
  const colCount = tableColCount(rows as any);
  while (rows.length <= row) rows.push(new Array(colCount).fill(""));
  while ((rows[row]?.length ?? 0) < colCount) rows[row]!.push("");
  while ((rows[row]?.length ?? 0) <= col) rows[row]!.push("");
  ctx.engine.updateNode(tableId, { rows } as any);
}

function findTableCellTd(ctx: RuntimeContext, tableId: string, row: number, col: number) {
  const nodeEl = ctx.engine.getNodeElement(tableId);
  const table = nodeEl?.querySelector("table") as HTMLTableElement | null;
  const tr = table?.rows?.[row] ?? null;
  const td = (tr?.cells?.[col] as HTMLTableCellElement | undefined) ?? null;
  if (!td) return null;
  if (!td.classList.contains("table-cell")) td.classList.add("table-cell");
  return td;
}

async function endActiveTableEdit(ctx: RuntimeContext, opts?: { commit?: boolean }) {
  const a = __active;
  if (!a) return;
  __active = null;

  const td = a.td;
  const val = String(a.input.value ?? "");
  const shouldCommit = opts?.commit !== false;
  try {
    a.input.remove();
  } catch {}

  if (!shouldCommit) {
    (td.dataset as any).raw = a.beforeValue;
    renderTextToElement(td, a.beforeValue);
    return;
  }

  if (val === a.beforeValue) {
    (td.dataset as any).raw = val;
    renderTextToElement(td, val);
    return;
  }

  const model = ctx.engine.getModel();
  if (!model) return;
  const node: any = model.nodes.find((n: any) => String(n.id) === a.tableId);
  if (!node) return;

  const before = ctx.getAppMode() === "edit" ? cloneModel(model) : null;
  const rows = (node.rows ?? []).map((r: any) => (Array.isArray(r) ? [...r] : [])) as string[][];
  while (rows.length <= a.row) rows.push([]);
  while ((rows[a.row]?.length ?? 0) <= a.col) rows[a.row]!.push("");
  rows[a.row]![a.col] = val;

  ctx.engine.updateNode(a.tableId, { rows } as any);
  const after = ctx.engine.getModel();
  if (after) hydrateTextMath(ctx.engine, after);

  const cellIdx0 = tableCellFlatIdx0(rows as any, a.row, a.col);
  const detail = { tableId: a.tableId, id: a.tableId, row: a.row, col: a.col, cellIdx: cellIdx0, index: cellIdx0 + 1, value: val };
  window.dispatchEvent(new CustomEvent(`${a.tableId}-change`, { detail }));

  if (before && ctx.onCommit) await ctx.onCommit(before);
}

async function gotoNextTableCell(ctx: RuntimeContext, tableId: string, row: number, col: number) {
  const model = ctx.engine.getModel();
  const node: any = model?.nodes?.find?.((n: any) => String(n.id) === tableId);
  const rows = (node?.rows ?? []) as any[][];
  const colCount = tableColCount(rows as any);
  let nr = row;
  let nc = col + 1;
  if (nc >= colCount) {
    nr = row + 1;
    nc = 0;
  }
  ensureTableCellExists(ctx, tableId, nr, nc);
  await new Promise<void>((r) => setTimeout(() => r(), 0));
  const td2 = findTableCellTd(ctx, tableId, nr, nc);
  if (td2) await beginTableCellEdit(ctx, td2, tableId, nr, nc);
}

async function beginTableCellEdit(ctx: RuntimeContext, td: HTMLTableCellElement, tableId: string, row: number, col: number) {
  await endActiveTableEdit(ctx, { commit: true });

  const raw = String((td.dataset as any).raw ?? td.textContent ?? "");
  td.innerHTML = "";

  const input = document.createElement("input");
  input.type = "text";
  input.value = raw;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.className = "ip-table-input";
  input.style.width = "100%";
  input.style.height = "100%";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.background = "transparent";
  input.style.color = "rgba(255,255,255,0.95)";
  input.style.font = "inherit";
  input.style.padding = "0 6px";
  (td.style as any).userSelect = "text";

  td.appendChild(input);
  __active = { tableId, row, col, td, input, beforeValue: raw };

  queueMicrotask(() => {
    try {
      input.focus();
      input.select();
    } catch {}
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const cur = __active;
      if (!cur) return;
      void (async () => {
        const { tableId, row, col } = cur;
        await endActiveTableEdit(ctx, { commit: true });
        await gotoNextTableCell(ctx, tableId, row, col);
      })();
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      void endActiveTableEdit(ctx, { commit: false });
      return;
    }
  });
  input.addEventListener("blur", () => void endActiveTableEdit(ctx, { commit: true }));
}

function attachHandlers(ctx: RuntimeContext) {
  if (__handlersAttached) return;
  __handlersAttached = true;

  // Click-away commit
  window.addEventListener(
    "pointerdown",
    (ev) => {
      const a = __active;
      if (!a) return;
      const t = ev.target as HTMLElement;
      if (t === a.input || t.closest(".ip-table-input")) return;
      if (t.closest("td.table-cell") === a.td) return;
      void endActiveTableEdit(ctx, { commit: true });
    },
    true
  );

  // Single-click cell edit in both Edit + Live modes.
  ctx.stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    const td = t.closest<HTMLTableCellElement>("td.table-cell");
    if (!td) return;
    const nodeEl = td.closest<HTMLElement>(".node-table");
    const tableId = String(nodeEl?.dataset?.nodeId ?? "");
    if (!tableId) return;
    const table = nodeEl?.querySelector("table") as HTMLTableElement | null;
    const tr = td.parentElement as HTMLTableRowElement | null;
    const row = table && tr ? Array.prototype.indexOf.call(table.rows, tr) : -1;
    const col = tr ? Array.prototype.indexOf.call(tr.cells, td) : -1;
    if (row < 0 || col < 0) return;
    void beginTableCellEdit(ctx, td, tableId, row, col);
    ev.preventDefault();
    ev.stopPropagation();
  });
}

export function createTablePlugin(): ElementPlugin {
  return {
    type: "table",
    onModel: (ctx) => attachHandlers(ctx),
  };
}

