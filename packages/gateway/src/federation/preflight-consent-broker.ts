import { randomUUID } from "node:crypto";

export interface PreflightApprovalInput {
  readonly peerId: string;
  readonly namespace: string;
  readonly ref: string;
  readonly purpose: string;
}

type Broadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owner-approval round-trip for an inbound preflight request (I24). The request is broadcast to all
 * connected local clients; the owner answers via `federation.preflightRespond` → `respond`. A TTL
 * safety-net resolves `false` (deny) if the owner never answers — fail-closed.
 */
export class PreflightConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  request(input: PreflightApprovalInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, ttlMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("federation.preflightRequest", { requestId, ...input });
    });
  }

  /** Returns true if a pending request matched (and was resolved); false for unknown/expired/settled. */
  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

/** Process singleton shared by the local dispatcher and the LAN onMessage path. */
export const preflightConsent = new PreflightConsentBroker();
