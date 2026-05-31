import type { JsonRpcNotification } from "./jsonrpc.ts";

export class ConsentDisconnectedError extends Error {
  readonly code = "CONSENT_CLIENT_DISCONNECTED" as const;
  readonly hitlAuditReason: string;
  override readonly name = "ConsentDisconnectedError";
  constructor(message = "client disconnected", hitlAuditReason: string = "client disconnected") {
    super(message);
    this.hitlAuditReason = hitlAuditReason;
  }
}

export interface ConsentCoordinator {
  requestConsent(
    clientId: string,
    params: { requestId: string; prompt: string; details?: unknown },
  ): Promise<boolean>;
  rejectAllPending(message: string, hitlAuditReason: string): void;
  pendingCount(): number;
}

type PendingConsent = {
  readonly resolve: (approved: boolean) => void;
  readonly reject: (err: Error) => void;
  readonly clientId: string;
};

export type ConsentSessionWriter = (notification: JsonRpcNotification) => void;

export class ConsentCoordinatorImpl implements ConsentCoordinator {
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly getWriter: (clientId: string) => ConsentSessionWriter | undefined) {}

  requestConsent(
    clientId: string,
    params: { requestId: string; prompt: string; details?: unknown },
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const write = this.getWriter(clientId);
      if (write === undefined) {
        reject(new ConsentDisconnectedError("No active IPC session for client"));
        return;
      }
      const { requestId, prompt, details } = params;
      this.pending.set(requestId, { resolve, reject, clientId });
      const notif: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "consent.request",
        params: details === undefined ? { requestId, prompt } : { requestId, prompt, details },
      };
      write(notif);
    });
  }

  handleRespond(clientId: string, params: unknown): { code: number; message: string } | null {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return { code: -32602, message: "Invalid params" };
    }
    const o = params as Record<string, unknown>;
    if (typeof o["requestId"] !== "string" || typeof o["approved"] !== "boolean") {
      return { code: -32602, message: "Invalid params" };
    }
    const entry = this.pending.get(o["requestId"]);
    if (entry?.clientId !== clientId) {
      return { code: -32602, message: "Unknown or foreign consent request" };
    }
    this.pending.delete(o["requestId"]);
    entry.resolve(o["approved"]);
    return null;
  }

  onClientDisconnect(clientId: string): void {
    const toRemove: string[] = [];
    for (const [requestId, entry] of this.pending) {
      if (entry.clientId === clientId) {
        toRemove.push(requestId);
      }
    }
    for (const requestId of toRemove) {
      const entry = this.pending.get(requestId);
      if (entry !== undefined) {
        this.pending.delete(requestId);
        entry.reject(new ConsentDisconnectedError());
      }
    }
  }

  rejectAllPending(message: string, hitlAuditReason: string): void {
    const err = new ConsentDisconnectedError(message, hitlAuditReason);
    const snapshot = new Map(this.pending);
    this.pending.clear();
    for (const entry of snapshot.values()) {
      entry.reject(err);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
