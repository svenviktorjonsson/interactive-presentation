import type { Model } from "./model";

export function loadEmbeddedModel(): Model | null {
  const el = document.getElementById("ip-model");
  if (!el) return null;
  const txt = el.textContent ?? "";
  if (!txt.trim()) return null;
  try {
    return JSON.parse(txt) as Model;
  } catch {
    console.error("[next] failed to parse embedded model");
    return null;
  }
}

