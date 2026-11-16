import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../../config/incident-toml.ts";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { configMap, serviceConfig, T0 } from "../../incident/__fixtures__/index-writers.ts";
import { createIncidentEngine } from "../../incident/incident-engine.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientKind } from "./client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchIncidentRpc, tryDispatchPhase4Rpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function makeCtx(wired: boolean, kind: ClientKind): ServerCtx {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const engine = createIncidentEngine({
    db,
    now: () => T0,
    emit: () => {},
    loadServiceConfigs: () => configMap(serviceConfig()),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
  return {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(wired ? { incidentRpcCtx: { db, engine } } : {}),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => kind,
  } as unknown as ServerCtx;
}

describe("tryDispatchIncidentRpc", () => {
  test("incident.list reaches the handler THROUGH the phase 4 group, with the connection's kind", async () => {
    const out = (await tryDispatchPhase4Rpc(makeCtx(true, "cli"), "incident.list", {}, "c1")) as {
      status: string;
    };
    expect(out.status).toBe("no_data");
    const ui = (await tryDispatchPhase4Rpc(makeCtx(true, "ui"), "incident.list", {}, "c1")) as {
      status: string;
    };
    expect(ui.status).toBe("no_data");
  });

  test("the kind comes from the connection: every other kind gets ERR_INCIDENT_FORBIDDEN_CLIENT", async () => {
    for (const kind of ["mcp", "unknown", "http", "chatops", "fleet", "push"] as const) {
      for (const m of ["incident.list", "incident.get", "incident.assemble"]) {
        const err = await tryDispatchPhase4Rpc(makeCtx(true, kind), m, { id: "x" }, "c1").catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RpcMethodError);
        expect((err as RpcMethodError).rpcCode).toBe(-32000);
        expect((err as RpcMethodError).message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
      }
    }
  });

  test("an unrelated method, an unwired context and an unknown method are skipped", async () => {
    expect(await tryDispatchIncidentRpc(makeCtx(true, "cli"), "oncall.now", {}, "c")).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchIncidentRpc(makeCtx(false, "cli"), "incident.list", {}, "c")).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchIncidentRpc(makeCtx(true, "cli"), "incident.zzz", {}, "c")).toBe(
      phase4RpcSkipped,
    );
  });

  test("a validation error keeps its code, and a non-domain failure propagates", async () => {
    const err = await tryDispatchIncidentRpc(
      makeCtx(true, "cli"),
      "incident.list",
      { limit: 0 },
      "c",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect((err as RpcMethodError).rpcCode).toBe(-32602);
    const ctx = makeCtx(true, "cli");
    const rpc = ctx.options.incidentRpcCtx;
    if (rpc === undefined) throw new Error("fixture");
    const broken = {
      ...ctx,
      options: {
        ...ctx.options,
        incidentRpcCtx: {
          ...rpc,
          engine: { assembleNow: () => Promise.reject(new Error("boom")) },
        },
      },
    };
    dbs
      .at(-1)
      ?.run(
        "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('pagerduty:A','pagerduty','incident','A','t',1,1)",
      );
    await expect(
      tryDispatchIncidentRpc(broken as unknown as ServerCtx, "incident.assemble", { id: "A" }, "c"),
    ).rejects.toThrow("boom");
  });
});
