import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * Test entry point — invoked by the dispatcher `runRepl(args)` and the
 * colocated `repl.test.ts`. Do not call from other command files.
 *
 * Returns the parsed `--session <id>` flag if present. Defaults the
 * `sessionId` field to `undefined` when the flag is absent or has no
 * value, which the dispatcher then propagates verbatim into IPC calls.
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
 * Test entry point — invoked by the dispatcher `runRepl(args)` REPL loop and
 * the colocated `repl.test.ts`. Do not call from other command files.
 *
 * Runs ONE REPL turn: calls `agent.invoke` (printing the reply via
 * `output.write` when non-empty), and — when `sessionId` is set —
 * appends the user message + assistant reply to the session memory.
 *
 * Returns the agent's reply string so callers can chain.
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

export async function runRepl(args: string[]): Promise<void> {
  const { sessionId } = parseReplArgs(args);
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();
  registerInteractiveCliIpcHandlers(client);

  const rl = createInterface({ input, output, terminal: true });
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
