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
