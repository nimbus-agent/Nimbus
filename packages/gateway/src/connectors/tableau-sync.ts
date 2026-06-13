import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapTableauViewToItem } from "./tableau-dashboard-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "tableau";
const CURSOR_PREFIX = "nimbus-tableau1:";

/**
 * Guard against flag-smuggling via the Tableau base URL before it is used
 * in fetch calls. Mirrors isSafeSnowflakeAccount for URL-style credentials.
 * The URL must parse successfully and have a non-empty hostname.
 */
function isSafeTableauUrl(value: string): boolean {
  if (value === "") return false;
  try {
    const u = new URL(value);
    return u.hostname !== "";
  } catch {
    return false;
  }
}

type TableauCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies TableauCursorV1);
}

export type TableauSyncableOptions = {
  ensureTableauMcpRunning: () => Promise<void>;
};

interface TableauCreds {
  readonly url: string;
  readonly patName: string;
  readonly patSecret: string;
}

async function loadCreds(ctx: SyncContext): Promise<TableauCreds | null> {
  const url = (await readConnectorSecret(ctx.vault, "tableau", "url"))?.trim() ?? "";
  const patName = (await readConnectorSecret(ctx.vault, "tableau", "pat_name"))?.trim() ?? "";
  const patSecret = (await readConnectorSecret(ctx.vault, "tableau", "pat_secret"))?.trim() ?? "";
  if (url === "" || patName === "" || patSecret === "" || !isSafeTableauUrl(url)) return null;
  return { url, patName, patSecret };
}

interface SigninResult {
  token: string;
  siteId: string;
}

function parseSigninResponse(parsed: unknown): SigninResult | null {
  const root = asRecord(parsed);
  const creds = asRecord(root?.["credentials"]);
  if (creds === undefined) return null;
  const token = stringField(creds, "token");
  const site = asRecord(creds["site"]);
  const siteId = site === undefined ? undefined : stringField(site, "id");
  if (token === undefined || siteId === undefined) return null;
  return { token, siteId };
}

function viewsFromResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const views = asRecord(root?.["views"]);
  const viewArr = Array.isArray(views?.["view"]) ? views["view"] : [];
  const out: Record<string, unknown>[] = [];
  for (const v of viewArr) {
    const r = asRecord(v);
    if (r === undefined) continue;
    // Extract name: prefer the view name, fall back to workbook name
    const name = stringField(r, "name") ?? "";
    const workbook = asRecord(r["workbook"]);
    const workbookName = workbook === undefined ? "" : (stringField(workbook, "name") ?? "");
    const displayName = name === "" ? workbookName : name;
    const owner = asRecord(r["owner"]);
    const author = owner === undefined ? null : (stringField(owner, "name") ?? null);
    // dataSourceTables is best-effort; Tableau REST API v3.4 views endpoint
    // does not return upstream table info — emit empty array. The edge is
    // exercised at the mapper + graph level via explicit test fixtures.
    out.push({
      luid: stringField(r, "luid") ?? "",
      name: displayName,
      author,
      folder: null,
      extractRefreshStatus: null,
      dataSourceTables: [] as string[],
    });
  }
  return out;
}

export function createTableauSyncable(options: TableauSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureTableauMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      // Step 1: sign in to get an auth token + site id
      const signinUrl = `${creds.url}/api/3.4/auth/signin`;
      const signinOutcome = await connectorFetch(ctx, SERVICE_ID, signinUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          credentials: {
            personalAccessTokenName: creds.patName,
            personalAccessTokenSecret: creds.patSecret,
            site: { contentUrl: "" },
          },
        }),
      });
      if (signinOutcome.kind !== "ok") {
        return signinOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, signinOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, signinOutcome.bytes, pass1Cursor());
      }
      const signin = parseSigninResponse(signinOutcome.parsed);
      if (signin === null) {
        return syncPassCursorParseEmpty(t0, signinOutcome.bytes, pass1Cursor());
      }

      // Step 2: list views for the site
      const viewsUrl = `${creds.url}/api/3.4/sites/${signin.siteId}/views`;
      const viewsOutcome = await connectorFetch(ctx, SERVICE_ID, viewsUrl, {
        headers: { "X-Tableau-Auth": signin.token, Accept: "application/json" },
      });
      if (viewsOutcome.kind !== "ok") {
        return viewsOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, viewsOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, viewsOutcome.bytes, pass1Cursor());
      }
      const now = Date.now();
      let upserted = 0;
      for (const rawView of viewsFromResponse(viewsOutcome.parsed)) {
        const mapped = mapTableauViewToItem(rawView, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return syncPassCursorSuccess(t0, viewsOutcome.bytes, pass1Cursor(), upserted);
    },
  };
}
