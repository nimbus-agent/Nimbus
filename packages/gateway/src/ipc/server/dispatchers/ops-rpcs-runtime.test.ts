/**
 * Direct tests of the runtime-backed arms of `ops-rpcs.ts`: briefing, incident, oncall push and iac drift. Each
 * runtime is a small fake handed in through `ServerCtx.options`, so the hit, the miss, the domain-error remap to
 * `RpcMethodError` and the re-throw of any other error are each reached without a gateway.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../../connectors/connector-sync-test-helpers.ts";
import { createMockVault } from "../../../vault/mock.ts";
import { createStreamRegistry } from "../../engine-ask-stream.ts";
import type { ClientKind } from "../client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import {
  tryDispatchBriefingRpc,
  tryDispatchIacDriftRpc,
  tryDispatchIncidentRpc,
  tryDispatchOncallPushRpc,
} from "./ops-rpcs.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const boom = (): never => {
  throw new Error("boom");
};

function ctxOf(
  options: Record<string, unknown>,
  kind: ClientKind | (() => ClientKind) = "cli",
): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...options },
    consentImpl: undefined,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: typeof kind === "function" ? kind : () => kind,
  } as unknown as ServerCtx;
}

async function rpcError(p: Promise<unknown>): Promise<RpcMethodError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RpcMethodError);
  return e as RpcMethodError;
}

describe("tryDispatchBriefingRpc", () => {
  const runtime = (latest: () => unknown = () => null) => ({
    latest,
    list: () => [],
    get: () => null,
    status: () => ({ enabled: false }),
    runNow: async () => null,
  });
  const ctx = (latest?: () => unknown) => ctxOf({ briefingRpcCtx: { runtime: runtime(latest) } });

  test("a hit returns the runtime's answer; a miss, another namespace and no runtime skip", async () => {
    expect(await tryDispatchBriefingRpc(ctx(), "briefing.latest", {})).toEqual({ run: null });
    expect(await tryDispatchBriefingRpc(ctx(), "briefing.zzz", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchBriefingRpc(ctx(), "cost.waste", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchBriefingRpc(ctxOf({}), "briefing.latest", {})).toBe(phase4RpcSkipped);
  });

  test("a domain error keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(tryDispatchBriefingRpc(ctx(), "briefing.get", { id: "" }));
    expect(e.rpcCode).toBe(-32602);
    await expect(tryDispatchBriefingRpc(ctx(boom), "briefing.latest", {})).rejects.toThrow("boom");
  });
});

describe("tryDispatchIncidentRpc", () => {
  const ctx = (kind: ClientKind | (() => ClientKind) = "cli") => {
    const db = createMemoryIndexDb();
    dbs.push(db);
    return ctxOf(
      {
        incidentRpcCtx: {
          db,
          engine: { assembleNow: async () => [] },
          dependsOn: () => new Map(),
        },
      },
      kind,
    );
  };

  test("a hit lists records; a miss, another namespace and no runtime skip", async () => {
    const out = (await tryDispatchIncidentRpc(ctx(), "incident.list", {}, "c1")) as {
      records: unknown[];
    };
    expect(out.records).toEqual([]);
    expect(await tryDispatchIncidentRpc(ctx(), "incident.zzz", {}, "c1")).toBe(phase4RpcSkipped);
    expect(await tryDispatchIncidentRpc(ctx(), "oncall.now", {}, "c1")).toBe(phase4RpcSkipped);
    expect(await tryDispatchIncidentRpc(ctxOf({}), "incident.list", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
  });

  test("a non-owner kind keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(tryDispatchIncidentRpc(ctx("mcp"), "incident.list", {}, "c1"));
    expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    await expect(tryDispatchIncidentRpc(ctx(boom), "incident.list", {}, "c1")).rejects.toThrow(
      "boom",
    );
  });
});

describe("tryDispatchOncallPushRpc", () => {
  const runtime = (isEnabled: () => boolean = () => true) => ({
    isEnabled,
    identityResolved: async () => false,
    store: { listWithIncident: () => [] },
    config: { chatopsNamespace: "", sources: ["pagerduty"] },
    chatopsSinkState: () => "unbound",
    incidentEngineEnabled: () => false,
    lastRun: () => null,
  });
  const ctx = (isEnabled?: () => boolean) =>
    ctxOf({ oncallPushRpcCtx: { runtime: runtime(isEnabled) } });

  test("a hit lists pushed briefs; a miss, another namespace and no runtime skip", async () => {
    const out = (await tryDispatchOncallPushRpc(ctx(), "oncall.pushedList", {})) as {
      enabled: boolean;
      briefs: unknown[];
    };
    expect(out.enabled).toBe(true);
    expect(out.briefs).toEqual([]);
    expect(await tryDispatchOncallPushRpc(ctx(), "oncall.zzz", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchOncallPushRpc(ctx(), "incident.list", {})).toBe(phase4RpcSkipped);
    expect(await tryDispatchOncallPushRpc(ctxOf({}), "oncall.pushedList", {})).toBe(
      phase4RpcSkipped,
    );
  });

  test("a domain error keeps its code; any other error is re-thrown as it is", async () => {
    const e = await rpcError(tryDispatchOncallPushRpc(ctx(), "oncall.pushedList", { limit: 0 }));
    expect(e.rpcCode).toBe(-32602);
    await expect(tryDispatchOncallPushRpc(ctx(boom), "oncall.pushedList", {})).rejects.toThrow(
      "boom",
    );
  });
});

describe("tryDispatchIacDriftRpc", () => {
  const ctx = (latest: () => unknown[] = () => [], kind: ClientKind | (() => ClientKind) = "cli") =>
    ctxOf({ iacDriftRpcCtx: { runner: () => ({ latest, check: async () => [] }) } }, kind);

  test("a hit returns the latest findings; a miss, another namespace and no runtime skip", async () => {
    expect(await tryDispatchIacDriftRpc(ctx(), "iac.driftLatest", {}, "c1")).toEqual({
      findings: [],
    });
    expect(await tryDispatchIacDriftRpc(ctx(), "iac.zzz", {}, "c1")).toBe(phase4RpcSkipped);
    expect(await tryDispatchIacDriftRpc(ctx(), "incident.list", {}, "c1")).toBe(phase4RpcSkipped);
    expect(await tryDispatchIacDriftRpc(ctxOf({}), "iac.driftLatest", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
  });

  test("a non-CLI kind keeps its code; any other error is re-thrown as it is", async () => {
    // the desktop (ui) may READ the latest findings but never start a check
    expect(await tryDispatchIacDriftRpc(ctx(undefined, "ui"), "iac.driftLatest", {}, "c1")).toEqual(
      { findings: [] },
    );
    const e = await rpcError(
      tryDispatchIacDriftRpc(ctx(undefined, "ui"), "iac.driftCheck", {}, "c1"),
    );
    expect(e.message).toContain("ERR_IAC_DRIFT_CLI_ONLY");
    const m = await rpcError(
      tryDispatchIacDriftRpc(ctx(undefined, "mcp"), "iac.driftLatest", {}, "c1"),
    );
    expect(m.message).toContain("ERR_IAC_DRIFT_OWNER_ONLY");
    await expect(tryDispatchIacDriftRpc(ctx(boom), "iac.driftLatest", {}, "c1")).rejects.toThrow(
      "boom",
    );
  });
});
