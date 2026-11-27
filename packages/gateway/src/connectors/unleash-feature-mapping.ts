import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface UnleashMappingContext {
  /** The instance root (`unleashInstanceRoot`): no trailing slash, no `/api`. */
  readonly root: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly syncedAt: number;
}

export type UnleashMappedRow = MappedRow<"unleash", "feature_flag", string>;

/** Tags shown per flag; Unleash tags are `{ type, value }`, kept as `type:value`. */
const MAX_TAGS = 50;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function tagLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const t of value) {
    const row = asRecord(t);
    const v = row === undefined ? undefined : stringField(row, "value");
    if (row === undefined || v === undefined || v === "") continue;
    const type = stringField(row, "type");
    out.push(type === undefined || type === "" ? v : `${type}:${v}`);
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, MAX_TAGS);
}

/** The Unleash admin UI page of one feature flag. */
export function unleashFeatureUrl(root: string, projectId: string, name: string): string {
  return `${root}/projects/${encodeURIComponent(projectId)}/features/${encodeURIComponent(name)}`;
}

/**
 * One feature flag DEFINITION from `GET /api/admin/projects/{id}/features`: name, type,
 * description, stale state, tags and timestamps. Per-environment enabled state and strategies are
 * not indexed (they change often and are read live with `unleash_feature_state_get`).
 */
export function mapUnleashFeatureToItem(
  raw: unknown,
  ctx: UnleashMappingContext,
): UnleashMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const name = stringField(row, "name");
  if (name === undefined || name === "") return null;

  const type = stringField(row, "type") ?? null;
  const description = stringField(row, "description") ?? null;
  const createdAtMs = parseIsoMs(row["createdAt"]);
  const lastSeenAtMs = parseIsoMs(row["lastSeenAt"]);
  const canonicalUrl = unleashFeatureUrl(ctx.root, ctx.projectId, name);

  const metadata: Record<string, unknown> = {
    name,
    type,
    description,
    tags: tagLabels(row["tags"]),
    stale: row["stale"] === true,
    archived: row["archived"] === true || typeof row["archivedAt"] === "string",
    impression_data: row["impressionData"] === true,
    project_id: ctx.projectId,
    project_name: ctx.projectName,
    created_at: createdAtMs,
    last_seen_at: lastSeenAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "unleash",
    type: "feature_flag",
    externalId: `${ctx.projectId}:${name}`,
    title: name,
    bodyPreview: description ?? name,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: createdAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
