/**
 * Pure mapping from a Zendesk `GET /api/v2/tickets.json` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `zendesk-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "zendesk", type = "ticket"` rows — a single item type.
 * `external_id = String(<ticket id>)`. The conceptual item identity is
 * `zendesk:ticket`; the `item.id` ends up `zendesk:<id>`. A ticket is short
 * (a subject plus the first comment), so it stays on local MiniLM embeddings —
 * NOT added to `PROSE_HEAVY_TYPES` (avoids surprise OpenAI spend on the whole
 * ticket corpus for every hybrid-mode user; promotion is a documented
 * follow-up).
 *
 * Zendesk is PER-TENANT: the canonical URL is built from the configured base
 * URL passed through {@link ZendeskMappingContext.baseUrl} (the ArgoCD pattern),
 * so the mapper can produce a clickable agent-UI deep link
 * `<base>/agent/tickets/<id>`.
 *
 * IMPORTANT: Zendesk's `created_at` and `updated_at` are ISO-8601 STRINGS
 * (e.g. `"2024-03-01T12:00:00Z"`), like Raindrop's / Readwise's timestamps and
 * UNLIKE the epoch-ms / epoch-seconds number APIs. Parse them to epoch-ms with
 * {@link parseIsoMs} — never pass the ISO string through verbatim, never treat
 * it as epoch seconds.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ZendeskMappingContext {
  /** Zendesk instance base URL (`https://<subdomain>.zendesk.com`) — used to build canonical URLs. */
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export interface ZendeskMappedRow {
  readonly service: "zendesk";
  readonly type: "ticket";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Tag strings from a Zendesk `tags: ["a", "b"]` array. Non-array input and
 * non-string entries are tolerated (skipped).
 */
export function tagStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names;
}

/**
 * Zendesk ids are numbers in the JSON, but tolerate a numeric string too
 * (mirrors the Raindrop `_id` skip logic + Intercom's numeric-string accept).
 * Returns the stringified id, or `undefined` when missing/non-numeric.
 */
function numericIdString(row: Record<string, unknown>, key: string): string | undefined {
  const n = numberField(row, key);
  if (n !== undefined) {
    return String(n);
  }
  const s = stringField(row, key);
  if (s !== undefined && s.trim() !== "" && Number.isFinite(Number(s))) {
    return String(Number(s));
  }
  return undefined;
}

export function mapZendeskTicketToItem(
  raw: unknown,
  ctx: ZendeskMappingContext,
): ZendeskMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // `id` is a number — stringify for external_id; skip the row if missing/non-numeric.
  const id = numericIdString(row, "id");
  if (id === undefined) {
    return null;
  }

  const subject = stringField(row, "subject") ?? null;
  const description = stringField(row, "description") ?? null;
  const status = stringField(row, "status") ?? null;
  const priority = stringField(row, "priority") ?? null;
  const type = stringField(row, "type") ?? null;
  const requesterId = numberField(row, "requester_id") ?? null;
  const assigneeId = numberField(row, "assignee_id") ?? null;
  const groupId = numberField(row, "group_id") ?? null;
  const organizationId = numberField(row, "organization_id") ?? null;
  const tags = tagStrings(row["tags"]);

  // `via.channel` — defensive nested access.
  const via = asRecord(row["via"]) ?? {};
  const viaChannel = stringField(via, "channel") ?? null;

  const createdAt = parseIsoMs(row["created_at"]);
  const updatedAt = parseIsoMs(row["updated_at"]);

  // canonical/url: the agent-UI deep link `<base>/agent/tickets/<id>` (the base
  // URL is always known here, unlike Intercom). Null only when baseUrl is empty.
  const base = trimTrailingSlash(ctx.baseUrl.trim());
  const canonicalUrl = base === "" ? null : `${base}/agent/tickets/${id}`;

  // title: the subject when present, else `Ticket <id>`.
  const titleText = subject !== null && subject.trim() !== "" ? subject : `Ticket ${id}`;

  // bodyPreview: the description (Zendesk's `description` is already plain text —
  // the first comment) when present, else the status label, else the title.
  const bodyPreview =
    description !== null && description !== ""
      ? description
      : status !== null && status !== ""
        ? status
        : titleText;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    ticket_id: id,
    subject,
    status,
    priority,
    type,
    requester_id: requesterId,
    assignee_id: assigneeId,
    group_id: groupId,
    organization_id: organizationId,
    tags,
    via_channel: viaChannel,
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "zendesk",
    type: "ticket",
    externalId: id,
    title: titleText,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
