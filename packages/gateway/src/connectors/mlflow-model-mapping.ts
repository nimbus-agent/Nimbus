/**
 * Pure mapping from an MLflow Model Registry `RegisteredModel` object to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `mlflow-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "mlflow", type = "ml_model"` rows — a single item type.
 * `external_id = "model_<name>"` (registered-model names are unique per
 * registry). The `ml_model` type is sparse/structured (name, stage, status,
 * version, run id, short description), so it stays on local MiniLM embeddings
 * — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * A `RegisteredModel` carries the human name at `name`, the free-text
 * `description`, epoch-millisecond `creation_timestamp` /
 * `last_updated_timestamp`, an optional `latest_versions` array of model
 * versions, and an optional `tags` array of `{ key, value }` pairs. We descend
 * defensively with {@link asRecord} so a missing sub-object yields nulls
 * rather than throwing.
 *
 * IMPORTANT: MLflow timestamps are epoch MILLISECONDS (numbers), not ISO
 * strings — `creation_timestamp` / `last_updated_timestamp` come through
 * `numberField` directly with no Date.parse.
 *
 * Latest-version selection: among `latest_versions`, prefer the entry whose
 * `current_stage === "Production"`; otherwise pick the entry with the highest
 * numeric `version`.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MlflowMappingContext {
  /** MLflow tracking-server host — used to build canonical model URLs. */
  readonly host: string;
  readonly syncedAt: number;
}

export interface MlflowMappedRow {
  readonly service: "mlflow";
  readonly type: "ml_model";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/** Picked latest model version summary (or null when `latest_versions` is empty). */
interface LatestVersion {
  readonly version: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  readonly runId: string | null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Build the canonical URL for a registered model. MLflow's UI uses a hash
 * fragment route, and the model name is URL-encoded so names with spaces /
 * slashes / special characters resolve.
 */
export function modelUrl(host: string, name: string): string {
  return `${trimTrailingSlash(host)}/#/models/${encodeURIComponent(name)}`;
}

/** Parse a model-version `version` string to a number for max comparison; NaN sorts last. */
function versionNumber(versionStr: string | null): number {
  if (versionStr === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const n = Number.parseInt(versionStr, 10);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Select the latest model version: prefer the `Production`-stage entry, else
 * the entry with the highest numeric `version`. Returns null when there are
 * no parseable version entries.
 */
function pickLatestVersion(raw: unknown): LatestVersion | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  let best: Record<string, unknown> | null = null;
  let bestNum = Number.NEGATIVE_INFINITY;
  let production: Record<string, unknown> | null = null;
  for (const entry of raw) {
    const ver = asRecord(entry);
    if (ver === undefined) {
      continue;
    }
    if (stringField(ver, "current_stage") === "Production" && production === null) {
      production = ver;
    }
    const num = versionNumber(stringField(ver, "version") ?? null);
    if (best === null || num > bestNum) {
      best = ver;
      bestNum = num;
    }
  }
  const chosen = production ?? best;
  if (chosen === null) {
    return null;
  }
  return {
    version: stringField(chosen, "version") ?? null,
    stage: stringField(chosen, "current_stage") ?? null,
    status: stringField(chosen, "status") ?? null,
    runId: stringField(chosen, "run_id") ?? null,
  };
}

/** Flatten a `{ key, value }[]` tag array into a `key=value` string[]. */
function flattenTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    const tag = asRecord(entry);
    if (tag === undefined) {
      continue;
    }
    const key = stringField(tag, "key");
    if (key === undefined) {
      continue;
    }
    out.push(`${key}=${stringField(tag, "value") ?? ""}`);
  }
  return out;
}

export function mapMlflowModelToItem(
  raw: unknown,
  ctx: MlflowMappingContext,
): MlflowMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const name = stringField(row, "name");
  if (name === undefined) {
    return null;
  }

  const description = stringField(row, "description") ?? null;
  // MLflow timestamps are epoch ms — pass through as-is, no Date.parse.
  const createdAt = numberField(row, "creation_timestamp") ?? null;
  const updatedAt = numberField(row, "last_updated_timestamp") ?? null;

  const latestVersions = row["latest_versions"];
  const versionCount = Array.isArray(latestVersions) ? latestVersions.length : 0;
  const latest = pickLatestVersion(latestVersions);

  const tags = flattenTags(row["tags"]);

  const canonicalUrl = modelUrl(ctx.host, name);
  const title = name !== "" ? name : `Model ${name}`;
  const stageLabel = latest?.stage ?? "no versions";
  const bodyPreview = description ?? "";
  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    name,
    description,
    version_count: versionCount,
    latest_version: latest?.version ?? null,
    latest_stage: latest?.stage ?? null,
    latest_status: latest?.status ?? null,
    latest_run_id: latest?.runId ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
    tags,
    canonical_url: canonicalUrl,
  };
  // stageLabel feeds the human-readable summary line in metadata so a consumer
  // can render "<name> — <stage>" without re-deriving the stage.
  metadata["summary"] = `${title} — ${stageLabel}`;

  return {
    service: "mlflow",
    type: "ml_model",
    externalId: `model_${name}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
