/**
 * dispatchers-rethrow-and-miss.test.ts
 *
 * The two arms of every `tryDispatchXRpc` wrapper that `dispatchers-error-remap.test.ts` (the
 * domain-error remap) does not reach:
 *
 *  1. THE RETHROW. `catch (e) { if (e instanceof XRpcError) throw new RpcMethodError(...); throw e; }`
 *     — an error that is NOT the subsystem's own must surface as itself. Remapping an internal
 *     fault (a dead database, a broken refresher) to the subsystem's invalid-params code would tell
 *     the caller they sent bad params when the gateway is the one that is broken. Each case asserts
 *     IDENTITY (`toBe(boom)`), so a remap — which would build a new `RpcMethodError` — fails it.
 *
 *  2. THE MISS. A method inside the namespace that the inner handler map does not serve returns
 *     the wrapper's skip sentinel (or, for the namespaces that own their prefix outright, a
 *     -32601), and must do so WITHOUT touching the subsystem. Where that dependency is
 *     observable — the prune approval, the glossary refresher's status, the config dir a
 *     filesystem write would land in — the case also proves it was never used; for the rest
 *     (a database handle a miss never queries) the sentinel's IDENTITY is the whole claim.
 *
 * Rules: no `mock.module`; no `any`; fakes are typed through `unknown`; real SQLite where a real
 * index is needed.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import { ProfileManager } from "../../config/profiles.ts";
import { appendEgressEntry } from "../../egress/egress-ledger.ts";
import { AutoUpdateCache } from "../../extensions/auto-update-cache.ts";
import type { AvailableUpdate } from "../../extensions/auto-update-types.ts";
import { InMemoryDiscoveryProvider } from "../../federation/discovery.ts";
import { PeerPairing } from "../../federation/peer-pairing.ts";
import type { GlossaryRefresher } from "../../glossary/glossary-refresh.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import type { EgressRpcCtx } from "../egress-rpc.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import {
  connectorRpcSkipped,
  metricsRpcSkipped,
  peopleRpcSkipped,
  phase4RpcSkipped,
  preflightRpcSkipped,
  type ServerCtx,
} from "./context.ts";
import {
  tryDispatchAgentsRpc,
  tryDispatchAutomationRpc,
  tryDispatchConnectorRpc,
  tryDispatchDemoRpc,
  tryDispatchEgressRpc,
  tryDispatchFederationRpc,
  tryDispatchFilesystemRpc,
  tryDispatchGlossaryRpc,
  tryDispatchHitlRpc,
  tryDispatchLocalityRpc,
  tryDispatchMetricsRpc,
  tryDispatchPeopleRpc,
  tryDispatchPhase4Rpc,
  tryDispatchPreflightRpc,
  tryDispatchProfileRpc,
  tryDispatchReindexRpc,
  tryDispatchSecurityRpc,
  tryDispatchTeamVaultRpc,
  tryDispatchTourRpc,
} from "./dispatchers.ts";
import type { CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";

const openDbs: Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshIndex(): LocalIndex {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  openDbs.push(db);
  return new LocalIndex(db);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(overrides: Partial<CreateIpcServerOptions> = {}): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

/** Whatever a dispatch threw or rejected with; a dispatch that returns fails the test. */
async function thrownBy(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the dispatch to throw");
}

/**
 * A LocalIndex whose database is gone. Every wrapper below reads `getDatabase()` (or `rawDb`)
 * INSIDE its try block, so the fault reaches the catch the test is about.
 */
function deadIndex(boom: Error): LocalIndex {
  return {
    getDatabase(): Database {
      throw boom;
    },
    get rawDb(): Database {
      throw boom;
    },
  } as unknown as LocalIndex;
}

// ---------------------------------------------------------------------------
// 1. Non-domain errors propagate as themselves
// ---------------------------------------------------------------------------

describe("a non-domain error propagates unchanged — never remapped to an RPC code", () => {
  type Case = readonly [
    label: string,
    overrides: (boom: Error) => Partial<CreateIpcServerOptions>,
    run: (ctx: ServerCtx) => unknown,
  ];

  const CASES: readonly Case[] = [
    [
      "agents.* (AgentsRpcError remap is the only remap)",
      (boom) => ({ localIndex: deadIndex(boom) }),
      (ctx) => tryDispatchAgentsRpc(ctx, "agents.why", { topic: "x" }, "c1"),
    ],
    [
      "security.scanCancel",
      (boom) => ({ localIndex: deadIndex(boom) }),
      (ctx) => tryDispatchSecurityRpc(ctx, "security.scanCancel", { jobId: "j" }),
    ],
    [
      "metrics.dora",
      (boom) => ({ localIndex: deadIndex(boom), configDir: tempDir("disp-rethrow-m-") }),
      (ctx) => tryDispatchMetricsRpc(ctx, "metrics.dora", { service: "s" }),
    ],
    [
      "deploy.preflight",
      (boom) => ({ localIndex: deadIndex(boom), configDir: tempDir("disp-rethrow-p-") }),
      (ctx) => tryDispatchPreflightRpc(ctx, "deploy.preflight", { service: "s", target_ref: "m" }),
    ],
    [
      "connector.reindex (metadata_only touches the raw database)",
      (boom) => ({ localIndex: deadIndex(boom) }),
      (ctx) =>
        tryDispatchReindexRpc(
          ctx,
          "connector.reindex",
          { service: "github", depth: "metadata_only" },
          "c1",
        ),
    ],
    [
      "tour.plan",
      (boom) => ({ localIndex: deadIndex(boom) }),
      (ctx) => tryDispatchTourRpc(ctx, "tour.plan", {}),
    ],
    [
      "locality.report",
      (boom) => ({ localIndex: deadIndex(boom) }),
      (ctx) => tryDispatchLocalityRpc(ctx, "locality.report", {}),
    ],
    [
      "federation.* (FederationRpcError remap is the only remap)",
      (boom) => {
        const index = deadIndex(boom);
        return {
          localIndex: index,
          federationDiscovery: new InMemoryDiscoveryProvider(),
          federationPairing: new PeerPairing(index),
        };
      },
      (ctx) => tryDispatchFederationRpc(ctx, "federation.peers", {}),
    ],
    [
      "demo.seed on a demo-rooted gateway",
      (boom) => ({
        demo: true,
        localIndex: deadIndex(boom),
        configDir: tempDir("disp-rethrow-dc-"),
        dataDir: tempDir("disp-rethrow-dd-"),
      }),
      (ctx) => tryDispatchDemoRpc(ctx, "demo.seed", {}),
    ],
  ];

  test.each(CASES)("%s", async (_label, overrides, run) => {
    const boom = new Error("database is gone");
    const thrown = await thrownBy(() => run(makeCtx(overrides(boom))));
    expect(thrown).toBe(boom);
    expect(thrown).not.toBeInstanceOf(RpcMethodError);
  });

  test("glossary.refresh: a refresher that faults is not reported as a glossary error", async () => {
    const boom = new Error("refresher state unreadable");
    const refresher: GlossaryRefresher = {
      trigger: () => {},
      runNow: () => Promise.reject(new Error("must not be reached")),
      status: () => {
        throw boom;
      },
      stop: () => {},
    } as unknown as GlossaryRefresher;
    const thrown = await thrownBy(() =>
      tryDispatchGlossaryRpc(makeCtx({ glossaryRefresher: refresher }), "glossary.refresh", {}),
    );
    expect(thrown).toBe(boom);
  });

  test("profile.switch: the manager's own refusal is a plain Error, not a ProfileRpcError", async () => {
    const manager = new ProfileManager(tempDir("disp-rethrow-profile-"));
    const thrown = await thrownBy(() =>
      tryDispatchProfileRpc(makeCtx({ profileManager: manager }), "profile.switch", {
        name: "ghost",
      }),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RpcMethodError);
    expect((thrown as Error).message).toBe("Profile not found: ghost");
  });

  test("filesystem.ensureRoot: a config dir that cannot be written surfaces the fs error itself", async () => {
    // A real git checkout, so every validation in the handler passes and the failure is the
    // registered-roots WRITE into a config dir that does not exist (ENOENT on every OS).
    const repo = tempDir("disp-rethrow-repo-");
    mkdirSync(join(repo, ".git"));
    const missingConfigDir = join(tempDir("disp-rethrow-cfg-"), "not-created");
    const thrown = await thrownBy(() =>
      tryDispatchFilesystemRpc(makeCtx({ configDir: missingConfigDir }), "filesystem.ensureRoot", {
        path: repo,
      }),
    );
    expect(thrown).not.toBeInstanceOf(RpcMethodError);
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("extension.update: an auto-update dependency that faults is not reported as -32602", async () => {
    const boom = new Error("installed-version lookup failed");
    const cached: AvailableUpdate = {
      id: "ext.demo",
      displayName: "Demo",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "verified",
      manifestHash: "m".repeat(64),
      signatureB64: "",
      entryHash: "e".repeat(64),
      tarballUrl: "https://registry.invalid/ext.demo-1.1.0.tgz",
      permissionDiff: {
        network: { added: [], removed: [] },
        filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
      },
      verificationStatus: "verified",
      detectedAt: 1,
    };
    const cache = new AutoUpdateCache();
    cache.upsert(cached);
    const ctx = makeCtx({
      localIndex: freshIndex(),
      extensionsAutoUpdate: {
        cache,
        forcePoll: async () => {},
        performUpgrade: async () => {},
        performDowngrade: async () => {},
        appendAudit: async () => {},
        getInstalledVersion: () => Promise.reject(boom),
        hasPrevVersion: async () => false,
      },
    });
    const session = {} as Parameters<typeof tryDispatchAutomationRpc>[2];
    const thrown = await thrownBy(() =>
      tryDispatchAutomationRpc(ctx, "c1", session, "extension.update", {
        id: "ext.demo",
        toVersion: "1.1.0",
      }),
    );
    expect(thrown).toBe(boom);
  });

  test("egress.prune: a faulting approval broker surfaces as itself, and nothing is pruned", async () => {
    // Driven through the phase-4 chain, so the routing match is part of the claim. No local index
    // is wired: the dispatcher therefore keeps the assembled broker rather than re-binding prune to
    // the caller's consent channel, and it is that broker's fault which reaches the catch.
    const ledger = freshIndex().getDatabase();
    for (const timestamp of [10, 20]) {
      appendEgressEntry(ledger, {
        timestamp,
        sourceType: "task",
        sourceId: "s",
        destination: "email",
        method: "email.send",
        payloadSummary: "{}",
        hitlStatus: "approved",
        resultStatus: "authorized",
      });
    }
    const boom = new Error("consent broker unavailable");
    const asked: number[] = [];
    const egressRpcCtx: EgressRpcCtx = {
      db: ledger,
      vault: createMockVault(),
      now: () => 100,
      requestPruneApproval: (beforeTs) => {
        asked.push(beforeTs);
        return Promise.reject(boom);
      },
    };
    const thrown = await thrownBy(() =>
      tryDispatchPhase4Rpc(makeCtx({ egressRpcCtx }), "egress.prune", { beforeTs: 15 }, "c1"),
    );
    expect(thrown).toBe(boom);
    expect(thrown).not.toBeInstanceOf(RpcMethodError);
    expect(asked).toEqual([15]);
    // Fail-closed: an approval that never arrived prunes nothing — both rows are still there.
    expect(
      ledger
        .query<{ ts: number }, []>("SELECT timestamp AS ts FROM egress_ledger ORDER BY id")
        .all(),
    ).toEqual([{ ts: 10 }, { ts: 20 }]);
  });
});

// ---------------------------------------------------------------------------
// Domain-error remaps not reached elsewhere
// ---------------------------------------------------------------------------

describe("a subsystem's own error keeps its code through the wrapper", () => {
  test("filesystem.ensureRoot without a path is FilesystemRpcError -32602, not -32603", async () => {
    // The configDir guard sits OUTSIDE the try, so the pre-existing `no roots configured` case
    // never reached this catch: only a call that passes the guard can.
    const thrown = await thrownBy(() =>
      tryDispatchFilesystemRpc(
        makeCtx({ configDir: tempDir("disp-remap-fs-") }),
        "filesystem.ensureRoot",
        {},
      ),
    );
    expect(thrown).toBeInstanceOf(RpcMethodError);
    expect((thrown as RpcMethodError).rpcCode).toBe(-32602);
    expect((thrown as RpcMethodError).message).toBe("params.path is required");
  });

  test("egress.list with a negative limit is EgressRpcError -32602", async () => {
    const index = freshIndex();
    const egressRpcCtx: EgressRpcCtx = {
      db: index.getDatabase(),
      vault: createMockVault(),
      now: () => 1,
      requestPruneApproval: async () => false,
    };
    const thrown = await thrownBy(() =>
      tryDispatchEgressRpc(makeCtx({ egressRpcCtx }), "egress.list", { limit: -1 }, "c1"),
    );
    expect(thrown).toBeInstanceOf(RpcMethodError);
    expect((thrown as RpcMethodError).rpcCode).toBe(-32602);
    expect((thrown as RpcMethodError).message).toBe("egress: limit must be a non-negative integer");
  });
});

// ---------------------------------------------------------------------------
// 2. A verb the handler map does not serve is declined without touching the subsystem
// ---------------------------------------------------------------------------

describe("an unserved verb inside a namespace is declined, not answered", () => {
  test("teamvault.* and hitl.* fall through to the skip sentinel", async () => {
    const ctx = makeCtx({ localIndex: freshIndex() });
    expect(await tryDispatchTeamVaultRpc(ctx, "teamvault.notAVerb", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchHitlRpc(ctx, "hitl.notAVerb", {})).toBe(phase4RpcSkipped);
  });

  test("metrics.* and deploy.* fall through to their OWN sentinels", async () => {
    const ctx = makeCtx({ localIndex: freshIndex(), configDir: tempDir("disp-miss-md-") });
    // Distinct unique symbols, so a group function can never confuse one for phase4RpcSkipped.
    expect(await tryDispatchMetricsRpc(ctx, "metrics.notAVerb", {})).toBe(metricsRpcSkipped);
    expect(await tryDispatchPreflightRpc(ctx, "deploy.notAVerb", {})).toBe(preflightRpcSkipped);
  });

  test("demo.* on a demo-rooted gateway declines an unknown verb", async () => {
    const ctx = makeCtx({
      demo: true,
      localIndex: freshIndex(),
      configDir: tempDir("disp-miss-dc-"),
      dataDir: tempDir("disp-miss-dd-"),
    });
    expect(await tryDispatchDemoRpc(ctx, "demo.notAVerb", {})).toBe(phase4RpcSkipped);
  });

  test("filesystem.* declines an unknown verb and writes no registered-roots file", async () => {
    const configDir = tempDir("disp-miss-fs-");
    expect(
      await tryDispatchFilesystemRpc(makeCtx({ configDir }), "filesystem.notAVerb", {
        path: configDir,
      }),
    ).toBe(phase4RpcSkipped);
    // The config dir starts empty (mkdtemp); a miss that wrote anything there would show up here.
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("egress.* declines an unknown verb without asking for prune approval", async () => {
    const index = freshIndex();
    let approvals = 0;
    const egressRpcCtx: EgressRpcCtx = {
      db: index.getDatabase(),
      vault: createMockVault(),
      now: () => 1,
      requestPruneApproval: async () => {
        approvals++;
        return true;
      },
    };
    expect(await tryDispatchEgressRpc(makeCtx({ egressRpcCtx }), "egress.notAVerb", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    expect(approvals).toBe(0);
  });

  test("glossary.* declines an unknown verb without reading the refresher's status", async () => {
    let statusReads = 0;
    const refresher = {
      trigger: () => {},
      runNow: () => Promise.reject(new Error("must not be reached")),
      status: () => {
        statusReads++;
        return "idle";
      },
      stop: () => {},
    } as unknown as GlossaryRefresher;
    expect(
      await tryDispatchGlossaryRpc(
        makeCtx({ glossaryRefresher: refresher }),
        "glossary.notAVerb",
        {},
      ),
    ).toBe(phase4RpcSkipped);
    expect(statusReads).toBe(0);
  });

  test("people.* and connector.* fall through to their own sentinels", async () => {
    const ctx = makeCtx({ localIndex: freshIndex() });
    expect(tryDispatchPeopleRpc(ctx, "people.notAVerb", {})).toBe(peopleRpcSkipped);
    expect(await tryDispatchConnectorRpc(ctx, "connector.notAVerb", {}, "c1")).toBe(
      connectorRpcSkipped,
    );
  });

  test("watcher.* / workflow.* / extension.* own their prefix: an unknown verb is -32601", async () => {
    // Unlike the sentinel namespaces above, `dispatchExtensionAutomationRpc` is the LAST stop for
    // these prefixes — `server.ts` returns its value directly — so a miss must be the method-not-
    // found error itself, naming the method the caller sent.
    // All three prefixes, not one: each is its own `startsWith` clause in the routing condition, so
    // dropping any ONE of them sends that namespace's misses to `automationRpcSkipped` instead.
    const ctx = makeCtx({ localIndex: freshIndex() });
    const session = {} as Parameters<typeof tryDispatchAutomationRpc>[2];
    for (const method of ["watcher.notAVerb", "workflow.notAVerb", "extension.notAVerb"]) {
      const thrown = await thrownBy(() => tryDispatchAutomationRpc(ctx, "c1", session, method, {}));
      expect(thrown).toBeInstanceOf(RpcMethodError);
      expect({ method, code: (thrown as RpcMethodError).rpcCode }).toEqual({
        method,
        code: -32601,
      });
      expect((thrown as RpcMethodError).message).toBe(`Method not found: ${method}`);
    }
  });
});
