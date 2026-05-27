/**
 * Pure mapping from a Greenhouse Harvest `GET /v1/jobs` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `greenhouse-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "greenhouse", type = "job"` rows — a single item type. The
 * conceptual item identity is `greenhouse:job`; the `item.id` ends up
 * `greenhouse:<id>`. `external_id = String(<job id>)`. Greenhouse job ids are
 * NUMBERS (e.g. `4001234`), so the row is skipped when the id is missing or
 * non-numeric (mirroring Raindrop's `_id` skip — NOT the Lever UUID-string
 * accept). A job is short (a name plus a department/office summary), so it stays
 * on local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES` (avoids surprise
 * OpenAI spend on the whole jobs corpus).
 *
 * IMPORTANT: Greenhouse's `created_at` / `updated_at` (and `opened_at` /
 * `closed_at`) are ISO-8601 STRINGS (e.g. `"2024-03-01T12:00:00.000Z"`), like
 * Readwise's / Raindrop's / Zendesk's timestamps and UNLIKE the epoch-ms
 * (Lever / Vercel) and epoch-seconds (Stripe / Intercom) number APIs. Parse
 * them to epoch-ms with the local {@link parseIsoMs} helper — never pass the ISO
 * string through verbatim, and never treat it as epoch seconds.
 *
 * The `departments` / `offices` arrays are lists of `{ id, name }` objects; only
 * the NAMES are stored (department_names / office_names), tolerating non-object
 * entries via defensive {@link asRecord} access. Each office additionally
 * carries a nested `location: { name }` — the location names are stored as
 * office_locations. The `canonical_url` is null: the Harvest API exposes no
 * per-job public URL without a board token (deferred — the Mercury
 * null-canonical pattern).
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface GreenhouseMappingContext {
  readonly syncedAt: number;
}

export interface GreenhouseMappedRow {
  readonly service: "greenhouse";
  readonly type: "job";
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
 * An ISO-8601 timestamp string → epoch ms. A non-string, an unparseable string,
 * or a number yields null (Greenhouse timestamps are always ISO strings).
 */
function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * The `name` of each `{ id, name }` entry of a Greenhouse named array
 * (`departments` / `offices`). Non-array input and non-object / nameless entries
 * are tolerated (skipped).
 */
export function namedEntryNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const e of raw) {
    const row = asRecord(e);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, "name");
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

/**
 * The nested `location.name` of each `offices: [{ location: { name } }]` entry.
 * Non-array input and non-object / nameless nested entries are tolerated.
 */
export function officeLocationNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const locs: string[] = [];
  for (const e of raw) {
    const row = asRecord(e);
    if (row === undefined) {
      continue;
    }
    const loc = asRecord(row["location"]);
    if (loc === undefined) {
      continue;
    }
    const name = stringField(loc, "name");
    if (name !== undefined && name !== "") {
      locs.push(name);
    }
  }
  return locs;
}

export function mapGreenhouseJobToItem(
  raw: unknown,
  ctx: GreenhouseMappingContext,
): GreenhouseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // Greenhouse ids are numbers — stringify for external_id; skip the row when
  // the id is missing or non-numeric (mirrors Raindrop's `_id` skip).
  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const name = stringField(row, "name") ?? null;
  const status = stringField(row, "status") ?? null;
  const requisitionId = stringField(row, "requisition_id") ?? null;
  const confidential = typeof row["confidential"] === "boolean" ? row["confidential"] : null;

  const departmentNames = namedEntryNames(row["departments"]);
  const officeNames = namedEntryNames(row["offices"]);
  const officeLocations = officeLocationNames(row["offices"]);

  // Greenhouse timestamps are ISO-8601 strings — parse to epoch-ms via the local
  // parseIsoMs helper, never verbatim, never epoch-seconds.
  const openedAt = parseIsoMs(row["opened_at"]);
  const closedAt = parseIsoMs(row["closed_at"]);
  const createdAt = parseIsoMs(row["created_at"]);
  const updatedAt = parseIsoMs(row["updated_at"]);

  // canonical/url: null. The Harvest API exposes no per-job public URL without a
  // board token (deferred — the Mercury null-canonical pattern).
  const canonicalUrl: string | null = null;

  // title: the job name (trimmed) when present, else `Job <id>`.
  const trimmedName = name !== null ? name.trim() : "";
  const titleText = trimmedName !== "" ? trimmedName : `Job ${id}`;

  // bodyPreview: a summary joining the department names + office names/locations
  // (e.g. "Engineering — San Francisco, CA"), else the status, else the title.
  const summaryParts = [...departmentNames, ...officeNames, ...officeLocations];
  const summary = summaryParts.join(" — ");
  const bodyPreview =
    summary !== "" ? summary : status !== null && status !== "" ? status : titleText;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    job_id: id,
    name,
    status,
    requisition_id: requisitionId,
    confidential,
    department_names: departmentNames,
    office_names: officeNames,
    office_locations: officeLocations,
    opened_at: openedAt,
    closed_at: closedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "greenhouse",
    type: "job",
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
