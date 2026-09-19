import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_SEED_MARKER, demoBannerLine, readDemoSeedMarker } from "./demo-banner.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-banner-"));
  roots.push(root);
  return root;
}

describe("demoBannerLine", () => {
  test("not seeded: undefined marker", () => {
    const line = demoBannerLine(undefined, Date.now());
    expect(line).toBe("DEMO — not seeded yet · run nimbus demo");
  });

  test("seeded 2h ago: fresh, mentions the org and the reset command", () => {
    const nowMs = 1_000_000_000;
    const line = demoBannerLine({ seededAtMs: nowMs - 2 * HOUR }, nowMs);
    expect(line).toContain("seeded 2h ago");
    expect(line).toContain("not your data");
  });

  test("seeded 3 days ago: stale", () => {
    const nowMs = 1_000_000_000;
    const line = demoBannerLine({ seededAtMs: nowMs - 3 * DAY }, nowMs);
    expect(line).toContain("(stale");
  });

  test("clock skew: nowMs before seededAtMs does not throw and reads as just-seeded", () => {
    const nowMs = 1_000_000_000;
    const line = demoBannerLine({ seededAtMs: nowMs + HOUR }, nowMs);
    expect(line).toContain("seeded 0m ago");
  });
});

describe("readDemoSeedMarker", () => {
  test("a valid marker file round-trips seededAtMs", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, DEMO_SEED_MARKER),
      JSON.stringify({ corpus: "acme", version: 1, seededAtMs: 42 }),
    );
    expect(readDemoSeedMarker(dir)).toEqual({ seededAtMs: 42 });
  });

  test("garbage JSON: undefined, no throw", () => {
    const dir = tempDir();
    writeFileSync(join(dir, DEMO_SEED_MARKER), "not json{{{");
    expect(readDemoSeedMarker(dir)).toBeUndefined();
  });

  test("a well-formed object missing seededAtMs: undefined", () => {
    const dir = tempDir();
    writeFileSync(join(dir, DEMO_SEED_MARKER), JSON.stringify({ corpus: "acme" }));
    expect(readDemoSeedMarker(dir)).toBeUndefined();
  });

  test("missing file: undefined, no throw", () => {
    const dir = tempDir();
    expect(readDemoSeedMarker(dir)).toBeUndefined();
  });
});
