import { resolve } from "node:path";
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

/**
 * `LongRunningJobRegistry.start()` (gateway side) can emit a progress/done/error
 * notification before the `index.reembed`/`index.rebody` RPC response even reaches this
 * client — trivially for a zero-`await` `dryRun` path, where the job's `run()` resolves
 * synchronously and the "done" emit can be written to the wire before the RPC response
 * frame is. A notification handler that only matches against an already-known `jobId`
 * silently drops anything that arrives first: progress vanishes, and a dropped `done`/`error`
 * leaves this promise unresolved forever. Buffer events until `jobId` is known, then replay
 * them in arrival order — used by both `streamReembed` and `streamRebody` below.
 */
function streamJob<TDone extends { jobId: string }>(
  c: IPCClient,
  call: { method: string; params: Record<string, unknown> },
  events: {
    progressMethod: string;
    doneMethod: string;
    errorMethod: string;
    onProgress: (p: unknown) => void;
  },
): Promise<TDone> {
  return new Promise<TDone>((resolve, reject) => {
    let jobId: string | undefined;
    const buffered: Array<{ method: string; payload: unknown }> = [];

    function dispatch(method: string, payload: unknown): void {
      const p = payload as { jobId: string };
      if (jobId === undefined || p.jobId !== jobId) return;
      if (method === events.progressMethod) {
        events.onProgress(payload);
      } else if (method === events.doneMethod) {
        resolve(payload as TDone);
      } else if (method === events.errorMethod) {
        reject(new Error(`ERROR: ${(payload as { message: string }).message}`));
      }
    }

    function onEvent(method: string, payload: unknown): void {
      if (jobId === undefined) {
        buffered.push({ method, payload });
        return;
      }
      dispatch(method, payload);
    }

    c.onNotification(events.progressMethod, (n: unknown) => onEvent(events.progressMethod, n));
    c.onNotification(events.doneMethod, (n: unknown) => onEvent(events.doneMethod, n));
    c.onNotification(events.errorMethod, (n: unknown) => onEvent(events.errorMethod, n));

    c.call<{ jobId: string }>(call.method, call.params)
      .then((r) => {
        jobId = r.jobId;
        const toFlush = buffered.splice(0, buffered.length);
        for (const { method, payload } of toFlush) {
          dispatch(method, payload);
        }
      })
      .catch(reject);
  });
}

function streamReembed(
  c: IPCClient,
  params: Record<string, unknown>,
  isJson: boolean,
): Promise<ReembedSummary> {
  return streamJob<ReembedSummary>(
    c,
    { method: "index.reembed", params },
    {
      progressMethod: "index.reembedProgress",
      doneMethod: "index.reembedDone",
      errorMethod: "index.reembedError",
      onProgress: (n: unknown) => {
        const p = n as { done: number; total: number; skipped: number };
        if (!isJson) {
          console.log(
            `progress: ${String(p.done)}/${String(p.total)} (skipped ${String(p.skipped)})`,
          );
        }
      },
    },
  );
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

type RebodyDonePayload = {
  jobId: string;
  durationMs: number;
  dryRun: boolean;
  pending?: Record<string, number>;
  cannotImprove?: string[];
  targeted?: string[];
  succeeded?: number;
  failed?: number;
  failedServices?: string[];
  warnings?: string[];
  pendingBefore?: Record<string, number>;
  pendingAfter?: Record<string, number>;
};

interface RebodyOptions {
  service?: string;
  type?: string;
  limit?: number;
}

/**
 * Unlike `reembed`'s `--limit` (bounds a local CPU recompute — safe to
 * silently drop if malformed), `rebody`'s `--limit` bounds how many
 * connectors get an unbounded full-account network re-walk. The gateway RPC
 * (`parseRebodyParams` in `ipc/index-rebody-rpc.ts`) rejects a malformed
 * value with rpc code -32602 rather than ignoring it, and the CLI must not
 * even send one — so validate client-side and fail loudly before any IPC
 * round-trip.
 */
function parseRebodyLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `--limit must be a positive integer (got "${raw}"). A malformed limit is rejected, not ` +
        `ignored, because it bounds how many connectors get a full-account network re-walk.`,
    );
  }
  return n;
}

function parseRebodyOptions(args: string[]): RebodyOptions {
  const service = takeFlag(args, "--service");
  const type = takeFlag(args, "--type");
  const limit = parseRebodyLimit(takeFlag(args, "--limit"));
  const opts: RebodyOptions = {};
  if (service !== undefined) opts.service = service;
  if (type !== undefined) opts.type = type;
  if (limit !== undefined) opts.limit = limit;
  return opts;
}

function printPlannedRebody(p: RebodyOptions): void {
  console.log(`Planned rebody:`);
  if (p.service !== undefined) console.log(`  service = ${p.service}`);
  if (p.type !== undefined) console.log(`  type    = ${p.type}`);
  if (p.limit !== undefined) console.log(`  limit   = ${String(p.limit)}`);
  console.log(
    "rebody re-fetches item bodies by clearing a connector's sync watermark and letting it " +
      "re-sync from scratch — this is real outbound API traffic, potentially tens of thousands " +
      "of requests for a full-scan connector (e.g. Notion, Confluence).",
  );
  console.log(
    "Re-run with --yes to execute, or --dry-run to see the per-service pending counts first.",
  );
}

function formatCounts(counts: Record<string, number>): string {
  return Object.keys(counts)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k} ${String(counts[k])}`)
    .join(", ");
}

function printCannotImprove(cannotImprove: string[] | undefined): void {
  if (cannotImprove === undefined || cannotImprove.length === 0) return;
  console.log(
    `cannot improve: ${cannotImprove.join(", ")} — connector(s) do not yet index full bodies; ` +
      `re-fetching will not change this count.`,
  );
}

/**
 * Signal 3 of the dry-run contract (see task-15 brief): a full-scan
 * connector re-walks its ENTIRE account, not just the pending items listed,
 * so a bare `notion 4210` line understates the cost. That per-service
 * full-scan-vs-delta-sync fact is NOT reachable here: it lives only as
 * connector-internal `Syncable` cursor behavior in
 * `packages/gateway/src/connectors/*-sync.ts`, and `cli` may not import
 * gateway source (IPC-only dependency rule); `index.rebody`'s result shape
 * (`pending`/`pendingBefore`/`pendingAfter`/`cannotImprove`/`failedServices`/
 * `warnings`) carries no such flag either. Hardcoding a service-name list
 * here is exactly what task-15 forbids (it would drift from the connectors),
 * so this prints a service-agnostic version of the same warning instead of
 * inventing one.
 */
function printRewalkCaveat(): void {
  console.log(
    "note: rebody works by clearing a service's sync watermark and letting its next sync run " +
      "from scratch — cost is NOT proportional to the pending counts above. Some connectors " +
      "resume from a bounded recent window; others have no delta sync and re-walk the ENTIRE " +
      "account regardless of how many items are actually pending.",
  );
}

function printPendingTransition(
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) =>
    a.localeCompare(b),
  );
  if (keys.length === 0) {
    console.log("pending bodies: none.");
    return;
  }
  console.log("pending bodies (before -> after):");
  for (const k of keys) {
    const b = before[k] ?? 0;
    const a = after[k] ?? 0;
    console.log(`  ${k}: ${String(b)} -> ${String(a)}`);
  }
}

function streamRebody(
  c: IPCClient,
  params: Record<string, unknown>,
  isJson: boolean,
): Promise<RebodyDonePayload> {
  return streamJob<RebodyDonePayload>(
    c,
    { method: "index.rebody", params },
    {
      progressMethod: "index.rebodyProgress",
      doneMethod: "index.rebodyDone",
      errorMethod: "index.rebodyError",
      onProgress: (n: unknown) => {
        const p = n as { done: number; total: number; service: string };
        if (!isJson) {
          console.log(`progress: ${String(p.done)}/${String(p.total)} (${p.service})`);
        }
      },
    },
  );
}

function printRebodySummaryJson(summary: RebodyDonePayload): void {
  console.log(JSON.stringify(summary));
}

function printRebodySummaryText(summary: RebodyDonePayload): void {
  if (summary.dryRun) {
    const pending = summary.pending ?? {};
    console.log(
      Object.keys(pending).length === 0
        ? "pending bodies: none."
        : `pending bodies: ${formatCounts(pending)}`,
    );
    printCannotImprove(summary.cannotImprove);
    printRewalkCaveat();
    return;
  }

  printPendingTransition(summary.pendingBefore ?? {}, summary.pendingAfter ?? {});
  printCannotImprove(summary.cannotImprove);
  printRewalkCaveat();
  console.log(
    `targeted ${String(summary.targeted?.length ?? 0)} service(s); succeeded ` +
      `${String(summary.succeeded ?? 0)}; failed ${String(summary.failed ?? 0)}`,
  );
  for (const w of summary.warnings ?? []) {
    console.error(`WARN: ${w}`);
  }
}

async function runRebody(args: string[]): Promise<void> {
  const opts = parseRebodyOptions(args);
  const dryRun = takeBool(args, "--dry-run");
  const yes = takeBool(args, "--yes");
  const isJson = takeBool(args, "--json");

  if (!dryRun && !yes) {
    printPlannedRebody(opts);
    return;
  }

  const params: Record<string, unknown> = { dryRun };
  if (opts.service !== undefined) params["service"] = opts.service;
  if (opts.type !== undefined) params["type"] = opts.type;
  if (opts.limit !== undefined) params["limit"] = opts.limit;

  const summary = await withGatewayIpc((c) => streamRebody(c, params, isJson));
  if (isJson) {
    printRebodySummaryJson(summary);
  } else {
    printRebodySummaryText(summary);
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

async function runIndexAdd(args: string[]): Promise<void> {
  const raw = args[0];
  if (raw === undefined || raw === "" || raw.startsWith("-")) {
    throw new Error("Usage: nimbus index add <path>");
  }
  const path = resolve(raw);
  const result = await withGatewayIpc((c) =>
    c.call<{ path: string; added: boolean }>("filesystem.ensureRoot", { path }),
  );
  console.log(
    result.added ? `Registered blame root: ${result.path}` : `Already registered: ${result.path}`,
  );
}

function printIndexHelp(): void {
  console.log(`nimbus index — local index maintenance (Gateway IPC)

Usage:
  nimbus index add <path>            register a local git repo as a blame/index root

  nimbus index reembed --model <id>
                       [--item-type <key>]   ("service:type" exact, or "type" alone)
                       [--service <name>]
                       [--limit N]
                       [--batch-size N]      (default 100, clamped 1..256)
                       [--dry-run]
                       [--yes]               (required for non-dry runs)
                       [--json]
  nimbus index rebody [--service <name>]
                      [--type <t>]
                      [--limit N]
                      [--dry-run]
                      [--yes]               (required for non-dry runs)
                      [--json]
                       Re-fetch full item bodies for services left with truncated legacy text
                       (clears the connector's sync watermark and re-syncs from scratch — real
                       outbound API traffic, potentially the WHOLE account for a full-scan
                       connector, not just the pending count shown).
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
  if (sub === "add") {
    await runIndexAdd(tail);
    return;
  }
  if (sub === "reembed") {
    await runReembed(tail);
    return;
  }
  if (sub === "rebody") {
    await runRebody(tail);
    return;
  }
  if (sub === "regraph") {
    await runRegraph(tail);
    return;
  }
  throw new Error(`Unknown index subcommand: ${sub}. Try: nimbus index help`);
}
