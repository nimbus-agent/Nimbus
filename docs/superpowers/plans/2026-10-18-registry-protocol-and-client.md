# Extension Registry Protocol and Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A registry is a folder of root-key-signed static files; Nimbus can build one offline, add several by name with a pinned key, search and install from them, and receive update notices only from an extension's own source registry — after first repairing the extension update path, which has never worked.

**Architecture:** Four PRs on one branch lineage. PR 1 fixes the existing install/update layout and extraction. PR 2 adds the index format (gateway verifier + CLI signer, held together by a shared golden vector) and the offline `nimbus registry maintain` commands. PR 3 adds the client: V71 tables, a single fetch-and-verify path with a new `registry` egress class, the `registry.*` IPC namespace, and `nimbus registry` / `nimbus extension search|info|install`. PR 4 moves the update daemon onto registries, deletes the dead HTTP client, and lands invariant I44 plus the docs.

**Tech Stack:** Bun 1.4, TypeScript 7 strict, `bun:sqlite`, `@nimbus-dev/sdk` canonical JSON (via `extensions/canonical-json.ts` / `cli/src/lib/extension-signing.ts`), npm `tar` ^7.5.22 (already a gateway dependency; added to the CLI), system `tar` for extraction (existing).

**Spec:** `docs/superpowers/specs/2026-10-18-registry-protocol-and-client-design.md` (read it with this plan; section refs below are to it).

## Global Constraints

- No `any`; external data is `unknown` and validated. TypeScript strict.
- Paths via `path.join`/`dirname`; no hardcoded separators. Every test must pass on Windows, macOS, Linux.
- `cli` never imports gateway source; the gateway never imports `cli`. Shared format = duplicated code + shared golden vector.
- Canonical bytes = `canonicalize` (gateway `extensions/canonical-json.ts`; CLI via the SDK the same way `cli/src/lib/extension-signing.ts` does). Signed object = index with top-level `signature` removed.
- Caps: `index.json` ≤ 8 MiB (`8 * 1024 * 1024`), `manifest.json` ≤ 64 KiB (`64 * 1024`), package ≤ 50 MiB compressed (existing `MAX_TARBALL_BYTES`), unpacked ≤ 200 MiB and ≤ 5000 entries (plan's call; spec § 7.2 requires caps without values).
- Registry name: `/^[a-z0-9][a-z0-9-]{0,31}$/`. Fingerprint: existing `publisherKeyFingerprint` (first 32 hex of SHA-256 of raw key bytes).
- Transports (§ 7.3): `https:`; `http:` only to a loopback host and only when `NODE_ENV !== "production"`; `file:` with empty or `localhost` host, or an absolute path. Refuse UNC (`\\host\…`, `//host/…`, `\\?\UNC\…`) and `file://<other-host>`.
- Consent-prompt payload keys never contain `key`, `auth`, `token`, `secret`, `password`, `credential`, `bearer` (executor `SENSITIVE_PAYLOAD_KEY` redacts them). Use `rootFingerprint`, `publisherFingerprint`, `sourceRegistry`.
- Every new IPC method: inner handler AND outer routing in `ipc/server/server.ts` `dispatchMethod`; LAN-forbidden; refused on a demo-rooted gateway; NOT in the Tauri allowlist.
- Specs and plans never reach `main`. **Branch workflow:** all work happens on `dev/asaf/registry-client`, which keeps both docs for the whole project. At each PR boundary, cut `dev/asaf/registry-pr<N>` from the work branch tip, add ONE commit that `git rm`s `docs/superpowers/`, push it, and open PR N against `main` (or against `dev/asaf/registry-pr<N-1>` while that one is unmerged; retarget after it merges). Work continues on `dev/asaf/registry-client` with the docs intact; never delete them there. Check with `git diff origin/main...dev/asaf/registry-pr<N> --stat`: no `docs/superpowers/` path.
- Before each PR: `bun run preflight:fast`, then the touched test files, then `bun run preflight` for PRs 3–4.
- Gateway modules take `Database` as `import type { Database } from "bun:sqlite"` (a value import trips static D30) and write only through `dbRun`/`dbExec` from `db/write.ts` (I14/D12).
- Error codes are prefixed `ERR_REGISTRY_` and appear in the RPC error message as `<CODE>: <detail>`, matching existing `ERR_*` style.

## Review Focus

1. A mistyped local path passed to `nimbus extension install` (contains a separator or drive letter, does not exist) must say "no such file or directory", not "extension not found in any registry". → Task 12, test `install arg that looks like a path but does not exist reports a missing path`.
2. An `index.json` saved by a Windows editor with a UTF-8 BOM and CRLF line endings must still verify (signature is over canonical bytes of the parsed value). → Task 5, test `parse accepts a BOM and CRLF`.
3. One unreachable registry must not stop search across the others or the daemon's tick for the others; it is reported per registry. → Task 11 test `search reports an unreachable registry and still returns others`; Task 13 test `one failing registry does not block another in the same tick`.
4. A local registry under a directory with spaces and non-ASCII characters (`C:\Users\Zoë Q\reg`), and a URL with or without a trailing slash, resolve the same relative paths. → Task 9, tests `local root with spaces and non-ASCII` and `trailing slash is irrelevant`.
5. A registry that changes an installed extension's publisher key yields a visible `publisher_key_conflict` update status, never a crash or a silent skip. → Task 13, test `publisher key change in the index surfaces as publisher_key_conflict`.

---

# PR 1 — Repair the extension update path (spec § 8.10)

### Task 1: Versions area and swap layout

**Files:**
- Create: `packages/gateway/src/extensions/version-store.ts`, `packages/gateway/src/extensions/version-store.test.ts`
- Modify: `packages/gateway/src/extensions/auto-update-apply.ts` (`ApplyUpgradeOpts`, `ApplyDowngradeOpts`, both swap functions), `auto-update-orchestrate.ts` (pending dir, `extRoot`), `auto-update-init.ts` (`hasPrevVersion`), `packages/gateway/src/ipc/automation-rpc.ts` (~L585 prev probe in `resolveExtensionInfoExtras`; `extension.remove` ~L360), `verify-extensions.ts` (`tryPromotePrevVersion` L48), `packages/gateway/src/automation/extension-store.ts` (`updateExtensionRowVersion`)
- Test: `auto-update-apply.test.ts`, `auto-update-orchestrate.test.ts`, `verify-extensions.test.ts`

**Interfaces:**
- Produces (in `version-store.ts`):
  - `extensionVersionsRoot(extensionsDir: string): string` → `join(dirname(extensionsDir), "extension-versions")`
  - `extensionSlug(id: string): string` → first 16 hex chars of SHA-256 of the UTF-8 id
  - `prevVersionDir(extensionsDir: string, id: string, version: string): string` → `<root>/<slug>/prev/<version>`
  - `prevVersionsDir(extensionsDir: string, id: string): string` → `<root>/<slug>/prev`
  - `pendingDir(extensionsDir: string, id: string, version: string): string` → `<root>/<slug>/pending/<version>`
  - `holdingDir(extensionsDir: string, id: string): string` → `<root>/<slug>/holding`
  - `newestPrevVersion(extensionsDir: string, id: string): string | undefined` — semver-max of `prev/` entries (use `Bun.semver.order`), ignoring non-semver names
  - `removeExtensionVersionStore(extensionsDir: string, id: string): void` — `rmSync(<root>/<slug>, { recursive: true, force: true })`
- `updateExtensionRowVersion(db, id, version, manifestHash, entryHash, lastVerifiedAt, treeDigest: string | null = null)` — writes `tree_digest = ?` with the given value in the SAME statement (NULL when omitted, preserving today's "a version change never keeps a stale digest" rule).
- `ApplyUpgradeOpts` becomes `{ installPath: string; extensionsDir: string; id: string; pendingExtractedDir: string; fromVersion: string; toVersion: string }`; `ApplyDowngradeOpts` becomes `{ installPath: string; extensionsDir: string; id: string; fromVersion: string; toVersion: string }`. `installPath` is the row's flat `install_path`.
- `PerformUpgradeDeps.dataDir` is removed (pending now derives from `extensionsRoot`).

- [ ] **Step 1: Write failing tests**
  - `version-store.test.ts`: `slug is 16 hex and differs for acme/foo vs acme-foo`; `versions root is a sibling of extensionsDir`; `newestPrevVersion picks 1.10.0 over 1.9.0` (lexical sort would pick 1.9.0); `newestPrevVersion ignores a non-semver directory`.
  - `auto-update-apply.test.ts`: `upgrade succeeds when prev/<fromVersion> already exists` (1.0.0 → 1.1.0 → downgrade to 1.0.0 → upgrade to 1.2.0; the third swap must not fail on a non-empty `prev/1.0.0`); `upgrade swaps a FLAT install dir` — create `<ext>/acme/foo/nimbus.extension.json` (v1) and a pending tree (v2); after `applyUpgradeSwap`, `installPath` holds v2 and `prevVersionDir(...,"1.0.0")` holds v1; `downgrade restores prev into the flat install dir`; `failed rename leaves the original install untouched`.
  - `automation-rpc.test.ts`: `extension.remove deletes the extension's version store` (a later fresh install of the same id finds no `prev/`).
  - `verify-extensions.test.ts`: `crash recovery promotes the semver-newest prev and records its measured hashes` — assert row `manifest_hash`/`entry_hash` equal `computeExtensionPackageHashes(installPath)` after promotion, not the old row values, and `tree_digest` equals `computeExtensionTreeDigest(installPath)`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/version-store.test.ts packages/gateway/src/extensions/auto-update-apply.test.ts packages/gateway/src/extensions/verify-extensions.test.ts` — expect FAIL (module missing / ENOENT on `active`).
- [ ] **Step 3: Implement** `version-store.ts`; in `applyUpgradeSwap` move EVERY existing `prev/` entry (including `prev/<fromVersion>`) into `holdingDir` before `rename(installPath, prevVersionDir(…, fromVersion))`, restore them on failure, and delete `holdingDir` on success; `extension.remove` calls `removeExtensionVersionStore` after the install dir is removed; rewrite both swaps to rename `installPath` ↔ `prevVersionDir`, with stale prev moved via `holdingDir` and the downgrade buffer under the slug dir; point `createPerformUpgrade`'s pending dir at `pendingDir(...)` with `mkdir(dirname(...), { recursive: true })`; point `hasPrevVersion`, the info prev probe and `tryPromotePrevVersion` at the version store. `tryPromotePrevVersion` uses `newestPrevVersion`, `computeExtensionPackageHashes` and `computeExtensionTreeDigest` and passes all three to `updateExtensionRowVersion`.
- [ ] **Step 4: Run** the same command plus `bun test packages/gateway/src/extensions packages/gateway/src/ipc/automation-rpc.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `fix(extensions): flat install path with a sibling versions area, so updates can apply`

### Task 2: One extraction pipeline with caps, digest before swap

**Files:**
- Create: `packages/gateway/src/extensions/package-extract.ts`, `package-extract.test.ts`
- Modify: `install-from-local.ts` (`installExtensionFromArchive` uses the new module; export nothing new from it), `auto-update-init.ts` (delete `extractTarballToDir` and the `tar.x` import; delete `recordTreeDigestAfterSwap`), `auto-update-orchestrate.ts`, `auto-update-types.ts` (no new phase; reuse `extract_failed`)

**Interfaces:**
- Produces:
  - `export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;` `export const MAX_PACKAGE_ENTRIES = 5000;`
  - `export async function extractPackage(archivePath: string, destDir: string): Promise<ExtractedPackage>` where `type ExtractedPackage = { sourceRoot: string; treeDigest: string }`.
  - Order inside: (1) pre-scan with npm `tar.t({ file, onReadEntry })` summing `entry.size`, counting entries, refusing any entry whose `type` is not `File`/`Directory` or whose path is absolute or contains a `..` segment, throwing `package_too_large: …` / `package_entry_refused: <path>`; (2) existing `extractTarGzToDirectory`; (3) `findExtensionSourceRootInTree` (move it from `install-from-local.ts` into this module); (4) `computeExtensionTreeDigest(sourceRoot)`.
- `PerformUpgradeDeps.extractTarball` becomes `extractPackage: (archivePath: string, destDir: string) => Promise<ExtractedPackage>`; `dbUpdateExtensionRow` gains a final `treeDigest: string` parameter, wired in `auto-update-init.ts` to Task 1's `updateExtensionRowVersion(…, treeDigest)` (same statement).

- [ ] **Step 1: Write failing tests** in `package-extract.test.ts` (build archives with npm `tar.c` in a temp dir): `refuses a symlink entry before extracting anything` (assert `destDir` empty); `refuses a ../ entry`; `refuses more than MAX_PACKAGE_ENTRIES entries`; `refuses when declared sizes exceed MAX_UNPACKED_BYTES` (use a sparse header size, not real bytes); `finds the source root inside one top-level folder`; `returns the tree digest of the source root`. In `auto-update-orchestrate.test.ts`: `a refused package leaves the installed version and digest untouched`; `a successful upgrade leaves no pending directory or temp archive behind` (archive packed inside one top-level folder, so `sourceRoot` ≠ the extraction dir).
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/package-extract.test.ts packages/gateway/src/extensions/auto-update-orchestrate.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** as specified; `performUpgrade` writes the archive bytes to a temp file under `pendingDir`'s parent, calls `extractPackage`, `assertPackageMatchesClaims(sourceRoot, update)`, swaps `sourceRoot` in, then `dbUpdateExtensionRow(..., treeDigest)`; a `finally` removes the whole pending version dir and the temp archive on success and failure alike.
- [ ] **Step 4: Run** `bun test packages/gateway/src/extensions` — expect PASS.
- [ ] **Step 5: Commit** `fix(extensions): install and update share one capped extraction pipeline; digest before swap`

### Task 3: Orphan sweep understands namespaced ids (latent fix)

**Files:** Modify `packages/gateway/src/extensions/verify-extensions.ts` (`sweepOrphanActiveDirsBestEffort`); Test `verify-extensions.test.ts`

- [ ] **Step 1: Failing test** `sweep keeps acme/ when acme/foo is installed and removes an unowned dir` — call `verifyExtensionsBestEffort(db, logger, undefined, undefined, extensionsRoot)` with rows `acme/foo` (enabled) and dirs `acme/foo`, `stray`; expect `acme` kept, `stray` removed.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/verify-extensions.test.ts` — FAIL.
- [ ] **Step 3: Implement**: live set = first `/`-segment (after `\`→`/` normalisation) of every `extension.id`. Do NOT wire the sweep into `assemble.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `fix(extensions): orphan sweep keeps namespaced extension directories`

### Task 4: `nimbus extension update|downgrade` show the prompt

**Files:** Modify `packages/cli/src/commands/extension.ts` (L749 timeout condition; `runExtensionUpdate` L869; `runExtensionDowngrade` L928); Test `packages/cli/src/commands/extension.test.ts`

- [ ] **Step 1: Failing tests** `update registers a consent prompt handler and uses the interactive timeout`, same for `downgrade`. Inject the client (DI, not `mock.module`): assert `onNotification("consent.request", …)` was registered before the `extension.update` call and that `createIpcClient` received `INTERACTIVE_RPC_TIMEOUT_MS`. `update --check` registers nothing (it never prompts).
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/extension.test.ts` — FAIL.
- [ ] **Step 3: Implement**: add `"update"`/`"downgrade"` to the interactive-timeout condition; call `registerConsentFor(client, { kind: "prompt" })` in both runners when not `--check`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `fix(cli): extension update and downgrade show the owner's prompt instead of timing out`

**PR 1 close:** CHANGELOG entry (fixes only, no feature); `docs/SECURITY-INVARIANTS.md` I16 line ~363: replace "the orchestrator re-verifies signatures" with "the orchestrator checks package hashes; signature re-verification happens at the next startup" (made true in PR 4). Cut the PR branch per the branch workflow, preflight, open PR titled `fix(extensions): make extension updates apply; one capped extraction pipeline`.

---

# PR 2 — Index format and offline maintainer commands (spec §§ 7, 9)

### Task 5: Gateway index model, parser, verifier

**Files:**
- Create: `packages/gateway/src/extensions/registry/index-format.ts`, `index-format.test.ts`, `packages/gateway/src/extensions/registry/registry-errors.ts`

**Interfaces:**
- Produces (`index-format.ts`):
  ```ts
  export type RegistryChannel = "stable" | "beta";
  export interface RegistryVersionEntry { channel: RegistryChannel; name: string; manifest: string; manifestSha256: string;
    package: string; packageSha256: string; packageSizeBytes: number; entryHash: string; publishedAt: string; }
  export interface RegistryExtensionEntry { publisher: { id: string; key: string }; versions: Readonly<Record<string, RegistryVersionEntry>>; }
  export interface RegistryIndex { format: 1; rootKey: string; sequence: number; generatedAt: string;
    extensions: Readonly<Record<string, RegistryExtensionEntry>>; signature: string; }
  export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
  export function parseRegistryIndex(bytes: Uint8Array): RegistryIndex;        // strips a UTF-8 BOM; schema-validates; throws RegistryError("ERR_REGISTRY_INDEX_INVALID")
  export async function verifyRegistryIndexSelf(index: RegistryIndex): Promise<void>;          // signature against index.rootKey
  export async function verifyRegistryIndexPinned(index: RegistryIndex, pinnedRootKey: string): Promise<void>; // rootKey === pinned (else ERR_REGISTRY_ROOT_KEY_CHANGED), then self-verify (else ERR_REGISTRY_SIGNATURE_INVALID)
  export function registryIndexSigningBytes(index: Omit<RegistryIndex, "signature"> | RegistryIndex): Uint8Array; // canonicalize without "signature", UTF-8
  ```
  Validation: `sequence` positive safe integer; every `<id>` passes `assertSafeExtensionId`; every `<version>` passes `Bun.semver.satisfies(v, v)` sanity (valid semver); `channel` in set; hex fields `/^[0-9a-f]{64}$/`; `manifest`/`package` equal `extensions/<id>/<version>/manifest.json|package.tgz` exactly (no free-form paths); `publisher.id` matches the manifest rules in `manifest.ts`; keys 44-char base64, signature 88-char base64.
- Produces (`registry-errors.ts`): `export type RegistryErrorCode = "ERR_REGISTRY_INDEX_INVALID" | "ERR_REGISTRY_ROOT_KEY_CHANGED" | "ERR_REGISTRY_SIGNATURE_INVALID" | "ERR_REGISTRY_ROLLBACK" | "ERR_REGISTRY_TOO_LARGE" | "ERR_REGISTRY_HASH_MISMATCH" | "ERR_REGISTRY_TRANSPORT_REFUSED" | "ERR_REGISTRY_AIR_GAP" | "ERR_REGISTRY_UNREACHABLE" | "ERR_REGISTRY_NOT_FOUND" | "ERR_REGISTRY_EXISTS" | "ERR_REGISTRY_AMBIGUOUS" | "ERR_REGISTRY_FINGERPRINT_MISMATCH" | "ERR_REGISTRY_ADD_NOT_APPROVED" | "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT" | "ERR_REGISTRY_ALREADY_INSTALLED";` and `export class RegistryError extends Error { constructor(readonly code: RegistryErrorCode, detail: string) }` whose `message` is `` `${code}: ${detail}` ``.

- [ ] **Step 1: Failing tests**: `golden vector: fixed key signs the fixture index to the pinned signature` (the fixture includes a non-ASCII `name`) — seed = bytes `0x01..0x20`; fixture index in the test; the expected signature literal is produced once during implementation and pasted into BOTH this test and Task 6's (Ed25519 is deterministic); `parse accepts a BOM and CRLF`; `rejects a manifest path that is not the canonical location`; `rejects an id that fails assertSafeExtensionId`; `pinned verify reports ROOT_KEY_CHANGED before checking the signature`; `a flipped byte in any version entry fails SIGNATURE_INVALID`; `rejects index over MAX_INDEX_BYTES before JSON.parse` (spy on nothing; assert error code with a 9 MiB buffer).
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/registry/index-format.test.ts` — FAIL.
- [ ] **Step 3: Implement** as specified. Do NOT route through `verifyManifestSignature` — the SDK manifest verifier requires a `publisher.key` field the index does not have. Verify with `nacl.sign.detached.verify(registryIndexSigningBytes(index), decodeBase64(index.signature), decodeBase64(key))` (`tweetnacl`, as `util/ed25519.ts` already uses); canonical bytes from `extensions/canonical-json.ts` `canonicalize`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(extensions): registry index format and verifier`

### Task 6: CLI index builder, deterministic packer

**Files:**
- Create: `packages/cli/src/lib/registry-index.ts`, `registry-index.test.ts`, `packages/cli/src/lib/registry-pack.ts`, `registry-pack.test.ts`
- Modify: `packages/cli/package.json` (add `"tar": "^7.5.22"`; follow the `nimbus-commands` skill's `bun add` safety pre-flight; `bun.lock` updates)

**Interfaces:**
- Produces (`registry-index.ts`): the same `RegistryIndex`/entry types (duplicated, not imported), plus
  `emptyIndex(rootKeyB64: string): Omit<RegistryIndex, "signature">` (`sequence: 1`, `extensions: {}`),
  `signIndex(unsigned: Omit<RegistryIndex, "signature">, privkey: Uint8Array): Promise<RegistryIndex>`,
  `readIndexFile(path: string): RegistryIndex` (structural parse only),
  `writeIndexAtomic(dir: string, index: RegistryIndex): void` (write `index.json.<pid>.tmp` in `dir`, then `renameSync`).
- Produces (`registry-pack.ts`): `packExtensionDir(srcDir: string, outFile: string): Promise<void>` — npm `tar.c({ gzip: true, file: outFile, cwd: srcDir, portable: true, mtime: new Date(0), noDirRecurse: true }, sortedRelativePaths)`; refuses symlinks/special files; file list sorted by UTF-16 code unit with `/` separators.

- [ ] **Step 1: Failing tests**: `golden vector matches the gateway's` (same seed, fixture and pinned signature literal as Task 5); `writeIndexAtomic leaves no tmp file and replaces atomically`; `packing the same tree twice yields identical bytes`; `pack refuses a symlink`.
- [ ] **Step 2: Run** `bun test packages/cli/src/lib/registry-index.test.ts packages/cli/src/lib/registry-pack.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Sign with `node:crypto` `sign(null, bytes, privateKeyObject)` using the JWK private-key construction already in `cli/src/lib/extension-signing.ts`. Canonical bytes MUST come from the same DEPRECATED `canonicalize` export of `@nimbus-dev/sdk` the gateway wraps (import it with the same `// NOSONAR S1874` note), NOT `@nimbus-dev/sdk/signing`: the two differ on NFC normalisation (see the docstring in `packages/gateway/src/extensions/canonical-json.ts`), so the newer one would produce signatures the gateway rejects for any non-ASCII name. The golden vector should include a non-ASCII `name` (e.g. `"Zoë Deploy"`) so this cannot regress silently.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): registry index signer and deterministic package packer`

### Task 7: `nimbus registry maintain init|add|remove`

**Files:**
- Create: `packages/cli/src/commands/registry-maintain.ts`, `registry-maintain.test.ts`, `packages/cli/src/commands/registry-cmd.ts` (top-level `nimbus registry` dispatcher; `commands/registry.ts` is already the command-name list)
- Modify: `packages/cli/src/commands/index.ts` (export `runRegistry`), `packages/cli/src/index.ts` (`COMMAND_HANDLERS.registry`), `packages/cli/src/commands/registry.ts` (`COMMAND_NAMES`), `packages/cli/src/commands/help.ts` (lines for `nimbus registry`), `docs/cli-reference.md`

**Interfaces:**
- Consumes: Task 6 functions; `signManifest`/verify from `cli/src/lib/extension-signing.ts`.
- Produces: `runRegistryMaintain(args: string[], io?: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number>`; `runRegistry(args: string[]): Promise<void>` routing `maintain` offline (no gateway) and everything else to Task 10.
- Behaviour (spec § 9): `init <dir> [--key <path>] [--force]` — key default `join(homedir(), ".nimbus", "registry-key")`, file mode 0600 (`chmodSync` off Windows), refuse overwrite without `--force` (exit 2), create `<dir>/extensions/`, write signed empty index, print fingerprint. `add <dir> <package.tgz|extension-dir> [--channel stable|beta] [--key <path>]` — pack a dir via `packExtensionDir`; extract to temp; require `publisher` + `signature`; verify manifest signature with the manifest's own key; refuse an existing `<id>@<version>` and a publisher key different from the index's for that id; copy `manifest.json` (verbatim bytes) + `package.tgz` to the canonical paths; fill the version entry (hashes, size, `entryHash` via the manifest `entry`, `name` = manifest `name ?? id`, `publishedAt` now); `sequence + 1`; re-sign; write atomically. `remove <dir> <id>[@<version>] [--key <path>]` — remove the version (or all); drop the id entry when no versions remain; `sequence + 1`; re-sign. Every write verifies the existing index's signature against the key file's public key first (refuse a folder signed by a different key).

- [ ] **Step 1: Failing tests** (temp dirs; key via `--key` in the temp dir, never `~/.nimbus`): `init writes a self-verifying index with sequence 1`; `init refuses to overwrite a key without --force`; `add a dir then the index lists it with correct hashes and sequence 2`; `add refuses an existing id@version`; `add refuses a changed publisher key for an existing id`; `add refuses an unsigned extension`; `remove last version drops the id entry`; `maintain on a folder signed by another key refuses`.
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/registry-maintain.test.ts packages/cli/src/commands/help.test.ts packages/cli/src/commands/registry.test.ts` — FAIL.
- [ ] **Step 3: Implement**, register the command, add help + `docs/cli-reference.md` section `nimbus registry maintain`.
- [ ] **Step 4: Run** the same plus `bun run audit:readme-cli` — PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus registry maintain builds a signed static registry`

**PR 2 close:** a cross-package check that the CLI's signed index verifies in the gateway: `packages/gateway/src/extensions/registry/index-format.test.ts` test `verifies an index produced by the maintainer flow` reads a committed fixture `packages/gateway/src/extensions/registry/__fixtures__/maintained-index.json` produced by running Task 7 once against the golden key (commit the fixture and its package files). CHANGELOG. Cut the PR branch per the branch workflow, preflight, PR `feat(cli): offline registry maintainer commands and signed index format`.

---

# PR 3 — Registry client (spec §§ 8.1–8.7, 8.11)

### Task 8: Schema V71 and the registry store

**Files:**
- Create: `packages/gateway/src/index/extension-registry-v71-sql.ts`, `packages/gateway/src/index/migrations/runner-v71.test.ts`, `packages/gateway/src/extensions/registry/registry-store.ts`, `registry-store.test.ts`
- Modify: `packages/gateway/src/automation/extension-store.ts` (`ExtensionRow` + `listExtensions` select `source_registry`, `source_root_fingerprint`, `source_channel` when the columns exist, NULL otherwise, following the existing `hasTreeDigestColumn` pattern), the `extension.list` handler in `ipc/automation-rpc.ts` and its CLI formatter (show `from <registry>` for registry installs), `index/migrations/runner.ts` (append `simpleStep(70, 71, "extension registries (extension_registry) + extension source columns", EXTENSION_REGISTRY_V71_SQL)`), `index/local-index.ts` (`CURRENT_SCHEMA_VERSION = 71`), `index/migrations/runner.test.ts` (`toBe(71)`), `docs/schema-reference.md`

**Interfaces:**
- SQL: `CREATE TABLE extension_registry (name TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, root_key TEXT NOT NULL, root_fingerprint TEXT NOT NULL, last_sequence INTEGER NOT NULL, last_generated_at TEXT NOT NULL, added_at INTEGER NOT NULL, last_fetched_at INTEGER)`; `ALTER TABLE extension ADD COLUMN source_registry TEXT`, `source_root_fingerprint TEXT`, `source_channel TEXT CHECK(source_channel IN ('stable','beta'))`.
- Produces (`registry-store.ts`, all writes via `dbRun` per I14):
  ```ts
  export interface RegistryRow { name: string; url: string; rootKey: string; rootFingerprint: string;
    lastSequence: number; lastGeneratedAt: string; addedAt: number; lastFetchedAt: number | null; }
  export function listRegistries(db: Database): RegistryRow[];
  export function getRegistry(db: Database, name: string): RegistryRow | undefined;
  export function insertRegistry(db: Database, row: Omit<RegistryRow, "lastFetchedAt">): void;      // ERR_REGISTRY_EXISTS on name/url clash
  export function recordRegistryFetch(db: Database, name: string, sequence: number, generatedAt: string, now: number): void;
  export function deleteRegistry(db: Database, name: string): boolean;
  export function setExtensionSource(db: Database, id: string, src: { registry: string; rootFingerprint: string; channel: RegistryChannel }): void;
  export function getExtensionSource(db: Database, id: string): { registry: string; rootFingerprint: string; channel: RegistryChannel } | undefined;
  ```

- [ ] **Step 1: Failing tests**: `V71 creates extension_registry and three nullable extension columns`; `existing extension rows keep NULL source after migration`; store round trip; `insert refuses a duplicate url`; `deleteRegistry leaves extension rows and their source columns intact`; `listExtensions returns the three source fields (null for a local install)`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/index/migrations/runner-v71.test.ts packages/gateway/src/extensions/registry/registry-store.test.ts packages/gateway/src/index/migrations/runner.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(extensions): schema V71 for registries and extension source`

### Task 9: Transport, ledgered fetch, fetch-and-verify

**Files:**
- Create: `packages/gateway/src/extensions/registry/registry-transport.ts` (+ test), `packages/gateway/src/extensions/registry/registry-fetch.ts` (+ test), `packages/gateway/src/egress/registry-egress.ts` (+ test)
- Modify: `egress/egress-source-type.ts` (add `"registry"` with its decision paragraph in the header), `egress/egress-coverage.ts` (insert `"registry"` between `"peer"` and `"session"` in `COVERAGE_CLASSES`; `ALL_NONE_COVERAGE.registry = "none"`; `THIS_BINARY_COVERAGE.registry = "per-call"` with its paragraph), `packages/cli/src/commands/prove.ts` (`COVERAGE_CLASS_LABELS.registry = "extension registry fetches"`), `scripts/structure-audit/check-nimbus-invariants.ts` (+ test) for D22(h)

**Interfaces:**
- `registry-transport.ts`:
  ```ts
  export type RegistryLocation = { kind: "remote"; base: URL } | { kind: "local"; root: string };
  export function resolveRegistryLocation(url: string, opts: { production: boolean }): RegistryLocation; // ERR_REGISTRY_TRANSPORT_REFUSED
  export function resolveRegistryResource(loc: RegistryLocation, relPath: string): { kind: "remote"; url: string } | { kind: "local"; path: string };
  ```
  Remote base always ends in `/` before `new URL(rel, base)`; `relPath` must match `^(index\.json|extensions/.+/(manifest\.json|package\.tgz))$` with no `..` segment.
- `registry-egress.ts`: `export function recordRegistryEgress(db: Database, args: { registryName: string; method: "registry.index" | "registry.manifest" | "registry.package"; extensionId?: string; version?: string; now: number }): { rowHash: string }` → `appendEgressEntry` with `sourceType: "registry"`, `sourceId: null`, `destination: registryName`, `payloadSummary: redactEgressSummary({ method, extensionId, version })`, `hitlStatus: "not_required"`, `resultStatus: "authorized"`.
- `registry-fetch.ts`:
  ```ts
  export interface RegistryFetchDeps { db: Database; fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
    enforceAirGap: () => boolean; now: () => number; production: boolean; }
  export async function fetchRegistryBytes(deps: RegistryFetchDeps, reg: { name: string; url: string },
    rel: string, meta: { method: "registry.index" | "registry.manifest" | "registry.package"; extensionId?: string; version?: string; maxBytes: number }, signal?: AbortSignal): Promise<Uint8Array>;
  export async function fetchVerifiedIndex(deps: RegistryFetchDeps, reg: RegistryRow, signal?: AbortSignal): Promise<RegistryIndex>;      // pinned verify + sequence ≥ lastSequence + recordRegistryFetch
  export async function fetchUnpinnedIndex(deps: RegistryFetchDeps, reg: { name: string; url: string }, signal?: AbortSignal): Promise<RegistryIndex>; // self-verify only, for registry.add
  ```
  `fetchRegistryBytes` order: resolve location → for remote: air-gap check (`ERR_REGISTRY_AIR_GAP`) → `recordRegistryEgress` (throws → abort) → fetch with a 30 s timeout and `redirect: "manual"`: follow at most 3 redirects (301/302/303/307/308), resolving `Location` against the current URL and re-running the transport check on every hop (so an `https` registry cannot redirect to `http`, to a non-loopback `http` host, or to `file:`), more → `ERR_REGISTRY_UNREACHABLE`; refuse up front when `Content-Length` exceeds `maxBytes`, and also stream with a running byte count that aborts past `maxBytes` (`ERR_REGISTRY_TOO_LARGE`); non-2xx → `ERR_REGISTRY_UNREACHABLE` (404 → `ERR_REGISTRY_NOT_FOUND`). For local: `statSync` size check then `readFileSync`; no egress row; allowed under air-gap.
- D22(h): `recordRegistryEgress` may appear only in `egress/registry-egress.ts` and `extensions/registry/registry-fetch.ts`; and no non-test file under `packages/gateway/src/extensions/` may contain `\bfetch\(` outside `extensions/registry/registry-fetch.ts` (after `stripComments`; the old `auto-update-apply.ts` `downloadTarball` is deleted in Task 13, so until then add it to a temporary allow-list entry marked for removal in Task 13). Rule names `registry-appender-confined`, `registry-fetch-confined`, modelled on `checkEmbeddingAppenderConfinement`, wired in `main` for `binary-only`/`all`.

- [ ] **Step 1: Failing tests**:
  - transport: `refuses UNC backslash`, `refuses //host`, `refuses \\?\UNC\`, `refuses file://evil.example/x`, `accepts file://localhost/abs and file:///abs`, `refuses http to a non-loopback host`, `refuses http in production`, `local root with spaces and non-ASCII` (path `join(tmp, "Zoë Q", "reg")`), `trailing slash is irrelevant`, `rejects a ../ relPath`.
  - fetch: `remote fetch appends exactly one registry row before the request` (fake `fetchFn` asserts the row exists when called); `append failure means no request`; `air-gap refuses remote and appends nothing`; `local fetch appends nothing and works under air-gap`; `streaming cap aborts at maxBytes`; `content-length over the cap refuses before reading`; `a redirect to http on a non-loopback host refuses`; `a fourth redirect refuses`; `rollback: lower sequence refuses and does not update the row`; `equal sequence accepted`; `changed root key refuses and never re-pins`.
  - coverage: existing invariant test that `COVERAGE_CLASSES` equals non-marker source types passes; `serializeCoverage` keeps sorted order.
  - D22(h) tests in `check-nimbus-invariants.test.ts`: allowed files pass; a `recordRegistryEgress` call in another gateway file fails; a `fetch(` in `extensions/install-from-local.ts` fails.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/registry packages/gateway/src/egress scripts/structure-audit/check-nimbus-invariants.test.ts packages/cli/src/commands/prove.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; also `bun run audit:invariants` (the script running `check-nimbus-invariants.ts`) — PASS.
- [ ] **Step 5: Commit** `feat(egress): registry coverage class; ledgered, verified registry fetch (D22(h))`

### Task 10: `registry.add|list|refresh|remove` — IPC, HITL, CLI

**Files:**
- Create: `packages/gateway/src/ipc/registry-rpc.ts` (+ test), `packages/gateway/test/e2e/registry.e2e.test.ts`, `packages/cli/src/commands/registry-client-cmds.ts` (+ test)
- Modify: `engine/executor.ts` (add `"registry.add"` to `HITL_REQUIRED_BACKING` with a comment naming the gate site; `tryDelegatedApproval` returns `"fallback"` when `action.type === "registry.add" || action.type.startsWith("extension.")`), `ipc/server/dispatchers.ts` (`tryDispatchRegistryRpc(ctx, clientId, method, params)`, gate via `buildExtensionGateExecutor`), `ipc/server/context.ts` (`registryRpcSkipped` symbol), `ipc/server/server.ts` (chain `tryDispatchRegistryRpc` after automation), `ipc/server/options.ts` (`registryFetch?: RegistryFetchDeps`-shaped bag minus `db`), `ipc/lan-rpc.ts` (`"registry"` namespace in `FORBIDDEN_OVER_LAN`), `ipc/server/demo-gate.ts` (refuse `method.startsWith("registry.")`), `platform/assemble.ts` (build the fetch deps: `fetchFn: fetch`, `enforceAirGap: () => llmRegistry?.enforcesAirGap() ?? bootLlmToml.enforceAirGap`, `production: process.env.NODE_ENV === "production"`), `security-invariants.test.ts` (I2 test for `registry.add`; I20 test), `packages/cli/src/commands/registry-cmd.ts`, help, `docs/cli-reference.md`

**Interfaces:**
- IPC (all CLI-only):
  - `registry.add { name: string; url: string; fingerprint?: string }` → `{ name, url, rootFingerprint, extensionCount, generatedAt }`. The GATEWAY trims and lowercases `fingerprint` and requires `/^[0-9a-f]{32}$/` (the `publisherKeyFingerprint` format), else `ERR_REGISTRY_FINGERPRINT_MISMATCH` with "expected 32 hex characters", so raw IPC callers get the same check as the CLI. Order exactly spec § 8.3. HITL action `{ type: "registry.add", payload: { name, url, rootFingerprint, extensionCount, generatedAt } }`; denied → `ERR_REGISTRY_ADD_NOT_APPROVED`.
  - `registry.list {}` → `{ registries: Array<{ name; url; rootFingerprint; extensionCount: number | null; lastFetchedAt: number | null; generatedAt: string; stale: boolean }> }` — reads DB only, no fetch; `extensionCount` null (counted only by refresh/search); `stale` = `generatedAt` older than 30 days (plan's call).
  - `registry.refresh { name?: string }` → `{ results: Array<{ name; ok: boolean; error?: string; sequence?: number; extensionCount?: number }> }`.
  - `registry.remove { name: string }` → `{ removed: boolean; orphanedExtensions: string[] }` (ids whose `source_registry` was this name).
- CLI: `runRegistryClient(sub: "add" | "list" | "refresh" | "remove", args: string[], deps: { client: IPCClient; isTty: boolean; stdout; stderr }): Promise<number>`. `add` refuses when `!isTty` (exit 2, message "nimbus registry add needs an interactive terminal"), rejects `--yes`, calls `registerConsentPromptHandler(client)` directly, uses `INTERACTIVE_RPC_TIMEOUT_MS`.

- [ ] **Step 1: Failing tests**:
  - `registry-rpc.test.ts` (real SQLite, local-folder registry built with Task 7's flow or the committed fixture, gate injected): `add pins the key after approval`; `add records the index fetch even when denied` (remote via fake fetchFn: one `registry` row, no registry row in DB); `add with a wrong --fingerprint refuses before prompting` (gate not called); `add refuses an existing name and an existing url`; `refresh reports per-registry results`; `remove returns orphaned extension ids`.
  - `security-invariants.test.ts`: `registry.add ∈ HITL_REQUIRED and the add handler refuses without an owner gate`; `I20: a delegate never approves registry.add or extension.*` (construct `ToolExecutor` with a delegation stub whose store says active; assert `requestRemote` never called).
  - `lan-rpc.test.ts`: `registry.* is forbidden over LAN`. `demo-gate.test.ts`: `registry.* refused on a demo root`.
  - `registry.e2e.test.ts` (template `extension-run-grant.e2e.test.ts`, `startRealGateway`): each of the four methods reaches its handler through both dispatcher layers (`client.raw` returns a handler error such as `ERR_REGISTRY_NOT_FOUND` for `refresh {name:"nope"}`, never -32601).
  - CLI: `add refuses without a TTY`; `add rejects --yes`; `list prints name, url, fingerprint, staleness`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/ipc/registry-rpc.test.ts packages/gateway/src/security-invariants.test.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/test/e2e/registry.e2e.test.ts packages/cli/src/commands/registry-client-cmds.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(extensions): named registries with pinned root keys (registry.add is owner-gated, never delegable)`

### Task 11: Search and info

**Files:** Modify `ipc/registry-rpc.ts` (+ test), `packages/cli/src/commands/extension.ts` (`search` subcommand; `info` gains `--registry <name>` / `--remote`), help, `docs/cli-reference.md`; Test `packages/gateway/test/e2e/registry.e2e.test.ts`

**Interfaces:**
- `registry.search { query: string }` → `{ results: Array<{ registry: string; id: string; name: string; publisherId: string; latestStable: string | null; latestBeta: string | null }>; errors: Array<{ registry: string; error: string }> }`. Case-insensitive substring over id, name (from the newest version entry), publisher id. Indexes fetched concurrently (`Promise.allSettled`).
- `registry.info { id: string; registry?: string }` → `{ registry; id; publisherId; publisherFingerprint; versions: Array<{ version; channel; publishedAt; packageSizeBytes; permissions: ExtensionManifest["permissions"] }> }` — fetches the newest version's `manifest.json` (ledgered) for permissions; checks `manifestSha256`; other versions omit `permissions`. Without `registry` and found in >1 → `ERR_REGISTRY_AMBIGUOUS` naming each.

- [ ] **Step 1: Failing tests**: `search matches name case-insensitively across two registries and tags results`; `search reports an unreachable registry and still returns others`; `info without --registry is ambiguous when two registries carry the id`; `info shows permissions from the hash-checked manifest`; `info refuses a manifest whose hash differs from the index`; E2E routing for both methods.
- [ ] **Step 2: Run** `bun test packages/gateway/src/ipc/registry-rpc.test.ts packages/gateway/test/e2e/registry.e2e.test.ts packages/cli/src/commands/extension.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(extensions): nimbus extension search and info across registries`

### Task 12: Install from a registry

**Files:**
- Create: `packages/gateway/src/extensions/registry/install-from-registry.ts` (+ test)
- Modify: `install-from-local.ts` (options gain `publisherKey?: Uint8Array` used in place of resolving by path/Vault/fetcher; `verifyAndRecordSignature`'s guard (~L109) changes to require only `vault`, and when `publisherKey` is given it skips `resolvePublisherKey` entirely, so PR 3 works before Task 13 deletes `fetcher`; `ExtensionInstallApprovalRequest` gains optional `sourceRegistry?: string; rootFingerprint?: string`), `ipc/registry-rpc.ts` (`registry.install`, owner-gated through the `extension.install` action), `ipc/server/dispatchers.ts` (owner gate for `registry.install`), `packages/cli/src/commands/extension.ts` (install path-vs-id), help, `docs/cli-reference.md`

**Interfaces:**
- `export async function installFromRegistry(deps: { db: Database; extensionsDir: string; vault: NimbusVault; fetch: RegistryFetchDeps; approve: ExtensionInstallApprover }, req: { id: string; registry?: string; version?: string; channel?: RegistryChannel }): Promise<InstallExtensionFromLocalResult & { sourceRegistry: string }>` — steps exactly spec § 8.6 1–8; temp files under `mkdtempSync(join(tmpdir(), "nimbus-reg-"))`, removed in `finally`; Vault conflict compares `readPublisherKey(vault, publisherId)` with the index key (`ERR_REGISTRY_PUBLISHER_KEY_CONFLICT`); already installed → `ERR_REGISTRY_ALREADY_INSTALLED` with "use `nimbus extension update <id>`, or remove it first"; `entryHash` from the index must equal the installed `entry_hash`; then `setExtensionSource`.
- IPC `registry.install { id; registry?; version?; channel? }` → `{ id, version, sourceRegistry, installPath, treeDigest }`. Emits `emitGatewayEvent("extension.stateChanged", { extensionId, action: "install", ok })` on success and failure, exactly as `extension.install` does in `automation-rpc.ts`, so the desktop list and `nimbus tail` refresh.
- CLI `stripFlags` (`extension.ts` ~L36) treats `--registry`, `--version`, `--channel` and the existing `--to` as value flags (skip the next token). Test `stripFlags keeps the id when --registry and --version precede it`.
- CLI: `nimbus extension install <arg> [--registry <name>] [--version <v>] [--channel beta] [--publisher-key <path>] [--yes]`. `existsSync(resolve(cwd, arg))` → local (refuse `--registry`/`--version`/`--channel` with it); else if `arg` contains `\`, a drive letter prefix, or starts with `.`/`~` → error `no such file or directory: <arg>`; else `registry.install`. Prints `installing <id>@<v> from registry <name> (root <fp>), publisher <pid> (<fp>)`. `--yes` keeps today's semantics for local installs only; refused for registry installs (plan's call: a registry install is the trust-expanding path).

- [ ] **Step 1: Failing tests**: `installs from a local-folder registry and records source registry, fingerprint, channel`; `prompt payload carries sourceRegistry and rootFingerprint, never a *Key field`; `tampered package.tgz fails HASH_MISMATCH before extraction`; `manifest publisher differing from the index refuses`; `Vault holding another key for the publisher refuses PUBLISHER_KEY_CONFLICT`; `already installed refuses with the update hint`; `registry.install emits extension.stateChanged on success and on failure`; `missing dependency refuses and fetches nothing transitively`; `install-from-local with publisherKey and no fetcher verifies and installs`; `beta channel picks the newest of stable ∪ beta`; CLI `install arg that looks like a path but does not exist reports a missing path`; CLI `--registry with an existing path is refused`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/registry/install-from-registry.test.ts packages/gateway/src/extensions/install-from-local.test.ts packages/cli/src/commands/extension.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, plus E2E routing case for `registry.install` in `registry.e2e.test.ts`.
- [ ] **Step 5: Commit** `feat(extensions): install extensions from a registry`

**PR 3 close:** `docs/architecture.md` Subsystem 4: registry format, client, trust model, rejected alternatives (TOFU key fetch; priority-ordered multi-registry; `nimbus.toml` storage), corrected sample manifest; CHANGELOG; `docs/SECURITY-INVARIANTS.md` I29 paragraph for the `registry` class and D22(h); `.claude/commands/nimbus-egress.md` and `nimbus-sandbox-and-extensions.md` updates; `CLAUDE.md` + `GEMINI.md` status line (schema V71). CHANGELOG also states that adding the `registry` coverage class makes `nimbus prove` report a window spanning the upgrade as `indeterminate` (the designed fail-safe). Cut the PR branch per the branch workflow, `bun run preflight`, PR `feat(extensions): extension registries — add, search, install (Phase 9.5 project 1, PR 3)`.

---

# PR 4 — Updates from the source registry; remove the dead client; invariant I44 (spec §§ 8.8, 8.9, 10, 11)

### Task 13: Auto-update daemon reads registries

**Files:**
- Create: `packages/gateway/src/extensions/registry/registry-update-source.ts` (+ test)
- Modify: `packages/cli/src/commands/extension.ts` (`AvailableUpdateCli` ~L769 mirrors the new `VerificationStatus` and renamed fields; `formatUpdateRow` shows `from <sourceRegistry>` and a `publisher key changed` marker), `auto-update.ts` (opts), `auto-update-types.ts`, `auto-update-init.ts`, `auto-update-orchestrate.ts`, `auto-update-rpc.ts` (drop the `needs_sync` hint; prompt payload adds `sourceRegistry`, `rootFingerprint`), `platform/assemble.ts` (`maybeStartAutoUpdateRuntime`), `ipc/server/options.ts`/`assemble.ts` (set `extensionsEnforceAirGap` from the same accessor)
- Delete: `extensions/registry-client.ts`, `registry-fetcher.ts`, `sync.ts`, `publisher-keys.ts`'s `resolvePublisherKey` fetch branch + `RegistryUnreachable`/`PublisherNotRegistered`/`AirGapNoPublisherKey` if unused, their tests; `extension.sync` from `automation-rpc.ts`, `lan-rpc.ts`, CLI (`runExtensionSync`, usage string), `ipc/server/options.ts` `extensionsPublisherKeyFetcher`; the D22(h) temporary allow-list entry; `registryClient` option and solver remote branch in `install-from-local.ts`; `NIMBUS_EXTENSIONS_REGISTRY_URL` from `assemble.ts` and `platform/demo-boot.ts`

**Interfaces:**
- `auto-update-types.ts`: `VerificationStatus = "verified" | "signature_failed" | "publisher_key_conflict"`; `AvailableUpdate` drops `tarballUrl`, renames `tarballSha256`→`packageSha256`, `tarballSizeBytes`→`packageSizeBytes`, adds `sourceRegistry: string; rootFingerprint: string; packagePath: string`; `UpdateRejectReason` replaces `"publisher_key_missing"` with `"publisher_key_conflict"`.
- `registry-update-source.ts`: `export interface InstalledRegistryRow { id; version; enabled: number; source: { registry: string; rootFingerprint: string; channel: RegistryChannel }; publisherId: string; manifest: InstalledExtensionManifestSlice }` and `export async function collectRegistryUpdates(deps: { db; fetch: RegistryFetchDeps; vault: NimbusVault; verifyManifestSignature: (m: object, k: Uint8Array) => Promise<void>; now: () => number }, rows: InstalledRegistryRow[], signal: AbortSignal): Promise<{ updates: AvailableUpdate[]; errors: Array<{ registry: string; error: string }> }>` — group by `source.registry`; skip a group whose registry row is gone or whose `rootFingerprint` ≠ `source.rootFingerprint`; one `fetchVerifiedIndex` per group; for each row with a newer version on its channel set (`stable` or `stable ∪ beta`), one ledgered manifest fetch, `manifestSha256` check, publisher key = index key, Vault mismatch → status `publisher_key_conflict`, else verify signature → `verified`/`signature_failed`; permission diff via existing `auto-update-permissions-diff.ts`.
- `ExtensionAutoUpdaterOpts`: replace `fetchLatestVersion`, `fetchManifest`, `lookupPublisherKey`, `solverRemoteFetchManifest` with `collect: (rows: InstalledRegistryRow[], signal: AbortSignal) => ReturnType<typeof collectRegistryUpdates>`; `enforceAirGap: () => boolean` (checked per tick, not only at `start`, since local registries still work under air-gap: the fetch layer refuses remote ones).
- `PerformUpgradeDeps.fetcher` → `fetchPackage: (update: AvailableUpdate, signal: AbortSignal) => Promise<Uint8Array>` (ledgered `registry.package` via `fetchRegistryBytes`, `maxBytes: MAX_TARBALL_BYTES`), then `packageSha256` check, then Task 2's pipeline. The apply path also re-verifies the manifest: fetch the update's manifest again via the index hash and run `verifyManifestSignature` with the index's publisher key before swapping.
- `maybeStartAutoUpdateRuntime`: construct whenever `!disabled && bootPolicyFor(paths).extensionsAutoUpdate`; `createAutoUpdateRuntime` opts drop `registryBaseUrl`, gain `fetch: RegistryFetchDeps`.

- [ ] **Step 1: Failing tests** (`registry-update-source.test.ts`, `auto-update.test.ts`, `auto-update-orchestrate.test.ts`): `one index fetch per registry per tick regardless of extension count` (count egress rows: 3 extensions from one registry → 1 `registry.index` row); `an id also present in another registry is ignored`; `a registry whose root fingerprint changed yields no update`; `removed registry yields no update`; `stable install ignores beta, beta install sees stable ∪ beta`; `publisher key change in the index surfaces as publisher_key_conflict`; `one failing registry does not block another in the same tick`; `local-path installs are never polled`; in `install-from-local.test.ts`: `a signed local install with no --publisher-key and no Vault key names --publisher-key` (replaces the old "requires vault and publisher key fetcher" error, spec § 8.9); `apply refuses a package whose sha differs`; `apply refuses when the re-fetched manifest signature fails`; `a registry added after boot is polled on the next tick` (call `pollOnce` twice around `insertRegistry`).
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions` — FAIL.
- [ ] **Step 3: Implement**, perform the deletions, fix every compile error they surface (`bun run typecheck`).
- [ ] **Step 4: Run** `bun test packages/gateway packages/cli` scoped to touched dirs, `bun run typecheck`, `bun run typecheck:tests`, `bun run audit:invariants` — PASS.
- [ ] **Step 5: Commit** `feat(extensions): updates come only from an extension's source registry; remove the dead registry HTTP client`

### Task 14: Invariant I44, acceptance E2E, docs

**Files:**
- Create: `packages/gateway/test/e2e/registry-acceptance.e2e.test.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md` + `GEMINI.md` (I44 line, "Invariants I1–I44"), `docs/roadmap.md` (Phase 9.5 rows: registry client + BYO registry partially done, with what did NOT ship), `docs/CHANGELOG.md`, `docs/architecture.md` (auto-update section), `docs/cli-reference.md` (remove `extension sync`), `.claude/commands/nimbus-sandbox-and-extensions.md`, `nimbus-security-invariants.md` if it enumerates

**Interfaces:**
- I44 wording (one line in CLAUDE.md, full rationale in SECURITY-INVARIANTS.md): "registry-sourced extension code is installed or updated only through `extensions/registry/registry-fetch.ts`'s verified chain — pinned root key, non-decreasing sequence, index hashes for manifest and package, the index-named publisher key and its I16 signature — and only from the extension's recorded source registry while that registry's root fingerprint is unchanged; a bare id present in two registries is refused, never prioritised · `extensions/registry/*`, `extensions/auto-update*.ts`". Bounds to state: freeze attacks (no expiry); `http:` loopback only outside production; `file:` registries append no egress row by design; the root key file's protection is the maintainer's.

- [ ] **Step 1: Failing tests**:
  - `security-invariants.test.ts` `describe("I44 — …")`: source pins that `install-from-registry.ts` calls `fetchVerifiedIndex` and checks `packageSha256` before `installExtensionFromLocalDirectory`; behavioural: tampered index → install refuses; update from a non-source registry → none offered; ambiguity → refused.
  - `nimbus doctor` (`packages/cli/src/commands/doctor-core.ts`, + test): `doctor warns about an extension whose source registry was removed` and `doctor warns about a registry whose index is stale (generatedAt older than 30 days)`, both from `registry.list` + `extension.list`; silent when no registries are configured (spec §§ 7.2, 8.3).
  - `registry-acceptance.e2e.test.ts` (template `extension-runtime.e2e.test.ts`'s `TestIpcClient` with `onNotification("consent.request", …)` auto-approving; `describe.skipIf(!sandboxAvailable)` for the run step): build a registry folder with the CLI maintainer functions; `registry.add` (local path); `registry.search` finds it; `registry.install`; `extension.approveRun`; add v2 to the folder; `extension.checkForUpdates` lists v2 with `sourceRegistry`; `extension.update` applies; run grant no longer matches (`extension.list` run state not `approved`); flip one byte of `package.tgz` for a v3 → update apply refuses.
- [ ] **Step 2: Run** `bun test packages/gateway/src/security-invariants.test.ts packages/gateway/test/e2e/registry-acceptance.e2e.test.ts` — FAIL.
- [ ] **Step 3: Implement** the invariant docs and any missing wiring the tests expose.
- [ ] **Step 4: Run** `bun run preflight` — PASS. Then the manual dogfood run (spec § 11) in the LOCALAPPDATA acceptance sandbox, by the owner; record the result in the PR description.
- [ ] **Step 5: Commit** `feat(extensions): invariant I44 for registry-sourced code; acceptance test`

**PR 4 close:** cut the PR branch per the branch workflow (this is the last one; the work branch and its docs are then deleted after merge), `bun run preflight`, PR `feat(extensions): registry-sourced updates and invariant I44 (Phase 9.5 project 1, PR 4)`.
