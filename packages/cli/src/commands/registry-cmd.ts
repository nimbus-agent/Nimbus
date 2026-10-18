/** `nimbus registry …` dispatcher. `maintain` is offline; add/list/refresh/remove talk to the gateway. */
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

const USAGE = `${REGISTRY_CLIENT_USAGE}       nimbus registry maintain init|add|remove ...\n`;

const CLIENT_SUBS: ReadonlySet<string> = new Set(["add", "list", "refresh", "remove"]);

/**
 * The seams `runRegistry` reaches through, so a test can drive the router without a real
 * `process.exit`. The defaults are the real thing; production callers pass nothing.
 */
export interface RegistryCmdDeps {
  readonly maintain: (args: string[]) => Promise<number>;
  readonly writeErr: (s: string) => void;
  readonly exit: (code: number) => never;
}

const DEFAULT_DEPS: RegistryCmdDeps = {
  maintain: (args) => runRegistryMaintain(args),
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
    const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (clientSub === "add") {
      // TTY / --yes / flag refusals need no gateway, so they report even when none is running.
      const refused = registryAddPrecheck(rest, isTty, (m) => process.stderr.write(m));
      if (refused !== undefined) process.exit(refused);
    }
    const paths = getCliPlatformPaths();
    const state = await readGatewayState(paths);
    if (state === undefined) {
      throw new Error(gatewayNotRunningMessage(paths.demo === true));
    }
    const client = createIpcClient(state.socketPath, registryClientTimeoutMs(clientSub));
    await client.connect();
    let code: number;
    try {
      code = await runRegistryClient(clientSub, rest, {
        client,
        isTty,
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      });
    } finally {
      await client.disconnect();
    }
    if (code !== 0) process.exit(code);
    return;
  }
  deps.writeErr(USAGE);
  deps.exit(2);
}
