/** Minimal surface the router needs — structurally satisfied by IPCClient. */
export interface BriefNotificationSource {
  onNotification(method: string, handler: (params: unknown) => void): void;
}

export interface PendingBrief<T> {
  readonly result: Promise<{ brief: string; findings: T }>;
  /** Bind the sessionId returned by the `agents.*` call. Replays any buffered notification. */
  bindSession(sessionId: string): void;
  /** Reject this waiter (e.g. transport death observed by the owner). Idempotent. */
  fail(err: Error): void;
  /** Drop this waiter without settling its promise's consumers further. Idempotent. */
  cancel(): void;
}

interface Waiter {
  readonly agentName: string;
  readonly guard: ((x: unknown) => boolean) | undefined;
  readonly settle: (outcome: { brief: string; findings: unknown } | Error) => void;
  sessionId: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  done: boolean;
}

interface BriefEnvelope {
  sessionId?: unknown;
  brief?: unknown;
  findings?: unknown;
  error?: unknown;
}

/** Cap on notifications held for a not-yet-bound waiter, so a misbehaving gateway cannot grow memory. */
const MAX_BUFFERED_PER_AGENT = 32;

/**
 * Routes `<agent>.briefReady` / `<agent>.briefError` notifications to the waiter that started
 * them, keyed by sessionId.
 *
 * Two properties the previous implementation lacked:
 *  - notifications are matched by sessionId, not merely by agent name, so concurrent callers
 *    cannot receive each other's briefs;
 *  - at most one listener pair is registered per agent name for the source's lifetime, so a
 *    long-lived server does not accumulate a handler per invocation.
 */
export class AgentBriefRouter {
  private readonly bound = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly buffered = new Map<string, BriefEnvelope[]>();

  constructor(private readonly source: BriefNotificationSource) {}

  expect<T>(
    agentName: string,
    guard: ((x: unknown) => x is T) | undefined,
    timeoutMs: number,
  ): PendingBrief<T> {
    this.bindListeners(agentName);

    let settleFn: (outcome: { brief: string; findings: unknown } | Error) => void = () => {};
    const result = new Promise<{ brief: string; findings: T }>((resolve, reject) => {
      settleFn = (outcome): void => {
        if (outcome instanceof Error) reject(outcome);
        else resolve({ brief: outcome.brief, findings: outcome.findings as T });
      };
    });

    const waiter: Waiter = {
      agentName,
      guard,
      settle: settleFn,
      sessionId: undefined,
      timer: undefined,
      done: false,
    };
    waiter.timer = setTimeout(() => {
      this.finish(waiter, new Error(`Agent timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    this.waiters.add(waiter);

    return {
      result,
      bindSession: (sessionId: string): void => {
        if (waiter.done) return;
        waiter.sessionId = sessionId;
        this.drainBuffered(waiter);
      },
      fail: (err: Error): void => {
        this.finish(waiter, err);
      },
      cancel: (): void => {
        this.finish(waiter, undefined);
      },
    };
  }

  /**
   * Reject every in-flight waiter. Called when the owner observes transport death: the awaited
   * notification can never arrive, so waiting out the timeout only delays a knowable answer and
   * reports it under the wrong error.
   */
  failAll(err: Error): void {
    for (const w of [...this.waiters]) this.finish(w, err);
    this.buffered.clear();
  }

  private bindListeners(agentName: string): void {
    if (this.bound.has(agentName)) return;
    this.bound.add(agentName);
    this.source.onNotification(`${agentName}.briefReady`, (params: unknown) => {
      this.route(agentName, params as BriefEnvelope);
    });
    this.source.onNotification(`${agentName}.briefError`, (params: unknown) => {
      this.route(agentName, params as BriefEnvelope);
    });
  }

  private route(agentName: string, env: BriefEnvelope): void {
    const sessionId = typeof env.sessionId === "string" ? env.sessionId : undefined;
    for (const w of this.waiters) {
      if (w.agentName === agentName && w.sessionId !== undefined && w.sessionId === sessionId) {
        this.apply(w, env);
        return;
      }
    }
    // No bound waiter yet — buffer for a waiter that has not learned its sessionId.
    const list = this.buffered.get(agentName) ?? [];
    if (list.length >= MAX_BUFFERED_PER_AGENT) list.shift();
    list.push(env);
    this.buffered.set(agentName, list);
  }

  private drainBuffered(waiter: Waiter): void {
    const list = this.buffered.get(waiter.agentName);
    if (list === undefined) return;
    const idx = list.findIndex((e) => e.sessionId === waiter.sessionId);
    if (idx === -1) return;
    const [env] = list.splice(idx, 1);
    if (env !== undefined) this.apply(waiter, env);
  }

  private apply(waiter: Waiter, env: BriefEnvelope): void {
    if (typeof env.error === "string") {
      this.finish(waiter, new Error(env.error));
      return;
    }
    if (
      typeof env.brief !== "string" ||
      (waiter.guard !== undefined && !waiter.guard(env.findings))
    ) {
      this.finish(waiter, new Error(`Malformed ${waiter.agentName}.briefReady payload`));
      return;
    }
    this.finish(waiter, { brief: env.brief, findings: env.findings });
  }

  private finish(
    waiter: Waiter,
    outcome: { brief: string; findings: unknown } | Error | undefined,
  ): void {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    this.waiters.delete(waiter);

    // Drop this agent's buffer once nothing is waiting on it. A waiter whose `agents.*` call failed
    // before returning a sessionId never binds, so its envelope would otherwise sit until 32 more
    // pushed it out. Hygiene rather than correctness: matching is by exact sessionId, so a stale
    // envelope can never be delivered to the wrong waiter — it can only occupy space.
    let stillWaiting = false;
    for (const w of this.waiters) {
      if (w.agentName === waiter.agentName) {
        stillWaiting = true;
        break;
      }
    }
    if (!stillWaiting) this.buffered.delete(waiter.agentName);

    if (outcome !== undefined) waiter.settle(outcome);
  }
}
