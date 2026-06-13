# Installer Slice 3 — winget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Nimbus to the winget community repo (`microsoft/winget-pkgs`) on every stable release by auto-opening a `wingetcreate` PR that points at the released `nimbus-headless-windows-x64.msi`.

**Architecture:** Add a Windows `winget` job to the existing `.github/workflows/publish-package-managers.yml` (same stable-only `released` + `workflow_dispatch` trigger as the brew/scoop job). The job downloads the released `.msi` + `SHA256SUMS`, verifies the `.msi` against `SHA256SUMS` via a small pure TS helper, bootstraps a pinned + checksum-verified `wingetcreate.exe`, and runs `wingetcreate update NimbusAgent.Nimbus --submit` to open the cross-repo PR. `wingetcreate` itself generates/updates the winget YAML manifests, so we do **not** author a manifest generator (we add only the URL + sha256 resolver helper). The SDK channel resolver already knows the `winget` channel; we tighten its upgrade hint to use the exact PackageIdentifier.

**Tech Stack:** GitHub Actions (Windows runner), Bun + TypeScript (pure helper), `wingetcreate` (Microsoft's WinGetCreate CLI), PowerShell (`pwsh`) workflow steps.

---

## Background & locked decisions (read before starting)

- **PackageIdentifier: `NimbusAgent.Nimbus`** — confirmed with the maintainer. It becomes the public install id (`winget install NimbusAgent.Nimbus`) and is disruptive to change after the first `microsoft/winget-pkgs` PR is accepted.
- **Secret: `WINGET_PAT`** — a **classic** PAT with the **`public_repo`** scope, provisioned by the maintainer via the GitHub UI. Required because `wingetcreate` must fork `microsoft/winget-pkgs`, push a branch to the fork, and open a cross-repo PR — which the existing fine-grained `PACKAGE_MANAGER_PAT` (scoped only to our own channel repos) cannot do. The job **fails loudly** if it is missing (mirrors the existing "Require PACKAGE_MANAGER_PAT" step).
- **No manifest generator.** `wingetcreate` downloads the `.msi`, computes its `InstallerSha256`, reads the MSI `ProductCode`/`UpgradeCode`, and regenerates the version/installer/locale YAML manifests itself. Authoring our own winget-manifest renderer would be redundant and would drift from what `wingetcreate` actually submits. We add only a tiny **pure helper** (`scripts/release/winget-manifest.ts`) that resolves the `.msi` release URL + reads its expected sha256 from `SHA256SUMS` — the integrity gate the maintainer asked for ("read the sha256 from the release SHA256SUMS, like the brew/scoop job does"). `wingetcreate` has no `--sha256` input, so we use that hash to **verify the downloaded `.msi` before submitting**, then `wingetcreate` independently re-derives the same value for the manifest.
- **First submission is a one-time manual `wingetcreate new`.** `wingetcreate update` requires the package to already exist in `winget-pkgs` (it fetches the current manifest to bump it). The very first `NimbusAgent.Nimbus` submission is therefore run once, by hand, by a maintainer (documented in `docs/install.md`); CI's `update` path then handles every subsequent stable release. This is the standard winget automation pattern.
- **`harden-runner` is Linux-only** — it is intentionally omitted from the Windows `winget` job (step-security/harden-runner does not support Windows runners).
- **Pre-release no-op is free.** The workflow's `release: [released]` trigger fires only for non-prerelease releases, so rc/beta/alpha tags skip winget automatically (spec §9). No extra guard is added (consistent with the existing brew/scoop job).
- **wingetcreate pin:** `v1.12.8.0`, `wingetcreate.exe` sha256 `8bd738851b524885410112678e3771b341c5c716de60fbbecb88ab0a363ed85d` (authoritative — computed by downloading the asset; cross-checked against the release's `wingetcreate.exe.txt`). Mirrors the Slice-2 pinned-nfpm-binary + checksum bootstrap pattern.
- **No CHANGELOG entry.** Installer Slices 1 & 2 did not add `docs/CHANGELOG.md` rows (release-infra, not a product delivery in the running log); Slice 3 follows that precedent. The user-facing surface is `docs/install.md`.
- **`test:scripts` = `bun test scripts`** auto-discovers any `*.test.ts` under `scripts/`; no test-registration edit is needed for the new helper test.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `scripts/release/winget-manifest.ts` | Pure helper: the winget constants (`WINGET_PACKAGE_IDENTIFIER`, `WINGET_MSI_ASSET`), `msiReleaseUrl()`, `msiAssetSha256()` (reuses `parseSha256Sums`), + a CLI that emits `url`/`sha256`/`identifier` to `$GITHUB_OUTPUT`. | Create |
| `scripts/release/winget-manifest.test.ts` | Unit tests for the helper (URL building, sha256 extraction, fail-loud on missing asset, identifier value). | Create |
| `packages/sdk/src/distribution-channel.ts:94-95` | Tighten the `winget` upgrade hint to use the exact PackageIdentifier. | Modify |
| `packages/sdk/src/distribution-channel.test.ts:99` | Update the hint expectation. | Modify |
| `.github/workflows/publish-package-managers.yml` | Add the Windows `winget` job. | Modify |
| `docs/install.md` | Add the `winget install NimbusAgent.Nimbus` one-liner + honest unsigned/SmartScreen note. | Modify |

---

## Task 1: Pure winget helper (URL + sha256 from SHA256SUMS)

**Files:**

- Create: `scripts/release/winget-manifest.ts`
- Test: `scripts/release/winget-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/release/winget-manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  WINGET_MSI_ASSET,
  WINGET_PACKAGE_IDENTIFIER,
  msiAssetSha256,
  msiReleaseUrl,
} from "./winget-manifest.ts";

// A minimal GNU-coreutils SHA256SUMS sample (hash + two spaces + filename).
const SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless-linux-amd64-v1.2.3.tar.gz",
  "2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-windows-x64.msi",
  "3333333333333333333333333333333333333333333333333333333333333333  nimbus-headless-windows-x64.zip",
  "",
].join("\n");

describe("winget-manifest", () => {
  test("PackageIdentifier is the confirmed NimbusAgent.Nimbus", () => {
    expect(WINGET_PACKAGE_IDENTIFIER).toBe("NimbusAgent.Nimbus");
  });

  test("WINGET_MSI_ASSET is the Slice-2 Windows installer filename", () => {
    expect(WINGET_MSI_ASSET).toBe("nimbus-headless-windows-x64.msi");
  });

  test("msiReleaseUrl points at the released .msi, normalizing a leading v", () => {
    const expected =
      "https://github.com/nimbus-agent/Nimbus/releases/download/v1.2.3/nimbus-headless-windows-x64.msi";
    expect(msiReleaseUrl("nimbus-agent/Nimbus", "1.2.3")).toBe(expected);
    expect(msiReleaseUrl("nimbus-agent/Nimbus", "v1.2.3")).toBe(expected);
  });

  test("msiAssetSha256 extracts the .msi hash from SHA256SUMS", () => {
    expect(msiAssetSha256(SUMS)).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("msiAssetSha256 throws if the .msi is missing (never submit a guessed hash)", () => {
    const noMsi =
      "4444444444444444444444444444444444444444444444444444444444444444  other.zip";
    expect(() => msiAssetSha256(noMsi)).toThrow(WINGET_MSI_ASSET);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/winget-manifest.test.ts`
Expected: FAIL — `Cannot find module './winget-manifest.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/release/winget-manifest.ts`:

```ts
#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { parseSha256Sums } from "./package-manager-manifests.ts";

/**
 * winget package identity. Confirmed with the maintainer before the first
 * microsoft/winget-pkgs submission — it becomes the public `winget install <id>`
 * id and is disruptive to change after a PR is accepted.
 */
export const WINGET_PACKAGE_IDENTIFIER = "NimbusAgent.Nimbus";

/** The Windows installer asset Slice 2 attaches to every stable release. */
export const WINGET_MSI_ASSET = "nimbus-headless-windows-x64.msi";

/** Public download URL for the released .msi (the URL winget's manifest points at). */
export function msiReleaseUrl(repo: string, version: string): string {
  const v = version.replace(/^v/, "");
  return `https://github.com/${repo}/releases/download/v${v}/${WINGET_MSI_ASSET}`;
}

/**
 * The expected sha256 of the released .msi, read from the release SHA256SUMS.
 * Throws (fail loud) if the asset is absent — we never submit a winget PR for a
 * hash we couldn't verify against the published manifest.
 */
export function msiAssetSha256(sha256SumsText: string): string {
  const hash = parseSha256Sums(sha256SumsText).get(WINGET_MSI_ASSET);
  if (!hash) {
    throw new Error(
      `winget-manifest: required release asset not found in SHA256SUMS: ${WINGET_MSI_ASSET}`,
    );
  }
  return hash;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const repo = parseArg("--repo") ?? "nimbus-agent/Nimbus";
  const sha256SumsPath = parseArg("--sha256sums");
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/winget-manifest.ts --version <v> --sha256sums <path> [--repo owner/repo]",
    );
    process.exit(1);
  }
  const url = msiReleaseUrl(repo, version);
  const sha256 = msiAssetSha256(readFileSync(sha256SumsPath, "utf8"));
  const lines = [`url=${url}`, `sha256=${sha256}`, `identifier=${WINGET_PACKAGE_IDENTIFIER}`];
  for (const line of lines) console.log(line);
  // GitHub Actions step-output idiom: append key=value lines to $GITHUB_OUTPUT
  // so downstream steps can read steps.<id>.outputs.url / .sha256 / .identifier.
  const ghOut = process.env["GITHUB_OUTPUT"];
  if (ghOut) appendFileSync(ghOut, `${lines.join("\n")}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/winget-manifest.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Sanity-check the CLI emits the right output**

Run:

```bash
printf '2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-windows-x64.msi\n' > /tmp/SUMS.txt
bun scripts/release/winget-manifest.ts --version v1.2.3 --repo nimbus-agent/Nimbus --sha256sums /tmp/SUMS.txt
```

Expected stdout (three lines):

```text
url=https://github.com/nimbus-agent/Nimbus/releases/download/v1.2.3/nimbus-headless-windows-x64.msi
sha256=2222222222222222222222222222222222222222222222222222222222222222
identifier=NimbusAgent.Nimbus
```

- [ ] **Step 6: Commit**

```bash
git add scripts/release/winget-manifest.ts scripts/release/winget-manifest.test.ts
git commit -m "feat(release): winget .msi URL + sha256 resolver helper (Slice 3)"
```

---

## Task 2: Tighten the SDK winget upgrade hint to the exact PackageIdentifier

**Why:** `channelUpgradeHint("winget")` currently prints `winget upgrade nimbus`. With a concrete PackageIdentifier now chosen, the precise command is `winget upgrade NimbusAgent.Nimbus` (winget's loose name/moniker match would usually work, but the exact id is unambiguous and matches what users `winget install`).

**Files:**

- Modify: `packages/sdk/src/distribution-channel.test.ts:99`
- Modify: `packages/sdk/src/distribution-channel.ts:94-95`

- [ ] **Step 1: Update the failing test first**

In `packages/sdk/src/distribution-channel.test.ts`, change the `winget` row of the `channelUpgradeHint` table (line 99) from:

```ts
    ["winget", "winget upgrade nimbus"],
```

to:

```ts
    ["winget", "winget upgrade NimbusAgent.Nimbus"],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/distribution-channel.test.ts`
Expected: FAIL — the winget hint still contains `winget upgrade nimbus`, not `...NimbusAgent.Nimbus`.

- [ ] **Step 3: Update the implementation**

In `packages/sdk/src/distribution-channel.ts`, change the `winget` case (lines 94-95) from:

```ts
    case "winget":
      return "Installed via winget — run 'winget upgrade nimbus' to update.";
```

to:

```ts
    case "winget":
      return "Installed via winget — run 'winget upgrade NimbusAgent.Nimbus' to update.";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/distribution-channel.test.ts`
Expected: PASS (the full file, including the `channelUpgradeHint` table).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/distribution-channel.ts packages/sdk/src/distribution-channel.test.ts
git commit -m "feat(sdk): winget upgrade hint uses the NimbusAgent.Nimbus id (Slice 3)"
```

---

## Task 3: Add the Windows `winget` job to the publish workflow

**Files:**

- Modify: `.github/workflows/publish-package-managers.yml`

This job is not unit-testable (it only runs against a real GitHub Release). It is authored carefully against the `wingetcreate` CLI contract and validated in the code-quality review, the same way Slice 2's WiX/pkgbuild jobs were. Validate YAML locally with the lint step in Step 4.

- [ ] **Step 1: Append the `winget` job**

In `.github/workflows/publish-package-managers.yml`, after the existing `generate-and-publish` job (i.e. as a second top-level entry under `jobs:`), add:

```yaml
  winget:
    name: Submit winget manifest PR
    runs-on: windows-latest
    timeout-minutes: 20
    # No step-security/harden-runner here: it supports Linux runners only.
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Setup Bun and install dependencies
        uses: ./.github/actions/setup-nimbus-ci
        with:
          verify-lock: "false"

      # Fail fast with an actionable message if the winget submission PAT is missing.
      # wingetcreate must fork microsoft/winget-pkgs + open a cross-repo PR, which the
      # fine-grained PACKAGE_MANAGER_PAT (scoped to our own channel repos) cannot do —
      # this needs a classic PAT with the `public_repo` scope.
      - name: Require WINGET_PAT
        shell: pwsh
        env:
          WINGET_PAT: ${{ secrets.WINGET_PAT }}
        run: |
          if ([string]::IsNullOrEmpty($env:WINGET_PAT)) {
            Write-Output "::error::WINGET_PAT is not set. Add a classic PAT with the 'public_repo' scope so wingetcreate can fork microsoft/winget-pkgs, push to the fork, and open a PR (the fine-grained PACKAGE_MANAGER_PAT cannot). Repo Settings -> Secrets -> Actions."
            exit 1
          }

      - name: Download the released .msi + SHA256SUMS
        shell: pwsh
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          New-Item -ItemType Directory -Force -Path out | Out-Null
          gh release download "$env:TAG" --repo "$env:GITHUB_REPOSITORY" `
            --pattern SHA256SUMS --pattern nimbus-headless-windows-x64.msi --dir out
          if ($LASTEXITCODE -ne 0) { throw "gh release download failed for $env:TAG" }

      - name: Resolve .msi URL + expected sha256 from SHA256SUMS
        id: msi
        shell: pwsh
        env:
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          $version = $env:TAG -replace '^v',''
          bun scripts/release/winget-manifest.ts `
            --version $version --repo "$env:GITHUB_REPOSITORY" --sha256sums out/SHA256SUMS
          if ($LASTEXITCODE -ne 0) { throw "winget-manifest helper failed (is the .msi in SHA256SUMS?)" }

      - name: Verify the downloaded .msi matches SHA256SUMS
        shell: pwsh
        run: |
          $expected = "${{ steps.msi.outputs.sha256 }}"
          $actual = (Get-FileHash -Algorithm SHA256 out/nimbus-headless-windows-x64.msi).Hash
          if ($actual.ToLower() -ne $expected.ToLower()) {
            Write-Output "::error::.msi sha256 mismatch (SHA256SUMS=$expected computed=$actual). Refusing to submit a winget PR for a tampered/incomplete asset."
            exit 1
          }
          Write-Output "verified .msi sha256 = $($actual.ToLower())"

      - name: Bootstrap wingetcreate (pinned + checksum-verified)
        shell: pwsh
        run: |
          $wcVersion = "1.12.8.0"
          $wcSha256 = "8bd738851b524885410112678e3771b341c5c716de60fbbecb88ab0a363ed85d"
          $wcUrl = "https://github.com/microsoft/winget-create/releases/download/v$wcVersion/wingetcreate.exe"
          Invoke-WebRequest -Uri $wcUrl -OutFile wingetcreate.exe
          $actual = (Get-FileHash -Algorithm SHA256 wingetcreate.exe).Hash
          if ($actual.ToLower() -ne $wcSha256) {
            Write-Output "::error::wingetcreate.exe sha256 mismatch (pinned v$wcVersion): expected=$wcSha256 computed=$($actual.ToLower())"
            exit 1
          }
          Write-Output "wingetcreate v$wcVersion verified"

      - name: Submit winget manifest PR
        shell: pwsh
        env:
          WINGET_PAT: ${{ secrets.WINGET_PAT }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          $version = $env:TAG -replace '^v',''
          $url = "${{ steps.msi.outputs.url }}"
          $id = "${{ steps.msi.outputs.identifier }}"
          # `update` requires NimbusAgent.Nimbus to already exist in microsoft/winget-pkgs.
          # The FIRST-EVER submission is a one-time manual `wingetcreate new` by a maintainer
          # (see docs/install.md); CI then handles every subsequent stable release here.
          ./wingetcreate.exe update $id --version $version --urls "$url" --submit --token $env:WINGET_PAT
          if ($LASTEXITCODE -ne 0) {
            throw "wingetcreate submit failed. If this is the first release, $id may not yet exist in winget-pkgs — bootstrap it once with 'wingetcreate new' (see docs/install.md)."
          }
```

- [ ] **Step 2: Confirm the existing brew/scoop job is untouched**

Run: `git diff .github/workflows/publish-package-managers.yml`
Expected: the diff adds only the new `winget:` job; the `generate-and-publish` job, the trigger, `concurrency`, and `permissions` blocks are unchanged.

- [ ] **Step 3: Validate the workflow YAML parses**

Run: `bun -e "import {parse} from 'yaml'; parse(require('fs').readFileSync('.github/workflows/publish-package-managers.yml','utf8')); console.log('yaml ok')"`
Expected: `yaml ok` (no parse error). If the `yaml` package isn't resolvable from the repo root, instead run `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish-package-managers.yml')); print('yaml ok')"`.

- [ ] **Step 4: Run actionlint if available (best-effort)**

Run: `actionlint .github/workflows/publish-package-managers.yml` (skip if `actionlint` is not installed locally — it is not a required gate).
Expected: no errors. PowerShell `run:` bodies are not shell-linted by actionlint.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-package-managers.yml
git commit -m "ci(release): winget job auto-submits the microsoft/winget-pkgs PR (Slice 3)"
```

---

## Task 4: Document the winget channel honestly in docs/install.md

**Files:**

- Modify: `docs/install.md`

- [ ] **Step 1: Add the winget row to the package-managers table**

In `docs/install.md`, the "Package managers (recommended — auto-updating)" table (lines 9-12) currently has Homebrew + Scoop rows. Add a winget row so the table reads:

```markdown
| Platform | Command |
| --- | --- |
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket; scoop install nimbus` |
| Windows (winget) | `winget install NimbusAgent.Nimbus` |
```

- [ ] **Step 2: Add an honest note about winget review + signing**

Immediately after that table (before the "## Native installers" heading on line 14), add:

```markdown
> **winget availability & trust:** the winget package tracks **stable releases only**
> and is published by an automated `wingetcreate` PR to
> [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) on each release, so
> a new version appears once Microsoft's PR review merges it (not instantly). The installer
> it delivers is the same per-user `.msi` as the direct download — currently **unsigned**, so
> Microsoft's PR review + SmartScreen reputation are the trust signals until code-signing
> lands (see the signing note at the bottom of this page).
```

- [ ] **Step 3: Verify markdownlint passes on the changed doc**

Run: `bunx markdownlint-cli2 docs/install.md`
Expected: no violations. (`docs/install.md` is under the markdownlint-gated tree; auto-fix trivial issues with `bunx markdownlint-cli2 --fix docs/install.md`.) Links in the added text are absolute `https://` URLs to GitHub, which lychee allows — do not use `file:///` links.

- [ ] **Step 4: Commit**

```bash
git add docs/install.md
git commit -m "docs(install): winget install one-liner + honest review/signing note (Slice 3)"
```

---

## Final verification (before opening the PR)

- [ ] **Run the full scripts test suite** (picks up the new helper test):

Run: `bun test scripts/release/winget-manifest.test.ts scripts/release/package-manager-manifests.test.ts`
Expected: all PASS.

- [ ] **Run the SDK channel tests:**

Run: `bun test packages/sdk/src/distribution-channel.test.ts`
Expected: all PASS.

- [ ] **Typecheck** (in a fresh worktree, build the client dist first — see the worktree gotcha):

Run: `cd packages/client && bun run build && cd ../.. && bun run typecheck`
Expected: no errors.

- [ ] **Lint** (in a `.claude` worktree, `bun run lint` false-fails — validate the real surface directly):

Run: `bunx biome check packages scripts`
Expected: no errors.

- [ ] **Preflight (fast):**

Run: `bun run preflight:fast`
Expected: PASS (static gates).

- [ ] Open the PR off fresh `main` with a summary of the four tasks; call out in the PR body that the **first-ever** winget submission is a one-time manual `wingetcreate new` and that `WINGET_PAT` (classic, `public_repo`) must be provisioned for the job to succeed (the job fails loudly otherwise).

---

## Self-review (completed during authoring)

- **Spec coverage (§5 Slice 3 + §6.1 + §9):** winget job opens the `microsoft/winget-pkgs` PR pointing at the released `.msi` (Task 3); stable-only via the existing `released` trigger + documented no-op on pre-release (Background, §9); honest "Microsoft PR review + SmartScreen while unsigned" doc (Task 4, §5/Slice 3); updater coexistence already shipped (Slice 1/2) and the `winget` channel hint is tightened (Task 2, §6.1); testing follows the pure-generator pattern with the helper unit-tested and the native job validated in review (Task 1, §6 Testing). ✅
- **Placeholder scan:** every code/YAML/doc block is complete; no TODO/TBD. ✅
- **Type/name consistency:** `WINGET_PACKAGE_IDENTIFIER` / `WINGET_MSI_ASSET` / `msiReleaseUrl` / `msiAssetSha256` are defined in Task 1 and referenced verbatim by the Task 3 workflow (`steps.msi.outputs.url|sha256|identifier`) and Task 2/4 strings; `NimbusAgent.Nimbus` and `nimbus-headless-windows-x64.msi` are used consistently throughout. ✅
