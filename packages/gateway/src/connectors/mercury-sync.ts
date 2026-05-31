import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapMercuryAccountToItem } from "./mercury-account-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "mercury";
const CURSOR_PREFIX = "nimbus-mercury1:";
const BASE = "https://api.mercury.com";

type MercuryCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MercuryCursorV1);
}

export type MercurySyncableOptions = {
  ensureMercuryMcpRunning: () => Promise<void>;
};

interface MercuryCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<MercuryCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "mercury", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function extractAccounts(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  if (root === undefined) {
    return [];
  }
  const accounts = root["accounts"];
  return Array.isArray(accounts) ? accounts : [];
}

function upsertAccounts(ctx: SyncContext, accounts: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const acct of accounts) {
    const mapped = mapMercuryAccountToItem(acct, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createMercurySyncable(options: MercurySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMercuryMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();

      const outcome = await connectorFetch(ctx, SERVICE_ID, `${BASE}/api/v1/accounts`, {
        headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
      });
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const accounts = extractAccounts(outcome.parsed);
      const upserted = upsertAccounts(ctx, accounts, now);

      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
