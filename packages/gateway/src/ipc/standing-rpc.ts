// packages/gateway/src/ipc/standing-rpc.ts
// `standing.*` — the owner's standing approval rules (Phase 10 SA3, I55, spec § 5.2).
//
//   standing.list | show | fires   reads (the desktop may call them: I7 allowlist);
//   standing.pause | revoke        narrowing, no approval needed, each audited (desktop-callable);
//   standing.create | resume       WIDENING: the connection must have declared kind `cli` (the local
//                                  socket's owner CLI), the org policy must allow standing approvals,
//                                  and the LOCAL owner approves the rule's exact text through an
//                                  executor built with NO delegation. The approval counts only when
//                                  the consent answer's source is `human`: `--yes` (`auto`), a script
//                                  (`script`) and an old client (`unknown`) are refused.
// The whole `standing` namespace is in `FORBIDDEN_OVER_LAN` (I5); ChatOps, MCP and HTTP have no route.
//
// The rule's scope is DERIVED here from the stored workflow (`standing-rule-derive.ts`); the caller
// names only `{ workflow, step, days?, max?, window? }`. A bad request never reaches the prompt.
import type { Database } from "bun:sqlite";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { type ExecutorPolicyDep, NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import type {
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../engine/types.ts";
import { STANDING_APPROVALS_DISABLED_MESSAGE } from "../standing/standing-rule-capability.ts";
import { deriveRule } from "../standing/standing-rule-derive.ts";
import {
  getRule,
  insertRule,
  listFires,
  listRules,
  pauseRule,
  resumeRule,
  revokeRule,
  ruleState,
} from "../standing/standing-rule-store.ts";
import {
  type RuleTextInput,
  renderRuleText,
  StandingRuleError,
  windowLabel,
} from "../standing/standing-rule-text.ts";
import type { StandingRule } from "../standing/standing-rule-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/** The result of asking the local owner to approve one standing-rule action. */
export type OwnerApproval =
  | { readonly approved: true; readonly auditId: number }
  | { readonly approved: false; readonly reason: "declined" | "not_human" };

export interface StandingRpcCtx {
  readonly db: Database;
  /** The connection's declared kind (`ctx.getClientKind(clientId)`), never a param. */
  readonly callerKind: ClientKind;
  /** The live org policy verdict (absent accessor = off, fail closed). */
  readonly policyAllows: () => boolean;
  /** Asks the LOCAL owner (no delegation); human answers only. */
  readonly askOwner: (action: PlannedAction) => Promise<OwnerApproval>;
  /** Writes an audit row for a narrowing (pause / revoke). */
  readonly recordNarrowing: (actionType: string, actionJson: string) => void;
  /** Whether an action type is in the executor's frozen HITL set (the eligibility check reads it). */
  readonly frozenHitl: (actionType: string) => boolean;
  readonly now?: () => number;
}

const ERR = (code: string, message: string): RpcMethodError =>
  new RpcMethodError(-32001, message, { code });

function recordOf(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function idOf(params: unknown): string {
  const id = recordOf(params)["id"];
  if (typeof id !== "string" || !/^sr_[0-9a-f]{16}$/.test(id)) {
    throw ERR("ERR_STANDING_BAD_ID", "id must be a rule id such as sr_0123456789abcdef");
  }
  return id;
}

/** What `list` and `show` return for one rule: the stored row plus its current state. */
function viewOf(db: Database, rule: StandingRule, now: number): Record<string, unknown> {
  const wf = db.query("SELECT name FROM workflow WHERE id = ?").get(rule.workflowId) as
    | { name: string }
    | null
    | undefined;
  return {
    id: rule.id,
    state: ruleState(rule, now),
    workflowId: rule.workflowId,
    workflowName: wf?.name ?? null,
    workflowSha256: rule.workflowSha256,
    stepIndex: rule.stepIndex,
    actionType: rule.actionType,
    toolId: rule.toolId,
    scope: rule.scope,
    window: rule.window === undefined ? null : { ...rule.window, label: windowLabel(rule.window) },
    createdAt: rule.createdAt,
    expiresAt: rule.expiresAt,
    maxActions: rule.maxActions,
    actionsUsed: rule.actionsUsed,
    lastFiredAt: rule.lastFiredAt ?? null,
    pausedAt: rule.pausedAt ?? null,
    revokedAt: rule.revokedAt ?? null,
    approvalAuditId: rule.approvalAuditId,
  };
}

function requireRule(db: Database, id: string): StandingRule {
  const rule = getRule(db, id);
  if (rule === undefined) throw ERR("ERR_STANDING_NOT_FOUND", "no such rule");
  return rule;
}

/** `create` and `resume` widen: local CLI only, and only while org policy allows. */
function requireWidening(ctx: StandingRpcCtx): void {
  if (ctx.callerKind !== "cli") {
    throw ERR(
      "ERR_STANDING_CLI_ONLY",
      "a standing rule is created or resumed only from the owner's CLI on the local socket",
    );
  }
  if (!ctx.policyAllows()) {
    throw ERR("ERR_STANDING_POLICY_DISABLED", STANDING_APPROVALS_DISABLED_MESSAGE);
  }
}

function refusalOf(approval: Extract<OwnerApproval, { approved: false }>): RpcMethodError {
  return approval.reason === "not_human"
    ? ERR(
        "ERR_STANDING_NEEDS_HUMAN",
        "a standing rule is approved only by a person answering the prompt (not --yes and not a script)",
      )
    : ERR("ERR_STANDING_DECLINED", "the rule was not approved");
}

/** Maps a derive-time refusal to the RPC error, leaving every other throw alone. */
function asRpcError(e: unknown): unknown {
  return e instanceof StandingRuleError ? ERR("ERR_STANDING_REFUSED", e.message) : e;
}

async function createRule(ctx: StandingRpcCtx, params: unknown): Promise<Record<string, unknown>> {
  requireWidening(ctx);
  const p = recordOf(params);
  const workflow = p["workflow"];
  const step = p["step"];
  if (typeof workflow !== "string" || workflow.trim() === "") {
    throw ERR("ERR_STANDING_REFUSED", "workflow must be the name of a saved workflow");
  }
  if (typeof step !== "string" && typeof step !== "number") {
    throw ERR("ERR_STANDING_REFUSED", "step must be a step label or number");
  }
  const now = (ctx.now ?? Date.now)();
  let derived: ReturnType<typeof deriveRule>;
  try {
    derived = deriveRule(
      ctx.db,
      { workflow: workflow.trim(), step, days: p["days"], max: p["max"], window: p["window"] },
      ctx.frozenHitl,
      now,
    );
  } catch (e) {
    throw asRpcError(e);
  }
  const approval = await ctx.askOwner({
    type: "standing.rule.create",
    payload: {
      workflowId: derived.rule.workflowId,
      workflowSha256: derived.rule.workflowSha256,
      stepIndex: derived.rule.stepIndex,
      toolId: derived.rule.toolId,
      expiresAt: derived.rule.expiresAt,
      maxActions: derived.rule.maxActions,
      promptText: renderRuleText(derived.text, now).join("\n"),
    },
  });
  if (!approval.approved) throw refusalOf(approval);
  const rule = insertRule(ctx.db, { ...derived.rule, approvalAuditId: approval.auditId });
  return viewOf(ctx.db, rule, now);
}

async function resumeOne(ctx: StandingRpcCtx, params: unknown): Promise<Record<string, unknown>> {
  requireWidening(ctx);
  const rule = requireRule(ctx.db, idOf(params));
  const now = (ctx.now ?? Date.now)();
  if (rule.revokedAt !== undefined) {
    throw ERR("ERR_STANDING_REVOKED", "a revoked rule is final; create a new one");
  }
  if (rule.pausedAt === undefined) throw ERR("ERR_STANDING_NOT_PAUSED", "the rule is not paused");
  const wf = ctx.db.query("SELECT name FROM workflow WHERE id = ?").get(rule.workflowId) as
    | { name: string }
    | null
    | undefined;
  const text: RuleTextInput = {
    workflowName: wf?.name ?? rule.workflowId,
    workflowSha256: rule.workflowSha256,
    stepIndex: rule.stepIndex,
    stepLabel: `step ${String(rule.stepIndex + 1)}`,
    toolId: rule.toolId,
    actionType: rule.actionType,
    scope: rule.scope,
    window: rule.window,
    expiresAt: rule.expiresAt,
    maxActions: rule.maxActions,
    actionsUsed: rule.actionsUsed,
  };
  const approval = await ctx.askOwner({
    type: "standing.rule.resume",
    payload: {
      ruleId: rule.id,
      workflowSha256: rule.workflowSha256,
      promptText: ["Resume this standing rule.", "", ...renderRuleText(text, now)].join("\n"),
    },
  });
  if (!approval.approved) throw refusalOf(approval);
  if (!resumeRule(ctx.db, rule.id)) {
    throw ERR("ERR_STANDING_NOT_PAUSED", "the rule is not paused");
  }
  return viewOf(ctx.db, requireRule(ctx.db, rule.id), now);
}

function narrow(
  ctx: StandingRpcCtx,
  params: unknown,
  verb: "pause" | "revoke",
): Record<string, unknown> {
  const rule = requireRule(ctx.db, idOf(params));
  const now = (ctx.now ?? Date.now)();
  const changed =
    verb === "pause" ? pauseRule(ctx.db, rule.id, now) : revokeRule(ctx.db, rule.id, now);
  if (changed) {
    ctx.recordNarrowing(`standing.rule.${verb}`, JSON.stringify({ ruleId: rule.id }));
  }
  return { ...viewOf(ctx.db, requireRule(ctx.db, rule.id), now), changed };
}

type AuditRef = { id: number; timestamp: number; rowHash: string };

/** The standing-approved audit rows, by the fire id their `action_json` names (truncation-safe). */
function auditRowsByFire(db: Database): Map<string, AuditRef> {
  const rows = db
    .query(
      "SELECT id, timestamp, row_hash AS rowHash, action_json AS actionJson FROM audit_log WHERE hitl_status = 'standing_approved'",
    )
    .all() as Array<AuditRef & { actionJson: string }>;
  const out = new Map<string, AuditRef>();
  for (const r of rows) {
    const m = /"fireId":"(sf_[0-9a-f]{16})"/.exec(r.actionJson);
    if (m?.[1] !== undefined)
      out.set(m[1], { id: r.id, timestamp: r.timestamp, rowHash: r.rowHash });
  }
  return out;
}

function firesOf(ctx: StandingRpcCtx, params: unknown): Record<string, unknown> {
  const raw = recordOf(params)["id"];
  const ruleId = raw === undefined ? undefined : idOf(params);
  if (ruleId !== undefined) requireRule(ctx.db, ruleId);
  const audits = auditRowsByFire(ctx.db);
  return {
    fires: listFires(ctx.db, ruleId).map((f) => {
      const a = audits.get(f.fireId);
      return {
        ...f,
        // A fire with no audit row is shown as such, never silently dropped.
        audit: a ?? null,
      };
    }),
  };
}

export async function dispatchStandingRpc(
  method: string,
  params: unknown,
  ctx: StandingRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<StandingRpcCtx, unknown>(method, params, ctx, {
    "standing.list": (_p, c) => {
      const now = (c.now ?? Date.now)();
      return { rules: listRules(c.db).map((r) => viewOf(c.db, r, now)) };
    },
    "standing.show": (p, c) => ({
      rule: viewOf(c.db, requireRule(c.db, idOf(p)), (c.now ?? Date.now)()),
    }),
    "standing.fires": (p, c) => firesOf(c, p),
    "standing.create": async (p, c) => ({ rule: await createRule(c, p) }),
    "standing.resume": async (p, c) => ({ rule: await resumeOne(c, p) }),
    "standing.pause": (p, c) => ({ rule: narrow(c, p, "pause") }),
    "standing.revoke": (p, c) => ({ rule: narrow(c, p, "revoke") }),
  });
}

/**
 * The owner's approval of one standing-rule action: a gate-only executor (its dispatcher rejects,
 * so nothing reaches a connector through it) with NO delegation (I20) around THIS connection's
 * consent channel. The channel is wrapped so that an approval whose source is not `human` (`--yes`
 * is `auto`, a script is `script`, an old client is `unknown`) is turned into a decline BEFORE the
 * executor records it: the audit row says rejected, and the caller is told why. The audit id of an
 * approved action is read synchronously from the sink the executor writes to.
 */
export function createStandingOwnerAsk(deps: {
  readonly consent: ConsentChannel;
  readonly audit: AuditSink;
  readonly db: Database;
  readonly policyHitl?: ExecutorPolicyDep | undefined;
}): (action: PlannedAction) => Promise<OwnerApproval> {
  return async (action) => {
    let refusedNonHuman = false;
    let auditId: number | undefined;
    const humanOnly: ConsentChannel = {
      async requestApproval(prompt, details, actionType) {
        const answer = await deps.consent.requestApproval(prompt, details, actionType);
        if (answer.approved && answer.answerSource !== "human") {
          refusedNonHuman = true;
          return { approved: false, answerSource: answer.answerSource };
        }
        return answer;
      },
    };
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("the standing-rule gate does not dispatch"));
      },
    };
    const capturing: AuditSink = {
      recordAudit(entry) {
        deps.audit.recordAudit(entry);
        const row = deps.db.query("SELECT MAX(id) AS id FROM audit_log").get() as {
          id: number | null;
        } | null;
        auditId = row?.id ?? undefined;
      },
    };
    const executor = new ToolExecutor(
      humanOnly,
      capturing,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      deps.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const outcome = await executor.gate(action);
    if (outcome === "proceed" && auditId !== undefined) return { approved: true, auditId };
    return { approved: false, reason: refusedNonHuman ? "not_human" : "declined" };
  };
}
