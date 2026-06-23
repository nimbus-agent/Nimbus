import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueryLatency1mOnce, S2C_TIER } from "./bench-query-latency-1m.ts";

describe("runQueryLatency1mOnce (S2-c)", () => {
  test("pins the large corpus tier", () => {
    expect(S2C_TIER).toBe("large");
  });

  test("returns 100 finite samples (test runs against small tier for speed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-s2c-test-"));
    try {
      const samples = await runQueryLatency1mOnce(
        { runs: 1, runner: "local-dev", corpus: "small" },
        { cacheDir: dir, overrideTier: "small" },
      );
      expect(samples).toHaveLength(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
