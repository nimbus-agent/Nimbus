import { IPCClient } from "../ipc-client/index.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  awaitAgentBrief,
  briefTextFor,
  type PendingBrief,
  renderAgentBrief,
} from "./agent-brief-render.ts";
import { CliExit } from "./cli-exit.ts";
import { disconnectQuietly } from "./disconnect-quietly.ts";
import { gatewayNotRunningMessage } from "./gateway-not-running.ts";
import { readGatewayState } from "./gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "./interactive-ipc-handlers.ts";

/** A brief as the gateway delivered it: the rendered Markdown plus the structured findings. */
export type AgentBriefResult<B> = { brief: string; findings: B };

/** Everything one `agents.*` round trip needs from the command asking for it. */
type AgentBriefRequest<B> = {
  /** Names the `<agentName>.briefReady` / `<agentName>.briefError` notifications awaited. */
  agentName: string;
  ipcMethod: string;
  callParams: Record<string, unknown>;
  /** Runtime guard validating the `findings` payload of `<agentName>.briefReady`. */
  guard: (x: unknown) => x is B;
};

/**
 * The opening every agent-brief command shares: read the gateway state and build — not connect —
 * an IPC client for it. With no gateway running, prints the not-running message (the demo
 * gateway's, under `--demo`) and exits 1 before any connection is attempted. `demo` is
 * `CliPlatformPaths.demo === true`: the flag `renderAgentBrief` takes, and `briefTextFor` as
 * `{ demo }`.
 */
export async function agentBriefClientOrExit(): Promise<{ client: IPCClient; demo: boolean }> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write(`${gatewayNotRunningMessage(paths.demo === true)}\n`);
    throw new CliExit(1);
  }
  return { client: new IPCClient(state.socketPath), demo: paths.demo === true };
}

/**
 * The one agent-brief round trip: read the gateway state (exit 1 if not running), connect the IPC
 * client, start awaiting the agent's brief (guarded by `guard`), invoke `ipcMethod` with
 * `callParams`, bind the returned sessionId to the waiter so the router can tell this call's brief
 * apart from a concurrent one, then hand the brief to `consume`. `consume` runs INSIDE the
 * connection, so whatever it prints is written before the disconnect. On error: stderr + exit 2.
 * Always cancels the pending waiter + disconnects in `finally`.
 */
async function withAgentBrief<B, R>(
  req: AgentBriefRequest<B>,
  consume: (result: AgentBriefResult<B>, demo: boolean) => R,
): Promise<R> {
  const { client, demo } = await agentBriefClientOrExit();
  let pending: PendingBrief<B> | undefined;

  try {
    // Connect + handler registration live inside the boundary so a stale
    // socket or setup failure still hits the stderr + exit(2) path and the
    // finally disconnect, rather than escaping uncaught.
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, req.agentName, req.guard);
    // Watch the result FROM CREATION, as `runAgentBriefCli` does (F30). Nothing else is attached to
    // it until the `await` below, so a rejection that settles while the `agents.*` call is still in
    // flight — the brief timer firing first (a low NIMBUS_BRIEF_TIMEOUT_MS against a slow reply),
    // or a sessionless `briefError` the router attributes to this sole waiter — was an unhandled
    // rejection: Bun printed a stack trace and the process exited 1, not the 2 promised here.
    // `changelog` still exited 2 only because its old `process.exit(2)` overrode that code — the
    // stack trace printed all the same.
    //
    // The no-op catch silences the RUNTIME, not the error: the rejection still reaches the `await`
    // below, and the catch there still prints it and throws CliExit(2).
    pending.result.catch(() => {});
    const { sessionId } = await client.call<{ sessionId: string }>(req.ipcMethod, req.callParams);
    pending.bindSession(sessionId);
    return consume(await pending.result, demo);
  } catch (err) {
    // A CliExit raised inside the try (renderAgentBrief's empty-index hint) already wrote its own
    // message and carries its own code. Re-labelling it here would print a stray "exit 1" and turn
    // exit 1 into exit 2 — which is what the stubbed-exit tests pinned by accident for months.
    if (err instanceof CliExit) throw err;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    throw new CliExit(2);
  } finally {
    pending?.cancel();
    await disconnectQuietly(client);
  }
}

/**
 * Run an agent CLI command over {@link withAgentBrief}, then render the brief with
 * `renderAgentBrief` (`--json` findings, the empty-index hint + exit 1, or the Markdown). The
 * per-command code supplies only the agent name, IPC method, call params, brief guard, and the
 * `--json` flag — this collapses the byte-identical dispatcher body shared by the agent commands
 * (catchup, impact, …).
 */
export function runAgentCli<B extends { gaps: readonly { category: string }[] }>(opts: {
  agentName: string;
  ipcMethod: string;
  callParams: Record<string, unknown>;
  guard: (x: unknown) => x is B;
  json: boolean;
}): Promise<void> {
  return withAgentBrief(opts, ({ brief, findings }, demo) => {
    renderAgentBrief(brief, findings, opts.json, demo);
  });
}

/**
 * The same round trip for a command that renders the brief ITSELF: `changelog`, `standup` and
 * `oncall` pick a `--format` transform (or `--json`) over the result, which `renderAgentBrief`
 * cannot. Calls `agents.<agentName>` with `callParams` verbatim and resolves to the raw
 * `{ brief, findings }` — demo-safe commands in the Markdown only (`briefTextFor`); `findings`, the
 * `--json` output, is untouched. Same exit codes as {@link runAgentCli}: `CliExit(1)` when no
 * gateway is running, `CliExit(2)` after printing the error for any later failure, a failed
 * connect included.
 */
export function fetchAgentBrief<B>(
  agentName: string,
  callParams: Record<string, unknown>,
  guard: (x: unknown) => x is B,
): Promise<AgentBriefResult<B>> {
  return withAgentBrief(
    { agentName, ipcMethod: `agents.${agentName}`, callParams, guard },
    (result, demo) => ({ ...result, brief: briefTextFor(result.brief, { demo }) }),
  );
}
