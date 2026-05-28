export interface BitriseSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function pickString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

export function filterBitriseBuilds(
  builds: readonly unknown[],
  options: BitriseSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of builds) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    const branch = pickString(row, "branch");
    const commitMessage = pickString(row, "commit_message");
    const workflow = pickString(row, "triggered_workflow");
    const statusText = pickString(row, "status_text");
    const hay = `${branch} ${commitMessage} ${workflow} ${statusText}`.toLowerCase();
    if (hay.includes(needle)) {
      out.push(it);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}
