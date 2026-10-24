# Role packs Project 4 — Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app's sidebar and home screen follow the active role packs, every read-only built-in brief runs from a brief page with a catalog-built form, and briefs render as safe formatted markdown.

**Architecture:** Two small gateway read changes (`fleet.briefs` filters, `pack.list` `visibleAgents`), an I7 allowlist edit (+7 −2 → 116), then UI work: a `marked`-lexer → React renderer, an app-level brief-run store that subscribes to notifications before any call, a role-packs provider (focus + 15 s refresh), sidebar groups, brief pages and home cards.

**Tech Stack:** Bun + TypeScript (gateway, `bun test`), Rust (Tauri bridge, `cargo test`), React 19 + react-router 8 + vitest/Testing Library (UI), `marked` 18.1.1 (new UI dependency, lexer only).

**Spec:** `docs/superpowers/specs/2026-10-24-role-packs-p4-desktop-design.md` (branch `dev/asaf/role-packs`). Read it alongside this plan; § numbers below refer to it.

## Global Constraints

- Work in a fresh worktree from `origin/main`: `git worktree add C:\gitrep\Nimbus\.claude\worktrees\role-packs-p4-desktop -b dev/asaf/role-packs-p4-desktop origin/main` (ABSOLUTE path). Never commit on `main`. Specs/plans never land on this branch.
- No `any`; external data is `unknown` and narrowed. Biome clean.
- Edit files with the Edit tool, not Python (CRLF on Windows). Never bare `git stash`.
- Invariant triple rule: the allowlist wiring, its docs and its tests land in ONE commit (Task 3).
- Nothing runs a brief on page load or on a timer. Only a click on **Run** calls `agents.*`.
- No `dangerouslySetInnerHTML`, no `innerHTML`, no `<a href>` and no `<img>` produced from brief text; the CSP and `packages/ui/src-tauri/capabilities/default.json` are unchanged.
- Excluded agents everywhere in the UI: `preflight`, `premortem` (and `whyPeek`, which has no catalog entry).
- Fixed copy (verbatim): `Role packs tailor this screen — see nimbus pack list.` · `No stored brief yet.` · `Asks your paired peers.` · `Still running — check back.` · `This stored brief is no longer available.` · `This run produced no text.`
- Constants (verbatim): runs kept per agent `5`; early-notification buffer `20` entries, TTL `60_000` ms; wait deadline `600_000` ms; pack/catalog poll `15_000` ms.
- Before opening the PR: `bun run preflight:fast`, plus the test commands each task names. The PR title is conventional (`feat(ui): …`), no `!`.

## Review Focus

1. **`fleet.*` unavailable** (fleet store absent → `-32000`, or any error): a home card must fall back to `No stored brief yet.` + Run, never an error tile. Pinned in Task 9.
2. **A notification for a `sessionId` the app never started** (a CLI run on the same gateway, or a late duplicate): buffered then expired, never shown on any page, never crashing the store. Pinned in Task 6.
3. **HTML entities and markup in brief text** (`a & b < c`, `<script>`, `[x](javascript:…)`): render as the literal characters, no element created. Pinned in Task 5.
4. **A pack whose `visibleAgents` names an agent the catalog hides, an excluded agent, or an unknown name**: that agent is absent from the section; a section with zero agents is not rendered. Pinned in Task 7.
5. **Navigating between `/briefs/a` and `/briefs/b` mid-run**: each page shows its own agent's latest run; the run for `a` completing does not appear on `b`. Pinned in Task 8.

---

### Task 1: `fleet.briefs` gains `agentMethod`, `nonSweep`, `withMarkdown`

**Files:**
- Modify: `packages/gateway/src/fleet/fleet-store.ts:302-325` (`listBriefs`)
- Modify: `packages/gateway/src/ipc/fleet-rpc.ts:316-329` (`handleBriefs`), add `optBool` beside `optString` (~`:114`)
- Test: `packages/gateway/src/fleet/fleet-store.test.ts`, `packages/gateway/src/ipc/fleet-rpc.test.ts`
- Docs: `docs/architecture.md` (the `// fleet.briefs` IPC comment near `:3204`)

**Interfaces:**
- Produces: `FleetStore.listBriefs(q: { limit: number; jobId?: string; subjectKey?: string; agentMethod?: string; nonSweep?: boolean; withMarkdown?: boolean; now: number }): FleetBriefRow[]`. Wire params `agentMethod?: string`, `nonSweep?: boolean`, `withMarkdown?: boolean`.

- [ ] **Step 1: Write failing store tests** in `fleet-store.test.ts`, reusing the file's existing record helpers. Seed: job `nightly` (config-named, `subjectKey: "nightly"`) brief A for `agents.decisions` with markdown; job `sweep-svc` brief B for `agents.decisions` with `subjectKey: "services:checkout"`; job `nightly2` brief C for `agents.decisions` with `briefMarkdown: null` (newest); job `g` brief D for `agents.glossary`.

```ts
test("listBriefs filters by agentMethod", () => {
  expect(store.listBriefs({ limit: 10, agentMethod: "agents.glossary", now }).map((b) => b.id)).toEqual([D]);
});
test("nonSweep keeps only rows whose subject is their job", () => {
  const ids = store.listBriefs({ limit: 10, agentMethod: "agents.decisions", nonSweep: true, now }).map((b) => b.id);
  expect(ids).not.toContain(B);
  expect(ids).toContain(A);
});
test("withMarkdown drops null-markdown rows; the three compose to the card query", () => {
  const rows = store.listBriefs({ limit: 1, agentMethod: "agents.decisions", nonSweep: true, withMarkdown: true, now });
  expect(rows.map((b) => b.id)).toEqual([A]);
});
test("false means no filter", () => {
  expect(store.listBriefs({ limit: 10, agentMethod: "agents.decisions", nonSweep: false, withMarkdown: false, now })).toHaveLength(3);
});
```

- [ ] **Step 2: Write failing RPC tests** in `fleet-rpc.test.ts`: `fleet.briefs { agentMethod, nonSweep: true, withMarkdown: true, limit: 1 }` reaches the store with those values; `nonSweep: "yes"` → `-32602` message `fleet: nonSweep must be a boolean`; `withMarkdown: 1` → `-32602`; `agentMethod: ""` → `-32602` (existing `optString` message).
- [ ] **Step 3: Run, verify red:** `bun test packages/gateway/src/fleet/fleet-store.test.ts packages/gateway/src/ipc/fleet-rpc.test.ts` → the new tests FAIL.
- [ ] **Step 4: Implement.** Store: append `agent_method = ?`, `subject_key = job_id`, `brief_markdown IS NOT NULL` to `where` when set/true. RPC: `optBool(params, key): boolean | undefined` throwing `FleetRpcError(-32602, \`fleet: ${key} must be a boolean\`)`; pass each through with the same `...(x === undefined ? {} : { x })` spread. No index, no migration (spec § 6) — say so in the `listBriefs` doc comment: the 500-row cap and retention bound the scan.
- [ ] **Step 5: Document** the three params in the `docs/architecture.md` `fleet.briefs` comment, including the `subject_key = job_id` rule and its bound (a sweep subject key equal to its own job name would pass).
- [ ] **Step 6: Verify green:** same command → PASS.
- [ ] **Step 7: Commit** `feat(fleet): fleet.briefs filters by agent, non-sweep and has-markdown`.

### Task 2: `pack.list` installed rows gain `visibleAgents`

**Files:**
- Modify: `packages/gateway/src/packs/pack-install.ts:80-94` (`PackListResult`), `:459-491` (`installedEntry`)
- Test: `packages/gateway/src/packs/pack-install.test.ts` (or the file holding `listPacks` tests — grep `listPacks(`)
- Docs: `docs/architecture.md` `pack.list` IPC entry (grep `pack.list`)

**Interfaces:**
- Produces: `PackListResult["installed"][number].visibleAgents: readonly string[]`; helper `packVisibleAgents(defaults: string): readonly string[]` exported from `pack-install.ts`.

- [ ] **Step 1: Failing tests:**

```ts
test("packVisibleAgents normalises, dedupes and keeps manifest order", () => {
  expect(packVisibleAgents('[agents]\nvisible = ["agents.decisions", "glossary", "decisions"]\n')).toEqual(["decisions", "glossary"]);
});
test("packVisibleAgents is [] for defaults with no [agents] visible, or invalid defaults", () => {
  expect(packVisibleAgents("")).toEqual([]);
  expect(packVisibleAgents("[agents]\nvisible = 3\n")).toEqual([]);
});
test("listPacks reads visibleAgents from the INSTALLED record, not the bundled copy", () => {
  // install a bundled pack, then hand listPacks a bundled map whose copy of it lists other agents
  // expect(installed[0].visibleAgents) to equal the installed manifest's list
});
test("a row with no readable record (versionUnknown) has visibleAgents []", () => { /* … */ });
```

- [ ] **Step 2: Run, verify red:** `bun test packages/gateway/src/packs` → new tests FAIL.
- [ ] **Step 3: Implement** `packVisibleAgents` with `checkPackFragment(defaults, checkPackFleetJobs)` (as `pack-validate.ts` does): not `ok` → `[]`; else `lists.get("agents.visible") ?? []`, `normaliseAgentName`, first occurrence wins. `installedEntry` sets `visibleAgents: packVisibleAgents(m.defaults)` from `record.manifest`, and `[]` on the no-record branch.
- [ ] **Step 4: Verify green** (same command) and `bun test packages/cli/src/commands/pack.test.ts` still passes (the CLI ignores the field).
- [ ] **Step 5: Document** `visibleAgents` in the architecture `pack.list` entry ("installed record, normalised; the desktop uses it, the CLI does not").
- [ ] **Step 6: Commit** `feat(packs): pack.list rows carry the agents each pack makes visible`.

### Task 3: Tauri allowlist 111 → 116 (I7), with docs and tests in the same commit

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` `:78`; tests `allowlist_premortem_brief_only` `:698`, `allowlist_excludes_fleet_namespace` `:803`, size `:863`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I7 block ~`:1406-1560`)
- Modify: `packages/gateway/src/ipc/allowlist-resolves.test.ts` (server options `:72-103`)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:1463-1465` (fleet comment)
- Docs: `docs/SECURITY-INVARIANTS.md` (§ I7 ledger `:156-168`), `.claude/commands/nimbus-tauri-allowlist.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`, any other hit of Step 6's greps

**Interfaces:**
- Produces: the renderer may call `agents.changelog`, `agents.oncall`, `agents.standup`, `catalog.list`, `fleet.briefs`, `fleet.show`, `pack.list`; not `agents.preflight`, `agents.premortem`.

- [ ] **Step 1: Failing Rust tests.** Replace `allowlist_premortem_brief_only` with `allowlist_preflight_and_premortem_removed` (both absent; `premortem.refresh` absent). Replace `allowlist_excludes_fleet_namespace` with `allowlist_fleet_reads_only`: every `fleet.` entry is `fleet.briefs` or `fleet.show`; both allowed; `fleet.runNow`, `fleet.digest`, `fleet.status`, `fleet.list` absent; comment states why (§ 6: local SQLite text the renderer could regenerate via `agents.*`; `runNow` spends resources). Add `allowlist_pack_list_only` (scan: the only `pack.` entry is `pack.list`; `pack.install`, `pack.remove`, `pack.show` absent) and `allowlist_role_pack_desktop_reads` (`catalog.list`, `agents.oncall`, `agents.standup`, `agents.changelog` allowed). Size `116`.
- [ ] **Step 2: Failing TS tests** in `security-invariants.test.ts`: size test regex `116` (rename to `allowlist_exact_size assertion is 116`); replace the pre-mortem test with one asserting `rust` does NOT match `/^\s*"agents\.premortem",\s*$/m` nor `/^\s*"agents\.preflight",\s*$/m` and contains `assert!(!is_method_allowed("agents.premortem"));`; add one asserting the only `fleet.` list entries are `fleet.briefs`/`fleet.show` and the only `pack.` entry is `pack.list`.
- [ ] **Step 3: Run, verify red:** `cd packages/ui/src-tauri && cargo test allowlist` and `bun test packages/gateway/src/security-invariants.test.ts` → FAIL.
- [ ] **Step 4: Edit `ALLOWED_METHODS`**, keeping alphabetical order (the existing ordering test enforces it): add `agents.changelog` (after `agents.catchup`), `agents.oncall` (after `agents.negotiate`), `agents.standup` (after `agents.ownership`), `catalog.list` (after `captures.list`), `fleet.briefs`/`fleet.show` (after `federation.quorumRespond`), `pack.list` (after `oncall.pushedList`); delete `agents.preflight`, `agents.premortem`.
- [ ] **Step 5: `allowlist-resolves.test.ts`:** add throwing stubs so the new entries resolve: `fleetRpcCtx: { store: { listBriefs: t, getBrief: t }, now: t } as never`, `packLayerStore: { read: t } as never`. Run `bun test packages/gateway/src/ipc/allowlist-resolves.test.ts` → PASS (no `-32601`). If `catalog.list` reports unresolved, wire whatever its arm needs the same way.
- [ ] **Step 6: Docs, same commit.**
  - `docs/SECURITY-INVARIANTS.md` § I7: new paragraph **"Role packs Project 4, desktop (<date>): 111 → 116, the current `allowlist_exact_size`."** with the arithmetic `111 + 7 − 2 = 116`, both lists by name, and the reasons (§ 5.1). In the 109 → 111 paragraph drop the words "the current `allowlist_exact_size`" (`audit:status-drift` reads that phrase). Rewrite the `agents.premortem` "first renderer-exposed method that is not purely a read" paragraph into past tense: it was removed in this change; the I7 reasoning stays as the rule for any future inert-write entry.
  - `.claude/commands/nimbus-tauri-allowlist.md`: both counts → 116, list re-derived.
  - Run and fix every stale statement: `grep -rn "fleet" CLAUDE.md GEMINI.md docs .claude/commands | grep -iE "tauri|allowlist|renderer"`, the same for `premortem\|preflight`, `pack\.` and `catalog\.list`. Known hits: CLAUDE.md/GEMINI.md fleet paragraph ("the whole `fleet` namespace is LAN-forbidden and absent from the Tauri allowlist" → only `fleet.briefs`/`fleet.show` are renderer-callable); `docs/architecture.md:1241` (pre-mortem "Tauri-exposed").
  - `dispatchers.ts:1463-1465` and the new Rust test comment: say why the two fleet reads are allowed and the rest are not.
- [ ] **Step 7: Verify:** `cargo test` (in `packages/ui/src-tauri`), `bun test packages/gateway/src/security-invariants.test.ts packages/gateway/src/ipc/allowlist-resolves.test.ts`, `bun run audit:status-drift`, `bun run audit:doc-refs` → all PASS.
- [ ] **Step 8: Commit** `feat(ui): renderer reads for role packs; drop preflight and premortem (I7 111 → 116)`.

### Task 4: UI wire types and `useIpcQuery` `refetchOnFocus`

**Files:**
- Modify: `packages/ui/src/ipc/types.ts`, `packages/ui/src/hooks/useIpcQuery.ts`
- Test: `packages/ui/test/hooks/useIpcQuery.test.ts`

**Interfaces:**
- Produces (types.ts, all `readonly`): `CatalogParamKind = "string" | "number" | "boolean" | "stringArray"`; `CatalogParam { name; kind: CatalogParamKind; label; required: boolean; oneOf?: { group; arm; required: boolean; armRequired: boolean } }`; `CatalogAgent { name; method; displayName; description; category: "catch-up" | "code" | "knowledge" | "operations" | "people"; roles: readonly string[]; params: readonly CatalogParam[]; surfaces: { external: boolean; fleet: boolean }; visible: boolean }`; `CatalogListResult { agents: readonly CatalogAgent[]; connectors: readonly unknown[]; visibility: { basis: "all" | "packs"; packs: readonly string[]; notes: readonly string[] } }`; `PackListResult { profile; installed: readonly { id; name; version; source: "bundled" | "file"; updateAvailable: boolean; visibleAgents?: readonly string[] }[]; available: readonly unknown[]; skipped: readonly { packId: string; reason: string }[]; listError?: string }` (`visibleAgents` optional: an older gateway omits it); `FleetBriefRow { id; runId; jobId; subjectKey; agentMethod; briefMarkdown: string | null; createdAt: number }`; `FleetBriefsResult { briefs: readonly FleetBriefRow[] }`; `FleetShowResult { brief: FleetBriefRow | null }`.
- Produces: `useIpcQuery(method, intervalMs, params?, opts?: { enabled?: boolean; refetchOnFocus?: boolean })`.

- [ ] **Step 1: Failing tests:** `"refetchOnFocus: a window focus event re-runs the query"` (mount with `{ refetchOnFocus: true }`, clear `callMock`, `window.dispatchEvent(new Event("focus"))`, expect one call); `"without refetchOnFocus, focus does not re-run"`; `"the focus listener is removed on unmount"` (spy `window.removeEventListener` called with `"focus"`).
- [ ] **Step 2: Red:** `cd packages/ui && bunx vitest run test/hooks/useIpcQuery.test.ts` → FAIL.
- [ ] **Step 3: Implement** the option (default `false`) inside the existing effect, beside the `visibilitychange` listener; add the types.
- [ ] **Step 4: Green** (same command), then `bun run --cwd packages/ui typecheck`.
- [ ] **Step 5: Commit** `feat(ui): useIpcQuery can refetch on window focus; wire types for packs, catalog, fleet`.

### Task 5: Markdown renderer (`marked` lexer → React)

**Files:**
- Create: `packages/ui/src/components/markdown/Markdown.tsx`
- Modify: `packages/ui/package.json` (+ lockfile), `packages/ui/src/components/oncall/BriefDetail.tsx:48-50`
- Test: `packages/ui/test/components/markdown/Markdown.test.tsx`; update `packages/ui/test/components/oncall/*` / `test/pages/Oncall.test.tsx` if they assert the `<pre>`

**Interfaces:**
- Produces: `export function Markdown({ text }: { readonly text: string }): ReactNode`.

- [ ] **Step 1: Add the dependency** after the `nimbus-commands` skill's dependency-safety pre-flight: `bun add marked@18.1.1 --cwd packages/ui`. Record the reason for the PR body (zero runtime deps; lexer only; `react-markdown` pulls unified/micromark).
- [ ] **Step 2: Failing tests** (`render(<Markdown text=… />)`, query the `container`):

```ts
it("raw HTML renders as text, creating no element", () => { /* "<b>x</b><script>y</script>" → no b/script element; textContent contains "<b>x</b>" */ });
it("a javascript: link renders as text plus URL, no anchor", () => { /* "[x](javascript:alert(1))" → no a; text contains "x" and "javascript:alert(1)" */ });
it("an http link renders text then the URL as plain text, no anchor", () => { /* "[docs](https://e.x/a)" → no a; text contains "docs" and "https://e.x/a"; an autolink whose text equals its URL shows it once */ });
it("an image shows its alt text and loads nothing", () => { /* "![chart](https://e.x/p.png)" → no img; text contains "chart" */ });
it("entities are literal", () => { /* "a & b < c" → textContent "a & b < c" */ });
it("renders headings, lists, tables, code, blockquote, hr", () => { /* "# H", "1. a\n2. b", "| a | b |\n|---|---|\n| 1 | 2 |", "```\ncode\n```", "> q", "---" → h1, ol>li×2, table th×2 td×2, pre>code "code", blockquote, hr */ });
it("never uses innerHTML", () => { /* spy on Element.prototype innerHTML setter via Object.defineProperty; render a rich doc; expect no set */ });
```

- [ ] **Step 3: Red:** `cd packages/ui && bunx vitest run test/components/markdown` → FAIL.
- [ ] **Step 4: Implement** with `marked.lexer(text, { gfm: true })` only (never `marked.parse`/`marked()`), recursing on `tokens`. `html`, `escape`, and any unrecognised token render their `raw` as text. Links: `<span>{children}</span>` + ` (<span className="select-text font-mono">{href}</span>)`, the URL omitted when it equals the text. Images: alt text. If the lexer's `text` fields arrive HTML-escaped, decode the five basic entities so the "entities are literal" test passes. Tailwind classes only, no `style`.
- [ ] **Step 5:** `BriefDetail` renders `<Markdown text={b.briefMarkdown ?? ""} />` inside the existing bordered container (drop `<pre>`/`font-mono`); update any on-call test that asserted `<pre>`.
- [ ] **Step 6: Green:** `bunx vitest run test/components test/pages/Oncall.test.tsx` → PASS.
- [ ] **Step 7: Commit** `feat(ui): render brief markdown safely through marked's lexer`.

### Task 6: App-level brief-run store

**Files:**
- Create: `packages/ui/src/briefs/brief-runs.ts` (pure), `packages/ui/src/providers/BriefRunsProvider.tsx`, `packages/ui/src/hooks/useBriefRuns.ts`
- Modify: `packages/ui/src/layouts/RootLayout.tsx:115-120` (wrap inside `OncallBriefsProvider`)
- Test: `packages/ui/test/briefs/brief-runs.test.ts`, `packages/ui/test/providers/BriefRunsProvider.test.tsx`

**Interfaces:**
- Produces (`brief-runs.ts`): constants `RUNS_PER_AGENT = 5`, `EARLY_BUFFER_MAX = 20`, `EARLY_BUFFER_TTL_MS = 60_000`, `BRIEF_WAIT_DEADLINE_MS = 600_000`;
  `type BriefOutcome = { kind: "ready"; markdown: string } | { kind: "error"; message: string }`;
  `type BriefRun = { sessionId: string; agent: string; requestedAt: number } & ({ status: "pending" } | { status: "ready"; markdown: string; finishedAt: number } | { status: "error"; message: string; finishedAt: number })`;
  `type BriefRunsState = { runs: ReadonlyMap<string, BriefRun>; byAgent: Readonly<Record<string, readonly string[]>>; early: readonly { sessionId: string; outcome: BriefOutcome; at: number }[] }` (`byAgent[agent]` newest-requested first);
  `emptyBriefRuns(): BriefRunsState`; `parseBriefNotification(n: JsonRpcNotification): { sessionId: string; outcome: BriefOutcome } | null` (method ending `.briefReady` with string `params.brief`, or `.briefError` with string `params.error`; string `params.sessionId`);
  `registerRun(s, agent, sessionId, now): BriefRunsState`; `applyOutcome(s, sessionId, outcome, now): BriefRunsState`; `latestRun(s, agent): BriefRun | undefined`; `isPastDeadline(run: BriefRun, now: number): boolean`.
- Produces (hook): `useBriefRuns(): { latest(agent: string): BriefRun | undefined; start(agent: string, params: Record<string, unknown>): Promise<void> }` — `start` calls `agents.<agent>` and registers the returned `sessionId`; a rejected call rejects `start` with an `Error` and registers nothing.

- [ ] **Step 1: Failing pure tests:**

```ts
it("an outcome for a registered pending run completes it", …);
it("an outcome arriving BEFORE registerRun is applied when the run registers", …);
it("an early outcome older than 60_000 ms is dropped, and the buffer keeps at most 20", …);
it("an outcome for an unknown session never creates a run", …); // Review Focus 2
it("a second outcome for a finished run is ignored", …);
it("keeps 5 runs per agent, dropping the oldest requested", …);
it("latestRun is the most recently REQUESTED run even if an older one finished later", …);
it("isPastDeadline is true at requestedAt + 600_000 for a pending run, false once finished", …);
it("parseBriefNotification ignores gateway.event and malformed params", …);
```

- [ ] **Step 2: Failing provider tests** (mock `../../src/ipc/client` with `call` + `subscribe`, as `OncallBriefsProvider.test.tsx` does): subscription exists before the first `start`; a `decisions.briefReady` emitted synchronously inside the mocked `call` (before it resolves) still ends with `latest("decisions").status === "ready"`; `start` with a rejecting `call` rejects and `latest` stays `undefined`; `call` receives `("agents.decisions", params)`.
- [ ] **Step 3: Red:** `bunx vitest run test/briefs test/providers/BriefRunsProvider.test.tsx` → FAIL.
- [ ] **Step 4: Implement** the pure module, then the provider (state via `useReducer` or `useState` over the pure functions; one `subscribe` on mount, unsubscribed on unmount; `now` from `Date.now()`). Mount it in `RootLayout` inside `OncallBriefsProvider`.
- [ ] **Step 5: Green** (same command).
- [ ] **Step 6: Commit** `feat(ui): app-level brief-run store that never loses an early result`.

### Task 7: Role-packs provider and sidebar groups

**Files:**
- Create: `packages/ui/src/briefs/pack-sections.ts` (pure), `packages/ui/src/providers/RolePacksProvider.tsx`, `packages/ui/src/hooks/useRolePacks.ts`
- Modify: `packages/ui/src/layouts/RootLayout.tsx`, `packages/ui/src/components/chrome/Sidebar.tsx`, `packages/ui/src/components/chrome/NavItem.tsx`
- Test: `packages/ui/test/briefs/pack-sections.test.ts`, `packages/ui/test/components/chrome/Sidebar.test.tsx` (extend or create)

**Interfaces:**
- Produces (`pack-sections.ts`): `DESKTOP_EXCLUDED_AGENTS: ReadonlySet<string> = new Set(["preflight", "premortem"])`; `type PackSection = { id: string; name: string; agents: readonly CatalogAgent[] }`; `packSections(packs: PackListResult | null, catalog: CatalogListResult | null): readonly PackSection[]`.
- Produces (hook): `useRolePacks(): { packs: PackListResult | null; catalog: CatalogListResult | null; sections: readonly PackSection[]; loaded: boolean }` — `loaded` once both queries returned data; both via `useIpcQuery(…, 15_000, {}, { refetchOnFocus: true })`.

- [ ] **Step 1: Failing pure tests:** null inputs → `[]`; `listError` set → `[]`; a pack in `skipped` → no section; agents follow `visibleAgents` order; an agent with `visible: false`, an excluded agent, or a name absent from the catalog is dropped (Review Focus 4); a section left with no agents is omitted; an agent in two packs appears in both; missing `visibleAgents` → treated as `[]`; sections follow `installed` order.
- [ ] **Step 2: Failing Sidebar tests** (mock `useRolePacks` and `useOncallBriefs`): a `Briefs` link to `/briefs` is always present, directly after `Dashboard`; with a DevOps section, a group labelled with the pack name lists links to `/briefs/oncall` etc. with each agent's `displayName`; with no sections only `Briefs` is added; the `nav` has class `overflow-y-auto`; a NavItem label carries `title` equal to the label.
- [ ] **Step 3: Red:** `bunx vitest run test/briefs/pack-sections.test.ts test/components/chrome` → FAIL.
- [ ] **Step 4: Implement.** Provider mounted in `RootLayout` beside `OncallBriefsProvider` (wrapping `Sidebar` and `<main>`). Sidebar: groups as `<div role="group" aria-label={section.name}>` with a small heading and `NavItem`s; NavItem label gets `truncate` + `title`. No collapsing (spec § 5.4).
- [ ] **Step 5: Green** (same command).
- [ ] **Step 6: Commit** `feat(ui): sidebar follows the active role packs`.

### Task 8: Brief pages and routes

**Files:**
- Create: `packages/ui/src/briefs/brief-form.ts` (pure), `packages/ui/src/pages/Briefs.tsx`, `packages/ui/src/pages/BriefRun.tsx`, `packages/ui/src/pages/StoredBrief.tsx`
- Modify: `packages/ui/src/App.tsx:37-73` (routes `briefs` index, `briefs/stored/:id`, `briefs/:agent`)
- Test: `packages/ui/test/briefs/brief-form.test.ts`, `packages/ui/test/pages/Briefs.test.tsx`, `packages/ui/test/pages/BriefRun.test.tsx`, `packages/ui/test/pages/StoredBrief.test.tsx`

**Interfaces:**
- Consumes: `useRolePacks().catalog` (Task 7), `useBriefRuns()` and `isPastDeadline` (Task 6), `Markdown` (Task 5), `FleetShowResult` (Task 4), `DESKTOP_EXCLUDED_AGENTS` (Task 7).
- Produces (`brief-form.ts`): `FEDERATION_PARAMS = new Set(["namespace", "namespaces"])`; `FEDERATED_AGENTS = new Set(["huddle", "ghost"])`; `CATEGORY_ORDER = ["catch-up", "knowledge", "people", "code", "operations"] as const`; `type FormModel = { plain: readonly CatalogParam[]; groups: readonly { group: string; required: boolean; arms: readonly { arm: string; fields: readonly CatalogParam[] }[] }[] }`; `buildFormModel(params: readonly CatalogParam[]): FormModel`; `type FormValues = Readonly<Record<string, string | boolean>>`; `collectParams(model: FormModel, values: FormValues, arms: Readonly<Record<string, string>>): { ok: true; params: Record<string, unknown> } | { ok: false; problems: readonly string[] }`; `hasRequiredParams(agent: CatalogAgent): boolean` (any `required` param, or any `oneOf.required` group).

- [ ] **Step 1: Failing `brief-form` tests:** federation params never appear in the model; `string` trimmed, empty omitted; `number` → `Number`, non-finite → problem `"<label> must be a number"`; `boolean` sent only when `true`; `stringArray` split on `,`, trimmed, empties dropped, empty list omitted; missing required → `"<label> is required"`; a required group with no arm → `"Choose one of: <arm>, <arm>"`; only the chosen arm's fields are sent, its `armRequired` fields enforced; `hasRequiredParams` true for `impact` / `why` fixtures, false for `decisions`.
- [ ] **Step 2: Failing page tests** (mock `useRolePacks`, `useBriefRuns`, client):
  - `Briefs`: groups by `CATEGORY_ORDER`; excludes `preflight`/`premortem`; includes `negotiate`; mounting calls no `agents.*`.
  - `BriefRun`: mounting calls no `agents.*`; Run calls `start("decisions", params)`; a rejected `start` shows its message beside the form; pending shows elapsed time and a disabled Run; past deadline shows `Still running — check back.`; ready renders through `Markdown` with a Copy button (calls the clipboard plugin's `writeText` with the markdown); error shows its message; `huddle` and `ghost` show `Asks your paired peers.`; `/briefs/premortem` and `/briefs/nope` show a not-available message (premortem names `nimbus pre-mortem`) and never call `start`; Review Focus 5: with a pending run for `a`, navigating to `/briefs/b` shows `b`'s state only.
  - `StoredBrief`: `fleet.show { id }` result renders markdown with the agent's display name, job and time; `{ brief: null }` → `This stored brief is no longer available.` + link to the agent page; null markdown → `This run produced no text.`; never calls `agents.*`.
- [ ] **Step 3: Red:** `bunx vitest run test/briefs/brief-form.test.ts test/pages/Briefs.test.tsx test/pages/BriefRun.test.tsx test/pages/StoredBrief.test.tsx` → FAIL.
- [ ] **Step 4: Implement** the form module, the three pages (field widgets per spec § 5.5; the `sinceMs` control is your call) and the routes (`briefs/stored/:id` declared before `briefs/:agent`). `StoredBrief` uses `useIpcQuery<unknown>("fleet.show", 300_000, { id })` and narrows the result.
- [ ] **Step 5: Green** (same command) and `bun run --cwd packages/ui typecheck`.
- [ ] **Step 6: Commit** `feat(ui): brief pages — run any read-only brief, read stored ones`.

### Task 9: Home-screen pack sections

**Files:**
- Create: `packages/ui/src/components/home/PackSections.tsx`, `packages/ui/src/components/home/AgentCard.tsx`
- Modify: `packages/ui/src/pages/Dashboard.tsx`
- Test: `packages/ui/test/components/home/AgentCard.test.tsx`, `packages/ui/test/pages/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `useRolePacks()` (Task 7), `hasRequiredParams` (Task 8), `useOncallBriefs()` (existing), `formatAge(createdAt, nowMs)` from `components/oncall/format.ts`, `Markdown` (Task 5), `FleetBriefsResult` (Task 4).
- Produces: `AgentCard({ agent }: { readonly agent: CatalogAgent }): ReactNode`; `previewLines(markdown: string, max = 8): string` (first `max` non-blank lines) exported from `AgentCard.tsx`.

- [ ] **Step 1: Failing tests:**
  - `AgentCard`: for `oncall` with a newest pushed brief → its `title` · `service`, age, Open link `/oncall?id=<incidentId>`, and no `fleet.briefs` call; for `decisions` → `fleet.briefs` called with exactly `{ agentMethod: "agents.decisions", nonSweep: true, withMarkdown: true, limit: 1 }`, preview text and Open link `/briefs/stored/<id>`; no row → `No stored brief yet.` and a Run link to `/briefs/decisions`; Review Focus 1: `fleet.briefs` rejecting → `No stored brief yet.` + Run, no error text; `impact` (required params) → Run only and no `fleet.briefs` call; no `agents.*` call in any case.
  - `Dashboard`: with sections → one header per pack above the existing strip/grid/feed (still rendered); with `loaded` and no sections → the line `Role packs tailor this screen — see nimbus pack list.` (text, not a button); while not `loaded` → neither.
- [ ] **Step 2: Red:** `bunx vitest run test/components/home test/pages/Dashboard.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Cards poll `fleet.briefs` with `useIpcQuery(…, 60_000, …)`; preview is `<Markdown text={previewLines(md)} />` in a `max-h-40 overflow-hidden` box.
- [ ] **Step 4: Green** (same command), then the whole UI suite: `cd packages/ui && bunx vitest run` and `bun run --cwd packages/ui test:coverage`.
- [ ] **Step 5: Commit** `feat(ui): home screen shows the active packs' briefs`.

### Task 10: Docs, changelog, preflight, PR

**Files:**
- Modify: `docs/CHANGELOG.md` (top of `## Post-Phase-6 deliveries`), `docs/roadmap.md` (role-packs Project 4 row, if one exists — grep `Project 4`/`role pack`), `docs/architecture.md` (desktop UI section: routes `/briefs`, `/briefs/:agent`, `/briefs/stored/:id`, the providers, the markdown rule), `CLAUDE.md` + `GEMINI.md` (one sentence in the status paragraph: desktop follows role packs; allowlist 116)

- [ ] **Step 1: Write** the CHANGELOG entry (what the user sees; the five § 8 calls that change behaviour: preflight/premortem leave the desktop, links are text, focus refresh, Run-only cards for agents with required input, huddle/ghost ask peers). No new invariant, migration or egress class.
- [ ] **Step 2: Verify:** `bun run preflight:fast`, `bun run typecheck:tests`, `bun test packages/gateway/src/fleet packages/gateway/src/packs packages/gateway/src/ipc packages/gateway/src/security-invariants.test.ts`, `cd packages/ui && bunx vitest run`, `cd packages/ui/src-tauri && cargo test` → all PASS. Fix anything red before continuing.
- [ ] **Step 3: Commit** `docs: role packs on the desktop`, push, open the PR (`feat(ui): the desktop follows your role packs`), body ending with the Claude Code line. Then check CodeRabbit threads after each push.
