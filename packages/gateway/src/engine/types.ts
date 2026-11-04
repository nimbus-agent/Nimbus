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

export interface ConsentChannel {
  requestApproval(
    prompt: string,
    details?: Record<string, unknown>,
    actionType?: string,
  ): Promise<boolean>;
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
