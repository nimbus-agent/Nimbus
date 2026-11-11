// packages/gateway/src/standing/standing-rule-derive.ts
// Builds a rule from the STORED workflow (Phase 10 SA3, spec § 5.2 and review S3-3): the caller
// names only `{ workflow, step, days?, max?, window? }`; the scope is derived here from the
// workflow's own write step, so a rule can never be wider than the step it names, and a caller can
// never supply a scope, a hash, a tool or an action type. Pure but for the read of the workflow.
import type { Database } from "bun:sqlite";
import {
  parseWorkflowSteps,
  type WorkflowStep,
  type WriteWorkflowStep,
  workflowStepsSha256,
} from "../automation/workflow-steps.ts";
import { getWorkflowByName } from "../automation/workflow-store.ts";
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import { MODEL_NEVER_OFFERED_TOOL_IDS } from "../connectors/connector-writes/model-offerable.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import {
  parseDays,
  parseMaxActions,
  parseWindow,
  type RuleTextInput,
  StandingRuleError,
} from "./standing-rule-text.ts";
import {
  DAY_MS,
  type NewStandingRule,
  type ScopeEntry,
  type StandingScope,
} from "./standing-rule-types.ts";

/** What a caller may say when it asks for a rule. Nothing else is read. */
export type CreateRuleRequest = {
  readonly workflow: string;
  /** The step's label or its 1-based number. */
  readonly step: string | number;
  readonly days?: unknown;
  readonly max?: unknown;
  readonly window?: unknown;
};

/** The eligibility of a connector write row for a standing rule (OR-10-1), as a reason or `undefined`. */
export function ineligibleReason(
  row: ConnectorWriteRow | undefined,
  frozenHitl: boolean,
): string | undefined {
  if (row === undefined) return "that is not a connector write";
  if (row.wave !== 2 && row.wave !== 3) {
    return `a wave ${String(row.wave)} write always asks you`;
  }
  if (MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)) return "that write is never run automatically";
  if (row.bound !== undefined) return "a bound write always asks you";
  if (row.confirm !== undefined) return "a write that needs typed confirmation always asks you";
  if (row.refuse !== undefined) return "that write is refused";
  if (!frozenHitl) return "that write does not require approval by itself";
  return undefined;
}

function stepLabelOf(step: WorkflowStep, index: number): string {
  return step.label ?? `step-${String(index + 1)}`;
}

function findWriteStep(
  steps: readonly WorkflowStep[],
  want: string | number,
): { step: WriteWorkflowStep; index: number } {
  let index = -1;
  if (typeof want === "number") {
    index = want - 1;
  } else if (/^\d+$/.test(want)) {
    const byNumber = Number(want) - 1;
    const byLabel = steps.findIndex((s, i) => stepLabelOf(s, i) === want);
    index = byLabel !== -1 ? byLabel : byNumber;
  } else {
    index = steps.findIndex((s, i) => stepLabelOf(s, i) === want);
  }
  const step = steps[index];
  if (step === undefined) throw new StandingRuleError("the workflow has no such step");
  if (step.kind !== "write") {
    throw new StandingRuleError("a standing rule can name only a write step");
  }
  return { step, index };
}

/** The scope of a write step: its constants and its declared-query references, as the step wrote them. */
export function scopeOfStep(
  step: WriteWorkflowStep,
  steps: readonly WorkflowStep[],
): StandingScope {
  const out: Record<string, ScopeEntry> = {};
  for (const [field, v] of Object.entries(step.input)) {
    if ("from" in v) {
      const at = steps.findIndex((s) => s.kind === "query" && s.label === v.from);
      out[field] = { query: at, column: v.column };
    } else {
      out[field] = { const: v.const };
    }
  }
  return out;
}

export type DerivedRule = {
  readonly rule: Omit<NewStandingRule, "approvalAuditId">;
  /** The inputs of the approval text. */
  readonly text: RuleTextInput;
};

/**
 * Derives the rule a request names, from the stored workflow. Throws {@link StandingRuleError} with
 * a fixed message when the workflow, the step, the write or a limit is not acceptable.
 */
export function deriveRule(
  db: Database,
  req: CreateRuleRequest,
  frozenHitl: (actionType: string) => boolean,
  now: number,
): DerivedRule {
  const wf = getWorkflowByName(db, req.workflow);
  if (wf === null) throw new StandingRuleError("no such workflow");
  let steps: WorkflowStep[];
  try {
    steps = parseWorkflowSteps(wf.steps_json);
  } catch {
    throw new StandingRuleError("the stored workflow does not parse");
  }
  const { step, index } = findWriteStep(steps, req.step);
  const row = connectorWriteRowByToolId(step.tool);
  const why = ineligibleReason(row, row === undefined ? false : frozenHitl(row.actionType));
  if (row === undefined || why !== undefined) {
    throw new StandingRuleError(`that step cannot have a standing rule: ${why ?? "unknown write"}`);
  }
  const days = parseDays(req.days);
  const maxActions = parseMaxActions(req.max);
  const window = parseWindow(req.window);
  const scope = scopeOfStep(step, steps);
  const workflowSha256 = workflowStepsSha256(steps);
  const expiresAt = now + days * DAY_MS;
  return {
    rule: {
      createdAt: now,
      workflowId: wf.id,
      workflowSha256,
      stepIndex: index,
      actionType: row.actionType,
      toolId: row.toolId,
      scope,
      window,
      expiresAt,
      maxActions,
    },
    text: {
      workflowName: wf.name,
      workflowSha256,
      stepIndex: index,
      stepLabel: stepLabelOf(step, index),
      toolId: row.toolId,
      actionType: row.actionType,
      scope,
      window,
      expiresAt,
      maxActions,
    },
  };
}
