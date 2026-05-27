/**
 * Pure mapping from a Pipedrive `GET /v1/deals` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `pipedrive-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "pipedrive", type = "deal"` rows — a single item type.
 * `external_id = String(<deal id>)`. The conceptual item identity is
 * `pipedrive:deal`; the `item.id` ends up `pipedrive:<id>`. A deal is sparse /
 * structured (title, value, status, ids), so it stays on local MiniLM
 * embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * IMPORTANT: Pipedrive's `add_time` / `update_time` (and `won_time` /
 * `close_time`) are NON-ISO `"YYYY-MM-DD HH:MM:SS"` UTC strings — they have a
 * SPACE instead of `T` and carry NO `Z` suffix, and are NEITHER ISO-8601 NOR
 * epoch numbers. Parse them with {@link pipedriveTimeMs}, which rewrites the
 * space to `T` and appends `Z` before `Date.parse` so the value is read as UTC.
 * Never pass the raw string through verbatim, and never treat it as epoch
 * seconds/ms.
 *
 * Pipedrive denormalizes the linked person / organization / owner names onto
 * the deal as `person_name` / `org_name` / `owner_name`. The `person_id` and
 * `org_id` fields can themselves be objects (e.g. `{ value, name }`) in some
 * API versions, so they are extracted defensively via {@link asRecord}.
 *
 * `canonical_url` / `url` are always null: a Pipedrive deal deep link needs the
 * company-specific domain (`https://<company>.pipedrive.com/deal/<id>`), which
 * the token-only `api.pipedrive.com` base does not provide. Surfacing it is a
 * deferred follow-up (the Mercury null-canonical pattern).
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface PipedriveMappingContext {
  readonly syncedAt: number;
}

export interface PipedriveMappedRow {
  readonly service: "pipedrive";
  readonly type: "deal";
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
 * Parse a Pipedrive `"YYYY-MM-DD HH:MM:SS"` UTC timestamp to epoch-ms. Rewrites
 * the space separator to `T` and appends `Z` so `Date.parse` reads it as UTC.
 * Returns null for empty / non-string input or an unparseable value.
 */
export function pipedriveTimeMs(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") {
    return null;
  }
  const ms = Date.parse(`${v.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Extract a scalar id from a Pipedrive id field that may be either a bare value
 * (number/string) or a nested `{ value, name }` object. Returns the scalar id
 * (as number when numeric, else the trimmed string) or null.
 */
function idScalar(raw: unknown): number | string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw;
  }
  const nested = asRecord(raw);
  if (nested !== undefined) {
    const value = nested["value"];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

/**
 * Extract a `name` string from a Pipedrive denormalized field. Accepts the
 * top-level `<key>` string (e.g. `org_name`) directly, else descends into a
 * nested `{ name }` object on the related id field (e.g. `org_id: { name }`).
 */
function denormName(row: Record<string, unknown>, nameKey: string, idKey: string): string | null {
  const direct = stringField(row, nameKey);
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  const nested = asRecord(row[idKey]);
  if (nested !== undefined) {
    const name = nested["name"];
    if (typeof name === "string" && name !== "") {
      return name;
    }
  }
  return null;
}

export function mapPipedriveDealToItem(
  raw: unknown,
  ctx: PipedriveMappingContext,
): PipedriveMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // `id` is a number — stringify for external_id; skip the row if missing/non-numeric.
  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const title = stringField(row, "title") ?? null;
  const value = numberField(row, "value") ?? null;
  const currency = stringField(row, "currency") ?? null;
  const status = stringField(row, "status") ?? null;
  const stageId = numberField(row, "stage_id") ?? null;
  const pipelineId = numberField(row, "pipeline_id") ?? null;
  const probability = numberField(row, "probability") ?? null;
  const label = stringField(row, "label") ?? null;
  const expectedCloseDate = stringField(row, "expected_close_date") ?? null;

  const personId = idScalar(row["person_id"]);
  const orgId = idScalar(row["org_id"]);
  const personName = denormName(row, "person_name", "person_id");
  const orgName = denormName(row, "org_name", "org_id");
  const ownerName = denormName(row, "owner_name", "user_id");

  const addTime = pipedriveTimeMs(row["add_time"]);
  const updateTime = pipedriveTimeMs(row["update_time"]);
  const wonTime = pipedriveTimeMs(row["won_time"]);
  const closeTime = pipedriveTimeMs(row["close_time"]);

  // canonical/url: always null — a deal deep link needs the company-specific
  // domain, which the token-only api.pipedrive.com base does not provide.
  const canonicalUrl: string | null = null;

  // title: the deal title when present, else `Deal <id>`.
  const titleText = title !== null && title !== "" ? title : `Deal ${id}`;

  // bodyPreview: `<value> <currency> — <status>` when a value is present, else
  // the status, else the org/person name, else the title.
  const bodyPreview =
    value !== null
      ? `${value}${currency !== null && currency !== "" ? ` ${currency}` : ""}${
          status !== null && status !== "" ? ` — ${status}` : ""
        }`
      : status !== null && status !== ""
        ? status
        : orgName !== null
          ? orgName
          : personName !== null
            ? personName
            : titleText;

  const modifiedAt = updateTime ?? addTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    deal_id: id,
    title,
    value,
    currency,
    status,
    stage_id: stageId,
    pipeline_id: pipelineId,
    person_id: personId,
    person_name: personName,
    org_id: orgId,
    org_name: orgName,
    owner_name: ownerName,
    probability,
    label,
    expected_close_date: expectedCloseDate,
    won_time: wonTime,
    close_time: closeTime,
    add_time: addTime,
    update_time: updateTime,
    canonical_url: canonicalUrl,
  };

  return {
    service: "pipedrive",
    type: "deal",
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
