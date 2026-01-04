import { formatStringToMathDisplay, renderStringToHtml } from "@cellmax/katex-renderer";
import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

const AUTO_MATH_RE = /(?:\\[a-zA-Z]+|[_^])/;

function normalizeTextForMath(input: string) {
  // If author already used $...$ / $$...$$, honor it.
  // Otherwise, for "math-looking" strings, auto-wrap/format into a display math block.
  const s = String(input ?? "");
  if (s.includes("$")) return s;
  if (!AUTO_MATH_RE.test(s)) return s;
  return formatStringToMathDisplay(s);
}

export function renderTextToHtml(input: string) {
  return renderStringToHtml(normalizeTextForMath(input));
}

// Back-compat: older callsites set `innerHTML = renderTextWithKatexToHtml(...)`.
export function renderTextWithKatexToHtml(input: string) {
  return renderTextToHtml(input);
}

export function renderTextToElement(el: HTMLElement, input: string) {
  // Keep <br/> behavior consistent with existing rendering.
  el.innerHTML = renderTextToHtml(input).replaceAll("\n", "<br/>");
}

export function hydrateTextMath(engine: Engine, model: PresentationModel) {
  // Hydrate all text nodes: render KaTeX into the stable `.node-text-content` wrapper.
  for (const n of model.nodes) {
    if ((n as any).type !== "text") continue;
    const el = engine.getNodeElement((n as any).id);
    if (!el) continue;
    const contentEl = el.querySelector<HTMLElement>(".node-text-content");
    if (!contentEl) continue;
    const raw = String((n as any).text ?? "");
    // Keep in sync with the engine's text node updater (it uses dataset.rawText as change detector).
    (el.dataset as any).rawText = raw;
    renderTextToElement(contentEl, raw);
  }
}

