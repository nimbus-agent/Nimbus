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
| HITL requests | ✅ `consent.request` is genuinely broadcast today |
| Connector health state changes | ❌ **No emitter exists.** `transitionHealth` (`connectors/health.ts`) mutates health silently |
| Watcher fires | ❌ No IPC notification anywhere in `automation/` |
| Sync cycle completions with item deltas | ❌ The scheduler's `notify` is an **OS desktop toast** (`title, body`), not an IPC notification |

So `tail` is a **producer** change before it is a consumer one. It adds gateway notification
surface; it does not merely subscribe to it.

### 1.1 The bug this uncovers, which is worth more than the feature

`connector.healthChanged` is **consumed by the desktop and emitted by nothing**:

- `packages/ui/src-tauri/src/gateway_bridge.rs:780` — `classify_notification` matches that exact
  method and emits `connector://health-changed` to the renderer.
- Repo-wide, the only other occurrence is that file's own test asserting it is not a global
  broadcast method. **No gateway code has ever sent it.**

The desktop's connector-health panel therefore never updates live. Emitting the event fixes that
with no Rust change — the listener has been waiting for a sender.

---

## 2. Contract

Two methods, intended to be the last two this feature ever needs.

### 2.1 `connector.healthChanged` — a named method

```jsonc
{ "connectorId": "github", "fromState": "healthy", "toState": "persistent_error",
  "reason": "sync failed after repeated attempts", "occurredAt": 1789300000000 }
```

Named rather than enveloped **because it has a second consumer**: the Tauri bridge matches on the
method name to discriminate it, and cannot cheaply match on a `kind` inside a payload. That is the
justification — not consistency with the other notifications, which would be a weaker reason.

### 2.2 `gateway.event` — the envelope for everything else

```jsonc
{ "kind": "sync.completed", "ts": 1789300000000, "payload": { /* per-kind */ } }
```

`kind` values in v1: `watcher.fired`, `sync.completed`, `extension.stateChanged`.

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

`tail` binds exactly **three** handlers — `gateway.event`, `connector.healthChanged`, and the
existing `consent.request` — and that count is fixed.

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

### 3.4 `extension.stateChanged` — runtime mutations only, NOT the boot pass

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
nimbus tail [--filter connector|watcher|hitl|sync|extension] [--json]
```

- Line-oriented, one event per line. Respects `NO_COLOR` (and emits no ANSI at all if simpler).
- Exits cleanly on Ctrl+C.
- `--filter` is a **client-side** predicate over the rendered event's category. There is no
  server-side subscription to add, because there is no subscription mechanism.
- Renders **generically from `kind`**: an unrecognised future `kind` prints its `kind` and a
  compact payload rather than being dropped. A stream that silently discards what it does not
  recognise is the same failure class as a brief that renders a missing section as empty.
- `--json` emits the raw notification objects, one per line, for piping.

**Naming.** `nimbus watch` is already the watcher-CRUD command (`watcher.list/pause/resume/delete`),
which is why the roadmap chose the verb `tail`. Unchanged here.

---

## 6. Error handling

- A subscriber that throws is swallowed at the sink (§ 3.1) — the gateway must not fail a health
  transition, a watcher fire or a sync because something downstream is broken.
- `tail` losing the gateway is an ordinary `onClose`: print a line saying the gateway went away and
  exit non-zero, rather than hanging. `@nimbus-dev/client` exposes `onClose` for exactly this, and
  its doc comment notes a notification consumer has no `call()` timeout to rescue it.
- An event that cannot be rendered prints its raw `kind` rather than crashing the stream.

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

None. Both decisions that could have gone either way are settled above: the envelope (§ 2.2) and
the progress-event exclusion (§ 4).
