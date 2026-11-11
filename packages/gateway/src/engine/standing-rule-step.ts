// packages/gateway/src/engine/standing-rule-step.ts
// I55, the standing-approval taint barrier (Phase 10 SA3, spec § 5.3, static D44(c)).
//
// `standingRuleStep` runs inside the executor's `approvalPhase`, after the before-state, preflight,
// prepare and confirm phases, and before a delegate or the owner is asked. It returns the rule that
// approves THIS action, or `undefined` ("no rule applies") and the owner's prompt follows exactly
// as it always did. It is nine named steps invoked in sequence; the order below IS the design
// (CLAUDE.md, the I35 lesson): the first failing step ends the check.
//
//   1. `policyStep`      the org policy has not locked standing approvals off (absent = off);
//   2. `provenanceStep`  a gateway-set owner-workflow provenance, a trigger the gateway derived
//                        (schedule, owner_cli, owner_ui), and no `origin: "model"`;
//   3. `eligibleRowsStep` the action TYPE names only wave 2 or 3 connector writes that are not
//                        bound, typed-confirm, refused or never-offered, and is HITL by the frozen set;
//   4. `toolStep`        the payload's `mcpToolId` names one of that type's own tools, and nothing
//                        rides along;
//   5. `accountedStep`   every input field has a constant or declared-query source, none is extra;
//   6. `ruleStep`        a live rule for this workflow id, hash, step, type and tool, inside its window;
//   7. `scopeStep`       the rule's scope equals the action's field sources, constants equal;
//   8. `doorRefusalStep` the shared door refusals pass on the actual input;
//   9. `claimStep`       the rule's counter is claimed atomically with the fire record.
//
// Nothing here writes anything but the fire (through the store's `claimFire`, which is also the
// ceiling). Every dependency is injected, so a test drives each clause alone.
import type { Database } from "bun:sqlite";

import { canonicalJson } from "../automation/workflow-steps.ts";
import { MODEL_NEVER_OFFERED_TOOL_IDS } from "../connectors/connector-writes/model-offerable.ts";
import { rowNamedByToolId } from "../connectors/connector-writes/preview.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import {
  claimFire,
  listRulesFor,
  ruleState,
  scopeSha256,
} from "../standing/standing-rule-store.ts";
import { isInsideWindow } from "../standing/standing-rule-text.ts";
import type { StandingRule } from "../standing/standing-rule-types.ts";
import type { PlannedAction, WorkflowProvenance } from "./types.ts";

/** What the executor hands the check (`ToolExecutorExtras.standingRules`). Only the workflow write executor has it. */
export interface StandingRuleDeps {
  readonly db: Database;
  /** Whether org policy leaves standing approvals on. A throw, or an absent policy, reads as off. */
  readonly policyAllows: () => boolean;
  /**
   * The shared door refusals on the actual input (`modelWriteRefusal`: a ChatOps channel, a
   * broadcast mention, remote content, the knowledge base, a null optional field, a calendar time
   * with no zone). A string means "refused"; a throw reads as refused (fail closed).
   */
  readonly refusal: (
    toolId: string,
    input: Readonly<Record<string, unknown>>,
  ) => string | undefined;
  /** The clock; tests inject one. */
  readonly now?: () => number;
}

/** What the executor gives the check about the gate it is in. */
export interface StandingRuleContext {
  readonly deps: StandingRuleDeps;
  /** The executor's write table (production: `CONNECTOR_WRITE_ROWS`). */
  readonly rows: readonly ConnectorWriteRow[];
  /** Whether the action type is in the frozen HITL set (not HITL only by an org policy `require`). */
  readonly frozenHitl: boolean;
}

/** The rule that approved the action, and the fire that recorded it. */
export interface StandingMatch {
  readonly ruleId: string;
  readonly fireId: string;
  readonly matchedScopeSha256: string;
}

/** The only triggers that can match a rule (OR-10-2); `schedule` is produced from SA4. */
const MATCHING_TRIGGERS: ReadonlySet<string> = new Set(["schedule", "owner_cli", "owner_ui"]);

type PlainRecord = Readonly<Record<string, unknown>>;

function isPlainRecord(v: unknown): v is PlainRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Step 1. Fail closed: an accessor that throws is "locked off". */
function policyStep(deps: StandingRuleDeps): boolean {
  try {
    return deps.policyAllows();
  } catch {
    return false;
  }
}

/** Step 2. The provenance is gateway-set (top level only); a model action never matches. */
function provenanceStep(action: PlannedAction): WorkflowProvenance | undefined {
  const p = action.provenance;
  if (p?.kind !== "owner_workflow") return undefined;
  if (!MATCHING_TRIGGERS.has(p.trigger)) return undefined;
  if (action.origin !== undefined) return undefined;
  return p;
}

/** Whether one write row may ever be approved by a standing rule (OR-10-1). */
function rowIsEligible(row: ConnectorWriteRow): boolean {
  if (row.wave !== 2 && row.wave !== 3) return false;
  if (MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)) return false;
  return row.bound === undefined && row.confirm === undefined && row.refuse === undefined;
}

/**
 * Step 3. Found by action TYPE alone (I3): EVERY write row of the type must be eligible (a type
 * shared by two rows is judged by both, so the payload can never pick the laxer one), and the type
 * must be HITL by the frozen set itself, not only by an org policy's `require`.
 */
function eligibleRowsStep(
  action: PlannedAction,
  rows: readonly ConnectorWriteRow[],
  frozenHitl: boolean,
): readonly ConnectorWriteRow[] | undefined {
  if (!frozenHitl) return undefined;
  const ofType = rows.filter((r) => r.actionType === action.type);
  if (ofType.length === 0 || !ofType.every(rowIsEligible)) return undefined;
  return ofType;
}

/**
 * Step 4. The payload names one of the type's own tools (never another row's), and carries only
 * `mcpToolId` and `input`. Returns the named row and the dispatched input.
 */
function toolStep(
  action: PlannedAction,
  ofType: readonly ConnectorWriteRow[],
  rows: readonly ConnectorWriteRow[],
): { readonly row: ConnectorWriteRow; readonly input: PlainRecord } | undefined {
  const payload = action.payload;
  if (payload === undefined) return undefined;
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== "input" || keys[1] !== "mcpToolId") return undefined;
  const named = payload["mcpToolId"];
  if (typeof named !== "string") return undefined;
  const row = rowNamedByToolId(named, rows);
  if (row === undefined || !ofType.includes(row)) return undefined;
  const input = payload["input"];
  return isPlainRecord(input) ? { row, input } : undefined;
}

/** Step 5. Every dispatched field has a constant or declared-query source; none is unaccounted for. */
function accountedStep(input: PlainRecord, p: WorkflowProvenance): boolean {
  const fields = Object.keys(input);
  const sources = Object.keys(p.fieldSources);
  if (fields.length !== sources.length) return false;
  for (const f of fields) {
    if (!Object.hasOwn(p.fieldSources, f)) return false;
    const s = p.fieldSources[f];
    if (s === "constant") continue;
    if (s === undefined || typeof s !== "object" || !Number.isInteger(s.query) || s.query < 0) {
      return false;
    }
    if (typeof s.column !== "string" || s.column === "") return false;
  }
  return true;
}

/** The rule's scope against the action's sources and values (step 7), for one candidate rule. */
function scopeMatches(rule: StandingRule, input: PlainRecord, p: WorkflowProvenance): boolean {
  const fields = Object.keys(rule.scope);
  if (fields.length !== Object.keys(p.fieldSources).length) return false;
  for (const field of fields) {
    const entry = rule.scope[field];
    const source = Object.hasOwn(p.fieldSources, field) ? p.fieldSources[field] : undefined;
    if (entry === undefined || source === undefined || !Object.hasOwn(input, field)) return false;
    if ("const" in entry) {
      if (source !== "constant") return false;
      if (canonicalJson(entry.const) !== canonicalJson(input[field])) return false;
    } else if (
      source === "constant" ||
      source.query !== entry.query ||
      source.column !== entry.column
    ) {
      return false;
    }
  }
  return true;
}

/** Step 6. The live rules for exactly this workflow, hash, step, type and tool, inside their window. */
function ruleStep(
  deps: StandingRuleDeps,
  p: WorkflowProvenance,
  row: ConnectorWriteRow,
  now: number,
): StandingRule[] {
  return listRulesFor(deps.db, {
    workflowId: p.workflowId,
    workflowSha256: p.workflowSha256,
    stepIndex: p.stepIndex,
    actionType: row.actionType,
    toolId: row.toolId,
  }).filter(
    (r) =>
      ruleState(r, now) === "live" && (r.window === undefined || isInsideWindow(r.window, now)),
  );
}

/** Step 7. Keeps the candidates whose scope is the action's own sources, constants equal. */
function scopeStep(
  candidates: readonly StandingRule[],
  input: PlainRecord,
  p: WorkflowProvenance,
): StandingRule[] {
  return candidates.filter((r) => scopeMatches(r, input, p));
}

/** Step 8. A refusal (or a refusal check that throws) means no rule applies. */
function doorRefusalStep(deps: StandingRuleDeps, toolId: string, input: PlainRecord): boolean {
  try {
    return deps.refusal(toolId, input) === undefined;
  } catch {
    return false;
  }
}

/** Step 9. The atomic claim: the first candidate whose counter still has an action to give. */
function claimStep(
  deps: StandingRuleDeps,
  candidates: readonly StandingRule[],
  actionType: string,
  now: number,
): StandingMatch | undefined {
  for (const rule of candidates) {
    const matchedScopeSha256 = scopeSha256(rule.scope);
    const fireId = claimFire(deps.db, rule.id, now, actionType, matchedScopeSha256);
    if (fireId !== undefined) return { ruleId: rule.id, fireId, matchedScopeSha256 };
  }
  return undefined;
}

/**
 * The I55 check. Returns the rule that approves this action (and the fire that recorded it), or
 * `undefined`: no rule applies, ask the owner. Synchronous end to end: no await between the claim
 * and the caller recording the audit row, which is what keeps a "claimed" fire from being followed
 * by anything but that row.
 */
export function standingRuleStep(
  action: PlannedAction,
  ctx: StandingRuleContext,
): StandingMatch | undefined {
  const { deps } = ctx;
  if (!policyStep(deps)) return undefined; // 1
  const provenance = provenanceStep(action); // 2
  if (provenance === undefined) return undefined;
  const ofType = eligibleRowsStep(action, ctx.rows, ctx.frozenHitl); // 3
  if (ofType === undefined) return undefined;
  const named = toolStep(action, ofType, ctx.rows); // 4
  if (named === undefined) return undefined;
  const { row, input } = named;
  if (!accountedStep(input, provenance)) return undefined; // 5
  const now = (deps.now ?? Date.now)();
  const live = ruleStep(deps, provenance, row, now); // 6
  const matching = scopeStep(live, input, provenance); // 7
  if (matching.length === 0) return undefined;
  if (!doorRefusalStep(deps, row.toolId, input)) return undefined; // 8
  return claimStep(deps, matching, action.type, now); // 9
}
