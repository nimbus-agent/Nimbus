// Phase 28 AD3a-1: `connector.writesEnable` with `door: "agent"` through the real dispatcher: the
// connection's declared kind decides who may approve, and only a person's answer counts (the
// human-only consent wrapper is built here, around THIS connection's consent channel).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { listDoorApprovals } from "../../connectors/connector-writes/door-approval-store.ts";
import { getModelWriteEnablement } from "../../connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../../connectors/connector-writes/index.ts";
import { previewTemplateKeys } from "../../connectors/connector-writes/types.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/mesh.ts";
import { mcpClientToolKey } from "../../connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientKind } from "./client-kind.ts";
import type { ServerCtx } from "./context.ts";
import { tryDispatchConnectorRpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});

function githubListing(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== "github") continue;
    // The schema declares every input key the row's typed preview names (the drift check).
    const keys = r.preview === undefined ? [] : [...previewTemplateKeys(r.preview)];
    out[mcpClientToolKey("github", r.toolId)] = {
      description: `d ${r.toolId}`,
      inputSchema: toStandardSchema({
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
      } as JsonSchemaInput),
    };
  }
  return out;
}

function harness(opts: {
  readonly kind: ClientKind;
  readonly answerSource?: "human" | "auto" | "script";
  readonly approve?: boolean;
}) {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dbs.push(db);
  const prompts: string[] = [];
  const coordinator: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(() => (n) => {
    const p = n.params as Record<string, unknown>;
    prompts.push(String(p["prompt"]));
    queueMicrotask(() =>
      coordinator.handleRespond("c1", {
        requestId: String(p["requestId"]),
        approved: opts.approve ?? true,
        answerSource: opts.answerSource ?? "human",
      }),
    );
  });
  const mesh = {
    listFirstPartyServerTools: async (service: string) =>
      service === "github" ? githubListing() : undefined,
    restartObsidian: async () => {},
    obsidianWriteScope: () => ({ roots: [], notes: [], skipped: [] }),
    iacPathDepsForEnable: () => undefined,
  } as unknown as LazyConnectorMesh;
  const ctx: ServerCtx = {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      localIndex: new LocalIndex(db),
      connectorMesh: mesh,
      enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
    },
    consentImpl: coordinator,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => opts.kind,
  };
  return { ctx, db, prompts };
}

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcMethodError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

const AGENT_ENABLE = { service: "github", wave: 3, door: "agent" };

describe("connector.writesEnable with door agent through the dispatcher", () => {
  test("a cli connection with a human answer writes the list", async () => {
    const h = harness({ kind: "cli" });
    const out = (await tryDispatchConnectorRpc(
      h.ctx,
      "connector.writesEnable",
      AGENT_ENABLE,
      "c1",
    )) as { door: string; approved: number };
    expect(out.door).toBe("agent");
    expect(out.approved).toBeGreaterThan(0);
    expect(h.prompts).toHaveLength(1);
    expect(listDoorApprovals(h.db, "agent", "github")).toHaveLength(out.approved);
  });

  test("a ui connection reaches the prompt too", async () => {
    const h = harness({ kind: "ui" });
    await tryDispatchConnectorRpc(h.ctx, "connector.writesEnable", AGENT_ENABLE, "c1");
    expect(h.prompts).toHaveLength(1);
  });

  for (const kind of ["mcp", "unknown", "http", "chatops"] as const) {
    test(`a ${kind} connection is refused before any prompt`, async () => {
      const h = harness({ kind });
      expect(
        await message(tryDispatchConnectorRpc(h.ctx, "connector.writesEnable", AGENT_ENABLE, "c1")),
      ).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
      expect(h.prompts).toEqual([]);
      expect(listDoorApprovals(h.db, "agent")).toEqual([]);
    });
  }

  for (const source of ["auto", "script"] as const) {
    test(`an approval answered as ${source} is a decline: nothing is written and the reply says why`, async () => {
      const h = harness({ kind: "cli", answerSource: source });
      const msg = await message(
        tryDispatchConnectorRpc(h.ctx, "connector.writesEnable", AGENT_ENABLE, "c1"),
      );
      expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
      expect(msg).toContain("did not come from a person");
      expect(listDoorApprovals(h.db, "agent")).toEqual([]);
      expect(getModelWriteEnablement(h.db, "github")).toBeUndefined();
    });
  }

  test("the model door's enable is NOT human-only: an auto answer still enables it", async () => {
    const h = harness({ kind: "cli", answerSource: "auto" });
    await tryDispatchConnectorRpc(
      h.ctx,
      "connector.writesEnable",
      { service: "github", wave: 3 },
      "c1",
    );
    expect(getModelWriteEnablement(h.db, "github")?.maxWave).toBe(3);
  });

  test("status carries the agent member beside the model's two", async () => {
    const h = harness({ kind: "cli" });
    await tryDispatchConnectorRpc(h.ctx, "connector.writesEnable", AGENT_ENABLE, "c1");
    const s = (await tryDispatchConnectorRpc(h.ctx, "connector.writesStatus", {}, "c1")) as {
      services: unknown[];
      policyAllows: boolean;
      agent: { services: Array<{ service: string }>; policyAllows: boolean };
    };
    expect(Object.keys(s).sort()).toEqual(["agent", "policyAllows", "services"]);
    expect(s.agent.services.map((x) => x.service)).toEqual(["github"]);
    expect(s.agent.policyAllows).toBe(true);
  });
});
