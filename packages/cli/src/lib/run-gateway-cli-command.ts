import { IPCClient } from "../ipc-client/index.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { readGatewayState } from "./gateway-process.ts";

/** The lifecycle surface this runner needs — satisfied by `IPCClient`. */
export interface GatewayCliClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * The three effects the runner performs that a test cannot let happen for real:
 * reading the on-disk gateway state, opening a socket, and terminating the
 * process. Injected rather than imported so the lifecycle is exercised directly
 * instead of through a process-global `mock.module`, which leaks across files in
 * a combined `bun test packages/cli/src` run.
 */
export interface GatewayCliIo<C extends GatewayCliClient> {
  readonly readState: () => Promise<{ socketPath: string } | undefined>;
  readonly makeClient: (socketPath: string) => C;
  /** Writes `message` to stderr and terminates; never returns. */
  readonly fail: (message: string) => never;
}

export const GATEWAY_NOT_RUNNING_MESSAGE = "Gateway is not running. Start with: nimbus start";

export const REAL_GATEWAY_CLI_IO: GatewayCliIo<IPCClient> = {
  readState: async () => readGatewayState(getCliPlatformPaths()),
  makeClient: (socketPath) => new IPCClient(socketPath),
  fail: (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
};

export interface GatewayCliCommandSpec<Cmd, C extends GatewayCliClient> {
  /** Throws on bad argv; the thrown message is what the user sees. */
  readonly parse: (argv: string[]) => Cmd;
  readonly dispatch: (client: C, cmd: Cmd) => Promise<void>;
  readonly io: GatewayCliIo<C>;
}

/**
 * parse argv → require a running gateway → connect → dispatch → always disconnect.
 *
 * `nimbus chatops`, `identity`, `policy` and `tribal` each carried a
 * byte-identical copy of this, differing only in which parser and dispatcher it
 * named. None of the four copies was reachable from a test, so the shared error
 * text and the disconnect-in-`finally` were unverified in all of them.
 *
 * Deliberately NOT folded into `withGatewayIpc`: that helper throws
 * `GatewayNotRunningError` and unconditionally registers a HITL consent handler,
 * which these four commands do not do. Migrating them is a behaviour change, not
 * a de-duplication, so it is left as its own decision.
 */
export async function runGatewayCliCommand<Cmd, C extends GatewayCliClient>(
  argv: string[],
  spec: GatewayCliCommandSpec<Cmd, C>,
): Promise<void> {
  let cmd: Cmd;
  try {
    cmd = spec.parse(argv);
  } catch (e) {
    return spec.io.fail(e instanceof Error ? e.message : String(e));
  }
  const state = await spec.io.readState();
  if (state === undefined) {
    return spec.io.fail(GATEWAY_NOT_RUNNING_MESSAGE);
  }
  const client = spec.io.makeClient(state.socketPath);
  await client.connect();
  try {
    await spec.dispatch(client, cmd);
  } finally {
    // A disconnect failure must not mask the dispatch result — the command has
    // already done its work and reported it by the time this runs.
    await client.disconnect().catch(() => {});
  }
}
