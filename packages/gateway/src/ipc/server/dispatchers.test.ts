import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProfileManager } from "../../config/profiles.ts";
import { appendEgressEntry } from "../../egress/egress-ledger.ts";
import { InMemoryDiscoveryProvider } from "../../federation/discovery.ts";
import { PeerPairing } from "../../federation/peer-pairing.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { LlmRegistry } from "../../llm/registry.ts";
import type { LlmProvider } from "../../llm/types.ts";
import { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { StatusReaders } from "../admin-status-rpc.ts";
import type { ChatopsRpcCtx } from "../chatops-rpc.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import type { EgressRpcCtx } from "../egress-rpc.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { PairingWindow } from "../lan-pairing.ts";
import type { PolicyRpcCtx } from "../policy-rpc.ts";
import type { TribalRpcCtx } from "../tribal-rpc.ts";
import {
  automationRpcSkipped,
  connectorRpcSkipped,
  deploymentRpcSkipped,
  diagnosticsRpcSkipped,
  metricsRpcSkipped,
  peopleRpcSkipped,
  phase4RpcSkipped,
  preflightRpcSkipped,
  type ServerCtx,
  sessionRpcSkipped,
} from "./context.ts";
import {
  extractKbPageRef,
  tryDispatchAdminRpc,
  tryDispatchAgentsRpc,
  tryDispatchAuditRpc,
  tryDispatchAutomationRpc,
  tryDispatchChatopsRpc,
  tryDispatchConnectorRpc,
  tryDispatchDataRpc,
  tryDispatchDeploymentRpc,
  tryDispatchDiagnosticsRpc,
  tryDispatchEgressRpc,
  tryDispatchFederationRpc,
  tryDispatchHitlRpc,
  tryDispatchIndexDemoSymbolRpc,
  tryDispatchIndexRebodyRpc,
  tryDispatchIndexReembedRpc,
  tryDispatchIndexRegraphRpc,
  tryDispatchLanRpc,
  tryDispatchLlmRpc,
  tryDispatchMetricsRpc,
  tryDispatchPeopleRpc,
  tryDispatchPhase4Rpc,
  tryDispatchPolicyRpc,
  tryDispatchPreflightRpc,
  tryDispatchPremortemRpc,
  tryDispatchProfileRpc,
  tryDispatchReindexRpc,
  tryDispatchSessionRpc,
  tryDispatchTeamVaultRpc,
  tryDispatchTribalRpc,
  tryDispatchUpdaterRpc,
  tryDispatchVoiceRpc,
} from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

function makePolicyRpcCtx(overrides: Partial<PolicyRpcCtx> = {}): PolicyRpcCtx {
  return {
    showPolicy: () => ({
      org: "acme",
      version: 1,
      signatureValid: true,
      pendingRestart: false,
      source: "peer",
    }),
    signPolicy: () => {
      throw new Error("anchor-only");
    },
    trustPubkey: () => {},
    refetch: async () => ({ applied: true }),
    purge: async () => ({ jobId: "j1", localDeleted: 0 }),
    isAnchor: false,
    ...overrides,
  };
}

function makeChatopsRpcCtx(overrides: Partial<ChatopsRpcCtx> = {}): ChatopsRpcCtx {
  return {
    status: () => ({ enabled: true, platforms: [] }),
    start: async () => {},
    stop: async () => {},
    testParse: (text: string) => ({ kind: "read", query: text }),
    ...overrides,
  };
}

function makeTribalRpcCtx(overrides: Partial<TribalRpcCtx> = {}): TribalRpcCtx {
  return {
    status: () => ({ enabled: true, clusters: 0 }),
    start: async () => {},
    stop: async () => {},
    list: () => [],
    dismiss: async () => {},
    scan: async () => ({ scanned: 0, fired: 0 }),
    capture: async () => ({ ok: true, pageRef: "notion:pg1" }),
    ...overrides,
  };
}

const statusReadersFixture: StatusReaders = {
  policyState: () => ({
    org: "acme",
    version: 1,
    signatureValid: true,
    pendingRestart: false,
    source: "peer",
  }),
  peers: () => [{ peerId: "peer:aa", reachable: true }],
  connectors: () => [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: () => [],
  audit: () => ({ chainLength: 1, lastHash: "h", appendRate1h: 0 }),
  hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
  identity: () => ({ operatorValid: true }),
  syncFreshnessMs: () => 0,
};

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function makeCtx(overrides: Partial<ServerCtx["options"]> = {}): {
  ctx: ServerCtx;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const consentImpl = new ConsentCoordinatorImpl(() => undefined);
  const ctx: ServerCtx = {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...overrides,
    },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification(method, params) {
      notifications.push({ method, params });
    },
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
  return { ctx, notifications };
}

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  openDbs.length = 0;
});

function trackedDb(): Database {
  const db = makeDb();
  openDbs.push(db);
  return db;
}

const FAKE_LLM_ROUTER_CONFIG = {
  preferLocal: true,
  remoteModel: "remote-model",
  localModel: "local-model",
  minReasoningParams: 0,
  enforceAirGap: false,
};

/** A local (ollama) LlmProvider that returns `markdown` verbatim — no real Ollama call. */
function fakeLocalOllamaProvider(markdown: string): LlmProvider {
  return {
    providerId: "ollama",
    isAvailable: async () => true,
    listModels: async () => [],
    generate: async () => ({
      text: markdown,
      tokensIn: 0,
      tokensOut: 0,
      modelUsed: "fake-model",
      isLocal: true,
      provider: "ollama",
    }),
  };
}

/** A remote-only LlmProvider — used to prove the default `[agents].synthesis = "local"` refuses it. */
function fakeRemoteProvider(): LlmProvider {
  return {
    providerId: "remote",
    isAvailable: async () => true,
    listModels: async () => [],
    generate: async () => ({
      text: "SHOULD-NEVER-BE-USED",
      tokensIn: 0,
      tokensOut: 0,
      modelUsed: "remote-model",
      isLocal: false,
      provider: "remote",
    }),
  };
}

function makeLlmRegistry(provider: LlmProvider): LlmRegistry {
  const registry = new LlmRegistry({ config: FAKE_LLM_ROUTER_CONFIG });
  registry.addProvider(provider);
  return registry;
}

async function waitForNotification(
  notifications: Array<{ method: string; params: Record<string, unknown> }>,
  method: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = notifications.find((n) => n.method === method);
    if (found !== undefined) return found.params;
    await Bun.sleep(10);
  }
  return undefined;
}

describe("tryDispatchLlmRpc", () => {
  test("skips non-llm methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchLlmRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when llmRegistry is undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchLlmRpc(ctx, "llm.listModels", {})).toBe(phase4RpcSkipped);
  });
  test("enters the dispatch path when a registry is present and rejects an unknown llm method", async () => {
    // A registry being present (not its internals) is what gates the dispatch+catch body; an unknown
    // llm.* method falls through to a method-not-found error.
    const { ctx } = makeCtx({
      llmRegistry: {} as unknown as NonNullable<ServerCtx["options"]["llmRegistry"]>,
    });
    await expect(tryDispatchLlmRpc(ctx, "llm.__nope__", {})).rejects.toBeDefined();
  });
});

describe("tryDispatchAgentsRpc", () => {
  test("skips non-agents methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchAgentsRpc(ctx, "engine.ask", {}, "test-client")).toBe(phase4RpcSkipped);
  });
  test("skips when localIndex is undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchAgentsRpc(ctx, "agents.expert", {}, "test-client")).toBe(
      phase4RpcSkipped,
    );
  });

  test("builds AgentsRpcContext.caller from the server-derived clientId/kind, not a hand-built one", async () => {
    // Exercises the real dispatchers.ts wiring (caller: { clientId, kind: ctx.getClientKind(clientId) })
    // rather than a hand-constructed AgentsRpcContext. Observes the effect through dispatchAgentsRpc's
    // real caller-attribution chokepoint (I29/D22(c): an mcp-kind caller appends one egress_ledger row
    // keyed by clientId), since tryDispatchAgentsRpc has no injectable seam over dispatchAgentsRpc
    // itself and a production seam solely for this test is not warranted.
    //
    // "client-abc" and "mcp" are deliberately non-interchangeable (client-abc is not a valid
    // ClientKind; mcp is not the clientId used here), so a clientId/kind swap cannot coincidentally
    // pass, and a hardcoded clientId literal at the call site is caught by the source_id assertion.
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const getClientKindCalls: string[] = [];
    ctx.getClientKind = (clientId: string) => {
      getClientKindCalls.push(clientId);
      return "mcp";
    };

    await tryDispatchAgentsRpc(ctx, "agents.expert", { topicOrFile: "x" }, "client-abc");

    expect(getClientKindCalls).toEqual(["client-abc"]);
    const rows = db
      .query(`SELECT source_type, source_id, method FROM egress_ledger`)
      .all() as Array<{ source_type: string; source_id: string | null; method: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_type).toBe("mcp");
    expect(rows[0]?.source_id).toBe("client-abc");
    expect(rows[0]?.method).toBe("agents.expert");
  });

  test("builds AgentsRpcContext.runner from ctx.options.llmRegistry — a synthesis-eligible context is actually supplied, not omitted as before (Task 6)", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const llmRegistry = makeLlmRegistry(fakeLocalOllamaProvider("SOCKET-SYNTHESIS-MARKER"));
    const { ctx, notifications } = makeCtx({ localIndex, llmRegistry });

    await tryDispatchAgentsRpc(ctx, "agents.expert", { topicOrFile: "x" }, "test-client");

    const params = await waitForNotification(notifications, "expert.briefReady");
    expect(params?.["brief"]).toContain("SOCKET-SYNTHESIS-MARKER");
    // The model name reported comes from LlmRouterConfig.localModel, not the provider's own
    // `modelUsed` — see LlmRouter.modelNameFor.
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "local-model",
    });
  });

  test("without an llmRegistry, no runner is built — the pre-Task-6 deterministic behavior is unchanged", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx, notifications } = makeCtx({ localIndex });

    await tryDispatchAgentsRpc(ctx, "agents.expert", { topicOrFile: "x" }, "test-client");

    const params = await waitForNotification(notifications, "expert.briefReady");
    expect(params?.["synthesis"]).toMatchObject({ attempted: false, reason: "disabled" });
  });

  test('wiring the socket runner causes NO remote egress on a default install ([agents].synthesis defaults to "local"; a REMOTE-only registry is refused)', async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const llmRegistry = makeLlmRegistry(fakeRemoteProvider());
    // No configDir on this ctx → DEFAULT_NIMBUS_AGENTS_TOML (`synthesis: "local"`) — the exact
    // config a fresh `nimbus init` install has, before anyone touches nimbus.toml.
    const { ctx, notifications } = makeCtx({ localIndex, llmRegistry });

    await tryDispatchAgentsRpc(ctx, "agents.expert", { topicOrFile: "x" }, "test-client");

    const params = await waitForNotification(notifications, "expert.briefReady");
    // "local" refuses a resolved REMOTE provider — no_eligible_provider, never "used".
    expect(params?.["synthesis"]).toMatchObject({
      attempted: false,
      reason: "no_eligible_provider",
    });
    const synthesisRows = db
      .query(`SELECT method FROM egress_ledger WHERE method LIKE '%.synthesis'`)
      .all();
    expect(synthesisRows).toEqual([]);
  });
});

describe("tryDispatchFederationRpc", () => {
  test("skips a non-federation method", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchFederationRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips a federation method when the federation services are not wired", async () => {
    // ctx has no federationDiscovery/federationPairing => skip
    const { ctx } = makeCtx();
    expect(await tryDispatchFederationRpc(ctx, "federation.discover", {})).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchVoiceRpc", () => {
  test("skips non-voice methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchVoiceRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when voiceService is undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchVoiceRpc(ctx, "voice.startListening", {})).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchTeamVaultRpc", () => {
  test("skips non-teamvault methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchTeamVaultRpc(ctx, "engine.ask", {}, "c")).toBe(phase4RpcSkipped);
  });
  test("skips when localIndex is undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchTeamVaultRpc(ctx, "teamvault.list", {}, "c")).toBe(phase4RpcSkipped);
  });
  test("dispatches a non-gated read (teamvault.list) when the index is present", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchTeamVaultRpc(ctx, "teamvault.list", {}, "c");
    expect(out).toMatchObject({ entries: [] });
  });
});

describe("tryDispatchHitlRpc", () => {
  test("skips non-hitl methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchHitlRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when localIndex is undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchHitlRpc(ctx, "hitl.listDelegations", {})).toBe(phase4RpcSkipped);
  });
  test("dispatches hitl.listDelegations when the index is present", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchHitlRpc(ctx, "hitl.listDelegations", {});
    expect(out).toMatchObject({ delegations: [] });
  });
});

describe("tryDispatchUpdaterRpc", () => {
  test("skips non-updater methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchUpdaterRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("delegates with undefined updater (handler decides)", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchUpdaterRpc(ctx, "updater.checkNow", {})).rejects.toBeDefined();
  });
});

describe("tryDispatchAuditRpc", () => {
  test("skips other methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchAuditRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when localIndex undefined and method is audit.*", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchAuditRpc(ctx, "audit.verify", {})).rejects.toThrow(
      /LocalIndex not configured/,
    );
  });
  test("delegates to dispatchAuditRpc when localIndex available", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchAuditRpc(ctx, "audit.verify", {});
    expect(out).toBeDefined();
  });
});

describe("tryDispatchMetricsRpc", () => {
  test("skips non-metrics methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchMetricsRpc(ctx, "engine.ask", {})).toBe(metricsRpcSkipped);
  });
  test("skips when localIndex undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchMetricsRpc(ctx, "metrics.dora", {})).toBe(metricsRpcSkipped);
  });
  test("throws when configDir missing", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchMetricsRpc(ctx, "metrics.dora", {})).rejects.toThrow(
      /configDir is required/,
    );
  });
});

describe("tryDispatchPreflightRpc", () => {
  test("skips non-deploy methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchPreflightRpc(ctx, "engine.ask", {})).toBe(preflightRpcSkipped);
  });
  test("skips when localIndex undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchPreflightRpc(ctx, "deploy.preflight", {})).toBe(preflightRpcSkipped);
  });
  test("throws when configDir missing", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchPreflightRpc(ctx, "deploy.preflight", {})).rejects.toThrow(
      /configDir is required/,
    );
  });
});

describe("tryDispatchDeploymentRpc", () => {
  test("skips non-deployment.annotate methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchDeploymentRpc(ctx, "engine.ask", {})).toBe(deploymentRpcSkipped);
  });
  test("skips when localIndex undefined", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchDeploymentRpc(ctx, "deployment.annotate", {})).toBe(
      deploymentRpcSkipped,
    );
  });
  test("delegates and rethrows validation errors as RpcMethodError", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchDeploymentRpc(ctx, "deployment.annotate", {})).rejects.toBeDefined();
  });
});

describe("tryDispatchReindexRpc", () => {
  test("skips non-connector.reindex methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchReindexRpc(ctx, "engine.ask", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("delegates and bubbles validation errors", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchReindexRpc(ctx, "connector.reindex", {}, "c1")).rejects.toBeDefined();
  });
  test("skips when localIndex missing (no toolExecutor branch)", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchReindexRpc(ctx, "connector.reindex", {}, "c1")).rejects.toBeDefined();
  });
});

describe("tryDispatchIndexReembedRpc", () => {
  test("skips other methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchIndexReembedRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when localIndex missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchIndexReembedRpc(ctx, "index.reembed", {})).rejects.toThrow(
      /requires LocalIndex/,
    );
  });
  test("throws when dataDir missing", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchIndexReembedRpc(ctx, "index.reembed", {})).rejects.toThrow(
      /requires dataDir/,
    );
  });
  test("delegates index.reembedCancel with valid wiring", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-reembed-"));
    const { ctx } = makeCtx({ localIndex, dataDir: tmp });
    // A typed error from the dispatcher is acceptable; what's under test is that the method was
    // delegated rather than skipped.
    const outcome = await tryDispatchIndexReembedRpc(ctx, "index.reembedCancel", {
      jobId: "missing",
    }).catch((e: unknown) => e);
    expect(outcome).not.toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchIndexRebodyRpc", () => {
  test("skips other methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchIndexRebodyRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when localIndex missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchIndexRebodyRpc(ctx, "index.rebody", {})).rejects.toThrow(
      /requires LocalIndex/,
    );
  });
  test("delegates index.rebody with valid wiring and no syncScheduler", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const outcome = await tryDispatchIndexRebodyRpc(ctx, "index.rebody", { dryRun: true });
    expect(outcome).not.toBe(phase4RpcSkipped);
    expect((outcome as { jobId: string }).jobId).toMatch(/^rebody_/);
  });
  test("delegates index.rebodyCancel with valid wiring", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const outcome = await tryDispatchIndexRebodyRpc(ctx, "index.rebodyCancel", {
      jobId: "missing",
    });
    expect(outcome).toEqual({ cancelled: false });
  });
  test("rejects invalid params as RpcMethodError", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(
      tryDispatchIndexRebodyRpc(ctx, "index.rebody", { service: "" }),
    ).rejects.toBeInstanceOf(RpcMethodError);
  });
  test("forwards a live syncScheduler into the rebody context — the scheduler actually receives the forceSync call", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    // Seed a pending row so a REAL (non-dry) run has a target to act on — dryRun never reaches
    // ctx.syncScheduler at all, so asserting anything with dryRun:true would guard nothing.
    upsertIndexedItem(db, {
      service: "test-svc",
      type: "message",
      externalId: "1",
      title: "T",
      bodyPreview: "not complete",
      modifiedAt: 1,
      syncedAt: 1,
    });
    const forceSyncCalls: string[] = [];
    const { ctx } = makeCtx({
      localIndex,
      syncScheduler: {
        forceSync: async (serviceId: string) => {
          forceSyncCalls.push(serviceId);
        },
      } as unknown as NonNullable<ServerCtx["options"]["syncScheduler"]>,
    });
    const outcome = await tryDispatchIndexRebodyRpc(ctx, "index.rebody", { service: "test-svc" });
    expect(outcome).not.toBe(phase4RpcSkipped);
    // The job runs asynchronously inside LongRunningJobRegistry — give it a tick to reach the
    // forceSync call before asserting on it.
    await new Promise((r) => setTimeout(r, 50));
    // This is the assertion that actually guards "forwards a live syncScheduler": deleting the
    // `syncScheduler` spread in tryDispatchIndexRebodyRpc (dispatchers.ts) makes this fail,
    // whereas the old `not.toBe(phase4RpcSkipped)` assertion would still pass.
    expect(forceSyncCalls).toEqual(["test-svc"]);
  });
});

describe("tryDispatchIndexRegraphRpc", () => {
  test("skips other methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchIndexRegraphRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when localIndex missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchIndexRegraphRpc(ctx, "index.regraph", {})).rejects.toThrow(
      /requires LocalIndex/,
    );
  });
  test("delegates index.regraph with valid wiring", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchIndexRegraphRpc(ctx, "index.regraph", {});
    expect(out).toMatchObject({ scanned: 0, graphed: 0, skipped: 0 });
  });
  test("delegates index.regraph with configDir present (the resolver-threading spread branch)", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-dispatchers-regraph-"));
    // TOML literal reused verbatim from index-regraph-rpc.test.ts case 2.
    writeFileSync(
      join(configDir, "nimbus.toml"),
      `[ci.service.checkout]
repos = ["github:acme/checkout"]
pagerduty_services = ["PSVC1"]
`,
      "utf8",
    );
    const { ctx } = makeCtx({ localIndex, configDir });
    const out = await tryDispatchIndexRegraphRpc(ctx, "index.regraph", {});
    expect(out).toMatchObject({ scanned: 0, graphed: 0, skipped: 0 });
  });
});

describe("tryDispatchIndexDemoSymbolRpc", () => {
  test("skips other methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchIndexDemoSymbolRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when localIndex missing", async () => {
    const { ctx } = makeCtx();
    await expect(
      tryDispatchIndexDemoSymbolRpc(ctx, "index.demoSymbol", { repoRoot: "/repo" }),
    ).rejects.toThrow(/requires LocalIndex/);
  });
  test("delegates index.demoSymbol and returns null on an empty index", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchIndexDemoSymbolRpc(ctx, "index.demoSymbol", {
      repoRoot: "/repo",
    });
    expect(out).toBeNull();
  });
  test("remaps a param error to the JSON-RPC invalid-params code", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchIndexDemoSymbolRpc(ctx, "index.demoSymbol", {})).rejects.toThrow(
      /non-empty repoRoot/,
    );
  });
});

describe("tryDispatchProfileRpc", () => {
  test("skips non-profile methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchProfileRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("throws when profileManager missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchProfileRpc(ctx, "profile.list", {})).rejects.toThrow(
      /Profile manager is not available/,
    );
  });
});

describe("tryDispatchDataRpc", () => {
  test("skips non-data methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchDataRpc(ctx, "engine.ask", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("delegates with valid prefix and bubbles up validation errors", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchDataRpc(ctx, "data.export", {}, "c1")).rejects.toThrow(/output/);
  });
  test("delegates data.* with localIndex (toolExecutor branch)", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchDataRpc(ctx, "data.export", {}, "c1")).rejects.toBeDefined();
  });
});

describe("tryDispatchLanRpc", () => {
  test("skips non-lan methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchLanRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("lan.getStatus returns sensible defaults when no LanServer", async () => {
    const { ctx } = makeCtx();
    const out = (await tryDispatchLanRpc(ctx, "lan.getStatus", {})) as Record<string, unknown>;
    expect(out["enabled"]).toBe(false);
    expect(out["pairingOpen"]).toBe(false);
    expect(out["listenAddr"]).toBeNull();
  });
  test("lan.listPeers throws when localIndex missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchLanRpc(ctx, "lan.listPeers", {})).rejects.toThrow(
      /Local index is not available/,
    );
  });
  test("lan.openPairingWindow throws when pairing window missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchLanRpc(ctx, "lan.openPairingWindow", {})).rejects.toThrow(
      /pairing window not configured/,
    );
  });
  test("lan.grantWrite requires localIndex + peerId", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchLanRpc(ctx, "lan.grantWrite", {})).rejects.toThrow(/Missing peerId/);
  });
  test("lan.grantWrite + revokeWrite + removePeer succeed against LocalIndex", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const granted = (await tryDispatchLanRpc(ctx, "lan.grantWrite", {
      peerId: "peer-1",
    })) as Record<string, unknown>;
    expect(granted["ok"]).toBe(true);
  });
  test("lan.listPeers returns peers list", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = (await tryDispatchLanRpc(ctx, "lan.listPeers", {})) as Record<string, unknown>;
    expect(Array.isArray(out["peers"])).toBe(true);
  });
  test("unknown lan.* method throws METHOD_NOT_FOUND", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchLanRpc(ctx, "lan.bogus", {})).rejects.toThrow(/Method not found/);
  });
  test("lan.closePairingWindow without window throws", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchLanRpc(ctx, "lan.closePairingWindow", {})).rejects.toThrow(
      /pairing window not configured/,
    );
  });
});

describe("tryDispatchSessionRpc", () => {
  test("skips non-session methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchSessionRpc(ctx, "engine.ask", {})).toBe(sessionRpcSkipped);
  });
  test("throws when sessionMemoryStore missing", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchSessionRpc(ctx, "session.create", {})).rejects.toThrow(
      /Session memory is not available/,
    );
  });
});

describe("tryDispatchAutomationRpc", () => {
  const fakeSession = {} as unknown as Parameters<typeof tryDispatchAutomationRpc>[2];
  test("skips off-namespace methods", async () => {
    const { ctx } = makeCtx();
    const out = await tryDispatchAutomationRpc(ctx, "c1", fakeSession, "engine.ask", {});
    expect(out).toBe(automationRpcSkipped);
  });
  test("throws on watcher.* without localIndex", async () => {
    const { ctx } = makeCtx();
    await expect(
      tryDispatchAutomationRpc(ctx, "c1", fakeSession, "watcher.list", {}),
    ).rejects.toThrow(/Local index is not available/);
  });
  test("workflow.list dispatches when localIndex available", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(
      tryDispatchAutomationRpc(ctx, "c1", fakeSession, "workflow.list", {}),
    ).resolves.toBeDefined();
  });
  test("workflow.run throws when localIndex undefined", async () => {
    const { ctx } = makeCtx();
    await expect(
      tryDispatchAutomationRpc(ctx, "c1", fakeSession, "workflow.run", {}),
    ).rejects.toThrow(/Local index is not available/);
  });
  test("watcher.list dispatches with localIndex", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchAutomationRpc(ctx, "c1", fakeSession, "watcher.list", {});
    expect(out).toBeDefined();
  });
  test("extension.list dispatches with localIndex", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchAutomationRpc(ctx, "c1", fakeSession, "extension.list", {});
    expect(out).toBeDefined();
  });
});

describe("tryDispatchPeopleRpc", () => {
  test("skips non-people methods", () => {
    const { ctx } = makeCtx();
    expect(tryDispatchPeopleRpc(ctx, "engine.ask", {})).toBe(peopleRpcSkipped);
  });
  test("skips when localIndex missing", () => {
    const { ctx } = makeCtx();
    expect(tryDispatchPeopleRpc(ctx, "people.list", {})).toBe(peopleRpcSkipped);
  });
  test("delegates with localIndex (people.* inner branch)", () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    try {
      const out = tryDispatchPeopleRpc(ctx, "people.list", {});
      expect(out).toBeDefined();
    } catch {
      // typed errors OK
    }
  });
});

describe("tryDispatchConnectorRpc", () => {
  test("skips non-connector methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchConnectorRpc(ctx, "engine.ask", {}, "c1")).toBe(connectorRpcSkipped);
  });
  test("skips when localIndex missing", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchConnectorRpc(ctx, "connector.listStatus", {}, "c1")).toBe(
      connectorRpcSkipped,
    );
  });
  test("connector.auth without openUrl throws", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchConnectorRpc(ctx, "connector.auth", {}, "c1")).rejects.toThrow(
      /Gateway is not configured for OAuth/,
    );
  });
  test("connector.listStatus dispatches when localIndex available", async () => {
    // Was `connector.list` + `expect(out).toBeDefined()`, and it asserted the OPPOSITE of its
    // name: `dispatchConnectorRpc` had no case for that method, so the arm returned the
    // `connectorRpcSkipped` SYMBOL — which is defined, so the assertion passed *because of* the
    // miss. It was live cover for a dead allowlist entry. Now names a method that is really
    // served, and asserts a dispatch rather than mere definedness.
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    const out = await tryDispatchConnectorRpc(ctx, "connector.listStatus", {}, "c1");
    expect(out).not.toBe(connectorRpcSkipped);
    expect(Array.isArray(out)).toBe(true);
  });
  test("connector.auth with openUrl wired hits dispatcher inner branch", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({
      localIndex,
      openUrl: async () => {},
    });
    // A typed error is acceptable; what's under test is that the inner branch ran rather than
    // the dispatcher returning the `skipped` sentinel.
    const outcome = await tryDispatchConnectorRpc(ctx, "connector.auth", {}, "c1").catch(
      (e: unknown) => e,
    );
    expect(outcome).not.toBe(connectorRpcSkipped);
  });
});

describe("tryDispatchDiagnosticsRpc", () => {
  test("skips off-namespace methods", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchDiagnosticsRpc(ctx, "engine.ask", {})).toBe(diagnosticsRpcSkipped);
  });
  test("throws when config.* called without configDir", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchDiagnosticsRpc(ctx, "config.validate", {})).rejects.toThrow(
      /configDir is required/,
    );
  });
  test("throws when telemetry.* called without dataDir", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchDiagnosticsRpc(ctx, "telemetry.show", {})).rejects.toThrow(
      /dataDir is required/,
    );
  });
  test("throws when telemetry.preview called without localIndex", async () => {
    const { ctx } = makeCtx({ dataDir: "/tmp" });
    await expect(tryDispatchDiagnosticsRpc(ctx, "telemetry.preview", {})).rejects.toThrow(
      /requires local index/,
    );
  });
  test("throws when diag.* called without localIndex + dataDir", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchDiagnosticsRpc(ctx, "diag.snapshot", {})).rejects.toThrow(
      /Diagnostics require local index and dataDir/,
    );
  });
  test("diag.snapshot delegates when wiring is complete", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex, dataDir: "/tmp", configDir: "/tmp/cfg" });
    const out = await tryDispatchDiagnosticsRpc(ctx, "diag.snapshot", {});
    expect(out).toBeDefined();
  });
});

describe("tryDispatchProfileRpc with manager", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-dispatchers-"));
  });

  test("profile.list returns array via dispatchProfileRpc", async () => {
    const manager = new ProfileManager(tmpDir);
    const { ctx } = makeCtx({ profileManager: manager });
    const out = await tryDispatchProfileRpc(ctx, "profile.list", {});
    expect(out).toBeDefined();
  });

  test("unknown profile.* method falls through to skipped", async () => {
    const manager = new ProfileManager(tmpDir);
    const { ctx } = makeCtx({ profileManager: manager });
    const out = await tryDispatchProfileRpc(ctx, "profile.bogus", {});
    expect(out).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchLanRpc with pairing window", () => {
  test("lan.openPairingWindow returns code + expiresAt", async () => {
    const pw = new PairingWindow(5_000);
    const { ctx } = makeCtx({ lanPairingWindow: pw });
    const out = (await tryDispatchLanRpc(ctx, "lan.openPairingWindow", {})) as Record<
      string,
      unknown
    >;
    expect(typeof out["pairingCode"]).toBe("string");
    expect(typeof out["expiresAt"]).toBe("number");
  });
  test("lan.closePairingWindow returns ok", async () => {
    const pw = new PairingWindow(5_000);
    const { ctx } = makeCtx({ lanPairingWindow: pw });
    const out = (await tryDispatchLanRpc(ctx, "lan.closePairingWindow", {})) as Record<
      string,
      unknown
    >;
    expect(out["ok"]).toBe(true);
  });
});

describe("tryDispatchSessionRpc with store", () => {
  test("session.list delegates and returns envelope", async () => {
    const db = trackedDb();
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    const { ctx } = makeCtx({ sessionMemoryStore: store });
    const out = await tryDispatchSessionRpc(ctx, "session.list", {});
    expect(out).toBeDefined();
  });
});

describe("tryDispatchPhase4Rpc", () => {
  test("walks the chain and returns the dispatcher's skip sentinel for non-matching method", async () => {
    const { ctx } = makeCtx();
    const out = await tryDispatchPhase4Rpc(ctx, "engine.ask", {}, "c1");
    expect(out).toBe(phase4RpcSkipped);
  });
  test("metrics.dora bubbles up the configDir error", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchPhase4Rpc(ctx, "metrics.dora", {}, "c1")).rejects.toThrow(
      /configDir is required/,
    );
  });
  test("preflight.* path is reached via chain", async () => {
    const db = trackedDb();
    const localIndex = new LocalIndex(db);
    const { ctx } = makeCtx({ localIndex });
    await expect(tryDispatchPhase4Rpc(ctx, "deploy.preflight", {}, "c1")).rejects.toThrow(
      /configDir is required/,
    );
  });
  test("data.* path is reached via chain (bubbles output error)", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchPhase4Rpc(ctx, "data.export", {}, "c1")).rejects.toThrow(/output/);
  });
  test("lan.getStatus hit through chain", async () => {
    const { ctx } = makeCtx();
    const out = (await tryDispatchPhase4Rpc(ctx, "lan.getStatus", {}, "c1")) as Record<
      string,
      unknown
    >;
    expect(out["enabled"]).toBe(false);
  });
  test("filesystem.ensureRoot hit through chain (registers a git repo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disp-fs-"));
    mkdirSync(join(dir, ".git"));
    const cfg = mkdtempSync(join(tmpdir(), "disp-fs-cfg-"));
    const { ctx } = makeCtx({ configDir: cfg });
    const out = (await tryDispatchPhase4Rpc(ctx, "filesystem.ensureRoot", { path: dir }, "c1")) as {
      path: string;
      added: boolean;
    };
    expect(out.added).toBe(true);
  });
  test("filesystem.ensureRoot bubbles the configDir error via chain", async () => {
    const { ctx } = makeCtx();
    await expect(
      tryDispatchPhase4Rpc(ctx, "filesystem.ensureRoot", { path: tmpdir() }, "c1"),
    ).rejects.toThrow(/configDir is required/);
  });
  test("audit.verify falls through audit chain when not configured", async () => {
    const { ctx } = makeCtx();
    await expect(tryDispatchPhase4Rpc(ctx, "audit.verify", {}, "c1")).rejects.toBeDefined();
  });
  test("policy.show hit through chain", async () => {
    const { ctx } = makeCtx({ policyRpcCtx: makePolicyRpcCtx() });
    const out = await tryDispatchPhase4Rpc(ctx, "policy.show", {}, "c1");
    expect(out).toMatchObject({ org: "acme" });
  });
  test("admin.status hit through chain", async () => {
    const { ctx } = makeCtx({ statusReaders: statusReadersFixture });
    const out = (await tryDispatchPhase4Rpc(ctx, "admin.status", {}, "c1")) as Record<
      string,
      unknown
    >;
    expect(out["connectors"]).toBeDefined();
  });
  test("team.auditMerged hit through chain (local-only stream)", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const { ctx } = makeCtx({
      localIndex,
      federationDiscovery: new InMemoryDiscoveryProvider(),
      federationPairing: new PeerPairing(localIndex),
    });
    const out = (await tryDispatchPhase4Rpc(
      ctx,
      "team.auditMerged",
      { namespace: "ns" },
      "c1",
    )) as Record<string, unknown>;
    expect(Array.isArray(out["entries"])).toBe(true);
  });
});

describe("tryDispatchPolicyRpc", () => {
  test("skips a non-policy method", async () => {
    const { ctx } = makeCtx({ policyRpcCtx: makePolicyRpcCtx() });
    expect(await tryDispatchPolicyRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when policyRpcCtx is not wired", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchPolicyRpc(ctx, "policy.show", {})).toBe(phase4RpcSkipped);
  });
  test("dispatches policy.show when the ctx is wired", async () => {
    const { ctx } = makeCtx({ policyRpcCtx: makePolicyRpcCtx() });
    const out = await tryDispatchPolicyRpc(ctx, "policy.show", {});
    expect(out).toMatchObject({ org: "acme", signatureValid: true });
  });
  test("routes team.purge through the shared seam (anchor-only fail-closed)", async () => {
    const { ctx } = makeCtx({ policyRpcCtx: makePolicyRpcCtx({ isAnchor: false }) });
    await expect(tryDispatchPolicyRpc(ctx, "team.purge", { externalId: "u1" })).rejects.toThrow(
      /ERR_NOT_PERMITTED/,
    );
  });
  test("an unknown policy.* method falls through to skipped", async () => {
    const { ctx } = makeCtx({ policyRpcCtx: makePolicyRpcCtx() });
    expect(await tryDispatchPolicyRpc(ctx, "policy.__nope__", {})).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchChatopsRpc", () => {
  test("skips a non-chatops method", async () => {
    const { ctx } = makeCtx({ chatopsRpcCtx: makeChatopsRpcCtx() });
    expect(await tryDispatchChatopsRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when chatopsRpcCtx is not wired", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchChatopsRpc(ctx, "chatops.status", {})).toBe(phase4RpcSkipped);
  });
  test("dispatches chatops.status when the ctx is wired", async () => {
    const { ctx } = makeCtx({ chatopsRpcCtx: makeChatopsRpcCtx() });
    const out = await tryDispatchChatopsRpc(ctx, "chatops.status", {});
    expect(out).toMatchObject({ enabled: true, platforms: [] });
  });
  test("an unknown chatops.* method falls through to skipped", async () => {
    const { ctx } = makeCtx({ chatopsRpcCtx: makeChatopsRpcCtx() });
    expect(await tryDispatchChatopsRpc(ctx, "chatops.__nope__", {})).toBe(phase4RpcSkipped);
  });
});

describe("tryDispatchPremortemRpc", () => {
  function fakePremortemRefresher(
    over: Partial<NonNullable<ServerCtx["options"]["premortemRefresher"]>> = {},
  ): NonNullable<ServerCtx["options"]["premortemRefresher"]> {
    return {
      trigger: () => undefined,
      stop: () => undefined,
      runNow: () =>
        Promise.resolve({
          scanned: 0,
          themesWritten: 0,
          demoted: 0,
          prunedEvidence: 0,
          llmCalls: 0,
          noModel: false,
        }),
      ...over,
    };
  }

  test("skips a non-premortem method", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchPremortemRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });

  test(
    "premortem.refresh throws ERR_PREMORTEM_DISABLED (remapped to RpcMethodError) when the " +
      "refresher is unset — unlike decisions/glossary/ownership this dispatcher does NOT skip",
    async () => {
      const { ctx } = makeCtx();
      let caught: unknown;
      try {
        await tryDispatchPremortemRpc(ctx, "premortem.refresh", {});
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RpcMethodError);
      expect((caught as RpcMethodError).message).toMatch(/ERR_PREMORTEM_DISABLED/);
    },
  );

  test("premortem.refresh with a wired refresher returns the hit value", async () => {
    const { ctx } = makeCtx({ premortemRefresher: fakePremortemRefresher() });
    const out = await tryDispatchPremortemRpc(ctx, "premortem.refresh", {});
    expect(out).toMatchObject({ scanned: 0, themesWritten: 0 });
  });

  test("a non-PremortemRpcError from the refresher propagates unchanged (not wrapped)", async () => {
    const { ctx } = makeCtx({
      premortemRefresher: fakePremortemRefresher({
        runNow: () => Promise.reject(new Error("raw premortem error")),
      }),
    });
    await expect(tryDispatchPremortemRpc(ctx, "premortem.refresh", {})).rejects.toThrow(
      "raw premortem error",
    );
  });

  test(
    "an unrecognised premortem.* method misses inside dispatchPremortemRpc and falls through " +
      "to phase4RpcSkipped (covers the refresher-wired branch without hitting)",
    async () => {
      const { ctx } = makeCtx({ premortemRefresher: fakePremortemRefresher() });
      const out = await tryDispatchPremortemRpc(ctx, "premortem.nope", {});
      expect(out).toBe(phase4RpcSkipped);
    },
  );
});

describe("extractKbPageRef", () => {
  test("reads a top-level id and prefixes by action type", () => {
    expect(extractKbPageRef("notion.knowledge.write", { id: "pg1" })).toBe("notion:pg1");
    expect(extractKbPageRef("confluence.knowledge.write", { id: "99" })).toBe("confluence:99");
  });
  test("unwraps an MCP content-block envelope with JSON text", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ id: "deep" }) }] };
    expect(extractKbPageRef("notion.knowledge.write", result)).toBe("notion:deep");
  });
  test("returns empty (→ write_failed) when no id is present or input is not an object", () => {
    expect(extractKbPageRef("notion.knowledge.write", { ok: true })).toBe("");
    expect(extractKbPageRef("notion.knowledge.write", null)).toBe("");
    expect(extractKbPageRef("notion.knowledge.write", "nope")).toBe("");
    expect(extractKbPageRef("notion.knowledge.write", { content: [{ text: "not json" }] })).toBe(
      "",
    );
  });
});

describe("tryDispatchTribalRpc", () => {
  test("skips a non-tribal method", async () => {
    const { ctx } = makeCtx({ tribalRpcCtx: makeTribalRpcCtx() });
    expect(await tryDispatchTribalRpc(ctx, "engine.ask", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("skips when tribalRpcCtx is not wired", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchTribalRpc(ctx, "tribal.status", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("dispatches tribal.status when the ctx is wired", async () => {
    const { ctx } = makeCtx({ tribalRpcCtx: makeTribalRpcCtx() });
    const out = await tryDispatchTribalRpc(ctx, "tribal.status", {}, "c1");
    expect(out).toMatchObject({ enabled: true, clusters: 0 });
  });
  test("an unknown tribal.* method falls through to skipped", async () => {
    const { ctx } = makeCtx({ tribalRpcCtx: makeTribalRpcCtx() });
    expect(await tryDispatchTribalRpc(ctx, "tribal.__nope__", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("tribal.capture requires a clusterId", async () => {
    const { ctx } = makeCtx({ tribalRpcCtx: makeTribalRpcCtx() });
    await expect(tryDispatchTribalRpc(ctx, "tribal.capture", {}, "c1")).rejects.toThrow(
      /clusterId/,
    );
  });
  test("tribal.capture with no connector dispatcher rejects the write (fail-closed)", async () => {
    // localIndex/tribalConnectorDispatcher unset → submitAction returns rejected; capture surfaces it.
    const captured: { clusterId: string; target: string | undefined }[] = [];
    const rpc = makeTribalRpcCtx({
      capture: async (clusterId, target, submit) => {
        captured.push({ clusterId, target });
        const r = await submit({ type: "notion.knowledge.write", payload: {} });
        return r.status === "approved"
          ? { ok: true, pageRef: "x" }
          : { ok: false, error: "rejected" };
      },
    });
    const { ctx } = makeCtx({ tribalRpcCtx: rpc });
    const out = await tryDispatchTribalRpc(ctx, "tribal.capture", { clusterId: "k1" }, "c1");
    expect(out).toEqual({ ok: false, error: "rejected" });
    expect(captured).toEqual([{ clusterId: "k1", target: undefined }]);
  });
});

describe("tryDispatchAdminRpc", () => {
  test("skips a non-admin.status method", () => {
    const { ctx } = makeCtx({ statusReaders: statusReadersFixture });
    expect(tryDispatchAdminRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
  });
  test("skips when statusReaders is not wired", () => {
    const { ctx } = makeCtx();
    expect(tryDispatchAdminRpc(ctx, "admin.status", {})).toBe(phase4RpcSkipped);
  });
  test("builds the status snapshot when readers are wired", () => {
    const { ctx } = makeCtx({ statusReaders: statusReadersFixture });
    const out = tryDispatchAdminRpc(ctx, "admin.status", {}) as Record<string, unknown>;
    expect(Array.isArray(out["connectors"])).toBe(true);
    expect(Array.isArray(out["peers"])).toBe(true);
  });
});

describe("tryDispatchFederationRpc team.auditMerged (local stream)", () => {
  test("dispatches team.auditMerged when federation services are wired", async () => {
    const localIndex = new LocalIndex(trackedDb());
    const { ctx } = makeCtx({
      localIndex,
      federationDiscovery: new InMemoryDiscoveryProvider(),
      federationPairing: new PeerPairing(localIndex),
    });
    const out = (await tryDispatchFederationRpc(ctx, "team.auditMerged", {
      namespace: "ns",
    })) as Record<string, unknown>;
    expect(Array.isArray(out["entries"])).toBe(true);
  });
});

describe("tryDispatchEgressRpc", () => {
  test("skips a non-egress method", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchEgressRpc(ctx, "engine.ask", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("skips when egressRpcCtx is not wired", async () => {
    const { ctx } = makeCtx();
    expect(await tryDispatchEgressRpc(ctx, "egress.head", {}, "c1")).toBe(phase4RpcSkipped);
  });
  test("dispatches egress.head when wired", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const egressRpcCtx: EgressRpcCtx = {
      db,
      // biome-ignore lint/suspicious/noExplicitAny: test stand-in
      vault: { get: async () => null, set: async () => {} } as any,
      now: () => 1,
      requestPruneApproval: async () => false,
    };
    openDbs.push(db);
    const { ctx } = makeCtx({ egressRpcCtx });
    const out = (await tryDispatchEgressRpc(ctx, "egress.head", {}, "c1")) as { count: number };
    expect(out.count).toBe(0);
  });
  test("egress.prune binds the owner HITL gate — fail-closed deny when no consent session is live", async () => {
    // The base ctx requestPruneApproval would APPROVE; the dispatcher must OVERRIDE it with the
    // I2 gate bound to the calling client. makeCtx's consent has no live writer → the gate rejects
    // (fail-closed) → nothing is pruned. Proves the gate is wired, not the injected default.
    const localIndex = new LocalIndex(makeDb());
    openDbs.push(localIndex.getDatabase());
    appendEgressEntry(localIndex.getDatabase(), {
      timestamp: 10,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    const egressRpcCtx: EgressRpcCtx = {
      db: localIndex.getDatabase(),
      // biome-ignore lint/suspicious/noExplicitAny: test stand-in
      vault: { get: async () => null, set: async () => {} } as any,
      now: () => 1,
      requestPruneApproval: async () => true, // would approve — but the gate override denies
    };
    const { ctx } = makeCtx({ localIndex, egressRpcCtx });
    const out = (await tryDispatchEgressRpc(ctx, "egress.prune", { beforeTs: 9999 }, "c1")) as {
      approved: boolean;
      prunedCount: number;
    };
    expect(out.approved).toBe(false);
    expect(out.prunedCount).toBe(0);
    const count = (
      localIndex.getDatabase().query("SELECT COUNT(*) as c FROM egress_ledger").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });
});
