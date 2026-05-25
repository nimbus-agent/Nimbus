/**
 * Pure substring-match filter for `flux_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns
 * the nested-CR haystack + case-insensitive substring match.
 *
 * A Flux Custom Resource is nested: `metadata` (name, namespace) and
 * `status.conditions` (an array of `{ type, status, reason, message }`). The
 * haystack is built by safely descending through `metadata.name`,
 * `metadata.namespace`, and the Ready condition's `reason` / `message`.
 */

export interface FluxSearchMatchOptions {
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

/** Descend a path of object keys, returning the leaf string if every hop is an object. */
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

/**
 * Find the `Ready` entry in `status.conditions` (an array of condition
 * objects) and return its `reason` + `message` concatenated. Descends
 * defensively — a missing / non-array `status.conditions` yields "".
 */
function readyConditionText(row: Record<string, unknown>): string {
  const status = asObject(row["status"]);
  const conditions = status?.["conditions"];
  if (!Array.isArray(conditions)) {
    return "";
  }
  for (const entry of conditions) {
    const c = asObject(entry);
    if (c === undefined) {
      continue;
    }
    if (c["type"] === "Ready") {
      const reason = typeof c["reason"] === "string" ? c["reason"] : "";
      const message = typeof c["message"] === "string" ? c["message"] : "";
      return `${reason} ${message}`;
    }
  }
  return "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const parts = [
    nestedString(row, ["metadata", "name"]),
    nestedString(row, ["metadata", "namespace"]),
    readyConditionText(row),
  ];
  return parts.join(" ").toLowerCase();
}

export function filterFluxResources(
  items: readonly unknown[],
  options: FluxSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of items) {
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
