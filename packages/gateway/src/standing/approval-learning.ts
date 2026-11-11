// packages/gateway/src/standing/approval-learning.ts
// Approval learning (Phase 10 SA5, spec § 6.4, owner rulings OR-10-4, OR-10-9, OR-10-10).
//
// After an owner-started run finishes a write step, `learnFromStepRun` reads the audit rows that
// run wrote for that step and updates the step's streak. After `[standing] suggest_after` runs in a
// row in which the owner answered every prompt of the step BY HAND and approved, it records a
// suggestion. It adds no executor seam and no consent-channel change: it can only see what the gate
// itself recorded. It never creates, widens or approves a rule; accepting a suggestion is the same
// `standing.rule.create` owner approval as any rule (the RPC handler, not this file).
//
// What a run of one step does to its streak (OR-10-9, the unit is one RUN of one step):
//   - counts   the owner was asked for at least one of its actions and EVERY asked action was
//              approved with `answerSource: "human"`;
//   - resets   an asked action was rejected with `answerSource: "human"` (the owner said no);
//   - no change anything else: `--yes` (`auto`), a script, `unknown`, a delegate, a remote answer,
//              a guard or door refusal with no answer, a standing-approved action, a run with no
//              asked action, and any run whose audit rows cannot all be read (below).
//
// A row of the step's action type in the run's window that does not parse (the audit payload's
// 4 KiB cap cuts the serialized string, so a capped row never parses) cannot be attributed to a run:
// the run of that step is "no change". A step whose payloads exceed the cap therefore never earns a
// suggestion (a stated bound); it can never earn a wrong one. The verdict is the `hitl_status`
// COLUMN; the JSON is parsed in TypeScript (never `json_extract`, which raises on malformed JSON).
import type { Database } from "bun:sqlite";

import { parseWorkflowSteps, workflowStepsSha256 } from "../automation/workflow-steps.ts";
import type { WorkflowTrigger } from "../engine/types.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { hasLiveRuleFor } from "./standing-rule-store.ts";
import {
  applyStepRun,
  markStaleFor,
  openSuggestion,
  type StepKey,
  type StepRunVerdict,
} from "./standing-suggestion-store.ts";

/** The facts of the finished step the pass needs. `actionType` is the step's connector write type. */
export type LearningStepRun = StepKey & {
  readonly runId: string;
  readonly actionType: string;
  /** For the log line only. */
  readonly workflowName: string;
  readonly stepLabel: string;
  readonly trigger: WorkflowTrigger | undefined;
  /** When the run started: audit rows older than this are not the run's. */
  readonly startedAt: number;
};

/** Built per run by the gateway from the live policy, the config and the demo flag. */
export type LearningConfig = {
  /** False on a demo-rooted gateway, when policy locks standing approvals off, or when policy cannot be read. */
  readonly enabled: () => boolean;
  /** `[standing] suggest_after`; `0` turns learning off. */
  readonly suggestAfter: () => number;
  readonly now?: () => number;
  /** Test seam: the workflow's current content hash; absent reads the stored workflow. */
  readonly currentSha?: (workflowId: string) => string | undefined;
  /** Receives the one `info` line a new suggestion logs (workflow, step, streak; no payload values). */
  readonly log?: (fields: Record<string, unknown>, message: string) => void;
};

export type LearningResult =
  | { readonly kind: "off" }
  /** The workflow was edited since this run started: the run teaches nothing about the new content. */
  | { readonly kind: "superseded" }
  | {
      readonly kind: "learned";
      readonly verdict: StepRunVerdict;
      readonly streak: number;
      readonly suggestionId?: string;
    };

type AuditRow = { readonly hitl_status: string; readonly action_json: string };

/** The part of one audit row this pass reads, or why the row cannot be attributed. */
type ParsedRow =
  | { readonly kind: "unreadable" }
  | { readonly kind: "foreign" }
  | { readonly kind: "ours"; readonly status: string; readonly answerSource: unknown };

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether this audit row is this run's action of this step, by its recorded provenance. */
function parseRow(row: AuditRow, run: LearningStepRun): ParsedRow {
  const root = asRecord(parseJson(row.action_json));
  const action = asRecord(root?.["action"]);
  if (root === undefined || action === undefined) return { kind: "unreadable" };
  const prov = asRecord(action["provenance"]);
  const mine =
    prov !== undefined &&
    prov["kind"] === "owner_workflow" &&
    prov["runId"] === run.runId &&
    prov["stepIndex"] === run.stepIndex &&
    prov["workflowId"] === run.workflowId &&
    typeof prov["workflowSha256"] === "string" &&
    sha256HexEqualConstantTime(prov["workflowSha256"], run.workflowSha256);
  if (!mine) return { kind: "foreign" };
  return { kind: "ours", status: row.hitl_status, answerSource: root["answerSource"] };
}

/** What a run of the step does to its streak, from the audit rows of its action type in the window. */
export function classifyStepRun(rows: readonly AuditRow[], run: LearningStepRun): StepRunVerdict {
  const parsed = rows.map((r) => parseRow(r, run));
  if (parsed.some((p) => p.kind === "unreadable")) return "no_change";
  let asked = 0;
  let allHumanApproved = true;
  for (const p of parsed) {
    // A row not asked of a person (a standing approval, a guard or door refusal that carries no
    // answer source) is not an answer and changes nothing.
    if (p.kind !== "ours" || (p.status !== "approved" && p.status !== "rejected")) continue;
    if (p.answerSource === undefined || p.answerSource === "none") continue;
    asked += 1;
    if (p.answerSource !== "human") {
      allHumanApproved = false;
    } else if (p.status === "rejected") {
      return "resets";
    }
  }
  return asked > 0 && allHumanApproved ? "counts" : "no_change";
}

function readRows(db: Database, run: LearningStepRun): AuditRow[] {
  return db
    .query(
      "SELECT hitl_status, action_json FROM audit_log WHERE action_type = ? AND timestamp >= ? ORDER BY id",
    )
    .all(run.actionType, run.startedAt) as AuditRow[];
}

/** The stored workflow's current content hash, or `undefined` when it is gone or does not parse. */
function currentWorkflowSha(db: Database, workflowId: string): string | undefined {
  const row = db.query("SELECT steps_json FROM workflow WHERE id = ?").get(workflowId) as {
    steps_json: string;
  } | null;
  if (row === null) return undefined;
  try {
    return workflowStepsSha256(parseWorkflowSteps(row.steps_json));
  } catch {
    return undefined;
  }
}

function isOwnerStarted(trigger: WorkflowTrigger | undefined): boolean {
  return trigger === "owner_cli" || trigger === "owner_ui";
}

/**
 * Learns from one finished write step. Does nothing unless learning is on, the run was started by
 * the owner (a scheduled run never prompts) and `suggest_after` is above zero. Never throws on bad
 * audit data; a caller still wraps it so learning can never fail a run.
 */
export function learnFromStepRun(
  db: Database,
  run: LearningStepRun,
  cfg: LearningConfig,
): LearningResult {
  if (!cfg.enabled() || !isOwnerStarted(run.trigger)) return { kind: "off" };
  const suggestAfter = cfg.suggestAfter();
  if (suggestAfter <= 0) return { kind: "off" };
  // A run of content the workflow no longer has (it was edited while the run was going) changes no
  // learning state: it must not drop the CURRENT hash's streak, nor start one for obsolete content.
  const current = (cfg.currentSha ?? ((id: string) => currentWorkflowSha(db, id)))(run.workflowId);
  if (current === undefined || !sha256HexEqualConstantTime(current, run.workflowSha256)) {
    return { kind: "superseded" };
  }
  const now = (cfg.now ?? Date.now)();
  // A hash change is a new key: the old hash's open suggestions go stale and its streaks are dropped.
  markStaleFor(db, run.workflowId, run.workflowSha256, now);
  const verdict = classifyStepRun(readRows(db, run), run);
  const streak = applyStepRun(db, run, verdict, run.runId, now);
  if (verdict !== "counts" || streak < suggestAfter) return { kind: "learned", verdict, streak };
  if (hasLiveRuleFor(db, run, now)) return { kind: "learned", verdict, streak };
  const made = openSuggestion(db, run, streak, now);
  if (made === undefined) return { kind: "learned", verdict, streak };
  cfg.log?.(
    {
      event: "standing.suggestion.created",
      suggestionId: made.id,
      workflow: run.workflowName,
      step: run.stepLabel,
      streak,
    },
    "a standing rule was suggested after repeated hand approvals",
  );
  return { kind: "learned", verdict, streak, suggestionId: made.id };
}
