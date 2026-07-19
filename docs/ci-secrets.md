# CI / Release Secrets

This page is the canonical inventory of every GitHub Actions secret the Nimbus
workflows consume: what each one is for, which workflow reads it, whether it is
required, and exactly how to mint and store it.

All secrets live under **repo Settings → Secrets and variables → Actions**.
Release/publish secrets are scoped to the **`release`** GitHub
[deployment environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
(jobs that read them declare `environment: release`); add those under
**Settings → Environments → release → Environment secrets**. Everything else is
a plain repository secret.

> **Token hygiene.** Fine-grained PATs expire (90 days by default). When a
> release fails with `Bad credentials` from `softprops/action-gh-release`, the
> `RELEASE_PAT` has expired or been revoked — rotate it (see below) and re-run
> the failed job. Prefer the **shortest practical expiry** and the **narrowest
> scope** for every token here; never grant org-wide or `repo`-classic scope
> when a fine-grained per-repo grant works.

---

## Quick reference

| Secret | Required for | Type | Used by |
| --- | --- | --- | --- |
| `RELEASE_PAT` | Publishing GitHub Releases | Fine-grained PAT — Contents: RW | `release.yml`, `release-please.yml` |
| `RELEASE_PLEASE_PAT` | release-please PRs (optional) | Fine-grained PAT — Contents + PRs: RW | `release-please.yml` |
| `GPG_SIGNING_SUBKEY` | Signing Linux artifacts + `SHA256SUMS` | ASCII-armored GPG private subkey | `release.yml` |
| `GPG_PASSPHRASE` | Unlocking the GPG subkey | String | `release.yml` |
| `UPDATER_SIGNING_KEY` | Signing the auto-updater manifest | Ed25519 private key | `release.yml` |
| `WINDOWS_CERT_PFX_BASE64` | Windows code-signing the `.msi` | base64 of a `.pfx` | `release.yml` |
| `WINDOWS_CERT_PASSWORD` | `.pfx` password | String | `release.yml` |
| `APPLE_CERT_P12_BASE64` | macOS signing the `.pkg` | base64 of a `.p12` | `release.yml` |
| `APPLE_CERT_PASSWORD` | `.p12` password | String | `release.yml` |
| `APPLE_TEAM_ID` | macOS signing identity | Apple Team ID | `release.yml` |
| `APPLE_DEVELOPER_ID_APP` | macOS app signing identity | Cert common-name | `release.yml` |
| `APPLE_DEVELOPER_ID_INSTALLER` | macOS installer signing identity | Cert common-name | `release.yml` |
| `APPLE_NOTARY_ID` | Apple notarization | Apple ID e-mail | `release.yml` |
| `APPLE_NOTARY_PASSWORD` | Apple notarization | App-specific password | `release.yml` |
| `PACKAGE_MANAGER_PAT` | Homebrew tap + Scoop bucket pushes | Fine-grained PAT — Contents: RW on the two channel repos | `publish-package-managers.yml` |
| `WINGET_PAT` | winget submission PR | **Classic** PAT — `public_repo` scope | `publish-package-managers.yml` |
| `VSCE_PAT` | VS Code Marketplace publish | Azure DevOps PAT — Marketplace (Manage) | `publish-vscode.yml` |
| `OVSX_PAT` | Open VSX publish | Open VSX token | `publish-vscode.yml` |
| `SONAR_TOKEN` | SonarCloud quality gate (optional) | SonarCloud token | `ci.yml`, `_test-suite.yml`, `release.yml` |
| `CODECOV_TOKEN` | Coverage upload (optional) | Codecov upload token | `_test-suite.yml` |
| `SCORECARD_TOKEN` | OSSF Scorecard (optional) | Fine-grained PAT — read-only | `scorecard.yml` |
| `NIMBUS_CHECKS_TOKEN` | Cross-workflow check runs (optional) | Fine-grained PAT — Checks: RW | `ci.yml`, `_test-suite.yml` |
| `GITHUB_TOKEN` | — | **Automatic**, no action needed | all |

`GITHUB_TOKEN` is injected by Actions automatically; it is never set by hand.
Several optional secrets fall back to `github.token` when unset
(`NIMBUS_CHECKS_TOKEN`, `RELEASE_PLEASE_PAT`) or simply skip their step
(`SONAR_TOKEN`).

---

## Release & GitHub Release publishing (`release` environment)

### `RELEASE_PAT` — **required to ship a release**

Used by the `Create GitHub Release` step (`softprops/action-gh-release`) in
`release.yml` and as the release-please fallback token. `GITHUB_TOKEN` is kept
read-only in that job, so the Release API needs this PAT.

Create it:

1. <https://github.com/settings/personal-access-tokens/new> → **Fine-grained
   token**.
2. **Resource owner:** `nimbus-agent`. **Repository access:** *Only select
   repositories* → `nimbus-agent/Nimbus`.
3. **Repository permissions:** **Contents → Read and write**. (That alone is
   enough to create releases and upload assets.)
4. Set a short expiry, generate, copy the `github_pat_…` value.
5. Store as the **`RELEASE_PAT`** environment secret under
   **Settings → Environments → release**.

> **Rotation:** when the release job logs
> `⚠️ Unexpected error fetching GitHub release for tag …: HttpError: Bad
> credentials`, regenerate this token and re-run the failed
> `Publish GitHub Release` job. The git tag is created by release-please, so a
> re-run after rotation publishes against the existing tag.

### `RELEASE_PLEASE_PAT` — optional

Lets release-please open its release PR with a PAT instead of `GITHUB_TOKEN`
(so the PR can trigger downstream workflows). Fine-grained, `nimbus-agent/Nimbus`
only, **Contents: RW + Pull requests: RW**. Falls back to `RELEASE_PAT`, then
`github.token`, when unset.

### `GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE` — required for Linux signing

Signs the Linux installers and the aggregate `SHA256SUMS`. The public half lives
at `docs/release/SIGNING-KEY.asc`; details in
[`docs/release/signing-keys.md`](./release/signing-keys.md).

- `GPG_SIGNING_SUBKEY`: the **ASCII-armored private subkey**, exported with
  `gpg --armor --export-secret-subkeys <KEYID>!`. Paste the full
  `-----BEGIN PGP PRIVATE KEY BLOCK-----` … block.
- `GPG_PASSPHRASE`: the passphrase that unlocks that subkey.

### `UPDATER_SIGNING_KEY` — required for the auto-updater

Ed25519 private key used by `scripts/sign-ed25519.ts` to sign release artifacts
and the update manifest the desktop/headless updater verifies. Generate with the
repo's keygen helper and paste the private-key body.

### Windows code-signing — `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD`

`WINDOWS_CERT_PFX_BASE64` is the code-signing certificate exported as a `.pfx`
and base64-encoded (`base64 -w0 cert.pfx`); `WINDOWS_CERT_PASSWORD` is its
export password. Consumed by `scripts/sign/sign-windows.ps1`.

### macOS code-signing & notarization — `APPLE_*`

Seven secrets feed the per-arch `.pkg` build/sign/notarize step:

- `APPLE_CERT_P12_BASE64` — Developer ID certs exported as a `.p12`, base64-encoded.
- `APPLE_CERT_PASSWORD` — the `.p12` export password.
- `APPLE_TEAM_ID` — your 10-character Apple Developer Team ID.
- `APPLE_DEVELOPER_ID_APP` — `Developer ID Application: … (TEAMID)` common name.
- `APPLE_DEVELOPER_ID_INSTALLER` — `Developer ID Installer: … (TEAMID)` common name.
- `APPLE_NOTARY_ID` — the Apple ID e-mail used for notarization.
- `APPLE_NOTARY_PASSWORD` — an **app-specific password** for that Apple ID
  (<https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords).

---

## Package-manager channels (`publish-package-managers.yml`)

### `PACKAGE_MANAGER_PAT` — Homebrew tap + Scoop bucket

Pushes the updated formula/manifest to `nimbus-agent/homebrew-tap` and
`nimbus-agent/scoop-bucket`. **Fine-grained** PAT, resource owner
`nimbus-agent`, **both** channel repos selected, **Contents: Read and write**.

### `WINGET_PAT` — winget submission

`wingetcreate` must **fork** `microsoft/winget-pkgs`, push to the fork, and open
a cross-repo PR — which a fine-grained PAT cannot do. This one must be a
**classic** PAT with the **`public_repo`** scope
(<https://github.com/settings/tokens/new>).

---

## VS Code extension (`publish-vscode.yml`, `release` environment)

- `VSCE_PAT` — Azure DevOps Personal Access Token for the `nimbus-agent`
  publisher with the **Marketplace → Manage** scope
  (<https://dev.azure.com> → User settings → Personal access tokens).
- `OVSX_PAT` — Open VSX Registry token for the `nimbus-agent` namespace
  (<https://open-vsx.org/user-settings/tokens>).

Neither touches the GitHub repo.

---

## npm packages

`@nimbus-dev/sdk` and `@nimbus-dev/client` are no longer published from this
monorepo — both were extracted to their own standalone repos
([nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk),
[nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client))
and each publishes to npm via release-please + an OIDC trusted publisher —
no `NPM_TOKEN` involved, here or there.

---

## CI quality, coverage & supply-chain (mostly optional)

- `SONAR_TOKEN` — SonarCloud analysis token. When unset the SonarQube step is
  silently skipped. Generate under your SonarCloud account → Security.
- `CODECOV_TOKEN` — Codecov upload token (<https://app.codecov.io> → repo
  settings). Coverage still computes locally without it; only the upload needs it.
- `SCORECARD_TOKEN` — read-only fine-grained PAT used by the OSSF Scorecard
  workflow to read branch-protection metadata.
- `NIMBUS_CHECKS_TOKEN` — optional fine-grained PAT with **Checks: Read and
  write**, so one workflow can publish check runs attributed to another. Falls
  back to `github.token` when unset.

---

## Verifying after a change

After rotating or adding a secret, re-run the affected workflow from the Actions
tab (**Re-run failed jobs** for a failed release). For the release path
specifically, the `Require release PAT` / `Require PACKAGE_MANAGER_PAT` /
`Require WINGET_PAT` guard steps fail fast with an actionable message when a
required secret is missing, so a green guard step confirms the secret is at
least present (it does not prove the token is unexpired — a valid-but-expired
token still passes the guard and fails later at the API call).

---

## Release-health monitor

Two independent mechanisms watch the release pipeline's credential and asset
health so a broken release doesn't sit undiscovered until the next tag push:

### `secret-health.yml` — proactive credential/cert audit

Runs on a **weekly cron** (`0 9 * * 1`, Mondays 09:00 UTC) and is also
`workflow_dispatch`-able with a `threshold_days` input (default `21`) that
controls how far ahead of expiry a certificate is flagged. It checks:

- **Six PATs**: `RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`,
  `WINGET_PAT`, `NIMBUS_CHECKS_TOKEN`, `SCORECARD_TOKEN` — each probed live
  against the GitHub API for basic validity/permissions.
- **Three certificate/signing-credential pairs**: the GPG signing subkey
  (`GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE`), the Windows code-signing cert
  (`WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD`), and the Apple
  Developer ID cert (`APPLE_CERT_P12_BASE64` + `APPLE_CERT_PASSWORD`) —
  decoded and checked for upcoming expiry against `threshold_days`.

> **Caveat — PAT dead/alive is not the same as PAT correct.** A live probe
> only proves the token authenticates and has *some* permission; it does not
> exercise the exact scope combination a release run needs (e.g. `RELEASE_PAT`
> passing the health probe still says nothing about whether it retains
> `Contents: Read and write` on this specific repo). Treat a green run as
> "not yet expired," not as a release dry-run.

Findings are filed as a single, de-duped **`release-health`** GitHub issue
(opened or updated in place per run, not re-created every week) — see
`scripts/release/open-health-issue.ts`.

**Responding to an alert:** rotate the flagged secret using the per-secret
runbook earlier in this document, confirm the new value is stored under the
correct scope (repo secret vs. the `release` environment), then close the
`release-health` issue (or just re-run `secret-health.yml` via
`workflow_dispatch` — a clean run auto-resolves it on the next scheduled
pass).

### `release.yml` — reactive asset gate + failure alert

Two additional checks live directly in the release pipeline, both wired in
`.github/workflows/release.yml`:

- **Asset-verify step** (`Verify release assets are complete`, in
  `publish-release`, immediately after `Create GitHub Release`): runs
  `scripts/release/verify-release-assets.ts` against the just-published
  GitHub Release to confirm every expected artifact (binaries, installers,
  archives, SBOM, `SHA256SUMS` + signature) actually landed. This step reads
  the release via `github.token`, so `publish-release` stays `contents: read`
  — no elevated permission is added for the check itself.
- **`alert-on-failure` job**: a separate top-level job that `needs` the build
  - publish jobs and runs only `if: failure()` (never `always()` — a fully
  green release must not open an issue). On trigger it files/updates the same
  de-duped `release-health` issue via `scripts/release/open-health-issue.ts`,
  linking back to the failed run.

Local dry-run aliases: `bun run release:verify-assets` and
`bun run release:secret-health` (see `package.json`) let you exercise either
script by hand with the right env vars set locally, without waiting for the
scheduled/tag-triggered workflow.
