import type { Agent } from "@mastra/core/agent";
import pino from "pino";
import { runWorkflowExecution } from "./automation/workflow-runner.ts";
import { WorkflowScheduler } from "./automation/workflow-scheduler.ts";
import { loadNimbusIacDriftFromConfigDir } from "./config/iac-drift-toml.ts";
import { loadServiceConfigsOrEmpty } from "./config/service-configs.ts";
import { createConnectorWriteDispatcher } from "./connectors/connector-write-dispatch.ts";
import { getIacGrants } from "./connectors/connector-writes/iac-grants.ts";
import { createModelWriteToolSource } from "./connectors/connector-writes/model-write-source.ts";
import { previewCredentialResolver } from "./connectors/connector-writes/preview-credential.ts";
import {
  createConnectorDispatcher,
  type McpToolListingClient,
  meshDispatcherClient,
} from "./connectors/index.ts";
import { listPolicyGatedModelAccessibleOwnerCodeServerIds } from "./connectors/user-mcp-model-capability.ts";
import { userMcpWriteGrantsReader } from "./connectors/user-mcp-write-reader.ts";
import { makeEgressSink } from "./egress/egress-ledger.ts";
import type { EmbeddingReadiness } from "./embedding/embedding-readiness.ts";
import { createNimbusEngineAgent } from "./engine/agent.ts";
import { agentRequestContext } from "./engine/agent-request-context.ts";
import { personalizationDeps } from "./engine/personalization.ts";
import {
  buildIacAcceptExecutor,
  buildIacDriftExecutor,
  buildRemediationExecutor,
  buildUnattendedWorkflowWriteExecutor,
  buildWorkflowWriteExecutor,
  type RunAskParams,
  runAsk,
} from "./engine/run-ask.ts";
import { createIacDriftRunner } from "./iac-drift/drift-runner.ts";
import { IacDriftScheduler } from "./iac-drift/drift-scheduler.ts";
import { humanOnlyConsent } from "./ipc/consent.ts";
import { armGatewayLifecycleDiagnostics } from "./platform/exit-diagnostics.ts";
import { removeGatewayStateFile, writeGatewayStateFile } from "./platform/gateway-state-file.ts";
import { createPlatformServices } from "./platform/index.ts";
import { showIgnoringFailure } from "./platform/notifications/notifications-runtime.ts";
import type { SandboxRunner } from "./platform/sandbox/sandbox-runner.ts";
import { buildLearningConfig } from "./standing/learning-config.ts";
import { sweepToolgenCredentials } from "./toolgen/toolgen-credential-sweep.ts";
import { removeAllToolScripts } from "./toolgen/toolgen-script-store.ts";
import { GATEWAY_VERSION } from "./version.ts";

function emitSandboxPostureBannerIfDegraded(runner: SandboxRunner): void {
  if (runner.isFullyActive()) return;
  const reason = runner.degradedReason() ?? "unknown";
  const logger = pino({ name: "sandbox-startup" });
  logger.warn(
    {
      platform: runner.platform,
      reason,
      affected: "extensions declaring permissions.network",
      docs: "docs/sandbox.md#platform-asymmetry",
    },
    runner.networkRefused?.() === true
      ? "sandbox: a child that declares network will be refused"
      : "sandbox: degraded posture — per-host network filtering is not enforced",
  );
  if (process.stderr.isTTY === true) {
    process.stderr.write(
      `\n` +
        `! Nimbus sandbox is in DEGRADED mode (${runner.platform}):\n` +
        `    ${reason}\n` +
        `    See: docs/sandbox.md#platform-asymmetry\n` +
        `\n`,
    );
  }
}

/**
 * The ChatOps read path (Slice 5): `@nimbus <question>` answers run through the same `runAsk`
 * pipeline as `agent.invoke` (I11 envelope, HITL gate on any planned action). Unlike the three
 * `ipc/server/inline-handlers.ts` `runAsk`/handler callers (`dispatchAgentInvoke`,
 * `dispatchWorkflowRunRpc`, `dispatchEngineAskStream`), nothing upstream of this binding
 * establishes an `agentRequestContext` request store — ChatOps is not an IPC dispatch, it is a
 * callback the `chatops` module invokes directly. Without a store here,
 * a negation tool's refusal/exclusion disclosure has nowhere to land and is dropped (see
 * `engine/negation-disclosure.ts`'s `store === undefined` branch): this wrapper is that store.
 *
 * `runAskFn` is injected (defaults to the real `runAsk`) so the wiring — does a disclosure
 * recorded during the call reach the returned reply — is unit-testable without a real Gateway.
 */
export function createChatOpsAskEngine(
  buildParams: (query: string) => RunAskParams,
  runAskFn: (params: RunAskParams) => Promise<{ reply: string }> = runAsk,
): (query: string, namespace: string) => Promise<string> {
  // No outer `async`: `AsyncLocalStorage.run` returns the callback's own promise, so the async
  // callback below is already the whole result — wrapping it again only added a second promise.
  return (query, _namespace) =>
    agentRequestContext.run({}, async () => {
      const r = await runAskFn(buildParams(query));
      return r.reply;
    });
}

/**
 * S2 runtime tool generation (I39) shutdown drain — extracted to a standalone export so it is
 * unit-testable independent of `main()`'s process.exit/signal-handler machinery, the same reason
 * `createChatOpsAskEngine` above is not inlined either.
 *
 * THREE parts matter, in order: `revokeAllToolgenRegistrations` clears the in-memory registry
 * (closing every live generated-tool child process); `removeAllToolScripts` clears the on-disk
 * ephemeral script store under the config dir; `sweepToolgenCredentials` (Task 5) deletes every
 * per-host generated-tool Vault credential still live at shutdown, retaining only the signing
 * keypair. A drain that runs only the first two LOOKS identical to success from memory and disk
 * alone — the Vault half is what a revoked-but-never-cleaned-up credential, or a tool that was
 * simply still live when the process exited, would otherwise leave behind indefinitely in the OS
 * keychain.
 *
 * **All THREE are attempted even when an earlier one rejects**, and the first failure is re-thrown
 * only once the credential sweep has had its turn. A plain sequential `await` chain made the
 * WEAKEST step decide the fate of the strongest: a `removeAllToolScripts` rejection — a locked
 * `toolgen/ephemeral/<toolId>/index.ts` on Windows is the realistic trigger — skipped the Vault
 * sweep, and the caller in `main()` swallows the rejection and exits, so generated-tool
 * credentials stayed in the OS keychain until some later boot's sweep happened to succeed. The
 * three drops are independent (memory, disk, keychain); nothing about one failing makes the next
 * one wrong to attempt, and the keychain is the half whose residue outlives the process.
 *
 * Re-thrown, never swallowed: this function stays honest about failing and `main()`'s own
 * try/catch is the single place that decides a shutdown drain is best-effort — one place, so the
 * decision to ignore a cleanup failure cannot be made twice and drift.
 */
export async function drainToolgenOnShutdown(deps: {
  readonly revokeAllToolgenRegistrations: () => Promise<void>;
  readonly removeAllToolScripts: (configDir: string) => Promise<void>;
  readonly sweepToolgenCredentials: () => Promise<number>;
  readonly configDir: string;
}): Promise<void> {
  let firstError: unknown;
  let failed = false;
  const attempt = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (err) {
      if (!failed) {
        failed = true;
        firstError = err;
      }
    }
  };

  await attempt(() => deps.revokeAllToolgenRegistrations());
  await attempt(() => deps.removeAllToolScripts(deps.configDir));
  await attempt(() => deps.sweepToolgenCredentials());

  if (failed) throw firstError;
}

export async function main(): Promise<void> {
  // FIRST statement in main(), before any assembly work: from here on, every in-process exit —
  // drain, process.exit(), uncaught error — leaves a record in the daily log. A death that leaves
  // NO record was terminated from outside, which is itself the diagnosis. The scheduler does not
  // exist yet, so the heartbeat's activity provider is resolved lazily through this box.
  let syncActivity: (() => readonly string[]) | undefined;
  let heartbeatExtras: (() => Readonly<Record<string, unknown>>) | undefined;
  const lifecycle = armGatewayLifecycleDiagnostics(
    GATEWAY_VERSION,
    () => syncActivity?.() ?? [],
    () => heartbeatExtras?.() ?? {},
  );

  process.stdout.write("[gateway] initializing platform services\n");
  const platform = await createPlatformServices();
  syncActivity = (): readonly string[] =>
    platform.syncScheduler
      .getStatus()
      .filter((s) => s.status === "syncing")
      .map((s) => s.serviceId);
  heartbeatExtras = (): Readonly<Record<string, unknown>> => ({
    embeddings: platform.embeddingReadiness().state,
  });
  process.stdout.write("[gateway] platform services ready; wiring engine\n");
  const mcp = platform.connectorMesh;
  const dispatcherClient: McpToolListingClient = meshDispatcherClient(mcp);
  const dispatcher = createConnectorWriteDispatcher(
    createConnectorDispatcher(dispatcherClient),
    platform.connectorWriteDeps,
  );
  // I29: runAsk is the agent-action path (nimbus ask / agent.invoke / the ChatOps read path below)
  // — the most dispatch-capable path in the product. RunAskParams.egressSink is a REQUIRED dep, so
  // it is wired here once and handed to every runAsk call rather than left to an internal fallback.
  const askEgressSink = makeEgressSink(platform.localIndex.getDatabase());
  const userMcpLogger = pino({ name: "user-mcp-agent-tools" });
  const connectorWriteLogger = pino({ name: "connector-write-agent-tools" });
  const oncallNowLogger = pino({ name: "oncall-now-tool" });
  // NO ENABLED VENDOR MEANS NO REMOTE INFERENCE ANYWHERE, including the default `nimbus ask`.
  // The agent is not merely refused, it is NOT CONSTRUCTED: `@mastra/core` resolves a vendor key
  // from the ENVIRONMENT on its own the moment an agent exists, so a constructed-but-refusing
  // agent would leave a hole exactly the size of the per-vendor opt-in. `runTurn` and
  // `runViaAgent` already branch on `p.agent === undefined` on every path, so this removes a
  // failure mode rather than adding one.
  const engine =
    platform.agentVendor === undefined
      ? undefined
      : createNimbusEngineAgent({
          localIndex: platform.localIndex,
          auditDb: platform.localIndex.getDatabase(),
          egressDb: platform.localIndex.getDatabase(),
          vendor: platform.agentVendor,
          // `oncall_now` resolves a service through `[ci.service.*]`, read per call, degrading to none.
          personalization: personalizationDeps(platform.paths.configDir),
          oncallServiceConfigs: () =>
            loadServiceConfigsOrEmpty(platform.paths.configDir, (m) =>
              oncallNowLogger.warn({ tool: "oncall_now" }, m),
            ),
          ...(platform.sessionMemoryStore === undefined
            ? {}
            : { sessionMemoryStore: platform.sessionMemoryStore }),
          // The production-supplied agent tool family that runs owner code: user MCP servers
          // registered with `--model`, and extensions approved with `--model` (enabled, approved
          // for the code now installed, not signature-disabled). Offered only on a turn whose
          // request context carries the user-MCP executor (the local owner); every call runs
          // through that executor's I42 owner prompt, and every result through `wrapToolForLlm`
          // (I11).
          // The org-policy lock-off (`[policy.capabilities.ai_v2] user_mcp_model_access = false`)
          // is enforced HERE, at the source, for both halves: locked off — or no policy accessor
          // (fail-closed) — nothing is listed, so the model is offered nothing on any path. Read per
          // call, so a policy applied after boot takes effect on the next turn.
          // I60: the owner's saved generated tools, each listed in `[tool_generation] model_tools`,
          // offered only on a turn whose request context carries the owner-only approval (the
          // local owner's non-demo `cli`/`ui` turn); every call asks a person over its input first.
          // Never on a demo-rooted gateway (I41), whatever the request context holds.
          ...(platform.paths.demo === true ? {} : { toolgen: platform.toolgenModelDoor }),
          userMcp: {
            listModelAccessibleIds: () =>
              listPolicyGatedModelAccessibleOwnerCodeServerIds(
                platform.localIndex.getDatabase(),
                platform.enforcedPolicy?.(),
              ),
            // `ext_*` lists through the extension slot (spawn re-verifies), anything else as a
            // user MCP server.
            listTools: (serviceId) => platform.connectorMesh.listOwnerCodeServerTools(serviceId),
            warn: (bindings, msg) => userMcpLogger.warn(bindings, msg),
          },
          // The model's connector-write door (Phase 9.7, D1): offered only on a turn whose request
          // context carries the delegation-free connector-write executor (the local owner's
          // non-demo `cli`/`ui` turn). Enablement, policy (fail-closed) and offerability are read
          // live, at listing and again on every call; only enabled services are listed (D2).
          connectorWrites: createModelWriteToolSource({
            db: platform.localIndex.getDatabase(),
            enforcedPolicy: platform.enforcedPolicy,
            listServerTools: (service) => platform.connectorMesh.listFirstPartyServerTools(service),
            // Per-slot, not the global epoch: unrelated slot activity must not refuse a listed tool.
            toolsEpoch: (service) => platform.connectorMesh.toolsGenerationFor(service),
            warn: (bindings, msg) => connectorWriteLogger.warn(bindings, msg),
            // F4: the knowledge base the model may never write to (the tribal capture gate's).
            getTribalKbConfig: () => platform.tribalKbConfig(),
          }),
        });

  function resolveEngineAgent(name: string | undefined): Agent | undefined {
    if (engine === undefined) {
      return undefined;
    }
    const key = name?.toLowerCase().trim();
    if (key === "devops") {
      return engine.agentsByName.devops;
    }
    if (key === "research") {
      return engine.agentsByName.research;
    }
    return engine.agentsByName.nimbus;
  }

  platform.ipc.setAgentInvokeHandler((ctx) =>
    runAsk({
      ...ctx,
      paths: platform.paths,
      consentCoordinator: platform.ipc.consent,
      localIndex: platform.localIndex,
      dispatcher,
      egressSink: askEgressSink,
      explainRecorder: platform.askExplainRecorder,
      agentLatencyRecorder: platform.agentLatencyRecorder,
      // Spread-conditional: `conversationalAgent` is OPTIONAL and `run-ask` already handles its
      // absence, but under `exactOptionalPropertyTypes` an explicit `undefined` is a different
      // type from an absent key.
      ...(() => {
        const a = resolveEngineAgent(ctx.agent);
        return a === undefined ? {} : { conversationalAgent: a };
      })(),
      llmRouter: platform.llmRegistry.llmRouter,
      ...(platform.sessionMemoryStore === undefined
        ? {}
        : { sessionMemoryStore: platform.sessionMemoryStore }),
      ...(platform.executorDelegation === undefined
        ? {}
        : { delegation: platform.executorDelegation }),
      // I22: agent-planned actions are the path an org's `[policy.hitl] require` list most
      // needs to reach, so the overlay rides along with the delegation dep.
      policyHitl: platform.policyHitl,
      previewCredentialFor: previewCredentialResolver(
        platform.connectorWriteDeps,
        platform.connectorMesh,
      ),
      userMcpWriteGrants: userMcpWriteGrantsReader(() => platform.localIndex.getDatabase()),
      // I42 (user-MCP model access): decided at the IPC entry from the live session's kind
      // (`USER_MCP_OFFER_BY_KIND`); only a literal `true` offers.
      offerUserMcpTools: ctx.offerUserMcpTools === true,
      // The connector-write door: decided at the IPC entry (`CONNECTOR_WRITE_OFFER_BY_KIND`,
      // `cli`/`ui` only); `runAsk` also refuses it on a demo-rooted gateway.
      offerConnectorWriteTools: ctx.offerConnectorWriteTools === true,
      // I35 (OR-MCU-1): a `cli` turn that named an open session may drive it; resolved by the
      // platform so the binding's approvals go to this connection alone (OR-MCU-2).
      offerComputerUse: ctx.offerComputerUse === true,
      ...(ctx.computerSessionId === undefined ? {} : { computerSessionId: ctx.computerSessionId }),
      computerUseFor: platform.computerUseFor,
      // B3 (R11): the door's KB-child guards read the same live accessor as the model-write source.
      getTribalKbConfig: () => platform.tribalKbConfig(),
    }),
  );

  // ChatOps read path (Slice 5): `@nimbus <question>` runs through the same runAsk pipeline as engine.ask
  // (I11 envelope, HITL gate). It is the only runAsk caller not already inside `agentRequestContext.run`
  // (see `createChatOpsAskEngine` above; the other three are in `ipc/server/inline-handlers.ts`), so the
  // wrapper is applied here explicitly.
  platform.chatops?.bindAskEngine(
    createChatOpsAskEngine((query) => ({
      input: query,
      stream: false,
      clientId: "chatops",
      paths: platform.paths,
      consentCoordinator: platform.ipc.consent,
      localIndex: platform.localIndex,
      dispatcher,
      egressSink: askEgressSink,
      explainRecorder: platform.askExplainRecorder,
      agentLatencyRecorder: platform.agentLatencyRecorder,
      sendChunk: () => {},
      ...(() => {
        const a = resolveEngineAgent(undefined);
        return a === undefined ? {} : { conversationalAgent: a };
      })(),
      llmRouter: platform.llmRegistry.llmRouter,
      ...(platform.sessionMemoryStore === undefined
        ? {}
        : { sessionMemoryStore: platform.sessionMemoryStore }),
      policyHitl: platform.policyHitl,
      previewCredentialFor: previewCredentialResolver(
        platform.connectorWriteDeps,
        platform.connectorMesh,
      ),
      userMcpWriteGrants: userMcpWriteGrantsReader(() => platform.localIndex.getDatabase()),
      // I42: a ChatOps mention is never the local owner's turn, so owner-registered user-MCP
      // tools are never offered here. Literal, not looked up: this call's clientId "chatops" is
      // not a registered ClientKind and would read as `unknown` (the plain CLI, an OWNER kind)
      // — which is why the decision is never a kind lookup inside runAsk.
      offerUserMcpTools: false,
      // Never on a ChatOps turn: a shared room is not the local owner.
      offerConnectorWriteTools: false,
      // Never on a ChatOps turn: a shared room is not the local owner.
      offerComputerUse: false,
      // Inert here (no model writes on ChatOps), but required so no construction site forgets it.
      getTribalKbConfig: () => platform.tribalKbConfig(),
    })),
  );

  // ChatOps agent-intent path (Task 9): `@nimbus agent <name> k=v ...` runs a built-in agent through
  // `dispatchAgentsRpc` and posts the brief via `posts.agentBrief` (I29 `chatops` class). It is bound
  // inside `assemblePlatformServices` (`bootChatopsAgentInvoker`), where the federation identity is
  // readable, so nothing is left to do here.

  const learningLogger = pino({ name: "standing-learning" });
  platform.ipc.setWorkflowRunHandler(async (ctx) => {
    // A `run` step genuinely REQUIRES an agent — unlike `runAsk`, it has no deterministic path
    // to fall back to. With no `[llm.remote.*]` vendor enabled there is no agent: the runner then
    // refuses a workflow that has a `run` step with a message that names the fix (a workflow of
    // query and write steps needs no model, SA2).
    const workflowAgent = resolveEngineAgent(ctx.agent);
    return runWorkflowExecution({
      db: platform.localIndex.getDatabase(),
      ...(workflowAgent === undefined ? {} : { agent: workflowAgent }),
      // SA2: a write step asks the owner on the run's own client, through an executor with no
      // delegation and the before-state runner; built per run so consent is bound to this client.
      ...(platform.paths.demo === true
        ? {}
        : {
            writeExecutor: buildWorkflowWriteExecutor({
              clientId: ctx.clientId,
              consentCoordinator: platform.ipc.consent,
              localIndex: platform.localIndex,
              dispatcher,
              egressSink: askEgressSink,
              policyHitl: platform.policyHitl,
              previewCredentialFor: previewCredentialResolver(
                platform.connectorWriteDeps,
                platform.connectorMesh,
              ),
              getTribalKbConfig: () => platform.tribalKbConfig(),
              // I55: the live org policy decides whether a standing rule may fire (absent = off).
              enforcedPolicy: platform.enforcedPolicy,
            }),
          }),
      // Derived by the IPC dispatcher from the connection's declared kind (never from params).
      ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
      // SA4: set only by `workflow.resume`, after the dispatcher validated the blocked run.
      ...(ctx.resume === undefined ? {} : { resume: ctx.resume }),
      // SA5: approval learning reads this run's audit rows after each write step. Off on a demo
      // gateway, under the org lockoff, or when policy cannot be read; never changes a run.
      learning: buildLearningConfig({
        demo: platform.paths.demo === true,
        configDir: platform.paths.configDir,
        enforcedPolicy: platform.enforcedPolicy,
        log: (fields, message) => learningLogger.info(fields, message),
      }),
      workflowName: ctx.workflowName,
      triggeredBy: ctx.triggeredBy,
      dryRun: ctx.dryRun,
      stream: ctx.stream,
      sendChunk: ctx.sendChunk,
      ...(ctx.paramsOverride !== undefined && { paramsOverride: ctx.paramsOverride }),
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
    });
  });

  // Phase 10 IC5a (I57 (b)): the incident engine runs a stored remediation proposal, or undoes one, through the
  // local owner's executor on the asking CLI connection: no delegation, no standing rules, and a consent channel
  // that takes a human answer only (`--yes`, a script and an old client become a decline). Built per call, so the
  // capture observer is that call's own. A demo-rooted gateway never binds it (I41): remediate and undo refuse.
  if (platform.paths.demo !== true) {
    platform.bindIncidentExecutor(({ clientId, onCaptured, onNonHuman, dryRun }) =>
      buildRemediationExecutor({
        clientId,
        consentCoordinator: humanOnlyConsent(platform.ipc.consent, onNonHuman),
        localIndex: platform.localIndex,
        dispatcher,
        egressSink: askEgressSink,
        policyHitl: platform.policyHitl,
        previewCredentialFor: previewCredentialResolver(
          platform.connectorWriteDeps,
          platform.connectorMesh,
        ),
        getTribalKbConfig: () => platform.tribalKbConfig(),
        onCaptured,
        dryRun: dryRun === true,
      }),
    );
  }

  // Phase 10 IaC drift (OR-DRIFT-1, OR-DRIFT-2): the read-only Terraform drift check (`iac.driftCheck`, and opt-in
  // the `[iac.drift] schedule`) on `buildIacDriftExecutor` (static D42(h)), which asks nobody and never applies.
  // OR-S4-ACCEPT-DRIFT: `iac.acceptDrift` runs the accept-drift row on `buildIacAcceptExecutor` (static D42(k)),
  // human-only consent on the asking connection. A demo-rooted gateway builds none of it (I41).
  const iacDriftScheduler =
    platform.paths.demo === true
      ? undefined
      : (() => {
          const runner = createIacDriftRunner({
            makeExecutor: () =>
              buildIacDriftExecutor({
                localIndex: platform.localIndex,
                dispatcher,
                egressSink: askEgressSink,
                policyHitl: platform.policyHitl,
              }),
            makeAcceptExecutor: ({ clientId, onNonHuman }) =>
              buildIacAcceptExecutor({
                clientId,
                consentCoordinator: humanOnlyConsent(platform.ipc.consent, onNonHuman),
                localIndex: platform.localIndex,
                dispatcher,
                egressSink: askEgressSink,
                policyHitl: platform.policyHitl,
              }),
            approvedWorkdirs: () => getIacGrants(platform.localIndex.getDatabase()).workdirs,
            dataDir: platform.paths.dataDir,
            now: Date.now,
            notify: (title, body) => showIgnoringFailure(platform.notifications, title, body),
            notifyEnabled: () => loadNimbusIacDriftFromConfigDir(platform.paths.configDir).notify,
          });
          platform.bindIacDriftRunner(runner);
          return new IacDriftScheduler({
            runner,
            config: () => loadNimbusIacDriftFromConfigDir(platform.paths.configDir),
            now: Date.now,
            onError: (err) =>
              process.stderr.write(
                `[gateway] scheduled IaC drift check failed: ${err instanceof Error ? err.message : String(err)}
`,
              ),
          });
        })();

  // SA4: scheduled workflows. A demo-rooted gateway never schedules (I41). The scheduler is handed a
  // FACTORY for an unattended write executor and a notifier; it holds no client and no consent
  // coordinator, so nothing it runs can ask a person anything (static D44(d)).
  const workflowScheduler =
    platform.paths.demo === true
      ? undefined
      : new WorkflowScheduler({
          db: platform.localIndex.getDatabase(),
          now: Date.now,
          makeExecutor: () =>
            buildUnattendedWorkflowWriteExecutor({
              localIndex: platform.localIndex,
              dispatcher,
              egressSink: askEgressSink,
              policyHitl: platform.policyHitl,
              previewCredentialFor: previewCredentialResolver(
                platform.connectorWriteDeps,
                platform.connectorMesh,
              ),
              getTribalKbConfig: () => platform.tribalKbConfig(),
              enforcedPolicy: platform.enforcedPolicy,
            }),
          notify: (title, body) => showIgnoringFailure(platform.notifications, title, body),
          costConfigDir: platform.paths.configDir,
          onError: (workflow, err) =>
            process.stderr.write(
              `[gateway] scheduled workflow ${workflow} failed: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
        });

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[gateway] ${signal} — shutting down\n`);
    lifecycle.stop();
    // Start BOTH retirements before awaiting either: each clears its own timer synchronously, so a
    // briefing still draining cannot leave the workflow interval ticking (and vice versa). The briefing
    // drain is bounded (`BRIEFING_RETIRE_DRAIN_MS`).
    const briefingRetired = platform.briefing.scheduler?.retire().catch(() => {});
    const workflowsRetired = workflowScheduler?.retire().catch(() => {});
    // IaC drift D2: started with the two above (its timer clears synchronously), awaited after them.
    const driftRetired = iacDriftScheduler?.retire().catch(() => {});
    await Promise.all([briefingRetired, workflowsRetired]);
    await driftRetired;
    try {
      platform.disposeSidecars?.();
    } catch {
      /* ignore */
    }
    try {
      await platform.syncScheduler.stop();
    } catch {
      /* ignore */
    }
    try {
      await drainToolgenOnShutdown({
        revokeAllToolgenRegistrations: () => platform.toolgenRegistry.revokeAll(),
        removeAllToolScripts,
        sweepToolgenCredentials: () => sweepToolgenCredentials(platform.vault),
        configDir: platform.paths.configDir,
      });
    } catch {
      /* ignore */
    }
    try {
      await platform.ipc.stop();
    } finally {
      try {
        await mcp.disconnect();
      } catch {
        /* ignore */
      }
      try {
        platform.localIndex.close();
      } catch {
        /* ignore */
      }
      removeGatewayStateFile(platform.paths);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  emitSandboxPostureBannerIfDegraded(platform.sandboxRunner);

  process.stdout.write("[gateway] binding IPC\n");
  await platform.ipc.start();
  // The index is ready and the socket is serving: scheduled workflows may now fire (one catch-up of
  // a miss within the last hour, then every minute's tick).
  workflowScheduler?.start();
  // IaC drift D2: off unless `[iac.drift] schedule` is set (re-read every tick); `undefined` on the demo root (I41).
  iacDriftScheduler?.start();
  // The morning briefing and the deadline notices (Phase 10 MB5); `undefined` on the demo root (I41).
  platform.briefing.scheduler?.start();
  writeGatewayStateFile(platform.paths, {
    pid: process.pid,
    socketPath: platform.paths.socketPath,
  });
  process.stdout.write(`[gateway] ready (${GATEWAY_VERSION}) IPC ${platform.paths.socketPath}\n`);
  // #928: the socket is bound and serving BEFORE the embedding model is loaded. Log the state
  // it was in at bind time — the previous boot log ended at "starting embedding runtime" with
  // no further output, which made a cold-model fetch indistinguishable from a hang.
  logEmbeddingStateAtBind(platform.embeddingReadiness());
}

/**
 * The clause that follows the state name: a reassurance while the model is still warming,
 * otherwise the reason the state is what it is (when there is one).
 */
function embeddingBindDetail(readiness: EmbeddingReadiness): string {
  if (readiness.state === "warming") {
    return " — semantic search activates when it finishes; everything else is available now";
  }
  return readiness.reason === null ? "" : ` (${readiness.reason})`;
}

/** One line, at bind time, naming the embedding state the gateway started serving in. */
function logEmbeddingStateAtBind(readiness: EmbeddingReadiness): void {
  process.stdout.write(
    `[gateway] embeddings: ${readiness.state}${embeddingBindDetail(readiness)}\n`,
  );
}
