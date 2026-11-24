// packages/gateway/src/connectors/connector-writes/iac-plan-attrs.ts
// Pure helpers the Terraform plan preview shares: JSON-shape guards, the injective one-line escape,
// the sensitive / unknown marker walks and the changed-attribute names (a value only for a
// non-sensitive short scalar). Split out of `iac-plan-preview.ts` to keep it under 500 lines; it has
// no behaviour of its own and reads nothing but its arguments.

import { escapeDiffText } from "./sanitise.ts";

/** Nesting deeper than this is not walked: a marker counts as sensitive, a pair as different. */
const MAX_DEPTH = 32;

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** One line of text for a name: escaped injectively, newline included. */
export function escapeOneLine(s: string): string {
  return escapeDiffText(s).replaceAll("\n", String.raw`\u{000A}`);
}

/** Whether a sensitive / unknown marker marks anything: `true` anywhere inside it (deep). */
export function marksAny(marker: unknown, depth = 0): boolean {
  if (marker === true) return true;
  if (depth >= MAX_DEPTH) return typeof marker === "object" && marker !== null;
  if (Array.isArray(marker)) return marker.some((m) => marksAny(m, depth + 1));
  if (typeof marker === "object" && marker !== null) {
    return Object.values(marker).some((m) => marksAny(m, depth + 1));
  }
  return false;
}

/** The marker of one attribute inside a marker container (`true` marks the whole container). */
export function markerOf(container: unknown, key: string): unknown {
  if (container === true) return true;
  return isObj(container) ? own(container, key) : undefined;
}

export function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i], depth + 1));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k], depth + 1))
    );
  }
  return false;
}

/** How one side of an attribute is shown. Never reveals a sensitive value or the content of a complex one. */
export function showValue(
  value: unknown,
  sensitive: unknown,
  unknown_: unknown,
  maxValueChars: number,
): string {
  if (marksAny(sensitive)) return "(sensitive)";
  if (unknown_ === true) return "(known after apply)";
  if (marksAny(unknown_)) return "(partly known after apply)";
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length > maxValueChars)
      return `(string of ${String(value.length)} characters, not shown)`;
    const escaped = escapeOneLine(value).replaceAll('"', String.raw`\"`);
    return `"${escaped}"`;
  }
  if (Array.isArray(value)) return `(list, ${String(value.length)} items)`;
  if (isObj(value)) return `(object, ${String(Object.keys(value).length)} keys)`;
  return "(value not shown)";
}

/** The names of the top-level attributes that differ between the two sides, in first-seen order. */
export function changedAttributes(c: Obj): string[] {
  const before = own(c, "before");
  const after = own(c, "after");
  const unknownAfter = own(c, "after_unknown");
  const names = new Set<string>();
  for (const side of [before, after, unknownAfter]) {
    if (isObj(side)) for (const k of Object.keys(side)) names.add(k);
  }
  const out: string[] = [];
  for (const k of names) {
    const was = isObj(before) ? own(before, k) : undefined;
    const now = isObj(after) ? own(after, k) : undefined;
    const unk = markerOf(unknownAfter, k);
    if (!sameValue(was, now) || marksAny(unk)) out.push(k);
  }
  return out;
}
