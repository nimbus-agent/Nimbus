import { getValidCanvaAccessToken } from "../auth/canva-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { mapCanvaDesignToItem } from "./canva-design-mapping.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "canva";
const CURSOR_PREFIX = "nimbus-canva1:";
const BASE = "https://api.canva.com";
const MAX_PAGES = 20;

type CanvaCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies CanvaCursorV1);
}

export type CanvaSyncableOptions = {
  ensureCanvaMcpRunning: () => Promise<void>;
};

function designsPath(continuation: string): string {
  const params = new URLSearchParams();
  if (continuation !== "") {
    params.set("continuation", continuation);
  }
  const qs = params.toString();
  return `/rest/v1/designs${qs === "" ? "" : `?${qs}`}`;
}

function canvaGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractDesigns(parsed: unknown): unknown[] {
  const items = asRecord(parsed)?.["items"];
  return Array.isArray(items) ? items : [];
}

/** Canva's cursor: the top-level `continuation` field is the opaque token for the next page (absent at the end). */
function nextContinuation(parsed: unknown): string {
  const c = asRecord(parsed)?.["continuation"];
  return typeof c === "string" && c !== "" ? c : "";
}

function upsertDesigns(ctx: SyncContext, designs: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const d of designs) {
    const mapped = mapCanvaDesignToItem(d, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createCanvaSyncable(options: CanvaSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureCanvaMcpRunning();

      const raw = await readConnectorSecret(ctx.vault, "canva", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await getValidCanvaAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      // Continuation pagination: the top-level `continuation` field is the
      // opaque token to the next page (or absent at the end). Walk a single
      // forward pass per cycle, page-capped.
      let continuation = "";
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await canvaGet(ctx, token, designsPath(continuation));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          // Mid-walk error: keep what we already upserted, stop without throwing.
          break;
        }
        const designs = extractDesigns(outcome.parsed);
        totalUpserted += upsertDesigns(ctx, designs, now);
        continuation = nextContinuation(outcome.parsed);
        if (designs.length === 0 || continuation === "") {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
