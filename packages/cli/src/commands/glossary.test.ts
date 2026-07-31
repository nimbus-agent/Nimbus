import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  isGlossaryBriefLike,
  parseGlossaryArgs,
  progressLine,
  readRebuildPreview,
  renderPassOutcome,
  renderRebuildPreview,
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
} {
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, (params: unknown) => void>();
  const fake = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return callImpl === undefined ? { sessionId: "s1" } : callImpl(method, params);
    },
    onNotification: (method: string, handler: (params: unknown) => void): void => {
      handlers.set(method, handler);
    },
  };
  const fire = (method: string, params: unknown): void => {
    handlers.get(method)?.(params);
  };
  return { client: fake as unknown as IPCClient, calls, fire };
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
  const BASE = {
    scanned: 0,
    discovered: 0,
    demoted: 0,
    consolidated: 2,
    upgraded: 0,
    vetoed: 0,
    upgradesVetoed: 0,
    vetoedTerms: [] as string[],
    retried: 0,
    llmConfigured: false,
    llmProduced: false,
    aborted: false,
  };

  test("warns when a model was configured but produced nothing", () => {
    const lines = renderPassOutcome({ ...BASE, llmConfigured: true, llmProduced: false });
    expect(lines.join("\n")).toContain("no local LLM provider was available");
  });

  test("does not warn when no model was configured at all", () => {
    expect(renderPassOutcome(BASE).join("\n")).not.toContain("no local LLM provider");
  });

  test("does not warn when the model produced definitions", () => {
    const lines = renderPassOutcome({ ...BASE, llmConfigured: true, llmProduced: true });
    expect(lines.join("\n")).not.toContain("no local LLM provider");
  });

  test("names terms vetoed during an upgrade", () => {
    const lines = renderPassOutcome({
      ...BASE,
      upgradesVetoed: 2,
      vetoedTerms: ["cdr", "slo"],
    });
    expect(lines.join("\n")).toContain("cdr, slo");
    expect(lines.join("\n")).toContain("no longer in the glossary");
  });

  test("does not warn when the model was configured but nothing changed this pass", () => {
    // llmConfigured && !llmProduced is true, but consolidated + upgraded === 0:
    // there is nothing the LLM could have failed to define.
    const lines = renderPassOutcome({
      ...BASE,
      consolidated: 0,
      upgraded: 0,
      llmConfigured: true,
      llmProduced: false,
    });
    expect(lines.join("\n")).not.toContain("no local LLM provider");
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
    const out = renderRebuildPreview({ total: 47, pending: 12 }, [
      "CDR",
      "shard_key",
      "write-behind",
    ]);
    expect(out).toContain("47 consolidated terms and 12 pending candidates");
    expect(out).toContain("CDR, shard_key, write-behind");
    expect(out).toContain("--yes");
  });

  test("omits the remainder line when the sample covers everything", () => {
    const out = renderRebuildPreview({ total: 2, pending: 0 }, ["CDR", "SLO"]);
    expect(out).not.toContain("more");
  });

  test("omits the sample line when there is nothing to sample", () => {
    const out = renderRebuildPreview({ total: 0, pending: 0 }, []);
    expect(out).toContain("0 consolidated terms and 0 pending candidates");
    expect(out).toContain("Re-run with --yes to confirm.");
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
      findings: { stats: { total: 47, pending: 12 }, entries: [{ term: "CDR" }, { term: "SLO" }] },
    });
    const result = await resultPromise;
    expect(result).toEqual({ counts: { total: 47, pending: 12 }, sample: ["CDR", "SLO"] });
    expect(calls).toEqual([{ method: "agents.glossary", params: { limit: 10 } }]);
    expect(calls.some((c) => c.method === "glossary.rebuild")).toBe(false);
    expect(calls.some((c) => c.method === "glossary.refresh")).toBe(false);
  });

  test("rejects on glossary.briefError", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefError", { error: "boom" });
    await expect(resultPromise).rejects.toThrow("boom");
  });

  test("rejects on a malformed glossary.briefReady payload", async () => {
    const { client, fire } = makeFakeIpcClient();
    const resultPromise = readRebuildPreview(client);
    fire("glossary.briefReady", { findings: { stats: { total: "no" }, entries: [] } });
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
});
