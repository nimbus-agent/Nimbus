import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { gitBlameLinePorcelain } from "../../connectors/filesystem-v2-sync.ts";
import { type BlameLookup, lookupBlame, upsertBlameLines } from "../../security/blame-store.ts";
import type { ResolvedRootPath } from "./why-subject.ts";

export type BlameSpawn = typeof Bun.spawn;

/**
 * Blame one line on demand, cached forever after.
 *
 * The path fence has two layers: callers obtain a ResolvedRootPath (or the
 * shape-compatible `WhySubject`) only through `resolveWhySubject`, which
 * enforces containment in a currently configured root on EVERY branch — the
 * literal-path branch via `matchConfiguredRoot` (a path outside every
 * configured root resolves to null upstream), and the symbol branch via its
 * own inline `repoRoot`-membership check (a symbol's metadata is never
 * implicitly trusted, since it did not come from resolving a caller path
 * against the roots list) — and this function independently refuses to spawn
 * unless `<repoRoot>/.git` exists. The spawn itself is the existing
 * `gitBlameLinePorcelain` — argv after `--`, 20 s AbortSignal, failure → [].
 * A local git read: not a connector dispatch (no I29), not a write gate (no I2).
 */
export async function ensureBlameLine(
  db: Database,
  subject: ResolvedRootPath,
  lineNo: number,
  spawn: BlameSpawn = Bun.spawn,
): Promise<BlameLookup | null> {
  const cached = lookupBlame(db, subject.repoRoot, subject.filePath, lineNo);
  if (cached !== null) return cached;

  if (!existsSync(join(subject.repoRoot, ".git"))) return null;

  const rows = await gitBlameLinePorcelain(
    subject.repoRoot,
    subject.filePath,
    [{ from: lineNo, to: lineNo }],
    spawn,
  );
  if (rows.length === 0) return null;

  upsertBlameLines(db, subject.repoRoot, subject.filePath, rows);
  return lookupBlame(db, subject.repoRoot, subject.filePath, lineNo);
}
