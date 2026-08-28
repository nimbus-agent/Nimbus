import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { createNimbusEngineAgent } from "./agent.ts";

/**
 * The agent now REQUIRES a resolved vendor and an egress db: slice 2b removed
 * `getEffectiveAgentModel()`, so a model can no longer be inferred from config or the
 * environment. These fixtures supply both explicitly. `TEST_EGRESS_DB` is an in-memory database
 * with no `egress_ledger` table -- nothing in this file calls doGenerate, so nothing appends, and
 * a schema here would only imply otherwise.
 */
const TEST_VENDOR = { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" };
const TEST_EGRESS_DB = new Database(":memory:");

describe("getAuditLog redaction (S1-F6)", () => {
  test("re-redacts persisted action_json before exposing to the LLM", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const localIndex = new LocalIndex(db);
    db.run(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES (?, ?, ?, ?)",
      [
        "slack.message.post",
        "approved",
        JSON.stringify({
          action: {
            type: "slack.message.post",
            payload: { input: { Authorization: "Bearer LEAK_VALUE_DO_NOT_DISCLOSE" } },
          },
        }),
        Date.now(),
      ],
    );

    const { agent } = createNimbusEngineAgent({
      localIndex,
      vendor: TEST_VENDOR,
      egressDb: TEST_EGRESS_DB,
      agentModel: "openai/gpt-4o-mini",
    });
    const tools = (await agent.listTools()) as Record<
      string,
      { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }
    >;
    const getAuditLog = tools["getAuditLog"];
    expect(getAuditLog?.execute).toBeDefined();
    const result = await getAuditLog!.execute!({ limit: 5 }, {});
    const json = JSON.stringify(result);
    expect(json.includes("LEAK_VALUE_DO_NOT_DISCLOSE")).toBe(false);
    expect(json.includes("[REDACTED]")).toBe(true);
    localIndex.close();
  });
});
