#!/usr/bin/env bun
/**
 * nimbus-sandbox-wrapper — invoked by `lazy-mesh/` ServerSpec entries so
 * every MCP connector child is spawned through `sandboxRunner.spawn`
 * (invariant `I15`, T2 PR 1).
 *
 * Architectural background: `@mastra/mcp`'s `MCPClient` builds each MCP
 * server from a `{ command, args, env }` triple and calls its internal
 * `StdioClientTransport.spawn(command, args, { env })` — there is no public
 * hook to intercept the spawn. To route every MCP child through the
 * sandbox we rewrite each `ServerSpec` so MCPClient launches THIS script
 * (under `process.execPath`), and this script in turn calls
 * `sandboxRunner.spawn(originalCmd, originalArgs, opts)` and stitches the
 * sandboxed child's stdio onto our own stdio (which is MCPClient's MCP
 * JSON-RPC transport).
 *
 * Invocation (built by `wrap-server-spec.ts`):
 *   <process.execPath> <this-script> <originalCmd> [...originalArgs]
 *
 * Required env (set by `wrapServerSpec` — consumed and stripped here so the
 * sandboxed child does not see them, which prevents a double-wrap if the
 * connector ever re-execs the same env block):
 *   NIMBUS_SANDBOX_MANIFEST_JSON — JSON-stringified ExtensionManifest
 *   NIMBUS_SANDBOX_CWD — working directory for the sandboxed child
 *
 * stdio:
 *   `stdio: "inherit"` so MCP JSON-RPC frames pass through transparently:
 *   MCPClient ↔ wrapper.stdin/stdout/stderr ↔ sandboxed connector.
 *
 * Exit-code propagation follows shell convention:
 *   - normal exit → propagate child's exit code
 *   - signal-killed → exit `128 + signal_number`
 */
import { constants as osConstants } from "node:os";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { createSandboxRunner } from "./sandbox-runner.ts";

function fatal(msg: string): never {
  process.stderr.write(`nimbus-sandbox-wrapper: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<never> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    fatal("usage: bun sandbox-wrapper.ts <cmd> [...args]");
  }
  const originalCmd = args[0];
  if (originalCmd === undefined) {
    fatal("missing original command");
  }
  const originalArgs = args.slice(1);

  const manifestJson = process.env["NIMBUS_SANDBOX_MANIFEST_JSON"];
  if (manifestJson === undefined || manifestJson === "") {
    fatal("NIMBUS_SANDBOX_MANIFEST_JSON not set");
  }
  const cwd = process.env["NIMBUS_SANDBOX_CWD"];
  if (cwd === undefined || cwd === "") {
    fatal("NIMBUS_SANDBOX_CWD not set");
  }

  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(manifestJson) as ExtensionManifest;
  } catch (e) {
    fatal(`invalid NIMBUS_SANDBOX_MANIFEST_JSON: ${(e as Error).message}`);
  }

  // Strip the two sandbox-control env vars from the child's env so a
  // connector that re-execs (or spawns a helper that walks process.env)
  // never re-enters this wrapper. The inner env (extensionProcessEnv
  // result) is everything else in process.env at this point — the
  // wrapper script itself runs as a child of the Gateway with the env
  // assembled by `wrapServerSpec`.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NIMBUS_SANDBOX_MANIFEST_JSON" || k === "NIMBUS_SANDBOX_CWD") continue;
    if (v !== undefined) childEnv[k] = v;
  }

  const runner = await createSandboxRunner();
  const child = runner.spawn(originalCmd, originalArgs, {
    manifest,
    env: childEnv,
    cwd,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal !== null) {
      // Map signal name → signal number via os.constants.signals, then
      // exit 128 + number per shell convention. If the signal is not in
      // the constants table (rare), default to 1.
      const signals = osConstants.signals as Record<string, number | undefined>;
      const num = signals[signal] ?? 0;
      process.exit(128 + num);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => fatal(`child spawn failed: ${err.message}`));

  // Keep the wrapper alive until the child's exit handler calls process.exit.
  return new Promise<never>(() => {});
}

void main();
