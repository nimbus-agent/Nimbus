import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapDbtJobToItem } from "./dbt-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField } from "./unknown-record.ts";

const SERVICE_ID = "dbt";
const CURSOR_PREFIX = "nimbus-dbt1:";
const DEFAULT_API_BASE = "https://cloud.getdbt.com";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_ACCOUNT = 20;

type DbtCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DbtCursorV1);
}

export type DbtSyncableOptions = {
  ensureDbtMcpRunning: () => Promise<void>;
};

interface DbtCreds {
  readonly token: string;
  readonly apiBase: string;
  readonly accountId: number | null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<DbtCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const baseRaw = (await ctx.getSecret("api_base"))?.trim() ?? "";
  const accountRaw = (await ctx.getSecret("account_id"))?.trim() ?? "";
  const parsedAccount = accountRaw === "" ? Number.NaN : Number.parseInt(accountRaw, 10);
  return {
    token,
    apiBase: baseRaw === "" ? DEFAULT_API_BASE : trimTrailingSlash(baseRaw),
    accountId: Number.isFinite(parsedAccount) ? parsedAccount : null,
  };
}

function dbtGet(ctx: SyncContext, creds: DbtCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.apiBase}/api/v2${path}`, {
    headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" },
  });
}

function extractData(parsed: unknown): unknown[] {
  const data = asRecord(parsed)?.["data"];
  if (Array.isArray(data)) {
    return data;
  }
  return Array.isArray(parsed) ? parsed : [];
}

function extractAccountIds(parsed: unknown): number[] {
  const out: number[] = [];
  for (const a of extractData(parsed)) {
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

function upsertJobs(
  ctx: SyncContext,
  creds: DbtCreds,
  accountId: number,
  jobs: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const j of jobs) {
    const mapped = mapDbtJobToItem(j, { apiBase: creds.apiBase, accountId, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
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
    const jobs = extractData(outcome.parsed);
    upserted += upsertJobs(ctx, creds, accountId, jobs, now);
    if (jobs.length < PAGE_SIZE) {
      break;
    }
  }
  return { upserted, bytes };
}

export function createDbtSyncable(options: DbtSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDbtMcpRunning();
      const creds = await loadCreds(ctx);
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
        const result = await syncAccountJobs(ctx, creds, accountId, now);
        totalUpserted += result.upserted;
        totalBytes += result.bytes;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
