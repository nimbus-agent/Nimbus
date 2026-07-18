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
- Replacing the PATs themselves — that is sub-project #2 (GitHub App migration). This sub-project makes the *current* PAT-based pipeline fail loudly; it is the safety net that de-risks that migration.

## Alerting model (decided)

All failures/warnings surface as a **de-duped GitHub issue** labeled `release-health`, via a shared helper. De-dupe keys on a hidden HTML marker `<!-- release-health:<key> -->` in the issue body: if an open issue with that marker exists, the helper updates the body and adds a comment; otherwise it creates one (ensuring the label exists). Uses the automatic `github.token` (needs `issues: write`) — no new secret.

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
- **PAT probes (dead/alive):** `RELEASE_PAT`, `PACKAGE_MANAGER_PAT`, `WINGET_PAT`, `RELEASE_PLEASE_PAT`, `NIMBUS_CHECKS_TOKEN`, `SCORECARD_TOKEN`. For each set secret, one minimal authenticated call (`GET /rate_limit`); HTTP 200 ⇒ alive, 401 ⇒ dead, other ⇒ indeterminate (reported, not fatal). Unset optional secrets are skipped and listed as "not configured".
- **Cert/key expiry (`notAfter`, N-days-ahead threshold, default 21, configurable via workflow input):**
  - `GPG_SIGNING_SUBKEY` (+ `GPG_PASSPHRASE`): import into an ephemeral `GNUPGHOME`, read the signing subkey's expiry.
  - `WINDOWS_CERT_PFX_BASE64` (+ `WINDOWS_CERT_PASSWORD`): `openssl pkcs12` → `x509 -enddate`.
  - `APPLE_CERT_P12_BASE64` (+ `APPLE_CERT_PASSWORD`): same.
- **Pure cores (unit-tested):** `classifyPatStatus(httpStatus): 'alive'|'dead'|'indeterminate'`; `evaluateCertExpiry(notAfter: Date, now: Date, thresholdDays): 'ok'|'expiring'|'expired'`.
- **Outcome:** aggregate into a report table (credential · kind · status · days-left where known).
  - Any **dead** PAT or **expired** cert → job **fails** (red) **and** opens/updates the issue (key `secret-health`).
  - Any **expiring** cert (within threshold) → job **passes** but opens/updates the issue as a warning.
  - All healthy → no issue; if a prior `secret-health` auto-issue is open, close it with a "resolved" comment.
  - The issue body states the caveat explicitly: **PATs are detected dead/alive only** (fine-grained PAT expiry dates are not exposed by the API), so a dead PAT is caught within one weekly cycle, not ahead; certs get true N-days-ahead warning.

### C4 — `open-health-issue.ts` (shared)

- `openOrUpdateHealthIssue({ key, title, body, labels })`: lists open issues, finds the one whose body contains `<!-- release-health:<key> -->`, updates it + comments if found, else creates it (creating the `release-health` label if absent). Also `closeHealthIssue(key, comment)` for the resolved path.
- **Pure core:** `selectExistingIssue(issues, key): Issue | null` — unit-tested.

## Data flow

```
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
- `classifyPatStatus`: 200⇒alive, 401⇒dead, 403/500⇒indeterminate.
- `evaluateCertExpiry`: past⇒expired, within threshold⇒expiring, beyond⇒ok (boundary at exactly threshold).
- `selectExistingIssue`: marker match ⇒ update; no match ⇒ create; multiple ⇒ oldest-open wins.

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
