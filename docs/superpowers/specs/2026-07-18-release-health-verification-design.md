# Release-Health Verification & Secret-Health Monitor — Design

> **Status:** Design — approved in brainstorm (2026-07-18); ready for implementation plan.
> **Sub-project 1 of 4** in the org secrets-management program (the others: GitHub App migration, npm OIDC + keyless signing, rotation calendar + doc/env/push-protection hardening).

## Problem

Releases `v0.17`–`v0.21` shipped **zero assets** — winget/scoop/brew froze at `0.16.0` — because the fine-grained `RELEASE_PAT` had expired. The `softprops/action-gh-release` step logged `⚠️ Bad credentials` but did **not** hard-fail the run: release-please had already created the tag + (empty) GitHub Release, so the upload step "succeeded" against a pre-existing release while attaching nothing. No one noticed for five releases because a red release run raises no alert.

The downstream race (`released` firing ~18 min before assets attach) is **already fixed** — `publish-package-managers.yml` and `publish-linux-repo.yml` now trigger on `workflow_run: Release [completed]` gated on success + `v*` + non-prerelease. This design closes the two remaining gaps and adds proactive detection:

1. A publish that soft-succeeds with missing/partial assets is not caught.
2. A failed release run is not surfaced to a human.
3. A credential's impending/actual expiry is only discovered on release day.

## Goals

- **Loud, hard** failure when a published release is missing any asset it should carry.
- **Surface** any failed release run as an auto-filed, de-duped GitHub issue.
- **Proactively** detect dead PATs and near-expiry signing certs/keys on a schedule, before release day.
- Logic in **unit-tested** TypeScript; release YAML stays thin; scripts portable to the 9 `nimbus-agent` satellite repos.

## Non-goals (YAGNI)

- External notifications (Slack/email) — deliberately avoided; adds a webhook secret to the system we're hardening. GitHub issues are the alert channel.
- Automatic secret rotation.
- Satellite-repo-specific secrets (`VSCE_PAT`, `OVSX_PAT`, npm publish) — covered by sub-projects #3/#4. Scripts are written to be portable but only wired into `nimbus-agent/Nimbus` here.
- A config-file secret **manifest** (design-review #5a) — deferred. Portability is served here by (a) presence-based skipping of unset secrets and (b) the checked-secret set living in one editable in-file table (not scattered), plus the dynamic `GITHUB_REPOSITORY`. A JSON/TOML manifest-loading layer is speculative generality for a single-repo deliverable; it lands if/when the satellite repos actually adopt the monitor (sub-project #4).
- Replacing the PATs themselves — that is sub-project #2 (GitHub App migration). This sub-project makes the *current* PAT-based pipeline fail loudly; it is the safety net that de-risks that migration.

## Alerting model (decided)

All failures/warnings surface as a **de-duped GitHub issue** labeled `release-health`, via a shared helper. De-dupe keys on a hidden HTML marker `<!-- release-health:<key> -->` in the issue body: if an open issue with that marker exists, the helper refreshes its body (and comments only when the reported state changed — see C4); otherwise it creates one (ensuring the label exists). Uses the automatic `github.token` (needs `issues: write`) — no new secret.

## Components

All new TS lives under `scripts/release/` (new dir; sibling to the existing `scripts/sign-*`, `scripts/audit/`, `scripts/structure-audit/`). Bun/TS, strict, no `any`. Pure logic is separated from I/O and dependency-injected so it is unit-testable without network, `gpg`, or `openssl`.

### C1 — `verify-release-assets.ts` (asset-completeness gate)

- **Inputs:** the tag (`GITHUB_REF_NAME`), the local staging dir (`dist/stage/`), a GH API client bound to `github.token`.
- **Behavior:**
  1. Enumerate the local intended-upload set = files directly under `dist/stage/` (the exact set the `files: dist/stage/*` upload used).
  2. Fetch the release for the tag; list its assets (name + size).
  3. Compute missing = staged files with no same-named release asset, plus present-but-zero-byte assets.
  4. Sanity assert `SHA256SUMS` and `SHA256SUMS.asc` are among the assets.
  5. If `missing` is non-empty → print a clear table, open/update the `release-health` issue (key `assets:<tag>`), and exit non-zero.
- **Pure core:** `diffReleaseAssets(local: FileMeta[], remote: AssetMeta[]): AssetGap[]` — no I/O; unit-tested.
- **Wiring:** a new step at the end of the `publish-release` job in `release.yml`, right after the upload step (normal step, not `always()` — if upload hard-failed the job is already red; if it soft-succeeded this catches it).

### C2 — release-failure alert (`alert-on-failure` job in `release.yml`)

- A trailing job, `if: ${{ failure() }}`, `needs:` the build + `publish-release` jobs, `permissions: issues: write`.
- Calls `open-health-issue.ts` with key `run:<tag>`, a title naming the tag, and a body linking the failed run (`github.server_url/…/actions/runs/…`).
- Independent of *why* the run failed (bad PAT, build break, signing failure) — any red release run becomes a visible issue.

### C3 — `check-secret-health.ts` + `.github/workflows/secret-health.yml` (monitor)

- **Workflow triggers:** `schedule` (weekly — Mondays 09:00 UTC) + `workflow_dispatch`. Job runs `environment: release` so the release-scoped secrets are readable; `permissions: issues: write` + `contents: read`.
- **PAT probes — validity *and* authorization, per-secret strategy (design-review #1).** A token can be *alive* yet have had its permissions reduced, which `/rate_limit` alone would not catch. Each monitored token declares a probe strategy in a single in-file table:
  - `repo-write:<owner/repo>` — `GET /repos/<owner>/<repo>` and assert `permissions.push === true`. Used for `RELEASE_PAT` + `RELEASE_PLEASE_PAT` (→ the repo itself) and `PACKAGE_MANAGER_PAT` (→ the Homebrew-tap + Scoop-bucket repos). Catches both death **and** silent write-permission loss.
  - `scopes:<scope>` — classic PAT: read the `X-OAuth-Scopes` response header and assert the required scope is present. Used for `WINGET_PAT` (`public_repo`).
  - `alive` — `GET /rate_limit`; 200 ⇒ authorized-enough. Fallback for tokens with no single target repo (`NIMBUS_CHECKS_TOKEN` Checks:RW, `SCORECARD_TOKEN` read-only).
  Across all strategies: 401 ⇒ dead, other non-2xx ⇒ indeterminate (reported, not fatal). The owning repo self-reference is read from `process.env.GITHUB_REPOSITORY` — **never hardcoded** (design-review #5b). Unset optional secrets are skipped and listed "not configured".
- **Cert/key expiry (`notAfter`, N-days-ahead threshold, default 21, configurable via workflow input):**
  - `GPG_SIGNING_SUBKEY` (+ `GPG_PASSPHRASE`): import into an ephemeral `GNUPGHOME`, read the signing subkey's expiry.
  - `WINDOWS_CERT_PFX_BASE64` (+ `WINDOWS_CERT_PASSWORD`): `openssl pkcs12` → `x509 -enddate`.
  - `APPLE_CERT_P12_BASE64` (+ `APPLE_CERT_PASSWORD`): same.
- **Credential feeding — no argv leakage (design-review #2).** Passphrases and base64 payloads are **never** passed as command-line arguments (visible in the process list / at risk in logs). base64 payloads are decoded to a `0600` temp file under `$RUNNER_TEMP`; passwords are fed via `openssl … -passin env:<VAR>` and `gpg --batch --pinentry-mode loopback --passphrase-fd 0`; the ephemeral `GNUPGHOME` and temp files are removed in a `finally`/post step. This upholds Non-Negotiable #3 (no plaintext credentials in logs).
- **Missing/failing tooling → indeterminate (design-review #3a).** A missing `gpg`/`openssl` binary or any non-zero decode exit is reported as `indeterminate` for that credential — never a false `expired` and never a hard script crash that masks the other checks. (The monitor runs on `ubuntu-latest` where both are guaranteed; this guard is for robustness + local dry-runs.)
- **Pure cores (unit-tested):** `classifyPatStatus(httpStatus): 'alive'|'dead'|'indeterminate'`; `evaluateCertExpiry(notAfter: Date, now: Date, thresholdDays): 'ok'|'expiring'|'expired'`.
- **Outcome:** aggregate into a report table (credential · kind · status · days-left where known).
  - Any **dead** PAT or **expired** cert → job **fails** (red) **and** opens/updates the issue (key `secret-health`).
  - Any **expiring** cert (within threshold) → job **passes** but opens/updates the issue as a warning.
  - All healthy → no issue; if a prior `secret-health` auto-issue is open, close it with a "resolved" comment.
  - The issue body states the caveat explicitly: **PATs are detected dead/alive only** (fine-grained PAT expiry dates are not exposed by the API), so a dead PAT is caught within one weekly cycle, not ahead; certs get true N-days-ahead warning.

### C4 — `open-health-issue.ts` (shared)

- `openOrUpdateHealthIssue({ key, title, body, state, labels })`: lists open issues, finds the one whose body carries `<!-- release-health:<key> -->`. None → create it (creating the `release-health` label if absent). Found → **state-transition-aware update (design-review #4):** the marker embeds the last-reported state hash; the body (report table + refreshed timestamp) is always updated silently, but a **new comment is posted only when the state hash changed** — a credential newly unhealthy, or a severity escalation (`expiring`→`expired`). An unchanged weekly run refreshes the body only: no comment, no notification spam. `closeHealthIssue(key, comment)` handles the resolved path.
- **Pure cores:** `selectExistingIssue(issues, key)`; `computeStateHash(report)`; `shouldComment(prevHash, nextHash)` — all unit-tested.

## Data flow

```text
release.yml publish-release:
  … build → sign → action-gh-release(upload dist/stage/*) →
    verify-release-assets.ts ──(gap?)──▶ open-health-issue(assets:<tag>) + exit 1
  (any job fails) ─────────────────────▶ alert-on-failure job ▶ open-health-issue(run:<tag>)

secret-health.yml (weekly | dispatch, environment: release):
  check-secret-health.ts:
    probe PATs (GET /rate_limit) ─┐
    decode certs (gpg/openssl)  ─┴▶ report ──(dead/expired)──▶ fail job + open-health-issue(secret-health)
                                            ──(expiring)─────▶ pass + open-health-issue(secret-health)
                                            ──(all ok)───────▶ close-health-issue(secret-health)
```

## Error handling

- Every script prints a human-readable summary to the job log **and** the GitHub Step Summary (`$GITHUB_STEP_SUMMARY`) so the state is visible without opening the issue.
- The monitor never throws on an unset optional secret or a single indeterminate probe — it reports and continues, so one flaky check can't mask the others.
- `open-health-issue.ts` failures (e.g. missing `issues: write`) are logged loudly but do **not** mask the underlying non-zero exit of the asset gate / monitor — the exit code is set first.
- Cert-decode tooling (`gpg`/`openssl`) is present on `ubuntu-latest`; a decode that errors is reported as `indeterminate` for that cert (not a false "expired").

## Testing

Unit tests (`bun test`, DI-mocked — no network/`gpg`/`openssl`):

- `diffReleaseAssets`: complete set ⇒ no gap; missing file ⇒ gap; zero-byte asset ⇒ gap; extra remote asset ⇒ ignored.
- `classifyPatProbe` (per strategy): `repo-write` — `permissions.push:true`⇒ok, `false`⇒insufficient, 401⇒dead; `scopes` — required scope present⇒ok, absent⇒insufficient; `alive` — 200⇒ok, 401⇒dead, other⇒indeterminate.
- `evaluateCertExpiry`: past⇒expired, within threshold⇒expiring, beyond⇒ok (boundary at exactly threshold).
- `selectExistingIssue`: marker match ⇒ update; no match ⇒ create; multiple ⇒ oldest-open wins.
- `computeStateHash` / `shouldComment`: identical report ⇒ no comment; a credential newly unhealthy or `expiring`→`expired` ⇒ comment.

No integration/e2e tests — the workflows are exercised manually via `workflow_dispatch` on first landing.

## Human-only steps (runbook, delivered with the PR)

- Confirm the `release` environment has no protection rule that blocks the scheduled `secret-health` run from reading its secrets (a schedule runs on the default branch; default-branch deployments must be allowed).
- The `release-health` label is auto-created by the helper on first use; no manual step.

## Files

- `scripts/release/verify-release-assets.ts` (+ `.test.ts`)
- `scripts/release/check-secret-health.ts` (+ `.test.ts`)
- `scripts/release/open-health-issue.ts` (+ `.test.ts`)
- `.github/workflows/secret-health.yml` (new)
- `.github/workflows/release.yml` (edit: asset-gate step + `alert-on-failure` job)
- `docs/ci-secrets.md` (edit: "Release-health monitor" section + how to act on a `release-health` issue)
- `package.json` (optional `bun run` alias for local dry-run of the monitor/asset check)

## Design-review dispositions (2026-07-18)

Review: [2026-07-18-release-health-verification-design-review.md](./2026-07-18-release-health-verification-design-review.md).

| # | Point | Disposition | Where |
| --- | --- | --- | --- |
| 1 | Alive ≠ authorized (PAT scope/permission) | **Fixed (bounded)** — per-secret probe strategy: `repo-write` permission check against the known target repo, classic `scopes` header check, `alive` fallback. Full per-scope introspection intentionally not built. | C3 PAT probes |
| 2 | Secret leakage via CLI argv | **Fixed** — `env:` / `--passphrase-fd` / `0600` temp-file feeding; no secret ever in argv. | C3 credential feeding |
| 3a | Missing/failing `gpg`/`openssl` | **Fixed** — reported `indeterminate`, never a false `expired` or hard crash. | C3 missing tooling |
| 3b | Pure-JS cert parsing to drop the binary dep | **Deferred** — the monitor is CI-only (`ubuntu-latest` guarantees `gpg`+`openssl`); a PKCS#12 parser dependency (node-forge / openpgp.js) is YAGNI and cuts against the repo's dependency-caution posture. The DI seam keeps the spawn mockable in tests. | — |
| 4 | Weekly comment spam on a still-open issue | **Fixed** — state-transition-aware: body refreshed silently every run, comment only on a state change. | C4 |
| 5b | Hardcoded repo name | **Fixed** — read from `process.env.GITHUB_REPOSITORY`. | C3 PAT probes |
| 5a | Config-manifest of secrets for satellites | **Deferred** — presence-based skip + single editable table + dynamic repo cover the portability need now; a manifest-loading layer is speculative until satellites adopt (sub-project #4). | Non-goals |

Invariant-alignment section of the review confirmed: no plaintext credentials on disk/in source (Non-Negotiable #3), and no local Gateway invariants touched (CI-only). No action required.
