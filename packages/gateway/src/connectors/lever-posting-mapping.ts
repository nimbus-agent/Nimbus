import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface LeverMappingContext {
  readonly syncedAt: number;
}

export interface LeverMappedRow {
  readonly service: "lever";
  readonly type: "posting";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function epochMs(row: Record<string, unknown>, key: string): number | null {
  const v = numberField(row, key);
  return v === undefined || v === 0 ? null : v;
}

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

function reqCode(row: Record<string, unknown>): string | null {
  const direct = stringField(row, "reqCode");
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  const list = row["requisitionCodes"];
  if (Array.isArray(list)) {
    for (const c of list) {
      if (typeof c === "string" && c !== "") {
        return c;
      }
    }
  }
  return null;
}

function deriveLeverCanonicalUrl(
  hostedUrl: string | null,
  urlsShow: string | null,
  applyUrl: string | null,
): string | null {
  if (hostedUrl !== null && hostedUrl !== "") {
    return hostedUrl;
  }
  if (urlsShow !== null && urlsShow !== "") {
    return urlsShow;
  }
  if (applyUrl !== null && applyUrl !== "") {
    return applyUrl;
  }
  return null;
}

function deriveLeverBodyPreview(
  categorySummary: string,
  state: string | null,
  titleText: string,
): string {
  if (categorySummary !== "") {
    return categorySummary;
  }
  if (state !== null && state !== "") {
    return state;
  }
  return titleText;
}

export function mapLeverPostingToItem(
  raw: unknown,
  ctx: LeverMappingContext,
): LeverMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const idRaw = stringField(row, "id");
  if (idRaw === undefined || idRaw === "") {
    return null;
  }
  const id = String(idRaw);

  const text = stringField(row, "text") ?? null;
  const state = stringField(row, "state") ?? null;

  const categories = asRecord(row["categories"]) ?? {};
  const team = stringField(categories, "team") ?? null;
  const department = stringField(categories, "department") ?? null;
  const location = stringField(categories, "location") ?? null;
  const commitment = stringField(categories, "commitment") ?? null;
  const level = stringField(categories, "level") ?? null;

  const tags = tagStrings(row["tags"]);

  const hostedUrl = stringField(row, "hostedUrl") ?? null;
  const applyUrl = stringField(row, "applyUrl") ?? null;
  const urls = asRecord(row["urls"]) ?? {};
  const urlsShow = stringField(urls, "show") ?? null;

  const createdAt = epochMs(row, "createdAt");
  const updatedAt = epochMs(row, "updatedAt");

  const canonicalUrl = deriveLeverCanonicalUrl(hostedUrl, urlsShow, applyUrl);

  const trimmedText = text !== null ? text.trim() : "";
  const titleText = trimmedText !== "" ? trimmedText : `Posting ${id}`;

  const categorySummary = [team, department, location, commitment, level]
    .filter((c): c is string => c !== null && c !== "")
    .join(" — ");
  const bodyPreview = deriveLeverBodyPreview(categorySummary, state, titleText);

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    posting_id: id,
    text,
    state,
    team,
    department,
    location,
    commitment,
    level,
    tags,
    hosted_url: hostedUrl,
    apply_url: applyUrl,
    req_code: reqCode(row),
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "lever",
    type: "posting",
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
