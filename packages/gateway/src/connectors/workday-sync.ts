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
  mapReportRowToItem,
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

function sameTenantHost(reportUrl: string, tenantHost: string): boolean {
  try {
    return new URL(reportUrl).host === new URL(tenantHost).host;
  } catch {
    return false;
  }
}

function reportRowsFrom(root: unknown): unknown[] {
  // Workday RaaS JSON wraps rows under "Report_Entry"; fall back to a bare array.
  const entry = (root as { Report_Entry?: unknown })?.Report_Entry;
  if (Array.isArray(entry)) return entry;
  return Array.isArray(root) ? root : [];
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

interface WalkDomainArgs {
  ctx: SyncContext;
  baseUrl: string;
  token: string;
  fetchFn: FetchFn;
  startOffset: number;
  mapper: (raw: unknown, mapCtx: WorkdayMapContext) => ReturnType<typeof mapWorkerToItem>;
  mapCtx: WorkdayMapContext;
  extraParams?: Record<string, string>;
}

type DomainResult = { upserted: number; totalBytes: number; nextOffset: number; hasMore: boolean };

async function walkDomain(args: WalkDomainArgs): Promise<DomainResult> {
  const { ctx, baseUrl, token, fetchFn, startOffset, mapper, mapCtx, extraParams } = args;
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

// Walk a single Workday domain, logging+swallowing its errors so one domain's failure does not
// abort the others (returns null on failure). Keeps `sync` flat (cognitive complexity).
async function runDomain(args: WalkDomainArgs, domain: string): Promise<DomainResult | null> {
  try {
    return await walkDomain(args);
  } catch (err) {
    args.ctx.logger.warn(
      { serviceId: SERVICE_ID, domain, err },
      `${domain} domain error; continuing`,
    );
    return null;
  }
}

export type WorkdaySyncableOptions = {
  ensureWorkdayMcpRunning: () => Promise<void>;
  loadWorkdayConfig?: () => NimbusWorkdayToml;
  fetchFn?: FetchFn;
  loadAccessToken?: (vault: SyncContext["vault"]) => Promise<string>;
  /** Override the tenant host used for same-host egress enforcement (tests only). */
  tenantHost?: string;
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
          options.loadAccessToken === undefined
            ? await getValidWorkdayAccessToken(ctx.vault)
            : await options.loadAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }

      const loadConfig = options.loadWorkdayConfig ?? (() => DEFAULT_NIMBUS_WORKDAY_TOML);
      const workdayConfig = loadConfig();
      const fetchFn: FetchFn = options.fetchFn ?? (globalThis.fetch as FetchFn);

      const prev = decodeCursor(cursor);
      const effectiveTenantHost = options.tenantHost ?? Config.workdayTenantHost;
      const base = restBase(effectiveTenantHost, Config.workdayTenant);
      const mapCtx: WorkdayMapContext = {
        syncedAt: Date.now(),
        tenantHost: effectiveTenantHost,
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
      const worker = await runDomain(
        {
          ctx,
          baseUrl: `${base}/workers`,
          token: accessToken,
          fetchFn,
          startOffset: domainState.worker.offset,
          mapper: mapWorkerToItem,
          mapCtx,
        },
        "workers",
      );
      if (worker !== null) {
        totalUpserted += worker.upserted;
        totalBytes += worker.totalBytes;
        domainState.worker = { offset: worker.nextOffset, hasMore: worker.hasMore };
      }

      // Domain 2: /timeOff (bounded by timeOffHistoryDays)
      const timeOff = await runDomain(
        {
          ctx,
          baseUrl: `${base}/timeOff`,
          token: accessToken,
          fetchFn,
          startOffset: domainState.timeOff.offset,
          mapper: mapTimeOffToItem,
          mapCtx,
          extraParams: { from: daysAgoIso(workdayConfig.timeOffHistoryDays) },
        },
        "timeOff",
      );
      if (timeOff !== null) {
        totalUpserted += timeOff.upserted;
        totalBytes += timeOff.totalBytes;
        domainState.timeOff = { offset: timeOff.nextOffset, hasMore: timeOff.hasMore };
      }

      // Domain 3: /jobRequisitions
      const jobPosting = await runDomain(
        {
          ctx,
          baseUrl: `${base}/jobRequisitions`,
          token: accessToken,
          fetchFn,
          startOffset: domainState.jobPosting.offset,
          mapper: mapJobPostingToItem,
          mapCtx,
        },
        "jobRequisitions",
      );
      if (jobPosting !== null) {
        totalUpserted += jobPosting.upserted;
        totalBytes += jobPosting.totalBytes;
        domainState.jobPosting = { offset: jobPosting.nextOffset, hasMore: jobPosting.hasMore };
      }

      // RaaS reports: one fetch per report URL, same-host egress enforcement
      for (const report of workdayConfig.reports) {
        if (!sameTenantHost(report.url, effectiveTenantHost)) {
          ctx.logger.warn(
            { serviceId: SERVICE_ID, reportLabel: report.label, url: report.url },
            "workday report url host does not match tenant host; skipping",
          );
          continue;
        }
        try {
          await ctx.rateLimiter.acquire(SERVICE_ID);
          const res = await fetchFn(report.url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const text = await res.text();
          totalBytes += text.length;
          if (!res.ok) {
            ctx.logger.warn(
              { serviceId: SERVICE_ID, reportLabel: report.label, status: res.status },
              "workday report fetch failed; skipping",
            );
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            ctx.logger.warn(
              { serviceId: SERVICE_ID, reportLabel: report.label },
              "workday report response is not valid JSON; skipping",
            );
            continue;
          }
          for (const row of reportRowsFrom(parsed)) {
            const mapped = mapReportRowToItem(row, report, mapCtx);
            if (mapped !== null) {
              upsertIndexedItemForSync(ctx, mapped);
              totalUpserted += 1;
            }
          }
        } catch (err) {
          ctx.logger.warn(
            { serviceId: SERVICE_ID, reportLabel: report.label, err },
            "workday report fetch error; skipping",
          );
        }
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
