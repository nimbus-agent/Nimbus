// packages/gateway/src/automation/workflow-resume.ts
// What `workflow.resume` checks before anything runs (Phase 10 SA4, plan task 7). A blocked run can be
// resumed only if it is still blocked, recorded the hash of the definition it executed, and the
// stored workflow still hashes to it: an edited workflow is a different workflow, and the owner
// approves the run they see, so a changed one is refused (`ERR_WORKFLOW_CHANGED`) and must be run
// afresh. The runner checks the hash again when the new run starts.
import type { Database } from "bun:sqlite";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";

/** A refused resume: `code` is the stable `ERR_*` the caller can match. */
export class ResumeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface PreparedResume {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly blockedStep: number;
  readonly expectedSha256: string;
}

type BlockedRunRow = {
  workflow_id: string;
  name: string;
  steps_json: string;
  status: string;
  blocked_step: number | null;
  workflow_sha256: string | null;
};

/** Validates a resume of `runId`; throws {@link ResumeError}, never changes anything. */
export function prepareResume(db: Database, runId: string): PreparedResume {
  const row = db
    .query(
      `SELECT r.workflow_id, w.name, w.steps_json, r.status, r.blocked_step, r.workflow_sha256
       FROM workflow_run r JOIN workflow w ON w.id = r.workflow_id WHERE r.id = ?`,
    )
    .get(runId) as BlockedRunRow | null | undefined;
  if (row === null || row === undefined) {
    throw new ResumeError("ERR_RUN_NOT_FOUND", "no such run");
  }
  if (row.status !== "blocked_on_approval") {
    throw new ResumeError("ERR_RUN_NOT_BLOCKED", "the run is not waiting for approval");
  }
  if (row.workflow_sha256 === null || row.blocked_step === null) {
    throw new ResumeError(
      "ERR_RUN_NOT_RESUMABLE",
      "this run did not record the workflow it executed; run the workflow again or discard it",
    );
  }
  let current: string;
  try {
    current = workflowStepsSha256(parseWorkflowSteps(row.steps_json));
  } catch {
    throw new ResumeError("ERR_WORKFLOW_CHANGED", "the workflow no longer parses");
  }
  if (current !== row.workflow_sha256) {
    throw new ResumeError(
      "ERR_WORKFLOW_CHANGED",
      "the workflow was edited after this run was blocked; run it again instead",
    );
  }
  return {
    runId,
    workflowId: row.workflow_id,
    workflowName: row.name,
    blockedStep: row.blocked_step,
    expectedSha256: row.workflow_sha256,
  };
}

/** The workflow a blocked run belongs to, for `discard` (which needs no hash check). */
export function blockedRunWorkflow(
  db: Database,
  runId: string,
): { workflowId: string; workflowName: string } {
  const row = db
    .query(
      `SELECT r.workflow_id AS workflowId, w.name AS workflowName, r.status
       FROM workflow_run r JOIN workflow w ON w.id = r.workflow_id WHERE r.id = ?`,
    )
    .get(runId) as { workflowId: string; workflowName: string; status: string } | null | undefined;
  if (row === null || row === undefined) {
    throw new ResumeError("ERR_RUN_NOT_FOUND", "no such run");
  }
  if (row.status !== "blocked_on_approval") {
    throw new ResumeError("ERR_RUN_NOT_BLOCKED", "the run is not waiting for approval");
  }
  return { workflowId: row.workflowId, workflowName: row.workflowName };
}
