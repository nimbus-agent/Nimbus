import { describe, expect, test } from "bun:test";

import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import {
  ARCHIVE_STEPS,
  freshDb,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { deriveRule, ineligibleReason, scopeOfStep } from "./standing-rule-derive.ts";
import { StandingRuleError } from "./standing-rule-text.ts";

const frozen = (t: string): boolean => HITL_REQUIRED.has(t);

function derive(db: ReturnType<typeof freshDb>, req: Parameters<typeof deriveRule>[1]) {
  return deriveRule(db, req, frozen, NOW);
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StandingRuleError) return e.message;
    throw e;
  }
  return "";
}

describe("ineligibleReason (OR-10-1)", () => {
  const row = (toolId: string): ConnectorWriteRow =>
    connectorWriteRowByToolId(toolId) as ConnectorWriteRow;

  test("a wave 2 write is eligible", () => {
    expect(ineligibleReason(row("gmail_thread_archive"), true)).toBeUndefined();
  });

  test("an unknown row, a wave 4 row, a never-offered row and a type that is not HITL by itself are not", () => {
    expect(ineligibleReason(undefined, true)).toContain("not a connector write");
    expect(ineligibleReason(row("jenkins_build_abort"), true)).toContain("wave 4");
    expect(ineligibleReason(row("gmail_message_send"), true)).toContain("never run automatically");
    expect(ineligibleReason(row("gmail_thread_archive"), false)).toContain(
      "does not require approval by itself",
    );
  });

  test("a bound row, a typed-confirm row and a refused row are not (synthetic rows, wave 2)", () => {
    const base = row("gmail_thread_archive");
    expect(ineligibleReason({ ...base, toolId: "x_bound", bound: {} as never }, true)).toContain(
      "bound",
    );
    expect(
      ineligibleReason({ ...base, toolId: "x_confirm", confirm: { template: "x" } }, true),
    ).toContain("typed confirmation");
    expect(ineligibleReason({ ...base, toolId: "x_refused", refuse: "no" }, true)).toContain(
      "refused",
    );
  });
});

describe("scopeOfStep", () => {
  test("a query reference carries the query step's index; a constant carries its value", () => {
    const wf = seedWorkflow(freshDb(), [
      ARCHIVE_STEPS[0],
      {
        kind: "write",
        label: "archive",
        tool: "gmail_thread_archive",
        input: { threadId: { from: "old-read-mail", column: "metadata.threadId" } },
      },
    ]);
    expect(scopeOfStep(wf.steps[1] as never, wf.steps)).toEqual({
      threadId: { query: 0, column: "metadata.threadId" },
    });
    const c = seedWorkflow(
      freshDb(),
      [{ kind: "write", tool: "gmail_thread_archive", input: { threadId: { const: "T" } } }],
      "c",
    );
    expect(scopeOfStep(c.steps[0] as never, c.steps)).toEqual({ threadId: { const: "T" } });
  });
});

describe("deriveRule", () => {
  test("derives hash, step index, tool, type, scope, expiry and ceiling from the stored workflow", () => {
    const db = freshDb();
    const wf = seedWorkflow(db);
    const d = derive(db, { workflow: wf.name, step: "archive" });
    expect(d.rule).toMatchObject({
      workflowId: wf.id,
      workflowSha256: wf.sha,
      stepIndex: 1,
      actionType: "gmail.thread.archive",
      toolId: "gmail_thread_archive",
      createdAt: NOW,
      maxActions: 100,
      expiresAt: NOW + 30 * 86_400_000,
    });
    expect(d.text.stepLabel).toBe("archive");
    expect(d.rule.window).toBeUndefined();
  });

  test("a step is found by label, by a 1-based number or by a numeric string; a label wins over a number", () => {
    const db = freshDb();
    const wf = seedWorkflow(db);
    expect(derive(db, { workflow: wf.name, step: 2 }).rule.stepIndex).toBe(1);
    expect(derive(db, { workflow: wf.name, step: "2" }).rule.stepIndex).toBe(1);
    const db2 = freshDb();
    seedWorkflow(
      db2,
      [
        {
          kind: "write",
          label: "2",
          tool: "gmail_thread_archive",
          input: { threadId: { const: "a" } },
        },
        {
          kind: "write",
          label: "1",
          tool: "gmail_thread_archive",
          input: { threadId: { const: "b" } },
        },
      ],
      "n",
    );
    expect(derive(db2, { workflow: "n", step: "2" }).rule.stepIndex).toBe(0);
  });

  test("an unnamed step is addressable by its default label", () => {
    const db = freshDb();
    seedWorkflow(db, [
      { kind: "write", tool: "gmail_thread_archive", input: { threadId: { const: "a" } } },
    ]);
    expect(derive(db, { workflow: "weekly-mail-clean", step: "step-1" }).rule.stepIndex).toBe(0);
  });

  test("refuses an unknown workflow, a missing step, a non-write step and a stored workflow that no longer parses", () => {
    const db = freshDb();
    seedWorkflow(db);
    expect(refusal(() => derive(db, { workflow: "nope", step: "archive" }))).toBe(
      "no such workflow",
    );
    expect(refusal(() => derive(db, { workflow: "weekly-mail-clean", step: "nope" }))).toBe(
      "the workflow has no such step",
    );
    expect(refusal(() => derive(db, { workflow: "weekly-mail-clean", step: 99 }))).toBe(
      "the workflow has no such step",
    );
    expect(
      refusal(() => derive(db, { workflow: "weekly-mail-clean", step: "old-read-mail" })),
    ).toBe("a standing rule can name only a write step");
    db.run("UPDATE workflow SET steps_json = ? WHERE name = ?", ["not json", "weekly-mail-clean"]);
    expect(refusal(() => derive(db, { workflow: "weekly-mail-clean", step: "archive" }))).toBe(
      "the stored workflow does not parse",
    );
  });

  test("refuses a type that is not HITL by itself, and a limit outside OR-10-6", () => {
    const db = freshDb();
    seedWorkflow(db);
    expect(
      refusal(() =>
        deriveRule(db, { workflow: "weekly-mail-clean", step: "archive" }, () => false, NOW),
      ),
    ).toContain("does not require approval by itself");
    expect(
      refusal(() => derive(db, { workflow: "weekly-mail-clean", step: "archive", days: 91 })),
    ).toContain("days must be");
    expect(
      refusal(() => derive(db, { workflow: "weekly-mail-clean", step: "archive", max: 0 })),
    ).toContain("max must be");
  });

  test("an ineligible write cannot even be saved in a workflow, so a rule never meets one", () => {
    // The step parser refuses a wave 4, never-offered or bound write at save, so a stored workflow
    // never holds one; `ineligibleReason` is the second line, covered above.
    expect(() =>
      seedWorkflow(freshDb(), [{ kind: "write", tool: "gmail_message_send", input: {} }], "bad"),
    ).toThrow();
  });
});
