# Implementation Plan Review: `nimbus explain last`

**Target Plan:** [`2026-09-14-nimbus-explain-last.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/explain-last/docs/superpowers/plans/2026-09-14-nimbus-explain-last.md)  
**Target Spec:** [`2026-09-14-nimbus-explain-last-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/explain-last/docs/superpowers/specs/2026-09-14-nimbus-explain-last-design.md)  
**Review Date:** 2026-09-14  
**Review Status:** Detailed analysis of tasks, concrete code/import corrections, type invariants, test fixtures, and execution safeguards.

---

## 1. Executive Summary

The implementation plan [`2026-09-14-nimbus-explain-last.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/explain-last/docs/superpowers/plans/2026-09-14-nimbus-explain-last.md) is thorough, well-sequenced, and rigorously organized into 9 TDD tasks. It directly addresses the core architectural requirements: threading score components, classifying candidate outcomes, in-process tool collection, wrapping `runAsk`, registering `ask.explainLast` in diagnostics RPC, forbidding the `"ask"` namespace over LAN, and building clean CLI renderers.

This review identifies several **concrete compile-time errors, broken test fixtures, incorrect module import paths, and property name mismatches** in the plan's proposed code blocks that would block implementation if followed verbatim, along with recommendations to make the plan 100% executable.

---

## 2. Critical Code & Import Corrections

### 2.1 Non-Existent Method in Test Seed Fixtures (Tasks 1 & 4)
- **Problem in Plan:** Task 1 Step 1 and Task 4 Step 1 define `seed()` and `seedMany()` calling `idx.upsertIndexedItem(...)`:
  ```ts
  const db = new Database(":memory:");
  const idx = new LocalIndex(db);
  idx.migrate();
  idx.upsertIndexedItem({ ... }); // ❌ TypeError: idx.upsertIndexedItem is not a function
  ```
- **Codebase Reality:** `LocalIndex` has no `upsertIndexedItem` instance method. In Nimbus, item upserts are performed via the standalone helper function `upsertIndexedItem(db, item)` in `packages/gateway/src/index/item-store.ts`.
- **Required Fix:** Update test helpers in Tasks 1 and 4 to import and use `upsertIndexedItem`:
  ```ts
  import { upsertIndexedItem } from "./item-store.ts";
  // ...
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/api#1",
    title: "rate limiting for the api",
    bodyPreview: "add a redis rate limiter",
    modifiedAt: Date.now(),
  });
  ```

---

### 2.2 Broken Import Path for `redactAuditPayload` (Task 5)
- **Problem in Plan (Task 5 Step 4):**
  ```ts
  import { redactAuditPayload } from "../db/redact-audit-payload.ts"; // ❌ Module not found
  ```
- **Codebase Reality:** `../db/redact-audit-payload.ts` does not exist. `redactAuditPayload` is defined in `packages/gateway/src/audit/format-audit-payload.ts`, and is **already imported** at line 8 of `packages/gateway/src/engine/agent.ts`:
  ```ts
  import { redactAuditPayload } from "../audit/format-audit-payload.ts";
  ```
- **Required Fix:** In Task 5 Step 4, do not add a duplicate/broken import; reuse the existing import from `../audit/format-audit-payload.ts`.

---

### 2.3 Property Name Mismatch: `RankedIndexItem` vs `LocalContextItem` (Task 4)
- **Problem in Plan (Task 4 Step 3):**
  The `toCandidate` helper and candidate pool loop in Task 4 Step 3 assume `RankedIndexItem` has `.sourceId` and `.title`:
  ```ts
  const toCandidate = (item: RankedIndexItem, pass: ContributingPass, inById: boolean): LocalCandidate => ({
    sourceId: item.sourceId, // ❌ RankedIndexItem has .indexPrimaryKey, NOT .sourceId
    service: item.service,
    indexedType: item.indexedType,
    title: item.title,       // ❌ RankedIndexItem has .name, NOT .title
    // ...
  });
  ```
  Furthermore, `byId.values()` stores `Omit<LocalContextItem, "rank">` (which has `.sourceId` and `.title`, but where `formatContextItem` **stripped** `score`, `matchScore`, `recencyComponent`, and `scoringFormula`).
  Meanwhile, `primary` stores `RankedIndexItem[]` (which has `.indexPrimaryKey`, `.name`, and all score fields, but **no** `.sourceId` or `.title`).
- **Consequence:** If executed as written in the plan:
  1. For items in `primary`, `item.sourceId` and `item.title` will be `undefined`.
  2. For items in `byId`, `item.score`, `item.matchScore`, `item.recencyComponent`, etc. will be `undefined`.
- **Required Fix:** Preserve the original `RankedIndexItem` mappings alongside `byId`. For example:
  ```ts
  // When adding ranked results:
  const rankedItemsById = new Map<string, RankedIndexItem>();
  const addRankedResults = (items: readonly RankedIndexItem[], pass: ContributingPass): void => {
    for (const item of items) {
      if (!byId.has(item.indexPrimaryKey)) {
        byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item));
        passById.set(item.indexPrimaryKey, pass);
        rankedItemsById.set(item.indexPrimaryKey, item);
      }
    }
  };

  // When building LocalCandidate:
  const toCandidateFromRanked = (item: RankedIndexItem, pass: ContributingPass, inById: boolean): LocalCandidate => ({
    sourceId: item.indexPrimaryKey,
    service: item.service,
    indexedType: item.indexedType,
    title: cleanContextText(item.name),
    ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }),
    ...(item.scoringFormula === undefined ? {} : {
      score: item.score,
      matchScore: item.matchScore,
      recencyComponent: item.recencyComponent,
      servicePriorityComponent: item.servicePriorityComponent,
      scoringFormula: item.scoringFormula,
    }),
    pass,
    outcome: classifyCandidateOutcome({
      sourceId: item.indexPrimaryKey,
      inById,
      byIdPosition: inById ? byIdOrder.indexOf(item.indexPrimaryKey) : -1,
      shownIds,
      limit,
    }),
  });

  const toCandidateFromContext = (item: Omit<LocalContextItem, "rank">, pass: ContributingPass): LocalCandidate => ({
    sourceId: item.sourceId,
    service: item.service,
    indexedType: item.indexedType,
    title: item.title,
    pass,
    outcome: classifyCandidateOutcome({
      sourceId: item.sourceId,
      inById: true,
      byIdPosition: byIdOrder.indexOf(item.sourceId),
      shownIds,
      limit,
    }),
  });
  ```

---

### 2.4 CLI Command Handler Signature in `packages/cli/src/index.ts` (Task 8)
- **Problem in Plan (Task 8 Step 4):**
  Task 8 defines `runExplain` taking `(client: IPCClient, args: string[])`:
  ```ts
  export async function runExplain(client: IPCClient, args: string[]): Promise<void>
  ```
  However, in `packages/cli/src/index.ts:92-94`, all top-level `COMMAND_HANDLERS` are typed as:
  ```ts
  type CommandHandler = (args: string[]) => Promise<void> | void;
  ```
- **Required Fix:** `runExplain` in `packages/cli/src/commands/explain.ts` should follow the standard CLI command signature:
  ```ts
  export async function runExplain(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub !== "last") {
      throw new Error("usage: nimbus explain last [--json]");
    }
    const paths = getCliPlatformPaths();
    const state = await readGatewayState(paths);
    if (state === undefined) {
      throw new Error("Gateway is not running. Start with: nimbus start");
    }
    const client = createIpcClient(state.socketPath, INTERACTIVE_RPC_TIMEOUT_MS);
    await client.connect();
    try {
      const res = await client.call<ExplainLastResult>("ask.explainLast", null);
      // ...
    } finally {
      await client.disconnect();
    }
  }
  ```
  (An overloaded helper `runExplainWithClient(client: IPCClient, args: string[])` can be exported for unit tests.)

---

## 3. Structural & Type Invariant Refinements

### 3.1 `modelRoute` in `BaseExplainRecord` for `empty_index` and Early Failures (Task 2)
- **Problem:** `BaseExplainRecord` makes `modelRoute: { provider: string; model: string; isLocal: boolean }` a **required** field.
- **Issue:** When an ask hits the `empty_index` route or fails during classification before model resolution, no LLM route was ever resolved. Requiring `modelRoute` forces the recorder to fabricate a dummy route (e.g. `{ provider: "none", model: "none", isLocal: true }`), violating the honesty principle.
- **Recommendation:** Make `modelRoute?: { provider: string; model: string; isLocal: boolean }` optional in `BaseExplainRecord`, or include it on the specific route types where a model was resolved.

### 3.2 Candidate Pool Construction for Fallback-Term & Quoted Passes (Task 4)
- **Detail:** When quoted searches or fallback terms run, they can return items that were not in the primary probe.
- **Verification:** Task 4 Step 3 correctly starts with `[...byId.entries()]` and then unions with items in `primary` that were not in `byId`. Ensure that `rankedItemsById` preserves the score components for items added via quoted or fallback passes.

### 3.3 E2E Test Fixture Helper Usage (Task 9)
- **Detail:** In Task 9 Step 1, the plan outlines an E2E test connecting over a real socket.
- **Recommendation:** Utilize the existing gateway runner fixture `join(import.meta.dir, "_fixtures", "gateway-runner.ts")` (as used in [`tail-stream.e2e.test.ts`](file:///C:/gitrep/Nimbus/packages/gateway/test/e2e/tail-stream.e2e.test.ts)), which handles cross-platform socket creation, Windows named pipes (`\\.\pipe\...`), and cleanup on exit.

---

## 4. Open Questions & Suggestions

1. **Format of Direct-SQL Candidates in CLI Table Output:**
   - In `explain-format.ts`, ensure that direct-SQL rows (from GitHub repo-slug lookups) display:
     `Score: n/a (direct query)` instead of `NaN` or `undefined`.
2. **Deterministic Sort Order in Candidate Pool:**
   - When rendering the candidate table in CLI output, specify whether candidates are sorted by contributing pass group, raw score descending, or insertion order. Grouping by contributing pass with items sorted by score within each group provides the most readable explanation.
3. **Type-Only File Exclusions:**
   - Remember that `packages/gateway/src/index/ranked-item.ts` and `packages/gateway/src/engine/ask-explain-types.ts` are exact-path-excluded from coverage floors. Keep them strictly type-only with zero runtime code.

---

## 5. Summary Checklist for Implementer

| Task | Component | Check / Verification |
|---|---|---|
| **T1** | `RankedIndexItem` | Use `upsertIndexedItem(db, ...)` from `./item-store.ts` in test fixture. |
| **T2** | `ask-explain-types.ts` | Keep strictly type-only. Make `modelRoute` optional on `BaseExplainRecord`. |
| **T3** | `ask-explain-outcome.ts` | Verify 4 outcome branches against insertion index and `shownIds`. |
| **T4** | `run-ask.ts` candidate pool | Use `indexPrimaryKey` and `name` for `RankedIndexItem`. Retain score components when items enter `byId`. |
| **T5** | `agent.ts` tool collection | Reuse `import { redactAuditPayload } from "../audit/format-audit-payload.ts"`. |
| **T6** | `runAsk` wrapper | Wrap `runAskInner` in `try...catch` ensuring `partial` captures failure stage and error. |
| **T7** | IPC & LAN Denylist | Add `"ask"` to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`. Add invariant test in `security-invariants.test.ts`. |
| **T8** | CLI command | Implement `runExplain(args: string[])` matching `CommandHandler` in `cli/src/index.ts`. |
| **T9** | E2E & Docs | Run against `gateway-runner.ts`. Update `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, and `GEMINI.md`. |
