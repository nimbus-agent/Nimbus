export interface StackOverflowSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
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
    } else if (t !== null && typeof t === "object") {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names.join(" ");
}

function ownerName(row: Record<string, unknown>): string {
  const owner = row["owner"];
  if (owner === null || typeof owner !== "object") {
    return "";
  }
  const name = (owner as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const title = stringField(row, "title");
  const body = stringField(row, "body");
  const bodyMarkdown = stringField(row, "bodyMarkdown");
  return `${title} ${body} ${bodyMarkdown} ${tagText(row)} ${ownerName(row)}`.toLowerCase();
}

export function filterStackOverflowQuestions(
  questions: readonly unknown[],
  options: StackOverflowSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of questions) {
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
