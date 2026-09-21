import { stripComments } from "../lib.ts";
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
 * `meta[...]` / `metadata[...]`, with or without the `?.` optional-chaining operator, keyed by a
 * single- or double-quoted literal — the JS-side counterpart to `metadataKeyRegex` above.
 * `metrics/dora.ts:110` reads `if (meta?.["conclusion"] !== "success") continue;`: optional
 * chaining, which a plain `meta\[` pattern does not match. `conclusion` is one of the keys the
 * DORA bug turns on, so a regex without the `(?:\?\.)?` alternation would miss the read on the
 * very lane this gate was built for. Built fresh per call, never module-level — Task 1.2's hazard
 * (a shared `g`-flagged RegExp across nested/recursive scans hangs `bun test` rather than failing).
 */
function jsMetadataReadRegex(): RegExp {
  return /\bmeta(?:data)?(?:\?\.)?\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g;
}

/** Matches a `function <name>(` declaration head, exported or not. Built fresh per call, same reason. */
function functionHeadRegex(): RegExp {
  return /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
}

/**
 * Cross-file manifest of helper functions that read a metadata key on the caller's behalf.
 * `dora.ts:60`'s `repoLikeMatchesUrn` is how `repo` hides from a per-call-site window — a
 * same-file helper the census would otherwise never see the key of; `metrics/service-identity
 * .ts:68`'s `repoMetadataMatchesUrn` is a second binder with the same shape, found during
 * feasibility and not yet verified end to end. The manifest exists precisely so the extractor
 * never has to resolve which call site reaches which helper (that is a call graph, out of scope
 * here) — it scans the DEFINITION wherever one appears and attributes the keys there.
 *
 * **Currently subsumed, stated rather than left implicit:** `collectJsMetadataReads`'s whole-file
 * pass already scans every byte of a file, including a listed helper's own body, so today this
 * manifest does no work a plain whole-file scan would not already do on its own — the two named
 * helpers' bodies use the literal `metadata["key"]` shape the whole-file regex already matches.
 * It is retained, not because it is load-bearing yet, but because it becomes load-bearing the
 * moment the direct pass narrows to a bounded per-call-site window (the shape the design spec
 * describes, §4.2.2) instead of the whole file — at that point a same-file helper's keys stop
 * being visible except through this manifest. Until then, this is a defensive/forward-declared
 * mechanism, not an active one.
 */
export const METADATA_READER_HELPERS: readonly string[] = [
  "repoLikeMatchesUrn",
  "repoMetadataMatchesUrn",
];

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

  collectJsMetadataReads(contents, file, out);

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

/**
 * Adds one `item`/`metadata-key` triple for every JS-side metadata read found anywhere in
 * comment-stripped `contents` — only `item` rows carry a JSON `metadata` column read this way in
 * v1 — plus every key read inside the body of a same-named function declaration listed in
 * `METADATA_READER_HELPERS`. A helper's own body is already part of `contents`, so the two passes
 * necessarily overlap; `addUniqueTriple` is what keeps that overlap from surfacing as duplicate
 * rows while still making the manifest's promise ("a helper contributes its keys at its definition
 * site") true by construction, not by accident of the whole-file pass's reach.
 *
 * **The blanket `item` attribution is a measured bound, not a structural guarantee.** `graph_entity`
 * and `graph_relation` both carry their own `metadata TEXT` column (`index/graph-v7-sql.ts:8,23`),
 * so a file that parses ONE of those rows' metadata the same way (`meta["key"]`/`metadata["key"]`,
 * with or without `?.`) would be misattributed to `item` here — the exact cross-table conflation
 * this whole gate exists to prevent, arriving through the JS door instead of the SQL one the rest
 * of this file guards against with `resolveTable`. Measured against every non-test file under
 * `packages/gateway/src`, not assumed: zero of them contain a JS metadata read that touches only
 * graph tables — every real match found (`negotiate.ts`, `graph-populator.ts`) reads `item.metadata`
 * (or an `IndexedItemGraphInput`'s `row.metadata`, itself an item field) even in files that are
 * otherwise all about `graph_entity`/`graph_relation`. This breaks the day someone parses a
 * `graph_entity.metadata` or `graph_relation.metadata` value with this same JS shape in a non-test
 * file — re-measure before trusting `item` attribution again if that ever happens, rather than
 * assuming this comment is still true.
 */
function collectJsMetadataReads(contents: string, file: string, out: ReadTriple[]): void {
  const stripped = stripComments(contents);

  scanJsMetadataReads(stripped, stripped, 0, file, out);

  for (const helper of findHelperBodies(stripped)) {
    scanJsMetadataReads(stripped, helper.body, helper.start, file, out);
  }
}

/** A named helper's body text plus the absolute index (into the comment-stripped file) it starts at. */
type HelperBody = { readonly body: string; readonly start: number };

/**
 * Locates every `function <name>(...) { ... }` declaration in `src` whose name is listed in
 * `METADATA_READER_HELPERS` and returns its body text plus where that body starts. Finding the
 * call site that *reaches* a helper is explicitly out of scope — that is a call graph — this only
 * has to find the DEFINITION, wherever it appears in the file.
 */
function findHelperBodies(src: string): readonly HelperBody[] {
  const out: HelperBody[] = [];
  const re = functionHeadRegex();
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const name = m[1];
    if (name !== undefined && METADATA_READER_HELPERS.includes(name)) {
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = findMatchingDelimiter(src, parenOpen, "(", ")");
      const braceOpen = parenClose === -1 ? -1 : src.indexOf("{", parenClose);
      const braceClose = braceOpen === -1 ? -1 : findMatchingDelimiter(src, braceOpen, "{", "}");
      if (braceOpen !== -1 && braceClose !== -1) {
        out.push({ body: src.slice(braceOpen + 1, braceClose), start: braceOpen + 1 });
      }
    }
    m = re.exec(src);
  }
  return out;
}

/**
 * Returns the index of the `close` delimiter matching the `open` delimiter at `openIndex`,
 * respecting single-, double-, and template-quoted strings so a stray brace/paren inside a string
 * literal never unbalances the count. Returns -1 if it never closes.
 */
function findMatchingDelimiter(
  src: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = findStringLiteralEnd(src, i, ch);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Finds the index of the closing quote matching `quote` at `start`, skipping `\\` escapes. A
 * single-/double-quoted string cannot legitimately span an unescaped newline; a template literal
 * can.
 */
function findStringLiteralEnd(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (quote !== "`" && ch === "\n") return -1;
    i++;
  }
  return -1;
}

/**
 * Scans `text` (a slice of `fullStripped` starting at `baseIndex`) for JS-side metadata reads,
 * attributing each to `item` with a line number recovered from its absolute position in
 * `fullStripped`.
 */
function scanJsMetadataReads(
  fullStripped: string,
  text: string,
  baseIndex: number,
  file: string,
  out: ReadTriple[],
): void {
  const re = jsMetadataReadRegex();
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const value = m[1];
    if (value !== undefined) {
      const line = lineAtIndex(fullStripped, baseIndex + m.index);
      addUniqueTriple(out, { table: "item", kind: "metadata-key", value, file, line });
    }
    m = re.exec(text);
  }
}

/** 1-indexed line of `index` within `src`, same counting rule as `sql-literals.ts`'s `lineAt`. */
function lineAtIndex(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

/**
 * Pushes `candidate` only if an identical triple is not already present. The whole-file JS pass
 * and the named-helper-body pass necessarily overlap (a helper's body is part of the whole file),
 * and this is what keeps that overlap from surfacing as duplicate rows.
 */
function addUniqueTriple(out: ReadTriple[], candidate: ReadTriple): void {
  const exists = out.some(
    (t) =>
      t.table === candidate.table &&
      t.kind === candidate.kind &&
      t.value === candidate.value &&
      t.file === candidate.file &&
      t.line === candidate.line,
  );
  if (!exists) out.push(candidate);
}
