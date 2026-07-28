import type { Database } from "bun:sqlite";
import { resolve } from "node:path";

export type DemoSymbol = { file: string; line: number; name: string };

type DemoSymbolRow = {
  file?: string | null;
  name?: string | null;
  start_line?: number | null;
};

const DEMO_SYMBOL_SQL = `SELECT json_extract(e.metadata, '$.file') AS file,
              json_extract(e.metadata, '$.name') AS name,
              CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'symbol'
          AND json_extract(e.metadata, '$.file') IS NOT NULL
          AND json_extract(e.metadata, '$.repoRoot') IN (?, ?)
          AND CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) > 0
        ORDER BY length(e.label) ASC, e.id ASC
        LIMIT 1`;

/**
 * Pick a symbol to show off `nimbus why` after a first sync.
 *
 * Queries the index rather than the filesystem: `nimbus why` resolves symbols,
 * so anything this returns is guaranteed resolvable. A lockfile, a config file,
 * or a binary asset can never be selected because none of them become symbols.
 * Shorter labels first, so the suggestion is a plain function name in a shallow
 * path rather than a deeply-qualified one.
 *
 * `file` is returned root-relative, exactly as `filesystem-v2-sync` stores it —
 * that is also the form `matchConfiguredRoot` accepts, so the printed
 * `nimbus why <file>:<line>` resolves.
 *
 * The root is matched against BOTH the caller's string and its `resolve()`d
 * form. `parseNimbusTomlFilesystemRoots` already resolves every root before
 * sync stores it, so the resolved spelling is the one that hits — but matching
 * the verbatim string too costs nothing and covers a caller passing the raw
 * config value. Both are bound parameters, so the query stays index-friendly
 * and bounded instead of scanning every symbol in the repo.
 *
 * Returns null rather than throwing on an index with no graph tables: this
 * feeds a cosmetic suggestion line, and a missing-table error must not fail the
 * command that prints it.
 */
export function pickDemoSymbol(db: Database, repoRoot: string): DemoSymbol | null {
  let row: DemoSymbolRow | null;
  try {
    row = db.query(DEMO_SYMBOL_SQL).get(resolve(repoRoot), repoRoot) as DemoSymbolRow | null;
  } catch {
    return null;
  }

  const file = row?.file ?? undefined;
  const line = row?.start_line ?? undefined;
  if (file === undefined || line === undefined) {
    return null;
  }
  return { file, line, name: row?.name ?? "symbol" };
}
