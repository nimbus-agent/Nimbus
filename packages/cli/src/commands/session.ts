import { IPCClient } from "../ipc-client/index.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export async function runSession(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error(gatewayNotRunningMessage(paths.demo === true));
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();

  try {
    if (sub === "list" || sub === "") {
      const out = await client.call<{ sessions: unknown }>("session.list", {});
      console.log(JSON.stringify(out, undefined, 2));
      return;
    }
    if (sub === "clear") {
      const sid = args[1]?.trim();
      const out = await client.call(
        "session.clear",
        sid === undefined || sid === "" ? {} : { sessionId: sid },
      );
      console.log(JSON.stringify(out, undefined, 2));
      return;
    }
    if (sub === "recall") {
      const sessionId = args[1]?.trim() ?? "";
      const query = args.slice(2).join(" ").trim();
      if (sessionId === "" || query === "") {
        throw new Error("Usage: nimbus session recall <sessionId> <query>");
      }
      const out = await client.call("session.recall", { sessionId, query, topK: 8 });
      console.log(JSON.stringify(out, undefined, 2));
      return;
    }
    throw new Error(
      "Usage: nimbus session list | nimbus session clear [sessionId] | nimbus session recall <sessionId> <query>",
    );
  } finally {
    await client.disconnect();
  }
}
