import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../../../config/incident-toml.ts";
import { createMemoryIndexDb } from "../../../connectors/connector-sync-test-helpers.ts";
import { configMap, serviceConfig, T0 } from "../../../incident/__fixtures__/index-writers.ts";
import { createIncidentEngine } from "../../../incident/incident-engine.ts";
import { createMockVault } from "../../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../../consent.ts";
import { createStreamRegistry } from "../../engine-ask-stream.ts";
import type { ClientKind } from "../client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import {
  tryDispatchCostRpc,
  tryDispatchInvestigationRpc,
  tryDispatchPrereviewRpc,
  tryDispatchStatuspageRpc,
  tryDispatchUpdateSynthesisRpc,
} from "./ops-rpcs.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

/** A context with (or without) a local index and the incident runtime, answering as `kind`. */
function makeCtx(opts: { index: boolean; incident: boolean; kind: ClientKind }): ServerCtx {
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
      ...(opts.index ? { localIndex: { getDatabase: () => db } } : {}),
      ...(opts.incident ? { incidentRpcCtx: { db, engine, dependsOn: () => new Map() } } : {}),
    },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => opts.kind,
  } as unknown as ServerCtx;
}

async function rpcError(p: Promise<unknown>): Promise<RpcMethodError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RpcMethodError);
  return err as RpcMethodError;
}

describe("tryDispatchUpdateSynthesisRpc", () => {
  test("another method, or no local index, is skipped", async () => {
    const ctx = makeCtx({ index: true, incident: true, kind: "cli" });
    expect(await tryDispatchUpdateSynthesisRpc(ctx, "incident.update", {}, "c")).toBe(
      phase4RpcSkipped,
    );
    const noIndex = makeCtx({ index: false, incident: true, kind: "cli" });
    expect(
      await tryDispatchUpdateSynthesisRpc(noIndex, "incident.updateSynthesize", { id: "x" }, "c"),
    ).toBe(phase4RpcSkipped);
  });

  test("a connection that is not the owner's gets ERR_INCIDENT_FORBIDDEN_CLIENT as an RPC error", async () => {
    const ctx = makeCtx({ index: true, incident: true, kind: "mcp" });
    const err = await rpcError(
      tryDispatchUpdateSynthesisRpc(ctx, "incident.updateSynthesize", { id: "x" }, "c"),
    );
    expect(err.rpcCode).toBe(-32000);
    expect(err.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
  });

  test("an unknown parameter is -32602 for the owner too, before any model is built", async () => {
    const ctx = makeCtx({ index: true, incident: true, kind: "cli" });
    const err = await rpcError(
      tryDispatchUpdateSynthesisRpc(ctx, "incident.updateSynthesize", { id: "x", nope: 1 }, "c"),
    );
    expect(err.rpcCode).toBe(-32602);
  });
});

describe("tryDispatchInvestigationRpc", () => {
  test("another method, no incident runtime or no local index is skipped", async () => {
    const ctx = makeCtx({ index: true, incident: true, kind: "cli" });
    expect(await tryDispatchInvestigationRpc(ctx, "incident.investigate", {}, "c")).toBe(
      phase4RpcSkipped,
    );
    for (const [index, incident] of [
      [false, true],
      [true, false],
    ] as const) {
      const partial = makeCtx({ index, incident, kind: "cli" });
      expect(
        await tryDispatchInvestigationRpc(
          partial,
          "incident.investigateSynthesize",
          { id: "x" },
          "c",
        ),
      ).toBe(phase4RpcSkipped);
    }
  });

  test("both methods refuse a connection that is not the owner's, as an RPC error", async () => {
    for (const method of ["incident.investigateSynthesize", "incident.investigateLive"]) {
      const ctx = makeCtx({ index: true, incident: true, kind: "http" });
      const err = await rpcError(tryDispatchInvestigationRpc(ctx, method, { id: "x" }, "c"));
      expect(err.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    }
  });
});

describe("tryDispatchPrereviewRpc", () => {
  test("another method, or no local index, is skipped", async () => {
    const ctx = makeCtx({ index: true, incident: false, kind: "cli" });
    expect(await tryDispatchPrereviewRpc(ctx, "prreview.other", {}, "c")).toBe(phase4RpcSkipped);
    const noIndex = makeCtx({ index: false, incident: false, kind: "cli" });
    expect(await tryDispatchPrereviewRpc(noIndex, "prreview.run", { url: "u" }, "c")).toBe(
      phase4RpcSkipped,
    );
  });

  test("a malformed payload is mapped to an RPC error with the handler's code", async () => {
    const ctx = makeCtx({ index: true, incident: false, kind: "cli" });
    const err = await rpcError(tryDispatchPrereviewRpc(ctx, "prreview.run", { url: "" }, "c"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toContain("url must be a non-empty string");
  });
});

describe("the index-only ops dispatchers", () => {
  test("statuspage and cost are skipped without a local index or for another method", async () => {
    const noIndex = makeCtx({ index: false, incident: false, kind: "cli" });
    expect(await tryDispatchStatuspageRpc(noIndex, "statuspage.model", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchCostRpc(noIndex, "cost.anomalies", {})).toBe(phase4RpcSkipped);
    const ctx = makeCtx({ index: true, incident: false, kind: "cli" });
    expect(await tryDispatchStatuspageRpc(ctx, "statuspage.other", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchCostRpc(ctx, "briefing.latest", {})).toBe(phase4RpcSkipped);
  });

  test("a cost payload error keeps its code and its method-named message", async () => {
    const ctx = makeCtx({ index: true, incident: false, kind: "cli" });
    const err = await rpcError(tryDispatchCostRpc(ctx, "cost.waste", { nope: 1 }));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe('cost.waste: unknown parameter "nope"');
    const anomalies = await rpcError(tryDispatchCostRpc(ctx, "cost.anomalies", []));
    expect(anomalies.message).toBe("cost.anomalies requires an object payload");
  });
});
