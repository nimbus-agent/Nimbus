import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { transitionHealth } from "../connectors/health.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type {
  SessionChunk,
  SessionMemoryRecallHit,
  SessionMemoryStore,
} from "../memory/session-memory-store.ts";
import { insertPerson } from "../people/person-store.ts";
import { createNimbusEngineAgent } from "./agent.ts";
import { agentRequestContext } from "./agent-request-context.ts";

/**
 * The agent now REQUIRES a resolved vendor and an egress db: slice 2b removed
 * `getEffectiveAgentModel()`, so a model can no longer be inferred from config or the
 * environment. These fixtures supply both explicitly. `TEST_EGRESS_DB` is an in-memory database
 * with no `egress_ledger` table -- nothing in this file calls doGenerate, so nothing appends, and
 * a schema here would only imply otherwise.
 */
const TEST_VENDOR = { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" };
const TEST_EGRESS_DB = new Database(":memory:");

type ToolExecute = (input: unknown, ctx?: unknown) => Promise<string>;
type ToolMap = Record<string, { execute: ToolExecute }>;
type AgentWithListTools = { listTools: () => Promise<ToolMap> };

interface ParsedEnvelope {
  service: string;
  tool: string;
  payload: unknown;
}

function parseEnvelope(body: string): ParsedEnvelope {
  const m = /^<tool_output service="([^"]+)" tool="([^"]+)">([\s\S]*)<\/tool_output>$/.exec(body);
  if (m === null) {
    throw new Error(`Not a <tool_output> envelope: ${body.slice(0, 120)}`);
  }
  return {
    service: m[1] ?? "",
    tool: m[2] ?? "",
    payload: JSON.parse(m[3] ?? "null"),
  };
}

async function listAgentTools(agent: unknown): Promise<ToolMap> {
  const fn = (agent as AgentWithListTools).listTools;
  if (typeof fn !== "function") {
    throw new TypeError("Agent.listTools() not exposed (Mastra version drift?)");
  }
  return await fn.call(agent);
}

async function getTool(agent: unknown, name: string): Promise<{ execute: ToolExecute }> {
  const tools = await listAgentTools(agent);
  const t = tools[name];
  if (t === undefined) {
    throw new Error(`Tool ${name} not exposed on agent (Mastra version drift?)`);
  }
  return t;
}

function setupIndex(): { db: Database; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  return { db, localIndex };
}

let localIndexHandle: LocalIndex | undefined;

afterEach(() => {
  localIndexHandle?.close();
  localIndexHandle = undefined;
});

function freshIndex(): { db: Database; localIndex: LocalIndex } {
  const ctx = setupIndex();
  localIndexHandle = ctx.localIndex;
  return ctx;
}

interface SearchCall {
  query: { service?: string; itemType?: string; name?: string; limit?: number };
  options: { semantic?: boolean; contextChunks?: number } | undefined;
}

function spyOnSearchRanked(localIndex: LocalIndex): {
  calls: SearchCall[];
  restore: () => void;
} {
  const calls: SearchCall[] = [];
  const orig = localIndex.searchRankedAsync.bind(localIndex);
  (
    localIndex as unknown as {
      searchRankedAsync: (q: unknown, o: unknown) => Promise<unknown>;
    }
  ).searchRankedAsync = async (q: unknown, o: unknown) => {
    calls.push({
      query: q as SearchCall["query"],
      options: o as SearchCall["options"],
    });
    return orig(q as SearchCall["query"], o as SearchCall["options"]);
  };
  return {
    calls,
    restore: () => {
      (localIndex as unknown as { searchRankedAsync: typeof orig }).searchRankedAsync = orig;
    },
  };
}

function seedItem(
  db: Database,
  fields: {
    service: string;
    type?: string;
    externalId: string;
    title: string;
  },
): void {
  const now = Date.now();
  upsertIndexedItem(db, {
    service: fields.service,
    type: fields.type ?? "file",
    externalId: fields.externalId,
    title: fields.title,
    modifiedAt: now,
    syncedAt: now,
  });
}

describe("createNimbusEngineAgent — construction", () => {
  test("constructs Mastra + Agent with read-only tools", () => {
    const { localIndex } = freshIndex();
    const { mastra, agent, agentsByName } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    expect(mastra).toBeDefined();
    expect(agent.id).toBe("nimbus-q1");
    expect(agentsByName.devops.id).toBe("nimbus-devops");
    expect(agentsByName.research.id).toBe("nimbus-research");
  });

  test("BUG-007: every agent's instructions tell the LLM to call the tool, not ask for in-chat confirmation", async () => {
    const { localIndex } = freshIndex();
    const { agentsByName } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    for (const a of [agentsByName.nimbus, agentsByName.devops, agentsByName.research]) {
      const rendered = await a.getInstructions();
      const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
      expect(text).toContain("consent gate");
      expect(text).toContain("call the tool");
      expect(text).not.toMatch(/ask (?:the user )?for confirmation/i);
      expect(text).not.toMatch(/are you sure\?/i);
    }
  });

  test("session memory hint is added when sessionMemoryStore is supplied", async () => {
    const { localIndex } = freshIndex();
    const { agentsByName } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const rendered = await agentsByName.nimbus.getInstructions();
    const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
    expect(text).toContain("recallSessionMemory");
  });
});

describe("toMastraModelId (via agentModel)", () => {
  test("already-prefixed id passes through", () => {
    const { localIndex } = freshIndex();
    expect(() =>
      createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      }),
    ).not.toThrow();
  });

  test("bare Claude id is accepted (prefixed internally)", () => {
    const { localIndex } = freshIndex();
    expect(() =>
      createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "claude-sonnet-4-6",
      }),
    ).not.toThrow();
  });

  test.each([
    ["a bare gpt id", "gpt-4o-mini"],
    ["a bare o3 id", "o3-mini"],
    ["an unknown family (passed through unmodified)", "llama-3"],
  ])("accepts %s", (_label, agentModel) => {
    const { localIndex } = freshIndex();
    expect(() =>
      createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel,
      }),
    ).not.toThrow();
  });
});

describe("searchLocalIndex", () => {
  test("empty input returns a context window when index is empty", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "searchLocalIndex");
    const env = parseEnvelope(await tool.execute({}));
    expect(env.service).toBe("index");
    expect(env.tool).toBe("searchLocalIndex");
    const p = env.payload as {
      totalMatches: number;
      itemsInWindow: number;
      items: unknown[];
      sourceSummary: unknown[];
      note: string;
    };
    expect(p.itemsInWindow).toBe(0);
    expect(Array.isArray(p.items)).toBe(true);
    expect(p.items).toHaveLength(0);
    expect(typeof p.note).toBe("string");
  });

  test("non-object input is coerced to empty query", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "searchLocalIndex");
    const e1 = parseEnvelope(await tool.execute(null));
    expect((e1.payload as { itemsInWindow: number }).itemsInWindow).toBe(0);
    const e2 = parseEnvelope(await tool.execute(42));
    expect((e2.payload as { itemsInWindow: number }).itemsInWindow).toBe(0);
    const e3 = parseEnvelope(await tool.execute([1, 2, 3]));
    expect((e3.payload as { itemsInWindow: number }).itemsInWindow).toBe(0);
  });

  test("name filter trims and clips to MAX_TOOL_STRING_LEN", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      const longName = `${"a".repeat(3000)}    `;
      await tool.execute({ name: longName });
      expect(spy.calls).toHaveLength(1);
      const observed = spy.calls[0]?.query.name ?? "";
      expect(observed).toHaveLength(2000);
      expect(observed.endsWith(" ")).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test("empty-string service is dropped from the query", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      await tool.execute({ service: "   " });
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.query.service).toBeUndefined();
    } finally {
      spy.restore();
    }
  });

  test("limit clamps high (500) and low (1)", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      await tool.execute({ limit: 9999 });
      await tool.execute({ limit: 0 });
      expect(spy.calls[0]?.query.limit).toBe(500);
      expect(spy.calls[1]?.query.limit).toBe(1);
    } finally {
      spy.restore();
    }
  });

  test("semantic:false propagates to searchRankedAsync", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      await tool.execute({ semantic: false });
      expect(spy.calls[0]?.options?.semantic).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test("contextChunks clamps high, low, and defaults when non-number", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      await tool.execute({ contextChunks: 9999 });
      await tool.execute({ contextChunks: -1 });
      await tool.execute({ contextChunks: "two" });
      expect(spy.calls[0]?.options?.contextChunks).toBe(8);
      expect(spy.calls[1]?.options?.contextChunks).toBe(0);
      expect(spy.calls[2]?.options?.contextChunks).toBe(2);
    } finally {
      spy.restore();
    }
  });

  test("itemType filter is trimmed and passed through", async () => {
    const { localIndex } = freshIndex();
    const spy = spyOnSearchRanked(localIndex);
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "searchLocalIndex");
      await tool.execute({ itemType: "  pr  " });
      expect(spy.calls[0]?.query.itemType).toBe("pr");
    } finally {
      spy.restore();
    }
  });

  test("single-service scoped query surfaces connectorHealthCaveat for unhealthy connector", async () => {
    const { db, localIndex } = freshIndex();
    transitionHealth(db, "github", {
      type: "rate_limited",
      retryAfter: new Date(Date.now() + 60_000),
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "searchLocalIndex");
    const env = parseEnvelope(await tool.execute({ service: "github" }));
    const p = env.payload as { connectorHealthCaveat?: string };
    expect(typeof p.connectorHealthCaveat).toBe("string");
    expect(p.connectorHealthCaveat).toContain("github");
    expect(p.connectorHealthCaveat).toContain("rate limited");
  });

  test("multi-service window yields connectorHealthCaveats array", async () => {
    const { db, localIndex } = freshIndex();
    seedItem(db, { service: "github", externalId: "g1", title: "alpha repo" });
    seedItem(db, { service: "slack", externalId: "s1", title: "alpha thread" });
    transitionHealth(db, "github", { type: "unauthenticated" });
    transitionHealth(db, "slack", {
      type: "rate_limited",
      retryAfter: new Date(Date.now() + 30_000),
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "searchLocalIndex");
    const env = parseEnvelope(await tool.execute({ name: "alpha" }));
    const p = env.payload as { connectorHealthCaveats?: string[] };
    expect(Array.isArray(p.connectorHealthCaveats)).toBe(true);
    expect(p.connectorHealthCaveats ?? []).toHaveLength(2);
  });
});

describe("fetchMoreIndexResults", () => {
  test("missing service returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "fetchMoreIndexResults");
    const env = parseEnvelope(await tool.execute({ indexedType: "pr" }));
    const p = env.payload as { error?: string };
    expect(p.error).toContain("service and indexedType");
  });

  test("missing indexedType returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "fetchMoreIndexResults");
    const env = parseEnvelope(await tool.execute({ service: "github" }));
    const p = env.payload as { error?: string };
    expect(p.error).toContain("service and indexedType");
  });

  test("non-object input falls through to error branch (both fields empty)", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "fetchMoreIndexResults");
    const env = parseEnvelope(await tool.execute(null));
    const p = env.payload as { error?: string };
    expect(p.error).toContain("service and indexedType");
  });

  test("offset clamps negative to 0; limit clamps high (100) and low (1)", async () => {
    const { db, localIndex } = freshIndex();
    seedItem(db, { service: "github", type: "pr", externalId: "p1", title: "first" });
    seedItem(db, { service: "github", type: "pr", externalId: "p2", title: "second" });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "fetchMoreIndexResults");
    const env = parseEnvelope(
      await tool.execute({
        service: "github",
        indexedType: "pr",
        offset: -10,
        limit: 9999,
      }),
    );
    const p = env.payload as {
      offset: number;
      limit: number;
      service: string;
      indexedType: string;
      items: unknown[];
    };
    expect(p.offset).toBe(0);
    expect(p.limit).toBe(100);
    expect(p.service).toBe("github");
    expect(p.indexedType).toBe("pr");
    expect(p.items).toHaveLength(2);

    const env2 = parseEnvelope(
      await tool.execute({
        service: "github",
        indexedType: "pr",
        limit: 0,
      }),
    );
    expect((env2.payload as { limit: number }).limit).toBe(1);
  });

  test("unhealthy connector surfaces connectorHealthCaveat", async () => {
    const { db, localIndex } = freshIndex();
    transitionHealth(db, "github", { type: "persistent_error", error: "boom" });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "fetchMoreIndexResults");
    const env = parseEnvelope(await tool.execute({ service: "github", indexedType: "pr" }));
    const p = env.payload as { connectorHealthCaveat?: string };
    expect(typeof p.connectorHealthCaveat).toBe("string");
    expect(p.connectorHealthCaveat).toContain("github");
  });
});

describe("traverseGraph", () => {
  test("missing entityId returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "traverseGraph");
    const env = parseEnvelope(await tool.execute({}));
    const p = env.payload as { error?: string };
    expect(p.error).toContain("entityId");
  });

  test("whitespace-only entityId returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "traverseGraph");
    const env = parseEnvelope(await tool.execute({ entityId: "   " }));
    expect((env.payload as { error?: string }).error).toContain("entityId");
  });

  test("valid call delegates to localIndex.traverseGraph; clamps depth and accepts relationTypes", async () => {
    const { localIndex } = freshIndex();
    const calls: Array<{ ref: string; opts: { depth?: number; relationTypes?: string[] } }> = [];
    const orig = localIndex.traverseGraph.bind(localIndex);
    (
      localIndex as unknown as {
        traverseGraph: (ref: string, opts: unknown) => unknown;
      }
    ).traverseGraph = (ref: string, opts: unknown) => {
      const o = opts as { depth?: number; relationTypes?: string[] };
      calls.push({ ref, opts: o });
      return orig(ref, o);
    };
    try {
      const { agent } = createNimbusEngineAgent({
        localIndex,
        vendor: TEST_VENDOR,
        egressDb: TEST_EGRESS_DB,
        agentModel: "openai/gpt-4o-mini",
      });
      const tool = await getTool(agent, "traverseGraph");
      await tool.execute({
        entityId: "github:foo/bar#1",
        depth: 99,
        relationTypes: ["authored", "linked"],
      });
      await tool.execute({
        entityId: "github:foo/bar#1",
        depth: -1,
        relationTypes: "not-an-array",
      });
      expect(calls[0]?.opts.depth).toBe(8);
      expect(calls[0]?.opts.relationTypes).toEqual(["authored", "linked"]);
      expect(calls[1]?.opts.depth).toBe(0);
      expect(calls[1]?.opts.relationTypes).toBeUndefined();
    } finally {
      (localIndex as unknown as { traverseGraph: typeof orig }).traverseGraph = orig;
    }
  });
});

describe("resolvePerson", () => {
  test("empty query returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "resolvePerson");
    const env = parseEnvelope(await tool.execute({}));
    const p = env.payload as { candidates: unknown[]; error?: string };
    expect(p.candidates).toEqual([]);
    expect(p.error).toContain("non-empty string");
  });

  test("whitespace-only query returns error envelope", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "resolvePerson");
    const env = parseEnvelope(await tool.execute({ query: "   " }));
    expect((env.payload as { error?: string }).error).toContain("non-empty string");
  });

  test("returns matching person candidates", async () => {
    const { db, localIndex } = freshIndex();
    insertPerson(db, {
      id: "person:alice",
      displayName: "Alice Example",
      canonicalEmail: "alice@example.com",
      githubLogin: "alice-gh",
      gitlabLogin: null,
      slackHandle: null,
      linearMemberId: null,
      jiraAccountId: null,
      notionUserId: null,
      bitbucketUuid: null,
      microsoftUserId: null,
      discordUserId: null,
      linked: true,
      metadata: {},
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "resolvePerson");
    const env = parseEnvelope(await tool.execute({ query: "alice" }));
    const p = env.payload as {
      candidates: Array<{ id: string; displayName: string | null; githubLogin: string | null }>;
    };
    expect(p.candidates.length).toBeGreaterThanOrEqual(1);
    const hit = p.candidates.find((c) => c.id === "person:alice");
    expect(hit?.displayName).toBe("Alice Example");
    expect(hit?.githubLogin).toBe("alice-gh");
  });
});

describe("listConnectors", () => {
  test("empty sync_state returns the static fallback (filesystem + catalog)", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "listConnectors");
    const env = parseEnvelope(await tool.execute({}));
    const p = env.payload as { connectors: string[] };
    expect(Array.isArray(p.connectors)).toBe(true);
    expect(p.connectors).toContain("filesystem");
    expect(p.connectors).toContain("github");
  });

  test("rows in sync_state are merged with filesystem; empty connector_id filtered out", async () => {
    const { db, localIndex } = freshIndex();
    localIndex.recordSync("custom-extension", "tok");
    localIndex.recordSync("github", "tok2");
    db.run(
      "INSERT OR IGNORE INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES ('', NULL, NULL)",
    );
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "listConnectors");
    const env = parseEnvelope(await tool.execute({}));
    const p = env.payload as { connectors: string[] };
    expect(p.connectors).toContain("filesystem");
    expect(p.connectors).toContain("custom-extension");
    expect(p.connectors).toContain("github");
    expect(p.connectors).not.toContain("");
  });

  test("query throw triggers static-fallback catch branch", async () => {
    const { db, localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    db.close();
    const tool = await getTool(agent, "listConnectors");
    const env = parseEnvelope(await tool.execute({}));
    const p = env.payload as { connectors: string[] };
    expect(p.connectors).toContain("filesystem");
    expect(p.connectors).toContain("github");
    localIndexHandle = undefined;
  });
});

describe("getAuditLog", () => {
  test("non-object input uses default limit and returns entries", async () => {
    const { db, localIndex } = freshIndex();
    const ts = Date.now();
    appendAuditEntry(db, {
      actionType: "test.simple",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ note: "ok" }),
      timestamp: ts,
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "getAuditLog");
    const env = parseEnvelope(await tool.execute(null));
    const p = env.payload as { entries: unknown[] };
    expect(Array.isArray(p.entries)).toBe(true);
    expect(p.entries).toHaveLength(1);
  });

  test("limit clamps high (1000) and low (1)", async () => {
    const { db, localIndex } = freshIndex();
    const ts = Date.now();
    for (let i = 0; i < 3; i++) {
      appendAuditEntry(db, {
        actionType: "test.row",
        hitlStatus: "not_required",
        actionJson: JSON.stringify({ i }),
        timestamp: ts + i,
      });
    }
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "getAuditLog");
    const envHigh = parseEnvelope(await tool.execute({ limit: 9999 }));
    expect((envHigh.payload as { entries: unknown[] }).entries).toHaveLength(3);
    const envLow = parseEnvelope(await tool.execute({ limit: 0 }));
    expect((envLow.payload as { entries: unknown[] }).entries).toHaveLength(1);
  });

  test("redacts sensitive keys in persisted action_json", async () => {
    const { db, localIndex } = freshIndex();
    appendAuditEntry(db, {
      actionType: "test.creds",
      hitlStatus: "approved",
      actionJson: JSON.stringify({
        token: "secret-VALUE",
        nested: { password: "xyz" },
      }),
      timestamp: Date.now(),
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "getAuditLog");
    const env = parseEnvelope(await tool.execute({ limit: 10 }));
    const p = env.payload as { entries: Array<{ actionJson: string }> };
    const row = p.entries[0];
    expect(row).toBeDefined();
    expect(row?.actionJson).not.toContain("secret-VALUE");
    expect(row?.actionJson).toContain("[REDACTED]");
  });

  test("malformed action_json falls back to redacting the raw string", async () => {
    const { db, localIndex } = freshIndex();
    appendAuditEntry(db, {
      actionType: "test.bad",
      hitlStatus: "not_required",
      actionJson: "not-json-at-all",
      timestamp: Date.now(),
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "getAuditLog");
    const env = parseEnvelope(await tool.execute({ limit: 1 }));
    const p = env.payload as { entries: Array<{ actionJson: string }> };
    expect(p.entries[0]?.actionJson).toContain("not-json-at-all");
  });
});

describe("negation tools are registered through wrapToolForLlm", () => {
  test("findPrsNotTouching output comes back enveloped, not raw", async () => {
    const { localIndex } = setupIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "findPrsNotTouching");
    const raw = await tool.execute({ pathGlob: "tests/**" });
    // The envelope regex itself proves the wrap happened -- a raw (unwrapped) tool result would
    // be a bare JSON object, not `<tool_output service="..." tool="...">...</tool_output>`, and
    // parseEnvelope throws on anything else.
    const env = parseEnvelope(raw);
    expect(env.service).toBe("index");
    expect(env.tool).toBe("findPrsNotTouching");
    const p = env.payload as { refused?: boolean };
    expect(p.refused).toBe(true);
  });

  test("findDeploymentsWithoutIncident output comes back enveloped, not raw", async () => {
    const { localIndex } = setupIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "findDeploymentsWithoutIncident");
    const env = parseEnvelope(await tool.execute({}));
    expect(env.service).toBe("index");
    expect(env.tool).toBe("findDeploymentsWithoutIncident");
    const p = env.payload as { refused?: boolean };
    expect(p.refused).toBe(true);
  });

  test("findPeopleWithoutReviews output comes back enveloped, not raw", async () => {
    const { localIndex } = setupIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "findPeopleWithoutReviews");
    const env = parseEnvelope(await tool.execute({}));
    expect(env.service).toBe("people");
    expect(env.tool).toBe("findPeopleWithoutReviews");
    const p = env.payload as { refused?: boolean };
    expect(p.refused).toBe(true);
  });
});

function fakeMemoryStore(): SessionMemoryStore {
  const chunks: SessionChunk[] = [];
  const store = {
    append: async (entry: SessionChunk): Promise<void> => {
      chunks.push(entry);
    },
    recall: async (sid: string, q: string, k: number): Promise<SessionMemoryRecallHit[]> => {
      const matches = chunks.filter((c) => c.sessionId === sid && c.text.includes(q));
      return matches.slice(0, k).map((c) => ({
        chunkText: c.text,
        role: c.role,
        createdAt: c.createdAt,
        distance: 0,
      }));
    },
  };
  return store as unknown as SessionMemoryStore;
}

describe("session-memory tools", () => {
  test("recall/append tools are not exposed without a store", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    await expect(getTool(agent, "recallSessionMemory")).rejects.toThrow(/not exposed/);
    await expect(getTool(agent, "appendSessionMemory")).rejects.toThrow(/not exposed/);
  });

  test("recallSessionMemory: missing sessionId both in input and context returns error", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const tool = await getTool(agent, "recallSessionMemory");
    const env = parseEnvelope(await tool.execute({ query: "hello" }));
    expect((env.payload as { error?: string }).error).toContain("No sessionId");
  });

  test("recallSessionMemory: empty query returns error", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const tool = await getTool(agent, "recallSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-x" }, async () => {
      const env = parseEnvelope(await tool.execute({ query: "" }));
      expect((env.payload as { error?: string }).error).toContain("non-empty");
    });
  });

  test("recallSessionMemory: returns recalled chunks via AsyncLocalStorage sessionId", async () => {
    const { localIndex } = freshIndex();
    const store = fakeMemoryStore();
    await store.append({
      sessionId: "sess-A",
      text: "hello world",
      role: "user",
      createdAt: Date.now(),
    });
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: store,
    });
    const tool = await getTool(agent, "recallSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-A" }, async () => {
      const env = parseEnvelope(await tool.execute({ query: "hello" }));
      const p = env.payload as { chunks: unknown[] };
      expect(Array.isArray(p.chunks)).toBe(true);
      expect(p.chunks).toHaveLength(1);
    });
  });

  test("recallSessionMemory: topK clamps high (32) and low (1); non-number → 8", async () => {
    const { localIndex } = freshIndex();
    const recalls: Array<{ sid: string; q: string; k: number }> = [];
    const store: SessionMemoryStore = {
      append: async () => undefined,
      recall: async (sid: string, q: string, k: number) => {
        recalls.push({ sid, q, k });
        return [];
      },
    } as unknown as SessionMemoryStore;
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: store,
    });
    const tool = await getTool(agent, "recallSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-X" }, async () => {
      await tool.execute({ query: "x", topK: 9999 });
      await tool.execute({ query: "x", topK: 0 });
      await tool.execute({ query: "x", topK: "many" });
    });
    expect(recalls[0]?.k).toBe(32);
    expect(recalls[1]?.k).toBe(1);
    expect(recalls[2]?.k).toBe(8);
  });

  test("appendSessionMemory: missing text returns error", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const tool = await getTool(agent, "appendSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-Y" }, async () => {
      const env = parseEnvelope(await tool.execute({ role: "user", text: "" }));
      expect((env.payload as { error?: string }).error).toContain("non-empty");
    });
  });

  test("appendSessionMemory: invalid role returns error", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const tool = await getTool(agent, "appendSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-Y" }, async () => {
      const env = parseEnvelope(await tool.execute({ role: "system", text: "hi" }));
      expect((env.payload as { error?: string }).error).toContain("role must be");
    });
  });

  test("appendSessionMemory: missing sessionId returns error", async () => {
    const { localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: fakeMemoryStore(),
    });
    const tool = await getTool(agent, "appendSessionMemory");
    const env = parseEnvelope(await tool.execute({ role: "user", text: "hi" }));
    expect((env.payload as { error?: string }).error).toContain("No sessionId");
  });

  test("appendSessionMemory: happy path returns {ok:true} and records the chunk", async () => {
    const { localIndex } = freshIndex();
    const appended: SessionChunk[] = [];
    const store: SessionMemoryStore = {
      append: async (entry: SessionChunk) => {
        appended.push(entry);
      },
      recall: async () => [],
    } as unknown as SessionMemoryStore;
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: store,
    });
    const tool = await getTool(agent, "appendSessionMemory");
    await agentRequestContext.run({ sessionId: "sess-Z" }, async () => {
      const env = parseEnvelope(await tool.execute({ role: "assistant", text: "  hi  " }));
      expect((env.payload as { ok?: boolean }).ok).toBe(true);
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.sessionId).toBe("sess-Z");
    expect(appended[0]?.text).toBe("hi");
    expect(appended[0]?.role).toBe("assistant");
  });

  test("appendSessionMemory: explicit sessionId in input overrides context", async () => {
    const { localIndex } = freshIndex();
    const appended: SessionChunk[] = [];
    const store: SessionMemoryStore = {
      append: async (entry: SessionChunk) => {
        appended.push(entry);
      },
      recall: async () => [],
    } as unknown as SessionMemoryStore;
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      sessionMemoryStore: store,
    });
    const tool = await getTool(agent, "appendSessionMemory");
    const env = parseEnvelope(
      await tool.execute({ sessionId: "explicit-sess", role: "tool", text: "note" }),
    );
    expect((env.payload as { ok?: boolean }).ok).toBe(true);
    expect(appended[0]?.sessionId).toBe("explicit-sess");
  });
});

describe("wrapToolForLlm (auditDb branches)", () => {
  test("writes a tool_call_log row with status='ok' on success", async () => {
    const { db, localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb: db,
    });
    const tool = await getTool(agent, "listConnectors");
    await agentRequestContext.run({ sessionId: "sess-OK" }, async () => {
      await tool.execute({});
    });
    const rows = db
      .query("SELECT session_id, tool_id, service, status FROM tool_call_log")
      .all() as Array<{
      session_id: string | null;
      tool_id: string;
      service: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session_id: "sess-OK",
      tool_id: "listConnectors",
      service: "connectors",
      status: "ok",
    });
  });

  test("writes a tool_call_log row with status='error' on throw, then re-throws", async () => {
    const { db, localIndex } = freshIndex();
    (
      localIndex as unknown as {
        searchRankedAsync: () => Promise<never>;
      }
    ).searchRankedAsync = async () => {
      throw new Error("boom");
    };
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb: db,
    });
    const tool = await getTool(agent, "searchLocalIndex");
    await expect(tool.execute({})).rejects.toThrow("boom");
    const rows = db.query("SELECT tool_id, status FROM tool_call_log").all() as Array<{
      tool_id: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tool_id: "searchLocalIndex", status: "error" });
  });

  test("session_id is null when no AsyncLocalStorage context is active", async () => {
    const { db, localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb: db,
    });
    const tool = await getTool(agent, "listConnectors");
    await tool.execute({});
    const row = db.query("SELECT session_id FROM tool_call_log").get() as {
      session_id: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.session_id).toBeNull();
  });

  test("no auditDb means no tool_call_log writes", async () => {
    const { db, localIndex } = freshIndex();
    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tool = await getTool(agent, "listConnectors");
    await tool.execute({});
    const row = db.query("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number };
    expect(row.n).toBe(0);
  });
});
