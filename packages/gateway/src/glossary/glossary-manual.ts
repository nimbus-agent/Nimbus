import type { Database } from "bun:sqlite";

import type {
  GlossaryManualConfig,
  ManualSkip,
  ManualTerm,
} from "../config/nimbus-toml-glossary-terms.ts";
import { projectTerm, unprojectTerm } from "./glossary-project.ts";
import {
  computeTermStats,
  demoteTerm,
  getTerm,
  listConsolidated,
  listManualKeys,
  upsertManualTerm,
} from "./glossary-store.ts";
import type { GlossaryTerm } from "./glossary-types.ts";
import { findNearMisses } from "./near-miss.ts";
import { scoreTerm } from "./term-scoring.ts";

export type ManualPassSummary = { added: number; removed: number; skipped: ManualSkip[] };

/** Mirrors `agents/glossary.ts` and `glossary-extract.ts`. */
const NEAR_MISS_POOL = 500;

/**
 * True when the stored row already matches what the author wrote.
 *
 * Compares only AUTHORED content — definition, display form, synonyms — and
 * deliberately not statistics: those move on their own as the index changes,
 * and treating them as a difference would re-write every row every pass, which
 * is the cost this check exists to avoid. A row that is not `manual` is never
 * "unchanged": that is a mined row being taken over by an authored one.
 *
 * The alias comparison is `JSON.stringify`, matching how `synonyms` is both
 * stored (`upsertManualTerm`) and decoded (`toTerm`'s `parseJsonArray`) — NOT
 * a `.join(" ")` string compare. Aliases legitimately contain spaces (that is
 * their whole point), so `["change data", "record"]` and
 * `["change data record"]` join to the identical string and would otherwise
 * compare equal, silently skipping a genuine alias-set change until some
 * other field happened to move.
 */
function isUnchanged(
  existing: GlossaryTerm | null,
  term: ManualTerm,
  aliases: readonly string[],
): boolean {
  return (
    existing !== null &&
    existing.definitionSource === "manual" &&
    existing.definition === term.definition &&
    existing.displayTerm === term.displayTerm &&
    JSON.stringify(existing.synonyms) === JSON.stringify(aliases)
  );
}

/**
 * The authoring pre-pass. Runs at the head of every glossary pass.
 *
 * Config is DESIRED STATE for the `definition_source='manual'` subspace, and
 * only for that subspace: an authored key is upserted, and a manual row whose
 * key vanished from config is demoted.
 *
 * Demotion rather than deletion is what makes "remove my override" mean the
 * right thing. The existing `selectPendingBatch` filter (`doc_freq >=
 * min_doc_freq`) then discriminates without a new branch: a term with real
 * mined evidence re-enters the consolidation queue and comes back with a mined
 * definition, while a pure invention sits below the floor, never selected and
 * never projected. Hard deletion would lose the first case entirely, because
 * `discoverPhase` only scans past the watermark and would never re-discover it.
 */
export function applyManualTerms(
  db: Database,
  cfg: GlossaryManualConfig,
  opts: { nowMs: number },
): ManualPassSummary {
  if (!cfg.loaded) {
    // The config could not be READ — which is not the same as "there are no
    // authored terms". Removing rows here would wipe the user's authored
    // glossary on a transient read failure. Fail safe: touch nothing.
    return { added: 0, removed: 0, skipped: [] };
  }

  const aliasesFor = new Map<string, string[]>();
  for (const [alias, termKey] of cfg.synonyms) {
    aliasesFor.set(termKey, [...(aliasesFor.get(termKey) ?? []), alias]);
  }

  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);
  let added = 0;

  for (const term of cfg.terms) {
    // Skip a term whose authored content has not changed.
    //
    // Without this, every pass recomputes statistics for every authored term —
    // 2 FTS queries each, on a pass that fires after EVERY connector sync. A
    // team checking a 500-term glossary into nimbus.toml would spend 1000 FTS
    // queries per sync re-deriving values that did not move. It is the same
    // waste `reconcilePass`'s `stats_recheck_cooldown_ms` exists to prevent,
    // and the fix is the same: let the sweep refresh statistics on its own
    // round-robin schedule (it now sweeps manual rows — see
    // `glossary-reconcile.ts`) and touch a row here only when the AUTHOR
    // changed something.
    const existing = getTerm(db, term.termKey);
    if (isUnchanged(existing, term, aliasesFor.get(term.termKey) ?? [])) continue;

    // Measured, but EXEMPT from `min_doc_freq` — a human may define a term the
    // sources never mention. doc_freq is still recorded because it is what
    // discriminates the two removal cases above.
    const stats = computeTermStats(db, term.termKey);
    // One transaction PER TERM, not one for the whole pre-pass.
    //
    // The unit of atomicity is deliberately the term, matching
    // `consolidatePhase`, which wraps each term for the same reason: a crash
    // between the row write and the projection would strand a `consolidated`
    // row with no searchable item, and the reconciliation sweep only
    // re-verifies rows that are already consolidated, so nothing would repair
    // it.
    //
    // Batching the whole loop into one transaction was considered and
    // rejected. It would make a single failing entry discard every OTHER
    // authored term's update — and this reads a file a human is actively
    // editing, where a bad entry is the expected case rather than the
    // exceptional one. The commit-count cost that would motivate batching is
    // removed by the unchanged-skip above, which makes the steady-state pass
    // write nothing at all.
    const synonyms = aliasesFor.get(term.termKey) ?? [];
    const nearMisses = findNearMisses(term.termKey, knownKeys);
    // Carried over from `existing` (or 'phrase' for a brand-new row) — the
    // same expression `projectTerm`'s call below uses. Hardcoding "phrase"
    // here diverged from that: an authored takeover of a mined acronym row
    // (`form: "acronym"`) would score as a phrase the FIRST time this pass
    // touches it, then never reconcile, because `isUnchanged` does not
    // compare `form` (score is a derived statistic, not authored content).
    const score = scoreTerm({
      docFreq: stats.docFreq,
      serviceSpread: stats.serviceSpread,
      form: existing?.form ?? "phrase",
    });
    db.transaction(() => {
      upsertManualTerm(db, {
        termKey: term.termKey,
        displayTerm: term.displayTerm,
        definition: term.definition,
        synonyms,
        nearMisses,
        stats,
        score,
        nowMs: opts.nowMs,
      });
      // `upsertManualTerm` just wrote exactly this row. Reading it back out
      // via `getTerm` would only reconstruct what is already in hand, and it
      // would leave a `stored === null` branch that no test could ever force
      // (the write above always either applies or the transaction never
      // reaches here) — a permanently-uncoverable branch the coverage floor
      // cannot be satisfied against. Project directly from what was just
      // written instead; `form` is the one field `upsertManualTerm` does not
      // touch, so it is carried over from `existing` (or the table's
      // 'phrase' default for a brand-new row) — `projectTerm` does not read
      // it, but the value must still be a real `CandidateForm` to type-check.
      projectTerm(
        db,
        {
          termKey: term.termKey,
          displayTerm: term.displayTerm,
          status: "consolidated",
          definition: term.definition,
          definitionSource: "manual",
          docFreq: stats.docFreq,
          serviceSpread: stats.serviceSpread,
          score,
          form: existing?.form ?? "phrase",
          firstSeenAt: stats.firstSeenAt,
          lastSeenAt: stats.lastSeenAt,
          topSources: stats.topSources,
          synonyms,
          nearMisses,
          consolidatedAt: opts.nowMs,
          statsVerifiedAt: opts.nowMs,
          updatedAt: opts.nowMs,
        },
        opts.nowMs,
      );
    })();
    added += 1;
  }

  const configured = new Set(cfg.terms.map((t) => t.termKey));
  let removed = 0;
  for (const key of listManualKeys(db)) {
    if (configured.has(key)) continue;
    // The same transaction `glossary-reconcile.ts` runs for a below-floor
    // term. `demoteTerm` nulls `definition_source`, so a demoted row is no
    // longer selected by `listManualKeys` on the next pass.
    db.transaction(() => {
      unprojectTerm(db, key);
      demoteTerm(db, key, opts.nowMs);
    })();
    removed += 1;
  }

  return { added, removed, skipped: cfg.skipped };
}
