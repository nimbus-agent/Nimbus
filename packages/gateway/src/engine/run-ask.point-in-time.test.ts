import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import {
  type AgentRequestContext,
  agentRequestContext,
  recordPointInTimeFacts,
} from "./agent-request-context.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { buildLocalIndexedContextForTest, runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher } from "./types.ts";

const base = join(tmpdir(), "nimbus-run-ask-pit-test");
const paths: PlatformPaths = {
  configDir: join(base, "cfg"),
  dataDir: join(base, "data"),
  logDir: join(base, "logs"),
  socketPath: join(base, "gateway.sock"),
  extensionsDir: join(base, "ext"),
  tempDir: join(base, "tmp"),
  sandboxDir: join(base, "sandbox"),
};

const consent: ConsentCoordinator = {
  async requestConsent() {
    return { approved: false, answerSource: "human" as const };
  },
  requestConfirmedConsent: async () => ({
    approved: false,
    typed: "",
    answerSource: "human" as const,
  }),
  rejectAllPending(): void {},
  pendingCount: () => 0,
};

// Instants far in the past of the real clock.
const BASE = Date.UTC(2026, 0, 1);
const AT = BASE + 1000;

function seed(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const put = (ext: string, title: string, opened: number, at: number): void =>
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: ext,
      title,
      modifiedAt: at,
      syncedAt: at,
      metadata: { state: "open", opened_at_ms: opened },
    });
  put("seed", "unrelated", BASE - 10, BASE);
  put("old", "payment-service retry fix", BASE + 100, BASE + 200);
  put("late", "payment-service rewrite", BASE + 1200, BASE + 1300);
  return new LocalIndex(db);
}

function fakeRouter(prompts: string[]): LlmRouter {
  return {
    prefersLocal: () => true,
    enforcesAirGap: () => false,
    generate: async (opts: { prompt: string }) => {
      prompts.push(opts.prompt);
      return {
        text: "local reply",
        tokensIn: 1,
        tokensOut: 2,
        modelUsed: "local-test-model:latest",
        isLocal: true,
        provider: "ollama" as const,
      };
    },
  } as unknown as LlmRouter;
}

function params(localIndex: LocalIndex, over: Record<string, unknown> = {}) {
  return {
    input: "payment-service",
    stream: false,
    clientId: "test-client",
    paths,
    consentCoordinator: consent,
    localIndex,
    dispatcher: { dispatch: async () => null } as ConnectorDispatcher,
    egressSink: NULL_EGRESS_SINK,
    getTribalKbConfig: () => undefined,
    sendChunk: () => {},
    ...over,
  };
}

describe("buildLocalIndexedContext with a point in time", () => {
  test("every item is as of T, carries asOf, and the facts ride along", async () => {
    const idx = seed();
    const ctx = await buildLocalIndexedContextForTest(idx, "payment-service", AT);
    expect(ctx?.text).toContain("payment-service retry fix");
    expect(ctx?.text).not.toContain("payment-service rewrite");
    expect(ctx?.text).toContain('"asOf"');
    expect(ctx?.pointInTime?.atMs).toBe(AT);
    expect(ctx?.pointInTime?.historyStartMs).toBe(BASE);
    const now = await buildLocalIndexedContextForTest(idx, "payment-service");
    expect(now?.text).toContain("payment-service rewrite");
    expect(now?.text).not.toContain('"asOf"');
    expect(now?.pointInTime).toBeUndefined();
    idx.close();
  });

  test("the quoted and fallback searches carry the instant too", async () => {
    const idx = seed();
    const quoted = await buildLocalIndexedContextForTest(
      idx,
      'find "payment-service rewrite" please',
      AT,
    );
    expect(quoted?.text ?? "").not.toContain("payment-service rewrite");
    idx.close();
  });

  test("the repo-slug pass (a raw read of the CURRENT list) does not run", async () => {
    const idx = seed();
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('github:acme/payment-service#issue-5', 'github', 'issue', 'acme/payment-service#issue-5', 'zzqq unrelated', ?, 1, '{}')`,
      [BASE + 10],
    );
    const now = await buildLocalIndexedContextForTest(idx, "what is up in acme/payment-service");
    expect(now?.text ?? "").toContain("zzqq unrelated");
    const then = await buildLocalIndexedContextForTest(
      idx,
      "what is up in acme/payment-service",
      AT,
    );
    expect(then?.text ?? "").not.toContain("zzqq unrelated");
    idx.close();
  });
});

describe("runAsk with pointInTimeMs", () => {
  test("the classifier is not called and plan dispatch is never reached, even for an action intent", async () => {
    const idx = seed();
    let classifierCalls = 0;
    let dispatches = 0;
    const prompts: string[] = [];
    const out = await runAsk(
      params(idx, {
        input: "deploy the payment-service now",
        llmRouter: fakeRouter(prompts),
        pointInTimeMs: AT,
        dispatcher: {
          dispatch: async () => {
            dispatches += 1;
            return null;
          },
        },
        classify: async () => {
          classifierCalls += 1;
          return {
            intent: "file_search",
            entities: { pattern: "*.ts" },
            requiresHITL: false,
            confidence: 0.99,
          };
        },
      }),
    );
    expect(classifierCalls).toBe(0);
    expect(dispatches).toBe(0);
    expect(out.asOfMs).toBe(AT);
    idx.close();
  });

  test("the router answer is followed by the deterministic as-of block; the model is told the instant", async () => {
    const idx = seed();
    const prompts: string[] = [];
    const chunks: string[] = [];
    const out = await runAsk(
      params(idx, {
        llmRouter: fakeRouter(prompts),
        pointInTimeMs: AT,
        stream: true,
        sendChunk: (t: string) => chunks.push(t),
      }),
    );
    expect(out.reply.startsWith("local reply")).toBe(true);
    expect(out.reply).toContain("As of 2026-01-01T00:00:01.000Z");
    expect(out.reply).toContain("## Gaps");
    expect(out.reply).toContain("could not be placed");
    // Streaming clients get the block as a final chunk.
    expect(chunks.join("")).toContain("As of 2026-01-01T00:00:01.000Z");
    // The model is told the instant and never asked for the disclosure.
    expect(prompts[0]).toContain("2026-01-01T00:00:01.000Z");
    expect(prompts[0]).not.toContain("## Gaps");
    expect(prompts[0]).not.toContain("could not be placed");
    idx.close();
  });

  test("the block is identical whatever the model said, and absent without pointInTimeMs", async () => {
    const idx = seed();
    const withAt = await runAsk(params(idx, { llmRouter: fakeRouter([]), pointInTimeMs: AT }));
    const without = await runAsk(params(idx, { llmRouter: fakeRouter([]) }));
    expect(without.reply).not.toContain("As of ");
    expect(without.asOfMs).toBeUndefined();
    expect(withAt.reply.slice(withAt.reply.indexOf("\n\nAs of "))).toContain("## Gaps");
    idx.close();
  });

  test("the history-start line appears when history begins after T, and the count line is omitted", async () => {
    const idx = seed();
    const early = BASE - 60_000;
    const out = await runAsk(
      params(idx, {
        input: "how many payment-service PRs are there",
        llmRouter: fakeRouter([]),
        pointInTimeMs: early,
      }),
    );
    expect(out.reply).toContain("History starts 2026-01-01T00:00:00.000Z");
    expect(out.reply).not.toContain("Counted from the index");
    const current = await runAsk(
      params(idx, {
        input: "how many payment-service PRs are there",
        llmRouter: fakeRouter([]),
      }),
    );
    expect(current.reply).toContain("Counted from the index");
    idx.close();
  });

  test("with no agent and no router it throws the existing no-LLM error", async () => {
    const idx = seed();
    await expect(runAsk(params(idx, { pointInTimeMs: AT }))).rejects.toBeInstanceOf(
      GatewayAgentUnavailableError,
    );
    idx.close();
  });

  test("a time-travel turn withdraws the owner executors from a reused store and marks the instant", async () => {
    const idx = seed();
    const store: AgentRequestContext = {
      userMcpExecutor: {} as never,
      connectorWriteExecutor: {} as never,
    };
    await agentRequestContext.run(store, async () => {
      await runAsk(
        params(idx, {
          llmRouter: fakeRouter([]),
          pointInTimeMs: AT,
          offerUserMcpTools: true,
          offerConnectorWriteTools: true,
        }),
      );
    });
    expect(store.userMcpExecutor).toBeUndefined();
    expect(store.connectorWriteExecutor).toBeUndefined();
    expect(store.pointInTimeMs).toBe(AT);
    // The next, ordinary turn on the same store clears the mark.
    await agentRequestContext.run(store, async () => {
      await runAsk(params(idx, { llmRouter: fakeRouter([]) }));
    });
    expect(store.pointInTimeMs).toBeUndefined();
    idx.close();
  });
});

describe("runAsk with pointInTimeMs - the agent path", () => {
  function recordingAgent(reply: string, gapCount: number): Agent {
    return {
      generate: async () => {
        // What the agent's searchLocalIndex tool does on a point-in-time turn.
        recordPointInTimeFacts({ atMs: AT, historyStartMs: BASE, gapCount });
        return { text: reply };
      },
      stream: async () => {
        throw new Error("not streaming in this test");
      },
    } as unknown as Agent;
  }

  test("the block is built from the facts the tools recorded and matches the router path's wording", async () => {
    const idx = seed();
    const out = await agentRequestContext.run({}, () =>
      runAsk(
        params(idx, { conversationalAgent: recordingAgent("agent reply", 3), pointInTimeMs: AT }),
      ),
    );
    expect(out.reply.startsWith("agent reply")).toBe(true);
    expect(out.reply).toContain("As of 2026-01-01T00:00:01.000Z");
    expect(out.reply).toContain("3 items could not be placed at that time");
    expect(out.asOfMs).toBe(AT);
    const router = await runAsk(params(idx, { llmRouter: fakeRouter([]), pointInTimeMs: AT }));
    const firstLine = (reply: string): string => {
      const rest = reply.slice(reply.indexOf("As of "));
      return rest.slice(0, rest.indexOf(" (")); // "As of <ISO instant>"
    };
    expect(firstLine(out.reply)).toBe(firstLine(router.reply));
    idx.close();
  });

  test("facts recorded by a turn that threw are drained, not carried into the next turn", async () => {
    const idx = seed();
    const store: AgentRequestContext = {};
    const throwing = {
      generate: async () => {
        recordPointInTimeFacts({ atMs: AT, historyStartMs: BASE, gapCount: 9 });
        throw new Error("model down");
      },
      stream: async () => {
        throw new Error("model down");
      },
    } as unknown as Agent;
    await agentRequestContext.run(store, async () => {
      await expect(
        runAsk(params(idx, { conversationalAgent: throwing, pointInTimeMs: AT })),
      ).rejects.toThrow();
      const next = await runAsk(
        params(idx, { conversationalAgent: recordingAgent("ok", 0), pointInTimeMs: AT }),
      );
      expect(next.reply).toContain("0 items could not be placed");
    });
    idx.close();
  });
});
