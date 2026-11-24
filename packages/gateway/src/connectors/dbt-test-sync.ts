import type { SyncContext } from "../sync/types.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { type DbtCreds, dbtGet, extractDbtData } from "./dbt-api.ts";
import { type DbtTestRun, indexDbtManifest, mapDbtTestResultToItem } from "./dbt-test-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

/**
 * The best-effort dbt test pass (Data Incident Brief input): for each account, the runs that finished since the
 * last pass (at most {@link MAX_RUN_PAGES} pages of 100, oldest {@link MAX_RUNS_PER_PASS} handled per pass), each
 * run's `run_results.json`, and, only when a run has a failing, erroring or warning test, its `manifest.json`
 * (to name the tested models). A failure never fails the dbt sync (the caller catches), and a capped listing
 * deletes nothing. Reply shapes follow dbt Cloud's Administrative API v2 documentation, not a live account.
 */
const RUN_PAGE_SIZE = 100;
export const MAX_RUN_PAGES = 3;
export const MAX_RUNS_PER_PASS = 15;
/** At most this many results of one run are indexed (a run that fails everything is cut, and says so). */
export const MAX_RESULTS_PER_RUN = 200;
/** The first pass looks this far back. */
export const FIRST_PASS_WINDOW_MS = 7 * 24 * 3_600_000;
const RUN_STATUS_SUCCESS = 10;
const RUN_STATUS_ERROR = 20;

/** Where a pass stopped: runs are handled in (finished-at, run id) order, so a tie on the time keeps its place. */
export type DbtTestPosition = { readonly ms: number; readonly runId: number };

export type DbtTestPassOutcome = {
  readonly upserted: number;
  readonly bytes: number;
  /** The position the next pass resumes after (unchanged when nothing could be read). */
  readonly since: DbtTestPosition;
};

/** A 4xx other than 429 will not change on a retry; a 5xx, a 429 or a dropped request might. */
function permanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

function runsPath(accountId: number, offset: number): string {
  const params = new URLSearchParams({
    order_by: "-finished_at",
    limit: String(RUN_PAGE_SIZE),
    offset: String(offset),
  });
  return `/accounts/${encodeURIComponent(String(accountId))}/runs/?${params.toString()}`;
}

function artifactPath(accountId: number, runId: number, file: string): string {
  return `/accounts/${encodeURIComponent(String(accountId))}/runs/${encodeURIComponent(String(runId))}/artifacts/${file}`;
}

function readRun(raw: unknown): DbtTestRun | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const runId = numberField(row, "id");
  const status = numberField(row, "status");
  const finished = stringField(row, "finished_at");
  const finishedAtMs = finished === undefined ? Number.NaN : Date.parse(finished);
  if (
    runId === undefined ||
    (status !== RUN_STATUS_SUCCESS && status !== RUN_STATUS_ERROR) ||
    !Number.isFinite(finishedAtMs)
  ) {
    return null;
  }
  return {
    runId,
    jobId: numberField(row, "job_id") ?? numberField(row, "job_definition_id") ?? null,
    projectId: numberField(row, "project_id") ?? null,
    finishedAtMs,
  };
}

/** Finished runs after `sinceMs`, newest page first, until a page reaches back to `sinceMs` or the cap. */
async function listNewRuns(
  ctx: SyncContext,
  creds: DbtCreds,
  accountId: number,
  since: DbtTestPosition,
): Promise<{ runs: DbtTestRun[]; bytes: number; ok: boolean }> {
  const runs: DbtTestRun[] = [];
  let bytes = 0;
  for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
    const outcome = await dbtGet(ctx, creds, runsPath(accountId, page * RUN_PAGE_SIZE));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      return { runs, bytes, ok: false };
    }
    const rows = extractDbtData(outcome.parsed);
    let reachedOld = false;
    for (const raw of rows) {
      const run = readRun(raw);
      if (run === null) continue;
      const after =
        run.finishedAtMs > since.ms || (run.finishedAtMs === since.ms && run.runId > since.runId);
      if (after) runs.push(run);
      else if (run.finishedAtMs < since.ms) reachedOld = true;
    }
    if (reachedOld || rows.length < RUN_PAGE_SIZE) break;
  }
  return { runs, bytes, ok: true };
}

type RunOutcome =
  | { readonly kind: "done"; readonly upserted: number; readonly bytes: number }
  | { readonly kind: "retry"; readonly bytes: number };

async function indexRun(
  ctx: SyncContext,
  creds: DbtCreds,
  accountId: number,
  run: DbtTestRun,
  now: number,
): Promise<RunOutcome> {
  const results = await dbtGet(
    ctx,
    creds,
    artifactPath(accountId, run.runId, "run_results.json"),
    true,
  );
  const bytes0 = results.bytes;
  let bytes = bytes0;
  if (results.kind === "http_error") {
    // 404: a run with no artifacts (no test step); other 4xx: not readable with this token, never retried.
    return permanentStatus(results.status)
      ? { kind: "done", upserted: 0, bytes }
      : { kind: "retry", bytes };
  }
  if (results.kind !== "ok") {
    return { kind: "done", upserted: 0, bytes };
  }
  const entries = asRecord(results.parsed)?.["results"];
  const flagged = (Array.isArray(entries) ? entries : [])
    .filter((e) => mapDbtTestResultToItem(e, base(creds, accountId, run, new Map(), now)) !== null)
    .slice(0, MAX_RESULTS_PER_RUN);
  if (flagged.length === 0) {
    return { kind: "done", upserted: 0, bytes };
  }
  const wanted = new Set(
    flagged
      .map((e) => stringField(asRecord(e) ?? {}, "unique_id"))
      .filter((u): u is string => u !== undefined),
  );
  const manifest = await dbtGet(
    ctx,
    creds,
    artifactPath(accountId, run.runId, "manifest.json"),
    true,
  );
  bytes += manifest.bytes;
  if (manifest.kind === "http_error" && !permanentStatus(manifest.status)) {
    return { kind: "retry", bytes }; // without the manifest the tests would be stored with no model, for good
  }
  const nodes = manifest.kind === "ok" ? indexDbtManifest(manifest.parsed, wanted) : new Map();
  const upserted = upsertMapped(ctx, flagged, (e) =>
    mapDbtTestResultToItem(e, base(creds, accountId, run, nodes, now)),
  );
  return { kind: "done", upserted, bytes };
}

function base(
  creds: DbtCreds,
  accountId: number,
  run: DbtTestRun,
  nodes: ReturnType<typeof indexDbtManifest>,
  syncedAt: number,
) {
  return { apiBase: creds.apiBase, accountId, run, nodes, syncedAt };
}

export async function syncDbtTestResults(
  ctx: SyncContext,
  creds: DbtCreds,
  accountId: number,
  since: DbtTestPosition,
  now: number,
): Promise<DbtTestPassOutcome> {
  const listed = await listNewRuns(ctx, creds, accountId, since);
  let bytes = listed.bytes;
  let upserted = 0;
  let next = since;
  if (!listed.ok) {
    return { upserted, bytes, since };
  }
  listed.runs.sort((a, b) => a.finishedAtMs - b.finishedAtMs || a.runId - b.runId);
  const queue = listed.runs.slice(0, MAX_RUNS_PER_PASS);
  for (const run of queue) {
    const outcome = await indexRun(ctx, creds, accountId, run, now); // NOSONAR S9382: runs are read one at a time through the shared dbt Cloud rate limiter
    bytes += outcome.bytes;
    if (outcome.kind === "retry") break; // resume at this run next pass
    upserted += outcome.upserted;
    next = { ms: run.finishedAtMs, runId: run.runId };
  }
  return { upserted, bytes, since: next };
}
