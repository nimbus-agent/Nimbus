# Plan — Morning briefing MB1: "my open work" snapshots, due dates and read state

Spec: `docs/superpowers/specs/2026-11-11-morning-briefing.md` (approved, round 2): § 2 (owner rulings and
D-MB-1 / D-MB-3), § 4 (slices), § 5.0 and § 5.1 (MB1's design), §§ 6-8 (security, tests, bounds).
Roadmap rows: Phase 10 *Morning briefing* and *Deadline tracking*. MB1 is the data layer only: nothing
here renders, schedules or notifies (that is MB5), and MB1 adds no CLI command, IPC method, HITL type,
invariant or egress class.

After MB1: Jira, Linear and GitHub each keep a per-(service, relation) snapshot of the authenticated
user's open work in a new table `work_snapshot` (schema V91), refreshed at most once per
`[briefing] snapshot_interval_minutes`; GitHub issues carry `due_at_ms` and `milestone`; Outlook mail rows
carry `is_read`; iCloud event rows carry `start_ms`, `end_ms`, `all_day`, `organizer_email`,
`self_response` and `attendee_count`. `nimbus ask` can already use all of it through the index.

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right, the plan follows it. Where the code disagrees, the correction below is binding
for MB1, and the later slices it affects are named.

1. **Syncables have no "existing config view" (§ 5.1: "read by each syncable through its existing config
   view").** `SyncContext` (`sync/types.ts`) carries no config; syncables get configuration only as
   factory options (`createJiraSyncable({ ensureJiraMcpRunning })`; `ConnectorMeshSyncableOptions` in
   `platform/assemble-sync-registrations.ts` carries `pagerdutyMaxPagesPerSync` and `workdayConfig` from
   `platform/assemble.ts` ~1095). Correction: a new OPTIONAL option
   `snapshotIntervalMinutes?: () => number` on the three syncable option types, fed from one new optional
   field `briefingSnapshotIntervalMinutes` of `ConnectorMeshSyncableOptions`, which `assemble.ts` builds
   as a closure over `loadNimbusBriefingFromConfigDir(paths.configDir)`. A closure (not a value like
   `pagerdutyMaxPagesPerSync`) so an edited `nimbus.toml` applies on the next sync without a restart (the
   layered reader is mtime-cached). Optional so every existing test and caller compiles unchanged;
   absent means the 15-minute default.
2. **§ 5.3 says the Jira snapshot "already reads" the `/myself` accountId. It does not.** The Jira JQL is
   `assignee = currentUser()`, resolved by Jira; Linear's `viewer` and GitHub's `@me` are likewise
   resolved by the provider. MB1 makes no `/myself`, `viewer { id }` or `/user` call. Correction: nothing
   in MB1; **MB3 must make its own `GET /myself` for JSM `is_me`** (record this in the MB3 plan).
3. **GitHub has no "existing issue/PR mapper" over a list (§ 5.1).** `github-sync.ts` is the user-events
   feed only (`/users/{login}/events`, one page of 100, ETag). `upsertPr` is reusable as is: a Search
   hit has `number`, `title`, `body`, `html_url`, `state`, `draft`, `labels`, `user`, `created_at` and
   `updated_at`, and the head `branch` and the size stats are merged forward from the stored row by
   `mergeForwardPrStats` (the mechanism the events path already relies on). `upsertFromIssue` is private,
   has no milestone and is keyed `<repo>#issue-<n>`; MB1 extends it and exports its external-id helper.
   A Search item has no repo-name field: the repo is parsed from `repository_url`
   (`<restRoot>/repos/<owner>/<repo>`, which also holds on GHES).
4. **`REBODY_META_TARGETS` must NOT gain `github`/`issue` (§ 5.1 says register it).** Evidence:
   (a) `ipc/index-rebody-rpc.test.ts` "a github issue below version is NOT pending; a github pr below
   version is" pins the opposite; (b) the only writer of issue rows is the events feed (no issue list), so
   an old issue row can never be re-walked to the new `meta_v`, and a registered target would keep
   `pendingMeta` non-zero forever and make every no-argument `nimbus index rebody` re-run an outbound
   GitHub resync for nothing: the reasoning already recorded above `REBODY_META_TARGETS` for `ci_run`.
   Correction: the issue mapper still writes `meta_v: GITHUB_ISSUE_META_VERSION` (= 1) so a reader can
   tell a row with due-date depth from one that predates it; the constant is NOT in
   `REBODY_META_TARGETS`; a comment beside the table says why and a test pins it. Issues in a snapshot are
   refreshed by the snapshot itself within one interval, which is the recovery path. MB5 treats a missing
   `due_at_ms` as "no due date known".
5. **`REBODY_META_TARGETS` must NOT gain `apple`/`event` (§ 5.1 says register it); `outlook`/`email` IS
   registered.** Evidence: `apple-sync.ts` re-fetches the whole CalDAV window (default 90 days back, 365
   forward, `AppleCalConfig`) on EVERY 5-minute pass, so every event in the window reaches the new
   `meta_v` within one sync with no rebody; an event older than the window can never be re-walked, so a
   registered target would be pending forever (the item 4 trap), and `rebody` would clear the apple
   cursor, which is the IMAP mail cursor, and re-walk the mailbox for nothing. For Outlook the cursor
   reset (`nimbus-outl3:`) already relists the mailbox and `rebody`'s own action is clearing that cursor,
   so a registered `outlook`/`email` target is satisfiable (`outlook` is already in
   `REBODY_IMPROVABLE_SERVICES`; a message the delta never returns again stays pending, the same bound as
   the ticket targets). `EVENT_META_VERSION` is still exported and written.
6. **The iCloud parser cannot supply what § 5.1 needs.** `@nimbus-dev/sdk` 2.1.0 `parseICalendar` returns
   `ParsedEvent { uid, recurrenceId, summary, description, location, start, end, allDay, status,
   organizer, attendees: string[], rrule, dtstamp }`: `extractValue` keeps only the text after the first
   colon, so **TZID and every property parameter are dropped**; attendees are bare addresses, so
   **PARTSTAT is dropped** and no `self_response` is derivable; `DURATION` is not parsed. The SDK battery
   is `@moduleStability frozen` and lives in another repo, so MB1 does not change it. Correction: a
   gateway-local helper `connectors/_lib/ical-event-extras.ts` re-reads the SAME raw ICS (already in hand
   in `runCalendarPass`) and returns, per VEVENT keyed `<uid>` or `<uid>:<recurrence-id>`,
   `{ startTzid, endTzid, durationMs, partstatByAddress }`. CalDAV is requested with `expand: true`, whose
   instances come back in UTC, so TZID matters mainly for a non-expanded floating event; the resolution
   rule stays as the spec says (TZID, else the gateway zone; all-day = midnight in that zone).
7. **The normalized iCloud keys are not all new (§ 5.1 lists four).** D-MB-3 names `all_day` and
   `organizer_email`, but the iCloud mapper writes `allDay` and `organizer`. Correction: MB1 also writes
   `all_day` and `organizer_email` (raw keys stay for existing readers). `status` stays the raw iCal value
   (`CONFIRMED`, upper case; Google's will be lower case): MB5 compares case-insensitively; MB1 does not
   rewrite a key readers already use.
8. **"Truncated" is ambiguous against the stated caps (§ 5.1 versus § 8).** A snapshot's "failed or
   truncated fetch leaves the previous snapshot", yet GitHub's stated cap is one page of 100 and
   Jira/Linear's is 3 pages of 100. Correction, two outcomes: **partial** = a request failed, a page did
   not parse, a later page errored, or GitHub returned `incomplete_results: true` (previous snapshot kept,
   `snapshot_partial: true` logged); **capped** = every request succeeded and the provider reports more
   than the cap (the capped set REPLACES the snapshot, `snapshot_capped: true` logged with the provider's
   total). Cap order puts the most urgent first: Jira `ORDER BY duedate ASC`, Linear `orderBy: updatedAt`,
   GitHub `sort=updated&order=desc`.
9. **The static D24 extension cannot literally be "only `sync-capabilities.ts` writes the table" (§ 5.0).**
   Every capability that touches a table delegates its SQL to a store (`writeObsidianVault` →
   `index/obsidian-notes-store.ts`), `dbRun` is the I14 route, and the V91 DDL with its trigger is
   necessarily another file. Correction: the new rule `work-snapshot-confined` allows a WRITE verb on
   `work_snapshot` only in `index/work-snapshot-store.ts` and the DDL file `index/work-snapshot-v91-sql.ts`,
   and lets the store's write function (`replaceWorkSnapshotRows`) be NAMED only by the store and
   `sync/sync-capabilities.ts`; reads of the table are unrestricted (MB5 reads it). The effect is the
   spec's: no syncable, agent, RPC or other store writes a snapshot.
10. **A scoping hole the spec does not mention.** `buildLocalOnlySyncCapabilities` builds its db members
    with `buildSyncCapabilities(deps, "github")`, so a local-only syncable (`obsidian`, `filesystem`,
    `blame`, `openapi`) would inherit a `replaceWorkSnapshot` bound to `github`. Correction: the local-only
    set overrides it with a refusal, and `buildSyncCapabilities` itself refuses any service other than
    `jira`, `linear` and `github` (an extension syncable is built through the same function).
11. **Where "at most once per interval" is persisted is unspecified.** Correction: a cursor field. Each of
    the three syncs already owns a JSON cursor that survives restarts and is cleared by
    `nimbus index rebody` (which therefore forces a snapshot, the right behaviour). The field is `snapAt`
    (epoch ms of the last ATTEMPT, success or failure, so a failing provider is retried once per interval
    and not once per 60 s sync). `MAX(captured_at)` from the table would not work: an empty relation writes
    no row and would re-query every sync.
12. **`null` versus omission.** § 5.1 says GitHub `due_at_ms` is `null` without a milestone or due date.
    Jira and Linear omit the key (`putIfDefined`, `ticket-depth.ts`: "omission over guessing") and the
    briefing's `json_extract` reads both as NULL. Correction: omit, so all three services share one
    contract. Same for `milestone`.

Spec claims verified correct (no deviation): the next migration is V91 (`CURRENT_SCHEMA_VERSION` = 90 at
`index/local-index.ts:289`); the Outlook `CURSOR_PREFIX` is `nimbus-outl2:` and
`decodeMicrosoftGraphDeltaCursor` returns `undefined` on a prefix mismatch so the sync falls to the initial
`$select` URL; Jira already requests `duedate` and writes `due_at_ms` and `status_category`
(`jiraDepthMetadata`); Linear already requests `dueDate` and writes the same keys (`linearDepthMetadata`);
the item upsert is `ON CONFLICT(id) DO UPDATE` (`index/item-store.ts:117`), so a re-upsert never fires an
`AFTER DELETE ON item` trigger; the limiter keys `github`, `jira`, `linear` exist (`sync/rate-limiter.ts`);
no new host is contacted (Atlassian, Linear, GitHub and Graph are what the syncs already call).

Risk noted, not a deviation: Jira's snapshot reuses `jiraFetchSearchPage`, which POSTs
`/rest/api/3/search`. Atlassian has announced token-paginated `/search/jql` as its replacement; the
snapshot inherits whatever the incremental sync does, and migrating both is a separate change.

## Design decisions

- **Capability, one transaction, service from the closure.** `replaceWorkSnapshot(relation, externalIds)`
  returns `{ stored, dropped }`. It resolves each external id with
  `SELECT id FROM item WHERE service = ? AND external_id = ?` (bound; `service` is the closure's), deletes
  the (service, relation) set, inserts the resolved ids with one `captured_at`, all inside
  `db.transaction`. It refuses more than 1,000 ids (a bug guard, far above the caps).
- **Order of operations in a syncable** (the same shape in each): fetch pages and `ctx.upsertItem` every
  member (`ctx.writeBatch` per page); only after the whole query succeeded call `ctx.replaceWorkSnapshot`;
  the snapshot step is wrapped so nothing it throws, a `RateLimitError` or `UnauthenticatedError`
  included, fails the incremental sync that already succeeded.
- **One shared helper** `connectors/_lib/work-snapshot-run.ts` holds the pure interval test, the
  partial/capped outcome type and the "replace or keep" step, so the three syncables differ only in how
  they fetch. Keep each function under cognitive complexity 15 (Sonar S3776).
- **Config home.** `config/briefing-toml.ts` with a `[briefing]` section holding ONLY
  `snapshot_interval_minutes` for now (MB5 adds the other keys to the same file and type). An out-of-range
  or non-integer value is a section fallback to the default (15) recorded through
  `sectionFallbackSink(configDir, "briefing")`, as `session-toml.ts` does; it never clamps. The section is
  registered in `SECTION_LOADERS` (`config/config-explain.ts`), which `config-explain.test.ts` requires of
  every section id a loader records a fallback under. (`oncall-push-toml.ts`, which the spec cites as the
  template, silently ignores a bad value; the `session-toml.ts` pattern is the one that reports it.)
- **Time-zone helper.** `connectors/_lib/zoned-time.ts` converts a wall time (with seconds) in an IANA
  zone to an instant. It does not reuse `automation/cron.ts` `instantOf` (private, minute resolution,
  returns `undefined` in a DST gap); a nonexistent local time resolves with the offset in force before
  the gap (RFC 5545 section 3.3.5). Other Phase 10 slices edit `cron.ts`; leaving it alone avoids a
  merge conflict. MB5 may export `instantOf` for its own use.
- **No model, no egress, no new request class.** Every new request is an existing sync-class fetch under
  the run's existing I29 `sync` ledger row (spec § 6). No invariant is added or retired; static D24 gains
  the one rule above.

## File map

New:
- `packages/gateway/src/index/work-snapshot-v91-sql.ts`
- `packages/gateway/src/index/work-snapshot-store.ts` (+ `.test.ts`)
- `packages/gateway/src/index/migrations/runner-v91.test.ts`
- `packages/gateway/src/config/briefing-toml.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/_lib/work-snapshot-run.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/_lib/ical-event-extras.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/_lib/zoned-time.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/github-issue-meta.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/outlook-mail-meta.ts` (constants only)
- `packages/gateway/test/integration/briefing/work-snapshot.test.ts`

Modified: `index/migrations/runner.ts`, `index/local-index.ts`, `sync/sync-capabilities.ts` (+ test),
`connectors/connector-sync-test-helpers.ts`, `connectors/{jira,linear,github,outlook,apple}-sync.ts`,
`connectors/apple-event-mapping.ts` (+ their tests), `ipc/index-rebody-rpc.ts` (+ test),
`config/config-explain.ts`, `platform/assemble-sync-registrations.ts`, `platform/assemble.ts`,
`scripts/structure-audit/check-nimbus-invariants.ts` (+ test), and the docs listed at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. Work in a fresh worktree from current `main`:
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-mb1 -b dev/asaf/p10-mb1 main`
   (absolute path, never nested). Verify `git rev-parse --abbrev-ref HEAD` before every commit.
2. `bun install` in the worktree and build the sandbox helper if a sandbox test is later run (a fresh
   worktree has neither). Editor diagnostics in a fresh worktree are stale: trust `bun run typecheck`.
3. Re-read `CURRENT_SCHEMA_VERSION` in `index/local-index.ts`. The plan assumes 90 and a free V91; if
   another Phase 10 slice merged first, renumber (the spec says numbers follow merge order) and update
   every `V91`/`91` below, file names included.

### Task 1 - Schema V91 `work_snapshot`

Files: `index/work-snapshot-v91-sql.ts` (new), `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner-v91.test.ts` (new).

1. Write `runner-v91.test.ts` first, modeled on `runner-v90.test.ts`:
   - a V90 database gains an empty `work_snapshot`; `PRAGMA user_version` is 91; `CURRENT_SCHEMA_VERSION`
     equals `maxRegisteredIndexedSchemaVersion()`;
   - the `relation` CHECK refuses `'bogus'` and accepts the three values; the primary key refuses a
     duplicate (service, relation, item_id);
   - the trigger: insert an `item` row and a `work_snapshot` row for it, `DELETE FROM item WHERE id = ?`,
     the snapshot row is gone while another item's row stays; `DELETE FROM item WHERE service = ?` (the
     `deleteAllItemsForService` shape) clears all of that service's rows;
   - re-running the step is idempotent (`IF NOT EXISTS` everywhere).
   Run `bun test packages/gateway/src/index/migrations/runner-v91.test.ts`: expected RED (no table).
2. `work-snapshot-v91-sql.ts` exports `WORK_SNAPSHOT_V91_SQL` (an array, one statement per element, as
   V90):
   ```sql
   CREATE TABLE IF NOT EXISTS work_snapshot (
     service TEXT NOT NULL,
     relation TEXT NOT NULL CHECK (relation IN ('assigned','review_requested','authored_open')),
     item_id TEXT NOT NULL,
     captured_at INTEGER NOT NULL,
     PRIMARY KEY (service, relation, item_id)
   );
   CREATE INDEX IF NOT EXISTS work_snapshot_item ON work_snapshot (item_id);
   CREATE TRIGGER IF NOT EXISTS work_snapshot_item_delete AFTER DELETE ON item
   BEGIN DELETE FROM work_snapshot WHERE item_id = OLD.id; END;
   ```
   Header comment: the store is the only writer (static D24 rule), no backfill because no snapshot
   existed before this version, `item` is not an FK parent here so the trigger is the cascade.
3. `runner.ts`: import it and add
   `simpleStep(90, 91, "my open work snapshots (Phase 10 MB1)", WORK_SNAPSHOT_V91_SQL)`;
   `local-index.ts`: `CURRENT_SCHEMA_VERSION = 91`.
4. Re-run the test: GREEN. Also run `bun test packages/gateway/src/index` (other migration tests and
   `local-index.test.ts` build a database to `CURRENT_SCHEMA_VERSION`).
5. `git grep -n "schema V90\|user_version: 90"`: no test hard-codes 90 at plan time; the docs are
   covered by `audit:status-drift` (see the docs section).

### Task 2 - The store `index/work-snapshot-store.ts`

1. Tests first (`work-snapshot-store.test.ts`, real SQLite via `openMemoryIndexDatabase`): replace stores
   only resolvable ids and returns `{stored, dropped}`; a second call REPLACES (old members gone, other
   relations and other services untouched); an empty id list clears the set; the same external id twice
   stores one row; a service outside `jira|linear|github` and a relation outside the three throw; more
   than 1,000 ids throws; a failure mid-way (a relation cast through `unknown` in the test only, to hit
   the CHECK) leaves the previous set intact (transaction). A reader `listWorkSnapshot(db, service,
   relation)` (read-only, returns `{itemId, capturedAt}`) is exported for tests and for MB5.
2. Implement: `export type WorkSnapshotRelation`, `WORK_SNAPSHOT_SERVICES`,
   `replaceWorkSnapshotRows(db, service, relation, externalIds, nowMs)`, `listWorkSnapshot`. Writes only
   through `dbRun`/`dbStmtRun` (I14, static D12), bound parameters (I9), `db.transaction`. Any ordering
   uses a code-unit comparator (Sonar S2871: no bare `.sort()`).
3. GREEN: `bun test packages/gateway/src/index/work-snapshot-store.test.ts`.

### Task 3 - The capability `replaceWorkSnapshot`

Files: `sync/sync-capabilities.ts`, `sync/sync-capabilities.test.ts`,
`connectors/connector-sync-test-helpers.ts`.

1. Tests first in `sync-capabilities.test.ts`:
   - the pinned key list (the "exposes no raw handle" test, line ~63) gains `"replaceWorkSnapshot"`;
   - **scoping:** a capability built for `jira` replaces only `jira` rows: seed `github` and `linear`
     snapshot rows, call it, assert theirs are untouched; an external id that exists only under `github`
     resolves to nothing (dropped) through the `jira` capability;
   - a capability built for `slack` (any service outside the three) throws a named error naming the
     service when `replaceWorkSnapshot` is called;
   - `unboundSyncCapabilities()` throws `^replaceWorkSnapshot was called on an unbound SyncContext` (the
     existing loop over all members asserts it once the member exists);
   - `buildLocalOnlySyncCapabilities(deps, "obsidian").replaceWorkSnapshot(...)` throws a message saying
     the syncable is local-only (deviation 10); the existing "local-only gets db capabilities but no
     credentials" test still passes.
   RED first (member missing).
2. `SyncCapabilities` interface: add
   ```ts
   /** Replaces this service's snapshot of one relation (V91). Bound to the calling service. */
   replaceWorkSnapshot(
     relation: WorkSnapshotRelation,
     externalIds: readonly string[],
   ): { stored: number; dropped: number };
   ```
   with a doc comment stating: scoped to the bound service, the service is never a parameter, one
   transaction, only `jira|linear|github`. `buildSyncCapabilities`: implement via
   `replaceWorkSnapshotRows(deps.db, serviceId, relation, externalIds, Date.now())`.
   `unboundSyncCapabilities`: add the `refuse` line. `buildLocalOnlySyncCapabilities`: override with
   `replaceWorkSnapshot: () => noCredentials("replaceWorkSnapshot")` and make that message say
   "local-only syncable" (the existing regex).
3. Find every other implementer and fix it. A `git grep` for `pruneBlameForFile` found, at plan time:
   `connectors/connector-sync-test-helpers.ts` (the `Pick<SyncContext, ...>` list in
   `silentSyncContextExtras` names every capability: add `"replaceWorkSnapshot"`);
   `testing/bun-test-support.ts` (builds through `buildSyncCapabilities`/`unbound...`: nothing to add);
   `platform/assemble.ts:3927`, `security-invariants.test.ts` ~4996 and ~6952 (spread
   `unboundSyncCapabilities()`: nothing to add). `bun run typecheck` and `bun run typecheck:tests` are the
   census: any other literal typed as `SyncCapabilities` fails to compile.
4. GREEN: `bun test packages/gateway/src/sync`.

### Task 4 - Static D24 extension (`work-snapshot-confined`)

Files: `scripts/structure-audit/check-nimbus-invariants.ts` and its `.test.ts`.

1. How D24 works today: `checkSyncContextNoRawHandles(files)` (line ~893) text-scans non-test files under
   `packages/gateway/src/connectors/` (not `lazy-mesh/`) for `ctx.vault`/`ctx.db`, with a two-file
   allow-list, and runs in the `binary-only`/`all` modes (~4726). Do not widen that function; add a
   sibling `checkWorkSnapshotConfinement(files)` in the style of `checkStandingApprovals` (D44) and call
   it next to it in the same modes, with an `::error ...::D24 work_snapshot written outside its store`
   line, and `exit = 1` on any violation.
2. Tests first in `check-nimbus-invariants.test.ts`, a new `describe("D24 - work_snapshot is written only
   by the capability's store", ...)` in the shape of the D44 block (a `GOOD` fixture set plus
   single-violation swaps; assert on the set of rule ids):
   - GOOD: the store file containing `INSERT INTO work_snapshot` / `DELETE FROM work_snapshot` and
     `export function replaceWorkSnapshotRows`; the DDL file containing `CREATE TABLE ... work_snapshot`
     and `DELETE FROM work_snapshot` in the trigger; `sync/sync-capabilities.ts` calling
     `replaceWorkSnapshotRows(`; a reader (`SELECT ... FROM work_snapshot`) in `agents/_lib/x.ts`; the
     control `checkWorkSnapshotConfinement(GOOD)` is `[]`.
   - Violations, each its own test asserting exactly `work-snapshot-confined`: a syncable under
     `connectors/` with `dbRun(db, "INSERT INTO work_snapshot ...")`; an RPC file with `DELETE FROM
     work_snapshot`; `UPDATE work_snapshot`; `INSERT OR REPLACE INTO work_snapshot`; `DROP TABLE
     work_snapshot`; a syncable naming `replaceWorkSnapshotRows`; the quoted and bracketed forms of a
     write verb. The SQL IS a string literal, so scan comment-stripped source with strings kept (as D44
     does for table names), not literal-stripped. Non-violations: the word in a comment; `FROM
     work_snapshot` / `JOIN work_snapshot` reads; test files (skipped).
   - A real-repo test (like "no syncable in the real repository reaches a handle") feeding
     `iterateSourceFiles()` to the checker and expecting `[]`.
   RED first (function missing).
3. Implement with constants `D24_WS_STORE`, `D24_WS_DDL`, `D24_WS_CAPABILITY` (the three repo-relative
   paths above). Write-verb regex over comment-stripped text, built with `String.raw` and `new RegExp`
   like the existing D24 pattern (its comment records an earlier backspace-byte accident, so red-prove
   that the rule fires on the planted violations):
   `\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE)\s+["'`\[]?work_snapshot\b`
   (case-insensitive). Name rule: `\breplaceWorkSnapshotRows\b`, allowed in store + capability only.
   Stated bound for the docs: a dynamically composed table name evades a text scan (as D33(b) says);
   confinement of the capability is the real defense.
4. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` GREEN; `bun run audit:invariants`
   GREEN on the real tree.

### Task 5 - Config `[briefing] snapshot_interval_minutes` and the option plumbing

1. `config/briefing-toml.test.ts` first: default 15 with no file and no section;
   `[briefing] snapshot_interval_minutes = 30` reads 30; `5` and `240` accepted; `4`, `241`, `0`, `-1`,
   `abc`, `1.5`, `"15"` fall back to 15 AND call the fallback sink with a message naming the key; a key in
   another section is ignored; an inline `# comment` is stripped; CRLF; `[briefing.deadlines]` (MB5's
   nested table) does not leak keys into `[briefing]`; unknown `[briefing]` keys are ignored (MB5 adds
   them).
2. `config/briefing-toml.ts`: `export type NimbusBriefingToml = { readonly snapshotIntervalMinutes:
   number }`, `DEFAULT_BRIEFING_CONFIG`, `parseNimbusTomlBriefing(source, onFallback?)` (primitives from
   `toml-primitives.ts`: `isTableHeader`, `parseIntDec`, `splitKeyValue`, `stripComment`),
   `loadNimbusBriefingFromConfigDir(configDir)` over `layeredConfigText` with
   `sectionFallbackSink(configDir, "briefing")`. Header comment says MB5 adds the other keys here.
3. `config/config-explain.ts`: add `briefing: loadNimbusBriefingFromConfigDir` to `SECTION_LOADERS` (keep
   alphabetical). `config-explain.test.ts` ("SECTION_LOADERS has a key for every section id...") goes red
   until it is added; add a test that `probeSection` on an out-of-range value reports the fallback.
4. Plumbing: `platform/assemble-sync-registrations.ts` `ConnectorMeshSyncableOptions` gains
   `briefingSnapshotIntervalMinutes?: () => number`; pass it as `snapshotIntervalMinutes` into
   `createJiraSyncable`, `createLinearSyncable`, `createGithubSyncable`. `platform/assemble.ts` (~1095)
   supplies `() => loadNimbusBriefingFromConfigDir(paths.configDir).snapshotIntervalMinutes`.
   `assemble-sync-registrations.test.ts` already calls `registerConnectorMeshSyncables` and needs no
   change (the field is optional); the option is exercised in Tasks 7-9.

### Task 6 - Shared helper `connectors/_lib/work-snapshot-run.ts`

1. Tests first (pure, no db): `snapshotDue(null, now, interval)` true; `now - last >= interval` true;
   `< interval` false; `last > now` (clock moved back) true. `snapshotIntervalMs(minutes?)` maps
   `undefined` to 15 min and passes a config value through (already validated 5..240). An outcome type
   `SnapshotFetch = { kind: "complete"; externalIds: string[]; capped: boolean; total?: number } |
   { kind: "partial"; reason: string }`. `applySnapshot(ctx, service, relation, fetch)`: on `complete`
   calls `ctx.replaceWorkSnapshot` and logs `info` `{service, relation, stored, dropped, capped}`; on
   `partial` calls nothing and logs `warn` `{service, relation, snapshot_partial: true, reason}`; if the
   fetch function THROWS it is caught and logged as `partial` (reason = the error message truncated to
   200 characters, never a token or a URL query), so a `RateLimitError` or 401 never escapes. Test all
   four with a recording fake ctx (`logger` spy, `replaceWorkSnapshot` spy).
2. Implement; GREEN.

### Task 7 - Jira

Files: `connectors/jira-sync.ts` (+ `jira-sync.test.ts` / `jira-sync.coverage.test.ts`).

1. Tests first (real SQLite + fake `fetch`, the patterns already in `jira-sync.test.ts`; fixtures are
   produced by running the real mapper through `sync` and reading `item`/`work_snapshot`, never
   hand-written rows):
   - a first sync (cursor null) issues the incremental search AND the snapshot search; the snapshot
     request body has `jql` exactly `assignee = currentUser() AND statusCategory != Done ORDER BY duedate
     ASC`, `maxResults: 100`, `startAt: 0`, and the same `fields` list as the incremental request (assert
     both bodies' `fields` are equal);
   - the response issues become `item` rows (type `issue`, `metadata.due_at_ms` for one with a `duedate`)
     and `work_snapshot` rows `('jira','assigned',…)` for exactly those keys;
   - a second sync inside the interval (cursor from the first, clock advanced less than the interval)
     makes NO snapshot request; after the interval it makes one (inject the interval through
     `createJiraSyncable({..., snapshotIntervalMinutes: () => 5})` and drive the clock by building the
     cursor with an old `snapAt`);
   - a stale member leaves: the second snapshot omits issue A, `work_snapshot` loses A, the `item` row for
     A STAYS;
   - failure keeps the old snapshot: the snapshot request returns 500, invalid JSON, or fails on page 2:
     `work_snapshot` unchanged, the incremental `SyncResult` still a success, a `warn` with
     `snapshot_partial: true` logged, and the cursor's `snapAt` still advanced (one retry per interval);
   - a 429 on the snapshot call penalises the `jira` limiter but does not throw out of `sync`;
   - paging: 3 pages of 100 with `total` 450 stores 300, logs `snapshot_capped`, and a 4th page is never
     requested;
   - an old cursor (`{v:1, floorJql}` without `snapAt`) decodes and triggers a snapshot; `decodeCursor`
     round-trips `snapAt`;
   - each snapshot request is preceded by `rateLimiter.acquire("jira")`.
   RED first.
2. Implement: `JiraSyncCursorV1 = { v: 1; floorJql: string | null; snapAt?: number }` (decode accepts
   absent or a finite number; every `encodeCursor` call carries the value); a constant
   `JIRA_SNAPSHOT_JQL`; `jiraSnapshotAssigned(ctx, creds, syncTime)` pages
   `jiraFetchSearchPage({ctx, creds, jql, startAt, pageSize: 100})` up to 3 times, calls
   `jiraIndexOneIssue` with a throwaway `maxUpdatedIso`, collects each issue `key` (give
   `jiraIndexOneIssue` a sibling that returns the key, keeping its boolean callers), reuses
   `jiraShouldStopPaging`, returns a `SnapshotFetch`. In `sync()`, after the incremental loop and before
   the cursor is built, run it when `snapshotDue(prev?.snapAt ?? null, Date.now(),
   snapshotIntervalMs(options.snapshotIntervalMinutes?.()))`. `itemsUpserted` stays the incremental count
   (snapshot upserts are not added; they would double-count rows the incremental pass also wrote).
3. GREEN: `bun test packages/gateway/src/connectors/jira-sync`.

### Task 8 - Linear

Files: `connectors/linear-sync.ts` (+ `linear-sync.test.ts`).

1. Tests first, same shape as Task 7: the snapshot request is a GraphQL POST whose query contains
   `viewer` and `assignedIssues(first: 100`, a `filter` with `state: { type: { nin: ["completed",
   "canceled"] } }` and `orderBy: updatedAt`, and selects the SAME issue fields as `SYNC_QUERY` (factor
   the field list into one shared constant `ISSUE_FIELDS` used by both queries, and assert both queries
   embed it); nodes are mapped by the existing `linearUpsertSingleIssue` (assert `due_at_ms`,
   `status_category`, `meta_v`); `work_snapshot` rows `('linear','assigned',identifier)`; interval gating
   through the cursor field `snapAt`; partial (GraphQL `errors`, HTTP 500, page 2 failing) keeps the old
   snapshot; the cap at 3 pages / 300 with `hasNextPage` still true is logged as capped; a 429 does not
   throw out of `sync` (`linearRequireIssuesData` throws a plain `Error` after `penalise`; the helper
   catches it); an old `{since}` cursor decodes and triggers a snapshot; the incremental `since` value is
   unaffected by snapshot upserts (a snapshot node with an old `updatedAt` must not move `maxUpdated`).
2. Implement: `LinearSyncCursorV1 = { since: string; snapAt?: number }` (decoder keeps `since` and an
   optional finite `snapAt`; encode carries both); `SNAPSHOT_QUERY` using `ISSUE_FIELDS` and the shape
   `viewer { assignedIssues(...) { nodes {...} pageInfo {...} } }`; a snapshot page parser separate from
   `SyncPage` (the envelope differs: `data.viewer.assignedIssues`); reuse `linearUpsertIssueNodes` and
   collect `identifier`s; `await ctx.rateLimiter.acquire("linear")` before each page.
3. GREEN.

### Task 9 - GitHub

Files: `connectors/github-issue-meta.ts` (new), `connectors/github-sync.ts` (+ tests).

1. `github-issue-meta.test.ts` first: `githubIssueDepthMetadata(issue)` returns `{ meta_v: 1 }` for an
   issue with `milestone: null`; with `milestone: { title: "v2", due_on: "2026-11-20T08:00:00Z" }` returns
   `due_at_ms: Date.parse(...)` and `milestone: "v2"`; a milestone with `due_on: null` gives `milestone`
   only; a non-string title or unparseable `due_on` is omitted; `GITHUB_ISSUE_META_VERSION` is 1;
   `repoFullFromRepositoryUrl` parses `https://api.github.com/repos/o/r` and
   `https://ghe.example.com/api/v3/repos/o/r`, and returns `undefined` for anything else (no `/repos/`
   segment, extra segments, empty parts). Implement it (reuse `msFromIso` from `ticket-depth.ts`).
2. `github-sync` tests first (fake `fetch` returning Search JSON; fixtures in the style of
   `github-sync.test.ts`):
   - the sync issues exactly three searches after the events call, URLs `<restRoot>/search/issues?q=`
     with the decoded `q` equal to `is:open is:issue assignee:@me`, `is:open is:pr review-requested:@me`,
     `is:open is:pr author:@me`, each with `per_page=100&sort=updated&order=desc`, each preceded by
     `rateLimiter.acquire("github")`, each sent only to the instance's own origin (see
     `github-sync-ghes.test.ts` for the pattern: against a GHES base the search goes to that base's
     `restRoot`, never `api.github.com`);
   - issue hits become `issue` rows `<repo>#issue-<n>` with `metadata.meta_v` 1 and, for a milestone,
     `due_at_ms` and `milestone`; PR hits go through `upsertPr` (row type `pr`, `<repo>#<n>`, `meta_v` 3
     from `PR_META_VERSION`); snapshot rows land under `assigned`, `review_requested` and
     `authored_open`; a PR in both PR searches is in both relations;
   - the 304 path (events unchanged) STILL runs the snapshot when due (restructure the two return paths
     so both carry `snapAt`) and does not run it inside the interval;
   - `incomplete_results: true`, a non-200 or invalid JSON keeps that relation's old snapshot while the
     other relations still replace (relations are independent); an item with an unparseable
     `repository_url` is skipped and counted, not partial; `total_count` 340 with 100 items is capped,
     not partial;
   - a 403 with `x-ratelimit-remaining: 0` on a search penalises `github` and does not fail the sync
     (`throwGithubRateLimitErrorIfApplicable(ctx, res, "search")` throws; the helper catches);
   - a stored `api_base` that no longer validates makes no search request (`readGithubPair` returns
     `null` before any call; assert zero fetches);
   - the cursor round-trips `snapAt`, and an old `{etag, login}` cursor decodes;
   - the events-feed path still writes issue rows, now with `meta_v` and the milestone keys; a
     pre-existing test that deep-equals issue metadata is updated for the new keys.
   RED first.
3. Implement: `GithubSyncCursorV1` gains `snapAt: number | null` (decoder and BOTH `encodeCursor` call
   sites carry it); `upsertFromIssue` adds `...githubIssueDepthMetadata(issue)` and its external id comes
   from an exported `githubIssueExternalId(repoFull, num)`; a `githubSnapshotSearch(ctx, pat, base, q)`
   that `acquire`s, does one `fetchSameOriginOnly` GET with `buildGithubEventHeaders(pat, null)`, checks
   status with `throwGithubRateLimitErrorIfApplicable`, parses `{ total_count, incomplete_results, items
   }` defensively (`asRecord`), upserts each item by kind (a `pull_request` key means PR) and returns a
   `SnapshotFetch`; `runGithubSnapshots(ctx, pat, base, prevSnapAt, intervalMs)` returns the new `snapAt`
   (= now when an attempt was made, else the previous value) and is called from `syncGithubUserEvents` on
   the 304 path and on the 200 path, after the enrichment passes.
4. GREEN: `bun test packages/gateway/src/connectors/github-sync`.

### Task 10 - Outlook `isRead` and cursor `nimbus-outl3:`

Files: `connectors/outlook-mail-meta.ts` (new: `export const OUTLOOK_MAIL_META_VERSION = 1`),
`connectors/outlook-sync.ts`, `outlook-sync.test.ts`.

1. Tests first: the codec test expects `"nimbus-outl3:"`; a new test mirrors the existing "a pre-upgrade
   outl1 cursor is ignored" test for a hand-built `nimbus-outl2:` cursor: the sync falls through to the
   initial `/me/messages/delta` URL, whose decoded `$select` is exactly
   `id,subject,bodyPreview,body,receivedDateTime,lastModifiedDateTime,webLink,from,isRead`; a message
   with `isRead: true` and one with `isRead: false` index `metadata.is_read` true / false and
   `metadata.meta_v` 1 (read back from SQLite through the real `upsertMessage`, not a hand row); a
   message with no boolean `isRead` writes NEITHER `is_read` nor `meta_v` (omission over guessing, and
   the row stays pending for rebody); a later delta page that re-reports a message with `isRead` flipped
   updates the row.
2. Implement: `CURSOR_PREFIX = "nimbus-outl3:"` with the comment extended in place (the history of the
   `outl1` → `outl2` → `outl3` moves and why a bump is needed: a stored delta link keeps the projection
   that minted it); `GraphMessage.isRead?: boolean`; `$select` gains `isRead`; metadata
   `{ receivedDateTime, ...(typeof m.isRead === "boolean" ? { is_read: m.isRead, meta_v:
   OUTLOOK_MAIL_META_VERSION } : {}) }`.
3. Comment at the constant: MB2b's decoder must accept `nimbus-outl3:` as a mail-only cursor so mail is
   not reset twice (already in the spec).
4. GREEN.

### Task 11 - iCloud events: normalized keys

Files: `connectors/_lib/zoned-time.ts`, `connectors/_lib/ical-event-extras.ts`,
`connectors/apple-event-mapping.ts`, `connectors/apple-sync.ts` (+ tests).

1. `zoned-time.test.ts` first: `wallToInstantMs({y,mo,d,h,mi,s}, "Europe/London")` in summer and winter;
   `America/New_York` on the spring-forward day with a nonexistent 02:30 resolves with the pre-gap offset
   (assert the exact epoch); the fall-back repeated hour resolves to the first occurrence; `UTC`; an
   invalid zone name returns `undefined` (the caller falls back to the gateway zone). The zone is a
   parameter, never read inside the pure function, so the test is deterministic on every CI OS.
2. `ical-event-extras.test.ts` first, with real ICS strings in the shapes `apple-sync` receives (CRLF,
   folded lines): `DTSTART;TZID=Europe/London:20261111T093000` with its `DTEND;TZID=...`,
   `DTSTART;VALUE=DATE:`, `DTSTART:20261111T093000Z`, a floating `DTSTART:20261111T093000`,
   `DURATION:PT1H30M` and `P1D`, `ATTENDEE;CN="Last, First";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:me@icloud.com`
   (a quoted parameter holding a colon and a comma must not break parsing), two VEVENTs (a master plus a
   `RECURRENCE-ID` override) keyed `<uid>` and `<uid>:<recurrence-id>`; an unknown `PARTSTAT` is ignored;
   malformed lines are skipped, never thrown (the SDK parser's contract). Implement
   `parseIcalEventExtras(ics): ReadonlyMap<string, IcalEventExtras>` with its own unfold (CRLF followed
   by a space or tab), a parameter parser that honors double quotes, and case-insensitive property names.
3. `apple-event-mapping.test.ts` first (extend the existing file): the mapper takes
   `ctx: { calendar, syncedAt, selfEmail?: string, extras?: IcalEventExtras, zone?: string }` (new
   members optional, so existing calls compile) and for a UTC timed event writes `start_ms`, `end_ms`,
   `all_day: false`, `organizer_email`, `attendee_count`, `self_response` and
   `meta_v: EVENT_META_VERSION`; a TZID event converts through its zone; a floating event uses `ctx.zone`
   (default the machine zone, injected in the test); an all-day event: `start_ms` = midnight of the
   DTSTART date in the zone, `end_ms` = midnight of the (exclusive) DTEND date, or +1 day when DTEND is
   absent; a timed event with neither DTEND nor DURATION: `end_ms` = `start_ms`; `DURATION` adds;
   `self_response` is the PARTSTAT (lower-cased: `accepted|declined|tentative|needs-action`) of the
   attendee whose address equals `selfEmail` case-insensitively, else `null`; `attendee_count` is
   `ev.attendees.length`; the raw `start`, `end`, `allDay`, `organizer`, `status` keys are unchanged; an
   unparseable `DTSTART` leaves `start_ms`/`end_ms` out. Fixtures: build the ICS with the SDK's
   `buildVEvent` where it can express the case, run it through the REAL `parseICalendar` + extras +
   mapper, and assert on the mapped row (fixtures built from the writer).
4. `apple-sync` tests: the calendar pass passes `config.email` as `selfEmail` and the per-VEVENT extras
   from the same ICS to the mapper; an event with a TZID produces the right `start_ms` through the full
   `sync`. Stated bound: an invitation addressed to an iCloud alias other than the account address
   yields `self_response: null`.
5. Implement all of it. Keep `parseICalDateMs`'s behavior for `modifiedAt` (floating treated as UTC)
   untouched: it is not the new keys' contract, and changing it would move `modified_at` of every stored
   event. Say so in a comment.
6. GREEN: `bun test packages/gateway/src/connectors/apple packages/gateway/src/connectors/_lib/ical
   packages/gateway/src/connectors/_lib/zoned`.

### Task 12 - `REBODY_META_TARGETS` (Outlook only) and the pins

Files: `ipc/index-rebody-rpc.ts`, `ipc/index-rebody-rpc.test.ts`.

1. Tests first: `REBODY_META_TARGETS` contains `{ service: "outlook", type: "email",
   requiredMetaVersion: OUTLOOK_MAIL_META_VERSION }`; contains NO `github`/`issue` entry and NO
   `apple`/`event` entry (deviations 4 and 5); the existing "a github issue below version is NOT
   pending" test stays green untouched; a seeded `outlook` `email` row with `body_complete = 1` and no
   `meta_v` is pending (`computePendingMetaByService` reports `{ outlook: 1 }`), one with `meta_v: 1` is
   not; a row matched by two targets still counts once (existing test).
2. Add the entry (type-scoped, because `outlook` also writes `event` rows from MB2b on) and a comment
   block next to `ci_run`'s explaining the two deliberate omissions with the evidence from items 4 and 5.
3. GREEN: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`.

### Task 13 - Integration test (real SQLite, fake HTTP per provider)

`packages/gateway/test/integration/briefing/work-snapshot.test.ts` (the `test/` tree is loaded only by
the whole-repo run, so also run it on its own). It is the first file of the directory MB5's acceptance
test will use.

1. One scenario per service through the REAL syncable and the production capability set
   (`createSyncTestContext` with the service id, as `sync/scheduler.ts` binds it): Jira, Linear and GitHub
   each produce `work_snapshot` rows that resolve to existing `item` rows (a `JOIN item` count equals the
   row count); deleting an item through `ctx.deleteItem` removes its snapshot row; a re-snapshot after a
   failed fetch keeps the old rows and their `captured_at`; two services' snapshots never mix (jira rows
   are unchanged after a github replace).
2. The interval end to end: with `snapshotIntervalMinutes: () => 15`, three consecutive syncs 60 s apart
   (cursor threaded between them, clock injected as in the unit tests) make exactly one set of snapshot
   requests; a sync after minute 15 makes a second; an absent cursor (what `index.rebody` leaves) makes
   one immediately.
3. Outlook: a real delta page with `isRead` indexes `is_read`, and a `nimbus-outl2:` cursor is ignored.
   iCloud: a TZID event through the real parse yields the expected `start_ms`.
4. `bun test packages/gateway/test/integration/briefing`.

### Task 14 - Coverage and cleanup

- New files fall under the connector and index coverage scopes: every new function has a test that
  executes it, branches included (`audit:coverage-floor` is Linux-authoritative, 85 % line / 80 %
  branch per file). The `test:coverage:*` scripts are not the gate (their threshold flag is ignored by
  Bun); if Docker is available run `bun run verify:docker --full`, otherwise review branch by branch and
  say so in the PR.
- Biome (as in `preflight:fast`), no `any` (external JSON is `unknown`, narrowed with
  `asRecord`/`stringField`), no bare `.sort()`, every new function under cognitive complexity 15.
- `git grep -n "nimbus-outl2"`: docs and CHANGELOG keep the history; code and tests must not.
- Cross-platform: no path separators are built here; the iCal and zone tests are pure and must give the
  same answer on Windows, macOS and Linux (`bun run audit:cross-platform`).

## Docs to update in the same PR (the five core docs, every PR)

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains a Phase 10 MB1 sentence
  (snapshots for Jira, Linear and GitHub, GitHub issue due dates, Outlook `is_read`, iCloud normalized
  event keys, `[briefing] snapshot_interval_minutes`, static D24 extended, no new invariant); `schema V90`
  becomes `schema V91` (`audit:status-drift` compares it with `CURRENT_SCHEMA_VERSION`: run it and fix
  every surface it names); the "Static complement" paragraph mentions the new D24 rule.
- `docs/roadmap.md`: the Phase 10 *Morning briefing* and *Deadline tracking* rows stay `[ ]` (MB5 closes
  them) with a dated sub-note that MB1 shipped the data half and which corrections the code forced
  (deviations 1-12 in short form); a note on the on-call row that MB3 must read `/myself` itself.
- `docs/architecture.md`: a `Schema V91` paragraph next to the V90 one (~line 599); the sync-capability
  description gains `replaceWorkSnapshot` and its scoping; the Outlook cursor history gains `outl3`; a
  short "My open work snapshots" subsection (relations, caps, partial versus capped, the `snapAt` cursor
  field, the interval key); the D24 mention in the static-time paragraph (~line 4171) gains the new rule.
- `docs/README.md`: the Phase 10 status paragraph gains the MB1 sentence.
- `docs/cli-reference.md`: no command or flag changes in MB1; add the `[briefing]
  snapshot_interval_minutes` key (default 15, 5 to 240) to the configuration table if the file has one,
  otherwise state in the PR description that the file is unchanged and why (no CLI surface).
- `docs/CHANGELOG.md`: a dated entry in the existing style (what the owner gets: nothing visible yet, the
  index now knows assigned work, due dates, read state and event times; schema V91; the `nimbus-outl3:`
  cursor makes the Outlook mailbox re-list once; the static D24 rule; no new invariant; the stated
  bounds from spec § 8 plus deviations 4, 5 and 6).
- `docs/SECURITY-INVARIANTS.md`: the D24 section ("Statement", "Wired at") gains the
  `work-snapshot-confined` rule and its stated bound, and the header line that lists D24 among the rules
  tied to no invariant gains one clause. The invariant ceiling (I1-I55) and the D-range (D10-D44) do not
  change.
- `docs/schema-reference.md`: the V91 `CREATE TABLE`, index and trigger with a dated header comment.
- `.claude/commands/nimbus-db-migrations.md` and `nimbus-file-map.md`: one line each for V91 and the
  store (gated by `audit:doc-refs`, which resolves every path they cite).

## Verification (run all; fix before presenting; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules including `audit:invariants`,
   `audit:status-drift`, `audit:doc-refs`).
2. `bun test packages/gateway/src` (unit: migration, capability, connector and config tests).
3. `bun test packages/gateway/test packages/cli` (integration and e2e trees; a `src` run does not load
   `test/`).
4. `bun test packages/gateway/src/security-invariants.test.ts` (no invariant changes, but it builds
   `SyncRuntimeContext`s from the capability set).
5. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` (the new D24 rule and fixtures).
6. `bun run typecheck` and `bun run typecheck:tests` (the latter covers `packages/gateway/test/**`; the
   baseline must not grow).
7. `bun run audit:invariants` (the real tree is clean under the new rule).
8. If Docker is available, `bun run verify:docker --changed` for the Linux-only failure class (its one
   known red exec-e2e is the harness, not this branch).
9. Before opening the PR, re-check `git rev-parse --abbrev-ref HEAD`, then `bun run preflight` if time
   allows (full CI parity).

## PR

Title (conventional commit, no `!`; nothing here requires a user to act):

`feat(gateway): index open-work snapshots, GitHub due dates, Outlook read state and iCloud event times for the morning briefing`

Description: summary of the data added, the 12 deviations (short), the stated bounds, the verification
output, and the dependencies: MB5 needs MB1 and MB3; MB2b's Outlook decoder must accept `nimbus-outl3:`.
End with the attribution lines from the session. No `Release-As:` trailer.
