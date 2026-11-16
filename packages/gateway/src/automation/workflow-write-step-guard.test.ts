// The write step of a GUARDED step: it is built only from a guard evaluation that held (fail closed in
// depth), and the action's provenance records the observed counts (history, not authority).
import { describe, expect, test } from "bun:test";

import { evaluateGuard, type QueryCount } from "./workflow-guard.ts";
import { parseWorkflowSteps, type WriteWorkflowStep } from "./workflow-steps.ts";
import { buildWriteActions, type WriteStepRun } from "./workflow-write-step.ts";

const QUERY = {
  kind: "query",
  label: "q",
  query: {
    service: "gmail",
    type: "email",
    where: [],
    select: "metadata.threadId",
    distinct: true,
    limit: 50,
  },
};
function step(when?: unknown): WriteWorkflowStep {
  const rows = [
    QUERY,
    {
      kind: "write",
      tool: "gmail_thread_archive",
      input: { threadId: { from: "q", column: "metadata.threadId" } },
      ...(when === undefined ? {} : { when }),
    },
  ];
  return parseWorkflowSteps(JSON.stringify(rows))[1] as WriteWorkflowStep;
}
const queries = new Map<string, QueryCount>([
  ["q", { index: 0, values: ["t1", "t2", "t3"], capped: false }],
]);
const base: WriteStepRun = {
  workflowId: "wf",
  workflowSha256: "a".repeat(64),
  stepIndex: 1,
  runId: "r1",
  trigger: "owner_cli",
  queries,
};

describe("buildWriteActions with a guard", () => {
  test("a guarded step with no evaluation throws (fail closed in depth), and so does a guard that did not hold", () => {
    const s = step({ count: "q", gt: 0 });
    expect(() => buildWriteActions(s, base)).toThrow("without a guard that held");
    const notHeld = evaluateGuard([{ count: "q", op: "gt", value: 9 }], queries);
    expect(() => buildWriteActions(s, { ...base, guard: notHeld })).toThrow("without a guard");
  });

  test("a held guard adds a bounded display-only provenance field; an unguarded step has none", () => {
    const s = step({ count: "q", gt: 0 });
    const guard = evaluateGuard(s.when ?? [], queries);
    const actions = buildWriteActions(s, { ...base, guard });
    expect(actions).toHaveLength(3);
    expect(actions[0]?.provenance?.guard).toEqual([
      { query: 0, op: "gt", value: 0, observed: 3, capped: false },
    ]);
    const plain = buildWriteActions(step(), base);
    expect(plain[0]?.provenance).not.toHaveProperty("guard");
  });

  test("the guard field holds no label: four comparisons stay small however long the labels", () => {
    const long = "L".repeat(300);
    const rows = [
      { ...QUERY, label: long },
      {
        kind: "write",
        tool: "gmail_thread_archive",
        input: { threadId: { from: long, column: "metadata.threadId" } },
        when: [
          { count: long, gt: 0 },
          { count: long, gte: 1 },
          { count: long, lt: 40 },
          { count: long, ne: 3 },
        ],
      },
    ];
    const s = parseWorkflowSteps(JSON.stringify(rows))[1] as WriteWorkflowStep;
    const q = new Map<string, QueryCount>([[long, { index: 0, values: ["a"], capped: false }]]);
    const guard = evaluateGuard(s.when ?? [], q);
    const [a] = buildWriteActions(s, { ...base, queries: q, guard });
    const size = JSON.stringify(a?.provenance?.guard).length;
    expect(size).toBeLessThan(400);
    expect(JSON.stringify(a?.provenance?.guard)).not.toContain("LLLL");
    expect(a?.provenance?.guard).toHaveLength(4);
  });
});
