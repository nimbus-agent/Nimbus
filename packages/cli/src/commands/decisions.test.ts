import { afterEach, describe, expect, test } from "bun:test";
import type { IPCClient } from "../ipc-client/index.ts";
import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import {
  isDecisionsBriefLike,
  parseDecisionsArgs,
  renderPassOutcome,
  runDecisionsCommand,
} from "./decisions.ts";

test("defaults to a 90-day window", () => {
  expect(parseDecisionsArgs([]).sinceMs).toBe(90 * 24 * 60 * 60 * 1000);
});

// The CLI half of the `--since` contract: `sinceMs` on the wire is a DURATION,
// not an absolute cutoff. The gateway half — that this exact literal, fed to
// `runDecisions`, keeps a 10-day-old decision and drops a 60-day-old one —
// lives in `packages/gateway/src/agents/decisions.test.ts` as
// `CLI_SINCE_30D_MS`, because neither package may import the other's source.
// Change one side and the other's assertion fails.
test("parses --since with a day unit", () => {
  expect(parseDecisionsArgs(["--since", "30d"]).sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
});

test("parses --service, --min-confidence, --explain and --json", () => {
  const a = parseDecisionsArgs([
    "--service",
    "billing",
    "--min-confidence",
    "0.6",
    "--explain",
    "--json",
  ]);
  expect(a.service).toBe("billing");
  expect(a.minConfidence).toBeCloseTo(0.6, 5);
  expect(a.explain).toBe(true);
  expect(a.json).toBe(true);
});

test("rejects a min-confidence outside 0..1", () => {
  expect(() => parseDecisionsArgs(["--min-confidence", "2"])).toThrow();
});

test("rejects --since with no value", () => {
  expect(() => parseDecisionsArgs(["--since"])).toThrow();
});

test("rejects combining --refresh and --rebuild", () => {
  expect(() => parseDecisionsArgs(["--refresh", "--rebuild"])).toThrow();
});

test("the brief guard accepts a well-formed payload and rejects junk", () => {
  expect(isDecisionsBriefLike({ kind: "decisions", entries: [], gaps: [] })).toBe(true);
  expect(isDecisionsBriefLike({ kind: "glossary", entries: [], gaps: [] })).toBe(false);
  expect(isDecisionsBriefLike(null)).toBe(false);
});

// --- Supplementary tests beyond the brief's 7, mirroring glossary.test.ts's coverage
// of parsing edge cases, the required noModel surfacing, and the DI-driven dispatch
// (no mock.module — see CLAUDE.md's CI-Linux-only mock.module trap).

test("--help and -h throw usage naming --refresh and --rebuild", () => {
  let usage = "";
  try {
    parseDecisionsArgs(["--help"]);
  } catch (err) {
    usage = err instanceof Error ? err.message : "";
  }
  expect(usage).toContain("nimbus decisions");
  expect(usage).toContain("--refresh");
  expect(usage).toContain("--rebuild");
});

test("an unknown flag throws", () => {
  expect(() => parseDecisionsArgs(["--bogus"])).toThrow("Unknown flag");
});

test("a stray positional argument throws", () => {
  expect(() => parseDecisionsArgs(["billing"])).toThrow("Unexpected argument");
});

test("--min-confidence rejects a non-numeric value", () => {
  expect(() => parseDecisionsArgs(["--min-confidence", "nope"])).toThrow(
    "--min-confidence must be a number between 0 and 1",
  );
});

test("--min-confidence accepts the boundary values 0 and 1", () => {
  expect(parseDecisionsArgs(["--min-confidence", "0"]).minConfidence).toBe(0);
  expect(parseDecisionsArgs(["--min-confidence", "1"]).minConfidence).toBe(1);
});

test("--rebuild and --yes parse independently of --refresh", () => {
  const a = parseDecisionsArgs(["--rebuild"]);
  expect(a.rebuild).toBe(true);
  expect(a.yes).toBe(false);
  const b = parseDecisionsArgs(["--rebuild", "--yes"]);
  expect(b.rebuild).toBe(true);
  expect(b.yes).toBe(true);
});

test("isDecisionsBriefLike rejects non-object, non-null values and non-array fields", () => {
  expect(isDecisionsBriefLike("decisions")).toBe(false);
  expect(isDecisionsBriefLike(42)).toBe(false);
  expect(isDecisionsBriefLike(undefined)).toBe(false);
  expect(isDecisionsBriefLike({ kind: "decisions", entries: "no", gaps: [] })).toBe(false);
  expect(isDecisionsBriefLike({ kind: "decisions", entries: [], gaps: "no" })).toBe(false);
});

describe("renderPassOutcome", () => {
  // The hard requirement: a user with no local model installed must see
  // `noModel` beside `extracted`/`upgraded`, or they wrongly conclude the LLM
  // ran when every decision extracted this pass was a verbatim snippet.
  test("surfaces noModel beside extracted and upgraded", () => {
    const line = renderPassOutcome({
      scanned: 10,
      discovered: 4,
      extracted: 3,
      vetoed: 0,
      upgraded: 1,
      failed: 0,
      noModel: 3,
    });
    expect(line).toContain("3 extracted");
    expect(line).toContain("1 upgraded");
    expect(line).toContain("3 no model");
  });

  test("reports noModel: 0 explicitly rather than omitting it", () => {
    const line = renderPassOutcome({
      scanned: 0,
      discovered: 0,
      extracted: 0,
      vetoed: 0,
      upgraded: 0,
      failed: 0,
      noModel: 0,
    });
    expect(line).toContain("0 no model");
  });

  // A rebuild whose discovery scan hit its batch bound covered only a PREFIX of
  // the index. Printing a bare "Pass complete" over that is the silent-
  // truncation shape the gateway fix removes; the CLI must not re-introduce it.
  test("says so when discovery was incomplete", () => {
    const line = renderPassOutcome({
      scanned: 5_000,
      discovered: 12,
      extracted: 12,
      vetoed: 0,
      upgraded: 0,
      failed: 0,
      noModel: 12,
      discoveryComplete: false,
    });
    expect(line).toContain("INCOMPLETE");
    expect(line).toContain("re-run");
  });

  test("stays silent about discovery when it completed, and when the field is absent", () => {
    const base = {
      scanned: 5,
      discovered: 1,
      extracted: 1,
      vetoed: 0,
      upgraded: 0,
      failed: 0,
      noModel: 1,
    };
    expect(renderPassOutcome({ ...base, discoveryComplete: true })).not.toContain("INCOMPLETE");
    // An older gateway omits the field entirely — never invent a warning from
    // `undefined`.
    expect(renderPassOutcome(base)).not.toContain("INCOMPLETE");
  });
});

/**
 * Duck-typed fake matching the handful of `IPCClient` members `decisions.ts`
 * actually calls. DI, not `mock.module` — no module is intercepted, so this
 * cannot leak into other files in the combined `bun test packages/cli/src` run.
 */
function makeFakeIpcClient(callImpl?: (method: string, params: unknown) => Promise<unknown>): {
  client: IPCClient;
  calls: Array<{ method: string; params: unknown }>;
  fire: (method: string, params: unknown) => void;
  fireClose: (err: Error) => void;
  liveHandlers: () => number;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const closeHandlers = new Set<(err: Error) => void>();
  const fake = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return callImpl === undefined ? { sessionId: "s1" } : callImpl(method, params);
    },
    onNotification: (method: string, handler: (params: unknown) => void): void => {
      const set = handlers.get(method) ?? new Set<(params: unknown) => void>();
      set.add(handler);
      handlers.set(method, set);
    },
    offNotification: (method: string, handler: (params: unknown) => void): void => {
      handlers.get(method)?.delete(handler);
    },
    onClose: (handler: (err: Error) => void): void => {
      closeHandlers.add(handler);
    },
    offClose: (handler: (err: Error) => void): void => {
      closeHandlers.delete(handler);
    },
  };
  const fire = (method: string, params: unknown): void => {
    for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
  };
  const fireClose = (err: Error): void => {
    for (const handler of [...closeHandlers]) handler(err);
  };
  const liveHandlers = (): number => {
    let n = closeHandlers.size;
    for (const set of handlers.values()) n += set.size;
    return n;
  };
  return { client: fake as unknown as IPCClient, calls, fire, fireClose, liveHandlers };
}

const DONE_SUMMARY = {
  scanned: 1,
  discovered: 1,
  extracted: 1,
  vetoed: 0,
  upgraded: 0,
  failed: 0,
  noModel: 0,
};

describe("runDecisionsCommand — dispatch (DI, no mock.module)", () => {
  test("forwards --since/--service/--min-confidence/--explain as agents.decisions params", async () => {
    let seenParams: unknown;
    await runDecisionsCommand(["--since", "30d", "--service", "billing", "--explain"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        seenParams = spec.params;
      },
    });
    expect(seenParams).toEqual({
      sinceMs: 30 * 24 * 60 * 60 * 1000,
      service: "billing",
      explain: true,
    });
  });

  test("['--refresh', '--json'] keeps stdout JSON-only; the pass summary goes to stderr", async () => {
    const { client, calls, fire } = makeFakeIpcClient();
    let stdoutBuf = "";
    let stderrBuf = "";
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string): boolean => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string): boolean => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      await runDecisionsCommand(["--refresh", "--json"], {
        runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
          if (spec.beforeCall !== undefined) {
            const beforeCallPromise = spec.beforeCall(client);
            fire("decisions.passDone", DONE_SUMMARY);
            await beforeCallPromise;
          }
          if (spec.json) process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
        },
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
    expect(calls).toEqual([{ method: "decisions.refresh", params: {} }]);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    expect(stdoutBuf).not.toContain("Pass complete");
    expect(stderrBuf).toContain("Pass complete");
    expect(stderrBuf).toContain("no model");
  });

  test("--rebuild calls decisions.rebuild (not decisions.refresh)", async () => {
    const { client, calls, fire } = makeFakeIpcClient();
    await runDecisionsCommand(["--rebuild", "--yes"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall !== undefined) {
          const p = spec.beforeCall(client);
          fire("decisions.passDone", DONE_SUMMARY);
          await p;
        }
      },
    });
    expect(calls).toEqual([{ method: "decisions.rebuild", params: {} }]);
  });

  test("no --refresh/--rebuild never touches beforeCall", async () => {
    let beforeCallSeen = false;
    await runDecisionsCommand([], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        beforeCallSeen = spec.beforeCall !== undefined;
      },
    });
    expect(beforeCallSeen).toBe(false);
  });
});

describe("runDecisionsCommand — rebuild without --yes", () => {
  let originalExit: typeof process.exit;

  afterEach(() => {
    process.exit = originalExit;
    process.exitCode = 0;
  });

  function stubExit(): { exitCalls: number[] } {
    originalExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number): never => {
      exitCalls.push(code ?? -1);
      throw new Error(`process.exit(${code ?? ""})`);
    }) as typeof process.exit;
    return { exitCalls };
  }

  test("--rebuild without --yes exits 2 and never reaches runAgentBriefCli", async () => {
    const { exitCalls } = stubExit();
    let stderrBuf = "";
    let briefCliCalled = false;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string): boolean => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        runDecisionsCommand(["--rebuild"], {
          runAgentBriefCli: async <T>(_spec: AgentBriefCliSpec<T>): Promise<void> => {
            briefCliCalled = true;
          },
        }),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      process.stderr.write = origStderrWrite;
    }
    expect(exitCalls).toEqual([2]);
    expect(briefCliCalled).toBe(false);
    // Not just "some warning appeared" — the two facts a user needs before
    // typing --yes: vetoes are cleared, and that specific loss is permanent.
    // `decision-store.ts`'s `clearDecisions` docstring: "Clears vetoes too —
    // that is the point of a rebuild."
    expect(stderrBuf).toContain("clears every veto");
    expect(stderrBuf).toContain("cannot be undone");
    expect(stderrBuf).toContain("Re-run with --yes to confirm.");
  });
});

describe("awaitPass — transport death and handler teardown", () => {
  test("a gateway death mid-pass rejects instead of hanging forever", async () => {
    const { client, fireClose } = makeFakeIpcClient();
    const deps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fireClose(new Error("IPC connection closed"));
        await Promise.race([
          passWait,
          Bun.sleep(250).then(() => {
            throw new Error("awaitPass never settled after the transport closed — it hung");
          }),
        ]);
      },
    };

    await expect(runDecisionsCommand(["--refresh"], deps)).rejects.toThrow(
      "gateway connection closed during the pass",
    );
  });

  test("a decisions.passError notification rejects with its message", async () => {
    const { client, fire } = makeFakeIpcClient();
    const deps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fire("decisions.passError", { message: "boom" });
        await passWait;
      },
    };
    await expect(runDecisionsCommand(["--refresh"], deps)).rejects.toThrow("boom");
  });

  test("removes every handler once the pass settles", async () => {
    const { client, fire, liveHandlers } = makeFakeIpcClient();
    let liveDuringPass = 0;
    const deps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        liveDuringPass = liveHandlers();
        fire("decisions.passDone", DONE_SUMMARY);
        await passWait;
      },
    };

    await runDecisionsCommand(["--refresh"], deps);

    expect(liveDuringPass).toBeGreaterThan(0);
    expect(liveHandlers()).toBe(0);
  });
});
