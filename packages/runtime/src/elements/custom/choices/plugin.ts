import type { ElementPlugin, FrameContext, RuntimeContext } from "../../../runtime/types";
import type { Engine } from "@interactive/engine";
import { applyDataBindings } from "../../../utils/template";
import { renderTextWithKatexToHtml } from "../../../utils/textMath";

type ChoiceOptionState = { id: string; label: string; color?: string; votes: number; percent: number };
type ChoicesState = {
  pollId: string;
  question: string;
  bullets?: string;
  chart?: string;
  options: ChoiceOptionState[];
  accepting: boolean;
  totalVotes: number;
};

const __choicesState: Record<string, ChoicesState | null> = {};
const __activeChoicesPollIds = new Set<string>();
let __choicesHandlersAttached = false;
let __lastPollMs = 0;

async function fetchChoicesState(BACKEND: string, pollId: string): Promise<ChoicesState | null> {
  if (!pollId) return null;
  try {
    const res = await fetch(`${BACKEND}/api/choices/state?pollId=${encodeURIComponent(pollId)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ChoicesState;
  } catch {
    return null;
  }
}

async function simulateChoicesVotes(BACKEND: string, pollId: string, opts: { users?: number } = {}) {
  const users = Math.max(1, Math.floor(opts.users ?? 30));
  // Simulate votes WITHOUT starting the poll (phones should remain in standby).
  await fetch(`${BACKEND}/api/choices/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pollId, users, reset: true }),
  }).catch(() => {});
}

function bulletFor(idx: number, style: string) {
  const i = idx + 1;
  if (style === "a") return String.fromCharCode(96 + i) + ".";
  if (style === "A") return String.fromCharCode(64 + i) + ".";
  if (style === "I") {
    const romans = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
    return (romans[i - 1] ?? String(i)) + ".";
  }
  return `${i}.`;
}

function runPauseResumeLabel(isRunning: boolean, hasRunOnce: boolean) {
  if (isRunning) return "Pause";
  return hasRunOnce ? "Resume" : "Run";
}

function _getHasRunOnce(el: HTMLElement) {
  return String(el.dataset.hasRunOnce ?? "0") === "1";
}

function _setHasRunOnce(el: HTMLElement, v: boolean) {
  el.dataset.hasRunOnce = v ? "1" : "0";
}

function parseInlineParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(raw ?? "");
  let buf = "";
  let inQuotes = false;
  let brace = 0;
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "{") brace += 1;
      else if (ch === "}") brace = Math.max(0, brace - 1);
    }
    if (ch === "," && !inQuotes && brace === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  for (const p of parts) {
    const m = p.match(/^(?<k>[a-zA-Z_]\w*)\s*=\s*(?<v>.*)$/);
    if (!m?.groups) continue;
    let v = (m.groups.v ?? "").trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m.groups.k] = v;
  }
  return out;
}

function parseChoicesBulletsSpec(elementsText: string): { type?: string; items: string[] } {
  const out: { type?: string; items: string[] } = { items: [] };
  const lines = String(elementsText ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln0 = lines[i] ?? "";
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^bullets\[(?<params>[^\]]+)\](?<colon>\s*:)?\s*$/);
    if (!m?.groups?.params) continue;
    const params = parseInlineParams(m.groups.params);
    const name = String(params.name ?? "").trim();
    if (name && name !== "bullets") continue;
    const t = String(params.type ?? params.bullets ?? "").trim();
    if (t) out.type = t;

    if (m.groups.colon) {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j] ?? "";
        const s = raw.trim();
        if (!s || s.startsWith("#")) continue;
        if (/^[a-zA-Z_]\w*\[/.test(s)) break;
        items.push(s);
      }
      out.items = items;
    }
    break;
  }
  return out;
}

function parseChoicesWheelSpec(elementsText: string): { otherLabel?: string; minLevel?: number; textInsideLimit?: number } {
  const out: { otherLabel?: string; minLevel?: number; textInsideLimit?: number } = {};
  for (const ln0 of String(elementsText ?? "").split(/\r?\n/)) {
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^wheel\[(?<params>[^\]]+)\]\s*$/);
    if (!m?.groups?.params) continue;
    const params = parseInlineParams(m.groups.params);
    const name = String(params.name ?? "").trim();
    if (name && name !== "wheel") continue;
    const ol = String(params.otherLabel ?? "").trim();
    if (ol) out.otherLabel = ol;
    const min = Number(params.minLevel ?? params.includeLimit ?? params.minPct ?? params.min ?? NaN);
    if (Number.isFinite(min)) out.minLevel = min;
    const ti = Number(params.textInsideLimit ?? params.minInsidePct ?? params.minInside ?? NaN);
    if (Number.isFinite(ti)) out.textInsideLimit = ti;
    break;
  }
  return out;
}

function parseWheelElementsPr(elementsPr: string): { templates: Record<string, string>; colors: Record<string, string> } {
  const templates: Record<string, string> = {};
  const colors: Record<string, string> = {};
  for (const ln0 of String(elementsPr ?? "").split(/\r?\n/)) {
    const ln = ln0.trim();
    if (!ln || ln.startsWith("#")) continue;

    // text[name=id,color=...]: template
    const mt = ln.match(/^text\[(?<params>[^\]]+)\]\s*:\s*(?<content>.*)$/);
    if (mt?.groups?.params) {
      const params = parseInlineParams(mt.groups.params);
      const id = String(params.name ?? "").trim();
      if (!id) continue;
      templates[id] = mt.groups.content ?? "";
      const col = String(params.color ?? "").trim();
      if (col) colors[id] = col;
      continue;
    }

    // slice[id=...,color=...] (optional; allows coloring by id without a text template)
    const ms = ln.match(/^slice\[(?<params>[^\]]+)\]\s*$/);
    if (ms?.groups?.params) {
      const params = parseInlineParams(ms.groups.params);
      const id = String(params.id ?? "").trim();
      const col = String(params.color ?? "").trim();
      if (id && col) colors[id] = col;
      continue;
    }
  }
  return { templates, colors };
}

function ensureChoicesWheelLayer(engine: Engine, pollId: string) {
  const m = engine.getModel();
  const node = (m?.nodes.find((n) => (n as any).id === pollId) as any) ?? null;
  const el = engine.getNodeElement(pollId);
  if (!node || !el) return null;
  const wheel = el.querySelector<HTMLElement>(".choices-wheel");
  if (!wheel) return null;
  wheel.style.position = "absolute";
  wheel.style.inset = "0";

  let layer = wheel.querySelector<HTMLElement>(":scope > .choices-wheel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "choices-wheel-layer";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    wheel.append(layer);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("choices-wheel-svg");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    layer.append(svg);
  }

  const elementsPr = String(node.wheelElementsPr ?? "");
  const prev = String((layer as any).__elementsPr ?? "");
  if (elementsPr !== prev) {
    (layer as any).__elementsPr = elementsPr;
    const parsed = parseWheelElementsPr(elementsPr);
    (layer as any).__templates = parsed.templates;
    (layer as any).__colors = parsed.colors;
  }

  const geoms: Record<string, any> = (node.compositeGeometriesByPath?.wheel ?? {}) as any;
  (layer as any).__wheelGeoms = geoms;
  return layer;
}

function renderChoicesWheelOverlay(
  engine: Engine,
  pollId: string,
  slices: Array<{ id: string; color?: string; votes: number; percent: number; label: string }>,
  opts: { totalVotes: number; otherLabel: string; textInsideLimit: number }
) {
  if (!pollId) return;
  const layer = ensureChoicesWheelLayer(engine, pollId);
  if (!layer) return;

  const svg = layer.querySelector<SVGSVGElement>(":scope > .choices-wheel-svg");
  if (!svg) return;

  const templates: Record<string, string> = (layer as any).__templates ?? {};
  const geoms: Record<string, any> = (layer as any).__wheelGeoms ?? {};

  const wheelEl = layer.parentElement as HTMLElement;
  const box = wheelEl.getBoundingClientRect();
  const fontBase = Math.max(18, box.height * 0.055);

  const textElsById = new Map<string, HTMLElement>();
  for (const t of Array.from(layer.querySelectorAll<HTMLElement>(":scope > .choices-wheel-text"))) {
    const sid = t.dataset.subId ?? "";
    if (sid) textElsById.set(sid, t);
  }

  const ensureTextEl = (sid: string) => {
    let t = textElsById.get(sid);
    if (t) return t;
    t = document.createElement("div");
    t.className = "choices-wheel-text comp-sub";
    t.dataset.subId = sid;
    t.dataset.compPath = `${pollId}/wheel`;
    t.dataset.anchor = "centerCenter";
    const content = document.createElement("div");
    content.className = "choices-wheel-text-content";
    content.style.width = "100%";
    content.style.height = "100%";
    content.style.display = "grid";
    content.style.placeItems = "center";
    t.append(content);
    t.style.position = "absolute";
    t.style.pointerEvents = "none";
    t.style.userSelect = "none";
    t.style.background = "transparent";
    t.style.border = "none";
    t.style.padding = "0";
    t.style.fontFamily = "KaTeX_Main, Times New Roman, serif";
    t.style.fontWeight = "700";
    t.style.color = "rgba(255,255,255,0.92)";
    t.style.transform = "translate(-50%, -50%)";
    layer.append(t);
    textElsById.set(sid, t);
    return t;
  };

  const total = Math.max(0, slices.reduce((s, o) => s + Math.max(0, o.votes || 0), 0));
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

  for (const t of Array.from(layer.querySelectorAll<HTMLElement>(":scope > .choices-wheel-text"))) {
    t.style.display = "none";
  }

  let a0 = -Math.PI / 2;
  for (const s of slices) {
    const val = Math.max(0, s.votes || 0);
    if (total <= 0 || val <= 0) continue;
    const frac = val / total;
    const a1 = a0 + frac * Math.PI * 2;
    const mid = (a0 + a1) / 2;

    const pct = Number.isFinite(s.percent) ? s.percent : frac * 100;
    const inside = Number.isFinite(opts.textInsideLimit) ? pct >= opts.textInsideLimit : true;

    const sid = String(s.id || "other");
    const t = ensureTextEl(sid);
    t.style.display = "block";

    const g = geoms[sid] ?? { x: 0, y: 0, w: 0.36, h: 0.10, rotationDeg: 0, anchor: "centerCenter", align: "center" };
    const dx = Number(g.x ?? 0);
    const dy = Number(g.y ?? 0);
    const w = Number(g.w ?? 0.36);
    const h = Number(g.h ?? 0.10);

    const rInside = 0.28;
    const rOutside = 0.62;
    const baseR = inside ? rInside : rOutside;
    const baseX = 0.5 + Math.cos(mid) * baseR;
    const baseY = 0.5 + Math.sin(mid) * baseR;

    const x = baseX + dx;
    const y = baseY + dy;
    t.dataset.baseX = String(baseX);
    t.dataset.baseY = String(baseY);

    t.style.left = `${x * 100}%`;
    t.style.top = `${y * 100}%`;
    t.style.width = `${w * 100}%`;
    t.style.height = `${h * 100}%`;
    t.style.rotate = `${Number(g.rotationDeg ?? 0)}deg`;
    t.style.textAlign = g.align === "right" ? "right" : g.align === "center" ? "center" : "left";
    t.style.fontSize = `${Math.max(14, fontBase)}px`;
    t.style.lineHeight = `${Math.max(14, fontBase)}px`;
    t.style.pointerEvents = (window as any).__ip_compositeEditing ? "auto" : "none";

    const tpl = String(t.dataset.template ?? templates[sid] ?? "{{label}} ({{percent}}%)");
    t.dataset.template = tpl;
    const noVotes = !(opts.totalVotes > 0);
    const resolved = applyDataBindings(tpl, {
      label: s.label,
      percent: noVotes ? "-" : Math.round(pct),
      votes: noVotes ? "-" : s.votes,
      totalVotes: noVotes ? "-" : opts.totalVotes,
    });
    const prevTxt = t.dataset.rawText ?? "";
    if (prevTxt !== resolved) {
      t.dataset.rawText = resolved;
      const contentEl = t.querySelector<HTMLElement>(":scope > .choices-wheel-text-content");
      if (contentEl) contentEl.innerHTML = renderTextWithKatexToHtml(resolved).replaceAll("\n", "<br/>");
    }

    if (!inside) {
      const rEdge = 0.46;
      const x0 = 0.5 + Math.cos(mid) * rEdge;
      const y0 = 0.5 + Math.sin(mid) * rEdge;
      lines.push({ x0, y0, x1: x, y1: y });
    }
    a0 = a1;
  }

  svg.replaceChildren();
  const strokeW = Math.max(2, (window.devicePixelRatio || 1) * 2.5);
  for (const ln of lines) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", `${ln.x0 * 100}%`);
    line.setAttribute("y1", `${ln.y0 * 100}%`);
    line.setAttribute("x2", `${ln.x1 * 100}%`);
    line.setAttribute("y2", `${ln.y1 * 100}%`);
    line.setAttribute("stroke", "rgba(255,255,255,0.92)");
    line.setAttribute("stroke-width", `${strokeW}`);
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  }
}

function drawChoicesPie(el: HTMLElement, opts: Array<{ color?: string; votes: number }>) {
  const canvas = el.querySelector<HTMLCanvasElement>("canvas.choices-chart-canvas");
  if (!canvas) return;
  if (el.offsetParent === null) return;
  const wheel = canvas.closest<HTMLElement>(".choices-wheel") ?? el;
  const r = wheel.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(30, Math.min(r.width, r.height)) * dpr;
  const W = Math.max(2, Math.round(size));
  const H = W;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const total = Math.max(0, opts.reduce((s, o) => s + Math.max(0, o.votes || 0), 0));
  const cx = W / 2;
  const cy = H / 2;
  const r0 = Math.max(10, Math.min(W, H) / 2 - 2);
  const borderW = Math.max(2, dpr * 4);
  const strokeCol = "rgba(255,255,255,0.92)";
  const ringCol = "rgba(255,255,255,0.92)";
  let start = -Math.PI / 2;
  const colors = ["#4caf50", "#e53935", "#1e88e5", "#ab47bc", "#00bcd4", "#fdd835", "#8d6e63"];
  const boundaries: number[] = [start];
  if (total > 0) {
    opts.forEach((opt, idx) => {
      const val = Math.max(0, opt.votes || 0);
      if (val <= 0) return;
      const frac = val / total;
      const end = start + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r0, start, end);
      ctx.closePath();
      ctx.fillStyle = opt.color || colors[idx % colors.length];
      ctx.globalAlpha = 0.92;
      ctx.fill();
      boundaries.push(end);
      start = end;
    });
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = borderW;
  for (const a of boundaries) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r0, 0, Math.PI * 2);
  ctx.strokeStyle = ringCol;
  ctx.lineWidth = borderW;
  ctx.stroke();
}

function renderChoicesNode(engine: Engine, el: HTMLElement, node: any, state: ChoicesState | null) {
  const question = el.querySelector<HTMLElement>(".choices-question");
  const list = el.querySelector<HTMLElement>(".choices-list");
  const total = el.querySelector<HTMLElement>(".choices-total");
  const startBtn = el.querySelector<HTMLButtonElement>('button[data-action="choices-startstop"]');
  const resetBtn = el.querySelector<HTMLButtonElement>('button[data-action="choices-reset"]');

  const accepting = !!state?.accepting;
  const choiceElText = String(node?.elementsText ?? "");
  const bulletSpec = parseChoicesBulletsSpec(choiceElText);
  const wheelSpec = parseChoicesWheelSpec(choiceElText);
  const bullet = String(state?.bullets ?? bulletSpec.type ?? (node?.bullets ?? "A"));
  const optsFromNode: Array<any> = Array.isArray(node?.options) ? node.options : [];
  el.dataset.resultsVisible = "1";

  if (question) question.textContent = state?.question || node?.question || "Poll";
  if (startBtn) {
    const hasRunOnce = _getHasRunOnce(el);
    startBtn.textContent = runPauseResumeLabel(accepting, hasRunOnce);
  }
  if (resetBtn) resetBtn.disabled = !optsFromNode.length;

  const options: Array<ChoiceOptionState> = optsFromNode.map((opt: any) => {
    const st = state?.options?.find((o) => o.id === opt.id);
    return {
      id: opt.id,
      label: opt.label,
      color: opt.color,
      votes: st?.votes ?? 0,
      percent: st?.percent ?? 0,
    };
  });

  const totalVotes = state?.totalVotes ?? options.reduce((s, o) => s + o.votes, 0);
  if (total) total.textContent = totalVotes > 0 ? `${totalVotes} vote${totalVotes === 1 ? "" : "s"}` : "-";

  if (list) {
    list.innerHTML = "";
    options.forEach((opt, idx) => {
      const row = document.createElement("div");
      row.className = "choices-row";
      const label = document.createElement("div");
      label.className = "choices-label";
      const swatch = document.createElement("span");
      swatch.className = "choices-swatch";
      const wheelParsed = parseWheelElementsPr(String(node?.wheelElementsPr ?? ""));
      const col = wheelParsed.colors[String(opt.id ?? "")] ?? opt.color;
      if (col) {
        swatch.style.background = col;
        swatch.style.borderColor = col;
      }
      const text = document.createElement("span");
      const rawItem = bulletSpec.items[idx] ?? String(opt.label ?? `Option ${idx + 1}`);
      text.textContent = `${bulletFor(idx, bullet)} ${rawItem}`;
      label.append(swatch, text);
      row.append(label);
      list.appendChild(row);
    });
  }

  const bulletsGroup = el.querySelector<HTMLElement>(".choices-bullets");
  const wheelGroup = el.querySelector<HTMLElement>(".choices-wheel-group");
  if (bulletsGroup) bulletsGroup.style.display = "flex";
  if (wheelGroup) wheelGroup.style.display = "block";

  const includeLimit = Number(wheelSpec.minLevel ?? node?.includeLimit ?? node?.minPct ?? node?.min ?? el.dataset.includeLimit ?? "3");
  const textInsideLimit = Number(wheelSpec.textInsideLimit ?? node?.textInsideLimit ?? node?.minInsidePct ?? node?.minInside ?? el.dataset.textInsideLimit ?? "6");
  const otherLabel = String(wheelSpec.otherLabel ?? node?.otherLabel ?? el.dataset.otherLabel ?? "Other") || "Other";
  const wheelParsed = parseWheelElementsPr(String(node?.wheelElementsPr ?? ""));
  const resolveSliceColor = (id: string, fallback: string | undefined) => wheelParsed.colors[id] ?? fallback;

  const big: Array<{ id: string; color?: string; votes: number; percent: number; label: string }> = [];
  let otherVotes = 0;
  let otherPercent = 0;
  for (const o of options) {
    const p = Number(o.percent ?? 0);
    if (Number.isFinite(includeLimit) && p > 0 && p < includeLimit) {
      otherVotes += Number(o.votes ?? 0);
      otherPercent += p;
    } else {
      const v = totalVotes > 0 ? o.votes : 1;
      const id = String(o.id ?? "");
      big.push({
        id,
        color: resolveSliceColor(id, o.color),
        votes: v,
        percent: totalVotes > 0 ? p : (NaN as any),
        label: o.label,
      });
    }
  }
  if (otherVotes > 0) {
    big.push({
      id: "other",
      color: resolveSliceColor("other", "rgba(255,255,255,0.35)"),
      votes: otherVotes,
      percent: otherPercent,
      label: otherLabel,
    });
  }
  drawChoicesPie(el, big.map((o) => ({ color: o.color, votes: o.votes })));
  renderChoicesWheelOverlay(engine, String(node?.id ?? ""), big, { totalVotes, otherLabel, textInsideLimit });
}

function attachChoicesHandlers(ctx: RuntimeContext) {
  if (__choicesHandlersAttached) return;
  __choicesHandlersAttached = true;

  ctx.stage.addEventListener("click", async (ev) => {
    if (ctx.getAppMode() !== "live") return;
    if ((window as any).__ip_compositeEditing) return;
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action || !action.startsWith("choices-")) return;
    const nodeEl = btn.closest<HTMLElement>(".node-choices");
    const pollId = nodeEl?.dataset.nodeId ?? "";
    if (!pollId) return;

    if (action === "choices-startstop") {
      const accepting = !!__choicesState[pollId]?.accepting;
      await fetch(`${ctx.BACKEND}/api/choices/${accepting ? "stop" : "start"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(accepting ? { pollId } : { pollId, reset: true }),
      }).catch(() => {});
      __choicesState[pollId] = await fetchChoicesState(ctx.BACKEND, pollId);
      if (!accepting && nodeEl) _setHasRunOnce(nodeEl, true);
      if (accepting) __activeChoicesPollIds.delete(pollId);
      else __activeChoicesPollIds.add(pollId);
      ev.preventDefault();
      return;
    }

    if (action === "choices-reset") {
      await fetch(`${ctx.BACKEND}/api/choices/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollId }),
      }).catch(() => {});
      __choicesState[pollId] = await fetchChoicesState(ctx.BACKEND, pollId);
      if (nodeEl) _setHasRunOnce(nodeEl, false);
      ev.preventDefault();
      return;
    }

    if (action === "choices-test") {
      // Debug-only: if node.debug, simulate votes without starting the poll.
      const model = ctx.engine.getModel();
      const node = model?.nodes.find((n: any) => String(n.id) === pollId) as any;
      if (!node || !node.debug) return;
      btn.disabled = true;
      try {
        await simulateChoicesVotes(ctx.BACKEND, pollId, { users: 30 });
      } finally {
        btn.disabled = false;
      }
      __choicesState[pollId] = await fetchChoicesState(ctx.BACKEND, pollId);
      ev.preventDefault();
      return;
    }
  });
}

export function createChoicesPlugin(): ElementPlugin {
  return {
    type: "choices",
    onModel: (ctx, model) => {
      attachChoicesHandlers(ctx);
      for (const n of (model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "choices") continue;
        const id = String(n.id ?? "");
        __choicesState[id] = __choicesState[id] ?? null;
      }
    },
    onFrame: async (ctx: FrameContext) => {
      // Render every frame (cheap DOM updates), poll state at most 4x/sec in Live mode.
      for (const n of (ctx.model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "choices") continue;
        const id = String(n.id ?? "");
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;
        renderChoicesNode(ctx.engine, el, n, __choicesState[id] ?? null);
      }

      if (ctx.getAppMode() !== "live") return;
      const now = performance.now();
      if (now - __lastPollMs < 250) return;
      __lastPollMs = now;

      // Poll accepting polls, but also refresh any visible polls occasionally.
      const ids = new Set<string>();
      for (const n of (ctx.model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "choices") continue;
        ids.add(String(n.id ?? ""));
      }
      for (const pollId of ids) {
        const st = __choicesState[pollId];
        const shouldPoll = __activeChoicesPollIds.has(pollId) || !!st?.accepting;
        if (!shouldPoll) continue;
        const next = await fetchChoicesState(ctx.BACKEND, pollId);
        if (next) {
          __choicesState[pollId] = next;
          if (next.accepting) __activeChoicesPollIds.add(pollId);
          else __activeChoicesPollIds.delete(pollId);
        }
      }
    },
    onStopInteractiveSessions: (ctx) => {
      for (const pollId of Array.from(__activeChoicesPollIds)) {
        __activeChoicesPollIds.delete(pollId);
        const st = __choicesState[pollId];
        if (st) st.accepting = false;
        void fetch(`${ctx.BACKEND}/api/choices/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pollId }),
        }).catch(() => {});
      }
    },
  };
}

