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

export function pipedriveTimeMs(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") {
    return null;
  }
  const ms = Date.parse(`${v.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

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

  const canonicalUrl: string | null = null;

  const titleText = title !== null && title !== "" ? title : `Deal ${id}`;

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
