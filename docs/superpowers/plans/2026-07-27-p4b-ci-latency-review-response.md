# P4b implementation-plan review — response

Response to [`2026-07-27-p4b-ci-latency-review.md`](./2026-07-27-p4b-ci-latency-review.md).

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | Does `created_at` track eligibility or run creation? | **Verified — hypothesis disproved**, plus a guard added so the assumption cannot rot silently |
| 2 | API volume / rate-limit handling | **Fixed** — bounded fetches + partial-collection detection |
| 3 | `MIN_SAMPLES_FOR_RATCHET = 5` too low | **Fixed, but the threshold was not the problem** — the sampling window was |

---

## 1. `created_at` — verified against the live API, hypothesis disproved

The review proposes that GitHub "creates all jobs in the run database at the very
start", which would make `dagWait` always 0 and silently collapse `queue` back
into the conflated metric this design exists to avoid. That would be fatal, so it
was measured rather than argued.

**Across 8 CI runs (301 jobs): 203 jobs have `created_at` shifted more than a
minute after `run_started_at`; 98 sit at ~0.** If the review's model were right,
all 301 would sit at ~0.

The split is not random — it is exactly the DAG:

| job | `created_at` offset | `needs` in `ci.yml` |
| --- | --- | --- |
| `PR quality — TS/Bun (ubuntu-24.04)` | 2.5 min | `needs: filter` |
| `PR quality — Rust/Tauri (ubuntu-24.04)` | 2.5 min | `needs: filter` |
| `PR quality — Duplication scan` | 2.5 min | `needs: filter` |
| `PR quality — required gates` | 2.5 min | `needs: [filter, …]` |
| `E2E Desktop (PR) — ubuntu-24.04` | 2.5 min | `needs: [filter, pr-quality-ts, pr-quality-rust]` |
| every root job | 0.0 min | none |

The `filter` job takes 2.5 minutes, and **every** dependent is created at exactly
2.5 minutes. `created_at` tracks eligibility. The metric stands, and the review's
fallback — reconstructing the DAG from workflow YAML — is not needed.

### But the caution was right, so the assumption is now guarded

This is undocumented API behaviour that a GitHub change could alter silently, and
the failure would be invisible: `dagWait` would quietly go to zero everywhere and
`queue` would re-absorb dependency execution, with no error anywhere.

**Added to the plan (Task 5 + Task 6):** if the whole collection produces
**zero** observations with a non-zero `dagWait`, the shell emits
`::warning::ci-latency: dagWait is zero everywhere — the created_at eligibility
assumption may have changed; queue figures may now include dependency execution`.

A warning rather than a failure, deliberately: an upstream API change is not
something a contributor's PR can fix. Same rule as `queue` itself.

---

## 2. API volume — fixed, and finding 3 forced the shape of the fix

The arithmetic in the review is right (~279 requests), and the robustness point
is right: `runGh` already degrades to `ok: false` rather than throwing, so
nothing crashes — but a **partial** collection is the real hazard. If half a
repo's job fetches fail, the survivors still produce medians, and those medians
could be biased toward whichever runs happened to succeed. The gate would then
compare a thin, skewed sample against the baseline and could manufacture a
regression.

**Fixed:**

- `collectAll` now returns `{ observations, readFailures }` instead of a bare
  array.
- Any read failure emits a warning naming the count.
- If read failures exceed **25%** of attempted job fetches, the run **skips
  gating entirely** via `strictSkip` rather than gating on a degraded sample —
  an unreliable read is `indeterminate`, never a finding.

Note the interaction with finding 3: the fix there *widens* the window, which
would have pushed this toward ~900 requests. That is resolved by capping job
fetches **per workflow** rather than per repo (below), which keeps the total in
the same ~300 range while multiplying per-key depth.

---

## 3. Ratchet threshold — the number was not the problem

The instinct is right — 5 is a small sample — but both the suggested values would
have made the mechanism **dead**, and measuring showed my own 5 was already
nearly dead.

With the planned 30-run window, over 161 distinct keys:

| threshold | keys that qualify |
| --- | --- |
| ≥3 (gating) | 114 (71%) |
| ≥5 (planned ratchet) | **4 (2%)** |
| ≥7 (suggested) | **0** |
| ≥10 (suggested) | **0** |

### Root cause: the window, not the threshold

`MAX_RUNS_PER_REPO = 30` counts runs **across all workflows in the repo**. Those
30 push runs span 8 workflows, so `CI` itself gets only **4** — and no CI job can
ever have more than 4 samples. Raising the threshold against that window cannot
help; it can only disable the ratchet.

Measured at a wider window:

| window | runs for `CI` |
| --- | --- |
| `per_page=30` | 4 |
| `per_page=100` | **12** |

**Fixed by re-shaping sampling:**

- `RUN_LIST_PAGE = 100` — fetch the run *list* at the API maximum (1 request).
- `MAX_RUNS_PER_WORKFLOW = 12` — cap the expensive *job* fetches per workflow,
  not per repo.

This lifts achievable depth for a stable CI job from ≤4 to ~12 while keeping
total requests in the same ballpark as before (the cap binds where the volume
is), which is what makes finding 2's fix and finding 3's fix compatible.

**With ~12 samples reachable, the review's suggestion becomes affordable, so it
is adopted: `MIN_SAMPLES_FOR_RATCHET = 7`** (up from 5). Lowering a bound now
requires more than half of a full window's evidence, and unlike the original
proposal it is a threshold that keys can actually meet.

`MIN_SAMPLES` stays at 3 for gating: 71% of keys qualify, and requiring more
would silently stop watching most of the org.

---

## Net changes to the plan

- **Task 1** — `MAX_RUNS_PER_REPO` replaced by `RUN_LIST_PAGE` (100) +
  `MAX_RUNS_PER_WORKFLOW` (12); `MIN_SAMPLES_FOR_RATCHET` 5 → 7;
  `MAX_READ_FAILURE_RATIO` (0.25) added.
- **Task 5** — group runs by workflow and cap per workflow; return
  `{ observations, readFailures, attempted, sawNonZeroDagWait }`; new tests for
  the per-workflow cap and for failure counting.
- **Task 6** — warn on read failures, skip gating past the failure ratio, and
  emit the `dagWait`-is-zero-everywhere guard.
- **Task 3** — the ratchet test updates to 7.
