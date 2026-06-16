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
  **ensure the `perf-drift` label exists** (`gh label create perf-drift --color
  … --description … --force` — idempotent; `--force` updates if present) →
  `bun scripts/perf/drift-check.ts`, with `NIMBUS_PERF_RUNNER: gha-ubuntu` in
  the env. All action refs SHA-pinned to match repo convention. The label step
  is required because `gh issue create --label <l>` **fails** on a missing label
  (it does not auto-create) — without it the per-surface try/catch would swallow
  the error and silently file nothing. `gh label create` is covered by the
  `issues: write` grant already requested.
- `schedule` fires only on the default branch of this repo — never on forks/fork
  PRs — so the `issues: write` grant is non-fork-triggered by construction.

### 3.2 `GhCli` issue methods (`packages/gateway/src/perf/bench-ci-gh.ts`)

Add two methods mirroring the existing body-file-based, retry-wrapped
`prComment*` methods (so issue ops inherit the `#run` retry/backoff and the
`spawn` injection seam):

- `issueList({ label }): Promise<{ number: number; title: string }[]>` —
  `gh issue list --state open --label <label> --json number,title`, parsed via
  the existing tolerant JSON-array reader (degrades to `[]` on non-JSON/notice
  output, matching `prCommentList`).
- `issueCreate({ title, label, bodyFile }): Promise<void>` —
  `gh issue create --title <title> --label <label> --body-file <bodyFile>`.

There is intentionally **no `issueComment`** method: the upsert is *create-only*
(see §3.3) — an already-open issue is left untouched, so daily re-commenting
never happens. Body-file (not `--body`) keeps multi-line bodies out of argv and
matches the `prComment*` precedent. Both methods are exercised by new unit tests
(required — `bench-ci-gh.ts` is coverage-floor-gated at ≥80% line+branch).

### 3.3 `scripts/perf/drift-check.ts` refactor

- **Create-only upsert.** Delete the local `ghSpawn` pass-through and route the
  upsert through the injected `deps.gh: GhCli`. `upsertDriftIssue` calls
  `issueList(perf-drift)`; if an open issue whose title matches the surface
  already exists it **does nothing** (the open issue is the standing signal),
  otherwise it writes the body to a temp file (`mkdtempSync` + `join`,
  cross-platform) and calls `issueCreate`. This removes the shipped behavior of
  posting a fresh comment on every daily run while a regression persists (the
  reviewer's spam concern). Net: the wrapper depends only on `GhCli`, injectable.
- Replace local `rollingMedian` with `medianOf` from `baseline-median.ts`,
  guarding the empty case (`window.length === 0 ? 0 : medianOf(window)`) to
  preserve `detectDrift`'s exact contract. `medianOf` is byte-for-byte the same
  median algorithm, so the existing `detectDrift` unit tests stay green. (The
  `detectDrift` loop only ever passes a fixed-size `k`-element window, so the
  guard is defensive, not load-bearing.)
- **One sample per run.** The shipped `downloadRecentMainLines` uses
  `parseHistoryLines`, which parses *every* line of each artifact. Each `_perf.yml`
  run writes a fresh single-run `run-history.jsonl` (its `RUNNER_TEMP` is per-run),
  so today that is one line per artifact and there is no live duplication — but
  reading *all* lines is fragile: an artifact that ever carried more than one line
  would inject multiple samples for a single run and distort the series. Switch to
  the shared last-line parser (§3.4) so each run contributes exactly one sample,
  preserving the existing `isHistoryLineV2` guard (a non-v2 / unreadable artifact
  is skipped, as today).

### 3.4 Shared JSONL parser (`scripts/perf/history-jsonl.ts`, new)

Extract `parseLastHistoryLine(text: string): HistoryLine` (currently private in
`emit-benchmark-json.ts`) into a small shared module; both `emit-benchmark-json.ts`
and `drift-check.ts` import it. Behavior: split on newlines, drop blank lines,
`JSON.parse` the last, throw on empty input. `drift-check.ts` applies its
existing `isHistoryLineV2` check to the returned line inside its per-artifact
try/catch (skipping a non-v2 / unparseable artifact), so the shared helper stays
a thin parser and the v2-guard semantics drift-check needs are preserved at the
call site. `parseHistoryLines` (the all-lines reader) is removed.

## 4. Data flow

```text
06:00 UTC daily
  └─ _perf-drift.yml (ubuntu, gha-ubuntu history)
       ├─ gh label create perf-drift --force   (idempotent; ensures the label exists)
       └─ drift-check.ts → runDriftCheckMain({ gh, runner: "gha-ubuntu" })
            ├─ GhCli.runListRecentSuccesses(_perf.yml, branch=main, limit=14)
            ├─ for each run (oldest-first): GhCli.runDownloadArtifact → parseLastHistoryLine (one/run)
            ├─ per trend, smaller-is-better surface: build DriftSample[] → detectDrift(series, 20)
            └─ if drifting: GhCli.issueList(label=perf-drift)
                 ├─ no matching open issue → GhCli.issueCreate(title, label, bodyFile)
                 └─ matching open issue    → no-op (create-only; no daily re-comment)
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
  injected `spawn` asserts exact argv for `issueList`/`issueCreate` and the
  tolerant-JSON parse for `issueList` (incl. the non-JSON-notice → `[]` arm).
- **`runDriftCheckMain` wrapper** (new) — injected `GhCli` (canned `spawn`
  sequence) + fake `run-history.jsonl` artifacts staged in a temp dir, mirroring
  the `bench-ci.test.ts` fixture pattern. Three cases: a drifting series with no
  matching open issue → exactly one `issueCreate`; a drifting series **with** a
  matching open issue → **no** `issueCreate` (create-only no-op, the anti-spam
  behavior); a flat series → no `issueList`/`issueCreate` at all.

## 7. Rollout

Single PR (workflow + GhCli methods + drift-check refactor + shared parser +
tests). No schema migration, no new security invariant (perf is not an invariant
surface; the `issues: write` grant is scoped to one non-fork-triggered workflow).
First scheduled run lands the day after merge; can be smoke-tested immediately
via `workflow_dispatch`. The `perf-drift` label is guaranteed by the idempotent
`gh label create … --force` step at the top of the job (§3.1), so the run is
self-contained and needs no manual repo setup.

**Issue resolution is manual** in this phase: when a regression is fixed the
daily run simply stops finding drift and files nothing further, but the existing
open `perf-drift` issue is **not** auto-closed — a human verifies the fix and
closes it. This is deliberate: these are intentionally noisy `trend` surfaces, so
auto-closing on the first no-drift run would flap the issue open/closed. (A
future enhancement could auto-close only after *N* consecutive clean runs — §9.)

## 8. Risks & mitigations

- *Unattended issue spam* → create-only upsert (§3.3): an already-open issue is
  left untouched, so there is no daily re-comment; one standing issue per drifting
  surface. Backed by the new wrapper test.
- *`gh issue create --label` fails on a missing label* → idempotent
  `gh label create perf-drift --force` step runs before drift-check (§3.1), so
  the label always exists.
- *14-artifact download cost daily* → low; one ubuntu job, ~14 small JSONL
  artifacts, once/day.
- *`gha-ubuntu` history sparse early on* → `detectDrift` needs `≥ k+n` samples
  and returns `false` otherwise, so it no-ops until enough history accrues.
- *Stale duplicate of the two #656 gate fixes on this branch* → this branch is
  stacked on the Biome-2.5.0/ovsx fix branch; rebase onto `main` after #656
  merges drops the duplicates.

## 9. Deferred enhancements (out of scope, noted for later)

These were raised in review and intentionally deferred to keep this PR focused on
*activating* alerting safely:

- **Informative comment body.** A future iteration could re-introduce a comment
  (re-adding `GhCli.issueComment`) carrying the current p95/median, the deviation
  vs. the rolling median, and the commits since the last clean run — gated by a
  throttle (e.g. no comment unless the prior one is ≥ *N* days old) so it never
  becomes daily noise.
- **Auto-close after sustained recovery.** Close an open `perf-drift` issue
  automatically once drift has been absent for *N* consecutive runs (not a single
  run — that would flap), with a closing comment. Requires tracking per-surface
  clean-run streaks, which this phase does not model.
