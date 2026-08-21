---
name: nimbus-agent-patterns
description: >
  Authoring built-in Nimbus agents (catchup, expert, impact, ghost, conflicts, huddle,
  janitor, preflight, why, glossary, decisions, ownership, pre-mortem, negotiate): file location,
  the read-only/HITL-free shape invariant (and pre-mortem's narrowly-bounded exception to it),
  parallel sub-agent decomposition via AgentCoordinator, tool-scope restriction, the briefReady
  IPC notification contract, the matching CLI entry point, the e2e test pattern, and the
  latency budget. Use when adding/modifying a built-in agent, deciding sequential-vs-parallel
  decomposition, scoping a sub-agent's tools, wiring an agent's CLI command, testing an
  agent, or asking why a brief is slow/empty. Consult before writing any new file under
  packages/gateway/src/agents/.
---

# Nimbus Built-in Agent Patterns

## Built-in Agent Location

Currently implemented built-in agents live in `packages/gateway/src/agents/` as single files named after the command they serve: `catchup.ts`, `expert.ts`, `impact.ts`, `ghost.ts`, `conflicts.ts`, `huddle.ts`, `janitor.ts`, `preflight.ts`, `why.ts`, `why-peek.ts`, `glossary.ts`, `decisions.ts`, `ownership.ts`, `premortem.ts`, `negotiate.ts` — **fourteen** agent kinds across fifteen files (`why-peek.ts` is a lightweight companion to `why.ts`, not a kind of its own). Planning agents (`meeting-prep`, `oncall-brief`, `standup`) are deferred to a future phase per the roadmap.

### Implicit-knowledge agents (Spine S1 — Local Brain)

Three agents mine knowledge nobody wrote down, from content already in the index. They are read-only like every other built-in agent, but they differ from the Phase 5 briefs in one structural way: **two of them own a persisted extraction pass plus a watermark table**, so they are not purely request-scoped.

**`why`** — see the section below; six-lane provenance, no persisted pass.

**`glossary`** (`packages/gateway/src/agents/glossary.ts`) — IPC `agents.glossary`, CLI `nimbus glossary [<term>] [--limit <n>] [--json] [--refresh | --rebuild [--yes]]` (the `USAGE` constant in `packages/cli/src/commands/glossary.ts` is canonical — copy it, do not reassemble it from the flag parser). Note `nimbus glossary` is one of the few commands that **hard-rejects** an unrecognised flag rather than ignoring it. Backed by `glossary_term` + the single-row `glossary_pass_state` watermark (**V45**; **V46** widened `definition_source` to admit `'manual'`). Consolidation uses the local LLM when `[glossary].use_llm` is true and one is available; without one it falls back to a verbatim snippet definition that a later pass automatically re-queues and upgrades. `[glossary.terms]` / `[glossary.synonyms]` in `nimbus.toml` let a human author or correct a term — `definition_source='manual'` wins on collision, sorts first, and is exempt from the sweep's demotion and veto (but not its statistics refresh); removing the config entry demotes rather than deletes.

**`decisions`** (`packages/gateway/src/agents/decisions.ts`) — IPC `agents.decisions`, CLI `nimbus decisions [--since <duration>] [--service <name>] [--min-confidence <0..1>] [--explain] [--json] [--refresh | --rebuild [--yes]]` (the `USAGE` constant in `packages/cli/src/commands/decisions.ts` is canonical). Backed by `decision_record` + `decision_evidence` + `decision_pass_state` (**V47**), fed by a debounced post-sync pass (discover → extract → corroborate). Confidence is scored deterministically from corroborating evidence already in the relationship graph — **never** from a model's self-report.

**Two honesty rules these agents established, worth copying:**

1. **State the recall limit in the brief, not just the docs.** `decisions` reports a per-brief truncated-source count keyed on `body_complete = 0` (`N of M source(s) … indexed with a truncated body`) and stays silent when nothing is truncated — it does not carry a standing disclaimer that readers learn to ignore.
2. **Never present a full-marks scale the user cannot reach.** `migration`/`iac` evidence is in the V47 schema but no connector indexes changed-file paths, so the confidence ceiling is **0.86, not 1.0** — and the brief says so.

### Ownership agent (Spine S1 — Local Brain)

**`ownership`** (`packages/gateway/src/agents/ownership.ts`) — IPC `agents.ownership`, CLI `nimbus owners [<path>] [--service <name>] [--json] [--refresh]` (the `USAGE` constant in `packages/cli/src/commands/owners.ts` is canonical). Backed by `person --owns--> source_file | directory | service` graph edges + the single-row `ownership_pass_state` watermark (**V51**), fed by a debounced post-sync pass (`ownership/ownership-pass.ts`) that aggregates already-indexed `git_blame_line` rows — it opens no connector and calls no model. `nimbus owners` also **hard-rejects** an unrecognised flag, matching `nimbus glossary`/`nimbus decisions`.

It sits beside the implicit-knowledge trio (same S1 slot, same persisted-pass-plus-watermark shape, same `emitBriefWithSynthesis` read path) but is **not** implicit-knowledge extraction — blame data is not knowledge nobody wrote down, it is aggregated quantitative attribution over data the Stage 2a blame indexer already captured. Four parallel lanes via `AgentCoordinator`: the requested target (path or service), its parent directory as a fallback so a one-committer file still routes somewhere, the service the containing root rolls up to, and coverage + the bound-service list.

**Root resolution is not `why`'s `whyRoots`.** `ownership/ownership-target.ts` `ownershipRoots()` merges **both** root sources — `[[filesystem.roots]]` **and** the `nimbus index add` registrations in `registered-roots.json` — because that is the exact set `platform/assemble.ts` hands the derivation pass; copying `why`'s TOML-only root set would report "no ownership data" for a path the pass has already blamed and written edges for.

**The honesty rule this agent adds:** every brief carries an **unconditional** gap note stating that this is authorship-derived ownership, not accountability — there is no CODEOWNERS, no reviewer data, and no on-call rotation in the index. Unlike the conditional gap notes above it, this one never turns off: a standing disclaimer that readers could learn to skip is judged worse here than the alternative, because getting this specific fact wrong (mistaking "wrote the most lines" for "owns the approval") is the one failure mode the agent exists to prevent.

`ownership.refresh` takes **no parameters** and has **no rebuild counterpart** — the pass clears and re-emits every edge it owns wholesale each run, so a caller-supplied root list would silently erase ownership for the omitted roots, and a "rebuild" verb would be a synonym for refresh. Like `glossary`/`decisions`, the whole `ownership` namespace is LAN-forbidden and absent from Tauri's `ALLOWED_METHODS` — only the read-only `agents.ownership` is renderer- and LAN-exposed.

### Cross-Colleague Agents (Phase 6 Slice 6a)

Three read-only agents that surface cross-colleague context by fanning the shipped federated-query primitives across paired peers. They follow the same shape invariant as `catchup`/`expert`/`impact` but additionally fan out over the federation mesh via `federation/peer-fanout.ts`.

**`ghost`** (`packages/gateway/src/agents/ghost.ts`) — IPC `agents.ghost`, CLI `nimbus ghost <file> [--namespace <n>] [--json]`, notification `ghost.briefReady`. Ranks teammates by file expertise across paired peers (`federation.expertise` fan-out) and surfaces their matching PRs, issues, and commits. Suggests who to contact; never sends a message. Sub-agents: per-peer expertise query + local index enrichment, run in parallel via `AgentCoordinator`.

**`conflicts`** (`packages/gateway/src/agents/conflicts.ts`) — IPC `agents.conflicts`, CLI `nimbus conflicts <file> [--namespace <n>] [--json]`, notification `conflicts.briefReady`. Warns of WIP collisions (open PR / assigned ticket / recent commit / open branch) before editing a file. Fans out `federation.query` per peer asking for recent activity on the file path; merges results sorted by recency.

**`huddle`** (`packages/gateway/src/agents/huddle.ts`) — IPC `agents.huddle`, CLI `nimbus huddle [--since <ms>] [--namespace <n>] [--json]`, notification `huddle.briefReady`. Team-scoped morning briefing aggregating each teammate's recent PRs, tickets, and incidents from across paired peers. One `federation.query` fan-out per peer, one sub-agent per peer, results merged into a per-teammate section.

**Shared fan-out helper:** `federation/peer-fanout.ts` — iterates `PeerRegistry`, calls `federation.query` / `federation.expertise` per peer with per-peer timeout + error isolation, and returns merged results. Consumed only by these three agents.

**V38 known-namespaces cache:** `federation_known_namespaces` table (added by V38 migration) caches which remote namespaces a successful federated query touched on the asker side, letting the agents default to an ambient sweep when `--namespace` is omitted. Rows are pruned on `no_grant` / unpair events.

### Federated Action-Request Agents (Phase 6 Slice 6b)

**`janitor`** (`packages/gateway/src/agents/janitor.ts`) — IPC `agents.janitor`, CLI `nimbus janitor <resource-ref> [--idle-days N] [--cleanup <action.type>] [--allow-gaps] [--json]`. Flags idle cloud resources from the already-indexed graph and proposes a cleanup action; the action itself is HITL-gated at the executor (`I24` / `D18`), so the brief itself stays read-only.

**`preflight`** (`packages/gateway/src/agents/preflight.ts`) — IPC `agents.preflight`, CLI `nimbus preflight <ref> --namespace <ns> [--strict] [--json]` (plus `nimbus preflight approve <request-id>` to respond to a federated request). Blast-radius preflight over a peer namespace before a change lands; read-only.

### Pre-mortem agent (Spine S1 — Local Brain)

**`pre-mortem`** (`packages/gateway/src/agents/premortem.ts`) — IPC `agents.premortem`, CLI `nimbus pre-mortem <epic-ref> [--service <name>]… [--json] [--refresh] [--repropose]`, notification `premortem.briefReady`. Four sequential lanes (not `AgentCoordinator` — each depends on the previous one's output): resolve a Jira epic to its affected services, build an IDF-weighted service-overlap cohort of closed epics, compute five structural risks over that cohort, and read recurring blocker themes (`premortem_theme`, mined by the debounced background pass Task 1/2 shipped). Jira-only, and `parent_key`-derived cohort membership is team-managed-Jira-only — no `linear:project` items are indexed at all. Confidence tops out at 0.86, matching `decisions` (`THEME_CONFIDENCE_CEILING`, `premortem/theme-identity.ts`): no connector indexes ticket comments. `glossary` has no confidence-ceiling concept of its own — its honesty disclosure is per-brief truncation counts and definition provenance (`snippet`/`manual`/`llm`), not a confidence score.

**This is the one built-in agent that is not purely read-only — read the exception's bounds below before treating "read-only, no write tools in scope" as unconditional.**

### Provenance Agents (Spine S1)

**`why`** (`packages/gateway/src/agents/why.ts`) — IPC `agents.why`, CLI `nimbus why <ref> [--line <n>] [--json]`, notification `why.briefReady`. Six parallel lanes (authorship / pull request / ticket / discussion / driver / downstream) over the Phase 3 relationship graph, each degrading to a named gap note rather than going silent. Its one local read outside the index is a root-fenced, cached single-line `git blame` — not a connector call.

**`why-peek`** (`packages/gateway/src/agents/why-peek.ts`) — IPC `agents.whyPeek`, CLI `nimbus why <ref> --peek`. A synchronous sub-300ms companion returning a one-line answer with no notification round-trip; the exception to the `briefReady` contract below, and only because it does no fan-out.

## Agent Shape Invariant

Every built-in agent must be:

- **Read-only** — no write tools in scope.
- **Parallel where possible** — use `AgentCoordinator` with independent sub-agents.
- **HITL-free** — if the coordinator encounters a HITL-required tool it skips it and notes the omission in output. Built-in agents never wait on consent.
- **Notifying** — emits a `<agentName>.briefReady { sessionId, brief: string, findings, synthesis }` IPC notification on completion.

### The pre-mortem exception, and its exact bounds

`pre-mortem` is the one built-in agent that is not purely read-only. `runPremortem` calls `proposeWatchers` (`packages/gateway/src/premortem/watcher-proposals.ts`), which writes exactly two things and nothing else:

- **`watcher` rows, always inserted with `enabled = 0`** — via `insertWatcherIfAbsent`, which never touches an existing row's `enabled` on a re-run.
- **`premortem_watcher_proposal` rows** — a tombstone recording that this epic/service/risk-kind triple was proposed, so a user-deleted watcher stays deleted (`suppressed`) across re-runs instead of being silently resurrected. `--repropose` deletes *only this epic's* tombstones (`clearProposalTombstones`), never a global clear.

No other table is written by this agent. It never calls `connectors.dispatch`, never fires HITL, and never arms a watcher — arming is a separate, unchanged user action.

**This is deliberately not an I2/HITL matter.** I2 governs `HITL_REQUIRED_BACKING` — the frozen set of `action.type`s that leave the machine via `engine/executor.ts`'s `gate()`. A local SQLite insert never reaches that gate, because it is not a connector action: it is a plain local write, exactly the same shape as `glossary`'s, `decisions`'s, `ownership`'s and the egress ledger's own writes to their respective tables, none of which run through I2 either. Treating "writes a local row" as inherently an I2 concern would be a category error — I2 is about actions that leave the machine, not about mutating local state.

**The actual safety property is `enabled = 0`, not a consent gate.** `automation/watcher-store.ts`'s `listEnabledWatchers` filters strictly on `w.enabled === 1`; the watcher engine (`automation/watcher-engine.ts`) only ever evaluates rows that function returns. A paused row `pre-mortem` inserts is therefore structurally inert — it cannot fire, regardless of who or what inserted it — until a human explicitly arms it through the existing watcher-arming path. That is what makes the write safe to leave outside I2: the row itself cannot cause an outbound or user-visible effect on its own.

Do not generalize this exception to a future agent by analogy. If a new agent needs to write something beyond a paused `watcher` row + its own proposal-tombstone table, that is a new design decision requiring its own review — not an extension of this one.

## Sub-agent Decomposition Pattern

Use `AgentCoordinator` to run independent sub-agents in parallel. Each sub-agent is a `SubTask` whose `execute()` function does the work; `run()` fans them out with `Promise.all`:

```typescript
const coordinator = new AgentCoordinator({ sessionId, parentId, depth, toolCallCount });
const tasks: SubTask[] = [
  { taskType: "agent_step", prompt: "", execute: async () => { /* query/blame ... */ } },
  { taskType: "agent_step", prompt: "", execute: async () => { /* ... */ } },
  { taskType: "agent_step", prompt: "", execute: async () => { /* ... */ } },
];
const results = await coordinator.run(tasks); // runs in parallel
```

Tool-scope restriction is a code-review discipline, not mechanically enforced — see below.

**Never use sequential tool calls where parallel sub-agents would work** — it defeats the latency purpose of decomposition.

## Tool Scope Restriction

Sub-agents are defined as functions passed via `SubTask.execute()`. Tool access is determined by what each sub-agent function calls internally — for the built-in agents (`expert`, `catchup`, `impact`) this is primarily queries against the in-memory SQLite `Database` (the local index). There is no built-in dispatcher-level restriction; **enforce scope via code review** — each sub-agent function should access only the data sources appropriate to its task. **Do not give a sub-agent a broad scope "for flexibility"** — scope it to exactly the data it needs. Broad scopes break the principle of least privilege and make latency budgets unpredictable.

## IPC Notification Contract

Every agent emits a completion notification via the Gateway IPC server, through the shared
`emitBriefWithSynthesis` helper (`packages/gateway/src/agents/_lib/emit-brief.ts`) rather than a
direct `notify` call:

```typescript
opts.notify(opts.briefReadyMethod, { sessionId, brief: markdown, findings: brief, synthesis: provenance });
```

- `brief` is **always a Markdown string** — either the deterministic render, or an LLM-synthesized
  rewrite of it (see below).
- `findings` is **that agent's own typed brief object**, declared in `packages/gateway/src/agents/_lib/<agent>-types.ts` — `ExpertBrief`, `CatchupBrief`, `ImpactBrief`, `WhyBrief`, `GlossaryBrief`, `DecisionsBrief`, `OwnershipBrief`, `PremortemBrief`, and so on. This is deliberately not a closed union: adding an agent adds a type here, it does not change the contract. Clients can render it directly or transform the Markdown further. CLI-side narrowing guards (e.g. `PremortemBriefLike` in `packages/cli/src/commands/pre-mortem.ts`) are structural subsets used to validate an untyped IPC payload — they are not the gateway-side type this field carries.
- `synthesis` is the `SynthesisProvenance` union (`packages/gateway/src/agents/_lib/synthesize.ts`):
  `{attempted: false, reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed"}`
  when `brief` is the deterministic render because no LLM was ever called — `"disabled"` (no
  runner), `"no_eligible_provider"` (a runner was invoked but nothing resolved), or
  `"reserved_extraction_failed"` (invariant I31's fail-closed guard: a renderer did not honour
  `omitReserved`, so the reserved-disclosure content would have gone to the model unguarded, and
  no rewrite was even attempted); `{attempted: true, used: true, model,
  remote}` when `brief` is a synthesized rewrite; or `{attempted: true, used: false, reason, ...}`
  when a rewrite was attempted and discarded (a dropped contractual disclaimer, a timeout, a
  provider error, an egress-append failure, or the provider returning no usable text) — `brief` is
  the deterministic render in that last case too, so `synthesis` is the only field that
  distinguishes "never asked" from "asked and discarded." Gated by `[agents] synthesis`
  (`"off"` | `"local"` default | `"allow-remote"`); a
  non-local generation appends an egress-ledger row (invariant I29, coverage class `model`) before
  `synthesis.used` can read `true` with `remote: true`.
- `sessionId` ties the notification to the originating `engine.askStream` call.
- Notification name is always `<agentName>.briefReady` — the CLI subscribes to that exact name.

## CLI Entry Point

Each built-in agent gets a dedicated CLI command in `packages/cli/src/commands/`. The command:

1. Calls the Gateway IPC method.
2. Streams the `briefReady` notification.
3. Renders the Markdown brief to stdout, **respecting `NO_COLOR`**.

Add the command to the CLI's command registry in `packages/cli/src/index.ts`.

## E2E Test Pattern

Every agent requires an e2e test at `packages/gateway/test/e2e/scenarios/<agent-name>.e2e.test.ts` that:

- Sets up test data in an in-memory SQLite `Database` (the local index; e.g. `new Database(":memory:")` or `createMemoryIndexDb()`) — mocking connectors is unnecessary, since agents query the local index rather than remote APIs.
- Asserts the brief contains the expected sections.
- Asserts **zero HITL actions fired** — a structural check that the agent source does not import `ToolExecutor` or reference `HITL_REQUIRED`.
- Optionally asserts the `briefReady` notification is emitted (via the `emitBriefWithSynthesis` / `emit<Agent>Brief` path) with a non-empty `brief` and `findings`.

Use `expert.e2e.test.ts` (alongside `catchup.e2e.test.ts` and `impact.e2e.test.ts`) as the reference implementations — they focus on brief-structure correctness and the HITL-free property.

## Coverage Gate

`packages/gateway/src/agents/` ≥ **80% line coverage**.

## Latency Expectation

Built-in agents targeting interactive use (`oncall`, `expert`, `standup`) should complete in **under 15 seconds** on a mid-range laptop using local LLM routing. If sub-agent decomposition would exceed this, **reduce the number of parallel sub-agents** rather than increasing the timeout — fewer, more focused sub-agents are always preferable to a long fan-out.

## Authoring Checklist

- [ ] File created at `packages/gateway/src/agents/<agent-name>.ts`.
- [ ] Agent is read-only — no write tools in scope. (The sole existing exception is `pre-mortem`'s paused-watcher-proposal write — see "The pre-mortem exception" above; do not add a second exception without the same level of review.)
- [ ] Decomposed into parallel sub-agents via `AgentCoordinator` where independent steps exist.
- [ ] Each sub-agent's `toolScope` lists exactly the tools it needs — nothing extra.
- [ ] HITL-required tools are skipped and noted in output, never awaited.
- [ ] Emits `<agentName>.briefReady { sessionId, brief }` on completion; `brief` is Markdown.
- [ ] CLI command added under `packages/cli/src/commands/` and registered in `packages/cli/src/index.ts`; respects `NO_COLOR`.
- [ ] E2E test added at `packages/gateway/test/e2e/scenarios/<agent-name>.e2e.test.ts` covering brief sections, zero HITL fires, and the `briefReady` notification.
- [ ] Latency on a mid-range laptop with local LLM routing is under 15 s.
- [ ] `packages/gateway/src/agents/` line coverage stays ≥ 80%.
