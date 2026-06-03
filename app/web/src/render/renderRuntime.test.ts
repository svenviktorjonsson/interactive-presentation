import { describe, expect, it } from "vitest";
import { createRenderRuntime } from "./renderRuntime";

describe("renderRuntime", () => {
  it("creates isolated mutable runtime state per render runtime", () => {
    const a = createRenderRuntime();
    const b = createRenderRuntime();

    a.colorCache.set("x", "red");
    a.playerBusInstalled = true;

    expect(b.colorCache.size).toBe(0);
    expect(b.playerBusInstalled).toBe(false);
    expect(a.youtubePlayers).not.toBe(b.youtubePlayers);
    expect(a.axisState).not.toBe(b.axisState);
  });
});
