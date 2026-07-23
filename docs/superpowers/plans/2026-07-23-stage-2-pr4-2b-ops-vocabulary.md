# Stage 2 PR 4 — 2b: ops vocabulary

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Copilot-three slash commands (`/explain` `/fix` `/test`) with the ops four — `/incident`, `/deploys`, `/owns`, `/blast` — backed by the built-in brief agents and DORA metrics, plus file-type-keyed quick-ask presets for infra files.

**Architecture:** **Stacked on PR 1's branch** (`dev/asafgolombek/stage2-pr1-consume-011`, PR base set to it) — the brief methods and `metricsDora` exist only on client 0.11.0. Ops turns bypass `askStream` entirely: `runParticipantTurn` routes `req.command` to a new pure module `src/chat-participant/ops-commands.ts` that calls the typed client methods and renders structured briefs as markdown. The old three survive as quick-ask presets (Explain/Fix already are; add "Write tests").

**Verified client/SDK shapes** (sdk 1.5.x `brief-composites.ts`): `ExpertBrief.ranked: ExpertFinding[]` (`displayName`, `confidence`, `evidence[]`, `score`); `ImpactBrief.affected: ImpactFinding[]` (`category`, `affectedTitle`, `serviceId`, `hops`, `pathSummary`); `CatchupBrief.sections: CatchupSection[]` (`serviceId`, `totalItemsInWindow`, `items[]: {title, modifiedAt, relevanceReasons}`); all `AgentBriefBase & {gaps: GapNote[]}`. `DoraMetricsResult.metrics.{deployment_frequency,lead_time_for_changes,change_failure_rate,mttr}: {value: number|null, unit, sample, gap}`. Client methods: `agentsExpert({topicOrFile, limit?})`, `agentsImpact({fileOrPrUrl, depth?})`, `agentsCatchup({sinceMs?, service?})` (each `o?: {timeoutMs?}`), `metricsDora({service, since?})` — the brief methods already handle briefReady/briefError correlation internally.

## Global Constraints

- Branch `dev/asafgolombek/stage2-pr4-2b-ops` in a worktree, created **from `dev/asafgolombek/stage2-pr1-consume-011`**; `gh pr create --base dev/asafgolombek/stage2-pr1-consume-011`; GitHub retargets to main when PR 1 merges.
- `bun install` first; full gate set before first push; never commit on `main`.
- Commands degrade honestly: a brief with zero findings says so and surfaces `gaps[].detail`; a thrown `AgentBriefError`/timeout renders its message.

---

### Task 1: Vocabulary swap in types, manifest, adapter (test-first)

**Files:**

- Modify: `src/chat-participant/participant-types.ts` — `ParticipantCommand = "incident" | "deploys" | "owns" | "blast"`; `ParticipantClientLike` gains `agentsExpert`, `agentsImpact`, `agentsCatchup`, `metricsDora` (signatures above).
- Modify: `src/chat-participant/prompt.ts` — delete `COMMAND_TEMPLATES` + the `req.command` branch (ops turns never build a prompt); `buildParticipantPrompt` keeps only the free-form path.
- Modify: `src/chat-participant/real-participant.ts` — `normalizeCommand` accepts the four new commands.
- Modify: `package.json` `chatParticipants[0].commands` — four entries: incident ("What changed around the current incident window?"), deploys ("DORA metrics for a service: /deploys <service> [7d|24h]"), owns ("Who owns this file, service, or topic?"), blast ("Blast radius of changing the current file or a PR").
- Modify: `src/extension.ts` participant-deps block — proxy the four new client methods.
- Tests: update `test/unit/participant-prompt.test.ts` (command-prompt cases deleted), `participant-registration.test.ts` (normalizeCommand), add manifest pin `test/unit/manifest-participant-commands.test.ts` (four names, no explain/fix/test).

- [ ] Steps: failing manifest+normalize tests → run red → implement all listed edits → suite green → commit (`feat(participant): ops slash-command vocabulary`).

### Task 2: `ops-commands.ts` pure module (TDD)

**Files:** Create `src/chat-participant/ops-commands.ts` + `test/unit/ops-commands.test.ts`.

**Interface:**

```ts
export async function runOpsCommand(
  client: ParticipantClientLike,
  req: ParticipantRequest,
  sink: ChatResponseSink,
  log: { warn(m: string): void },
): Promise<void>;
```

Routing (arg = `req.prompt.trim()`):

- `blast`: target = arg, else `req.selection?.path`; none → usage line. `agentsImpact({ fileOrPrUrl: target })` → heading + one line per finding: `- **<affectedTitle>** (<serviceId>, <category>, <hops> hop(s)) — <pathSummary>`; empty → "No downstream dependents found." + gaps.
- `owns`: topic = arg, else `req.selection?.path`; none → usage. `agentsExpert({ topicOrFile: topic, limit: 5 })` → `- **<displayName>** — <confidence> confidence, <evidence.length> signals` (top 5 of `ranked`); empty → honest none + gaps.
- `incident`: `agentsCatchup({ sinceMs: 24*60*60*1000, ...(arg ? { service: arg } : {}) })` → per section `### <serviceId> (<totalItemsInWindow> in window)` + top 5 items `- <title> — <relevanceReasons.join(", ")>`.
- `deploys`: parse `<service> [since]` (`since` matches `/^\d+(d|h)$/`, default `"7d"`); no service → usage. `metricsDora({ service, since })` → four lines `- Deployment frequency: <value> <unit> (n=<sample>)`, `value === null` → `no data (<gap>)`.
- Every call in try/catch → `sink.markdown("Nimbus could not build that brief: <errMsg>")` + `log.warn`.
- Gaps: when `gaps.length > 0`, append `_Data gaps: <detail; joined>_`.

- [ ] Steps: failing tests per route (happy, empty, error, usage) → red → implement → green → commit (`feat(participant): brief-backed ops command handlers`).

### Task 3: Route in `runParticipantTurn` + presets

**Files:**

- Modify: `src/chat-participant/participant.ts` — after the connected/empty checks: `if (req.command !== undefined) { await runOpsCommand(client, req, deps, sink); return {}; }` (bare-turn hint text updated to name the new commands). Note the empty-prompt guard must not swallow bare `/incident` (prompt may be empty when a command is set — reorder the checks).
- Modify: `src/quick-ask-presets.ts` — add `{ label: "Write tests", prompt: "Write focused unit tests for this code, following the project's existing test framework and conventions." }` to defaults; add `export function filePresetsFor(fileName: string, languageId: string): QuickAskPreset[]` returning ops presets for `*.tf` / k8s-helm YAML (languageId yaml) / `Dockerfile*` / `.github/workflows/*`: "What breaks if I apply this?", "Who owns this service?", "What changed here recently?".
- Modify: `src/extension.ts` quick-ask picker — prepend `filePresetsFor(...)` of the active editor to the resolved presets.
- Tests: `participant.test.ts` (command routes to ops, not askStream), `quick-ask-presets.test.ts` (new default + per-file-type cases).

- [ ] Steps: red → implement → full suite + typecheck → commit (`feat(quick-ask): ops presets keyed to infra file types`).

### Task 4: Full gates, push, PR (base = PR 1's branch)

Full gate set incl. package/check-vsix; whole-branch review (`git log stage2-pr1-consume-011..HEAD`); `gh pr create --base dev/asafgolombek/stage2-pr1-consume-011`. PR body: the vocabulary re-cut rationale (stop adjudicating on model quality), the honest-degradation contract, and the stacking note.
