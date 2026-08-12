import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import type {
  NegotiateAuthoredPrs,
  NegotiateBrief,
  NegotiateInput,
  NegotiateReviewedPrs,
  NegotiateSubject,
  NegotiateTickets,
} from "./_lib/negotiate-types.ts";
import { resolveSelfPerson } from "./_lib/self-person.ts";
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

  const subject = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());

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
    laneNames.push("authoredPrs", "reviewedPrs", "tickets");
    tasks.push(
      laneTask(() => laneAuthoredPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneReviewedPrs(ctx.db, personId, sinceMs)),
      laneTask(() => laneTickets(ctx.db, personId, sinceMs)),
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
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) continue;
    const laneName = laneNames[r.taskIndex];
    try {
      const decoded: unknown = JSON.parse(r.text);
      if (laneName === "authoredPrs") authoredPrs = decoded as NegotiateAuthoredPrs;
      else if (laneName === "reviewedPrs") reviewedPrs = decoded as NegotiateReviewedPrs;
      else if (laneName === "tickets") tickets = decoded as NegotiateTickets;
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
  };
}

async function resolveSubject(db: Database, input: NegotiateInput): Promise<NegotiateSubject> {
  // Always resolve the local self id, even for an explicit `--person`: `isOther` means
  // "named someone other than the resolved local user" (see `NegotiateSubject.isOther`'s
  // docstring), which is a comparison, not a fact derivable from `--person` being present.
  const resolution = await resolveSelfPerson(db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    ...(input.runGitOverride === undefined ? {} : { runGit: input.runGitOverride }),
    osUsername: input.osUsernameOverride ?? safeOsUsername(),
  });
  if (input.personId !== undefined && input.personId.length > 0) {
    return {
      personId: input.personId,
      source: "explicit",
      displayName: personDisplayNameOrNull(db, input.personId),
      isOther: input.personId !== resolution.personId,
    };
  }
  return {
    personId: resolution.personId,
    source: resolution.source,
    displayName:
      resolution.personId === null ? null : personDisplayNameOrNull(db, resolution.personId),
    isOther: false,
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
