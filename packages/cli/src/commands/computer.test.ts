import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import {
  CU_EXIT_CODES,
  cuOutcomeExitCode,
  formatActionPrompt,
  formatEnvelopePrompt,
  handleActionBroadcast,
  handleEnvelopeBroadcast,
  parseComputerBrowserArgs,
  parseComputerTerminalArgs,
  resolveOrigin,
  runComputer,
} from "./computer.ts";

describe("resolveOrigin", () => {
  test("accepts a bare https origin unchanged", () => {
    expect(resolveOrigin("--origin", "https://example.com")).toBe("https://example.com");
  });

  test("lowercases/normalises the same way the gateway would", () => {
    expect(resolveOrigin("--origin", "https://Example.com")).toBe("https://example.com");
  });

  test("REFUSES an origin carrying a path, CLIENT-side, with an explanation", () => {
    // Must never widen `https://example.com/safe/subdir` to the bare origin -- that grants more
    // than the caller typed. Refuse and explain, so the mistake is visible at the point it is made.
    expect(() => resolveOrigin("--origin", "https://example.com/safe/subdir")).toThrow(/path/i);
  });

  test("refuses a querystring-bearing origin", () => {
    expect(() => resolveOrigin("--origin", "https://example.com/?x=1")).toThrow();
  });

  test("refuses a fragment-bearing origin", () => {
    expect(() => resolveOrigin("--origin", "https://example.com/#frag")).toThrow();
  });

  test("refuses embedded userinfo", () => {
    expect(() => resolveOrigin("--origin", "https://user:pass@example.com")).toThrow(/userinfo/i);
  });

  test("refuses a trailing dot on the hostname", () => {
    expect(() => resolveOrigin("--origin", "https://example.com.")).toThrow();
  });

  test("refuses a non-http(s) scheme", () => {
    expect(() => resolveOrigin("--origin", "ftp://example.com")).toThrow(/http/i);
  });

  test("refuses an unparseable value", () => {
    expect(() => resolveOrigin("--origin", "not a url")).toThrow();
  });

  test("names the offending flag in the message", () => {
    expect(() => resolveOrigin("--script-origin", "not a url")).toThrow(/--script-origin/);
  });
});

describe("parseComputerBrowserArgs", () => {
  test("a MISSING --origin refuses rather than defaulting to an empty allowlist", () => {
    // An empty navigate list would open a session in which every navigation is later refused
    // with a confusing message -- fail early instead, naming the flag.
    expect(() => parseComputerBrowserArgs([])).toThrow(/--origin/);
  });

  test("collects a single --origin into navigateOrigins", () => {
    const p = parseComputerBrowserArgs(["--origin", "https://example.com"]);
    expect(p.navigateOrigins).toEqual(["https://example.com"]);
    expect(p.scriptOrigins).toEqual([]);
  });

  test("collects repeated --origin and --script-origin flags", () => {
    const p = parseComputerBrowserArgs([
      "--origin",
      "https://a.example.com",
      "--origin",
      "https://b.example.com",
      "--script-origin",
      "https://cdn.example.com",
    ]);
    expect(p.navigateOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(p.scriptOrigins).toEqual(["https://cdn.example.com"]);
  });

  test("a path-bearing --origin throws before any origin is collected", () => {
    expect(() => parseComputerBrowserArgs(["--origin", "https://example.com/sub/path"])).toThrow(
      /path/i,
    );
  });

  test("parses --max-actions and --timeout (seconds -> ms)", () => {
    const p = parseComputerBrowserArgs([
      "--origin",
      "https://example.com",
      "--max-actions",
      "5",
      "--timeout",
      "30",
    ]);
    expect(p.maxActions).toBe(5);
    expect(p.maxWallClockMs).toBe(30_000);
  });

  test("rejects a non-numeric --max-actions", () => {
    expect(() =>
      parseComputerBrowserArgs(["--origin", "https://example.com", "--max-actions", "soon"]),
    ).toThrow();
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    expect(() =>
      parseComputerBrowserArgs(["--origin", "https://example.com", "--allow-everything"]),
    ).toThrow(/Unknown flag/);
  });

  test("rejects a flag whose value is missing", () => {
    expect(() => parseComputerBrowserArgs(["--origin"])).toThrow();
  });
});

describe("cuOutcomeExitCode", () => {
  test("distinguishes denied_by_owner, terminated_budget and terminated_wall_clock", () => {
    expect(cuOutcomeExitCode("denied_by_owner")).toBe(CU_EXIT_CODES.deniedByOwner);
    expect(cuOutcomeExitCode("terminated_budget")).toBe(CU_EXIT_CODES.terminatedBudget);
    expect(cuOutcomeExitCode("terminated_wall_clock")).toBe(CU_EXIT_CODES.terminatedWallClock);

    const codes = new Set([
      cuOutcomeExitCode("denied_by_owner"),
      cuOutcomeExitCode("terminated_budget"),
      cuOutcomeExitCode("terminated_wall_clock"),
    ]);
    expect(codes.size).toBe(3);
  });

  test("a clean actuation is a success", () => {
    expect(cuOutcomeExitCode("actuated")).toBe(0);
  });

  test("an unrecognised or otherwise-failed outcome is a refusal, never 0", () => {
    expect(cuOutcomeExitCode("failed_after_approval")).toBe(CU_EXIT_CODES.refused);
    expect(cuOutcomeExitCode("refused_before_consent")).toBe(CU_EXIT_CODES.refused);
    expect(cuOutcomeExitCode("refused_out_of_envelope")).toBe(CU_EXIT_CODES.refused);
    expect(cuOutcomeExitCode("terminated_target_lost")).toBe(CU_EXIT_CODES.refused);
    expect(cuOutcomeExitCode("terminated_policy")).toBe(CU_EXIT_CODES.refused);
    expect(cuOutcomeExitCode("something-new")).toBe(CU_EXIT_CODES.refused);
  });

  test("CU_EXIT_CODES.refused deliberately shares 127 with exec's refused code — same meaning", () => {
    expect(CU_EXIT_CODES.refused).toBe(127);
  });
});

describe("the two prompt kinds render as VISIBLY DIFFERENT things", () => {
  const envelope = formatEnvelopePrompt({
    sessionId: "s1",
    lane: "browser",
    navigateOrigins: ["https://a.example.com", "https://b.example.com"],
    scriptOrigins: ["https://cdn.example.com"],
    maxActions: 10,
    maxWallClockMs: 60_000,
  });
  const action = formatActionPrompt({
    sessionId: "s1",
    seq: 3,
    kind: "click",
    observedTarget: "click button type=submit",
    classification: "actuating",
    why: "submit control inside a form",
    actionsUsed: 2,
    maxActions: 10,
    modelDescription: "I am just checking the page, definitely not submitting anything",
  });

  test("the envelope prompt shows the FULL origin lists, never elided", () => {
    expect(envelope).toContain("https://a.example.com");
    expect(envelope).toContain("https://b.example.com");
    expect(envelope).toContain("https://cdn.example.com");
    expect(envelope).not.toMatch(/\d+ origins?/i);
  });

  test("the envelope prompt shows the budgets, with a human-scaled duration alongside the raw ms", () => {
    expect(envelope).toContain("10");
    expect(envelope).toContain("60000");
    expect(envelope).toContain("1m"); // 60000ms rendered human-scaled
  });

  test("formatEnvelopePrompt renders a human-scaled duration for various sizes", () => {
    expect(
      formatEnvelopePrompt({
        sessionId: "s",
        lane: "browser",
        navigateOrigins: [],
        scriptOrigins: [],
        maxActions: 1,
        maxWallClockMs: 500,
      }),
    ).toContain("500ms");
    expect(
      formatEnvelopePrompt({
        sessionId: "s",
        lane: "browser",
        navigateOrigins: [],
        scriptOrigins: [],
        maxActions: 1,
        maxWallClockMs: 3_661_000,
      }),
    ).toContain("1h 1m 1s");
  });

  test("the action prompt shows what the GATEWAY observed, as a fact", () => {
    expect(action).toContain("click button type=submit");
    expect(action).toContain("actuating");
    expect(action).toContain("submit control inside a form");
  });

  test("the action prompt labels the model's own description as UNTRUSTED, distinctly", () => {
    expect(action).toMatch(/untrusted/i);
    expect(action).toContain("I am just checking the page, definitely not submitting anything");
  });

  test("the two renders do not share a heading, so they cannot be mistaken for one another", () => {
    const envelopeHeading = envelope.split("\n")[0];
    const actionHeading = action.split("\n")[0];
    expect(envelopeHeading).not.toBe(actionHeading);
  });

  test("only the action prompt ever mentions the model; the envelope prompt never does", () => {
    expect(envelope.toLowerCase()).not.toContain("model");
    expect(action.toLowerCase()).toContain("model");
  });
});

describe("handleEnvelopeBroadcast", () => {
  function harness(answer: unknown) {
    const answered: Array<{ requestId: string; approved: boolean }> = [];
    const shown: string[] = [];
    return {
      answered,
      shown,
      ask: async (m: string) => {
        shown.push(m);
        return answer;
      },
      respond: async (requestId: string, approved: boolean) => {
        answered.push({ requestId, approved });
      },
    };
  }

  const REQ = {
    requestId: "e1",
    sessionId: "s1",
    lane: "browser",
    navigateOrigins: ["https://example.com"],
    scriptOrigins: [],
    maxActions: 10,
    maxWallClockMs: 60_000,
  };

  test("approves only on an explicit true", async () => {
    const h = harness(true);
    await handleEnvelopeBroadcast(REQ, h.ask, h.respond);
    expect(h.answered).toEqual([{ requestId: "e1", approved: true }]);
    expect(h.shown[0]).toContain("https://example.com");
  });

  test("cancelling is a denial, never an approval", async () => {
    const h = harness(Symbol.for("clack:cancel"));
    await handleEnvelopeBroadcast(REQ, h.ask, h.respond);
    expect(h.answered[0]?.approved).toBe(false);
  });

  test("a broadcast with no usable requestId is ignored, not answered", async () => {
    const h = harness(true);
    await handleEnvelopeBroadcast({}, h.ask, h.respond);
    expect(h.answered).toEqual([]);
    expect(h.shown).toEqual([]);
  });

  test("survives malformed nested origin lists without throwing before responding", async () => {
    const h = harness(true);
    await handleEnvelopeBroadcast(
      // `lane` added when the prompt became a lane union: without it this broadcast is now
      // auto-denied as undescribable (see the test below), which would make this case assert the
      // wrong thing. Its actual subject is the MALFORMED ORIGIN LISTS, unchanged.
      { requestId: "e2", lane: "browser", navigateOrigins: "nope", scriptOrigins: [1, 2] },
      h.ask,
      h.respond,
    );
    expect(h.answered).toEqual([{ requestId: "e2", approved: true }]);
  });

  test("an UNRECOGNISED lane is denied without ever prompting the owner", async () => {
    // Falling back to the browser render would show the owner a prompt describing a grant that is
    // not the one being requested. Asking a human to approve a thing this command cannot describe
    // is worse than refusing it — and a refusal is recoverable, a mistaken approval is not.
    const h = harness(true);
    await handleEnvelopeBroadcast({ requestId: "e3", lane: "screen" }, h.ask, h.respond);
    expect(h.shown).toEqual([]);
    expect(h.answered).toEqual([{ requestId: "e3", approved: false }]);
  });

  test("a MISSING lane is denied too, rather than assumed to be a browser", async () => {
    const h = harness(true);
    await handleEnvelopeBroadcast({ requestId: "e4" }, h.ask, h.respond);
    expect(h.shown).toEqual([]);
    expect(h.answered).toEqual([{ requestId: "e4", approved: false }]);
  });

  test("a terminal broadcast renders the shell and directory, and says there is no network", async () => {
    const h = harness(true);
    await handleEnvelopeBroadcast(
      {
        requestId: "e5",
        lane: "terminal",
        sessionId: "s1",
        shellId: "sh",
        cwd: "/home/me/project",
        maxActions: 5,
        maxWallClockMs: 60000,
      },
      h.ask,
      h.respond,
    );
    const shown = h.shown[0] ?? "";
    expect(shown).toContain("/home/me/project");
    expect(shown).toContain("sh");
    expect(shown).toMatch(/no network|NONE/i);
    expect(h.answered).toEqual([{ requestId: "e5", approved: true }]);
  });
});

describe("handleActionBroadcast", () => {
  function harness(answer: unknown) {
    const answered: Array<{ requestId: string; approved: boolean }> = [];
    const shown: string[] = [];
    return {
      answered,
      shown,
      ask: async (m: string) => {
        shown.push(m);
        return answer;
      },
      respond: async (requestId: string, approved: boolean) => {
        answered.push({ requestId, approved });
      },
    };
  }

  const REQ = {
    requestId: "a1",
    sessionId: "s1",
    seq: 1,
    kind: "click",
    observedTarget: "click button",
    classification: "actuating",
    why: "submit control",
    actionsUsed: 0,
    maxActions: 10,
    modelDescription: "clicking the login button",
  };

  test("approves only on an explicit true", async () => {
    const h = harness(true);
    await handleActionBroadcast(REQ, h.ask, h.respond);
    expect(h.answered).toEqual([{ requestId: "a1", approved: true }]);
    expect(h.shown[0]).toContain("clicking the login button");
  });

  test("any non-true answer denies, fail-closed", async () => {
    for (const v of ["yes", 1, {}, null, undefined, false]) {
      const h = harness(v);
      await handleActionBroadcast(REQ, h.ask, h.respond);
      expect(h.answered[0]?.approved).toBe(false);
    }
  });

  test("a missing requestId is ignored, not answered", async () => {
    const h = harness(true);
    await handleActionBroadcast({ kind: "click" }, h.ask, h.respond);
    expect(h.answered).toEqual([]);
  });

  test("a null modelDescription renders as an explicit absence, not a crash", async () => {
    const h = harness(true);
    await handleActionBroadcast({ requestId: "a2", modelDescription: null }, h.ask, h.respond);
    expect(h.answered).toEqual([{ requestId: "a2", approved: true }]);
    expect(h.shown[0]).toContain("none");
  });
});

/**
 * The slice of the IPC client the interrupt tests build inline. Structural, and deliberately NOT
 * imported from `computer.ts` — these tests exercise the command through its injected deps, so a
 * shape wide enough to satisfy `runWithClient` is exactly the contract under test.
 */
interface FakeClient {
  onNotification(method: string, handler: (params: unknown) => unknown): void;
  call(method: string, params?: unknown): Promise<unknown>;
}

describe("runComputer orchestration — browser subcommand", () => {
  function deps(over: Partial<Parameters<typeof runComputer>[1]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const codes: number[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const notifs = new Map<string, (params: unknown) => unknown>();
    const signal: { handlers: Array<() => void>; fire: () => void } = {
      handlers: [],
      fire: () => {
        for (const h of [...signal.handlers]) h();
      },
    };
    const client = {
      onNotification: (m: string, h: (p: unknown) => unknown) => {
        notifs.set(m, h);
      },
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "computer.sessionOpen") {
          return { status: "open", sessionId: "sess-1" };
        }
        if (method === "computer.sessionStatus") {
          // Already closed on the FIRST poll (a clean, owner-initiated close) so a test that does
          // not care about the watch loop's own behaviour resolves immediately with exit code 0,
          // without ever needing `sleep` to be called.
          return {
            sessions: [
              {
                sessionId: "sess-1",
                lane: "browser",
                openedAt: 0,
                closedAt: 1,
                closeReason: "owner",
                taintedAt: null,
                actionsUsed: 0,
                open: false,
              },
            ],
          };
        }
        return { matched: true };
      },
    };
    const base = {
      runWithClient: async <T>(fn: (c: typeof client) => Promise<T>) => fn(client),
      ask: async () => true,
      sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
      setExitCode: (c: number) => codes.push(c),
      sleep: async () => {},
      // Captured, never attached to the real process: a listener left on `process` after a test
      // would change how the TEST RUNNER itself responds to Ctrl-C. `signal.fire()` raises it.
      onSignal: (handler: () => void) => {
        signal.handlers.push(handler);
        return () => {
          signal.handlers = signal.handlers.filter((h) => h !== handler);
        };
      },
      ...over,
    };
    return {
      out,
      err,
      codes,
      calls,
      notifs,
      signal,
      d: base as never,
    };
  }

  test("sends computer.sessionOpen with the resolved origin list", async () => {
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    const open = h.calls.find((c) => c.method === "computer.sessionOpen");
    if (open === undefined) throw new Error("expected a computer.sessionOpen call");
    expect(open.params).toMatchObject({
      lane: "browser",
      navigateOrigins: ["https://example.com"],
      scriptOrigins: [],
    });
    expect(h.out.join("")).toContain("sess-1");
    expect(h.codes).toEqual([0]);
  });

  test("a missing --origin never opens an IPC connection and refuses", async () => {
    const h = deps();
    await runComputer(["browser"], h.d);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain("--origin");
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
  });

  test("a path-bearing --origin never opens an IPC connection and refuses client-side", async () => {
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com/sub"], h.d);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toMatch(/path/i);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
  });

  test("ERR_CU_NO_BROWSER — the only outcome a real user can reach today — is an ACTIONABLE message", async () => {
    const h = deps({
      runWithClient: (async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) =>
            method === "computer.sessionOpen"
              ? { status: "refused", code: "ERR_CU_NO_BROWSER" }
              : { matched: true },
        })) as never,
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
    const message = h.err.join("");
    // Must be actionable / explanatory, not a bare error code and not a stack trace.
    expect(message).not.toContain("at ");
    expect(message.toLowerCase()).toContain("browser");
    expect(message.length).toBeGreaterThan("ERR_CU_NO_BROWSER".length + 10);
  });

  test("session denied by the owner sets the denied_by_owner exit code", async () => {
    const h = deps({
      runWithClient: (async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) =>
            method === "computer.sessionOpen" ? { status: "denied" } : { matched: true },
        })) as never,
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.deniedByOwner]);
  });

  test("registers BOTH prompt-kind handlers before calling sessionOpen", async () => {
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.notifs.has("computer.envelopeRequest")).toBe(true);
    expect(h.notifs.has("computer.actionRequest")).toBe(true);
  });

  test("never calls computer.act — this command is a passive listener, not a driver", async () => {
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.calls.some((c) => c.method === "computer.act")).toBe(false);
  });

  test("a clean owner-initiated close (closeReason 'owner') exits 0", async () => {
    const h = deps(); // default harness already returns closeReason "owner"
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([0]);
    expect(h.out.join("")).toContain("Session closed");
  });

  test("a session that terminates on its ACTION BUDGET surfaces the matching exit code", async () => {
    let statusCalls = 0;
    const h = deps({
      runWithClient: (async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            if (method === "computer.sessionOpen") return { status: "open", sessionId: "s1" };
            if (method === "computer.sessionStatus") {
              statusCalls += 1;
              const open = statusCalls < 2;
              return {
                sessions: [
                  {
                    sessionId: "s1",
                    lane: "browser",
                    openedAt: 0,
                    closedAt: open ? null : 1,
                    closeReason: open ? null : "terminated_budget",
                    taintedAt: null,
                    actionsUsed: statusCalls,
                    open,
                  },
                ],
              };
            }
            return { matched: true };
          },
        })) as never,
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.terminatedBudget]);
    // The poll loop must have actually paced itself between an open and a closed observation.
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  test("a session that terminates on WALL CLOCK surfaces the matching exit code", async () => {
    let statusCalls = 0;
    const h = deps({
      runWithClient: (async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            if (method === "computer.sessionOpen") return { status: "open", sessionId: "s1" };
            if (method === "computer.sessionStatus") {
              statusCalls += 1;
              const open = statusCalls < 2;
              return {
                sessions: [
                  {
                    sessionId: "s1",
                    lane: "browser",
                    openedAt: 0,
                    closedAt: open ? null : 1,
                    closeReason: open ? null : "terminated_wall_clock",
                    taintedAt: null,
                    actionsUsed: 0,
                    open,
                  },
                ],
              };
            }
            return { matched: true };
          },
        })) as never,
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.terminatedWallClock]);
  });

  test("a session that disappears mid-watch (not found) refuses rather than exiting 0", async () => {
    const h = deps({
      runWithClient: (async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            if (method === "computer.sessionOpen") return { status: "open", sessionId: "s1" };
            if (method === "computer.sessionStatus") return { sessions: [] };
            return { matched: true };
          },
        })) as never,
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.refused]);
  });

  test("Ctrl-C asks the GATEWAY to close the session, and exits 130", async () => {
    // Before this, an interrupt exited THIS process and left the gateway holding a live headless
    // browser inside an approved envelope with nothing watching it — until its wall-clock ceiling
    // expired (five minutes on the shipped defaults). The session belongs to the gateway, not to
    // this process, so the fix is to ask the gateway to close it rather than to exit harder.
    let polls = 0;
    const seen: string[] = [];
    const h = deps({
      runWithClient: async <T>(fn: (c: FakeClient) => Promise<T>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            seen.push(method);
            if (method === "computer.sessionOpen") {
              return { status: "open", sessionId: "sess-1" };
            }
            if (method === "computer.sessionStatus") {
              polls += 1;
              // Open on the first poll (so the watch loop is genuinely running when the signal
              // arrives), closed on the next — as it would be once the gateway honours the close.
              return {
                sessions: [
                  {
                    sessionId: "sess-1",
                    lane: "browser",
                    openedAt: 0,
                    closedAt: polls > 1 ? 1 : null,
                    closeReason: polls > 1 ? "owner" : null,
                    taintedAt: null,
                    actionsUsed: 0,
                    open: polls <= 1,
                  },
                ],
              };
            }
            return { status: "closed" };
          },
        }),
      // Fire the interrupt from inside the poll loop's own pause, which is where a real Ctrl-C
      // lands: the loop is idle between polls for all but a few microseconds of its life.
      sleep: async () => {
        h.signal.fire();
      },
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(seen.filter((m) => m === "computer.sessionClose")).toHaveLength(1);
    // A clean close driven by our own interrupt still exits 130: the SESSION ended tidily, but the
    // COMMAND was interrupted, and that is what a caller is asking about.
    expect(h.codes).toEqual([CU_EXIT_CODES.interrupted]);
    expect(h.err.join("")).toContain("closing the computer-use session");
  });

  test("a SECOND interrupt stops waiting and names the recovery command", async () => {
    // If the first close is not landing, blocking the user's terminal on it is the wrong trade —
    // but exiting silently would leave them with a session they cannot find. The message carries
    // the id and the exact command.
    const seen: string[] = [];
    const h = deps({
      runWithClient: async <T>(fn: (c: FakeClient) => Promise<T>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            seen.push(method);
            if (method === "computer.sessionOpen") {
              return { status: "open", sessionId: "sess-1" };
            }
            if (method === "computer.sessionStatus") {
              // NEVER closes — a gateway that is not honouring the close.
              return {
                sessions: [
                  {
                    sessionId: "sess-1",
                    lane: "browser",
                    openedAt: 0,
                    closedAt: null,
                    closeReason: null,
                    taintedAt: null,
                    actionsUsed: 0,
                    open: true,
                  },
                ],
              };
            }
            return { status: "closed" };
          },
        }),
      sleep: async () => {
        h.signal.fire();
      },
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.interrupted]);
    expect(h.err.join("")).toContain("nimbus computer close sess-1");
    // Exactly one close attempt: the second interrupt gives up rather than retrying forever.
    expect(seen.filter((m) => m === "computer.sessionClose")).toHaveLength(1);
  });

  test("a failing sessionClose does not raise out of the signal handler", async () => {
    // Nothing can await a signal handler, so a rejected close must be swallowed there; the watch
    // loop reports what actually happened to the session.
    let polls = 0;
    const h = deps({
      runWithClient: async <T>(fn: (c: FakeClient) => Promise<T>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            if (method === "computer.sessionOpen") {
              return { status: "open", sessionId: "sess-1" };
            }
            if (method === "computer.sessionClose") throw new Error("gateway went away");
            polls += 1;
            return {
              sessions: [
                {
                  sessionId: "sess-1",
                  lane: "browser",
                  openedAt: 0,
                  closedAt: polls > 1 ? 1 : null,
                  closeReason: polls > 1 ? "owner" : null,
                  taintedAt: null,
                  actionsUsed: 0,
                  open: polls <= 1,
                },
              ],
            };
          },
        }),
      sleep: async () => {
        h.signal.fire();
      },
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.interrupted]);
  });

  test("a second interrupt exits even while the status request is still pending", async () => {
    // The finding this closes: `forced` was a boolean read only at the top of the poll loop, so a
    // second Ctrl-C arriving while `computer.sessionStatus` was in flight printed its recovery
    // guidance and then WAITED for that request anyway. If the gateway is wedged — the very
    // situation a second interrupt is for — the request never settles and the command hangs
    // forever. The loop now RACES the request (and the sleep) against the abort.
    const seen: string[] = [];
    const h = deps({
      runWithClient: async <T>(fn: (c: FakeClient) => Promise<T>) =>
        fn({
          onNotification: () => {},
          call: async (method: string) => {
            seen.push(method);
            if (method === "computer.sessionOpen") {
              return { status: "open", sessionId: "sess-1" };
            }
            if (method === "computer.sessionStatus") {
              // NEVER settles — a wedged gateway, which is precisely when a second Ctrl-C matters.
              return new Promise(() => {});
            }
            return { status: "closed" };
          },
        }),
      // Both signals fire before the hung request can ever resolve.
      onSignal: (handler: () => void) => {
        queueMicrotask(() => {
          handler();
          handler();
        });
        return () => {};
      },
    });
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([CU_EXIT_CODES.interrupted]);
    expect(h.err.join("")).toContain("nimbus computer close sess-1");
    expect(seen).toContain("computer.sessionClose");
    // The status request WAS issued, so the loop really was mid-request when the second signal
    // landed — otherwise this test would prove nothing about racing an in-flight call.
    expect(seen).toContain("computer.sessionStatus");
    // THE PROPERTY IS THAT THIS TEST COMPLETES AT ALL. The status promise above never settles, so
    // an implementation that awaits it — the one this test exists to catch — hangs here and fails
    // on bun's timeout rather than on an assertion.
    //
    // Stated rather than dressed up in a flag, because the flag version was WRONG and shipped:
    // `let statusSettled = false` set from inside the promise executor runs synchronously at
    // construction, assigns the value it already has, and is never touched again — so
    // `expect(statusSettled).toBe(false)` passed for every implementation including a hanging one.
    // That is the second cannot-fail assertion written in this file; caught in review both times.
    // If an assertion here cannot distinguish the broken build from the fixed one, do not write it.
  });

  test("the signal handler is UNREGISTERED once the command finishes", async () => {
    // A listener left attached would outlive the command and change how the process responds to a
    // later Ctrl-C — in the CLI's case, to one aimed at whatever runs next.
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.signal.handlers).toEqual([]);
  });

  test("an uninterrupted session keeps its own exit code", async () => {
    // The interrupt path must not change the ordinary one: a clean close is still 0.
    const h = deps();
    await runComputer(["browser", "--origin", "https://example.com"], h.d);
    expect(h.codes).toEqual([0]);
  });
});

describe("runComputer — sessions / close subcommands", () => {
  test("sessions lists every session from computer.sessionStatus", async () => {
    const out: string[] = [];
    const codes: number[] = [];
    await runComputer(["sessions"], {
      runWithClient: async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async () => ({
            sessions: [
              {
                sessionId: "s1",
                lane: "browser",
                openedAt: 0,
                closedAt: null,
                closeReason: null,
                taintedAt: null,
                actionsUsed: 2,
                open: true,
              },
            ],
          }),
        }),
      ask: async () => true,
      sink: { out: (s: string) => out.push(s), err: () => {} },
      setExitCode: (c: number) => codes.push(c),
      sleep: async () => {},
    } as never);
    expect(out.join("")).toContain("s1");
  });

  test("close requires a session id", async () => {
    const err: string[] = [];
    const codes: number[] = [];
    await runComputer(["close"], {
      runWithClient: async () => {
        throw new Error("must not connect without an id");
      },
      ask: async () => true,
      sink: { out: () => {}, err: (s: string) => err.push(s) },
      setExitCode: (c: number) => codes.push(c),
      sleep: async () => {},
    } as never);
    expect(codes).toEqual([CU_EXIT_CODES.refused]);
    expect(err.join("")).toContain("session-id");
  });

  test("close calls computer.sessionClose with the given id", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    await runComputer(["close", "s1"], {
      runWithClient: async (fn: (c: unknown) => Promise<unknown>) =>
        fn({
          onNotification: () => {},
          call: async (method: string, params: unknown) => {
            calls.push({ method, params });
            return { status: "closed" };
          },
        }),
      ask: async () => true,
      sink: { out: (s: string) => out.push(s), err: () => {} },
      setExitCode: () => {},
      sleep: async () => {},
    } as never);
    expect(calls).toEqual([{ method: "computer.sessionClose", params: { sessionId: "s1" } }]);
    expect(out.join("")).toContain("closed");
  });
});

describe("an unknown subcommand refuses with a usage message", () => {
  test("no subcommand", async () => {
    const err: string[] = [];
    const codes: number[] = [];
    await runComputer([], {
      runWithClient: async () => {
        throw new Error("must not connect");
      },
      ask: async () => true,
      sink: { out: () => {}, err: (s: string) => err.push(s) },
      setExitCode: (c: number) => codes.push(c),
      sleep: async () => {},
    } as never);
    expect(codes).toEqual([CU_EXIT_CODES.refused]);
    expect(err.join("")).toContain("Usage");
  });
});

describe("nimbus computer terminal", () => {
  test("requires --cwd and resolves it to an absolute path CLIENT-side", () => {
    expect(() => parseComputerTerminalArgs([])).toThrow(/--cwd is required/);
    const p = parseComputerTerminalArgs(["--cwd", "."]);
    expect(isAbsolute(p.cwd)).toBe(true);
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseComputerTerminalArgs(["--cwd", ".", "--net"])).toThrow(/Unknown flag/);
  });

  test("rejects a flag with no value", () => {
    expect(() => parseComputerTerminalArgs(["--cwd"])).toThrow(/requires a value/);
  });

  test("rejects a non-positive budget or timeout", () => {
    expect(() => parseComputerTerminalArgs(["--cwd", ".", "--max-actions", "0"])).toThrow(
      /positive integer/,
    );
    expect(() => parseComputerTerminalArgs(["--cwd", ".", "--timeout", "-1"])).toThrow(
      /positive integer/,
    );
  });

  test("carries --shell and the bounds through", () => {
    const p = parseComputerTerminalArgs([
      "--cwd",
      ".",
      "--shell",
      "sh",
      "--max-actions",
      "7",
      "--timeout",
      "30",
    ]);
    expect(p.shellId).toBe("sh");
    expect(p.maxActions).toBe(7);
    expect(p.maxWallClockMs).toBe(30_000);
  });

  test("the terminal envelope prompt shows the shell and the directory verbatim", () => {
    const s = formatEnvelopePrompt({
      lane: "terminal",
      sessionId: "s1",
      shellId: "sh",
      cwd: "/home/me/project",
      maxActions: 5,
      maxWallClockMs: 60_000,
    });
    expect(s).toContain("/home/me/project");
    expect(s).toContain("sh");
    // The one thing a terminal envelope must say and a browser one must not.
    expect(s).toMatch(/network:\s+NONE/);
  });

  test("the browser envelope prompt is unchanged and mentions no shell", () => {
    const s = formatEnvelopePrompt({
      lane: "browser",
      sessionId: "s1",
      navigateOrigins: ["https://example.com"],
      scriptOrigins: [],
      maxActions: 5,
      maxWallClockMs: 60_000,
    });
    expect(s).toContain("https://example.com");
    expect(s).not.toMatch(/shell/i);
    expect(s).not.toMatch(/directory/i);
  });

  test("the action prompt heading is lane-neutral, and the fact/claim split survives", () => {
    const s = formatActionPrompt({
      sessionId: "s1",
      seq: 1,
      kind: "terminal_write",
      observedTarget: "rm -rf /tmp/x",
      classification: "actuating",
      why: "every complete command line",
      actionsUsed: 1,
      maxActions: 5,
      modelDescription: null,
    });
    expect(s).not.toMatch(/browser action/i);
    expect(s).toContain("rm -rf /tmp/x");
    // The whole design rests on the human reading these as two different kinds of information.
    expect(s).toMatch(/gateway observed/i);
    expect(s).toMatch(/UNTRUSTED/);
  });

  test("the subcommand usage lists terminal", () => {
    // `runComputer`'s default branch prints this, so a typo'd subcommand would otherwise tell the
    // user the terminal lane does not exist.
    let err = "";
    const deps = {
      runWithClient: async () => undefined as never,
      ask: async () => true,
      sink: {
        out: () => {},
        err: (chunk: string) => {
          err += chunk;
        },
      },
      setExitCode: () => {},
      sleep: async () => {},
      onSignal: () => () => {},
    };
    return runComputer(["nonsense"], deps).then(() => {
      expect(err).toContain("terminal");
    });
  });
});
