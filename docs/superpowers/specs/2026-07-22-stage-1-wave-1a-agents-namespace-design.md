# Stage 1 Wave 1a — Expose the `agents.*` Namespace in `@nimbus-dev/client`

> **Status:** Design — approved in brainstorm (2026-07-22); ready for implementation plan.
> **Stage:** [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) Stage 1, Wave 1a — the first
> wave after [Stage 0](./2026-07-20-stage-0-real-schema-design.md) sealed the narrow waist.
> **Repos:** `nimbus-sdk` (1.5.0) → `Nimbus` (de-dup) → `nimbus-client` (0.7.0).

## Why this wave is first

Stage 1 ranks by value ÷ effort, not roadmap order. `agents.*` wins on both axes: eight methods,
all read-only, never HITL, all already vetted on the Tauri renderer allowlist, and zero gateway
changes required. It unlocks `expert` / `impact` / `catchup` — the substance of Stage 2's headline —
and `nimbus-raycast` is blocked on the same namespace.

The ecosystem roadmap's own estimate is *"a whole namespace is roughly a day plus an hour of release
latency."* That estimate assumed the SDK already shipped everything the client needs. **It does
not** — see Correction 2. The extra work is one npm release hop and a de-duplication PR, and it buys
a single source of truth instead of a third divergent copy.

## What the gateway actually exposes

`packages/gateway/src/ipc/agents-rpc.ts:382` dispatches exactly eight methods. Each validates its
params and returns `{ sessionId }` **synchronously**, then does the work fire-and-forget:

| Method | Params (validated) |
| --- | --- |
| `agents.expert` | `{ topicOrFile: string(1..1024), limit?: int 1..25 }` |
| `agents.impact` | `{ fileOrPrUrl: string(1..2048), depth?: int 1..5, service?: string(≤64) }` |
| `agents.catchup` | `{ sinceMs?: int 0..90d, service?: string(≤64) }` |
| `agents.ghost` | `{ file: string(1..2048), namespace?/namespaces?: string \| string[] }` |
| `agents.conflicts` | `{ file: string(1..2048), namespace?/namespaces?: string \| string[] }` |
| `agents.huddle` | `{ sinceMs?: int 0..90d, namespace?/namespaces?: string \| string[] }` |
| `agents.janitor` | `{ resourceRef: string, idleDays?: int>0 (default 14), cleanupAction?: string, allowGaps?: boolean }` |
| `agents.preflight` | `{ ref: string, namespace: string, changedSurface?: string[] }` |

Note `namespaces` (array) takes precedence over the singular `namespace` alias when both are given
(`agents-rpc.ts:191`). The client surfaces both, unchanged.

## Correction 1 — the async return is a notification *pair*

The Wave 1a brief names only `<agent>.briefReady`. `agents/_lib/emit-brief.ts:45-58` emits **two**
notifications:

```ts
opts.notify(opts.briefReadyMethod, { sessionId, brief: markdown, findings: brief });
// …and on any thrown error:
opts.notify(opts.briefErrorMethod, { sessionId, error: message });
```

Every agent wires both (`expert.ts`, `impact.ts`, `catchup.ts`, `ghost.ts`, `conflicts.ts`,
`huddle.ts`, `janitor.ts`, `preflight.ts` — each declaring `<agent>.briefReady` /
`<agent>.briefError`).

**Consequence:** a wrapper that subscribes only to `briefReady` hangs until timeout on every failed
agent run, and reports a timeout where the gateway supplied a real error message. Handling
`briefError` is not a refinement — it is the difference between a usable wrapper and one that lies
about why it failed.

## Correction 2 — the SDK ships the parts, not the whole

The brief states the SDK ships *"BOTH the result types (`agents/brief-types`) AND runtime guards
(`agents/guard-factory`) in `dist/`."* Measured against `@nimbus-dev/sdk@1.4.0` as installed:

**Exported from root** — the building blocks and a factory:
`AgentBriefBase`, `Evidence`, `GapNote`, `GapCategory`, `ExpertFinding`, `ImpactFinding`,
`CatchupItem`, `CatchupSection`, `JanitorPeerTouch`, `PreflightDownstream`, `ConflictType`, and
`createBriefGuard`.

**Not exported** — the composed briefs and the concrete guards:
`ExpertBrief`, `ImpactBrief`, `CatchupBrief`, `GhostBrief`, `ConflictBrief`, `HuddleBrief`,
`JanitorBrief`, `PreflightBrief`, the `AgentBrief` union, `BriefReadyPayload<B>`, and
`isExpertBrief` … `isPreflightBrief`.

`dist/agents/*` exists on disk, but the package `exports` map declares only `.`, `./testing` and
`./ipc` — so there is no deep-import escape hatch. `createBriefGuard` is a *factory*; it produces a
guard, it is not one.

Those composed types are **already written twice**:

| Copy | Location |
| --- | --- |
| Gateway | `packages/gateway/src/agents/_lib/findings.ts:29-192` |
| CLI | `packages/cli/src/types/agents.ts:25-198` |

Writing them a third time in `nimbus-client` reproduces exactly the failure the ecosystem roadmap
documents as Fact 2 — four layers disagreeing about one object with nothing to catch it. Stage 0's
rule applies unchanged: **shared types live in `nimbus-sdk` and flow one way**, MIT into AGPL.

## Design

### Three PRs, one hard ordering constraint

| # | Repo | Ships | Gate |
| --- | --- | --- | --- |
| 1 | `nimbus-sdk` → **1.5.0** | 8 composed brief types, `AgentBrief`, `BriefReadyPayload<B>`, `AGENT_NAMES` + `AgentName`, `BriefFor<A>`, 8 concrete guards | typecheck + guard accept/reject units |
| 2 | `Nimbus` | gateway + CLI re-export from SDK; local copies deleted | existing gateway/CLI suites pass **unchanged** + `preflight:fast` |
| 3 | `nimbus-client` → **0.7.0** | `subscribeAgentBrief` + 8 promise methods + validators + `MockClient` parity + conformance | validator units, mock parity, **the new conformance gate** |

PR 1 must publish to npm before PR 3 can consume it. **PR 2 is not on that critical path** — it is
what makes the promotion honest rather than additive-only, and may land in parallel with PR 3.

The SDK bump is **additive and non-breaking**, so 1.5.0 (minor), consistent with how 1.4.0 shipped
the `ItemType` promotion in Stage 0.

### The subscription wrapper

The design problem the brief flags. Two layers.

**Layer 1 — the primitive**, generic over agent *name*:

```ts
// The name → brief mapping, exported by the SDK alongside the composed types.
export type BriefFor<A extends AgentName> = {
  expert: ExpertBrief; impact: ImpactBrief; catchup: CatchupBrief; ghost: GhostBrief;
  conflicts: ConflictBrief; huddle: HuddleBrief; janitor: JanitorBrief; preflight: PreflightBrief;
}[A];

export type AgentBriefEvent<A extends AgentName> =
  | { ok: true;  sessionId: string; brief: string; findings: BriefFor<A> }
  | { ok: false; sessionId: string; error: string };

subscribeAgentBrief<A extends AgentName>(
  agent: A,
  handler: (ev: AgentBriefEvent<A>) => void,
): { dispose(): void };
```

Modelled on `subscribeHitl` (`nimbus-client.ts:234`), which registers one handler via
`ipc.onNotification` and returns `{ dispose }` that calls `offNotification`. This registers on
**both** `<agent>.briefReady` and `<agent>.briefError`; `dispose()` unregisters both.

Being generic over the agent name is what keeps a ninth agent cheap: when Spine S1's
implicit-knowledge triad lands (`nimbus why` / `glossary` / `decisions`, `roadmap.md` §Active), it
costs one `AGENT_NAMES` entry, one brief type in the SDK, and one promise method — no redesign.

**Layer 2 — eight promise methods** built on the primitive:

```ts
agentsExpert(params: ExpertParams, opts?: { timeoutMs?: number }): Promise<ExpertBrief>;
// …impact, catchup, ghost, conflicts, huddle, janitor, preflight
```

Four correctness requirements, in priority order:

1. **Subscribe before calling.** `emit-brief.ts:45` starts its async IIFE immediately, so a fast
   agent can emit `briefReady` before the RPC response is parsed. Handlers register first, always.
2. **Buffer, then correlate.** The non-obvious one: `sessionId` is only known *after* the RPC
   resolves, yet events may arrive before that. The subscription buffers events by `sessionId` until
   the call resolves, then drains and matches. A naive "resolve on the next `briefReady`" cross-talks
   between concurrent runs of the same agent — two `agentsExpert` calls in flight would swap results.
3. **Reject on `briefError`**, surfacing the gateway's message verbatim.
4. **Timeout and unconditional dispose.** Default 30 s — built-in agents target <15 s per the
   `nimbus-agent-patterns` latency budget, so 30 s is headroom, not a guess; configurable per call.
   A `finally` disposes the subscription and clears the timer on every path, including rejection.

The primitive stays public: it is the only way to observe a brief fired by another caller, and it is
what a UI needs to render progress rather than await a promise.

### Validators

`queryItems` is the precedent — the client validates shape rather than normalising casing, because
the gateway already maps rows. Two validators:

- `validateAgentSession(method, v): { sessionId: string }` — the synchronous RPC return.
- `validateBriefReady<A>(agent, v): AgentBriefEvent<A>` — narrows the notification payload, using the
  SDK's concrete guard for the `findings` field.

Both live in `src/validate.ts` alongside the existing eleven validators.

### `MockClient` parity

`MockClient implements NimbusClientLike` (`mock-client.ts:38`), so the compiler enforces parity the
moment the interface grows — no separate checklist. Mock briefs resolve deterministically from
fixtures; `subscribeAgentBrief` returns a disposable no-op consistent with `subscribeHitl`.

### The conformance gate

Following PR #12's pattern (`test/query-items-conformance.test.ts`) and its stated rule: the fixture
SHAPE comes from real gateway code, never hand-written.

A generator script in the Nimbus repo runs each of the eight agents against an in-memory index — the
`test/e2e/scenarios/*` suites already build exactly these DBs — and dumps the real `briefReady`
payloads to JSON. That file is committed to the client's `test/fixtures/`, and the regeneration
recipe is added to the existing `test/fixtures/README.md`.

The gate asserts, per agent: the golden payload validates; `findings` passes the SDK guard;
`agentVersion === 1`; `gaps` is an array; and every `kind` matches its agent name.

**Red-prove before green.** Drop `agentVersion` from one fixture brief and confirm the conformance
test fails; restore it and confirm it passes. Same discipline for each guard. A gate never observed
failing is not a gate.

## Risks

**The guard-strictness divergence is real and must be resolved, not assumed away.**
`guard-factory.d.ts` documents it deliberately: *"the cli expert/impact/catchup guards omit the query
check; every gateway guard and the remaining cli guards include it."* Promoting to one shared guard
forces a single behaviour.

Resolution: the SDK exports the **gateway-strict** variants — the gateway is the producer and defines
the wire. If that reddens CLI tests, PR 2 de-duplicates the *types* only and leaves the CLI's laxer
guards local with a comment explaining why. **Verify shape-identity between the two copies before
assuming they can merge at all** — the CLI declares `ExpertBrief = { … }` where the gateway declares
`AgentBriefBase & { … }`, and equality is not established until read field-by-field.

**Release latency.** Three repos, one npm publish on the critical path. PR 2 is deliberately kept off
that path so a slow publish does not block de-duplication.

**Fixture staleness.** The conformance fixture can go stale silently — the tradeoff Open Decision 2
already names. Mitigation is the documented regeneration recipe, not a new mechanism.

## Out of scope

- **`nimbus why`** and the rest of Spine S1's implicit-knowledge triad. It needs its own gateway agent
  first; the generic wrapper is what keeps it cheap when it arrives. Deliberately a follow-on.
- Waves 1b–1h (`consent.respond`, diagnostics, `session.*`, `audit.*`, `metrics.dora`, `connector.*`,
  `workflow.*`).
- Stage 0 Task 5 Step 8 — the human in-editor check of the VS Code Index view against a running
  gateway.
- Typing `ITEM_LINKED_ENTITY_TYPES` in `graph/relationship-graph.ts` against the SDK (Stage 1
  side-cleanup, tracked separately).
- Codegen from a machine-readable manifest (Open Decision 1) — unchanged by this wave.

## Exit criteria

- All eight `agents.*` methods reachable from `@nimbus-dev/client` with typed params and typed briefs.
- A failed agent run **rejects with the gateway's error message**, not a timeout.
- Two concurrent runs of the same agent resolve to their own results.
- The composed brief types exist in exactly **one** place; gateway and CLI import them.
- The conformance gate is green in CI and was observed red before it was green.
- `MockClient` parity is compiler-enforced.
