import { randomUUID } from "node:crypto";

type Broadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ShareApprovalInput {
  readonly sessionId: string;
  readonly kind: string;
  readonly preview: unknown;
  readonly redactionSet: readonly string[];
  readonly sink: string;
}

/**
 * Owner-approval round-trip for an outbound share publish (I27). The request is broadcast to all
 * connected local clients; the owner answers via `share.approvalRespond` → `respond`. A TTL
 * safety-net resolves `false` (deny) if the owner never answers — fail-closed. Mirrors
 * `federation/preflight-consent-broker.ts`.
 */
export class ShareConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  request(input: ShareApprovalInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, ttlMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("share.approvalRequest", { requestId, ...input });
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

/** Process singleton shared by the local dispatcher and the share-gate path. */
export const shareConsent = new ShareConsentBroker();
