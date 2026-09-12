import type { Database } from "bun:sqlite";
import type { GapNote } from "@nimbus-dev/sdk";

import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { type GitRunner, resolveSelfPerson } from "./_lib/self-person.ts";
import { basisCanBeMisplaced } from "./_lib/standup-time-basis.ts";
import type { StandupBrief, StandupIdentity } from "./_lib/standup-types.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import {
  countMessageThreads,
  nonGithubMergedPrCount,
  type StandupRow,
  selectActivePrs,
  selectIncidentsResponded,
  selectMergedPrs,
  selectMessages,
  selectPersonDisplayName,
  selectReviews,
  selectTicketsOpened,
  type Window,
} from "./standup-queries.ts";

/**
 * Per-lane display cap. Keeps a busy Slack day out of the synthesis prompt wholesale.
 *
 * Lower than `changelog`'s 50 would under-serve the one lane that routinely exceeds it
 * (messages); higher would put a thousand-line prompt in front of the model on a chatty day.
 * `counts` keeps the true pre-cap total per lane either way, so nothing is hidden — see
 * `StandupCounts`.
 */
export const STANDUP_CATEGORY_CAP = 50;

/**
 * Raised when no person could be resolved for the local owner.
 *
 * A dedicated class rather than a bare `Error`, so `ipc/agents-rpc.ts` can map it to a JSON-RPC
 * error code without string-matching a message — and declared HERE rather than imported from
 * `ipc/`, which would invert the dependency (`agents/*` is read by the IPC layer, never the
 * other way round).
 *
 * **Why this refuses instead of emitting an empty brief.** Every lane keys on the resolved person
 * id, so an unresolved identity yields six empty sections — indistinguishable from a genuinely
 * quiet day. This command's whole purpose is to produce text someone pastes into a channel, so
 * an empty standup is not a missing answer but a WRONG one: it asserts the author did nothing.
 * Matching the negation-query precedent from W6-B, which refuses on an empty substrate rather
 * than answering over it.
 */
export class StandupIdentityUnresolvedError extends Error {
  constructor() {
    super(
      "ERR_STANDUP_IDENTITY_UNRESOLVED: could not resolve which indexed person you are, so no " +
        "activity can be attributed. Nimbus tried `git config user.email` against indexed " +
        "people, then your OS username against indexed GitHub logins. Set `[user] mePersonId` " +
        'in nimbus.toml (find yours with `nimbus people list`), or run `git config user.email "…"` ' +
        "with the address your commits use.",
    );
    this.name = "StandupIdentityUnresolvedError";
  }
}

export type BuildStandupArgs = {
  readonly db: Database;
  readonly nowMs: number;
  /**
   * A lookback DURATION, not an absolute cutoff — the repo-wide convention for an agent input
   * (`agents/decisions.ts` states it; `catchup.ts` computes `now - sinceMs`). Named `lookbackMs`
   * rather than `sinceMs` precisely so it cannot be handed to SQL by mistake:
   * `created_at_ms >= 86400000` is January 1970, and would report the whole index as today's
   * work. `Window` carries the converted absolute bounds.
   */
  readonly lookbackMs: number;
  readonly identity: StandupIdentity;
  /**
   * A `performance.now()` ORIGIN, not an elapsed duration — `latencyMs` is computed at the END of
   * `buildStandupBrief`, after the lanes have run, exactly as `ownership.ts`, `decisions.ts`,
   * `glossary.ts` and `changelog.ts` do.
   *
   * Taking the elapsed time as an INPUT is the defect this shape exists to prevent, and it
   * shipped on `changelog` before review caught it: a `latencyMs: Date.now() - started` written
   * in the caller's object literal is evaluated BEFORE the function body runs, so it times
   * argument resolution and publishes ~0 ms in a footer the reader sees.
   */
  readonly startedAtMs: number;
};

/**
 * Split a lane's rows into the ones that will be LISTED and the ones the display cap drops,
 * keeping the true total so `counts` can report what the window actually held.
 *
 * `total` is not `kept.length` — that difference is the whole point. See `StandupCounts`.
 */
function cap(rows: readonly StandupRow[]): {
  kept: readonly StandupRow[];
  dropped: number;
  total: number;
} {
  return rows.length <= STANDUP_CATEGORY_CAP
    ? { kept: rows, dropped: 0, total: rows.length }
    : {
        kept: rows.slice(0, STANDUP_CATEGORY_CAP),
        dropped: rows.length - STANDUP_CATEGORY_CAP,
        total: rows.length,
      };
}

/**
 * The two categories this command's roadmap row promised that the index cannot supply, disclosed
 * UNCONDITIONALLY.
 *
 * Unconditional follows `ownership`'s standing-disclaimer precedent, and the reasoning is the
 * same one: a conditional note is absent exactly when the reader needs it. Both of these are
 * substrate holes rather than empty results, so there is no "today" on which they do not apply —
 * and a reader who ships a standup with no deploy line needs to know that means "not indexed",
 * not "I deployed nothing".
 *
 * Both were verified against the connectors, not the roadmap:
 *
 * - **Deployments have no person attribution at all.** `github-actions-sync.ts`,
 *   `circleci-sync.ts` and `jenkins-sync.ts` each write `authorId: null` on their `ci_run` rows,
 *   `deployment/annotate.ts` writes a literal `NULL` author for a deploy posted to
 *   `POST /v1/deployments`, and `graph/graph-populator.ts` emits no person→deployment edge. There
 *   is no query that could answer "deployments I triggered".
 * - **Ticket transitions and comments are not indexed.** No connector writes a comment item
 *   type, and Jira/Linear store only a ticket's CURRENT `metadata.status` — no transition event —
 *   so "tickets moved" has nothing to read. `assigned` edges exist for incidents and Sentry
 *   issues only, never Jira or Linear tickets, so assignment is not a fallback either.
 *
 * The third is not a substrate hole but a standing property of the attribution itself, and it
 * lives here for the same reason: every section is scoped to ONE person id, so a split identity
 * silently halves the brief. `resolveSelfPerson` picks whichever half its git-email lookup lands
 * on (`catchup.test.ts` records this as F26), and the other half's PRs, reviews and messages are
 * simply absent with nothing on the page suggesting a second account exists.
 *
 * All three sit in `## Gaps` rather than the preamble deliberately. A reserved section is
 * withheld from the model and re-attached verbatim, so a rewrite cannot drop it BY CONSTRUCTION
 * (I31) — strictly stronger than the anchor-phrase check an interleaved sentence gets. See
 * `standupDisclosures` for what stays in the preamble and why.
 */
function substrateGaps(): GapNote[] {
  return [
    {
      category: "missing_user_identity",
      detail:
        "Every section is attributed through the single indexed person this standup resolved " +
        "to, so anything your connectors recorded under a different account or email address " +
        "is absent. Where one human appears in the index as two people — a work email on " +
        "commits and a different address on tickets, say — this brief covers whichever half " +
        "was resolved and says nothing about the other.",
      remediation:
        "Check `nimbus people list` for a second record that is also you, and pin the one you " +
        "want with `[user] mePersonId` in nimbus.toml.",
    },
    {
      category: "missing_relation_emit",
      detail:
        "Deployments you triggered are absent and cannot be listed: no connector records who " +
        "started a deployment. Every `ci_run` row is indexed with no author, an annotated " +
        "deployment posted to `POST /v1/deployments` carries none either, and the relationship " +
        "graph holds no person-to-deployment edge. Their absence here says nothing about " +
        "whether you deployed.",
      remediation:
        "No action available today — the attribution is missing at the connector, not in your " +
        "configuration. `nimbus changelog` lists deployments without attributing them.",
    },
    {
      category: "missing_entity_type",
      detail:
        "Tickets you moved or commented on are absent and cannot be listed: ticket comments are " +
        "not indexed as items, and Jira and Linear are indexed with only a ticket's current " +
        "status rather than its transitions, so there is no record of a status change. Only " +
        "tickets you OPENED in the window appear below.",
      remediation:
        "No action available today — no connector indexes ticket comments or status transitions " +
        "as their own item type.",
    },
  ];
}

/**
 * Gaps about the IDENTITY the brief was scoped to, when the resolution is weaker than it looks.
 *
 * Separate from `substrateGaps` because these are conditional and about THIS run rather than the
 * index as a whole. Both cases produce a brief that looks ordinary and may be about the wrong
 * person or nobody, which is exactly when silence is worst.
 */
function identityGaps(identity: StandupIdentity): GapNote[] {
  const out: GapNote[] = [];
  if (identity.displayName === null) {
    out.push({
      category: "missing_user_identity",
      detail:
        `No indexed person record carries the id \`${identity.personId}\`, so every section ` +
        "below is empty because nothing can match it, not because nothing happened.",
      remediation:
        identity.source === "override"
          ? "`[user] mePersonId` in nimbus.toml is used verbatim and is never checked against " +
            "the index. Confirm the id with `nimbus people list`."
          : "Check that your connectors have synced and that your account appears in " +
            "`nimbus people list`.",
    });
  }
  if (identity.source === "os") {
    out.push({
      category: "missing_user_identity",
      detail:
        "Your identity was resolved by matching your operating-system username against indexed " +
        "GitHub logins, because `git config user.email` matched no indexed person. That is a " +
        "heuristic: where a colleague's GitHub login equals your OS username, this standup is " +
        "about them.",
      remediation:
        "Set `[user] mePersonId` in nimbus.toml, or set `git config user.email` to the address " +
        "your commits use.",
    });
  }
  return out;
}

/**
 * Assemble the brief.
 *
 * **Sequential, not `AgentCoordinator`.** The skill's "parallel where possible" rule is about
 * latency, and it does not apply to these lanes: `bun:sqlite` is a SYNCHRONOUS binding, so eight
 * queries wrapped in `Promise.all` execute one after another on the same thread exactly as they
 * do here — the coordinator would add a sub-agent ledger and fan-out bookkeeping for zero
 * concurrency. `changelog.ts` is sequential for the same reason. A future lane that awaits real
 * I/O (a `git` subprocess, a connector) is where the coordinator earns its place.
 */
export function buildStandupBrief(args: BuildStandupArgs): StandupBrief {
  // THE one conversion from duration to absolute bounds. Doing it anywhere else — or twice — is
  // the defect `BuildStandupArgs.lookbackMs`'s naming exists to prevent.
  const w: Window = { fromMs: args.nowMs - args.lookbackMs, toMs: args.nowMs };
  const me = args.identity.personId;

  const activeRows = selectActivePrs(args.db, w, me);
  const mergedRows = selectMergedPrs(args.db, w, me);
  const reviewRows = selectReviews(args.db, w, me);
  const ticketRows = selectTicketsOpened(args.db, w, me);
  const incidentRows = selectIncidentsResponded(args.db, w, me);
  const messageRows = selectMessages(args.db, w, me);
  const threadCount = countMessageThreads(args.db, w, me);
  const nonGithub = nonGithubMergedPrCount(args.db, w, me);

  const active = cap(activeRows);
  const merged = cap(mergedRows);
  const reviews = cap(reviewRows);
  const tickets = cap(ticketRows);
  const incidents = cap(incidentRows);
  const messages = cap(messageRows);

  // EVERY matched row, not just the listed ones — `approximateCount` is a claim about what the
  // WINDOW held, on the same basis as `counts`. Counting only the kept rows would make the
  // time-basis disclosure quietly mean "of the entries shown", and the two numbers in one brief
  // would then be on different bases.
  const allRows = [
    ...activeRows,
    ...mergedRows,
    ...reviewRows,
    ...ticketRows,
    ...incidentRows,
    ...messageRows,
  ];

  const gaps: GapNote[] = [...substrateGaps(), ...identityGaps(args.identity)];

  // Conditional on the two lanes it describes actually having entries — unlike the standing
  // notes above, this one has nothing to qualify on a brief with no reviews and no messages, and
  // an inapplicable caveat is how a reader learns to stop reading them.
  if (reviews.total > 0 || messages.total > 0) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "Reviews and Slack messages are placed by the index's own timestamp column rather than " +
        "by a separate event field. Those connectors write it from the event's own time and " +
        "never update the row, so it is the real moment in practice — but where the source " +
        "payload carried no timestamp at all, the row holds the time it was synced instead, " +
        "and nothing distinguishes the two afterwards.",
      remediation:
        "No action available today — neither connector indexes the submission or post " +
        "timestamp as its own metadata field.",
    });
  }

  if (nonGithub > 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(nonGithub)} merged pull request(s) of yours on a non-GitHub forge are not ` +
        "listed under merged: `merged_at` is written by the GitHub connector alone, so GitLab " +
        "and Bitbucket merges carry no merge timestamp to window on. That count is itself an " +
        "estimate for the same reason — with no merge timestamp it windows on when the index " +
        "last touched the row, so it omits a merge whose row has not been re-synced and " +
        "includes an older merge that was touched during the window.",
      remediation:
        "Track this as the same substrate gap `nimbus stats` reports as `github_only_merge_data`.",
    });
  }

  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: args.nowMs,
    // Computed HERE, after the lanes above, never taken as an input — see
    // `BuildStandupArgs.startedAtMs`.
    latencyMs: Math.round(performance.now() - args.startedAtMs),
    gaps,
    query: { sinceMs: w.fromMs, nowMs: args.nowMs },
    identity: args.identity,
    prsActive: active.kept,
    prsMerged: merged.kept,
    reviews: reviews.kept,
    ticketsOpened: tickets.kept,
    incidents: incidents.kept,
    messages: messages.kept,
    // TRUE, pre-cap totals — deliberately NOT `kept.length`. See `StandupCounts`.
    counts: {
      prsActive: active.total,
      prsMerged: merged.total,
      reviews: reviews.total,
      ticketsOpened: tickets.total,
      incidents: incidents.total,
      messages: messages.total,
    },
    threadCount,
    approximateCount: allRows.filter((r) => basisCanBeMisplaced(r.timeBasis)).length,
    nonGithubMergedPrs: nonGithub,
    truncatedCount:
      active.dropped +
      merged.dropped +
      reviews.dropped +
      tickets.dropped +
      incidents.dropped +
      messages.dropped,
  };
}

export type EmitStandupOpts = {
  readonly db: Database;
  readonly sessionId: string;
  /** A lookback DURATION — see `BuildStandupArgs.lookbackMs`. */
  readonly lookbackMs: number;
  /** `[user] mePersonId`, read from `nimbus.toml` by the caller. Used VERBATIM when present. */
  readonly mePersonIdOverride?: string;
  /** Injected in tests so no `git` subprocess runs; production passes nothing. */
  readonly runGit?: GitRunner;
  /** Injected in tests; production passes nothing and `resolveSelfPerson` reads `os.userInfo`. */
  readonly osUsername?: string;
  readonly notify: (method: string, params: unknown) => void;
  readonly runner?: SynthesisRunner;
};

/**
 * Resolve who the owner is, then build and emit the brief.
 *
 * Identity resolution is `resolveSelfPerson` UNCHANGED (`_lib/self-person.ts`): the
 * `[user] mePersonId` override, else `git config user.email` matched against indexed canonical
 * emails, else the OS username matched against indexed GitHub logins. Reused rather than
 * reimplemented so `nimbus standup` and `nimbus catchup` can never disagree about who "me" is —
 * the failure that would produce is two briefs about two different people with nothing saying so.
 *
 * Resolution happens BEFORE `emitBriefWithSynthesis`, so a refusal is a JSON-RPC error the CLI
 * exits on rather than a `standup.briefError` notification carrying an empty brief.
 */
export async function emitStandupBrief(opts: EmitStandupOpts): Promise<{ sessionId: string }> {
  // The ORIGIN the builder measures against, taken before any work begins — including identity
  // resolution, which spawns `git` and is a real part of the latency the footer reports.
  // `performance.now()` rather than `Date.now()`, matching `ownership.ts`/`changelog.ts`: a
  // monotonic clock cannot be walked backwards by an NTP step mid-brief.
  const startedAtMs = performance.now();

  const resolution = await resolveSelfPerson(opts.db, {
    ...(opts.mePersonIdOverride === undefined ? {} : { override: opts.mePersonIdOverride }),
    ...(opts.runGit === undefined ? {} : { runGit: opts.runGit }),
    ...(opts.osUsername === undefined ? {} : { osUsername: opts.osUsername }),
  });
  if (resolution.personId === null) throw new StandupIdentityUnresolvedError();

  const identity: StandupIdentity = {
    personId: resolution.personId,
    source: resolution.source,
    displayName: selectPersonDisplayName(opts.db, resolution.personId),
  };

  return await emitBriefWithSynthesis<StandupBrief>({
    sessionId: opts.sessionId,
    briefReadyMethod: "standup.briefReady",
    briefErrorMethod: "standup.briefError",
    notify: opts.notify,
    ...(opts.runner === undefined ? {} : { runner: opts.runner }),
    buildBrief: async () =>
      buildStandupBrief({
        db: opts.db,
        nowMs: Date.now(),
        // A DURATION, converted to absolute bounds exactly once inside the builder.
        lookbackMs: opts.lookbackMs,
        identity,
        startedAtMs,
      }),
  });
}
