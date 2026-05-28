import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapMlflowModelToItem } from "./mlflow-model-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "mlflow";
const CURSOR_PREFIX = "nimbus-mlflow1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type MlflowCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MlflowCursorV1);
}

export type MlflowSyncableOptions = {
  ensureMlflowMcpRunning: () => Promise<void>;
};

interface MlflowCreds {
  readonly host: string;
  readonly token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<MlflowCreds | null> {
  const host = (await readConnectorSecret(ctx.vault, "mlflow", "host"))?.trim() ?? "";
  const token = (await readConnectorSecret(ctx.vault, "mlflow", "token"))?.trim() ?? "";
  if (host === "" || token === "") {
    return null;
  }
  return { host: trimTrailingSlash(host), token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function mlflowGet(
  ctx: SyncContext,
  creds: MlflowCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${creds.host}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "mlflow GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractArray(parsed: unknown, key: string): unknown[] {
  const v = asRecord(parsed)?.[key];
  return Array.isArray(v) ? v : [];
}

function upsertModels(
  ctx: SyncContext,
  creds: MlflowCreds,
  models: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const m of models) {
    const mapped = mapMlflowModelToItem(m, { host: creds.host, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

function searchPath(pageToken: string | null): string {
  const params = new URLSearchParams({ max_results: String(PAGE_SIZE) });
  if (pageToken !== null) {
    params.set("page_token", pageToken);
  }
  return `/api/2.0/mlflow/registered-models/search?${params.toString()}`;
}

export function createMlflowSyncable(options: MlflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMlflowMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let pageToken: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await mlflowGet(ctx, creds, searchPath(pageToken));
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
        totalUpserted += upsertModels(
          ctx,
          creds,
          extractArray(outcome.parsed, "registered_models"),
          now,
        );

        const nextToken = stringField(envelope, "next_page_token") ?? "";
        if (nextToken === "") {
          break;
        }
        pageToken = nextToken;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
