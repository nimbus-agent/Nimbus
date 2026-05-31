import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface DependencyTrackMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type DependencyTrackMappedRow = MappedRow<"dependencytrack", "project">;

const TITLE_MAX = 200;

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function projectUrl(baseUrl: string, uuid: string): string {
  return `${trimTrailingSlash(baseUrl)}/projects/${encodeURIComponent(uuid)}`;
}

function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    const row = asRecord(t);
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

function clampTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

export function mapDependencyTrackProjectToItem(
  raw: unknown,
  ctx: DependencyTrackMappingContext,
): DependencyTrackMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const uuid = stringField(row, "uuid");
  if (uuid === undefined || uuid === "") {
    return null;
  }

  const name = stringField(row, "name");
  if (name === undefined || name === "") {
    return null;
  }

  const version = stringField(row, "version") ?? null;
  const classifier = stringField(row, "classifier") ?? null;
  const active = row["active"] === true;
  const lastBomImport = numberField(row, "lastBomImport") ?? null;
  const tags = tagNames(row["tags"]);

  const metrics = asRecord(row["metrics"]);
  const critical = metrics === undefined ? null : (numberField(metrics, "critical") ?? null);
  const high = metrics === undefined ? null : (numberField(metrics, "high") ?? null);
  const medium = metrics === undefined ? null : (numberField(metrics, "medium") ?? null);
  const low = metrics === undefined ? null : (numberField(metrics, "low") ?? null);
  const vulnerabilities =
    metrics === undefined ? null : (numberField(metrics, "vulnerabilities") ?? null);
  const components = metrics === undefined ? null : (numberField(metrics, "components") ?? null);

  const canonicalUrl = projectUrl(ctx.baseUrl, uuid);
  const title = clampTitle(version !== null && version !== "" ? `${name} ${version}` : name);
  const bodyPreview = `${classifier ?? "PROJECT"}: ${name}${version !== null ? ` ${version}` : ""}`;
  const modifiedAt = lastBomImport ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    uuid,
    name,
    version,
    classifier,
    active,
    last_bom_import: lastBomImport,
    tags,
    critical,
    high,
    medium,
    low,
    vulnerabilities,
    components,
    canonical_url: canonicalUrl,
  };

  return {
    service: "dependencytrack",
    type: "project",
    externalId: uuid,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
