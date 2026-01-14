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
export function renderTextWithKatexToHtml(input: string) {
  const s0 = normalizeTextForMath(input);
  const s = String(s0 ?? "");

  // Simple tokenizer: supports $$...$$ and $...$ (no nested).
  let out = "";
  let i = 0;
  while (i < s.length) {
    const nextD = s.indexOf("$$", i);
    const nextI = s.indexOf("$", i);

    const useDisplay = nextD !== -1 && (nextI === -1 || nextD <= nextI);
    const start = useDisplay ? nextD : nextI;
    if (start === -1) {
      out += escapeHtml(s.slice(i)).replaceAll("\n", "<br/>");
      break;
    }

    // Text before math
    out += escapeHtml(s.slice(i, start)).replaceAll("\n", "<br/>");

    if (useDisplay) {
      const end = s.indexOf("$$", start + 2);
      if (end === -1) {
        out += escapeHtml(s.slice(start)).replaceAll("\n", "<br/>");
        break;
      }
      const expr = s.slice(start + 2, end);
      try {
        out += katex.renderToString(expr, { displayMode: true, throwOnError: false });
      } catch {
        out += escapeHtml(s.slice(start, end + 2)).replaceAll("\n", "<br/>");
      }
      i = end + 2;
      continue;
    }

    // inline $
    const end = s.indexOf("$", start + 1);
    if (end === -1) {
      out += escapeHtml(s.slice(start)).replaceAll("\n", "<br/>");
      break;
    }
    const expr = s.slice(start + 1, end);
    try {
      out += katex.renderToString(expr, { displayMode: false, throwOnError: false });
    } catch {
      out += escapeHtml(s.slice(start, end + 1)).replaceAll("\n", "<br/>");
    }
    i = end + 1;
  }
  return out;
}

