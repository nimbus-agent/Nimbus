# Review: On-call Pushed Brief PR 3 (Desktop Panel) Implementation Plan

**Target Plan:** `2026-10-04-oncall-push-desktop.md`  
**Review Date:** 2026-10-04  
**Status:** Plan Approved with Minor Defensive Suggestions · Ready for Execution  

---

## 1. Executive Summary & Verdict

The implementation plan [`2026-10-04-oncall-push-desktop.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/oncall-push-desktop/docs/superpowers/plans/2026-10-04-oncall-push-desktop.md) is thorough, well-structured, and strictly adheres to the Nimbus architectural rules and security invariants:

- **TDD & Red-Proving Discipline:** Every task starts with explicit failing tests, exact failure assertions, and verified red-proof steps (reverting specific lines to prove failure).
- **Security Invariant I7 Alignment:** The allowlist update (105 → 107) follows the required "triple rule" in one atomic commit (Rust `ALLOWED_METHODS` + Rust tests + `security-invariants.test.ts` + `docs/SECURITY-INVARIANTS.md`).
- **Contract Testing Separation:** Gateway and Desktop packages are cleanly decoupled with a committed, normalized JSON contract fixture (`packages/ui/test/fixtures/oncall-pushed.json`), avoiding cross-package imports.
- **SQLite Performance:** The `listWithIncident` query resolves incident metadata using a guarded `LEFT JOIN` and `json_valid()` check, preventing N+1 queries.
- **Strict Typing:** No `any` used; narrowers (`asPushedBriefList`, `asPushedBriefGet`, `parseBriefPushed`) safely handle IPC data.

Below are **open questions, subtle edge-case guards, and suggested improvements** to consider during task execution.

---

## 2. Key Observations & Recommended Guards

### 2.1 Auto-Select Loop Guard on Pruned Incident (`Oncall.tsx`)
In `packages/ui/src/pages/Oncall.tsx` (Task 9, Step 7):
```tsx
const newestId = newest?.incidentId;
useEffect(() => {
  if (selectedId === null && newestId !== undefined) {
    setParams({ id: newestId }, { replace: true });
  }
}, [selectedId, newestId, setParams]);
```
- **Scenario:** Suppose a user opens `/oncall?id=pagerduty:PRUNED`, or a brief in a single-item cached list was pruned from the database.
  1. `BriefDetail` receives `incidentId = "pagerduty:PRUNED"`.
  2. `pushedGet` returns `{ brief: null }`.
  3. `onPruned` sets `pruned = "pagerduty:PRUNED"` and calls `setParams({}, { replace: true })`.
  4. On the next render, `selectedId` is `null`.
  5. If `newestId` happens to still be `"pagerduty:PRUNED"` (e.g. before the list query refetches), the auto-select effect will immediately re-set `id: "pagerduty:PRUNED"`, causing an immediate re-fetch and render loop.
- **Recommended Guard:**
  ```tsx
  useEffect(() => {
    if (selectedId === null && newestId !== undefined && newestId !== pruned) {
      setParams({ id: newestId }, { replace: true });
    }
  }, [selectedId, newestId, pruned, setParams]);
  ```

---

### 2.2 `asPushedBriefGet` Return Semantics (`useOncallBriefs.ts`)
In `hooks/useOncallBriefs.ts` (Task 8, Step 3):
- `asPushedBriefGet(v)` returns:
  - `undefined`: when `data` is `null`, `undefined`, loading, or of invalid shape.
  - `{ brief: null }`: when the gateway explicitly returns `{ brief: null }` (pruned/vanished brief).
  - `{ brief: PushedBriefDetail }`: when a valid brief detail payload is present.
- In `BriefDetail.tsx`:
  - `if (got !== undefined && got.brief === null) onPruned(incidentId);`
  - `if (got === undefined || got.brief === null || got.brief.incidentId !== incidentId) return <p ...>Loading…</p>;`
- **Note:** This distinction is clean and correct, but adding a short inline doc comment in `useOncallBriefs.ts` will make the `undefined` (loading/invalid) vs `{ brief: null }` (pruned) contract immediately obvious to future maintainers.

---

### 2.3 `DeliveryStrip` Ordering & Empty State
In `components/oncall/DeliveryStrip.tsx` (Task 9, Step 4):
- The `orderedSinks` function guarantees the priority order: `["event", "toast", "chatops"]`, followed by any remaining sinks sorted alphabetically.
- If `delivery` is empty (`{}`), `sinks.length === 0` safely returns `null` with no extra DOM wrapper.
- Verified that all fields avoid stringified `"null"` / `"undefined"` leaks when reason is missing.

---

## 3. Task-by-Task Verification Highlights

| Task | Core Responsibility | Verification Focus |
|---|---|---|
| **Task 1** | `resolvePushService` | Returns raw string (no escaping), mapped service wins, fallbacks work. |
| **Task 2** | `service` in `pushedList` & `push-store.ts` | Guarded `PD_SERVICE_SQL` prevents SQLite errors on bad JSON; 1 single query for list. |
| **Task 3** | Cross-Package Contract Fixture | Fixed epoch `1_790_000_000_000` ensures deterministic fixture generation. `biome format` keeps lint clean. |
| **Task 4** | CLI `nimbus oncall pushed list` | Omits `[service]` segment cleanly when service is null; no double spacing. |
| **Task 5** | Allowlist (105 → 107) | Atomic commit across Rust, TS tests, and Security Invariant docs. `pushedRetry` strictly excluded. |
| **Task 6** | `OncallSlice` & Persistence | `lastSeenPushedAt` only moves forward; persisted via `WHITELISTED_PERSIST_KEYS`. |
| **Task 7** | `NavItem` Dot Indicator | Dot renders with `sr-only` label; numeric badge `> 0` takes precedence over dot. |
| **Task 8** | `OncallBriefsProvider` | Single subscription to `gateway://notification`; `seq` counter increments on each matching event. |
| **Task 9** | `Oncall` Page & Detail View | Verbatim markdown in `<pre>`; clock-skew resilience (`just now`); pruned brief URL recovery. |
| **Task 10** | Documentation & Ledger | Synchronized status across `architecture.md`, `cli-reference.md`, `CHANGELOG.md`, `CLAUDE.md`, `GEMINI.md`. |
| **Task 11** | Whole-Branch Verification | Full preflight, coverage gates (≥80% lines, ≥75% branches), cleanup of planning docs before PR. |

---

## 4. Suggested Execution Order

1. **Tasks 1 – 4 (Gateway & CLI Layer):**
   - Implement `resolvePushService` and `listWithIncident`.
   - Generate and commit `packages/ui/test/fixtures/oncall-pushed.json`.
   - Update CLI list formatting.
2. **Task 5 (Security / Invariant Boundary):**
   - Update `gateway_bridge.rs`, `security-invariants.test.ts`, and docs in ONE single commit.
3. **Tasks 6 – 9 (Desktop UI Layer):**
   - Implement store slice, `NavItem` dot, `OncallBriefsProvider`, and the `/oncall` page with its subcomponents.
4. **Tasks 10 – 11 (Documentation & Verification):**
   - Update docs, run whole-branch checks, and strip spec/plan review files before opening PR.

---

## 5. Conclusion

The plan is approved and ready for execution via subagent-driven development or direct execution. Incorporate the small `newestId !== pruned` loop guard in Task 9 during implementation.
