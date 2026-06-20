# Proactive `nimbus watch` Daemon — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Near-Term Spine **S4 — Autonomous Agent** (watch → learn → act loop), tracked as Phase 10 in `docs/roadmap.md`. Sequenced in `docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md` as the Track-1 capstone (lands after S1 Local Brain, S2 Local Compute Fleet, S3 Open Surface).
**Scope:** `packages/gateway/src/watch/` (new subsystem), `packages/gateway/src/index/migrations/` (V44), `packages/gateway/src/platform/assemble.ts` (lifecycle wiring — `assemblePlatformServices`), `packages/gateway/src/ipc/` (new `watch.*` RPC namespace, **separate** from the incumbent `watcher.*` namespace), `packages/cli/src/commands/watch.ts` (extend the existing `nimbus watch` dispatcher with new subcommands) + a new `nimbus brief` command, `docs/SECURITY-INVARIANTS.md` + `packages/gateway/src/security-invariants.test.ts` (I29 — daemon-proposal taint barrier). Reuses the shipped `AnomalyDetectorStub`, the built-in agents (`catchup`/`impact`/`conflicts`), `emitBriefWithSynthesis`, `broadcastNotification`, and the executor HITL gate. **Does not touch** the incumbent connector-watcher subsystem (`watcher.*` / `automation-rpc.ts`).

---

## Motivation / Goal

Today Nimbus is **pull-only**: every brief, query, and agent run is initiated by the user (`nimbus ask`, `nimbus catchup`, etc.). S4's thesis is to flip this — turn Nimbus into an assistant that **initiates**: a long-running daemon inside the Gateway that, on a schedule and on local signal, pushes the user a **morning briefing** (cross-service summary), flags **anomalies** over already-collected DORA/metrics series, and assembles a **blast-radius / incident pre-brief** when a monitoring alert lands in the local index.

This spec covers **only the proactive (push) half** of S4. It is deliberately a *notifier*, not an actor:

- The daemon **never executes a write action on its own authority.** Anything it proposes is dispatched as a normal `PlannedAction` through the existing executor `gate()` (`packages/gateway/src/engine/executor.ts:258`), which consults the frozen `HITL_REQUIRED` set (I2). The daemon's job ends at "here is a proposed action and a one-click approval prompt."
- All anomaly scoring is **local** — it reuses the shipped Z-score `AnomalyDetectorStub` (`packages/gateway/src/watcher/anomaly-detector.ts`). No cloud ML, no model call required to flag an anomaly.
- All briefing/incident content is assembled from the **local SQLite index** via existing read-only agents. No new outbound network path.

The "learn → act" autonomy half (standing-approval *auto-execution*, watcher-trained baselines) is explicitly a **follow-on slice** — see Non-goals. This slice ships the push surface and the safety invariant (I29) that the act-half will later depend on.

---

## Where this fits (roadmap home + not-already-shipped evidence)

**Not already shipped (the proactive push half).** I confirmed in-tree:

- No `packages/gateway/src/watch/` directory and no `nimbus brief` CLI command exist. The **proactive daemon** this spec proposes (morning-briefing push loop, anomaly sweep, incident pre-brief) is unbuilt. Phase 10 is "Planned" in the roadmap.
- ⚠️ **Namespace collision to resolve.** A `nimbus watch` command *does* already exist — `packages/cli/src/commands/watch.ts` implements `nimbus watch list|pause|resume`, which maps to the **incumbent connector-watcher subsystem** over the `watcher.*` RPC namespace (`packages/gateway/src/ipc/automation-rpc.ts` — `watcher.list`/`watcher.create`/`watcher.delete`/`watcher.pause`/`watcher.resume`/…). That subsystem (event-condition watchers on indexed items) is **distinct** from the proactive daemon proposed here. This spec therefore **adds new subcommands** (`status`, `on`, `off`, `config`, `incidents`, `incident <id>`) under the *same* `nimbus watch` umbrella and a **new, separate** `watch.*` RPC namespace — it does **not** claim `nimbus watch` is unbuilt. The two RPC namespaces are deliberately kept apart: `watcher.*` = incumbent connector-watchers; `watch.*` = this proactive daemon. See **Open question 7** for whether to keep both subsystems under one CLI noun or rename one.
- The morning-briefing push loop, scheduled-workflow trigger, and incident pre-brief assembly are unbuilt. There is **no** standing-approval table, scheduled-task table, or incident-record table — current schema tops out at **V43** (`share_inbox`, `runner.ts:405`); V44 is the next migration.

**Reusable prerequisites that already exist (reuse > rebuild):**

- **Daemon lifecycle template** — `packages/gateway/src/extensions/auto-update-init.ts` / `auto-update.ts`: `ExtensionAutoUpdater` is a polling daemon with `pollOnce()`, an `AbortController`, an `intervalHours`, an injected `now()`/`random()`, and best-effort audit. This is the exact shape to copy for a watch daemon.
- **Anomaly scoring** — `AnomalyDetectorStub` (`anomaly-detector.ts`): `recordSample(seriesId, value, atMs)` returns a Z-score and fires `onNotify` at score ≥ 3 with ≥ 3 prior samples. Production-ready; just needs feeding from the metrics series.
- **Read-only brief builders** — `runCatchup` (`agents/catchup.ts:105`) for the "recent activity" slice; `runImpact` (`agents/impact.ts`) for blast-radius; `runConflicts` for conflicting-work flags. All produce typed briefs and run via `AgentCoordinator` sub-agent fan-out. The morning briefing is a **composition** of these, not a rewrite.
- **Fire-and-forget brief emit** — `emitBriefWithSynthesis` (`agents/_lib/emit-brief.ts:42`): builds a typed brief, synthesizes Markdown, emits `<x>.briefReady` with `{ sessionId, brief, findings }`, catches errors to `<x>.briefError`. The daemon's push uses the same envelope.
- **Push transport** — `broadcastNotification(method, params)` (`ipc/server/server.ts:72`): every connected session receives the JSON-RPC notification; already used for `voice.microphoneActive`. No new transport needed.
- **Scheduler notify hook** — `SyncScheduler` (`sync/scheduler.ts:85`) already carries a `notify: (title, body) => Promise<void>` and concurrency/backoff control. The watch daemon shares the `TickScheduler`-style clock abstraction but is a **separate instance** (different cadence; see Approaches).

---

## Approaches considered

### Approach A — Scheduled task *inside* the existing `SyncScheduler`
Add a `scheduledWorkflows` / `watchTasks` queue to `SyncScheduler` alongside connector sync jobs, reusing its concurrency control, backoff, and `notify` callback.

- **Pro:** zero new lifecycle code; one event loop to reason about; reuses rate-limiting + `SchedulerStateRepository`.
- **Con:** conflates two very different cadences — connector sync runs every few minutes with backoff on auth/rate-limit errors; a morning briefing fires *once daily* at a user-local hour, and an incident pre-brief is *event-driven* (fires when an alert row lands). Shoehorning daily/event triggers into a minutes-granularity backoff loop muddies a load-bearing, well-tested subsystem (`scheduler.ts` is coverage-gated). High blast radius for a behavior that wants different timing semantics.

### Approach B — Separate `WatchDaemon` process (OS service)
Ship the daemon as its own OS-level background process (launchd/systemd/Windows Service), separate from the Gateway.

- **Pro:** survives Gateway crashes; clean separation.
- **Con:** **violates Vault access boundaries and Platform Equality cleanly only at high cost.** The daemon must read the local index and (for proposals) reach the executor — that means either re-opening the Vault out-of-process (a second DPAPI/Keychain consumer — risky and platform-divergent) or talking to the Gateway over IPC (then it's just an external client and can't reach `executor.gate()` directly). Adds three OS-specific service installers. Over-engineered for v1.

### Approach C — Separate **in-gateway** `WatchDaemon`, sharing the clock abstraction (recommended)
A new `WatchDaemon` class under `packages/gateway/src/watch/`, instantiated in `assemblePlatformServices()` (`packages/gateway/src/platform/assemble.ts:1501`) exactly like the `ExtensionAutoUpdater` runtime is today (`createAutoUpdateRuntime` / `maybeStartAutoUpdateRuntime`, `assemble.ts:913`/`:1618`). It owns its own tick loop (injected `now()` + an `AbortController`), reads the local index directly (in-process, full Vault access already available to the Gateway), and pushes via `broadcastNotification`. Proposed actions go through the **same** `executor.gate()` the rest of the engine uses.

- **Pro:** copies a proven in-tree daemon pattern; one process, one Vault, no new transport, no OS service installers (Platform Equality holds trivially — pure Bun event loop + SQLite); different cadence from sync without touching `scheduler.ts`; proposals inherit I2/I3/I4 for free.
- **Con:** dies with the Gateway (acceptable — the Gateway is the always-on local process; restart re-reads V44 state so nothing is lost; this is the same trade-off `ExtensionAutoUpdater` already accepts).

**Recommendation: Approach C.** It is the minimal, in-tree-proven design: it reuses the `ExtensionAutoUpdater` lifecycle, the anomaly stub, the read-only agents, and the broadcast channel; it keeps the HITL gate as the *only* path to a write; and it satisfies Platform Equality and Local-first without new OS surface. Approach A is rejected for cadence-mismatch risk on a coverage-gated subsystem; Approach B for the Vault/transport cost.

---

## Design (recommended)

### Architecture & components

New subsystem `packages/gateway/src/watch/`:

- **`watch-daemon.ts`** — `WatchDaemon` class. Lifecycle (`start()`/`stop()` + `AbortController`), injected `now: () => number` and `clock`/`sleep` seams (DI for tests, mirroring `auto-update.ts`). Holds three triggers:
  1. **Daily briefing tick** — once per day at the configured `briefing_hour` (user-local TZ); computes `nextFireAt` and persists it to `watch_daemon_config`.
  2. **Anomaly sweep tick** — on each metrics refresh, feeds the latest DORA/metric series points into a shared `AnomalyDetectorStub` and surfaces score ≥ 3 events.
  3. **Event trigger** — polls for unhandled rows in the incident-source view (PagerDuty `incident` items newly landed in the index since `last_fired_at`) and assembles a pre-brief.
- **`morning-briefing.ts`** — `buildMorningBriefing(db, ...)`: composes existing builders into one `MorningBriefingBrief` (typed). v1 slices: **open PRs** (reuse `runCatchup` activity sections filtered to `type='pr'`), **active incidents** (incident items unresolved), **overdue tickets**, **anomaly flags** (from the anomaly sweep). Emits via `emitBriefWithSynthesis`-style envelope as `watch.briefReady`.
- **`incident-prebrief.ts`** — `buildIncidentPrebrief(db, incidentId)`: on a new incident item, runs `runImpact` (blast radius of the affected service/repo) + recent deploy/PR/CI correlation from the local index, caches the result to `incident_record`, and pushes `watch.incidentReady`. Read-only; no remediation executed here.
- **`anomaly-sweep.ts`** — thin adapter feeding metric series into `AnomalyDetectorStub`, mapping `AnomalyNotification` → a user-facing flag carrying `{ seriesId, value, score, baselineMean }` (score + baseline, not raw deltas — per constraints).
- **`watch-proposal-gate.ts`** — **the I29 enforcement site** (see Security). The single function through which the daemon may turn a flagged finding into a *proposed* `PlannedAction`. It tags the proposal's provenance and refuses to surface any auto-approvable proposal whose triggering input is `untrusted`; such proposals are downgraded to a plain HITL prompt (default behavior in this slice — see Non-goals on auto-execute).
- **`watch-store.ts`** — typed read/write over the V44 tables (config get/set, incident cache upsert, scheduled-task list). Bound-param SQL only (I9), writes via `dbRun`/`dbExec`/`dbStmtRun` (I14).

Wiring: `WatchDaemon` is constructed in `assemblePlatformServices()` (`packages/gateway/src/platform/assemble.ts:1501`) alongside the other subsystems, given `{ db, ipc.broadcastNotification, anomalyDetector, llmRegistry, now }`, and `start()`/`stop()` are tied to gateway boot/shutdown — following the same pattern as the `ExtensionAutoUpdater` runtime (`maybeStartAutoUpdateRuntime` at `assemble.ts:1618`). Gated behind a `[watch] enabled` config flag (default on; `nimbus watch off` disables without uninstall).

### Data flow

```
                       (in-process, full Vault, local SQLite)
  daily tick ─────────► buildMorningBriefing(db) ──► emit envelope
                          ├─ runCatchup (PRs/activity)        │
                          ├─ unresolved incidents query       │
                          ├─ overdue tickets query            ├─► broadcastNotification(
                          └─ anomaly flags (from sweep)        │     "watch.briefReady", {...})
                                                               │        │
  metrics refresh ──────► anomaly-sweep ──► AnomalyDetectorStub│        ▼
                          (recordSample, score≥3 → flag) ──────┘   all CLI/Tauri sessions

  new incident row ────► buildIncidentPrebrief(db, id)
                          ├─ runImpact (blast radius)
                          └─ deploy/PR/CI correlation ──► cache → incident_record (V44)
                                                       └─► broadcastNotification("watch.incidentReady", …)

  any *proposed* write ─► watch-proposal-gate (I29 provenance check)
                          └─► executor.gate(action)  ◄── I2 HITL, owner approves/declines
```

No step in this flow makes an outbound network call. Briefing/incident assembly reads only rows already synced into the local index by the existing connectors.

### IPC / CLI surface

New `watch.*` RPC namespace (`packages/gateway/src/ipc/watch-rpc.ts`, dispatched via the existing `dispatchByMethod` pattern in `agents-rpc.ts`):

| Method | Shape | Notes |
| --- | --- | --- |
| `watch.status` | `() → { enabled, briefingHour, nextFireAt, anomalyThreshold }` | read-only |
| `watch.briefNow` | `() → { sessionId }` | force a briefing build now; result arrives as the `watch.briefReady` notification |
| `watch.config.set` | `({ key, value }) → { ok }` | `briefing_hour`, `anomaly_threshold`, `incident_severity_floor`; written to V44 config |
| `watch.incidents.list` | `({ sinceMs? }) → { incidents }` | reads cached `incident_record` |
| `watch.incident.show` | `({ id }) → { incident }` | cached pre-brief, no re-query |

**Notifications** (via `broadcastNotification`): `watch.briefReady` `{ sessionId, brief, findings }`, `watch.incidentReady` `{ incidentId, brief, findings }`, `watch.anomalyFlag` `{ seriesId, score, baselineMean, value }`.

**CLI** — **new** subcommands added to the existing `nimbus watch` dispatcher (`packages/cli/src/commands/watch.ts`, which already routes `list|pause|resume` to the incumbent `watcher.*` connector-watcher subsystem): `nimbus watch status`, `nimbus watch on|off`, `nimbus watch config <key> <value>`, `nimbus watch incidents`, `nimbus watch incident <id>`, plus a top-level `nimbus brief` (force + print the morning briefing — alias of `watch.briefNow` + waits for `watch.briefReady`). The new subcommands route to the **new** `watch.*` namespace; the incumbent `list|pause|resume` continue routing to `watcher.*` unchanged. (See Open question 7 on whether the two subsystems should ultimately share one CLI noun.)

**Tauri exposure (I7):** `watch.status`, `watch.briefNow`, `watch.config.set`, `watch.incidents.list`, `watch.incident.show` are read/notify-class and may be added to `ALLOWED_METHODS`; the daemon exposes **no** RCE-class method. The `watch.*` notifications are classified for cross-window rebroadcast (consult `nimbus-tauri-allowlist`).

### Security: the 7 Non-Negotiables + invariant impact

1. **Local-first** ✅ — daemon runs in-process in the Gateway; all assembly reads local SQLite; anomaly scoring is local Z-score. **No outbound network path is introduced.** There is deliberately no "POST brief to a URL" sink in this slice; if ever added it must be HITL-gated + audit-logged (out of scope here).
2. **HITL is structural** ✅ — the daemon **notifies and proposes only**. Any proposed write action is dispatched as a `PlannedAction` through `executor.gate()` (`executor.ts:258`), which consults the frozen `HITL_REQUIRED` set. The daemon has **no bypass and no auto-execute path** in this slice. Morning-briefing and incident-prebuild reads are HITL-free (read-only, like the existing agents).
3. **No plaintext credentials** ✅ — the daemon has in-process Vault access (same as the engine) but **emits no secrets**: all `watch.*` notifications and audit entries carry only titles/scores/ids/markdown summaries, run through the existing audit-payload redaction (`audit-payload-safety.test.ts`). Vault values never enter a brief, notification, or log.
4. **MCP as connector standard** ✅ — assembly reads rows already synced via existing MCP connectors; the daemon spawns **no** MCP server and calls **no** cloud API directly. (If a future live-Prometheus anomaly source is wanted, it arrives as a Prometheus MCP connector feeding the index — not a daemon HTTP call.)
5. **Platform equality** ✅ — pure Bun event loop + SQLite + the cross-platform `broadcastNotification`. No OS-specific service, no per-OS code. `briefing_hour` uses the OS local TZ uniformly.
6. **AGPL-3.0 core / MIT sdk** ✅ — all new code lives under `packages/gateway` (AGPL); no license field touched.
7. **No `any`** ✅ — external inputs (`watch.config.set` params, cached JSON) typed as `unknown` and validated, mirroring `requireExpertParams` (`agents-rpc.ts:48`). Typed briefs throughout.

**Invariant reuse:**
- **I2 / I3 / I4** — every proposed write rides the existing `gate()`; matching dispatches the correct `action.type` (I3); `hitlStatus` is written only by the gate (I4). The daemon adds **no** new HITL action type — it reuses whatever action types its proposals already carry.
- **I9 / I14** — V44 writes use bound params + `dbRun`/`dbExec`/`dbStmtRun`.
- **I11** — incident/briefing sub-agent runs (via `runImpact`/`runCatchup`/`AgentCoordinator`) already wrap tool outputs in the envelope; no new LLM-facing path bypasses it.
- **I5** — the daemon runs in-process and exposes nothing over LAN. The `watch.*` methods are local/Tauri-only; none is added to a LAN allowlist (and they are not LAN-reachable).

**New invariant — I29 (proposal taint barrier).** *Note: **I28 is reserved** (not yet merged) for the MCP-server owner-sink on branch `dev/asafgolombek/phase7-mcp-gateway-server` — a different concern from this design's proposal-taint barrier. To avoid colliding with that reserved number, this design claims **I29**. (If I28 lands first under a different scope, re-confirm the next free number before wiring.)*
- **Statement:** A watch-daemon-originated proposed action must be tagged with the provenance of the data that triggered it. A proposal whose triggering input derives from attacker-controllable content (cloud-indexed item text, a federated answer, a user-supplied template) is `untrusted`; an `untrusted` proposal may **never** be presented as pre-approved or auto-executable — it is downgraded to a standard owner HITL prompt (fail-closed). Only `trusted`-provenance findings (the daemon's own local metric series, the user's explicit config) may, in a *future* slice, ride a standing approval.
- **Why now:** this slice does not yet ship auto-execute, but it *does* ship the daemon that decides what to propose. Establishing I29 now means the act-half slice inherits a wired, tested taint barrier rather than retrofitting one — and it closes the obvious prompt-injection vector (a malicious indexed Slack message that nudges the daemon to "propose deleting X").
- **Wiring site:** `packages/gateway/src/watch/watch-proposal-gate.ts` — the single function the daemon uses to mint a proposal; it stamps provenance and refuses to mark anything `untrusted` as auto-approvable (today: forces full HITL).
- **Triple rule:** docs row in `docs/SECURITY-INVARIANTS.md`, enforcement test in `packages/gateway/src/security-invariants.test.ts`, static complement in `scripts/structure-audit/check-nimbus-invariants.ts` (confine the proposal-mint path to `watch-proposal-gate.ts`, analogous to D21 confining share emit).

**Schema — V44** (`packages/gateway/src/index/migrations/`, append-only, via a `simpleStep(43, 44, …)` after the V43 row at `runner.ts:405`):
- `watch_daemon_config(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)` — `briefing_hour`, `anomaly_threshold`, `incident_severity_floor`, `next_briefing_at`, `last_fired_at`.
- `incident_record(id TEXT PRIMARY KEY, external_incident_id TEXT, discovered_at INTEGER, assembled_at INTEGER, brief_json TEXT, resolved_at INTEGER)` with index on `(discovered_at, resolved_at)` — caches assembled pre-briefs so `watch.incident.show` never re-queries.

**Deferred to the act-half slice (NOT in V44 here):** `standing_approval_rule` and `scheduled_task` tables. This slice is notify-only; adding those tables now would be unused schema (YAGNI). I29 is defined now so the taint barrier exists before any rule table does.

**Fail-closed behavior:** anomaly sweep with < 3 samples scores 0 (no flag) — already the stub's behavior. Incident assembly that throws emits `watch.briefError`/nothing, never a partial proposal. A proposed write that hits a declined/timed-out HITL gate executes nothing (existing gate semantics). An `untrusted`-provenance finding can never become an auto-proposal (I29).

### Testing

- **Invariant test (I29)** — in `security-invariants.test.ts`: assert that a proposal minted from an `untrusted`-provenance finding cannot be marked auto-approvable (forces HITL); assert the proposal-mint path is confined to `watch-proposal-gate.ts` (static).
- **HITL test** — prove a daemon-proposed write action fires `executor.gate()` and is blocked on decline (reuse the HITL test pattern; the daemon must not have any path that reaches a connector without the gate).
- **Integration (real SQLite + temp dir)** — V44 migration applies cleanly from V43; `buildMorningBriefing` composes the catchup/incident/overdue slices over a seeded index; `buildIncidentPrebrief` caches to `incident_record` and `watch.incident.show` reads the cache without re-running `runImpact` (assert no second sub-agent run). Anomaly sweep: feed a series, assert score ≥ 3 → exactly one `watch.anomalyFlag` with the baseline mean.
- **E2E CLI** — real Gateway subprocess: `nimbus brief` forces a build and prints the briefing; `nimbus watch off` then `watch.briefNow` emits nothing (disabled). DI the clock so the "daily tick" is deterministic (inject `now()` + a fake clock, mirroring `auto-update.ts` — no real time waits).
- **Vault test** — assert no Vault value appears in any `watch.*` notification or audit payload (extend `audit-payload-safety` coverage).
- **Coverage** — every new file under `packages/gateway/src/watch/` must clear the ≥ 80% line+branch floor (the True-Coverage baseline is `{}`; new files are gated on first land). DI all the seams (`now`, broadcast, anomaly detector, db) so the daemon loop and the I29 gate are unit-testable without spawning the Gateway.

---

## Non-goals (YAGNI)

- **No standing-approval *auto-execution*.** This slice proposes; it does not auto-act. No `standing_approval_rule` table, no confidence-scored auto-approve. That is the explicit follow-on "act-half" slice — and it will *depend on* I29, which we ship here.
- **No cron/scheduled-workflow engine.** No `scheduled_task` table, no cron parser. The only schedule in v1 is the single daily briefing hour. Generic cron triggers are deferred.
- **No ML / adaptive baselines.** Anomaly detection is the shipped 3σ Z-score stub. Adaptive thresholds are a later stretch.
- **No outbound brief delivery** (email/Slack/webhook push of the briefing). The briefing surfaces only to connected local clients via `broadcastNotification`. An outbound sink would need its own HITL-gated, audit-logged design.
- **No new MCP connector** and no live Prometheus/Grafana scrape — anomaly input is the metric series already in the index.
- **No multi-alert-source incident routing** beyond the existing PagerDuty incident items already in the index, filtered by `incident_severity_floor`.

---

## Open questions

1. **Briefing slice set for v1.** Recommend PRs + unresolved incidents + overdue tickets + anomaly flags. Add "upcoming deadlines" / watch-event digest as later waves. Confirm the four-slice v1.
2. **Anomaly source series.** v1 feeds the DORA/metrics series the CI/CD data layer already computes (Phase 5 T4). Confirm that's the right first substrate vs. also scoring item-volume-per-service.
3. **`briefing_hour` default + suppression.** Default 09:00 local? Suppress on weekends? Recommend 09:00, no weekend suppression in v1 (config can disable).
4. **Incident severity floor default.** Recommend P1+P2 (`incident_severity_floor` default = P2) to avoid noise; configurable.
5. **I29 provenance tagging mechanics.** The cleanest carrier is a `trusted`/`untrusted` tag riding the I11 `tool_output` envelope so any sub-agent-derived finding inherits provenance automatically. Confirm we extend the envelope vs. a side-channel tag on the proposal. (Leaning: extend the envelope — single source of truth.)
6. **`nimbus brief` blocking UX.** Force-build is async (arrives as a notification). Should the CLI block-and-print (await `watch.briefReady`) or fire-and-return? Recommend block-and-print for `nimbus brief`, fire-and-return for the daily tick.
7. **CLI noun overload (`nimbus watch`).** The incumbent connector-watcher subsystem already owns `nimbus watch list|pause|resume` (→ `watcher.*`). Do we keep both subsystems under one `nimbus watch` noun (this spec's plan — additive subcommands, separate `watch.*` RPC namespace) or disambiguate (e.g. rename the proactive daemon's commands to `nimbus daemon …` / `nimbus proactive …`, or rename the incumbent to `nimbus watchers`)? Leaning: keep the single noun and add subcommands, since the daemon *is* "the thing that watches"; the RPC namespaces (`watch.*` vs `watcher.*`) stay distinct regardless. Confirm.

---

## Acceptance criteria

- `WatchDaemon` is constructed in `assemblePlatformServices()` (`assemble.ts:1501`) and `start()`/`stop()` track gateway boot/shutdown (mirrors the `ExtensionAutoUpdater` runtime wired at `assemble.ts:1618`); disabling via `nimbus watch off` halts ticks without uninstall, and state survives a gateway restart (re-read from V44).
- V44 migration (`watch_daemon_config`, `incident_record`) applies cleanly from V43 and is recorded in the `_schema_migrations` ledger; no existing migration is mutated.
- A daily tick (driven by an injected clock) emits exactly one `watch.briefReady` with a typed `MorningBriefingBrief` composed from `runCatchup` + incident/overdue queries + anomaly flags; `nimbus brief` prints it.
- A metric series crossing 3σ (≥ 3 prior samples) emits exactly one `watch.anomalyFlag` carrying `score` + `baselineMean` (not raw numbers); below-threshold or < 3 samples emits nothing.
- A new incident item triggers `buildIncidentPrebrief`, caches to `incident_record`, emits `watch.incidentReady`; `watch.incident.show` returns the cache without a second `runImpact` run.
- **I2 held:** any daemon-proposed write action is blocked when the owner declines the HITL gate; the daemon has no path to a connector that bypasses `gate()`.
- **I29 added (triple):** an `untrusted`-provenance finding can never be minted as an auto-approvable proposal (forced to full HITL); the mint path is statically confined to `watch-proposal-gate.ts`; docs row + enforcement test + static check all land in the same commit. I28 left reserved.
- No Vault value appears in any `watch.*` notification, brief, or audit payload.
- Every new file under `packages/gateway/src/watch/` clears the ≥ 80% line+branch coverage floor; `bun run preflight` is green on Ubuntu before first push.
