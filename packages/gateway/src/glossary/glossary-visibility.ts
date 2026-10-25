import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { LOCAL_ONLY_PROSE_TYPES, PROSE_HEAVY_TYPES } from "../embedding/routing.ts";
import { knownSourceTypes } from "../sources/source-catchup.ts";
import { builtinSourceEntries } from "../sources/source-kinds.ts";
import type { SourceMapping } from "../sources/source-mapping.ts";
import {
  type GlossaryItemType,
  glossaryItemId,
  projectTerm,
  unprojectTerm,
} from "./glossary-project.ts";
import { computeTermStats, getTerm, isRowVisible } from "./glossary-store.ts";
import type { GlossarySets, GlossaryTerm, TermStats } from "./glossary-types.ts";

/**
 * Which glossary terms the effective source mapping lets a reader see, and where each visible
 * term's search copy is embedded (role packs P2, spec § 7 and § 7.1).
 *
 * A mapping change never rewrites `glossary_term`: a term mined from a type that is later excluded
 * keeps its row, status, statistics and definition. Visibility is decided against the mapping
 * resolved for THAT read or pass. The only state here is the in-memory sweep fingerprint below,
 * which is an optimisation: losing it (a restart) costs one sweep, never a wrong projection.
 */

/** True when every known type is effective, so no term can be hidden by the mapping. */
export function isFastPath(known: readonly string[], effective: readonly string[]): boolean {
  const eff = new Set(effective);
  return known.every((t) => eff.has(t));
}

/** The sets one read resolves against: the mapping's effective types and the pass's known types. */
export function glossarySets(db: Database, mapping: SourceMapping): GlossarySets {
  const effective = mapping.typesFor("glossary");
  const known = knownSourceTypes(db, "glossary");
  return { effective, known, fast: isFastPath(known, effective) };
}

/**
 * Whether a reader resolving `sets` sees the term. Manual and owner-accepted agent terms are never
 * hidden by the mapping; on the fast path nothing can be hidden; otherwise a term needs at least
 * one occurrence in an effective type.
 */
export function isTermVisible(db: Database, term: GlossaryTerm, sets: GlossarySets): boolean {
  return isRowVisible(db, term.termKey, term.definitionSource, sets);
}

const BUILTIN_TYPES: ReadonlySet<string> = new Set(builtinSourceEntries().map(([key]) => key));

/** Whether one source type may contribute to a remotely embedded term (spec § 7.1). */
function isRemoteEligible(serviceType: string): boolean {
  // Checked first, so a local-only type can never be let through by the other two sets.
  if (LOCAL_ONLY_PROSE_TYPES.has(serviceType)) return false;
  // Built-in types are grandfathered: every term embedded remotely before source mappings existed,
  // and built-in commit types are not prose-heavy.
  return PROSE_HEAVY_TYPES.has(serviceType) || BUILTIN_TYPES.has(serviceType);
}

/**
 * The § 7.1 rule: a term's search copy embeds remotely only if EVERY type it was mined from is
 * remote-eligible. True for an empty list — a manual term with no occurrences keeps today's type.
 */
export function routesRemotely(contributingTypes: readonly string[]): boolean {
  return contributingTypes.every(isRemoteEligible);
}

export type ProjectionOutcome = "projected" | "projected_local" | "unprojected" | "skipped";

/**
 * THE one place a term's search copy is written. Every production projection of a glossary term
 * goes through here, so visibility and the § 7.1 routing rule cannot be skipped by a caller.
 *
 * - An agent row, a missing row and a row with no definition are skipped (agent text is never
 *   projected; the paths that remove such rows unproject them themselves).
 * - A term that is not `consolidated`, or that `sets` hides, is unprojected.
 * - Otherwise the copy is LOCAL when the stored definition was written from a non-remote-eligible
 *   source (`definitionLocal`, V75: the text stays derived from that item even after it is
 *   deleted) OR any current contributing type over the KNOWN set is not remote-eligible. Neither
 *   check is skipped on the fast path: the fast path is about visibility, not routing.
 *
 * Both types share ONE item id, and `upsertIndexedItem`'s `ON CONFLICT(id)` would rewrite `type`
 * in place, keeping the vectors computed for the old type (for a flip to local, vectors already
 * computed by the REMOTE embedder from derived text). So a type change deletes the old row's chunks
 * — the V30 triggers drop their `vec_items_*` rows — and the row itself, then upserts, in one
 * transaction. The chunks are deleted explicitly rather than left to the `ON DELETE CASCADE`,
 * which only fires on a connection with `foreign_keys = ON`.
 *
 * `stats` is an optimisation only: a caller that has just run `computeTermStats(db, termKey,
 * sets.known)` passes the result so the FTS match is not run twice. It must be over `sets.known`.
 */
export function syncTermProjection(
  db: Database,
  termKey: string,
  sets: GlossarySets,
  nowMs: number,
  stats?: TermStats,
): ProjectionOutcome {
  return db.transaction((): ProjectionOutcome => {
    const term = getTerm(db, termKey);
    if (term === null || term.definitionSource === "agent" || term.definition === null) {
      return "skipped";
    }
    if (term.status !== "consolidated" || !isTermVisible(db, term, sets)) {
      unprojectTerm(db, termKey);
      return "unprojected";
    }
    const { contributingTypes } = stats ?? computeTermStats(db, termKey, sets.known);
    const itemType: GlossaryItemType =
      !term.definitionLocal && routesRemotely(contributingTypes)
        ? "glossary_term"
        : "glossary_term_local";
    const id = glossaryItemId(termKey);
    const existing = db.query("SELECT type FROM item WHERE id = ?").get(id) as {
      type: string;
    } | null;
    if (existing !== null && existing.type !== itemType) {
      dbRun(db, "DELETE FROM embedding_chunk WHERE item_id = ?", [id]);
      dbRun(db, "DELETE FROM item WHERE id = ?", [id]);
    }
    projectTerm(db, term, nowMs, itemType);
    return itemType === "glossary_term" ? "projected" : "projected_local";
  })();
}

/** The `(effective, known)` each database was last swept against, in this process. */
const sweptFingerprint = new WeakMap<Database, string>();

function fingerprintOf(sets: GlossarySets): string {
  return JSON.stringify([[...sets.effective].sort(), [...sets.known].sort()]);
}

/** Every projectable term: consolidated, and not an owner-accepted agent row. */
const ALL_TARGETS_SQL = `SELECT term_key FROM glossary_term
  WHERE status = 'consolidated' AND (definition_source IS NULL OR definition_source <> 'agent')
  ORDER BY term_key`;

/** The projectable terms with no search copy at all (one anti-join). */
const UNPROJECTED_TARGETS_SQL = `SELECT g.term_key FROM glossary_term g
  WHERE g.status = 'consolidated'
    AND (g.definition_source IS NULL OR g.definition_source <> 'agent')
    AND NOT EXISTS (SELECT 1 FROM item i WHERE i.id = ? || g.term_key)
  ORDER BY g.term_key`;

/**
 * Whether the fast path's anti-join is enough. On the fast path nothing is hidden, so only a
 * term with no copy can need writing — PROVIDED nothing can need re-routing. That holds when every
 * known type is remote-eligible (no term can route local) and no local copy exists (none can need
 * to route back). Otherwise every term is re-synced, so a type that just became known re-routes
 * the terms it contributes to in the same pass rather than when catch-up or reconcile next
 * reaches them.
 */
function antiJoinSuffices(db: Database, sets: GlossarySets): boolean {
  if (!sets.fast || !routesRemotely(sets.known)) return false;
  const local = db
    .query("SELECT 1 FROM item WHERE service = 'nimbus' AND type = 'glossary_term_local' LIMIT 1")
    .get();
  return local === null;
}

/**
 * Brings every term's search copy in line with `sets`, when they changed since this database was
 * last swept in this process (the first pass after a boot always sweeps). Runs once per glossary
 * pass, after reconcile. One transaction.
 */
export function sweepProjections(
  db: Database,
  sets: GlossarySets,
  nowMs: number,
): { projected: number; unprojected: number } {
  const fingerprint = fingerprintOf(sets);
  if (sweptFingerprint.get(db) === fingerprint) return { projected: 0, unprojected: 0 };
  let projected = 0;
  let unprojected = 0;
  db.transaction(() => {
    const rows = antiJoinSuffices(db, sets)
      ? db.query(UNPROJECTED_TARGETS_SQL).all(glossaryItemId(""))
      : db.query(ALL_TARGETS_SQL).all();
    for (const { term_key } of rows as { term_key: string }[]) {
      const outcome = syncTermProjection(db, term_key, sets, nowMs);
      if (outcome === "projected" || outcome === "projected_local") projected += 1;
      else if (outcome === "unprojected") unprojected += 1;
    }
  })();
  // Recorded only once the transaction committed, so a failed sweep is retried next pass.
  sweptFingerprint.set(db, fingerprint);
  return { projected, unprojected };
}
