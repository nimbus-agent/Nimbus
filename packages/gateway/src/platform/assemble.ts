import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Logger } from "pino";
import { startAuditShipper } from "../audit/audit-shipper.ts";
import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
} from "../automation/watcher-engine.ts";
import { buildChatopsBoot, type ChatopsBoot } from "../chatops/chatops-boot.ts";
import { buildChatopsToolRunner } from "../chatops/chatops-tool-runner.ts";
import {
  buildE2eSinkDispatcher,
  buildE2eSinkRunChatopsTool,
} from "../chatops/chatops-tool-runner-e2e-sink.ts";
import type { ChatMessage, ReplyTarget } from "../chatops/types.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  type ConnectorsConfig,
  loadNimbusAuditFromConfigDir,
  loadNimbusAutomationFromConfigDir,
  loadNimbusChatopsFromConfigDir,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusLlmPartialFromPath,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPreflightFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusScimFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusTribalFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
  type NimbusChatopsToml,
  type NimbusTribalToml,
  resolveNimbusTomlForProfile,
  type TeamCredentialConnector,
} from "../config/nimbus-toml.ts";
import { loadNimbusWorkdayFromConfigDir } from "../config/nimbus-toml-workday.ts";
import { loadNimbusSessionFromPath } from "../config/session-toml.ts";
import { applyLlmTomlOverrides, Config } from "../config.ts";
import {
  CONNECTOR_SERVICE_IDS,
  defaultSyncIntervalMsForService,
} from "../connectors/connector-catalog.ts";
import {
  CONNECTOR_VAULT_SECRET_KEYS,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../connectors/connector-secrets-manifest.ts";
import {
  migrateToPerServiceOAuthKeys,
  readConnectorSecret,
} from "../connectors/connector-vault.ts";
import type { ConnectorWriteContext } from "../connectors/connector-write-transport.ts";
import { createFilesystemV2Syncable } from "../connectors/filesystem-v2-sync.ts";
import { getAllConnectorHealth } from "../connectors/health.ts";
import { createConnectorDispatcher } from "../connectors/index.ts";
import { createLazyConnectorMesh, type LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { createObsidianSyncable } from "../connectors/obsidian-sync.ts";
import {
  DEFAULT_OPENAPI_CONFIG,
  type OpenapiConfig,
  parseOpenapiToml,
} from "../connectors/openapi-indexer-config.ts";
import { createOpenapiIndexerSyncable } from "../connectors/openapi-indexer-sync.ts";
import { listUserMcpConnectors } from "../connectors/user-mcp-store.ts";
import { resolveTeamListOpenSession } from "../connectors/warehouse-sync-transport.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { startLatencyFlushScheduler } from "../db/latency-ring-buffer.ts";
import { readToolCallLog } from "../db/tool-call-log.ts";
import {
  effectiveRetentionDays,
  startToolCallLogRetention,
} from "../db/tool-call-log-retention.ts";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { createEmbeddingRuntime } from "../embedding/create-embedding-runtime.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { buildDelegatedRequestRemote } from "../engine/delegated-request-remote.ts";
import { DelegationStore } from "../engine/delegation-store.ts";
import { type ExecutorDelegationDep, ToolExecutor } from "../engine/executor.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import type { ConnectorDispatcher } from "../engine/types.ts";
import { type AutoUpdateRuntime, createAutoUpdateRuntime } from "../extensions/auto-update-init.ts";
import { verifyExtensionsBestEffort } from "../extensions/verify-extensions.ts";
import { federationConsent } from "../federation/consent-broker.ts";
import { loadOrCreateFederationIdentity } from "../federation/federation-identity.ts";
import { buildFederationRuntime } from "../federation/federation-runtime.ts";
import { buildFederationLanServer } from "../federation/federation-server.ts";
import {
  answerLocalOperatorInvoke,
  answerLocalOperatorList,
  type LocalOperatorInvokeCtx,
  type LocalOperatorListCtx,
} from "../federation/invoke-gate.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { preflightConsent } from "../federation/preflight-consent-broker.ts";
import { appendPreflightAudit, defaultRunCommand } from "../federation/preflight-gate.ts";
import { buildIdentityBoot } from "../identity/identity-boot.ts";
import { buildTeamsBotJwtValidator } from "../identity/teams-bot-jwt.ts";
import { isOperatorValid } from "../identity/verifier.ts";
import {
  LocalIndex,
  type LocalIndexOptions,
  type SemanticSearchDeps,
} from "../index/local-index.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import type { StatusReaders } from "../ipc/admin-status-rpc.ts";
import { resumePendingRemovals } from "../ipc/connector-rpc-handlers/index.ts";
import type { EgressRpcCtx } from "../ipc/egress-rpc.ts";
import { HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY } from "../ipc/http-auth.ts";
import { type ReadOnlyHttpServerOptions, startReadOnlyHttpServer } from "../ipc/http-server.ts";
import type { TeamsEventsSurface } from "../ipc/http-write-routes.ts";
import { createIpcServer } from "../ipc/index.ts";
import { sendFederatedOverWire } from "../ipc/lan-client.ts";
import { startMetricsServer } from "../ipc/metrics-server.ts";
import type { PolicyRpcCtx } from "../ipc/policy-rpc.ts";
import { extractKbPageRef } from "../ipc/server/dispatchers.ts";
import type { TribalSubmitAction } from "../ipc/tribal-rpc.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { LlmRegistry } from "../llm/registry.ts";
import { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { ensureAnchorKeypair } from "../policy/anchor-keypair.ts";
import { partitionByAllowlist } from "../policy/connector-allowlist.ts";
import { startPurge } from "../policy/gdpr-purge.ts";
import { startGdprPurgeRetry } from "../policy/gdpr-purge-retry-sidecar.ts";
import { GdprPurgeStore } from "../policy/gdpr-purge-store.ts";
import { type AuthorResult, authorPolicy } from "../policy/policy-author.ts";
import { servePolicy } from "../policy/policy-distribution.ts";
import { buildPolicyGate, type PolicyGate } from "../policy/policy-gate.ts";
import { refreshPolicy } from "../policy/policy-runtime.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import { trustAnchorPubkey } from "../policy/policy-trust.ts";
import { resolveQuorumRule } from "../policy/quorum-override.ts";
import { vectorSearchChunks } from "../search/vec-store.ts";
import { shareConsent } from "../share/share-consent-broker.ts";
import type { ShareFile } from "../share/share-format.ts";
import {
  drainPending,
  insertPendingForward,
  insertReceivedShare,
  markDelivered,
} from "../share/share-inbox-store.ts";
import { ensureShareKeypair } from "../share/share-keypair.ts";
import type { ShareRecord } from "../share/share-store.ts";
import { getShareRecord } from "../share/share-store.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import type { SyncContext } from "../sync/types.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import {
  drainTeamListSession,
  invokeTeamTool,
  invokeTeamToolList,
} from "../teamvault/team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "../teamvault/team-tool-spawn.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { startTelemetryFlushScheduler } from "../telemetry/flush-scheduler.ts";
import { type SynthSource, synthesizeAnswer } from "../tribal/answer-synthesizer.ts";
import type { TribalCluster } from "../tribal/cluster-store.ts";
import { buildTribalBoot, type TribalBoot } from "../tribal/tribal-boot.ts";
import {
  handleTribalCaptureCommand,
  parseTribalCaptureCommand,
} from "../tribal/tribal-chat-capture.ts";
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
  // Before ensureSchema: migrations write, and this is the handle that converts
  // nimbus.db to WAL for every other connection (journal_mode is a file property).
  applyWritablePragmas(db);
  LocalIndex.ensureSchema(db, { backupDir: join(dataDir, "backups"), dbPath });
  const stopLatency = startLatencyFlushScheduler(db);
  sidecarStops.push(() => stopLatency.stop());
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

// Register the filesystem-root-backed syncables (filesystem-v2 / openapi-indexer / obsidian) on the
// real scheduler. These are NOT policy connectors, so they register directly (no allowlist filter).
function registerFilesystemRootSyncables(
  syncScheduler: SyncScheduler,
  localIndex: LocalIndex,
  configDir: string,
  fsV2Roots: ReturnType<typeof loadNimbusFilesystemRootsFromConfigDir>,
): void {
  if (fsV2Roots.length === 0) {
    return;
  }
  localIndex.ensureConnectorSchedulerRegistration("filesystem", 10 * 60 * 1000, Date.now());
  syncScheduler.register(createFilesystemV2Syncable({ roots: fsV2Roots }));
  localIndex.ensureConnectorSchedulerRegistration("openapi", 10 * 60 * 1000, Date.now());
  syncScheduler.register(
    createOpenapiIndexerSyncable({
      roots: fsV2Roots,
      config: loadOpenapiConfig(configDir),
    }),
  );
  localIndex.ensureConnectorSchedulerRegistration("obsidian", 10 * 60 * 1000, Date.now());
  syncScheduler.register(createObsidianSyncable({ roots: fsV2Roots }));
}

interface SchedulerWithMeshOpts {
  paths: PlatformPaths;
  vault: NimbusVault;
  db: Database;
  syncContext: SyncContext;
  localIndex: LocalIndex;
  notifications: NotificationService;
  syncLogger: Logger;
  isConnectorAllowed: (serviceId: string) => boolean;
}

async function createSchedulerWithMesh(
  opts: SchedulerWithMeshOpts,
): Promise<{ syncScheduler: SyncScheduler; connectorMesh: LazyConnectorMesh }> {
  const {
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
    isConnectorAllowed,
  } = opts;
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
  registerFilesystemRootSyncables(syncScheduler, localIndex, paths.configDir, fsV2Roots);
  const connectorMesh = await createLazyConnectorMesh(paths, vault, {
    listUserMcpConnectors: () => listUserMcpConnectors(db),
    healthDb: db,
    auditDb: db,
    logger: syncLogger,
    obsidianVaultPaths: fsV2Roots.map((r) => r.path),
    isConnectorAllowed,
  });
  const pagerdutyCfg = loadNimbusPagerdutyFromConfigDir(paths.configDir);
  const workdayCfg = loadNimbusWorkdayFromConfigDir(paths.configDir);
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
    workdayConfig: workdayCfg,
  });
  registerUserMcpSyncablesFromDatabase(db, policyFilteredRegistrar, connectorMesh);
  syncScheduler.start();
  evaluateWatchersStartupCatchUp(db, Date.now(), (t, b) => notifications.show(t, b), watcherOpts);
  return { syncScheduler, connectorMesh };
}

interface HttpSidecarOpts {
  resolveScimToken?: () => Promise<string>;
  statusReaders?: StatusReaders;
  resolveAdminToken?: () => Promise<string>;
  authorPolicy?: (toml: string) => Promise<AuthorResult>;
  resolveTeamsEventsSurface?: () => Promise<TeamsEventsSurface | undefined>;
  // Web-clipper (Task 7): clipsVault + pairingController + scheduleEmbedding are threaded into
  // ReadOnlyHttpServerOptions. pairingController is the SINGLETON also injected into clip.* IPC.
  clipsVault?: NimbusVault;
  pairingController?: PairingWindowController;
  scheduleEmbedding?: (id: string) => void;
}

/** Parse a sidecar port from a raw env value: a positive finite integer, else undefined. */
function parseSidecarPortEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const port = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

/** Assemble the read-only HTTP server options, spreading only the seams the caller wired. */
function buildReadOnlyHttpServerOpts(
  configDir: string,
  httpOpts: HttpSidecarOpts,
): ReadOnlyHttpServerOptions {
  return {
    configDir,
    ...(httpOpts.resolveScimToken === undefined
      ? {}
      : { resolveScimToken: httpOpts.resolveScimToken }),
    ...(httpOpts.statusReaders === undefined ? {} : { statusReaders: httpOpts.statusReaders }),
    ...(httpOpts.resolveAdminToken === undefined
      ? {}
      : { resolveAdminToken: httpOpts.resolveAdminToken }),
    ...(httpOpts.authorPolicy === undefined ? {} : { authorPolicy: httpOpts.authorPolicy }),
    ...(httpOpts.resolveTeamsEventsSurface === undefined
      ? {}
      : { resolveTeamsEventsSurface: httpOpts.resolveTeamsEventsSurface }),
    ...(httpOpts.clipsVault === undefined ? {} : { clipsVault: httpOpts.clipsVault }),
    ...(httpOpts.pairingController === undefined
      ? {}
      : { pairingController: httpOpts.pairingController }),
    ...(httpOpts.scheduleEmbedding === undefined
      ? {}
      : { scheduleEmbedding: httpOpts.scheduleEmbedding }),
  };
}

function collectSidecarsFromEnv(
  db: Database,
  paths: PlatformPaths,
  sidecarStops: Array<() => void>,
  httpOpts: HttpSidecarOpts = {},
): void {
  const httpPort = parseSidecarPortEnv(processEnvGet("NIMBUS_HTTP_PORT"));
  if (httpPort !== undefined) {
    sidecarStops.push(
      startReadOnlyHttpServer(
        join(paths.dataDir, "nimbus.db"),
        httpPort,
        buildReadOnlyHttpServerOpts(paths.configDir, httpOpts),
      ).stop,
    );
  }
  const metricsPort = parseSidecarPortEnv(processEnvGet("NIMBUS_METRICS_PORT"));
  if (metricsPort !== undefined) {
    sidecarStops.push(startMetricsServer(() => db, metricsPort).stop);
  }
}

/**
 * Build the observability snapshot readers (Task 15). Each accessor is cheap + synchronous so the
 * snapshot can be assembled on every admin.status / GET /v1/admin/status / GET /metrics call.
 *
 * REAL: policyState (policyGate.status), connectors (CONNECTOR_SERVICE_IDS × isConnectorAllowed +
 * live mesh health), audit (audit_log COUNT + latest row_hash + 1h append rate), hitl.pendingApprovals
 * (delegatedApprovalBroker), peers (localIndex.listLanPeers), identity.operatorValid (isOperatorValid
 * when identity wired).
 * STUBBED: hitl.pendingQuorum = 0 (quorumCoordinator has no public pending-count accessor),
 * namespaces = [] (no cheap subscriber-count accessor), syncFreshnessMs derived best-effort from the
 * most-recent connector lastSuccessfulSync (0 when none).
 */
function buildStatusReaders(deps: {
  db: Database;
  policyGate: PolicyGate;
  localIndex: LocalIndex;
  isConnectorAllowed: (serviceId: string) => boolean;
  identityBoot?: ReturnType<typeof buildIdentityBoot>;
}): StatusReaders {
  const { db, policyGate, localIndex, isConnectorAllowed, identityBoot } = deps;
  return {
    policyState: () => policyGate.status(),
    peers: () =>
      localIndex.listLanPeers().map((p) => ({
        peerId: p.peer_id,
        reachable: p.last_seen_at !== null,
        ...(p.last_seen_at === null ? {} : { lastSeenMs: Date.parse(p.last_seen_at) }),
      })),
    connectors: () => {
      const health = new Map(getAllConnectorHealth(db).map((h) => [h.connectorId, h]));
      return [...CONNECTOR_SERVICE_IDS].map((id) => {
        const allowed = isConnectorAllowed(id);
        return {
          id,
          enabled: allowed,
          blockedByPolicy: !allowed,
          health: health.get(id)?.state ?? "unknown",
        };
      });
    },
    namespaces: () => [], // STUB: no cheap subscriber-count accessor on NamespaceStore.
    audit: () => {
      const total = db.query(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number } | null;
      const last = db.query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as {
        row_hash: string | null;
      } | null;
      const since = Date.now() - 3_600_000;
      const rate = db
        .query(`SELECT COUNT(*) AS n FROM audit_log WHERE timestamp >= ?`)
        .get(since) as { n: number } | null;
      return {
        chainLength: total?.n ?? 0,
        lastHash: last?.row_hash ?? "",
        appendRate1h: rate?.n ?? 0,
      };
    },
    hitl: () => ({
      pendingApprovals: delegatedApprovalBroker.listPending().length,
      pendingQuorum: 0, // STUB: quorumCoordinator exposes no public pending-count accessor.
    }),
    identity: () => {
      const store = identityBoot?.store;
      const issuer = identityBoot?.issuer;
      if (store === undefined || issuer === undefined) return { operatorValid: true };
      return {
        operatorValid: isOperatorValid(store, issuer, Date.now(), identityBoot?.graceSeconds ?? 0),
      };
    },
    syncFreshnessMs: () => {
      let newest = 0;
      for (const h of getAllConnectorHealth(db)) {
        const t = h.lastSuccessfulSync?.getTime() ?? 0;
        if (t > newest) newest = t;
      }
      return newest === 0 ? 0 : Math.max(0, Date.now() - newest);
    },
  };
}

function asBroadcastParams(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/** Actionable local-operator sync error (Wave 7b). The localOperator path may surface a distinct,
 *  actionable message (no cross-principal leak on the operator's own machine) — the peer path stays
 *  opaque. The login verb is verified: `nimbus identity login` (cli/src/commands/identity.ts). */
function teamListErrorMessage(
  error: "no_grant" | "identity_invalid",
  req: { entry: string; service: string },
): string {
  if (error === "identity_invalid") {
    return `team-credential sync for ${req.service} blocked: your identity is invalid/expired — re-run the device-code login with: nimbus identity login`;
  }
  return `team-credential sync for ${req.service} failed: team-vault entry "${req.entry}" not found or service mismatch. Add it with: nimbus team vault put ${req.entry} ${req.service} --secret <key>=<value>`;
}

interface BootFederationOpts {
  federationCfg: ReturnType<typeof loadNimbusFederationFromConfigDir>;
  paths: PlatformPaths;
  vault: NimbusVault;
  db: Database;
  localIndex: LocalIndex;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  sidecarStops: Array<() => void>;
  policyGate: PolicyGate;
}

/** Boot the federation LAN server + discovery into ipcOpts when enabled. Returns true if booted
 *  (so the caller can wire the consent broadcast after the IPC server exists). */
async function bootFederationIntoIpcOpts(
  opts: BootFederationOpts,
): Promise<ExecutorDelegationDep | undefined> {
  const { federationCfg, paths, vault, db, localIndex, ipcOpts, sidecarStops, policyGate } = opts;
  if (!federationCfg.enabled) return undefined;
  const identity = await loadOrCreateFederationIdentity(vault);

  // 8d: deliver a signed share to a peer over the authenticated, pubkey-pinned federation wire.
  const deliverShareToPeer = async (
    share: ShareFile,
    peer: { host: string; port: number; pubkey: string },
  ): Promise<void> => {
    await sendFederatedOverWire(
      peer.host,
      peer.port,
      identity,
      new Uint8Array(Buffer.from(peer.pubkey, "base64")),
      "federation.shareReceive",
      { share },
    );
  };
  // peerId/pubkey → reachable ForwardPeer (paired only, host+port must be present).
  const lookupForwardPeer = (
    recipientPubkey: string,
  ): { host: string; port: number; pubkey: string } | undefined => {
    const row = localIndex.getLanPeerByPubkey(
      new Uint8Array(Buffer.from(recipientPubkey, "base64")),
    );
    if (row?.host_ip == null || row.host_port == null) return undefined;
    return { host: row.host_ip, port: row.host_port, pubkey: recipientPubkey };
  };
  // Resolve a `peer:<hex>` id to its paired row's b64 pubkey. For a raw input, pass it through ONLY
  // if it is a structurally-valid 32-byte Ed25519/X25519 pubkey (a cryptographic recipient identity,
  // for the deferred-reveal queue — §9.4); any other unknown/garbage value resolves to `undefined`
  // so the RPC rejects it (no caller-supplied arbitrary destination; no undrainable pending rows).
  const resolvePeerPubkeyFn = (peerIdOrPubkey: string): string | undefined => {
    const row = localIndex
      .listLanPeers()
      .find(
        (r) =>
          `peer:${bytesToHex(new Uint8Array(r.peer_pubkey).subarray(0, 8))}` === peerIdOrPubkey,
      );
    if (row !== undefined) return Buffer.from(new Uint8Array(row.peer_pubkey)).toString("base64");
    // Not a known peer id → accept only a canonical 32-byte base64 pubkey.
    try {
      const decoded = Buffer.from(peerIdOrPubkey, "base64");
      if (decoded.length === 32 && decoded.toString("base64") === peerIdOrPubkey) {
        return peerIdOrPubkey;
      }
    } catch {
      /* fall through to undefined */
    }
    return undefined;
  };
  // Reconstruct a ShareFile from a share_records row (camelCase mapped fields from share-store.ts).
  const shareFileFromRecord = (r: ShareRecord): ShareFile => ({
    format: "nimbus-share/v1",
    contentHash: r.contentHash,
    body: JSON.parse(r.bodyJson) as ShareFile["body"],
    sig: JSON.parse(r.sigJson) as ShareFile["sig"],
    forwarding: r.provenance as ShareFile["forwarding"],
  });

  // drain-on-pair: when a new peer pairs, flush any pending forwards queued for them.
  const drainOnPair = async (peerId: string): Promise<void> => {
    const pub = resolvePeerPubkeyFn(peerId);
    if (pub === undefined) return;
    const peer = lookupForwardPeer(pub);
    if (peer === undefined) return;
    for (const row of drainPending(db, pub)) {
      try {
        await deliverShareToPeer(row.share, peer);
        markDelivered(db, row.id);
      } catch {
        /* best-effort; retried on next pair/online event */
      }
    }
  };

  const federationRuntime = buildFederationRuntime(
    federationCfg,
    localIndex,
    identity,
    drainOnPair,
  );
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
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
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
  // GDPR purge signer (Slice 4, spec D11). Resolve the Ed25519 anchor keypair once (Vault-only seed)
  // and pass the privkey seed + this gateway's federation selfPeerId so an approved federation.purge
  // can return a valid signed DeletionRecord. selfPeerId is derived from the federation box identity's
  // public key the same way peers are identified (peer:<first-8-bytes-hex>).
  // deletePurgeContributions (Task 26): after the LOCAL operator approves an inbound federation.purge,
  // delete the requesting peer's local contributions. The confirmed local effect is revoking ALL of
  // that peer's federation grants (NamespaceStore.revokeAllForPeer); its count is the deletedCount in
  // the signed receipt. Item-level row deletion has no confirmed accessor — see Task 26 report.
  const { privkeyB64: purgePrivkeyB64 } = await ensureAnchorKeypair(vault); // gitleaks:allow — Vault-resolved seed, not a literal
  const selfPeerId = `peer:${bytesToHex(identity.publicKey.subarray(0, 8))}`;
  const purgeNamespaceStore = new NamespaceStore(db);
  const built = buildFederationLanServer({
    db,
    index: localIndex,
    identity,
    purgeSign: { privkeyB64: purgePrivkeyB64, selfPeerId },
    deletePurgeContributions: (_externalId, peerId) =>
      purgeNamespaceStore.revokeAllForPeer(peerId, Date.now()),
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
    // I24 (Slice 6b): serve inbound preflights over the wire behind THIS owner's local HITL approval;
    // the command is resolved from local nimbus.toml only, never from the caller.
    preflight: {
      isPeerGranted: (ns, peerId) =>
        new NamespaceStore(db).getActiveGrant(ns, peerId) !== undefined,
      resolveCommand: (ns) => loadNimbusPreflightFromConfigDir(paths.configDir).get(ns),
      requestApproval: (input) =>
        preflightConsent.request(input, federationRuntime.consentTimeoutSeconds * 1000 + 5000),
      runCommand: defaultRunCommand,
      audit: (e) => appendPreflightAudit(db, e),
    },
    // 8d: receive forwarded shares inert (spec §9.4) — store in share_inbox, no HITL.
    receiveShareDeps: {
      now: () => Date.now(),
      storeReceived: (share) => insertReceivedShare(db, { share, now: Date.now() }),
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

  // 8d: wire forward/resolve deps into the local IPC federation dispatch path.
  // forwardShareDeps — the second I27 chokepoint's dependencies (owner calls federation.shareForward).
  ipcOpts.federationForwardShareDeps = {
    now: () => Date.now(),
    label: os.hostname(),
    loadShare: (h) => {
      const r = getShareRecord(db, h);
      return r === undefined ? undefined : shareFileFromRecord(r);
    },
    shareKeypair: () => ensureShareKeypair(vault),
    // SAME owner consent broker as createShare (D21 extension: second outbound-share chokepoint).
    requestApproval: (preview, redactionSet) =>
      shareConsent.request(
        { sessionId: "", kind: "forward", preview, redactionSet, sink: "peer" },
        (ipcOpts.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000,
      ),
    lookupPeer: lookupForwardPeer,
    deliver: deliverShareToPeer,
    queuePending: (recipientPubkey, share) =>
      insertPendingForward(db, { recipientPubkey, share, now: Date.now() }),
    recordAudit: (entry) => appendAuditEntry(db, entry),
  };
  ipcOpts.federationResolvePeerPubkey = resolvePeerPubkeyFn;
  // 8d origin emit (share.create --to-peer): deliver the already-approved+signed share to a peer.
  // No hop is appended here (origin, hops stays 0) — createShare already ran the share.publish HITL.
  ipcOpts.shareDeliverToPeer = async (share: ShareFile, peerId: string): Promise<boolean> => {
    const pub = resolvePeerPubkeyFn(peerId);
    if (pub === undefined) return false;
    const peer = lookupForwardPeer(pub);
    if (peer === undefined) return false;
    // A transport failure must not fail `share.create --to-peer` — the share is already persisted
    // locally (createShare ran first); report delivered:false rather than throwing.
    try {
      await deliverShareToPeer(share, peer);
      return true;
    } catch {
      return false;
    }
  };

  return delegationDep;
}

/** How long the chatops local-owner fallback waits for a `nimbus team approve` answer. */
const CHATOPS_LOCAL_CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Org policy boot (I22): the gate rehydrates last-valid from the store (ungoverned when none). The
 *  baseline is the local floor policy can only TIGHTEN. `policyGate` is the shared instance reused
 *  by the retention floor (Task 8), quorum (Task 9), and the audit shipper (Task 19) — keep it in
 *  scope even though Part C of this task only consumes `enforced().connectorAllow`. Also enforces
 *  the connector allowlist: audits + blocks connectors not permitted by policy. */
function bootPolicyGateWithConnectorAllowlist(
  db: Database,
  configDir: string,
  auditCfg: ReturnType<typeof loadNimbusAuditFromConfigDir>,
): {
  policyStore: PolicyStore;
  policyGate: PolicyGate;
  isConnectorAllowed: (serviceId: string) => boolean;
} {
  const policyStore = new PolicyStore(db);
  const policyGate = buildPolicyGate(db, policyStore, {
    retentionDays: auditCfg.toolCallLogRetentionDays,
    hitlRequired: new Set<string>(),
    quorum: loadNimbusQuorumFromConfigDir(configDir),
  });
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
  return { policyStore, policyGate, isConnectorAllowed };
}

/** Load the [llm] config from the active TOML, apply the model overrides, and build the provider
 *  registry (Ollama + llama.cpp local providers). */
function buildLlmRegistryFromToml(db: Database, activeTomlPath: string): LlmRegistry {
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
  return llmRegistry;
}

/** Start the extensions auto-update daemon when `NIMBUS_EXTENSIONS_REGISTRY_URL` enables it (and
 *  `NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE` does not veto). Returns the runtime (undefined when not
 *  started) plus the disable flag for the IPC diag surface. */
function maybeStartAutoUpdateRuntime(deps: {
  db: Database;
  vault: NimbusVault;
  paths: PlatformPaths;
  connectorMesh: LazyConnectorMesh;
  sidecarStops: Array<() => void>;
}): { runtime: AutoUpdateRuntime | undefined; disabled: boolean } {
  const { db, vault, paths, connectorMesh, sidecarStops } = deps;
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
  return { runtime: autoUpdateRuntime, disabled: autoUpdateDisabled };
}

/** The auto-update slices of the IPC server options; empty when the daemon is not running. */
function autoUpdateIpcOpts(
  runtime: AutoUpdateRuntime | undefined,
  configDir: string,
  airGapBlocked: boolean,
): Pick<
  Parameters<typeof createIpcServer>[0],
  "extensionsAutoUpdate" | "extensionsAutoUpdateDiag"
> {
  if (runtime === undefined) {
    return {};
  }
  const autoUpdateDeps = runtime.deps;
  return {
    extensionsAutoUpdate: autoUpdateDeps,
    extensionsAutoUpdateDiag: {
      cachedUpdatesCount: (): number => autoUpdateDeps.cache.list().length,
      intervalHours: loadNimbusExtensionsFromConfigDir(configDir).updateCheckIntervalHours,
      airGapBlocked,
    },
  };
}

/** Identity & Access (Phase 6 Slice 3). Mirrors the federation block: build the boot, wire the
 *  IPC-facing seams onto ipcOpts, and (when [scim].enabled) hand the SCIM bearer resolver to the
 *  read-only HTTP server so the SCIM provisioning surface authenticates. */
function bootIdentityIntoIpcOpts(deps: {
  configDir: string;
  localIndex: LocalIndex;
  vault: NimbusVault;
  syncLogger: Logger;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  httpSidecarOpts: HttpSidecarOpts;
}): ReturnType<typeof buildIdentityBoot> | undefined {
  const { configDir, localIndex, vault, syncLogger, ipcOpts, httpSidecarOpts } = deps;
  const identityCfg = loadNimbusIdentityFromConfigDir(configDir);
  const scimCfg = loadNimbusScimFromConfigDir(configDir);
  let identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
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
  return identityBoot;
}

/** Build the policy.* + team.purge IPC context (Task 26, Lanes A–G integration hub). The local IPC
 *  socket is operator/owner-trusted, so isAnchor is true for local calls (signing makes this gateway
 *  an anchor; a purge is operator-only). The GDPR purge deps wire the REAL local-side capabilities:
 *    resolvePeer            → identity binding store (externalId → active peer ids; first wins)
 *    revokeAllGrants        → NamespaceStore.revokeAllForPeer (confirmed grant-revocation sweep)
 *    deleteLocalContributions → same sweep's count (item-level row deletion has no confirmed accessor;
 *                               grant-revocation is the confirmed local effect — see report)
 *    knownPeers             → localIndex.listLanPeers (paired peers fan out one purge request each)
 *  resolvePeer returns undefined when identity is disabled / unbound → startPurge throws (fail-closed). */
function buildPolicyRpcCtx(deps: {
  db: Database;
  vault: NimbusVault;
  localIndex: LocalIndex;
  policyStore: PolicyStore;
  policyGate: PolicyGate;
  identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
}): PolicyRpcCtx {
  const { db, vault, localIndex, policyStore, policyGate, identityBoot } = deps;
  const purgeNamespaceStore = new NamespaceStore(db);
  const purgeJobStore = new GdprPurgeStore(db);
  let purgeJobCounter = 0;
  return {
    showPolicy: () => policyGate.status(),
    trustPubkey: ({ pubkey }) => trustAnchorPubkey(policyStore, pubkey, Date.now()),
    refetch: () =>
      refreshPolicy({
        store: policyStore,
        gate: policyGate,
        pinnedPubkey: policyStore.getAnchorPubkey() ?? "",
        nowMs: Date.now(),
        // Best-effort: no inbound anchor bundle source is wired at the IPC layer, so refetch is a
        // local no-op (returns the locally-served bundle, or null when ungoverned). The over-the-wire
        // peer fetch is the federation runtime's job; here we surface "no_bundle" rather than fabricate.
        fetch: async () => servePolicy(policyStore),
      }),
    signPolicy: async ({ toml }) => {
      const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);
      const r = authorPolicy(
        { store: policyStore, gate: policyGate, db, privkeyB64, pubkeyB64, nowMs: Date.now() },
        toml,
      );
      if (!r.ok) throw new Error(r.error);
      return { org: r.org, version: r.version };
    },
    purge: ({ externalId }) =>
      startPurge(
        {
          store: purgeJobStore,
          resolvePeer: (extId) => identityBoot?.store.activePeerIdsFor(extId)[0],
          // Grant revocation is the confirmed local effect of a purge; performed once in
          // deleteLocalContributions (which returns the count). No separate item-level
          // deletion accessor exists yet, so revokeAllGrants is a no-op to avoid double-sweeping.
          revokeAllGrants: () => {},
          deleteLocalContributions: (peerId) =>
            purgeNamespaceStore.revokeAllForPeer(peerId, Date.now()),
          knownPeers: () => localIndex.listLanPeers().map((p) => p.peer_id),
          newJobId: () => {
            purgeJobCounter += 1;
            return `gdpr-${Date.now()}-${purgeJobCounter}`;
          },
          nowMs: () => Date.now(),
        },
        externalId,
      ),
    // Local IPC socket is operator/owner-trusted (see ipc/server): treat local calls as the anchor.
    isAnchor: true,
  };
}

/** Build the updater from config (when [updater] enables one), hand it to the IPC server, and run
 *  the best-effort startup check. */
function wireUpdaterIntoIpc(
  configDir: string,
  ipc: ReturnType<typeof createIpcServer>,
  syncLogger: Logger,
): void {
  const updaterCfg = loadNimbusUpdaterFromConfigDir(configDir);
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
}

// Tribal-knowledge watcher boot (Phase 6 Slice 6c), extracted verbatim from
// assemblePlatformServices to keep that function's cognitive complexity in budget (S3776). This is
// a BEHAVIOUR-PRESERVING extraction: boot ordering and every wiring decision are identical.
//
// The chatops↔tribal boot cycle is preserved exactly via two late-binding seams the caller owns:
//   - `sendHolder.current` — the I23 reply seam. `buildTribalBoot`'s `send` closure reads it at
//     post time; the caller rebinds it to `chatopsBoot.replyTo` AFTER chatops boots. Sharing one
//     mutable holder keeps the original late-bound `let tribalSend` semantics across the boundary.
//   - `getChatopsBoot()` — `chatopsBoot` is assigned after this function returns; the in-chat
//     capture interceptor reads it at message time (skips cleanly if chatops isn't up).
async function bootTribalKnowledge(deps: {
  tribalCfg: NimbusTribalToml;
  chatopsCfg: NimbusChatopsToml;
  rt: EmbeddingRuntime;
  db: Database;
  syncLogger: Logger;
  localIndex: LocalIndex;
  connectorMesh: LazyConnectorMesh;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  sendHolder: { current: (target: ReplyTarget, text: string) => Promise<void> };
  getChatopsBoot: () => ChatopsBoot | undefined;
}): Promise<{
  tribalBoot: TribalBoot;
  tribalInterceptCommand: (m: ChatMessage) => Promise<boolean>;
}> {
  const {
    tribalCfg,
    chatopsCfg,
    rt,
    db,
    syncLogger,
    localIndex,
    connectorMesh,
    ipcOpts,
    sendHolder,
    getChatopsBoot,
  } = deps;
  // Embeddings absent is a DEGRADATION, not a security boundary: repeat detection needs the
  // embedder, so without it the watcher is inert (embedQuery → null), but the IPC surface,
  // CLI list/dismiss, and owner-HITL capture still work. The privacy fail-closed (empty
  // watch_channels) is enforced inside buildTribalBoot regardless.
  const embeddingRt = rt;
  if (embeddingRt == null) {
    syncLogger.warn(
      "[tribal].enabled but the embedding runtime is unavailable — repeat detection is inert; capture/list still work",
    );
  }
  const tribalModel = embeddingRt?.getEmbeddingModel() ?? "";
  const tribalWatch = tribalCfg.watchChannels;
  const tribalWatchSet = new Set(tribalWatch);
  // Recall the cluster's source threads from the index, channel-filtered IN SQL (review §2.1),
  // and hydrate each hit with its channel + url for citations. Empty when the cluster has no vec.
  const gatherSources = (cluster: TribalCluster): SynthSource[] => {
    const vec = cluster.representativeVec;
    if (vec === null) return [];
    const hits = [
      ...vectorSearchChunks(db, {
        queryEmbedding: vec,
        model: tribalModel,
        limit: 5,
        service: "slack",
        itemType: "message",
        metadataChannelIn: tribalWatch,
      }),
      ...vectorSearchChunks(db, {
        queryEmbedding: vec,
        model: tribalModel,
        limit: 5,
        service: "teams",
        itemType: "message",
        metadataChannelIn: tribalWatch,
      }),
    ];
    const out: SynthSource[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      if (seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      const row = db.query("SELECT metadata, url FROM item WHERE id = ?").get(h.itemId) as {
        metadata: string | null;
        url: string | null;
      } | null;
      let channelId = "";
      if (row?.metadata != null) {
        try {
          const m = JSON.parse(row.metadata) as { channel?: unknown };
          if (typeof m.channel === "string") channelId = m.channel;
        } catch {
          // non-JSON metadata → leave channelId empty (filtered out by the watch-set check)
        }
      }
      out.push({ itemId: h.itemId, channelId, url: row?.url ?? null, text: h.chunkText });
    }
    return out;
  };
  // v1 synthesis: a deterministic draft (title = the question, body = the source snippets) that
  // the owner reviews + edits at the HITL gate. The injected-llm seam keeps swapping in an
  // LLM-authored prose draft a one-line change (answer-synthesizer.ts SYNTH_PROMPT is ready).
  const tribalSynthesize = (cluster: TribalCluster) =>
    synthesizeAnswer(
      {
        gatherSources,
        watchChannels: tribalWatchSet,
        llm: async (question, srcs) => ({
          title: question.slice(0, 120),
          bodyMarkdown:
            srcs.length === 0
              ? "No source context was found — please write the answer manually before saving."
              : `Drafted from ${srcs.length} source message(s) — review and edit before saving.\n\n${srcs
                  .map((s) => `- ${s.text}`)
                  .join("\n")}`,
        }),
      },
      cluster,
    );
  const tribalBoot = buildTribalBoot({
    db,
    cfg: tribalCfg,
    embedQuery: (text) =>
      embeddingRt == null ? Promise.resolve(null) : embeddingRt.embedQuery(text),
    // Bot self-filter (review §1.1): primary guard is the Slack normalizer's bot_id/subtype skip
    // (Task 8); this is defense-in-depth using the configured Teams bot app id. (The Slack bot
    // user id is not resolvable without an extra API call at boot.)
    botUserIds: new Set([chatopsCfg.teamsBotAppId].filter((s) => s !== "")),
    send: (target, text) => sendHolder.current(target, text),
    synthesize: tribalSynthesize,
    log: (m) => syncLogger.warn(m),
  });
  ipcOpts.tribalRpcCtx = tribalBoot.rpcCtx;
  // I25 capture write target: the e2e sink when set (Task 20), else the real connector mesh.
  const tribalE2eSinkDir = processEnvGet("NIMBUS_CHATOPS_E2E_SINK_DIR");
  const tribalDispatcher: ConnectorDispatcher =
    tribalE2eSinkDir === undefined || tribalE2eSinkDir === ""
      ? createConnectorDispatcher({
          listTools: () => connectorMesh.listToolsForDispatcher(),
          getToolsEpoch: () => connectorMesh.getToolsEpoch(),
        })
      : buildE2eSinkDispatcher(tribalE2eSinkDir);
  ipcOpts.tribalConnectorDispatcher = tribalDispatcher;
  // In-chat capture trigger (Task 19): `@nimbus tribal capture <id>` → I25 write-gate with the
  // owner's chatops HITL consent. `chatopsBoot` is late-bound (assigned just below), so the
  // closure reads it at message time. Skips cleanly if chatops isn't up.
  const tribalRpcCtx = tribalBoot.rpcCtx;
  const tribalInterceptCommand = async (msg: ChatMessage): Promise<boolean> => {
    const cmd = parseTribalCaptureCommand(msg.text);
    if (cmd === undefined) return false;
    const cb = getChatopsBoot();
    if (cb === undefined) return false;
    // Only an enrolled (mapped) sender may trigger the owner-HITL capture — otherwise fall
    // through to the IntentRouter (which refuses unmapped users). Without this, any addressed
    // channel member could spam the local owner with capture approval prompts.
    if (!(await cb.isSenderMapped(msg.platform, msg.userId))) return false;
    const executor = new ToolExecutor(
      { requestApproval: (p, d) => cb.requestOwnerApproval(p, d) },
      localIndex,
      tribalDispatcher,
      undefined,
      // I29: in-chat tribal capture dispatches a real connector KB write — ledger it.
      makeEgressSink(localIndex.getDatabase()),
    );
    const submit: TribalSubmitAction = async (action) => {
      const res = await executor.execute({ type: action.type, payload: action.payload });
      if (res.status !== "ok") return { status: "rejected" };
      return {
        status: "approved",
        result: { pageRef: extractKbPageRef(action.type, res.result) },
      };
    };
    await handleTribalCaptureCommand(
      {
        capture: (id, t) => tribalRpcCtx.capture(id, t, submit),
        reply: (text) =>
          cb.replyTo(
            { kind: "originating", platform: msg.platform, channelId: msg.channelId },
            text,
          ),
      },
      cmd,
    );
    return true;
  };
  return { tribalBoot, tribalInterceptCommand };
}

/** Wave 7b/7c — build the team-shared credential contexts (I19 secret-consumption chokepoint).
 *  `credentialFor` reads the per-connector [connectors.<name>] pin (default personal); the
 *  localOperator list/invoke paths route through the principal-polymorphic gate. identityBoot is
 *  built later in assembly, so operator-validity is late-bound through `identityBootRefHolder` and
 *  fails closed until identity has booted (I18: identity-enabled but unbooted is treated as invalid).
 *  Extracted from assemblePlatformServices to keep its cognitive complexity in budget. */
function buildTeamCredentialContexts(deps: {
  db: Database;
  vault: NimbusVault;
  paths: PlatformPaths;
  connectorsConfig: ConnectorsConfig;
  identityEnabled: boolean;
  identityBootRefHolder: { current: ReturnType<typeof buildIdentityBoot> | undefined };
}): {
  teamCredentialExtras: Pick<SyncContext, "sandboxCwd" | "credentialFor" | "runTeamList">;
  connectorWriteDeps: ConnectorWriteContext;
} {
  const { db, vault, paths, connectorsConfig, identityEnabled, identityBootRefHolder } = deps;
  // Shared by the list + invoke ctxs (previously duplicated): the late-bound operator-validity guard.
  const identitySpread = identityEnabled
    ? {
        identity: {
          enabled: true,
          isOperatorValid: () => {
            const ref = identityBootRefHolder.current;
            const store = ref?.store;
            const issuer = ref?.issuer;
            if (store === undefined || issuer === undefined) return false; // fail-closed until booted
            return isOperatorValid(store, issuer, Date.now(), ref?.graceSeconds ?? 0);
          },
        },
      }
    : {};

  const localOpListCtx: LocalOperatorListCtx = {
    db,
    store: new TeamVaultStore(db),
    runListTool: (input) =>
      invokeTeamToolList(
        {
          vault,
          sandboxCwd: paths.dataDir,
          requiredSecretKeysFor: (service: string) =>
            CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          openSession: resolveTeamListOpenSession(
            processEnvGet("NIMBUS_WAREHOUSE_E2E_SINK_DIR"),
            drainTeamListSession,
          ),
        },
        input,
      ),
    ...identitySpread,
  };
  const teamCredentialExtras: Pick<SyncContext, "sandboxCwd" | "credentialFor" | "runTeamList"> = {
    sandboxCwd: paths.dataDir,
    credentialFor: (service: string) =>
      connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" },
    runTeamList: (req) =>
      answerLocalOperatorList(localOpListCtx, req).then((r) => {
        if (r.kind === "error") throw new Error(teamListErrorMessage(r.error, req));
        return [...r.items];
      }),
  };

  // Wave 7c — team-credentialed local WRITE invoke (I19 single-tool variant). Mirrors localOpListCtx
  // but uses invokeTeamTool (single call) + a one-shot session call.
  const localOpInvokeCtx: LocalOperatorInvokeCtx = {
    db,
    store: new TeamVaultStore(db),
    runTool: (input) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: paths.dataDir,
          requiredSecretKeysFor: (service: string) =>
            CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          spawnAndCall: (r) =>
            withConnectorSession(
              { service: r.service, vaultView: r.vaultView, sandboxCwd: r.sandboxCwd },
              (session) => session.call(r.toolId, r.args),
            ),
        },
        input,
      ),
    ...identitySpread,
  };

  const connectorWriteDeps: ConnectorWriteContext = {
    vault,
    sandboxCwd: paths.dataDir,
    credentialFor: (service: string) =>
      connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" },
    runTeamInvoke: (req) =>
      answerLocalOperatorInvoke(localOpInvokeCtx, req).then((r) => {
        if (r.kind === "error") {
          throw new Error(`team-vault write (${req.service}/${req.toolId}): ${r.error}`);
        }
        return r.result;
      }),
  };

  return { teamCredentialExtras, connectorWriteDeps };
}

/** ChatOps (Phase 6 Slice 5) boot wiring. When [chatops].enabled, build the Slack/Teams bot graph
 *  and wire it into the IPC + HTTP sidecar opts; returns the live ChatopsBoot (or undefined when
 *  disabled). Extracted from assemblePlatformServices to keep its cognitive complexity in budget;
 *  the chatops↔tribal reply cycle is preserved by rebinding `tribalSendHolder.current` here. */
function bootChatopsIntoAssembly(deps: {
  chatopsCfg: ReturnType<typeof loadNimbusChatopsFromConfigDir>;
  policyGate: Parameters<typeof buildChatopsBoot>[0]["policyGate"];
  tribalBoot: TribalBoot | undefined;
  tribalInterceptCommand: ((m: ChatMessage) => Promise<boolean>) | undefined;
  identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
  vault: NimbusVault;
  paths: PlatformPaths;
  db: Database;
  connectorMesh: Awaited<ReturnType<typeof createSchedulerWithMesh>>["connectorMesh"];
  syncLogger: Logger;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  httpSidecarOpts: HttpSidecarOpts;
  sidecarStops: Array<() => void>;
  tribalSendHolder: { current: (target: ReplyTarget, text: string) => Promise<void> };
}): ChatopsBoot | undefined {
  const {
    chatopsCfg,
    policyGate,
    tribalBoot,
    tribalInterceptCommand,
    identityBoot,
    vault,
    paths,
    db,
    connectorMesh,
    syncLogger,
    ipcOpts,
    httpSidecarOpts,
    sidecarStops,
    tribalSendHolder,
  } = deps;
  if (!chatopsCfg.enabled) return undefined;
  const identityBootRef = identityBoot;
  // E2E seam (NIMBUS_CHATOPS_E2E_SINK_DIR, precedent: NIMBUS_SKIP_EMBEDDING_RUNTIME): swap the
  // real bot-credentialed connector spawn + mesh dispatch for a file-backed mock — the "mock
  // Slack/Teams transport" the real-gateway e2e drives. Unset in production (the real spawn).
  const chatopsE2eSinkDir = processEnvGet("NIMBUS_CHATOPS_E2E_SINK_DIR");
  const chatopsBoot = buildChatopsBoot({
    cfg: chatopsCfg,
    policyGate,
    ...(tribalBoot === undefined ? {} : { onInboundMessage: tribalBoot.onInboundMessage }),
    ...(tribalInterceptCommand === undefined ? {} : { interceptCommand: tribalInterceptCommand }),
    ...(identityBootRef === undefined
      ? {}
      : {
          identity: {
            findScimByEmail: (email: string) => {
              const scim = identityBootRef.store.findScimByEmail(email);
              if (scim === undefined) return undefined;
              return {
                externalId: scim.externalId,
                email: scim.email ?? email,
                active: scim.active,
                issuer: identityBootRef.issuer,
              };
            },
            isOperatorValid: (issuer: string) =>
              isOperatorValid(
                identityBootRef.store,
                issuer,
                Date.now(),
                identityBootRef.graceSeconds,
              ),
          },
        }),
    runTool:
      chatopsE2eSinkDir === undefined || chatopsE2eSinkDir === ""
        ? buildChatopsToolRunner({
            vault,
            botVaultEntry: chatopsCfg.botVaultEntry,
            sandboxCwd: paths.dataDir,
          })
        : buildE2eSinkRunChatopsTool(chatopsE2eSinkDir),
    audit: { recordAudit: (entry) => appendAuditEntry(db, entry) },
    dispatcher:
      chatopsE2eSinkDir === undefined || chatopsE2eSinkDir === ""
        ? createConnectorDispatcher({
            listTools: () => connectorMesh.listToolsForDispatcher(),
            getToolsEpoch: () => connectorMesh.getToolsEpoch(),
          })
        : buildE2eSinkDispatcher(chatopsE2eSinkDir),
    // I29: chatops-approved writes dispatch real connector actions — ledger them (append-before-dispatch).
    egressSink: makeEgressSink(db),
    ...(chatopsCfg.teamsEnabled && chatopsCfg.teamsBotAppId !== ""
      ? {
          validateTeamsJwt: buildTeamsBotJwtValidator({
            db,
            teamsBotAppId: chatopsCfg.teamsBotAppId,
            log: (m) => syncLogger.warn(m),
          }),
        }
      : {}),
    log: (m) => syncLogger.warn(m),
  });
  ipcOpts.chatopsRpcCtx = chatopsBoot.rpcCtx;
  const teamsSurface = chatopsBoot.teamsSurface;
  if (teamsSurface !== undefined) {
    httpSidecarOpts.resolveTeamsEventsSurface = () => Promise.resolve(teamsSurface);
  }
  const stopChatops = chatopsBoot;
  sidecarStops.push(() => void stopChatops.stop());
  // Resolve the chatops↔tribal cycle: rebind the tribal watcher's `send` (the shared holder the
  // tribal `send` closure reads at post time) to the chatops I23 reply seam now that it exists.
  // Without chatops, the holder stays the no-op (detection still records clusters; CLI capture
  // works; only auto-suggestion posts are suppressed).
  if (tribalBoot !== undefined) {
    const replyTo = chatopsBoot.replyTo;
    tribalSendHolder.current = (target, text) => replyTo(target, text);
  }
  return chatopsBoot;
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
  const llmRegistry = buildLlmRegistryFromToml(db, activeTomlPath);

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

  // Wave 7b — team-shared credentials. `credentialFor` reads the per-connector [connectors.<name>]
  // pin (default personal); `runTeamList` routes the localOperator path through the principal-
  // polymorphic gate (I19 — the one secret-consumption chokepoint). identityBoot is built later in
  // assembly, so the operator-validity check is late-bound through `identityBootRef` and fails closed
  // until identity has booted (I18: identity-enabled but unbooted is treated as invalid).
  const connectorsConfig = loadNimbusConnectorsFromConfigDir(paths.configDir);
  const identityEnabled = loadNimbusIdentityFromConfigDir(paths.configDir).enabled;
  // identityBoot is built later in assembly; the operator-validity check is late-bound through this
  // holder and fails closed until identity has booted (I18). Rebound to the live boot below.
  const identityBootRefHolder: { current: ReturnType<typeof buildIdentityBoot> | undefined } = {
    current: undefined,
  };
  const { teamCredentialExtras, connectorWriteDeps } = buildTeamCredentialContexts({
    db,
    vault,
    paths,
    connectorsConfig,
    identityEnabled,
    identityBootRefHolder,
  });

  const syncBase: SyncContext = {
    vault,
    db,
    logger: syncLogger,
    rateLimiter,
    ...teamCredentialExtras,
  };
  const syncContext: SyncContext = scheduleItemEmbedding
    ? { ...syncBase, scheduleItemEmbedding }
    : syncBase;

  const sessionMemoryStore = maybeAttachSessionMemoryStore(db, rt, sessionToml, sidecarStops);

  const auditCfg = loadNimbusAuditFromConfigDir(paths.configDir);

  // Org policy (I22): built BEFORE the retention sidecar so the latter can honor
  // `enforced().retentionDays` (the monotonic floor).
  const { policyStore, policyGate, isConnectorAllowed } = bootPolicyGateWithConnectorAllowlist(
    db,
    paths.configDir,
    auditCfg,
  );

  // Retention floor (Task 8): effective retention = max(local config, policy floor); policy can only
  // LENGTHEN retention. Started after the gate so it can read `enforced().retentionDays`.
  const toolCallLogRetention = startToolCallLogRetention(db, {
    retentionDays: effectiveRetentionDays(
      auditCfg.toolCallLogRetentionDays,
      policyGate.enforced().retentionDays,
    ),
  });
  sidecarStops.push(() => toolCallLogRetention.stop());

  // GDPR purge-retry (Task 25): each cycle, retry the pending `federation.purge`
  // requests durable in the gdpr_purge ledger; when all of a job's requests are
  // done, close it with an aggregate signed completion record + a
  // `team.purge.completed` audit entry. The anchor seed stays inside this closure
  // (never persisted/returned/logged). The concrete over-the-wire `requestPurge`
  // lands in Task 26; until then this is a no-op retry that keeps the loop,
  // attempt-counting, and job-completion machinery live.
  const { privkeyB64: anchorPrivkeyB64 } = await ensureAnchorKeypair(vault); // gitleaks:allow — Vault-resolved seed, not a literal
  const gdprPurgeRetry = startGdprPurgeRetry(db, { anchorPrivkeyB64 });
  sidecarStops.push(() => gdprPurgeRetry.stop());

  // Audit shipper (Task 19, I22): when policy configures an org SIEM endpoint
  // (`enforced().auditShipTo`), ship audit_log entries there as metadata-only
  // NDJSON — NEVER `action_json` (the no-leak guarantee; the SELECT omits it).
  // Forward-only: the shipper baselines on the current MAX(id) at start and
  // ships only entries created afterwards, so no persisted-cursor migration is
  // needed. Started after the gate so it reads the enforced policy.
  const auditShipTo = policyGate.enforced().auditShipTo;
  if (auditShipTo !== undefined && auditShipTo.length > 0) {
    const auditShipper = startAuditShipper(db, { shipTo: auditShipTo });
    sidecarStops.push(() => auditShipper.stop());
  }

  const { syncScheduler, connectorMesh } = await createSchedulerWithMesh({
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
    isConnectorAllowed,
  });

  await verifyExtensionsBestEffort(db, syncLogger, connectorMesh, { vault });

  const { runtime: autoUpdateRuntime, disabled: autoUpdateDisabled } = maybeStartAutoUpdateRuntime({
    db,
    vault,
    paths,
    connectorMesh,
    sidecarStops,
  });

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
    ...autoUpdateIpcOpts(autoUpdateRuntime, paths.configDir, autoUpdateDisabled),
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
  const federationBooted = await bootFederationIntoIpcOpts({
    federationCfg,
    paths,
    vault,
    db,
    localIndex,
    ipcOpts,
    sidecarStops,
    policyGate,
  });

  // Web-clipper (Task 7): create the SINGLETON PairingWindowController once here and inject it into
  // BOTH consumers so the IPC clip.pair and the HTTP /v1/clips/pair/confirm share the same window.
  const pairingController = new PairingWindowController({ nowMs: () => Date.now() });
  ipcOpts.clipPairingController = pairingController;
  // Give clip.pair the loopback HTTP origin so `nimbus clip pair` can print the exact URL to paste
  // into the extension. The gateway binds 127.0.0.1 (I6); the port is NIMBUS_HTTP_PORT (the same var
  // that gates the /v1/clips sidecar below). Undefined port → no HTTP surface → leave it unset.
  const clipHttpPort = parseSidecarPortEnv(processEnvGet("NIMBUS_HTTP_PORT"));
  if (clipHttpPort !== undefined) {
    ipcOpts.clipHttpBaseUrl = `http://127.0.0.1:${clipHttpPort}`;
  }

  const httpSidecarOpts: HttpSidecarOpts = {
    clipsVault: vault,
    pairingController,
    ...(scheduleItemEmbedding === undefined ? {} : { scheduleEmbedding: scheduleItemEmbedding }),
  };
  const identityBoot = bootIdentityIntoIpcOpts({
    configDir: paths.configDir,
    localIndex,
    vault,
    syncLogger,
    ipcOpts,
    httpSidecarOpts,
  });
  // Bind the late-bound operator-validity guard used by the Wave 7b team-credential sync path (I18).
  identityBootRefHolder.current = identityBoot;

  const chatopsCfg = loadNimbusChatopsFromConfigDir(paths.configDir);

  const tribalCfg = loadNimbusTribalFromConfigDir(paths.configDir);
  // The chatops↔tribal cycle's late-bound `send` seam: `buildTribalBoot`'s `send` closure reads
  // `tribalSendHolder.current` at post time; it's rebound to chatopsBoot.replyTo below once
  // chatops boots. Without chatops it stays the no-op (detection still records clusters; CLI
  // capture works; only auto-suggestion posts are suppressed).
  const tribalSendHolder: { current: (target: ReplyTarget, text: string) => Promise<void> } = {
    current: async () => {},
  };
  let chatopsBoot: ChatopsBoot | undefined;
  // Tribal-knowledge watcher (Phase 6 Slice 6c). Built BEFORE chatops so its `onInboundMessage`
  // fan-out can be wired into buildChatopsBoot. Extracted into bootTribalKnowledge to keep this
  // function's cognitive complexity in budget; the chatops↔tribal cycle is preserved via the
  // shared `tribalSendHolder` (reply seam) and the `() => chatopsBoot` getter (the in-chat capture
  // interceptor reads it at message time — chatopsBoot is assigned just below).
  const tribal = tribalCfg.enabled
    ? await bootTribalKnowledge({
        tribalCfg,
        chatopsCfg,
        rt,
        db,
        syncLogger,
        localIndex,
        connectorMesh,
        ipcOpts,
        sendHolder: tribalSendHolder,
        getChatopsBoot: () => chatopsBoot,
      })
    : undefined;
  const tribalBoot: TribalBoot | undefined = tribal?.tribalBoot;
  const tribalInterceptCommand: ((m: ChatMessage) => Promise<boolean>) | undefined =
    tribal?.tribalInterceptCommand;

  // ChatOps (Phase 6 Slice 5 boot wiring — the deferred follow-up of PR #559). When
  // [chatops].enabled, build the Slack/Teams bot graph: bot-credentialed connector invocation
  // (Team-Vault entry `[chatops].bot_vault_entry`, I19 pattern), identity mapping over the Slice 3
  // SCIM store (I18), policy resolvers from the I22 gate, the real HITL executor (I2/I20), and the
  // bounded I23 reply surface. The engine read path is late-bound in src/index.ts (the engine agent
  // does not exist yet); the local-consent fallback binds to the delegated-approval broker after
  // the IPC server exists. Identity disabled → every chat user resolves unmapped (fail-closed).
  // (`chatopsBoot` is declared above so the tribal in-chat capture interceptor can late-bind to it.)
  chatopsBoot = bootChatopsIntoAssembly({
    chatopsCfg,
    policyGate,
    tribalBoot,
    tribalInterceptCommand,
    identityBoot,
    vault,
    paths,
    db,
    connectorMesh,
    syncLogger,
    ipcOpts,
    httpSidecarOpts,
    sidecarStops,
    tribalSendHolder,
  });

  // Observability snapshot (Task 15). Cheap, synchronous readers assembled here where every
  // subsystem is in scope. Wired into BOTH the IPC server (admin.status) and the read-only HTTP
  // server (GET /v1/admin/status + GET /metrics, bearer-gated). Real where one accessor away;
  // conservative defaults stand in for fields with no cheap accessor (documented inline).
  const statusReaders = buildStatusReaders({
    db,
    policyGate,
    localIndex,
    isConnectorAllowed,
    ...(identityBoot === undefined ? {} : { identityBoot }),
  });
  ipcOpts.statusReaders = statusReaders;
  httpSidecarOpts.statusReaders = statusReaders;
  // Admin/metrics bearer = the I13 HTTP write-surface token (vault key http_api.deployment_token).
  // No dedicated admin token exists, so the observability surface reuses the same constant-time
  // mechanism; "" (key absent) → requireBearer fails closed (surfaceDisabled), routes 401.
  httpSidecarOpts.resolveAdminToken = async (): Promise<string> =>
    (await vault.get(HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY)) ?? "";

  // Anchor policy write surface (Task 18b): PUT /v1/admin/policy. The closure resolves the
  // Vault-only anchor signing keypair (generated on first use) and delegates all validate+sign+
  // persist+apply logic to policy/policy-author.ts — the HTTP route never parses TOML (D16). The
  // privkey stays inside this closure's call frame: never persisted, returned, or logged.
  httpSidecarOpts.authorPolicy = async (toml: string): Promise<AuthorResult> => {
    const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);
    return authorPolicy(
      { store: policyStore, gate: policyGate, db, privkeyB64, pubkeyB64, nowMs: Date.now() },
      toml,
    );
  };

  // policy.* + team.purge IPC namespace (Task 26, Lanes A–G integration hub) — see buildPolicyRpcCtx.
  ipcOpts.policyRpcCtx = buildPolicyRpcCtx({
    db,
    vault,
    localIndex,
    policyStore,
    policyGate,
    identityBoot,
  });

  // Share & Virality (Phase 6 Slice 8, Task 10). The dependency seam behind the share.* IPC
  // namespace. requestApproval routes to the owner consent broker (I27) — fail-closed on
  // timeout/deny: a denied/expired approval persists + signs NOTHING. The broker's setBroadcast is
  // bound UNCONDITIONALLY below (after the IPC server exists), so the owner is prompted even with
  // federation off. The sink config is the config-pinned [share.http_sink] (the only host --http may
  // target; the bearer token is Vault-only). collectSession pre-resolves turns from the
  // session-memory store + tool calls (with their SECRET-redacted input params, V42) from
  // tool_call_log. The share-gate applies the full PII redaction set on top before any share leaves
  // the machine.
  const shareHttpSink = loadNimbusShareHttpSink(paths.configDir);
  ipcOpts.shareRpcCtx = {
    db,
    vault,
    label: os.hostname(),
    now: () => Date.now(),
    collectSession: async (sessionId) => {
      const rawTurns =
        sessionMemoryStore === undefined
          ? []
          : await sessionMemoryStore.getRecentTurns(sessionId, 200);
      const turns = rawTurns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({
          role: t.role as "user" | "assistant",
          text: t.text,
          timestamp: t.createdAt,
        }));
      const toolCalls = readToolCallLog(db, { sessionId, limit: 1000 }).toolCalls.map((tc) => ({
        toolId: tc.toolId,
        service: tc.service,
        params: tc.params,
        status: tc.status,
      }));
      return { turns, toolCalls };
    },
    requestApproval: (sessionId, kind, sink, preview, redactionSet) =>
      shareConsent.request(
        { sessionId, kind, preview, redactionSet, sink },
        (ipcOpts.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000,
      ),
    recordAudit: (entry) => appendAuditEntry(db, entry),
    respondApproval: (requestId, approved) => shareConsent.respond(requestId, approved),
    httpSink: shareHttpSink,
    // Slice 8c replay: the live connector tool map. share.replay re-runs only read-only-classified
    // tools (read-tool-registry) against it; an uninstalled connector → missing-connector.
    listReplayTools: () => connectorMesh.listToolsForDispatcher(),
    // 8d origin emit: deliver share.create --to-peer over the wire. Lazily reads the federation-wired
    // closure at call time (ordering-independent); false when federation is disabled/peer unreachable.
    deliverToPeer: async (share, peerId) =>
      (await ipcOpts.shareDeliverToPeer?.(share, peerId)) ?? false,
  };

  // I29 (S1 egress ledger): the read/verify/prove/prune surface behind the egress.* IPC namespace.
  // The 4 read verbs are pure reads; proveWindow signs with the Vault-only share keypair only on
  // sign:true. `requestPruneApproval` is the fail-closed DEFAULT (deny) — the dispatcher overrides it
  // per-request, binding the LOCAL owner's HITL consent gate to the calling client (egress.prune is
  // in the I2 frozen set). So prune is never approved unless an owner answers the gate.
  const egressRpcCtx: EgressRpcCtx = {
    db,
    vault,
    now: () => Date.now(),
    requestPruneApproval: () => Promise.resolve(false),
  };
  ipcOpts.egressRpcCtx = egressRpcCtx;

  collectSidecarsFromEnv(db, paths, sidecarStops, httpSidecarOpts);

  const ipc = createIpcServer(ipcOpts);

  // I27 (Slice 8): the share-publish approval prompt reaches the local owner via the broadcast
  // channel; they answer with `nimbus share approve <id>` → share.approvalRespond. UNCONDITIONAL
  // (NOT federation-gated) — sharing to a file/http sink works with federation disabled; a missing
  // binding would leave the broker's broadcast a no-op → every approval times out → silent deny.
  shareConsent.setBroadcast((method, params) => ipc.broadcast(method, asBroadcastParams(params)));

  if (federationBooted) {
    federationConsent.setBroadcast((method, params) =>
      ipc.broadcast(method, asBroadcastParams(params)),
    );
    // I24 (Slice 6b): the inbound-preflight approval prompt reaches the local owner via the same
    // broadcast channel; they answer with `nimbus preflight approve <id>` → federation.preflightRespond.
    preflightConsent.setBroadcast((method, params) =>
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

  if (chatopsBoot !== undefined) {
    // I20 fallback leg: when the chat-routed approval is not honored (timeout / non-owner /
    // identity-invalid click), the executor falls back to the LOCAL owner — surfaced through the
    // same delegated-approval broker the CLI/UI answer (`nimbus team approve`). Re-bound here so
    // the fallback works even when chatops is enabled without federation. No subscriber /
    // timeout → false → the gate records a fail-closed rejection.
    delegatedApprovalBroker.setBroadcast((requestId, prompt) =>
      ipc.broadcast("federation.approvalRequest", { requestId, prompt }),
    );
    chatopsBoot.bindLocalConsent(async (prompt) => {
      const r = await delegatedApprovalBroker.request({ prompt }, CHATOPS_LOCAL_CONSENT_TIMEOUT_MS);
      return r.kind === "answered" ? r.approved : false;
    });
    // Headless gateway: the bot comes up with the gateway. A failed transport start (e.g. bot
    // tokens not yet provisioned) is logged and retryable via `nimbus chatops start`.
    void chatopsBoot.service
      .start()
      .catch((err: unknown) =>
        syncLogger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "chatops: transport start failed (provision bot tokens, then `nimbus chatops start`)",
        ),
      );
  }

  wireUpdaterIntoIpc(paths.configDir, ipc, syncLogger);

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
    connectorWriteDeps,
    ...(sessionMemoryStore === undefined ? {} : { sessionMemoryStore }),
    ...(federationBooted === undefined ? {} : { executorDelegation: federationBooted }),
    ...(chatopsBoot === undefined ? {} : { chatops: chatopsBoot }),
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
