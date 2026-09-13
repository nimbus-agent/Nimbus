import type { Database } from "bun:sqlite";

import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  finiteNumberField,
  metadataRecord,
  nonEmptyStringField,
  stringArrayField,
} from "./_lib/item-metadata.ts";
import type {
  OncallChange,
  OncallCiRun,
  OncallDeployment,
  OncallIncident,
  OncallMessage,
  OncallPriorIncident,
  OncallSyncFreshness,
} from "./_lib/oncall-types.ts";

/**
 * ABSOLUTE epoch bounds, half-open `[fromMs, toMs)`.
 *
 * Named `fromMs`/`toMs` and NOT `sinceMs`, matching `standup-queries.ts` and
 * `changelog-queries.ts`: repo-wide, `sinceMs` on an agent INPUT is a lookback DURATION, and
 * handing that duration to SQL compares against January 1970 and matches the whole index. The
 * conversion happens exactly once, in `buildOncallBrief`.
 */
export type Window = {
  readonly fromMs: number;
  readonly toMs: number;
};

/** The connector id PagerDuty rows and its `sync_state` row are keyed under. */
const PAGERDUTY_SERVICE = "pagerduty";

/**
 * Whether an incident counts as ACTIVE — the ONE definition, used by every selection path.
 *
 * **A MISSING status counts as active.** `pagerduty-sync.ts` writes `status: status ?? null`, so
 * a payload that carried none leaves `null` here, and the two candidate readings are not
 * symmetric: treating an unknown status as resolved HIDES an incident from the on-call engineer
 * looking for it, while treating it as active shows one extra row they can dismiss in a second.
 * Fail toward showing.
 *
 * Compared case-insensitively. PagerDuty writes lowercase today and nothing in the index enforces
 * that — a connector version, a manual backfill or a future provider writing `Resolved` would
 * otherwise make every closed incident read active, which is the failure that fills this brief
 * with noise until nobody runs it.
 */
function isActiveStatus(status: string | null): boolean {
  return status === null || status.toLowerCase() !== "resolved";
}

type RawItemRow = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

/**
 * Build an {@link OncallIncident} from a raw row, or `null` when the row cannot be trusted.
 *
 * `null` on malformed metadata rather than a partially-populated incident: every downstream lane
 * scopes on `pagerdutyServiceId` and windows on `openedAtMs`, so an incident whose metadata did
 * not parse would silently produce a brief with an unscoped deploy lane and no prior incidents —
 * a page that looks complete and is about nothing.
 */
function toIncident(r: RawItemRow): OncallIncident | null {
  const meta = metadataRecord(r.metadata);
  if (meta === null) return null;
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    status: nonEmptyStringField(meta, "status"),
    severity: nonEmptyStringField(meta, "severity"),
    urgency: nonEmptyStringField(meta, "urgency"),
    // Re-checked in TypeScript: `json_extract` returns whatever the JSON held, and SQLite orders
    // a string above every number. See `finiteNumberField`.
    openedAtMs: finiteNumberField(meta, "opened_at_ms"),
    pagerdutyServiceId: nonEmptyStringField(meta, "pagerduty_service_id"),
    assigneeEmails: stringArrayField(meta, "assignee_emails"),
  };
}

/**
 * Newest by OPENED time first, ties broken by id.
 *
 * The tiebreak is not cosmetic: the first element of this list is the incident `oncall`
 * auto-selects, so an unspecified `SELECT` order would let two runs over an unchanged index brief
 * two different incidents. `codeUnitCompare`, never `localeCompare` — the latter is locale-
 * dependent and would order the same index differently on two machines.
 *
 * An incident with NO `opened_at_ms` sorts LAST regardless of id. It cannot be placed in time at
 * all, and auto-selecting one over an incident that carries a real open time would pick the row
 * we know least about.
 */
function byOpenedThenId(a: OncallIncident, b: OncallIncident): number {
  if (a.openedAtMs === null && b.openedAtMs === null) return codeUnitCompare(a.id, b.id);
  if (a.openedAtMs === null) return 1;
  if (b.openedAtMs === null) return -1;
  return b.openedAtMs - a.openedAtMs || codeUnitCompare(a.id, b.id);
}

const INCIDENT_COLUMNS = `i.id, i.service, i.title, i.url, i.modified_at, i.metadata`;

/**
 * Active incidents assigned to this person, newest first.
 *
 * Reaches the person through `graph_relation` rather than `metadata.assignee_emails`, and the
 * choice matters: `standup.ts`'s `selectIncidentsResponded` already joins these exact tables on
 * these exact edge types, so sharing the path is what keeps `nimbus oncall` and `nimbus standup`
 * from disagreeing about which incidents are mine. Matching on the email array would additionally
 * require resolving a person id back to every address they are indexed under, which
 * `graph-populator.ts` has already done once when it wrote the edge.
 *
 * `assigned` OR `resolves`, matching standup: PagerDuty's `last_status_change_by` produces the
 * latter, and an engineer who acknowledged an incident is on it whether or not the assignment
 * stuck.
 */
export function selectActiveAssignedIncidents(db: Database, personId: string): OncallIncident[] {
  const raw = db
    .query(
      `SELECT DISTINCT ${INCIDENT_COLUMNS}
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
         JOIN item i          ON i.id = ie.external_id
        WHERE r.type IN ('assigned', 'resolves')
          AND pe.external_id = ?
          AND i.type = 'incident'`,
    )
    .all(personId) as RawItemRow[];

  return raw
    .map(toIncident)
    .filter((i): i is OncallIncident => i !== null && isActiveStatus(i.status))
    .sort(byOpenedThenId);
}

/**
 * One incident by its item id, whatever its status.
 *
 * Deliberately NOT status-filtered. This backs `--incident <id>`, where the caller has named the
 * row: refusing to brief a resolved incident they explicitly asked for would be the command
 * second-guessing an instruction, and reading a just-closed incident's deploy and change lanes is
 * a normal thing to want during a postmortem.
 */
export function selectIncidentById(db: Database, itemId: string): OncallIncident | null {
  const raw = db
    .query(`SELECT ${INCIDENT_COLUMNS} FROM item i WHERE i.id = ? AND i.type = 'incident' LIMIT 1`)
    .get(itemId) as RawItemRow | null;
  return raw === null ? null : toIncident(raw);
}

/**
 * Active incidents on any of the given PagerDuty services, newest first.
 *
 * Backs the `--service` path, which is also the only shape an EXTERNAL caller may use — see
 * `ipc/agents-rpc.ts`'s `requireOncallParams`, where the owner-scoped zero-parameter shape is
 * refused over HTTP/MCP for the reason invariant `I36` refuses a federated file question.
 *
 * An EMPTY service list matches nothing rather than everything. An unbound `IN ()` is a SQL error
 * in most engines and an accident in the rest; here the caller reaching this with no services has
 * a service that maps to no PagerDuty id, and the honest answer is "no incidents I can see", not
 * "every incident in the index".
 */
export function selectActiveIncidentsForPagerdutyServices(
  db: Database,
  pagerdutyServiceIds: readonly string[],
): OncallIncident[] {
  if (pagerdutyServiceIds.length === 0) return [];
  const placeholders = pagerdutyServiceIds.map(() => "?").join(",");
  const raw = db
    .query(
      `SELECT ${INCIDENT_COLUMNS}
         FROM item i
        WHERE i.service = '${PAGERDUTY_SERVICE}'
          AND i.type = 'incident'
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '$.pagerduty_service_id') IN (${placeholders})`,
    )
    .all(...pagerdutyServiceIds) as RawItemRow[];

  return raw
    .map(toIncident)
    .filter((i): i is OncallIncident => i !== null && isActiveStatus(i.status))
    .sort(byOpenedThenId);
}

/**
 * How stale the PagerDuty index is.
 *
 * This qualifies the SELECTION, not merely a count, which is why it is a first-class lane rather
 * than a footnote: `metadata.status` is only as current as this timestamp, so a brief assembled
 * from a six-hour-old sync may be about an incident that closed five hours ago.
 * `metrics/dora.ts` records the same dependency for its own reasons.
 *
 * The two null cases are kept apart because their fixes are opposite — see
 * {@link OncallSyncFreshness.reason}. `db/index-health.ts` splits them the same way.
 */
export function readPagerdutySyncFreshness(db: Database, nowMs: number): OncallSyncFreshness {
  const row = db
    .query(`SELECT last_sync_at FROM sync_state WHERE connector_id = ? LIMIT 1`)
    .get(PAGERDUTY_SERVICE) as { last_sync_at: number | null } | null;

  if (row === null) return { lastSyncMs: null, ageMs: null, reason: "no_sync_record" };
  const last = row.last_sync_at;
  if (last === null || !Number.isFinite(last)) {
    return { lastSyncMs: null, ageMs: null, reason: "never_synced" };
  }
  // Clamped at zero: a clock step or a sync row written by a machine running ahead would
  // otherwise report a NEGATIVE age, which renders as "synced in -3 minutes" in a brief someone
  // reads under pressure.
  return { lastSyncMs: last, ageMs: Math.max(0, nowMs - last), reason: null };
}

/**
 * The deployment that most recently STARTED before `beforeMs`, on this service and environments.
 *
 * **Strictly before**, not `<=`. A deploy whose recorded start equals the incident's open instant
 * to the millisecond did not precede it in any useful sense, and including it would let a brief
 * assert a deploy "before the alert" that a reader comparing the two printed timestamps can see
 * is simultaneous.
 *
 * Ordered on `started_at_ms DESC` with an `id` tiebreak, which the
 * `idx_deployment_items_service_env_started` index already serves for the first key.
 */
export function selectLastDeploymentBefore(
  db: Database,
  nimbusServiceId: string,
  environments: readonly string[],
  beforeMs: number,
): OncallDeployment | null {
  if (environments.length === 0) return null;
  const placeholders = environments.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT d.id, d.provider, d.environment, d.sha, d.ref, d.started_at_ms, d.finished_at_ms,
              d.conclusion, d.workflow_url, d.ci_run_external_id,
              i.title AS title, i.url AS url
         FROM deployment_items d
         LEFT JOIN item i ON i.id = d.id
        WHERE d.nimbus_service_id = ?
          AND d.environment IN (${placeholders})
          AND d.started_at_ms < ?
        ORDER BY d.started_at_ms DESC, d.id ASC
        LIMIT 1`,
    )
    .get(nimbusServiceId, ...environments, beforeMs) as {
    id: string;
    provider: string;
    environment: string;
    sha: string;
    ref: string;
    started_at_ms: number;
    finished_at_ms: number | null;
    conclusion: string;
    workflow_url: string | null;
    ci_run_external_id: string | null;
    title: string | null;
    url: string | null;
  } | null;

  if (row === null) return null;
  return {
    id: row.id,
    // `deployment_items` has a FK to `item`, but the join is LEFT and this falls back: an
    // annotated deploy posted to `POST /v1/deployments` whose item row was later pruned would
    // otherwise render a blank heading rather than the deploy it still has every other field for.
    title: row.title ?? row.id,
    url: row.url,
    provider: row.provider,
    environment: row.environment,
    sha: row.sha,
    ref: row.ref,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    conclusion: row.conclusion,
    workflowUrl: row.workflow_url,
    ciRunExternalId: row.ci_run_external_id,
  };
}

/**
 * The pull request merged into a deployed SHA.
 *
 * The join is `pr.metadata.merge_commit_sha = <deployed sha>` — the one `metrics/dora.ts`'s
 * `prLeadTime` already ships, reused rather than re-derived so the two cannot disagree about
 * which change a deploy carried.
 *
 * `merge_commit_sha` is written by `github-sync.ts` ALONE, so this is structurally empty on
 * GitLab and Bitbucket and its emptiness says nothing about whether a change shipped. The caller
 * discloses that under the existing `github_only_merge_data` gap name rather than inventing one.
 */
export function selectChangeForDeployment(
  db: Database,
  sha: string,
  prServices: readonly string[],
): OncallChange | null {
  if (sha === "" || prServices.length === 0) return null;
  const placeholders = prServices.map(() => "?").join(",");
  const raw = db
    .query(
      `SELECT ${INCIDENT_COLUMNS}
         FROM item i
        WHERE i.type = 'pr'
          AND i.service IN (${placeholders})
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '$.merge_commit_sha') = ?
        ORDER BY i.id ASC
        LIMIT 1`,
    )
    .get(...prServices, sha) as RawItemRow | null;

  if (raw === null) return null;
  const meta = metadataRecord(raw.metadata);
  if (meta === null) return null;
  return {
    id: raw.id,
    title: raw.title,
    url: raw.url,
    service: raw.service,
    mergedAtMs: finiteNumberField(meta, "merged_at"),
    additions: finiteNumberField(meta, "additions"),
    deletions: finiteNumberField(meta, "deletions"),
    changedFiles: finiteNumberField(meta, "changed_files"),
  };
}

/**
 * The CI run behind a deployment, by the external id `deployment_items` recorded for it.
 *
 * A `null` external id returns `null` rather than running an unscoped query — the column is
 * nullable and a deploy annotated through `POST /v1/deployments` legitimately has none.
 */
export function selectCiRunForDeployment(
  db: Database,
  ciRunExternalId: string | null,
): OncallCiRun | null {
  if (ciRunExternalId === null || ciRunExternalId === "") return null;
  const raw = db
    .query(
      `SELECT ${INCIDENT_COLUMNS}
         FROM item i
        WHERE i.type = 'ci_run' AND (i.external_id = ? OR i.id = ?)
        ORDER BY i.modified_at DESC, i.id ASC
        LIMIT 1`,
    )
    .get(ciRunExternalId, ciRunExternalId) as RawItemRow | null;

  if (raw === null) return null;
  const meta = metadataRecord(raw.metadata);
  return {
    id: raw.id,
    title: raw.title,
    url: raw.url,
    service: raw.service,
    conclusion: meta === null ? null : nonEmptyStringField(meta, "conclusion"),
    atMs: raw.modified_at,
  };
}

/**
 * Escape a term for an FTS5 `MATCH`.
 *
 * FTS5's query language treats bare input as SYNTAX — `OR`, `NOT`, `*`, `:` and an unbalanced
 * `"` are all operators or errors, so a service id containing any of them would either change
 * the query's meaning or raise, and this term is not a constant: it comes from `[metrics.dora.*]`
 * config. Wrapping in double quotes makes it a PHRASE, and doubling any internal quote is how
 * FTS5 escapes one inside a phrase.
 *
 * A bound parameter is not sufficient on its own here. Binding protects the SQL layer; the FTS5
 * expression parser runs on the bound VALUE afterwards and re-interprets it, which is why the
 * quoting has to be part of the string rather than left to the driver.
 */
function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Chat messages naming the service inside the window, newest first.
 *
 * Matches through `item_fts` over the live `item` table — `(title, body)` since V48. Note this is
 * NOT the legacy `items_fts`, which is built over the LEGACY `items` table on a `name` column;
 * a query written against that one returns nothing here forever, which is the same class of
 * mistake the `index health` roadmap row records for `raw_meta`.
 *
 * **A literal name match, never a semantic one.** A message discussing the outage without naming
 * the service is absent, and one mentioning the service for an unrelated reason is present. The
 * brief discloses that rather than presenting this lane as "the conversation about this
 * incident".
 *
 * The empty term returns nothing rather than matching everything — an unbound service name means
 * there is nothing to search FOR, and `MATCH '""'` is an FTS5 syntax error in any case.
 */
export function selectServiceMessages(
  db: Database,
  w: Window,
  serviceTerm: string,
): OncallMessage[] {
  if (serviceTerm.trim() === "") return [];
  const raw = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, i.modified_at, i.metadata
         FROM item_fts
         JOIN item i ON i.rowid = item_fts.rowid
        WHERE item_fts MATCH ?
          AND i.type = 'message'
          AND i.modified_at >= ?
          AND i.modified_at < ?
        ORDER BY i.modified_at DESC, i.id ASC`,
    )
    .all(ftsPhrase(serviceTerm.trim()), w.fromMs, w.toMs) as RawItemRow[];

  return raw.map((r) => ({
    id: r.id,
    service: r.service,
    title: r.title,
    url: r.url,
    atMs: r.modified_at,
  }));
}

/**
 * Earlier incidents on the SAME PagerDuty service, newest first, excluding the current one.
 *
 * **Same SERVICE, not "similar".** The roadmap row said "the last time a similar alert fired",
 * and similarity over incident titles is a judgement this lane deliberately does not make: the
 * index holds no alert-rule id, no fingerprint and no dedup key, so any similarity here would be
 * string overlap dressed up as a causal claim. Same-service recurrence is a fact, and it is the
 * signal an on-call engineer can act on — four of these in a month means something whatever the
 * titles say.
 *
 * **And never HOW any of them was resolved.** An incident's indexed body is `bodyPreview: status`
 * — the status string — so no narrative, postmortem link or remediation note exists to return.
 * `resolvedByEmail` and `resolvedAtMs` answer who and when; the caller discloses the rest.
 */
export function selectPriorIncidents(
  db: Database,
  pagerdutyServiceId: string,
  beforeMs: number,
  excludeItemId: string,
  limit: number,
): OncallPriorIncident[] {
  if (pagerdutyServiceId === "" || limit <= 0) return [];
  const raw = db
    .query(
      `SELECT ${INCIDENT_COLUMNS}
         FROM item i
        WHERE i.service = '${PAGERDUTY_SERVICE}'
          AND i.type = 'incident'
          AND i.id <> ?
          AND json_valid(i.metadata)
          AND json_extract(i.metadata, '$.pagerduty_service_id') = ?`,
    )
    .all(excludeItemId, pagerdutyServiceId) as RawItemRow[];

  const out: OncallPriorIncident[] = [];
  for (const r of raw) {
    const meta = metadataRecord(r.metadata);
    if (meta === null) continue;
    const openedAtMs = finiteNumberField(meta, "opened_at_ms");
    // Windowed in TypeScript rather than SQL for the reason `finiteNumberField` exists: SQLite
    // would compare a STRING `opened_at_ms` by type ordering and admit it for any bound. An
    // incident with NO open time is excluded rather than admitted — it cannot be placed before
    // the current one, and "prior" is the entire claim this lane makes.
    if (openedAtMs === null || openedAtMs >= beforeMs) continue;
    const status = nonEmptyStringField(meta, "status");
    out.push({
      id: r.id,
      title: r.title,
      url: r.url,
      openedAtMs,
      // `modified_at` ONLY for a row that reads resolved, and it is not a resolution time — see
      // `OncallPriorIncident.resolvedAtMs`. `metrics/dora.ts`'s MTTR bounds on the same column
      // for the same absence of a better field.
      resolvedAtMs: isActiveStatus(status) ? null : r.modified_at,
      resolvedByEmail: nonEmptyStringField(meta, "resolved_by_email"),
    });
  }
  return out
    .sort((a, b) => (b.openedAtMs ?? 0) - (a.openedAtMs ?? 0) || codeUnitCompare(a.id, b.id))
    .slice(0, limit);
}
