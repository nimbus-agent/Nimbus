# Credential Rotation & Hardening Design Review — Feedback, Suggestions, and Open Questions

This document reviews the design specification for **Credential Rotation & Hardening** ([2026-07-20-credential-rotation-and-hardening-design.md](./2026-07-20-credential-rotation-and-hardening-design.md)).

---

## 1. Open Questions & Technical Clarifications

### Q1.1: Token Age and `updated_at` Refresh Scenarios

* **Observation:** The spec notes that `updated_at` represents when the secret was last set, not when it was issued. However, if a user updates an existing secret to rotationally *extend* its life (or if GitHub re-presents it), the updated timestamp resets.
* **Question:** Is there any way to cross-reference GitHub's audit logs or API to fetch actual credential metadata (like PAT creation date)? Or are we purely constrained to the GitHub API's `/actions/secrets` endpoint? If the latter is true, how do we distinguish between a secret that has been *re-saved* vs one that has been *rotated* to a new value?

### Q1.2: Scope of Repository Secrets (`secrets:read` vs. `actions:secrets:read`)

* **Observation:** The spec lists `secrets:read` and `organization_secrets:read` permissions for the App.
* **Question:** Under GitHub App permissions, secrets read permissions only allow reading the names and metadata of repository/org-level Action secrets. However, do these cover Dependabot secrets or Codespaces secrets? If there are secrets configured for Dependabot or Codespaces in the Nimbus repository ecosystem, will the auditor scan those as well, or are we strictly targeting GitHub Actions secrets?

### Q1.3: Verification of `security_and_analysis` in Gap 1

* **Observation:** The design suggests probing whether the read-only auditor app can access `security_and_analysis` fields with its current `metadata:read` permission.
* **Question:** If the auditor *cannot* read this field, what is the fallback mechanism? Will we add a warning rule pointing to a manual inspection, or will we rely on a developer manually validating this field during releases?

---

## 2. Suggested Improvements & Refinements

### Suggestion 2.1: Implement a Post-Rotation Validity Validator

* **Context:** The system alerts a human that rotation is needed, but the human rotates it manually.
* **Suggestion:** We should add a helper script or a subcommand to the auditor (e.g., `nimbus credentials check-validity`) that attempts to run a non-destructive query using the rotated token to ensure the new token works before the old one is revoked (similar to the logic that classification probes run).

### Suggestion 2.2: Add Tracking of Secret Consumed By Locations

* **Context:** `consumedBy` in `CredentialEntry` records workflow paths where secrets are used.
* **Suggestion:** We can automate a secondary static check that parses the YAML files in `.github/workflows/` of all checked out repositories to ensure that any secret defined as `required` is actually referenced in at least one workflow, or matches the `consumedBy` list. This prevents `consumedBy` list from drifting over time.

### Suggestion 2.3: Verification and Sandboxing of Auditor Private Key

* **Context:** The auditor private key itself is a highly sensitive credential that is stored on the CI/runner.
* **Suggestion:** Ensure the auditor app is scoped strictly to read-only metadata and has **no permissions** on private repositories where code or deployment secrets reside.

---

## Resolutions (2026-07-20)

Two items were settled by querying the live API rather than by reasoning.

### Q1.1 — Cross-referencing real credential issue dates · **ANSWERED, limitation accepted**

There is no better source, and this was checked rather than assumed. A PAT's true
issue date is not exposed to consumers by any API — only the token's owner sees it
in their own settings. The organization audit log would record secret-set events,
but it requires GitHub Enterprise Cloud; this org is on the **Free** plan and
`GET /orgs/nimbus-agent/audit-log` returns **404** (verified 2026-07-20).

So the answer to "are we purely constrained to `/actions/secrets`?" is **yes**, and
re-saved cannot be distinguished from rotated. Spec now states this as an accepted
limitation with the reason it is tolerable: the warn is an instruction to *go
look*, not an assertion of staleness, and the failure direction is a missed
reminder — never a false all-clear about validity, which the independent liveness
probes still cover.

### Q1.2 — Dependabot / Codespaces secret coverage · **REAL GAP, FIXED**

The strongest item in the review. `secrets:read` covers **Actions secrets only**;
Dependabot and Codespaces sit behind separate permissions and endpoints, so the
`undocumented` verdict would have implied a completeness it did not have.

Verified 2026-07-20: **zero** Dependabot secrets at org level and in every repo
checked; zero Codespaces secrets. So the inventory is complete *today* — but it
would silently become incomplete the moment someone added a Dependabot secret,
which is precisely the drift class this design exists to catch.

**Fix:** the auditor also takes `dependabot_secrets: read` and enumerates that
endpoint. Same permission class — read-only, names and timestamps, never values.
**Codespaces is declared out of scope** rather than silently uncovered: the
org endpoint is unavailable on this plan and the count is zero, so the boundary is
stated in the spec and carried as a manual-checklist line.

*This requires one additional permission toggle on the App.*

### Q1.3 — Fallback if `security_and_analysis` is unreadable · **ALREADY SPECIFIED, made explicit**

The spec already defined both branches; the review reading suggests it was not
prominent enough. Now stated as an explicit two-branch fallback, plus the reason
the App is not widened either way: that field needs `administration`, a materially
more dangerous grant than reading secret names, for drift that is rare and
low-velocity.

### Suggestion 2.1 — Post-rotation validity validator · **DEFERRED (tool), ACCEPTED (the lesson)**

The underlying insight is right and is exactly the ordering that cost a reversal in
sub-project 3 — revoking the npm token before configuring package policies killed
the maintainer's own CLI session.

But a new `nimbus credentials check-validity` subcommand duplicates capability that
already exists: the weekly monitor's liveness probes classify credentials
`ok` / `dead` / `not-configured` / `indeterminate`, and can be dispatched on demand.
Building a second path to the same answer adds surface to a program about reducing
it.

**Resolution:** the *rule* — configure-then-revoke, verify the replacement before
revoking — is written into `docs/credential-hygiene.md`, pointing at the existing
monitor. The dedicated command is deferred; if manual dispatch proves awkward in
practice, it can be reconsidered with evidence.

### Suggestion 2.2 — Static validation of `consumedBy` · **ACCEPTED for the monorepo, DECLINED cross-repo**

Correct that a hand-maintained `consumedBy` will drift. A static check now parses
`.github/workflows/**` in this repository and asserts the correspondence in both
directions. It runs in the preflight gate set rather than the weekly monitor —
it needs no credentials and should fail at PR time.

Extending it to the other 17 repos is **declined on a permissions argument**: it
would require `contents: read`, the exact permission deliberately withheld to keep
the auditor incapable of reading code. Paying for validation of a documentation
field with a code-read grant across 18 repos is a bad trade. Cross-repo consumer
enumeration stays a one-time manual step, which is all Gap 2 requires.

### Suggestion 2.3 — Sandboxing the auditor · **CONCERN SATISFIED, SUGGESTION DECLINED**

The concern is already met, more strongly than the review assumes: the App holds
**no `contents` permission at all**, so it cannot read source, workflow files, or
deployment configuration in *any* repository, public or private. Its entire reach
is credential names and timestamps.

The specific suggestion — remove the private repos — is **declined**, because it
would defeat the design's main purpose. An undocumented credential in a
low-traffic private repo is *likelier*, not less likely; excluding those repos
would blind the `undocumented` check exactly where it is most needed. The spec now
states the no-`contents` boundary explicitly so this reasoning is not re-litigated.
