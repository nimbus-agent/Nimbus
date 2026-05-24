import { spinner } from "@clack/prompts";

import { ensureGatewayDirs, isProcessAlive, readGatewayState } from "../lib/gateway-process.ts";
import { spawnGateway } from "../lib/spawn-gateway.ts";
import { getCliPlatformPaths } from "../paths.ts";

export function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  return args[i + 1];
}

export type ServeArgs = { kind: "help" } | { kind: "serve"; port: number };

/**
 * Pure parser for `nimbus serve` argv. Extracted for unit testing without
 * touching the actual gateway spawn.
 *
 * Resolution order: --port flag > NIMBUS_HTTP_PORT env > default 7474.
 */
export function parseServeArgs(args: string[], envHttpPort?: string): ServeArgs {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  const portRaw = takeFlag(args, "--port") ?? envHttpPort?.trim() ?? "7474";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }
  return { kind: "serve", port };
}

/**
 * Starts the Gateway with `NIMBUS_HTTP_PORT` so the read-only HTTP sidecar is enabled.
 */
export async function runServe(args: string[]): Promise<void> {
  const parsed = parseServeArgs(args, process.env["NIMBUS_HTTP_PORT"]);
  if (parsed.kind === "help") {
    console.log(`nimbus serve — start Gateway with local read-only HTTP API

Usage:
  nimbus serve [--port 7474]

The HTTP server binds 127.0.0.1 only. Set a different port with --port or NIMBUS_HTTP_PORT before start.
`);
    return;
  }
  const port = parsed.port;

  const paths = getCliPlatformPaths();
  await ensureGatewayDirs(paths);

  const existing = await readGatewayState(paths);
  if (existing !== undefined && isProcessAlive(existing.pid)) {
    throw new Error(
      "Gateway is already running. Stop it first (nimbus stop), or set NIMBUS_HTTP_PORT and start again.",
    );
  }

  const s = spinner();
  s.start("Starting Gateway with HTTP sidecar");
  try {
    const { pid, logPath } = await spawnGateway(paths, {
      extraEnv: { NIMBUS_HTTP_PORT: String(port) },
    });
    s.stop(`Gateway started (pid ${String(pid)})`);
    console.log(`HTTP:   http://127.0.0.1:${String(port)}/v1/items`);
    console.log(`Socket: ${paths.socketPath}`);
    console.log(`Log:    ${logPath}`);
  } catch (e) {
    s.stop("Could not start Gateway");
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exitCode = 1;
  }
}
