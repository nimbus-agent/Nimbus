import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readToolCallLog } from "../../../src/db/tool-call-log.ts";
import { createNimbusEngineAgent } from "../../../src/engine/agent.ts";
import { agentRequestContext } from "../../../src/engine/agent-request-context.ts";
import type { LocalIndex } from "../../../src/index/local-index.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../../../src/index/tool-call-log-v29-sql.ts";
import { TOOL_CALL_PARAMS_V42_SQL } from "../../../src/index/tool-call-params-v42-sql.ts";

/**
 * The agent REQUIRES a resolved vendor and an egress db as of slice 2b: `getEffectiveAgentModel()`
 * is gone, so a model can no longer be inferred from config or the environment. Nothing here
 * calls doGenerate, so `TEST_EGRESS_DB` needs no `egress_ledger` table -- adding one would imply
 * an append that never happens.
 */
const TEST_VENDOR = { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" };
const TEST_EGRESS_DB = new Database(":memory:");

function freshAuditDb(): Database {
  const db = new Database(":memory:");
  db.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
  db.exec(TOOL_CALL_PARAMS_V42_SQL);
  return db;
}

function stubLocalIndex(): LocalIndex {
  return {
    searchRankedAsync: async () => [],
    fetchMoreItems: () => [],
    traverseGraph: () => ({ entities: [], relations: [] }),
    getDatabase: () => new Database(":memory:"),
  } as unknown as LocalIndex;
}

describe("agent.ts wrapToolForLlm — tool_call_log audit-write", () => {
  test("writes a tool_call_log row when the wrapped tool resolves", async () => {
    const auditDb = freshAuditDb();
    const { agent } = createNimbusEngineAgent({
      localIndex: stubLocalIndex(),
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb,
    });
    const tools = (await agent.listTools()) as Record<
      string,
      { execute?: (input: unknown, ctx?: unknown) => Promise<string> }
    >;
    const searchExecute = tools["searchLocalIndex"]?.execute;
    expect(searchExecute).toBeDefined();
    if (searchExecute === undefined) throw new Error("unreachable");

    await agentRequestContext.run({ sessionId: "s-test-1" }, async () => {
      const out = await searchExecute({ name: "x", limit: 1 });
      expect(typeof out).toBe("string");
      expect(out).toContain("<tool_output");
    });

    const result = readToolCallLog(auditDb, {});
    expect(result.toolCalls).toHaveLength(1);
    const row = result.toolCalls[0];
    if (row === undefined) throw new Error("unreachable");
    expect(row.sessionId).toBe("s-test-1");
    expect(row.toolId).toBe("searchLocalIndex");
    expect(row.status).toBe("ok");
    expect(row.resultEnvelope).toContain("<tool_output");
  });

  test("writes a status='error' row when the wrapped tool throws (and re-throws)", async () => {
    const auditDb = freshAuditDb();
    const throwingIndex = {
      ...stubLocalIndex(),
      searchRankedAsync: () => {
        throw new Error("simulated tool failure");
      },
    } as unknown as LocalIndex;
    const { agent } = createNimbusEngineAgent({
      localIndex: throwingIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb,
    });
    const tools = (await agent.listTools()) as Record<
      string,
      { execute?: (input: unknown, ctx?: unknown) => Promise<string> }
    >;
    const searchExecute = tools["searchLocalIndex"]?.execute;
    if (searchExecute === undefined) throw new Error("unreachable");

    await agentRequestContext.run({ sessionId: "s-test-err" }, async () => {
      await expect(searchExecute({ name: "x", limit: 1 })).rejects.toThrow(
        "simulated tool failure",
      );
    });

    const result = readToolCallLog(auditDb, {});
    expect(result.toolCalls).toHaveLength(1);
    const row = result.toolCalls[0];
    if (row === undefined) throw new Error("unreachable");
    expect(row.status).toBe("error");
    expect(row.sessionId).toBe("s-test-err");
    expect(row.resultEnvelope).toContain("simulated tool failure");
  });

  test("writes sessionId=null when no agentRequestContext.run is in scope", async () => {
    const auditDb = freshAuditDb();
    const { agent } = createNimbusEngineAgent({
      localIndex: stubLocalIndex(),
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
      auditDb,
    });
    const tools = (await agent.listTools()) as Record<
      string,
      { execute?: (input: unknown, ctx?: unknown) => Promise<string> }
    >;
    const searchExecute = tools["searchLocalIndex"]?.execute;
    if (searchExecute === undefined) throw new Error("unreachable");
    await searchExecute({ name: "x", limit: 1 });

    const result = readToolCallLog(auditDb, {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.sessionId).toBeNull();
  });

  test("does not break the LLM-facing path when auditDb is undefined", async () => {
    const { agent } = createNimbusEngineAgent({
      localIndex: stubLocalIndex(),
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tools = (await agent.listTools()) as Record<
      string,
      { execute?: (input: unknown, ctx?: unknown) => Promise<string> }
    >;
    const searchExecute = tools["searchLocalIndex"]?.execute;
    if (searchExecute === undefined) throw new Error("unreachable");
    const out = await searchExecute({ name: "x", limit: 1 });
    expect(typeof out).toBe("string");
    expect(out).toContain("<tool_output");
    // No assertion on the audit table because there's none.
  });
});
