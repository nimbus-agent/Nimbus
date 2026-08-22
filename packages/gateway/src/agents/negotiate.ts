import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { normalizeEmail } from "../people/person-store.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import {
  detectEmptyIndex,
  detectMissingConnector,
  detectMissingRelationToEntityType,
  remediationForEntityType,
} from "./_lib/gap-notes.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateBrief,
  NegotiateDecisions,
  NegotiateEvidenceRef,
  NegotiateIncidents,
  NegotiateInput,
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
  NegotiateWriting,
} from "./_lib/negotiate-types.ts";
import {
  defaultRunGitConfigUserEmail,
  type GitRunner,
  resolveSelfPerson,
} from "./_lib/self-person.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

const DEFAULT_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * The agent's own window ceiling — a year, sized for an annual review cycle rather than
 * `catchup`'s "what happened while I was away" quarter. EXPORTED so `ipc/agents-rpc.ts`'s
 * `requireNegotiateParams` validates against this same literal instead of re-declaring it:
 * two copies drifting apart fails SILENTLY (the IPC accepts a window the agent then clamps),
 * which is exactly the silent-clamping bug the explicit IPC rejection exists to prevent.
 */
export const MAX_SINCE_MS = 365 * 24 * 60 * 60 * 1000;

export type NegotiateContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  /**
   * `[negotiate] personal_sources` (spec § 3.3): personal-document services the local
   * owner has named as in scope. Not optional — a caller must resolve config (or supply
   * `[]`) explicitly rather than silently disabling an opt-in the user believes is active.
   */
  personalSources: readonly string[];
};

const PERSONAL_DOCS_CONFIG_KEY = "[negotiate] personal_sources";

const UNAVAILABLE_EVIDENCE: readonly string[] = Object.freeze([
  "on-call shifts",
  "deploys triggered",
]);

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function unresolvedIdentityGap(): GapNote {
  return {
    category: "missing_user_identity",
    detail:
      "Could not resolve the subject — no override / git email / OS username matched a known person.",
    remediation:
      "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
  };
}

/**
 * How an explicit `--person <id>` matched the index.
 *
 * - `person` — a real `person` row. Every lane can measure this subject.
 * - `graph-only` — no `person` row, but a `person`-typed `graph_entity` with that
 *   `external_id` exists. Typically the `git:<email>` blame-alias shape (`resolveOwner`,
 *   `ownership/owner-identity.ts`), though a stale entity whose `person` row is gone lands
 *   here too. OWNERSHIP IS THE ONLY LANE THAT CAN MEASURE SUCH AN ID. It is tempting to
 *   assume the other graph-traversing lanes can too — they cannot: `authored` and `opened`
 *   edges are built from `row.authorId` (`graph/graph-populator.ts`), which only ever holds
 *   a `person.id`, so a `git:` entity is never their `from`. The ownership pass is the sole
 *   writer that puts such an external id on a graph entity, and it emits only `owns` edges.
 *   Authored PRs, reviewed PRs, tickets, decisions and writing are therefore ALL
 *   structurally zero here.
 * - `none` — nothing in the index carries that id at all: every lane is structurally zero.
 */
type ExplicitSubjectMatch = "person" | "graph-only" | "none";

function classifyExplicitSubject(db: Database, personId: string): ExplicitSubjectMatch {
  const person = db.query("SELECT 1 AS n FROM person WHERE id = ? LIMIT 1").get(personId) as {
    n?: number;
  } | null;
  if (person !== null) return "person";
  const entity = db
    .query("SELECT 1 AS n FROM graph_entity WHERE type = 'person' AND external_id = ? LIMIT 1")
    .get(personId) as { n?: number } | null;
  return entity === null ? "none" : "graph-only";
}

/**
 * The honesty contract's hardest case (spec § 3.2): an explicit `--person <id>` that resolves
 * to nothing is NOT `personId === null`, so `unresolvedIdentityGap()` never fires for it, and
 * `personDisplayNameOrNull` returns `null` for an unknown id — nothing in the rendered brief
 * gives it away. Six lanes then each honestly return `0` and the document reads as a person who
 * shipped nothing, which in a compensation conversation is the worst possible failure.
 *
 * A structural zero is not a measurement, so it must be labelled as one. The two arms state
 * DIFFERENT facts and are not collapsed: with a `graph-only` match the graph lanes really did
 * measure something (that is precisely why a `git:` id looks like it worked — ownership comes
 * back populated), and claiming every count is structurally zero would be its own false
 * statement in the opposite direction.
 *
 * Returns `null` for a `person` match — the ordinary case, which needs no disclosure.
 */
function explicitSubjectGap(match: ExplicitSubjectMatch, personId: string): GapNote | null {
  if (match === "person") return null;
  const remediation =
    "Pass a `person.id` — run `nimbus people search <name>` to find it. A `git:<email>` blame " +
    "alias is a graph entity, not a person id.";
  if (match === "none") {
    return {
      category: "missing_user_identity",
      detail:
        `\`--person ${personId}\` matched no indexed person; every count attributed to this id ` +
        "below is structurally zero, not a measurement. (The index-wide figures — decisions " +
        "with no indexed author, unmapped git identities — are real counts about the index, " +
        "not about this id.)",
      remediation,
    };
  }
  return {
    category: "missing_user_identity",
    detail:
      `\`--person ${personId}\` matched no \`person\` record — only a graph entity (typically ` +
      "the `git:<email>` blame-alias shape). Ownership below is the ONLY lane that can measure " +
      "this id: PRs authored, PRs reviewed, tickets, decisions and writing are every one of " +
      "them structurally zero for it, not measurements.",
    remediation,
  };
}

interface PersonHandleRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly canonical_email: string | null;
  readonly github_login: string | null;
  readonly gitlab_login: string | null;
  readonly slack_handle: string | null;
}

/**
 * The identity strings a person row can be recognised by, normalised for comparison.
 *
 * Lowercased with every non-alphanumeric character removed, and an email reduced to its
 * local-part. That is what makes the observed pair recognisable as one human: the Gmail record's
 * `asafgolombek@gmail.com` and the GitHub record's login `asafgolombek` normalise to the same
 * string, while their DISPLAY NAMES — "Asaf Golombek" and "asafgolombek" — do not compare equal
 * at all. A name-only match would have found nothing here.
 */
function personHandles(row: PersonHandleRow): Set<string> {
  const out = new Set<string>();
  const add = (raw: string | null): void => {
    if (raw === null) return;
    const value = raw.includes("@") ? (raw.split("@")[0] ?? "") : raw;
    const norm = value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (norm.length >= 3) out.add(norm);
  };
  add(row.display_name);
  add(row.canonical_email);
  add(row.github_login);
  add(row.gitlab_login);
  add(row.slack_handle);
  return out;
}

/**
 * How many person rows to consider as lookalikes. This query runs ONLY when the subject has
 * zero edges, which is rare, and the filter is a set intersection in JS because SQLite cannot
 * strip punctuation. A larger index than this simply reports no lookalike — the disclosure
 * still fires, it just cannot name a cause.
 */
const LOOKALIKE_SCAN_LIMIT = 500;

/**
 * Edges the subject holds, or `null` when the graph could not be read at all.
 *
 * `null` is NOT folded into `0`. A missing or broken `graph_relation` table would otherwise
 * look identical to a healthy graph holding nothing for this person, and the brief would
 * announce a split identity when the real problem is that the graph is unreadable. Every lane
 * that touches the same table fails in that case and `laneFailureGap` says so by name, which is
 * the accurate disclosure; adding a second, wrong one on top of it is not more honest.
 */
function subjectEdgeCount(db: Database, personId: string): number | null {
  try {
    const row = db
      .query(
        `SELECT COUNT(*) AS n
           FROM graph_relation r
           JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
          WHERE pe.external_id = ?
            AND r.type IN ('authored', 'opened', 'reviewed')`,
      )
      .get(personId) as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

/** Another person row that shares a normalised handle with the subject AND holds edges. */
function findLookalikeWithEdges(db: Database, personId: string): PersonHandleRow | null {
  try {
    return findLookalikeWithEdgesUnguarded(db, personId);
  } catch {
    return null;
  }
}

function findLookalikeWithEdgesUnguarded(db: Database, personId: string): PersonHandleRow | null {
  const subject = db
    .query(
      `SELECT id, display_name, canonical_email, github_login, gitlab_login, slack_handle
         FROM person WHERE id = ?`,
    )
    .get(personId) as PersonHandleRow | null;
  if (subject === null) return null;
  const mine = personHandles(subject);
  if (mine.size === 0) return null;
  const others = db
    .query(
      `SELECT p.id, p.display_name, p.canonical_email, p.github_login, p.gitlab_login, p.slack_handle
         FROM person p
        WHERE p.id <> ?
          AND EXISTS (
                SELECT 1 FROM graph_relation r
                  JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
                 WHERE pe.external_id = p.id
                   AND r.type IN ('authored', 'opened', 'reviewed'))
        ORDER BY p.id ASC
        LIMIT ?`,
    )
    .all(personId, LOOKALIKE_SCAN_LIMIT) as PersonHandleRow[];
  for (const other of others) {
    for (const h of personHandles(other)) {
      if (mine.has(h)) return other;
    }
  }
  return null;
}

/**
 * The third arm of the structural-zero disclosure: the subject IS an indexed person, and holds
 * none of the edges this brief measures.
 *
 * `explicitSubjectGap`'s two arms cover "the id matched nothing" and "the id matched only a
 * graph entity". Both return early on a `person` match, on the reasoning that a real person row
 * is the ordinary case needing no disclosure. It is not: one human routinely lands in the index
 * as two unlinked rows — an email from one connector, a login from another — and
 * `resolveSelfPerson` consults `git config user.email` FIRST, so it returns whichever half
 * carries the email. Observed: six lanes rendering `0` for someone who authored 160 of 173
 * indexed PRs, with no note, because the id did resolve.
 *
 * Both facts are knowable from the index, so both are stated: that the zeroes are structural,
 * and — when a lookalike exists — which record holds the edges and how to merge them. When no
 * lookalike is found the note still fires but names no record, since inventing a cause would be
 * its own false statement.
 */
function zeroEdgeSubjectGap(db: Database, personId: string): GapNote | null {
  const edges = subjectEdgeCount(db, personId);
  if (edges === null || edges > 0) return null;
  const twin = findLookalikeWithEdges(db, personId);
  const base =
    `The subject \`${personId}\` is an indexed person but has no \`authored\`, \`opened\` or ` +
    "`reviewed` edges at all, so PRs authored, PRs reviewed, tickets, decisions and writing " +
    "below are structurally zero — not measurements of what this human did.";
  if (twin === null) {
    return {
      category: "missing_user_identity",
      detail: base,
      remediation:
        "Run `nimbus people search <name>`: if a second record holds this human's activity, " +
        "`nimbus people link <a> <b>` merges them. If not, the index genuinely holds nothing " +
        "for this person yet.",
    };
  }
  const twinLabel = twin.display_name === null ? twin.id : `${twin.display_name} (${twin.id})`;
  return {
    category: "missing_user_identity",
    detail: `${base} Another indexed record — ${twinLabel} — shares an identity handle with this one AND holds those edges, so this looks like one human split across two unlinked person rows.`,
    remediation: `Merge them with \`nimbus people link ${personId} ${twin.id}\`, then re-run this brief.`,
  };
}

/**
 * A lane that fails degrades to a gap note, never a silent zero (spec § 4). `laneName` is
 * carried in `detail` (not just `taskIndex`) so a reader — and Task 2's red-prove test — can
 * tell which lane broke; the literal word "lane" is load-bearing for that match.
 */
function laneFailureGap(laneName: string, r: SubTaskResult): GapNote {
  return {
    category: "missing_connector",
    detail: `negotiate lane \`${laneName}\` failed${
      r.errorText === undefined ? "" : `: ${r.errorText}`
    }`,
  };
}

/**
 * A PR row's `item.metadata` as a plain object, or `undefined` when the JSON will not parse.
 *
 * `undefined` and `{}` are deliberately different answers: unparseable JSON drops the row
 * from every tally (the caller `continue`s), while JSON that parses to a non-object — a
 * number, an array, `null` — yields `{}`, so the row is still walked and simply contributes
 * nothing. That is the behaviour of the inline `try`/`catch` this replaces; it was extracted
 * only to bring the caller back under the cognitive-complexity gate (Sonar S3776).
 */
function parsePrMetadata(json: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * `person --authored--> pr` (graph_relation) joined back to `item` for the PR's metadata.
 * PR size stats (`additions`/`deletions`/`changed_files`) live in that metadata only where
 * the enrichment pass has run, hence `statsCoverage`: an aggregate over a partial subset
 * must disclose its own denominator rather than be printed as if it covered everything.
 */
/**
 * Fold one person's authored-PR metadata rows into the five counters
 * {@link laneAuthoredPrs} reports. Lifted out of that function to bring it back under the
 * cognitive-complexity gate (Sonar `S3776`) — the loop and its five guards were the whole
 * of its score.
 *
 * Unparseable metadata contributes to neither the merged count nor stats coverage — but it
 * DOES stay in `count`/`statsCoverage.total` at the call site, because the PR itself is real
 * evidence and dropping it would understate the headline number. The consequence is
 * asymmetric disclosure: the stats half is self-disclosing (`statsCoverage` renders
 * `covered/total`, so an unparseable row visibly widens the gap), while the `merged` half is
 * not — `merged` carries no denominator of its own, so a PR whose metadata will not parse is
 * silently absent from it. Only a genuinely corrupt `item.metadata` reaches here (every
 * writer goes through `JSON.stringify`), so this is a never-in-practice edge rather than a
 * live undercount; a `mergedCoverage` companion field is the fix if it ever stops being one.
 */
function accumulateAuthoredPrStats(rows: ReadonlyArray<{ metadata: string }>): {
  merged: number;
  covered: number;
  additions: number;
  deletions: number;
  changedFiles: number;
} {
  let merged = 0;
  let covered = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const row of rows) {
    const meta = parsePrMetadata(row.metadata);
    // Unparseable JSON drops the row from both tallies, per the note above.
    if (meta === undefined) continue;
    if (meta["merged"] === true) merged += 1;
    const a = meta["additions"];
    // `additions` is the coverage key: a row without it counts toward neither `covered` nor
    // any of the three sums, exactly as when the whole block was nested under `typeof a`.
    if (typeof a !== "number") continue;
    covered += 1;
    additions += a;
    const d = meta["deletions"];
    if (typeof d === "number") deletions += d;
    const c = meta["changed_files"];
    if (typeof c === "number") changedFiles += c;
  }
  return { merged, covered, additions, deletions, changedFiles };
}

function laneAuthoredPrs(db: Database, personId: string, sinceMs: number): NegotiateAuthoredPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT i.metadata AS metadata
         FROM graph_relation r
         JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
         JOIN item i           ON i.id = pre.external_id
        WHERE r.type = 'authored' AND pe.external_id = ? AND i.modified_at >= ?`,
    )
    .all(personId, cutoff) as Array<{ metadata: string }>;

  const { merged, covered, additions, deletions, changedFiles } = accumulateAuthoredPrStats(rows);

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
       JOIN item i           ON i.id = pre.external_id
      WHERE r.type = 'authored' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    count: rows.length,
    merged,
    evidence: { refs, total: rows.length },
    stats: covered === 0 ? null : { additions, deletions, changedFiles },
    statsCoverage: { covered, total: rows.length },
  };
}

/**
 * Queries `item` directly (not the graph): a `review` item's `metadata.state` is nullable
 * (GitHub can omit it), and every review must be counted somewhere — `otherOrUnknown` catches
 * `commented`, `dismissed`, and the null case, never silently dropping a row.
 *
 * The `json_valid` guard is required, not decorative: `json_extract` raises on unparseable
 * JSON, and one bad row kills the whole query rather than just itself (measured on bun
 * 1.3.14 / SQLite 3.53.0). It sits in the PROJECTION, inside a short-circuiting `CASE`, and
 * NOT in the WHERE clause. As a WHERE predicate it silently DROPPED every row whose metadata
 * is NULL or corrupt — removing them from `count` as well as from `otherOrUnknown`, which
 * contradicts the "every review is counted somewhere" rule above and disagreed with
 * `laneAuthoredPrs`, which deliberately keeps such rows in its headline count. Measured on a
 * 4-row fixture (valid / NULL / corrupt / no-state): the WHERE form returned 2 rows, the
 * `CASE` form returns all 4 with the two unreadable ones landing in `otherOrUnknown`.
 * Do not "simplify" this back into the WHERE clause.
 *
 * No `item(author_id)` index: `item` narrows hard first on `service`/`type` before this
 * unindexed filter runs, which is deliberate for a personal index — see spec § 4/Task 2 brief.
 */
function laneReviewedPrs(db: Database, personId: string, sinceMs: number): NegotiateReviewedPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.state') END AS state
         FROM item i
        WHERE i.service = 'github'
          AND i.type = 'review'
          AND i.author_id = ?
          AND i.modified_at >= ?`,
    )
    .all(personId, cutoff) as Array<{ state: string | null }>;

  let approved = 0;
  let changesRequested = 0;
  let otherOrUnknown = 0;
  for (const r of rows) {
    if (r.state === "approved") approved += 1;
    else if (r.state === "changes_requested") changesRequested += 1;
    else otherOrUnknown += 1;
  }
  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM item i
      WHERE i.service = 'github'
        AND i.type = 'review'
        AND i.author_id = ?
        AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    count: rows.length,
    approved,
    changesRequested,
    otherOrUnknown,
    evidence: { refs, total: rows.length },
  };
}

/**
 * `opened`: `person --opened--> issue` (graph_relation), joined back to `item` for the
 * window cutoff. `closedByAuthoredPr`: `person --authored--> pr --resolves--> issue`,
 * `DISTINCT`-counted on the issue side so one PR resolving multiple issues (or, in
 * principle, multiple authored PRs resolving the same issue) does not double-count.
 * Windowed on the PR's `modified_at`, matching `laneAuthoredPrs`.
 */
function laneTickets(db: Database, personId: string, sinceMs: number): NegotiateTickets {
  const cutoff = Date.now() - sinceMs;
  const opened = db
    .query(
      `SELECT COUNT(*) AS n
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
         JOIN item i          ON i.id = ie.external_id
        WHERE r.type = 'opened' AND pe.external_id = ? AND i.modified_at >= ?`,
    )
    .get(personId, cutoff) as { n: number };

  const closed = db
    .query(
      `SELECT COUNT(DISTINCT res.to_id) AS n
         FROM graph_relation auth
         JOIN graph_entity pe   ON pe.id = auth.from_id AND pe.type = 'person'
         JOIN graph_entity pre  ON pre.id = auth.to_id  AND pre.type = 'pr'
         JOIN item pri          ON pri.id = pre.external_id
         JOIN graph_relation res ON res.from_id = pre.id AND res.type = 'resolves'
        WHERE auth.type = 'authored' AND pe.external_id = ? AND pri.modified_at >= ?`,
    )
    .get(personId, cutoff) as { n: number };

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
       JOIN item i          ON i.id = ie.external_id
      WHERE r.type = 'opened' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    opened: opened.n,
    closedByAuthoredPr: closed.n,
    evidence: { refs, total: opened.n },
  };
}

/**
 * How many evidence refs a single lane may carry (spec § 5.B, citation half).
 *
 * A 365-day window over an active repo holds hundreds of PRs; an unbounded list stops being
 * a brief and becomes a data dump nobody reads, which defeats the purpose as thoroughly as
 * having no citations at all. Truncation is safe here ONLY because it self-discloses:
 * `NegotiateEvidence.total` carries the full population, so the renderer can say "and N
 * more" instead of letting a capped list read as exhaustive. Exported so tests can seed
 * exactly-at / one-past the boundary without duplicating the magic number.
 */
export const NEGOTIATE_EVIDENCE_LIMIT = 5;

/**
 * `title` + best-available url for the `item` rows a lane counted, newest first.
 *
 * Ordered `modified_at DESC, id ASC` — the `id` tiebreak is not decoration: without it two
 * items sharing a timestamp (routine, since a sync stamps a batch) come back in whatever
 * order SQLite chooses, so the same index could cite different PRs on two consecutive runs
 * of an unchanged brief. `COALESCE(canonical_url, url)` because not every connector records
 * a canonical url, and a null stays null rather than being invented.
 */
function evidenceRefsFor(
  db: Database,
  sql: string,
  params: readonly (string | number)[],
): NegotiateEvidenceRef[] {
  const rows = db.query(sql).all(...params) as Array<{ title: string; url: string | null }>;
  return rows.map((r) => ({ title: r.title, url: r.url }));
}

/** Exported so tests can seed exactly-at / one-past the boundary without duplicating the magic
 * number. */
export const OWNERSHIP_LIMIT = 50;

/**
 * A graph read, never a `git_blame_line` scan (spec § 5.A0) — the ownership pass
 * (`ownership/ownership-pass.ts`) already did the expensive derivation and left `owns`
 * edges behind; this lane only aggregates them. `maxOwnersPerPath` bounds owners PER PATH,
 * not paths per owner, so a long-tenured person can carry thousands of `owns` edges —
 * hence the explicit `LIMIT` here and the directory/service-only aggregation (never files).
 */
function laneOwnership(db: Database, personId: string): NegotiateOwnership {
  const rows = db
    .query(
      `SELECT te.type AS target_type, te.label AS label
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity te ON te.id = r.to_id
        WHERE r.type = 'owns'
          AND pe.external_id = ?
          AND te.type IN ('service', 'directory')
        ORDER BY r.weight DESC
        LIMIT ?`,
    )
    .all(personId, OWNERSHIP_LIMIT + 1) as Array<{ target_type: string; label: string }>;

  const truncated = rows.length > OWNERSHIP_LIMIT;
  const kept = truncated ? rows.slice(0, OWNERSHIP_LIMIT) : rows;
  const state = db.query("SELECT last_pass_at FROM ownership_pass_state WHERE id = 1").get() as {
    last_pass_at: number | null;
  } | null;

  return {
    services: kept.filter((r) => r.target_type === "service").map((r) => r.label),
    directories: kept.filter((r) => r.target_type === "directory").map((r) => r.label),
    lastPassAt: state?.last_pass_at ?? null,
    truncated,
    unmappedIdentitiesInIndex: countUnmappedOwnerIdentities(db),
  };
}

/**
 * Spec § 5.A0. `resolveOwner` (`ownership/owner-identity.ts`) emits `git:<email>` for a
 * blame email with no matching `person` row, so ownership recorded under an unmapped alias
 * is attributed to a SEPARATE graph entity and would silently vanish from a person-id-keyed
 * lane like `laneOwnership`. For the SELF subject we know the git email that self-resolution
 * attempted (whether or not it ended up mapping to a person), so we can name the gap
 * precisely instead of carrying a generic caveat. Never called for an explicit `--person`
 * subject: someone else's alias set is unknowable from here (see `countUnmappedOwnerIdentities`).
 */
function detectUnmappedGitIdentity(db: Database, gitEmail: string | null): GapNote | null {
  if (gitEmail === null || gitEmail.trim() === "") return null;
  const row = db
    .query(
      `SELECT 1 AS n FROM graph_entity
        WHERE type = 'person' AND external_id = ? LIMIT 1`,
    )
    .get(`git:${normalizeEmail(gitEmail)}`) as { n?: number } | null;
  if (row === null) return null;
  return {
    category: "missing_user_identity",
    detail:
      "Some of your ownership is recorded under an unmapped git identity and is not counted here.",
    remediation:
      "Add that git email to your person record so blame lines written under it are attributed to you.",
  };
}

/**
 * A fact about the INDEX, never a guess about the SUBJECT. Matching `git:`-prefixed
 * entities to an explicit `--person` subject by name or email substring was proposed and
 * rejected (spec § 5.A0): a heuristic attribution is wrong in a document that may affect
 * someone's compensation, which is worse than an acknowledged gap. This count is always
 * true regardless of who the brief is about.
 */
function countUnmappedOwnerIdentities(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM graph_entity
        WHERE type = 'person' AND external_id LIKE 'git:%'`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * `decision_record.source_item_id` joins to `item`, and the item's `author_id` gives the
 * decision's author — a join nothing under `decisions/` performs today. `obsidian-sync.ts`
 * and `teams-sync.ts` set no `authorId` at all, so a decision mined from either source
 * resolves to an item with `author_id IS NULL`; `unattributable` counts those rows rather
 * than silently dropping them from the denominator (spec § 8.2, Task 5 brief).
 */
function laneDecisions(db: Database, personId: string, sinceMs: number): NegotiateDecisions {
  const cutoff = Date.now() - sinceMs;
  const authored = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id = ?`,
    )
    .get(cutoff, personId) as { n: number };

  const unattributable = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id IS NULL`,
    )
    .get(cutoff) as { n: number };

  // Cited from `authored` ONLY. `d.statement` is nullable (a `pending` row has none, and an
  // `extracted` one can still be null if extraction produced nothing usable), so fall back to
  // the source item's title rather than rendering an empty bullet.
  const refs = evidenceRefsFor(
    db,
    `SELECT COALESCE(NULLIF(d.statement, ''), i.title) AS title,
            COALESCE(i.canonical_url, i.url) AS url
       FROM decision_record d
       JOIN item i ON i.id = d.source_item_id
      WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id = ?
      ORDER BY d.decided_at DESC, d.id ASC
      LIMIT ?`,
    [cutoff, personId, NEGOTIATE_EVIDENCE_LIMIT],
  );
  return {
    authored: authored.n,
    unattributable: unattributable.n,
    evidence: { refs, total: authored.n },
  };
}

/**
 * A graph read: `person --resolves--> incident` and `person --assigned-->
 * incident`, joined back to `item` for the window cutoff — the same shape as
 * `laneTickets`. `COUNT(DISTINCT ie.id)` because one incident can carry both
 * edge types for the same person and must not count twice within a lane.
 */
function laneIncidents(db: Database, personId: string, sinceMs: number): NegotiateIncidents {
  const cutoff = Date.now() - sinceMs;
  const countEdge = (relationType: string): number =>
    (
      db
        .query(
          `SELECT COUNT(DISTINCT ie.id) AS n
             FROM graph_relation r
             JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
             JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
             JOIN item i          ON i.id = ie.external_id
            WHERE r.type = ? AND pe.external_id = ? AND i.modified_at >= ?`,
        )
        .get(relationType, personId, cutoff) as { n: number }
    ).n;

  const unattributable = (
    db
      .query(
        `SELECT COUNT(*) AS n
           FROM item i
          WHERE i.type = 'incident'
            AND i.modified_at >= ?
            AND NOT EXISTS (
                  SELECT 1
                    FROM graph_entity ie
                    JOIN graph_relation r ON r.to_id = ie.id AND r.type IN ('assigned', 'resolves')
                   WHERE ie.type = 'incident' AND ie.external_id = i.id
                )`,
      )
      .get(cutoff) as { n: number }
  ).n;

  const resolved = countEdge("resolves");

  // Deliberately NOT `countEdge("assigned")` — that helper hardcodes
  // `ie.type = 'incident'` and would silently count the wrong population.
  const errorIssuesAssigned = (
    db
      .query(
        `SELECT COUNT(DISTINCT ie.id) AS n
           FROM graph_relation r
           JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
           JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'error_issue'
           JOIN item i          ON i.id = ie.external_id
          WHERE r.type = 'assigned' AND pe.external_id = ? AND i.modified_at >= ?`,
      )
      .get(personId, cutoff) as { n: number }
  ).n;

  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
       JOIN item i          ON i.id = ie.external_id
      WHERE r.type = 'resolves' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );

  return {
    resolved,
    assigned: countEdge("assigned"),
    unattributable,
    errorIssuesAssigned,
    evidence: { refs, total: resolved },
  };
}

const DOC_TYPES = ["page", "document"] as const;
const NOTE_TYPES = ["obsidian_note"] as const;
const MESSAGE_TYPES = ["message"] as const;

/**
 * Services whose content is mined only when the user names them in
 * `[negotiate] personal_sources` (spec § 3.3). The gate operates on the SERVICE, not the
 * item type: `type: "page"` is emitted by BOTH `confluence-sync.ts` (a work wiki) and
 * `notion-sync.ts` (commonly personal), so a type-only filter cannot separate them —
 * without a service filter, an unconfigured Notion workspace would be counted
 * unconditionally, contradicting "excluded by default, opt in via config".
 *
 * - `obsidian`: an unambiguously personal, local notes vault.
 * - `notion`: commonly a personal workspace, and named explicitly in the brief's own
 *   `[negotiate]` example.
 *
 * A future connector belongs here only if its content is similarly personal by default.
 * Everything else — Confluence, Slack, Teams, Discord, … — is a work artifact and stays
 * always in scope; it is never gated by `personal_sources`.
 */
const PERSONAL_CAPABLE_SERVICES = ["obsidian", "notion"] as const;

function countAuthoredByType(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
): number {
  const placeholders = types.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ? AND type IN (${placeholders})`,
    )
    .get(personId, cutoff, ...types) as { n: number };
  return row.n;
}

/** `types` authored by `personId`, from services NOT in `excludedServices` — the
 * always-on half of the personal-sources gate (work artifacts). */
function countAuthoredExcludingServices(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  excludedServices: readonly string[],
): number {
  const typePlaceholders = types.map(() => "?").join(", ");
  const servicePlaceholders = excludedServices.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ?
          AND type IN (${typePlaceholders})
          AND service NOT IN (${servicePlaceholders})`,
    )
    .get(personId, cutoff, ...types, ...excludedServices) as { n: number };
  return row.n;
}

/**
 * `types` authored by `personId`, from services IN `services` — the opt-in half of the
 * personal-sources gate. `services` is a bound `IN (...)` list, so an unrecognised or
 * typo'd service name simply matches no rows: it never throws and never widens to
 * "everything" (spec: fail-safe toward excluding). An empty `services` list
 * short-circuits to `0` without querying at all.
 */
function countAuthoredForServices(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  services: readonly string[],
): number {
  if (services.length === 0) return 0;
  const typePlaceholders = types.map(() => "?").join(", ");
  const servicePlaceholders = services.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ?
          AND type IN (${typePlaceholders})
          AND service IN (${servicePlaceholders})`,
    )
    .get(personId, cutoff, ...types, ...services) as { n: number };
  return row.n;
}

/**
 * Counts `types` authored by `personId`, applying the `[negotiate] personal_sources`
 * gate PER SERVICE (spec § 3.3, see `PERSONAL_CAPABLE_SERVICES`): every service outside
 * `PERSONAL_CAPABLE_SERVICES` always contributes (work artifacts); a service inside it
 * contributes only when the caller has named it in `personalSources`. Used for both
 * `docs` (Confluence always, Notion opt-in) and `notes` (Obsidian opt-in only — no
 * non-personal-capable service emits `obsidian_note`, so this collapses to the prior
 * "notes is zero unless configured" behaviour).
 */
function countAuthoredServiceGated(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
  personalSources: readonly string[],
): number {
  const alwaysOn = countAuthoredExcludingServices(
    db,
    personId,
    cutoff,
    types,
    PERSONAL_CAPABLE_SERVICES,
  );
  const gated = countAuthoredForServices(
    db,
    personId,
    cutoff,
    types,
    splitPersonalSources(personalSources).recognised,
  );
  return alwaysOn + gated;
}

/**
 * The `[negotiate] personal_sources` list, split into the entries that actually WIDEN the
 * query and the entries that match nothing.
 *
 * The one authority for both halves of the disclosure: `countAuthoredServiceGated` widens on
 * `recognised`, and `renderNegotiateSources` reports the same `recognised`/`unrecognised`
 * split — so "personal document sources are configured" can never mean anything other than
 * "at least one configured entry actually contributed". Deriving `personalDocsConfigured`
 * from `personalSources.length` instead made a typo'd or mis-capitalised entry render as
 * complete coverage over an undercount, in the one section whose whole job is to disclose
 * whether the opt-in applied. Case-folding is handled upstream at parse time
 * (`config/nimbus-toml.ts` `parsePersonalSources`), so `"Obsidian"` reaches here as
 * `"obsidian"` and is recognised.
 *
 * `recognised` is ordered by `PERSONAL_CAPABLE_SERVICES`, not by config order, so it is
 * deduplicated and stable regardless of how the user wrote the list. `unrecognised` is
 * deduplicated explicitly to match: it is echoed back to the reader verbatim, and
 * `2 unrecognised entries ignored: "foo", "foo"` reads as two distinct mistakes.
 */
function splitPersonalSources(personalSources: readonly string[]): {
  recognised: readonly string[];
  unrecognised: readonly string[];
} {
  const capable: readonly string[] = PERSONAL_CAPABLE_SERVICES;
  return {
    recognised: capable.filter((s) => personalSources.includes(s)),
    unrecognised: [...new Set(personalSources.filter((s) => !capable.includes(s)))],
  };
}

/**
 * Evidence for the writing lane, reproducing `countAuthoredServiceGated`'s gate EXACTLY in
 * one query: a gated type (doc/note) qualifies from a non-personal-capable service always, or
 * from a personal-capable one only when recognised; a message qualifies unconditionally.
 *
 * The gate is duplicated here rather than shared because the counts are three separate
 * `COUNT(*)`s and this is one ordered list — but it MUST agree with them. Evidence that
 * disagrees with the count above it is worse than no evidence: it turns the citation from a
 * check into a contradiction, and a reader who spots an Obsidian note cited under a brief
 * whose `sources` block says personal docs are off has no reason to trust any other number.
 * The `personal sources gate the evidence list exactly as it gates the counts` test pins it.
 *
 * `recognised` is interpolated as a literal `0` (false) when empty: `service IN ()` is a
 * syntax error in SQLite, so the empty case must collapse the clause, not emit it.
 */
function laneWritingEvidence(
  db: Database,
  personId: string,
  cutoff: number,
  personalSources: readonly string[],
): NegotiateEvidenceRef[] {
  const gatedTypes: readonly string[] = [...DOC_TYPES, ...NOTE_TYPES];
  const { recognised } = splitPersonalSources(personalSources);
  const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
  const recognisedClause = recognised.length === 0 ? "0" : `service IN (${ph(recognised.length)})`;
  return evidenceRefsFor(
    db,
    `SELECT title, COALESCE(canonical_url, url) AS url
       FROM item
      WHERE author_id = ? AND modified_at >= ?
        AND (
          (type IN (${ph(gatedTypes.length)})
            AND (service NOT IN (${ph(PERSONAL_CAPABLE_SERVICES.length)}) OR ${recognisedClause}))
          OR type IN (${ph(MESSAGE_TYPES.length)})
        )
      ORDER BY modified_at DESC, id ASC
      LIMIT ?`,
    [
      personId,
      cutoff,
      ...gatedTypes,
      ...PERSONAL_CAPABLE_SERVICES,
      ...recognised,
      ...MESSAGE_TYPES,
      NEGOTIATE_EVIDENCE_LIMIT,
    ],
  );
}

/** Messages are a work artifact and are always in scope (spec § 3.3) — chat services are
 * not in `PERSONAL_CAPABLE_SERVICES`. */
function laneWriting(
  db: Database,
  personId: string,
  sinceMs: number,
  personalSources: readonly string[],
): NegotiateWriting {
  const cutoff = Date.now() - sinceMs;
  const docs = countAuthoredServiceGated(db, personId, cutoff, DOC_TYPES, personalSources);
  const notes = countAuthoredServiceGated(db, personId, cutoff, NOTE_TYPES, personalSources);
  const messages = countAuthoredByType(db, personId, cutoff, MESSAGE_TYPES);
  return {
    docs,
    notes,
    messages,
    evidence: {
      refs: laneWritingEvidence(db, personId, cutoff, personalSources),
      total: docs + notes + messages,
    },
  };
}

/**
 * The `sources` block (spec § 5.F). `personalDocsConfigured` is the INTERSECTION with
 * `PERSONAL_CAPABLE_SERVICES` — see `splitPersonalSources` — never `personalSources.length`;
 * and entries that matched nothing are carried through to the render rather than dropped
 * silently, so a typo is visible to the person holding the brief.
 */
function personalDocsSources(personalSources: readonly string[]): NegotiateBrief["sources"] {
  const { recognised, unrecognised } = splitPersonalSources(personalSources);
  return {
    personalDocsConfigured: recognised.length > 0,
    personalDocsRecognised: recognised,
    personalDocsUnrecognised: unrecognised,
    personalDocsConfigKey: PERSONAL_DOCS_CONFIG_KEY,
  };
}

function laneTask(execute: () => unknown): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => ({ text: JSON.stringify(execute()), tokensIn: 0, tokensOut: 0 }),
  };
}

/**
 * Extracted from `runNegotiate` so it can be unit-tested directly against synthetic
 * `SubTaskResult[]` input: Task 1 wires this mechanism with zero real lanes (`tasks` is
 * always `[]`), so the loop body never runs end-to-end via `runNegotiate` itself, and a
 * coverage floor requires exercising it — building fake `SubTaskResult`s is the only way
 * to reach it without inventing a lane, which is Task 2's job, not Task 1's.
 */
export function reduceLaneResults(
  results: readonly SubTaskResult[],
  laneNames: readonly string[],
): GapNote[] {
  const gaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      gaps.push(laneFailureGap(laneNames[r.taskIndex] ?? `#${String(r.taskIndex)}`, r));
    }
  }
  return gaps;
}

/**
 * Resolution-aware probe for the incidents lane's `resolves -> incident` edge (spec §
 * 5.8). `detectMissingRelationToEntityType`'s shared default detail says the edge is
 * "defined in the schema but not yet emitted by the graph populator" — false here,
 * since `syncIncidentPersonEdges` emits it. Build an honest, scoped `GapNote` from its
 * result instead of changing the shared helper's detail for every other relation type
 * (the pattern `expert.ts`'s `detectUnresolvedReviewedRelation` already establishes).
 */
function detectMissingIncidentPersonEdges(db: Database): GapNote | null {
  const missingEmit = detectMissingRelationToEntityType(db, "resolves", "incident");
  if (missingEmit === null) return null;
  const note: GapNote = {
    category: missingEmit.category,
    detail:
      "No PagerDuty incident in the index is attributed to a person — either none carry " +
      "an assignee or resolver, or their actor payloads carry no usable email.",
  };
  const remediation = remediationForEntityType("incident");
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

/**
 * Same shape as `detectMissingIncidentPersonEdges`, for the `assigned -> error_issue`
 * edge `syncErrorIssueGraph` emits. An unassigned Sentry issue is the NORM, so the
 * shared default detail's remediation (`nimbus index regraph`) would be a no-op for the
 * most common case — a user with many indexed-but-unassigned issues would be told to
 * run a command that reports "graphed N" and changes nothing. State the actual cause
 * instead.
 */
/**
 * Push at most ONE gap note for a connector-backed lane: the missing-connector note if the
 * connector is absent, otherwise the missing-edges note if it is present but has emitted
 * none.
 *
 * Ordered more fundamental cause first, and deliberately exclusive: a missing connector
 * structurally implies missing edges, so firing both would emit two notes for one root
 * cause. Written once here because the PagerDuty and Sentry blocks it replaces were the
 * same eleven lines twice, and were most of the caller's cognitive-complexity score
 * (Sonar `S3776`).
 */
function pushConnectorOrEdgeGap(
  db: Database,
  service: string,
  detectMissingEdges: (db: Database) => GapNote | null,
  gaps: GapNote[],
): void {
  const missingConnector = detectMissingConnector(db, service);
  if (missingConnector !== null) {
    gaps.push(missingConnector);
    return;
  }
  const missingEdges = detectMissingEdges(db);
  if (missingEdges !== null) gaps.push(missingEdges);
}

function detectMissingErrorIssuePersonEdges(db: Database): GapNote | null {
  const missingEmit = detectMissingRelationToEntityType(db, "assigned", "error_issue");
  if (missingEmit === null) return null;
  const note: GapNote = {
    category: missingEmit.category,
    detail:
      "No Sentry issue in the index is assigned to a resolvable person — either none are " +
      "assigned, or the assignee actors carry no usable email.",
  };
  const remediation = remediationForEntityType("error_issue");
  if (remediation !== undefined) note.remediation = remediation;
  return note;
}

/**
 * The seven lane-backed fields of `NegotiateBrief`, in the order their tasks are queued.
 *
 * ONE list, read by both the `laneNames` push below and `decodeLaneResults`'s guard: when the
 * two were separate string literals, a lane renamed in one place and not the other decoded to
 * nothing and left its field at `null` — indistinguishable from a lane that genuinely could
 * not be computed, which is exactly the confusion the whole null-vs-0 contract exists to
 * prevent. The order still has to match the `tasks.push` below; that pairing is positional
 * (`SubTaskResult.taskIndex`) and is not something a type can carry.
 */
const NEGOTIATE_LANE_FIELDS = [
  "authoredPrs",
  "reviewedPrs",
  "tickets",
  "ownership",
  "decisions",
  "writing",
  "incidents",
] as const;
type NegotiateLaneField = (typeof NEGOTIATE_LANE_FIELDS)[number];

function isNegotiateLaneField(name: string | undefined): name is NegotiateLaneField {
  return name !== undefined && (NEGOTIATE_LANE_FIELDS as readonly string[]).includes(name);
}

/** The seven lane-backed fields, each `null` until its lane decodes successfully. */
type NegotiateLaneValues = {
  authoredPrs: NegotiateAuthoredPrs | null;
  reviewedPrs: NegotiateReviewedPrs | null;
  tickets: NegotiateTickets | null;
  ownership: NegotiateOwnership | null;
  decisions: NegotiateDecisions | null;
  writing: NegotiateWriting | null;
  incidents: NegotiateIncidents | null;
};

/**
 * Decode each completed lane's JSON into its field, appending a `laneFailureGap` to `gaps`
 * for any lane whose text will not parse.
 *
 * Lifted out of `runNegotiate` to bring it back under the cognitive-complexity gate (Sonar
 * S3776, was 20): the seven-arm `else if` chain this replaces was most of that score. A lane
 * that never ran, ran and failed, or decoded to nothing all leave their field at `null` —
 * unchanged from the chain, and the whole point of the mechanism.
 *
 * The single `as NegotiateLaneValues` stands in for the seven per-lane `as` casts it
 * replaces; it asserts the same thing they did (each lane's task returns the shape its field
 * declares) in one place instead of seven, and `Record<NegotiateLaneField, unknown>`
 * guarantees every key is present before the assertion is made.
 */
function decodeLaneResults(
  results: readonly SubTaskResult[],
  laneNames: readonly string[],
  gaps: GapNote[],
): NegotiateLaneValues {
  const out: Record<NegotiateLaneField, unknown> = {
    authoredPrs: null,
    reviewedPrs: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
    incidents: null,
  };
  for (const r of results) {
    // A non-`done` lane already got its gap from `reduceLaneResults`; only a DECODE failure
    // is this function's to report.
    if (r.status !== "done" || r.text === undefined) continue;
    const laneName = laneNames[r.taskIndex];
    try {
      const decoded: unknown = JSON.parse(r.text);
      if (isNegotiateLaneField(laneName)) out[laneName] = decoded;
    } catch {
      gaps.push(laneFailureGap(laneName ?? `#${String(r.taskIndex)}`, r));
    }
  }
  return out as NegotiateLaneValues;
}

export async function runNegotiate(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<NegotiateBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);
  const gaps: GapNote[] = [];

  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) gaps.push(empty);

  const { subject, gitEmailAttempted, subjectGap } = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());
  if (subjectGap !== null) gaps.push(subjectGap);
  // Never when `--person` named SOMEONE ELSE — their alias set is unknowable from here
  // (spec § 5.A0); `gitEmailAttempted` is only meaningful for the local self. Keyed on
  // `isOther`, not on `source === "explicit"`: `--person <your own id>` is still a brief
  // about you, resolved from your own git email, and dropping the undercount caveat there
  // would render a bare run and an explicit self run identically while one of them silently
  // omits a disclosure the other makes.
  if (!subject.isOther) {
    const gitGap = detectUnmappedGitIdentity(ctx.db, gitEmailAttempted);
    if (gitGap !== null) gaps.push(gitGap);
  }

  // Lane mechanism (spec § 4): every lane-backed field on `NegotiateBrief` must be
  // declared `… | null` and initialised to `null` before the coordinator runs, so a
  // lane that failed is distinguishable from a lane that ran and found nothing (`0`).
  // Each lane pushes a `{ name, task }` pair (name into `laneNames`, task into `tasks`,
  // same index); after the coordinator runs, `r.text` is decoded with `JSON.parse` for
  // `status === "done"` results and merged into the matching `NegotiateBrief` field —
  // leaving that field at `null` and pushing a `laneFailureGap` for any other status
  // (or for text that fails to decode).
  const laneNames: string[] = [];
  const tasks: SubTask[] = [];
  // Only attempt the PR lanes with a resolved subject: `laneAuthoredPrs`/`laneReviewedPrs`
  // require a concrete `personId`, and an unresolved subject already carries its own
  // `missing_user_identity` gap above — leaving these fields at their initial `null` here
  // is "not attempted", the same "could not be computed" meaning as a lane that threw.
  if (subject.personId !== null) {
    const personId = subject.personId;
    // The incidents lane's four-zero honesty contract (spec § 5.8): a structural zero
    // caused by "no PagerDuty connector" or "connector present, no incident edges yet"
    // must never render identically to a real `unattributable` measurement. Gated the
    // same as the lane itself — an unresolved subject already carries its own
    // `missing_user_identity` gap and must not also emit connector noise. Ordered more
    // fundamental cause first: no connector before no edges, since a missing connector
    // implies missing edges too and naming both would be redundant.
    // `detectMissingIncidentPersonEdges` builds an honest, scoped `GapNote` rather than
    // falling back to `detectMissingRelationToEntityType`'s shared default detail, which
    // says the edges are "not yet emitted by the graph populator" — false since
    // `syncIncidentPersonEdges` shipped.
    pushConnectorOrEdgeGap(ctx.db, "pagerduty", detectMissingIncidentPersonEdges, gaps);
    // `detectMissingErrorIssuePersonEdges` is scoped for its own reason — an unassigned
    // Sentry issue is the NORM, so the shared default's `nimbus index regraph` remediation
    // would be a no-op in the common case.
    pushConnectorOrEdgeGap(ctx.db, "sentry", detectMissingErrorIssuePersonEdges, gaps);
    // Same order as `tasks.push` below — the pairing is positional (`SubTaskResult.taskIndex`).
    laneNames.push(...NEGOTIATE_LANE_FIELDS);
    tasks.push(
      laneTask(() => laneAuthoredPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneReviewedPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneTickets(ctx.db, personId, sinceMs)),
      laneTask(() => laneOwnership(ctx.db, personId)),
      laneTask(() => laneDecisions(ctx.db, personId, sinceMs)),
      laneTask(() => laneWriting(ctx.db, personId, sinceMs, ctx.personalSources)),
      laneTask(() => laneIncidents(ctx.db, personId, sinceMs)),
    );
  }
  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `negotiate:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });
  const results = await coordinator.run(tasks);
  gaps.push(...reduceLaneResults(results, laneNames));

  const { authoredPrs, reviewedPrs, tickets, ownership, decisions, writing, incidents } =
    decodeLaneResults(results, laneNames, gaps);

  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    subject,
    sources: personalDocsSources(ctx.personalSources),
    unavailableEvidence: UNAVAILABLE_EVIDENCE,
    authoredPrs,
    reviewedPrs,
    incidents,
    tickets,
    ownership,
    decisions,
    writing,
  };
}

/**
 * `gitEmailAttempted` captures the raw email `resolveSelfPerson` tried against git config
 * (whether or not it ended up mapping to a `person` row) so `runNegotiate` can pass it to
 * `detectUnmappedGitIdentity`. It stays `null` whenever git was never consulted — e.g. an
 * `override`/explicit `mePersonIdOverride` short-circuits `resolveSelfPerson` before it
 * calls `runGit` at all — matching "call only when a git email is otherwise known" (Task 4
 * brief step 4).
 */
async function resolveSubject(
  db: Database,
  input: NegotiateInput,
): Promise<{
  subject: NegotiateSubject;
  gitEmailAttempted: string | null;
  subjectGap: GapNote | null;
}> {
  let gitEmailAttempted: string | null = null;
  const baseRunGit = input.runGitOverride ?? defaultRunGitConfigUserEmail;
  const capturingRunGit: GitRunner = async () => {
    const raw = await baseRunGit();
    gitEmailAttempted = raw === null || raw.trim() === "" ? null : raw;
    return raw;
  };
  // Always resolve the local self id, even for an explicit `--person`: `isOther` means
  // "named someone other than the resolved local user" (see `NegotiateSubject.isOther`'s
  // docstring), which is a comparison, not a fact derivable from `--person` being present.
  const resolution = await resolveSelfPerson(db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    runGit: capturingRunGit,
    osUsername: input.osUsernameOverride ?? safeOsUsername(),
  });
  if (input.personId !== undefined && input.personId.length > 0) {
    return {
      subject: {
        personId: input.personId,
        source: "explicit",
        displayName: personDisplayNameOrNull(db, input.personId),
        isOther: input.personId !== resolution.personId,
      },
      gitEmailAttempted,
      // The two arms fire only when the id is NOT a person row, so the zero-edge arm is the
      // fallback rather than an alternative — a `person` match reaches it, everything else
      // has already been described.
      subjectGap:
        explicitSubjectGap(classifyExplicitSubject(db, input.personId), input.personId) ??
        zeroEdgeSubjectGap(db, input.personId),
    };
  }
  return {
    subject: {
      personId: resolution.personId,
      source: resolution.source,
      displayName:
        resolution.personId === null ? null : personDisplayNameOrNull(db, resolution.personId),
      isOther: false,
    },
    gitEmailAttempted,
    // Was hard-coded `null`, which meant only an explicit `--person` could ever be disclosed —
    // and the split-identity failure was observed on the bare `nimbus negotiate` path, where
    // the resolver picks the subject and the user never named one.
    subjectGap: resolution.personId === null ? null : zeroEdgeSubjectGap(db, resolution.personId),
  };
}

function personDisplayNameOrNull(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as {
    display_name: string | null;
  } | null;
  return row?.display_name ?? null;
}

export function emitNegotiateBrief(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "negotiate.briefReady",
    briefErrorMethod: "negotiate.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runNegotiate(input, ctx),
  });
}
