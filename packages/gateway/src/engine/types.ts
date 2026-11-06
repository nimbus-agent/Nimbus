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

/** The owner's answer to a {@link ConfirmedApprovalRequest}: the decision and what they typed. */
export interface ConfirmedApprovalResult {
  approved: boolean;
  typed: string;
}

export interface ConsentChannel {
  requestApproval(
    prompt: string,
    details?: Record<string, unknown>,
    actionType?: string,
  ): Promise<boolean>;
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
    hitlStatus: "approved" | "rejected" | "not_required";
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }): void;
}

export interface ConnectorDispatcher {
  dispatch(action: PlannedAction): Promise<unknown>;
}
