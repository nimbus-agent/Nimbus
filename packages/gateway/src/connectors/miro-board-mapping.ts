import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface MiroMappingContext {
  readonly syncedAt: number;
}

export type MiroMappedRow = MappedRow<"miro", "board">;

/**
 * Miro board timestamps (`createdAt`, `modifiedAt`) are ISO-8601 strings. Parse
 * to epoch-milliseconds; return null when unrecognizable.
 */
function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || v === "") {
    return null;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function deriveTitle(name: string | null, id: string): string {
  return name !== null && name !== "" ? name : `Miro board ${id}`;
}

export function mapMiroBoardToItem(raw: unknown, ctx: MiroMappingContext): MiroMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const description = stringField(row, "description") ?? null;
  const owner = asRecord(row["owner"]) ?? {};
  const ownerName = stringField(owner, "name") ?? null;
  const createdAt = parseIsoMs(row["createdAt"]);
  const modified = parseIsoMs(row["modifiedAt"]);
  const viewLink = stringField(row, "viewLink") ?? null;

  const modifiedAt = modified ?? createdAt ?? ctx.syncedAt;

  const title = deriveTitle(name, id);
  const bodyPreview =
    description !== null && description !== "" ? `${title} — ${description}` : title;

  const metadata: Record<string, unknown> = {
    id,
    name,
    description,
    owner_name: ownerName,
    createdAt,
    modifiedAt: modified,
    viewLink,
  };

  return {
    service: "miro",
    type: "board",
    externalId: id,
    title,
    bodyPreview,
    url: viewLink,
    canonicalUrl: viewLink,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
