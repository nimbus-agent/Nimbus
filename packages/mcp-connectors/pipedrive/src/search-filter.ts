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
