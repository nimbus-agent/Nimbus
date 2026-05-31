import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface FigmaMappingContext {
  readonly syncedAt: number;
  /** Project name carried alongside the file (the file object has no project name). */
  readonly projectName: string | null;
}

export type FigmaMappedRow = MappedRow<"figma", "file">;

/**
 * Figma file `last_modified` is an ISO-8601 string. Parse to epoch-milliseconds;
 * return null when unrecognizable.
 */
function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || v === "") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function deriveTitle(name: string | null, key: string): string {
  return name !== null && name !== "" ? name : `Figma file ${key}`;
}

export function mapFigmaFileToItem(raw: unknown, ctx: FigmaMappingContext): FigmaMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const thumbnailUrl = stringField(row, "thumbnail_url") ?? null;
  const lastModified = parseIsoMs(row["last_modified"]);

  const modifiedAt = lastModified ?? ctx.syncedAt;
  const url = `https://www.figma.com/file/${key}`;

  const title = deriveTitle(name, key);
  const bodyPreview =
    ctx.projectName !== null && ctx.projectName !== "" ? `${title} — ${ctx.projectName}` : title;

  const metadata: Record<string, unknown> = {
    key,
    name,
    project_name: ctx.projectName,
    thumbnail_url: thumbnailUrl,
    last_modified: lastModified,
  };

  return {
    service: "figma",
    type: "file",
    externalId: key,
    title,
    bodyPreview,
    url,
    canonicalUrl: url,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
