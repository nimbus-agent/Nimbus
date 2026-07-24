# Design Review: CLA — Contributor License Agreement Design

This document reviews [2026-07-24-cla-design.md](./2026-07-24-cla-design.md) and notes questions, suggestions, and improvements.

---

## 1. Concurrency & Race Conditions in Shared Store

### Concurrency Conflicts on Push

- **Observation:** With 7 active public repositories concurrently updating a single JSON file (`signatures/version1/cla.json` on the `cla-signatures` branch of `.github`), there is a risk of git push conflicts (e.g., `non-fast-forward` errors) if multiple contributors sign CLAs or comment at similar times across repos.
- **Suggestion:** Verify how `contributor-assistant/github-action` handles concurrent push retries. We should configure the Action with retry parameters (e.g. `retries` or backoff) if supported, or document how conflicts are mitigated to prevent workflow run failures.

### Branch Protection Rules

- **Question:** How will branch protection rules be configured on the `.github` repository for the `cla-signatures` branch? Since the GitHub App needs to push directly to it, we must ensure it bypasses standard pull request requirements or approval checks without weakening the security of the `main` branch.

---

## 2. GitHub App Token Distribution & Secrets Scoping

### Scoping of the App Token

- **Observation:** The workflow runs in all 7 repos and needs a token to write to `.github`. The design proposes using a GitHub App token scoped to `contents: write` on the `.github` repo only.
- **Question:** How is this App Private Key shared securely? Since organization secrets are available to workflows triggered by `pull_request_target` even from forks, we must confirm that the App Private Key secret is restricted to only execute within the specific workflows and cannot be exposed by custom pull request triggers.
- **Suggestion:** Explicitly document the recommended configuration for the organization secret, ensuring it is restricted to the specific repositories requiring it.

---

## 3. Workflow Security & Execution Safeguards

### `pull_request_target` Isolation

- **Observation:** The use of `pull_request_target` executes in the context of the base branch but has write permissions and access to secrets.
- **Important Rule:** Ensure that the `.github/workflows/cla.yml` configuration across all 7 repositories never checks out the PR head branch (`github.event.pull_request.head.sha`) or runs package scripts (such as `npm run` or `bun run`) which could allow malicious code to execute inside the privileged runner.

---

## 4. Multi-Contributor Commit Verification

### Verification of All Commit Authors

- **Observation:** Pull requests frequently contain commits from multiple different authors or contributors (e.g., co-authored-by commits or cherry-picked work).
- **Question:** Does the `contributor-assistant/github-action` validate and require signatures for *all* unique commit authors and committers present in the PR history, or does it only validate the PR author/sender?
- **Suggestion:** Configure the action to check all commit authors to prevent unsigned code from being merged under a signed PR author's name.

---

## 5. Drift Prevention & Allowlist Management

### Centralized Allowlist

- **Observation:** The allowlist of org members and bots (e.g., `dependabot[bot]`) is specified inside the `.github/workflows/cla.yml` files in all 7 repositories.
- **Suggestion:** Rather than duplicating this allowlist in 7 distinct files, check if `contributor-assistant/github-action` supports pointing to a central config/allowlist file (e.g., inside `.github`) or dynamically querying organization membership via the GitHub API to prevent configuration drift.

---

## 6. Versioning & Re-signing Operations

### Standard Operating Procedure (SOP) for Bumping versions

- **Observation:** Bumping the CLA version (e.g., `version1` -> `version2`) requires re-signing by all contributors.
- **Suggestion:** Include a brief guide or SOP in the spec on how to coordinate a version bump (e.g. updating the workflow files across all 7 repos concurrently to avoid state mismatches where a contributor is prompt-blocked on one repo but allowed on another).
