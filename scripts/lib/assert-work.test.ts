// scripts/lib/assert-work.test.ts
import { describe, expect, test } from "bun:test";
import { assertDidWork } from "./assert-work.ts";

const BIOME = [/Checked (\d+) files/];

describe("assertDidWork", () => {
  test("passes when the tool reports a non-zero count", () => {
    expect(() => assertDidWork("Checked 3162 files in 700ms.", BIOME, "lint")).not.toThrow();
  });

  test("THROWS when the tool reports zero — a check that did nothing is not a pass", () => {
    expect(() => assertDidWork("Checked 0 files in 12ms.", BIOME, "lint")).toThrow(/did no work/i);
  });

  test("throws when no count can be found at all", () => {
    expect(() => assertDidWork("something unexpected", BIOME, "lint")).toThrow(
      /could not confirm/i,
    );
  });
});
