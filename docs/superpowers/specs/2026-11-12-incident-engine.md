# Phase 10 + Phase 17 — The incident engine and the on-call copilot

Status: DRAFT for Antigravity review (round 2; round 1 changes listed in § 9). Owner rulings below are binding; do not reopen them.
Date: 2026-11-12. Slot: S4. Roadmap: `docs/roadmap.md` § Phase 10 → *Core — Incident Correlation
Engine* (rows **Automatic incident assembly**, **Incident timeline**, **Proactive technical debt
detection**, **Suggested remediation**, **Post-mortem generation**; **On-call schedule awareness**
shipped in MB3/MB5) and the Phase 10 acceptance criterion on `--at`; and § Phase 17 — *The On-Call
Copilot*, all four waves. Phase 17's own row *Pushed incident brief* shipped 2026-10-04 (V64,
`oncall-push/`); this project generalises it rather than replacing it.

## 1. Goal

When an alert fires, Nimbus assembles what the index knows about it, with no query and no model:
the deploy before it, the change and commit behind that deploy, the CI run, the chat threads that
mention the service, earlier incidents of the same service, and what changed state and when. The
on-call engineer gets that record pushed, can read it as a timeline, sees which of several firing
alerts is the root, gets remediation proposals with their evidence, a blast-radius preview and an
honest reversibility label, approves any of them through the normal HITL gate, can undo what is
undoable, drives the team's runbook step by step, drafts stakeholder updates and the post-mortem,
and hands the shift over with a brief. Before an alert, Nimbus warns about the silence of expected
events, sub-threshold drift and a risky deploy. Every step is reconstructable with
`nimbus audit replay <incident-id>`.

Roadmap acceptance this project must meet:

- (P10) *When a PagerDuty P1 fires, the incident summary (deploy, PR, commit, CI result, Slack
  thread) is assembled and available via `nimbus incident show` within 30 seconds of the alert
  being indexed — no user query required.*
- (P10) *A post-mortem draft for a resolved incident is generated from the incident record and
  surfaced for review; the HITL-gated push to Notion succeeds only after the user explicitly
  approves.*
- (P10) *`nimbus ask "what PRs were open for payment-service at 09:00 yesterday?" --at
  yesterday-09:00` returns results consistent with the indexed sync history for that timestamp,
  verified by seeding the index with timestamped items and confirming the filter excludes items
  modified after the requested time.*
- (P17) *On a seeded multi-alert cascade, the pushed brief names the single root and marks the rest
  downstream in <15 s, delivered without a query.*
- (P17) *For a seeded bad-deploy incident, the copilot proposes a rollback with confidence + cited
  evidence + dry-run blast radius + reversibility label; approving executes through the HITL gate
  (action + preview in the audit chain); `nimbus audit replay <id>` reconstructs the steps
  deterministically.*
- (P17) *A mitigation that makes things worse can be undone in one keystroke (where reversible);
  irreversible actions are flagged before approval.* (Stated deviation, § 5.5: "one keystroke" is one
  command, `nimbus incident undo`, followed by the gate's own approval; HITL is structural and is
  never skipped for an undo.)
- (P17) *`nimbus oncall handoff` returns a shift brief in <15 s, zero HITL.*

## 2. Owner rulings

- **OR-10-8 (carried).** No model step in anything that runs unattended. Assembly, the cascade
  ranking, the radar, the anomaly baseline, the deploy-risk score, remediation proposals and the
  handoff brief are deterministic. A model may appear only in a command the owner runs and only
  through `synthesize()` with I31 reserved sections intact (the post-mortem draft, the
  investigation summary, the stakeholder-update draft), and each has a deterministic render that
  is complete without it.
- **OR-10-16 (2026-11-12) Local substitutes for Phase 11/16 dependencies.** Phase 17 rows that name
  unbuilt phases are built on what exists, and the Phase 11/16 upgrade is recorded as later work:
  approve-from-push uses the typed confirmation of the desktop, the CLI or ChatOps (D0c) instead of
  Phase 11's biometric signing; *Live runbook driving* drives OWNER-AUTHORED runbook files, HITL per
  step, instead of Phase 16 team skill packs; team incident command uses the existing ownership and
  on-call data instead of Phase 16's bus-factor radar.
- **OR-10-17 (2026-11-12) Alert sources.** Assembly triggers on PagerDuty incidents, Jira Service
  Management Operations alerts (newly indexed here), Sentry issues, and Monte Carlo and Bigeye
  incidents (the roadmap's *Data Incident Brief*).
- **OR-10-18 (2026-11-12) Command name.** `nimbus incident show|list|timeline|remediate|undo|runbook|
  postmortem|investigate|update|debt|advisory`. The roadmap's Phase 8 security agent is renamed to
  `nimbus security incident` (next to the existing `nimbus security scan`); this project edits that
  roadmap text and builds nothing for Phase 8.
- **OR-10-19 (2026-11-12) Point-in-time history.** This project builds `item_history`, a sync-time
  record of state changes, and uses it for the timeline, the post-mortem, the handoff and `--at`.

Decided by me (not owner questions; recorded so review can challenge them):

- **D-IC-1 One record per trigger item.** An *incident record* is assembled per trigger item (a PD
  incident, a JSM alert, a Sentry issue, a Monte Carlo or Bigeye incident). Several alerts about one
  outage are NOT merged into one record; the cascade ranking (§ 5.4) groups records into a view.
  Merging would need a judgment about identity that the index cannot prove.
- **D-IC-2 Evidence, not conclusions.** Every lane of a record cites the indexed items it came from
  and the rule that linked them (same service binding, inside the window, a graph edge). The engine
  never says "root cause"; it says "candidate" and shows the evidence. A post-mortem's root-cause
  section starts as the candidate list for the owner to edit.
- **D-IC-3 Owner actions, never model actions.** A remediation, a runbook action step, a comms send
  and a post-mortem push are LOCAL OWNER actions through the executor (`execute()`, the consent gate,
  the audit chain, the egress ledger). The engine only PROPOSES them. The model door (I53) is not
  widened: the model is not offered a remediation tool by this project. No standing rule (I55) can
  match an engine-proposed action, so nothing here auto-remediates (the P17 guardrail).
- **D-IC-4 Reversibility is a declared row property, proven by a test.** A connector write row may
  declare `reversibility: { class: "reversible", inverse, fromBefore }`, `"irreversible"` or (the
  default) `"unknown"`. `reversible` is accepted only when the row has a `before` reader whose reply
  supplies every field the inverse needs, and a per-row test builds the inverse from a recorded
  before-state. The label shown is the declared class; nothing is inferred.
- **D-IC-5 Detection never acts.** The radar, the anomaly baseline and the deploy-risk advisor write
  only their own findings and raise local notifications (counts only on the OS toast, as D-MB-4).

## 3. Non-goals

- No auto-remediation and no standing rule over engine proposals (D-IC-3).
- No new connector write rows. Remediation uses rows that exist and are offerable today; rows still
  waiting on D3 (the Kubernetes and GKE rows) or refused by owner ruling (`azure_app_service_restart`,
  `azure_aks_node_pool_scale`, `gcp_cloud_run_deploy`) appear in proposals as *not available here*,
  with the reason.
- No status-page connector (none exists): status-page updates are drafts only.
- No dashboard snapshots in the investigation (the roadmap names them; no connector renders one).
- No DAG-run logs, dbt test results or warehouse schema deltas: the index holds Airflow DAGs, Dagster
  and dbt jobs and Prefect deployments as inventory only. The Data Incident Brief renders those lanes
  as `## Gaps` and is recorded as later work (§ 8).
- No Phase 8 security work beyond the rename (OR-10-18), no mobile app (OR-10-16), no team skill
  packs (OR-10-16).
- No LLM in any unattended path (OR-10-8).

## 4. Slices (one PR each, in order)

| Slice | Content |
| --- | --- |
| IC1 | `item_history` (V94): sync-time state-change rows for allowlisted keys of incident, alert, error-issue, data-quality, PR and ticket items, written in the `upsertIndexedItemForSync` chokepoint; `--at <time>` on `nimbus ask` and `nimbus search` |
| IC2 | Alert sources and bindings: JSM Operations alert sync (`jira` service, type `alert`); PD `resolved_at_ms`; service bindings for JSM, Sentry, Monte Carlo and Bigeye; `[ci.service.X] depends_on`; the `correlates_with` populator anchored on the open time; deployment → commit and deployment → CI-run graph edges |
| IC3 | Assembly: V95 `incident_record` (+ versions), the generalised trigger (every OR-10-17 source), the lanes, `nimbus incident list|show`, `incident.*` IPC, the `incident.assembled` event, the pushed brief re-based on records; static D46 and invariant I56 (a) |
| IC4 | Timeline, cascade ranking, the incident id on audit rows, `nimbus incident timeline`, `nimbus audit replay <incident-id>` |
| IC5 | Remediation: the `reversibility` row field, proposals with confidence, evidence, blast radius and dry-run, `nimbus incident remediate|undo|advisory`, approve-from-push; I56 (b) |
| IC6 | Runbooks: owner-authored runbook files, `nimbus incident runbook`; I56 (c) |
| IC7 | Post-mortem draft, configurable template and HITL push; technical-debt detection (`nimbus incident debt`) |
| IC8 | Predict: the expectation radar, the persisted anomaly baseline (replacing `AnomalyDetectorStub`, V96) and its local notifications, the deploy-risk advisor in `deploy preflight` |
| IC9 | Coordinate: `nimbus incident investigate`, `nimbus incident update` (stakeholder drafts, HITL send), `nimbus oncall handoff` |
| IC10 | Desktop: a read-only Incidents page (records, timeline, cascade, proposals, findings) over five read methods; `ALLOWED_METHODS` |

No connectors release is needed: `jira_ops_alert_list` and `jira_ops_alert_get` ship in
`@nimbus-dev/connectors` 0.13.0 (the pin), and the investigation reads use existing list/search tools.
Each slice updates the five core docs and CHANGELOG. Migration numbers follow merge order. IC3 needs
IC1 and IC2; IC4 needs IC3; IC5–IC7 need IC4; IC8 and IC9 need IC3; IC10 needs IC5.

## 5. Design

### 5.1 IC1 — item history and `--at`

**Table (V94).** `item_history(id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, service TEXT NOT NULL,
type TEXT NOT NULL, key TEXT NOT NULL, old_value TEXT, new_value TEXT, observed_at_ms INTEGER NOT NULL,
source_at_ms INTEGER)`, indexes on `(item_id, observed_at_ms)` and `(service, type, observed_at_ms)`.
A row means: at a sync that observed it at `observed_at_ms`, key `key` of the item went from
`old_value` to `new_value`; `source_at_ms` is the provider's own change time when the provider gives
one (PD `last_status_change_at`, a PR's `merged_at`), else null. Two pseudo-keys record existence:
`__created` (first indexed) and `__deleted` (removed through `deleteItem`).

**Writer.** Only `index/item-history.ts` writes the table, called from `upsertIndexedItem` in
`index/item-store.ts` (the real SQL chokepoint for every item write: `upsertIndexedItemForSync`,
clips, saved briefs, glossary projection and Nimbus items all reach it) and from the item delete path,
inside the same statement sequence (static D46(b) pins that no other file writes `item_history`).
Deployments live in `deployment_items`, not `item`; they need no history (their rows are immutable
events with their own timestamps). It
compares the stored metadata with the new metadata for an allowlist per `(service, type)`
(`ITEM_HISTORY_KEYS`): status, state, severity, priority, urgency, assignee keys, merged, draft,
resolution and due date. Bodies, titles and free text are never recorded. Values are capped at 256
characters. The table has NO foreign key to `item` (a delete must not erase the history that says
the item existed). Retention: `[index] history_retention_days` (default 180), pruned at boot and by a
daily maintenance tick in batches of 5,000 rows, never inside a sync pass.

**Honesty.** History starts at V94; nothing earlier is recovered. Every reader that reconstructs a
past state says when its earliest history row is later than the time asked for ("history starts
2026-11-14 08:00; state before then is the first observed state").

**`--at <time>`** on `nimbus ask` and `nimbus search` (absolute ISO, or `yesterday-09:00`,
`today-HH:MM`, `-2h` in the gateway's zone). Retrieval keeps an item only if it existed at T (its
`__created` row, or its provider creation time, is at or before T, and no `__deleted` row precedes T)
and shows each tracked key's value as reconstructed at T. An item whose tracked state at T cannot be
reconstructed (it changed after T and the change predates history) is excluded and counted in the
answer's `## Gaps`. The filter runs in SQL before ranking, so a later item can never outrank an
earlier one. The answer states that bodies and titles are as of now.

### 5.2 IC2 — alert sources and bindings

- **JSM Operations alerts.** The `jira` syncable gains an alert pass (only when a cloud id is stored,
  as MB3's shift pass): `jira_ops_alert_list` for open alerts plus those closed in the last 7 days,
  then items `jira:alert` with `status`, `priority` (P1–P5), `opened_at_ms`, `closed_at_ms`, `tags`,
  `entity`, `source`, `owner_team`, `acknowledged`. External id is the alert id. Refreshed at most
  every 5 minutes (alerts move faster than shifts).
- **PagerDuty resolution time.** The PD incident mapper records `resolved_at_ms` from
  `last_status_change_at` when the status is `resolved` (meta version bump, so the next sync
  re-writes the rows); MTTR and prior-incident code stop using `modified_at` for it.
- **Bindings.** `[ci.service.<id>]` (and `[metrics.dora.<id>]`) gain `jsm_alert_tags` (an alert
  binds when any tag matches), `sentry_projects` (project slugs), `data_models` (globs over
  `normalizeDataModelKey` keys, binding Monte Carlo and Bigeye incidents through their monitored
  models) and `depends_on` (other service ids, for the cascade). Unknown keys stay an error.
  `buildServiceIdentityResolver` (`platform/assemble.ts`) and its graph use gain the matching rules for
  `jira:alert`, `sentry:error_issue`, `montecarlo`/`bigeye` `data_quality_test`, so a bound alert of
  any OR-10-17 source resolves to its Nimbus service and gets `correlates_with` edges; an unbound one
  still correlates with nothing (and its record says so).
- **Correlation anchor fix.** The incident timestamp the populator passes to `syncTimelineEventGraph`
  comes from `occurredAtForItem` in `graph/graph-populator.ts`, which reads `item.modified_at` (PD's
  `updated_at`). For incident, alert, error-issue and data-quality items it will read
  `metadata.opened_at_ms` (via `json_extract`, guarded against malformed JSON) and fall back to
  `modified_at` only when that is absent; a one-shot re-graph of incidents runs once after the
  migration.
- **Deploy edges.** The populator adds `deployment --deployed--> git_commit` (deployed sha) and
  `deployment --built_by--> ci_run` (`ci_run_external_id`) so the graph reaches commit and CI. The
  existing hand-seeded `incident-correlation-indexed.e2e.test.ts` is replaced by one driven by the
  real populators.

### 5.3 IC3 — assembly

**Trigger.** The sync scheduler's `onConnectorSyncSuccess` hook (where `oncallPush.trigger` runs today)
calls `incidentEngine.trigger(serviceId)` for `pagerduty`, `jira`, `sentry`, `montecarlo` and
`bigeye`. The engine selects trigger items that are new or changed since the last pass, and assembles
or re-assembles their records. A source's severity filter decides what triggers
(`[incident] severities`, default: PD `p1` plus `[pagerduty] severity_p1_aliases`; JSM `P1`; Sentry
level `fatal`; Monte Carlo and Bigeye severity `high`/`sev1`, exact values verified in the plan).
Others are assembled on demand by `nimbus incident show <id>`. Single-flight per service; a pass is
capped at 20 records, and the rest wait for the next pass.

**Lanes** (each a function in `incident/lanes/`, each SQL over the index, each returning items with
the rule that matched):

1. Service binding (from § 5.2 bindings; unbound renders a Gap and lanes 2–5 are skipped).
2. Last deployment before the open time within `incident_window_minutes`, then its commit and CI run
   through the IC2 edges, then the PR (`merged_as`). GitLab and Bitbucket PR matches follow the same
   edges where their populators write them (verified per forge in the plan).
3. Chat: messages mentioning the service name or any bound alias, in the 24 h before open (the
   existing `selectServiceMessages` rule).
4. Prior incidents of the service with their resolution time (IC2) and any Nimbus action recorded
   against them (IC4 links).
5. Concurrent records of other services (for the cascade).
6. Data lanes (Monte Carlo and Bigeye triggers): the monitored data models, lineage up one hop
   (`derived_from`), dbt and orchestration inventory touching them, PRs merged in the 24 h before whose
   title or branch names a model; the absent run-level lanes are listed in `## Gaps` (§ 3).
7. On call: who is on call for the service now (MB3 `oncall_shift`) and who is assigned.

**Record (V95).** `incident_record(id TEXT PRIMARY KEY, trigger_item_id TEXT UNIQUE NOT NULL, service
TEXT, opened_at_ms INTEGER, status TEXT, version INTEGER NOT NULL, assembled_at_ms INTEGER NOT NULL,
record_json TEXT NOT NULL, markdown TEXT NOT NULL)` plus `incident_record_version(record_id, version,
assembled_at_ms, record_sha256, record_json)` so replay can show what was known when. Retention
`[incident] retention_days` (default 365). Written only by `incident/incident-store.ts`.

**Render.** A deterministic brief through `synthesize()` with no runner (I31): Summary, Service,
Change, CI, Chat, Prior incidents, On call, Concurrent, and the reserved `## Gaps` and
`## Data freshness`. New brief kinds join `SynthInput["kind"]` and `RESERVED_HEADINGS_BY_KIND`
(`agents/_lib/reserved-sections.ts`): `incident` (IC3), `incident_postmortem` (IC7; Timeline and
Decision log reserved), `incident_investigation` and `incident_update` (IC9; the per-backend tables
reserved) and `oncall_handoff` (IC9). Each reserved heading's deterministic block comes from
`reservedBlocksFor()`, and the plan records whether `chatops/brief-truncate.ts` must classify any of
them in `SYNTHESIS_RESERVED_HEADINGS`.

**Delivery.** The `incident.assembled` event (`{recordId, version, status}`, no title). The existing
`[oncall.push]` pipeline is re-based on records: a record that meets the push filter is pushed
through the same V64 store, ChatOps headline and toast caps; `pushed_brief` keeps its key. The push
remains default off and PagerDuty-assigned by default; `[oncall.push] sources` widens it to the
other OR-10-17 sources.

**Surfaces.** IPC `incident.list`, `incident.get`, `incident.assemble` (on demand, owner kinds only);
LAN-refused namespace (root `"incident"`); CLI `nimbus incident list [--open] [--service]`, `nimbus incident show <id>
[--json]` (id = record id, trigger item id or provider id).

**Confinement (static D46(a), invariant I56(a)).** `incident/**` assembly, cascade, radar, baseline
and handoff code import nothing from egress, chatops posting, connectors (type-only allowed),
federation or share and call no `fetch` (the D45 shape). A runtime pin: a full pass appends zero
egress rows.

### 5.4 IC4 — timeline, cascade, replay

**Timeline.** `nimbus incident timeline <id> [--json]`: one ordered list of the trigger's state changes
(`item_history`), the deploy, the commit, the PR merge, the CI run, the first and last chat mention,
other records opening, and every Nimbus action linked to the incident (proposed, approved, denied,
executed, undone), each with its time, source and the item it came from. The `source_at_ms` is used
when present, else the observed time, and the line says which.

**Cascade.** For open records in a 30-minute window, rank: (1) a record whose service is upstream (by
`depends_on`) of other open records' services is a root candidate; (2) among candidates, the earliest
open time; (3) a shared deployment in the window raises it. Output: one root, the rest marked
downstream, each with the reason. With no `depends_on` declared, the ranking falls back to time and
says so. The pushed brief carries the ranking for its group. The < 15 s criterion is measured from the
last trigger item being indexed to the event.

**Incident link on actions.** Any action the engine proposes carries `incidentId` in its audit
payload (`context.incident_id`), and the executor records it in the audit row and the egress row.
This is the join replay uses; it is never used for authorisation.

**Replay.** `nimbus audit replay <incident-id> [--json]` reconstructs, deterministically from stored
rows only: each record version (what was known when), each proposal and its evidence, each approval
prompt (the preview text stored in the audit chain), each decision and result, each undo. It verifies
the audit chain over the rows it reads and says so. Two runs on the same database produce identical
output (pinned by a test).

### 5.5 IC5 — remediation

**Reversibility (D-IC-4).** A row field in `connectors/connector-writes/`. Initial classification
(each verified against the connector in the plan, each with its test):

- reversible: `launchdarkly_flag_toggle` (inverse: toggle to the before-state value),
  `flagsmith_feature_state_set` (before-state), `aws_ec2_instance_stop` / `aws_ec2_instance_start`
  (each other), `aws_ecs_service_update` (the before-state task definition and desired count),
  `argocd_app_rollback` (rollback to the before-state revision id).
- irreversible: `pd_incident_resolve`, `jira_ops_alert_close`, `argocd_app_sync`, the merges, the
  deletes, `aws_lambda_invoke`, the pipeline triggers.
- unknown: every other row (the default).

A static check refuses a `reversible` declaration whose inverse row does not exist or whose
`fromBefore` names a field the row's before reader does not return.

**Proposals.** For a record, the engine lists remediation kinds that the evidence supports:

- Roll back the correlated deploy: Argo CD rollback to the previous synced revision of the bound
  application, or ECS service update to the previous task definition, when the record's deploy lane
  found the deploy and the service is bound to that application or service
  (`[ci.service.X] argocd_apps`, `ecs_services`, new binding keys).
- Revert a flag changed in the window (LaunchDarkly, Flagsmith) when a flag change of a bound
  project is indexed in the window (the plan verifies what flag history the index holds; if none, the
  kind is listed as unavailable).
- What was done last time: a write executed against a prior incident of the same service (IC4
  link), offered again with the current target.
- Acknowledge or close the alert (PD, JSM).

Each proposal shows: the action and target, **confidence** (a deterministic score from fixed weights:
deploy inside the window, deploy to the bound environment, same-service prior success, recency; the
weights and the arithmetic are printed), the **evidence** (item ids and rules), the **blast radius**
(the row's before-state of the target, the bound services that depend on it through `depends_on`, the
environment), a **dry run** line: none of the rows in the initial catalogue has a connector dry run today
(`argocd_get` takes only the application name and neither Argo CD write exposes a dry-run flag), so
every proposal at IC5 says *no dry run available; the preview shows the target's current state*, and
a row gains a dry run only when its connector does; and the
**reversibility** label in the first line. An irreversible proposal says so before anything else.
Proposals not available here (a D3 row, an owner-refused row) are listed with their reason.

**Proposal lifecycle.** Proposals are stored in V95 `incident_proposal(id, record_id, record_version,
kind, tool_id, input_json, evidence_json, confidence, reversibility, status, created_at_ms,
expires_at_ms, action_id)`, written only by `incident/remediation.ts`. Status moves `proposed` to
`executing` to `executed`, `failed` or `denied`, or from `proposed` to `expired` (TTL 2 h) or
`superseded` (a new record version re-derived a different proposal set). Every transition is one
`UPDATE ... WHERE id = ? AND status = ?`; a second concurrent `remediate` of the same proposal finds
zero rows changed and is refused with `ERR_PROPOSAL_BUSY`.

**Execution.** `nimbus incident remediate <id> [--pick N]` asks the gateway's `incident.remediate`
(CLI and ChatOps only, § 6), which claims the proposal (`proposed` to `executing`), builds the action
from the proposal AS STORED (never from caller fields other than the pick) and runs `execute()` as a
local owner action with the incident link. The row's before-state reader runs inside that same
execution, immediately before the prompt (as it does for every write with a reader), so the preview
shows the target as it is now. The consent
prompt is the row's normal typed preview plus two lines: `Proposed by: the incident engine` and the
reversibility label. A Wave 4 row still needs its typed confirm text (the CLI and ChatOps collect it, D0a/D0c). Before
claiming, the proposal is re-derived from the current record; if it differs, or the record has a newer
version whose proposals no longer include it, it is refused with `ERR_PROPOSAL_STALE` and marked
`superseded`.

**Undo.** `nimbus incident undo <action-id>` builds the declared inverse of an executed reversible
action from the before-state recorded with it and runs it through `execute()` the same way. Unknown or
irreversible actions are refused with their label. This is the "one keystroke" (§ 1).

**Advisory mode.** `nimbus incident advisory on|off|status` (stored in V95 `incident_engine_state`).
While on, `incident.remediate`, `incident.undo` and runbook action steps are refused before any
prompt; proposals are still shown.

**Approve-from-push (OR-10-16).** A pushed record carries its top proposal's id. Two doors can act
on it: `nimbus oncall pushed <id> --remediate` and the ChatOps headline's Remediate action (the
resource owner only; D0c's typed-confirm modal for Wave 4 rows, the existing approve flow
otherwise). Both call the same proposal path; the push never approves anything by itself. The
desktop shows the proposal and the exact CLI command, and does not start it (§ 6, Renderer).

**Invariant I56 (b).** An engine-proposed action reaches dispatch only through `execute()` as a local
owner action: never delegated (I20 falls back to the local owner), never satisfied by a standing rule
(I55), never offered to the model (I53 unchanged), refused in advisory mode, and its prompt names the
proposer and the reversibility label. Wiring: `incident/remediation.ts`; static D46(c) pins that only
it builds remediation actions.

### 5.6 IC6 — runbooks

Runbook files live only in `<configDir>/runbooks/*.toml` (owner-authored; never fetched, never from
an extension or a pack). A runbook declares `match` (services, trigger sources, an optional title
regex) and ordered steps: `check` (text the owner marks done), `read` (a read tool id with parameters,
gated and ledgered as reads are), `action` (a write tool id with parameters). Parameters may
interpolate only TYPED record fields: the service id, bound application or service names from config,
provider ids, the deploy's sha and the open time. Free text from a provider (titles, descriptions,
tags, chat) can never be interpolated, so an alert cannot write a parameter (I56 (c)). A runbook cannot
set any approval behaviour; each action step is an `execute()` call exactly as § 5.5 (advisory mode,
typed confirm, proposer line `Proposed by: runbook <name>, step N`).

`nimbus incident runbook <id> [--runbook <name>] [--step N] [--done N]` shows the matched runbook with
each step's state (stored per record in V95 `incident_runbook_step`), runs one step, or marks a check
done. Loading refuses an unknown tool id, a write id that is not a connector write row, a parameter
that does not validate against the row's schema, and any interpolation of an untyped field.

### 5.7 IC7 — post-mortem and technical debt

**Post-mortem.** `nimbus incident postmortem <id> [--out <file>] [--template <file>] [--synthesize]`
for a record whose trigger is resolved or closed (from history). Default template sections: Summary,
Impact window (open → resolved from history), Timeline (IC4), Candidate causes (the change lane,
labelled candidate), Contributing factors (cascade and concurrent records, then placeholders), What
we did (every linked action and its outcome), Action items (undone runbook checks, open proposals,
then placeholders), Decision log (the linked audit rows: prompt, decision, result). A `--template`
file is Markdown with `{{section}}` placeholders from a fixed list; unknown placeholders are refused.
`--synthesize` (attended; needs a model) rewrites prose sections through `synthesize()`; Timeline and
Decision log are reserved and re-attached verbatim (I31). The draft is written to `--out` (default
`<dataDir>/postmortems/<record-id>.md`) for the owner to edit.

Push: `nimbus incident postmortem <id> --push notion --parent <page-id>` or `--push confluence
--space <key> [--parent <id>]` reads the (edited) file and runs the existing `notion_page_create` or
`confluence_page_create` row through `execute()` as a local owner action with the incident link:
the normal typed preview, the tribal-KB refusals and the remote-content refusals (B3r) all apply. A
denial writes nothing. The push is never automatic.

**Technical debt.** `nimbus incident debt [--since 90d] [--untouched 180d]` (read-only, deterministic)
lists code symbols (graph `symbol` entities with file paths) that are referenced by incident evidence
(files changed by PRs in incident change lanes; Sentry culprits and frames if the index holds them,
verified in the plan) at least twice in the window AND whose file has not been changed in the local
repository for the untouched period (git log over `[[filesystem.roots]]` repos). Output: symbol, file,
incident count, last touch, the incidents. Symbols in repos that are not local are listed as a Gap.

### 5.8 IC8 — predict

**Expectation radar.** `[[incident.expect]]` entries in `nimbus.toml` (OR-10-16 replaces
`nimbus.team.toml` declarations): `service`, `kind` (`deploy`, `ci_success`, `sync`, `item`),
`max_gap` (duration), and for `item` a `service`/`type` pair. Every 15 minutes the radar finds each
expectation whose last matching event is older than `max_gap` and records a finding (V96
`incident_finding`), raising one counts-only toast per scan and the `incident.finding` event; a
finding clears when the event recurs.

**Anomaly baseline.** `AnomalyDetectorStub` is replaced by a persisted per-series baseline (V96
`anomaly_baseline`: rolling mean and variance over 14 days of hourly buckets) for: per-service
counts of new error issues, new alerts and failed CI runs (from the index), and the two sync
telemetry series the stub watches today. A bucket at or above `[incident] anomaly_z` (default 3) with
at least 7 days of baseline becomes a finding and a heads-up toast to the owner when the owner is on
call for that service (MB3), else a finding only. This also delivers the carried-in *Anomaly user
notifications* row (sync telemetry anomalies become findings and local notifications).

**Deploy-risk advisor.** `deploy preflight` (and `POST /v1/preflight/deploy`) gains a `risk` block:
open records on the service or its `depends_on`, PRs merged since the last deploy (change velocity),
whether anyone is on call for the service now, and time-of-week against `[incident] quiet_windows`
(default Friday 15:00 to Monday 09:00 and 18:00 to 08:00, gateway zone). A score from fixed weights
and every factor with its value. Advisory only; it never blocks the deploy.

### 5.9 IC9 — coordinate

**Investigation.** `nimbus incident investigate <id>` (attended, owner kinds only) runs a fixed fan-out
of read tools for the bound backends, each through the executor as a read (audited, I29-ledgered),
each scoped by the backend's own filter to the service and the window, each capped (100 rows): Sentry
issues for the bound projects, Datadog incidents and monitors, Grafana alerts, New Relic violations,
CloudWatch log search for bound log groups. The tools that exist today are listed in § 4; a backend
with no filtering tool is a Gap. Results are shown per backend with counts; `--synthesize` summarises
them through `synthesize()` (I31; the per-backend tables are reserved).

**Stakeholder updates.** `nimbus incident update <id> [--audience stakeholders|engineers] [--out
<file>] [--send slack:<channel>|teams:<team>/<channel>]` drafts an update from the record and timeline
(deterministic; `--synthesize` optional). `--send` runs the existing Slack or Teams post row through
`execute()` as a local owner action (all B1 refusals apply: a ChatOps channel, a broadcast mention).
`[incident.scribe] enabled` drafts an update whenever a record gains a new version and queues it
(`incident.updateDrafted` event, counts-only toast); it never posts by itself. Status pages: draft
only (§ 3).

**Handoff.** `nimbus oncall handoff [--since <time>] [--json]` (zero HITL, deterministic): the owner's
shift window from `oncall_shift` (or `--since`), records opened, resolved or still open in it (from
history), smouldering records (open longer than 4 h, or re-triggered), radar and anomaly findings,
pending proposals and runbook steps, and who is on call next. Under 15 s on the acceptance fixture.

### 5.10 IC10 — desktop

An Incidents page, read-only: the record list, a record's brief, timeline and cascade, its proposals
(each with its evidence, labels and the exact `nimbus incident remediate` command to copy), the
advisory state and findings. `ALLOWED_METHODS` gains the five reads only (`incident.list`,
`incident.get`, `incident.timeline`, `incident.proposals`, `incident.findings`). Starting a
remediation, an undo, a runbook step or changing advisory mode is never renderer-callable (§ 6): the
renderer can answer consent prompts, so letting it start an action would let a compromised renderer
both start and approve one.

## 6. Security analysis

- **Unattended paths are inert.** Assembly, cascade, radar, baseline and handoff read the index and
  write only their own tables; D46(a) forbids network, egress, posting, connectors and federation
  imports there, and a runtime pin counts zero egress rows (I56 (a)).
- **No new way to act.** Every action this project can cause is an existing connector write row,
  dispatched by `execute()` as a local owner action behind the consent gate (I2), never delegated
  (I20), never by a standing rule (I55), never by the model (I53 unchanged), with the typed confirm
  where Wave 4 requires it (D41). Advisory mode removes even that (I56 (b)).
- **Attacker-influenced text.** Alert titles, chat messages and Sentry text are provider content.
  They are shown, escaped, in briefs; they never choose a proposal's target (targets come from
  config bindings and typed ids), never interpolate a runbook parameter (I56 (c)), and are wrapped
  with `wrapToolOutput` when a synthesis step sees them (I11).
- **Toasts carry counts only** (as MB5): no title, service or channel name reaches a lock screen.
- **History stores state, not content.** `item_history` records allowlisted state keys only, capped.
- **Replay integrity.** Replay reads the audit chain and verifies it; it cannot be fed rows from
  outside the database.
- **LAN.** The exact namespace root `"incident"` is added to `FORBIDDEN_OVER_LAN` in
  `ipc/lan-rpc.ts` (the check compares the part before the first dot; the LAN check is a denylist),
  and `audit.replay` is covered by the existing `audit` root (verified in the plan).
- **Renderer.** The desktop renderer can already answer consent prompts (`consent.respond` is in
  `ALLOWED_METHODS`), so it must not also be able to START an engine action: `incident.remediate`,
  `incident.undo`, `incident.runbookStep` and `incident.advisorySet` are never renderer-callable (I7).

## 7. Testing and acceptance

Each acceptance criterion in § 1 is an e2e or integration test over real SQLite, driven by the real
populators and syncables with fake MCP replies (no hand-seeded edges): the 30 s assembly from a PD P1
sync; the `--at` filter over seeded timestamped history; the cascade root in < 15 s; the bad-deploy
rollback proposal, its approval through the gate and `audit replay` determinism (two runs, identical
bytes); the undo of a reversible action and the refusal of an irreversible one; the post-mortem push
denied (nothing written) and approved (one page create dispatched); the handoff in < 15 s. Plus:
per-row reversibility tests (inverse built from a recorded before-state); the runbook loader's
refusals (untyped interpolation, unknown tool, schema mismatch); advisory mode refusing before any
prompt; D46 fixtures; I56 rows in `security-invariants.test.ts`; LAN refusal.

## 8. Stated bounds

- History starts at V94; earlier states are not reconstructed, and readers say so.
- Records are per trigger item (D-IC-1); the same outage paged in PD and JSM is two records grouped
  by the cascade view, not one.
- Cascade quality depends on declared `depends_on`; without it, the ranking is by time and says so.
- Confidence is a fixed-weight score over indexed evidence, not a probability.
- Data Incident Brief: DAG-run logs, dbt test results and warehouse schema deltas are not indexed;
  those lanes are Gaps until a later project indexes runs (recorded in the roadmap).
- Datadog monitors carry no state in the index; the investigation reads them live (attended only).
- Status pages are drafts only; dashboards are not snapshotted.
- Phase 11 biometric approve-from-push and Phase 16 team skill-pack runbooks and bus-factor radar
  are recorded as upgrades to the OR-10-16 substitutes.
- Live reply shapes for JSM alerts and the investigation backends are verified against documented
  shapes only.

## 9. Review log

Round 1 (Antigravity, 2026-11-12), applied: the renderer never starts an engine action, since it can
answer consent prompts (remediate, undo, runbook step and advisory set are CLI and ChatOps only; the
desktop page is read-only); the LAN refusal names the exact root `"incident"`; `item_history` is
written in `upsertIndexedItem`, the real chokepoint, with no foreign key and batched daily pruning;
no initial row has a dry run, and proposals say so; the populator's `occurredAtForItem` is where the
open-time anchor changes; the service resolver gains the new bindings; proposals have a stored
lifecycle with atomic transitions, a TTL and supersession; the new brief kinds and their reserved
headings are named. Not applied, with reasons: migration numbers (the draft already used V94 to V96);
an IPC client cannot collect typed text (the CLI and desktop already do, D0a, and remediate is
CLI/ChatOps-only anyway); the quoted "identified as the root cause in the timeline" sentence is not in
the spec, whose targets already come only from bindings and typed ids (§ 6).
