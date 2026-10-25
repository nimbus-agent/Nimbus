# Review: Role Packs P4 — Desktop Implementation Plan

**Reviewed plan:** [2026-10-25-role-packs-p4-desktop.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-25-role-packs-p4-desktop.md)  
**Parent spec:** [2026-10-24-role-packs-p4-desktop-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-24-role-packs-p4-desktop-design.md)  
**Spec review:** [2026-10-24-role-packs-p4-desktop-design-review.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-24-role-packs-p4-desktop-design-review.md)  
**Date:** 2026-10-25  

---

## Executive Summary

The Project 4 desktop implementation plan is exceptional in its rigor, structure, and fidelity to Nimbus engineering standards. It directly addresses the architectural concerns raised in the design review:
- Resolves the `fleet_brief` schema mismatch by introducing an explicit `nonSweep: true` predicate (`subject_key = job_id`) rather than the invalid `subjectKey: null`.
- Protects against the `emitBriefWithSynthesis` microtask race condition via a dedicated `early` buffer (`EARLY_BUFFER_MAX = 20`, `EARLY_BUFFER_TTL_MS = 60_000`).
- Implements strict, zero-sink markdown parsing using `marked.lexer` with plain-text URL rendering and alt-text-only images.
- Enforces the owner's precedence (`[agents] visible`) and handles excluded / federated agents cleanly.
- Defines a dedicated route `/briefs/stored/:id` for stored fleet briefs.

A detailed walkthrough of the 10 tasks against [`packages/gateway`](file:///C:/gitrep/Nimbus/packages/gateway), [`packages/ui/src-tauri`](file:///C:/gitrep/Nimbus/packages/ui/src-tauri), and [`packages/ui`](file:///C:/gitrep/Nimbus/packages/ui) identifies **4 implementation traps / edge cases to guard against**, **4 concrete implementation refinements**, and **4 builder clarifications**.

---

## 1. Implementation Traps & Edge Cases to Guard Against (Must-Address)

### 1.1 SQL Parameter Binding Alignment in `FleetStore.listBriefs` (Task 1)

In Task 1 Step 4:
> *"Store: append `agent_method = ?`, `subject_key = job_id`, `brief_markdown IS NOT NULL` to `where` when set/true."*

**The Trap:**
- In [`packages/gateway/src/fleet/fleet-store.ts:308-320`](file:///C:/gitrep/Nimbus/packages/gateway/src/fleet/fleet-store.ts#L308-L320), the SQL query is constructed dynamically:
  ```ts
  const where: string[] = ["expires_at > ?"];
  const params: (string | number)[] = [q.now];
  if (q.jobId !== undefined) {
    where.push("job_id = ?");
    params.push(q.jobId);
  }
  if (q.subjectKey !== undefined) {
    where.push("subject_key = ?");
    params.push(q.subjectKey);
  }
  ```
- Two of the new filters are **predicates without parameters**:
  - `subject_key = job_id` (a direct column-to-column comparison).
  - `brief_markdown IS NOT NULL` (a nullity check).
- Only `agent_method = ?` pushes a value (`q.agentMethod`) into `params`.
- Finally, `params.push(q.limit)` binds the `LIMIT ?` clause.
- **Danger:** If an implementer accidentally writes `where.push("subject_key = ?")` with `params.push(q.jobId)` or pushes anything for `nonSweep` / `withMarkdown`, the positional parameter index in `db.query(...).all(...params)` will shift, binding `q.limit` or booleans to the wrong column and causing SQLite errors or silent query failure.

**Recommendation:**  
Ensure the builder constructs the SQL predicates with strict parameter parity:
```ts
if (q.agentMethod !== undefined) {
  where.push("agent_method = ?");
  params.push(q.agentMethod);
}
if (q.nonSweep === true) {
  where.push("subject_key = job_id");
}
if (q.withMarkdown === true) {
  where.push("brief_markdown IS NOT NULL");
}
```

---

### 1.2 Asynchronous Submission Gap in `BriefRun.tsx` (Tasks 6 & 8)

In Task 8 Step 2:
> *"BriefRun: mounting calls no `agents.*`; Run calls `start("decisions", params)`; a rejected `start` shows its message beside the form; pending shows elapsed time and a disabled Run"*

**The Trap:**
- `start(agent, params)` in `useBriefRuns` is an asynchronous function:
  ```ts
  const res = await createIpcClient().call<{ sessionId: string }>(`agents.${agent}`, params);
  registerRun(res.sessionId, agent);
  ```
- Between the user clicking **Run** and the IPC promise resolving with `{ sessionId }`:
  - `latestRun` in the store has **not yet transitioned to `status: "pending"`**.
  - If the Run button is disabled solely by `run?.status === "pending"`, the button remains enabled for 20–200 ms during the IPC network/socket hop.
  - A rapid double-click will dispatch two concurrent `agents.<agent>` calls to the gateway, triggering two model syntheses and conflicting sessions.

**Recommendation:**  
In `BriefRun.tsx`, maintain a local `isStarting` state (or expose `isStarting(agent): boolean` from `useBriefRuns`):
```tsx
const [isStarting, setIsStarting] = useState(false);

const handleRun = async (params: Record<string, unknown>) => {
  setIsStarting(true);
  try {
    await start(agent.name, params);
  } catch (err) {
    setRpcError(err instanceof Error ? err.message : String(err));
  } finally {
    setIsStarting(false);
  }
};

const isPending = isStarting || run?.status === "pending";
```
Disable the button whenever `isPending` is true.

---

### 1.3 Stale Data on Parameter Change in `StoredBrief.tsx` (Task 8)

In Task 8 Step 4:
> *"`StoredBrief` uses `useIpcQuery<unknown>("fleet.show", 300_000, { id })` and narrows the result."*

**The Trap:**
- In [`packages/ui/src/hooks/useIpcQuery.ts:32-46`](file:///C:/gitrep/Nimbus/packages/ui/src/hooks/useIpcQuery.ts#L32-L46), `useIpcQuery` does **not** reset `data` to `null` when `params` change while a query is in-flight.
- If a user navigates from `/briefs/stored/brief-1` to `/briefs/stored/brief-2`:
  - During the fetch of `brief-2`, `data` still holds the response for `brief-1`.
  - Without an explicit guard, `StoredBrief` will momentarily render the wrong brief text for `brief-1` under the title and URL of `brief-2`.

**Recommendation:**  
In `StoredBrief.tsx`, guard against stale query data by matching the brief ID before rendering:
```tsx
const { id } = useParams<{ id: string }>();
const { data, isLoading } = useIpcQuery<{ brief: FleetBriefRow | null }>("fleet.show", 300_000, { id });

const brief = data?.brief;
const isMatching = brief !== undefined && (brief === null || brief.id === id);

if (isLoading || !isMatching) {
  return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
}
```

---

### 1.4 `hasRequiredParams` Must Filter Out Federation Parameters (Task 8)

In Task 8 Step 1:
> *"`hasRequiredParams(agent: CatalogAgent): boolean` (any `required` param, or any `oneOf.required` group)."*

**The Trap:**
- In `agent-catalog.ts`, federation parameters (`namespace`, `namespaces`) are stripped from desktop forms because federation is out of scope for desktop brief forms.
- If an agent or future catalog entry marks a federation parameter as `required`, but the desktop form omits it, `hasRequiredParams` would evaluate to `true` while the user-visible form has no required fields (or vice versa).

**Recommendation:**  
Ensure `hasRequiredParams` filters out `FEDERATION_PARAMS` (`namespace`, `namespaces`) before checking `p.required` or `oneOf.required`:
```ts
export function hasRequiredParams(agent: CatalogAgent): boolean {
  const localParams = agent.params.filter((p) => !FEDERATION_PARAMS.has(p.name));
  return localParams.some((p) => p.required || (p.oneOf !== undefined && p.oneOf.required));
}
```

---

## 2. Concrete Implementation Refinements

### 2.1 `oncall` Card Zero-Pushed-Brief Fallback State (Task 9)

In Task 9 Step 1:
> *"`AgentCard`: for `oncall` with a newest pushed brief → its `title` · `service`, age, Open link `/oncall?id=<incidentId>`, and no `fleet.briefs` call"*

**Refinement:**
- What happens if `useOncallBriefs().list` has no briefs (e.g. freshly installed DevOps pack, or no incidents have paged)?
- The plan explicitly specifies the success case, but must also specify the zero-brief branch:
  - If `oncall` has no newest pushed brief, `AgentCard` must render:
    `No stored brief yet.` and a **Run** link navigating to `/briefs/oncall`.
  - Like all other cards, it must never render an error tile or empty white space.

---

### 2.2 `previewLines` and Heading Hierarchy in Previews (Task 9)

In Task 9 Step 3:
> *"preview is `<Markdown text={previewLines(md)} />` in a `max-h-40 overflow-hidden` box... `previewLines(markdown: string, max = 8): string` (first `max` non-blank lines)"*

**Refinement:**
- Many agent briefs begin with a top-level `# Heading` (e.g. `# Decisions Brief (last 90 days)` or `# Standup Brief`).
- If rendered inside `<Markdown />` in an `AgentCard`, a large `<h1>` (e.g. `text-xl font-bold mb-3`) consumes half of the `max-h-40` card preview height, leaving almost no room for actual content.
- Furthermore, the card header already prominently displays the agent's `displayName` ("Decisions").
- **Suggestion:** In `previewLines`, if the first non-blank line starts with `# `, strip that title line so the preview begins immediately with the synthesis summary or findings.

---

### 2.3 Responsive Card Layout for Home Pack Sections (Task 9)

In Task 9 Step 1:
> *"`Dashboard`: with sections → one header per pack above the existing strip/grid/feed (still rendered)"*

**Refinement:**
- The DevOps pack makes 7 agents visible (`oncall`, `why`, `impact`, `ownership`, `catchup`, `changelog`, `standup`).
- If rendered in a single un-wrapped horizontal flex row on a standard 1024px or 1200px desktop screen, each card would be squashed into a ~120px column.
- **Suggestion:** Use a responsive CSS grid for pack sections:
  ```tsx
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
    {section.agents.map((agent) => (
      <AgentCard key={agent.name} agent={agent} />
    ))}
  </div>
  ```
  This guarantees readable cards with proper padding on all desktop display sizes.

---

### 2.4 Duration Selector Presets for `sinceMs` (Task 8)

In Task 8 Step 4:
> *"the `sinceMs` control is your call"*

**Refinement:**
- `sinceMs` is typed as a number in JSON-RPC. Expecting users to type millisecond numbers (e.g. `604800000` for 7 days) in an `<input type="number">` is error-prone.
- **Suggestion:** Implement `sinceMs` as a segmented choice or select dropdown with common duration options:
  - 24 hours (`86_400_000`)
  - 7 days (`604_800_000`)
  - 30 days (`2_592_000_000`)
  - 90 days (`7_776_000_000`)
  - Blank / Default (omitted)

---

## 3. Open Questions & Builder Clarifications

1. **Copy-as-Markdown Visual Feedback:**  
   In `BriefRun` and `StoredBrief`, when the user clicks the "Copy as markdown" button, should the button text temporarily switch to `"Copied!"` for 2 seconds (using a local `useState` timer) before reverting?
   *(Recommendation: Yes, this provides essential tactile feedback in a desktop app).*

2. **Sidebar Iconography for Briefs & Agents:**  
   What icon should be used for the top-level `Briefs` item and pack group items?  
   *(Recommendation: Use `📄` or `📋` for Briefs, and a subtle bullet `•` or category icon for individual agents under pack groups).*

3. **Breadcrumbs / Back Navigation on Brief Pages:**  
   When navigating to `/briefs/:agent` or `/briefs/stored/:id`, should `PageHeader` include a back link or breadcrumb (e.g. `← Briefs / Decisions`)?  
   *(Recommendation: Yes, a simple back link to `/briefs` improves navigation ergonomics).*

4. **Gateway Offline Recovery Behavior in `useRolePacks`:**  
   If the gateway starts after the desktop app, or restarts mid-session, does `useRolePacks` recover automatically?  
   *(Confirmation: Yes, because `useIpcQuery` checks `connectionState === "connected"` and re-runs on focus and on its 15 s timer once reconnected).*

---

## Disposition (2026-10-25)

Every item was checked against the code before acting. All 12 hold; 11 are fixed in the plan, 1 needed no change.

| # | Item | Verdict | Plan change |
|---|---|---|---|
| 1.1 | Param binding in `listBriefs` | Correct (`fleet-store.ts:308-320` binds positionally; two new predicates bind nothing) | Task 1 Step 4 states which predicates push a value and that `limit` stays last; new store test runs every filter at once with `limit: 1`, which a stray push would break |
| 1.2 | Double-click before `start` resolves | Correct (the store has no run until `call()` returns) | Task 8: a local `starting` flag OR'd with `pending`; test holds `start` unresolved and asserts a second click does not call it |
| 1.3 | Stale `fleet.show` data across `:id` | Correct (`useIpcQuery` keeps `data` on a params change; React Router reuses the element) | Task 8: `StoredBrief` renders `<StoredBriefView key={id}>`, which remounts the view and works even when the new result is `{ brief: null }`, where an id-match guard could not tell; test added |
| 1.4 | `hasRequiredParams` vs federation params | Latent: `namespace`/`namespaces` are optional in `catalog/agent-catalog.ts` today | Defined over `buildFormModel(...)` output so it can never disagree with the form; test with a required-`namespace` fixture |
| 2.1 | On-call card with no pushed brief | Correct gap: spec § 5.3 covers it, plan's test only covered `decisions` | Task 9 test: empty pushed list → `No stored brief yet.` + Run to `/briefs/oncall`, no `fleet.briefs` call |
| 2.2 | Leading `# ` title eats the preview | Correct (renderers open with `# Expert: …` etc., `agents/_lib/render.ts`) | `previewLines` drops a leading `# ` line; test added |
| 2.3 | 7 cards in one row | Correct | Task 9: wrapping responsive grid |
| 2.4 | `sinceMs` as raw ms | Correct; it is a look-back window capped at 90 days (`ipc/agents-rpc.ts:100`; 365 for `negotiate`) | `SINCE_PRESETS` select (Default / 24 h / 7 d / 30 d / 90 d); "Default" omits the param so each agent keeps its own default; test added |
| Q1 | Copy feedback | Accepted | `Copied` for 2 s, timer cleared on unmount; test added |
| Q2 | Sidebar icons | Accepted (NavItem requires `icon`) | `📄` for Briefs, `•` for agent links |
| Q3 | Back link | Accepted | `← Briefs` on both brief pages; test added |
| Q4 | Gateway restart recovery | Confirmed: `useIpcQuery`'s effect depends on `connectionState`, so it re-runs on reconnect | None |
