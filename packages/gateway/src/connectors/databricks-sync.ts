import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapDatabricksJobToItem, type RunSummary } from "./databricks-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "databricks";
const CURSOR_PREFIX = "nimbus-databricks1:";
const JOBS_PAGE_SIZE = 25;
const RUNS_PAGE_SIZE = 100;
const MAX_PAGES = 20;

type DatabricksCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DatabricksCursorV1);
}

export type DatabricksSyncableOptions = {
  ensureDatabricksMcpRunning: () => Promise<void>;
};

interface DatabricksCreds {
  readonly host: string;
  readonly token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<DatabricksCreds | null> {
  const host = (await ctx.getSecret("host"))?.trim() ?? "";
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (host === "" || token === "") {
    return null;
  }
  return { host: trimTrailingSlash(host), token };
}

function extractArray(parsed: unknown, key: string): unknown[] {
  const v = asRecord(parsed)?.[key];
  return Array.isArray(v) ? v : [];
}

function strOrNull(r: Record<string, unknown>, key: string): string | null {
  return stringField(r, key) ?? null;
}

function numOrNull(r: Record<string, unknown>, key: string): number | null {
  return numberField(r, key) ?? null;
}

function extractRunsByJobId(parsed: unknown): Map<number, RunSummary> {
  const map = new Map<number, RunSummary>();
  for (const r of extractArray(parsed, "runs")) {
    const run = asRecord(r);
    if (run === undefined) {
      continue;
    }
    const jobId = numberField(run, "job_id");
    if (jobId === undefined || map.has(jobId)) {
      continue;
    }
    const state = asRecord(run["state"]) ?? {};
    const clusterInstance = asRecord(run["cluster_instance"]) ?? {};
    const duration = numOrNull(run, "run_duration") ?? numOrNull(run, "execution_duration");
    map.set(jobId, {
      run_id: numOrNull(run, "run_id"),
      life_cycle_state: strOrNull(state, "life_cycle_state"),
      result_state: strOrNull(state, "result_state"),
      start_time: numOrNull(run, "start_time"),
      run_duration: duration,
      creator_user_name: strOrNull(run, "creator_user_name"),
      cluster_id: strOrNull(clusterInstance, "cluster_id"),
    });
  }
  return map;
}

function upsertJobs(
  ctx: SyncContext,
  creds: DatabricksCreds,
  runsByJobId: Map<number, RunSummary>,
  jobs: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const j of jobs) {
    const mapped = mapDatabricksJobToItem(j, { host: creds.host, runsByJobId, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

function jobsListPath(pageToken: string | null): string {
  const params = new URLSearchParams({ limit: String(JOBS_PAGE_SIZE) });
  if (pageToken !== null) {
    params.set("page_token", pageToken);
  }
  return `/api/2.1/jobs/list?${params.toString()}`;
}

export function createDatabricksSyncable(options: DatabricksSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDatabricksMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const runsOutcome = await connectorFetch(
        ctx,
        SERVICE_ID,
        `${creds.host}/api/2.1/jobs/runs/list?limit=${String(RUNS_PAGE_SIZE)}&expand_tasks=false`,
        { headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" } },
      );
      let totalBytes = runsOutcome.bytes;
      const runsByJobId =
        runsOutcome.kind === "ok"
          ? extractRunsByJobId(runsOutcome.parsed)
          : new Map<number, RunSummary>();

      const now = Date.now();
      let totalUpserted = 0;
      let pageToken: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await connectorFetch(
          ctx,
          SERVICE_ID,
          `${creds.host}${jobsListPath(pageToken)}`,
          {
            headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
          },
        );
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const envelope = asRecord(outcome.parsed) ?? {};
        totalUpserted += upsertJobs(
          ctx,
          creds,
          runsByJobId,
          extractArray(outcome.parsed, "jobs"),
          now,
        );

        const hasMore = envelope["has_more"] === true;
        const nextToken = stringField(envelope, "next_page_token") ?? "";
        if (!hasMore || nextToken === "") {
          break;
        }
        pageToken = nextToken;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
