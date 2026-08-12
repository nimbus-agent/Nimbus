import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { normalizeEmail } from "../people/person-store.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateBrief,
  NegotiateDecisions,
  NegotiateInput,
  NegotiateOwnership,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
} from "./_lib/negotiate-types.ts";
import {
  defaultRunGitConfigUserEmail,
  type GitRunner,
  resolveSelfPerson,
} from "./_lib/self-person.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const DEFAULT_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SINCE_MS = 365 * 24 * 60 * 60 * 1000;

export type NegotiateContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

const PERSONAL_DOCS_CONFIG_KEY = "[negotiate] personal_sources";

const UNAVAILABLE_EVIDENCE: readonly string[] = Object.freeze([
  "incidents resolved",
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
 * `person --authored--> pr` (graph_relation) joined back to `item` for the PR's metadata.
 * PR size stats (`additions`/`deletions`/`changed_files`) live in that metadata only where
 * the enrichment pass has run, hence `statsCoverage`: an aggregate over a partial subset
 * must disclose its own denominator rather than be printed as if it covered everything.
 */
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

  let merged = 0;
  let covered = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable metadata contributes to neither the merged count nor stats coverage.
      continue;
    }
    if (meta["merged"] === true) merged += 1;
    const a = meta["additions"];
    if (typeof a === "number") {
      covered += 1;
      additions += a;
      const d = meta["deletions"];
      if (typeof d === "number") deletions += d;
      const c = meta["changed_files"];
      if (typeof c === "number") changedFiles += c;
    }
  }
  return {
    count: rows.length,
    merged,
    stats: covered === 0 ? null : { additions, deletions, changedFiles },
    statsCoverage: { covered, total: rows.length },
  };
}

/**
 * Queries `item` directly (not the graph): a `review` item's `metadata.state` is nullable
 * (GitHub can omit it), and every review must be counted somewhere — `otherOrUnknown` catches
 * `commented`, `dismissed`, and the null case, never silently dropping a row.
 *
 * `json_valid(i.metadata)` in the WHERE clause is required, not decorative: `json_extract`
 * raises on unparseable JSON, and an unguarded call in a WHERE clause kills the query for
 * every row, not just the bad one (measured on bun 1.3.14 / SQLite 3.53.0).
 *
 * No `item(author_id)` index: `item` narrows hard first on `service`/`type` before this
 * unindexed filter runs, which is deliberate for a personal index — see spec § 4/Task 2 brief.
 */
function laneReviewedPrs(db: Database, personId: string, sinceMs: number): NegotiateReviewedPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT json_extract(i.metadata, '$.state') AS state
         FROM item i
        WHERE i.service = 'github'
          AND i.type = 'review'
          AND i.author_id = ?
          AND i.modified_at >= ?
          AND json_valid(i.metadata)`,
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
  return { count: rows.length, approved, changesRequested, otherOrUnknown };
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

  return { opened: opened.n, closedByAuthoredPr: closed.n };
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

  return { authored: authored.n, unattributable: unattributable.n };
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

export async function runNegotiate(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<NegotiateBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);
  const gaps: GapNote[] = [];

  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) gaps.push(empty);

  const { subject, gitEmailAttempted } = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());
  // Never for an explicit `--person` subject — someone else's alias set is unknowable
  // from here (spec § 5.A0); `gitEmailAttempted` is only meaningful for the local self.
  if (subject.source !== "explicit") {
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
    laneNames.push("authoredPrs", "reviewedPrs", "tickets", "ownership", "decisions");
    tasks.push(
      laneTask(() => laneAuthoredPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneReviewedPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneTickets(ctx.db, personId, sinceMs)),
      laneTask(() => laneOwnership(ctx.db, personId)),
      laneTask(() => laneDecisions(ctx.db, personId, sinceMs)),
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

  let authoredPrs: NegotiateAuthoredPrs | null = null;
  let reviewedPrs: NegotiateReviewedPrs | null = null;
  let tickets: NegotiateTickets | null = null;
  let ownership: NegotiateOwnership | null = null;
  let decisions: NegotiateDecisions | null = null;
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) continue;
    const laneName = laneNames[r.taskIndex];
    try {
      const decoded: unknown = JSON.parse(r.text);
      if (laneName === "authoredPrs") authoredPrs = decoded as NegotiateAuthoredPrs;
      else if (laneName === "reviewedPrs") reviewedPrs = decoded as NegotiateReviewedPrs;
      else if (laneName === "tickets") tickets = decoded as NegotiateTickets;
      else if (laneName === "ownership") ownership = decoded as NegotiateOwnership;
      else if (laneName === "decisions") decisions = decoded as NegotiateDecisions;
    } catch {
      gaps.push(laneFailureGap(laneName ?? `#${String(r.taskIndex)}`, r));
    }
  }

  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    subject,
    sources: {
      personalDocsConfigured: false,
      personalDocsConfigKey: PERSONAL_DOCS_CONFIG_KEY,
    },
    unavailableEvidence: UNAVAILABLE_EVIDENCE,
    authoredPrs,
    reviewedPrs,
    tickets,
    ownership,
    decisions,
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
): Promise<{ subject: NegotiateSubject; gitEmailAttempted: string | null }> {
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
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runNegotiate(input, ctx),
  });
}
