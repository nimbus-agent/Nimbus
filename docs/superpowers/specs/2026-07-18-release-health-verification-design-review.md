# Design Review — Release-Health Verification & Secret-Health Monitor

**Date:** 2026-07-18
**Target:** [2026-07-18-release-health-verification-design.md](./2026-07-18-release-health-verification-design.md)

## Open Questions & Suggestions

### 1. PAT Scope/Permission Verification vs. Simple Validity
* **Problem:** Probing a PAT via `GET /rate_limit` only checks if the token is valid and active (alive). It does not verify if the token possesses the necessary scopes or fine-grained permissions required to perform release operations (such as write access to repository contents, packages, deployments, and issues). A PAT could be "alive" but have had its permissions revoked or reduced.
* **Suggestion:** 
  * For classic PATs, inspect the `X-OAuth-Scopes` header returned in the API response to verify the required scopes are present.
  * For fine-grained PATs, perform a lightweight check (e.g., check permissions on the target repository using the repo metadata API or verify collaborator permissions) to ensure the token has write/push capabilities on the specific target repository rather than just checking global token validity.

### 2. Preventing Secret Leakage in Actions Logs
* **Problem:** When checking the expiration of keys/certificates (`GPG_SIGNING_SUBKEY`, `WINDOWS_CERT_PFX_BASE64`, `APPLE_CERT_P12_BASE64`), invoking CLI tools like `gpg` or `openssl` using standard command-line arguments (e.g. passing passwords directly in the command string) poses a risk of exposing credentials in runner logs or process lists.
* **Suggestion:** Never pass sensitive passphrases or base64 payloads as command-line arguments. Instead, use standard input piping (e.g. `gpg --passphrase-fd 0`) or environment variables natively supported by the tool configs (e.g., `openssl pkcs12 -password env:WINDOWS_CERT_PASSWORD`) to feed credentials securely to external binaries.

### 3. CLI Binary Dependencies and Cross-Platform Reliability
* **Problem:** The monitor script relies on system binaries like `gpg` and `openssl` being available and matching expected output formats. While these are present on `ubuntu-latest`, developers trying to run these scripts locally (as dry-runs) on Windows or macOS might run into missing binaries or command syntax differences.
* **Suggestion:** 
  * Explicitly handle situations where `gpg` or `openssl` commands are missing or fail by capturing their exit codes and reporting the status as `indeterminate` rather than throwing a hard script error.
  * Consider using a lightweight pure-JS/TS PKCS#12 and X.509 library (or standard Bun/Node cryptographic API features) to extract certificate metadata. Parsing certificate expiration dates in JS/TS avoids spawning processes entirely and eliminates platform toolchain dependencies.

### 4. Preventing Issue Notification Spam on Scheduled Runs
* **Problem:** Since the monitor runs weekly, if a certificate enters the "expiring" window (e.g. 15 days remaining) and the corresponding GitHub issue is already open, subsequent weekly runs will run again, detect the expiration, and could repeatedly comment or modify the issue, generating unnecessary noise.
* **Suggestion:** Ensure the issue update helper (`open-health-issue.ts`) tracks state transitions. It should only add a new comment or update the issue if the status changes (e.g., transition from warning/expiring to critical/expired, or if a new credential is found to be unhealthy) rather than spamming a comment on every scheduled run.

### 5. Configurable and Portable Secret Manifests for Satellite Repos
* **Problem:** The script checks a hardcoded list of secrets (e.g., `RELEASE_PAT`, `WINGET_PAT`, `WINDOWS_CERT_PFX_BASE64`). Sibling repositories (satellite repos) will have different release flows (e.g. npm publish, VS Code extension publishing) and will not share the same secret set.
* **Suggestion:** 
  * Make the list of checked secrets dynamic. The monitor can read a configuration file (like a JSON/TOML manifest or a specific config object) or determine what to check based on which environment variables are present, rather than hardcoding the list.
  * Ensure the repo name is retrieved dynamically from `process.env.GITHUB_REPOSITORY` in all scripts instead of hardcoding `nimbus-agent/Nimbus`.

## Alignment with Invariants

* **Credentials Handling (Non-Negotiable 3):** The design correctly avoids storing plaintext credentials in the source code or local files. Secrets are managed natively in GitHub Repo/Environment secrets and accessed only within the secure, ephemeral environment of the runner.
* **Consent Gates / Local Invariants:** Since these scripts run entirely within the remote CI/CD environment and do not run on the client or interact with the local Gateway databases directly, they do not violate any local security invariants (such as I29, I12, etc.).
