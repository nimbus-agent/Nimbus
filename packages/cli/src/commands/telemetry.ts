import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

function printTelemetryHelp(): void {
  console.log(`nimbus telemetry — opt-in aggregate telemetry

Usage:
  nimbus telemetry show     Print sanitized preview payload (requires Gateway)
  nimbus telemetry disable  Write local disable marker under the data directory (no Gateway)
`);
}

export async function runTelemetryShow(client: IPCClient): Promise<void> {
  const r = await client.call<unknown>("telemetry.preview", {});
  console.log(JSON.stringify(r, null, 2));
}

export async function runTelemetryDisable(
  dataDir: string,
  writeFile: (p: string, data: string) => Promise<unknown> = (p, d) =>
    Bun.write(p, d) as Promise<unknown>,
  now: () => number = Date.now,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, ".nimbus-telemetry-disabled"), `${String(now())}\n`);
  console.log("Telemetry disabled (local marker written under the data directory).");
}

export async function runTelemetry(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printTelemetryHelp();
    return;
  }

  if (sub === "show") {
    await withGatewayIpc((c) => runTelemetryShow(c));
    return;
  }

  if (sub === "disable") {
    const paths = getCliPlatformPaths();
    await runTelemetryDisable(paths.dataDir);
    return;
  }

  throw new Error(`Unknown telemetry subcommand: ${sub}`);
}
