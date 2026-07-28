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

| binding upstream OS | times it gated E2E |
| --- | --- |
| ubuntu-24.04 | 30 |
| windows-2025 | 15 |
| macos-15 | **3** |

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

The remaining 17 — Engine, Agents, Sync scheduler, Rate limiter, People,
Embedding, Workflow, Watcher, Config, TUI, DB layer, Deployment, Health,
Metrics, Preflight, MCP, LAN — load no file that branches on platform.

**This is static evidence, not empirical** — and the plan review proved that
caveat was not decorative. The sweep above originally matched only
`process.platform` and `os.platform()`, missing
`import { platform } from "node:os"`, which is the **dominant idiom in this
codebase** (6 files). That omission left `doctor-core.ts` undetected and
classified `Doctor` as Linux-only despite it branching on platform — the exact
signal loss this design exists to avoid, inside the classification the design
was built from.

`Doctor` is corrected to a PAL gate above, and the detection in Change C covers
destructured `node:os` imports and `os.type()`. A stronger check still would
compare measured per-OS coverage from real lcov artifacts; static remains the
judgement of record, now with a demonstrated failure to justify the scepticism.

### Mechanism

Give **every** matrix entry an explicit `pal` field — `true` for the seven
above, `false` for the other seventeen — and gate the job:

```yaml
if: inputs.runner == 'ubuntu-24.04' || matrix.gate.pal
```

The field is explicit rather than defaulted so that a newly added gate cannot
inherit Linux-only treatment silently; Change C enforces that.

Coverage gates go **72 → 38**; a push run goes **105 → 71**.

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

## Change C — stop the PAL classification rotting silently

Changes A and B are point-in-time judgements about which code branches on
platform. Without a guard, the day someone adds `process.platform` to a
Linux-only gate's code, coverage on Windows and macOS quietly stops watching it
and **nothing fails**. That is the same silent-decay failure mode the
measurement slice had to guard for the `created_at` assumption.

A directory scan over the 18 Linux-only gates cannot do this job: the coverage
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

**Expected effect.** DAG wait 33.4 → ~3 min. Jobs-per-run 105 → 71. Peak
created-but-waiting materially reduced. If the measured result contradicts these
numbers, the recorded outcome is the measurement — not the prediction.

**Baseline note — and when to regenerate.**
`docs/structure-audit/ci-latency-baseline.json` holds entries for the 36
coverage keys that stop being produced on macOS and Windows. `evaluate` reports
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
| Losing per-OS coverage signal on 18 gates | Bounded by the static sweep above. Recorded as a judgement, not a proof. |
| Non-Negotiable #5, platform equality | Every test still executes on all 3 OSes via `static`, `unit`, `integration`, `e2e-gateway`, `e2e-cli`. Only *threshold enforcement* narrows. Read as compatible; flagged for the owner's ruling. |
| A TS-failing, Rust-passing `main` commit burns E2E runners | **Deferred, on measured data.** 2 of the last 40 `main` commits arrived without a PR (`a91d73ec`, `7176dd49`) — both `ci(cla)` workflow commits, neither touching TypeScript. The residual case is two green PRs merging into a semantic conflict. Guarding it has real cost: no standalone fast typecheck exists (`Static`, 4.57 min, is inside `_test-suite.yml` and unreachable by `needs:`), so it would mean a new job duplicating typecheck on every push plus ~3 min of DAG depth added back. `CI — Structure audit` (0.83 min) was evaluated as a cheap substitute and rejected — it runs `audit:boundaries`/`invariants`/`release-please`, not typecheck. **Trigger to adopt:** a `main` E2E run observed burning on a TS compile failure. |
| Cross-job cancellation as an alternative guard | **Not available.** GitHub Actions cannot cancel a job with no `needs` relationship to the failing one; `fail-fast` operates within a matrix, not across jobs. Removing the edge removes the cancellation relationship by definition. |
| Fewer jobs could mask a future regression in the removed legs | The removed legs are threshold *enforcement*, not test execution. A behavioural break still fails the 3-OS suites. |

## Out of scope

Consolidating the remaining 17 Linux gates into fewer grouped jobs (~71 → ~52).
Deferred deliberately: it makes failure reports coarser and is the least
reversible of the available levers. Revisit only if the measured result of this
slice falls short.
