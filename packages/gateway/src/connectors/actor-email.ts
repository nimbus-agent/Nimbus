/**
 * Bounded quantifiers, matching the house style in `updater/manifest-fetcher.ts:3`.
 * Every segment is capped, so no input can drive superlinear backtracking; the
 * length check below runs BEFORE the regex so nothing pathological reaches it.
 */
const ACTOR_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/;

/** RFC 5321's ceiling on a full address. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The single gate between a connector's actor payload and
 * `resolvePersonForSync`, which CREATES a person row for whatever it is handed.
 * `normalizeEmail` only trims and lowercases — it does not validate — so
 * without this a payload carrying "unknown" or a display name mints a junk
 * person that pollutes every people-based brief and cannot be merged away.
 *
 * Deliberately does NOT lowercase: `resolvePersonForSync` already normalises
 * (`people/linker.ts:44`), and duplicating that here creates two places for the
 * rule to drift.
 *
 * Returns `null` rather than throwing — a rejected address is an expected
 * outcome that increments an unattributable count, not an error.
 */
export function usableActorEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  return ACTOR_EMAIL_RE.test(trimmed) ? trimmed : null;
}
