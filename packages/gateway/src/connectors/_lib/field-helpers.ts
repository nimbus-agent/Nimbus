import { asRecord, stringField } from "../unknown-record.ts";

/*
 * Field readers shared by the connector mapping layer (`*-mapping.ts`) and by the
 * syncs that normalise a configured base URL (`*-sync.ts`). Each one encodes
 * exactly the rule of the private copies it replaced, so moving a connector onto
 * one of these leaves what that connector indexes unchanged. A reader that needs
 * a DIFFERENT rule gets its own function rather than a flag on one of these.
 */

/**
 * Drops ONE trailing `/`, so a base URL configured as `https://host/` still
 * builds `https://host/path` rather than `https://host//path`.
 *
 * Deliberately not `string/strip-trailing-slashes.ts`'s `stripTrailingSlashes`,
 * which also trims whitespace and strips EVERY trailing slash: switching a
 * connector to it would change the URL that connector builds from a base URL
 * ending in `//`.
 */
export function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * The non-empty `field` values of an array of tag OBJECTS, in input order —
 * `[{ name: "infra" }]` by default; Zotero's tags carry the label in `tag`.
 *
 * A non-array yields `[]`. An entry is skipped when it is not a plain object
 * (a bare string included) or when its `field` is absent, not a string, or
 * empty. Tags that may arrive as either strings or objects need a different
 * reader (`stackoverflow-question-mapping.ts` has one).
 */
export function namedTags(raw: unknown, field = "name"): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, field);
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

/**
 * Every string element of `value`, in input order, EMPTY STRINGS INCLUDED; a
 * non-array yields `[]`. Plain-string tag lists (`["vip", "billing"]`) are read
 * with this too — it is the same rule.
 */
export function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * `row[key]` truncated toward zero when it is a finite number, else `null`, so a
 * line number that arrives as `12.7` reads as `12`. A numeric STRING (`"12"`) is
 * not a number here and yields `null`.
 */
export function pickIntField(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/**
 * `value` when it is a string in `set` — an exact, CASE-SENSITIVE match — else
 * `null`. `T` is the literal union that `set` enumerates; the caller keeps the
 * two in step. An upstream that varies the case needs a lowercasing reader
 * instead (`semgrep-finding-mapping.ts`'s `lowerEnum`).
 */
export function pickEnum<T extends string>(value: unknown, set: ReadonlySet<string>): T | null {
  if (typeof value !== "string") {
    return null;
  }
  return set.has(value) ? (value as T) : null;
}
