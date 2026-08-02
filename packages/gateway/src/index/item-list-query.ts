export type ItemListQueryParams = {
  readonly services?: readonly string[];
  readonly types?: readonly string[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
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
