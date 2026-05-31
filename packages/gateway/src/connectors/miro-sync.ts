import { getValidMiroAccessToken } from "../auth/miro-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapMiroBoardToItem } from "./miro-board-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "miro";
const CURSOR_PREFIX = "nimbus-miro1:";
const BASE = "https://api.miro.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

type MiroCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MiroCursorV1);
}

export type MiroSyncableOptions = {
  ensureMiroMcpRunning: () => Promise<void>;
};

function boardsPath(cursor: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== "") {
    params.set("cursor", cursor);
  }
  return `/v2/boards?${params.toString()}`;
}

function miroGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractBoards(parsed: unknown): unknown[] {
  const data = asRecord(parsed)?.["data"];
  return Array.isArray(data) ? data : [];
}

/** Miro's cursor: the top-level `cursor` field is the opaque token for the next page (absent at the end). */
function nextCursor(parsed: unknown): string {
  const cursor = asRecord(parsed)?.["cursor"];
  return typeof cursor === "string" && cursor !== "" ? cursor : "";
}

function upsertBoards(ctx: SyncContext, boards: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const b of boards) {
    const mapped = mapMiroBoardToItem(b, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createMiroSyncable(options: MiroSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMiroMcpRunning();

      const raw = await readConnectorSecret(ctx.vault, "miro", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await getValidMiroAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      // Cursor pagination: the top-level `cursor` field is the opaque token to
      // the next page (or absent at the end). Walk a single forward pass per
      // cycle, page-capped.
      let pageCursor = "";
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await miroGet(ctx, token, boardsPath(pageCursor));
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
        const boards = extractBoards(outcome.parsed);
        totalUpserted += upsertBoards(ctx, boards, now);
        pageCursor = nextCursor(outcome.parsed);
        if (boards.length === 0 || pageCursor === "") {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
