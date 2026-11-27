// The `workflow.run.completed` audit row every finished, blocked or skipped run writes. Split out of
// `workflow-runner.ts` (a file on the size baseline) unchanged.
import type { Database } from "bun:sqlite";
import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { WorkflowTrigger } from "../engine/types.ts";

export function emitRunCompletedAudit(params: {
  readonly db: Database;
  readonly runId: string;
  readonly workflowName: string;
  readonly status: string;
  readonly startedAt: number;
  readonly dryRun: boolean;
  readonly paramsOverride?: Readonly<Record<string, Record<string, unknown>>>;
  readonly errorMsg?: string | null;
  /** How many guarded steps did not run in a real run; absent when none. */
  readonly stepsNotTaken?: number;
  /** The run's derived trigger, so audit history tells a scheduled run from an owner-started one. */
  readonly trigger?: WorkflowTrigger;
}): void {
  const durationMs = Date.now() - params.startedAt;
  const details: Record<string, unknown> = {
    runId: params.runId,
    workflowName: params.workflowName,
    status: params.status,
    durationMs,
    dryRun: params.dryRun,
  };
  if (params.trigger !== undefined) {
    details["trigger"] = params.trigger;
  }
  if (params.paramsOverride !== undefined) {
    details["paramsOverride"] = params.paramsOverride;
  }
  if (params.errorMsg !== undefined && params.errorMsg !== null) {
    details["errorMsg"] = params.errorMsg;
  }
  if (params.stepsNotTaken !== undefined && params.stepsNotTaken > 0) {
    details["stepsNotTaken"] = params.stepsNotTaken;
  }
  appendAuditEntry(params.db, {
    actionType: "workflow.run.completed",
    hitlStatus: "not_required",
    actionJson: redactAuditPayload(details),
    timestamp: Date.now(),
  });
}
