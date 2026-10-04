import { pickStringArray, trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

// Zendesk tags are plain strings: every string element is kept, empty ones included.
export { pickStringArray as tagStrings } from "./_lib/field-helpers.ts";

export interface ZendeskMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type ZendeskMappedRow = MappedRow<"zendesk", "ticket">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

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
  const tags = pickStringArray(row["tags"]);

  const via = asRecord(row["via"]) ?? {};
  const viaChannel = stringField(via, "channel") ?? null;

  const createdAt = parseIsoMs(row["created_at"]);
  const updatedAt = parseIsoMs(row["updated_at"]);

  const base = trimTrailingSlash(ctx.baseUrl.trim());
  const canonicalUrl = base === "" ? null : `${base}/agent/tickets/${id}`;

  const titleText = subject !== null && subject.trim() !== "" ? subject : `Ticket ${id}`;

  const statusOrTitle = status !== null && status !== "" ? status : titleText;
  const bodyPreview = description !== null && description !== "" ? description : statusOrTitle;

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
