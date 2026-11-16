import type { Database } from "bun:sqlite";

/**
 * Resolves what the user typed after `linear:` to ONE indexed Linear project row.
 *
 * Accepted, first rung that finds at least one row decides: the project UUID, its `slugId` (the
 * 12-hex id at the end of the project URL, case-insensitive), the full project URL (its trailing
 * `-<slugId>` path segment, else the stored canonical URL), then the exact project name
 * (case-insensitive in JS: SQLite `lower()` would not fold non-ASCII).
 *
 * Every failure is a thrown error with a clear message; none is an empty brief and none reads as
 * "no risk". The match runs in JS over one capped listing of project rows.
 */

export type ResolvedLinearProject = {
  /** The `item.id` (`linear:<uuid>`). */
  readonly itemId: string;
  /** The Linear project UUID: the join key children carry in `project_id`. */
  readonly externalId: string;
  readonly title: string;
  readonly slugId: string | null;
  /** The human reference shown for the project: its slug id, else its name; never the UUID. */
  readonly displayKey: string;
  readonly createdAtMs: number | null;
};

type ProjectRow = {
  id: string;
  external_id: string;
  title: string;
  url: string | null;
  slug_id: string | null;
  created_at_ms: number | null;
};

const MAX_PROJECT_ROWS = 2_000;
const MAX_LISTED_CANDIDATES = 5;

/** The `slugId` at the end of a Linear project URL path (`.../project/<name>-<slugId>`), or null. */
function slugFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter((s) => s !== "");
  const at = segments.indexOf("project");
  const last = at === -1 ? undefined : segments[at + 1];
  if (last === undefined) {
    return null;
  }
  const dash = last.lastIndexOf("-");
  return dash === -1 ? last : last.slice(dash + 1);
}

function isUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function matchRung(rows: readonly ProjectRow[], key: string): ProjectRow[] {
  const byUuid = rows.filter((r) => r.external_id === key);
  if (byUuid.length > 0) {
    return byUuid;
  }
  const lowered = key.toLowerCase();
  const bySlug = rows.filter((r) => r.slug_id !== null && r.slug_id.toLowerCase() === lowered);
  if (bySlug.length > 0) {
    return bySlug;
  }
  if (isUrl(key)) {
    const fromUrl = slugFromUrl(key)?.toLowerCase();
    const viaUrlSlug =
      fromUrl === undefined
        ? []
        : rows.filter((r) => r.slug_id !== null && r.slug_id.toLowerCase() === fromUrl);
    if (viaUrlSlug.length > 0) {
      return viaUrlSlug;
    }
    const canonical = stripTrailingSlash(key);
    const viaUrl = rows.filter((r) => r.url !== null && stripTrailingSlash(r.url) === canonical);
    if (viaUrl.length > 0) {
      return viaUrl;
    }
  }
  return rows.filter((r) => r.title.toLowerCase() === lowered);
}

/** A project name is third-party text bound for an error line: no control, format or separator characters. */
function plain(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

function describeCandidate(r: ProjectRow): string {
  return r.slug_id === null ? plain(r.title) : `${plain(r.title)} (${plain(r.slug_id)})`;
}

function toResolved(r: ProjectRow): ResolvedLinearProject {
  return {
    itemId: r.id,
    externalId: r.external_id,
    title: r.title,
    slugId: r.slug_id,
    displayKey: r.slug_id ?? r.title,
    createdAtMs: r.created_at_ms,
  };
}

// lane-census: scope=project service=linear
function listProjectRows(db: Database): ProjectRow[] {
  return db
    .query(
      `SELECT id, external_id, title, url,
              CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.slug_id') END AS slug_id,
              CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.created_at_ms') END AS created_at_ms
         FROM item
        WHERE service = 'linear' AND type = 'project'
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(MAX_PROJECT_ROWS) as ProjectRow[];
}

/** Resolves `key` (the text after `linear:`, or a bare Linear URL) or throws a clear error. */
export function resolveLinearProject(
  db: Database,
  epicRef: string,
  key: string,
): ResolvedLinearProject {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new Error(
      `pre-mortem: '${epicRef}' names no Linear project (pass the slug id, the project URL, the UUID or the exact name)`,
    );
  }
  const rows = listProjectRows(db);
  if (rows.length === 0) {
    throw new Error(
      "pre-mortem: no Linear projects are indexed (the project pass has not run yet, the sync is " +
        "not connected, or the token cannot list projects); run `nimbus connector status linear`",
    );
  }
  const matches = matchRung(rows, trimmed);
  const [only] = matches;
  if (only === undefined) {
    throw new Error(
      `pre-mortem: '${epicRef}' was not found among ${String(rows.length)} indexed Linear projects`,
    );
  }
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_LISTED_CANDIDATES).map(describeCandidate).join(", ");
    const more = matches.length > MAX_LISTED_CANDIDATES ? ", ..." : "";
    throw new Error(
      `pre-mortem: '${epicRef}' matches ${String(matches.length)} indexed Linear projects ` +
        `(${shown}${more}). Pass the slug id or the project URL.`,
    );
  }
  return toResolved(only);
}
