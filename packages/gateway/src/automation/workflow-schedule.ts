// packages/gateway/src/automation/workflow-schedule.ts
// What `workflow.save` does with a schedule (Phase 10 SA4, plan task 3). A schedule is the one way a
// standing rule fires with the owner absent, so it is set only by a local owner client, never by a
// LAN peer or an unidentified local process; it is validated and its zone resolved ONCE, here; and
// a workflow that holds a model (`run`) step cannot have one (owner ruling OR-10-8: unattended model
// use already has its own invariant and budget, I38, and SA4 adds no second path).
import type { ClientKind } from "../ipc/server/client-kind.ts";
import { isValidTimeZone, machineTimeZone, nextFire, scheduleRefusal } from "./cron.ts";
import { needsModel, parseWorkflowSteps } from "./workflow-steps.ts";
import type { WorkflowSchedule } from "./workflow-store.ts";

/** A refused schedule: `code` is the stable `ERR_*` the caller can match. */
export class ScheduleSaveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const SCHEDULE_LOCAL_ONLY = "ERR_SCHEDULE_LOCAL_ONLY";
export const SCHEDULE_INVALID = "ERR_SCHEDULE_INVALID";
export const SCHEDULE_NEEDS_NO_MODEL = "ERR_SCHEDULE_MODEL_STEP";

/** Kinds that may set a schedule: the owner's CLI and desktop on the local socket (as the trigger). */
const LOCAL_OWNER_KINDS: ReadonlySet<ClientKind> = new Set<ClientKind>(["cli", "ui"]);

export interface SaveScheduleInput {
  readonly schedule: unknown;
  readonly scheduleTz: unknown;
  readonly stepsJson: string;
  /** The CONNECTION's declared kind, set by the server from the session; never from params. */
  readonly clientKind: ClientKind;
  readonly now: number;
  /** Test seam: the machine zone used when no zone is given. */
  readonly machineTz?: () => string;
}

/**
 * The schedule a save stores: `null` when none was asked for (which clears any old one), or the
 * validated schedule with its first fire. Throws {@link ScheduleSaveError}.
 */
export function resolveSaveSchedule(input: SaveScheduleInput): WorkflowSchedule | null {
  const { schedule, scheduleTz } = input;
  if (schedule === undefined || schedule === null) {
    if (scheduleTz !== undefined && scheduleTz !== null) {
      throw new ScheduleSaveError(SCHEDULE_INVALID, "scheduleTz needs a schedule");
    }
    return null;
  }
  if (!LOCAL_OWNER_KINDS.has(input.clientKind)) {
    throw new ScheduleSaveError(
      SCHEDULE_LOCAL_ONLY,
      "a schedule is set only from the owner's CLI or desktop on the local socket",
    );
  }
  if (typeof schedule !== "string" || schedule.trim() === "") {
    throw new ScheduleSaveError(SCHEDULE_INVALID, "schedule must be a cron expression");
  }
  if (scheduleTz !== undefined && scheduleTz !== null && typeof scheduleTz !== "string") {
    throw new ScheduleSaveError(SCHEDULE_INVALID, "scheduleTz must be an IANA zone name");
  }
  const tz = typeof scheduleTz === "string" ? scheduleTz : (input.machineTz ?? machineTimeZone)();
  if (!isValidTimeZone(tz)) {
    throw new ScheduleSaveError(SCHEDULE_INVALID, `"${tz}" is not a time zone`);
  }
  const expr = schedule.trim();
  const refusal = scheduleRefusal(expr, tz);
  if (refusal !== undefined) throw new ScheduleSaveError(SCHEDULE_INVALID, refusal);
  refuseModelSteps(input.stepsJson);
  const nextAt = nextFire(expr, tz, input.now);
  if (nextAt === undefined)
    throw new ScheduleSaveError(SCHEDULE_INVALID, "this schedule never fires");
  return { expr, tz, nextAt };
}

/** A scheduled workflow runs with no model: any `run` step refuses the schedule. */
export function refuseModelSteps(stepsJson: string): void {
  let steps: ReturnType<typeof parseWorkflowSteps>;
  try {
    steps = parseWorkflowSteps(stepsJson);
  } catch (e) {
    throw new ScheduleSaveError(
      SCHEDULE_INVALID,
      `a scheduled workflow must parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (needsModel(steps)) {
    throw new ScheduleSaveError(
      SCHEDULE_NEEDS_NO_MODEL,
      "a workflow with a model (run) step cannot be scheduled; use query and write steps only",
    );
  }
}
