export const WORKER_ALLOWED_FIELDS = [
  "name",
  "title",
  "manager",
  "managerId",
  "team",
  "supervisoryOrg",
  "department",
  "location",
  "workEmail",
  "workPhone",
  "hireDate",
  "employmentStatus",
  "canonicalUrl",
] as const;

export const TIME_OFF_ALLOWED_FIELDS = [
  "worker",
  "workerId",
  "type",
  "startDate",
  "endDate",
  "units",
  "status",
  "canonicalUrl",
] as const;

export const JOB_POSTING_ALLOWED_FIELDS = [
  "title",
  "team",
  "department",
  "location",
  "status",
  "postedDate",
  "canonicalUrl",
] as const;

// Separator-free PII tokens. Matched against a normalized key (see isPiiKey) so the same
// patterns catch snake_case, kebab-case, and camelCase (home_address / home-address /
// homeAddress all normalize to "homeaddress").
const PII_KEY_RE =
  /(ssn|socialsecurity|nationalid|taxid|passport|salary|compensation|totalcomp|remuneration|dob|dateofbirth|birth|homeaddress|address|street|postal|zip|medical|fmla|disability|bank|accountnumber|routing|iban|swift|gender|ethnicity|race|religion|marital|personalemail|personalphone)/;

export function isPiiKey(key: string): boolean {
  // Normalize separators + case so camelCase / snake_case / kebab-case PII keys all match.
  // Over-matching is the safe direction for a denylist backstop — it drops data, never leaks it.
  const normalized = key.toLowerCase().replace(/[\s._-]/g, "");
  return PII_KEY_RE.test(normalized);
}

export function pickAllowed<T extends Record<string, unknown>>(
  row: T,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

/**
 * Apply the RaaS report field policy to a single row.
 *
 * - When `fields` is provided (the `fields` key was present in the report config), ONLY
 *   those keys are emitted — an explicit admin-supplied allowlist that INTENTIONALLY
 *   BYPASSES the {@link isPiiKey} denylist. The caller owns its contents; if they list a
 *   PII key it will be indexed. A PRESENT-but-empty `fields` (incl. a config that failed
 *   to parse to a non-empty list) emits NOTHING — fail-closed, never widening to the denylist.
 * - When `fields` is absent (no `fields` key at all), every non-PII key is emitted, with
 *   the {@link isPiiKey} denylist applied as a defense-in-depth backstop.
 */
export function applyReportFieldPolicy(
  row: Record<string, unknown>,
  fields?: readonly string[],
): Record<string, unknown> {
  if (fields !== undefined) {
    return pickAllowed(row, fields);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!isPiiKey(k) && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
