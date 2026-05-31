import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface DagsterMappingContext {
  /**
   * The per-tenant host root (Dagster Cloud `https://<org>.dagster.cloud/<deployment>`
   * or a self-hosted OSS `http://localhost:3000`). Used to derive a best-effort
   * canonical job url.
   */
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type DagsterMappedRow = MappedRow<"dagster", "job">;

const TITLE_MAX = 200;

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Dagster pipeline `tags` are a list of `{ key, value }` objects. */
function tagPairs(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const t of raw) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const key = stringField(row, "key");
    if (key === undefined || key === "") {
      continue;
    }
    out.push({ key, value: stringField(row, "value") ?? "" });
  }
  return out;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const v = stringField(row, key);
  return v !== undefined && v !== "" ? v : null;
}

function clampTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

/**
 * Best-effort canonical url. Dagster's job permalink is
 * `<base_url>/locations/<location>/jobs/<jobName>`; when either piece is
 * unavailable we return null rather than a guess.
 */
function jobUrl(baseUrl: string, location: string | null, jobName: string): string | null {
  if (baseUrl === "" || location === null) {
    return null;
  }
  try {
    // Validate the host root parses as a URL before constructing the permalink.
    new URL(baseUrl);
  } catch {
    return null;
  }
  return `${trimTrailingSlash(baseUrl)}/locations/${encodeURIComponent(
    location,
  )}/jobs/${encodeURIComponent(jobName)}`;
}

export interface DagsterFlatJob {
  /** The pipeline (job) name — the stable human-readable id component. */
  readonly name: string;
  readonly repository: string;
  readonly location: string | null;
  readonly raw: Record<string, unknown>;
}

/**
 * Map a single flattened Dagster job (a `pipelines[]` entry already paired with
 * its repository + location) into an `IndexedItem` row.
 *
 * Item id is the stable, human-readable `dagster:<location>:<repository>:<jobName>`
 * — NOT the opaque base64 `id`, which can change across redeploys.
 */
export function mapDagsterJobToItem(
  job: DagsterFlatJob,
  ctx: DagsterMappingContext,
): DagsterMappedRow | null {
  const name = job.name.trim();
  if (name === "") {
    return null;
  }
  const repository = job.repository.trim();
  if (repository === "") {
    return null;
  }
  const location = job.location;
  const externalId = `${location ?? "_"}:${repository}:${name}`;

  const row = job.raw;
  const description = optionalString(row, "description");
  const isJob = row["isJob"] === true;
  const tags = tagPairs(row["tags"]);

  const label = name;
  const title = clampTitle(description !== null ? `${label} — ${description}` : label);
  const bodyPreview = description !== null ? `${label}: ${description}` : `Dagster job: ${label}`;

  const canonicalUrl = jobUrl(ctx.baseUrl, location, name);

  const metadata: Record<string, unknown> = {
    name,
    repository,
    location,
    description,
    is_job: isJob,
    tags: tags.map((t) => `${t.key}=${t.value}`),
    tag_keys: tags.map((t) => t.key),
    canonical_url: canonicalUrl,
  };

  return {
    service: "dagster",
    type: "job",
    externalId,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
