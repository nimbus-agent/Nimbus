# Nimbus SLO Sheet

> **Status:** PR-C-1 — UX surfaces published with concrete thresholds; workload surfaces (S6, S7, S8 cells, S9, S10) are flagged `TBD (Phase 5)` and will be filled in once PR-C-2's M1 Air reference run lands.
>
> **Source spec:** Phase 4 perf audit design (B2), §3.

## Reference hardware caveat

These figures are measured on a **2020 M1 MacBook Air, 8 GB / 256 GB**. Performance on x64 / older hardware is measured but **not threshold-gated** for `v0.1.0`; see GHA matrix results in the [Performance Benchmarks workflow](https://github.com/asafgolombek/Nimbus/actions/workflows/_perf.yml) artifacts (90-day retention) for that baseline. The reference machine anchors the published SLO to a real-world worst-case "Nimbus runs on your existing laptop" profile; runs on equal-or-better hardware should meet or beat these targets.

## Threshold semantics

For every measurement entry, `threshold` is the maximum allowed value for the **specified percentile of a multi-run aggregate** (median-of-medians across 5 runs — see spec §4.5). Almost all UX rows use **p95**; workload rows use the natural metric for their surface (items/sec for throughput, p95 RSS for memory, etc.).

A bench fails when either:
- the measured aggregate exceeds the absolute reference or GHA threshold, **or**
- the run delta vs the most recent `main` history entry for the same `runner` exceeds the per-surface noise floor (`max(noise_floor_pct, absolute_noise_floor / previous × 100)`).

**Sustained-drift detection uses the same per-surface floor.** `scripts/perf/drift-check.ts` walks a rolling median of the last 7 `main` samples and files an issue only when 3 consecutive samples each exceed that surface's own floor. It applied a hardcoded **10 %** until 2026-08-29, which is what filed the false #1308 / #1309 alarms against `S11-a` / `S11-b` — surfaces whose declared floor is 40 % precisely because their spawn-dominated latency is a runner property, not a code signal.

The failure mode is worth knowing before widening a floor again: a rolling median MOVES WITH THE DATA, so a cluster of unusually **fast** runs drags it down, and the next ordinary samples then read as a regression against a depressed baseline. The window that fired both issues was `224, 249, 261, 253, 247, 333, 306` (median 253) against a series median of 311 — the "regression" was the runner returning to normal.

## UX surfaces

| Surface | Metric | Reference threshold | GHA threshold | Noise floor (rel %, abs) |
|---|---|---|---|---|
| S1 | p95_ms | **≤2 000 ms** | ≤10 000 ms | 25 %, 300 ms |
| S2-a | p95_ms | **≤30 ms** | ≤200 ms | 25 %, 5 ms |
| S2-b | p95_ms | **≤80 ms** | ≤500 ms | 25 %, 10 ms |
| S2-c | p95_ms | **≤300 ms** | n/a (reference only) | 25 %, 25 ms |
| S3 | p95_ms | **≤1 500 ms** | ≤7 500 ms | 25 %, 100 ms |
| S4 | p95_ms | **≤500 ms** | ≤2 500 ms | 25 %, 50 ms |
| S5 | p95_ms | **≤200 ms** | ≤1 000 ms | 25 %, 25 ms |
| S11-a | p95_ms | **≤300 ms** | ≤1 500 ms | 40 %, 50 ms |
| S11-b | p95_ms | **≤50 ms** | ≤900 ms | 40 %, 10 ms |

## Workload surfaces

| Surface | Metric | Reference threshold | GHA threshold | Noise floor (rel %, abs) |
|---|---|---|---|---|
| S6-drive | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S6-gmail | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S6-github | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S7-a | rss_bytes_p95 | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 20 %, 20 MB |
| S7-b | rss_bytes_p95 | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 20 %, 50 MB |
| S7-c | rss_bytes_p95 | n/a (reference only) | n/a (reference only) | 20 %, 50 MB |
| S9 | tokens_per_sec | n/a (reference only) | n/a (reference only) | 30 %, 2 tps |
| S10 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 100 items/sec |
| S8 (12 cells, see § Workload › S8 cells below) | throughput_per_sec | TBD | TBD — Phase 5 reference run (PR-C-2) | 25 %, 5 items/sec |

### S8 cells

12-cell cross-product of `(length × batch)`. Each cell is its own surface ID with its own threshold (set by PR-C-2).

Cell IDs encode the parameters: `S8-l<chars>-b<batch>` where `l` = approximate text length in characters (50, 500, 5000) and `b` = batch size passed to `embedder.embed()` (1, 8, 32, 64). E.g., `S8-l500-b32` measures embedding throughput on 500-char texts in batches of 32.

| Cell | Metric | Reference threshold | GHA threshold | Noise floor (rel %, abs) |
|---|---|---|---|---|
| S8-l50-b1 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l50-b8 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l50-b32 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l50-b64 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l500-b1 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l500-b8 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l500-b32 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l500-b64 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l5000-b1 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l5000-b8 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l5000-b32 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |
| S8-l5000-b64 | throughput_per_sec | n/a (reference only) | TBD — Phase 2 reference run (PR-C-2) | 25 %, 5 items/sec |

## What this sheet is not

- **Not a regression-tracking document.** This sheet pins the absolute SLO *thresholds*. Trend-over-time tracking lives in the **[/dev/bench dashboard](https://github.com/nimbus-agent/Nimbus/tree/perf-data/dev/bench)** — the github-action-benchmark chart published from `main` on every push (data in the `perf-data` branch under `dev/bench/`). The reference machine's per-run aggregates are recorded in `docs/perf/history.jsonl`.

---

*This file is generated from `packages/gateway/src/perf/slo-thresholds.ts`. Run `bun scripts/regen-slo.ts` after changing thresholds. CI runs `bun scripts/regen-slo.ts --check` to fail the build on drift.*
