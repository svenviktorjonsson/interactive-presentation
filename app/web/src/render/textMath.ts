import katex from "katex";

const AUTO_MATH_RE = /(?:\\[a-zA-Z]+|[_^])/;

function normalizeTextForMath(input: string) {
  const s = String(input ?? "");
  if (s.includes("$")) return s;
  if (!AUTO_MATH_RE.test(s)) return s;
  // Minimal auto-wrap: treat as inline math if single-line.
  if (!s.includes("\n")) return `$${s}$`;
  return `$$\n${s}\n$$`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Render a string containing $...$ and $$...$$ segments using KaTeX.
 * Non-math segments are HTML-escaped and newlines become <br/>.
 */
function balanceDelimsForPreview(s: string) {
  // Add a closing $ or $$ if we're currently "open".
  // This is only for live preview while editing (so KaTeX keeps rendering).
  let inlineOpen = false;
  let displayOpen = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      i += 1; // skip escaped char
      continue;
    }
    if (s.startsWith("$$", i)) {
      displayOpen = !displayOpen;
      i += 1;
      continue;
    }
    if (ch === "$") {
      inlineOpen = !inlineOpen;
      continue;
    }
  }
  if (displayOpen) return `${s}$$`;
  if (inlineOpen) return `${s}$`;
  return s;
}

function findNextDelim(s: string, from: number): { idx: number; kind: "$" | "$$" } | null {
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (s.startsWith("$$", i)) return { idx: i, kind: "$$" };
    if (ch === "$") return { idx: i, kind: "$" };
  }
  return null;
}

function findClosingDelim(s: string, from: number, kind: "$" | "$$"): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (kind === "$$" && s.startsWith("$$", i)) return i;
    if (kind === "$" && ch === "$") return i;
  }
  return -1;
}

export function renderTextWithKatexToHtmlCached(
  input: string,
  opts?: { preview?: boolean; cache?: string[] }
): { html: string; cache: string[]; ok: boolean; errors: Array<{ raw: string; message: string }> } {
  const s0 = normalizeTextForMath(input);
  const s1 = String(s0 ?? "");
  const s = opts?.preview ? balanceDelimsForPreview(s1) : s1;
  const cache = Array.isArray(opts?.cache) ? [...opts!.cache!] : [];

  let out = "";
  let i = 0;
  let mathIndex = 0;
  let ok = true;
  const errors: Array<{ raw: string; message: string }> = [];
  while (i < s.length) {
    const next = findNextDelim(s, i);
    if (!next) {
      out += escapeHtml(s.slice(i)).replaceAll("\n", "<br/>");
      break;
    }
    out += escapeHtml(s.slice(i, next.idx)).replaceAll("\n", "<br/>");

    const start = next.idx;
    const kind = next.kind;
    const openLen = kind === "$$" ? 2 : 1;
    const end = findClosingDelim(s, start + openLen, kind);
    if (end === -1) {
      out += escapeHtml(s.slice(start)).replaceAll("\n", "<br/>");
      ok = false;
      break;
    }
    const closeLen = openLen;
    const expr = s.slice(start + openLen, end);
    const rawSeg = s.slice(start, end + closeLen);
    try {
      const html = katex.renderToString(expr, { displayMode: kind === "$$", throwOnError: true });
      cache[mathIndex] = html;
      out += html;
    } catch (e) {
      ok = false;
      const cached = cache[mathIndex];
      // IMPORTANT: rendered output should not show error markup.
      // If we've rendered this segment before, keep last-good HTML; otherwise emit nothing.
      if (cached) out += cached;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ raw: rawSeg, message: msg });
    }
    mathIndex++;
    i = end + closeLen;
  }
  return { html: out, cache, ok, errors };
}

export function renderTextWithKatexToHtml(input: string) {
  return renderTextWithKatexToHtmlCached(input, { preview: false, cache: [] }).html;
}

