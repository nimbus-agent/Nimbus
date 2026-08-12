import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import type { SentryIssuePassResult } from "./sentry-issue-sync.ts";
import { syncSentryIssuePass } from "./sentry-issue-sync.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "sentry";
const CURSOR_PREFIX = "nimbus-sentry2:";

/**
 * `resume` / `pendingMax` are present only while a page-budget-truncated
 * walk is in flight; a completed walk clears both (see `buildNextCursor`).
 */
type SentryCursorV2 = { lastSeenMs: number; resume?: string; pendingMax?: number };

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
  const resumeRaw = rec["resume"];
  const resume = typeof resumeRaw === "string" && resumeRaw !== "" ? resumeRaw : undefined;
  const pendingMaxRaw = rec["pendingMax"];
  const pendingMax =
    typeof pendingMaxRaw === "number" && Number.isFinite(pendingMaxRaw) ? pendingMaxRaw : undefined;
  return {
    lastSeenMs,
    ...(resume !== undefined ? { resume } : {}),
    ...(pendingMax !== undefined ? { pendingMax } : {}),
  };
}

/**
 * Composes the next persisted cursor from the projects+issues pass outcome.
 *
 * - A FAILED issue pass echoes the incoming cursor VERBATIM, including
 *   `null`. Never synthesize `{lastSeenMs: 0}` here: a cold start (`cursor`
 *   already null) that fails must STAY a cold start, or the next attempt
 *   silently loses `historyFloorMs` forever (Important B).
 * - A BUDGET-TRUNCATED walk (`issues.resumeUrl !== null`) leaves `lastSeenMs`
 *   exactly as it already was — nothing is "caught up" yet — and carries the
 *   resume point + running max forward so the unread tail is reachable next
 *   run instead of being permanently stranded (the Critical fix).
 * - A COMPLETE walk advances to the highest of: any carried-over
 *   `pendingMax`, this walk's own running max, and the previously
 *   established `lastSeenMs` — never regressing below any of the three —
 *   and clears `resume`/`pendingMax`.
 */
function buildNextCursor(
  cursor: string | null,
  prev: SentryCursorV2 | null,
  issues: SentryIssuePassResult,
): string | null {
  if (!issues.ok) {
    return cursor;
  }
  if (issues.resumeUrl !== null) {
    return encodeCursor({
      lastSeenMs: prev?.lastSeenMs ?? 0,
      resume: issues.resumeUrl,
      pendingMax: issues.runningMaxMs ?? prev?.pendingMax ?? 0,
    });
  }
  const candidates = [prev?.pendingMax, issues.runningMaxMs, prev?.lastSeenMs].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const lastSeenMs = candidates.length > 0 ? Math.max(...candidates) : 0;
  return encodeCursor({ lastSeenMs });
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
        // Same reasoning as the !res.ok arm above: an unparseable projects
        // body means the issue pass is skipped too, AND — like that arm —
        // a cursor the caller already trusted must not be destroyed by a
        // failure in the OTHER pass. Echo it (or a cold-start marker if
        // there was none), never synthesize a fresh {lastSeenMs: 0} over an
        // established one.
        return {
          cursor: cursor ?? encodeCursor({ lastSeenMs: 0 }),
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
      const windowFloorMs = now - initialSyncDepthDays * 86_400_000;
      // An established cursor derives the window from ITSELF, not a fixed
      // 30-day floor: skip-not-stop (the Critical fix) means every row at or
      // below the cursor is still fetched, parsed and mapped even though none
      // of them get indexed, so a caught-up connector that kept asking for
      // the full 30 days would re-walk the entire window every tick for zero
      // upserts. `Math.max` (not min) picks the NEWER of the two bounds: a
      // recent cursor shrinks the request to a small delta so the walk
      // terminates naturally, while an ancient cursor is still capped at the
      // 30-day window rather than left unbounded. A RESUMED walk is
      // unaffected — it starts from `resumeUrl`, which already carries its
      // own params, and never rebuilds this URL unless the resume is
      // rejected, in which case rebuilding with the shrunken window is
      // exactly what's wanted.
      const sinceMs = prev === null ? coldFloorMs : Math.max(prev.lastSeenMs, windowFloorMs);

      const issues = await syncSentryIssuePass({
        ctx,
        apiRoot,
        org,
        token,
        sinceMs,
        cursorLastSeenMs: prev?.lastSeenMs ?? null,
        now,
        maxPages: maxPagesPerSync,
        resumeUrl: prev?.resume ?? null,
        pendingMax: prev?.pendingMax ?? null,
      });

      const nextCursor = buildNextCursor(cursor, prev, issues);

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
