import type { Store } from "../core/store";
import { updateExperimentNodes } from "./experiment";
import { updateMultichoiceNodes } from "./multichoice";
import { updatePressureNodes } from "./pressure";
import { updateSoundNodes } from "./sound";
import { updateTimerNodes } from "./timer";

export type RenderModuleAdapter = {
  id: string;
  update: (store: Store, timeMs: number) => void;
};

const builtinRenderModuleAdapters: RenderModuleAdapter[] = [
  {
    id: "sound",
    update: (store, timeMs) => updateSoundNodes(store, timeMs),
  },
  {
    id: "pressure",
    update: (store, timeMs) => updatePressureNodes(store, timeMs),
  },
  {
    id: "timer",
    update: (store, timeMs) => updateTimerNodes(store, timeMs),
  },
  {
    id: "experiment",
    update: (store, _timeMs) => updateExperimentNodes(store),
  },
  {
    id: "multichoice",
    update: (store, _timeMs) => updateMultichoiceNodes(store),
  },
];

export const updateBuiltinRenderModules = (store: Store, timeMs: number) => {
  for (const adapter of builtinRenderModuleAdapters) {
    adapter.update(store, timeMs);
  }
};

export const listBuiltinRenderModuleAdapters = () => builtinRenderModuleAdapters.slice();
