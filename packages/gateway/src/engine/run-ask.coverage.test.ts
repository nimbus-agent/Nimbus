/**
 * run-ask.coverage.test.ts — the `runAsk` arms the main suite leaves open: an unreadable or
 * malformed item count, the classifier's own refusals when nothing is injected, a non-Error throw
 * reaching the explain record, a string tool result, the `empty_index` and fallback-term
 * `local_context` explain routes, and `buildLocalIndexedContext`'s early returns, quoted-query /
 * repo-slug dedupe and unscored-candidate shapes.
 *
 * Dependency injection only — stubs are passed in, never `mock.module` (process-global in bun).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import { dbRun } from "../db/write.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { RankedIndexItem } from "../index/ranked-item.ts";
import type { SearchRankedResult } from "../index/search-retrieval.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import type { ClassifiedIntent } from "./router.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts";
import { buildLocalIndexedContextForTest, type RunAskParams, runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher } from "./types.ts";

ensureFullSqlite();

const stubBase = join(tmpdir(), "nimbus-run-ask-coverage-test");
const stubPaths: PlatformPaths = {
  configDir: join(stubBase, "cfg"),
  dataDir: join(stubBase, "data"),
  logDir: join(stubBase, "logs"),
  socketPath: join(stubBase, "gateway.sock"),
  extensionsDir: join(stubBase, "ext"),
  tempDir: join(stubBase, "tmp"),
  sandboxDir: join(stubBase, "sandbox"),
};

const stubConsent: ConsentCoordinator = {
  requestConsent: () => Promise.resolve(false),
  rejectAllPending: () => {},
  pendingCount: () => 0,
};

const nullDispatcher: ConnectorDispatcher = { dispatch: () => Promise.resolve(null) };

const UNKNOWN_CONFIDENT: ClassifiedIntent = {
  intent: "unknown",
  entities: {},
  requiresHITL: false,
  confidence: 0.9,
};

/** A real in-memory index holding `n` unrelated items (0 = the empty index). */
function realIndex(n: number): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  for (let i = 0; i < n; i++) {
    dbRun(
      db,
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) " +
        "VALUES (?, 'seed', 'note', ?, 'unrelated seeded item', 1, 1)",
      [`seed:${String(i)}`, String(i)],
    );
  }
  return new LocalIndex(db);
}

function baseParams(over: Partial<RunAskParams> & Pick<RunAskParams, "localIndex">): RunAskParams {
  return {
    input: "what changed in billing",
    stream: false,
    clientId: "cov-client",
    paths: stubPaths,
    consentCoordinator: stubConsent,
    dispatcher: nullDispatcher,
    egressSink: NULL_EGRESS_SINK,
    sendChunk: () => {},
    ...over,
  };
}

describe("runAsk — the item count", () => {
  test("an index whose count cannot be read is NOT reported as empty", async () => {
    // `getDatabase` throws, so the count is unknown — which must not read as zero: that would
    // tell a user with a full index to go connect a service.
    const unreadable = {
      getDatabase: () => {
        throw new Error("database is locked");
      },
    } as unknown as LocalIndex;
    const recorder = new AskExplainRecorder();
    const out = await runAsk(
      baseParams({
        localIndex: unreadable,
        classify: () => Promise.resolve(UNKNOWN_CONFIDENT),
        explainRecorder: recorder,
      }),
    );
    expect(out.reply).not.toContain("No data indexed yet");
    expect(out.reply).toContain("I can search your indexed sandbox");
    expect(recorder.last()?.route).toBe("plan_dispatch");
  });

  test("a count query that yields no row reads as zero, so the onboarding guidance is shown", async () => {
    const chunks: string[] = [];
    const noRow = {
      getDatabase: () => ({ query: () => ({ get: () => null }) }),
    } as unknown as LocalIndex;
    const out = await runAsk(
      baseParams({
        localIndex: noRow,
        stream: true,
        sendChunk: (t) => chunks.push(t),
        classify: () => Promise.reject(new Error("the classifier must not run on an empty index")),
      }),
    );
    expect(out.reply).toContain("No data indexed yet");
    expect(chunks.join("")).toContain("No data indexed yet");
  });

  test("an empty index is recorded as the empty_index route, with the classifier skipped", async () => {
    const recorder = new AskExplainRecorder();
    const idx = realIndex(0);
    try {
      await runAsk(baseParams({ localIndex: idx, explainRecorder: recorder }));
    } finally {
      idx.close();
    }
    const last = recorder.last();
    expect(last?.route).toBe("empty_index");
    expect(last?.classifier).toEqual({ called: false, reason: "index is empty" });
    expect(last?.question).toBe("what changed in billing");
  });
});

describe("runAsk — the classifier's own refusals", () => {
  test("with no router and nothing injected, the classifier's no_api_key refusal propagates", async () => {
    const recorder = new AskExplainRecorder();
    const idx = realIndex(1);
    let caught: unknown;
    try {
      await runAsk(baseParams({ localIndex: idx, explainRecorder: recorder }));
    } catch (e) {
      caught = e;
    } finally {
      idx.close();
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("no_api_key");
    const last = recorder.last();
    expect(last?.route).toBe("failed");
    expect(last?.route === "failed" ? last.stage : undefined).toBe("classification");
    expect(last?.classifier.called).toBe(false);
  });

  test("a classifier crash that is not an agent-unavailable error surfaces as 'unknown'", async () => {
    // The router answers with no `text`, so the classifier's parse step throws a TypeError OUTSIDE
    // its own try. That raw error must never reach the user: it is re-raised as the generic
    // agent-unavailable error.
    const malformedRouter = {
      prefersLocal: () => false,
      enforcesAirGap: () => false,
      generate: () =>
        Promise.resolve({
          tokensIn: 0,
          tokensOut: 0,
          modelUsed: "m",
          isLocal: true,
          provider: "ollama",
        }),
    } as unknown as LlmRouter;
    const idx = realIndex(1);
    let caught: unknown;
    try {
      await runAsk(baseParams({ localIndex: idx, llmRouter: malformedRouter }));
    } catch (e) {
      caught = e;
    } finally {
      idx.close();
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    const err = caught as GatewayAgentUnavailableError;
    expect(err.reason).toBe("unknown");
    expect(err.message).toBe("Agent unavailable. Check the gateway log for details.");
    expect(err.message).not.toContain("trim");
  });

  test("a non-Error throw is recorded by its string form and re-thrown unchanged", async () => {
    const recorder = new AskExplainRecorder();
    const idx = realIndex(1);
    const thrown = { toString: () => "classifier exploded" };
    let caught: unknown;
    try {
      await runAsk(
        baseParams({
          localIndex: idx,
          explainRecorder: recorder,
          classify: () => Promise.reject(thrown),
        }),
      );
    } catch (e) {
      caught = e;
    } finally {
      idx.close();
    }
    expect(caught).toBe(thrown);
    const last = recorder.last();
    expect(last?.route === "failed" ? last.error : undefined).toBe("classifier exploded");
  });
});

describe("runAsk — plan dispatch", () => {
  test("a string tool result is summarised verbatim, not JSON-encoded", async () => {
    const chunks: string[] = [];
    const idx = realIndex(1);
    try {
      const out = await runAsk(
        baseParams({
          localIndex: idx,
          stream: true,
          sendChunk: (t) => chunks.push(t),
          classify: () =>
            Promise.resolve({
              intent: "file_search",
              entities: { pattern: "*.md" },
              requiresHITL: false,
              confidence: 0.95,
            }),
          dispatcher: { dispatch: () => Promise.resolve("a.md\nb.md") },
        }),
      );
      expect(out.reply).toBe("OK: filesystem_search_files\n\na.md\nb.md");
      expect(out.reply).not.toContain('"a.md');
    } finally {
      idx.close();
    }
    expect(chunks).toEqual(["Running: filesystem_search_files…\n", "\na.md\nb.md\n"]);
  });
});

describe("runAsk — the local_context explain route", () => {
  test("a fallback term that rescued retrieval is recorded on the route", async () => {
    // "smoke test issue" AND-joins to nothing (no item contains `issue`), so the per-term retry
    // runs, longest first; `smoke` ties `issue` at five characters and wins on position.
    const recorder = new AskExplainRecorder();
    const params = makeRunAskParams({
      input: "smoke test issue",
      seedMatchingTitle: "add a smoke test",
      localRouterSucceeds: true,
      explainRecorder: recorder,
    });
    try {
      await runAsk(params);
    } finally {
      params.localIndex.close();
    }
    const last = recorder.last();
    expect(last?.route).toBe("local_context");
    expect(last?.route === "local_context" ? last.fallbackTermFired : undefined).toBe("smoke");
    expect(last?.route === "local_context" ? last.searchTerms : undefined).toBe("smoke test issue");
  });
});

/** A `LocalIndex` stand-in for `buildLocalIndexedContext`, recording what it was asked. */
function stubIndex(opts: {
  readonly primary?: readonly RankedIndexItem[];
  readonly primaryRejects?: Error;
  readonly onSearchRanked?: (name: string | undefined) => void;
  readonly onRepoQuery?: (like: unknown) => void;
}): { index: LocalIndex; primaryCalls: () => number } {
  let primaryCalls = 0;
  const index = {
    searchRankedAsync: (): Promise<SearchRankedResult> => {
      primaryCalls += 1;
      if (opts.primaryRejects !== undefined) return Promise.reject(opts.primaryRejects);
      return Promise.resolve({
        items: [...(opts.primary ?? [])],
        retrieval: { vectorRanked: false, reason: "semantic_off", partial: null, backfill: null },
      });
    },
    searchRanked: (q: { name?: string }): RankedIndexItem[] => {
      opts.onSearchRanked?.(q.name);
      return [];
    },
    getBodyPreview: (): string | undefined => undefined,
    getDatabase: () => ({
      query: () => ({
        all: (like: unknown) => {
          opts.onRepoQuery?.(like);
          return [];
        },
      }),
    }),
  } as unknown as LocalIndex;
  return { index, primaryCalls: () => primaryCalls };
}

/** A primary hit with NO `modifiedAt` and NO `scoringFormula` — an unscored candidate. */
const UNSCORED_HIT: RankedIndexItem = {
  id: "docs:1",
  service: "docs",
  itemType: "note",
  name: "Billing retry notes",
  score: 0,
  indexPrimaryKey: "docs:1",
  indexedType: "note",
};

describe("buildLocalIndexedContext", () => {
  test("whitespace-only input builds nothing and never searches", async () => {
    const { index, primaryCalls } = stubIndex({ primary: [UNSCORED_HIT] });
    expect(await buildLocalIndexedContextForTest(index, "   \t ")).toBeUndefined();
    expect(primaryCalls()).toBe(0);
  });

  test("a question made only of stop words builds nothing and never searches", async () => {
    const { index, primaryCalls } = stubIndex({ primary: [UNSCORED_HIT] });
    expect(await buildLocalIndexedContextForTest(index, "what is it?")).toBeUndefined();
    expect(primaryCalls()).toBe(0);
  });

  test("a search that throws yields no context rather than failing the turn", async () => {
    const { index, primaryCalls } = stubIndex({ primaryRejects: new Error("fts5 corrupt") });
    expect(await buildLocalIndexedContextForTest(index, "billing retry")).toBeUndefined();
    expect(primaryCalls()).toBe(1);
  });

  test("an unscored candidate carries no score fields and no modifiedAt — absent, never 0", async () => {
    const { index } = stubIndex({ primary: [UNSCORED_HIT] });
    const out = await buildLocalIndexedContextForTest(index, "billing retry");
    const c = out?.explain.pool[0];
    expect(c?.sourceId).toBe("docs:1");
    expect(c?.outcome).toBe("shown");
    expect(c !== undefined && Object.hasOwn(c, "score")).toBe(false);
    expect(c !== undefined && Object.hasOwn(c, "scoringFormula")).toBe(false);
    expect(c !== undefined && Object.hasOwn(c, "modifiedAt")).toBe(false);
  });

  test("quoted queries are de-duplicated case-insensitively, blanks skipped, capped at four", async () => {
    const searched: Array<string | undefined> = [];
    const { index } = stubIndex({
      primary: [UNSCORED_HIT],
      onSearchRanked: (name) => searched.push(name),
    });
    await buildLocalIndexedContextForTest(
      index,
      'find "alpha one" "ALPHA ONE" "   " "beta two" "gamma three" "delta four" "epsilon five"',
    );
    expect(searched).toEqual(["alpha one", "beta two", "gamma three", "delta four"]);
  });

  test("a repo slug named twice in different case is queried once", async () => {
    const likes: unknown[] = [];
    const { index } = stubIndex({ primary: [UNSCORED_HIT], onRepoQuery: (l) => likes.push(l) });
    await buildLocalIndexedContextForTest(index, "compare acme/app with ACME/App");
    expect(likes).toEqual(["acme/app#%"]);
  });

  test("the discarded tail is grouped by service + type and ordered largest group first", async () => {
    const hit = (i: number, service: string, type: string): RankedIndexItem => ({
      id: `${service}:${String(i)}`,
      service,
      itemType: type,
      name: `billing retry ${String(i)}`,
      score: 1 - i / 100,
      indexPrimaryKey: `${service}:${String(i)}`,
      indexedType: type,
    });
    // The first eight fill the context; the twelve after them are the probe-slice overflow —
    // three `github/pr` met FIRST, then nine `slack/message`, so insertion order alone would put
    // the smaller group on top.
    const primary = [
      ...Array.from({ length: 8 }, (_, i) => hit(i, i % 2 === 0 ? "slack" : "github", "note")),
      ...Array.from({ length: 3 }, (_, i) => hit(8 + i, "github", "pr")),
      ...Array.from({ length: 9 }, (_, i) => hit(11 + i, "slack", "message")),
    ];
    const { index } = stubIndex({ primary });
    // The split below assumes the default context budget of 8; a developer shell exporting
    // NIMBUS_ASK_CONTEXT_ITEMS (read per call) must not move it.
    const prevBudget = process.env["NIMBUS_ASK_CONTEXT_ITEMS"];
    delete process.env["NIMBUS_ASK_CONTEXT_ITEMS"];
    let out: Awaited<ReturnType<typeof buildLocalIndexedContextForTest>>;
    try {
      out = await buildLocalIndexedContextForTest(index, "billing retry");
    } finally {
      if (prevBudget !== undefined) process.env["NIMBUS_ASK_CONTEXT_ITEMS"] = prevBudget;
    }
    expect(out?.truncation.shown).toBe(8);
    expect(out?.explain.discardedTail).toEqual([
      { service: "slack", type: "message", count: 9 },
      { service: "github", type: "pr", count: 3 },
    ]);
  });
});

describe("runAsk — session history", () => {
  test("recent turns of the request's session are replayed to the agent ahead of the question", async () => {
    const prompts: unknown[] = [];
    const agent = {
      generate: (arg: unknown) => {
        prompts.push(arg);
        return Promise.resolve({ text: "agent reply" });
      },
    } as unknown as Agent;
    const asked: Array<[string, number]> = [];
    const store = {
      getRecentTurns: (sessionId: string, limit: number) => {
        asked.push([sessionId, limit]);
        return Promise.resolve([
          { role: "user", text: "earlier question", sessionId, createdAt: 1 },
          { role: "assistant", text: "earlier answer", sessionId, createdAt: 2 },
        ]);
      },
      append: () => Promise.resolve(),
    } as unknown as SessionMemoryStore;
    const idx = realIndex(1);
    try {
      const out = await agentRequestContext.run({ sessionId: "sess-cov" }, () =>
        runAsk(
          baseParams({
            localIndex: idx,
            input: "hello there",
            conversationalAgent: agent,
            sessionMemoryStore: store,
            classify: () => Promise.resolve({ ...UNKNOWN_CONFIDENT, confidence: 0 }),
          }),
        ),
      );
      expect(out.reply).toBe("agent reply");
    } finally {
      idx.close();
    }
    expect(asked).toEqual([["sess-cov", 12]]);
    expect(prompts).toEqual([
      [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "hello there" },
      ],
    ]);
  });
});
