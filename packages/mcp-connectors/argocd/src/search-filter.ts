/**
 * Pure substring-match filter for `argocd_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns
 * the nested-object haystack + case-insensitive substring match.
 *
 * The ArgoCD Application object is nested, so the haystack is built by safely
 * descending through `metadata.name`, `spec.project`, `spec.source.repoURL`,
 * `status.sync.status`, and `status.health.status`.
 */

export interface ArgocdSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

/** Non-array plain object, or undefined. */
function asObject(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

/** Descend a path of keys, returning the leaf string if every hop is an object. */
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
