/** `nimbus registry …` dispatcher. `maintain` is offline; add/list/refresh/remove talk to the gateway. */
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { createIpcClient } from "../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  REGISTRY_CLIENT_USAGE,
  type RegistryClientSub,
  registryClientTimeoutMs,
  runRegistryClient,
} from "./registry-client-cmds.ts";
import { runRegistryMaintain } from "./registry-maintain.ts";

const USAGE = `${REGISTRY_CLIENT_USAGE}       nimbus registry maintain init|add|remove ...\n`;

const CLIENT_SUBS: ReadonlySet<string> = new Set(["add", "list", "refresh", "remove"]);

export async function runRegistry(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "maintain") {
    const code = await runRegistryMaintain(rest);
    if (code !== 0) process.exit(code);
    return;
  }
  if (sub !== undefined && CLIENT_SUBS.has(sub)) {
    const clientSub = sub as RegistryClientSub;
    const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
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
  process.stderr.write(USAGE);
  process.exit(2);
}
