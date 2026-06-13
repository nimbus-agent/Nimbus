# Installer Slice 4 — Hosted apt/yum repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On each stable release, publish a GPG-signed apt + yum repository (built from the released `.deb` / `.rpm`) to GitHub Pages at `https://nimbus-agent.github.io/linux-repo/`, so users can `apt install nimbus-headless` / `dnf install nimbus-headless` and get auto-updates.

**Architecture:** A new `publish-linux-repo.yml` workflow (stable-only `released` + `workflow_dispatch`, mirroring `publish-package-managers.yml`) downloads the released `.deb`/`.rpm`/`SHA256SUMS`, verifies the artifacts against `SHA256SUMS`, imports the existing release GPG key into an ephemeral `GNUPGHOME`, clones the `nimbus-agent/linux-repo` Pages repo (preserving prior state), refreshes the apt repo with `reprepro` and the yum repo with `createrepo_c`, **manually signs** the apt `Release` (→ `Release.gpg` + `InRelease`) and the yum `repomd.xml` with the same `--pinentry-mode loopback` pattern the existing `sign-linux-gpg.sh` uses, writes the public key + client `.repo` file + `.nojekyll`, and pushes. A pure, unit-tested generator renders the `reprepro` `conf/distributions` and the yum `.repo` client file and reads the artifact checksums from `SHA256SUMS`.

**Tech Stack:** GitHub Actions (Ubuntu runner), `reprepro` (apt), `createrepo_c` (yum), GnuPG (loopback signing), Bun + TypeScript (pure generator), GitHub Pages (static hosting).

---

## Background & locked decisions (read before starting)

- **Hosting URL: `https://nimbus-agent.github.io/linux-repo/`** (maintainer-confirmed — the default Pages URL, no DNS work). apt lives under `/apt`, yum under `/yum`, the public key at `/gpg.key`. A custom subdomain can be added later without breaking these paths.
- **New repo: `nimbus-agent/linux-repo`** (maintainer-confirmed). The main Nimbus repo's Pages is already used by the docs site (`nimbus-agent.dev`), and there is one Pages site per repo — so the linux repo must be its own repo, exactly like `homebrew-tap` / `scoop-bucket`.
- **Package name is `nimbus-headless`** for both `.deb` and `.rpm` (confirmed: `package-linux-installers.ts:322` `Package: nimbus-headless`; `nfpm-config.ts:50` `name: nimbus-headless`). So the user commands are `apt install nimbus-headless` / `dnf install nimbus-headless`.
- **Released artifact names** (already attached + in `SHA256SUMS` since Slice 2): `nimbus-headless_<ver>_amd64.deb` and `nimbus-headless-<ver>-x86_64.rpm`. `<ver>` has no leading `v`.
- **GPG: reuse the existing release secrets — NO new secret.** `GPG_SIGNING_SUBKEY` is an **ASCII-armored private key** piped straight to `gpg --batch --import` (not base64), and `GPG_PASSPHRASE` is its passphrase (see `sign-linux-gpg.sh`). The trusted public fingerprint is `5A20457CCD8B53FFAA945240886ADA6B487CAB6E` (`nimbus-verify.ps1`).
- **Manual signing, not reprepro `SignWith`.** reprepro signs `Release` via gpgme, which needs a passphrase preset into `gpg-agent` — fiddly and error-prone in CI. Instead, run `reprepro` **without** `SignWith` (produces a plain `Release`), then sign it ourselves with the proven `gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --pinentry-mode loopback` pattern: `--detach-sign --armor` → `Release.gpg` and `--clearsign` → `InRelease`. Same pattern signs the yum `repomd.xml`. This reuses exactly what already works and keeps `conf/distributions` free of a signing-key field.
- **`.nojekyll` is mandatory.** GitHub Pages runs Jekyll by default, which can drop or mangle files in a static tree. A `.nojekyll` file at the repo root serves the apt/yum trees verbatim.
- **apt pool stays small; yum accumulates.** `reprepro` keeps only the latest version per package by default (apt pool holds one `.deb`). `createrepo_c` indexes every `.rpm` in the yum dir, so yum keeps all published versions — fine for now; prune later if size matters (note it, don't prematurely optimize).
- **Re-run safety.** `reprepro includedeb` errors if the exact version is already registered, so the apt step first runs `reprepro ... remove stable nimbus-headless` (tolerating "not present"). The yum step copies the new `.rpm` in then re-runs `createrepo_c` over the whole dir — idempotent.
- **Trust framing (docs).** Unlike the `.msi`/`.pkg` (OS-codesigning still pending), the apt/yum **repository metadata is GPG-signed**, which IS the native apt/yum trust model — so `apt`/`dnf` verify it cryptographically. Use the modern `signed-by` keyring form, never the deprecated `apt-key add` (spec §5/Slice 4 + §9).
- **Pre-release no-op is free.** The `release: [released]` trigger fires only for non-prerelease releases (spec §9), same as the brew/scoop/winget workflow.
- **`scripts/` is NOT measured by the coverage-floor** (its globs are only `packages/{gateway,cli,sdk,client}/src` + `mcp-connectors/*/src`), so the generator's untested CLI glue is fine — same as `winget-manifest.ts` / `package-manager-manifests.ts`.
- **`test:scripts` = `bun test scripts`** auto-discovers the new `*.test.ts`; no registration edit needed.
- **No CHANGELOG entry** (release-infra; matches Slices 1–3). User-facing surface is `docs/install.md`.

---

## Infra prerequisite (maintainer provisions via GitHub UI — like the Slice 1 step)

The code work is NOT blocked on this; the workflow fails loudly with an actionable message if a secret is missing (mirroring the existing "Require PACKAGE_MANAGER_PAT" step). The maintainer needs to:

1. **Create `nimbus-agent/linux-repo`** (empty or a README). Disable issues/wiki/projects. Leave `main` unprotected so the release bot can push (matches `homebrew-tap` / `scoop-bucket`).
2. **Enable GitHub Pages on it:** Settings → Pages → Source = **Deploy from a branch** → branch **`main`** / folder **`/ (root)`**. After the first publish it serves at `https://nimbus-agent.github.io/linux-repo/`.
3. **Extend `PACKAGE_MANAGER_PAT`** (the existing fine-grained PAT) to also grant **contents: write on `nimbus-agent/linux-repo`** (it currently covers only `homebrew-tap` + `scoop-bucket`). No new secret.
4. **`GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE`** already exist (used by `release.yml`) — nothing to do.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `scripts/release/linux-repo-config.ts` | Pure generator: artifact-name + checksum helpers (`debAssetName`, `rpmAssetName`, `assetSha256` reusing `parseSha256Sums`), `renderRepreproDistributions()`, `renderYumRepoFile()`, the channel constants; + a CLI that writes the two config files and emits artifact names/shas to `$GITHUB_OUTPUT`. | Create |
| `scripts/release/linux-repo-config.test.ts` | Unit tests for every pure function. | Create |
| `.github/workflows/publish-linux-repo.yml` | The stable-only publish job (download → verify → GPG → reprepro + createrepo_c → manual sign → push to `linux-repo`). | Create |
| `docs/install.md` | Add a "Linux repositories (apt / yum)" section with the `signed-by` apt install + the dnf `.repo` install. | Modify |

---

## Task 1: Pure generator for the apt/yum repo config + checksum lookup

**Files:**

- Create: `scripts/release/linux-repo-config.ts`
- Test: `scripts/release/linux-repo-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/release/linux-repo-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  APT_ARCH,
  APT_CODENAME,
  APT_COMPONENT,
  assetSha256,
  debAssetName,
  renderRepreproDistributions,
  renderYumRepoFile,
  rpmAssetName,
} from "./linux-repo-config.ts";

const SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless_1.2.3_amd64.deb",
  "2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-1.2.3-x86_64.rpm",
  "3333333333333333333333333333333333333333333333333333333333333333  SHA256SUMS",
  "",
].join("\n");

describe("linux-repo-config artifact helpers", () => {
  test("debAssetName builds the released .deb name, stripping a leading v", () => {
    expect(debAssetName("1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
    expect(debAssetName("v1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
  });

  test("rpmAssetName builds the released .rpm name, stripping a leading v", () => {
    expect(rpmAssetName("1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
    expect(rpmAssetName("v1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
  });

  test("assetSha256 extracts a file's hash from SHA256SUMS", () => {
    expect(assetSha256(SUMS, "nimbus-headless_1.2.3_amd64.deb")).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(assetSha256(SUMS, "nimbus-headless-1.2.3-x86_64.rpm")).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("assetSha256 throws (fail loud) when the file is absent", () => {
    expect(() => assetSha256(SUMS, "nope.deb")).toThrow("nope.deb");
  });
});

describe("renderRepreproDistributions", () => {
  const conf = renderRepreproDistributions();

  test("declares the stable distribution with our codename/component/arch", () => {
    expect(conf).toContain(`Codename: ${APT_CODENAME}`);
    expect(conf).toContain(`Components: ${APT_COMPONENT}`);
    expect(conf).toContain(`Architectures: ${APT_ARCH}`);
  });

  test("does NOT set SignWith (we sign Release manually with loopback gpg)", () => {
    expect(conf).not.toContain("SignWith");
  });

  test("ends with a trailing newline (reprepro requires a final newline)", () => {
    expect(conf.endsWith("\n")).toBe(true);
  });
});

describe("renderYumRepoFile", () => {
  const repo = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo" });

  test("points baseurl at the yum tree and gpgkey at the published key", () => {
    expect(repo).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(repo).toContain("gpgkey=https://nimbus-agent.github.io/linux-repo/gpg.key");
  });

  test("enables gpg + repo_gpg checks (the repo metadata is signed)", () => {
    expect(repo).toContain("gpgcheck=1");
    expect(repo).toContain("repo_gpgcheck=1");
  });

  test("strips a trailing slash on baseUrl so URLs aren't doubled", () => {
    const r = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo/" });
    expect(r).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(r).not.toContain("linux-repo//yum");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/linux-repo-config.test.ts`
Expected: FAIL — `Cannot find module './linux-repo-config.ts'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/release/linux-repo-config.ts`:

```ts
#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSha256Sums } from "./package-manager-manifests.ts";

/** apt distribution coordinates. `stable` tracks the latest stable release. */
export const APT_CODENAME = "stable";
export const APT_COMPONENT = "main";
export const APT_ARCH = "amd64";

/** The shared package name for both the .deb and the .rpm. */
const PACKAGE_NAME = "nimbus-headless";

function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/** Released `.deb` filename for a version, e.g. `nimbus-headless_1.2.3_amd64.deb`. */
export function debAssetName(version: string): string {
  return `${PACKAGE_NAME}_${stripV(version)}_${APT_ARCH}.deb`;
}

/** Released `.rpm` filename for a version, e.g. `nimbus-headless-1.2.3-x86_64.rpm`. */
export function rpmAssetName(version: string): string {
  return `${PACKAGE_NAME}-${stripV(version)}-x86_64.rpm`;
}

/**
 * The sha256 of a named asset, read from a SHA256SUMS string. Throws (fail
 * loud) if the asset is absent — we never publish an artifact we couldn't
 * verify against the release manifest.
 */
export function assetSha256(sha256SumsText: string, filename: string): string {
  const hash = parseSha256Sums(sha256SumsText).get(filename);
  if (!hash) {
    throw new Error(`linux-repo-config: required release asset not found in SHA256SUMS: ${filename}`);
  }
  return hash;
}

export interface RepreproOptions {
  origin?: string;
  label?: string;
  description?: string;
}

/**
 * Render reprepro's `conf/distributions`. No `SignWith`: the workflow signs
 * the generated `Release` itself (detached `Release.gpg` + clearsigned
 * `InRelease`) with loopback gpg, mirroring `sign-linux-gpg.sh`.
 */
export function renderRepreproDistributions(opts: RepreproOptions = {}): string {
  const origin = opts.origin ?? "Nimbus";
  const label = opts.label ?? "Nimbus";
  const description = opts.description ?? "Nimbus headless apt repository";
  return [
    `Origin: ${origin}`,
    `Label: ${label}`,
    `Codename: ${APT_CODENAME}`,
    `Architectures: ${APT_ARCH}`,
    `Components: ${APT_COMPONENT}`,
    `Description: ${description}`,
    "",
  ].join("\n");
}

export interface YumRepoOptions {
  /** Repo root, e.g. `https://nimbus-agent.github.io/linux-repo` (trailing slash tolerated). */
  baseUrl: string;
}

/** Render the yum client `.repo` file (`baseurl` → /yum, `gpgkey` → /gpg.key). */
export function renderYumRepoFile(opts: YumRepoOptions): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return [
    "[nimbus]",
    "name=Nimbus headless",
    `baseurl=${base}/yum`,
    "enabled=1",
    "gpgcheck=1",
    "repo_gpgcheck=1",
    `gpgkey=${base}/gpg.key`,
    "",
  ].join("\n");
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const sha256SumsPath = parseArg("--sha256sums");
  const baseUrl = parseArg("--base-url") ?? "https://nimbus-agent.github.io/linux-repo";
  const distributionsPath = parseArg("--distributions-out");
  const repoFilePath = parseArg("--repo-file-out");
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/linux-repo-config.ts --version <v> --sha256sums <path> [--base-url <url>] [--distributions-out <path>] [--repo-file-out <path>]",
    );
    process.exit(1);
  }
  const sums = readFileSync(sha256SumsPath, "utf8");
  const deb = debAssetName(version);
  const rpm = rpmAssetName(version);
  const debSha = assetSha256(sums, deb);
  const rpmSha = assetSha256(sums, rpm);

  if (distributionsPath) {
    mkdirSync(dirname(distributionsPath), { recursive: true });
    writeFileSync(distributionsPath, renderRepreproDistributions(), "utf8");
  }
  if (repoFilePath) {
    mkdirSync(dirname(repoFilePath), { recursive: true });
    writeFileSync(repoFilePath, renderYumRepoFile({ baseUrl }), "utf8");
  }

  const lines = [`deb=${deb}`, `deb_sha256=${debSha}`, `rpm=${rpm}`, `rpm_sha256=${rpmSha}`];
  for (const line of lines) console.log(line);
  const ghOut = process.env["GITHUB_OUTPUT"];
  if (ghOut) {
    const { appendFileSync } = require("node:fs");
    appendFileSync(ghOut, `${lines.join("\n")}\n`);
  }
  void join; // (join imported for parity with sibling generators; retained for future path joins)
}
```

> Note: drop the `void join;` line and the `join` import if Biome flags the unused import — keep the file Biome-clean. (It is included only if a path join is used; if not, remove both.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/linux-repo-config.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Sanity-check the CLI**

Run:

```bash
printf '1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless_1.2.3_amd64.deb\n2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-1.2.3-x86_64.rpm\n' > /tmp/SUMS.txt
bun scripts/release/linux-repo-config.ts --version v1.2.3 --sha256sums /tmp/SUMS.txt --distributions-out /tmp/conf/distributions --repo-file-out /tmp/nimbus.repo
cat /tmp/conf/distributions
cat /tmp/nimbus.repo
```

Expected: four `deb=`/`deb_sha256=`/`rpm=`/`rpm_sha256=` stdout lines; `/tmp/conf/distributions` contains `Codename: stable`; `/tmp/nimbus.repo` contains `baseurl=https://nimbus-agent.github.io/linux-repo/yum`.

- [ ] **Step 6: Lint (worktree gotcha: `bun run lint` false-fails in a `.claude` worktree)**

Run: `bunx biome check scripts/release/linux-repo-config.ts scripts/release/linux-repo-config.test.ts`
Expected: no errors. (Remove the `join` import + `void join;` line if flagged.)

- [ ] **Step 7: Commit**

```bash
git add scripts/release/linux-repo-config.ts scripts/release/linux-repo-config.test.ts
git commit -m "feat(release): apt/yum repo config generator + checksum lookup (Slice 4)"
```

---

## Task 2: The `publish-linux-repo.yml` workflow

**Files:**

- Create: `.github/workflows/publish-linux-repo.yml`

Not unit-testable (runs only against a real release). Authored carefully against the `reprepro` / `createrepo_c` / GnuPG / apt-`signed-by` docs and validated by a YAML parse + review (the same way Slice 2/3 native jobs were).

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/publish-linux-repo.yml` with EXACTLY this content:

```yaml
name: Publish Linux repo

# `released` (not `published`) fires only for non-prerelease releases, so
# rc/beta/alpha tags are skipped automatically (the apt/yum channel tracks
# stable only). `workflow_dispatch` lets a maintainer re-publish a tag if a
# push failed transiently — re-running is idempotent.
on:
  release:
    types: [released]
  workflow_dispatch:
    inputs:
      tag_name:
        description: "Tag to publish (e.g. v0.5.0)"
        required: true
        type: string

concurrency:
  group: publish-linux-repo-${{ github.event.release.tag_name || github.event.inputs.tag_name }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  publish-linux-repo:
    name: Build + publish apt/yum repo
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - name: Checkout Nimbus
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Setup Bun and install dependencies
        uses: ./.github/actions/setup-nimbus-ci
        with:
          verify-lock: "false"

      # Fail fast with actionable messages if any required secret is missing.
      - name: Require publish + signing secrets
        env:
          PKG_PAT: ${{ secrets.PACKAGE_MANAGER_PAT }}
          GPG_PRIVATE_KEY: ${{ secrets.GPG_SIGNING_SUBKEY }}
          GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}
        run: |
          set -euo pipefail
          if [ -z "${PKG_PAT}" ]; then
            echo "::error::PACKAGE_MANAGER_PAT is not set. Grant the fine-grained PAT contents:write on nimbus-agent/linux-repo (repo Settings -> Secrets -> Actions)."
            exit 1
          fi
          if [ -z "${GPG_PRIVATE_KEY}" ] || [ -z "${GPG_PASSPHRASE}" ]; then
            echo "::error::GPG_SIGNING_SUBKEY and/or GPG_PASSPHRASE are not set. They sign the apt Release + yum repomd (same secrets release.yml already uses)."
            exit 1
          fi

      - name: Install reprepro + createrepo_c
        run: |
          set -euo pipefail
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends reprepro createrepo-c

      - name: Download released .deb + .rpm + SHA256SUMS
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          mkdir -p out
          VERSION="${TAG#v}"
          gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir out \
            --pattern SHA256SUMS \
            --pattern "nimbus-headless_${VERSION}_amd64.deb" \
            --pattern "nimbus-headless-${VERSION}-x86_64.rpm"

      - name: Resolve + verify artifact checksums
        id: art
        env:
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          VERSION="${TAG#v}"
          bun scripts/release/linux-repo-config.ts \
            --version "$VERSION" \
            --sha256sums out/SHA256SUMS \
            --base-url "https://nimbus-agent.github.io/linux-repo" \
            --distributions-out staging/apt/conf/distributions \
            --repo-file-out staging/nimbus.repo
          # Verify the downloaded artifacts match SHA256SUMS before publishing.
          ( cd out && sha256sum -c <(grep -E 'nimbus-headless(_|-)' SHA256SUMS) )

      - name: Import GPG signing key (ephemeral GNUPGHOME)
        env:
          GPG_PRIVATE_KEY: ${{ secrets.GPG_SIGNING_SUBKEY }}
        run: |
          set -euo pipefail
          GNUPGHOME="$(mktemp -d)"
          chmod 700 "$GNUPGHOME"
          echo "GNUPGHOME=$GNUPGHOME" >> "$GITHUB_ENV"
          printf '%s' "$GPG_PRIVATE_KEY" | gpg --batch --import
          gpg --list-secret-keys

      - name: Clone the linux-repo Pages repo
        env:
          GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}
        run: |
          set -euo pipefail
          git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/nimbus-agent/linux-repo.git" repo

      - name: Build the apt repo (reprepro) + the yum repo (createrepo_c)
        env:
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          VERSION="${TAG#v}"
          DEB="$PWD/out/nimbus-headless_${VERSION}_amd64.deb"
          RPM="$PWD/out/nimbus-headless-${VERSION}-x86_64.rpm"

          # --- apt (reprepro) ---
          mkdir -p repo/apt/conf
          cp staging/apt/conf/distributions repo/apt/conf/distributions
          # Drop any prior version first so re-running a tag (or bumping) never
          # trips reprepro's "already registered" guard. Tolerate "not present".
          reprepro -b repo/apt remove stable nimbus-headless 2>/dev/null || true
          reprepro -b repo/apt includedeb stable "$DEB"

          # --- yum (createrepo_c) ---
          mkdir -p repo/yum
          cp "$RPM" repo/yum/
          createrepo_c --update repo/yum

      - name: Sign apt Release + yum repomd (loopback gpg)
        env:
          GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}
        run: |
          set -euo pipefail
          REL="repo/apt/dists/stable/Release"
          gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --pinentry-mode loopback \
            --detach-sign --armor -o "${REL}.gpg" "$REL"
          gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --pinentry-mode loopback \
            --clearsign -o "repo/apt/dists/stable/InRelease" "$REL"
          gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --pinentry-mode loopback \
            --detach-sign --armor "repo/yum/repodata/repomd.xml"

      - name: Write the public key, client .repo, and .nojekyll
        run: |
          set -euo pipefail
          gpg --batch --armor --export > repo/gpg.key
          cp staging/nimbus.repo repo/nimbus.repo
          # Disable Jekyll so Pages serves the apt/yum trees verbatim.
          touch repo/.nojekyll

      - name: Commit + push to linux-repo
        env:
          GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          cd repo
          git config user.name "nimbus-release-bot"
          git config user.email "release-bot@nimbus-agent.invalid"
          # Stage first: first-publish files are untracked, and `git diff`
          # ignores untracked files — staging then diffing --cached makes the
          # no-op check see new files too.
          git add -A
          if git diff --cached --quiet; then echo "no repo change"; exit 0; fi
          git commit -m "nimbus ${TAG#v}"
          git push
```

- [ ] **Step 2: Confirm only the new file was added**

Run: `git -C C:\gitrep\Nimbus\.claude\worktrees\installer-slice4-linux-repo status --short`
Expected: only `?? .github/workflows/publish-linux-repo.yml` (plus the untracked plan doc until it's committed in Task 4).

- [ ] **Step 3: Validate the YAML parses (the `yaml` package is installed)**

Run from the worktree:

```bash
bun -e "import {parse} from 'yaml'; const fs=require('fs'); const d=parse(fs.readFileSync('.github/workflows/publish-linux-repo.yml','utf8')); console.log('jobs:', Object.keys(d.jobs)); console.log('steps:', d.jobs['publish-linux-repo'].steps.length)"
```

Expected: `jobs: [ "publish-linux-repo" ]` and a step count of 13. The YAML MUST parse cleanly — fix indentation if it doesn't.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish-linux-repo.yml
git commit -m "ci(release): publish a GPG-signed apt/yum repo to GitHub Pages (Slice 4)"
```

---

## Task 3: Document the apt/yum channel in docs/install.md

**Files:**

- Modify: `docs/install.md`

- [ ] **Step 1: READ the current file**

Read `docs/install.md` fully. It has a "Package managers (recommended — auto-updating)" table (Homebrew / Scoop / winget), a winget blockquote, a "## Native installers (double-click)" section (which lists the RPM/DEB direct-download rows), a "## Direct downloads" section, a "## Universal fallback (scripted)" section, and a bottom "> Signing status:" blockquote.

- [ ] **Step 2: Add a "Linux repositories (apt / yum)" section**

Insert a new section immediately AFTER the "## Native installers (double-click)" section and BEFORE "## Direct downloads". Use exactly this content:

````markdown
## Linux repositories (apt / yum)

For auto-updating Linux installs, add the signed Nimbus repository. The repository
**metadata is GPG-signed** (the native apt/yum trust model), so `apt`/`dnf` verify it
cryptographically — this is a stronger trust path than the standalone `.deb`/`.rpm`.
The channel tracks **stable releases only**.

**Debian / Ubuntu (apt):**

```bash
curl -fsSL https://nimbus-agent.github.io/linux-repo/gpg.key \
  | gpg --dearmor | sudo tee /usr/share/keyrings/nimbus-archive-keyring.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/nimbus-archive-keyring.gpg] https://nimbus-agent.github.io/linux-repo/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nimbus.list
sudo apt update && sudo apt install nimbus-headless
```

**Fedora / RHEL (dnf/yum):**

```bash
sudo curl -fsSL https://nimbus-agent.github.io/linux-repo/nimbus.repo \
  -o /etc/yum.repos.d/nimbus.repo
sudo dnf install nimbus-headless
```

`apt upgrade` / `dnf upgrade` then keep Nimbus current. (Uses the modern `signed-by`
keyring form — not the deprecated `apt-key add`.)

````

(The nested ` ```bash ` blocks above are part of the inserted markdown — keep them as fenced code blocks in the doc.)

- [ ] **Step 3: Verify markdownlint passes**

Run: `bunx markdownlint-cli2 docs/install.md`
Expected: no violations (auto-fix trivial ones with `bunx markdownlint-cli2 --fix docs/install.md`, then re-check). The links are absolute `https://` URLs (lychee allows these; do NOT use `file:///`).

- [ ] **Step 4: Commit**

```bash
git add docs/install.md
git commit -m "docs(install): apt/yum signed-repo install instructions (Slice 4)"
```

---

## Task 4: Commit the plan (markdownlint-clean)

**Files:**

- Add: `docs/superpowers/plans/2026-06-13-installer-slice4-linux-repo.md` (this file)

- [ ] **Step 1: Lint the plan**

Run: `bunx markdownlint-cli2 docs/superpowers/plans/2026-06-13-installer-slice4-linux-repo.md`
Expected: 0 errors. Auto-fix with `--fix`; for any MD040 (missing fence language) add `text`/`bash`/`yaml`/`ts` as appropriate.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-06-13-installer-slice4-linux-repo.md
git commit -m "docs(plan): Installer Slice 4 — apt/yum hosted repo plan"
```

---

## Final verification (before opening the PR)

- [ ] **Release-scripts tests** (the new generator + sibling helpers):

Run: `bun test scripts/release/linux-repo-config.test.ts scripts/release/winget-manifest.test.ts scripts/release/package-manager-manifests.test.ts`
Expected: all PASS. (For the whole tree: `bun test scripts` — the `test:scripts` gate.)

- [ ] **Workflow YAML parses** — `jobs` = `publish-linux-repo`, 13 steps (Task 2 Step 3).

- [ ] **Typecheck** (build the client dist first in a fresh worktree):

Run: `cd packages/client && bun run build && cd ../.. && bun run typecheck`
Expected: no errors.

- [ ] **Lint** (validate the real surface — `bun run lint` false-fails in a `.claude` worktree):

Run: `bunx biome check packages scripts`
Expected: 0 errors.

- [ ] **Preflight (fast):**

Run: `bun run preflight:fast`
Expected: PASS (the `lint (biome)` "0 files" line is the known `.claude`-worktree false-fail — confirm via the `bunx biome check packages scripts` above instead).

- [ ] Open the PR off fresh `main`. In the PR body, call out the **infra prerequisite** (create `nimbus-agent/linux-repo` + enable Pages on `main`/root + extend `PACKAGE_MANAGER_PAT` to it; GPG secrets already exist) and that the job **fails loudly** if the PAT/GPG secrets are missing.

---

## Self-review (completed during authoring)

- **Spec coverage (§5 Slice 4 + §9):** `reprepro` (apt) + `createrepo_c` (yum) from the released `.deb`/`.rpm` (Task 2); signed with the **existing** `GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE`, imported into an ephemeral `GNUPGHOME`, never echoed (Task 2); hosted on GitHub Pages (`nimbus-agent.github.io/linux-repo`); new `publish-linux-repo.yml`; docs use the modern `signed-by` keyring form, not `apt-key add` (Task 3); stable-only via the `released` trigger + documented no-op (Background, §9); generators unit-tested following the established pattern (Task 1, §6 Testing). ✅
- **Placeholder scan:** every code/YAML/doc block is complete; no TODO/TBD. ✅
- **Type/name consistency:** `debAssetName` / `rpmAssetName` / `assetSha256` / `renderRepreproDistributions` / `renderYumRepoFile` + `APT_CODENAME`/`APT_COMPONENT`/`APT_ARCH` are defined in Task 1 and used verbatim by its tests and the Task 2 CLI flags (`--distributions-out`, `--repo-file-out`, `deb`/`rpm` outputs). `nimbus-headless`, `stable`, and `https://nimbus-agent.github.io/linux-repo` are consistent across generator, workflow, and docs. ✅
- **Deviation note:** the spec's example domain `pkg.nimbus.dev` is replaced by the maintainer-confirmed `nimbus-agent.github.io/linux-repo` (the spec marked the domain "TBD"); apt repo signing is done manually (loopback gpg) rather than via reprepro `SignWith`, a documented robustness choice that reuses the proven `sign-linux-gpg.sh` pattern. ✅
