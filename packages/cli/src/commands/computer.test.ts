import { describe, expect, test } from "bun:test";
import {
  CU_EXIT_CODES,
  cuOutcomeExitCode,
  formatActionPrompt,
  formatEnvelopePrompt,
  handleActionBroadcast,
  handleEnvelopeBroadcast,
  parseComputerBrowserArgs,
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
      { requestId: "e2", navigateOrigins: "nope", scriptOrigins: [1, 2] },
      h.ask,
      h.respond,
    );
    expect(h.answered).toEqual([{ requestId: "e2", approved: true }]);
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

describe("runComputer orchestration — browser subcommand", () => {
  function deps(over: Partial<Parameters<typeof runComputer>[1]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const codes: number[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const notifs = new Map<string, (params: unknown) => unknown>();
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
      ...over,
    };
    return { out, err, codes, calls, notifs, d: base as never };
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
