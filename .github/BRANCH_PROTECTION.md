# Branch protection (repository settings)

Enable these in **GitHub → Settings → Branches → Branch protection rules** for `main` (and `develop` if used as a merge target).

## TL;DR — clear Scorecard **Branch-Protection** / **Code-Review** (High)

Those findings measure **default-branch rules** on GitHub, not files in this repo. Configure them once; the next **Scorecard** run (Tuesday schedule or push to `main`, see `.github/workflows/scorecard.yml`) refreshes SARIF and the alerts typically move to **Closed** or downgrade.

### Option A — **Rulesets** (recommended UI)

1. Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. **Ruleset name:** e.g. `main — required reviews + checks`.
3. **Enforcement status:** **Active**.
4. **Target branches** → **Add target** → **Include default branch** (or **Add pattern** `main`).
5. Under **Branch rules**, enable at least (see [mapping table](#map-scorecard-branch-protection-warnings-to-github) for Scorecard wording):
   - **Require a pull request before merging**
   - **Required approvals** → **2** for maximal OpenSSF Scorecard (use **1** if you are solo and accept a lower score).
   - **Require status checks to pass** → **Add checks** → pick the checks in the [table below](#currently-active-required-checks-general-ruleset-on-main) (names must match the Actions tab exactly).
   - **Require review from Code Owners** (uses [`.github/CODEOWNERS`](./CODEOWNERS) on `main`).
   - **Dismiss stale pull request approvals when new commits are pushed**
   - **Require approval of the most recent reviewable push** (wording may vary by plan).
6. **Bypass list** — leave **empty** so admins cannot skip rules (fixes Scorecard “does not apply to administrators”).
7. **Create** / **Save** the ruleset.

### Option B — **Classic** branch protection rule

1. **Settings** → **Branches** → **Add branch protection rule** (or edit existing) for `main`.
2. Enable **Require a pull request before merging**, **Require approvals** (prefer **2** for Scorecard; **1** if solo), **Require review from Code Owners**, **Require status checks to pass** (add checks from the table below), **Dismiss stale reviews**, and **Require review before merging the most recent push** if shown.
3. Enable **Do not allow bypassing the above settings** for administrators (same as “rules apply to administrators” in Scorecard).

After this is live on `main`, open **Security → Code scanning**, filter **Tool: Scorecard**, and use **Dismiss** only if a finding is a false positive (rare for these three).

## Map Scorecard Branch-Protection warnings to GitHub

Scorecard **Branch-Protection** (rule `BranchProtectionID`) reads **enforced** rules on **`main`**. Typical warnings and how to clear them:

| Scorecard warning (gist) | What to set on `main` |
|----------------------------|------------------------|
| Branch protection **does not apply to administrators** | **Rulesets:** leave **Bypass list** empty (do not add admins or “Repository admin”). **Classic:** enable **Do not allow bypassing the above settings**. |
| **Required approving review count** is only 1 | Set **Required number of approvals** to **2** for a higher Scorecard score; keep **1** if that matches your team size. |
| **Code owners** review not required | Enable **Require review from Code Owners** and merge [`.github/CODEOWNERS`](./CODEOWNERS) on `main`. |
| **Last push approval** disabled | Enable **Require approval of the most recent reviewable push** (rulesets) or the closest equivalent in classic rules. |
| **No status checks** found for merge | In the same ruleset, **Require status checks to pass** and add the checks in the [table below](#currently-active-required-checks-general-ruleset-on-main). They must be **required before merge** — Scorecard only sees checks GitHub **blocks merges** on, not jobs that merely exist in YAML. |

**Finding check names:** open **Actions** → pick a recent **CI** / **Security** / **CodeQL** run on `main` or a PR → copy each **job name** exactly (including punctuation and OS suffixes) into the ruleset search box.

## Scorecard alerts in “Code scanning” (no file in repo)

Scorecard uploads SARIF to **Security → Code scanning**. Findings such as **Branch-Protection**, **Code-Review**, and **Maintained** are **not** tied to a path in the tree: they score **GitHub settings** and **project activity**. Closing them is done in the UI (and with ongoing maintenance), then the next **Scorecard** run (see `.github/workflows/scorecard.yml`: scheduled and on push to `main`) refreshes or drops the alert.

| Scorecard finding | What actually changes the score |
|--------------------|-----------------------------------|
| **Branch-Protection** | Strong default-branch rule: require PR, required status checks (below), optional “include administrators”. |
| **Code-Review** | Same rule: required approving reviews, optional CODEOWNERS reviews, dismiss stale reviews, “require approval of most recent push” if your plan offers it. |
| **Maintained** | Steady **commits**, **releases**, and **issue/PR triage** (Scorecard looks at activity windows). Repos **younger than ~90 days** often score **0** until that window passes — expected, not a misconfiguration. |
| **Dependency-Update-Tool** | Scorecard looks for an update tool's config file. There is none by decision: Dependabot version updates were retired on 2026-10-02 and dependencies move in periodic manual bulk updates ([`docs/CONTRIBUTING.md` § Updating Dependencies](../docs/CONTRIBUTING.md#updating-dependencies)), which Scorecard cannot see. A low score here is expected, not a misconfiguration. |
| **Fuzzing** | Continuous fuzzing Scorecard recognizes includes **[OSS-Fuzz](https://google.github.io/oss-fuzz/)** (separate application repo), **[ClusterFuzzLite](https://github.com/google/clusterfuzzlite)**, or **[OneFuzz](https://github.com/microsoft/onefuzz)** wiring — not a one-line repo change. |
| **CII-Best-Practices** | Complete the [OpenSSF Best Practices](https://www.bestpractices.dev/) questionnaire for this repository (badge is optional). |

**Security-Policy** is satisfied by [`docs/SECURITY.md`](../docs/SECURITY.md) on the default branch (separate from the rows above).

## Recommended required status checks

The recommended set is the one the `General` ruleset already requires — the ten contexts in [Currently active required checks](#currently-active-required-checks-general-ruleset-on-main) below. An earlier version of this section recommended individual jobs instead (`PR quality — TS/Bun (ubuntu-24.04)`, `PR quality — Rust/Tauri (ubuntu-24.04)`, `PR quality — Duplication scan`, the label-gated `E2E Desktop (PR) — ubuntu-24.04`, and the push-only `CI — TS/Bun` / `CI — Rust/Tauri` matrices). **Do not add those as required contexts.** Two of them can never report on a pull request, which then waits forever: `PR quality — TS/Bun (ubuntu-24.04)` calls a reusable workflow, so its checks are named `PR quality — TS/Bun (ubuntu-24.04) / <job>` and nothing reports under the bare name; and a matrix job that its `if:` skips reports only under its literal, unexpanded name (`CI — TS/Bun (${{ matrix.os }})`), so `CI — TS/Bun (ubuntu-24.04)` never appears on a PR. A job with a static name behaves differently: when its `if:` skips it, it reports `skipped`, which counts as a pass, the way `Cargo audit (Tauri)` does on a PR that touches no Rust. So `PR quality — Rust/Tauri (ubuntu-24.04)` and `PR quality — Duplication scan` would not stall anything, but `PR quality — required gates` already covers both, and requiring the label-gated `E2E Desktop (PR) — ubuntu-24.04` would only gate the PRs that carry its label.

**Note:** Required checks must match the **exact** job names shown in the Actions UI. After changing workflow job names, update the rule accordingly. Marking every Security job as required ensures `bun audit`, Trivy, gitleaks, the gateway contract tests, `cargo audit` and `cargo deny` all block merges when they fail.

## Currently active required checks (`General` ruleset on `main`)

The `General` ruleset (id `14784377`) requires the following 10 checks to pass before a PR can merge to `main` (re-derived from the live ruleset on 2026-10-02). These names are matched **verbatim** against the Actions UI; renaming a job in the workflow YAML without updating the ruleset will break merges.

| Required check | Source workflow | Notes |
|---|---|---|
| `PR quality — required gates` | `ci.yml` | The aggregator: an `if: always()` job that `needs:` every PR-quality job (TS/Bun suite, Rust/Tauri, the macOS + Windows cross-platform legs, duplication, ONNX clean room, structure audit, release safety) and fails unless each one succeeded or was legitimately skipped |
| `Dependency audit` | `security.yml` | `bun audit`, then `audit:advisories`, then `audit:js-licenses` |
| `Trivy vulnerability scan` | `security.yml` | filesystem scan + SARIF upload |
| `Gitleaks secret scan` | `security.yml` | committed-secret detection |
| `Gateway audit JSON + connector.remove vault restore` | `security.yml` | Gateway contract tests |
| `Cargo audit (Tauri)` | `security.yml` | Rust dep advisories; reports `skipped`, which passes, on a PR that touches no Rust |
| `Cargo deny (licenses + advisories + bans)` | `security.yml` | License + bans + registry pinning; skipped the same way |
| `Analyze (javascript-typescript)` | `codeql.yml` | CodeQL JS/TS security-extended |
| `Analyze (rust)` | `codeql.yml` | CodeQL Rust security-extended |
| `cla` | `cla.yml` | CLA Assistant, on `pull_request_target` |

**Merge rules around them:** squash is the only merge method, there is **no merge queue**, and **Require branches to be up to date** is off. Two further rules in the same ruleset are not status checks: every review conversation must be resolved before merge (`required_review_thread_resolution: true`), and a `code_quality` rule is set at `severity: all` (both re-derived from the live ruleset on 2026-10-03). A PR can merge as soon as these checks are green, and `gh pr merge <n> --squash --auto` merges it at that moment. A merge queue ran from 2026-09-30 to 2026-10-02 and was retired; no workflow reports on `merge_group` any more, so turning a queue back on would stall every merge until each required context did.

**Individual PR-quality jobs are deliberately not required contexts.** A job skipped by its own `if:` still reports `skipped`, but it never expands the `${{ }}` in its name, so a required context named after a matrix leg or a reusable-workflow child (`PR quality — TS/Bun (ubuntu-24.04) / Test — ubuntu-24.04` used to be one) is never created on a PR that skips it, and that PR waits for it forever. `PR quality — required gates` has a static name and covers them all, so adding, renaming or matrix-ing a gate inside `ci.yml` needs no ruleset edit. Label-gated jobs such as `E2E Desktop (PR) — ubuntu-24.04` and the push-only `CI — *` matrix are outside it.

**When job names change:** `gh api repos/nimbus-agent/Nimbus/rulesets/14784377` exposes the current `required_status_checks` array. Update via `PUT repos/nimbus-agent/Nimbus/rulesets/14784377` with the corrected `context` strings.

**Solo-dev approval policy:** the same ruleset has `required_approving_review_count: 0`, and its only bypass actor is `OrganizationAdmin` with `bypass_mode: always` — PRs are mandatory, status checks are mandatory, but human approval is not (see `docs/SECURITY.md` and the threat model around AI-assisted review). The bypass is silent: an admin can merge with checks still pending and nothing on the PR records it, so wait for the checks or use auto-merge.

## Security features (org or repo)

- **Secret scanning** — detect leaked secrets in the repository.
- **Push protection** for secrets — block pushes that contain high-confidence patterns (if your plan supports it).

These are configured under **Settings → Code security and analysis**, not in workflow files.

## OpenSSF Scorecard: Branch-Protection and Code-Review

Scorecard’s **Branch-Protection** and **Code-Review** checks reflect **default-branch** settings (usually `main`), not YAML in this repo. To improve those scores:

1. **Branch protection rule for `main`** (and `develop` if it is a protected merge target):
   - Require a pull request before merging.
   - Require approvals (at least one; use more for sensitive repos).
   - Require status checks to pass (see the table above).
   - Prefer **Require review from Code Owners** if you add a `CODEOWNERS` file.
   - Enable **Do not allow bypassing the above settings** for administrators when your governance model allows it.
2. **Code-Review** in Scorecard also considers review policy depth (e.g. dismiss stale reviews, required review on last push) — configure those in the same branch rule UI.

See [`docs/SECURITY.md`](../docs/SECURITY.md) for other Scorecard items (fuzzing, CII badge) that need separate enrollment.

## Why both PR quality and CI matrix?

- **PR quality** (single Ubuntu runner) gives fast feedback on every PR.
- **CI matrix** (Ubuntu, macOS, Windows) runs on **push** after merge to prove cross-platform behavior before release and for `e2e-desktop` gating on `main`.
