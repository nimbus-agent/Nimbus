import type { Agent } from "@mastra/core/agent";
import pino from "pino";

import { runWorkflowExecution } from "./automation/workflow-runner.ts";
import { createConnectorWriteDispatcher } from "./connectors/connector-write-dispatch.ts";
import { createConnectorDispatcher, type McpToolListingClient } from "./connectors/index.ts";
import { makeEgressSink } from "./egress/egress-ledger.ts";
import type { EmbeddingReadiness } from "./embedding/embedding-readiness.ts";
import { createNimbusEngineAgent } from "./engine/agent.ts";
import { agentRequestContext } from "./engine/agent-request-context.ts";
import { type RunAskParams, runAsk } from "./engine/run-ask.ts";
import { armGatewayLifecycleDiagnostics } from "./platform/exit-diagnostics.ts";
import { removeGatewayStateFile, writeGatewayStateFile } from "./platform/gateway-state-file.ts";
import { createPlatformServices } from "./platform/index.ts";
import type { SandboxRunner } from "./platform/sandbox/sandbox-runner.ts";
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
    "sandbox: degraded posture — per-host network filtering is not enforced",
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
 * `ipc/server/inline-handlers.ts` `runAsk`/handler callers (`:96`, `:215`, `:350`), nothing
 * upstream of this binding establishes an `agentRequestContext` request store — ChatOps is not
 * an IPC dispatch, it is a callback the `chatops` module invokes directly. Without a store here,
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
  return async (query, _namespace) =>
    agentRequestContext.run({}, async () => {
      const r = await runAskFn(buildParams(query));
      return r.reply;
    });
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
  const dispatcherClient: McpToolListingClient = {
    listTools: () => mcp.listToolsForDispatcher(),
    getToolsEpoch: () => mcp.getToolsEpoch(),
  };
  const dispatcher = createConnectorWriteDispatcher(
    createConnectorDispatcher(dispatcherClient),
    platform.connectorWriteDeps,
  );
  // I29: runAsk is the agent-action path (nimbus ask / agent.invoke / the ChatOps read path below)
  // — the most dispatch-capable path in the product. RunAskParams.egressSink is a REQUIRED dep, so
  // it is wired here once and handed to every runAsk call rather than left to an internal fallback.
  const askEgressSink = makeEgressSink(platform.localIndex.getDatabase());
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
          ...(platform.sessionMemoryStore === undefined
            ? {}
            : { sessionMemoryStore: platform.sessionMemoryStore }),
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
    }),
  );

  // ChatOps read path (Slice 5): `@nimbus <question>` answers run through the same runAsk
  // pipeline as engine.ask (I11 envelope, HITL gate on any planned action). Per-namespace
  // content filtering of local reads remains the slice's documented deferral.
  //
  // See `createChatOpsAskEngine` above: this is the only runAsk caller not already inside
  // `agentRequestContext.run` (the other three sites are `ipc/server/inline-handlers.ts` at
  // :96, :215, :350), so the wrapper is applied here explicitly.
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
    })),
  );

  platform.ipc.setWorkflowRunHandler(async (ctx) => {
    // `runWorkflowExecution` genuinely REQUIRES an agent — unlike `runAsk`, it has no
    // deterministic path to fall back to. With no `[llm.remote.*]` vendor enabled there is no
    // agent, so refuse with a message that names the fix rather than dereferencing undefined.
    const workflowAgent = resolveEngineAgent(ctx.agent);
    if (workflowAgent === undefined) {
      throw new Error(
        "Workflows need a model: enable a vendor under [llm.remote.<vendor>] in nimbus.toml " +
          "and store its <vendor>.api_key in the Vault.",
      );
    }
    return runWorkflowExecution({
      db: platform.localIndex.getDatabase(),
      agent: workflowAgent,
      workflowName: ctx.workflowName,
      triggeredBy: ctx.triggeredBy,
      dryRun: ctx.dryRun,
      stream: ctx.stream,
      sendChunk: ctx.sendChunk,
      ...(ctx.paramsOverride !== undefined && { paramsOverride: ctx.paramsOverride }),
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[gateway] ${signal} — shutting down\n`);
    lifecycle.stop();
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
