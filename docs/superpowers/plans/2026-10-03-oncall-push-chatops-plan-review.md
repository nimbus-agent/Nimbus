# On-Call Pushed Brief PR 2 (ChatOps Sink) — Plan Review & Suggestions

**Date:** 2026-10-03  
**Target Plan:** `2026-10-03-oncall-push-chatops.md`  
**Branch:** `dev/asaf/oncall-push-chatops`  
**Status:** Plan Review Complete (Ready for Execution with minor defensive recommendations)

---

## 1. Executive Summary

The implementation plan is exceptionally high quality, structured, and disciplined. It thoroughly addresses all aspects of the design specification and the earlier design review:
- **TDD Workflow:** Every task follows a strict failing test $\to$ red confirmation $\to$ implementation $\to$ green verification $\to$ red-proof $\to$ atomic commit sequence.
- **Settle Gate Pattern (Task 2):** Solves the boot race cleanly inside `OncallPushRuntime` via a promise gate (`gate` / `settleChatopsPoster`), avoiding risky global scheduler reordering in `assemble.ts`.
- **Command Grammar Fix (Task 3):** Correctly identifies and uses `incidentId=` instead of `incident=` for `@nimbus agent oncall`, adhering to `ipc/agent-param-kinds.ts`.
- **Injection & Formatting Protections (Task 1 & 3):** Combines `escapeSlackText` with `oneLine` Unicode format/control character collapsing and surrogate-safe code point limits.
- **Invariant Integrity (Task 4 & 7):** Updates I29 (4 post kinds) and I41 (`BootPolicy.chatops`) following the strict "wiring + tests + docs in one commit" triple rule.

Below are minor defensive refinements, edge-case observations, and practical suggestions for the implementation phase.

---

## 2. Defensive Improvements & Suggestions

### 2.1 Defensive Null/Undefined Handling in `parseHeadlineBrief` (Task 3)
In Task 3 Step 3, `parseHeadlineBrief` narrows properties from the serialized `OncallBrief`:
```ts
const sid = binding["nimbusServiceId"];
if (sid !== null && typeof sid !== "string") return null;
```
and:
```ts
const finishedAtMs = dep["finishedAtMs"];
if (finishedAtMs !== null && typeof finishedAtMs !== "number") return null;
```

**Observation:**
If a serialized brief JSON omits `nimbusServiceId` or `finishedAtMs` (i.e. the properties evaluate to `undefined`), the strict check `sid !== null && typeof sid !== "string"` will evaluate to `true` (since `undefined !== null` and `typeof undefined !== "string"`), causing `parseHeadlineBrief` to reject a valid brief as malformed.

**Recommended Improvement:**
Make optional/nullable field extraction tolerant of `undefined` (missing keys):
```ts
export function parseHeadlineBrief(json: string | null): HeadlineBrief | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(v) || !("deployment" in v)) return null;
  const binding = v["binding"];
  if (!isRecord(binding)) return null;
  const sid = binding["nimbusServiceId"];
  if (sid !== null && sid !== undefined && typeof sid !== "string") return null;
  const dep = v["deployment"];
  if (dep === null) return { nimbusServiceId: typeof sid === "string" ? sid : null, deployment: null };
  if (!isRecord(dep)) return null;
  const title = dep["title"];
  const startedAtMs = dep["startedAtMs"];
  const finishedAtMs = dep["finishedAtMs"];
  if (typeof title !== "string" || typeof startedAtMs !== "number") return null;
  if (finishedAtMs !== null && finishedAtMs !== undefined && typeof finishedAtMs !== "number") return null;
  return {
    nimbusServiceId: typeof sid === "string" ? sid : null,
    deployment: {
      title,
      startedAtMs,
      finishedAtMs: typeof finishedAtMs === "number" ? finishedAtMs : null,
    },
  };
}
```

---

### 2.2 Settle Gate Concurrency Verification (Task 2)
In Task 2, multiple sync ticks or calls to `rt.trigger("pagerduty")` may arrive while `gate` is still pending before ChatOps boots:
- When `gate` resolves, all waiting `run("pagerduty")` calls resume concurrently.
- `createOncallPushRunner` in `push-runner.ts` already handles this via `inFlight` and `rerunRequested` (single-flight loop), so the runner coalesces these calls safely into at most two passes.
- **Tip for Implementer:** No extra queuing is needed in `push-runtime.ts`; the existing runner's single-flight deduplication already protects against concurrent microtask thundering herds upon gate resolution.

---

### 2.3 Unit Test Suite Safety with `settleImmediately` (Task 2 & Task 5)
- Any unit test that constructs `assembleOncallPushRuntime` directly without providing `settleImmediately: true` and without calling `settleChatopsPoster` will cause `await rt.run(...)` to wait indefinitely for the gate.
- The plan identifies `push-runtime.test.ts`, `demo/seed.test.ts`, `ipc/demo-rpc.test.ts`, and `ipc/oncall-push-rpc.test.ts`.
- **Tip for Implementer:** If running `bun test` hangs after Task 2, search across tests for `assembleOncallPushRuntime` to check if any other test file instantiated a runtime without `settleImmediately: true`.

---

### 2.4 Summary Post with Empty Coalesced List (Task 3 & Task 5)
In `push-sinks.ts`:
```ts
const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
if (rest.length === 0) return;
```
- When `items.length <= PUSH_NOTIFY_CAP` (3), `rest` is empty and no summary post is attempted, which correctly saves Slack API quota and channel noise.
- When `rest.length > 0`, `renderPushSummary(items, rest)` receives both the total set and the overflow slice, producing the accurate `N` total, `M` ready, and capped ID listing.

---

## 3. Checklist of Key Validation Points during Execution

| Step | Area | Validation |
|---|---|---|
| **Task 1** | `escapeSlackText` | `&` must be escaped first so that `&lt;` is not double-escaped. |
| **Task 2** | Settle Gate | Red-prove by removing `await gate;` and asserting that an un-settled run is no longer held. |
| **Task 3** | `push-headline.ts` | Verify command parses cleanly with `parseAgentCommand(cmd, new Set(EXTERNAL_AGENT_NAMES))`. |
| **Task 4** | Egress Ledger | Verify `METHOD_FOR.pushedBrief` writes `chatops.pushedBrief` and records byte count payload only. |
| **Task 5** | `push-sinks.ts` | Verify that `notifyDelivers: false` still allows ChatOps delivery (sink runs before toast early return). |
| **Task 6** | `assemble.ts` | Confirm `settleOncallPushChatops` is called on both enabled and disabled ChatOps branches. |
| **Task 7** | Invariant I41 | Confirm `bootPolicyFor(demo).chatops === false` and `bootChatopsIntoAssembly` returns `undefined` in demo mode. |
| **Task 8** | Integration | Confirm 2 ledger rows are inserted *before* their respective posts for a 2-channel namespace. |
| **Task 9** | Documentation | Run `bun run audit:doc-refs && bun run audit:status-drift` and ensure no orphaned "three functions" references exist. |
| **Task 10**| Pre-merge cleanup| Verify spec, review, and plan markdown files are cleanly stripped before opening PR. |

---

## 4. Conclusion

The plan is complete, well-architected, and fully aligned with all Nimbus codebase conventions and security invariants. It is ready for execution using either subagent-driven development or direct task-by-task execution.
