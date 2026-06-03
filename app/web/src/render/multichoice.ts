import type { Store } from "../core/store";
import { publishMultichoicePrompt } from "../core/transport";

type MultichoiceLink = {
  id: string;
  root?: any;
  wheel?: any;
  buttons?: any;
  question?: any;
  bullets?: any;
  answers: Map<number, any>;
};

type MultichoiceRuntime = {
  id: string;
  active: boolean;
  round: number;
  counts: number[];
  question: string;
  answers: Array<{ name: string; color?: string }>;
  choiceType: string;
  otherLabel: string;
  otherLimit?: number;
  startLabel: string;
  stopLabel: string;
  resetLabel: string;
  lastPromptKey: string;
};

const TEMPLATE_RE = /\{\{([a-zA-Z_]\w*)(?::([^}]+))?\}\}/g;
const multichoiceRuntime = new Map<string, MultichoiceRuntime>();
const multichoiceButtons = new Map<string, string>();
let multichoiceBusInstalled = false;
let activeStore: Store | null = null;
const PALETTE = [
  { color: "red", bg: "rgba(255,0,0,0.22)" },
  { color: "green", bg: "rgba(0,170,0,0.22)" },
  { color: "blue", bg: "rgba(0,120,255,0.22)" },
  { color: "yellow", bg: "rgba(255,210,0,0.22)" },
  { color: "cyan", bg: "rgba(0,200,200,0.22)" },
  { color: "magenta", bg: "rgba(200,0,200,0.22)" },
];

const formatTemplate = (template: string, data: Record<string, unknown>) =>
  String(template).replace(TEMPLATE_RE, (_m, key, fmt) => {
    const raw = (data as any)[key];
    if (raw === null || raw === undefined) return "-";
    if (typeof raw === "number" && typeof fmt === "string") {
      const match = fmt.match(/\.([0-9]+)/);
      if (match) {
        const digits = Math.max(0, Math.min(10, Number(match[1]) || 0));
        return raw.toFixed(digits);
      }
    }
    return String(raw);
  });

const toAlpha = (n: number, upper: boolean) => {
  let value = Math.max(1, n);
  let label = "";
  while (value > 0) {
    value -= 1;
    const ch = String.fromCharCode((value % 26) + (upper ? 65 : 97));
    label = ch + label;
    value = Math.floor(value / 26);
  }
  return label;
};

const toRoman = (n: number, upper: boolean) => {
  const map: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let value = Math.max(1, n);
  let out = "";
  for (const [v, ch] of map) {
    while (value >= v) {
      out += ch;
      value -= v;
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

const ensureRuntime = (id: string): MultichoiceRuntime => {
  const existing = multichoiceRuntime.get(id);
  if (existing) return existing;
  const rt: MultichoiceRuntime = {
    id,
    active: false,
    round: 0,
    counts: [],
    question: "",
    answers: [],
    choiceType: "A",
    otherLabel: "",
    otherLimit: undefined,
    startLabel: "Start",
    stopLabel: "Stop",
    resetLabel: "Reset",
    lastPromptKey: "",
  };
  multichoiceRuntime.set(id, rt);
  return rt;
};

const resolveLinks = (store: Store) => {
  const links = new Map<string, MultichoiceLink>();
  multichoiceButtons.clear();
  for (const node of store.model.nodes as any[]) {
    const mid = String(node?.multichoiceId ?? "");
    if (!mid) continue;
    const entry = links.get(mid) ?? { id: mid, answers: new Map<number, any>() };
    if (node.type === "group" && node.multichoiceRole === "root") entry.root = node;
    if (node.type === "multichoice" && node.multichoiceRole === "wheel") entry.wheel = node;
    if (node.type === "wheel") {
      entry.root = node;
      entry.wheel = node;
    }
    if (node.type === "buttons" && node.multichoiceRole === "buttons") {
      entry.buttons = node;
      multichoiceButtons.set(String(node.id ?? ""), mid);
    }
    if (node.type === "text" && node.multichoiceRole === "question") entry.question = node;
    if (node.type === "bullets" && node.multichoiceRole === "answers") entry.bullets = node;
    if (node.type === "text" && node.multichoiceRole === "answer") {
      const idx = Number(node.multichoiceIndex ?? -1);
      if (Number.isFinite(idx) && idx >= 0) entry.answers.set(idx, node);
    }
    links.set(mid, entry);
  }
  return links;
};

const syncRuntimeFromNodes = (rt: MultichoiceRuntime, links: MultichoiceLink) => {
  const root = links.root ?? {};
  const nextQuestion = String(root.multichoiceQuestion ?? root.question ?? rt.question);
  const nextAnswers = Array.isArray(root.multichoiceAnswers)
    ? root.multichoiceAnswers.map((a: any) => ({ name: String(a?.name ?? ""), color: String(a?.color ?? "") }))
    : rt.answers;
  const nextChoiceType = String(root.multichoiceChoiceType ?? root.choiceType ?? rt.choiceType);
  const nextOtherLabel = String(root.multichoiceOtherLabel ?? root.otherLabel ?? rt.otherLabel);
  const nextOtherLimit = Number(root.multichoiceOtherLimit ?? root.otherLimit ?? rt.otherLimit ?? NaN);
  const nextStart = String(root.multichoiceStartLabel ?? root.startLabel ?? rt.startLabel);
  const nextStop = String(root.multichoiceStopLabel ?? root.stopLabel ?? rt.stopLabel);
  const nextReset = String(root.multichoiceResetLabel ?? root.resetLabel ?? rt.resetLabel);
  const answersKey = JSON.stringify({ nextAnswers, nextOtherLabel });
  const prevKey = JSON.stringify({ nextAnswers: rt.answers, nextOtherLabel: rt.otherLabel });
  if (answersKey !== prevKey) {
    rt.answers = nextAnswers;
    rt.otherLabel = nextOtherLabel;
    const total = nextAnswers.length + (nextOtherLabel ? 1 : 0);
    rt.counts = Array.from({ length: total }, () => 0);
    rt.round += 1;
    rt.lastPromptKey = "";
  }
  if (nextQuestion !== rt.question) rt.question = nextQuestion;
  if (nextChoiceType !== rt.choiceType) rt.choiceType = nextChoiceType;
  if (Number.isFinite(nextOtherLimit)) rt.otherLimit = nextOtherLimit;
  if (nextStart) rt.startLabel = nextStart;
  if (nextStop) rt.stopLabel = nextStop;
  if (nextReset) rt.resetLabel = nextReset;
};

const updateTemplates = (rt: MultichoiceRuntime, links: MultichoiceLink) => {
  const totalVotes = rt.counts.reduce((a, b) => a + b, 0);
  const displayAnswers = rt.otherLabel ? [...rt.answers, { name: rt.otherLabel }] : rt.answers;
  const labels = displayAnswers.map((_, idx) => formatChoiceLabel(rt.choiceType, idx));
  const data: Record<string, unknown> = { question: rt.question, total: totalVotes };
  for (let i = 0; i < displayAnswers.length; i++) {
    const name = String(displayAnswers[i]?.name ?? "");
    const count = rt.counts[i] ?? 0;
    let countLabel = "";
    if (rt.active) countLabel = String(count);
    data[`name${i}`] = name;
    data[`countLabel${i}`] = countLabel;
    data[`item${i}`] = name ? `${name}\t${countLabel}` : "";
    data[`count${i}`] = count;
    data[`label${i}`] = labels[i] ?? "";
    const palette = PALETTE[i % PALETTE.length];
    const colorRaw = String(displayAnswers[i]?.color ?? "").trim();
    data[`color${i}`] = colorRaw || palette.color;
  }
  const applyText = (node?: any, valueOverride?: string) => {
    if (!node) return;
    const template = String(node.template ?? node.text ?? "");
    const next = valueOverride != null ? valueOverride : formatTemplate(template, data);
    if (node.text !== next) node.text = next;
  };
  applyText(links.question);
  for (const [idx, node] of links.answers) {
    const answer = displayAnswers[idx];
    if (!answer) continue;
    applyText(node, String(answer.name ?? "").trim());
  }
  if (links.bullets) {
    const items = displayAnswers.map((ans, idx) => {
      const palette = PALETTE[idx % PALETTE.length];
      const colorRaw = String(ans?.color ?? "").trim();
      return {
        text: String(ans?.name ?? "").trim(),
        indent: 0,
        color: colorRaw || "rgba(255,255,255,0.92)",
        bgColor: colorRaw ? colorRaw : palette.bg,
      };
    });
    const nextRaw = items.map((item) => item.text).join("\n");
    if (links.bullets.rawText !== nextRaw) links.bullets.rawText = nextRaw;
    links.bullets.items = items;
  }
  if (links.buttons) {
    const templates = Array.isArray(links.buttons.templates)
      ? links.buttons.templates
      : Array.isArray(links.buttons.labels)
        ? links.buttons.labels
        : [];
    const toggleLabel = rt.active ? rt.stopLabel : rt.startLabel;
    const labels = templates.map((tpl: string) =>
      formatTemplate(tpl, {
        toggleLabel,
        startLabel: rt.startLabel,
        stopLabel: rt.stopLabel,
        resetLabel: rt.resetLabel,
      })
    );
    links.buttons.labels = labels;
  }
  if (links.wheel) {
    links.wheel.answers = displayAnswers.map((a: any, idx: number) => ({
      name: String(a?.name ?? ""),
      color: String(rt.answers[idx]?.color ?? ""),
    }));
    links.wheel.counts = rt.counts.slice(0, displayAnswers.length);
    links.wheel.choiceType = rt.choiceType;
    links.wheel.otherLabel = rt.otherLabel;
    links.wheel.otherLimit = rt.otherLimit;
    links.wheel.showList = false;
    links.wheel.showQuestion = false;
  }
};

const isPromptViewActive = (store: Store, viewId: string) => {
  if (!viewId) return true;
  if (viewId === store.activeViewId) return true;
  const viewById = new Map((store.model.views ?? []).map((v: any) => [String(v.id), v]));
  let cursor = viewById.get(String(viewId));
  while (cursor?.refView) {
    if (String(cursor.refView) === store.activeViewId) return true;
    cursor = viewById.get(String(cursor.refView));
  }
  return false;
};

const publishPrompt = (rt: MultichoiceRuntime, links: MultichoiceLink, store: Store) => {
  if (store.mode !== "live") return;
  const root = links.root ?? {};
  const viewId = String(root.viewId ?? "");
  if (viewId && !isPromptViewActive(store, viewId)) return;
  const displayAnswers = rt.otherLabel ? [...rt.answers, { name: rt.otherLabel }] : rt.answers;
  const labels = displayAnswers.map((_, idx) => formatChoiceLabel(rt.choiceType, idx));
  const payload = {
    id: rt.id,
    active: rt.active,
    round: rt.round,
    question: rt.question,
    answers: displayAnswers.map((a) => String((a as any)?.name ?? "")),
    labels,
    otherLabel: rt.otherLabel,
    otherLimit: rt.otherLimit,
  };
  const key = JSON.stringify(payload);
  if (!rt.active) {
    if (key === rt.lastPromptKey) return;
    rt.lastPromptKey = key;
    void publishMultichoicePrompt({ ...payload, active: false }).catch((err) => {
      console.error("[next] failed to publish multichoice prompt", err);
    });
    return;
  }
  if (key === rt.lastPromptKey) return;
  rt.lastPromptKey = key;
  void publishMultichoicePrompt(payload).catch((err) => {
    console.error("[next] failed to publish multichoice prompt", err);
  });
};

const ensureBus = () => {
  if (multichoiceBusInstalled || typeof window === "undefined") return;
  multichoiceBusInstalled = true;
  window.addEventListener("ip-buttons-action", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const action = String(detail?.action ?? "");
    if (!action.startsWith("multichoice-")) return;
    const store = activeStore;
    if (!store || store.mode !== "live") return;
    const btnId = String(detail?.id ?? "");
    const multichoiceId =
      multichoiceButtons.get(btnId) || (btnId.endsWith("_buttons") ? btnId.slice(0, -"_buttons".length) : "");
    if (!multichoiceId) return;
    const rt = ensureRuntime(multichoiceId);
    if (action === "multichoice-toggle") {
      if (!rt.active) rt.round += 1;
      rt.active = !rt.active;
      rt.lastPromptKey = "";
      return;
    }
    if (action === "multichoice-reset") {
      rt.counts = rt.counts.map(() => 0);
      rt.round += 1;
      rt.lastPromptKey = "";
    }
  });
  window.addEventListener("ip-multichoice-vote", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as any;
    const id = String(detail?.id ?? "");
    if (!id) return;
    const rt = ensureRuntime(id);
    if (!rt.active) return;
    const choice = String(detail?.choice ?? "").trim();
    if (!choice) return;
    const displayAnswers = rt.otherLabel ? [...rt.answers, { name: rt.otherLabel }] : rt.answers;
    let idx = displayAnswers.findIndex((a: any) => String(a?.name ?? "") === choice);
    if (idx < 0 && rt.otherLabel) idx = displayAnswers.length - 1;
    if (idx < 0) return;
    if (rt.counts.length < displayAnswers.length) {
      rt.counts = Array.from({ length: displayAnswers.length }, (_, i) => rt.counts[i] ?? 0);
    }
    rt.counts[idx] = (rt.counts[idx] ?? 0) + 1;
  });
};

export const updateMultichoiceNodes = (store: Store) => {
  activeStore = store;
  ensureBus();
  const linksById = resolveLinks(store);
  for (const [id, links] of linksById) {
    const rt = ensureRuntime(id);
    syncRuntimeFromNodes(rt, links);
    updateTemplates(rt, links);
    publishPrompt(rt, links, store);
  }
};
