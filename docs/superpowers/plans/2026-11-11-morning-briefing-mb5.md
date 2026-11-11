# Plan - Morning briefing MB5: the briefing itself and deadline notices

Spec: `docs/superpowers/specs/2026-11-11-morning-briefing.md` (approved, round 2): section 2 (OR-10-8,
OR-10-11, D-MB-2, D-MB-4), section 4 (slices), section 5.5 (MB5's design), sections 6-8 (security, tests,
bounds). Roadmap rows: Phase 10 *Morning briefing* and *Deadline tracking*; MB5 CLOSES both.

MB5 is the last slice. It reads what MB1 (snapshots, due dates, Outlook `is_read`, iCloud event keys),
MB2b (Google and Outlook calendar rows) and MB3 (`oncall_shift` rows, `queryOncallNow`) wrote, and renders
and delivers it locally. It makes NO provider request, adds NO model step, NO ChatOps/mail/egress path, NO
HITL type, NO invariant. It adds schema (`briefing_run`, `deadline_notice`), the `[briefing]` config,
a scheduler, 5 `briefing.*` IPC methods (4 renderer-callable), `nimbus briefing`, a `nimbus doctor` check,
one gateway event kind, and static rule D45.

Base: current `dev/asaf/p10-mb3` (PR #1972) treated as merged: `CURRENT_SCHEMA_VERSION` = 91
(`index/local-index.ts:289`), Tauri `ALLOWED_METHODS.len()` = 127 (`gateway_bridge.rs:996`), MB1's
`config/briefing-toml.ts`, MB2b's calendar mappers, MB3's `index/oncall-now-query.ts` are all present.

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right the plan follows it. Where the code disagrees the correction below is binding for MB5.

1. **`showIgnoringFailure` cannot report an outcome (spec: "the OS toast through `showIgnoringFailure`;
   each outcome recorded in `toast_outcome`").** `platform/notifications/notifications-runtime.ts:274`
   returns `Promise<void>` and swallows every throw; `OsNotificationService.show` signals a rate-limit drop
   by REJECTING with `NotificationRateLimitedError` and an unavailable backend with
   `NotificationUnavailableError` (`os-notifications.ts:78,278`), and `delivers === false` means `show` is a
   no-op. Correction: add a sibling `showWithOutcome(service, title, body): Promise<ToastOutcome>` next to
   `showIgnoringFailure` (same file, same never-rejects contract) returning `"delivered" |
   "not_delivering" | "rate_limited" | "unavailable" | "failed"`; it checks `delivers === false` first
   (`not_delivering`, no call), then maps the three error classes. `briefing/` imports only this.
2. **`briefing.ready` is not a standalone notification method (spec: "Notification `briefing.ready`
   classified for rebroadcast").** `ipc/gateway-events.ts` states it carries exactly TWO method names
   (`gateway.event`, `connector.healthChanged`) "and that count is meant to be final": a second method name
   exists only when `gateway_bridge.rs` `classify_notification` needs to match on it, and
   `@nimbus-dev/client`'s `onNotification` is named-only. The desktop already receives every notification as
   `gateway://notification` (`gateway_bridge.rs:402`); `GLOBAL_BROADCAST_METHODS` is `#[allow(dead_code)]`
   with the single `profile.switched`. Correction: `briefing.ready` is a new `GatewayEventKind`
   (`emitGatewayEvent("briefing.ready", { runId, trigger, headline, counts })`, the shape of
   `oncall.briefPushed`); `cli/src/commands/tail.ts` gets a rendering arm (its fallback already shows an
   unknown kind, so nothing was ever dropped) and a `briefing.` category. NO Rust classify arm, NO
   `GLOBAL_BROADCAST_METHODS` change (a Rust test would pin it at 1 and was not edited).
3. **`agents/briefing.ts` cannot exist (spec file map).** Static rule D22(d)
   (`check-nimbus-invariants.ts:1437-1490`, `checkAgentEmitterImportConfinement`) treats EVERY
   `agents/<name>.ts` as a brief emitter that only `ipc/agents-rpc.ts` may import; the scheduler lives in
   `briefing/` and would import it. Memory `d22d-non-emitter-belongs-in-agents-lib`: put it in
   `agents/_lib/`, never exempt. Correction: `agents/_lib/briefing-types.ts`, `briefing-queries.ts`,
   `briefing-build.ts`, `briefing-render.ts`. D45's scope therefore widens from the spec's "`briefing/` and
   `agents/briefing*.ts`" to `briefing/**` plus `agents/_lib/briefing*.ts` (the spec's own
   `agents/_lib/briefing-queries.ts` would otherwise have been outside D45).
4. **`synthesize()` is a closed union, not a free function.** `agents/_lib/brief-kinds.ts` `SynthInput` has
   17 kinds; `deterministicRender` (`synthesize.ts:99`), `TOOL_NAME_BY_KIND` (`:159`),
   `RESERVED_HEADINGS_BY_KIND` (`reserved-sections.ts:38`, a total `Record`), `requiredPhrases`
   (`brief-contract.ts:109`, an explicit no-phrase list ending in `assertNeverBrief`) and
   `reservedBlocksFor` each need the new kind, and `security-invariants.test.ts:5263` ("the reserved
   registry is total over the brief union") scrapes `brief.kind === "..."` from `synthesize.ts`. With no
   runner `synthesize` returns `withDeterministicFooter(render(brief))` and `{attempted:false,
   reason:"disabled"}` (`synthesize.ts:334`): the right deterministic path, and its footer ("built-in briefs
   do not use an LLM") is true. Correction: an 18th kind `"briefing"` (`TOOL_NAME_BY_KIND` entry
   `agents.briefing` is never sent anywhere: no runner exists). Reserved headings are `## Gaps` and
   `## Data freshness`. `GapNote.category` is the SDK's closed union (`missing_entity_type |
   missing_relation_emit | missing_connector | missing_user_identity | empty_index`, SDK
   `brief-types.d.ts:11`, MIT repo, not changed): the briefing's gaps use only `missing_connector`,
   `missing_user_identity` and `empty_index`; "showing 10 of 23", "n Outlook messages predate read
   tracking" and staleness are INLINE section lines and the reserved freshness block, not gaps.
5. **Time helpers: spec "the cron.ts wall-to-instant helper" is private, and D45 forbids the other one.**
   `automation/cron.ts` `instantOf` is private, minute resolution, and returns `undefined` for a wall time
   in a DST gap (`:210`), so a zone whose local midnight is skipped has no day start. MB1's
   `connectors/_lib/zoned-time.ts` `wallToInstantMs` handles the gap (pre-gap offset) but lives under
   `connectors/`, which D45 forbids as a value import. Correction: `git mv` it to `util/zoned-time.ts`,
   leave a one-line `export * from "../../util/zoned-time.ts"` shim at the old path (every MB1/MB2b/MB3
   import and test keeps working), and add `wallOfInstant(ms, zone): WallTime | undefined` there (cron.ts's
   `wallOf` is private). Separately `scheduleRefusal(expr, tz)` hard-codes `MIN_INTERVAL_MINUTES` = 5
   (`cron.ts:276`) while the spec wants "at least 1 h apart": add an optional third parameter
   `minIntervalMinutes = MIN_INTERVAL_MINUTES` (message built from it; `workflow.save` unchanged).
6. **Date-only due dates are UTC midnights (spec: tickets "whose `due_at_ms` is before the end of today";
   notices "`now < due_at_ms <= now + lead_hours`").** Jira writes `msFromIso(fields.duedate)` and Linear
   `msFromIso(dueDate)` (`jira-sync.ts:446`, `linear-sync.ts:226`) from `YYYY-MM-DD`, and `Date.parse` of a
   date-only string is 00:00 UTC. West of UTC the literal rule calls a ticket due on the 12th "due today"
   on the 11th and fires its notice up to a day early; east of UTC it is a day late for "overdue".
   GitHub milestone `due_on` is a full timestamp. Correction, one pure function `dueInstant(service,
   dueAtMs, tz)`: for `jira` and `linear` the due date is the UTC calendar date of `due_at_ms` and the due
   instant is the END of that date in `tz` (the local midnight that begins the next date); for GitHub it is
   `due_at_ms`. Overdue = `dueInstant <= now`; due today = `now < dueInstant <= endOfToday`; the notice
   window is `now < dueInstant <= now + lead_hours`. `deadline_notice.due_at_ms` stores the RAW row value
   (stable under re-sync, which is what the 1 h re-notify rule needs).
7. **Outlook mail has no thread key (spec: "grouped by thread").** The Outlook writer's metadata is only
   `receivedDateTime` plus `is_read`/`meta_v` (`outlook-sync.ts:148-158`); there is no `conversationId`.
   Gmail has `metadata.threadId` and `labelIds` (`_lib/gmail/api.ts:196`; `labelIds` may be `undefined`).
   Correction: Gmail unread is grouped by `threadId` (a message without one is its own thread); Outlook is
   counted per MESSAGE and the section says so in one inline line. Outlook's window uses
   `receivedDateTime` (the row's `modified_at` is `lastModifiedDateTime`, which a read flips). Gmail rows
   labelled `TRASH` or `SPAM` are excluded (the spec lists only `UNREAD`; stated here, tested).
8. **D-MB-4's example contradicts its own rule.** The example headline reads "... on call until 18:00"
   while section 5.5 says "No title, sender, repository, channel, schedule name or time is ever in a
   toast". Correction: counts only, `on call today`, no time. Also `deadlineToastText(n)` would say "within
   24 h" even when `lead_hours` is 48: it takes `(n: number, leadHours: number)` (still numbers only).
9. **The scheduler has nowhere to read "lastFire" from.** SA4 persists `schedule_next_at` on each workflow
   row (`workflow-scheduler.ts:153`, `advanceSchedule`); the briefing has no such row and the spec's `briefing_run`
   has no slot column. Correction: `briefing_run` gains `slot_at INTEGER` (the scheduled instant a
   `schedule` run or skip answers; NULL for `manual`) with a partial UNIQUE index, plus `error_msg TEXT`.
   `lastSlotAt = MAX(slot_at)` is the durable "last fire", and the unique index makes a slot fire at most
   once even if two ticks race. The in-memory baseline rule (Design decisions) stops a re-enable from
   replaying old slots.
10. **All-day events carry GATEWAY-zone midnights, not `[briefing] tz` midnights.**
    `connectors/_lib/calendar-event-normalize.ts` `allDayInstants(start, endExclusive, zone)` takes the
    sync's zone (`gatewayZone()`), and iCloud does the same. If `[briefing] tz` differs, comparing the
    instants against the briefing day misplaces an all-day event by hours. Correction: an `all_day` row is
    compared by CALENDAR DATE: its start/end dates are read back from `start_ms`/`end_ms` in `gatewayZone()`
    and it covers the briefing date `D` iff `startDate <= D < endDateExclusive`. Timed events use the
    half-open instant overlap `start < dayEnd && (end > dayStart || (end == start && start >= dayStart))`.
11. **An empty snapshot is indistinguishable from "never ran".** MB1 deviation 11: an empty relation writes
    no `work_snapshot` row. The section can show snapshot age only as `MAX(captured_at)` over non-empty
    relations. Correction: with a connected service and zero snapshot rows the section says "no open
    assigned items are indexed (the snapshot is empty or has not run yet)"; it never claims "nothing is
    assigned to you". Stated bound.
12. **MB3's reader answers "now and the next 7 days", not "overlapping today".** `queryOncallNow`
    (`index/oncall-now-query.ts:254`) returns `shifts` (cover `now`) and `next` (start within 7 d). A shift
    that ended earlier today is not returned; JSM shifts carry no times and a `shift: current|next` flag
    instead. Correction: the On call section is `shifts.filter(isMe)` plus `next.filter(isMe)` whose
    `startMs < endOfToday`, plus one `queryOncallNow({term: serviceId, serviceConfigs})` line per
    `[ci.service.*]` binding (current shifts only). Bound: a shift that began and ended before the fire is not
    listed. No new reader is written.
13. **The "active incident" rule is private and "mine" needs a person id.** `isActiveStatus` in
    `agents/_lib/oncall-queries.ts:51` is module-private (a missing status counts as active, compared
    case-insensitively); `selectActiveAssignedIncidents(db, personId)` needs the id. Correction: export
    the predicate as `isActiveIncidentStatus` (one definition, no copy); the personId comes from an injected
    `resolveSelf` built exactly as `oncall-push/push-runtime.ts:135` builds it (`[user]` override, then
    `resolveSelfPerson`). When it resolves to `null` the Incidents section lists every active incident
    unmarked and a `missing_user_identity` gap says why.
14. **"A `ci_run` row links it" has no link.** PR rows carry canonical `repo`, `number`, `branch`
    (`connectors/pr-meta.ts`); `ci_run` rows carry canonical `repo`, `branch`, `conclusion`, `head_sha`
    (`connectors/ci-run-meta.ts`); there is no edge. Correction: CI state of an authored PR is the newest
    `ci_run` (by `modified_at`) with the same `repo` AND `branch`, shown only when both are present; a PR
    row without `branch` shows no CI state and counts toward one inline "n PRs have no branch recorded"
    line. Only GitHub PRs are in MB1's snapshot; the section carries a fixed line saying GitLab and
    Bitbucket reviews are not tracked.
15. **The roadmap's Deadline row names Calendar as a source; the spec's scan does not.** Section 5.5 scans
    `assigned` snapshot items only. Correction recorded in the roadmap edit: calendar events appear in the
    briefing's Calendar section, they are not deadline notices.
16. **Provider windows "sent as UTC instants" (section 5.5) does not apply:** MB5 reads the index only and
    makes no provider request, so there is no outbound window to format. The "today" range is used only to
    filter indexed rows.
17. **The acceptance test path** is `packages/gateway/test/integration/briefing/briefing.acceptance.test.ts`
    (the directory exists with MB1-MB3's files; the spec omits `packages/gateway/`).

Spec claims verified correct (no deviation): `checkLanMethodAllowed` is a DENYLIST (`lan-rpc.ts:281`: first
segment or full method in `FORBIDDEN_OVER_LAN`), so `briefing` is LAN-reachable by default until added and
there is no `briefing` entry today; `ALLOWED_METHODS.len()` is 127 and the list is alphabetised (the four
reads slot between `audit.verify` and `captures.get`); `WorkflowScheduler` is a 60 s `unref`'d interval with
`start`/`stop`/`retire`, built in `gateway-main.ts:407` only when `paths.demo !== true`, started after
`ipc.start()` (`:487`) and retired first in `shutdown` (`:437`); `cron.ts` `nextFire` works on the zone's wall
clock, skips a spring-forward gap minute and fires a fall-back repeated minute once at its first occurrence
(header comment, `instantOf` takes the earliest); every metadata key section 5.5 reads is written (see the
fixture table in Task 6); `sync_state(connector_id, last_sync_at, configured)` exists and
`detectMissingConnector` (`agents/_lib/gap-notes.ts:32`) is the existing "is this source connected" test.

## Design decisions

- **Layout.** `briefing/` holds orchestration (store, scheduler, runner, delivery, deadline scan, runtime);
  `agents/_lib/briefing-*.ts` holds the pure brief (types, queries, builder, renderer). Both are D45's scope.
  No file in either imports `chatops/`, `egress/`, `federation/`, `share/`, or a VALUE from `connectors/`;
  none calls `fetch`. Delivery sinks: `ipc/gateway-events.ts` `emitGatewayEvent` and
  `platform/notifications/notifications-runtime.ts` `showWithOutcome`, both INJECTED into the runner so a
  test substitutes recorders.
- **The brief is a pure function of the database and a clock.**
  `buildMorningBriefing({ db, nowMs, tz, sections, selfPersonId, serviceConfigs, snapshotIntervalMinutes,
  readUnreadChat? }): BriefingBrief`, synchronous, no I/O beyond SQLite reads, no `Date.now`, no ambient
  zone. Section order = config order; a section not in config is not built (no query runs).
- **Reads are parsed in TypeScript.** Memory (`sqlite-json-extract-raises-on-bad-json`) says `json_extract`
  throws on bad JSON and its evaluation order is context-dependent. Every section selects rows by a cheap
  column predicate, parses `metadata` with a `try/catch` (`oncall-now-query.ts` `parseRow` is the pattern),
  and drops rows that do not parse, counting them in an inline "n rows unreadable" line only when n > 0. Row
  scans are capped (events 20,000, mail 5,000 newest) and a hit cap is an inline line.
- **Lane census.** Every metadata key a TypeScript read touches is annotated
  `// lane-census: scope=<type>[,<type>] service=<id>[,<id>]` so `audit:lane-census` matches it to a
  writer. The fixture table in Task 6 is the key inventory; the task ends by running
  `bun run audit:lane-census` (report mode) and `--check`, and adding an annotation (never an exemption)
  for each flagged read.
- **Self-contained scheduler (not a workflow, D-MB-2).** `briefing/briefing-scheduler.ts` copies
  `WorkflowScheduler`'s shape (60 s `unref`'d interval, first tick at once = startup catch-up, `inFlight`
  guard so ticks never overlap, `retired` flag, `start`/`stop`/`retire`) and shares no code with it. Config
  is re-read EVERY tick from `loadNimbusBriefingFromConfigDir` (mtime-cached layered reader), so an edit
  applies without a restart and `enabled` needs no live-reader machinery.
- **Slot planning is a pure function** (`briefing/briefing-schedule.ts` `planFire`), so DST, catch-up and
  re-enable are table-driven tests with no timers: `cursor = max(baseline, lastSlotAt ?? baseline, now -
  25 h)`; iterate `nextFire(schedule, tz, cursor)` while `<= now` (at most 30 steps; the 1 h minimum
  spacing makes 25 h hold at most 25); none -> `{kind:"none"}`; otherwise only the LATEST due slot is acted
  on (older ones are absorbed into it): `now - slot <= 3 h` -> `{kind:"run", slotAt}`, else
  `{kind:"skip", slotAt, reason:"missed while the gateway was not running"}` recorded as a `skipped` row.
  `baseline` is in-memory: at scheduler start with `enabled` it is `lastSlotAt ?? startMs` (so a restart
  catches up a missed slot, and a first-ever start does not invent history); a tick that sees `enabled`
  go false -> true sets it to `now` (enabling at 09:00 does not fire the 08:30 slot); `enabled` false
  clears it and plans nothing.
- **Order inside one fire:** build the brief -> `synthesize(brief)` with NO runner -> insert the
  `briefing_run` row (the claim; the unique `slot_at` index makes a double fire impossible) -> emit
  `briefing.ready` -> toast -> `UPDATE ... SET toast_outcome`. A throw in build/render inserts a `failed`
  row with `error_msg` = error name + first 200 characters of the message (never item text: the build
  throws only on SQL/programming errors) and emits nothing; `nimbus doctor` reports it. A manual run
  (`runNow`) toasts exactly like a scheduled one except on a demo-rooted gateway (`toast: false`,
  `toast_outcome = "demo"`); the event is emitted either way. One in-flight run at a time
  (`ERR_BRIEFING_BUSY`, -32000).
- **Headline == toast body.** `briefing_run.headline` stores `briefingToastText(counts).body`, so what the
  lock screen showed is what `list` shows. `BriefingCounts` is `{ meetings, onCallShifts, incidents,
  reviews, ticketsDue, unreadMail, unreadChat }`, all `number`; zero parts are omitted; all zero reads
  "Nothing is waiting for you today". `ticketsDue` = overdue + due today.
- **Deadline scan (every 15 min inside the same tick; independent of `[briefing] enabled`).** Candidates are
  `work_snapshot` relation `assigned` JOIN `item` for jira, linear, github issues; the query selects NO
  title (privacy by construction). Open = Jira/Linear `status_category` not in `done|canceled` (a missing
  or `unknown` category counts as open: fail toward notifying), GitHub issue `state = 'open'`. Candidate
  iff `now < dueInstant <= now + lead_hours` and `item.modified_at < now - quiet_hours`. Per candidate, in a
  `try`: no row -> INSERT (notify); row with `|raw due - stored due| >= 1 h` -> UPDATE (notify); else
  nothing. The write happens BEFORE the toast; a write that throws drops that item from this scan's count.
  One toast per scan (`deadlineToastText(n, leadHours)`) when n > 0, `showWithOutcome`, outcome logged, not
  stored (spec has no column). Prune: `deadline_notice` rows with `due_at_ms < now - 30 d`, and `briefing_run`
  rows with `fired_at < now - retention_days`, once per hour and at start. First scan runs on the first tick.
- **Dedup of calendar entries.** The same meeting often arrives from two services (an Outlook calendar
  subscribed in Google). Entries from DIFFERENT services with identical `start_ms`, `end_ms` and
  case-folded trimmed title are shown once, naming both sources. Same-service duplicates are never merged.
- **Counts for the headline use pre-cap totals,** the rendered lists use the caps from section 5.5
  (calendar 20, on call 10, incidents 10, reviews 15 + authored 10, tickets 25, mail 10, chat 10), each with
  a final "and N more" line.
- **Demo (I41).** `platform.paths.demo === true`: the runtime is built (IPC reads and `runNow` work over
  the demo root's synthetic index and its own config dir) but `scheduler` is `undefined`, so neither the
  briefing tick nor the deadline scan exists; the notifications service is already inert in demo
  (`delivers === false`) and the runner is additionally passed `toast: false`.
- **IPC.** `briefing.latest {}` -> `{ run: BriefingRunView | null }` (newest `ok`, with markdown);
  `briefing.list {limit?}` (1..100, default 20) -> `{ runs: BriefingRunSummary[] }` (no markdown);
  `briefing.get {id}` -> `{ run }` or -32602 `ERR_BRIEFING_NOT_FOUND`; `briefing.status {}`;
  `briefing.runNow {}` (CLI-only: not on the Tauri allowlist, not LAN-callable). A `BriefingRpcError` ->
  `RpcMethodError` like `OncallNowRpcError`. Unknown params are refused (-32602) as `oncall.now` does.
- **MB4 seam (exact).** MB5 never imports MB4. `agents/_lib/briefing-types.ts` declares
  ```ts
  export type ChatUnreadThread = { readonly itemId: string; readonly channelId: string;
    readonly channelName: string | null; readonly channelKind: "dm" | "mpim" | "channel";
    readonly threadKey: string; readonly latestTsMs: number; readonly title: string;
    readonly url: string | null; readonly unreadMessages: number };
  export type ChatUnreadResult = { readonly totalThreads: number;            // before the cap
    readonly threads: readonly ChatUnreadThread[];                           // DMs and mpims first, then newest first, at most opts.limit
    readonly channelsWithMarker: number;
    readonly oldestMarkerCapturedAtMs: number | null; readonly newestMarkerCapturedAtMs: number | null };
  export type ChatUnreadReader = (db: Database, opts: { readonly nowMs: number; readonly limit: number }) => ChatUnreadResult;
  ```
  and `BriefingDeps.readUnreadChat?: ChatUnreadReader`. **The function MB4 must export is
  `readUnreadChatThreads(db: Database, opts: { nowMs: number; limit: number }): ChatUnreadResult` from
  `packages/gateway/src/index/chat-unread-query.ts`**, declaring its own structurally identical result types
  (neither slice imports the other; TypeScript structural typing joins them). The single join point is one
  line in `platform/assemble.ts` where the runtime is built: `readUnreadChat: readUnreadChatThreads`.
  *If MB5 merges first:* the line is absent, `readUnreadChat` is `undefined`, and the Chat section renders
  `## Gaps` (`missing_connector`): "Unread Slack threads are not available yet: Slack read markers are not
  indexed in this version." MB4's PR then adds the import and the line and flips the Gaps case in MB5's
  acceptance test to the fake-reader case (MB5 ships both cases). *If MB4 merges first:* MB5's PR adds the
  import and the line itself and the Gaps-for-absent-reader test keeps passing because it passes no reader.
  With a reader present: Slack not connected (`detectMissingConnector(db, "slack")`) -> `missing_connector`
  gap; `channelsWithMarker === 0` -> gap "no Slack read markers yet (the next Slack sync records them)";
  otherwise the list plus an inline "markers are N min to M min old" line from the two captured-at fields.
- **Migration number rule.** Free numbers at plan time: V92 (MB4 will most likely take it) and V93. MB5
  writes its DDL as `BRIEFING_V93_SQL` in `index/briefing-v93-sql.ts`, `runner-v93.test.ts`,
  `simpleStep(92, 93, ...)`, `CURRENT_SCHEMA_VERSION = 93`. **Rebase rule:** the number is
  `CURRENT_SCHEMA_VERSION on the merge base + 1`. If MB4 has NOT merged, rename to V92 (`git mv` the sql file
  and the test, change `simpleStep(91, 92)`, the constant, and every `V93`/`93` in comments and docs: the
  checklist is `git grep -n "V93\|schema V93\|, 93\b"` before and after). If MB4 merges after MB5, MB4 renumbers
  itself. `runner-v93.test.ts` asserts `CURRENT_SCHEMA_VERSION === maxRegisteredIndexedSchemaVersion()` and
  its first test sets the "from" version from the constant minus one, so a renumber is a two-line edit.

## File map

New, gateway (`packages/gateway/src/`), each with a colocated `.test.ts` unless noted:
- `util/zoned-time.ts` (moved from `connectors/_lib/zoned-time.ts`; old path becomes a re-export shim)
- `index/briefing-v93-sql.ts` (DDL, no test of its own), `index/migrations/runner-v93.test.ts`
- `briefing/briefing-store.ts` (the only writer of both tables), `briefing/briefing-day.ts`,
  `briefing/briefing-due.ts`, `briefing/briefing-toast.ts`, `briefing/briefing-schedule.ts`,
  `briefing/briefing-delivery.ts`, `briefing/briefing-runner.ts`, `briefing/deadline-scan.ts`,
  `briefing/briefing-scheduler.ts`, `briefing/briefing-runtime.ts`
- `agents/_lib/briefing-types.ts` (types only, covered through the builder), `briefing-queries.ts`,
  `briefing-build.ts`, `briefing-render.ts`
- `ipc/briefing-rpc.ts`, `ipc/server/dispatchers-briefing.test.ts`
- `packages/gateway/test/integration/briefing/briefing.acceptance.test.ts`
- `packages/cli/src/commands/briefing.ts`, `briefing-format.ts` (+ tests)

Modified, gateway: `connectors/_lib/zoned-time.ts` (shim), `automation/cron.ts` (+ test),
`config/briefing-toml.ts` (+ test), `index/migrations/runner.ts`, `index/local-index.ts`,
`agents/_lib/{brief-kinds,synthesize,reserved-sections,brief-contract,render,oncall-queries}.ts` (+ their
tests, `reserved-sections.coverage.test.ts` table), `platform/notifications/notifications-runtime.ts`
(+ test), `ipc/gateway-events.ts` (+ test), `ipc/lan-rpc.ts` (+ `lan-rpc.test.ts`), `ipc/server/{dispatchers,options}.ts`
(+ `demo-gate.test.ts`), `platform/assemble.ts` (`PlatformServices.briefing`), `gateway-main.ts`,
`security-invariants.test.ts`.
Modified, other: `packages/cli/src/{index.ts,commands/index.ts,commands/help.ts,commands/tail.ts,
commands/doctor-core.ts}` (+ tests), `packages/ui/src-tauri/src/gateway_bridge.rs`,
`scripts/structure-audit/check-nimbus-invariants.ts` (+ `.test.ts`), `scripts/structure-audit/lane-census/`
only if a read cannot be annotated (it should not), and the docs listed at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. Fresh worktree from the base that contains MB1, MB2b and MB3 (current `main` if #1972 has merged):
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-mb5 -b dev/asaf/p10-mb5 main`
   (absolute path, never nested). `git rev-parse --abbrev-ref HEAD` before every commit. `bun install`;
   build the sandbox helper only if a sandbox test is run later. Trust `bun run typecheck`, not editor
   diagnostics (stale in a fresh worktree).
2. Re-read the three numbers the plan assumes: `CURRENT_SCHEMA_VERSION` (91), `ALLOWED_METHODS.len()` (127,
   `security-invariants.test.ts:1932` and the Rust `allowlist_exact_size`), and whether
   `packages/gateway/src/index/chat-unread-query.ts` exists (MB4 merged). Apply the migration rebase rule and
   the MB4 seam rule above accordingly; every `93`, `131` and "17 kinds" below moves with them.
3. Confirm the base has MB1's `config/briefing-toml.ts`, `index/work-snapshot-store.ts`, MB2b's
   `connectors/google-calendar-event-mapping.ts`/`outlook-calendar-mapping.ts`, and MB3's
   `index/oncall-now-query.ts`. If any is missing, stop: MB5 needs MB1 and MB3 merged (spec section 4).

### Task 1 - Time helpers (`util/zoned-time.ts`, `cron.ts`)

Files: `util/zoned-time.ts` (+ moved `zoned-time.test.ts`), `connectors/_lib/zoned-time.ts` (shim),
`automation/cron.ts`, `automation/cron.test.ts`.

1. Tests first. In `util/zoned-time.test.ts` (moved from `connectors/_lib/`, import path updated) add
   `wallOfInstant`: London summer and winter; `America/New_York` across spring-forward (the instant after
   the gap reads 03:00); across fall-back (two instants read 01:30, one hour apart); `UTC`; an invalid zone
   returns `undefined`; a negative-epoch instant. In `cron.test.ts` add `scheduleRefusal("0,30 * * * *", tz,
   60)` refused with a message naming 60 minutes, `scheduleRefusal("30 8 * * 1-5", tz, 60)` accepted,
   default third argument unchanged (`"*/5 * * * *"` still accepted, `"*/4 * * * *"` still refused with
   "5 minutes"). RED: `bun test packages/gateway/src/util/zoned-time.test.ts packages/gateway/src/automation/cron.test.ts`.
2. `git mv packages/gateway/src/connectors/_lib/zoned-time.ts packages/gateway/src/util/zoned-time.ts` and
   `.test.ts`; recreate `connectors/_lib/zoned-time.ts` as exactly
   `export * from "../../util/zoned-time.ts";` with a two-line comment (D45 reason). Implement
   `wallOfInstant` with the existing `formatterFor` cache. `scheduleRefusal(expr, tz, minIntervalMinutes =
   MIN_INTERVAL_MINUTES)`; the compared constant and the message use the parameter.
3. GREEN the two tests, then `bun run typecheck` (every importer of the old path still compiles through the
   shim) and `bun test packages/gateway/src/connectors/_lib packages/gateway/src/connectors/google-calendar packages/gateway/src/connectors/apple`.
   If `audit:dead-code` (knip) objects to the shim, convert importers to the new path in the same commit
   instead (mechanical `git grep -l "_lib/zoned-time"`), keeping no shim.

### Task 2 - Config (`config/briefing-toml.ts`)

1. Extend MB1's type (MB1 left `snapshotIntervalMinutes` as the only field and its parser tracks only
   `[briefing]`). Tests first in `briefing-toml.test.ts` (keep MB1's tests green):
   defaults (`enabled false`, `schedule "30 8 * * 1-5"`, `tz null`, `sections` = the 7 in spec order,
   `retentionDays 30`, `snapshotIntervalMinutes 15`, `deadlines {enabled false, leadHours 24, quietHours
   24}`); every key parsed; `[briefing.deadlines]` is its own table and does NOT leak into `[briefing]`
   (and `[briefing]` keys after it still parse when re-entered); `sections = ["mail","calendar"]` keeps
   order; fallback with a sink message naming the key for: `enabled = "yes"`, `schedule = "* * * * *"`
   (under 1 h apart), `schedule = "nonsense"`, `tz = "Mars/Base"`, `sections = []`, an unknown section name,
   a duplicate section, `sections = "calendar"` (not an array), a multi-line array (the line parser sees a
   bare `[`; `parseStringArray` THROWS, so wrap it as `oncall-push-toml.ts` documents), `retention_days`
   `0`/`366`/`1.5`, `lead_hours` `0`/`169`, `quiet_hours` `0`/`337`, `snapshot_interval_minutes` `4`/`241`.
   Never clamps: each bad key falls back to its OWN default and the others keep their values. Layered text:
   a profile or pack value wins as for other sections (`loadNimbusBriefingFromConfigDir`), CRLF, inline
   comments. Schedule validation uses the EFFECTIVE zone (`tz` if valid, else the machine zone) so a bad
   `tz` does not also condemn the schedule. RED.
2. Implement. `NimbusBriefingToml` gains `enabled, schedule, tz (string | null), sections, retentionDays,
   deadlines`. `tz: null` means "the OS zone", resolved at USE by `effectiveBriefingZone(cfg)`
   (`cfg.tz ?? machineTimeZone()`), so the frozen default constant is not machine-dependent and tests inject
   a zone. Validation calls `isValidTimeZone`, `scheduleRefusal(expr, tz, 60)` from `automation/cron.ts`
   (pure, no I/O). One fallback sink id stays `"briefing"` (already in `SECTION_LOADERS`,
   `config-explain.ts:84`), so no new section id and `config-explain.test.ts` needs no change. Export
   `BRIEFING_SECTIONS` (the seven names, as a readonly tuple) and `type BriefingSection`.
3. GREEN: `bun test packages/gateway/src/config/briefing-toml.test.ts packages/gateway/src/config/config-explain.test.ts`.
   Add a `probeSection` assertion that an out-of-range `retention_days` is reported as a fallback.

### Task 3 - Schema and store

Files: `index/briefing-v93-sql.ts`, `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner-v93.test.ts`, `briefing/briefing-store.ts` (+ test).

1. `runner-v93.test.ts` first (model it on `runner-v91.test.ts`): a V92 database gains empty
   `briefing_run` and `deadline_notice`; `user_version` 93; `CURRENT_SCHEMA_VERSION ===
   maxRegisteredIndexedSchemaVersion()`; CHECKs refuse `trigger = 'bogus'` and `status = 'bogus'`; the
   partial UNIQUE index refuses two rows with the same non-NULL `slot_at` and accepts any number of NULLs
   (manual runs); `deadline_notice` primary key; the trigger: insert an `item` row and its notice,
   `DELETE FROM item WHERE id = ?` removes that notice and no other; `DELETE FROM item WHERE service = ?`
   clears the service's notices; re-running the step is idempotent. RED.
2. DDL (`IF NOT EXISTS` everywhere, one statement per array element as `work-snapshot-v91-sql.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS briefing_run (
     id TEXT PRIMARY KEY, fired_at INTEGER NOT NULL,
     trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
     status TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
     headline TEXT NOT NULL, markdown TEXT, counts_json TEXT, toast_outcome TEXT,
     slot_at INTEGER, error_msg TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS briefing_run_slot ON briefing_run (slot_at) WHERE slot_at IS NOT NULL;
   CREATE INDEX IF NOT EXISTS briefing_run_fired ON briefing_run (fired_at DESC);
   CREATE TABLE IF NOT EXISTS deadline_notice (
     item_id TEXT PRIMARY KEY, due_at_ms INTEGER NOT NULL, notified_at INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS deadline_notice_item_delete AFTER DELETE ON item
   BEGIN DELETE FROM deadline_notice WHERE item_id = OLD.id; END;
   ```
   Header comment: `slot_at` and `error_msg` are additions to the spec's table (deviation 9); no backfill; the
   trigger is the cascade (`item` is not an FK parent; an upsert is `ON CONFLICT DO UPDATE` and never fires it).
   Register `simpleStep(92, 93, "morning briefing runs and deadline notices (Phase 10 MB5)", BRIEFING_V93_SQL)`;
   `CURRENT_SCHEMA_VERSION = 93`. GREEN, then `bun test packages/gateway/src/index` (other tests build to the constant).
3. `briefing-store.test.ts` first (real SQLite via `openMemoryIndexDatabase`): `insertRun` returns the id;
   a second `schedule` run with the same `slotAt` throws a typed `SlotTakenError` (the unique index) and
   inserts nothing; `setToastOutcome`; `latestOk` skips `skipped`/`failed`; `list(limit)` newest first,
   summaries carry no markdown; `get`; `lastSlotAt()` is `MAX(slot_at)` or `null`; `lastRun()` (any status)
   for status; `pruneRuns(olderThanMs)`; notices: `getNotice`, `insertNotice`, `updateNotice`, `pruneNotices`;
   `counts_json` round-trips. Implement with `dbRun`/`dbStmtRun` only (I14, static D12), bound parameters
   (I9), a code-unit comparator wherever an order is computed in TS (Sonar S2871: no bare `.sort()`).
   The file's header names it the only writer (D45 does not police this; `check-nimbus-invariants` D12 does).
4. GREEN.

### Task 4 - Pure types, counts and toast text

Files: `agents/_lib/briefing-types.ts`, `briefing/briefing-toast.ts` (+ test), `briefing/briefing-due.ts`
(+ test), `briefing/briefing-day.ts` (+ test).

1. `briefing-toast.test.ts` first: `briefingToastText(counts)` -> `{ title: "Nimbus briefing", body }` for
   the spec example (`3 meetings · 2 reviews waiting · 1 active incident · 4 tickets due or overdue ·
   2 unread mail threads · 1 unread chat thread · on call today`), singular/plural of each part, zero parts
   omitted, all-zero text, `onCallShifts > 0` -> `on call today`. `deadlineToastText(n, leadHours)` ->
   `{ title: "Nimbus deadlines", body: "2 open items due within 24 h with no recent activity" }`, singular,
   `leadHours` 48. **Property test:** 200 random `BriefingCounts` (including NaN, negative and fractional inputs, which the function clamps with `Math.max(0, Math.trunc(n))`, NaN counting as 0) always produce a body that matches the anchored pattern `^(Nothing is waiting for you today|\d+ [a-z ]+( · \d+ [a-z ]+)*( · on call today)?)$`, so no free text can appear. A type-level test (`// @ts-expect-error`) proves a `string` field cannot be added to the input.
2. `briefing-due.test.ts` first: `dueInstant("jira", Date.parse("2026-11-12"), "America/Los_Angeles")` is
   2026-11-13 00:00 PST (end of the 12th local), same date in `Asia/Tokyo`; `linear` likewise; `github`
   returns the input; classification table: overdue / due today / later / the 23 h and 25 h DST days.
3. `briefing-day.test.ts` first: `dayRange(nowMs, tz)` returns `{ startMs, endMs, dateKey }` half-open from
   local 00:00 to the next local 00:00 using `wallOfInstant` + `wallToInstantMs` (NEVER `+ 86_400_000`):
   London 2026-03-29 is 23 h, 2026-10-25 is 25 h, `America/New_York` 2026-03-08 and 2026-11-01 likewise;
   a zone whose midnight is in a gap (`America/Havana` on its spring-forward date, or
   `America/Sao_Paulo` for a pre-2019 date) still returns a finite range; `eventsOnDate` predicate tests for
   timed overlap (spans midnight, starts before and ends inside, ends exactly at start, zero-length) and the
   `all_day` calendar-date rule of deviation 10 (multi-day all-day event appears on each covered date and
   not on the exclusive end date; gateway zone injected, `briefing tz` different).
4. Implement. `briefing-types.ts` defines `BriefingBrief` (`kind: "briefing"`, `agentVersion: 1`,
   `generatedAt`, `latencyMs`, `gaps: GapNote[]`, `tz`, `day: { startMs, endMs, dateKey, label }`,
   `sections: readonly BriefingSectionBlock[]` as a discriminated union per section with its rows already
   formatted for display (local time labels computed by the builder with `Intl`, so the renderer is
   zone-free), `counts`, `freshness: readonly FreshnessRow[]`), `BriefingCounts`, `BriefingDeps`, and the
   MB4 seam types from the Design section. Types only: no runtime code, so it needs no test of its own.
5. GREEN: `bun test packages/gateway/src/briefing`.

### Task 5 - The brief: queries per section (`agents/_lib/briefing-queries.ts`)

All functions are synchronous, take `db` and plain parameters, return plain data, and build every fixture in
their tests FROM the writer (memory `query-filters-on-keys-no-connector-writes`): the test seeds rows by
running the real mapper/syncable through `syncTestContext(db, vault, service)`, never a hand-written
`item` row. Metadata-key inventory, which Task 5's `lane-census` annotations repeat:

| Section | Type, service | Keys read | Writer to drive in tests |
| --- | --- | --- | --- |
| Calendar | `event`: `apple`, `google_calendar`, `outlook` | `start_ms`, `end_ms`, `all_day`, `status`, `self_response`, `attendee_count` | `mapAppleEvent` (apple-event-mapping), `mapGoogleCalendarEvent`, the Outlook calendar mapper (`outlook-calendar-mapping.ts`) |
| Incidents | `incident`: `pagerduty` | `status`, `severity`, `assignee_emails`, `opened_at_ms` | `syncPagerdutyIncidentItems` |
| Reviews | `pr`: `github` | `state`, `repo`, `number`, `branch` | `upsertPr` path of `github-sync` via a Search fake (MB1 helpers) |
| CI state | `ci_run`: any CI writer | `repo`, `branch`, `conclusion` | `github-actions-sync` mapper |
| Tickets | `issue`: `jira`, `linear`, `github` | `due_at_ms`, `status_category`, `state` | the three syncables' snapshot passes (MB1) |
| Mail | `email`: `gmail`, `outlook` | `labelIds`, `threadId`, `from`, `is_read`, `receivedDateTime` | `upsertGmailMessage`, Outlook `upsertMessage` |
| On call | `oncall_shift` | none directly: `queryOncallNow` | MB3's syncables |

For each function, tests first, then implementation:

- **`selectCalendarDay(db, range, gatewayZone)`** reads all `event` rows of the three services (cap 20,000,
  a hit is reported), parses metadata, drops `status` cancelled (case-insensitive: iCloud keeps raw
  `CANCELLED`/`CONFIRMED`, Google/Outlook write `confirmed|tentative`) and `self_response === "declined"`,
  applies `eventsOnDate`, counts rows with no `start_ms` as "no time recorded" (iCloud rows older than MB1 until
  they resync), dedups across services (design), sorts by `start_ms`, flags overlaps (two timed events
  intersect; the later one carries `overlapsWith`), returns `{ rows, total, noTimeCount, scanned, capped }`.
  Tests: the three services' rows from their writers on one day; declined and cancelled dropped; tentative
  kept and labelled; all-day multi-day on each covered date only; a midnight-spanning event on both days;
  a duplicate across Google and Outlook merged and both services named; same-service duplicates kept.
- **`selectOncall`** is not a query: the builder calls `queryOncallNow` (deviation 12). Test through the
  builder with MB3's writers: a PagerDuty row with `is_me`, a JSM row with `shift: "next"`, a binding line.
- **`selectIncidents(db, personId)`**: `selectActiveAssignedIncidents(db, personId)` (mine first, existing
  edge join) then every other active incident (`isActiveIncidentStatus`, newest `opened_at_ms` first, id
  tiebreak by `codeUnitCompare`), deduped by id; `personId === null` -> all unmarked. Tests: resolved
  excluded, missing status included (fail toward showing), mine ordered first, case-insensitive `Resolved`.
- **`selectReviews(db)`**: GitHub `review_requested` then `authored_open` members of `work_snapshot` joined
  to `item` where `state` is not `merged|closed` (a PR that closed after the snapshot drops out), newest
  first; CI state per authored PR by the (repo, branch) rule of deviation 14.
- **`selectTickets(db, tz, range, nowMs)`**: `assigned` snapshots of the three services, open filter as in
  the deadline design, `dueInstant` classification, overdue first (oldest due first) then due today, then
  `otherOpen` count; returns snapshot `capturedAt` bounds per service. Tests per service from the MB1
  writers, including a Jira date-only due in `America/Los_Angeles` (deviation 6) and a GitHub milestone.
- **`selectUnreadMail(db, sinceMs)`**: SQL narrows to `type = 'email' AND service IN ('gmail','outlook') AND
  modified_at >= ? ` plus `instr(metadata, '"UNREAD"') > 0 OR service = 'outlook'`, capped at 5,000 newest;
  TypeScript then applies: Gmail `labelIds` includes `UNREAD` and not `TRASH`/`SPAM`, grouped by `threadId`
  (newest message's subject, sender from `from`, message count); Outlook `is_read === false` and
  `receivedDateTime` within 7 days, per message; counts Outlook rows with no boolean `is_read`
  (`predateReadTracking`) and returns them. Tests: Gmail thread with 3 unread messages is one thread;
  Outlook `is_read` true/false/absent; the 7-day edge; the sender string is sanitised in the renderer, not here.
- **Sources and freshness**: `connectedServices(db, ids)` via `detectMissingConnector` semantics (a
  `sync_state` row), and `freshnessOf(db, ids, nowMs)` = per service `sync_state.last_sync_at`, plus
  `MAX(work_snapshot.captured_at)` for the snapshot-backed sections and MB3's `sources[].oldestFetchedMs`.
  Test: a service without a row is "not connected", with `last_sync_at` null is "never synced".
- Finish the task by running `bun run audit:lane-census` and `bun run audit:lane-census -- --check`;
  annotate every flagged read (`// lane-census: scope=event service=apple,google_calendar,outlook` above the
  statement; R4: where SQL already scopes a type the annotation must agree). Do NOT add an exemption.

### Task 6 - The builder and the renderer; registering the `briefing` kind

Files: `agents/_lib/briefing-build.ts`, `briefing-render.ts`, `brief-kinds.ts`, `synthesize.ts`,
`reserved-sections.ts`, `brief-contract.ts`, `render.ts` (+ tests).

1. Tests first for `buildMorningBriefing`: with a fixed `nowMs` and `tz`, a database seeded for all seven
   sections yields one block per configured section in config order and none for an unconfigured one (spy:
   a section not in `sections` runs no query - assert by an `sqlite` statement counter or by dropping the
   `event` table and still building without calendar); caps (calendar 20, on call 10, incidents 10, reviews
   15 + 10, tickets 25, mail 10, chat 10) each ending with "and N more" and counts using pre-cap totals; an
   unconnected source for a built section adds exactly one `missing_connector` gap and renders no silent
   empty section; `selfPersonId === null` adds `missing_user_identity`; the chat reader absent adds the
   Gaps line of the seam text, the reader present renders threads and the marker-age line, `channelsWithMarker
   0` adds its gap; an empty index adds `empty_index` once; freshness rows list each section's services and
   the age of the newest sync (`"4 min ago"`, `"never synced"`, `"not connected"`); a 23 h day and a 25 h day
   build without error. No clock reads: `Date.now` replaced by a thrower for the test proves purity.
2. `briefing-render.test.ts`: the markdown header `# Morning briefing - <weekday> <date> (<tz>)`, a
   `## <Section>` per block, `## Gaps` and `## Data freshness` last and RESERVED (`omitReserved: true`
   drops both); titles pass `hardenedTitleLink` (a title containing `](` or a newline, and a
   `javascript:` url, are neutralised); mail sender text goes through `stripLineStructureChars` and is capped
   at 80 characters; the Outlook per-message line and "n PRs have no branch recorded" appear only when
   relevant; the output is byte-identical across two renders (determinism).
3. Register the kind. In `brief-kinds.ts` add `BriefingBrief` to `SynthInput`; `synthesize.ts`: a
   `case brief.kind === "briefing": return renderBriefing(brief, opts);` (keep the `switch (true)` shape the
   I31 scraper reads) and `briefing: "agents.briefing"` in `TOOL_NAME_BY_KIND`; `reserved-sections.ts`:
   `briefing: [GAPS_HEADING, BRIEFING_FRESHNESS_HEADING]` and a `reservedBlocksFor` branch building the
   freshness block from the brief (never by scanning markdown); `brief-contract.ts`: add `brief.kind ===
   "briefing"` to the explicit empty list; `render.ts`: `export` `hardenedTitleLink`. Update the existing
   tests that enumerate kinds: `reserved-sections.coverage.test.ts` table, `brief-contract` kind tests,
   and `security-invariants.test.ts:5263` needs no edit (it derives the set from `synthesize.ts`) - run it
   to prove totality. Update the stale "sixteen"/"seventeenth" comments only where they state a count the
   edit makes false (`audit:status-drift` and review will flag the rest).
4. Test that `synthesize(brief)` with no options returns `provenance: {attempted:false, reason:"disabled"}`,
   markdown ending in the deterministic footer, and that passing a runner is a TYPE the briefing code never
   constructs (grep pin in Task 12: `briefing/` and `briefing-*` contain no `runner`/`resolveForSynthesis`).
5. GREEN: `bun test packages/gateway/src/agents`.

### Task 7 - Delivery (`showWithOutcome`, gateway event, runner)

Files: `platform/notifications/notifications-runtime.ts` (+ test), `ipc/gateway-events.ts` (+ test),
`briefing/briefing-delivery.ts`, `briefing/briefing-runner.ts` (+ tests), `cli/src/commands/tail.ts` (+ test).

1. `showWithOutcome` tests first: `delivers === false` -> `"not_delivering"` and `show` NOT called; resolve
   -> `"delivered"`; reject with `NotificationRateLimitedError` -> `"rate_limited"`; with
   `NotificationUnavailableError` -> `"unavailable"`; any other throw or a synchronous throw -> `"failed"`;
   never rejects. Implement beside `showIgnoringFailure`; keep that function unchanged.
2. `gateway-events.ts`: add `"briefing.ready"` to `GatewayEventKind`, a `BriefingReadyPayload` interface
   (`runId`, `trigger`, `headline`, `counts`), and update the header comment's list WITHOUT changing the
   "two methods" statement. Test (`gateway-events.test.ts`): `emitGatewayEvent("briefing.ready", p)` reaches
   a bound broadcast as method `gateway.event` with that kind.
3. `tail.ts`: add a `briefing.` category (the `kind.startsWith(...)` chain at `:134`) and a render arm
   `${at} [briefing] ${headline} - nimbus briefing`; test in `tail.test.ts` incl. that an unknown future
   `briefing.*` kind is still shown.
4. `briefing-runner.test.ts` first (fake clock; fake `emit`, `toast` recorders; real SQLite): a `schedule`
   run writes one `ok` row with markdown, `counts_json`, `headline` equal to the toast body, then emits
   exactly one `briefing.ready` whose payload keys are `runId, trigger, headline, counts` and nothing else,
   then toasts with the headline, then stores `toast_outcome`; the order emit -> toast is asserted; a slot
   already taken -> `SlotTakenError` swallowed, no emit, no toast; a throwing builder (inject a failing
   `build`) -> a `failed` row with `error_msg` <= 200 chars, no emit, no toast, and the error does not
   escape the scheduler path; `toast: false` -> `toast_outcome = "demo"` and no toast call; an emit that
   throws does not stop the toast (`safeBroadcast` swallows, plus a runner-level catch); retention prune
   runs after a fire. Implement `runBriefing(deps, { trigger, slotAt, toast })` per the Design order. It
   calls `synthesize(brief)` with NO second argument.
5. GREEN: `bun test packages/gateway/src/briefing packages/gateway/src/platform/notifications packages/gateway/src/ipc/gateway-events.test.ts packages/cli/src/commands/tail.test.ts`.

### Task 8 - Deadline scan (`briefing/deadline-scan.ts`)

1. Tests first (real SQLite; items from the MB1 syncables, notices through the store):
   - **Exactly once:** a GitHub issue with a milestone due in 23 h and `modified_at` 30 h old, in the
     `assigned` snapshot: ten consecutive `scanDeadlines` calls (clock advancing 15 min each) produce exactly
     ONE toast and one `deadline_notice` row; the toast text is `deadlineToastText(1, 24)`.
   - **Quiet-hours edge:** `modified_at` newer than `now - quiet_hours` -> no notice; becoming stale later ->
     notice then.
   - **Window edge:** due in 25 h -> nothing; in 24 h exactly -> notice (`<=`); already past -> nothing
     (overdue is the briefing's job, not a 24 h warning); no `due_at_ms` -> nothing.
   - **Re-notify:** raw due moves by 59 min -> no second toast, row unchanged; by exactly 1 h -> a second toast
     and the row updated (new `due_at_ms`, new `notified_at`); a `Date.parse` re-render of the same date does
     not move it.
   - **Date-only:** a Jira ticket with `duedate` the day after tomorrow in `America/Los_Angeles` notices
     when `dueInstant` (end of that date) is within the lead window, not when the UTC midnight is.
   - **Open filter:** Jira `done`, Linear `canceled`, GitHub `closed` never notice; `unknown` category does.
   - **Write-first:** a store whose insert throws (inject) sends no toast for that item and the others still
     proceed; a toast failure never removes a written row (the notice is recorded; at-most-once beats
     at-least-once for a warning).
   - **One toast per scan** for several items (`deadlineToastText(3, 24)`); zero candidates -> no toast.
   - **Cascade:** `deleteItem` on a noticed item removes its notice (the V93 trigger), so a recreated item notices again.
   - **Privacy:** the candidate SQL selects no `title` column (assert on the SQL text) and the toast/outcome
     record contain no item field.
   - Prune: a notice with `due_at_ms` 31 days past is deleted, 29 days kept.
2. Implement `scanDeadlines({ db, store, nowMs, tz, cfg, toast })`: candidates -> per-item `try` ->
   `toast(deadlineToastText(n, leadHours))` -> returns `{ candidates, noticed, outcome }` for status.
3. GREEN: `bun test packages/gateway/src/briefing/deadline-scan.test.ts`.

### Task 9 - Slot planning and the scheduler

1. `briefing-schedule.test.ts` first (pure; zones injected; no timers), table-driven:
   - ordinary weekday: `now` just after 08:30 with `lastSlotAt` yesterday -> `run(08:30 today)`;
     `now` before 08:30 -> `none`; weekend (`1-5`) -> `none`.
   - **catch-up:** gateway off, `now` = slot + 2 h 59 m -> `run`; slot + 3 h 1 m -> `skip` with the
     reason; three missed days -> ONE action for the latest slot.
   - **baseline:** first-ever start 08:45 with no rows -> `none` (no history invented); `enabled`
     flipped on at 09:00 -> `none` until tomorrow; restart with `lastSlotAt` = yesterday and now 08:40 ->
     `run`.
   - **DST (Europe/London, `30 1 * * *`):** 2026-03-29 (01:30 does not exist) -> `none` that day, a stated
     bound; 2026-10-25 (01:30 repeated) -> exactly one `run`, and the tick after it -> `none`;
     `America/New_York` `0 2 * * *` on 2026-03-08 -> skipped day, on 2026-11-01 once. `30 8 * * 1-5` across
     both changes fires at 08:30 local on both sides.
   - **Spacing:** the 25 h clamp - a `lastSlotAt` 10 days old does not iterate 240 slots (assert the loop
     bound with a counter on an injected `next`).
   RED, implement `planFire`, GREEN.
2. `briefing-scheduler.test.ts` first (fake clock, fake runner/scan; real SQLite for the store):
   `start()` ticks once at once and every `tickMs`; `stop`/`retire` (awaits an in-flight run; no new fire
   after); two overlapping ticks run once (`inFlight`); a `skip` action inserts a `skipped` row with the slot
   and reason, no emit, no toast; a `run` action calls the runner with `trigger: "schedule"` and the slot;
   two schedulers racing the same slot -> one row (unique index); config `enabled=false` -> no fire and
   baseline cleared; invalid schedule (config fell back) is never passed on; the deadline scan runs on the
   first tick when `deadlines.enabled`, then not again until 15 min later, independent of `enabled`;
   `onError` is called, and the tick survives, when the runner or the scan throws; prune hook hourly.
3. GREEN: `bun test packages/gateway/src/briefing`.

### Task 10 - Runtime, IPC, LAN, assembly

Files: `briefing/briefing-runtime.ts`, `ipc/briefing-rpc.ts`, `ipc/server/{dispatchers,options}.ts`,
`ipc/lan-rpc.ts`, `platform/assemble.ts`, `gateway-main.ts` (+ tests).

1. `briefing-runtime.ts`: `createBriefingRuntime(deps)` where `deps = { db, configDir, now, resolveSelf,
   emit, toast, demo, readUnreadChat?, logger }` returns `{ runNow(), latest(), list(limit), get(id),
   status(), scheduler: BriefingScheduler | undefined }`. `runNow` rejects with `ERR_BRIEFING_BUSY` while a
   run is in flight (shares the scheduler's `inFlight` promise). `status()` assembles: config echo (schedule,
   tz, sections, retention, deadlines), `nextFireMs` (`nextFire(schedule, tz, now)`, `null` when disabled),
   `lastRun` (any status), `deadlines.{lastScanMs,lastCandidateCount,lastNoticeCount}` from the scanner's
   in-memory result, `sources` per configured section (`services: [{id, connected, lastSyncMs}]`),
   `toastDelivers` (the service's live `delivers`), `demo`. Test each field, including `nextFireMs` across a
   DST change and `sources` for an unconnected service.
2. `ipc/briefing-rpc.ts` + `dispatchBriefingRpc` via `dispatchByMethod` (the `oncall-now-rpc.ts` shape);
   tests (`briefing-rpc.test.ts`): payload validation (non-object, unknown key, `limit` 0/101/1.5/"5",
   missing/empty `id`), `get` of an unknown id -> `BriefingRpcError(-32602, "ERR_BRIEFING_NOT_FOUND")`,
   `runNow` returns the run view. `tryDispatchBriefingRpc` in `dispatchers.ts` is added to
   `PHASE4_PLATFORM_DISPATCHERS` (the IPC-needs-ROUTING trap, memory `ipc-method-needs-routing-not-just-a-handler`);
   `dispatchers-briefing.test.ts` pins that `briefing.latest` reaches the handler THROUGH
   `tryDispatchPhase4Rpc` (not only through the unit function), and that an unrelated method is skipped.
   `options.ts` gains `briefingRpcCtx?: BriefingRpcCtx`; the dispatcher skips cleanly when unset.
3. LAN (I5): add `"briefing"` to `FORBIDDEN_OVER_LAN` with a comment (the brief restates the owner's PRs,
   incidents, mail subjects, calendar and on-call: the whole index in prose; and `runNow` writes). `lan-rpc.test.ts`:
   `test.each` over all five methods throws `ERR_METHOD_NOT_ALLOWED` for `writeAllowed` true and false, and
   the negative control `agents.briefing` (not a method; keys on `agents`) is NOT refused by the new entry.
   `security-invariants.test.ts`: an I5 test beside the `oncall.now` one (line 846) asserting the entry and the
   refusal.
4. Assembly: `platform/assemble.ts` builds the runtime next to `oncallPush` (it needs `db`, `paths.configDir`,
   `notifications`, the `resolveSelf` closure copied from `push-runtime.ts:135`, `emitGatewayEvent`,
   `showWithOutcome`, `paths.demo`, and the MB4 seam line), adds `briefing: BriefingRuntime` to
   `PlatformServices`, and sets `ipcOpts.briefingRpcCtx = { runtime: briefing }`. `scheduler` is `undefined`
   when `paths.demo === true` (I41). `gateway-main.ts`: after `platform.ipc.start()` (next to
   `workflowScheduler?.start()`): `platform.briefing.scheduler?.start()`; in `shutdown`, next to
   `await workflowScheduler?.retire()`: `await platform.briefing.scheduler?.retire()` in its own
   `try/catch {}` like the others. `bun run typecheck` is the census for every `PlatformServices` literal
   (test stubs); fix each by `...` spread of an existing stub, not by making the field optional.
5. Tauri (I7), `packages/ui/src-tauri/src/gateway_bridge.rs`: insert `"briefing.get"`, `"briefing.latest"`,
   `"briefing.list"`, `"briefing.status"` between `"audit.verify"` and `"captures.get"` (alphabetised;
   `allowlist_is_alphabetized` enforces it); `allowlist_exact_size` 127 -> 131; add Rust test
   `allowlist_briefing_reads_only`: the four are `is_method_allowed`, `briefing.runNow` is NOT, none is in
   `NO_TIMEOUT_METHODS` (`no_timeout_methods_exact_size` stays 8). `GLOBAL_BROADCAST_METHODS` untouched
   (deviation 2). TS pins in `security-invariants.test.ts`: the `allowlist_exact_size assertion is 127`
   test (`:1930`) -> 131; a new test beside the oncall one (`:1961`) asserting by name that the four reads
   appear as `^\s*"briefing\.x",\s*$` lines, `briefing.runNow` does not, and the Rust test strings
   `assert!(is_method_allowed("briefing.status"));` / `assert!(!is_method_allowed("briefing.runNow"));` exist.
6. Demo: `demo-gate.test.ts` allowed list gains the five methods (`demoRefusal` returns `undefined`: they
   bring neither credentials nor data, spec section 5.5; no `demo-gate.ts` change). A runtime test with
   `demo: true` pins: no scheduler object, `runNow` emits the event, the toast recorder is never called,
   `toast_outcome === "demo"`.
7. GREEN: `bun test packages/gateway/src/ipc packages/gateway/src/briefing`, then in
   `packages/ui/src-tauri`: `cargo test` (the allowlist tests), and `bun test packages/gateway/src/security-invariants.test.ts`.

### Task 11 - CLI and doctor

Files: `cli/src/commands/briefing.ts`, `briefing-format.ts`, `index.ts`, `commands/index.ts`, `help.ts`,
`doctor-core.ts` (+ tests).

1. Tests first (the `oncall-now.test.ts` pattern: an injected `{call}` IPC and a `{out, err}` sink):
   - `parseBriefingArgs`: `[]` -> latest, `--json`, `now`, `list [--limit N]`, `status [--json]`; unknown
     argument or a second subcommand -> `undefined` (usage on stderr, exit 1).
   - `nimbus briefing`: prints `run.markdown` with `stripControlChars` applied to the WHOLE text (ANSI escapes
     from an indexed title cannot reach the terminal) and a footer `fired <local time> - <trigger>`;
     `{run: null}` -> a hint (`No briefing yet. Run "nimbus briefing now", or enable [briefing] in nimbus.toml`)
     exit 1; `--json` prints the raw result.
   - `now`: calls `briefing.runNow` and prints the new run; `ERR_BRIEFING_BUSY` -> message, exit 1.
   - `list`: one line per run (`<id8> <local time> <trigger> <status> <headline>`), `skipped` shows its reason.
   - `status`: enabled/off, schedule + zone + next fire in the configured zone, last run, deadlines block,
     per-section sources (`connected` / `not connected`), `toast: will show | will not show (...)`.
   - Doctor `doctorPrintBriefing(client)` in the `doctorPrintCaptures` shape: silent when `[briefing]
     enabled = false` and deadlines off; `-32601` from an older gateway silent; `[warn] Morning briefing:
     enabled but no source is connected for: <sections>` (exit 1) when an enabled section has no connected
     service; `[warn] ... the last scheduled briefing failed (<error_msg>)`; `[info]` when toasts will not
     show; `[ok]` otherwise with the next fire. Wire it after `doctorPrintCaptures` (`:1169`). Any other RPC
     failure is a `[warn]` (a skipped check must not read as healthy).
2. Implement; register `briefing: runBriefingCommand` in `COMMAND_HANDLERS` (`index.ts`; it returns
   `Promise<void>` and throws `CliExit` for a non-zero code, like `oncall`), export from `commands/index.ts`,
   add the help lines (`nimbus briefing [now|list|status] [--json]  Your morning briefing, built from the
   local index (no model, nothing leaves the machine)`). `audit:readme-cli` compares registered commands with
   the README: run it.
3. GREEN: `bun test packages/cli`.

### Task 12 - Static rule D45 (`briefing-confined`)

Files: `scripts/structure-audit/check-nimbus-invariants.ts` and `.test.ts`.

1. Tests first, a `describe("D45 - the morning briefing delivers locally only", ...)` in the D44 block's
   shape (a `GOOD` fixture set, single-violation swaps, assertions on the set of rule ids; a `.test.ts` and a
   comment-only mention are skipped/ignored):
   - GOOD: `briefing/briefing-runner.ts` importing `../ipc/gateway-events.ts`, `../platform/notifications/notifications-runtime.ts`,
     `../agents/_lib/synthesize.ts`, `../index/...`; `agents/_lib/briefing-build.ts` importing
     `../../index/oncall-now-query.ts`; `import type { X } from "../connectors/..."` (type-only allowed);
     the control `checkBriefingConfinement(GOOD)` is `[]`.
   - Violations, each its own test asserting exactly `briefing-forbidden-import`: a value import from
     `../chatops/x.ts`, `../egress/x.ts`, `../federation/x.ts`, `../share/x.ts`, `../connectors/x.ts`
     (value), `import { type A, b } from "../connectors/..."` (mixed clause has a value), a dynamic
     `import("../chatops/...")`, `require("../egress/...")`, a re-export `export { x } from "../connectors/..."`,
     a type-only import from `chatops/` (the spec allows type-only for `connectors/` ONLY), and the same
     imports from `agents/_lib/briefing-queries.ts`. Violations asserting `briefing-no-network`: `fetch(`,
     `globalThis.fetch(`, `Bun.fetch(`, `new WebSocket(`, `XMLHttpRequest`, and an import of `node:http`,
     `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram` or `undici`. Non-violations: the word
     `fetch` in a comment or a string literal, `db.fetch(` / `.fetch(` as a method on another object is
     allowed only if the receiver is not `globalThis`/`Bun` (use `(?<![.\w$])fetch\s*\(` plus the two
     explicit forms), a file OUTSIDE the scope (`ipc/gateway-events.ts` imports a connectors type and is not
     scanned), `*.test.ts`.
   - A real-repo test: `iterateSourceFiles()` fed to the checker returns `[]`; and a scope test that asserts
     the checker actually visits at least one `briefing/` file and one `agents/_lib/briefing-*.ts` file.
   RED first (function missing).
2. Implement `checkBriefingConfinement(files)` reusing `D39_STATIC_IMPORT_RE`, `clauseHasValue`,
   `D39_DYNAMIC_IMPORT_RE` and the `D38_SPECIFIER_RE` shape: scan comment-stripped text for specifiers (a
   forbidden SEGMENT regex `(?:^|/)(?:chatops|egress|federation|share)(?:/|$)`, and `connectors` counted
   only for a value clause or a dynamic/require form), then the code with strings and comments stripped for
   the network tokens. Scope predicate: `relPath` starts with `packages/gateway/src/briefing/` or matches
   `packages/gateway/src/agents/_lib/briefing[\w.-]*\.ts`, not `*.test.ts`. Call it in the `binary-only`/`all`
   modes next to `checkWorkSnapshotConfinement`, with an `::error ...::D45 ...` line and `exit = 1`.
   Add `packages/gateway/src/briefing/briefing-runner.ts` and `packages/gateway/src/agents/_lib/briefing-build.ts`
   to `RULE_ANCHORS` (`:4476`) so a moved file fails loudly instead of passing over nothing.
3. Stated bounds (go in `docs/SECURITY-INVARIANTS.md`): a text scan of direct imports; an indirect path
   through an allowed module (`llm/`, `index/`) is not followed, and `synthesize.ts`, which the briefing
   imports, is itself no network path because no runner is ever passed (a source pin below). D45 is tied to
   no invariant; it makes OR-10-11 structural, not conventional.
4. A source pin in `security-invariants.test.ts` (new test in the I31/OR-10-8 neighbourhood): no file in
   scope contains `runner`, `SynthesisRunner`, `resolveForSynthesis` or `createLlm`; and `briefing-runner.ts`
   calls `synthesize(` with exactly one argument.
5. GREEN: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants`
   (clean on the real tree).

### Task 13 - Security-invariants pins, privacy and zero-egress

All in `security-invariants.test.ts` or the acceptance test, each red-proved:
1. **Zero egress rows:** with a real `egress_ledger` (the chain exists after `ensureSchema`), a briefing run
   (scheduled and manual), a deadline scan with candidates, and a scheduler tick leave `SELECT COUNT(*)
   FROM egress_ledger` unchanged AND call a replaced `globalThis.fetch` zero times.
2. **No indexed string reaches a toast or the event** (property test, spec section 7): seed 40 random
   sentinel strings (`NB_<random>`) into event titles/locations, incident and PR and ticket titles, mail
   subjects and senders, repository names, a branch, schedule and policy names, a milestone, a Slack
   channel name through the fake chat reader; run; assert no sentinel appears in any toast title/body, in the
   `briefing.ready` payload JSON, in `briefing_run.headline`, or in the deadline toast, and that at least
   10 sentinels DO appear in `markdown` (the control that proves the seeding reached the renderer).
3. **LAN and Tauri pins** from Task 10, **demo behaviour** from Task 10, **ALLOWED_METHODS 131**.
4. The OR-10-8 pin from Task 12 step 4.

### Task 14 - Acceptance test

`packages/gateway/test/integration/briefing/briefing.acceptance.test.ts` (the `test/` tree loads only in
the whole-repo run, so also run it alone). Real SQLite FILE, `LocalIndex.ensureSchema`, injected clock and
a recording `emit`/`toast`; `globalThis.fetch` replaced by a thrower after seeding (every assertion below
is local). Seeding runs the REAL writers:
- `pagerduty` syncable (fake HTTP as in `oncall-shifts.test.ts`): an active incident assigned to the self
  person (graph edge through the real populator or `person` + `regraph`), a resolved one, and the
  `/oncalls` shift with `is_me`; `jira` syncable: an assigned issue overdue and one due today (date-only
  `duedate`); `github` syncable: one `review_requested` PR, one authored PR with a matching `ci_run`;
  `linear` assigned issue with no due date; Gmail (`upsertGmailMessage`) one unread thread of two messages
  and one read; Outlook `upsertMessage` one `is_read: false`; the three calendar mappers one event each
  on the day (one declined, dropped), one overlapping pair.
1. **Seven sections:** with the clock at 2026-11-12 08:30 `Europe/London`, `enabled`, schedule `30 8 * * 1-5`,
   one scheduler tick yields exactly ONE `briefing_run` (`trigger schedule`, `status ok`, `slot_at` = the
   08:30 instant), whose markdown contains the seven section headings in config order, the expected rows and
   counts, `## Data freshness`, and (fake chat reader supplied) the unread Slack thread; a second and third
   tick do nothing; `briefing.ready` emitted once, toast once, `toast_outcome` stored.
2. **Gaps:** the same scenario with NO chat reader and no Slack `sync_state` row renders the chat `## Gaps`
   line and still 7 section blocks; with the iCloud row removed the calendar block still renders from the
   other two services.
3. **Deadline:** a GitHub milestone issue due in 23 h with `modified_at` 30 h old in the `assigned` snapshot,
   `[briefing.deadlines] enabled`, ten scans 15 min apart -> exactly one deadline toast, one `deadline_notice`
   row, text `1 open item due within 24 h with no recent activity`.
4. **On-call answer from the index:** `queryOncallNow(db, { term: "payment-service", serviceConfigs })`
   names the PagerDuty user with `fetch` thrown (the MB3 acceptance sentence; the briefing's On call line
   for the self shift is asserted in scenario 1).
5. **Catch-up and skip:** restart the scheduler at 10:29 (inside 3 h) -> one run; at 11:31 -> a `skipped`
   row, no toast.
6. **DST day:** Europe/London 2026-03-29 and 2026-10-25 fire the (non-gap) slot exactly once and the
   calendar block's "today" holds the 23 h / 25 h day's events.
7. **Retention:** a run older than `retention_days` is pruned by the next fire.
`bun test packages/gateway/test/integration/briefing/briefing.acceptance.test.ts`.

### Task 15 - Coverage and cleanup

- `audit:coverage-floor` is per file: 85% line and 80% branch for every new file, Linux-authoritative. No
  unreachable `??` defaults: where a value is already narrowed, index with a type guard or a `Map.get` plus an
  explicit branch the tests drive (memory: coverage-floor traps). `briefing-types.ts` and the sql file hold
  no executable branches. If Docker is available, `bun run verify:docker --full`; otherwise review each new
  file branch by branch against its test and say so in the PR.
- Biome (as `preflight:fast`), no `any` (external JSON is `unknown`, narrowed), no bare `.sort()`, every
  function under cognitive complexity 15 (Sonar S3776; `planFire`, `buildMorningBriefing` and `renderBriefing`
  split by SECTION, not by extracting a check).
- `git grep -n "Date.now()" packages/gateway/src/briefing packages/gateway/src/agents/_lib/briefing*` shows
  only the injection defaults in `briefing-runtime.ts` and `gateway-main.ts` (the brief and the scan take a
  clock).
- Cross-platform: no separators built; zones are parameters; every DST test names its zone and works on all
  three OSes. `bun run audit:cross-platform`.
- Windows: the scheduler test uses fake clocks only (no real 60 s waits; the PR Windows leg is ~13-18x slower).

## Docs to update in the same PR (the five core docs, every PR)

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains the MB5 sentence (the briefing
  and deadline notices, `[briefing]` and `[briefing.deadlines]`, schema V93, `briefing.*` IPC with 4
  renderer-callable reads, `nimbus briefing`, `briefing.ready` as a gateway event kind, D45, no new
  invariant, Phase 10 Morning briefing and Deadline tracking rows closed); `schema V91` -> `V93`
  (`audit:status-drift` compares with `CURRENT_SCHEMA_VERSION`: run it and fix every surface it names); the
  "Static complement" paragraph mentions D45 and the range `D10-D45`; the I7 sentence's count if it states
  one (127 -> 131).
- `docs/roadmap.md`: tick the **Morning briefing** and **Deadline tracking** rows `[x]` with the dated MB5
  summary and the corrections the code forced (deviations 1-17 in short form), the Calendar-is-not-a-deadline
  note, and the owner action that Google's `calendar.readonly` verification (MB2b) still gates non-test users;
  the Phase 10 acceptance bullets (`briefing delivered at the configured time`, `deadline 24 h away fires
  exactly one notification`, `oncall now names the person from the index`) cite the acceptance test.
- `docs/architecture.md`: `Schema V93` paragraph beside V91; a "Morning briefing" subsection (module map
  `briefing/` and `agents/_lib/briefing-*`, scheduler and `planFire` semantics incl. DST and catch-up,
  delivery order, privacy of toasts, the 18th brief kind and its reserved sections, the MB4 seam); the IPC
  method catalogue gains `briefing.*` with the LAN/Tauri/demo column; the gateway-events kind list gains
  `briefing.ready`; the static-rule paragraph gains D45.
- `docs/README.md`: the Phase 10 status paragraph gets the MB5 sentence.
- `docs/cli-reference.md`: `nimbus briefing [now|list|status] [--json]`, the `[briefing]` and
  `[briefing.deadlines]` key table (defaults and ranges), `nimbus doctor`'s new line, `nimbus tail`'s new
  event.
- `docs/CHANGELOG.md`: a dated entry in the existing style (what the owner gets; schema V93; the
  one-time-nothing behaviour of a first enable; the stated bounds from spec section 8 plus deviations 6, 7,
  10, 11, 12 and the DST-gap bound; no new invariant).
- `docs/SECURITY-INVARIANTS.md`: a D45 section (Statement, Wired at, Test, stated bounds), the header line
  that lists the rules tied to no invariant gains D45 and the range becomes `D10-D45`, and the I7 section's
  count paragraph gains "MB5 127 -> 131: `briefing.get|latest|list|status`; `briefing.runNow` is CLI-only";
  the I5 paragraph notes the `briefing` namespace entry.
- `docs/schema-reference.md`: the V93 `CREATE TABLE`s, indexes and trigger with a dated header.
- `.claude/commands/nimbus-db-migrations.md`, `nimbus-file-map.md`, `nimbus-ipc.md`, `nimbus-tauri-allowlist.md`
  (count 131 and the by-name rule), `nimbus-agent-patterns.md` (the briefing is a `_lib` brief with no
  `agents/` emitter file, and why): one line each; `audit:doc-refs` resolves every path they cite.
- The docs site: `packages/docs/src/content/docs/user-guide/` gains `morning-briefing.mdx` (enable it, the
  config keys, what the notification shows and does not, `nimbus briefing`, the bounds), added to the
  user-guide sidebar the way `workflows.mdx` is; `bun run docs:build` (or the repo's docs gate) must pass.

## Verification (run all; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules including `audit:invariants`, `audit:status-drift`,
   `audit:doc-refs`).
2. `bun test packages/gateway/src` (unit: store, scheduler, builder, config, IPC, D45 neighbours).
3. `bun test packages/gateway/test packages/cli` (integration and e2e trees; a `src` run does not load `test/`),
   plus the acceptance file on its own.
4. `bun test packages/gateway/src/security-invariants.test.ts` (whole file: the I5, I7, I31 totality and new
   pins), and `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`.
5. `cargo test` in `packages/ui/src-tauri` (`allowlist_exact_size` 131, `allowlist_is_alphabetized`,
   `allowlist_briefing_reads_only`).
6. `bun run typecheck` and `bun run typecheck:tests` (baseline must not grow).
7. `bun run audit:invariants`, `bun run audit:status-drift`, `bun run audit:lane-census -- --check`,
   `bun run audit:doc-refs`, `bun run audit:readme-cli`, `bun run audit:boundaries`, `bun run audit:dead-code`,
   `bun run audit:cross-platform`.
8. If Docker is available, `bun run verify:docker --changed` for the Linux-only class (its one known red
   exec-e2e is the harness, not this branch); before opening the PR re-check `git rev-parse --abbrev-ref HEAD`
   and run `bun run preflight` if time allows.

## PR

Title (conventional commit, no `!`; nothing here requires a user to act, a first enable is opt-in):

`feat(gateway): the morning briefing and 24-hour deadline notices, built from the local index and delivered locally`

Description: summary of what the owner gets, the 17 deviations (short), the stated bounds, verification output,
the dependency note (needs MB1, MB2b, MB3 merged; the MB4 seam and the migration-number rebase rule above),
and the owner action carried from MB2b (Google `calendar.readonly` verification). End with the attribution
lines from the session. No `Release-As:` trailer.
