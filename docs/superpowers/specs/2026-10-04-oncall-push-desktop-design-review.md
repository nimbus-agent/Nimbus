# Review: On-call pushed brief, PR 3 (Desktop Panel Design)

**Target Spec:** `2026-10-04-oncall-push-desktop-design.md`  
**Review Date:** 2026-10-04  
**Status:** Review complete · Ready for implementation planning  

---

## 1. Executive Summary

The design document is well-scoped, concise, and aligns with Nimbus architecture principles:
- **Local-first & Event-driven:** Reuses the existing `gateway://notification` event stream (`gateway.event` with `kind: "oncall.briefPushed"`) with a 60 s polling backstop.
- **Security Invariants Preserved:**
  - **I7 (Tauri allowlist):** Only adds read-only methods (`oncall.pushedGet` and `oncall.pushedList`, 105 → 107). Keeps the mutating/agent-triggering `oncall.pushedRetry` CLI-only.
  - **I8 (CSP):** Renders stored markdown verbatim in `<pre>` text nodes with no `dangerouslySetInnerHTML`, no HTML parsing, and no external dependencies.
  - **LAN Invariant:** `oncall` namespace remains `FORBIDDEN_OVER_LAN`.
- **Contract Testing:** Binds the gateway RPC output to desktop tests via a shared, normalized JSON fixture (`packages/ui/test/fixtures/oncall-pushed.json`).

Below are specific **open questions**, **architectural & performance improvements**, **edge cases**, and **implementation suggestions** to incorporate before implementation.

---

## 2. Open Questions & Clarifications

### Q1: Sidebar Unread Dot Lifecycle on Live Arrival
- **Spec Statement:**
  > "Mounting the page records `lastSeenPushedAt`."  
  > "Sidebar dot: It is shown when the newest brief's `createdAt > lastSeenPushedAt`, and hidden after `/oncall` mounts."
- **Question:** What happens if the user already has `/oncall` open when a new `oncall.briefPushed` event arrives?
  - If `markPushedSeen` only fires on initial mount (`useEffect(..., [])`), the arrival of a new brief will update `briefs`, causing `newestBrief.createdAt > lastSeenPushedAt` to evaluate to `true`. This would turn the sidebar unread dot ON while the user is actively viewing `/oncall`.
- **Recommendation:** When `/oncall` is active/mounted, an effect should call `markPushedSeen(newest.createdAt)` whenever `newest` updates, so active viewers do not see an unread badge for a page they are already looking at.

### Q2: URL Search Param Synchronization (`?id=`)
- **Spec Statement:**
  > "The selection is the `id` URL search param. With none, the newest brief is selected."  
  > "`pushedGet` returns `{ brief: null }` for the selection → 'This brief was pruned (older than `retention_days`).' The selection is cleared from the URL."
- **Question:** When navigating to `/oncall` (without `?id=`), should the UI actively update the URL query string with `setSearchParams({ id: newest.incidentId }, { replace: true })`, or keep the URL as `/oncall` and only default the selection in React state?
- **Recommendation:** Actively sync the URL via `replace: true`. This ensures copy-pasting the URL, refreshing the browser, or navigating back/forward retains the exact brief selection consistently.

### Q3: CLI Formatting for `service` in `nimbus oncall pushed list`
- **Spec Statement:**
  > "`cli` `nimbus oncall pushed list` | Prints `service` when non-null. It is already in the payload."
- **Question:** What is the exact column alignment / layout for `nimbus oncall pushed list` when `service` is present vs null?
- **Current format:**
  ```text
  <ISO-TIMESTAMP>  <STATUS>  <INCIDENT-ID>  <TITLE>
  ```
- **Proposed format:**
  ```text
  <ISO-TIMESTAMP>  <STATUS>  <INCIDENT-ID>  [<SERVICE>]  <TITLE>
  ```
  *(or an aligned column: `<ISO-TIMESTAMP>  <STATUS>  <SERVICE:-16>  <INCIDENT-ID>  <TITLE>`)*. Specifying this avoids fixture churn between CLI and gateway unit tests.

### Q4: `BriefDetail` Subscription Mechanism
- **Spec Statement:**
  > "`BriefDetail.tsx` (new) Fetches `oncall.pushedGet { incidentId }` for the selection. It refetches when an `oncall.briefPushed` event names that id, which covers a retry that turned `failed` into `ok`."
- **Question:** Does `BriefDetail` subscribe directly to `gateway://notification` via `useIpcSubscription`, or does `OncallBriefsProvider` manage notification dispatching?
- **Recommendation:** `BriefDetail` can subscribe to `gateway://notification` directly with a targeted check `(n.params as any)?.payload?.incidentId === incidentId` to trigger its local `refetch()`. It should use the `generationRef` / cancelable pattern (identical to `useIpcQuery`) to prevent out-of-order responses when switching between incidents quickly.

---

## 3. Improvements & Architectural Suggestions

### 3.1 SQLite Query Optimization in `PushStore` (Avoid N+1 Queries)
- In `gateway/src/oncall-push/push-store.ts`, `summarize()` needs both `incidentTitle` and the incident's `pagerduty_service_id`.
- If `PushStore.list(50)` performs per-row `incidentTitle()` and per-row `incidentService()` queries, that results in 101 SQLite queries for one list fetch.
- **Suggestion:** Use a single `LEFT JOIN` query in `PushStore.list()`:
  ```sql
  SELECT 
    pb.incident_id,
    pb.session_id,
    pb.status,
    pb.failure_code,
    pb.brief_markdown,
    pb.brief_json,
    pb.created_at,
    pb.delivery_json,
    pb.retried_at,
    i.title AS incident_title,
    json_extract(i.metadata, '$.pagerduty_service_id') AS incident_pd_service_id
  FROM pushed_brief pb
  LEFT JOIN item i ON i.id = pb.incident_id AND i.type = 'incident'
  ORDER BY pb.created_at DESC, pb.incident_id ASC
  LIMIT ?
  ```
- This resolves the incident title, PagerDuty service ID, and brief row in **1 single SQLite query** without extra lookups.

### 3.2 Add Missing Component to Section 2.2 Table: `NavItem.tsx`
- Section 2.2 mentions modifying `Sidebar.tsx` to add `{ to: "/oncall", icon: "☎", label: "On-call" }` with an accessible dot.
- However, `packages/ui/src/components/chrome/NavItem.tsx` currently only supports numeric badges:
  ```tsx
  interface NavItemProps {
    readonly to: string;
    readonly icon: string;
    readonly label: string;
    readonly badge?: number | undefined;
  }
  ```
- **Suggestion:** Explicitly include `packages/ui/src/components/chrome/NavItem.tsx` in Section 2.2:
  - Add `dot?: boolean` and `dotAriaLabel?: string` (or `badge?: number | { dot: boolean; label: string }`).
  - Render a small accent dot with an accessible `<span className="sr-only">new pushed brief</span>` (or `aria-label`).

### 3.3 UX Ergonomics: "Copy Brief" & "Copy Retry Command"
- While a full markdown renderer is intentionally out of scope (to prevent CSP risks and dependencies), on-call responders frequently copy incident details into Slack/incident channels or run CLI commands.
- **Suggestions:**
  1. **"Copy Brief" Button:** In `BriefDetail.tsx`, add a simple "Copy Markdown" button that writes `briefMarkdown` to the clipboard with temporary visual feedback ("Copied!").
  2. **"Copy Command" Button:** In `BriefDetail.tsx` on failed rows, place a copy icon next to `nimbus oncall pushed <id> --retry`.

---

## 4. Edge Cases & Failure Handling Checklist

| Edge Case | Expected Behavior | Verification Note |
|---|---|---|
| **Incident title is null** | `BriefList` displays `b.incidentId` in place of title. | Covered in spec § 3 & § 4. |
| **Service is null / unmapped** | Summary payload has `service: null`. `BriefList` hides service tag or renders neutral fallback without crashing. | Test with unmapped and missing incident rows. |
| **Pruned brief via direct URL `?id=old-id`** | `pushedGet` returns `{ brief: null }`. Displays: *"This brief was pruned (older than retention_days)."* and clears `?id=` param. | Assert URL param removal and empty state display. |
| **XSS / HTML injection in markdown** | Text like `<img src=x onerror=alert(1)>` renders as plain literal text in `<pre>`. DOM contains no `<img>` or script tags. | Assert via Testing Library `screen.getByText` and query selector checks. |
| **Rapid selection switching** | Rapidly clicking different rows in `BriefList` does not overwrite detail with stale async responses. | Guarded by `generationRef` in `useIpcQuery` / fetch handler. |
| **Tauri bridge reconnect** | When gateway disconnects and reconnects, `useOncallBriefs` triggers `refetch()` when connection state returns to `connected`. | Supported by `useIpcQuery` connection listener. |
| **Malformed `gateway.event`** | Notification with missing `params` or non-object `payload` is silently ignored, never throwing in context. | Unit test with `params: null`, `params: {}`, `kind: "other"`. |

---

## 5. Security & Invariant Checklist

1. **Tauri Allowlist (I7)**:
   - `ALLOWED_METHODS` in `ui/src-tauri/src/gateway_bridge.rs`: 105 → 107.
   - Insert in sorted alphabetical order:
     ```rust
     "llm.unloadModel",
     "oncall.pushedGet",
     "oncall.pushedList",
     "policy.show",
     ```
   - Neither method is in `NO_TIMEOUT_METHODS`.
   - `oncall.pushedRetry` is verified absent.
   - `packages/gateway/src/security-invariants.test.ts`: update allowlist exact size test (105 → 107) and add named assertion.
   - `docs/SECURITY-INVARIANTS.md`: Add ledger paragraph explaining the 105 + 2 = 107 transition.

2. **Persistence Whitelist**:
   - `WHITELISTED_PERSIST_KEYS` in `packages/ui/src/store/partialize.ts` must include `"lastSeenPushedAt"`.
   - Forbidden keys check must remain clean.

3. **LAN Protection**:
   - Verify `oncall` namespace remains in `FORBIDDEN_OVER_LAN` in `packages/gateway/src/ipc/lan-rpc.ts`.

---

## 6. Recommended Next Steps

1. Update the spec to include `packages/ui/src/components/chrome/NavItem.tsx` in Section 2.2 and clarify live unread dot behavior (Q1).
2. Proceed with writing the implementation plan following the 3-layer approach (Gateway/PushStore → Rust Allowlist → UI Provider & Components).
3. Generate the contract fixture `packages/ui/test/fixtures/oncall-pushed.json` as the bridge between gateway and desktop tests.
