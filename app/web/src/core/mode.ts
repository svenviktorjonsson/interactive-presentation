import type { Node } from "./model";

export type AppMode = "edit" | "screen-edit" | "live";

export function isNodeInteractiveInMode(mode: AppMode, node: Node): boolean {
  const space = (node as any).space ?? "world";
  const layer = (node as any).layer;
  if (mode === "live") return layer === "live";
  if (mode === "screen-edit") return space === "screen" && layer !== "live";
  // edit mode: world nodes only, screen nodes dimmed + noninteractive
  return space === "world" && layer !== "live";
}

