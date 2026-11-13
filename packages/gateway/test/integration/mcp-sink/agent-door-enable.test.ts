/**
 * Agent door AD3a-1 (the owner's approval list for outside agents), end to end through the REAL
 * dispatch entries (`tryDispatchConnectorRpc` for `connector.writes*`, `tryDispatchPhase4Rpc` for
 * `capture.submit`) over a migrated SQLite, a REAL `ConsentCoordinatorImpl` whose "owner connection"
 * answers `consent.request` notifications, and a FAKE mesh listing.
 *
 * What this pins: the owner can approve, see the status, see a changed definition suspend a tool and
 * re-approve it by name; and that the list now counts (AD3a-2a, invariant I58): the capture gate is
 * built over the REAL agent door, so a type the owner approved is accepted and one they did not is not
 * (the AD3a-1 "reach is unchanged" test is replaced by "the list counts" below).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { DEFAULT_MCP_SINK_CONFIG } from "../../../src/config/mcp-sink-toml.ts";
import {
  type AgentDoor,
  createAgentDoor,
} from "../../../src/connectors/connector-writes/agent-door-runtime.ts";
import { listDoorApprovals } from "../../../src/connectors/connector-writes/door-approval-store.ts";
import { setModelWriteEnablement } from "../../../src/connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../../../src/connectors/connector-writes/index.ts";
import { createModelWriteToolSource } from "../../../src/connectors/connector-writes/model-write-source.ts";
import { previewTemplateKeys } from "../../../src/connectors/connector-writes/types.ts";
import type { LazyConnectorMesh } from "../../../src/connectors/lazy-mesh/mesh.ts";
import { mcpClientToolKey } from "../../../src/connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "../../../src/engine/service-of.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../../src/index/local-index.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { ConsentCoordinatorImpl } from "../../../src/ipc/consent.ts";
import { createStreamRegistry } from "../../../src/ipc/engine-ask-stream.ts";
import type { JsonRpcNotification } from "../../../src/ipc/jsonrpc.ts";
import type { ClientKind } from "../../../src/ipc/server/client-kind.ts";
import type { ServerCtx } from "../../../src/ipc/server/context.ts";
import {
  tryDispatchConnectorRpc,
  tryDispatchPhase4Rpc,
} from "../../../src/ipc/server/dispatchers.ts";
import type { CreateIpcServerOptions } from "../../../src/ipc/server/options.ts";
import { resolveCaptureCapability } from "../../../src/mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../../../src/mcp-sink/capture-gate.ts";
import {
  CaptureAttemptLimiter,
  CaptureRefusalCounter,
} from "../../../src/mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../../../src/mcp-sink/capture-store.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

const OWNER = "owner";
const AGENT = "agent";

let db: Database;
let store: CaptureStore;
let coordinator: ConsentCoordinatorImpl;
let prompts: string[];
let describeTool: (toolId: string) => string;
let seq: number;
const kinds: Record<string, ClientKind> = { [OWNER]: "cli", [AGENT]: "mcp" };

function listing(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== "github") continue;
    // The schema declares every input key the row's typed preview names (the drift check).
    const keys = r.preview === undefined ? [] : [...previewTemplateKeys(r.preview)];
    out[mcpClientToolKey("github", r.toolId)] = {
      description: describeTool(r.toolId),
      inputSchema: toStandardSchema({
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
      } as JsonSchemaInput),
    };
    // The tools a Wave 4 or bound row needs listed: its current-state readers and its prepare tool.
    const support = [
      r.before?.tool,
      r.before?.also?.tool,
      r.bound?.prepare.tool,
      r.bound?.prepare.settleTool,
    ];
    for (const tool of support) {
      if (tool === undefined) continue;
      out[mcpClientToolKey("github", tool)] ??= {
        description: `read ${tool}`,
        inputSchema: toStandardSchema({ type: "object", properties: {} } as JsonSchemaInput),
      };
    }
  }
  return out;
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new CaptureStore(db);
  prompts = [];
  seq = 0;
  describeTool = (t) => `d ${t}`;
  coordinator = new ConsentCoordinatorImpl(() => (n: JsonRpcNotification) => {
    const p = n.params as Record<string, unknown>;
    prompts.push(String(p["prompt"]));
    queueMicrotask(() =>
      coordinator.handleRespond(OWNER, {
        requestId: String(p["requestId"]),
        approved: true,
        answerSource: "human",
      }),
    );
  });
});
afterEach(() => db.close());

function agentDoor(): AgentDoor {
  return createAgentDoor({
    db,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
    listServerTools: async (service) => (service === "github" ? listing() : undefined),
    tribalKbConfig: () => undefined,
    classifyContext: {
      userMcpModelAccessAllowed: () => false,
      modelAccessServices: () => new Set<string>(),
    },
    isServiceConfigured: async () => true,
    now: () => 1_000 + seq,
  });
}

function gateDeps(): CaptureGateDeps {
  return {
    db,
    store,
    capability: () =>
      resolveCaptureCapability(
        {
          ok: true,
          config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
        },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => 1_000 + seq,
    // The production wiring: the verdict, the refusal and the definition check are the agent door's.
    classifyAction: agentDoor().verdict,
    isServiceConfigured: () => Promise.resolve(true),
    actionDestinationRefusal: agentDoor().refusal,
    verifyActionDefinition: agentDoor().verifyDefinition,
  };
}

function serverCtx(): ServerCtx {
  const mesh = {
    listFirstPartyServerTools: async (service: string) =>
      service === "github" ? listing() : undefined,
    restartObsidian: async () => {},
    obsidianWriteScope: () => ({ roots: [], notes: [], skipped: [] }),
    iacPathDepsForEnable: () => undefined,
  } as unknown as LazyConnectorMesh;
  const options: CreateIpcServerOptions = {
    listenPath: "",
    vault: createMockVault(),
    version: "test",
    localIndex: new LocalIndex(db),
    connectorMesh: mesh,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
    captureRpcCtx: { gate: gateDeps() },
  };
  return {
    options,
    consentImpl: coordinator,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: (id: string) => kinds[id] ?? "unknown",
  } as unknown as ServerCtx;
}

const connector = (client: string, method: string, params: unknown = {}) =>
  tryDispatchConnectorRpc(serverCtx(), method, params, client);
const captureRpc = (client: string, method: string, params: unknown) =>
  tryDispatchPhase4Rpc(serverCtx(), method, params, client);

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { rpcData?: { code?: string }; message?: string };
    return err.rpcData?.code ?? err.message;
  }
  throw new Error("expected a rejection");
}

type Status = {
  agent: {
    services: Array<{
      service: string;
      approved: number;
      suspended: Array<{ toolId: string; approvedSha12: string; nowSha12: string | null }>;
    }>;
  };
};

const auditCount = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

describe("the owner's approval list for outside agents", () => {
  test("enable at wave 4, status, a changed definition suspends the tool, a re-approval by name clears it", async () => {
    const out = (await connector(OWNER, "connector.writesEnable", {
      service: "github",
      wave: 4,
      door: "agent",
    })) as { approved: number };
    expect(out.approved).toBeGreaterThan(10);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Door: outside agents (MCP)");
    expect(prompts[0]).toContain("typed confirmation");
    expect(listDoorApprovals(db, "agent", "github")).toHaveLength(out.approved);

    const s1 = (await connector(OWNER, "connector.writesStatus")) as Status;
    expect(s1.agent.services).toEqual([
      { service: "github", approved: out.approved, suspended: [] },
    ]);

    // The connector's listing changes by one byte of one description.
    const id = "github_issue_create";
    describeTool = (t) => (t === id ? `d ${t}!` : `d ${t}`);
    const before = auditCount();
    const s2 = (await connector(OWNER, "connector.writesStatus")) as Status;
    expect(s2.agent.services[0]?.approved).toBe(out.approved - 1);
    expect(s2.agent.services[0]?.suspended.map((x) => x.toolId)).toEqual([id]);
    expect(s2.agent.services[0]?.suspended[0]?.nowSha12).not.toBeNull();
    expect(auditCount()).toBe(before + 1);

    // Changing it back does not un-suspend; only a re-approval by name does.
    describeTool = (t) => `d ${t}`;
    const s3 = (await connector(OWNER, "connector.writesStatus")) as Status;
    expect(s3.agent.services[0]?.suspended.map((x) => x.toolId)).toEqual([id]);
    describeTool = (t) => (t === id ? `d ${t}!` : `d ${t}`);
    await connector(OWNER, "connector.writesEnable", {
      service: "github",
      wave: 4,
      door: "agent",
      approve: [id],
    });
    const s4 = (await connector(OWNER, "connector.writesStatus")) as Status;
    expect(s4.agent.services[0]?.suspended).toEqual([]);
    expect(s4.agent.services[0]?.approved).toBe(out.approved);
  });

  test("an mcp connection calling the agent enable is refused before any prompt, and the same for an undeclared one", async () => {
    for (const client of [AGENT, "undeclared"]) {
      expect(
        await code(
          connector(client, "connector.writesEnable", { service: "github", door: "agent" }),
        ),
      ).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
    }
    expect(prompts).toEqual([]);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("disable --door agent removes the list and leaves the shared wave", async () => {
    await connector(OWNER, "connector.writesEnable", { service: "github", wave: 3, door: "agent" });
    expect(
      await connector(OWNER, "connector.writesDisable", { service: "github", door: "agent" }),
    ).toEqual({
      removed: true,
    });
    expect(listDoorApprovals(db, "agent")).toEqual([]);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM connector_write_enablement").get() as { n: number }).n,
    ).toBe(1);
  });
});

describe("the list counts: what an outside agent can propose depends on the owner's approval", () => {
  const submit = (
    actionType: string,
    input: Record<string, unknown> = { repo: "o/r", title: "t" },
  ) =>
    captureRpc(AGENT, "capture.submit", {
      kind: "action",
      payload: { actionType, input, summary: "s" },
      clientLabel: "claude-code",
    });

  test("a Wave 4 type is refused until the owner enables the service to wave 4 and approves it, then accepted with no warning", async () => {
    expect(await code(submit("github.pr.merge"))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");

    // Wave 3 does not reach a Wave 4 row.
    await connector(OWNER, "connector.writesEnable", { service: "github", wave: 3, door: "agent" });
    expect(await code(submit("github.pr.merge"))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");

    await connector(OWNER, "connector.writesEnable", { service: "github", wave: 4, door: "agent" });
    expect(
      listDoorApprovals(db, "agent", "github").some((a) => a.toolId === "github_pr_merge"),
    ).toBe(true);
    const out = (await submit("github.pr.merge")) as Record<string, unknown>;
    expect(out["state"]).toBe("proposed");
    expect(out).not.toHaveProperty("legacy");
    expect(out).not.toHaveProperty("deprecation");
    const stored = db.query("SELECT legacy FROM capture WHERE id = ?").get(out["id"] as string) as {
      legacy: number;
    };
    expect(stored.legacy).toBe(0);
  });

  test("a wave-4 service with only another tool approved still refuses the unapproved one", async () => {
    await connector(OWNER, "connector.writesEnable", {
      service: "github",
      wave: 4,
      door: "agent",
      approve: ["github_pr_close"],
    });
    expect(await code(submit("github.pr.merge"))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(((await submit("github.pr.close")) as { state: string }).state).toBe("proposed");
  });

  test("a type the earlier door accepted is still accepted with no approval, flagged and warned", async () => {
    const out = (await submit("github.issue.create")) as Record<string, unknown>;
    expect(out["state"]).toBe("proposed");
    expect(out["legacy"]).toBe(true);
    expect(String(out["deprecation"])).toContain(
      "nimbus connector writes enable github --door agent",
    );
  });

  test("a bound type with no approval stays refused", async () => {
    expect(await code(submit("github.file.commit"))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
});

describe("an upgrade from V96", () => {
  test("a model opt-in and queued captures survive, the model's offer is unchanged and the agent list is empty", async () => {
    const old = new (await import("bun:sqlite")).Database(":memory:");
    try {
      runIndexedSchemaMigrations(old, 96);
      setModelWriteEnablement(old, "github", 3, 5, ["github_issue_create", "github_pr_close"]);
      // A V96 `capture` has no `legacy` column, so this row is written the way V96 wrote it.
      old.run(
        `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at, expires_at)
         VALUES (?, 'action', 'proposed', NULL, ?, 60, 'claude-code', 's1', 1, 9999999)`,
        ["cap_old", JSON.stringify({ actionType: "github.issue.create", input: {}, summary: "s" })],
      );
      const offer = (d: Database) =>
        createModelWriteToolSource({
          db: d,
          enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }) as never,
          listServerTools: async () => undefined,
          toolsEpoch: () => 0,
          warn: () => {},
          approvedWorkdirs: () => [],
          approvedK8sPairs: () => [],
        })
          .offerableEnabledRows()
          .map((r) => r.toolId);
      const before = offer(old);
      expect(before.length).toBeGreaterThan(0);
      runIndexedSchemaMigrations(old, CURRENT_SCHEMA_VERSION);
      expect(offer(old)).toEqual(before);
      expect(listDoorApprovals(old, "agent")).toEqual([]);
      const row = new CaptureStore(old).get("cap_old");
      expect(row?.state).toBe("proposed");
      const legacy = old.query("SELECT legacy FROM capture WHERE id = 'cap_old'").get() as {
        legacy: number;
      };
      expect(legacy.legacy).toBe(0);
    } finally {
      old.close();
    }
  });
});
