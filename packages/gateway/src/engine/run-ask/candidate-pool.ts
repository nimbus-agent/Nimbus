import type { RankedIndexItem } from "../../index/ranked-item.ts";
import { classifyCandidateOutcome } from "../ask-explain-outcome.ts";
import type { CandidateOutcome, ContributingPass, LocalCandidate } from "../ask-explain-types.ts";
import { cleanContextText, type LocalContextItem } from "./context-item.ts";

/** One group of the discarded tail: how many cut candidates share a service + item type. */
export type DiscardedTailEntry = { service: string; type: string; count: number };

/** What {@link buildCandidatePool} reads: the merged candidates plus what the context showed. */
export type CandidatePoolInputs = {
  readonly byId: ReadonlyMap<string, Omit<LocalContextItem, "rank">>;
  readonly passById: ReadonlyMap<string, ContributingPass>;
  /** The scores survive ONLY here — `formatContextItem` drops them (spec §2.4). */
  readonly rankedById: ReadonlyMap<string, RankedIndexItem>;
  /** The full primary probe, including the overflow that never reached `byId`. */
  readonly primary: readonly RankedIndexItem[];
  readonly shownIds: ReadonlySet<string>;
  readonly limit: number;
};

/**
 * Every candidate the ranking pass considered, with its contributing pass and outcome (spec
 * §2.4): first each `byId` entry in merge order, then the primary probe's overflow that never
 * made it into `byId` (`cut: probe slice`).
 */
export function buildCandidatePool(inputs: CandidatePoolInputs): LocalCandidate[] {
  const { byId, passById, rankedById, primary, shownIds, limit } = inputs;
  const byIdOrder = [...byId.keys()];

  const outcomeFor = (id: string, inById: boolean): CandidateOutcome =>
    classifyCandidateOutcome({
      sourceId: id,
      inById,
      byIdPosition: inById ? byIdOrder.indexOf(id) : -1,
      shownIds,
      limit,
    });

  /** A candidate that WAS scored: read the components off the preserved RankedIndexItem. */
  const fromRanked = (
    item: RankedIndexItem,
    pass: ContributingPass,
    inById: boolean,
  ): LocalCandidate => ({
    sourceId: item.indexPrimaryKey,
    service: item.service,
    indexedType: item.indexedType,
    title: cleanContextText(item.name),
    ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }),
    ...(item.scoringFormula === undefined
      ? {}
      : {
          score: item.score,
          matchScore: item.matchScore,
          recencyComponent: item.recencyComponent,
          servicePriorityComponent: item.servicePriorityComponent,
          scoringFormula: item.scoringFormula,
        }),
    pass,
    outcome: outcomeFor(item.indexPrimaryKey, inById),
  });

  /**
   * A candidate that was NEVER scored — the raw-SQL repo-slug rows. Score fields are left
   * ABSENT, never 0: rendering an absent score as zero would claim it ranked last when in fact
   * it was never ranked (spec §2.4).
   */
  const fromContext = (
    item: Omit<LocalContextItem, "rank">,
    pass: ContributingPass,
  ): LocalCandidate => ({
    sourceId: item.sourceId,
    service: item.service,
    indexedType: item.indexedType,
    title: item.title,
    pass,
    outcome: outcomeFor(item.sourceId, true),
  });

  const pool: LocalCandidate[] = [];
  const seen = new Set<string>();
  for (const [id, ctxItem] of byId) {
    seen.add(id);
    const pass = passById.get(id) ?? { kind: "primary-hybrid" as const };
    const ranked = rankedById.get(id);
    pool.push(ranked === undefined ? fromContext(ctxItem, pass) : fromRanked(ranked, pass, true));
  }
  for (const item of primary) {
    if (seen.has(item.indexPrimaryKey)) continue;
    seen.add(item.indexPrimaryKey);
    pool.push(fromRanked(item, { kind: "primary-hybrid" }, false));
  }
  return pool;
}

/**
 * Groups the discarded tail (every candidate not `shown`) by service + type, largest first.
 *
 * Spec §2.5 suggested reusing `buildContextWindow`. DO NOT: its cap is
 * `Math.min(200, Math.max(1, Math.floor(maxItems)))`, so passing 0 to summarise EVERYTHING
 * clamps to 1 — it would keep the first discarded row as an "item" and silently omit it from
 * the summary. It would also need an unsound cast, since LocalCandidate is not a
 * RankedIndexItem. Ten honest lines beat a reused function used off-contract.
 */
export function summarizeDiscardedTail(pool: readonly LocalCandidate[]): DiscardedTailEntry[] {
  const tail = new Map<string, DiscardedTailEntry>();
  for (const c of pool) {
    if (c.outcome === "shown") continue;
    const key = JSON.stringify([c.service, c.indexedType]);
    const hit = tail.get(key);
    if (hit === undefined) {
      tail.set(key, { service: c.service, type: c.indexedType, count: 1 });
    } else {
      hit.count += 1;
    }
  }
  return [...tail.values()].sort((a, b) => b.count - a.count);
}
