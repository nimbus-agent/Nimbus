/**
 * Pure mapping from a LaunchDarkly v2 feature-flag rep to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `launchdarkly-sync.ts` so the REST path and the indexing path can be
 * tested independently.
 *
 * Emits `service = "launchdarkly", type = "feature_flag"` rows. The
 * `feature_flag` type is sparse/structured (key, name, state), so it stays
 * on local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 */

import { asRecord, stringField } from "./unknown-record.ts";

type Kind = "boolean" | "multivariate";
const KINDS: ReadonlySet<string> = new Set(["boolean", "multivariate"]);

export interface LaunchDarklyMappingContext {
  /** App base URL — used to construct canonical flag URLs. */
  readonly baseUrl: string;
  /** Project key the flag belongs to. */
  readonly projectKey: string;
  readonly syncedAt: number;
}

export interface LaunchDarklyMappedRow {
  readonly service: "launchdarkly";
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

export function flagUrl(baseUrl: string, projectKey: string, flagKey: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}`;
}

function pickEnum<T extends string>(value: unknown, set: ReadonlySet<string>): T | null {
  if (typeof value !== "string") {
    return null;
  }
  return set.has(value) ? (value as T) : null;
}

function numberField(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((t): t is string => typeof t === "string");
}

/** Returns { envKeys (sorted), states (envKey→on bool), maxLastModified }. */
function extractEnvironments(value: unknown): {
  readonly envKeys: string[];
  readonly states: Record<string, boolean>;
  readonly maxLastModified: number | null;
} {
  const root = asRecord(value);
  if (root === undefined) {
    return { envKeys: [], states: {}, maxLastModified: null };
  }
  const envKeys = Object.keys(root).sort();
  const states: Record<string, boolean> = {};
  let maxLastModified: number | null = null;
  for (const k of envKeys) {
    const env = asRecord(root[k]) ?? {};
    states[k] = env["on"] === true;
    const lm = numberField(env, "lastModified");
    if (lm !== null && (maxLastModified === null || lm > maxLastModified)) {
      maxLastModified = lm;
    }
  }
  return { envKeys, states, maxLastModified };
}

export function mapLaunchDarklyFlagToItem(
  raw: unknown,
  ctx: LaunchDarklyMappingContext,
): LaunchDarklyMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const description = stringField(row, "description") ?? null;
  const kind = pickEnum<Kind>(row["kind"], KINDS);
  const tags = extractTags(row["tags"]);
  const maintainer = stringField(asRecord(row["_maintainer"]) ?? {}, "email") ?? null;
  const maintainerId = stringField(row, "maintainerId") ?? null;
  const variations = Array.isArray(row["variations"]) ? row["variations"].length : 0;
  const createdAt = numberField(row, "creationDate");
  const { envKeys, states, maxLastModified } = extractEnvironments(row["environments"]);

  const modifiedAt = maxLastModified ?? createdAt ?? ctx.syncedAt;
  const canonicalUrl = flagUrl(ctx.baseUrl, ctx.projectKey, key);
  const title = name ?? key;
  const bodyPreview = description ?? title;

  const metadata: Record<string, unknown> = {
    key,
    name,
    kind,
    project_key: ctx.projectKey,
    tags,
    temporary: row["temporary"] === true,
    archived: row["archived"] === true,
    maintainer,
    maintainer_id: maintainerId,
    description,
    variation_count: variations,
    environments: envKeys,
    env_states: states,
    created_at: createdAt,
    updated_at: maxLastModified,
    canonical_url: canonicalUrl,
  };

  return {
    service: "launchdarkly",
    type: "feature_flag",
    externalId: `${ctx.projectKey}:${key}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
