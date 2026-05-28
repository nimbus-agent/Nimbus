export interface DbtSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function field(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const name = field(row, "name");
  const version = field(row, "dbt_version");
  const id = field(row, "id");
  return `${name} ${version} ${id}`.toLowerCase();
}

export function filterDbtJobs(jobs: readonly unknown[], options: DbtSearchMatchOptions): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of jobs) {
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
