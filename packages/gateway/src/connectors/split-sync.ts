import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSplitToItem } from "./split-flag-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "split";
const CURSOR_PREFIX = "nimbus-split1:";
/** Split's Admin API: SaaS only, the same fixed host the connector uses (no override). */
const API_BASE = "https://api.split.io/internal/api/v2";
/** Split's own page cap for the split list. */
const PAGE_SIZE = 50;
/** Pages per workspace (1,000 splits, the connector's search bound) and workspaces per pass. */
export const SPLIT_MAX_PAGES_PER_WORKSPACE = 20;
export const SPLIT_MAX_WORKSPACES = 50;

type SplitCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies SplitCursorV1);
}

export type SplitSyncableOptions = {
  ensureSplitMcpRunning: () => Promise<void>;
};

function splitGet(ctx: SyncContext, apiKey: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
}

interface SplitWorkspace {
  readonly id: string;
  readonly name: string;
}

function objectsOf(parsed: unknown): unknown[] {
  const list = asRecord(parsed)?.["objects"];
  return Array.isArray(list) ? list : [];
}

function extractWorkspaces(parsed: unknown): SplitWorkspace[] {
  const out: SplitWorkspace[] = [];
  for (const w of objectsOf(parsed)) {
    const row = asRecord(w);
    const id = row === undefined ? undefined : stringField(row, "id");
    if (row === undefined || id === undefined || id === "") continue;
    out.push({ id, name: stringField(row, "name") ?? id });
    if (out.length === SPLIT_MAX_WORKSPACES) break;
  }
  return out;
}

function splitsPath(workspaceId: string, page: number): string {
  const params = new URLSearchParams({
    offset: String(page * PAGE_SIZE),
    limit: String(PAGE_SIZE),
  });
  return `/splits/ws/${encodeURIComponent(workspaceId)}?${params.toString()}`;
}

async function syncWorkspace(
  ctx: SyncContext,
  apiKey: string,
  ws: SplitWorkspace,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  let upserted = 0;
  let bytes = 0;
  let seen = 0;
  for (let page = 0; page < SPLIT_MAX_PAGES_PER_WORKSPACE; page += 1) {
    const outcome = await splitGet(ctx, apiKey, splitsPath(ws.id, page)); // NOSONAR S9382: page by page through the shared Split rate limiter, until a short page or the total
    bytes += outcome.bytes;
    if (outcome.kind !== "ok") break;
    const objects = objectsOf(outcome.parsed);
    seen += objects.length;
    upserted += upsertMapped(ctx, objects, (s) =>
      mapSplitToItem(s, { workspaceId: ws.id, workspaceName: ws.name, syncedAt: now }),
    );
    const root = asRecord(outcome.parsed);
    const total = root === undefined ? undefined : numberField(root, "totalCount");
    if (objects.length < PAGE_SIZE || (total !== undefined && seen >= total)) break;
  }
  return { upserted, bytes };
}

export function createSplitSyncable(options: SplitSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSplitMcpRunning();
      const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
      if (apiKey === "") return syncNoopResult(cursor, t0);

      const workspaces = await splitGet(ctx, apiKey, "/workspaces");
      let totalBytes = workspaces.bytes;
      if (workspaces.kind !== "ok") {
        return workspaces.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const ws of extractWorkspaces(workspaces.parsed)) {
        const result = await syncWorkspace(ctx, apiKey, ws, now); // NOSONAR S9382: one workspace at a time through the shared Split rate limiter; the list is capped at SPLIT_MAX_WORKSPACES
        totalUpserted += result.upserted;
        totalBytes += result.bytes;
      }
      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
