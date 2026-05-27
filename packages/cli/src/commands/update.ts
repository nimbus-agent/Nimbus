import type { IPCClient } from "../ipc-client/index.ts";
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

/**
 * Sub-handler: `nimbus update --check`. Calls `updater.checkNow` and prints
 * the version info; sets `process.exitCode = 1` when a newer version exists,
 * `0` otherwise. Exposed so the test suite can drive the dispatcher in
 * isolation from the gateway socket.
 */
export async function runUpdateCheck(client: IPCClient): Promise<void> {
  const result = await client.call<UpdateCheckResult>("updater.checkNow", {});
  console.log(`current: ${result.currentVersion}`);
  console.log(`latest:  ${result.latestVersion}`);
  if (result.notes) {
    console.log(`notes:   ${result.notes}`);
  }
  process.exitCode = result.updateAvailable ? 1 : 0;
}

/**
 * Sub-handler: `nimbus update --yes` (no prompt). Calls `updater.applyUpdate`
 * and prints the success message. The prompt-bearing apply flow lives in
 * `runUpdate`, which composes a check + interactive prompt + this helper.
 */
export async function runUpdateApply(client: IPCClient): Promise<void> {
  await client.call<unknown>("updater.applyUpdate", {});
  console.log("Update applied. Gateway will restart.");
}

export async function runUpdate(argv: string[]): Promise<void> {
  const args = parseUpdateArgs(argv);

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

  await withGatewayIpc(async (c) => {
    await runUpdateApply(c);
  });
}

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // If not a TTY, don't try to read
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
