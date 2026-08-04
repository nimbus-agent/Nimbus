---
name: nimbus-agent-patterns
description: >
  Authoring built-in Nimbus agents (catchup, expert, impact, ghost, conflicts, huddle,
  janitor, preflight, why, glossary, decisions): file location, the
  read-only/HITL-free shape invariant, parallel sub-agent decomposition via
  AgentCoordinator, tool-scope restriction, the briefReady
  IPC notification contract, the matching CLI entry point, the e2e test pattern, and the
  latency budget. Use when adding/modifying a built-in agent, deciding sequential-vs-parallel
  decomposition, scoping a sub-agent's tools, wiring an agent's CLI command, testing an
  agent, or asking why a brief is slow/empty. Consult before writing any new file under
  packages/gateway/src/agents/.
---

# Nimbus Built-in Agent Patterns

## Built-in Agent Location

Currently implemented built-in agents live in `packages/gateway/src/agents/` as single files named after the command they serve: `catchup.ts`, `expert.ts`, `impact.ts`, `ghost.ts`, `conflicts.ts`, `huddle.ts`, `janitor.ts`, `preflight.ts`, `why.ts`, `why-peek.ts`, `glossary.ts`, `decisions.ts`. Planning agents (`meeting-prep`, `oncall-brief`, `standup`) are deferred to a future phase per the roadmap.

### Implicit-knowledge agents (Spine S1 — Local Brain)

Three agents mine knowledge nobody wrote down, from content already in the index. They are read-only like every other built-in agent, but they differ from the Phase 5 briefs in one structural way: **two of them own a persisted extraction pass plus a watermark table**, so they are not purely request-scoped.

**`why`** — see the section below; six-lane provenance, no persisted pass.

**`glossary`** (`packages/gateway/src/agents/glossary.ts`) — IPC `agents.glossary`, CLI `nimbus glossary [<term>] [--refresh|--rebuild] [--json]`. Backed by `glossary_term` + the single-row `glossary_pass_state` watermark (**V45**; **V46** widened `definition_source` to admit `'manual'`). Consolidation uses the local LLM when `[glossary].use_llm` is true and one is available; without one it falls back to a verbatim snippet definition that a later pass automatically re-queues and upgrades. `[glossary.terms]` / `[glossary.synonyms]` in `nimbus.toml` let a human author or correct a term — `definition_source='manual'` wins on collision, sorts first, and is exempt from the sweep's demotion and veto (but not its statistics refresh); removing the config entry demotes rather than deletes.

**`decisions`** (`packages/gateway/src/agents/decisions.ts`) — IPC `agents.decisions`, CLI `nimbus decisions [--since <duration>] [--service <name>] [--json]`. Backed by `decision_record` + `decision_evidence` + `decision_pass_state` (**V47**), fed by a debounced post-sync pass (discover → extract → corroborate). Confidence is scored deterministically from corroborating evidence already in the relationship graph — **never** from a model's self-report.

**Two honesty rules these agents established, worth copying:**

1. **State the recall limit in the brief, not just the docs.** `decisions` reports a per-brief truncated-source count keyed on `body_complete = 0` (`N of M source(s) … indexed with a truncated body`) and stays silent when nothing is truncated — it does not carry a standing disclaimer that readers learn to ignore.
2. **Never present a full-marks scale the user cannot reach.** `migration`/`iac` evidence is in the V47 schema but no connector indexes changed-file paths, so the confidence ceiling is **0.86, not 1.0** — and the brief says so.

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

### Provenance Agents (Spine S1)

**`why`** (`packages/gateway/src/agents/why.ts`) — IPC `agents.why`, CLI `nimbus why <ref> [--line <n>] [--json]`, notification `why.briefReady`. Six parallel lanes (authorship / pull request / ticket / discussion / driver / downstream) over the Phase 3 relationship graph, each degrading to a named gap note rather than going silent. Its one local read outside the index is a root-fenced, cached single-line `git blame` — not a connector call.

**`why-peek`** (`packages/gateway/src/agents/why-peek.ts`) — IPC `agents.whyPeek`, CLI `nimbus why <ref> --peek`. A synchronous sub-300ms companion returning a one-line answer with no notification round-trip; the exception to the `briefReady` contract below, and only because it does no fan-out.

## Agent Shape Invariant

Every built-in agent must be:

- **Read-only** — no write tools in scope.
- **Parallel where possible** — use `AgentCoordinator` with independent sub-agents.
- **HITL-free** — if the coordinator encounters a HITL-required tool it skips it and notes the omission in output. Built-in agents never wait on consent.
- **Notifying** — emits a `<agentName>.briefReady { sessionId, brief: string, findings }` IPC notification on completion.

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

Every agent emits a completion notification via the Gateway IPC server:

```typescript
ipcServer.notify(`${agentName}.briefReady`, { sessionId, brief, findings });
```

- `brief` is **always a Markdown string**.
- `findings` is the typed brief object (`ExpertBrief`, `CatchupBrief`, or `ImpactBrief`) — clients can render it directly or transform the Markdown further.
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
- [ ] Agent is read-only — no write tools in scope.
- [ ] Decomposed into parallel sub-agents via `AgentCoordinator` where independent steps exist.
- [ ] Each sub-agent's `toolScope` lists exactly the tools it needs — nothing extra.
- [ ] HITL-required tools are skipped and noted in output, never awaited.
- [ ] Emits `<agentName>.briefReady { sessionId, brief }` on completion; `brief` is Markdown.
- [ ] CLI command added under `packages/cli/src/commands/` and registered in `packages/cli/src/index.ts`; respects `NO_COLOR`.
- [ ] E2E test added at `packages/gateway/test/e2e/scenarios/<agent-name>.e2e.test.ts` covering brief sections, zero HITL fires, and the `briefReady` notification.
- [ ] Latency on a mid-range laptop with local LLM routing is under 15 s.
- [ ] `packages/gateway/src/agents/` line coverage stays ≥ 80%.
