import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
} from "../automation/watcher-engine.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  loadNimbusAutomationFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusLlmPartialFromPath,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
  resolveNimbusTomlForProfile,
} from "../config/nimbus-toml.ts";
import { loadNimbusSessionFromPath } from "../config/session-toml.ts";
import { applyLlmTomlOverrides, Config } from "../config.ts";
import { defaultSyncIntervalMsForService } from "../connectors/connector-catalog.ts";
import {
  migrateToPerServiceOAuthKeys,
  readConnectorSecret,
} from "../connectors/connector-vault.ts";
import { createFilesystemV2Syncable } from "../connectors/filesystem-v2-sync.ts";
import { createLazyConnectorMesh, type LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { createObsidianSyncable } from "../connectors/obsidian-sync.ts";
import {
  DEFAULT_OPENAPI_CONFIG,
  type OpenapiConfig,
  parseOpenapiToml,
} from "../connectors/openapi-indexer-config.ts";
import { createOpenapiIndexerSyncable } from "../connectors/openapi-indexer-sync.ts";
import { listUserMcpConnectors } from "../connectors/user-mcp-store.ts";
import { startLatencyFlushScheduler } from "../db/latency-ring-buffer.ts";
import { dbRun } from "../db/write.ts";
import { createEmbeddingRuntime } from "../embedding/create-embedding-runtime.ts";
import { verifyExtensionsBestEffort } from "../extensions/verify-extensions.ts";
import {
  LocalIndex,
  type LocalIndexOptions,
  type SemanticSearchDeps,
} from "../index/local-index.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { resumePendingRemovals } from "../ipc/connector-rpc-handlers/index.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import { createIpcServer } from "../ipc/index.ts";
import { startMetricsServer } from "../ipc/metrics-server.ts";
import { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import type { SyncContext } from "../sync/types.ts";
import { startTelemetryFlushScheduler } from "../telemetry/flush-scheduler.ts";
import { createUpdaterFromConfig } from "../updater/factory.ts";
import { redactUrlUserinfo } from "../updater/updater.ts";
import { createNimbusVault } from "../vault/factory.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { GATEWAY_VERSION } from "../version.ts";
import { AnomalyDetectorStub } from "../watcher/anomaly-detector.ts";
import { registerConnectorMeshSyncables } from "./assemble-sync-registrations.ts";
import { openUrlInDefaultBrowser } from "./browser.ts";
import { ensurePlatformDirectories } from "./dirs.ts";
import { processEnvGet } from "./env-access.ts";
import { createGatewayPinoLogger } from "./gateway-log-file.ts";
import type { PlatformPaths } from "./paths.ts";
import { registerUserMcpSyncablesFromDatabase } from "./register-user-mcp-sync.ts";
import { createSandboxRunner } from "./sandbox/sandbox-runner.ts";
import type { AutostartManager, NotificationService, PlatformServices } from "./types.ts";

function createStubAutostart(): AutostartManager {
  return {
    async isEnabled(): Promise<boolean> {
      return false;
    },
    async enable(): Promise<void> {},
    async disable(): Promise<void> {},
  };
}

function createStubNotifications(): NotificationService {
  return {
    async show(_title: string, _body: string): Promise<void> {},
  };
}

function loadOpenapiConfig(configDir: string): OpenapiConfig {
  const path = join(configDir, "nimbus.toml");
  if (!existsSync(path)) {
    return DEFAULT_OPENAPI_CONFIG;
  }
  try {
    return parseOpenapiToml(readFileSync(path, "utf8"));
  } catch {
    return DEFAULT_OPENAPI_CONFIG;
  }
}

type EmbeddingRuntime = Awaited<ReturnType<typeof createEmbeddingRuntime>>;

function openGatewaySqlite(dataDir: string, sidecarStops: Array<() => void>): Database {
  const dbPath = join(dataDir, "nimbus.db");
  const db = new Database(dbPath);
  LocalIndex.ensureSchema(db, { backupDir: join(dataDir, "backups"), dbPath });
  const stopLatency = startLatencyFlushScheduler(db);
  sidecarStops.push(() => stopLatency.stop());
  dbRun(db, "PRAGMA busy_timeout = 8000");
  return db;
}

async function createLocalIndexWithEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  vault: NimbusVault,
  syncLogger: Logger,
  activeTomlPath: string,
): Promise<{
  localIndex: LocalIndex;
  scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  rt: EmbeddingRuntime;
}> {
  const tomlEmbedding = loadNimbusEmbeddingFromPath(activeTomlPath);
  process.stdout.write("[gateway] starting embedding runtime\n");
  const embeddingRuntime = await createEmbeddingRuntime(
    db,
    paths,
    syncLogger,
    tomlEmbedding,
    Config.embeddingsEnabled,
    vault,
  );
  const rt = embeddingRuntime;
  let scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  let semanticSearch: SemanticSearchDeps | undefined;
  if (rt) {
    scheduleItemEmbedding = rt.scheduleItemEmbedding.bind(rt);
    semanticSearch = {
      model: rt.getEmbeddingModel(),
      embedQuery: (text: string) => rt.embedQuery(text),
      embedQueryDual: (text: string) => rt.embedQueryDual(text),
    };
  }
  const localIndexOpts: LocalIndexOptions = {};
  if (scheduleItemEmbedding !== undefined) {
    localIndexOpts.scheduleItemEmbedding = scheduleItemEmbedding;
  }
  if (semanticSearch !== undefined) {
    localIndexOpts.semanticSearch = semanticSearch;
  }
  const hasEmbeddingIndexOpts = scheduleItemEmbedding !== undefined || semanticSearch !== undefined;
  const localIndex = hasEmbeddingIndexOpts
    ? new LocalIndex(db, localIndexOpts)
    : new LocalIndex(db);
  return { localIndex, scheduleItemEmbedding, rt };
}

async function ensureGithubCircleCiSchedulerCompanions(
  localIndex: LocalIndex,
  vault: NimbusVault,
): Promise<void> {
  const pat = await readConnectorSecret(vault, "github", "pat");
  localIndex.ensureGithubActionsSchedulerCompanionIfNeeded({
    githubPatPresent: pat !== null && pat !== "",
    now: Date.now(),
    intervalMs: defaultSyncIntervalMsForService("github_actions"),
  });
  const cciTok = await readConnectorSecret(vault, "circleci", "api_token");
  localIndex.ensureCircleciSchedulerCompanionIfNeeded({
    circleciTokenPresent: cciTok !== null && cciTok !== "",
    now: Date.now(),
    intervalMs: defaultSyncIntervalMsForService("circleci"),
  });
}

/**
 * Default vector dimension when the embedding runtime is unavailable. Matches
 * `vec_items_384`. The store still records literal turns (vec_rowid=0
 * sentinel) so multi-turn TUI memory works without embeddings.
 */
const DEFAULT_EMBEDDING_DIMS = 384;

function maybeAttachSessionMemoryStore(
  db: Database,
  rt: EmbeddingRuntime,
  sessionToml: ReturnType<typeof loadNimbusSessionFromPath>,
  sidecarStops: Array<() => void>,
): SessionMemoryStore | undefined {
  // BUG-005 follow-up: keep going even when the embedding runtime failed
  // to start. The store still works for literal-turn replay (the path the
  // multi-turn TUI memory fix relies on); semantic recall just stays empty
  // until embeddings come back.
  if (readIndexedUserVersion(db) < 10) {
    return undefined;
  }
  const sessionMemoryStore =
    rt == null
      ? new SessionMemoryStore({
          db,
          dims: DEFAULT_EMBEDDING_DIMS,
          embedText: async () => null,
        })
      : new SessionMemoryStore({
          db,
          dims: rt.getEmbeddingDims(),
          embedText: (t) => rt.embedQuery(t),
        });
  const ttlMs = Math.max(1, sessionToml.memoryTtlHours) * 3_600_000;
  const timer = setInterval(() => {
    try {
      sessionMemoryStore.pruneExpired(ttlMs, Date.now());
    } catch {
      /* ignore */
    }
  }, 3_600_000);
  sidecarStops.push(() => clearInterval(timer));
  return sessionMemoryStore;
}

async function createSchedulerWithMesh(
  paths: PlatformPaths,
  vault: NimbusVault,
  db: Database,
  syncContext: SyncContext,
  localIndex: LocalIndex,
  notifications: NotificationService,
  syncLogger: Logger,
): Promise<{ syncScheduler: SyncScheduler; connectorMesh: LazyConnectorMesh }> {
  const syncAnomaly = new AnomalyDetectorStub({
    windowSize: 64,
    onNotify: (e) => {
      syncLogger.warn(
        { seriesId: e.seriesId, value: e.value, score: e.score, atMs: e.atMs },
        "sync telemetry anomaly (stub — no automated remediation)",
      );
    },
  });

  const automation = loadNimbusAutomationFromConfigDir(paths.configDir);
  const watcherOpts = { graphConditionsEnabled: automation.graphConditions };

  const syncScheduler = new SyncScheduler(syncContext, undefined, {
    notify: async (title, body) => {
      await notifications.show(title, body);
    },
    onConnectorSyncSuccess: (serviceId, result, durationMs) => {
      const at = Date.now();
      syncAnomaly.recordSample(`sync:duration_ms:${serviceId}`, durationMs, at);
      syncAnomaly.recordSample(`sync:items_upserted:${serviceId}`, result.itemsUpserted, at);
      evaluateWatchersAfterSync(db, serviceId, at, (t, b) => notifications.show(t, b), watcherOpts);
    },
  });
  const fsV2Roots = loadNimbusFilesystemRootsFromConfigDir(paths.configDir);
  if (fsV2Roots.length > 0) {
    localIndex.ensureConnectorSchedulerRegistration("filesystem", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createFilesystemV2Syncable({ roots: fsV2Roots }));
    // Wave A PR 1 — gateway-side OpenAPI / AsyncAPI spec indexer.
    localIndex.ensureConnectorSchedulerRegistration("openapi", 10 * 60 * 1000, Date.now());
    syncScheduler.register(
      createOpenapiIndexerSyncable({
        roots: fsV2Roots,
        config: loadOpenapiConfig(paths.configDir),
      }),
    );
    // Wave A PR 2 — gateway-side Obsidian vault indexer.
    localIndex.ensureConnectorSchedulerRegistration("obsidian", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createObsidianSyncable({ roots: fsV2Roots }));
  }
  const connectorMesh = await createLazyConnectorMesh(paths, vault, {
    listUserMcpConnectors: () => listUserMcpConnectors(db),
    // S8-F9 — pass db + logger so args_json failures surface as
    // persistent_error in connector health and a warn log line.
    healthDb: db,
    // Phase 5 T6 PR 2 — same db handle used for tool_call_log audit writes
    // from listTools' wrapped execute path. Two distinct field names so
    // the two concerns stay readable.
    auditDb: db,
    logger: syncLogger,
    // Wave A PR 2 — thread the absolute filesystem-root paths so the
    // obsidian MCP child can discover `.obsidian/` markers itself.
    obsidianVaultPaths: fsV2Roots.map((r) => r.path),
  });
  const pagerdutyCfg = loadNimbusPagerdutyFromConfigDir(paths.configDir);
  registerConnectorMeshSyncables(syncScheduler, connectorMesh, {
    pagerdutyMaxPagesPerSync: pagerdutyCfg.maxPagesPerSync,
  });
  registerUserMcpSyncablesFromDatabase(db, syncScheduler, connectorMesh);
  syncScheduler.start();
  evaluateWatchersStartupCatchUp(db, Date.now(), (t, b) => notifications.show(t, b), watcherOpts);
  return { syncScheduler, connectorMesh };
}

function collectSidecarsFromEnv(
  db: Database,
  paths: PlatformPaths,
  sidecarStops: Array<() => void>,
): void {
  const httpPortRaw = processEnvGet("NIMBUS_HTTP_PORT");
  if (httpPortRaw !== undefined && httpPortRaw.trim() !== "") {
    const hp = Number.parseInt(httpPortRaw.trim(), 10);
    if (Number.isFinite(hp) && hp > 0) {
      sidecarStops.push(startReadOnlyHttpServer(join(paths.dataDir, "nimbus.db"), hp).stop);
    }
  }
  const metricsPortRaw = processEnvGet("NIMBUS_METRICS_PORT");
  if (metricsPortRaw !== undefined && metricsPortRaw.trim() !== "") {
    const mp = Number.parseInt(metricsPortRaw.trim(), 10);
    if (Number.isFinite(mp) && mp > 0) {
      sidecarStops.push(startMetricsServer(() => db, mp).stop);
    }
  }
}

export async function assemblePlatformServices(paths: PlatformPaths): Promise<PlatformServices> {
  const assemblyStartedMs = performance.now();
  const sidecarStops: Array<() => void> = [];
  await ensurePlatformDirectories(paths);
  const vault = await createNimbusVault(paths);
  // T2 PR 1 — construct the per-platform sandbox runner singleton. The
  // wrapper subprocess (sandbox-wrapper.ts) constructs its own runner per
  // spawn; this handle is the gateway-process view used by `diag.snapshot`
  // and the startup posture banner so the same probe result (e.g. Linux
  // helper present + CAP_NET_ADMIN) is observable from both surfaces.
  const sandboxRunner = await createSandboxRunner();
  const db = openGatewaySqlite(paths.dataDir, sidecarStops);
  const notifications = createStubNotifications();
  const syncLogger: Logger = createGatewayPinoLogger(paths.logDir);
  const rateLimiter = new ProviderRateLimiter();
  const activeTomlPath = resolveNimbusTomlForProfile(paths.configDir);
  const sessionToml = loadNimbusSessionFromPath(activeTomlPath);
  const llmTomlPartial = loadNimbusLlmPartialFromPath(activeTomlPath);
  const llmOverrides: { agentModel?: string; classifierModel?: string } = {};
  if (llmTomlPartial.remoteModel !== undefined) {
    llmOverrides.agentModel = llmTomlPartial.remoteModel;
  }
  if (llmTomlPartial.classifierModel !== undefined) {
    llmOverrides.classifierModel = llmTomlPartial.classifierModel;
  }
  applyLlmTomlOverrides(llmOverrides);

  const { localIndex, scheduleItemEmbedding, rt } = await createLocalIndexWithEmbeddingRuntime(
    db,
    paths,
    vault,
    syncLogger,
    activeTomlPath,
  );
  await ensureGithubCircleCiSchedulerCompanions(localIndex, vault);

  // Copy shared provider OAuth keys to per-service keys for any service that
  // hasn't been re-authenticated since the migration landed.
  await migrateToPerServiceOAuthKeys(vault);

  // Complete any connector removals that were interrupted by a crash. Idempotent.
  await resumePendingRemovals(vault, localIndex);

  const syncBase: SyncContext = { vault, db, logger: syncLogger, rateLimiter };
  const syncContext: SyncContext = scheduleItemEmbedding
    ? { ...syncBase, scheduleItemEmbedding }
    : syncBase;

  const sessionMemoryStore = maybeAttachSessionMemoryStore(db, rt, sessionToml, sidecarStops);

  const { syncScheduler, connectorMesh } = await createSchedulerWithMesh(
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
  );

  // S7-F10 — pass the mesh so a hash mismatch can terminate the running
  // child. Must run AFTER mesh creation; the mesh handle did not exist
  // pre-G7 so this call was placed before mesh creation in the original
  // wiring.
  await verifyExtensionsBestEffort(db, syncLogger, connectorMesh, { vault });
  rt?.startBackgroundJobs();
  const ipcOpts: Parameters<typeof createIpcServer>[0] = {
    listenPath: paths.socketPath,
    vault,
    version: GATEWAY_VERSION,
    localIndex,
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    extensionsDir: paths.extensionsDir,
    openUrl: openUrlInDefaultBrowser,
    syncScheduler,
    connectorMesh,
    sandboxRunner,
  };
  if (sessionMemoryStore !== undefined) {
    ipcOpts.sessionMemoryStore = sessionMemoryStore;
  }
  if (rt) {
    ipcOpts.getEmbeddingStatus = () => ({
      embeddingBackfill: rt.getBackfillProgress(),
    });
  }

  collectSidecarsFromEnv(db, paths, sidecarStops);

  const ipc = createIpcServer(ipcOpts);

  // Updater wiring (S6-F1). Uses GATEWAY_VERSION (Task 1) so future bumps
  // don't skew across the three consumers. Skips wiring when [updater].enabled
  // is false or when the host arch isn't in the supported release set; the
  // dispatcher returns ERR_UPDATER_NOT_CONFIGURED for `updater.*` calls in
  // that case, which is the correct signal.
  const updaterCfg = loadNimbusUpdaterFromConfigDir(paths.configDir);
  const updater = createUpdaterFromConfig({
    updaterCfg,
    currentVersion: GATEWAY_VERSION,
    emit: (name, payload) => ipc.broadcast(name, payload ?? {}),
    logger: syncLogger,
  });
  if (updater !== undefined) {
    ipc.setUpdater(updater);
    if (updaterCfg.checkOnStartup) {
      // Non-blocking. `Updater.checkNow()` redacts userinfo into private
      // `lastError` but re-throws the un-redacted original — logging
      // `err.message` directly would leak credentials embedded in the
      // configured manifest URL into the gateway log file. The
      // `redactUrlUserinfo` import above is mandatory for this call site.
      void updater
        .checkNow()
        .catch((err: unknown) =>
          syncLogger.warn(
            { err: redactUrlUserinfo(err instanceof Error ? err.message : String(err)) },
            "updater startup check failed",
          ),
        );
    }
  }

  const gatewayAssemblyMs = Math.max(0, Math.round(performance.now() - assemblyStartedMs));
  const telemetryStop = startTelemetryFlushScheduler({
    dataDir: paths.dataDir,
    activeTomlPath,
    getDatabase: () => db,
    gatewayVersion: GATEWAY_VERSION,
    logger: syncLogger,
    coldStartMs: gatewayAssemblyMs,
  });
  sidecarStops.push(telemetryStop.stop);

  return {
    vault,
    ipc,
    paths,
    localIndex,
    connectorMesh,
    syncScheduler,
    autostart: createStubAutostart(),
    notifications,
    openUrl: openUrlInDefaultBrowser,
    sandboxRunner,
    ...(sessionMemoryStore === undefined ? {} : { sessionMemoryStore }),
    disposeSidecars(): void {
      for (const s of sidecarStops) {
        try {
          s();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
