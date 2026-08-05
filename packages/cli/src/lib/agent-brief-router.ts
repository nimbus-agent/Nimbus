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

/** Which notification channel an envelope arrived on — threaded through so a malformed-payload
 * error names the channel it actually came from, rather than always saying `briefReady`. */
type NotificationKind = "briefReady" | "briefError";

interface BufferedEnvelope {
  readonly env: BriefEnvelope;
  readonly kind: NotificationKind;
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
 *
 * A gateway can emit an envelope with no sessionId at all (a legacy/malformed payload, or a
 * `briefError` that fired before the caller round-trip that would have supplied one). That
 * envelope is attributable exactly when there is exactly one waiter in flight for the agent —
 * see `route()` — so the real error surfaces immediately for the single-caller case that
 * dominates real usage, without ever guessing across two-or-more concurrent callers.
 */
export class AgentBriefRouter {
  private readonly bound = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly buffered = new Map<string, BufferedEnvelope[]>();

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
      this.route(agentName, params as BriefEnvelope, "briefReady");
    });
    this.source.onNotification(`${agentName}.briefError`, (params: unknown) => {
      this.route(agentName, params as BriefEnvelope, "briefError");
    });
  }

  private route(agentName: string, env: BriefEnvelope, kind: NotificationKind): void {
    const sessionId = typeof env.sessionId === "string" ? env.sessionId : undefined;

    if (sessionId !== undefined) {
      for (const w of this.waiters) {
        if (w.agentName === agentName && w.sessionId === sessionId) {
          this.apply(w, env, kind);
          return;
        }
      }
    } else {
      // No sessionId to key on. Attribution is only unambiguous when exactly one waiter is
      // in flight for this agent — deliver to it whether or not it has bound yet, since it is
      // the sole possible recipient either way. With zero or two-or-more waiters the envelope
      // genuinely cannot be attributed, so it is buffered (and the waiter(s) time out) rather
      // than guessed at: guessing would defeat the no-cross-delivery guarantee this router
      // exists to provide.
      let sole: Waiter | undefined;
      let count = 0;
      for (const w of this.waiters) {
        if (w.agentName === agentName) {
          count += 1;
          sole = w;
        }
      }
      if (count === 1 && sole !== undefined) {
        this.apply(sole, env, kind);
        return;
      }
    }

    // No unambiguous recipient yet — buffer for a waiter that binds this exact sessionId later.
    const list = this.buffered.get(agentName) ?? [];
    if (list.length >= MAX_BUFFERED_PER_AGENT) list.shift();
    list.push({ env, kind });
    this.buffered.set(agentName, list);
  }

  private drainBuffered(waiter: Waiter): void {
    const list = this.buffered.get(waiter.agentName);
    if (list === undefined) return;
    const idx = list.findIndex((e) => e.env.sessionId === waiter.sessionId);
    if (idx === -1) return;
    const [entry] = list.splice(idx, 1);
    if (entry !== undefined) this.apply(waiter, entry.env, entry.kind);
  }

  private apply(waiter: Waiter, env: BriefEnvelope, kind: NotificationKind): void {
    if (typeof env.error === "string") {
      this.finish(waiter, new Error(env.error));
      return;
    }
    if (
      typeof env.brief !== "string" ||
      (waiter.guard !== undefined && !waiter.guard(env.findings))
    ) {
      this.finish(waiter, new Error(`Malformed ${waiter.agentName}.${kind} payload`));
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
