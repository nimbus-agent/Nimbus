# Role packs, Project 4 — Desktop

**Status:** draft for owner review, 2026-10-24.
**Parent:** `2026-10-21-role-packs-overview-design.md` § 5 Project 4.
**Builds on:**
- Project 1: the layered config, `[agents] visible`, and the agent catalog with parameter shapes.
- Project 3: `pack.*` methods, and the bundled `pm` / `devops` packs. Merged as #1762, #1764 and #1767.

**Blocker cleared:** `dev/asaf/desktop-migration` has merged (#1709, #1711, #1713).

## 1. Intent

A person who installs the PM pack and opens the desktop app should see a home screen about their
work, not one about connectors and index health:
- **PM pack:** recent decisions, new glossary terms, and what they missed.
- **DevOps pack:** its 7 visible agents: oncall, why, impact, ownership, catchup, changelog and
  standup. `why` and `impact` need input, so their cards show only Run.

Every read-only built-in brief should also be runnable from the app and read as formatted text, not
raw markdown in a `<pre>` box.

Today the desktop has none of this:
- routes, sidebar and dashboard are static code;
- no page calls any `agents.*` method;
- the one brief it shows (the on-call pushed brief) renders as raw text.

## 2. What exists today (recon on `main` @ 232fa191)

- **Routes:** `packages/ui/src/App.tsx:37-73`. The paths are `/`, `/oncall`, `/captures`,
  `/onboarding/*`, `/quick`, `/hitl-popup`, `/hitl`, `/settings/*`, `/marketplace`, `/watchers` and
  `/workflows`.
- **Sidebar:** `components/chrome/Sidebar.tsx:6-15`, a static `ENTRIES` array of 8 items.
- **Dashboard:** `pages/Dashboard.tsx` renders `IndexMetricsStrip`, `ConnectorGrid` and
  `AuditFeed`.
- **Briefs:** none rendered except `components/oncall/BriefDetail.tsx:48-50`, which puts
  `briefMarkdown` in a `<pre>`. There is no markdown dependency and no `dangerouslySetInnerHTML`.
- **CSP** (`packages/ui/src-tauri/tauri.conf.json:28`):
  `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`.
  There is no `style-src`, so inline `<style>` and `style=""` attributes from HTML are blocked;
  React's style props are CSSOM writes and are not blocked.
- **Tauri allowlist:** `packages/ui/src-tauri/src/gateway_bridge.rs:78`, 111 methods, size asserted
  at `:863`.
  - **Agents:** 15 `agents.*` entries, including `agents.preflight` and `agents.premortem`. Missing:
    `agents.oncall`, `agents.standup`, `agents.changelog`.
  - **Not listed:** no `pack.*`, no `catalog.*`. `fleet.*` is excluded by a test
    (`allowlist_excludes_fleet_namespace`, `:802-815`).
  - **Timeout:** the default RPC timeout is 30 s (`:236`). `NO_TIMEOUT_METHODS` has 7 entries, none
    of them `agents.*`.
- **Gateway reads this project needs:**
  - `catalog.list`: agents with `visible`, `params` (`CatalogParam`: name, kind, label, required,
    oneOf) and `surfaces`, plus `visibility.basis` / `packs`.
  - `pack.list`: `PackListResult`.
  - `fleet.briefs { limit?, jobId?, subjectKey? }`, returning `FleetBriefRow` (`id`, `jobId`,
    `subjectKey`, `agentMethod`, `briefMarkdown`, `createdAt`, …). `subject_key` is
    `TEXT NOT NULL` (V63): a config-named job writes `subjectKey = jobId`
    (`fleet-scheduler.ts:329`), a sweep writes the subject's key (`:400`). No row is ever null, and
    `optString` (`fleet-rpc.ts:114`) refuses a non-string `subjectKey` with `-32602`.
  - `fleet.show { id }`, returning `{ brief: FleetBriefRow | null }`.
  - `oncall.pushedList` / `oncall.pushedGet` (already on the allowlist). The list's
    `PushedBriefSummary` carries `title`, `service`, `status` and `createdAt` but **no markdown**;
    only `pushedGet` returns `briefMarkdown`. The On-call page selects a brief by `?id=`.
- **Polling hook:** `hooks/useIpcQuery.ts` re-runs on an interval and on `visibilitychange` only.
  It has no window `focus` listener, and focusing a window that was merely behind another does not
  fire `visibilitychange`.
- **No URL opener:** nothing in `packages/ui/src` imports a Tauri opener, and
  `packages/ui/src-tauri/capabilities/default.json` grants no `shell:allow-open` / `opener:*`
  permission (it has `shell:allow-spawn` and a scoped `shell:allow-execute` for `nimbus start`).
- **Sidebar container:** a fixed `w-[150px]` flex column with no `overflow-y-auto`.
- **Federation in briefs:** `huddle` always fans out to paired peers (with no `namespaces` it uses
  every known namespace, `agents/huddle.ts:95-110`); `ghost` always calls `fanOutExpertise`
  (`agents/ghost.ts:53`) and fans out queries only for the namespaces given; `conflicts` fans out
  only for the namespaces given. With no paired peer, none of them sends anything.
- **Notification ordering:** `emitBriefWithSynthesis` starts the brief before it returns
  `{ sessionId }` (`agents/_lib/emit-brief.ts:57-75`), so a fast or synchronously failing brief can
  emit `<agent>.briefReady` / `briefError` before the caller's `call()` resolves.
- **Change events:** there is no gateway event when the pack set or layered config changes
  (`ipc/gateway-events.ts` has 6 kinds). The fleet supervisor polls the snapshot version instead.
- **Tests:** vitest + Testing Library under `packages/ui/test/**`, with the IPC mock at
  `src/ipc/__mocks__/client.ts`. Desktop E2E is a stub.

## 3. Decided by the owner (2026-10-24)

- **Shape B:** a home screen driven by the active packs, plus a shared brief page.
  - Home cards show the newest **stored** result (an overnight fleet brief, or the on-call pushed
    brief) with its time.
  - With nothing stored, a card says so and offers **Run**.
  - **Nothing runs on page load.**
- **The renderer may call these read-only methods:** `pack.list`, `fleet.briefs`, `fleet.show`.
  `pack.install` and `pack.remove` stay off the allowlist. Installing a pack stays a terminal
  action in this project.
- **A pack picker (installing from the desktop) is out of scope.** It is a Project 5 / security
  decision.

## 4. Goals, non-goals, anti-goals

**Goals**
1. The sidebar and home screen follow the active packs and change without a rebuild or restart
   when a pack is installed or removed in the terminal.
2. One brief page runs any read-only built-in brief, with a parameter form built from the catalog.
3. Briefs render as formatted markdown, safely, under the current CSP (the CSP is not loosened).

**Non-goals**
- Installing or removing packs from the desktop.
- Role onboarding (Project 5).
- Editing config.
- Showing fleet-run history beyond the newest brief per agent.
- A desktop E2E harness.

**Anti-goals** (failures even if everything else works)
- A page that runs a brief by itself on load or on a timer: that spends model calls and may send
  text to a remote model the owner did not ask for.
- Rendering pack- or brief-supplied text as HTML, or loosening the CSP to make a renderer work.
- The renderer gaining any method that writes, prompts for approval, or runs code.

## 5. Design

### 5.1 Allowlist changes (I7)

Add, all read-only:
- `agents.oncall`, `agents.standup` and `agents.changelog`: read-only briefs, the overview's rule;
- `catalog.list`: agent metadata and parameter shapes (**my call**: the brief page and sidebar need
  it, it is a read of static plus visibility data, and it is the same class as the owner-approved
  reads);
- `pack.list`, `fleet.briefs` and `fleet.show`: the owner-approved reads.

**Remove** `agents.preflight` and `agents.premortem` (**my call**).
- Both are on the allowlist today, but nothing in the UI calls them.
- `preflight` raises an owner HITL prompt (I24) and `premortem` writes watcher rows. The overview
  already says both stay in the CLI.
- Removing them shrinks what a compromised renderer can trigger.
- `fleet.runNow`, `fleet.digest`, `fleet.status` and `fleet.list` stay off.

`agents.whyPeek` **stays** (my call). Nothing in the UI calls it today either, but the reason for
removing the other two is their side effects, not disuse: `whyPeek` is a synchronous read with
none. Pruning unused reads is a separate allowlist audit, not this project.

The `allowlist_excludes_fleet_namespace` test becomes "only `fleet.briefs` and `fleet.show`". Add a
test that no `pack.*` method other than `pack.list` is allowed. The size assertion moves
111 → 116 (+7 −2), and the enumeration is re-derived wherever docs list it (the
`nimbus-tauri-allowlist` skill, `docs/architecture.md`).

**No timeout change is needed.** An `agents.*` call returns `{ sessionId }` at once
(`agents/_lib/emit-brief.ts:50-76`). The brief arrives later as a `<agent>.briefReady` notification
(field `brief`), or `<agent>.briefError` if it fails, and the bridge already forwards every
notification to the frontend (`gateway_bridge.rs:374-375`). § 5.5 waits for that notification.

**Retire the old rationale in the same change.** The comment on `allowlist_excludes_fleet_namespace`
(`gateway_bridge.rs:804-807`) and the dispatcher comment at `ipc/server/dispatchers.ts:1463-1465`
both say the fleet reads stay off the allowlist because they are "synthesised answers over the
private index". Rewrite both to say why `fleet.briefs` and `fleet.show` are now allowed (§ 6) and
the other fleet methods are not.

### 5.2 Which agents a pack contributes

The desktop needs, per active pack, the agents it makes visible. `pack.list` does not carry that
today. **My call:** each `pack.list` `installed[]` row gains `visibleAgents: string[]`, the
normalised `[agents] visible` names of that pack's installed `defaults`, read from the installed
record and not from the bundled copy. The CLI ignores the field.

**Active pack** means a row in `pack.list` `installed[]` whose id is not in `skipped[]`. A skipped
(broken) layer contributes no section, and if `listError` is set the home screen shows no pack
sections.

**The owner wins (my call).** A pack section shows the agents in the pack's `visibleAgents` that
`catalog.list` reports as `visible: true`, so the owner's own `[agents]` settings take precedence.
Sections follow pack order, and agents within a section follow manifest order. An agent made
visible by two packs appears in both sections.

### 5.3 Home screen (`/`)

- **With at least one active pack:** one section per pack, above the existing dashboard content.
  - A section has a header with the pack name and a row of cards, one per visible agent.
  - The existing `IndexMetricsStrip`, `ConnectorGrid` and `AuditFeed` stay below, unchanged.
- **With no pack:** today's dashboard, plus one quiet line: `Role packs tailor this screen — see
  nimbus pack list.` This is text, not a button.
- **A card shows:**
  - the agent's `displayName` and one-line description (from the catalog);
  - the newest stored result:
    - for `oncall`, the newest `oncall.pushedList` entry, shown as its `title` and `service`
      (the list carries no markdown, and the card does not make a second `pushedGet` call
      just for a preview — my call). "Open" goes to `/oncall?id=<incidentId>`;
    - for other agents, the newest `fleet.briefs` row for that agent's method from any job that is
      **not a sweep** (a sweep's per-subject brief is not a general answer) and has a non-null
      `briefMarkdown`, shown as the first lines of the rendered markdown, clipped. "Open" goes to
      `/briefs/stored/<id>` (§ 5.5);
    - **gateway change (my call):** `fleet.briefs` gains three optional filters, so the card asks
      for exactly one row (`limit: 1`) instead of filtering 500 rows in the renderer:
      - `agentMethod: string`: `agent_method = ?`;
      - `nonSweep: boolean`: when `true`, `subject_key = job_id`. This is how a config-named job's
        row is told from a sweep's (V63 made `subject_key` `NOT NULL` and backfilled it with
        `job_id`; there is no null to match). Bound: a sweep subject whose key happened to equal
        its own job's name would pass; subject keys are `<kind>:…` and a job named like one is the
        only way to get there;
      - `withMarkdown: boolean`: when `true`, `brief_markdown IS NOT NULL`.
      
      Each is validated like the existing params (a wrong type is `-32602`); `false` means no
      filter. The CLI does not use them;
  - its age ("3 h ago");
  - with nothing stored: `No stored brief yet.` and **Run**, which opens the brief page for that
    agent. It does not run inline, because the form may need input.
- An agent that requires parameters (e.g. `impact`) shows only **Run**: a stored fleet brief is
  per-subject and not a general answer.

### 5.4 Sidebar

The sidebar keeps its static entries.
- It adds **Briefs** (always present), which goes to the brief index.
- Under it, one group per active pack lists that pack's visible agents, each linking to
  `/briefs/<agent>`.
- With no pack, only **Briefs** is added.
- The sidebar gets `overflow-y-auto`: both bundled packs add 10 agent links, two group headers and
  Briefs to today's 8 entries, which overflows a small window. Collapsible pack groups are deferred until a third pack exists. Long labels
  truncate with an ellipsis and keep the full name in `title`.

### 5.5 Brief pages (`/briefs`, `/briefs/:agent`, `/briefs/stored/:id`)

- **`/briefs`:** every read-only built-in agent from `catalog.list`, grouped by `category`. It
  excludes `preflight`, `premortem` and `whyPeek` (no catalog entry; an internal shape), and
  includes `negotiate`.
- **`/briefs/:agent`:** a form built from the agent's `CatalogParam[]`.
  - **Field types by `kind`:** `string` is a text field, `number` a number field (`sinceMs` shown
    as a duration picker is the builder's call), `boolean` a checkbox, and `stringArray` a
    comma-separated list.
  - **`oneOf` groups** render as a segmented choice of arms, and the chosen arm's fields are
    required when the arm's `armRequired` or the group's `required` says so.
  - **Run** calls `agents.<name>` with the filled params only. Empty optional fields are omitted.
  - **Federation fields are not offered (my call).** The form omits `namespace` and `namespaces`,
    so the desktop never names which peers' namespaces to ask. This does **not** make every brief
    local: `huddle` with no `namespaces` asks every known namespace, and `ghost` always asks paired
    peers for expertise (§ 2). Those two stay on `/briefs` (it is the same act as `nimbus huddle` /
    `nimbus ghost`, behind the same click), and their form shows one fixed line: `Asks your paired
    peers.` With no paired peer they send nothing. `conflicts` without `namespaces` is local. Bound:
    the gateway still accepts both fields from any allowlisted caller, so the omission is a UI
    choice, not enforcement.
  - **The call is asynchronous, and fails in two places.**
    - The `agents.<name>` call itself can reject (bad params are `-32602`, a refusal is another
      code). The page shows that message beside the form, and the run never enters the store.
    - Otherwise it returns `{ sessionId }`, and the page waits for the matching
      `<agent>.briefReady` (render `brief`) or `<agent>.briefError` (show its `error`).
    - The wait has its own deadline: 10 minutes, **my call**. Past it the page shows "still
      running — check back", and a late result is still accepted.
  - While waiting, the page shows elapsed time and a disabled Run button.
  - The result renders as markdown (§ 5.6) with a copy-as-markdown button.
  - **Results live in an app-level store (my call).** It is keyed by `sessionId` and indexed by
    agent, and sits outside the page component, so navigating away mid-run does not lose the
    result.
    - The page shows the most recently REQUESTED run for that agent: its result, or its pending
      state. An older run that completes later is kept but not shown over it.
    - The store is in memory only (never persisted) and holds at most the last 5 results per
      agent.
    - **The store subscribes before any call.** One listener for every `*.briefReady` /
      `*.briefError` is registered when the app starts. A notification whose `sessionId` is not
      yet known is buffered (bounded: 20 entries, dropped after 60 s), and when `call()` resolves
      with that `sessionId` the buffered result is applied at once. Without this, a brief that
      finishes or fails before `call()` resolves (§ 2) leaves the page waiting forever.
- **`/briefs/stored/:id`:** calls `fleet.show { id }` and renders `briefMarkdown` with the agent's
  display name, the job and the time. `{ brief: null }` (pruned or unknown) shows `This stored
  brief is no longer available.` with a link to the agent's page. A stored brief with null
  markdown shows `This run produced no text.` It never runs anything.
- An unknown or excluded `:agent` shows "not available here" with the CLI command. It never calls
  the gateway.

### 5.6 Markdown rendering

A renderer that turns brief markdown into React elements, under these constraints:
- **No `innerHTML`:** no `dangerouslySetInnerHTML`, no HTML string sink.
- **Raw HTML in the markdown is not rendered:** it is shown as text, or dropped.
- **Links never navigate the webview, and nothing opens a browser (my call).** There is no opener
  path today and no capability grants one (§ 2), so every link renders as its text followed by the
  URL as plain, selectable text, never an `<a href>`. Opening `http(s)` links in the system browser
  would add `shell:allow-open` or the opener plugin to `capabilities/default.json`, a capability
  widening that is deferred to its own change.
- **Images are not loaded.** Show the alt text.
- **Supported markdown:** headings, paragraphs, emphasis, inline code, fenced code, lists,
  blockquotes, tables and horizontal rules.
- **The CSP is unchanged:** styling comes from Tailwind classes, not inline style.

**Parser (my call): `marked`'s lexer only.** `marked` has no runtime dependencies; the renderer
calls `marked.lexer(text)` and maps the token tree to React elements itself, and never calls
`marked.parse` (which produces HTML). An `html` token renders as text. This keeps one small
dependency and no HTML string anywhere, where `react-markdown` pulls in the unified/micromark tree
and a hand-written parser would own table and list edge cases. The dependency goes through the
repo's dependency-safety pre-flight (`nimbus-commands` skill), with the reason in the PR. The
existing on-call `BriefDetail` and the stored-brief view use the same renderer.

### 5.7 Live switching

There is no change event. **My call:** the app re-reads `pack.list` (and `catalog.list`) when the
window regains focus, and every 15 s while visible, through the existing `useIpcQuery` polling hook.
An install in the terminal therefore shows up when the user switches back to the app. A new gateway
event kind is not worth it for this.

`useIpcQuery` listens only to `visibilitychange` today, which does not fire when a window that was
merely behind the terminal is focused (§ 2). It gains an opt-in `refetchOnFocus` option that adds a
`window` `focus` listener (removed on cleanup), used by the pack and catalog queries. It is opt-in
so the hook's other callers do not start refetching on every focus.

### 5.8 Demo gateway

On a demo gateway, `pack.list`, `fleet.*` reads, `catalog.list` and `agents.*` are already allowed.
The demo's seeded data shows on the home screen if a pack is installed in the demo root, and
nothing changes in the demo gate.

## 6. Security notes

- **I7:** every added method is a read. Two side-effecting methods leave the allowlist. No write,
  approval or code-running method is added.
- **Running a brief from the desktop** is the same act as running it from the CLI. The `ui`
  ClientKind is non-egress-bearing, a remote synthesis is ledgered at the provider (I29), and I31
  still governs the content. Nothing runs without a click.
- **Federation:** `huddle` and `ghost` reach paired peers from the desktop exactly as from the CLI
  (both are already on the allowlist). The form says so before Run; the desktop never supplies
  `namespace(s)`.
- **No new Tauri capability:** links are text, so `capabilities/default.json` is unchanged.
- **Stored briefs:** fleet briefs are local SQLite text that any renderer able to call `agents.*`
  could already regenerate, so exposing reads adds little.
- **No invariant changes** beyond the I7 enumeration. No new HITL type, migration or egress class.
  The one gateway change besides `visibleAgents` is three read filters on `fleet.briefs`.

## 7. Done when

- Installing the `pm` pack in the terminal, then focusing the app, shows a Product section with
  Decisions, Glossary and Catch-up cards, and a Product group in the sidebar, with no restart.
  Removing it removes both.
- The Decisions card shows the newest non-sweep fleet brief for `agents.decisions` (the
  `pm-decisions-nightly` job writes one) when one exists, and "Open" shows it in full at
  `/briefs/stored/<id>`.
- With `devops` installed, the on-call card shows the newest pushed brief's title and service, and
  "Open" goes to `/oncall?id=<incidentId>`.
- Focusing the app (not only un-minimising it) after a terminal `pack install` refreshes it.
- A brief whose notification arrives before its `call()` resolves still shows its result.
- Every read-only built-in brief runs from `/briefs/<agent>` with a form that enforces its required
  parameters, and renders as formatted markdown.
- `preflight` and `premortem` are not on the allowlist and not on the brief index.
- Raw HTML and `javascript:` links in a brief render as text, and nothing navigates the webview.

## 8. Calls made (for the owner to check)

1. `catalog.list` joins the allowlist (needed for the forms and the sidebar).
2. `agents.preflight` and `agents.premortem` are **removed** from the allowlist.
3. `pack.list` rows gain `visibleAgents`. A pack section shows only the ones the catalog reports
   visible, so the owner's own `[agents]` settings win.
4. Live switching is a refresh on focus plus a 15 s poll, with no new event; `useIpcQuery` gains an
   opt-in `refetchOnFocus`.
5. A card for an agent with required parameters never shows a stored brief. Other cards show the
   newest non-sweep fleet brief with text for that agent from any job, through new `agentMethod`,
   `nonSweep` (`subject_key = job_id`) and `withMarkdown` filters on `fleet.briefs`.
6. Brief results live in an in-memory app store keyed by `sessionId` (5 per agent), subscribed at
   app start with a small buffer for early notifications. The page shows the latest requested run,
   with a 10-minute wait deadline.
7. The desktop form omits the federation `namespace` / `namespaces` fields. `huddle` and `ghost`
   stay on `/briefs` with an `Asks your paired peers.` line.
8. Stored fleet briefs open at `/briefs/stored/:id`; the on-call card opens `/oncall?id=…` and shows
   title and service, not a markdown preview.
9. Links render as plain text; no opener capability is added.
10. The markdown parser is `marked`'s lexer, rendered to React by our own code.
11. `agents.whyPeek` stays on the allowlist.

## 9. Left to the builder

- How the React renderer maps each `marked` token, within § 5.6.
- Exact card and form layout, and Tailwind styling.
- The duration control for `sinceMs`.
- Whether `/briefs` and the pack sections share a component.
