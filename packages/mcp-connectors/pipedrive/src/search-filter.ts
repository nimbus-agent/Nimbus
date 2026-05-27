/**
 * Pure substring-match filter for `pipedrive_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * title/status/org_name/person_name/owner_name/label haystack + case-insensitive
 * substring match.
 */

export interface PipedriveSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const title = stringField(row, "title");
  const status = stringField(row, "status");
  // Pipedrive denormalizes the linked person / organization / owner names onto
  // the deal object as `person_name` / `org_name` / `owner_name`.
  const orgName = stringField(row, "org_name");
  const personName = stringField(row, "person_name");
  const ownerName = stringField(row, "owner_name");
  const label = stringField(row, "label");
  return `${title} ${status} ${orgName} ${personName} ${ownerName} ${label}`.toLowerCase();
}

export function filterPipedriveDeals(
  deals: readonly unknown[],
  options: PipedriveSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of deals) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    if (!buildHaystack(row).includes(needle)) {
      continue;
    }
    out.push(it);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
