/**
 * A real-parts harness for `platform/assemble/scheduler-mesh.ts` `createSchedulerWithMesh`: a
 * migrated in-memory index, an in-memory Vault, a recording notification service and a temp config
 * directory, handed to the REAL function. Nothing in the function under test is faked; only what it
 * is given is.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { LocalIndex } from "../../src/index/local-index.ts";
import { openMigratedMemoryDb } from "../../src/index/migrated-db-template.ts";
import { setGatewayEventBroadcast } from "../../src/ipc/gateway-events.ts";
import { createSchedulerWithMesh } from "../../src/platform/assemble/scheduler-mesh.ts";
import type { SchedulerWithMesh } from "../../src/platform/assemble/scheduler-mesh-opts.ts";
import type { PlatformPaths } from "../../src/platform/paths.ts";
import type { NotificationService } from "../../src/platform/types.ts";
import { ProviderRateLimiter } from "../../src/sync/rate-limiter.ts";
import { unboundSyncCapabilities } from "../../src/sync/sync-capabilities.ts";
import type { SyncRuntimeContext } from "../../src/sync/types.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";
import { makeInMemoryVault } from "./in-memory-vault.ts";

export type SchedulerHarness = {
  readonly root: string;
  readonly paths: PlatformPaths;
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly localIndex: LocalIndex;
  readonly logger: Logger;
  readonly toasts: Array<{ title: string; body: string }>;
  readonly events: Array<{ method: string; params: Record<string, unknown> }>;
  readonly out: SchedulerWithMesh;
  readonly cleanup: () => Promise<void>;
};

export type HarnessOptions = {
  readonly demo?: boolean;
  /** `nimbus.toml` text; none written when absent. */
  readonly toml?: string;
  readonly isConnectorAllowed?: (serviceId: string) => boolean;
  readonly extensionRuntimeEnabled?: boolean;
  readonly withSpawnGate?: boolean;
  readonly withUserMcpCanConfine?: boolean;
  /** Supplied when a test must observe boot-time log lines. */
  readonly logger?: Logger;
  /** Runs after the dirs exist and before the function under test is called. */
  readonly seed?: (db: Database, paths: PlatformPaths) => void;
};

export async function buildSchedulerHarness(o: HarnessOptions = {}): Promise<SchedulerHarness> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-sched-mesh-"));
  const paths: PlatformPaths = {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath: join(root, "g.sock"),
    extensionsDir: join(root, "extensions"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
    ...(o.demo === true ? { demo: true } : {}),
  };
  for (const d of [paths.configDir, paths.dataDir, paths.sandboxDir]) {
    mkdirSync(d, { recursive: true });
  }
  if (o.toml !== undefined) writeFileSync(join(paths.configDir, "nimbus.toml"), o.toml);
  const db = openMigratedMemoryDb();
  o.seed?.(db, paths);
  const vault = makeInMemoryVault();
  const localIndex = new LocalIndex(db);
  const logger = o.logger ?? pino({ level: "silent" });
  const toasts: SchedulerHarness["toasts"] = [];
  const notifications: NotificationService = {
    show: (title, body) => {
      toasts.push({ title, body });
      return Promise.resolve();
    },
  };
  const events: SchedulerHarness["events"] = [];
  setGatewayEventBroadcast((method, params) => {
    const p = params as { kind?: string; payload?: Record<string, unknown> };
    events.push({
      method: method === "gateway.event" && p.kind !== undefined ? p.kind : method,
      params: p.payload ?? (params as Record<string, unknown>),
    });
  });
  const syncContext: SyncRuntimeContext = {
    ...unboundSyncCapabilities(),
    vault,
    db,
    logger,
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
    sandboxCwd: paths.sandboxDir,
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: () => Promise.resolve([]),
  };
  const out = await createSchedulerWithMesh({
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger: logger,
    isConnectorAllowed: o.isConnectorAllowed ?? (() => true),
    ...(o.withSpawnGate === true ? { filesystemSpawnGate: Promise.resolve() } : {}),
    ...(o.withUserMcpCanConfine === true ? { userMcpCanConfine: () => null } : {}),
    extensionRuntimeEnabled: o.extensionRuntimeEnabled ?? false,
    extensionSpawnGate: Promise.resolve(),
    continuityTable: [],
    extensionObservationDir: join(root, "extension-observations"),
  });
  const cleanup = async (): Promise<void> => {
    setGatewayEventBroadcast(undefined);
    await out.syncScheduler.stop();
    for (const r of [
      out.glossaryRefresher,
      out.decisionsRefresher,
      out.ownershipRefresher,
      out.premortemRefresher,
      out.oncallPush,
    ]) {
      r?.stop();
    }
    await out.connectorMesh.disconnect();
    try {
      db.close();
    } catch {
      /* a test closed it on purpose */
    }
    rmSync(root, { recursive: true, force: true });
  };
  return { root, paths, db, vault, localIndex, logger, toasts, events, out, cleanup };
}
