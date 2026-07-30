import type { Database } from "bun:sqlite";

import { unprojectTerm } from "./glossary-project.ts";
import {
  applyStats,
  computeTermStats,
  demoteTerm,
  selectStaleForRecheck,
} from "./glossary-store.ts";
import { scoreTerm } from "./term-scoring.ts";

export type ReconcileSummary = { verified: number; demoted: string[] };

/**
 * Re-verifies the least-recently-checked consolidated terms, round-robin.
 *
 * Necessary because the incremental scan can never revisit a term whose
 * sources were deleted: deletion bumps no `modified_at`, and an edit that
 * removes the last mention leaves no item to re-discover the term from. The
 * FTS index is correct throughout — only the trigger to re-read it is missing.
 *
 * Pure SQL, zero LLM cost, so it runs on every pass unconditionally.
 */
export function reconcilePass(
  db: Database,
  opts: { limit: number; minDocFreq: number; nowMs: number; cooldownMs: number },
): ReconcileSummary {
  // The cooldown is what keeps this cheap. The pass fires after EVERY
  // successful connector sync, and each verified term costs 2 FTS queries —
  // re-checking 50 terms every minute would be ~100 FTS queries a minute for
  // no new information. With a 12 h cooldown the sweep is a no-op on most
  // passes and still reaches full coverage daily.
  const stale = selectStaleForRecheck(db, opts.limit, opts.nowMs - opts.cooldownMs);
  const demoted: string[] = [];

  for (const term of stale) {
    const stats = computeTermStats(db, term.termKey);
    if (stats.docFreq < opts.minDocFreq) {
      // Below the floor: the evidence is gone. Drop it from the searchable
      // index first — a stale definition surfacing in search after its
      // sources vanished is worse than no glossary at all.
      unprojectTerm(db, term.termKey);
      demoteTerm(db, term.termKey, opts.nowMs);
      applyStats(db, term.termKey, stats, 0, opts.nowMs);
      demoted.push(term.termKey);
      continue;
    }
    // Still a term — only its evidence moved. No LLM call.
    const score = scoreTerm({
      docFreq: stats.docFreq,
      serviceSpread: stats.serviceSpread,
      form: term.form,
    });
    applyStats(db, term.termKey, stats, score, opts.nowMs);
  }

  return { verified: stale.length, demoted };
}
