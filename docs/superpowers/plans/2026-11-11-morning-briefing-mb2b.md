# Plan — Morning briefing MB2b: Google Calendar and Outlook calendar sync, and `replaceItemSet`

Spec: `docs/superpowers/specs/2026-11-11-morning-briefing.md` (approved, round 2): § 2 (OR-10-12, D-MB-3), § 4
(slices, release gate), § 5.0 (`replaceItemSet`), § 5.2 (MB2b), §§ 6-8. Roadmap rows: Phase 10 *Morning
briefing* and *Deadline tracking* (the calendar half). Builds on MB1 (PR #1969, treated as merged): schema V91,
`replaceWorkSnapshot`, `connectors/_lib/zoned-time.ts`, the iCloud normalized event keys, cursor
`nimbus-outl3:`, `OUTLOOK_MAIL_META_VERSION`.

MB2b is the second data layer of the briefing: nothing renders, schedules or notifies (that is MB5), and it adds
no CLI command, IPC method, HITL type, invariant, schema version or egress class. It adds ONE connector
service (`google_calendar`, its own consent), ONE sync capability (`replaceItemSet`), and calendar rows for
two providers.

After MB2b: `nimbus connector auth google_calendar` runs its own Google consent for
`https://www.googleapis.com/auth/calendar.readonly`; the gateway syncs each selected Google calendar (cap 20)
for the window now-1d .. now+30d into `google_calendar:event` rows; the existing `outlook` syncable also keeps
the same window of the mailbox calendar as `outlook:event` rows; both carry the D-MB-3 keys (`start_ms`,
`end_ms`, `all_day`, `status`, `self_response`, `organizer_email`, `attendee_count`) already carried by iCloud
rows. The gateway pins `@nimbus-dev/connectors` 0.13.0 (95 exported connectors, 94 bundled), whose new
read-only `google-calendar` connector gives the model `gcal_*` read tools through the Google mesh bundle.

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right the plan follows it. Where the code disagrees, the correction below is binding for MB2b,
and the later slices it affects are named.

1. **"Its own consent" is true of the OAuth flow but NOT of the token lookup (§ 5.2).** The flow is per service
   (`ipc/connector-rpc-handlers/auth.ts` `connectorAuthOAuthPkce`: PKCE with the profile's scopes, tokens land
   in the provider's SHARED key `google.oauth`, then `writePerServiceOAuthKey` copies them to the per-service
   key). The lookup, however, is `auth/google-access-token.ts` `resolveGoogleOAuthVaultKey`: the service's own
   key, ELSE the shared `google.oauth`. Wired as `google_meet` is, a user who connected only Gmail has
   `google.oauth` (the last Google consent wins it) and `google_gmail.oauth`; `isConnectorConfigured`
   (`sync/connector-configured.ts` `googleOAuthConfigured` -> the same resolver) would say `google_calendar` is
   configured, the scheduler would append a per-run `sync` egress row (I29) and send the Gmail token to
   `www.googleapis.com/calendar/v3`, which answers 403 every 5 minutes. That is exactly the "silently given
   calendar access" the spec forbids, and an honesty failure for the ledger. Correction: `google_calendar` is an
   OWN-KEY-ONLY service: `resolveGoogleOAuthVaultKey` returns its key or `null`, never the shared one (one
   constant `GOOGLE_OWN_KEY_ONLY_SERVICES`, read by the resolver, so `getValidGoogleAccessToken`,
   `isConnectorConfigured` and the mesh bundle agree by construction). The three siblings keep their fallback
   (changing it is out of scope). Stated bound for the docs: a calendar consent overwrites the shared
   `google.oauth`, so a pre-per-service install that has no `google_meet.oauth` and relied on the shared key
   would send the calendar-only token to Meet; that pre-exists for Photos/Meet and is not widened.
2. **google_meet's syncable is not "the template" for the connector call path (§ 5.2 sites list).** Meet's
   `sync()` reads its token through `ctx.accessToken()` (`sync/access-token-registry.ts` `RESOLVERS` ->
   `getValidGoogleAccessToken`) and calls the Google REST API itself through `fetchGoogleJson`
   (`connectors/google-sync-shared.ts`); its `ensureGoogleMcpRunning` option boots the whole five-server Google
   bundle (`ensureGoogleDriveMcp`) and is vestigial for the REST path. The MB2a connector tool `gcal_event_list`
   forces `orderBy=startTime` and has no `syncToken` parameter (connectors repo `connectors/google-calendar/src/tools.ts`),
   so a `syncToken` sync cannot go through it. Correction: the calendar syncable calls REST directly and takes NO
   `ensure*Running` option (a 5-minute cadence would otherwise keep the Google bundle spawned for a user who has
   only Calendar). The connector is registered in `GOOGLE_BUNDLE_SPAWNS` and `FIRST_PARTY_MANIFESTS` only so the
   model's `gcal_*` read tools exist.
3. **Google `externalId` cannot be the bare provider event id (§ 5.2 "Rows").** A Google event id is unique per
   calendar, not per account: an invitation and a delegated or secondary calendar can hold the SAME id in two
   selected calendars, and `deleteItem` of a cancelled copy in one would remove the row the other still shows.
   Correction: Google `externalId` is `<calendarId>|<eventId>` (neither contains `|`), with `calendar_id` and
   `ical_uid` in the metadata so MB5 can de-duplicate the same meeting seen in two calendars. This is also why
   the capability gains an `externalIdPrefix` option (deviation 7). Outlook keeps the bare Graph id as the spec
   says (a Graph id is unique across messages and events; an Outlook `event` row and an `email` row cannot
   collide, and every replace is type-scoped).
4. **Graph `calendarView/delta` and `$select` / time zones (§ 5.2).** Nothing in this repo or the connectors repo
   calls `calendarView/delta` (the Outlook connector's `outlook_calendar_*` read uses plain `/me/calendarView`,
   `connectors/outlook/src/tools.ts:278`), so there is no code evidence either way; the spec says it does not
   support `$select`. Correction: send NO `$select`; map from the default event resource and pin the fields read
   in a mapper test. Graph returns `start.dateTime` WITHOUT an offset beside a `timeZone` that is a Windows
   zone name by default; the plan sends `Prefer: odata.maxpagesize=50, outlook.timezone="UTC"` and accepts a
   `timeZone` of `UTC` or a name `wallToInstantMs` can resolve; any other zone, and an all-day event whose
   time part is not `00:00:00`, gets NO epoch keys (omission over guessing, as MB1 does) and is counted in the
   sync log line as `calendar_unresolved`. Both the header's effect on the delta endpoint and the all-day shape
   under it are UNVERIFIED against a live account (spec § 8 already says reply shapes are documented-shape
   only); `Date.parse` is never used on an offset-less Graph string (its meaning depends on the host zone).
5. **A window-bounded delta/sync token is bound to the window that minted it (§ 5.2 "same window ... re-anchor").**
   A Graph `deltaLink` and a Google `nextSyncToken` carry the window of the request that created them, so the
   horizon shrinks from +30 d to at least +23 d between re-anchors (stated bound). Google forbids `timeMin`/`timeMax`
   (and `orderBy`) on a request that carries `syncToken`, so the incremental request sends neither, and Google
   does not document whether its result stays inside the original window: the plan filters client-side (an event
   outside `[windowStart, windowStart+31d]` is deleted if present, never upserted). The spec's "deleting rows
   whose `end_ms` fell out of the window" is implemented by `replaceItemSet` (deviation 7), but a keep set from a
   FULL fetch needs the whole fetch in one run: the Outlook sync today moves ONE page per run (the scheduler
   re-queues on `hasMore`) and the cursor cannot hold hundreds of ids. Correction: a (re)anchoring fetch
   drains its pages inside one run up to a page cap (Outlook 20 pages of 50, Google 10 pages of 250 per
   calendar); finished inside the run, it sweeps with the keep set; if the cap is hit the cursor stores the
   `nextLink`/`pageToken` and the run ends `hasMore`, and the completing run prunes only rows whose `end_ms` is
   before the window start (`endBeforeMs`); events deleted during an uncapped gap then survive until their end
   passes (stated bound).
6. **The Outlook cursor needs fields the spec's payload lacks (§ 5.2).** `{v:2, mail:{nextUrl},
   calendar:{nextUrl, windowStart}}` is kept; the calendar half also carries `checkedAt` (epoch ms of the last
   delta request) and an optional `retryAt`. Reason: the mail stream is one page per run with immediate
   continuations, so without a throttle a 2,000-page first mailbox listing would also issue 2,000 calendar delta
   requests. The calendar step runs when its stream is mid-drain (a stored `nextLink`), or `checkedAt` is
   older than 4 minutes (about once per scheduled 5-minute run), or the cursor has no calendar half. A 401/403
   on the calendar (a connection granted before `Calendars.Read` was in `defaultScopes`, `connector-catalog.ts:430`)
   sets `retryAt = now + 6 h` so it neither fails the mail sync nor retries every run. The spec's claim "uses the
   existing `Calendars.Read` grant; no re-auth" is true for connections made with the current scope list only.
7. **`replaceItemSet`'s second mode is under-specified and its scope is wider than it needs to be (§ 5.0).**
   "rows whose `end_ms` is before `opts.endBeforeMs`" does not say whether that is an alternative to or a filter on
   the keep set; two Google calendars share one service and type, so a full sweep of one calendar must not touch
   the other's rows. Correction, binding for MB3: `replaceItemSet(type, keep, opts?)` deletes every row of
   (bound service, `type`) that is a CANDIDATE and whose `external_id` is not in `keep`; the candidate set is all
   rows, narrowed by `opts.externalIdPrefix` (a JS `startsWith`, never `LIKE`: `_` and `%` are wildcards and
   calendar ids contain `_`) and by `opts.endBeforeMs` (a row is a candidate only when its metadata `end_ms` is
   a finite number below it; a row with no `end_ms` is never a candidate under it). It also takes a per-service
   TYPE allowlist (`REPLACE_ITEM_SET_TYPES`: `google_calendar` and `outlook` -> `event`; MB3 adds the on-call
   type), so the capability cannot be used to wipe `email` rows. Like MB1's deviation 10,
   `buildLocalOnlySyncCapabilities` builds its db members bound to `"github"`, so the local-only set must override
   `replaceItemSet` with a refusal.
8. **The connector counts (§ 4, "94 -> 95").** 94 is the number of connectors the PACKAGE exports (it includes
   `readwise`, which the gateway no longer bundles, `UNBUNDLED_CONNECTOR_IDS`). The gateway's
   `BUNDLED_CONNECTORS` has 93 entries today and goes to 94. Every "94" must be classified, not bulk-replaced
   (the table in Task 1).
9. **First-party manifest hosts (§ 5.2 "host www.googleapis.com").** Correct, and nothing more: the MB2a
   connector names only `www.googleapis.com` and is handed a ready access token, so its manifest does NOT carry
   `oauth2.googleapis.com` as the Meet, Photos and Gmail ones do (`audit:connector-hosts` reads the installed
   connector's source against this list).
10. **`status` and `self_response` vocabularies are unspecified (D-MB-3).** The shipped iCloud rows (MB1) hold
    `status` as the raw upper-case iCal value (`CONFIRMED`) and `self_response` as `accepted` | `declined` |
    `tentative` | `needs-action` | `null`. Correction: Google and Outlook write `status` lower-case
    (`confirmed` | `tentative` | `cancelled`; cancelled rows are deleted, so in practice `confirmed` or
    `tentative`), and `self_response` in the SAME four-value set (Google: the attendee with `self: true`, its
    `needsAction` -> `needs-action`; Outlook: `responseStatus.response`, `none`/`notResponded` -> `needs-action`,
    `tentativelyAccepted` -> `tentative`, `organizer` -> `accepted`; no attendees or no own entry -> `null`). One
    helper and one contract test (Task 4) hold the three providers to the same key set. MB5 compares `status`
    case-insensitively (as MB1 already says).
11. **A default sync interval is not in the spec.** Google Calendar uses 5 minutes (as Gmail and Outlook),
    not the 6 hours of `google_meet`: a meeting moved this morning must be seen this morning.
12. **`calendarList` filtering (§ 5.2 "selected !== false, cap 20").** Plus `minAccessRole=reader` (a
    `freeBusyReader` calendar returns no event detail), `hidden`/`deleted` dropped, the primary calendar first,
    then list order; one page of 250 is read and a `nextPageToken` is logged, not followed (a 20-calendar cap
    makes more pages pointless). A calendar that leaves the selection has its rows removed
    (`externalIdPrefix` replace with an empty keep set).

Spec claims verified correct (no deviation): the next free decoder move is `nimbus-outl3:` -> `nimbus-outl4:`
(`outlook-sync.ts` `CURSOR_PREFIX`, with the comment that MB2b's decoder must accept `outl3` as mail-only);
`decodeMicrosoftGraphDeltaCursor` returns `undefined` on a prefix mismatch, so an older prefix falls to the
initial URL; `fetchMicrosoftGraphJson` takes five positional arguments and sets only `Authorization`;
`Calendars.Read` and `Calendars.ReadWrite` are in the Outlook profile (`connector-catalog.ts:430-431`); the
rate-limiter keys `google` and `microsoft` already exist and are the ones the existing fetch helpers acquire
(`fetchGoogleOk` -> `acquire("google")`, `fetchMicrosoftGraphJson` -> `acquire("microsoft")`), so no new limiter
key and no new `Provider` member; the I29 `sync` ledger row is appended by the SCHEDULER once per run
(`sync/scheduler.ts` `appendSyncEgress`) for any registered, configured service, so a new syncable needs no
egress code, only the "unconfigured -> zero rows" test list gaining the id; the catalog already has the
`calendar` category (`catalog/connector-catalog-meta.ts`); `deleteItem` is `deleteItemByServiceExternal` ->
`deleteItemByPrimaryKey` (graph entities then `DELETE FROM item`, embeddings/FTS by trigger), the path
`replaceItemSet` reuses; no new schema version is needed (the next stays V92, MB4's); events are not
`PROSE_HEAVY` (`apple:event` is the comment's precedent); `google_calendar` needs no entry in the
fetch-host boundary (`sync/fetch-host-boundary.ts`) because it has no `fetchOne`.

Risk noted, not a deviation: calendar.readonly is a Google SENSITIVE scope. An unverified OAuth client can grant
it only to test users until Google's verification covers it; the Nimbus client's consent screen must list it.
That is an owner action (record it in the PR description and `docs/roadmap.md` § Owner's open items), not code.

## Design decisions

- **Capability.** `replaceItemSet(type, keepExternalIds, opts?: { endBeforeMs?: number; externalIdPrefix?: string }): number`
  (the deleted count). Implemented in a new store `index/item-set-store.ts`
  (`replaceItemSetRows(db, service, type, keep, opts)`) that selects `id, external_id, metadata` for
  (service, type), filters in JS (candidate rule of deviation 7; metadata parsed with `try/catch`, never
  `json_extract`, which raises on bad JSON), and deletes each id with `deleteItemByPrimaryKey` inside one
  `db.transaction`: the same delete path as `deleteItem`. The service is the capability's closure (never a
  parameter); `type` must be in `REPLACE_ITEM_SET_TYPES[service]`; `keep` is capped at 20,000 (a bug guard).
  No new static rule: the store writes through the existing delete helper (I14/D12 already cover it) and the
  capability list census (Task 3) is the structural pin.
- **One normalized-event helper.** `connectors/_lib/calendar-event-normalize.ts` holds the shared pieces the two
  new mappers use (and the contract test checks apple against): `SelfResponse`, `normalizeSelfResponse`,
  `allDayInstants(startDate, endDateExclusive, zone)` (midnight in the gateway zone, via `wallToInstantMs`),
  `normalizedEventKeys(...)` returning exactly the seven D-MB-3 keys, and `CALENDAR_WINDOW` (`BACK_MS` 1 d,
  `AHEAD_MS` 30 d, `REANCHOR_MS` 7 d, `windowEnd(windowStart)`). All-day events are midnight in
  `gatewayZone()` (MB1's rule), not the calendar's own zone: the owner's briefing day is the owner's zone, which
  `[briefing] tz` defaults to.
- **Per-stream failure isolation.** Google: a per-calendar 403/404 skips that calendar (warn, entry kept); 410
  restarts that calendar once; 401 (`UnauthenticatedError`), 429 and 5xx rethrow (the scheduler backs off; the
  cursor is not persisted on a throw, so the retry repeats, which is safe: a `syncToken` replay and an upsert
  are idempotent). Outlook: the calendar step is wrapped so NOTHING it throws fails the mail step that already
  succeeded; the mail step's errors propagate exactly as today.
- **Cognitive complexity.** Each syncable is split by PHASE into named steps (`listSelectedCalendars`,
  `syncOneCalendar`, `drainWindow`, `finishWindow`; `runMailStep`, `runCalendarStep`), each under Sonar S3776's 15.
- **Rows.** `bodyPreview` only (`capPreview` of the description, as iCloud does), never `body`; `title` clamped to
  256; `modifiedAt` from `updated` / `lastModifiedDateTime`, else `syncedAt`; `url` from `htmlLink` /
  `webLink`; `metadata` = the seven keys + `location`, `ical_uid`, (Google) `calendar_id`, `calendar_name`,
  `recurring_event_id`, (Outlook) `series_master_id`, + `meta_v` (`GOOGLE_CALENDAR_EVENT_META_VERSION` and
  `OUTLOOK_EVENT_META_VERSION`, both 1, in `connectors/calendar-event-meta.ts`). Neither is a
  `REBODY_META_TARGETS` entry: every row is re-written at each (re)anchor, so a target would be pending forever
  for a row older than the window (MB1 deviation 5's reasoning; a comment at the table says so and a test pins
  it). `ipc/index-rebody-rpc.ts:163` already anticipates "outlook also writes `event` rows from MB2b on".
- **Hosts and egress.** Google: `www.googleapis.com` only. Graph: `graph.microsoft.com`. Both are the sync's own
  gateway-process `fetch` (not the sandboxed connector child), covered by the scheduler's per-run `sync` row.

## File map

New:
- `packages/gateway/src/index/item-set-store.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/_lib/calendar-event-normalize.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/calendar-event-meta.ts` (constants only; exact-path coverage exclusion not needed if a test imports it)
- `packages/gateway/src/connectors/google-calendar-event-mapping.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/google-calendar-sync.ts` (+ `.test.ts`, `.window.test.ts`)
- `packages/gateway/src/connectors/outlook-calendar-mapping.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/outlook-calendar-step.ts` (+ `.test.ts`)
- `packages/gateway/test/integration/briefing/calendar-sync.test.ts`
- `packages/docs/src/content/docs/connectors/google-calendar.mdx`

Modified: `packages/gateway/package.json`, `bun.lock`, `connectors/bundled-connector-registry.ts` (generated),
`connectors/connector-catalog.ts` (+ test), `catalog/connector-catalog-meta.ts`,
`connectors/connector-secrets-manifest.ts`, `connectors/connector-vault.ts` (+ test),
`auth/google-access-token.ts` (+ test), `sync/access-token-registry.ts`, `sync/connector-configured.ts` (+ test),
`connectors/lazy-mesh/{connector-spawns,first-party-manifests}.ts` (+ their tests, incl.
`test/unit/connectors/lazy-mesh/connector-spawns.test.ts`, `google-spawn-env.test.ts`),
`platform/assemble-sync-registrations.ts`, `platform/assemble.test.ts`,
`sync/sync-capabilities.ts` (+ test), `connectors/connector-sync-test-helpers.ts`,
`connectors/microsoft-graph-sync-shared.ts` (+ test), `connectors/outlook-sync.ts` (+ test),
`embedding/routing.test.ts`, `ipc/index-rebody-rpc.ts` (comment + test pin), `packages/cli/src/commands/connector.ts`
(+ test), `packages/cli/src/lib/connector-oauth-env-help.ts`, comment-only count edits
(`packages/registry-format/src/manifest.ts:408`, `scripts/gen-bundled-connector-registry.ts:110`,
`scripts/coverage-floor/exclusions.ts:294`, `scripts/structure-audit/check-gateway-native-deps.ts:74`), and the docs
listed at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions (release gate and base)

1. Release gate: MB2a is merged and `@nimbus-dev/connectors` 0.13.0 is PUBLISHED. Check
   `npm view @nimbus-dev/connectors@0.13.0 version` prints `0.13.0` and
   `npm view @nimbus-dev/connectors@0.13.0 exports --json` lists `"./google-calendar"`. If not published, STOP:
   `audit:connector-version-skew` fails a pin to an unpublished version (spec § 4), and `bun install` cannot
   resolve it. The release PR for the connectors repo is release-please's; do not edit `CHANGELOG`/version by hand there.
2. Fresh worktree from `main` AFTER #1969 merged (absolute path, never nested):
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-mb2b -b dev/asaf/p10-mb2b main`.
   Verify `git rev-parse --abbrev-ref HEAD` before every commit.
3. `bun install`; build the sandbox helper only if a sandbox test is later run (a fresh worktree has neither).
   Editor diagnostics in a fresh worktree are stale: trust `bun run typecheck`.
4. Assert MB1 is in the base: `git grep -n "nimbus-outl3:\|replaceWorkSnapshot\|export function wallToInstantMs"`
   must hit `outlook-sync.ts`, `sync-capabilities.ts`, `connectors/_lib/zoned-time.ts`; `CURRENT_SCHEMA_VERSION`
   is 91 (MB2b adds no migration; if another slice moved it, nothing here changes).
5. Re-read `bun run audit:connector-version-skew` expectations: after Task 1 the pin is 0.13.0 = latest, `ok`.

### Task 1 - Pin 0.13.0 and bundle the new connector entrypoint (ONE commit)

The pin and the generated registry must land together: with 0.13.0 installed and the old registry,
`audit:connector-registry-drift` fails (the package exports `./google-calendar`, the registry lacks it).
What a connector-version bump plus a NEW bundled entrypoint touches in the gateway (derived from
`git log -S"@nimbus-dev/connectors" -- packages/gateway/package.json`, #1343 / #1613 / #1713 / #1955 / #1960, and
the `google_meet` sites of #475 and #927):

| Site | Change |
| --- | --- |
| `packages/gateway/package.json` | `"@nimbus-dev/connectors": "^0.12.0"` -> `"^0.13.0"` |
| `bun.lock` | workspace entry (line ~88) and the resolved `@nimbus-dev/connectors@0.13.0` row (line ~618, with its integrity hash and dependency list); produced by `bun install`, never hand-edited |
| `packages/gateway/src/connectors/bundled-connector-registry.ts` | GENERATED: `bun run gen:connector-registry` adds `"google-calendar": () => import("@nimbus-dev/connectors/google-calendar")` (sorted before `google-drive`) and rewrites its header count 93 -> 94 |
| `scripts/gen-bundled-connector-registry.ts` | none (reads the installed package's `exports` map and subtracts `UNBUNDLED_CONNECTOR_IDS`); comment at line ~110 ("all 94 connectors", a historical measurement) stays |
| `bun run audit:connector-registry-drift` | must report ok (exports ⊂ registry + unbundled) |
| `bun run audit:connector-version-skew` | `ok` (pin 0.13.0 = latest) |
| `bun run audit:connector-hosts` | reads the installed `google-calendar` source: hosts it names must be in `FIRST_PARTY_MANIFESTS.google_calendar` (Task 2); a string it names that is never fetched needs a `connector-host-gaps.json` entry (read `connectors/google-calendar/src/tools.ts` at implementation time: it names only `https://www.googleapis.com/calendar/v3`) |
| `bun run gen:connector-write-manifest` | must produce NO diff (the connector has no write tool; `connector-writes/manifest.generated.ts` unchanged); a diff means the scan found a write and the plan is wrong |
| `bun run audit:connector-boot` / `test:connector-boot` (CI compiled-binary smoke) | boots every `BUNDLED_CONNECTORS` entry; `google-calendar` without a token must exit non-zero with `GOOGLE_OAUTH_ACCESS_TOKEN is not set` (matches `CREDENTIAL_REFUSAL_RE`); no edit |
| `audit:gateway-native-deps` (`check-gateway-native-deps.ts`) | no new native dependency in 0.13.0 (the connector depends only on the MCP SDK, `@nimbus-dev/sdk` and `zod`); verify the lockfile diff adds none |

Counts (classify, do not bulk-replace). The PACKAGE exports 94 -> 95 (includes `readwise`); the gateway BUNDLES
93 -> 94:
- package count, change to 95: `CLAUDE.md` lines ~111 and ~131 and `GEMINI.md` (the pair is updated together),
  `.claude/commands/nimbus-file-map.md:272`, `packages/registry-format/src/manifest.ts:408` (a comment about the
  package's manifests), `docs/roadmap.md:1838` ("most of the 94 connectors").
- bundled count: the generated header only (93 -> 94); `scripts/coverage-floor/exclusions.ts:294` says "94 lazy
  thunks" (already stale by one: it becomes 94 correctly after this change; edit the comment to say "one lazy
  thunk per bundled connector" so it stops being a number).
- leave: `docs/CHANGELOG.md` history lines, `CHANGELOG.md` (release-please), `check-gateway-native-deps.ts:74` and
  `gen-bundled-connector-registry.ts:110` (dated measurements: "boots all 94 connectors out of the compiled
  binary" was true for 0.1.1).
- `scripts/connector-gates.test.ts`'s 94 -> 95 is in the connectors repo (MB2a), not here.

Steps: edit the manifest; `bun install` (registry must serve 0.13.0); `bun run gen:connector-registry`; run the
audits above; `bun run typecheck` (expected green: no catalog change yet); `bun test packages/gateway/src/connectors/connector-catalog.test.ts scripts/structure-audit`.
Commit: `chore(gateway): pin @nimbus-dev/connectors 0.13.0 and bundle google-calendar`.
(Squash discards commit messages; the PR title carries the `feat(gateway)` for release-please.)

### Task 2 - Register the `google_calendar` service everywhere `google_meet` is, with the own-key rule

Order matters: write the tests that pin the new behaviour first; most failures are compile errors and exhaustive
records, so `bun run typecheck` after adding the id to `CONNECTOR_SERVICE_IDS` IS the census (every
`{ [K in ConnectorServiceId]: ... }` record and `Record<GoogleConnectorOAuthServiceId, ...>` goes red).

1. Tests first (RED):
   - `connectors/connector-catalog.test.ts`: `oauthProfileForService("google_calendar")` is provider `google` with
     `defaultScopes` exactly `["https://www.googleapis.com/auth/calendar.readonly"]`;
     `normalizeConnectorServiceId("google-calendar")` is `"google_calendar"`; `defaultSyncIntervalMsForService`
     is 5 minutes; `GOOGLE_CONNECTOR_SERVICES.has("google_calendar")`.
   - `connectors/connector-vault.test.ts`: `perServiceOAuthVaultKey("google_calendar")` is
     `"google_calendar.oauth"`; `ALL_GOOGLE_OAUTH_VAULT_KEYS` contains it; `assertEq<ConnectorSecretKeyOf<"google_calendar">, never>(true)`;
     `clearOAuthVaultIfProviderUnused` clears it with the siblings (the existing photos test at ~368-379 is the
     shape).
   - `auth/google-access-token.test.ts` (the own-key rule, the deviation-1 pin): with only `google.oauth` and
     `google_gmail.oauth` in the vault, `resolveGoogleOAuthVaultKey(vault, "google_calendar")` is `null` and
     `getValidGoogleAccessToken(vault, "google_calendar")` throws the not-configured text; with
     `google_calendar.oauth` present it resolves that key; for `google_meet` the shared fallback STILL works
     (control: the three siblings are unchanged). The not-configured text names `google_calendar` too.
   - `sync/connector-configured.test.ts`: `google_calendar.oauth` alone configures it; `google.oauth` alone does
     NOT (while it does for `google_meet`); the "no empty-manifest syncable still bypasses" list (~line 239)
     gains `google_calendar` (13 -> 14; fix the comment).
   - `platform/assemble.test.ts` (~717-760): the "force-syncing all 13 empty-manifest syncables against an EMPTY
     Vault ledgers ZERO rows" list and its title/comment gain `google_calendar` (14).
   - `connectors/lazy-mesh/first-party-manifests.test.ts` (~101): the enumerated list gains `google_calendar`; a
     new test pins its `network` to exactly `["www.googleapis.com"]`.
   - `test/unit/connectors/lazy-mesh/connector-spawns.test.ts` (~106-122, 1165-1210, 1267) and
     `connectors/lazy-mesh/google-spawn-env.test.ts` (~82-90): the per-service key map and the "bundle starts
     every Google connector that has a token" tests gain `google_calendar`; add: a vault with `google.oauth` +
     the four old per-service keys but NO `google_calendar.oauth` registers NO `google_calendar` server
     (own-key-only at the bundle); with its key present it is registered with
     `GOOGLE_OAUTH_ACCESS_TOKEN` and no `GOOGLE_OAUTH_SCOPES` (Gmail alone gets scopes).
   - `embedding/routing.test.ts`: `isProseHeavy("google_calendar","event")` and `isProseHeavy("outlook","event")` are false.
   - `packages/cli/src/commands/connector.test.ts` (~1582): `auth google_calendar --help` prints the Google OAuth help.
   Run: `bun test` on those files. RED.
2. Implement (each bullet is one `google_meet` site; the grep is
   `git grep -n "google_meet" -- packages scripts` plus the siblings that list `google_photos` only):
   - `connectors/connector-catalog.ts`: `CONNECTOR_SERVICE_IDS` (after `google_meet`); `GOOGLE_CONNECTOR_SERVICES`;
     `CONNECTOR_SYNC_INTERVAL_MS` (`google_calendar: MIN5`); `oauthProfileForService` case (own consent: ONLY
     `calendar.readonly`, with a comment stating that a user who connected Gmail is not given calendar access and
     that the profile is the owner's explicit consent).
   - `catalog/connector-catalog-meta.ts`: `google_calendar: m("Google Calendar", "calendar", "Google's calendar service")`.
   - `connectors/connector-secrets-manifest.ts`: `google_calendar: []`.
   - `connectors/connector-vault.ts`: `GOOGLE_SERVICE_VAULT_KEYS.google_calendar = "google_calendar.oauth"` and
     `ALL_GOOGLE_OAUTH_VAULT_KEYS` (so `connector.remove` and `anyGoogleOAuthVaultPresent` see it; the
     remove-restores-the-vault audit iterates this list).
   - `auth/google-access-token.ts`: `GoogleConnectorOAuthServiceId` gains `"google_calendar"`; a new exported
     `GOOGLE_OWN_KEY_ONLY_SERVICES` (a `ReadonlySet`, one member) read by `resolveGoogleOAuthVaultKey`, which
     returns `null` instead of falling to `google.oauth` for a member; `NOT_CONFIGURED` text lists it.
   - `sync/access-token-registry.ts`: `google_calendar: (v) => getValidGoogleAccessToken(v, "google_calendar")`
     (an arrow, as every entry; the file's header explains why).
   - `sync/connector-configured.ts`: `googleOAuthConfigured`'s union, `DERIVED_CONFIGURED_CHECKS.google_calendar`,
     and the doc comments' "13" -> "14".
   - `connectors/lazy-mesh/connector-spawns.ts`: `GOOGLE_BUNDLE_SPAWNS.google_calendar = "google-calendar"`; the
     loop's `resolveGoogleOAuthVaultKey` already returns `null` for a missing own key, so the server is skipped.
   - `connectors/lazy-mesh/first-party-manifests.ts`: `google_calendar: baseManifest("com.nimbus.google-calendar", { network: ["www.googleapis.com"], filesystem: { read: [], write: [] } })`
     (id from the connector's own `nimbus.extension.json`; no `oauth2.googleapis.com`, deviation 9).
   - CLI: `packages/cli/src/commands/connector.ts` `printConnectorAuthServiceHelp` case;
     `packages/cli/src/lib/connector-oauth-env-help.ts` pointer text "(also gmail, google_photos, google_meet, google_calendar)".
   - `scripts/diagnostics/test-google-oauth-refresh.ps1` (key list ~100, map ~108): add the key and mapping
     (a diagnostic script, not gated; keep it truthful).
   - The sync registration is Task 6 (it needs the syncable); the mesh `WAVE2_LISTING` is NOT touched (Meet is not
     in it).
3. `bun run typecheck` and `bun run typecheck:tests`: expected green. Any other exhaustive record that fails is a
   site the grep missed: add it, and record it in the PR description.
4. GREEN: the files of step 1. Then `bun test packages/gateway/src/connectors packages/gateway/src/sync packages/gateway/src/auth packages/gateway/src/catalog`.
5. Check by hand, not by test: `nimbus connector list` style readers that print per-service names get the id from
   the catalog (no edit); `packages/ui` has no `google_meet` literal (grepped), so no desktop change.
6. Commit: `feat(gateway): the google_calendar service, its own OAuth consent and token lookup`.

### Task 3 - The capability `replaceItemSet` (service-scoped, red-proofed)

Files: `index/item-set-store.ts` (+ test), `sync/sync-capabilities.ts` (+ test),
`connectors/connector-sync-test-helpers.ts`.

1. Store tests first (`index/item-set-store.test.ts`, real SQLite via `openMemoryIndexDatabase`; rows are written
   through `upsertIndexedItem` so the metadata is what the writers produce):
   - keep set: rows of (service, type) not in `keep` are deleted, rows in `keep` stay, the return is the count;
   - another TYPE of the same service (`outlook` `email`) and another SERVICE's `event` rows are untouched (the
     scoping assertion: seed `outlook:email:m1`, `google_calendar:event:a|1`, `apple:event:u1`, call for
     `outlook`/`event`, assert the others survive);
   - `externalIdPrefix`: only ids starting with the prefix are candidates; a calendar id containing `_` and `%`
     does not match a sibling by wildcard (`a_b|1` vs `axb|1`);
   - `endBeforeMs`: only rows with a finite numeric `end_ms` below it are candidates; a row with no `end_ms`, a
     string `end_ms` and a row at exactly `endBeforeMs` survive; combined with a keep set, a kept old row survives;
   - an empty keep set without opts deletes every row of the type (an emptied calendar); with `externalIdPrefix`
     only that calendar's;
   - the delete path is `deleteItem`'s: after the call the row has no `item_fts` match, no embedding row, no
     `graph_entity`/`graph_relation` edge (seed one through the graph populator or direct insert the way the
     existing `deleteItemByPrimaryKey` test does) and an `AFTER DELETE ON item` trigger fired (a `work_snapshot`
     row for the item is gone: MB1's trigger);
   - one transaction: a delete that throws part-way (inject a failing trigger or pass a poisoned row) leaves every
     row; a corrupt `metadata` string on one row is not a candidate under `endBeforeMs` and does not throw;
   - a `type` outside `REPLACE_ITEM_SET_TYPES[service]`, a service with no entry, a keep set over 20,000, a
     non-finite `endBeforeMs` and an empty prefix string all throw named errors.
   RED (module missing).
2. Capability tests first in `sync/sync-capabilities.test.ts`:
   - the pinned key list (the "exposes no raw handle" test, ~line 63-80) gains `"replaceItemSet"`;
   - **scoping (red-proof this one):** a capability built for `outlook` deletes only `outlook` `event` rows:
     seed the same external id under `google_calendar` and `outlook`, call through the `outlook` capability, and
     assert `google_calendar`'s row and `outlook`'s `email` row are untouched; the mirror for `google_calendar`;
   - a capability built for `slack`, `jira` or `github` (no allowlist entry) throws a named error naming the
     service; `outlook` + `type: "email"` throws;
   - `unboundSyncCapabilities()` throws `^replaceItemSet was called on an unbound SyncContext` (the existing loop
     over all members asserts it once the member exists);
   - `buildLocalOnlySyncCapabilities(deps, "obsidian").replaceItemSet(...)` throws a message saying the syncable is
     local-only (deviation 7; the existing "local-only gets db capabilities but no credentials" test still passes).
   RED first (member missing).
3. Implement. `SyncCapabilities` gains
   ```ts
   /** Deletes this service's rows of `type` that are not in `keepExternalIds` (see item-set-store.ts). Bound to the calling service; returns the deleted count. */
   replaceItemSet(
     type: string,
     keepExternalIds: readonly string[],
     opts?: { readonly endBeforeMs?: number; readonly externalIdPrefix?: string },
   ): number;
   ```
   with a doc comment stating: scoped to the bound service, the service is never a parameter, one transaction, the
   `REPLACE_ITEM_SET_TYPES` allowlist, the same delete path as `deleteItem`. `buildSyncCapabilities` implements it
   via `replaceItemSetRows(deps.db, serviceId, type, keep, opts)`; `unboundSyncCapabilities` adds the `refuse`
   line; `buildLocalOnlySyncCapabilities` overrides with `noCredentials("replaceItemSet")` (its message already
   says "local-only syncable").
4. Red-proof the scoping: temporarily replace `serviceId` with a literal `"outlook"` in the implementation (or drop
   the `service = ?` predicate) and watch the scoping test fail; revert. Record both reds in the PR description.
5. Every other implementer (MB1 task 3's census): `connectors/connector-sync-test-helpers.ts` (the
   `Pick<SyncContext, ...>` list in `silentSyncContextExtras` names every capability: add `"replaceItemSet"`);
   `testing/bun-test-support.ts`, `platform/assemble.ts` and the two `security-invariants.test.ts` spreads build
   through `buildSyncCapabilities` / `unboundSyncCapabilities()`: nothing to add. `bun run typecheck` and
   `bun run typecheck:tests` are the census: any other literal typed as `SyncCapabilities` fails to compile.
   Also run `git grep -n "pruneBlameForFile" -- packages` and confirm every file that names it also names
   `replaceItemSet` or is in the "nothing to add" list above.
6. GREEN: `bun test packages/gateway/src/index/item-set-store.test.ts packages/gateway/src/sync`.
7. Static: `bun run audit:invariants` stays green (no new rule; D24's `checkSyncContextNoRawHandles` is unaffected
   because no syncable touches `ctx.db`). Note for `docs/SECURITY-INVARIANTS.md` (docs task): D24's text lists the
   capability members; add this one and its allowlist.
8. Commit: `feat(gateway): the replaceItemSet sync capability, scoped to the calling service`.

### Task 4 - Shared calendar helpers `_lib/calendar-event-normalize.ts`

1. Tests first (`_lib/calendar-event-normalize.test.ts`, pure):
   - `normalizeSelfResponse` over every Google value (`needsAction`, `accepted`, `declined`, `tentative`),
     every Graph value (`none`, `notResponded`, `organizer`, `accepted`, `tentativelyAccepted`, `declined`),
     an unknown string, `undefined` -> exactly the four-value set or `null`;
   - `allDayInstants("2026-11-12", "2026-11-13", "Europe/London")` is two midnights in that zone (exact epochs);
     the spring-forward and fall-back days of `America/New_York` give 23 h and 25 h spans; a multi-day all-day
     event spans the exclusive end; an invalid zone returns `undefined`; a bad date string returns `undefined`;
   - `normalizedEventKeys` returns exactly the key set `["all_day","attendee_count","end_ms","organizer_email","self_response","start_ms","status"]`
     (sorted) and omits `organizer_email` when absent, lower-casing it otherwise;
   - `windowEnd(windowStart)` is `windowStart + 31 d`; `isOutsideWindow(startMs, endMs, windowStart)` is true for an
     event ending before `windowStart` or starting after `windowEnd`, false for one overlapping an edge.
   RED. Implement; GREEN.
2. The contract test lands with the mappers (Tasks 5 and 8): it asserts the key sets of the Google, Outlook and
   iCloud (`mapAppleEventToItem`) rows contain the same seven D-MB-3 keys, with the same types
   (`start_ms`/`end_ms`/`attendee_count`: number; `all_day`: boolean; `status`: string; `self_response`:
   string | null; `organizer_email`: string when present). This is the spec's "one normalized contract".
3. `connectors/calendar-event-meta.ts`: the two meta-version constants with the doc comment of deviation 6/Design
   (not rebody targets), and a test beside `ipc/index-rebody-rpc.test.ts`'s existing pins that
   `REBODY_META_TARGETS` has NO `google_calendar` and NO `outlook`/`event` entry (a Sonar-safe literal list).
4. Commit: `feat(gateway): one normalized calendar-event contract shared by Google, Outlook and iCloud rows`.

### Task 5 - The Google event mapper `google-calendar-event-mapping.ts`

1. Tests first. Fixtures are produced by the writer wherever possible: the mapper's output is what the sync tests
   (Task 6) read back from SQLite, never a hand-written row. Raw API fixtures are the documented Events resource:
   - timed event (`start.dateTime` with offset) -> `start_ms`/`end_ms` exact epochs, `all_day` false;
   - all-day (`start.date`/`end.date`, exclusive end) -> midnights in `gatewayZone()` (pass a zone parameter; the
     test passes `Europe/London` and `Pacific/Auckland` and asserts both), `all_day` true, a multi-day one;
   - `status`: `confirmed`, `tentative`; a `cancelled` event returns `null` from the mapper (the caller deletes);
   - `self_response` from the attendee with `self: true`; no attendees -> `null`; attendees without a `self` entry
     -> `null`; `attendee_count` is `attendees.length`; `organizer_email` lower-cased;
   - an event with no `id`, no `start`, or neither `start.dateTime` nor `start.date` -> `null`;
   - `externalId` is `<calendarId>|<eventId>`; a recurring instance id (`abc_20261111T090000Z`) is kept whole;
     `ical_uid`, `calendar_id`, `calendar_name`, `recurring_event_id`, `location` present only when strings;
   - title: summary clamped to 256, `(untitled event)` when empty; `bodyPreview` = `capPreview(description)`;
     no `body` key on the row;
   - `modifiedAt` from `updated`, else `syncedAt`; `url` from `htmlLink`, else `null`;
   - `meta_v` equals `GOOGLE_CALENDAR_EVENT_META_VERSION`;
   - the contract test of Task 4 step 2 (Google arm).
   RED. Implement `mapGoogleCalendarEvent(ev, { calendarId, calendarName, zone, syncedAt }): MappedRow<"google_calendar","event"> | null`
   over `unknown` input with `asRecord`/`stringField` (`unknown-record.ts`), no `any`. GREEN.
2. Commit: `feat(gateway): map a Google Calendar event to the normalized event row`.

### Task 6 - The Google Calendar syncable, cursor, 410 restart and window re-anchor

Files: `connectors/google-calendar-sync.ts`, `google-calendar-sync.test.ts`, `google-calendar-sync.window.test.ts`,
`platform/assemble-sync-registrations.ts`.

Cursor `nimbus-gcal1:` (base64url JSON via `encodeNimbusJsonCursor`; `decodeNimbusJsonCursorObject` returns `null`
on junk): `{ v: 1, calendars: { [calendarId]: { windowStart: number, syncToken?: string, pageToken?: string } } }`.
Decoder validates every field type, caps the map at 20 entries and ignores an entry with a non-finite
`windowStart`; a junk cursor decodes to "no cursor" (a full first sync), never throws.

Request shapes (a test asserts each by decoding the URL):
- list: `GET https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader&fields=nextPageToken,items(id,summary,primary,selected,timeZone,accessRole,hidden,deleted)`.
- full: `GET .../calendars/<encodeURIComponent(id)>/events?singleEvents=true&maxResults=250&timeMin=<ISO>&timeMax=<ISO>&fields=nextPageToken,nextSyncToken,items(id,iCalUID,status,summary,description,location,start,end,organizer(email),attendees(self,responseStatus),updated,htmlLink,recurringEventId)`
  (+ `pageToken` when resuming; NO `orderBy`, NO `showDeleted`).
- incremental: the same URL with `syncToken=<t>` and WITHOUT `timeMin`/`timeMax`/`orderBy` (Google refuses them
  beside `syncToken`); `attendees(self,responseStatus)` carries no addresses, so an attendee list never reaches
  the index (a privacy narrowing relative to iCloud, which stores addresses; the count is kept).
- all through `fetchGoogleJson(ctx, token, url, "Google Calendar", { method: "GET" })`, so each request is
  preceded by `rateLimiter.acquire("google")` and a 401 is an `UnauthenticatedError`.

1. Tests first (`google-calendar-sync.test.ts`, real SQLite + fake `fetch`, the setup of `google-meet-sync.test.ts`
   plus `await vault.set("google_calendar.oauth", ...)` because `createOAuthConnectorTestSetup("google", ...)`
   writes only the shared `google.oauth`, which the own-key rule now ignores):
   - a first sync (cursor null) lists calendars, then fetches each selected one: `selected: false`,
     `hidden: true`, `deleted: true` calendars are skipped; a `freeBusyReader` calendar is absent because the
     request carries `minAccessRole=reader` (assert the query string); more than 20 selected -> 20 synced, the
     primary first, a `warn` logged; rows land as `google_calendar:event` with namespaced ids and the seven keys
     (read from `item`, not a hand row);
   - cursor round trip (`nimbus-gcal1:`), junk and wrong-prefix cursors decode to "none", an entry per calendar,
     `syncToken` stored from `nextSyncToken` on the last page only;
   - the incremental pass: the request has `syncToken` and NONE of `timeMin`/`timeMax`/`orderBy`;
     a `status: "cancelled"` item deletes the row (`itemsDeleted` counted, only when it existed); an updated
     item upserts; an item outside the window (an `end` before `windowStart`, a `start` after the window end) is
     not indexed and an existing row for it is removed;
   - **410 restart:** the incremental request answers 410 (`GoogleHttpError` status 410): that calendar's entry is
     dropped and the SAME run re-fetches it in full (assert the second request has `timeMin`, no `syncToken`),
     keeping other calendars' entries; a second 410 in one run for one calendar does not loop (one restart only);
   - **window re-anchor:** an entry whose `windowStart` is older than 7 days is re-fetched in full with a NEW
     `timeMin` (= now - 1 d), and after the drain `replaceItemSet` sweeps THAT calendar's prefix with the keep
     set: a row for an event removed upstream while the token was valid, and a row whose `end_ms` fell out of the
     window, are gone; another calendar's rows, and rows of a calendar not re-anchored this run, are untouched
     (the scoping assertion, red-proofed by deleting the `externalIdPrefix`);
   - the page cap: 11 pages of a full fetch -> 10 drained, the entry keeps `pageToken` and no `syncToken`,
     `hasMore` true, NO sweep (rows from a stale gap survive); the next run resumes with the stored `pageToken`
     and the SAME `timeMin` (derived from the stored `windowStart`), and on completion prunes only rows with
     `end_ms < windowStart` (`endBeforeMs`);
   - a calendar removed from the list (present in the cursor, absent now) has its rows deleted and its entry
     dropped; the same run does NOT do that when the `calendarList` request itself failed (it throws first);
   - per-calendar isolation: a 403 and a 404 on one calendar log a `warn` (fixed text, no provider body), keep
     its entry and let the others sync; a 429 and a 500 rethrow; a 401 is an `UnauthenticatedError`;
   - an event with a `|`-free id but the SAME id in two calendars yields two rows; cancelling it in one leaves the other;
   - no `ensure*Running` option exists (deviation 2): `createGoogleCalendarSyncable()` takes none, and the run
     makes no mesh call;
   - the run's `bytesTransferred` sums every response; `itemsUpserted`/`itemsDeleted` count rows, not requests;
   - unconfigured vault: `ctx.accessToken()` throws the not-configured error and NO request is made (the
     scheduler's own configured gate is tested in Task 2).
   RED.
2. Implement. `GoogleCalendarSyncableOptions = {}` (kept as a type so the factory signature matches its
   siblings). `createGoogleCalendarSyncable(): Syncable` with `serviceId: "google_calendar"`,
   `defaultIntervalMs: 5 min`, `initialSyncDepthDays: 30`. Phases, each a named function: `decodeCursor`;
   `listSelectedCalendars` (filter, order, cap, drop rows of departed calendars through
   `ctx.replaceItemSet("event", [], { externalIdPrefix })` AFTER a successful list); `syncOneCalendar` (chooses
   full vs incremental, handles the 410 restart and the 403/404 skip); `drainPages` (the page loop under a shared
   page budget of 12 per run across calendars, writing each page inside `ctx.writeBatch`); `finishWindow` (sweep
   with keep when the drain began fresh and completed in this run, else `endBeforeMs` prune when it completed after
   a resume, else nothing). The mapper's `null` for `cancelled` routes to `ctx.deleteItem("google_calendar", id)`.
   `hasMore` is true when the budget ran out with work left. A full drain collects keep ids in a `Set` local to
   the run only. Register in `platform/assemble-sync-registrations.ts` next to `createGoogleMeetSyncable`, with NO
   mesh option. `registerConnectorMeshSyncables`' existing test counts registrations: update its expectation
   (`assemble-sync-registrations.test.ts`).
3. `google-calendar-sync.window.test.ts` holds the DST and midnight cases through the syncable: an all-day event
   on the spring-forward day, an event spanning midnight (kept whole, one row), a multi-day all-day event.
4. GREEN: `bun test packages/gateway/src/connectors/google-calendar-sync*.test.ts packages/gateway/src/platform`.
5. Commit: `feat(gateway): Google Calendar sync with per-calendar syncTokens, 410 restart and a 7-day window re-anchor`.

### Task 7 - Graph helpers: request headers, a typed error, and the v2 Outlook cursor

Files: `connectors/microsoft-graph-sync-shared.ts` (+ test), `connectors/outlook-sync.ts` (codec part).

1. Tests first in `microsoft-graph-sync-shared.test.ts`:
   - `fetchMicrosoftGraphJson(ctx, token, nextUrl, initialUrl, label, headers?)` sends the extra headers, still
     sends `Authorization: Bearer <token>`, and a caller header named `Authorization` (any case) does NOT replace it;
     with no `headers` the request equals today's (the existing tests pass unchanged: Teams and OneDrive call
     the 5-argument form);
   - a non-OK response throws `MicrosoftGraphHttpError` (new, exported) whose `message` is byte-identical to
     today's (`Outlook sync failed: 410`) and whose `status` is the number (so a 410 is recognisable and every
     existing message assertion still holds); invalid JSON keeps its message.
   RED. Implement (the thrown class extends `Error`, `name` set; `instanceof Error` callers unaffected). GREEN.
2. Codec tests first in `outlook-sync.test.ts` (update the codec describe at ~line 29, which currently expects
   `nimbus-outl3:`):
   - `encodeOutlookSyncCursor` now emits `nimbus-outl4:` with payload `{v:2, mail:{nextUrl}, calendar?:{nextUrl, windowStart, checkedAt?, retryAt?}}`;
     `expectPrefixedCursorCodecRoundTrip` over several samples (calendar absent, calendar mid-drain, calendar
     settled, `retryAt` set) with prefix `"nimbus-outl4:"`;
   - `decodeOutlookSyncCursor("nimbus-outl3:" + <a v:1 mail cursor>)` returns `{ v: 2, mail: <that cursor's nextUrl>, calendar: undefined }`
     (**mail is NOT reset**: a sync from an outl3 cursor requests the stored `nextUrl`, not the initial URL; assert
     the first fetched URL of the sync is the stored one), `nimbus-outl2:`/`nimbus-outl1:`/junk decode to
     `undefined` (both streams start fresh), an outl4 payload with `v: 1` or a malformed `mail`/`calendar` is
     `undefined`; a calendar half with a non-finite `windowStart` is dropped (calendar restarts) while the valid mail half is kept;
   - the three-way migration test: outl3 (mail mid-drain) -> one sync -> the stored cursor is `nimbus-outl4:` with
     `mail.nextUrl` advanced from the SAME link and `calendar` set.
   RED. Implement: `CURSOR_PREFIX = "nimbus-outl4:"`, `CURSOR_PREFIX_V3 = "nimbus-outl3:"` (the comment history
   extended: outl1 -> outl2 -> outl3 -> outl4, and why outl3 is still read); `OutlookSyncCursorV2 = { v: 2; mail: { nextUrl: string | null }; calendar?: OutlookCalendarCursor }`;
   `decodeOutlookSyncCursor` tries outl4 first, then outl3 through the existing `decodeMicrosoftGraphDeltaCursor(raw, CURSOR_PREFIX_V3)`;
   keep `decodeMicrosoftGraphDeltaCursor`/`encodeMicrosoftGraphDeltaCursor` for Teams/OneDrive unchanged.
   GREEN.
3. Commit: `feat(gateway): Graph request headers, a typed Graph HTTP error and the nimbus-outl4 cursor (outl3 read as mail-only)`.

### Task 8 - Outlook calendar mapper and the calendar step inside the `outlook` syncable

Files: `connectors/outlook-calendar-mapping.ts`, `connectors/outlook-calendar-step.ts` (+ tests), `connectors/outlook-sync.ts`.

Request: `GET https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=<ISO>&endDateTime=<ISO>`
with `Prefer: odata.maxpagesize=50, outlook.timezone="UTC"`, no `$select` (deviation 4), following
`@odata.nextLink` to `@odata.deltaLink`; a stored `deltaLink` is requested as-is on later runs (the same two
headers). `startDateTime` = `windowStart`, `endDateTime` = `windowStart + 31 d`, both UTC ISO with `Z`.

1. Mapper tests first (`outlook-calendar-mapping.test.ts`; documented Graph event shape fixtures):
   - timed event with `start: { dateTime: "2026-11-12T09:30:00.0000000", timeZone: "UTC" }` -> exact epoch via a
     regex + `Date.UTC` (assert it does not depend on the host zone: run the assertion with `process.env.TZ`
     untouched and also compare against a hand-computed epoch);
   - `timeZone` an IANA name (`Europe/London`) resolved through `wallToInstantMs`; a Windows name
     (`"Pacific Standard Time"`) or unknown -> NO `start_ms`/`end_ms` and the mapper reports `unresolved: true`;
     an all-day event (`isAllDay: true`) with a `00:00:00` time part -> midnights in the gateway zone from the
     DATE parts; an all-day event with a non-midnight time part -> unresolved (deviation 4);
   - `isCancelled: true` -> the mapper returns `{ kind: "delete" }`; `@removed` is the caller's;
   - `status` `confirmed`/`tentative` (`showAs: "tentative"` -> `tentative`); `self_response` from
     `responseStatus.response` per the table (deviation 10); `organizer_email` from
     `organizer.emailAddress.address` lower-cased; `attendee_count` from `attendees.length`;
     `location.displayName` -> `location`; `iCalUId` -> `ical_uid`; `seriesMasterId`;
   - `bodyPreview` from Graph's `bodyPreview` via `capPreview`; no `body`; `title` from `subject` (`(no subject)`
     in the same words the mail mapper uses), clamped; `modifiedAt` from `lastModifiedDateTime`; `url` `webLink`;
   - missing/empty `id` -> `null`; `meta_v` = `OUTLOOK_EVENT_META_VERSION`; the contract test arm (Outlook).
   RED. Implement `mapOutlookCalendarEvent(raw, { zone, syncedAt })` returning
   `{ kind: "row"; row } | { kind: "delete"; externalId } | { kind: "skip" }`. GREEN.
2. Calendar step tests first (`outlook-calendar-step.test.ts`, fake `fetch`, real SQLite):
   - first run (no calendar half): one fresh drain: 3 pages of 50 -> all rows written, the stored half is the
     `deltaLink` with `windowStart` ~ now - 1 d, and `replaceItemSet("event", keep)` swept rows that were not
     returned (seed a stale `outlook:event` row and an `outlook:email` row: the stale event goes, the email stays);
   - the request has `startDateTime`/`endDateTime` 31 days apart, the two `Prefer` values in ONE header, and
     no `$select`; the stored `deltaLink` request carries the same header;
   - a later run requests the stored `deltaLink`; `@removed` entries delete (`itemsDeleted`), an entry with
     `isCancelled` deletes, a changed event upserts; no sweep;
   - throttle: a second call 1 minute after `checkedAt` makes NO request and keeps the half unchanged; after 4
     minutes it requests; a mid-drain half (stored `nextLink`) always requests;
   - re-anchor: `windowStart` older than 7 days and a settled half -> a fresh drain with a new window, then the
     sweep with the keep set; a stored `nextLink` mid-drain is NOT re-anchored (finish first);
   - the page cap: 21 pages -> 20 drained, the half keeps the `nextLink`, `hasMore` true, no sweep; the completing
     run prunes only `end_ms < windowStart`;
   - 410 (`MicrosoftGraphHttpError` status 410): drop the half and re-drain once in the same run;
   - 401/403: the step resolves with `retryAt = now + 6 h`, the mail result of the same run is unaffected, no
     further calendar request before `retryAt`; a 500 or a network throw is swallowed with a `warn` (fixed text)
     and the half is kept as it was; NOTHING thrown by the calendar escapes to the caller;
   - the unresolved-zone counter reaches the run's log line.
   RED.
3. `outlook-sync.test.ts` (existing file): the mail tests must still pass unchanged apart from the cursor
   prefix; new: one run issues the mail request and the calendar request (assert URLs, in that order: the mail
   result is computed first so a calendar failure cannot lose it), `itemsUpserted`/`itemsDeleted`/
   `bytesTransferred` are the SUM of both, `hasMore` is `mail.hasMore || calendar.hasMore`, a run whose cursor
   is outl3 migrates (Task 7), the "`@removed` mail id" and "mail with an event-like id" cases still route by
   type, and a calendar failure leaves the mail rows and the mail cursor advance intact.
4. Implement `outlook-calendar-step.ts` (`runOutlookCalendarStep(ctx, token, half, now, zone): Promise<{ half; upserted; deleted; bytes; hasMore; unresolved }>`)
   as named phases: `shouldRun`, `anchorWindow`, `drainWindow`, `finishWindow` (the same sweep / prune rule as
   Google), `settleError`. In `outlook-sync.ts` split `sync()` into `runMailStep` (the existing body, unchanged in
   behaviour, returning its result and next mail half) and the call to the calendar step, then
   `encodeOutlookSyncCursor({ v: 2, mail, calendar })`. `fetchMicrosoftGraphJson` is called with the new headers
   argument only by the calendar step.
5. GREEN: `bun test packages/gateway/src/connectors/outlook packages/gateway/src/connectors/microsoft-graph`.
6. Commit: `feat(gateway): Outlook calendar delta inside the outlook syncable, with its own window re-anchor`.

### Task 9 - Integration test over the real syncables

`packages/gateway/test/integration/briefing/calendar-sync.test.ts`, in the shape of MB1's
`work-snapshot.test.ts` (real SQLite, `syncTestContext` binding the service as `sync/scheduler.ts` does, one fake
HTTP router per provider; it lives in the `test/` tree, which `bunfig.toml` does not exclude, and the PR legs
run it):
- Google: two calendars + three events (one all-day, one recurring instance, one cancelled on the second sync):
  after sync 1 the index holds the rows with every D-MB-3 key; sync 2 (incremental) deletes the cancelled one;
  a 410 on sync 3 restarts and converges to the same set; after 8 simulated days (advance the cursor's
  `windowStart`) the re-anchor sweeps an aged-out row; `item_fts` finds an event by title.
- Outlook: the real `createOutlookSyncable` with an outl3 cursor holding a mid-drain mail link: mail continues
  (no reset), the calendar half appears, `outlook:email` rows are untouched by the sweep.
- The three-provider contract: a Google, an Outlook and an iCloud event for the SAME wall-clock meeting produce
  identical `start_ms`/`end_ms` (a UTC instant) and the same seven keys, so MB5 can union them with one query
  (`SELECT ... json_extract(metadata,'$.start_ms')`); the query is the one MB5 will use, written here as the
  contract's proof.
- Scoping end to end: running the Google sync never changes an `outlook` row and vice versa.
- Egress: with the real scheduler (`createSyncScheduler` over the same db and an in-memory egress sink, as
  `platform/assemble.test.ts` does) one forced `google_calendar` run appends exactly one `sync` row whose
  destination is `google_calendar`; an UNCONFIGURED one appends none.
Commit: `test(gateway): calendar sync over real SQLite for Google and Outlook (Phase 10 MB2b)`.

### Task 10 - Gates that read the new code (run, then fix what they report)

- `bun run audit:lane-census`: the lane census reads `item.type` / `metadata.<key>` writes and reads. MB5 will read
  `start_ms` etc. under `type = 'event'`; the census matches "every service that writes the type emits the key":
  with `apple`, `google_calendar` and `outlook` all writing `event`, a reader of `start_ms` is satisfied only
  when all three emit it, which the contract test guarantees. The committed `docs/structure-audit/index-lane-census.json`
  is a report artifact the report-mode run rewrites (MB1 did not regenerate it); regenerate it only if the diff is
  limited to the new rows, otherwise leave it.
- `bun run audit:connector-hosts`, `audit:connector-registry-drift`, `audit:connector-version-skew`,
  `gen:connector-write-manifest` (no diff): re-run after Task 2.
- Coverage floor (CI-Linux-authoritative; per-file 85% line / 80% branch): every new file has its own test file
  (Tasks 3-8) and the mapper/step branches (unresolved zone, cap, 410, 403) are each tested above; do not rely on
  the integration test for coverage.
- Sonar S3776: after Tasks 6 and 8, run `bunx biome check` and the local complexity script if the repo has one
  (`docs/sonar-local.md`), and split any function over 15 by PHASE.

## Docs to update (the five core docs every PR, plus the rest; say why when unchanged)

- `CLAUDE.md` and `GEMINI.md` (identical edits): the Status paragraph gains MB2b (what shipped, the own-key-only
  rule, `replaceItemSet`, the cursor move, the stated bounds below); "all 94 ship as ONE package" -> 95 (lines
  ~111 and ~131 as in Task 1); `schema V91` is unchanged (no migration: say so in the CHANGELOG); no invariant is
  added (I29's `sync` class gains the new fetches, in SECURITY-INVARIANTS).
- `docs/roadmap.md`: the Phase 10 *Morning briefing* and *Deadline tracking* rows (lines ~2007, ~2009) gain MB2b
  (calendar half done; the Deadline row's "Calendar" source); § Owner's open items gains the Google sensitive-scope
  verification note; line ~1838 count 94 -> 95; the Google Meet entry (~586) gets a sibling "Google Calendar" entry.
- `docs/architecture.md`: a subsection after "My open work snapshots and the briefing's data" (~line 607):
  "Calendar events (Phase 10 MB2b)": the normalized contract, the namespaced Google id, the window and re-anchor,
  the sweep rules and `replaceItemSet`'s candidate semantics, the outl4 cursor, the own-key-only consent, why the
  sync does not go through the MCP connector.
- `docs/README.md` (the line ~445 status paragraph): one sentence: Google Calendar (after `nimbus connector auth
  google_calendar`) and Outlook calendar events are indexed for the next 30 days.
- `docs/cli-reference.md` (the "Briefing data" paragraph ~1656 and the connector auth section): `nimbus connector auth google_calendar`
  (scope, own consent, `--help`), and that MB2b adds no other command or flag.
- `docs/CHANGELOG.md`: one dated entry in the MB1 style (what changed, spec deviations recorded, stated bounds,
  tests).
- `docs/SECURITY-INVARIANTS.md`: the I29 `sync` text gains `google_calendar` (www.googleapis.com) and the Outlook
  `calendarView` fetch under its existing class; the D24 section names `replaceItemSet` and its allowlist.
- `docs/schema-reference.md`: no schema change (state it in the CHANGELOG, not here).
- `.claude/commands/nimbus-file-map.md`: the OAuth sub-service row (line ~119) gains `google_calendar` and the
  own-key rule; the new files; the `94` at line ~272; `nimbus-sandbox-and-extensions`/`nimbus-connector-authoring`
  need no change.
- Connector docs: `packages/docs/src/content/docs/connectors/google-calendar.mdx` (modeled on `google-photos.mdx`:
  what is indexed, the `calendar.readonly` scope and its own consent, the window, the 20-calendar cap, `nimbus
  connector auth google_calendar`) and the Google row of `connectors/overview.mdx` (line 23); the Outlook page,
  if present, gains the calendar window.

Stated bounds to record in the docs: the window is -1 d .. +30 d at each anchor and the horizon shrinks to >= +23 d
between 7-day re-anchors; at most 20 Google calendars; recurring events are expanded instances; an event deleted
upstream during a capped (multi-run) drain survives until its end passes; a Graph event whose zone is neither UTC
nor an IANA name carries no epoch keys; an Outlook connection authorised before `Calendars.Read` gets no events
and retries every 6 hours; the Google attendee list is a count only; live reply shapes for Google Calendar and
Graph `calendarView/delta` (incl. the `Prefer` header's effect and all-day shape) are verified against documented
shapes only; a calendar consent overwrites the shared legacy `google.oauth` key (deviation 1).

## Verification (run in the worktree; fix before presenting)

1. `bun run typecheck` and `bun run typecheck:tests` (the exhaustive-record census).
2. `bun test packages/gateway/src` (unit, incl. `sync/sync-capabilities.test.ts`, `connectors/*calendar*`, `index/item-set-store.test.ts`).
3. `bun test packages/gateway/test packages/cli` (integration and e2e trees: `test/integration/briefing/calendar-sync.test.ts`,
   `test/unit/connectors/lazy-mesh/connector-spawns.test.ts`, the CLI connector tests).
4. The WHOLE `packages/gateway/src/security-invariants.test.ts` (it pins the capability census, the I29 sync
   class and the I1/I15 spawn wiring that Task 2 touches): `bun test packages/gateway/src/security-invariants.test.ts`.
5. `bun run audit:invariants` (D24 etc.), `bun run audit:status-drift`, `bun run audit:connector-registry-drift`,
   `bun run audit:connector-version-skew`, `bun run audit:connector-hosts`, `bun run gen:connector-write-manifest`
   (no diff), `bun run audit:lane-census`, `bun run audit:doc-refs`.
6. `bun run preflight:fast`, then `bun run preflight` if logic or tests were touched (they were). Optionally
   `bun run verify:docker --changed` to reproduce Linux-only failures (the sandbox-dependent connector-spawn tests).
7. Red-proof log for the PR description: the scoping of `replaceItemSet` (service predicate removed -> red; prefix
   removed -> red), the own-key-only rule (shared fallback restored -> red in `google-access-token`,
   `connector-configured` and `connector-spawns`), the outl3-as-mail-only decode (decoder returns `undefined` for
   outl3 -> the mail-not-reset test red).
8. Do not merge with checks pending; open the PR (do not ask), PR checks per CLAUDE.md. Connectors-release ordering:
   0.13.0 must be on npm before the PR's `Dependency audit` and skew gate can pass (Task 0).

## PR title

`feat(gateway): Google Calendar and Outlook calendar events are indexed, with the normalized event keys (Phase 10 MB2b)`

(No `!`: nothing an existing user must change. Put the reasoning, the spec deviations, the red-proof log and the
owner action — Google sensitive-scope verification for `calendar.readonly` — in the PR description; no
`Release-As:` line.)
