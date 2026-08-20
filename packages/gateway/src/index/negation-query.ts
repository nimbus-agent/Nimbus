import type { Database } from "bun:sqlite";
import { buildPersonListSql, listPersons } from "../people/person-store.ts";
import type { PersonRecord } from "../people/person-types.ts";
import { buildItemListSql, type ItemListQueryParams } from "./item-list-query.ts";
// NOTE: `IndexedItem` is defined in TWO places — `index/local-index.ts:65`
// (`NimbusItem & { indexPrimaryKey: string }`, what `listItems` returns) and
// `embedding/types.ts:1` (a different shape entirely). Import the FORMER. An editor
// auto-import will offer the latter first.
import type { IndexedItem } from "./local-index.ts";
import {
  buildNoDownstreamIncidentSql,
  buildNotReviewedSql,
  buildNotTouchingSql,
  countNoDownstreamIncidentExclusions,
  countNotReviewedExclusions,
  countNotTouchingExclusions,
  type MissingSubstrateRefusal,
  missingSubstrateRefusal,
  type NegationExplain,
  probeCorrelatesWith,
  probePrFileCoverage,
  probeReviewed,
  toPositionalSubquery,
} from "./negation-predicates.ts";

/**
 * The shared shape every negation query resolves to: either a refusal (the substrate probe
 * failed) or an ok result carrying rows, the per-reason exclusion-gap counts, and an optional
 * `--explain` block. One generic over the row type and one over the gap-counter shape, so
 * `runNotTouchingQuery` / `runNoDownstreamIncidentQuery` / `runNotReviewedQuery` each keep their
 * own precise `Row`/`Gaps` types rather than widening to `unknown`.
 */
export type NegationOutcome<Row, Gaps> =
  | { readonly kind: "refused"; readonly refusal: MissingSubstrateRefusal }
  | {
      readonly kind: "ok";
      readonly rows: Row[];
      readonly gaps: Gaps;
      readonly explain?: NegationExplain;
    };

/**
 * The subset of `LocalIndex` this module needs, so a test can pass a real index and the module
 * does not depend on the class. `LocalIndex.listItems` (`index/local-index.ts:752`) satisfies it
 * structurally.
 */
type ItemLister = { listItems(params: ItemListQueryParams): IndexedItem[] };

export type NotTouchingParams = {
  readonly pathGlob: string;
  readonly services?: readonly string[];
  /**
   * The caller's own type filter (e.g. an RPC-level `types` param), ANDed with the predicate's
   * own `id IN (<pr-subquery>)` restriction — NOT a replacement for it. `buildNotTouchingSql`
   * still hardcodes `i.type = 'pr'` inside its own predicate SQL (fail-closed regardless of this
   * filter); this is the OUTER scope a raw JSON-RPC caller can additionally narrow with, exactly
   * as `index.queryItems`'s plain path already lets it. Omitted or empty means unrestricted
   * (the pre-refactor default). A caller passing a type disjoint from `'pr'` (e.g. `["issue"]`)
   * gets zero rows, not every PR — the two filters intersect, reproducing the pre-refactor
   * composed SQL exactly.
   */
  readonly types?: readonly string[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
  readonly explain?: boolean;
};

export type NotTouchingGaps = {
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * `--not-touching`: PRs with no indexed changed-file path matching `pathGlob`. Probe-first —
 * on an empty `pr_files_state`, every uncovered PR would trivially satisfy "does not touch this
 * path", a confident false positive rather than an incomplete answer, so an empty substrate
 * refuses instead of answering.
 */
export function runNotTouchingQuery(
  db: Database,
  index: ItemLister,
  params: NotTouchingParams,
): NegationOutcome<IndexedItem, NotTouchingGaps> {
  // `types` is the CALLER's own filter (see `NotTouchingParams.types`'s doc comment) — the
  // predicate's own `i.type = 'pr'` restriction lives inside `buildNotTouchingSql` and is
  // unconditional. Threading the caller's filter through, rather than hardcoding `["pr"]` here,
  // reproduces the pre-refactor composed SQL exactly: a caller-supplied type disjoint from `pr`
  // still intersects down to zero rows instead of silently being ignored.
  const types = params.types ?? [];
  const baseParams: ItemListQueryParams = {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
    ...(params.sinceMs === undefined ? {} : { sinceMs: params.sinceMs }),
    ...(params.untilMs === undefined ? {} : { untilMs: params.untilMs }),
    limit: params.limit,
  };
  const probeResult = probePrFileCoverage(db);
  const idInSql = toPositionalSubquery(buildNotTouchingSql(params.pathGlob));
  const composed = buildItemListSql({ ...baseParams, idInSql });
  if (!probeResult.passed) {
    return {
      kind: "refused",
      refusal: missingSubstrateRefusal(
        "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
        "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
        params.explain === true
          ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
          : undefined,
      ),
    };
  }
  const rows = index.listItems({ ...baseParams, idInSql });
  const gaps = countNotTouchingExclusions(db, {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
  });
  return {
    kind: "ok",
    rows,
    gaps,
    ...(params.explain === true
      ? { explain: { sql: composed.sql, params: composed.vals, substrate: probeResult } }
      : {}),
  };
}

export type NoDownstreamIncidentParams = {
  readonly services?: readonly string[];
  /**
   * The caller's own type filter, ANDed with the predicate's own `id IN (<deployment-subquery>)`
   * restriction — see `NotTouchingParams.types`'s doc comment for the full reasoning.
   * `buildNoDownstreamIncidentSql` still hardcodes `i.type = 'deployment'` unconditionally.
   */
  readonly types?: readonly string[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
  readonly explain?: boolean;
};

export type NoDownstreamIncidentGapsResult = { readonly excludedNoGraphEntity: number };

/**
 * `--no-downstream-incident`: deployments with no outgoing `correlates_with` edge. Same
 * probe-first shape as `runNotTouchingQuery`, over the `correlates_with` substrate.
 */
export function runNoDownstreamIncidentQuery(
  db: Database,
  index: ItemLister,
  params: NoDownstreamIncidentParams,
): NegationOutcome<IndexedItem, NoDownstreamIncidentGapsResult> {
  // Same reasoning as `runNotTouchingQuery`: `types` is the CALLER's own filter, threaded through
  // rather than hardcoded, so it reproduces the pre-refactor composed SQL exactly. The predicate's
  // own `i.type = 'deployment'` restriction lives inside `buildNoDownstreamIncidentSql`.
  const types = params.types ?? [];
  const baseParams: ItemListQueryParams = {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
    ...(params.sinceMs === undefined ? {} : { sinceMs: params.sinceMs }),
    ...(params.untilMs === undefined ? {} : { untilMs: params.untilMs }),
    limit: params.limit,
  };
  const probeResult = probeCorrelatesWith(db);
  const idInSql = toPositionalSubquery(buildNoDownstreamIncidentSql());
  const composed = buildItemListSql({ ...baseParams, idInSql });
  if (!probeResult.passed) {
    return {
      kind: "refused",
      refusal: missingSubstrateRefusal(
        "no `correlates_with` edges are indexed, so which deployments have no downstream " +
          "incident cannot be verified",
        "run a sync that populates deployment-to-incident correlation, then retry",
        params.explain === true
          ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
          : undefined,
      ),
    };
  }
  const rows = index.listItems({ ...baseParams, idInSql });
  // The Task 2 -> Task 3 ruling: an ungraphed deployment is silently DROPPED by the predicate's
  // INNER JOIN — fail-closed and correct — but must not be dropped UNCOUNTED. See
  // `countNoDownstreamIncidentExclusions`'s doc comment for why it is labelled "no graph entity
  // of the required type" rather than "not graphed".
  const gaps = countNoDownstreamIncidentExclusions(db, {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
  });
  return {
    kind: "ok",
    rows,
    gaps,
    ...(params.explain === true
      ? { explain: { sql: composed.sql, params: composed.vals, substrate: probeResult } }
      : {}),
  };
}

export type NotReviewedParams = {
  readonly unlinkedOnly?: boolean;
  readonly sinceMs?: number;
  readonly limit: number;
  readonly explain?: boolean;
};

export type NotReviewedGapsResult = { readonly excludedNoGraphEntity: number };

/**
 * `--not-reviewed`: people with no outgoing `reviewed` edge newer than the effective `sinceMs`
 * (defaults to `0`, i.e. "ever"). The probe itself is WINDOWED to the same `sinceMs` the query
 * uses — see `probeReviewed`'s doc comment for why a global, unwindowed probe would be wrong
 * here.
 */
export function runNotReviewedQuery(
  db: Database,
  params: NotReviewedParams,
): NegationOutcome<PersonRecord, NotReviewedGapsResult> {
  const unlinkedOnly = params.unlinkedOnly === true;
  const effectiveSinceMs = params.sinceMs ?? 0;
  const probeResult = probeReviewed(db, effectiveSinceMs);
  const idInSql = toPositionalSubquery(buildNotReviewedSql(effectiveSinceMs));
  const composed = buildPersonListSql({ unlinkedOnly, limit: params.limit, idInSql });
  if (!probeResult.passed) {
    return {
      kind: "refused",
      refusal: missingSubstrateRefusal(
        "no `reviewed` edges are indexed within the --since window, so who has not reviewed " +
          "anything in that window cannot be verified",
        // B.1 wrote this remediation for the CLI, which was right when the CLI was the only
        // caller. B.2 breaks that: this same string now reaches a model answering in `nimbus ask`
        // and an external MCP client, neither of which has a `--since` flag, so telling those
        // callers to "widen --since" would point them at an option that does not exist where they
        // are. Fixed here, at the single definition, so no per-surface copy can drift.
        "widen the time window (`--since` on the CLI, `sinceDays` on the tool surfaces) to " +
          "include older reviews, or sync a connector that populates PR review activity and run " +
          "nimbus index regraph",
        params.explain === true
          ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
          : undefined,
      ),
    };
  }
  const rows = listPersons(db, { unlinkedOnly, limit: params.limit, idInSql });
  // The SAME `unlinkedOnly` the query itself used, so the count printed beside a
  // `unlinkedOnly`-scoped result set describes THAT result set — an unscoped count would include
  // a linked person who could never have appeared in the result set in the first place.
  const gaps = countNotReviewedExclusions(db, { unlinkedOnly });
  return {
    kind: "ok",
    rows,
    gaps,
    ...(params.explain === true
      ? { explain: { sql: composed.sql, params: composed.vals, substrate: probeResult } }
      : {}),
  };
}
