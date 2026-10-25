import type { Database } from "bun:sqlite";

import { unprojectTerm } from "./glossary-project.ts";
import {
  applyStats,
  computeTermStats,
  demoteTerm,
  selectStaleForRecheck,
} from "./glossary-store.ts";
import type { GlossarySets } from "./glossary-types.ts";
import { syncTermProjection } from "./glossary-visibility.ts";
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
  opts: {
    limit: number;
    minDocFreq: number;
    nowMs: number;
    cooldownMs: number;
    /** The pass's sets: statistics are over `known`, the re-projection is visibility- and routing-aware. */
    sets: GlossarySets;
  },
): ReconcileSummary {
  // The cooldown is what keeps this cheap. The pass fires after EVERY
  // successful connector sync, and each verified term costs 2 FTS queries —
  // re-checking 50 terms every minute would be ~100 FTS queries a minute for
  // no new information. With a 12 h cooldown the sweep is a no-op on most
  // passes and still reaches full coverage daily.
  const stale = selectStaleForRecheck(db, opts.limit, opts.nowMs - opts.cooldownMs);
  const demoted: string[] = [];
  // Over the KNOWN set, never the effective one: a type that left the mapping still counts, so
  // removing a pack never demotes a term mined from it, and re-adding never re-consolidates it.
  const known = opts.sets.known;

  for (const term of stale) {
    const stats = computeTermStats(db, term.termKey, known);
    if (term.definitionSource === "agent") {
      // An owner-ACCEPTED agent term: its evidence floor does not apply (the owner vouched for it,
      // as for a manual term), and it is never projected — projection would embed agent text
      // remotely (spec criterion 5). Only the stats are refreshed.
      applyStats(
        db,
        term.termKey,
        stats,
        scoreTerm({ docFreq: stats.docFreq, serviceSpread: stats.serviceSpread, form: term.form }),
        opts.nowMs,
      );
      continue;
    }
    // A human assertion outranks a doc-frequency floor, so an authored term is
    // never demoted — but it IS still swept. Skipping it entirely (the literal
    // reading of the base spec's §12) would freeze its `top_sources` forever,
    // so an authored term would keep citing threads the user deleted months
    // ago: precisely the failure this sweep exists to prevent.
    const isManual = term.definitionSource === "manual";
    if (!isManual && stats.docFreq < opts.minDocFreq) {
      // Below the floor: the evidence is gone. Drop it from the searchable
      // index first — a stale definition surfacing in search after its
      // sources vanished is worse than no glossary at all.
      //
      // All three writes are ONE transaction. Without it, a crash between
      // demoteTerm and applyStats leaves the row 'pending' with a stale score
      // and docFreq — and `selectStaleForRecheck` only looks at 'consolidated'
      // rows, so no later sweep can ever repair it. The term could then be
      // picked for consolidation and spend an LLM call on sources that no
      // longer exist. Ordering alone cannot fix this: without a transaction one
      // of the two crash windows is always exposed.
      db.transaction(() => {
        unprojectTerm(db, term.termKey);
        demoteTerm(db, term.termKey, opts.nowMs);
        applyStats(db, term.termKey, stats, 0, opts.nowMs);
      })();
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
    // Re-project so the searchable copy self-heals too — `applyStats` alone
    // only refreshes the `glossary_term` row; the projected `item` row (what
    // `nimbus ask` actually retrieves) would otherwise keep pointing at
    // sources the reconcile pass just confirmed are stale. Through the chokepoint, so the copy is
    // also hidden or re-routed when the term's contributing types moved (spec § 7.1).
    syncTermProjection(db, term.termKey, opts.sets, opts.nowMs, stats);
  }

  return { verified: stale.length, demoted };
}
