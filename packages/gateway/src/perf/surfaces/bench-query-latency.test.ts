import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueryLatencyOnce } from "./bench-query-latency.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "bench-query-latency-test-"));
}

describe("runQueryLatencyOnce (S2-a)", () => {
  test("returns 100 finite samples for a small fixture", async () => {
    const dir = freshDir();
    try {
      const samples = await runQueryLatencyOnce(
        {
          runs: 1,
          runner: "local-dev",
          corpus: "small",
        },
        { cacheDir: dir },
      );
      expect(samples).toHaveLength(100);
      for (const s of samples) {
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
