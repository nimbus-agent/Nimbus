import { emitGatewayEvent } from "./gateway-events.ts";
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
      // OBSERVATION ONLY, and additive: `consent.request` above stays unicast to the acting
      // client, so consent semantics (who is asked, who may answer) are untouched.
      //
      // The `details` FIELD is omitted from this broadcast, but that withholds nothing: `prompt`
      // is built by `engine/executor.ts`'s `formatConsentPrompt`, which stringifies the very same
      // redacted `details` object into the prompt text (channel names, message bodies,
      // recipients, file paths — whatever the action payload carries). `redactPayloadForConsentDisplay`
      // masks only secret-LOOKING key names (token/key/secret/password/credential/bearer/auth);
      // everything else survives verbatim into `prompt`, and `prompt` DOES go out on this
      // broadcast, to every connected session. Recipients are same-user local socket sessions,
      // which can already read the same redacted payload via `audit.list` — this does not widen
      // who can see it, only when.
      //
      // Better long-term shape: thread `action.type` through `requestApproval`'s params and
      // broadcast `{requestId, actionType}` instead of the rendered prompt, so a passive observer
      // learns WHAT KIND of action is pending without the argument values riding along. That is a
      // wider contract change (touches every `ConsentChannel` caller) and is deliberately not done
      // here.
      emitGatewayEvent("hitl.requested", { requestId, prompt });
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
    emitGatewayEvent("hitl.resolved", { requestId: o["requestId"], approved: o["approved"] });
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
        emitGatewayEvent("hitl.resolved", {
          requestId,
          approved: false,
          reason: "client disconnected",
        });
      }
    }
  }

  rejectAllPending(message: string, hitlAuditReason: string): void {
    const err = new ConsentDisconnectedError(message, hitlAuditReason);
    const snapshot = new Map(this.pending);
    this.pending.clear();
    // `.entries()`, not `.values()`: the key IS the requestId, and `hitl.resolved` is useless
    // without it. The existing loop discarded it because nothing needed it before.
    for (const [requestId, entry] of snapshot.entries()) {
      entry.reject(err);
      emitGatewayEvent("hitl.resolved", { requestId, approved: false, reason: message });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
