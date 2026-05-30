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

export function stripHtml(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  const open = typeof row["open"] === "boolean" ? row["open"] : null;
  const read = typeof row["read"] === "boolean" ? row["read"] : null;

  const source = asRecord(row["source"]) ?? {};
  const sourceType = stringField(source, "type") ?? null;
  const sourceSubject = stringField(source, "subject") ?? null;
  const sourceBodyHtml = stringField(source, "body") ?? null;
  const author = asRecord(source["author"]) ?? {};
  const sourceAuthorName = stringField(author, "name") ?? null;
  const sourceAuthorEmail = stringField(author, "email") ?? null;

  const adminAssignee = numberField(row, "admin_assignee_id");
  const assigneeObj = asRecord(row["assignee"]) ?? {};
  const assigneeNested =
    numberField(assigneeObj, "id") ??
    (stringField(assigneeObj, "id") !== undefined ? stringField(assigneeObj, "id") : undefined);
  const assigneeId: string | number | null = adminAssignee ?? assigneeNested ?? null;
  const teamAssigneeId = numberField(row, "team_assignee_id") ?? null;

  const tags = tagNames(row);
  const contacts = contactIds(row);

  const createdAt = secondsToMs(numberField(row, "created_at"));
  const updatedAt = secondsToMs(numberField(row, "updated_at"));

  const canonicalUrl: string | null = null;

  const trimmedSubject = sourceSubject !== null ? sourceSubject.trim() : "";
  const title = trimmedSubject !== "" ? trimmedSubject : `Conversation ${id}`;

  const strippedBody = stripHtml(sourceBodyHtml);
  const stateOrTitle = state !== null && state !== "" ? state : title;
  const bodyPreview = strippedBody !== "" ? strippedBody : stateOrTitle;

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
