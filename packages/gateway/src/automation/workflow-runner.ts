import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import { formatAuditPayload } from "../audit/format-audit-payload.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import {
  type RunConversationalAgentParams,
  runConversationalAgent,
} from "../engine/run-conversational-agent.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { previewHitlActionsForStepText } from "./workflow-hitl-preview.ts";
import { pruneWorkflowRuns } from "./workflow-run-history.ts";
import {
  finishWorkflowRunRow,
  getWorkflowByName,
  insertWorkflowRunRow,
  insertWorkflowRunStepRow,
  updateWorkflowRunStepRow,
} from "./workflow-store.ts";

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
}): void {
  const durationMs = Date.now() - params.startedAt;
  const details: Record<string, unknown> = {
    runId: params.runId,
    workflowName: params.workflowName,
    status: params.status,
    durationMs,
    dryRun: params.dryRun,
  };
  if (params.paramsOverride !== undefined) {
    details["paramsOverride"] = params.paramsOverride;
  }
  if (params.errorMsg !== undefined && params.errorMsg !== null) {
    details["errorMsg"] = params.errorMsg;
  }
  appendAuditEntry(params.db, {
    actionType: "workflow.run.completed",
    hitlStatus: "not_required",
    actionJson: formatAuditPayload(details),
    timestamp: Date.now(),
  });
}

export type WorkflowStep = {
  label?: string;
  run: string;
  continueOnError?: boolean;
};

function parseOneWorkflowStepRow(row: unknown): WorkflowStep | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const rec = row as Record<string, unknown>;
  const run = typeof rec["run"] === "string" ? rec["run"].trim() : "";
  if (run === "") {
    return null;
  }
  const label = typeof rec["label"] === "string" ? rec["label"].trim() : undefined;
  const continueOnError = rec["continueOnError"] === true || rec["continue_on_error"] === true;
  const step: WorkflowStep = { run };
  if (label !== undefined && label !== "") {
    step.label = label;
  }
  if (continueOnError) {
    step.continueOnError = true;
  }
  return step;
}

export function parseWorkflowStepsJson(stepsJson: string): WorkflowStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stepsJson) as unknown;
  } catch {
    throw new Error("workflow steps_json is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("workflow steps must be a JSON array");
  }
  const out: WorkflowStep[] = [];
  for (const row of parsed) {
    const step = parseOneWorkflowStepRow(row);
    if (step !== null) {
      out.push(step);
    }
  }
  if (out.length === 0) {
    throw new Error("workflow has no executable steps (need objects with non-empty run string)");
  }
  return out;
}

export type RunWorkflowExecutionParams = {
  db: Database;
  agent: Agent;
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
};

export type RunWorkflowExecutionResult = {
  runId: string;
  /**
   * The run's terminal status: "preview" | "done" | "error" | "cancelled".
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
  | { kind: "ok"; label: string; reply: string }
  | { kind: "err"; label: string; message: string; halt: boolean };

async function executeWorkflowStep(
  p: RunWorkflowExecutionParams,
  runId: string,
  stepIndex: number,
  step: WorkflowStep,
  outputs: string[],
): Promise<StepExecOutcome> {
  const label = step.label ?? `step-${String(stepIndex + 1)}`;
  const stepStart = Date.now();
  insertWorkflowRunStepRow(p.db, {
    runId,
    stepIndex,
    label,
    status: "running",
    startedAt: stepStart,
  });

  const prior =
    outputs.length > 0
      ? `Prior step outputs (summarize, do not repeat verbatim):\n${outputs.join("\n---\n")}\n\n`
      : "";
  const prompt = `${prior}Workflow step ${String(stepIndex + 1)} (${label}):\n${step.run}`;

  if (p.stream) {
    p.sendChunk(`\n— Step ${String(stepIndex + 1)}: ${label} —\n`);
  }

  try {
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
    return { kind: "err", label, message: msg, halt: step.continueOnError !== true };
  }
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
  });
  pruneWorkflowRuns(p.db, wf.id, RUN_RETENTION_PER_WORKFLOW);
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
    stepResults: steps.map((s, i) => ({
      label: s.label ?? `step-${String(i + 1)}`,
      status: "preview",
      output: s.run,
      hitlActions: previewHitlActionsForStepText(s.run),
    })),
  };
}

async function executeRealRunSteps(
  p: RunWorkflowExecutionParams,
  wf: { id: string; name: string },
  steps: WorkflowStep[],
  runId: string,
  now: number,
): Promise<RunWorkflowExecutionResult> {
  const outputs: string[] = [];
  const stepResults: RunWorkflowExecutionResult["stepResults"] = [];
  for (let i = 0; i < steps.length; i++) {
    if (p.signal?.aborted === true) {
      finalizeRun(p, wf, runId, "cancelled", now, "Run cancelled");
      return { runId, status: "cancelled", dryRun: false, stepResults };
    }
    const step = steps[i];
    if (step === undefined) continue;
    const outcome = await executeWorkflowStep(p, runId, i, step, outputs);
    if (outcome.kind === "ok") {
      stepResults.push({ label: outcome.label, status: "done", output: outcome.reply });
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
  const steps = parseWorkflowStepsJson(wf.steps_json);
  const runId = randomUUID();
  const now = Date.now();
  const paramsOverrideJson =
    p.paramsOverride === undefined ? null : JSON.stringify(p.paramsOverride);

  if (p.dryRun) {
    return executeDryRun(p, wf, steps, runId, now, paramsOverrideJson);
  }

  insertWorkflowRunRow(p.db, {
    id: runId,
    workflowId: wf.id,
    triggeredBy: p.triggeredBy,
    status: "running",
    startedAt: now,
    paramsOverrideJson,
  });

  try {
    return await executeRealRunSteps(p, wf, steps, runId, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finalizeRun(p, wf, runId, "error", now, msg);
    throw err;
  }
}
