# Review: S3 MCP Capture Sink — PR 2 Implementation Plan

> **Target Plan:** [`2026-10-13-mcp-capture-sink-pr2.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/s3-mcp-capture-sink/docs/superpowers/plans/2026-10-13-mcp-capture-sink-pr2.md)  
> **Review Date:** 2026-10-13  
> **Reviewer:** Antigravity  
> **Status:** Actionable recommendations ready for plan amendment and execution  

---

## Executive Summary

The PR 2 implementation plan (`2026-10-13-mcp-capture-sink-pr2.md`) is extraordinarily comprehensive, covering Tasks 1 through 15 across 2,709 lines with meticulous attention to detail, strict TDD sequences, and robust SQLite schema migrations (V68 table rebuild with FK cascade mitigation).

Cross-referencing the plan against the live codebase (`dev/asaf/s3-mcp-capture-sink-pr2` at `51662dc0`) revealed **5 critical defects** that will cause immediate test or build failures if executed as written, along with **4 code snippet refinements** and **4 strategic product/architectural questions**.

Addressing these findings prior to or during subagent task execution will ensure uninterrupted progress and prevent subtle data integrity bugs.

---

## 1. Critical Plan Defects (Will Break Tests/Build if Uncorrected)

### 1.1 `security-invariants.test.ts:2626` Assertion Drift (Breaks Task 7 / CI)

* **Location in Plan:** Task 7 (`packages/gateway/src/mcp-sink/capture-gate.ts`)
* **Location in Code:** [`packages/gateway/src/security-invariants.test.ts:2626`](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts#L2617-L2634)
* **The Problem:**
  `security-invariants.test.ts` enforces the strict security check order in `submitCapture`:
  ```ts
  const order = [
    "deps.capability()",
    "CAPTURE_ROLE_BY_KIND[caller.kind]",
    "deps.limiter.tryAcquire(",
    "cap.kinds.includes(",
    "validateNotePayload(params", // <--- Line 2626
    "missingItem(",
    "deps.store.countCreatedSince(",
    "deps.db.transaction(",
  ];
  ```
  In Task 7 Step 3, `validateNotePayload(params["payload"])` in `capture-gate.ts` is replaced with `validateCapturePayload(kindRaw, params["payload"], now)`.
  As a result, `body.indexOf("validateNotePayload(params")` will return `-1`, causing `security-invariants.test.ts` to fail immediately.
  The plan did not list `security-invariants.test.ts` in Task 7 nor include this string update in Task 10.
* **Actionable Fix:**
  In Task 7 (or Task 10), update `packages/gateway/src/security-invariants.test.ts:2626` from:
  ```ts
  "validateNotePayload(params",
  ```
  to:
  ```ts
  "validateCapturePayload(",
  ```

---

### 1.2 `mcp-capture.e2e.test.ts` Gateway Config Omits Proposal Kinds (Breaks Task 14)

* **Location in Plan:** Task 14 (`packages/gateway/test/e2e/mcp-capture.e2e.test.ts`)
* **Location in Code:** [`packages/gateway/test/e2e/mcp-capture.e2e.test.ts:88-94`](file:///C:/gitrep/Nimbus/packages/gateway/test/e2e/mcp-capture.e2e.test.ts#L88-L94)
* **The Problem:**
  Task 14 Step 1 writes new E2E tests asserting that `mcp.toolNames()` contains `"propose_decision"`, `"propose_term"`, and `"propose_link"`.
  However, in `packages/gateway/test/e2e/mcp-capture.e2e.test.ts:91`, `bootGateway(enabled)` hardcodes:
  ```ts
  writeFileSync(
    join(gw.configDir, "nimbus.toml"),
    ["[mcp_sink]", `enabled = ${String(enabled)}`, 'kinds = ["note"]', "max_per_hour = 30"].join("\n"),
  );
  ```
  `captureToolsFor` queries the gateway for `capture.status`. When `kinds = ["note"]`, proposal tools are never registered on the MCP server! The test assertion `expect(names).toContain("propose_decision")` will fail on line 2561.
* **Actionable Fix:**
  Update Task 14 Step 1 to also update `bootGateway` (or parameterize kinds) in `mcp-capture.e2e.test.ts`:
  ```ts
  'kinds = ["note", "decision", "term", "link"]'
  ```

---

### 1.3 Stale Search Projection Leak When Agent Term Replaces LLM Term

* **Location in Plan:** Task 4 & Task 6 (`glossary-store.ts`, `capture-native.ts`)
* **Location in Code:** [`packages/gateway/src/glossary/glossary-project.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/glossary/glossary-project.ts#L71-L80), [`packages/gateway/src/glossary/glossary-reconcile.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/glossary/glossary-reconcile.ts)
* **The Problem:**
  - LLM-extracted glossary terms are projected into the `item` table as `nimbus:glossary_term` items via `projectTerm` in `glossary-project.ts`.
  - When an owner accepts a proposed term (`upsertAgentTerm` in Task 4 / `writeCaptureNative` in Task 6), `glossary_term` is updated with `provenance = 'agent'`.
  - `acceptCapture` also creates a new `nimbus:capture` item for the accepted capture.
  - Task 4 updates `glossary-reconcile.ts` so that reconcile skips `'agent'` rows (`if (existing.provenance === "agent") continue;`).
  - Because `reconcile` skips the row and `upsertAgentTerm` never calls `unprojectTerm(db, p.termKey)`, the old `nimbus:glossary_term` item remains in SQLite `item` table indefinitely!
  - **Impact:** Duplicate search results (one obsolete `nimbus:glossary_term` and one `nimbus:capture`), and a violation of the invariant that agent-authored glossary terms are NOT projected to `item` as regular glossary entries.
* **Actionable Fix:**
  In Task 6 (`writeCaptureNative`) or Task 4 (`upsertAgentTerm`), import and call `unprojectTerm(db, p.termKey)` whenever an agent term is written:
  ```ts
  unprojectTerm(db, v.payload.termKey);
  ```

---

### 1.4 Pass State Clearing Omission in `--rebuild` (`clearDecisions` & `clearGlossary`)

* **Location in Plan:** Task 3 (line 987) & Task 4 (line 1202)
* **Location in Code:** [`packages/gateway/src/decisions/decision-store.ts:346-352`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-store.ts#L346-L352), [`packages/gateway/src/glossary/glossary-store.ts:552-555`](file:///C:/gitrep/Nimbus/packages/gateway/src/glossary/glossary-store.ts#L552-L555)
* **The Problem:**
  - Existing `clearDecisions` in `decision-store.ts` runs:
    ```ts
    dbRun(db, "DELETE FROM decision_evidence", []);
    dbRun(db, "DELETE FROM decision_record", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
    ```
  - Task 3 line 990 provides a snippet showing only:
    ```ts
    dbRun(db, `DELETE FROM decision_evidence WHERE decision_id NOT IN (SELECT id FROM decision_record WHERE extraction_source = 'agent')`, []);
    dbRun(db, "DELETE FROM decision_record WHERE extraction_source IS NOT 'agent'", []);
    ```
    (omitting `DELETE FROM decision_pass_state`).
  - Similarly, Task 4 line 1202 states: "`clearGlossary` becomes `DELETE FROM glossary_term WHERE definition_source IS NOT 'agent'`", omitting `DELETE FROM glossary_pass_state`.
  - If `decision_pass_state` and `glossary_pass_state` are not cleared during `--rebuild`, extraction watermarks will not reset, and historical items will not be re-scanned.
* **Actionable Fix:**
  Ensure both pass state deletions are explicitly preserved in the plan snippets:
  - In `clearDecisions`: keep `dbRun(db, "DELETE FROM decision_pass_state", []);`.
  - In `clearGlossary`: keep `dbRun(db, "DELETE FROM glossary_pass_state", []);`.

---

### 1.5 Non-Existent `REJECTED_RETENTION_MS` Constant in PR 1

* **Location in Plan:** Task 8 (line 1913) & Task 9 (line 2021)
* **Location in Code:** [`packages/gateway/src/platform/assemble.ts:3443`](file:///C:/gitrep/Nimbus/packages/gateway/src/platform/assemble.ts#L3443)
* **The Problem:**
  Task 8 states:
  > *"Find PR 1's 90-day retention constant (used by the boot-time pruneRejected in platform/assemble.ts) and reuse it. Do not define a second one. If it is module-private, export it from the module that owns it."*
  However, in `packages/gateway/src/platform/assemble.ts:3443`, PR 1 hardcoded this value directly as a numeric literal:
  ```ts
  captureStore.pruneRejected(Date.now() - 90 * 86_400_000);
  ```
  There is no named constant exported or defined anywhere in PR 1.
* **Actionable Fix:**
  Explicitly instruct Task 8 to define and export:
  ```ts
  export const REJECTED_RETENTION_MS = 90 * 86_400_000;
  ```
  in `packages/gateway/src/mcp-sink/capture-types.ts` (or `capture-store.ts`), and update `assemble.ts:3443` to import and use it.

---

## 2. Code Snippet & Implementation Refinements

### 2.1 Truncated `revokeCapture` Snippet in Task 9

* **Location in Plan:** Task 9 (lines 2128–2152)
* **Location in Code:** [`packages/gateway/src/mcp-sink/capture-gate.ts:315-318`](file:///C:/gitrep/Nimbus/packages/gateway/src/mcp-sink/capture-gate.ts#L315-L318)
* **Detail:**
  In Task 9 Step 3, the replacement code block for `revokeCapture` ends right after the audit entry transaction:
  ```ts
      appendAuditEntry(deps.db, { ... });
    })();
  ```
  Existing PR 1 code has crucial post-transaction race handling and return statement:
  ```ts
    if (!won && deps.store.get(id)?.state !== "revoked") {
      throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
    }
    return { id, state: "revoked" };
  ```
* **Suggestion:** Include the return and race-check lines in the snippet to avoid an executing agent accidentally cutting off the function tail.

---

### 2.2 `titleOf` Link Format Preview Truncation

* **Location in Plan:** Task 7 Step 3 (`packages/gateway/src/mcp-sink/capture-store.ts`)
* **Detail:**
  Task 7 mentions:
  > *"add the link preview `${p["relation"]}: ${p["fromItemId"]} → ${p["toItemId"]}` when `p["relation"]` is a string."*
  Because `fromItemId` and `toItemId` can each be up to 512 characters, formatting both into a preview without clamping could yield a title over 1,000 characters.
* **Suggestion:**
  Match the existing `titleOf` truncation convention (`.slice(0, 120)`):
  ```ts
  case "link": {
    const rel = typeof p["relation"] === "string" ? p["relation"] : "link";
    const from = typeof p["fromItemId"] === "string" ? p["fromItemId"] : "";
    const to = typeof p["toItemId"] === "string" ? p["toItemId"] : "";
    return `${rel}: ${from} → ${to}`.slice(0, 120);
  }
  ```

---

### 2.3 Line Reference Drift in Task 11 (`brief-contract.coverage.test.ts`)

* **Location in Plan:** Task 11 Step 1 (line 2332)
* **Detail:**
  Task 11 states: *"Update the :665 comment, which currently says decisions disclose only via gap notes."*
  `packages/gateway/src/agents/_lib/brief-contract.coverage.test.ts` is only 196 lines long.
  The comment referenced was originally located in a different test file (e.g. `synthesize.test.ts` or an earlier branch).
* **Suggestion:** Update the note in Task 11 to reference the correct file and line so developers/agents do not search fruitlessly in `brief-contract.coverage.test.ts`.

---

### 2.4 Cognitive Complexity Vigilance in `brief-contract.ts` & `render.ts`

* **Location in Plan:** Task 11 (`brief-contract.ts`, `render.ts`)
* **Detail:**
  The gateway enforces Sonar / Biome cognitive complexity ceilings (e.g. function complexity limit 15 in `brief-contract.ts`).
  Inline additions to `renderBrief` or `requiredPhrases` can easily trip this rule.
* **Suggestion:**
  Keep the helper functions modular:
  - `decisionsRequiredPhrases(brief)` (already planned in Task 11) is good.
  - In `render.ts`, extract helper `formatAgentDecisionDisclosure(...)` rather than nesting conditions deeply inside `renderDecisionsEntry`.

---

## 3. Open Questions & Strategic Improvements

### Q 3.1 Validation at Submit vs. Accept for Vetoed / Manual Terms

* **Current Design:**
  `propose_term` succeeds at submit time even if a term is already `vetoed` or `manual`. It only fails at `accept` time with `ERR_CAPTURE_SUPERSEDED`.
* **Discussion:**
  - *Advantage:* Separation of concerns. Proposal queue is non-asserted, and state might change between submission and review.
  - *Potential Friction:* An MCP agent might generate a proposal for a term that the human explicitly vetoed months ago, only for the human to see an error upon trying to accept it.
* **Suggestion:**
  Maintain the current design (defer authoritative refusal to accept time), but consider returning an advisory note in the `propose_term` MCP response if `vetoed` or `manual` already exists (e.g. `"Note: This term is currently recorded as vetoed in the index; acceptance may be rejected."`).

---

### Q 3.2 Batch CLI Operations for Captures

* **Current Design:**
  CLI supports `nimbus captures accept <id>` and `nimbus captures reject <id>` for single IDs.
* **Discussion:**
  When an agent proposes multiple links or decisions in a single session (e.g. 10 links discovered during a review), the user must run 10 separate CLI commands.
* **Suggestion:**
  Consider allowing multiple IDs in `accept` and `reject`:
  ```bash
  nimbus captures accept <id1> <id2> <id3>
  ```
  or a batch flag `nimbus captures accept --all --kind link`.
  *(Can be implemented in PR 2 or deferred to PR 3).*

---

### Q 3.3 Foreign Key Cascades & Revocation of Referenced Decisions

* **Current Design:**
  `decision_evidence` references `decision_record(id) ON DELETE CASCADE`.
  When `revokeCapture` deletes an agent decision row (`deleteAgentDecision`), its evidence rows automatically cascade away.
* **Verification:**
  Checked `packages/gateway/src/index/decisions-v47-sql.ts`:
  - `decision_evidence` has `ON DELETE CASCADE`.
  - `decision_record` has no other incoming foreign key constraints from graph or item tables.
  - Deleting an agent decision will not throw FK constraint violations during normal operation.

---

### Q 3.4 Handling of Disconnected Graph Entities on Link Revocation

* **Current Design:**
  `upsertGraphRelation` creates a `graph_relation` row between `fromEntityId` and `toEntityId`.
  `deleteGraphRelation` removes the relation on revoke.
* **Consideration:**
  If the link was between entities that had no other edges, the entities remain in `graph_entity`. This is standard and expected in the Nimbus graph populator (entities persist while relations evolve), so no changes are needed.

---

## 4. Plan Amendment Checklist

To make the execution 100% smooth, apply the following quick edits to `2026-10-13-mcp-capture-sink-pr2.md`:

| Task | Target File | Amendment |
| :--- | :--- | :--- |
| **Task 3** | `decision-store.ts` | Ensure `clearDecisions` snippet includes `dbRun(db, "DELETE FROM decision_pass_state", []);`. |
| **Task 4** | `glossary-store.ts` | Ensure `clearGlossary` snippet includes `dbRun(db, "DELETE FROM glossary_pass_state", []);`. |
| **Task 6** | `capture-native.ts` | In `writeCaptureNative` for `case "term"`, call `unprojectTerm(db, v.payload.termKey)` to remove any stale LLM item projection. |
| **Task 7** | `security-invariants.test.ts` | Update line 2626 from `"validateNotePayload(params"` to `"validateCapturePayload("`. |
| **Task 7** | `capture-store.ts` | Add `.slice(0, 120)` to `titleOf` link preview formatting. |
| **Task 8** | `capture-types.ts` & `assemble.ts` | Export `REJECTED_RETENTION_MS = 90 * 86_400_000;` and replace the magic number in `assemble.ts:3443`. |
| **Task 9** | `capture-gate.ts` | Complete `revokeCapture` snippet with the post-transaction check and `return { id, state: "revoked" };`. |
| **Task 11** | `brief-contract.coverage.test.ts` | Correct the comment reference from `:665` to point to the actual target file. |
| **Task 14** | `mcp-capture.e2e.test.ts` | In `bootGateway()`, configure `kinds = ["note", "decision", "term", "link"]` so proposal tools are registered. |

---

## 5. Disposition (plan author, 2026-10-13)

Every finding was checked against the code at `51662dc0` before acting.

| # | Verdict | Action in the plan |
|---|---|---|
| 1.1 | **Confirmed** | Task 7 now owns the edit (it is the task that breaks the test): the order array names `validateCapturePayload(kindRaw` and also pins the two new steps, `resolveLinkEndpoints(` and `countByState("proposed")`, with a red-proof. Step 4 runs `security-invariants.test.ts`. |
| 1.2 | **Confirmed** | Task 14 gains Step 0: `bootGateway` writes all four kinds. |
| 1.3 | **Confirmed** (the most serious one) | Task 6's term arm calls `unprojectTerm` after a successful takeover, in the accept transaction. It has a positive-control test (projected → 1 item; after accept → 0). Recorded in the Spec-corrections row. Without it, the superseded LLM definition would stay searchable forever. |
| 1.4 | **Confirmed as ambiguity**, not a wrong instruction | Task 3 shows the whole `clearDecisions` body including the `decision_pass_state` delete. Task 4 says the `glossary_pass_state` delete stays. Both tests assert that pass state is empty. |
| 1.5 | **Confirmed** | Task 8 defines `REJECTED_RETENTION_MS` in `capture-store.ts` and swaps the literal at `assemble.ts:3443`. |
| 2.1 | **Confirmed** | Task 9's snippet now ends with PR 1's race check and `return`, and states exactly what it replaces. |
| 2.2 | **Confirmed**; file corrected | `titleOf` lives in `capture-gate.ts`, not `capture-store.ts`. The full function is shown, clamped at 120, with a test. |
| 2.3 | **Confirmed** | The stale `:665` pointer is replaced: no such comment exists, and the `brief-contract.ts` comment stays true. |
| 2.4 | **Taken, sharpened** | The plan's own glossary label was a nested ternary (Sonar S3358). It is now a `provenanceLabel` helper. |
| Q3.1 | **Rejected** | An advisory would disclose vetoed/authored index state to an external MCP client. Recorded under "Considered and NOT taken". |
| Q3.2 | **Deferred** (follow-up) | Partial-failure semantics need a design. Recorded under "Considered and NOT taken". |
| Q3.3 / Q3.4 | Confirmations | No change. |
