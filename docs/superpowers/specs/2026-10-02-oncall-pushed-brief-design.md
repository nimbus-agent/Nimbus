# On-call pushed brief — design

**Date:** 2026-10-02 · **Status:** draft for review · **Roadmap:** Phase 17 W2 (first half), Killer Demo beat 1
**Branch:** `dev/asaf/oncall-pushed-brief` — this spec never lands on `main`; it is stripped before the implementation PR.

## 1. Purpose

The Killer Demo opens with "a P1 fires → the assembled brief is already there". Today nothing makes that
true: `nimbus oncall` assembles the brief only when someone asks, watchers toast and emit `watcher.fired`
but run nothing, and the demo gateway never syncs at all.

This slice makes it true **as a real feature, proven by the demo**. When a PagerDuty sync shows a new P1
incident assigned to the local owner, the gateway runs `agents.oncall` for it unattended, stores the
brief, and pushes a pointer (or, where policy allows, the brief) to the owner. The demo drives the
**same code path** with a simulated page, so the demo is honest rather than staged.

### Agreed understanding

| | |
|---|---|
| Who it is for | The on-call owner of a real install, and the `nimbus demo` evaluator |
| Success | A new P1 assigned to me has its brief stored and pushed with no query typed, at most once per incident; `nimbus demo` shows the page firing and the brief appearing, still closing on "0 outbound network calls" |
| Trigger | Active (`triggered`/`acknowledged`) incidents assigned to the self-person (the same query `nimbus oncall` uses), severity in `{"p1"} ∪ [pagerduty] severity_p1_aliases` (replaceable) |
| Channels | OS toast + `nimbus tail` (PR 1), ChatOps notify channel (PR 2), desktop panel (PR 3) |
| ChatOps content | Headline by default; the full brief only on a policy binding that opts in |
| Out of scope | Cascade root ranking (piece 2), remediation/rollback (piece 3), `nimbus audit replay` (piece 4), post-mortem/status-page drafts (piece 5), approve-from-push |

## 2. Architecture

New directory `packages/gateway/src/oncall-push/`, four units with one job each:

| File | Job | Depends on |
|---|---|---|
| `push-selector.ts` | Pure query: which incidents need a brief | `Database`, `resolveSelfPerson`, `selectActiveAssignedIncidents`, `[pagerduty]` severity aliases |
| `push-runner.ts` | Single-flight orchestration: select → dispatch → store → deliver | selector, `dispatchAgentsRpc`, store, sinks |
| `push-store.ts` | The only reader/writer of `pushed_brief` / `oncall_push_state` | `Database` |
| `push-sinks.ts` | Deliver one stored brief to each enabled sink, isolating failures | notifications, `emitGatewayEvent`, ChatOps dispatcher (PR 2) |

### 2.1 Data flow

```
pagerduty sync completes (assemble.ts, beside evaluateWatchersAfterSync)
  └─ runOncallPush(db, "pagerduty")            [enabled && single-flight + trailing re-run]
       ├─ selectPushCandidates()               → incident ids
       └─ for each id (sequential):
            ├─ dispatchAgentsRpc("agents.oncall", { incidentId: id },
            │     caller { clientId: "oncall-push", kind: "push" },
            │     notify: the runner's own listener, synthesis: off)
            │   → returns { sessionId } at once; the brief arrives later as
            │     oncall.briefReady / oncall.briefError on that listener (or a timeout)
            ├─ pushed_brief INSERT (status ok | failed)
       └─ deliver the run's new rows → toast, gateway.event, [chatops] (capped per run, § 2.5),
          record delivery_json
```

### 2.2 Selector

An incident is a candidate when ALL hold:

1. **Assigned to me, active.** The incident is returned by `oncall-queries.ts`'s
   `selectActiveAssignedIncidents(db, personId)`, where `personId` comes from `resolveSelfPerson`, reused
   **unchanged**. That query walks `graph_relation` (`assigned`/`resolves` edges from the person entity) and
   keeps active statuses only (`triggered` and `acknowledged`). Reusing it rather than re-parsing
   `metadata.assignee_emails` is the point: what push selects is, by construction, what `nimbus oncall` shows for
   "my incidents", so the two cannot disagree. An incident acknowledged from a phone before the sync still gets
   its brief; it is still yours and still open.
2. **P1.** `LOWER(metadata.severity)` is in `{"p1"} ∪ lowercase(severity_p1_aliases)`, the same baseline
   `preflight/preflight.ts` uses (it compares `LOWER(severity)` against `["p1", ...aliases]`). When
   `[oncall.push] severities` is non-empty, it **replaces** that set (also lowercased). `severity_p1_aliases` is
   the global `[pagerduty]` key (`config/nimbus-toml.ts`, merged into every service config), not a per-service
   one. `metadata.severity` is PagerDuty's priority NAME (`pagerduty-sync.ts`), which each org defines itself.
   That is why no extra baseline such as `sev1`/`critical` is invented: an alias the owner did not configure would
   make push disagree with `preflight` and DORA about what counts as P1.
4. There is no `pushed_brief` row for its id. **The table is the dedup**: there is no time cursor, so a restart, a
   re-sync or an overlapping sync can never push twice, and a missed sync catches up.
5. Its `metadata.opened_at_ms` (written by `pagerduty-sync.ts` from the incident's `created_at`) is at or
   after `oncall_push_state.enabled_at − ENABLE_GRACE_MS` (5 min). Enabling the feature never backfills history.
   The grace absorbs clock skew between PagerDuty and the host; pushing a brief for an incident opened a few minutes
   before enabling is harmless, whereas missing one is not. `item` has no
   first-indexed column (`modified_at`/`synced_at` move on every re-sync), so the guard keys on the
   incident's own open time. An incident with **no** `opened_at_ms` cannot be placed in time and is
   never selected; `nimbus oncall pushed list` does not show it either, and the doc says so.

The fixtures for this query are built by running `pagerduty-sync`'s real writer, never from hand-written
metadata. Hand-written fixtures are how a filter on a key no connector writes ships green.

### 2.3 Runner

- **Dispatch goes through `dispatchAgentsRpc`**, the seam `fleet/fleet-invoker.ts` uses. D22(d) forbids
  importing an agent emitter anywhere else, and this keeps push on the same handler map as every other
  caller.
- **The brief arrives asynchronously.** `emitBriefWithSynthesis` (`agents/_lib/emit-brief.ts`) returns
  `{ sessionId }` immediately and delivers the brief later through `ctx.notify("oncall.briefReady", …)` or
  `"oncall.briefError"`. The runner therefore supplies its **own** `notify` listener in the dispatch context and
  wraps each dispatch in a promise that settles on that session's ready/error notification or on a timeout
  (`PUSH_BRIEF_TIMEOUT_MS`, 30 s), exactly the shape of `fleet/fleet-invoker.ts`. Two consequences follow. A timeout
  is a `failed` row with `failure_code = 'timeout'`. And the listener is the runner's alone, so the brief is never
  broadcast to socket clients: the only broadcast is § 2.5's id-only `oncall.briefPushed`.
- **New derived `ClientKind` `"push"`.** It is added to the union in `ipc/server/client-kind.ts`, deliberately absent from
  `RECOGNISED` (no socket client can declare it), with `EGRESS_BEARING_CLIENT_KINDS.push = null`
  (a pushed brief is local SQLite; a ChatOps post is ledgered by the `chatops` class at the post). D28's
  confinement extends to the `kind: "push"` assignment shape.
- **`OWNER_SCOPED_ONCALL_ALLOWED.push = false`.** `agents-rpc.ts`'s map is total over `ClientKind`, so the
  compiler forces an entry. It is consulted only for the zero-parameter "which incident is mine" shape, and push
  always names `incidentId`. Setting it to `false` makes that a hard guarantee: a push call that ever lost its
  `incidentId` is refused rather than quietly briefing whatever the owner-scoped resolution picks.
- **Synthesis is pinned off.** The pushed brief is the deterministic render. That keeps latency well under the
  15 s Phase 17 target, needs no LLM, and guarantees no unattended push reaches a remote model. No new
  invariant is needed and I38 is not in play. The pin is applied at the runner's dispatch context. A test
  asserts that no `LlmRouter`/`SynthesisRouter` method is called on a push run even when
  `[agents] synthesis = "allow-remote"`.
- **Single-flight with one trailing run.** A call that arrives while a run is in flight sets a
  `rerunRequested` flag and returns. When the active run finishes, it selects once more if the flag is set, so
  an incident from an overlapping sync is not left waiting a whole poll interval. Any number of overlapping
  calls collapse into one trailing run.
- **Only PagerDuty.** `assemble.ts` calls the runner only when `serviceId === "pagerduty"`, and the runner
  returns at once for any other id, so the guard does not depend on its one caller remembering it.
- **Failure.** If dispatch throws, refuses, emits `briefError` or times out, the runner writes `status = 'failed'` with the
  reason code. There is no automatic retry, so a poison incident cannot re-run on every sync.
  `nimbus oncall pushed <id> --retry` re-runs by hand (§ 2.7).

### 2.4 Storage — schema V64

```sql
CREATE TABLE pushed_brief (
  incident_id    TEXT PRIMARY KEY,          -- e.g. pagerduty:PDEMO412
  session_id     TEXT,                      -- agents session; NULL when failed before dispatch
  status         TEXT NOT NULL CHECK (status IN ('ok','failed')),
  failure_code   TEXT,
  brief_markdown TEXT,                      -- NULL when failed
  brief_json     TEXT,                      -- the oncall brief payload; NULL when failed
  created_at     INTEGER NOT NULL,
  delivery_json  TEXT NOT NULL DEFAULT '{}', -- { sink: { outcome: delivered|skipped|coalesced|failed, reason?, at } }
  retried_at     INTEGER                    -- last manual retry; created_at is never rewritten
);
CREATE INDEX idx_pushed_brief_created_at ON pushed_brief(created_at);
CREATE TABLE oncall_push_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_at INTEGER NOT NULL
);
```

All writes go through `dbRun`/`dbExec` (I14/D12). Retention: rows older than `[oncall.push] retention_days`
(default 90) are pruned at the start of each run, which the `created_at` index serves, as it does the newest-first
list. `push-store.ts` is the only file naming either table.

**Stated bound: a GDPR purge does not reach `pushed_brief`.** A stored brief carries names, assignee emails and PR
titles copied from the index. The V37 purge pipeline (`policy/gdpr-purge-store.ts`) does not sweep derived brief
tables today; `fleet_brief` likewise relies on retention alone. `pushed_brief` follows that precedent. A purged
person can survive in a pushed brief for up to `retention_days`. That is disclosed in `docs/architecture.md`
rather than silently inherited, and it is recorded as a deferral (§ 7), since teaching the purge about derived
briefs is a cross-cutting change affecting `fleet_brief` too.

### 2.5 Sinks

Each sink is attempted independently. One failing never blocks another, and every outcome lands in
`delivery_json`.

**Per-run notification cap.** Every candidate's brief is **stored**: briefs are cheap, deterministic and local,
and dropping one would be a silent loss. Only *notifications* are capped. A run that produced up to
`PUSH_NOTIFY_CAP` (3) new rows notifies once per row, newest `opened_at_ms` first. A run that produced more notifies
for the newest 3, then sends ONE summary per sink: "Briefs ready for 5 P1 incidents (3 shown) — `nimbus oncall
pushed list`". The rows beyond the cap record `coalesced`. The `oncall.briefPushed` event is the exception and fires
per row, because it is a machine signal (the desktop panel needs every id), not a human interruption.

| Sink | PR | Behaviour |
|---|---|---|
| Toast | 1 | `notifications.show("Nimbus on-call", "P1 <service>: <title> — brief ready: nimbus oncall pushed")`. A pointer, never the brief. |
| Gateway event | 1 | New `GatewayEventKind` `"oncall.briefPushed"`, payload `{ incidentId, status }` only, never the body (the same rule as the `hitl.*` observation events). `nimbus tail` gains the filter `oncall`. |
| ChatOps | 2 | See § 2.6 |
| Desktop | 3 | No push of its own: the panel listens for `oncall.briefPushed` and reads through `oncall.pushedGet`. |

### 2.6 ChatOps sink (PR 2)

- **Destination is server-derived (I23).** The local key `[oncall.push] chatops_namespace` selects a namespace. The
  channel comes from that namespace's policy `notify` list through the existing `ReplyDispatcher`
  `namespaceNotify` target. Nothing caller-supplied names a channel.
- **Ledgered (I29).** `buildLedgeredChatPosts` gains a fourth bound kind, `pushedBrief`
  (`method = 'chatops.pushedBrief'`), and `chatops-boot.ts` builds a fourth `ReplyDispatcher` over it.
  D17's unwrapped-post rule already covers it. Every post appends exactly one `chatops`-class row.
- **Content.** By default the post is the headline only: incident title, service, "last deployment: <PR> <n> min before the alert"
  (or "no deployment found before the alert"), and the hint `@nimbus agent oncall incident=<id>`.
  The full brief markdown is posted only when the policy binding sets `push_full_brief = true`, and then only
  through `chatops/brief-truncate.ts`'s `truncateBrief` at `CHATOPS_AGENT_BRIEF_MAX_BYTES` (3,000). That is the same
  bound and the same truncation disclosure the agent intent already applies, so an oversized brief is cut
  visibly rather than rejected by the platform.
- **`push_full_brief` resolves tighten-only (I22).** It is a widening flag, so a stricter layer's `false` wins
  and a missing or invalid value resolves to `false`. Enforcement reads `EnforcedPolicy`, never raw TOML
  (D16).
- If no namespace is configured, the namespace has no notify channels, or ChatOps is not booted, the sink records `skipped` with
  a reason. That is never an error.
- **Disclosure, carried over from the agent-intent design:** a brief is synthesized from the owner's whole
  index and is not filtered by channel membership. That is exactly why the full form is opt-in per binding.

### 2.7 Read surface

| Method | PR | Callers |
|---|---|---|
| `oncall.pushedList` `{ limit? }` → newest first, `{ incidentId, status, createdAt, title, service }` | 1 | CLI; Tauri from PR 3 |
| `oncall.pushedGet` `{ incidentId? }` → one row incl. markdown (newest when omitted) | 1 | CLI; Tauri from PR 3 |
| `oncall.pushedRetry` `{ incidentId }` | 1 | CLI only, never Tauri |

- All three are **LAN-forbidden** by adding the whole `"oncall"` namespace to `FORBIDDEN_OVER_LAN`
  (`ipc/lan-rpc.ts`), matching `fleet`/`toolgen`/`demo`. `checkLanMethodAllowed` is a denylist, so a new namespace
  is LAN-reachable by default; the test calls it with a negative control. (`agents.oncall` is in the `agents`
  namespace and is unaffected.)
- **Retry semantics.** `oncall.pushedRetry` acts only on a `failed` row. On an `ok` row it refuses with
  `ERR_ONCALL_PUSH_NOT_FAILED`; there is no `--force`, since re-briefing a succeeded incident is just
  `nimbus oncall --incident <id>`. A successful retry updates the row in place (`status`, `session_id`, brief
  columns, `failure_code = NULL`, `retried_at = now`), leaves `created_at` untouched, and delivers to every sink
  afresh. That is correct, not a duplicate: a failed row never had a brief to deliver. A retry that fails again
  updates `failure_code` and `retried_at` only.
- Each is wired into both the inner dispatcher **and** the outer method-routing match in
  `ipc/server/dispatchers.ts`. An E2E test over a real socket proves the routing, not only the handler.
- PR 3 adds `oncall.pushedList` and `oncall.pushedGet` to `ALLOWED_METHODS` (105 → 107). The Rust test
  asserts them by name and the prose ledger's enumeration is re-derived, not only the count.

CLI (`packages/cli`): `nimbus oncall pushed [--json]` (newest), `nimbus oncall pushed list [--json]`,
`nimbus oncall pushed <incident-id> [--retry] [--json]`.

| Case | Text output | Exit |
|---|---|---|
| No pushed briefs | `No pushed briefs yet.`, plus a hint when `[oncall.push]` is disabled | 0 (an empty list is an answer, not an error) |
| Row is `ok` | the brief markdown | 0 |
| Row is `failed` | the failure code and the `--retry` hint | 1 |
| Unknown incident id | `No pushed brief for <id>.` | 1 |
| `--retry` refused (row `ok`) | `ERR_ONCALL_PUSH_NOT_FAILED` message | 1 |

`--json` always prints one valid JSON document (`{ "briefs": [] }` when empty) with the same exit codes, so a
script reads status from the exit code and detail from the JSON.

### 2.8 Configuration

```toml
[oncall.push]
enabled = false              # DEFAULT OFF
severities = []              # empty → {"p1"} ∪ [pagerduty] severity_p1_aliases; non-empty replaces it
chatops_namespace = ""       # empty → ChatOps sink skipped
retention_days = 90
```

The policy binding gains `push_full_brief` (default `false`).

## 3. Demo

- `demo/corpus/acme.ts`: move `STORY_DEPLOY` so it **finishes** 8 min before the page, matching the roadmap script.
  The incident is no longer pre-seeded as the story P1. It arrives through `demo.firePage`.
- **`demo.firePage`** is claimed only by a demo-rooted gateway (elsewhere it falls through to `Method not found`, the same as
  `demo.seed`), is LAN-forbidden and is absent from the Tauri allowlist. It writes the incident with "now" timestamps
  through the seed's real write path, then calls `runOncallPush(db, "pagerduty")` directly. The demo's
  config enables `[oncall.push]` and the demo persona resolves as self. **Ordering matters:** `enabled_at` must exist before
  any page fires, or the § 2.2 guard rejects the very incident the demo just fired. The boot-time reconcile
  (§ 4.1) provides it, because `nimbus demo` restarts the gateway after seeding (the restart its locality window
  already spans), so the enabled config is in force at boot and `enabled_at` = boot time precedes `firePage`. The E2E
  test pins this ordering.
- **I41 is unchanged.** The demo's sync scheduler stays disabled, and `demo.firePage` is the one way in.
- **The tour** (`ACME_TOUR_STEPS`): a new first step, "a page fires", calls `demo.firePage` and renders the
  pushed brief from `oncall.pushedGet`. It **replaces** the explicit `oncall --incident` step, so the evaluator
  never types the query. Then come `why`, `owners`, and the locality panel. The push path appends no egress row
  (toast and event only; ChatOps is not configured in the demo), so "0 outbound network calls" stays a
  produced fact, and the released-install-smoke judge keeps asserting it.

## 4. Error handling summary

### 4.1 `enabled_at` lifecycle — reconciled at boot

`enabled_at` is written by a **boot-time reconcile** in `assemble.ts`, not by the first run. Two cases:
- Config enabled and no state row: write `enabled_at = boot time`.
- Config disabled: delete the row.

Config is read at boot, so every disable → enable change passes through a boot where this runs. That closes two
problems the first-run design had:
1. **First-sync drop.** Stamping on the first run would set `enabled_at` *after* an incident that arrived in the
   very sync that triggered the run, and the guard would reject it forever. Boot time precedes every sync of that
   process.
2. **Restart straight into an enabled config.** The earlier draft accepted that a disable was observed only by a
   sync running while disabled. Reconciling at boot observes it at the boot where the config is disabled, so
   re-enabling never backfills the gap.

| Condition | Behaviour |
|---|---|
| Push disabled | `runOncallPush` returns immediately; nothing is selected (the state row was cleared at boot) |
| Self-person unresolved | Nothing selected; `nimbus doctor` warns "`[oncall.push]` enabled but identity unresolved". No fallback to "every P1". |
| Dispatch throws, refuses, emits `briefError` or times out (30 s) | `pushed_brief` `failed` + code; no auto-retry; `--retry` by hand |
| More than 3 new briefs in one run | All stored; 3 notified + one summary per sink; the rest `coalesced` |
| Resolved but stale `triggered` | Pushed at most once (table dedup); the brief prints the PagerDuty sync age unconditionally |
| A sink fails | Recorded in `delivery_json`; other sinks still run |
| Overlapping syncs | Collapsed into one trailing run |
| Enable (first, or again after disabling) | A fresh `enabled_at` is written at boot (§ 4.1); no backfill of history or of the disabled gap |
| Host/PagerDuty clock skew at the enable boundary | Absorbed by the 5-min `ENABLE_GRACE_MS` |

## 5. Testing

- **Unit:** selector predicates over fixtures from `pagerduty-sync`'s real writer, which also populates the
  `graph_relation` assignment edges the selector reads, including a negative control per predicate (resolved,
  severity not in the set, a severity matching only by case, assigned to someone else, already pushed, opened
  before `enabled_at − grace`, no `opened_at_ms`); a parity test showing that push candidates are a subset of
  `selectActiveAssignedIncidents` for the same person. Runner: the async listener settling on ready, on error and
  on timeout; single-flight plus trailing run; the failure path; `push: false` refusing a parameterless dispatch.
  Also: the notification cap and summary; sink isolation; retry on `ok` vs `failed`; `push_full_brief` tighten-only
  resolution; ChatOps truncation; headline rendering with and without a matched deployment; boot reconcile in all
  three states.
- **Integration:** real migrated V64 schema; real `dispatchAgentsRpc` producing a real oncall brief that is stored and
  read back; the no-model-call assertion under `allow-remote`.
- **E2E** (`packages/gateway/test/e2e/`): a real demo-rooted gateway subprocess. `demo.firePage` produces exactly
  one `pushed_brief` row, `oncall.pushedGet` returns it over the real socket/pipe, a second
  `runOncallPush` produces no second row, and `egress.proveWindow` over the run reports zero.
- **Security invariants test:** `push` is not declarable over the socket; `EGRESS_BEARING_CLIENT_KINDS` covers
  it; D28 rejects a `kind: "push"` assignment outside its allow-list; `oncall.*`/`demo.firePage` are
  LAN-forbidden (called, with a negative control); a ChatOps pushed brief appends exactly one `chatops` row (PR 2).
- Every test that expects a prompt or TTY behaviour clears `CI`.

## 6. Staging

| PR | Contents |
|---|---|
| 1 | `oncall-push/` core, V64, `push` ClientKind + D28 extension, toast + `oncall.briefPushed` + `tail --filter oncall`, `oncall.pushed*` IPC + CLI, `doctor` check, demo (`firePage`, timing, tour step), docs (architecture, cli-reference, roadmap Phase 17 W2 row, CHANGELOG) |
| 2 | ChatOps sink, `pushedBrief` post kind, `push_full_brief` policy field |
| 3 | Desktop panel, `ALLOWED_METHODS` 105 → 107 |

## 7. Open questions

None blocking. Approve-from-push is deliberately deferred: it needs piece 3's remediation to have something to
approve. Also deferred: teaching the V37 GDPR purge to sweep derived brief tables (`pushed_brief` and
`fleet_brief` together), with retention as the interim bound (§ 2.4). Resolved in review: the `enabled_at`
lifecycle is now a boot-time reconcile (§ 4.1), which also closes the restart-into-enabled gap the earlier draft
accepted.
