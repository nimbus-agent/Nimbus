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

const PII_KEY_RE =
  /(ssn|social_security|national_id|nationalid|tax_id|taxid|passport|salary|compensation|total_comp|remuneration|\bcomp\b|dob|date_of_birth|birth|home_address|^address$|street|postal|zip|medical|fmla|disability|bank|account_number|routing|iban|swift|gender|ethnicity|race|religion|marital|personal_email|personal_phone)/i;

export function isPiiKey(key: string): boolean {
  return PII_KEY_RE.test(key);
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
 * - When `fields` is provided and non-empty, ONLY those keys are emitted — this is
 *   an explicit admin-supplied allowlist and it INTENTIONALLY BYPASSES the
 *   {@link isPiiKey} denylist. The caller (the report config author) is responsible
 *   for the contents of `fields`; if they list a PII key it will be indexed.
 * - Otherwise (no `fields`, or empty), every non-PII key is emitted, with the
 *   {@link isPiiKey} denylist applied as a defense-in-depth backstop.
 */
export function applyReportFieldPolicy(
  row: Record<string, unknown>,
  fields?: readonly string[],
): Record<string, unknown> {
  if (fields !== undefined && fields.length > 0) {
    return pickAllowed(row, fields);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!isPiiKey(k) && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
