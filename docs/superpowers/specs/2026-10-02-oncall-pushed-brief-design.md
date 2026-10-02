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
| Trigger | `triggered` incidents, severity in the service's `severity_p1_aliases` (widenable), assigned to the self-person |
| Channels | OS toast + `nimbus tail` (PR 1), ChatOps notify channel (PR 2), desktop panel (PR 3) |
| ChatOps content | Headline by default; the full brief only on a policy binding that opts in |
| Out of scope | Cascade root ranking (piece 2), remediation/rollback (piece 3), `nimbus audit replay` (piece 4), post-mortem/status-page drafts (piece 5), approve-from-push |

## 2. Architecture

New directory `packages/gateway/src/oncall-push/`, four units with one job each:

| File | Job | Depends on |
|---|---|---|
| `push-selector.ts` | Pure query: which incidents need a brief | `Database`, self-person, per-service severity aliases |
| `push-runner.ts` | Single-flight orchestration: select → dispatch → store → deliver | selector, `dispatchAgentsRpc`, store, sinks |
| `push-store.ts` | The only reader/writer of `pushed_brief` / `oncall_push_state` | `Database` |
| `push-sinks.ts` | Deliver one stored brief to each enabled sink, isolating failures | notifications, `emitGatewayEvent`, ChatOps dispatcher (PR 2) |

### 2.1 Data flow

```
pagerduty sync completes (assemble.ts, beside evaluateWatchersAfterSync)
  └─ runOncallPush(db, "pagerduty")            [enabled && single-flight]
       ├─ selectPushCandidates()               → incident ids
       └─ for each id:
            ├─ dispatchAgentsRpc("agents.oncall", { incident: id },
            │     caller { clientId: "oncall-push", kind: "push" }, synthesis: off)
            ├─ pushed_brief INSERT (status ok | failed)
            └─ deliver → toast, gateway.event, [chatops], record delivery_json
```

### 2.2 Selector

An incident is a candidate when ALL hold:

1. `item.type = 'incident'`, `json_valid(metadata)`, and `metadata.status = 'triggered'`. These are the same predicates as
   the `incident_opened` watcher kind (`automation/watcher-condition-kinds.ts`).
2. Its severity matches the resolved service's `severity_p1_aliases` (`config/nimbus-toml.ts`), or any of
   `[oncall.push] severities` when that key is set.
3. `metadata.assignee_emails` contains an email of the person `resolveSelfPerson` returns, reused
   **unchanged** so that `standup`, `catchup`, `oncall` and push cannot disagree about who "me" is.
4. There is no `pushed_brief` row for its id. **The table is the dedup**: there is no time cursor, so a restart, a
   re-sync or an overlapping sync can never push twice, and a missed sync catches up.
5. Its `metadata.opened_at_ms` (written by `pagerduty-sync.ts` from the incident's `created_at`) is at or
   after `oncall_push_state.enabled_at`. Enabling the feature never backfills history. `item` has no
   first-indexed column (`modified_at`/`synced_at` move on every re-sync), so the guard keys on the
   incident's own open time. An incident with **no** `opened_at_ms` cannot be placed in time and is
   never selected; `nimbus oncall pushed list` does not show it either, and the doc says so.

The fixtures for this query are built by running `pagerduty-sync`'s real writer, never from hand-written
metadata. Hand-written fixtures are how a filter on a key no connector writes ships green.

### 2.3 Runner

- **Dispatch goes through `dispatchAgentsRpc`**, the seam `fleet/fleet-invoker.ts` uses. D22(d) forbids
  importing an agent emitter anywhere else, and this keeps push on the same handler map as every other
  caller.
- **New derived `ClientKind` `"push"`.** It is added to the union in `ipc/server/client-kind.ts`, deliberately absent from
  `RECOGNISED` (no socket client can declare it), with `EGRESS_BEARING_CLIENT_KINDS.push = null`
  (a pushed brief is local SQLite; a ChatOps post is ledgered by the `chatops` class at the post). D28's
  confinement extends to the `kind: "push"` assignment shape, and the compiler forces `oncall`'s
  shape-bounded external map, which is total over `ClientKind`, to classify `push`. It allows it, because push
  always passes an explicit `incident`.
- **Synthesis is pinned off.** The pushed brief is the deterministic render. That keeps latency well under the
  15 s Phase 17 target, needs no LLM, and guarantees no unattended push reaches a remote model. No new
  invariant is needed and I38 is not in play. The pin is applied at the runner's dispatch context. A test
  asserts that no `LlmRouter`/`SynthesisRouter` method is called on a push run even when
  `[agents] synthesis = "allow-remote"`.
- **Single-flight.** A run already in flight makes a concurrent call a no-op, the same shape as the
  glossary/decisions post-sync passes.
- **Failure.** If dispatch throws or refuses, the runner writes `status = 'failed'` with the reason code. There is no automatic
  retry, so a poison incident cannot re-run on every sync. `nimbus oncall pushed <id> --retry` re-runs by hand.

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
  delivery_json  TEXT NOT NULL DEFAULT '{}' -- { sink: { outcome: delivered|skipped|failed, reason?, at } }
);
CREATE TABLE oncall_push_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_at INTEGER NOT NULL
);
```

All writes go through `dbRun`/`dbExec` (I14/D12). Retention: rows older than `[oncall.push] retention_days`
(default 90) are pruned at the start of each run. `push-store.ts` is the only file naming either table.

### 2.5 Sinks

Each sink is attempted independently. One failing never blocks another, and every outcome lands in
`delivery_json`.

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
  The full brief markdown is posted only when the policy binding sets `push_full_brief = true`.
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

- All three are **LAN-forbidden**. `checkLanMethodAllowed` is a denylist, so a new namespace is LAN-reachable
  by default; the test calls it with a negative control.
- Each is wired into both the inner dispatcher **and** the outer method-routing match in
  `ipc/server/dispatchers.ts`. An E2E test over a real socket proves the routing, not only the handler.
- PR 3 adds `oncall.pushedList` and `oncall.pushedGet` to `ALLOWED_METHODS` (105 → 107). The Rust test
  asserts them by name and the prose ledger's enumeration is re-derived, not only the count.

CLI (`packages/cli`): `nimbus oncall pushed [--json]` (newest), `nimbus oncall pushed list [--json]`,
`nimbus oncall pushed <incident-id> [--retry] [--json]`.

### 2.8 Configuration

```toml
[oncall.push]
enabled = false              # DEFAULT OFF
severities = []              # empty → each service's severity_p1_aliases
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
  config enables `[oncall.push]` and the demo persona resolves as self. **Ordering matters:** `demo.seed` writes
  `oncall_push_state.enabled_at` (through `push-store.ts`) at seed time, before any page fires. Otherwise the
  first run would stamp `enabled_at` *after* the incident's open time and the § 2.2 guard would reject the very
  incident the demo just fired. The E2E test pins this.
- **I41 is unchanged.** The demo's sync scheduler stays disabled, and `demo.firePage` is the one way in.
- **The tour** (`ACME_TOUR_STEPS`): a new first step, "a page fires", calls `demo.firePage` and renders the
  pushed brief from `oncall.pushedGet`. It **replaces** the explicit `oncall --incident` step, so the evaluator
  never types the query. Then come `why`, `owners`, and the locality panel. The push path appends no egress row
  (toast and event only; ChatOps is not configured in the demo), so "0 outbound network calls" stays a
  produced fact, and the released-install-smoke judge keeps asserting it.

## 4. Error handling summary

| Condition | Behaviour |
|---|---|
| Push disabled | `runOncallPush` clears `oncall_push_state` and returns; nothing is selected |
| Self-person unresolved | Nothing selected; `nimbus doctor` warns "`[oncall.push]` enabled but identity unresolved". No fallback to "every P1". |
| Dispatch throws or refuses | `pushed_brief` `failed` + code; no auto-retry; `--retry` by hand |
| Resolved but stale `triggered` | Pushed at most once (table dedup); the brief prints the PagerDuty sync age unconditionally |
| A sink fails | Recorded in `delivery_json`; other sinks still run |
| Overlapping syncs | Single-flight no-op |
| Enable (first, or again after disabling) | A fresh `enabled_at` is written on the first enabled run; no backfill of history or of the disabled gap |

## 5. Testing

- **Unit:** selector predicates over fixtures from `pagerduty-sync`'s real writer, including a negative
  control per predicate (wrong status, wrong severity, not assigned to me, already pushed, before
  `enabled_at`); runner single-flight and failure path; sink isolation; `push_full_brief` tighten-only
  resolution; headline rendering with and without a matched deployment.
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
approve. Resolved during self-review: `enabled_at` resets on every disable → enable cycle (a disabled run
clears the state row), so re-enabling never floods the owner with incidents from the gap. A disable is
observed only when a PagerDuty sync runs while disabled. If the gateway restarts straight into an enabled
config, the old row survives and the gap IS eligible. That bound is accepted and stated, because closing it
needs a persisted "last seen config" that is more machinery than the case is worth.
