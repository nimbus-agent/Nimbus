# `nimbus tail` — gateway operational event stream

**Status:** design approved 2026-09-13. Implementation not started.
**Row:** v0.1.1 CLI batch (`docs/roadmap.md`), fifth row after `index health`, `changelog`,
`standup`, `oncall`.
**Invariants:** none new. Touches I23's neighbourhood without entering it — see § 8.
**Schema:** no migration.

---

## 1. Why this is not what the roadmap row says it is

The row's trigger column reads *"engineering work only — uses existing IPC notification surface"*
and *"No Gateway API changes required — subscribes to existing IPC notifications."* That is wrong
on three of its four lanes, verified against code before this design was written:

| Lane the row promises | Reality |
|---|---|
| HITL requests | ❌ **`consent.request` is UNICAST, not broadcast** — see below |
| Connector health state changes | ❌ **No emitter exists.** `transitionHealth` (`connectors/health.ts`) mutates health silently |
| Watcher fires | ❌ No IPC notification anywhere in `automation/` |
| Sync cycle completions with item deltas | ❌ The scheduler's `notify` is an **OS desktop toast** (`title, body`), not an IPC notification |

So `tail` is a **producer** change before it is a consumer one, on **all four** lanes. It adds
gateway notification surface; it does not merely subscribe to it.

**The HITL row was wrong in the first draft of this spec** and is corrected here rather than
quietly amended. `ConsentCoordinatorImpl.requestConsent` (`ipc/consent.ts`) resolves a single
session and writes to it:

```ts
const write = this.getWriter(clientId);   // ONE session
…
write(notif);                              // not broadcastNotification
```

`consent.request` therefore reaches only the client that triggered the action. A separate
`nimbus tail` process would never see a prompt raised by `nimbus vault set` in another terminal,
so `--filter hitl` would have silently shown nothing. Two consequences, both handled in § 3.4:
a broadcast observation event is required, and `tail` must never answer a prompt — `handleRespond`
rejects a foreign `requestId` with `-32602 Unknown or foreign consent request`.

### 1.1 The bug this uncovers, which is worth more than the feature

`connector.healthChanged` is **consumed by the desktop and emitted by nothing**:

- `packages/ui/src-tauri/src/gateway_bridge.rs:780` — `classify_notification` matches that exact
  method and emits `connector://health-changed` to the renderer.
- Repo-wide, the only other occurrence is that file's own test asserting it is not a global
  broadcast method. **No gateway code has ever sent it.**

The desktop's connector-health panel therefore never updates live. Emitting the event fixes that
with **no Rust change** — but only if the payload matches what the React component reads, which the
first draft of this spec got wrong. See § 2.1: "the listener has been waiting for a sender" is true,
and insufficient on its own.

---

## 2. Contract

Two methods, intended to be the last two this feature ever needs.

### 2.1 `connector.healthChanged` — a named method, in the DESKTOP's vocabulary

```jsonc
{ "name": "github", "health": "error", "degradationReason": "sync failed after repeated attempts",
  "fromState": "degraded", "reason": "sync failed after repeated attempts",
  "occurredAt": 1789300000000 }
```

```ts
export interface ConnectorHealthChangedPayload {
  readonly name: string;                        // connector id — `ConnectorStatus.name`'s vocabulary
  readonly health: ConnectorHealthState;        // the state AFTER the transition
  readonly degradationReason?: string;          // omitted when null
  readonly fromState: ConnectorHealthState | null;
  readonly reason: string | null;
  readonly occurredAt: number;
}
```

Named rather than enveloped **because it has a second consumer**: the Tauri bridge matches on the
method name to discriminate it, and cannot cheaply match on a `kind` inside a payload.

**The field names are the desktop's, and the first draft of this spec got this wrong.** It proposed
`{ connectorId, fromState, toState, reason, occurredAt }` and claimed emitting it would fix the
desktop "with no Rust change". No Rust change is indeed needed — but
`packages/ui/src/components/dashboard/ConnectorGrid.tsx` reads:

```ts
interface HealthChangedPayload { readonly name: string; readonly health: ConnectorStatus["health"]; readonly degradationReason?: string }
…
patchConnector(payload.name, { health: payload.health });
```

So the proposed payload would have called `patchConnector(undefined, { health: undefined })`,
matched no connector row, and **the panel still would not have updated** — the bug fixed on paper
and not in fact. The first draft verified that the listener EXISTS and never verified the CONTRACT
it expects: one end, not the wire.

**Merged, not aliased.** The review proposed carrying both vocabularies — `connectorId` *and*
`name`, `toState` *and* `health` — as compatibility aliases. Rejected: two names for one value in
one payload is a standing invitation for a future consumer to read the wrong one, and there is
nothing to be compatible *with* since this event has never been emitted. `name`/`health` are not a
concession to the desktop; they are already the repo's UI-facing vocabulary (`ConnectorStatus.name`,
`ConnectorStatus.health`). The fields `tail` additionally wants — `fromState`, `reason`,
`occurredAt` — are simply added, and the desktop ignores them.

**`toState` values are `ConnectorHealthState`, never `HealthEvent.type`.** The first draft's example
said `"toState": "persistent_error"`, which is an *event* type; the derived *state* is `"error"`.
The union is `healthy | not_configured | degraded | error | rate_limited | unauthenticated | paused`
and must line up with the UI's `ConnectorHealth`.

**`from === to` is a legitimate, emitted case.** `transitionHealth` has no early return when the
state is unchanged, so a second `transient_error` while already `degraded` appends a history row
and emits with `fromState === health`. That is correct for an event log and harmless for the
desktop (it patches the same value). The method name says "changed" and means "a transition was
recorded"; that is stated rather than filtered, because suppressing it would hide repeated failures
from the one reader who wants them.

### 2.2 `gateway.event` — the envelope for everything else

```jsonc
{ "kind": "sync.completed", "ts": 1789300000000, "payload": { /* per-kind */ } }
```

`kind` values in v1: `watcher.fired`, `sync.completed`, `extension.stateChanged`,
`hitl.requested`, `hitl.resolved`.

```ts
export interface GatewayEventNotification<K extends string = string, P = Record<string, unknown>> {
  readonly kind: K;
  readonly ts: number;
  readonly payload: P;
}

export interface WatcherFiredPayload {
  readonly watcherId: string; readonly name: string; readonly summary: string;
  readonly firedAt: number;
}
export interface SyncCompletedPayload {
  readonly serviceId: string; readonly itemsUpserted: number; readonly itemsDeleted: number;
  readonly durationMs: number; readonly bytesTransferred?: number; readonly hasMore: boolean;
}
export interface ExtensionStateChangedPayload {
  readonly extensionId: string;
  readonly action: "install" | "enable" | "disable" | "remove" | "update";
  readonly ok: boolean; readonly version?: string; readonly error?: string;
}
export interface HitlRequestedPayload {
  readonly requestId: string; readonly prompt: string;
}
export interface HitlResolvedPayload {
  readonly requestId: string; readonly approved: boolean; readonly reason?: string;
}
```

**Why an envelope, against the repo's per-method convention.** `@nimbus-dev/client`'s
`onNotification(method, handler)` is **named-only** — there is no wildcard, and the client is a
separate repository (`nimbus-agent/nimbus-client`), so adding one means a publish and a pin bump
before this feature can land. Without an envelope, a stream that renders "everything operational"
needs a per-method list in the CLI, which is the hand-maintained-list defect this repo has hit
three times (`reserved-sections.coverage.test.ts` silently skipping `standup`;
`disclosure-anchor-coverage.test.ts` silently skipping `oncall`; `security-invariants.test.ts`'s
per-kind I31 pairing tests, also missing `oncall`). The envelope removes the list entirely: a new
operational event picks a `kind` and reaches `tail` with no CLI change and nobody remembering
anything.

`tail` binds exactly **two** handlers — `gateway.event` and `connector.healthChanged` — and that
count is fixed. (The first draft said three, counting `consent.request`; that method is unicast to
the acting client and is useless to a separate `tail` process, so HITL observation rides the
envelope as `hitl.requested`/`hitl.resolved` instead. One fewer handler, and a lane that actually
works.)

---

## 3. Emit sites

### 3.1 `connector.healthChanged` — at `appendHistory`, not at `transitionHealth`'s callers

`appendHistory` (`connectors/health.ts`, module-private, 4 call sites) is the **one place every
health transition is already recorded** — including the `configured` flag change and
`skipped_offline`, which do not flow through the main `nextState` path. Its existing arguments
(`connectorId, fromState, toState, reason, occurredAt`) are already the notification payload.

The alternative — emitting from `transitionHealth`'s five importers (`sync/scheduler.ts`,
`connectors/lazy-mesh/connector-spawns.ts`, `connectors/lazy-mesh/user-mcp.ts`,
`index/local-index.ts`) — is the drift trap: a sixth importer silently emits nothing.

**The seam.** `health.ts` takes only a `Database`. A single sink is registered once at boot from
`platform/assemble.ts`:

```ts
// connectors/health.ts
let healthSink: ((e: ConnectorHealthChange) => void) | undefined;
export function setConnectorHealthSink(sink: (e: ConnectorHealthChange) => void): void { … }
```

This is module-level mutable state, which is the one thing in this design to object to. It is
chosen for the same reason the I29 appenders are decorators rather than call-site appends: the
callers must not have to cooperate. It is bounded by a test asserting `appendHistory` is the only
site that calls the sink.

**Deliberately fire-and-forget.** Unlike the I29 appenders, a failed emit must NOT abort the
transition: this is an observability stream, not a ledger, and a broken subscriber must never stop
a connector's health from being recorded. The sink is wrapped so a throwing subscriber is
swallowed and logged.

**It must also emit AFTER COMMIT, not inside the transaction — the first draft missed this.**
`appendHistory` runs inside `db.transaction(() => { upsertHealthRow(…); appendHistory(…); })()`
(`connectors/health.ts`). Emitting from inside that closure is wrong in three independent ways,
only the first of which "swallow the throw" addresses:

1. A throwing subscriber would roll the transaction back — the health transition lost because
   something downstream was broken.
2. A subscriber querying the same connection synchronously can deadlock or throw.
3. **Worst: the event is published before the commit.** If the commit then fails, every connected
   client — including the desktop panel — has been told a transition happened that did not.

So the sink is NOT invoked from `appendHistory`. `appendHistory` records what to emit, and
`transitionHealth` fires it **after** `db.transaction(...)()` returns, from a single site. That
keeps the chokepoint property (one place, callers do not cooperate) while moving the side effect
outside the transaction boundary. The "only `appendHistory` may reach the sink" test in § 7 becomes
"only `transitionHealth` may fire it, and only after the transaction".

**Test lifecycle.** `setConnectorHealthSink(undefined)` must be supported so a unit test can clear
module state between cases; without it one test's sink leaks into the next.

### 3.2 `watcher.fired` — a new structured dep, never the existing toast callback

`automation/watcher-engine.ts` already takes `notify(title, body)` and calls it at two sites with
`` `${w.name}: ${fired.summary}` ``. That is **human prose for an OS toast** and must not be
reused: the event needs structure (`watcherId`, `name`, `summary`, `firedAt`), and conflating them
would make the stream's payload a rendering decision.

A separate optional `onFired` dep is added and wired in `platform/assemble.ts`.

### 3.3 `sync.completed` — at the already-wired hook

`SyncScheduler` already calls `this.onConnectorSyncSuccess?.(serviceId, result, durationMs)`, and
`platform/assemble.ts:776` already supplies it. The emit goes there. `SyncResult` already carries
`itemsUpserted`, `itemsDeleted`, `bytesTransferred` and `hasMore`.

**No separate `sync.failed` in v1.** A failed sync already produces a health transition
(`transitionHealth(..., { type: "sync_failure" | "unauthenticated" | … })`), so it reaches the
stream through § 3.1. A second event would be a second place for the two to disagree about what
failed.

### 3.4 `hitl.requested` / `hitl.resolved` — observation only, never participation

Required because `consent.request` is unicast (§ 1). `ConsentCoordinatorImpl` broadcasts an
observation event alongside — never instead of — the existing targeted notification:

- `requestConsent` → `gateway.event` `{ kind: "hitl.requested", payload: { requestId, prompt } }`
- `handleRespond` / `onClientDisconnect` / `rejectAllPending` → `hitl.resolved`
  `{ requestId, approved, reason? }`

**Three bounds, because this is the one lane that touches the HITL path:**

1. **The unicast `consent.request` is unchanged.** The broadcast is additive. Consent SEMANTICS —
   who is asked, who may answer, what `handleRespond` accepts — are untouched. This lane observes a
   gate; it is not part of one, so non-negotiable #2 ("HITL is structural") is not in play.
2. **`details` is NOT broadcast.** `consent.request` carries an optional `details` payload
   describing the action; the targeted client needs it to render an approval card, and a passive
   observer does not. It can carry action arguments, so broadcasting it to every connected client —
   including MCP clients — would widen who sees them. `requestId` and `prompt` only.
3. **`tail` must never answer.** `withGatewayIpc` binds an interactive consent handler by default;
   `tail` must opt out (passive/no-op). A `tail` that replied would hit `handleRespond`'s
   `-32602 Unknown or foreign consent request` — harmless, but it would be a client trying to
   approve something nobody asked it about.

### 3.5 `extension.stateChanged` — runtime mutations only, NOT the boot pass

**This section's first draft was wrong and the correction is the point.** It said "extension load /
disable", implying the signature-verification pass. That pass is **boot-time**:
`verifyExtensionsBestEffort` is called once from `platform/assemble.ts:3309`, and
`signatureDisabledRegistry` is populated by `reset()`/`mark()` during it. An operational stream
shows what happens *while you are watching*; a `tail` started after boot would never see a single
one of those, so promising "extension state changes" on that basis would be a claim the stream
cannot keep.

What genuinely changes at runtime is the owner-initiated IPC surface — `extension.install`,
`extension.enable`, `extension.disable`, `extension.remove`, `extension.update` — each of which
happens while someone may be tailing. Those are the emit sites: one `gateway.event` with
`kind: "extension.stateChanged"` and `payload { extensionId, action, ok }`, emitted by the
dispatcher handlers after the mutation succeeds.

The boot-time signature-disable is deliberately NOT emitted. It is already surfaced by
`nimbus extension list`/`info` (which say *why* an extension was signature-disabled, as of
2026-09-10) and by `diag.snapshot`'s count; re-emitting it into a stream nobody is connected to
yet would add surface for nothing.

---

## 4. What is deliberately NOT on the stream

`broadcastNotification` (`ipc/server/server.ts:75`) writes to **every connected session** with no
subscription and no filtering. Every event therefore reaches the Tauri desktop and every connected
MCP client, whether or not they want it.

That bounds what belongs here: **no per-item progress.** Embedding backfill progress and LLM pull
progress are high-frequency, and putting them on a broadcast-to-all channel makes every client pay
for one reader's curiosity. Backfill **start/finish** is acceptable and can be added later as a
`kind`; per-item progress is not.

This narrows "everything operational" as originally scoped, and is recorded here rather than
applied silently.

---

## 5. The CLI

```text
nimbus tail [--filter <categories>] [--json]
```

- Line-oriented, one event per line. Respects `NO_COLOR`.
- `--filter` takes a COMMA-SEPARATED list and is REPEATABLE — `--filter connector,sync` and
  `--filter watcher --filter hitl` are both valid. Categories: `connector`, `watcher`, `sync`,
  `extension`, `hitl`. An unknown category FAILS FAST naming the valid set, rather than silently
  matching nothing — a filter that quietly excludes everything looks identical to a quiet system,
  which is the failure this whole command exists to avoid.
- Client-side predicate. There is no server-side subscription to add, because there is no
  subscription mechanism (§ 4).
- Renders **generically from `kind`**: an unrecognised future `kind` prints as
  `[unknown: my.new.kind] {…}` rather than being dropped.
- `--json` emits the raw JSON-RPC notification objects as JSONL (`{"method":…,"params":…}`), one per
  line, for `jq`.
- **Follow-only.** Like `tail -f -n 0`: it shows what happens from the moment it connects and
  replays nothing. Stated in `--help`, because a reader who assumes otherwise would conclude
  nothing had happened rather than that nothing had been watched.

Illustrative output (default mode):

```text
2026-09-13T14:32:01.102Z [connector] github: healthy -> degraded (rate limited)
2026-09-13T14:32:05.450Z [sync]      slack: +14 items, -0 (182ms)
2026-09-13T14:32:12.800Z [watcher]   P0 Incidents: high latency on auth-service
2026-09-13T14:33:00.010Z [extension] nimbus-jira: enabled
2026-09-13T14:33:15.220Z [hitl]      req-8f12: requested
```

**Naming.** `nimbus watch` is already the watcher-CRUD command (`watcher.list/pause/resume/delete`),
which is why the roadmap chose the verb `tail`. Unchanged here.

## 6. Error handling

- A subscriber that throws is swallowed at the sink (§ 3.1) — the gateway must not fail a health
  transition, a watcher fire or a sync because something downstream is broken.
- `tail` losing the gateway is an ordinary `onClose`: print a line saying the gateway went away and
  exit non-zero, rather than hanging. `@nimbus-dev/client` exposes `onClose` for exactly this, and
  its doc comment notes a notification consumer has no `call()` timeout to rescue it.
- An event that cannot be rendered prints its raw `kind` rather than crashing the stream.
- **`SIGINT`/`SIGTERM`:** unlisten, disconnect, exit 0.
- **Broken pipe:** `nimbus tail --json | head -n 5` closes stdout early. That must exit quietly,
  not dump an `EPIPE` stack trace — piping into `head` is the obvious first thing anyone does with
  a stream.
- **Gateway not running** at startup: `Gateway is not running. Start with: nimbus start`, exit 1 —
  the same wording every other command uses.

---

## 7. Testing

- **Per emitter, a unit test**, each red-proved by reverting the emit.
- **An integration test over a real gateway subprocess**: drive a health transition, assert exactly
  one `connector.healthChanged` arrives with that exact method name. This is what stops a rename
  from silently re-orphaning the Tauri listener.
- **A CLI test** over an injected client (dependency injection, not `mock.module` — the repo's
  stated preference for dispatcher-driven code).
- **A test that `appendHistory` is the only caller of the health sink**, so a future emit site
  cannot bypass the chokepoint.
- **An unknown-`kind` test**: an envelope with a `kind` the CLI has never seen still prints.
- **A DESKTOP CONTRACT test** (`packages/ui`): feed `ConnectorGrid`'s `onHealth` the exact payload
  the gateway emits and assert the store is actually patched. This is the direct guard for the
  defect § 2.1 describes — the first draft's payload would have passed every gateway-side test and
  still left the panel dead, because both sides were only ever tested against themselves.
- **A sink-throws test**: a subscriber that throws must leave the health transition committed.
- **A commit-ordering test**: a transaction that ROLLS BACK must emit nothing (§ 3.1).
- **A sink-lifecycle test**: `setConnectorHealthSink(undefined)` clears module state between cases.
- **A multi-client test**: two `tail` clients plus a third connection all receive the same
  broadcast, since `broadcastNotification` fans out per session.
- **A HITL-observation test**: a consent prompt raised on client A produces `hitl.requested` on
  client B, and B answering it is refused (§ 3.4).

---

## 8. Invariant and gate implications

**No new invariant.** Every event is a LOCAL IPC broadcast to already-connected clients; nothing
leaves the machine, so no I29 egress class is involved and no ledger row is appended.

**The I23 boundary is adjacent and must not be crossed.** `watcher-engine.ts` carries
`makeChatopsWatcherNotify`, which is explicitly **not wired**, and whose comment records that an
earlier version *falsely claimed* a wiring site that never existed. That comment further records
that routing watcher alerts outbound would put the path under **I23** (ChatOps posts go only
through `reply-dispatcher.ts` to a server-derived `ReplyTarget`) and plausibly **I29**, requiring
the invariant triple rule. This design touches none of that: `watcher.fired` is a local
notification, and § 3.2's separate `onFired` dep exists partly so the two can never be confused.

**Tauri:** notifications are not IPC methods, so `ALLOWED_METHODS` (I7) does not apply. The bridge
already forwards every notification generically as `gateway://notification`; `connector.healthChanged`
additionally hits its existing `classify_notification` arm. No Rust change is required, and none
should be made.

---

## 9. Open questions

None. Every decision is settled above. For the record, the four raised by review:

1. **HITL broadcast** — yes, `hitl.requested`/`hitl.resolved` (§ 3.4). Forced: without it
   `--filter hitl` shows nothing from any other client.
2. **Compatibility aliases** — rejected in favour of ONE merged payload in the desktop's existing
   vocabulary (§ 2.1). Nothing to be backward-compatible with; two names per value is a future
   consumer reading the wrong one.
3. **`sync.failed`** — not needed, and the premise behind asking was wrong. `transitionHealth` has
   NO `fromState === toState` early return, so a repeat `transient_error` while already `degraded`
   still appends history and still emits. A separate failure event would be a second place for the
   two to disagree.
4. **Historical backlog (`-n`/`--lines`)** — deferred, not scoped. The row specifies a real-time
   feed, and a replay would need to merge `connector_health_history` with sources that have no
   history table at all (there is no watcher-fire or sync-completion log to replay from), so it is a
   materially larger feature than it sounds. Forward-only is the confirmed v1 scope, disclosed in
   `--help` (§ 5).
