import { randomUUID } from "node:crypto";

export type ConsentBroadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owner-approval round-trip shared by the outbound-share publish gate (I27) and the inbound
 * federated-preflight gate (I24). A request is broadcast to all connected local clients under
 * `requestMethod`; the owner answers via the paired RPC → {@link ConsentBroker.respond}. A TTL
 * safety-net resolves `false` (deny) if the owner never answers — fail-closed.
 *
 * `TInput` is the per-gate request payload (spread into the broadcast alongside the generated
 * `requestId`); subclasses bind the concrete payload type + the broadcast method name.
 */
export class ConsentBroker<TInput extends object> {
  private readonly pending = new Map<string, Pending>();
  private broadcast: ConsentBroadcast = () => {};

  constructor(private readonly requestMethod: string) {}

  setBroadcast(fn: ConsentBroadcast): void {
    this.broadcast = fn;
  }

  request(input: TInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      // NB: do NOT call `timer.unref()`. An awaited promise that settles from an `unref`'d timer
      // makes `bun test` spin forever on Windows (a known runtime trap). The gateway is long-lived
      // so the bounded TTL timer holding the loop is harmless, and `clear()` cancels timers on
      // shutdown — `respond()` clears the timer the instant the owner answers.
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, ttlMs);
      this.pending.set(requestId, { resolve, timer });
      this.broadcast(this.requestMethod, { requestId, ...input });
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

  /**
   * Cancel and drop every pending request, clearing each TTL timer. Callers that hold no live
   * promise (fire-and-forget `request()` whose result is ignored) MUST be able to release the
   * timer — otherwise a dangling `unref`'d timer hangs `bun test` teardown on Windows. Safe to
   * call on shutdown and from test `afterEach`.
   */
  clear(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
