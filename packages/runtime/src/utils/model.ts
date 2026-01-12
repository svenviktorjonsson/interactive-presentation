import type { PresentationModel } from "@interactive/content";

export function cloneModel<T extends PresentationModel>(m: T): T {
  // Browser-native deep clone where available; fallback to JSON for plain data models.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sc = (globalThis as any).structuredClone as ((v: any) => any) | undefined;
    if (typeof sc === "function") return sc(m);
  } catch {
    // ignore
  }
  return JSON.parse(JSON.stringify(m)) as T;
}

