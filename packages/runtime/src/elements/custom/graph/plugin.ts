import type { ElementPlugin, FrameContext } from "../../../runtime/types";
import { ensureGraphCompositeLayer, layoutGraphCompositeTexts, renderGraphCompositeArrows, renderGraphCompositeTexts } from "./ui";
import { renderGraphCanvas } from "./render";

export function createGraphPlugin(): ElementPlugin {
  return {
    type: "graph",
    onFrame: (ctx: FrameContext) => {
      for (const n of (ctx.model.nodes as any[]) ?? []) {
        if (String(n?.type ?? "") !== "graph") continue;
        const id = String(n.id ?? "");
        if (!id) continue;
        const el = ctx.engine.getNodeElement(id);
        if (!el) continue;

        // Ensure composite overlay exists and is rendered every frame (like timer).
        const layer = ensureGraphCompositeLayer(ctx.engine, id);
        if (layer) {
          renderGraphCompositeArrows(el, layer);
          layoutGraphCompositeTexts(el, layer);
          renderGraphCompositeTexts(el, layer, { xLabel: String(n.xLabel ?? "x"), yLabel: String(n.yLabel ?? "y"), name: id });
        }

        // Render plot points (data region) into the shared timer-style canvas.
        renderGraphCanvas(ctx, el, n);
      }
    }
  };
}

