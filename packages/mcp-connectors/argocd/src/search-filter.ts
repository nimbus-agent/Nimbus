export interface ArgocdSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

function nestedString(root: Record<string, unknown>, path: readonly string[]): string {
  let cur: Record<string, unknown> | undefined = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = asObject(cur?.[path[i] ?? ""]);
    if (cur === undefined) {
      return "";
    }
  }
  const leaf = cur?.[path[path.length - 1] ?? ""];
  return typeof leaf === "string" ? leaf : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const parts = [
    nestedString(row, ["metadata", "name"]),
    nestedString(row, ["spec", "project"]),
    nestedString(row, ["spec", "source", "repoURL"]),
    nestedString(row, ["status", "sync", "status"]),
    nestedString(row, ["status", "health", "status"]),
  ];
  return parts.join(" ").toLowerCase();
}

export function filterArgocdApplications(
  apps: readonly unknown[],
  options: ArgocdSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of apps) {
    const row = asObject(it);
    if (row === undefined) {
      continue;
    }
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
