// The pure guard module: evaluation (the capped rule), the presence definition, the owner text.
import { describe, expect, test } from "bun:test";

import {
  evaluateGuard,
  guardRequiresPresence,
  guardRuleLines,
  guardText,
  type QueryCount,
} from "./workflow-guard.ts";
import type { GuardOp, WorkflowGuard, WorkflowStep } from "./workflow-steps.ts";

const OPS: GuardOp[] = ["gt", "gte", "lt", "lte", "eq", "ne"];
const g = (op: GuardOp, value: number, count = "q"): WorkflowGuard => ({ count, op, value });
const counts = (n: number, capped = false, index = 0): Map<string, QueryCount> =>
  new Map([["q", { index, values: Array.from({ length: n }, (_, i) => `v${String(i)}`), capped }]]);
const holds = (op: GuardOp, value: number, n: number, capped = false): boolean =>
  evaluateGuard([g(op, value)], counts(n, capped)).holds;

describe("evaluateGuard (not capped)", () => {
  const TRUTH: Record<GuardOp, (c: number, v: number) => boolean> = {
    gt: (c, v) => c > v,
    gte: (c, v) => c >= v,
    lt: (c, v) => c < v,
    lte: (c, v) => c <= v,
    eq: (c, v) => c === v,
    ne: (c, v) => c !== v,
  };
  for (const op of OPS) {
    test(`${op} at counts 0, 1, 4 and 5 against operand 1 and 4`, () => {
      for (const c of [0, 1, 4, 5]) {
        for (const v of [1, 4]) expect(holds(op, v, c)).toBe(TRUTH[op](c, v));
      }
    });
  }

  test("every comparison is observed, even after one failed; the query index is the flat one", () => {
    const ev = evaluateGuard([g("gt", 5), g("lt", 9), g("eq", 2)], counts(3, false, 4));
    expect(ev.holds).toBe(false);
    expect(ev.observed).toEqual([
      { query: 4, op: "gt", value: 5, observed: 3, capped: false, holds: false },
      { query: 4, op: "lt", value: 9, observed: 3, capped: false, holds: true },
      { query: 4, op: "eq", value: 2, observed: 3, capped: false, holds: false },
    ]);
  });

  test("a query with no result throws (it never reads as a count of zero)", () => {
    expect(() => evaluateGuard([g("gt", 0, "missing")], counts(3))).toThrow("has not run");
  });
});

describe("evaluateGuard (capped: the count is a lower bound)", () => {
  test("gt and gte hold on their lower bound", () => {
    expect(holds("gt", 3, 5, true)).toBe(true);
    expect(holds("gte", 5, 5, true)).toBe(true);
    expect(holds("gt", 5, 5, true)).toBe(false);
  });

  test("ne 0 holds when at least one value was seen, exactly like gt 0 (more rows cannot reach zero)", () => {
    expect(holds("ne", 0, 1, true)).toBe(true);
    expect(holds("ne", 0, 7, true)).toBe(true);
    expect(holds("ne", 0, 0, true)).toBe(false); // an all-dropped capped read proves nothing
    expect(holds("gt", 0, 1, true)).toBe(true);
  });

  test("every other operator fails closed, even when the lower bound satisfies it", () => {
    expect(holds("eq", 5, 5, true)).toBe(false);
    expect(holds("lt", 9, 5, true)).toBe(false);
    expect(holds("lte", 9, 5, true)).toBe(false);
    expect(holds("ne", 3, 5, true)).toBe(false); // ne n>=1: more rows could make it exactly n
    expect(holds("eq", 0, 0, true)).toBe(false);
  });

  test("the observation records capped", () => {
    expect(evaluateGuard([g("gt", 0)], counts(2, true)).observed[0]?.capped).toBe(true);
  });
});

describe("guardRequiresPresence: the one definition a standing rule relies on", () => {
  const rows: Array<[GuardOp, number, boolean]> = [
    ["gt", 0, true],
    ["gt", 7, true],
    ["gte", 1, true],
    ["gte", 3, true],
    ["eq", 1, true],
    ["eq", 2, true],
    ["ne", 0, true],
    ["eq", 0, false],
    ["lt", 1, false],
    ["lt", 3, false],
    ["lte", 0, false],
    ["lte", 2, false],
    ["ne", 1, false],
    ["ne", 2, false],
  ];
  for (const [op, v, needs] of rows) {
    test(`${op} ${String(v)} ${needs ? "requires presence" : "can hold at zero"}`, () => {
      expect(guardRequiresPresence([g(op, v)])).toBe(needs);
    });
  }

  test("an unguarded step requires presence", () => {
    expect(guardRequiresPresence(undefined)).toBe(true);
  });

  test("one absence-satisfiable comparison anywhere makes the whole guard ineligible (the review example)", () => {
    expect(guardRequiresPresence([g("gte", 3), g("eq", 0, "p1")])).toBe(false);
    expect(guardRequiresPresence([g("eq", 0, "p1"), g("gte", 3)])).toBe(false);
    expect(guardRequiresPresence([g("gte", 3), g("gt", 0, "p1")])).toBe(true);
  });
});

describe("guard text", () => {
  test("guardText joins the comparisons and sanitises the label", () => {
    expect(guardText([g("gt", 0), g("lte", 4, "other")])).toBe(
      "count(q) > 0 AND count(other) <= 4",
    );
    expect(guardText([g("gt", 0, "a\u001b[2Jb")])).not.toContain("\u001b");
  });

  const steps: WorkflowStep[] = [
    { kind: "run", run: "x" },
    {
      kind: "query",
      label: "old-read-mail",
      query: {
        service: "gmail",
        type: "email",
        where: [],
        select: "id",
        distinct: false,
        limit: 50,
      },
    },
  ];

  test("the rule lines name the query step number and the operator in words", () => {
    const words: Record<GuardOp, string> = {
      gt: "more than",
      gte: "at least",
      lt: "fewer than",
      lte: "at most",
      eq: "exactly",
      ne: "anything but",
    };
    for (const op of OPS) {
      expect(guardRuleLines([g(op, 3, "old-read-mail")], steps)).toEqual([
        `Runs only when: query step 2 (old-read-mail) selects ${words[op]} 3`,
      ]);
    }
  });

  test("a list adds one line per comparison and a closing line", () => {
    const lines = guardRuleLines([g("gt", 0, "old-read-mail"), g("lt", 9, "old-read-mail")], steps);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("(all of these must hold)");
  });
});
