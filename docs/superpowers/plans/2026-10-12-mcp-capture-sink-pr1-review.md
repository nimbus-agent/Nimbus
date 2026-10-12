# Review: S3 — MCP Capture Sink PR 1 Implementation Plan

> **Review Date:** 2026-10-12  
> **Document Reviewed:** `2026-10-12-mcp-capture-sink-pr1.md`  
> **Target Branch:** `dev/asaf/s3-mcp-capture-sink`  
> **Scope:** PR 1 — Notes End to End (I28, D32, V66 Schema, `capture_note`, `nimbus captures`)  
> **Reviewer:** Antigravity / Pair Programming Agent  

---

## 1. Executive Summary

The implementation plan for PR 1 (`2026-10-12-mcp-capture-sink-pr1.md`) is an exemplary, production-grade engineering blueprint. It translates the architectural foundations laid out in `2026-10-11-mcp-capture-sink-design.md` into 12 tightly scoped, test-driven tasks. 

Commendably, the author has already incorporated key findings from the earlier design review:
- **Index Primary Key Exposure:** `projectRankedItem` in `adapter.ts` now projects `id: r["indexPrimaryKey"]`, giving MCP clients the exact identifier required for `relatesTo`.
- **Atomic Single-Transaction Submit:** `submitCapture` bundles the `capture` row, `item` row, and audit entry in one transaction, ensuring atomicity and fail-closed rollbacks.
- **LAN Denylist Enforcement:** `capture` and `captures` are explicitly added to `FORBIDDEN_OVER_LAN` in `lan-rpc.ts`.
- **Durable Rate Limiting:** Gateway-wide attempt limiting combines an in-memory sliding window with durable SQLite table counts (`capture.created_at`).

During line-by-line verification against the codebase (`packages/gateway` and `packages/cli`), **five actionable corrections** and several **architectural enhancements** were identified. Addressing these will ensure a zero-friction implementation phase without broken builds or runtime regressions.

---

## 2. Critical Corrections & Blockers (Must Fix Before Execution)

### 2.1 Broken Import Path in `captures.ts` (Task 10, Line 3160)
- **The Issue:**  
  Task 10 specifies:
  ```ts
  import type { IPCClient } from "../ipc-client.ts";
  ```
- **Codebase Reality:**  
  In `packages/cli/src/`, `ipc-client` is a directory containing `index.ts`. Across all CLI commands (e.g. `ask.ts`, `admin.ts`, `_agent-brief-cli.ts`), the import is:
  ```ts
  import type { IPCClient } from "../ipc-client/index.ts";
  ```
- **Impact:** `bun run typecheck` will fail immediately with `TS2307: Cannot find module '../ipc-client.ts'`.
- **Fix:** Update line 3160 in Task 10 to import from `"../ipc-client/index.ts"`.

---

### 2.2 Missing Index on `capture(item_id)` in V66 Migration (Task 1 & Task 6)
- **The Issue:**  
  Task 6 introduces `missingItem()` and Task 3 introduces `stateOfItem(itemId: string)`:
  ```ts
  stateOfItem(itemId: string): CaptureState | undefined {
    const r = this.db.query("SELECT state FROM capture WHERE item_id = ?").get(itemId) as ...;
  }
  ```
  In `submitCapture`, `missingItem` runs `stateOfItem(id)` for **every item** in `payload.relatesTo`.
  However, in Task 1 (`capture-v66-sql.ts`), the only indexes created are:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at);
  ```
  There is **no index on `item_id`**.
- **Impact:**  
  Because `relatesTo` typically contains non-capture connector items (e.g., `github:issue:123`, `slack:message:...`), `stateOfItem` will execute an **unindexed full table scan of `capture` up to 10 times per note submission**. As the `capture` table grows, this degrades submission throughput.
- **Fix:** Add a partial index to `CAPTURE_V66_SQL` in Task 1:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_capture_item_id ON capture(item_id) WHERE item_id IS NOT NULL;
  ```

---

### 2.3 Title Sanitization Asymmetry (Task 2 & Task 10)
- **The Issue:**  
  In Task 2 (`capture-validate.ts`), `validateNotePayload` verifies `title.length` (1..256), but does **not** strip control or ANSI characters from `title`. It only runs `stripControl()` on `clientLabel`.
  While Task 10's CLI renderer (`captures-format.ts`) strips control characters before printing to the terminal, the raw, unsanitized `title` is written directly into `item.title` in SQLite via `upsertIndexedItem`.
- **Impact:**  
  Downstream consumers of the unified `item` index (such as `nimbus query`, web clip searches, vector index titles, and desktop UI notifications) may render the raw `item.title` without stripping ANSI escape sequences, introducing terminal escape injection risks.
- **Fix:** In `validateNotePayload`, sanitize `title` with `stripControl(title.trim())` before validation and storage.

---

### 2.4 Fragile E2E Test Output Regex (Task 11, Line 3519)
- **The Issue:**  
  Task 11 uses:
  ```ts
  const match = stdout.match(/Captured note (cap_[0-9a-f-]+)/);
  ```
- **Codebase Reality:**  
  `newId` in Task 6 generates `cap_${randomUUID()}`. While random UUIDs use lowercase hex and dashes, mock implementations, future ULID transitions, or test fixtures using sequential IDs (e.g. `cap_1`, `cap_test`) will fail this regex assertion.
- **Fix:** Broaden the pattern to standard identifier characters:
  ```ts
  const match = stdout.match(/Captured note (cap_[A-Za-z0-9_-]+)/);
  ```

---

### 2.5 `.coderabbit.yaml` Header & Comment Drift (Task 8)
- **The Issue:**  
  Task 8 updates `check-coderabbit-config.test.ts` to assert that invariant `I28` is active.
  However, `.coderabbit.yaml` contains an explicit comment on line 16:
  ```yaml
  # (I1-I42; I28 is reserved, so the LIVE count is 41, not 42)
  ```
- **Impact:** Failing to update this comment creates misleading documentation for PR reviewers and future audits.
- **Fix:** Add a step in Task 8 to update the comment in `.coderabbit.yaml` from 41 to 42 live invariants.

---

## 3. Architectural Alignments & Enhancements

### 3.1 Rate Limiting Spec Drift (Spec vs. Plan)
- **Observation:**  
  The design spec (`2026-10-11-mcp-capture-sink-design.md`) proposed rate-limiting per MCP session ID (`idx_capture_session_created`).  
  The implementation plan wisely deviated from this, using a **gateway-wide durable hourly limit** combined with an in-memory attempt window. This prevents clients like Claude Code or Cursor from bypassing limits by simply recycling stdio connections.
- **Recommendation:** Document this enhancement in `2026-10-11-mcp-capture-sink-design.md` under an "Amended during PR 1 Planning" note to maintain spec-to-plan consistency.

---

### 3.2 Deduplication of `tags` and `relatesTo` Arrays
- **Observation:**  
  In Task 2, `validateNotePayload` validates that `tags.length <= 20` and `relatesTo.length <= 10`. If a model sends duplicate values (e.g. `relatesTo: ["github:1", "github:1"]`), both duplicates pass validation and consume array capacity.
- **Recommendation:**  
  Deduplicate both arrays during validation:
  ```ts
  const tags = Array.from(new Set(rawTags.map(t => t.trim().toLowerCase())));
  const relatesTo = Array.from(new Set(rawRelatesTo.map(r => r.trim())));
  ```
  This prevents redundant `SELECT 1 FROM item WHERE id = ?` queries in `missingItem` and avoids polluting metadata.

---

### 3.3 Doctor Check Exit Code Semantics on Historical Refusals (Task 10)
- **Observation:**  
  In Task 10, `formatCapturesDoctor`:
  ```ts
  const refused = Object.entries(s.refusedSinceStart);
  if (refused.length > 0) {
    lines.push(`[warn] MCP capture sink: refused since gateway start: ...`);
    exit = 1;
  }
  ```
- **Consideration:**  
  If an agent hits the hourly rate limit once, `refusedSinceStart["ERR_CAPTURE_RATE_LIMITED"]` becomes non-zero.  
  As currently drafted, `nimbus doctor` will fail (exit code 1) for the entire uptime of the gateway process, even after the hourly window clears and subsequent operations succeed.
- **Recommendation:**  
  Emit `[warn]` or `[info]` for historical refusals without setting `exit = 1`, reserving `exit = 1` for actionable anomalies:
  - Configuration errors (`disabledReason === "config_error"`)
  - Saturated proposal queues (`pending >= maxPending`)
  - Table or permission corruptions

---

### 3.4 MCP SDK `getClientVersion()` Fallback (Task 9)
- **Observation:**  
  In Task 9, line 2723:
  ```ts
  () => server.server.getClientVersion()?.name
  ```
  In `@modelcontextprotocol/sdk` v1.32.0, during unit test runs or when transport initialization has not completed the JSON-RPC `initialize` handshake, `server.server.getClientVersion()` may be undefined or throw.
- **Recommendation:**  
  Wrap safely with optional chaining and fallback:
  ```ts
  () => {
    try {
      return server.server?.getClientVersion?.()?.name;
    } catch {
      return undefined;
    }
  }
  ```
  `sanitizeClientLabel` in Task 2 already converts `undefined` to `null`, ensuring complete robustness.

---

## 4. Task-by-Task Feedback

| Task | Title | Status / Notes |
|---|---|---|
| **Task 1** | V66 Migration | **Needs Adjustment:** Add `idx_capture_item_id` index. Schema CHECK constraints and table structure are rock solid. |
| **Task 2** | Types & Note Validation | **Needs Adjustment:** Sanitize `title` with `stripControl()`; deduplicate `tags` and `relatesTo`. |
| **Task 3** | `CaptureStore` | **Ready.** Clean boundary isolation conforming to D32(a). |
| **Task 4** | Config & Capability | **Ready.** Fail-closed on missing policy/invalid config. Matches existing `isUserMcpModelAccessEnabled` pattern. |
| **Task 5** | Client Policy & Limiter | **Ready.** Clean distinction between submitter (`mcp`) and owner (`cli`, `ui`). |
| **Task 6** | Capture Gate | **Ready.** Order of refusals is strict and auditable. Transaction handles rollback gracefully. |
| **Task 7** | IPC Dispatcher & Assemble | **Ready.** Explicit LAN ban in `lan-rpc.ts` protects local security boundary. |
| **Task 8** | Invariants I28 & D32 | **Needs Adjustment:** Update live count comment in `.coderabbit.yaml`. Astute regex rules for D32 table confinement. |
| **Task 9** | MCP Adapter & `capture_note` | **Ready.** Correctly fixes the Item ID visibility gap from the spec review. |
| **Task 10** | `nimbus captures` CLI | **Needs Adjustment:** Fix `../ipc-client.ts` import; soften doctor exit code on historical refusal counters. |
| **Task 11** | End-to-End Tests | **Needs Adjustment:** Broaden regex matcher for capture ID in stdout. |
| **Task 12** | Docs & Final Audit | **Ready.** Thorough coverage of drift gates (`audit:status-drift`, `audit:invariants`). |

---

## 5. Implementation Verdict

The plan is **ready for execution** once the 5 critical corrections in Section 2 are applied to `2026-10-12-mcp-capture-sink-pr1.md`. 

The architecture is airtight, adheres strictly to AGPL-3.0 and Nimbus safety standards, preserves zero-egress boundaries, and sets a clean stage for PR 2 (proposals & review) and PR 3 (HITL act door).
