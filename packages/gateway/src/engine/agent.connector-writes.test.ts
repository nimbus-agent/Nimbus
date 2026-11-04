/**
 * The connector-write door's spread in `toolsFor` (Phase 9.7): door tools are listed only when the
 * turn's request context carries the connector-write executor, every result goes through
 * `wrapToolForLlm` (I11), and a door name already taken this turn (base, toolgen, user-MCP) is
 * skipped, never replacing the tool already offered.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { row, textField, withPreview } from "../connectors/connector-writes/types.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createNimbusEngineAgent, type NimbusEngineAgentDeps } from "./agent.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import type { ConnectorWriteToolSource } from "./connector-write-agent-tools.ts";
import type { ToolExecutor } from "./executor.ts";
import type { ActionResult, PlannedAction } from "./types.ts";
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

function baseDeps(): NimbusEngineAgentDeps {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  openIndex = localIndex;
  return { localIndex, vendor: TEST_VENDOR, egressDb: TEST_EGRESS_DB };
}

async function listTools(agent: unknown): Promise<ToolMap> {
  return await (agent as { listTools: () => Promise<ToolMap> }).listTools();
}

const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), {
  target: "{name}",
  summary: "Sync {name}",
  fields: [textField("revision", "Revision", "HEAD")],
});
/** Its door name would be `mcp_x__echo`, the user-MCP tool's name: it must be skipped. */
const COLLIDES = withPreview(row("echo", "mcp_x.echo", "write", 2), {
  target: "{name}",
  summary: "Echo {name}",
  fields: [],
});
const SCHEMA = toStandardSchema({
  type: "object",
  properties: { name: { type: "string" }, revision: { type: "string" } },
});

function doorSource(): {
  source: ConnectorWriteToolSource;
  listCalls: string[];
  warnings: string[];
} {
  const listCalls: string[] = [];
  const warnings: string[] = [];
  const source: ConnectorWriteToolSource = {
    offerableEnabledRows: () => [SYNC, COLLIDES],
    listServerTools: async (service) => {
      listCalls.push(service);
      if (service === "argocd") {
        return { argocd_argocd_app_sync: { description: "Sync", inputSchema: SCHEMA } };
      }
      if (service === "mcp_x") return { mcp_x_echo: { description: "x", inputSchema: SCHEMA } };
      return undefined;
    },
    toolsEpoch: () => 1,
    recheck: () => true,
    warn: (_b, msg) => {
      warnings.push(msg);
    },
  };
  return { source, listCalls, warnings };
}

function userMcpSource(): UserMcpAgentToolSource {
  const listing: LazyMeshToolMap = { mcp_x_echo: { execute: async () => "SERVER RAN DIRECTLY" } };
  return {
    listModelAccessibleIds: () => ["mcp_x"],
    listTools: async (id) => (id === "mcp_x" ? listing : undefined),
    warn: () => {},
  };
}

function fakeExecutor(): { executor: ToolExecutor; actions: PlannedAction[] } {
  const actions: PlannedAction[] = [];
  const executor = {
    execute: async (action: PlannedAction): Promise<ActionResult> => {
      actions.push(action);
      return { status: "ok", result: { synced: true } };
    },
  } as unknown as ToolExecutor;
  return { executor, actions };
}

describe("toolsFor: the connector-write door spread", () => {
  test("with the door executor in context, the door tool is offered and its result is enveloped", async () => {
    const door = doorSource();
    const { executor, actions } = fakeExecutor();
    const { agent } = createNimbusEngineAgent({ ...baseDeps(), connectorWrites: door.source });
    await agentRequestContext.run({ connectorWriteExecutor: executor }, async () => {
      const tools = await listTools(agent);
      expect(Object.keys(tools)).toContain("argocd__argocd_app_sync");
      const body = await tools["argocd__argocd_app_sync"]?.execute({ name: "web" });
      expect(body).toBe(
        '<tool_output service="argocd" tool="argocd__argocd_app_sync">{"synced":true}</tool_output>',
      );
    });
    expect(actions).toEqual([
      {
        type: "argocd.app.sync",
        origin: "model",
        payload: { mcpToolId: "argocd_argocd_app_sync", input: { name: "web" } },
      },
    ]);
  });

  test("no door executor (outside a turn, a non-owner turn, or a user-MCP-only turn): nothing listed, nothing spawned", async () => {
    const door = doorSource();
    const { executor } = fakeExecutor();
    const { agent } = createNimbusEngineAgent({ ...baseDeps(), connectorWrites: door.source });
    expect(Object.keys(await listTools(agent))).not.toContain("argocd__argocd_app_sync");
    await agentRequestContext.run({ sessionId: "s" }, async () => {
      expect(Object.keys(await listTools(agent))).not.toContain("argocd__argocd_app_sync");
    });
    await agentRequestContext.run({ userMcpExecutor: executor }, async () => {
      expect(Object.keys(await listTools(agent))).not.toContain("argocd__argocd_app_sync");
    });
    expect(door.listCalls).toEqual([]);
  });

  test("a door name already offered this turn (a user-MCP tool) is skipped; both doors' other tools stay", async () => {
    const door = doorSource();
    const { executor, actions } = fakeExecutor();
    const { agent } = createNimbusEngineAgent({
      ...baseDeps(),
      userMcp: userMcpSource(),
      connectorWrites: door.source,
    });
    await agentRequestContext.run(
      { userMcpExecutor: executor, connectorWriteExecutor: executor },
      async () => {
        const tools = await listTools(agent);
        expect(Object.keys(tools)).toContain("argocd__argocd_app_sync");
        expect(Object.keys(tools)).toContain("mcp_x__echo");
        // The kept `mcp_x__echo` is the USER-MCP tool: its action has no `origin`.
        await tools["mcp_x__echo"]?.execute({ name: "a" });
      },
    );
    expect(actions[0]?.origin).toBeUndefined();
    expect(actions[0]?.payload).toEqual({
      mcpToolId: "mcp_x_echo",
      input: { name: "a" },
      requestedBy: "model",
    });
    expect(door.warnings).toEqual([
      "connector write tool name collides with one already offered; not offered",
    ]);
  });

  test("the built-in tools are unchanged by the door spread", async () => {
    const without = createNimbusEngineAgent(baseDeps()).agent;
    const plain = Object.keys(await listTools(without)).sort((a, b) => a.localeCompare(b));
    const door = doorSource();
    const { executor } = fakeExecutor();
    const { agent } = createNimbusEngineAgent({ ...baseDeps(), connectorWrites: door.source });
    await agentRequestContext.run({ connectorWriteExecutor: executor }, async () => {
      const keys = Object.keys(await listTools(agent)).sort((a, b) => a.localeCompare(b));
      expect(keys.filter((k) => !k.includes("__"))).toEqual(plain);
      expect(keys.filter((k) => k.includes("__"))).toEqual([
        "argocd__argocd_app_sync",
        "mcp_x__echo",
      ]);
    });
  });
});
