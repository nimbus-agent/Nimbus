# Design Review — GitHub App Migration

**Date:** 2026-07-19
**Target:** [2026-07-19-github-app-migration-design.md](./2026-07-19-github-app-migration-design.md)

## Open Questions & Suggestions

### 1. Verification Logic for App Installation & Scopes in `check-secret-health.ts`

* **Problem:** In the PAT era, the health check validated scope existence via headers. In the App-token era, minting a token using the App ID and Private Key proves that the credentials are valid, but it does not guarantee that the App is still *installed* on all the target repositories (`homebrew-tap`, `scoop-bucket`, `linux-repo`), or that the installation still has the correct permissions (e.g., someone could modify the App's permissions in the organization settings).
* **Suggestion:**
  * In the updated `check-secret-health.ts`, don't just assert a successful mint of a generic token.
  * Explicitly attempt to mint a token requesting access to each of the target repositories (e.g., specifying `repositories: ["Nimbus", "homebrew-tap", "scoop-bucket", "linux-repo"]`).
  * If the API returns an error for any of the repositories (e.g., due to the App being uninstalled or permission downgraded), report it as a health failure for that specific target.

### 2. Implementation of Token Minting in the Bun Script

* **Problem:** To mint an installation token programmatically in the secret health check script (`check-secret-health.ts`), the script must construct and sign a JWT using the RS256 algorithm with the PEM private key.
* **Suggestion:**
  * Avoid adding heavy dependencies like `jsonwebtoken` or `@octokit/auth-app` if possible.
  * Utilize Bun's native Web Crypto API (`crypto.subtle`) or Node's `crypto` module to import the private key and sign the RS256 JWT natively.
  * Clearly document the cryptographic utility helper that does this to keep the script lightweight.

### 3. Branch Protection Rule Bypasses for the App

* **Problem:** If `main` or the release branches on `Nimbus`, `homebrew-tap`, `scoop-bucket`, or `linux-repo` have branch protection rules (e.g., requiring pull requests, requiring status checks, or restricting pushes to specific actors), direct pushes from the GitHub Actions workflow using the App token will fail.
* **Suggestion:**
  * Add a step to the **Human-only steps (runbook)** to update the branch protection rules for the target repositories, allowing the "Nimbus Release Bot" App to bypass pull request requirements or push restrictions where necessary.

### 4. Downstream Workflow Triggers and Action Permissions

* **Problem:** Pushing commits or tags with a GitHub App token triggers downstream workflows, which is the desired behavior for triggering `release.yml` on a tag push. However, some repositories restrict Actions permissions (e.g., "Allow all actions and reusable workflows" vs "Allow select actions").
* **Suggestion:**
  * Ensure the target repositories have action permissions enabled so that commits/tags pushed by the App actually trigger the workflows as expected.
  * Verify if `Pages` or `Deployments` permissions are needed for the `publish-linux-repo.yml` workflow, as Page deployments sometimes require additional `pages: write` / `id-token: write` scopes.

### 5. GPG/Commit Signing for App Commits

* **Problem:** When the App pushes commits to repositories (such as update commits to `homebrew-tap` or `scoop-bucket`), GitHub will show them as unverified unless they are signed.
* **Suggestion:**
  * GitHub Apps can sign commits using GitHub's web-flow signing key if the commits are made via the GitHub API. However, if using standard `git push`, we may want to either document that these automated commits will appear unsigned, or configure a signing subkey for the bot. Given the complexity, documenting that App-pushed commits are unsigned (or verifying if GitHub's automatic App-attribution signature is applied) is recommended.

## Alignment with Invariants

* **Credentials Handling (Non-Negotiable 3):** The migration away from personal tokens to short-lived App tokens significantly improves security. The private key `RELEASE_BOT_PRIVATE_KEY` remains safely stored in the `Nimbus` repo Actions secrets and is never exposed in logs or scripts.
* **HITL Consent (Non-Negotiable 2 / I2):** The App token is strictly confined to CI/CD workflows and is used to automate publication after the owner has already run the release process. It does not bypass any local execution gates or user consent mechanisms on the client.
