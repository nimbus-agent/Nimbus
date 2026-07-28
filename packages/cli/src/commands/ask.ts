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

/**
 * First line of the gateway's no-LLM message
 * (`NO_LLM_SENTINEL` in gateway/src/engine/gateway-agent-error.ts).
 *
 * Duplicated as a literal because the CLI may not import gateway source, and
 * because the JSON-RPC transport in `@nimbus-dev/client` rejects with a plain
 * Error carrying only the message — the numeric error code never reaches us, so
 * there is nothing else to key on. A gateway-side test pins the constant, so a
 * change there fails before it can silently desync this branch.
 */
const NO_LLM_SENTINEL = "Nimbus needs an LLM for this command.";

function isNoLlmError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NO_LLM_SENTINEL);
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
    let result: { reply: string };
    try {
      result = await client.call<{ reply: string }>("agent.invoke", invokeParams);
    } catch (e) {
      if (!isNoLlmError(e)) {
        throw e;
      }
      // Guidance, not a failure report: print it as-is rather than letting the
      // top-level handler render it as `cli.error` with a stack. `ask` is the
      // one command that genuinely cannot degrade — everything else in Nimbus
      // works with no LLM — so the exit code stays non-zero.
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
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
