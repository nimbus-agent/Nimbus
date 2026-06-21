import { getValidWorkdayAccessToken } from "../auth/workday-access-token.ts";
import {
  DEFAULT_NIMBUS_WORKDAY_TOML,
  type NimbusWorkdayToml,
} from "../config/nimbus-toml-workday.ts";
import { Config } from "../config.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  mapJobPostingToItem,
  mapTimeOffToItem,
  mapWorkerToItem,
  type WorkdayMapContext,
} from "./workday-mappers.ts";

const SERVICE_ID = "workday";
const CURSOR_PREFIX = "nimbus-workday1:";
const MAX_PAGES = 20;

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface WorkdayCursorV1 {
  workerOffset: number;
  timeOffOffset: number;
  jobPostingOffset: number;
}

interface DomainState {
  offset: number;
  hasMore: boolean;
}

function decodeCursor(cursor: string | null): WorkdayCursorV1 | null {
  if (cursor === null) return null;
  const parsed = decodeNimbusJsonCursorPayload(cursor, CURSOR_PREFIX);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "workerOffset" in parsed &&
    "timeOffOffset" in parsed &&
    "jobPostingOffset" in parsed
  ) {
    return {
      workerOffset:
        typeof (parsed as WorkdayCursorV1).workerOffset === "number"
          ? (parsed as WorkdayCursorV1).workerOffset
          : 0,
      timeOffOffset:
        typeof (parsed as WorkdayCursorV1).timeOffOffset === "number"
          ? (parsed as WorkdayCursorV1).timeOffOffset
          : 0,
      jobPostingOffset:
        typeof (parsed as WorkdayCursorV1).jobPostingOffset === "number"
          ? (parsed as WorkdayCursorV1).jobPostingOffset
          : 0,
    };
  }
  return null;
}

function buildNextCursor(
  workerOffset: number,
  timeOffOffset: number,
  jobPostingOffset: number,
): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, {
    workerOffset,
    timeOffOffset,
    jobPostingOffset,
  } satisfies WorkdayCursorV1);
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, "");
}

function restBase(tenantHost: string, tenant: string): string {
  return `${trimSlash(tenantHost)}/ccx/api/staffing/v6/${encodeURIComponent(tenant)}`;
}

function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchDomainPage(
  ctx: SyncContext,
  url: string,
  token: string,
  fetchFn: FetchFn,
): Promise<{ rows: unknown[]; bytes: number; ok: boolean }> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  const bytes = text.length;
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, status: res.status, url },
      "workday domain fetch failed",
    );
    return { rows: [], bytes, ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { rows: [], bytes, ok: false };
  }
  const data =
    parsed !== null && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>)["data"]
      : parsed;
  return { rows: Array.isArray(data) ? data : [], bytes, ok: true };
}

async function walkDomain(
  ctx: SyncContext,
  baseUrl: string,
  token: string,
  fetchFn: FetchFn,
  startOffset: number,
  mapper: (raw: unknown, mapCtx: WorkdayMapContext) => ReturnType<typeof mapWorkerToItem>,
  mapCtx: WorkdayMapContext,
  extraParams?: Record<string, string>,
): Promise<{ upserted: number; totalBytes: number; nextOffset: number; hasMore: boolean }> {
  let upserted = 0;
  let totalBytes = 0;
  let offset = startOffset;
  let hasMore = false;
  const pageSize = 50;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      ...extraParams,
    });
    const url = `${baseUrl}?${params.toString()}`;
    const { rows, bytes, ok } = await fetchDomainPage(ctx, url, token, fetchFn);
    totalBytes += bytes;
    if (!ok) break;
    for (const raw of rows) {
      const mapped = mapper(raw, mapCtx);
      if (mapped !== null) {
        upsertIndexedItemForSync(ctx, mapped);
        upserted += 1;
      }
    }
    if (rows.length < pageSize) {
      hasMore = false;
      offset += rows.length;
      break;
    }
    offset += rows.length;
    hasMore = true;
  }

  return { upserted, totalBytes, nextOffset: offset, hasMore };
}

export type WorkdaySyncableOptions = {
  ensureWorkdayMcpRunning: () => Promise<void>;
  loadWorkdayConfig?: () => NimbusWorkdayToml;
  fetchFn?: FetchFn;
  loadAccessToken?: (vault: SyncContext["vault"]) => Promise<string>;
};

export function createWorkdaySyncable(options: WorkdaySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,

    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureWorkdayMcpRunning();

      let accessToken: string;
      try {
        accessToken =
          options.loadAccessToken !== undefined
            ? await options.loadAccessToken(ctx.vault)
            : await getValidWorkdayAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const loadConfig = options.loadWorkdayConfig ?? (() => DEFAULT_NIMBUS_WORKDAY_TOML);
      const workdayConfig = loadConfig();
      const fetchFn: FetchFn = options.fetchFn ?? (globalThis.fetch as FetchFn);

      const prev = decodeCursor(cursor);
      const base = restBase(Config.workdayTenantHost, Config.workdayTenant);
      const mapCtx: WorkdayMapContext = {
        syncedAt: Date.now(),
        tenantHost: Config.workdayTenantHost,
        tenant: Config.workdayTenant,
      };

      let totalUpserted = 0;
      let totalBytes = 0;
      const domainState: Record<"worker" | "timeOff" | "jobPosting", DomainState> = {
        worker: { offset: prev?.workerOffset ?? 0, hasMore: false },
        timeOff: { offset: prev?.timeOffOffset ?? 0, hasMore: false },
        jobPosting: { offset: prev?.jobPostingOffset ?? 0, hasMore: false },
      };

      // Domain 1: /workers
      try {
        const result = await walkDomain(
          ctx,
          `${base}/workers`,
          accessToken,
          fetchFn,
          domainState.worker.offset,
          mapWorkerToItem,
          mapCtx,
        );
        totalUpserted += result.upserted;
        totalBytes += result.totalBytes;
        domainState.worker = { offset: result.nextOffset, hasMore: result.hasMore };
      } catch (err) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, domain: "workers", err },
          "workers domain error; continuing",
        );
      }

      // Domain 2: /timeOff (bounded by timeOffHistoryDays)
      try {
        const fromDate = daysAgoIso(workdayConfig.timeOffHistoryDays);
        const result = await walkDomain(
          ctx,
          `${base}/timeOff`,
          accessToken,
          fetchFn,
          domainState.timeOff.offset,
          mapTimeOffToItem,
          mapCtx,
          { from: fromDate },
        );
        totalUpserted += result.upserted;
        totalBytes += result.totalBytes;
        domainState.timeOff = { offset: result.nextOffset, hasMore: result.hasMore };
      } catch (err) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, domain: "timeOff", err },
          "timeOff domain error; continuing",
        );
      }

      // Domain 3: /jobRequisitions
      try {
        const result = await walkDomain(
          ctx,
          `${base}/jobRequisitions`,
          accessToken,
          fetchFn,
          domainState.jobPosting.offset,
          mapJobPostingToItem,
          mapCtx,
        );
        totalUpserted += result.upserted;
        totalBytes += result.totalBytes;
        domainState.jobPosting = { offset: result.nextOffset, hasMore: result.hasMore };
      } catch (err) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, domain: "jobRequisitions", err },
          "jobRequisitions domain error; continuing",
        );
      }

      // TODO(Task 15): RaaS reports
      for (const _report of workdayConfig.reports) {
        // Task 15 fills this walk
      }

      const nextCursor = buildNextCursor(
        domainState.worker.offset,
        domainState.timeOff.offset,
        domainState.jobPosting.offset,
      );

      return {
        ...syncPassCursorSuccess(t0, totalBytes, nextCursor, totalUpserted),
        hasMore:
          domainState.worker.hasMore ||
          domainState.timeOff.hasMore ||
          domainState.jobPosting.hasMore,
      };
    },
  };
}
