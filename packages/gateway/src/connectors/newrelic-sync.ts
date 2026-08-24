import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  clampSyncTitle,
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "newrelic";
const CURSOR_PREFIX = "nimbus-nr1:";

type NrCursorV1 = { pass: number };

function encodeCursor(c: NrCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type NewrelicSyncableOptions = {
  ensureNewrelicMcpRunning: () => Promise<void>;
};

export function createNewrelicSyncable(options: NewrelicSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureNewrelicMcpRunning();
      const key = (await ctx.getSecret("api_key"))?.trim() ?? "";
      if (key === "") {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("newrelic");
      const res = await fetch("https://api.newrelic.com/v2/applications.json", {
        headers: { "X-Api-Key": key, Accept: "application/json" },
      });
      const text = await res.text();
      if (!res.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, status: res.status },
          "newrelic sync: apps failed",
        );
        return syncPassCursorHttpEmpty(t0, text.length, cursor, pass1Cursor());
      }
      let root: unknown;
      try {
        root = JSON.parse(text) as unknown;
      } catch {
        return syncPassCursorParseEmpty(t0, text.length, pass1Cursor());
      }
      const rec = asRecord(root);
      const appsRaw = rec?.["applications"];
      const appList = Array.isArray(appsRaw) ? appsRaw : [];
      const now = Date.now();
      let upserted = 0;
      for (const item of appList) {
        const row = asRecord(item);
        if (row === undefined) {
          continue;
        }
        const id = stringField(row, "id");
        const name = stringField(row, "name");
        const ext = id !== undefined && id !== "" ? `app:${id}` : (name ?? "");
        if (ext === "") {
          continue;
        }
        const title = name ?? ext;
        upsertIndexedItemForSync(ctx, {
          service: SERVICE_ID,
          type: "application",
          externalId: ext,
          title: clampSyncTitle(title),
          bodyPreview: id ?? "",
          url: null,
          canonicalUrl: null,
          modifiedAt: now,
          authorId: null,
          metadata: { id: id ?? null, name: name ?? null },
          pinned: false,
          syncedAt: now,
        });
        upserted += 1;
      }

      return syncPassCursorSuccess(t0, text.length, pass1Cursor(), upserted);
    },
  };
}
