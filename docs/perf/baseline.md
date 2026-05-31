# Nimbus performance baseline

> **Migration note (PR-C-1, 2026-04-29):** Benchmark history before this commit lives at the [`gh-pages` branch](https://github.com/asafgolombek/Nimbus/tree/gh-pages) (chart powered by `benchmark-action/github-action-benchmark`, retired in this PR). Subsequent history is split:
>
> - **Reference-machine runs** (M1 Air) → committed to [`docs/perf/history.jsonl`](./history.jsonl).
> - **GHA runs** (Ubuntu / macOS / Windows) → workflow artifacts on the [Performance Benchmarks workflow](https://github.com/asafgolombek/Nimbus/actions/workflows/_perf.yml) (90-day retention).
>
> Source spec: Phase 4 perf audit design (B2), §4.7.

## Reference baseline (M1 Air)

_TBD — populated by PR-C-2 reference run. Each row sourced from a `history.jsonl` line, not retyped (provenance per spec §4.4)._

| Surface | Metric | p50 | p95 | p99 | max | run_id |
|---|---|---|---|---|---|---|
| S1 | cold-start ms | TBD | TBD | TBD | TBD | TBD |
| S2-a | query p95 ms | TBD | TBD | TBD | TBD | TBD |
| S2-b | query p95 ms | TBD | TBD | TBD | TBD | TBD |
| S2-c | query p95 ms | TBD | TBD | TBD | TBD | TBD |
| S3 | dashboard first-paint ms | TBD | TBD | TBD | TBD | TBD |
| S4 | TUI first-paint ms | TBD | TBD | TBD | TBD | TBD |
| S5 | HITL popup ms | TBD | TBD | TBD | TBD | TBD |
| S6 | sync items/sec | TBD | TBD | TBD | TBD | TBD |
| S7-a | RSS idle bytes | TBD | TBD | TBD | TBD | TBD |
| S7-b | RSS heavy-sync bytes | TBD | TBD | TBD | TBD | TBD |
| S7-c | RSS multi-agent bytes | TBD | TBD | TBD | TBD | TBD |
| S8 | embedding items/sec (12 cells) | TBD | TBD | TBD | TBD | TBD |
| S9 | LLM tokens/sec | TBD | TBD | TBD | TBD | TBD |
| S10 | SQLite writes/sec | TBD | TBD | TBD | TBD | TBD |
| S11-a | CLI cold ms | TBD | TBD | TBD | TBD | TBD |
| S11-b | CLI warm ms | TBD | TBD | TBD | TBD | TBD |

## What lands in PR-C-2

- The TBD cells above, sourced from a single `nimbus bench --all --reference` run.
