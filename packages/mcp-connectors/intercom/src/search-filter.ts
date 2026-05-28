export interface IntercomSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagText(row: Record<string, unknown>): string {
  const tags = asRecord(row["tags"]);
  const list = tags === undefined ? undefined : tags["tags"];
  if (!Array.isArray(list)) {
    return "";
  }
  const names: string[] = [];
  for (const t of list) {
    const obj = asRecord(t);
    if (obj === undefined) {
      continue;
    }
    const name = obj["name"];
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const state = stringField(row, "state");
  const source = asRecord(row["source"]) ?? {};
  const subject = stringField(source, "subject");
  const body = stringField(source, "body");
  const author = asRecord(source["author"]) ?? {};
  const authorName = stringField(author, "name");
  const authorEmail = stringField(author, "email");
  return `${subject} ${body} ${state} ${authorName} ${authorEmail} ${tagText(row)}`.toLowerCase();
}

export function filterIntercomConversations(
  conversations: readonly unknown[],
  options: IntercomSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of conversations) {
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
