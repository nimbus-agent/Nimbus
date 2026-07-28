# P4b tuning slice — design

The second half of P4b. The [measurement slice](./2026-07-27-p4b-ci-latency-design.md)
shipped `audit:ci-latency` and deliberately stopped short of tuning, because the
first measurement contradicted the design of record's hunch. This slice acts on
what that measurement — and two follow-up probes — actually found.

## The finding: CI queues behind itself

The measurement slice reported a 33.9-minute worst DAG wait and ~10-minute
runner queues, and the roadmap recorded macOS contention as "the clearest lead".
**Both of those framings were wrong**, and a probe over 15 recent successful
push-to-`main` CI runs shows why.

**macOS is not the binding constraint.** For each of 45 observed `E2E Desktop`
legs, the probe identified which upstream job was last to complete — the job
that actually set the leg's eligibility:

| binding upstream OS | times it gated E2E (capture A, 2026-07-27) |
| --- | --- |
| ubuntu-24.04 | 27 |
| windows-2025 | 15 |
| macos-15 | **3** |

**Superseded split, 2026-07-28.** Re-running the corrected, promoted
`probe-dag.ts` over the same 15-run window gives ubuntu **24×**, macOS **18×**,
windows **3×** (45 legs, 0 unattributed). macOS is ~40% of legs, not 7%. Both
captures are kept in
[`docs/infrastructure-roadmap.md`](../../infrastructure-roadmap.md); the
conclusion below is unchanged, because it never rested on the split — it rests
on the uniform ~10-minute queue across every OS and on the slot arithmetic in
the next section, which both windows agree on.

Runner queue is ~10 minutes median on *every* OS, not just macOS. That
uniformity is the tell: the constraint is not runner scarcity for one platform.

**The real constraint is slot starvation.** A second probe swept a per-minute
timeline of concurrently-running jobs across four runs:

| run | jobs | wall | peak concurrent | created-but-waiting at peak |
| --- | --- | --- | --- | --- |
| 30232465196 | 105 | 40 min | 17 | 32 |
| 30231798220 | 105 | 36 min | 14 | 2 |
| 30215198584 | 105 | 74 min | 13 | 9 |
| 30215183045 | 105 | 64 min | 13 | 41 |

A push run demands ~105 job slots from a pool that grants 13–17. On run
30215198584 the concurrency profile opens with **nine consecutive minutes at
zero running jobs**. The ~10-minute queue and the 33-minute DAG wait are both
downstream of this single fact.

### Where the 105 jobs come from

`_test-suite.yml` fans out a 24-entry `coverage-gates` matrix, and `ci.yml`
calls it once per OS on push:

```text
24 coverage gates × 3 OSes = 72 jobs
```

That is 69% of the run. Each gate pays its own harden-runner, checkout, Bun
setup and dependency install before re-running a single `test:coverage:*`
script, and all 24 sit behind `needs: unit-coverage`.

This also explains the DAG wait, which decomposes as: `unit-coverage`
(~13 min on Windows) → 24 coverage shards queueing against the saturated pool →
`e2e-desktop` finally eligible at ~33.4 min.

**Consequence for the design of record.** That document proposed matrix
sharding. Sharding adds jobs to the pool that *is* the constraint, so it would
have made this measurably worse. Principle #3 — *only against measurement,
never against a hunch* — earns its keep a second time.

## Change A — a PAL-aware coverage matrix

Run the coverage-threshold gates on Linux only, **except** those whose covered
code genuinely diverges per platform.

### Which gates are PAL-touching, and how that was decided

Two static sweeps over the source tree: files named for an OS, and files that
branch on `process.platform` / `os.platform()` at runtime. OS-divergent source
lives in exactly three directories — `platform/`, `platform/sandbox/`,
`vault/` — plus a set of runtime-branching files. Mapping those onto the 24
gates:

| stays on all 3 OSes | why |
| --- | --- |
| `Vault` | `vault/{win32,darwin,linux}.ts` — DPAPI / Keychain / libsecret |
| `Sandbox` | `platform/sandbox/{win32,darwin,linux}.ts` + `seccomp-filter.ts` |
| `Updater` | `updater/factory.ts`, `updater/platform-target.ts` branch |
| `Extensions` | `extensions/install-from-local.ts` branches |
| `Perf` | `perf/bench-runner.ts`, `perf/bench-cli.ts` branch |
| `Telemetry` | `telemetry/collector.ts` branches |
| `Doctor` | `cli/src/commands/doctor-core.ts:80` — `if (platform() === "linux")` |
| `Embedding` *(added 2026-07-28)* | `embedding/lazy-scheduler.ts` statically imports `index/sqlite-vec-load.ts`, which branches per-OS on the native extension filename |
| `DB layer` *(added 2026-07-28)* | `index/migrations/runner.ts` statically imports the same file |

The remaining 15 — Engine, Agents, Sync scheduler, Rate limiter, People,
Workflow, Watcher, Config, TUI, Deployment, Health, Metrics, Preflight, MCP,
LAN — load no file that branches on platform.

**Corrected 2026-07-28 (whole-branch review):** this list originally also held
`Embedding` and `DB layer`, and that was wrong. `index/sqlite-vec-load.ts`
branches on platform for the native extension filename, and it is reached by
static import from `embedding/lazy-scheduler.ts` (plus `create-routing-runtime.ts`
and `embedding-worker.ts`) and from `index/migrations/runner.ts` — so it sits in
both gates' coverage denominators. Both were promoted to `pal: true`. The PAL
set is **9**: `Vault`, `Embedding`, `Extensions`, `Telemetry`, `DB layer`,
`Doctor`, `Updater`, `Perf`, `Sandbox`. This is the second time the static
sweep under-detected, which is why the caveat below is repeated rather than
retired.

**This is static evidence, not empirical** — and the plan review proved that
caveat was not decorative. The sweep above originally matched only
`process.platform` and `os.platform()`, missing
`import { platform } from "node:os"`, which is the **dominant idiom in this
codebase** (7 files). That omission left `doctor-core.ts` undetected and
classified `Doctor` as Linux-only despite it branching on platform — the exact
signal loss this design exists to avoid, inside the classification the design
was built from.

`Doctor` is corrected to a PAL gate above, and the detection in Change C covers
destructured `node:os` imports and `os.type()`. A stronger check still would
compare measured per-OS coverage from real lcov artifacts; static remains the
judgement of record, now with a demonstrated failure to justify the scepticism.

### Mechanism

Give **every** matrix entry an explicit `pal` field — `true` for the nine
above, `false` for the other fifteen — and split the matrix across two jobs,
each gated only on `inputs`:

```yaml
coverage-gates-pal:      # the 9 pal: true entries
  if: inputs.run-tests

coverage-gates-linux:    # the 15 pal: false entries
  if: inputs.run-tests && inputs.runner == 'ubuntu-24.04'
```

**This design originally specified a single job with one condition, and that
was wrong:**

```yaml
# WRONG — shipped through implementation and survived review before the
# whole-branch review caught it.
if: inputs.run-tests && (inputs.runner == 'ubuntu-24.04' || matrix.gate.pal)
```

`matrix` is **not** in the context set available to a job-level `if:`. GitHub's
context-availability table grants `jobs.<job_id>.if` only `github`, `needs`,
`vars` and `inputs`, because the job condition is evaluated *before* the matrix
expands. The condition would therefore either error the workflow or evaluate
falsy on Windows and macOS, silently skipping **all 24** coverage gates there —
including the `pal: true` gates whose preservation is this change's entire
safety argument. (Confirming evidence: all 15 other `matrix.`-referencing `if:`
conditions in this repo are step-level, where `matrix` *is* available.)

The `pal:` field is retained on every entry even though no `if:` reads it any
more. It is now purely the machine-readable classification Change C enforces —
including a rule that an entry's `pal` value must match the job it sits in.

`fromJSON(...)` over a single job was considered and rejected: a leg that never
expands never creates its check context, whereas a *skipped* leg does. This repo
depends on the latter (see "Why this is safe" below).

The field is explicit rather than defaulted so that a newly added gate cannot
inherit Linux-only treatment silently; Change C enforces that.

`inputs.run-tests` is gated explicitly in the condition rather than relied
upon implicitly through the `needs: unit-coverage` skip chain, matching how
every sibling job in `_test-suite.yml` gates on it directly (`static`,
`unit-coverage`, `integration`, `e2e-gateway`, `e2e-cli`, `packaging`). Without
it, a docs-only PR caller (`pr-quality-ts` with `runner: ubuntu-24.04` and
`run-tests: false`) makes the runner clause of `coverage-gates-linux`'s
condition unconditionally true — and `coverage-gates-pal` has no runner clause
at all — so without it the split would offer no protection for that caller; it
would depend entirely on `needs: unit-coverage` skipping.

Coverage gates go **72 → 42** (9 PAL × 3 OSes + 15 Linux-only × 1); a push run
goes **105 → 75**.

### Why this is safe

- **A skipped matrix leg still creates its check context** and counts as
  passing. The "Expected — Waiting for status to be reported" trap documented
  at `ci.yml:137-144` — where a never-created context blocks a merge forever —
  therefore cannot fire.
- **The repo's rulesets pin the aggregator**, `PR quality — required gates`,
  not individual coverage contexts. Verified against both live rulesets
  (`14784377`, `15436427`).
- **Every narrowed gate already runs green on Linux today.** Narrowing cannot
  introduce a new failure; it can only remove signal.
- **PRs are unaffected.** `pr-quality-ts` already passes `runner: ubuntu-24.04`,
  so PRs have always run all 24 gates on Linux only. This change makes the push
  path consistent with the PR path rather than inventing a new policy.

## Change B — narrow the E2E dependency edge

`e2e-desktop` declares `needs: [ci-ts, ci-rust]`. `ci-ts` is the whole
`_test-suite.yml` — 30 jobs including all 24 coverage shards — and
`needs:` on a matrix or reusable-workflow caller waits for **all** of it.

`e2e-desktop` consumes no artifact from `ci-ts`: it performs its own checkout,
its own `setup-nimbus-ci` install, and its own `setup-rust-tauri`. The edge is a
pure gate, not a data dependency.

Narrow it to `needs: [ci-rust]`. Measured execution for that job, from the
committed baseline:

| job | execMedian |
| --- | --- |
| `CI — Rust/Tauri (ubuntu-24.04)` | 1.25 min |
| `CI — Rust/Tauri (macos-15)` | 1.17 min |
| `CI — Rust/Tauri (windows-2025)` | 1.72 min |

This keeps the prerequisite that carries meaning — a broken Tauri/Rust build
makes E2E Desktop unrunnable — and drops a ~33-minute wait on 24 coverage shards
that tell E2E nothing.

**Side effect on the probe.** Narrowing the edge collapses the gating margin
from ~60 min to ~1.2 min, which makes it plausible for `bindingUpstream` to find
no candidate completed at or before a leg's eligibility moment. `probe-dag.ts`
now counts such legs and emits one `::warning::` naming the count, rather than
skipping them silently — the after-measurement is the only instrument that can
show this slice worked, so it must not quietly measure fewer legs than ran.

## Change C — stop the PAL classification rotting silently

Changes A and B are point-in-time judgements about which code branches on
platform. Without a guard, the day someone adds `process.platform` to a
Linux-only gate's code, coverage on Windows and macOS quietly stops watching it
and **nothing fails**. That is the same silent-decay failure mode the
measurement slice had to guard for the `created_at` assumption.

A directory scan over the 15 Linux-only gates cannot do this job: the coverage
scripts name *test* paths (`test:coverage:db` runs
`packages/gateway/test/unit/db`, never naming `src/db`), coverage is measured
over files loaded at runtime including transitive imports, and cross-platform
tests branch on `process.platform` legitimately — so such a scan would be both
incomplete and full of false positives.

`scripts/structure-audit/check-coverage-gate-pal.ts` inverts it, following the
D10–D22 confinement pattern already used for tool ids and dispatch sites:

1. Enumerate every source file branching on platform — `process.platform`,
   `os.platform()`, `os.type()`, or a destructured
   `import { platform } from "node:os"` — or importing an OS-named module
   (`win32`/`darwin`/`linux`). The scan must reach `src` directories at **any**
   depth: `packages/mcp-connectors/src` does not exist, and a one-level scan
   silently skips all 94 connectors.
2. Require each in a checked-in allowlist entry declaring **which coverage gate
   covers it**.
3. Cross-check that the declared gate carries `pal: true` in the matrix.
4. Require every matrix entry to carry an explicit `pal` field.
5. *(added 2026-07-28)* Require both coverage-gate jobs to exist and to carry
   the exact `if:` conditions the split depends on, and require each entry's
   `pal` value to match the job it sits in.
6. *(added 2026-07-28)* Require the runner literal inside
   `coverage-gates-linux`'s condition to match the Linux runner label `ci.yml`
   actually calls `_test-suite.yml` with.

Rules 5 and 6 exist because the first revision of this audit validated the
`pal:` fields and never read the `if:` lines that consume them — which is
exactly how the broken job-level `matrix.gate.pal` condition shipped green. The
runner label is now duplicated between `ci.yml` and `_test-suite.yml`; without
rule 6, bumping it in one place would silently drop all 15 Linux-only gates.

A new platform-branching file then fails the audit until its author either
refactors it behind the PAL or promotes its gate to `pal: true`.

## Verification — and why our own gate cannot do it

`audit:ci-latency` gates on **execution** time. This change barely moves
execution; the win lands in **queue** and **DAG wait**, which that gate
deliberately reports and never gates, because neither is caused by the
contributor's change.

So the gate cannot prove this slice worked, and pretending otherwise would be
the same category of error the measurement slice was built to prevent. The
proof is instead:

1. Both probe scripts are promoted from scratch into
   `scripts/ci-latency/probe-dag.ts` and `scripts/ci-latency/probe-concurrency.ts`,
   run manually against `main` before and after the change.
2. The before/after figures are recorded in the P4b progress log in
   [`docs/infrastructure-roadmap.md`](../../infrastructure-roadmap.md).

**Expected effect.** DAG wait 33.4 min (measured 2026-07-27) → ~3 min. That
33.4-minute figure was re-measured on 2026-07-28, against the same `main`
window, at **60.5 min median (max 110.8, n=15)** — CI congestion nearly
doubled between the two dates, so 60.5 min, not 33.4, is the baseline this
slice's "after" measurement must be compared against. Jobs-per-run 105 → 75.
Peak created-but-waiting materially reduced. If the measured result
contradicts these numbers, the recorded outcome is the measurement — not the
prediction.

**Baseline note — and when to regenerate.**
`docs/structure-audit/ci-latency-baseline.json` holds entries for the 30
coverage keys (15 Linux-only gates × 2 dropped OSes) that stop being produced on
macOS and Windows. `evaluate` reports
an absent key as `stale-baseline-entry` — a warning, never a regression — so the
gate stays green throughout.

Regeneration timing follows the sampling window, not the merge.
`MAX_RUNS_PER_WORKFLOW` is 12, so immediately after this lands the window still
contains pre-change runs carrying those keys; they keep receiving observations
and produce no warnings yet. Running `--update-baseline` inside the PR would be
a **no-op** — `computeUpdatedBaseline` drops only keys absent from the window,
and they are present. Deleting them by hand is no better: `evaluate` would then
report `new-key` for each while the pre-change runs remain in the window.

So: **regenerate once roughly 12 post-change push runs have accumulated**, when
the abandoned keys have aged out of the window.

## Risks

| risk | assessment |
| --- | --- |
| Losing per-OS coverage signal on 15 gates | Bounded by the static sweep above. Recorded as a judgement, not a proof. |
| Non-Negotiable #5, platform equality | Every test still executes on all 3 OSes via `static`, `unit`, `integration`, `e2e-gateway`, `e2e-cli`. Only *threshold enforcement* narrows. Read as compatible; flagged for the owner's ruling. |
| A TS-failing, Rust-passing `main` commit burns E2E runners | **Deferred, on measured data.** 2 of the last 40 `main` commits arrived without a PR (`a91d73ec`, `7176dd49`) — both `ci(cla)` workflow commits, neither touching TypeScript. The residual case is two green PRs merging into a semantic conflict. Guarding it has real cost: no standalone fast typecheck exists (`Static`, 4.57 min, is inside `_test-suite.yml` and unreachable by `needs:`), so it would mean a new job duplicating typecheck on every push plus ~3 min of DAG depth added back. `CI — Structure audit` (0.83 min) was evaluated as a cheap substitute and rejected — it runs `audit:boundaries`/`invariants`/`release-please`, not typecheck. **Trigger to adopt:** a `main` E2E run observed burning on a TS compile failure. |
| Cross-job cancellation as an alternative guard | **Not available.** GitHub Actions cannot cancel a job with no `needs` relationship to the failing one; `fail-fast` operates within a matrix, not across jobs. Removing the edge removes the cancellation relationship by definition. |
| Fewer jobs could mask a future regression in the removed legs | The removed legs are threshold *enforcement*, not test execution. A behavioural break still fails the 3-OS suites. |

## Out of scope

Consolidating the remaining 15 Linux gates into fewer grouped jobs (~75 → ~60).
Deferred deliberately: it makes failure reports coarser and is the least
reversible of the available levers. Revisit only if the measured result of this
slice falls short.
