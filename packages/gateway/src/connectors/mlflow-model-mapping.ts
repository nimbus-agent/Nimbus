import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MlflowMappingContext {
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

interface LatestVersion {
  readonly version: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  readonly runId: string | null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function modelUrl(host: string, name: string): string {
  return `${trimTrailingSlash(host)}/#/models/${encodeURIComponent(name)}`;
}

function versionNumber(versionStr: string | null): number {
  if (versionStr === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const n = Number.parseInt(versionStr, 10);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

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
  const createdAt = numberField(row, "creation_timestamp") ?? null;
  const updatedAt = numberField(row, "last_updated_timestamp") ?? null;

  const latestVersions = row["latest_versions"];
  const versionCount = Array.isArray(latestVersions) ? latestVersions.length : 0;
  const latest = pickLatestVersion(latestVersions);

  const tags = flattenTags(row["tags"]);

  const canonicalUrl = modelUrl(ctx.host, name);
  const title = name === "" ? `Model ${name}` : name;
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
