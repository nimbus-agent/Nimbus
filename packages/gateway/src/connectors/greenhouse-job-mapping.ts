import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface GreenhouseMappingContext {
  readonly syncedAt: number;
}

export type GreenhouseMappedRow = MappedRow<"greenhouse", "job">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

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

  const openedAt = parseIsoMs(row["opened_at"]);
  const closedAt = parseIsoMs(row["closed_at"]);
  const createdAt = parseIsoMs(row["created_at"]);
  const updatedAt = parseIsoMs(row["updated_at"]);

  const canonicalUrl: string | null = null;

  const trimmedName = name === null ? "" : name.trim();
  const titleText = trimmedName === "" ? `Job ${id}` : trimmedName;

  const summaryParts = [...departmentNames, ...officeNames, ...officeLocations];
  const summary = summaryParts.join(" — ");
  const statusOrTitle = status !== null && status !== "" ? status : titleText;
  const bodyPreview = summary === "" ? statusOrTitle : summary;

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
