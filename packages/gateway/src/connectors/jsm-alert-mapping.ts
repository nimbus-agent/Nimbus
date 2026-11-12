import { flattenOncallText } from "./oncall-shift-items.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

/**
 * A Jira Service Management Operations alert as the index stores it (Phase 10 IC2): item
 * `jira:alert`, external id = the alert id (so the item id is `jira:<alertId>`, which cannot collide with
 * a `jira:KEY-1` issue).
 *
 * Shapes are from the documented Operations API (`GET /alerts`, `GET /alerts/{id}`) and are NOT verified
 * against a live site; every field is read defensively and an absent one stays ABSENT. A mapper never
 * defaults a timestamp: a defaulted time corrupts the open-time anchor the incident graph and the item
 * history read. No description, details, owner user, integration or individual responder id is stored
 * (free text and people).
 *
 * Deliberately NOT in `PROSE_HEAVY_TYPES`: `bodyPreview` is the status string, so the alert stays on the
 * local MiniLM tier like `sentry:error_issue`.
 */

/** Bumped when a stored alert must be re-fetched to gain depth. */
export const JSM_ALERT_META_VERSION = 1;

export const JSM_ALERT_TITLE_MAX = 512;
export const JSM_ALERT_TAGS_MAX = 20;
export const JSM_ALERT_TAG_CHARS = 100;
export const JSM_ALERT_FIELD_CHARS = 200;

const PRIORITY = /^P[1-5]$/;

export type JsmAlertMappingContext = { readonly syncedAt: number };

export type JsmAlertMappedRow = {
  readonly service: "jira";
  readonly type: "alert";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: null;
  readonly canonicalUrl: null;
  readonly modifiedAt: number;
  readonly authorId: null;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
  readonly pinned: false;
};

/** An ISO string or an epoch number as epoch milliseconds; null when it is neither. */
function timeMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function tagsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const flat = flattenOncallText(t, JSM_ALERT_TAG_CHARS);
    if (flat === "") continue;
    out.push(flat);
    if (out.length === JSM_ALERT_TAGS_MAX) break;
  }
  return out;
}

/** The id of the first responder whose type is `team`, else null. */
function ownerTeamOf(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const r of raw) {
    const rec = asRecord(r);
    if (rec === undefined) continue;
    const id = stringField(rec, "id");
    if (stringField(rec, "type")?.toLowerCase() === "team" && id !== undefined && id !== "") {
      return flattenOncallText(id, JSM_ALERT_FIELD_CHARS);
    }
  }
  return null;
}

/** `report.<key>` as a finite, non-negative duration in ms, else undefined. */
function reportDuration(row: Record<string, unknown>, key: string): number | undefined {
  const report = asRecord(row["report"]);
  const d = report === undefined ? undefined : numberField(report, key);
  return d !== undefined && d >= 0 ? d : undefined;
}

function addDerivedTimes(
  metadata: Record<string, unknown>,
  row: Record<string, unknown>,
  openedAtMs: number | null,
  closed: boolean,
  acknowledged: boolean,
): void {
  if (openedAtMs === null) return;
  const closeAfter = reportDuration(row, "closeTime");
  if (closed && closeAfter !== undefined) metadata["closed_at_ms"] = openedAtMs + closeAfter;
  const ackAfter = reportDuration(row, "ackTime");
  if (acknowledged && ackAfter !== undefined)
    metadata["acknowledged_at_ms"] = openedAtMs + ackAfter;
}

export function mapJsmAlertToItem(
  raw: unknown,
  ctx: JsmAlertMappingContext,
): JsmAlertMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = stringField(row, "id");
  if (id === undefined || id === "") return null;

  const openedAtMs = timeMs(row["createdAt"]);
  const updatedAtMs = timeMs(row["updatedAt"]);
  // The provider's change clock; never defaulted to the sync time. With neither time the row is skipped.
  const modifiedAt = updatedAtMs ?? openedAtMs;
  if (modifiedAt === null) return null;

  const status = stringField(row, "status")?.toLowerCase() ?? null;
  const priorityRaw = stringField(row, "priority")?.trim();
  const acknowledged = row["acknowledged"] === true;
  const metadata: Record<string, unknown> = {
    alert_id: id,
    status,
    priority: priorityRaw !== undefined && PRIORITY.test(priorityRaw) ? priorityRaw : null,
    acknowledged,
    tags: tagsOf(row["tags"]),
    owner_team: ownerTeamOf(row["responders"]),
    meta_v: JSM_ALERT_META_VERSION,
  };
  if (openedAtMs !== null) metadata["opened_at_ms"] = openedAtMs;
  if (updatedAtMs !== null) metadata["updated_at_ms"] = updatedAtMs;
  addDerivedTimes(metadata, row, openedAtMs, status === "closed", acknowledged);
  for (const key of ["entity", "source"] as const) {
    const v = stringField(row, key);
    const flat = v === undefined ? "" : flattenOncallText(v, JSM_ALERT_FIELD_CHARS);
    if (flat !== "") metadata[key] = flat;
  }

  const message = flattenOncallText(stringField(row, "message") ?? "", JSM_ALERT_TITLE_MAX);
  return {
    service: "jira",
    type: "alert",
    externalId: id,
    title: message === "" ? `Alert ${id}` : message,
    bodyPreview: status ?? "",
    url: null,
    canonicalUrl: null,
    modifiedAt,
    authorId: null,
    metadata,
    syncedAt: ctx.syncedAt,
    pinned: false,
  };
}

export type JsmAlertList = {
  /** The list entries that are records carrying a non-empty string id. */
  readonly alerts: readonly Record<string, unknown>[];
  /** Entries that were not records or carried no usable id: the page is not a complete list. */
  readonly skipped: number;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One `GET /alerts` page: an array at `values`, else at `alerts`, else the body itself. Null otherwise. */
export function parseAlertList(text: string): JsmAlertList | null {
  const root = parseJson(text);
  const rec = asRecord(root);
  let list: unknown;
  if (Array.isArray(root)) list = root;
  else list = rec?.["values"] ?? rec?.["alerts"];
  if (!Array.isArray(list)) return null;
  const alerts: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const item of list) {
    const r = asRecord(item);
    const id = r === undefined ? undefined : stringField(r, "id");
    if (r === undefined || id === undefined || id === "") skipped += 1;
    else alerts.push(r);
  }
  return { alerts, skipped };
}

/** One `GET /alerts/{id}` reply: the record at the root, else under `data`, else under `result`. */
export function parseAlertGet(text: string): Record<string, unknown> | null {
  const root = asRecord(parseJson(text));
  if (root === undefined) return null;
  for (const candidate of [root, asRecord(root["data"]), asRecord(root["result"])]) {
    if (candidate !== undefined && typeof candidate["id"] === "string") return candidate;
  }
  return null;
}
