import { describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_OWNERSHIP_TOML, parseNimbusOwnershipToml } from "./nimbus-toml.ts";

describe("[ownership] config", () => {
  test("defaults match both existing derivation passes (enabled)", () => {
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.enabled).toBe(true);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.debounceMs).toBe(30_000);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.halfLifeDays).toBe(365);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.minShare).toBeCloseTo(0.05, 10);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.maxOwnersPerPath).toBe(10);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.ignoreGlobs.length).toBeGreaterThan(0);
  });

  test("an empty config yields the defaults", () => {
    expect(parseNimbusOwnershipToml("")).toEqual(DEFAULT_NIMBUS_OWNERSHIP_TOML);
  });

  // THE REGRESSION THIS FILE EXISTS FOR: `min_share` is the one FLOAT key.
  // If its branch falls through to the integer branch, `parseIntDec("0.25")` is
  // `Number.parseInt("0.25", 10)` = 0 — finite, so the `n <= 0` guard returns
  // early and `minShare` silently keeps its DEFAULT. The asserted value must
  // therefore DIFFER from the default (0.05), or the test passes either way.
  test("min_share survives the float branch", () => {
    const cfg = parseNimbusOwnershipToml("[ownership]\nmin_share = 0.25\n");
    expect(cfg.minShare).toBeCloseTo(0.25, 10);
    expect(cfg.minShare).not.toBe(DEFAULT_NIMBUS_OWNERSHIP_TOML.minShare);
  });

  // Clamping is this test's job. Note only the `-1` case is ORDERING-sensitive:
  // `parseIntDec("-1")` = -1 <= 0, so a misordered float branch returns early and
  // `minShare` falls back to the default (0.05), failing the expectation of 0.
  // The `5` case passes in BOTH orderings — the switch's `default: break` falls
  // through to the float code — so it proves clamping, not ordering.
  test("min_share clamps to [0,1]", () => {
    expect(parseNimbusOwnershipToml("[ownership]\nmin_share = 5\n").minShare).toBe(1);
    expect(parseNimbusOwnershipToml("[ownership]\nmin_share = -1\n").minShare).toBe(0);
  });

  test("integer keys parse", () => {
    const cfg = parseNimbusOwnershipToml(
      "[ownership]\ndebounce_ms = 1000\nhalf_life_days = 90\nmax_owners_per_path = 3\n",
    );
    expect(cfg.debounceMs).toBe(1000);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.maxOwnersPerPath).toBe(3);
  });

  test("enabled = false parses", () => {
    expect(parseNimbusOwnershipToml("[ownership]\nenabled = false\n").enabled).toBe(false);
  });

  test("ignore_globs overrides the defaults, and an empty array disables filtering", () => {
    const cfg = parseNimbusOwnershipToml('[ownership]\nignore_globs = ["**/*.gen.ts"]\n');
    expect(cfg.ignoreGlobs).toEqual(["**/*.gen.ts"]);
    expect(parseNimbusOwnershipToml("[ownership]\nignore_globs = []\n").ignoreGlobs).toEqual([]);
  });

  test("malformed values fall back to defaults rather than throwing", () => {
    const cfg = parseNimbusOwnershipToml(
      "[ownership]\ndebounce_ms = nonsense\nmin_share = nonsense\n",
    );
    expect(cfg.debounceMs).toBe(DEFAULT_NIMBUS_OWNERSHIP_TOML.debounceMs);
    expect(cfg.minShare).toBe(DEFAULT_NIMBUS_OWNERSHIP_TOML.minShare);
  });

  test("a malformed ignore_globs does not discard the rest of the section", () => {
    // Regression: `parseStringArray` throws on a non-bracketed value. Unguarded
    // that unwinds out of the whole-section parse, so `enabled = false` would be
    // lost and the pass would silently run again.
    const cfg = parseNimbusOwnershipToml("[ownership]\nenabled = false\nignore_globs = nonsense\n");
    expect(cfg.enabled).toBe(false);
    expect(cfg.ignoreGlobs).toEqual(DEFAULT_NIMBUS_OWNERSHIP_TOML.ignoreGlobs);
  });
});
