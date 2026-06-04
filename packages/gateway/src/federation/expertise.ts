import type { Database } from "bun:sqlite";
import type { ExpertiseRank, ExpertiseRequest, ExpertiseResponse } from "./types.ts";

const HIGH_THRESHOLD = 10;
const MEDIUM_THRESHOLD = 3;

function rankForCount(n: number): ExpertiseRank {
  if (n === 0) return "none";
  if (n >= HIGH_THRESHOLD) return "high";
  if (n >= MEDIUM_THRESHOLD) return "medium";
  return "low";
}

/** Escape SQL LIKE metacharacters so a query token matches literally (privacy: no wildcard probing). */
function escapeLikeWildcards(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Locally score this gateway's relevance to a query and return ONLY a coarse rank.
 * The response payload is `{ rank }` and never carries item bodies (leak-proof).
 */
export function scoreExpertise(db: Database, req: ExpertiseRequest): ExpertiseResponse {
  // Token-LIKE count over title + body_preview. Cheap, content-free output.
  const tokens = req.query
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 5);
  if (tokens.length === 0) return { rank: "none" };
  const clauses = tokens
    .map(() => `(title LIKE ? ESCAPE '\\' OR body_preview LIKE ? ESCAPE '\\')`)
    .join(" OR ");
  const vals: string[] = [];
  for (const t of tokens) {
    const escaped = escapeLikeWildcards(t);
    vals.push(`%${escaped}%`, `%${escaped}%`);
  }
  const row = db
    .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM item WHERE ${clauses}`)
    .get(...vals);
  return { rank: rankForCount(row?.n ?? 0) };
}
