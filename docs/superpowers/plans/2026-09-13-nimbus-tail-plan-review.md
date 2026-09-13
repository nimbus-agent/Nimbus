# Plan Review: `nimbus tail` Implementation Plan

**Reviewed Plan:** [`2026-09-13-nimbus-tail.md`](./2026-09-13-nimbus-tail.md)  
**Review Date:** 2026-09-13  
**Status:** Review complete — 5 task-level defects/gaps identified, 4 architectural improvements, 3 open questions for alignment.

---

## 1. Executive Summary

The implementation plan is exceptionally well-structured and follows strict test-driven development (TDD) discipline. It successfully integrates the critical findings from the design review:
- Resolves the desktop UI schema mismatch by adopting the desktop's `name` / `health` vocabulary.
- Solves the unicast `consent.request` limitation by introducing observational `hitl.requested` / `hitl.resolved` broadcast events without mutating consent authorization.
- Moves the `connector.healthChanged` emission outside the SQLite transaction in `transitionHealth`.
- Limits `@nimbus-dev/client` interaction to strictly two notification handlers via the `gateway.event` envelope.

However, a line-by-line code audit of the plan against the Nimbus codebase revealed **5 task-level discrepancies** that would cause test or build failures during execution, along with several testing and lifecycle improvements.

---

## 2. Task-Level Defects & Code Discrepancies (Must Fix in Plan)

### Defect 1: Task 7 Targets the Wrong File (`dispatchers.ts` vs `automation-rpc.ts`)

**Plan Section:** Task 7, Step 3 (lines 906, 971–996)  
**The Issue:**  
The plan instructs:
> *"In `packages/gateway/src/ipc/server/dispatchers.ts`, for each of the five methods, after the mutation returns successfully, emit; and in the catch/failure path emit with `ok: false`. Example for `extension.enable`..."*

In reality, [`packages/gateway/src/ipc/server/dispatchers.ts:1676-1714`](../../../packages/gateway/src/ipc/server/dispatchers.ts) does not contain individual handlers like `handleExtensionEnable` or `extension.enable` dispatch tables. It simply delegates the entire `extension.*` namespace to `dispatchAutomationRpc` in [`packages/gateway/src/ipc/automation-rpc.ts`](../../../packages/gateway/src/ipc/automation-rpc.ts).

The actual mutation handlers are registered in `packages/gateway/src/ipc/automation-rpc.ts`:
- `"extension.install"`: line 212 (`handleExtensionInstall`)
- `"extension.update"`: line 219 (`handleAutoUpdateRpc`)
- `"extension.enable"`: line 221
- `"extension.disable"`: line 226
- `"extension.remove"`: line 235

**Required Correction:**  
Update Task 7 to target `packages/gateway/src/ipc/automation-rpc.ts` instead of `packages/gateway/src/ipc/server/dispatchers.ts`.

---

### Defect 2: Task 3 Test File Path Breaks UI Directory Convention

**Plan Section:** Task 3, Step 1 & Step 3 (lines 422, 432, 499, 530)  
**The Issue:**  
Task 3 specifies the new test file at:  
packages/ui/src/components/dashboard/ConnectorGrid.health-contract.test.tsx *(new file)*

Throughout `packages/ui`, **all test files live under `packages/ui/test/...`**, not `packages/ui/src/...` (e.g. `packages/ui/test/components/dashboard/ConnectorGrid.test.tsx`). Placing test files inside `src/` risks inclusion in Vite production build bundles and violates the project layout standard.

**Required Correction:**  
Move the test file to:  
packages/ui/test/components/dashboard/ConnectorGrid.health-contract.test.tsx *(new file)*  
and update the relative import to `import type { ConnectorStatus } from "../../src/ipc/types";`.

---

### Defect 3: Task 2 Misses Early-Return Branches in `transitionHealth` (`configured` / `not_configured`)

**Plan Section:** Task 2, Step 3 (lines 363–394)  
**The Issue:**  
In [`packages/gateway/src/connectors/health.ts:241-244`](../../../packages/gateway/src/connectors/health.ts):
```ts
if (event.type === "not_configured" || event.type === "configured") {
  applyConfiguredFlag(db, connectorId, current, fromState, event.type === "configured", now);
  return buildSnapshot(connectorId, readHealthRow(db, connectorId));
}
```
When a connector is authenticated or unauthenticated via `nimbus connector auth`, `transitionHealth` returns early on line 243. Because Task 2 places `emitConnectorHealthChanged` at line 383 (after the main `db.transaction`), **no notification is emitted when a connector transitions between `configured` and `not_configured`**.

**Required Correction:**  
Ensure `applyConfiguredFlag` (or the early-return branch in `transitionHealth`) also calls `emitConnectorHealthChanged` when a configuration state change occurs:
```ts
if (event.type === "not_configured" || event.type === "configured") {
  const isConfigured = event.type === "configured";
  applyConfiguredFlag(db, connectorId, current, fromState, isConfigured, now);
  if (current !== null && (current.configured !== 0) !== isConfigured) {
    emitConnectorHealthChanged({
      name: connectorId,
      health: isConfigured ? (fromState as ConnectorHealthState ?? "healthy") : "not_configured",
      fromState: fromState as ConnectorHealthState | null,
      reason: isConfigured ? "credential configured" : "no credential configured",
      occurredAt: now,
    });
  }
  return buildSnapshot(connectorId, readHealthRow(db, connectorId));
}
```

---

### Defect 4: Task 6 Missing Map Key in `rejectAllPending`

**Plan Section:** Task 6, Step 3 (lines 878–886)  
**The Issue:**  
In `packages/gateway/src/ipc/consent.ts:89-96`:
```ts
rejectAllPending(message: string, hitlAuditReason: string): void {
  const err = new ConsentDisconnectedError(message, hitlAuditReason);
  const snapshot = new Map(this.pending);
  this.pending.clear();
  for (const entry of snapshot.values()) {
    entry.reject(err);
  }
}
```
The existing loop iterates over `snapshot.values()`, which yields only `entry` without the `requestId` key. To emit `hitl.resolved` with the `requestId`, the loop must iterate over entries (`for (const [requestId, entry] of snapshot.entries())`).

**Required Correction:**  
Update Task 6 Step 3 code snippet:
```ts
  rejectAllPending(message: string, hitlAuditReason: string): void {
    const err = new ConsentDisconnectedError(message, hitlAuditReason);
    const snapshot = new Map(this.pending);
    this.pending.clear();
    for (const [requestId, entry] of snapshot.entries()) {
      entry.reject(err);
      emitGatewayEvent("hitl.resolved", {
        requestId,
        approved: false,
        reason: message,
      });
    }
  }
```

---

### Defect 5: Type Cast for `fromState` in `transitionHealth`

**Plan Section:** Task 2, Step 3 (lines 387–390)  
**The Issue:**  
In `packages/gateway/src/connectors/health.ts:234`, `fromState` is derived as:
`const fromState = current?.health_state ?? null;`
Since `SyncStateHealthRow.health_state` is typed as `string`, `fromState` has type `string | null`.  
In `ConnectorHealthChangedPayload`, `fromState` is typed strictly as `ConnectorHealthState | null`.  
Under TypeScript strict mode, passing `fromState` directly causes a compiler error:
`Type 'string | null' is not assignable to type 'ConnectorHealthState | null'`.

**Required Correction:**  
In `transitionHealth`, type-assert `fromState`:
`const fromState = (current?.health_state as ConnectorHealthState | undefined) ?? null;`

---

## 3. Improvements & Enhancements

### 3.1 CLI Dependency Injection for Full Lifecycle Testing (Task 8)

In Task 8, `runTailCommand` directly invokes `process.exit(1)`, `readGatewayState(getCliPlatformPaths())`, and `process.stdout.write`. As a result, unit tests only cover `parseTailArgs` and `renderEvent`, leaving the actual command execution, gateway-offline handling, and stream piping unverified.

**Suggestion:**  
Expand `TailCommandDeps` to support injectable IO (following the pattern in `packages/cli/src/lib/run-gateway-cli-command.ts`):
```ts
export type TailCommandDeps = {
  readonly connect: (socketPath: string) => Promise<IPCClient>;
  readonly readState?: () => Promise<{ socketPath: string } | undefined>;
  readonly writeOut?: (line: string) => void;
  readonly writeErr?: (line: string) => void;
  readonly onExit?: (code: number) => void;
};
```
This enables writing fast unit tests for:
- Gateway offline (`readState` returns `undefined` -> writes error and exits `1`).
- Successful stream subscription and message filtering.
- Signal interruption and graceful shutdown.

### 3.2 Signal Listener Cleanup on CLI Exit (Task 8)

In `runTailCommand`, `SIGINT` and `SIGTERM` listeners are attached to `process`. If the promise resolves due to `onClose` or programmatic disconnection, the signal listeners remain attached to `process`.

**Suggestion:**  
Ensure listeners are removed when the stream closes:
```ts
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void client.disconnect().finally(() => cleanupAndResolve(0));
    };
    const onClose = (): void => {
      deps.writeErr?.("[nimbus tail] Gateway connection closed.\n");
      cleanupAndResolve(1);
    };
    function cleanupAndResolve(code: number): void {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.exitCode = code;
      resolve();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    client.onClose(onClose);
  });
```

### 3.3 Integration Test Coverage (Self-Review Follow-up)

The plan's Self-Review notes that an end-to-end integration test over a real subprocess gateway was deferred.  
To protect against method-name drift, we should add an integration test in packages/gateway/test/integration/ipc/tail-stream.integration.test.ts *(new file)* that:

1. Boots a real temporary gateway instance.
2. Connects a real `IPCClient`.
3. Triggers a sync or health transition.
4. Asserts both `connector.healthChanged` and `gateway.event` are received on the socket.

---

## 4. Open Questions & Alignment Points

1. **Category Filter on Unknown Future Kinds:**  
   In Task 8 (`categoryOf`, lines 1209–1210), unknown future kinds return `null`, which causes them to be displayed only when NO `--filter` is specified. If a user runs `nimbus tail --filter sync`, unknown kinds are filtered out. Is this the intended behavior? (Yes, this matches standard CLI filter semantics).
2. **`extension.stateChanged` for `extension.sync`:**  
   `automation-rpc.ts` also contains `extension.sync` (syncing publisher keys). Should key syncs emit `extension.stateChanged`, or is that considered internal telemetry rather than extension state? (Excluding it as internal seems correct).
3. **Documentation Retention:**  
   Task 9 Step 6 specifies deleting the design spec, review, and plan before merging to `main`. To maintain context during review, ensure this deletion is the final commit on the branch prior to merge.

---

## 5. Summary of Recommended Plan Edits

| Task | File | Change |
|---|---|---|
| **Task 2** | `packages/gateway/src/connectors/health.ts` | Emit on `configured`/`not_configured` in `applyConfiguredFlag`; type-assert `fromState`. |
| **Task 3** | `packages/ui/test/components/dashboard/` | Move test file from `src/` to `test/`. |
| **Task 6** | `packages/gateway/src/ipc/consent.ts` | Iterate `snapshot.entries()` in `rejectAllPending`. |
| **Task 7** | `packages/gateway/src/ipc/automation-rpc.ts` | Change target file from `dispatchers.ts` to `automation-rpc.ts`. |
| **Task 8** | packages/cli/src/commands/tail.ts *(new file)* | Add IO seams to `TailCommandDeps`; clean up `process.off` signal listeners. |
