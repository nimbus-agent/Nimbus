import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  type LedgerableContext,
  type LedgerableRoute,
  wrapLedgeredBrowserContext,
} from "../../egress/browser-egress.ts";
import type { BrowserLane, OpenBrowserLaneOptions } from "../cu-types.ts";
import {
  decodeObservation,
  normalizeObservedOrigin,
  observeExpression,
} from "./browser-observe.ts";
import { CdpConnection, type CdpEvent, type CdpSocket } from "./cdp-session.ts";

/**
 * The browser lane driver — raw CDP over a WebSocket.
 *
 * **This directory is the only place in the repo permitted to open a browser-automation channel**
 * (static rule D26(b)). Confining `performActuation` alone (D26(a)) does not carry invariant I35: a
 * new file could open its own CDP socket and dispatch `Input.dispatchMouseEvent` directly, reaching
 * the host without passing the gate's envelope check, structural classification, consent round-trip
 * or audit append. Same gap D22(d) closes for the agent emitters.
 *
 * What confines the browser this file launches, since it is NOT spawned through `SandboxRunner`
 * (see `CuBrowserLaunchPolicy` in `cu-types.ts` for the three PAL reasons it cannot be):
 *
 *  1. **Chromium's own multi-process sandbox**, intact. `browser-launch.ts`'s
 *     `assertBrowserLaunchPolicy` refuses, BEFORE consent, any argv carrying `--no-sandbox` or its
 *     siblings, so the renderers that parse attacker-controlled markup keep the strongest boundary
 *     available on each platform.
 *  2. **A Nimbus-owned profile directory**, asserted absolute and matched against the single
 *     `--user-data-dir` in the argv. No shared cookies, no shared history, no access to the owner's
 *     real browser profile (spec § 3.5).
 *  3. **The § 3.5.1 CDP request policy**, applied to EVERY request before it is allowed to proceed,
 *     through the ledgering decorator below.
 *  4. **Headless, with downloads denied at the browser level** — nothing this lane does can put a
 *     file on disk or a window on the owner's desktop.
 */

/** Injected process/transport seams, so the lane is drivable in tests without a real browser. */
export interface BrowserLaneRuntime {
  readonly spawnBrowser: (cmd: string, argv: readonly string[]) => ChildProcess;
  readonly connect: (url: string) => CdpSocket;
  readonly ensureProfileDir: (dir: string) => void;
  /** How long to wait for Chromium to print its DevTools endpoint on stderr. */
  readonly launchTimeoutMs: number;
}

export const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

export const defaultBrowserLaneRuntime: BrowserLaneRuntime = {
  spawnBrowser: (cmd, argv) =>
    // `windowsHide` hides the console Windows would otherwise allocate for this child of the
    // console-less Gateway. It does NOT hide the browser: the lane launches headless, and the
    // flag governs console allocation, not a GUI window. It changes nothing about the launch
    // policy asserted by `assertBrowserLaunchPolicy` (I35).
    spawn(cmd, [...argv], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
  connect: (url) => new WebSocket(url) as unknown as CdpSocket,
  ensureProfileDir: (dir) => {
    // Created AFTER consent, never before: making a directory for a session the owner may deny is
    // a side effect of asking the question, and the profile lock it implies would outlive the
    // refusal.
    mkdirSync(dir, { recursive: true });
  },
  launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
};

/** Chromium prints exactly this line on stderr once its DevTools endpoint is listening. */
const DEVTOOLS_LINE = /^DevTools listening on (ws:\/\/\S+)\s*$/m;

/** `readText` ceiling. The value crosses into a model prompt; an unbounded page must not. */
const READ_TEXT_MAX_CHARS = 100_000;

/** How long `close()` waits for a SIGTERMed browser to exit before escalating to SIGKILL. */
const BROWSER_SIGTERM_GRACE_MS = 5_000;
/** How long it then waits for the SIGKILL to land before returning anyway. */
const BROWSER_SIGKILL_GRACE_MS = 2_000;

/**
 * Trailing window of Chromium's stderr kept while scanning for the DevTools banner.
 *
 * The banner is one line and arrives within the first few hundred bytes, so a window this size
 * cannot lose it even if it is split across chunks (which it is — observed during bring-up).
 */
const STDERR_SCAN_MAX_CHARS = 64_000;

function waitForDevToolsUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const onStderr = (chunk: Buffer | string): void => {
      // Bounded: Chromium writes to stderr for its whole life (GPU warnings, DevTools chatter), and
      // this handler stays attached until the banner arrives. Without a cap, a browser that never
      // prints the line — or, before the detach below, one that ran for hours after printing it —
      // accumulates every byte of that into one string. The banner is in the first few hundred
      // bytes, so keeping a trailing window loses nothing and bounds the buffer.
      stderr = (stderr + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(
        -STDERR_SCAN_MAX_CHARS,
      );
      const m = DEVTOOLS_LINE.exec(stderr);
      const url = m?.[1];
      if (url !== undefined) finish(() => resolve(url));
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // DETACH. This handler exists only to find the DevTools banner; leaving it attached would
      // keep appending Chromium's lifetime stderr to a string nothing reads again.
      child.stderr?.off("data", onStderr);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `browser did not report a DevTools endpoint within ${timeoutMs}ms; stderr: ${stderr.slice(0, 2000)}`,
          ),
        ),
      );
    }, timeoutMs);

    child.stderr?.on("data", onStderr);
    child.once("error", (e) => {
      finish(() => reject(e));
    });
    child.once("exit", (code) => {
      // A browser that exits before printing its endpoint AND writes nothing to stderr is almost
      // always Chromium's singleton lock. `[computer_use] browser_profile_dir` is ONE directory
      // shared by every session (spec § 9, so a login survives across them), so a second CONCURRENT
      // session finds the profile held and exits immediately and silently — verified against a real
      // Chrome: exit code 21, empty stderr. The bare code tells an operator nothing, so the likely
      // cause is named. It stays a HINT rather than a claim: Chromium's exit codes are not stable
      // across versions, and other failures reach here the same way.
      const hint =
        stderr.trim() === ""
          ? " and wrote nothing to stderr — most often another computer-use session already holds" +
            " the shared browser profile directory, and only one browser-lane session can run at a time"
          : `; stderr: ${stderr.slice(0, 2000)}`;
      finish(() =>
        reject(
          new Error(
            `browser exited with code ${String(code)} before reporting a DevTools endpoint${hint}`,
          ),
        ),
      );
    });
  });
}

function openSocket(
  runtime: BrowserLaneRuntime,
  url: string,
  timeoutMs: number,
): Promise<CdpSocket> {
  return new Promise<CdpSocket>((resolve, reject) => {
    const socket = runtime.connect(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out connecting to the browser's CDP endpoint after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("failed to connect to the browser's CDP endpoint"));
    });
  });
}

function stringResult(result: Record<string, unknown>): string | null {
  const inner = result["result"];
  if (typeof inner !== "object" || inner === null) return null;
  const value = (inner as Record<string, unknown>)["value"];
  return typeof value === "string" ? value : null;
}

/**
 * A FINITE number at `key`, or null when the field is absent, non-numeric, `NaN` or infinite.
 *
 * The bounding box comes back from an untyped CDP payload, so an unusable field means the PAGE
 * did not produce a box a click can be aimed at — a page condition, which is why callers throw
 * their own domain message rather than a `TypeError` about a caller's argument. `NaN` is folded
 * in here deliberately: it survives a bare `typeof v === "number"` check and would otherwise
 * reach `Input.dispatchMouseEvent` as a coordinate.
 */
function finiteFieldOf(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rawValue(result: Record<string, unknown>): unknown {
  const inner = result["result"];
  return typeof inner === "object" && inner !== null
    ? (inner as Record<string, unknown>)["value"]
    : undefined;
}

/**
 * Launch a sandboxed browser and return the lane the gate drives.
 *
 * Called by `cu-gate.ts` ONLY after the owner has approved the session envelope, via the injected
 * `CuGateDeps.openLane` seam. `opts.launch` is the very object
 * `browser-launch.ts`'s `assertBrowserLaunchPolicy` cleared before that prompt, and its `argv` is
 * spawned VERBATIM — nothing is appended here — which is what makes the pre-consent assertion a
 * statement about the process that actually starts.
 */
export async function openBrowserLane(
  opts: OpenBrowserLaneOptions,
  runtime: BrowserLaneRuntime = defaultBrowserLaneRuntime,
): Promise<BrowserLane> {
  runtime.ensureProfileDir(opts.launch.profileDir);

  const child = runtime.spawnBrowser(opts.executablePath, opts.launch.argv);
  let conn: CdpConnection | undefined;
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  /**
   * Wait for the browser process to ACTUALLY exit, bounded.
   *
   * `close()` used to return the moment `child.kill()` had been *called*, which made it mean "a
   * signal was sent", not "the browser is gone". That is not a distinction without a difference:
   * `[computer_use] browser_profile_dir` is ONE directory shared by every session, and Chromium
   * holds a `SingletonLock` on it for as long as the process lives. So closing a session and
   * immediately opening another raced the dying process for the lock, and the new session died at
   * launch with `Failed to create …/SingletonLock: File exists (17)` — reported to the owner as
   * `ERR_CU_LAUNCH_FAILED`, with nothing in the message connecting it to the session they had just
   * closed.
   *
   * Found by the macOS CI leg, not locally: Windows happened to win the race every time, so a
   * green Windows run said nothing about it. That is the whole reason the cross-platform legs run
   * the same suite.
   *
   * Bounded and best-effort on purpose — `close()` is called from `bestEffortCloseLane` on every
   * terminal path, including ones that are already unwinding from a different failure, so it must
   * not hang or throw. If the browser has not gone after SIGTERM it is SIGKILLed; if it still has
   * not gone, `close()` returns anyway rather than blocking the gate forever.
   */
  const waitForChildExit = (timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (childExited) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        child.off("exit", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      child.once("exit", done);
    });

  const killBrowser = (signal?: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // Already gone. Nothing to recover, and this runs on paths that are already unwinding.
    }
  };

  /**
   * Signal, wait, escalate, wait — then give up rather than hang. Mirrors `exec-run.ts`'s own
   * SIGTERM-then-SIGKILL shape. The waits are what make `close()` mean "the profile lock is
   * released", which is the property a subsequent session depends on.
   */
  const shutDownBrowser = async (): Promise<void> => {
    killBrowser();
    await waitForChildExit(BROWSER_SIGTERM_GRACE_MS);
    if (childExited) return;
    killBrowser("SIGKILL");
    await waitForChildExit(BROWSER_SIGKILL_GRACE_MS);
  };

  try {
    const wsUrl = await waitForDevToolsUrl(child, runtime.launchTimeoutMs);
    const socket = await openSocket(runtime, wsUrl, runtime.launchTimeoutMs);
    conn = new CdpConnection(socket);

    // A dedicated page target, never the one Chromium happens to have open: `--disable-extensions`
    // does not stop component extensions with background pages, and one showed up as a live target
    // during bring-up. Attaching to "whatever is first" would sometimes attach to that instead.
    const created = await conn.send("Target.createTarget", { url: "about:blank" });
    const targetId = created["targetId"];
    if (typeof targetId !== "string") {
      throw new TypeError("browser did not return a target id for the lane's page");
    }
    const attached = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached["sessionId"];
    if (typeof sessionId !== "string") {
      throw new TypeError("browser did not return a CDP session id for the lane's page");
    }

    // Track the page's own origin from protocol events, because `BrowserLane.currentOrigin()` is
    // SYNCHRONOUS: the classifier reads it while deciding, and a round trip there would make the
    // decision depend on a value that could change between the read and the classification.
    let currentUrl = "about:blank";
    conn.on((e: CdpEvent) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === "Page.frameNavigated") {
        const frame = e.params["frame"];
        if (typeof frame === "object" && frame !== null) {
          const f = frame as Record<string, unknown>;
          // Main frame only — a sub-frame navigation does not change the page's own origin, and
          // treating it as if it did would let an embedded iframe move the origin the classifier
          // compares a click's href against.
          if (f["parentId"] === undefined && typeof f["url"] === "string") currentUrl = f["url"];
        }
      }
    });

    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    await conn.send("DOM.enable", {}, sessionId);
    // Downloads are denied at the BROWSER level, not merely unimplemented in `performActuation`.
    // Spec § 7's "nothing this lane does puts a file on disk" must not rest on the gate refusing a
    // `download` action kind: a page can start a download on its own, with no action at all.
    await conn.send("Browser.setDownloadBehavior", { behavior: "deny" });

    const activeConn = conn;

    /**
     * The driver-side `LedgerableContext`: CDP's `Fetch` domain in the shape Task 8's appender
     * expects. `Fetch.requestPaused` → one `LedgerableRoute`; `continue()`/`abort()` →
     * `Fetch.continueRequest`/`Fetch.failRequest`.
     *
     * `resourceType()` returns the RAW CDP string (`"Document"`, `"XHR"`, …), NOT a value
     * pre-mapped into `CuResourceType`. That is deliberate: the guard belongs at the appender's
     * boundary (`browser-egress.ts`, via `toCuResourceType`), where an unrecognised protocol value
     * fails closed into the gated branch and the raw string is preserved for the ledger row. A
     * driver that mapped first would hand the appender a value that always looked recognised.
     */
    const cdpContext: LedgerableContext = {
      route: async (_pattern, handler) => {
        activeConn.on((e: CdpEvent) => {
          if (e.method !== "Fetch.requestPaused" || e.sessionId !== sessionId) return;
          const requestId = e.params["requestId"];
          const request = e.params["request"];
          if (typeof requestId !== "string" || typeof request !== "object" || request === null) {
            return;
          }
          const url = (request as Record<string, unknown>)["url"];
          const resourceType = e.params["resourceType"];
          const route: LedgerableRoute = {
            request: () => ({
              url: () => (typeof url === "string" ? url : ""),
              resourceType: () => (typeof resourceType === "string" ? resourceType : "Other"),
            }),
            continue: async () => {
              activeConn.sendAndForget("Fetch.continueRequest", { requestId }, sessionId);
            },
            abort: async () => {
              activeConn.sendAndForget(
                "Fetch.failRequest",
                { requestId, errorReason: "BlockedByClient" },
                sessionId,
              );
            },
          };
          void handler(route).catch(() => {
            // The ONLY way here is the appender throwing `EgressAppendFailedError` — its verdict
            // logic cannot otherwise reject. Fail closed in both dimensions: this request never
            // proceeds, AND the transport is torn down so no LATER request can proceed unrecorded
            // either. `isAlive()` then reports false and the gate terminates the session on its
            // next action rather than letting it run on with a ledger that cannot record it.
            activeConn.sendAndForget(
              "Fetch.failRequest",
              { requestId, errorReason: "BlockedByClient" },
              sessionId,
            );
            activeConn.close();
          });
        });
        await activeConn.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      },
    };

    // THE `browser` EGRESS CLASS'S PRODUCTION CALLER (I29). Every request the lane makes is routed
    // through the ledgering decorator BEFORE it is allowed to proceed, and an append failure aborts
    // it — so a zero-row window means no request was made, never that one was made unrecorded.
    // `THIS_BINARY_COVERAGE.browser` is raised to `"per-run"` in the same commit as this line, per
    // `egress-coverage.ts`'s own rule.
    const ledgered = wrapLedgeredBrowserContext(cdpContext, {
      db: opts.db,
      sessionId: opts.sessionId,
      target: opts.target,
      now: () => Date.now(),
    });
    // The decorator REPLACES the routed handler — its gate-then-continue/abort logic IS the whole
    // handler, and the argument passed here is invoked only for requests it has already decided to
    // allow and already ledgered. The driver deliberately has no routing logic of its own.
    await ledgered.route("*", async () => {});

    const evaluate = async (expression: string): Promise<Record<string, unknown>> =>
      await activeConn.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);

    /** Resolve a selector to a click point, or throw. Shared by `click`. */
    const centerOf = async (selector: string): Promise<{ x: number; y: number }> => {
      const res = await evaluate(
        `JSON.stringify((function (s) {
          var el = document.querySelector(s);
          if (el === null) return null;
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
          var r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        })(${JSON.stringify(selector)}))`,
      );
      const text = stringResult(res);
      if (text === null) throw new Error(`could not resolve a click point for: ${selector}`);
      const box: unknown = JSON.parse(text);
      if (typeof box !== "object" || box === null) {
        throw new Error(`no element matched selector: ${selector}`);
      }
      const b = box as Record<string, unknown>;
      const x = finiteFieldOf(b, "x");
      const y = finiteFieldOf(b, "y");
      const w = finiteFieldOf(b, "w");
      const h = finiteFieldOf(b, "h");
      if (x === null || y === null) {
        throw new Error(`no element matched selector: ${selector}`);
      }
      // A zero-area box is an element that is present in the DOM but not rendered. Dispatching a
      // mouse event at its centre would hit whatever IS at that coordinate — a different control
      // than the one the owner saw described in the prompt. Refuse rather than click a stranger.
      if (w === null || h === null || w <= 0 || h <= 0) {
        throw new Error(`element is not visible and cannot be clicked: ${selector}`);
      }
      return { x, y };
    };

    const lane: BrowserLane = {
      observe: async (selector) => {
        const res = await evaluate(observeExpression(selector));
        return decodeObservation(rawValue(res));
      },

      currentOrigin: () => {
        try {
          return normalizeObservedOrigin(new URL(currentUrl).origin);
        } catch {
          return null;
        }
      },

      click: async (selector) => {
        const { x, y } = await centerOf(selector);
        const base = { x, y, button: "left", clickCount: 1, buttons: 1 };
        await activeConn.send(
          "Input.dispatchMouseEvent",
          { ...base, type: "mouseMoved", buttons: 0 },
          sessionId,
        );
        await activeConn.send(
          "Input.dispatchMouseEvent",
          { ...base, type: "mousePressed" },
          sessionId,
        );
        await activeConn.send(
          "Input.dispatchMouseEvent",
          { ...base, type: "mouseReleased" },
          sessionId,
        );
      },

      type: async (selector, text) => {
        // Focus + select-the-existing-value + `Input.insertText`, which is `fill()` semantics
        // without a synthetic key event anywhere in it. That is load-bearing rather than
        // convenient: `Input.insertText` CANNOT press Enter, so this action can never submit the
        // form it types into, which is exactly the property `BrowserActionInput.submitsForm`
        // documents as "not reachable in the shipped surface yet". A `dispatchKeyEvent`-based
        // implementation would make it reachable and would need the classifier's I7 rule live.
        const focused = await evaluate(
          `(function (s) {
             var el = document.querySelector(s);
             if (el === null) return false;
             el.focus();
             if (typeof el.select === 'function') el.select();
             return document.activeElement === el;
           })(${JSON.stringify(selector)})`,
        );
        if (rawValue(focused) !== true) {
          throw new Error(`could not focus an element for selector: ${selector}`);
        }
        await activeConn.send("Input.insertText", { text }, sessionId);
      },

      navigate: async (url) => {
        const res = await activeConn.send("Page.navigate", { url }, sessionId);
        const errorText = res["errorText"];
        if (typeof errorText === "string" && errorText !== "") {
          throw new Error(`navigation failed: ${errorText}`);
        }
        const frameId = res["frameId"];
        // `Page.navigate` resolves when the navigation COMMITS, not when the document is ready, so
        // a `readText`/`observe` issued straight after would see the previous document. Wait for
        // the main frame's load event, bounded — a page that never fires `load` (a long-polling
        // endpoint, a stalled subresource) must not wedge the action; the DOM is usually usable
        // anyway, so a timeout here proceeds rather than failing the action.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            off();
            resolve();
          }, 15_000);
          const off = activeConn.on((e: CdpEvent) => {
            if (e.sessionId !== sessionId) return;
            if (e.method !== "Page.frameStoppedLoading" && e.method !== "Page.loadEventFired") {
              return;
            }
            if (e.method === "Page.frameStoppedLoading" && e.params["frameId"] !== frameId) return;
            clearTimeout(timer);
            off();
            resolve();
          });
        });
      },

      readText: async () => {
        const res = await evaluate("document.body ? document.body.innerText : ''");
        return (stringResult(res) ?? "").slice(0, READ_TEXT_MAX_CHARS);
      },

      domSnapshot: async () => {
        const res = await evaluate(
          "document.documentElement ? document.documentElement.outerHTML : ''",
        );
        return stringResult(res) ?? "";
      },

      // Returned to the caller in memory and hashed by `performActuation`. NEVER written to disk
      // (spec § 7): `Page.captureScreenshot` returns base64 in the protocol response, and this file
      // deliberately contains no filesystem write of any kind for it — the enforcement test scans
      // this whole file for every persisting API this repo uses.
      screenshot: async () => {
        const res = await activeConn.send("Page.captureScreenshot", { format: "png" }, sessionId);
        const data = res["data"];
        if (typeof data !== "string") throw new Error("browser returned no screenshot data");
        return Uint8Array.from(Buffer.from(data, "base64"));
      },

      isAlive: () => !childExited && activeConn.isOpen(),

      close: async () => {
        activeConn.close();
        // AWAITED: `close()` resolving must mean the browser is gone and its profile
        // `SingletonLock` released, not merely that a signal was sent. See `waitForChildExit`.
        await shutDownBrowser();
      },
    };

    return lane;
  } catch (e) {
    // The browser process may already be running even though the lane never became usable. Nothing
    // else holds a reference to it at this point, so leaving it would leak a headless browser with
    // a live CDP endpoint and a lock on the profile directory — making every LATER session fail
    // with an error about the profile rather than about this failure.
    conn?.close();
    // AWAITED here too: a failed launch must release the profile `SingletonLock` before this
    // rejects, or the very next `openSession` — which an owner is likely to attempt immediately,
    // having just been told the browser failed to start — races the dying process and fails the
    // same way, with an error naming a lock rather than the original cause.
    await shutDownBrowser();
    throw e;
  }
}
