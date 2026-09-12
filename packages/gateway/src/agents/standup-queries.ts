import type { Database } from "bun:sqlite";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  finiteNumberField,
  metadataRecord,
  type StandupTimeBasis,
} from "./_lib/standup-time-basis.ts";

/**
 * ABSOLUTE epoch bounds, half-open `[fromMs, toMs)`.
 *
 * Named `fromMs`/`toMs` and NOT `sinceMs`, matching `changelog-queries.ts`: repo-wide, `sinceMs`
 * on an agent input is a lookback DURATION (`agents/decisions.ts` states the convention and
 * points at `catchup.ts`'s `now - sinceMs`). Handing that duration to SQL would compare
 * `created_at_ms >= 86400000`, i.e. January 1970, and report the entire index as today's work —
 * which on THIS command is a standup someone pastes into Slack. The conversion happens exactly
 * once, in `buildStandupBrief`.
 *
 * Half-open matches `metrics/stats.ts` rather than `dora.ts`'s inclusive `>= AND <=`. The repo
 * carries both, and `stats.ts` already records the boundary double-counting the inclusive form
 * causes — which for a command run daily over adjacent windows would mean an event on the
 * boundary appearing in two consecutive standups.
 */
export type Window = {
  readonly fromMs: number;
  readonly toMs: number;
};

/**
 * One entry, with the provenance of its own timestamp attached.
 *
 * `timeBasis` travels WITH the row rather than being a per-lane constant the renderer looks up,
 * because `nonGithubMergedPrCount` and the merged lane disagree about it for the same item type:
 * a GitHub PR is placed by `metadata.merged_at` (`event_field`) and a GitLab MR has no such
 * field at all. A lane-keyed lookup would have to state one answer for `pr`.
 */
export type StandupRow = {
  readonly id: string;
  readonly service: string;
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
  readonly timeBasis: StandupTimeBasis;
};

type RawRow = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

/**
 * Newest first, ties broken by `id`.
 *
 * The tiebreak is not cosmetic. `standup.ts`'s `cap()` keeps the FIRST
 * `STANDUP_CATEGORY_CAP` rows of each lane, so where more rows than that share a timestamp —
 * a bulk backfill, a burst of Slack messages inside one second, a batch of reviews submitted
 * together — SQLite's unspecified `SELECT` order would decide which entries the reader sees,
 * and two runs over an unchanged index could list different ones. `nimbus fleet digest`
 * compares `findings_json` between runs to report what moved, so that instability would surface
 * as a fabricated change. `codeUnitCompare`, never `localeCompare`: the latter is locale-
 * dependent and would order the same index differently on two machines.
 */
function byRecencyThenId(a: StandupRow, b: StandupRow): number {
  return b.atMs - a.atMs || codeUnitCompare(a.id, b.id);
}

/**
 * Rows placed by a dedicated EVENT FIELD in connector metadata, windowed on that field directly
 * with no `modified_at` pre-filter.
 *
 * The pre-filter looks free — `modified_at` is indexed, the event field is not — and is unsound:
 * `index/item-store.ts` writes `modified_at = excluded.modified_at`, a wholesale replacement
 * rather than a `MAX()`, so monotonicity is a property of each upstream API and not a local
 * guarantee. The failure mode is a merged PR silently missing from the standup with nothing
 * saying it was dropped. `metrics/dora.ts`'s `selectAttributionIncidents` makes the same trade.
 *
 * `jsonPath` is interpolated, not bound, because SQLite will not accept a parameter as
 * `json_extract`'s path argument. Every caller passes a module-private literal — there is no
 * path here derived from user input, and adding one would need a bound rewrite rather than a
 * new caller.
 */
function selectByEventField(
  db: Database,
  w: Window,
  personId: string,
  opts: { type: string; jsonPath: string; extraSql?: string },
): StandupRow[] {
  const raw = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, i.modified_at, i.metadata
         FROM item i
        WHERE i.type = ?
          AND i.author_id = ?
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '${opts.jsonPath}') >= ?
          AND json_extract(i.metadata, '${opts.jsonPath}') < ?
          ${opts.extraSql ?? ""}`,
    )
    .all(opts.type, personId, w.fromMs, w.toMs) as RawRow[];

  const field = opts.jsonPath.replace(/^\$\./, "");
  const out: StandupRow[] = [];
  for (const r of raw) {
    const meta = metadataRecord(r.metadata);
    if (meta === null) continue;
    // Re-checked in TypeScript: the SQL comparison above would accept a STRING here by
    // SQLite's type ordering. See `finiteNumberField`.
    const atMs = finiteNumberField(meta, field);
    if (atMs === null || atMs < w.fromMs || atMs >= w.toMs) continue;
    out.push({
      id: r.id,
      service: r.service,
      title: r.title,
      url: r.url,
      atMs,
      timeBasis: "event_field",
    });
  }
  return out.sort(byRecencyThenId);
}

/** Rows placed by the `modified_at` column, on the basis the caller declares for that lane. */
function selectByModifiedAt(
  db: Database,
  w: Window,
  personId: string,
  opts: { type: string; basis: StandupTimeBasis; extraSql?: string },
): StandupRow[] {
  const raw = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, i.modified_at, i.metadata
         FROM item i
        WHERE i.type = ?
          AND i.author_id = ?
          AND i.modified_at >= ?
          AND i.modified_at < ?
          ${opts.extraSql ?? ""}`,
    )
    .all(opts.type, personId, w.fromMs, w.toMs) as RawRow[];

  return raw
    .map((r) => ({
      id: r.id,
      service: r.service,
      title: r.title,
      url: r.url,
      atMs: r.modified_at,
      timeBasis: opts.basis,
    }))
    .sort(byRecencyThenId);
}

/**
 * Pull requests of mine the index touched in the window and that are NOT merged.
 *
 * **This lane is `last_touch` and its heading says so** — the brief renders it as "Pull requests
 * active", never "opened". A `pr` row carries no creation timestamp at all:
 * `github-sync.ts`'s `extractPrMetadataForIndex` writes `number`, `repo`, `state`, `draft`,
 * `merged`, `user`, `labels`, `mergeable`, `additions`, `deletions`, `changed_files`, `commits`
 * and the two merge fields — there is no `created_at`, so "pull requests I OPENED in the last 24
 * hours" is not a question this index can answer. `modified_at` is GitHub's `updated_at`, so what
 * it can answer is "pull requests of mine that moved", which for a standup is the more useful
 * question anyway: a PR of mine that moved yesterday is what I am working on, whenever I opened
 * it.
 *
 * Merged PRs are excluded because they are reported by {@link selectMergedPrs} — listing one
 * under both headings would double-count the same work in one brief. The exclusion is on being
 * merged AT ALL, not merged within the window: a PR merged last month that a comment touched
 * yesterday is finished work, not something in flight.
 *
 * Both merge signals are checked. `metadata.merged_at` is written by `github-sync.ts` alone, so
 * on GitLab and Bitbucket rows the only evidence of a merge is `metadata.state`. Testing just
 * one would leave every merged MR on those forges sitting in the "active" list.
 */
export function selectActivePrs(db: Database, w: Window, personId: string): StandupRow[] {
  return selectByModifiedAt(db, w, personId, {
    type: "pr",
    basis: "last_touch",
    extraSql:
      " AND (json_valid(i.metadata) = 0 OR (" +
      "json_extract(i.metadata, '$.merged_at') IS NULL" +
      " AND COALESCE(json_extract(i.metadata, '$.state'), '') <> 'merged'" +
      " AND COALESCE(json_extract(i.metadata, '$.merged'), 0) <> 1))",
  });
}

/**
 * Pull requests of mine merged in the window, placed by `metadata.merged_at`.
 *
 * GitHub-only by substrate, not by choice: `github-sync.ts`'s `applyMergeFields` is the only
 * writer of `merged_at` in the repo. {@link nonGithubMergedPrCount} counts what this therefore
 * cannot see, so the brief can disclose it instead of reporting a quiet day.
 */
export function selectMergedPrs(db: Database, w: Window, personId: string): StandupRow[] {
  return selectByEventField(db, w, personId, { type: "pr", jsonPath: "$.merged_at" });
}

/**
 * Reviews I submitted in the window.
 *
 * `event_column`, not `last_touch`: `github-sync.ts` writes one `review` row per review id
 * (`<repo>#<pr>#<reviewId>`) and sets `modifiedAt` from that review's own `submitted_at`, so the
 * column holds the submission instant and a re-sync recomputes the same value. See
 * `standup-time-basis.ts` for the narrow fallback that keeps this from being `event_field`.
 *
 * Read from the `review` ITEM rather than the `reviewed` graph edge (person → pr), which
 * `expert.ts` and `negotiate.ts` use. The edge points at the PULL REQUEST, so windowing it means
 * windowing on the PR's mutable `modified_at` — a review I left in June lands in today's standup
 * the moment anyone comments on that PR. The item carries the review's own timestamp, its own
 * title and its own permalink.
 */
export function selectReviews(db: Database, w: Window, personId: string): StandupRow[] {
  return selectByModifiedAt(db, w, personId, { type: "review", basis: "event_column" });
}

/**
 * Tickets I opened in the window, placed by `metadata.created_at_ms`.
 *
 * Written by BOTH ticket connectors — `jira-sync.ts` from `fields.created`, `linear-sync.ts`
 * from `createdAt` — so unlike the merged-PR lane this one has no single-forge hole.
 *
 * Tickets I MOVED or COMMENTED ON are not here and cannot be: no connector indexes a ticket
 * comment as an item, and no status TRANSITION is indexed either (Jira and Linear store only the
 * current `metadata.status`). `standup.ts` discloses that unconditionally rather than letting
 * this heading imply it covers ticket activity in general.
 */
export function selectTicketsOpened(db: Database, w: Window, personId: string): StandupRow[] {
  return selectByEventField(db, w, personId, { type: "issue", jsonPath: "$.created_at_ms" });
}

/**
 * Slack messages I posted in the window.
 *
 * `event_column` for {@link selectReviews}' reason: `slack-sync.ts` writes one row per
 * `<channel>:<ts>` and sets `modifiedAt` to `round(parseFloat(ts) * 1000)` — the post instant,
 * taken from the row's own key.
 */
export function selectMessages(db: Database, w: Window, personId: string): StandupRow[] {
  return selectByModifiedAt(db, w, personId, { type: "message", basis: "event_column" });
}

/**
 * How many distinct Slack THREADS my messages in the window touched.
 *
 * The roadmap's unit for this lane is "Slack threads participated in", and a count of messages
 * answers a different question: eleven replies in one thread is one conversation, not eleven.
 * Computed over the same window as {@link selectMessages} and from the same column the entries
 * are placed by, so the two numbers in the brief are on one basis.
 *
 * A top-level message has `thread_ts` NULL, and is its own thread — hence the `COALESCE` onto
 * `external_id`, which is `<channel>:<ts>` and therefore unique per message. Keying only on
 * `thread_ts` would collapse every unthreaded message in the window into a single bucket.
 */
export function countMessageThreads(db: Database, w: Window, personId: string): number {
  const row = db
    .query(
      `SELECT COUNT(DISTINCT COALESCE(
                CASE WHEN json_valid(i.metadata)
                     THEN json_extract(i.metadata, '$.thread_ts')
                     ELSE NULL END,
                i.external_id)) AS n
         FROM item i
        WHERE i.type = 'message'
          AND i.author_id = ?
          AND i.modified_at >= ?
          AND i.modified_at < ?`,
    )
    .get(personId, w.fromMs, w.toMs) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Incidents I responded to in the window — assigned to me, or resolved by me.
 *
 * The only lane that must go through the relationship graph. An incident's `item.author_id` is
 * whoever the connector recorded as its creator, which is not the responder, and responder
 * attribution exists only as graph edges: `graph-populator.ts` writes `person --assigned-->
 * incident` from `metadata.assignee_email` and `person --resolves--> incident` from
 * `metadata.resolved_by_email`.
 *
 * `last_touch`, and honestly so. There is no per-response timestamp anywhere — the edge carries
 * none and the incident row's `modified_at` is mutable — so this windows on the same basis
 * `metrics/dora.ts` ships for incident resolution, and the brief discloses it. The direction of
 * the error is worth stating: an incident I resolved inside the window whose row has not been
 * re-synced since is MISSING, so this lane under-reports by sync lag.
 *
 * `DISTINCT` on the item, not on the edge: both edge types can exist for one incident (I was
 * assigned it and I resolved it), and without this that incident is listed twice.
 */
export function selectIncidentsResponded(db: Database, w: Window, personId: string): StandupRow[] {
  const raw = db
    .query(
      `SELECT DISTINCT i.id, i.service, i.title, i.url, i.modified_at, i.metadata
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
         JOIN item i          ON i.id = ie.external_id
        WHERE r.type IN ('assigned', 'resolves')
          AND pe.external_id = ?
          AND i.modified_at >= ?
          AND i.modified_at < ?`,
    )
    .all(personId, w.fromMs, w.toMs) as RawRow[];

  return raw
    .map((r) => ({
      id: r.id,
      service: r.service,
      title: r.title,
      url: r.url,
      atMs: r.modified_at,
      timeBasis: "last_touch" as const,
    }))
    .sort(byRecencyThenId);
}

/**
 * How many merged pull requests of mine this standup CANNOT place.
 *
 * `metadata.merged_at` is written by `github-sync.ts` alone — neither `gitlab-sync.ts` nor
 * `bitbucket-sync.ts` populates it — so every merged GitLab MR and Bitbucket PR is invisible to
 * {@link selectMergedPrs}. Counting them turns a silent substrate hole into a disclosed one,
 * reusing the gap `metrics/stats.ts` already ships as `github_only_merge_data`.
 *
 * **This is an ESTIMATE and its caller must say so.** The absence of `merged_at` is the entire
 * reason this function exists, so there is no merge timestamp to window on and it falls back to
 * `modified_at` — hence `last_touch`. It misses in BOTH directions: a PR merged inside the window
 * whose row has not been re-synced is not counted, and one merged months ago that a comment
 * touched during the window is. A bare count printed beside event-windowed ones would read as
 * the same kind of number.
 *
 * `i.service <> 'github'` rather than a forge allow-list: the property that matters is "no
 * connector wrote `merged_at` for this row", which is true of every non-GitHub forge including
 * one added later.
 */
export function nonGithubMergedPrCount(db: Database, w: Window, personId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM item i
        WHERE i.type = 'pr'
          AND i.author_id = ?
          AND i.service <> 'github'
          AND i.modified_at >= ?
          AND i.modified_at < ?
          AND json_valid(i.metadata)
          AND (json_extract(i.metadata, '$.state') = 'merged'
               OR json_extract(i.metadata, '$.merged') = 1)`,
    )
    .get(personId, w.fromMs, w.toMs) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * The resolved person's display name, for the brief header.
 *
 * `null` when the person row is absent, which is reachable: `resolveSelfPerson` returns the
 * `[user] mePersonId` override VERBATIM without checking that it names a real person
 * (`self-person.ts` short-circuits on it before either lookup). A brief headed by a raw person
 * id is the honest rendering of that; inventing a name from the id would not be.
 */
export function selectPersonDisplayName(db: Database, personId: string): string | null {
  const row = db.query(`SELECT display_name FROM person WHERE id = ?`).get(personId) as {
    display_name: string | null;
  } | null;
  const name = row?.display_name ?? null;
  return name === null || name.trim().length === 0 ? null : name;
}
