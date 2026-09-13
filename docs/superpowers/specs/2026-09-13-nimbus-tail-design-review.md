# Design Review: `nimbus tail` — Gateway Operational Event Stream

**Reviewed Spec:** [`2026-09-13-nimbus-tail-design.md`](./2026-09-13-nimbus-tail-design.md)  
**Review Date:** 2026-09-13  
**Status:** Review complete — 3 critical defects identified, 5 architectural improvements, 4 open questions for alignment.

---

## 1. Executive Summary

The design spec makes several strong architectural choices:

- Correctly identifies that `nimbus tail` is a **producer** change before it is a consumer one (refuting the inaccurate roadmap premise that all notification surface already existed).
- Introduces an enveloped notification (`gateway.event`) for future extensibility without requiring `@nimbus-dev/client` bumps or hardcoded CLI dispatch lists.
- Sensibly excludes high-frequency progress events (backfill, LLM streaming) from global broadcast to protect connected clients from resource contention.
- Reuses `appendHistory` as the singular chokepoint for connector health state transitions.

However, a code-level audit against the current codebase revealed **3 critical defects** that will cause runtime failures or silent omissions if implemented as written, along with several specification gaps around schemas, UX, and error handling.

---

## 2. Critical Findings (Must Address Before Implementation)

### Finding 1: Desktop UI Schema Mismatch on `connector.healthChanged` (High Severity)

**Spec Section:** § 1.1 & § 2.1  
**The Issue:**  
Spec § 1.1 states:
> *"The desktop's connector-health panel therefore never updates live. Emitting the event fixes that with no Rust change — the listener has been waiting for a sender."*

And § 2.1 specifies the payload:

```jsonc
{ "connectorId": "github", "fromState": "healthy", "toState": "persistent_error",
  "reason": "sync failed after repeated attempts", "occurredAt": 1789300000000 }

```

In reality, the Tauri Rust bridge (`packages/ui/src-tauri/src/gateway_bridge.rs:780`) passes `params` directly to the webview:

```rust
"connector.healthChanged" => {
    if let Some(p) = params.cloned() {
        let _ = app.emit("connector://health-changed", p);
    }
}

```

And the React component ([`packages/ui/src/components/dashboard/ConnectorGrid.tsx:10-45`](../../../packages/ui/src/components/dashboard/ConnectorGrid.tsx)) consumes this payload with the following contract:

```ts
interface HealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorStatus["health"];
  readonly degradationReason?: string;
}

const onHealth = useCallback(
  (payload: HealthChangedPayload) => {
    const patch: Partial<ConnectorStatus> = { health: payload.health };
    if (payload.degradationReason !== undefined) {
      patch.degradationReason = payload.degradationReason;
    }
    patchConnector(payload.name, patch);
  },
  [patchConnector],
);

```

If the gateway emits `{ connectorId, fromState, toState, reason, occurredAt }`:

1. `payload.name` evaluates to `undefined` (it expects `name`, not `connectorId`).
2. `payload.health` evaluates to `undefined` (it expects `health`, not `toState`).
3. `patchConnector(undefined, { health: undefined })` executes. In `dashboard.ts`, this matches no connector row (`c.name === undefined` is false), so the event is **silently dropped and the desktop UI still will not update**.
4. Furthermore, the example uses `"toState": "persistent_error"`. `"persistent_error"` is a `HealthEvent.type`, not a valid `ConnectorHealthState`. The derived `ConnectorHealthState` in SQLite is `"error"`, which matches `ConnectorStatus["health"]` (`"healthy" | "degraded" | "error" | "rate_limited" | "unauthenticated" | "paused"`).

**Required Fix:**  
Include compatibility alias fields in the `connector.healthChanged` gateway notification payload:

```ts
export interface ConnectorHealthChangedNotification {
  // Canonical fields for CLI & future consumers
  connectorId: string;
  fromState: ConnectorHealthState | null;
  toState: ConnectorHealthState;
  reason: string | null;
  occurredAt: number;

  // Compatibility aliases for existing desktop React listener (ConnectorGrid.tsx)
  name: string; // alias of connectorId
  health: ConnectorHealthState; // alias of toState
  degradationReason?: string; // alias of reason (omitted if null)
}

```

---

### Finding 2: `consent.request` is Unicast to the Requesting Client, NOT Broadcast (High Severity)

**Spec Section:** § 1 (Table 1), § 2.2, § 5  
**The Issue:**  
Spec § 1 Table 1 claims:
> *"HITL requests | ✅ `consent.request` is genuinely broadcast today"*

And § 2.2 states:
> *"`tail` binds exactly **three** handlers — `gateway.event`, `connector.healthChanged`, and the existing `consent.request` — and that count is fixed."*

**This is factually incorrect in the gateway implementation.**  
In [`packages/gateway/src/ipc/consent.ts:35-54`](../../../packages/gateway/src/ipc/consent.ts):

```ts
requestConsent(
  clientId: string,
  params: { requestId: string; prompt: string; details?: unknown },
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const write = this.getWriter(clientId);
    if (write === undefined) {
      reject(new ConsentDisconnectedError("No active IPC session for client"));
      return;
    }
    // ...
    write(notif); // Writes ONLY to the session for clientId!
  });
}

```

`consent.request` is a targeted unicast notification sent strictly to the IPC session that triggered the tool/action (e.g. `nimbus vault set` or `nimbus connector reindex`). A separate client running `nimbus tail` in another window or process **will never receive `consent.request`** from foreign sessions.

Furthermore, `withGatewayIpc` automatically binds an interactive consent prompt handler to `consent.request` by default. If `nimbus tail` connects without setting `consent: "reject"` or a passive mode, it would attempt to answer consent prompts, which `ConsentCoordinatorImpl.handleRespond` would reject with `-32602: Unknown or foreign consent request`.

**Required Fix:**  
To support `--filter hitl` in `nimbus tail`, the gateway must emit a broadcast event when consent is requested and resolved.

1. In `ConsentCoordinatorImpl.requestConsent`: broadcast `gateway.event` with `kind: "hitl.requested"` and `{ requestId, prompt, details, clientId }`.
2. In `ConsentCoordinatorImpl.handleRespond` / `onClientDisconnect` / `rejectAllPending`: broadcast `gateway.event` with `kind: "hitl.resolved"` and `{ requestId, approved, reason }`.
3. `tail` should bind `gateway.event` for HITL observation, and `withGatewayIpc` in `tail` must use a passive consent mode (e.g. `consent: "reject"` or no-op) so it never attempts to mutate pending requests.

---

### Finding 3: SQLite Transaction Side-Effects via `setConnectorHealthSink` (Medium Severity)

**Spec Section:** § 3.1  
**The Issue:**  
In [`packages/gateway/src/connectors/health.ts:316-325`](../../../packages/gateway/src/connectors/health.ts):

```ts
db.transaction(() => {
  upsertHealthRow(db, connectorId, { ... });
  appendHistory(db, connectorId, fromState, effectiveState, reason, now);
})();

```

If `appendHistory` invokes `healthSink(event)` synchronously, the sink callback executes **inside an active SQLite transaction**.

Performing IPC writes / external socket broadcasts inside SQLite transactions introduces risks:

- If an unhandled exception occurs in a synchronous sink listener, it rolls back the database transaction.
- If any notification handler attempts to query the database synchronously on the same connection, SQLite will throw or deadlock.
- If the transaction fails to commit after `appendHistory`, the event has already been broadcast to clients as if the transition succeeded.

**Required Fix:**  

1. Guarantee that `healthSink` invocation in `appendHistory` is wrapped in `try...catch` and cannot throw into the transaction.
2. Ensure the broadcast is deferred until the transaction successfully commits, or document clearly that `healthSink` must never synchronously query the database.
3. Provide `resetConnectorHealthSink()` or `setConnectorHealthSink(undefined)` so unit tests can clean up module state between test cases.

---

## 3. Schema Specifications & Event Contracts (Improvements)

The spec mentions event payloads informally in prose. To avoid implementation divergence, the complete schemas should be formalized:

### 3.1 `connector.healthChanged`

```ts
export interface ConnectorHealthChangedPayload {
  readonly connectorId: string;
  readonly fromState: ConnectorHealthState | null;
  readonly toState: ConnectorHealthState;
  readonly reason: string | null;
  readonly occurredAt: number;

  // Compatibility aliases for desktop
  readonly name: string;
  readonly health: ConnectorHealthState;
  readonly degradationReason?: string;
}

```

### 3.2 `gateway.event` Envelope

```ts
export interface GatewayEventNotification<K extends string = string, P = Record<string, unknown>> {
  readonly kind: K;
  readonly ts: number;
  readonly payload: P;
}

```

### 3.3 Concrete `kind` Payloads

#### `watcher.fired`

```ts
export interface WatcherFiredPayload {
  readonly watcherId: string;
  readonly name: string;
  readonly summary: string;
  readonly conditionType?: string;
  readonly firedAt: number;
}

```

#### `sync.completed`

```ts
export interface SyncCompletedPayload {
  readonly serviceId: string;
  readonly itemsUpserted: number;
  readonly itemsDeleted: number;
  readonly durationMs: number;
  readonly bytesTransferred?: number;
  readonly hasMore: boolean;
}

```

#### `extension.stateChanged`

```ts
export interface ExtensionStateChangedPayload {
  readonly extensionId: string;
  readonly action: "install" | "enable" | "disable" | "remove" | "update";
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

```

#### `hitl.requested` & `hitl.resolved` (Recommended for HITL lane)

```ts
export interface HitlRequestedPayload {
  readonly requestId: string;
  readonly prompt: string;
  readonly details?: unknown;
}

export interface HitlResolvedPayload {
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason?: string;
}

```

---

## 4. CLI UX, Formatting & Lifecycle Suggestions

### 4.1 CLI Output Formatting

The spec states output is line-oriented and respects `NO_COLOR`. Providing concrete examples in the spec ensures testable consistency:

**Human-Readable Mode (Default):**

```text
2026-09-13T14:32:01.102Z [connector] github: healthy -> degraded (transient error (attempt 1): rate limited)
2026-09-13T14:32:05.450Z [sync]      slack: synced 14 items, deleted 0 (182ms)
2026-09-13T14:32:12.800Z [watcher]   P0 Incidents: pagerduty: High latency on auth-service
2026-09-13T14:33:00.010Z [extension] nimbus-jira: enabled
2026-09-13T14:33:15.220Z [hitl]      #req-8f12: Post to Slack #ops requires consent (pending)

```

**JSON Mode (`--json`):**
Emits standard JSON Lines (JSONL) objects matching the exact JSON-RPC notification structure (`{ "method": "...", "params": { ... } }`), enabling easy piping to `jq` or file redirection.

### 4.2 Multi-Category Filtering

Support comma-separated filters and multiple flags:

- `nimbus tail --filter connector,sync`
- `nimbus tail --filter watcher --filter hitl`
- Invalid filter names (e.g. `nimbus tail --filter foobar`) should fail fast with `ERR_INVALID_ARGUMENT` and display the allowed categories: `connector`, `watcher`, `sync`, `extension`, `hitl`.

### 4.3 Process Signals & Pipe Handling

- **SIGINT / SIGTERM:** Cleanly unlisten and disconnect the IPC client, then exit with code 0.
- **SIGPIPE / Broken Pipe:** When piping to `head -n 5` (`nimbus tail --json | head -n 5`), writing to a closed stdout should not crash with an unhandled `EPIPE` error stack trace.
- **Gateway Disconnect:** On `client.onClose`, print `[nimbus tail] Gateway connection closed.` to stderr and exit with code 1.
- **Gateway Not Running:** Catch `GatewayNotRunningError` on initial connection and output `Gateway is not running. Start with: nimbus start` with exit code 1.

### 4.4 Stream Scope Disclosure

Make explicit in `--help` and docs that `nimbus tail` is **follow-only** (like `tail -f -n 0` / real-time event tap) and does not replay historical events before the connection instant.

---

## 5. Testing Plan Enhancements

Expand the test matrix in § 7 to include:

1. **Desktop Contract Test:**  
   Unit test in `packages/ui` asserting that `ConnectorGrid.tsx` / `onHealth` successfully updates state when receiving the exact payload emitted by `connector.healthChanged`.

2. **Multi-Client Broadcast Test:**  
   Integration test with 2 CLI `tail` clients and a mock desktop client all connected concurrently to the gateway, verifying all 3 receive identical broadcasts without message dropping or socket blocking.

3. **Sink Error Resilience Test:**  
   Unit test verifying that if `setConnectorHealthSink` callback throws an error, `transitionHealth` and `appendHistory` still complete successfully and persist to SQLite without throwing.

4. **Sink Lifecycle / Cleanup Test:**  
   Test calling `setConnectorHealthSink(undefined)` to ensure no stale callbacks or leaks remain.

5. **CLI Formatting & Filter Tests:**  
   - Verify filter matching and exclusion across all 5 categories.
   - Verify `--json` valid JSONL parsing.
   - Verify unrecognised future `kind` rendering fallback (`[unknown: my.new.kind] { ... }`).

---

## 6. Open Questions for Author / Engineering Team

1. **HITL Event Broadcast Architecture:**  
   Do we want to add `hitl.requested` and `hitl.resolved` to `gateway.event` as proposed in Finding 2 so that `nimbus tail` can observe HITL prompts triggered by other clients/agents?

2. **Compatibility Aliases Lifespan:**  
   Should the desktop compatibility aliases (`name`, `health`, `degradationReason`) on `connector.healthChanged` be permanent, or deprecated once the desktop UI transitions to consuming `connectorId` and `toState`? (Keeping them permanently is low cost and eliminates cross-repo sync hazards).

3. **Sync Failure Observability:**  
   The spec currently omits `sync.failed` in favour of relying on `connector.healthChanged`. However, a transient sync failure that does not change the coarse health state (e.g. 1st retry attempt during `degraded`) might not emit a health change if `fromState === toState`. Should `sync.completed` carry an `ok: boolean` and optional `error?: string`, or is health transition sufficient for v1?

4. **Historical Event Backlog (`-n / --lines`):**  
   Is there any requirement to support replaying recent history (e.g. from `connector_health_history` and `watcher_event`), or is forward-only follow mode confirmed as the complete scope for v0.1.1?
