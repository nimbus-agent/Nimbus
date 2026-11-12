/**
 * The agent's tools on a point-in-time turn (`nimbus ask --at`, Phase 10 IC1): exactly the time-aware
 * tools are offered, whatever else is wired, and the index tools read the instant from the request store.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { row, textField, withPreview } from "../connectors/connector-writes/types.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { createNimbusEngineAgent, type NimbusEngineAgentDeps } from "./agent.ts";
import { agentRequestContext, drainPointInTimeFacts } from "./agent-request-context.ts";
import type { ConnectorWriteToolSource } from "./connector-write-agent-tools.ts";
import type { ToolExecutor } from "./executor.ts";
import { POINT_IN_TIME_TOOL_IDS, POINT_IN_TIME_WITHHELD_TOOL_IDS } from "./point-in-time.ts";
import type { UserMcpAgentToolSource } from "./user-mcp-agent-tools.ts";

const TEST_VENDOR = { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" };
const TEST_EGRESS_DB = new Database(":memory:");

type ToolExecute = (input: unknown, ctx?: unknown) => Promise<string>;
type ToolMap = Record<string, { execute: ToolExecute }>;

let openIndex: LocalIndex | undefined;
afterEach(() => {
  openIndex?.close();
  openIndex = undefined;
});
afterAll(() => {
  TEST_EGRESS_DB.close();
});

const BASE = Date.UTC(2026, 0, 1);
const AT = BASE + 1000;

function seededDeps(extra: Partial<NimbusEngineAgentDeps> = {}): NimbusEngineAgentDeps {
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
  const localIndex = new LocalIndex(db);
  openIndex = localIndex;
  return { localIndex, vendor: TEST_VENDOR, egressDb: TEST_EGRESS_DB, ...extra };
}

async function listTools(agent: unknown): Promise<ToolMap> {
  return await (agent as { listTools: () => Promise<ToolMap> }).listTools();
}

function payloadOf(body: string): Record<string, unknown> {
  const m = /^<tool_output [^>]*>([\s\S]*)<\/tool_output>$/.exec(body);
  if (m === null) throw new Error(`not an envelope: ${body.slice(0, 80)}`);
  return JSON.parse(m[1] ?? "null") as Record<string, unknown>;
}

const sessionStore = {
  append: async () => {},
  search: async () => [],
} as unknown as SessionMemoryStore;

describe("toolsFor on a point-in-time turn", () => {
  test("census: every base tool is either offered or withheld, by a recorded decision", async () => {
    const { agent } = createNimbusEngineAgent(seededDeps({ sessionMemoryStore: sessionStore }));
    const all = Object.keys(await listTools(agent));
    const decided = [...POINT_IN_TIME_TOOL_IDS, ...POINT_IN_TIME_WITHHELD_TOOL_IDS];
    expect(new Set(decided).size).toBe(decided.length);
    for (const name of all) {
      expect(decided, `new base tool "${name}" needs a point-in-time decision`).toContain(name);
    }
    for (const name of decided) expect(all).toContain(name);
  });

  test("exactly the three time-aware tools are offered, even with every other source present", async () => {
    const listing: LazyMeshToolMap = { mcp_x_echo: { execute: async () => "RAN" } };
    const userMcp: UserMcpAgentToolSource = {
      listModelAccessibleIds: () => ["mcp_x"],
      listTools: async () => listing,
      warn: () => {},
    };
    const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), {
      target: "{name}",
      summary: "Sync {name}",
      fields: [textField("revision", "Revision", "HEAD")],
    });
    const schema = toStandardSchema({
      type: "object",
      properties: { name: { type: "string" }, revision: { type: "string" } },
    });
    const door: ConnectorWriteToolSource = {
      offerableEnabledRows: () => [SYNC],
      listServerTools: async () => ({
        argocd_argocd_app_sync: { description: "Sync", inputSchema: schema },
      }),
      toolsEpoch: () => 1,
      recheck: () => true,
      warn: () => {},
    };
    const executor = {
      execute: async () => ({ status: "ok", result: {} }),
    } as unknown as ToolExecutor;
    const { agent } = createNimbusEngineAgent(
      seededDeps({ sessionMemoryStore: sessionStore, userMcp, connectorWrites: door }),
    );
    const withoutAt = await agentRequestContext.run(
      { userMcpExecutor: executor, connectorWriteExecutor: executor },
      () => listTools(agent),
    );
    expect(Object.keys(withoutAt)).toContain("argocd__argocd_app_sync");
    expect(Object.keys(withoutAt)).toContain("mcp_x__echo");
    const withAt = await agentRequestContext.run(
      { pointInTimeMs: AT, userMcpExecutor: executor, connectorWriteExecutor: executor },
      () => listTools(agent),
    );
    expect(Object.keys(withAt).sort()).toEqual([...POINT_IN_TIME_TOOL_IDS].sort());
  });
});

describe("the index tools on a point-in-time turn", () => {
  test("searchLocalIndex reads the instant from the store, shows asOf, and records the facts", async () => {
    const { agent } = createNimbusEngineAgent(seededDeps());
    await agentRequestContext.run({ pointInTimeMs: AT }, async () => {
      const tools = await listTools(agent);
      const body = await tools["searchLocalIndex"]?.execute({
        name: "payment-service",
        semantic: false,
        // The model cannot lift the instant by naming one.
        atMs: BASE + 5000,
        at: "now",
      });
      const payload = payloadOf(body ?? "");
      const items = payload["items"] as Array<{ name: string; asOf?: { atMs: number } }>;
      expect(items.map((i) => i.name)).toEqual(["payment-service retry fix"]);
      expect(items[0]?.asOf?.atMs).toBe(AT);
      expect(payload["connectorHealthCaveats"]).toBeUndefined();
      expect(drainPointInTimeFacts()).toEqual([{ atMs: AT, historyStartMs: BASE, gapCount: 0 }]);
    });
  });

  test("without an instant, searchLocalIndex is unchanged and records nothing", async () => {
    const { agent } = createNimbusEngineAgent(seededDeps());
    await agentRequestContext.run({}, async () => {
      const tools = await listTools(agent);
      const payload = payloadOf(
        (await tools["searchLocalIndex"]?.execute({ name: "payment-service", semantic: false })) ??
          "",
      );
      const items = payload["items"] as Array<{ name: string; asOf?: unknown }>;
      expect(items.map((i) => i.name).sort()).toEqual([
        "payment-service retry fix",
        "payment-service rewrite",
      ]);
      expect(items.every((i) => i.asOf === undefined)).toBe(true);
      expect(drainPointInTimeFacts()).toEqual([]);
    });
  });

  test("fetchMoreIndexResults pages only items that existed at the instant", async () => {
    const { agent } = createNimbusEngineAgent(seededDeps());
    await agentRequestContext.run({ pointInTimeMs: AT }, async () => {
      const tools = await listTools(agent);
      const payload = payloadOf(
        (await tools["fetchMoreIndexResults"]?.execute({ service: "github", indexedType: "pr" })) ??
          "",
      );
      const items = payload["items"] as Array<{ name: string; asOf?: unknown }>;
      expect(items.map((i) => i.name)).toEqual(["payment-service retry fix", "unrelated"]);
      expect(items.every((i) => i.asOf !== undefined)).toBe(true);
      expect(payload["connectorHealthCaveat"]).toBeUndefined();
    });
  });
});
