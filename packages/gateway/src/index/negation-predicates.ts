import type { Database } from "bun:sqlite";

export type SubstrateProbe = {
  readonly probeSql: string;
  readonly passed: boolean;
  readonly rowCount: number;
};

export type NegationGaps = {
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * `explain` shape shared by every negation-query IPC handler: `{ sql, params, substrate }`.
 * `sql`/`params` must be the COMPOSED statement that actually shaped — or, on a refusal, would
 * have shaped — the answer (e.g. `id IN (<predicate SELECT>) ... LIMIT ?`), never the bare
 * predicate SQL alone, so a caller's own filters (limit, unlinkedOnly, services/types/since/until)
 * are visible in `explain` too, not just the negation clause. `substrate` is present only for a
 * negation query — a plain query has no probe to report.
 *
 * Hoisted here (Task 4 fix round 1) from two independent, byte-identical copies in
 * `ipc/diagnostics-rpc.ts` and `ipc/people-rpc.ts`: this shape and the `toPositionalSubquery`
 * guard below are properties of the `?N`-placeholder convention `buildNotTouchingSql` /
 * `buildNoDownstreamIncidentSql` / `buildNotReviewedSql` share, not of either IPC file, so a
 * fix to one copy has no reason to reach the other. Precedent for hoisting a duplicated
 * disclosure/guard rather than leaving two copies to drift: `agents/_lib/brief-disclosures.ts`
 * (I31).
 */
export type NegationExplain = {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
  readonly substrate?: SubstrateProbe;
};

export type MissingSubstrateRefusal = {
  readonly status: "refused";
  readonly reason: "missing_substrate";
  readonly message: string;
  readonly remediation: string;
  readonly explain?: NegationExplain;
};

/**
 * `explainBlock` is attached to a refusal too, not only to a successful result: the substrate
 * probe is the only way to see WHY a query refused, which is exactly the case where `--explain`
 * matters most — a refused query has no `items`/`people`/`gaps` to inspect instead.
 */
export function missingSubstrateRefusal(
  message: string,
  remediation: string,
  explainBlock: NegationExplain | undefined,
): MissingSubstrateRefusal {
  return {
    status: "refused",
    reason: "missing_substrate",
    message,
    remediation,
    ...(explainBlock === undefined ? {} : { explain: explainBlock }),
  };
}

/**
 * A negation predicate builder (`buildNotTouchingSql` / `buildNoDownstreamIncidentSql` /
 * `buildNotReviewedSql`) numbers its own placeholders `?1`, `?2`, ... for standalone use. Embedded
 * as an `id IN (<sql>)` subquery inside a caller's own flat, positionally-bound filter list (see
 * `ItemListQueryParams.idInSql` / `PersonListQueryParams.idInSql`'s doc comments), a numbered
 * placeholder would desynchronize SQLite's own auto-numbering of the surrounding unnumbered `?`s
 * from that flat array's order and misbind. This renumbers every placeholder to plain, unnumbered
 * `?`, which SQLite auto-numbers in left-to-right order — exactly the order each predicate's own
 * `vals` array is already in, so no reordering of `vals` is needed, only of the placeholder
 * syntax.
 *
 * That equivalence holds only while each builder references every placeholder EXACTLY ONCE and
 * embeds no literal `?` in a string. All three hold today; neither is enforced by the type
 * system, and a future builder reusing `?1` twice would emit two `?` for one value and misbind
 * EVERY subsequent parameter — producing wrong rows rather than an error, the one failure mode a
 * negation query must not have. So the count is checked here rather than assumed: a mismatch
 * throws before any SQL runs. A literal `?` inside a string would trip it too; that is the
 * fail-closed direction, and the fix would be to bind that string instead.
 */
export function toPositionalSubquery(predicate: {
  sql: string;
  vals: ReadonlyArray<string | number>;
}): {
  sql: string;
  vals: ReadonlyArray<string | number>;
} {
  const sql = predicate.sql.replace(/\?\d+/g, "?");
  const placeholders = (sql.match(/\?/g) ?? []).length;
  if (placeholders !== predicate.vals.length) {
    throw new Error(
      `negation predicate placeholder mismatch: ${placeholders} placeholders for ${predicate.vals.length} values`,
    );
  }
  return { sql, vals: predicate.vals };
}

/**
 * Re-exported so the CLI prints the REAL window rather than restating "2h" and drifting.
 *
 * `CORRELATION_WINDOW_MS` was module-PRIVATE in `graph/graph-populator.ts` — it is now
 * exported there for this re-export, rather than copying its value here, which would be
 * exactly the drift this re-export exists to prevent.
 */
export { CORRELATION_WINDOW_MS } from "../graph/graph-populator.ts";

/**
 * `executedSql` is what actually runs, bound against `params` — this is the only SQL execution
 * path for every probe in this module (Task 4 fix round 2, Minor 7: collapsed from two
 * byte-identical row-extraction copies). `displaySql`, when given, is what `SubstrateProbe.probeSql`
 * REPORTS instead of `executedSql` — used only when a bound `?` would otherwise appear unbound in
 * the printed/explain form (see `probeReviewed`'s windowed branch). Defaults to `executedSql`
 * itself, which is already self-contained and runnable as printed for every parameterless probe.
 */
function probe(
  db: Database,
  executedSql: string,
  params: ReadonlyArray<string | number> = [],
  displaySql: string = executedSql,
): SubstrateProbe {
  const row = db.query(executedSql).get(...params) as { n?: number } | null;
  const rowCount = typeof row?.n === "number" ? row.n : 0;
  return { probeSql: displaySql, passed: rowCount > 0, rowCount };
}

export function probePrFileCoverage(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM pr_files_state");
}

export function probeCorrelatesWith(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'correlates_with'");
}

/**
 * Optionally WINDOWED by `sinceMs`, matching the exact filter `buildNotReviewedSql` applies to
 * `reviewed` edges (`created_at >= sinceMs`). Windowing the probe itself — not just the query —
 * is deliberate (Task 4 fix round 1, controller ruling): a GLOBAL count over all time can pass on
 * year-old edges while the query's own window has zero edges in it. That is exactly the state
 * where "nobody reviewed in the window" and "we have no synced data for the window" are
 * indistinguishable at the SQL level, and refusing on that ambiguity — rather than returning
 * every graphed person as a confident false "clean" answer — is this whole feature's thesis.
 *
 * `sinceMs` omitted means the unwindowed, all-time check (the ORIGINAL behavior). There is no
 * other PRODUCTION caller of that branch today — `ipc/people-rpc.ts`'s `rpcPeopleList` always
 * passes `effectiveSinceMs` (defaulting to `0`, never `undefined`) — so the unwindowed branch is
 * reached only from this module's own tests, kept because it is the correct behavior for any
 * future caller that genuinely wants an all-time check.
 */
export function probeReviewed(db: Database, sinceMs?: number): SubstrateProbe {
  if (sinceMs === undefined) {
    return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'reviewed'");
  }
  const executedSql =
    "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'reviewed' AND created_at >= ?";
  // `probeSql` is reported for DISPLAY/`--explain` — a caller pasting it into sqlite3 must get a
  // runnable statement, not an unbound `?` (Task 4 fix round 2, Important 2). The EXECUTED
  // statement above stays fully parameterised via `probe()`'s `params` argument; this inlines
  // `sinceMs` into a SEPARATE string used for display ONLY. Safe here because `sinceMs` is typed
  // `number` (never a raw caller string) and is already `Math.floor`-ed by `rpcPeopleList` before
  // it reaches this function — do not "fix" this by string-concatenating anything that is not
  // already a known-safe number; that would turn a display convenience into an injection.
  const displaySql = `SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'reviewed' AND created_at >= ${String(sinceMs)}`;
  return probe(db, executedSql, [sinceMs], displaySql);
}

/**
 * PRs with no indexed changed-file path matching `pathGlob`.
 *
 * Fail-closed by TWO independent mechanisms, and both must stay: the INNER JOIN to
 * `pr_files_state` (an uncovered PR has no row to join), and `s.truncated = 0` (under a LEFT
 * JOIN, an uncovered PR has no matching row at all, so `s.truncated` reads as NULL from the
 * ABSENT join side, not because the column itself is nullable — it is
 * `NOT NULL DEFAULT 0 CHECK(truncated IN (0,1))` — and `NULL = 0` is NULL, which WHERE treats as
 * not-true). Either alone excludes an unfetched PR, so swapping the JOIN for a LEFT JOIN does NOT
 * by itself reintroduce the bug — it takes losing both, e.g. a LEFT JOIN plus
 * `COALESCE(s.truncated, 0) = 0`.
 *
 * GLOB, never LIKE: LIKE is case-insensitive and treats `_` as a wildcard, both measured, both
 * wrong for paths.
 */
export function buildNotTouchingSql(pathGlob: string): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN pr_files_state s ON s.item_id = i.id
           WHERE i.type = 'pr'
             AND s.truncated = 0
             AND NOT EXISTS (
                   SELECT 1 FROM pr_changed_file f
                    WHERE f.item_id = i.id AND f.path GLOB ?1
                 )
           ORDER BY i.id`,
    vals: [pathGlob],
  };
}

/**
 * Deployments with no outgoing `correlates_with` edge.
 *
 * The bridge is required: `syncTimelineEventGraph` (`graph/graph-populator.ts:854`) upserts the
 * deployment's graph entity as `{ type: "deployment", externalId: row.id }`, so the item's id is
 * the entity's EXTERNAL id, never its primary key. Joining `graph_relation.from_id = item.id`
 * would match nothing and silently return every deployment as "clean" — the exact false positive
 * this feature exists to prevent.
 *
 * No time filter, deliberately: `CORRELATION_WINDOW_MS` is applied at WRITE time by the populator
 * and `graph_relation.created_at` is the write timestamp, not the event time. See spec § 4.2.
 */
export function buildNoDownstreamIncidentSql(): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN graph_entity e ON e.external_id = i.id AND e.type = 'deployment'
           WHERE i.type = 'deployment'
             AND NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id AND r.type = 'correlates_with'
                 )
           ORDER BY i.id`,
    vals: [],
  };
}

/**
 * People with no outgoing `reviewed` edge newer than `sinceMs`.
 *
 * Same bridge: `graph-populator.ts:341-349` upserts the person entity as
 * `{ type: "person", externalId: row.authorId }` and emits `reviewed` FROM it, and `row.authorId`
 * is the `person.id`. Unlike the deployment predicate this one DOES filter on `created_at`,
 * because `--since` is meant to bound the review window and that is the timestamp available.
 *
 * BOUND (verified, not assumed): `graph_relation.created_at` is a WRITE timestamp, not an event
 * timestamp. `upsertGraphRelation`'s `ON CONFLICT (from_id, to_id, type) DO UPDATE SET
 * created_at = excluded.created_at` (`graph/relationship-graph.ts`) means a `reviewed` edge's
 * `created_at` moves forward on every re-emit. `regraphAllItems` (`graph/regraph.ts`) never
 * clears existing `reviewed` edges but DOES re-run `syncGraphFromIndexedItem` over every `review`
 * item with `now = Date.now()` at regraph time — so a full regraph rewrites `created_at` for
 * every already-known review to "now", not the original review time. `--since` on this predicate
 * therefore means "no reviewed edge WRITTEN in the window", which can drift arbitrarily far from
 * "no review performed in the window" after any regraph pass.
 */
export function buildNotReviewedSql(sinceMs: number): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT p.id AS id
            FROM person p
            JOIN graph_entity e ON e.external_id = p.id AND e.type = 'person'
           WHERE NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id
                      AND r.type = 'reviewed'
                      AND r.created_at >= ?1
                 )
           ORDER BY p.id`,
    vals: [sinceMs],
  };
}

/**
 * Optionally narrows a count to the same `services`/`types` a query was scoped to, so the count
 * printed beside a result set describes THAT result set rather than the whole index. Omitted (or
 * both empty) means unscoped — every indexed row of the predicate's own type, matching the
 * previous (global) behavior byte-for-byte, which is what every existing caller of these count
 * functions still gets.
 */
export type ExclusionScope = {
  readonly services?: readonly string[];
  readonly types?: readonly string[];
};

function scopeFilter(
  alias: string,
  scope: ExclusionScope | undefined,
): { readonly sql: string; readonly vals: Array<string | number> } {
  const filters: string[] = [];
  const vals: Array<string | number> = [];
  const services = scope?.services ?? [];
  const types = scope?.types ?? [];
  if (services.length > 0) {
    filters.push(`${alias}.service IN (${services.map(() => "?").join(", ")})`);
    vals.push(...services);
  }
  if (types.length > 0) {
    filters.push(`${alias}.type IN (${types.map(() => "?").join(", ")})`);
    vals.push(...types);
  }
  return { sql: filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "", vals };
}

export type NoDownstreamIncidentGaps = {
  readonly excludedNoGraphEntity: number;
};

/**
 * Deployments `buildNoDownstreamIncidentSql` silently drops for having no graph entity of the
 * required type (`type = 'deployment'`) to join through at all — not because a downstream
 * incident was found, but because the predicate's INNER JOIN to `graph_entity` has nothing to
 * match. See that function's doc comment for why the join is required and why it drops such rows
 * instead of including them: dropping an unverifiable row is the fail-closed direction, but
 * dropping it UNCOUNTED is the silent shortfall this whole feature exists to prevent — a caller
 * asking "which deploys were clean?" would otherwise get a shorter list with no explanation.
 *
 * Labelled "no graph entity of the required type", deliberately NOT "not graphed": this count
 * conflates two different states — a deployment with no `graph_entity` row at all, and one graphed
 * as some OTHER entity type (a real possibility, since `graph_entity` only enforces
 * `UNIQUE(type, external_id)`, not uniqueness on `external_id` alone) — and the second is the
 * likelier case in practice. "Not graphed" would claim a precision this count does not have.
 *
 * `scope`, when given, narrows the count to the caller's own `services`/`types` filter — passing
 * the SAME `services`/`types` the query itself used keeps the printed count describing the result
 * set beside it, rather than the whole index (a count silently wider than its query reads as
 * belonging to it, and is not).
 */
export function countNoDownstreamIncidentExclusions(
  db: Database,
  scope?: ExclusionScope,
): NoDownstreamIncidentGaps {
  const { sql: scopeSql, vals } = scopeFilter("i", scope);
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
         LEFT JOIN graph_entity e ON e.external_id = i.id AND e.type = 'deployment'
        WHERE i.type = 'deployment' AND e.id IS NULL${scopeSql}`,
    )
    .get(...vals) as { n: number };
  return { excludedNoGraphEntity: row.n };
}

export type NotReviewedGaps = {
  readonly excludedNoGraphEntity: number;
};

/**
 * People `buildNotReviewedSql` silently drops for having no graph entity of the required type
 * (`type = 'person'`) to join through at all — not because a recent `reviewed` edge was found,
 * but because the predicate's INNER JOIN to `graph_entity` has nothing to match. See that
 * function's doc comment for why the join is required; see `countNoDownstreamIncidentExclusions`
 * above for why dropping such rows is the fail-closed direction but dropping them UNCOUNTED is
 * the silent shortfall this whole feature exists to prevent.
 *
 * Labelled "no graph entity of the required type", deliberately NOT "not graphed": this count
 * conflates two different states — a person with no `graph_entity` row at all, and one graphed as
 * some OTHER entity type (a real possibility, since `graph_entity` only enforces
 * `UNIQUE(type, external_id)`, not uniqueness on `external_id` alone) — and the second is the
 * likelier case in practice. "Not graphed" would claim a precision this count does not have.
 *
 * `scope`, when given, narrows the count to the caller's own `unlinkedOnly` filter — same
 * reasoning as `countNoDownstreamIncidentExclusions`'s `scope` above: an unscoped count printed
 * beside a scoped result set reads as belonging to it, and is not. `person` has no `service`/
 * `type` columns, unlike `item`, so this predicate cannot be scoped the same way its two siblings
 * are — but `person.linked` IS a real column, and it is exactly the column `people.list`'s own
 * `unlinkedOnly` filter reads. (Corrected from an earlier version of this comment, which claimed
 * `people.list` had "no service/type-like filter to scope against" and then, in the same
 * sentence, named `unlinkedOnly` as one — that was self-contradictory and the count shipped
 * unscoped as a result: an `unlinkedOnly: true` query could report an exclusion for a LINKED
 * person who could never have appeared in that query's own result set.)
 */
export type NotReviewedScope = {
  readonly unlinkedOnly?: boolean;
};

export function countNotReviewedExclusions(
  db: Database,
  scope?: NotReviewedScope,
): NotReviewedGaps {
  const linkedFilter = scope?.unlinkedOnly === true ? " AND p.linked = 0" : "";
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM person p
         LEFT JOIN graph_entity e ON e.external_id = p.id AND e.type = 'person'
        WHERE e.id IS NULL${linkedFilter}`,
    )
    .get() as { n: number };
  return { excludedNoGraphEntity: row.n };
}

/**
 * The two `buildNotTouchingSql` exclusion counts, reported SEPARATELY: a PR the index never
 * fetched a file list for, and a PR whose file list is known-incomplete. They mean different
 * things to a reader — the first is "we never checked", the second is "we checked partially" —
 * and summing them would erase that distinction.
 *
 * `scope`, when given, narrows both counts to the caller's own `services`/`types` filter — see
 * `countNoDownstreamIncidentExclusions`'s doc comment for why: an unscoped count next to a scoped
 * result set reads as belonging to it and is not.
 */
export function countNotTouchingExclusions(db: Database, scope?: ExclusionScope): NegationGaps {
  const { sql: scopeSql, vals } = scopeFilter("i", scope);
  const noCoverage = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
         LEFT JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.item_id IS NULL${scopeSql}`,
    )
    .get(...vals) as { n: number };
  const truncated = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.truncated = 1${scopeSql}`,
    )
    .get(...vals) as { n: number };
  return { excludedNoCoverage: noCoverage.n, excludedTruncated: truncated.n };
}

/** A `--not-touching` pattern that passed validation, or the reason it cannot ever match. */
export type PathGlobCheck =
  | { readonly ok: true; readonly glob: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Reject `--not-touching` patterns that CANNOT match an indexed path, before they become a
 * confident wrong answer.
 *
 * `pr_changed_file.path` is always POSIX-separated and repo-relative, so a backslash separator,
 * a leading `/` and a leading `./` are not merely unusual — they can never match anything, and
 * SQLite `GLOB` reports that by matching nothing rather than by failing. For a negation that
 * inverts the answer: measured on the live index, `packages\gateway\**` returned all 173 PRs,
 * including the 49 that touch the path, as "PRs not touching packages/gateway".
 *
 * The backslash form is the likeliest input on Windows — it is what Explorer's `Copy as path`,
 * the address bar and `path.join` all produce.
 *
 * These are REJECTED, not corrected. Silently rewriting the caller's pattern would answer a
 * question they did not ask, which on a negation surface is the same class of harm as the bug.
 * The message names the corrected form so the fix is one edit away.
 */
export function validatePathGlob(raw: string): PathGlobCheck {
  const glob = raw.trim();
  if (glob === "") {
    return { ok: false, reason: "--not-touching needs a path glob, e.g. packages/gateway/**" };
  }
  if (glob.includes("\\")) {
    return {
      ok: false,
      reason: `indexed paths are POSIX-separated, so a backslash can never match — did you mean ${glob.replaceAll("\\", "/")}`,
    };
  }
  if (glob.startsWith("/") || glob.startsWith("./")) {
    const fixed = glob.replace(/^\.?\//, "");
    return {
      ok: false,
      reason: `indexed paths are repo-relative, so a leading separator can never match — did you mean ${fixed}`,
    };
  }
  return { ok: true, glob };
}

/**
 * How many indexed paths the pattern actually matches.
 *
 * The existing substrate probe asks whether `pr_files_state` has ROWS — it was `passed=true
 * rowCount=173` in every one of the failing cases above, because the table was fully populated
 * and only the pattern was wrong. This asks the other question.
 *
 * ZERO has two readings that this function cannot tell apart — "genuinely nothing touches this"
 * and "your pattern is wrong" — which is precisely why the caller must DISCLOSE the count rather
 * than resolve it in either direction. Both readings make every returned row unfiltered, and a
 * reader who is told that can judge which one applies; a reader told nothing cannot.
 */
export function countPathsMatchingGlob(db: Database, pathGlob: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM pr_changed_file WHERE path GLOB ?1")
    .get(pathGlob) as { n: number } | null;
  return row?.n ?? 0;
}
