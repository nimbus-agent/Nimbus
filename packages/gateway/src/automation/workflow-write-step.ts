// packages/gateway/src/automation/workflow-write-step.ts
// The execution of a workflow `write` step (Phase 10 SA2, spec § 5.1). For each id the referenced
// query step selected (one action per id; a write that holds only constants runs once) it builds a
// `PlannedAction` and runs it through the executor the caller supplied. That executor is built by
// `engine/run-ask.ts` `buildWorkflowWriteExecutor`: consent bound to the run's client, no delegation,
// the before-state runner. Every action asks the owner; nothing here approves anything.
//
// `provenance` on a PlannedAction is constructed ONLY in this file (a source-pin test holds it):
// no IPC method, door, payload or `input` can supply one. It is set only when the run's trigger was
// derived server-side from a local owner client (`cli` / `ui`); a run of any other origin builds the
// same action with no provenance, so nothing downstream can mistake it for the owner's.
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import type {
  ActionResult,
  PlannedAction,
  WorkflowProvenance,
  WorkflowTrigger,
} from "../engine/types.ts";
import type { JsonValue, WriteValue, WriteWorkflowStep } from "./workflow-steps.ts";

/** What a write step needs from the executor: one call. */
export type WorkflowWriteExecutor = {
  execute(action: PlannedAction): Promise<ActionResult>;
};

/** The facts of the run a write step's provenance records. */
export type WriteStepRun = {
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly stepIndex: number;
  readonly runId: string;
  /** Derived by the IPC dispatcher from the client's kind; `undefined` means no provenance. */
  readonly trigger: WorkflowTrigger | undefined;
  /** The query step each label names, and the values it selected. */
  readonly queries: ReadonlyMap<
    string,
    { readonly index: number; readonly values: readonly string[] }
  >;
  readonly signal?: AbortSignal | undefined;
};

export type WriteStepOutcome =
  | { status: "done"; dispatched: number; message: string }
  | { status: "skipped"; dispatched: 0; message: string }
  | { status: "error"; dispatched: number; message: string };

function fieldSourcesOf(
  step: WriteWorkflowStep,
  run: WriteStepRun,
): WorkflowProvenance["fieldSources"] {
  const out: Record<string, "constant" | { query: number; column: string }> = {};
  for (const [field, v] of Object.entries(step.input)) {
    if ("from" in v) {
      const q = run.queries.get(v.from);
      out[field] = { query: q?.index ?? -1, column: v.column };
    } else {
      out[field] = "constant";
    }
  }
  return out;
}

function inputFor(
  step: WriteWorkflowStep,
  selected: string | undefined,
): Record<string, JsonValue> {
  const input: Record<string, JsonValue> = {};
  for (const [field, v] of Object.entries(step.input) as [string, WriteValue][]) {
    if ("from" in v) {
      // buildActions only reaches here with a selected value for a step that has a `from`.
      input[field] = selected as string;
    } else {
      input[field] = v.const;
    }
  }
  return input;
}

/** The query label a write step reads, or `undefined` when it holds only constants. */
export function referencedQuery(step: WriteWorkflowStep): string | undefined {
  for (const v of Object.values(step.input)) {
    if ("from" in v) return v.from;
  }
  return undefined;
}

/** The actions a write step runs, one per selected id; empty when its query selected nothing. */
export function buildWriteActions(step: WriteWorkflowStep, run: WriteStepRun): PlannedAction[] {
  const row = connectorWriteRowByToolId(step.tool);
  if (row === undefined) throw new Error(`"${step.tool}" is not a connector write tool`);
  const label = referencedQuery(step);
  let ids: readonly (string | undefined)[];
  if (label === undefined) {
    ids = [undefined];
  } else {
    const q = run.queries.get(label);
    if (q === undefined) throw new Error(`query "${label}" has not run`);
    ids = q.values;
  }
  const fieldSources = fieldSourcesOf(step, run);
  const trigger = run.trigger;
  return ids.map((id) => {
    const action: PlannedAction = {
      type: row.actionType,
      payload: { mcpToolId: row.toolId, input: inputFor(step, id) },
    };
    if (trigger !== undefined) {
      action.provenance = {
        kind: "owner_workflow",
        workflowId: run.workflowId,
        workflowSha256: run.workflowSha256,
        stepIndex: run.stepIndex,
        runId: run.runId,
        trigger,
        fieldSources,
      };
    }
    return action;
  });
}

/**
 * Runs the step's actions one after another through `executor`. The first action the owner
 * declines, a gate refuses or that throws ends the step (the rest are not asked): a step that was
 * stopped says how many were done.
 */
export async function runWriteStep(
  step: WriteWorkflowStep,
  run: WriteStepRun,
  executor: WorkflowWriteExecutor,
): Promise<WriteStepOutcome> {
  const actions = buildWriteActions(step, run);
  if (actions.length === 0) {
    return { status: "skipped", dispatched: 0, message: "skipped: no matches" };
  }
  let dispatched = 0;
  for (const action of actions) {
    if (run.signal?.aborted === true) {
      return {
        status: "error",
        dispatched,
        message: `cancelled after ${String(dispatched)} of ${String(actions.length)}`,
      };
    }
    let result: ActionResult;
    try {
      result = await executor.execute(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: "error",
        dispatched,
        message: `${msg} (stopped after ${String(dispatched)} of ${String(actions.length)})`,
      };
    }
    if (result.status === "rejected") {
      return {
        status: "error",
        dispatched,
        message: `not done: ${result.reason} (stopped after ${String(dispatched)} of ${String(actions.length)})`,
      };
    }
    dispatched++;
  }
  return {
    status: "done",
    dispatched,
    message: `${step.tool}: ${String(dispatched)} of ${String(actions.length)} done`,
  };
}
