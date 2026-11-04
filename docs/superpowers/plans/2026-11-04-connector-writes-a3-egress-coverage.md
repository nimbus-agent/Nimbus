# Connector Writes A3: Per-Write Egress and Federation Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A contract test proves three things for EVERY connector write: it prompts the owner, it appends exactly one egress row before dispatch (one `blocked` row on denial, nothing dispatched when the append fails), and a federated peer naming it is refused with a `write_forbidden` audit row and no egress row. Today one test covers two sample action types (`security-invariants.test.ts` I29 block); after this PR the rows table drives it, so a write added later is covered the moment its row lands.

**Architecture:** Tests only, plus docs. No production code changes. The executor chokepoint (`engine/executor.ts` `gate()` / `execute()`) and the federated invoke gate (`federation/invoke-gate.ts` `answerFederatedInvoke`) are exercised per row through their real code with a real SQLite egress ledger.

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

- **E1: The tests live in `packages/gateway/src/security-invariants.test.ts`**, in the existing I29 block (`describe("I29 — egress-ledger completeness over the executor chokepoint"`) and the existing I26 block (`describe("I26 — every connector write row is confined …"`), because the triple rule names that file as each invariant's enforcement test (a CodeRabbit finding on #1884 asked for exactly this). Shared fixture code goes in `packages/gateway/src/connectors/connector-writes/testing/write-coverage-fixtures.ts` (a `testing/` helper, never imported by runtime code).
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
- Create: `packages/gateway/src/connectors/connector-writes/testing/write-coverage-fixtures.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts` (I29 and I26 blocks)

**Interfaces:**
- Produces, in `write-coverage-fixtures.ts`:
  ```ts
  export interface WriteUnderTest { readonly label: string; readonly action: PlannedAction }
  /** Every row (rule E2) plus the four gate-confined action types; label = toolId or actionType. */
  export function writesUnderTest(): readonly WriteUnderTest[];
  /** A fresh in-memory DB with the egress_ledger schema applied, the way egress-ledger.test.ts builds one. */
  export function freshEgressDb(): Database;
  export function egressRows(db: Database): Array<{ resultStatus: string; destination: string; hitlStatus: string }>;
  ```
  Read `packages/gateway/src/egress/egress-ledger.test.ts` for how a test DB gets the `egress_ledger` table (reuse that helper or migration path; never hand-write the schema).

- [ ] **Step 1: Write the tests** in the I29 block:
  - `"every connector write prompts the owner and appends exactly one egress row BEFORE dispatch"`: for each `writesUnderTest()` entry, a fresh DB, `makeEgressSink(db)`, an approving consent channel that counts calls, and a dispatcher that records `egressRows(db).length` when called. After `execute(action)`: consent calls `1`; dispatch calls `1`; the count seen at dispatch `1`; the row's `resultStatus` `"authorized"`, `hitlStatus` `"approved"`, `destination` equal to what the executor derives (`serviceOf(action.type)`). Collect failures as `"<label>: <what>"` strings and assert the list is `[]`, so one failing row names itself.
  - `"a denied write appends one blocked row and dispatches nothing"`: denying channel → exactly one row, `blocked`; dispatch calls `0`; result status `rejected`.
  - `"a failed append dispatches nothing"`: a sink whose `append` throws → `execute` rejects; dispatch calls `0`.
  - `"the coverage set is the whole table"`: `writesUnderTest().length === CONNECTOR_WRITE_ROWS.length + 4` and `CONNECTOR_WRITE_ROWS.length === 88`.
- [ ] **Step 2: Write the tests** in the I26 block:
  - `"a federated peer naming any write is refused, audited write_forbidden, and appends no egress row"`: for every row id, its `${serviceOf(row.actionType)}_${row.toolId}` form, and every id in the two gate-confined sets, call `answerFederatedInvoke` with a minimal ctx wired with `isWriteForbiddenToolId: isConnectorWriteToolId` (take the ctx fixture from `federation/invoke-gate.test.ts`; its run/connector hooks must record any call). Assert `{ kind: "error", error: "no_grant" }`, exactly one audit decision `write_forbidden`, no run/dispatch hook called, and — with a real egress DB available to the ctx if the gate has an egress seam, or by asserting the gate has none — zero egress rows. Collect failures as above.
- [ ] **Step 3: Red-prove each test** by a temporary local mutation, then revert: (a) remove one action type from `HITL_REQUIRED_BACKING` → the prompt test names it; (b) swap the order of `this.egressSink.append` and dispatch in a scratch copy of `execute` → the before-dispatch test fails; (c) make `isWriteForbiddenToolId` return false for one id → the federation test names it. Record the three in the report. Do not commit the mutations.
- [ ] **Step 4: Run** `bun test packages/gateway/src/security-invariants.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `test(security): every connector write is gated, ledgered before dispatch, and refused over federation`.

### Task 2: Docs

**Files:** `docs/SECURITY-INVARIANTS.md` (I29 and I26 test lists), `docs/roadmap.md` (Phase 9.7 Wave 1 row "Egress-ledger coverage proof" ticked; the Phase 9.7 acceptance criterion reworded per ruling E3; the S4 progress line: A3 ✅), `docs/architecture.md` (the egress section: per-write coverage), `docs/CHANGELOG.md` (new top entry), `CLAUDE.md` and `GEMINI.md` (S4 progress, identical), `docs/README.md` (if it carries the S4 progress), `docs/cli-reference.md` (no CLI change — say so in the report).

- [ ] **Step 1:** Update each, re-deriving counts (88 rows + 4 gate-confined).
- [ ] **Step 2: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests`. Expected: pass. Scan edited files for literal invisible characters.
- [ ] **Step 3: Commit.** Message: `docs: per-write egress and federation coverage`.

## PR

- Title: `test(security): every connector write is gated, ledgered and refused over federation`. Not breaking.
- Body: what is now proven per write, ruling E3 and the acceptance-criterion rewording, the red-proofs, attribution lines. No unbalanced `(`.
- Auto-merge; resolve every review thread.
