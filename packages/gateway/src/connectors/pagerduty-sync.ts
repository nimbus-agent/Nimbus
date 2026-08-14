import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
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

function buildPagerdutyMetadata(row: Record<string, unknown>, id: string): Record<string, unknown> {
  const status = stringField(row, "status");
  const createdAt = stringField(row, "created_at");
  const openedAtMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const serviceId = pdServiceId(row);
  const severity = pdPriorityName(row);
  const urgency = stringField(row, "urgency");

  const metadata: Record<string, unknown> = { status: status ?? null, incidentId: id };
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
    metadata: buildPagerdutyMetadata(row, id),
    pinned: false,
    syncedAt: now,
  });
}

export function syncPagerdutyIncidentItems(
  ctx: SyncContext,
  incidents: unknown[],
  since: string,
  now: number,
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
    upsertPagerdutyIncident(ctx, row, id, now);
    upserted += 1;
  }
  return { upserted, maxUpdated };
}

export type PagerdutySyncableOptions = {
  ensurePagerdutyMcpRunning: () => Promise<void>;
  maxPagesPerSync?: number;
};

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
      const token = await readConnectorSecret(ctx.vault, "pagerduty", "api_token");
      if (token === null || token.trim() === "") {
        return syncNoopResult(cursor, t0);
      }
      const prev = decodeCursor(cursor);
      const now = Date.now();
      const floorIso = new Date(now - initialSyncDepthDays * 86_400_000).toISOString();
      const since = prev?.lastUpdated ?? floorIso;

      let pagesFetched = 0;
      let totalUpserted = 0;
      let maxUpdated = since;
      let totalBytesTransferred = 0;
      let pdHasMore = false;

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
          return {
            cursor: encodeCursor({ lastUpdated: maxUpdated }),
            itemsUpserted: totalUpserted,
            itemsDeleted: 0,
            hasMore: false,
            durationMs: Math.round(performance.now() - t0),
            bytesTransferred: totalBytesTransferred,
          };
        }
        const parsed = parsePagerdutyListResponse(text);
        if (parsed === null) {
          return {
            cursor: encodeCursor({ lastUpdated: maxUpdated }),
            itemsUpserted: totalUpserted,
            itemsDeleted: 0,
            hasMore: false,
            durationMs: Math.round(performance.now() - t0),
            bytesTransferred: totalBytesTransferred,
          };
        }
        const { upserted, maxUpdated: pageMax } = syncPagerdutyIncidentItems(
          ctx,
          parsed.incidents,
          maxUpdated,
          now,
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
