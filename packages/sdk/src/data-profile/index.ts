/**
 * Pure data-profile parsing utilities (Tier-5, no-row-data).
 *
 * Shared between `packages/gateway` (data-profile-mapping / data-profile-sync)
 * and `packages/mcp-connectors/dataprofile`. Neither package can import the
 * other (gateway ↔ mcp boundary), so the PURE, I/O-free logic lives here.
 *
 * HARD SCOPE CONSTRAINT (security): NEVER reads cell values / row samples /
 * first-N-row previews. Only keys, types, and structural metadata are extracted.
 */

const MAX_COLUMNS = 512;

/** A parsed column — name + its JS/Parquet kind. Type is null when unknown (e.g. CSV). */
export interface DataColumn {
  readonly name: string;
  /** Column kind (parquet physical type, or the JS type of a JSONL/JSON field). Null when unknown (CSV). */
  readonly type: string | null;
}

/** hyparquet metadata shape (the fields we read — schema + row count from the footer). */
export interface ParquetMetadataLike {
  readonly schema?: ReadonlyArray<{ name?: unknown; type?: unknown }>;
  readonly num_rows?: number | bigint;
}

/** The JS "kind" of a value — name only, never the value itself. */
export function jsKind(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
}

/**
 * Parse a CSV header line into column names. A simple comma split with optional
 * surrounding-quote stripping — heuristic (does not handle embedded quoted
 * commas), sufficient for column-NAME extraction. NEVER reads data rows.
 */
export function parseCsvHeader(firstLine: string): DataColumn[] {
  const line = firstLine.replace(/\r$/, "");
  if (line.trim() === "") {
    return [];
  }
  return line
    .split(",")
    .slice(0, MAX_COLUMNS)
    .map((raw) => {
      const name = raw
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      return { name, type: null } satisfies DataColumn;
    });
}

/**
 * Extract field names + JS kinds from the first JSONL object. Reads ONLY the
 * keys + value KINDS of the first record — never stores any value. Returns []
 * if the line is not a JSON object.
 */
export function parseJsonlColumns(firstLine: string): DataColumn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  return Object.entries(parsed as Record<string, unknown>)
    .slice(0, MAX_COLUMNS)
    .map(([name, value]) => ({ name, type: jsKind(value) }) satisfies DataColumn);
}

/**
 * Profile a parsed JSON document's top-level shape. An array of objects → columns
 * from the first element + rowCount = array length; a single object → columns
 * from its keys, rowCount null. Reads keys + value KINDS only, never values.
 */
export function parseJsonColumns(parsed: unknown): {
  columns: DataColumn[];
  rowCountEstimate: number | null;
} {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return {
        columns: Object.entries(first as Record<string, unknown>)
          .slice(0, MAX_COLUMNS)
          .map(([name, value]) => ({ name, type: jsKind(value) })),
        rowCountEstimate: parsed.length,
      };
    }
    return { columns: [], rowCountEstimate: parsed.length };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return {
      columns: Object.entries(parsed as Record<string, unknown>)
        .slice(0, MAX_COLUMNS)
        .map(([name, value]) => ({ name, type: jsKind(value) })),
      rowCountEstimate: null,
    };
  }
  return { columns: [], rowCountEstimate: null };
}

/**
 * Extract columns + row count from parsed Parquet footer metadata. Leaf schema
 * elements (those with a physical `type`) are the columns; the root/group
 * elements (no `type`) are skipped. NO row data is read — this operates on the
 * footer metadata only.
 */
export function parquetColumnsFromMetadata(meta: ParquetMetadataLike): {
  columns: DataColumn[];
  rowCountEstimate: number | null;
} {
  const schema = Array.isArray(meta.schema) ? meta.schema : [];
  const columns: DataColumn[] = [];
  for (const el of schema) {
    if (el !== null && typeof el === "object" && typeof el.name === "string" && el.type != null) {
      columns.push({ name: el.name, type: String(el.type) });
      if (columns.length >= MAX_COLUMNS) {
        break;
      }
    }
  }
  const nr = meta.num_rows;
  const finiteRowCount = typeof nr === "number" && Number.isFinite(nr) ? nr : null;
  const rowCountEstimate = typeof nr === "bigint" ? Number(nr) : finiteRowCount;
  return { columns, rowCountEstimate };
}

/**
 * First line + a newline-based row estimate from already-read text (no row data).
 * When truncated (file exceeded the peek cap) rowCountEstimate is null.
 */
export function firstLineAndRows(
  text: string,
  truncated: boolean,
): { firstLine: string; rowCountEstimate: number | null } {
  const idx = text.indexOf("\n");
  const firstLine = idx === -1 ? text : text.slice(0, idx);
  if (truncated) {
    return { firstLine, rowCountEstimate: null };
  }
  const nl = (text.match(/\n/g) ?? []).length;
  return { firstLine, rowCountEstimate: Math.max(0, text.endsWith("\n") ? nl : nl + 1) };
}
