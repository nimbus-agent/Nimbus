import type { Database } from "bun:sqlite";

import type { GapNote } from "../findings.ts";

export function unresolvedIdentityGap(): GapNote {
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

export function classifyExplicitSubject(db: Database, personId: string): ExplicitSubjectMatch {
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
export function explicitSubjectGap(match: ExplicitSubjectMatch, personId: string): GapNote | null {
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
export function zeroEdgeSubjectGap(db: Database, personId: string): GapNote | null {
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
