import type { Agent } from "@mastra/core/agent";
import pino from "pino";

import { runWorkflowExecution } from "./automation/workflow-runner.ts";
import { createConnectorWriteDispatcher } from "./connectors/connector-write-dispatch.ts";
import { createConnectorDispatcher, type McpToolListingClient } from "./connectors/index.ts";
import type { EmbeddingReadiness } from "./embedding/embedding-readiness.ts";
import { createNimbusEngineAgent } from "./engine/agent.ts";
import { runAsk } from "./engine/run-ask.ts";
import { emergencyGatewayLog } from "./platform/gateway-log-file.ts";
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

async function main(): Promise<void> {
  process.stdout.write("[gateway] initializing platform services\n");
  const platform = await createPlatformServices();
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
  const engine = createNimbusEngineAgent({
    localIndex: platform.localIndex,
    auditDb: platform.localIndex.getDatabase(),
    ...(platform.sessionMemoryStore === undefined
      ? {}
      : { sessionMemoryStore: platform.sessionMemoryStore }),
  });

  function resolveEngineAgent(name: string | undefined): Agent {
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
      conversationalAgent: resolveEngineAgent(ctx.agent),
      llmRouter: platform.llmRegistry.llmRouter,
      ...(platform.sessionMemoryStore === undefined
        ? {}
        : { sessionMemoryStore: platform.sessionMemoryStore }),
      ...(platform.executorDelegation === undefined
        ? {}
        : { delegation: platform.executorDelegation }),
    }),
  );

  // ChatOps read path (Slice 5): `@nimbus <question>` answers run through the same runAsk
  // pipeline as engine.ask (I11 envelope, HITL gate on any planned action). Per-namespace
  // content filtering of local reads remains the slice's documented deferral.
  platform.chatops?.bindAskEngine(async (query, _namespace) => {
    const r = await runAsk({
      input: query,
      stream: false,
      clientId: "chatops",
      paths: platform.paths,
      consentCoordinator: platform.ipc.consent,
      localIndex: platform.localIndex,
      dispatcher,
      sendChunk: () => {},
      conversationalAgent: engine.agentsByName.nimbus,
      llmRouter: platform.llmRegistry.llmRouter,
      ...(platform.sessionMemoryStore === undefined
        ? {}
        : { sessionMemoryStore: platform.sessionMemoryStore }),
    });
    return r.reply;
  });

  platform.ipc.setWorkflowRunHandler(async (ctx) =>
    runWorkflowExecution({
      db: platform.localIndex.getDatabase(),
      agent: resolveEngineAgent(ctx.agent),
      workflowName: ctx.workflowName,
      triggeredBy: ctx.triggeredBy,
      dryRun: ctx.dryRun,
      stream: ctx.stream,
      sendChunk: ctx.sendChunk,
      ...(ctx.paramsOverride !== undefined && { paramsOverride: ctx.paramsOverride }),
    }),
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[gateway] ${signal} — shutting down\n`);
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

try {
  await main();
} catch (err: unknown) {
  emergencyGatewayLog(err);
  console.error("[gateway] fatal:", err);
  process.exit(1);
}
