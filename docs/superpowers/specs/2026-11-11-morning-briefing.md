# Phase 10 — Morning briefing, deadline tracking and on-call awareness

Status: DRAFT for Antigravity review. Owner rulings below are binding; do not reopen them.
Date: 2026-11-11. Slot: S4. Roadmap: `docs/roadmap.md` § Phase 10 → *Core — Standing Approvals &
Scheduling* (rows **Morning briefing**, **Deadline tracking**) and *Core — Incident Correlation Engine*
(row **On-call schedule awareness**). Phase 10 standing approvals (SA0–SA5) shipped first; this project
builds on the SA4 cron parser and none of the standing-rule machinery.

## 1. Goal

Each working morning, at a time the owner configures, Nimbus puts ONE local summary in front of the owner
of what needs them today, built only from the local index with no model: their calendar, whether they
are on call, active incidents, pull requests waiting on them, their tickets that are overdue or due
today, and unread mail and chat threads. Separately, it warns once, 24 hours before a deadline, about an
open item assigned to the owner that has seen no recent activity. And `nimbus ask "who's on call for
payment-service right now?"` is answered from the index.

Roadmap acceptance (Phase 10 core) this project must meet: *the morning briefing is delivered at the
configured time and lists open PRs, active incidents, overdue tickets and unread threads* and *a deadline
24 h away with no recent activity fires exactly one notification*. The on-call row has no criterion of its
own; we add one: *`nimbus oncall now --service payment-service` and `nimbus ask` both name the on-call
person from the index with no live API call at question time*.

## 2. Owner rulings (2026-11-11)

- **OR-10-8 (carried).** No model step in anything that runs unattended. The briefing and the deadline
  notices are deterministic renders (`synthesize()` with no runner, I31 reserved sections intact).
- **OR-10-11 Delivery is local only.** An OS notification (headline only), a gateway event for the
  desktop, and `nimbus briefing` for the full text. No ChatOps, no mail, no DM, no egress of any kind.
- **OR-10-12 Calendars.** Build Google Calendar and Outlook calendar sync as part of this project (only
  iCloud events are indexed today).
- **OR-10-13 On-call sources.** Index on-call shifts from PagerDuty AND Jira Service Management
  Operations.
- **OR-10-14 Slack unread.** Index each member channel's `last_read` marker so the briefing counts unread
  Slack threads.

Decided by me (not owner questions; recorded so review can challenge them):

- **D-MB-1 "Mine" is a server-side snapshot, not identity matching.** No Jira/Linear assignee is indexed
  today, and Jira hides e-mail addresses by default, so matching an assignee to `resolveSelfPerson` would
  be unreliable. Instead each ticket/forge sync also runs a small, bounded "my open work" query AS the
  authenticated user (Jira `assignee = currentUser()`, Linear `viewer.assignedIssues`, GitHub search
  `assignee:@me` / `review-requested:@me` / `author:@me`) and replaces a per-(service, relation) snapshot.
  The provider decides who "me" is.
- **D-MB-2 Not a workflow.** The roadmap calls the briefing a "built-in scheduled workflow". SA2 workflow
  steps (`query`, `write`) select ids for writes and render nothing; adding a render/notify step kind would
  widen the I55 surface for no gain. The briefing is a built-in scheduled brief with its own config and
  scheduler, reusing `automation/cron.ts`. A stated deviation from the row's wording.
- **D-MB-3 One normalized event contract.** Google, Outlook and iCloud events share metadata
  `start_ms`, `end_ms`, `all_day`, `status`, `self_response`, `organizer_email`, `attendee_count`; iCloud
  rows gain the epoch keys through a mapper version bump (the raw iCal `start`/`end` stay).
- **D-MB-4 Headline privacy.** The OS notification may show on a lock screen, so it carries COUNTS only
  ("3 meetings · 2 reviews waiting · 1 incident · on call until 18:00"), never a title, sender or channel
  name. The full brief is shown only by the CLI and the desktop.

## 3. Non-goals

- No ChatOps/mail delivery (OR-10-11); no model synthesis (OR-10-8); no Opsgenie (Atlassian is folding it
  into JSM Operations).
- No write of any kind: marking mail read, acknowledging an incident or snoozing a deadline from the
  briefing is out of scope.
- No new calendar WRITE rows (Outlook/iCloud event create already exist; Google Calendar gets reads only).
- No desktop screen in this project: the desktop gets IPC methods and the event; a page is later (as SA3–5).

## 4. Slices (one PR each, in order)

| Slice | Repo | Content |
| --- | --- | --- |
| MB1 | Nimbus | "My open work" snapshots (Jira, Linear, GitHub), due dates (Jira/Linear existing `due_at_ms`, GitHub milestone `due_on`), Outlook `isRead`, the normalized event keys on iCloud, schema V91 `work_snapshot` |
| MB2a | nimbus-mcp-servers | `google-calendar` connector, READ tools only (`gcal_calendar_list`, `gcal_event_list`, `gcal_event_get`); minor release |
| MB2b | Nimbus | Pin MB2a; `google_calendar` service (own OAuth consent, `calendar.readonly`); Google Calendar sync; Outlook calendar delta inside the `outlook` syncable |
| MB3 | Nimbus | On-call shifts: PagerDuty `/oncalls`, JSM Operations schedules → `oncall_shift` items; `nimbus oncall now`; the read-only agent tool `oncall_now` |
| MB4 | Nimbus | Slack `last_read` markers (V92 `chat_read_marker`) and unread-thread counting |
| MB5 | Nimbus | The briefing (`[briefing]` config, scheduler, brief, V93 `briefing_run`, IPC, CLI, event, OS headline) and deadline notices (`[briefing.deadlines]`, V93 `deadline_notice`); static D45 |

**Release gate:** MB2a merges and its connectors release publishes to npm before MB2b bumps the pin
(`audit:connector-version-skew` fails a pin to an unpublished version). MB1, MB3, MB4 and MB5 need no
connectors release. MB5 needs MB1 and MB3 merged (snapshots, shifts); its calendar, mail and chat
sections render a `## Gaps` line for any source not yet shipped, so MB5 does not wait for MB2b or MB4.

Each slice updates the five core docs (CLAUDE.md + GEMINI.md, roadmap, architecture, docs/README,
cli-reference) and CHANGELOG, and is independently useful (MB1–MB4 improve `nimbus ask` before MB5 lands).
Migration numbers are assigned in merge order; if a slice is reordered, numbers follow merge order.

## 5. Design

### 5.0 New sync capabilities (D24)

Syncables never see a `Database` handle (D24, `sync/sync-capabilities.ts`); every write goes through a
`SyncCapabilities` member. Rows are upserted with the existing `ctx.upsertItem(row)` (which runs
`upsertIndexedItemForSync`), deletions with `ctx.deleteItem`. Three members are added, each SCOPED to the
calling syncable's own service id the way `getSecret` is (a syncable cannot name another service; the
gateway fills the service from the context), each one transaction, each bound-parameter SQL (I9/I14):

- `replaceWorkSnapshot(relation, externalIds)` (MB1): resolves each external id to the item id of this
  service's indexed row (ids with no row are dropped and counted in the return value), then deletes and
  reinserts that (service, relation) set.
- `replaceItemSet(type, keepExternalIds, opts?: { endBeforeMs?: number })` (MB2b, MB3): deletes this
  service's rows of `type` whose external id is not in the keep set (for `event` after a FULL window
  fetch only, or rows whose `end_ms` is before `opts.endBeforeMs`), through the same delete path as
  `deleteItem`, so embeddings, FTS and graph edges go too. Returns the deleted count.
- `setChatReadMarkers(markers)` (MB4): upserts `chat_read_marker` rows for this service.

A static extension of D24 pins that only `sync/sync-capabilities.ts` writes `work_snapshot` and
`chat_read_marker`; a unit test pins that a capability built for service A cannot touch service B's rows.

### 5.1 MB1 — my open work, due dates, read state

**Schema V91** `work_snapshot`:

```sql
CREATE TABLE work_snapshot (
  service      TEXT NOT NULL,          -- 'jira' | 'linear' | 'github'
  relation     TEXT NOT NULL CHECK (relation IN ('assigned','review_requested','authored_open')),
  item_id      TEXT NOT NULL,          -- item.id of the indexed row
  captured_at  INTEGER NOT NULL,
  PRIMARY KEY (service, relation, item_id)
);
CREATE INDEX work_snapshot_item ON work_snapshot(item_id);
```

A snapshot for (service, relation) is REPLACED through `ctx.replaceWorkSnapshot` (§ 5.0) only after the
whole query succeeded; a failed or truncated fetch leaves the previous snapshot and records
`snapshot_partial` in the sync's own log line (the briefing shows the snapshot's `captured_at`, § 5.5).
Every snapshot member is first upserted as an ordinary item through `ctx.upsertItem`, so the item row
exists and carries current metadata. Leaving a snapshot (reassigned, closed) removes only the snapshot row:
the item stays indexed, as any closed ticket does today; an upstream deletion is handled by each sync's
existing deletion path, unchanged. Item deletion cascades are by trigger
(`AFTER DELETE ON item` deletes `work_snapshot` rows), since `item` deletes go through the existing paths.

Per service, run after the existing incremental sync, at most once per `snapshot_interval_minutes`
(default 15, 5–240) so a 60 s sync cadence does not multiply calls:

- **Jira:** `search` with JQL `assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC`,
  `maxResults` 100, at most 3 pages (300). Fields as the existing sync requests, so the row mapping is the
  existing `jira-sync.ts` mapper (it already writes `due_at_ms`, `status_category`).
- **Linear:** `viewer { assignedIssues(first: 100, filter: { state: { type: { nin: ["completed","canceled"] } } }) }`
  with the existing issue field set, at most 3 pages.
- **GitHub:** three searches, each `per_page=100`, one page: `is:open is:issue assignee:@me`,
  `is:open is:pr review-requested:@me`, `is:open is:pr author:@me` (GitHub search returns at most 1000;
  one page is the stated cap, 100 per relation). Each hit is upserted with the existing issue/PR mapper
  extended by `due_at_ms` from `milestone.due_on` (issues; `null` when no milestone or no due date) and
  `milestone` title. PR rows keep `PR_META_VERSION` semantics; issue metadata gains `meta_v` (new
  `GITHUB_ISSUE_META_VERSION = 1`) and is registered in `REBODY_META_TARGETS`.

**Outlook mail:** add `isRead` to the `$select` and the metadata (`is_read: boolean`). Existing rows lack
it: the briefing counts only rows that HAVE the key and says so (`n of m Outlook messages predate read
tracking`) until a resync; `REBODY_META_TARGETS` gains `outlook`/`email` at a new
`OUTLOOK_MAIL_META_VERSION = 1`. The delta link is reset once by changing `CURSOR_PREFIX` from
`nimbus-outl2:` to `nimbus-outl3:` (`outlook-sync.ts:16-25` records the same move from `outl1`: a stored
delta link keeps the projection that minted it, and `decodeMicrosoftGraphDeltaCursor` returns `undefined`
on a prefix mismatch, so the sync falls through to the initial URL that carries the new `$select`). That
one fresh delta re-lists the mailbox and backfills `is_read` for every message the delta returns.

**Gmail:** nothing to add (`metadata.labelIds` contains `UNREAD`, kept current by history label events).

**iCloud events:** `apple-event-mapping.ts` adds `start_ms`/`end_ms` (UTC epoch; a floating time is
resolved in the event's TZID when present, else the gateway's zone, and `all_day` dates are midnight in
that zone) plus `self_response` (the attendee entry whose address matches the account, else `null`) and
`attendee_count`; `meta_v` = `EVENT_META_VERSION = 1`, registered for rebody.

### 5.2 MB2 — Google Calendar and Outlook calendar sync

**MB2a (nimbus-mcp-servers).** New connector `google-calendar`, read-only, the template of `google-meet`:
`gcal_calendar_list`, `gcal_event_list` (calendarId, timeMin, timeMax, max 250, single events expanded),
`gcal_event_get`. No write tools. Hosts: `www.googleapis.com` only. Released as a minor; the gateway pins it
in MB2b (mind `audit:connector-version-skew`).

**MB2b (gateway).**

- New service `google_calendar` registered at every site `google_meet` touches (catalog + OAuth profile
  `https://www.googleapis.com/auth/calendar.readonly`, catalog meta, secrets manifest `[]`, connector vault,
  access-token registry, connector-configured, google-access-token, lazy-mesh spawns + first-party
  manifest, sync registration, CLI `connector auth google_calendar` + env help). Its own consent: a user
  who connected Gmail is NOT silently given calendar access; `nimbus connector auth google_calendar` asks.
- **Sync:** for each calendar in `calendarList` with `selected !== false` (cap 20), `events.list` with
  `singleEvents=true`, `timeMin = now − 1 d`, `timeMax = now + 30 d`, then incremental `syncToken` per
  calendar (cursor `{v:1, calendars: {[id]: {syncToken, windowStart}}}`). A 410 (token expired) restarts
  that calendar. The window is re-anchored (a fresh full list) once `windowStart` is more than 7 days old,
  deleting rows whose `end_ms` fell out of the window. `status: cancelled` → `ctx.deleteItem`.
- **Outlook calendar:** inside the existing `outlook` syncable (one service, one cursor): MB2b moves the
  prefix to `nimbus-outl4:` with the same base64-JSON encoding, payload
  `{v:2, mail:{nextUrl}, calendar:{nextUrl, windowStart}}`. The decoder accepts `nimbus-outl4:` and also
  `nimbus-outl3:` (MB1's mail-only cursor), which it reads as `{mail: <that cursor>, calendar: undefined}`,
  so MB2b does NOT reset mail a second time; any older prefix falls through to the initial URLs as today. `GET /me/calendarView/delta?startDateTime&endDateTime`
  with the same window, `Prefer: odata.maxpagesize=50` (`fetchMicrosoftGraphJson` gains an optional
  headers argument), `@removed` → delete, re-anchored like Google. Uses the existing `Calendars.Read`
  grant; no re-auth.
- Rows: `type: "event"`, services `google_calendar` / `outlook`, the D-MB-3 keys, `externalId` = provider
  event id (instance id for a recurrence). Not in `PROSE_HEAVY_TYPES` (like `apple:event`).

### 5.3 MB3 — on-call shifts

Item type `oncall_shift`, snapshot semantics (each refresh replaces that source's set; rows not returned
are deleted). Metadata: `source` (`pagerduty`|`jsm`), `user_name`, `user_email` (nullable),
`escalation_policy_id`, `escalation_policy_name`, `escalation_level` (PagerDuty; `null` for JSM),
`schedule_id`, `schedule_name`, `start_ms`, `end_ms` (`null` = open-ended), `service_ids` (PagerDuty
service ids whose escalation policy this is), `is_me` (boolean, § below). Title:
`On call: <user> — <schedule or policy> (level N) until <time>` so FTS/semantic search finds it.

- **PagerDuty** (inside the `pagerduty` syncable, at most every 15 min): `GET /oncalls?since=now&until=now+7d`
  `&include[]=users&include[]=escalation_policies&include[]=schedules`, offset paging as the incident sync,
  cap 10 pages. Service mapping: `GET /services?include[]=escalation_policies` (cap 5 pages) builds
  `service_ids`. `is_me`: the token's user, `GET /users/me` (works for a user token; for an account-level
  token it 400s and `is_me` is `false` everywhere, a stated bound; the `pagerduty.from_email` Vault value,
  when set, is used as the fallback identity by e-mail match).
- **JSM Operations** (inside the `jira` syncable's `run`, at most every 15 min, only when a cloud id
  resolves: the Vault `jira.cloud_id` through `ctx.getSecret("cloud_id")`, else one `GET
  {site}/_edge/tenant_info` made by the same syncable with the same credential and fetch path as its other
  requests, so it is a sync-class request covered by that run's I29 row; the result is cached in the
  syncable's cursor, never written to the Vault): `GET {OPS}/{cloudId}/v1/schedules` (cap 50 schedules) then per schedule
  `GET .../schedules/{id}/on-calls?flat=true` and `.../next-on-calls` for the next shift; Basic auth as the
  existing alert tools. `is_me` by the `/myself` accountId, which the Jira snapshot (MB1) already reads.
  JSM shifts have no PagerDuty service mapping; the schedule name is the join key users type.
- **`nimbus oncall now [--service <id|name>] [--json]`**: the CLI calls a new IPC method `oncall.now
  {service?}` (read-only, local index; added to `FORBIDDEN_OVER_LAN`; added to Tauri `ALLOWED_METHODS`,
  126 → 127). It reads `oncall_shift` rows whose window covers now. `--service` matches a `[ci.service.<id>]` binding's PagerDuty service id against
  `service_ids`, else a case-insensitive schedule/policy name match. Prints the data's age.
- **Agent tool `oncall_now`** (read-only, local index; registered with the existing read-only index tools,
  so it is logged to `tool_call_log` like them; its output goes through `wrapToolOutput`, which already
  escapes a `</tool_output>` closer inside provider-supplied names, I11): same query,
  so `nimbus ask "who's on call for payment-service right now?"` answers from the index. Registered with
  the other read-only index tools; no HITL type, no egress.
- The `nimbus oncall` incident brief gains an "On call now" line for the incident's service (reuses the
  same reader).

### 5.4 MB4 — Slack unread

Schema V92 `chat_read_marker(service, channel_id, channel_kind, last_read_ts, captured_at,
PRIMARY KEY(service, channel_id))`. During the Slack sync, for member channels only, call
`conversations.info` (user token, existing `*:read` scopes; no re-auth) and store `last_read`. Rate:
Slack tier 3; at most 100 channels per sync pass, round-robin by oldest `captured_at`, so a large
workspace converges over several passes (stated bound: a marker can be up to N passes old; the briefing
shows the oldest marker's age). Unread threads for a channel = distinct `coalesce(thread_ts, ts)` among
indexed `slack:message` rows in that channel with `ts > last_read_ts` and `user` ≠ the token's own user
id (from `auth.test`, cached). DMs and mpims are listed first. Only channels the sync indexes count; a
channel outside the 14-day history depth shows at most what is indexed (stated bound).

### 5.5 MB5 — the briefing and deadline notices

**Config** (`config/briefing-toml.ts`, the `[oncall.push]` template; layered reader; errors fall back to
the last valid / defaults through `sectionFallbackSink`; never clamps):

```toml
[briefing]
enabled = false                 # off by default
schedule = "30 8 * * 1-5"       # automation/cron.ts grammar; at least 1 h apart
tz = "Europe/London"            # IANA; default: the OS zone
sections = ["calendar","oncall","incidents","reviews","tickets","mail","chat"]  # order = render order
retention_days = 30             # 1..365

[briefing.deadlines]
enabled = false
lead_hours = 24                 # 1..168
quiet_hours = 24                # "no recent activity" = modified_at older than this; 1..336
```

**Scheduler** (`briefing/briefing-scheduler.ts`): a 60 s unref'd tick (same shape as SA4's
`WorkflowScheduler`, not shared: it fires no workflow). Fires when `nextFire(schedule, tz, lastFire)` ≤
now; one catch-up if the gateway was off and starts within 3 h of a missed fire, else the fire is skipped
and recorded `skipped`. DST follows `automation/cron.ts` (`nextFire` works on the zone's wall clock; a
wall minute in a spring-forward gap is skipped, so a briefing scheduled inside the gap does not fire that
day, a stated bound; a fall-back repeated minute fires once). "Today" in `tz` is the half-open instant
range from the earliest instant whose wall clock reads local `00:00` to the same for the next local date
(the `cron.ts` wall-to-instant helper, never `+ 86 400 000`), so a 23 h or 25 h day is one day; provider
windows are sent as UTC instants. The same tick runs the deadline scan every 15 min. Not started in demo
(I41).

**The brief** (`agents/briefing.ts` + `agents/_lib/briefing-queries.ts`; a typed `MorningBriefing`, rendered by
`synthesize(brief)` with no runner). Sections (each omitted from config is not built; each built section
with no source configured renders a `## Gaps` line, never silence):

- **Calendar:** today's events (local day in `tz`) from all three services, sorted by `start_ms`, declined
  ones dropped, overlaps flagged.
- **On call:** shifts with `is_me` overlapping today; plus "on call now" for each `[ci.service]` binding.
- **Incidents:** PagerDuty `incident` rows not resolved (existing "active" rule), the ones assigned to me
  (existing `assigned` graph edges) first; cap 10 + "and N more".
- **Reviews / PRs:** `work_snapshot` GitHub `review_requested`, then `authored_open` (with CI state when a
  `ci_run` row links it).
- **Tickets:** `assigned` snapshots (Jira, Linear, GitHub issues) whose `due_at_ms` is before the end of
  today (overdue first, then due today), then the count of other assigned open items.
- **Mail:** unread threads: Gmail `labelIds` contains `UNREAD`, Outlook `is_read = false`, grouped by
  thread, last 7 days; top 10 by recency + count.
- **Chat:** Slack unread threads per § 5.4, DMs first; top 10 + count.
- **Data freshness** (reserved, I31): each section's source and the age of its newest sync/snapshot.

**Persistence** V93 `briefing_run(id, fired_at, trigger CHECK IN ('schedule','manual'), status CHECK IN
('ok','skipped','failed'), headline, markdown, counts_json, toast_outcome)`, pruned past `retention_days`;
`deadline_notice(item_id TEXT PRIMARY KEY, due_at_ms INTEGER NOT NULL, notified_at INTEGER NOT NULL)`,
with an `AFTER DELETE ON item` trigger deleting its row and the scheduler pruning rows whose `due_at_ms` is
more than 30 days past.

**Section caps** (deterministic; each capped section ends with "and N more"): calendar 20 events, on call
10 shifts, incidents 10, reviews 15 + authored 10, tickets 25 (overdue first, then due today, then the
count of other open assigned items), mail 10 threads, chat 10 threads. There is no model and no token
budget (OR-10-8); the caps bound the render and the desktop payload.

**Delivery** (OR-10-11): the `briefing.ready` gateway event (id + headline + counts), then the OS toast
through `showIgnoringFailure`; each outcome recorded in `toast_outcome`.

**Toast text** (D-MB-4) is built by ONE function per kind whose input type holds numbers only
(`briefingToastText(counts: BriefingCounts)`, `deadlineToastText(n: number)`), so no indexed string can
reach it by construction: title `Nimbus briefing` / `Nimbus deadlines`; body like `3 meetings · 2 reviews
waiting · 1 active incident · on call today` / `2 open items due within 24 h with no recent activity`.
No title, sender, repository, channel, schedule name or time is ever in a toast. The gateway event carries
the same counts plus the run id; the full text is fetched over IPC by the CLI or the desktop.

**Deadline notices:** every 15 min, items in an `assigned` snapshot, open (Jira/Linear `status_category`
not `done`/`canceled`; GitHub `state = open`), with `now < due_at_ms ≤ now + lead_hours` and `modified_at <
now − quiet_hours`, and not yet noticed → ONE counts-only toast per scan (`deadlineToastText`); each
`deadline_notice` row is written first (a write that fails sends nothing for that item). An item already
noticed is noticed again only when its `due_at_ms` moved by at least 1 hour (the row is then updated), so
a re-sync or a time-zone re-rendering of the same date never repeats the notice.

**IPC** (`briefing.*`; added to `FORBIDDEN_OVER_LAN`; not federated): `briefing.latest`, `briefing.list
{limit}`, `briefing.get {id}`, `briefing.runNow` (manual trigger; returns the run), `briefing.status`
(config, next fire, last outcome). Tauri `ALLOWED_METHODS` gains `briefing.latest`, `briefing.list`,
`briefing.get`, `briefing.status` (127 → 131, after MB3's `oncall.now`); `runNow` is CLI-only.

**Demo (I41).** The scheduler and the deadline scan are not started in a demo gateway. The read methods
and `oncall.now` serve the demo root's own synthetic index (they read nothing else, so nothing real can
appear); `briefing.runNow` works in demo and emits the gateway event but never an OS toast. `demo-gate.ts`
needs no entry (it refuses methods that bring real credentials or data in; these do neither); a test pins
the demo behaviour. Notification `briefing.ready`
classified for rebroadcast.

**CLI:** `nimbus briefing` (= latest; `--json`), `nimbus briefing now` (run and print), `nimbus briefing
list`, `nimbus briefing status`; `nimbus doctor` warns when `[briefing] enabled` but no source for an
enabled section is connected, and when the last fire failed.

**Static D45 (no invariant).** Files under `briefing/` and `agents/briefing*.ts` import nothing from
`chatops/`, `egress/`, `connectors/` (except type-only), `federation/`, `share/`, and call no `fetch`;
the only delivery sinks are the gateway event emitter and the notifications runtime. Rationale: OR-10-11
must stay true structurally, not by convention. A runtime test pins that `briefing.*` is in
`FORBIDDEN_OVER_LAN` and that a briefing run appends zero `egress_ledger` rows.

## 6. Security analysis

- **New outbound requests** (MB1–MB4) are all sync-class fetches through each syncable's existing
  `SyncContext` credential (D24) and are covered by the existing I29 `sync` ledger rows per run; no new
  egress class. New hosts: `www.googleapis.com` (calendar) only; PagerDuty, Graph, Slack, GitHub,
  Atlassian hosts are already allowlisted.
- **New OAuth scope:** `calendar.readonly` on a NEW service, by explicit owner consent; Gmail's grant is
  untouched (per-service mirror tokens).
- **No new write, HITL type or model surface** except the read-only `oncall_now` agent tool (I11 wrapped,
  local index only, no egress).
- **Prompt injection:** event titles, ticket titles and Slack text reach the model only via the existing
  I11 envelope when the owner asks; the briefing itself never reaches a model (OR-10-8).
- **Privacy:** the toast carries counts only (D-MB-4); `briefing.*` is LAN-forbidden; the desktop gets reads
  only.
- **Invariants:** none added or retired. I7 count changes (126 → 127 at MB3, → 131 at MB5), I29 text gains the new sync fetches
  under its existing `sync` class, D45 is a new static rule tied to no invariant.

## 7. Testing and acceptance

- Unit: each mapper (fixtures built FROM the writer, per memory), snapshot replace/partial-failure,
  cursor v1→v2 migration for Outlook, Google 410 restart, window re-anchoring, JSM/PD paging caps, Slack
  round-robin, unread counting, cron/tz firing incl. DST, catch-up window, deadline exactly-once and due
  change, headline contains no title (property test over random titles).
- Integration (real SQLite, fake HTTP per provider): `test/integration/briefing/briefing.acceptance.test.ts`
  — a configured 08:30 fire produces one `briefing_run` with all seven sections from seeded syncs; a
  deadline 23 h out with stale `modified_at` fires exactly one toast across 10 scans; `oncall now
  --service` names the PD on-call user from the index with the HTTP fake disabled.
- Static: D45 fixtures (each forbidden import refused; a type-only import allowed); the D24 extension
  (a write to `work_snapshot` / `chat_read_marker` outside `sync-capabilities.ts` refused).
- Capability scoping: a capability built for one service cannot replace or delete another service's rows.
- Time: DST spring-forward and fall-back days for the scheduler and the "today" window (23 h and 25 h
  days); an event spanning midnight and a multi-day all-day event appear on each day they cover.
- Toast: a property test seeding random titles/names into the index asserts no toast and no
  `briefing.ready` payload contains any of them.
- Demo: a demo gateway starts no scheduler; `runNow` emits the event and no toast.
- Migrations V91–V93: a runner test per version (`runner-vNN.test.ts`), as for every migration.
- Security-invariants: ALLOWED_METHODS pins 126 → 127 (MB3) → 131 (MB5); LAN denylist pin; zero egress rows per run.

## 8. Stated bounds

- GitHub "my work" is capped at 100 per relation; Jira/Linear at 300 assigned open items.
- PagerDuty `is_me` needs a user-level token or a matching `pagerduty.from_email`.
- JSM shifts carry no service mapping; schedules capped at 50.
- Calendars: the window is −1 d … +30 d; at most 20 Google calendars; recurring events are expanded
  instances.
- Slack markers converge over passes in large workspaces; unread counts only indexed messages
  (14-day depth).
- Outlook rows indexed before MB1 carry no read flag until resynced (disclosed in the section).
- Live reply shapes for Google Calendar, Graph calendar delta, PD /oncalls and JSM schedules are verified
  against documented shapes only, not live accounts.
