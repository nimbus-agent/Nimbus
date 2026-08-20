export type ItemListQueryParams = {
  readonly services?: readonly string[];
  readonly types?: readonly string[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
  /**
   * Restrict to exactly this id set — e.g. the rows a negation-predicate query
   * (`buildNotTouchingSql` / `buildNoDownstreamIncidentSql`) returned. AND-ed with every other
   * filter, so this composes as an intersection, never a union. `undefined` means "no
   * restriction" (unchanged default behavior); an EMPTY array means "nothing qualifies" and must
   * still return zero rows — SQLite has no `IN ()` syntax for a zero-length list, so that case is
   * special-cased to a literal false rather than emitted as an empty `IN (...)` clause.
   */
  readonly ids?: readonly string[];
  /**
   * Restrict via `id IN (<sql>)` where `<sql>` is a caller-supplied SELECT — e.g. a negation
   * predicate's own query (`buildNotTouchingSql` / `buildNoDownstreamIncidentSql`), embedded as a
   * subquery rather than materialised into a bind-parameter list. This is the mechanism a large
   * matching set must use: SQLite has a ~65,535 bind-parameter ceiling per statement, so `ids`
   * above (one parameter per id) throws on a large index, while a subquery costs exactly the
   * `<sql>`'s own parameter count regardless of how many rows it matches.
   *
   * `sql` MUST use only plain, unnumbered `?` placeholders — never `?1`-style numbered ones. This
   * filter's `vals` are spliced into the SAME flat, positionally-bound array as every other filter
   * here, in the order filters are appended; a numbered placeholder would desynchronize SQLite's
   * own auto-numbering from that array's order and misbind. Callers embedding a predicate built
   * with numbered placeholders must renumber them to plain `?` first (see
   * `toPositionalSubquery` in `index/negation-predicates.ts`).
   *
   * Mutually exclusive with `ids` in practice (a caller needing both would just AND two `id IN`
   * clauses, which this type does not prevent, but no current caller does).
   */
  readonly idInSql?: { readonly sql: string; readonly vals: readonly (string | number)[] };
};

export function buildItemListSql(params: ItemListQueryParams): {
  sql: string;
  vals: Array<string | number>;
} {
  const filters: string[] = [];
  const vals: Array<string | number> = [];
  const services = params.services ?? [];
  const types = params.types ?? [];
  if (services.length > 0) {
    const ph = services.map(() => "?").join(", ");
    filters.push(`service IN (${ph})`);
    vals.push(...services);
  }
  if (types.length === 1 && types[0] !== undefined) {
    filters.push("type = ?");
    vals.push(types[0]);
  } else if (types.length > 1) {
    const ph = types.map(() => "?").join(", ");
    filters.push(`type IN (${ph})`);
    vals.push(...types);
  }
  if (params.ids !== undefined) {
    if (params.ids.length === 0) {
      filters.push("1 = 0");
    } else {
      const ph = params.ids.map(() => "?").join(", ");
      filters.push(`id IN (${ph})`);
      vals.push(...params.ids);
    }
  }
  if (params.idInSql !== undefined) {
    filters.push(`id IN (${params.idInSql.sql})`);
    vals.push(...params.idInSql.vals);
  }
  if (params.sinceMs !== undefined) {
    filters.push("modified_at >= ?");
    vals.push(params.sinceMs);
  }
  if (params.untilMs !== undefined) {
    filters.push("modified_at <= ?");
    vals.push(params.untilMs);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT id, service, type, external_id, title, body_preview, url, canonical_url,
                      modified_at, author_id, metadata, synced_at, pinned
               FROM item ${where} ORDER BY modified_at DESC LIMIT ?`;
  vals.push(params.limit);
  return { sql, vals };
}

export function parseRelativeSinceToWindowMs(raw: string, nowMs: number): number | undefined {
  const s = raw.trim();
  const m = /^(\d+)\s*([dhms])$/i.exec(s);
  if (m === null) {
    return undefined;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  const unit = m[2]?.toLowerCase() ?? "";
  let windowMs = 0;
  switch (unit) {
    case "d":
      windowMs = n * 24 * 60 * 60 * 1000;
      break;
    case "h":
      windowMs = n * 60 * 60 * 1000;
      break;
    case "m":
      windowMs = n * 60 * 1000;
      break;
    case "s":
      windowMs = n * 1000;
      break;
    default:
      return undefined;
  }
  return nowMs - Math.floor(windowMs);
}
