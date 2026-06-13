import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapBigeyeIssueToItem } from "./bigeye-dq-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "bigeye";
const CURSOR_PREFIX = "nimbus-bigeye1:";

/**
 * Guard against flag-smuggling via the Bigeye base URL before it is used in
 * fetch calls. The URL must parse successfully and have a non-empty hostname.
 * Mirrors isSafeLookerUrl in looker-sync.ts.
 */
function isSafeBigeyeUrl(value: string): boolean {
  if (value === "") return false;
  try {
    const u = new URL(value);
    return u.hostname !== "";
  } catch {
    return false;
  }
}

type BigeyeCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies BigeyeCursorV1);
}

export type BigeyeSyncableOptions = {
  ensureBigeyeMcpRunning: () => Promise<void>;
};

interface BigeyeCreds {
  readonly baseUrl: string;
  readonly apiKey: string;
}

async function loadCreds(ctx: SyncContext): Promise<BigeyeCreds | null> {
  const baseUrl = (await readConnectorSecret(ctx.vault, "bigeye", "base_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(ctx.vault, "bigeye", "api_key"))?.trim() ?? "";
  if (baseUrl === "" || apiKey === "" || !isSafeBigeyeUrl(baseUrl)) {
    return null;
  }
  return { baseUrl, apiKey };
}

function issuesFromResponse(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of parsed) {
    const r = asRecord(item);
    if (r !== undefined) out.push(r);
  }
  return out;
}

export function createBigeyeSyncable(options: BigeyeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureBigeyeMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      const url = `${creds.baseUrl}/api/v1/issues`;
      const outcome = await connectorFetch(ctx, SERVICE_ID, url, {
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          Accept: "application/json",
        },
      });

      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;
      for (const rawIssue of issuesFromResponse(outcome.parsed)) {
        const mapped = mapBigeyeIssueToItem(rawIssue, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
