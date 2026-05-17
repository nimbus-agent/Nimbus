/**
 * Nimbus Gateway — Headless Bun process
 *
 * Startup: PAL → SQLite index → MCP filesystem mesh → IPC (agent.invoke → runAsk).
 * See architecture.md §Nimbus Gateway: Process Lifecycle.
 */

import type { Agent } from "@mastra/core/agent";
import pino from "pino";

import { runWorkflowExecution } from "./automation/workflow-runner.ts";
import { createConnectorDispatcher, type McpToolListingClient } from "./connectors/index.ts";
import { createNimbusEngineAgent } from "./engine/agent.ts";
import { runAsk } from "./engine/run-ask.ts";
import { emergencyGatewayLog } from "./platform/gateway-log-file.ts";
import { removeGatewayStateFile, writeGatewayStateFile } from "./platform/gateway-state-file.ts";
import { createPlatformServices } from "./platform/index.ts";
import type { SandboxRunner } from "./platform/sandbox/sandbox-runner.ts";
import { GATEWAY_VERSION } from "./version.ts";

/**
 * Emit the T2 PR 1 "degraded sandbox" warning to (a) the structured logger
 * (always) and (b) stderr as a multi-line banner (TTY-only — TTY-gated so
 * CI logs and piped consumers are not polluted).
 *
 * Always-emitted log line shape is asserted in
 * `packages/gateway/src/security-invariants.test.ts` and parsed by the
 * release smoke checklist.
 */
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
  // Plain stdout writes (not pino) so the CLI's progress tail surfaces them
  // regardless of NIMBUS_LOG_LEVEL.
  process.stdout.write("[gateway] initializing platform services\n");
  const platform = await createPlatformServices();
  process.stdout.write("[gateway] platform services ready; wiring engine\n");
  const mcp = platform.connectorMesh;
  // S8-F3 / chain C4 — the planner-side dispatcher consumes the BARE tool map
  // (structured results) so ToolExecutor / HITL gate see normal objects.
  // The Mastra-visible mesh.listTools() returns envelope-wrapped strings.
  const dispatcherClient: McpToolListingClient = {
    listTools: () => mcp.listToolsForDispatcher(),
    getToolsEpoch: () => mcp.getToolsEpoch(),
  };
  const dispatcher = createConnectorDispatcher(dispatcherClient);
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
      ...(platform.sessionMemoryStore === undefined
        ? {}
        : { sessionMemoryStore: platform.sessionMemoryStore }),
    }),
  );

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

  // T2 PR 1 (Task 20) — surface the per-platform sandbox posture before
  // accepting IPC connections so operators see the banner alongside the
  // "binding IPC" / "ready" log lines. The structured `logger.warn` line is
  // always emitted on a degraded runner; the stderr multi-line banner is
  // TTY-gated to keep CI logs and piped consumers clean.
  emitSandboxPostureBannerIfDegraded(platform.sandboxRunner);

  process.stdout.write("[gateway] binding IPC\n");
  await platform.ipc.start();
  writeGatewayStateFile(platform.paths, {
    pid: process.pid,
    socketPath: platform.paths.socketPath,
  });
  process.stdout.write(`[gateway] ready (${GATEWAY_VERSION}) IPC ${platform.paths.socketPath}\n`);
}

try {
  await main();
} catch (err: unknown) {
  emergencyGatewayLog(err);
  console.error("[gateway] fatal:", err);
  process.exit(1);
}
