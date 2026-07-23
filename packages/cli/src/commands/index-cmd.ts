import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type ReembedSummary = {
  jobId: string;
  succeeded: number;
  skipped: number;
  durationMs: number;
  planned?: number;
  dryRun?: boolean;
};

interface ReembedOptions {
  model: string;
  itemType?: string;
  service?: string;
  limit?: number;
  batchSize?: number;
}

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function takeBool(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function printPlannedAction(p: ReembedOptions): void {
  console.log(`Planned reembed:`);
  console.log(`  model      = ${p.model}`);
  if (p.itemType !== undefined) console.log(`  item-type  = ${p.itemType}`);
  if (p.service !== undefined) console.log(`  service    = ${p.service}`);
  if (p.limit !== undefined) console.log(`  limit      = ${String(p.limit)}`);
  if (p.batchSize !== undefined) console.log(`  batch-size = ${String(p.batchSize)}`);
  console.log("Re-run with --yes to execute, or --dry-run to compute the candidate count.");
}

function parseReembedOptions(args: string[]): ReembedOptions {
  const model = takeFlag(args, "--model");
  if (model === undefined || model === "") {
    throw new Error(
      "Usage: nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]",
    );
  }
  const opts: ReembedOptions = { model };
  const itemType = takeFlag(args, "--item-type");
  const service = takeFlag(args, "--service");
  const limit = parseInteger(takeFlag(args, "--limit"));
  const batchSize = parseInteger(takeFlag(args, "--batch-size"));
  if (itemType !== undefined) opts.itemType = itemType;
  if (service !== undefined) opts.service = service;
  if (limit !== undefined) opts.limit = limit;
  if (batchSize !== undefined) opts.batchSize = batchSize;
  return opts;
}

function streamReembed(
  c: IPCClient,
  params: Record<string, unknown>,
  isJson: boolean,
): Promise<ReembedSummary> {
  return new Promise<ReembedSummary>((resolve, reject) => {
    let jobId: string | undefined;
    c.onNotification("index.reembedProgress", (n: unknown) => {
      const p = n as { jobId: string; done: number; total: number; skipped: number };
      if (jobId === undefined || p.jobId !== jobId) return;
      if (!isJson) {
        console.log(
          `progress: ${String(p.done)}/${String(p.total)} (skipped ${String(p.skipped)})`,
        );
      }
    });
    c.onNotification("index.reembedDone", (n: unknown) => {
      const p = n as ReembedSummary;
      if (jobId === undefined || p.jobId !== jobId) return;
      resolve(p);
    });
    c.onNotification("index.reembedError", (n: unknown) => {
      const p = n as { jobId: string; code: number; message: string };
      if (jobId === undefined || p.jobId !== jobId) return;
      reject(new Error(`ERROR: ${p.message}`));
    });
    c.call<{ jobId: string }>("index.reembed", params)
      .then((r) => {
        jobId = r.jobId;
      })
      .catch(reject);
  });
}

function printReembedSummaryJson(summary: ReembedSummary): void {
  console.log(JSON.stringify(summary));
}

function printReembedSummaryText(summary: ReembedSummary): void {
  if (summary.dryRun === true) {
    console.log(`Dry run: ${String(summary.planned ?? 0)} item(s) would be reembedded.`);
  } else {
    console.log(
      `Reembedded ${String(summary.succeeded)} item(s); skipped ${String(summary.skipped)} ` +
        `(${String(summary.durationMs)} ms).`,
    );
  }
}

async function runReembed(args: string[]): Promise<void> {
  const opts = parseReembedOptions(args);
  const dryRun = takeBool(args, "--dry-run");
  const yes = takeBool(args, "--yes");
  const isJson = takeBool(args, "--json");

  if (!dryRun && !yes) {
    printPlannedAction(opts);
    return;
  }

  const params: Record<string, unknown> = { model: opts.model, dryRun };
  if (opts.itemType !== undefined) params["itemType"] = opts.itemType;
  if (opts.service !== undefined) params["service"] = opts.service;
  if (opts.limit !== undefined) params["limit"] = opts.limit;
  if (opts.batchSize !== undefined) params["batchSize"] = opts.batchSize;

  const summary = await withGatewayIpc((c) => streamReembed(c, params, isJson));
  if (isJson) {
    printReembedSummaryJson(summary);
  } else {
    printReembedSummaryText(summary);
  }
}

type RegraphSummary = { scanned: number; graphed: number; skipped: number };

async function runRegraph(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const result = await withGatewayIpc((c) => c.call<RegraphSummary>("index.regraph", null));
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    // `graphed` counts items that actually wrote graph rows, not items dispatched.
    console.log(
      `regraph: scanned ${String(result.scanned)}, graphed ${String(result.graphed)}, skipped ${String(result.skipped)}`,
    );
  }
  if (result.skipped > 0) {
    console.error(
      `WARN: ${String(result.skipped)} item(s) failed to graph — see the gateway log for per-item errors.`,
    );
  }
}

function printIndexHelp(): void {
  console.log(`nimbus index — local index maintenance (Gateway IPC)

Usage:
  nimbus index reembed --model <id>
                       [--item-type <key>]   ("service:type" exact, or "type" alone)
                       [--service <name>]
                       [--limit N]
                       [--batch-size N]      (default 100, clamped 1..256)
                       [--dry-run]
                       [--yes]               (required for non-dry runs)
                       [--json]
  nimbus index regraph [--json]
                       Re-run the graph populator over every indexed item (backfills resolves/mentions/correlates_with)
                       Note: 'graphed' counts items that actually wrote graph rows, not items dispatched.

Models (v1):
  openai:text-embedding-3-small  (1536-dim; needs vault key openai.api_key)
  Xenova/all-MiniLM-L6-v2        (384-dim; local, no key required)

Exit codes:
  0  run completed (skips are reported but non-fatal); operator re-runs to retry skipped items
  1  fatal abort (vault key missing, unknown model, auth failure, gateway down)
`);
}

export async function runIndexCmd(args: string[]): Promise<void> {
  const sub = args[0];
  const tail = args.slice(1);
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printIndexHelp();
    return;
  }
  if (sub === "reembed") {
    await runReembed(tail);
    return;
  }
  if (sub === "regraph") {
    await runRegraph(tail);
    return;
  }
  throw new Error(`Unknown index subcommand: ${sub}. Try: nimbus index help`);
}
