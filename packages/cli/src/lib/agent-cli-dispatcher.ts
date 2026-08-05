import { IPCClient } from "../ipc-client/index.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { awaitAgentBrief, type PendingBrief, renderAgentBrief } from "./agent-brief-render.ts";
import { readGatewayState } from "./gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "./interactive-ipc-handlers.ts";

/**
 * Run an agent CLI command: read the gateway state (exit 1 if not running),
 * connect the IPC client, start awaiting the agent's brief (guarded by `guard`),
 * invoke `ipcMethod` with `callParams`, bind the returned sessionId to the
 * waiter so the router can tell this call's brief apart from a concurrent one,
 * then render the brief. On error: stderr + exit 2. Always cancels the pending
 * waiter + disconnects in `finally`. The per-command code supplies only the
 * agent name, IPC method, call params, brief guard, and the `--json` flag —
 * this collapses the byte-identical dispatcher body shared by the agent
 * commands (catchup, impact, …).
 */
export async function runAgentCli<B extends { gaps: readonly { category: string }[] }>(opts: {
  agentName: string;
  ipcMethod: string;
  callParams: Record<string, unknown>;
  guard: (x: unknown) => x is B;
  json: boolean;
}): Promise<void> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  let pending: PendingBrief<B> | undefined;

  try {
    // Connect + handler registration live inside the boundary so a stale
    // socket or setup failure still hits the stderr + exit(2) path and the
    // finally disconnect, rather than escaping uncaught.
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, opts.agentName, opts.guard);
    const { sessionId } = await client.call<{ sessionId: string }>(opts.ipcMethod, opts.callParams);
    pending.bindSession(sessionId);
    const { brief, findings } = await pending.result;
    renderAgentBrief(brief, findings, opts.json);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    pending?.cancel();
    await client.disconnect();
  }
}
