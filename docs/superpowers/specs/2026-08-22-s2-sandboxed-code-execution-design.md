# S2 Slice 1 — Sandboxed Code Execution

**Date:** 2026-08-22
**Spine slot:** S2 — Local Compute Fleet (opened 2026-08-21; this is the first thing to ship in it)
**Roadmap row:** [Phase 14 § Core — Code Execution Sandbox](../../roadmap.md#phase-14--agent-evolution--ai-v2)
**Predecessor:** [`2026-08-21-windows-sandbox-and-policy-design.md`](./2026-08-21-windows-sandbox-and-policy-design.md) (#1294) — which built the substrate this consumes.

---

## 1. Goal

Turn the three-OS sandbox that shipped in #1294 from something only *connectors* spawn into something the **owner** can run arbitrary code inside, behind the HITL gate, with a full audit record.

#1294 left an explicit hand-off. `platform/sandbox/sandbox-policy.ts` was deliberately shaped so that "a per-execution capability set can reach the same three runners a connector uses", and its `limits.wallClockMs` field carries the comment *"DECLARED BUT NOT ENFORCED by any runner in this release — the execution surface adds enforcement."* This slice **is** that execution surface.

### Non-goals for this slice

| Deferred | Why |
|---|---|
| Agent-callable `execute_code` mesh tool | Opens a path from indexed untrusted text to a consent prompt for arbitrary code. Deliberate second slice, after the gate/audit/capability shape has proven out. |
| `--allow-net` | Arrives with its egress-ledger appender, not before it. See §9. |
| `nimbus exec --interactive` (REPL) | A per-block approval loop earns its complexity only once single-shot approval works. |
| Remote sandbox adapters (E2B/Modal/Daytona) | Directly contrary to local-first; the roadmap gates them behind `enforce_air_gap` anyway. |
| Deno / Python runtimes | The registry is built now; the entries are later. |

---

## 2. Scoping decisions

Four forks were settled before design:

1. **Runtimes** — build the pluggable `ExecRuntime` registry up front, wire **only Bun**. Bun is the runtime the Gateway already runs under: zero new external dependencies, guaranteed present on every dev machine and CI runner. Adding Deno or Python later is a registry entry, not a refactor.
2. **Caller** — **CLI / owner only.** The LLM cannot trigger an execution in this slice.
3. **Network** — **none, at all.** Not grantable.
4. **Org policy lockoff** — **included in this slice** (§6).

---

## 3. Architecture

```
packages/gateway/src/exec/
  exec-gate.ts             The ONLY path to a code execution. Owns policy
                           construction, confinement assertion, HITL approval,
                           spawn, output capture, audit append.
  exec-consent-broker.ts   ExecConsentBroker extends ConsentBroker<ExecApprovalInput>
  exec-runtimes.ts         ExecRuntime registry: { id, detect(), argvFor(file) }
  exec-policy.ts           code + requested grants -> SandboxPolicy
  exec-result.ts           { exitCode, stdout, stderr, durationMs, truncated }
```

### Why a dedicated gate rather than an executor action type

The alternative was adding `code.execute` to `HITL_REQUIRED_BACKING` and routing through `ToolExecutor.gate()`. Rejected: the executor's gate is shaped around **connector dispatch** — it pairs every gated action with a dispatcher and an `EgressSink`. Local code execution is neither, so it would need the `NULL_EGRESS_SINK` escape hatch that exists for vault/reindex-style local mutations, and it would place arbitrary code execution inside a frozen set whose 40+ members are all "call a cloud API". That weakens the set's meaning rather than strengthening the new capability.

A dedicated gate is also the **established pattern** for high-blast-radius *local* capabilities: `share/share-gate.ts` (I27), `tribal/tribal-write-gate.ts` (I25), `federation/preflight-gate.ts` (I24). Each owns one greppable chokepoint that a static `D`-rule confines, and each takes approval as an injected dependency so it is unit-testable without the engine.

### Three load-bearing rules

1. **Network is refused at construction, not at spawn.** `exec-policy.ts` never populates `permissions.network`. A caller-supplied net grant is a **rejection with a named error**, never a silently-dropped field. (Prior art: a supplied flag degrading into an omitted filter is invisible gateway-side.)

2. **The confinement assertion is `isFullyActive()`, never `degradedReason() === null`.** On Windows `degradedReason()` returns a **non-null string even when the runner is fully active** — it reports the accepted per-host-filtering caveat (`win32.ts:70-75`). A gate written the intuitive way would refuse every execution on Windows, permanently.

3. **The gate asserts confinement even though all three platforms already behave.** Measured today:
   - **Windows** already fails closed — `win32.ts:54` *throws* rather than spawning unconfined when the helper is missing (I15 posture).
   - **Linux** degradation is network-only — the helper probe tests `CAP_NET_ADMIN` for per-host gating (`linux.ts:86-110`); `bwrap` filesystem confinement and seccomp still apply without it.
   - **macOS** is always fully active (`darwin.ts:218`).

   All three are *derived* facts about today's code, and they are safe **because** of the no-network decision. An explicit assertion in the gate is what keeps the property true when network arrives in slice 2.

---

## 4. HITL and audit

**Consent.** `ExecConsentBroker extends ConsentBroker<ExecApprovalInput>` broadcasting `exec.approvalRequest`, answered by `exec.approvalRespond`. This is the third binding over the shared `util/consent-broker.ts` base (after share and federated-preflight), so fail-closed TTL behaviour is inherited rather than re-implemented.

**The prompt shows the full code body verbatim — never a digest.** The human is the entire security boundary in this slice; a prompt reading "run script sha256:a1b2…" is a rubber stamp with extra steps. Alongside it: runtime id, resolved filesystem read/write paths, `network: none`, wall-clock budget, cwd.

**Audit.** Every outcome appends one row via `appendAuditEntry`:

```ts
{ actionType: "code.execute",
  hitlStatus: "approved" | "rejected" | "timeout",
  actionJson: JSON.stringify({
    runtime, codeBody, grants, exitCode,
    stdoutDigest, stderrDigest, durationMs, truncated }) }
```

Body in full, output hashed. That asymmetry is deliberate and matches the roadmap's acceptance criterion: the code is what you consented to; the output is potentially enormous.

---

## 5. CLI and configuration

```
nimbus exec --file ./script.ts
nimbus exec --code 'console.log(1+1)'
  --runtime bun                    # registry id; defaults to the sole wired entry
  --allow-fs-read  <path>          # repeatable
  --allow-fs-write <path>          # repeatable
  --timeout <ms>                   # bounded by config max
```

Lives at `packages/cli/src/commands/exec.ts`, exported from `commands/index.ts`.

```toml
[code_execution]
enabled           = false      # DEFAULT OFF
max_wall_clock_ms = 30000
max_output_bytes  = 1048576
allowed_runtimes  = ["bun"]
```

Follows the established `NimbusCodeExecutionToml` + `DEFAULT_NIMBUS_CODE_EXECUTION_TOML` + parser pattern in `config/nimbus-toml.ts`.

**Default-off matters beyond caution:** with `enabled = false` the gate refuses *before* reaching consent, so a fresh install has no arbitrary-code-execution path at all, and the capability's existence cannot be probed via a consent prompt.

---

## 6. Org-level policy lockoff

`EnforcedPolicy` has no capability field today. Rather than adding booleans, model it as a **disabled set**, mirroring `hitlRequired`:

```ts
OrgPolicy.capabilities  = { readonly disabled: readonly string[] }
LocalBaseline          += capabilitiesDisabled: ReadonlySet<string>
EnforcedPolicy         += capabilitiesDisabled: ReadonlySet<string>   // union
```

`computeEnforced` unions the two sets.

**Union is monotonic-stricter by construction**, so the "which boolean wins" question never arises. Concretely: `[capabilities.ai_v2] code_execution = false` **adds** to the disabled set, and `code_execution = true` is a **no-op, not a grant** — a peer-distributed policy can never re-enable what the anchor disabled. A boolean-valued field would have made that re-enable the natural reading, which is exactly the I22 tighten-only property it must not break. Absence of the block is an empty set, so every existing policy behaves identically.

The gate reads `EnforcedPolicy.capabilitiesDisabled.has("code_execution")` — never raw policy TOML (I22).

The field serves all five `ai_v2` capabilities (`code_execution`, `computer_use`, `tool_generation`, `multimodal_input`, `local_finetuning`), not just this one, so later S2 rows inherit it.

---

## 7. Security invariant I33

I32 is the current ceiling; I28 stays reserved. Static rule **D23**.

> **I33** — user-supplied code executes only through `exec/exec-gate.ts` `runExecution()`: the runtime is resolved from the `ExecRuntime` registry (never a caller-supplied argv), the `SandboxPolicy` is constructed with `permissions.network` unconditionally empty (a requested net grant is rejected, never dropped), the runner is asserted `isFullyActive()` before spawn, the capability is refused when disabled by local config or by `EnforcedPolicy.capabilitiesDisabled` (I22), the LOCAL owner approves the verbatim code body and resolved capability set via `exec.approvalRequest`, and a denied/timed-out approval spawns nothing (fail-closed). Every outcome appends one `code.execute` audit row. No other path spawns a process from user-supplied code.

Per the triple rule, the wiring, the `docs/SECURITY-INVARIANTS.md` section, and the `security-invariants.test.ts` case land in **one commit**.

---

## 8. Testing

| Layer | What it proves |
|---|---|
| `exec-gate.test.ts` | net grant *rejected* (not dropped); non-`isFullyActive()` runner refused; **denied approval spawns nothing**; timeout kills; truncation disclosed; capability-disabled refusal |
| sandbox integration suite | a real confined spawn per OS — the suite the `pr-quality-cross-platform` legs actually run |
| `security-invariants.test.ts` | the I33 case |
| `check-nimbus-invariants.ts` | static D23 — spawn-from-user-code confined to `exec-gate.ts` |
| `policy-gate.test.ts` | union semantics; `= true` does not loosen |
| e2e CLI | `nimbus exec` approved and denied paths |

**The denied-approval test is red-proven by reverting the guard**, not by observing green. A test that passes because nothing happened is the recurring failure shape in this repo's history; the assertion is a spy on the runner, never an absent side effect.

---

## 9. Known bounds (documented, not glossed)

1. **I11 (`wrapToolOutput`) is not exercised.** No output reaches the LLM in this slice. The envelope becomes load-bearing when the agent-callable path lands. Wiring a no-op envelope now would let us claim I11 coverage that never carried anything.
2. **Zero egress rows from `exec` is true by construction** — no network is grantable — not by an appender that was forgotten. `nimbus prove`'s claim is unaffected by this slice.
3. **Wall-clock is enforced by gate-level kill**, not OS job limits: SIGTERM→SIGKILL escalation on POSIX; on Windows SIGTERM is already `TerminateProcess(1)`. The Windows Job-Object route stays available as later hardening. The `sandbox-policy.ts` comment is updated in the same commit so it stops describing a future that has arrived.
4. **A runtime listed in `allowed_runtimes` but absent from the machine** fails at detect with a named error, not at spawn.
5. **The lockoff only tightens** — it cannot enable a capability the local config has off.
6. **Linux's harmless degradation is contingent on no-network.** If slice 2 grants network, the `isFullyActive()` assertion becomes the only thing standing between a missing `CAP_NET_ADMIN` helper and unfiltered egress.
