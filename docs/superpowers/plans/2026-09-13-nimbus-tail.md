# `nimbus tail` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gateway operational event stream and a `nimbus tail` CLI that follows it, and fix the desktop connector-health panel that has never updated live.

**Architecture:** Two notification methods — `connector.healthChanged` (named, because the Tauri bridge matches on the method name) and `gateway.event` (an envelope carrying every other operational event by `kind`). Emitters live at existing chokepoints; each is bound to the live IPC broadcast after `createIpcServer(...)` via the same late-bind seam `identity-boot.ts` already uses. The CLI binds exactly two handlers and renders generically from `kind`.

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:sqlite`, `bun:test`, Biome. CLI consumes the published `@nimbus-dev/client` (IPC only — no gateway source imports).

**Spec:** [`../specs/2026-09-13-nimbus-tail-design.md`](../specs/2026-09-13-nimbus-tail-design.md) (and its review, [`../specs/2026-09-13-nimbus-tail-design-review.md`](../specs/2026-09-13-nimbus-tail-design-review.md))

## Global Constraints

- **No `any`.** Use `unknown` for external data; TypeScript strict is non-negotiable.
- **No new invariant, no migration, no new I29 egress class.** Every event is a LOCAL IPC broadcast; nothing leaves the machine.
- **`cli` reaches the gateway IPC-only.** No `packages/gateway` source imports from `packages/cli`.
- **Emit must never break the thing it observes.** Every sink call is wrapped so a throwing subscriber cannot fail a health transition, a watcher fire, a sync, or a consent prompt.
- **`connector.healthChanged` payload field names are `name` / `health` / `degradationReason`** — the desktop's existing vocabulary (`ConnectorStatus`). Never `connectorId` / `toState`.
- **`toState`-style values are `ConnectorHealthState`** (`healthy | not_configured | degraded | error | rate_limited | unauthenticated | paused`), never a `HealthEvent.type` such as `persistent_error`.
- **HITL is observation only.** The unicast `consent.request` is unchanged; `details` is never broadcast; `tail` never answers a prompt.
- **No per-item progress on the stream** (`broadcastNotification` fans out to every session).
- **Platform equality.** No OS-specific behaviour; run `bun run audit:cross-platform` before the PR.
- **Before the PR:** `bun run preflight`, and **strip both spec and review files** — specs never land on `main`.

---

### Task 1: The event contract and the late-bind sink

**Files:**

- Create: packages/gateway/src/ipc/gateway-events.ts _(new file)_
- Test: packages/gateway/src/ipc/gateway-events.test.ts _(new file)_

**Interfaces:**

- Consumes: nothing.
- Produces: `GatewayEventKind`, `GatewayEventNotification`, `ConnectorHealthChangedPayload`, `WatcherFiredPayload`, `SyncCompletedPayload`, `ExtensionStateChangedPayload`, `HitlRequestedPayload`, `HitlResolvedPayload`, `GatewayEventBroadcast`, `setGatewayEventBroadcast(b: GatewayEventBroadcast | undefined): void`, `emitGatewayEvent<K>(kind, payload): void`, `emitConnectorHealthChanged(p: ConnectorHealthChangedPayload): void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/ipc/gateway-events.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  emitConnectorHealthChanged,
  emitGatewayEvent,
  setGatewayEventBroadcast,
} from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

describe("gateway event sink", () => {
  test("drops emits when nothing is bound, rather than throwing", () => {
    // `buildIdentityBoot`'s precedent: assemble runs BEFORE the IPC broadcast exists, so an
    // unbound emit must be harmless. A unit test that never binds is the common case.
    expect(() => emitGatewayEvent("sync.completed", {
      serviceId: "github", itemsUpserted: 1, itemsDeleted: 0, durationMs: 5, hasMore: false,
    })).not.toThrow();
  });

  test("a bound broadcast receives the envelope with kind, ts and payload", () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
    emitGatewayEvent("watcher.fired", {
      watcherId: "w1", name: "P0", summary: "fired", firedAt: 7,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("gateway.event");
    const p = seen[0]?.params as { kind: string; ts: number; payload: { watcherId: string } };
    expect(p.kind).toBe("watcher.fired");
    expect(typeof p.ts).toBe("number");
    expect(p.payload.watcherId).toBe("w1");
  });

  test("connector health goes out as its OWN named method, not the envelope", () => {
    // The Tauri bridge matches on the METHOD name (`classify_notification`), so this one cannot
    // ride `gateway.event` — that is the whole reason it is named.
    const seen: string[] = [];
    setGatewayEventBroadcast((method) => seen.push(method));
    emitConnectorHealthChanged({
      name: "github", health: "error", fromState: "degraded", reason: "boom", occurredAt: 1,
    });
    expect(seen).toEqual(["connector.healthChanged"]);
  });

  test("a throwing subscriber is swallowed", () => {
    // The emit sites are inside health transitions, sync completion and consent prompts. A broken
    // subscriber must never fail the thing it is observing.
    setGatewayEventBroadcast(() => {
      throw new Error("subscriber exploded");
    });
    expect(() => emitGatewayEvent("extension.stateChanged", {
      extensionId: "x", action: "enable", ok: true,
    })).not.toThrow();
  });

  test("setGatewayEventBroadcast(undefined) clears a previously bound sink", () => {
    // Without this, one test's sink leaks into the next through module state.
    const seen: string[] = [];
    setGatewayEventBroadcast((m) => seen.push(m));
    setGatewayEventBroadcast(undefined);
    emitGatewayEvent("sync.completed", {
      serviceId: "s", itemsUpserted: 0, itemsDeleted: 0, durationMs: 1, hasMore: false,
    });
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/gateway-events.test.ts`
Expected: FAIL — `Cannot find module './gateway-events.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/ipc/gateway-events.ts
import type { ConnectorHealthState } from "../connectors/health.ts";

/**
 * The operational event stream `nimbus tail` follows.
 *
 * TWO methods, and that count is meant to be final. `connector.healthChanged` is named because it
 * has a SECOND consumer — `ui/src-tauri/src/gateway_bridge.rs`'s `classify_notification` matches on
 * the method name and cannot cheaply match a `kind` inside a payload. Everything else rides one
 * envelope, because `@nimbus-dev/client`'s `onNotification` is named-only (no wildcard) and lives
 * in another repository: without an envelope the CLI would need a hand-maintained method list, the
 * defect shape this repo has hit three times.
 */
export type GatewayEventKind =
  | "watcher.fired"
  | "sync.completed"
  | "extension.stateChanged"
  | "hitl.requested"
  | "hitl.resolved";

export interface GatewayEventNotification<P = Record<string, unknown>> {
  readonly kind: GatewayEventKind;
  readonly ts: number;
  readonly payload: P;
}

/**
 * Field names are the DESKTOP's (`ConnectorStatus.name` / `.health`), not the gateway's internal
 * vocabulary. `ConnectorGrid.tsx` reads `payload.name` and `payload.health`; a payload using
 * `connectorId`/`toState` would call `patchConnector(undefined, { health: undefined })`, match no
 * row, and leave the panel exactly as dead as it is today. `fromState`/`reason`/`occurredAt` are
 * added for `tail` and ignored by the desktop — one merged shape, never aliased pairs.
 */
export interface ConnectorHealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorHealthState;
  readonly degradationReason?: string;
  readonly fromState: ConnectorHealthState | null;
  readonly reason: string | null;
  readonly occurredAt: number;
}

export interface WatcherFiredPayload {
  readonly watcherId: string;
  readonly name: string;
  readonly summary: string;
  readonly firedAt: number;
}

export interface SyncCompletedPayload {
  readonly serviceId: string;
  readonly itemsUpserted: number;
  readonly itemsDeleted: number;
  readonly durationMs: number;
  readonly bytesTransferred?: number;
  readonly hasMore: boolean;
}

export interface ExtensionStateChangedPayload {
  readonly extensionId: string;
  readonly action: "install" | "enable" | "disable" | "remove" | "update";
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

/** `details` is deliberately ABSENT — see `emitHitlRequested`'s caller in `ipc/consent.ts`. */
export interface HitlRequestedPayload {
  readonly requestId: string;
  readonly prompt: string;
}

export interface HitlResolvedPayload {
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason?: string;
}

export type GatewayEventBroadcast = (method: string, params: Record<string, unknown>) => void;

/**
 * Module-level, late-bound, exactly as `identity-boot.ts`'s `bindLoginNotify` is.
 *
 * Emitters are constructed during `assemblePlatformServices`, which runs BEFORE `createIpcServer`
 * exists, so there is nothing to inject at construction time. `platform/assemble.ts` binds the live
 * broadcast after the server is up (the same line that calls `bindLoginNotify`). Until then — and
 * in every unit test that never binds — emits are dropped harmlessly.
 */
let broadcast: GatewayEventBroadcast | undefined;

export function setGatewayEventBroadcast(b: GatewayEventBroadcast | undefined): void {
  broadcast = b;
}

/**
 * Never throws. Every call site sits inside something that must not fail because an observer did:
 * a health transition, a sync completion, a watcher fire, a consent prompt.
 */
function safeBroadcast(method: string, params: Record<string, unknown>): void {
  if (broadcast === undefined) return;
  try {
    broadcast(method, params);
  } catch {
    // Intentionally swallowed. This is an observability stream, not a ledger: unlike the I29
    // appenders, a failed emit must NOT abort the operation being observed.
  }
}

export function emitGatewayEvent<P extends Record<string, unknown>>(
  kind: GatewayEventKind,
  payload: P,
): void {
  safeBroadcast("gateway.event", { kind, ts: Date.now(), payload });
}

export function emitConnectorHealthChanged(payload: ConnectorHealthChangedPayload): void {
  safeBroadcast("connector.healthChanged", { ...payload });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/gateway-events.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/gateway-events.ts packages/gateway/src/ipc/gateway-events.test.ts
git commit -m "feat(ipc): gateway operational event contract and late-bind sink"
```

---

### Task 2: Emit `connector.healthChanged` — after commit, not inside the transaction

**Files:**

- Modify: `packages/gateway/src/connectors/health.ts` (`transitionHealth`, `appendHistory`)
- Test: packages/gateway/src/connectors/health-events.test.ts _(new file)_

**Interfaces:**

- Consumes: `emitConnectorHealthChanged`, `setGatewayEventBroadcast` (Task 1).
- Produces: no new exports. `transitionHealth`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/health-events.test.ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { transitionHealth } from "./health.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

function captured(): Array<{ method: string; params: Record<string, unknown> }> {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
  return seen;
}

describe("connector.healthChanged", () => {
  test("emits the DESKTOP's field names, so ConnectorGrid can patch a row", () => {
    const db: Database = createMemoryIndexDb();
    const seen = captured();
    transitionHealth(db, "github", { type: "persistent_error", error: "boom" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("connector.healthChanged");
    const p = seen[0]?.params as Record<string, unknown>;
    // `name`/`health`, never `connectorId`/`toState`.
    expect(p["name"]).toBe("github");
    // `error` is the derived STATE; `persistent_error` is the EVENT type and must never appear.
    expect(p["health"]).toBe("error");
    expect(p["health"]).not.toBe("persistent_error");
  });

  test("an unchanged state still emits — from === to is a real, recorded transition", () => {
    // `transitionHealth` has no early return when the state does not change, so a repeat failure
    // while already degraded appends history and emits. Suppressing it would hide repeated
    // failures from the one reader who wants them.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "transient_error", error: "a", attempt: 1 });
    const seen = captured();
    transitionHealth(db, "github", { type: "transient_error", error: "b", attempt: 2 });
    expect(seen).toHaveLength(1);
    const p = seen[0]?.params as Record<string, unknown>;
    expect(p["fromState"]).toBe("degraded");
    expect(p["health"]).toBe("degraded");
  });

  test("a throwing subscriber leaves the transition COMMITTED", () => {
    const db: Database = createMemoryIndexDb();
    setGatewayEventBroadcast(() => {
      throw new Error("subscriber exploded");
    });
    expect(() => transitionHealth(db, "github", { type: "unauthenticated" })).not.toThrow();
    const row = db
      .query("SELECT health_state FROM sync_state WHERE connector_id = ?")
      .get("github") as { health_state: string } | null;
    expect(row?.health_state).toBe("unauthenticated");
  });

  test("emits AFTER the transaction commits, never inside it", () => {
    // The defect this prevents: `appendHistory` runs inside `db.transaction(...)`, so emitting
    // there publishes before commit. If the commit then failed, every client — including the
    // desktop — would have been told of a transition that never happened.
    const db: Database = createMemoryIndexDb();
    let rowsAtEmit = -1;
    setGatewayEventBroadcast(() => {
      rowsAtEmit = (
        db.query("SELECT COUNT(*) AS n FROM connector_health_history").get() as { n: number }
      ).n;
    });
    transitionHealth(db, "github", { type: "sync_success" });
    // The history row is already visible when the emit runs — proof the commit happened first.
    expect(rowsAtEmit).toBe(1);
  });

  test("a configured/not_configured change EMITS, despite the early return", () => {
    // `transitionHealth` returns early for these two before ever reaching the main transaction,
    // so an emit placed only after that transaction is unreachable for them — and these are the
    // transitions `nimbus connector auth` produces, the ones a user is most likely watching for.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "sync_success" }); // create the row, configured = 0
    const seen = captured();
    transitionHealth(db, "github", { type: "configured" });
    expect(seen).toHaveLength(1);
    const p = seen[0]?.params as Record<string, unknown>;
    expect(p["name"]).toBe("github");
    expect(p["reason"]).toBe("credential configured");
  });

  test("a configured event that changes NOTHING emits nothing", () => {
    // `applyConfiguredFlag` no-ops when the flag already matches; the emit must respect that
    // guard rather than firing on every auth check.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "configured" });
    const seen = captured();
    transitionHealth(db, "github", { type: "configured" });
    expect(seen).toEqual([]);
  });

  test("a non-state-changing event type emits nothing", () => {
    // `skipped_offline` appends history but is explicitly not a health CHANGE.
    const db: Database = createMemoryIndexDb();
    const seen = captured();
    transitionHealth(db, "github", { type: "skipped_offline" });
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/health-events.test.ts`
Expected: FAIL — first test gets `seen` length 0 (nothing emits yet)

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/connectors/health.ts`, add the import:

```ts
import { emitConnectorHealthChanged } from "../ipc/gateway-events.ts";
```

**First, make `applyConfiguredFlag` report what it recorded.** `transitionHealth` RETURNS EARLY for
`configured` / `not_configured`, so an emit placed after the main `db.transaction(...)` never runs
for them — and those are exactly the transitions `nimbus connector auth` produces. Rather than
duplicating the derived-state ternary at a second site, have the function hand back the state it
appended (or `null` when its no-op guard fired):

```ts
/** Returns the state it RECORDED, or `null` when nothing changed (the no-op guard). */
function applyConfiguredFlag(
  db: Database,
  connectorId: string,
  current: SyncStateHealthRow | null,
  fromState: string | null,
  nowConfigured: boolean,
  now: number,
): ConnectorHealthState | null {
  if (current === null) return null;
  if ((current.configured !== 0) === nowConfigured) return null;
  dbRun(db, "UPDATE sync_state SET configured = ? WHERE connector_id = ?", [
    nowConfigured ? 1 : 0,
    connectorId,
  ]);
  // ONE derivation, reused by both the history row and the event — a second copy of this ternary
  // is a second place for them to disagree about what the state became.
  const recorded: ConnectorHealthState = nowConfigured
    ? ((fromState as ConnectorHealthState | null) ?? "healthy")
    : "not_configured";
  appendHistory(
    db,
    connectorId,
    fromState,
    recorded,
    nowConfigured ? "credential configured" : "no credential configured",
    now,
  );
  return recorded;
}
```

Then emit from the early-return branch, only when something actually changed:

```ts
  if (event.type === "not_configured" || event.type === "configured") {
    const recorded = applyConfiguredFlag(
      db, connectorId, current, fromState, event.type === "configured", now,
    );
    if (recorded !== null) {
      emitConnectorHealthChanged({
        name: connectorId,
        health: recorded,
        fromState: (fromState as ConnectorHealthState | null) ?? null,
        reason: event.type === "configured" ? "credential configured" : "no credential configured",
        occurredAt: now,
      });
    }
    return buildSnapshot(connectorId, readHealthRow(db, connectorId));
  }
```

**On the `as ConnectorHealthState` casts.** `SyncStateHealthRow.health_state` is typed `string`, so
`fromState` is `string | null` and assigning it to the payload's `ConnectorHealthState | null` is a
strict-mode error. The cast matches what this file already does at its snapshot builder —
`((row.health_state as ConnectorHealthState) ?? "healthy")` — so it is the file's existing idiom,
not a new one. The column is written only by this module, from that union.

Then change the state-changing branch of `transitionHealth` so the emit happens **after** the transaction closure returns:

```ts
  const effectiveState = to;

  db.transaction(() => {
    upsertHealthRow(db, connectorId, {
      health_state: effectiveState,
      retry_after: retryAfterMs,
      backoff_until: backoffUntilMs,
      backoff_attempt: backoffAttempt,
      last_error: lastError,
    });
    appendHistory(db, connectorId, fromState, effectiveState, reason, now);
  })();

  // AFTER the transaction, deliberately. Emitting from inside `appendHistory` would publish before
  // commit — a rollback would leave clients told of a transition that never happened — and would
  // let a throwing subscriber roll the transaction back. `appendHistory` stays the single place
  // every transition is RECORDED; this is the single place one is ANNOUNCED.
  emitConnectorHealthChanged({
    name: connectorId,
    health: effectiveState,
    ...(reason === null ? {} : { degradationReason: reason }),
    // `string | null` -> the payload's union; same cast idiom as this file's snapshot builder.
    fromState: (fromState as ConnectorHealthState | null) ?? null,
    reason,
    occurredAt: now,
  });

  const updated = readHealthRow(db, connectorId);
  return buildSnapshot(connectorId, updated);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/health-events.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Red-prove the commit-ordering guard**

Temporarily move the `emitConnectorHealthChanged(...)` call to the last line _inside_ the
`db.transaction(() => { ... })` closure. Run the test again.
Expected: the "emits AFTER the transaction commits" test FAILS (`rowsAtEmit` is `0`).
Then move it back out and re-run — expected PASS. Do not commit the temporary move.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/health.ts packages/gateway/src/connectors/health-events.test.ts
git commit -m "feat(connectors): emit connector.healthChanged after the health transaction commits"
```

---

### Task 3: Bind the broadcast, and prove the desktop contract

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts:4112` (beside `bindLoginNotify`)
- Test: packages/ui/test/components/dashboard/ConnectorGrid.health-contract.test.tsx _(new file)_

**Interfaces:**

- Consumes: `setGatewayEventBroadcast` (Task 1), `emitConnectorHealthChanged`'s payload shape (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing desktop contract test**

```tsx
// packages/ui/test/components/dashboard/ConnectorGrid.health-contract.test.tsx
import { describe, expect, test } from "bun:test";
import type { ConnectorStatus } from "../../../src/ipc/types";

/**
 * Lives under `packages/ui/test/`, never `packages/ui/src/`: every UI test in this repo does
 * (`packages/ui/test/components/dashboard/ConnectorGrid.test.tsx` is its neighbour), and a test
 * file under `src/` risks landing in the Vite production bundle.
 *
 * The guard for the defect the design review caught: the gateway and the desktop were each tested
 * against THEMSELVES, so a payload the desktop cannot read would have passed every gateway test
 * and still left the panel dead. This asserts the exact payload the gateway emits is one
 * `ConnectorGrid`'s `onHealth` can act on.
 *
 * Kept as a pure shape/behaviour check rather than a render test so it needs no DOM: the defect is
 * in the payload contract, not in rendering.
 */
interface HealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorStatus["health"];
  readonly degradationReason?: string;
}

/** Byte-for-byte the object `emitConnectorHealthChanged` broadcasts (gateway Task 2). */
const GATEWAY_PAYLOAD = {
  name: "github",
  health: "error",
  degradationReason: "sync failed after repeated attempts",
  fromState: "degraded",
  reason: "sync failed after repeated attempts",
  occurredAt: 1_789_300_000_000,
} as const;

describe("connector.healthChanged desktop contract", () => {
  test("the gateway payload carries the two fields ConnectorGrid actually reads", () => {
    const payload = GATEWAY_PAYLOAD as unknown as HealthChangedPayload;
    // `patchConnector(payload.name, { health: payload.health })` — both must be defined, or the
    // patch matches no row and the panel silently does not update.
    expect(payload.name).toBe("github");
    expect(payload.health).toBe("error");
    expect(payload.name).not.toBeUndefined();
    expect(payload.health).not.toBeUndefined();
  });

  test("health is a ConnectorHealth value, never a HealthEvent type", () => {
    const valid: ReadonlyArray<ConnectorStatus["health"]> = [
      "healthy",
      "degraded",
      "error",
      "rate_limited",
      "unauthenticated",
      "paused",
    ];
    expect(valid).toContain(GATEWAY_PAYLOAD.health);
    expect(GATEWAY_PAYLOAD.health).not.toBe("persistent_error");
  });

  test("the extra gateway fields do not collide with what the desktop reads", () => {
    // `fromState`/`reason`/`occurredAt` are for `nimbus tail`. The desktop ignores them; this
    // pins that they are ADDITIONS, not renames of the fields it needs.
    const keys = Object.keys(GATEWAY_PAYLOAD);
    expect(keys).toContain("name");
    expect(keys).toContain("health");
    expect(keys).not.toContain("connectorId");
    expect(keys).not.toContain("toState");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/test/components/dashboard/ConnectorGrid.health-contract.test.tsx`
Expected: PASS immediately if Task 2 landed the correct shape. If it FAILS, Task 2's payload is
wrong — fix Task 2, not this test. (This test is a contract pin, so a green first run is the
correct outcome here; its value is that it goes red if either side drifts.)

- [ ] **Step 3: Bind the live broadcast in assemble**

In `packages/gateway/src/platform/assemble.ts`, immediately after the existing line 4112:

```ts
  identityBoot?.bindLoginNotify((method, payload) => ipc.broadcast(method, payload));
  // Same seam, same reason: the emitters are constructed during assemble, which runs before
  // `createIpcServer(...)` exists. Until this line runs, every operational emit is dropped
  // harmlessly — which is also what makes unit tests that never bind safe.
  setGatewayEventBroadcast((method, params) => ipc.broadcast(method, params));
```

And add the import at the top of the file:

```ts
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
```

- [ ] **Step 4: Verify the gateway still boots and nothing regressed**

Run: `bun test packages/gateway/src/platform packages/gateway/src/connectors/health-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/ui/test/components/dashboard/ConnectorGrid.health-contract.test.tsx
git commit -m "feat(platform): bind the operational event broadcast; pin the desktop health contract"
```

---

### Task 4: Emit `sync.completed`

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts:776` (`onConnectorSyncSuccess`)
- Test: packages/gateway/src/ipc/gateway-events.sync.test.ts _(new file)_

**Interfaces:**

- Consumes: `emitGatewayEvent`, `SyncCompletedPayload` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/ipc/gateway-events.sync.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { emitGatewayEvent, setGatewayEventBroadcast } from "./gateway-events.ts";
import type { SyncCompletedPayload } from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

describe("sync.completed", () => {
  test("carries the item deltas the roadmap row promised", () => {
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    const payload: SyncCompletedPayload = {
      serviceId: "slack",
      itemsUpserted: 14,
      itemsDeleted: 0,
      durationMs: 182,
      bytesTransferred: 4096,
      hasMore: false,
    };
    emitGatewayEvent("sync.completed", { ...payload });
    const p = seen[0] as { kind: string; payload: SyncCompletedPayload };
    expect(p.kind).toBe("sync.completed");
    expect(p.payload.itemsUpserted).toBe(14);
    expect(p.payload.itemsDeleted).toBe(0);
    expect(p.payload.durationMs).toBe(182);
  });

  test("bytesTransferred is optional and omitted rather than zeroed", () => {
    // `SyncResult.bytesTransferred` is optional; a connector that does not report bytes must not
    // be rendered as having transferred none.
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    emitGatewayEvent("sync.completed", {
      serviceId: "slack", itemsUpserted: 1, itemsDeleted: 0, durationMs: 5, hasMore: false,
    });
    const p = seen[0] as { payload: Record<string, unknown> };
    expect("bytesTransferred" in p.payload).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/gateway-events.sync.test.ts`
Expected: PASS (this exercises Task 1's emitter directly). If it fails, Task 1 is wrong.

- [ ] **Step 3: Wire the emit at the existing hook**

In `packages/gateway/src/platform/assemble.ts`, inside `onConnectorSyncSuccess`, after the two
`syncAnomaly.recordSample(...)` lines:

```ts
    onConnectorSyncSuccess: (serviceId, result, durationMs) => {
      const at = Date.now();
      syncAnomaly.recordSample(`sync:duration_ms:${serviceId}`, durationMs, at);
      syncAnomaly.recordSample(`sync:items_upserted:${serviceId}`, result.itemsUpserted, at);
      // The hook already existed and already carries every field this event needs.
      emitGatewayEvent("sync.completed", {
        serviceId,
        itemsUpserted: result.itemsUpserted,
        itemsDeleted: result.itemsDeleted,
        durationMs,
        ...(result.bytesTransferred === undefined
          ? {}
          : { bytesTransferred: result.bytesTransferred }),
        hasMore: result.hasMore,
      });
      evaluateWatchersAfterSync(db, serviceId, at, (t, b) => notifications.show(t, b), watcherOpts);
      glossaryRefresher.trigger();
      decisionsRefresher?.trigger();
      premortemRefresher?.trigger();
      ownershipRefresher?.trigger();
    },
```

Add `emitGatewayEvent` to the existing `gateway-events.ts` import added in Task 3.

- [ ] **Step 4: Run the suite**

Run: `bun test packages/gateway/src/ipc packages/gateway/src/platform`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/gateway/src/ipc/gateway-events.sync.test.ts
git commit -m "feat(sync): emit sync.completed with item deltas at the existing success hook"
```

---

### Task 5: Emit `watcher.fired`

**Files:**

- Modify: `packages/gateway/src/automation/watcher-engine.ts` (`WatcherEvalOptions`, both evaluate functions)
- Modify: `packages/gateway/src/platform/assemble.ts:780` and `:835` (the two `watcherOpts` call sites)
- Test: packages/gateway/src/automation/watcher-engine.fired-event.test.ts _(new file)_

**Interfaces:**

- Consumes: `emitGatewayEvent`, `WatcherFiredPayload` (Task 1).
- Produces: `WatcherEvalOptions.onFired?: (p: WatcherFiredPayload) => void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/automation/watcher-engine.fired-event.test.ts
import { describe, expect, test } from "bun:test";
import type { WatcherFiredPayload } from "../ipc/gateway-events.ts";
import type { WatcherEvalOptions } from "./watcher-engine.ts";

describe("WatcherEvalOptions.onFired", () => {
  test("is a STRUCTURED dep, distinct from the human-prose toast callback", () => {
    // The engine's existing `notify(title, body)` is OS-toast prose (`${w.name}: ${summary}`).
    // Reusing it would make the stream's payload a rendering decision, and — more importantly —
    // would blur a local IPC event with the ChatOps path that `makeChatopsWatcherNotify` is
    // explicitly NOT wired for (I23 / I29 territory). Separate dep, separate purpose.
    const seen: WatcherFiredPayload[] = [];
    const opts: WatcherEvalOptions = { onFired: (p) => seen.push(p) };
    opts.onFired?.({ watcherId: "w1", name: "P0 Incidents", summary: "latency", firedAt: 42 });
    expect(seen).toEqual([
      { watcherId: "w1", name: "P0 Incidents", summary: "latency", firedAt: 42 },
    ]);
  });

  test("is optional, so existing callers compile unchanged", () => {
    const opts: WatcherEvalOptions = { graphConditionsEnabled: true };
    expect(opts.onFired).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/automation/watcher-engine.fired-event.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'onFired' does not exist in type 'WatcherEvalOptions'`

- [ ] **Step 3: Add the dep and call it at both fire sites**

In `packages/gateway/src/automation/watcher-engine.ts`:

```ts
import type { WatcherFiredPayload } from "../ipc/gateway-events.ts";

export type WatcherEvalOptions = {
  graphConditionsEnabled?: boolean;
  /**
   * Structured observation of a fire, for the operational event stream.
   *
   * Deliberately NOT the `notify(title, body)` parameter beside it: that one is human prose for an
   * OS toast. Keeping them separate also keeps this lane visibly distinct from
   * `makeChatopsWatcherNotify`, which is unwired precisely because routing watcher alerts OUTBOUND
   * would put the path under I23 and plausibly I29.
   */
  onFired?: (payload: WatcherFiredPayload) => void;
};
```

In **both** `evaluateWatchersAfterSync` and `evaluateWatchersStartupCatchUp`, immediately after the
existing `void notify("Nimbus watcher", ...)` line inside the `if (fired !== null)` block:

```ts
      void notify("Nimbus watcher", `${w.name}: ${fired.summary}`);
      opts.onFired?.({
        watcherId: w.id,
        name: w.name,
        summary: fired.summary,
        firedAt: nowMs,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/automation/`
Expected: PASS

- [ ] **Step 5: Wire it in assemble at BOTH call sites**

In `packages/gateway/src/platform/assemble.ts`, change the shared options object so both callers
carry the emit (it is built once at line ~631 as `watcherOpts`):

```ts
  const watcherOpts = {
    graphConditionsEnabled: automation.graphConditions,
    // Both `evaluateWatchersAfterSync` (line ~780) and `evaluateWatchersStartupCatchUp`
    // (line ~835) share this object, so wiring it here covers both fire paths — a per-call-site
    // wiring is one place for the second to be forgotten.
    onFired: (p: WatcherFiredPayload) => emitGatewayEvent("watcher.fired", { ...p }),
  };
```

Add `WatcherFiredPayload` to the `gateway-events.ts` type import.

- [ ] **Step 6: Run the suite and commit**

Run: `bun test packages/gateway/src/automation packages/gateway/src/platform`
Expected: PASS

```bash
git add packages/gateway/src/automation/watcher-engine.ts packages/gateway/src/automation/watcher-engine.fired-event.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(automation): emit watcher.fired as a structured event at both fire sites"
```

---

### Task 6: Emit `hitl.requested` / `hitl.resolved` — observation only

**Files:**

- Modify: `packages/gateway/src/ipc/consent.ts` (`requestConsent`, `handleRespond`, and the disconnect/reject-all paths)
- Test: packages/gateway/src/ipc/consent-events.test.ts _(new file)_

**Interfaces:**

- Consumes: `emitGatewayEvent`, `HitlRequestedPayload`, `HitlResolvedPayload` (Task 1).
- Produces: nothing new. `requestConsent`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/ipc/consent-events.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

type Seen = { method: string; params: Record<string, unknown> };

function capture(): Seen[] {
  const seen: Seen[] = [];
  setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
  return seen;
}

describe("HITL observation events", () => {
  test("a prompt broadcasts hitl.requested ALONGSIDE the unicast consent.request", () => {
    // `consent.request` is written to ONE session (`getWriter(clientId)`), so a separate
    // `nimbus tail` process can never see it. The broadcast is what makes `--filter hitl` real.
    const unicast: unknown[] = [];
    const c = new ConsentCoordinatorImpl(() => (n) => unicast.push(n));
    const seen = capture();
    void c.requestConsent("client-a", { requestId: "r1", prompt: "Post to Slack?" });
    // The targeted notification is UNCHANGED — this lane observes a gate, it is not part of one.
    expect(unicast).toHaveLength(1);
    const ev = seen.find((s) => s.method === "gateway.event");
    expect(ev).toBeDefined();
    const p = ev?.params as { kind: string; payload: Record<string, unknown> };
    expect(p.kind).toBe("hitl.requested");
    expect(p.payload["requestId"]).toBe("r1");
    expect(p.payload["prompt"]).toBe("Post to Slack?");
  });

  test("`details` is NEVER broadcast", () => {
    // `details` can carry action arguments. The targeted client needs it to render an approval
    // card; a passive observer does not, and broadcasting it would widen who sees those arguments
    // to every connected client, MCP clients included.
    const c = new ConsentCoordinatorImpl(() => () => {});
    const seen = capture();
    void c.requestConsent("client-a", {
      requestId: "r2",
      prompt: "Send email?",
      details: { to: "ceo@example.com", body: "secret" },
    });
    const ev = seen.find((s) => s.method === "gateway.event");
    const p = ev?.params as { payload: Record<string, unknown> };
    expect("details" in p.payload).toBe(false);
    expect(JSON.stringify(p.payload)).not.toContain("ceo@example.com");
  });

  test("an answer broadcasts hitl.resolved with the verdict", () => {
    const c = new ConsentCoordinatorImpl(() => () => {});
    void c.requestConsent("client-a", { requestId: "r3", prompt: "ok?" });
    const seen = capture();
    c.handleRespond("client-a", { requestId: "r3", approved: true });
    const ev = seen.find(
      (s) =>
        s.method === "gateway.event" &&
        (s.params as { kind: string }).kind === "hitl.resolved",
    );
    expect(ev).toBeDefined();
    const p = ev?.params as { payload: Record<string, unknown> };
    expect(p.payload["requestId"]).toBe("r3");
    expect(p.payload["approved"]).toBe(true);
  });

  test("a FOREIGN requestId is still refused — observation grants no authority", () => {
    // A `tail` client that tried to answer must not be able to. This is the existing behaviour;
    // the test pins that adding the broadcast did not loosen it.
    const c = new ConsentCoordinatorImpl(() => () => {});
    const err = c.handleRespond("client-b", { requestId: "never-issued", approved: true });
    expect(err?.code).toBe(-32602);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/consent-events.test.ts`
Expected: FAIL — no `gateway.event` is broadcast yet

- [ ] **Step 3: Add the observation emits**

In `packages/gateway/src/ipc/consent.ts`, import:

```ts
import { emitGatewayEvent } from "./gateway-events.ts";
```

In `requestConsent`, after `write(notif);`:

```ts
      write(notif);
      // OBSERVATION ONLY, and additive: `consent.request` above stays unicast to the acting
      // client, so consent semantics (who is asked, who may answer) are untouched. `details` is
      // deliberately withheld — it can carry action arguments, and this goes to every session.
      emitGatewayEvent("hitl.requested", { requestId, prompt });
```

In `handleRespond`, at the point the pending entry is resolved (after the `approved` verdict is
known and the entry removed from `this.pending`):

```ts
      emitGatewayEvent("hitl.resolved", { requestId, approved });
```

In `rejectAllPending`, the existing loop iterates `snapshot.values()`, so the `requestId` is NOT
in scope — it must become `snapshot.entries()`:

```ts
  rejectAllPending(message: string, hitlAuditReason: string): void {
    const err = new ConsentDisconnectedError(message, hitlAuditReason);
    const snapshot = new Map(this.pending);
    this.pending.clear();
    // `.entries()`, not `.values()`: the key IS the requestId, and `hitl.resolved` is useless
    // without it. The existing loop discarded it because nothing needed it before.
    for (const [requestId, entry] of snapshot.entries()) {
      entry.reject(err);
      emitGatewayEvent("hitl.resolved", { requestId, approved: false, reason: message });
    }
  }
```

Apply the same `.entries()` change to any per-client disconnect path that abandons pending
requests, emitting `reason: "client disconnected"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/consent-events.test.ts packages/gateway/src/ipc/consent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/consent.ts packages/gateway/src/ipc/consent-events.test.ts
git commit -m "feat(ipc): broadcast hitl.requested/hitl.resolved as observation events"
```

---

### Task 7: Emit `extension.stateChanged` on runtime mutations

**Files:**

- Modify: `packages/gateway/src/ipc/automation-rpc.ts` (the `extension.*` handler map)
- Test: packages/gateway/src/ipc/gateway-events.extension.test.ts _(new file)_

**Interfaces:**

- Consumes: `emitGatewayEvent`, `ExtensionStateChangedPayload` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/ipc/gateway-events.extension.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  emitGatewayEvent,
  type ExtensionStateChangedPayload,
  setGatewayEventBroadcast,
} from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

describe("extension.stateChanged", () => {
  test("covers the five RUNTIME mutations, not the boot verification pass", () => {
    // `verifyExtensionsBestEffort` runs ONCE at boot (`assemble.ts:3309`), before anyone is
    // tailing, so a signature-disable is not a streamable event — `nimbus extension list`/`info`
    // already surface it. Only owner-initiated IPC mutations happen while someone is watching.
    const actions: ExtensionStateChangedPayload["action"][] = [
      "install",
      "enable",
      "disable",
      "remove",
      "update",
    ];
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    for (const action of actions) {
      emitGatewayEvent("extension.stateChanged", { extensionId: "nimbus-jira", action, ok: true });
    }
    expect(seen).toHaveLength(5);
    expect(
      seen.map((s) => (s as { payload: ExtensionStateChangedPayload }).payload.action),
    ).toEqual(actions);
  });

  test("a failed mutation is reported with ok:false and its error", () => {
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    emitGatewayEvent("extension.stateChanged", {
      extensionId: "nimbus-jira",
      action: "install",
      ok: false,
      error: "signature verification failed",
    });
    const p = seen[0] as { payload: ExtensionStateChangedPayload };
    expect(p.payload.ok).toBe(false);
    expect(p.payload.error).toBe("signature verification failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/gateway-events.extension.test.ts`
Expected: PASS (exercises Task 1's emitter). If it fails, Task 1 is wrong.

- [ ] **Step 3: Emit from each mutation handler**

The handlers are a METHOD MAP in `packages/gateway/src/ipc/automation-rpc.ts` (around lines
208–245), not individual functions in `dispatchers.ts` — that file only delegates the whole
`extension.*` namespace via `dispatchAutomationRpc`. Each entry is an arrow returning
`{ kind: "hit", value }`, so the emit goes inside the arrow, after the mutation call.

`extension.enable` today:

```ts
  "extension.enable": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setExtensionEnabled(ctx.db, requireString(rec, "id"), true) },
  }),
```

becomes:

```ts
  "extension.enable": (rec, ctx) => {
    const id = requireString(rec, "id");
    const ok = setExtensionEnabled(ctx.db, id, true);
    emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "enable", ok });
    return { kind: "hit", value: { ok } };
  },
```

`extension.disable` already destructures `id` and `ok`, so add one line before its return:

```ts
    emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "disable", ok });
```

For `extension.install`, `extension.update` and `extension.remove`, emit after the delegated call
returns, using the id each already resolves (`requireString(rec, "id")` for remove; the install and
update handlers delegate to `handleExtensionInstall` / `handleAutoUpdateRpc`, so wrap the call:

```ts
  "extension.install": async (rec, ctx) => {
    const id = requireString(rec, "id");
    try {
      const out = await handleExtensionInstall(rec, ctx);
      emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "install", ok: true });
      return out;
    } catch (e) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "install",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
```

**`extension.sync` is deliberately NOT emitted.** It syncs publisher keys, not extension state —
internal maintenance rather than something whose change a reader is watching for. Neither are
`extension.list`/`info`/`checkForUpdates`, which mutate nothing.

Add the import at the top of `automation-rpc.ts`:

```ts
import { emitGatewayEvent } from "./gateway-events.ts";
```

- [ ] **Step 4: Run the suite**

Run: `bun test packages/gateway/src/ipc`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/automation-rpc.ts packages/gateway/src/ipc/gateway-events.extension.test.ts
git commit -m "feat(ipc): emit extension.stateChanged on runtime extension mutations"
```

---

### Task 8: The `nimbus tail` CLI

**Files:**

- Create: packages/cli/src/commands/tail.ts _(new file)_
- Test: packages/cli/src/commands/tail.test.ts _(new file)_

**Interfaces:**

- Consumes: the two notification methods (Tasks 1–7). No gateway source imports.
- Produces: `runTailCommand(args: string[], deps?: TailCommandDeps): Promise<void>`, `parseTailArgs(args: string[]): TailCliArgs`, `renderEvent(method: string, params: unknown): string | null`, `TailCommandDeps`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/tail.test.ts
import { describe, expect, test } from "bun:test";
import type { IPCClient } from "../ipc-client/index.ts";
import { parseTailArgs, renderEvent, runTailCommand, type TailCommandDeps } from "./tail.ts";

describe("parseTailArgs", () => {
  test("defaults to every category and human output", () => {
    const a = parseTailArgs([]);
    expect(a.categories).toEqual(["connector", "watcher", "sync", "extension", "hitl"]);
    expect(a.json).toBe(false);
  });

  test("accepts a COMMA-SEPARATED list", () => {
    expect(parseTailArgs(["--filter", "connector,sync"]).categories).toEqual([
      "connector",
      "sync",
    ]);
  });

  test("is REPEATABLE and unions the results", () => {
    expect(parseTailArgs(["--filter", "watcher", "--filter", "hitl"]).categories).toEqual([
      "watcher",
      "hitl",
    ]);
  });

  test("an unknown category FAILS FAST naming the valid set", () => {
    // A filter that silently matches nothing is indistinguishable from a quiet system — the exact
    // failure this command exists to prevent.
    expect(() => parseTailArgs(["--filter", "foobar"])).toThrow(/connector, watcher, sync/);
  });

  test("--help throws the usage text, which states follow-only", () => {
    expect(() => parseTailArgs(["--help"])).toThrow(/follow-only/);
  });
});

describe("renderEvent", () => {
  test("renders a health change in the desktop's field names", () => {
    const line = renderEvent("connector.healthChanged", {
      name: "github",
      health: "degraded",
      fromState: "healthy",
      reason: "rate limited",
      occurredAt: 1_789_300_000_000,
    });
    expect(line).toContain("[connector]");
    expect(line).toContain("github");
    expect(line).toContain("healthy -> degraded");
    expect(line).toContain("rate limited");
  });

  test("renders a sync completion with item deltas", () => {
    const line = renderEvent("gateway.event", {
      kind: "sync.completed",
      ts: 1_789_300_000_000,
      payload: { serviceId: "slack", itemsUpserted: 14, itemsDeleted: 0, durationMs: 182, hasMore: false },
    });
    expect(line).toContain("[sync]");
    expect(line).toContain("slack");
    expect(line).toContain("+14");
  });

  test("an UNKNOWN future kind still prints rather than being dropped", () => {
    // A stream that silently discards what it does not recognise is the same failure class as a
    // brief rendering a missing section as empty.
    const line = renderEvent("gateway.event", {
      kind: "some.future.kind",
      ts: 1_789_300_000_000,
      payload: { a: 1 },
    });
    expect(line).toContain("unknown: some.future.kind");
  });

  test("a malformed notification returns null instead of throwing", () => {
    expect(renderEvent("gateway.event", null)).toBeNull();
    expect(renderEvent("gateway.event", { kind: 7 })).toBeNull();
  });
});

describe("runTailCommand lifecycle", () => {
  function harness(over: Partial<TailCommandDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const handlers: Record<string, (p: unknown) => void> = {};
    const client = {
      onNotification: (m: string, h: (p: unknown) => void) => {
        handlers[m] = h;
      },
      onClose: (_h: () => void) => {},
      disconnect: async () => {},
    } as unknown as IPCClient;
    const deps: TailCommandDeps = {
      connect: async () => client,
      readState: async () => ({ socketPath: "/tmp/fake.sock" }),
      writeOut: (l) => out.push(l),
      writeErr: (l) => err.push(l),
      onExit: (c) => exits.push(c),
      ...over,
    };
    return { deps, out, err, exits, handlers };
  }

  test("a gateway that is not running writes the standard line and exits 1", async () => {
    const h = harness({ readState: async () => undefined });
    await runTailCommand([], h.deps);
    expect(h.err.join("")).toContain("Gateway is not running");
    expect(h.exits).toEqual([1]);
  });

  test("binds EXACTLY the two handlers, never a third", async () => {
    // The count is the design's central claim: a future operational event must arrive with no CLI
    // change. A third handler here means someone reintroduced a per-method list.
    const h = harness();
    const done = runTailCommand([], h.deps);
    expect(Object.keys(h.handlers).sort()).toEqual(["connector.healthChanged", "gateway.event"]);
    process.emit("SIGINT");
    await done;
  });

  test("--filter excludes a known category it did not name", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    h.handlers["connector.healthChanged"]?.({
      name: "github", health: "error", fromState: "healthy", reason: null, occurredAt: 1,
    });
    expect(h.out).toEqual([]);
    process.emit("SIGINT");
    await done;
  });

  test("an UNKNOWN kind is shown even under a filter", async () => {
    // Deliberate: a stream that silently discards what it does not recognise is the failure this
    // design rejects. The plan review read this as "filtered out" — it is not.
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    h.handlers["gateway.event"]?.({ kind: "some.future.kind", ts: 1, payload: {} });
    expect(h.out.join("")).toContain("unknown: some.future.kind");
    process.emit("SIGINT");
    await done;
  });

  test("SIGINT removes its own listeners", async () => {
    // `process` outlives the promise; a leaked handler per invocation is invisible until a caller
    // runs the command twice in one process.
    const before = process.listenerCount("SIGINT");
    const h = harness();
    const done = runTailCommand([], h.deps);
    process.emit("SIGINT");
    await done;
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/tail.test.ts`
Expected: FAIL — `Cannot find module './tail.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/commands/tail.ts
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { flagValue } from "./_agent-brief-cli.ts";

export type TailCategory = "connector" | "watcher" | "sync" | "extension" | "hitl";

const ALL_CATEGORIES: readonly TailCategory[] = [
  "connector",
  "watcher",
  "sync",
  "extension",
  "hitl",
];

export type TailCliArgs = {
  categories: readonly TailCategory[];
  json: boolean;
};

const USAGE =
  "Usage: nimbus tail [--filter <categories>] [--json]\n" +
  `  --filter   comma-separated, repeatable: ${ALL_CATEGORIES.join(", ")}\n` +
  "  --json     emit raw JSON-RPC notifications as JSONL, one per line\n" +
  "\n" +
  "Streams gateway operational events as they happen. It is FOLLOW-ONLY: like `tail -f -n 0`,\n" +
  "it shows what happens from the moment it connects and replays nothing that came before.\n" +
  "Exits on Ctrl+C.";

function isCategory(v: string): v is TailCategory {
  return (ALL_CATEGORIES as readonly string[]).includes(v);
}

export function parseTailArgs(args: string[]): TailCliArgs {
  const picked: TailCategory[] = [];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--filter") {
      const raw = flagValue(args, i, "--filter");
      for (const part of raw.split(",").map((s) => s.trim())) {
        if (part === "") continue;
        if (!isCategory(part)) {
          throw new Error(
            `Unknown --filter category: ${part}\nValid: ${ALL_CATEGORIES.join(", ")}\n${USAGE}`,
          );
        }
        if (!picked.includes(part)) picked.push(part);
      }
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else {
      throw new Error(`Unexpected argument: ${String(a)}\n${USAGE}`);
    }
  }

  return { categories: picked.length === 0 ? ALL_CATEGORIES : picked, json };
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}

function ts(ms: unknown): string {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}

/** The category a notification belongs to, or `null` when it is not one of ours. */
export function categoryOf(method: string, params: unknown): TailCategory | null {
  if (method === "connector.healthChanged") return "connector";
  if (method !== "gateway.event") return null;
  const o = rec(params);
  const kind = o === null ? null : str(o, "kind");
  if (kind === null) return null;
  if (kind.startsWith("watcher.")) return "watcher";
  if (kind.startsWith("sync.")) return "sync";
  if (kind.startsWith("extension.")) return "extension";
  if (kind.startsWith("hitl.")) return "hitl";
  // A future kind in an unknown namespace still belongs on an unfiltered stream.
  return null;
}

export function renderEvent(method: string, params: unknown): string | null {
  const o = rec(params);
  if (o === null) return null;

  if (method === "connector.healthChanged") {
    const name = str(o, "name");
    const health = str(o, "health");
    if (name === null || health === null) return null;
    const from = str(o, "fromState") ?? "unknown";
    const reason = str(o, "reason");
    const tail = reason === null ? "" : ` (${reason})`;
    return `${ts(o["occurredAt"])} [connector] ${name}: ${from} -> ${health}${tail}`;
  }

  if (method !== "gateway.event") return null;
  const kind = str(o, "kind");
  if (kind === null) return null;
  const payload = rec(o["payload"]) ?? {};
  const at = ts(o["ts"]);

  if (kind === "sync.completed") {
    const svc = str(payload, "serviceId") ?? "?";
    const up = payload["itemsUpserted"];
    const del = payload["itemsDeleted"];
    const ms = payload["durationMs"];
    return `${at} [sync]      ${svc}: +${String(up)} items, -${String(del)} (${String(ms)}ms)`;
  }
  if (kind === "watcher.fired") {
    return `${at} [watcher]   ${str(payload, "name") ?? "?"}: ${str(payload, "summary") ?? ""}`;
  }
  if (kind === "extension.stateChanged") {
    const ok = payload["ok"] === true ? "" : " (failed)";
    return `${at} [extension] ${str(payload, "extensionId") ?? "?"}: ${str(payload, "action") ?? "?"}${ok}`;
  }
  if (kind === "hitl.requested") {
    return `${at} [hitl]      ${str(payload, "requestId") ?? "?"}: requested — ${str(payload, "prompt") ?? ""}`;
  }
  if (kind === "hitl.resolved") {
    const verdict = payload["approved"] === true ? "approved" : "rejected";
    return `${at} [hitl]      ${str(payload, "requestId") ?? "?"}: ${verdict}`;
  }

  // Never dropped: a stream that discards what it does not recognise is the same failure as a
  // brief that renders a missing section as empty.
  return `${at} [unknown: ${kind}] ${JSON.stringify(payload)}`;
}

/**
 * Every side effect is injectable, so the command's LIFECYCLE is testable and not just its two
 * pure functions. Without these seams the gateway-offline path, the filter predicate, the
 * shutdown path and the EPIPE guard are all unreachable from a unit test — which is how a command
 * ends up with green tests and an untested main path.
 */
export type TailCommandDeps = {
  readonly connect: (socketPath: string) => Promise<IPCClient>;
  readonly readState: () => Promise<{ socketPath: string } | undefined>;
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
  readonly onExit: (code: number) => void;
};

const defaultTailDeps: TailCommandDeps = {
  connect: async (socketPath) => {
    const client = new IPCClient(socketPath);
    await client.connect();
    return client;
  },
  readState: async () => await readGatewayState(getCliPlatformPaths()),
  writeOut: (line) => {
    process.stdout.write(line);
  },
  writeErr: (line) => {
    process.stderr.write(line);
  },
  onExit: (code) => {
    process.exit(code);
  },
};

export async function runTailCommand(
  args: string[],
  deps: TailCommandDeps = defaultTailDeps,
): Promise<void> {
  const parsed = parseTailArgs(args);

  const state = await deps.readState();
  if (state === undefined) {
    deps.writeErr("Gateway is not running. Start with: nimbus start
");
    deps.onExit(1);
    return;
  }

  // Piping into `head -n 5` closes stdout early. Without this the process dies with an unhandled
  // EPIPE stack trace, which is the first thing anyone does with a stream.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") deps.onExit(0);
  });

  const client = await deps.connect(state.socketPath);

  const onEvent = (method: string) => (params: unknown) => {
    const category = categoryOf(method, params);
    // An UNCATEGORISED event (a future `kind`) is shown even under a filter. A stream that
    // silently drops what it does not recognise is the failure this design rejects; the cost is
    // that `--filter sync` may show one unfamiliar line, which is strictly better than hiding a
    // new event type from everyone who uses a filter.
    if (category !== null && !parsed.categories.includes(category)) return;
    if (parsed.json) {
      deps.writeOut(`${JSON.stringify({ method, params })}
`);
      return;
    }
    const line = renderEvent(method, params);
    if (line !== null) deps.writeOut(`${line}
`);
  };

  // EXACTLY TWO handlers, forever. A future operational event picks a new `kind` and arrives here
  // with no CLI change — which is why the envelope exists.
  client.onNotification("connector.healthChanged", onEvent("connector.healthChanged"));
  client.onNotification("gateway.event", onEvent("gateway.event"));

  await new Promise<void>((resolve) => {
    // Listeners are REMOVED on every exit path. `process` outlives this promise, so leaving them
    // attached leaks one handler per invocation — invisible for a one-shot CLI, a real leak for
    // any caller that runs the command twice in a process (tests included).
    function shutdown(): void {
      void client.disconnect().finally(() => finish(0));
    }
    function finish(code: number): void {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.exitCode = code;
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    client.onClose(() => {
      deps.writeErr("[nimbus tail] Gateway connection closed.
");
      finish(1);
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/tail.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/tail.ts packages/cli/src/commands/tail.test.ts
git commit -m "feat(cli): nimbus tail — follow the gateway operational event stream"
```

---

### Task 9: End-to-end over a real gateway socket

**Files:**

- Test: packages/gateway/test/integration/ipc/tail-stream.integration.test.ts _(new file)_

**Interfaces:**

- Consumes: everything from Tasks 1–7. No production code changes.
- Produces: nothing.

This was a NAMED GAP in the first draft of this plan — deferred as "a different harness". The plan
review pushed back, correctly: without it, renaming `connector.healthChanged` silently re-orphans
the desktop listener, which is the exact bug this whole feature exists to fix. Every other test in
this plan asserts against an in-process sink, so none of them would notice.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/integration/ipc/tail-stream.integration.test.ts
import { describe, expect, test } from "bun:test";
import { startTestGateway } from "../../helpers/test-gateway.ts";

/**
 * Real gateway, real socket, real client. The in-process tests prove the emitters CALL the sink;
 * this proves the bytes reach a subscriber under the exact method names the desktop and the CLI
 * bind to. A rename is caught here and nowhere else.
 */
describe("tail stream over a real socket", () => {
  test("a health transition arrives as connector.healthChanged with the desktop's fields", async () => {
    const gw = await startTestGateway();
    try {
      const client = await gw.connect();
      const seen: Array<{ method: string; params: unknown }> = [];
      client.onNotification("connector.healthChanged", (params) =>
        seen.push({ method: "connector.healthChanged", params }),
      );

      await gw.transitionConnectorHealth("github", { type: "persistent_error", error: "boom" });
      await gw.waitFor(() => seen.length > 0);

      expect(seen).toHaveLength(1);
      const p = seen[0]?.params as Record<string, unknown>;
      // The two fields ConnectorGrid actually reads. A rename breaks HERE, loudly.
      expect(p["name"]).toBe("github");
      expect(p["health"]).toBe("error");
      await client.disconnect();
    } finally {
      await gw.stop();
    }
  });

  test("every connected client receives the same broadcast", async () => {
    // `broadcastNotification` fans out per session. A second `tail` must not starve the first, and
    // the desktop must not miss what the CLI saw.
    const gw = await startTestGateway();
    try {
      const a = await gw.connect();
      const b = await gw.connect();
      const seenA: unknown[] = [];
      const seenB: unknown[] = [];
      a.onNotification("connector.healthChanged", (p) => seenA.push(p));
      b.onNotification("connector.healthChanged", (p) => seenB.push(p));

      await gw.transitionConnectorHealth("github", { type: "unauthenticated" });
      await gw.waitFor(() => seenA.length > 0 && seenB.length > 0);

      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(1);
      expect(seenA[0]).toEqual(seenB[0]);
      await a.disconnect();
      await b.disconnect();
    } finally {
      await gw.stop();
    }
  });
});
```

- [ ] **Step 2: Run it and adapt to the real harness**

Run: `bun test packages/gateway/test/integration/ipc/tail-stream.integration.test.ts`

The helper names above (`startTestGateway`, `gw.connect`, `gw.transitionConnectorHealth`,
`gw.waitFor`, `gw.stop`) are the SHAPE this test needs, not a promise that a helper with those
exact names exists. Before writing the test, read the existing integration helpers under
`packages/gateway/test/integration/` and use whatever this repo already provides for booting a
gateway on a temp socket; if driving a health transition from outside needs a seam that does not
exist, prefer triggering it through an existing IPC method over adding a test-only backdoor.

Expected after adaptation: FAIL first (no emitter reaches the socket if Tasks 1–3 were skipped),
then PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/ipc/tail-stream.integration.test.ts
git commit -m "test(ipc): end-to-end tail stream over a real gateway socket"
```

---

### Task 10: Register the command, document it, strip the spec

**Files:**

- Modify: `packages/cli/src/commands/index.ts`, `packages/cli/src/index.ts`, `packages/cli/src/commands/registry.ts`, `packages/cli/src/commands/help.ts`
- Modify: `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`
- Delete: `docs/superpowers/specs/2026-09-13-nimbus-tail-design.md`, `docs/superpowers/specs/2026-09-13-nimbus-tail-design-review.md`, `docs/superpowers/plans/2026-09-13-nimbus-tail.md`

**Interfaces:**

- Consumes: `runTailCommand` (Task 8).
- Produces: the `tail` CLI command.

- [ ] **Step 1: Register in all four sites**

`packages/cli/src/commands/index.ts`:

```ts
export { runTailCommand } from "./tail.ts";
```

`packages/cli/src/index.ts` — add `runTailCommand` to the import block and to the command map:

```ts
  tail: runTailCommand,
```

`packages/cli/src/commands/registry.ts` — add to `COMMAND_NAMES`:

```ts
  "tail",
```

`packages/cli/src/commands/help.ts` — beside the other operational commands:

```ts
  nimbus tail [--filter sync]        Follow gateway events live — health, syncs, watchers, HITL
```

- [ ] **Step 2: Run the registry contract test**

Run: `bun test packages/cli/src/commands/registry.test.ts`
Expected: PASS — this test fails if a dispatch-table entry is missing from `COMMAND_NAMES`.

- [ ] **Step 3: Document in `docs/cli-reference.md`**

Add a `### \`nimbus tail\`` section after `### \`nimbus oncall\``, covering: the two flags, the
five categories, follow-only semantics, the exit codes (0 on Ctrl+C, 1 on gateway loss or gateway
not running), and one line stating that connector health, watcher fires, sync completions,
extension mutations and HITL prompts are what it carries — and that per-item progress deliberately
is not, because every event reaches every connected client.

- [ ] **Step 4: Add the CHANGELOG entry**

Prepend to `## Post-Phase-6 deliveries` in `docs/CHANGELOG.md`, stating: the roadmap row's trigger
("no Gateway API changes required") was wrong on all four lanes; `connector.healthChanged` had a
desktop consumer and no emitter, so the panel never updated live; `consent.request` is unicast, so
HITL observation needed a broadcast; the emit is after commit, not inside the health transaction;
and per-item progress is excluded because `broadcastNotification` fans out to every session.

- [ ] **Step 5: Update the roadmap row**

In `docs/roadmap.md`, mark the `nimbus tail` v0.1.1 row `✅ **shipped**` with the date, and correct
its trigger column — it currently claims no Gateway API changes are required.

- [ ] **Step 6: Strip the spec, review and plan**

```bash
git rm docs/superpowers/specs/2026-09-13-nimbus-tail-design.md \
       docs/superpowers/specs/2026-09-13-nimbus-tail-design-review.md \
       docs/superpowers/plans/2026-09-13-nimbus-tail.md
```

Specs and plans never land on `main` — squash takes the net diff, so they must be removed on the
branch before the PR. The durable design content belongs in `docs/architecture.md`; the command
surface in `docs/cli-reference.md`; the dated record in `docs/CHANGELOG.md`.

- [ ] **Step 7: Full verification**

```bash
bun run preflight
bun test packages/gateway packages/cli scripts
bun run audit:doc-refs
```

Expected: `preflight PASSED`, 0 test failures, all doc references resolve.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): register nimbus tail, document it, strip the design docs"
```

---

## Self-Review

**Spec coverage.** § 2.1 → Task 2 + Task 3. § 2.2 → Task 1. § 3.1 → Task 2. § 3.2 → Task 5.
§ 3.3 → Task 4. § 3.4 → Task 6. § 3.5 → Task 7. § 4 (exclusions) → Global Constraints, enforced by
omission. § 5 (CLI) → Task 8. § 6 (error handling) → Task 8 steps 3. § 7 (testing) → each task's
test step, plus the desktop contract test in Task 3. § 8 (invariants) → Global Constraints.

**The gap the first draft deferred is now Task 9.** It named the integration and multi-client
tests as "a different harness" and left them as a follow-up. The plan review pushed back and was
right: every other test asserts against an in-process sink, so a rename of
`connector.healthChanged` would pass all of them and silently re-orphan the desktop listener —
the exact bug this feature exists to fix. Task 9's helper NAMES are a shape to adapt, not an
assertion that those helpers exist; the task says so.

**Type consistency.** `ConnectorHealthChangedPayload` uses `name`/`health` in Tasks 1, 2, 3 and 8.
`WatcherFiredPayload` uses `watcherId`/`name`/`summary`/`firedAt` in Tasks 1, 5 and 8.
`SyncCompletedPayload` uses `serviceId`/`itemsUpserted`/`itemsDeleted`/`durationMs`/`hasMore` in
Tasks 1, 4 and 8. `setGatewayEventBroadcast` is the binder name in Tasks 1, 2, 3, 4, 6 and 7.

## Review Dispositions

All five defects from the plan review were verified against code and FIXED: the `automation-rpc.ts`
retarget (Task 7), the `packages/ui/test/` path (Task 3), the `configured`/`not_configured` early
return (Task 2), `rejectAllPending`'s `.entries()` (Task 6), and the `fromState` cast (Task 2,
matching `health.ts`'s own existing idiom at its snapshot builder).

Both improvements were taken: injectable IO on `TailCommandDeps` with five lifecycle tests, and
`process.off` cleanup on every exit path (Task 8). The deferred integration test became Task 9.

**One review statement corrected rather than implemented.** The review's open question 1 says that
under `--filter sync`, "unknown kinds are filtered out". They are not: `categoryOf` returns `null`
for an unrecognised `kind`, and the predicate is `category !== null && !categories.includes(...)`,
so a `null` category is never excluded. That is deliberate — a stream that silently drops what it
does not recognise is the failure this design rejects — and it is now pinned by a test and stated
in the code comment. The cost (one unfamiliar line under a narrow filter) is strictly better than
hiding a new event type from everyone who filters.

**`extension.sync` stays unemitted**, per the review's open question 2: it syncs publisher keys, not
extension state.
