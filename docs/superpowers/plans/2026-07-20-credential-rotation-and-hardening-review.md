# Credential Rotation & Hardening Implementation Plan Review — Feedback, Suggestions, and Open Questions

This document reviews the implementation plan for **Credential Rotation & Hardening** ([2026-07-20-credential-rotation-and-hardening.md](file:///C:/gitrep/Nimbus/.claude/worktrees/credential-rotation-hardening/docs/superpowers/plans/2026-07-20-credential-rotation-and-hardening.md)).

---

## 1. Open Questions & Technical Clarifications

### Q1.1: Verification of `gh` Command Context in Task 1 Spike

* **Observation:** Task 1 runs a temporary GitHub Action workflow to test permissions.
* **Question:** Is the `gh` client within the Ubuntu runner context authenticated automatically via the minted token when running `gh api` calls, or is setting the `GH_TOKEN` environment variable sufficient? Under standard runner setups, `gh` commands implicitly read `GITHUB_TOKEN` from the environment if no token is configured. Setting `GH_TOKEN: ${{ steps.mint.outputs.token }}` is correct and should take precedence, but we should make sure we explicitly check that no caching from previous runner environments interferes with the token swap.

### Q1.2: Scope of the `repos` list in `credential-enumerate.ts`

* **Observation:** The plan flatMaps repos from `CREDENTIAL_REGISTRY`:

  ```ts
  const repos = [...new Set(CREDENTIAL_REGISTRY.flatMap((e) => (e.location.repo ? [e.location.repo] : [])))];
  ```

* **Question:** If the auditor is installed on all 18 repositories, but the registry only lists a subset of repositories (e.g. `Nimbus`, `nimbus-vscode`, `nimbus-web-clipper`, `nimbus-sdk`, `nimbus-client`), then any undocumented credentials in the remaining repositories won't be scanned because those repositories are not listed in the flatMap.
* **Refinement:** To truly satisfy Goal 2 ("detect undocumented credentials"), the `repos` list fed to `enumerateSecrets` should ideally be resolved dynamically by querying GitHub for all repositories in the organization, rather than relying only on the repositories mentioned in the manifest. If we only scan repos declared in the manifest, we will never see an undocumented secret created in a completely new repository.

### Q1.3: Expected HTTP Status code handling on `/dependabot/secrets`

* **Observation:** In Task 4, we query `/repos/{owner}/{repo}/dependabot/secrets`.
* **Question:** If a repository doesn't have Dependabot enabled (or has no secrets configured), does the endpoint return a 404, or a 200 with `total_count: 0`? The mock fetch tests in `credential-enumerate.test.ts` should ensure that both return scenarios are correctly mapped without triggering an error in `enumerateSecrets`.

---

## 2. Suggested Improvements & Refinements

### Suggestion 2.1: Dynamic Repo Enumeration for Completeness

* **Context:** The current plan passes a static list of repos extracted from the manifest to `enumerateSecrets`.
* **Suggestion:** We should consider fetching the organization's repositories dynamically using `GET /orgs/nimbus-agent/repos` using the auditor app's token first. That way, even if a repository is not listed in the manifest, it will still be queried for Action and Dependabot secrets. This guarantees that **any** undocumented secret in the org gets flagged.

### Suggestion 2.2: Ensure exact matching in `daysBetween`

* **Context:** `daysBetween` uses `Math.floor((to.getTime() - from.getTime()) / 86_400_000)`.
* **Suggestion:** If the clocks of the GitHub API (`updated_at` timezone formatted) and the runner timezone differ slightly, this division could lead to slight off-by-one errors for secrets updated recently. Using a helper that strips the time portion of dates and compares calendar days is a safer approach for calculating age thresholds.

---

## Resolutions (2026-07-20)

### Q1.2 + S2.1 — the scan surface was derived from the manifest · **CRITICAL, FIXED**

The review is right, and the consequence is worse than it states. Verified: the
manifest names **3** repos (`Nimbus`, `nimbus-vscode`, `nimbus-web-clipper`); the
org has **18**. So 15 repos — including both npm satellites and all 6 private ones
— would never have been scanned.

That defeats the sub-project's primary goal. `undocumented` exists to find a
secret nobody recorded, and deriving the scan surface from the manifest means
only ever looking where the manifest already points. A secret in an undocumented
repo would have been invisible **by construction**, while the monitor reported
everything healthy — a false all-clear, the exact failure class this program was
started to eliminate.

It also made the plan self-contradictory. Task 9 proves the `undocumented` path by
planting a probe secret in **`nimbus-benchmarks`**, which is not in the manifest.
Under the original design that repo would never have been queried, so Task 9 would
have detected nothing and "passed" by proving nothing.

**Fix:** `enumerateSecrets` now takes **no `repos` parameter at all** and
discovers the surface via `GET /installation/repositories` — an endpoint already
proven against this App during design verification (`total_count = 18`). An
optional override was deliberately rejected: it would let production silently take
the wrong path. A discovery failure is now pushed to `errors` rather than yielding
an empty scan, because an empty repo list would make the whole inventory look
clean. Task 9 now states explicitly that `nimbus-benchmarks` is chosen *because*
it is absent from the manifest, making it a true test of the discovery path.

### Q1.3 — Dependabot endpoint on a repo with no secrets · **ANSWERED + test added**

Answered empirically rather than assumed: `GET /repos/{owner}/{repo}/dependabot/secrets`
returns **200 with `total_count: 0`** for every repo checked on 2026-07-20 —
including repos where Dependabot has no secrets configured. 404 occurs only where
the App is not installed.

The plan already handled 200/404/403 distinctly, but the review is right that
"200 with an empty list" was only covered incidentally. An explicit test now
asserts an empty repo yields no secrets **and no errors**, so a future change that
starts treating empty as an error cannot pass.

### Q1.1 — `gh` token precedence in the Task 1 spike · **DECLINED, with reasoning**

`gh` resolves `GH_TOKEN` ahead of `GITHUB_TOKEN`, and the probe step sets
`GH_TOKEN` explicitly while never setting `GITHUB_TOKEN` in that step's `env:`, so
there is no ambiguity to resolve.

The specific concern — "caching from previous runner environments" — does not
apply: GitHub-hosted runners are ephemeral VMs, freshly provisioned per job, so
no credential state survives between runs. Adding a defensive check would
implement a guard against something that cannot occur and would suggest to a
future reader that it can.

This is also not theoretical: the identical pattern already ran successfully
during design verification, minting the auditor token and enumerating 18 repos.

### S2.2 — calendar-day arithmetic in `daysBetween` · **DECLINED — it would make this worse**

`updated_at` is an ISO-8601 UTC instant and `Date.getTime()` returns milliseconds
since the Unix epoch, which is timezone-independent by definition. Subtracting two
`getTime()` values measures elapsed real time; no local timezone participates, so
the premise that runner and API timezones could disagree does not hold.

Switching to calendar-day comparison would **introduce** the very dependence the
suggestion aims to remove, because "which calendar day" requires choosing a
timezone — and a runner in UTC and a maintainer in UTC+3 would then disagree about
a secret's age.

The `Math.floor` behaviour is also correct rather than incidental: a secret set
89.9 days ago reports 89, so `maxAgeDays: 90` fires at 90.0 elapsed days exactly.
Rounding up would fire a day early and make the threshold mean something other
than what it says.
