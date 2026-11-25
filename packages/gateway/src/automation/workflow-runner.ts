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
import { type LearningConfig, learnFromStepRun } from "../standing/approval-learning.ts";
import { type DeclaredQueryResult, runDeclaredQuery } from "./declared-query.ts";
import {
  observeGuardQueries,
  previewStep,
  stepLabelOf,
  type WorkflowStepResult,
} from "./workflow-dry-run.ts";
import {
  evaluateGuard,
  type GuardEvaluation,
  guardRequiresPresence,
  guardText,
  observationText,
  type QueryCount,
} from "./workflow-guard.ts";
import { pruneWorkflowRuns } from "./workflow-run-history.ts";
import {
  type DeclaredQuery,
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
  /**
   * Approval learning (Phase 10 SA5): after an owner-started run finishes a write step, the pass
   * reads that run's audit rows and may record a standing-rule suggestion. Built by the gateway
   * from the live policy, the config and the demo flag; absent means off, so no caller learns
   * anything unless it says so. A throw is caught: learning never fails or changes a run.
   */
  readonly learning?: LearningConfig;
  /** Test seam: runs a declared query (production: `runDeclaredQuery`). Used by steps and the dry run. */
  readonly queryRunner?: (db: Database, q: DeclaredQuery) => DeclaredQueryResult;
};

export type RunWorkflowExecutionResult = {
  runId: string;
  /** The blocked run this one resumed (SA4). */
  resumedFrom?: string;
  /**
   * The run's terminal status: "preview" | "done" | "error" | "cancelled" | "blocked_on_approval" |
   * "condition_lapsed" (a resumed run whose blocked step's `when` no longer holds: it stopped there).
   * Mirrors what finalizeRun wrote to workflow_run — an IPC caller cannot read
   * that table, so a cancelled run would otherwise be indistinguishable from a
   * short one that completed.
   */
  status: string;
  dryRun: boolean;
  stepResults: WorkflowStepResult[];
};

type StepExecOutcome =
  | { kind: "ok"; label: string; reply: string; status?: string }
  | { kind: "err"; label: string; message: string; halt: boolean }
  | { kind: "blocked"; label: string; message: string }
  /** The step's `when` did not hold: nothing ran, nothing was asked, the run goes on. */
  | { kind: "not_taken"; label: string; message: string; guard: string };

/** What the steps of one run share: the outputs of `run` steps and the query results. */
type RunState = {
  readonly outputs: string[];
  readonly queries: Map<string, QueryCount>;
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly workflowName: string;
  readonly startedAt: number;
};

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
    const r = (p.queryRunner ?? runDeclaredQuery)(p.db, step.query);
    // `rows >= limit`: the SELECT hit its limit, so the count is only a lower bound (D1).
    state.queries.set(step.label, {
      index: stepIndex,
      values: r.values,
      capped: r.rows >= step.query.limit,
    });
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
  guard: GuardEvaluation | undefined,
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
    ...(guard !== undefined && { guard }),
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
  if (step.kind === "query") return executeQueryStep(p, runId, stepIndex, step, state);
  // The guard is decided HERE, before anything is built: a step that is not taken never reaches the
  // model, the executor, the standing-rule check or the learner (I55: a guard only removes runs).
  const decided = decideGuard(p, runId, stepIndex, step, state);
  if (decided.kind === "outcome") return decided.outcome;
  if (step.kind === "run") return executeRunStep(p, runId, stepIndex, step, state.outputs);
  const outcome = await executeWriteStep(p, runId, stepIndex, step, state, decided.evaluation);
  learnAfterWriteStep(p, runId, stepIndex, step, state);
  return outcome;
}

/** The step's guard: proceed (with the evaluation to record), or an outcome that ends the step. */
function decideGuard(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: RunWorkflowStep | WriteWorkflowStep,
  state: RunState,
):
  | { kind: "proceed"; evaluation: GuardEvaluation | undefined }
  | { kind: "outcome"; outcome: StepExecOutcome } {
  if (step.when === undefined) return { kind: "proceed", evaluation: undefined };
  const label = stepLabelOf(step, stepIndex);
  let evaluation: GuardEvaluation;
  try {
    evaluation = evaluateGuard(step.when, state.queries);
  } catch (err) {
    // Fail closed: a guard that cannot be evaluated never lets the step run.
    const msg = err instanceof Error ? err.message : String(err);
    updateWorkflowRunStepRow(p.db, runId, stepIndex, {
      status: "error",
      resultJson: JSON.stringify({ error: msg }),
      finishedAt: Date.now(),
    });
    return { kind: "outcome", outcome: errorOutcome(label, err, true) };
  }
  if (evaluation.holds) return { kind: "proceed", evaluation };
  const guard = guardText(step.when);
  const labels = step.when.map((g) => g.count);
  const observed = evaluation.observed.map((o, i) => ({
    query: labels[i],
    count: o.observed,
    capped: o.capped,
    holds: o.holds,
  }));
  updateWorkflowRunStepRow(p.db, runId, stepIndex, {
    status: "not_taken",
    resultJson: JSON.stringify({ guard, observed }),
    finishedAt: Date.now(),
  });
  const counts = evaluation.observed.map((o) => observationText(o)).join(", ");
  return {
    kind: "outcome",
    outcome: { kind: "not_taken", label, message: `${guard}: selected ${counts}`, guard },
  };
}

/** Approval learning after a write step, whatever its status. It can never fail or change the run. */
function learnAfterWriteStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: WriteWorkflowStep,
  state: RunState,
): void {
  const actionType = connectorWriteRowByToolId(step.tool)?.actionType;
  if (p.learning === undefined || p.dryRun || actionType === undefined) return;
  try {
    learnFromStepRun(
      p.db,
      {
        runId,
        stepIndex,
        workflowId: state.workflowId,
        workflowSha256: state.workflowSha256,
        workflowName: state.workflowName,
        stepLabel: stepLabelOf(step, stepIndex),
        ruleEligibleGuard: guardRequiresPresence(step.when),
        actionType,
        trigger: p.trigger,
        startedAt: state.startedAt,
      },
      p.learning,
    );
  } catch (err) {
    reportLearningFailure(p.learning, err);
  }
}

/** Reports a failed learning pass. A logger that itself throws is swallowed: learning never fails a run. */
function reportLearningFailure(learning: LearningConfig, err: unknown): void {
  try {
    learning.log?.(
      {
        event: "standing.learning.failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "approval learning failed; the run is unaffected",
    );
  } catch {
    /* the diagnostic is best effort; the run's outcome stands */
  }
}

function finalizeRun(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  runId: string,
  status: string,
  startedAt: number,
  errorMsg: string | null,
  stepsNotTaken = 0,
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
    ...(stepsNotTaken > 0 && { stepsNotTaken }),
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
  const observed = observeGuardQueries(p, steps);
  return {
    runId,
    status: "preview",
    dryRun: true,
    stepResults: steps.map((s, i) => previewStep(s, i, observed)),
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
    workflowName: wf.name,
    startedAt: now,
  };
  const run: RunLoop = { p, wf, runId, now, stepResults: [], notTaken: 0 };
  const { stepResults } = run;
  // Checked once up front too: a zero-step workflow never enters the loop
  // below, so without this an already-aborted signal would be ignored and
  // the run would finalise "done" instead of honouring the cancellation.
  if (isAborted(p)) {
    finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled");
    return { runId, status: "cancelled", dryRun: false, stepResults };
  }
  for (let i = 0; i < steps.length; i++) {
    if (isAborted(p)) {
      finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled", run.notTaken);
      return { runId, status: "cancelled", dryRun: false, stepResults };
    }
    const step = steps[i];
    if (step === undefined || skippedOnResume(p, step, i)) continue;
    const stop = settleStepOutcome(run, i, await executeWorkflowStep(p, runId, i, step, state));
    if (stop !== undefined) return { runId, status: stop, dryRun: false, stepResults };
  }
  finalizeRun(p, wf, runId, "done", now, null, run.notTaken);
  return { runId, status: "done", dryRun: false, stepResults };
}

type RunLoop = {
  readonly p: RunWorkflowExecutionParams;
  readonly wf: { id: string; name: string };
  readonly runId: string;
  readonly now: number;
  readonly stepResults: RunWorkflowExecutionResult["stepResults"];
  notTaken: number;
};

/** Records one step's outcome; returns the run's final status when that outcome ends the run. */
function settleStepOutcome(
  run: RunLoop,
  i: number,
  outcome: StepExecOutcome,
): RunWorkflowExecutionResult["status"] | undefined {
  const { p, wf, runId, now, stepResults } = run;
  const label = outcome.label;
  switch (outcome.kind) {
    case "blocked":
      stepResults.push({ label, status: "blocked", output: outcome.message });
      blockRun(p, wf, runId, now, { stepIndex: i, label, message: outcome.message });
      return "blocked_on_approval";
    case "not_taken": {
      run.notTaken++;
      stepResults.push({
        label,
        status: "not_taken",
        output: outcome.message,
        guard: outcome.guard,
      });
      // A resume was asked to answer a prompt for THIS step. If its condition no longer holds on
      // the fresh counts, stop: later steps would run on data the owner never saw.
      if (p.resume?.blockedStep !== i) return undefined;
      const message = lapsedMessage(outcome);
      stepResults.push({ label, status: "condition_lapsed", output: message });
      finalizeRun(p, wf, runId, "condition_lapsed", now, message, run.notTaken);
      return "condition_lapsed";
    }
    case "ok":
      stepResults.push({ label, status: outcome.status ?? "done", output: outcome.reply });
      return undefined;
    case "err":
      stepResults.push({ label, status: "error", error: outcome.message });
      if (!outcome.halt) return undefined;
      finalizeRun(p, wf, runId, "error", now, outcome.message, run.notTaken);
      return "error";
  }
}

/** The fixed text of a resumed run that stopped because the blocked step's condition lapsed. */
function lapsedMessage(outcome: { message: string }): string {
  return `the condition no longer holds (${outcome.message}); nothing was done for this step and the steps after it were not run; run the workflow again to evaluate it fresh`;
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
