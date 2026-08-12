import { upsertIndexedItemForSync } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import { nextPageUrl } from "./link-header.ts";
import { mapSentryIssueToItem } from "./sentry-issue-mapping.ts";

export type SentryIssuePassInput = {
  readonly ctx: SyncContext;
  readonly apiRoot: string;
  readonly org: string;
  readonly token: string;
  readonly sinceMs: number;
  readonly cursorLastSeenMs: number | null;
  readonly now: number;
  readonly maxPages: number;
};

export type SentryIssuePassResult = {
  readonly upserted: number;
  readonly bytes: number;
  readonly maxLastSeenMs: number | null;
  readonly ok: boolean;
  readonly hasMore: boolean;
};

const MS_PER_DAY = 86_400_000;

/**
 * `query` is ONE string and REPLACES Sentry's `is:unresolved` default, so a
 * `lastSeen:` term with no `is:` term both windows the request and returns every
 * status — resolved issues included, which is the entire point. `statsPeriod` is
 * deliberately absent: it does not filter the result set, it only controls the
 * inline `stats` key, which `collapse=stats` drops.
 */
function firstPageUrl(input: SentryIssuePassInput): string {
  const days = Math.max(1, Math.ceil((input.now - input.sinceMs) / MS_PER_DAY));
  const u = new URL(`${input.apiRoot}/organizations/${encodeURIComponent(input.org)}/issues/`);
  u.searchParams.set("query", `lastSeen:-${String(days)}d`);
  u.searchParams.set("sort", "date");
  u.searchParams.set("collapse", "stats");
  u.searchParams.set("limit", "100");
  return u.toString();
}

export async function syncSentryIssuePass(
  input: SentryIssuePassInput,
): Promise<SentryIssuePassResult> {
  const { ctx } = input;
  let url: string | null = firstPageUrl(input);
  let pages = 0;
  let upserted = 0;
  let bytes = 0;
  let maxLastSeenMs: number | null = null;

  while (url !== null && pages < input.maxPages) {
    await ctx.rateLimiter.acquire("sentry");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.token}`, Accept: "application/json" },
    });
    const text = await res.text();
    bytes += text.length;
    if (!res.ok) {
      // 403 is the mis-scoped-token case: the org issues endpoint needs
      // `event:read`, which a `project:read` token lacks even though pass 1
      // succeeds with it. Treated as an ordinary failure — nothing indexed, and
      // `ok: false` stops the caller advancing the cursor past unfetched data.
      ctx.logger.warn(
        { serviceId: "sentry", status: res.status, page: pages },
        res.status === 403
          ? "sentry sync: issues forbidden — the auth token needs the event:read scope"
          : "sentry sync: issues list failed",
      );
      return { upserted, bytes, maxLastSeenMs, ok: false, hasMore: false };
    }

    let root: unknown;
    try {
      root = JSON.parse(text) as unknown;
    } catch {
      ctx.logger.warn({ serviceId: "sentry", page: pages }, "sentry sync: issues body not JSON");
      return { upserted, bytes, maxLastSeenMs, ok: false, hasMore: false };
    }
    const list = Array.isArray(root) ? root : [];

    for (const raw of list) {
      const row = mapSentryIssueToItem(raw, { org: input.org, syncedAt: input.now });
      if (row === null) continue;
      // Descending scan: the first row at or below the stored high-water mark
      // means everything after it is already indexed.
      if (input.cursorLastSeenMs !== null && row.modifiedAt <= input.cursorLastSeenMs) {
        return { upserted, bytes, maxLastSeenMs, ok: true, hasMore: false };
      }
      upsertIndexedItemForSync(ctx, row);
      upserted += 1;
      if (maxLastSeenMs === null || row.modifiedAt > maxLastSeenMs) {
        maxLastSeenMs = row.modifiedAt;
      }
    }

    pages += 1;
    url = nextPageUrl(res.headers.get("Link"));
  }

  return { upserted, bytes, maxLastSeenMs, ok: true, hasMore: url !== null };
}
