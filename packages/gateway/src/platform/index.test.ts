/**
 * Targeted unit tests for `packages/gateway/src/platform/index.ts`.
 *
 * The full PlatformServices creation is already exercised by platform.test.ts.
 * These tests cover the two branches that the existing suite doesn't reach at
 * measurable line-coverage cost:
 *
 *  - The `default` branch (unsupported platform): mock `node:os` so
 *    `platform()` returns `"freebsd"`, then call `createPlatformServices()`
 *    and confirm it rejects with `PlatformInitError`. This exercises lines 24
 *    and 26-28 in index.ts.
 *  - The PlatformInitError re-export and constructor shape.
 *
 * The mock is restored in `afterAll` by re-mocking with the real `platform`
 * function, preventing contamination of subsequent test files in the same bun
 * test process.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { platform as realPlatform } from "node:os";

// Capture the real platform() before mock takes effect.
const savedPlatform = realPlatform;

mock.module("node:os", () => ({
  platform: () => "freebsd",
}));

// Restore the real node:os implementation after this file finishes so that
// subsequent test files in the same bun test run are not contaminated.
afterAll(() => {
  mock.module("node:os", () => ({
    platform: savedPlatform,
  }));
});

// Import after mock is in place so createPlatformServices picks up "freebsd".
const { createPlatformServices, PlatformInitError } = await import("./index.ts");

describe("createPlatformServices — error branches (index.ts)", () => {
  test("PlatformInitError is exported from index.ts", () => {
    expect(PlatformInitError).toBeDefined();
    expect(typeof PlatformInitError).toBe("function");
  });

  test("createPlatformServices is a function", () => {
    expect(typeof createPlatformServices).toBe("function");
  });

  test("default branch throws PlatformInitError for unsupported platform", async () => {
    // With node:os mocked to return "freebsd", the switch default branch fires
    // (line 24 in index.ts), then PlatformInitError is re-thrown at line 28.
    await expect(createPlatformServices()).rejects.toBeInstanceOf(PlatformInitError);
  });

  test("PlatformInitError carries the right name and message", () => {
    const err = new PlatformInitError("Unsupported platform: freebsd");
    expect(err.name).toBe("PlatformInitError");
    expect(err.message).toContain("Unsupported platform");
    expect(err).toBeInstanceOf(PlatformInitError);
    expect(err).toBeInstanceOf(Error);
  });
});
