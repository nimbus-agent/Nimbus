import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Logger } from "pino";
import { type AgentHttpInvoker, buildAgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";
import { AgentRunController } from "../agent-runs/agent-run-store.ts";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import { startAuditShipper } from "../audit/audit-shipper.ts";
import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
} from "../automation/watcher-engine.ts";
import { createBriefIndexSearch } from "../briefs/brief-index-search.ts";
import { createBriefLlm } from "../briefs/brief-llm-adapter.ts";
import { buildRegistry } from "../briefs/brief-registry.ts";
import { BriefRunController } from "../briefs/brief-run-store.ts";
import { saveBriefReport } from "../briefs/brief-save.ts";
import { runSynthesis } from "../briefs/brief-synthesis.ts";
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
  DEFAULT_NIMBUS_LLM_TOML,
  loadNimbusAuditFromConfigDir,
  loadNimbusAutomationFromConfigDir,
  loadNimbusBriefsFromPath,
  loadNimbusChatopsFromConfigDir,
  loadNimbusCodeExecutionFromConfigDir,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusOwnershipFromConfigDir,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPreflightFromConfigDir,
  loadNimbusPremortemFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusScimFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusTribalFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
  type NimbusChatopsToml,
  type NimbusLlmLocalRoute,
  type NimbusLlmRemoteVendor,
  type NimbusLlmToml,
  type NimbusTribalToml,
  resolveNimbusTomlForProfile,
  type TeamCredentialConnector,
} from "../config/nimbus-toml.ts";
import { loadNimbusWorkdayFromConfigDir } from "../config/nimbus-toml-workday.ts";
import { resolvePersona } from "../config/persona.ts";
import { ProfileManager } from "../config/profiles.ts";
import { loadNimbusSessionFromPath } from "../config/session-toml.ts";
import { Config } from "../config.ts";
import { bitbucketFetchOneUrlIsSupported } from "../connectors/bitbucket-sync.ts";
import { createBlameIndexSyncable } from "../connectors/blame-index-sync.ts";
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
import { githubFetchOneUrlIsSupported } from "../connectors/github-sync.ts";
import { gitlabFetchOneUrlIsSupported } from "../connectors/gitlab-sync.ts";
import { getAllConnectorHealth } from "../connectors/health.ts";
import { createConnectorDispatcher } from "../connectors/index.ts";
import { jenkinsFetchOneUrlIsSupported } from "../connectors/jenkins-sync.ts";
import { jiraConfiguredBaseUrl, jiraFetchOneUrlIsSupported } from "../connectors/jira-sync.ts";
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
import { rebuildDecisions, runDecisionPass } from "../decisions/decision-extract.ts";
import { createDecisionLlm, type DecisionLlm } from "../decisions/decision-llm-adapter.ts";
import { createDecisionRefresher, type DecisionRefresher } from "../decisions/decision-refresh.ts";
import { appendBootMarker } from "../egress/egress-boot-marker.ts";
import { type CoverageVector, THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { recordFetchOutcomeEgress } from "../egress/outcome-egress.ts";
import { recordSyncEgress } from "../egress/sync-egress.ts";
import { createEmbeddingRuntimeNonBlocking } from "../embedding/create-embedding-runtime.ts";
import {
  type EmbeddingReadiness,
  embedQueryBestEffort,
  embedQueryDualBestEffort,
} from "../embedding/embedding-readiness.ts";
import type { EmbeddingRuntime as ConcreteEmbeddingRuntime } from "../embedding/embedding-runtime.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { buildDelegatedRequestRemote } from "../engine/delegated-request-remote.ts";
import { DelegationStore } from "../engine/delegation-store.ts";
import {
  type ExecutorDelegationDep,
  type ExecutorPolicyDep,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "../engine/executor.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import type { ConnectorDispatcher } from "../engine/types.ts";
import { execConsent } from "../exec/exec-consent-broker.ts";
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
import type { ConsolidatorLlm } from "../glossary/glossary-consolidate.ts";
import { rebuildGlossary, runGlossaryPass } from "../glossary/glossary-extract.ts";
import { createGlossaryLlm } from "../glossary/glossary-llm-adapter.ts";
import { createGlossaryRefresher, type GlossaryRefresher } from "../glossary/glossary-refresh.ts";
import { buildIdentityBoot } from "../identity/identity-boot.ts";
import { buildTeamsBotJwtValidator } from "../identity/teams-bot-jwt.ts";
import { isOperatorValid } from "../identity/verifier.ts";
import {
  LocalIndex,
  type LocalIndexOptions,
  type SemanticSearchDeps,
} from "../index/local-index.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import {
  gitAwareRootPaths,
  loadRegisteredRoots,
  mergeRoots,
} from "../index/registered-roots-store.ts";
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
import { AnthropicProvider } from "../llm/anthropic-provider.ts";
import { isLoopbackBaseUrl } from "../llm/base-url-locality.ts";
import type { ApiKeyResolver, CloudProviderOptions } from "../llm/cloud-provider-base.ts";
import { GeminiProvider } from "../llm/gemini-provider.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { OpenAiProvider } from "../llm/openai-provider.ts";
import { LlmRegistry } from "../llm/registry.ts";
import { makeRouteId, parseRouteRef } from "../llm/route-id.ts";
import type { LlmProvider } from "../llm/types.ts";
import { vendorApiKeyName } from "../llm/vendor-vault-keys.ts";
import { XaiProvider } from "../llm/xai-provider.ts";
import { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import {
  createOwnershipRefresher,
  type OwnershipRefresher,
} from "../ownership/ownership-refresh.ts";
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
import { isHitlRequiredByPolicy, resolveQuorumRule } from "../policy/quorum-override.ts";
import { runPremortemPass } from "../premortem/premortem-pass.ts";
import {
  createPremortemRefresher,
  type PremortemRefresher,
} from "../premortem/premortem-refresh.ts";
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
import {
  deriveFetchHostMap,
  type FetchableService,
  serviceForHost,
} from "../sync/fetch-host-boundary.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import { type TargetedFetchOutcome, targetedFetch } from "../sync/targeted-fetch.ts";
import type { SyncContext, SyncRuntimeContext } from "../sync/types.ts";
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
import { reapAppContainersAtBoot } from "./sandbox/win32-reap.ts";
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

/**
 * The ONLY `NotificationService` implementation in the tree: OS notification delivery
 * is **not implemented on any platform**. `win32.ts`, `darwin.ts` and `linux.ts` all
 * delegate to `assemblePlatformServices`, so this no-op is what every install runs —
 * there is no per-platform variant to find. Tracked in `docs/ecosystem-roadmap.md`
 * ("OS notification delivery", effort S per platform).
 *
 * What this does NOT mean: no alert is lost. All three producers — repeated sync
 * failure, connector auth loss, and a watcher fire — write durable state BEFORE they
 * call `show()`. A fire is persisted by `insertWatcherEvent` + `updateWatcherLastFired`
 * one statement ahead of the notify; auth loss is persisted by `transitionHealth` to
 * `sync_state.health_state`, `last_error` and a `connector_health_history` row. Both
 * then surface through `nimbus connector list`/`status`/`history`, `nimbus doctor`, the
 * TUI, the Tauri tray, and agent `connectorHealthCaveat` strings. What is missing is
 * the unattended PUSH channel, not the data.
 *
 * The log line makes the gap observable instead of silent. It logs the TITLE ONLY, and
 * deliberately not the body: watcher bodies interpolate `fired.summary`
 * (`${service}: ${item title}`) straight from the index, so logging them would write
 * indexed item titles into `logDir`. `gateway-log-redact.ts` scrubs secrets, not
 * arbitrary indexed content, so it is not a backstop here. The three titles are fixed
 * strings and carry the full signal.
 */
export function createUnimplementedNotifications(logger: Logger): NotificationService {
  return {
    async show(title: string, _body: string): Promise<void> {
      logger.info(
        { event: "notification.dropped", title },
        "OS notification not delivered (no platform implementation); the underlying event is still persisted and readable",
      );
    },
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

type EmbeddingRuntime = ConcreteEmbeddingRuntime | null;

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

/**
 * #928 — bind-first. This used to `await` the embedding runtime, which on a cold machine
 * awaited a MiniLM fetch from a third-party CDN: the IPC socket stayed unbound for as long
 * as the download took (up to the 600 s worker init window), and `nimbus init` looked hung.
 * `createEmbeddingRuntimeNonBlocking` returns on the same tick and warms up in the background,
 * so assembly reaches `ipc.start()` immediately.
 */
function createLocalIndexWithEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  vault: NimbusVault,
  syncLogger: Logger,
  activeTomlPath: string,
): {
  localIndex: LocalIndex;
  scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  rt: EmbeddingRuntime;
} {
  const tomlEmbedding = loadNimbusEmbeddingFromPath(activeTomlPath);
  process.stdout.write("[gateway] starting embedding runtime (background)\n");
  const rt = createEmbeddingRuntimeNonBlocking(
    db,
    paths,
    syncLogger,
    tomlEmbedding,
    Config.embeddingsEnabled,
    vault,
  );
  let scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  let semanticSearch: SemanticSearchDeps | undefined;
  if (rt) {
    scheduleItemEmbedding = rt.scheduleItemEmbedding.bind(rt);
    // DELIBERATE degradation seam. `searchRankedAsync` runs on every ask/agent/brief path, and
    // a warming throw there would take `nimbus ask` down for the length of the model download.
    // It therefore degrades to BM25 while warming — and the warm-up is NOT hidden: the
    // `index.searchRanked` RPC checks `embeddingReadiness()` first and returns the typed
    // warming condition rather than a lexical-only result the caller would read as complete.
    semanticSearch = {
      model: rt.getEmbeddingModel(),
      embedQuery: (text: string) => embedQueryBestEffort(rt, text),
      embedQueryDual: (text: string) => embedQueryDualBestEffort(rt, text),
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
          // Best-effort by design: session-memory recall ADDS optional context and never
          // reports "no results" to a human, so a warming model degrades it rather than
          // failing the turn. Explicit, not accidental (#928).
          embedText: (t) => embedQueryBestEffort(rt, t),
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
  tomlRoots: ReturnType<typeof loadNimbusFilesystemRootsFromConfigDir>,
  registeredRoots: ReturnType<typeof loadNimbusFilesystemRootsFromConfigDir>,
): void {
  // filesystem-v2 (git commits + optional symbols/deps per the root's own flags) and the blame
  // indexer act on the full set — a CLI-registered blame root needs git_commit items so its blame
  // SHAs resolve (the why-lens join). TOML wins on collision; a missing folder is dropped.
  const allRoots = mergeRoots(tomlRoots, registeredRoots);
  if (allRoots.length > 0) {
    localIndex.ensureConnectorSchedulerRegistration("filesystem", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createFilesystemV2Syncable({ roots: allRoots }));
    localIndex.ensureConnectorSchedulerRegistration("blame", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createBlameIndexSyncable({ roots: allRoots }));
  }
  // OpenAPI spec indexing and Obsidian vault semantics are opt-in via [[filesystem.roots]] only:
  // `nimbus index add <repo>` registers a blame/index root, NOT an API-spec source or a note vault.
  if (tomlRoots.length > 0) {
    localIndex.ensureConnectorSchedulerRegistration("openapi", 10 * 60 * 1000, Date.now());
    syncScheduler.register(
      createOpenapiIndexerSyncable({
        roots: tomlRoots,
        config: loadOpenapiConfig(configDir),
      }),
    );
    localIndex.ensureConnectorSchedulerRegistration("obsidian", 10 * 60 * 1000, Date.now());
    syncScheduler.register(createObsidianSyncable({ roots: tomlRoots }));
  }
}

interface SchedulerWithMeshOpts {
  paths: PlatformPaths;
  vault: NimbusVault;
  db: Database;
  syncContext: SyncRuntimeContext;
  localIndex: LocalIndex;
  notifications: NotificationService;
  syncLogger: Logger;
  isConnectorAllowed: (serviceId: string) => boolean;
  /**
   * Local-only consolidation model for the glossary pass. Optional so tests and
   * degraded boots keep the snippet path. Gated below on `[glossary].use_llm`.
   */
  glossaryLlm?: ConsolidatorLlm;
  /**
   * Local-only extraction model for the decisions pass. Optional so tests and
   * degraded boots keep the snippet path. Gated below on `[decisions].use_llm`.
   */
  decisionLlm?: DecisionLlm;
}

async function createSchedulerWithMesh(opts: SchedulerWithMeshOpts): Promise<{
  syncScheduler: SyncScheduler;
  connectorMesh: LazyConnectorMesh;
  glossaryRefresher: GlossaryRefresher;
  decisionsRefresher: DecisionRefresher | undefined;
  ownershipRefresher: OwnershipRefresher | undefined;
  premortemRefresher: PremortemRefresher | undefined;
}> {
  const {
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
    isConnectorAllowed,
    glossaryLlm,
    decisionLlm,
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

  const glossaryCfg = loadNimbusGlossaryFromConfigDir(paths.configDir);
  // Gate at the point of use, so the single config read stays single.
  const consolidationLlm = glossaryCfg.useLlm ? glossaryLlm : undefined;
  const glossaryRefresher = createGlossaryRefresher({
    enabled: glossaryCfg.enabled,
    debounceMs: glossaryCfg.debounceMs,
    runPass: async (signal, runOpts) => {
      const passOpts = {
        maxNewTermsPerPass: glossaryCfg.maxNewTermsPerPass,
        statsRecheckPerPass: glossaryCfg.statsRecheckPerPass,
        statsRecheckCooldownMs: glossaryCfg.statsRecheckCooldownMs,
        minDocFreq: glossaryCfg.minDocFreq,
        consolidateTimeoutMs: glossaryCfg.consolidateTimeoutMs,
        retryBaseCooldownMs: glossaryCfg.retryBaseCooldownMs,
        // Re-read every pass, unlike the numeric knobs above: authored terms
        // are content a user actively edits, so `--refresh` must apply an edit
        // without a gateway restart.
        configDir: paths.configDir,
        ...(consolidationLlm === undefined ? {} : { llm: consolidationLlm }),
        ...(runOpts.onProgress === undefined ? {} : { onProgress: runOpts.onProgress }),
        nowMs: Date.now(),
        signal,
      };
      return runOpts.rebuild
        ? await rebuildGlossary(db, passOpts)
        : await runGlossaryPass(db, passOpts);
    },
    onError: (err) => {
      syncLogger.warn({ err }, "glossary extraction pass failed");
    },
  });

  // Decisions (S1 Local Brain). Construction itself is gated on `[decisions].enabled` — unlike
  // glossaryRefresher, which is always constructed and gates internally — so a disabled decisions
  // pass leaves `decisionsRefresher` unset rather than idling.
  const decisionsCfg = loadNimbusDecisionsFromConfigDir(paths.configDir);
  // Gate at the point of use, so the single config read stays single.
  const extractionLlm = decisionsCfg.useLlm ? decisionLlm : undefined;
  const decisionsRefresher = decisionsCfg.enabled
    ? createDecisionRefresher({
        debounceMs: decisionsCfg.debounceMs,
        runPass: (runOpts) => {
          const passOpts = {
            nowMs: Date.now(),
            useLlm: decisionsCfg.useLlm,
            maxLlmCalls: decisionsCfg.maxLlmCallsPerPass,
            // `decisionsCfg.minConfidence` is deliberately NOT passed: it is a
            // read-path floor (`agents/decisions.ts`), not an extraction filter.
            retryCooldownMs: decisionsCfg.retryCooldownMs,
            ...(extractionLlm === undefined ? {} : { llm: extractionLlm }),
          };
          // `decisions.rebuild` (ipc/decisions-rpc.ts) is the only caller that ever sets
          // `rebuild: true` — the debounced post-sync `trigger()` path above never does, and
          // `decisions.refresh` always passes `false` explicitly. `rebuildDecisions` clears
          // `decision_record`/`decision_evidence`/the watermark, vetoes included, before
          // re-running — the sole recovery path for a veto, which is otherwise permanent.
          return runOpts?.rebuild ? rebuildDecisions(db, passOpts) : runDecisionPass(db, passOpts);
        },
        onError: (err) => {
          syncLogger.warn({ err }, "decision extraction pass failed");
        },
      })
    : undefined;

  // Pre-mortem theme pass (S1 Local Brain). Construction itself is gated on
  // `[premortem].enabled` — like decisionsRefresher above, not glossaryRefresher — so a
  // disabled pass leaves `premortemRefresher` unset rather than idling, and `premortem.refresh`
  // fails loudly instead of silently reporting success. `premortemCfg.maxCohortSize` /
  // `maxCandidateScan` are deliberately NOT passed to `runPremortemPass`: they feed PR B's
  // cohort-assembly read path, not this write pass, which only takes
  // `nowMs`/`maxLlmCalls`/`llm`/`signal`.
  const premortemCfg = loadNimbusPremortemFromConfigDir(paths.configDir);
  const premortemLlmForPass = premortemCfg.useLlm ? decisionLlm : undefined;
  const premortemRefresher = premortemCfg.enabled
    ? createPremortemRefresher({
        debounceMs: premortemCfg.debounceMs,
        runPass: (signal) =>
          runPremortemPass(db, {
            nowMs: Date.now(),
            maxLlmCalls: premortemCfg.maxLlmCallsPerPass,
            ...(premortemLlmForPass === undefined ? {} : { llm: premortemLlmForPass }),
            signal,
          }),
        onError: (err) => {
          syncLogger.warn({ err }, "premortem theme pass failed");
        },
      })
    : undefined;

  // Ownership graph (S1 Local Brain). Construction itself is gated on `[ownership].enabled`,
  // mirroring decisionsRefresher above — a disabled pass leaves `ownershipRefresher` unset
  // rather than idling. `runPass` re-reads BOTH the git-aware filesystem roots and the service
  // configs on every invocation, never captures them: `runOwnershipPass` clears every
  // `person --owns--> service` edge each pass and re-emits only what is reachable from
  // `opts.roots`, so a partial/stale root set would silently erase ownership for every
  // service the omitted roots would have bound (see that function's doc comment). Re-reading
  // per pass also means a `[[filesystem.roots]]` or service-config edit — or a fresh
  // `nimbus index add` — takes effect without a gateway restart.
  //
  // The root set MUST span BOTH sources: the `[[filesystem.roots]]` TOML blocks and the
  // CLI-registered roots in `registered-roots.json`. `registerFilesystemRootSyncables` runs
  // the blame indexer over the merged set, so `git_blame_line` holds rows for registered
  // roots too; passing the TOML roots alone would leave every path under a registered root
  // unowned AND erase, on every pass, the ownership of any service that root binds.
  const ownershipCfg = loadNimbusOwnershipFromConfigDir(paths.configDir);
  const ownershipRefresher = ownershipCfg.enabled
    ? createOwnershipRefresher({
        debounceMs: ownershipCfg.debounceMs,
        runPass: () => {
          const roots = gitAwareRootPaths(
            loadNimbusFilesystemRootsFromConfigDir(paths.configDir),
            loadRegisteredRoots(paths.configDir),
          );
          const serviceRepoUrns = new Map<string, readonly string[]>();
          // M-1 (see `loadServiceConfigsOrDegrade`): the raw loader THROWS on any
          // malformed `[metrics.dora.*]`/`[ci.service.*]` block. Unwrapped, one typo
          // in an unrelated DORA section would abort every pass — taking file and
          // directory ownership, which need no service config at all, down with it.
          // Degrade to zero bindings instead: the service rollup is skipped, code
          // ownership still lands.
          for (const [serviceId, svc] of loadServiceConfigsOrDegrade(paths.configDir, syncLogger)) {
            serviceRepoUrns.set(
              serviceId,
              svc.repos.map((u) => `${u.provider}:${u.providerId}`),
            );
          }
          return runOwnershipPass(db, {
            nowMs: Date.now(),
            roots,
            config: ownershipCfg,
            serviceRepoUrns,
          });
        },
        onError: (err) => {
          syncLogger.warn({ err }, "ownership derivation pass failed");
        },
      })
    : undefined;

  const syncScheduler = new SyncScheduler(syncContext, undefined, {
    notify: async (title, body) => {
      await notifications.show(title, body);
    },
    onConnectorSyncSuccess: (serviceId, result, durationMs) => {
      const at = Date.now();
      syncAnomaly.recordSample(`sync:duration_ms:${serviceId}`, durationMs, at);
      syncAnomaly.recordSample(`sync:items_upserted:${serviceId}`, result.itemsUpserted, at);
      evaluateWatchersAfterSync(db, serviceId, at, (t, b) => notifications.show(t, b), watcherOpts);
      glossaryRefresher.trigger();
      decisionsRefresher?.trigger();
      premortemRefresher?.trigger();
      ownershipRefresher?.trigger();
    },
    // I29/D22(b): the ONE production appender for the `sync` egress class — one `sync` row per
    // paginated RUN, before `connector.sync(...)` in `runJob`. Kept synchronous (`recordSyncEgress`
    // returns `undefined`, never a Promise) so a throw here aborts the run before any outbound call,
    // matching the fail-closed contract `sync/scheduler.ts`'s own doc comment states for this seam.
    appendSyncEgress: (row) => recordSyncEgress(db, { ...row, now: Date.now() }),
  });
  const tomlRoots = loadNimbusFilesystemRootsFromConfigDir(paths.configDir);
  const registeredRoots = loadRegisteredRoots(paths.configDir);
  registerFilesystemRootSyncables(
    syncScheduler,
    localIndex,
    paths.configDir,
    tomlRoots,
    registeredRoots,
  );
  const connectorMesh = await createLazyConnectorMesh(paths, vault, {
    listUserMcpConnectors: () => listUserMcpConnectors(db),
    healthDb: db,
    auditDb: db,
    logger: syncLogger,
    // Obsidian vault semantics are opt-in via [[filesystem.roots]] only — CLI-registered blame
    // roots must not be silently treated as note vaults.
    obsidianVaultPaths: tomlRoots.map((r) => r.path),
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
  return {
    syncScheduler,
    connectorMesh,
    glossaryRefresher,
    decisionsRefresher,
    ownershipRefresher,
    premortemRefresher,
  };
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
  // Research briefs (Spine S1, Task 13): threaded into ReadOnlyHttpServerOptions the same way.
  briefRuns?: BriefRunController;
  briefStartRun?: (runId: string) => void;
  briefSave?: (runId: string) => { itemId: string };
  // Agents over HTTP: the run store is a SINGLETON — the POST route opens runs in it and the GET
  // route reads them, so they must be the same object.
  agentRuns?: AgentRunController;
  agentInvoke?: AgentHttpInvoker;
  // Targeted fetch-on-miss (Task 11): threaded into ReadOnlyHttpServerOptions the same way.
  fetchItem?: (url: string) => Promise<TargetedFetchOutcome>;
  // IMPORTANT 1 fix: threaded into ReadOnlyHttpServerOptions the same way.
  resolveFetchable?: () => Promise<(host: string) => boolean>;
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
    ...(httpOpts.briefRuns === undefined ? {} : { briefRuns: httpOpts.briefRuns }),
    ...(httpOpts.briefStartRun === undefined ? {} : { briefStartRun: httpOpts.briefStartRun }),
    ...(httpOpts.briefSave === undefined ? {} : { briefSave: httpOpts.briefSave }),
    ...(httpOpts.agentRuns === undefined ? {} : { agentRuns: httpOpts.agentRuns }),
    ...(httpOpts.agentInvoke === undefined ? {} : { agentInvoke: httpOpts.agentInvoke }),
    ...(httpOpts.fetchItem === undefined ? {} : { fetchItem: httpOpts.fetchItem }),
    ...(httpOpts.resolveFetchable === undefined
      ? {}
      : { resolveFetchable: httpOpts.resolveFetchable }),
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
  // I18 — operator validity for answers served OVER THE WIRE. `identityBoot` happens AFTER this
  // function runs (bootFederationIntoIpcOpts at ~2434, bootIdentityIntoIpcOpts at ~2497), so the
  // guard has to be late-bound through the holder rather than captured, exactly as
  // `buildTeamCredentialContexts` already does for the team-credential contexts.
  identityEnabled: boolean;
  identityBootRefHolder: { current: ReturnType<typeof buildIdentityBoot> | undefined };
}

/** Boot the federation LAN server + discovery into ipcOpts when enabled. Returns true if booted
 *  (so the caller can wire the consent broadcast after the IPC server exists). */
async function bootFederationIntoIpcOpts(
  opts: BootFederationOpts,
): Promise<ExecutorDelegationDep | undefined> {
  const {
    federationCfg,
    paths,
    vault,
    db,
    localIndex,
    ipcOpts,
    sidecarStops,
    policyGate,
    identityEnabled,
    identityBootRefHolder,
  } = opts;
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
    // I18 — the operator-validity guard for answers served OVER THE WIRE.
    //
    // Every federated gate already reads it (`gate-commons.ts`, `invoke-gate.ts`,
    // `preflight-gate.ts` all test `ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()`),
    // and `ipc/server/dispatchers.ts` has always supplied it — but only on the LOCAL IPC path, i.e.
    // the owner querying their own machine, the one case where it is not needed. This 14-key object
    // literal did not include it, so `ctx.identity` was `undefined` for every peer-facing answer,
    // `undefined?.enabled === true` was false, and the branch never executed: a gateway whose
    // operator SSO session had been deprovisioned or expired past grace kept answering
    // `federation.query` / `auditExport` / `invoke` / `preflight` instead of failing closed.
    //
    // Late-bound, not captured: identity boots AFTER federation (see BootFederationOpts), so the
    // holder is read per call and fails closed until it is populated — the same shape
    // `buildTeamCredentialContexts` uses for exactly this ordering problem.
    ...(identityEnabled
      ? {
          identityGuard: {
            enabled: true,
            isOperatorValid: (): boolean => {
              const ref = identityBootRefHolder.current;
              const store = ref?.store;
              const issuer = ref?.issuer;
              if (store === undefined || issuer === undefined) return false; // unbooted → invalid
              return isOperatorValid(store, issuer, Date.now(), ref?.graceSeconds ?? 0);
            },
          },
        }
      : {}),
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
    // Empty by design: the LOCAL kill-switch for an ai_v2 capability is its own config flag
    // (`[code_execution] enabled`), which the exec gate checks separately. This baseline set is the
    // seam an org policy tightens against, and conflating the two would make a local `enabled =
    // true` look like it could argue with a policy lockoff -- which it must never be able to.
    capabilitiesDisabled: new Set<string>(),
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

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LLAMACPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/** A minimal logging seam so `buildLlmRegistryFromToml` stays independently callable (the
 *  integration test constructs it with no logger at all) while production wiring passes the real
 *  `syncLogger.warn`, matching the `log: (m) => syncLogger.warn(m)` adapter shape already used
 *  elsewhere in this file. The default is a no-op — production always supplies `syncLogger`
 *  explicitly (see the call in `assemblePlatformServices`), so a dropped-entry warning is never
 *  actually silent at boot; this default only covers callers (e.g. tests) that don't need one. */
type RouteValidationLogger = { warn: (msg: string) => void };
const defaultRouteValidationLogger: RouteValidationLogger = { warn: () => {} };

/** Resolves what base URL a `[llm.local.*]` entry actually talks to, applying the runtime's
 *  default when `base_url` is omitted and stripping a trailing slash — the form two entries must
 *  be compared in. Comparing the raw, unresolved field misses the case where BOTH entries omit
 *  `base_url`: both fields are `undefined`, but both resolve to the SAME real endpoint. */
function resolveBaseUrl(runtime: string, baseUrl: string | undefined): string {
  const explicit = baseUrl?.trim() ?? "";
  if (explicit !== "") return explicit.replace(/\/$/, "");
  return runtime === "llamacpp" ? LLAMACPP_DEFAULT_BASE_URL : OLLAMA_DEFAULT_BASE_URL;
}

const KNOWN_LOCAL_RUNTIMES = new Set(["ollama", "llamacpp"]);

/** The four cloud vendors this build knows how to CONSTRUCT an adapter for. */
const REMOTE_VENDOR_IDS = ["anthropic", "openai", "gemini", "xai"] as const;
export type RemoteVendorId = (typeof REMOTE_VENDOR_IDS)[number];

function isKnownVendorId(id: string): id is RemoteVendorId {
  return (REMOTE_VENDOR_IDS as readonly string[]).includes(id);
}

export type ResolvedRemoteVendor = {
  vendorId: RemoteVendorId;
  modelName: string;
  apiKey: ApiKeyResolver;
  baseUrl?: string;
};

/**
 * TOTAL over `RemoteVendorId`, so adding a vendor id without adding its factory is a COMPILE
 * ERROR rather than a silent fallthrough — the same shape `EGRESS_BEARING_CLIENT_KINDS` uses to
 * make a new transport a compile error instead of a missing ledger row.
 *
 * This deliberately replaces a `switch` whose `default` would construct one particular vendor: a
 * fifth id added without a case would then be built as THAT vendor's adapter while carrying the
 * new vendor's model name and reading its `<id>.api_key` — prompts posted to the wrong host under
 * a credential minted for someone else. A `default: throw` catches it at runtime; a total map
 * catches it before the code can be committed.
 */
const REMOTE_PROVIDER_FACTORIES: Record<
  RemoteVendorId,
  (opts: CloudProviderOptions) => LlmProvider
> = {
  anthropic: (opts) => new AnthropicProvider(opts),
  openai: (opts) => new OpenAiProvider(opts),
  gemini: (opts) => new GeminiProvider(opts),
  xai: (opts) => new XaiProvider(opts),
};

/** A vendor resolved far enough to construct the Mastra agent: key materialised, not a thunk. */
export type AgentVendor = { providerId: string; modelId: string; apiKey: string };

/**
 * The vendor the Mastra engine agent talks to, or `undefined` when none is enabled AND keyed.
 *
 * `undefined` is the load-bearing case: `gateway-main.ts` then does not construct the agent at
 * all. That matters because `@mastra/core` resolves `ANTHROPIC_API_KEY` from the ENVIRONMENT on
 * its own the moment an agent exists — so "constructed but refusing" would leave a hole exactly
 * the size of the default `nimbus ask`.
 *
 * FIRST enabled-and-keyed vendor in config order. The agent takes one model, unlike the route
 * table which takes all of them; picking the first keeps that deterministic and lets an operator
 * choose by ordering their `[llm.remote.*]` tables.
 *
 * The key is materialised HERE rather than passed as a resolver because Mastra's model config
 * takes a string. The cost is that a key rotated after boot needs a restart FOR THE AGENT —
 * route-table adapters still resolve per call and pick it up immediately.
 */
export async function resolveAgentVendor(
  llmToml: NimbusLlmToml,
  vault: NimbusVault,
  logger: RouteValidationLogger = defaultRouteValidationLogger,
): Promise<AgentVendor | undefined> {
  for (const vendor of resolveEnabledVendors(llmToml.remoteVendors, vault, logger)) {
    const apiKey = await vendor.apiKey();
    if (apiKey !== undefined && apiKey.trim() !== "") {
      return { providerId: vendor.vendorId, modelId: vendor.modelName, apiKey };
    }
  }
  return undefined;
}

function makeRemoteProvider(v: ResolvedRemoteVendor): LlmProvider {
  return REMOTE_PROVIDER_FACTORIES[v.vendorId]({
    apiKey: v.apiKey,
    modelName: v.modelName,
    ...(v.baseUrl === undefined ? {} : { baseUrl: v.baseUrl }),
  });
}

/**
 * Validates `[llm.remote.*]` AFTER defaults are applied, here rather than in the parser.
 *
 * DO NOT "fix" this by moving it earlier. The instinct is to validate the raw table before
 * defaults so a vendor problem can be isolated — but that moves validation TOWARD the parser, and
 * a throw there is swallowed by `loadTomlSection`'s bare catch, whose outcome is not a dropped
 * vendor but a silently reverted `[llm]` section with `enforce_air_gap` back at `false`.
 * Post-default validation loses nothing, because an absent `enabled` and an explicit
 * `enabled = false` mean the same thing — no field here needs absent-versus-explicit
 * discrimination.
 *
 * Every rejection is warn-logged BY NAME, matching `dropUnknownRuntimeEntries` above. An entry
 * that vanishes without a word is the shape `dropUnresolvableRoutePriorityEntries` refuses to
 * allow.
 */
export function resolveEnabledVendors(
  remoteVendors: ReadonlyMap<string, NimbusLlmRemoteVendor>,
  vault: NimbusVault,
  logger: RouteValidationLogger,
): ResolvedRemoteVendor[] {
  const out: ResolvedRemoteVendor[] = [];
  for (const [vendorId, cfg] of remoteVendors) {
    // Default-off. Not an error and not warned: it is the norm, and the whole point of the
    // per-vendor opt-in.
    if (!cfg.enabled) continue;
    if (!isKnownVendorId(vendorId)) {
      logger.warn(
        `[llm] dropping [llm.remote.${vendorId}]: unknown vendor — expected one of ` +
          REMOTE_VENDOR_IDS.join(", "),
      );
      continue;
    }
    if (cfg.model.trim() === "") {
      logger.warn(`[llm] dropping [llm.remote.${vendorId}]: empty model`);
      continue;
    }
    out.push({
      vendorId,
      modelName: cfg.model,
      // Resolved PER CALL from the Vault, never from the environment: no env var may satisfy a
      // vendor nobody opted into, and a key added after boot works with no restart. `VaultReader`
      // answers `null` for a miss, which is normalised to `undefined` for `ApiKeyResolver`.
      apiKey: async () => (await vault.get(vendorApiKeyName(vendorId))) ?? undefined,
      ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
    });
  }
  return out;
}

/**
 * Drops (and names, via `logger.warn`) any `[llm.local.*]` entry whose `runtime` is neither
 * `"ollama"` nor `"llamacpp"` — the only two runtimes this build knows how to construct a
 * provider for. `NimbusLlmLocalRoute.runtime` is an intentionally open string at the parser layer
 * (Task 8), so a typo or a not-yet-supported runtime (e.g. `"vllm"`) must not silently fall
 * through to the `runtime === "llamacpp" ? llamacpp : ollama` branches below and get constructed
 * as an Ollama route pointed at a port that entry never asked for.
 */
function dropUnknownRuntimeEntries(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  for (const [name, route] of localRoutes) {
    if (!KNOWN_LOCAL_RUNTIMES.has(route.runtime)) {
      logger.warn(
        `[llm] dropping [llm.local.${name}]: unknown runtime "${route.runtime}" — expected ` +
          '"ollama" or "llamacpp"',
      );
      continue;
    }
    kept.set(name, route);
  }
  return kept;
}

/**
 * Task 9's validation stage — deliberately NOT in the Task 8 parser, because a throw there is
 * swallowed by `loadTomlSection`'s bare catch and silently reverts the WHOLE `[llm]` section to
 * defaults (including `enforce_air_gap`). Here a bad entry is logged and dropped; nothing else in
 * `[llm]` is affected.
 *
 * Only a `llamacpp` base URL claimed twice is an error: `LlamaCppProvider.generate()` sends no
 * model field, so the server answers with whatever weights it was launched with — two llama.cpp
 * routes at one URL would report two different model names against IDENTICAL weights, a route
 * table that lies. Ollama is exempt: `generate()` sends `this.modelName` per request to a shared
 * daemon, so many routes at one base URL is the normal, correct case.
 *
 * First occurrence (file order — `localRoutes` preserves it) wins; every later collider is
 * dropped and logged by name.
 */
function dropLlamacppBaseUrlCollisions(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  const claimedBy = new Map<string, string>(); // resolved llamacpp base URL -> first entry name
  for (const [name, route] of localRoutes) {
    if (route.runtime === "llamacpp") {
      const resolved = resolveBaseUrl(route.runtime, route.baseUrl);
      const existing = claimedBy.get(resolved);
      if (existing !== undefined) {
        logger.warn(
          `[llm] dropping [llm.local.${name}]: llamacpp base URL "${resolved}" is already ` +
            `claimed by [llm.local.${existing}] — a llama.cpp server reports one model for the ` +
            "whole process, so two routes at the same URL would report different model names " +
            "against identical weights",
        );
        continue;
      }
      claimedBy.set(resolved, name);
    }
    kept.set(name, route);
  }
  return kept;
}

/**
 * Drops (and names) any `[llm.local.*]` entry whose derived route id — `<runtime>/<model>` — was
 * already claimed by an earlier entry. `LlmRouter.registerRoute` keys on that id and uses
 * `Map.set`, so without this stage a second entry naming the same runtime AND model at a
 * different `base_url` (a plausible failover pairing: the same model on a laptop and on a
 * workstation) silently REPLACES the first, and `nimbus llm status` shows one row pointing at the
 * second URL with nothing to explain where the other went.
 *
 * FIRST occurrence wins, matching `dropLlamacppBaseUrlCollisions` above — the two drop rules must
 * not disagree about which entry survives, or which one you get depends on which check fired.
 * Every other drop path in this slice names the offending entry; a route that vanishes without a
 * word is the exact shape `dropUnresolvableRoutePriorityEntries` refuses to allow.
 */
function dropDuplicateRouteIds(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  const claimedBy = new Map<string, string>(); // route id -> first entry name
  for (const [name, route] of localRoutes) {
    const routeId = makeRouteId(route.runtime === "llamacpp" ? "llamacpp" : "ollama", route.model);
    const existing = claimedBy.get(routeId);
    if (existing !== undefined) {
      logger.warn(
        `[llm] dropping [llm.local.${name}]: route id "${routeId}" is already claimed by ` +
          `[llm.local.${existing}] — a route is keyed on (runtime, model), so two entries ` +
          "naming the same pair are one route; keeping the first, and the later entry's " +
          "base_url is NOT used",
      );
      continue;
    }
    claimedBy.set(routeId, name);
    kept.set(name, route);
  }
  return kept;
}

/**
 * Names — in the boot log, by entry name — every `[llm.local.*]` entry whose resolved base URL is
 * NOT loopback, and is therefore registered as a REMOTE route.
 *
 * Nothing is dropped here. The reclassification itself happens in the provider constructors
 * (`OllamaProvider`/`LlamaCppProvider` derive `isLocal` from the resolved base URL — see
 * `llm/base-url-locality.ts`), which is what actually stops `[llm] enforce_air_gap` from treating
 * a LAN daemon as air-gap-eligible. This stage exists so the reclassification is never SILENT: a
 * route configured under a heading that reads `[llm.local.ws]` and then excluded by air-gap, or
 * ledgered as egress, would otherwise be inexplicable from the user's seat.
 *
 * Dropping instead of warning was the other option and is wrong: a deliberately-configured LAN
 * llama.cpp box is a legitimate setup, and it stays usable with air-gap off. What must not happen
 * is it counting as local.
 */
function warnRemoteClassifiedLocalRoutes(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): void {
  for (const [name, route] of localRoutes) {
    const resolved = resolveBaseUrl(route.runtime, route.baseUrl);
    if (isLoopbackBaseUrl(resolved)) continue;
    logger.warn(
      `[llm] [llm.local.${name}] base URL "${resolved}" is not loopback — registering it as a ` +
        "REMOTE route: prompts sent to it leave this machine, so it is excluded when " +
        "[llm] enforce_air_gap is set and its use is recorded in the egress ledger",
    );
  }
}

/**
 * Resolves `[llm] route_priority` entries against the route ids that are ACTUALLY about to be
 * registered, dropping (with a named log line) any entry that fails `parseRouteRef` or names no
 * registered route. Silence is not acceptable here: a vanished priority entry changes which model
 * answers with no outward sign.
 *
 * LIMITATION (stated, not papered over): a malformed `route_priority` VALUE — e.g.
 * `route_priority = "ollama"`, a string rather than an array — is swallowed by
 * `parseNimbusTomlLlmSection` (Task 8) with no diagnostic, and arrives here as simply unset. This
 * function only ever sees entries that PARSED as an array of strings, so it cannot distinguish
 * "not configured" from "malformed", and cannot name that entry — it validates only well-formed
 * strings that fail `parseRouteRef` or resolve to no registered route.
 */
function dropUnresolvableRoutePriorityEntries(
  routePriority: readonly string[],
  registeredRouteIds: ReadonlySet<string>,
  logger: RouteValidationLogger,
): string[] {
  const kept: string[] = [];
  for (const entry of routePriority) {
    let parsed: { providerId: string; modelName: string };
    try {
      parsed = parseRouteRef(entry);
    } catch (err) {
      logger.warn(
        `[llm] dropping route_priority entry "${entry}": malformed — ${String(err instanceof Error ? err.message : err)}`,
      );
      continue;
    }
    const routeId = makeRouteId(parsed.providerId, parsed.modelName);
    if (!registeredRouteIds.has(routeId)) {
      logger.warn(
        `[llm] dropping route_priority entry "${entry}": does not name a registered route`,
      );
      continue;
    }
    kept.push(routeId);
  }
  return kept;
}

/** Load the [llm] config from the active TOML, apply the model overrides, and build the provider
 *  registry — one route per `[llm.local.<name>]` entry when any are configured, else today's two
 *  built-in Ollama + llama.cpp providers (unchanged behaviour). Also runs the validation Task 8
 *  deliberately does not: dropping (never aborting boot on) a duplicate llamacpp base URL or an
 *  unresolvable `route_priority` entry. `logger` defaults to a no-op so this stays independently
 *  callable (e.g. from a test) without a real Gateway logger; production wiring always supplies
 *  `syncLogger`, so a dropped-entry warning is never actually silent at boot. */
export async function buildLlmRegistryFromToml(
  db: Database,
  activeTomlPath: string,
  vault: NimbusVault,
  logger: RouteValidationLogger = defaultRouteValidationLogger,
): Promise<LlmRegistry> {
  const llmToml = loadNimbusLlmFromPath(activeTomlPath);
  const knownRuntimeLocalRoutes = dropUnknownRuntimeEntries(llmToml.localRoutes, logger);
  const uncollidedLocalRoutes = dropLlamacppBaseUrlCollisions(knownRuntimeLocalRoutes, logger);
  const validatedLocalRoutes = dropDuplicateRouteIds(uncollidedLocalRoutes, logger);
  warnRemoteClassifiedLocalRoutes(validatedLocalRoutes, logger);

  // `local_model = ""` parses to the empty string and survives `loadNimbusLlmFromPath` (the
  // `[llm]` parser assigns `parseString(valRaw)` unconditionally). It then reaches
  // `makeRouteId`, which THROWS on an empty model name — and this function is called from
  // `assemblePlatformServices` with nothing between it and boot, so a one-character config typo
  // took the whole Gateway down with `modelName must not be empty`. Nothing in assembly may
  // abort boot: keep the shipped default and say so by name.
  const localModel = llmToml.localModel.trim();
  const effectiveLocalModel =
    localModel === "" ? DEFAULT_NIMBUS_LLM_TOML.localModel : llmToml.localModel;
  if (localModel === "") {
    logger.warn(
      `[llm] local_model is empty — keeping the default "${DEFAULT_NIMBUS_LLM_TOML.localModel}"; ` +
        "an empty model name cannot name a route",
    );
  }

  // The route ids that WILL be registered below — computed up front (without touching the
  // registry) so route_priority can be validated against the real, post-collision-check set
  // before the router is constructed, since `LlmRouterConfig.routePriority` is set at
  // construction time.
  const localRouteIdsToRegister: string[] =
    validatedLocalRoutes.size > 0
      ? [...validatedLocalRoutes.values()].map((route) =>
          makeRouteId(route.runtime === "llamacpp" ? "llamacpp" : "ollama", route.model),
        )
      : [makeRouteId("ollama", effectiveLocalModel), makeRouteId("llamacpp", effectiveLocalModel)];

  // REMOTE route ids belong in this set too, and leaving them out was a real bug: the vendor
  // loop registers them AFTER the router is constructed, but `routePriority` is frozen into
  // `LlmRouterConfig` at construction — so a `[llm.remote.*]` id named in `route_priority` was
  // dropped as "does not name a registered route" and could never be honoured. With
  // `prefer_local = true` that left an enabled cloud vendor effectively unreachable, since
  // `byPreference` always put the local routes first.
  //
  // Keyless vendors are INCLUDED here on purpose. Whether a key resolves is not known until the
  // async registration loop below, and over-including is safe: `orderedRoutes` skips an id that
  // did not end up registered, and the vendor loop warns by name when it drops one. Excluding
  // them would resurrect this bug for anyone whose key arrives after boot.
  // Resolved ONCE and reused by the registration loop below: `resolveEnabledVendors` warns by
  // name for an unknown vendor or an empty model, so calling it twice would emit every warning
  // twice.
  const enabledVendors = resolveEnabledVendors(llmToml.remoteVendors, vault, logger);
  const remoteRouteIdsToRegister: string[] = enabledVendors.map((v) =>
    makeRouteId(v.vendorId, v.modelName),
  );

  const routeIdsToRegister: string[] = [...localRouteIdsToRegister, ...remoteRouteIdsToRegister];

  const validatedRoutePriority = dropUnresolvableRoutePriorityEntries(
    llmToml.routePriority,
    new Set(routeIdsToRegister),
    logger,
  );

  const llmRegistry = new LlmRegistry({
    db,
    config: {
      preferLocal: llmToml.preferLocal,
      localModel: effectiveLocalModel,
      minReasoningParams: llmToml.minReasoningParams,
      enforceAirGap: llmToml.enforceAirGap,
      routePriority: validatedRoutePriority,
      // Unlike `routePriority`, an unresolvable entry is NOT dropped here: the router's own
      // `orderedRoutes` already fails open on a pin naming an unregistered or unavailable route
      // (falls through to normal ordering, never comes up empty), so pre-validating against
      // `routeIdsToRegister` would only duplicate that behaviour with a warn-log for a case that
      // is expected to happen routinely (a pinned local model that has not been pulled yet, or a
      // pinned vendor route that is momentarily down).
      //
      // Spread-conditional, not `taskPins: llmToml.taskPins`: under `exactOptionalPropertyTypes`
      // an explicit `taskPins: undefined` is a different type from an absent key.
      ...(llmToml.taskPins === undefined ? {} : { taskPins: llmToml.taskPins }),
    },
  });

  if (validatedLocalRoutes.size > 0) {
    for (const route of validatedLocalRoutes.values()) {
      const baseUrl = resolveBaseUrl(route.runtime, route.baseUrl);
      if (route.runtime === "llamacpp") {
        llmRegistry.addRoute(new LlamaCppProvider(baseUrl, route.model), route.model);
      } else {
        llmRegistry.addRoute(
          new OllamaProvider(baseUrl, route.model, llmToml.localContextTokens),
          route.model,
        );
      }
    }
  } else {
    llmRegistry.addRoute(
      new OllamaProvider(OLLAMA_DEFAULT_BASE_URL, effectiveLocalModel, llmToml.localContextTokens),
      effectiveLocalModel,
    );
    const llamacppBaseUrl = llmToml.llamacppServerPath.trim();
    // The legacy single-route path reaches the same hazard through a different key: an
    // `[llm] llamacpp_server_path` pointed at a LAN box also produces a non-local provider now,
    // and that must be as visible here as it is for a `[llm.local.*]` entry.
    if (llamacppBaseUrl !== "" && !isLoopbackBaseUrl(llamacppBaseUrl)) {
      logger.warn(
        `[llm] llamacpp_server_path "${llamacppBaseUrl}" is not loopback — registering the ` +
          "llama.cpp route as REMOTE: it is excluded when [llm] enforce_air_gap is set",
      );
    }
    llmRegistry.addRoute(
      new LlamaCppProvider(
        llamacppBaseUrl === "" ? undefined : llamacppBaseUrl,
        effectiveLocalModel,
      ),
      effectiveLocalModel,
    );
  }
  // Fill in `parameterCount` so `[llm] min_reasoning_params` can fire at all (F8). Fire-and-
  // forget: nothing downstream blocks on it, and a provider that is down simply leaves the floor
  // fail-open exactly as it was. Called with NO argument — one pass over every registered local
  // route, each matched against its OWN `route.modelName` inside `refreshProviderMeta` — never a
  // single shared name looped across all routes (Task 9 review, finding 1: that shape cross-
  // assigned one route's parameterCount onto another route sharing the same daemon). One
  // `listModels()` call per local route, not per route × distinct model name.
  // Registering a vendor HERE is what turns I29's `model` egress class from wired-but-zero-row
  // into a live one: `addRoute` passes every non-local provider through `wrapLedgeredProvider`
  // (slice 2a), so each of these routes ledgers before every generate without the adapter
  // cooperating. A vendor that is enabled but whose key does not resolve is dropped with a
  // warning rather than registered, so a keyless route never enters the priority walk at all.
  for (const vendor of enabledVendors) {
    const key = await vendor.apiKey();
    if (key === undefined || key.trim() === "") {
      logger.warn(
        `[llm] dropping [llm.remote.${vendor.vendorId}]: enabled but no ` +
          `${vendorApiKeyName(vendor.vendorId)} in the Vault`,
      );
      continue;
    }
    llmRegistry.addRoute(makeRemoteProvider(vendor), vendor.modelName);
  }

  void llmRegistry.refreshProviderMeta();
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
      // Best-effort: tribal clustering degrades to no-match while the model warms (#928).
      embeddingRt == null ? Promise.resolve(null) : embedQueryBestEffort(embeddingRt, text),
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
      // I22: same org-policy overlay the IPC executors get. Read from `ipcOpts` rather than
      // closed over, because this function is handed `ipcOpts` and nothing else policy-shaped.
      ipcOpts.policyHitl ?? NO_POLICY_OVERLAY,
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
async function bootChatopsIntoAssembly(deps: {
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
}): Promise<ChatopsBoot | undefined> {
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
  const chatopsBoot = await buildChatopsBoot({
    cfg: chatopsCfg,
    db,
    vault,
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

/**
 * M-1: `loadNimbusServiceConfigsFromConfigDir` throws on any malformed
 * `[metrics.dora.*]`/`[ci.service.*]` block (missing `repos`, unknown key, bad
 * URN/regex, out-of-range window, invalid env name). Degrade to no service-identity
 * bindings (timeline correlation falls back to plain `metadata.service`, as before
 * this feature existed) rather than aborting gateway startup over a config typo.
 */
function loadServiceConfigsOrDegrade(
  configDir: string,
  logger: Logger,
): ReturnType<typeof loadNimbusServiceConfigsFromConfigDir> {
  try {
    return loadNimbusServiceConfigsFromConfigDir(configDir);
  } catch (err) {
    logger.warn(
      { err },
      "failed to load [metrics.dora.*]/[ci.service.*] service configs — timeline " +
        "correlation will fall back to metadata.service only until this is fixed",
    );
    return new Map();
  }
}

/**
 * I29: append this process's boot marker WITHOUT letting a failure abort gateway startup.
 *
 * `appendEgressEntry` (via `readHeadHash`) deliberately THROWS when the ledger's head `row_hash`
 * is malformed — fail-closed against a corrupted chain — and a read-only/locked SQLite file
 * throws too. Left unguarded, either condition would take the WHOLE GATEWAY down over what is, by
 * design, a DEGRADED-PROOF condition rather than a fatal one: a window with no covering boot
 * marker already reports `indeterminate` instead of a false zero (see `egress-boot-marker.ts` /
 * `coverageForWindow`). Worse, `egress.verify` / `nimbus egress verify` are reachable only
 * through a running gateway, so aborting boot here would prevent the user from even diagnosing
 * the corruption that is blocking it.
 *
 * Swallowing the failure must never be SILENT: log a warning naming what failed and stating that
 * egress proofs will read `indeterminate` until the next successful boot marker.
 */
export function appendBootMarkerOrWarn(
  db: Database,
  coverage: CoverageVector,
  now: number,
  logger: Pick<Logger, "warn">,
): void {
  try {
    appendBootMarker(db, coverage, now);
  } catch (err) {
    logger.warn(
      { err },
      "I29: failed to append the egress boot marker — egress proofs (nimbus prove / " +
        "egress.verify) will report 'indeterminate' for every window this process observes " +
        "until the next successful boot marker",
    );
  }
}

/**
 * Audit shipper (Task 19, I22): when policy configures an org SIEM endpoint
 * (`enforced().auditShipTo`), ship audit_log entries there as metadata-only
 * NDJSON — NEVER `action_json` (the no-leak guarantee; the SELECT omits it).
 * Forward-only: the shipper baselines on the current MAX(id) at start and
 * ships only entries created afterwards, so no persisted-cursor migration is
 * needed. Must be called after the policy gate is built, so the caller passes
 * the already-enforced value rather than the gate.
 *
 * Extracted from `assemblePlatformServices` to keep that function's cognitive
 * complexity in budget (S3776); the guard is the same one it inlined.
 */
function maybeStartAuditShipper(
  db: Database,
  auditShipTo: string | undefined,
  sidecarStops: Array<() => void>,
): void {
  if (auditShipTo === undefined || auditShipTo.length === 0) {
    return;
  }
  const auditShipper = startAuditShipper(db, { shipTo: auditShipTo });
  sidecarStops.push(() => auditShipper.stop());
}

// Research-briefs boot (Spine S1), extracted verbatim from assemblePlatformServices to keep that
// function's cognitive complexity in budget (S3776) — the same reason bootTribalKnowledge above
// exists. This is a BEHAVIOUR-PRESERVING extraction: the `[briefs].enabled` gate moved in here with
// the block it guards, so a disabled install still reaches none of this and the caller still owns
// the unconditional `ipcOpts.briefsEnabled` echo. The three `httpSidecarOpts` seams are assigned on
// the caller's own object, so the wiring order relative to the identity/chatops boots is unchanged.
function bootBriefsIntoHttpSidecar(deps: {
  briefsToml: ReturnType<typeof loadNimbusBriefsFromPath>;
  llmRouter: Parameters<typeof createBriefLlm>[0];
  localIndex: LocalIndex;
  db: Database;
  scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const { briefsToml, llmRouter, localIndex, db, scheduleItemEmbedding, httpSidecarOpts } = deps;
  if (!briefsToml.enabled) {
    return;
  }
  const briefRuns = new BriefRunController({
    nowMs: () => Date.now(),
    ttlMs: briefsToml.ttlMinutes * 60_000,
  });
  const briefLlm = createBriefLlm(llmRouter, briefsToml.preferLocal);
  // The query itself lives in briefs/brief-index-search.ts so a test can reach it — see the
  // docblock there. This wiring is behaviour-identical to the closure it replaced.
  const briefSearch = createBriefIndexSearch(localIndex);
  httpSidecarOpts.briefRuns = briefRuns;
  httpSidecarOpts.briefStartRun = (runId: string): void => {
    const run = briefRuns.get(runId);
    if (run === null) return;
    briefRuns.markRunning(run);
    void (async () => {
      const { registry, indexHits, semanticAvailable, searchFailed } = await buildRegistry(
        run,
        briefSearch,
      );
      const out = await runSynthesis({
        run,
        registry,
        indexHits,
        semanticAvailable,
        searchFailed,
        llm: briefLlm,
      });
      if ("error" in out) briefRuns.fail(run, out.error);
      else briefRuns.finish(run, out.report);
    })().catch(() => briefRuns.fail(run, "internal_error"));
  };
  httpSidecarOpts.briefSave = (runId: string) => {
    const run = briefRuns.get(runId);
    if (run === null) throw new Error("run not found");
    return saveBriefReport(db, run, scheduleItemEmbedding);
  };
}

/**
 * Agents-over-HTTP boot. Mirrors `bootBriefsIntoHttpSidecar`: build the singleton run store and the
 * invoker, then assign both onto the caller's `httpSidecarOpts` so wiring order is unchanged.
 *
 * The context handed to the invoker mirrors `ipc/server/dispatchers.ts` `tryDispatchAgentsRpc` —
 * same db, index, configDir and federation identity. `router` is `llmRegistry.llmRouter`, the SAME
 * instance `ipc/server/dispatchers.ts` reads off `ServerCtx.options.llmRegistry` — both paths hand
 * it to the SAME `buildAgentSynthesisRunner` factory, so an HTTP brief and a socket brief stay the
 * same answer to the same question, under every `[agents].synthesis` mode, by construction.
 *
 * Unlike briefs there is no `[agents].enabled` gate: the agents namespace is already served on the
 * socket unconditionally, and the HTTP surface adds no capability a paired client does not have to
 * be granted explicitly — reaching it requires the `agents` scope, which no legacy token carries
 * and `nimbus clip pair --scopes` must name.
 */
function bootAgentsIntoHttpSidecar(deps: {
  db: Database;
  localIndex: LocalIndex;
  configDir: string;
  selfIdentity: Parameters<typeof createIpcServer>[0]["federationIdentity"];
  llmRouter: SynthesisRouter;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const agentRuns = new AgentRunController({ nowMs: () => Date.now() });
  deps.httpSidecarOpts.agentRuns = agentRuns;
  deps.httpSidecarOpts.agentInvoke = buildAgentHttpInvoker({
    db: deps.db,
    runs: agentRuns,
    index: deps.localIndex,
    configDir: deps.configDir,
    router: deps.llmRouter,
    ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
  });
}

/**
 * `POST /v1/items/fetch`'s one `http:` exception source (Task 11): the literal `URL.origin` of a
 * service's own self-hosted origin secret — but ONLY when that origin is itself `http:`.
 *
 * Mirrors `sync/fetch-host-boundary.ts`'s module-private `selfHostedOriginSecret` vault-key mapping
 * (`gitlab` → `api_base`, `jenkins`/`jira` → `base_url`; `github`/`bitbucket` have no self-hosted
 * variant) rather than importing it — that helper is private by design, and this is the one other
 * call site that needs the same mapping. `sync/fetch-host-boundary.ts` is on the "do not modify"
 * list for this task, so a short, obviously-mirrored switch here is the alternative to changing
 * that module's public surface.
 *
 * Returns `new URL(secret).origin`, NEVER the raw secret string: `targeted-fetch.ts` compares
 * against `parsed.origin`, which is always scheme+host+port with no trailing slash and a lowercase
 * host — a raw Vault value with a trailing slash or an uppercase host would never match, silently
 * breaking the exception for an otherwise-legitimate self-hosted `http:` service. Returns `null`
 * for a SaaS-only service, an absent/blank secret, an unparseable one, or one configured over
 * anything but `http:`.
 */
export async function httpOriginFor(
  vault: NimbusVault,
  service: FetchableService,
): Promise<string | null> {
  let raw: string | null;
  switch (service) {
    case "gitlab":
      raw = await readConnectorSecret(vault, "gitlab", "api_base");
      break;
    case "jenkins":
      raw = await readConnectorSecret(vault, "jenkins", "base_url");
      break;
    case "jira":
      raw = await readConnectorSecret(vault, "jira", "base_url");
      break;
    case "github":
    case "bitbucket":
      return null;
  }
  if (raw === null || raw.trim() === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  return parsed.protocol === "http:" ? parsed.origin : null;
}

/** Every `FetchableService` with a possible self-hosted origin secret (Task 11). */
const HTTP_ORIGIN_CANDIDATE_SERVICES: readonly FetchableService[] = ["gitlab", "jenkins", "jira"];

/**
 * Resolved FRESH per call, alongside `deriveFetchHostMap` — never cached — for the same reason:
 * credentials can be revoked while the gateway runs, and a cached boundary would keep authorising
 * an `http:` exception after its credential was removed. A few Vault reads on a route that makes a
 * network request anyway.
 */
async function buildHttpOriginMap(
  vault: NimbusVault,
): Promise<ReadonlyMap<FetchableService, string>> {
  const map = new Map<FetchableService, string>();
  for (const service of HTTP_ORIGIN_CANDIDATE_SERVICES) {
    const origin = await httpOriginFor(vault, service);
    if (origin !== null) {
      map.set(service, origin);
    }
  }
  return map;
}

/**
 * Whether `service`'s `fetchOne` would make an outbound request for `url` — i.e. whether
 * `targetedFetch` should append an egress row before attempting it (I29 Critical 2). Delegates to
 * each connector's own exported, pure, network-free URL-shape parser (never a reimplementation
 * here), so this can never disagree with what `fetchOne` itself would decide.
 *
 * `jiraBaseUrl` — resolved fresh per call by the caller, alongside the host map (see
 * `bootTargetedFetchIntoHttpSidecar`) — lets the `jira` case also apply `fetchOneIssue`'s own
 * base-URL match, so a caller URL whose spelling diverges from the configured `jira.base_url`
 * (e.g. a context path the caller's URL omits) is declined HERE too, before the egress append —
 * otherwise `fetchOneIssue`'s later, correct `unsupported_url` would come one step too late to
 * stop an over-claimed `authorized` row for a call that never left the machine.
 */
function fetchOneUrlIsSupported(
  service: FetchableService,
  url: string,
  jiraBaseUrl: string | null,
): boolean {
  switch (service) {
    case "github":
      return githubFetchOneUrlIsSupported(url);
    case "gitlab":
      return gitlabFetchOneUrlIsSupported(url);
    case "bitbucket":
      return bitbucketFetchOneUrlIsSupported(url);
    case "jenkins":
      return jenkinsFetchOneUrlIsSupported(url);
    case "jira":
      return jiraFetchOneUrlIsSupported(url, jiraBaseUrl);
  }
}

/**
 * IMPORTANT 1 fix: builds the `GET /v1/items/resolve` `fetchable` predicate and assigns it onto
 * the caller's `httpSidecarOpts`. Derives the host map the SAME way `bootTargetedFetchIntoHttpSidecar`
 * does — fresh on every call, never cached — so a revoked credential stops advertising
 * `fetchable` on the very next resolve, not just the next fetch.
 */
function bootResolveFetchableIntoHttpSidecar(deps: {
  vault: NimbusVault;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const { vault } = deps;
  deps.httpSidecarOpts.resolveFetchable = async (): Promise<(host: string) => boolean> => {
    const hostMap = await deriveFetchHostMap(vault);
    return (host: string) => serviceForHost(hostMap, host) !== null;
  };
}

/**
 * Targeted-fetch-on-miss boot (Task 11): builds the `POST /v1/items/fetch` closure and assigns it
 * onto the caller's `httpSidecarOpts`, mirroring `bootAgentsIntoHttpSidecar`'s shape.
 *
 * The host map AND the http-origin map are both derived fresh on EVERY call — never cached at boot
 * — because a credential can be revoked while the gateway runs; a cached boundary would keep
 * authorising a service (or an `http:` exception) after its backing secret was removed.
 * `syncableFor`/`contextFor` read the scheduler's OWN registered connectors and `SyncContext`
 * (Task 10's `syncableFor`/`syncContextFor`), so a targeted fetch shares depth enforcement and the
 * rate-limiter bucket with scheduled syncs rather than constructing a parallel context that could
 * drift from it. `appendEgress` and `sync/scheduler.ts`'s `appendSyncEgress` (wired in
 * `createSchedulerWithMesh`, above) are two closures around the SAME appender,
 * `egress/sync-egress.ts`'s `recordSyncEgress` — never the raw `appendEgressEntry`, which D22(b)
 * confines to `egress/*`.
 */
function bootTargetedFetchIntoHttpSidecar(deps: {
  db: Database;
  vault: NimbusVault;
  syncScheduler: SyncScheduler;
  httpSidecarOpts: HttpSidecarOpts;
  /** Narrowed to the one method used, as `appendBootMarkerOrWarn` does: this is only ever the
   *  destination for a swallowed outcome-append failure. */
  logger: Pick<Logger, "warn">;
}): void {
  const { db, vault, syncScheduler, logger } = deps;
  // `callerLabel` is threaded, not dropped. A closure taking only `url` stays ASSIGNABLE to the
  // surface's `(url, callerLabel?)` type — TypeScript permits fewer parameters — so omitting it
  // here would typecheck cleanly and silently leave every targeted-fetch row unattributed.
  deps.httpSidecarOpts.fetchItem = async (
    url: string,
    callerLabel?: string,
  ): Promise<TargetedFetchOutcome> => {
    const [hostMap, httpOrigins, jiraBaseUrl] = await Promise.all([
      deriveFetchHostMap(vault),
      buildHttpOriginMap(vault),
      jiraConfiguredBaseUrl(vault),
    ]);
    return targetedFetch(
      {
        hostMap,
        syncableFor: (service) => syncScheduler.syncableFor(service),
        contextFor: (service) => syncScheduler.syncContextFor(service),
        httpOriginFor: (service) => httpOrigins.get(service) ?? null,
        urlIsSupported: (service, u) => fetchOneUrlIsSupported(service, u, jiraBaseUrl),
        appendEgress: (row) => recordSyncEgress(db, { ...row, now: Date.now() }),
        appendOutcome: (row) => recordFetchOutcomeEgress(db, { ...row, now: Date.now() }),
        warn: (err, message) => logger.warn(err, message),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
      url,
      callerLabel,
    );
  };
}

/**
 * Register `stop()` for each refresher that is present.
 *
 * Deliberately takes the refreshers rather than pre-built closures: a caller
 * building `() => x.stop()` for an `x` that turned out to be `undefined` would
 * only fail at shutdown, long after the mistake.
 */
function pushStops(
  sidecarStops: Array<() => void>,
  refreshers: ReadonlyArray<{ stop: () => void } | undefined>,
): void {
  for (const r of refreshers) {
    if (r !== undefined) {
      sidecarStops.push(() => r.stop());
    }
  }
}

export async function assemblePlatformServices(
  paths: PlatformPaths,
  customVault?: NimbusVault,
): Promise<PlatformServices> {
  const assemblyStartedMs = performance.now();
  const sidecarStops: Array<() => void> = [];
  await ensurePlatformDirectories(paths);
  // Built before `db` so a boot-marker append failure (below) has somewhere to log a warning.
  const syncLogger: Logger = createGatewayPinoLogger(paths.logDir);
  const vault = customVault ?? (await createNimbusVault(paths));
  // Ordering is load-bearing on Windows: this constructs the runner, which synchronously probes
  // the helper via `--check-caps` (creating, then deleting, a throwaway `nimbus-ext-probe`
  // AppContainer profile) — BEFORE `reapAppContainersAtBoot` runs below. So if that probe's own
  // delete ever fails and leaves `nimbus-ext-probe` behind, the reaper that runs right after on
  // this same boot is what cleans it up, not a later restart.
  const sandboxRunner = await createSandboxRunner();
  const db = openGatewaySqlite(paths.dataDir, sidecarStops);
  // I29: record what THIS binary is built to observe, before anything can emit egress. Without a
  // covering marker `proveWindow` reports `indeterminate` rather than a false zero, so this append
  // is what makes a clean window provable. Safe here: openGatewaySqlite ran LocalIndex.ensureSchema,
  // so egress_ledger (V44) exists. Non-fatal on failure (see `appendBootMarkerOrWarn`) — a corrupted
  // or locked ledger degrades proofs to `indeterminate`, it does not stop the gateway from booting.
  appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, Date.now(), syncLogger);
  // The AppContainer profiles the Windows sandbox creates are per-user registry state. Reap the
  // ones whose extension is gone, or they accumulate across every install/uninstall cycle and
  // leave orphaned SIDs on paths they were granted. Non-fatal by construction: see the function.
  void reapAppContainersAtBoot({ db, logger: syncLogger });
  const notifications = createUnimplementedNotifications(syncLogger);
  const rateLimiter = new ProviderRateLimiter();
  const activeTomlPath = resolveNimbusTomlForProfile(paths.configDir);
  // A2: resolve the persona ONCE at boot, discarding the result, purely so an unrecognised
  // `[persona]` value is reported. This is the ONLY site that passes a logger.
  //
  // Why it has to exist: `run-ask.ts` and `agent-synthesis-runner.ts` both resolve the persona
  // per invocation and both deliberately pass NO logger, because warning on every turn and
  // every brief would be noise. Without this line the warn-once path in `config/persona.ts`
  // is never reached in production — the loader would be `OrWarn` in name only, and a user
  // with `tone = "tree"` would get silent neutral behaviour, which is the exact failure the
  // design review raised (Q2).
  resolvePersona(paths.configDir, syncLogger);
  const sessionToml = loadNimbusSessionFromPath(activeTomlPath);
  // AWAITED, never fire-and-forget: the registry must be fully populated before the router
  // answers anything, or a remote route could be missing from the first turn after boot.
  const llmRegistry = await buildLlmRegistryFromToml(db, activeTomlPath, vault, {
    warn: (m: string) => syncLogger.warn(m),
  });
  // `undefined` here means the Mastra engine agent is NOT CONSTRUCTED at all (gateway-main.ts),
  // which is what makes `enabled = false` mean no remote inference anywhere — including the
  // default `nimbus ask`, which Mastra would otherwise serve off an environment credential.
  const agentVendor = await resolveAgentVendor(loadNimbusLlmFromPath(activeTomlPath), vault, {
    warn: (m: string) => syncLogger.warn(m),
  });

  const { localIndex, scheduleItemEmbedding, rt } = createLocalIndexWithEmbeddingRuntime(
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

  // Timeline correlation (deployment <-> incident, `correlates_with`): binds an item's
  // PagerDuty/repo metadata to a nimbus service id via the [metrics.dora.<id>] /
  // [ci.service.<id>] config, so cross-provider service identifiers (PagerDuty's
  // "PSVC1" vs. a forge's "checkout-web") resolve to the same `ServiceConfig.serviceId`.
  //
  // M-1 (see `loadServiceConfigsOrDegrade`): a malformed `[metrics.dora.*]`/
  // `[ci.service.*]` block degrades to no service-identity bindings rather than
  // aborting boot. This is the only call site reached unconditionally at boot.
  const serviceConfigs = loadServiceConfigsOrDegrade(paths.configDir, syncLogger);
  // M-2: two ServiceConfigs claiming the same pagerdutyServices entry or repo URN
  // (a monorepo) resolve deterministically but silently otherwise; surface it the
  // same way `loadNimbusServiceConfigsFromConfigDir` already warns on duplicate ids.
  const resolveServiceId = buildServiceIdentityResolver(serviceConfigs, (w) => {
    syncLogger.warn(
      { ...w },
      "ambiguous service-identity binding — multiple [metrics.dora.*]/[ci.service.*] " +
        "configs claim the same key; picked the first by config order",
    );
  });

  // Capabilities are NOT bound here, deliberately. This context is built ONCE and shared by every
  // service, so a `getSecret` bound at this point would carry whichever service id happened to be
  // chosen and be scoped to the wrong connector for all but one of them. They bind per service in
  // `sync/scheduler.ts` `contextForService`, which both `runJob` and `syncContextFor` route
  // through — the first points that know which connector is running.
  const syncBase: SyncRuntimeContext = {
    ...unboundSyncCapabilities(),
    vault,
    db,
    logger: syncLogger,
    rateLimiter,
    resolveServiceId,
    // Shared template context — the scheduler overrides this per run
    // (sync/scheduler.ts `runJob`) with the connector's actual persisted
    // depth; this is only the safe pass-through default for any other caller.
    depth: "full",
    ...teamCredentialExtras,
  };
  const syncContext: SyncRuntimeContext = scheduleItemEmbedding
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

  // I22 — the tighten-only HITL overlay every ToolExecutor in this process consults, alongside
  // I2's frozen set. Defined here, next to the gate it reads, so there is one instance rather than
  // a closure rebuilt at each of the eleven executor construction sites.
  const policyHitl: ExecutorPolicyDep = {
    isHitlRequiredByPolicy: (actionType) =>
      isHitlRequiredByPolicy(policyGate.enforced(), actionType),
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

  // Started after the policy gate so it reads the enforced policy (see
  // `maybeStartAuditShipper`).
  maybeStartAuditShipper(db, policyGate.enforced().auditShipTo, sidecarStops);

  const {
    syncScheduler,
    connectorMesh,
    glossaryRefresher,
    decisionsRefresher,
    ownershipRefresher,
    premortemRefresher,
  } = await createSchedulerWithMesh({
    paths,
    vault,
    db,
    syncContext,
    localIndex,
    notifications,
    syncLogger,
    isConnectorAllowed,
    glossaryLlm: createGlossaryLlm(llmRegistry.llmRouter),
    decisionLlm: createDecisionLlm(llmRegistry.llmRouter),
  });
  // One `stop` per refresher that actually started. Three of the four are
  // optional (their passes are config-gated), and the repeated
  // `if (x !== undefined) push(...)` was a third of this function's
  // cognitive-complexity score (Sonar S3776, 17 against a limit of 15) for no
  // structural benefit.
  pushStops(sidecarStops, [
    glossaryRefresher,
    decisionsRefresher,
    ownershipRefresher,
    premortemRefresher,
  ]);

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
    // I22 — the tighten-only HITL overlay, handed to every ToolExecutor this server builds.
    // Set in the literal, not assigned later: `bootTribalKnowledge` receives `ipcOpts` and
    // builds its own executor from it, so a post-hoc assignment would depend on that read
    // staying lazy. Until 2026-08-16 nothing consumed the resolved policy at all — an admin
    // could sign `[policy.hitl] require = [...]`, see it verify, and get no gate.
    policyHitl,
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
  // Readiness is ALWAYS wired, even when there is no runtime at all: a client must be able to
  // tell "warming up, N% downloaded" from "switched off" from "fetch failed" — the difference
  // between a real progress report and a generic spinner (#928).
  const embeddingReadiness = (): EmbeddingReadiness =>
    rt?.getReadiness() ?? {
      state: "disabled",
      elapsedMs: 0,
      model: null,
      dims: null,
      download: null,
      reason: "embeddings are disabled for this gateway",
    };
  ipcOpts.embeddingReadiness = embeddingReadiness;
  ipcOpts.getEmbeddingStatus = () => ({
    embeddingBackfill: rt?.getBackfillProgress() ?? null,
    embedding: embeddingReadiness(),
  });

  // A2: the gateway side of `profile.*` was declared (ipc/server/options.ts) and dispatched
  // (ipc/server/dispatchers.ts) but NEVER constructed, so every call threw "Profile manager is
  // not available on this gateway" — which is why the desktop app's routed Profiles settings
  // page has never worked. All four methods are already on the Tauri allowlist; this is the
  // one missing link, not a new surface.
  //
  // Switching a profile still requires a gateway restart: NIMBUS_PROFILE is read at spawn
  // (cli/src/lib/spawn-gateway.ts), so the switch takes effect on the next start. The CLI
  // already prints that, and ProfilesPanel must say it too.
  ipcOpts.profileManager = new ProfileManager(paths.configDir);

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
    identityEnabled,
    identityBootRefHolder,
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

  // Research briefs (Spine S1). Default-off; the seam stays absent unless [briefs].enabled.
  const briefsToml = loadNimbusBriefsFromPath(activeTomlPath);
  // Always set (not gated on briefsToml.enabled) so `clip.status` can always echo the real
  // enable-state — a paired user's first `nimbus clip status` should never see it silently absent.
  ipcOpts.briefsEnabled = briefsToml.enabled;
  // No-op unless `[briefs].enabled` — the gate lives in the helper, with the block it guards.
  bootBriefsIntoHttpSidecar({
    briefsToml,
    llmRouter: llmRegistry.llmRouter,
    localIndex,
    db,
    scheduleItemEmbedding,
    httpSidecarOpts,
  });

  // Agents over HTTP. Placed AFTER bootFederationIntoIpcOpts (above) so `federationIdentity` is
  // already populated when the invoker captures it — the socket path reads it per call, this one
  // captures once, so the ordering is load-bearing rather than cosmetic.
  bootAgentsIntoHttpSidecar({
    db,
    localIndex,
    configDir: paths.configDir,
    selfIdentity: ipcOpts.federationIdentity,
    llmRouter: llmRegistry.llmRouter,
    httpSidecarOpts,
  });

  // Targeted fetch-on-miss (Task 11). Unconditional, like agents: reaching it requires the
  // `fetch` scope, which no legacy token carries and `nimbus clip pair --scopes` must name.
  bootTargetedFetchIntoHttpSidecar({
    db,
    vault,
    syncScheduler,
    httpSidecarOpts,
    logger: syncLogger,
  });

  // IMPORTANT 1 fix: wires `GET /v1/items/resolve`'s `fetchable` predicate. Unconditional, same
  // as the fetch seam above — the route itself still requires the `resolve` scope.
  bootResolveFetchableIntoHttpSidecar({ vault, httpSidecarOpts });

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
  chatopsBoot = await bootChatopsIntoAssembly({
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
  // I33 (S2 slice 1): the sandboxed code-execution surface. DEFAULT OFF -- `enabled` is read from
  // `[code_execution]`, and `runExecution` refuses before consent when it is false, so wiring the
  // ctx unconditionally does not enable anything. The org-policy half is read LAZILY through
  // `policyGate.enforced()` rather than snapshotted here, so a policy installed after boot tightens
  // the next execution rather than the next restart.
  const codeExecCfg = loadNimbusCodeExecutionFromConfigDir(paths.configDir);
  ipcOpts.execRpcCtx = {
    consent: execConsent,
    gateDeps: {
      runner: sandboxRunner,
      config: codeExecCfg,
      get enforced() {
        return policyGate.enforced();
      },
      requestApproval: (input) =>
        execConsent.request(input, (ipcOpts.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000),
      db,
      readFile: (p) => readFileSync(p, "utf8"),
      now: () => Date.now(),
      newId: () => randomUUID(),
    },
  };

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

  ipcOpts.glossaryRefresher = glossaryRefresher;
  if (decisionsRefresher !== undefined) {
    ipcOpts.decisionsRefresher = decisionsRefresher;
  }
  if (ownershipRefresher !== undefined) {
    ipcOpts.ownershipRefresher = ownershipRefresher;
  }
  if (premortemRefresher !== undefined) {
    ipcOpts.premortemRefresher = premortemRefresher;
  }

  collectSidecarsFromEnv(db, paths, sidecarStops, httpSidecarOpts);

  const ipc = createIpcServer(ipcOpts);

  // I27 (Slice 8): the share-publish approval prompt reaches the local owner via the broadcast
  // channel; they answer with `nimbus share approve <id>` → share.approvalRespond. UNCONDITIONAL
  // (NOT federation-gated) — sharing to a file/http sink works with federation disabled; a missing
  // binding would leave the broker's broadcast a no-op → every approval times out → silent deny.
  shareConsent.setBroadcast((method, params) => ipc.broadcast(method, asBroadcastParams(params)));

  // I33 (S2 slice 1): the code-execution approval prompt reaches the local owner via the same
  // broadcast channel; they answer through exec.approvalRespond. UNCONDITIONAL for the same reason
  // as share above — a missing binding leaves the broker's broadcast a no-op, so every approval
  // times out and the capability silently never works (fail-closed, but indistinguishable from a
  // bug). The gate is still fail-closed either way: no answer means no spawn.
  execConsent.setBroadcast((method, params) => ipc.broadcast(method, asBroadcastParams(params)));

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
    ...(agentVendor === undefined ? {} : { agentVendor }),
    connectorWriteDeps,
    embeddingReadiness,
    ...(sessionMemoryStore === undefined ? {} : { sessionMemoryStore }),
    policyHitl,
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
