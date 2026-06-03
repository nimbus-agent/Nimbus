import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Local-only reader for saved SQL queries. This module is the MCP-server-side
 * counterpart of the gateway's `mapLocalDbQueryToItem` mapper: it reads `.sql`
 * files from the configured local DB-tool scripts dir (DBeaver/DataGrip/pgAdmin
 * exports) and returns their TEXT + lightweight metadata for semantic recall.
 *
 * No database is ever connected to and no query is ever executed — this is a
 * pure filesystem read, bounded and path-traversal-guarded.
 */

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;
const PREVIEW_MAX_CHARS = 4000;

export interface SavedQuery {
  /** Path relative to the configured scripts dir — the stable id. */
  readonly relativePath: string;
  readonly title: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  /** SQL text, capped. */
  readonly preview: string;
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function baseTitle(relativePath: string): string {
  const segments = relativePath.split(/[/\\]/);
  const last = segments[segments.length - 1] ?? relativePath;
  return last.replace(/\.sql$/i, "");
}

/**
 * Resolve the configured scripts dir from the environment. Throws when unset so
 * the MCP tools surface a clear error rather than reading an empty path.
 */
export function scriptsDir(): string {
  const dir = process.env["LOCALDB_SCRIPTS_DIR"]?.trim();
  if (dir === undefined || dir === "") {
    throw new Error("LOCALDB_SCRIPTS_DIR is not set");
  }
  return resolve(dir);
}

/**
 * Path-traversal guard: confirm `candidate` (an absolute resolved path) is the
 * scripts dir itself or a descendant. Rejects `..`-escaping inputs.
 */
export function assertWithinScriptsDir(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    return;
  }
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path escapes the configured local DB scripts dir");
  }
}

async function collectSqlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function readSavedQuery(path: string, root: string): Promise<SavedQuery | null> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return null;
    }
    const sql = buf.toString("utf8");
    if (sql.trim() === "") {
      return null;
    }
    let sizeBytes = buf.byteLength;
    try {
      const info = await stat(path);
      sizeBytes = Number.isFinite(info.size) ? info.size : buf.byteLength;
    } catch {
      sizeBytes = buf.byteLength;
    }
    const relativePath = relative(root, path);
    return {
      relativePath,
      title: baseTitle(relativePath) || relativePath,
      sizeBytes,
      lineCount: sql.split("\n").length,
      preview: clamp(sql, PREVIEW_MAX_CHARS),
    };
  } catch {
    return null;
  }
}

/** Read all saved `.sql` queries under the configured scripts dir (bounded). */
export async function scanSavedQueries(): Promise<SavedQuery[]> {
  const root = scriptsDir();
  const files = await collectSqlFiles(root);
  const out: SavedQuery[] = [];
  for (const file of files) {
    assertWithinScriptsDir(file, root);
    const q = await readSavedQuery(file, root);
    if (q !== null) {
      out.push(q);
    }
  }
  return out;
}

/** Read one saved query by its relative path (path-guarded). */
export async function getSavedQuery(relativePath: string): Promise<SavedQuery | null> {
  const root = scriptsDir();
  const candidate = resolve(root, relativePath);
  assertWithinScriptsDir(candidate, root);
  return readSavedQuery(candidate, root);
}

/** Substring search over saved-query title / relative path / SQL text. */
export function filterSavedQueries(queries: readonly SavedQuery[], query: string): SavedQuery[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...queries];
  }
  return queries.filter(
    (sq) =>
      sq.title.toLowerCase().includes(q) ||
      sq.relativePath.toLowerCase().includes(q) ||
      sq.preview.toLowerCase().includes(q),
  );
}
