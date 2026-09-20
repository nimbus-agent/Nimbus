import { bindAliases, type TableName } from "./alias-binding.ts";
import { extractSqlLiterals, type SqlLiteral } from "./sql-literals.ts";

/**
 * One production READ site: a SQL predicate that filters on `<table>.type` (equality or `IN`) or
 * on a `json_extract(metadata, '$.<key>')` key, resolved to the specific tracked table it reads
 * from. This is the shape the census compares against what connectors actually WRITE — a triple
 * that never shows up on the write side is a dead lane.
 */
export type ReadTriple = {
  readonly table: TableName;
  readonly kind: "type" | "metadata-key";
  readonly value: string;
  readonly file: string;
  readonly line: number;
};

/**
 * `[qualifier.]type = 'value'`. The qualifier group is optional so a bare `type = 'x'` (no table
 * alias in front) still matches — resolving *which* table that bare form means is `resolveTable`'s
 * job, not this regex's.
 */
function typeEqualityRegex(): RegExp {
  return /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s*=\s*'([a-z0-9_]+)'/gi;
}

/**
 * `[qualifier.]type IN (…)`. Not optional — `agents/impact.ts` and `agents/negotiate.ts` both
 * filter this way, and an equality-only extractor would silently omit them. The captured list is
 * whatever sits between the parens, unparsed; splitting it into individual literals is
 * `collectTypeIn`'s job.
 */
function typeInRegex(): RegExp {
  return /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s+in\s*\(\s*([^)]+)\)/gi;
}

/** `json_extract([qualifier.]metadata, '$.<key>')`. The qualifier group is optional, same reason as above. */
function metadataKeyRegex(): RegExp {
  return /json_extract\(\s*(?:([a-z_][a-z0-9_]*)\.)?metadata\s*,\s*'\$\.([A-Za-z0-9_]+)'/gi;
}

/** Matches a single quoted literal that fills an entire (trimmed) `TYPE_IN` list item. */
function quotedListItemRegex(): RegExp {
  return /^\s*'([a-z0-9_]+)'\s*$/i;
}

/**
 * Extracts every `type`/`metadata` read predicate from `contents`, bound to the tracked table it
 * actually reads from. Composes `extractSqlLiterals` (1.1) for the raw SQL string literals and
 * `bindAliases` (1.2) for alias resolution — this file adds only the predicate regexes and the
 * ambiguity rule on top.
 */
export function extractReadTriples(file: string, contents: string): readonly ReadTriple[] {
  const out: ReadTriple[] = [];

  for (const literal of extractSqlLiterals(contents)) {
    const aliases = bindAliases(literal.sql);
    const distinctTables = distinctBoundTables(aliases);

    collectTypeEquality(literal, aliases, distinctTables, file, out);
    collectTypeIn(literal, aliases, distinctTables, file, out);
    collectMetadataKey(literal, aliases, distinctTables, file, out);
  }

  return out;
}

/** The set of distinct tables bound anywhere in an alias map — the ambiguity check reads its size, not the map's. */
function distinctBoundTables(aliases: ReadonlyMap<string, TableName>): ReadonlySet<TableName> {
  return new Set(aliases.values());
}

/**
 * Resolves a predicate's qualifier to a tracked table, or `undefined` when it should be skipped
 * rather than guessed at:
 * - a qualified name (`i.type`) resolves via the alias map, or is skipped if it binds to nothing;
 * - an unqualified name (`type`) resolves to the single bound table when exactly one is bound, and
 *   is skipped when more than one is — recording it anyway would reintroduce the exact cross-table
 *   conflation this gate exists to prevent.
 */
function resolveTable(
  qualifier: string | undefined,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
): TableName | undefined {
  if (qualifier !== undefined) {
    return aliases.get(qualifier);
  }
  if (distinctTables.size === 1) {
    const [only] = distinctTables;
    return only;
  }
  return undefined;
}

/** 1-indexed line of `indexInSql`, as the literal's start line plus the newline offset within it. */
function lineFor(literal: SqlLiteral, indexInSql: number): number {
  let offset = 0;
  for (let i = 0; i < indexInSql; i++) {
    if (literal.sql[i] === "\n") offset++;
  }
  return literal.line + offset;
}

function collectTypeEquality(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = typeEqualityRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const value = m[2];
    if (table !== undefined && value !== undefined) {
      out.push({ table, kind: "type", value, file, line: lineFor(literal, m.index) });
    }
    m = re.exec(literal.sql);
  }
}

function collectTypeIn(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = typeInRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const list = m[2] ?? "";
    if (table !== undefined) {
      const line = lineFor(literal, m.index);
      for (const item of list.split(",")) {
        const literalMatch = quotedListItemRegex().exec(item);
        const value = literalMatch?.[1];
        if (value !== undefined) {
          out.push({ table, kind: "type", value, file, line });
        }
      }
    }
    m = re.exec(literal.sql);
  }
}

function collectMetadataKey(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = metadataKeyRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const value = m[2];
    if (table !== undefined && value !== undefined) {
      out.push({ table, kind: "metadata-key", value, file, line: lineFor(literal, m.index) });
    }
    m = re.exec(literal.sql);
  }
}
