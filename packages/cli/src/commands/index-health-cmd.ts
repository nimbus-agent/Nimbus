import type { IPCClient } from "../ipc-client/index.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { formatIndexHealth, type IndexHealthReport } from "./index-health-format.ts";

function takeFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

/**
 * `nimbus index health` — the index quality report.
 *
 * Read-only: one `index.health` call, no HITL, no writes. The whole calculation is gateway-side
 * (it is SQL over the index), so this is a renderer plus argument parsing.
 */
export async function runIndexHealth(client: IPCClient, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const raw = takeFlagValue(args, "--stale-days");

  const params: Record<string, unknown> = {};
  if (raw !== undefined) {
    const n = Number(raw);
    // Parsed and rejected here as well as gateway-side: a CLI user gets a usage error rather than
    // a JSON-RPC code, and `Number("")` is 0 — which would silently mean "everything is stale".
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
      throw new Error(`--stale-days must be a non-negative number (got: ${raw})`);
    }
    params["staleThresholdDays"] = n;
  }

  const report = await client.call<IndexHealthReport>("index.health", params);

  if (json) {
    console.log(JSON.stringify(report, undefined, 2));
    return;
  }

  const noColorEnv = process.env["NO_COLOR"];
  const noColor = (noColorEnv !== undefined && noColorEnv !== "") || process.stdout.isTTY !== true;
  const all = args.includes("--all");
  const demo = getCliPlatformPaths().demo === true;
  process.stdout.write(formatIndexHealth(report, { nowMs: Date.now(), noColor, all, demo }));
}
