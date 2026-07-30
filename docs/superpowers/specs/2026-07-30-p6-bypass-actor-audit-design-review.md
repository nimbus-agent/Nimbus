# Design Review: Bypass-actor audit

This document contains a design review of the [2026-07-30-p6-bypass-actor-audit-design.md](./2026-07-30-p6-bypass-actor-audit-design.md) specification, detailing open questions, suggestions, and potential improvements.

---

## 1. Open Questions

### 1.1. Portability of Actor IDs (Forks, Test Orgs)

The normalization section details comparing an order-independent set of `${actor_type}:${actor_id ?? "null"}:${bypass_mode}` triples:
> Comparison is therefore an order-independent set of `${actor_type}:${actor_id ?? "null"}:${bypass_mode}` triples.

* **The Question**: If a team or user is added as a bypass actor, their `actor_id` (e.g., the team ID or user ID) is organization-specific. If the project/configuration is forked or audited in a test/staging GitHub organization, these IDs will differ from the production Nimbus org. How will the design handle environments where the IDs are different, or are we assuming only org-wide actors like `OrganizationAdmin` (which have no specific `actor_id`) will be used?
* **Impact**: If a team bypass is ever declared, the audit will fail in any non-production environment/fork if the ID is hardcoded, or it will require environment-dependent config mappings.
* **Suggestion**: If user or team actors are permitted, allow wildcard matching for `actor_id` in the declared config (e.g., comparing only `actor_type` and `bypass_mode` if `actor_id` is specified as `*` or omitted in the declared ruleset JSON), or specify that only org-level roles (like `OrganizationAdmin`, which have a null `actor_id` across all orgs) are supported.

### 1.2. Handling of Reachability / Failures on Renamed or Archived Repositories

* **The Question**: If a repository listed in `repos` is archived, renamed, or temporarily deleted, how does `audit:bypass-actors` (owner-run) handle the failure to resolve the ruleset?
* **Impact**: If it exits with `indeterminate` (fail-soft), it shouldn't block the ability to generate a new attestation for the remaining healthy repositories, or conversely, it shouldn't allow bypass changes on the healthy repositories to go unnoticed.
* **Suggestion**: Clarify how `decideExit` behaves under `--attest`. If one repo out of five is unreachable, `--attest` must not write a new attestation file, as it cannot verify the complete state. The tool should exit 1 (or indeterminate) and refuse to write the attestation.

### 1.3. Timezone and Clock Skew in Attestation Grace Checks

* **The Question**: When calculating if `attested_at` is within the grace window, how do we protect against local system timezone differences or clock skew?
* **Impact**: If the attestation is done on a machine with a clock set in the future or a different local time offset, parsing and comparison might lead to false green or false red states.
* **Suggestion**: Mandate ISO 8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`) for `attested_at` and enforce UTC-only arithmetic (e.g., comparing millisecond timestamps relative to `Date.now()`) to compute the elapsed duration.

---

## 2. Improvements & Suggestions

### 2.1. Fallback for `attested_by` Capture

The specification states:
> `attested_by` comes from `gh api user --jq .login`

* **The Risk**: If `gh` is authenticated using a token that lacks permission to query the current user endpoint, or if the API call temporarily fails or is rate-limited, the `--attest` command might fail to generate the attestation file entirely.
* **Improvement**: If `gh api user` fails, fallback to extracting the operator's identity via `git config user.name` or `git config user.email`, or environment variables (e.g., `USER`, `USERNAME`), so the attestation can still be successfully generated.

### 2.2. Directory Autocreation for Attestation File

* **Improvement**: Ensure that the target directory `docs/structure-audit/` is automatically created (if it doesn't already exist) before attempting to write `docs/structure-audit/bypass-actors-attestation.json` when the `--attest` flag is run.

### 2.3. Structural Schema Validation for Declared Bypass Intent

* **Improvement**: In the unit tests or in the config validator, assert that `bypass_mode` only takes valid values allowed by GitHub Ruleset schemas (e.g., `"always"`, `"pull_request"`). This prevents typos in `general-branch.json` (such as `"alway"`) from passing validation but failing or drifting at run time.
