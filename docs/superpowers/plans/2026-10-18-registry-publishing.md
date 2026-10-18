# Extension Registry Publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extension author can scaffold, build, sign and publish an extension to a git-repository registry they do not own; the registry repo's CI checks the PR and, after a human merge and a human-approved signing run, re-signs the index on `gh-pages`; the extension then installs and RUNS.

**Architecture:** Three PRs, each opened against `main` only after the previous one has merged (never stacked). PR A extracts the registry rules into a new pure workspace `packages/registry-format` used by gateway and CLI (no behaviour change). PR B makes the first-author path work: scaffold template, `extension sign` publisher fill-in, package file set, the publish validator with the § 11 rules, and `nimbus extension publish`. PR C adds the GitHub Action (check/sign), `registry maintain init --github`, the release-build commit SHA, the acceptance test and the docs.

**Tech Stack:** Bun 1.4, TypeScript 7 strict, `@nimbus-dev/sdk` (deprecated NFC `canonicalize`), `tweetnacl`, `tar` ^7.5.22, node24 JavaScript action bundled with `bun build --target=node`.

**Spec:** `docs/superpowers/specs/2026-10-18-registry-publishing-design.md` (§ 11 is binding; read it with this plan).

## Global Constraints

- No `any`; external data is `unknown` and validated; TypeScript strict; `path.join`, no hardcoded separators; Windows/macOS/Linux for all CLI code.
- `packages/registry-format` imports nothing from `packages/gateway`, `packages/cli`, `packages/ui`; uses no `bun:*`, no `Bun.*` API, no DB, no `node:child_process`. Allowed deps: `@nimbus-dev/sdk`, `tweetnacl`, `tar`, `node:*` pure modules (`crypto`, `fs`, `path`, `os`, `zlib`).
- Canonical bytes: the SDK's deprecated NFC `canonicalize` only — never `@nimbus-dev/sdk/signing`.
- Caps (unchanged from project 1): manifest ≤ 64 KiB, package ≤ 50 MiB compressed, unpacked ≤ 200 MiB, ≤ 5000 entries, index ≤ 8 MiB.
- Extension id → service id: `ext_` + `id.toLowerCase()` with non-`[a-z0-9]` → `_`, total matching `/^ext_[a-z0-9_]{1,62}$/`.
- Package file set: `nimbus.extension.json`, everything under `dist/`, and top-level files matching `/^(README|LICENSE)(\..+)?$/i`; manifest `entry` must be inside `dist/`.
- Every `git`/`gh` child process: argv array, never a shell string, `windowsHide: true`.
- Every `uses:` in emitted workflow YAML is `@<40-hex>` with a `# vX` comment; every job has `timeout-minutes`.
- Commit/PR: specs and plans never reach `main` — at each PR boundary cut `dev/asaf/registry-publish-pr<N>` from `origin/main` after the previous PR merged, carry the code commits (cherry-pick or re-apply), `git rm -r docs/superpowers` there, open against `main`. Set the final conventional-commit PR title BEFORE asking the owner to merge.
- Before each PR: `bun run preflight:fast`, focused tests; `bun run preflight` for PR B and C; Linux coverage via Docker (`oven/bun:1.4`) for new source files.

## Review Focus

1. A Windows author whose clone has CRLF checkout: `manifest.json` committed through git with autocrlf must still be byte-identical to the one in `package.tgz` → publish writes the registry files with `.gitattributes` `* -text` under `extensions/` (Task 8 test `publish writes extensions with -text so CRLF checkout cannot change bytes`; `init --github` writes that `.gitattributes`, Task 11).
2. An author on a machine without `gh` gets a complete, copy-pasteable set of commands, not a stack trace → Task 8 test `no gh on PATH prints push and pr commands`.
3. A second publisher key under an existing publisher id — the cross-extension squat — is refused by publish, check and sign alike → Task 6 test `validator refuses a second key for an existing publisher id across extensions`.
4. Two merges land while a signing run is waiting for approval: the approved run signs both, the next run signs nothing and makes no commit → Task 10 test `sign over two new dirs signs both; a second run is a no-op`.
5. A scaffold name that is valid for `scaffold mcp` but whose `<publisher>/<name>` id exceeds the service-id limit is refused at scaffold time with the limit in the message → Task 5 test `scaffold refuses an id whose service id would exceed 62 characters`.

---

# PR A — `packages/registry-format` (pure refactor, no behaviour change)

### Task 1: Create the workspace and register it everywhere CI looks

**Files:**
- Create: `packages/registry-format/package.json` (`@nimbus-dev/registry-format`, `private: true`, `license: "AGPL-3.0-only"`, `type: "module"`, scripts `typecheck: "tsc --noEmit"`, `test: "bun test src"`; deps `@nimbus-dev/sdk ^2.0.0`, `tweetnacl` (same version as gateway), `tar ^7.5.22`), `packages/registry-format/tsconfig.json` (extends `../../tsconfig.base.json`, includes `src/**/*.ts`, `"types": ["node"]` — no Bun types), `packages/registry-format/src/index.ts`, `packages/registry-format/README.md`
- Modify: root `package.json` (`workspaces`; root `test` script paths), `scripts/lib/ci-tests.ts` (`UNIT_TEST_PATHS`), `.github/workflows/_test-suite.yml` (the per-package loop ~L344 and the macOS/Windows command ~L412), `.github/workflows/ci.yml` (~L539), `scripts/coverage/instrument-scope.ts` (add `registry-format`), `scripts/coverage-floor/check.ts` (`discoverSourceFiles` glob), `scripts/structure-audit/check-boundaries.ts` (`REQUIRED_SOURCES_GLOB` adds `registry-format`), `.dependency-cruiser.cjs` (new rule `registry-format-is-pure`: `from: { path: "^packages/registry-format/src" }`, `to: { path: "^packages/(gateway|cli|ui)/src" }`, severity error), `knip.json` (workspace block), `CLAUDE.md` + `GEMINI.md` (workspace count and list)
- Test: `scripts/ci/cross-platform-parity.test.ts` (must still pass), `packages/registry-format/src/index.test.ts`

**Interfaces:** Produces the importable package `@nimbus-dev/registry-format` (gateway and CLI depend on it with `"@nimbus-dev/registry-format": "workspace:*"`).

- [ ] **Step 1:** Write `index.test.ts` asserting `import * as rf from "@nimbus-dev/registry-format"` resolves from both `packages/gateway` and `packages/cli` test contexts (one smoke test per consumer, placed in `packages/gateway/src/extensions/registry/registry-format-import.test.ts` and `packages/cli/src/lib/registry-format-import.test.ts`).
- [ ] **Step 2:** Run them — FAIL (package missing).
- [ ] **Step 3:** Create the package and every registration above; `bun install`; commit `bun.lock`.
- [ ] **Step 4:** Run the smoke tests, `bun test scripts/ci/cross-platform-parity.test.ts`, `bun run typecheck`, `bun run audit:boundaries`, `bun run audit:dead-code` — PASS.
- [ ] **Step 5:** Commit `build: add the pure registry-format workspace`.

### Task 2: Move the format, signer and pure id/manifest rules into the workspace

**Files:**
- Create in `packages/registry-format/src/`: `errors.ts` (moved `RegistryErrorCode` + `RegistryError` from `gateway/src/extensions/registry/registry-errors.ts`), `index-format.ts` (moved from gateway; same exports), `sign.ts` (moved from `cli/src/lib/registry-index.ts`: `publicKeyFromSeed`, `verifyIndexSignature`, `emptyIndex`, `signIndex`), `extension-id.ts` (`MAX_EXTENSION_ID_LENGTH = 128`, `assertSafeExtensionId`, `deriveExtensionServiceId`, `EXTENSION_SERVICE_ID_PATTERN`, `findServiceIdPrefixCollision`), `manifest.ts` (moved `parseExtensionManifestForRegistry`, `RegistryParseResult`, `extensionEntryRelPath`, `DEFAULT_EXTENSION_ENTRY`, `PUBLISHER_ID_RE`, `PUBLISHER_KEY_RE` exported, the permissions validator), `fingerprint.ts` (`publisherKeyFingerprint`), tests moved alongside (golden vector ONCE, here)
- Modify: the gateway files keep thin re-exports ONLY where many importers exist, otherwise importers are updated to `@nimbus-dev/registry-format` — `gateway/src/extensions/{manifest.ts,install-from-local.ts,extension-service-id.ts,registry/index-format.ts,registry/registry-errors.ts}`, `gateway/src/util/service-id-prefix.ts`; `cli/src/lib/registry-index.ts` keeps only `readIndexFile`/`writeIndexAtomic` (fs I/O) and imports the rest
- Delete: the CLI golden-vector duplicate test (now one test in the workspace)

**Interfaces:**
- Produces (exact names as today): `RegistryIndex`, `RegistryVersionEntry`, `RegistryExtensionEntry`, `RegistryChannel`, `MAX_INDEX_BYTES`, `isValidSemver`, `parseRegistryIndex`, `registryIndexSigningBytes`, `verifyRegistryIndexSelf`, `verifyRegistryIndexPinned`, `RegistryError`, `RegistryErrorCode`, `signIndex`, `emptyIndex`, `publicKeyFromSeed`, `verifyIndexSignature`, `assertSafeExtensionId`, `deriveExtensionServiceId(id: string): string` (throws `RegistryError("ERR_REGISTRY_MANIFEST_INVALID", …)` in the workspace; the gateway wrapper keeps throwing `ExtensionRunGrantError` for its callers), `findServiceIdPrefixCollision`, `parseExtensionManifestForRegistry`, `extensionEntryRelPath`, `PUBLISHER_ID_RE`, `PUBLISHER_KEY_RE`, `publisherKeyFingerprint`.

- [ ] **Step 1:** Move tests first (they fail: modules missing in the workspace).
- [ ] **Step 2:** Run `bun test packages/registry-format` — FAIL.
- [ ] **Step 3:** Move code; update importers; keep behaviour byte-identical (golden vector literal unchanged).
- [ ] **Step 4:** Run `bun test packages/registry-format packages/gateway/src/extensions packages/gateway/src/ipc packages/cli/src`, `bun run typecheck`, `bun run audit:boundaries`, `bun run audit:invariants` (static rules that name moved files — D22(h), D33 — may need their paths updated; keep their intent) — PASS.
- [ ] **Step 5:** Commit `refactor: registry format, signer and id rules live in registry-format`.

### Task 3: Move the package file set, packer and inspection into the workspace

**Files:**
- Create in `packages/registry-format/src/`: `package-set.ts` (`PACKAGE_MANIFEST_FILE`, `isPackageFile(relPath: string): boolean`, `listPackageFiles(dir: string): string[]` — sorted, `/`-separated, refuses symlinks/special files), `pack.ts` (moved `packExtensionDir` from `cli/src/lib/registry-pack.ts`, now packing ONLY `listPackageFiles(dir)`), `inspect.ts` (moved `inspectPackage` from `cli/src/commands/registry-maintain.ts`; returns `{ manifestBytes, manifest, entryHash, files }`), `caps.ts` (`MAX_MANIFEST_BYTES`, `MAX_PACKAGE_BYTES`, `MAX_UNPACKED_BYTES`, `MAX_ENTRY_COUNT`)
- Modify: `cli/src/lib/registry-pack.ts` (delete or re-export), `cli/src/commands/registry-maintain.ts` (import from the workspace; its own `SEMVER_RE`/`PUBLISHER_ID_RE`/`KEY_RE`/`fingerprint`/`assertSafeId` duplicates removed in favour of the workspace), the gateway's `MAX_TARBALL_BYTES` users keep their constant but a parity test asserts it equals `MAX_PACKAGE_BYTES`
- Test: move/adapt `registry-pack.test.ts` and the maintain coverage tests; update fixtures whose entry is not under `dist/`

**Interfaces:** Produces `isPackageFile`, `listPackageFiles`, `packExtensionDir(srcDir: string, outFile: string): Promise<void>`, `inspectPackage(tgz: string, work: string): Promise<InspectedPackage>`, caps constants.

- [ ] **Step 1:** Tests: `listPackageFiles keeps manifest, dist and README/LICENSE and drops node_modules, src and tests`; `LICENSE.md and readme.txt match case-insensitively`; `packing the same tree twice is byte-identical`; existing inspect tests ported.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Move and adapt.
- [ ] **Step 4:** Run the workspace, CLI registry and gateway extension tests, typecheck — PASS.
- [ ] **Step 5:** Commit `refactor: package file set, packer and inspection live in registry-format`.

**PR A close:** CHANGELOG (refactor, no behaviour change), `docs/architecture.md` (registry-format workspace), Linux coverage via Docker for `packages/registry-format/src` (the floor now scans it — add tests until it passes), PR title `refactor(extensions): registry format and rules move to a pure shared workspace`.

---

# PR B — the first-author path (after PR A merged)

### Task 4: The publish validator (§ 11 rules 1, 2, 4, 5)

**Files:** Create `packages/registry-format/src/validate-publish.ts` (+ test)

**Interfaces:**
```ts
export interface RegistryConfig { format: 1; requirePublisherNamespace: boolean }
export function parseRegistryConfig(bytes: Uint8Array): RegistryConfig;           // unknown keys refused
export interface PublishCandidate { dirId: string; dirVersion: string; manifestBytes: Uint8Array; packageBytes: Uint8Array; publishRequestBytes: Uint8Array }
export interface PublishVerdict { id: string; version: string; channel: RegistryChannel; name: string; publisher: { id: string; key: string }; entryHash: string; manifestSha256: string; packageSha256: string; packageSizeBytes: number; newId: boolean; permissions: unknown }
export async function validatePublish(c: PublishCandidate, signed: RegistryIndex, config: RegistryConfig, work: string): Promise<PublishVerdict>; // throws RegistryError
```
Checks, in order: publish-request schema (exact keys, channel); manifest parse (registry-format manifest rules) and ≤ 64 KiB; `id`/`version` equal dir path and publish-request; I16 signature with the manifest's own key; fingerprint equals publish-request; namespace rule (`id` starts with `<publisher.id>/`) when required; service-id derivable; NEW id's service id has no prefix collision with any indexed id; publisher id ↔ key 1:1 across ALL indexed extensions; version not already indexed; package caps + inspection; inner `nimbus.extension.json` bytes === `manifestBytes`; entry inside `dist/`; package files === the package file set.

- [ ] **Step 1:** One failing test per rule above, each asserting the specific `ERR_REGISTRY_*` code, plus `validator refuses a second key for an existing publisher id across extensions` (Review Focus 3) and a happy path.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(extensions): one publish validator for CLI, check and sign`.

### Task 5: Scaffold template (`scaffold extension` split from `scaffold mcp`)

**Files:** Modify `packages/cli/src/commands/scaffold.ts` (+ test); `scaffold mcp` output unchanged.

**Interfaces:** `parseScaffoldArgs` returns `{ kind: "extension"; name; publisher?: string }` for `extension`; `buildExtensionScaffoldFiles(name, publisher, platform, absDir): readonly ScaffoldFile[]`.

Emits `nimbus.extension.json` (`id` = `<publisher>/<name>` or `<name>`, `version 0.1.0`, `name`, `entry: "dist/index.js"`, empty permissions, `updateChannel: "stable"`, `publisher: { id }` when `--publisher`), `src/server.ts` starting the stdio server unconditionally, `package.json` with `build: "bun build src/server.ts --target=bun --outfile dist/index.js"`, a test, README with the next steps, `.gitignore`.

- [ ] **Step 1:** Tests: manifest parses with `parseExtensionManifestForRegistry`; build script is the single-file `--target=bun` bundle (no `--compile`); server source has no `import.meta.main`; `scaffold refuses an id whose service id would exceed 62 characters` (Review Focus 5); `scaffold mcp` output byte-identical to before.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit `feat(cli): scaffold extension writes an installable, runnable extension`.

### Task 6: `nimbus extension sign` fills in the publisher key

**Files:** Modify `packages/cli/src/commands/extension.ts` (`runExtensionSign`) (+ test)

Behaviour: manifest has `publisher.id` and no `publisher.key` → set `key` = signing key's public half, then sign; both present and key ≠ signing key → refuse (exit 2, message names both fingerprints); no `publisher` → today's behaviour.

- [ ] Steps 1–5 (tests for the three cases; commit `feat(cli): extension sign fills in the publisher key from the signing key`).

### Task 7: `registry maintain add` uses the shared validator and file set

**Files:** Modify `packages/cli/src/commands/registry-maintain.ts` (+ tests). `add` builds a `PublishCandidate` (writing a synthetic publish request with `--channel`) and calls `validatePublish`, so a maintainer and a CI check can never disagree; namespace rule read from `<dir>/nimbus-registry.json` when present (absent → not required, i.e. today's behaviour for project-1 registries).

- [ ] Steps 1–5 (parity test: a package refused by `validatePublish` is refused by `maintain add` with the same code; commit `refactor(cli): registry maintain add validates through the shared publish validator`).

### Task 8: `nimbus extension publish`

**Files:** Create `packages/cli/src/commands/extension-publish.ts` (+ test), `packages/cli/src/lib/run-git.ts` (`runTool(cmd: "git" | "gh", args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>` with `windowsHide: true`, argv only; injectable in tests); Modify `extension.ts` dispatch, help, `docs/cli-reference.md`

**Interfaces:** `runExtensionPublish(args: string[], deps?: { runTool; tmpdir; log }): Promise<number>`

Flow per spec § 7.2 + § 11.9: local `validatePublish` against the registry's `gh-pages` state (`git show origin/gh-pages:index.json`, `…:nimbus-registry.json`), clone `--depth 1 --no-single-branch` or `--clone`, branch `publish/<id>/<version>`, write the three files + ensure `extensions/.gitattributes` contains `* -text` (Review Focus 1), commit, then `gh repo fork --remote` / `git push` / `gh pr create --title "Publish <id>@<version>" --body … --head …` when `gh auth status` succeeds, else print the exact commands.

- [ ] **Step 1:** Integration tests with real temp git repos and a local bare remote that has `main` and `gh-pages`: writes only the three files on the branch and never `index.json`; `publish writes extensions with -text so CRLF checkout cannot change bytes`; refuses a duplicate version / changed key / non-namespaced id before touching git; a fake `gh` on PATH receives the expected argv; `no gh on PATH prints push and pr commands` (Review Focus 2).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit `feat(cli): nimbus extension publish opens a registry pull request`.

**PR B close:** CHANGELOG, `docs/cli-reference.md` (scaffold extension, extension sign, extension publish), `docs/contributors/extension-author-walkthrough.md` updated to the real flow, Linux coverage, `bun run preflight`. PR title `feat(extensions): publish extensions to a registry repository`.

---

# PR C — registry CI and the first registry (after PR B merged)

### Task 9: The action package and its bundle guarantees

**Files:** Create `packages/github-actions/registry-action/{action.yml,package.json,README.md,src/main.ts,src/check.ts,src/sign.ts,src/git-tree.ts,dist/index.js}`; `scripts/audit/check-action-dist-drift.ts` (+ test, + `package.json` script `audit:action-dist`, + `scripts/lib/preflight-gates.ts` entry); a closure test `packages/github-actions/registry-action/src/closure.test.ts`

`action.yml`: `runs.using: node24`, `main: dist/index.js`, input `mode` (`check|sign`), `root-key` (sign only). `git-tree.ts`: `listTreeEntries(ref: string, prefix: string)` via `git ls-tree -r -z` returning `{ mode, path, blob }`, `readBlob(ref, path): Uint8Array` via `git cat-file blob`; refuses modes other than `100644` under `extensions/` (§ 11.4).

- [ ] **Step 1:** Tests: `closure test: the bundle has no bun:* import and does not reach gateway, cli, DB or sqlite-vec modules` (build with `bun build --target=node`, inspect the metafile/outputs); drift gate fails when `dist/` differs from a fresh build; `git-tree refuses a symlink and a submodule entry` (real temp repo with a `120000` entry).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit `feat(ci): registry action package with a Bun-free bundle and a dist drift gate`.

### Task 10: `check` and `sign` modes

**Files:** `src/check.ts`, `src/sign.ts` (+ tests). Both call `validatePublish` (Task 4) with candidates read through `git-tree.ts`.

- `check`: diff `origin/<base>...HEAD` must only ADD the three files of exactly one new `extensions/<id>/<version>/`; anything else fails; then `validatePublish` against `origin/gh-pages`'s signed index + config; write the job summary (id, version, channel, fingerprint, **NEW ID** banner, declared permissions, "no runtime check of the package is performed").
- `sign`: read latest `origin/<default>` and `origin/gh-pages`; § 11.6 config-loosening refusal; § 11.7 already-signed integrity (hash equality, no deletions); for each unsigned dir `validatePublish` — skip+`::warning` on failure (§ 11.8); refuse if root key's public half ≠ index `rootKey`; add passing entries, `sequence + 1`, sign, write site (index + referenced files + `nimbus-registry.json`) into a `gh-pages` checkout, commit, push; on non-fast-forward re-fetch and retry from the top up to 3 times; no change → no commit.

- [ ] **Step 1:** Tests over real temp repos with `main` and `gh-pages`: check accepts a good publish and rejects a changed `index.json`, a workflow edit, a config edit, another extension's files, a second version dir; `sign over two new dirs signs both; a second run is a no-op` (Review Focus 4); sign skips an invalid dir with a warning and signs the rest; sign refuses a modified signed version, a deleted signed version, a loosened config, a wrong root key; the signed index verifies with project 1's client (`verifyRegistryIndexPinned`) and installs (`installFromRegistry` against a local `file:` registry of the gh-pages tree).
- [ ] **Step 2–4:** fail → implement → pass; rebuild `dist/`. **Step 5:** Commit `feat(ci): registry action check and sign modes`.

### Task 11: `nimbus registry maintain init --github` and the release commit SHA

**Files:** Modify `packages/cli/src/commands/registry-maintain.ts` (+ tests), `.github/workflows/release.yml` (CLI build steps get `--define NIMBUS_RELEASE_COMMIT='"${{ github.sha }}"'`), Create `packages/cli/src/release-commit.ts` (`export const NIMBUS_RELEASE_COMMIT: string | undefined` read from the define, `undefined` in dev), workflow templates in `packages/cli/src/commands/registry-templates/` (as TS string builders)

Writes per spec § 7.5 + § 11 (exact tree; `extensions/.gitattributes` `* -text`); action ref `nimbus-agent/Nimbus/packages/github-actions/registry-action@<NIMBUS_RELEASE_COMMIT or --action-ref>  # v<NIMBUS_VERSION>`; refuses `--github` when neither exists; `actions/checkout` pinned by SHA (constant in the template module, with version comment).

- [ ] **Step 1:** Tests: exact file tree; no `index.json` in `<dir>`; site folder has the signed empty index + config; `every uses: is @<40-hex>`; `lintWorkflow` returns no errors for both files; check workflow has `on: pull_request`, `permissions: contents: read`, no `environment`; sign workflow has `on: push` (default branch) + `workflow_dispatch`, `environment: registry-signing`, `permissions: contents: write`, `concurrency: { group: registry-sign, cancel-in-progress: false }`; dev build without `--action-ref` refuses.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit `feat(cli): registry maintain init --github writes a pinned registry repository`.

### Task 12: Acceptance and docs

**Files:** Create `packages/cli/test/registry-publish-acceptance.test.ts` (or under `packages/gateway/test/e2e/` if it needs a real gateway — it does for the run step); docs: `docs/architecture.md` (publishing + registry repo layout), `docs/cli-reference.md`, `docs/roadmap.md` (Phase 9.5 "Author publishing flow" + "registry-side publish hook" rows, with what did not ship), `docs/registry-hosting.md` (the § 7.6 owner steps), `docs/CHANGELOG.md`, CLAUDE.md/GEMINI.md (S3 status line), `.claude/commands/nimbus-sandbox-and-extensions.md`

- [ ] **Step 1:** Acceptance per spec § 8 (scaffold `--publisher` → build → keygen → sign → `publish --no-pr` into a local registry clone → run the bundled action's `check` → merge → `sign` → `registry add` the gh-pages tree → install → approve → `connector tools ext_…` lists `echo`); the run step uses `describe.skipIf(!sandboxAvailable)` with the skip stated in the test name.
- [ ] **Step 2–4:** fail → implement → pass; `bun run preflight`; Linux coverage.
- [ ] **Step 5:** Commit `test(extensions): publish-to-run acceptance; docs for registry publishing`.

**PR C close:** PR title `feat(extensions): registry CI — check and sign publish pull requests`; the PR body lists the owner's steps for `nimbus-agent/extensions` (docs/registry-hosting.md).
