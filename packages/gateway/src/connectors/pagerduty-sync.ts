import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { usableActorEmail } from "./actor-email.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  extractPagerdutyActors,
  PAGERDUTY_INCIDENT_META_VERSION,
  pagerdutyEmailMapFromIncidents,
  pagerdutyUnresolvedActorIds,
} from "./pagerduty-attribution.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "pagerduty";
const CURSOR_PREFIX = "nimbus-pd1:";

type PdCursorV1 = { lastUpdated: string };

function encodeCursor(c: PdCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): PdCursorV1 | null {
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
  const lu = rec["lastUpdated"];
  if (typeof lu !== "string" || lu === "") {
    return null;
  }
  return { lastUpdated: lu };
}

function parsePagerdutyListResponse(text: string): { incidents: unknown[]; more: boolean } | null {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const rec = asRecord(root);
  if (rec === undefined) return null;
  const incidents = rec["incidents"];
  if (!Array.isArray(incidents)) return null;
  return { incidents, more: rec["more"] === true };
}

function pdServiceId(row: Record<string, unknown>): string | undefined {
  const svc = asRecord(row["service"]);
  return svc === undefined ? undefined : stringField(svc, "id");
}

function pdPriorityName(row: Record<string, unknown>): string | undefined {
  const pri = asRecord(row["priority"]);
  return pri === undefined ? undefined : stringField(pri, "name");
}

function buildPagerdutyMetadata(
  row: Record<string, unknown>,
  id: string,
  emailById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const status = stringField(row, "status");
  const createdAt = stringField(row, "created_at");
  const openedAtMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const serviceId = pdServiceId(row);
  const severity = pdPriorityName(row);
  const urgency = stringField(row, "urgency");
  const actors = extractPagerdutyActors(row, emailById);

  const metadata: Record<string, unknown> = {
    status: status ?? null,
    incidentId: id,
    // Always present, never conditional: an absent key would be
    // indistinguishable from a connector version that never captured actors,
    // which is exactly what `meta_v` and `nimbus index rebody` exist to detect.
    assignee_emails: actors.assigneeEmails,
    resolved_by_email: actors.resolvedByEmail,
    unattributed_actors: actors.unattributed,
    meta_v: PAGERDUTY_INCIDENT_META_VERSION,
  };
  if (Number.isFinite(openedAtMs)) metadata["opened_at_ms"] = openedAtMs;
  if (serviceId !== undefined && serviceId !== "") metadata["pagerduty_service_id"] = serviceId;
  if (severity !== undefined && severity !== "") metadata["severity"] = severity;
  if (urgency !== undefined && urgency !== "") metadata["urgency"] = urgency;
  return metadata;
}

function upsertPagerdutyIncident(
  ctx: SyncContext,
  row: Record<string, unknown>,
  id: string,
  now: number,
  emailById: ReadonlyMap<string, string>,
): void {
  const title = stringField(row, "title") ?? `Incident ${id}`;
  const status = stringField(row, "status");
  const htmlUrl = stringField(row, "html_url");
  const updated = stringField(row, "updated_at") ?? stringField(row, "created_at");
  const modifiedAt = updated === undefined ? now : Date.parse(updated);

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "incident",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: status ?? "",
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : now,
    authorId: null,
    metadata: buildPagerdutyMetadata(row, id, emailById),
    pinned: false,
    syncedAt: now,
  });
}

export function syncPagerdutyIncidentItems(
  ctx: SyncContext,
  incidents: unknown[],
  since: string,
  now: number,
  emailById: ReadonlyMap<string, string>,
): { upserted: number; maxUpdated: string } {
  let upserted = 0;
  let maxUpdated = since;
  for (const item of incidents) {
    const row = asRecord(item);
    if (row === undefined) {
      continue;
    }
    const id = stringField(row, "id");
    if (id === undefined || id === "") {
      continue;
    }
    const updated = stringField(row, "updated_at") ?? stringField(row, "created_at");
    if (updated !== undefined && updated > maxUpdated) {
      maxUpdated = updated;
    }
    upsertPagerdutyIncident(ctx, row, id, now, emailById);
    upserted += 1;
  }
  return { upserted, maxUpdated };
}

/**
 * Hard ceiling on identity lookups per sync run. The expansion in Task 4
 * covers assignees for free, so this only ever pays for actors that arrive as
 * bare references — normally a handful. Exported so the test can seed exactly
 * at the boundary without duplicating the number.
 */
export const MAX_USER_LOOKUPS_PER_SYNC = 25;

/**
 * Fill `emailById` for actor ids the page did not expand.
 *
 * Sequential on purpose. The cap bounds TOTAL requests, not their burst rate;
 * fanning 25 concurrent requests at a shared limiter is precisely the spike the
 * limiter exists to smooth. Each lookup acquires the limiter exactly as the
 * list requests do (`:186`).
 *
 * Every failure mode — non-OK status, thrown request, unparseable body — is
 * caught PER LOOKUP and memoised as a miss, then attribution simply degrades to
 * an unattributed count. A 403 here is the expected steady state for any token
 * scoped before this feature existed, so losing the whole incident index over
 * it would be a far worse outcome than an unattributed incident.
 *
 * Returns the bytes transferred so the caller keeps its accounting honest.
 */
async function resolveMissingActorEmails(
  ctx: SyncContext,
  token: string,
  ids: readonly string[],
  emailById: Map<string, string>,
  attempted: Set<string>,
): Promise<number> {
  let bytes = 0;
  for (const id of ids) {
    if (attempted.size >= MAX_USER_LOOKUPS_PER_SYNC) return bytes;
    if (attempted.has(id) || emailById.has(id)) continue;
    attempted.add(id);
    await ctx.rateLimiter.acquire("pagerduty");
    try {
      const res = await fetch(`https://api.pagerduty.com/users/${encodeURIComponent(id)}`, {
        headers: {
          Accept: "application/vnd.pagerduty+json;version=2",
          Authorization: `Token token=${token.trim()}`,
        },
      });
      const text = await res.text();
      bytes += text.length;
      if (!res.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, status: res.status },
          "pagerduty sync: user lookup failed; incident left unattributed",
        );
        continue;
      }
      // Do NOT "simplify" this into a hand-rolled `typeof parsed === "object"
      // && parsed !== null` guard. `asRecord` already rejects null, primitives
      // AND arrays (`unknown-record.ts:1-6`); an inline guard drops the array
      // check, and binding `JSON.parse(text)` to a `const` without `as unknown`
      // types it `any`, which the no-`any` rule forbids. `JSON.parse` sits
      // inside the try precisely so an empty or non-JSON 200 body degrades to
      // an unattributed incident rather than throwing.
      const user = asRecord(asRecord(JSON.parse(text) as unknown)?.["user"]);
      const email = user === undefined ? null : usableActorEmail(user["email"]);
      if (email !== null) emailById.set(id, email);
    } catch (err) {
      ctx.logger.warn(
        { serviceId: SERVICE_ID, err },
        "pagerduty sync: user lookup threw; incident left unattributed",
      );
    }
  }
  return bytes;
}

export type PagerdutySyncableOptions = {
  ensurePagerdutyMcpRunning: () => Promise<void>;
  maxPagesPerSync?: number;
};

/**
 * Merge a page's newly-discovered actor emails into the run-scoped map, first write
 * wins. Lifted out of the sync loop: as an inline `for` with a nested `if` it was worth
 * five points of cognitive complexity (Sonar `S3776`) for one line of intent.
 *
 * First write wins deliberately — `emailById` is run-scoped so a repeated actor is
 * harvested once per SYNC, and a later page re-reporting the same id must not overwrite
 * an email an explicit user lookup already resolved.
 */
function mergeNewEmails(into: Map<string, string>, page: ReadonlyMap<string, string>): void {
  for (const [id, email] of page) {
    if (!into.has(id)) into.set(id, email);
  }
}

/**
 * The result a run returns when a page cannot be read — an HTTP failure or an
 * unparseable body. Identical in both cases: keep everything already upserted, park the
 * cursor at the high-water mark so the next run resumes from there, and report
 * `hasMore: false` so the scheduler does not immediately retry into the same wall.
 *
 * One helper rather than two byte-identical object literals, which is what the two early
 * returns in the loop used to be.
 */
function partialSyncResult(
  maxUpdated: string,
  itemsUpserted: number,
  bytesTransferred: number,
  t0: number,
): SyncResult {
  return {
    cursor: encodeCursor({ lastUpdated: maxUpdated }),
    itemsUpserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred,
  };
}

export function createPagerdutySyncable(options: PagerdutySyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  const maxPagesPerSync = Math.max(1, Math.min(100, options.maxPagesPerSync ?? 20));
  const PAGE_SIZE = 100;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensurePagerdutyMcpRunning();
      const token = await ctx.getSecret("api_token");
      if (token === null || token.trim() === "") {
        return syncNoopResult(cursor, t0);
      }
      const prev = decodeCursor(cursor);
      const now = Date.now();
      // Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
      // START only; an established cursor is more recent by construction and wins.
      // Opted in because an attribution substrate is exactly the case the mechanism
      // was built for — assembling a contribution brief needs more than 30 days of
      // history, once, without permanently widening every routine sync.
      const coldFloorMs =
        ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
          ? ctx.historyFloorMs
          : now - initialSyncDepthDays * 86_400_000;
      const since = prev?.lastUpdated ?? new Date(coldFloorMs).toISOString();

      let pagesFetched = 0;
      let totalUpserted = 0;
      let maxUpdated = since;
      let totalBytesTransferred = 0;
      let pdHasMore = false;
      // Run-scoped, so a repeated actor is harvested once per SYNC, not per page.
      const emailById = new Map<string, string>();
      // Run-scoped, so a repeated actor costs one lookup per SYNC, not per page.
      const attemptedUserIds = new Set<string>();

      while (pagesFetched < maxPagesPerSync) {
        await ctx.rateLimiter.acquire("pagerduty");
        const u = new URL("https://api.pagerduty.com/incidents");
        u.searchParams.set("limit", String(PAGE_SIZE));
        u.searchParams.set("sort_by", "updated_at:asc");
        u.searchParams.set("since", since);
        u.searchParams.set("offset", String(pagesFetched * PAGE_SIZE));
        // Expanded actors carry `email`, which is what makes assignee
        // attribution cost ZERO extra requests. `acknowledgers` is requested
        // even though no acknowledger edge is emitted: it is an identity
        // source for `last_status_change_by`, which arrives as a bare
        // reference (spec § 3.2). `append`, not `set` — `set` would replace
        // the previous value and only the last would survive.
        u.searchParams.append("include[]", "assignees");
        u.searchParams.append("include[]", "acknowledgers");
        u.searchParams.append("include[]", "users");
        const res = await fetch(u.toString(), {
          headers: {
            Accept: "application/vnd.pagerduty+json;version=2",
            Authorization: `Token token=${token.trim()}`,
          },
        });
        const text = await res.text();
        totalBytesTransferred += text.length;
        if (!res.ok) {
          ctx.logger.warn(
            { serviceId: SERVICE_ID, status: res.status, page: pagesFetched },
            "pagerduty sync: list failed",
          );
          return partialSyncResult(maxUpdated, totalUpserted, totalBytesTransferred, t0);
        }
        const parsed = parsePagerdutyListResponse(text);
        if (parsed === null) {
          return partialSyncResult(maxUpdated, totalUpserted, totalBytesTransferred, t0);
        }
        const pageEmails = pagerdutyEmailMapFromIncidents(parsed.incidents);
        mergeNewEmails(emailById, pageEmails);
        totalBytesTransferred += await resolveMissingActorEmails(
          ctx,
          token,
          pagerdutyUnresolvedActorIds(parsed.incidents, emailById),
          emailById,
          attemptedUserIds,
        );

        const { upserted, maxUpdated: pageMax } = syncPagerdutyIncidentItems(
          ctx,
          parsed.incidents,
          maxUpdated,
          now,
          emailById,
        );
        totalUpserted += upserted;
        maxUpdated = pageMax;
        pagesFetched += 1;
        pdHasMore = parsed.more;
        if (!pdHasMore) break;
      }

      return {
        cursor: encodeCursor({ lastUpdated: maxUpdated }),
        itemsUpserted: totalUpserted,
        itemsDeleted: 0,
        hasMore: pagesFetched >= maxPagesPerSync && pdHasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: totalBytesTransferred,
      };
    },
  };
}
