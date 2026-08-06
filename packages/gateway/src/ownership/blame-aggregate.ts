import type { Database } from "bun:sqlite";

const MS_PER_DAY = 86_400_000;

export type FileAuthorWeight = {
  readonly filePath: string;
  readonly authorEmail: string;
  readonly authorName: string | null;
  readonly weightedLines: number;
  readonly rawLines: number;
  readonly lastTouchedMs: number;
};

export type BlameAggregate = {
  readonly rows: readonly FileAuthorWeight[];
  readonly filesCovered: number;
  readonly filesExcluded: number;
};

/**
 * Exponential recency decay. A line authored `halfLifeMs` ago counts half as
 * much as one authored now.
 *
 * A FUTURE `authorTimeMs` (clock skew, a rewritten commit date) is clamped to
 * weight 1 rather than allowed to exceed it: `0.5 ^ negative` is > 1 and would
 * let a single skewed line outweigh an entire file.
 */
export function lineWeight(authorTimeMs: number, nowMs: number, halfLifeMs: number): number {
  const ageMs = nowMs - authorTimeMs;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / halfLifeMs);
}

/**
 * `Bun.Glob` rather than a hand-rolled glob-to-regex translation: compiling a
 * user-supplied pattern into a backtracking regex is a ReDoS surface, and the
 * translation step is where that defect is usually introduced.
 *
 * Compilation is separated from matching because `aggregateBlameForRoot`
 * iterates BLAME LINES, not files. Constructing the glob set inside that loop
 * would build `lines × patterns` objects — on a 50k-line root with the 21
 * default patterns, over a million allocations for a decision that depends
 * only on the path.
 */
export function compileIgnoreGlobs(globs: readonly string[]): Bun.Glob[] {
  return globs.map((g) => new Bun.Glob(g));
}

export function matchesAnyCompiledGlob(filePath: string, compiled: readonly Bun.Glob[]): boolean {
  for (const g of compiled) {
    if (g.match(filePath)) return true;
  }
  return false;
}

/** String convenience over the compiled pair. Compiles on every call, so it is
 * for callers holding a single path — never for a hot loop. */
export function isIgnoredPath(filePath: string, globs: readonly string[]): boolean {
  return matchesAnyCompiledGlob(filePath, compileIgnoreGlobs(globs));
}

type BlameRow = {
  file_path: string;
  author_name: string | null;
  author_email: string | null;
  author_time_ms: number | null;
};

/**
 * Aggregate one root's blame into per-`(file, author)` weighted totals.
 *
 * Filtering happens HERE, not in the blame sync, on purpose: `git_blame_line`
 * is shared with `nimbus why`'s provenance lanes, which legitimately need to
 * answer "who last touched this lock-file line". Narrowing what gets blamed
 * would silently degrade an unrelated shipped feature.
 */
export function aggregateBlameForRoot(
  db: Database,
  repoRoot: string,
  opts: { nowMs: number; halfLifeDays: number; ignoreGlobs: readonly string[] },
): BlameAggregate {
  const halfLifeMs = Math.max(1, opts.halfLifeDays) * MS_PER_DAY;
  const rows = db
    .query(
      `SELECT file_path, author_name, author_email, author_time_ms
         FROM git_blame_line
        WHERE repo_root = ?
        ORDER BY file_path ASC, line_no ASC`,
    )
    .all(repoRoot) as BlameRow[];

  const acc = new Map<string, { row: FileAuthorWeight }>();
  const coveredFiles = new Set<string>();
  const excludedFiles = new Set<string>();

  // Compiled ONCE, then memoized PER FILE. The rows are blame LINES, so a
  // 5,000-line file would otherwise be glob-matched 5,000 times against every
  // pattern for a decision that depends only on the path. Compilation alone
  // fixes the allocation cost; the memo fixes the far larger match cost.
  const compiled = compileIgnoreGlobs(opts.ignoreGlobs);
  const ignoredByPath = new Map<string, boolean>();
  const isIgnored = (path: string): boolean => {
    const memo = ignoredByPath.get(path);
    if (memo !== undefined) return memo;
    const v = matchesAnyCompiledGlob(path, compiled);
    ignoredByPath.set(path, v);
    return v;
  };

  for (const r of rows) {
    if (isIgnored(r.file_path)) {
      excludedFiles.add(r.file_path);
      continue;
    }
    const email = r.author_email?.trim().toLowerCase() ?? "";
    if (email === "") continue;
    coveredFiles.add(r.file_path);

    // A NULL author_time_ms must decay to ~0, never to weight 1: an unknown
    // date is not evidence of recency.
    const t = r.author_time_ms ?? Number.NEGATIVE_INFINITY;
    const w = Number.isFinite(t) ? lineWeight(t, opts.nowMs, halfLifeMs) : 0;
    const lastTouched = Number.isFinite(t) ? t : 0;

    // A NUL codepoint is never present in a filesystem path or a trimmed
    // email, so it is a safe, collision-free composite-key separator (a
    // plain delimiter like "/" or " " could coincide with real path/email
    // characters and merge two distinct (file, author) pairs).
    const key = `${r.file_path}\u0000${email}`;
    const prev = acc.get(key);
    if (prev === undefined) {
      acc.set(key, {
        row: {
          filePath: r.file_path,
          authorEmail: email,
          authorName: r.author_name,
          weightedLines: w,
          rawLines: 1,
          lastTouchedMs: lastTouched,
        },
      });
      continue;
    }
    acc.set(key, {
      row: {
        ...prev.row,
        weightedLines: prev.row.weightedLines + w,
        rawLines: prev.row.rawLines + 1,
        lastTouchedMs: Math.max(prev.row.lastTouchedMs, lastTouched),
      },
    });
  }

  return {
    rows: [...acc.values()].map((v) => v.row),
    filesCovered: coveredFiles.size,
    filesExcluded: excludedFiles.size,
  };
}
