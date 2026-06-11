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
