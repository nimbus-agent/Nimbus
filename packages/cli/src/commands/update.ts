import {
  channelUpgradeHint,
  type DistributionChannel,
  resolveDistributionChannel,
} from "@nimbus-dev/sdk";
import type { IPCClient } from "../ipc-client/index.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export type UpdateArgs = { mode: "check" | "apply"; yes: boolean };

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  notes?: string;
};

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  let mode: UpdateArgs["mode"] = "apply";
  let yes = false;
  for (const arg of argv) {
    switch (arg) {
      case "--check":
        mode = "check";
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return { mode, yes };
}

export async function runUpdateCheck(client: IPCClient): Promise<void> {
  const result = await client.call<UpdateCheckResult>("updater.checkNow", {});
  console.log(`current: ${result.currentVersion}`);
  console.log(`latest:  ${result.latestVersion}`);
  if (result.notes) {
    console.log(`notes:   ${result.notes}`);
  }
  process.exitCode = result.updateAvailable ? 1 : 0;
}

export async function runUpdateApply(client: IPCClient): Promise<void> {
  await client.call<unknown>("updater.applyUpdate", {});
  console.log("Update applied. Gateway will restart.");
}

export interface RunUpdateOptions {
  channel?: DistributionChannel | null;
}

export async function runUpdate(argv: string[], opts: RunUpdateOptions = {}): Promise<void> {
  // Validate flags first (pure, no IPC) so an unknown flag still errors even on a
  // package-managed install. The channel short-circuit below stays before any
  // withGatewayIpc() call, so the managed path still opens no IPC connection.
  const args = parseUpdateArgs(argv);

  const channel = opts.channel === undefined ? resolveDistributionChannel() : opts.channel;
  if (channel !== null) {
    console.log(channelUpgradeHint(channel));
    process.exitCode = 0;
    return;
  }

  if (args.mode === "check") {
    await withGatewayIpc(async (c) => {
      await runUpdateCheck(c);
    });
    return;
  }

  if (!args.yes) {
    console.log("Check for updates?");
    const checkResult = await withGatewayIpc((c) =>
      c.call<UpdateCheckResult>("updater.checkNow", {}),
    );
    console.log(`current: ${checkResult.currentVersion}`);
    console.log(`latest:  ${checkResult.latestVersion}`);

    if (!checkResult.updateAvailable) {
      console.log("No update available.");
      return;
    }

    if (checkResult.notes) {
      console.log(`Release notes: ${checkResult.notes}`);
    }

    process.stdout.write("Apply update now? [y/N] ");
    const answer = await readLine();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  // `updater.applyUpdate` downloads, verifies the signature and installs before it
  // returns — the Tauri bridge already exempts it from its own 30s bound via
  // NO_TIMEOUT_METHODS; the CLI was still applying one.
  await withGatewayIpc(
    async (c) => {
      await runUpdateApply(c);
    },
    undefined,
    { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS },
  );
}

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunk = process.stdin.read();
    if (chunk === null) {
      process.stdin.once("data", (data) => {
        resolve((data as Buffer).toString("utf8"));
      });
    } else {
      resolve(chunk.toString("utf8"));
    }
  });
}
