import type { Model } from "./model";
import type { Store } from "./store";

export type Transport = {
  start: () => void;
  stop: () => void;
};

function setModel(store: Store, model: Model) {
  store.model = model;
  store.activeViewId = model.initialViewId || model.views[0]?.id || "home";
  store.selectedId = null;
  store.selectedIds = [];
}

export function createTransport(store: Store): Transport {
  // Source-of-truth rules:
  // - If the HTML has an embedded model (`#ip-model`), treat it as offline mode (no server).
  // - Otherwise, if we're served over http(s), always connect to the python backend so `.pr` is the source of truth.
  const hasEmbedded = !!document.getElementById("ip-model");
  if (hasEmbedded) return noopTransport();
  if (window.location.protocol === "http:" || window.location.protocol === "https:") return connectedTransport(store);
  return noopTransport();
}

export function canPersistToServer(): boolean {
  const hasEmbedded = !!document.getElementById("ip-model");
  if (hasEmbedded) return false;
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

export async function persistText(payload: {
  id: string;
  viewId: string;
  text: string;
  align?: "left" | "center" | "right";
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/text ${res.status}`);
}

export async function persistBullets(payload: {
  id: string;
  viewId: string;
  text: string;
  bullets?: string;
  align?: "left" | "center" | "right";
  bgColor?: string;
  bgAlpha?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/bullets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/bullets ${res.status}`);
}

export async function persistImage(payload: {
  id: string;
  viewId: string;
  src?: string;
  bgColor?: string;
  bgAlpha?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/image ${res.status}`);
}

export async function persistGeometry(payload: {
  id: string;
  viewId: string;
  transform: any;
  fontPx?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/geometry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/geometry ${res.status}`);
}

export async function persistArrow(payload: {
  id: string;
  viewId: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  color?: string;
  strokePx?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/arrow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/arrow ${res.status}`);
}

export async function persistJoin(payload: {
  id: string;
  viewId: string;
  text: string;
  fields: string[];
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
}) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/join ${res.status}`);
}

export async function persistDelete(payload: { ids: string[]; doc?: "presentation" | "notes" }) {
  if (!canPersistToServer()) return;
  const res = await fetch("/persist/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /persist/delete ${res.status}`);
}

export async function uploadImageFile(file: File): Promise<{ src: string; filename: string }> {
  if (!canPersistToServer()) {
    const src = URL.createObjectURL(file);
    return { src, filename: file.name };
  }
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/media/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`POST /api/media/upload ${res.status}`);
  const data = (await res.json()) as { src?: string; filename?: string };
  const src = String(data.src ?? "");
  const filename = String(data.filename ?? "");
  if (!src) throw new Error("Upload missing src");
  return { src, filename };
}

function noopTransport(): Transport {
  return { start: () => {}, stop: () => {} };
}

function connectedTransport(store: Store): Transport {
  let es: EventSource | null = null;

  const start = () => {
    // Do not swallow errors: failures must surface during development.
    void (async () => {
      const res = await fetch("/model", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /model ${res.status}`);
      const model = (await res.json()) as Model;
      setModel(store, model);
    })();

    // Connect for future interactive events, but never let events override `.pr` during basic testing.
    // If EventSource fails, we want to see it (don't swallow).
    es = new EventSource("/events");
  };

  const stop = () => {
    try {
      es?.close();
    } catch (e) {
      console.error("[next][transport] failed to close /events", e);
    }
    es = null;
  };

  return { start, stop };
}

