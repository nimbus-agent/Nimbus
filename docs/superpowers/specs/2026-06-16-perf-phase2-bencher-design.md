# Perf Strategy Phase 2 — Bencher — Design

> **Status:** Draft for review · **Date:** 2026-06-16 · **Author:** brainstormed with Claude
> **Builds on:** [`2026-06-14-hybrid-perf-strategy-design.md`](./2026-06-14-hybrid-perf-strategy-design.md) §5 ("Phase 2 — Bencher") + §8 (retention risk). Phase 1 shipped in PR #642 (`0.8.0`); the sustained-drift detector in PR #659 (`0.10.0`).
> **Scope note:** One of six CI-health workstreams (this = perf strategy). Phase 2 is the planned successor to Phase 1's GH-native backbone; it changes *where trends live*, not *what is gated*.

## 1. Problem

Phase 1 stood up a GH-native perf backbone: an in-code `gateClass` partition (`gate` / `trend` / `reference`) that owns pass/fail deterministically, a `github-action-benchmark` (g-a-b) trend dashboard on the `perf-data` orphan branch, and a daily rolling-median sustained-drift detector. It is live and healthy.

Two limitations remain, both flagged as Phase-2 work in the Phase 1 spec (§4.4 "History retention", §8):

1. **`github-action-benchmark`'s history JSON grows unbounded.** It stores every data point as JSON on the `perf-data` orphan branch in-repo. On a high-velocity repo this grows without natural retention; Phase 1's interim mitigation was `max-items-in-chart: 500` + periodic manual pruning. The principled fix is a backend with **native, off-repo retention**.
2. **g-a-b can only chart one coherent series.** Phase 1 publishes the trend from the **gha-ubuntu push leg only** (single runner) to avoid three OSes interleaving on one chart, and `emit-benchmark-json.ts` emits **only smaller-is-better** metrics (`p95_ms`, `rss_bytes_p95`) — the bigger-is-better throughput surfaces (`S6-*`, `S8` cells, `S9`, `S10`) are explicitly deferred and never charted.

Bencher's data model (Project → Branch → **Testbed** → Benchmark → Measure) solves both: data lives **off-repo** on Bencher Cloud with native retention, and the **Testbed** dimension lets every runner be its own series and every metric kind (incl. throughput) be a first-class **Measure**.

## 2. Goals / Non-goals

**Goals**

- Retire `github-action-benchmark`; trends, statistical context, and the trend dashboard move to **Bencher Cloud**, with native off-repo retention (the `perf-data` branch stops growing).
- **Expand** trend coverage: all runners as distinct series; throughput/tokens surfaces charted for the first time.
- A safe, **validated** cutover — no trend-continuity gap, no silent ingest misconfiguration.
- **Zero change to gating authority.** The in-code `gateClass` comparator stays the sole thing that can fail a PR. Bencher is **advisory only**; a Bencher/SaaS outage can never block a merge.

**Non-goals**

- Not changing *what* the benchmarks measure (surfaces S1–S11 + S8 cells stay as-is), nor the `gateClass` partition, nor the trimmed-pool p95 aggregation.
- Not retiring `drift-check.ts` (the bespoke sustained-drift alerter stays this phase; folding drift into Bencher's statistical thresholds is a possible *future*, gated on Bencher's alerting being proven).
- Not self-hosting a Bencher server (decided: Bencher Cloud — see §3).
- Not blocking on the M1 Air reference runner (decided: Bencher is decoupled from it — see §7).
- Not backfilling g-a-b history into Bencher (old trend stays viewable on the archived `perf-data` branch for forensics).

## 3. Decisions made during brainstorm

| # | Decision | Rationale |
|---|---|---|
| D1 | **Hosting = Bencher Cloud (OSS free tier).** Not self-hosted. | Public OSS projects are free with no artificial limits. Zero ops surface (no server/TLS/DB/backups), and reachability is trivial — both GH-hosted and (future) self-hosted runners just `bencher run --host` over HTTPS. This is *dev infra* (like SonarCloud/Codacy already in this repo's CI), not the product, so it does not touch the local-first Non-Negotiable. Supersedes the Phase-1 sketch's "self-hosted" framing. |
| D2 | **Role = advisory only; replaces g-a-b exactly.** | The `gateClass` comparator stays the sole gate (Phase 1's "gate the deterministic in-code"). Bencher inherits g-a-b's job: dashboards + statistical context + PR trend reporting. No threshold → no alert → no failure, by construction. |
| D3 | **`drift-check.ts` stays untouched.** | Chosen over the "Bencher also owns drift" option. Keeps this phase a clean backend swap; revisit once Bencher's alerting is observed in practice. |
| D4 | **Migration = parallel soak, then retire.** | PR-1 runs Bencher alongside g-a-b for ~2 weeks / ~10 main pushes; PR-2 retires g-a-b only after the Bencher dashboard is verified trustworthy. No trend-continuity gap. |
| D5 | **Feed all matrix legs as separate testbeds** (not ubuntu-only). | Bencher's Testbed dimension handles multi-OS natively, so the Phase-1 single-series constraint is lifted — strictly more coverage at low cost. |

## 4. Architecture & data flow

```text
run-history.jsonl  (HistoryLine v2, one line per run, per runner)
        │
        ▼
toBencherBmf(line)            ← NEW pure fn · packages/gateway/src/perf/bencher-bmf.ts (floor-gated, unit-tested)
        │  emit BMF for every gateClass==="trend" surface carrying a finite metric value (ALL metric kinds)
        ▼
$RUNNER_TEMP/bencher.json    (Bencher Metric Format)
        │
        ▼
bencher run --project nimbus --key $BENCHER_API_KEY --adapter json
            --file bencher.json --branch <ref> --testbed <runner_id>
            --github-actions $GITHUB_TOKEN [--ci-only-thresholds]    ← NEW workflow step (continue-on-error: true)
        │
        ▼
Bencher Cloud (off-repo)  →  per-testbed trend dashboards · statistical context · advisory "Bencher Report" check
```

The bench is **not** re-run under `bencher run`; we reuse the already-produced `run-history.jsonl` artifact and feed Bencher via `--file` + `--adapter json` (Bencher Metric Format). The mapping is a pure function, decoupled from how the bench executed — mirroring the existing `emit-benchmark-json.ts` → `toBenchmarkPoints` pattern.

### 4.1 Bencher object-model mapping

| Bencher concept | Nimbus mapping | Notes |
|---|---|---|
| **Project** | `nimbus` (one public OSS project) | Created once during ops setup (§6). |
| **Branch** | git ref | `main` on push; `$GITHUB_HEAD_REF` with start-point `main` on PRs. |
| **Testbed** | `RunnerKind` | `gha-ubuntu` / `gha-macos` / `gha-windows` / `reference-m1air`. Each leg ingests under its own testbed → no interleaving. |
| **Benchmark** | `surfaceId` | `S1`, `S2-a`, `S8-l500-b32`, … (declared order in `SLO_THRESHOLDS`). |
| **Measure** | metric kind | `latency` (`p95_ms`, ms, ↓) · `memory` (`rss_bytes_p95`, bytes, ↓) · `throughput` (`throughput_per_sec`, items/sec, ↑) · `tokens` (`tokens_per_sec`, tps, ↑) · `first_token` (`first_token_ms`, ms, ↓). |

Each surface carries exactly one metric (per `SLO_THRESHOLDS`), so each Benchmark emits exactly one Measure. The Measure's **direction** (lower-vs-higher-is-better) captures the existing `isFloorMetric` distinction (`throughput_per_sec` / `tokens_per_sec` are higher-is-better; everything else lower-is-better) — set once on the Measure at project-setup time so Bencher's stats interpret regressions correctly.

### 4.2 Bencher Metric Format (BMF)

BMF is nested JSON: top-level keys are Benchmark names, second-level keys are Measure slugs, values carry `value` (required) plus optional `lower_value`/`upper_value` bounds. We emit only `value` (the per-surface aggregate from the trimmed-pool p95 / throughput / RSS computation already done by the bench harness). Example for one runner's line:

```json
{
  "S1":            { "latency":    { "value": 1834.0 } },
  "S11-a":         { "latency":    { "value": 168.5 } },
  "S7-a":          { "memory":     { "value": 146800640 } },
  "S8-l500-b32":   { "throughput": { "value": 512.4 } },
  "S9":            { "tokens":     { "value": 41.2 } }
}
```

(`S9` is `reference`-class, not `trend`; shown only to illustrate the `tokens` measure. The emitter includes a surface **iff** its `gateClass === "trend"` — see §5.1.)

## 5. Components

### 5.1 `packages/gateway/src/perf/bencher-bmf.ts` (NEW, floor-gated)

A pure `toBencherBmf(line: HistoryLine): BmfReport`:

- Iterate `SLO_THRESHOLDS` in declared order (deterministic).
- Include a surface **iff** `gateClass === "trend"`, its `HistoryLineSurface` exists, `samples_count > 0` (not a stub), and the metric value is a finite number.
- Map `metric → measure slug` via a single `MEASURE_BY_METRIC` table (`p95_ms→latency`, `rss_bytes_p95→memory`, `throughput_per_sec→throughput`, `tokens_per_sec→tokens`, `first_token_ms→first_token`, `p50_ms→latency`).
- Emit `{ [surfaceId]: { [measureSlug]: { value } } }`.

Crucially, **unlike `emit-benchmark-json.ts`** (which whitelists only `p95_ms`/`rss_bytes_p95`), this emits **every** metric kind — so the bigger-is-better throughput/tokens trend surfaces are charted for the first time.

Lives in `packages/gateway/src/perf/` (not `scripts/perf/`) so it is under the coverage-floor scan roots and unit-tested to ≥80% line+branch. (Phase 1's `emit-benchmark-json.ts` is in `scripts/perf/` and is *not* floor-gated; this is the better placement.)

### 5.2 `scripts/perf/emit-bencher-bmf.ts` (NEW, thin CLI)

`--in <run-history.jsonl> --out <bencher.json>`. Reads the last line via the shared `scripts/perf/history-jsonl.ts` `parseLastHistoryLine`, calls `toBencherBmf`, writes the BMF JSON. Mirrors `emit-benchmark-json.ts`'s `runEmitBenchmarkJsonMain` structure (same flag parsing, same error handling, returns `0`/`1`/`2`).

### 5.3 `_perf.yml` additions (PR-1, alongside g-a-b)

Two new steps per matrix leg, after the existing "Upload run history artifact" step:

- **Emit Bencher BMF** — `bun scripts/perf/emit-bencher-bmf.ts --in "$RUNNER_TEMP/run-history.jsonl" --out "$RUNNER_TEMP/bencher.json"`. Runs on the same legs that produced an artifact (the existing `ubuntu || not-schedule || sunday` gate).
- **Publish to Bencher** — `bencher run …` (flags per §4 / §5.4). `continue-on-error: true`.

Setup needs a `uses: bencherdev/bencher@<pinned-sha>` install step (SHA-pinned per the repo's Scorecard pin policy, like the g-a-b action). The `BENCHER_API_KEY` secret is exposed only to this perf job.

**Secret-presence guard (review A).** The job copies the secret into a job-level `env: BENCHER_API_KEY: ${{ secrets.BENCHER_API_KEY }}`, and **both** Bencher steps (emit + publish) carry `if: ${{ env.BENCHER_API_KEY != '' }}` in addition to the existing leg gate. When the secret is absent the steps **skip cleanly** rather than fail — this covers (a) the window after PR-1 merges but before the §6 ops setup completes, (b) forks and non-`nimbus-agent/Nimbus` repo copies, and (c) any branch where the secret is unset. It also means PR-1's workflow can land independently of the manual ops steps (§10) without redding the perf job. (This is belt-and-suspenders with `continue-on-error` from §5.6: the guard avoids even a *visible* failed step in the no-secret case; `continue-on-error` covers a *transient* API failure when the secret IS present.)

The existing g-a-b steps (`Emit trend benchmark JSON`, `Publish to github-action-benchmark`) are **left in place** through the soak.

### 5.4 Branch/event behavior

| Event | `--branch` | start-point | `--github-actions` | Comment behavior |
|---|---|---|---|---|
| `push` → main | `main` | — | (omitted) | Feeds the dashboard; no PR. |
| perf-labelled PR (same-repo) | `$GITHUB_HEAD_REF` | `--start-point main --start-point-hash <base.sha> --start-point-clone-thresholds --start-point-reset` | `$GITHUB_TOKEN` | `--ci-only-thresholds`: with no thresholds configured, Bencher posts only the informational **"Bencher Report" check** (no PR comment) — see §5.5. |
| Fork PR | — | — | — | **Skipped** via `if: github.event.pull_request.head.repo.full_name == github.repository` (secrets are unavailable to fork runners). The two-workflow `workflow_run` fork pattern is deferred (§8). |

**Testbed name exactness (review B).** `--testbed` consumes the **existing** `steps.runner-id.outputs.id` from `_perf.yml`'s "Derive runner id" step (lines 137–148) verbatim — `gha-ubuntu` / `gha-macos` / `gha-windows` — the *same* identifier the artifact name (`perf-${id}-${sha}`) and `bench-ci.ts --runner` already consume. No new string is introduced, so the Bencher Testbed dimension can never drift from `RunnerKind`. The `_perf-reference.yml` ingest (§7) passes the literal `reference-m1air`. Bencher auto-creates a Testbed on first ingest, so these become the canonical testbed slugs.

### 5.5 Advisory mode & PR-comment coexistence

We configure **no Bencher thresholds** → no alerts → `bencher run` never fails on the data (advisory by construction; the `gateClass` comparator stays the only thing that can red a PR). On PRs, `--github-actions $GITHUB_TOKEN --ci-only-thresholds` makes Bencher post only its informational "Bencher Report" check (a link to the run), **not** a PR comment — so it never double-comments alongside `bench-ci.ts`'s authoritative gate-class comment. `bench-ci.ts` remains the single PR comment; in PR-2 its dashboard link flips from `/dev/bench` to the Bencher project URL.

### 5.6 Error handling

Bencher ingest is advisory, so a transient Bencher API / network failure must **not** red the perf job. We use GitHub-native **`continue-on-error: true`** on the Bencher steps: a failure is *visible* (the step is marked failed) but non-blocking. This is deliberately **not** `|| true`, which would swallow the signal entirely (an anti-pattern that previously bit this repo's perf gating).

**Empty / partial BMF (review C).** `toBencherBmf` skips stub surfaces (`samples_count===0`) and non-finite values, so a degraded run can yield a BMF with a subset of surfaces — or, in the (rare) all-stub case, an empty `{}`. Two safeguards: (1) the emit step prints the surface count (mirroring `emit-benchmark-json.ts`'s "wrote N point(s)"), and the **publish step is guarded to skip an empty BMF** (no surfaces → nothing to ingest); (2) a *partial* BMF is safe to send — **verified:** Bencher treats each report as additive, so submitting a subset of benchmarks never erases or fails the historical data for the omitted ones. The advisory ingest is therefore resilient to per-surface flakiness.

## 6. Ops prerequisites (manual — operator, not automatable in-repo)

These mirror the installer program's infra-provisioning steps; they cannot be done by a code PR:

1. Create the public Bencher Cloud project **`nimbus`**.
2. Pre-create the 5 **Measures** with correct units + direction (`latency`/`memory`/`first_token` = lower-is-better; `throughput`/`tokens` = higher-is-better) — so on-the-fly-created measures don't default to the wrong direction.
3. Generate a **project-scoped** API key (`bencher_run_*`, *not* a user key — least privilege) → store as the `BENCHER_API_KEY` GitHub Actions secret.
4. (PR-2) Archive the `perf-data` orphan branch (§7).

## 7. Reference runner & retirement

**Reference runner (not a blocker).** Phase 2 is decoupled from the still-unprovisioned M1 Air. The `reference-m1air` testbed simply has no data until the runner exists; Bencher handles sparse testbeds fine and gha-ubuntu data flows immediately. PR-1 adds a **dormant** `bencher run --branch main --testbed reference-m1air …` step to `_perf-reference.yml` (after its bench), which only executes when that workflow runs — i.e. once the runner is online — so it is zero-risk to land now.

**Retirement (PR-2, after the soak).**

1. Remove `Emit trend benchmark JSON` + `Publish to github-action-benchmark` steps from `_perf.yml`.
2. Delete `scripts/perf/emit-benchmark-json.ts` + its tests.
3. Flip dashboard links to the Bencher project URL in `docs/perf/slo.md` and `pr-comment-formatter.ts` (`DEV_BENCH_DASHBOARD_PATH`).
4. **Archive** the `perf-data` branch (rename → `perf-data-archive`, kept read-only for forensics) rather than hard-delete — the unbounded-growth branch stops being written to, which is the retention win.

`drift-check.ts` still reads the per-run gha-ubuntu **artifacts** (90-day retention), not the `perf-data` branch, so archiving the branch does not affect it.

## 8. Risks & mitigations

- *Bencher Cloud free-tier metric cap* → search indicates public OSS projects are free with no artificial limits; **verify during setup (§6)** before relying on retention. Low severity (the gate is in-code regardless).
- *Fork PRs can't see secrets* → mitigated by the same-repo `if` guard (skip Bencher on forks). The two-workflow `pull_request` + `workflow_run` fork pattern is **deferred** — Nimbus perf PRs are label-gated and typically internal; fork perf PRs are rare.
- *SaaS dependency for the dashboard* → accepted per D1. It is **dashboard-only**: the gate is in-code, so a Bencher outage degrades gracefully (no dashboard, but CI still gates). `continue-on-error` keeps ingest failures non-blocking.
- *`BENCHER_API_KEY` is a write-scoped secret in CI* → use a project-scoped `bencher_run_*` key (least privilege), exposed only to the perf job.
- *Silent ingest misconfiguration loses trend continuity* → the parallel soak (D4) is the mitigation: g-a-b keeps charting until Bencher is verified.
- *No backfill of g-a-b history* → accepted; the archived `perf-data` branch retains the old trend for forensics.

## 9. Testing

- **`bencher-bmf.ts` (unit, floor-gated):** maps a representative `HistoryLine` → BMF; asserts (a) only `trend`-class surfaces appear, (b) correct measure slug per metric, (c) **throughput/tokens surfaces included** (the gap vs `emit-benchmark-json.ts`), (d) stubs (`samples_count===0`) excluded, (e) non-finite values excluded, (f) declared-order determinism.
- **`emit-bencher-bmf.ts` (CLI):** injected in/out paths → writes expected BMF; missing-flag → exit 2; unreadable input → exit 1 (mirror `emit-benchmark-json.ts` tests).
- **Workflow:** YAML can't be unit-tested; validated by (a) a `bencher run` against a throwaway scratch project during PR-1 review, and (b) the soak window confirming the dashboard matches the perf-data trend.
- Existing `regen-slo.ts --check` stays green (no `SloThreshold` field changes).

## 10. Rollout

1. **PR-1** — `bencher-bmf.ts` + `emit-bencher-bmf.ts` + tests; `_perf.yml` Bencher steps (push + same-repo PR, all legs, `continue-on-error` + secret-presence guard); dormant `_perf-reference.yml` step. g-a-b untouched. Labelled `perf` so the bench validates on-PR. **Ordering is relaxed by the secret guard (§5.3):** the code/workflow PR and the manual ops setup (§6: project, measures, `BENCHER_API_KEY` secret) can land in either order — until the secret exists the Bencher steps skip cleanly; ingest begins the first run after the secret is set. Recommended: do §6 just before or right after merging PR-1 so the soak clock starts.
2. **Soak** — ~2 weeks / ~10 main pushes; verify Bencher dashboard ≈ perf-data trend across testbeds.
3. **PR-2** — retire g-a-b steps + emitter + tests; flip dashboard links; archive `perf-data` branch.

- **No security-invariant impact** (perf is not an invariant surface). No DB migration. No `SloThreshold` schema change.

## 11. Resolved review points

- **PR comments — DECIDED: check-only** (`--ci-only-thresholds`). Reviewer (Antigravity) concurred: a single authoritative `bench-ci.ts` comment avoids PR-timeline pollution; Bencher's "Bencher Report" check already links to the run dashboard for anyone wanting trend detail. No second PR comment.
- **Fork double-guard + no-secret resilience (review A)** — addressed by the secret-presence step guard (§5.3) plus the same-repo `if` (§5.4) and `continue-on-error` (§5.6).
- **Testbed name exactness (review B)** — addressed: `--testbed` reuses the existing `steps.runner-id.outputs.id` (§5.4).
- **Empty / partial BMF resilience (review C)** — addressed: skip-on-empty publish + reviewer-verified additive-report semantics (§5.6).
