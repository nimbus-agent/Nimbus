import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticIndex, FIXTURE_TIER_SIZES } from "./perf-fixture.ts";

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "perf-fixture-test-"));
}

describe("buildSyntheticIndex", () => {
  test("generates a file containing exactly the expected number of items for `small`", async () => {
    const dir = freshCacheDir();
    try {
      const path = await buildSyntheticIndex("small", { cacheDir: dir });
      const db = new Database(path, { readonly: true });
      const row = db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number };
      db.close();
      expect(row.n).toBe(FIXTURE_TIER_SIZES.small);
    } finally {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });

  test("is deterministic — two invocations of the same tier produce byte-identical files", async () => {
    const dir = freshCacheDir();
    try {
      const a = await buildSyntheticIndex("small", { cacheDir: dir });
      const contentA = readFileSync(a);
      rmSync(a);
      const b = await buildSyntheticIndex("small", { cacheDir: dir });
      const contentB = readFileSync(b);
      expect(contentA).toHaveLength(contentB.length);
      expect(contentA.equals(contentB)).toBe(true);
    } finally {
      // maxRetries: 0 / retryDelay: 0 — fail FAST rather than block the hook's timeout
      // budget; a leaked temp dir is the accepted trade-off (#972, #973). Do NOT turn
      // this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });

  test("reuses cached file when present (does not regenerate)", async () => {
    const dir = freshCacheDir();
    try {
      const path = await buildSyntheticIndex("small", { cacheDir: dir });
      const mtime1 = statSync(path).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      const path2 = await buildSyntheticIndex("small", { cacheDir: dir });
      const mtime2 = statSync(path2).mtimeMs;
      expect(path).toBe(path2);
      expect(mtime2).toBe(mtime1);
    } finally {
      // maxRetries: 0 / retryDelay: 0 — fail FAST rather than block the hook's timeout
      // budget; a leaked temp dir is the accepted trade-off (#972, #973). Do NOT turn
      // this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });
});
