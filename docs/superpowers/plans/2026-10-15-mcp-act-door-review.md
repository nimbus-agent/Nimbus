# S3 Act Door Implementation Plan Review

**Plan:** [`docs/superpowers/plans/2026-10-15-mcp-act-door.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/s3-act-door/docs/superpowers/plans/2026-10-15-mcp-act-door.md)  
**Spec (rev 2):** `docs/superpowers/specs/2026-10-15-mcp-act-door-design.md`  
**Date:** 2026-10-15  
**Reviewer:** Pair Programming Assistant  

---

## 1. Executive Summary

The 15-task implementation plan in `2026-10-15-mcp-act-door.md` is an exceptionally comprehensive, rigorous, and disciplined translation of the S3 Act Door Design Specification into concrete executable steps. 

It successfully incorporates all fundamental design revisions identified during the spec review:
- Resolves the first-party mesh dispatch mismatch via `PROPOSABLE_WRITE_TOOLS` (30 mapped write tools, tested against `@nimbus-dev/connectors@0.2.4` in Task 4).
- Establishes canonical user-MCP tool routing via `userMcpToolKeyForActionType(actionType)` under `mcpToolId` to satisfy Invariant I42.
- Adheres to fail-closed capability gates (disabled `mcp_action` policy blocks proposals and execution).
- Enforces strict table isolation (V69 schema rebuild with `CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL))`).
- Provides unredacted provenance consent, lazy expiry auditing, and restart reconcile.

This review identifies **4 high-priority technical catches / edge cases**, **4 architectural improvements**, and a task-by-task verification checklist to ensure smooth, zero-regression execution.

---

## 2. High-Priority Catches & Edge Cases

### 2.1. Intermediate Test Failure: Task 6 Breaks Invariant I28 Order Pin
- **Location:** Plan Task 6 (lines 1410–1440) vs [`packages/gateway/src/security-invariants.test.ts:2618-2635`](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts#L2618-L2635)
- **Issue:**
  In Task 6 Step 1, `submitCapture`'s signature is made `async`:
  ```ts
  export async function submitCapture(...)
  ```
  However, in `security-invariants.test.ts`, the existing I28 order test does:
  ```ts
  const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
  const body = src.slice(src.indexOf("export function submitCapture"));
  ```
  Because `indexOf("export function submitCapture")` no longer matches `export async function submitCapture`, it evaluates to `-1` (`src.slice(-1)`).
  Consequently, `idx.every((i) => i >= 0)` returns `false`, causing `security-invariants.test.ts` to fail immediately after Task 6.
  While Task 7 Step 6 eventually updates this anchor, running `bun run preflight:fast` or `bun test packages/gateway/src/security-invariants.test.ts` at the end of Task 6 will report a red regression.
- **Recommendation:**
  In Task 6 Step 1 (or Step 2), update the string search anchor in `packages/gateway/src/security-invariants.test.ts:2620` from `src.indexOf("export function submitCapture")` to `src.indexOf("submitCapture(")`. This keeps intermediate commits clean and testable under preflight.

---

### 2.2. Missing Trojan Source / Bidi Marks in `INVISIBLE_RE`
- **Location:** Plan Task 7, lines 1725 & 1791
- **Issue:**
  In `capture-act.ts`, `INVISIBLE_RE` is defined as:
  ```ts
  const INVISIBLE_RE = /[\u007f-\u009f\u200B-\u200D\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
  ```
  Notice the range `\u200B-\u200D`:
  - `\u200B`: Zero-Width Space
  - `\u200C`: Zero-Width Non-Joiner
  - `\u200D`: Zero-Width Joiner
  
  Crucially, it **omits** `\u200E` (Left-to-Right Mark, LRM) and `\u200F` (Right-to-Left Mark, RLM)! Both are common invisible directional marks explicitly exploited in Trojan Source / directional spoofing attacks.
  Furthermore, `\u2060` (Word Joiner) and `\u2061–\u2064` (Invisible mathematical operators) are omitted (only `\u2066-\u2069` are matched).
- **Recommendation:**
  Widen `INVISIBLE_RE` to comprehensively cover the General Punctuation format characters:
  ```ts
  const INVISIBLE_RE = /[\u007f-\u009f\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
  ```
  This ensures any attempt by an agent to disguise or reorder arguments using LRM/RLM or word joiners renders escaped (e.g. `\u200e`) in the owner's confirmation prompt.

---

### 2.3. Top-Level `mcpToolId` Key in `validateActionPayload`
- **Location:** Plan Task 5, lines 1362–1377
- **Issue:**
  The docstring in Task 5 states:
  > *"A top-level `mcpToolId` key REFUSES: the dispatcher would treat it as a tool selector, and a refusal (unlike a silent drop) is visible to the agent and in the audit log."*
  
  However, the implementation only checks:
  ```ts
  const input = o["input"];
  if (Object.hasOwn(input, "mcpToolId")) {
    invalid("input may not carry mcpToolId: the gateway chooses the tool");
  }
  ```
  If an agent passes `{ actionType: "slack.message.post", mcpToolId: "slack_admin_delete", input: {}, summary: "..." }`, `validateActionPayload` extracts `actionType`, `input`, and `summary`, silently dropping `o["mcpToolId"]`.
- **Recommendation:**
  Check both `o` and `input`:
  ```ts
  if (Object.hasOwn(o, "mcpToolId") || Object.hasOwn(input, "mcpToolId")) {
    invalid("may not carry mcpToolId: the gateway chooses the tool");
  }
  ```
  This guarantees that an agent attempting to inject `mcpToolId` at either the proposal payload level or tool input level receives an explicit refusal and audit log.

---

### 2.4. Socket Handle Leak in E2E Test (`user-mcp.e2e.test.ts`)
- **Location:** Plan Task 14, lines 3033–3035 & [`packages/gateway/test/e2e/user-mcp.e2e.test.ts:400-411`](file:///C:/gitrep/Nimbus/packages/gateway/test/e2e/user-mcp.e2e.test.ts#L400-L411)
- **Issue:**
  Task 14 instantiates a secondary client:
  ```ts
  const agent = new TestIpcClient();
  ```
  While `client.close()` is called in `afterAll()`, `agent.close()` is never called. On Windows (named pipes) and Bun test runners, an unclosed IPC socket handle can keep the event loop alive or trigger handle race warnings during temporary folder cleanup (`rmSync(tmp)`).
- **Recommendation:**
  Add `agent.close()` to `afterAll` in `user-mcp.e2e.test.ts`.

---

## 3. Improvements & Architecture Polish

### 3.1. Consolidate Dual IPC Connections in CLI `runCapturesCmd`
- **Location:** Plan Task 13, lines 2969–2993
- **Current Pattern:**
  When `a.verb === "accept"`, `runCapturesCmd` executes:
  1. `withGatewayIpc` connection #1: calls `captures.get` to check `kind === "action"` for the TTY guard.
  2. Disconnects.
  3. `withGatewayIpc` connection #2: calls `runCapturesWith`, which calls `captures.get` *again* to fetch `payload.actionType` for prompt formatting, followed by `captures.accept`.
- **Drawbacks:**
  - Double IPC handshake overhead on named pipe / domain socket.
  - Race condition: capture could be accepted, deleted, or expired between connection #1 and #2.
  - Redundant duplicate `captures.get` RPC call.
- **Proposed Optimization:**
  Perform both operations inside a single `withGatewayIpc` session:
  ```ts
  export async function runCapturesCmd(argv: string[]): Promise<void> {
    const a = parseCapturesArgs(argv);
    if (a === undefined) {
      process.stderr.write(`${CAPTURES_USAGE}\n`);
      throw new CliExit(2);
    }
    const paths = getCliPlatformPaths();
    const code = await withGatewayIpc(
      async (c) => {
        if (a.verb === "accept") {
          let kind: string | undefined;
          try {
            const d = await c.call<unknown>("captures.get", { id: a.id });
            kind = (d as Record<string, unknown> | null)?.["kind"] as string | undefined;
          } catch {
            kind = undefined;
          }
          const refusal = actionAcceptTtyRefusal(kind, {
            stdin: process.stdin.isTTY === true,
            stdout: process.stdout.isTTY === true,
          });
          if (refusal !== undefined) {
            process.stderr.write(`${refusal}\n`);
            return 1;
          }
        }
        return runCapturesWith(c, a, {
          out: (s) => process.stdout.write(s),
          err: (s) => process.stderr.write(s),
        });
      },
      paths,
      a.verb === "accept" ? { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : {},
    );
    if (code !== 0) throw new CliExit(code);
  }
  ```

---

### 3.2. Action Queue Cap Warning in `doctorCapturesLines`
- **Location:** Plan Task 13, line 3000
- **Current Behavior:**
  Task 13 adds an info line to `doctorCapturesLines`:
  ```ts
  if (s.actionEnabled && s.actionPending > 0) {
    lines.push(`[info] MCP capture sink: ${s.actionPending} agent-proposed actions awaiting review...`);
  }
  ```
  However, for native captures, if `s.pending >= s.maxPending`, doctor warns:
  ```ts
  if (s.pending >= s.maxPending) {
    lines.push(`[warn] MCP capture sink: capture queue full (${s.pending}/${s.maxPending}): new proposals are being refused`);
    exit = 1;
  }
  ```
  The act door configures `action_max_pending` (default 50). When `actionPending >= actionMaxPending`, all new action proposals are rejected with `ERR_CAPTURE_QUEUE_FULL`.
- **Recommendation:**
  Mirror the queue exhaustion warning for actions:
  ```ts
  if (s.actionEnabled) {
    if (s.actionPending >= s.actionMaxPending) {
      lines.push(
        `[warn] MCP capture sink: action queue full (${String(s.actionPending)}/${String(s.actionMaxPending)}): new action proposals are being refused — nimbus captures`,
      );
      exit = 1;
    } else if (s.actionPending > 0) {
      lines.push(
        `[info] MCP capture sink: ${String(s.actionPending)} agent-proposed actions awaiting review (${String(s.actionExpiringWithinHour)} expire within 1h) — nimbus captures`,
      );
    }
  }
  ```

---

### 3.3. Remove Dead Error Codes in `ACTION_ERROR_CODES`
- **Location:** Plan Task 1, lines 292–304
- **Observation:**
  Task 1 defines `ACTION_ERROR_CODES` containing:
  - `ERR_ACTION_NOT_FOUND`
  - `ERR_ACTION_NETWORK`
  
  In Task 7 (line 1768), `classifyActionError` only classifies:
  - `ERR_ACTION_TIMEOUT`
  - `ERR_ACTION_TOOL_NOT_FOUND`
  - Fallback: `ERR_ACTION_DISPATCH`
  (And boot reconcile sets `ERR_ACTION_INTERRUPTED`).
  
  Neither `ERR_ACTION_NOT_FOUND` nor `ERR_ACTION_NETWORK` is ever produced anywhere in the codebase.
- **Recommendation:**
  Either trim `ACTION_ERROR_CODES` to the exact 4 error codes emitted during execution (`TIMEOUT`, `TOOL_NOT_FOUND`, `DISPATCH`, `INTERRUPTED`), or add error message patterns to `classifyActionError` (e.g. `/ECONNREFUSED|ENOTFOUND|fetch failed/` -> `ERR_ACTION_NETWORK`).

---

### 3.4. Update Task 15 Deletion List
- **Location:** Plan Task 15, lines 3113 & 3150
- **Observation:**
  Task 15 specifies:
  ```bash
  git rm docs/superpowers/specs/2026-10-15-mcp-act-door-design.md docs/superpowers/specs/2026-10-15-mcp-act-door-review.md docs/superpowers/plans/2026-10-15-mcp-act-door.md
  ```
  Because this plan review file is written to `docs/superpowers/plans/2026-10-15-mcp-act-door-review.md`, the cleanup step should delete it as well:
  ```bash
  git rm docs/superpowers/specs/2026-10-15-mcp-act-door-*.md docs/superpowers/plans/2026-10-15-mcp-act-door-*.md
  ```

---

## 4. Task-by-Task Verification Matrix

| Task # | Scope | Critical Invariants | Notes / Recommendations |
|---|---|---|---|
| **Task 1** | Vocabulary & Config | Fail-closed policy (`mcp_action`), default-off kinds | Ensure `action_ttl_hours` (1–168) and `action_max_pending` (1–500) validated. |
| **Task 2** | Schema V69 & Store Queries | I28 Table Confinement, SQLite rebuild | `pruneRejected` must prune `('rejected', 'expired')`. Table constraint ensures `item_id IS NULL AND native_ref IS NULL` for actions. |
| **Task 3** | Proposability & Routing Table | 139 `HITL_REQUIRED` totality, 30 write tools | Clean separation between first-party `PROPOSABLE_WRITE_TOOLS` and user-MCP `<srv>_<tool>`. |
| **Task 4** | Installed Connector Sync Test | Connector package drift prevention | Uses real AST span extraction from installed `@nimbus-dev/connectors@0.2.4`. |
| **Task 5** | Payload Validation | 64 KiB cap, `mcpToolId` rejection | Check `mcpToolId` on both `o` and `input` (see § 2.3). |
| **Task 6** | Async `submitCapture` Signature | Type consistency | Update `security-invariants.test.ts` string anchor here to prevent test failure (see § 2.1). |
| **Task 7** | Gate Logic (`capture-act.ts`) | CAS claim, lazy expiry, atomic finalize | Widen `INVISIBLE_RE` to include `\u200E` and `\u200F` (see § 2.2). |
| **Task 8** | IPC & Executor Wiring | I42 consent unredacted, I29 egress | `ToolExecutor` constructed per call with `NO_POLICY_OVERLAY` for consent. |
| **Task 9** | Assemble Wiring & Boot Reconcile | Recovery of interrupted actions | Verify `reconcileActionsAtBoot` runs before IPC socket binds. |
| **Task 10** | Dispatcher Routing Integration Test | Real dispatcher + mesh key format | Red-proof test confirms dispatch by type alone fails. |
| **Task 11** | Flow Integration Test | Egress ledger before dispatch | Proves append-before-dispatch, disconnect, and expiry. |
| **Task 12** | Invariant Static Rules D32(e)(f)(g) | Confinement of `acceptAction` & `mcpToolId` | `checkActDoorConfinement` AST/regex rules properly confined. |
| **Task 13** | CLI Surface (`propose_action`, TTY) | TTY requirement for action approval | Consolidate `withGatewayIpc` calls in `runCapturesCmd` (see § 3.1). Add queue full warning (see § 3.2). |
| **Task 14** | End-to-End User MCP Test | Real gateway subprocess + sandbox | Close `agent` socket client in `afterAll` (see § 2.4). |
| **Task 15** | Docs & Pre-PR Cleanup | Documentation integrity | Include plan review in final deletion command (see § 3.4). |

---

## 5. Conclusion & Next Steps

The implementation plan is exceptionally high quality and ready to execute once the few edge cases and refinements above are incorporated:
1. **Apply the 4 High-Priority fixes** (§ 2.1 – § 2.4) directly into Tasks 5, 6, 7, and 14.
2. **Adopt the CLI IPC consolidation and Doctor warning** (§ 3.1 & § 3.2) in Task 13.
3. **Proceed with implementation** following the 15-task sequence.
