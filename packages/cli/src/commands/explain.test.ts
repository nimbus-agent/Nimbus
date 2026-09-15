// DI test for `runExplain` (fix-wave finding CRITICAL 2). The header comment on `runExplain`
// claimed it was "exported separately so unit tests need no live gateway" — no such test existed
// until this file. DI over a duck-typed `IPCClient`, never `mock.module` (process-global, leaks
// across the combined `bun test packages/cli/src` run — see CLAUDE.md's CI-Linux-only trap).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IPCClient } from "../ipc-client/index.ts";
import { runExplain } from "./explain.ts";

function makeFakeIpcClient(callImpl: (method: string, params: unknown) => Promise<unknown>): {
  client: IPCClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fake = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return callImpl(method, params);
    },
    onNotification: (): void => {},
    offNotification: (): void => {},
    onClose: (): void => {},
    offClose: (): void => {},
  };
  return { client: fake as unknown as IPCClient, calls };
}

const RECORD_RAW = {
  askedAt: 1_700_000_000_000,
  durationMs: 342,
  question: "what did we decide about rate limiting?",
  source: "local" as const,
  persona: "standard/standard",
  classifier: { called: false, reason: "local preference" },
  route: "empty_index" as const,
};

describe("runExplain (DI, no live gateway)", () => {
  // Captured unconditionally in `beforeEach` — not lazily on first use — so `afterEach` always
  // restores the REAL functions it actually swapped out, even for a test (the usage-error one)
  // that never writes any output. A lazy capture left `origWrite` `undefined` on such a test and
  // `afterEach` then clobbered `process.stdout.write` with `undefined` for every later test in the
  // run, a real defect this rewrite fixes rather than merely avoids re-triggering.
  let origWrite: typeof process.stdout.write;
  let origLog: typeof console.log;
  let stdoutBuf = "";
  let logBuf = "";

  beforeEach(() => {
    stdoutBuf = "";
    logBuf = "";
    origWrite = process.stdout.write.bind(process.stdout);
    origLog = console.log.bind(console);
    process.stdout.write = ((chunk: string): boolean => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write;
    console.log = ((...args: unknown[]): void => {
      logBuf += `${args.map(String).join(" ")}\n`;
    }) as typeof console.log;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    console.log = origLog;
  });

  test("a bad subcommand throws a usage error before ever calling the gateway", async () => {
    const { client, calls } = makeFakeIpcClient(async () => {
      throw new Error("must not be called");
    });
    await expect(runExplain(client, ["bogus"])).rejects.toThrow(/usage: nimbus explain last/i);
    await expect(runExplain(client, [])).rejects.toThrow(/usage: nimbus explain last/i);
    expect(calls).toHaveLength(0);
  });

  test("record: null renders the honest 'no ask recorded' line, not an empty report", async () => {
    const { client, calls } = makeFakeIpcClient(async () => ({
      record: null,
      reason: "no_ask_since_start",
    }));
    await runExplain(client, ["last"]);
    expect(calls).toEqual([{ method: "ask.explainLast", params: null }]);
    expect(stdoutBuf).toContain("No ask recorded since the gateway started.");
  });

  test("a real record renders through formatExplain, including the question", async () => {
    const { client } = makeFakeIpcClient(async () => ({ record: RECORD_RAW }));
    await runExplain(client, ["last"]);
    expect(stdoutBuf).toContain("nimbus explain last");
    expect(stdoutBuf).toContain("Question:");
    expect(stdoutBuf).toContain(RECORD_RAW.question);
    expect(stdoutBuf).toMatch(/index was empty/i);
  });

  test("--json emits the parsed (validated) record via console.log, not the raw wire response", async () => {
    const { client } = makeFakeIpcClient(async () => ({ record: RECORD_RAW }));
    await runExplain(client, ["last", "--json"]);
    // --json must short-circuit before the human-readable renderer runs.
    expect(stdoutBuf).toBe("");
    const parsed: unknown = JSON.parse(logBuf.trim());
    expect(parsed).toEqual({ record: RECORD_RAW });
  });

  test("--json on the empty ring emits { record: null, reason }", async () => {
    const { client } = makeFakeIpcClient(async () => ({
      record: null,
      reason: "no_ask_since_start",
    }));
    await runExplain(client, ["last", "--json"]);
    const parsed: unknown = JSON.parse(logBuf.trim());
    expect(parsed).toEqual({ record: null, reason: "no_ask_since_start" });
  });

  test("a malformed gateway response throws rather than rendering silently", async () => {
    const { client } = makeFakeIpcClient(async () => ({ record: { totally: "wrong shape" } }));
    await expect(runExplain(client, ["last"])).rejects.toThrow(/malformed response/i);
  });
});
