import { randomUUID } from "node:crypto";
import type { ConsentDecision } from "./query-gate.ts";

export interface ConsentRequestInput {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly role: string;
}

type Broadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (d: ConsentDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owner-consent round-trip for inbound federated queries. The request is broadcast to all connected
 * local clients (any owner UI may answer); `respond` resolves the matching pending promise. A TTL
 * safety-net guarantees no pending entry leaks even if the owner never answers (belt-and-suspenders
 * behind query-gate's own consent-timeout race).
 */
export class FederationConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  request(input: ConsentRequestInput, ttlMs: number): Promise<ConsentDecision> {
    const requestId = randomUUID();
    return new Promise<ConsentDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("denied");
      }, ttlMs);
      timer.unref?.(); // don't hold the event loop open while a consent request is pending
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("federation.consentRequest", { requestId, ...input });
    });
  }

  /** Returns true if a pending request matched (and was resolved); false for unknown/expired/settled. */
  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false; // unknown / already settled / expired
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved ? "approved" : "denied");
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

/** Process singleton shared by the local dispatcher and the LAN onMessage path. */
export const federationConsent = new FederationConsentBroker();
