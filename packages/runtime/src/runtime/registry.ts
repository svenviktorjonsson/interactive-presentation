import type { ElementPlugin } from "./types";

export class ElementRegistry {
  private byType = new Map<string, ElementPlugin>();

  register(plugin: ElementPlugin) {
    if (!plugin?.type) throw new Error("ElementPlugin missing type");
    if (this.byType.has(plugin.type)) throw new Error(`Duplicate plugin type: ${plugin.type}`);
    this.byType.set(plugin.type, plugin);
  }

  get(type: string) {
    return this.byType.get(type) ?? null;
  }

  list() {
    return Array.from(this.byType.values());
  }
}

