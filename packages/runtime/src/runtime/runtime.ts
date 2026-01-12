import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";
import { ElementRegistry } from "./registry";
import type { ElementPlugin, RuntimeContext } from "./types";

export class Runtime {
  private registry: ElementRegistry;
  private ctx: RuntimeContext;
  private rafStarted = false;

  constructor(opts: {
    engine: Engine;
    stage: HTMLElement;
    BACKEND: string;
    getAppMode: () => "edit" | "live";
    onCommit?: (before: PresentationModel) => Promise<void> | void;
  }) {
    this.registry = new ElementRegistry();
    this.ctx = {
      engine: opts.engine,
      stage: opts.stage,
      BACKEND: opts.BACKEND,
      getAppMode: opts.getAppMode,
      onCommit: opts.onCommit,
    };
  }

  register(plugin: ElementPlugin) {
    this.registry.register(plugin);
    return this;
  }

  onModel(model: PresentationModel) {
    for (const p of this.registry.list()) p.onModel?.(this.ctx, model);
  }

  stopInteractiveSessions() {
    for (const p of this.registry.list()) p.onStopInteractiveSessions?.(this.ctx);
  }

  startFrameLoop() {
    if (this.rafStarted) return;
    this.rafStarted = true;
    const tick = () => {
      const model = this.ctx.engine.getModel();
      if (model) {
        const timeMs = this.ctx.engine.getTimeMs();
        for (const p of this.registry.list()) p.onFrame?.({ ...this.ctx, model, timeMs });
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }
}

