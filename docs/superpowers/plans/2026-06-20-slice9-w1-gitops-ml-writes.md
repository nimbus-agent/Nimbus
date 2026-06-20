# Phase 6 Slice 9 — W1: GitOps + ML HITL Writes (ArgoCD / Flux / MLflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six HITL-gated write actions (ArgoCD sync/rollback, Flux kustomization/helmrelease reconcile, MLflow promote/transition-stage) that execute only behind the local owner's I2 consent gate, with a personal+team credential path, by generalizing the Wave 7c warehouse-write machinery to all connector writes.

**Architecture:** Reuse the already-generic Wave 7c write transport + dispatcher + the existing `answerLocalOperatorInvoke` team rail. Add a per-group SSoT module (`gitops-ml-write-tools.ts`) and a union registry (`connector-write-registry.ts`); add the six action types to the frozen `HITL_REQUIRED_BACKING`; generalize invariant **I26** ("warehouse/BI write tool ids" → "connector write tool ids") so the federated peer invoke gate fail-closed rejects them. Three inline-only connectors are refactored to an exported registrar first, then gain their write tools.

**Tech Stack:** Bun 1.2+ / TypeScript 6.x strict · Biome · Zod tool schemas · `bun:test` · `bun:sqlite`.

**Design spec:** [`docs/superpowers/specs/2026-06-20-slice9-w1-gitops-ml-writes-design.md`](../specs/2026-06-20-slice9-w1-gitops-ml-writes-design.md)

## Global Constraints

- **No `any`** — external payloads typed `unknown`; strict mode; Zod-validate all write args.
- **HITL is structural** — the six action types live in `HITL_REQUIRED_BACKING` (module-private) in `packages/gateway/src/engine/executor.ts`; never read `payload.mcpToolId` to gate (I3).
- **No new invariant number** — I26 is *generalized in place* (statement + examples reworded); do not add I28/I29/I30 (they're claimed by in-flight branches).
- **No new SQLite migration** — schema stays V43. No new item types. No new `CONNECTOR_VAULT_SECRET_KEYS`.
- **No plaintext credentials** — tokens read from `process.env` inside the connector subprocess only; never logged/returned. Team sourcing stays inside the I19 gate.
- **Connector write tools are thin API callers** — there is **no** `assertHitlRequired()` helper; HITL is declared in `nimbus.extension.json` `hitlRequired: ["write"]` and enforced gateway-side (I2). The tool *description* names its HITL action type.
- **Reference-API pinned** — the exact request shapes are fixed in this plan (below); do not invent.
- **Service-prefixed action types**, 1:1 with tool ids — `argocd.app.sync` ↔ `argocd_app_sync`, etc.
- **Excluded/deferred:** SageMaker + Vertex AI writes (CLI-credential connectors); all destructive `delete`/drop writes.
- **TDD + frequent commits** — red → green → refactor; commit per task. Coverage floor ≥80% line+branch on every new file (`audit:coverage-floor` is CI-Linux-authoritative).
- **Branch:** `worktree-phase6-slice9-wrapup` (verify `git rev-parse --abbrev-ref HEAD` before committing; never commit on `main`).

---

## File Structure

**New gateway files:**
- `packages/gateway/src/connectors/connector-write.ts` — shared `ConnectorWrite` type + `w()` builder (hoisted from `warehouse-write-tools.ts`).
- `packages/gateway/src/connectors/gitops-ml-write-tools.ts` — the six-row SSoT + predicate + by-action-type lookup.
- `packages/gateway/src/connectors/connector-write-registry.ts` — union predicate (`isConnectorWriteToolId`) + union lookup (`connectorWriteByActionType`).

**Renamed gateway files (behavior-preserving):**
- `warehouse-write-transport.ts` → `connector-write-transport.ts` (`WarehouseWriteContext` → `ConnectorWriteContext`).
- `warehouse-write-dispatch.ts` → `connector-write-dispatch.ts` (`createWarehouseWriteDispatcher` → `createConnectorWriteDispatcher`, routes via the union lookup).

**Modified gateway files:**
- `connectors/warehouse-write-tools.ts` — import the hoisted type/builder.
- `engine/executor.ts` — six action types into `HITL_REQUIRED_BACKING`.
- `ipc/federation-rpc.ts` — swap `isWriteForbiddenToolId: isWarehouseWriteToolId` → `isConnectorWriteToolId`.
- `connectors/connector-secrets-manifest.ts` — enroll argocd/flux/mlflow in `TEAM_SECRET_ANYOF_GROUPS`.
- `platform/assemble.ts` — call site rename `createWarehouseWriteDispatcher` → `createConnectorWriteDispatcher`.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D20 generalized (regex + allowlist + names).
- `docs/SECURITY-INVARIANTS.md` — I26 reworded.

**Connector files (per connector, ArgoCD/Flux/MLflow):**
- `packages/mcp-connectors/<svc>/src/server.ts` — extract exported `register<Svc>Tools` + guard, then add two write tools.
- `packages/mcp-connectors/<svc>/nimbus.extension.json` — `hitlRequired: ["write"]` + description update.
- `packages/mcp-connectors/<svc>/test/server-writes.test.ts` — `captureTools()` unit tests.

**Docs:** `docs/CHANGELOG.md` (W1 entry), `docs/roadmap.md` (rows), `docs/SECURITY-INVARIANTS.md`.

---

## Task 1: Hoist the `ConnectorWrite` type + `w()` builder

**Files:**
- Create: `packages/gateway/src/connectors/connector-write.ts`
- Create: `packages/gateway/src/connectors/connector-write.test.ts`
- Modify: `packages/gateway/src/connectors/warehouse-write-tools.ts` (import the hoisted symbols)

**Interfaces:**
- Produces: `interface ConnectorWrite { readonly actionType: string; readonly toolId: string; readonly service: string }` and `function w(actionType: string, toolId: string, service: string): ConnectorWrite`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/connector-write.test.ts
import { describe, expect, test } from "bun:test";
import { type ConnectorWrite, w } from "./connector-write.ts";

describe("connector-write — shared write descriptor", () => {
  test("w() builds a 1:1 {actionType, toolId, service} row", () => {
    const row: ConnectorWrite = w("argocd.app.sync", "argocd_app_sync", "argocd");
    expect(row).toEqual({ actionType: "argocd.app.sync", toolId: "argocd_app_sync", service: "argocd" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-write.test.ts`
Expected: FAIL — cannot find module `./connector-write.ts`.

- [ ] **Step 3: Create the module**

```ts
// packages/gateway/src/connectors/connector-write.ts

/** One connector write action: its HITL action.type, its MCP tool id, and its service id.
 *  Shared single-row descriptor consumed by every connector-write SSoT module (warehouse, gitops-ml). */
export interface ConnectorWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

/** Compact single-line builder so each SSoT entry is one row, not a cloned multi-line literal. */
export const w = (actionType: string, toolId: string, service: string): ConnectorWrite => ({
  actionType,
  toolId,
  service,
});
```

- [ ] **Step 4: Refactor `warehouse-write-tools.ts` to import the hoisted symbols**

In `packages/gateway/src/connectors/warehouse-write-tools.ts`: delete the local `WarehouseWrite` interface and local `w` const; replace with `import { type ConnectorWrite, w } from "./connector-write.ts";`. Change `export const WAREHOUSE_BI_WRITES: readonly WarehouseWrite[]` to `readonly ConnectorWrite[]`. Update the two helper signatures that referenced `WarehouseWrite` to `ConnectorWrite`. Keep `WAREHOUSE_BI_WRITES`, `WAREHOUSE_BI_WRITE_TOOL_IDS`, `isWarehouseWriteToolId`, `warehouseWriteByActionType` names unchanged.

- [ ] **Step 5: Run tests to verify green (incl. the existing warehouse test)**

Run: `bun test packages/gateway/src/connectors/connector-write.test.ts packages/gateway/src/connectors/warehouse-write-tools.test.ts`
Expected: PASS (both files).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/connector-write.ts packages/gateway/src/connectors/connector-write.test.ts packages/gateway/src/connectors/warehouse-write-tools.ts
git commit -m "refactor(connectors): hoist ConnectorWrite descriptor + w() builder for reuse"
```

---

## Task 2: GitOps/ML write SSoT (`gitops-ml-write-tools.ts`)

**Files:**
- Create: `packages/gateway/src/connectors/gitops-ml-write-tools.ts`
- Create: `packages/gateway/src/connectors/gitops-ml-write-tools.test.ts`

**Interfaces:**
- Consumes: `ConnectorWrite`, `w` (Task 1).
- Produces: `GITOPS_ML_WRITES: readonly ConnectorWrite[]`, `GITOPS_ML_WRITE_TOOL_IDS: ReadonlySet<string>`, `isGitopsMlWriteToolId(id: string): boolean`, `gitopsMlWriteByActionType(type: string): ConnectorWrite | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/gitops-ml-write-tools.test.ts
import { describe, expect, test } from "bun:test";
import {
  GITOPS_ML_WRITE_TOOL_IDS,
  GITOPS_ML_WRITES,
  gitopsMlWriteByActionType,
  isGitopsMlWriteToolId,
} from "./gitops-ml-write-tools.ts";

describe("gitops-ml-write-tools — single source of truth", () => {
  test("exposes exactly six write actions across argocd/flux/mlflow", () => {
    expect(GITOPS_ML_WRITES).toHaveLength(6);
    expect([...new Set(GITOPS_ML_WRITES.map((x) => x.service))].sort()).toEqual([
      "argocd",
      "flux",
      "mlflow",
    ]);
  });

  test("action types and tool ids are unique and service-prefixed", () => {
    const types = GITOPS_ML_WRITES.map((x) => x.actionType);
    const ids = GITOPS_ML_WRITES.map((x) => x.toolId);
    expect(new Set(types).size).toBe(6);
    expect(new Set(ids).size).toBe(6);
    for (const x of GITOPS_ML_WRITES) {
      expect(x.actionType.startsWith(`${x.service}.`)).toBe(true);
      expect(x.toolId.startsWith(`${x.service}_`)).toBe(true);
    }
  });

  test("predicate + set agree; lookup resolves and rejects", () => {
    expect(GITOPS_ML_WRITE_TOOL_IDS.size).toBe(6);
    expect(isGitopsMlWriteToolId("argocd_app_sync")).toBe(true);
    expect(isGitopsMlWriteToolId("argocd_get")).toBe(false);
    expect(gitopsMlWriteByActionType("mlflow.model.promote")?.toolId).toBe("mlflow_model_promote");
    expect(gitopsMlWriteByActionType("snowflake.tag.set")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/gitops-ml-write-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```ts
// packages/gateway/src/connectors/gitops-ml-write-tools.ts
import { type ConnectorWrite, w } from "./connector-write.ts";

/** Phase 6 Slice 9 W1 — GitOps + ML write actions (kept in sync with HITL_REQUIRED_BACKING in
 *  engine/executor.ts; the connector-write-registry drift test ties the two lists together). */
export const GITOPS_ML_WRITES: readonly ConnectorWrite[] = [
  w("argocd.app.sync", "argocd_app_sync", "argocd"),
  w("argocd.app.rollback", "argocd_app_rollback", "argocd"),
  w("flux.kustomization.reconcile", "flux_kustomization_reconcile", "flux"),
  w("flux.helmrelease.reconcile", "flux_helmrelease_reconcile", "flux"),
  w("mlflow.model.promote", "mlflow_model_promote", "mlflow"),
  w("mlflow.model.transition_stage", "mlflow_model_transition_stage", "mlflow"),
];

export const GITOPS_ML_WRITE_TOOL_IDS: ReadonlySet<string> = new Set(
  GITOPS_ML_WRITES.map((x) => x.toolId),
);

const BY_ACTION_TYPE: ReadonlyMap<string, ConnectorWrite> = new Map(
  GITOPS_ML_WRITES.map((x) => [x.actionType, x]),
);

export function isGitopsMlWriteToolId(toolId: string): boolean {
  return GITOPS_ML_WRITE_TOOL_IDS.has(toolId);
}

export function gitopsMlWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return BY_ACTION_TYPE.get(actionType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/gitops-ml-write-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/gitops-ml-write-tools.ts packages/gateway/src/connectors/gitops-ml-write-tools.test.ts
git commit -m "feat(connectors): GitOps/ML write SSoT (6 actions: argocd/flux/mlflow)"
```

---

## Task 3: Union registry (`connector-write-registry.ts`)

**Files:**
- Create: `packages/gateway/src/connectors/connector-write-registry.ts`
- Create: `packages/gateway/src/connectors/connector-write-registry.test.ts`

**Interfaces:**
- Consumes: `WAREHOUSE_BI_WRITES`/`isWarehouseWriteToolId`/`warehouseWriteByActionType`; `GITOPS_ML_WRITES`/`isGitopsMlWriteToolId`/`gitopsMlWriteByActionType`; `ConnectorWrite`.
- Produces: `CONNECTOR_WRITES: readonly ConnectorWrite[]` (union), `isConnectorWriteToolId(id: string): boolean`, `connectorWriteByActionType(type: string): ConnectorWrite | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/connector-write-registry.test.ts
import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_WRITES,
  connectorWriteByActionType,
  isConnectorWriteToolId,
} from "./connector-write-registry.ts";
import { GITOPS_ML_WRITES } from "./gitops-ml-write-tools.ts";
import { WAREHOUSE_BI_WRITES } from "./warehouse-write-tools.ts";

describe("connector-write-registry — union of all connector writes", () => {
  test("union is exactly warehouse ∪ gitops-ml with no collision", () => {
    expect(CONNECTOR_WRITES).toHaveLength(WAREHOUSE_BI_WRITES.length + GITOPS_ML_WRITES.length);
    expect(new Set(CONNECTOR_WRITES.map((x) => x.toolId)).size).toBe(CONNECTOR_WRITES.length);
    expect(new Set(CONNECTOR_WRITES.map((x) => x.actionType)).size).toBe(CONNECTOR_WRITES.length);
  });

  test("predicate spans both groups", () => {
    expect(isConnectorWriteToolId("snowflake_tag_set")).toBe(true);
    expect(isConnectorWriteToolId("argocd_app_sync")).toBe(true);
    expect(isConnectorWriteToolId("argocd_get")).toBe(false);
  });

  test("lookup spans both groups", () => {
    expect(connectorWriteByActionType("tableau.workbook.refresh")?.toolId).toBe(
      "tableau_workbook_refresh",
    );
    expect(connectorWriteByActionType("flux.helmrelease.reconcile")?.toolId).toBe(
      "flux_helmrelease_reconcile",
    );
    expect(connectorWriteByActionType("nope.nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-write-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```ts
// packages/gateway/src/connectors/connector-write-registry.ts
import type { ConnectorWrite } from "./connector-write.ts";
import {
  GITOPS_ML_WRITES,
  gitopsMlWriteByActionType,
  isGitopsMlWriteToolId,
} from "./gitops-ml-write-tools.ts";
import {
  isWarehouseWriteToolId,
  WAREHOUSE_BI_WRITES,
  warehouseWriteByActionType,
} from "./warehouse-write-tools.ts";

/** The union of every connector write action across all groups. Drives the generalized I26 predicate
 *  (federated peer fail-closed rejection) and the credential-aware dispatch routing. */
export const CONNECTOR_WRITES: readonly ConnectorWrite[] = [
  ...WAREHOUSE_BI_WRITES,
  ...GITOPS_ML_WRITES,
];

/** I26: true for any connector write tool id — the federated peer invoke gate rejects these
 *  fail-closed; they execute only behind the local owner's executor I2 HITL gate. */
export function isConnectorWriteToolId(toolId: string): boolean {
  return isWarehouseWriteToolId(toolId) || isGitopsMlWriteToolId(toolId);
}

export function connectorWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return warehouseWriteByActionType(actionType) ?? gitopsMlWriteByActionType(actionType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/connector-write-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-write-registry.ts packages/gateway/src/connectors/connector-write-registry.test.ts
git commit -m "feat(connectors): union connector-write registry (warehouse ∪ gitops-ml)"
```

---

## Task 4: Add the six action types to the HITL frozen set + the completeness drift test

**Files:**
- Modify: `packages/gateway/src/engine/executor.ts` (inside `HITL_REQUIRED_BACKING`)
- Modify: `packages/gateway/src/connectors/connector-write-registry.test.ts` (add the drift test)

**Interfaces:**
- Consumes: `HITL_REQUIRED` (exported from `engine/executor.ts`), `CONNECTOR_WRITES` (Task 3).

- [ ] **Step 1: Write the failing completeness drift test** (append to `connector-write-registry.test.ts`)

```ts
import { HITL_REQUIRED } from "../engine/executor.ts";

describe("connector writes are all HITL-gated (I26 ↔ I2 completeness)", () => {
  test("every connector-write action type is in HITL_REQUIRED", () => {
    for (const x of CONNECTOR_WRITES) {
      expect(HITL_REQUIRED.has(x.actionType)).toBe(true);
    }
  });

  test("every tool id flagged by isConnectorWriteToolId maps to a HITL action type", () => {
    for (const x of CONNECTOR_WRITES) {
      expect(isConnectorWriteToolId(x.toolId)).toBe(true);
      expect(HITL_REQUIRED.has(x.actionType)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-write-registry.test.ts`
Expected: FAIL — the six new GitOps/ML action types are not yet in `HITL_REQUIRED`.

- [ ] **Step 3: Add the six action types to `HITL_REQUIRED_BACKING`**

In `packages/gateway/src/engine/executor.ts`, immediately after the Wave 7c warehouse block (the lines beginning `"snowflake.tag.set",` … through `"bigeye.issue.resolve",`), add:

```ts
  // Phase 6 Slice 9 W1 — GitOps + ML writes (kept in sync with GITOPS_ML_WRITES; see
  // connectors/gitops-ml-write-tools.ts; drift asserted in connector-write-registry.test.ts).
  "argocd.app.sync",
  "argocd.app.rollback",
  "flux.kustomization.reconcile",
  "flux.helmrelease.reconcile",
  "mlflow.model.promote",
  "mlflow.model.transition_stage",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/connector-write-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing executor/HITL suites for no regression**

Run: `bun test packages/gateway/src/engine/executor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/engine/executor.ts packages/gateway/src/connectors/connector-write-registry.test.ts
git commit -m "feat(engine): HITL-gate the 6 GitOps/ML writes + I26↔I2 completeness drift test"
```

---

## Task 5: Rename the write transport to `connector-write-transport.ts`

**Files:**
- Rename: `packages/gateway/src/connectors/warehouse-write-transport.ts` → `connector-write-transport.ts`
- Rename: `packages/gateway/src/connectors/warehouse-write-transport.test.ts` → `connector-write-transport.test.ts`
- Modify: importers (`warehouse-write-dispatch.ts` — handled in Task 6; any others found by grep)

**Interfaces:**
- Produces (unchanged behavior, renamed type): `interface ConnectorWriteContext { ... }`, `invokeConnectorWrite(ctx, req)`, `__setPersonalInvokeForTest`.

- [ ] **Step 1: Git-rename both files**

```bash
git mv packages/gateway/src/connectors/warehouse-write-transport.ts packages/gateway/src/connectors/connector-write-transport.ts
git mv packages/gateway/src/connectors/warehouse-write-transport.test.ts packages/gateway/src/connectors/connector-write-transport.test.ts
```

- [ ] **Step 2: Rename the context type inside the module**

In `connector-write-transport.ts`: rename `export interface WarehouseWriteContext` → `export interface ConnectorWriteContext` and the two internal references (`PersonalInvoke`'s `ctx: WarehouseWriteContext` param, the `invokeConnectorWrite(ctx: WarehouseWriteContext, ...)` signature). Update the file-header comment and the doc comment that says "warehouse/BI write" → "connector write". No logic changes.

- [ ] **Step 3: Update the test file's import + type name**

In `connector-write-transport.test.ts`: update the import path (now same-dir, name change only if it referenced the old filename) and any `WarehouseWriteContext` → `ConnectorWriteContext`.

- [ ] **Step 4: Find and update any remaining importers**

Run: `git grep -n "warehouse-write-transport\|WarehouseWriteContext" -- packages`
Expected: only `connector-write-dispatch` (still named warehouse until Task 6) references it. Update that import path now to `./connector-write-transport.ts` and the type to `ConnectorWriteContext` (the dispatcher rename in Task 6 completes the rest).

- [ ] **Step 5: Run the transport test + typecheck the connectors dir**

Run: `bun test packages/gateway/src/connectors/connector-write-transport.test.ts`
Expected: PASS.
Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json` (or the repo's `bun run typecheck` scoped) — expect no new errors referencing the renamed symbols.

- [ ] **Step 6: Commit**

```bash
git add -A packages/gateway/src/connectors/
git commit -m "refactor(connectors): rename warehouse-write-transport → connector-write-transport"
```

---

## Task 6: Generalize the dispatcher to route the full connector-write union

**Files:**
- Rename: `packages/gateway/src/connectors/warehouse-write-dispatch.ts` → `connector-write-dispatch.ts`
- Rename: `packages/gateway/src/connectors/warehouse-write-dispatch.test.ts` → `connector-write-dispatch.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (call site)

**Interfaces:**
- Consumes: `connectorWriteByActionType` (Task 3), `invokeConnectorWrite` + `ConnectorWriteContext` (Task 5), `extractToolInput` (from `registry.ts`).
- Produces: `createConnectorWriteDispatcher(inner: ConnectorDispatcher, deps: ConnectorWriteContext): ConnectorDispatcher`.

- [ ] **Step 1: Git-rename both files**

```bash
git mv packages/gateway/src/connectors/warehouse-write-dispatch.ts packages/gateway/src/connectors/connector-write-dispatch.ts
git mv packages/gateway/src/connectors/warehouse-write-dispatch.test.ts packages/gateway/src/connectors/connector-write-dispatch.test.ts
```

- [ ] **Step 2: Write/extend the failing test — a GitOps action routes to the transport**

In `connector-write-dispatch.test.ts`, add (keeping the existing warehouse routing test):

```ts
import { describe, expect, test } from "bun:test";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { createConnectorWriteDispatcher } from "./connector-write-dispatch.ts";
import { __setPersonalInvokeForTest } from "./connector-write-transport.ts";

const ctx = {
  vault: {} as never,
  sandboxCwd: "/tmp",
  credentialFor: () => ({ credential: "personal" as const }),
  runTeamInvoke: async () => ({}),
};

describe("connector-write-dispatch routes gitops/ml writes", () => {
  test("argocd.app.sync routes to invokeConnectorWrite with the right service/toolId", async () => {
    let seen: { service: string; writeToolId: string } | undefined;
    __setPersonalInvokeForTest(async (_c, service, writeToolId) => {
      seen = { service, writeToolId };
      return { status: "requested" };
    });
    const inner: ConnectorDispatcher = { dispatch: async () => "INNER" };
    const d = createConnectorWriteDispatcher(inner, ctx);
    const action = {
      type: "argocd.app.sync",
      payload: { mcpToolId: "argocd_app_sync", toolInput: { name: "web" } },
    } as unknown as PlannedAction;
    await d.dispatch(action);
    expect(seen).toEqual({ service: "argocd", writeToolId: "argocd_app_sync" });
    __setPersonalInvokeForTest(undefined);
  });

  test("a non-write action delegates to inner", async () => {
    const inner: ConnectorDispatcher = { dispatch: async () => "INNER" };
    const d = createConnectorWriteDispatcher(inner, ctx);
    const r = await d.dispatch({ type: "argocd.app.get", payload: {} } as unknown as PlannedAction);
    expect(r).toBe("INNER");
  });
});
```

> Note: match the existing test's `PlannedAction`/payload shape — read the original `warehouse-write-dispatch.test.ts` content (now renamed) and reuse its `extractToolInput`-compatible payload key (`toolInput` vs `mcpToolInput`) verbatim.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/connector-write-dispatch.test.ts`
Expected: FAIL — `createConnectorWriteDispatcher` not exported / still named `createWarehouseWriteDispatcher`, routing via `warehouseWriteByActionType`.

- [ ] **Step 4: Rewrite the dispatcher to the union**

Replace the body of `connector-write-dispatch.ts` with:

```ts
// packages/gateway/src/connectors/connector-write-dispatch.ts
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { connectorWriteByActionType } from "./connector-write-registry.ts";
import { invokeConnectorWrite, type ConnectorWriteContext } from "./connector-write-transport.ts";
import { extractToolInput } from "./registry.ts";

/**
 * Wraps the base connector dispatcher: a connector write action.type (warehouse/BI ∪ GitOps/ML) is
 * routed to the credential-aware {@link invokeConnectorWrite} transport; everything else delegates to
 * `inner`. Installed in assemble.ts AROUND the executor's dispatcher, so the executor + registry stay
 * generic. Credential selection is config-driven via `deps.credentialFor` — never from the payload.
 * The HITL (I2) gate is upstream in the executor; this is reached only after `gate()` → "proceed".
 */
export function createConnectorWriteDispatcher(
  inner: ConnectorDispatcher,
  deps: ConnectorWriteContext,
): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      const write = connectorWriteByActionType(action.type);
      if (write === undefined) return inner.dispatch(action);
      return invokeConnectorWrite(deps, {
        service: write.service,
        writeToolId: write.toolId,
        args: extractToolInput(action),
      });
    },
  };
}
```

- [ ] **Step 5: Update the `assemble.ts` call site**

Run: `git grep -n "createWarehouseWriteDispatcher\|warehouse-write-dispatch" -- packages/gateway/src/platform/assemble.ts`
Update the import to `./…/connectors/connector-write-dispatch.ts` (match the existing relative depth) and the call `createWarehouseWriteDispatcher(` → `createConnectorWriteDispatcher(`. No other change — the `deps` object is already a `ConnectorWriteContext` (renamed type, same shape).

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test packages/gateway/src/connectors/connector-write-dispatch.test.ts`
Expected: PASS.
Run: `git grep -n "createWarehouseWriteDispatcher\|warehouseWriteByActionType\|WarehouseWriteContext\|warehouse-write-transport\|warehouse-write-dispatch" -- packages/gateway/src` — expect **no** matches outside `warehouse-write-tools.ts` (which legitimately keeps its `WAREHOUSE_BI_*` names).

- [ ] **Step 7: Commit**

```bash
git add -A packages/gateway/src/connectors/ packages/gateway/src/platform/assemble.ts
git commit -m "refactor(connectors): generalize write dispatcher to the full connector-write union"
```

---

## Task 7: Generalize invariant I26 (wiring + docs + test + static — ONE commit)

**Files:**
- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (predicate swap)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D20 generalization)
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts` (D20 test)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I26 runtime test)
- Modify: `docs/SECURITY-INVARIANTS.md` (I26 reword)

**Interfaces:**
- Consumes: `isConnectorWriteToolId` (Task 3).

- [ ] **Step 1: Write the failing runtime test** (extend the I26 block in `security-invariants.test.ts`)

Locate `describe("I26 — warehouse/BI writes are confined ...")` (~line 1007). Add a test asserting a federated peer invoke of a **GitOps** write tool id is rejected and never runs the tool, mirroring the existing warehouse assertion shape:

```ts
test("federated peer invoke of a gitops write tool id is rejected fail-closed (I26 generalized)", async () => {
  const { answerFederatedInvoke } = await import("./federation/invoke-gate.ts");
  const { isConnectorWriteToolId } = await import("./connectors/connector-write-registry.ts");
  let ran = false;
  const ctx = {
    // reuse the same minimal InvokeGateCtx the existing warehouse test builds, but inject the union:
    isWriteForbiddenToolId: isConnectorWriteToolId,
    runTool: async () => {
      ran = true;
      return {};
    },
    audit: () => {},
  } as unknown as Parameters<typeof answerFederatedInvoke>[0];
  const res = await answerFederatedInvoke(ctx, {
    toolId: "flux_kustomization_reconcile",
    // ...match the existing test's InboundInvoke shape (peerId/entry/args)
  } as unknown as Parameters<typeof answerFederatedInvoke>[1]);
  expect(res).toEqual({ kind: "error", error: "no_grant" });
  expect(ran).toBe(false);
});
```

> Read the existing warehouse I26 test and copy its exact `ctx`/`InboundInvoke` construction; only the `isWriteForbiddenToolId` predicate (now `isConnectorWriteToolId`) and the `toolId` (`flux_kustomization_reconcile`) differ.

- [ ] **Step 2: Write the failing static test** (extend `check-nimbus-invariants.test.ts`)

Find the `checkWarehouseWriteConfinement` describe block. Add a test that a GitOps write tool id literal in a non-allowed file is flagged:

```ts
test("flags a gitops write tool id literal outside the allowed set", () => {
  const v = checkConnectorWriteConfinement([
    { relPath: "packages/gateway/src/engine/agent.ts", contents: 'const x = "argocd_app_sync";' },
  ]);
  expect(v.some((x) => x.rule === "D20-connector-write")).toBe(true);
});

test("does NOT flag the gitops-ml SSoT module", () => {
  const v = checkConnectorWriteConfinement([
    {
      relPath: "packages/gateway/src/connectors/gitops-ml-write-tools.ts",
      contents: 'w("argocd.app.sync", "argocd_app_sync", "argocd");',
    },
  ]);
  expect(v).toHaveLength(0);
});
```

> Also update the existing references from `checkWarehouseWriteConfinement` → `checkConnectorWriteConfinement` and the rule string `D20-warehouse-write` → `D20-connector-write` in this test file. Keep the `D20-invoke-gate-predicate` rule string unchanged.

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.test.ts`
Expected: FAIL (new tests).

- [ ] **Step 4: Swap the federated predicate**

In `packages/gateway/src/ipc/federation-rpc.ts`: change the import `import { isWarehouseWriteToolId } from "../connectors/warehouse-write-tools.ts";` → `import { isConnectorWriteToolId } from "../connectors/connector-write-registry.ts";` and the injection (`~line 495`) `isWriteForbiddenToolId: isWarehouseWriteToolId,` → `isWriteForbiddenToolId: isConnectorWriteToolId,`. Update the adjacent I26 comment from "warehouse/BI write" → "connector write".

- [ ] **Step 5: Generalize the D20 static check**

In `scripts/structure-audit/check-nimbus-invariants.ts`:
- Rename `WAREHOUSE_WRITE_ALLOWED` → `CONNECTOR_WRITE_ALLOWED`; add the three connector servers + the GitOps/ML SSoT:
  ```ts
  "packages/gateway/src/connectors/gitops-ml-write-tools.ts",
  "packages/mcp-connectors/argocd/src/server.ts",
  "packages/mcp-connectors/flux/src/server.ts",
  "packages/mcp-connectors/mlflow/src/server.ts",
  ```
  and update the two renamed transport/dispatch entries to `connector-write-transport.ts` / `connector-write-dispatch.ts`.
- Rename `WAREHOUSE_WRITE_RE` → `CONNECTOR_WRITE_RE` and extend the alternation with the six new ids:
  `argocd_app_sync|argocd_app_rollback|flux_kustomization_reconcile|flux_helmrelease_reconcile|mlflow_model_promote|mlflow_model_transition_stage`.
- Rename `checkWarehouseWriteConfinement` → `checkConnectorWriteConfinement`; change the pushed rule string `"D20-warehouse-write"` → `"D20-connector-write"` (keep `"D20-invoke-gate-predicate"`). Update the explanatory comment ("warehouse" → "connector").
- Update the call site of the renamed function in the same file's `runAllChecks`/aggregator.

- [ ] **Step 6: Reword the I26 docs row**

In `docs/SECURITY-INVARIANTS.md`, change the I26 entry's subject from "warehouse/BI write tool ids" to "connector write tool ids (warehouse/BI ∪ GitOps/ML)"; update the wiring-site list to include `connectors/gitops-ml-write-tools.ts` + `connectors/connector-write-registry.ts`; note the predicate is now `isConnectorWriteToolId`. Do **not** add a new invariant id.

- [ ] **Step 7: Run the full invariant + static suites**

Run: `bun test packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.test.ts`
Expected: PASS.
Run: `bun run audit:structure` (or the exact script that runs `check-nimbus-invariants.ts`; see `nimbus-commands`) — expect no violations.

- [ ] **Step 8: Commit (the invariant triple, one commit)**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md
git commit -m "feat(security): generalize I26/D20 to all connector write tool ids (gitops/ml + warehouse)"
```

---

## Task 8: Enroll ArgoCD/Flux/MLflow in the team-vault group

**Files:**
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts` (`TEAM_SECRET_ANYOF_GROUPS`)
- Modify: the manifest's test (find with `git grep -n "TEAM_SECRET_ANYOF_GROUPS" -- packages/gateway/src/**/*.test.ts`)

- [ ] **Step 1: Write the failing test**

Add to the connector-secrets-manifest test file:

```ts
import { TEAM_SECRET_ANYOF_GROUPS } from "../connectors/connector-secrets-manifest.ts"; // adjust path

test("argocd/flux/mlflow tokens are team-vault enrollable (W1)", () => {
  expect(TEAM_SECRET_ANYOF_GROUPS.argocd).toEqual([["argocd.token"]]);
  expect(TEAM_SECRET_ANYOF_GROUPS.flux).toEqual([["flux.token"]]);
  expect(TEAM_SECRET_ANYOF_GROUPS.mlflow).toEqual([["mlflow.token"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the manifest test file>`
Expected: FAIL — keys undefined.

- [ ] **Step 3: Add the enrollments**

In `connector-secrets-manifest.ts`, extend `TEAM_SECRET_ANYOF_GROUPS`:

```ts
export const TEAM_SECRET_ANYOF_GROUPS: Partial<
  Record<ConnectorServiceId, readonly (readonly string[])[]>
> = {
  snowflake: [["snowflake.oauth_token", "snowflake.key_pair_jwt"]],
  argocd: [["argocd.token"]],
  flux: [["flux.token"]],
  mlflow: [["mlflow.token"]],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test <the manifest test file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-secrets-manifest.ts <the manifest test file>
git commit -m "feat(connectors): enroll argocd/flux/mlflow tokens in TEAM_SECRET_ANYOF_GROUPS (W1 team writes)"
```

---

## Task 9: ArgoCD write tools (registrar extraction + sync/rollback)

**Files:**
- Modify: `packages/mcp-connectors/argocd/src/server.ts`
- Modify: `packages/mcp-connectors/argocd/nimbus.extension.json`
- Create: `packages/mcp-connectors/argocd/test/server-writes.test.ts`

**Reference (from the read code):** base = `${ARGOCD_URL}/api/v1`; auth = `Authorization: Bearer ${ARGOCD_TOKEN}`, `Accept: application/json`. Mirror Tableau's `registerTableauTools` + `captureTools` shape.

- [ ] **Step 1: Refactor — extract the exported registrar (behavior-preserving)**

In `argocd/src/server.ts`, change the inline `await runReadOnlyMcpConnector("nimbus-argocd", (reg) => { ...read tools... });` into:

```ts
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts"; // match the actual export path used by tableau

export function registerArgocdTools(reg: ZodToolRegistrar): void {
  // ...the three existing read-tool reg(...) calls, moved verbatim...
}

if (import.meta.main) {
  await runReadOnlyMcpConnector("nimbus-argocd", registerArgocdTools);
}
```

> Confirm the `ZodToolRegistrar` import path against `tableau/src/server.ts` (it imports from the shared kit). Run `bun test packages/mcp-connectors/argocd` to confirm existing read behavior unchanged (if no read test exists, just typecheck).

- [ ] **Step 2: Write the failing write-tool test**

```ts
// packages/mcp-connectors/argocd/test/server-writes.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerArgocdTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerArgocdTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
  );
  return tools;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("argocd write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    calls = [];
    process.env["ARGOCD_URL"] = "https://argo.example.com";
    process.env["ARGOCD_TOKEN"] = "tok";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ metadata: { name: "web" } }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("argocd_app_sync POSTs /applications/{name}/sync and returns status:requested", async () => {
    const out = payload(await (captureTools().get("argocd_app_sync") as Handler)({ name: "web" }));
    expect(out["status"]).toBe("requested");
    expect(calls[0]?.url).toBe("https://argo.example.com/api/v1/applications/web/sync");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("argocd_app_rollback POSTs /applications/{name}/rollback with the history id", async () => {
    await (captureTools().get("argocd_app_rollback") as Handler)({ name: "web", id: 3 });
    expect(calls[0]?.url).toBe("https://argo.example.com/api/v1/applications/web/rollback");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: 3 });
  });

  it("argocd_app_sync throws on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect((captureTools().get("argocd_app_sync") as Handler)({ name: "web" })).rejects.toThrow(
      /403/,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/argocd/test/server-writes.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 4: Add the two write tools inside `registerArgocdTools`**

Reuse the connector's existing `apiBase()` + `authHeader()` helpers (they already build `${ARGOCD_URL}/api/v1` + the Bearer header). Add a small `agPost(path, body)` helper if one does not exist (mirror the existing `agGet`):

```ts
async function agPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ArgoCD ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  return text === "" ? {} : JSON.parse(text);
}
```

```ts
reg(
  "argocd_app_sync",
  "Trigger a sync for an ArgoCD application (`POST /api/v1/applications/{name}/sync`, requires HITL argocd.app.sync). Async — the sync is requested; verify via the next metadata sync (sync_status/health_status). Recommend /schedule to re-check.",
  z.object({
    name: z.string().min(1),
    prune: z.boolean().optional(),
    revision: z.string().optional(),
  }),
  async (p) => {
    await agPost(`/applications/${encodeURIComponent(p.name)}/sync`, {
      ...(p.prune === undefined ? {} : { prune: p.prune }),
      ...(p.revision === undefined ? {} : { revision: p.revision }),
    });
    return jsonResult({ status: "requested", name: p.name });
  },
);

reg(
  "argocd_app_rollback",
  "Roll back an ArgoCD application to a prior deployment history id (`POST /api/v1/applications/{name}/rollback`, requires HITL argocd.app.rollback). Async — verify via the next metadata sync.",
  z.object({ name: z.string().min(1), id: z.number().int().nonnegative() }),
  async (p) => {
    await agPost(`/applications/${encodeURIComponent(p.name)}/rollback`, { id: p.id });
    return jsonResult({ status: "requested", name: p.name });
  },
);
```

> `z` and `jsonResult` are already imported by the read tools — reuse them.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/argocd/test/server-writes.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the manifest**

In `argocd/nimbus.extension.json`: set `"hitlRequired": ["write"]` and extend `description` to mention the two HITL-gated write tools (mirror Tableau's description style).

- [ ] **Step 7: Run the connector contract test + commit**

Run: `bun test packages/mcp-connectors/argocd`
Expected: PASS (incl. any `runContractTests`).

```bash
git add packages/mcp-connectors/argocd/
git commit -m "feat(argocd): HITL-gated app.sync + app.rollback write tools"
```

---

## Task 10: Flux write tools (registrar extraction + kustomization/helmrelease reconcile)

**Files:**
- Modify: `packages/mcp-connectors/flux/src/server.ts`
- Modify: `packages/mcp-connectors/flux/nimbus.extension.json`
- Create: `packages/mcp-connectors/flux/test/server-writes.test.ts`

**Reference:** base = `${FLUX_API_URL}` (kube-apiserver, no suffix); auth = Bearer. Existing helpers `kindEntry(kind)` → `{ group, version, plural }` and `listPath(entry, ns)` → `/apis/{group}/{version}/namespaces/{ns}/{plural}`. The reconcile write = `PATCH {listPath}/{name}` with `Content-Type: application/merge-patch+json`, body `{ metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": <RFC3339 now> } } }`. Each write tool is fixed to one kind (Kustomization / HelmRelease) — reuse the existing kind constant the read enum defines for each (read `KIND_VALUES`/the kind map to get the exact constant string).

- [ ] **Step 1: Refactor — extract exported `registerFluxTools` + `import.meta.main` guard** (same pattern as Task 9 Step 1).

- [ ] **Step 2: Write the failing write-tool test**

```ts
// packages/mcp-connectors/flux/test/server-writes.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerFluxTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerFluxTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
  );
  return tools;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("flux reconcile write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    calls = [];
    process.env["FLUX_API_URL"] = "https://k8s.example.com";
    process.env["FLUX_TOKEN"] = "tok";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ kind: "Kustomization" }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("flux_kustomization_reconcile PATCHes the CR with the requestedAt annotation", async () => {
    const out = payload(
      await (captureTools().get("flux_kustomization_reconcile") as Handler)({
        namespace: "flux-system",
        name: "apps",
      }),
    );
    expect(out["status"]).toBe("requested");
    expect(calls[0]?.url).toContain(
      "/apis/kustomize.toolkit.fluxcd.io/", // version segment from kindEntry follows
    );
    expect(calls[0]?.url.endsWith("/namespaces/flux-system/kustomizations/apps")).toBe(true);
    expect(calls[0]?.init?.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      metadata: { annotations: Record<string, string> };
    };
    expect(body.metadata.annotations["reconcile.fluxcd.io/requestedAt"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("flux_helmrelease_reconcile PATCHes the helm.toolkit.fluxcd.io CR", async () => {
    await (captureTools().get("flux_helmrelease_reconcile") as Handler)({
      namespace: "apps",
      name: "redis",
    });
    expect(calls[0]?.url).toContain("/apis/helm.toolkit.fluxcd.io/");
    expect(calls[0]?.url.endsWith("/namespaces/apps/helmreleases/redis")).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/flux/test/server-writes.test.ts`
Expected: FAIL.

- [ ] **Step 4: Add the two reconcile tools inside `registerFluxTools`**

Add a `fluxReconcile(kindValue, namespace, name)` helper that reuses `kindEntry`/`listPath`:

```ts
async function fluxReconcile(kindValue: FluxKind, namespace: string, name: string): Promise<string> {
  const entry = kindEntry(kindValue);
  const path = `${listPath(entry, namespace)}/${encodeURIComponent(name)}`;
  const requestedAt = new Date().toISOString();
  const res = await fetch(`${apiBase()}${path}`, {
    method: "PATCH",
    headers: { ...authHeader(), "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({
      metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": requestedAt } },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flux reconcile ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  return requestedAt;
}
```

```ts
reg(
  "flux_kustomization_reconcile",
  "Request a reconcile of a Flux Kustomization by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.kustomization.reconcile, and the SA's `patch` RBAC verb on kustomizations). Async — verify via the next metadata sync.",
  z.object({ namespace: z.string().min(1), name: z.string().min(1) }),
  async (p) =>
    jsonResult({
      status: "requested",
      name: p.name,
      requestedAt: await fluxReconcile(/* Kustomization kind const */ KIND_KUSTOMIZATION, p.namespace, p.name),
    }),
);

reg(
  "flux_helmrelease_reconcile",
  "Request a reconcile of a Flux HelmRelease by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.helmrelease.reconcile, and the SA's `patch` RBAC verb on helmreleases). Async — verify via the next metadata sync.",
  z.object({ namespace: z.string().min(1), name: z.string().min(1) }),
  async (p) =>
    jsonResult({
      status: "requested",
      name: p.name,
      requestedAt: await fluxReconcile(/* HelmRelease kind const */ KIND_HELMRELEASE, p.namespace, p.name),
    }),
);
```

> Replace `KIND_KUSTOMIZATION` / `KIND_HELMRELEASE` and `FluxKind` with the exact kind-value constants + type the connector already defines (from its `KIND_VALUES` enum / kind map — read `flux/src/server.ts` and the SDK `flux-cd/index.ts`). Do not introduce new kind strings; reuse the read path's source of truth so the group/version stays consistent.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/flux/test/server-writes.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the manifest** — `"hitlRequired": ["write"]` + description mentions the two reconcile tools + the `patch` RBAC requirement.

- [ ] **Step 7: Run the connector test + commit**

Run: `bun test packages/mcp-connectors/flux`
Expected: PASS.

```bash
git add packages/mcp-connectors/flux/
git commit -m "feat(flux): HITL-gated kustomization + helmrelease reconcile write tools"
```

---

## Task 11: MLflow write tools (registrar extraction + promote/transition-stage)

**Files:**
- Modify: `packages/mcp-connectors/mlflow/src/server.ts`
- Modify: `packages/mcp-connectors/mlflow/nimbus.extension.json`
- Create: `packages/mcp-connectors/mlflow/test/server-writes.test.ts`

**Reference:** base = `${MLFLOW_HOST}` (no suffix); auth = Bearer. Write endpoint = `POST /api/2.0/mlflow/model-versions/transition-stage`, body `{ name, version, stage, archive_existing_versions }`. `archiveExisting` arg defaults `false`.

- [ ] **Step 1: Refactor — extract exported `registerMlflowTools` + `import.meta.main` guard** (Task 9 Step 1 pattern).

- [ ] **Step 2: Write the failing write-tool test**

```ts
// packages/mcp-connectors/mlflow/test/server-writes.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerMlflowTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerMlflowTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
  );
  return tools;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("mlflow write tools", () => {
  const origFetch = globalThis.fetch;
  let bodies: Record<string, unknown>[] = [];
  beforeEach(() => {
    bodies = [];
    process.env["MLFLOW_HOST"] = "https://mlflow.example.com";
    process.env["MLFLOW_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ model_version: { current_stage: "Production" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("mlflow_model_promote sends stage=Production and archive_existing_versions=false by default", async () => {
    const out = payload(
      await (captureTools().get("mlflow_model_promote") as Handler)({ name: "ranker", version: "4" }),
    );
    expect(out["status"]).toBe("ok");
    expect(bodies[0]).toEqual({
      name: "ranker",
      version: "4",
      stage: "Production",
      archive_existing_versions: false,
    });
  });

  it("mlflow_model_promote honors archiveExisting:true", async () => {
    await (captureTools().get("mlflow_model_promote") as Handler)({
      name: "ranker",
      version: "4",
      archiveExisting: true,
    });
    expect(bodies[0]?.["archive_existing_versions"]).toBe(true);
  });

  it("mlflow_model_transition_stage sends the caller stage", async () => {
    await (captureTools().get("mlflow_model_transition_stage") as Handler)({
      name: "ranker",
      version: "4",
      stage: "Staging",
    });
    expect(bodies[0]?.["stage"]).toBe("Staging");
    expect(bodies[0]?.["archive_existing_versions"]).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/mlflow/test/server-writes.test.ts`
Expected: FAIL.

- [ ] **Step 4: Add the two write tools inside `registerMlflowTools`**

Add an `mlflowPost(path, body)` helper mirroring the existing `mlflowGet`:

```ts
async function mlflowPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MLflow ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  return text === "" ? {} : JSON.parse(text);
}

const TRANSITION_PATH = "/api/2.0/mlflow/model-versions/transition-stage";
```

```ts
reg(
  "mlflow_model_promote",
  "Promote a model version to Production (`POST /api/2.0/mlflow/model-versions/transition-stage`, stage=Production; requires HITL mlflow.model.promote). `archiveExisting` (default false) archives other Production versions — opt in explicitly.",
  z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    archiveExisting: z.boolean().optional(),
  }),
  async (p) => {
    await mlflowPost(TRANSITION_PATH, {
      name: p.name,
      version: p.version,
      stage: "Production",
      archive_existing_versions: p.archiveExisting ?? false,
    });
    return jsonResult({ status: "ok", name: p.name, version: p.version, stage: "Production" });
  },
);

reg(
  "mlflow_model_transition_stage",
  "Transition a model version to a chosen stage (`POST /api/2.0/mlflow/model-versions/transition-stage`; requires HITL mlflow.model.transition_stage). `archiveExisting` default false.",
  z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    stage: z.enum(["None", "Staging", "Production", "Archived"]),
    archiveExisting: z.boolean().optional(),
  }),
  async (p) => {
    await mlflowPost(TRANSITION_PATH, {
      name: p.name,
      version: p.version,
      stage: p.stage,
      archive_existing_versions: p.archiveExisting ?? false,
    });
    return jsonResult({ status: "ok", name: p.name, version: p.version, stage: p.stage });
  },
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/mlflow/test/server-writes.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the manifest** — `"hitlRequired": ["write"]` + description mentions the two write tools.

- [ ] **Step 7: Run the connector test + commit**

Run: `bun test packages/mcp-connectors/mlflow`
Expected: PASS.

```bash
git add packages/mcp-connectors/mlflow/
git commit -m "feat(mlflow): HITL-gated model.promote + model.transition_stage write tools"
```

---

## Task 12: Docs (CHANGELOG + roadmap), invariant doc-drift, and ship-readiness gate

**Files:**
- Modify: `docs/CHANGELOG.md` (W1 entry)
- Modify: `docs/roadmap.md` (GitOps/MLflow write rows checked; SageMaker/Vertex annotated deferred)
- Verify: `docs/architecture.md` (IPC/connector counts if any reference the I26 subject — reword only if it names "warehouse writes")

- [ ] **Step 1: CHANGELOG entry** (connector-docs-changelog convention — do **not** edit the CLAUDE.md/GEMINI.md status line)

Add a dated entry under the current unreleased section summarizing W1: six HITL-gated write tools (ArgoCD sync/rollback, Flux kustomization/helmrelease reconcile, MLflow promote/transition-stage), personal+team credentials, I26 generalized to all connector writes, no migration, SageMaker/Vertex writes deferred.

- [ ] **Step 2: Roadmap rows**

In `docs/roadmap.md` "Deferred from Phase 5":
- Check off ArgoCD writes, Flux writes, and the MLflow line of ML writes (mark "✅ delivered 2026-06-20 (W1)").
- Annotate the SageMaker writes + Vertex AI writes rows: "remains deferred — CLI-credential connectors (no discrete token); does not fit the team-vault/discrete-token write model; S5-demoted."

- [ ] **Step 3: Run doc-drift + markdown gates**

Run: `bun run audit:doc-refs` and `bun run lint:markdown` (and `lychee` on changed docs).
Expected: PASS.

- [ ] **Step 4: Full ship-readiness (the never-push-and-see rule)**

Run, in order, and fix any failure before proceeding:
- `bun run preflight` (full CI parity — all-package tsc, biome, tests, static audits)
- the Docker Linux coverage-floor dry-run (`oven/bun:latest`) over the new files, then `check.ts` — every new file ≥80% line+branch
- `bun run audit:structure` (D20 generalized) — no violations
- whole-branch `/code-review`

- [ ] **Step 5: Commit docs + push + open PR**

```bash
git add docs/CHANGELOG.md docs/roadmap.md docs/architecture.md
git commit -m "docs(slice9): W1 CHANGELOG + roadmap rows (gitops/mlflow writes shipped; sagemaker/vertex deferred)"
git push -u origin worktree-phase6-slice9-wrapup
```

Open the PR with a summary linking the spec; title `feat(slice9-w1): HITL-gated GitOps + ML writes (ArgoCD/Flux/MLflow), generalize I26`.

---

## Self-Review (completed during authoring)

**Spec coverage:** Every spec section maps to a task — write surface §3 → Tasks 9–11; HITL set §4.2 → Task 4; transport reuse/rename §4.2 → Tasks 5–6; SSoT + union registry §4.3 → Tasks 1–3; generalized I26/D20 §4.4 → Task 7; team enrollment §4.2 → Task 8; archiveExisting §3 → Task 11; Flux RBAC + async output §3 → Tasks 10/9 (descriptions) + manifest; drift completeness §4.3 → Task 4; deferrals + roadmap §1.1 → Task 12.

**Placeholder scan:** The only deliberate "read the existing constant" instructions are Task 10's Flux kind constants (`KIND_KUSTOMIZATION`/`KIND_HELMRELEASE`) and Task 6's payload key — both are *reuse-an-existing-symbol* instructions (the symbols exist in the connector / the renamed test), not unspecified behavior, per the spec's reference-impl rule. All code steps include runnable code.

**Type consistency:** `ConnectorWrite`/`w` (Task 1) used identically in Tasks 2–3; `ConnectorWriteContext`/`invokeConnectorWrite` (Task 5) used in Task 6; `isConnectorWriteToolId`/`connectorWriteByActionType` (Task 3) used in Tasks 6–7; registrar names `registerArgocdTools`/`registerFluxTools`/`registerMlflowTools` consistent between extraction and test.
