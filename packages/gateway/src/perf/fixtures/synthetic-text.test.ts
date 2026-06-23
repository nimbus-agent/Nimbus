import { describe, expect, test } from "bun:test";

import { SYNTHETIC_TEXT_DEFAULT_SEED, synthesizeText } from "./synthetic-text.ts";

describe("synthesizeText", () => {
  test("returns exactly `count` strings", () => {
    const out = synthesizeText({ length: 50, count: 32 });
    expect(out).toHaveLength(32);
  });

  test("each string has roughly `length` characters (±10%)", () => {
    const out = synthesizeText({ length: 500, count: 16 });
    for (const s of out) {
      expect(s.length).toBeGreaterThanOrEqual(450);
      expect(s.length).toBeLessThanOrEqual(550);
    }
  });

  test("is deterministic across calls with the same seed", () => {
    const a = synthesizeText({ length: 100, count: 8, seed: 42 });
    const b = synthesizeText({ length: 100, count: 8, seed: 42 });
    expect(a).toEqual(b);
  });

  test("varies with different seeds", () => {
    const a = synthesizeText({ length: 100, count: 8, seed: 1 });
    const b = synthesizeText({ length: 100, count: 8, seed: 2 });
    expect(a).not.toEqual(b);
  });

  test("uses the documented default seed when seed is omitted", () => {
    const a = synthesizeText({ length: 100, count: 4 });
    const b = synthesizeText({ length: 100, count: 4, seed: SYNTHETIC_TEXT_DEFAULT_SEED });
    expect(a).toEqual(b);
  });

  test("scales to S8 large-tier (length=5000, count=64) without OOM", () => {
    const out = synthesizeText({ length: 5_000, count: 64 });
    expect(out).toHaveLength(64);
    expect(out[0]?.length).toBeGreaterThan(4_500);
  });
});
