// packages/gateway/src/automation/workflow-schedule-view.ts
// `workflow.scheduleList` (Phase 10 SA4, plan task 8): every scheduled workflow with its expression,
// zone, next and last fire, its last run's status and, if a run is waiting for the owner, which step
// and which run id, so the CLI can print the exact `nimbus workflow resume <runId>`.
import type { Database } from "bun:sqlite";
import { parseWorkflowSteps } from "./workflow-steps.ts";
import { listScheduledWorkflows } from "./workflow-store.ts";

export interface ScheduleListEntry {
  readonly name: string;
  readonly schedule: string;
  readonly timezone: string;
  readonly nextFireAt: number | null;
  readonly lastFireAt: number | null;
  readonly lastRunStatus: string | null;
  readonly blockedRunId: string | null;
  readonly blockedStepLabel: string | null;
}

/** The label of step `index` of a workflow, or `step-N` when it cannot be read. */
function stepLabelAt(stepsJson: string, index: number): string {
  try {
    const step = parseWorkflowSteps(stepsJson)[index];
    return step?.label ?? `step-${String(index + 1)}`;
  } catch {
    return `step-${String(index + 1)}`;
  }
}

export function listScheduleView(db: Database): ScheduleListEntry[] {
  return listScheduledWorkflows(db).map((wf) => {
    const last = db
      .query(
        `SELECT status FROM workflow_run WHERE workflow_id = ? AND status <> 'skipped'
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(wf.id) as { status: string } | null | undefined;
    const blocked = db
      .query(
        `SELECT id, blocked_step FROM workflow_run
         WHERE workflow_id = ? AND status = 'blocked_on_approval'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(wf.id) as { id: string; blocked_step: number | null } | null | undefined;
    const blockedStep = blocked?.blocked_step ?? null;
    return {
      name: wf.name,
      schedule: wf.schedule,
      timezone: wf.schedule_tz,
      nextFireAt: wf.schedule_next_at,
      lastFireAt: wf.schedule_last_fire_at,
      lastRunStatus: last?.status ?? null,
      blockedRunId: blocked?.id ?? null,
      blockedStepLabel: blockedStep === null ? null : stepLabelAt(wf.steps_json, blockedStep),
    };
  });
}
