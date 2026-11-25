export { appendBootMarkerOrWarn } from "./assemble/boot-misc.ts";
export {
  bootChatopsAgentInvoker,
  settleOncallPushChatops,
  settleWatcherChatops,
} from "./assemble/chatops-boot.ts";
export type { FleetBootDeps, FleetRuntime } from "./assemble/fleet-boot.ts";
export { assembleFleetRuntime, fleetRpcCtxFor } from "./assemble/fleet-boot.ts";
export { httpOriginFor } from "./assemble/http-sidecar-boot.ts";
export { buildLlmRegistryFromToml } from "./assemble/llm-registry.ts";
export type { AgentVendor, RemoteVendorId, ResolvedRemoteVendor } from "./assemble/llm-vendors.ts";
export { resolveAgentVendor, resolveEnabledVendors } from "./assemble/llm-vendors.ts";
export { createUnimplementedNotifications } from "./assemble/stubs.ts";
export { tribalKbConfigOf } from "./assemble/tribal-boot.ts";

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import { createBriefingRuntime } from "../briefing/briefing-runtime.ts";
import type { ChatopsBoot } from "../chatops/chatops-boot.ts";
import type { ChatMessage, ReplyTarget } from "../chatops/types.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { cuActionConsent, cuEnvelopeConsent } from "../computer-use/cu-consent-broker.ts";
import { type CuGateDeps, type CuRunDeps, liveSessionLane } from "../computer-use/cu-gate.ts";
import { openBrowserLane } from "../computer-use/cu-lanes/browser.ts";
import {
  assertBrowserLaunchPolicy,
  buildChromiumLaunchPolicy,
} from "../computer-use/cu-lanes/browser-launch.ts";
import { resolveChromiumPath } from "../computer-use/cu-lanes/chromium-path.ts";
import { openTerminalLane } from "../computer-use/cu-lanes/terminal.ts";
import {
  assertTerminalLaunchable,
  buildTerminalLaunchPolicy,
} from "../computer-use/cu-lanes/terminal-launch.ts";
import {
  type CuShell,
  DEFAULT_SHELL_ID,
  resolveShellById,
} from "../computer-use/cu-lanes/terminal-shells.ts";
import { startCuSnapshotRetention } from "../computer-use/cu-snapshot-retention.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { loadNimbusIncidentPredictFromConfigDir } from "../config/incident-predict-toml.ts";
import { loadNimbusIncidentFromConfigDir } from "../config/incident-toml.ts";
import { initLayeredConfig } from "../config/layered-config.ts";
import {
  loadNimbusAuditFromConfigDir,
  loadNimbusBriefsFromConfigDir,
  loadNimbusChatopsFromConfigDir,
  loadNimbusCodeExecutionFromConfigDir,
  loadNimbusComputerUseFromConfigDir,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusExtensionsRuntimeFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLlmFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusToolGenerationFromConfigDir,
  loadNimbusTribalFromConfigDir,
  loadNimbusUserFromConfigDir,
  type NimbusComputerUseToml,
  nimbusTribalConfigUnreadable,
} from "../config/nimbus-toml.ts";
import { resolvePersona } from "../config/persona.ts";
import { ProfileManager } from "../config/profiles.ts";
import { loadDependsOnMap, loadServiceBindings } from "../config/service-configs.ts";
import { loadNimbusSessionFromConfigDir } from "../config/session-toml.ts";
import { migrateToPerServiceOAuthKeys } from "../connectors/connector-vault.ts";
import { createConnectorWriteDispatcher } from "../connectors/connector-write-dispatch.ts";
import { createAgentDoor } from "../connectors/connector-writes/agent-door-runtime.ts";
import { previewCredentialResolver } from "../connectors/connector-writes/preview-credential.ts";
import { createExtensionCredentialsResolver } from "../connectors/extension-sync/extension-identity.ts";
import { createConnectorDispatcher, meshDispatcherClient } from "../connectors/index.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { createProposableServiceConfigured } from "../connectors/proposable-service-configured.ts";
import { isUserMcpModelAccessEnabled } from "../connectors/user-mcp-model-capability.ts";
import { getUserMcpConnector } from "../connectors/user-mcp-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { readToolCallLog } from "../db/tool-call-log.ts";
import {
  effectiveRetentionDays,
  startToolCallLogRetention,
} from "../db/tool-call-log-retention.ts";
import { createDecisionLlm } from "../decisions/decision-llm-adapter.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import type { EmbeddingReadiness } from "../embedding/embedding-readiness.ts";
import { readAgentLimitEnv, resolveAgentLimits, setAgentLimits } from "../engine/agent-limits.ts";
import type { ComputerUseBinding } from "../engine/agent-request-context.ts";
import { AskExplainRecorder } from "../engine/ask-explain-recorder.ts";
import type { ExecutorPolicyDep } from "../engine/executor.ts";
import { execConsent } from "../exec/exec-consent-broker.ts";
import { resolveRuntimeById } from "../exec/exec-runtimes.ts";
import { userMcpNetworkNote } from "../extensions/extension-reach.ts";
import type { RegistryFetchDeps } from "../extensions/registry/registry-fetch.ts";
import {
  buildExtensionRunGrantEnv,
  isExtensionRuntimeEnabled,
} from "../extensions/run-grant-env.ts";
import { createTrustBlockEnforcer } from "../extensions/trust/trust-block-enforcer.ts";
import { prepareTrustAtBoot, startTrustFeedForBoot } from "../extensions/trust/trust-feed-boot.ts";
import { freshenTrustFeed } from "../extensions/trust/trust-freshen.ts";
import { verifyExtensionsBestEffort } from "../extensions/verify-extensions.ts";
import { checkFleetJob } from "../fleet/fleet-job-check.ts";
import { createGlossaryLlm } from "../glossary/glossary-llm-adapter.ts";
import type { IacDriftRunner } from "../iac-drift/drift-runner.ts";
import type { buildIdentityBoot } from "../identity/identity-boot.ts";
import { startIncidentRetention } from "../incident/incident-retention.ts";
import { startPredictScheduler } from "../incident/predict-pass.ts";
import { createRemediation, type MakeExecutor } from "../incident/remediation.ts";
import { readUnreadChatThreads } from "../index/chat-unread-query.ts";
import { gitAwareRootPaths, loadRegisteredRoots } from "../index/registered-roots-store.ts";
import { createLiveInvestigator } from "../investigation/investigation-live.ts";
import { resumePendingRemovals } from "../ipc/connector-rpc-handlers/index.ts";
import type { EgressRpcCtx } from "../ipc/egress-rpc.ts";
import { emitGatewayEvent, setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY } from "../ipc/http-auth.ts";
import { createIpcServer } from "../ipc/index.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { newCaptureId } from "../mcp-sink/capture-id.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { proposalsWaitingToast } from "../mcp-sink/capture-toast.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { createPackLayerStore, packSkipLogLines } from "../packs/pack-layer-store.ts";
import { ensureAnchorKeypair } from "../policy/anchor-keypair.ts";
import { startGdprPurgeRetry } from "../policy/gdpr-purge-retry-sidecar.ts";
import { type AuthorResult, authorPolicy } from "../policy/policy-author.ts";
import { isHitlRequiredByPolicy } from "../policy/quorum-override.ts";
import { createRunbooks } from "../runbook/runbook-run.ts";
import { shareConsent } from "../share/share-consent-broker.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncRuntimeContext } from "../sync/types.ts";
import { AgentLatencyRecorder } from "../telemetry/agent-latency.ts";
import { startTelemetryFlushScheduler } from "../telemetry/flush-scheduler.ts";
import { reconcileSavedToolsOrWarn } from "../toolgen/toolgen-boot-reconcile.ts";
import { ToolgenBroker } from "../toolgen/toolgen-broker.ts";
import { spawnGeneratedTool } from "../toolgen/toolgen-client.ts";
import { assertToolConfinement } from "../toolgen/toolgen-confinement.ts";
import { toolgenConsent, toolgenSaveConsent } from "../toolgen/toolgen-consent-broker.ts";
import { sweepToolgenCredentialsOrWarn } from "../toolgen/toolgen-credential-sweep.ts";
import {
  deleteCredentialsForTool,
  deleteToolCredential,
  readToolCredential,
  writeToolCredential,
} from "../toolgen/toolgen-credentials.ts";
import { createDraftToolClosure } from "../toolgen/toolgen-draft.ts";
import {
  createToolgenDraftLlm,
  createToolgenDraftRouteProbe,
} from "../toolgen/toolgen-draft-llm.ts";
import type { ToolgenGateDeps } from "../toolgen/toolgen-gate.ts";
import { createEndpointFinder } from "../toolgen/toolgen-grounding.ts";
import { invokeSavedTool, type ToolgenInvokeDeps } from "../toolgen/toolgen-invoke-gate.ts";
import { TOOLGEN_SIGNING_PUBKEY } from "../toolgen/toolgen-keypair.ts";
import {
  pinReadVerified,
  type ToolgenModelDoorSource,
  type ToolgenModelPin,
} from "../toolgen/toolgen-model-door.ts";
import { ToolgenRegistry } from "../toolgen/toolgen-registry.ts";
import type { ToolgenSaveDeps } from "../toolgen/toolgen-save-gate.ts";
import { getSavedTool } from "../toolgen/toolgen-saved-repo.ts";
import {
  loadSavedToolsIntoRegistry,
  savedToolSpawnPolicy,
  spawnSavedTool,
} from "../toolgen/toolgen-saved-spawn.ts";
import {
  readVerifiedSavedTool,
  removeSavedTool,
  rewriteSavedToolScript,
  savedToolDir,
} from "../toolgen/toolgen-saved-store.ts";
import {
  removeToolScript,
  toolScriptDir,
  writeToolScript,
} from "../toolgen/toolgen-script-store.ts";
import {
  CLI_TOOLGEN_SESSION_ID,
  ERR_TOOLGEN_MODEL_ACCESS_WITHDRAWN,
  ERR_TOOLGEN_NOT_SAVED,
  ERR_TOOLGEN_PUBKEY_UNAVAILABLE,
  ToolgenError,
} from "../toolgen/toolgen-types.ts";
import type { TribalBoot } from "../tribal/tribal-boot.ts";
import { setApprovalPendingNotifier } from "../util/approval-pending.ts";
import { createNimbusVault } from "../vault/factory.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { GATEWAY_VERSION } from "../version.ts";
import {
  appendBootMarkerOrWarn,
  assignIfPresent,
  bootCaptureStore,
  loadServiceConfigsOrDegrade,
  maybeStartAuditShipper,
  pushStops,
  reconcileOrphanedCuSessionsOrWarn,
  startPendingRegraph,
} from "./assemble/boot-misc.ts";
import {
  bindChatopsLocalConsent,
  bootChatopsAgentInvoker,
  bootChatopsIntoAssembly,
  settleOncallPushChatops,
  settleWatcherChatops,
} from "./assemble/chatops-boot.ts";
import { attachEpisodicMemory } from "./assemble/episodic-boot.ts";
import { startExtensionObservation } from "./assemble/extension-observation.ts";
import {
  asBroadcastParams,
  bindFederationBroadcasts,
  bootFederationIntoIpcOpts,
} from "./assemble/federation-boot.ts";
import { startFinopsSidecars } from "./assemble/finops-sidecars.ts";
import { assembleFleetRuntime, fleetRpcCtxFor } from "./assemble/fleet-boot.ts";
import {
  collectSidecarsFromEnv,
  type HttpSidecarOpts,
  parseSidecarPortEnv,
} from "./assemble/http-sidecar.ts";
import {
  bootAgentsIntoHttpSidecar,
  bootBriefsIntoHttpSidecar,
  bootResolveFetchableIntoHttpSidecar,
  bootTargetedFetchIntoHttpSidecar,
} from "./assemble/http-sidecar-boot.ts";
import {
  createLocalIndexWithEmbeddingRuntime,
  ensureGithubCircleCiSchedulerCompanions,
  maybeAttachSessionMemoryStore,
  openGatewaySqlite,
} from "./assemble/index-boot.ts";
import { startIndexRetentionSidecars } from "./assemble/index-retention-sidecars.ts";
import { buildLlmRegistryFromToml } from "./assemble/llm-registry.ts";
import { resolveAgentVendor } from "./assemble/llm-vendors.ts";
import {
  bootIdentityIntoIpcOpts,
  bootPolicyGateWithConnectorAllowlist,
  buildPolicyRpcCtx,
} from "./assemble/policy-identity-boot.ts";
import { createSchedulerWithMesh } from "./assemble/scheduler-mesh.ts";
import { buildStatusReaders } from "./assemble/status-readers.ts";
import { createStubAutostart, createUnimplementedNotifications } from "./assemble/stubs.ts";
import { buildTeamCredentialContexts } from "./assemble/team-credentials.ts";
import { bootTribalKnowledge, tribalKbConfigOf } from "./assemble/tribal-boot.ts";
import {
  autoUpdateIpcOpts,
  maybeStartAutoUpdateRuntime,
  wireUpdaterIntoIpc,
} from "./assemble/updater-boot.ts";
import { openUrlInDefaultBrowser } from "./browser.ts";
import { bootPolicyFor } from "./demo-boot.ts";
import { ensurePlatformDirectories } from "./dirs.ts";
import { processEnvGet } from "./env-access.ts";
import { createGatewayPinoLogger } from "./gateway-log-file.ts";
import { createHostActivity } from "./host-activity.ts";
import {
  type AssembleCompositionOptions,
  createMigrationEngineForBoot,
  resolveMigrationComposition,
  resolveTrustComposition,
  startMigrationBootEvaluation,
} from "./migration-boot.ts";
import {
  createNotificationsRuntime,
  showIgnoringFailure,
  showWithOutcome,
} from "./notifications/notifications-runtime.ts";
import type { PlatformPaths } from "./paths.ts";
import {
  createExtensionSyncRegistrarForBoot,
  purgeExtensionIndexData,
} from "./register-extension-sync.ts";
import { isProductionRuntime } from "./runtime-layout.ts";
import { sandboxCwdFor } from "./sandbox/sandbox-cwd.ts";
import { createSandboxRunner } from "./sandbox/sandbox-runner.ts";
import { reapAppContainersAtBoot, revokeLegacyDataDirGrantsAtBoot } from "./sandbox/win32-reap.ts";
import type { PlatformServices } from "./types.ts";

export async function assemblePlatformServices(
  paths: PlatformPaths,
  customVault?: NimbusVault,
  /**
   * Composition-only (ruling B1): never passed by `platform/{win32,darwin,linux}.ts`, so production
   * keeps the baked built-in registry and continuity table. A test runner passes a fixture here —
   * the only way either reaches a real gateway.
   */
  composition?: AssembleCompositionOptions,
): Promise<PlatformServices> {
  const assemblyStartedMs = performance.now();
  // ONE value for every consumer that binds through the continuity table or the built-in registry.
  const migration = resolveMigrationComposition(composition);
  // The baked trust feed and snapshot, unless a test runner passed its own (or none).
  const trustComposition = resolveTrustComposition(composition);
  const sidecarStops: Array<() => void> = [];
  await ensurePlatformDirectories(paths);
  // Pin the profile BEFORE the first config read: every `…FromConfigDir` loader below goes
  // through this reader, so the profile cannot change under a running gateway. An invalid
  // profile name (env or marker) throws `InvalidProfileNameError` and stops boot.
  // ONE store: the layered reader reads through it and `pack.*` writes through it, so a pack write
  // bumps the running reader (its `onChange`).
  const packLayerStore = createPackLayerStore({ configDir: paths.configDir });
  const layeredConfig = initLayeredConfig(paths.configDir, {
    packs: packLayerStore,
  });
  const bootPolicy = bootPolicyFor(paths);
  // Built before `db` so a boot-marker append failure (below) has somewhere to log a warning.
  const syncLogger: Logger = createGatewayPinoLogger(paths.logDir);
  syncLogger.info(
    `config: profile "${layeredConfig.profile.name}" (from ${layeredConfig.profile.source})`,
  );
  // A skipped pack is never fatal, but it is reported: here, in `diag.snapshot`, and in `nimbus config explain`.
  for (const line of packSkipLogLines(layeredConfig.snapshot())) syncLogger.error(line);
  const vault = customVault ?? (await createNimbusVault(paths));
  // Ordering is load-bearing on Windows: this constructs the runner, which synchronously probes
  // the helper via `--check-caps` (creating, then deleting, a throwaway
  // `nimbus-ext-probe-<pid>-<tick>` AppContainer profile) — BEFORE `reapAppContainersAtBoot` runs
  // below. So if that probe's own delete ever fails and leaves its profile behind, the reaper that
  // runs right after on this same boot is what cleans it up, not a later restart.
  const sandboxRunner = await createSandboxRunner();
  const hostActivity = await createHostActivity();
  const { db, dbPath } = openGatewaySqlite(paths.dataDir, sidecarStops);
  // I29: record what THIS binary is built to observe, before anything can emit egress. Without a
  // covering marker `proveWindow` reports `indeterminate` rather than a false zero, so this append
  // is what makes a clean window provable. Safe here: openGatewaySqlite ran LocalIndex.ensureSchema,
  // so egress_ledger (V44) exists. Non-fatal on failure (see `appendBootMarkerOrWarn`) — a corrupted
  // or locked ledger degrades proofs to `indeterminate`, it does not stop the gateway from booting.
  appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, Date.now(), syncLogger);
  // The AppContainer profiles the Windows sandbox creates are per-user registry state. Reap the
  // ones whose extension is gone, or they accumulate across every install/uninstall cycle. Deleting
  // a profile does not remove the ACEs its SID holds, so the reap is followed by a sweep of the
  // runtime's read paths — the directory every exec and generated-tool spawn is granted, which
  // otherwise gained one unresolvable ACE per distinct SID until the DACL overflowed. Non-fatal by
  // construction: see the function.
  // Skipped for a demo-rooted gateway (I41 clause 4, platform/demo-boot.ts).
  let dataDirRevoke: Promise<void> | undefined;
  if (bootPolicy.reapAppContainers) {
    void reapAppContainersAtBoot({
      db,
      logger: syncLogger,
      sweepPaths: resolveRuntimeById("bun").requiredReadPaths(),
    });
    // Spec § A: before per-policy working directories, every connector ran with `dataDir` as its
    // cwd and the helper left an inheritable ACE there per SID. Nothing re-grants it now (except
    // the filesystem MCP, deliberately), so revoke once and record a marker. The revoke rewrites the
    // dataDir DACL, and so does the filesystem MCP’s spawn-time grant (an unlocked read-modify-
    // write), and that MCP spawns lazily on its first listing — which a request arriving in the
    // seconds the revoke takes CAN trigger. So the mesh awaits this promise (never rejects) at the
    // top of `collectBuiltInToolMaps`, which holds EVERY dispatcher tool listing (all connector
    // dispatches, user-MCP list/call, share replay, tribal capture, ChatOps writes), not only the
    // filesystem MCP (`listUserMcpTools` awaits it too, for the per-server user-MCP dispatch path).
    // Each helper call has its own 15 s deadline (`BOOT_REVOKE_CALL_TIMEOUT_MS`): a hung helper is
    // killed, the pass stops, no marker is written and the next boot retries. The calls are
    // sequential, so the hold is the time the earlier calls took plus ONE deadline, rather than
    // lasting until a hung helper exits. Nothing else at boot awaits it,
    // and Linux/macOS/demo gateways never reach this branch, so they never wait.
    dataDirRevoke = revokeLegacyDataDirGrantsAtBoot({
      db,
      dataDir: paths.dataDir,
      logger: syncLogger,
    });
  }
  const rateLimiter = new ProviderRateLimiter();
  // pre-S3 item E: real OS toasts. A demo-rooted gateway (I41), a platform with no backend, or an
  // invalid `[notifications]` section (logged at ERROR; never crashes boot) keep the non-delivering
  // service. The probe is kicked off here and never awaited — boot does not wait on a PowerShell
  // spawn — and `ready()` never rejects.
  const notificationsRuntime = createNotificationsRuntime({
    allowed: bootPolicy.osNotifications,
    platform: process.platform,
    configDir: paths.configDir,
    logger: syncLogger,
    fallback: createUnimplementedNotifications(syncLogger),
  });
  const notifications = notificationsRuntime.service;
  void notificationsRuntime.ready();
  // The consent hop (T3): a fixed-text toast while a HITL approval is pending. The hop itself
  // swallows a throwing/rejecting notifier, so a toast failure can never break consent.
  setApprovalPendingNotifier((title, body) => notifications.show(title, body, { urgent: true }));
  sidecarStops.push(() => {
    setApprovalPendingNotifier(undefined);
    notificationsRuntime.close();
  });
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
  const sessionToml = loadNimbusSessionFromConfigDir(paths.configDir);
  // `[llm] max_agent_depth` / `max_tool_calls_per_session` are LIVE from here on: resolved
  // once (a set, valid env var still wins) and read by `AgentCoordinator` and `gateway.ping`.
  const bootLlmToml = loadNimbusLlmFromConfigDir(paths.configDir);
  setAgentLimits(resolveAgentLimits({ env: readAgentLimitEnv(), toml: bootLlmToml }));
  // AWAITED, never fire-and-forget: the registry must be fully populated before the router
  // answers anything, or a remote route could be missing from the first turn after boot.
  const llmRegistry = await buildLlmRegistryFromToml(db, paths.configDir, vault, {
    warn: (m: string) => syncLogger.warn(m),
  });
  // `undefined` here means the Mastra engine agent is NOT CONSTRUCTED at all (gateway-main.ts),
  // which is what makes `enabled = false` mean no remote inference anywhere — including the
  // default `nimbus ask`, which Mastra would otherwise serve off an environment credential.
  const agentVendor = await resolveAgentVendor(bootLlmToml, vault, {
    warn: (m: string) => syncLogger.warn(m),
  });

  const { localIndex, scheduleItemEmbedding, rt } = createLocalIndexWithEmbeddingRuntime(
    db,
    paths,
    vault,
    syncLogger,
    paths.configDir,
    hostActivity,
    sidecarStops,
  );
  await ensureGithubCircleCiSchedulerCompanions(localIndex, vault);

  await migrateToPerServiceOAuthKeys(vault);

  await resumePendingRemovals(vault, localIndex);

  const auditCfg = loadNimbusAuditFromConfigDir(paths.configDir);

  // Org policy (I22): built BEFORE the team-credential contexts, whose connector-write transport
  // reads the connector allowlist per call, and before the retention sidecar, so the latter can
  // honor `enforced().retentionDays` (the monotonic floor).
  const { policyStore, policyGate, isConnectorAllowed } = bootPolicyGateWithConnectorAllowlist(
    db,
    paths.configDir,
    auditCfg,
  );

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
    isConnectorAllowed,
  });

  // MCP capture sink (I28). Config at boot; org policy LIVE per call (I22) — an absent/undefined
  // policy result fails closed inside resolveCaptureCapability.
  const { mcpSinkLoad, captureStore } = bootCaptureStore(db, paths.configDir, syncLogger);
  // The `user_mcp_model_access` policy capability (I42) can change at runtime, so it is read LIVE
  // per call, never snapshotted at boot.
  const actClassifyCtx = {
    userMcpModelAccessAllowed: (): boolean => isUserMcpModelAccessEnabled(policyGate.enforced()),
  };
  // Obsidian's server spawns from the boot-time `[[filesystem.roots]]` (createSchedulerWithMesh), so
  // the act door reads them at boot too rather than answering obsidian configured vacuously.
  const obsidianCanSpawn = loadNimbusFilesystemRootsFromConfigDir(paths.configDir).length > 0;
  const isServiceConfigured = createProposableServiceConfigured({
    vault,
    isUserMcpRegistered: (id) => getUserMcpConnector(db, id) !== null,
    meshOnly: { obsidian: () => obsidianCanSpawn },
  });
  // Loaded BEFORE the capture gate (B3, review fix 2): the act door's KB refusals read the same
  // value `platform.tribalKbConfig` returns below. A pure config read; nothing between here and its
  // other uses writes the `[tribal]` section.
  const tribalCfg = loadNimbusTribalFromConfigDir(paths.configDir);
  const tribalUnreadable = nimbusTribalConfigUnreadable(paths.configDir);
  // The agent door (invariant I58): what an outside agent may propose is decided per door, by the
  // owner's approval by name, and re-derived at submit, at approval and after the owner's answer.
  // It is built BEFORE the mesh exists, so the listing it hashes is late-bound (the
  // `identityBootRefHolder` pattern): until the mesh is bound there is NO listing and no `approved`
  // proposal is accepted (fail closed).
  const agentDoorMesh: {
    current:
      | Pick<LazyConnectorMesh, "listFirstPartyServerTools" | "listUserMcpToolDefinitions">
      | undefined;
  } = {
    current: undefined,
  };
  const agentDoor = createAgentDoor({
    db,
    enforcedPolicy: () => policyGate.enforced(),
    listServerTools: async (service) => agentDoorMesh.current?.listFirstPartyServerTools(service),
    // A registered user-MCP server's STRIPPED definitions (AD5a); may start that one server.
    listUserMcpDefinitions: async (serviceId) =>
      agentDoorMesh.current?.listUserMcpToolDefinitions(serviceId),
    // The owner's prompt names the reach when the OS cannot limit it host by host (as the
    // registration prompt does).
    userMcpNetworkNote: (netHosts) => userMcpNetworkNote(sandboxRunner, netHosts),
    tribalKbConfig: () => tribalKbConfigOf(tribalCfg, tribalUnreadable),
    userMcpPolicy: actClassifyCtx,
    isServiceConfigured,
    now: () => Date.now(),
  });
  const captureGate: CaptureGateDeps = {
    db,
    store: captureStore,
    capability: () => resolveCaptureCapability(mcpSinkLoad, policyGate.enforced()),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: newCaptureId,
    now: () => Date.now(),
    // Agent door AD2: a count-only toast (a number and fixed text, never a request-derived string).
    onActionProposed: (pending) => {
      const t = proposalsWaitingToast(pending);
      void showIgnoringFailure(notifications, t.title, t.body);
    },
    classifyAction: agentDoor.verdict,
    isServiceConfigured,
    listProposableActionTypes: agentDoor.acceptedTypes,
    // The refusal follows the verdict's basis: the model door's check, over the LIVE policy and
    // the `[tribal]` KB config.
    actionDestinationRefusal: agentDoor.refusal,
    verifyActionDefinition: agentDoor.verifyDefinition,
    ...(scheduleItemEmbedding === undefined
      ? {}
      : { scheduleEmbedding: (id: string) => scheduleItemEmbedding(id) }),
  };

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

  startPendingRegraph(db, paths.configDir, syncLogger, sidecarStops);

  // Capabilities are NOT bound here, deliberately. This context is built ONCE and shared by every
  // service, so a `getSecret` bound at this point would carry whichever service id happened to be
  // chosen and be scoped to the wrong connector for all but one of them. They bind per service in
  // `sync/scheduler.ts` `contextForService`, which both `runJob` and `syncContextFor` route
  // through — the first points that know which connector is running.
  const syncContext: SyncRuntimeContext = {
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
    // The scheduler's configured-ness gate reads an approved extension's own credentials (the
    // grant's, which for a bound extension are the legacy keys). Answers nothing for an id no grant
    // carries, so it changes no built-in connector's answer.
    extensionCredentialsFor: createExtensionCredentialsResolver(db, migration.continuityTable),
  };
  assignIfPresent(syncContext, "scheduleItemEmbedding", scheduleItemEmbedding);

  const sessionMemoryStore = maybeAttachSessionMemoryStore(db, rt, sessionToml, sidecarStops);
  attachEpisodicMemory(sessionMemoryStore, { db, rt, llmRegistry, paths, sidecarStops });

  // I22 - the tighten-only HITL overlay every ToolExecutor in this process consults, beside I2's frozen set.
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

  // Item and schema history (IC1, V108) and orchestration run rows: the daily index retention passes.
  startIndexRetentionSidecars({ db, paths, sidecarStops });

  // Incident record retention (IC3): `[incident] retention_days`, re-read per tick; a pruned record takes its pushed briefs.
  const incidentRetention = startIncidentRetention(db, {
    retentionDays: () => loadNimbusIncidentFromConfigDir(paths.configDir).retentionDays,
    onError: (err) => syncLogger.warn({ err }, "incident record retention pass failed"),
  });
  sidecarStops.push(() => incidentRetention.stop());

  // Incident predictions (Phase 10 IC8, I57 (a), D-IC-5): the expectation radar and the index anomaly baseline,
  // every 15 minutes and once at boot. Reads the local index and writes only its own findings; its only outward
  // effects are a counts-only toast (none on a demo gateway, I41) and the `incident.finding` event.
  const incidentPredict = startPredictScheduler({
    db,
    config: () => loadNimbusIncidentPredictFromConfigDir(paths.configDir),
    serviceConfigs: () => loadNimbusServiceConfigsFromConfigDir(paths.configDir),
    nowMs: Date.now,
    ...(paths.demo === true
      ? {}
      : {
          notify: (title: string, body: string) => {
            void showIgnoringFailure(notifications, title, body);
          },
        }),
    emit: (p) => emitGatewayEvent("incident.finding", { ...p }),
    onError: (err) => syncLogger.warn({ err }, "incident predict pass failed"),
  });
  sidecarStops.push(() => incidentPredict.stop());

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

  // Overnight agent fleet (S2). DEFAULT OFF twice over: `[fleet] enabled` is false by default and
  // no job is configured by default, so a gateway with no `[fleet]` block constructs nothing at
  // all. Built here, after the policy gate, because it reads the `agent_fleet` lockoff from it.
  //
  // Called exactly ONCE: `ipcOpts.fleetRpcCtx` (wired further down) is derived from this single
  // result, and its supervisor rebuilds the scheduler when `[fleet]` changes — see
  // `assembleFleetRuntime`'s own doc comment for why a second call would double-prune and start a
  // second live scheduler.
  const fleetRuntime = assembleFleetRuntime({
    db,
    paths,
    localIndex,
    llmRegistry,
    hostActivity,
    policyGate,
    logger: syncLogger,
    sidecarStops,
  });

  // Extension runtime PR 3: the kill switch (read on its own, so a bad sibling key cannot re-enable
  // it) AND not demo-rooted. One answer, handed to both the mesh and the IPC server.
  const extensionRuntimeEnabled = isExtensionRuntimeEnabled(
    { runtime: loadNimbusExtensionsRuntimeFromConfigDir(paths.configDir) },
    paths,
  );
  // No extension spawns before the boot-time verification pass below has hard-disabled what fails
  // it. Resolved in a `finally`, so a throwing pass cannot wedge every extension forever — the
  // per-spawn verifier still refuses anything that fails.
  const extensionSpawnGate = Promise.withResolvers<void>();
  const extensionObservationDir = startExtensionObservation(
    db,
    paths.dataDir,
    syncLogger,
    sidecarStops,
    notifications,
  );

  const {
    syncScheduler,
    connectorMesh,
    glossaryRefresher,
    decisionsRefresher,
    ownershipRefresher,
    premortemRefresher,
    oncallPush,
    incidentEngine,
    watcherChat,
    watcherPinnedChannel,
    policyFilteredRegistrar,
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
    ...(dataDirRevoke === undefined ? {} : { filesystemSpawnGate: dataDirRevoke }),
    // I15 (AD5b): whether this OS's sandbox can confine a user MCP server's write directory.
    userMcpCanConfine: (policy) => sandboxRunner.canConfine(policy),
    extensionRuntimeEnabled,
    extensionSpawnGate: extensionSpawnGate.promise,
    continuityTable: migration.continuityTable,
    extensionObservationDir,
  });
  // One `stop` per refresher that actually started. Three of the four are
  // optional (their passes are config-gated), and the repeated
  // `if (x !== undefined) push(...)` was a third of this function's
  // cognitive-complexity score (Sonar S3776, 17 against a limit of 15) for no
  // structural benefit.
  agentDoorMesh.current = connectorMesh;
  pushStops(sidecarStops, [
    glossaryRefresher,
    decisionsRefresher,
    ownershipRefresher,
    premortemRefresher,
    // The live `[oncall.push] enabled` reader's timer must not outlive shutdown.
    oncallPush,
  ]);

  // Trust layer (I48): when a statement newly blocks an installed extension, stop its client and
  // notify the owner once. Every recording path reaches this hook: the boot snapshot below, and the
  // registry fetches and trust feed through the shared `registryFetch` deps.
  const trustEnforcer = createTrustBlockEnforcer({
    db,
    stop: (id) => connectorMesh.stopExtensionClient(id),
    notify: (title, body) => showIgnoringFailure(notifications, title, body),
    logger: syncLogger,
  });
  const onTrustRecorded = (ids: readonly string[]): void => void trustEnforcer.onRecorded(ids);
  // Record each installed extension's verifying key and apply the baked trust snapshot BEFORE the
  // gate opens. Never throws, so the gate below still always resolves.
  await prepareTrustAtBoot({
    db,
    vault,
    logger: syncLogger,
    onTrustRecorded,
    trustFeed: trustComposition.feed,
    snapshot: trustComposition.snapshot,
  });
  try {
    await verifyExtensionsBestEffort(
      db,
      syncLogger,
      connectorMesh,
      { vault },
      undefined,
      paths.extensionsDir,
    );
  } finally {
    extensionSpawnGate.resolve();
  }

  // The extension sync host (connector-unbundling pilot, spec § 8.3). Built only AFTER the boot
  // verification pass, so nothing it registers is something that pass just hard-disabled, and only
  // when the runtime is on and the scheduler can run (not demo-rooted, I41). Registration goes
  // through the same I22 policy filter as every other mesh-backed syncable.
  const extensionSyncRegistrar = createExtensionSyncRegistrarForBoot(
    { runtimeEnabled: extensionRuntimeEnabled, syncEnabled: bootPolicyFor(paths).syncScheduler },
    {
      db,
      vault,
      scheduler: {
        register: (c, i) => policyFilteredRegistrar.register(c, i),
        unregister: (id) => syncScheduler.unregister(id),
        pause: (id, reason) => syncScheduler.pause(id, reason),
        resume: (id) => syncScheduler.resume(id),
        syncableFor: (id) => syncScheduler.syncableFor(id),
      },
      mesh: connectorMesh,
      sandbox: sandboxRunner,
      runtimeReadPaths: () => resolveRuntimeById("bun").requiredReadPaths(),
      table: migration.continuityTable,
      logger: syncLogger,
    },
  );
  extensionSyncRegistrar.registerAllFromDatabase();

  // Extension registries: ONE air-gap switch (the LLM router's `enforce_air_gap`), read per call from
  // the router's boot-resolved config; it does not track a later config or policy change. The SAME
  // object reaches the `registry.*` methods, the auto-update daemon and the migration engine.
  const registryFetch: Omit<RegistryFetchDeps, "db"> = {
    fetchFn: (url, init) => fetch(url, init),
    enforceAirGap: () => llmRegistry.llmRouter.enforcesAirGap(),
    now: Date.now,
    // The compiled release binary counts as production even with NODE_ENV unset (it always is).
    production: isProductionRuntime(),
    // The SAME built-in the migration engine gets (ruling B1): the baked built-in registry, unless a
    // test runner passed a fixture to this function. No env var, config key or IPC param sets it.
    builtin: migration.builtin,
    onTrustRecorded,
  };

  // The connector migration engine (connector-unbundling spec § 7.2): built after the extension boot
  // gate and the sync registrar it registers through, and handed the SAME continuity table and
  // built-in registry as the registrar, the spawn verifier and the registry fetch above. Boot
  // evaluation is skipped when demo-rooted (I41), never awaited, and never fatal.
  const migrationEngine = createMigrationEngineForBoot({
    db,
    vault,
    dataDir: paths.dataDir,
    extensionsDir: paths.extensionsDir,
    registryFetch,
    composition: migration,
    // The SAME builder `extension.approveRun` and the spawn verifier use.
    env: buildExtensionRunGrantEnv(connectorMesh.userMcpProtectedRoots(), paths.extensionsDir),
    runtimeEnabled: extensionRuntimeEnabled,
    sandbox: sandboxRunner,
    extensionSync: extensionSyncRegistrar,
    scheduler: syncScheduler,
    logger: syncLogger,
  });
  void startMigrationBootEvaluation(migrationEngine, paths.demo === true, syncLogger);
  // The Nimbus trust feed (trust layer), on the same fetch deps as the registries; nothing is
  // fetched when this build has no feed configured, and a demo-rooted gateway gets no handle (I41).
  const trustFeed = startTrustFeedForBoot({
    db,
    configDir: paths.configDir,
    demoRooted: paths.demo === true,
    registryFetch,
    logger: syncLogger,
    sidecarStops,
    trustFeed: trustComposition.feed,
  });
  const autoUpdateRuntime = maybeStartAutoUpdateRuntime({
    db,
    vault,
    paths,
    connectorMesh,
    sidecarStops,
    registryFetch,
    onUpdateApplied: (id) => extensionSyncRegistrar.refresh(id),
    freshenTrust: () => freshenTrustFeed(trustFeed, db, Date.now()),
  });

  rt?.startBackgroundJobs();
  const ipcOpts: Parameters<typeof createIpcServer>[0] = {
    // I22 — the tighten-only HITL overlay, handed to every ToolExecutor this server builds.
    // Set in the literal, not assigned later: `bootTribalKnowledge` receives `ipcOpts` and
    // builds its own executor from it, so a post-hoc assignment would depend on that read
    // staying lazy. Until 2026-08-16 nothing consumed the resolved policy at all — an admin
    // could sign `[policy.hitl] require = [...]`, see it verify, and get no gate.
    policyHitl,
    // LIVE getter (I22): `connector.writesEnable` reads the policy per call, not at boot.
    enforcedPolicy: () => policyGate.enforced(),
    listenPath: paths.socketPath,
    vault,
    version: GATEWAY_VERSION,
    localIndex,
    dbPath,
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    demo: paths.demo === true,
    extensionsDir: paths.extensionsDir,
    extensionsRuntimeEnabled: extensionRuntimeEnabled,
    extensionSync: {
      refresh: (id) => extensionSyncRegistrar.refresh(id),
      syncServiceIdFor: (id) => extensionSyncRegistrar.syncServiceIdFor(id),
      unregister: (id) => extensionSyncRegistrar.unregister(id),
      // Always wired, runtime on or off: items an extension synced earlier go with it either way.
      purgeBeforeRemove: (id) =>
        purgeExtensionIndexData({ db, vault, localIndex, table: migration.continuityTable }, id),
    },
    migrationEngine,
    // The SAME table the registrar, the spawn verifier and the credential resolver get (C7):
    // `extension.approveRun`, `extension.credentialSet` and `connector.remove` bind through it.
    continuityTable: migration.continuityTable,
    registryFetch,
    ...(trustFeed === undefined ? {} : { trustFeed }),
    packLayerStore,
    openUrl: openUrlInDefaultBrowser,
    syncScheduler,
    connectorMesh,
    sandboxRunner,
    sandboxDir: paths.sandboxDir,
    llmRegistry,
    ...autoUpdateIpcOpts(autoUpdateRuntime, paths.configDir, registryFetch.enforceAirGap()),
  };
  assignIfPresent(ipcOpts, "sessionMemoryStore", sessionMemoryStore);
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
    isConnectorAllowed,
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
  if (bootPolicy.envSidecars && clipHttpPort !== undefined) {
    ipcOpts.clipHttpBaseUrl = `http://127.0.0.1:${clipHttpPort}`;
  }

  const httpSidecarOpts: HttpSidecarOpts = {
    clipsVault: vault,
    pairingController,
    ...(scheduleItemEmbedding === undefined ? {} : { scheduleEmbedding: scheduleItemEmbedding }),
  };

  // Research briefs (Spine S1). Default-off; the seam stays absent unless [briefs].enabled.
  const briefsToml = loadNimbusBriefsFromConfigDir(paths.configDir);
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
  // Telemetry agent-invocation latency. ONE in-memory ring for the process, constructed before
  // every writer (socket/HTTP/ChatOps `agents.*` dispatch, both `runAsk` sites in
  // `gateway-main.ts`) and reader (`telemetry.preview`/`getStatus`, the opt-in flush) is built.
  const agentLatencyRecorder = new AgentLatencyRecorder();
  ipcOpts.agentLatencyRecorder = agentLatencyRecorder;
  bootAgentsIntoHttpSidecar({
    db,
    localIndex,
    configDir: paths.configDir,
    selfIdentity: ipcOpts.federationIdentity,
    llmRouter: llmRegistry.llmRouter,
    httpSidecarOpts,
    agentLatencyRecorder,
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
    ? bootTribalKnowledge({
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
    chatopsAllowedByBootPolicy: bootPolicy.chatops,
    watcherPinnedChannel,
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
    connectorWriteDeps,
  });
  settleOncallPushChatops(oncallPush, chatopsBoot);
  settleWatcherChatops(watcherChat, chatopsBoot);

  // ChatOps agent-intent path (Task 9 / FIX 1): `@nimbus agent <name> k=v ...` runs a real
  // built-in agent through `dispatchAgentsRpc`. Bound HERE rather than post-boot in
  // `gateway-main.ts` so it can carry the real `federationIdentity` — see
  // `bootChatopsAgentInvoker`'s doc comment above for why the old call site could not.
  bootChatopsAgentInvoker({
    chatopsBoot,
    db,
    localIndex,
    configDir: paths.configDir,
    // The fix: `ipcOpts.federationIdentity` is populated by `bootFederationIntoIpcOpts` above
    // (undefined when `[federation]` is disabled — `federatedAgentBase` falls back to
    // `ZERO_IDENTITY` in that case, same as the HTTP invoker).
    selfIdentity: ipcOpts.federationIdentity,
    llmRouter: llmRegistry.llmRouter,
    agentLatencyRecorder,
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

  // I35 (S2 slice 2): the computer-use surface. DEFAULT OFF — `enabled` and `allowed_lanes` are
  // read from `[computer_use]`, and the gate refuses before consent when either is empty, so wiring
  // the ctx unconditionally enables nothing. The org-policy half is read LAZILY through
  // `policyGate.enforced()` rather than snapshotted, so a policy installed after boot tightens the
  // next session rather than the next restart.
  //
  // `resolveBrowserPath`/`buildLaunchPolicy`/`assertLaunchable`/`openLane` are the four `CuGateDeps`
  // seams the browser driver owns, and THIS IS THE ONLY FILE THAT SUPPLIES THEM (static rule
  // D26(c) confines `openBrowserLane` to this file plus its own definition, the same shape D22(f)
  // uses for `wrapLedgeredEmbedder`). Injecting them rather than importing the driver into
  // `cu-gate.ts` is what keeps the gate testable with no browser installed and clear of the
  // D26(b) driver-capability confinement.
  //
  // `[computer_use] browser_profile_dir` defaults to the EMPTY string, meaning "use
  // `<configDir>/computer-use/profile`" (spec § 9). That default is resolved HERE, at the one layer
  // that knows `configDir`, and never inside the gate: `assertBrowserLaunchPolicy` refuses an empty
  // or relative profile directory outright, because Chromium with no `--user-data-dir` runs against
  // the OWNER'S REAL PROFILE — their cookies, sessions and history. An unresolved default must fail
  // the launch assertion, not fall back to something plausible.
  const computerUseCfg = loadNimbusComputerUseFromConfigDir(paths.configDir);
  const cuBrowserProfileDir =
    computerUseCfg.browserProfileDir === ""
      ? join(paths.configDir, "computer-use", "profile")
      : computerUseCfg.browserProfileDir;
  const cuConfig: NimbusComputerUseToml = {
    ...computerUseCfg,
    browserProfileDir: cuBrowserProfileDir,
  };

  // Reconcile `cu_session` rows orphaned by a previous gateway process, BEFORE any session of this
  // one can be opened (see `cu-boot-reconcile.ts`): the durable table survives a restart and the
  // gate's in-memory `liveSessions` map does not, so without this they disagree permanently — a
  // session shows open forever, `sessionClose` answers `not_found`, and the CLI's watch loop never
  // exits. Best-effort, matching `appendBootMarkerOrWarn`: a bookkeeping failure must not abort
  // gateway startup, and staying silent about it is what would make it a bug rather than an event.
  reconcileOrphanedCuSessionsOrWarn(db, syncLogger);

  // I35 (OR-MCU-2): the gate deps are built PER CONNECTION, so the envelope prompt goes to the
  // connection that OPENS a session, and every action prompt of that session to the same connection
  // (the gate reads it from the session's open-time deps), and to no other. A fresh object per call
  // keeps the `enforced` getter live (a spread would snapshot it).
  const cuGateDepsFor = (clientId: string): CuGateDeps => ({
    config: cuConfig,
    get enforced() {
      return policyGate.enforced();
    },
    db,
    now: () => Date.now(),
    newId: () => randomUUID(),
    lanes: {
      browser: {
        resolveBrowserPath: resolveChromiumPath,
        buildLaunchPolicy: buildChromiumLaunchPolicy,
        assertLaunchable: assertBrowserLaunchPolicy,
        openLane: (opts) => openBrowserLane(opts),
      },
      // THE ONLY PRODUCTION SITE that may name `openTerminalLane` (static rule D26(c)). Injecting
      // it rather than importing the driver into `cu-gate.ts` is what keeps the gate testable with
      // no shell present and clear of the driver-capability confinement.
      terminal: {
        defaultShellId: DEFAULT_SHELL_ID,
        resolveShellPath: (shellId) => {
          let shell: CuShell;
          try {
            shell = resolveShellById(shellId);
          } catch {
            // `CuShellError("ERR_CU_UNKNOWN_SHELL")`, converted to a STATUS rather than allowed
            // to propagate: this seam's contract is to report what it found, and a throw crossing
            // into the gate would be flattened to `ERR_CU_FAILED` by its outer catch.
            return { status: "unknown_shell" };
          }
          const shellPath = shell.detect();
          return shellPath === null
            ? { status: "not_installed" }
            : { status: "ok", shellPath, argv: shell.argv(), envOverlay: shell.envOverlay() };
        },
        buildLaunchPolicy: ({ sessionId, shellId, shellPath, cwd }) =>
          buildTerminalLaunchPolicy({
            sessionId,
            shell: resolveShellById(shellId),
            shellPath,
            cwd,
          }),
        // Reuses the runner constructed at the top of this function rather than probing again:
        // `createSandboxRunner` synchronously spawns the Windows helper with `--check-caps`
        // (creating and deleting a throwaway AppContainer profile), and a second call pays that
        // cost for an answer that cannot differ within one process.
        assertLaunchable: assertTerminalLaunchable(sandboxRunner),
        openLane: (opts) => openTerminalLane(opts),
      },
    },
    // `CuGateDeps.requestApproval` takes the UNION of the two approval-input shapes; routed on
    // the `promptKind` DISCRIMINANT. This used to probe `"seq" in input` — a structural property
    // standing in for a tagged union, sound only because `seq` happened to exist on one shape and
    // not the other. Adding a `seq` to the envelope input would have silently routed every
    // session-open prompt to the ACTION broker, whose renderer draws a different prompt entirely:
    // the owner would be asked to approve "a browser action" while the origin lists and budgets
    // they were actually granting went unshown. `switch` on a literal makes a third prompt kind a
    // compile error here instead.
    requestApproval: (input) => {
      const ttlMs = (ipcOpts.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000;
      switch (input.promptKind) {
        case "envelope":
          return cuEnvelopeConsent.requestFor(clientId, input, ttlMs);
        case "action":
          return cuActionConsent.requestFor(clientId, input, ttlMs);
        default: {
          const exhaustive: never = input;
          throw new Error(`unrecognised computer-use approval kind: ${String(exhaustive)}`);
        }
      }
    },
  });
  ipcOpts.computerRpcCtx = {
    envelopeConsent: cuEnvelopeConsent,
    actionConsent: cuActionConsent,
    gateDepsFor: cuGateDepsFor,
  };
  // A connection that goes away settles its own computer-use prompts as denials at once (OR-MCU-2).
  ipcOpts.onClientDisconnected = (clientId) => {
    cuEnvelopeConsent.onClientDisconnect(clientId);
    cuActionConsent.onClientDisconnect(clientId);
  };
  // I35 (OR-MCU-1): the model may drive only a session the owner opened and THIS process holds
  // open. Its RUN deps carry no lane spawner (the tool layer never gets `CuGateDeps`), and every
  // action prompt still goes to the connection that opened the session (OR-MCU-2), never to the
  // ask turn; the turn's own channel answers nothing.
  const computerUseFor = (sessionId: string): ComputerUseBinding | undefined => {
    if (!cuConfig.enabled) return undefined;
    const lane = liveSessionLane(sessionId);
    if (lane === undefined) return undefined;
    const runDeps: CuRunDeps = {
      config: cuConfig,
      get enforced() {
        return policyGate.enforced();
      },
      db,
      // Never asked: `runAction` prompts through the session's open-time channel.
      requestApproval: async () => false,
    };
    return { session: { sessionId, lane }, gateDeps: runDeps };
  };

  // Multimodal I/O (S2). Only the org-policy accessor: the local `[multimodal] enabled` switch and
  // the roots are re-read per call in the dispatcher. LAZY through `policyGate.enforced()` rather
  // than snapshotted, so a policy installed after boot tightens the next pass rather than the next
  // restart — the same shape as execRpcCtx and computerRpcCtx above.
  ipcOpts.mediaRpcCtx = {
    get enforced() {
      return policyGate.enforced();
    },
  };

  // Snapshot retention (Task 15, spec § 8.4): the same daily-cadence sidecar shape as
  // `startToolCallLogRetention` above, driven by `[computer_use] snapshot_retention_days`. NULLs
  // `dom_before`/`dom_after` on `cu_action` rows past the window; the row itself and its
  // `audit_log` decision are permanent. Deliberately NOT routed through `egress.prune` (I29) —
  // `cu_action` is not the egress ledger and gets its own, unchained prune.
  const cuSnapshotRetention = startCuSnapshotRetention(db, {
    retentionDays: computerUseCfg.snapshotRetentionDays,
  });
  sidecarStops.push(() => cuSnapshotRetention.stop());

  // FinOps sidecars (FO2 retention, OR-FO-5; the cost anomaly notice, off unless `[finops] notify`). Static rule D48.
  startFinopsSidecars({ db, paths, notifications, logger: syncLogger, sidecarStops });

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

  // S2 overnight agent fleets (Task 9). `store`/`config`/`jobs` are always present (see
  // `assembleFleetRuntime`'s doc comment) so `fleet.status`/`fleet.list` can report the truth even
  // when the scheduler itself is `undefined` — disabled by config/policy, or unconfigured. The
  // whole namespace is LAN-forbidden (I5) and absent from the Tauri allowlist (I7): `fleet.runNow`
  // spends the machine's resources and the reads return synthesised answers over the private
  // index, neither of which a LAN peer or the renderer needs.
  ipcOpts.fleetRpcCtx = fleetRpcCtxFor(fleetRuntime, hostActivity);
  ipcOpts.oncallPushRpcCtx = { runtime: oncallPush };
  // Morning briefing (Phase 10 MB5): briefing.* (the four reads are renderer-callable, runNow is
  // CLI-only; LAN-forbidden). The scheduler exists only off the demo root (I41); `gateway-main.ts` starts
  // and retires it. The unread-Slack reader (MB4) is the one seam line below.
  const briefing = createBriefingRuntime({
    db,
    configDir: paths.configDir,
    now: Date.now,
    // The SAME identity source `agents.oncall` and the on-call push use.
    resolveSelf: async () => {
      const user = loadNimbusUserFromConfigDir(paths.configDir);
      const r = await resolveSelfPerson(
        db,
        user.mePersonId === undefined ? {} : { override: user.mePersonId },
      );
      return r.personId;
    },
    emit: (p) => emitGatewayEvent("briefing.ready", { ...p }),
    toast: (title, body) => showWithOutcome(notifications, title, body),
    toastDelivers: () => notifications.delivers !== false,
    // Not spelled like the IPC options line: the I41 wiring pin counts that exact text once.
    demo: Boolean(paths.demo),
    readUnreadChat: readUnreadChatThreads,
    logger: syncLogger,
  });
  ipcOpts.briefingRpcCtx = { runtime: briefing };
  // Incident records (Phase 10 IC3): incident.list / get / assemble. cli/ui connections only (checked per
  // call from the connection's declared kind); LAN-forbidden (I5), not Tauri-exposed (I7).
  // IC5a: the remediation service. The executor factory is bound by `gateway-main.ts` (it owns the connector
  // dispatcher and the egress sink); until then, and on a demo gateway (I41), remediate and undo refuse.
  let incidentExecutorFactory: MakeExecutor | undefined;
  const incidentExecutor: MakeExecutor = (o) => {
    if (incidentExecutorFactory === undefined) throw new Error("no remediation executor");
    return incidentExecutorFactory(o);
  };
  const remediation = createRemediation({
    db,
    makeExecutor: incidentExecutor,
    ready: () => incidentExecutorFactory !== undefined,
    bindingsFor: (service) => loadServiceBindings(paths.configDir, service),
    // A malformed block degrades to an empty blast radius here (the listing must still work).
    dependsOn: () => {
      try {
        return loadDependsOnMap(paths.configDir);
      } catch {
        return new Map();
      }
    },
  });
  // IC6: the owner's runbooks (the TOML files under `<configDir>/runbooks`), run one step at a time on the SAME executor
  // factory as remediation (human-only consent on the asking connection, no delegation, no standing rule).
  const runbooks = createRunbooks({
    db,
    makeExecutor: incidentExecutor,
    ready: () => incidentExecutorFactory !== undefined,
    configDir: () => paths.configDir,
    bindingsFor: (service) => loadServiceBindings(paths.configDir, service),
  });
  ipcOpts.investigationLive = createLiveInvestigator({ db, makeExecutor: incidentExecutor });
  // IC5b (approve-from-push): the push carries its record's top proposal, read through the owner listing only.
  oncallPush.bindTopProposal((recordId) => remediation.topProposal(recordId));
  ipcOpts.incidentRpcCtx = {
    db,
    engine: incidentEngine,
    // A malformed block THROWS (not an empty map): the cascade then reads as unavailable.
    dependsOn: () => loadDependsOnMap(paths.configDir),
    // IC9a: `incident.investigate` reads a service's declared `sentry_projects`; a malformed block reads as unreadable.
    serviceConfigs: () => loadNimbusServiceConfigsFromConfigDir(paths.configDir),
    remediation,
    runbooks,
    // `incident.debt` (IC7b): the same git-aware roots the ownership pass binds (`[[filesystem.roots]]` plus
    // the CLI-registered ones), re-read per call; git runs only from `debt/`.
    debt: {
      roots: () =>
        gitAwareRootPaths(
          loadNimbusFilesystemRootsFromConfigDir(paths.configDir),
          loadRegisteredRoots(paths.configDir),
        ).map((path) => ({ path, gitAware: true })),
    },
  };
  // pre-S3 item E: notifications.status / notifications.test (CLI-only; LAN-forbidden, not Tauri).
  ipcOpts.notificationsRpcCtx = { runtime: notificationsRuntime };
  // IaC drift D2 (OR-DRIFT-1): iac.driftCheck / iac.driftLatest (CLI only; LAN-forbidden, not Tauri). The runner is
  // bound by `gateway-main.ts`; until then, and on a demo gateway (I41), both refuse.
  let iacDriftRunner: IacDriftRunner | undefined;
  ipcOpts.iacDriftRpcCtx = { runner: () => iacDriftRunner };
  // MCP capture sink (I28): capture.* / captures.* (LAN-forbidden by namespace, not Tauri, no HTTP).
  // I28 act door: the SAME dispatcher composition runAsk (gateway-main.ts) and ChatOps use, the real
  // egress sink (I29) and the process's policy overlay (I22). Default off twice ([mcp_sink] kinds +
  // mcp_action); wiring it unconditionally enables nothing.
  ipcOpts.captureRpcCtx = {
    gate: captureGate,
    act: {
      dispatcher: createConnectorWriteDispatcher(
        createConnectorDispatcher(meshDispatcherClient(connectorMesh)),
        connectorWriteDeps,
      ),
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl,
      // The typed preview's `Credential:` line reads the same pin the write itself uses (as runAsk).
      previewCredentialFor: previewCredentialResolver(connectorWriteDeps, connectorMesh),
      // Phase 28 AD1: the before-state guards read the tribal KB destinations, from the same
      // accessor as `platform.tribalKbConfig` (the model door's) and the act door's destination refusal.
      getTribalKbConfig: () => tribalKbConfigOf(tribalCfg, tribalUnreadable),
      agentDoor: {
        listServerTools: (service) => connectorMesh.listFirstPartyServerTools(service),
        verifyDefinition: agentDoor.verifyDefinition,
        userMcpCallFacts: agentDoor.userMcpCallFacts,
      },
    },
    // `capture.describe` (AD3a-2b): the SAME door the gate checks submits with, and a limiter of its
    // own, so describes and submits cannot starve each other.
    describe: { limiter: new CaptureAttemptLimiter(), actions: agentDoor.describe },
  };

  // I39 (S2 runtime tool generation): the sandboxed, owner-approved, session-ephemeral tool
  // registration surface. DEFAULT OFF -- `enabled` is read from `[tool_generation]`, and
  // `createGeneratedTool` refuses before consent when it is false, so wiring the ctx
  // unconditionally does not enable anything. The org-policy half is read LAZILY through
  // `policyGate.enforced()` rather than snapshotted here, so a policy installed after boot
  // tightens the next registration rather than the next restart -- the same shape as execRpcCtx
  // and computerRpcCtx above.
  //
  // Boot-time sweep (Task 5): a generated tool is ephemeral by construction, and its Vault
  // credential must be too. Run this BEFORE `toolgenRegistry` below is populated by anything, so
  // it only ever cleans up what a PREVIOUS process left behind -- a crash between approval and
  // registration, a kill signal that skipped the shutdown drain in `gateway-main.ts` entirely, or
  // (belt-and-suspenders) a `toolgen.revoke`/shutdown sweep that itself failed partway. Nothing in
  // this process could have written a `toolgen.`-prefixed credential yet at this point, so there
  // is no live credential this can race.
  //
  // `...OrWarn`, not the bare sweep: `createPlatformServices()` is awaited unguarded at
  // `gateway-main.ts`'s call site, so an unguarded Vault I/O failure here (a locked/temporarily
  // inaccessible OS keychain) would abort the ENTIRE gateway boot over a bookkeeping pass --
  // matching `appendBootMarkerOrWarn`/`reconcileOrphanedCuSessionsOrWarn` above.
  await sweepToolgenCredentialsOrWarn(vault, syncLogger);

  // Boot reconciliation for SAVED (persisted) generated tools (spec § 7.1, Task 8): re-verify every
  // `generated_tool` row against the Vault's current signing pubkey, repairing/re-enabling what
  // still verifies and disabling what does not, then sweep any `saved/<toolId>` directory with no
  // row. Run AFTER the credential sweep above (so a stale credential is gone before anything reads
  // saved-tool state) and BEFORE `toolgenRegistry` below is populated by anything -- this pass never
  // spawns a child process and never registers a tool itself, it only updates the database and the
  // `saved/` directory a later load reads from.
  //
  // `...OrWarn`, matching `sweepToolgenCredentialsOrWarn` immediately above: a database or
  // filesystem failure here must not abort gateway boot over a health-check pass.
  //
  // Loaded HERE rather than at `toolgenRegistry` below, because both boot passes now read it: the
  // `[tool_generation] enabled` kill switch and the org-policy lock-off have to reach the DURABLE
  // half (reconcile + load), not only creation and saving, or turning the capability off leaves
  // every already-approved saved tool loading and model-visible in every future session.
  const toolGenerationCfg = loadNimbusToolGenerationFromConfigDir(paths.configDir);
  await reconcileSavedToolsOrWarn({
    db,
    configDir: paths.configDir,
    vault,
    logger: syncLogger,
    config: toolGenerationCfg,
    // An EAGER snapshot of `policyGate.enforced()`, deliberately NOT the lazy getter
    // `toolgenGateDeps`/`toolgenSaveDeps` use below: both boot passes run synchronously right here,
    // so "at the moment of the pass" and "at the moment of construction" are the same instant, and
    // a getter would imply a re-read that never happens. `isToolgenCapabilityEnabled` fails CLOSED if
    // this is ever `undefined`, so a policy layer that could not resolve disables the durable half
    // rather than defaulting it on.
    enforced: policyGate.enforced(),
  });

  // `toolgenRegistry` is the ONE registry instance shared by three places: the gate (counts a
  // session's budget and registers a live tool), the broker's `approvedHostsFor` AND
  // `credentialHostsFor` (both read back the same artifact the owner approved -- fail-closed
  // `?? []` for an unknown/revoked toolId), and `PlatformServices.toolgenRegistry`, which
  // `gateway-main.ts`'s shutdown drains.
  const toolgenRegistry = new ToolgenRegistry();

  // Populate the registry's SAVED collection (Task 9, spec § 7.2) so a persisted tool is visible
  // to every session, not only demonstrable in a unit test that calls `registerSaved` by hand.
  // This RE-VERIFIES every row against the Vault's CURRENT pubkey rather than trusting
  // `reconcileSavedToolsOrWarn`'s cached `disabled_reason` column -- see
  // `loadSavedToolsIntoRegistry`'s docstring for why a health-report cache is never an authority a
  // loader may rely on. It is still not the security GATE: `spawnSavedTool` (invoked wherever a
  // saved tool is actually called) verifies a THIRD time before anything runs, and re-checks the
  // reconstructed manifest against the signed shape besides -- this load only decides what the
  // model and `nimbus tool list` are OFFERED.
  //
  // Wrapped, not `...OrWarn`-style delegated: a Vault or filesystem failure here must not abort
  // gateway boot over saved-tool visibility, matching the credential sweep and reconciliation pass
  // immediately above.
  try {
    await loadSavedToolsIntoRegistry(
      {
        db,
        configDir: paths.configDir,
        vault,
        runtime: resolveRuntimeById("bun"),
        // The same kill switch the reconcile pass above reads, for the same reason: this load is
        // what makes a saved tool visible to `forSession` and therefore OFFERED to the model.
        config: toolGenerationCfg,
        enforced: policyGate.enforced(),
      },
      toolgenRegistry,
    );
  } catch (err) {
    syncLogger.warn(
      { err },
      "toolgen: could not load saved tools into the registry this boot; they remain saved but " +
        "are not visible until the next successful boot",
    );
  }

  const toolgenBroker = new ToolgenBroker({
    db,
    now: () => Date.now(),
    maxRequestsPerTool: toolGenerationCfg.maxRequestsPerTool,
    requestTimeoutMs: toolGenerationCfg.requestTimeoutMs,
    resolveHost: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
    readCredential: (toolId, host) => readToolCredential(vault, toolId, host),
    // The artifact the owner approved IS the source of truth for this list -- an unknown or
    // revoked toolId gets NO approved hosts (the `?? []`), so every request from it is refused
    // and ledgered `blocked` rather than falling back to some other notion of "approved".
    // `findArtifact`, not `get`: a request may come from a SPAWNED SAVED tool (Task 12's
    // `spawnSavedTool`), which lives in the registry's saved collection, not its ephemeral one --
    // `get`'s `?? []` would refuse every host for such a tool regardless of what was approved.
    approvedHostsFor: (toolId) => toolgenRegistry.findArtifact(toolId)?.approvedHosts ?? [],
    // Mirrors `approvedHostsFor` immediately above: the SAME signed artifact (ephemeral or saved),
    // the same fail-closed `?? []` for an unknown/revoked toolId, so an unregistered tool is
    // refused for both reasons at once rather than being treated as "no credential was ever
    // promised".
    credentialHostsFor: (toolId) => toolgenRegistry.findArtifact(toolId)?.credentialHosts ?? [],
    // A bare pass-through, deliberately -- `redirect: "error"` is set by `toolgen-broker.ts`
    // itself on the `init` it builds, not here, so the guarantee travels with the broker's checks
    // rather than living in this one wiring site (see `ToolgenBroker.handleFetch`'s docstring).
    doFetch: (url, init) => fetch(url, init),
  });
  const toolgenGateDeps: ToolgenGateDeps = {
    db,
    config: toolGenerationCfg,
    get enforced() {
      return policyGate.enforced();
    },
    registry: toolgenRegistry,
    // `subject` is resolved by the GATE (Task 9's normalised host list + credential-host subset)
    // and passed straight through -- it cannot be computed here: this closure is built ONCE at
    // boot, while approved hosts and their credential subset are per-request, and at draft time
    // nothing has been written to the Vault yet (`bindCredentials` runs AFTER drafting), so
    // probing the Vault from this closure would report nothing even if a boot-time closure could
    // see the request. `generate`/`hasDraftRoute`/`findEndpoints` are the only deps
    // `draftGeneratedTool` needs; all three are cheap, stateless wrappers over services already in
    // scope here.
    //
    // Built via `createDraftToolClosure` (`toolgen-draft.ts`), not an inline arrow, so the e2e test
    // (`test/integration/toolgen/toolgen-draft-e2e.test.ts`) drives this EXACT composition over its
    // own fake `generate`/`findEndpoints` rather than a test-authored copy of the shape -- reverting
    // this call, or how it is built, changes what that test exercises too.
    draftTool: createDraftToolClosure({
      generate: createToolgenDraftLlm(llmRegistry.llmRouter, toolGenerationCfg.drafting),
      // Shares ONE mode/locality decision with `generate` above (`resolveDraftProvider`), and is
      // what lets `draftGeneratedTool` refuse `drafting = "off"` BEFORE `findEndpoints` embeds the
      // description — which is an outbound request whenever `[embedding]` names a remote vendor.
      hasDraftRoute: createToolgenDraftRouteProbe(
        llmRegistry.llmRouter,
        toolGenerationCfg.drafting,
      ),
      findEndpoints: createEndpointFinder(localIndex),
    }),
    assertConfinement: (manifest) => {
      // The probe spawns through the runner directly (not sandbox-wrapper.ts), so its own per-policy
      // directory must exist before the spawn: canonical-path.ts falls back to the input spelling
      // for a missing path.
      const probeCwd = sandboxCwdFor(paths.sandboxDir, "toolgen-probe");
      mkdirSync(probeCwd, { recursive: true });
      return assertToolConfinement({ runner: sandboxRunner, manifest, cwd: probeCwd });
    },
    scriptDir: (toolId) => toolScriptDir(paths.configDir, toolId),
    writeScript: (toolId, source) => writeToolScript(paths.configDir, toolId, source),
    // cwd is the script's OWN directory: the manifest grants read only to `scriptDir(toolId)` plus
    // the runtime's own read paths, so spawning from anywhere else grants nothing extra and only
    // adds a directory the sandbox does not know about.
    // The exit callback is what makes `forSession`/`countForSession`'s "live tools only" claim
    // real: without it, nothing ever observes a generated tool's child dying, so a crashed tool
    // stays listed, stays model-visible and permanently burns a `maxToolsPerSession` slot.
    spawn: (envelope) =>
      spawnGeneratedTool(envelope, toolgenBroker, dirname(envelope.scriptPath), () =>
        toolgenRegistry.markTerminated(envelope.artifact.toolId),
      ),
    requestApproval: (input, ttlMs) => toolgenConsent.request(input, ttlMs),
    // A SEQUENTIAL per-host write loop -- acceptable because the gate (Task 9) already carries the
    // compensating guarantee: it records the ATTEMPTED host set and flips its own `credentialsBound`
    // flag BEFORE awaiting this call, so a throw partway through still leaves the gate with an
    // accurate cleanup list. No compensating logic belongs here too -- that would be a second place
    // for the same guarantee to drift from the gate's.
    bindCredentials: async (toolId, credentials) => {
      const bound: string[] = [];
      for (const c of credentials) {
        await writeToolCredential(vault, toolId, c.host, c.binding); // NOSONAR S9382: Vault WRITES - macOS set() updates `.keyindex.json` by an unlocked read-modify-write, so concurrent sets lose index entries; one at a time also stops at the first failure rather than writing more secrets for a tool that may never register
        bound.push(c.host);
      }
      return bound;
    },
    // Idempotent by contract: called on paths where a binding may never have been written, and
    // `deleteToolCredential` on an absent key is a no-op. `hosts` comes from the GATE's ATTEMPTED
    // set (Task 9 step 8), never a registry lookup -- the tool is by definition unregistered on
    // every path that calls this.
    // EVERY host is attempted even when one delete rejects. Without the per-host guard the first
    // Vault or keychain error skipped every remaining host, and the gate's `safeRevokeCredentials`
    // then swallowed it -- so a single transient failure could leave later bearer tokens in the
    // Vault under a toolId that never registers, which is the exact leak this callback exists to
    // close. The last error is re-thrown AFTER the loop so the gate stays the single place that
    // decides to ignore a cleanup failure.
    revokeCredentials: async (toolId, hosts) => {
      let lastError: unknown;
      for (const host of hosts) {
        try {
          await deleteToolCredential(vault, toolId, host); // NOSONAR S9382: macOS Vault deletes update `.keyindex.json` by unlocked read-modify-write, so concurrent deletes lose index entries; the per-host catch already attempts every host
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError !== undefined) throw lastError;
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
  // Task 10's persistence surface. Shares `db` and `toolgenRegistry` with `toolgenGateDeps` above
  // (a saved tool a session just created must be visible to a same-process `toolgen.save` call
  // without a second lookup path) but owns its OWN approval broker (`toolgenSaveConsent`, never
  // `toolgenConsent`) -- see `ToolgenRpcCtx.saveConsent`'s docstring for why reusing the create
  // broker here would silently defeat the standing-approval distinction I40 exists to draw.
  const toolgenSaveDeps: ToolgenSaveDeps = {
    db,
    configDir: paths.configDir,
    config: toolGenerationCfg,
    get enforced() {
      return policyGate.enforced();
    },
    registry: toolgenRegistry,
    vault,
    requestApproval: (input, ttlMs) => toolgenSaveConsent.request(input, ttlMs),
    now: () => Date.now(),
  };

  // Task 4's `toolgen.invoke` deps: everything `invokeSavedTool` (`toolgen-invoke-gate.ts`,
  // Tasks 1-3) needs to spawn, call and audit a SAVED tool. The owner's `nimbus tool run` uses them
  // as they are; the model's door (`toolgenModelDoor` below, I60) uses them with a pinned spawn,
  // only after a person approved the call.
  //
  // Resolved once, matching `loadSavedToolsIntoRegistry`'s own read of the same runtime above.
  const runtimeReadPaths = resolveRuntimeById("bun").requiredReadPaths();
  // One spawn path for both callers: `nimbus tool run` (no pin) and the model's door (pinned to the
  // artifact digest the owner approved, I60), so the two can never diverge in what they verify.
  const spawnSaved = async (toolId: string, pin?: ToolgenModelPin) => {
    const pubkeyB64 = await vault.get(TOOLGEN_SIGNING_PUBKEY);
    if (pubkeyB64 === null) {
      throw new ToolgenError(ERR_TOOLGEN_PUBKEY_UNAVAILABLE, "toolgen signing pubkey unavailable");
    }
    const row = getSavedTool(db, toolId);
    if (row === null) {
      throw new ToolgenError(ERR_TOOLGEN_NOT_SAVED, `tool "${toolId}" is not saved`);
    }
    return spawnSavedTool(toolId, {
      configDir: paths.configDir,
      pubkeyB64,
      sessionId: CLI_TOOLGEN_SESSION_ID,
      row: { approvedAt: row.approvedAt },
      runtime: { requiredReadPaths: () => runtimeReadPaths },
      readVerifiedSavedTool:
        pin === undefined
          ? readVerifiedSavedTool
          : pinReadVerified(readVerifiedSavedTool, pin.expectedDigest),
      savedToolDir,
      rewriteSavedToolScript,
      spawn: (envelope) => {
        // A model call re-checks its offer at the last moment before the child starts (I60), after
        // every wait above: a lock-off or an opt-out set meanwhile refuses the spawn.
        if (pin !== undefined && !pin.stillAllowed()) {
          throw new ToolgenError(
            ERR_TOOLGEN_MODEL_ACCESS_WITHDRAWN,
            `model access to "${toolId}" was withdrawn before it started`,
          );
        }
        return spawnGeneratedTool(envelope, toolgenBroker, dirname(envelope.scriptPath));
      },
    });
  };

  const toolgenInvokeDeps: ToolgenInvokeDeps = {
    config: toolGenerationCfg,
    // A GETTER, not a snapshot: org policy is re-resolved per call, so a policy tightened after
    // boot takes effect on the next invocation rather than at the next restart -- the same shape
    // as `toolgenGateDeps`/`toolgenSaveDeps` above.
    get enforced() {
      return policyGate.enforced();
    },
    registry: toolgenRegistry,
    spawn: (toolId) => spawnSaved(toolId),
    audit: (entry) => appendAuditEntry(db, entry),
    // Refusal-path disambiguation only -- see `ToolgenInvokeDeps.disabledReasonFor`. The row is a
    // health-report CACHE (I40), never an authority: it is read here to explain a refusal the
    // registry already decided, and can never make a tool invocable.
    disabledReasonFor: (toolId) => getSavedTool(db, toolId)?.disabledReason ?? null,
    // Asked before spawning, over the exact policy `spawnSavedTool` builds, so an unconfinable
    // sandbox is recorded as a refusal rather than as a run that failed. See the dep's docstring.
    confinementUnavailable: (toolId) =>
      sandboxRunner.canConfine(
        savedToolSpawnPolicy(toolId, savedToolDir(paths.configDir, toolId), runtimeReadPaths),
      ),
    now: () => Date.now(),
  };

  // The model's door to the owner's saved generated tools (S4, I60): every switch, the opt-in list
  // and the policy read live per listing and per call; `invoke` is reached only after a person's
  // approval of the call (`toolgen/toolgen-model-door.ts`), and its spawn is pinned to the artifact
  // digest that approval showed.
  const toolgenModelDoor: ToolgenModelDoorSource = {
    config: () => loadNimbusToolGenerationFromConfigDir(paths.configDir),
    enforced: () => policyGate.enforced(),
    // A governed install whose policy did not verify offers nothing: its `enforced()` is only the baseline.
    policyUnverified: () => policyGate.governanceIntended() && !policyGate.status().signatureValid,
    registry: toolgenRegistry,
    savedDigest: (toolId) => getSavedTool(db, toolId)?.artifactDigest ?? null,
    invoke: (toolId, input, pin) =>
      invokeSavedTool(
        { toolId, input, sessionId: CLI_TOOLGEN_SESSION_ID, approvalAuditId: pin.approvalAuditId },
        { ...toolgenInvokeDeps, spawn: (id) => spawnSaved(id, pin) },
      ),
    warn: (msg) => syncLogger.warn({ capability: "toolgen_model_access" }, msg),
  };

  ipcOpts.toolgenRpcCtx = {
    consent: toolgenConsent,
    gateDeps: toolgenGateDeps,
    saveDeps: toolgenSaveDeps,
    saveConsent: toolgenSaveConsent,
    invokeDeps: toolgenInvokeDeps,
    removeScript: (toolId) => removeToolScript(paths.configDir, toolId),
    // The DURABLE half of `toolgen.revoke`: `saved/<toolId>` -- body, artifact and signature. The
    // matching `generated_tool` row is dropped by the handler itself, which already holds `db`.
    // Without this pair, a revoked SAVED tool came straight back at the next boot and the standing
    // approval the save prompt promised was revocable had no withdrawal path at all.
    removeSavedDir: (toolId) => removeSavedTool(paths.configDir, toolId),
    // Deletes every `toolgen.<toolId>.*` Vault key by prefix -- excluding the signing keypair's own
    // `toolgen.signing.` prefix -- closing the leak where a revoked tool's per-host credential
    // outlived both the tool and the gateway.
    revokeCredentialsForTool: (toolId) => deleteCredentialsForTool(vault, toolId),
  };

  ipcOpts.glossaryRefresher = glossaryRefresher;
  assignIfPresent(ipcOpts, "decisionsRefresher", decisionsRefresher);
  assignIfPresent(ipcOpts, "ownershipRefresher", ownershipRefresher);
  assignIfPresent(ipcOpts, "premortemRefresher", premortemRefresher);

  // `nimbus explain last` (spec §4). ONE recorder for the process's lifetime, shared by every
  // `runAsk` call site `gateway-main.ts` wires it to (via `PlatformServices.askExplainRecorder`
  // below) AND by `ask.explainLast` here, over the shared LAN-forbidden diagnostics IPC route.
  // Constructed here — before `createIpcServer(ipcOpts)` — so the same instance reaches both
  // consumers; constructing it after the IPC server exists would leave `ask.explainLast` reading
  // an instance nothing else ever writes to.
  const askExplainRecorder = new AskExplainRecorder();
  ipcOpts.askExplainRecorder = askExplainRecorder;
  // Fleet job drops and the semantic check reach `diag.snapshot`/`config.explain` as closures, so
  // `ipc/` never imports `fleet/`. The getter reads the supervisor's CURRENT drops on each call.
  ipcOpts.fleetDroppedJobs = () => fleetRuntime.dropped;
  ipcOpts.fleetJobCheck = checkFleetJob;

  if (bootPolicy.envSidecars) {
    collectSidecarsFromEnv(db, paths, sidecarStops, httpSidecarOpts);
  }

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

  // I39 (S2 runtime tool generation): the tool-registration approval prompt reaches the local
  // owner via the same broadcast channel; they answer through toolgen.approvalRespond.
  // UNCONDITIONAL for the same reason as share/exec above.
  toolgenConsent.setBroadcast((method, params) => ipc.broadcast(method, asBroadcastParams(params)));

  // I40 (S2 toolgen persistence): the SEPARATE tool-SAVE approval prompt reaches the local owner
  // via the same broadcast channel; they answer through toolgen.saveApprovalRespond. Without this
  // binding `toolgenSaveConsent.request(...)` broadcasts to nobody and every `toolgen.save` call
  // times out and is denied -- identical failure mode to the missing bindings share/exec/toolgen
  // above already call out, on a SEPARATE broker instance from `toolgenConsent` immediately above.
  toolgenSaveConsent.setBroadcast((method, params) =>
    ipc.broadcast(method, asBroadcastParams(params)),
  );

  // I35 (S2 slice 2): the computer-use approval prompts (session-open envelope + per-action) reach
  // the local owner via the same broadcast channel; they answer through computer.approvalRespond.
  // UNCONDITIONAL for the same reason as share/exec above.
  // OR-MCU-2: UNICAST to the asking connection only, never a broadcast.
  cuEnvelopeConsent.setUnicast((clientId, method, params) =>
    ipc.notify(clientId, method, asBroadcastParams(params)),
  );
  cuActionConsent.setUnicast((clientId, method, params) =>
    ipc.notify(clientId, method, asBroadcastParams(params)),
  );

  bindFederationBroadcasts(ipc, federationBooted);
  // Bind the live broadcast so identity.loginProgress/Done/Error reach subscribers (see identity-boot.ts).
  identityBoot?.bindLoginNotify((method, payload) => ipc.broadcast(method, payload));
  // Same seam, same reason: the emitters are constructed during assemble, which runs before
  // `createIpcServer(...)` exists. Until this line runs, every operational emit is dropped
  // harmlessly — which is also what makes unit tests that never bind safe.
  setGatewayEventBroadcast((method, params) => ipc.broadcast(method, params));

  bindChatopsLocalConsent(ipc, chatopsBoot, syncLogger);

  if (bootPolicy.updaterStartupCheck) {
    wireUpdaterIntoIpc(paths.configDir, ipc, syncLogger, db);
  }

  const gatewayAssemblyMs = Math.max(0, Math.round(performance.now() - assemblyStartedMs));
  if (bootPolicy.telemetryFlush) {
    const telemetryStop = startTelemetryFlushScheduler({
      dataDir: paths.dataDir,
      configDir: paths.configDir,
      getDatabase: () => db,
      gatewayVersion: GATEWAY_VERSION,
      logger: syncLogger,
      coldStartMs: gatewayAssemblyMs,
      agentLatencyRecorder,
    });
    sidecarStops.push(telemetryStop.stop);
  }

  const services: PlatformServices = {
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
    hostActivity,
    toolgenRegistry,
    toolgenModelDoor,
    computerUseFor,
    llmRegistry,
    connectorWriteDeps,
    embeddingReadiness,
    askExplainRecorder,
    agentLatencyRecorder,
    oncallPush,
    incidentEngine,
    bindIncidentExecutor: (make: MakeExecutor): void => {
      incidentExecutorFactory = make;
    },
    bindIacDriftRunner: (runner: IacDriftRunner): void => {
      iacDriftRunner = runner;
    },
    briefing,
    policyHitl,
    // A GETTER, not `policyGate.enforced()` evaluated here: a signed policy applied after boot
    // (`policyGate.applyVerified`) must reach the user-MCP model tool source (I42's
    // `user_mcp_model_access` lock-off) on the next turn, not the next restart.
    enforcedPolicy: () => policyGate.enforced(),
    tribalKbConfig: () => tribalKbConfigOf(tribalCfg, tribalUnreadable),
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
  // The members only some installs have — OMITTED when absent, never set to `undefined`
  // (`exactOptionalPropertyTypes`).
  assignIfPresent(services, "agentVendor", agentVendor);
  assignIfPresent(services, "sessionMemoryStore", sessionMemoryStore);
  assignIfPresent(services, "executorDelegation", federationBooted);
  assignIfPresent(services, "chatops", chatopsBoot);
  return services;
}
