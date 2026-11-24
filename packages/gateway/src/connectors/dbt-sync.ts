import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { DBT_SERVICE_ID, type DbtCreds, dbtGet, extractDbtData, loadDbtCreds } from "./dbt-api.ts";
import { mapDbtJobToItem } from "./dbt-job-mapping.ts";
import { FIRST_PASS_WINDOW_MS, syncDbtTestResults } from "./dbt-test-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField } from "./unknown-record.ts";

const SERVICE_ID = DBT_SERVICE_ID;
const CURSOR_PREFIX = "nimbus-dbt1:";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_ACCOUNT = 20;

/** Per account id: `tests` is the finished-at and `testRuns` the run id its test-result pass resumes after. */
type DbtCursorV1 = {
  pass: number;
  tests?: Record<string, number>;
  testRuns?: Record<string, number>;
};
type TestPositions = { tests: Record<string, number>; testRuns: Record<string, number> };

function pass1Cursor(pos: TestPositions = { tests: {}, testRuns: {} }): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1, ...pos } satisfies DbtCursorV1);
}

function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(raw) ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function readTestPositions(cursor: string | null): TestPositions {
  const parsed = decodeNimbusJsonCursorObject(cursor, CURSOR_PREFIX);
  return { tests: numberMap(parsed?.["tests"]), testRuns: numberMap(parsed?.["testRuns"]) };
}

export type DbtSyncableOptions = {
  ensureDbtMcpRunning: () => Promise<void>;
};

function extractAccountIds(parsed: unknown): number[] {
  const out: number[] = [];
  for (const a of extractDbtData(parsed)) {
    const row = asRecord(a);
    if (row === undefined) {
      continue;
    }
    const id = numberField(row, "id");
    if (id !== undefined) {
      out.push(id);
    }
  }
  return out;
}

function jobsPath(accountId: number, offset: number): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `/accounts/${encodeURIComponent(String(accountId))}/jobs/?${params.toString()}`;
}

type AccountsOutcome =
  | { readonly accountIds: number[]; readonly bytes: number }
  | { readonly error: "http_error" | "parse_error"; readonly bytes: number };

async function resolveAccounts(ctx: SyncContext, creds: DbtCreds): Promise<AccountsOutcome> {
  if (creds.accountId !== null) {
    return { accountIds: [creds.accountId], bytes: 0 };
  }
  const outcome = await dbtGet(ctx, creds, "/accounts/");
  if (outcome.kind === "ok") {
    return { accountIds: extractAccountIds(outcome.parsed), bytes: outcome.bytes };
  }
  return { error: outcome.kind, bytes: outcome.bytes };
}

async function syncAccountJobs(
  ctx: SyncContext,
  creds: DbtCreds,
  accountId: number,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  let upserted = 0;
  let bytes = 0;

  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page += 1) {
    const offset = page * PAGE_SIZE;
    const outcome = await dbtGet(ctx, creds, jobsPath(accountId, offset));
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      ctx.logger.warn(
        { serviceId: SERVICE_ID, accountId },
        "dbt jobs GET failed; skipping account",
      );
      break;
    }
    const jobs = extractDbtData(outcome.parsed);
    upserted += upsertMapped(ctx, jobs, (raw) =>
      mapDbtJobToItem(raw, { apiBase: creds.apiBase, accountId, syncedAt: now }),
    );
    if (jobs.length < PAGE_SIZE) {
      break;
    }
  }
  return { upserted, bytes };
}

/** The test-result pass for every account; a failure keeps that account's previous position and never fails the sync. */
async function syncTestResults(
  ctx: SyncContext,
  creds: DbtCreds,
  accountIds: readonly number[],
  cursor: string | null,
  now: number,
): Promise<{ since: TestPositions; upserted: number; bytes: number }> {
  const since = readTestPositions(cursor);
  let upserted = 0;
  let bytes = 0;
  for (const accountId of accountIds) {
    const key = String(accountId);
    try {
      const from = {
        ms: since.tests[key] ?? now - FIRST_PASS_WINDOW_MS,
        runId: since.testRuns[key] ?? -1,
      };
      const out = await syncDbtTestResults(ctx, creds, accountId, from, now); // NOSONAR S9382: one account at a time through the shared dbt Cloud rate limiter
      since.tests[key] = out.since.ms;
      since.testRuns[key] = out.since.runId;
      upserted += out.upserted;
      bytes += out.bytes;
    } catch (err) {
      ctx.logger.warn({ serviceId: SERVICE_ID, accountId, err }, "dbt test pass failed; skipped");
    }
  }
  return { since, upserted, bytes };
}

export function createDbtSyncable(options: DbtSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDbtMcpRunning();
      const creds = await loadDbtCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const resolved = await resolveAccounts(ctx, creds);
      let totalBytes = resolved.bytes;
      if ("error" in resolved) {
        return resolved.error === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const accountId of resolved.accountIds) {
        const result = await syncAccountJobs(ctx, creds, accountId, now); // NOSONAR S9382: one account at a time through the shared dbt Cloud rate limiter - each account paginates its own job list (up to MAX_PAGES_PER_ACCOUNT) and the account list is uncapped
        totalUpserted += result.upserted;
        totalBytes += result.bytes;
      }

      const tests = await syncTestResults(ctx, creds, resolved.accountIds, cursor, now);
      totalBytes += tests.bytes;
      totalUpserted += tests.upserted;

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(tests.since), totalUpserted);
    },
  };
}
