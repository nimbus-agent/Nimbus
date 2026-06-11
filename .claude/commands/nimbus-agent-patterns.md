---
name: nimbus-agent-patterns
description: >
  Authoring built-in Nimbus agents (catchup, expert, impact): file location, the
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

Currently implemented built-in agents live in `packages/gateway/src/agents/` as single files named after the command they serve: `catchup.ts`, `expert.ts`, `impact.ts`. Planning agents (`meeting-prep`, `oncall-brief`, `standup`) are deferred to a future phase per the roadmap.

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

Sub-agents are defined as functions passed via `SubTask.execute()`. Tool access is determined by what each sub-agent function calls internally — for the built-in agents (`expert`, `catchup`, `impact`) this is primarily local-index database queries on the `IndexDB` instance. There is no built-in dispatcher-level restriction; **enforce scope via code review** — each sub-agent function should access only the data sources appropriate to its task. **Do not give a sub-agent a broad scope "for flexibility"** — scope it to exactly the data it needs. Broad scopes break the principle of least privilege and make latency budgets unpredictable.

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

- Sets up test data in an in-memory `IndexDB` instance — mocking connectors is unnecessary, since agents query the local index rather than remote APIs.
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
