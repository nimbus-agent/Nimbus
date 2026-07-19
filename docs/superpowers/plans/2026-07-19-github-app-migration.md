# GitHub App Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three org-scoped human PATs (`RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`) in the release/publish pipeline with per-job, least-privilege, 1-hour tokens minted by one org-owned GitHub App ("Nimbus Release Bot").

**Architecture:** Each job that consumed a PAT gains an `actions/create-github-app-token` mint step scoped to only the repos + permissions it needs, then uses `steps.app-token.outputs.token`. `WINGET_PAT` stays (external repo). The secret-health monitor retires the three PAT probes and gains an App-mint health check. Big-bang wiring; PAT-secret deletion is staged to a post-release runbook step.

**Tech Stack:** GitHub Actions, `actions/create-github-app-token` (SHA-pinned), Bun/TS (the monitor script), `googleapis/release-please-action@v5`.

## Global Constraints

- **Pinned action (hardcoded, resolved 2026-07-19):** every mint step pins `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0` (latest stable; `audit:action-sha-pins` gates the pin). This exact SHA is used in all mint steps below. It must also be added to the org's allowed-actions list (runbook step).
- **The mint step is least-privilege:** `owner: nimbus-agent`, `repositories:` = only that job's repos, `permission-contents: write` (add `permission-pull-requests: write` ONLY for `release-please.yml`).
- **Do NOT delete the PAT secrets in this PR.** `RELEASE_PAT` / `RELEASE_PLEASE_PAT` / `PACKAGE_MANAGER_PAT` deletion is a post-first-green-release runbook step (break-glass window). `WINGET_PAT` is never touched.
- **Sequencing (documented, not code):** the wiring is static and committable now, but the workflows only *run* green once the human runbook is done (App created + installed + `RELEASE_BOT_APP_ID` / `RELEASE_BOT_PRIVATE_KEY` secrets added + the action allow-listed org-side). The PR must not merge before that.
- No new runtime dependency. Docs stay markdownlint-clean (`bun run lint:markdown`). Third-party actions SHA-pinned.
- The canonical mint step (fill `<APP_TOKEN_SHA>` + the per-job `repositories`):

  ```yaml
  - name: Mint release-bot token
    id: app-token
    uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
    with:
      app-id: ${{ secrets.RELEASE_BOT_APP_ID }}
      private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
      owner: nimbus-agent
      repositories: <comma-or-newline repo list for this job>
      permission-contents: write
  ```

---

### Task 1: `release-please.yml` — mint + token swap

**Files:**

- Modify: `.github/workflows/release-please.yml`

**Steps:**

- [ ] **Step 1: Insert the mint step** into the `release-please` job, before the `googleapis/release-please-action@…` step (line ~27). Use the canonical mint step (pinned SHA from Global Constraints) with `repositories: Nimbus` and add `permission-pull-requests: write` (this job opens PRs).

- [ ] **Step 2: Swap the action token.** Line 31:

  ```yaml
  # before
          token: ${{ secrets.RELEASE_PLEASE_PAT || secrets.RELEASE_PAT || github.token }}
  # after
          token: ${{ steps.app-token.outputs.token }}
  ```

- [ ] **Step 3: Verify.** `bun -e "import{parse}from'yaml';parse(await Bun.file('.github/workflows/release-please.yml').text());console.log('valid')"` → valid; `bun run audit:action-sha-pins` → OK.

- [ ] **Step 4: Commit.** `git add .github/workflows/release-please.yml && git commit -m "ci(app-migration): mint release-bot token in release-please"`

---

### Task 2: `release.yml` — mint (2 jobs) + `RELEASE_PAT` swaps

`RELEASE_PAT` appears in two jobs: `publish-release` (the "Require release PAT" guard at ~411-414, and the `action-gh-release` token at line 620) and `update-manifest` (token at line 678). Each job mints its own token.

**Files:**

- Modify: `.github/workflows/release.yml`

**Steps:**

- [ ] **Step 1: `publish-release` job — replace the guard with the mint step.** Replace the entire "Require release PAT" step (the `env: RELEASE_PAT:` + the `if [ -z … ]` guard, ~lines 410-415) with the canonical mint step (`repositories: Nimbus`, `permission-contents: write`, `id: app-token`). The mint step itself fails loudly if the App secrets are missing, so it subsumes the guard.

- [ ] **Step 2: `publish-release` — swap the release token.** Line 620: `token: ${{ secrets.RELEASE_PAT }}` → `token: ${{ steps.app-token.outputs.token }}`.

- [ ] **Step 3: `update-manifest` job — add a mint step.** Insert the canonical mint step (`repositories: Nimbus`, `permission-contents: write`, `id: app-token`) as the job's first step after checkout/setup, before the `action-gh-release` step at ~668.

- [ ] **Step 4: `update-manifest` — swap the token.** Line 678: `token: ${{ secrets.RELEASE_PAT }}` → `token: ${{ steps.app-token.outputs.token }}`.

- [ ] **Step 5: Update the stale comment** at line 390 ("GitHub Release API uses RELEASE_PAT") to reference the minted App token.

- [ ] **Step 6: Verify.** YAML parse valid; `bun run audit:action-sha-pins` → OK.

- [ ] **Step 7: Commit.** `git add .github/workflows/release.yml && git commit -m "ci(app-migration): mint release-bot token in release.yml (publish + manifest)"`

---

### Task 3: `publish-package-managers.yml` — mint + `PACKAGE_MANAGER_PAT` swaps (keep `WINGET_PAT`)

**Files:**

- Modify: `.github/workflows/publish-package-managers.yml`

**Steps:**

- [ ] **Step 1: Replace the "Require PACKAGE_MANAGER_PAT" guard** (~lines 71-77) with the canonical mint step: `repositories:` = `homebrew-tap` + `scoop-bucket`, `permission-contents: write`, `id: app-token`.

- [ ] **Step 2: Swap the two channel-push tokens.** Lines 106 and 126: `GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}` → `GH_TOKEN: ${{ steps.app-token.outputs.token }}` (the `git clone https://x-access-token:${GH_TOKEN}@…` lines for `homebrew-tap` and `scoop-bucket` are unchanged — they just consume `GH_TOKEN`).

- [ ] **Step 3: Leave `WINGET_PAT` fully intact** (the winget job forks `microsoft/winget-pkgs`, external — the App cannot mint for it).

- [ ] **Step 4: Verify.** YAML parse valid; `audit:action-sha-pins` OK; confirm `WINGET_PAT` still referenced (grep) and `PACKAGE_MANAGER_PAT` no longer referenced.

- [ ] **Step 5: Commit.** `git add .github/workflows/publish-package-managers.yml && git commit -m "ci(app-migration): mint release-bot token for brew/scoop; keep winget PAT"`

---

### Task 4: `publish-linux-repo.yml` — mint + `PACKAGE_MANAGER_PAT` swaps

**Files:**

- Modify: `.github/workflows/publish-linux-repo.yml`

**Steps:**

- [ ] **Step 1: Replace the "Require PACKAGE_MANAGER_PAT" guard** (~lines 71-77) with the canonical mint step: `repositories: linux-repo`, `permission-contents: write`, `id: app-token`.

- [ ] **Step 2: Swap the push tokens.** Lines 144 and 194: `GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}` → `GH_TOKEN: ${{ steps.app-token.outputs.token }}` (the clone + `git push` to `linux-repo` are unchanged — branch-served Pages, contents:write suffices).

- [ ] **Step 3: Verify.** YAML parse valid; `audit:action-sha-pins` OK; `PACKAGE_MANAGER_PAT` no longer referenced.

- [ ] **Step 4: Commit.** `git add .github/workflows/publish-linux-repo.yml && git commit -m "ci(app-migration): mint release-bot token for linux-repo"`

---

### Task 5: Secret-health monitor — retire 3 PAT probes, add App-mint health check

**Files:**

- Modify: `.github/workflows/secret-health.yml`
- Modify: `scripts/release/check-secret-health.ts`
- Modify: `scripts/release/check-secret-health.test.ts`

**Interfaces:**

- Consumes: the existing `PatStrategy` / `HealthRow` / `summarize` in `check-secret-health.ts`.

**Steps:**

- [ ] **Step 1: `secret-health.yml` — add the scoped App-mint step.** Before the "Run secret-health check" step, add the canonical mint step with `id: app-mint`, `continue-on-error: true`, `repositories:` = all four target repos (`Nimbus`, `homebrew-tap`, `scoop-bucket`, `linux-repo`), and BOTH `permission-contents: write` **and `permission-pull-requests: write`** — so it verifies the full permission set the pipeline needs (a PRs-permission downgrade that would break `release-please` is caught too; design-review #1). Then add to the check step's `env:` `APP_MINT_STATUS: ${{ steps.app-mint.outcome }}` (`success`/`failure`). Remove the `RELEASE_PAT` / `RELEASE_PLEASE_PAT` / `PACKAGE_MANAGER_PAT` env lines (43-45) — those probes are retired.

- [ ] **Step 2: Write the failing test** in `check-secret-health.test.ts`: given a health row list containing an `App` row derived from `APP_MINT_STATUS`, assert `summarize` marks `hardFailure` when the App row is `dead` and healthy when `ok`. Add a `classifyAppMint(outcome)` pure helper test: `success → "ok"`; **any non-success outcome (`failure`, `skipped`, empty/undefined) → `"dead"`** — fail-closed, so a missing App secret or a skipped mint step alerts rather than silently passing (design-review #2).

- [ ] **Step 2b: Run it** → FAIL (`classifyAppMint` not defined).

- [ ] **Step 3: Implement.** In `check-secret-health.ts`: (a) delete the three PAT entries (`RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`) from the `pats` table in `import.meta.main`, keeping `WINGET_PAT`; (b) add `export function classifyAppMint(outcome: string): PatStatus { return outcome === "success" ? "ok" : "dead"; }` (fail-closed — any non-success outcome, incl. unset/`skipped`, is `dead`); (c) in `import.meta.main`, read `process.env["APP_MINT_STATUS"] ?? ""` and push a `HealthRow { name: "RELEASE_BOT_APP", kind: "pat", status: classifyAppMint(...), detail: "scoped mint: Nimbus+homebrew-tap+scoop-bucket+linux-repo" }`. The App row flows through the existing `summarize` (a `dead` App → hardFailure → red + `release-health` issue).

- [ ] **Step 4: Run tests** → `bun test scripts/release/check-secret-health.test.ts` GREEN; then `bun test scripts/release/` all green.

- [ ] **Step 5: Verify workflow.** YAML parse valid; `audit:action-sha-pins` OK; `bunx biome check scripts/release/` clean.

- [ ] **Step 6: Commit.** `git add .github/workflows/secret-health.yml scripts/release/check-secret-health.ts scripts/release/check-secret-health.test.ts && git commit -m "ci(app-migration): monitor App health via scoped mint; retire 3 PAT probes"`

---

### Task 6: Docs — `ci-secrets.md` + runbook

**Files:**

- Modify: `docs/ci-secrets.md`

**Steps:**

- [ ] **Step 1: Replace the three PAT rows** (`RELEASE_PAT`, `RELEASE_PLEASE_PAT`, `PACKAGE_MANAGER_PAT`) in the quick-reference table + their detail sections with a single **Nimbus Release Bot (GitHub App)** entry: what it is (App ID + private key → per-job 1-hour tokens), the two secrets (`RELEASE_BOT_APP_ID`, `RELEASE_BOT_PRIVATE_KEY`), the four installed repos, and key rotation (regenerate the App private key + update the secret; no 90-day expiry).

- [ ] **Step 2: Keep `WINGET_PAT`** documented with an explicit note on *why* it stays (external `microsoft/winget-pkgs` fork — the org App can't mint for it).

- [ ] **Step 3: Add the "GitHub App setup + migration runbook"** section (the six human-only steps from the design: create App → permissions → install on 4 repos → add 2 secrets → allow-list the action org-side → branch-protection push access → confirm Actions-enabled → delete the 3 PAT secrets after the first green release).

- [ ] **Step 4: Verify.** `bun run audit:doc-refs` → OK; `bun run lint:markdown` → 0 errors.

- [ ] **Step 5: Commit.** `git add docs/ci-secrets.md && git commit -m "docs(app-migration): document the release-bot App, winget exception, and setup runbook"`

---

## Self-Review

**Spec coverage:** App + per-job least-privilege minting → Tasks 1-4 (+ Global Constraints mint step). WINGET_PAT untouched → Task 3 step 3. Secret-health App-mint (scoped to 4 repos, via the action, no crypto) → Task 5. Branch-protection + Actions-enabled + trigger validation + staged PAT deletion → Task 6 runbook + Global Constraints. release-please auto-create (attempt) → Task 1 wires the App token; validation is a post-merge live check (documented, not a task). ci-secrets.md rewrite → Task 6.

**Placeholder scan:** `<APP_TOKEN_SHA>` and per-job `repositories` lists are resolved in Task 1 Step 1 / stated per task — environment values, not logic gaps. No TBD/TODO.

**Type consistency:** `classifyAppMint` returns `PatStatus` (defined in check-secret-health.ts); the App `HealthRow` uses the existing `HealthRow` shape and flows through the existing `summarize`.

## Deviations / notes

- The design's "release-please auto-create fix" is scoped as *attempt + validate on the next real release* — there is no code task that can prove it pre-merge, so it is a documented post-merge observation, and the manual tag step stays in `ci-secrets.md` until a release proves it auto-creates.
- No `NIMBUS_CHECKS_TOKEN` / `SCORECARD_TOKEN` work — already deleted / unset.
- **Bot git-author attribution (design-review #3) is deferred, not built.** The publish jobs' existing git author config already works; changing it to the App bot identity (`<app-id>+<app-slug>[bot]@users.noreply.github.com`) is cosmetic attribution only, the commits are Unverified either way (design-review #5), and the `<app-slug>` isn't known until the App is created. Recorded as an **optional** post-creation runbook item, not a task.

## Plan-review dispositions (2026-07-19)

Review: [2026-07-19-github-app-migration-review.md](./2026-07-19-github-app-migration-review.md).

| # | Point | Disposition |
| --- | --- | --- |
| 1 | Monitor mint should also request `pull-requests: write` (a PRs downgrade would break release-please but pass a contents-only check) | **Fixed** — Task 5 Step 1 mint requests contents **and** pull-requests write. |
| 2 | `skipped`/undefined outcome maps to non-alerting `indeterminate` — a missing App secret could go unnoticed | **Fixed** — `classifyAppMint` is fail-closed: `success → ok`, everything else (`failure`/`skipped`/empty) → `dead` (alerts). |
| 3 | Set git author to the App bot identity for commit attribution | **Deferred** — cosmetic only; commits are Unverified regardless (design-review #5), and the bot slug isn't known until the App exists. Recorded as an optional post-creation runbook item. |
| 4 | Hardcode the pinned action SHA instead of a placeholder | **Fixed** — pinned `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0` (resolved 2026-07-19) throughout. |

Invariant-alignment section confirmed the security posture (key in Actions secrets, staged deletion / rollback gate). No action.
