/**
 * I53 amended (OR-S4-PERS): the owner's `[personalization]` hide list and order are applied to the
 * FINAL tool map of a turn, after every offer path, so they can only REMOVE a tool or MOVE one; they
 * never add a tool and never re-offer one an earlier check refused.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";
import { read } from "../../test/helpers/security-invariants.ts";
import { parseNimbusTomlPersonalization } from "../config/personalization-toml.ts";
import { row, textField, withPreview } from "../connectors/connector-writes/types.ts";
import { createNimbusEngineAgent, type NimbusEngineAgentDeps } from "../engine/agent.ts";
import { agentRequestContext } from "../engine/agent-request-context.ts";
import type { ConnectorWriteToolSource } from "../engine/connector-write-agent-tools.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import { resetToolPreferenceWarningsForTest } from "../engine/personalization.ts";
import { LocalIndex } from "../index/local-index.ts";

const VENDOR = { providerId: "openai", modelId: "gpt-4o-mini", apiKey: "sk-test-not-used" };
const EGRESS_DB = new Database(":memory:");
let openIndex: LocalIndex | undefined;
afterEach(() => {
  openIndex?.close();
  openIndex = undefined;
  resetToolPreferenceWarningsForTest();
});
afterAll(() => EGRESS_DB.close());

const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), {
  target: "{name}",
  summary: "Sync {name}",
  fields: [textField("revision", "Revision", "HEAD")],
});
const SCHEMA = toStandardSchema({
  type: "object",
  properties: { name: { type: "string" }, revision: { type: "string" } },
});

function deps(prefsToml: string, warnings: string[] = []): NimbusEngineAgentDeps {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openIndex = new LocalIndex(db);
  const source: ConnectorWriteToolSource = {
    // The never-offered / not-enabled rows are simply absent here, as `offerableEnabledRows` omits them.
    offerableEnabledRows: () => [SYNC],
    listServerTools: async (service) =>
      service === "argocd"
        ? { argocd_argocd_app_sync: { description: "Sync", inputSchema: SCHEMA } }
        : undefined,
    toolsEpoch: () => 1,
    recheck: () => true,
    warn: () => {},
  };
  return {
    localIndex: openIndex,
    vendor: VENDOR,
    egressDb: EGRESS_DB,
    connectorWrites: source,
    personalization: {
      get: () => parseNimbusTomlPersonalization(prefsToml),
      warn: (_n, m) => warnings.push(m),
    },
  };
}

async function offered(d: NimbusEngineAgentDeps): Promise<string[]> {
  const { agent } = createNimbusEngineAgent(d);
  const executor = {
    execute: async () => ({ status: "ok", result: {} }),
  } as unknown as ToolExecutor;
  return await agentRequestContext.run({ connectorWriteExecutor: executor }, async () =>
    Object.keys(
      await (agent as unknown as { listTools: () => Promise<Record<string, unknown>> }).listTools(),
    ),
  );
}

describe("I53 (OR-S4-PERS) — personalization only removes or reorders", () => {
  test("a hidden write row is not offered; everything else is unchanged", async () => {
    const all = await offered(deps(""));
    expect(all).toContain("argocd__argocd_app_sync");
    const hidden = await offered(
      deps('[personalization]\nhide_tools = ["argocd__argocd_app_sync", "oncall_now"]'),
    );
    expect(hidden).not.toContain("argocd__argocd_app_sync");
    expect(hidden).not.toContain("oncall_now");
    expect([...hidden].sort()).toEqual(
      all.filter((n) => n !== "argocd__argocd_app_sync" && n !== "oncall_now").sort(),
    );
  });

  test("a reordered list keeps exactly the same set, with the ordered names first", async () => {
    const all = await offered(deps(""));
    const ordered = await offered(
      deps('[personalization]\ntool_order = ["argocd__argocd_app_sync", "resolvePerson"]'),
    );
    expect(ordered.slice(0, 2)).toEqual(["argocd__argocd_app_sync", "resolvePerson"]);
    expect([...ordered].sort()).toEqual([...all].sort());
  });

  test("a name listed in the order that I53 does not offer stays absent (never added), with a warning", async () => {
    const warnings: string[] = [];
    const all = await offered(deps(""));
    const ordered = await offered(
      deps(
        '[personalization]\ntool_order = ["slack__slack_message_post_dm", "no_such_tool"]',
        warnings,
      ),
    );
    expect(ordered).toEqual(all);
    expect(ordered).not.toContain("slack__slack_message_post_dm");
    expect(warnings.some((w) => w.includes("no_such_tool"))).toBe(true);
  });

  test("hiding wins over ordering for the same name", async () => {
    const out = await offered(
      deps(
        '[personalization]\ntool_order = ["argocd__argocd_app_sync"]\nhide_tools = ["argocd__argocd_app_sync"]',
      ),
    );
    expect(out).not.toContain("argocd__argocd_app_sync");
  });

  test("source pin: the module builds no tool and reads no write table; agent.ts applies it to the final map", async () => {
    const mod = await read("packages/gateway/src/engine/personalization.ts");
    expect(mod).not.toMatch(/createTool|connector-writes\/index|CONNECTOR_WRITE_ROWS/);
    const agent = await read("packages/gateway/src/engine/agent.ts");
    expect(agent).toMatch(/applyToolPreferences\(await assembleTools\(\)/);
    // `tools: toolsFor` is the only thing the Agents are given.
    expect(agent.match(/tools: toolsFor,/g)?.length).toBe(3);
    expect(agent).not.toMatch(/tools: assembleTools/);
  });
});
