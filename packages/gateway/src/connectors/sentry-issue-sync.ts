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
  /**
   * A saved `rel="next"` URL from a page-budget-truncated walk (see
   * `resumeUrl` on the result). When present the walk resumes from THIS url
   * instead of building a fresh first page — it already carries its own
   * query params, which must not be rebuilt.
   */
  readonly resumeUrl: string | null;
  /**
   * The running high-water mark carried over from a truncated walk, so
   * progress survives across resumed runs even though the caller's
   * established `lastSeenMs` is deliberately left unchanged until the walk
   * completes (see `sentry-sync.ts`'s cursor composition).
   */
  readonly pendingMax: number | null;
};

export type SentryIssuePassResult = {
  readonly upserted: number;
  readonly bytes: number;
  readonly ok: boolean;
  /** Max modifiedAt seen this walk (seeded from `pendingMax`). Meaningful only when `ok`. */
  readonly runningMaxMs: number | null;
  /**
   * Set when the page budget stopped a walk that had a further page — carry
   * this back in as `resumeUrl` on the next call. Null on a completed or a
   * failed walk.
   */
  readonly resumeUrl: string | null;
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

/**
 * Resolve a `rel="next"` href against the URL it came from — RFC 8288 permits
 * a relative href, and an unresolved relative URL makes `fetch()` throw — and
 * reject a resolved URL whose origin (scheme AND host) doesn't match
 * `apiRoot`'s. The Link header is server-supplied and every follow carries
 * the bearer token, so an unvalidated host would leak it to wherever the
 * header points, and an unvalidated scheme would let a same-host
 * `http://` downgrade send it over cleartext. A rejected or unresolvable URL
 * ends the walk exactly like a natural `results="false"` — no error, just no
 * more pages — with a warning logged for the operator.
 */
function resolveNextUrl(
  rawNext: string | null,
  requestUrl: string,
  apiRoot: string,
  ctx: SyncContext,
): string | null {
  if (rawNext === null) return null;
  let resolved: URL;
  try {
    resolved = new URL(rawNext, requestUrl);
  } catch {
    return null;
  }
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiRoot);
  } catch {
    return null;
  }
  if (resolved.host !== apiUrl.host || resolved.protocol !== apiUrl.protocol) {
    ctx.logger.warn(
      { serviceId: "sentry", nextOrigin: resolved.origin, expectedOrigin: apiUrl.origin },
      "sentry sync: issues next link origin mismatch — ending walk",
    );
    return null;
  }
  return resolved.href;
}

/**
 * Upsert one page of issues and return what it contributed: how many rows were written,
 * and the running high-water mark after them.
 *
 * Lifted out of {@link syncSentryIssuePass}, which was more than 12 points over the
 * cognitive-complexity gate (Sonar `S3776`); this loop and its four guards were most of
 * it. Pure with respect to the walk — it reads no pagination state and decides nothing
 * about whether to continue.
 */
function upsertSentryIssuePage(
  input: SentryIssuePassInput,
  list: readonly unknown[],
  startingMaxMs: number | null,
): { upserted: number; runningMaxMs: number | null } {
  let upserted = 0;
  let runningMaxMs = startingMaxMs;
  for (const raw of list) {
    const row = mapSentryIssueToItem(raw, { org: input.org, syncedAt: input.now });
    if (row === null) continue;
    // SKIP, not stop: newest-first pagination means one out-of-order row
    // at/below the stored high-water mark does NOT mean everything after
    // it is old too — a later row in the same page (or a later page) can
    // still be newer and must still be reached.
    if (input.cursorLastSeenMs !== null && row.modifiedAt <= input.cursorLastSeenMs) {
      continue;
    }
    input.ctx.upsertItem(row);
    upserted += 1;
    if (runningMaxMs === null || row.modifiedAt > runningMaxMs) {
      runningMaxMs = row.modifiedAt;
    }
  }
  return { upserted, runningMaxMs };
}

export async function syncSentryIssuePass(
  input: SentryIssuePassInput,
): Promise<SentryIssuePassResult> {
  const { ctx } = input;
  let url: string | null = input.resumeUrl ?? firstPageUrl(input);
  let firstRequestOfResume = input.resumeUrl !== null;
  let pages = 0;
  let upserted = 0;
  let bytes = 0;
  let runningMaxMs: number | null = input.pendingMax;

  while (url !== null && pages < input.maxPages) {
    await ctx.rateLimiter.acquire("sentry");
    const requestUrl = url;
    const res = await fetch(requestUrl, {
      headers: { Authorization: `Bearer ${input.token}`, Accept: "application/json" },
    });
    const text = await res.text();
    bytes += text.length;

    if (!res.ok) {
      if (firstRequestOfResume) {
        // A resume cursor Sentry no longer accepts (expired/invalidated):
        // fall back to a fresh first-page walk in this same run rather than
        // error out or leave the connector wedged on a dead cursor. The
        // fresh walk starts its OWN running max — the abandoned resume's
        // pendingMax doesn't correspond to anything reachable from page 1.
        ctx.logger.warn(
          { serviceId: "sentry", status: res.status },
          "sentry sync: resume cursor rejected — falling back to a fresh walk",
        );
        firstRequestOfResume = false;
        runningMaxMs = null;
        url = firstPageUrl(input);
        continue;
      }
      // 403 is the mis-scoped-token case: the org issues endpoint needs
      // `event:read`, which a `project:read` token lacks even though pass 1
      // succeeds with it. Treated as an ordinary failure — nothing further
      // indexed, and `ok: false` stops the caller advancing the cursor past
      // unfetched data.
      ctx.logger.warn(
        { serviceId: "sentry", status: res.status, page: pages },
        res.status === 403
          ? "sentry sync: issues forbidden — the auth token needs the event:read scope"
          : "sentry sync: issues list failed",
      );
      return { upserted, bytes, ok: false, runningMaxMs, resumeUrl: null, hasMore: false };
    }
    firstRequestOfResume = false;

    let root: unknown;
    try {
      root = JSON.parse(text) as unknown;
    } catch {
      ctx.logger.warn({ serviceId: "sentry", page: pages }, "sentry sync: issues body not JSON");
      return { upserted, bytes, ok: false, runningMaxMs, resumeUrl: null, hasMore: false };
    }
    const list = Array.isArray(root) ? root : [];

    const page = upsertSentryIssuePage(input, list, runningMaxMs);
    upserted += page.upserted;
    runningMaxMs = page.runningMaxMs;

    pages += 1;
    url = resolveNextUrl(nextPageUrl(res.headers.get("Link")), requestUrl, input.apiRoot, ctx);
  }

  // The walk terminates ONLY on a null next-url (results="false", no Link
  // header, or a rejected host) or the page budget — never on an in-page
  // cursor match. `url !== null` here means the budget stopped a walk that
  // had more left to fetch: save it as a resume point instead of publishing
  // a watermark that would strand the unread tail.
  return url !== null
    ? { upserted, bytes, ok: true, runningMaxMs, resumeUrl: url, hasMore: true }
    : { upserted, bytes, ok: true, runningMaxMs, resumeUrl: null, hasMore: false };
}
