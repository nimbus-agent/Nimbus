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

/** The value at `path` (own properties only, through plain objects); `undefined` when absent. */
function valueAt(v: unknown, path: readonly string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * The value at `path` (own properties only, through plain objects), as a string: a string as is,
 * a finite number in its `String` form; anything else (absent, inherited, an object, a boolean,
 * NaN) is `undefined`.
 */
export function stringAt(v: unknown, path: readonly string[]): string | undefined {
  const cur = valueAt(v, path);
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return undefined;
}

/** The boolean at `path` (own properties only, through plain objects); `undefined` when absent or not a boolean. */
export function boolAt(v: unknown, path: readonly string[]): boolean | undefined {
  const cur = valueAt(v, path);
  return typeof cur === "boolean" ? cur : undefined;
}

/** `yes` or `no` for a boolean; `undefined` otherwise (the field is then omitted). */
export function yesNo(b: boolean | undefined): string | undefined {
  if (b === undefined) return undefined;
  return b ? "yes" : "no";
}

/** The array at `path` (own properties only, through plain objects); `undefined` when absent or not an array. */
export function arrayAt(v: unknown, path: readonly string[]): readonly unknown[] | undefined {
  const cur = valueAt(v, path);
  return Array.isArray(cur) ? (cur as unknown[]) : undefined;
}

/** A non-empty string input, else `undefined`: a reader never runs on a number, null or "". */
export function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A positive integer given as a number or a string of digits, else `undefined`. */
export function positiveIntegerArg(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
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

/** A list value shows at most this many entries; the rest are counted. */
export const BEFORE_LIST_MAX_ENTRIES = 50;

/**
 * The list at `path`, joined for a before-state field: each entry a string (`item` absent) or the
 * string at `item` inside an object entry. At most {@link BEFORE_LIST_MAX_ENTRIES} readable names
 * are joined with `, `; every other entry is counted, never silently dropped: `(+N more)` for
 * readable names past the cap, `(+N unreadable)` for entries with no readable name, or
 * `(+N more, M of them unreadable)` for both. Only an EMPTY list reads `(none)`; a non-empty list
 * with no readable entry reads `(N entries, unreadable)` (`(1 entry, unreadable)`). `undefined` when the value is absent or
 * not an array (the field is then omitted, never shown as empty).
 */
export function listAt(v: unknown, path: readonly string[], item?: string): string | undefined {
  const list = valueAt(v, path);
  if (!Array.isArray(list)) return undefined;
  const entries = list as unknown[];
  if (entries.length === 0) return "(none)";
  const names: string[] = [];
  for (const entry of entries) {
    const name = item === undefined ? stringAt(entry, []) : stringAt(entry, [item]);
    if (name !== undefined) names.push(name);
  }
  const unreadable = entries.length - names.length;
  if (names.length === 0) {
    return `(${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"}, unreadable)`;
  }
  const shown = names.slice(0, BEFORE_LIST_MAX_ENTRIES);
  const hidden = entries.length - shown.length;
  if (hidden === 0) return shown.join(", ");
  let suffix: string;
  if (unreadable === 0) suffix = `+${String(hidden)} more`;
  else if (unreadable === hidden) suffix = `+${String(unreadable)} unreadable`;
  else suffix = `+${String(hidden)} more, ${String(unreadable)} of them unreadable`;
  return `${shown.join(", ")} (${suffix})`;
}

/** A before-state excerpt of page content shows at most this many characters (code points). */
export const BEFORE_EXCERPT_MAX_CHARS = 1000;

/**
 * The first `max` code points of `s` (a surrogate pair is never split), followed by
 * ` (<k> more characters not shown)` when `k` code points were cut; `s` as is within the cap.
 * Every B3 page selector routes every value through this (or {@link excerptTail}), so no page
 * content reaches the prompt uncapped.
 */
export function excerptHead(s: string, max: number = BEFORE_EXCERPT_MAX_CHARS): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  const cut = cps.length - max;
  return `${cps.slice(0, max).join("")} (${String(cut)} more characters not shown)`;
}

/**
 * The last `max` code points of `s`, preceded by `(<k> earlier characters not shown) ` when `k`
 * code points were cut; `s` as is within the cap.
 */
export function excerptTail(s: string, max: number = BEFORE_EXCERPT_MAX_CHARS): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  const cut = cps.length - max;
  return `(${String(cut)} earlier characters not shown) ${cps.slice(cut).join("")}`;
}

/** The number of code points in `s` (what the page selectors call characters). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
