# Design Review: Org Delivery Infrastructure — Program Design

**Date:** 2026-07-23
**Target Spec:** [2026-07-23-org-infrastructure-program-design.md](./2026-07-23-org-infrastructure-program-design.md)

---

## 1. Security Boundaries and Secrets in Org-Level Reusable Workflows (P1)

### Reusable Workflows and Secret Leakage (I13/I27/I29)

* **Observation:** Promoting workflows to the org-level `.github` repository using `secrets: inherit` simplifies secrets management.
* **Potential Issue:** If a repository's write permissions are compromised or if a malicious PR is submitted to a satellite repository, calling a shared workflow with inherited secrets could inadvertently expose organization-level secrets (like NPM tokens, VS Code Marketplace tokens, or release bot credentials) to untrusted code runs.
* **Suggestion:**
  * Restrict the use of `secrets: inherit` where possible.
  * For sensitive workflows (e.g., publishing to npm or VS Code Marketplace), define explicit inputs/secrets requirements instead of blanket inheritance.
  * Document the exact permission model for workflows running on `pull_request` vs. `push`/`release` events to prevent untrusted PR forks from accessing release-tier secrets.

---

## 2. Downstream Auto-Consumption Cascades and Loops (P2)

### Cascade Control and Circular Dependency Risks

* **Observation:** P2 plans downstream auto-consumption: `sdk` dispatch -> `client` PR, `client` dispatch -> `Nimbus` / `nimbus-vscode` PR.
* **Potential Issue:** If a cycle is introduced, or if multiple repository dispatches queue up rapid-fire, it can trigger run-away CI loops, wasting runner minutes and polluting the PR queues.
* **Suggestion:**
  * Introduce rate-limiting or debounce logic in the dispatch receiver workflows.
  * Ensure the automated PR creation is idempotent: if a downstream PR for version `X` is already open, do not open a new one; instead, update the existing branch or do nothing.
  * Define clear termination rules for the release propagation train.

### Automated Merge & HITL Constraints

* **Observation:** The spec notes "There are no human reviewers" and 18 of the last 80 merges were by `nimbus-release-bot`.
* **Potential Issue:** If the downstream consumption PRs (e.g., bumping client SDK in Nimbus) auto-merge when CI passes, we bypass human gatekeeping entirely. This might conflict with the structural HITL non-negotiables (Invariant I2).
* **Suggestion:** Explicitly document whether the downstream bumps require manual approval (`asafgolombek`) to merge, or if they are auto-merged by the bot only when passing a specific sub-suite of automated validation gates.

---

## 3. Standardizing and Enforcing Rulesets/Branch Protection (P1)

### Infrastructure-as-Code for Repo Rulesets

* **Observation:** `nimbus-client` has zero rulesets while other repositories have some protected release tags.
* **Potential Issue:** Manual configuration of rulesets in GitHub's UI leads to setting drift over time.
* **Suggestion:** Consider managing repository settings and rulesets programmatically (e.g., via GitHub CLI scripts in the `.github` repository or a lightweight Terraform configuration) to guarantee uniform protection across all 9 repositories.

---

## 4. Reusable Workflow Testing and Dev Loop (P1)

### Test Harness/Local Verification for Shared Actions

* **Observation:** "Branch-only workflow changes need live proof."
* **Potential Issue:** Testing shared workflows in `.github` from satellite repositories before merging to `main` is difficult because GitHub Actions reusable references typically require a hardcoded ref (e.g., `org/.github/.github/workflows/reusable.yml@main` or a specific branch/SHA).
* **Suggestion:** Document the exact developer loop for testing changes to reusable workflows. Typically, this involves pointing the caller repo's workflow to `org/.github/...@dev-branch` temporarily, triggering the check, and verifying it succeeds before reverting the ref to `@main` for the PR merge.

---

## 5. Org Legibility Dashboard Privacy (P5)

### Public vs. Private Dashboard Legibility

* **Observation:** P5 Tier A plans to write markdown to the `.github` repository profile or a pinned issue showing version status and secret-expiry countdowns.
* **Potential Issue:** If these repositories are public, publishing a dashboard that surfaces secret names, precise expiration dates, and internal CI pass rates/durations might expose sensitive operations or operational metadata to the public.
* **Suggestion:** Ensure the dashboard only displays non-sensitive metadata (e.g., names like "VS Code Marketplace Token" with coarse countdowns rather than precise API parameters) and verify that no internal gateway paths or environments are exposed.

---

## Disposition

Recorded 2026-07-23 against design revision 2. Claims above are left **as
written**; this section records what happened to each and why. Verification
commands are named so the reasoning can be re-checked rather than trusted.

| # | Item | Disposition | Landed in |
| --- | --- | --- | --- |
| 1 | `secrets: inherit` / reusable-workflow leakage | **Fixed, reframed** | Design constraints |
| 2a | Cascade idempotency | **Fixed** | P2 §3 |
| 2a | Cycle risk / rate-limiting | **Rejected** | P2 §3 (DAG note) |
| 2b | Auto-merge bypasses I2 | **Split** — I2 linkage rejected, merge question adopted | Non-goals + Open decision 4 |
| 3 | Rulesets as code | **Fixed**, scoped to script + drift gate | P1 |
| 4 | Cross-repo reusable dev loop | **Fixed** | Design constraints |
| 5 | Dashboard privacy | **Split** — secret-name framing rejected, private-repo leak accepted, and a follow-up found the inventory itself incomplete | P5 |

### On item 1 — right conclusion, wrong reasoning

`grep -rn "secrets: inherit" .github/workflows/` returns nothing: the org does
not use inheritance anywhere, so the described exposure does not exist today. The
suggestion is still adopted as a forward constraint, but for a different and
stronger reason — an explicitly mapped secret that is absent fails **loudly** at
the call site, while an inherited one that never arrives fails **silently**. That
silent mode is not hypothetical: it is how `CODECOV_TOKEN` was broken long enough
to be retired rather than rotated.

The fork half of the concern is largely handled by the platform: `pull_request`
runs from forks receive no secrets. The genuine sharp edge the review did not
name is `pull_request_target`, which `labeler.yml` and `pr-title-lint.yml` do
use, and which runs with base-repo secret access against PR-authored content.
That is captured as a constraint on what P1 may promote.

**I13, I27 and I29 do not apply.** They govern the gateway's HTTP write
allowlist, outbound share chokepoint, and egress ledger — runtime properties of a
binary on a user's machine, not GitHub Actions. See item 2b.

### On item 2b — a category error worth naming

I2 is `HITL_REQUIRED_BACKING` in `engine/executor.ts`: the consent gate an agent
crosses before a tool call executes on the user's machine. It says nothing about
GitHub merges. "Human-in-the-loop for an agent action" and "human review before a
PR lands" share a word and share nothing else; auto-merging a dependency bump
cannot weaken I2 because I2 is not on that path.

This is recorded in the design's non-goals rather than quietly dropped, because
invariant names used as generic gravitas is precisely the drift the triple rule
exists to prevent — and a spec that let it stand would license the next one.

The underlying question is real and was adopted: **open decision 4**, with a
defensible middle (auto-merge patch bumps only).

### On item 2a — idempotency yes, cycles no

Idempotent PR creation is a genuine requirement and is now specified. Cycle
detection is rejected: the topology is `sdk → client → {Nimbus, vscode}` and
nothing downstream publishes anything upstream consumes, so a cycle is not
reachable by construction. The design states this as a property to *preserve*,
with the trigger for revisiting it (a future back-edge) named explicitly. Adding
hop limits against an unreachable state is machinery that would need its own
tests and would drift.

### On item 3 — the strongest item in the review

Accepted with scope changed. The insight is right and generalizes further than
stated: `nimbus-client`'s missing rulesets *are* the drift, and the 2026-06-23
org settings audit already left UI-only items pending. Fixing it by hand fixes
one repo once. Checked-in ruleset config plus a scheduled divergence check turns
it into a gated property, which is what the operating principle requires.

Terraform is rejected as disproportionate — nine repos, no existing state
backend, solo maintainer, and it breaches the Actions-only infra tier the program
committed to. A `gh api` script in `.github` reaches the same guarantee.

### On item 5 — wrong risk, real risk underneath, and a third one neither of us saw

Secret **names** are already public regardless of `ci-secrets.md`:
`grep -rhoE "secrets\.[A-Z_]+" .github/workflows/` yields 22 names, and the
workflow files are public. So privatizing the doc buys nothing on the thing it
looks like it protects. CI pass-rates and durations are likewise already public
for public repos via the Actions UI.

The exposure the review pointed at without naming: the `.github` repo is
**public**, and the org's **6** private repos would become publicly enumerable
with commit cadence attached if a dashboard aggregated them there. The adopted
constraint is therefore about **repo-visibility mixing**, not secret names.
(Revision 2 of the design miscounted this as "six private scaffolds plus five
others"; the true split is 12 public / 6 private, corrected in revision 3.)

**A follow-up question — "maybe `ci-secrets.md` is a mistake?" — surfaced the
real defect, which is neither of the above.** The doc claims to be the canonical
inventory of *every* Actions secret the workflows consume, and is missing three:
`SECRET_AUDITOR_CLIENT_ID`, `SECRET_AUDITOR_PRIVATE_KEY` (both
`secret-health.yml`) and `BENCHER_API_KEY` (`_perf.yml`, `_perf-reference.yml`).
The two App credentials belong to the workflow that monitors secret health — the
monitor is absent from the inventory it exists to serve, and
`nimbus-secret-auditor` is installed org-wide with `all` repo selection.

A completeness claim that is false is worse than a public one, because the claim
is what people act on. P5 gains an `audit:secret-inventory` gate asserting the
`grep secrets\.` set equals the documented table. Two narrower trims were also
adopted (coarsen the one precise expiry date; move the repo-secret-versus-
`release`-environment mapping off the public page); token type and scope stay,
as they serve auditors more than attackers. The document is **not** deleted or
privatized — it is why `secret-health.yml` exists, and obscurity is the weakest
control in this stack.

### Not in the review — two gaps found while verifying it

Both are larger than anything above, and both are prior art this program would
otherwise have re-derived:

* [`2026-07-19-github-app-migration-design.md`](./2026-07-19-github-app-migration-design.md)
  is the design of record for `nimbus-release-bot` — sub-project 2 of 4 in the
  org secrets-management program. P2(b) extends it rather than reinventing it,
  and its finding that an org-installed App can only mint tokens for repos inside
  that org is exactly why `VSCE_PAT` is unreachable.
* [`2026-06-20-github-app-design.md`](./2026-06-20-github-app-design.md)
  specifies a first-party PR-check Action posting preflight + DORA verdicts on
  pull requests. It is a Phase 12 product deliverable, but it is a fourth
  reviewer that already exists on paper, and P3 is the natural place to dogfood
  it. Added as open decision 5.
