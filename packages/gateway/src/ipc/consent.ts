import { notifyApprovalPending } from "../util/approval-pending.ts";
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
    params: {
      requestId: string;
      prompt: string;
      details?: unknown;
      actionType?: string | undefined;
    },
  ): Promise<boolean>;
  /**
   * Phase 9.7 D0a: a consent request that also asks the owner to TYPE `confirmText`. Resolves
   * with the owner's answer and the text they typed; the coordinator never compares them
   * (`engine/executor.ts` does, static D41).
   */
  requestConfirmedConsent(
    clientId: string,
    params: {
      requestId: string;
      prompt: string;
      details?: unknown;
      actionType?: string | undefined;
      confirmText: string;
    },
  ): Promise<{ approved: boolean; typed: string }>;
  rejectAllPending(message: string, hitlAuditReason: string): void;
  pendingCount(): number;
}

/** The longest `typed` answer `consent.respond` accepts; a confirm text is at most 200 characters. */
export const CONSENT_TYPED_MAX_LENGTH = 512;

type PendingConsent = {
  readonly resolve: (answer: { approved: boolean; typed: string }) => void;
  readonly reject: (err: Error) => void;
  readonly clientId: string;
  /** True for a type-to-confirm request: a missing `typed` then resolves as the empty string. */
  readonly confirm: boolean;
};

export type ConsentSessionWriter = (notification: JsonRpcNotification) => void;

export class ConsentCoordinatorImpl implements ConsentCoordinator {
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly getWriter: (clientId: string) => ConsentSessionWriter | undefined) {}

  requestConsent(
    clientId: string,
    params: {
      requestId: string;
      prompt: string;
      details?: unknown;
      actionType?: string | undefined;
    },
  ): Promise<boolean> {
    return this.open(clientId, params, undefined, (answer) => answer.approved);
  }

  requestConfirmedConsent(
    clientId: string,
    params: {
      requestId: string;
      prompt: string;
      details?: unknown;
      actionType?: string | undefined;
      confirmText: string;
    },
  ): Promise<{ approved: boolean; typed: string }> {
    return this.open(clientId, params, params.confirmText, (answer) => answer);
  }

  // One promise per request (no derived `.then` chain): a derived promise rejects a tick later, and
  // a caller that awaits several pending requests in turn would see an unhandled rejection.
  private open<T>(
    clientId: string,
    params: {
      requestId: string;
      prompt: string;
      details?: unknown;
      actionType?: string | undefined;
    },
    confirmText: string | undefined,
    toResult: (answer: { approved: boolean; typed: string }) => T,
  ): Promise<T> {
    return new Promise<T>((resolveResult, reject) => {
      const resolve = (answer: { approved: boolean; typed: string }): void => {
        resolveResult(toResult(answer));
      };
      const write = this.getWriter(clientId);
      if (write === undefined) {
        reject(new ConsentDisconnectedError("No active IPC session for client"));
        return;
      }
      const { requestId, prompt, details, actionType } = params;
      this.pending.set(requestId, {
        resolve,
        reject,
        clientId,
        confirm: confirmText !== undefined,
      });
      const notif: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "consent.request",
        // `actionType` rides the unicast so a client can key its rendering on the real type instead
        // of parsing it out of `prompt`. Additive: absent when the executor did not name one, and
        // clients ignore fields they do not know. It is already broadcast in `hitl.requested`.
        params: {
          requestId,
          prompt,
          ...(details === undefined ? {} : { details }),
          ...(actionType === undefined ? {} : { actionType }),
          // The text the owner must type, on a type-to-confirm request only. NOT in the
          // `hitl.requested` broadcast below, for the same reason `prompt` is not: it carries
          // input values.
          ...(confirmText === undefined ? {} : { confirmText }),
        },
      };
      write(notif);
      // OBSERVATION ONLY, and additive: `consent.request` above stays unicast to the acting
      // client, to the same one recipient, with one additive field (`actionType`) — so consent semantics (who is
      // asked, who may answer, and what they see) are untouched.
      //
      // The broadcast below carries `{requestId, actionType}`, never `prompt`. `prompt` is built
      // by `engine/executor.ts`'s `formatConsentPrompt`, which stringifies the redacted `details`
      // object straight into its text (channel names, message bodies, recipients, file paths —
      // whatever the action payload carries); `redactPayloadForConsentDisplay` masks only
      // secret-LOOKING key names (token/key/secret/password/credential/bearer/auth), so
      // everything else survives verbatim — and a user-MCP action (I42) is shown with NO
      // masking at all (`consentDisplayPayload`). Broadcasting `prompt` would hand every connected
      // session — not only the one the gateway is asking — the argument values of an action
      // nobody has approved yet. `actionType` gives a passive observer (`nimbus tail`) what KIND
      // of action is pending without any of that riding along.
      emitGatewayEvent("hitl.requested", { requestId, actionType: actionType ?? "unknown" });
      // The consent hop: a fixed-text OS toast naming only the action TYPE, for the same reason
      // the broadcast above omits `prompt`. A no-op until wiring sets a notifier; never throws.
      notifyApprovalPending({ source: "executor", actionType });
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
    const typed = o["typed"];
    if (
      typed !== undefined &&
      (typeof typed !== "string" || typed.length > CONSENT_TYPED_MAX_LENGTH)
    ) {
      return { code: -32602, message: "Invalid params" };
    }
    const entry = this.pending.get(o["requestId"]);
    if (entry?.clientId !== clientId) {
      return { code: -32602, message: "Unknown or foreign consent request" };
    }
    this.pending.delete(o["requestId"]);
    // A plain request ignores `typed`; a confirm request without one is a mismatch for the executor.
    entry.resolve({ approved: o["approved"], typed: entry.confirm ? (typed ?? "") : "" });
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
