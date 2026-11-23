import { createWatcherChatNotifier } from "../../automation/watcher-chat-notifier.ts";
import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
  type WatcherNotice,
} from "../../automation/watcher-engine.ts";
import { loadNimbusAnomalyFromConfigDir } from "../../config/anomaly-toml.ts";
import { loadNimbusBriefingFromConfigDir } from "../../config/briefing-toml.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../../config/filesystem-toml.ts";
import { loadNimbusFinopsFromConfigDir } from "../../config/finops-toml.ts";
import { loadNimbusIncidentScribeFromConfigDir } from "../../config/incident-scribe-toml.ts";
import { loadNimbusIncidentFromConfigDir } from "../../config/incident-toml.ts";
import {
  loadNimbusAutomationFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  loadNimbusOwnershipFromConfigDir,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPremortemFromConfigDir,
} from "../../config/nimbus-toml.ts";
import { loadNimbusWorkdayFromConfigDir } from "../../config/nimbus-toml-workday.ts";
import { loadServiceConfigsOrEmpty } from "../../config/service-configs.ts";
import {
  loadNimbusWatcherChatopsFromConfigDir,
  watcherChatopsDestination,
} from "../../config/watcher-chatops-toml.ts";
import { isObsidianWriteGrantApproved } from "../../connectors/connector-writes/enablement-store.ts";
import { getIacGrants } from "../../connectors/connector-writes/iac-grants.ts";
import { getK8sGrants } from "../../connectors/connector-writes/k8s-grants.ts";
import {
  createLazyConnectorMesh,
  userMcpProtectedRootsFor,
} from "../../connectors/lazy-mesh/index.ts";
import { listUserMcpConnectors } from "../../connectors/user-mcp-store.ts";
import { rebuildDecisions, runDecisionPass } from "../../decisions/decision-extract.ts";
import { createDecisionRefresher } from "../../decisions/decision-refresh.ts";
import { recordSyncEgress } from "../../egress/sync-egress.ts";
import { resolveRuntimeById } from "../../exec/exec-runtimes.ts";
import { createExtensionSlotSource } from "../../extensions/extension-runtime.ts";
import { buildExtensionRunGrantEnv } from "../../extensions/run-grant-env.ts";
import { rebuildGlossary, runGlossaryPass } from "../../glossary/glossary-extract.ts";
import { createGlossaryRefresher } from "../../glossary/glossary-refresh.ts";
import { createIncidentEngine } from "../../incident/incident-engine.ts";
import { readSyncTelemetrySeed, recordSyncScore } from "../../incident/sync-anomaly-findings.ts";
import { createIncidentScribe } from "../../incident-update/scribe.ts";
import { gitAwareRootPaths, loadRegisteredRoots } from "../../index/registered-roots-store.ts";
import { emitGatewayEvent, type WatcherFiredPayload } from "../../ipc/gateway-events.ts";
import { assembleOncallPushRuntime } from "../../oncall-push/push-runtime.ts";
import { runOwnershipPass } from "../../ownership/ownership-pass.ts";
import { createOwnershipRefresher } from "../../ownership/ownership-refresh.ts";
import { runPremortemPass } from "../../premortem/premortem-pass.ts";
import { createPremortemRefresher } from "../../premortem/premortem-refresh.ts";
import { sourceMappingFor } from "../../sources/source-mapping.ts";
import { configuredForgeHosts } from "../../sync/fetch-host-boundary.ts";
import { SyncScheduler } from "../../sync/scheduler.ts";
import { createSyncAnomalyDetector, SYNC_WINDOW } from "../../watcher/anomaly-notifier.ts";
import { registerConnectorMeshSyncables } from "../assemble-sync-registrations.ts";
import { bootPolicyFor } from "../demo-boot.ts";
import { showIgnoringFailure } from "../notifications/notifications-runtime.ts";
import { registerUserMcpSyncablesFromDatabase } from "../register-user-mcp-sync.ts";
import { loadServiceConfigsOrDegrade } from "./boot-misc.ts";
import { registerFilesystemRootSyncables } from "./index-boot.ts";
import type { SchedulerWithMesh, SchedulerWithMeshOpts } from "./scheduler-mesh-opts.ts";

export async function createSchedulerWithMesh(
  opts: SchedulerWithMeshOpts,
): Promise<SchedulerWithMesh> {
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
    filesystemSpawnGate,
    extensionRuntimeEnabled,
    extensionSpawnGate,
    continuityTable,
    extensionObservationDir,
  } = opts;
  // I41 clause (6), spec § 11.2: a demo gateway's scheduler exists (IPC and the post-sync
  // refreshers are built alongside it) but can never run a job.
  const syncEnabled = bootPolicyFor(paths).syncScheduler;
  const anomalyConfig = loadNimbusAnomalyFromConfigDir(paths.configDir);
  const syncAnomaly = createSyncAnomalyDetector({
    config: anomalyConfig,
    demo: !syncEnabled,
    notify: (title, body) => showIgnoringFailure(notifications, title, body),
    now: () => Date.now(),
    onFailure: (err) => syncLogger.warn({ err }, "sync anomaly notification failed"),
    logger: (e) => {
      syncLogger.warn(
        { seriesId: e.seriesId, value: e.value, score: e.score, atMs: e.atMs },
        "sync telemetry anomaly (stub — no automated remediation)",
      );
    },
    // Phase 10 IC8: the window is seeded from the persisted telemetry, and each scored sample opens or clears
    // a sync anomaly finding (a record only; the toast above stays `[watcher.anomaly]`'s).
    seed: () => readSyncTelemetrySeed(db, SYNC_WINDOW),
    onScore: (e) => recordSyncScore(db, e, anomalyConfig.minScore),
  });

  // Off by default and never in a demo gateway (I41): then `watcherChat` is undefined and no post
  // path exists. The destination is the config namespace alone (I23); the poster is bound later,
  // by `settleWatcherChatops`, once ChatOps has booted.
  const watcherChatopsCfg = loadNimbusWatcherChatopsFromConfigDir(paths.configDir);
  const watcherChat = createWatcherChatNotifier({
    config: watcherChatopsCfg,
    demo: !syncEnabled,
    onFailure: (err) => syncLogger.warn({ err }, "watcher chatops notice failed"),
    warn: (msg, counts) => syncLogger.warn(counts, msg),
  });
  const watcherDestination =
    watcherChat === undefined ? undefined : watcherChatopsDestination(watcherChatopsCfg);
  const watcherPinnedChannel =
    watcherDestination?.kind === "pinned" ? watcherDestination.channelId : undefined;
  const automation = loadNimbusAutomationFromConfigDir(paths.configDir);
  const watcherOpts = {
    graphConditionsEnabled: automation.graphConditions,
    onNotice: (n: WatcherNotice) => watcherChat?.notify(n),
    // Both `evaluateWatchersAfterSync` and `evaluateWatchersStartupCatchUp` share this object, so
    // wiring it here covers both fire paths — a per-call-site wiring is one place for the second
    // to be forgotten.
    onFired: (p: WatcherFiredPayload) => emitGatewayEvent("watcher.fired", { ...p }),
  };

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
        // Resolved on EVERY run, never at assemble time, exactly as the decisions pass does: a
        // pack install or an owner edit to `[sources]` applies to the next pass without a restart.
        mapping: sourceMappingFor(paths.configDir),
        // Catch-up re-reads it between batches, so a type removed mid-run stops there.
        mappingAt: () => sourceMappingFor(paths.configDir),
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
            // Resolved on EVERY run, never at assemble time: a pack install or an owner edit to
            // `[sources]` applies to the next pass without a restart. Pack install/remove does not
            // itself trigger a pass; the next post-sync pass (or `nimbus decisions --refresh`) mines it.
            mapping: sourceMappingFor(paths.configDir),
            // Catch-up re-reads it between batches, so a type removed mid-run stops there.
            mappingAt: () => sourceMappingFor(paths.configDir),
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
        runPass: async () => {
          // A GitHub Enterprise Server clone only becomes a `repo` entity (and so a forge
          // coordinate `resolve-file` can find) once its host is known; read fresh per pass.
          const extraForgeHosts = await configuredForgeHosts(vault);
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
            extraForgeHosts,
          });
        },
        onError: (err) => {
          syncLogger.warn({ err }, "ownership derivation pass failed");
        },
      })
    : undefined;

  // Incident engine (Phase 10 IC3, I57 (a)): assembles incident records from the local index after a sync.
  // Its deps carry no dispatcher, executor, egress sink or model, so a pass can read and store only.
  // The service configs and `[incident]` are re-read on every use, so an edited nimbus.toml applies.
  // The incident scribe (Phase 10 IC9b, `[incident.scribe]`, default off): queues an update draft (metadata only)
  // for every new record version and shows a counts-only toast. It never posts. Not built on a demo gateway (I41).
  const incidentScribe = paths.demo
    ? undefined
    : createIncidentScribe({
        dataDir: paths.dataDir,
        enabled: () => loadNimbusIncidentScribeFromConfigDir(paths.configDir).enabled,
        now: Date.now,
        emit: (p) => emitGatewayEvent("incident.updateDrafted", { ...p }),
        notify: (title, body) => showIgnoringFailure(notifications, title, body),
        logger: syncLogger,
      });
  const incidentEngine = createIncidentEngine({
    db,
    now: Date.now,
    emit: (p) => {
      emitGatewayEvent("incident.assembled", { ...p });
      incidentScribe?.onAssembled(p);
    },
    loadServiceConfigs: () =>
      new Map(
        loadServiceConfigsOrEmpty(paths.configDir, (m) => syncLogger.warn(m)).map((c) => [
          c.serviceId,
          c,
        ]),
      ),
    readConfig: () => ({
      incident: loadNimbusIncidentFromConfigDir(paths.configDir),
      pagerdutyP1Aliases: loadNimbusPagerdutyFromConfigDir(paths.configDir).severityP1Aliases,
    }),
    // Not spelled like the IPC options line: the I41 wiring pin counts that exact text once.
    demo: Boolean(paths.demo),
    logger: syncLogger,
  });

  const oncallPush = assembleOncallPushRuntime({
    db,
    configDir: paths.configDir,
    // The push pushes the record the engine assembled, assembling a candidate's on demand (Phase 10 IC3).
    records: incidentEngine,
    // Passed WHOLE so the push sinks read `delivers` LIVE at delivery time (the OS service's probe
    // can flip it after boot) and record "skipped" rather than attempting a toast that cannot show.
    notifications,
    logger: syncLogger,
  });

  const syncScheduler = new SyncScheduler(syncContext, undefined, {
    // `show()` REJECTS (unavailable / rate-limited / send failure) and the scheduler fires this as
    // `void this.notify?.(...)`; an unhandled rejection exits the gateway (exit-diagnostics.ts).
    notify: (title, body) => showIgnoringFailure(notifications, title, body),
    onConnectorSyncSuccess: (serviceId, result, durationMs) => {
      // FIRST: the scheduler calls this hook unguarded, so a throw below would skip the push;
      // trigger() never throws (and returns at once for anything but pagerduty). The incident engine
      // goes before the push (Phase 10 IC3): its trigger never rejects, and the push assembles its own
      // candidates on demand, so the order is a courtesy, not a dependency.
      void incidentEngine.trigger(serviceId);
      oncallPush.trigger(serviceId);
      const at = Date.now();
      syncAnomaly.recordSample(`sync:duration_ms:${serviceId}`, durationMs, at);
      syncAnomaly.recordSample(`sync:items_upserted:${serviceId}`, result.itemsUpserted, at);
      // The hook already existed and already carries every field this event needs.
      emitGatewayEvent("sync.completed", {
        serviceId,
        itemsUpserted: result.itemsUpserted,
        itemsDeleted: result.itemsDeleted,
        durationMs,
        ...(result.bytesTransferred === undefined
          ? {}
          : { bytesTransferred: result.bytesTransferred }),
        hasMore: result.hasMore,
      });
      evaluateWatchersAfterSync(
        db,
        serviceId,
        at,
        (t, b) => showIgnoringFailure(notifications, t, b),
        watcherOpts,
      );
      glossaryRefresher.trigger();
      decisionsRefresher?.trigger();
      premortemRefresher?.trigger();
      ownershipRefresher?.trigger();
    },
    // I29/D22(b): the scheduled-sync closure around the `sync` egress class's shared appender —
    // one of FIVE production callers of `recordSyncEgress` (the other four: `sync/targeted-fetch.ts`,
    // wired below in this file; `multimodal/cloud-url-resolver.ts` + `multimodal/cloud-bytes.ts`,
    // which share one closure wired by `multimodal/build-media-pass-deps.ts`; and
    // `ipc/connector-rpc-handlers/auth.ts`'s `verifyBeforeStoreWithScopes`, called directly before
    // the pre-store credential probe) — appending one `sync` row per paginated RUN, before
    // `connector.sync(...)` in `runJob`. Kept synchronous (`recordSyncEgress` returns `undefined`,
    // never a Promise) so a throw here aborts the run before any outbound call, matching the
    // fail-closed contract `sync/scheduler.ts`'s own doc comment states for this seam.
    appendSyncEgress: (row) => recordSyncEgress(db, { ...row, now: Date.now() }),
    ...(syncEnabled ? {} : { syncDisabled: true }),
  });
  const tomlRoots = loadNimbusFilesystemRootsFromConfigDir(paths.configDir);
  const registeredRoots = loadRegisteredRoots(paths.configDir);
  if (syncEnabled) {
    registerFilesystemRootSyncables(
      syncScheduler,
      localIndex,
      paths.configDir,
      tomlRoots,
      registeredRoots,
    );
  }
  // The ONE extension slot source (extension runtime PR 3). Its grant env comes from the SAME
  // builder `extension.approveRun` uses, over the mesh's protected roots computed from the paths
  // alone — so it can be built before the mesh it is handed to, without a setter or a lazy wrapper.
  const extensionSlots = extensionRuntimeEnabled
    ? createExtensionSlotSource({
        db,
        vault,
        env: buildExtensionRunGrantEnv(userMcpProtectedRootsFor(paths), paths.extensionsDir),
        sandboxDir: paths.sandboxDir,
        observationDir: extensionObservationDir,
        runtimeReadPaths: () => resolveRuntimeById("bun").requiredReadPaths(),
        isConnectorAllowed,
        continuityTable,
      })
    : undefined;
  const connectorMesh = await createLazyConnectorMesh(paths, vault, {
    listUserMcpConnectors: () => listUserMcpConnectors(db),
    healthDb: db,
    auditDb: db,
    logger: syncLogger,
    // Obsidian vault semantics are opt-in via [[filesystem.roots]] only — CLI-registered blame
    // roots must not be silently treated as note vaults.
    obsidianVaultPaths: tomlRoots.map((r) => r.path),
    // I15 (B4b): the Obsidian sandbox may write today's daily note of each vault under those roots only while the
    // owner's `connector writes enable obsidian` approval includes the append, read LIVE per spawn.
    obsidianWriteGrantEnabled: () => isObsidianWriteGrantApproved(db),
    // D2: the owner's approved Terraform directories and clouds (V85), read fresh for every child.
    iacGrants: () => getIacGrants(db),
    // D3a: the owner's approved Kubernetes (context, namespace) pairs (V86), read fresh for every child.
    k8sGrants: () => getK8sGrants(db),
    isConnectorAllowed,
    ...(filesystemSpawnGate === undefined ? {} : { filesystemSpawnGate }),
    ...(extensionSlots === undefined ? {} : { extensionSlots, extensionSpawnGate }),
    ...(opts.userMcpCanConfine === undefined ? {} : { userMcpCanConfine: opts.userMcpCanConfine }),
  });
  // Snapshot the GitHub Enterprise Server host now (the constructor reads no Vault key) so the first
  // write preview, which can come before the lazy child first spawns, already names the instance.
  void connectorMesh.primeGithubInstance();
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
  // Read per sync. Bound here, outside the `if` below, because i41-demo-root.test.ts pins how
  // far `syncScheduler.start()` may sit from the guard that wraps it.
  const briefingSnapshotIntervalMinutes = (): number =>
    loadNimbusBriefingFromConfigDir(paths.configDir).snapshotIntervalMinutes;
  const finopsMaxSeries = (): number => loadNimbusFinopsFromConfigDir(paths.configDir).maxSeries;
  if (syncEnabled) {
    registerConnectorMeshSyncables(policyFilteredRegistrar, connectorMesh, {
      pagerdutyMaxPagesPerSync: pagerdutyCfg.maxPagesPerSync,
      workdayConfig: workdayCfg,
      briefingSnapshotIntervalMinutes,
      finopsMaxSeries,
    });
    registerUserMcpSyncablesFromDatabase(db, policyFilteredRegistrar, connectorMesh);
    syncScheduler.start();
  }
  evaluateWatchersStartupCatchUp(
    db,
    Date.now(),
    (t, b) => showIgnoringFailure(notifications, t, b),
    watcherOpts,
  );
  return {
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
  };
}
