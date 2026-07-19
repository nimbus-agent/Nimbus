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

> **Token hygiene.** The release/publish path now authenticates as the
> **Nimbus Release Bot** GitHub App for everything it can (see below) — App
> installation tokens are minted fresh per job and expire in 1 hour, so there
> is no 90-day clock to watch. `WINGET_PAT` is the one remaining human-owned
> classic PAT (it must fork an external repo the App cannot reach); prefer the
> **shortest practical expiry** and the **narrowest scope** for it and for any
> future token added here.

---

## Quick reference

| Secret | Required for | Type | Used by |
| --- | --- | --- | --- |
| `RELEASE_BOT_APP_ID` | Minting Nimbus Release Bot tokens | GitHub App ID | `release.yml`, `release-please.yml`, `publish-package-managers.yml`, `publish-linux-repo.yml`, `secret-health.yml` |
| `RELEASE_BOT_PRIVATE_KEY` | Minting Nimbus Release Bot tokens | GitHub App private key (PEM) | `release.yml`, `release-please.yml`, `publish-package-managers.yml`, `publish-linux-repo.yml`, `secret-health.yml` |
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
(`NIMBUS_CHECKS_TOKEN`) or simply skip their step (`SONAR_TOKEN`).

---

## Release & GitHub Release publishing (`release` environment)

### Nimbus Release Bot (GitHub App) — **required to ship a release**

An org-owned **GitHub App** ("Nimbus Release Bot", installed under
`nimbus-agent`) replaces the three release-scoped PATs this section used to
document (`RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`). Every
job that used to consume one of those PATs now runs a mint step first:

```yaml
- name: Mint release-bot token
  id: app-token
  uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
  with:
    app-id: ${{ secrets.RELEASE_BOT_APP_ID }}
    private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
    owner: nimbus-agent
    repositories: <only the repos this job writes>
    permission-contents: write
    # permission-pull-requests: write   # release-please.yml only
```

and uses `${{ steps.app-token.outputs.token }}` in place of the retired PAT.
Each minted token is an **installation access token**: scoped to exactly the
repos + permissions the `with:` block requests, and it expires in **1 hour**
— there is no 90-day expiry clock to track, unlike a PAT.

- **Two secrets**, both stored as **plain `Nimbus` repository secrets**, not
  scoped to the `release` environment (`release-please.yml` and
  `publish-package-managers.yml`/`publish-linux-repo.yml` mint a token
  without declaring `environment: release`, so an environment-scoped secret
  would be invisible to them). `create-github-app-token`'s `repositories:`
  input mints tokens for any *other* installed repo too, so no org-level or
  per-repo duplicate secrets are needed:
  - `RELEASE_BOT_APP_ID` — the App's numeric ID.
  - `RELEASE_BOT_PRIVATE_KEY` — the App's private key, PEM, generated once
    from the App's settings page.
- **Installed on exactly four repos** (`nimbus-agent` org, *Only select
  repositories*): `Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`. A
  token mint fails for any repo outside this set.
- **Permissions:** `Contents: Read and write` + `Pull requests: Read and
  write`. No organization or account permissions, no webhook — the App can
  push/tag/PR in the four installed repos and nothing else.
- **Who mints it:** `release-please.yml` (contents + pull-requests: write on
  `Nimbus`, replacing the old `RELEASE_PLEASE_PAT` `token:` input),
  `release.yml` (contents: write on `Nimbus`, replacing `RELEASE_PAT` in the
  `Create GitHub Release` step), `publish-package-managers.yml` (contents:
  write on `homebrew-tap` + `scoop-bucket`, replacing `PACKAGE_MANAGER_PAT`
  for the brew/scoop pushes — **`WINGET_PAT` is untouched**, see below), and
  `publish-linux-repo.yml` (contents: write on `linux-repo`, replacing
  `PACKAGE_MANAGER_PAT` for the apt/yum repo + Pages push).
  `secret-health.yml` also mints a token (scoped to all four repos) purely as
  a weekly health probe — see
  [Release-health monitor](#release-health-monitor) below.

> **Rotation:** an App private key doesn't expire on a schedule the way a PAT
> does, but if it's ever compromised or you want to rotate it proactively:
> generate a **new** private key from the App's settings page
> (<https://github.com/organizations/nimbus-agent/settings/apps> → Nimbus
> Release Bot → Generate a private key), replace the
> **`RELEASE_BOT_PRIVATE_KEY`** repo secret with the new PEM, then revoke the
> old key from the same page. No `RELEASE_BOT_APP_ID` change is needed — the
> App ID is stable across key rotations.

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

### Homebrew tap + Scoop bucket — Nimbus Release Bot

Pushes the updated formula/manifest to `nimbus-agent/homebrew-tap` and
`nimbus-agent/scoop-bucket`. Both repos are installed targets of the Nimbus
Release Bot App (see above); the job mints a token scoped to both with
`Contents: Read and write` and uses it in place of the retired
`PACKAGE_MANAGER_PAT`.

### `WINGET_PAT` — winget submission — **stays a classic PAT, on purpose**

`wingetcreate` must **fork `microsoft/winget-pkgs`** (owned by Microsoft, not
`nimbus-agent`), push to that fork, and open a cross-repo PR against it. A
GitHub App installed on the `nimbus-agent` org can only mint tokens for repos
*inside* that org's installation — it has no way to authenticate against an
external org's repo or fork it. So this one credential cannot be migrated to
the App and remains a **classic** PAT with the **`public_repo`** scope
(<https://github.com/settings/tokens/new>). This is a deliberate, documented
exception, not an oversight.

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
specifically:

- The **`Mint release-bot token`** step itself is the guard for
  `RELEASE_BOT_APP_ID` / `RELEASE_BOT_PRIVATE_KEY` — it fails fast if either
  secret is missing, the App isn't installed on the target repo, or the
  requested permission exceeds what the App grants, so there's no separate
  "Require …" step to check.
- The **`Require WINGET_PAT`** guard step still fails fast with an actionable
  message when that secret is missing, so a green guard step confirms the
  PAT is at least present (it does not prove the token is unexpired — a
  valid-but-expired token still passes the guard and fails later at the
  API call).

---

## Release-health monitor

Two independent mechanisms watch the release pipeline's credential and asset
health so a broken release doesn't sit undiscovered until the next tag push:

### `secret-health.yml` — proactive credential/cert audit

Runs on a **weekly cron** (`0 9 * * 1`, Mondays 09:00 UTC) and is also
`workflow_dispatch`-able with a `threshold_days` input (default `21`) that
controls how far ahead of expiry a certificate is flagged. It checks:

- **Nimbus Release Bot App-health check**: the workflow itself mints an App
  token (`Mint release-bot token (health probe)` step, `continue-on-error:
  true`) scoped to **all four** installed repos (`Nimbus`, `homebrew-tap`,
  `scoop-bucket`, `linux-repo`) with `Contents: Read and write` +
  `Pull requests: Read and write` — a superset of what the individual
  release jobs request, so a downgrade of either permission on any repo is
  caught. Its outcome is passed to the script as `APP_MINT_STATUS`,
  which classifies anything other than a clean mint (`failure`, `skipped`, or
  unset) as `dead` so a missing secret, an uninstalled App, or a downgraded
  permission all alert. This deliberately reuses `actions/create-github-app-token`
  rather than reimplementing RS256 JWT signing in the script, and it
  dogfoods the exact mint path the release pipeline depends on.
- **Three remaining PATs**: `WINGET_PAT`, `NIMBUS_CHECKS_TOKEN` (falls back to
  `github.token` when unset), and `SCORECARD_TOKEN` (unset — the Scorecard
  job falls back to `github.token`) — each probed live against the GitHub API
  for basic validity/permissions.
- **Three certificate/signing-credential pairs**: the GPG signing subkey
  (`GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE`), the Windows code-signing cert
  (`WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD`), and the Apple
  Developer ID cert (`APPLE_CERT_P12_BASE64` + `APPLE_CERT_PASSWORD`) —
  decoded and checked for upcoming expiry against `threshold_days`.

> **Caveat — a green probe is not the same as "the real job will work."** A
> live probe only proves the credential authenticates and has *some*
> permission; the App-health check narrows this gap by minting with the same
> repo set + permissions the release jobs use, but it still doesn't run the
> actual publish steps. Treat a green run as "not yet broken," not as a
> release dry-run.

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

---

## GitHub App setup + migration runbook

The four release/publish workflows and the secret-health monitor already
contain the mint steps and reference `RELEASE_BOT_APP_ID` /
`RELEASE_BOT_PRIVATE_KEY` — that part ships in code. What code **cannot** do
is create the App itself or grant it org-admin-gated access; the following
steps are **human-only**, done once, by someone with `nimbus-agent`
org-admin rights:

1. **Create the App.** `nimbus-agent` org → Settings → Developer settings →
   GitHub Apps → New GitHub App. Name it **Nimbus Release Bot**.
2. **Set repository permissions:** `Contents: Read and write` and
   `Pull requests: Read and write`. Grant **no** organization or account
   permissions, and **no** webhook — the App only needs to push commits/tags
   and open PRs in the repos it's installed on.
3. **Install the App** on `nimbus-agent`, *Only select repositories* →
   `Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`. These are exactly
   the four repos the release/publish pipeline writes to.
4. **Generate a private key** from the App's settings page, then add it and
   the App ID as two **plain repository secrets** on `Nimbus` (not
   environment-scoped — see the note above):
   - `RELEASE_BOT_APP_ID`
   - `RELEASE_BOT_PRIVATE_KEY` (the full PEM block)
5. **Allow-list the mint action.** `Nimbus` requires SHA-pinned third-party
   actions, so add
   `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1`
   (`v3.2.0`) to the org's (or repo's) allowed-actions list, or the mint step
   fails closed with an "action not allowed" error before ever reaching the
   App.
6. **Grant the App push access on protected branches, if any.**
   `homebrew-tap`, `scoop-bucket`, and `linux-repo` all receive direct
   `git push`es from the publish workflows (not PRs). If any of those repos'
   default branches has branch protection that requires PRs or restricts
   which actors can push, add the Nimbus Release Bot App to that branch's
   bypass/allowlist. `Nimbus` itself needs no change here — release-please
   opens a PR and `release.yml` only pushes a tag, neither of which is a
   protected-branch commit.
7. **Confirm Actions are enabled** on all four target repos so that an
   App-token-pushed tag actually triggers `release.yml`. This matters because
   App-minted tokens (unlike the default `github.token`) *do* trigger
   downstream workflow runs on push — that's part of why the App is used for
   release-please in the first place — but it only works if Actions isn't
   disabled on the receiving repo. Validate this live on the first real
   release after cutover.
8. **After the first green release, delete the three retired PAT secrets** —
   `RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`. Do this only
   once a full release has gone out end-to-end on the App wiring; keeping the
   PATs around until then is a deliberate break-glass window — if the App
   wiring has a problem, reverting the wiring PR falls back to a pipeline
   that still has working PATs, with no secret to re-create under time
   pressure.

**Optional, deferred:** setting the publish jobs' git author identity to the
bot (`<app-id>+<app-slug>[bot]@users.noreply.github.com`) is cosmetic —
commits pushed with an App token show as **Unverified** either way (the same
as today's PAT-pushed commits), and the App's slug isn't known until step 1
is done. Not required for the migration to be complete.
