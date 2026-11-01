/**
 * The consent prompts state the sandbox's live reach, and the runner has to GET there: a wiring gap
 * in the dispatcher would leave it undefined and print "not known here" on every machine. These
 * go through the real `tryDispatch*` functions and the real executor gate, and read the prompt the
 * owner would be shown.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { planNothing } from "../../../test/helpers/empty-update-plan.ts";
import { AutoUpdateCache } from "../../extensions/auto-update-cache.ts";
import type { AvailableUpdate } from "../../extensions/auto-update-types.ts";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import { buildTestRegistry } from "../../extensions/registry/__fixtures__/build-test-registry.ts";
import { insertRegistry } from "../../extensions/registry/registry-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { dispatchAutomationRpc } from "../automation-rpc.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ServerCtx } from "./context.ts";
import {
  tryDispatchAutomationRpc,
  tryDispatchConnectorRpc,
  tryDispatchRegistryRpc,
} from "./dispatchers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function runner(opts: {
  platform: "linux" | "darwin" | "win32";
  fullyActive: boolean;
  scope?: "per_port" | "all_or_nothing";
  reason: string | null;
}): NonNullable<ServerCtx["options"]["sandboxRunner"]> {
  const { scope } = opts;
  const r: ReachRunner = {
    platform: opts.platform,
    isFullyActive: () => opts.fullyActive,
    degradedReason: () => opts.reason,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    canConfine: () => null,
  };
  // Only the reach slice is read; `spawn` is never called on the prompt path.
  return r as unknown as NonNullable<ServerCtx["options"]["sandboxRunner"]>;
}

/** A ctx whose consent channel records each prompt and declines it (nothing is stored). */
function ctxWith(overrides: Partial<ServerCtx["options"]>, prompts: string[]): ServerCtx {
  const consentImpl: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(() => (n) => {
    const p = n.params as { requestId: string; prompt: string };
    prompts.push(p.prompt);
    queueMicrotask(() =>
      consentImpl.handleRespond("c1", { requestId: p.requestId, approved: false }),
    );
  });
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
}

function mkIndex(): { db: Database; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => db.close());
  return { db, localIndex: new LocalIndex(db) };
}

describe("the runner reaches the consent prompts through the real dispatch", () => {
  test("the run approval receives the runner through the real dispatch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-run-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { db, localIndex } = mkIndex();
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "reach.run",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network: ["a.com"] },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const extensionsDir = join(root, "data", "extensions");
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir,
      ownerGate: async () => true,
    });
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir,
        connectorMesh: { userMcpProtectedRoots: () => [join(root, "data")] } as never,
        sandboxRunner: runner({ platform: "linux", fullyActive: false, reason: "helper missing" }),
      },
      prompts,
    );
    await tryDispatchAutomationRpc(ctx, "c1", {} as never, "extension.approveRun", {
      id: "reach.run",
    }).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("the whole network");
    expect(prompts[0]).not.toContain("not known here");
  });

  test("the add --mcp prompt receives the runner through the real dispatch", async () => {
    const { localIndex } = mkIndex();
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        syncScheduler: { register: () => {} } as never,
        connectorMesh: {
          ensureUserMcpRunning: async () => {},
          userMcpProtectedRoots: () => [],
          ensureUserMcpSandboxClean: async () => {},
          userMcpSandboxLeaf: () => "",
        } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
      },
      prompts,
    );
    await tryDispatchConnectorRpc(
      ctx,
      "connector.addMcp",
      { serviceId: "mcp_reach", argv: [process.execPath], netHosts: ["a.com"] },
      "c1",
    ).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Windows cannot limit");
    expect(prompts[0]).not.toContain("not known here");
  });

  /** An extension source declaring network and write paths, installed through the real handler. */
  function stageSource(root: string, name: string, network: string[], write: string[]): string {
    const src = join(root, name);
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "reach.inst",
        version: "1.0.0",
        entry: "dist/index.js",
        permissions: { network, filesystem: { read: [], write } },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    return src;
  }

  test("the install approval states reach and a file outcome through the real dispatch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-inst-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { localIndex } = mkIndex();
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const src = stageSource(root, "src", ["a.com"], [dataDir]);
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir: join(dataDir, "extensions"),
        connectorMesh: { userMcpProtectedRoots: () => [dataDir] } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
      },
      prompts,
    );
    await tryDispatchAutomationRpc(ctx, "c1", {} as never, "extension.install", {
      sourcePath: src,
    }).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Windows cannot limit this to a.com");
    expect(prompts[0]).toContain("can't run here");
    expect(prompts[0]).not.toContain("not known here");
    expect(prompts[0]).not.toContain("not checked here");
  });

  test("the update approval states reach and a file outcome through the real dispatch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-upd-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { db, localIndex } = mkIndex();
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const extensionsDir = join(dataDir, "extensions");
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: stageSource(root, "src", ["a.com"], []) },
      db,
      extensionsDir,
      ownerGate: async () => true,
    });
    const cache = new AutoUpdateCache();
    const update: AvailableUpdate = {
      id: "reach.inst",
      displayName: "Reach",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "verified",
      manifestHash: "d".repeat(64),
      signatureB64: "AA==",
      entryHash: "e".repeat(64),
      packageSha256: "f".repeat(64),
      packageSizeBytes: 1,
      sourceRegistry: "main",
      rootFingerprint: "c".repeat(32),
      packagePath: "p.tgz",
      permissionDiff: {
        network: { added: ["b.com"], removed: [] },
        filesystem: { read: { added: [], removed: [] }, write: { added: [dataDir], removed: [] } },
      },
      verificationStatus: "verified",
      detectedAt: 1,
    };
    cache.upsert(update);
    const prompts: string[] = [];
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir,
        connectorMesh: { userMcpProtectedRoots: () => [dataDir] } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
        extensionsAutoUpdate: {
          cache,
          forcePoll: async () => {},
          planUpdate: planNothing,
          performUpgrade: async () => ({ orphanedDependencies: [] }),
          performDowngrade: async () => ({ orphanedDependencies: [] }),
          appendAudit: async () => {},
          getInstalledVersion: async () => "1.0.0",
          hasPrevVersion: async () => false,
        },
      },
      prompts,
    );
    await tryDispatchAutomationRpc(ctx, "c1", {} as never, "extension.update", {
      id: "reach.inst",
      toVersion: "1.1.0",
    }).catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("a.com, b.com");
    expect(prompts[0]).toContain("can't run here");
    expect(prompts[0]).not.toContain("not known here");
    expect(prompts[0]).not.toContain("not checked here");
  });

  test("extension.info states reach and the own-files outcome through the real dispatch", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-info-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { db, localIndex } = mkIndex();
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const extensionsDir = join(dataDir, "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: stageSource(root, "src", ["a.com"], [extensionsDir]) },
      db,
      extensionsDir,
      ownerGate: async () => true,
    });
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir,
        connectorMesh: {
          userMcpProtectedRoots: () => [],
          isExtensionRunning: () => false,
        } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
      },
      [],
    );
    const out = (await tryDispatchAutomationRpc(ctx, "c1", {} as never, "extension.info", {
      id: "reach.inst",
    })) as { extension: { access?: { networkReach: string; fileAccess: string } } };
    expect(out.extension.access?.networkReach).toContain("Windows cannot limit this to a.com");
    expect(out.extension.access?.fileAccess).toContain("overlaps the extension's own files");
    expect(out.extension.access?.networkReach).not.toContain("not known here");
    expect(out.extension.access?.fileAccess).not.toContain("not checked here");
  });

  test("registry.info states reach through the real dispatch, and a clean remote path claims no pass", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-reach-rinfo-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { db, localIndex } = mkIndex();
    const dataDir = join(root, "data");
    const readable = join(root, "readable");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(readable, { recursive: true });
    const regDir = join(root, "reg");
    const built = await buildTestRegistry(regDir, {
      id: "acme.tool",
      versions: [{ version: "1.0.0" }],
      manifestExtra: {
        permissions: { network: ["a.com"], filesystem: { read: [readable], write: [] } },
      },
    });
    insertRegistry(db, {
      name: "main",
      url: regDir,
      rootKey: built.rootKey,
      rootFingerprint: publisherKeyFingerprint(built.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-18T12:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const ctx = ctxWith(
      {
        localIndex,
        extensionsDir: join(dataDir, "extensions"),
        connectorMesh: { userMcpProtectedRoots: () => [dataDir] } as never,
        sandboxRunner: runner({
          platform: "win32",
          fullyActive: true,
          scope: "all_or_nothing",
          reason: null,
        }),
        registryFetch: {
          fetchFn: () => Promise.reject(new Error("unexpected network")),
          enforceAirGap: () => false,
          now: () => Date.parse("2026-10-18T12:00:00Z"),
          production: false,
          builtin: null,
        },
      },
      [],
    );
    const out = (await tryDispatchRegistryRpc(ctx, "c1", "registry.info", {
      id: "acme.tool",
      registry: "main",
    })) as {
      versions: Array<{
        access?: {
          networkReach: string;
          fileAccess: string;
          canRunHere: boolean | null;
          checked: boolean;
        };
      }>;
    };
    const access = out.versions[0]?.access;
    expect(access?.networkReach).toContain("Windows cannot limit this to a.com");
    expect(access?.fileAccess).toContain(readable);
    expect(access?.fileAccess).not.toContain("not checked here");
    // The own-files check needs an install path a remote entry has not got: no pass is claimed.
    expect(access?.canRunHere).toBe(true);
    expect(access?.fileAccess).not.toMatch(/can run|own files/i);
  });
});
