import type { Database } from "bun:sqlite";

export interface ResourceProbeRequest {
  readonly resourceRef: string;
}
export interface ResourceProbeResponse {
  readonly touched: boolean;
  readonly lastSeenDaysAgo?: number;
}

export const MIN_RESOURCE_REF_LEN = 4;
const RESOURCE_REF_RE = /^[A-Za-z0-9_:.\-/]+$/;
const DAY_MS = 86_400_000;

/** Reject short/noisy/wildcard refs so the probe cannot produce false idle/touched hits. */
export function isValidResourceRef(ref: string): boolean {
  return ref.length >= MIN_RESOURCE_REF_LEN && RESOURCE_REF_RE.test(ref);
}

/**
 * Why `isValidResourceRef` rejected a ref, or `null` if it did not.
 *
 * Two independent rules reject a ref and callers were reporting only the length
 * one, so a ref failing on an unsupported character (`#` is the common case —
 * `repo:acme/payments#branch/wip` is a natural thing to type) was told it was
 * "too short" while being 29 characters long.
 */
export function describeInvalidResourceRef(ref: string): string | null {
  if (ref.length < MIN_RESOURCE_REF_LEN) {
    return `resourceRef must be at least ${MIN_RESOURCE_REF_LEN} characters (got ${ref.length})`;
  }
  if (!RESOURCE_REF_RE.test(ref)) {
    return "resourceRef may contain only letters, digits, and _ : . - /";
  }
  return null;
}

/** Escape SQL LIKE metacharacters so the ref matches literally (no wildcard probing). */
function escapeLikeWildcards(s: string): string {
  return s
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`);
}

/**
 * Content-free recency probe (mirrors scoreExpertise): does any indexed item mention
 * `resourceRef`, and how recently? Returns ONLY a boolean + whole-days recency — never item bodies.
 */
export function probeResourceRecency(
  db: Database,
  req: ResourceProbeRequest,
  now: () => number = Date.now,
): ResourceProbeResponse {
  if (!isValidResourceRef(req.resourceRef)) return { touched: false };
  const like = `%${escapeLikeWildcards(req.resourceRef)}%`;
  const row = db
    .query<{ last: number | null }, [string, string]>(
      String.raw`SELECT MAX(modified_at) AS last FROM item WHERE title LIKE ? ESCAPE '\' OR body_preview LIKE ? ESCAPE '\'`,
    )
    .get(like, like);
  if (row?.last == null) return { touched: false };
  const daysAgo = Math.max(0, Math.floor((now() - row.last) / DAY_MS));
  return { touched: true, lastSeenDaysAgo: daysAgo };
}
