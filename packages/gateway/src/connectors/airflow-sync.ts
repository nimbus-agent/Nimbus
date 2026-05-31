import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapAirflowDagToItem } from "./airflow-dag-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "airflow";
const CURSOR_PREFIX = "nimbus-airflow1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type AirflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies AirflowCursorV1);
}

export type AirflowSyncableOptions = {
  ensureAirflowMcpRunning: () => Promise<void>;
};

interface AirflowCreds {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<AirflowCreds | null> {
  const baseUrl = (await readConnectorSecret(ctx.vault, "airflow", "base_url"))?.trim() ?? "";
  const username = (await readConnectorSecret(ctx.vault, "airflow", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(ctx.vault, "airflow", "password"))?.trim() ?? "";
  if (baseUrl === "" || username === "" || password === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), username, password };
}

// The gateway cannot import the mcp-shared encodeBasicAuthHeader (cross-package
// boundary), so build the HTTP Basic header inline — same pattern as
// bitbucket-sync / jenkins-sync.
function basicAuthHeader(user: string, pass: string): string {
  const b64 = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function dagsPath(offset: number): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `/api/v1/dags?${params.toString()}`;
}

function airflowGet(ctx: SyncContext, creds: AirflowCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}${path}`, {
    headers: {
      Authorization: basicAuthHeader(creds.username, creds.password),
      Accept: "application/json",
    },
  });
}

function extractDags(parsed: unknown): unknown[] {
  const dags = (parsed as { dags?: unknown } | null)?.dags;
  return Array.isArray(dags) ? dags : [];
}

function extractTotalEntries(parsed: unknown): number {
  const total = (parsed as { total_entries?: unknown } | null)?.total_entries;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function upsertDags(
  ctx: SyncContext,
  creds: AirflowCreds,
  dags: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const d of dags) {
    const mapped = mapAirflowDagToItem(d, { baseUrl: creds.baseUrl, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createAirflowSyncable(options: AirflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureAirflowMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // Airflow's /api/v1/dags paginates by limit/offset with a total_entries
      // count in the body; walk a single forward offset pass per cycle,
      // stopping when offset >= total_entries, a short page, or the page cap.
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const offset = page * PAGE_SIZE;
        const outcome = await airflowGet(ctx, creds, dagsPath(offset));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const dags = extractDags(outcome.parsed);
        totalUpserted += upsertDags(ctx, creds, dags, now);

        const total = extractTotalEntries(outcome.parsed);
        if (dags.length < PAGE_SIZE || offset + dags.length >= total) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
