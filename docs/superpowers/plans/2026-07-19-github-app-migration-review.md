# Implementation Plan Review — GitHub App Migration

**Date:** 2026-07-19
**Target:** [2026-07-19-github-app-migration.md](./2026-07-19-github-app-migration.md)

## Open Questions & Suggestions

### 1. Scoping Pull Requests Permission in the Secret-Health Monitor

* **Problem:** In Task 5 Step 1, the `secret-health.yml` mint step is configured with:

  ```yaml
  repositories: Nimbus, homebrew-tap, scoop-bucket, linux-repo
  permission-contents: write
  ```

  However, the `release-please.yml` workflow requires both `contents: write` and `pull-requests: write`. If the organization administrator accidentally revokes or downgrades the App's `pull-requests` permission while keeping `contents: write` intact, the monitor's token minting check will succeed (status `success`), but the actual release-please workflow will fail.
* **Suggestion:** Configure the health check mint step to request both permissions to verify complete functional health:

  ```yaml
  permission-contents: write
  permission-pull-requests: write
  ```

### 2. Handling Missing Secrets / Skipped Minting in the Monitor

* **Problem:** In Task 5 Step 3, the `classifyAppMint` helper maps `"success"` to `"ok"`, `"failure"` to `"dead"`, and anything else to `"indeterminate"`.
  If the repository secrets (`RELEASE_BOT_APP_ID`, `RELEASE_BOT_PRIVATE_KEY`) are deleted or missing, the `create-github-app-token` action step may be skipped by the runner (or fail depending on configuration). If it is skipped, the step outcome might be `"skipped"`, which maps to `"indeterminate"` under this classification. An `"indeterminate"` status does not trigger a hard failure, which could allow a completely unconfigured/missing App credential to go unnoticed without raising a critical alert.
* **Suggestion:** Map `"skipped"` or undefined outcomes explicitly to `"dead"` or a status that triggers a warning/failure, ensuring that missing/unset secrets trigger a notification to the maintainers.

### 3. Git Author Config for Bot Commits

* **Problem:** In Tasks 3 and 4, the workflows clone external repos (`homebrew-tap`, `scoop-bucket`, `linux-repo`) and push changes. The existing workflows configure git author info (email and username) for local commits. When migrating from PATs (where commits appear under the PAT owner's account) to the GitHub App, pushing commits without adjusting the git author config will still work, but attribution might be inconsistent.
* **Suggestion:** When the App token is used for commits/pushes, update the git config step in those jobs to use the official GitHub App bot user details:
  * **User Name:** `nimbus-release-bot[bot]`
  * **User Email:** `[app-id]+nimbus-release-bot[bot]@users.noreply.github.com` (or the default `github-actions[bot] <github-actions[bot]@users.noreply.github.com>`).

### 4. Verification of Pinned Action SHA

* **Problem:** The plan leaves the action SHA as a placeholder `<APP_TOKEN_SHA>` to be resolved dynamically during execution.
* **Suggestion:** Resolve the SHA of `actions/create-github-app-token@v2` (e.g. `v2.1.0` or latest stable) using the `gh` command or looking it up, and hardcode it directly in the implementation plan to make the steps fully deterministic for the runner.

## Alignment with Invariants

* **No Plaintext Secrets (I12/I18):** Using the GitHub App private key via Actions Secrets aligns perfectly with our security standards.
* **Staged Deletion / Rollback Gate:** The plan's emphasis on staging the PAT secret deletion as a manual post-release step ensures a safe rollback path if any unseen edge case arises.
