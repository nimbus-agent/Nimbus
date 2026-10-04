/**
 * `buildSyntheticIndex` arms `perf-fixture.test.ts` does not reach: a cache directory that does
 * not exist yet, and the DEFAULT cache directory (under the OS temp dir) when no options are given.
 *
 * The default-directory case never touches the real OS temp dir: `TMPDIR`/`TMP`/`TEMP` point at a
 * fresh mkdtemp directory for the synchronous span of the call (`Promise.try` runs the build
 * before `buildSyntheticIndex` returns), and the precondition is CHECKED before the call, so a
 * runtime that ignored the redirect would fail this test rather than write outside it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSyntheticIndex, FIXTURE_SEED, FIXTURE_TIER_SIZES } from "./perf-fixture.ts";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

describe("buildSyntheticIndex — cache directory handling", () => {
  test("creates a cache directory that does not exist yet, nested, and builds into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "perf-fixture-cov-"));
    try {
      const cacheDir = join(root, "not", "yet", "there");
      expect(existsSync(cacheDir)).toBe(false);
      const path = await buildSyntheticIndex("small", { cacheDir });
      expect(path).toBe(join(cacheDir, `small-${FIXTURE_SEED.toString(16)}.sqlite`));
      const db = new Database(path, { readonly: true });
      try {
        const row = db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number };
        expect(row.n).toBe(FIXTURE_TIER_SIZES.small);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });

  test("with no options it uses <os temp>/nimbus-bench-fixtures, and reuses a cached file there", async () => {
    const fakeTemp = mkdtempSync(join(tmpdir(), "perf-fixture-default-"));
    const saved = new Map(TEMP_VARS.map((k) => [k, process.env[k]]));
    const expectedPath = join(
      fakeTemp,
      "nimbus-bench-fixtures",
      `small-${FIXTURE_SEED.toString(16)}.sqlite`,
    );
    // Pre-seed the cache so the default-path call is a cache HIT: no 10k-row build, and the
    // sentinel bytes prove the file was reused rather than regenerated.
    mkdirSync(join(fakeTemp, "nimbus-bench-fixtures"));
    writeFileSync(expectedPath, "cached-sentinel");
    let pending: Promise<string> | undefined;
    try {
      for (const k of TEMP_VARS) process.env[k] = fakeTemp;
      // Precondition, checked rather than assumed: if this runtime did not honour the redirect,
      // stop HERE instead of letting the call below write into the real temp directory.
      expect(tmpdir()).toBe(fakeTemp);
      pending = buildSyntheticIndex("small");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      expect(await pending).toBe(expectedPath);
      expect(readFileSync(expectedPath, "utf8")).toBe("cached-sentinel");
    } finally {
      rmSync(fakeTemp, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    }
  });
});
