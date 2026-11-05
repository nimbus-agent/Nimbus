// packages/gateway/src/connectors/connector-writes/before-select.ts
// Helpers for a write row's before-reader `select` (spec § 5.4): turn the read tool's reply into
// JSON, and read one identity field from it. Imported BY the group files, so it imports nothing
// from the row table or the read/write classifiers.
import { extractMcpToolText, MCP_TOOL_RESULT_MAX_BYTES } from "../_lib/mcp-tool-result.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The read's reply as JSON. A value with a `content` property is an MCP `CallToolResult` (what
 * the mesh dispatcher hands back as is): its first text part is unwrapped under the 4 MiB cap and
 * parsed, and `isError: true` throws. A plain object without `content` is returned as is. Anything
 * else (a string, an array, null, unparseable text) throws, so the preview reads
 * `unavailable (failed)` rather than an empty before-state.
 */
export function beforeReplyJson(reply: unknown): unknown {
  if (!isRecord(reply)) throw new TypeError("before reply: not an object");
  if (!Object.hasOwn(reply, "content")) return reply;
  const parsed: unknown = JSON.parse(extractMcpToolText(reply, MCP_TOOL_RESULT_MAX_BYTES));
  return parsed;
}

/**
 * The value at `path` (own properties only, through plain objects), as a string: a string as is,
 * a finite number in its `String` form; anything else (absent, inherited, an object, a boolean,
 * NaN) is `undefined`.
 */
export function stringAt(v: unknown, path: readonly string[]): string | undefined {
  let cur: unknown = v;
  for (const key of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return undefined;
}

/** `stringAt`, but a missing value throws: for the field that names the target. */
export function requiredStringAt(v: unknown, path: readonly string[]): string {
  const s = stringAt(v, path);
  if (s === undefined) throw new Error(`before reply: no ${path.join(".")}`);
  return s;
}

/** A `{label, value}` list from optional entries, dropping the absent ones. */
export function presentFields(
  entries: readonly (readonly [string, string | undefined])[],
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [label, value] of entries) {
    if (value !== undefined) out.push({ label, value });
  }
  return out;
}
