import type { Database } from "bun:sqlite";

import type {
  PrereviewPrRef,
  PrereviewReviewNote,
  PrereviewTerm,
} from "../agents/_lib/prreview-types.ts";

/**
 * The owner's own review text and the small pure helpers of `prreview-build.ts` (Phase 10 "Automated PR
 * pre-review"). Reads the local index only; no network, no model, no write.
 */

export const REVIEWS_SCANNED = 200;
export const TERMS_MAX = 8;
export const MIN_REVIEWS_FOR_TERM = 2;
const REVIEW_STATES = new Set(["CHANGES_REQUESTED", "COMMENTED"]);

/** Code-unit order: deterministic and locale-free. */
export function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

type ReviewRow = { body: string | null; modified_at: number; metadata: string | null };

// lane-census: scope=review service=github
export function reviewsFor(
  db: Database,
  repo: string,
  prs: ReadonlyMap<number, PrereviewPrRef>,
): PrereviewReviewNote[] {
  if (prs.size === 0) return [];
  const nums = [...prs.keys()];
  const marks = nums.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT body, modified_at, metadata FROM item
        WHERE service = 'github' AND type = 'review'
          AND json_extract(metadata, '$.repo') = ?
          AND CAST(json_extract(metadata, '$.pr_number') AS INTEGER) IN (${marks})
          AND upper(json_extract(metadata, '$.state')) IN ('CHANGES_REQUESTED', 'COMMENTED')
          AND body IS NOT NULL AND trim(body) <> ''
        ORDER BY modified_at DESC, id ASC
        LIMIT ?`,
    )
    .all(repo, ...nums, REVIEWS_SCANNED) as ReviewRow[];
  const out: PrereviewReviewNote[] = [];
  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    const num = numOrNull(meta["pr_number"]);
    const state = strOrNull(meta["state"])?.toUpperCase() ?? "";
    const pr = num === null ? undefined : prs.get(num);
    if (pr === undefined || !REVIEW_STATES.has(state) || r.body === null) continue;
    out.push({ pr, state, reviewedAtMs: r.modified_at, body: r.body });
  }
  return out;
}

const STOPWORDS = new Set(
  (
    "this that with from have will would could should there their they them then than what when where which " +
    "while also just like here into only some more most such very your yours about after before again being " +
    "does done each every make made need needs please thanks thank maybe still think looks look good great " +
    "nice small minor nits nit change changes changed code file files line lines test tests pull request"
  ).split(" "),
);

/** Words in at least {@link MIN_REVIEWS_FOR_TERM} distinct reviews, top {@link TERMS_MAX}. A count, not a summary. */
export function recurringTerms(bodies: readonly string[]): PrereviewTerm[] {
  const seen = new Map<string, number>();
  for (const body of bodies) {
    const words = new Set(body.toLowerCase().match(/[a-z0-9_-]{4,32}/g) ?? []);
    for (const w of words) {
      if (STOPWORDS.has(w) || /^[0-9_-]+$/.test(w)) continue;
      seen.set(w, (seen.get(w) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, n]) => n >= MIN_REVIEWS_FOR_TERM)
    .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
    .slice(0, TERMS_MAX)
    .map(([term, reviews]) => ({ term, reviews }));
}
