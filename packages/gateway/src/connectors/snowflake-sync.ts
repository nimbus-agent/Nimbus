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
import { mapSnowflakeTableToItem } from "./snowflake-data-model-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "snowflake";
const CURSOR_PREFIX = "nimbus-snowflake1:";

/**
 * Guard against flag-smuggling via the account identifier before it is
 * interpolated into the fetch URL (`${account}.snowflakecomputing.com`).
 * Mirrors the identical check in phase3-config.ts's isSafeSnowflakeAccount.
 */
function isSafeSnowflakeAccount(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
      return false;
    }
  }
  return true;
}

type SnowflakeCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies SnowflakeCursorV1);
}

export type SnowflakeSyncableOptions = {
  ensureSnowflakeMcpRunning: () => Promise<void>;
};

interface SnowflakeCreds {
  readonly account: string;
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<SnowflakeCreds | null> {
  const account = (await readConnectorSecret(ctx.vault, "snowflake", "account"))?.trim() ?? "";
  const token =
    (await readConnectorSecret(ctx.vault, "snowflake", "oauth_token"))?.trim() ??
    (await readConnectorSecret(ctx.vault, "snowflake", "key_pair_jwt"))?.trim() ??
    "";
  if (account === "" || token === "" || !isSafeSnowflakeAccount(account)) return null;
  return { account, token };
}

function rowsFromStatementsResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const meta = asRecord(root?.["resultSetMetaData"]);
  const rowType = Array.isArray(meta?.["rowType"]) ? meta["rowType"] : [];
  const names = rowType.map(
    (c) => (asRecord(c)?.["name"] as string | undefined)?.toLowerCase() ?? "",
  );
  const data = Array.isArray(root?.["data"]) ? root["data"] : [];
  const out: Record<string, unknown>[] = [];
  for (const rr of data) {
    if (!Array.isArray(rr)) continue;
    const obj: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (name !== "") obj[name] = rr[i];
    });
    if (typeof obj["row_count"] === "string" && obj["row_count"] !== "") {
      obj["row_count"] = Number(obj["row_count"]);
    }
    out.push(obj);
  }
  return out;
}

const TABLES_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "row_count, last_altered FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'";

export function createSnowflakeSyncable(options: SnowflakeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSnowflakeMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);
      const url = `https://${creds.account}.snowflakecomputing.com/api/v2/statements`;
      const outcome = await connectorFetch(ctx, SERVICE_ID, url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ statement: TABLES_SQL, timeout: 60 }),
      });
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }
      const now = Date.now();
      let upserted = 0;
      for (const rawRow of rowsFromStatementsResponse(outcome.parsed)) {
        const mapped = mapSnowflakeTableToItem(rawRow, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
