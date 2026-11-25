// packages/gateway/src/computer-use/cu-unicast-broker.ts
// The computer-use approval round-trip (I35, owner ruling OR-MCU-2): a prompt goes to the ONE
// connection that made the request, and only a person's answer from that same connection approves.
//
// Deliberately not the shared `util/consent-broker.ts` `ConsentBroker`, which broadcasts to every
// connected client and accepts any answer: the two computer-use brokers extend THIS class, which has
// no broadcast arm at all, so a computer-use prompt cannot be broadcast by mistake.
import { randomUUID } from "node:crypto";

import { notifyApprovalPending } from "../util/approval-pending.ts";

/** Writes one notification to one connection; `false` when that connection is not live. */
export type UnicastNotify = (clientId: string, method: string, params: unknown) => boolean;

/** Who answered a prompt: the server's own connection id and the client's declared source. */
export type CuAnswerFrom = {
  readonly clientId: string;
  /** As the client declared it; only the exact string `human` approves. */
  readonly answerSource: string | undefined;
};

interface Pending {
  readonly clientId: string;
  readonly resolve: (approved: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CuUnicastConsentBroker<TInput extends object> {
  private readonly pending = new Map<string, Pending>();
  private notify: UnicastNotify = () => false;

  constructor(private readonly requestMethod: string) {}

  setUnicast(fn: UnicastNotify): void {
    this.notify = fn;
  }

  /**
   * Ask the connection `clientId`, and only it. Resolves `false` at once when that connection is not
   * live (nobody else is asked instead), and `false` after `ttlMs` when nobody answers (fail closed).
   */
  requestFor(clientId: string, input: TInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      // NB: not `unref`'d, for the reason `util/consent-broker.ts` gives (a Windows `bun test` trap).
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, ttlMs);
      this.pending.set(requestId, { clientId, resolve, timer });
      const sent = this.notify(clientId, this.requestMethod, { requestId, ...input });
      if (!sent) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve(false);
        return;
      }
      notifyApprovalPending({ source: "broker", method: this.requestMethod });
    });
  }

  /**
   * An answer. It MATCHES only the connection the prompt was sent to: another connection's answer is
   * not even a denial and leaves the prompt open (`false` is returned). From the right connection it
   * settles the prompt, and approves only for `approved === true` with `answerSource === "human"`.
   */
  respondFrom(requestId: string, approved: boolean, from: CuAnswerFrom): boolean {
    const entry = this.pending.get(requestId);
    if (entry?.clientId !== from.clientId) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved === true && from.answerSource === "human");
    return true;
  }

  /** A connection went away: every prompt it was asked is a denial now (nobody else is asked). */
  onClientDisconnect(clientId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.clientId !== clientId) continue;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Cancel every pending request as a denial and drop it (shutdown, test `afterEach`). */
  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
}
