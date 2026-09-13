import type { GapNote } from "@nimbus-dev/sdk";

/**
 * The incident this brief is about, as the index holds it.
 *
 * Every field is nullable except `id`/`title`, and that is not defensive typing: `pagerduty-sync.ts`
 * writes `status`, `severity`, `urgency`, `opened_at_ms` and `pagerduty_service_id` CONDITIONALLY
 * — only `assignee_emails`, `resolved_by_email`, `unattributed_actors`, `incidentId` and `meta_v`
 * are unconditional. A row indexed by an older connector version, or one whose PagerDuty payload
 * carried no priority, genuinely has no severity, and a renderer that printed `undefined` or
 * silently omitted the line would be making a claim the index cannot support.
 */
export type OncallIncident = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  /**
   * `triggered` / `acknowledged` / `resolved` as PagerDuty last reported it TO THE INDEX.
   *
   * Read `OncallSyncFreshness` before trusting it. This value is only as current as the last
   * PagerDuty sync, and `metrics/dora.ts` already records the consequence in its own comment: "a
   * resolved incident whose row has not been re-synced still reads `triggered` here". For DORA
   * that made a metric move with sync lag; here it decides WHICH INCIDENT the brief is about, so
   * the same staleness can put an on-call engineer in front of an incident that closed an hour
   * ago. The selection cannot be made correct locally — only disclosed.
   */
  readonly status: string | null;
  /** PagerDuty's priority NAME (`P1`, `SEV2`, …), absent when the incident carried no priority. */
  readonly severity: string | null;
  readonly urgency: string | null;
  /** `metadata.opened_at_ms`, a real event field. `null` when `created_at` did not parse. */
  readonly openedAtMs: number | null;
  readonly pagerdutyServiceId: string | null;
  readonly assigneeEmails: readonly string[];
};

/**
 * An active incident this brief did NOT choose, named so the choice is visible.
 *
 * Carried on the brief rather than mentioned only in prose because the whole point is that the
 * reader can act on it: each entry is what `--incident <id>` takes. Deliberately minimal — a
 * reader scanning for "is the one I care about in this list" needs the title and the id, and
 * repeating severity and status for every runner-up turns a one-line orientation into a second
 * incident table competing with the real one.
 */
export type OncallOtherIncident = {
  readonly id: string;
  readonly title: string;
  readonly openedAtMs: number | null;
};

/**
 * How stale the PagerDuty index is, which qualifies the SELECTION itself and not merely a count.
 *
 * On the brief because {@link OncallIncident.status} cannot be trusted without it. `lastSyncMs`
 * is `sync_state.last_sync_at` for `connector_id = 'pagerduty'`; `null` distinguishes two cases
 * the reader must not confuse and `db/index-health.ts` already separates for the same reason —
 * see {@link OncallSyncFreshness.reason}.
 */
export type OncallSyncFreshness = {
  readonly lastSyncMs: number | null;
  /** `now - lastSyncMs`, or `null` when there is no sync time to subtract. */
  readonly ageMs: number | null;
  /**
   * Why `lastSyncMs` is absent, `null` when it is present.
   *
   * `no_sync_record` means no `sync_state` row exists for PagerDuty at all — the connector has
   * never been scheduled. `never_synced` means a row exists with a NULL `last_sync_at` — it is
   * configured and scheduled but has not completed a run. The distinction is actionable in
   * opposite directions (configure the connector vs. wait for or force a sync), which is why
   * `db/index-health.ts` carries the same two names rather than one "unknown".
   */
  readonly reason: "no_sync_record" | "never_synced" | null;
};

/**
 * The deployment that most recently STARTED before the incident opened, on the incident's service.
 *
 * **Temporal correlation, never causation.** Nothing in the index links a deployment to an
 * incident; this is "the last deploy before the alert", which is a useful place to look and not
 * an answer. The brief's preamble says so, and the section heading is worded to match — the
 * roadmap row's phrasing ("the triggering PR and commit diff") claims a causal chain the
 * substrate cannot support.
 */
export type OncallDeployment = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly provider: string;
  readonly environment: string;
  readonly sha: string;
  readonly ref: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly conclusion: string;
  readonly workflowUrl: string | null;
  readonly ciRunExternalId: string | null;
};

/**
 * The pull request merged into {@link OncallDeployment}, matched on merge SHA.
 *
 * The join is `pr.metadata.merge_commit_sha = deployment_items.sha`, which is exactly the one
 * `metrics/dora.ts`'s `prLeadTime` already ships — reused rather than re-derived so `oncall` and
 * `nimbus metrics dora` cannot disagree about which change a deploy carried.
 *
 * **`merge_commit_sha` is written by `github-sync.ts` alone.** Neither `gitlab-sync.ts` nor
 * `bitbucket-sync.ts` populates it, so on those forges this lane is structurally empty and its
 * absence says nothing about whether a change shipped. That is the same substrate hole
 * `metrics/stats.ts` reports as `github_only_merge_data`, and the brief discloses it under that
 * name rather than inventing a second one.
 */
export type OncallChange = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly service: string;
  readonly mergedAtMs: number | null;
  /**
   * A DIFFSTAT, never a diff.
   *
   * The roadmap row promised a "commit diff summary". No connector indexes a patch, a file list
   * or a hunk — `github-sync.ts`'s PR metadata carries `additions`, `deletions` and
   * `changed_files` and nothing else of that kind — so three integers is the whole of what can be
   * honestly reported, and the missing diff is disclosed in `## Gaps` rather than approximated.
   */
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
};

/** The CI run behind {@link OncallDeployment}, resolved through `ci_run_external_id`. */
export type OncallCiRun = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly service: string;
  readonly conclusion: string | null;
  readonly atMs: number;
};

/** A chat message naming the affected service inside the window. */
export type OncallMessage = {
  readonly id: string;
  readonly service: string;
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
};

/**
 * An earlier incident on the SAME PagerDuty service.
 *
 * **"How it was resolved" is not here, and cannot be.** An incident's indexed body is
 * `bodyPreview: status ?? ""` — the status string — so no resolution narrative, postmortem link
 * or remediation note exists anywhere in the index. `resolved_by_email` answers WHO and
 * `openedAtMs`/`resolvedAtMs` answer WHEN; the roadmap row's "and how it was resolved" has no
 * substrate at all and is disclosed in `## Gaps` rather than being softened into a summary of
 * fields that do not say it.
 *
 * What the lane IS good for is recurrence: four of these in thirty days is a signal an on-call
 * engineer can act on without any narrative at all.
 */
export type OncallPriorIncident = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly openedAtMs: number | null;
  /**
   * `item.modified_at` for a row whose status reads `resolved`, which is the closest thing the
   * index holds to a resolution time and is NOT one.
   *
   * `metrics/dora.ts`'s `selectResolvedIncidents` bounds MTTR on the same column for the same
   * absence of a better field. It is a `last_touch` value: any re-sync that touches the row moves
   * it. `null` when the incident does not read resolved.
   */
  readonly resolvedAtMs: number | null;
  readonly resolvedByEmail: string | null;
};

/** Pre-cap totals per lane — what the window HELD, never what is listed. See `OncallBrief`. */
export type OncallCounts = {
  readonly messages: number;
  readonly priorIncidents: number;
};

/**
 * How the incident this brief covers was chosen.
 *
 * On the brief because it changes how the reader should read an unexpected incident. `explicit`
 * means they named it and there is nothing to second-guess. `auto` means Nimbus picked it from
 * the incidents assigned to the resolved owner, so a wrong pick is possible for every reason
 * `OncallIdentity` and `OncallSyncFreshness` describe.
 */
export type OncallSelection = "explicit" | "auto";

/**
 * Whether the incident's PagerDuty service maps to a configured Nimbus service.
 *
 * The deployment, change and CI lanes are ALL scoped through `ServiceConfig` — repos for the
 * change lane, `nimbus_service_id` for deploys — so with no mapping there is no scope to query
 * and those three sections are structurally empty. That is a CONFIGURATION gap rather than a
 * substrate one and has a real remediation, which is why it is carried as its own field instead
 * of letting three empty sections imply "nothing happened". `pre-mortem` ships the same
 * mapped-services-only bound.
 */
export type OncallServiceBinding = {
  readonly nimbusServiceId: string | null;
  readonly pagerdutyServiceId: string | null;
};

export type OncallBrief = {
  readonly kind: "oncall";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: {
    /** The ABSOLUTE chat-window cutoff, already converted from the caller's lookback DURATION. */
    readonly sinceMs: number;
    readonly nowMs: number;
  };
  readonly selection: OncallSelection;
  readonly incident: OncallIncident;
  readonly otherActiveIncidents: readonly OncallOtherIncident[];
  readonly syncFreshness: OncallSyncFreshness;
  readonly binding: OncallServiceBinding;
  readonly deployment: OncallDeployment | null;
  readonly change: OncallChange | null;
  readonly ciRun: OncallCiRun | null;
  readonly messages: readonly OncallMessage[];
  readonly priorIncidents: readonly OncallPriorIncident[];
  readonly counts: OncallCounts;
  /** Per-lane entries dropped by the display cap, for the truncation disclosure. */
  readonly truncatedCount: number;
};
