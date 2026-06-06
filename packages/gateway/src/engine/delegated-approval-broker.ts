import { randomUUID } from "node:crypto";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";

interface Pending {
  readonly resolve: (o: RemoteApprovalOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class DelegatedApprovalBroker {
  private channel: (requestId: string, prompt: string) => void = () => {};
  private readonly pending = new Map<string, Pending>();

  setBroadcast(fn: (requestId: string, prompt: string) => void): void {
    this.channel = fn;
  }

  request(input: { prompt: string }, timeoutMs: number): Promise<RemoteApprovalOutcome> {
    const requestId = randomUUID();
    return new Promise<RemoteApprovalOutcome>((resolve) => {
      // NB: do NOT unref() this timer. The returned promise resolves ONLY when this timer fires
      // (timeout) or respond() clears it — unref'ing an awaited timer hangs `bun test` on Windows.
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.channel(requestId, input.prompt);
    });
  }

  respond(requestId: string, peerId: string, approved: boolean): boolean {
    const p = this.pending.get(requestId);
    if (p === undefined) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve({ kind: "answered", peerId, approved });
    return true;
  }
}

export const delegatedApprovalBroker = new DelegatedApprovalBroker();
