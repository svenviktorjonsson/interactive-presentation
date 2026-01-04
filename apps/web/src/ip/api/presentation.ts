import type { PresentationModel } from "@interactive/content";
import { BACKEND } from "../config";

export async function fetchModel(): Promise<PresentationModel> {
  const res = await fetch(`${BACKEND}/api/presentation`);
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return (await res.json()) as PresentationModel;
}

export async function saveModel(model: PresentationModel) {
  const res = await fetch(`${BACKEND}/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(model),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
}

export function preloadImageAssets(model: PresentationModel) {
  // Ensure critical images (e.g. join_qr) are actually loaded before enter animations fire.
  // Browsers may otherwise defer loading depending on heuristics.
  for (const n of model.nodes) {
    if ((n as any).type !== "image") continue;
    const src = String((n as any).src ?? "");
    if (!src) continue;
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.src = src;
  }
}

