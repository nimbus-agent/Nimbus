import { describe, expect, test } from "bun:test";

import { resolveSocketPath } from "../../src/paths.ts";

describe("resolveSocketPath", () => {
  test("returns NIMBUS_GATEWAY_SOCKET when set", () => {
    const prev = process.env["NIMBUS_GATEWAY_SOCKET"];
    process.env["NIMBUS_GATEWAY_SOCKET"] = "/tmp/override.sock";
    try {
      expect(resolveSocketPath()).toBe("/tmp/override.sock"); // cross-platform-ok — env-var override echoed back verbatim, not an OS-resolved path
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_GATEWAY_SOCKET"];
      else process.env["NIMBUS_GATEWAY_SOCKET"] = prev;
    }
  });

  test("falls back to platform default when NIMBUS_GATEWAY_SOCKET is unset", () => {
    const prev = process.env["NIMBUS_GATEWAY_SOCKET"];
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    try {
      const p = resolveSocketPath();
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env["NIMBUS_GATEWAY_SOCKET"] = prev;
    }
  });

  test("ignores NIMBUS_GATEWAY_SOCKET when set to empty string", () => {
    const prev = process.env["NIMBUS_GATEWAY_SOCKET"];
    process.env["NIMBUS_GATEWAY_SOCKET"] = "";
    try {
      const p = resolveSocketPath();
      // Must not be the empty string — falls back to platform default
      expect(p.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_GATEWAY_SOCKET"];
      else process.env["NIMBUS_GATEWAY_SOCKET"] = prev;
    }
  });
});
