import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueryLatency100kOnce, S2B_TIER } from "./bench-query-latency-100k.ts";

describe("runQueryLatency100kOnce (S2-b)", () => {
  test("pins the medium corpus tier", () => {
    expect(S2B_TIER).toBe("medium");
  });

  test("returns 100 finite samples (test runs against small tier for speed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-s2b-test-"));
    try {
      const samples = await runQueryLatency100kOnce(
        { runs: 1, runner: "local-dev", corpus: "small" },
        { cacheDir: dir, overrideTier: "small" },
      );
      expect(samples.length).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
