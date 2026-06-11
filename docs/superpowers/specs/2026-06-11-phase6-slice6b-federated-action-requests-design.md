# Phase 6 Slice 6b — Federated Action Requests (Cloud Janitor + Blast-Radius Preflight)

**Date:** 2026-06-11
**Status:** Design approved; ready for implementation plan
**Slice:** Phase 6 (Team) — Slice 6b (after Slice 6a, PR #574)
**New invariant:** I24 (static complement D18)

## 1. Summary

Slice 6b ships the two **federated action-request** features of Phase 6's
cross-colleague set, in one combined branch/PR:

- **Cross-team cloud janitor** — a read-only agent that asks every paired peer's
  Gateway, content-free, whether any recent local activity has touched a given
  cloud resource (e.g. `i-12345`). If every *answering* peer reports the resource
  idle for at least N days, the janitor emits a brief recommending the exact
  HITL/quorum-gated cleanup action the owner can then run.
- **Cross-team blast-radius preflight** — before merging a PR, an upstream
  service owner's Gateway sends a preflight request to downstream service owners'
  Gateways. A downstream Gateway runs its **own, locally configured** test command
  against the change **only after the downstream owner approves via their local
  HITL queue** — never on the upstream caller's say-so — inside the per-OS
  sandbox. Aggregated pass/fail results return to the upstream PR.

The preflight introduces the slice's structural heart: **invariant I24** — a
federated action/preflight request executes only behind the LOCAL owner's HITL
gate, never selects or supplies its own command, and runs only inside the
sandbox.

## 2. Scope decisions (locked during brainstorming)

1. **One combined slice** — both features + I24 land together (like Slice 6a
   bundled ghost/conflicts/huddle).
2. **Janitor peer query = content-free recency probe** — each peer returns only
   `{ touched, lastSeenDaysAgo? }`, mirroring the shipped privacy-preserving
   expertise primitive. No item bodies cross the wire. Stays under I17.
3. **Janitor output = read-only proposal brief** — the janitor stays a read-only
   agent (the built-in-agent shape invariant holds). It names the precise
   cleanup action; the owner triggers actual execution as a separate,
   already-HITL/quorum-gated step. No new executor/quorum plumbing.
4. **Preflight downstream execution = real test-command run in the sandbox** —
   the literal reading, made safe by I24: the command is downstream-owner
   configured (never caller-supplied); only bounded, validated parameters ride in
   from the request; execution is gated by the downstream owner's local HITL
   approval and runs inside the I15 `createSandboxRunner` boundary.

### 2.1 Assumed defaults (approved)

1. The preflight command lives in **local `nimbus.toml`**
   (`[federation.preflight.<namespace>]`), owner-controlled per local-first.
   Org-policy allowlisting of the command is deferred to a later slice.
2. **No new migration.** The janitor reuses Slice 6a's V38 known-namespaces
   cache; inbound preflight requests live in an in-memory pending registry
   (mirroring the consent broker / quorum coordinator), with `audit_log` entries
   for request/approval/result. Schema stays at V38.
3. The preflight uses a **single downstream-owner local HITL approval** (the
   consent-broker path), not I21 quorum.
4. The upstream sends a **change descriptor** (namespace + git ref/version +
   optional changed-symbol list), not a diff to apply. The downstream's
   configured command fetches/pins the candidate build from the ref itself.

## 3. Non-negotiables honored

- **Local-first** — the preflight command is owner-configured local state; no
  caller can supply or change it.
- **HITL is structural** — the downstream test run is gated by the local owner's
  HITL approval in the gate path, not the prompt; cannot be bypassed.
- **MCP-as-connector / sandbox** — the test command runs inside the same per-OS
  sandbox boundary (`createSandboxRunner`) used for connector child processes.
- **No `any`** — `unknown` for all wire-inbound data; validated before use.
- **Platform equality** — sandbox runner is per-OS; the integration test fakes
  the runner (real landlock/seccomp/seatbelt/Job-Objects can't run
  deterministically in CI).

## 4. Architecture

### 4.1 Reused as-is

`federation/peer-fanout.ts` (`runPool` bounded-parallel cap-5, `PeerFanoutDeps`,
`GapNote` handling, no_grant prune); `agents/_lib/match-token.ts`;
`emitBriefWithSynthesis` + the `_lib/{findings,emit-brief,synthesize,render,
fanout-deps,gap-notes}.ts` agent substrate; `federation/expertise.ts`'s
content-free LIKE-scoring pattern; `federation/consent-broker.ts`'s
broadcast-and-resolve pattern; `dispatchFederationRpc` / `FederationRpcContext`;
`platform/sandbox/createSandboxRunner()`; `ipc/_lib/long-running.ts`
(`LongRunningJobRegistry`); `cli/src/commands/_agent-brief-cli.ts`
(`runAgentBriefCli`).

### 4.2 New / modified files

**Janitor (read-only — asker + answerer):**

- `federation/resource-probe.ts` — `probeResourceRecency(db, { resourceRef })`
  returns `{ touched: boolean; lastSeenDaysAgo?: number }`. Mirrors
  `scoreExpertise`: wildcard-escaped LIKE-match the resource ref against recent
  `item` rows; return only the boolean + recency. Leak-proof.
- `federation/peer-fanout.ts` — add `fanOutProbe(deps, { resourceRef, purpose })`
  returning `PeerFanoutOutcome<PeerProbeResult>`.
- `federation/federation-rpc.ts` — inbound `federation.probe` →
  `probeResourceRecency`, audited like a read query.
- `agents/janitor.ts` — `runJanitor` + `emitJanitorBrief` via
  `emitBriefWithSynthesis`: fan-out probe, decide idle ≥ N days across all
  answering peers, render a brief naming the cleanup action; gaps suppress the
  proposal.

**Preflight (I24 — upstream + downstream):**

- `federation/preflight-gate.ts` — **the sole I24 wiring site.**
  `answerFederatedPreflight(ctx, req)`: identity (I18) → scope/grant (I17-style)
  → resolve **local-config** command (fail-closed if none) → **local owner HITL
  approval** via `PreflightConsentBroker` → sandbox-spawn the configured command
  with validated params as env → leak-proof `{ passed, summary }`. Audited each
  outcome. Mirrors `invoke-gate.ts` (I19).
- `federation/preflight-consent-broker.ts` — `PreflightConsentBroker` (broadcast
  `federation.preflightRequest` to local clients; `respond(id, approved)`;
  TTL safety-net), mirroring `FederationConsentBroker`. Process singleton.
- `federation/preflight-runner.ts` — wraps `createSandboxRunner()`: builds a
  minimal scoped `ExtensionManifest` (test dir only), spawns the configured
  command with validated params as env vars, captures exit code → `{ passed,
  summary }`. The only consumer of the sandbox in the preflight path. DI seam for
  the runner so tests inject a fake.
- `federation/peer-fanout.ts` — add `fanOutPreflight(deps, { ref, changedSurface,
  purpose })`.
- `federation/federation-rpc.ts` — inbound `federation.preflight` →
  `answerFederatedPreflight`; extend `FederationRpcContext` with the preflight
  gate deps (config-command resolver, consent broker, runner, identity guard).
- `federation/federation-server.ts` — thread the new ctx deps through
  `buildFederationLanServer`.
- `agents/preflight.ts` — `runPreflight` (upstream): resolve downstream owners
  (policy ownership map → paired peers fallback), `fanOutPreflight`, aggregate
  into a brief via `LongRunningJobRegistry`.
- `config/nimbus-toml.ts` — `[federation.preflight.<namespace>]` schema:
  `{ command: string; args?: string[]; cwd?: string; timeoutSeconds?: number }`.

**Shared surfaces:**

- `agents/_lib/{findings,emit-brief,synthesize,render}.ts` — extend the brief
  unions with `janitor` + `preflight` kinds (the Slice 6a edit set).
- `ipc/agents-rpc.ts` — `agents.janitor` + `agents.preflight`.
- `ipc/federation-rpc.ts` — `federation.probe`, `federation.preflight`,
  `federation.preflightRespond` (local owner approves an inbound request).
- `ipc/server/dispatchers.ts` — thread new ctx (index/selfIdentity/sendOverWire,
  preflight gate deps).
- `cli/` — `nimbus janitor <ref>`, `nimbus preflight <ref>`, `nimbus preflight
  approve <id>`; via `runAgentBriefCli` + a respond command. Register in
  `cli/index.ts` `COMMAND_HANDLERS` + `cli/registry.ts` `COMMAND_NAMES` +
  `cli/src/types/agents.ts`.
- Tauri allowlist — add read-only `agents.janitor` / `agents.preflight`;
  `federation.preflightRespond` stays **CLI-only** (an approval/RCE-adjacent
  action, like `federation.pair`). Bump the Rust count + the JS mirror in
  `security-invariants.test.ts`.
- `docs/SECURITY-INVARIANTS.md` (I24 row) + `security-invariants.test.ts` (I24
  assertions) + `scripts/structure-audit/check-nimbus-invariants.ts` (D18) +
  CLAUDE.md / GEMINI.md invariant-count prose + `docs/CHANGELOG.md`.

### 4.3 Data flow — janitor probe (read-only)

```text
nimbus janitor i-12345 --idle-days 14
  -> agents.janitor -> runJanitor -> fanOutProbe
       per peer: federation.probe { resourceRef:"i-12345", purpose }
         answerer: probeResourceRecency
           -> { touched:false } | { touched:true, lastSeenDaysAgo:3 }
  -> if every ANSWERING peer is touched=false OR lastSeenDaysAgo >= 14
       brief: "i-12345 idle >=14d across N peers.
               Cleanup: nimbus run cloud.instance.terminate i-12345"
  -> gaps (unreachable / no_grant) are NEVER counted as idle; they suppress
     the proposal and are surfaced in the brief.
```

Safety rule: a peer that does not answer (gap / no_grant / unreachable) is never
treated as "idle." The janitor proposes a cleanup only when every answering peer
is clear **and** coverage is complete; otherwise it reports the gap and withholds
the proposal.

### 4.4 Data flow — preflight (I24)

```text
UPSTREAM:  nimbus preflight HEAD~1..HEAD
  -> agents.preflight -> runPreflight -> resolve downstream owners
     -> fanOutPreflight
          per owner: federation.preflight { ref, changedSurface, purpose }

DOWNSTREAM (answerer — preflight-gate.ts, I24):
  1. verify caller identity (I18 isOperatorValid)   else -> { error:"no_grant" }
  2. scope/grant check (namespace shareable to peer) else -> { error:"no_grant" }
  3. resolve LOCAL [federation.preflight.<ns>].command
                                            else -> { error:"not_configured" }
  4. PreflightConsentBroker.request -> broadcast federation.preflightRequest
       owner runs `nimbus preflight approve <id>` -> federation.preflightRespond
       deny / TTL-timeout                          -> { error:"denied" }
  5. preflight-runner: createSandboxRunner().spawn(command, args,
       { manifest, env:{ NIMBUS_PREFLIGHT_REF:ref, ... } })
       — any caller-supplied command field is IGNORED; only step-3 command runs
  6. -> { kind:"ok", passed:bool, summary:"42 passed, 0 failed" }
        (no paths, no file contents)

UPSTREAM aggregates:
  brief "downstream X: pass | Y: fail (3 tests) | Z: declined"
```

Validated params (`ref` / `changedSurface`) reach the command **only as env
vars**, after validation (ref matches a safe git-ref charset; arrays bounded) —
never concatenated into a shell command.

## 5. Invariant I24

**Statement (for `SECURITY-INVARIANTS.md`):** A federated preflight (action)
request executes only behind the LOCAL owner's HITL gate, never on the caller's
say-so, and runs only a downstream-owner-configured command inside the per-OS
sandbox. The caller-supplied request never selects or supplies the command;
missing local config fails closed.

**The triple (lands in one commit):**

- **Production wiring** — `federation/preflight-gate.ts` `answerFederatedPreflight`
  is the sole path from an inbound `federation.preflight` to a sandbox spawn. It
  (a) resolves the command from local config only, (b) awaits
  `PreflightConsentBroker` approval before any spawn, (c) spawns via
  `preflight-runner.ts` (`createSandboxRunner`), (d) returns leak-proof
  `{ passed, summary }`.
- **Runtime test** (`security-invariants.test.ts`):
  1. an inbound request does not spawn until local approval resolves (spawn-fake
     uncalled pre-approval, called post-approval);
  2. a request carrying its own `command`/`cmd`/`args` field has that field
     ignored — only the configured command runs;
  3. no local config → `{ error:"not_configured" }`, zero spawn;
  4. denied / timeout → zero spawn;
  5. the result payload contains no filesystem paths or file contents.
- **Static D18** (`check-nimbus-invariants.ts`): the preflight
  command-resolution + the `createSandboxRunner` / `preflight-runner` import are
  confined to `preflight-gate.ts` / `preflight-runner.ts` (mirroring D15's
  invoke-gate confinement); any other file referencing the preflight runner fails
  the static audit before the suite runs. Also assert `preflight-gate.ts` imports
  the consent broker (gate-before-spawn is structurally present).

## 6. Error handling (fail-closed throughout)

- **Downstream gate:** identity-invalid / no-grant → opaque `{ error:"no_grant" }`
  (no state leak, mirrors invoke-gate). Not-configured →
  `{ error:"not_configured" }`. Denied / TTL → `{ error:"denied" }`. Sandbox spawn
  failure → `{ kind:"ok", passed:false, summary:"preflight could not run" }` (a
  test failing vs the runner erroring are distinguished but both leak-proof).
- **Upstream:** each downstream error becomes a gap-style line in the brief
  (`declined` / `not configured` / `unreachable`); a non-answering downstream is
  never rendered as "safe to merge."
- **Janitor:** gaps suppress the cleanup proposal (coverage-incomplete is noted,
  never silently treated as idle).
- **Timers:** TTL timers follow the `bun test` unref-timer guidance — no `.unref()`
  on an awaited path.

## 7. Testing

- **Unit:** `resource-probe` (content-free shape, wildcard-escape); `peer-fanout`
  new arms (probe/preflight gap/no_grant/timeout); `preflight-gate` (every I24
  branch — the security test doubles as the gate's coverage); `preflight-runner`
  (spawn via injected runner fake; pass/fail/spawn-error); `preflight-consent-broker`
  (approve/deny/timeout/unknown-id); the two agents (decompose + render +
  injected-LLM emit branch); config parse.
- **Integration:** a two-gateway preflight acceptance (upstream fan-out →
  downstream gate → local approve → sandboxed echo-command → aggregated result),
  mirroring the Slice-2 two-gateway invoke test; plus a janitor multi-peer
  acceptance. Sandbox runner faked / echo at the integration layer.
- **E2E CLI:** `nimbus janitor` / `nimbus preflight` via DI dispatcher
  (`cli-mocks`), mirroring `impact.ts`. CLI commands are not coverage-excluded.
- **Discipline:** 0 `any`; DI over `mock.module` (the combined-cli-run trap);
  scoped `bun test <path>` wrapped in `timeout 60`.

## 8. Coverage & CI

- Every new file ≥ 80% branch + line on Linux (Docker `oven/bun:latest`, the
  `nimbus-coverage-floor` agent). No `*-v*-sql.ts` this slice (no migration).
- Reseed the committed baseline **only from the PR's own merge-commit lcov**,
  never local Docker. Expect one red CI round (incidental sibling coverage +
  SonarCloud new-code duplication — fix-not-exclude; lean on the Slice 6a
  `_agent-brief-cli.ts` / `fanout-deps.ts` extraction helpers).
- Pre-push: `bun run preflight:fast` + the Docker coverage-floor.
  `lint:markdown` the spec/plan docs (MD022/031/032/009/056).

## 9. Task sequencing (subagent-driven-development)

Fresh subagent per task; two-stage spec/quality review; I serialize git.

1. `[federation.preflight.<ns>]` config schema + parse.
2. `resource-probe.ts` (unit).
3. `peer-fanout` `fanOutProbe` (unit, DI fake send).
4. `federation.probe` inbound RPC + audit.
5. `agents/janitor.ts` + brief unions + render.
6. `agents.janitor` IPC + `nimbus janitor` CLI.
7. `preflight-consent-broker.ts` (unit).
8. `preflight-runner.ts` (sandbox via injected runner fake).
9. **`preflight-gate.ts` + I24 triple (wiring + SECURITY-INVARIANTS row +
   security test + D18) — same commit.**
10. `federation.preflight` + `federation.preflightRespond` inbound RPC +
    `FederationRpcContext` / `federation-server.ts` threading.
11. `peer-fanout` `fanOutPreflight` (unit).
12. `agents/preflight.ts` (upstream, `LongRunningJobRegistry`) + unions / render.
13. `agents.preflight` IPC + `nimbus preflight` / `nimbus preflight approve` CLI.
14. Tauri allowlist bump (Rust + JS mirror) + `nimbus-toml` doc/schema-version
    prose + CLAUDE / GEMINI invariant count + CHANGELOG.
15. Two-gateway preflight integration acceptance + janitor integration.
16. Full `preflight` + Docker coverage-floor + reseed.

## 10. Acceptance criteria (roadmap-tied)

- A janitor query for a cloud resource that every answering peer reports idle for
  at least N days produces a brief naming the exact cleanup action; a peer that
  does not answer suppresses the proposal and is surfaced as a gap.
- An inbound preflight request never runs any command until the downstream owner
  approves it through their local HITL queue; a request carrying its own command
  field cannot change what runs; a downstream with no configured command fails
  closed.
- A two-gateway preflight returns aggregated downstream pass/fail to the upstream
  caller; a declined or unreachable downstream is never rendered as
  "safe to merge."
- I24 holds: the runtime invariant test and static D18 both fail if the
  gate-before-spawn wiring or the command-confinement is removed.

## 11. Out of scope (later slices)

- Scheduled / ambient janitor sweeps (this slice is manual CLI-triggered).
- Org-policy allowlisting of the preflight command (local config only here).
- The janitor enqueuing an executable pending action into the team HITL/quorum
  queue (read-only proposal brief only here).
- Tribal-knowledge extraction (Slice 6c).
- Applying an upstream diff to the downstream checkout (the downstream command
  fetches the candidate build from the ref itself).
