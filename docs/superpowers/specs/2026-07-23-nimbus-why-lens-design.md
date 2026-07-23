# `nimbus why` + the VS Code why-lens — design

> **Status:** design approved 2026-07-23. Spine **S1 (Local Brain)**, implicit-knowledge triad — the
> first of the three agents. Simultaneously delivers the ecosystem roadmap's **Stage 2a headline**.
>
> Roadmap: [`docs/roadmap.md`](../../roadmap.md) § Active → Spine S1 · Phase 7 Wave 5.
> Ecosystem: [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) § Stage 2a.

---

## Contents

- [Goal](#goal)
- [Why this is buildable today](#why-this-is-buildable-today)
- [Correction 1 — blame is not full-file](#correction-1--blame-is-not-full-file)
- [Correction 2 — Wave 1a is already built at eight agents](#correction-2--wave-1a-is-already-built-at-eight-agents)
- [Correction 3 — a 10-second hover is not a hover](#correction-3--a-10-second-hover-is-not-a-hover)
- [Correction 4 — three of the six lanes ride edges nothing emits](#correction-4--three-of-the-six-lanes-ride-edges-nothing-emits)
- [Design](#design)
  - [Landing sequence](#landing-sequence)
  - [The `why` agent](#the-why-agent)
  - [Input resolution](#input-resolution)
  - [The six lanes](#the-six-lanes)
  - [On-demand blame](#on-demand-blame)
  - [Graceful degradation](#graceful-degradation)
  - [The two gateway entry points](#the-two-gateway-entry-points)
  - [Output types](#output-types)
  - [CLI](#cli)
  - [SDK + client hop](#sdk--client-hop)
  - [The VS Code lens](#the-vs-code-lens)
- [Security posture](#security-posture)
- [Testing](#testing)
- [Risks](#risks)
- [Out of scope](#out-of-scope)
- [Exit criteria](#exit-criteria)

---

## Goal

For any source location, answer the question `git blame` gestures at but cannot answer:

> **who** wrote this, **why**, **what drove it**, and **what depends on it** —
> entirely from the local index, with no live API call.

A cloud agent structurally cannot do this. It does not see the team's private Slack thread, the
Linear ticket, or the incident that the change was a response to. Nimbus already has all four
indexed; they are simply not queryable in a conversational shape yet.

Two surfaces:

- **`nimbus why <ref>`** — the full brief, CLI + IPC.
- **A VS Code hover lens** — the demo. Hover a line, see author → PR → ticket inline; click through
  for the full brief.

---

## Why this is buildable today

Every relation type the agent traverses is already **declared** in the schema, and every item it
reads is already **indexed**. **No new graph relation type, no new item type, no migration, no new
invariant, no HITL action type.**

Three of those relation types are declared but never written by any populator, so a prerequisite
phase makes them real — see [Correction 4](#correction-4--three-of-the-six-lanes-ride-edges-nothing-emits).
That is populator work on existing tables, not schema work.

| Lane | Substrate in the index today |
| --- | --- |
| who | `git_blame_line` (V32, `index/git-blame-line-v32-sql.ts`) → `commit_sha`, author, time |
| which PR | `merged_as` (V27) commit → PR |
| why | `authored` / `reviewed` / `resolves` (V7) → PR body, reviewer thread, Linear/Jira ticket |
| the thread | `mentions` / `posted` (V7) → `message` entities |
| what drove it | `correlates_with` / `affects` (V7) → `incident`, `alert`, `deployment` |
| downstream | `depends_on` / `defined_in` / `in_repo` (V12) → dependent symbols, repos |

`agents/impact.ts` is a near-exact structural
template: `AgentCoordinator` → five parallel `SubTask`s → `emitBriefWithSynthesis`. `why` is the
same shape pointed backwards in the graph.

---

## Correction 1 — blame is not full-file

**The brief assumed `git_blame_line` covers every line. It does not.**

`connectors/filesystem-v2-sync.ts:363`
calls `blameIndexedExcerptRanges`, which blames **only the indexed code-symbol excerpt ranges** —
and skips the file entirely when the merged ranges exceed `MAX_BLAME_LINES = 5000`. Coverage is
further bounded to paths under a configured `[[filesystem.roots]]`.

So a hover on a comment, an import, a blank line, or any line outside an indexed symbol's excerpt
has **no blame row** — and those are exactly the lines a lens fires on. Designing against the
assumption of full coverage would have shipped a lens that is empty most of the time.

The resolution is [on-demand blame](#on-demand-blame), below.

## Correction 2 — Wave 1a is already built at eight agents

Ecosystem Stage 1 Wave 1a (`agents.*` in `@nimbus-dev/client`) was assumed spec'd-but-unstarted.
It is in fact **fully built and release-committed locally, unpushed and unpublished**:

- `nimbus-sdk` worktree `.worktrees/agents-briefs`, branch `dev/asafgolombek/promote-agent-briefs`,
  release commit `chore(release): 1.5.0`
- `nimbus-client` worktree `.worktrees/agents-namespace`, branch `dev/asafgolombek/agents-namespace`,
  release commit `chore(release): 0.7.0` — 226 tests green

Widening those branches to nine agents would mean reverting two release commits and holding two
finished branches hostage to a gateway agent that does not exist yet. The generic
`subscribeAgentBrief<A extends AgentName>` wrapper was explicitly designed so the ninth agent is a
**follow-on** costing one `AGENT_NAMES` entry, one brief type, and one promise method.

**Decision: ship Wave 1a unchanged at eight; `why` rides a later `sdk 1.6.0` → `client 0.8.0` hop.**

**External prerequisite — owned elsewhere:** the client's ESM `dist/index.js` throws under Node (a
pre-existing SDK extensionless-specifier bug, newly hit). VS Code extensions run on Node, so the
lens cannot work until that is fixed. **That fix, and the Wave 1a push/publish it gates, are being
handled in a separate workstream and are not scope here.** This spec depends on their outcome but
plans no work for them: it is listed as landing step 0 to make the dependency explicit, and only
step 3 (the lens) waits on it.

## Correction 3 — a 10-second hover is not a hover

The roadmap budgets `why` at **under 10 s**. VS Code cancels hovers on cursor movement and users
expect roughly 300 ms. A single entry point cannot serve both the CLI brief and the lens.

The surface therefore splits in two: a synchronous **peek** for the hover and the **full agent** for
the click-through. See [The two gateway entry points](#the-two-gateway-entry-points).

## Correction 4 — three of the six lanes ride edges nothing emits

**Added 2026-07-23, after auditing every `upsertGraphRelation` call site in the gateway.**

The relation types are all declared in the schema (V7/V12/V26/V27/V40). Only some are ever written.

| | Relation types |
| --- | --- |
| **Emitted by a populator** | `authored`, `targets`, `in_repo`, `depends_on`, `belongs_to`, `upstream_refs`, `reviewed`, `posted`, `opened`, `monitors`, `merged_as`, `derived_from`, `defined_in`, `backlinks` |
| **Declared but emitted by nothing** | `resolves`, `mentions`, `correlates_with`, `affects`, `triggers`, `tests`, `fires_on`, `assigned` |

The original lane table put `subTicket` on `resolves` / `mentions`, `subDiscussion` on `mentions`,
and `subDriver` on `correlates_with` / `affects`. **All three would return zero rows on every index,
forever** — three of six lanes permanently dark, and the headline claim about the ticket, the thread
and the incident hollow.

**Decision: emit the missing edges in the graph populator first.** `why` then traverses real edges,
and `impact.ts` plus every future agent inherits the same benefit. The alternative — reading the
`item` table and `item_fts` heuristically from inside the agent — was rejected as reaching around
the graph.

This makes the populator a prerequisite **phase**, not a footnote. Grounding it surfaced three
further constraints that shape its task list:

1. **`clearRelationsTouchingEntity` clobbers cross-item edges.** Every sync function opens with
   `DELETE FROM graph_relation WHERE from_id = ? OR to_id = ?`. Today that is safe only because
   every existing edge is emitted by the sync of its *own* `from` entity. A `mentions` edge from a
   message to a PR would be silently deleted the next time that PR re-syncs, and would not come back
   until the message itself re-synced. The clear must be scoped to the relation types the calling
   sync function actually owns, on `from_id` only, before any cross-item edge is trustworthy.
2. **`IndexedItemGraphInput` carries no body.** It is `{id, service, type, title, authorId,
   metadata}`. Parsing ticket references out of a PR body or mention references out of a message
   body requires widening it with `bodyPreview` — one field, one call site (`index/item-store.ts`).
3. **`incident` and `deployment` have no graph entities at all.** Both are indexed as items by real
   connectors and both are listed in `ITEM_LINKED_ENTITY_TYPES`, but `syncGraphFromIndexedItem` has
   no branch for either — so nothing is ever created to correlate. `correlates_with` therefore needs
   the entities built first. This is also why `impact.ts`'s on-call and dashboard lanes are gap
   notes today.

**Consequence for the landing sequence:** gateway step 1 splits into **1a (populator edges)** and
**1b (the agent)**. 1a is independently valuable and independently shippable — it lights up
`impact.ts` on its own — and 1b depends on it.

---

## Design

### Landing sequence

| # | Repo | Ships | Gate |
| --- | --- | --- | --- |
| **0** *(external — owned by a separate workstream)* | `nimbus-sdk` / `nimbus-client` | Fix ESM `dist/index.js` under Node; push + publish `sdk 1.5.0`, then `client 0.7.0` | not planned here; only step 3 waits on it |
| **1a** | `Nimbus` | Graph-populator edges: scoped relation clear, `resolves`, `mentions`, `incident` + `deployment` entities, `correlates_with`, backfill | `bun run preflight`; `impact.ts` suite green |
| **1b** | `Nimbus` | `why` agent, `agents.why` + `agents.whyPeek`, Tauri allowlist, `nimbus why` CLI | `bun run preflight` |
| **2** | `nimbus-sdk` **1.6.0** → `nimbus-client` **0.8.0** | `why` as the ninth agent | guard units, `MockClient` parity, conformance gate |
| **3** | `nimbus-vscode` | hover provider + `nimbus.why` command | extension test suite + marketplace release |

Step 1a is a hard prerequisite for 1b (the lanes need real edges), and 1b for step 2 (the SDK cannot
promote a type the gateway has not defined). Step 0 is external to this spec and progresses
independently; steps 1a/1b/2 do not wait on it, and step 3 does.

**Therefore this spec yields four implementation plans, not one** — 1a (populator edges), 1b (the
agent), 2 (the SDK + client hop), 3 (the extension). **1a can start immediately and is independently
valuable**: it lights up `impact.ts`'s currently-dark lanes on its own, with no dependency on `why`.
1b delivers the roadmap's stated acceptance criterion.

### The `why` agent

New file `packages/gateway/src/agents/why.ts`, following
`nimbus-agent-patterns`: read-only, HITL-free,
parallel sub-agent decomposition via `AgentCoordinator`, terminating in
`emitBriefWithSynthesis` from `agents/_lib/emit-brief.ts`.

Latency target **under 10 s** on a mid-range laptop against a populated index.

### Input resolution

```ts
export type WhyInput = {
  ref: string;      // "path/to/file.ts:42" | "path/to/file.ts" | "<symbolName>"
  line?: number;    // alternative to the ":42" suffix
};
```

Resolution order:

1. `path:line` (or `path` + `line`) → resolve `repoRoot` by matching the path against the configured
   `[[filesystem.roots]]`. **A path that matches no root resolves to `null`** — see
   [Security posture](#security-posture).
2. A bare token → look up a `code_symbol` graph entity by name; take its file and
   `excerptStartLine` metadata.
3. No match → `subject: null` plus a `GapNote`, mirroring how `impact.ts` handles an unresolvable
   start entity. The brief still renders; it simply has nothing to anchor on.

### The six lanes

Six `SubTask`s run in parallel under one `AgentCoordinator`, exactly as `impact.ts` runs five.

| Lane | Traversal | Produces |
| --- | --- | --- |
| `subAuthorship` | `git_blame_line` → `commit_sha` → `git_commit` entity → `authored` → person | author name/email, commit SHA, commit subject, authored date |
| `subPullRequest` | commit → `merged_as` → `pr`; `reviewed` → reviewers | PR number, title, body, URL, reviewer set, review-thread comments |
| `subTicket` | pr → `resolves` / `mentions` → `issue` | ticket key, title, URL, status |
| `subDiscussion` | pr / commit / issue → `mentions` / `posted` → `message` | Slack/Teams thread excerpts with permalinks |
| `subDriver` | `correlates_with` / `affects` → `incident`, `alert`, `deployment` within the commit's time window | the incident or deploy the change responded to |
| `subDownstream` | `depends_on` / `defined_in` / `in_repo` from the resolved symbol | dependent symbols, repos, services |

**Shared traversal.** `subDownstream` overlaps `impact.ts`'s `subDownstreamCode` and
`subDownstreamRepos`. Given this repo's standing jscpd duplication floor, the traversal is extracted
into `agents/_lib/` and **both** agents call it. `impact.ts` is refactored to consume the extracted
helper in the same PR — a sixth copy of a graph walk is not acceptable here.

Each lane returns `{ findings?: WhyFinding[]; gap?: GapNote }` and a failed lane degrades to a gap
note rather than failing the brief — the established `impact.ts` contract.

### On-demand blame

When `subAuthorship` finds no `git_blame_line` row for the resolved `(repoRoot, filePath, lineNo)`:

1. Confirm the resolved path is inside a configured `[[filesystem.roots]]`. If not, stop — emit a
   gap note, spawn nothing.
2. Run `git blame -L <n>,<n> --porcelain -- <file>` in `repoRoot`, reusing the existing spawn shape
   from `filesystem-v2-sync.ts` including `AbortSignal.timeout(BLAME_TIMEOUT_MS)`.
3. Parse with the existing `parseBlamePorcelain`
   (`security/blame-store.ts`).
4. Persist with the existing `upsertBlameLines`, so the next hover on that line is a pure DB hit.
5. A non-zero exit, spawn failure, or timeout yields no rows — treated identically to a miss, with a
   gap note. Never an error.

One line, one bounded subprocess, cached forever after. This is a **local** git read: it is not a
connector dispatch, so `I29` / the egress ledger does not apply, and it is not a write, so `I2` /
HITL does not apply.

The `security/blame-store.ts` helpers are reused as-is; nothing in that module changes. The new
single-line spawn helper is the only added code, and it is placed alongside the agent rather than in
`security/`, which owns the scan-attribution use case.

### Graceful degradation

Degradation is the **existing** mechanism, not new code.
`agents/_lib/gap-notes.ts` already
provides `detectEmptyIndex`, `detectMissingConnector`, `detectMissingEntityType`, and
`aggregateMissingEntityTypes`.

| Connectors present | Lanes that light up |
| --- | --- |
| git only | `subAuthorship`, `subDownstream` |
| \+ GitHub / GitLab | `subPullRequest`, `subTicket` (GitHub issues) |
| \+ Linear / Jira | `subTicket` (full) |
| \+ Slack / Teams | `subDiscussion` |
| \+ PagerDuty / deploy annotation | `subDriver` |

Every dark lane produces a gap note naming the connector that would light it. This is what makes the
ecosystem roadmap's "degrades gracefully" claim true by construction rather than by special-casing.

### The two gateway entry points

Both registered in the handler map in
`ipc/agents-rpc.ts` alongside the existing eight,
and both added to `ALLOWED_METHODS` in
`ui/src-tauri/src/gateway_bridge.rs`
(read-only, renderer-safe). Neither is an HTTP write route: **no `I13`, no `WRITE_ROUTE_ALLOWLIST`
change.**

**`agents.why`** — the full agent. Returns `{ sessionId }` synchronously and emits the
`why.briefReady` / `why.briefError` **pair**. Standard agent shape.

**`agents.whyPeek`** — synchronous, no coordinator, no LLM, no notification, returns its payload
directly:

```ts
export type WhyPeek = {
  subject: { repoRoot: string; filePath: string; lineNo: number } | null;
  author: string | null;
  authorEmail: string | null;
  commitSha: string | null;
  committedAt: number | null;
  commitSubject: string | null;
  pr: { number: number; title: string; url: string } | null;
  ticket: { key: string; title: string; url: string } | null;
  hasMore: boolean;   // true when the full agent would add lanes beyond these
};
```

Pure indexed `SELECT`s plus at most one on-demand blame spawn. **Target under 300 ms.**

**On the name:** `agents.whyPeek`, not `agents.why.peek`. Every existing method in the namespace is
two-segment (`agents.expert`, `agents.impact`, …); a three-segment name would be the first in the
codebase for no benefit. It stays inside `agents.*` despite not emitting a brief so that it inherits
the same allowlist grouping, client namespace, and conformance treatment as its sibling.

### Output types

```ts
export type WhyLane =
  | "authorship" | "pull_request" | "ticket" | "discussion" | "driver" | "downstream";

export type WhyFinding = {
  lane: WhyLane;
  title: string;
  detail: string;
  url: string | null;
  occurredAt: number | null;
  entityId: string | null;
};

export type WhyBrief = AgentBriefBase & {
  kind: "why";
  query: { ref: string; line: number | null };
  subject: { repoRoot: string; filePath: string; lineNo: number; symbol: string | null } | null;
  findings: WhyFinding[];
};
```

`AgentBriefBase` (`agentVersion`, `generatedAt`, `latencyMs`, `gaps`) comes from the SDK, matching
how the other eight briefs are composed. `kind` is `"why"` — it matches the agent name, unlike
`conflicts`, whose kind is the singular `"conflict"`.

Markdown rendering goes through the existing `agents/_lib/render.ts`.

### CLI

```text
nimbus why <ref> [--line <n>] [--peek] [--json]
```

`<ref>` accepts `path:line`, a bare path, or a symbol name. `--peek` hits `agents.whyPeek` for the
one-line answer; the default runs the full agent and renders the brief as Markdown.

The command must be registered in the CLI `COMMAND_NAMES` registry as well as `index.ts` — the
registry silently lags, and `audit:readme-cli` reds when a doc names a command the registry lacks.
Documented in [`docs/cli-reference.md`](../../cli-reference.md).

### SDK + client hop

Deliberately deferred behind Wave 1a's unchanged eight-agent release.

`nimbus-sdk` **1.6.0** (additive, non-breaking):

- `AGENT_NAMES` gains `"why"`; `AGENT_KIND.why = "why"`
- `WhyBrief`, `WhyFinding`, `WhyLane`, `WhyPeek` exported from the root
- `BriefFor<"why">` resolves via the existing mapped type
- one concrete guard `isWhyBrief` via the existing `createBriefGuard` factory

`nimbus-client` **0.8.0**:

- `agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>` — rides the existing
  generic `subscribeAgentBrief` + buffer-and-correlate machinery unchanged
- `agentsWhyPeek(p: WhyPeekParams): Promise<WhyPeek>` — a plain request/response method, no
  subscription
- validators for both in `src/validate.ts`
- `MockClient` parity, which the shared interface makes compiler-enforced
- both added to the `agents.*` conformance gate

### The VS Code lens

- `vscode.languages.registerHoverProvider`, scoped to files resolving inside a Nimbus
  `[[filesystem.roots]]` path. Files outside it get no provider activity at all.
- The hover calls `client.agentsWhyPeek` with a ~1 s timeout, wired to the hover's
  `CancellationToken`.
- **Gateway down, slow, cancelled, or line unknown → render nothing.** No error chrome, no spinner
  that outlives the hover. The lens is never the reason the editor feels slow.
- Rendered `MarkdownString`:

  ```markdown
  **alice** committed `a1b2c3d` · 3 months ago
  [#412 Fix retry backoff](https://…) · [NIM-88](https://…)
  [Why — full brief](command:nimbus.why?…)
  ```

  The command link appears only when `hasMore` is true.
- `nimbus.why` command → `client.agentsWhy` → renders into the extension's existing agent-chat
  webview (`nimbus.openAgentChat` already ships).
- New setting `nimbus.whyLens.enabled`, default `true`.
- Extension stays at its current `engines.vscode` floor of `^1.95.0` — `registerHoverProvider` and
  command URIs in `MarkdownString` are long-stable APIs. No engines bump, no proposed API.

---

## Security posture

No new invariant. The relevant existing ones and why they are untouched:

| Invariant | Relationship |
| --- | --- |
| `I2` / `I3` / `I4` (HITL) | Not engaged — `why` is read-only and dispatches no action. Same posture as the other eight built-in agents. |
| `I11` (`wrapToolOutput`) | Engaged only through `emitBriefWithSynthesis`, which already wraps the synthesis step's tool output. No new LLM-facing tool surface is added. |
| `I13` (HTTP write surface) | Untouched — both methods are local-socket IPC reads. `WRITE_ROUTE_ALLOWLIST` count is unchanged. |
| `I7` (Tauri allowlist) | Two entries added; both read-only, neither RCE-class. The Rust count assertion moves from eight `agents.*` entries to ten. |
| `I29` / `D22` (egress ledger) | Not engaged — the on-demand blame is a local `git` read, not a `connectors.dispatch`. `D22`'s static confinement is unaffected. |
| `I9` (bound-param SQL) | All lane queries use bound parameters; no identifier interpolation. |

**The one genuinely new attack surface is the on-demand blame subprocess**, and it is fenced by a
single rule: *the resolved path must be inside a configured `[[filesystem.roots]]`, or nothing
spawns.* The path is passed as an argv element after `--`, never through a shell. This rule gets a
dedicated test that is **red-proven** before it is trusted — a guard asserted against a leftover
import rather than a real call site is a failure mode this repo has already hit once.

---

## Testing

Per `nimbus-testing`: real SQLite, fresh temp dirs,
no DB-layer mocks.

| Test | Asserts |
| --- | --- |
| `why.test.ts` per-lane units | each lane against a fixture DB containing only that lane's edges |
| Resolution units | `path:line`, `path` + `--line`, bare symbol, and unresolvable ref |
| Degradation | git-only fixture → lanes 2–5 emit `GapNote`s, **not** errors; brief still renders |
| On-demand blame — hit | DB row present → **zero** spawns |
| On-demand blame — miss | miss → one spawn → row persisted → second call is a DB hit with **zero** further spawns |
| On-demand blame — failure | non-zero exit / timeout → gap note, no throw |
| **Path escape** | ref outside every `[[filesystem.roots]]` → gap note and **zero** spawns; red-proven |
| `agents-rpc` handlers | malformed params → `-32602` for both methods, matching the existing eight |
| Peek shape | `hasMore` true iff a lane beyond authorship/PR/ticket has data |
| E2E CLI | real gateway subprocess + mock MCP servers; `nimbus why <file>:<line>` end to end |
| Latency | full brief under 10 s, peek under 300 ms against the fixture index |
| Tauri allowlist | Rust count assertion updated 8 → 10 `agents.*` entries |

Gates: per-file ≥80% line and branch coverage (the floor is Docker-Linux-authoritative — verify
there, not on native Windows), `audit:readme-cli` after the CLI registration, and
`bun run preflight` before the first push.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| The blame subprocess makes a hover feel slow on a cold line | The peek path spawns at most once per line and caches; the hover's 1 s timeout renders nothing rather than blocking. A cold line degrades to a fast empty hover, not a slow populated one. |
| `hasMore` requires knowing what the full agent would find, which is what makes the full agent expensive | `hasMore` is computed from cheap existence checks (does any `mentions` / `correlates_with` / `depends_on` edge leave the resolved entity), not from running the lanes. |
| Extracting the shared traversal touches `impact.ts`, a shipped agent | The refactor lands with `impact.ts`'s existing suite passing **unchanged** — the same honesty gate Wave 1a applied to its de-dup PR. |
| Step 0 (the client ESM bug) slips and blocks step 3 | Steps 1 and 2 are unblocked by it; only the lens waits. The gateway agent and the CLI ship value on their own. |
| Wave 1a never publishes, stranding the client hop | Step 2 is explicitly sequenced *behind* Wave 1a's publish. If that stalls, `why` still ships on the gateway + CLI, which is where the roadmap acceptance criterion lives. |

---

## Out of scope

Each is its own spec:

- `nimbus glossary` and `nimbus decisions` — the other two thirds of the S1 implicit-knowledge triad
- `nimbus pre-mortem`, `nimbus negotiate`
- The implicit-knowledge dashboard (Tauri)
- The ownership graph — `service` / `team` item types, `nimbus services list/show` (Phase 7 Wave 1)
- Ecosystem Stage 2b (ops vocabulary), 2c (egress receipts), 2d (Language Model Tool registration)
- Full-file blame indexing

---

## Exit criteria

1. `nimbus why packages/gateway/src/engine/executor.ts:42` returns a brief naming the PR author, the
   linked ticket, the driving incident where one exists, and the downstream dependents — from the
   local index, with zero live API calls, in under 10 s on a mid-range laptop. *(This is the
   roadmap's stated Wave 5 acceptance criterion.)*
2. On a git-only index the same command still returns authorship and downstream lanes, with gap
   notes naming the connectors that would light the rest. No errors.
3. `nimbus why <ref> --peek` returns in under 300 ms.
4. A hover in VS Code over any line inside an indexed root shows author, commit, PR, and ticket; a
   hover with the gateway stopped shows nothing and logs nothing user-visible.
5. Clicking **Why — full brief** opens the rendered brief in the agent-chat view.
6. The path-escape test is red-proven: it fails when the root check is removed.
7. `bun run preflight` green; coverage floor green on Docker-Linux.
