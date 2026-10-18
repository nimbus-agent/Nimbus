/** `nimbus registry …` dispatcher. `maintain` is offline; add/list/refresh/remove talk to the gateway. */
import type { IPCClient } from "../ipc-client/index.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { createIpcClient } from "../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  REGISTRY_CLIENT_USAGE,
  type RegistryClientSub,
  registryAddPrecheck,
  registryClientTimeoutMs,
  runRegistryClient,
} from "./registry-client-cmds.ts";
import { runRegistryMaintain } from "./registry-maintain.ts";

/** The router's usage: the gateway-backed client subcommands, then the offline `maintain` line. */
export const REGISTRY_USAGE = `${REGISTRY_CLIENT_USAGE}       nimbus registry maintain init|add|remove ...\n`;

const CLIENT_SUBS: ReadonlySet<string> = new Set(["add", "list", "refresh", "remove"]);

/** The seams the gateway-backed half reaches through: where the gateway is, and how to talk to it. */
export interface RegistryGatewayDeps {
  /** The running gateway's socket (undefined when none is running) and whether the CLI is demo-rooted. */
  readonly locate: () => Promise<{
    readonly socketPath: string | undefined;
    readonly demo: boolean;
  }>;
  readonly createClient: (socketPath: string, requestTimeoutMs: number | undefined) => IPCClient;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

const DEFAULT_GATEWAY_DEPS: RegistryGatewayDeps = {
  locate: async () => {
    const paths = getCliPlatformPaths();
    const state = await readGatewayState(paths);
    return { socketPath: state?.socketPath, demo: paths.demo === true };
  },
  createClient: (socketPath, timeoutMs) => createIpcClient(socketPath, timeoutMs),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

/**
 * Connects to the running gateway, runs one client subcommand and always disconnects. Throws the
 * demo-aware "not running" hint when no gateway is up. Returns the subcommand's exit code.
 */
export async function runRegistryClientOverGateway(
  sub: RegistryClientSub,
  args: string[],
  isTty: boolean,
  gw: RegistryGatewayDeps = DEFAULT_GATEWAY_DEPS,
): Promise<number> {
  const { socketPath, demo } = await gw.locate();
  if (socketPath === undefined) {
    throw new Error(gatewayNotRunningMessage(demo));
  }
  const client = gw.createClient(socketPath, registryClientTimeoutMs(sub));
  await client.connect();
  try {
    return await runRegistryClient(sub, args, {
      client,
      isTty,
      stdout: gw.stdout,
      stderr: gw.stderr,
    });
  } finally {
    await client.disconnect();
  }
}

/**
 * The seams `runRegistry` reaches through, so a test can drive the router without a real
 * `process.exit`. The defaults are the real thing; production callers pass nothing.
 */
export interface RegistryCmdDeps {
  readonly maintain: (args: string[]) => Promise<number>;
  /** Runs a gateway-backed subcommand; the default connects to the running gateway. */
  readonly client: (sub: RegistryClientSub, args: string[], isTty: boolean) => Promise<number>;
  /** Whether both stdin and stdout are a terminal (`add` refuses otherwise). */
  readonly isTty: () => boolean;
  readonly writeErr: (s: string) => void;
  readonly exit: (code: number) => never;
}

const DEFAULT_DEPS: RegistryCmdDeps = {
  maintain: (args) => runRegistryMaintain(args),
  client: (sub, args, isTty) => runRegistryClientOverGateway(sub, args, isTty),
  isTty: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  writeErr: (s) => void process.stderr.write(s),
  exit: (code) => process.exit(code),
};

export async function runRegistry(
  args: string[],
  deps: RegistryCmdDeps = DEFAULT_DEPS,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "maintain") {
    const code = await deps.maintain(rest);
    if (code !== 0) deps.exit(code);
    return;
  }
  if (sub !== undefined && CLIENT_SUBS.has(sub)) {
    const clientSub = sub as RegistryClientSub;
    const isTty = deps.isTty();
    if (clientSub === "add") {
      // TTY / --yes / flag refusals need no gateway, so they report even when none is running.
      const refused = registryAddPrecheck(rest, isTty, deps.writeErr);
      if (refused !== undefined) deps.exit(refused);
    }
    const code = await deps.client(clientSub, rest, isTty);
    if (code !== 0) deps.exit(code);
    return;
  }
  deps.writeErr(REGISTRY_USAGE);
  deps.exit(2);
}
