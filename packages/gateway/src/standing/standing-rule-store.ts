// packages/gateway/src/standing/standing-rule-store.ts
// The ONLY reader and writer of `standing_rule` and `standing_rule_fire` (Phase 10 SA3, I55, static
// D44(b)). Every write goes through `dbRun` (I14); every value is a bound parameter (I9).
//
// Who may call what (the callers are the contract, the store does not decide for them):
//   - `insertRule`  only the create handler (`ipc/standing-rpc.ts`), after the owner approved
//                   `standing.rule.create` over the rule's exact text;
//   - `resumeRule`  only the resume handler, after the owner approved `standing.rule.resume`;
//   - `pauseRule`, `revokeRule`  the owner's narrowing (no approval needed; the handler audits);
//   - `claimFire`   only `engine/standing-rule-step.ts`, the last step of the I55 check.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

import { canonicalJson } from "../automation/workflow-steps.ts";
import { dbRun } from "../db/write.ts";
import type {
  NewStandingRule,
  StandingFire,
  StandingRule,
  StandingRuleState,
  StandingScope,
  StandingWindow,
} from "./standing-rule-types.ts";

type RuleRow = {
  id: string;
  created_at: number;
  workflow_id: string;
  workflow_sha256: string;
  step_index: number;
  action_type: string;
  tool_id: string;
  scope_json: string;
  window_json: string | null;
  expires_at: number;
  max_actions: number;
  actions_used: number;
  paused_at: number | null;
  revoked_at: number | null;
  last_fired_at: number | null;
  approval_audit_id: number;
};

type FireRow = {
  fire_id: string;
  rule_id: string;
  fired_at: number;
  action_type: string;
  matched_scope_sha256: string;
};

const RULE_COLUMNS = `id, created_at, workflow_id, workflow_sha256, step_index, action_type, tool_id,
  scope_json, window_json, expires_at, max_actions, actions_used, paused_at, revoked_at,
  last_fired_at, approval_audit_id`;

function ruleOf(r: RuleRow): StandingRule {
  return {
    id: r.id,
    createdAt: r.created_at,
    workflowId: r.workflow_id,
    workflowSha256: r.workflow_sha256,
    stepIndex: r.step_index,
    actionType: r.action_type,
    toolId: r.tool_id,
    scope: JSON.parse(r.scope_json) as StandingScope,
    window: r.window_json === null ? undefined : (JSON.parse(r.window_json) as StandingWindow),
    expiresAt: r.expires_at,
    maxActions: r.max_actions,
    actionsUsed: r.actions_used,
    pausedAt: r.paused_at ?? undefined,
    revokedAt: r.revoked_at ?? undefined,
    lastFiredAt: r.last_fired_at ?? undefined,
    approvalAuditId: r.approval_audit_id,
  };
}

function fireOf(r: FireRow): StandingFire {
  return {
    fireId: r.fire_id,
    ruleId: r.rule_id,
    firedAt: r.fired_at,
    actionType: r.action_type,
    matchedScopeSha256: r.matched_scope_sha256,
  };
}

/** SHA-256 of the canonical JSON of a scope: what each fire records as the scope it matched. */
export function scopeSha256(scope: StandingScope): string {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

/** `'sr_'` + 16 random hex characters. */
export function newRuleId(): string {
  return `sr_${randomBytes(8).toString("hex")}`;
}

/** `'sf_'` + 16 random hex characters. */
export function newFireId(): string {
  return `sf_${randomBytes(8).toString("hex")}`;
}

/** Inserts a rule. Call only after the owner approved `standing.rule.create` over its text. */
export function insertRule(db: Database, rule: NewStandingRule): StandingRule {
  const id = newRuleId();
  dbRun(
    db,
    `INSERT INTO standing_rule (id, created_at, workflow_id, workflow_sha256, step_index, action_type,
       tool_id, scope_json, window_json, expires_at, max_actions, actions_used, approval_audit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      rule.createdAt,
      rule.workflowId,
      rule.workflowSha256,
      rule.stepIndex,
      rule.actionType,
      rule.toolId,
      JSON.stringify(rule.scope),
      rule.window === undefined ? null : JSON.stringify(rule.window),
      rule.expiresAt,
      rule.maxActions,
      rule.approvalAuditId,
    ],
  );
  return {
    ...rule,
    id,
    actionsUsed: 0,
    pausedAt: undefined,
    revokedAt: undefined,
    lastFiredAt: undefined,
  };
}

export function getRule(db: Database, id: string): StandingRule | undefined {
  const row = db.query(`SELECT ${RULE_COLUMNS} FROM standing_rule WHERE id = ?`).get(id) as
    | RuleRow
    | null
    | undefined;
  return row === null || row === undefined ? undefined : ruleOf(row);
}

export function listRules(db: Database): StandingRule[] {
  const rows = db
    .query(`SELECT ${RULE_COLUMNS} FROM standing_rule ORDER BY created_at DESC, id`)
    .all() as RuleRow[];
  return rows.map(ruleOf);
}

/**
 * The rules bound to exactly this workflow id, content hash, step, action type and tool. The check
 * (I55 step 6) filters these further by state, window and scope; the SQL only narrows.
 */
export function listRulesFor(
  db: Database,
  key: {
    readonly workflowId: string;
    readonly workflowSha256: string;
    readonly stepIndex: number;
    readonly actionType: string;
    readonly toolId: string;
  },
): StandingRule[] {
  const rows = db
    .query(
      `SELECT ${RULE_COLUMNS} FROM standing_rule
       WHERE workflow_id = ? AND workflow_sha256 = ? AND step_index = ? AND action_type = ?
         AND tool_id = ?
       ORDER BY created_at, id`,
    )
    .all(
      key.workflowId,
      key.workflowSha256,
      key.stepIndex,
      key.actionType,
      key.toolId,
    ) as RuleRow[];
  return rows.map(ruleOf);
}

/**
 * Whether a LIVE rule (not revoked, paused, expired or exhausted: `ruleState(r, now) === "live"`)
 * already covers this workflow id, content hash and step. Approval learning asks this and nothing
 * else about rules, so a suggestion is never made for a step a rule covers (Phase 10 SA5).
 */
export function hasLiveRuleFor(
  db: Database,
  key: {
    readonly workflowId: string;
    readonly workflowSha256: string;
    readonly stepIndex: number;
  },
  now: number,
): boolean {
  const rows = db
    .query(
      `SELECT ${RULE_COLUMNS} FROM standing_rule
       WHERE workflow_id = ? AND workflow_sha256 = ? AND step_index = ?`,
    )
    .all(key.workflowId, key.workflowSha256, key.stepIndex) as RuleRow[];
  return rows.some((r) => ruleState(ruleOf(r), now) === "live");
}

export function listFires(db: Database, ruleId?: string): StandingFire[] {
  const rows =
    ruleId === undefined
      ? (db
          .query(
            `SELECT fire_id, rule_id, fired_at, action_type, matched_scope_sha256
             FROM standing_rule_fire ORDER BY fired_at, fire_id`,
          )
          .all() as FireRow[])
      : (db
          .query(
            `SELECT fire_id, rule_id, fired_at, action_type, matched_scope_sha256
             FROM standing_rule_fire WHERE rule_id = ? ORDER BY fired_at, fire_id`,
          )
          .all(ruleId) as FireRow[]);
  return rows.map(fireOf);
}

/** What a rule is, right now. Revoked wins over paused, paused over expired, expired over exhausted. */
export function ruleState(rule: StandingRule, now: number): StandingRuleState {
  if (rule.revokedAt !== undefined) return "revoked";
  if (rule.pausedAt !== undefined) return "paused";
  if (rule.expiresAt <= now) return "expired";
  if (rule.actionsUsed >= rule.maxActions) return "exhausted";
  return "live";
}

/** Pauses a rule that is not paused or revoked. `false` when there was nothing to pause. */
export function pauseRule(db: Database, id: string, now: number): boolean {
  const r = dbRun(
    db,
    "UPDATE standing_rule SET paused_at = ? WHERE id = ? AND paused_at IS NULL AND revoked_at IS NULL",
    [now, id],
  );
  return r.changes === 1;
}

/** Un-pauses a paused rule that is not revoked. Call only after the owner approved `standing.rule.resume`. */
export function resumeRule(db: Database, id: string): boolean {
  const r = dbRun(
    db,
    "UPDATE standing_rule SET paused_at = NULL WHERE id = ? AND paused_at IS NOT NULL AND revoked_at IS NULL",
    [id],
  );
  return r.changes === 1;
}

/** Revokes a rule for good: a revoked rule never resumes. `false` when it was already revoked or unknown. */
export function revokeRule(db: Database, id: string, now: number): boolean {
  const r = dbRun(
    db,
    "UPDATE standing_rule SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    [now, id],
  );
  return r.changes === 1;
}

/**
 * Step 9 of the I55 check (spec § 5.3): claims one action of the rule's ceiling and records the
 * fire, in ONE transaction. The conditional UPDATE is the whole decision: a rule that is revoked,
 * paused, expired (`expires_at <= now`) or at its ceiling changes no row, and nothing is inserted.
 * The transaction takes the write lock up front (`immediate`), so two claims on two connections
 * cannot both read "one left". Returns the new fire id, or `undefined` when nothing was claimed.
 */
export function claimFire(
  db: Database,
  ruleId: string,
  now: number,
  actionType: string,
  matchedScopeSha256: string,
): string | undefined {
  const claim = db.transaction((): string | undefined => {
    const updated = dbRun(
      db,
      `UPDATE standing_rule
       SET actions_used = actions_used + 1, last_fired_at = ?
       WHERE id = ? AND revoked_at IS NULL AND paused_at IS NULL AND expires_at > ?
         AND actions_used < max_actions`,
      [now, ruleId, now],
    );
    if (updated.changes !== 1) return undefined;
    const fireId = newFireId();
    dbRun(
      db,
      `INSERT INTO standing_rule_fire (fire_id, rule_id, fired_at, action_type, matched_scope_sha256)
       VALUES (?, ?, ?, ?, ?)`,
      [fireId, ruleId, now, actionType, matchedScopeSha256],
    );
    return fireId;
  });
  return claim.immediate();
}
