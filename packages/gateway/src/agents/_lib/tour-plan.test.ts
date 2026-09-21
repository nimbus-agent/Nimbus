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
