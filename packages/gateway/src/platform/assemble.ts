import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Logger } from "pino";
import { startAuditShipper } from "../audit/audit-shipper.ts";
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
import { getAllConnectorHealth } from "../connectors/health.ts";
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
import { NamespaceStore } from "../federation/namespace-store.ts";
import { buildIdentityBoot } from "../identity/identity-boot.ts";
import { isOperatorValid } from "../identity/verifier.ts";
import {
  LocalIndex,
  type LocalIndexOptions,
  type SemanticSearchDeps,
} from "../index/local-index.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import type { StatusReaders } from "../ipc/admin-status-rpc.ts";
import { resumePendingRemovals } from "../ipc/connector-rpc-handlers/index.ts";
import { HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY } from "../ipc/http-auth.ts";
import { startReadOnlyHttpServer } from "../ipc/http-server.ts";
import { createIpcServer } from "../ipc/index.ts";
import { startMetricsServer } from "../ipc/metrics-server.ts";
import type { PolicyRpcCtx } from "../ipc/policy-rpc.ts";
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

interface HttpSidecarOpts {
  resolveScimToken?: () => Promise<string>;
  statusReaders?: StatusReaders;
  resolveAdminToken?: () => Promise<string>;
  authorPolicy?: (toml: string) => Promise<AuthorResult>;
}

function collectSidecarsFromEnv(
  db: Database,
  paths: PlatformPaths,
  sidecarStops: Array<() => void>,
  httpOpts: HttpSidecarOpts = {},
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
          ...(httpOpts.statusReaders === undefined
            ? {}
            : { statusReaders: httpOpts.statusReaders }),
          ...(httpOpts.resolveAdminToken === undefined
            ? {}
            : { resolveAdminToken: httpOpts.resolveAdminToken }),
          ...(httpOpts.authorPolicy === undefined ? {} : { authorPolicy: httpOpts.authorPolicy }),
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
  const httpSidecarOpts: HttpSidecarOpts = {};
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

  // policy.* + team.purge IPC namespace (Task 26, Lanes A–G integration hub). The local IPC socket is
  // operator/owner-trusted, so isAnchor is true for local calls (signing makes this gateway an anchor;
  // a purge is operator-only). The GDPR purge deps wire the REAL local-side capabilities:
  //   resolvePeer            → identity binding store (externalId → active peer ids; first wins)
  //   revokeAllGrants        → NamespaceStore.revokeAllForPeer (confirmed grant-revocation sweep)
  //   deleteLocalContributions → same sweep's count (item-level row deletion has no confirmed accessor;
  //                              grant-revocation is the confirmed local effect — see report)
  //   knownPeers             → localIndex.listLanPeers (paired peers fan out one purge request each)
  // resolvePeer returns undefined when identity is disabled / unbound → startPurge throws (fail-closed).
  const purgeNamespaceStore = new NamespaceStore(db);
  const purgeJobStore = new GdprPurgeStore(db);
  let purgeJobCounter = 0;
  const policyRpcCtx: PolicyRpcCtx = {
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
  ipcOpts.policyRpcCtx = policyRpcCtx;

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
