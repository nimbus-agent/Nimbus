/**
 * Binds every FROM/JOIN alias (and CTE name) in a raw SQL string literal to the underlying base
 * table it reads from, for the three tables this gate cares about.
 *
 * Table-awareness is the whole point of this file. Three tables carry a bare `type` column —
 * `item`, `graph_entity`, `graph_relation` — and a scanner that treats "the string 'commit' shows
 * up near `type`" as one undifferentiated signal cannot tell `graph/graph-populator.ts` writing
 * `type: "commit"` to `graph_entity` apart from `agents/expert.ts` reading `i.type = 'commit'`
 * from `item`, which nothing writes. Task 1.3 needs to know, for a given SQL literal, which table
 * each alias in it actually names — that's this file's one job.
 */

export type TableName = "item" | "graph_entity" | "graph_relation";

const TABLES: ReadonlySet<TableName> = new Set(["item", "graph_entity", "graph_relation"]);

function isKnownTable(name: string): name is TableName {
  return (TABLES as ReadonlySet<string>).has(name);
}

/**
 * Words that can never be bound as an alias, whether they show up as the identifier right after
 * `FROM`/`JOIN` (should never happen given the keyword-boundary regex below, but a CTE name could
 * theoretically collide) or as the alias token that follows a table name. Matched case-insensitively.
 */
const RESERVED = new Set([
  "as",
  "on",
  "where",
  "select",
  "group",
  "order",
  "left",
  "inner",
  "outer",
  "join",
  "union",
  "having",
  "limit",
]);

/**
 * Matches `FROM <table> [[AS] <alias>]` or `JOIN <table> [[AS] <alias>]`. The alias group is
 * optional and itself bounded to a bare identifier, so `FROM item WHERE …` never captures `WHERE`
 * as an alias — `WHERE` fails the identifier-then-optional-second-identifier shape only because a
 * reserved-word guard below rejects it, since the regex alone cannot know `WHERE` is a keyword.
 *
 * Built fresh per call (never a shared module-level instance): `bindAliases` recurses into CTE
 * bodies, and a `g`-flagged `RegExp`'s `lastIndex` is mutable shared state — a shared instance
 * would have an inner call's loop-to-completion reset `lastIndex` to 0 out from under an
 * in-progress outer loop, re-matching the first CTE forever.
 */
function sourceRegex(): RegExp {
  return /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
}

/** Matches a CTE definition's `<name> AS (` opening, capturing the name. Built fresh per call — see `sourceRegex`. */
function cteHeadRegex(): RegExp {
  return /\b([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
}

/**
 * Binds every alias in `sql` to one of the three tracked tables. The map carries the bare table
 * name as its own key, every FROM/JOIN alias, and every CTE name — the last resolved transitively,
 * since a CTE can itself select from another CTE.
 */
export function bindAliases(sql: string): ReadonlyMap<string, TableName> {
  return bindAliasesSeeded(sql, EMPTY_MAP);
}

const EMPTY_MAP: ReadonlyMap<string, TableName> = new Map();

/**
 * `bindAliases`'s real body, taking a `seed` of already-resolved names an enclosing scope wants
 * visible while binding `sql` — the mechanism that makes CTE resolution transitive across
 * siblings, not only across nesting. When a CTE body's own bind (`resolvePrimaryTable`) can't
 * resolve a name, it falls through to whatever the enclosing `bindCtes` pass has resolved so far
 * (e.g. `wrapped AS (SELECT id FROM base)` needs `base`'s binding, resolved moments earlier by the
 * same top-level `bindCtes` loop, to be visible here — a fresh, unseeded recursive call could
 * never see it, since each recursive `bindAliases` otherwise starts from nothing).
 */
function bindAliasesSeeded(
  sql: string,
  seed: ReadonlyMap<string, TableName>,
): Map<string, TableName> {
  const map = new Map<string, TableName>(seed);

  bindCtes(sql, map);
  bindSources(sql, map);

  return map;
}

/**
 * First pass: find every `<name> AS ( <body> )` CTE definition, recursively bind the body, and
 * map the CTE name to the first table the body resolves to (or nothing, if the body never
 * resolves to one of the three tracked tables). Nested CTEs inside the body are picked up too,
 * since the head regex keeps scanning past the opening paren rather than skipping the body span.
 */
function bindCtes(sql: string, map: Map<string, TableName>): void {
  const cteHead = cteHeadRegex();
  let head: RegExpExecArray | null = cteHead.exec(sql);
  while (head !== null) {
    const name = head[1] ?? "";
    if (!RESERVED.has(name.toLowerCase())) {
      const openParenIndex = head.index + head[0].length - 1;
      const closeParenIndex = findMatchingParen(sql, openParenIndex);
      if (closeParenIndex !== -1) {
        const body = sql.slice(openParenIndex + 1, closeParenIndex);
        const resolved = resolvePrimaryTable(body, map);
        if (resolved !== undefined) {
          map.set(name, resolved);
        }
      }
    }
    head = cteHead.exec(sql);
  }
}

/**
 * Second pass: walk every FROM/JOIN across the whole string. A source token already bound as a
 * CTE (present in `map` from the first pass, not in `TABLES`) is not re-classified — its binding
 * is reused as-is — but an alias trailing it is still recorded, so `FROM ranked r` binds `r` too.
 * A source token that is neither a known table nor an already-bound CTE name binds nothing.
 */
function bindSources(sql: string, map: Map<string, TableName>): void {
  const source = sourceRegex();
  let m: RegExpExecArray | null = source.exec(sql);
  while (m !== null) {
    const tableToken = m[1] ?? "";
    const aliasToken = m[2];

    if (!RESERVED.has(tableToken.toLowerCase())) {
      let resolved: TableName | undefined;
      if (isKnownTable(tableToken)) {
        resolved = tableToken;
        map.set(tableToken, resolved);
      } else {
        resolved = map.get(tableToken);
      }

      if (
        resolved !== undefined &&
        aliasToken !== undefined &&
        !RESERVED.has(aliasToken.toLowerCase())
      ) {
        map.set(aliasToken, resolved);
      }
    }

    m = source.exec(sql);
  }
}

/**
 * Recursively binds `body` (a CTE's own SELECT), seeded with everything the enclosing scope has
 * resolved so far, then walks the body's FROM/JOIN occurrences in source order to find the first
 * one that resolves to a tracked table — directly, through an alias, through a nested CTE the
 * recursive bind resolved, or through a sibling CTE resolved earlier in the same enclosing pass
 * (via `seed`). That's "the table this CTE reads from", even when the body joins several things.
 */
function resolvePrimaryTable(
  body: string,
  seed: ReadonlyMap<string, TableName>,
): TableName | undefined {
  const bodyMap = bindAliasesSeeded(body, seed);

  const localSource = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m: RegExpExecArray | null = localSource.exec(body);
  while (m !== null) {
    const token = m[1] ?? "";
    if (!RESERVED.has(token.toLowerCase())) {
      const resolved = bodyMap.get(token);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    m = localSource.exec(body);
  }

  return undefined;
}

/**
 * Returns the index of the `)` matching the `(` at `openIndex`, respecting single- and
 * double-quoted string literals (SQL's `''`-escaped quote included) so a stray paren inside a
 * quoted value never unbalances the count. Returns -1 if the paren never closes.
 */
function findMatchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = findQuoteEnd(sql, i, ch);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Finds the index of the closing quote matching `quote` at `startIndex`, treating a doubled quote
 * (`''`) as an escaped literal quote rather than the end of the string — SQL's own escape rule.
 */
function findQuoteEnd(sql: string, startIndex: number, quote: string): number {
  let i = startIndex + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}
