import { describe, expect, test } from "bun:test";
import { checkScopes, SCOPE_GATES } from "./check-scopes.ts";
import { EXCLUSIONS } from "./exclusions.ts";

/** Minimal lcov for one file: `lines` DA records, `covered` of them hit. */
function lcovFor(entries: ReadonlyArray<{ path: string; lines: number; covered: number }>): string {
  return entries
    .map(({ path, lines, covered }) => {
      const da = Array.from(
        { length: lines },
        (_, i) => `DA:${String(i + 1)},${i < covered ? "1" : "0"}`,
      );
      return [
        `SF:${path}`,
        ...da,
        `LF:${String(lines)}`,
        `LH:${String(covered)}`,
        "end_of_record",
      ].join("\n");
    })
    .join("\n");
}

/** A scope's predicate is data; pick a real path it matches so tests bind to the table. */
function pathForScope(name: string): string {
  const candidates = [
    "packages/gateway/src/engine/executor.ts",
    "packages/gateway/src/vault/key-format.ts",
    "packages/gateway/src/agents/catchup.ts",
    "packages/cli/src/tui/app.ts",
  ];
  const gate = SCOPE_GATES.find((g) => g.name === name);
  if (gate === undefined) throw new Error(`no scope named ${name}`);
  const hit = candidates.find((c) => gate.match(c));
  if (hit === undefined) throw new Error(`no candidate path matches scope ${name}`);
  return hit;
}

describe("checkScopes", () => {
  test("passes a scope at or above its floor", () => {
    const path = pathForScope("Engine"); // floor 85
    const out = checkScopes(lcovFor([{ path, lines: 100, covered: 90 }]));
    const engine = out.results.find((r) => r.name === "Engine");
    expect(engine?.ok).toBe(true);
    expect(engine?.linePct).toBeCloseTo(90, 5);
  });

  test("FAILS a scope below its floor", () => {
    const path = pathForScope("Engine"); // floor 85
    const out = checkScopes(lcovFor([{ path, lines: 100, covered: 84 }]));
    expect(out.ok).toBe(false);
    expect(out.errors.join(" ")).toContain("Engine");
    expect(out.errors.join(" ")).toContain("84.00%");
  });

  test("a floor is a floor: exactly at it passes", () => {
    const path = pathForScope("Engine");
    const out = checkScopes(lcovFor([{ path, lines: 100, covered: 85 }]));
    expect(out.results.find((r) => r.name === "Engine")?.ok).toBe(true);
  });

  /**
   * The gate-that-cannot-fail case. These predicates name directories, and
   * directories get renamed; a scope silently matching nothing would report ok
   * forever while measuring no code at all.
   */
  test("a scope matching ZERO files fails rather than vacuously passing", () => {
    // An lcov containing only an unrelated file: every scope matches nothing.
    const out = checkScopes(
      lcovFor([{ path: "packages/docs/src/whatever.ts", lines: 10, covered: 10 }]),
    );
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBe(SCOPE_GATES.length);
    expect(out.errors.join(" ")).toContain("matched 0 non-exempt files");
  });

  /**
   * Exempt files must not enter the denominator — that is what keeps this gate
   * measuring testable code rather than how much untestable per-OS glue a scope
   * happens to contain.
   */
  test("exempt files are excluded from the denominator", () => {
    const exemptExact = EXCLUSIONS.find(
      (e) => e.kind === "exact" && e.path.startsWith("packages/gateway/src/vault/"),
    );
    expect(exemptExact).toBeDefined();
    const exemptPath = (exemptExact as { path: string }).path;

    const covered = pathForScope("Vault"); // non-exempt vault file, floor 90
    // The exempt file is 0% and would drag the scope to 50% if it counted.
    const out = checkScopes(
      lcovFor([
        { path: covered, lines: 100, covered: 100 },
        { path: exemptPath, lines: 100, covered: 0 },
      ]),
    );
    const vault = out.results.find((r) => r.name === "Vault");
    expect(vault?.files).toBe(1);
    expect(vault?.linePct).toBeCloseTo(100, 5);
    expect(vault?.ok).toBe(true);
  });
});

describe("SCOPE_GATES table", () => {
  test("names are unique", () => {
    const names = SCOPE_GATES.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every floor is a sane percentage", () => {
    for (const g of SCOPE_GATES) {
      expect(g.floorLines).toBeGreaterThan(0);
      expect(g.floorLines).toBeLessThanOrEqual(100);
    }
  });

  // The floors CLAUDE.md names explicitly. If one of these is ever loosened,
  // the docs become wrong again — which is the failure this whole gate exists
  // to end.
  test("the documented headline floors are the ones enforced", () => {
    const floorOf = (n: string): number | undefined =>
      SCOPE_GATES.find((g) => g.name === n)?.floorLines;
    expect(floorOf("Engine")).toBe(85);
    expect(floorOf("Vault")).toBe(90);
    expect(floorOf("Embedding")).toBe(80);
  });
});
