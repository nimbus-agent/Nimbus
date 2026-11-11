import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import {
  type RunConversationalAgentParams,
  runConversationalAgent,
} from "../engine/run-conversational-agent.ts";
import type { WorkflowTrigger } from "../engine/types.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { runDeclaredQuery } from "./declared-query.ts";
import { previewHitlActionsForStepText } from "./workflow-hitl-preview.ts";
import { pruneWorkflowRuns } from "./workflow-run-history.ts";
import {
  needsModel,
  nonRunStepLabels,
  parseWorkflowSteps,
  type QueryWorkflowStep,
  type RunWorkflowStep,
  type WorkflowStep,
  type WriteWorkflowStep,
  workflowStepsSha256,
} from "./workflow-steps.ts";
import {
  abandonWorkflowRunRow,
  blockWorkflowRunRow,
  finishWorkflowRunRow,
  getWorkflowByName,
  insertWorkflowRunRow,
  insertWorkflowRunStepRow,
  updateWorkflowRunStepRow,
} from "./workflow-store.ts";
import {
  runWriteStep,
  type WorkflowWriteExecutor,
  type WriteStepRun,
} from "./workflow-write-step.ts";

export type { WorkflowStep } from "./workflow-steps.ts";

/** What a run with a `run` step and no enabled model vendor reports. */
export const WORKFLOW_NEEDS_MODEL_MESSAGE =
  "Workflows need a model: enable a vendor under [llm.remote.<vendor>] in nimbus.toml " +
  "and store its <vendor>.api_key in the Vault.";

const RUN_RETENTION_PER_WORKFLOW = 100;

function emitRunCompletedAudit(params: {
  readonly db: Database;
  readonly runId: string;
  readonly workflowName: string;
  readonly status: string;
  readonly startedAt: number;
  readonly dryRun: boolean;
  readonly paramsOverride?: Readonly<Record<string, Record<string, unknown>>>;
  readonly errorMsg?: string | null;
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
  appendAuditEntry(params.db, {
    actionType: "workflow.run.completed",
    hitlStatus: "not_required",
    actionJson: redactAuditPayload(details),
    timestamp: Date.now(),
  });
}

/** Parses a workflow's `steps_json` (see `workflow-steps.ts`); kept under its old name. */
export function parseWorkflowStepsJson(stepsJson: string): WorkflowStep[] {
  return parseWorkflowSteps(stepsJson);
}

/** A run that stopped at a write step no standing rule covered and now waits for the owner (SA4). */
export type BlockedRunInfo = {
  readonly runId: string;
  readonly workflowName: string;
  readonly stepIndex: number;
  readonly stepLabel: string;
};

/**
 * Resumes a blocked run (SA4, `workflow.resume`): earlier write and run steps are skipped, earlier
 * QUERY steps are re-run against the current index (a query's rows are not persisted), and the run
 * continues from the blocked step. `expectedSha256` is the hash the blocked run executed; the runner
 * refuses if the stored workflow no longer hashes to it.
 */
export type WorkflowResume = {
  readonly runId: string;
  readonly blockedStep: number;
  readonly expectedSha256: string;
};

export const WORKFLOW_CHANGED_MESSAGE =
  "ERR_WORKFLOW_CHANGED: the workflow was edited after this run was blocked; run it again instead";

export type RunWorkflowExecutionParams = {
  db: Database;
  /** Needed only by a `run` step; a workflow of query and write steps runs with none. */
  agent?: Agent;
  /** Runs a `write` step's actions (SA2); built only by `buildWorkflowWriteExecutor`. */
  writeExecutor?: WorkflowWriteExecutor;
  /**
   * How the run started, derived by the IPC dispatcher from the client's declared kind. Absent
   * means the write actions carry no provenance. Never read from `workflow.run` params.
   */
  trigger?: WorkflowTrigger;
  workflowName: string;
  triggeredBy: string;
  dryRun: boolean;
  stream: boolean;
  sendChunk: (text: string) => void;
  conversationalRunner?: (p: RunConversationalAgentParams) => Promise<{ reply: string }>;
  readonly paramsOverride?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * Cancels the run at the NEXT STEP BOUNDARY. The in-flight step always runs
   * to completion — the signal is deliberately not threaded into step
   * execution or the LLM calls inside it.
   */
  readonly signal?: AbortSignal;
  /** Called once when the run blocks on a write no standing rule covered (the scheduler notifies). */
  readonly onBlocked?: (info: BlockedRunInfo) => void;
  /** Set only by `workflow.resume`. */
  readonly resume?: WorkflowResume;
};

export type RunWorkflowExecutionResult = {
  runId: string;
  /** The blocked run this one resumed (SA4). */
  resumedFrom?: string;
  /**
   * The run's terminal status: "preview" | "done" | "error" | "cancelled" | "blocked_on_approval".
   * Mirrors what finalizeRun wrote to workflow_run — an IPC caller cannot read
   * that table, so a cancelled run would otherwise be indistinguishable from a
   * short one that completed.
   */
  status: string;
  dryRun: boolean;
  stepResults: Array<{
    label?: string;
    status: string;
    output?: string;
    error?: string;
    hitlActions?: readonly string[];
  }>;
};

type StepExecOutcome =
  | { kind: "ok"; label: string; reply: string; status?: string }
  | { kind: "err"; label: string; message: string; halt: boolean }
  | { kind: "blocked"; label: string; message: string };

/** What the steps of one run share: the outputs of `run` steps and the query results. */
type RunState = {
  readonly outputs: string[];
  readonly queries: Map<string, { index: number; values: readonly string[] }>;
  readonly workflowId: string;
  readonly workflowSha256: string;
};

function stepLabelOf(step: WorkflowStep, stepIndex: number): string {
  return step.label ?? `step-${String(stepIndex + 1)}`;
}

function errorOutcome(label: string, err: unknown, halt: boolean): StepExecOutcome {
  return { kind: "err", label, message: err instanceof Error ? err.message : String(err), halt };
}

async function executeRunStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: RunWorkflowStep,
  outputs: string[],
): Promise<StepExecOutcome> {
  const label = stepLabelOf(step, stepIndex);
  const prior =
    outputs.length > 0
      ? `Prior step outputs (summarize, do not repeat verbatim):\n${outputs.join("\n---\n")}\n\n`
      : "";
  const prompt = `${prior}Workflow step ${String(stepIndex + 1)} (${label}):\n${step.run}`;

  if (p.stream) {
    p.sendChunk(`\n— Step ${String(stepIndex + 1)}: ${label} —\n`);
  }

  try {
    if (p.agent === undefined) throw new Error(WORKFLOW_NEEDS_MODEL_MESSAGE);
    const runner = p.conversationalRunner ?? runConversationalAgent;
    const { reply } = await runner({
      agent: p.agent,
      input: prompt,
      stream: p.stream,
      sendChunk: p.sendChunk,
    });
    outputs.push(reply);
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status: "done",
      resultJson: JSON.stringify({ reply }),
      finishedAt: Date.now(),
    });
    return { kind: "ok", label, reply };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status: "error",
      resultJson: JSON.stringify({ error: msg }),
      finishedAt: Date.now(),
    });
    return errorOutcome(label, err, step.continueOnError !== true);
  }
}

function executeQueryStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: QueryWorkflowStep,
  state: RunState,
): StepExecOutcome {
  const label = stepLabelOf(step, stepIndex);
  try {
    const r = runDeclaredQuery(p.db, step.query);
    state.queries.set(step.label, { index: stepIndex, values: r.values });
    const reply = `selected ${String(r.values.length)}; dropped ${String(r.dropped)} (not an id)`;
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status: "done",
      resultJson: JSON.stringify({ selected: r.values.length, dropped: r.dropped }),
      finishedAt: Date.now(),
    });
    return { kind: "ok", label, reply };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status: "error",
      resultJson: JSON.stringify({ error: msg }),
      finishedAt: Date.now(),
    });
    // A query that cannot run leaves the writes that read it with nothing to act on: halt.
    return errorOutcome(label, err, true);
  }
}

async function executeWriteStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: WriteWorkflowStep,
  state: RunState,
): Promise<StepExecOutcome> {
  const label = stepLabelOf(step, stepIndex);
  const halt = step.continueOnError !== true;
  const finish = (status: string, detail: Record<string, unknown>): void => {
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status,
      resultJson: JSON.stringify(detail),
      finishedAt: Date.now(),
    });
  };
  if (p.writeExecutor === undefined) {
    const message = "this gateway cannot run write steps (no write executor)";
    finish("error", { error: message });
    return { kind: "err", label, message, halt };
  }
  const run: WriteStepRun = {
    workflowId: state.workflowId,
    workflowSha256: state.workflowSha256,
    stepIndex,
    runId,
    trigger: p.trigger,
    queries: state.queries,
    signal: p.signal,
  };
  try {
    const out = await runWriteStep(step, run, p.writeExecutor);
    if (out.status === "error") {
      finish("error", { error: out.message, dispatched: out.dispatched });
      return { kind: "err", label, message: out.message, halt };
    }
    if (out.status === "blocked") {
      finish("blocked", { message: out.message, dispatched: out.dispatched });
      return { kind: "blocked", label, message: out.message };
    }
    finish(out.status, { message: out.message, dispatched: out.dispatched });
    return { kind: "ok", label, reply: out.message, status: out.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finish("error", { error: msg });
    return errorOutcome(label, err, halt);
  }
}

async function executeWorkflowStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: WorkflowStep,
  state: RunState,
): Promise<StepExecOutcome> {
  insertWorkflowRunStepRow(p.db, {
    runId,
    stepIndex,
    label: stepLabelOf(step, stepIndex),
    status: "running",
    startedAt: Date.now(),
  });
  if (step.kind === "run") return executeRunStep(p, runId, stepIndex, step, state.outputs);
  if (step.kind === "query") return executeQueryStep(p, runId, stepIndex, step, state);
  return executeWriteStep(p, runId, stepIndex, step, state);
}

function finalizeRun(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  runId: string,
  status: string,
  startedAt: number,
  errorMsg: string | null,
): void {
  finishWorkflowRunRow(p.db, runId, status, Date.now(), errorMsg);
  emitRunCompletedAudit({
    db: p.db,
    runId,
    workflowName: wf.name,
    status,
    startedAt,
    dryRun: p.dryRun,
    ...(p.paramsOverride !== undefined && { paramsOverride: p.paramsOverride }),
    ...(errorMsg !== null && { errorMsg }),
    ...(p.trigger !== undefined && { trigger: p.trigger }),
  });
  pruneWorkflowRuns(p.db, wf.id, RUN_RETENTION_PER_WORKFLOW);
}

/**
 * Stops the run at `stepIndex`: it is recorded `blocked_on_approval` (never pruned), audited, and the
 * owner is told once. Nothing is dispatched for this or any later step. A notifier that throws
 * cannot undo the block.
 */
function blockRun(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  runId: string,
  startedAt: number,
  blocked: { stepIndex: number; label: string; message: string },
): void {
  blockWorkflowRunRow(p.db, runId, blocked.stepIndex, Date.now(), blocked.message);
  emitRunCompletedAudit({
    db: p.db,
    runId,
    workflowName: wf.name,
    status: "blocked_on_approval",
    startedAt,
    dryRun: false,
    errorMsg: blocked.message,
    ...(p.trigger !== undefined && { trigger: p.trigger }),
  });
  pruneWorkflowRuns(p.db, wf.id, RUN_RETENTION_PER_WORKFLOW);
  try {
    p.onBlocked?.({
      runId,
      workflowName: wf.name,
      stepIndex: blocked.stepIndex,
      stepLabel: blocked.label,
    });
  } catch {
    // The run is already blocked and recorded; a failed notification must not change that.
  }
}

/** On a resumed run, an earlier write or run step is skipped; an earlier query step re-runs. */
function skippedOnResume(p: RunWorkflowExecutionParams, step: WorkflowStep, i: number): boolean {
  return p.resume !== undefined && i < p.resume.blockedStep && step.kind !== "query";
}

/** One step's dry-run entry: a prompt as before; a query or write shown as the declared form. */
function previewStep(
  s: WorkflowStep,
  i: number,
): RunWorkflowExecutionResult["stepResults"][number] {
  const label = stepLabelOf(s, i);
  if (s.kind === "run") {
    return {
      label,
      status: "preview",
      output: s.run,
      hitlActions: previewHitlActionsForStepText(s.run),
    };
  }
  if (s.kind === "query") {
    return { label, status: "preview", output: JSON.stringify(s.query), hitlActions: [] };
  }
  const row = connectorWriteRowByToolId(s.tool);
  return {
    label,
    status: "preview",
    output: `write ${s.tool} ${JSON.stringify(s.input)}`,
    hitlActions: row === undefined ? [] : [row.actionType],
  };
}

function executeDryRun(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  steps: WorkflowStep[],
  runId: string,
  now: number,
  paramsOverrideJson: string | null,
): RunWorkflowExecutionResult {
  insertWorkflowRunRow(p.db, {
    id: runId,
    workflowId: wf.id,
    triggeredBy: p.triggeredBy,
    status: "preview",
    startedAt: now,
    dryRun: true,
    paramsOverrideJson,
  });
  finalizeRun(p, wf, runId, "preview", now, null);
  return {
    runId,
    status: "preview",
    dryRun: true,
    stepResults: steps.map((s, i) => previewStep(s, i)),
  };
}

// A plain `p.signal?.aborted === true` expression, factored out only so
// TypeScript's control-flow narrowing doesn't (wrongly) treat the second
// call site as unreachable: `.aborted` can flip between calls via
// `AbortController.abort()`, but the compiler can't see that through two
// inline copies of the same property read, and a function call boundary is
// what resets its narrowing.
function isAborted(p: RunWorkflowExecutionParams): boolean {
  return p.signal?.aborted === true;
}

// Exported for direct unit testing of the empty-`steps` edge case: the sole
// production caller (`runWorkflowExecution`, via `parseWorkflowStepsJson`)
// currently rejects a workflow with zero executable steps before this ever
// runs, so that path can't be exercised end-to-end through the public RPC —
// but this function's own contract (honour an already-aborted signal) must
// not depend on a caller-side invariant that could change later.
export async function executeRealRunSteps(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  steps: WorkflowStep[],
  runId: string,
  now: number,
): Promise<RunWorkflowExecutionResult> {
  const state: RunState = {
    outputs: [],
    queries: new Map(),
    workflowId: wf.id,
    workflowSha256: workflowStepsSha256(steps),
  };
  const stepResults: RunWorkflowExecutionResult["stepResults"] = [];
  // Checked once up front too: a zero-step workflow never enters the loop
  // below, so without this an already-aborted signal would be ignored and
  // the run would finalise "done" instead of honouring the cancellation.
  if (isAborted(p)) {
    finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled");
    return { runId, status: "cancelled", dryRun: false, stepResults };
  }
  for (let i = 0; i < steps.length; i++) {
    if (isAborted(p)) {
      finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled");
      return { runId, status: "cancelled", dryRun: false, stepResults };
    }
    const step = steps[i];
    if (step === undefined || skippedOnResume(p, step, i)) continue;
    const outcome = await executeWorkflowStep(p, runId, i, step, state);
    if (outcome.kind === "blocked") {
      stepResults.push({ label: outcome.label, status: "blocked", output: outcome.message });
      blockRun(p, wf, runId, now, { stepIndex: i, label: outcome.label, message: outcome.message });
      return { runId, status: "blocked_on_approval", dryRun: false, stepResults };
    }
    if (outcome.kind === "ok") {
      stepResults.push({
        label: outcome.label,
        status: outcome.status ?? "done",
        output: outcome.reply,
      });
      continue;
    }
    stepResults.push({ label: outcome.label, status: "error", error: outcome.message });
    if (outcome.halt) {
      finalizeRun(p, wf, runId, "error", now, outcome.message);
      return { runId, status: "error", dryRun: false, stepResults };
    }
  }
  finalizeRun(p, wf, runId, "done", now, null);
  return { runId, status: "done", dryRun: false, stepResults };
}

/** Only `run` steps take overrides: nothing outside the hashed definition may change a write or a query. */
export function refuseOverridesOfNonRunSteps(
  paramsOverride: RunWorkflowExecutionParams["paramsOverride"],
  steps: readonly WorkflowStep[],
): void {
  if (paramsOverride === undefined) return;
  const fixed = new Set(nonRunStepLabels(steps));
  for (const key of Object.keys(paramsOverride)) {
    if (fixed.has(key)) {
      throw new Error(`paramsOverride may not name a write or query step ("${key}")`);
    }
  }
}

export async function runWorkflowExecution(
  p: RunWorkflowExecutionParams,
): Promise<RunWorkflowExecutionResult> {
  if (readIndexedUserVersion(p.db) < 9) {
    throw new Error("Workflow schema requires v9+");
  }
  const wf = getWorkflowByName(p.db, p.workflowName);
  if (wf === null) {
    throw new Error(`Unknown workflow: ${p.workflowName}`);
  }
  const steps = parseWorkflowSteps(wf.steps_json);
  refuseOverridesOfNonRunSteps(p.paramsOverride, steps);
  if (!p.dryRun && p.agent === undefined && needsModel(steps)) {
    throw new Error(WORKFLOW_NEEDS_MODEL_MESSAGE);
  }
  const runId = randomUUID();
  const now = Date.now();
  const paramsOverrideJson =
    p.paramsOverride === undefined ? null : JSON.stringify(p.paramsOverride);

  if (p.dryRun) {
    return executeDryRun(p, wf, steps, runId, now, paramsOverrideJson);
  }

  const sha256 = workflowStepsSha256(steps);
  // A resume is for the exact definition that blocked: the hash is re-checked here, after the
  // dispatcher's own check, so an edit between the two cannot slip a changed workflow through.
  if (p.resume !== undefined && p.resume.expectedSha256 !== sha256) {
    throw new Error(WORKFLOW_CHANGED_MESSAGE);
  }
  insertWorkflowRunRow(p.db, {
    id: runId,
    workflowId: wf.id,
    triggeredBy: p.triggeredBy,
    status: "running",
    startedAt: now,
    paramsOverrideJson,
    trigger: p.trigger ?? null,
    workflowSha256: sha256,
  });
  // The resumed execution is a NEW run; the blocked one is finished as abandoned, once the new row
  // exists (so a failure to start leaves the blocked run in place).
  if (p.resume !== undefined) abandonWorkflowRunRow(p.db, p.resume.runId, now);

  try {
    const out = await executeRealRunSteps(p, wf, steps, runId, now);
    return p.resume === undefined ? out : { ...out, resumedFrom: p.resume.runId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finalizeRun(p, wf, runId, "error", now, msg);
    throw err;
  }
}
