const MCP_LIMIT_DEFAULT = 20;
const MCP_LIMIT_MAX = 50;
// Whitelisted rawMeta keys, verified against real connector item mappings (e.g. github-sync.ts
// stores a PR's author under `user`, plus `labels`/`merged`/`draft`/`repo`; pagerduty incidents
// use `status`/`severity`/`urgency`). Keep this tight — it is the only rawMeta that reaches the
// editor LLM (see the spec's security checklist).
const META_WHITELIST = [
  "state",
  "status",
  "number",
  "user",
  "author",
  "labels",
  "merged",
  "draft",
  "priority",
  "severity",
  "urgency",
  "environment",
  "conclusion",
  "repo",
] as const;
const META_STRING_MAX = 200;

/** Defense-in-depth: truncate any long string value so a whitelisted key can't smuggle a large blob. */
function clampMetaValue(v: unknown): unknown {
  return typeof v === "string" && v.length > META_STRING_MAX ? v.slice(0, META_STRING_MAX) : v;
}

/** Clamp an MCP-tool limit to [1, 50], defaulting to 20. Independent of the Gateway's own 1–500 clamp. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MCP_LIMIT_DEFAULT;
  }
  return Math.min(MCP_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Project one ranked index item to a compact, whitelisted shape for an editor LLM. */
export function projectRankedItem(item: unknown): Record<string, unknown> {
  const r = asRecord(item);
  const out: Record<string, unknown> = {};
  if (typeof r["name"] === "string") {
    out["name"] = r["name"];
  }
  if (typeof r["service"] === "string") {
    out["service"] = r["service"];
  }
  // Prefer indexedType (the real type, e.g. "pr"); itemType collapses unknown types to "file".
  const type = typeof r["indexedType"] === "string" ? r["indexedType"] : r["itemType"];
  if (typeof type === "string") {
    out["type"] = type;
  }
  const url = typeof r["url"] === "string" ? r["url"] : r["canonicalUrl"];
  if (typeof url === "string") {
    out["url"] = url;
  }
  if (typeof r["score"] === "number") {
    out["score"] = r["score"];
  }
  if (typeof r["modifiedAt"] === "number") {
    out["modifiedAt"] = r["modifiedAt"];
  }
  if (typeof r["semanticSnippet"] === "string") {
    out["semanticSnippet"] = r["semanticSnippet"];
  }
  const meta = r["rawMeta"];
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of META_WHITELIST) {
      if (m[k] !== undefined) {
        picked[k] = clampMetaValue(m[k]);
      }
    }
    if (Object.keys(picked).length > 0) {
      out["meta"] = picked;
    }
  }
  return out;
}

/** Project a ranked-items array; tolerates a non-array input by returning []. */
export function projectRankedItems(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map(projectRankedItem);
}
