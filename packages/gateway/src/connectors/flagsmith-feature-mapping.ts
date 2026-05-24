/**
 * Pure mapping from a Flagsmith feature-flag definition to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `flagsmith-sync.ts` so the REST path and the indexing path can be
 * tested independently.
 *
 * Emits `service = "flagsmith", type = "feature_flag"` rows. The
 * `feature_flag` type is sparse/structured (name, type, flags), so it stays
 * on local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 */

import { asRecord, stringField } from "./unknown-record.ts";

export interface FlagsmithMappingContext {
  /** API base URL — used to derive the user-facing app host for canonical URLs. */
  readonly apiBase: string;
  /** Numeric project id the feature belongs to. */
  readonly projectId: number;
  /** Human-readable project name. */
  readonly projectName: string;
  /** Map of tag id → label, resolved from `/projects/{id}/tags/`. */
  readonly tagMap: Record<number, string>;
  readonly syncedAt: number;
}

export interface FlagsmithMappedRow {
  readonly service: "flagsmith";
  readonly type: "feature_flag";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/**
 * Derive the user-facing Flagsmith app base from the API base. Flagsmith's
 * API host is `api.flagsmith.com`; the dashboard host is `app.flagsmith.com`.
 * We rewrite a leading `api.` to `app.`; any other host (self-hosted) is
 * passed through unchanged. On parse failure, falls back to the SaaS app host.
 */
export function appBaseFromApiBase(apiBase: string): string {
  try {
    const u = new URL(apiBase);
    const host = u.hostname.startsWith("api.") ? `app.${u.hostname.slice(4)}` : u.hostname;
    const portSuffix = u.port === "" ? "" : `:${u.port}`;
    return `${u.protocol}//${host}${portSuffix}`;
  } catch {
    return "https://app.flagsmith.com";
  }
}

/**
 * Build the canonical URL for a feature. Per-feature deep links require an
 * environment (deferred follow-up), so the honest canonical target is the
 * project page.
 */
export function featureUrl(apiBase: string, projectId: number): string {
  return `${appBaseFromApiBase(apiBase)}/project/${encodeURIComponent(String(projectId))}`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function resolveTags(value: unknown, tagMap: Record<number, string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const labels: string[] = [];
  for (const id of value) {
    if (typeof id !== "number") {
      continue;
    }
    const label = tagMap[id];
    if (label !== undefined && label !== "") {
      labels.push(label);
    }
  }
  return labels.sort((a, b) => a.localeCompare(b));
}

export function mapFlagsmithFeatureToItem(
  raw: unknown,
  ctx: FlagsmithMappingContext,
): FlagsmithMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const name = stringField(row, "name");
  if (name === undefined || name === "") {
    return null;
  }

  const type = stringField(row, "type") ?? null;
  const initialValue = stringField(row, "initial_value") ?? null;
  const description = stringField(row, "description") ?? null;
  const tags = resolveTags(row["tags"], ctx.tagMap);
  const ownerCount = Array.isArray(row["owners"]) ? row["owners"].length : 0;
  const createdAtMs = parseIsoMs(row["created_date"]);

  const modifiedAt = createdAtMs ?? ctx.syncedAt;
  const canonicalUrl = featureUrl(ctx.apiBase, ctx.projectId);
  const title = name;
  const bodyPreview = description ?? title;

  const metadata: Record<string, unknown> = {
    name,
    type,
    default_enabled: row["default_enabled"] === true,
    initial_value: initialValue,
    description,
    tags,
    is_archived: row["is_archived"] === true,
    owner_count: ownerCount,
    project_id: ctx.projectId,
    project_name: ctx.projectName,
    created_at: createdAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "flagsmith",
    type: "feature_flag",
    externalId: `${ctx.projectId}:${name}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
