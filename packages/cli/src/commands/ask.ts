import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";

function parseAskArgs(args: string[]): { rest: string[]; sessionId?: string; agent?: string } {
  const rest: string[] = [];
  let sessionId: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session" && args[i + 1] !== undefined) {
      sessionId = args[i + 1];
      i += 1;
      continue;
    }
    if (a === "--agent" && args[i + 1] !== undefined) {
      agent = args[i + 1];
      i += 1;
      continue;
    }
    if (a !== undefined) {
      rest.push(a);
    }
  }
  const out: { rest: string[]; sessionId?: string; agent?: string } = { rest };
  if (sessionId !== undefined) {
    out.sessionId = sessionId;
  }
  if (agent !== undefined) {
    out.agent = agent;
  }
  return out;
}

export async function runAsk(args: string[]): Promise<void> {
  const { rest, sessionId, agent } = parseAskArgs(args);
  const query = rest.join(" ").trim();
  if (query.length === 0) {
    throw new Error('Usage: nimbus ask [--session <uuid>] "<natural language query>"');
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();
  registerInteractiveCliIpcHandlers(client);

  try {
    const connectors = await client.call<Array<{ serviceId?: string }>>("connector.listStatus", {});
    if (!Array.isArray(connectors) || connectors.length === 0) {
      process.stdout.write(
        [
          "No connectors are registered in the local index yet.",
          "",
          "Authenticate at least one connector, then sync:",
          "  nimbus connector auth github",
          "  nimbus connector auth google",
          "  nimbus connector list",
          "  nimbus connector sync <service>",
          "",
          "Until a connector is registered, searches and agent answers have no cloud data to draw on.",
          "",
        ].join("\n"),
      );
      return;
    }

    const invokeParams: Record<string, unknown> = {
      input: query,
      stream: true,
    };
    if (sessionId !== undefined) {
      invokeParams["sessionId"] = sessionId;
    }
    if (agent !== undefined) {
      invokeParams["agent"] = agent;
    }
    const result = await client.call<{ reply: string }>("agent.invoke", invokeParams);
    if (
      invokeParams["stream"] !== true &&
      typeof result.reply === "string" &&
      result.reply.length > 0
    ) {
      process.stdout.write(`\n${result.reply}\n`);
    }
    if (sessionId !== undefined) {
      await client.call("session.append", {
        sessionId,
        chunkText: query,
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
  } finally {
    await client.disconnect();
  }
}
