# Hybrid Perf Strategy — Design

> **Status:** Draft for review · **Date:** 2026-06-14 · **Author:** brainstormed with Claude
> **Supersedes operationally:** the per-surface `linuxOnlyGate` stop-gaps (#623 S1/S11-b, #628 S11-a)
> **Scope note:** This is one of six CI-health workstreams (reliability, **perf strategy** ← this, speed/cost, gating-config, local-DX, tech-swaps). It covers perf only.

## 1. Problem

The `Performance Benchmarks` workflow is the single biggest source of red `main`: **~37 % of recent runs failed** (11 of 30), and **100 % of those gating failures were latency-surface `delta-fail`s caused by shared-runner jitter, not code** — e.g. S1 `+38.1 %` on windows-2025 (run 27498114264) and S11-a `+57.7 %` on macos-15 on a *no-code-change release-version-bump commit* (#622, run 27501081344).

Two root causes:

1. **Shared GitHub-hosted runners cannot reliably gate end-to-end latency.** Cold-start + process-spawn + neighbour-contention produce a large run-to-run jitter envelope (S1 ~±36 %; S11-a observed +57.7 %) with no code change. An absolute noise floor cannot absorb this: the floor-as-percentage shrinks as the baseline grows, and the Windows baseline is ~2× macOS, so the same fixed floor is far weaker there.
2. **Push-to-main gates a main-vs-main comparison with no code delta to attribute.** A non-zero exit on a push-to-main bench has no actionable owner and no PR to annotate — it is pure red noise.

The stop-gaps (`linuxOnlyGate` on S1/S11-a/S11-b/S7) proved the diagnosis but are **whack-a-mole**: each noisy surface is excluded one at a time (S11-a was missed in the first pass and immediately flapped). The principled fix is a **declared partition** between surfaces we *can* gate and surfaces we can only *trend*.

## 2. Goals / Non-goals

**Goals**
- A green perf check **always means a real regression** (no false-fails from runner jitter).
- Real latency regressions are still **caught** — pre-merge where cheap, and on consistent hardware otherwise.
- Perf trends are **visible over time** with an alert on *sustained* drift (not single-run noise).
- The partition is **declared and tested**, not inferred from a tangle of flags.

**Non-goals**
- Not adopting an external SaaS in Phase 1 (Bencher is Phase 2, sketched only).
- Not changing *what* the benchmarks measure (surfaces S1–S11 stay as-is).
- Not solving the broader merge-queue / cross-platform-flake problems (separate workstreams).

## 3. Philosophy: gate the deterministic, trend the noisy

Every surface is classified by where its measurement is trustworthy:

| Class | Gated where? | Surfaces | Rationale |
|---|---|---|---|
| **`gate`** | Every runner (PRs + reference) | `S2-a`, `S2-b`; `S8` cells once calibrated | In-process, ms-scale, no process spawn → deterministic, low-noise. A red check is real. |
| **`trend`** | **Reference (M1 Air) only**; GHA shared runners record-only | `S1`, `S4`, `S6-*`, `S7-*`, `S10`, `S11-a`, `S11-b` | Spawn/IO-dominated → irreducible jitter on shared runners. Gated only on consistent hardware. |
| **`reference`** | Reference (M1 Air) only, via `refMax` | `S2-c`, `S7-c`, `S9` | Already reference-only today. |

**Stubs:** `S3`, `S4`, `S5` are currently un-implemented (`samples_count = 0` → `skipped(stub)`), so they gate nothing today. They get a `gateClass` when implemented: `S4` → `trend` (it spawns the gateway, per the `_perf.yml` driver note), `S3`/`S5` → classify by whether the implemented driver spawns a process. The partition is exhaustive over all 29 surfaces (9 non-S8 listed above + S3/S4/S5 stubs + 12 S8 cells in `gate`).

This **supersedes `linuxOnlyGate`**: today S1/S11 still gate on `gha-ubuntu` (also a shared runner with jitter). Under this model, spawn/latency surfaces stop gating on *all* GHA runners (ubuntu included) and are gated only on the M1 Air reference run — which is consistent hardware and therefore trustworthy. GHA still *measures and charts* them; it just never blocks on them.

> **Decided (review Q1):** **drop** `gha-ubuntu` gating of spawn-latency surfaces (S1/S11) — ubuntu is also a shared VM (CPU-scaling / neighbour noise / IO throttling), so gating there produces false alerts. The safety net is the nightly reference run (§4.5); GHA runs are trend-only for these surfaces.

## 4. Phase 1 — GH-native (build now, no external service)

### 4.1 Declared partition (`gateClass`)
Add to `SloThreshold` (`packages/gateway/src/perf/slo-thresholds.ts`):

```ts
gateClass: "gate" | "trend" | "reference";
```

Populate per the table in §3 and **remove `linuxOnlyGate`** (its three current users — S1/S11-a/S11-b — become `trend`; S7 becomes `trend`). `threshold-comparator.ts` `classifySkip`/`compareOne` consult `gateClass` + the runner:
- `reference` runner → gate any surface that has a `refMax` (gate + trend + reference classes all evaluated).
- GHA runner → only `gate`-class surfaces can fail; `trend`/`reference` resolve to `skipped` (still measured + reported).

`gateClass` also **subsumes the existing `gated: boolean`** on `SloThreshold` (`gate` ⇒ gated everywhere; `trend`/`reference` ⇒ not GHA-gated). Remove `gated` and derive its call-sites from `gateClass`, so there is one source of truth, not two overlapping flags. (Name: keeping `gateClass` for concision; reviewer-suggested `gatingStrategy` / `evalMode` are equivalent — final name is the maintainer's call, §10.)

### 4.2 Stats fix — single p95 across flattened samples
`bench-harness.ts buildLatencyResult` currently reports the **median of per-run p95 values** (p95-of-5 ≈ the 2nd-largest of 5 → max-like, volatile). Change it to a **trimmed-pool p95**: discard the single worst run (highest per-run p95) — so one catastrophically-contended run (disk thrash / network hang spiking *all* its samples) can't skew the result — then flatten the remaining runs' `rawSamples` into one pool and compute a single p95. With the default 5 runs this pools ~4 runs; for `runs < 3` skip the trim and pool all (too few to trim). *Verified feasible:* `buildLatencyResult` already receives `perRunSamples: number[][]`, so the trim + pooled p95 are a local change (and align latency with the existing RSS surface, which already pools). Keeps the `p95_ms` metric (no change of meaning), is far more stable than median-of-per-run-p95, and is the adversarially-verified-sound option (p50 was rejected — it discards tail-latency signal). Bump `schema_version` 1 → 2; reset the trend history (old aggregates are not comparable).

### 4.3 Event-aware gating
`bench-ci.ts decideExit`:
- Consider **only `gate`-class surfaces**.
- Exit non-zero only on `pull_request` events (absolute + delta). On `push` to `main`, **always return 0** — its job is to publish the baseline + feed the trend. (This is the *correct* form of the rejected `|| true`, which would have neutered PR gating too.)

### 4.4 Trend pipeline (`benchmark-action/github-action-benchmark`)
On every main run, emit a `customSmallerIsBetter` / `customBiggerIsBetter` JSON view of **`trend`-class** surfaces (per runner) and feed it to `github-action-benchmark`:
- Stores results on an orphan **`perf-data`** branch, renders charts at `/dev/bench` (GitHub Pages).
- `fail-on-alert: false`, `comment-on-alert: true` → advisory only, never blocks.

Because that action only compares against the *previous* point (noisy), add a small **sustained-drift detector** (`scripts/perf/drift-check.ts`): rolling median of the last **K = 7** main runs per `(surface, runner)`; if the latest is worse than that median by **> the surface's own noise floor** for **N = 3 consecutive** runs, open/update **one** GitHub issue (de-duplicated by surface). This catches genuine drift while ignoring single-run spikes.

**Noise-floor source (review B):** the drift threshold is *not* new config — it reuses each surface's existing `noiseFloorPct` / `noiseFloorAbs` on `SloThreshold`, i.e. the same `max(noiseFloorPct, noiseFloorAbs / median × 100)` effective floor that `threshold-comparator.ts` already computes for gating. Gate and trend share one noise definition.

**In-PR comment (review Q3):** keep a condensed PR comment — a small table of the **`gate`-class** surfaces' pass/fail plus a link to the `/dev/bench` dashboard for the full `trend`-class detail. (Devs rarely click through to a dashboard without an at-a-glance summary in the PR.)

**History retention (review C):** `github-action-benchmark`'s history JSON grows unbounded on a high-velocity repo. Interim mitigation: cap rendered points (`max-items-in-chart`) and periodically prune/down-sample the `perf-data` JSON — the orphan branch is checked out rarely, so growth is low-severity. Native retention/down-sampling is a **Phase-2 (Bencher)** capability; tracked as a known limitation (§8).

### 4.5 Promote the M1 Air reference run to gate authority
`.github/workflows/_perf-reference.yml` is currently `workflow_dispatch`-only. Add a **nightly `schedule` cron** (keep manual dispatch). On consistent hardware it gates the **full** surface set via `refMax` — the trustworthy regression catch, off the PR critical path. Security: scheduled/dispatch only, never fork-PR-triggered (self-hosted runner).

## 5. Phase 2 — Bencher (sketch, separate spec later)
Stand up a **self-hosted Bencher** instance (open-source, AGPL/local-first-aligned, no SaaS dependency). A thin adapter maps `docs/perf/history.jsonl` → Bencher's JSON; Bencher then owns trend dashboards, statistical threshold models, and PR comments, and `github-action-benchmark` retires. Bencher's "same bare metal locally and in CI" model pairs with the M1 Air runner. De-risked because Phase 1 already produces clean per-surface JSON. Full spec when Phase 1 lands.

## 6. Testing
- **Partition:** table test asserting each surface's `gateClass`; `gate`-class on every runner fails on breach; `trend`/`reference` on a GHA runner resolve to `skipped`.
- **Stats fix:** `buildLatencyResult` flattens samples and the resulting p95 matches a hand-computed p95 over the pooled samples; stability test (a single outlier run moves the aggregate less than the old median-of-p95 did).
- **Event-aware exit:** `bench-ci.ts` returns 0 on a `push` event even with a `gate`-class delta-fail; returns non-zero on a `pull_request` `gate`-class fail; `trend` fails never affect exit.
- **Drift detector:** unit tests for the rolling-median + N-consecutive logic (no alert on a single spike; alert on sustained drift; issue de-dup).
- Existing `regen-slo.ts --check` stays green (regenerate `docs/perf/slo.md` if the field surfaces there).

## 7. Rollout / migration
1. Land `gateClass` + comparator change + stats fix + event-aware exit (one PR) with `schema_version` 2 + a documented baseline/history reset.
2. Land the trend pipeline (`github-action-benchmark` workflow step + `perf-data` branch + drift-check script) in a second PR.
3. Add the reference-run nightly cron (third PR).
4. Update `docs/perf/slo.md` (its "not a regression-tracking document" note now points at the `/dev/bench` dashboard).
- **No security-invariant impact** (perf is not an invariant surface). No DB migration.

## 8. Risks & mitigations
- *Dropping GHA gating of spawn-latency could miss a regression* → mitigated by the nightly reference run (§4.5) which gates the full set on consistent hardware, plus the sustained-drift alert.
- *`github-action-benchmark` single-point alerts are noisy* → we set `fail-on-alert: false` and layer our own rolling-median sustained-drift rule for the actionable issue alert.
- *`perf-data` branch churn* → orphan branch, charts only; never merged to main.
- *Stats-fix baseline reset loses history continuity* → one-time, documented; the 90-day artifacts remain for forensics.
- *`perf-data` history JSON grows unbounded* → interim `max-items-in-chart` cap + periodic prune of the orphan branch (rarely checked out → low severity); fully solved by Phase-2 Bencher's native retention (review C).
- *A single catastrophically-contended run skews the pooled p95* → the run-level outlier trim in §4.2 (drop the worst run) absorbs it (review A).

## 9. Decisions already made (during brainstorm)
- Philosophy = **hybrid** (gate stable, trend noisy).
- Approach = **Phase 1 GH-native backbone now, Phase 2 Bencher later** (phased; CodeSpeed de-prioritized on Bun-fit risk).
- Stats fix = **flatten→single p95** (not p50).
- Trend tooling = **`github-action-benchmark`** (not hand-rolled charts).
- Drift defaults: **K=7, N=3, threshold = per-surface noise floor** (tunable).
- Review Q1–Q3 resolved: **drop ubuntu gating** (Q1); **`perf-data` orphan branch** for the dashboard (Q2); **keep a condensed gate-class PR comment** + dashboard link (Q3).
- `gateClass` **subsumes** the existing `gated: boolean` — remove the redundant flag (surfaced by review Q4).
- Stats fix adds a **run-level outlier trim** before the pooled p95 (review A).
- Drift threshold **reuses the existing per-surface `noiseFloorPct` / `noiseFloorAbs`** — no new field (review B).

## 10. Open questions for reviewer
Q1–Q3 resolved via the review (see §9 + §3). **One residual — maintainer preference only, no functional impact:** the field **name** — `gateClass` (kept) vs the reviewer-suggested `gatingStrategy` / `evalMode`. Will use `gateClass` unless you say otherwise.
