import { expect, test } from "bun:test";
import { buildTourPlan, TOUR_PRIORITY } from "./tour-plan.ts";
import type { TourSelectorCtx, TourSelectorResult } from "./tour-selectors.ts";
import type { TourStepKind } from "./tour-types.ts";
import { TOUR_STEP_KINDS } from "./tour-types.ts";

const ctx = { nowMs: 5_000 } as unknown as TourSelectorCtx;
const ok = (args: string[] = []): TourSelectorResult => ({ ok: { title: "T", args, reason: "r" } });
const all = (r: () => TourSelectorResult) =>
  Object.fromEntries(TOUR_STEP_KINDS.map((k) => [k, r])) as Record<
    TourStepKind,
    () => TourSelectorResult
  >;

test("priority is a permutation of the kinds", () => {
  expect([...TOUR_PRIORITY].sort()).toEqual([...TOUR_STEP_KINDS].sort());
});

test("six candidates, cap 3 → 3 steps, 3 more, 0 skipped", async () => {
  const p = await buildTourPlan(ctx, { steps: 3, demo: false, selectors: all(() => ok()) });
  expect(p.steps.map((s) => s.kind)).toEqual(["oncall", "why", "owners"]);
  expect(p.more.map((s) => s.kind)).toEqual(["standup", "decisions", "glossary"]);
  expect(p.skipped).toEqual([]);
  expect(p.t0).toBe(5_000);
});

test("empty index → everything skipped", async () => {
  const p = await buildTourPlan(ctx, {
    steps: 3,
    demo: false,
    selectors: all(() => ({ skip: "x" })),
  });
  expect(p.steps).toEqual([]);
  expect(p.more).toEqual([]);
  expect(p.skipped).toHaveLength(TOUR_STEP_KINDS.length);
});

test("a throwing selector is a skip, not a failed plan", async () => {
  const sel = {
    ...all(() => ok()),
    why: () => {
      throw new Error("bad json");
    },
  } as never;
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: sel });
  expect(p.skipped).toEqual([{ kind: "why", reason: "selector error" }]);
  expect(p.steps).toHaveLength(5);
});

test("command carries --demo on a demo gateway; args never do", async () => {
  const p = await buildTourPlan(ctx, {
    steps: 6,
    demo: true,
    selectors: all(() => ok(["a b", "--line", "3"])),
  });
  for (const s of p.steps) {
    expect(s.args).not.toContain("--demo");
    expect(s.command.startsWith(`nimbus --demo ${s.kind === "owners" ? "owners" : s.kind} `)).toBe(
      true,
    );
  }
  expect(p.steps[0]?.command).toContain('"a b"'); // an arg with a space is quoted for display
});

// M1: `quoteForDisplay` used to quote whitespace only — an arg like `a;rm -rf x.ts` (no leading
// space) rendered BARE, so a printed `command` line did something else entirely when pasted. Now
// anything outside a safe bare-argument charset is quoted, with an embedded `"` escaped.
test("quoting: shell metacharacters are quoted, safe paths and flags stay bare", async () => {
  const winPath = String.raw`C:\repo\src\auth.ts`;
  const posixPath = "/repo/src/auth.ts";
  const args = ["a b", "a;rm -rf x.ts", 'foo"bar', winPath, posixPath, "--line"];
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: all(() => ok(args)) });
  const step = p.steps[0];
  // args must remain byte-identical to the selector's own output — quoting is display-only.
  expect(step?.args).toEqual(args);

  const command = step?.command ?? "";
  expect(command).toContain('"a b"');
  expect(command).toContain('"a;rm -rf x.ts"');
  expect(command).toContain(String.raw`"foo\"bar"`);
  expect(command).toContain(winPath);
  expect(command).not.toContain(`"${winPath}"`);
  expect(command).toContain(posixPath);
  expect(command).not.toContain(`"${posixPath}"`);
  expect(command).toContain("--line");
  expect(command).not.toContain('"--line"');
});

// CodeQL "Incomplete string escaping" fix: the quoted form must escape `\` BEFORE `"` — order
// matters, since escaping `"` first would double the backslashes that step just added. An arg
// needing quotes that ends in a backslash used to render as `"foo\"`, whose closing quote a POSIX
// shell reads as ESCAPED rather than closing the string; `a\"b` round-tripped to the wrong value
// too. `oncall` is TOUR_PRIORITY[0], so `p.steps[0]` is always the `oncall` step below.

test("quoting: a trailing backslash before the closing quote is doubled, not left to escape it", async () => {
  const arg = `${String.raw`C:\my dir`}\\`; // "C:\my dir\" — one literal trailing backslash
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: all(() => ok([arg])) });
  const step = p.steps[0];
  expect(step?.args).toEqual([arg]); // args stays byte-identical to the selector's output
  // An EVEN number of backslashes (2) immediately precedes the closing quote.
  expect(step?.command).toBe(`nimbus oncall "${String.raw`C:\\my dir\\`}"`);
});

test("quoting: an existing backslash and double quote together — backslash doubled, quote escaped", async () => {
  const arg = `${String.raw`a\b`}" c`; // a\b" c
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: all(() => ok([arg])) });
  const step = p.steps[0];
  expect(step?.args).toEqual([arg]);
  expect(step?.command).toBe(`nimbus oncall "${String.raw`a\\b\"`} c"`);
});

test("quoting: a Windows path WITH a space doubles every backslash", async () => {
  const arg = String.raw`C:\my dir\x.ts`;
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: all(() => ok([arg])) });
  const step = p.steps[0];
  expect(step?.args).toEqual([arg]);
  expect(step?.command).toBe(`nimbus oncall "${String.raw`C:\\my dir\\x.ts`}"`);
});

test("quoting: a Windows path WITHOUT a space stays bare and unmodified", async () => {
  const arg = String.raw`C:\repo\src\auth.ts`;
  const p = await buildTourPlan(ctx, { steps: 6, demo: false, selectors: all(() => ok([arg])) });
  const step = p.steps[0];
  expect(step?.args).toEqual([arg]);
  expect(step?.command).toBe(`nimbus oncall ${arg}`);
});
