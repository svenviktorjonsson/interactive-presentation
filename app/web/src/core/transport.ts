import type { Model } from "./model";
import type { Store } from "./store";
import { persistActiveViewId, resolveInitialActiveViewId } from "./store";

export type Transport = {
  start: () => void;
  stop: () => void;
};

async function postJson(url: string, payload: unknown, opts?: { keepalive?: boolean }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: opts?.keepalive ?? true,
  });
  if (!res.ok) throw new Error(`POST ${url} ${res.status}`);
}

function setModel(store: Store, model: Model) {
  const preferredViewId = store.activeViewId;
  const safeViews = (model.views ?? []).map((v) => {
    const cx = Number(v.camera?.cx);
    const cy = Number(v.camera?.cy);
    const nextCx = Number.isFinite(cx) && Math.abs(cx) > 1e-9 ? cx : 0.5;
    const nextCy = Number.isFinite(cy) && Math.abs(cy) > 1e-9 ? cy : 0.5;
    return { ...v, camera: { ...v.camera, cx: nextCx, cy: nextCy, zoom: 1 } };
  });
  store.model = { ...model, views: safeViews };
  store.activeViewId = resolveInitialActiveViewId(store.model, preferredViewId);
  store.selectedId = null;
  store.selectedIds = [];
  store.activeGroupId = null;
  persistActiveViewId(store);
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
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/text", payload);
}

export async function persistBullets(payload: {
  id: string;
  viewId: string;
  text: string;
  bullets?: string;
  align?: "left" | "center" | "right";
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/bullets", payload);
}

export async function persistImage(payload: {
  id: string;
  viewId: string;
  src?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/image", payload);
}

export async function persistGeometry(payload: {
  id: string;
  viewId: string;
  transform: any;
  fontPx?: number;
  zIndex?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  const key = `${payload.id}|${payload.viewId}|${payload.groupId ?? ""}|${payload.space ?? ""}`;
  const stableTransform = normalizeTransformSnapshot(payload.transform);
  const snapshot = JSON.stringify({
    id: payload.id,
    viewId: payload.viewId,
    transform: stableTransform,
    fontPx: payload.fontPx ?? null,
    zIndex: payload.zIndex ?? null,
    doc: payload.doc ?? null,
    space: payload.space ?? null,
    groupId: payload.groupId ?? null,
  });
  const prev = lastGeometryPayload.get(key);
  if (prev === snapshot) return;
  try {
    await postJson("/persist/geometry", payload);
    lastGeometryPayload.set(key, snapshot);
  } catch (err) {
    if (lastGeometryPayload.get(key) === snapshot) lastGeometryPayload.delete(key);
    throw err;
  }
}

const lastGeometryPayload = new Map<string, string>();

const normalizeTransformSnapshot = (t: any) => {
  if (!t || typeof t !== "object") return t;
  const round = (v: any) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
  return {
    ...t,
    x: round(t.x),
    y: round(t.y),
    w: round(t.w),
    h: round(t.h),
    rotationDeg: round(t.rotationDeg),
  };
};

export async function persistButtons(payload: {
  id: string;
  viewId: string;
  labels: string[];
  actions: string[];
  buttonsMode?: "keep" | "click" | "radio";
  hSplits?: number[];
  vSplits?: number[];
  rows?: number;
  cols?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/buttons", payload);
}

export async function persistArrow(payload: {
  id: string;
  viewId: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  color?: string;
  strokePx?: number;
  zIndex?: number;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/arrow", payload);
}

export async function persistJoin(payload: {
  id: string;
  viewId: string;
  text: string;
  fields: string[];
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/join", payload);
}

export async function publishMultichoicePrompt(payload: {
  id: string;
  active: boolean;
  round?: number;
  question: string;
  answers: string[];
  labels: string[];
  otherLabel?: string;
  otherLimit?: number;
}) {
  if (!canPersistToServer()) return;
  await postJson("/update/multichoice", payload);
}

export async function publishTimerPrompt(payload: {
  id: string;
  active: boolean;
  running: boolean;
  elapsedMs: number;
  durationMs?: number;
  labels: { start: string; stop: string; reset: string; toggle: string };
  xLabel: string;
  yLabel: string;
  value: string;
  showTime?: boolean;
}) {
  if (!canPersistToServer()) return;
  await postJson("/update/timer", payload);
}

export async function publishTableUpdate(payload: {
  id: string;
  row: number;
  col: number;
  value: string;
}) {
  if (!canPersistToServer()) return;
  await postJson("/update/table", payload);
}

export async function persistDelete(payload: { ids: string[]; doc?: "presentation" | "notes"; groupId?: string | null }) {
  if (!canPersistToServer()) return;
  await postJson("/persist/delete", payload);
}

export async function persistGroup(payload: {
  id: string;
  viewId: string;
  doc?: "presentation" | "notes";
  space?: "world" | "screen";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/group", payload);
}

export async function persistElement(payload: {
  id: string;
  type: string;
  viewId: string;
  attrs?: Record<string, unknown>;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/element", payload);
}

export async function persistTable(payload: {
  id: string;
  viewId: string;
  cells: string[][];
  rows?: number;
  cols?: number;
  editable?: boolean;
  hHeader?: string[];
  vHeader?: string[];
  hStyle?: Array<"left" | "center" | "right">;
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
}) {
  if (!canPersistToServer()) return;
  await postJson("/persist/table", payload);
}

export async function uploadMediaFile(file: File): Promise<{ src: string; filename: string; contentType: string }> {
  if (!canPersistToServer()) {
    const src = URL.createObjectURL(file);
    return { src, filename: file.name, contentType: file.type || "application/octet-stream" };
  }
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/media/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(`POST /api/media/upload ${res.status}`);
  const data = (await res.json()) as { src?: string; filename?: string; contentType?: string };
  const src = String(data.src ?? "");
  const filename = String(data.filename ?? "");
  const contentType = String(data.contentType ?? file.type ?? "application/octet-stream");
  if (!src) throw new Error("Upload missing src");
  return { src, filename, contentType };
}

export async function uploadImageFile(file: File): Promise<{ src: string; filename: string }> {
  const uploaded = await uploadMediaFile(file);
  return { src: uploaded.src, filename: uploaded.filename };
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
    es.addEventListener("text", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as { id?: string; text?: string };
        const id = String(data.id ?? "");
        const node = store.model.nodes.find((n) => n.id === id) as any;
        if (node && typeof data.text === "string") {
          if ("text" in node) node.text = data.text;
        }
      } catch (err) {
        console.error("[next][transport] bad text event", err);
      }
    });
    es.addEventListener("bullets", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as {
          id?: string;
          rawText?: string;
          items?: Array<{ text: string; indent: number }>;
        };
        const id = String(data.id ?? "");
        const node = store.model.nodes.find((n) => n.id === id) as any;
        if (node && node.type === "bullets") {
          if (typeof data.rawText === "string") node.rawText = data.rawText;
          if (Array.isArray(data.items)) node.items = data.items;
        }
      } catch (err) {
        console.error("[next][transport] bad bullets event", err);
      }
    });
    es.addEventListener("buttons", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as { id?: string; labels?: string[] };
        const id = String(data.id ?? "");
        const node = store.model.nodes.find((n) => n.id === id) as any;
        if (node && node.type === "buttons" && Array.isArray(data.labels)) {
          node.labels = data.labels;
        }
      } catch (err) {
        console.error("[next][transport] bad buttons event", err);
      }
    });
    es.addEventListener("multichoice-vote", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as { id?: string; choice?: string };
        window.dispatchEvent(new CustomEvent("ip-multichoice-vote", { detail: data }));
      } catch (err) {
        console.error("[next][transport] bad multichoice-vote event", err);
      }
    });
    es.addEventListener("timer-action", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as { id?: string; action?: string; timeMs?: number };
        window.dispatchEvent(new CustomEvent("ip-timer-action", { detail: data }));
      } catch (err) {
        console.error("[next][transport] bad timer-action event", err);
      }
    });
    es.addEventListener("table-update", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as {
          id?: string;
          row?: number;
          col?: number;
          value?: string;
        };
        window.dispatchEvent(new CustomEvent("ip-table-update", { detail: data }));
      } catch (err) {
        console.error("[next][transport] bad table-update event", err);
      }
    });
    es.addEventListener("node-patch", (ev) => {
      try {
        const data = JSON.parse(String((ev as MessageEvent).data ?? "{}")) as {
          id?: string;
          patch?: Record<string, unknown>;
        };
        window.dispatchEvent(new CustomEvent("ip-node-patch", { detail: data }));
      } catch (err) {
        console.error("[next][transport] bad node-patch event", err);
      }
    });
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
