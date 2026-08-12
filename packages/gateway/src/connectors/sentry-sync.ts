import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { syncSentryIssuePass } from "./sentry-issue-sync.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "sentry";
const CURSOR_PREFIX = "nimbus-sentry2:";

type SentryCursorV2 = { lastSeenMs: number };

function encodeCursor(c: SentryCursorV2): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

/**
 * `null` on a prefix miss — which is what makes a persisted legacy
 * `nimbus-sentry1:` cursor (payload `{pass}`) a cold start rather than a
 * special-cased legacy branch: it simply fails to decode.
 */
function decodeCursor(raw: string | null): SentryCursorV2 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const lastSeenMs = rec["lastSeenMs"];
  if (typeof lastSeenMs !== "number" || !Number.isFinite(lastSeenMs)) {
    return null;
  }
  return { lastSeenMs };
}

export type SentrySyncableOptions = {
  ensureSentryMcpRunning: () => Promise<void>;
  maxPagesPerSync?: number;
};

export function createSentrySyncable(options: SentrySyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  const maxPagesPerSync = Math.max(1, Math.min(100, options.maxPagesPerSync ?? 20));
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSentryMcpRunning();
      const token = (await readConnectorSecret(ctx.vault, "sentry", "auth_token"))?.trim() ?? "";
      const org = (await readConnectorSecret(ctx.vault, "sentry", "org_slug"))?.trim() ?? "";
      if (token === "" || org === "") {
        return syncNoopResult(cursor, t0);
      }
      const baseRaw = await readConnectorSecret(ctx.vault, "sentry", "url");
      const apiRoot =
        baseRaw !== null && baseRaw.trim() !== ""
          ? `${stripTrailingSlashes(baseRaw.trim())}/api/0`
          : "https://sentry.io/api/0";

      await ctx.rateLimiter.acquire("sentry");
      const u = `${apiRoot}/organizations/${encodeURIComponent(org)}/projects/`;
      const res = await fetch(u, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const text = await res.text();
      if (!res.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, status: res.status },
          "sentry sync: projects failed",
        );
        // The projects request itself failed: nothing is trustworthy enough to
        // window an issue pass against, so the issue pass does not run this
        // tick. Keep the incoming cursor untouched, or a cold-start marker if
        // there was none.
        return {
          cursor: cursor ?? encodeCursor({ lastSeenMs: 0 }),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred: text.length,
        };
      }
      let root: unknown;
      try {
        root = JSON.parse(text) as unknown;
      } catch {
        // Same reasoning as the !res.ok arm: an unparseable projects body means
        // the issue pass is skipped too.
        return {
          cursor: encodeCursor({ lastSeenMs: 0 }),
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: Math.round(performance.now() - t0),
          bytesTransferred: text.length,
        };
      }
      const list = Array.isArray(root) ? root : [];
      const now = Date.now();
      let projectsUpserted = 0;
      for (const item of list) {
        const row = asRecord(item);
        if (row === undefined) {
          continue;
        }
        const slug = stringField(row, "slug");
        const name = stringField(row, "name");
        const id = slug ?? name;
        if (id === undefined || id === "") {
          continue;
        }
        const title = name ?? id;
        upsertIndexedItemForSync(ctx, {
          service: SERVICE_ID,
          type: "project",
          externalId: id,
          title: clampSyncTitle(title),
          bodyPreview: slug ?? "",
          url: null,
          canonicalUrl: null,
          modifiedAt: now,
          authorId: null,
          metadata: { org, slug: slug ?? null },
          pinned: false,
          syncedAt: now,
        });
        projectsUpserted += 1;
      }
      const projectBytes = text.length;

      const prev = decodeCursor(cursor);
      // Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
      // START only; an established cursor is more recent by construction and wins.
      const coldFloorMs =
        ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
          ? ctx.historyFloorMs
          : now - initialSyncDepthDays * 86_400_000;

      const issues = await syncSentryIssuePass({
        ctx,
        apiRoot,
        org,
        token,
        sinceMs: prev === null ? coldFloorMs : now - initialSyncDepthDays * 86_400_000,
        cursorLastSeenMs: prev?.lastSeenMs ?? null,
        now,
        maxPages: maxPagesPerSync,
      });

      // Never advance past data that was not fetched. A failed pass echoes the
      // incoming cursor VERBATIM (not re-derived from `prev`) so the next tick
      // retries the exact same window. A successful pass, by contrast, always
      // returns a freshly re-encoded V2 cursor — even when it indexed nothing —
      // which is what upgrades a legacy `nimbus-sentry1:` (or any other
      // undecodable) cursor to V2 instead of echoing it back unrecognised.
      const nextCursor = issues.ok
        ? encodeCursor({ lastSeenMs: issues.maxLastSeenMs ?? prev?.lastSeenMs ?? 0 })
        : (cursor ?? encodeCursor({ lastSeenMs: prev?.lastSeenMs ?? 0 }));

      return {
        cursor: nextCursor,
        itemsUpserted: projectsUpserted + issues.upserted,
        itemsDeleted: 0,
        hasMore: issues.hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: projectBytes + issues.bytes,
      };
    },
  };
}
