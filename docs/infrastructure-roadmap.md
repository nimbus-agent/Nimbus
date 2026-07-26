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
fail when a required workflow's action is not permitted to run — is recorded
under [P5](#p5-progress-log).

---

## Sub-programs

Design of record:
`superpowers/specs/2026-07-23-org-infrastructure-program-design.md`.

| | Sub-program | Status | Gate |
| --- | --- | --- | --- |
| P1 | Org CI Foundation | ✅ done | The scheduled sweep goes red on drift: SHA-pins across the 8 public org repos, ruleset shape across the 5 active code repos — proven green end-to-end (run 30060920603) |
| P2 | Release Train | 🔨 Phase 1 done | `audit:release-staleness` goes red when a channel (brew/scoop/linux/winget) lags the published Release past the grace window, or when a release phantoms (manifest bumped, nothing built). Red-proved on a real phantom and green after (`OK (5 edges current)`). Remaining: Phase 2 (dependency-DAG edges) |
| P3 | Review Layer | ⬜ not started | An invariant violation is caught in CI, not only in local `preflight` |
| P4a | Main-CI concurrency | ✅ shipped | Every commit on `main` has a completed CI run |
| P4b | Latency | ⬜ not started | Per-job wall-clock tracked; regressions visible |
| P5 | Org Legibility | ⬜ not started | `audit:secret-inventory` fails on any workflow secret missing from `ci-secrets.md`. **Second gate added 2026-07-26:** an Actions-allowlist check that fails when a required workflow's action is not permitted to run |
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
  follow-up.

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
- **Remaining:** Phase 2 (dependency-DAG edges — sdk/client → consumers). The
  sub-program is *done* only once the `release-staleness` job has run green in
  a scheduled sweep on `main`; **record that run number here** (dispatch
  `org-drift-sweep.yml` — it is green locally against live state as of the
  entry above, so this is the last formality).

### P5 progress log

Not started. Two gates are already specified by findings from other
sub-programs — record them here so the motivation is not lost:

- **`audit:actions-allowlist`** (from the CLA outage, 2026-07-26). For every
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
- **Known inventory item with a deadline:** `VSCE_PAT` expires **2026-12-01**,
  and three release PATs retired during the App migration were never deleted.

---

## How to update this document

- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- When a gate lands, record the command that runs it, so the claim is checkable.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.
