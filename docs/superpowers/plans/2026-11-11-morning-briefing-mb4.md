# Plan - Morning briefing MB4: Slack read markers (V92 `chat_read_marker`) and unread-thread counting

Spec: `mb-spec.md` (approved): § 4 (slices), § 5.0 (`setChatReadMarkers`, D24), § 5.4 (MB4), §§ 6-8.
Roadmap rows: Phase 10 *Morning briefing* (data half; MB5 renders the Chat section and closes the row).
Code read at `origin/main` f36c27b6e (MB1 and MB2b merged; `CURRENT_SCHEMA_VERSION = 91`, so MB4 is V92;
MB3 adds items only, no table). MB4 is the data layer plus one read helper. It adds no CLI command, IPC
method, HITL type, invariant or egress class: every new request is a sync-class fetch under the Slack
run's existing I29 `sync` ledger row.

After MB4: during the Slack sync the gateway asks Slack for the owner's `last_read` of each channel it
indexes (public, private, DM, group DM) and keeps it in `chat_read_marker`; `countUnreadSlackThreads(db,
...)` answers "which indexed Slack threads are newer than my read position and not mine, DMs first".

> **Owner ruling OR-10-15 (2026-11-11):** index Slack direct and group DMs (`is_im` / `is_mpim`) as well as member channels. Deviation 1 is therefore ACCEPTED as written: keep the `is_im`/`is_mpim` condition and its DM tests.

> **Seam for MB5 (added 2026-11-11, binding):** besides `index/slack-unread.ts` `countUnreadSlackThreads`, MB4 must export the briefing's reader exactly as the MB5 plan declares it: `readUnreadChatThreads(db: Database, opts: { nowMs: number; limit: number }): ChatUnreadResult` from `packages/gateway/src/index/chat-unread-query.ts` (a thin adapter over `countUnreadSlackThreads` that resolves the self user id itself), with types structurally identical to these from the MB5 plan. If MB5 has merged first, import its exported types instead of redeclaring them, and wire `readUnreadChat: readUnreadChatThreads` at the one line in `platform/assemble.ts` the MB5 plan names.

```
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

```

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right the plan follows it. Where the code disagrees, the correction is binding for MB4,
and MB5 must follow it (named per item).

1. **"For member channels only" is not how DMs are selected today, and DMs may never have been indexed.**
   `connectors/slack-sync.ts` `slackCollectMemberChannelIds` keeps a list entry only when
   `is_member === true`. Slack's documented `conversations.list` object for an IM (`is_im: true`, `user`,
   `is_user_deleted`, `priority`) has no `is_member` field (documentation knowledge; no repo file records
   it; NOT verified against a live workspace). The sync asks for `types: public_channel,private_channel,
   mpim,im` and the OAuth scopes include `im:history`/`mpim:history`, so DMs were clearly intended. If the
   documentation is right, the sync has indexed no DM so far and spec § 5.4's "DMs and mpims are listed
   first" would list nothing. Correction (an OWNER-VISIBLE decision, flagged in the PR): a list entry also
   counts when `is_im === true` or `is_mpim === true` (a DM that `conversations.list` returns for the
   token's own user is the user's by construction). This starts indexing DM text locally for existing
   connections; the scopes were already requested. If the owner wants DMs out, delete that one condition
   and Task 8's DM tests; the markers and the reader are unaffected (a DM-less index just has no DM rows).
2. **The channel list is never refreshed, so "member channels" go stale and the cleanup story needs a
   code change.** `decodeCursor` accepts `phase: "history"`, and nothing in `slack-sync.ts` ever sets
   `phase` back to `"list"`: after the first walk `nextIdx` just keeps counting (`state.ids[state.nextIdx %
   state.ids.length]`). Two consequences found while reading: a channel joined later is never indexed,
   and a first list that returns zero member channels leaves the cursor at `{phase: "history", ids: []}`
   forever (`if (state.phase === "history" && state.ids.length === 0) return ...`). Correction: at the
   END of a history round (the call where `nextIdx` reaches `ids.length`, `hasMore` false) the returned
   cursor goes back to `phase: "list"` with `ids: []`, `nextIdx: 0`, `listCursor: null`, `histCursor:
   null`, keeping `hw`, `floorTs`, `teamSubdomain`; an empty list result also returns `phase: "list"`, so
   the next sync re-lists. One extra `conversations.list` per round. Existing tests that pin
   `phase: "history"` after a finished round change (Task 8 lists them). The fresh `ids` are what the
   marker prune (deviation 9) keys on. If review wants this out of MB4, drop Task 8 step 3 and the prune:
   markers still work, but a departed channel's marker lingers until the connector is removed.
3. **`ts` is not in the item metadata.** The writer (`slackTryUpsertIndexedHistoryMessage`) stores
   `metadata: { channel, user, thread_ts }` and `externalId = "${channel}:${ts}"`; `modified_at` is the
   `ts` rounded to ms. § 5.4's "`ts > last_read_ts`" cannot key on a metadata `ts`. Correction: the reader
   derives `ts = substr(external_id, instr(external_id, ':') + 1)` (a channel id never contains `:`) and
   compares it to `last_read_ts` as STRING: both are `^\d{10}\.\d{6}$` (Slack ts are fixed-width until
   year 2286), so lexicographic order is exact, which a REAL cast is not (16 significant digits exceed a
   double). A `GLOB` guard in the SQL and a regex in the store keep any other shape out of the compare.
   Thread key = `coalesce(metadata.thread_ts, ts)` as the spec says (a top-level parent with replies
   carries `thread_ts` equal to its own ts; a `thread_broadcast` carries the parent's).
4. **"Unread threads" can only see what history returns.** `conversations.history` returns top-level
   messages and `thread_broadcast` replies; plain thread replies are not fetched or indexed
   (`subtype !== undefined && !== "thread_broadcast"` rows are dropped too). So a new reply in an older
   thread is invisible, and a thread counts as unread only when its parent or a broadcast is newer than
   `last_read`. This is a stated bound beyond spec § 8's 14-day bound; MB5's Chat section must say
   "threads with new top-level or broadcast messages".
5. **The rate limit is not Slack's tier 3.** § 5.4 says "Slack tier 3; at most 100 channels per pass".
   The repo's `slack` limiter key is 20 requests/minute, burst 5 (`sync/rate-limiter.ts`
   `DEFAULT_QUOTAS`), shared with history and list calls, and `acquire` holds the per-provider mutex for
   the whole wait (its abandoned-caller problem is documented on `tryAcquire`). Correction: the marker
   loop takes tokens with `tryAcquire`, polling every 500 ms until the pass's 30 s deadline, so a pass
   fetches about burst + 0.33/s x 30 s = ~15 channels at saturation (up to 100 when the bucket is full
   and `maxChannels` allows). Convergence in a large workspace is therefore slower than the spec's
   "several passes": 100 channels need ~7 rounds. Stated bound; the briefing shows the oldest marker's age
   (`oldestMarkerAt` from the reader). Nothing raises the quota in MB4.
6. **A syncable cannot read `captured_at` (D24: no `Database`), so "round-robin by oldest captured_at"
   cannot be done in the syncable.** Correction: round-robin by a cursor offset `mkIdx` over the
   (sorted, deduplicated) `ids` of the fresh list: each pass starts at `mkIdx % ids.length`, attempts up
   to `min(100, ids.length)` channels, and advances `mkIdx` by the number attempted (success or skip). Under
   uniform attempts this is the same order as "oldest captured_at" and needs no read capability. No second
   capability member is added.
7. **"Per sync pass" is undefined for Slack.** `sync()` handles ONE channel per call (`hasMore` chains the
   calls). Definition used: a pass is the call that ends a history round (deviation 2). The marker
   refresh runs there, after that channel's history was upserted.
8. **"Cached own user id via `auth.test`": there is nothing to cache it in, and the reader is outside the
   syncable.** `auth.test` is today called only inside `slackTryFillTeamSubdomain` and only to read `url`.
   Correction: the cursor gains optional `selfUserId` (old cursors decode with `null`; the prefix
   `nimbus-slk1:` is unchanged, as `teamSubdomain` was added the same way). The marker pass calls
   `auth.test` at its start EVERY pass and stores the id (re-authorising as another Slack user must not
   keep the old id; one cheap call per round). The reader needs the id without a Slack handle:
   `connectors/slack-cursor.ts` (new; the cursor types and decode moved out of `slack-sync.ts`
   unchanged) exposes `readSlackSelfUserId(cursor)`, and `index/slack-unread.ts` exposes
   `loadSlackSelfUserId(db)` over `loadSchedulerState`. `clearSchedulerCursor` (rebody, `connector.sync
   --full`) drops the id until the next round end: the reader then reports `selfUnknown` instead of
   guessing (MB5 renders a Gaps line).
9. **The spec has no cleanup for vanished channels or a removed connector.** `chat_read_marker` is not
   keyed by `item`, so MB1's `AFTER DELETE ON item` trigger pattern does not fit (it would fire once
   per message row of a removed connector). Correction, in two parts: (a) `setChatReadMarkers(markers,
   opts?: { keepChannelIds })` also deletes this service's markers whose channel is not in
   `keepChannelIds`, in the same transaction (the sync passes the fresh list at every marker pass, so a
   channel the owner left loses its marker one round later); (b) the store's
   `deleteChatReadMarkersForService` is called from `LocalIndex.removeConnectorIndexData` and from
   `commands/data-delete.ts`, the two places that delete a service's items. So the capability grows an
   optional second parameter relative to § 5.0 and returns `{ stored, skipped, pruned }`.
10. **Slack API facts (not recorded anywhere in the repo; documentation only, stated as a bound).**
    (a) The token is a USER token: `auth/oauth-registry.ts` `parseSlackTokenResponse` reads
    `authed_user.access_token`, and the authorize URL sends `user_scope` (line ~287). (b) The scopes that
    `conversations.info` needs per type (`channels:read`, `groups:read`, `im:read`, `mpim:read`) are all
    in `connectors/connector-catalog.ts` `defaultScopes` (lines ~470-477): no re-auth for new connections;
    an old connection authorised before a scope was added gets `missing_scope`, which the marker pass
    treats as a partial and logs once (no marker, so the reader reports the channel under
    `channelsWithoutMarker`). (c) `conversations.info` returns `last_read` for a user token for public,
    private, IM and MPIM conversations the user is in (Slack's documented sample objects); a bot token
    would not. `last_read` is `"0000000000.000000"` for a never-read conversation. Live reply shapes are
    not verified against a live workspace (same bound as spec § 8).
11. **Existing Slack tests pin call lists that the marker pass changes.** `slack-sync.coverage.test.ts`
    and `test/unit/connectors/slack-sync.test.ts` build cursors with a preset `teamSubdomain` to skip
    `auth.test` and assert exact `fetchStub.calls` and `phase: "history"` cursors. A round-ending call now
    also performs `auth.test`, up to 100 `conversations.info` calls and (deviation 2) returns `phase:
    "list"`. Task 8 updates them with one shared helper rather than per-test edits.

## Design decisions

- **Table `chat_read_marker`** exactly as the spec (service, channel_id, channel_kind, last_read_ts,
  captured_at; PK service+channel_id), plus a CHECK on `channel_kind IN ('public_channel',
  'private_channel','im','mpim')` (mirrors Slack's `types`; the briefing sorts `im`/`mpim` first). No
  secondary index (the PK serves every lookup; the reader joins on it). No backfill (nothing existed).
  Service allow-list in the store: `["slack"]` (`CHAT_READ_MARKER_SERVICES`), so the capability refuses
  every other service the way `replaceWorkSnapshot` refuses non-jira/linear/github.
- **Capability `setChatReadMarkers(markers, opts?)`**: scoped by the closure's `serviceId` (never a
  parameter), one `db.transaction`, bound parameters (I9) through `dbRun` (I14, static D12). Per-marker
  validation (channel id `^[A-Za-z0-9]{1,32}$`, kind in the enum, `last_read_ts` `^\d{10}\.\d{6}$`); an
  invalid marker is skipped and counted, never stored. More than 1,000 markers throws (a bug guard far
  above the 100 per pass). Upsert is `INSERT ... ON CONFLICT(service, channel_id) DO UPDATE`; a marker
  can move BACKWARD (the owner marked a channel unread), so no monotonic guard. `captured_at` is
  stamped by the capability (`Date.now()`), never supplied.
- **Prune** is `DELETE FROM chat_read_marker WHERE service = ? AND channel_id NOT IN (SELECT value FROM
  json_each(?))` with the keep list as ONE bound JSON parameter (no 999-variable limit, still bound
  SQL). `keepChannelIds` absent means no prune.
- **Marker pass is best effort and never fails the sync.** It runs after the channel's history upsert,
  inside a try/catch that logs and returns; a 30 s controller (a ref'd `setTimeout`, as MB1's
  `applySnapshot`) aborts the in-flight `fetch` and ends the loop; whatever was fetched is stored
  (partial keeps every prior marker for channels not reached). `ratelimited` calls
  `ctx.rateLimiter.penalise("slack", 60_000)` and ends the pass; `channel_not_found`/`not_in_channel`
  skip that channel; `invalid_auth`/`token_revoked`/`token_expired`/`missing_scope`/`account_inactive`
  end the pass with a logged code (the Slack error CODE only, never response text or the token).
- **Pure parts first.** `connectors/slack-read-markers.ts` holds `parseConversationInfo`,
  `selectMarkerChannels` and the loop `refreshSlackReadMarkers(ctx, input, deps)` with injected
  `callApi`, `sleep`, `now`, `budgetMs`, `maxChannels`, so the coverage floor (85 % line / 80 % branch
  per new file) is met by unit tests, not by the integration test. No `??` on a value that cannot be
  nullish; every branch has a test (list in Task 7).
- **Reader.** `index/slack-unread.ts` `countUnreadSlackThreads(db, { selfUserId, limit? })` returns
  `{ threads: UnreadThread[], total, channelsWithoutMarker, oldestMarkerAt }`; it never writes. One SQL
  statement with a CTE over `item` joined to `chat_read_marker`; `metadata` is read through
  `CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.x') END` (a malformed row must not
  raise: see `sqlite-json-extract-raises-on-bad-json`). DMs and mpims sort first, then newest message
  first. `selfUserId` is a parameter (pure SQL, testable); `loadSlackSelfUserId(db)` is the separate
  loader. A null `selfUserId` returns `selfUnknown: true` and counts nothing (never counts the owner's own
  messages as unread).
- **Layering.** D45 (MB5) forbids `briefing/` importing `connectors/`; MB5 will import only
  `index/slack-unread.ts`, which imports `connectors/slack-cursor.ts` for the cursor decode (index/
  already imports `connectors/` and `sync/` in `item-store.ts` and `local-index.ts`). If
  `audit:boundaries` objects, move the decode into `index/` and re-export from `connectors/` (Task 6
  checks this with the real gate).
- **No model, no egress class, no config key, no IPC.** `docs/cli-reference.md` is unchanged (say so in
  the PR); `[briefing] snapshot_interval_minutes` does not govern markers (they follow the Slack round).

## File map

New:
- `packages/gateway/src/index/chat-read-marker-v92-sql.ts`
- `packages/gateway/src/index/chat-read-marker-store.ts` (+ `.test.ts`)
- `packages/gateway/src/index/migrations/runner-v92.test.ts`
- `packages/gateway/src/index/slack-unread.ts` (+ `.test.ts`)
- `packages/gateway/src/index/chat-unread-query.ts` (+ `.test.ts`) (Task 6b, the MB5 seam)
- `packages/gateway/src/connectors/slack-cursor.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/slack-read-markers.ts` (+ `.test.ts`)
- `packages/gateway/test/integration/briefing/slack-unread.test.ts`

Modified: `index/migrations/runner.ts`, `index/migrations/runner.test.ts`, `index/local-index.ts`
(schema constant and `removeConnectorIndexData`), `commands/data-delete.ts` (+ its test),
`sync/sync-capabilities.ts` (+ test), `connectors/connector-sync-test-helpers.ts`,
`connectors/slack-sync.ts`, `connectors/slack-sync.coverage.test.ts`,
`test/unit/connectors/slack-sync.test.ts`, `scripts/structure-audit/check-nimbus-invariants.ts` (+ test),
`scripts/structure-audit/lane-census/exemptions.ts` or an annotation (only if Task 10 needs it), the
docs at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. Fresh worktree from current `main` (absolute path, never nested):
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-mb4 -b dev/asaf/p10-mb4 main`.
   Verify `git rev-parse --abbrev-ref HEAD` before every commit. `bun install`; editor diagnostics in a
   fresh worktree are stale, trust `bun run typecheck`.
2. Re-read `CURRENT_SCHEMA_VERSION` in `index/local-index.ts` (91 at plan time). If another slice took
   V92, renumber every `V92`/`92` below, file names included (spec: numbers follow merge order).
3. `git grep -n "authed_user\|user_scope" packages/gateway/src/auth` (deviation 10a) and
   `git grep -n "clearConnectorSyncCursor\|clearSchedulerCursor" packages/gateway/src` (who resets the Slack
   cursor: it decides how often `selfUserId` is lost).
4. Baseline: `bun test packages/gateway/src/connectors/slack-sync.coverage.test.ts
   packages/gateway/test/unit/connectors/slack-sync.test.ts` green before any edit.

### Task 1 - Schema V92 `chat_read_marker`

Files: `index/chat-read-marker-v92-sql.ts` (new), `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner.test.ts`, `index/migrations/runner-v92.test.ts` (new).

1. `runner-v92.test.ts` first (model: `runner-v91.test.ts`): a V91 database gains an empty
   `chat_read_marker`; `PRAGMA user_version` is 92; `CURRENT_SCHEMA_VERSION` equals
   `maxRegisteredIndexedSchemaVersion()`; the `channel_kind` CHECK refuses `'bogus'` and accepts the four
   values; the primary key refuses a duplicate (service, channel_id) and allows the same channel id under
   another service; `NOT NULL` on every column; re-running the step is idempotent (`IF NOT EXISTS`).
   `bun test packages/gateway/src/index/migrations/runner-v92.test.ts`: RED (no table).
2. `chat-read-marker-v92-sql.ts` exports `CHAT_READ_MARKER_V92_SQL` (array, one statement per element):
   ```sql
   CREATE TABLE IF NOT EXISTS chat_read_marker (
     service TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     channel_kind TEXT NOT NULL CHECK (channel_kind IN ('public_channel','private_channel','im','mpim')),
     last_read_ts TEXT NOT NULL,
     captured_at INTEGER NOT NULL,
     PRIMARY KEY (service, channel_id)
   )
   ```
   Header comment: the store is the only writer (static D24 rule `chat-read-marker-confined`); no
   backfill; no trigger (rows are not keyed by `item`; cleanup is the capability's prune and the removal
   paths, Task 5).
3. `runner.ts`: import it; add `simpleStep(91, 92, "slack read markers (Phase 10 MB4)",
   CHAT_READ_MARKER_V92_SQL)` after the V91 step. `local-index.ts`: `CURRENT_SCHEMA_VERSION = 92`.
   `runner.test.ts` line ~825: rename and change the pin to 92 (`toBe(92)`).
4. GREEN, then `bun test packages/gateway/src/index` (other tests build a DB to `CURRENT_SCHEMA_VERSION`).
5. `git grep -n "schema V91\|user_version.*91"`: code is covered above; docs by `audit:status-drift`.

### Task 2 - The store `index/chat-read-marker-store.ts`

1. `chat-read-marker-store.test.ts` first (real SQLite via `openMemoryIndexDatabase`):
   - `setChatReadMarkerRows(db, "slack", markers, opts, nowMs)`: stores valid markers, returns
     `{ stored, skipped, pruned }`; a second call for the same channel UPDATES `last_read_ts` and
     `captured_at` (and may move backward); other channels and other services untouched;
   - invalid markers are skipped and counted: empty id, id with `:`/space/quote, id of 33 chars, kind
     `'dm'`, `last_read_ts` `"1700000000"`, `"abc"`, `"1700000000.00001"`, `"01700000000.000001"`, a
     number cast through `unknown`;
   - the same channel twice in one call: the later entry wins, one row;
   - a service outside `["slack"]` throws; more than 1,000 markers throws;
   - prune: `keepChannelIds: ["C1"]` deletes this service's `C2` but not another service's `C2`; an empty
     keep list deletes all of this service's markers; absent `keepChannelIds` prunes nothing; a keep id with
     a quote or `%` is just data (bound JSON); 2,000 keep ids work (no variable limit);
   - atomicity: a failure after the upsert (force by a `channel_kind` cast through `unknown` that the CHECK
     rejects when validation is bypassed with a spy) leaves the previous rows and prune intact;
   - `deleteChatReadMarkersForService(db, "slack")` removes only that service's rows and returns the count;
   - `listChatReadMarkers(db, service)` (read-only, ordered by channel id with a code-unit comparator, no
     bare `.sort()`: Sonar S2871) returns `{ channelId, channelKind, lastReadTs, capturedAt }`.
   RED (module missing).
2. Implement: `CHAT_READ_MARKER_SERVICES`, `ChatReadMarkerKind`, `ChatReadMarkerInput`, the validators,
   `setChatReadMarkerRows`, `deleteChatReadMarkersForService`, `listChatReadMarkers`. Writes only through
   `dbRun`/`dbStmtRun`; the upsert statement is prepared once per call and finalised in `finally`
   (bun:sqlite prepared statements must be finalised). Header comment: "The ONLY writer of
   `chat_read_marker` (static D24 rule `chat-read-marker-confined`)".
3. GREEN: `bun test packages/gateway/src/index/chat-read-marker-store.test.ts`.

### Task 3 - The capability `setChatReadMarkers`

Files: `sync/sync-capabilities.ts`, `sync/sync-capabilities.test.ts`,
`connectors/connector-sync-test-helpers.ts`.

1. Tests first in `sync-capabilities.test.ts`:
   - the pinned key list (the "exposes no raw handle" test) gains `"setChatReadMarkers"`;
   - **scoping:** a capability built for `slack` writes `service = 'slack'` rows; seed a row for service
     `'other'` with the same channel id (insert via the test's own SQL), call the capability with that id
     and a prune: the other service's row is untouched; a marker input carrying an extra `service` field
     (cast through `unknown`) is ignored (the service is never a parameter);
   - a capability built for any service other than `slack` (e.g. `jira`) throws a named error;
   - `unboundSyncCapabilities()` throws `^setChatReadMarkers was called on an unbound SyncContext` (the
     existing loop over all members covers it once the member exists);
   - `buildLocalOnlySyncCapabilities(deps, "obsidian").setChatReadMarkers(...)` throws the "local-only
     syncable" message.
   RED first.
2. Interface member with a doc comment (scoped to the bound service, one transaction, only `slack`, the
   optional prune), implementation `setChatReadMarkerRows(deps.db, serviceId, markers, opts, Date.now())`
   behind an `isChatReadMarkerService(serviceId)` check; `unboundSyncCapabilities`: `refuse` line;
   `buildLocalOnlySyncCapabilities`: override with `noCredentials("setChatReadMarkers")`.
3. Every other implementer: `connectors/connector-sync-test-helpers.ts` (`silentSyncContextExtras`'s
   `Pick<SyncContext, ...>` list: add `"setChatReadMarkers"`; MB1 and MB2b did the same for their members);
   `testing/bun-test-support.ts`, `platform/assemble.ts` and `security-invariants.test.ts` spread
   `unboundSyncCapabilities()` or build through `buildSyncCapabilities`: nothing to add.
   `bun run typecheck` and `bun run typecheck:tests` are the census; fix anything they name.
4. GREEN: `bun test packages/gateway/src/sync`.

### Task 4 - Static D24 extension (`chat-read-marker-confined`)

Files: `scripts/structure-audit/check-nimbus-invariants.ts` and `.test.ts`. Model: MB1's
`checkWorkSnapshotConfinement` (~line 924) and its tests.

1. Tests first (a `describe` in the shape of the `work_snapshot` block: a `GOOD` fixture set plus
   single-violation swaps asserting the rule id set):
   - GOOD: the store (write verbs, `export function setChatReadMarkerRows`, `deleteChatReadMarkersForService`);
     the V92 DDL file; `sync/sync-capabilities.ts` naming `setChatReadMarkerRows`; `index/local-index.ts`
     and `commands/data-delete.ts` naming `deleteChatReadMarkersForService`; a reader
     (`SELECT ... FROM chat_read_marker`) in `index/slack-unread.ts`; `checkChatReadMarkerConfinement(GOOD)`
     is `[]`.
   - Violations (each its own test, exactly `chat-read-marker-confined`): a syncable with
     `dbRun(db, "INSERT INTO chat_read_marker ...")`; an RPC file with `DELETE FROM chat_read_marker`;
     `UPDATE chat_read_marker`; `UPDATE OR REPLACE chat_read_marker`; `INSERT OR REPLACE INTO`;
     `REPLACE INTO`; `DROP TABLE`; `ALTER TABLE`; schema-qualified (`main.chat_read_marker`,
     `main . chat_read_marker`); quoted/bracketed/backticked names (`"chat_read_marker"`, `[chat_read_marker]`);
     verb and table on different lines; a syncable naming `setChatReadMarkerRows`; a syncable naming
     `deleteChatReadMarkersForService`; the capability file naming `deleteChatReadMarkersForService`
     (allowed only in store, `local-index.ts`, `data-delete.ts`).
   - Non-violations: the word in a comment; reads (`FROM`/`JOIN`); test files; the DDL file.
   - A real-repo test feeding `iterateSourceFiles()` and expecting `[]`.
   RED first.
2. Implement `checkChatReadMarkerConfinement(files)` with constants for the store, DDL, capability,
   `local-index.ts` and `data-delete.ts` paths; the write-verb regex is MB1's (`D24_WS_WRITE_RE`) with the
   table name swapped, built with `String.raw`/`new RegExp` (including the optional schema qualifier and
   quote characters) and red-proved against the planted violations. Scan comment-stripped source with
   strings kept. Call it next to `checkWorkSnapshotConfinement`, with an `::error ...::D24 chat_read_marker
   written outside its store (rule chat-read-marker-confined)` line and `exit = 1`.
3. `RULE_ANCHORS` (flat array, ~line 4476): add `packages/gateway/src/index/chat-read-marker-store.ts`
   (`sync/sync-capabilities.ts` is already anchored by MB1). `assertScanIsMeaningful` then fails loudly
   if the store moves out of the scan. `iterateGlob` skips `-sql.ts` files, so the DDL path stays in the
   allow-list only for synthetic fixture sets; say so in a comment (as MB1 did).
4. GREEN: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`; `bun run audit:invariants`.
   Stated bound for the docs: a text scan, so a dynamically composed table name evades it (as D33(b)
   says); the capability's confinement is the real defense.

### Task 5 - Removal paths

Files: `index/local-index.ts` (`removeConnectorIndexData`), `commands/data-delete.ts`, and their tests.

1. Tests first: after `removeConnectorIndexData("slack")` the slack markers are gone and another
   service's rows stay (seed through the store); after `runDataDelete({ service: "slack", ... })` likewise;
   `dryRun` deletes nothing. RED.
2. Call `deleteChatReadMarkersForService(db, serviceId)` inside the existing transaction in both
   places (the static rule's allow-list from Task 4 names exactly these two files). GREEN.

### Task 6 - `connectors/slack-cursor.ts` and the reader `index/slack-unread.ts`

1. **Behaviour-preserving extraction first.** Move `SlackSyncCursorV1`, `CURSOR_PREFIX`, `encodeCursor`,
   `decodeCursor` and the two small decode helpers out of `slack-sync.ts` into `slack-cursor.ts`
   (`slack-sync.ts` imports them). The type gains optional-on-decode `selfUserId: string | null` and
   `mkIdx: number` (default 0 when absent or not a non-negative integer). `slack-cursor.test.ts`: every
   existing decode rule (bad phase, empty floor, non-string ids, negative `nextIdx`, junk `hw`), a cursor
   without the new fields decodes with `selfUserId: null, mkIdx: 0`, round trip with them, `selfUserId`
   of the wrong type decodes to null, `readSlackSelfUserId(cursor)` (null cursor, foreign prefix, valid).
   `bun test` the existing Slack tests: still green with no other change.
2. `slack-unread.test.ts` first, **fixtures built FROM the writer**: do not hand-insert `item` rows.
   Create the rows by running the real `createSlackSyncable` against a `StubFetch` (as the Slack unit
   tests do) with history messages, or by calling the exported mapper if Task 8 exports it, so
   `external_id` (`C1:1700000100.000200`), `metadata.channel/user/thread_ts` and `type = 'message'` are
   what production writes. Markers are written through `setChatReadMarkerRows`. Cases:
   - messages with `ts` after `last_read_ts` count; at or before do not (equal `ts` is read);
   - the owner's own messages (`user === selfUserId`) never count; a null `user` counts;
   - thread dedup: a parent (`thread_ts` = own ts) and two `thread_broadcast` rows with the same
     `thread_ts` are ONE thread; two unrelated top-level messages are two;
   - a channel with no marker is listed under `channelsWithoutMarker` and counts nothing;
   - a marker for a channel with no indexed message yields nothing;
   - ordering: `im` and `mpim` first, then channels, newest `latestTs` first within a group; `limit`
     caps `threads` while `total` stays the full count;
   - `oldestMarkerAt` is the minimum `captured_at` over the markers (null with none);
   - `selfUserId: null` returns `selfUnknown: true`, no threads;
   - a row whose `metadata` is malformed JSON (insert directly) does not raise and does not count;
   - string-compare soundness: `last_read_ts "0000000000.000000"` (never read) counts everything;
     a message ts `"1700000000.000099"` vs marker `"1700000000.000100"` is unread=false;
   - another service's `message` rows (e.g. `teams`) never count even with the same channel id;
   - `loadSlackSelfUserId(db)`: reads the scheduler cursor of `slack` (seed `scheduler_state` through the
     scheduler store functions), null with no row, no cursor, or an old cursor.
   RED.
3. Implement. The SQL, written in the plain `json_extract(metadata, '$.key')` form the lane census
   reads (Task 10): a CTE `msgs` selecting from `item` where `service = 'slack' AND type = 'message'` with
   `ch`, `ts` (`substr(external_id, instr(external_id, ':') + 1)`), `tkey` (`coalesce(thread_ts, ts)`),
   `usr`, each metadata read as `CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.channel')
   END`; join `chat_read_marker k ON k.service = 'slack' AND k.channel_id = m.ch`; `WHERE m.ts GLOB
   '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]' AND m.ts >
   k.last_read_ts AND (m.usr IS NULL OR m.usr <> ?)`; `GROUP BY m.ch, m.tkey` for the thread list
   (`MAX(m.ts) AS latest_ts`, `MIN`/title via the newest row), ordered `CASE WHEN k.channel_kind IN ('im',
   'mpim') THEN 0 ELSE 1 END, latest_ts DESC, ch, tkey` (total order, deterministic). Title/permalink/
   author are returned for MB5 (`item.title`, `item.url`); they are DATA, never interpreted. Reads only.
4. GREEN. Then `bun run audit:boundaries` (deviation: index/ importing connectors/slack-cursor.ts): if it
   objects, move the decode into `index/slack-cursor.ts`, re-export from `connectors/`, and say so.

### Task 7 - `connectors/slack-read-markers.ts` (pure parts and the loop)

1. `slack-read-markers.test.ts` first, no network and no DB (a recording fake `ctx`):
   - `parseConversationInfo(json, requestedId)`: public channel (`is_channel`), private (`is_private` or
     `is_group`), IM, MPIM (`is_mpim` wins over `is_group`), each to the right `channelKind`;
     `last_read` absent, empty, `"0"`, wrong shape, or a number: skipped with reason `no_last_read`;
     `channel.id` different from the requested id: `id_mismatch`; `channel` not an object: `no_channel`;
     `"0000000000.000000"` accepted.
   - `selectMarkerChannels(ids, mkIdx, max)`: starts at `mkIdx % n`, wraps, returns at most `max` and
     never repeats an id; `n = 0` returns `[]` without dividing; `mkIdx` beyond `n` wraps; `max > n`
     returns each once; the returned `nextIdx` is `(mkIdx + count) % n`.
   - `refreshSlackReadMarkers`: stores what it fetched in ONE `setChatReadMarkers` call with
     `keepChannelIds: ids`; `auth.test` first and the returned `user_id` is the new `selfUserId` (kept
     unchanged when `auth.test` fails); `channel_not_found` skips that channel and goes on; `ratelimited`
     ends the pass, calls `penalise("slack", 60_000)` and still stores the earlier results; each fatal code
     ends the pass with a logged code; the deadline (injected `now`/`sleep`, a limiter with no tokens)
     ends the pass partial with a logged `deadline`; a `fetch` that throws (abort) ends it partial;
     `maxChannels` caps; a `setChatReadMarkers` that throws is caught and logged, the function resolves;
     the log lines never contain the token or response text (assert on the logger spy's arguments); with
     zero ids it still calls `setChatReadMarkers([], { keepChannelIds: [] })` (prune all) and makes no
     Slack call but `auth.test`.
   RED.
2. Implement with injectable `deps` (`callApi`, `sleep`, `now`, `budgetMs = 30_000`, `maxChannels =
   100`). Token acquisition: `acquireWithin(limiter, "slack", deadline, sleep, now)` polls `tryAcquire`
   every 500 ms. The 30 s budget is a ref'd `setTimeout` controller whose signal is passed to `callApi`
   (add an optional `signal` parameter to `slackWebApi`; today it has no timeout at all). Keep each
   function under cognitive complexity 15 (Sonar S3776); split by phase (`openPass`, `fetchOne`,
   `closePass`), not by hiding a check in a helper. GREEN.

### Task 8 - Wire into `slack-sync.ts`

1. Tests first (extend `slack-sync.coverage.test.ts` and `test/unit/connectors/slack-sync.test.ts`, with
   one shared helper `respondMarkerCalls(stub, ...)` and a cursor builder that carries `selfUserId`):
   - a DM (`{ id: "D1", is_im: true }`) and an MPIM (`is_mpim: true`) without `is_member` are collected;
     `{ id: "C2", is_member: false }` still is not (deviation 1);
   - a round-ending call (last channel) performs `auth.test`, `conversations.info` for each id, calls
     `setChatReadMarkers` once, and returns `phase: "list"`, `ids: []`, `nextIdx: 0`, `mkIdx` advanced,
     `selfUserId` set, `hw` preserved; a non-ending call performs none of them;
   - an empty list result returns `phase: "list"` (the next call re-lists) instead of the stuck history
     cursor (deviation 2);
   - the next call after a round end re-lists and walks again from `hw`;
   - a `conversations.info` failure never fails the sync (`SyncResult` still success, items upserted);
   - the pass stays under the limiter: with a drained bucket the call returns within the budget (use the
     injected limiter clock; no real 30 s wait in a test);
   - old cursor strings (no `selfUserId`/`mkIdx`) still decode and run.
   RED.
2. Implement: `slackCollectMemberChannelIds` (+ `is_im`/`is_mpim`); `slackRunHistoryPhase`'s final branch
   becomes a named `slackFinishRound(ctx, token, state)` step called when the walk is complete (the
   per-phase split the project requires for an ordered sequence, no helper hiding a check); the empty-list
   branch returns `phase: "list"`. `createSlackSyncable` options unchanged (no new option).
3. Update the existing tests whose expectations changed (deviation 11); run
   `bun test packages/gateway/src/connectors/slack-sync*.test.ts packages/gateway/test/unit/connectors/slack-sync.test.ts`.
4. GREEN.

### Task 9 - Integration test (real SQLite, fake HTTP)

`packages/gateway/test/integration/briefing/slack-unread.test.ts` (the `test/` tree: only the E2E tree
has D-Bus on Linux, but this spawns nothing; it just lives beside MB1's `work-snapshot.test.ts`). Drive
the real `createSyncScheduler`/`createSlackSyncable` over one database with `StubFetch`:
- two forced runs of a three-channel workspace (a public channel, a DM, an MPIM) with messages before and
  after `last_read`: markers are stored, `countUnreadSlackThreads` (with `loadSlackSelfUserId`) returns
  the DM and MPIM threads first, excludes the owner's own messages and read messages;
- scoping: running the Slack sync never changes an `item` of another service or another service's
  markers (a seeded `teams` row and a seeded marker for a fake service stay);
- prune: the owner leaves a channel (absent from the next list): its marker is gone after the next round;
- a connector removal (`removeConnectorIndexData("slack")`) clears the markers;
- egress: one forced `slack` run appends exactly one `sync` ledger row (destination `slack`) however many
  `conversations.info` calls it made; an unconfigured run appends none (assert as MB2b's integration test
  does, with the same in-memory sink);
- a partial pass (rate limited at the third `conversations.info`): the first two markers are stored, the
  rest keep their previous values;
- the lane census and the reader agree with the writer: the SQL keys (`channel`, `user`, `thread_ts`)
  are the ones the sync wrote, shown by the DM test above passing against writer-built rows.
`bun test packages/gateway/test/integration/briefing`.

### Task 10 - Gates that read the new code (run, then fix what they report)

- `bun run audit:lane-census --check`: `index/slack-unread.ts` reads `metadata.channel`, `.user`,
  `.thread_ts` of `slack` `message` rows; the writer is `slack-sync.ts` (an object literal inside
  `ctx.upsertItem`, the shape the census writer scan reads) so it should pass. If it flags the `CASE WHEN
  json_valid(...)` wrapper or cannot scope the CTE alias, first restructure to the plain
  `json_extract(metadata, '$.channel')` form in a sub-select, then add `// lane-census: scope=message
  service=slack` (annotation; see `lane-census/annotations.ts`) on the statement, and only as a last
  resort a `census-blind` entry in `lane-census/exemptions.ts` whose `reason` names the writer function
  and file (MB2b's four entries are the model; the entry's `reads` must equal the suppressed count, and a
  stale one fails). The committed `docs/structure-audit/index-lane-census.json` is a report artifact:
  regenerate only if the diff is limited to the new rows.
- Coverage floor (CI-Linux-authoritative, 85 % line / 80 % branch per file): every new file has its own
  test file (Tasks 2, 6, 7); no `??` on a non-nullish value; no defensive branch without a test. If Docker
  is available run `bun run verify:docker --full`, otherwise review branch by branch and say so in the PR.
- Sonar S3776: every new function under 15; `slackFinishRound` and `refreshSlackReadMarkers` are the risk
  (split by phase). No bare `.sort()` (S2871).
- `bun run audit:connector-hosts`, `audit:cross-platform` (no paths built here), `audit:doc-refs`.

## Docs to update in the same PR (the five core docs every PR, plus the rest; say why when unchanged)

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains a Phase 10 MB4 sentence (Slack
  `last_read` markers in V92 `chat_read_marker`, kept for the channels, DMs and group DMs the Slack sync
  indexes; `setChatReadMarkers` capability; static D24 extended by `chat-read-marker-confined`; the sync
  now re-lists channels each round; DMs indexed; stated bounds: a pass fetches ~15 channels, replies are
  not indexed, 14-day depth; no new invariant); `schema V91` becomes `schema V92` everywhere it appears
  (`audit:status-drift` names every surface); the "Static complement" paragraph mentions the new D24 rule.
- `docs/roadmap.md`: the *Morning briefing* row stays `[ ]` (MB5 closes it) with a dated sub-note that MB4
  shipped the chat half of the data layer and the deviations (1, 2, 4, 5, 6, 8, 9 in short form).
- `docs/architecture.md`: a `Schema V92` paragraph next to V91 (~line 611); the sync-capability
  description gains `setChatReadMarkers` and its scoping/prune; a short "Slack read markers" subsection
  (round end, `mkIdx`, `selfUserId`, rate behaviour, the reader's contract and bounds); the Slack sync
  paragraph gains the per-round re-list and DM inclusion; the D24 mention in the static-time paragraph
  gains the rule.
- `docs/README.md`: the Phase 10 status paragraph gains the MB4 sentence.
- `docs/cli-reference.md`: unchanged (no command, flag or config key); state this in the PR description.
- `docs/CHANGELOG.md`: a dated entry in the existing style (owner-visible: DMs and group DMs are now
  indexed; the index knows Slack read positions; channels joined later are now picked up; schema V92; the
  static rule; no new invariant; stated bounds).
- `docs/SECURITY-INVARIANTS.md`: the D24 section ("Statement", "Wired at", ~line 1190) gains the
  `chat-read-marker-confined` rule, its stated bound and the allow-listed removal callers; the header line
  that lists D24 gains one clause. The I-ceiling (I1-I54) and the D-range do not change; I29's `sync` text
  gains `conversations.info`/`auth.test` under its existing class.
- `docs/schema-reference.md`: the V92 `CREATE TABLE` with a dated header comment (after V91, ~line 1339).
- `.claude/commands/nimbus-db-migrations.md` and `nimbus-file-map.md`: one line each for V92 and the
  store/reader (gated by `audit:doc-refs`).

## Verification (run all; fix before presenting; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules, `audit:invariants`, `audit:status-drift`,
   `audit:doc-refs`).
2. `bun test packages/gateway/src` (migration, store, capability, cursor, markers, Slack sync, reader).
3. `bun test packages/gateway/test packages/cli` (integration and e2e trees; a `src` run does not load
   `test/`; the 6 migration e2e reds in that combined process are known and pre-existing on `main`).
4. `bun test packages/gateway/src/security-invariants.test.ts` (the whole file: it builds
   `SyncRuntimeContext`s from the capability set).
5. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` (the new D24 rule and fixtures).
6. `bun run typecheck` and `bun run typecheck:tests` (baseline must not grow).
7. `bun run audit:invariants`, `bun run audit:status-drift`, `bun run audit:lane-census --check`.
8. If Docker is available, `bun run verify:docker --changed` (Linux-only failure class; its one red
   exec-e2e is the harness).
9. Before opening the PR, re-check `git rev-parse --abbrev-ref HEAD`; `bun run preflight` if time allows.

## PR

Title (conventional commit, no `!`; nothing here requires a user to act, and DM indexing uses scopes the
owner already granted):

`feat(gateway): keep Slack read markers and count unread threads for the morning briefing`

Description: what is added; the 11 deviations in short, with deviation 1 (DM indexing) and 2 (per-round
re-list) called out as owner-visible; stated bounds (~15 channels per pass at the 20/min limiter, replies
not indexed, 14-day depth, Slack reply shapes documented not live-verified, string compare relies on
10-digit ts); verification output; dependencies: MB5 needs MB1, MB3 and uses `countUnreadSlackThreads` +
`loadSlackSelfUserId`. End with the attribution lines from the session. No `Release-As:` trailer.

## Review notes applied (agy round 1, both NIT)

- `countUnreadSlackThreads` returns `channelsWithoutMarker` de-duplicated and sorted (`[...new Set(ids)].sort(byCodeUnit)`, never a bare `.sort()`: Sonar S2871), with a test that seeds two unread messages in one marker-less channel.
- The prune runs only when `opts.keepChannelIds !== undefined` (absent = prune nothing; `[]` = prune every marker of the service), with a test for each of the three cases.

## Round 2 corrections (agy round 2: the MB5 seam; these OVERRIDE Task 6's result shape where they differ)

**R2-1. One result shape.** `countUnreadSlackThreads` returns EXACTLY the MB5 seam's types (declared in
`index/chat-unread-query.ts`, imported by `slack-unread.ts`), so the adapter is genuinely thin:
`{ totalThreads, threads, channelsWithMarker, channelsWithoutMarker, oldestMarkerCapturedAtMs, newestMarkerCapturedAtMs }`
(`channelsWithoutMarker: string[]` is an MB4 extra that MB5 ignores; it stays de-duplicated and sorted).
The thread query selects, per `(channel, threadKey)` group: `item.id` of the NEWEST row (`itemId`), `COUNT(*)` (`unreadMessages`),
`MAX(ts)` converted to epoch ms (`latestTsMs` = the integer seconds part × 1000 + the first three fraction digits,
computed in TypeScript from the TEXT ts, never via a REAL cast), the newest row's `title` and `url`, `threadKey`, `channelId`,
`channelName: null` (the writer stores no channel name), and `channelKind` mapped from `chat_read_marker.channel_kind`:
`im` → `"dm"`, `mpim` → `"mpim"`, anything else → `"channel"` (one exhaustive switch with a test per arm).
`channelsWithMarker` = count of this service's markers; `oldest/newestMarkerCapturedAtMs` = `MIN/MAX(captured_at)` (null when none).
Tests pin every field against rows built FROM the slack-sync writer.

**R2-2. Task 6b: `packages/gateway/src/index/chat-unread-query.ts` (+ `chat-unread-query.test.ts`).** Declares the seam types
and `readUnreadChatThreads(db, { nowMs, limit })`: resolves the self user id with `loadSlackSelfUserId(db)`; when it is
`null` returns the empty result (`totalThreads: 0`, `threads: []`, the marker counts still filled) so MB5 can say the
self id is unknown; otherwise calls `countUnreadSlackThreads(db, { selfUserId, limit })` and returns it. `nowMs` is
accepted for the seam and used for nothing but a future age filter (document that; no branch on it). Tests: self-id
null, passthrough of `limit`, the full field mapping on a seeded index, DMs/mpims ordered first. Added to the file map
(New) and to Task 10's coverage list. It is a read-only `index/` module: no D24 or static-rule allow-list change.

**R2-3. `platform/assemble.ts`** is modified by MB4 ONLY if MB5 has already merged (then add the one wiring line MB5
names); otherwise MB4 leaves it untouched and MB5 adds the line.

**R3-1 (agy round 3, SHOULD).** `countUnreadSlackThreads(db, { selfUserId: string | null; limit?: number })` handles `selfUserId: null` itself (threads `[]`, `totalThreads` 0, marker counts still computed), and `readUnreadChatThreads` delegates to it UNCONDITIONALLY with `loadSlackSelfUserId(db)`. This supersedes the null branch in R2-2. The file map and Task 10 now name Task 6b; `channelsWithoutMarker` sorts with `byCodeUnit`.
