import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { awsCliJson, awsCredentialsExtra } from "./_lib/aws-cli.ts";
import { mapAthenaTableToItem } from "./athena-table-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "athena";
const CURSOR_PREFIX = "nimbus-athena1:";

// Page caps — single forward pass per cycle (mirrors BigQuery's caps).
const MAX_CATALOGS = 50;
const MAX_DATABASES_PER_CATALOG = 200;
const MAX_TABLES_PER_DATABASE = 500;
const PAGE_SIZE = 50;

type AthenaCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies AthenaCursorV1);
}

/** Injectable AWS-CLI runner — defaults to the shared `awsCliJson` spawn; tests pass a stub. */
export type RunAwsCli = (
  ctx: SyncContext,
  args: string[],
) => Promise<{ ok: boolean; text: string }>;

export type AthenaSyncableOptions = {
  ensureAthenaMcpRunning: () => Promise<void>;
  /** Override the AWS-CLI runner (dependency injection for tests). */
  runAwsCli?: RunAwsCli;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function nextToken(parsed: unknown): string | null {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return null;
  }
  const tok = stringField(rec, "NextToken");
  return tok !== undefined && tok !== "" ? tok : null;
}

function extractArray(parsed: unknown, key: string): unknown[] {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return [];
  }
  const arr = rec[key];
  return Array.isArray(arr) ? arr : [];
}

function catalogNameOf(entry: unknown): string | null {
  const rec = asRecord(entry);
  if (rec === undefined) {
    return null;
  }
  const name = stringField(rec, "CatalogName");
  return name !== undefined && name !== "" ? name : null;
}

function databaseNameOf(entry: unknown): string | null {
  const rec = asRecord(entry);
  if (rec === undefined) {
    return null;
  }
  const name = stringField(rec, "Name");
  return name !== undefined && name !== "" ? name : null;
}

interface ListResult {
  readonly items: string[];
  readonly bytes: number;
  readonly firstPageFailed: boolean;
}

/** Append the ids on a single result page into `items`, respecting `cap`. */
function collectPageIds(
  parsed: unknown,
  resultKey: string,
  idOf: (entry: unknown) => string | null,
  cap: number,
  items: string[],
): void {
  for (const entry of extractArray(parsed, resultKey)) {
    if (items.length >= cap) {
      return;
    }
    const id = idOf(entry);
    if (id !== null) {
      items.push(id);
    }
  }
}

/** Walk a paginated `aws athena list-*` command, collecting one string id per entry. */
async function collectPaged(
  run: RunAwsCli,
  ctx: SyncContext,
  baseArgs: string[],
  resultKey: string,
  idOf: (entry: unknown) => string | null,
  cap: number,
): Promise<ListResult> {
  const items: string[] = [];
  let bytes = 0;
  let token: string | null = null;
  let page = 0;
  while (items.length < cap) {
    const args = [...baseArgs, "--max-results", String(PAGE_SIZE)];
    if (token !== null && token !== "") {
      args.push("--next-token", token);
    }
    const res = await run(ctx, args);
    bytes += res.text.length;
    if (!res.ok) {
      if (page === 0) {
        return { items, bytes, firstPageFailed: true };
      }
      break;
    }
    const parsed = parseJson(res.text);
    collectPageIds(parsed, resultKey, idOf, cap, items);
    token = nextToken(parsed);
    page += 1;
    if (token === null) {
      break;
    }
  }
  return { items, bytes, firstPageFailed: false };
}

interface WalkResult {
  readonly upserted: number;
  readonly bytes: number;
}

interface PageUpsert {
  readonly upserted: number;
  readonly seen: number;
}

/** Upsert a single `TableMetadataList` page, capped at `MAX_TABLES_PER_DATABASE`. */
function upsertTablePage(
  ctx: SyncContext,
  parsed: unknown,
  catalog: string,
  database: string,
  now: number,
  seenSoFar: number,
): PageUpsert {
  let upserted = 0;
  let seen = seenSoFar;
  for (const entry of extractArray(parsed, "TableMetadataList")) {
    if (seen >= MAX_TABLES_PER_DATABASE) {
      break;
    }
    seen += 1;
    const mapped = mapAthenaTableToItem(entry, { catalog, database, syncedAt: now });
    if (mapped !== null) {
      ctx.upsertItem(mapped);
      upserted += 1;
    }
  }
  return { upserted, seen };
}

async function walkDatabaseTables(
  run: RunAwsCli,
  ctx: SyncContext,
  catalog: string,
  database: string,
  now: number,
): Promise<WalkResult> {
  let upserted = 0;
  let bytes = 0;
  let token: string | null = null;
  let seen = 0;

  while (seen < MAX_TABLES_PER_DATABASE) {
    const args = [
      "athena",
      "list-table-metadata",
      "--catalog-name",
      catalog,
      "--database-name",
      database,
      "--max-results",
      String(PAGE_SIZE),
    ];
    if (token !== null && token !== "") {
      args.push("--next-token", token);
    }
    const res = await run(ctx, args);
    bytes += res.text.length;
    if (!res.ok) {
      break;
    }
    const parsed = parseJson(res.text);
    const page = upsertTablePage(ctx, parsed, catalog, database, now, seen);
    upserted += page.upserted;
    seen = page.seen;
    token = nextToken(parsed);
    if (token === null) {
      break;
    }
  }
  return { upserted, bytes };
}

export function createAthenaSyncable(options: AthenaSyncableOptions): Syncable {
  const run = options.runAwsCli ?? awsCliJson;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureAthenaMcpRunning();

      // Athena (Tier-3, metadata-only) reuses the existing AWS credentials.
      const extra = await awsCredentialsExtra(ctx);
      if (extra === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      const catalogs = await collectPaged(
        run,
        ctx,
        ["athena", "list-data-catalogs"],
        "DataCatalogsSummary",
        catalogNameOf,
        MAX_CATALOGS,
      );
      let totalBytes = catalogs.bytes;
      if (catalogs.firstPageFailed) {
        // Graceful empty pass — no throw past the Syncable boundary.
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      let totalUpserted = 0;
      for (const catalog of catalogs.items) {
        const databases = await collectPaged(
          run,
          ctx,
          ["athena", "list-databases", "--catalog-name", catalog],
          "DatabaseList",
          databaseNameOf,
          MAX_DATABASES_PER_CATALOG,
        );
        totalBytes += databases.bytes;
        for (const database of databases.items) {
          const res = await walkDatabaseTables(run, ctx, catalog, database, now);
          totalUpserted += res.upserted;
          totalBytes += res.bytes;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
