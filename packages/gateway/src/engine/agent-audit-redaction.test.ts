import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { createNimbusEngineAgent } from "./agent.ts";

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

    const { agent } = createNimbusEngineAgent({ localIndex, agentModel: "openai/gpt-4o-mini" });
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
