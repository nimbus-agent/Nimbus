import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import {
  type ComputerClient,
  CU_EXIT_CODES,
  formatEnvelopePrompt,
  handleActionBroadcast,
  handleEnvelopeBroadcast,
  onProcessInterrupt,
  parseComputerBrowserArgs,
  REFUSAL_MESSAGES,
  type RunComputerDeps,
  runComputer,
} from "./computer.ts";

/**
 * Branches `computer.test.ts` leaves unexercised: duration rendering without a zero unit, the
 * fallbacks a malformed broadcast renders, the respond wiring of both prompt kinds, a second
 * interrupt landing in the poll SLEEP, the `sessions`/`close` failure and non-closed paths, and the
 * production signal registrar. Everything except the two production-default checks at the end runs
 * through injected deps; nothing reaches a gateway and no real signal is raised.
 */

interface StatusEntry {
  readonly sessionId: string;
  readonly lane: string;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly actionsUsed: number;
  readonly open: boolean;
}

function entry(over: Partial<StatusEntry> = {}): StatusEntry {
  return {
    sessionId: "sess-c",
    lane: "browser",
    closedAt: 1,
    closeReason: null,
    actionsUsed: 0,
    open: false,
    ...over,
  };
}

type Notify = (method: string, params: unknown) => Promise<unknown>;
type CallImpl = (method: string, params: unknown, notify: Notify) => unknown;

interface Controls {
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly calls: Array<{ method: string; params: unknown }>;
  readonly fireSignal: () => void;
}

/**
 * A fake gateway client plus every injected seam. `callImpl` answers each RPC and may raise a
 * broadcast through `notify`, which runs the handler the command registered for it.
 */
function harness(
  callImpl: CallImpl,
  over: (c: Controls) => Partial<RunComputerDeps> = () => ({}),
): Controls & { deps: RunComputerDeps } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, (params: unknown) => unknown>();
  const signalHandlers: Array<() => void> = [];
  const notify: Notify = async (method, params) => handlers.get(method)?.(params);
  const client: ComputerClient = {
    onNotification: (method, handler) => {
      handlers.set(method, handler);
    },
    call: async (method, params) => {
      calls.push({ method, params });
      return callImpl(method, params, notify);
    },
  };
  const controls: Controls = {
    out,
    err,
    codes,
    calls,
    fireSignal: () => {
      for (const h of [...signalHandlers]) h();
    },
  };
  const deps: RunComputerDeps = {
    runWithClient: async <T>(fn: (c: ComputerClient) => Promise<T>) => fn(client),
    ask: async () => true,
    sink: { out: (s) => out.push(s), err: (s) => err.push(s) },
    setExitCode: (c) => codes.push(c),
    sleep: async () => {},
    onSignal: (handler) => {
      signalHandlers.push(handler);
      return () => {
        const i = signalHandlers.indexOf(handler);
        if (i >= 0) signalHandlers.splice(i, 1);
      };
    },
    ...over(controls),
  };
  return { ...controls, deps };
}

/** A gateway that opens `sess-c` and reports `status(poll)` for each status poll. */
function openThen(status: (poll: number) => StatusEntry): CallImpl {
  let polls = 0;
  return (method) => {
    if (method === "computer.sessionOpen") return { status: "open", sessionId: "sess-c" };
    if (method === "computer.sessionStatus") {
      polls += 1;
      return { sessions: [status(polls)] };
    }
    return { status: "closed" };
  };
}

const methods = (c: Controls): string[] => c.calls.map((x) => x.method);

describe("parseComputerBrowserArgs — --timeout", () => {
  test("a zero, negative or non-numeric --timeout is refused with the BROWSER usage", () => {
    for (const bad of ["0", "-5", "soon"]) {
      let message = "";
      try {
        parseComputerBrowserArgs(["--origin", "https://example.com", "--timeout", bad]);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("--timeout must be a positive integer (seconds)");
      expect(message).toContain("nimbus computer browser");
      // The browser parser's own usage, never the terminal lane's.
      expect(message).not.toContain("nimbus computer terminal");
      expect(message).not.toContain("--max-actions must be");
    }
  });
});

describe("formatEnvelopePrompt — duration rendering", () => {
  const prompt = (maxWallClockMs: number): string =>
    formatEnvelopePrompt({
      lane: "browser",
      sessionId: "s",
      navigateOrigins: ["https://example.com"],
      scriptOrigins: [],
      maxActions: 1,
      maxWallClockMs,
    });

  // The time limit is the prompt's LAST line, so each expectation is anchored to the end.
  test("whole hours print no zero-minute or zero-second unit", () => {
    expect(prompt(7_200_000)).toMatch(/\n {2}time limit: {5}7200000 ms \(2h\)$/);
  });

  test("hours plus seconds skip the empty minute unit", () => {
    expect(prompt(3_630_000)).toMatch(/\n {2}time limit: {5}3630000 ms \(1h 30s\)$/);
  });

  test("a seconds-only duration prints just the seconds", () => {
    expect(prompt(5_000)).toMatch(/\n {2}time limit: {5}5000 ms \(5s\)$/);
  });
});

describe("broadcast handlers — malformed input", () => {
  function recorder(answer: unknown) {
    const shown: string[] = [];
    const answered: Array<{ requestId: string; approved: boolean }> = [];
    return {
      shown,
      answered,
      ask: async (m: string) => {
        shown.push(m);
        return answer;
      },
      respond: async (requestId: string, approved: boolean) => {
        answered.push({ requestId, approved });
      },
    };
  }

  test("a null or undefined envelope broadcast is ignored — nothing shown, nothing answered", async () => {
    const r = recorder(true);
    await handleEnvelopeBroadcast(null, r.ask, r.respond);
    await handleEnvelopeBroadcast(undefined, r.ask, r.respond);
    expect(r.shown).toEqual([]);
    expect(r.answered).toEqual([]);
  });

  test("a null or undefined action broadcast is ignored — nothing shown, nothing answered", async () => {
    const r = recorder(true);
    await handleActionBroadcast(null, r.ask, r.respond);
    await handleActionBroadcast(undefined, r.ask, r.respond);
    expect(r.shown).toEqual([]);
    expect(r.answered).toEqual([]);
  });

  test("a terminal envelope missing every field renders explicit fallbacks and is still answered", async () => {
    const r = recorder(false);
    await handleEnvelopeBroadcast(
      { requestId: "t1", lane: "terminal", shellId: 7, cwd: null, maxActions: "9" },
      r.ask,
      r.respond,
    );
    expect(r.shown).toHaveLength(1);
    const shown = r.shown[0] ?? "";
    expect(shown).toContain("  session:        unknown\n");
    expect(shown).toContain("  shell:          unknown\n");
    expect(shown).toContain("  directory:      unknown\n");
    // A non-number bound is shown as 0, never echoed from the wire.
    expect(shown).toContain("  max actions:    0\n");
    expect(shown).toContain("  time limit:     0 ms (0ms)");
    expect(r.answered).toEqual([{ requestId: "t1", approved: false }]);
  });

  test("an action broadcast carrying only a requestId renders every fallback, the model line as (none)", async () => {
    const r = recorder(true);
    await handleActionBroadcast({ requestId: "a9" }, r.ask, r.respond);
    expect(r.shown).toEqual([
      [
        "--- Approve this computer-use action? ---",
        "  action:            unknown  (#0, 0/0 actions used)",
        "  gateway observed:  unknown  [unknown: unknown]",
        "  model said (UNTRUSTED — a claim, not a fact): (none)",
      ].join("\n"),
    ]);
    expect(r.answered).toEqual([{ requestId: "a9", approved: true }]);
  });
});

describe("runComputer browser — open parameters and refusals", () => {
  test("--max-actions and --timeout reach computer.sessionOpen as maxActions / maxWallClockMs", async () => {
    const h = harness(openThen(() => entry({ closeReason: "owner" })));
    await runComputer(
      ["browser", "--origin", "https://example.com", "--max-actions", "4", "--timeout", "15"],
      h.deps,
    );
    const open = h.calls.find((c) => c.method === "computer.sessionOpen");
    expect(open?.params).toEqual({
      lane: "browser",
      navigateOrigins: ["https://example.com"],
      scriptOrigins: [],
      maxActions: 4,
      maxWallClockMs: 15_000,
    });
    expect(h.codes).toEqual([0]);
  });

  test("a refusal code this build has no message for is named verbatim, not hidden", async () => {
    const h = harness((method) =>
      method === "computer.sessionOpen" ? { status: "refused", code: "ERR_CU_FUTURE" } : {},
    );
    await runComputer(["browser", "--origin", "https://example.com"], h.deps);
    expect(h.err).toEqual(["nimbus: refused (ERR_CU_FUTURE)\n"]);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
    // Refused before anything opened: the watch loop never ran.
    expect(methods(h)).toEqual(["computer.sessionOpen"]);
  });

  test("a refusal that carries no code at all reports it as unknown", async () => {
    const h = harness((method) => (method === "computer.sessionOpen" ? { status: "refused" } : {}));
    await runComputer(["browser", "--origin", "https://example.com"], h.deps);
    expect(h.err).toEqual(["nimbus: refused (unknown)\n"]);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
  });

  test("every refusal code in the table gets its own message, never the generic fallback", async () => {
    // Iterated from the table itself, not a hand-copied list of its keys: a code added later is
    // held to the same rule without anyone remembering to extend this test.
    const codes = Object.keys(REFUSAL_MESSAGES);
    // The codes the gateway's gate sends today are all still in it (a deleted message fails here).
    expect(codes).toEqual(
      expect.arrayContaining([
        "ERR_CU_NO_BROWSER",
        "ERR_CU_UNSAFE_LAUNCH",
        "ERR_CU_DISABLED",
        "ERR_CU_POLICY_DISABLED",
        "ERR_CU_LANE_NOT_ALLOWED",
        "ERR_CU_BAD_ORIGIN",
        "ERR_CU_BAD_BOUNDS",
        "ERR_CU_LAUNCH_FAILED",
        "ERR_CU_NO_SHELL",
        "ERR_CU_UNKNOWN_SHELL",
        "ERR_CU_SANDBOX_DEGRADED",
        "ERR_CU_TERMINAL_NETWORK_UNSUPPORTED",
        "ERR_CU_TERMINAL_RELATIVE_CWD",
      ]),
    );
    const messages: string[] = [];
    for (const code of codes) {
      const h = harness((method) =>
        method === "computer.sessionOpen" ? { status: "refused", code } : {},
      );
      await runComputer(["terminal", "--cwd", "."], h.deps);
      const message = h.err.join("");
      expect(message).toBe(`${REFUSAL_MESSAGES[code]}\n`);
      expect(message.startsWith("nimbus: ")).toBe(true);
      expect(message).not.toContain("refused (");
      messages.push(message);
    }
    expect(new Set(messages).size).toBe(codes.length);
  });
});

describe("runComputer — watching a session", () => {
  test("a close with no reason prints a bare 'Session closed.' and exits 0", async () => {
    const h = harness(openThen(() => entry({ closeReason: null, actionsUsed: 3 })));
    await runComputer(["browser", "--origin", "https://example.com"], h.deps);
    expect(h.out).toEqual(["Session opened: sess-c\n", "actions used: 3\n", "Session closed.\n"]);
    expect(h.codes).toEqual([0]);
  });

  test("both prompt kinds are answered over computer.approvalRespond with the owner's own decision", async () => {
    const asked: string[] = [];
    let polls = 0;
    const h = harness(
      async (method, _params, notify) => {
        if (method === "computer.sessionOpen") {
          // The envelope prompt fires DURING the open call, as it does on a real gateway.
          await notify("computer.envelopeRequest", {
            requestId: "env-1",
            sessionId: "sess-c",
            lane: "browser",
            navigateOrigins: ["https://example.com"],
            scriptOrigins: [],
            maxActions: 3,
            maxWallClockMs: 60_000,
          });
          return { status: "open", sessionId: "sess-c" };
        }
        if (method === "computer.sessionStatus") {
          polls += 1;
          if (polls === 1) {
            // Something else actuating the session raises a per-action prompt mid-watch.
            await notify("computer.actionRequest", {
              requestId: "act-1",
              sessionId: "sess-c",
              seq: 1,
              kind: "click",
              observedTarget: "button#buy",
              classification: "actuating",
              why: "submit control",
              actionsUsed: 0,
              maxActions: 3,
              modelDescription: "just looking",
            });
            return { sessions: [entry({ open: true, closedAt: null })] };
          }
          return { sessions: [entry({ actionsUsed: 1, closeReason: "owner" })] };
        }
        return { ok: true };
      },
      () => ({
        // Approve the envelope, deny the action — so a response that ignored the answer, or
        // swapped the two request ids, cannot pass.
        ask: async (message: string) => {
          asked.push(message);
          return message.startsWith("=== Open a computer-use session? ===");
        },
      }),
    );
    await runComputer(["browser", "--origin", "https://example.com"], h.deps);
    const responses = h.calls.filter((c) => c.method === "computer.approvalRespond");
    expect(responses.map((c) => c.params)).toEqual([
      { requestId: "env-1", approved: true },
      { requestId: "act-1", approved: false },
    ]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("gateway observed:  button#buy");
    expect(h.codes).toEqual([0]);
  });

  test("a second interrupt that lands in the poll SLEEP stops waiting at once", async () => {
    // The sleep below never resolves, so the only way this command can finish is the abort
    // winning the race against the sleep — the loop never gets back to its own top-of-loop check.
    const h = harness(
      openThen(() => entry({ open: true, closedAt: null })),
      (c) => ({
        sleep: () => {
          c.fireSignal();
          c.fireSignal();
          return new Promise<void>(() => {});
        },
      }),
    );
    // The deadline is this test's own, not the runner's. A regression leaves `runComputer` waiting
    // on a promise nothing settles, and with nothing else scheduled Bun 1.3.14 on Windows never
    // fires its per-test timeout: the process hung until killed (Linux fails the same test at its
    // timeout). A timer of our own turns that hang into a failure within two seconds.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runComputer(["browser", "--origin", "https://example.com"], h.deps).then(
        () => "finished" as const,
      ),
      new Promise<"still waiting">((resolve) => {
        deadline = setTimeout(() => resolve("still waiting"), 2_000);
      }),
    ]);
    clearTimeout(deadline);
    expect(outcome).toBe("finished");
    expect(h.codes).toEqual([CU_EXIT_CODES.interrupted]);
    expect(h.err.join("")).toContain("nimbus computer close sess-c");
    // One status poll (the one before the sleep) and one close request — no retry loop.
    expect(methods(h).filter((m) => m === "computer.sessionStatus")).toHaveLength(1);
    expect(methods(h).filter((m) => m === "computer.sessionClose")).toHaveLength(1);
  });

  test("a non-Error transport failure is printed as-is and refuses", async () => {
    const h = harness(
      () => ({}),
      () => ({
        runWithClient: async () => {
          throw "pipe closed";
        },
      }),
    );
    await runComputer(["browser", "--origin", "https://example.com"], h.deps);
    expect(h.err).toEqual(["pipe closed\n"]);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
  });
});

describe("runComputer sessions / close", () => {
  test("sessions renders open and closed rows, with the close reason only when there is one", async () => {
    const h = harness(() => ({
      sessions: [
        entry({ sessionId: "s-open", open: true, closedAt: null, actionsUsed: 2 }),
        entry({
          sessionId: "s-done",
          lane: "terminal",
          open: false,
          closeReason: "terminated_budget",
          actionsUsed: 5,
        }),
      ],
    }));
    await runComputer(["sessions"], h.deps);
    expect(h.out).toEqual([
      "s-open  browser  open  actions=2\n",
      "s-done  terminal  closed  actions=5  (terminated_budget)\n",
    ]);
    expect(h.calls).toEqual([{ method: "computer.sessionStatus", params: {} }]);
    expect(h.codes).toEqual([]);
  });

  test("a sessions failure — Error or not — is printed and refuses", async () => {
    for (const thrown of [new Error("gateway not running"), "socket reset"]) {
      const h = harness(
        () => ({}),
        () => ({
          runWithClient: async () => {
            throw thrown;
          },
        }),
      );
      await runComputer(["sessions"], h.deps);
      expect(h.err).toEqual([`${thrown instanceof Error ? thrown.message : thrown}\n`]);
      expect(h.out).toEqual([]);
      expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
    }
  });

  test("close prints a non-closed status and refuses rather than exiting 0", async () => {
    const h = harness(() => ({ status: "not_found" }));
    await runComputer(["close", "sess-x"], h.deps);
    expect(h.out).toEqual(["not_found\n"]);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
    expect(h.calls).toEqual([{ method: "computer.sessionClose", params: { sessionId: "sess-x" } }]);
  });

  test("a clean close sets no exit code at all", async () => {
    const h = harness(() => ({ status: "closed" }));
    await runComputer(["close", "sess-x"], h.deps);
    expect(h.out).toEqual(["closed\n"]);
    expect(h.codes).toEqual([]);
  });

  test("a close transport failure — Error or not — is printed and refuses", async () => {
    for (const thrown of [new Error("gateway went away"), "pipe reset"]) {
      const h = harness(
        () => ({}),
        () => ({
          runWithClient: async () => {
            throw thrown;
          },
        }),
      );
      await runComputer(["close", "sess-x"], h.deps);
      expect(h.err).toEqual([`${thrown instanceof Error ? thrown.message : thrown}\n`]);
      expect(h.out).toEqual([]);
      expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
    }
  });
});

describe("production defaults", () => {
  test("with no deps, a bad subcommand writes the usage to stderr and sets process.exitCode", async () => {
    // The default branch refuses before any client is built; were that to regress, the gateway
    // lookup would land in this never-created root rather than a real profile.
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-computer-cov-env-never-created"));
    const cap = createStreamCapture();
    const priorExitCode = process.exitCode;
    cap.install();
    try {
      await runComputer(["nonsense"]);
      expect(process.exitCode).toBe(CU_EXIT_CODES.refused);
    } finally {
      cap.restore();
      restoreEnv();
      // `?? 0`, not the bare prior value: Bun ignores `process.exitCode = undefined`, so restoring an
      // unset code that way would leave 127 behind and fail the whole test process.
      process.exitCode = priorExitCode ?? 0;
    }
    expect(cap.stderrChunks.join("")).toBe(
      "Usage: nimbus computer <browser|terminal|sessions|close> ...\n",
    );
    expect(cap.stdoutChunks).toEqual([]);
  });

  test("onProcessInterrupt registers on SIGINT and SIGTERM and its unregister removes both", () => {
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const handler = (): void => {};
    const off = onProcessInterrupt(handler);
    try {
      expect(process.listeners("SIGINT")).toContain(handler);
      expect(process.listeners("SIGTERM")).toContain(handler);
    } finally {
      off();
    }
    expect(process.listeners("SIGINT")).not.toContain(handler);
    expect(process.listeners("SIGTERM")).not.toContain(handler);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });
});
