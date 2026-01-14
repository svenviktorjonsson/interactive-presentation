import type { Model } from "./model";
import { defaultModel } from "./model";

export type Store = {
  model: Model;
  activeViewId: string;
  selectedId: string | null;
};

export function createStore(initialModel?: Model): Store {
  const model = initialModel ?? defaultModel();
  return {
    model,
    activeViewId: model.initialViewId,
    selectedId: null,
  };
}

export function activeView(store: Store) {
  const v = store.model.views.find((x) => x.id === store.activeViewId);
  return v ?? store.model.views[0]!;
}

