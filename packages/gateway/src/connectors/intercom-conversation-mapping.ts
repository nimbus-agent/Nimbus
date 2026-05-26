/**
 * Pure mapping from an Intercom `GET /conversations` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `intercom-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "intercom", type = "conversation"` rows — a single item
 * type. `external_id = String(<conversation id>)` (Intercom ids are numeric
 * strings; the row is skipped when `id` is missing/non-numeric — accept either a
 * numeric string or a number, mirroring Raindrop's `_id` skip logic). The
 * conceptual item identity is `intercom:conversation`; the `item.id` ends up
 * `intercom:<id>`.
 *
 * IMPORTANT: Intercom's `created_at` / `updated_at` are epoch SECONDS, exactly
 * like Stripe's timestamps and UNLIKE the epoch-ms / ISO-8601 APIs. They are
 * multiplied by 1000 via {@link secondsToMs} (re-used from the Stripe mapper —
 * the single source of the seconds→ms helper) on the way into the index — never
 * passed through verbatim, and never run through `Date.parse` (these are
 * numbers, not ISO strings).
 *
 * `canonical_url` / `url` are null: the Intercom inbox deep link needs the
 * workspace app id, which is not present in the conversation payload (deferred —
 * the Mercury null-canonical pattern).
 *
 * The conversation `source.body` is HTML; it is stripped to plain text for the
 * body preview (a simple tag-strip + whitespace collapse, no dependency).
 *
 * The `conversation:conversation` type is sparse/structured here — the
 * conversation LIST endpoint only returns the first message (`source.body`),
 * bodies are short, and the batch default is to omit to avoid surprise OpenAI
 * spend for hybrid-mode users — so it stays on local MiniLM embeddings, NOT
 * added to `PROSE_HEAVY_TYPES`.
 */

// Re-use the Stripe seconds→ms helper — Intercom timestamps are epoch SECONDS
// (NOT ms, NOT ISO). Do not redefine a local copy.
import { secondsToMs } from "./stripe-invoice-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface IntercomMappingContext {
  readonly syncedAt: number;
}

export interface IntercomMappedRow {
  readonly service: "intercom";
  readonly type: "conversation";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/**
 * Strip HTML tags from a string to plain text. Removes `<...>` runs, collapses
 * runs of whitespace to a single space, and trims. Returns `""` for non-strings
 * or empty results. Intentionally simple — no HTML-entity decoding, no
 * dependency.
 */
export function stripHtml(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The conversation `id` may be a numeric string (`"123456"`) or a number
 * (`123456`). Return the stringified numeric id, or `null` when the id is
 * missing/non-numeric.
 */
function conversationId(row: Record<string, unknown>): string | null {
  const num = numberField(row, "id");
  if (num !== undefined) {
    return String(num);
  }
  const str = stringField(row, "id");
  if (str !== undefined && str !== "" && Number.isFinite(Number(str))) {
    return str;
  }
  return null;
}

/** Contact ids from a `contacts: { contacts: [{ id }] }` shape, defensive. */
function contactIds(row: Record<string, unknown>): string[] {
  const contacts = asRecord(row["contacts"]);
  const list = contacts === undefined ? undefined : contacts["contacts"];
  if (!Array.isArray(list)) {
    return [];
  }
  const ids: string[] = [];
  for (const c of list) {
    const obj = asRecord(c);
    if (obj === undefined) {
      continue;
    }
    const id = obj["id"];
    if (typeof id === "string" && id !== "") {
      ids.push(id);
    } else if (typeof id === "number" && Number.isFinite(id)) {
      ids.push(String(id));
    }
  }
  return ids;
}

/** Tag NAMES from a `tags: { tags: [{ name }] }` shape, defensive. */
function tagNames(row: Record<string, unknown>): string[] {
  const tags = asRecord(row["tags"]);
  const list = tags === undefined ? undefined : tags["tags"];
  if (!Array.isArray(list)) {
    return [];
  }
  const names: string[] = [];
  for (const t of list) {
    const obj = asRecord(t);
    if (obj === undefined) {
      continue;
    }
    const name = obj["name"];
    if (typeof name === "string" && name !== "") {
      names.push(name);
    }
  }
  return names;
}

export function mapIntercomConversationToItem(
  raw: unknown,
  ctx: IntercomMappingContext,
): IntercomMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = conversationId(row);
  if (id === null) {
    return null;
  }

  const state = stringField(row, "state") ?? null;
  const priority = stringField(row, "priority") ?? null;
  const open = typeof row["open"] === "boolean" ? (row["open"] as boolean) : null;
  const read = typeof row["read"] === "boolean" ? (row["read"] as boolean) : null;

  const source = asRecord(row["source"]) ?? {};
  const sourceType = stringField(source, "type") ?? null;
  const sourceSubject = stringField(source, "subject") ?? null;
  const sourceBodyHtml = stringField(source, "body") ?? null;
  const author = asRecord(source["author"]) ?? {};
  const sourceAuthorName = stringField(author, "name") ?? null;
  const sourceAuthorEmail = stringField(author, "email") ?? null;

  // assignee_id: `admin_assignee_id`, else nested `assignee.id`.
  const adminAssignee = numberField(row, "admin_assignee_id");
  const assigneeObj = asRecord(row["assignee"]) ?? {};
  const assigneeNested =
    numberField(assigneeObj, "id") ??
    (stringField(assigneeObj, "id") !== undefined ? stringField(assigneeObj, "id") : undefined);
  const assigneeId: string | number | null =
    adminAssignee !== undefined ? adminAssignee : (assigneeNested ?? null);
  const teamAssigneeId = numberField(row, "team_assignee_id") ?? null;

  const tags = tagNames(row);
  const contacts = contactIds(row);

  const createdAt = secondsToMs(numberField(row, "created_at"));
  const updatedAt = secondsToMs(numberField(row, "updated_at"));

  // canonical/url is null — the inbox deep link needs the workspace app id,
  // which is not present in the conversation payload (deferred).
  const canonicalUrl: string | null = null;

  // title: `source.subject` when non-empty, else `Conversation <id>` (Intercom
  // conversations frequently have no subject).
  const trimmedSubject = sourceSubject !== null ? sourceSubject.trim() : "";
  const title = trimmedSubject !== "" ? trimmedSubject : `Conversation ${id}`;

  // bodyPreview: the HTML-stripped source body, else the state label, else the
  // title.
  const strippedBody = stripHtml(sourceBodyHtml);
  const bodyPreview =
    strippedBody !== "" ? strippedBody : state !== null && state !== "" ? state : title;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    conversation_id: id,
    title,
    state,
    priority,
    open,
    read,
    source_type: sourceType,
    source_author_name: sourceAuthorName,
    source_author_email: sourceAuthorEmail,
    source_subject: sourceSubject,
    contact_ids: contacts,
    assignee_id: assigneeId,
    team_assignee_id: teamAssigneeId,
    tags,
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "intercom",
    type: "conversation",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
