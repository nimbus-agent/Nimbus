import { afterEach, describe, expect, test } from "bun:test";
import type { IPCClient } from "../ipc-client/index.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import {
  isGlossaryBriefLike,
  parseGlossaryArgs,
  progressLine,
  readRebuildPreview,
  renderPassOutcome,
  renderRebuildPreview,
  runGlossaryCommand,
} from "./glossary.ts";

interface RecordedCall {
  method: string;
  params: unknown;
}

/**
 * Duck-typed fake matching the handful of `IPCClient` members `glossary.ts`
 * actually calls. DI, not `mock.module` — no module is intercepted, so this
 * cannot leak into other files in the combined `bun test packages/cli/src` run.
 */
function makeFakeIpcClient(callImpl?: (method: string, params: unknown) => Promise<unknown>): {
  client: IPCClient;
  calls: RecordedCall[];
  fire: (method: string, params: unknown) => void;
  fireClose: (err: Error) => void;
  liveHandlers: () => number;
} {
  const calls: RecordedCall[] = [];
  // Sets, not a single handler per method — the real `IPCClient` keeps a Set,
  // and a fake that silently replaced a second registration would hide exactly
  // the leak `liveHandlers` exists to catch.
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
  /** Simulate the transport dying — what `IPCClient.onClose` reports. */
  const fireClose = (err: Error): void => {
    for (const handler of [...closeHandlers]) handler(err);
  };
  /** Total live handlers, so a test can prove teardown actually removed them. */
  const liveHandlers = (): number => {
    let n = closeHandlers.size;
    for (const set of handlers.values()) n += set.size;
    return n;
  };
  return { client: fake as unknown as IPCClient, calls, fire, fireClose, liveHandlers };
}

test("no arguments yields a list request", () => {
  const a = parseGlossaryArgs([]);
  expect(a.term).toBeUndefined();
  expect(a.json).toBe(false);
});

test("a positional argument becomes the term", () => {
  expect(parseGlossaryArgs(["CDR"]).term).toBe("CDR");
});

test("a multi-word term is joined", () => {
  expect(parseGlossaryArgs(["Change", "Data", "Record"]).term).toBe("Change Data Record");
});

test("--json sets the json flag", () => {
  expect(parseGlossaryArgs(["--json"]).json).toBe(true);
});

test("--limit parses a positive integer", () => {
  expect(parseGlossaryArgs(["--limit", "10"]).limit).toBe(10);
});

test("--limit rejects a non-positive value", () => {
  expect(() => parseGlossaryArgs(["--limit", "0"])).toThrow();
});

test("--limit rejects a missing value", () => {
  expect(() => parseGlossaryArgs(["--limit"])).toThrow();
});

test("the usage line advertises --refresh and --rebuild", () => {
  let usage = "";
  try {
    parseGlossaryArgs(["--help"]);
  } catch (err) {
    usage = err instanceof Error ? err.message : "";
  }
  expect(usage).toContain("nimbus glossary");
  expect(usage).toContain("--refresh");
  expect(usage).toContain("--rebuild");
});

test("flags combine with a term", () => {
  const a = parseGlossaryArgs(["CDR", "--json"]);
  expect(a.term).toBe("CDR");
  expect(a.json).toBe(true);
});

test("isGlossaryBriefLike accepts a well-formed brief", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: [], mode: "list" })).toBe(true);
});

test("isGlossaryBriefLike rejects malformed payloads", () => {
  expect(isGlossaryBriefLike(null)).toBe(false);
  expect(isGlossaryBriefLike({ kind: "why", entries: [], gaps: [], mode: "list" })).toBe(false);
  expect(isGlossaryBriefLike({ kind: "glossary", entries: "no", gaps: [], mode: "list" })).toBe(
    false,
  );
});

// --- Supplementary tests beyond the brief's 11, added to close branch-coverage gaps
// (local coverage tooling did not produce numbers in this environment; gaps identified
// by manual review of parseGlossaryArgs / isGlossaryBriefLike). See task-15-report.md.

test("--help and -h throw usage", () => {
  expect(() => parseGlossaryArgs(["--help"])).toThrow();
  expect(() => parseGlossaryArgs(["-h"])).toThrow();
});

test("an unknown flag throws", () => {
  expect(() => parseGlossaryArgs(["--bogus"])).toThrow();
});

test("isGlossaryBriefLike rejects non-object, non-null values", () => {
  expect(isGlossaryBriefLike("glossary")).toBe(false);
  expect(isGlossaryBriefLike(42)).toBe(false);
  expect(isGlossaryBriefLike(undefined)).toBe(false);
});

test("isGlossaryBriefLike rejects a non-string mode", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: [], mode: 1 })).toBe(false);
});

test("isGlossaryBriefLike rejects non-array gaps", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: "no", mode: "list" })).toBe(
    false,
  );
});

describe("glossary flag parsing", () => {
  test("parses --refresh", () => {
    expect(parseGlossaryArgs(["--refresh"]).refresh).toBe(true);
  });

  test("parses --rebuild and --yes independently", () => {
    const a = parseGlossaryArgs(["--rebuild"]);
    expect(a.rebuild).toBe(true);
    expect(a.yes).toBe(false);
    const b = parseGlossaryArgs(["--rebuild", "--yes"]);
    expect(b.rebuild).toBe(true);
    expect(b.yes).toBe(true);
  });

  test("rejects --refresh together with --rebuild", () => {
    expect(() => parseGlossaryArgs(["--refresh", "--rebuild"])).toThrow("cannot be combined");
  });
});

describe("renderPassOutcome", () => {
  // `consolidated`/`upgraded` default to 0: when `llmConfigured` is true,
  // `consolidateTerm` labels every `defined` outcome `source: "llm"` and sets
  // `llmProduced` one line above incrementing either counter
  // (`glossary-extract.ts`), so `llmConfigured && !llmProduced && (consolidated
  // > 0 || upgraded > 0)` is a summary shape the gateway can never actually
  // emit. Tests that need a positive `consolidated`/`upgraded` override it
  // alongside `llmProduced: true` (or leave `llmConfigured: false`) so the
  // fixture always stays a summary `runGlossaryPass` could really produce.
  const BASE = {
    scanned: 0,
    discovered: 0,
    demoted: 0,
    consolidated: 0,
    upgraded: 0,
    vetoed: 0,
    upgradesVetoed: 0,
    vetoedTerms: [] as string[],
    retried: 0,
    llmConfigured: false,
    llmProduced: false,
    aborted: false,
  };

  test("warns on the dead-model shape: configured, never answered, terms deferred to retry", () => {
    // The realistic "Ollama stopped" summary: nothing was consolidated or
    // upgraded (a model that never answers can't produce either), and every
    // term touched this pass fell through to `retry`.
    const lines = renderPassOutcome({
      ...BASE,
      retried: 2,
      llmConfigured: true,
      llmProduced: false,
    });
    expect(lines.join("\n")).toContain("no local LLM provider answered");
    expect(lines.join("\n")).toContain("2 term(s) were deferred");
  });

  test("does not warn when no model was configured at all", () => {
    expect(renderPassOutcome(BASE).join("\n")).not.toContain("no local LLM provider");
  });

  test("does not warn when the model produced definitions", () => {
    const lines = renderPassOutcome({
      ...BASE,
      consolidated: 2,
      llmConfigured: true,
      llmProduced: true,
    });
    expect(lines.join("\n")).not.toContain("no local LLM provider");
  });

  test("names terms vetoed during an upgrade", () => {
    const lines = renderPassOutcome({
      ...BASE,
      upgradesVetoed: 2,
      vetoedTerms: ["CDR", "SLO"],
    });
    expect(lines.join("\n")).toContain("CDR, SLO");
    expect(lines.join("\n")).toContain("no longer in the glossary");
  });

  test("names the veto overflow when more terms were vetoed than reported by name", () => {
    const lines = renderPassOutcome({
      ...BASE,
      upgradesVetoed: 12,
      vetoedTerms: Array.from({ length: 10 }, (_, i) => `TERM${String(i)}`),
    });
    expect(lines.join("\n")).toContain("and 2 more");
  });

  test("does not warn when the model was configured but nothing was deferred to retry", () => {
    // llmConfigured && !llmProduced is true, but retried === 0: the model
    // never answered because it was never asked to (nothing landed in the
    // upgrade/pending queues this pass), not because it failed to.
    const lines = renderPassOutcome({
      ...BASE,
      llmConfigured: true,
      llmProduced: false,
    });
    expect(lines.join("\n")).not.toContain("no local LLM provider");
  });

  test("omits the skipped-entries section when manualSkipped is absent or empty", () => {
    expect(renderPassOutcome(BASE).join("\n")).not.toContain("[glossary.terms]");
    expect(renderPassOutcome({ ...BASE, manualSkipped: [] }).join("\n")).not.toContain(
      "[glossary.terms]",
    );
  });

  test("the pass outcome names skipped config entries", () => {
    // `vetoed` is deliberately omitted here: `GlossaryPassSummaryLike` (the
    // CLI's structural stand-in) has no such field — only the gateway's
    // `GlossaryPassSummary` does — and `renderPassOutcome` never reads it.
    const lines = renderPassOutcome({
      consolidated: 0,
      upgraded: 0,
      upgradesVetoed: 0,
      vetoedTerms: [],
      retried: 0,
      llmConfigured: false,
      llmProduced: false,
      manualSkipped: [{ entry: "CDR", reason: "empty definition" }],
    });
    expect(lines.join("\n")).toContain("CDR");
    expect(lines.join("\n")).toContain("empty definition");
  });
});

describe("progressLine", () => {
  test("clears to end of line so a shorter update cannot leave stale characters", () => {
    const long = progressLine(9, 100);
    const short = progressLine(1, 2);
    expect(long.startsWith("\r\x1b[K")).toBe(true);
    expect(short.startsWith("\r\x1b[K")).toBe(true);
    expect(short).toContain("1/2");
    // No trailing newline: the line is rewritten in place, and awaitPass emits
    // the single closing newline once the pass ends.
    expect(short.endsWith("\n")).toBe(false);
  });
});

describe("renderRebuildPreview", () => {
  test("lists a sample and the remainder", () => {
    const out = renderRebuildPreview({ total: 47, pending: 12, manual: 0 }, [
      "CDR",
      "shard_key",
      "write-behind",
    ]);
    expect(out).toContain("47 mined terms and 12 pending candidates");
    expect(out).toContain("CDR, shard_key, write-behind");
    expect(out).toContain("--yes");
  });

  test("warns that a rebuild only re-mines incrementally, not all at once", () => {
    // A confirmed --rebuild truncates immediately but re-derives via the
    // ordinary bounded pass (SCAN_BATCH_LIMIT / maxNewTermsPerPass), so the
    // confirm prompt must say so up front rather than let the user believe
    // "Pass complete" means the whole glossary came back.
    const out = renderRebuildPreview({ total: 47, pending: 12, manual: 0 }, ["CDR"]);
    expect(out).toContain("Rebuilding re-mines incrementally");
    expect(out).toContain("the full glossary returns over subsequent passes");
  });

  test("omits the remainder line when the sample covers everything", () => {
    const out = renderRebuildPreview({ total: 2, pending: 0, manual: 0 }, ["CDR", "SLO"]);
    expect(out).not.toContain("more");
  });

  test("omits the sample line when there is nothing to sample", () => {
    const out = renderRebuildPreview({ total: 0, pending: 0, manual: 0 }, []);
    expect(out).toContain("0 mined terms and 0 pending candidates");
    expect(out).toContain("Re-run with --yes to confirm.");
  });

  test("shows the remainder line even with an empty sample", () => {
    // sample.length === 0 (no sample line) but remainder = 5 - 0 > 0 (the
    // remainder line still fires) — a distinct branch from both tests above.
    const out = renderRebuildPreview({ total: 5, pending: 0, manual: 0 }, []);
    expect(out).toContain("... and 5 more");
  });

  test("omits the authored-terms line when manual is 0", () => {
    const out = renderRebuildPreview({ total: 5, pending: 0, manual: 0 }, []);
    expect(out).not.toContain("authored term");
  });

  test("the rebuild preview does not claim authored terms will be deleted", () => {
    const out = renderRebuildPreview({ total: 10, pending: 4, manual: 3 }, ["CDR", "widget"]);
    // `startsWith`, not `toContain` — "7 mined terms" as a bare substring
    // check would also match a mangled "-7 mined terms" (e.g. an inverted
    // `manual - total` subtraction), which is exactly the arithmetic bug this
    // test exists to catch. Anchoring at the start of the line rules that out.
    expect(out.startsWith("7 mined terms")).toBe(true);
    expect(out).toContain("3 authored term");
    expect(out).toContain("nimbus.toml");
  });
});

describe("readRebuildPreview", () => {
  // `readRebuildPreview` registers its notification handlers BEFORE calling
  // `client.call`, so firing the notification synchronously right after
  // invoking it (before awaiting) is safe — this mirrors how the real
  // gateway's `glossary.briefReady` arrives asynchronously relative to the
  // `agents.glossary` RPC reply.
  test("calls only agents.glossary — never a mutating glossary.* method", async () => {
    const { client, calls, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefReady", {
      findings: {
        stats: { total: 47, pending: 12, manual: 0 },
        entries: [{ term: "CDR" }, { term: "SLO" }],
      },
    });
    const result = await resultPromise;
    expect(result).toEqual({
      counts: { total: 47, pending: 12, manual: 0 },
      sample: ["CDR", "SLO"],
    });
    expect(calls).toEqual([{ method: "agents.glossary", params: { limit: 10 } }]);
    expect(calls.some((c) => c.method === "glossary.rebuild")).toBe(false);
    expect(calls.some((c) => c.method === "glossary.refresh")).toBe(false);
  });

  // Authored terms sort first (glossary-store.ts), so without this filter
  // they would head the "would be deleted" sample despite never actually
  // being deleted.
  test("filters authored entries out of the sample", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefReady", {
      findings: {
        stats: { total: 2, pending: 0, manual: 1 },
        entries: [
          { term: "CDR", definitionSource: "manual" },
          { term: "widget", definitionSource: "llm" },
        ],
      },
    });
    const result = await resultPromise;
    expect(result.sample).toEqual(["widget"]);
  });

  test("rejects on glossary.briefError", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefError", { error: "boom" });
    await expect(resultPromise).rejects.toThrow("boom");
  });

  test("rejects on a malformed glossary.briefReady payload (total mistyped)", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefReady", { findings: { stats: { total: "no", pending: 0 }, entries: [] } });
    await expect(resultPromise).rejects.toThrow("Malformed glossary.briefReady payload");
  });

  test("rejects when glossary.briefReady itself is not an object", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefReady", null);
    await expect(resultPromise).rejects.toThrow("Malformed glossary.briefReady payload");
  });

  test("rejects with a fallback message when briefError carries no error string", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefError", {});
    await expect(resultPromise).rejects.toThrow("Agent failed");
  });

  test("propagates a rejected agents.glossary call", async () => {
    const { client } = makeFakeIpcClient(() => Promise.reject(new Error("no gateway")));
    await expect(readRebuildPreview(client)).rejects.toThrow("no gateway");
  });

  test("normalises a non-Error rejection from agents.glossary into an Error", async () => {
    // Deliberately a raw string rejection (not `new Error(...)`), to prove
    // `settleReject` normalises it the same way `awaitPass` does.
    const { client } = makeFakeIpcClient(() => Promise.reject("boom-string"));
    await expect(readRebuildPreview(client)).rejects.toThrow("boom-string");
  });

  test("times out if neither briefReady nor briefError ever arrives", async () => {
    const { client } = makeFakeIpcClient();
    await expect(readRebuildPreview(client, 5)).rejects.toThrow("Agent timed out after 0 s");
  });

  describe("isGlossaryPreviewLike branch coverage (via readRebuildPreview)", () => {
    test("rejects when stats is null", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", { findings: { stats: null, entries: [] } });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });

    test("rejects when stats is not an object", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", { findings: { stats: "nope", entries: [] } });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });

    test("rejects when stats.pending (not just stats.total) is mistyped", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", {
        findings: { stats: { total: 1, pending: "no" }, entries: [] },
      });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });

    test("rejects when stats.manual (not just total/pending) is mistyped", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", {
        findings: { stats: { total: 1, pending: 0, manual: "no" }, entries: [] },
      });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });

    test("rejects when entries is not an array", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", {
        findings: { stats: { total: 1, pending: 0, manual: 0 }, entries: "nope" },
      });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });

    test("rejects when an entry has no string term", async () => {
      const { client, fire } = makeFakeIpcClient();
      const p = readRebuildPreview(client);
      fire("glossary.briefReady", {
        findings: { stats: { total: 1, pending: 0, manual: 0 }, entries: [{ term: 1 }] },
      });
      await expect(p).rejects.toThrow("Malformed glossary.briefReady payload");
    });
  });
});

describe("runGlossaryCommand — dispatch (DI, no mock.module)", () => {
  test("['--rebuild'] touches nothing and never reaches runAgentBriefCli", async () => {
    const { client, calls, fire } = makeFakeIpcClient();
    let briefCliCalled = false;
    let stdoutBuf = "";
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string): boolean => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const resultPromise = runGlossaryCommand(["--rebuild"], {
        withGatewayIpc: async (fn) => fn(client),
        runAgentBriefCli: async <T>(_spec: AgentBriefCliSpec<T>): Promise<void> => {
          briefCliCalled = true;
        },
      });
      fire("glossary.briefReady", {
        findings: { stats: { total: 5, pending: 1, manual: 0 }, entries: [{ term: "CDR" }] },
      });
      await resultPromise;
    } finally {
      process.stdout.write = origStdoutWrite;
    }
    // The headline safety property: assert on the IPC call log, not merely on
    // stdout. `runAgentBriefCli` — the only place `glossary.refresh` /
    // `glossary.rebuild` are ever invoked — was never reached at all.
    expect(briefCliCalled).toBe(false);
    expect(calls).toEqual([{ method: "agents.glossary", params: { limit: 10 } }]);
    expect(calls.some((c) => c.method === "glossary.rebuild")).toBe(false);
    expect(calls.some((c) => c.method === "glossary.refresh")).toBe(false);
    expect(stdoutBuf).toContain("5 mined terms");
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
      await runGlossaryCommand(["--refresh", "--json"], {
        withGatewayIpc: async () => {
          throw new Error("withGatewayIpc should not be used on the --refresh path");
        },
        runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
          if (spec.beforeCall !== undefined) {
            const beforeCallPromise = spec.beforeCall(client);
            // `awaitPass` registers its handlers synchronously before this
            // point returns control here, so firing immediately is safe.
            fire("glossary.passDone", {
              consolidated: 3,
              upgraded: 1,
              upgradesVetoed: 0,
              vetoedTerms: [],
              retried: 0,
              llmConfigured: false,
              llmProduced: false,
            });
            await beforeCallPromise;
          }
          if (spec.json) process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
        },
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
    expect(calls.some((c) => c.method === "glossary.refresh")).toBe(true);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    expect(stdoutBuf).not.toContain("Pass complete");
    expect(stderrBuf).toContain("Pass complete");
  });
});

describe("runGlossaryCommand — rebuild-preview error exit code", () => {
  // `process.exit()` really terminates the process — even inside a test —
  // so it must be stubbed to throw instead of firing for real. The stub
  // replaces `process.exit` entirely (never calling through to the real
  // one) and is restored in `afterEach`, so it can never leak into another
  // test file in the combined `bun test packages/cli/src` run. This test
  // never touches `process.exitCode` (the documented leak vector — a test
  // that sets it must reset it in `afterEach`); it only intercepts the
  // `process.exit` function reference itself, so there is nothing to reset
  // there, but `process.exitCode` is defensively zeroed anyway as a
  // second line of defence against any other code path that might set it.
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

  test("a GatewayNotRunningError from withGatewayIpc exits 1, not 2", async () => {
    // Pins the other half of the split this task's e2e regression test caught:
    // a gateway-not-running precondition failure must exit 1 (matching every
    // other command's "gateway not running" code, `docs/cli-reference.md`),
    // while the tests below pin that a genuine agent-call failure (timeout /
    // malformed payload) still exits 2. Without both sides pinned, a later
    // "simplification" collapsing the two exit codes back into one would only
    // be caught by whichever side happens to still have a test.
    const { exitCalls } = stubExit();
    let stderrBuf = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string): boolean => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        runGlossaryCommand(["--rebuild"], {
          withGatewayIpc: async () => {
            throw new GatewayNotRunningError();
          },
          runAgentBriefCli: async <T>(_spec: AgentBriefCliSpec<T>): Promise<void> => {},
        }),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      process.stderr.write = origStderrWrite;
    }
    expect(exitCalls).toEqual([1]);
    expect(stderrBuf).toContain("Gateway is not running");
  });

  test("a readRebuildPreview timeout exits 2 with the sibling error shape", async () => {
    const { exitCalls } = stubExit();
    const { client } = makeFakeIpcClient();
    let stderrBuf = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string): boolean => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        runGlossaryCommand(["--rebuild"], {
          withGatewayIpc: async (fn) => fn(client),
          runAgentBriefCli: async <T>(_spec: AgentBriefCliSpec<T>): Promise<void> => {},
          // Force the real timeout branch inside readRebuildPreview without a
          // real 30s wait — no notification is ever fired, so this genuinely
          // drives the timer to expiry, not a compile-only check.
          rebuildPreviewTimeoutMs: 5,
        }),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      process.stderr.write = origStderrWrite;
    }
    expect(exitCalls).toEqual([2]);
    expect(stderrBuf).toContain("Agent timed out after 0 s");
  });

  test("a malformed agents.glossary response exits 2 with the sibling error shape", async () => {
    const { exitCalls } = stubExit();
    const { client, fire } = makeFakeIpcClient();
    let stderrBuf = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string): boolean => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      const resultPromise = runGlossaryCommand(["--rebuild"], {
        withGatewayIpc: async (fn) => fn(client),
        runAgentBriefCli: async <T>(_spec: AgentBriefCliSpec<T>): Promise<void> => {},
      });
      fire("glossary.briefReady", { findings: { stats: { total: 1 }, entries: [] } });
      await expect(resultPromise).rejects.toThrow("process.exit(2)");
    } finally {
      process.stderr.write = origStderrWrite;
    }
    expect(exitCalls).toEqual([2]);
    expect(stderrBuf).toContain("Malformed glossary.briefReady payload");
  });
});

describe("awaitPass — transport death", () => {
  const DONE_SUMMARY = {
    consolidated: 1,
    upgraded: 0,
    upgradesVetoed: 0,
    vetoedTerms: [] as string[],
    retried: 0,
    llmConfigured: false,
    llmProduced: false,
  };

  /**
   * The failure this closes: `--refresh` starts a pass whose result arrives as
   * a NOTIFICATION, so the `call()` that started it has already resolved and
   * the client's `requestTimeoutMs` no longer protects anything. Before
   * `@nimbus-dev/client` 0.15.0 exposed `onClose`, a gateway dying here left the
   * CLI waiting forever — no pending call to reject, no notification ever
   * coming. There is deliberately no timeout instead, because a pass
   * legitimately runs minutes; only the transport closing is a reliable signal.
   */
  test("a gateway death mid-pass rejects instead of hanging forever", async () => {
    const { client, fireClose } = makeFakeIpcClient();
    const deps = {
      withGatewayIpc: async <T>(fn: (c: IPCClient) => Promise<T>): Promise<T> => fn(client),
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        // `awaitPass` registers its handlers synchronously before yielding, so
        // the transport can die right here.
        fireClose(new Error("IPC connection closed"));
        // Raced against a short deadline on purpose. Without the `onClose`
        // wiring this wait never settles, and an unraced `await` would express
        // that as a suite TIMEOUT — a slow, generic failure a future reader
        // could easily mistake for flake. The race turns the regression into a
        // fast assertion that names itself.
        await Promise.race([
          passWait,
          Bun.sleep(250).then(() => {
            throw new Error("awaitPass never settled after the transport closed — it hung");
          }),
        ]);
      },
    };

    await expect(runGlossaryCommand(["--refresh"], deps)).rejects.toThrow(
      "gateway connection closed during the pass",
    );
  });

  test("removes every handler once the pass settles", async () => {
    const { client, fire, liveHandlers } = makeFakeIpcClient();
    let liveDuringPass = 0;
    const deps = {
      withGatewayIpc: async <T>(fn: (c: IPCClient) => Promise<T>): Promise<T> => fn(client),
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        liveDuringPass = liveHandlers();
        fire("glossary.passDone", DONE_SUMMARY);
        await passWait;
      },
    };

    await runGlossaryCommand(["--refresh"], deps);

    expect(liveDuringPass).toBeGreaterThan(0);
    // `runAgentBriefCli` reuses this same client for the brief that runs
    // immediately afterwards, so a leaked handler is a live cross-phase
    // listener rather than merely untidy — which is why the client documents
    // pairing every `on*` with its `off*`.
    expect(liveHandlers()).toBe(0);
  });
});
