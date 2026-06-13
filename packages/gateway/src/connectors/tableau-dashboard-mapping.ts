import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type TableauMappedRow = MappedRow<"tableau", "dashboard">;

export interface TableauMappingContext {
  readonly syncedAt: number;
}

const SERVICE = "tableau" as const;
const TYPE = "dashboard" as const;

export function mapTableauViewToItem(
  raw: unknown,
  ctx: TableauMappingContext,
): TableauMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const luid = stringField(r, "luid");
  const name = stringField(r, "name");
  if (luid === undefined || luid === "" || name === undefined || name === "") return null;
  const author = stringField(r, "author") ?? null;
  const folder = stringField(r, "folder") ?? null;
  const extractRefreshStatus = stringField(r, "extractRefreshStatus") ?? null;
  const rawTables = Array.isArray(r["dataSourceTables"]) ? r["dataSourceTables"] : [];
  const upstreamDataModelKeys = rawTables
    .filter((t): t is string => typeof t === "string" && t !== "")
    .map((t) => normalizeDataModelKey(t))
    .filter((k): k is string => k !== null);
  const authorSuffix = author === null ? "" : ` · ${author}`;
  return {
    service: SERVICE,
    type: TYPE,
    externalId: `tableau:${luid}`,
    title: name,
    bodyPreview: `Tableau dashboard${authorSuffix}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.syncedAt,
    metadata: { upstreamDataModelKeys, author, folder, extractRefreshStatus },
    syncedAt: ctx.syncedAt,
  };
}
