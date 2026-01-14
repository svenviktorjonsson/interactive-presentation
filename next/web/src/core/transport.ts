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

