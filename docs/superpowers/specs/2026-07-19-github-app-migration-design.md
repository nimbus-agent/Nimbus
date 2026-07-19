# GitHub App Migration — Design

> **Status:** Design — approved in brainstorm (2026-07-19); ready for implementation plan.
> **Sub-project 2 of 4** in the org secrets-management program. Sub-project 1 (release-health verification + secret-health monitor) shipped in #768. The remaining sub-projects are #3 (npm OIDC + keyless signing) and #4 (rotation calendar + env/push-protection hardening).

## Problem

The release + publish pipeline authenticates with a sprawl of **human-owned fine-grained PATs** that expire (≤90 days), break when the owner rotates or leaves, and — as the phantom releases v0.17–v0.21 proved — fail *silently*. Sub-project 1 added a monitor that *watches* these PATs; this sub-project *retires* the ones it can, replacing them with a single org-owned GitHub App that issues short-lived (1-hour) installation tokens per job.

A GitHub App installed on the `nimbus-agent` org can mint tokens for repos **inside that org** only. That cleanly covers three PATs; two others cannot or need not be migrated (see Non-goals).

## Goals

- Retire the three org-scoped fine-grained PATs — `RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT` — replacing them with one org-owned App ("Nimbus Release Bot").
- Mint **per-job, least-privilege, 1-hour** tokens (`actions/create-github-app-token`), scoped to exactly the repos + permissions each job needs.
- Remove the recurring silent-expiry failure class for those three credentials (an App private key does not expire on a 90-day clock).
- **Attempt** to fix release-please auto-creating the release + tag (removing today's manual `git tag` + `autorelease: tagged` step) — see the honest caveat below.
- Keep the release path safe throughout: big-bang wiring cutover, but the PAT secrets are deleted only *after* the first green release (break-glass window).

## Non-goals

- **`WINGET_PAT` stays a classic PAT.** `publish-package-managers.yml` forks and opens a PR against **`microsoft/winget-pkgs`** (an external repo); an App installed on `nimbus-agent` cannot mint tokens for it. Documented as a deliberate exception.
- **`SCORECARD_TOKEN`** is not migrated — the monitor showed it unset (the OSSF Scorecard job falls back to `github.token`); there is nothing to replace.
- **`NIMBUS_CHECKS_TOKEN`** — already deleted (falls back to `github.token`).
- **npm trusted publishing / keyless signing** — sub-project #3.
- **Rolling the App out to the other satellite repos, rotation calendar, org push-protection** — sub-project #4. This sub-project installs the App only on the repos the current release pipeline touches.
- **Bot commit signing** — App-pushed commits to the channel repos appear **Unverified**, exactly as today's `PACKAGE_MANAGER_PAT`-pushed commits do (not a regression); giving the bot a signing key is out of scope (design-review #5).

## The App

- **Name:** Nimbus Release Bot (org-owned, under `nimbus-agent`).
- **Repository permissions:** `Contents: Read and write` (create releases + tags, push to the channel repos) and `Pull requests: Read and write` (release-please PRs). No organization or account permissions. **No `Pages` permission is needed** (design-review #4): `publish-linux-repo` updates GitHub Pages by `git push`-ing to the branch `linux-repo` serves from (contents:write), not via the Pages deploy API — verified against the workflow (clone → commit → push, Jekyll disabled).
- **Installed on:** `nimbus-agent`, *Only select repositories* → **`Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`**.
- **Credentials:** two secrets on the `Nimbus` repo — `RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY` (PEM). The Actions workflows run in `Nimbus`, and `create-github-app-token` mints cross-repo tokens for any installed repo via its `repositories:` input, so repo-scoped secrets on `Nimbus` are sufficient (no org secrets needed).

## Approach: per-job least-privilege minting

Each job that currently consumes one of the three PATs gains a token-mint step:

```yaml
- name: Mint release-bot token
  id: app-token
  uses: actions/create-github-app-token@<pinned-sha>  # add to allowed actions + SHA-pin
  with:
    app-id: ${{ secrets.RELEASE_BOT_APP_ID }}
    private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
    owner: nimbus-agent
    repositories: <only the repos this job writes>
    permission-contents: write        # down-scope to just what the job needs
    # permission-pull-requests: write # only where PRs are created (release-please)
```

Downstream steps then use `${{ steps.app-token.outputs.token }}` in place of the PAT. Each token is scoped to the narrowest repo set + permission the job needs, and expires in 1 hour — a far smaller blast radius than a broad, long-lived PAT.

## Per-workflow wiring

| Workflow | Job token scope | Replaces |
| --- | --- | --- |
| `release-please.yml` | `Nimbus` — contents + pull-requests: write | `RELEASE_PLEASE_PAT` (the `token:` input to `release-please-action`) |
| `release.yml` | `Nimbus` — contents: write | `RELEASE_PAT` (the `action-gh-release` step + the "Require release PAT" guard) |
| `publish-package-managers.yml` | `homebrew-tap`, `scoop-bucket` — contents: write | `PACKAGE_MANAGER_PAT` (brew/scoop pushes). **`WINGET_PAT` untouched.** |
| `publish-linux-repo.yml` | `linux-repo` — contents: write | `PACKAGE_MANAGER_PAT` (apt/yum repo + Pages push) |

`GPG_SIGNING_SUBKEY` / `GPG_PASSPHRASE` / `UPDATER_SIGNING_KEY` / Windows + Apple signing secrets are **unchanged** — they are signing keys, not GitHub API tokens, and out of scope.

## release-please auto-create — honest caveat

An App token *should* let `googleapis/release-please-action@v5` create the GitHub Release + tag on release-PR merge: App tokens can create releases, and unlike `github.token` their tag-push **does** trigger downstream workflows (so `release.yml` would fire automatically).

**However:** `RELEASE_PLEASE_PAT` is currently set and healthy, yet release-please still did **not** auto-create v0.23.0 (it stayed `autorelease: pending`, requiring the manual tag). So the token may not be the sole cause. This design therefore scopes the auto-create fix as **attempt + validate on the next release**, not a guarantee:

- Wire the App token into `release-please.yml` and observe whether the next release auto-creates.
- If it does — remove the manual step from `ci-secrets.md`.
- If it does not — the manual `git tag` + `autorelease: tagged` step **remains the documented fallback**, and the root cause (config vs. token vs. org setting) is diagnosed as separate follow-up work. The PAT retirement stands on its own regardless.

## Secret-health monitor update

`scripts/release/check-secret-health.ts` + `secret-health.yml` are updated to match the new credential reality:

- **Remove** the `RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT` PAT probes (those secrets are being retired).
- **Add** an App-health check that mints a token **scoped to all four target repos** (`Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`) with `contents: write` — so it catches not just a bad/rotated key but also the App being uninstalled from a repo or having its permissions downgraded (design-review #1). The mint is performed by the same `actions/create-github-app-token` action the pipeline uses, run in `secret-health.yml` with `continue-on-error: true`; its success/failure is passed into `check-secret-health.ts` via an env flag (`APP_MINT_STATUS=ok|failed`), which reports `dead` → red + `release-health` issue on failure. This deliberately avoids re-implementing RS256 JWT signing in the script — design-review #2 suggested native `node:crypto`; using the action instead needs no crypto at all **and** dogfoods the exact mint path the release pipeline depends on.
- **Keep** the `WINGET_PAT` probe (still a live PAT) and the cert decoders.
- **Fix a pre-existing gap** the release-health PR shipped: the `PACKAGE_MANAGER_PAT` `repo-write` check listed only `homebrew-tap` + `scoop-bucket` and **missed `linux-repo`**. That check is superseded by the App-health check here, so the gap is closed by removal — but the design records it so the plan does not silently reintroduce it.

## Migration and rollback

- **Big-bang wiring** in one PR: all four workflows gain the mint step and switch to the App token; the monitor + `ci-secrets.md` are updated in the same PR.
- **Staged secret deletion:** the PR does **not** delete `RELEASE_PAT` / `RELEASE_PLEASE_PAT` / `PACKAGE_MANAGER_PAT`. They are deleted as a **final step only after the first green release** proves the App wiring works end-to-end. This preserves a break-glass window.
- **Rollback:** revert the wiring PR — the PATs still exist (deletion is staged), so the pipeline returns to its prior working state with one revert.
- **Pre-flight:** a `workflow_dispatch`-able check (or the updated monitor) mints a token and verifies it can read the target repos before the first real release relies on it.

## Human-only steps (runbook, delivered with the PR)

These require org-admin rights and cannot be automated from CI:

1. Create the GitHub App under `nimbus-agent` org settings (Developer settings → GitHub Apps → New).
2. Set repository permissions: Contents R/W, Pull requests R/W. No org/account permissions. No webhook.
3. Install the App on `nimbus-agent`, selected repos: `Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`.
4. Generate a private key; add `RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY` as `Nimbus` repo Actions secrets.
5. Add `actions/create-github-app-token@<sha>` to the org's allowed-actions list (the repo requires SHA-pinned third-party actions).
6. Confirm the App can push to the channel repos' default branches (design-review #3): `homebrew-tap`, `scoop-bucket`, and `linux-repo` receive direct `git push`es from the publish workflows, so if any has branch protection requiring PRs or restricting push actors, add the App to its bypass/allowlist. `Nimbus` needs no change — release-please uses a PR and `release.yml` pushes a tag, not a protected-branch commit.
7. Confirm Actions are enabled on the target repos so an App-token-pushed tag triggers `release.yml` (App tokens trigger downstream workflows, unlike `github.token`; validated live on the first release — design-review #4).
8. After the first green release: delete the three retired PAT secrets.

Everything else — the four workflow edits, the monitor + script changes, and the docs — is automated in the PR.

## Files

- `.github/workflows/release.yml` (edit: mint step + swap `RELEASE_PAT`)
- `.github/workflows/release-please.yml` (edit: mint step + swap the `token:` input)
- `.github/workflows/publish-package-managers.yml` (edit: mint step + swap `PACKAGE_MANAGER_PAT`; leave `WINGET_PAT`)
- `.github/workflows/publish-linux-repo.yml` (edit: mint step + swap `PACKAGE_MANAGER_PAT`)
- `.github/workflows/secret-health.yml` + `scripts/release/check-secret-health.ts` (+ `.test.ts`) (edit: retire 3 PAT probes, add App-mint health check)
- `docs/ci-secrets.md` (edit: replace the 3 PAT rows with the App; document App setup + key rotation + the winget exception)
- Allowed-actions config for `actions/create-github-app-token` (SHA-pinned)

## Design-review dispositions (2026-07-19)

Review: [2026-07-19-github-app-migration-design-review.md](./2026-07-19-github-app-migration-design-review.md).

| # | Point | Disposition |
| --- | --- | --- |
| 1 | Health check must verify installation + scopes, not just a generic mint | **Fixed** — the App-health check mints a token scoped to all four target repos with `contents: write`, catching uninstall/permission-downgrade. |
| 2 | RS256 JWT minting without heavy deps | **Fixed (cleaner path)** — the mint is done by the `actions/create-github-app-token` action in `secret-health.yml` (`continue-on-error`), fed into the script via an env flag; no crypto re-implemented, and it dogfoods the real mint path. The review's native-`node:crypto` suggestion was considered but the action is simpler + more faithful. |
| 3 | Branch-protection could block App pushes | **Fixed** — added a runbook step to allow the App to push to the channel repos' default branches. |
| 4 | Pages/Deployments perms + downstream triggers | **Fixed** — verified `publish-linux-repo` uses branch-served Pages (git push), so `contents: write` suffices (no `pages: write`); added a runbook step to confirm Actions-enabled + first-release trigger validation. |
| 5 | App commits show Unverified | **Fixed (documented)** — recorded as a non-regression (PAT pushes are already unverified) and a non-goal; bot commit-signing is deferred. |

Invariant-alignment section of the review confirmed the security improvement (short-lived tokens, key stays in Actions secrets) and that the App is CI-confined (no HITL/local-gate bypass). No action.
