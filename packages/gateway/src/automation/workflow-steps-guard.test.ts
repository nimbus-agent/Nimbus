// Workflow conditionals: the `when` guard in the step parser (D1 matrix, D5 refusals, the strict run
// row, hash stability). Every refusal here is a case the parser must hold; the hash fixture was
// computed with the parser on main BEFORE this feature, so an old workflow hashes as it did.
import { describe, expect, test } from "bun:test";

import {
  parseWorkflowSteps,
  stepsSaveRefusal,
  type WorkflowGuard,
  type WorkflowStep,
  WorkflowStepsError,
  workflowStepsSha256,
} from "./workflow-steps.ts";

const QUERY = {
  service: "gmail",
  type: "email",
  where: [{ olderThanDays: 60 }],
  select: "metadata.threadId",
  distinct: true,
  limit: 200,
};
const FROM_Q = { from: "q", column: "metadata.threadId" };

function qStep(label = "q", limit = 200): Record<string, unknown> {
  return { kind: "query", label, query: { ...QUERY, limit } };
}
function wStep(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "write", tool: "gmail_thread_archive", input: { threadId: FROM_Q }, ...extra };
}
function parse(steps: unknown[]): WorkflowStep[] {
  return parseWorkflowSteps(JSON.stringify(steps));
}
function refusal(steps: unknown[]): string {
  try {
    parse(steps);
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowStepsError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}
const whenOf = (s: WorkflowStep | undefined): readonly WorkflowGuard[] =>
  s !== undefined && s.kind !== "query" && s.kind !== "report" ? (s.when ?? []) : [];
const guarded = (when: unknown, limit = 200): unknown[] => [qStep("q", limit), wStep({ when })];

describe("when guard: shape", () => {
  test("a single comparison is stored as a one-element list, as written", () => {
    const steps = parse(guarded({ count: "q", gt: 0 }));
    expect(steps[1]).toMatchObject({ kind: "write", when: [{ count: "q", op: "gt", value: 0 }] });
  });

  test("a list means AND; four are allowed, five and none are refused", () => {
    const four = [
      { count: "q", gt: 0 },
      { count: "q", gte: 1 },
      { count: "q", lt: 9 },
      { count: "q", ne: 3 },
    ];
    expect(whenOf(parse(guarded(four))[1])).toHaveLength(4);
    expect(refusal(guarded([...four, { count: "q", eq: 1 }]))).toContain("1 to 4");
    expect(refusal(guarded([]))).toContain("1 to 4");
  });

  test("a guard may sit on a run step and on a write; a query is never guarded", () => {
    const steps = parse([qStep(), { kind: "run", run: "say hi", when: { count: "q", eq: 0 } }]);
    expect(steps[1]).toMatchObject({ kind: "run", when: [{ count: "q", op: "eq", value: 0 }] });
    expect(refusal([qStep(), { ...qStep("q2"), when: { count: "q", gt: 0 } }])).toContain(
      "always runs",
    );
  });

  test("a guard names an EARLIER query step only (never a run or write step, never a later query)", () => {
    expect(refusal([wStep({ when: { count: "q", gt: 0 } }), qStep()])).toBeDefined();
    const runThenGuard = [
      qStep(),
      { kind: "run", label: "sum", run: "x" },
      wStep({ when: { count: "sum", gt: 0 } }),
    ];
    expect(refusal(runThenGuard)).toContain("can never read a run or write step");
    expect(refusal(guarded({ count: "nope", gt: 0 }))).toContain("earlier query step");
    const twoWrites = [qStep(), wStep({ label: "w1" }), wStep({ when: { count: "w1", gt: 0 } })];
    expect(refusal(twoWrites)).toContain("can never read a run or write step");
  });

  test("unknown keys, two operators, no operator and non-integers are refused", () => {
    for (const bad of [
      { count: "q", gt: 0, or: {} },
      { count: "q", gt: 0, lt: 5 },
      { count: "q" },
      { gt: 0 },
      { count: "q", gt: 1.5 },
      { count: "q", gt: "1" },
      { count: "q", gt: true },
      { count: "q", gt: Number.NaN },
      { count: "", gt: 0 },
      null,
      7,
    ]) {
      expect(() => parse(guarded(bad))).toThrow(WorkflowStepsError);
    }
  });

  test("the same query may be named twice in one list", () => {
    const steps = parse(
      guarded([
        { count: "q", gt: 0 },
        { count: "q", lt: 9 },
      ]),
    );
    expect(whenOf(steps[1])).toHaveLength(2);
  });
});

describe("when guard: the operand matrix", () => {
  // The plan's matrix: every operator against -1, 0, 1, L-1, L and L+1, for L = 1 and L = 5.
  const ALLOWED: Record<string, (n: number, L: number) => boolean> = {
    gt: (n, L) => n >= 0 && n <= L - 1,
    gte: (n, L) => n >= 1 && n <= L - 1,
    lt: (n, L) => n >= 1 && n <= L - 1,
    lte: (n, L) => n >= 0 && n <= L - 1,
    eq: (n, L) => n >= 0 && n <= L - 1,
    ne: (n, L) => n >= 0 && n <= L - 1,
  };
  for (const L of [1, 5]) {
    for (const op of ["gt", "gte", "lt", "lte", "eq", "ne"]) {
      for (const n of [-1, 0, 1, L - 1, L, L + 1]) {
        const ok = ALLOWED[op]?.(n, L) === true;
        test(`${op} ${String(n)} against limit ${String(L)} is ${ok ? "allowed" : "refused"}`, () => {
          const run = () => parse(guarded({ count: "q", [op]: n }, L));
          if (ok) expect(run).not.toThrow();
          else expect(run).toThrow(WorkflowStepsError);
        });
      }
    }
  }

  test("always-true and never-true forms say why; gt L-1 is allowed", () => {
    expect(refusal(guarded({ count: "q", gte: 0 }))).toContain("always true");
    expect(refusal(guarded({ count: "q", lt: 0 }))).toContain("never be true");
    expect(refusal(guarded({ count: "q", gt: 200 }))).toContain("out of range");
    expect(() => parse(guarded({ count: "q", gt: 199 }))).not.toThrow();
  });

  test("equivalent forms are stored as written and hash differently", () => {
    const a = parse(guarded({ count: "q", ne: 0 }));
    const b = parse(guarded({ count: "q", gt: 0 }));
    expect(workflowStepsSha256(a)).not.toBe(workflowStepsSha256(b));
    expect(whenOf(a[1])[0]?.op).toBe("ne");
  });

  test("a guard edited by one byte changes the hash", () => {
    const a = workflowStepsSha256(parse(guarded({ count: "q", gt: 0 })));
    const b = workflowStepsSha256(parse(guarded({ count: "q", gt: 1 })));
    expect(a).not.toBe(b);
  });
});

describe("when guard: a run row that carries the key is strict whatever its value", () => {
  const withRun = (row: Record<string, unknown>): unknown[] => [qStep(), row];

  test("a missing, empty or non-string run refuses the whole workflow instead of dropping the step", () => {
    for (const run of [undefined, "", "   ", 7, null]) {
      const row: Record<string, unknown> = { kind: "run", when: { count: "q", gt: 0 } };
      if (run !== undefined) row["run"] = run;
      expect(() => parse(withRun(row))).toThrow(WorkflowStepsError);
      expect(stepsSaveRefusal(JSON.stringify(withRun(row)))).toContain("needs a non-empty run");
    }
  });

  test("an unknown key refuses; when null, a number, a string and an empty list refuse", () => {
    const bad = { kind: "run", run: "x", extra: 1, when: { count: "q", gt: 0 } };
    expect(() => parse(withRun(bad))).toThrow(WorkflowStepsError);
    for (const when of [null, 5, [], "q"]) {
      expect(() => parse(withRun({ kind: "run", run: "x", when }))).toThrow(WorkflowStepsError);
    }
  });

  test("a guarded run row among other steps never changes the parsed step count", () => {
    const rows = [
      qStep(),
      { run: "a" },
      { kind: "run", run: "b", when: { count: "q", gt: 0 } },
      { run: "" },
    ];
    expect(parse(rows)).toHaveLength(3);
  });

  test("a bare run row keeps its legacy leniency", () => {
    expect(parse([{ run: "a", extra: 1 }, { run: "" }, { label: "x" }])).toEqual([
      { kind: "run", run: "a" },
    ]);
  });
});

describe("when guard: caps and hash stability", () => {
  test("the step caps apply only to a workflow that uses when", () => {
    const manyRuns = Array.from({ length: 120 }, (_, i) => ({ run: `r${String(i)}` }));
    expect(parse(manyRuns)).toHaveLength(120); // an old workflow stays valid
    const over = [qStep(), ...manyRuns.slice(0, 100), wStep({ when: { count: "q", gt: 0 } })];
    expect(refusal(over)).toContain("at most 100 steps");
    const fiftyOne = [
      qStep(),
      ...Array.from({ length: 51 }, () => wStep({ when: { count: "q", gt: 0 } })),
    ];
    expect(refusal(fiftyOne)).toContain("at most 50 steps with a when");
  });

  test("a workflow without when hashes exactly as it did before the change", () => {
    // The hash was computed by the parser on main before this feature (same input, old module).
    const legacy = parse([
      {
        kind: "query",
        label: "old-mail",
        query: { ...QUERY, where: [{ olderThanDays: 60 }], limit: 200 },
      },
      {
        kind: "write",
        tool: "gmail_thread_archive",
        input: { threadId: { from: "old-mail", column: "metadata.threadId" } },
      },
      { run: "hello", label: "x", continueOnError: true },
    ]);
    expect(JSON.stringify(legacy)).not.toContain("when");
    expect(workflowStepsSha256(legacy)).toBe(
      "bc57304e8ffa9bd82e368c104e7d0498ab72e47a71ecaf6e0f1abc9fb2afc89d",
    );
  });
});
