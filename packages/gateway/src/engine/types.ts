export type PlannedAction = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ActionResult =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; reason: string };

export interface ConsentChannel {
  requestApproval(prompt: string, details?: Record<string, unknown>): Promise<boolean>;
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
