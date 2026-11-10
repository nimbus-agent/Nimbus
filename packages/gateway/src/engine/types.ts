import type { BoundWriteCapabilities } from "./bound-write-capabilities.ts";

export type PlannedAction = {
  type: string;
  payload?: Record<string, unknown>;
  /**
   * Set only by the gateway for an action the MODEL proposed. It only ever REMOVES delegation (a
   * delegate never approves it, I20) and adds a consent line; whether HITL is required stays
   * decided by `type` alone (I3). Top level only: a `payload.origin` means nothing.
   */
  origin?: "model";
};

export type ActionResult =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; reason: string };

/**
 * A type-to-confirm request (Phase 9.7 D0a): the owner approves a Wave 4 write only by typing
 * `confirmText` exactly. `prompt` already ends with the fixed line telling them what to type.
 */
export interface ConfirmedApprovalRequest {
  prompt: string;
  details?: Record<string, unknown> | undefined;
  actionType?: string | undefined;
  confirmText: string;
}

/**
 * Where an approval answer came from (Phase 10 SA1, spec § 6.1). Client-reported for the owner's
 * prompt: `human` (a person answered), `auto` (`--yes`), `script` (a scripted consent); `unknown`
 * is an older client that sent none; `delegate` and `remote` are set by the gateway for a delegated
 * and a ChatOps answer; `none` is a decision no prompt was shown for.
 */
export type AnswerSource = "human" | "auto" | "script" | "unknown" | "delegate" | "remote" | "none";

/** The answer sources an IPC consent reply may carry (the client-reported subset). */
export const REPORTED_ANSWER_SOURCES = ["human", "auto", "script"] as const;

/** What the approval phase decided: an owner/delegate answer, or (reserved for I55) a standing rule. */
export type ApprovalOutcome =
  | { kind: "approved"; answerSource: AnswerSource }
  | { kind: "rejected"; reason: string; answerSource: AnswerSource }
  | { kind: "standing_approved"; ruleId: string; fireId: string };

/** The owner's answer to a {@link ConfirmedApprovalRequest}: the decision and what they typed. */
export interface ConfirmedApprovalResult {
  approved: boolean;
  typed: string;
  answerSource: AnswerSource;
}

/** The owner's answer to a plain approval request. */
export interface ApprovalAnswer {
  approved: boolean;
  answerSource: AnswerSource;
}

export interface ConsentChannel {
  requestApproval(
    prompt: string,
    details?: Record<string, unknown>,
    actionType?: string,
  ): Promise<ApprovalAnswer>;
  /**
   * Collects a typed confirmation. A channel without it cannot approve a Wave 4 write: the
   * executor denies it (`confirm: unsupported_channel`) and never falls back to
   * `requestApproval`. The channel only carries the text; the comparison with `confirmText` is
   * the executor's alone (static D41).
   */
  requestConfirmedApproval?(req: ConfirmedApprovalRequest): Promise<ConfirmedApprovalResult>;
}

export interface AuditSink {
  recordAudit(entry: {
    actionType: string;
    hitlStatus: "approved" | "rejected" | "not_required" | "standing_approved";
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }): void;
}

export interface ConnectorDispatcher {
  dispatch(action: PlannedAction): Promise<unknown>;
  /**
   * D2 (I54): the runtime capabilities of a bound IaC row (its settle step and its preflight).
   * Optional and read-only; set only by the production dispatcher built in `connectors/registry.ts`
   * (a test dispatcher sets its own). The gate reaches it ONLY from its preflight and prepare
   * phases, and a bound row whose tag needs it is refused when it is absent.
   */
  readonly boundWriteCapabilities?: BoundWriteCapabilities;
}
