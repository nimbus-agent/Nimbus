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
  loadNimbusAuditFromConfigDir,
  loadNimbusAutomationFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusLlmPartialFromPath,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusScimFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
  resolveNimbusTomlForProfile,
} from "../config/nimbus-toml.ts";
import { loadNimbusSessionFromPath } from "../config/session-toml.ts";
import { applyLlmTomlOverrides, Config } from "../config.ts";
import {
  CONNECTOR_SERVICE_IDS,
  defaultSyncIntervalMsForService,
} from "../connectors/connector-catalog.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
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
import { appendAuditEntry } from "../db/audit-chain.ts";
import { startLatencyFlushScheduler } from "../db/latency-ring-buffer.ts";
import {
  effectiveRetentionDays,
  startToolCallLogRetention,
} from "../db/tool-call-log-retention.ts";
import { dbRun } from "../db/write.ts";
import { createEmbeddingRuntime } from "../embedding/create-embedding-runtime.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { buildDelegatedRequestRemote } from "../engine/delegated-request-remote.ts";
import { DelegationStore } from "../engine/delegation-store.ts";
import type { ExecutorDelegationDep } from "../engine/executor.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import { type AutoUpdateRuntime, createAutoUpdateRuntime } from "../extensions/auto-update-init.ts";
import { verifyExtensionsBestEffort } from "../extensions/verify-extensions.ts";
import { federationConsent } from "../federation/consent-broker.ts";
import { loadOrCreateFederationIdentity } from "../federation/federation-identity.ts";
import { buildFederationRuntime } from "../federation/federation-runtime.ts";
import { buildFederationLanServer } from "../federation/federation-server.ts";
import { buildIdentityBoot } from "../identity/identity-boot.ts";
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
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { LlmRegistry } from "../llm/registry.ts";
import { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { partitionByAllowlist } from "../policy/connector-allowlist.ts";
import { buildPolicyGate, type PolicyGate } from "../policy/policy-gate.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import { resolveQuorumRule } from "../policy/quorum-override.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import type { SyncContext } from "../sync/types.ts";
import { invokeTeamTool } from "../teamvault/team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "../teamvault/team-tool-spawn.ts";
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

const DEFAULT_EMBEDDING_DIMS = 384;

function maybeAttachSessionMemoryStore(
  db: Database,
  rt: EmbeddingRuntime,
  sessionToml: ReturnType<typeof loadNimbusSessionFromPath>,
  sidecarStops: Array<() => void>,
): SessionMemoryStore | undefined {
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
  isConnectorAllowed: (serviceId: string) => boolean,
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
    localIndex.ensureConnectorSchedulerRegistration("openapi", 10 * 60 * 1000, Date.now());
    syncScheduler.register(
      createOpenapiIndexerSyncable({
        roots: fsV2Roots,
        config: loadOpenapiConfig(paths.configDir),
      }),
    );
    localIndex.ensureConnectorSchedulerRegistration("obsidian", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createObsidianSyncable({ roots: fsV2Roots }));
  }
  const connectorMesh = await createLazyConnectorMesh(paths, vault, {
    listUserMcpConnectors: () => listUserMcpConnectors(db),
    healthDb: db,
    auditDb: db,
    logger: syncLogger,
    obsidianVaultPaths: fsV2Roots.map((r) => r.path),
    isConnectorAllowed,
  });
  const pagerdutyCfg = loadNimbusPagerdutyFromConfigDir(paths.configDir);
  // Policy connector-allowlist (I22): a blocked connector must never SYNC, not just be hidden from
  // tool exposure. Filter at the single mesh/user-MCP registration seam so blocked syncables are
  // never registered with the scheduler. fs/openapi/obsidian syncables are not policy connectors and
  // are registered directly on the real scheduler above.
  const policyFilteredRegistrar: Pick<SyncScheduler, "register"> = {
    register: (connector, intervalOverrideMs) => {
      if (!isConnectorAllowed(connector.serviceId)) {
        return;
      }
      syncScheduler.register(connector, intervalOverrideMs);
    },
  };
  registerConnectorMeshSyncables(policyFilteredRegistrar, connectorMesh, {
    pagerdutyMaxPagesPerSync: pagerdutyCfg.maxPagesPerSync,
  });
  registerUserMcpSyncablesFromDatabase(db, policyFilteredRegistrar, connectorMesh);
  syncScheduler.start();
  evaluateWatchersStartupCatchUp(db, Date.now(), (t, b) => notifications.show(t, b), watcherOpts);
  return { syncScheduler, connectorMesh };
}

function collectSidecarsFromEnv(
  db: Database,
  paths: PlatformPaths,
  sidecarStops: Array<() => void>,
  httpOpts: { resolveScimToken?: () => Promise<string> } = {},
): void {
  const httpPortRaw = processEnvGet("NIMBUS_HTTP_PORT");
  if (httpPortRaw !== undefined && httpPortRaw.trim() !== "") {
    const hp = Number.parseInt(httpPortRaw.trim(), 10);
    if (Number.isFinite(hp) && hp > 0) {
      sidecarStops.push(
        startReadOnlyHttpServer(join(paths.dataDir, "nimbus.db"), hp, {
          configDir: paths.configDir,
          ...(httpOpts.resolveScimToken === undefined
            ? {}
            : { resolveScimToken: httpOpts.resolveScimToken }),
        }).stop,
      );
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

function asBroadcastParams(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/** Boot the federation LAN server + discovery into ipcOpts when enabled. Returns true if booted
 *  (so the caller can wire the consent broadcast after the IPC server exists). */
async function bootFederationIntoIpcOpts(
  federationCfg: ReturnType<typeof loadNimbusFederationFromConfigDir>,
  paths: PlatformPaths,
  vault: NimbusVault,
  db: Database,
  localIndex: LocalIndex,
  ipcOpts: Parameters<typeof createIpcServer>[0],
  sidecarStops: Array<() => void>,
  policyGate: PolicyGate,
): Promise<ExecutorDelegationDep | undefined> {
  if (!federationCfg.enabled) return undefined;
  const identity = await loadOrCreateFederationIdentity(vault);
  const federationRuntime = buildFederationRuntime(federationCfg, localIndex, identity);
  if (federationRuntime === undefined) return undefined;
  void federationRuntime.discovery.start();
  sidecarStops.push(() => void federationRuntime.discovery.stop());
  ipcOpts.federationDiscovery = federationRuntime.discovery;
  ipcOpts.federationPairing = federationRuntime.pairing;
  ipcOpts.federationConsentTimeoutSeconds = federationRuntime.consentTimeoutSeconds;
  ipcOpts.federationIdentity = identity;

  const lanCfg = loadNimbusLanFromConfigDir(paths.configDir);
  // Team Vault (Slice 2): the anchor's invoke backing. quorumFor resolves the authoritative quorum
  // rule via EnforcedPolicy (Task 9) — max(local [hitl.quorum] baseline, org policy); ungoverned it
  // returns the local baseline verbatim, governed it tightens. runTool resolves the team secret
  // (teamvault.<entry>.*) and runs the tool in an ephemeral team-credentialed connector
  // (I19 — secret stays in the subprocess env, never returned).
  const teamVault = {
    quorumFor: (toolId: string) => resolveQuorumRule(policyGate.enforced(), toolId),
    runTool: (input: { entry: string; service: string; toolId: string; args: unknown }) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: paths.dataDir,
          requiredSecretKeysFor: (service: string) =>
            CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          spawnAndCall: spawnTeamToolAndCall,
        },
        input,
      ),
  };
  ipcOpts.teamVault = teamVault;
  // Delegated HITL (Slice 2, I20). As a DELEGATE, this gateway answers an owner's routed approval by
  // prompting its own local clients via the delegated-approval broker (CLI/UI `team approve` →
  // federation.approvalRespond resolves it). As an OWNER, the executor gate routes a HITL action to
  // an active delegate over the wire (delegationDep, threaded into run-ask).
  const delegationStore = new DelegationStore(db);
  const delegationDep: ExecutorDelegationDep = {
    store: delegationStore,
    isOperatorValid: () => true,
    requestRemote: buildDelegatedRequestRemote({
      store: delegationStore,
      index: localIndex,
      selfIdentity: identity,
    }),
  };
  const built = buildFederationLanServer({
    db,
    index: localIndex,
    identity,
    lan: {
      bind: lanCfg.bind,
      port: lanCfg.port,
      pairingWindowSeconds: lanCfg.pairingWindowSeconds,
      maxFailedAttempts: lanCfg.maxFailedAttempts,
      lockoutSeconds: lanCfg.lockoutSeconds,
    },
    consentTimeoutMs: federationRuntime.consentTimeoutSeconds * 1000,
    notify: () => {},
    discovery: federationRuntime.discovery,
    pairing: federationRuntime.pairing,
    teamVault,
    delegateApproval: async ({ actionType }) => {
      const r = await delegatedApprovalBroker.request(
        { prompt: `Approve delegated action: ${actionType}?` },
        federationRuntime.consentTimeoutSeconds * 1000,
      );
      return r.kind === "answered" ? r.approved : false;
    },
  });
  // Register the stop callback BEFORE start() so a throw from start() can't leak the server.
  sidecarStops.push(() => void built.lanServer.stop());
  await built.lanServer.start();
  const addr = built.lanServer.listenAddr();
  if (addr !== undefined && federationCfg.mdnsEnabled) {
    void federationRuntime.discovery.advertise(`nimbus-${GATEWAY_VERSION}`, addr.port);
  }
  ipcOpts.lanServer = built.lanServer;
  ipcOpts.lanPairingWindow = built.pairingWindow;
  return delegationDep;
}

export async function assemblePlatformServices(paths: PlatformPaths): Promise<PlatformServices> {
  const assemblyStartedMs = performance.now();
  const sidecarStops: Array<() => void> = [];
  await ensurePlatformDirectories(paths);
  const vault = await createNimbusVault(paths);
  const sandboxRunner = await createSandboxRunner();
  const db = openGatewaySqlite(paths.dataDir, sidecarStops);
  const notifications = createStubNotifications();
  const syncLogger: Logger = createGatewayPinoLogger(paths.logDir);
  const rateLimiter = new ProviderRateLimiter();
  const activeTomlPath = resolveNimbusTomlForProfile(paths.configDir);
  const sessionToml = loadNimbusSessionFromPath(activeTomlPath);
  const llmToml = loadNimbusLlmFromPath(activeTomlPath);
  const llmTomlPartial = loadNimbusLlmPartialFromPath(activeTomlPath);
  const llmOverrides: { agentModel?: string; classifierModel?: string } = {};
  if (llmTomlPartial.remoteModel !== undefined) {
    llmOverrides.agentModel = llmTomlPartial.remoteModel;
  }
  if (llmTomlPartial.classifierModel !== undefined) {
    llmOverrides.classifierModel = llmTomlPartial.classifierModel;
  }
  applyLlmTomlOverrides(llmOverrides);
  const llmRegistry = new LlmRegistry({
    db,
    config: {
      preferLocal: llmToml.preferLocal,
      remoteModel: llmToml.remoteModel,
      localModel: llmToml.localModel,
      minReasoningParams: llmToml.minReasoningParams,
      enforceAirGap: llmToml.enforceAirGap,
    },
  });
  llmRegistry.addProvider(new OllamaProvider("http://127.0.0.1:11434", llmToml.localModel));
  const llamacppBaseUrl = llmToml.llamacppServerPath.trim();
  llmRegistry.addProvider(
    new LlamaCppProvider(llamacppBaseUrl === "" ? undefined : llamacppBaseUrl, llmToml.localModel),
  );

  const { localIndex, scheduleItemEmbedding, rt } = await createLocalIndexWithEmbeddingRuntime(
    db,
    paths,
    vault,
    syncLogger,
    activeTomlPath,
  );
  await ensureGithubCircleCiSchedulerCompanions(localIndex, vault);

  await migrateToPerServiceOAuthKeys(vault);

  await resumePendingRemovals(vault, localIndex);

  const syncBase: SyncContext = { vault, db, logger: syncLogger, rateLimiter };
  const syncContext: SyncContext = scheduleItemEmbedding
    ? { ...syncBase, scheduleItemEmbedding }
    : syncBase;

  const sessionMemoryStore = maybeAttachSessionMemoryStore(db, rt, sessionToml, sidecarStops);

  const auditCfg = loadNimbusAuditFromConfigDir(paths.configDir);

  // Org policy (I22): the gate rehydrates last-valid from the store (ungoverned when none). The
  // baseline is the local floor policy can only TIGHTEN. `policyGate` is the shared instance reused
  // by the retention floor (Task 8), quorum (Task 9), and the audit shipper (Task 19) — keep it in
  // scope even though Part C of this task only consumes `enforced().connectorAllow`. Built BEFORE
  // the retention sidecar so the latter can honor `enforced().retentionDays` (the monotonic floor).
  const policyStore = new PolicyStore(db);
  const policyGate = buildPolicyGate(db, policyStore, {
    retentionDays: auditCfg.toolCallLogRetentionDays,
    hitlRequired: new Set<string>(),
    quorum: loadNimbusQuorumFromConfigDir(paths.configDir),
  });
  // Connector allowlist enforcement: audit + block connectors not permitted by policy.
  const enforcedConnectorAllow = policyGate.enforced().connectorAllow;
  const { blocked: blockedConnectors } = partitionByAllowlist(
    [...CONNECTOR_SERVICE_IDS],
    enforcedConnectorAllow,
  );
  const blockedAt = Date.now();
  for (const id of blockedConnectors) {
    appendAuditEntry(db, {
      actionType: "policy.connector.blocked",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ connector: id }),
      timestamp: blockedAt,
    });
  }
  const isConnectorAllowed = (serviceId: string): boolean => {
    const allow = policyGate.enforced().connectorAllow;
    return allow === undefined || allow.includes(serviceId);
  };

  // Retention floor (Task 8): effective retention = max(local config, policy floor); policy can only
  // LENGTHEN retention. Started after the gate so it can read `enforced().retentionDays`.
  const toolCallLogRetention = startToolCallLogRetention(db, {
    retentionDays: effectiveRetentionDays(
      auditCfg.toolCallLogRetentionDays,
      policyGate.enforced().retentionDays,
    ),
  });
  sidecarStops.push(() => toolCallLogRetention.stop());

  const { syncScheduler, connectorMesh } = await createSchedulerWithMesh(
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
    isConnectorAllowed,
  );

  await verifyExtensionsBestEffort(db, syncLogger, connectorMesh, { vault });

  let autoUpdateRuntime: AutoUpdateRuntime | undefined;
  const autoUpdateRegistryUrl = (process.env["NIMBUS_EXTENSIONS_REGISTRY_URL"] ?? "").trim();
  const autoUpdateDisabled = process.env["NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE"] === "1";
  if (autoUpdateRegistryUrl !== "" && !autoUpdateDisabled) {
    const extensionsCfg = loadNimbusExtensionsFromConfigDir(paths.configDir);
    autoUpdateRuntime = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: paths.extensionsDir,
      dataDir: paths.dataDir,
      registryBaseUrl: autoUpdateRegistryUrl,
      intervalHours: extensionsCfg.updateCheckIntervalHours,
      enforceAirGap: false,
      stopExtensionClient: (id) => connectorMesh.stopExtensionClient(id),
    });
    void autoUpdateRuntime.daemon.start();
    sidecarStops.push(() => {
      autoUpdateRuntime?.abortController.abort();
      void autoUpdateRuntime?.daemon.stop();
    });
  }

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
    llmRegistry,
    ...(autoUpdateRuntime === undefined ? {} : { extensionsAutoUpdate: autoUpdateRuntime.deps }),
    ...(autoUpdateRuntime === undefined
      ? {}
      : {
          extensionsAutoUpdateDiag: {
            cachedUpdatesCount: (): number => autoUpdateRuntime?.deps.cache.list().length ?? 0,
            intervalHours: loadNimbusExtensionsFromConfigDir(paths.configDir)
              .updateCheckIntervalHours,
            airGapBlocked: autoUpdateDisabled,
          },
        }),
  };
  if (sessionMemoryStore !== undefined) {
    ipcOpts.sessionMemoryStore = sessionMemoryStore;
  }
  if (rt) {
    ipcOpts.getEmbeddingStatus = () => ({
      embeddingBackfill: rt.getBackfillProgress(),
    });
  }

  const federationCfg = loadNimbusFederationFromConfigDir(paths.configDir);
  const federationBooted = await bootFederationIntoIpcOpts(
    federationCfg,
    paths,
    vault,
    db,
    localIndex,
    ipcOpts,
    sidecarStops,
    policyGate,
  );

  // Identity & Access (Phase 6 Slice 3). Mirrors the federation block: build the boot, wire the
  // IPC-facing seams onto ipcOpts, and (when [scim].enabled) hand the SCIM bearer resolver to the
  // read-only HTTP server so the SCIM provisioning surface authenticates.
  const identityCfg = loadNimbusIdentityFromConfigDir(paths.configDir);
  const scimCfg = loadNimbusScimFromConfigDir(paths.configDir);
  let identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
  const httpSidecarOpts: { resolveScimToken?: () => Promise<string> } = {};
  if (identityCfg.enabled && localIndex !== undefined) {
    identityBoot = buildIdentityBoot(identityCfg, scimCfg, localIndex, vault, {
      log: (m: string) => syncLogger.warn(m),
    });
    ipcOpts.identityStore = identityBoot.store;
    ipcOpts.identityIssuer = identityBoot.issuer;
    ipcOpts.identityGraceSeconds = identityBoot.graceSeconds;
    ipcOpts.identityStartLogin = identityBoot.startLogin;
    ipcOpts.identityVault = vault;
    if (scimCfg.enabled) {
      httpSidecarOpts.resolveScimToken = identityBoot.resolveScimToken;
    }
  }

  collectSidecarsFromEnv(db, paths, sidecarStops, httpSidecarOpts);

  const ipc = createIpcServer(ipcOpts);

  if (federationBooted) {
    federationConsent.setBroadcast((method, params) =>
      ipc.broadcast(method, asBroadcastParams(params)),
    );
    // Quorum (I21) + delegated-approval (I20) requests reach subscribers (local owner UI / approver
    // poll) via the same broadcast channel as consent; remote responders answer over the wire
    // through federation.quorumRespond / federation.approvalRespond.
    quorumCoordinator.setBroadcast((requestId) =>
      ipc.broadcast("federation.quorumRequest", { requestId }),
    );
    delegatedApprovalBroker.setBroadcast((requestId, prompt) =>
      ipc.broadcast("federation.approvalRequest", { requestId, prompt }),
    );
  }
  // Bind the live broadcast so identity.loginProgress/Done/Error reach subscribers (see identity-boot.ts).
  identityBoot?.bindLoginNotify((method, payload) => ipc.broadcast(method, payload));

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
    llmRegistry,
    ...(sessionMemoryStore === undefined ? {} : { sessionMemoryStore }),
    ...(federationBooted === undefined ? {} : { executorDelegation: federationBooted }),
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
