import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import type { WhyInput, WhySubject } from "./why-types.ts";

const LINE_SUFFIX_RE = /^(.+):(\d+)$/;

export function parseRef(ref: string): { path: string; line: number | null } {
  const m = LINE_SUFFIX_RE.exec(ref);
  if (m === null) return { path: ref, line: null };
  const [, p, n] = m as unknown as [string, string, string];
  return { path: p, line: Number.parseInt(n, 10) };
}

export type ResolvedRootPath = { repoRoot: string; filePath: string };

/**
 * Map a user-supplied path onto a configured `[[filesystem.roots]]` entry.
 *
 * `repoRoot` is returned VERBATIM as configured because that exact string is
 * the `git_blame_line.repo_root` key filesystem-v2 stores (it never runs
 * `git rev-parse`); `filePath` is root-relative POSIX for the same reason.
 *
 * Returning null is the security fence: a path outside every configured root
 * must produce a gap note and ZERO blame spawns (see blame-on-demand.ts). Both
 * the absolute-path branch and the relative-path branch enforce containment
 * via `relative()` + startsWith("..")/isAbsolute checks before ever touching
 * `exists()` — a relative `../`-escape must be rejected regardless of whether
 * the joined path happens to exist on disk.
 */
export function matchConfiguredRoot(
  roots: readonly NimbusFilesystemRootToml[],
  refPath: string,
  exists: (p: string) => boolean = existsSync,
): ResolvedRootPath | null {
  if (isAbsolute(refPath)) {
    const abs = resolve(refPath);
    for (const r of roots) {
      const rel = relative(resolve(r.path), abs);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      return { repoRoot: r.path, filePath: rel.replaceAll("\\", "/") };
    }
    return null;
  }
  for (const r of roots) {
    const joined = join(r.path, refPath);
    const rel = relative(resolve(r.path), resolve(joined));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (exists(joined)) {
      return { repoRoot: r.path, filePath: rel.replaceAll("\\", "/") };
    }
  }
  return null;
}

function lookupSymbol(
  db: Database,
  token: string,
): { file: string; repoRoot: string; lineNo: number | null; name: string } | null {
  const row = (db
    .query(
      `SELECT json_extract(e.metadata, '$.file')     AS file,
              json_extract(e.metadata, '$.repoRoot') AS repo_root,
              json_extract(e.metadata, '$.name')     AS name,
              CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'symbol' AND json_extract(e.metadata, '$.name') = ?
        LIMIT 1`,
    )
    .get(token) ??
    db
      .query(
        `SELECT json_extract(e.metadata, '$.file')     AS file,
                json_extract(e.metadata, '$.repoRoot') AS repo_root,
                json_extract(e.metadata, '$.name')     AS name,
                CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
           FROM graph_entity e
           JOIN item i ON i.id = e.external_id
          WHERE e.type = 'symbol' AND e.label LIKE '%' || ? || '%'
          ORDER BY length(e.label) ASC, e.id ASC
          LIMIT 1`,
      )
      .get(token)) as {
    file?: string;
    repo_root?: string;
    name?: string;
    start_line?: number | null;
  } | null;
  if (
    row?.file === undefined ||
    row.file === null ||
    row.repo_root === undefined ||
    row.repo_root === null
  ) {
    return null;
  }
  return {
    file: row.file,
    repoRoot: row.repo_root,
    lineNo: row.start_line ?? null,
    name: row.name ?? token,
  };
}

export function resolveWhySubject(
  db: Database,
  roots: readonly NimbusFilesystemRootToml[],
  input: WhyInput,
  exists: (p: string) => boolean = existsSync,
): WhySubject | null {
  const parsed = parseRef(input.ref);
  const line = input.line ?? parsed.line;

  const asPath = matchConfiguredRoot(roots, parsed.path, exists);
  if (asPath !== null) {
    return { repoRoot: asPath.repoRoot, filePath: asPath.filePath, lineNo: line, symbol: null };
  }

  const sym = lookupSymbol(db, parsed.path);
  if (sym !== null) {
    return {
      repoRoot: sym.repoRoot,
      filePath: sym.file,
      lineNo: line ?? sym.lineNo,
      symbol: sym.name,
    };
  }
  return null;
}
