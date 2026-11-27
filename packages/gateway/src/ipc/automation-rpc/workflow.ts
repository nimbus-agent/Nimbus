import { listSources } from "../../automation/workflow-import-store.ts";
import { listWorkflowRuns } from "../../automation/workflow-run-history.ts";
import { resolveSaveSchedule, ScheduleSaveError } from "../../automation/workflow-schedule.ts";
import { listScheduleView } from "../../automation/workflow-schedule-view.ts";
import {
  parseWorkflowSteps,
  stepsSaveRefusal,
  workflowStepsSha256,
} from "../../automation/workflow-steps.ts";
import {
  clearScheduleByName,
  deleteWorkflowByName,
  listWorkflows,
  upsertWorkflowByName,
} from "../../automation/workflow-store.ts";
import { constantTimeStringEqual } from "../../util/timing-safe-compare.ts";
import type { ClientKind } from "../server/client-kind.ts";
import {
  type AutomationCtx,
  type AutomationHandler,
  AutomationRpcError,
  requireNumber,
  requireString,
} from "./shared.ts";

/** What `workflow list` says about where a workflow's content came from (a hash comparison, never stored). */
type WorkflowSourceView =
  | { readonly kind: "local" }
  | {
      readonly kind: "imported";
      readonly signerFingerprint: string;
      readonly issuedAt: number;
      readonly edited: boolean;
    };

function currentContentHash(stepsJson: string): string | null {
  try {
    return workflowStepsSha256(parseWorkflowSteps(stepsJson));
  } catch {
    return null;
  }
}

/**
 * `workflow.list` (I59): the saved workflows, each with a `source` ONLY for the owner's own connection
 * (`cli` or `ui`). Any other connection (a paired LAN peer, an unidentified local process) gets the rows as
 * before, with NO `source` key, so a peer learns no signer fingerprint. One `listSources` read, never a
 * query per row.
 */
function listWithSource(
  ctx: AutomationCtx,
): Array<ReturnType<typeof listWorkflows>[number] & { source?: WorkflowSourceView }> {
  const rows = listWorkflows(ctx.db);
  if (ctx.clientKind !== "cli" && ctx.clientKind !== "ui") return rows;
  const sources = listSources(ctx.db);
  return rows.map((w) => {
    const src = sources.get(w.id);
    if (src === undefined) return { ...w, source: { kind: "local" } as const };
    // An unknown current hash (steps that no longer parse) is always "edited"; otherwise I10.
    const current = currentContentHash(w.steps_json);
    return {
      ...w,
      source: {
        kind: "imported",
        signerFingerprint: src.signerFingerprint,
        issuedAt: src.issuedAt,
        edited: current === null || !constantTimeStringEqual(current, src.stepsSha256),
      } as const,
    };
  });
}

/** A `clientKind` key in the params would be a caller naming its own kind: refused, not ignored. */
function refuseSuppliedClientKind(rec: Record<string, unknown> | undefined, method: string): void {
  if (rec !== undefined && Object.hasOwn(rec, "clientKind")) {
    throw new AutomationRpcError(
      -32602,
      `${method}: clientKind is derived by the gateway and may not be sent`,
    );
  }
}

/** A save the gateway refused; its message names why (`workflow.save` adds its own prefix). */
export class WorkflowSaveError extends Error {
  override readonly name = "WorkflowSaveError";
}

/**
 * The ONE save path (`workflow.save`, and `cost.reportSchedule` for a generated cost report workflow): the
 * steps are validated as at every run, the schedule is resolved for the CONNECTION's kind (never a param),
 * then the row is upserted by name. Throws {@link WorkflowSaveError}.
 */
export function saveWorkflowDefinition(
  db: AutomationCtx["db"],
  d: {
    readonly name: string;
    readonly description: string | null;
    readonly stepsJson: string;
    readonly schedule: unknown;
    readonly scheduleTz: unknown;
    readonly clientKind: ClientKind | undefined;
    readonly now: number;
  },
): { id: string; scheduled: boolean } {
  // A query or write step is validated at SAVE and again at every run (Phase 10 SA2); a
  // run-only workflow saves exactly as it always did.
  const refusal = stepsSaveRefusal(d.stepsJson);
  if (refusal !== undefined) throw new WorkflowSaveError(refusal);
  // A save sets the schedule it names or clears the old one; only a local owner client may set one
  // (SA4): the kind comes from the connection, and an absent kind is `unknown`, which is refused.
  let schedule: ReturnType<typeof resolveSaveSchedule>;
  try {
    schedule = resolveSaveSchedule({
      schedule: d.schedule,
      scheduleTz: d.scheduleTz,
      stepsJson: d.stepsJson,
      clientKind: d.clientKind ?? "unknown",
      now: d.now,
    });
  } catch (e) {
    if (e instanceof ScheduleSaveError) throw new WorkflowSaveError(e.message);
    throw e;
  }
  const id = upsertWorkflowByName(db, d.name, d.description, d.stepsJson, d.now, schedule);
  return { id, scheduled: schedule !== null };
}

export const WORKFLOW_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "workflow.list": (_rec, ctx) => ({
    kind: "hit",
    value: { workflows: listWithSource(ctx) },
  }),

  "workflow.save": (rec, ctx) => {
    const description =
      rec !== undefined && typeof rec["description"] === "string" ? rec["description"] : null;
    const name = requireString(rec, "name");
    const stepsJson = requireString(rec, "stepsJson");
    const refusal = stepsSaveRefusal(stepsJson);
    if (refusal !== undefined) throw new AutomationRpcError(-32602, `workflow.save: ${refusal}`);
    refuseSuppliedClientKind(rec, "workflow.save");
    try {
      const value = saveWorkflowDefinition(ctx.db, {
        name,
        description,
        stepsJson,
        schedule: rec?.["schedule"],
        scheduleTz: rec?.["scheduleTz"],
        clientKind: ctx.clientKind,
        now: Date.now(),
      });
      return { kind: "hit", value };
    } catch (e) {
      if (e instanceof WorkflowSaveError) {
        throw new AutomationRpcError(-32602, `workflow.save: ${e.message}`);
      }
      throw e;
    }
  },

  "workflow.scheduleList": (_rec, ctx) => ({
    kind: "hit",
    value: { schedules: listScheduleView(ctx.db) },
  }),

  "workflow.unschedule": (rec, ctx) => {
    refuseSuppliedClientKind(rec, "workflow.unschedule");
    return {
      kind: "hit",
      value: { ok: clearScheduleByName(ctx.db, requireString(rec, "name")) },
    };
  },

  "workflow.delete": (rec, ctx) => ({
    kind: "hit",
    value: { ok: deleteWorkflowByName(ctx.db, requireString(rec, "name")) },
  }),

  "workflow.listRuns": (rec, ctx) => ({
    kind: "hit",
    value: listWorkflowRuns(ctx.db, {
      workflowName: requireString(rec, "workflowName"),
      limit: requireNumber(rec, "limit"),
    }),
  }),
};
