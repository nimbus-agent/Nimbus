# Implementation Plan Review — Release-Health Verification & Secret-Health Monitor

**Date:** 2026-07-18
**Target:** [2026-07-18-release-health-verification.md](./2026-07-18-release-health-verification.md)

## Open Questions & Suggestions

### 1. Repository Permissions Check Using the Tested PAT

* **Problem:** In Task 4 (`check-secret-health.ts`), the strategy `repo-write` calls `deps.api.getRepoPermissions(p.strategy.targetRepo)`. However, looking at the `GitHubApi` interface in Task 1, `getRepoPermissions` only accepts `ownerRepo` and uses the default `opts.token` (which is the workflow's default `GITHUB_TOKEN`). This means it will check the push permissions of the runner's ephemeral token rather than the permissions of the specific `RELEASE_PAT` or `RELEASE_PLEASE_PAT` being tested.
* **Suggestion:** Update the `getRepoPermissions` method signature in `GitHubApi` to accept an optional `token` override, or pass the specific token to a newly designed API function:

  ```ts
  getRepoPermissions(ownerRepo: string, token?: string): Promise<RepoPerms | { status: number }>;
  ```

  This ensures that when verifying `repo-write` permissions, the API call is authenticated using the PAT under test.

### 2. Robust Date Parsing and Validation for Certificate Outputs

* **Problem:** Spawning `openssl` or `gpg` to read expiration dates returns plain text string outputs (e.g., `notAfter=Jul 18 12:00:00 2028 GMT` or colon-separated GPG fields). Simply passing these strings to `new Date()` can result in `Invalid Date` if the binary output is malformed, localized, or if the process exits unexpectedly.
* **Suggestion:** Implement a robust date parsing wrapper in `check-secret-health.ts`:

  ```ts
  function safeParseDate(dateStr: string): Date | null {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  ```

  Additionally, ensure that the GPG output parser handles the various subkey status codes correctly and checks for the specific signature subkey expiration field (`key` or `sub` record, field index 9 in colon-delimited format).

### 3. Temp File Cleanup on Failure

* **Problem:** In Task 4 step 5, base64 payloads of certificates are decoded and written to temporary `.p12` or `.pfx` files under `$RUNNER_TEMP`. If the validation or decryption throws an error before the end of the method, these sensitive temporary files might remain on disk.
* **Suggestion:** Wrap all temporary file operations and external tool spawns in `try...finally` blocks to guarantee that any temporary files written to `$RUNNER_TEMP` are immediately deleted from disk before the function returns or propagates the error.

### 4. Handling Conditional/Skipped Jobs in `alert-on-failure`

* **Problem:** The `alert-on-failure` job specifies a hard dependency on multiple build jobs (`build-gateway`, `build-cli`, `build-msi`, `build-pkg`, `publish-release`). If any of these jobs are skipped (due to conditional expressions like OS targets or prerelease tags), the behavior of `if: ${{ failure() }}` should be carefully verified.
* **Suggestion:** In GitHub Actions, skipped needed jobs are treated as successful. The `if: ${{ failure() }}` check will correctly trigger if *any* of the active, non-skipped needed jobs fail. However, we should explicitly check if the configuration needs `always()` context handling to make sure skipped jobs don't block the alert. The current `if: ${{ failure() }}` is correct, but adding a brief verification test or comment clarifying this behavior for future developers is recommended.

## Alignment with Invariants

* **Least Privilege / Data Flow:** The deviation noted in the plan (having the `publish-release` job remain `contents: read` and delegating the issue filing to the `alert-on-failure` job with `issues: write` permissions) is a great security improvement that minimizes permissions on the job handling the main release assets.
* **No Plaintext Passwords (I12/I18):** spawner parameters in the cert decoders must use stdin/env variables instead of shell arguments, which is correctly captured in the plan's global constraints.
