# Design Review: Role Packs — Project 4: Desktop (`2026-10-24-role-packs-p4-desktop-design.md`)

**Reviewed document:** `docs/superpowers/specs/2026-10-24-role-packs-p4-desktop-design.md`  
**Companion documents:**
- `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md` (overview)
- `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` (Project 1 foundations)
- `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md` (Project 3 pack design)
- `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design-review.md` (Project 3 review)

**Review date:** 2026-10-25

---

## Overall Assessment

The Project 4 specification addresses a major UX gap in Nimbus: replacing static, infrastructure-centric gateway dashboards with an actionable, role-tailored workspace that reflects the user's active role packs and makes built-in briefs directly runnable and readable.

The architectural principles in the design are sound and commendable:
- **Strict adherence to security invariants (I7):** every added IPC method is read-only (`catalog.list`, `pack.list`, `fleet.briefs`, `fleet.show`, and read-only brief invocations). Mutating methods (`pack.install`, `pack.remove`, `fleet.runNow`) remain strictly in the CLI.
- **Surface reduction:** removing `agents.preflight` (which raises HITL approvals) and `agents.premortem` (which writes paused watchers) shrinks the capabilities exposed to a webview.
- **Zero auto-run anti-goal:** preventing automatic agent execution on page load or timers protects model token budgets and owner privacy.
- **CSP integrity:** maintaining the strict CSP without inline style sinks or `dangerouslySetInnerHTML`.

Cross-checking the specification against the Gateway, Tauri Rust bridge, and UI codebases identified **4 codebase mismatches**, **7 concrete design improvements / failure modes**, and **5 open questions** to address before implementation.

---

## 1. Codebase Mismatches to Correct in the Spec

### 1.1 `fleet_brief` has `subject_key TEXT NOT NULL`: querying `subjectKey: null` will return 0 rows (§ 5.3, § 8 item 5)

- **Spec claim (§ 5.3, § 8 item 5):**  
  *"for other agents, the newest `fleet.briefs` row for that agent's method from any job, with a **null `subjectKey`** (a sweep's per-subject brief is not a general answer) and a non-null `briefMarkdown`... gateway change (my call): `fleet.briefs` gains an optional `agentMethod` filter and an optional **`subjectKey: null`** match..."*
- **Actual code (`packages/gateway/src/index/fleet-subjects-v63-sql.ts:4, 22`, `packages/gateway/src/fleet/fleet-scheduler.ts:329`, `packages/gateway/src/fleet/fleet-digest.ts:35`, `packages/gateway/src/ipc/fleet-rpc.ts:114-118`):**
  1. In the V63 migration (`fleet-subjects-v63-sql.ts:4, 22`):
     ```sql
     subject_key TEXT NOT NULL
     ```
     `subject_key` is `TEXT NOT NULL` across the entire database. No row in `fleet_brief` ever has `subject_key IS NULL`.
  2. For non-sweep (config-named) jobs, `FleetScheduler.runOneJob` (`fleet-scheduler.ts:329`) records:
     ```ts
     this.deps.store.recordBrief({
       runId,
       jobId: job.name,
       subjectKey: job.name, // <--- subjectKey IS the job.name, NOT null!
       agentMethod: `agents.${job.agent}`,
       ...
     });
     ```
     As documented in `fleet-digest.ts:35`: *"for a config-named job the subject IS the job: `subjectKey = jobId`"*.
  3. Conversely, sweep jobs record `subjectKey: subject.key` (e.g. `"services:checkout"`, `"paths:file:/r:src/a.ts"`), where `subject_key != job_id`.
  4. In `fleet-rpc.ts:114-118`, `optString` rejects anything that is not a non-empty string. Passing `subjectKey: null` currently raises a JSON-RPC `-32602` error.
- **Correction:**  
  If `fleet.briefs` searches for `subject_key IS NULL`, it will return zero rows for every agent. To filter for general non-sweep briefs, the query must distinguish config-named jobs from sweeps:
  - Add an explicit filter parameter to `fleet.briefs`, such as `nonSweepOnly: boolean` (or `isSweep: boolean`). In SQL on `fleet_brief`, non-sweep rows satisfy `subject_key = job_id` (or `subject_key NOT LIKE '%:%'`).

---

### 1.2 Outdated `src-tauri/` paths in the spec (§ 2, § 5.1)

- **Spec claim (§ 2, § 5.1):**  
  Cites `src-tauri/src/gateway_bridge.rs:78`, `src-tauri/tauri.conf.json:28`.
- **Actual code (`packages/ui/src-tauri/`):**  
  `dev/asaf/desktop-migration` merged as part of #1709, #1711, #1713 and relocated `src-tauri/` inside `packages/ui/src-tauri/`.
- **Correction:**  
  Update paths in § 2 and § 5.1 to `packages/ui/src-tauri/src/gateway_bridge.rs` and `packages/ui/src-tauri/tauri.conf.json`.

---

### 1.3 `oncall.pushedList` does not return `briefMarkdown` for card previews (§ 5.3)

- **Spec claim (§ 5.3):**  
  *"A card shows: ... for `oncall`, the newest `oncall.pushedList` brief; its age ('3 h ago') and the first lines of the rendered markdown, clipped, with 'Open' going to the full stored brief;"*
- **Actual code (`packages/ui/src/ipc/types.ts:480-499`, `packages/gateway/src/ipc/oncall-push-rpc.ts`):**
  1. `oncall.pushedList` returns `PushedBriefSummary[]`:
     ```ts
     export interface PushedBriefSummary {
       readonly incidentId: string;
       readonly status: "ok" | "failed";
       readonly createdAt: number;
       readonly retriedAt: number | null;
       readonly title: string | null;
       readonly service: string | null;
     }
     ```
     Notice that `PushedBriefSummary` **does not contain `briefMarkdown`**.
  2. Only `oncall.pushedGet { incidentId }` returns `PushedBriefDetail`, which contains `briefMarkdown`.
- **Correction:**  
  Clarify in § 5.3 how the on-call card gets its preview text:
  - Either the on-call card shows `title` and `service` ("Incident INC-123 · checkout service") rather than clipped markdown, OR
  - When the on-call card detects a newest brief in `oncall.pushedList`, it issues an `oncall.pushedGet` call to fetch `briefMarkdown` for the preview snippet.

---

### 1.4 `useIpcQuery` does not listen to window `focus`, only `visibilitychange` (§ 5.7, § 8 item 4)

- **Spec claim (§ 5.7, § 8 item 4):**  
  *"the app re-reads `pack.list` (and `catalog.list`) when the window regains focus, and every 15 s while visible, through the existing `useIpcQuery` polling hook."*
- **Actual code (`packages/ui/src/hooks/useIpcQuery.ts:51, 60-67`):**
  1. `useIpcQuery` attaches only a `visibilitychange` listener:
     ```ts
     const onVis = () => {
       if (document.visibilityState === "visible") run().catch(() => undefined);
     };
     document.addEventListener("visibilitychange", onVis);
     ```
  2. In desktop OS window managers (Windows, macOS, Linux), switching focus between a terminal and an uncovered or side-by-side Tauri desktop window **does not trigger a `visibilitychange` event** (the webview document remains `visibilityState === "visible"`).
  3. Consequently, switching back to the app from the terminal will not trigger an immediate refresh unless the window was minimized or until the 15 s timer fires.
- **Correction:**  
  Explicitly specify in § 5.7 that `useIpcQuery` must be augmented to subscribe to `window.addEventListener("focus", ...)` in addition to `visibilitychange`.

---

## 2. Concrete Design Improvements & Failure Modes

### 2.1 Missing "Stored-Brief View" Route & Navigation Contract (§ 5.3, § 5.5, § 5.6)

- **Problem:**  
  § 5.3 states that clicking "Open" on a home card goes to "the full stored brief", § 5.6 refers to "the stored-brief view", and § 5.1 adds `fleet.show` to the allowlist. However, § 5.5 only defines routes for `/briefs` (index) and `/briefs/:agent` (which renders the live form and in-memory store results). There is no route or modal defined for viewing stored briefs!
  - If a user clicks "Open" on the Decisions card displaying an overnight fleet brief, where does the router take them?
  - If it navigates to `/briefs/decisions`, § 5.5 says `/briefs/:agent` displays the *latest requested run from the in-memory store*, not the stored fleet brief.
- **Recommendation:**  
  Define the routing and viewing contract for stored briefs explicitly:
  - Either add a route `/briefs/stored/:fleetBriefId` (which calls `fleet.show { id }` and renders the markdown), OR
  - Allow `/briefs/:agent?storedId=<id>` where the page loads and displays the stored brief when `storedId` is present, OR
  - Render stored briefs in a slide-over drawer / modal.
  - For `oncall`, clicking "Open" should route directly to `/oncall?incidentId=<id>` (which already uses `BriefDetail`).

---

### 2.2 Tauri External Link Opener Permissions in `capabilities/default.json` (§ 5.6)

- **Problem:**  
  § 5.6 specifies:
  > *"http(s) links open in the system browser through the existing Tauri opener path, if one exists. Otherwise they render as plain text showing the URL."*
  
  In the current desktop codebase:
  1. There is **no existing Tauri opener path** in `packages/ui/src` (zero imports of `@tauri-apps/plugin-shell` or `@tauri-apps/plugin-opener`).
  2. `packages/ui/src-tauri/capabilities/default.json` grants only:
     `core:default`, `shell:allow-spawn`, `shell:allow-execute` (for `nimbus start`), `global-shortcut`, `clipboard-manager`, `dialog`, `fs:allow-write-text-file`.
  3. It does **not** grant `shell:allow-open` or `opener:default`. Under Tauri v2 security policies, attempting to open a URL from the webview will be rejected.
- **Recommendation:**  
  Decide whether Project 4 permits external browser navigation:
  - If external URLs should open in the system browser, update `packages/ui/src-tauri/capabilities/default.json` to grant `shell:allow-open` (scoped strictly to `http` and `https` schemes).
  - If external links are kept as plain text (no opener capability), state clearly in § 5.6 that no Tauri opener capability currently exists, so all links will render as plain text URLs unless capability expansion is explicitly approved.

---

### 2.3 Race Condition: Microtask Race in `emitBriefWithSynthesis` vs Store Registration (§ 5.5)

- **Problem:**  
  `emitBriefWithSynthesis` (`packages/gateway/src/agents/_lib/emit-brief.ts:57-74`) executes its async IIFE *immediately* before resolving `{ sessionId }`:
  ```ts
  void (async () => {
    const brief = await opts.buildBrief();
    ...
    opts.notify(opts.briefReadyMethod, { sessionId: opts.sessionId, brief: markdown, ... });
  })().catch(...);
  return Promise.resolve({ sessionId: opts.sessionId });
  ```
  If an agent runs very quickly (e.g. local index query with cached or mocked synthesis) or fails synchronously, the `<agent>.briefReady` or `<agent>.briefError` IPC notification can arrive at the webview **before** the `client.call("agents.<name>")` Promise resolves with `{ sessionId }`.
  If the UI store only starts listening or registers the active `sessionId` *after* `client.call()` resolves, the completion notification will be dropped, leaving the card or page permanently stuck in "Waiting / Elapsed time".
- **Recommendation:**  
  The app-level store must maintain a global notification listener that buffers incoming `<agent>.briefReady` and `<agent>.briefError` notifications by `sessionId`, so that if a notification arrives before `client.call()` returns `{ sessionId }`, the result is immediately matched and not lost.

---

### 2.4 Federated Agents (`huddle`, `ghost`) and LAN Query Behavior (§ 5.5)

- **Problem:**  
  § 5.5 claims:
  > *"The `namespace` and `namespaces` parameters make the gateway call paired peers, so the desktop form omits them and briefs run against the local index only."*
  
  This misunderstands how federated agents operate in the Gateway:
  1. `agents.huddle` (`packages/gateway/src/agents/huddle.ts:95-110`) **has no local index search**. When `namespaces` is omitted or empty, it queries all known namespaces in the database and fans out over LAN/wire to paired peers!
  2. `agents.ghost` (`packages/gateway/src/agents/ghost.ts:53`) calls `fanOutExpertise` over the LAN across all paired peers, regardless of whether `namespaces` is specified.
- **Recommendation:**  
  Omitting `namespace`/`namespaces` from form fields does not convert a federated agent into a local-only agent.
  - Update the description in § 5.5 to accurately state that federated agents (`huddle`, `ghost`) will still query paired LAN peers using their default discovery logic.
  - Alternatively, if the desktop UI is intended to be local-only, explicitly exclude pure-federation agents like `huddle` from `/briefs`.

---

### 2.5 Sidebar Layout & Vertical Overflow in Narrow `w-[150px]` Container (§ 5.4)

- **Problem:**  
  `packages/ui/src/components/chrome/Sidebar.tsx:25` defines a fixed-width container:
  ```tsx
  <nav className="w-[150px] bg-[var(--color-bg)] border-r border-[var(--color-border)] py-2 flex flex-col">
  ```
  Today, it has 8 items. With Project 4:
  - 8 existing items
  - 1 "Briefs" link
  - Active pack groups (e.g. DevOps with 7 agents, PM with 3 agents)
  - This totals 21+ navigation links in a 150px sidebar. In standard desktop windows (min height 640px), this will overflow and get clipped because `Sidebar.tsx` has no `overflow-y-auto`.
  - Furthermore, labels like "Changelog" or "Pre-mortem" in `w-[150px]` with icons and padding risk severe truncation or wrapping.
- **Recommendation:**  
  - Ensure `Sidebar.tsx` specifies `overflow-y-auto` and smooth scrolling.
  - Provide collapsible pack group headers in the sidebar so users can collapse packs they aren't actively using.

---

### 2.6 Two-Phase Error Handling on `/briefs/:agent` (§ 5.5)

- **Problem:**  
  § 5.5 mentions waiting for `<agent>.briefError`. However, errors can happen in two distinct phases:
  1. **Synchronous RPC rejection:** If the user submits invalid parameters, `ipc/agents-rpc.ts` throws `-32602` immediately upon `client.call()`.
  2. **Asynchronous brief error:** If parameter parsing succeeds but generation/synthesis fails, the gateway emits `<agent>.briefError` with `{ sessionId, error }`.
- **Recommendation:**  
  Explicitly specify both phases in § 5.5: the form must capture synchronous `client.call` Promise rejections (displaying validation errors directly on the form) as well as listening for asynchronous `<agent>.briefError` notifications while in the pending state.

---

### 2.7 Status of `agents.whyPeek` on the Allowlist (§ 5.1, § 5.5)

- **Observation:**  
  § 5.1 removes `agents.preflight` and `agents.premortem` from the allowlist because they are not needed in the UI. § 5.5 notes that `agents.whyPeek` is excluded from `/briefs` because it is an internal shape.
  However, `agents.whyPeek` remains on the Tauri allowlist (`gateway_bridge.rs:94`).
- **Recommendation:**  
  Evaluate whether `agents.whyPeek` should also be removed from the allowlist. If no desktop view or component calls `agents.whyPeek`, removing it further reduces attack surface and aligns with the rationale for removing `preflight` and `premortem`.

---

## 3. Open Questions for Owner / Author

1. **Stored Brief Navigation Destination:**  
   When a user clicks "Open" on a card showing an overnight fleet brief (e.g. Decisions or Catch-up), what is the exact route or modal presented? Should it be `/briefs/stored/:id` calling `fleet.show`, or a drawer over the dashboard?
2. **External Link Policy:**  
   Should links in rendered briefs remain non-clickable plain text, or should Tauri's `capabilities/default.json` be updated to permit `shell:allow-open` for `http(s)` URLs?
3. **Non-Sweep Brief Filter in `fleet.briefs`:**  
   Since `subject_key` is `TEXT NOT NULL` and equals `job_id` for non-sweep jobs, does the owner prefer `fleet.briefs` to gain a `nonSweepOnly: true` boolean filter, or an explicit `isSweep: boolean` parameter?
4. **Federated Agents Scope on Desktop:**  
   Given that `huddle` has no local index search and always queries LAN peers across all namespaces, should `huddle` be included on `/briefs`, or should pure-federation briefs remain CLI-only until desktop federation management is built?
5. **Markdown Parser Dependency Selection:**  
   Given Nimbus's strict zero-sink and CSP rules, is adopting `react-markdown` (without `rehype-raw`, mapping `a` and `img` to custom secure components) preferred over writing a custom, ad-hoc regex parser for markdown tables and lists?
