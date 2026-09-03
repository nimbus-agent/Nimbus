/**
 * A minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * NO DEPENDENCY, deliberately. `playwright-core` was the plan's first choice and failed a
 * `bun build --compile` gate outright (its `coreBundle.js` carries an unconditional,
 * statically-resolved `require("chromium-bidi/lib/cjs/…")` inside an unused WebDriver-BiDi
 * transport, which bun resolves eagerly), and the architecture requires the gateway binary to
 * "ship alone — no bun on PATH, no source tree beside it". Bun has a native `WebSocket`, and the
 * surface this lane needs — `Runtime.evaluate`, `DOM`/`Page`, `Fetch` request interception,
 * `Page.captureScreenshot` — is a few hundred lines of JSON framing. See the design spec § 14.
 */

/** The slice of `WebSocket` this client uses. Injected so tests drive a real in-process server. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", fn: () => void): void;
}

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`CDP ${method} failed: ${message}`);
    this.name = "CdpError";
  }
}

/** Default per-command ceiling. A wedged CDP call must not outlive the action that issued it. */
export const CDP_COMMAND_TIMEOUT_MS = 30_000;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

interface PendingCommand {
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * One CDP connection. Correlates command ids to responses, fans events out to listeners, and goes
 * permanently `closed` on transport loss.
 *
 * `closed` is one-way and every in-flight command rejects when it flips, so a browser that dies
 * mid-action surfaces as a prompt failure the gate can classify (`terminated_target_lost`) rather
 * than as a promise that never settles. That property is why `BrowserLane.isAlive()` exists at all.
 */
/**
 * The human-readable half of a CDP error object.
 *
 * Only a string `message` is used verbatim. `String(someObject)` yields "[object Object]",
 * which is worse than saying nothing — a CDP error whose `message` is structured would produce
 * a diagnostic that names no cause, from the layer whose entire job is explaining why the
 * browser refused. Falls back to the serialised error so the caller still gets the fields.
 *
 * Lifted out of `#onMessage` rather than inlined there: that method already carries the parse,
 * dispatch and listener fan-out branches, and adding this one pushed it past the cognitive
 * complexity limit. The extraction is the fix for that, not a second concern.
 */
function cdpErrorMessage(err: Record<string, unknown>): string {
  const raw = err["message"];
  if (typeof raw === "string" && raw !== "") return raw;
  return JSON.stringify(err) || "unknown error";
}

export class CdpConnection {
  #nextId = 0;
  #closed = false;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Set<(e: CdpEvent) => void>();

  constructor(
    private readonly socket: CdpSocket,
    private readonly commandTimeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
  ) {
    socket.addEventListener("message", (ev) => {
      this.#onMessage(ev.data);
    });
    socket.addEventListener("close", () => {
      this.#failAll("CDP transport closed");
    });
    socket.addEventListener("error", () => {
      this.#failAll("CDP transport error");
    });
  }

  isOpen(): boolean {
    return !this.#closed;
  }

  /** Subscribe to every protocol event. Returns an unsubscribe function. */
  on(listener: (e: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Issue one command and await its result.
   *
   * `sessionId` selects a flattened target session (`Target.attachToTarget` with `flatten: true`),
   * which is how every page-scoped domain call is addressed; omitting it addresses the browser.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return Promise.reject(new CdpError(method, "connection is closed"));
    }
    const id = ++this.#nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(method, `timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(method, e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /**
   * Fire-and-forget: a command whose result nobody awaits.
   *
   * Used ONLY for the two `Fetch` verdict verbs (`continueRequest`/`failRequest`). Awaiting those
   * would deadlock the interception loop: they are issued from inside a `Fetch.requestPaused`
   * handler, and Chromium can pause a second request before answering the first, so the handler
   * for request N would sit waiting on a response that arrives behind request N+1's event. The
   * ledger row is already durably appended before either verb is sent (that is the fail-closed
   * property, and it is unaffected here); what is not awaited is only Chromium's acknowledgement
   * that it applied a verdict it cannot decline.
   */
  sendAndForget(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (this.#closed) return;
    const id = ++this.#nextId;
    try {
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    } catch {
      // The transport is gone; `#failAll` has run or is about to. Nothing to recover here, and
      // throwing would replace a lane-level "target lost" with a driver-internal error.
    }
  }

  close(): void {
    this.#failAll("CDP connection closed by the gateway");
    try {
      this.socket.close();
    } catch {
      // Best-effort: an already-dead socket must not mask the reason we are closing.
    }
  }

  #onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    let msg: Record<string, unknown> | undefined;
    try {
      msg = asRecord(JSON.parse(text));
    } catch {
      return; // Not JSON: nothing this client can act on, and never a reason to tear down.
    }
    if (msg === undefined) return;

    const id = msg["id"];
    if (typeof id === "number") {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const err = asRecord(msg["error"]);
      if (err !== undefined) {
        pending.reject(new CdpError(pending.method, cdpErrorMessage(err)));
        return;
      }
      pending.resolve(asRecord(msg["result"]) ?? {});
      return;
    }

    const method = msg["method"];
    if (typeof method !== "string") return;
    const sessionId = msg["sessionId"];
    const event: CdpEvent = {
      method,
      params: asRecord(msg["params"]) ?? {},
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
    };
    for (const l of [...this.#listeners]) {
      try {
        l(event);
      } catch {
        // A listener that throws must not stop its siblings from seeing the event, and must not
        // take the transport down. The interception listener does its own fail-closed handling.
      }
    }
  }

  #failAll(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(p.method, reason));
    }
    this.#pending.clear();
  }
}
