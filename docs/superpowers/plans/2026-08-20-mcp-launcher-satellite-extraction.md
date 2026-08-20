# MCP Launcher Satellite Extraction (Branch B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `packages/mcp-launcher` out of this monorepo into a new `nimbus-agent/nimbus-mcp` satellite repo, publish `@nimbus-dev/mcp` to npm via OIDC trusted publishing, and take the official MCP Registry listing off the blocked list.

**Architecture:** The launcher is already engineered for extraction — its `src/` imports nothing from `packages/gateway`, and its `package.json` declares no `@nimbus-dev/*` dependency. Extraction therefore formalizes an existing boundary rather than carving a new one. The one real coupling is a *test*, not code: `resolve-binary.test.ts` reads `scripts/install/lib/paths.ts` as text to keep the launcher's fallback install directories in sync with what the installer actually writes. That guard is replaced by a two-sided arrangement — vendored constants in the satellite, plus a new cross-repo drift job in this repo's existing `org-drift-sweep.yml`, which already clones public satellite repos for exactly this class of check.

**Tech Stack:** Bun 1.2+, TypeScript strict, Biome, GitHub Actions, release-please, npm OIDC trusted publishing.

**Spec:** [`docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md`](../specs/2026-08-19-mcp-launcher-publish-route.md) (Branch B, recommended, owner-approved 2026-08-20). Parent program: [`docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`](../specs/2026-08-19-nimbus-distribution-program-design.md).

---

## Global Constraints

- **No `NPM_TOKEN`, ever, in any repo.** `scripts/release/credential-registry.ts` records it as `state: "forbidden"` with the note *"Revoked 2026-07-19. Publishing is OIDC-only... If this reappears, someone has reintroduced a bypass."* The new repo publishes via OIDC trusted publishing only.
- **No `npm publish` step lands in this monorepo.** Zero exist today; keeping it that way is reason #2 in the spec's recommendation — this repo holds the release signing surface (`docs/release/signing-keys.md`).
- **The launcher stays MIT and dependency-free.** It must not import from `packages/gateway`, `packages/cli`, or `scripts/` — those are AGPL-3.0. Vendoring literal *values* with attribution is fine; importing code is not.
- **npm floor 11.5.1** for the publish preflight (matches the sdk/client gate shipped 2026-07-20).
- **Publishing access on the npm package must be set to require 2FA and disallow tokens** (`mfa=publish`), matching `@nimbus-dev/sdk` and `@nimbus-dev/client`.
- **Credentials come from the org, never from a repo secret.** Verified 2026-08-20: `nimbus-client` and `nimbus-sdk` have zero repo-level secrets. Four org secrets are `SELECTED` visibility and must have `nimbus-mcp` added to their repo lists (Task 2b Step 10b); `gh secret set --repo` is the wrong tool and creates a duplicate credential.
- **`publishConfig.access` must be `"public"` in `package.json`.** npm defaults a *scoped* package to restricted, and a restricted publish on a free org fails outright. Verified against the live precedent on 2026-08-20: `npm view @nimbus-dev/sdk publishConfig` → `{ access: 'public', registry: 'https://registry.npmjs.org/' }`, `npm view @nimbus-dev/client publishConfig` → `{ access: 'public' }`. The launcher's `package.json` has no `publishConfig` at all today.
- **The `Co-Authored-By: Claude Opus 5` trailer applies only when an agent authors the commit.** A human executing these steps by hand should drop it — the trailer is an attribution claim, not boilerplate. Note that in this monorepo it is largely moot either way: squash is the only merge method, so a local commit message is discarded and replaced by the PR title + body. In the **satellite** repo (Tasks 2–4, pushed directly to `main`) the message does persist, so get it right there.
- **Platform equality** — the launcher resolves paths for win32/darwin/linux from any host; every test exercises all three (`resolve-binary.ts` routes joins through `path.win32`/`path.posix` deliberately).
- **Branch hygiene in this repo** — never commit on `main`. `git switch -c dev/<you>/<topic>` first; verify with `git rev-parse --abbrev-ref HEAD`.
- **PR title is the commit.** Squash is the only merge method; the PR title is what release-please parses. Put the conventional-commit type in the title, reasoning in the body.

---

## Sequencing Invariant (read before starting)

**Nothing may be deleted from this monorepo until `@nimbus-dev/mcp` is live on npm.** Tasks 1–5 build and publish the satellite; Tasks 6–9 clean up this repo. Reversing that order means a window where the package exists nowhere.

Within the cleanup half there is a second ordering rule: **Task 6 (the replacement drift guard) lands before Task 7 (which deletes the current one).** Otherwise the installer-path contract is unguarded for the length of the gap, and that guard protects the single worst first-run failure mode for this whole distribution play — `Could not find the Nimbus CLI` reported against a perfectly good install, on the macOS GUI-launched-editor path where `PATH` is empty.

```text
Task 1 ──► Task 2 ──► Task 2b ──► Task 3 ──► Task 4 (npm live) ──► Task 5 (registry)
 gates      seed      scaffold    release      publish              submit
                          │
                          └──────────────► Task 6 ──► Task 7 ──► Task 8 ──► Task 9
                                          (guard)   (delete)   (org)    (docs)
```

Task 2b's CI job names are an input to Task 8 Step 6 (the `required_status_checks` contexts), so 2b must land before the ruleset is created. Task 6 needs only the repo to *exist* with `src/installer-contract.ts` in it, which is Task 2 — it does not wait on 2b.

---

## What the spec undercounted

The spec costed the monorepo side as "a `workspaces`/`test`-script edit". Re-running the search finds **fifteen** live references outside `packages/mcp-launcher/` itself. This is not a flaw in the recommendation — the org-side count of six enumeration sites is exactly right — but the cleanup is larger than one line, and Task 7 is sized accordingly.

| # | Site | What it does |
|---|---|---|
| 1 | `package.json:37` | `workspaces` array entry |
| 2 | `package.json:214` | root `test` script |
| 3 | `bun.lock` | workspace + `@nimbus-dev/mcp` alias (regenerated) |
| 4 | `scripts/lib/ci-tests.ts:43` | `runInitialUnitTestsWithCoverage` args |
| 5 | `.github/workflows/_test-suite.yml:267` | per-package test loop |
| 6 | `.github/workflows/_test-suite.yml:318` | combined coverage test line |
| 7 | `scripts/coverage/instrument-scope.ts:15` | `FIRST_PARTY` regex (+ comment at :4) |
| 8 | `scripts/coverage/instrument-scope.test.ts:32,39-40` | asserts the launcher *is* instrumented |
| 9 | `scripts/coverage-floor/check.ts:159` | floor discovery glob |
| 10 | `scripts/coverage-floor/check.test.ts:215` | asserts `resolve-binary.ts` is in the file set |
| 11 | `scripts/coverage-floor/exclusions.ts:56,61` | `index.ts` bin-entry exemption |
| 12 | `scripts/coverage-floor/build-lcov.sh:62,72,86` | lcov package loop + two comments |
| 13 | `sonar-project.properties:109` | `sonar.coverage.exclusions` entry |
| 14 | `scripts/structure-audit/platform-branching-allowlist.ts:184-187` | platform-branching allowlist entry |
| 15 | `docs/README.md:811` | repository tree |

Plus `CLAUDE.md:90` and `GEMINI.md:90` (Task 9), and `docs/CHANGELOG.md:799`, which is a **historical** entry and must be left alone.

**A trap in that list.** Sites 11 and 13 are joined by `scripts/coverage-floor/check-exclusion-parity.ts`, which asserts every `sonar.coverage.exclusions` pattern has a matching local exemption in `exclusions.ts`. The check is one-directional (sonar → exclusions), so removing the `exclusions.ts` entry alone **fails the gate**, while removing the sonar entry alone passes silently. Remove both in the same commit.

**A stale claim to fix while you are in there.** `platform-branching-allowlist.ts:186` currently reads *"the coverage floor (scripts/coverage-floor/check.ts) scopes only packages/{gateway,cli}/src and packages/mcp-connectors/\*/src, so no coverage-threshold gate covers packages/mcp-launcher"*. That is false as of the change that added `check.ts:159` — the floor **does** scope `packages/mcp-launcher/src/**/*.ts`. The entry is deleted in Task 7, so the false claim goes with it; no separate fix is needed, but do not copy that sentence anywhere.

---

## File Structure

**New repo `nimbus-agent/nimbus-mcp`** (created in Task 2):

| File | Responsibility |
|---|---|
| `src/index.ts` | Bin entry: resolve, spawn `nimbus mcp-server --stdio`, forward exit status. Moved verbatim. |
| `src/resolve-binary.ts` | Platform-aware binary resolution. Moved verbatim. |
| `src/exit-status.ts` | Exit-code/signal translation. Moved verbatim. |
| `src/installer-contract.ts` | **New.** The two installer directory suffixes, vendored with attribution. Single source of truth for both the satellite's unit test and this repo's cross-repo drift job. |
| `src/resolve-binary.test.ts` | Moved, with the text-read drift test rewritten against `installer-contract.ts`. |
| `src/exit-status.test.ts` | Moved verbatim. |
| `src/installer-contract.test.ts` | **New.** Asserts `CANDIDATE_DIRS`' first entry per platform is built from the vendored suffixes. |

Scaffolding added in Task 2b, all adapted from `C:\gitrep\nimbus-client` (the closest analogue — MIT, one npm package, OIDC-published):

| File | Responsibility |
|---|---|
| `CLAUDE.md` | Agent context: what this is, the zero-dependency + MIT boundary, and the fact that the MCP *server* is not in this repo. |
| `README.md` | Moved with the source in Task 2; the "not published" caveat comes out at Task 4 Step 9. |
| `CONTRIBUTING.md`, `SECURITY.md` | Adapted from `nimbus-client`; sdk-specific sections deleted, not stubbed. |
| `.claude/commands/nimbus-mcp-boundaries.md` | The one skill, mirroring `nimbus-client-boundaries.md`: what is expensive to rediscover, not what `CLAUDE.md` already says. |
| `.github/workflows/{ci,cla,codeql,sonar}.yml` | Copied from `nimbus-client`; job names become Task 8's required-check contexts. |
| `.github/{CODEOWNERS,dependabot.yml,pull_request_template.md,ISSUE_TEMPLATE/*,codeql/codeql-config.yml}` | Org-standard repo furniture. |
| `.gitattributes`, `.gitignore`, `.editorconfig`, `.bun-version`, `biome.json`, `.coderabbit.yaml` | Shared config. `.gitattributes` (`* text=auto eol=lf`) is load-bearing against Biome's `lineEnding: lf`. |
| `sonar-project.properties` | Project key `nimbus-agent_nimbus-mcp`, `sonar.sources=src` (no `scripts/` or `test/` here), `src/index.ts` coverage-excluded as a bin entry, `sonar.qualitygate.wait=true`. |

**This repo** (Tasks 6–9):

| File | Change |
|---|---|
| `scripts/structure-audit/check-launcher-installer-contract.ts` | **Create.** Compares a cloned `installer-contract.ts` against `resolveInstallDir`. |
| `scripts/structure-audit/check-launcher-installer-contract.test.ts` | **Create.** Unit tests for the parser + comparator. |
| `.github/workflows/org-drift-sweep.yml` | Add `nimbus-mcp` to the `sha-pins` matrix + three App-token CSVs; add the `launcher-installer-contract` job. |
| `.github/rulesets/general-branch.json` | Add `nimbus-mcp` to `bypass.by_repo` and `repos`. |
| The fifteen sites above | Remove. |
| `CLAUDE.md`, `GEMINI.md`, `docs/README.md`, `docs/CHANGELOG.md` | Reverse the wording per the spec's "Consequence" section. |

---

### Task 1: Record the sdk/client publish precedent

The spec is explicit that the exact workflow shape and the npm trusted-publisher UI steps are **implementation-time gaps that must not be guessed**. This task closes them by reading the two live satellite repos before anything is written. Its deliverable is a written record, because Tasks 3 and 4 are executed against it.

**Files:**

- Create: `docs/superpowers/specs/2026-08-20-satellite-publish-precedent.md`

**Interfaces:**

- Produces: the verbatim release + publish workflow of `nimbus-sdk`, which Task 3 adapts.

#### Prerequisite gate — run this before anything else in the plan

Creating a repo, moving source, and wiring CI is wasted work if the operator cannot actually register a trusted publisher on the npm org. That permission check belongs here, not at Task 4.

- [ ] **Gate A: Confirm the operator holds npm org owner/admin on `nimbus-dev`**

Trusted-publisher registration and the publishing-access setting both require org **owner** (or admin) rights. `npm whoami` fails `E401` on this machine, so this is an interactive check the operator runs themselves:

> Run these yourself in the terminal: `! npm login`, then `! npm org ls nimbus-dev`

Expected: the command succeeds and lists your account with `owner` (or `admin`). If it shows `developer`, **stop the plan here** — someone with owner rights must either grant the role or perform Task 4 Steps 3–4. Record which in the precedent doc.

- [ ] **Gate B: Confirm the package name is still free**

```bash
npm view @nimbus-dev/mcp version
```

Expected: `E404 Not Found` (verified 2026-08-20). If it resolves, the name is taken — stop and investigate before creating anything.

- [ ] **Step 1: Fetch both satellite release workflows**

```bash
mkdir -p "$CLAUDE_JOB_DIR/tmp/precedent"
gh api repos/nimbus-agent/nimbus-sdk/contents/.github/workflows \
  --jq '.[].name' > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-workflows.txt"
cat "$CLAUDE_JOB_DIR/tmp/precedent/sdk-workflows.txt"
```

Expected: a list including a release-please workflow. Note its exact filename — the next step needs it.

- [ ] **Step 2: Download the release workflow and release-please config**

```bash
for f in release-please.yml release.yml; do
  gh api "repos/nimbus-agent/nimbus-sdk/contents/.github/workflows/$f" \
    --jq '.content' 2>/dev/null | base64 -d \
    > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-$f" && echo "got $f"
done
gh api repos/nimbus-agent/nimbus-sdk/contents/release-please-config.json \
  --jq '.content' | base64 -d > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-release-please-config.json"
gh api repos/nimbus-agent/nimbus-sdk/contents/.release-please-manifest.json \
  --jq '.content' | base64 -d > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-manifest.json"
```

If a filename 404s, list the directory again and use the real name. Do not invent one.

- [ ] **Step 3: Read PR nimbus-sdk#12 — the OIDC + provenance gate**

```bash
gh pr view 12 --repo nimbus-agent/nimbus-sdk --json title,body,files \
  > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-pr12.json"
gh pr diff 12 --repo nimbus-agent/nimbus-sdk \
  > "$CLAUDE_JOB_DIR/tmp/precedent/sdk-pr12.diff"
```

This is the PR `docs/ci-secrets.md:359` names as the source of the pre-publish preflight (OIDC available + npm ≥ 11.5.1) and the two post-publish verification steps. Read the diff in full.

- [ ] **Step 4: Confirm the repo settings you must reproduce**

```bash
gh api repos/nimbus-agent/nimbus-sdk --jq \
  '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}'
gh api repos/nimbus-agent/nimbus-sdk/rulesets --jq '.[] | {name, target, enforcement}'
```

Expected: squash-only, matching this monorepo's convention and `.github/rulesets/general-branch.json`.

- [ ] **Step 5: Write the record**

Create `docs/superpowers/specs/2026-08-20-satellite-publish-precedent.md` containing: the exact workflow filenames, the full text of the release workflow, the `release-please-config.json` and `.release-please-manifest.json` contents, the permissions block (`id-token: write`, `contents: write`, `pull-requests: write`), the pre-publish preflight steps, the two post-publish verification steps, and the repo settings from Step 4. Quote them; do not summarize. State explicitly which parts are verbatim-copyable and which are repo-specific (package name, paths).

- [ ] **Step 5b: Research the MCP Registry submission format now, not at Task 5**

The registry may require a manifest file (currently `server.json`) in the repo. Finding that out at Task 5 costs an extra commit round-trip on a repo that is already published; finding it out here lets Task 2 seed the file with everything else.

```bash
gh api repos/modelcontextprotocol/registry/contents/README.md --jq '.content' | base64 -d \
  > "$CLAUDE_JOB_DIR/tmp/precedent/mcp-registry-readme.md"
grep -n -i "server.json\|schema\|publish\|npm" "$CLAUDE_JOB_DIR/tmp/precedent/mcp-registry-readme.md" | head -30
```

Record in the precedent doc: whether a manifest file is required, its exact filename and schema URL, whether it must reference a *published* version (which would force it to land after Task 4 regardless), and the submission mechanism (PR vs CLI). If a manifest is required and does **not** depend on a published version, Task 2 Step 11b creates it; otherwise it stays in Task 5.

- [ ] **Step 6: Verify no NPM_TOKEN appears anywhere in the precedent**

```bash
grep -rn "NPM_TOKEN\|npm_token" "$CLAUDE_JOB_DIR/tmp/precedent/" || echo "clean — OIDC only"
```

Expected: `clean — OIDC only`. If `NPM_TOKEN` appears, **stop** and report it — that contradicts `credential-registry.ts` and the whole premise of Branch B.

- [ ] **Step 7: Commit**

```bash
git switch -c dev/asaf/mcp-launcher-precedent
git add docs/superpowers/specs/2026-08-20-satellite-publish-precedent.md
git commit -m "docs: record the sdk/client npm publish precedent for the launcher extraction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Create `nimbus-agent/nimbus-mcp` and seed it

**Files:**

- Create (new repo): `src/{index,resolve-binary,exit-status,installer-contract}.ts`, `src/{resolve-binary,exit-status,installer-contract}.test.ts`, `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `biome.json`, `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: nothing from Task 1 yet (that lands in Task 3).
- Produces: `INSTALLER_WIN32_SUFFIX: string` and `INSTALLER_POSIX_SUFFIX: string` exported from `src/installer-contract.ts` — Task 6's drift job parses exactly these two names.

- [ ] **Step 1: Create the repo**

Clone it alongside the other repos in `C:\gitrep`, **not** into a temp directory — every sibling satellite lives there (`Nimbus`, `nimbus-sdk`, `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `create-nimbus-connector`), and `nimbus-client`'s own `verify:sdk` script already assumes siblings are reachable as `../nimbus-sdk`.

```bash
gh repo create nimbus-agent/nimbus-mcp --public \
  --description "Launcher for the Nimbus MCP server — exposes your local Nimbus index and agents to any MCP client."
git clone https://github.com/nimbus-agent/nimbus-mcp.git /c/gitrep/nimbus-mcp
ls -d /c/gitrep/*/
```

Expected: the listing now shows `nimbus-mcp` next to the other six.

- [ ] **Step 2: Copy the launcher source verbatim**

```bash
cd /c/gitrep/nimbus-mcp
mkdir -p src
cp /c/gitrep/Nimbus/packages/mcp-launcher/src/index.ts src/
cp /c/gitrep/Nimbus/packages/mcp-launcher/src/resolve-binary.ts src/
cp /c/gitrep/Nimbus/packages/mcp-launcher/src/exit-status.ts src/
cp /c/gitrep/Nimbus/packages/mcp-launcher/src/exit-status.test.ts src/
cp /c/gitrep/Nimbus/packages/mcp-launcher/src/resolve-binary.test.ts src/
cp /c/gitrep/Nimbus/packages/mcp-launcher/package.json .
cp /c/gitrep/Nimbus/packages/mcp-launcher/tsconfig.json .
cp /c/gitrep/Nimbus/packages/mcp-launcher/README.md .
cp /c/gitrep/Nimbus/packages/mcp-launcher/LICENSE .
```

Do not edit the three `src/*.ts` implementation files. They move unchanged — that is the point of the extraction.

- [ ] **Step 2b: Add `publishConfig` to `package.json` — the first publish fails without it**

`@nimbus-dev/mcp` is a **scoped** package, and npm defaults scoped packages to restricted access. A restricted publish fails on a free org, so the OIDC release would go red on its first run for a reason that has nothing to do with OIDC. Both live sibling packages set this (verified 2026-08-20).

Add to `package.json`, after the `license` field:

```json
  "publishConfig": {
    "access": "public"
  },
```

Verify it parses and reads back:

```bash
cd /c/gitrep/nimbus-mcp
bun -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log(p.name, JSON.stringify(p.publishConfig))'
```

Expected: `@nimbus-dev/mcp {"access":"public"}`. Keep this even though `nimbus-client`'s workflow also passes `--access public` on the publish line (verified 2026-08-20) — belt and braces on the one setting whose failure mode is a paid-plan error on first publish.

- [ ] **Step 2c: Add `mcpName` to `package.json` — it must ship in the published tarball**

This is an ordering trap found while researching the registry (see the precedent doc, §8). The MCP Registry verifies npm ownership through an **`mcpName` property in `package.json`**, checked against the *published tarball*. Adding it after the first publish means cutting another npm version purely to carry it.

With GitHub authentication the value must begin with `io.github.<owner>/` — here `io.github.nimbus-agent/`. Add alongside `publishConfig`:

```json
  "mcpName": "io.github.nimbus-agent/nimbus",
```

**Confirm the exact value with the owner before publishing.** It is the server's public identity in the registry and it is baked into a published tarball, so it is a naming decision rather than a mechanical one. `server.json` itself is *not* added here — it names a published version, so it belongs in Task 5.

```bash
cd /c/gitrep/nimbus-mcp
bun -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log(p.mcpName ?? "MISSING")'
```

Expected: the `io.github.nimbus-agent/...` name, not `MISSING`.

- [ ] **Step 3: Write the failing test for the vendored installer contract**

Create `src/installer-contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import { INSTALLER_POSIX_SUFFIX, INSTALLER_WIN32_SUFFIX } from "./installer-contract.ts";
import { CANDIDATE_DIRS } from "./resolve-binary.ts";

test("the FIRST candidate on every platform is built from the vendored installer suffix", () => {
  // cross-platform-ok: these separators come from the vendored installer contract,
  // not from a host-path assumption.
  const localAppData = "C:\\Users\\u\\AppData\\Local";
  expect(CANDIDATE_DIRS("win32", "C:\\Users\\u", { LOCALAPPDATA: localAppData })[0]).toBe(
    `${localAppData}${INSTALLER_WIN32_SUFFIX}`,
  );
  expect(CANDIDATE_DIRS("darwin", "/Users/u", {})[0]).toBe(`/Users/u${INSTALLER_POSIX_SUFFIX}`);
  expect(CANDIDATE_DIRS("linux", "/home/u", {})[0]).toBe(`/home/u${INSTALLER_POSIX_SUFFIX}`);
});

test("the vendored suffixes are non-empty", () => {
  // A previous version of this guard asserted `length > 0` on the candidate list and
  // passed against [""]. Assert the constants themselves, so an emptied vendor file
  // cannot make the test above trivially true.
  expect(INSTALLER_WIN32_SUFFIX.length).toBeGreaterThan(0);
  expect(INSTALLER_POSIX_SUFFIX.length).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd /c/gitrep/nimbus-mcp && bun test src/installer-contract.test.ts
```

Expected: FAIL — `Cannot find module './installer-contract.ts'`.

- [ ] **Step 5: Write the vendored contract**

Create `src/installer-contract.ts`:

```ts
/**
 * The Nimbus installer's own output directories, vendored as literals.
 *
 * The source of truth is `scripts/install/lib/paths.ts` (`resolveInstallDir`) in the
 * nimbus-agent/Nimbus monorepo. This package is MIT and that file is AGPL-3.0, so the
 * values are copied with attribution rather than imported — copying two path literals
 * creates neither a package dependency nor a licence problem.
 *
 * These directories are tried FIRST when resolving the `nimbus` binary, and they matter
 * precisely when an MCP client spawns this launcher WITHOUT the user's shell PATH (the
 * normal case for a GUI-launched editor on macOS). A stale value here reports
 * "Could not find the Nimbus CLI" against a perfectly good install.
 *
 * DRIFT GUARD: this file cannot detect a change on the installer side by itself — a
 * vendored copy is a change-detector, not a two-sided contract. The real guard lives in
 * the monorepo: `scripts/structure-audit/check-launcher-installer-contract.ts`, run by
 * the `launcher-installer-contract` job in `.github/workflows/org-drift-sweep.yml`,
 * clones this repo and fails if these two literals stop matching `resolveInstallDir`.
 * If you rename either constant, update that script's parser in the same change.
 */

/** Appended to `%LOCALAPPDATA%` on Windows. */
export const INSTALLER_WIN32_SUFFIX = String.raw`\Programs\Nimbus\bin`;

/** Appended to `$HOME` on macOS and Linux. */
export const INSTALLER_POSIX_SUFFIX = "/.local/bin";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /c/gitrep/nimbus-mcp && bun test src/installer-contract.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Red-prove the guard by breaking the vendored value**

A guard that has never failed is not known to work. Verify it fails for the right reason:

```bash
cd /c/gitrep/nimbus-mcp
sed -i 's|/.local/bin|/.wrong/bin|' src/installer-contract.ts
bun test src/installer-contract.test.ts   # EXPECT: FAIL on the darwin + linux assertions
git checkout src/installer-contract.ts 2>/dev/null || sed -i 's|/.wrong/bin|/.local/bin|' src/installer-contract.ts
bun test src/installer-contract.test.ts   # EXPECT: PASS again
```

If the first run passes, the test is not wired to the constants — fix it before continuing.

- [ ] **Step 8: Replace the severed text-read guard in `resolve-binary.test.ts`**

Open `src/resolve-binary.test.ts`. Delete the block from the `INSTALLER_PATHS_SRC` declaration through the end of the `"the FIRST candidate on every platform is the installer's own output directory"` test — that is roughly lines 73–117, including the `installerWin32Suffix()` and `installerPosixSuffix()` helpers. Its relative path (`../../../scripts/install/lib/paths.ts`) does not resolve outside the monorepo, so leaving it in place produces an ENOENT, not a guard.

Also remove the now-unused imports it needed:

```ts
// DELETE these two lines if nothing else in the file uses them:
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
```

Then add this comment where the deleted block was, so the next reader knows where the guard went:

```ts
/**
 * The installer-directory drift guard that used to live here read
 * `scripts/install/lib/paths.ts` as text out of the monorepo. That relative path does
 * not exist in this repo. It is replaced by `installer-contract.test.ts` (vendored
 * constants, checked every PR) plus the monorepo's cross-repo
 * `launcher-installer-contract` sweep job, which is the half that can actually see the
 * installer move.
 */
```

- [ ] **Step 9: Run the full suite**

```bash
cd /c/gitrep/nimbus-mcp && bun test
```

Expected: PASS, all files. If `resolve-binary.test.ts` errors on a missing import, you left a stale `readFileSync`/`resolve` reference — remove it.

- [ ] **Step 10: Point the README at the new home**

In `README.md`, replace the "Running from a local checkout" path:

```json
      "args": ["/absolute/path/to/Nimbus/packages/mcp-launcher/src/index.ts"]
```

with:

```json
      "args": ["/absolute/path/to/nimbus-mcp/src/index.ts"]
```

Leave the "Not published to npm yet" block in place for now — Task 4 removes it, and removing it before the package is live would be exactly the false claim this whole program exists to prevent.

- [ ] **Step 11: Add a CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3"
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
      - run: bun run build
```

Pin `oven-sh/setup-bun` to a commit SHA before merging — `org-drift-sweep.yml`'s `sha-pins` job audits exactly this, and Task 8 adds this repo to that audit. Resolve the SHA with:

```bash
gh api repos/oven-sh/setup-bun/git/refs/tags/v2 --jq '.object.sha'
```

- [ ] **Step 11b: Nothing to seed here — resolved by the Task 1 research**

`server.json` names a published version in two places, so it cannot be seeded before the first publish; it is created in Task 5 Step 2. The half that *must* ship early is `mcpName` in `package.json`, which is Step 2c above. This step is a deliberate no-op — tick it and move on.

- [ ] **Step 12: Commit and push**

```bash
cd /c/gitrep/nimbus-mcp
git add -A
git commit -m "feat: seed the launcher from the Nimbus monorepo

Source moved verbatim from packages/mcp-launcher. The installer-directory drift
guard is re-expressed as vendored constants; the cross-repo half lands in the
monorepo's org-drift-sweep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin main
```

Note: `git add -A` is used here only because this is a brand-new empty repo where every file is intentional. Do **not** use it in the monorepo.

---

### Task 2b: Scaffold the repo to org standard

A repo with source and no scaffolding is not a satellite — it is a directory. `nimbus-client` is the template throughout this task: it is the closest analogue (MIT, single npm package, OIDC-published, no VS Code marketplace complications). Copy from the local clone at `C:\gitrep\nimbus-client`, adapting names — do not invent files.

Verified inventory of `nimbus-client` as of 2026-08-20: `CLAUDE.md` (56 lines), `README.md` (135), `CONTRIBUTING.md` (93), `SECURITY.md` (37), `ROADMAP.md` (16), `LICENSE` (MIT), `.gitattributes`, `.gitignore`, `.editorconfig`, `.bun-version` (`1.3.14`), `biome.json`, `sonar-project.properties`, `.coderabbit.yaml`, `.claude/commands/nimbus-client-boundaries.md`, and `.github/` containing `CODEOWNERS`, `dependabot.yml`, `pull_request_template.md`, `codeql/codeql-config.yml`, `ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`, and `workflows/{ci,cla,codeql,release,sonar}.yml`.

**Files:**

- Create (new repo): `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.gitattributes`, `.gitignore`, `.editorconfig`, `.bun-version`, `biome.json`, `sonar-project.properties`, `.coderabbit.yaml`, `.claude/commands/nimbus-mcp-boundaries.md`, `.github/**`

**Interfaces:**

- Consumes: the seeded source from Task 2.
- Produces: the CI job names that Task 8's `required_status_checks` contexts must match exactly.

- [ ] **Step 1: Copy the mechanical config files**

These need no adaptation beyond the package name:

```bash
cd /c/gitrep/nimbus-mcp
for f in .gitattributes .gitignore .editorconfig .bun-version biome.json .coderabbit.yaml; do
  cp "/c/gitrep/nimbus-client/$f" . && echo "copied $f"
done
mkdir -p .github/ISSUE_TEMPLATE .github/codeql .claude/commands
cp /c/gitrep/nimbus-client/.github/CODEOWNERS .github/
cp /c/gitrep/nimbus-client/.github/dependabot.yml .github/
cp /c/gitrep/nimbus-client/.github/pull_request_template.md .github/
cp /c/gitrep/nimbus-client/.github/codeql/codeql-config.yml .github/codeql/
cp /c/gitrep/nimbus-client/.github/ISSUE_TEMPLATE/*.yml .github/ISSUE_TEMPLATE/
```

`.gitattributes` is `* text=auto eol=lf` — load-bearing, because `biome.json` enforces `lineEnding: lf` and a CRLF checkout on Windows would fail lint on every file.

- [ ] **Step 2: Verify nothing copied still says "client"**

```bash
cd /c/gitrep/nimbus-mcp
grep -rn "nimbus-client\|@nimbus-dev/client" .github .coderabbit.yaml biome.json .editorconfig 2>/dev/null
```

Every hit is a file needing adaptation in the next steps. A `CODEOWNERS` or `dependabot.yml` still naming the client package is the kind of thing that silently routes reviews to the wrong place.

- [ ] **Step 3: Copy the three CI workflows that are not the release workflow**

`release.yml` is Task 3's job. These three are this task's:

```bash
cd /c/gitrep/nimbus-mcp
cp /c/gitrep/nimbus-client/.github/workflows/cla.yml .github/workflows/
cp /c/gitrep/nimbus-client/.github/workflows/codeql.yml .github/workflows/
cp /c/gitrep/nimbus-client/.github/workflows/sonar.yml .github/workflows/
```

This supersedes the minimal `ci.yml` written in Task 2 Step 11 — replace that file with `nimbus-client`'s, which already carries the 3-OS `build-test` matrix that Task 8's required-checks list expects:

```bash
cp /c/gitrep/nimbus-client/.github/workflows/ci.yml .github/workflows/ci.yml
grep -n "name:\|runs-on:\|matrix:" .github/workflows/ci.yml | head -20
```

Adapt any step that assumes client-specific scripts (`verify:sdk`, `check-package-identity`) — the launcher has no sdk dependency, so those steps are deleted, not stubbed.

- [ ] **Step 4: Record the exact job names Task 8 will need**

```bash
cd /c/gitrep/nimbus-mcp
grep -n "^\s*name:" .github/workflows/*.yml
```

Write the resulting check-context names into the precedent doc. `nimbus-client`'s `General` ruleset requires exactly six contexts — `build-test (ubuntu-24.04)`, `build-test (macos-latest)`, `build-test (windows-latest)`, `Analyze (javascript-typescript)`, `SonarQube Cloud analysis`, `cla`. Task 8 Step 6 sets the same list, so a job renamed here and not there produces a ruleset that blocks every PR forever waiting on a check that will never report.

- [ ] **Step 5: Write `CLAUDE.md`**

Model it on `nimbus-client/CLAUDE.md` — same section order (`What this is` / `Stack` / `Commands` / `Cross-repo relationships` / `Design invariants` / `Notes`), same brevity (56 lines there; this package is smaller, so shorter).

````markdown
# nimbus-mcp — Claude Code Context

## What this is

`@nimbus-dev/mcp` — the **MIT-licensed launcher** that exposes a locally-installed
Nimbus index and its agents to any MCP client. It does no work itself: it locates the
`nimbus` binary already on the machine and execs it as `nimbus mcp-server --stdio`,
then passes stdio straight through.

**The MCP server is not in this repo.** It lives in the AGPL monorepo at
`packages/cli/src/commands/mcp-server.ts` + `packages/cli/src/mcp/`. This package only
knows how to *find* the binary — never how to run the gateway.

## Stack

- **Runtime:** Bun v1.2+ · **Language:** TypeScript 7.x strict · **Linter:** Biome
- **Zero runtime dependencies.** Not "few" — zero. Adding one is a licence and
  supply-chain decision, not a convenience call.
- **No `any`** — use `unknown` for external data; strict mode is non-negotiable.

## Commands

```bash
bun run typecheck   # tsc --noEmit
bun run test        # bun test
bun run build       # bun build src/index.ts --target node --outdir dist
```

## Cross-repo relationships

- [`Nimbus`](https://github.com/nimbus-agent/Nimbus) — the gateway/CLI monorepo. Owns
  the MCP server this launcher starts, and owns the installer whose output directories
  `src/installer-contract.ts` vendors.

## Design invariants

- **MIT, and it must stay importable-from-nothing.** This package must never import
  from the AGPL monorepo. `src/installer-contract.ts` vendors two path literals with
  attribution — copying values is fine, importing code is not.
- **`src/installer-contract.ts` is half of a cross-repo contract.** The other half is
  `scripts/structure-audit/check-launcher-installer-contract.ts` in the monorepo, run
  by two jobs there (`install-smoke.yml` at PR time, `org-drift-sweep.yml` on a
  schedule). Renaming either exported constant breaks that parser — change both sides
  in the same sitting.
- **Resolution order is `NIMBUS_BIN` → `PATH` → known install dirs, installer dir
  first.** The fallback exists because a GUI-launched editor on macOS spawns this
  process without the user's shell `PATH`. A wrong first candidate reports
  "Could not find the Nimbus CLI" against a perfectly good install.

## Notes

- Releases: Conventional Commits → release-please → `npm publish` via OIDC trusted
  publishing (no npm token; `publishConfig.access` is `public` because the package is
  scoped).
````

- [ ] **Step 6: Write `CONTRIBUTING.md` and `SECURITY.md`**

Copy both from `nimbus-client` and adapt. `SECURITY.md` is 37 lines and largely repo-agnostic — change the repo name and the "what this package does" sentence. `CONTRIBUTING.md` is 93 lines; delete the sdk-linking section (no dependency here) and the coverage-gate section if this repo has no Sonar gate yet, rather than describing gates that do not exist.

```bash
cd /c/gitrep/nimbus-mcp
cp /c/gitrep/nimbus-client/SECURITY.md .
cp /c/gitrep/nimbus-client/CONTRIBUTING.md .
grep -n "client\|sdk" SECURITY.md CONTRIBUTING.md
```

Every hit from that grep is an edit to make. Do not leave a `CONTRIBUTING.md` that tells a contributor to run `bun run verify:sdk`.

- [ ] **Step 7: Write the `.claude` skill**

`nimbus-client` carries exactly one: `.claude/commands/nimbus-client-boundaries.md`, and its own opening states the rule — `CLAUDE.md` and `CONTRIBUTING.md` "win on doctrine", the skill is "the part that is expensive to rediscover: which guard is load-bearing and which is theatre."

Create `.claude/commands/nimbus-mcp-boundaries.md` with that same job. Frontmatter:

```markdown
---
name: nimbus-mcp-boundaries
description: >
  Where this launcher ends and the Nimbus monorepo begins, and which of its guards
  prove less than they look. Use when changing binary resolution, touching
  `src/installer-contract.ts`, adding a dependency, or debugging a release/publish.
---
```

The body must carry the three things that are expensive to rediscover and are **not** obvious from the code: (1) the installer-contract guard is two-sided and the other half lives in another repository, so a green `bun test` here proves only that this side is self-consistent; (2) the zero-dependency rule is a licence boundary, not a preference; (3) `src/index.ts` is a bin entry with top-level side effects, which is why it is coverage-exempt and why a test importing it would spawn a process.

- [ ] **Step 8: Add the `test:coverage` script `sonar.yml` calls**

`sonar.yml` runs `bun run test:coverage`, and the launcher's `package.json` has only `build` / `typecheck` / `test`. Without this the Sonar job fails on a missing script before it ever reaches the scanner. Add, matching `nimbus-client`:

```json
    "test:coverage": "bun test --coverage --coverage-reporter=lcov",
```

Verify it produces the file `sonar-project.properties` points at:

```bash
cd /c/gitrep/nimbus-mcp
bun run test:coverage && ls -la coverage/lcov.info
```

Expected: `coverage/lcov.info` exists and is non-empty.

- [ ] **Step 9: Adapt `sonar-project.properties`**

```bash
cd /c/gitrep/nimbus-mcp
cp /c/gitrep/nimbus-client/sonar-project.properties .
```

Then edit. `nimbus-client`'s layout has `src/`, `scripts/` and `test/`; this repo has only `src/`, with tests alongside sources. The `sonar.tests` note in the copied file is load-bearing and its reasoning carries over: *every* directory that can hold a test file must appear in `sonar.tests`, or `sonar.test.inclusions` cannot reclassify it and Sonar analyses a test as production source.

```properties
sonar.organization=nimbus-agent
sonar.projectKey=nimbus-agent_nimbus-mcp
sonar.host.url=https://sonarcloud.io
sonar.sourceEncoding=UTF-8

sonar.sources=src
sonar.tests=src
sonar.test.inclusions=**/*.test.ts

sonar.exclusions=**/node_modules/**,**/dist/**,**/*.d.ts

# `src/index.ts` is a shebang bin entry: top-level side effects that spawn a child
# process, so it cannot be unit-tested without launching one. The monorepo exempted
# the same file for the same reason (scripts/coverage-floor/exclusions.ts).
sonar.coverage.exclusions=src/index.ts

sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.typescript.tsconfigPaths=tsconfig.json

sonar.qualitygate.wait=true
```

- [ ] **Step 10: Import the SonarCloud project**

In the `nimbus-agent` SonarCloud org, import `nimbus-agent/nimbus-mcp`. The project key must match `sonar.projectKey=nimbus-agent_nimbus-mcp` exactly.

No repo secret is created here — see the next step for why.

- [ ] **Step 10b: Grant the four SELECTED-visibility org secrets to `nimbus-mcp`**

**Do not run `gh secret set --repo`.** Verified 2026-08-20: `nimbus-client` and `nimbus-sdk` each have **zero** repo-level secrets. Every credential comes from the org, and four of the five are `SELECTED` visibility — meaning each carries an explicit repo list that a new repo is not on. Minting a repo-level copy would spread a credential to save a config call, which is the same anti-pattern `docs/ci-secrets.md` refuses for `VSCE_PAT`.

| Org secret | Visibility | Currently granted to | Consequence if `nimbus-mcp` is not added |
|---|---|---|---|
| `SONAR_TOKEN` | SELECTED (7) | awesome-nimbus, create-nimbus-connector, Nimbus, nimbus-client, nimbus-sdk, nimbus-vscode, nimbus-web-clipper | Analysis step silently skips; check reports **green** having analysed nothing |
| `CLA_BOT_CLIENT_ID` | SELECTED (7) | same seven | `cla` job fails — and `cla` is a **required check**, so every PR blocks |
| `CLA_BOT_PRIVATE_KEY` | SELECTED (7) | same seven | same |
| `RELEASE_BOT_PRIVATE_KEY` | SELECTED (5) | create-nimbus-connector, Nimbus, nimbus-client, nimbus-sdk, nimbus-vscode | release-please cannot open its PR; Task 4 has nothing to merge |
| `RELEASE_BOT_CLIENT_ID` | **ALL** | every repo | Nothing — it is already available |

Note the fifth row: `RELEASE_BOT_CLIENT_ID` is `ALL` while its private key is `SELECTED`. Granting one without the other is a silent half-configuration, so the key is on the list above and the id is not.

Add the repo to each list by id — `PUT .../repositories/{id}` adds one repo without touching the secret's value or the rest of its list, unlike `gh secret set --org --repos`, which replaces the whole list and demands the value:

```bash
REPO_ID="$(gh api repos/nimbus-agent/nimbus-mcp --jq '.id')"
echo "nimbus-mcp id=${REPO_ID}"
for s in SONAR_TOKEN CLA_BOT_CLIENT_ID CLA_BOT_PRIVATE_KEY RELEASE_BOT_PRIVATE_KEY; do
  gh api -X PUT "orgs/nimbus-agent/actions/secrets/${s}/repositories/${REPO_ID}" \
    && echo "granted ${s}"
done
```

- [ ] **Step 10c: Verify all four grants landed**

```bash
for s in SONAR_TOKEN CLA_BOT_CLIENT_ID CLA_BOT_PRIVATE_KEY RELEASE_BOT_PRIVATE_KEY; do
  printf '%-24s ' "$s"
  gh api "orgs/nimbus-agent/actions/secrets/$s/repositories" --jq '.repositories[].name' \
    | grep -qx "nimbus-mcp" && echo "OK" || echo "MISSING"
done
```

Expected: four `OK` lines. A `MISSING` here is not cosmetic — two of the four block every PR on the new repo, and a third blocks the release this whole plan exists to produce.

- [ ] **Step 11: Verify the scan actually RAN — a green check is not proof**

This is the part worth being careful about. `sonar.yml`'s analysis **step** is guarded by `if: env.SONAR_TOKEN != ''`, but the **job** is not — so with no token the job still completes and the `SonarQube Cloud analysis` check still reports **green**. The workflow comment says this is deliberate: the check "passes until the project is imported into SonarCloud and the secret is set."

That means the failure mode here is the opposite of blocking: a repo can carry a green Sonar check forever while analysing nothing. Assert the step ran, not that the check passed:

```bash
gh run list --repo nimbus-agent/nimbus-mcp --workflow sonar.yml --limit 1
gh run view --repo nimbus-agent/nimbus-mcp \
  "$(gh run list --repo nimbus-agent/nimbus-mcp --workflow sonar.yml --limit 1 --json databaseId --jq '.[0].databaseId')" \
  --log | grep -i "SonarQube Cloud analysis\|quality gate\|skipped"
```

Expected: scanner output and a quality-gate verdict. If you see the analysis step **skipped**, the token is not reaching the job — fix that before treating the gate as real. With `sonar.qualitygate.wait=true`, a genuine gate ERROR fails the check, which is the behaviour you want and cannot observe until the token is in place.

- [ ] **Step 12: Verify the tree lints and tests clean**

```bash
cd /c/gitrep/nimbus-mcp
bun install
bun run typecheck && bun run test && bunx biome check .
```

Expected: all three pass. `biome check` is the one most likely to fail first, on line endings — that is `.gitattributes` doing its job.

- [ ] **Step 13: Commit and push**

```bash
cd /c/gitrep/nimbus-mcp
git add -A
git commit -m "chore: scaffold the repo to org standard

CLAUDE.md, CONTRIBUTING.md, SECURITY.md, the boundaries skill, CI/CodeQL/CLA/Sonar
workflows, and the shared config files, all adapted from nimbus-client.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Release-please + OIDC publish workflow

**Files:**

- Create (new repo): `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`

**Interfaces:**

- Consumes: `docs/superpowers/specs/2026-08-20-satellite-publish-precedent.md` from Task 1 — the workflow is adapted from the quoted `nimbus-sdk` text, not written from scratch.

- [ ] **Step 1: Copy `nimbus-client`'s release workflow — not `nimbus-sdk`'s**

Corrected 2026-08-20. The publish-route spec named `nimbus-sdk` as the precedent, but its `release.yml` is **680 lines** because it fans out across multiple language SDKs (it has a second `release-go.yml` too). `nimbus-client`'s is **201 lines** for one npm package at the repo root — exactly this repo's shape.

```bash
cp /c/gitrep/nimbus-client/.github/workflows/release.yml \
   /c/gitrep/nimbus-mcp/.github/workflows/release.yml
wc -l /c/gitrep/nimbus-mcp/.github/workflows/release.yml
```

Expected: 201 lines.

- [ ] **Step 2: Adapt exactly four identifiers — and nothing else**

Per the precedent doc §4:

1. App-token step: `repositories: nimbus-client` → `nimbus-mcp`.
2. `@nimbus-dev/client` → `@nimbus-dev/mcp` — three places: the install line in the signature-verify step, that step's error message, and the `package:` input of the provenance action.
3. `expected-repo: nimbus-agent/nimbus-client` → `nimbus-agent/nimbus-mcp`.
4. Nothing else.

Leave **byte-identical**: every pinned action SHA, the `permissions` blocks, `egress-policy: audit` on both harden-runner steps, the npm ≥ 11.5.1 preflight, the 8-attempt `--prefer-online` install-and-audit retry loop, and `expected-workflow: .github/workflows/release.yml`.

Two of those carry incident history worth not rediscovering: the retry loop exists because packument lag turned `0.6.1` red and attestation lag turned `0.6.0` red, and `--prefer-online` is required because npm caches the negative packument. The preflight exists because npm cannot unpublish after 72h, so a post-publish check reports damage rather than preventing it.

```bash
cd /c/gitrep/nimbus-mcp
grep -n "nimbus-client\|@nimbus-dev/client" .github/workflows/release.yml
```

Expected after editing: **no output**.

- [ ] **Step 3: Verify the permissions block is present and correct**

```bash
grep -n -A 5 "permissions:" "/c/gitrep/nimbus-mcp/.github/workflows/release.yml"
```

Expected: `id-token: write` (required for OIDC), `contents: write`, `pull-requests: write`. If `id-token: write` is missing, OIDC publishing cannot work — stop and re-read the precedent.

- [ ] **Step 4: Confirm no token-based publish crept in**

```bash
grep -n "NPM_TOKEN\|npm_token\|NODE_AUTH_TOKEN" \
  "/c/gitrep/nimbus-mcp/.github/workflows/release.yml" \
  || echo "clean — OIDC only"
```

Expected: `clean — OIDC only`.

- [ ] **Step 5: Write the release-please config**

Mirror `nimbus-client`'s, which is the verified shape. Create `release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "bootstrap-sha": "<the seed commit SHA from Task 2 Step 12>",
  "bump-minor-pre-major": true,
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "@nimbus-dev/mcp"
    }
  }
}
```

Resolve `bootstrap-sha` — it pins where release-please starts reading history, and without it release-please walks a history this repo does not have:

```bash
cd /c/gitrep/nimbus-mcp
git rev-parse HEAD
```

Create `.release-please-manifest.json`:

```json
{
  ".": "0.1.0"
}
```

`0.1.0` matches the version already in `package.json`, so the first run proposes a bump from the commits rather than re-cutting a version. `bump-minor-pre-major: true` means a `feat` below 1.0.0 bumps the minor, not the major — copied from client deliberately.

**This config produces `mcp-vX.Y.Z` tags, not `vX.Y.Z`.** Neither sibling sets `component` or `include-component-in-tag`, and both still tag `client-v*` / `typescript-v*` — the manifest strategy includes the component by default and derives it from the last segment of the package name. Task 8 Step 6b's tag ruleset depends on this.

- [ ] **Step 6: Validate both JSON files parse**

```bash
cd /c/gitrep/nimbus-mcp
bun -e 'JSON.parse(require("fs").readFileSync("release-please-config.json","utf8")); JSON.parse(require("fs").readFileSync(".release-please-manifest.json","utf8")); console.log("both parse")'
```

Expected: `both parse`.

- [ ] **Step 7: Set the repo to squash-only, matching every other org repo**

```bash
gh api -X PATCH repos/nimbus-agent/nimbus-mcp \
  -F allow_squash_merge=true -F allow_merge_commit=false \
  -F allow_rebase_merge=false -F delete_branch_on_merge=true
gh api repos/nimbus-agent/nimbus-mcp --jq \
  '{allow_squash_merge, allow_merge_commit, allow_rebase_merge}'
```

Expected: `true, false, false` — matching the Task 1 Step 4 output for `nimbus-sdk`.

- [ ] **Step 8: Commit and push**

```bash
cd /c/gitrep/nimbus-mcp
git add .github/workflows/release.yml release-please-config.json .release-please-manifest.json
git commit -m "ci: add release-please + OIDC trusted publishing

Adapted from nimbus-sdk's workflow; the OIDC preflight and both post-publish
provenance checks are copied byte-identical.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Register the trusted publisher and publish

**This task contains owner-performed manual steps.** npm's trusted-publisher registration is a web UI with no API equivalent, and the spec explicitly refuses to guess its field order. Do the UI steps by hand; every step below has a command that verifies the result.

**Files:** none in either repo — this is configuration plus a release.

- [ ] **Step 1: Confirm the package name is still unclaimed**

```bash
npm view @nimbus-dev/mcp version
```

Expected: `E404 Not Found`. If it resolves, someone published it — **stop** and investigate before doing anything else.

- [ ] **Step 2: Re-confirm the org role recorded at Task 1 Gate A**

Task 1 Gate A already established that the operator holds owner/admin on `nimbus-dev` — this is the point of use, so confirm the session is still authenticated rather than re-litigating the role:

> Run this yourself in the terminal: `! npm whoami` (and `! npm login` if it returns `E401`)

Expected: your username. If Gate A recorded that a *different* person holds owner rights, Steps 3 and 4 are theirs to perform — hand off rather than improvising a workaround.

- [ ] **Step 3: Register the trusted publisher (npm web UI)**

On npmjs.com → the `nimbus-dev` org → create/settings for `@nimbus-dev/mcp` → **Trusted Publisher**. Provide:

- Provider: GitHub Actions
- Repository owner: `nimbus-agent`
- Repository: `nimbus-mcp`
- Workflow filename: the release workflow's filename from Task 3 Step 1
- Environment: leave blank unless the precedent record from Task 1 says `nimbus-sdk` uses one

Record the exact field labels and order in the precedent doc as you go — that closes the gap the spec named, for the next package.

- [ ] **Step 4: Set publishing access to require 2FA and disallow tokens**

Same settings page → publishing access → **Require two-factor authentication and disallow tokens**. This is a Global Constraint, not an option: it is what makes a leaked token unable to publish, and it matches sdk/client.

- [ ] **Step 5: Trigger the release**

Merge the release-please PR that the Task 3 push produced. If none appeared, every commit so far is `feat`/`ci` — check the workflow run:

```bash
gh run list --repo nimbus-agent/nimbus-mcp --limit 5
gh pr list --repo nimbus-agent/nimbus-mcp
```

- [ ] **Step 6: Verify the publish succeeded**

```bash
npm view @nimbus-dev/mcp version
```

Expected: a real version. If the run failed, read the log — do **not** work around it by publishing from a laptop; that bypasses the provenance gate.

- [ ] **Step 7: Verify provenance and signatures independently**

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null
npm install @nimbus-dev/mcp --no-audit --no-fund
npm audit signatures
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/@nimbus-dev/mcp@$(npm view @nimbus-dev/mcp version)" \
  | jq -r '.attestations[].predicateType'
```

Expected: signatures verify, and **both** predicate types appear (the npm publish attestation and the SLSA provenance predicate naming `nimbus-agent/nimbus-mcp`). This is the first live exercise of that gate for this package — `docs/ci-secrets.md:365` notes neither sdk nor client had exercised it against a real publish as of 2026-07-20, so treat a failure here as informative, not as a reason to skip it.

- [ ] **Step 8: Smoke-test the published launcher end to end**

```bash
npx -y @nimbus-dev/mcp
```

Expected on a machine with Nimbus installed: it execs the gateway MCP server and waits on stdio (Ctrl-C to exit). On a machine without: the `explain()` error naming the searched directories — which is the resolution path the vendored contract protects.

- [ ] **Step 9: Remove the "not published" block from the README**

Now — and only now — delete the `> **Not published to npm yet.** ...` blockquote from the new repo's `README.md`, and delete the "Running from a local checkout" section it points at (the `npx` instructions above it are now true).

```bash
cd /c/gitrep/nimbus-mcp && git pull
# edit README.md
git add README.md
git commit -m "docs: @nimbus-dev/mcp is published — drop the unpublished caveat

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Submit to the official MCP Registry

This is the goal the whole extraction unblocks. Do it immediately after the publish, while the details are in hand.

**Files:** none in either repo (registry metadata may require a `server.json` in the new repo — confirm in Step 1, do not assume).

- [ ] **Step 1: Re-read the submission requirements recorded at Task 1 Step 5b**

Task 1 already captured the format into the precedent doc. Re-fetch rather than trusting the capture — the registry's requirements change, and days have passed since Task 1:

```bash
gh api repos/modelcontextprotocol/registry/contents/README.md --jq '.content' | base64 -d \
  > "$CLAUDE_JOB_DIR/tmp/mcp-registry-readme-now.md"
diff "$CLAUDE_JOB_DIR/tmp/precedent/mcp-registry-readme.md" \
     "$CLAUDE_JOB_DIR/tmp/mcp-registry-readme-now.md" && echo "unchanged since Task 1"
```

If the diff is non-empty, the requirements moved — work from the new version, and note the change in the precedent doc.

- [ ] **Step 2: Generate and edit `server.json`**

Resolved by the Task 1 research: `server.json` **is** version-dependent (both `version` and `packages[].version` name a published version), so it lands here, after the publish — not in Task 2. The `mcpName` half of the verification already shipped in the tarball at Task 2b Step 2c.

Install the CLI and generate the template:

```bash
brew install mcp-publisher 2>/dev/null || \
  curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
    | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
cd /c/gitrep/nimbus-mcp && mcp-publisher init
```

Edit the generated file so `name` matches the `mcpName` already published in `package.json`, and both `version` fields match the published npm version:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.nimbus-agent/nimbus",
  "description": "Exposes your local Nimbus index and agents to any MCP client.",
  "repository": { "url": "https://github.com/nimbus-agent/nimbus-mcp", "source": "github" },
  "version": "<published version>",
  "packages": [
    { "registryType": "npm", "identifier": "@nimbus-dev/mcp",
      "version": "<published version>", "transport": { "type": "stdio" } }
  ]
}
```

There are no `environmentVariables` to declare: the launcher reads `NIMBUS_BIN` as an *optional* override, not a required input, and declaring it as required would misrepresent the server. Validate before publishing:

```bash
mcp-publisher validate
```

- [ ] **Step 2b: Authenticate and publish to the registry**

Namespace ownership for `io.github.nimbus-agent/*` is satisfied by logging in as a member of the `nimbus-agent` org (or, later, by a GitHub Action running in one of its repos — GitHub OIDC is a supported auth method and is the natural way to automate this once it works by hand).

```bash
cd /c/gitrep/nimbus-mcp
mcp-publisher login github
mcp-publisher publish
mcp-publisher status
```

The registry is **in preview** — its own README warns that breaking changes or data resets may occur before GA. Treat a schema rejection as "re-read the current docs", not as a defect in this plan.

- [ ] **Step 3: Submit**

Follow the submission path from Step 1 (currently a PR or a CLI publish against the registry). Record the resulting PR/issue URL.

- [ ] **Step 4: Update the distribution program spec**

In `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`, change the "blocked — needs a packaging decision" status on the MCP Registry row to the submission URL and date. Commit in this repo on the Task 9 branch.

---

### Task 6: Add the cross-repo installer-contract drift guard

**Lands before Task 7.** This is the half of the old guard that can actually detect the installer moving.

**Files:**

- Create: `scripts/structure-audit/check-launcher-installer-contract.ts`
- Create: `scripts/structure-audit/check-launcher-installer-contract.test.ts`
- Modify: `.github/workflows/org-drift-sweep.yml`
- Modify: `package.json` (add the `audit:launcher-contract` script)

**Interfaces:**

- Consumes: `INSTALLER_WIN32_SUFFIX` / `INSTALLER_POSIX_SUFFIX` from `nimbus-mcp`'s `src/installer-contract.ts` (Task 2).
- Produces: `parseVendoredSuffixes(src: string): { win32: string | null; posix: string | null }` and `installerSuffixes(): { win32: string; posix: string }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/check-launcher-installer-contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  installerSuffixes,
  parseVendoredSuffixes,
} from "./check-launcher-installer-contract.ts";

// A backtick cannot be written inside a template literal that is itself
// backtick-delimited, and the fixture must contain one (the vendored file uses
// `String.raw`). Build it by concatenation rather than fighting the escaping.
const BT = "`";
const GOOD = [
  `export const INSTALLER_WIN32_SUFFIX = String.raw${BT}\\Programs\\Nimbus\\bin${BT};`,
  `export const INSTALLER_POSIX_SUFFIX = "/.local/bin";`,
].join("\n");

test("parses both vendored suffixes", () => {
  expect(parseVendoredSuffixes(GOOD)).toEqual({
    win32: String.raw`\Programs\Nimbus\bin`,
    posix: "/.local/bin",
  });
});

test("returns null for a renamed or missing constant rather than a wrong value", () => {
  // A rename must FAIL the audit, not silently match nothing and pass.
  const renamed = GOOD.replace("INSTALLER_POSIX_SUFFIX", "INSTALLER_UNIX_SUFFIX");
  expect(parseVendoredSuffixes(renamed).posix).toBeNull();
});

test("installerSuffixes derives from resolveInstallDir, not from a second copy", () => {
  expect(installerSuffixes()).toEqual({
    win32: String.raw`\Programs\Nimbus\bin`,
    posix: "/.local/bin",
  });
});

test("the vendored copy matches the installer today", () => {
  // The end-to-end assertion the sweep job runs. Kept here too so a change to
  // resolveInstallDir fails a local `bun test` immediately, not only on the sweep.
  const installer = installerSuffixes();
  expect(parseVendoredSuffixes(GOOD)).toEqual({
    win32: installer.win32,
    posix: installer.posix,
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/gitrep/Nimbus && bun test scripts/structure-audit/check-launcher-installer-contract.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `scripts/structure-audit/check-launcher-installer-contract.ts`:

```ts
#!/usr/bin/env bun
/**
 * Cross-repo drift guard for the extracted MCP launcher.
 *
 * `packages/mcp-launcher` used to live here, and its `resolve-binary.test.ts` read
 * `scripts/install/lib/paths.ts` as TEXT to assert the launcher's first-choice install
 * directory matched what the installer actually writes. The launcher now lives in
 * nimbus-agent/nimbus-mcp and vendors those two literals in `src/installer-contract.ts`,
 * which on its own is a change-detector, not a contract — nothing over there can see
 * this side move.
 *
 * This script is the missing half. `org-drift-sweep.yml` clones nimbus-mcp (the same way
 * its sha-pins job already clones every public repo) and runs this against the checkout,
 * so a change to `resolveInstallDir` fails loudly instead of silently stranding every
 * PATH-less MCP client on a wrong directory.
 *
 * Importing `resolveInstallDir` rather than re-reading its source is deliberate: both
 * files are AGPL and in this repo, so there is no licence reason to text-scrape, and an
 * import cannot drift from the function it is checking.
 */
import { readFileSync } from "node:fs";
import { resolveInstallDir } from "../install/lib/paths.ts";

export function parseVendoredSuffixes(src: string): {
  win32: string | null;
  posix: string | null;
} {
  const win = /INSTALLER_WIN32_SUFFIX\s*=\s*String\.raw`([^`]*)`/.exec(src);
  const posix = /INSTALLER_POSIX_SUFFIX\s*=\s*"([^"]*)"/.exec(src);
  return { win32: win?.[1] ?? null, posix: posix?.[1] ?? null };
}

export function installerSuffixes(): { win32: string; posix: string } {
  const localAppData = String.raw`C:\LAD`;
  const home = "/home/u";
  return {
    win32: resolveInstallDir("win32", { LOCALAPPDATA: localAppData }).slice(localAppData.length),
    posix: resolveInstallDir("linux", { HOME: home }).slice(home.length),
  };
}

function main(): void {
  const contractPath = process.argv[2];
  if (contractPath === undefined) {
    console.error(
      "usage: check-launcher-installer-contract.ts <path to nimbus-mcp/src/installer-contract.ts>",
    );
    process.exit(2);
  }
  const vendored = parseVendoredSuffixes(readFileSync(contractPath, "utf8"));
  const installer = installerSuffixes();
  const problems: string[] = [];
  if (vendored.win32 === null) {
    problems.push("INSTALLER_WIN32_SUFFIX not found (renamed? no longer a String.raw literal?)");
  } else if (vendored.win32 !== installer.win32) {
    problems.push(`win32: vendored '${vendored.win32}' != installer '${installer.win32}'`);
  }
  if (vendored.posix === null) {
    problems.push("INSTALLER_POSIX_SUFFIX not found (renamed? no longer a double-quoted literal?)");
  } else if (vendored.posix !== installer.posix) {
    problems.push(`posix: vendored '${vendored.posix}' != installer '${installer.posix}'`);
  }
  if (problems.length > 0) {
    for (const p of problems) {
      console.error(`::error file=scripts/install/lib/paths.ts::launcher contract drift — ${p}`);
    }
    console.error(
      "check-launcher-installer-contract: FAILED — update nimbus-mcp/src/installer-contract.ts to match, or revert the installer change.",
    );
    process.exit(1);
  }
  console.log("check-launcher-installer-contract: ok (win32 + posix suffixes match)");
}

if (import.meta.main) {
  main();
}
```

The `import.meta.main` guard is load-bearing: without it, importing this module from the test file executes `main()` and exits the test process.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /c/gitrep/Nimbus && bun test scripts/structure-audit/check-launcher-installer-contract.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Red-prove the audit end to end**

```bash
cd /c/gitrep/Nimbus
printf 'export const INSTALLER_WIN32_SUFFIX = String.raw`\\Programs\\Nimbus\\bin`;\nexport const INSTALLER_POSIX_SUFFIX = "/.wrong/bin";\n' \
  > "$CLAUDE_JOB_DIR/tmp/bad-contract.ts"
bun scripts/structure-audit/check-launcher-installer-contract.ts "$CLAUDE_JOB_DIR/tmp/bad-contract.ts"
echo "exit=$?"
```

Expected: the posix mismatch error and `exit=1`. Then confirm the real file passes:

```bash
bun scripts/structure-audit/check-launcher-installer-contract.ts \
  "/c/gitrep/nimbus-mcp/src/installer-contract.ts"
echo "exit=$?"
```

Expected: `ok` and `exit=0`.

- [ ] **Step 6: Add the package script**

In `package.json`, next to the other `audit:*` scripts, add:

```json
"audit:launcher-contract": "bun scripts/structure-audit/check-launcher-installer-contract.ts",
```

It takes the contract path as an argument, so it is run by the sweep with a path, not bare.

- [ ] **Step 7: Add the sweep job**

In `.github/workflows/org-drift-sweep.yml`, add a new job alongside the existing ones:

```yaml
  launcher-installer-contract:
    name: Launcher installer-path contract
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout Nimbus (owns scripts/install/lib/paths.ts)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Checkout nimbus-mcp (owns the vendored copy)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: nimbus-agent/nimbus-mcp
          path: .nimbus-mcp
          persist-credentials: false

      - uses: ./.github/actions/setup-nimbus-ci

      - name: Compare the vendored suffixes against resolveInstallDir
        run: |
          bun scripts/structure-audit/check-launcher-installer-contract.ts \
            .nimbus-mcp/src/installer-contract.ts
```

The `actions/checkout` SHA is copied from the existing jobs in this file — keep it identical so `sha-pins` stays consistent.

- [ ] **Step 7b: Close the PR-time window — hang the same check on `install-smoke.yml`**

The sweep job above runs on a schedule, so an installer change can merge before the mismatch is reported. Close that by running the identical audit at PR time on exactly the PRs that can break it. `.github/workflows/install-smoke.yml` **already** triggers on `scripts/install/**` (plus `workflow_dispatch`), so this needs no new workflow and costs nothing on the other ~95% of PRs.

Add a job to `.github/workflows/install-smoke.yml`:

```yaml
  launcher-contract:
    name: Launcher installer-path contract
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Checkout nimbus-mcp (owns the vendored copy)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: nimbus-agent/nimbus-mcp
          path: .nimbus-mcp
          persist-credentials: false

      - uses: ./.github/actions/setup-nimbus-ci

      - name: Compare the vendored suffixes against resolveInstallDir
        run: |
          bun scripts/structure-audit/check-launcher-installer-contract.ts \
            .nimbus-mcp/src/installer-contract.ts
```

**Keep the sweep job as well — the two catch different failures.** The `install-smoke` job fires when *this repo's* installer moves; it can never fire when the *satellite's* vendored file moves, because no monorepo path filter sees a commit in another repository. The sweep is the only thing watching that direction. Neither subsumes the other, and dropping either leaves one side of the contract unguarded.

**Why this and not a network fetch inside the test suite.** Fetching `raw.githubusercontent.com/.../installer-contract.ts` from a `bun test` run would be faster to write and is superficially attractive, but it puts a live network call in the unit suite: `bun test` would fail offline, fail during a GitHub incident, and go red on an unrelated PR whenever someone edits the satellite's `main`. This repo's testing philosophy is explicitly hermetic — integration tests use real SQLite and real subprocesses, but "no real cloud calls." A CI job with an `actions/checkout` is the same information at PR time with none of that coupling, and it reuses the checkout pattern `org-drift-sweep.yml` already established.

- [ ] **Step 8: Commit**

```bash
git switch -c dev/asaf/launcher-contract-guard
git add scripts/structure-audit/check-launcher-installer-contract.ts \
        scripts/structure-audit/check-launcher-installer-contract.test.ts \
        .github/workflows/org-drift-sweep.yml \
        .github/workflows/install-smoke.yml package.json
git commit -m "ci: guard the launcher installer-path contract across repos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Prove the job runs before relying on it**

A branch-only workflow change is not proven by a green PR — `org-drift-sweep.yml` runs on a schedule. Trigger it manually against the branch and read the log:

```bash
gh workflow run org-drift-sweep.yml --ref dev/asaf/launcher-contract-guard
sleep 30
gh run list --workflow org-drift-sweep.yml --limit 1
gh run view --log --job "$(gh run list --workflow org-drift-sweep.yml --limit 1 --json databaseId --jq '.[0].databaseId')" \
  | grep -A 3 "launcher-installer-contract"
```

Expected: the job appears and prints `check-launcher-installer-contract: ok`. If `workflow_dispatch` is not a trigger on that workflow, add it in this task — an unrunnable guard is not a guard.

Then prove the PR-time job too. `install-smoke.yml` already has `workflow_dispatch`, so:

```bash
gh workflow run install-smoke.yml --ref dev/asaf/launcher-contract-guard
sleep 30
gh run view --log --job "$(gh run list --workflow install-smoke.yml --limit 1 --json databaseId --jq '.[0].databaseId')" \
  | grep -A 3 "launcher-contract"
```

Expected: the same `ok` line. A branch-only workflow change is not proven by a green PR — the job must be observed running.

---

### Task 7: Remove `packages/mcp-launcher` from the monorepo

**Only after Task 4 reports a live npm version and Task 6 is merged.**

**Files:**

- Delete: `packages/mcp-launcher/` (entire directory)
- Modify: `package.json:37`, `package.json:214`, `scripts/lib/ci-tests.ts:43`, `.github/workflows/_test-suite.yml:267`, `.github/workflows/_test-suite.yml:318`, `scripts/coverage/instrument-scope.ts:4,15`, `scripts/coverage/instrument-scope.test.ts:32,39-40`, `scripts/coverage-floor/check.ts:154-159`, `scripts/coverage-floor/check.test.ts:215`, `scripts/coverage-floor/exclusions.ts:56-61`, `scripts/coverage-floor/build-lcov.sh:62,72,86`, `sonar-project.properties:109`, `scripts/structure-audit/platform-branching-allowlist.ts:183-187`, `docs/README.md:811`
- Regenerate: `bun.lock`

- [ ] **Step 1: Confirm the package is live before deleting anything**

```bash
npm view @nimbus-dev/mcp version
```

Expected: a real version. If this 404s, **stop** — Task 4 is not done and deleting now destroys the only copy.

- [ ] **Step 2: Branch**

```bash
cd /c/gitrep/Nimbus
git switch -c dev/asaf/remove-mcp-launcher
git rev-parse --abbrev-ref HEAD
```

Expected: `dev/asaf/remove-mcp-launcher`.

- [ ] **Step 3: Delete the package directory**

```bash
git rm -r packages/mcp-launcher
```

- [ ] **Step 4: Remove the two `package.json` entries**

In `package.json`, delete line 37 — the `"packages/mcp-launcher",` entry, indented four spaces — from the `workspaces` array, and change the `test` script on line 214 from:

```json
"test": "bun test packages/gateway packages/cli packages/mcp-connectors packages/mcp-launcher scripts",
```

to:

```json
"test": "bun test packages/gateway packages/cli packages/mcp-connectors scripts",
```

- [ ] **Step 5: Remove the CI test wiring**

In `scripts/lib/ci-tests.ts`, delete line 43 — the `"packages/mcp-launcher",` entry, indented four spaces — from the `runInitialUnitTestsWithCoverage` args array.

In `.github/workflows/_test-suite.yml` line 267, change:

```yaml
          for pkg in packages/gateway packages/cli packages/mcp-launcher; do
```

to:

```yaml
          for pkg in packages/gateway packages/cli; do
```

And on line 318, remove `packages/mcp-launcher` from the `bun test` argument list, taking the single space that precedes it so the remaining arguments stay singly spaced.

- [ ] **Step 6: Remove the coverage instrumentation scope**

In `scripts/coverage/instrument-scope.ts`, change line 15 from:

```ts
const FIRST_PARTY = /\/packages\/(?:gateway|cli|mcp-launcher)\/src\//;
```

to:

```ts
const FIRST_PARTY = /\/packages\/(?:gateway|cli)\/src\//;
```

and delete the `mcp-launcher` sentence from the comment block at line 4.

In `scripts/coverage/instrument-scope.test.ts`, delete the `"instruments mcp-launcher src — its tests run, so its source must be measured"` test (around lines 39–41) and the comment above it at line 32 that references `build-lcov.sh` running mcp-launcher's tests since #1047.

- [ ] **Step 7: Remove the coverage-floor scope and its test**

In `scripts/coverage-floor/check.ts`, delete the `new Glob("packages/mcp-launcher/src/**/*.ts"),` on line 159 **and** the five-line comment above it (lines 154–158, beginning "Measured (instrument-scope.ts) and its tests run").

In `scripts/coverage-floor/check.test.ts`, delete the assertion on line 215:

```ts
    expect(files).toContain("packages/mcp-launcher/src/resolve-binary.ts");
```

- [ ] **Step 8: Remove the paired exclusion entries — both, in this commit**

This is the parity trap. In `scripts/coverage-floor/exclusions.ts`, delete the comment at lines 56–60 and the entry on line 61:

```ts
  { kind: "exact", path: "packages/mcp-launcher/src/index.ts" },
```

In `sonar-project.properties` line 109, remove `packages/mcp-launcher/src/index.ts,` from the comma-separated `sonar.coverage.exclusions` value. Take the comma with it; do not leave a doubled comma.

- [ ] **Step 9: Verify the parity gate agrees**

```bash
bun scripts/coverage-floor/check-exclusion-parity.ts
echo "exit=$?"
```

Expected: `check-exclusion-parity: ok (N sonar patterns all covered)` and `exit=0`. If it fails naming `packages/mcp-launcher/src/index.ts`, you removed the `exclusions.ts` entry but not the sonar one.

- [ ] **Step 10: Remove the lcov build loop entry**

In `scripts/coverage-floor/build-lcov.sh`, change line 72:

```bash
for pkg in packages/gateway packages/cli packages/mcp-launcher; do
```

to:

```bash
for pkg in packages/gateway packages/cli; do
```

Delete the `mcp-launcher` comment block at lines 62–65. On line 86, the comment reads "the same two-switch bug the `mcp-launcher` comment above describes" — rewrite it so it still explains the bug without pointing at a deleted comment:

```bash
# Omitting them is the two-switch bug: a package's tests can run while its
# source is not instrumented (or the reverse), and the floor then reports a
# confident 0% — or nothing at all — for files it never measured.
```

- [ ] **Step 11: Remove the platform-branching allowlist entry**

In `scripts/structure-audit/platform-branching-allowlist.ts`, delete the entire entry at lines 183–187 (the `{ file: "packages/mcp-launcher/src/index.ts", ... }` object). Its `why` text carries a claim that is already false — that no coverage-threshold gate covers the launcher — so it must not be reused elsewhere.

- [ ] **Step 12: Update the repository tree**

In `docs/README.md`, delete line 811:

```text
│   ├── mcp-launcher/         # The @nimbus-dev/mcp npm launcher (unpublished)
```

- [ ] **Step 13: Regenerate the lockfile**

```bash
bun install
git diff --stat bun.lock
```

Expected: `bun.lock` loses the `packages/mcp-launcher` workspace block and the `@nimbus-dev/mcp` alias. Commit the regenerated file — do not hand-edit it.

- [ ] **Step 14: Confirm no live references remain**

```bash
grep -rn "mcp-launcher" --include="*.ts" --include="*.json" --include="*.yml" \
  --include="*.sh" --include="*.properties" --include="*.md" \
  . 2>/dev/null | grep -v node_modules | grep -v "^./docs/CHANGELOG.md" \
    | grep -v "^./docs/superpowers/" | grep -v "^./bun.lock"
```

Expected: **no output**. `docs/CHANGELOG.md` and `docs/superpowers/` are excluded because their references are historical records of decisions, which stay accurate. `CLAUDE.md` and `GEMINI.md` will still match — they are Task 9.

- [ ] **Step 15: Run the static gates**

```bash
bun run preflight:fast
```

Expected: PASS. If `audit:coverage-floor` complains about a missing baseline entry, re-run with the baseline update it names — removing files from the floor's scope narrows the denominator and can require a re-bank.

- [ ] **Step 16: Run the affected test suites**

```bash
bun test scripts/coverage-floor scripts/coverage scripts/structure-audit
```

Expected: PASS. Failures here are almost certainly a test still asserting the launcher is in scope — Steps 6 and 7 cover the two known ones.

- [ ] **Step 17: Verify on Linux, because the coverage floor is Linux-authoritative**

```bash
bun run verify:docker
```

Expected: PASS. `audit:coverage-floor` is CI-Linux-authoritative and a Windows-local run produces false violations — do not skip this on the grounds that Step 15 was green.

- [ ] **Step 18: Commit**

```bash
git add -u
git add package.json bun.lock
git commit -m "chore: remove packages/mcp-launcher — extracted to nimbus-agent/nimbus-mcp

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Use `git add -u` and explicit paths, never `git add -A` — this repo's history has a trap around that.

---

### Task 8: Add `nimbus-mcp` to the six org enumeration sites

**Files:**

- Modify: `.github/workflows/org-drift-sweep.yml` (four sites), `.github/rulesets/general-branch.json` (two sites)

- [ ] **Step 1: Add to the `sha-pins` matrix**

In `.github/workflows/org-drift-sweep.yml`, in the `repo:` list (currently 9 entries, lines 28–36), add `nimbus-mcp` after `nimbus-sdk`:

```yaml
        repo:
          - nimbus-client
          - nimbus-sdk
          - nimbus-mcp
          - nimbus-vscode
          - nimbus-web-clipper
          - create-nimbus-connector
          - .github
          - linux-repo
          - homebrew-tap
          - scoop-bucket
```

This job clones each public repo to audit its Action pins, which is why Task 2 Step 11 required a SHA-pinned `setup-bun`.

- [ ] **Step 2: Add to the three App-token CSVs**

Line 78 (`ruleset-drift`):

```yaml
          repositories: Nimbus,nimbus-client,nimbus-sdk,nimbus-mcp,nimbus-vscode,nimbus-web-clipper,create-nimbus-connector
```

Line 165 (`cla-coverage`):

```yaml
          repositories: Nimbus,nimbus-sdk,nimbus-mcp,nimbus-client,nimbus-vscode,nimbus-web-clipper,awesome-nimbus,create-nimbus-connector
```

Line 197 (`review-coverage`):

```yaml
          repositories: Nimbus,nimbus-sdk,nimbus-mcp,nimbus-client,nimbus-vscode,nimbus-web-clipper,create-nimbus-connector
```

Preserve each list's existing order and membership — they are deliberately different from one another (`awesome-nimbus` appears only in `cla-coverage`).

- [ ] **Step 3: Add to `bypass.by_repo`**

In `.github/rulesets/general-branch.json`, add to the `bypass.by_repo` object, mirroring `nimbus-sdk` and `nimbus-client` (empty array — no bypass actors):

```json
      "nimbus-sdk": [],
      "nimbus-mcp": [],
```

Do **not** copy `nimbus-vscode`'s `OrganizationAdmin` entry. sdk and client are the right analogues: MIT npm packages with no manual-publish escape hatch.

- [ ] **Step 4: Add to the `repos` array**

```json
  "repos": [
    "Nimbus",
    "nimbus-client",
    "nimbus-sdk",
    "nimbus-mcp",
    "nimbus-vscode",
    "nimbus-web-clipper",
    "create-nimbus-connector"
  ]
```

- [ ] **Step 5: Validate the JSON**

```bash
bun -e 'const j=JSON.parse(require("fs").readFileSync(".github/rulesets/general-branch.json","utf8")); console.log("repos:",j.repos.length,"bypass:",Object.keys(j.bypass.by_repo).length)'
```

Expected: `repos: 7 bypass: 7`. If the two counts disagree, one of Steps 3–4 was missed — `audit:ruleset-drift` diffs every entry in `repos`, so a repo in one and not the other is a silent gap.

- [ ] **Step 6: Create the two repo-level rulesets**

`nimbus-client` carries **four** rulesets, and only two of them are this task's work (verified 2026-08-20):

| Ruleset | Target | Source | Action |
|---|---|---|---|
| `org-baseline: default branch integrity` | branch | **Organization** | Applies automatically — nothing to do |
| `org-baseline: release tags immutable` | tag | **Organization** | Applies automatically — nothing to do |
| `General` | branch | Repository | **Create** |
| `Protected release tags` | tag | Repository | **Create** |

Confirm the two org-level ones landed on the new repo before creating anything:

```bash
gh api repos/nimbus-agent/nimbus-mcp/rulesets --jq '.[] | {name, source_type}'
```

Expected: both `org-baseline:*` entries with `"source_type": "Organization"`. If they are absent, the org ruleset does not target new repos automatically and that is a separate finding — report it rather than hand-rolling a substitute.

Create `General` to match `nimbus-client`'s exactly, substituting the check contexts recorded in Task 2b Step 4:

```bash
gh api -X POST repos/nimbus-agent/nimbus-mcp/rulesets --input - <<'JSON'
{
  "name": "General",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "dismissal_restriction": { "enabled": false, "allowed_actors": [] },
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "build-test (ubuntu-24.04)" },
          { "context": "build-test (macos-latest)" },
          { "context": "build-test (windows-latest)" },
          { "context": "Analyze (javascript-typescript)" },
          { "context": "SonarQube Cloud analysis" },
          { "context": "cla" }
        ]
      }
    }
  ]
}
JSON
```

`bypass_actors: []` is deliberate and matches sdk/client — **do not** copy `nimbus-vscode`'s `OrganizationAdmin` entry, and keep it consistent with the `"nimbus-mcp": []` added in Step 3.

**The required-checks list is the trap.** Each context must match a job name that actually reports on a PR. A context naming a job that does not exist leaves every PR permanently pending, with no error explaining why — so the list above is copied from `nimbus-client`'s live ruleset and cross-checked against the job names Task 2b Step 4 recorded, not typed from memory.

All six contexts are correct as listed. `SonarQube Cloud analysis` in particular stays: the SonarCloud project is being created (Task 2b Step 10), and — separately — `sonar.yml`'s **job** always reports regardless of the token, because only the analysis *step* carries `if: env.SONAR_TOKEN != ''`. So this context can never be the thing that hangs a PR. Its risk runs the other way, and Task 2b Step 11 covers it: a green check that analysed nothing.

- [ ] **Step 6b: Create the tag ruleset — but derive the prefix, do not guess it**

**The prefix is `mcp-v*`, not `v*`.** This was verified 2026-08-20 and corrects the plan's first draft. Observed live tags: `nimbus-client` → `client-v0.17.3`, `nimbus-sdk` → `typescript-v1.19.0`. Neither config sets `component` or `include-component-in-tag`; release-please's manifest strategy defaults to including the component, and the component defaults to the last segment of the package name. So `@nimbus-dev/mcp` tags `mcp-vX.Y.Z`.

This is a silent failure if you get it wrong: a ruleset on `refs/tags/v*` would match nothing, the real tags would stay mutable, and **nothing reports an unmatched ruleset**. Confirm after the first release regardless:

```bash
gh api repos/nimbus-agent/nimbus-mcp/tags --jq '.[].name' | head -5
```

Create it now with the derived prefix:

```bash
gh api -X POST repos/nimbus-agent/nimbus-mcp/rulesets --input - <<'JSON'
{
  "name": "Protected release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/tags/mcp-v*"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ]
}
JSON
```

This is what makes release tags immutable with **no bypass actors, admins included** — the property the monorepo relies on when it says a failed release is abandoned and never retagged.

- [ ] **Step 6c: Verify all four rulesets are present**

```bash
gh api repos/nimbus-agent/nimbus-mcp/rulesets --jq '.[] | {name, target, enforcement, source_type}'
```

Expected: four entries matching the table above — two `Organization`, two `Repository`, all `active`. Compare side by side with the reference:

```bash
diff <(gh api repos/nimbus-agent/nimbus-client/rulesets --jq '[.[] | {name, target, source_type}] | sort_by(.name)') \
     <(gh api repos/nimbus-agent/nimbus-mcp/rulesets    --jq '[.[] | {name, target, source_type}] | sort_by(.name)') \
  && echo "ruleset shape matches nimbus-client"
```

- [ ] **Step 7: Run the drift audit**

```bash
bun run audit:ruleset-drift
```

Expected: PASS with `nimbus-mcp` included. A failure naming `nimbus-mcp` means Step 6's ruleset does not match `shared` — fix the ruleset, not the expectation.

- [ ] **Step 8: Add the CLA and CodeRabbit config to the new repo**

`cla-coverage` and `review-coverage` will now check `nimbus-mcp`. Mirror what `nimbus-sdk` carries:

```bash
gh api repos/nimbus-agent/nimbus-sdk/contents/.coderabbit.yaml --jq '.content' | base64 -d \
  > "/c/gitrep/nimbus-mcp/.coderabbit.yaml"
gh api repos/nimbus-agent/nimbus-sdk/contents/.github/workflows/cla.yml --jq '.content' | base64 -d \
  > "/c/gitrep/nimbus-mcp/.github/workflows/cla.yml"
```

Commit and push those in the new repo. If either 404s, list the sdk repo's contents and use the real filenames.

- [ ] **Step 9: Commit**

```bash
cd /c/gitrep/Nimbus
git add .github/workflows/org-drift-sweep.yml .github/rulesets/general-branch.json
git commit -m "ci: register nimbus-mcp in the org drift sweep and branch ruleset

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Reverse the documentation

The spec's "Consequence" section already worked out the exact wording change. Follow it rather than re-deriving.

**Files:**

- Modify: `CLAUDE.md:90` and `:93-98`, `GEMINI.md:90` and the matching satellite list, `docs/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md` (the Task 5 Step 4 status update, if not already committed)

- [ ] **Step 1: Delete the subsystem bullet in `CLAUDE.md`**

Remove line 90 entirely:

```markdown
- `packages/mcp-launcher` — the `@nimbus-dev/mcp` npm launcher (`nimbus-mcp` bin) that resolves and execs the local gateway MCP server. **Not yet published to npm** — publishing it is what unblocks the official MCP Registry listing (see `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`).
```

The spec is explicit that the "Not yet published" clause is **deleted, not flipped to "published"** — the sdk/client bullets carry no published/unpublished framing at all, and adding one here would re-introduce the drift this whole exercise is cleaning up.

- [ ] **Step 2: Add the satellite bullet in `CLAUDE.md`**

In the "Several surfaces live in their own standalone repos" list, after the `@nimbus-dev/client` bullet, add:

```markdown
- The **`@nimbus-dev/mcp`** MCP-server launcher (`nimbus-mcp` bin) — [nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) (MIT); resolves the installed `nimbus` binary and execs `nimbus mcp-server --stdio`, so any MCP client reaches the local index and agents. The MCP server itself stays here (`packages/cli/src/commands/mcp-server.ts` + `packages/cli/src/mcp/`).
```

That last sentence matters: the launcher left, the server did not, and a reader who assumes otherwise will go looking for `mcp-server.ts` in the wrong repo.

- [ ] **Step 3: Make the same two edits in `GEMINI.md`**

`GEMINI.md` mirrors `CLAUDE.md` and its line 90 is byte-identical. Apply Steps 1 and 2 there too — CLAUDE.md's own instructions require updating both.

- [ ] **Step 4: Verify both files agree**

```bash
diff <(sed -n '85,100p' CLAUDE.md) <(sed -n '85,100p' GEMINI.md) && echo "in sync"
```

Expected: `in sync`. Line numbers shift by one after the deletion, so widen the range if the diff shows only an offset.

- [ ] **Step 5: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, under today's date, add:

```markdown
- **`@nimbus-dev/mcp` extracted and published** — `packages/mcp-launcher` moved to
  [nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) and published to npm via
  OIDC trusted publishing, matching `@nimbus-dev/sdk` and `@nimbus-dev/client`. Unblocks the
  official MCP Registry listing. The installer-directory drift guard the launcher carried is
  replaced by vendored constants plus the new `launcher-installer-contract` job in
  `org-drift-sweep.yml`. Branch B of
  `docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md`.
```

Leave the existing line 799 reference untouched — it records a past fix and is still true about the past.

- [ ] **Step 6: Confirm the only remaining matches are historical**

```bash
grep -rn "mcp-launcher" --include="*.md" . 2>/dev/null | grep -v node_modules
```

Expected: matches only in `docs/CHANGELOG.md` and `docs/superpowers/{specs,plans}/`. Any match in `CLAUDE.md`, `GEMINI.md`, or `docs/README.md` means Steps 1–3 or Task 7 Step 12 were missed.

- [ ] **Step 7: Run the doc gates**

```bash
bun run preflight:fast
bunx markdownlint-cli2 CLAUDE.md GEMINI.md docs/CHANGELOG.md docs/README.md
```

Expected: PASS. `preflight:fast` includes the doc-refs audit, which will fail on a link to a path that no longer exists — that is the check catching Step 1 if it was done sloppily.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md GEMINI.md docs/CHANGELOG.md \
        docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md
git commit -m "docs: record the launcher extraction and drop the monorepo subsystem bullet

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Open the PR**

Tasks 7, 8 and 9 can ship as one PR (they are one logical change and splitting them leaves `main` in a state where the docs and the tree disagree). Task 6 ships separately and first.

```bash
git push -u origin dev/asaf/remove-mcp-launcher
gh pr create --title "chore: extract the MCP launcher to nimbus-agent/nimbus-mcp" --body "$(cat <<'EOF'
`packages/mcp-launcher` is now `@nimbus-dev/mcp`, published from
[nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) via OIDC trusted
publishing. This removes it from the monorepo and registers the new repo in the org sweep.

Branch B of `docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md`.

The installer-directory drift guard that `resolve-binary.test.ts` carried is not dropped:
it is split into vendored constants in the satellite plus the `launcher-installer-contract`
job added to `org-drift-sweep.yml` in the preceding PR, which is the half that can see this
repo's installer move.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Check the PR body renders with balanced parentheses before merging — an unbalanced `(` in a PR body has silently dropped commits from release-please here three times.

---

## Self-Review

**Spec coverage.** Every Branch B cost the spec names has a task: the six enumeration sites (Task 8), the `workspaces`/`test`-script edit (Task 7 Steps 4–5), the severed `resolve-binary.test.ts` drift check (Tasks 2 Step 8 + 6), the CLA/review-coverage entries (Task 8 Step 8), the release-please + OIDC setup mirroring sdk/client (Tasks 1, 3, 4), and the `CLAUDE.md`/`GEMINI.md` reversal quoted in the spec's "Consequence" section (Task 9). The two gaps the spec explicitly refused to guess — the npm trusted-publisher UI field order and the satellite workflow shape — are handled by reading rather than inventing (Task 1; Task 4 Step 3 records the UI as it goes).

**Beyond the spec.** The nine monorepo sites the spec did not enumerate are in Task 7 with exact line numbers, along with the `check-exclusion-parity` ordering trap and the stale coverage-scope claim in `platform-branching-allowlist.ts:186`.

**Added after the first review pass.** The repo is cloned to `C:\gitrep\nimbus-mcp` alongside its six siblings rather than a temp directory (Task 2 Step 1, threaded through every later `cd`). Task 2b scaffolds it to org standard from the verified `nimbus-client` inventory — root docs, the one `.claude` skill, four workflows, and the shared config files. Task 8 Step 6 creates the two **repository**-level rulesets with the live JSON shape read off `nimbus-client`, and records that the two `org-baseline:*` rulesets are **Organization**-sourced and apply on their own; Step 6b adds the immutable-tag ruleset with the prefix derived rather than assumed; Step 6c diffs the finished shape against `nimbus-client`. The coupling this introduces — Task 2b's job names must equal Task 8's `required_status_checks` contexts, or every PR hangs forever on a check that never reports — is called out in both places and in the sequencing diagram.

**The drift guard, after review.** The first draft of this plan replaced a per-PR check with a scheduled-only one and said so. That was a real regression and it is now fixed: Task 6 Step 7b hangs the same audit on `install-smoke.yml`, which already triggers on `scripts/install/**`, so the check fires at PR time on exactly the changes that can break it — no new workflow, no cost on unrelated PRs. The sweep job stays because it covers the opposite direction (a change to the *satellite's* vendored file, which no monorepo path filter can observe). Both directions are now guarded, and Task 6 Step 9 proves both jobs actually run.

**Remaining weaknesses, stated plainly.** Two, neither worth pre-paying to close. (1) The vendored constants are still a *copy*: nothing prevents someone editing `installer-contract.ts` and `paths.ts` in the same sitting to two different wrong values — the guard proves agreement, not correctness. (2) `install-smoke.yml`'s path filter is the thing deciding when the PR-time check runs, so moving `resolveInstallDir` out of `scripts/install/` would silently drop it from the trigger set. That failure mode is why the scheduled sweep is kept rather than deleted as redundant.

**Type consistency.** `parseVendoredSuffixes` / `installerSuffixes` are named identically in Task 6 Steps 1, 3, and 5. `INSTALLER_WIN32_SUFFIX` / `INSTALLER_POSIX_SUFFIX` are named identically in Task 2 Steps 3 and 5 and in Task 6's regexes; Task 2 Step 5's docstring names the consuming script so a rename cannot happen on one side silently. `CANDIDATE_DIRS` matches its existing export in `resolve-binary.ts`.
