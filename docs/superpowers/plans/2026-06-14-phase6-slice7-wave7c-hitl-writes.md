# Phase 6 Slice 7 — Wave 7c: HITL-gated warehouse/BI WRITE actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add twelve HITL-gated write actions (two per connector) to the six warehouse/BI connectors, executing only behind the local owner's I2 consent gate, reusing the Wave 7b spawn transport for personal + team credentials, with a new confinement invariant I26/D20 that fail-closed rejects write tool ids on the federated peer path.

**Architecture:** A single-source-of-truth module maps `action.type ↔ toolId ↔ service`. The twelve types are added to the frozen `HITL_REQUIRED_BACKING` set so I2 gates every local write. A `ConnectorDispatcher` decorator routes warehouse-write action types to a new `invokeConnectorWrite` transport (personal: service-scoped vault view; team: a new `answerLocalOperatorInvoke` I19 variant) — both via the Wave 7b `withConnectorSession` spawn-once primitive. The federated peer gate `answerFederatedInvoke` gains an injected `isWriteForbiddenToolId` predicate (I26). Credential selection is config-driven (`[connectors.<name>]`), identical to Wave 7b sync — never taken from the action payload.

**Tech Stack:** Bun + TypeScript strict, Biome, `bun:test`. MCP connectors use `@modelcontextprotocol/sdk` via the `shared/run-read-only-mcp-connector.ts` `register<Svc>Tools(reg)` registrar + `shared/mcp-tool-kit.ts` (`fetchWithTimeout`, `mcpJsonResult`). Coverage floor ≥80% line+branch per file (`audit:coverage-floor`, Docker-Linux-authoritative).

**Reference design:** `docs/superpowers/specs/2026-06-14-phase6-slice7-wave7c-hitl-writes-design.md` (+ its review doc). Branch `dev/asafgolombek/phase6-slice7-wave7c` off main `8e42e0ed`.

---

## Conventions for every task

- TDD: write the failing test, run it red, implement minimally, run it green, commit.
- All paths below are repo-relative; the worktree root is
  `C:/gitrep/Nimbus/.claude/worktrees/dev+asafgolombek+phase6-slice7-wave7c`.
- Run a single test file with: `bun test <path>` (add `--timeout 60000` if it spawns).
- Per-connector tasks (Phase 1) commit one connector at a time — connectors share registration
  files; running them sequentially with a commit each avoids the Wave 7a/7b subagent-death trap.
- Never edit files via the main-repo path (`C:/gitrep/Nimbus/packages/...`) — always the worktree
  path, or the edit silently lands on `main`.

---

## Phase 0 — Shared gateway scaffolding

## Task 1: Write-surface single source of truth (`warehouse-write-tools.ts`)

**Files:**

- Create: `packages/gateway/src/connectors/warehouse-write-tools.ts`
- Test: `packages/gateway/src/connectors/warehouse-write-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/connectors/warehouse-write-tools.test.ts
import { describe, expect, test } from "bun:test";
import {
  WAREHOUSE_BI_WRITES,
  WAREHOUSE_BI_WRITE_TOOL_IDS,
  isWarehouseWriteToolId,
  warehouseWriteByActionType,
} from "./warehouse-write-tools.ts";

describe("warehouse-write-tools — single source of truth", () => {
  test("exposes exactly the twelve write actions, 2 per connector", () => {
    expect(WAREHOUSE_BI_WRITES).toHaveLength(12);
    const services = new Set(WAREHOUSE_BI_WRITES.map((w) => w.service));
    expect([...services].sort()).toEqual([
      "bigeye",
      "looker",
      "montecarlo",
      "powerbi",
      "snowflake",
      "tableau",
    ]);
    for (const svc of services) {
      expect(WAREHOUSE_BI_WRITES.filter((w) => w.service === svc)).toHaveLength(2);
    }
  });

  test("action types and tool ids are unique and well-formed", () => {
    const types = WAREHOUSE_BI_WRITES.map((w) => w.actionType);
    const ids = WAREHOUSE_BI_WRITES.map((w) => w.toolId);
    expect(new Set(types).size).toBe(12);
    expect(new Set(ids).size).toBe(12);
    for (const w of WAREHOUSE_BI_WRITES) {
      expect(w.actionType.startsWith(`${w.service}.`)).toBe(true);
      expect(w.toolId.startsWith(`${w.service}_`)).toBe(true);
    }
  });

  test("WAREHOUSE_BI_WRITE_TOOL_IDS + isWarehouseWriteToolId agree", () => {
    expect(WAREHOUSE_BI_WRITE_TOOL_IDS.size).toBe(12);
    expect(isWarehouseWriteToolId("tableau_datasource_refresh")).toBe(true);
    expect(isWarehouseWriteToolId("tableau_list")).toBe(false);
    expect(isWarehouseWriteToolId("")).toBe(false);
  });

  test("warehouseWriteByActionType resolves and rejects", () => {
    expect(warehouseWriteByActionType("powerbi.dataset.refresh")?.toolId).toBe(
      "powerbi_dataset_refresh",
    );
    expect(warehouseWriteByActionType("notion.page.create")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/warehouse-write-tools.test.ts`
Expected: FAIL (module not found / exports undefined).

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/gateway/src/connectors/warehouse-write-tools.ts

/** One warehouse/BI write action: its HITL action.type, its MCP tool id, and its service id.
 *  Single source of truth consumed by the HITL drift test (Task 2), the dispatch decorator
 *  (Task 5), and the I26 confinement predicate (Task 6). */
export interface WarehouseWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

export const WAREHOUSE_BI_WRITES: readonly WarehouseWrite[] = [
  { actionType: "snowflake.tag.set", toolId: "snowflake_tag_set", service: "snowflake" },
  { actionType: "snowflake.comment.set", toolId: "snowflake_comment_set", service: "snowflake" },
  { actionType: "tableau.datasource.refresh", toolId: "tableau_datasource_refresh", service: "tableau" },
  { actionType: "tableau.workbook.refresh", toolId: "tableau_workbook_refresh", service: "tableau" },
  { actionType: "looker.datagroup.trigger", toolId: "looker_datagroup_trigger", service: "looker" },
  { actionType: "looker.schedule.run_once", toolId: "looker_schedule_run_once", service: "looker" },
  { actionType: "powerbi.dataset.refresh", toolId: "powerbi_dataset_refresh", service: "powerbi" },
  { actionType: "powerbi.dataflow.refresh", toolId: "powerbi_dataflow_refresh", service: "powerbi" },
  { actionType: "montecarlo.incident.acknowledge", toolId: "montecarlo_incident_acknowledge", service: "montecarlo" },
  { actionType: "montecarlo.incident.resolve", toolId: "montecarlo_incident_resolve", service: "montecarlo" },
  { actionType: "bigeye.issue.acknowledge", toolId: "bigeye_issue_acknowledge", service: "bigeye" },
  { actionType: "bigeye.issue.resolve", toolId: "bigeye_issue_resolve", service: "bigeye" },
] as const;

export const WAREHOUSE_BI_WRITE_TOOL_IDS: ReadonlySet<string> = new Set(
  WAREHOUSE_BI_WRITES.map((w) => w.toolId),
);

const BY_ACTION_TYPE: ReadonlyMap<string, WarehouseWrite> = new Map(
  WAREHOUSE_BI_WRITES.map((w) => [w.actionType, w]),
);

export function isWarehouseWriteToolId(toolId: string): boolean {
  return WAREHOUSE_BI_WRITE_TOOL_IDS.has(toolId);
}

export function warehouseWriteByActionType(actionType: string): WarehouseWrite | undefined {
  return BY_ACTION_TYPE.get(actionType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/warehouse-write-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/warehouse-write-tools.ts packages/gateway/src/connectors/warehouse-write-tools.test.ts
git commit -m "feat(7c): warehouse/BI write-tool single source of truth"
```

---

## Task 2: Register the twelve action types in the HITL set (I2)

**Files:**

- Modify: `packages/gateway/src/engine/executor.ts:107` (end of `HITL_REQUIRED_BACKING` array)
- Test: `packages/gateway/src/connectors/warehouse-write-tools.test.ts` (add a drift test)

- [ ] **Step 1: Write the failing test** (append to the Task 1 test file)

```typescript
import { HITL_REQUIRED } from "../engine/executor.ts";

describe("warehouse writes are all HITL-gated (I2 drift)", () => {
  test("every write action type is in HITL_REQUIRED", () => {
    for (const w of WAREHOUSE_BI_WRITES) {
      expect(HITL_REQUIRED.has(w.actionType)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/warehouse-write-tools.test.ts`
Expected: FAIL (the 12 types are not yet in the set).

- [ ] **Step 3: Add the twelve strings to `HITL_REQUIRED_BACKING`**

In `packages/gateway/src/engine/executor.ts`, insert before the closing `]);` at line 107 (after `"teamvault.delete",`):

```typescript
  // Phase 6 Slice 7 Wave 7c — warehouse/BI writes (kept in sync with WAREHOUSE_BI_WRITES;
  // see connectors/warehouse-write-tools.ts; drift asserted in warehouse-write-tools.test.ts).
  "snowflake.tag.set",
  "snowflake.comment.set",
  "tableau.datasource.refresh",
  "tableau.workbook.refresh",
  "looker.datagroup.trigger",
  "looker.schedule.run_once",
  "powerbi.dataset.refresh",
  "powerbi.dataflow.refresh",
  "montecarlo.incident.acknowledge",
  "montecarlo.incident.resolve",
  "bigeye.issue.acknowledge",
  "bigeye.issue.resolve",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/warehouse-write-tools.test.ts`
Then the existing I2 suite: `bun test packages/gateway/src/security-invariants.test.ts -t "I2"`
Expected: PASS (the I2 test asserts every member triggers the consent channel).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/executor.ts packages/gateway/src/connectors/warehouse-write-tools.test.ts
git commit -m "feat(7c): HITL-gate the twelve warehouse/BI write action types (I2)"
```

---

## Task 3: `answerLocalOperatorInvoke` + I26 rejection in the invoke gate

**Files:**

- Modify: `packages/gateway/src/teamvault/team-vault-audit.ts` (add `"write_forbidden"` decision)
- Modify: `packages/gateway/src/federation/invoke-gate.ts` (I26 predicate in `answerFederatedInvoke`; new `answerLocalOperatorInvoke`)
- Test: `packages/gateway/src/federation/invoke-gate.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test** (append to `invoke-gate.test.ts`)

```typescript
import { answerFederatedInvoke, answerLocalOperatorInvoke } from "./invoke-gate.ts";

function memDb() {
  // mirror the existing helper in this test file; if none, use createMemoryIndexDb()
  return createMemoryIndexDb();
}

describe("I26 — federated peer gate fail-closed rejects write tool ids", () => {
  test("a granted write tool id is rejected; runTool is never called", async () => {
    const db = memDb();
    let ran = false;
    const result = await answerFederatedInvoke(
      {
        db,
        store: {
          getEntry: () => ({ service: "tableau" }),
          checkGrant: () => true, // grant present — still must be rejected
        } as never,
        quorumFor: () => undefined,
        runQuorum: async () => ({ outcome: "approved", approvers: [] }),
        runTool: async () => {
          ran = true;
          return { ok: true };
        },
        isWriteForbiddenToolId: (id) => id === "tableau_datasource_refresh",
      },
      {
        peerId: "peer-1",
        entry: "warehouse",
        toolId: "tableau_datasource_refresh",
        purpose: "p",
        args: {},
      },
    );
    expect(result).toEqual({ kind: "error", error: "no_grant" }); // opaque
    expect(ran).toBe(false);
  });

  test("a read tool id is unaffected by the predicate", async () => {
    const db = memDb();
    let ran = false;
    const result = await answerFederatedInvoke(
      {
        db,
        store: { getEntry: () => ({ service: "tableau" }), checkGrant: () => true } as never,
        quorumFor: () => undefined,
        runQuorum: async () => ({ outcome: "approved", approvers: [] }),
        runTool: async () => {
          ran = true;
          return { ok: true };
        },
        isWriteForbiddenToolId: (id) => id === "tableau_datasource_refresh",
      },
      { peerId: "peer-1", entry: "warehouse", toolId: "tableau_list", purpose: "p", args: {} },
    );
    expect(result).toEqual({ kind: "ok", result: { ok: true } });
    expect(ran).toBe(true);
  });
});

describe("answerLocalOperatorInvoke — local owner may invoke a write tool id", () => {
  test("runs the tool and returns its result", async () => {
    const db = memDb();
    const result = await answerLocalOperatorInvoke(
      {
        db,
        store: { getEntry: () => ({ service: "tableau" }) } as never,
        runTool: async (input) => ({ echoed: input.toolId }),
      },
      { entry: "warehouse", service: "tableau", toolId: "tableau_datasource_refresh", args: {} },
    );
    expect(result).toEqual({ kind: "ok", result: { echoed: "tableau_datasource_refresh" } });
  });

  test("fail-closed on entry/service mismatch", async () => {
    const db = memDb();
    const result = await answerLocalOperatorInvoke(
      {
        db,
        store: { getEntry: () => ({ service: "looker" }) } as never,
        runTool: async () => ({ ok: true }),
      },
      { entry: "warehouse", service: "tableau", toolId: "tableau_datasource_refresh", args: {} },
    );
    expect(result).toEqual({ kind: "error", error: "no_grant" });
  });
});
```

> If `invoke-gate.test.ts` lacks `createMemoryIndexDb`, import it from the existing test helper used
> by sibling tests (grep `createMemoryIndexDb` under `packages/gateway`); the audit append only needs
> a real `bun:sqlite` Database.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/federation/invoke-gate.test.ts`
Expected: FAIL (`answerLocalOperatorInvoke` undefined; `isWriteForbiddenToolId` ignored).

- [ ] **Step 3a: Add the `write_forbidden` decision** in `team-vault-audit.ts`

```typescript
export type TeamVaultDecision =
  | "answered"
  | "no_grant"
  | "identity_invalid"
  | "quorum_failed"
  | "quorum_denied"
  | "write_forbidden";
```

- [ ] **Step 3b: I26 rejection in `answerFederatedInvoke`** — add the field to `InvokeGateCtx` and the check as the FIRST guard (`packages/gateway/src/federation/invoke-gate.ts`):

In `InvokeGateCtx` (after the `identity?` field):

```typescript
  /** I26: confines warehouse/BI write tool ids to the local executor I2 path — when this returns
   *  true for the requested toolId, the federated peer invoke is rejected fail-closed (opaque),
   *  before grant/quorum. Omitted → no write confinement (back-compat). */
  readonly isWriteForbiddenToolId?: (toolId: string) => boolean;
```

At the top of `answerFederatedInvoke`, before the identity check:

```typescript
  if (ctx.isWriteForbiddenToolId?.(q.toolId) === true) {
    audit(ctx, q, "write_forbidden");
    return { kind: "error", error: "no_grant" }; // opaque — never reveal write confinement
  }
```

- [ ] **Step 3c: Add `answerLocalOperatorInvoke`** at the end of `invoke-gate.ts` (mirror `answerLocalOperatorList`):

```typescript
export interface LocalOperatorInvokeCtx {
  readonly db: Database;
  readonly store: Pick<TeamVaultStore, "getEntry">;
  readonly runTool: (input: {
    entry: string;
    service: string;
    toolId: string;
    args: unknown;
  }) => Promise<unknown>;
  readonly now?: () => number;
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface LocalOperatorInvokeRequest {
  readonly entry: string;
  readonly service: string;
  readonly toolId: string;
  readonly args: unknown;
}

export type LocalOperatorInvokeResult =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: "no_grant" | "identity_invalid" };

/**
 * I19 — local-operator single-tool variant of the team-vault gate (Wave 7c writes). The local owner
 * runs ONE team-credentialed tool (a warehouse/BI write) after clearing the executor I2 HITL gate
 * upstream. Unlike `answerFederatedInvoke`, no `isWriteForbiddenToolId` confinement applies — write
 * tool ids ARE allowed here (this is the sanctioned local write path). Identity failures return a
 * DISTINCT `identity_invalid` (no cross-principal leak on the owner's own machine).
 */
export async function answerLocalOperatorInvoke(
  ctx: LocalOperatorInvokeCtx,
  req: LocalOperatorInvokeRequest,
): Promise<LocalOperatorInvokeResult> {
  const ts = (ctx.now ?? Date.now)();
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    appendTeamVaultAudit(ctx.db, {
      principal: { kind: "localOperator" },
      entry: req.entry,
      toolId: req.toolId,
      decision: "identity_invalid",
      timestamp: ts,
    });
    return { kind: "error", error: "identity_invalid" };
  }
  const entryDef = ctx.store.getEntry(req.entry);
  if (entryDef === undefined || entryDef.service !== req.service) {
    appendTeamVaultAudit(ctx.db, {
      principal: { kind: "localOperator" },
      entry: req.entry,
      toolId: req.toolId,
      decision: "no_grant",
      timestamp: ts,
    });
    return { kind: "error", error: "no_grant" };
  }
  const result = await ctx.runTool({
    entry: req.entry,
    service: req.service,
    toolId: req.toolId,
    args: req.args,
  });
  appendTeamVaultAudit(ctx.db, {
    principal: { kind: "localOperator" },
    entry: req.entry,
    toolId: req.toolId,
    decision: "answered",
    timestamp: ts,
  });
  return { kind: "ok", result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/federation/invoke-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-audit.ts packages/gateway/src/federation/invoke-gate.ts packages/gateway/src/federation/invoke-gate.test.ts
git commit -m "feat(7c): answerLocalOperatorInvoke + I26 federated write-id rejection"
```

---

## Task 4: `warehouse-write-transport.ts` (`invokeConnectorWrite`, personal + team)

**Files:**

- Create: `packages/gateway/src/connectors/warehouse-write-transport.ts`
- Test: `packages/gateway/src/connectors/warehouse-write-transport.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/connectors/warehouse-write-transport.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  __setPersonalInvokeForTest,
  invokeConnectorWrite,
  type WarehouseWriteContext,
} from "./warehouse-write-transport.ts";

afterEach(() => __setPersonalInvokeForTest(undefined));

function ctx(over: Partial<WarehouseWriteContext>): WarehouseWriteContext {
  return {
    vault: {} as never,
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" }),
    runTeamInvoke: async () => ({ team: true }),
    ...over,
  };
}

describe("invokeConnectorWrite", () => {
  test("personal path calls the injected personal invoke", async () => {
    let seen: { service: string; toolId: string; args: unknown } | undefined;
    __setPersonalInvokeForTest(async (_c, service, toolId, args) => {
      seen = { service, toolId, args };
      return { personal: true };
    });
    const out = await invokeConnectorWrite(ctx({}), {
      service: "tableau",
      writeToolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
    expect(out).toEqual({ personal: true });
    expect(seen).toEqual({
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
  });

  test("team path routes through runTeamInvoke with the configured entry", async () => {
    let seen: unknown;
    const out = await invokeConnectorWrite(
      ctx({
        credentialFor: () => ({ credential: "team", teamEntry: "wh" }),
        runTeamInvoke: async (req) => {
          seen = req;
          return { team: true };
        },
      }),
      { service: "powerbi", writeToolId: "powerbi_dataset_refresh", args: { groupId: "g" } },
    );
    expect(out).toEqual({ team: true });
    expect(seen).toEqual({
      entry: "wh",
      service: "powerbi",
      toolId: "powerbi_dataset_refresh",
      args: { groupId: "g" },
    });
  });

  test("team credential without a team_entry fails closed", async () => {
    await expect(
      invokeConnectorWrite(ctx({ credentialFor: () => ({ credential: "team" }) }), {
        service: "powerbi",
        writeToolId: "powerbi_dataset_refresh",
        args: {},
      }),
    ).rejects.toThrow(/team_entry/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/warehouse-write-transport.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (mirrors `warehouse-sync-transport.ts`)

```typescript
// packages/gateway/src/connectors/warehouse-write-transport.ts
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

export interface WarehouseWriteContext {
  readonly vault: NimbusVault;
  readonly sandboxCwd: string;
  /** Per-connector credential selection from [connectors.<name>]; defaults to personal. */
  readonly credentialFor: (service: string) => {
    credential: "personal" | "team";
    teamEntry?: string;
  };
  /** Gate-routed localOperator team invoke (I19); returns the tool result or throws. */
  readonly runTeamInvoke: (req: {
    entry: string;
    service: string;
    toolId: string;
    args: unknown;
  }) => Promise<unknown>;
}

type PersonalInvoke = (
  ctx: WarehouseWriteContext,
  service: string,
  writeToolId: string,
  args: unknown,
) => Promise<unknown>;

const realPersonalInvoke: PersonalInvoke = (ctx, service, writeToolId, args) =>
  withConnectorSession(
    {
      service,
      vaultView: createServiceScopedVaultView(ctx.vault, service),
      sandboxCwd: ctx.sandboxCwd,
    },
    (session) => session.call(writeToolId, args),
  );

let personalInvokeOverride: PersonalInvoke | undefined;

/** TEST-ONLY DI seam (avoids spawning a real subprocess). */
export function __setPersonalInvokeForTest(fn: PersonalInvoke | undefined): void {
  personalInvokeOverride = fn;
}

/**
 * Run a warehouse/BI write tool with the connector's configured credential. Mirrors
 * {@link listConnectorItems}: personal → spawn once with a service-scoped vault view and call the
 * write tool; team → the I19 localOperator invoke gate. The HITL (I2) check is upstream in the
 * executor — this transport is reached only after `gate()` returns "proceed".
 */
export async function invokeConnectorWrite(
  ctx: WarehouseWriteContext,
  req: { service: string; writeToolId: string; args: unknown },
): Promise<unknown> {
  const cfg = ctx.credentialFor(req.service);
  if (cfg.credential === "team") {
    if (cfg.teamEntry === undefined || cfg.teamEntry === "") {
      throw new Error(`connectors.${req.service}: credential = "team" requires a team_entry`);
    }
    return ctx.runTeamInvoke({
      entry: cfg.teamEntry,
      service: req.service,
      toolId: req.writeToolId,
      args: req.args,
    });
  }
  return (personalInvokeOverride ?? realPersonalInvoke)(ctx, req.service, req.writeToolId, req.args);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/warehouse-write-transport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/warehouse-write-transport.ts packages/gateway/src/connectors/warehouse-write-transport.test.ts
git commit -m "feat(7c): warehouse write transport (personal + team via withConnectorSession)"
```

---

## Task 5: Dispatch decorator (`warehouse-write-dispatch.ts`)

**Files:**

- Modify: `packages/gateway/src/connectors/registry.ts` (export `extractToolInput`)
- Create: `packages/gateway/src/connectors/warehouse-write-dispatch.ts`
- Test: `packages/gateway/src/connectors/warehouse-write-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/connectors/warehouse-write-dispatch.test.ts
import { describe, expect, test } from "bun:test";
import type { ConnectorDispatcher } from "../engine/types.ts";
import { createWarehouseWriteDispatcher } from "./warehouse-write-dispatch.ts";

describe("createWarehouseWriteDispatcher", () => {
  test("delegates non-warehouse actions to the inner dispatcher", async () => {
    let innerCalled = false;
    const inner: ConnectorDispatcher = {
      dispatch: async () => {
        innerCalled = true;
        return { inner: true };
      },
    };
    const d = createWarehouseWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: "/tmp",
      credentialFor: () => ({ credential: "personal" }),
      runTeamInvoke: async () => ({}),
    });
    const out = await d.dispatch({ type: "slack.message.post", payload: { mcpToolId: "x" } });
    expect(out).toEqual({ inner: true });
    expect(innerCalled).toBe(true);
  });

  test("routes a warehouse-write action to invokeConnectorWrite with extracted args", async () => {
    let seen: unknown;
    const inner: ConnectorDispatcher = { dispatch: async () => ({ inner: true }) };
    const d = createWarehouseWriteDispatcher(inner, {
      vault: {} as never,
      sandboxCwd: "/tmp",
      credentialFor: () => ({ credential: "team", teamEntry: "wh" }),
      runTeamInvoke: async (req) => {
        seen = req;
        return { ok: true };
      },
    });
    const out = await d.dispatch({
      type: "tableau.datasource.refresh",
      payload: { mcpToolId: "tableau_datasource_refresh", id: "ds-1" },
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual({
      entry: "wh",
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/warehouse-write-dispatch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3a: Export `extractToolInput` from `registry.ts`** — change `function extractToolInput` to `export function extractToolInput` (line 106).

- [ ] **Step 3b: Implement the decorator**

```typescript
// packages/gateway/src/connectors/warehouse-write-dispatch.ts
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { extractToolInput } from "./registry.ts";
import { warehouseWriteByActionType } from "./warehouse-write-tools.ts";
import {
  invokeConnectorWrite,
  type WarehouseWriteContext,
} from "./warehouse-write-transport.ts";

/**
 * Wraps the base connector dispatcher: a warehouse/BI write action.type is routed to the
 * credential-aware {@link invokeConnectorWrite} transport; everything else delegates to `inner`.
 * Installed in assemble.ts AROUND the executor's dispatcher, so the executor + registry stay generic.
 * Credential selection is config-driven via `deps.credentialFor` — never from the action payload.
 */
export function createWarehouseWriteDispatcher(
  inner: ConnectorDispatcher,
  deps: WarehouseWriteContext,
): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      const write = warehouseWriteByActionType(action.type);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/warehouse-write-dispatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/registry.ts packages/gateway/src/connectors/warehouse-write-dispatch.ts packages/gateway/src/connectors/warehouse-write-dispatch.test.ts
git commit -m "feat(7c): warehouse-write dispatch decorator (config-driven credential routing)"
```

---

## Task 6: I26 triple rule — federated wiring + static D20 + invariant test + docs

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts:465` (inject `isWriteForbiddenToolId`)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D20)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I26 describe block)
- Modify: `docs/SECURITY-INVARIANTS.md` (I26 row) + invariant-count prose laggards

> **All four land in ONE commit — the invariant triple rule (wiring + docs + test + static).**

- [ ] **Step 1: Write the failing tests**

(a) Static-check unit test — append to `scripts/structure-audit/check-nimbus-invariants.test.ts`
(grep for the existing `checkTribalKbWriteInvariant` test and mirror its shape):

```typescript
import { checkWarehouseWriteConfinement } from "./check-nimbus-invariants.ts";

describe("D20 — warehouse write-id confinement", () => {
  test("flags a write tool id referenced outside the allowed sites", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/ipc/some-handler.ts",
        contents: `dispatch("tableau_datasource_refresh")`,
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("D20-warehouse-write");
  });

  test("allows the SSoT, connector servers, and transport/dispatch sites", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/connectors/warehouse-write-tools.ts",
        contents: `"tableau_datasource_refresh"`,
      },
    ]);
    expect(v).toHaveLength(0);
  });

  test("requires answerFederatedInvoke to consult isWriteForbiddenToolId", () => {
    const v = checkWarehouseWriteConfinement([
      {
        relPath: "packages/gateway/src/federation/invoke-gate.ts",
        contents: `export async function answerFederatedInvoke() { return; }`,
      },
    ]);
    expect(v.some((x) => x.rule === "D20-invoke-gate-predicate")).toBe(true);
  });
});
```

(b) I26 runtime invariant — append a describe block to `security-invariants.test.ts`
(after the I25 block at line 859):

```typescript
describe("I26 — warehouse/BI writes are confined to the local I2 path; federated gate rejects them", () => {
  test("answerFederatedInvoke is wired with isWriteForbiddenToolId in federation-rpc.ts", async () => {
    const src = await Bun.file(
      new URL("./ipc/federation-rpc.ts", import.meta.url),
    ).text();
    expect(src).toContain("isWriteForbiddenToolId");
    expect(src).toContain("isWarehouseWriteToolId");
  });

  test("every warehouse write tool id is HITL-gated via its action type (local path)", () => {
    for (const w of WAREHOUSE_BI_WRITES) {
      expect(HITL_REQUIRED.has(w.actionType)).toBe(true);
    }
  });
});
```

(Add the imports `WAREHOUSE_BI_WRITES` from `./connectors/warehouse-write-tools.ts` and `HITL_REQUIRED`
from `./engine/executor.ts` at the top of `security-invariants.test.ts` if not present.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D20"`
Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I26"`
Expected: FAIL (`checkWarehouseWriteConfinement` undefined; `federation-rpc.ts` lacks the wiring).

- [ ] **Step 3a: Wire the predicate** in `federation-rpc.ts` — add the import at the top:

```typescript
import { isWarehouseWriteToolId } from "../connectors/warehouse-write-tools.ts";
```

and inside the `answerFederatedInvoke({ ... })` ctx (line ~476, alongside the `identity` spread):

```typescript
          isWriteForbiddenToolId: isWarehouseWriteToolId,
```

- [ ] **Step 3b: Add the D20 static check** in `check-nimbus-invariants.ts` (after `checkTribalKbWriteInvariant`, ~line 399):

```typescript
// D20 (I26): warehouse/BI write tool ids may be NAMED only in the SSoT, the connector servers, and
// the gateway transport/dispatch sites. Any other reference could route a write outside the local
// executor I2 gate. Also requires answerFederatedInvoke to consult the write-id predicate.
const WAREHOUSE_WRITE_ALLOWED = [
  "packages/gateway/src/connectors/warehouse-write-tools.ts",
  "packages/gateway/src/connectors/warehouse-write-transport.ts",
  "packages/gateway/src/connectors/warehouse-write-dispatch.ts",
  "packages/mcp-connectors/snowflake/src/server.ts",
  "packages/mcp-connectors/tableau/src/server.ts",
  "packages/mcp-connectors/looker/src/server.ts",
  "packages/mcp-connectors/powerbi/src/server.ts",
  "packages/mcp-connectors/monte-carlo/src/server.ts",
  "packages/mcp-connectors/bigeye/src/server.ts",
];
const WAREHOUSE_WRITE_RE =
  /\b(?:snowflake_tag_set|snowflake_comment_set|tableau_datasource_refresh|tableau_workbook_refresh|looker_datagroup_trigger|looker_schedule_run_once|powerbi_dataset_refresh|powerbi_dataflow_refresh|montecarlo_incident_acknowledge|montecarlo_incident_resolve|bigeye_issue_acknowledge|bigeye_issue_resolve)\b/;

export function checkWarehouseWriteConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // Predicate-presence check on the federated gate.
    if (f.relPath === "packages/gateway/src/federation/invoke-gate.ts") {
      if (!/isWriteForbiddenToolId/.test(stripComments(f.contents))) {
        out.push({
          rule: "D20-invoke-gate-predicate",
          file: f.relPath,
          line: 1,
          snippet: "answerFederatedInvoke must consult isWriteForbiddenToolId (I26)",
        });
      }
      continue;
    }
    if (WAREHOUSE_WRITE_ALLOWED.some((p) => f.relPath === p)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (WAREHOUSE_WRITE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D20-warehouse-write",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
```

Then register it in the runAll aggregation (after the `checkTribalKbWriteInvariant` block, ~line 530):

```typescript
    const vWh = checkWarehouseWriteConfinement(files);
    for (const e of vWh) {
      console.error(
        `::error file=${e.file},line=${e.line}::D20 warehouse write tool referenced/owired outside allowed sites — bypasses I26: ${e.snippet}`,
      );
    }
    violations.push(...vWh);
```

> Match the exact local variable name the file uses for the accumulator (grep the existing
> `violations.push(...` / `allViolations` near line 530 and mirror it).

- [ ] **Step 3c: Add the I26 docs.** In `docs/SECURITY-INVARIANTS.md`, add the I26 row mirroring the
  I25 row format:

```markdown
- **I26** — warehouse/BI write actions execute only behind the LOCAL owner's HITL gate (I2); the
  federated peer invoke gate (`answerFederatedInvoke`) fail-closed rejects any write-classified tool
  id via the injected `isWriteForbiddenToolId` predicate (`isWarehouseWriteToolId`), so a peer can
  never trigger a warehouse write. Write tool ids are confined to the SSoT + connector + transport/
  dispatch sites (static D20) · `federation/invoke-gate.ts`, `connectors/warehouse-write-tools.ts`
```

Then update the static-complement sentence in the same doc (the "Static complement:" paragraph)
to append `, D20` to the enforced-rule list, and bump the "invariants through I25" / "I1–I25"
prose. Update the same count prose in: `CLAUDE.md` (Security Invariants intro says "I1–I25" → "I1–I26"
— but DO NOT touch the status line), `GEMINI.md`, `docs/architecture.md`,
`docs/SECURITY-INVARIANTS.md` header, and any `nimbus-security-invariants` skill count. Run
`bun run audit:doc-refs` after.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test scripts/structure-audit/check-nimbus-invariants.test.ts
bun test packages/gateway/src/security-invariants.test.ts
bun run check:invariants   # or: bun scripts/structure-audit/check-nimbus-invariants.ts
```

Expected: PASS; the static check exits 0.

- [ ] **Step 5: Commit (triple rule, one commit)**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md docs/architecture.md CLAUDE.md GEMINI.md
git commit -m "feat(7c): I26/D20 — confine warehouse writes to local I2 path (wiring+docs+test+static)"
```

---

## Task 7: Audit identity-subject refinement (folded 7b deferral)

**Files:**

- Modify: `packages/gateway/src/teamvault/team-vault-audit.ts` (`identitySubject?`)
- Modify: `packages/gateway/src/federation/invoke-gate.ts` (thread subject at the three audit sites)
- Test: `packages/gateway/src/teamvault/team-vault-audit.test.ts`

- [ ] **Step 1: Write the failing test** (append to the audit test file; grep its existing read-back helper for the audit-chain row)

```typescript
test("identitySubject is serialized into federationJson when provided", () => {
  const db = createMemoryIndexDb();
  appendTeamVaultAudit(db, {
    principal: { kind: "localOperator" },
    entry: "wh",
    toolId: "tableau_datasource_refresh",
    decision: "answered",
    timestamp: 1,
    identitySubject: "alice@example.com",
  });
  const row = db.query("SELECT federation_json AS f FROM <audit_table> ORDER BY rowid DESC LIMIT 1").get() as { f: string };
  expect(JSON.parse(row.f).identity_subject).toBe("alice@example.com");
});

test("identitySubject is omitted when absent (no key)", () => {
  const db = createMemoryIndexDb();
  appendTeamVaultAudit(db, {
    principal: { kind: "localOperator" },
    entry: "wh",
    toolId: "tableau_list",
    decision: "answered",
    timestamp: 1,
  });
  const row = db.query("SELECT federation_json AS f FROM <audit_table> ORDER BY rowid DESC LIMIT 1").get() as { f: string };
  expect("identity_subject" in JSON.parse(row.f)).toBe(false);
});
```

> Replace `<audit_table>` with the real table name `appendAuditEntry` writes to (grep
> `appendAuditEntry` / the audit-chain schema; likely `audit_log`). If the audit file already has a
> read helper, use it instead of raw SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts`
Expected: FAIL (field not serialized).

- [ ] **Step 3: Implement** — add `identitySubject?: string` to `TeamVaultAuditFields` and serialize it:

```typescript
export interface TeamVaultAuditFields {
  readonly principal: AuditPrincipal;
  readonly entry: string;
  readonly toolId: string;
  readonly decision: TeamVaultDecision;
  readonly timestamp: number;
  readonly approvers?: readonly string[];
  /** Wave 7b deferral: resolved identity subject when identity is enabled; omitted otherwise so the
   *  tamper-evident trail never implies a verified identity that was not actually verified. */
  readonly identitySubject?: string;
}
```

In `appendTeamVaultAudit`, add to the `federationJson` object (conditional spread, so absent stays absent):

```typescript
    ...(f.identitySubject === undefined ? {} : { identity_subject: f.identitySubject }),
```

Then in `invoke-gate.ts`, at the `answerFederatedInvoke` "answered" audit and the two
`answerLocalOperator*` "answered" audits, pass `identitySubject` when identity is enabled and the
subject is resolvable. Add an optional `resolveIdentitySubject?: () => string | undefined` to each
gate ctx (`InvokeGateCtx`, `LocalOperatorListCtx`, `LocalOperatorInvokeCtx`) and spread:

```typescript
    ...(ctx.resolveIdentitySubject?.() === undefined
      ? {}
      : { identitySubject: ctx.resolveIdentitySubject() }),
```

(Add a focused test that when `resolveIdentitySubject` returns a value, the answered audit carries
it; when it returns undefined, the key is absent.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts packages/gateway/src/federation/invoke-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-audit.ts packages/gateway/src/teamvault/team-vault-audit.test.ts packages/gateway/src/federation/invoke-gate.ts packages/gateway/src/federation/invoke-gate.test.ts
git commit -m "feat(7c): audit identity-subject refinement (7b deferral; no migration)"
```

---

## Task 8: Wire the write dispatcher + team-invoke in `assemble.ts`

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts`

This task has no new unit test of its own (assemble.ts is a coverage-floor EXCLUSION — boot glue,
see `scripts/coverage-floor/exclusions.ts`). Correctness is covered by Tasks 4–6 + the per-connector
dispatch tests (Phase 1) + the existing e2e harness. Verify by `bun run typecheck` + the full suite.

- [ ] **Step 1: Build the local-operator invoke ctx + write deps** — near the Wave 7b block
  (after `teamCredentialExtras`, ~line 1208), add:

```typescript
  // Wave 7c — team-credentialed local WRITE invoke (I19 single-tool variant). Mirrors localOpListCtx
  // but uses invokeTeamTool (single call) + a one-shot session call.
  const localOpInvokeCtx: LocalOperatorInvokeCtx = {
    db,
    store: new TeamVaultStore(db),
    runTool: (input) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: paths.dataDir,
          requiredSecretKeysFor: (service: string) =>
            CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          spawnAndCall: (r) =>
            withConnectorSession(
              { service: r.service, vaultView: r.vaultView, sandboxCwd: r.sandboxCwd },
              (session) => session.call(r.toolId, r.args),
            ),
        },
        input,
      ),
    ...(identityEnabled
      ? {
          identity: {
            enabled: true,
            isOperatorValid: () => {
              const store = identityBootRef?.store;
              const issuer = identityBootRef?.issuer;
              if (store === undefined || issuer === undefined) return false;
              return isOperatorValid(store, issuer, Date.now(), identityBootRef?.graceSeconds ?? 0);
            },
          },
        }
      : {}),
  };

  const warehouseWriteDeps: WarehouseWriteContext = {
    vault,
    sandboxCwd: paths.dataDir,
    credentialFor: (service: string) =>
      connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" },
    runTeamInvoke: (req) =>
      answerLocalOperatorInvoke(localOpInvokeCtx, req).then((r) => {
        if (r.kind === "error") {
          throw new Error(`team-vault write (${req.service}/${req.toolId}): ${r.error}`);
        }
        return r.result;
      }),
  };
```

Add the imports at the top of `assemble.ts`:

```typescript
import {
  answerLocalOperatorInvoke,
  type LocalOperatorInvokeCtx,
} from "../federation/invoke-gate.ts";
import { invokeTeamTool } from "../teamvault/team-tool-invoke.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import { createWarehouseWriteDispatcher } from "../connectors/warehouse-write-dispatch.ts";
import type { WarehouseWriteContext } from "../connectors/warehouse-write-transport.ts";
```

- [ ] **Step 2: Wrap the executor's connector dispatcher** — find where the main `ToolExecutor` is
  constructed (line ~1102, `const executor = new ToolExecutor(`). The third constructor arg is the
  `ConnectorDispatcher`. Wrap whatever dispatcher is passed:

```typescript
  const baseConnectorDispatcher = /* the existing dispatcher expression passed today */;
  const connectorDispatcherWithWrites = createWarehouseWriteDispatcher(
    baseConnectorDispatcher,
    warehouseWriteDeps,
  );
  const executor = new ToolExecutor(
    consentChannel,
    auditSink,
    connectorDispatcherWithWrites,
    delegationDep,
  );
```

> Read lines 1095–1115 first to see the exact current dispatcher expression and constructor arg
> names; introduce the `baseConnectorDispatcher` local from that expression, then wrap it.

- [ ] **Step 3: Typecheck + full gateway suite**

```bash
bun run typecheck
bun test packages/gateway/src/connectors packages/gateway/src/federation packages/gateway/src/engine
```

Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(7c): wire warehouse-write dispatcher + team-invoke into assemble"
```

---

## Task 9: Cursor-shape contract test (folded 7b deferral)

**Files:**

- Create: `packages/gateway/src/connectors/warehouse-cursor-contract.test.ts`

This test pins the documented paged-response shapes the read transport drains, so a future connector
refactor that breaks the `{ items, nextCursor }` envelope is caught offline. (Live-API verification is
the manual checklist in the spec §7 — not automatable.)

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/warehouse-cursor-contract.test.ts
import { describe, expect, test } from "bun:test";
import { drainPagedList } from "./connector-list-page.ts";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";

function pagedSession(pages: { items: unknown[]; nextCursor: string | null }[]): ConnectorToolSession {
  return {
    call: (_toolId, args) => {
      const { cursor } = args as { cursor: string | null };
      const idx = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const page = pages[idx] ?? { items: [], nextCursor: null };
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(page) }] });
    },
  };
}

describe("warehouse paged-list cursor contract", () => {
  test("drains multiple pages and stops on nextCursor=null", async () => {
    const items = await drainPagedList(
      pagedSession([
        { items: [{ id: 1 }, { id: 2 }], nextCursor: "1" },
        { items: [{ id: 3 }], nextCursor: null },
      ]),
      "tableau_list",
    );
    expect(items).toHaveLength(3);
  });

  test("a single short page returns immediately", async () => {
    const items = await drainPagedList(
      pagedSession([{ items: [{ id: 1 }], nextCursor: null }]),
      "powerbi_list",
    );
    expect(items).toHaveLength(1);
  });

  test("an empty first page yields nothing", async () => {
    const items = await drainPagedList(
      pagedSession([{ items: [], nextCursor: null }]),
      "bigeye_list",
    );
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** — `bun test packages/gateway/src/connectors/warehouse-cursor-contract.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/connectors/warehouse-cursor-contract.test.ts
git commit -m "test(7c): warehouse paged-list cursor-shape contract (7b deferral)"
```

---

## Phase 1 — Per-connector write tools (one commit per connector, SEQUENTIAL)

**Shared pattern for every connector below.** In each `register<Svc>Tools(reg)` you ADD two `reg(...)`
write tools next to the existing read tools. Each write tool:

1. reuses the connector's EXISTING auth/base helpers (the `*_list` handler in the same file shows
   how it signs in / builds the base URL / reads env credentials — reuse those exact helpers);
2. validates its inputs with a Zod schema (required scoping ids);
3. issues the write request via `fetchWithTimeout`;
4. returns `jsonResult({ status: "queued" | "ok", ...ids })` — refresh writes return the job/run id
   with `status: "queued"`; synchronous writes return `status: "ok"`;
5. on a non-OK response, throws `new Error(\`<Svc> <op> ${res.status}: ${text.slice(0,400)}\`)` so
   provider privilege/rate-limit errors surface (review §5) through the I11 envelope upstream.

**Reference-pin step (every connector task, do FIRST):** read the connector's existing `src/server.ts`
read handlers + the vendor API doc, and confirm the exact endpoint/method/body below. Adjust to match
the real API before writing the handler (the #595 reference-impl lesson). The shapes below are the
starting point.

**Test pattern for every connector:** mirror `tableau/test/server-list-pagination.test.ts` —
`captureTools()` via the inline registrar, stub `globalThis.fetch` (handle the signin/auth call +
the write call), assert the request URL + method + body, and assert the returned `jsonResult`.

---

## Task 10: Snowflake writes (`snowflake_tag_set`, `snowflake_comment_set`)

**Files:**

- Modify: `packages/mcp-connectors/snowflake/src/server.ts`
- Modify: `packages/mcp-connectors/snowflake/nimbus.extension.json` (`hitlRequired`)
- Test: `packages/mcp-connectors/snowflake/test/server-writes.test.ts`

**API (pin against the existing `snowflake_list` SQL-REST handler):** `POST /api/v2/statements`
with `{ statement, timeout, database?, schema?, warehouse? }`. Snowflake DDL:

- tag set: `ALTER TABLE <obj> SET TAG <tag> = '<value>'` (or `UNSET TAG <tag>` when value omitted)
- comment set: `COMMENT ON TABLE <obj> IS '<comment>'`

**SECURITY — SQL injection guard (critical):** `<obj>` and `<tag>` are SQL IDENTIFIERS and MUST be
validated, not quoted. `<value>`/`<comment>` are string LITERALS and MUST be single-quote-escaped.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/mcp-connectors/snowflake/test/server-writes.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerSnowflakeTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerSnowflakeTools(<T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
    tools.set(n, h as Handler),
  );
  return tools;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("snowflake write tools", () => {
  const origFetch = globalThis.fetch;
  let bodies: unknown[] = [];
  beforeEach(() => {
    bodies = [];
    process.env["SNOWFLAKE_ACCOUNT"] = "acme";
    process.env["SNOWFLAKE_OAUTH_TOKEN"] = "tok";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ statementHandle: "h1" }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("snowflake_tag_set issues ALTER ... SET TAG with escaped literal", async () => {
    const tools = captureTools();
    const out = payload(
      await (tools.get("snowflake_tag_set") as Handler)({
        object: "DB.SCHEMA.T",
        tag: "GOVERNANCE.PII",
        value: "yes'no",
      }),
    );
    expect(out["status"]).toBe("ok");
    expect((bodies[0] as { statement: string }).statement).toContain("SET TAG");
    expect((bodies[0] as { statement: string }).statement).toContain("'yes''no'"); // doubled quote
  });

  it("rejects an unsafe identifier", async () => {
    const tools = captureTools();
    await expect(
      (tools.get("snowflake_comment_set") as Handler)({ object: "T; DROP TABLE x", comment: "c" }),
    ).rejects.toThrow(/identifier/i);
  });
});
```

- [ ] **Step 2: Run** → FAIL (tools not registered).

- [ ] **Step 3: Implement** — add to `registerSnowflakeTools`, reusing the existing `executeStatement`
  helper (the `snowflake_list` handler shows the exact POST/headers; reuse it):

```typescript
// identifier: dotted, each part [A-Za-z_][A-Za-z0-9_$]* or "quoted"
const SF_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;
function assertSfIdentifier(name: string, label: string): string {
  if (!SF_IDENT.test(name)) throw new Error(`unsafe Snowflake identifier for ${label}: ${name}`);
  return name;
}
function sfLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

reg(
  "snowflake_tag_set",
  "Set or unset a governance TAG on a table (requires HITL snowflake.tag.set). `ALTER TABLE <object> SET TAG <tag> = '<value>'`; omit `value` to UNSET.",
  z.object({
    object: z.string().min(1),
    tag: z.string().min(1),
    value: z.string().optional(),
  }),
  async (p) => {
    const obj = assertSfIdentifier(p.object, "object");
    const tag = assertSfIdentifier(p.tag, "tag");
    const statement =
      p.value === undefined
        ? `ALTER TABLE ${obj} UNSET TAG ${tag}`
        : `ALTER TABLE ${obj} SET TAG ${tag} = ${sfLiteral(p.value)}`;
    await executeStatement(statement); // reuse the existing POST /api/v2/statements helper
    return jsonResult({ status: "ok", object: obj, tag });
  },
);

reg(
  "snowflake_comment_set",
  "Set a COMMENT on a table (requires HITL snowflake.comment.set). `COMMENT ON TABLE <object> IS '<comment>'`.",
  z.object({ object: z.string().min(1), comment: z.string() }),
  async (p) => {
    const obj = assertSfIdentifier(p.object, "object");
    await executeStatement(`COMMENT ON TABLE ${obj} IS ${sfLiteral(p.comment)}`);
    return jsonResult({ status: "ok", object: obj });
  },
);
```

> If `snowflake_list` inlines the POST instead of exposing an `executeStatement` helper, extract that
> POST into a small `executeStatement(statement: string)` helper first (refactor; the list test still
> passes), then call it from both writes.

- [ ] **Step 4: Update the manifest** — `packages/mcp-connectors/snowflake/nimbus.extension.json`:
  set `"hitlRequired": ["write"]`.

- [ ] **Step 5: Add a gateway dispatch test** — `packages/gateway/src/connectors/warehouse-write-dispatch.test.ts`
  already covers routing generically; no per-connector gateway test needed beyond Task 5. Run the
  connector test:

Run: `bun test packages/mcp-connectors/snowflake/test/server-writes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/snowflake/
git commit -m "feat(7c): Snowflake tag.set + comment.set write tools (HITL, injection-guarded)"
```

---

## Task 11: Tableau writes (`tableau_datasource_refresh`, `tableau_workbook_refresh`) — EXEMPLAR

**Files:**

- Modify: `packages/mcp-connectors/tableau/src/server.ts`
- Modify: `packages/mcp-connectors/tableau/nimbus.extension.json`
- Test: `packages/mcp-connectors/tableau/test/server-writes.test.ts`

**API:** `POST ${base}/api/3.4/sites/${siteId}/datasources/${id}/refresh` (and `/workbooks/${id}/refresh`),
header `X-Tableau-Auth: <token>`, empty JSON body `{}`. Response `{ job: { id } }` → 202/200.
Reuse the existing `tableauSignin()` helper (returns `{ token, siteId }`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/mcp-connectors/tableau/test/server-writes.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerTableauTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;
function captureTools(): Map<string, Handler> {
  const t = new Map<string, Handler>();
  registerTableauTools(<T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
    t.set(n, h as Handler),
  );
  return t;
}
function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("tableau write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; method: string }[] = [];
  beforeEach(() => {
    calls = [];
    process.env["TABLEAU_URL"] = "https://tab.example.com";
    process.env["TABLEAU_PAT_NAME"] = "pat";
    process.env["TABLEAU_PAT_SECRET"] = "secret";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/signin")) {
        return new Response(JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }), { status: 200 });
      }
      calls.push({ url: u, method: String(init?.method) });
      return new Response(JSON.stringify({ job: { id: "job-9" } }), { status: 202 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("datasource refresh POSTs to the refresh endpoint and returns a queued job", async () => {
    const out = payload(await (captureTools().get("tableau_datasource_refresh") as Handler)({ id: "ds-1" }));
    expect(out).toEqual({ status: "queued", jobId: "job-9" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/sites/site-1/datasources/ds-1/refresh");
  });

  it("workbook refresh targets the workbooks endpoint", async () => {
    await (captureTools().get("tableau_workbook_refresh") as Handler)({ id: "wb-2" });
    expect(calls[0]?.url).toContain("/sites/site-1/workbooks/wb-2/refresh");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — add to `registerTableauTools`:

```typescript
async function tableauRefresh(kind: "datasources" | "workbooks", id: string): Promise<string> {
  const { token, siteId } = await tableauSignin();
  const base = apiBase();
  const res = await fetchWithTimeout(
    `${base}/api/3.4/sites/${encodeURIComponent(siteId)}/${kind}/${encodeURIComponent(id)}/refresh`,
    { method: "POST", headers: { "X-Tableau-Auth": token, Accept: "application/json", "Content-Type": "application/json" }, body: "{}" },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Tableau ${kind} refresh ${String(res.status)}: ${text.slice(0, 400)}`);
  const root = JSON.parse(text) as { job?: { id?: string } };
  return root.job?.id ?? "";
}

reg(
  "tableau_datasource_refresh",
  "Trigger an extract refresh for a published datasource (requires HITL tableau.datasource.refresh). Async — returns the job id.",
  z.object({ id: z.string().min(1) }),
  async (p) => jsonResult({ status: "queued", jobId: await tableauRefresh("datasources", p.id) }),
);
reg(
  "tableau_workbook_refresh",
  "Trigger an extract refresh for a workbook (requires HITL tableau.workbook.refresh). Async — returns the job id.",
  z.object({ id: z.string().min(1) }),
  async (p) => jsonResult({ status: "queued", jobId: await tableauRefresh("workbooks", p.id) }),
);
```

- [ ] **Step 4: Manifest** — set `"hitlRequired": ["write"]`.

- [ ] **Step 5: Run** → `bun test packages/mcp-connectors/tableau/test/server-writes.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/tableau/
git commit -m "feat(7c): Tableau datasource/workbook refresh write tools (HITL)"
```

---

## Task 12: Looker writes (`looker_datagroup_trigger`, `looker_schedule_run_once`)

**Files:** `packages/mcp-connectors/looker/src/server.ts`, its `nimbus.extension.json`, `test/server-writes.test.ts`.

**API (pin against `looker_list` auth helper — Looker logs in with client_id/secret → access_token):**

- datagroup trigger (invalidate): `PATCH ${base}/api/4.0/datagroups/${datagroupId}` body `{ stale_before: <epochSeconds> }`
- schedule run once: `POST ${base}/api/4.0/scheduled_plans/${scheduledPlanId}/run_once` body `{}`
Header `Authorization: token <access_token>`.

- [ ] **Step 1: Failing test** — mirror Task 11's harness; assert:
  - `looker_datagroup_trigger({ datagroupId: "dg-1" })` → method `PATCH`, url contains `/datagroups/dg-1`, body has `stale_before`; returns `{ status: "ok", datagroupId: "dg-1" }`.
  - `looker_schedule_run_once({ scheduledPlanId: "sp-2" })` → method `POST`, url contains `/scheduled_plans/sp-2/run_once`; returns `{ status: "queued", scheduledPlanId: "sp-2" }`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — add two `reg(...)` tools reusing the existing Looker auth helper; schemas `z.object({ datagroupId: z.string().min(1) })` and `z.object({ scheduledPlanId: z.string().min(1) })`. Throw on non-OK with `Looker <op> ${res.status}: ...`. For `stale_before`, compute `Math.floor(Date.now() / 1000)`.
- [ ] **Step 4: Manifest** — `"hitlRequired": ["write"]`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `git add packages/mcp-connectors/looker/ && git commit -m "feat(7c): Looker datagroup.trigger + schedule.run_once write tools (HITL)"`

---

## Task 13: Power BI writes + `groupId` metadata extension

**Files:**

- Modify: `packages/mcp-connectors/powerbi/src/server.ts`, `nimbus.extension.json`, `test/server-writes.test.ts`
- Modify: `packages/gateway/src/connectors/powerbi-dashboard-mapping.ts` (+ its test) — index `groupId`

**API (pin against `powerbi_list`; Power BI uses an AAD bearer token):**

- dataset refresh: `POST ${base}/v1.0/myorg/groups/${groupId}/datasets/${datasetId}/refreshes` body `{ notifyOption: "NoNotification" }` → 202
- dataflow refresh: `POST ${base}/v1.0/myorg/groups/${groupId}/dataflows/${dataflowId}/refreshes` body `{ notifyOption: "NoNotification" }` → 202
Header `Authorization: Bearer <token>`.

- [ ] **Step 1a: Failing test for the mapper `groupId`** — append to `powerbi-dashboard-mapping.test.ts`:

```typescript
test("indexes groupId GUID when present", () => {
  const item = mapPowerBiReportToItem(
    { id: "r1", name: "Dash", workspace: "Finance", groupId: "11111111-2222-3333-4444-555555555555", datasetId: "d1" },
    { syncedAt: 1 },
  );
  expect(item?.metadata["groupId"]).toBe("11111111-2222-3333-4444-555555555555");
});
test("groupId defaults to null when absent", () => {
  const item = mapPowerBiReportToItem({ id: "r2", name: "D" }, { syncedAt: 1 });
  expect(item?.metadata["groupId"]).toBeNull();
});
```

- [ ] **Step 1b: Failing test for the two write tools** — mirror Task 11's harness; assert:
  - `powerbi_dataset_refresh({ groupId: "g1", datasetId: "d1" })` → POST, url contains `/groups/g1/datasets/d1/refreshes`, body `{ notifyOption: "NoNotification" }`; returns `{ status: "queued" }`.
  - `powerbi_dataflow_refresh({ groupId: "g1", dataflowId: "f1" })` → url contains `/groups/g1/dataflows/f1/refreshes`.

- [ ] **Step 2: Run** → FAIL (both).

- [ ] **Step 3a: Extend the mapper** — in `powerbi-dashboard-mapping.ts` after the `datasetId` line:

```typescript
  const groupId = stringField(r, "groupId") ?? null;
```

and add `groupId` to the returned `metadata`:

```typescript
    metadata: { upstreamDataModelKeys, workspace, datasetId, groupId },
```

- [ ] **Step 3b: Implement the two write tools** in `registerPowerBiTools`, reusing the existing AAD
  token helper; schemas `z.object({ groupId: z.string().min(1), datasetId: z.string().min(1) })` and
  `z.object({ groupId: z.string().min(1), dataflowId: z.string().min(1) })`; throw on non-OK; return
  `jsonResult({ status: "queued", groupId, datasetId|dataflowId })`.

- [ ] **Step 4: Manifest** — `"hitlRequired": ["write"]`.

- [ ] **Step 5: Run** → `bun test packages/mcp-connectors/powerbi/test/server-writes.test.ts packages/gateway/src/connectors/powerbi-dashboard-mapping.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/powerbi/ packages/gateway/src/connectors/powerbi-dashboard-mapping.ts packages/gateway/src/connectors/powerbi-dashboard-mapping.test.ts
git commit -m "feat(7c): Power BI dataset/dataflow refresh write tools + groupId metadata (HITL)"
```

---

## Task 14: Monte Carlo writes (`montecarlo_incident_acknowledge`, `montecarlo_incident_resolve`)

**Files:** `packages/mcp-connectors/monte-carlo/src/server.ts`, `nimbus.extension.json`, `test/server-writes.test.ts`.

**API (pin against `montecarlo_list`; MC is GraphQL `POST https://api.getmontecarlo.com/graphql`,
headers `x-mcd-id` / `x-mcd-token`):** a single mutation with a feedback/status enum:

```graphql
mutation($incidentId: UUID!, $feedback: IncidentFeedback!) {
  setIncidentFeedback(input: { incidentId: $incidentId, feedback: $feedback }) { success }
}
```

acknowledge → `feedback: "ACKNOWLEDGED"`; resolve → `feedback: "RESOLVED"`. **Verify the exact mutation
name + enum values against the MC GraphQL schema in the reference-pin step** (the connector's existing
GraphQL query shows the auth + POST shape).

- [ ] **Step 1: Failing test** — stub `globalThis.fetch` for the single GraphQL POST; assert the
  request body `variables.incidentId` + `variables.feedback` (`ACKNOWLEDGED` / `RESOLVED`) and that
  each tool returns `{ status: "ok", incidentId }`. Schema `z.object({ incidentId: z.string().min(1) })`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — one shared `setFeedback(incidentId, feedback)` helper reusing the
  existing GraphQL POST helper; two `reg(...)` wrappers. Throw on a GraphQL `errors` array or non-OK.
- [ ] **Step 4: Manifest** — `"hitlRequired": ["write"]`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `git add packages/mcp-connectors/monte-carlo/ && git commit -m "feat(7c): Monte Carlo incident acknowledge/resolve write tools (HITL)"`

---

## Task 15: Bigeye writes (`bigeye_issue_acknowledge`, `bigeye_issue_resolve`)

**Files:** `packages/mcp-connectors/bigeye/src/server.ts`, `nimbus.extension.json`, `test/server-writes.test.ts`.

**API (pin against `bigeye_list`; Bigeye REST, header `Authorization: apikey <key>` or workspace
token):** `POST ${base}/api/v1/issues` body `{ issueId: <id>, status: <STATUS> }` (the `updateIssue`
endpoint). acknowledge → `status: "ISSUE_STATUS_ACKNOWLEDGED"`; resolve → `status: "ISSUE_STATUS_CLOSED"`.
**Verify the exact endpoint + status enum in the reference-pin step.**

- [ ] **Step 1: Failing test** — stub fetch; assert the POST body `{ issueId, status }` (the two enum
  values) and the returned `{ status: "ok", issueId }`. Schema `z.object({ issueId: z.string().min(1) })`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — one shared `updateIssueStatus(issueId, status)` helper reusing the
  existing Bigeye auth/POST helper; two `reg(...)` wrappers; throw on non-OK.
- [ ] **Step 4: Manifest** — `"hitlRequired": ["write"]`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `git add packages/mcp-connectors/bigeye/ && git commit -m "feat(7c): Bigeye issue acknowledge/resolve write tools (HITL)"`

---

## Phase 2 — Ship-readiness

## Task 16: CHANGELOG, docs, full preflight, coverage-floor, review, push

**Files:**

- Modify: `docs/CHANGELOG.md` (Wave 7c entry — connector-docs-changelog convention; do NOT touch the
  CLAUDE.md/GEMINI.md status line)

- [ ] **Step 1: Add the CHANGELOG entry** under the current dated section:

```markdown
- **Phase 6 Slice 7 Wave 7c — HITL-gated warehouse/BI writes.** Twelve write actions (two per
  connector: Snowflake tag/comment, Tableau datasource/workbook refresh, Looker datagroup/schedule,
  Power BI dataset/dataflow refresh, Monte Carlo + Bigeye incident/issue acknowledge/resolve), each
  behind the local owner's HITL gate (I2). New invariant **I26/D20**: the federated peer invoke gate
  fail-closed rejects warehouse write tool ids — writes execute only locally. Reuses the Wave 7b
  spawn transport (personal + team credentials). Folds in the two 7b deferrals (audit identity-subject;
  cursor-shape contract test). No migration (V40); no new credentials.
```

- [ ] **Step 2: Markdown-lint the docs**

Run: `bunx markdownlint-cli2 "docs/CHANGELOG.md" "docs/SECURITY-INVARIANTS.md" "docs/superpowers/**/*.md"`
Fix any MD0xx errors (blank lines around fences/lists, fence languages).

- [ ] **Step 3: Doc-ref + readme audits**

```bash
bun run audit:doc-refs
~/.cargo/bin/lychee docs/SECURITY-INVARIANTS.md docs/CHANGELOG.md docs/superpowers/specs/2026-06-14-phase6-slice7-wave7c-hitl-writes-design.md
```

Expected: PASS.

- [ ] **Step 4: Full preflight (CI parity)**

```bash
bun run preflight
```

Expected: PASS (typecheck across all packages, biome, structure-audit incl. D20, full test suite,
drift tests). Fix anything red. If `@nimbus-dev/client` typecheck false-fails, run
`cd packages/client && bun run build` first (fresh-worktree gotcha).

- [ ] **Step 5: Coverage-floor Docker-Linux dry-run** (baseline is `{}` — every NEW file must be
  ≥80% line+branch). Use the validated Docker flow:

```bash
# from the worktree root, run the lcov build + check inside oven/bun:latest (the CI-authoritative env)
bash scripts/coverage-floor/build-lcov.sh    # or the documented Docker wrapper
bun scripts/coverage-floor/check.ts
```

Expected: no `coverage-floor: FAILED`. New files to watch: `warehouse-write-tools.ts`,
`warehouse-write-transport.ts`, `warehouse-write-dispatch.ts`, the 12 connector write tools, the
invoke-gate additions. If a connector write file is <80%, add the missing branch test (error path /
unsafe-identifier path); do NOT exclude.

- [ ] **Step 6: Whole-branch code review**

Run: `/code-review` (whole branch vs main). Triage findings (receiving-code-review skill).

- [ ] **Step 7: Push + open PR**

```bash
git push -u origin dev/asafgolombek/phase6-slice7-wave7c
gh pr create --title "feat(connectors): Phase 6 Slice 7 Wave 7c — HITL-gated warehouse/BI writes" --body "<summary + I26 note + test evidence>"
```

- [ ] **Step 8: Update the memory workstream file** with the PR number + any gotchas hit.

---

## Self-review notes (plan ↔ spec coverage)

- Spec §3 twelve writes → Tasks 10–15 (each names its two tools + API). ✓
- Spec §4.2 local flow / transport / `answerLocalOperatorInvoke` → Tasks 3, 4, 5, 8. ✓
- Spec §4.3 SSoT module → Task 1; HITL drift → Task 2. ✓
- Spec §4.4 I26 triple (wiring + docs + test + D20) → Task 6 (one commit). ✓
- Spec §4.5 audit identity-subject → Task 7; cursor contract → Task 9. ✓
- Spec §3 scoping-ids (Power BI groupId) → Task 13. ✓
- Spec review §1 confinement (no IPC/Tauri exposure) → enforced by D20 predicate check (Task 6) +
  the fact that `invokeConnectorWrite`/`answerLocalOperatorInvoke` are imported only by
  transport/dispatch/assemble (verify in Task 6 the D20 allow-list does not include ipc/ or
  src-tauri/). ✓
- Spec §6 ship-readiness → Task 16. ✓

**Type consistency check:** `WarehouseWriteContext` (Task 4) is the dep type used by Task 5 + Task 8;
`LocalOperatorInvokeCtx`/`answerLocalOperatorInvoke` (Task 3) used by Task 8; `isWarehouseWriteToolId`
(Task 1) used by Task 6 wiring + the D20 predicate; `extractToolInput` exported in Task 5 used by the
decorator. `runTeamInvoke` shape `{entry,service,toolId,args}` matches `LocalOperatorInvokeRequest`. ✓
