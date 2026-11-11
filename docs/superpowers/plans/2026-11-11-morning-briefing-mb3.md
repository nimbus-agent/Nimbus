# Plan — Morning briefing MB3: on-call shifts (PagerDuty `/oncalls`, JSM Operations schedules), `oncall.now`, `nimbus oncall now`, the `oncall_now` agent tool

Spec: `docs/superpowers/specs/2026-11-11-morning-briefing.md` (approved, round 2): § 2 (OR-10-13), § 4 (slices),
§ 5.0 (`replaceItemSet`), § 5.3 (MB3's design), § 5.5 (the `oncall.now` / allowlist / demo notes), §§ 6-8.
Roadmap row: Phase 10 *On-call schedule awareness* (the Incident Correlation Engine group).
Builds on MB1 (PR #1969, treated as merged): the `SyncCapabilities` pattern, the cursor-field pacing
(`snapAt`), `connectors/_lib/work-snapshot-run.ts`, the scoping hole fix for local-only syncables.

MB3 adds NO schema (the shifts are `item` rows of a new type), NO HITL type, NO invariant, NO egress class and no
model step. It adds one IPC method (`oncall.now`), one CLI subcommand (`nimbus oncall now`), one read-only agent tool
(`oncall_now`), one line in the `nimbus oncall` incident brief, and two sync steps that make requests inside the
existing `pagerduty` and `jira` syncs.

After MB3: the index holds `oncall_shift` items per source (PagerDuty, JSM Operations), refreshed at most every 15 minutes
inside the two existing syncs; `nimbus oncall now --service payment-service` and (with a remote model vendor) `nimbus ask
"who's on call for payment-service right now?"` answer from the index with no live API call at question time; the incident
brief says who is on call for the incident's service.

## Spec deviations (checked against the code; each has its evidence and the correction this plan makes)

Where the spec is right the plan follows it. Where the code disagrees the correction below is binding for MB3; the later
slices it affects (MB5) are named.

1. **`oncall.now` is already LAN-forbidden; "added to `FORBIDDEN_OVER_LAN`" needs no entry (§ 5.3).** Evidence:
   `ipc/lan-rpc.ts:60-63` lists the WHOLE namespace `"oncall"` ("`oncall.pushed*` ... The WHOLE namespace"), and the set is a
   DENYLIST, so every `oncall.*` method is forbidden by default. Correction: no edit to `lan-rpc.ts` except its comment (it
   says `oncall.pushed*`; add `oncall.now`); add a pin in `lan-rpc.test.ts` and the I5/I7 section of
   `security-invariants.test.ts` that `checkLanMethodAllowed("oncall.now")` is refused, so a later narrowing of the
   namespace entry to individual methods cannot silently open it. (MB5 repeats this for `briefing.*`, where a new entry IS
   needed.)
2. **`oncall.now` cannot be added to the existing `oncall-push-rpc.ts` handler table (§ 5.3 is silent).** Evidence:
   `ipc/server/dispatchers.ts:1514` `tryDispatchOncallPushRpc` returns `phase4RpcSkipped` unless
   `ctx.options.oncallPushRpcCtx` is set, and that ctx carries only the push `runtime` (`ipc/oncall-push-rpc.ts:20`), no
   database or config dir. Correction: a new module `ipc/oncall-now-rpc.ts` and a new dispatcher `tryDispatchOncallNowRpc`
   in `PHASE4_PLATFORM_DISPATCHERS` placed BEFORE `tryDispatchOncallPushRpc`; it reads `ctx.options.localIndex` and
   `ctx.options.configDir` (both already on `ServerCtx.options`; the demo dispatcher at `dispatchers.ts:1055` uses the same
   two), so it works in a demo gateway (§ 5.5) and needs no new `ipcOpts` field. `dispatchByMethod` returns a miss for a
   method it does not own, so the push dispatcher still sees `oncall.pushed*`.
3. **The fetch-host boundary does not govern scheduled syncs, so "api.atlassian.com is already allowlisted" (§ 6) is the
   wrong reason and proves nothing for the gateway (§ 6 and the task brief).** Evidence: `sync/fetch-host-boundary.ts`
   answers one question, which hosts a TARGETED fetch-on-miss (`fetchOne`) may be aimed at (`FetchableService`: github,
   gitlab, bitbucket, jenkins, jira); a scheduled `Syncable.sync` calls global `fetch` directly (`jira-sync.ts:261`,
   `pagerduty-sync.ts:276`) and no gateway-side rule pins its hosts. The `api.atlassian.com` entry in
   `connectors/lazy-mesh/first-party-manifests.ts:74,82` is the connector CHILD's sandbox network list, which a
   gateway-process `fetch` never consults; `audit:connector-hosts` (`scripts/structure-audit/check-connector-hosts.ts`)
   scans the connectors package, not gateway syncables. The I29 row IS in place: `sync/scheduler.ts:997` appends one
   `sync.run` row (destination = the SERVICE id `jira` / `pagerduty`, never a host, `egress/sync-egress.ts`) before
   `connector.sync`, covering every request the run makes. Correction (this is new security surface, so it is built, not
   assumed): the Jira credential, which until now went only to the owner's configured `base_url` host, will also go to ONE
   fixed host. The plan therefore (a) hard-codes `https://api.atlassian.com/jsm/ops/api` as a constant (never taken from
   the Vault, the cursor or a reply), (b) validates the cloud id with the existing `isAtlassianCloudId`
   (`connectors/atlassian-cloud-id.ts`) before it enters a path, (c) sends every request of the step with
   `redirect: "manual"` and treats any 3xx as a failure (the connector child does the same, `jira/src/tools.ts`
   `refuseRedirect`; the existing sync `fetch` calls follow redirects, and the new ones must not), (d) issues the
   `tenant_info` lookup only for an https `*.atlassian.net` site (the connector's `isAtlassianCloudHost`), (e) pins all of
   this with a source test that names the host constant and the `redirect: "manual"` option, and (f) states the bound in
   `SECURITY-INVARIANTS.md` under I29's sync paragraph: `nimbus prove` shows `jira`, not `api.atlassian.com`.
4. **JSM `flat=true` cannot carry the data § 5.3 needs, and the on-call replies carry no shift times.** § 5.3 asks for
   `GET .../schedules/{id}/on-calls?flat=true` and `is_me` by the `/myself` accountId. The flat form returns recipient
   e-mail addresses only (documented `onCallRecipients`), and Jira hides e-mail addresses by default (the spec's own D-MB-1
   reason), so an accountId can never be compared against it. The non-flat form returns participants
   (`onCallParticipants[{id, name, type}]`, the `id` of a user being the Atlassian account id). Neither form documents a
   start or end of the shift (the time-bearing endpoint is `.../timeline`, not in the spec). Correction: request WITHOUT
   `flat` (the default form) for both `on-calls` and `next-on-calls`; keep entries of `type: "user"` only (a team or
   escalation participant is skipped and counted); `is_me` = participant `id` equals the `/myself` `accountId`;
   `start_ms` and `end_ms` are `null` for JSM rows; a JSM row carries an extra metadata key `shift`: `"current"` or
   `"next"` (the reader cannot tell them apart by time). `until <time>` is omitted from a JSM title (the spec already omits
   it when `end_ms` is null). `.../timeline` for real shift times is recorded as a follow-up, not built. Reply shapes are
   from the documented API and are NOT verified against a live site (spec § 8 already states this); the parser accepts the
   body at the root or under `data`/`result` and every key defensively.
5. **§ 5.3 says the Jira snapshot (MB1) "already reads" the `/myself` accountId. It does not.** Evidence: MB1's plan,
   deviation 2 (the Jira JQL is `assignee = currentUser()`, resolved by Jira; no `/myself` call exists in `jira-sync.ts`).
   Correction: MB3 adds its own `GET {base_url}/rest/api/3/myself` (limiter key `jira`, one request per refresh, no cache:
   a cached id would survive a re-auth as a different user). A failure leaves `is_me` false for JSM rows (stated bound).
6. **"Registered with the existing read-only index tools" does not give `nimbus ask` the tool on every path (§ 5.3, § 1).**
   Evidence: the Mastra engine agent (`engine/agent.ts` `baseTools`) is constructed only when a remote vendor is enabled
   (`gateway-main.ts:176-185`: "NO ENABLED VENDOR MEANS NO REMOTE INFERENCE ... the agent is NOT CONSTRUCTED"), and the
   `prefer_local = true` path has no tool calling at all (the W6-B.2 note in `docs/roadmap.md`). The MCP server's index
   tools (`INDEX_TOOL_SPECS`) are a different registry. Correction: the tool is added to `baseTools` as the spec says;
   for the paths without tools the answer comes from ranked retrieval over the shift rows, so each row's FTS-visible text
   is made to carry what a question names: the title is the spec's (`On call: <user> — <schedule or policy> (level N)
   until <time>`), and `bodyPreview` lists the escalation policy and the service NAMES it covers. The acceptance test
   covers `nimbus oncall now`; the `nimbus ask` half is stated as "answers when the tool is offered, or when ranked
   retrieval surfaces the row" (at `metadata_only` depth the body is blanked by `applyDepth`, so only the title is
   searchable; stated). The MCP index tools are NOT extended (out of scope; `TOOL_SPECS` stays 21).
7. **`--service payment-service` cannot work from the spec's matching rule alone.** § 5.3 matches a `[ci.service.<id>]`
   binding's PagerDuty service id against `service_ids`, else a schedule/policy name. A PagerDuty SERVICE name
   ("payment-service" as PagerDuty knows it) with no binding is matched by neither. Correction (additive metadata):
   each PagerDuty row also stores `service_names` (the names of the services whose escalation policy this is, from the same
   `/services` reply), and the matcher tries, in order: binding id -> `service_ids`; the term itself as a raw PagerDuty
   service id; `service_names`; schedule or policy name. First tier with a match wins and the result says which tier
   (`resolvedVia`), so a wrong guess is visible. Equality (case-insensitive, trimmed) is tried before substring within a
   tier.
8. **Pacing state lives in the cursor and the existing cursors DROP unknown keys.** Evidence: `pagerduty-sync.ts:21-30`
   `decodeCursor` rebuilds `{ lastUpdated }` and returns `null` without it (a cold start), and BOTH of its cursor-encoding
   sites (`partialSyncResult` and the final return) write only `lastUpdated`; `jira-sync.ts:42-60` rebuilds
   `{v, floorJql, snapAt}` (MB1) the same way. Correction: `PdCursorV1 = { lastUpdated: string; ocAt?: number }`;
   `JiraSyncCursorV1` gains `ocAt?`, `ocUntil?`, `cid?`, `cidSite?`; each decoder keeps the new keys and each encoder
   writes them (tests round-trip every one, including the early-return paths). `nimbus index rebody` clears the cursors, so
   it also forces an on-call refresh (the right behaviour, as for MB1).
9. **A refresh must not delete what it did not fully see (§ 5.3: "rows not returned are deleted").** The spec's snapshot
   semantics are right for a COMPLETE fetch. Correction, MB1's partial/capped split applied here with the opposite
   capped rule (a capped on-call page set can omit the CURRENT shift, so it must not delete): **complete** = every request
   of the source's step succeeded and no cap was hit -> upsert, then `replaceItemSet("oncall_shift", keep)`;
   **partial or capped** (a request failed, a page did not parse, `more` still true after 10 PagerDuty pages, more than 50
   JSM schedules, the 60 s step budget ran out) -> upsert what was read, call NO replace, log `oncall_partial: true`. The
   metadata key `fetched_at_ms` (additive) is set on every upserted row, so the reader's data age is per row and a row a
   failing refresh never touches visibly ages. Service-map failure alone (the `/services` request) is NOT partial for the
   on-call set: rows are written with `service_ids: []` and `service_map_complete: false`, and replace proceeds.
10. **`item.external_id` is unique per SERVICE across types (`UNIQUE(service, external_id)`, `index/unified-item-v3-sql.ts`),
    not per type.** A shift id such as a bare schedule id could collide with a PagerDuty incident id (`P...`) or a Jira
    issue key. Correction: every shift external id starts `oncall:` (`oncall:pd:<policy>:<level>:<schedule|->:<user>:<start|->`,
    `oncall:jsm:<schedule>:<current|next>:<participant id>`), and `replaceItemSet("oncall_shift", ...)` is by TYPE so
    incident and issue rows are never touched.
11. **The scoping hole MB1 found applies to `replaceItemSet` too.** `buildLocalOnlySyncCapabilities` builds its db members
    with `buildSyncCapabilities(deps, "github")`, so a local-only syncable (`obsidian`, `filesystem`, `blame`, `openapi`)
    would inherit a `replaceItemSet` that deletes GITHUB rows of any type. Correction: the local-only set overrides it with a
    refusal (as MB1 did for `replaceWorkSnapshot`). Noted, not changed: the existing `deleteItem(service, externalId)` takes
    the service as a parameter and is unscoped; MB3 does not use it.
12. **The `nimbus oncall` brief carries the new line to external callers.** `agents.oncall` is "eligible" for external
    surfaces in its explicit `--incident`/`service` shape (`ipc/agents-rpc.ts:1487`), so the on-call person's name now
    reaches an MCP/HTTP caller's model. This is the class of data the brief already carries (`assignee_emails`); stated,
    not gated. The agent tool's output omits e-mail addresses (names, schedule, level and `is_me` answer "who"; an address
    reaching a cloud model adds nothing); `oncall.now` over IPC and `--json` keep them (local owner only).
13. **Cosmetic: the tool id.** Sibling tools are camelCase (`searchLocalIndex`, `getAuditLog`); the spec names `oncall_now`.
    Kept as the spec names it (the model sees only the id and description).

Spec claims verified correct (no deviation): `pagerduty.from_email` is a Vault key (`connector-secrets-manifest.ts:27`,
read by `readConnectorSecret(vault, "pagerduty", "from_email")`), so `ctx.getSecret("from_email")` type-checks; `jira.cloud_id`
is in the manifest (`:21`) so `ctx.getSecret("cloud_id")` type-checks and is the same value the connector child gets
(`jiraCloudIdEnv`); the limiter keys `pagerduty` and `jira` exist (`sync/rate-limiter.ts`, 60 rpm, burst 10, a closed
`Provider` union, so JSM requests use `jira`); the connector's alert tools use Basic `email:api_token` against
`https://api.atlassian.com/jsm/ops/api/{cloudId}/v1` (`mcp-servers` `connectors/jira/src/tools.ts` `opsFetch`), so the same
header from the gateway is what the shipped tools do (whether Atlassian accepts it for the read endpoints on every plan is
unverified; a 401/403/404 is handled, below); `ALLOWED_METHODS` is 126 (`gateway_bridge.rs:993`, pinned at two sites in
`security-invariants.test.ts`: lines ~1897 and ~9618); `oncall.pushedList/Get` are on the allowlist and `pushedRetry` is not;
no schema change is needed; `deleteItemByServiceExternal` removes the item row, its FTS and embeddings and its graph
entities (`index/item-store.ts:274`, `deleteGraphEntitiesForItemKeys`), and a connector removal
(`deleteAllItemsForService`) already takes a service's shifts with it; PagerDuty's `/users/me` answering 400 for an
account-level token is the spec's claim and cannot be checked offline (stated bound, as in the spec).

## Rebase rule for `replaceItemSet` (MB2b adds it in parallel)

`SyncCapabilities.replaceItemSet(type, keepExternalIds, opts?: { endBeforeMs?: number }): number` is added by whichever of
MB2b and MB3 merges FIRST.
- **If MB2b has merged when MB3 starts (or before MB3 merges): do NOT add it.** Skip Task 1 entirely, reuse the member
  exactly as MB2b shipped it (its signature, its store file, its refusal for local-only and unbound contexts), call it
  with the two-argument form only (`ctx.replaceItemSet("oncall_shift", keep)`), and add MB3's tests that call it through
  the real capability. If MB2b's semantics differ from the text in Task 1 (for instance in what `opts.endBeforeMs` means or
  in whether an empty keep set deletes everything), MB3 adapts to MB2b's, never the reverse; the only behaviour MB3 relies
  on is: deletes THIS service's rows of `type` whose external id is not in the keep set, an empty keep set deletes them all,
  through the `deleteItem` path, in one transaction, returns the count. Add a test in MB3 that asserts exactly those four
  properties if MB2b's tests do not.
- **If MB3 merges first: Task 1 adds it, in full, per spec § 5.0** (including the optional `opts.endBeforeMs`, which MB3
  does not call), so MB2b's rebase is "delete my copy, keep my calendar tests". Use the file and member names below
  (`index/item-set-store.ts`, `replaceItemSet`); if MB2b's PR is open with different names, the second PR to merge
  renames to the first's.
- Either way the interface test (`sync-capabilities.test.ts` pinned key list), `connector-sync-test-helpers.ts` `Pick<>`
  list and `buildLocalOnlySyncCapabilities` / `unboundSyncCapabilities` need exactly one `replaceItemSet` entry each; after a
  rebase run `git grep -n replaceItemSet` and confirm one definition, one local-only refusal, one unbound refusal.
- Decide at Task 0 by `git log origin/main --oneline -- packages/gateway/src/sync/sync-capabilities.ts | head` and
  `git grep -n replaceItemSet origin/main`, and re-check immediately before opening the PR (the PR description states
  which branch of this rule applied).

## Design decisions

- **Two refresh steps, each inside an existing syncable, each fail-soft.** A step is wrapped so that nothing it throws
  (a `RateLimitError`, a 401, a parse error) fails the incident or issue sync that already succeeded; it logs and records
  its attempt in the cursor. Each step lives in its own module (`connectors/pagerduty-oncall.ts`, `connectors/jsm-oncall.ts`)
  so `pagerduty-sync.ts` and `jira-sync.ts` stay readable and every function stays under cognitive complexity 15 (Sonar
  S3776).
- **15 minutes, a constant.** `ONCALL_REFRESH_INTERVAL_MS = 15 * 60_000` (`connectors/oncall-shift-items.ts`); the attempt
  time is the cursor field `ocAt` (an ATTEMPT, success or failure, so a failing provider is retried once per interval, the
  MB1 rule). No config key (the spec has none and MB5's `[briefing]` table has none for it). Tests drive time through an
  old `ocAt` in the cursor, not a clock fake. JSM answers 401/403/404 (no Operations on the plan, a scoped token) ->
  `ocUntil = now + 6 h` so an unavailable feature is not retried every 15 minutes; a later refresh after `ocUntil` tries
  again.
- **One shared shift model.** `index/oncall-shift-types.ts` (pure: the type name `oncall_shift`, the metadata type
  `OncallShiftMeta`, the sources) is imported by the writers and the reader; `connectors/oncall-shift-items.ts` builds the
  title, external id, `bodyPreview` and metadata and calls `ctx.upsertItem`. Fixtures in tests are produced by running the
  real writer and reading the rows back (memory: build fixtures FROM the writer), never hand-written rows.
- **Rows.** `service` = `pagerduty` or `jira`; `type` = `oncall_shift`; `modifiedAt` = refresh time; `authorId` = null (no
  person is created: this keeps the person graph untouched); `url` = the schedule's or policy's `html_url` when present;
  not in `PROSE_HEAVY_TYPES` (local 384-dim embedding, like `apple:event`). Metadata is the spec's plus the additive keys of
  deviations 4, 7 and 9: `source`, `user_name`, `user_email`, `escalation_policy_id`, `escalation_policy_name`,
  `escalation_level`, `schedule_id`, `schedule_name`, `start_ms`, `end_ms`, `service_ids`, `service_names`,
  `service_map_complete`, `is_me`, `fetched_at_ms`, and for JSM `shift`. `start_ms` and `end_ms` are OMITTED when unknown
  (MB1's "omission over guessing"; the reader treats both absent and `null` the same, as `end_ms: null` = open-ended per the
  spec). A user's e-mail is stored only when the provider returned a usable address (`usableActorEmail`,
  `connectors/actor-email.ts`).
- **Reader semantics (`index/oncall-now-query.ts`).** Read all `oncall_shift` rows (bound parameters; a few hundred at
  most), parse metadata defensively, classify at read time (a row's currentness depends on `now`, not on the last refresh):
  with `start_ms`/`end_ms` present, current = `start <= now < end` (absent start = since forever, absent end = open
  ended); without both (JSM), `shift` decides; upcoming = a timed row with `start > now`, or a JSM `next`. Result:
  `{ status, asOfMs, query, resolvedVia, sources, shifts, next, gaps }`. `status` is one of `ok`, `none_on_call` (data
  exists and matched, nothing covers now: an answer), `no_match` (the term matched nothing; `known` lists up to 20
  schedule/policy/service names so the user can retry), `no_data` (no `oncall_shift` row at all: no source connected or
  none synced yet, with a `gaps` line naming PagerDuty and JSM). The refusal shapes exist for the reason `nimbus oncall`'s
  refusal does: an empty list reads as "nobody is on call", the one wrong answer that looks right. `sources[]` carries per
  source the OLDEST `fetched_at_ms` among the rows it contributed (conservative age) and `stale: true` when older than 60
  minutes (four refresh intervals). Caps: 50 current and 50 upcoming rows, upcoming also limited to 7 days ahead.
  Deterministic order by schedule/policy name then level then user name (code-unit comparator, no bare `.sort()`).
- **Why the reader does not call a provider.** Spec § 1: no live API call at question time. The CLI test and the
  integration test disable `fetch` and assert it is never called.
- **Service resolution lives with the callers, matching in the reader.** The caller (IPC handler, agent tool, brief) loads
  the `ServiceConfig` list (`loadNimbusServiceConfigsFromConfigDir`, which THROWS on a malformed block) through one new
  helper `config/service-configs.ts` `loadServiceConfigsOrEmpty(configDir, warn)` (degrade, never abort the read; the
  existing three private copies are left alone, they are out of scope) and passes `{ serviceId, pagerdutyServices }[]` to the
  reader, which stays config-free and pure over the database.
- **No new invariant, no new static rule.** `oncall_shift` rows are written only by the two syncables; that is enforced
  by the capability (a syncable can write only through `upsertItem`/`replaceItemSet` bound to its own service), not by a new
  text rule. I11 (the tool's output is wrapped by `wrapToolForLlm`), I5 (LAN), I7 (allowlist), I29 (sync class) and I41
  (demo) are exercised by tests, with their prose counts updated.
- **No notification, no long-running classification.** `oncall.now` is a synchronous read of the local index (milliseconds):
  not in `NO_TIMEOUT_METHODS` (stays 8), no progress notification, nothing for `GLOBAL_BROADCAST_METHODS` (stays 1). The
  Rust test asserts `!is_no_timeout_method("oncall.now")`. (The briefing's `briefing.ready` notification is MB5's.)
- **Demo (§ 5.5, I41).** `oncall.now` serves whatever index the gateway holds; a demo gateway's index is the synthetic Acme
  corpus, so nothing real can appear. `demo-gate.ts` needs no entry (the method brings no credentials or data in). So that
  the demo is not empty, the corpus gains three `oncall_shift` rows, one per Acme service (Task 11). The PagerDuty and JSM
  refresh steps do not run in a demo gateway because the demo registers no syncs (I41, unchanged).

## File map

New:
- `packages/gateway/src/index/item-set-store.ts` (+ `.test.ts`) — ONLY if MB2b has not merged (rebase rule)
- `packages/gateway/src/index/oncall-shift-types.ts`
- `packages/gateway/src/index/oncall-now-query.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/oncall-shift-items.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/pagerduty-oncall.ts` (+ `.test.ts`)
- `packages/gateway/src/connectors/jsm-oncall.ts` (+ `.test.ts`)
- `packages/gateway/src/config/service-configs.ts` (+ `.test.ts`)
- `packages/gateway/src/ipc/oncall-now-rpc.ts` (+ `.test.ts`)
- `packages/gateway/src/ipc/server/dispatchers-oncall-now.test.ts`
- `packages/gateway/src/engine/oncall-now-tool.ts` (+ `.test.ts`)
- `packages/cli/src/commands/oncall-now.ts` (+ `.test.ts`)
- `packages/gateway/test/integration/briefing/oncall-shifts.test.ts`

Modified: `sync/sync-capabilities.ts` (+ test; only if Task 1 applies), `connectors/connector-sync-test-helpers.ts` (same),
`connectors/pagerduty-sync.ts`, `connectors/jira-sync.ts` (+ their tests), `ipc/server/dispatchers.ts`, `ipc/lan-rpc.ts`
(comment) and `lan-rpc.test.ts`, `engine/agent.ts` (+ `agent.coverage.test.ts`, `agent.test.ts`), `gateway-main.ts`,
`agents/oncall.ts`, `agents/_lib/oncall-types.ts`, `agents/_lib/render.ts` (+ `oncall-render.test.ts`, the fixtures named in
Task 10), `packages/cli/src/commands/oncall.ts`, `commands/help.ts`, `packages/ui/src-tauri/src/gateway_bridge.rs`,
`packages/gateway/src/security-invariants.test.ts`, `packages/gateway/src/demo/corpus/acme.ts` (+ `acme.test.ts`), and the
docs and skills listed at the end.

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. Work in a fresh worktree from current `main` with MB1 merged:
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-mb3 -b dev/asaf/p10-mb3 main`
   (absolute path, never nested). Verify `git rev-parse --abbrev-ref HEAD` before every commit. `bun install`; build the
   sandbox helper only if a sandbox test is later run. Trust `bun run typecheck`, not editor diagnostics.
2. Check the three things this plan assumed and re-number or re-point where they moved:
   - MB1 is on `main`: `git grep -n "replaceWorkSnapshot" packages/gateway/src/sync/sync-capabilities.ts` finds it.
   - The `replaceItemSet` state (rebase rule above): `git grep -n replaceItemSet`.
   - `ALLOWED_METHODS.len()` is 126: `grep -n "ALLOWED_METHODS.len()" packages/ui/src-tauri/src/gateway_bridge.rs`. If another
     slice merged first the number is higher; use number + 1 everywhere this plan says 127 (the count follows merge order;
     MB5's 131 then follows too).
3. Baseline: `bun test packages/gateway/src/connectors/pagerduty-sync packages/gateway/src/connectors/jira-sync` GREEN before
   any edit, so a later red is attributable.

### Task 1 - `replaceItemSet` capability (ONLY if MB2b has not merged)

Files: `index/item-set-store.ts` (new), `sync/sync-capabilities.ts`, `sync/sync-capabilities.test.ts`,
`connectors/connector-sync-test-helpers.ts`.

1. Tests first (`item-set-store.test.ts`, real SQLite via `openMemoryIndexDatabase`):
   - deletes this service's rows of the type that are not in the keep set, returns the count, leaves the keep set;
   - an EMPTY keep set deletes all of that (service, type);
   - rows of another TYPE of the same service and rows of another SERVICE with the same external id are untouched;
   - the delete goes through the `deleteItem` path: seed an embedding row, an FTS hit and a graph edge for a doomed item
     (the way `item-store.test.ts` does) and assert all three are gone;
   - one transaction: a delete that throws part-way (inject a failing delete through a `db` wrapper whose second `dbRun`
     throws) leaves every row;
   - `opts.endBeforeMs`: only rows whose `json_extract(metadata, '$.end_ms') < endBeforeMs` are candidates (and still must
     be absent from the keep set); a row with no `end_ms` is never a candidate under it;
   - a keep set over 20,000 ids throws (a bug guard; the implementation reads the service's ids and diffs in JS, it never
     builds a giant `IN (...)`).
   RED first.
2. `sync-capabilities.test.ts`: the pinned key list in the "exposes no raw handle" test gains `"replaceItemSet"`;
   SCOPING: a capability built for `pagerduty` deletes only `pagerduty` rows (seed `jira` rows of the same type and external
   ids, call, assert untouched); `unboundSyncCapabilities().replaceItemSet(...)` throws `^replaceItemSet was called on an
   unbound SyncContext`; `buildLocalOnlySyncCapabilities(deps, "obsidian").replaceItemSet(...)` throws (the local-only
   message; deviation 11) and github rows are untouched. RED first.
3. Implement: `replaceItemSetRows(db, service, type, keep, opts?)` in `index/item-set-store.ts` (reads
   `SELECT external_id FROM item WHERE service = ? AND type = ?` bound, diffs against the keep `Set`, deletes each through
   `deleteItemByServiceExternal` inside `db.transaction`; writes only through that function and `dbRun`, I9/I14, static
   D12). The capability binds the service from the closure (never a parameter). Interface doc: scoped to the bound service,
   one transaction, returns the deleted count. Add the local-only override and the unbound refusal. Add `"replaceItemSet"` to
   `silentSyncContextExtras`'s `Pick<SyncContext, ...>` in `connector-sync-test-helpers.ts`. Run `bun run typecheck` and
   `bun run typecheck:tests`: any other literal typed as `SyncCapabilities` fails to compile (MB1's census).
4. GREEN: `bun test packages/gateway/src/index/item-set-store.test.ts packages/gateway/src/sync`.

### Task 2 - The shared shift model and writer

Files: `index/oncall-shift-types.ts`, `connectors/oncall-shift-items.ts` (+ test).

1. Tests first (`oncall-shift-items.test.ts`, `createSyncTestContext` bound to `pagerduty`, real SQLite):
   - title: PagerDuty with end -> `On call: Alice Ng — Payments primary (level 1) until 2026-11-12 08:00 UTC`; `end_ms`
     absent/null -> no `until` part; no schedule -> the policy name is used; no level (JSM) -> no `(level N)`; JSM next ->
     `Next on call: ...`; a user or schedule name longer than 120 characters or with a newline/control character is cut and
     flattened (the title feeds FTS and a terminal);
   - external id is `oncall:pd:...` / `oncall:jsm:...`, stable across two builds of the same shift, different for a
     different start, never equal to a PagerDuty incident id;
   - `bodyPreview` lists `Escalation policy: <name>. Covers: <service names>.`; with no service map it says
     `Covers: (unknown)` and not an empty string;
   - metadata has exactly the keys listed in "Rows" (a key-set equality test, so a later addition is deliberate), omits
     `start_ms`/`end_ms` when unknown, never stores an address that is not a usable e-mail, and always carries
     `fetched_at_ms` and `is_me`;
   - the row lands through `ctx.upsertItem` (read it back from `item`; `type` = `oncall_shift`).
   RED first.
2. Implement `OncallShiftMeta`, `ONCALL_SHIFT_ITEM_TYPE = "oncall_shift"`, `ONCALL_REFRESH_INTERVAL_MS`,
   `ONCALL_STALE_MS = 60 * 60_000` in `index/oncall-shift-types.ts` (pure: no db, no fetch), and `upsertOncallShift(ctx,
   shift, nowMs)` + `oncallShiftExternalId`, `oncallShiftTitle` in `connectors/oncall-shift-items.ts`.
3. GREEN.

### Task 3 - PagerDuty: `/oncalls` refresh inside the pagerduty syncable

Files: `connectors/pagerduty-oncall.ts` (new), `connectors/pagerduty-sync.ts`, their tests.

1. Tests first (`pagerduty-oncall.test.ts`, fake `fetch` returning documented-shape JSON, `createSyncTestContext`; the PD
   reply fixtures live in the test as plain objects and every assertion reads `item` rows written by the real writer):
   - request shape: the first request is `GET https://api.pagerduty.com/users/me`; then
     `/oncalls?limit=100&offset=0&since=<ISO now>&until=<ISO now+7d>` with `include[]=users&include[]=escalation_policies
     &include[]=schedules` (assert the three `include[]` values and both bounds); then `/services?limit=100&offset=0
     &include[]=escalation_policies`; all with `Authorization: Token token=<trimmed token>` and the
     `application/vnd.pagerduty+json;version=2` Accept header; each request preceded by `rateLimiter.acquire("pagerduty")`
     (spy), and NO request goes to any other host;
   - mapping: an `oncalls` entry with user, `escalation_policy`, `escalation_level`, `schedule`, `start`, `end` becomes one
     row (assert every metadata key); an entry with `schedule: null` and `start`/`end` null is an always-on-call row with no
     time keys and a title without `until`; an entry whose user object carries no email stores `user_email` absent; an entry
     with no user is skipped and counted;
   - service mapping: `/services` replies `[{id: "P1", name: "payment-service", escalation_policy: {id: "EP1"}}, ...]` ->
     the policy `EP1` row gets `service_ids: ["P1"]`, `service_names: ["payment-service"]`, `service_map_complete: true`;
     two services on one policy list both; a policy with none gets `[]`;
   - `is_me`: `/users/me` returns `{user: {id: "U1", email: "me@x.com"}}` -> rows whose user id is `U1` are `is_me: true`;
     `/users/me` answers 400 and `from_email` is `me@x.com` (through `ctx.getSecret("from_email")`) -> match by e-mail,
     case-insensitive; 400 and no `from_email` -> every `is_me` false and the log line names the bound; a network error on
     `/users/me` behaves as the 400 case and the step continues;
   - paging: two `oncalls` pages with `more: true` then `false` -> 3 requests for oncalls (offset 0, 100); a reply with
     `more: true` forever stops at 10 pages, upserts everything read, calls NO replace and logs `oncall_partial: true`
     (deviation 9); `/services` with `more: true` forever stops at 5 pages and rows carry `service_map_complete: false` while
     replace STILL runs;
   - snapshot semantics (needs `replaceItemSet`): a second refresh whose reply omits shift A deletes A's row, leaves another
     source's rows and PagerDuty INCIDENT rows alone, and returns an empty-keep deletion when the reply is a valid empty
     `oncalls: []` with `more: false` (an empty complete fetch deletes all); a refresh whose page 2 returns 500 or invalid
     JSON deletes NOTHING (rows from the earlier refresh survive with their old `fetched_at_ms`);
   - a 429 penalises the `pagerduty` limiter and does not throw; a 401 does not throw; neither deletes anything.
   RED first.
2. Tests in `pagerduty-sync.test.ts`: the cursor round-trip keeps `ocAt` (and an old `{lastUpdated}` cursor decodes without
   it); a first sync (cursor null) runs the incident sync AND the on-call step; a second sync with a fresh `ocAt` makes NO
   `/oncalls`, `/users/me` or `/services` request; with `ocAt` older than 15 minutes it makes them; the incident list failing
   (`partialSyncResult` path) still returns a cursor that carries the OLD `ocAt` and does not lose it; the on-call step
   failing leaves the incident `SyncResult` a success and the cursor's `lastUpdated` advanced and `ocAt` advanced (one
   retry per interval); the step never throws out of `sync`; `itemsUpserted` stays the incident count (shifts are not
   added, as MB1 did for snapshots).
3. Implement `connectors/pagerduty-oncall.ts`: `runPagerdutyOncall(ctx, token, nowMs): Promise<OncallOutcome>` where the
   outcome is `{ complete: boolean; upserted: number; deleted: number }`; pure parsers (`parseOncallsPage`,
   `parseServicesPage`, `parseMe`) take `unknown` and narrow with `asRecord`/`stringField` (no `any`); a total byte/ item
   guard (reject a page over 2 MiB). In `pagerduty-sync.ts`: `PdCursorV1 = { lastUpdated: string; ocAt?: number }`
   (decoder keeps `ocAt` when a finite number; BOTH encoders write it; `partialSyncResult` takes it as a parameter); after
   the incident loop (and on the `partialSyncResult` exits as well: factor the loop into a function returning a result so
   the step runs once whichever way it ended) call `pagerdutyOncallIfDue(ctx, token, prev?.ocAt, nowMs)` when
   `snapshotDue(prev?.ocAt ?? null, Date.now(), ONCALL_REFRESH_INTERVAL_MS)` (reuse MB1's pure `snapshotDue` from
   `connectors/_lib/work-snapshot-run.ts`; do not copy it), wrapped so nothing escapes; it returns the new `ocAt`.
4. GREEN: `bun test packages/gateway/src/connectors/pagerduty-oncall.test.ts packages/gateway/src/connectors/pagerduty-sync`.

### Task 4 - JSM Operations: schedules refresh inside the jira syncable

Files: `connectors/jsm-oncall.ts` (new), `connectors/jira-sync.ts`, their tests.

1. Tests first (`jsm-oncall.test.ts`, fake `fetch` keyed on URL, `createSyncTestContext` bound to `jira`):
   - cloud id: `ctx.getSecret("cloud_id")` set to a valid UUID -> NO `tenant_info` request; absent and the base is an https
     `*.atlassian.net` site -> exactly one `GET {base_url}/_edge/tenant_info` with the same Basic header, `redirect:
     "manual"`; reply `{cloudId: "<uuid>"}` -> used and cached in the cursor (`cid` + `cidSite` = the base url), so the NEXT
     refresh makes no `tenant_info` request, and a changed `base_url` invalidates it; a malformed id (wrong length, a `/`
     or `..` in it, a non-JSON body, a 3xx) -> the step stops (no ops request), logs, and writes nothing; a Data Center or
     proxied base (not `*.atlassian.net`) with no stored id -> NO request of any kind, a single `info` log, no failure; a
     stored malformed `cloud_id` is treated as absent (not sent);
   - host pin: every ops request URL starts with `https://api.atlassian.com/jsm/ops/api/<cloudId>/v1/` (assert on all
     recorded URLs), every request in the step is made with `redirect: "manual"`, and a 3xx answer is a failure that sends
     nothing further (deviation 3); no request ever goes to a host taken from a reply (a reply containing an absolute URL
     in a field is ignored);
   - requests: `GET /myself` on the site (not api.atlassian.com) first; `GET .../v1/schedules`; per schedule
     `GET .../v1/schedules/{id}/on-calls` and `.../next-on-calls`, WITHOUT `flat` (deviation 4), the id passed through
     `encodeURIComponent` after a `^[A-Za-z0-9_-]{1,128}$` check (a schedule id that fails it is skipped and counted); each
     request preceded by `rateLimiter.acquire("jira")`;
   - mapping (documented shapes; the parser accepts the body at the root or under `data`/`result`):
     `onCallParticipants: [{id: "acc-1", name: "Alice Ng", type: "user"}, {id: "t1", name: "Team", type: "team"}]` -> one
     `shift: "current"` row for Alice (title `On call: Alice Ng — Primary rotation`, no level, no times) and the team skipped
     and counted; `nextOnCallParticipants`/`nextOnCallRecipients` -> `shift: "next"` rows; a name that looks like an e-mail
     sets `user_email`; `is_me` true when the participant id equals the `/myself` `accountId`, false when `/myself` fails;
   - caps and budget: 60 schedules -> only 50 are read, replace is NOT called, `oncall_partial: true`; a failing
     per-schedule request -> the others are still upserted, no replace; a step running past 60 s (inject the clock) stops
     and is partial;
   - unavailable: `schedules` answering 401, 403 or 404 -> no row written, nothing deleted, `ocUntil` = now + 6 h in the
     returned cursor fields, one `info` log; 429 penalises `jira` and is a failure without `ocUntil`;
   - snapshot semantics as for PagerDuty (complete -> `replaceItemSet("oncall_shift", keep)` bound to `jira`, which leaves
     Jira ISSUE rows untouched; empty complete schedules list deletes all shifts).
   RED first.
2. Tests in `jira-sync.test.ts`: the cursor round-trips `ocAt`, `ocUntil`, `cid`, `cidSite` next to MB1's `snapAt`; an old
   cursor decodes; a sync inside the interval makes no ops request; after the interval it does; inside `ocUntil` it does not
   even if `ocAt` is old; the step fails soft (the incident `SyncResult` is a success); the order in `sync` is incremental
   -> MB1 snapshot -> on-call, and a throw in the snapshot step does not skip the on-call step (and vice versa).
3. Implement `connectors/jsm-oncall.ts`: constants `JSM_OPS_ROOT = "https://api.atlassian.com/jsm/ops/api"`,
   `JSM_MAX_SCHEDULES = 50`, `JSM_STEP_BUDGET_MS = 60_000`, `JSM_UNAVAILABLE_BACKOFF_MS = 6 * 3_600_000`; reuse
   `isAtlassianCloudId`, `basicAuthHeader` and `normalizeAtlassianSiteBaseUrl` (do not re-implement them);
   `runJsmOncall(ctx, creds, cursorFields, nowMs)` returns `{ outcome, cursorFields }`. In `jira-sync.ts` add the four optional
   cursor keys, a sibling of `jiraSnapshotIfDue` called `jiraOncallIfDue`, and the `loadJiraVaultCreds` result is reused (no
   second Vault read of the three secrets; only `ctx.getSecret("cloud_id")` is new).
4. GREEN: `bun test packages/gateway/src/connectors/jsm-oncall.test.ts packages/gateway/src/connectors/jira-sync`.
5. Add the source pin in `security-invariants.test.ts` (next to the I29 sync tests): `connectors/jsm-oncall.ts` names the
   host constant exactly once as a string literal, contains no other `https://` literal except `tenant_info` built from
   the validated base, and every `fetch(` in it passes `redirect: "manual"`. RED-prove by deleting the option.

### Task 5 - The reader `index/oncall-now-query.ts`

1. Tests first (real SQLite; rows seeded THROUGH the Task 2 writer, not by hand):
   - current/upcoming classification at read time: a PagerDuty row `start <= now < end` is current; `end <= now` is
     excluded; `start > now` is upcoming; an always-on row (no times) is current; a JSM `current` row is current and a JSM
     `next` row is upcoming (deviation 4); two reads with different `now` over the same rows give different answers
     without any refresh;
   - `status`: no rows -> `no_data` with a gap naming both sources; rows but none cover now and the term is absent ->
     `none_on_call` with the upcoming list; a term that matches nothing -> `no_match` with `known` (at most 20, deduplicated,
     sorted); otherwise `ok`;
   - matching tiers (deviation 7), each its own test, each asserting `resolvedVia`: binding (`serviceConfigs =
     [{serviceId: "payment-service", pagerdutyServices: ["P1"]}]`, term `payment-service`) -> `service_ids` contains `P1`;
     raw `P1`; `service_names`; schedule/policy name; equality beats substring; case-insensitive and trimmed; a term with
     SQL/regex metacharacters (`%`, `_`, `(`, `\`) matches literally (the reader filters in JS over parsed values, and a
     test passes `%` and `_` to prove no pattern is built);
   - `is_me` rows are reported with `isMe: true` and a top-level `youAreOnCall` boolean;
   - age: per source `oldestFetchedMs` is the minimum over the rows it contributed; `stale` is true past 60 minutes; a row
     with no `fetched_at_ms` (written by nothing today, but a hand-edited index) counts as stale and age unknown;
   - `service_map_complete: false` on any contributing row adds a gap line saying `--service` by PagerDuty service may miss;
   - caps (50 current, 50 upcoming, 7-day horizon) and deterministic ordering with a code-unit comparator;
   - the provider-supplied names are returned as plain strings (envelope and Markdown hardening belong to the callers).
   RED first.
2. Implement `queryOncallNow(db, { nowMs, term?, serviceConfigs })` and the result types (pure over the database, reads only,
   bound parameters, no `fetch`, no config file access). Export `OncallNowResult` for the IPC, tool and brief.
3. GREEN: `bun test packages/gateway/src/index/oncall-now-query.test.ts`.

### Task 6 - IPC `oncall.now`, routing, LAN pin, demo

Files: `ipc/oncall-now-rpc.ts` (new), `config/service-configs.ts` (new), `ipc/server/dispatchers.ts`, `ipc/lan-rpc.ts` (comment),
tests.

1. Tests first:
   - `ipc/oncall-now-rpc.test.ts`: `oncall.now {}` -> the reader's result with `term` null; `{service: "payment-service"}`
     -> filtered; params validation with `-32602`: not an object, `service` not a string, empty after trim, longer than 128
     characters, an unknown key (only `service` is accepted); the config loader failing (a malformed `[ci.service.*]` block)
     degrades to no bindings and still answers (the stderr warning, as `agentServiceConfigs` does) instead of throwing;
     `fetch` is replaced by a thrower for the whole file and never called.
   - `config/service-configs.test.ts`: a valid dir returns the configs; a malformed block returns `[]` and calls `warn`;
     no dir returns `[]`.
   - `ipc/server/dispatchers-oncall-now.test.ts` in the shape of `dispatchers-oncall-push.test.ts`: `oncall.now` reaches the
     new handler through `tryDispatchPhase4Rpc` with `oncallPushRpcCtx` UNSET (deviation 2); `oncall.pushedList` still
     reaches the push handler when both are set (order); an unknown `oncall.zzz` is still "method not found".
   - LAN: in `ipc/lan-rpc.test.ts` and the I5 area of `security-invariants.test.ts`: `checkLanMethodAllowed("oncall.now")`
     is refused (deviation 1) and the `FORBIDDEN_OVER_LAN` set still names `"oncall"` (a source-reading test on the entry,
     so replacing it with per-method entries must be a deliberate edit).
   - Demo (I41): a demo-rooted server built the way `dispatchers.test.ts` builds one serves `oncall.now` over the demo
     index and `demoRefusal("oncall.now")` is `undefined`; `NIMBUS_DEMO` index rows seeded by Task 11 come back.
   RED first (method not found).
2. Implement `ipc/oncall-now-rpc.ts` (`OncallNowRpcError`, `dispatchOncallNowRpc` via `dispatchByMethod`),
   `config/service-configs.ts` `loadServiceConfigsOrEmpty`, and `tryDispatchOncallNowRpc(ctx, method, params)` in
   `dispatchers.ts` (skips unless `method === "oncall.now"` and `ctx.options.localIndex`/`configDir` exist; maps
   `OncallNowRpcError` to `RpcMethodError` like `tryDispatchOncallPushRpc`); insert it in `PHASE4_PLATFORM_DISPATCHERS`
   immediately BEFORE `tryDispatchOncallPushRpc`. Update the `lan-rpc.ts` comment to name `oncall.now`.
3. GREEN: `bun test packages/gateway/src/ipc/oncall-now-rpc.test.ts packages/gateway/src/ipc/server packages/gateway/src/ipc/lan-rpc.test.ts`.

### Task 7 - Tauri allowlist 126 -> 127 (I7)

Read the `nimbus-tauri-allowlist` skill's checklist again before editing; this task is that checklist.

1. Handler exists (Task 6). The method is not in a forbidden category (it reads the local index, writes nothing, brings no
   credentials). It is not long-running, so `NO_TIMEOUT_METHODS` (8) and `GLOBAL_BROADCAST_METHODS` (1) do not change.
2. Tests first, all RED until the Rust edit:
   - `security-invariants.test.ts`: both `allowlist_exact_size` pins (lines ~1897 and ~9618: the test titled
     "allowlist_exact_size assertion is 126" and the regex in the migration test) become 127 (re-derive the lines with
     `git grep -n "ALLOWED_METHODS\\\\.len"`); add `oncall.now` to the named-on-both-sides assertion pattern the SA5 test uses
     (a one-for-one swap must not keep the count): the Rust source contains `"oncall.now",` in the array and
     `assert!(is_method_allowed("oncall.now"));` in `allowlist_oncall_reads_only`.
   - Rust: extend `allowlist_oncall_reads_only` with `assert!(is_method_allowed("oncall.now"));` and
     `assert!(!is_no_timeout_method("oncall.now"));`, keep `oncall.pushedRetry` refused, and bump `allowlist_exact_size` to
     127.
3. Edit `gateway_bridge.rs`: insert `"oncall.now",` alphabetically between `"migration.list",` and `"oncall.pushedGet",`
   (`"oncall.now"` sorts before `"oncall.pushedGet"`: `n` < `p`), bump the assertion.
4. Run from `packages/ui/src-tauri`: `cargo test` (all allowlist tests: size, alphabetized, no-duplicates,
   `allowlist_oncall_reads_only`, `no_timeout_methods_are_subset_of_allowlist`). Expected GREEN; if `cargo` is unavailable
   say so in the PR (the Rust change is a one-line array entry plus two assertions, and the security-invariants pins read the
   source text).
5. Update the "Currently 126 entries" and `== 126` lines in `.claude/commands/nimbus-tauri-allowlist.md` (the skill
   requires it) and the prose in the docs listed below.

### Task 8 - CLI `nimbus oncall now [--service <id|name>] [--json]`

Files: `packages/cli/src/commands/oncall-now.ts` (new), `commands/oncall.ts`, `commands/help.ts`, tests.

1. Structure (verified): `nimbus oncall` is `commands/oncall.ts` `runOncallCommand`, which dispatches
   `args[0] === "pushed"` to `commands/oncall-pushed.ts` (`parse...Args`, a `run...With(c, args, sink, demo)` core with an
   injected IPC client and sink, and a thin `run...` that uses `withGatewayIpc` and `CliExit`). `now` follows that exact
   shape; the brief's own flags (`--incident`, `--service`, `--since`, `--format`) are unchanged and `now` does not accept
   `--incident`, `--since` or `--format`.
2. Tests first (`oncall-now.test.ts`, no `mock.module`: inject the IPC client and sink as `oncall-pushed.test.ts` does):
   - `parseOncallNowArgs`: `[]`, `["--json"]`, `["--service", "payment-service"]`, `["--service=payment-service"]` parse; an
     unknown flag, a missing value, a repeated `--service` or a positional argument returns `undefined` and the runner prints
     the usage and exits 1;
   - the runner calls `oncall.now` with `{}` or `{service}`; a text render per status: `ok` lists each current shift as
     `<service/schedule> -> <user> [<policy>, level N, until <UTC time>] (<source>)` plus ` <- you` for `isMe`, then the
     upcoming list, then one line per source `PagerDuty data 3 min old` / `Jira Service Management data 11 min old`, with a
     `WARNING: older than 1 h; the shift may have changed` line when `stale`; `none_on_call` prints "No on-call shift covers
     now for <term>" and the next shifts, exit 0; `no_match` prints the known names to stderr, exit 1; `no_data` prints the
     gaps (connect PagerDuty or Jira Service Management) to stderr, exit 1;
   - `--json` prints the result object verbatim (one line) and uses the same exit codes; an IPC error prints `{error}` in
     `--json` and the message otherwise, exit 1 (as `runOncallPushedWith`);
   - provider-supplied names are printed through the CLI's existing control-character stripping so a hostile schedule name
     cannot inject terminal escapes (reuse the helper the pushed-brief render uses; if none is exported, add one small
     `stripControl` in `lib/` with a test) and a demo gateway (`paths.demo === true`) prints the demo banner line the other
     commands print.
   RED first.
3. Implement; add `now` dispatch in `runOncallCommand` before `parseOncallArgs`; add the usage line to `USAGE`
   (`nimbus oncall now [--service <id|name>] [--json]`) and to `help.ts`; `registry.ts` already lists `oncall`.
4. GREEN: `bun test packages/cli/src/commands/oncall-now.test.ts packages/cli/src/commands/oncall.test.ts`.
5. An e2e CLI test against a real gateway subprocess is added in Task 12 (the acceptance test), because only the E2E tree has
   the D-Bus session Linux needs.

### Task 9 - The agent tool `oncall_now` (I11)

Files: `engine/oncall-now-tool.ts` (new), `engine/agent.ts`, `gateway-main.ts`, tests.

1. Tests first:
   - `engine/oncall-now-tool.test.ts`: `createOncallNowTool({ localIndex, serviceConfigs })` returns a Mastra tool whose
     `execute({service?})` returns the reader's result MINUS e-mail addresses (a deep check: no `@` string value appears in
     the output for seeded shifts that carry `user_email`); the service argument is clipped to 128 characters and a
     non-string is ignored; a refusal status (`no_match`, `no_data`) is returned as data with a `note` that says to report
     it and not to guess ("Do not name anyone as on call that this result does not name"); it makes no `fetch` call
     (thrower) and writes nothing (no INSERT: assert `db.changes` or run it on a read-only copy).
   - `engine/agent.test.ts` in the shape of the `findPeopleWithoutReviews` envelope test (line ~865): the tool's output
     arrives enveloped, `env.tool === "oncall_now"`, `env.service === "index"`; a shift whose schedule name contains
     `</tool_output>` comes back with the closer escaped (`<\/tool_output>`) and the envelope intact (I11); a `tool_call_log`
     row is written with `tool_id = oncall_now` (the `wrapToolForLlm` path, `auditDb`), success and error.
   - `engine/agent.coverage.test.ts` line ~406: the pinned `builtIns` list gains `"oncall_now"` in sorted position; grep
     every other test that pins the built-in key list (`git grep -n '"traverseGraph",' -- '*.test.ts'`) and update it (the
     connector-write and user-MCP tests assert the built-ins are unchanged).
   - `security-invariants.test.ts` I11 area: the wiring-site table gains `engine/oncall-now-tool.ts` only if it calls
     `wrapToolOutput` itself (it must NOT: the wrap happens in `wrapToolForLlm`, per the skill's anti-pattern table), so add
     instead a source assertion that `engine/agent.ts` registers `oncall_now` through `wrapToolForLlm(` and not bare.
   RED first.
2. Implement `createOncallNowTool` (an `execute` that returns the raw object; `Promise.try` like the negation tools; id
   `oncall_now`; description names what it answers and that it reads the local index only, that the data has an age, and what
   each `status` means). In `agent.ts`: a new optional dep `oncallServiceConfigs?: () => readonly ServiceConfig[]`
   (a function, so a config edit applies on the next call); `baseTools.oncall_now = wrapToolForLlm("index", "oncall_now",
   tool, deps.auditDb)`; one sentence in `toolGuidance`: use `oncall_now` for who is on call; never answer that from
   `searchLocalIndex`. In `gateway-main.ts`: pass `oncallServiceConfigs: () => loadServiceConfigsOrEmpty(platform.paths.configDir,
   warn)` (the `paths` object is already used in this file for `runAsk`).
3. GREEN: `bun test packages/gateway/src/engine`.
4. Not done on purpose (state in the PR): the MCP server's `INDEX_TOOL_SPECS` is not extended, the local-router path has no
   tools (deviation 6), no HITL type and no egress row (local SQLite read; `egress/egress-coverage.ts`'s note that the read-only
   index tools append nothing stays true).

### Task 10 - The "On call now" line in the `nimbus oncall` incident brief

Files: `agents/oncall.ts`, `agents/_lib/oncall-types.ts`, `agents/_lib/render.ts`, tests.

1. Design: `buildOncallBrief` already resolves the incident's binding. It calls `queryOncallNow(db, { nowMs, term:
   binding.nimbusServiceId ?? undefined, serviceConfigs })` restricted to the incident's PagerDuty service id when there is one
   (so an unrelated schedule whose NAME contains the service name does not answer for it); the result is reduced to a small
   `onCallNow` on the brief: `{ status, asOfMs, shifts: [{ userName, scheduleName, policyName, level, endMs, isMe, source }],
   upcomingCount }`. A required field on `OncallBrief` (typecheck is the census of fixtures: `render.coverage.test.ts`,
   `oncall-render.test.ts`, `brief-contract.coverage.test.ts`, `reserved-sections.coverage.test.ts`,
   `fleet-digest-extractors.test.ts`, `admin-console` fixtures that build an `OncallBrief` if any; `git grep -n
   "syncFreshness:" -- '*.test.ts'`). `agentVersion` stays 1 (an additive field, no reader breaks).
2. Tests first (`oncall-render.test.ts`, `oncall.test.ts`):
   - with a PagerDuty shift for the incident's service id the `## Incident` section gains
     `- **On call now:** Alice Ng (Payments primary, level 1, until 2026-11-12 08:00 UTC) (PagerDuty data 3 min old)`; two
     current shifts are both listed in level order; `isMe` adds ` (you)`; `none_on_call` renders
     `_nobody on call per the index (next: Bob from ...)_`; `no_data` renders `_no on-call data indexed_` and the brief's
     `## Gaps` gains a `missing_connector` note (PagerDuty schedules or JSM not synced) with a remediation; an incident with no
     PagerDuty service id renders `_unknown (no service id)_` and no gap about on-call;
   - provider-supplied names are hardened exactly like the e-mail lines around them (`stripLineStructureChars`; a name
     containing a newline plus `## Fake heading` or a backtick cannot start a heading or close a code span);
   - a stale source (older than 60 minutes) renders `(PagerDuty data 2 h old; the shift may have changed)`; this is a plain
     line, not an I31 disclosure (a rewrite that drops it is a stated bound: the brief's deterministic render is the
     authority, and the line sits in a section the synthesizer receives verbatim). If the reviewer insists on the I31
     treatment, the alternative is one `oncallDisclosures` entry with anchors `["on-call data"]`, `["may have changed"]` and a
     `disclosure-anchor-coverage.test.ts` row; not planned because the line is data, not a limitation of the brief;
   - the existing `nimbus oncall` golden/contract tests still pass with the new field present;
   - no new query: `reads` count stays within the budget `oncall.test.ts` asserts for the brief (one extra SELECT).
   RED first.
3. Implement; the CLI `isOncallBriefLike` is unchanged (it validates only the shape it needs and `--json` prints the object
   verbatim).
4. GREEN: `bun test packages/gateway/src/agents`.

### Task 11 - Demo corpus rows

Files: `demo/corpus/acme.ts`, `demo/corpus/acme.test.ts`.

1. Tests first: the seeded demo index holds three `oncall_shift` rows (one per `SERVICES` entry: `payment-service` P `PPAYDEMO`,
   `checkout-web`, `ledger-worker`), the `payment-service` one is `is_me: true` for the demo persona (Sam, via the same
   `emailOf` the incident uses), and `queryOncallNow` with `term: "payment-service"` returns `ok` with Sam; metadata is built
   with the relative-time function the corpus already uses so the shift covers the demo's "now" whenever it is seeded;
   `seed.test.ts`'s item-count expectation (`> 80`) still holds.
2. Implement an `oncallShift(...)` DemoItem factory next to `incident(...)` using the REAL writer's title and metadata builders
   (import `oncall-shift-items.ts` helpers), `service: "pagerduty"`, `type: "oncall_shift"`, `fetched_at_ms` = the seed time.
3. GREEN: `bun test packages/gateway/src/demo`. Then by hand, in a temp config dir only (never real state):
   `NIMBUS_DEMO=1 ... nimbus --demo oncall now --service payment-service` prints Sam as on call (acceptance sandbox via
   `LOCALAPPDATA`, per the repo's acceptance-sandbox practice).

### Task 12 - Integration and e2e acceptance

Files: `packages/gateway/test/integration/briefing/oncall-shifts.test.ts` (loaded only by the whole-repo run; also run it on
its own), plus one case in the CLI e2e tree.

1. Integration (real SQLite, the REAL pagerduty and jira syncables through the production capability set via
   `createSyncTestContext`, fake HTTP per provider):
   - PagerDuty: a user-token fake (`/users/me` ok) -> one refresh -> `queryOncallNow` names the on-call user for
     `payment-service` via a `[ci.service.payment-service]`-shaped `ServiceConfig` binding to the fake's service id; then
     REPLACE `globalThis.fetch` with a thrower and repeat the query: the same answer (spec § 7: "with the HTTP fake
     disabled") and `fetch` call count is 0.
   - Two refreshes: the second omits a shift -> its row is gone, the incident rows survive; a refresh with a failing second
     page -> rows from the first refresh survive and the reader's `oldestFetchedMs` for that source did not move.
   - JSM: a fake with a valid cloud id in the Vault -> rows for the schedule, `is_me` by accountId; the same fake with no cloud
     id and an `*.atlassian.net` base -> exactly one `tenant_info` call and the id cached in the cursor for the next refresh;
     a 403 -> backoff recorded, no rows, nothing deleted.
   - The interval end to end: three syncs 60 s apart (cursor threaded, `ocAt` old/new) make exactly one set of on-call
     requests; an absent cursor (what `index.rebody` leaves) makes one at once.
   - Egress: a pagerduty sync with the on-call step appends exactly ONE `sync.run` ledger row for the run (the scheduler's), not
     one per request (the I29 per-run claim), using the existing test that builds a scheduler over a fake syncable
     (`sync/scheduler` tests show how).
2. Real-gateway e2e (CLI e2e tree, Linux has D-Bus only there): seed an index with a PagerDuty shift through the real
   syncable against a fake PagerDuty HTTP server where the harness allows it, otherwise seed through the writer, start a real
   gateway subprocess, run `nimbus oncall now --service payment-service --json`, assert the on-call user and `status: "ok"`;
   the same with `--demo` (acceptance: spec § 1 "no live API call at question time").
3. `bun test packages/gateway/test/integration/briefing`.

### Task 13 - Coverage and cleanup

- Every new file falls under an existing coverage scope (connectors, index, ipc, engine, cli): every new function has a test
  that executes it, branches included (`audit:coverage-floor`, Linux-authoritative, 85 % line / 80 % branch per file). The
  `test:coverage:*` scripts are not the gate; if Docker is available run `bun run verify:docker --full`, otherwise review
  branch by branch and say so in the PR.
- Biome (as `preflight:fast`), no `any` (all external JSON is `unknown`, narrowed with `asRecord`/`stringField`), no bare
  `.sort()` (S2871), every new function under cognitive complexity 15 (S3776; split by PHASE into named steps).
- `git grep -n "oncall_now\|oncall.now"` and confirm the spelling is identical in code, tests, docs and the skills.
- Cross-platform: nothing here builds a path; time formatting is UTC-explicit so Windows, macOS and Linux give the same
  text (`bun run audit:cross-platform`).
- Memory-listed traps to check: a test that expects `fetch` NOT to be called must restore `globalThis.fetch` in `afterEach`;
  spawned-CLI tests resolve paths in a child; tests that touch the Vault do not leak machine-global state between retries.

## Docs to update in the same PR (the five core docs, every PR, plus the ones this slice touches)

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains a Phase 10 MB3 sentence (`oncall_shift` items from
  PagerDuty and JSM Operations refreshed at most every 15 minutes inside the two syncs; `oncall.now`, `nimbus oncall now`, the
  `oncall_now` agent tool and the incident brief's on-call line; Tauri allowlist 126 -> 127; JSM shifts carry no times;
  no schema change, no new invariant); the "Invariants I1-I55; schema V91" tail is unchanged (no schema change: say so);
  the I7 bullet and any `ALLOWED_METHODS` count in the file (`grep -n "\b126\b" CLAUDE.md GEMINI.md`); the I29 bullet's
  sync fetches sentence only if it lists hosts (it does not).
- `docs/roadmap.md`: the Phase 10 *On-call schedule awareness* row (line ~2019) stays `[ ]` (MB5 closes the "feeds into the
  morning briefing" half) with a dated sub-note in the style of the MB1 note on the Morning briefing row: what shipped
  (shifts, `oncall.now`, CLI, tool, brief line), the corrections the code forced (deviations 1-13 in short form), the stated
  bounds, and that OpsGenie is replaced by JSM Operations (the row's wording said PagerDuty/OpsGenie); add the acceptance
  criterion the spec proposes (`nimbus oncall now --service payment-service` and `nimbus ask` both name the on-call person from
  the index with no live API call) and mark the `nimbus oncall now` half verified, the `nimbus ask` half "when the tool is
  offered"; remove or amend the MB1 sentence that told MB3 to read `/myself` (it did).
- `docs/architecture.md`: an "On-call shifts" subsection (the item type and metadata, the two refresh steps and their
  cursor fields `ocAt`/`ocUntil`/`cid`/`cidSite`, complete versus partial/capped and why capped does not delete, the reader's
  statuses, the matching tiers, the host constant and `redirect: "manual"`); the sync-capability description gains
  `replaceItemSet` (if Task 1 applied) and its scoping and the local-only refusal; the IPC catalogue gains `oncall.now`
  (read; LAN-forbidden by the `oncall` namespace entry; Tauri-exposed; demo-served); the `oncall` row at line ~1602 and the
  on-call pushed-brief section (~2152-2176, which says "(105 -> 107)") gain a one-line pointer; the Tauri allowlist count in
  every place it appears (`grep -n "\b126\b" docs/architecture.md`).
- `docs/README.md`: the Phase 10 status paragraph gains the MB3 sentence.
- `docs/cli-reference.md`: a `nimbus oncall now [--service <id|name>] [--json]` entry under `nimbus oncall` (what it reads,
  the data age line, the four statuses and their exit codes, the matching tiers, that it makes no API call, the JSM bounds);
  the `nimbus oncall` usage block gains the `now` subcommand; the IPC section gains `oncall.now`; the allowlist count
  mentions (`grep -n "\b126\b" docs/cli-reference.md`).
- `docs/CHANGELOG.md`: a dated entry in the existing style (what the owner gets; the 15-minute refresh; the unverified live
  shapes; the cursor keys; `redirect: "manual"` and the new fixed host for the Jira credential; allowlist 127; the stated
  bounds from spec § 8 plus deviations 4, 6, 9 and 12; no schema, no invariant).
- `docs/SECURITY-INVARIANTS.md`: I7's allowlist-count text (the "Approval learning, Phase 10 SA5 ... 124 -> 126, the current
  `allowlist_exact_size`" paragraph at ~198 gets a following paragraph: "MB3 (2026-11-..): 126 -> 127, `oncall.now`, a read of the
  local index, `oncall.pushedRetry` still CLI-only"; fix every "the current" claim); I5/denylist text: `oncall.now` is covered
  by the namespace entry; I29's sync paragraph: the on-call steps' requests (PagerDuty `/oncalls`, `/services`, `/users/me`;
  Jira `/myself`, `_edge/tenant_info`, and the fixed host `api.atlassian.com`) are inside the run's single `sync.run` row,
  and the row names the service, not the host; I11: the tool `oncall_now` joins the list of tools wrapped by `wrapToolForLlm`
  (file:line of its registration in `engine/agent.ts`, per the skill's compliance list). I1-I55 and D10-D44 ceilings do not
  change.
- `docs/schema-reference.md`: unchanged (no schema change); say so in the PR description.
- `.claude/commands/nimbus-tauri-allowlist.md` (count 126 -> 127, `allowlist_oncall_reads_only` named), `nimbus-ipc.md` (the
  `oncall` namespace gains `oncall.now`), `nimbus-file-map.md` (the new files), `nimbus-agent-patterns.md` (the
  incident brief's on-call line, only if it lists the brief's sections), `nimbus-tool-output-envelope.md` (the new wrapped
  tool, if it lists the tools); all gated by `audit:doc-refs`, which resolves every path they cite.

## Verification (run all; fix before presenting; a failing step hides later ones, so run each)

1. `bun run preflight:fast` (types, Biome, static rules incl. `audit:invariants` and `audit:status-drift`, `audit:doc-refs`).
2. `bun test packages/gateway/src` (unit: connectors, index, ipc, engine, agents, demo, config).
3. `bun test packages/gateway/test packages/cli` (integration and e2e trees; a `src` run does not load `test/`).
4. `bun test packages/gateway/src/security-invariants.test.ts` (the whole file: the two `allowlist_exact_size` pins, the I5
   LAN pin, the I11 wiring, the new host-pin source test, and the capability-built contexts).
5. `cargo test` from `packages/ui/src-tauri` (the allowlist tests; see Task 7 step 4).
6. `bun run typecheck` and `bun run typecheck:tests` (the latter covers `packages/gateway/test/**`; the baseline must not
   grow).
7. `bun run audit:invariants` (the real tree is clean; MB3 adds no static rule) and `bun run audit:status-drift` (reads the
   counts the docs state: fix every surface it names, including any `126`).
8. If Docker is available, `bun run verify:docker --changed` for the Linux-only failure class (its one known red exec-e2e is
   the harness, not this branch).
9. Before opening the PR re-check `git rev-parse --abbrev-ref HEAD` and the `replaceItemSet` rebase state, then
   `bun run preflight` if time allows (full CI parity).

## PR

Title (conventional commit, no `!`; nothing here requires a user to act):

`feat(gateway): index on-call shifts from PagerDuty and Jira Service Management and answer who is on call from the index`

Description: summary of what is indexed and how it is refreshed, the 13 deviations (short), the stated bounds (live reply
shapes unverified; JSM shifts carry no times and no service mapping; PagerDuty `is_me` needs a user-level token or
`from_email`; capped or partial refreshes never delete; the `nimbus ask` half needs a remote vendor or ranked retrieval), the
new credential-bearing host and how it is pinned, which branch of the `replaceItemSet` rebase rule applied, the verification
output, and the dependencies: MB5 consumes `queryOncallNow` and needs `ALLOWED_METHODS` at 127 before its own 131. End with the
attribution lines from the session. No `Release-As:` trailer.
