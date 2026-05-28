// packages/cli/src/commands/repl-core.ts
//
// Dependency-injected REPL logic. This file is the testable twin of the thin
// `repl.ts` wrapper (same split as `gw-state-helpers.ts` ↔ `gateway-process.ts`).
//
// Why the split exists: the colocated test must run alongside the shared CLI
// mock harness (`cli-mocks.ts`), which installs process-global `mock.module`
// registrations for `ipc-client/index.ts`, `lib/gateway-process.ts` and
// `@clack/prompts`. Any module that STATICALLY imports one of those mocked
// modules lands in Bun's mock-resolution blast radius; under some CI
// file-collection orderings (observed on macOS) that corrupted the importer's
// own export surface, so `import { … } from "./repl.ts"` failed at link time
// (`SyntaxError: Export named 'loadReplPreconditions' not found`) and a
// top-level `await import("./repl.ts")` resolved to an empty namespace
// (every export `undefined`).
//
// `repl-core.ts` therefore imports NONE of the mocked modules as values — only
// Node builtins + type-only references — and takes its real dependencies via a
// `ReplCoreDeps` object. The test imports this file directly and injects fakes,
// so it never needs `cli-mocks.ts`; the module-under-test has a clean graph and
// a stable export surface on every platform. `repl.ts` supplies the production
// deps and is the (coverage-exempt) wiring shim.
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";

/** Minimal shape of the recorded gateway state `loadReplPreconditions` reads. */
export interface ReplGatewayState {
  readonly socketPath: string;
  readonly pid?: number;
}

/**
 * The real dependencies `repl.ts` wires in. Injected (never statically
 * imported here) so this module stays out of the cli-mocks blast radius.
 */
export interface ReplCoreDeps {
  readonly readGatewayState: (paths: CliPlatformPaths) => Promise<ReplGatewayState | undefined>;
  readonly getCliPlatformPaths: () => CliPlatformPaths;
  readonly makeClient: (socketPath: string) => IPCClient;
  readonly registerHandlers: (client: IPCClient) => void;
}

/**
 * Returns the parsed `--session <id>` flag if present. Defaults the
 * `sessionId` field to `undefined` when the flag is absent or has no value,
 * which the dispatcher then propagates verbatim into IPC calls.
 */
export function parseReplArgs(args: string[]): { sessionId: string | undefined } {
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session" && args[i + 1] !== undefined) {
      sessionId = args[i + 1];
      i += 1;
    }
  }
  return { sessionId };
}

/**
 * Runs ONE REPL turn: calls `agent.invoke` (printing the reply via `write`
 * when non-empty), and — when `sessionId` is set — appends the user message +
 * assistant reply to the session memory. Returns the agent's reply string.
 */
export async function runReplTurn(
  client: IPCClient,
  q: string,
  sessionId: string | undefined,
  write: (s: string) => void,
): Promise<string> {
  const invokeParams: Record<string, unknown> = {
    input: q,
    stream: true,
  };
  if (sessionId !== undefined) {
    invokeParams["sessionId"] = sessionId;
  }
  const result = await client.call<{ reply: string }>("agent.invoke", invokeParams);
  if (typeof result.reply === "string" && result.reply.length > 0) {
    write(`\n${result.reply}\n`);
  }
  if (sessionId !== undefined) {
    await client.call("session.append", {
      sessionId,
      chunkText: q,
      role: "user",
    });
    if (typeof result.reply === "string" && result.reply.trim() !== "") {
      await client.call("session.append", {
        sessionId,
        chunkText: result.reply.slice(0, 8000),
        role: "assistant",
      });
    }
  }
  return typeof result.reply === "string" ? result.reply : "";
}

/**
 * Performs only the parse + gateway-running check, so tests can verify the
 * "Gateway is not running" branch without driving the readline event loop.
 */
export async function loadReplPreconditions(
  args: string[],
  deps: ReplCoreDeps,
): Promise<{ socketPath: string; sessionId: string | undefined }> {
  const { sessionId } = parseReplArgs(args);
  const paths = deps.getCliPlatformPaths();
  const state = await deps.readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  return { socketPath: state.socketPath, sessionId };
}

/**
 * The full REPL dispatcher: gate on `readGatewayState`, connect a client,
 * register interactive handlers, then drive the readline loop until the user
 * types `exit`/`quit`/blank. `makeInterface` is a seam for tests (defaults to
 * the real `createInterface`); all other dependencies arrive via `deps`.
 */
export async function runRepl(
  args: string[],
  deps: ReplCoreDeps,
  makeInterface: typeof createInterface = createInterface,
): Promise<void> {
  const { socketPath, sessionId } = await loadReplPreconditions(args, deps);

  const client = deps.makeClient(socketPath);
  await client.connect();
  deps.registerHandlers(client);

  const rl = makeInterface({ input, output, terminal: true });
  try {
    output.write("Nimbus REPL — type a message, or exit / quit to leave.\n");
    for (;;) {
      const line = await rl.question("nimbus> ");
      const q = line.trim();
      if (q === "" || q === "exit" || q === "quit") {
        break;
      }
      await runReplTurn(client, q, sessionId, (s) => output.write(s));
    }
  } finally {
    rl.close();
    await client.disconnect();
  }
}
