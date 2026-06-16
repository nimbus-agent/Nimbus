# Perf Drift-Check Wiring — Design

**Status:** approved (2026-06-16) · **Author:** Asaf Golombek
**Predecessor:** [`2026-06-14-hybrid-perf-strategy-design.md`](./2026-06-14-hybrid-perf-strategy-design.md) (Phase 1, shipped #642)

## 1. Problem

The hybrid perf strategy (Phase 1, PR #642) shipped a complete sustained-drift
detector — `scripts/perf/drift-check.ts` with a fully unit-tested pure
`detectDrift(history, noiseFloorPct, k=7, n=3)` core plus an I/O wrapper
`runDriftCheckMain` that reads recent `main` perf history and upserts one GitHub
issue per drifting `trend`-class surface. **But nothing invokes it** — no
workflow calls `drift-check.ts`, so the alerting is dormant. `_perf.yml` only
wires `emit-benchmark-json.ts` (the dashboard publish).

Two consequences:

1. A sustained regression on a `trend`-class surface (the spawn/IO-noisy
   latency/RSS surfaces that intentionally stopped hard-gating on shared GHA
   runners) is charted on the `/dev/bench` dashboard but raises no alert — a
   human has to notice the chart.
2. The `runDriftCheckMain` I/O wrapper is **untested** (the #642 review deferred
   the refactors that would make it testable: its `gh` calls go through a local
   `ghSpawn` pass-through, not the injectable `GhCli`). Wiring an unattended,
   issue-filing path into CI before it is tested risks issue spam from a logic
   bug.

## 2. Goals / non-goals

**Goals:**

- Activate drift alerting via a daily scheduled workflow that runs
  `drift-check.ts` over recent `main` history and files/updates issues.
- Clear the four #642-deferred refactors so the issue-filing path is tested
  before it goes live:
  1. `ghSpawn` → injectable `GhCli` issue methods.
  2. local `rollingMedian` → existing `medianOf` (`baseline-median.ts`).
  3. duplicated last-JSONL-line parse → one shared helper.
  4. add a `runDriftCheckMain` wrapper test.

**Non-goals (explicitly out of scope):**

- The M1 Air `reference-m1air` self-hosted runner (separate ops task).
- Phase 2 (Bencher).
- Any change to detection thresholds — `k=7`, `n=3`, `DRIFT_NOISE_FLOOR_PCT=20`,
  `DRIFT_RUN_COUNT=14` stay exactly as shipped.
- Per-OS drift (drift-check reads one runner's history; this phase uses
  `gha-ubuntu`, the trend-baseline runner that runs daily Mon–Sat).

## 3. Architecture

Four units, each independently testable:

### 3.1 `.github/workflows/_perf-drift.yml` (new)

- **Triggers:** `schedule` daily at `0 6 * * *` (06:00 UTC, ~2h after the
  `_perf.yml` 04:00 bench crons so the latest `gha-ubuntu` `run-history`
  artifact exists) + `workflow_dispatch` (manual, no inputs).
- **Workflow-level `permissions: {}`** (Scorecard default-deny). The single job
  grants exactly: `contents: read` (checkout), `actions: read` (`gh run list` +
  `gh run download` of perf artifacts), `issues: write` (upsert drift issues).
- **`concurrency`** group `perf-drift` with `cancel-in-progress: false` (a
  queued run waits rather than racing on issue upserts).
- **Job (ubuntu-24.04):** `step-security/harden-runner` (egress audit, mirroring
  the other perf workflows) → `actions/checkout` → setup Bun + install →
  `bun scripts/perf/drift-check.ts`, with `NIMBUS_PERF_RUNNER: gha-ubuntu` in
  the env. All action refs SHA-pinned to match repo convention.
- `schedule` fires only on the default branch of this repo — never on forks/fork
  PRs — so the `issues: write` grant is non-fork-triggered by construction.

### 3.2 `GhCli` issue methods (`packages/gateway/src/perf/bench-ci-gh.ts`)

Add three methods mirroring the existing body-file-based, retry-wrapped
`prComment*` methods (so issue ops inherit the `#run` retry/backoff and the
`spawn` injection seam):

- `issueList({ label }): Promise<{ number: number; title: string }[]>` —
  `gh issue list --state open --label <label> --json number,title`, parsed via
  the existing tolerant JSON-array reader (degrades to `[]` on non-JSON/notice
  output, matching `prCommentList`).
- `issueCreate({ title, label, bodyFile }): Promise<void>` —
  `gh issue create --title <title> --label <label> --body-file <bodyFile>`.
- `issueComment({ number, bodyFile }): Promise<void>` —
  `gh issue comment <number> --body-file <bodyFile>`.

Body-file (not `--body`) keeps multi-line bodies out of argv and matches the
`prComment*` precedent. These methods are exercised by new unit tests (required —
`bench-ci-gh.ts` is coverage-floor-gated at ≥80% line+branch).

### 3.3 `scripts/perf/drift-check.ts` refactor

- Delete the local `ghSpawn` pass-through; route `issueList/create/comment`
  through the injected `deps.gh: GhCli`. `upsertDriftIssue` writes its computed
  body to a temp file (`mkdtempSync` + `join`, cross-platform) and passes it via
  `bodyFile`. Net: the wrapper now depends only on `GhCli`, which is injectable.
- Replace local `rollingMedian` with `medianOf` from `baseline-median.ts`,
  guarding the empty case (`window.length === 0 ? 0 : medianOf(window)`) to
  preserve `detectDrift`'s exact contract. `medianOf` is byte-for-byte the same
  median algorithm, so the existing `detectDrift` unit tests stay green. (The
  `detectDrift` loop only ever passes a fixed-size `k`-element window, so the
  guard is defensive, not load-bearing.)
- Use the shared last-line parser (§3.4) in `downloadRecentMainLines` instead of
  its inline `split("\n").filter(...).at(-1)`.

### 3.4 Shared JSONL parser (`scripts/perf/history-jsonl.ts`, new)

Extract `parseLastHistoryLine(text: string): HistoryLine` (currently private in
`emit-benchmark-json.ts`) into a small shared module; both `emit-benchmark-json.ts`
and `drift-check.ts` import it. Same behavior: split on newlines, drop blank
lines, `JSON.parse` the last, throw on empty input.

## 4. Data flow

```text
06:00 UTC daily
  └─ _perf-drift.yml (ubuntu, gha-ubuntu history)
       └─ drift-check.ts → runDriftCheckMain({ gh, runner: "gha-ubuntu" })
            ├─ GhCli.runListRecentSuccesses(_perf.yml, branch=main, limit=14)
            ├─ for each run (oldest-first): GhCli.runDownloadArtifact → parseLastHistoryLine
            ├─ per trend, smaller-is-better surface: build DriftSample[] → detectDrift(series, 20)
            └─ if drifting: GhCli.issueList(label=perf-drift)
                 ├─ no matching open issue → GhCli.issueCreate(title, label, bodyFile)
                 └─ matching open issue    → GhCli.issueComment(number, bodyFile)
```

## 5. Error handling

Unchanged from the shipped wrapper: drift-check is advisory and fail-soft. A
failed `gh run list` logs to stderr and returns `[]` (no issues filed); an
unreadable artifact is skipped; an issue-upsert failure for one surface logs and
continues to the next. The workflow itself does not gate any build — a non-zero
exit would only mark the scheduled run red, and `runDriftCheckMain` returns
normally on all handled errors.

## 6. Testing

- **`detectDrift`** — existing unit tests, kept green through the `medianOf` swap
  (no new assertions needed; the swap is behavior-preserving).
- **`parseLastHistoryLine`** (new, `history-jsonl.test.ts`) — empty input throws;
  last-of-many wins; trailing-newline tolerated.
- **`GhCli` issue methods** (new, in the existing `bench-ci-gh` test file) —
  injected `spawn` asserts exact argv for list/create/comment and the
  tolerant-JSON parse for `issueList` (incl. the non-JSON-notice → `[]` arm).
- **`runDriftCheckMain` wrapper** (new) — injected `GhCli` (canned `spawn`
  sequence) + fake `run-history.jsonl` artifacts staged in a temp dir, mirroring
  the `bench-ci.test.ts` fixture pattern. Three cases: a drifting series →
  exactly one `issueCreate`; a drifting series with a matching open issue →
  `issueComment` (no create); a flat series → neither.

## 7. Rollout

Single PR (workflow + GhCli methods + drift-check refactor + shared parser +
tests). No schema migration, no new security invariant (perf is not an invariant
surface; the `issues: write` grant is scoped to one non-fork-triggered workflow).
First scheduled run lands the day after merge; can be smoke-tested immediately
via `workflow_dispatch`. The `perf-drift` issue label is created on first use by
`gh issue create --label` (or pre-created in the repo).

## 8. Risks & mitigations

- *Unattended issue spam from a wrapper bug* → mitigated by the new wrapper test
  plus the upsert dedup (one open issue per surface title) that already exists.
- *14-artifact download cost daily* → low; one ubuntu job, ~14 small JSONL
  artifacts, once/day.
- *`gha-ubuntu` history sparse early on* → `detectDrift` needs `≥ k+n` samples
  and returns `false` otherwise, so it no-ops until enough history accrues.
- *Stale duplicate of the two #656 gate fixes on this branch* → this branch is
  stacked on the Biome-2.5.0/ovsx fix branch; rebase onto `main` after #656
  merges drops the duplicates.
