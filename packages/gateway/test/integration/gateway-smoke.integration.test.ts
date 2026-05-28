import { describe, expect, test } from "bun:test";

describe("gateway integration smoke", () => {
  test("PAL module loads", async () => {
    const { createPlatformServices } = await import("../../src/platform/index.ts");
    expect(typeof createPlatformServices).toBe("function");
  });
});
