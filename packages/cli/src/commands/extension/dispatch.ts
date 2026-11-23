import { tmpdir } from "node:os";
import type { IPCClient } from "../../ipc-client/index.ts";
import { gatewayNotRunningMessage } from "../../lib/gateway-not-running.ts";
import { readGatewayState } from "../../lib/gateway-process.ts";
import { openHttpsUrl } from "../../lib/open-url.ts";
import { readLine } from "../../lib/read-line.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../../paths.ts";
import { NIMBUS_VERSION } from "../../version.ts";
import { runExtensionAudit } from "../extension-audit.ts";
import { runExtensionClone } from "../extension-clone.ts";
import { runExtensionKey } from "../extension-key.ts";
import { runExtensionPack } from "../extension-pack.ts";
import { runExtensionVerifyProvenance } from "../extension-provenance.ts";
import { runExtensionPublish } from "../extension-publish.ts";
import { runExtensionSearch } from "../extension-registry-cmds.ts";
import { runExtensionReport } from "../extension-report.ts";
import { runExtensionSponsor } from "../extension-sponsor.ts";
import { NETWORK_EQ, printable, runExtensionApprove, runExtensionRevoke } from "./approve.ts";
import { runExtensionCredential } from "./credential.ts";
import { runExtensionDowngrade } from "./downgrade.ts";
import { hasFlag, stripFlags } from "./flags.ts";
import { runExtensionInfo } from "./info.ts";
import { runExtensionInstall, runExtensionRehash } from "./install.ts";
import { runExtensionKeygen, runExtensionSign } from "./keys.ts";
import { runExtensionDisable, runExtensionEnable, runExtensionRemove } from "./lifecycle.ts";
import { runExtensionList } from "./list.ts";
import { extensionUpdateApplies, runExtensionUpdate } from "./update.ts";

const EXTENSION_USAGE =
  "Usage: nimbus extension list [--filter needs-reinstall] [--tree] [--json] | info <id> [--deps] [--registry <name> | --remote] [--json] | search <query> [--json] | install <path | id> [--registry <name>] [--version <v>] [--channel beta] [--accept-publisher-key <fingerprint>] [--publisher-key <path>] [--yes] | rehash <id> [--yes] | approve <id> [--model] | revoke <id> | credential set <id> <name> | credential status <id> | enable <id> | disable <id> | remove <id> [--yes] [--force] [--clean-deps] | update [<id>] [--check] [--to <version>] [--accept-publisher-key <fingerprint>] [--json] | downgrade <id> [--json] | report <id> | sponsor <id> [--registry <name>] [--index <n>] | clone <id> [--registry <name>] [--version <v>] [--into <dir>] [--publisher <id>] [--json] | audit [<id>] [--json] | verify-provenance <id> [--json] | pack <dir> --out <file> | publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--statement <file>]... [--no-pr] | key rotate --from <old key file> --to <new key file> --publisher <id> [--out <file>] [--force] | key revoke --key <key file> --publisher <id> --reason <text> [--out <file>] [--force]";

/**
 * Subcommands that need no gateway. `publish`, `key` and `pack` get the RAW args: `stripFlags` drops
 * `--channel` and its value, which would silently publish a beta as stable, a `--reason` text, and
 * `--out`.
 */
async function runExtensionOffline(sub: string, args: string[]): Promise<boolean> {
  if (sub === "publish") {
    const code = await runExtensionPublish(args.slice(1));
    if (code !== 0) process.exit(code);
    return true;
  }
  if (sub === "key") {
    const code = await runExtensionKey(args.slice(1));
    if (code !== 0) process.exit(code);
    return true;
  }
  if (sub === "pack") {
    const code = await runExtensionPack(args.slice(1));
    if (code !== 0) process.exit(code);
    return true;
  }
  const rest = stripFlags(args.slice(1));
  if (sub === "keygen") {
    const code = await runExtensionKeygen(rest);
    if (code !== 0) process.exit(code);
    return true;
  }
  if (sub === "sign") {
    const code = await runExtensionSign(rest);
    if (code !== 0) process.exit(code);
    return true;
  }
  return false;
}

async function dispatchExtensionWithCode(
  sub: string,
  client: IPCClient,
  args: string[],
  socketPath?: string,
): Promise<boolean> {
  const handlers: Record<string, () => Promise<number>> = {
    search: async () =>
      runExtensionSearch(stripFlags(args.slice(1)).join(" "), hasFlag(args, "--json"), {
        client,
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      }),
    update: () =>
      runExtensionUpdate(client, args, socketPath === undefined ? undefined : { socketPath }),
    report: () =>
      runExtensionReport(args.slice(1), {
        client,
        isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
        confirm: async (q) => /^y(es)?$/i.test(await readLine(q)),
        openUrl: (u) => openHttpsUrl(u),
        log: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        nimbusVersion: NIMBUS_VERSION,
        osFamily: process.platform,
      }),
    sponsor: () =>
      runExtensionSponsor(args.slice(1), {
        client,
        isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
        confirm: async (q) => /^y(es)?$/i.test(await readLine(q)),
        openUrl: (u) => openHttpsUrl(u),
        log: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    clone: () =>
      runExtensionClone(args.slice(1), {
        client,
        cwd: process.cwd(),
        tmpDir: tmpdir(),
        now: () => new Date(),
        log: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    downgrade: () => runExtensionDowngrade(client, args),
    audit: () => runExtensionAudit(args.slice(1), { client, out: (s) => process.stdout.write(s) }),
    "verify-provenance": () =>
      runExtensionVerifyProvenance(args.slice(1), {
        client,
        out: (s) => process.stdout.write(s),
      }),
  };
  const handler = handlers[sub];
  if (handler === undefined) return false;
  const code = await handler();
  if (code !== 0) process.exit(code);
  return true;
}

async function dispatchExtensionVoid(
  sub: string,
  client: IPCClient,
  args: string[],
  rest: string[],
  socketPath: string,
): Promise<boolean> {
  switch (sub) {
    case "list":
    case "":
      await runExtensionList(client, args);
      return true;
    case "info":
      await runExtensionInfo(client, rest, args);
      return true;
    case "install":
      await runExtensionInstall(client, args, rest, { socketPath });
      return true;
    case "rehash":
      await runExtensionRehash(client, args, rest);
      return true;
    case "approve":
      await runExtensionApprove(client, args, rest);
      return true;
    case "revoke":
      await runExtensionRevoke(client, rest);
      return true;
    case "credential":
      await runExtensionCredential(client, rest);
      return true;
    case "enable":
      await runExtensionEnable(client, rest);
      return true;
    case "disable":
      await runExtensionDisable(client, rest);
      return true;
    case "remove":
      await runExtensionRemove(client, args, rest);
      return true;
    default:
      return false;
  }
}

/**
 * `install`, `rehash`, `approve`, `update` and `downgrade` block on the owner's HITL prompt, so
 * they get the human-bound budget rather than the 30s default that would time out while the owner
 * is still reading the prompt. `update --check` only reads, so it keeps the default.
 */
export function rpcTimeoutForExtensionSub(sub: string, rest: string[]): number | undefined {
  if (sub === "install" || sub === "rehash" || sub === "approve" || sub === "downgrade") {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  // `clone` fetches and verifies the registry index and the package, like a registry install.
  if (sub === "clone") {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  // Registry lookups fetch and verify every index; the 30s default is the fetch timeout itself.
  if (
    sub === "search" ||
    (sub === "info" && (hasFlag(rest, "--remote") || hasFlag(rest, "--registry"))) ||
    (sub === "sponsor" && hasFlag(rest, "--registry"))
  ) {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  if (sub === "update" && extensionUpdateApplies(rest)) {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  // `credential set` waits on the owner's vault.set prompt.
  if (sub === "credential" && rest[0] === "set") {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  return undefined;
}

/**
 * `--network` narrows a run approval and means nothing anywhere else. `stripFlags` drops it (and
 * its value) for every subcommand, so outside `approve` it would be silently ignored: refuse it.
 */
export function refuseNetworkOutsideApprove(sub: string, args: readonly string[]): void {
  if (sub === "approve") return;
  if (args.slice(1).some((a) => a === "--network" || a.startsWith(NETWORK_EQ))) {
    throw new Error(
      `--network is only for \`nimbus extension approve\`; \`nimbus extension ${printable(sub)}\` does not take it.`,
    );
  }
}

export async function runExtension(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  refuseNetworkOutsideApprove(sub, args);
  if (await runExtensionOffline(sub, args)) {
    return;
  }
  const rest = stripFlags(args.slice(1));

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error(gatewayNotRunningMessage(paths.demo === true));
  }

  const client = createIpcClient(state.socketPath, rpcTimeoutForExtensionSub(sub, args.slice(1)));
  await client.connect();
  try {
    if (await dispatchExtensionVoid(sub, client, args, rest, state.socketPath)) {
      return;
    }
    if (await dispatchExtensionWithCode(sub, client, args, state.socketPath)) {
      return;
    }
    throw new Error(EXTENSION_USAGE);
  } finally {
    await client.disconnect();
  }
}
