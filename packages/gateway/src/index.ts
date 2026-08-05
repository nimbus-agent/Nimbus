#!/usr/bin/env bun
import { ROLE_SENTINELS } from "./platform/runtime-layout.ts";

/**
 * The gateway executable has three roles, selected by argv[2]. A compiled binary ships alone — no
 * bun on PATH, no source tree beside it — so the only program it can spawn is itself.
 *
 * This file stays THIN on purpose. Each role is reached through a dynamic import so that a
 * connector role never evaluates the gateway module graph, which builds loggers and freezes config
 * at import time. `entry-graph.test.ts` enforces that.
 */
const sentinel = process.argv[2];
const roleArgs = process.argv.slice(3);

function failRole(message: string): never {
  process.stderr.write(`nimbus-gateway: ${message}\n`);
  process.exit(2);
}

if (sentinel === ROLE_SENTINELS.sandbox) {
  const { runSandboxWrapper } = await import("./platform/sandbox/sandbox-wrapper.ts");
  await runSandboxWrapper(roleArgs);
} else if (sentinel === ROLE_SENTINELS.connector) {
  const { runBundledConnector } = await import("./connectors/run-bundled-connector.ts");
  try {
    await runBundledConnector(roleArgs[0]);
  } catch (err: unknown) {
    failRole(err instanceof Error ? err.message : String(err));
  }
} else {
  const { main } = await import("./gateway-main.ts");
  try {
    await main();
  } catch (err: unknown) {
    const { emergencyGatewayLog } = await import("./platform/gateway-log-file.ts");
    emergencyGatewayLog(err);
    console.error("[gateway] fatal:", err);
    process.exit(1);
  }
}
