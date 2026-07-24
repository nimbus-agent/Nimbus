# Design Review: P6a — Access & Contribution Model (core) Design

This document reviews [2026-07-24-p6a-access-contribution-model-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/org-infra-program/docs/superpowers/specs/2026-07-24-p6a-access-contribution-model-design.md) and captures suggestions, open questions, and potential improvements.

---

## 1. Automated Audit Robustness

### Archived Repositories Handling
- **Observation:** Over time, orgs archive old or deprecated repositories. 
- **Question:** Does the `check-team-reachability` audit retrieve and flag archived repositories? Typically, team write/maintain access is less relevant for archived repos. We should clarify if `findUnreachable` should automatically ignore archived repos or require them to be explicitly allowlisted.

### Pagination on GitHub API Calls
- **Observation:** `GET /orgs/nimbus-agent/repos` and team repo fetches are paginated by default (default limit is 30).
- **Suggestion:** Although the org currently has 18 repositories, to make the audit future-proof, the script should either:
  - Explicitly request `per_page=100` to cover growth up to 100 repos.
  - Implement basic pagination traversal (handling `Link` headers or page increments) to avoid silently truncating repo lists once the org exceeds 30 repositories.

---

## 2. CI Visibility & Diagnostics

### Fail-Soft Visibility
- **Observation:** The scripts will fail-soft (exit 0) when `gh` is unavailable or unauthorized.
- **Question:** If the App token permissions are revoked or modified in the future, how will maintainers notice that the sweeps are skipping rather than actively validating?
- **Suggestion:** When skipping due to auth/network failures, the script should print a highly visible diagnostic warning (e.g., using GitHub Actions' `::warning::` syntax) so that the skip is highlighted in the action runs, rather than blending in as a silent green pass.

---

## 3. Bypass-Actor Audits

### Local Manual Trigger via CLI
- **Observation:** The bypass-actor audit is deferred because it requires org-owner credentials rather than the App token.
- **Suggestion:** Instead of deferring it entirely, we could write the audit logic today but restrict its execution to local runs via the CLI (e.g., `nimbus audit:bypass-actors` or similar script). The script would read a user-provided PAT (personal access token) from the local environment, allowing the org owner to run it manually until an automated out-of-band solution is built.

---

## 4. Configuration & Allowlists

### Exemptions Allowlist Location
- **Observation:** The spec mentions a checked-in "exemption allowlist" for the reachability gate.
- **Question:** Where will this allowlist live? 
- **Suggestion:** It would be cleanest to keep it in `.github/team-reachability-exemptions.json` or as an attribute in a unified settings file (e.g., inside `.github/org-settings.json` under an `exempt_repos` key) to keep configuration consolidated.
