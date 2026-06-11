import type { Database } from "bun:sqlite";

export interface ResolvedToken {
  /** The graph entity id when one resolved, else null. */
  readonly entityId: string | null;
  /** A machine-portable match token: a symbol/repo-relative label, else the file basename. */
  readonly token: string;
}

function basename(fileOrPath: string): string {
  const parts = fileOrPath.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.at(-1) ?? fileOrPath;
}

/**
 * Resolve a user-supplied file argument to a machine-portable match token. Prefers the local
 * graph's symbol label (service-relative, e.g. a repo-relative path) so the token matches across
 * machines; falls back to the file basename. Never returns the absolute local path.
 */
export function resolveMatchToken(db: Database, fileArg: string): ResolvedToken {
  const base = basename(fileArg);
  const exact = db
    .query("SELECT id, label FROM graph_entity WHERE type = 'symbol' AND label = ? LIMIT 1")
    .get(fileArg) as { id?: string; label?: string } | null;
  if (exact?.id !== undefined && exact.label !== undefined) {
    return { entityId: exact.id, token: exact.label };
  }
  const byBase = db
    .query(
      "SELECT id, label FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%' " +
        "ORDER BY length(label) ASC, id ASC LIMIT 1",
    )
    .get(base) as { id?: string; label?: string } | null;
  if (byBase?.id !== undefined && byBase.label !== undefined) {
    return { entityId: byBase.id, token: byBase.label };
  }
  return { entityId: null, token: base };
}

/** Local check: does a symbol whose label contains `token` still exist in the graph? */
export function symbolExistsLocally(db: Database, token: string): boolean {
  const row = db
    .query(
      "SELECT 1 AS hit FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%' LIMIT 1",
    )
    .get(token) as { hit?: number } | null;
  return row?.hit === 1;
}
