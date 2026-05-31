import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";

export interface ReplGatewayState {
  readonly socketPath: string;
  readonly pid?: number;
}

export interface ReplCoreDeps {
  readonly readGatewayState: (paths: CliPlatformPaths) => Promise<ReplGatewayState | undefined>;
  readonly getCliPlatformPaths: () => CliPlatformPaths;
  readonly makeClient: (socketPath: string) => IPCClient;
  readonly registerHandlers: (client: IPCClient) => void;
}

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
