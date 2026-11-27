import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface SplitMappingContext {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly syncedAt: number;
}

/** No canonical URL: Split's web app routes by organisation and environment ids the list lacks. */
export type SplitMappedRow = MappedRow<"split", "feature_flag", null>;

/** Tags shown per split. */
const MAX_TAGS = 50;

function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const t of value) {
    const row = asRecord(t);
    const name = row === undefined ? undefined : stringField(row, "name");
    if (name !== undefined && name !== "") out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, MAX_TAGS);
}

function nameOf(v: unknown): string | null {
  const row = asRecord(v);
  return row === undefined ? null : (stringField(row, "name") ?? null);
}

/**
 * One split (feature flag) DEFINITION from `GET /splits/ws/{workspaceId}`: name, description,
 * traffic type, tags, rollout status and creation time. Per-environment treatments, rules and the
 * killed state are not indexed (they are read live with `split_definition_get`).
 */
export function mapSplitToItem(raw: unknown, ctx: SplitMappingContext): SplitMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const name = stringField(row, "name");
  if (name === undefined || name === "") return null;

  const description = stringField(row, "description") ?? null;
  const created = numberField(row, "creationTime");
  const createdAtMs = created !== undefined && Number.isFinite(created) ? created : null;

  const metadata: Record<string, unknown> = {
    name,
    split_id: stringField(row, "id") ?? null,
    description,
    traffic_type: nameOf(row["trafficType"]),
    tags: tagNames(row["tags"]),
    rollout_status: nameOf(row["rolloutStatus"]),
    workspace_id: ctx.workspaceId,
    workspace_name: ctx.workspaceName,
    created_at: createdAtMs,
  };

  return {
    service: "split",
    type: "feature_flag",
    externalId: `${ctx.workspaceId}:${name}`,
    title: name,
    bodyPreview: description ?? name,
    url: null,
    canonicalUrl: null,
    modifiedAt: createdAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
