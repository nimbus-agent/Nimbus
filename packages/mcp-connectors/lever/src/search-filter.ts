export interface LeverSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function categoryField(row: Record<string, unknown>, key: string): string {
  const cats = row["categories"];
  if (cats === null || typeof cats !== "object" || Array.isArray(cats)) {
    return "";
  }
  const v = (cats as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const text = stringField(row, "text");
  const state = stringField(row, "state");
  const team = categoryField(row, "team");
  const department = categoryField(row, "department");
  const location = categoryField(row, "location");
  return `${text} ${state} ${team} ${department} ${location} ${tagText(row)}`.toLowerCase();
}

export function filterLeverPostings(
  postings: readonly unknown[],
  options: LeverSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of postings) {
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
