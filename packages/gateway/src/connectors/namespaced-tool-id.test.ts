import { describe, expect, test } from "bun:test";
import { matchesBareOrNamespacedToolId } from "./namespaced-tool-id.ts";

const IDS = new Set(["fx_run", "fx_run_all"]);
const isExactly = (id: string): boolean => IDS.has(id);
const LONGEST = Math.max(...[...IDS].map((id) => id.length));

function matches(toolId: string): boolean {
  return matchesBareOrNamespacedToolId(toolId, isExactly, LONGEST);
}

describe("matchesBareOrNamespacedToolId — one matching rule for every federated refusal", () => {
  test("the bare id, and any `_`-delimited suffix under any server key", () => {
    for (const id of ["fx_run", "fx_fx_run", "fx_bundle_fx_run", "a_b_c_fx_run_all"]) {
      expect(matches(id), id).toBe(true);
    }
  });

  test("not a lookalike, a prefix, or a suffix that is not `_`-delimited", () => {
    for (const id of ["xfx_run", "fx_run_x", "fx_runx", "fx", "", "_", "fx_run_"]) {
      expect(matches(id), id).toBe(false);
    }
  });

  test("a suffix longer than the longest id is never tried", () => {
    // `isExactly` sees only candidates no longer than LONGEST, however long the caller's id is.
    const seen: number[] = [];
    const probe = (id: string): boolean => {
      seen.push(id.length);
      return false;
    };
    matchesBareOrNamespacedToolId(`${"a_".repeat(500)}b`, probe, LONGEST);
    expect(seen[0]).toBe(1001); // the bare id itself is always tried
    expect(seen.length).toBeGreaterThan(1); // and some suffixes were
    expect(Math.max(...seen.slice(1))).toBeLessThanOrEqual(LONGEST);
  });
});
