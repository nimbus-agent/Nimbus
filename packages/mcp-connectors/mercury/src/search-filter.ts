export interface MercurySearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const id = stringField(row, "id");
  const name = stringField(row, "name");
  const status = stringField(row, "status");
  const type = stringField(row, "type");
  const kind = stringField(row, "kind");
  const legalBusinessName = stringField(row, "legalBusinessName");
  return `${id} ${name} ${status} ${type} ${kind} ${legalBusinessName}`.toLowerCase();
}

export function filterMercuryAccounts(
  accounts: readonly unknown[],
  options: MercurySearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of accounts) {
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
