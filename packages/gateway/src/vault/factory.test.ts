/**
 * Targeted unit tests for `packages/gateway/src/vault/factory.ts`.
 *
 * `createNimbusVault` is a thin platform dispatcher — fully exercising all
 * three branches in a single test run is impossible (only one OS branch
 * executes per invocation). What we can cover:
 *
 *  1. The function is exported and is async (AsyncFunction constructor name).
 *  2. The unsupported-platform default branch throws PlatformInitError — this
 *     is the branch not reached by the per-OS integration tests that run on
 *     exactly one platform each.
 *
 * Test 2 mocks `node:os` so `platform()` returns `"freebsd"`, which forces the
 * switch-default branch (line 21 in factory.ts) to fire.  The saved real
 * function is restored in `afterAll` so subsequent test files in the same bun
 * test run continue to see the host OS.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { platform as realPlatform } from "node:os";
import type { PlatformPaths } from "../platform/paths.ts";

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

// Import after mock is in place so createNimbusVault picks up "freebsd".
const { createNimbusVault } = await import("./factory.ts");
const { PlatformInitError } = await import("../platform/errors.ts");

describe("createNimbusVault factory", () => {
  test("createNimbusVault is an async function", () => {
    expect(typeof createNimbusVault).toBe("function");
    const proto = Object.getPrototypeOf(createNimbusVault) as { constructor: { name: string } };
    expect(proto.constructor.name).toBe("AsyncFunction");
  });

  test("default branch throws PlatformInitError for unsupported platform", async () => {
    // With node:os mocked to return "freebsd", the switch default branch fires
    // (line 21 in factory.ts), throwing PlatformInitError.
    // The paths argument is never reached — cast is safe here.
    await expect(createNimbusVault({} as unknown as PlatformPaths)).rejects.toBeInstanceOf(
      PlatformInitError,
    );
  });

  test("PlatformInitError carries the right name and message", () => {
    const err = new PlatformInitError("Unsupported platform for vault: freebsd");
    expect(err.name).toBe("PlatformInitError");
    expect(err.message).toContain("Unsupported platform for vault");
    expect(err).toBeInstanceOf(PlatformInitError);
    expect(err).toBeInstanceOf(Error);
  });
});
