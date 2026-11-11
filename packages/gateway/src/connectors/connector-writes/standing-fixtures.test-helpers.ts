// Test support for the standing-rule tests (Phase 10 SA3): a database with the V88 tables, the
// archive workflow of the acceptance criterion, an action built by the REAL write-step builder (so
// its provenance is the one a run produces), and a rule created through the REAL derive + store.
// Imported by tests only; no production file imports this module.
import { Database } from "bun:sqlite";
import {
  parseWorkflowSteps,
  type WriteWorkflowStep,
  workflowStepsSha256,
} from "../../automation/workflow-steps.ts";
import { upsertWorkflowByName } from "../../automation/workflow-store.ts";
import { buildWriteActions } from "../../automation/workflow-write-step.ts";
import type { PlannedAction, WorkflowTrigger } from "../../engine/types.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { ensureFullSqlite } from "../../platform/sqlite-runtime.ts";
import { type CreateRuleRequest, deriveRule } from "../../standing/standing-rule-derive.ts";
import { insertRule } from "../../standing/standing-rule-store.ts";
import type { StandingRule } from "../../standing/standing-rule-types.ts";

export const NOW = Date.UTC(2026, 10, 11, 8, 30); // a Wednesday, 08:30 UTC

/** The acceptance criterion's workflow: archive the threads a declared query selects. */
export const ARCHIVE_STEPS = [
  {
    kind: "query",
    label: "old-read-mail",
    query: {
      service: "gmail",
      type: "email",
      where: [{ metadata: "labelIds", notContains: "UNREAD" }, { olderThanDays: 60 }],
      select: "metadata.threadId",
      distinct: true,
      limit: 200,
    },
  },
  {
    kind: "write",
    label: "archive",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "old-read-mail", column: "metadata.threadId" } },
  },
] as const;

export function freshDb(): Database {
  ensureFullSqlite();
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 90);
  return db;
}

export type SeededWorkflow = {
  readonly id: string;
  readonly name: string;
  readonly sha: string;
  readonly steps: ReturnType<typeof parseWorkflowSteps>;
};

/** Saves a workflow of `steps` (default: the archive workflow) and returns what a run would load. */
export function seedWorkflow(
  db: Database,
  steps: readonly unknown[] = ARCHIVE_STEPS,
  name = "weekly-mail-clean",
): SeededWorkflow {
  const stepsJson = JSON.stringify(steps);
  const id = upsertWorkflowByName(db, name, null, stepsJson, NOW);
  const parsed = parseWorkflowSteps(stepsJson);
  return { id, name, sha: workflowStepsSha256(parsed), steps: parsed };
}

/** An action exactly as a run's write step builds it for one selected thread id. */
export function archiveAction(
  wf: SeededWorkflow,
  opts: {
    readonly trigger?: WorkflowTrigger | undefined;
    readonly threadId?: string;
    readonly stepIndex?: number;
  } = {},
): PlannedAction {
  const stepIndex = opts.stepIndex ?? 1;
  const step = wf.steps[stepIndex] as WriteWorkflowStep;
  const [action] = buildWriteActions(step, {
    workflowId: wf.id,
    workflowSha256: wf.sha,
    stepIndex,
    runId: "run-1",
    trigger: "trigger" in opts ? opts.trigger : "owner_cli",
    queries: new Map([["old-read-mail", { index: 0, values: [opts.threadId ?? "thread-1"] }]]),
  });
  return action as PlannedAction;
}

/** Creates a rule the way the create handler does, minus the prompt (the audit id is a stand-in). */
export function createRule(
  db: Database,
  req: Partial<CreateRuleRequest> = {},
  over: { readonly now?: number } = {},
): StandingRule {
  const derived = deriveRule(
    db,
    { workflow: "weekly-mail-clean", step: "archive", ...req },
    () => true,
    over.now ?? NOW - 1000,
  );
  return insertRule(db, { ...derived.rule, approvalAuditId: 1 });
}
