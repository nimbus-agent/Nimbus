# Nimbus Infrastructure Roadmap

The delivery machinery for everything the org builds: CI, release automation,
PR review, and cross-repo coordination.

> **Three roadmaps, three axes.** [`roadmap.md`](./roadmap.md) is authoritative
> for **what the gateway does** — phases, acceptance criteria.
> [`ecosystem-roadmap.md`](./ecosystem-roadmap.md) is authoritative for **when
> capability becomes reachable** — client surface width. This file is
> authoritative for **how it gets built, reviewed and shipped**.
>
> On disagreement about gateway capability, `roadmap.md` wins. On disagreement
> about client reachability, `ecosystem-roadmap.md` wins. This file yields to
> both and owns only the machinery.

---

## The pattern this exists to break

**Controls stop where they were written.** Three instances, found across
unrelated areas of the org:

| Control | Written in | Where the risk is | Propagation |
| --- | --- | --- | --- |
| `audit:action-sha-pins` | `Nimbus` | the satellites — pins already drifted | never made |
| `.coderabbit.yaml` (tuned) | the 4 satellites | `Nimbus` — 30 invariants, reviewed stock | never made |
| `ci-secrets.md` completeness claim | when authored | `secret-health.yml`'s own credentials | never made |
| the `cla` required check | verified on `nimbus-web-clipper` | `Nimbus` — the only repo with a restricted Actions allowlist | never made |

Two point in opposite directions, so this is not "the periphery lags." A control
here is scoped to whatever context its author was in, and nothing carries it
further — not to another repo, not to a later day.

**Operating principle:** every sub-program ends in a gate a machine can check. A
sub-program is done when its gate is green in CI and would go red if the
property regressed — not when its code merges. A control that has stopped
covering the risk looks exactly like one that is passing; only a gate that would
go red tells them apart.

### The sharpest instance so far (2026-07-26)

The fourth row above is the thesis in its purest form, and it is worth stating
plainly because it defeats a weaker version of this document's own rule.

The CLA was written, deployed to all six public repos, and made a **required**
status check. It was red-proved on `nimbus-web-clipper`. Every visible signal
said *shipped*. It had **never executed on `Nimbus` even once**: 23 of 23 runs
were `startup_failure`, because `Nimbus` is the only repo whose Actions
allowlist is set to `selected`, and `contributor-assistant/github-action` was
not on it. GitHub rejected the workflow before any job started, so the required
`cla` context was never reported and **every PR was silently unmergeable**.

Two lessons this file should carry:

1. **Verifying a control on one repo proves nothing about another.** The
   red-prove happened where the allowlist was permissive. That is the same
   scoping failure as the three rows above, just with the "context" being a repo
   setting rather than a directory.
2. **"The gate is green" is not the bar — "the gate ran" is.** `cla-coverage`
   was green throughout: it verifies each repo *has* `cla.yml` at a consistent
   version, which was true. A gate that checks a control's *presence* cannot see
   that the control is structurally unable to execute. Absence of a red signal
   was indistinguishable from absence of the signal entirely.

The follow-up gate this implies — an Actions-allowlist drift check that would
fail when a required workflow's action is not permitted to run — shipped in #845
and is recorded under [P5](#p5-progress-log). On its first correct run it found
a second live instance of the same failure mode.

### A gate must never report a permanent mismatch as a fixable failure (2026-07-27)

Promoted from a code comment to an operating rule because it was hit **four
times in one batch**, each time in a different gate, each time as a genuine
design error rather than a slip:

1. `audit:actions-allowlist` — `verified_allowed` is on and no API exposes
   verified-creator status, so the pattern check was permanently
   `indeterminate`, i.e. permanently red under `--strict`.
2. `audit:pin-freshness` — a repo publishing **no releases** (our own
   `nimbus-agent/.github` composite actions) can never be "behind" one.
3. `audit:pin-freshness` again — `dtolnay/rust-toolchain` is pinned to the
   `stable` branch, whose newest *release* sits 12 commits **behind** it, so
   satisfying the gate would have meant moving the pin backwards in code age.
4. `audit:pin-freshness` a third time — a failed commit-date read fell through
   as an empty timestamp, which fails closed to `+Infinity` and manufactured a
   `stale` finding out of a transient API error.

**The rule.** Distinguish a **transient** unknown (a read failed and may succeed
next run) from a **permanent** one (no API can answer, or the question does not
apply). Only the transient kind may be strict-red; the permanent kind warns, is
skipped, or is measured against the thing the code actually tracks. And an
unreadable input degrades to `indeterminate` — never to a finding.

**Why it matters more than it sounds.** A gate that is always red is one
everybody learns to ignore, which is indistinguishable from having no gate — the
exact failure this document exists to prevent. The fourth instance is the
sharpest: a gate whose only route to green is making the repo worse is not a
strict gate, it is a broken one.

Instance 4 was caught by CodeRabbit citing `_Source: Path instructions_` — the
`.coderabbit.yaml` rule shipped in #846, one PR earlier. The review layer caught
a violation of a rule the review layer had just been taught.

---

## Sub-programs

Design of record:
`superpowers/specs/2026-07-23-org-infrastructure-program-design.md`.

| | Sub-program | Status | Gate |
| --- | --- | --- | --- |
| P1 | Org CI Foundation | ✅ done | The scheduled sweep goes red on drift: SHA-pins across the 8 public org repos, ruleset shape across the 5 active code repos — proven green end-to-end (run 30060920603) |
| P2 | Release Train | ✅ done — both phases (run 30231918767) | `audit:release-staleness` goes red when a channel (brew/scoop/linux/winget) lags the published Release past the grace window, when a release phantoms, when an npm package is tagged but unpublished, or when a consumer's **lockfile-resolved** dependency lags npm `@latest`. Red-proved on a real phantom and on three real dependency edges; green after both, `OK (12 edges current)`. |
| P3 | Review Layer | 🔨 first step done (#846) | The monorepo now carries a tuned `.coderabbit.yaml` whose `path_instructions` encode I1–I30, the triple rule and the PAL ban — closing the satellites→monorepo direction of the pattern above. **Note:** the previously-stated gate ("an invariant violation is caught in CI") was already met — `_structure.yml` runs `audit:invariants` and all 17 static checks execute there; the one branch `--binary-only` excludes is a census that always exits 0. |
| P4a | Main-CI concurrency | ✅ shipped | Every commit on `main` has a completed CI run |
| P4b | Latency | ✅ done — `ci-latency` green in sweep run `30356357605` | `audit:ci-latency` tracks per-job execution, runner queue and DAG wait across the 9 org repos and fails when a job's execution regresses beyond its own measured noise band. Tuning followed the measurement, not the design of record's hunch: a push run demanded ~105 job slots against a pool granting 12-17, so the fix was cutting the fan-out (coverage gates 72 → 42 jobs, Linux-only except the 9 PAL-touching ones) and narrowing E2E's dependency edge — not the proposed cache tuning or sharding, which would have added jobs to the constrained pool. **Measured after (run `30353595114`): 105 → 77 jobs, DAG wait 60.5 → 2.5 min, wall clock 36-74 → 20 min.** `audit:coverage-gate-pal` keeps the platform classification honest, co-gates included. |
| P5 | Org Legibility | ✅ both gates green (run 30231918767) | `audit:secret-inventory` fails on any workflow secret missing from the credential registry **or** `ci-secrets.md`; `audit:actions-allowlist` fails on an unpermitted action **or** any workflow whose latest run ended in `startup_failure`. The second found a live nightly outage on its first correct run. Remaining: the legibility dashboard. |
| P6 | Access & Contribution Model | 🔨 P6a + CLA done | Every repo reachable through a team + org settings gated (both in the sweep); contributor-two switches recorded in checked-in config; CLA live and **actually executing** on all 6 repos. Remaining: bypass-actor audit |

**Sequence:** P1 → P6 → P2 → P5 → P3 → P4b. Three items ignore the sequence and
land immediately: P4a, `nimbus-client` rulesets, and the contribution-licensing
decision (resolved 2026-07-24 — **CLA**, see the P1 progress log; implementation
moves to P6).

### P1 progress log

- **Main-CI concurrency (P4a)** — shipped: `cancel-in-progress` is now conditional
  on `github.event_name == 'pull_request'`, so consecutive `main` merges no longer
  cancel each other's validation.
- **`nimbus-client` rulesets** — shipped: a `General` branch ruleset (id
  `19635616`, active) now protects the narrow-waist repo that had none, matching
  the shape the other active code repos share (squash-only, thread-resolution
  required, zero required approvals in solo mode).
- **Contribution-licensing decision (2026-07-24)** — resolved to a **CLA** over a
  DCO. A CLA preserves relicensing optionality for any future commercial
  dual-licensing of the AGPL-3.0 core; that optionality is the deciding factor,
  since both mechanisms establish a contributor's right to submit. The P1 plan's
  Task 7 (a `Signed-off-by` DCO + `dco.yml` check) is therefore **superseded, not
  amended** — P1 ships with Tasks 1–6 only. The CLA is its own sub-effort (an
  ICLA/CCLA text + a signature-capture bot) and moves to its natural home in **P6
  (Access & Contribution Model)**; it is *not* a blocker for the P1 PR.
- **Ruleset-drift coverage** — the diff pins name/target/enforcement,
  `ref_name.include` **and `ref_name.exclude`** (an `exclude` naming the default
  branch is a silent total-bypass), the required rule types, and the pull-request
  parameters. **Bypass actors are deliberately NOT diffed** (finding from the
  first live run, below): the CI credential is a repo-scoped App installation
  token with `Administration: read`, and GitHub returns an **empty
  `bypass_actors`** to it for org-level actors (`OrganizationAdmin`). Proven live
  that adding `organization-administration: read` does **not** restore it, and
  reading the field otherwise needs `Administration: write` — which a read-only
  audit gate must not hold. Diffing it therefore false-failed on every repo that
  carries an org-level bypass. **Follow-up:** audit bypass actors from a
  higher-privilege context (a scheduled org-owner credential, not the sweep's App
  token). The intended shape is recorded in `.github/rulesets/general-branch.json`:
  `OrganizationAdmin` on Nimbus/nimbus-vscode/nimbus-web-clipper, none on
  nimbus-client/nimbus-sdk.
- **First post-merge sweep run (2026-07-24)** — P1 merged (#818), so the
  net-new `workflow_dispatch` could finally fire. **`sha-pins`: green across all 8
  repos** — the propagation mechanism works end-to-end. **`ruleset-drift`:** the
  App-token path works (token mint succeeds once `nimbus-release-bot` has
  `Administration: read` and is installed on all 5 repos), and the audit then
  surfaced the `bypass_actors` token-visibility limitation above — closed by
  dropping that one field from the diff. Every other check reads reliably.
- **First org drift sweep (2026-07-23)** — all 8 repos pass `audit:action-sha-pins`
  (run locally as `bun scripts/structure-audit/check-action-sha-pins.ts --root
  <checkout>` against fresh clones, pending the workflow's first post-merge run —
  a net-new `workflow_dispatch` cannot fire on a feature branch). **Finding:** the
  version drift noted in the design (`harden-runner` v2.20.0 vs v2.19.4,
  `actions/checkout` v7.0.1 vs v7.0.0) is *staleness*, not *unpinning* — every ref
  is correctly SHA-pinned, just to older SHAs. The SHA-pin gate is green and
  structurally cannot detect staleness; a freshness check is a **Plan B**
  follow-up. **Plan B delivered 2026-07-27 (#847 gate, #851 remediation):**
  `audit:pin-freshness` compares each SHA-pinned action against the thing it
  actually tracks — the latest release, or, for a pin that deliberately follows a
  named ref, that ref — with a 30-day grace window (not the release train's 6
  hours: a pin moves when a human or Dependabot gets to it, and an hours-long
  window would mean a permanently red sweep). It shipped red on three genuinely
  stale pins, which #851 refreshed, and is green in the sweep at 30/30 current.
  Grace is measured from the target COMMIT's date rather than the release's,
  because a rolling major tag like `v1` was published years ago and would
  otherwise report a wildly misleading age.

### P6a progress log

- **Delivered (2026-07-24) — checked-in config + gates:** `.github/org-access.json`
  (desired org settings + team-reachability exemptions); the two gates
  `audit:org-settings-drift` + `audit:team-reachability` wired into
  `org-drift-sweep` (fail-soft locally, `--strict` in CI); and the four
  contributor-two switches recorded in the `$contributor_two` block of
  `.github/rulesets/general-branch.json`.
- **Applied (2026-07-24, org-owner):** the six teamless repos (`.github`,
  `linux-repo`, the four npm narrow-waist repos) are granted to `maintainers`;
  `members_can_create_repositories` → false and `default_repository_permission`
  → none; the `nimbus-release-bot` App granted `members: read`.
- **Proven green end-to-end (run 30071156534):** a dispatched `org-drift-sweep`
  is green across all 11 jobs — `sha-pins` (8), `ruleset-drift`,
  `org-settings-drift`, and `team-reachability` — with the two new gates
  authenticating via their scoped App tokens (org-administration read /
  members read). Both were **red** before the apply (they detect the un-applied
  state) and green after: the gate would go red on regression, which is this
  file's definition of *done*.
- **Deferred:** the CLA (own spec) and a higher-privilege **bypass-actor audit**
  (the CI App token cannot read `bypass_actors`; a future owner-`gh`-run check,
  no PAT). Private-repo ruleset protection stays **blocked-on-Team** (Free plan).

### CLA progress log

- **Delivered (config + gate):** broad-relicensable ICLA + CCLA drafted
  (`docs/cla/`, pending ratification), the reusable `cla.yml` template, the
  `cla-coverage` drift gate (all 6 public repos have `cla.yml` at one version),
  and `CONTRIBUTING.md` terms.
- **Applied (2026-07-24, org-owner):** the dedicated `nimbus-cla-bot` App
  (id 4382579) + org secrets `CLA_BOT_CLIENT_ID` / `CLA_BOT_PRIVATE_KEY`
  (`SELECTED` → the 6 repos); the `.github` `cla-signatures` branch carrying
  `CLA/ICLA.md` + `CLA/CCLA.md` and `signatures/version1/cla.json`; `cla.yml`
  deployed to all 6 repos; the **`cla`** check made required in each ruleset.
  Note the required context name is **`cla`** — the workflow *job* name, not
  "CLA Assistant". Red-proved on `nimbus-web-clipper` #22.
- **⚠️ The gate was dead on `Nimbus` for two days — fixed 2026-07-26.** All 23
  `cla.yml` runs since deployment were `startup_failure`: `Nimbus` is the only
  org repo with `allowed_actions: "selected"`, and
  `contributor-assistant/github-action` was absent from its `patterns_allowed`,
  so GitHub rejected the workflow before any job ran. The required `cla` context
  was therefore never reported and **every `Nimbus` PR was unmergeable** —
  presenting as `cla — Expected — Waiting for status to be reported`. Fixed by
  adding the action to the repo allowlist (the endpoint is a **full replace**;
  all 13 existing patterns must be re-sent or Trivy/CodeQL/gitleaks silently
  break). First-ever successful run: **30203619816**; `cla` now passes on real
  PRs. See [the sharpest instance](#the-sharpest-instance-so-far-2026-07-26).
  - **Retrigger note:** `startup_failure` runs **cannot** be `gh run rerun`'d
    ("This workflow run cannot be retried"). Use `gh pr close` + `gh pr reopen`
    — `cla.yml` listens for `reopened`, and this leaves branch history clean.
- **Still prove-in-prod:** the sign → green → signature-write leg. It could not
  have been exercised before now, since the workflow never ran on `Nimbus`; the
  first real external PR tests it.
- **Deferred:** CCLA employee-roster automation; private repos; retroactive
  signatures. See `docs/superpowers/specs/2026-07-24-cla-design.md`.
- **Robustness follow-up — CLOSED (2026-07-26, in P2 Phase 1):**
  `check-cla-coverage` used to treat any per-repo `gh` failure as "cla.yml
  absent", so a transient 5xx/rate-limit would false-red until the next run.
  `_gh-audit.ts` now surfaces the HTTP status and `classifyReadFailure` treats
  a non-404 as indeterminate, like `team-reachability`.

### P2 progress log

- **Delivered (Phase 1 — channel staleness):** `.github/release-train.json`
  declares the propagation edges; `audit:release-staleness`
  (`scripts/structure-audit/check-release-staleness.ts`) reads three heads —
  intended (release-please manifest + its bump age), published (latest Release
  actually carrying its `SHA256SUMS` asset), distributed (each channel's live
  file, or winget dir-or-open-PR) — and emits a per-edge verdict. A new
  `release-staleness` job runs it `--strict` on the weekly `org-drift-sweep`
  cron. Public reads only, so no App token is minted.
- **Design decisions that matter:** the phantom edge gates on the *bump
  commit's* age, not the release's, so a normal build window is never red;
  winget counts as caught-up on a merged dir **or** an open PR, so the gate
  never waits on Microsoft's merge; every unreadable or unparseable input
  degrades to `indeterminate`, never `stale`; and under `--strict` a run that
  evaluated *nothing* is red, so "indeterminate" cannot read as "all clear".
- **Red-proved on a real defect (2026-07-26, pre-merge):** the gate's first live
  run went **red on a genuine phantom** — `.release-please-manifest.json` on
  `main` claimed `0.27.0`, but no `v0.27.0` tag or Release existed (latest
  built: `v0.26.0`), bump 54h old. All four channel edges evaluated `ok`. Caught
  on run one, exactly the failure mode the sub-program exists to catch.
- **Green after the defect was fixed (2026-07-26):** `v0.27.0` published with 33
  assets and all three version channels propagated, after which the same gate
  reports `audit:release-staleness: OK (5 edges current)`, exit 0. Red-before /
  green-after on a real defect — this file's definition of *done* for the gate
  itself.
- **What the red thread led to — three nested defects, each hidden by the one
  above it.** Worth recording because the sub-program's value showed up as
  diagnosis, not just alerting:
  1. The phantom itself (`v0.27.0` merged, never tagged).
  2. The auto-reconcile step added to recover phantoms (#824) had been a
     **silent no-op since it shipped**. It probed for the tag with
     `existing=$(gh api ... || true)`, but `gh` writes its error body to
     **stdout**, so a missing tag left `$existing` non-empty and the
     "create the tag" branch never ran. Fixed in #834 — *test the exit code or
     validate the output's shape, never `-z` on captured output.*
  3. With #834 in place the step finally attempted the create — and hit
     **`403 Resource not accessible by integration`** on `POST /git/refs`. Root
     cause: GitHub refuses to let a GitHub App create a ref pointing at a commit
     whose `.github/workflows/**` differs from the default branch unless the App
     holds **`Workflows: write`**. A release tag always points at the release
     PR's merge commit, which falls behind `main` as soon as any later PR edits
     a workflow — so this fired on precisely the releases that matter, and is
     structural rather than intermittent. Fixed by granting the permission and
     requesting it in the mint step (#837).
     - The decisive diagnostic was the response header
       **`X-Accepted-Github-Permissions: contents=write; contents=write,workflows=write`**,
       captured with `gh api -i` from inside CI using the minted token. Reach
       for that header first on any opaque App `403`.
     - The App permission is **Workflows** ("update GitHub Action workflow
       files"), *not* **Actions** ("workflows, workflow runs and artifacts") —
       the two are easy to confuse in the App UI, and we picked the wrong one on
       the first attempt.
     - `rulesets/rule-suites?ref=<ref>` returning `[]` is the authoritative,
       read-only way to prove a ruleset was *not* involved. It exonerated the
       "Protected release tags" ruleset here and prevented a pointless
       weakening of it.
- **Phase 1 is DONE by this file's own bar (2026-07-26): green in CI, run
  30210246814.** A dispatched `org-drift-sweep` ran the `release-staleness` job
  on `main` and it passed. Red-before / green-after on a real defect, then green
  in the scheduled harness — that is the full definition of *done* for a gate
  here, not "the code merged".
- **The same run surfaced a separate, unrelated defect:** the `cla-coverage`
  job failed — and it failed at the **App-token mint**, so its audit never ran.
  The mint requests six repos; the App's installation does not include
  `awesome-nimbus`. The CLA program grew its gated list to six while the App's
  repository access stayed at five, and because P6a's green sweep predates both
  new jobs, **this was `cla-coverage`'s first-ever real execution**. Fifth
  instance of the pattern at the top of this file, second in one day. Fix is
  org-owner: add `awesome-nimbus` to the `nimbus-release-bot` installation.
- **Delivered (Phase 2 — dependency DAG, 2026-07-26):** `.github/release-train.json`
  gains `packages[]`; two new edge kinds run in the same gate. `<pkg>:publish`
  compares the upstream component-prefixed release tag to npm `@latest`,
  catching "tagged but never published" — the npm analogue of the release
  phantom. `<pkg>:<consumer>` compares each consumer's **lockfile-resolved**
  version to npm `@latest`, because a range misleads in both directions:
  `^1.2.0` permits a newer `1.3.0`, while a caret on a `0.x` pins the minor, so
  `^0.5.0` cannot reach `0.12.1` at all.
- **The lockfile reader is workspace-scoped, not global.** A bun.lock resolution
  key is a dependency *path*, so a lower version nested under a third-party
  package is that package's business, not ours. The reader takes the minimum
  over the hoisted entry plus entries whose prefix is one of the consumer's own
  workspace names. Getting this wrong reports a version no local code resolves —
  confirmed live: Nimbus's hoisted sdk is `1.6.0` while the copy inside
  `@nimbus-dev/client` is `1.3.0`, and the gate correctly reads `1.6.0`.
- **Shipped RED on real drift (2026-07-26 16:41Z):** `client:Nimbus`
  (0.5.0 vs npm 0.12.1) and `client:nimbus-vscode` (0.11.0 vs 0.12.1), both past
  a 52h-old publish. Confirmed drift, not deliberate pins. Both `:publish` edges
  green. Bumping those consumers is separate remediation work.
- **The sdk edges were green on that run for the right reason, and the timing is
  the point.** `@nimbus-dev/sdk` 1.7.0 had been published 0.8h earlier, so the
  6h grace window suppressed all three consumer edges even though every one of
  them is behind it (nimbus-vscode 1.5.2, nimbus-client and Nimbus 1.6.0). That
  is the rule working — a package published minutes ago must not red its whole
  consumer set — but it means those three edges go red once grace expires unless
  they are bumped, and the drift is larger than the design's snapshot recorded.
- **Phase 2 is DONE by this file's own bar (2026-07-27): green in CI, run
  30231918767.** A dispatched `org-drift-sweep` ran `release-staleness` on
  `main` and it passed — **`OK (12 edges current)`**: Phase 1's five channel
  edges plus Phase 2's seven dependency edges. Red-before / green-after on real
  drift, then green in the scheduled harness.
- **What made it green was remediation, not a gate change.** All three edges the
  gate shipped red on were fixed at the source: `@nimbus-dev/client` 0.5.0 →
  0.12.1 in `packages/cli` (#848), and the sdk/client bumps in
  `nimbus-client#38` + `nimbus-vscode#58`. The `0.x` cases needed a **manifest**
  edit — a caret on a `0.x` pins the minor, so `^0.5.0` could never reach
  0.12.1 — while the `1.x` cases needed only a lockfile refresh. That asymmetry
  is exactly why the gate reads the lockfile rather than the declared range.
- **The same run was the first fully green sweep: 15/15 jobs**, including
  `cla-coverage`, which had failed at the App-token mint on every previous run
  (the installation did not cover `awesome-nimbus`). It also carried the first
  scheduled runs of the two P5 gates and of `pin-freshness`.

### P4b progress log

- **Delivered (measurement, 2026-07-27):** `audit:ci-latency` collects per-job
  timings from the Actions API across all 9 org repos and gates execution
  against a committed baseline (`docs/structure-audit/ci-latency-baseline.json`),
  mirroring `audit:coverage-floor`.
- **The first measurement contradicted the design of record's hunch.** That
  document proposed cache tuning, matrix sharding and finer path filters. On the
  slowest sampled run (73.8min) the longest single job *executed* for 12.3min,
  while the longest DAG wait was 33.9min and the longest runner queue 31.6min —
  so execution is not the binding constraint, and sharding would worsen it by
  adding jobs to the same contended pool. Principle #3 ("only against
  measurement, never against a hunch") earned its keep on first use.
- **An earlier revision of the design claimed "~80% of wall-clock is queueing".
  That was wrong** and the design review caught it: it measured
  `started_at − run_started_at`, which charges a job for its *dependencies'*
  execution. A job's `created_at` tracks eligibility, so `started_at − created_at`
  is DAG-free contention and the DAG cost is recorded separately. Contention is
  real but concentrated almost entirely on **macOS** runners.
- **Tolerance is a per-key noise band, not a constant.** Measured spreads
  (`p90 − median`) in the committed baseline: `Static — ubuntu` 0.15, `Unit +
  Coverage — ubuntu` 0.22, `Unit + Coverage — windows` **10.48**. No global
  constant fits both, so the baseline stores each job's own spread and the gate
  allows `max(1min, spread)`. A job whose spread exceeds half its median is
  reported `unstable` — observed, never failed, since flakiness is not caused
  by the contributor's change.
- **Baseline coverage:** the generated baseline contains **197 keys from 1778
  observations across 6 repos**. Three of the nine audited repos (`linux-repo`,
  `homebrew-tap`, `scoop-bucket`) contribute nothing because they have zero
  successful `push`-event runs — their automation is dispatch-triggered. This is
  expected, not a gap. An earlier collection paged only the first 100 jobs of
  each run, which silently dropped every job past that cutoff — including all
  three `E2E Desktop` legs, exactly the deepest-DAG, longest-tail jobs the gate
  exists to watch. The collector now pages through `total_count`, capped at
  `MAX_JOB_PAGES` (5) per run, and `Nimbus :: CI :: E2E Desktop — {ubuntu,macos,
  windows}` now appear in the baseline.
- **The gate ships green by construction:** the baseline is generated from the
  same window the check reads, so nothing can exceed it on the first run. The
  red-proof is the unit test in `scripts/ci-latency/evaluate.test.ts`, not the
  live run.
- **Delivered (tuning, 2026-07-28):** the measurement's own "clearest lead" was
  wrong, and two probes disproved it. **Attribution capture A (2026-07-27,
  throwaway probe):** across 45 `E2E Desktop` legs the binding upstream job was
  ubuntu 27×, windows 15×, **macOS only 3×**, and runner queue was ~10min
  median on every OS. The constraint is not macOS scarcity: a push run demands
  ~105 job slots against a pool granting 13-17, with 32-41 jobs
  created-but-waiting at peak; one sampled run opened with nine consecutive
  minutes at zero running jobs. 72 of those 105 jobs were one 24-entry coverage
  matrix run once per OS.
- **Attribution capture B (2026-07-28, promoted `probe-dag.ts` +
  `probe-concurrency.ts`) supersedes A's split across OSes — but not A's
  conclusion.** Re-run over the same 15-run `main` push window, the corrected
  probe reports **ubuntu 24×, macOS 18×, windows 3×** (45 legs, 0 legs
  unattributed, 15/15 complete reads) — macOS at ~40% of the legs, not 7%. The
  created-but-waiting figure moved the same way: 4 sampled runs give **14 / 8 /
  0 / 51 jobs created-but-waiting at peak** (peak concurrent 15 / 12 / 14 / 12;
  105 jobs on all four runs), against A's "32-41 at peak". Both captures are
  kept on purpose — `.superpowers/` is git-ignored, so this prose is the only
  durable record of what was measured, and A's numbers were genuinely measured
  in A's window. A's conclusion — *macOS scarcity is not the binding
  constraint* — held for that window and is not softened here; B disagrees only
  about how the legs divide across OSes. What both windows agree on, and what
  the two changes below act on, is **slot starvation**: 105 jobs against a pool
  granting 12-17, one run sitting 51 jobs deep at its peak and spending its
  first 17 minutes at zero running jobs.
- **This retired the design of record's sharding proposal.** Sharding adds jobs
  to the pool that IS the constraint.
- **Two changes:** coverage-threshold gates run on Linux only except the nine
  whose covered code branches on platform (72 → 42 jobs; a run 105 → 75), and
  `e2e-desktop` now waits on `ci-rust` (1.17-1.72min) instead of `ci-ts` (30
  jobs, DAG wait measured 33.4min median on 2026-07-27) — an edge that carried
  no artifacts.
- **The coverage-gate split is TWO jobs, and the first spelling of it was
  wrong.** The obvious single-job form —
  `if: inputs.run-tests && (inputs.runner == 'ubuntu-24.04' || matrix.gate.pal)`
  — shipped through implementation and review before the whole-branch review
  caught that `matrix` is not in the context set available to a **job-level**
  `if:` (GitHub grants only `github`, `needs`, `vars`, `inputs`, because the
  condition is evaluated before the matrix expands). It would have silently
  skipped **all 24** coverage gates on Windows and macOS — including the PAL
  gates whose preservation is the entire safety argument. The shipped form is
  `coverage-gates-pal` (9 entries, `if: inputs.run-tests`) and
  `coverage-gates-linux` (15 entries, `if: inputs.run-tests && inputs.runner ==
  'ubuntu-24.04'`), each gated only on `inputs`. `fromJSON(...)` over one job
  was rejected: a leg that never expands never creates its check context, and
  this repo depends on a *skipped* leg still creating one.
- **Two gates were promoted to `pal: true` by the same review.** `Embedding`
  and `DB layer` both pull `index/sqlite-vec-load.ts` — which branches on
  platform for the native extension filename — into their coverage denominators
  through static imports (`embedding/lazy-scheduler.ts` and
  `index/migrations/runner.ts`). The PAL set is therefore 9, not 7: `Vault`,
  `Embedding`, `Extensions`, `Telemetry`, `DB layer`, `Doctor`, `Updater`,
  `Perf`, `Sandbox`.
- **The DAG-wait baseline nearly doubled between measurements.** The 33.4min
  figure above was genuinely measured on 2026-07-27. Re-running the promoted
  probe on 2026-07-28 against the same `main` window found **60.5min median
  (max 110.8min, n=15)** — cross-checked by running both the original
  throwaway probe and the promoted `probe-dag.ts` over the same window, which
  returned identical figures, so the widening reflects real CI congestion
  between the two dates (`main` took several merges in between, consistent
  with the slot-starvation diagnosis: more concurrent runs competing for the
  same pool) rather than an instrumentation change. Same-day probes
  (2026-07-28, against `main`) also found: 105 jobs per run on all four
  sampled runs, peak concurrent 12-14 (the plan predicted 13-17), and all
  reads complete (15/15 DAG runs, 4/4 concurrency runs — so none of the above
  is a partial-sample artifact). A third re-run later on 2026-07-28, after the
  whole-branch review fixes, returned **60.1min median (max 110.8min, n=15)** —
  the window had rolled by one run, so the figure is stable, not drifting.
  **~60min median is the baseline any future "after" comparison must be
  measured against — not 33.4.**
- **`audit:ci-latency` cannot prove this worked**, since it gates execution
  while the win lands in queue and DAG wait. `scripts/ci-latency/probe-dag.ts`
  and `probe-concurrency.ts` are the instrument.
- **AFTER MEASUREMENT (2026-07-28, run `30353595114` — the first green push run
  under the new workflow).** Measured, not predicted:

  | metric | before (2026-07-28, n=15) | after (n=1) |
  | --- | --- | --- |
  | DAG wait per `E2E Desktop` leg | 60.5 min median (max 110.8) | **2.5 min** |
  | job that gated E2E | coverage shards (ubuntu 24× / macOS 18× / win 3×) | **`CI — Rust/Tauri (ubuntu-24.04)` 3×** |
  | jobs per run | 105 | **77** |
  | created-but-waiting at peak | 32–41 | **19** |
  | wall clock | 36–74 min | **20 min** |

  Coverage legs land exactly as designed: **ubuntu 24 / macOS 9 / windows 9 = 42**.

  Two honesties about these numbers. The count is **77, not the 75 this document
  predicted** — the estimate omitted the two skipped `Packaging` placeholder jobs
  on windows/macOS; the measurement governs. And **n=1**: the DAG-wait collapse
  (60.5 → 2.5 min) is far too large to be noise, and the binding-job row is
  categorical rather than statistical — E2E is now gated by `ci-rust`, which is
  the change itself — but re-run both probes once ~15 green push runs have
  accumulated for a like-for-like median. Use `--runs 1` to isolate post-change
  runs; the default window of 15 is still dominated by pre-tuning runs.
- **The co-gate enforcement gap is CLOSED.** `PlatformFileEntry` gained
  `coGates`, and rule 3 now checks the primary gate and every co-gate
  identically, so demoting **either** `Embedding` or `DB layer` is caught.
  Previously an entry named one gate and the other rested on a comment.
- **Sweep proof (2026-07-28, run `30356357605`):** the `ci-latency` job is
  **green**, which is P4b's bar — a gate is done when it runs green in the sweep
  and would go red on regression. Stated precisely because the sweep run as a
  whole is red: `release-staleness` failed on the **known, unrelated** P2 edge
  (`client:Nimbus`, 0.5.0 vs npm 0.12.1 — seven `0.x` minors, deliberately left
  for its own reviewed PR). 15 of 16 jobs green. Do not read that red as P4b.
- **Guarded against silent decay:** `audit:coverage-gate-pal` fails when a
  platform-branching file is unclassified, when a classified file's gate is not
  `pal: true`, when a new matrix entry carries no explicit `pal` field, when an
  entry sits in the job that contradicts its `pal` value, when either job's
  `if:` drifts from the condition the split depends on, or when the runner
  literal in `coverage-gates-linux`'s condition stops matching the label
  `ci.yml` actually calls `_test-suite.yml` with. The last three rules exist
  because the first revision validated the `pal:` fields without ever reading
  the `if:` lines that consume them — which is precisely how the broken
  job-level `matrix.gate.pal` condition shipped green.
- **Deferred:** guarding E2E against a TypeScript failure on `main`. Measured
  2 of the last 40 `main` commits arrived without a PR, both `ci(cla)` workflow
  commits touching no TypeScript. No standalone fast typecheck job exists to
  depend on (`Static`, 4.57min, sits inside `_test-suite.yml` where `needs:`
  cannot reach it), so guarding costs a duplicate typecheck job on every push.
  **Adopt if** a `main` E2E run is ever seen burning on a TS compile failure.
- **Baseline regeneration is due after ~12 post-change push runs**, when the
  30 abandoned macOS/Windows coverage keys (15 Linux-only gates × 2 dropped
  OSes) have aged out of the sampling window
  (`MAX_RUNS_PER_WORKFLOW`). Regenerating sooner is a no-op: the window still
  holds pre-change runs carrying those keys.

### P5 progress log

**Both specified gates are delivered and green in the sweep (2026-07-27, run
30231918767).** They shipped in #845 alongside the batch spec
`docs/superpowers/specs/2026-07-26-p5-p3-infra-batch-design.md`.

- **Delivered — `audit:secret-inventory` (#845).** Asserts every secret this
  repo's workflows consume appears in BOTH inventories:
  `scripts/release/credential-registry.ts` (authoritative — owner, rotation
  policy, the `secret-health` watch-list) and `docs/ci-secrets.md` (the
  narrative read during an incident). The finding says WHICH is missing, because
  the repairs differ: "add a row to a table" versus "this credential is
  unmanaged". Deliberately one-directional — `ci-secrets.md` is an ORG-WIDE
  inventory documenting `VSCE_PAT`/`OVSX_PAT`/`NPM_TOKEN` for other repos'
  workflows, so gating the reverse direction could only be satisfied by deleting
  true information. Unlike the sweep gates it is local and deterministic, so it
  runs on every PR from the preflight fast tier — and therefore had to be green
  at merge. Red-before/green-after inside its own PR: five secrets reached the
  prose doc, among them the secret-health probe's own credentials and the CLA
  bot's pair. **Correction worth keeping:** this was first written up as row 3
  of the table at the top of this file still being unfixed. Reading the code
  disproved that — all five were already in the registry, so the drift was
  *narrative*, not unmanaged credentials.
- **Delivered — `audit:actions-allowlist` (#845).** Two halves. The pattern half
  compares each `uses:` against `patterns_allowed` / `github_owned_allowed` /
  same-org. The **direct** half — the one that actually closes the hole — reports
  any workflow whose MOST RECENT run ended in `startup_failure`, which needs no
  knowledge of verified-creator status and also catches invalid workflow YAML.
  Scoped to the latest run so a since-fixed failure does not red the sweep
  forever.
- **It found a second live instance of the CLA failure mode on its first correct
  run (2026-07-26).** `Lock Threads` had been rejected at startup every night
  since at least 2026-07-24 because `dessant/lock-threads` was absent from
  `patterns_allowed`. Fixed by adding the pattern (a full-replace PUT re-sending
  all 14 existing entries), and proved by dispatch: the workflow now completes
  `success`, and the gate reports `0 workflow(s) failing at startup`.
- **The repo-wide run window was the reason nothing saw it.** The first
  implementation read `actions/runs?per_page=100`, which returns the newest runs
  across the WHOLE repo — 26 workflows here, but only 13 represented in that
  window. Each active workflow's latest run is now fetched individually.
- **`secret-health` permission superset** — already fixed in #837; only the
  general rule needed recording (below).

- **Original motivation, kept for the record — `audit:actions-allowlist`** (from
  the CLA outage, 2026-07-26). For every
  repo whose `allowed_actions` is `selected`, assert that every action `uses:`d
  by a workflow in that repo is permitted by `patterns_allowed` (accounting for
  `github_owned_allowed` / `verified_allowed`). Would have caught the two-day
  CLA outage on day zero. `Nimbus` is currently the only repo with a restricted
  allowlist, and its list must be re-sent in full on every edit — the API is a
  replace, not a merge, so a careless PUT silently unpermits Trivy/CodeQL/
  gitleaks. That fragility is itself an argument for checking it in.
- **`secret-health` permission superset** (from #837, 2026-07-26). The weekly
  probe mints the release-bot token, but was requesting a *subset* of what real
  consumers request, so it would have reported healthy after a revoked
  `Workflows: write`. `create-github-app-token` only fails for permissions it
  actually asks for, so **a permission the probe omits is one it cannot detect
  being lost**. Fixed in #837; the general rule — a health probe must exercise
  the superset of what it guards — belongs in this sub-program.
- **Known inventory item with a deadline:** `VSCE_PAT` expires **2026-09-20**,
  and three release PATs retired during the App migration were never deleted.
  The date is the token's **own expiry**, per
  `scripts/release/credential-registry.ts`, which is the SSoT. It is *not*
  2026-12-01 — that is the Azure DevOps global-PAT decommission, which does not
  apply because this token was confirmed org-scoped in the ADO portal
  (2026-07-22, nimbus-vscode#34). An earlier revision of this file carried the
  December date; at 90-day lead that would have stayed silent past the expiry
  that actually bites.

---

## How to update this document

- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- When a gate lands, record the command that runs it, so the claim is checkable.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.
