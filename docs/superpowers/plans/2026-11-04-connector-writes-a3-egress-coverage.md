# Connector Writes A3: Per-Write Egress and Federation Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A contract test proves three things for EVERY connector write: it prompts the owner, it appends exactly one egress row before dispatch (one `blocked` row on denial, nothing dispatched when the append fails), and a federated peer naming it is refused with a `write_forbidden` audit row and no egress row. Today the I29 block's ordering test exercises only `search.run` (a non-HITL read) and `email.send` (a generic frozen-set type): no row of `CONNECTOR_WRITE_ROWS` has egress-ordering coverage. After this PR the rows table drives it, so a write added later is covered the moment its row lands.

**Architecture:** Tests only, plus docs. No production code changes. The executor chokepoint (`engine/executor.ts`: `gate()` appends the egress entry that `egress/egress-record.ts` `buildEgressEntry` builds, with `destination = serviceOf(action.type)` via `summarizeDestination`; `execute()` calls `gate()` then `connectors.dispatch`) is exercised per row through its real code with a real SQLite egress ledger. The federated invoke gate (`federation/invoke-gate.ts` `answerFederatedInvoke`) is exercised per id with its real code; it has NO egress seam (its ctx has no sink), so the "no egress row" half of ruling E3 is a structural fact, pinned by a source assertion, not by an always-empty table.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, bun:sqlite.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` (branch `dev/asaf/connector-writes-spec`), § 5.5 and § 10 (A3).

## Global Constraints

- Branch from `origin/main`. This plan and the spec never land on `main`.
- No production code change. If a test exposes a real gap (a row that does not prompt, or appends no row, or is not refused), STOP and report it with the row; do not fix production code in this PR without the controller's ruling.
- The four gate-confined write tool ids (ChatOps posts, KB appends) are never spelled as literals outside their gates (D17/D19): reach them only through `CHATOPS_POST_TOOL_IDS` and `TRIBAL_KB_WRITE_TOOL_IDS`. Their ACTION TYPES (`slack.chat.post`, `teams.chat.post`, `notion.knowledge.write`, `confluence.knowledge.write`) may be spelled.
- Test data in fresh temp dirs or in-memory databases only; never the real install.
- No comparator-less `.sort()`. No `any`.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`.
- Do not compile the gateway; never a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings this plan makes

- **E1: The tests and their helpers live in `packages/gateway/src/security-invariants.test.ts`**, in the existing I29 block (`describe("I29 — egress-ledger completeness over the executor chokepoint", …)`) and the existing I26 block (`describe("I26 — every connector write row is confined to the local I2 path; federated gate rejects them", …)`), because the triple rule names that file as each invariant's enforcement test. The helpers are module-level functions in that test file, never a separate non-test `.ts` (the I4 scan treats any non-`.test.ts` file under `src/` as production and flags `hitlStatus: "approved"`).
- **E2: The action under test is built the way each door builds it.** `mesh` row: `{ type: row.actionType, payload: { mcpToolId: row.toolId, input: {} } }`. `write` row: `{ type: row.actionType, payload: {} }`. Gate-confined writes: their four action types with `payload: {}`.
- **E3: The federated refusal stays audit-only** (spec § 5.5, owner-listed call): `answerFederatedInvoke` refuses with `{ kind: "error", error: "no_grant" }`, audits `write_forbidden`, and appends NO egress row. The roadmap's Phase 9.7 acceptance criterion ("… and a `blocked` ledger row") is reworded in this PR to "no dispatch, and a `write_forbidden` audit row; nothing leaves the machine, so no egress row".

## Review Focus

1. **A row whose action type is not in the frozen set** would dispatch with `hitlStatus: "not_required"` — the test asserts the consent channel was asked exactly once per row, so it fails.
2. **A dispatcher that runs before the append** — the recording dispatcher reads the ledger's row count at dispatch time and asserts 1.
3. **The namespaced id a federated session executes** (`<server>_<tool>`) — refused too.
4. **A future row** — the loops iterate `CONNECTOR_WRITE_ROWS`, and a size assertion (`88`) makes an emptied table fail rather than pass vacuously.
5. **An egress row for a federated refusal** — asserted absent, against a real ledger.

---

### Task 1: The per-write coverage tests

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts` (module-level helpers, the I29 and I26 blocks)

**Interfaces:**
- Module-level helpers in `security-invariants.test.ts`:
  ```ts
  interface WriteUnderTest { readonly label: string; readonly action: PlannedAction }
  /** Every row (rule E2), label = row.toolId; plus the four gate-confined action types, label = actionType. */
  function writesUnderTest(): readonly WriteUnderTest[];
  /** As egress-ledger.test.ts does: new Database(":memory:") + runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION). */
  function freshEgressDb(): Database;
  function egressRows(db: Database): Array<{ resultStatus: string; destination: string; hitlStatus: string }>;
  // SELECT result_status AS resultStatus, destination, hitl_status AS hitlStatus FROM egress_ledger ORDER BY id
  ```
  Check the actual `egress_ledger` column names in the migration before writing the query.

- [ ] **Step 1: Write the tests** in the I29 block:
  - `"every connector write prompts the owner and appends exactly one egress row BEFORE dispatch"`: for each `writesUnderTest()` entry, a fresh DB, `makeEgressSink(db)`, an approving consent channel that counts calls, and a dispatcher that records `egressRows(db).length` when called. After `execute(action)`: consent calls `1`; dispatch calls `1`; the count seen at dispatch `1`; the row's `resultStatus` `"authorized"`, `hitlStatus` `"approved"`, `destination` equal to `serviceOf(action.type)` (what `buildEgressEntry` writes). Collect failures as `"<label>: <what>"` strings and assert the list is `[]`, so one failing row names itself.
  - `"a denied write appends one blocked row and dispatches nothing"`: denying channel → exactly one row, `blocked`; dispatch calls `0`; result status `rejected`.
  - `"a failed append dispatches nothing"`: a sink whose `append` throws → `execute` rejects; dispatch calls `0`.
  - `"the coverage set is the whole table"`: `writesUnderTest().length === CONNECTOR_WRITE_ROWS.length + 4` and `CONNECTOR_WRITE_ROWS.length === 88`.
- [ ] **Step 2: Write the tests** in the I26 block:
  - `"a federated peer naming any write is refused and audited write_forbidden"`: for every row id, its `${serviceOf(row.actionType)}_${row.toolId}` form, and every id in the two gate-confined sets, call `answerFederatedInvoke` with a ctx built like the fixture in `federation/invoke-gate.test.ts`, wired with `isWriteForbiddenToolId: isConnectorWriteToolId`, and whose store GRANTS that exact tool id to the peer (so the write refusal is the only barrier: without it the gate would reach `runTool`). Its `runTool` (and any connector hook) records calls. Per id assert: the result is `{ kind: "error", error: "no_grant" }`; `runTool` was never called; and the newest `audit_log` row has `action_type === "teamvault.invoke.write_forbidden"` (count those rows and assert the count rises by exactly 1 per id). Collect failures as above.
  - `"the federated invoke gate has no egress seam, so a refused write appends no egress row"`: read `federation/invoke-gate.ts` source and assert it contains no `egress` identifier (`/\begress/i` absent outside comments, using the file's existing comment-stripping helper if one is used nearby). This pins ruling E3 structurally.
- [ ] **Step 3: Red-prove each test** by a temporary local mutation, then revert: (a) remove one action type from `HITL_REQUIRED_BACKING` → the prompt test names it; (b) temporarily change `ToolExecutor.execute` in `engine/executor.ts` to call `this.connectors.dispatch(action)` BEFORE `await this.gate(action)` → the before-dispatch test fails (the count seen at dispatch is 0); (c) wire the test ctx's `isWriteForbiddenToolId` to return false for one id → that id reaches the granted `runTool`, and the federation test names it. Record the three in the report. Do not commit the mutations.
- [ ] **Step 4: Run** `bun test packages/gateway/src/security-invariants.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `test(security): every connector write is gated, ledgered before dispatch, and refused over federation`.

### Task 2: Docs

**Files:** `docs/SECURITY-INVARIANTS.md` (I29 and I26 test lists), `docs/roadmap.md` (Phase 9.7 Wave 1 row "Egress-ledger coverage proof" ticked; the Phase 9.7 acceptance criterion reworded per ruling E3; the S4 progress line: A3 ✅), `docs/architecture.md` (the egress section: per-write coverage), `docs/CHANGELOG.md` (new top entry), `CLAUDE.md` and `GEMINI.md` (S4 progress, identical), `docs/README.md` (if it carries the S4 progress). `docs/cli-reference.md` is read, not edited: there is no CLI change; say so in the report.

- [ ] **Step 1:** Update each, re-deriving counts (88 rows + 4 gate-confined).
- [ ] **Step 2: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests`. Expected: pass. Scan edited files for literal invisible characters.
- [ ] **Step 3: Commit.** Message: `docs: per-write egress and federation coverage`.

## PR

- Title: `test(security): every connector write is gated, ledgered and refused over federation`. Not breaking.
- Body: what is now proven per write, ruling E3 and the acceptance-criterion rewording, the red-proofs, attribution lines. No unbalanced `(`.
- Auto-merge; resolve every review thread.
