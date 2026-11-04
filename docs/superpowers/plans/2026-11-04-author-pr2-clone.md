# Author onboarding PR 2 — `nimbus extension clone` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nimbus extension clone <id>` puts an editable copy of a published registry package in a folder, fetched through the verified registry chain, with the original publisher's key and signature removed, ready to install unsigned or to sign with the author's own key.

**Architecture:** A new gateway method `registry.cloneSource` runs the same verified fetch as install (I44: root, sequence, index hashes, the I16 signature, I48 blocks) minus the "already installed" refusal and minus the publisher-key decision (owner ruling R5), and stages the hash-checked archive in a gateway-owned directory under the data dir. The CLI reads that archive, re-checks its sha256, unpacks it with `registry-format` `inspectPackage`, rewrites the manifest and writes `CLONED_FROM.md`. Nothing is installed, approved or stored in the Vault.

**Tech Stack:** Bun, TypeScript strict, `@nimbus-dev/registry-format`, Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-author-onboarding-design.md` § 5 and § 9, branch `dev/asaf/author-onboarding-spec`. Owner rulings R2, R5, R6.

## Global Constraints

- Clone never installs, never asks for approval, writes no `extension` row and no Vault entry, and runs `publisherKeyDecision` never. It does verify the index-named key's I16 signature, the manifest and package hashes, and the I48 blocks.
- The two writes the shared fetch already makes stay and are documented: the registry anti-rollback sequence advances, and the egress ledger gets its rows.
- `registry.cloneSource` lives in the `registry` namespace, so it is LAN-refused (`lan-rpc.ts` denies the whole namespace) and absent from the Tauri allowlist; neither list changes.
- The gateway writes only inside `<dataDir>/registry-clone-staging/`; the CLI writes only inside `--into` and its own temp dir.
- IPC lines are capped at 1 MiB (`IPC_MAX_LINE_BYTES`), so the archive never travels over IPC.
- `<name>` = the last `/`-segment of the id; `--into` defaults to `./<name>`; an existing non-empty `--into` is refused before any request.
- License (R6): clone never refuses on licence. It warns when `license` is absent, malformed, or contains an id not in the baked OSI list.
- I44 is amended under the triple rule (wiring, docs, test in ONE commit): Task 2.
- Every string from a manifest or reply printed by the CLI goes through `stripControlChars`.
- Run `bun run preflight:fast` and `bun run typecheck:tests` before every push.

## Rulings made in this plan (against the spec)

- **The method is `registry.cloneSource`, not `extension.cloneSource`.** The `registry` namespace is denied over LAN as a whole and has no renderer method, so the spec's "refused over LAN and absent from the Tauri allowlist" holds with no list edit. Cost if wrong: a rename.
- **The archive is handed over through a staging file, not IPC.** The spec left the transport to the builder; IPC lines are capped at 1 MiB and packages may be 50 MiB. The gateway sweeps staging entries older than one hour on every call, and the CLI removes its entry after reading. Cost if wrong: a stale archive in the data dir until the next clone.
- **The OSI list is a curated subset**, so an OSI-approved id missing from it only produces the warning. Cost if wrong: an unneeded warning.

## Plan review record

Antigravity (2026-11-04) raised 7 findings. Applied 6: the CLI removing `dirname(archivePath)` without a containment check (now a shape check and file-then-dir removal); `InstallFromRegistryDeps` far wider than clone needs (`CloneSourceDeps`); the shared steps extracted as `fetchVerifiedPackageBytes`; the publisher-id rule lives in `parseExtensionArgs`, not `resolveExtensionId`; `mkdirSync` of the staging root; symlink and containment checks for `--into`. Rejected 1: "the RPC strips the error code" is false — `RegistryError` and `TrustBlockError` both lead `message` with the code — but it exposed a wrong prefix in this plan (`ERR_TRUST_` → the real `ERR_EXTENSION_KEY_REVOKED` / `ERR_EXTENSION_TAKEN_DOWN`), now fixed.

## Review Focus

1. Cloning an extension that is installed works, and leaves the installed row, its run grant and the Vault untouched (Task 2).
2. A revoked or taken-down version, a tampered archive and a bad signature are each refused, with nothing staged (Task 2).
3. An `--into` that is a file, a non-empty directory, or a path through `..` is handled before any request: file or non-empty → exit 2 (Task 3).
4. The staged archive changed between gateway and CLI (sha mismatch) is refused and nothing is written to `--into` (Task 3).
5. A manifest whose `id` has no `/` still gives a usable `<name>` (Task 3).

---

### Task 1: The OSI licence check (registry-format)

**Files:**
- Create: `packages/registry-format/src/osi-licenses.ts`, `packages/registry-format/src/osi-licenses.test.ts`
- Modify: `packages/registry-format/src/index.ts`; `packages/registry-format/src/author-metadata.ts` only if a shared tokenizer must be exported (prefer exporting the existing tokenizer over a second one)

**Interfaces:**
- Produces:
  ```ts
  export const OSI_LICENSE_IDS: ReadonlySet<string>;
  /** Ids in a VALID expression (as `readManifestLicense` accepts) that are not OSI-listed; exception ids after WITH are ignored; a trailing `+` is stripped before lookup. */
  export function nonOsiLicenseIds(expr: string): string[];
  ```
- The set, exactly: `0BSD AFL-3.0 AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-2.0 Artistic-2.0 BlueOak-1.0.0 BSD-2-Clause BSD-3-Clause BSL-1.0 CDDL-1.0 CECILL-2.1 ECL-2.0 EPL-1.0 EPL-2.0 EUPL-1.2 GPL-2.0 GPL-2.0-only GPL-2.0-or-later GPL-3.0 GPL-3.0-only GPL-3.0-or-later ISC LGPL-2.1 LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later MIT MIT-0 MPL-2.0 MS-PL MS-RL NCSA OFL-1.1 OSL-3.0 PostgreSQL Python-2.0 UPL-1.0 Unlicense Zlib`. Lookup is case-sensitive, as SPDX ids are.

- [ ] **Step 1: Failing tests:** `nonOsiLicenseIds("MIT")` → `[]`; `("MIT OR Apache-2.0")` → `[]`; `("GPL-2.0+")` → `[]`; `("Apache-2.0 WITH LLVM-exception")` → `[]`; `("LicenseRef-Acme-1.0")` → `["LicenseRef-Acme-1.0"]`; `("MIT AND Proprietary-1")` → `["Proprietary-1"]`; `("(BUSL-1.1 OR MIT)")` → `["BUSL-1.1"]`; `("mit")` → `["mit"]`; `OSI_LICENSE_IDS.size === 43`.
- [ ] **Step 2: Run** `bun test packages/registry-format/src/osi-licenses.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Reuse the licence tokenizer from `author-metadata.ts` (export it if needed); do not write a second grammar.
- [ ] **Step 4: Run** `bun test packages/registry-format` — PASS; rebuild the registry action (`bun run --cwd packages/github-actions/registry-action build`) and run `bun run audit:action-dist`.
- [ ] **Step 5: Commit** `feat(registry-format): list OSI-approved licence ids`.

### Task 2: `registry.cloneSource` and the I44 amendment

**Files:**
- Create: `packages/gateway/src/extensions/registry/clone-source.ts`, `packages/gateway/src/extensions/registry/clone-source.test.ts`
- Modify: `packages/gateway/src/extensions/registry/install-from-registry.ts`: extract the shared steps into an exported `fetchVerifiedPackageBytes(fetchDeps: RegistryFetchDeps, db: Database, req: { id: string; registry?: string; version?: string; channel?: string }): Promise<{ reg; index; entry; version; vEntry; fetched; packageBytes; rootFingerprint }>` (resolve, `selectVersion`, `assertNotBlocked`, manifest fetch, hashed package fetch, signature verify, in that order). `fetchVerifiedRegistryPackage` calls it between its installed-id check and its key decision and extraction, so install's behaviour and order are unchanged; clone calls it alone. `selectVersion` stays module-private.
- Modify: `packages/gateway/src/ipc/registry-rpc.ts` (`case "registry.cloneSource"`, `RegistryRpcOptions.cloneStagingDir?: string`)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchRegistryRpc` passes `cloneStagingDir: join(ctx.options.dataDir, "registry-clone-staging")` when `dataDir` is set)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I44 block), `docs/SECURITY-INVARIANTS.md` (I44 entry), `CLAUDE.md` and `GEMINI.md` (the I44 line), identically

**Interfaces:**
- Produces:
  ```ts
  export interface CloneSourceRequest { readonly id: string; readonly registry?: string; readonly version?: string }
  export interface CloneSource {
    readonly id: string; readonly version: string; readonly channel: string; readonly registry: string;
    readonly publisherId: string; readonly keyFingerprint: string;
    readonly verifiedPublisher: { readonly github: string; readonly verifiedAt: string } | null;
    readonly packageSha256: string; readonly archivePath: string;
  }
  export interface CloneSourceDeps { readonly db: Database; readonly fetch: RegistryFetchBag }
  export async function cloneRegistrySource(deps: CloneSourceDeps, req: CloneSourceRequest, stagingRoot: string): Promise<CloneSource>;
  export function sweepCloneStaging(stagingRoot: string, now: number, maxAgeMs?: number): void; // default 3_600_000
  ```
- `registry.cloneSource` params `{ id, registry?, version? }`; reply = `CloneSource`. Missing `cloneStagingDir` → `RpcMethodError(-32603, "Gateway has no data directory for clone staging")`.
- Steps, in order: `mkdirSync(stagingRoot, { recursive: true })`; sweep; resolve entry (`resolveRegistryEntry`); I48 version selection and `assertNotBlocked` exactly as install; `fetchRegistryManifest`; `fetchHashedPackage`; `verifyRegistryManifestSignature`; then `mkdtempSync(join(stagingRoot, "c-"))` and write `package.tgz` there (`archivePath` is that absolute path) (mode 0600 where the OS supports it). Any failure after the mkdtemp removes it. No `publisherKeyDecision`, no extraction, no installed-id check.
- `verifiedPublisher` from `verifiedPublisherFor` with the registry source, as `registry.info` does.

- [ ] **Step 1: Failing tests** in `clone-source.test.ts` against the existing test registry builder used by `install-from-registry` tests (find it; reuse it; no new fake transport):
  - clones a version whose publisher key the Vault has never seen: returns the reply, the archive exists and its sha256 equals `packageSha256`; afterwards `listExtensions(db)` is unchanged and the test Vault holds no publisher key;
  - clones an id that is installed: succeeds; the installed row and its run grant are unchanged;
  - a taken-down version → `TrustBlockError` (or the error install throws), nothing under `stagingRoot`;
  - a tampered package (hash mismatch) → `ERR_REGISTRY_HASH_MISMATCH`, nothing staged;
  - a manifest whose signature does not verify → the error install throws, nothing staged;
  - `sweepCloneStaging` removes an entry older than the max age and keeps a fresh one;
  - install still refuses an installed id and still runs the key decision (an existing install test passing proves it; name it in the report).
- [ ] **Step 2: Failing RPC test** in the registry-rpc tests: `registry.cloneSource` routes, returns the reply, and refuses without `cloneStagingDir`.
- [ ] **Step 3: Failing invariant test** in `security-invariants.test.ts` I44 block: clone of an unknown-key package writes no Vault key and no extension row; clone of a blocked version is refused.
- [ ] **Step 4: Run** the three test files — FAIL.
- [ ] **Step 5: Implement**, and amend I44 in `docs/SECURITY-INVARIANTS.md` (one paragraph: registry bytes reach an author's clone only through the same verified chain, from the extension's registry; the one stated difference is that clone makes no publisher-key decision and stores no key, because nothing it produces is installed or run under that publisher; the two writes it shares with install), and the same one-clause addition to the I44 line in `CLAUDE.md` and `GEMINI.md`.
- [ ] **Step 6: Run** the three files plus `bun test packages/gateway/src/extensions/registry`, `bun run audit:invariants`, `bun run audit:doc-refs` — PASS.
- [ ] **Step 7: Commit** (ONE commit: wiring + docs + test) `feat(gateway): registry.cloneSource fetches a verified package for an author's clone`.

### Task 3: `nimbus extension clone`

**Files:**
- Create: `packages/cli/src/commands/extension-clone.ts`, `packages/cli/src/commands/extension-clone.test.ts`
- Modify: `packages/cli/src/commands/extension.ts` (`dispatchExtensionWithCode` handler `clone` with `args.slice(1)`; `EXTENSION_USAGE`; `rpcTimeoutForExtensionSub` gives `clone` the interactive budget; `--into` and `--publisher` in `stripFlags`' value flags)

**Interfaces:**
- Consumes: `registry.cloneSource` (Task 2), `inspectPackage`, `readManifestLicense`, `readManifestRepository`, `nonOsiLicenseIds` (Task 1), the id rule used by `nimbus scaffold extension` (`resolveExtensionId` in `scaffold.ts`; import it or move it to a shared module, do not copy it).
- Produces: `runExtensionClone(args: readonly string[], deps: CloneDeps): Promise<number>`; `CloneDeps = { client: IPCClient; cwd: string; tmpDir: string; now: () => Date; log: (s: string) => void; err: (s: string) => void }`.
- Usage: `nimbus extension clone <id> [--registry <name>] [--version <v>] [--into <dir>] [--publisher <id>] [--json]`.
- Order:
  1. Parse args (unknown flag, missing value, extra positional → usage, exit 2). Resolve `--into` to an absolute path (default `<cwd>/<name>`); an existing file, an existing non-empty directory, or an existing symlink (checked with `lstatSync`) → `<dir> already exists and is not empty` (symlink: `<dir> is a symbolic link`) exit 2. Validate `--publisher` with the scaffold's publisher-id rule: move the `PUBLISHER_ID_RE` / length / `.lock` checks out of `parseExtensionArgs` into an exported `publisherIdProblem(id: string): string | undefined` in `scaffold.ts`, used by both; then build the new id with `resolveExtensionId(name, publisher)`.
  2. `registry.cloneSource`. An error whose message contains `ERR_REGISTRY_`, `ERR_EXTENSION_KEY_REVOKED` or `ERR_EXTENSION_TAKEN_DOWN` (both `RegistryError` and `TrustBlockError` lead their message with the code, and `registry-rpc.ts` passes `e.message` through) → cleaned message, exit 1; anything else is rethrown.
  3. Check `archivePath` BEFORE touching it: absolute, `basename` is `package.tgz`, and its parent's basename starts with `c-` and the grandparent's basename is `registry-clone-staging`; otherwise `the gateway returned an unexpected staging path; nothing was written` exit 1, and nothing is read or removed. Then read it once; sha256 must equal `packageSha256`, else `the staged package changed before it was read; nothing was written` exit 1. In a `finally`, remove only `archivePath` and then its `c-*` parent (non-recursive `rmdirSync`, ignoring failure).
  4. Write the checked bytes to a fresh dir under `tmpDir` and `inspectPackage` it; copy every file in `inspected.files` from `<work>/x` into `--into` (created with `mkdirSync`, which fails if it appeared meanwhile). For each file assert the resolved destination is strictly inside `--into` and the resolved source strictly inside `<work>/x`; refuse otherwise. Remove the work dir in a `finally`.
  5. Rewrite `nimbus.extension.json`: delete `signature` and `publisher`; with `--publisher <p>`, `id` = `<p>/<name>` and `publisher` = `{ "id": "<p>" }`. Two-space JSON plus a trailing newline.
  6. Write `CLONED_FROM.md`: original id, version, channel, registry, publisher id, key fingerprint, the verified-publisher text, the date (`now().toISOString()`), and `repository` when declared.
  7. Print (each value cleaned):
     - `Cloned <id>@<version> from <registry> into <dir>`
     - `Original publisher: <publisherId> (key <fingerprint>), <Verified publisher: @<github> | Unverified publisher>`
     - `License: <expr>` or `License: not declared` or `License: (invalid, ignored)`
     - a warning line, when the licence is absent, malformed or has non-OSI ids: `Warning: <reason>; make sure the licence lets you modify and redistribute this code.` — reasons `no licence is declared`, `the declared licence is malformed`, `<ids> is not an OSI-approved licence id` (ids comma-joined)
     - `Source: https://github.com/<repository>` or `This copy is built JavaScript (dist/); the package names no source repository.`
     - next steps: without `--publisher`, `Install it unsigned with: nimbus extension install <dir>` plus `(refused while <id> is installed: remove it first or clone with --publisher)`; with it, `Sign it first: nimbus extension keygen (once), then nimbus extension sign <dir>`.
  8. Any failure after `--into` was created removes what clone wrote there (clone created it, so it removes the directory).
- `--json` prints `{ id, version, registry, into, publisherId, keyFingerprint, verifiedPublisher, license, licenseWarning, repository, newId }` instead of the lines (`licenseWarning`, `repository`, `newId` null when absent).

- [ ] **Step 1: Failing tests** with a fake client returning a `CloneSource` whose `archivePath` is a real `.tgz` built in a temp dir with `packExtensionDir` from a fixture extension (signed manifest with `publisher` and `signature`):
  - the copy has every file, the manifest has no `signature`/`publisher`, the id is kept, `CLONED_FROM.md` names the fingerprint; exit 0; the staging entry is gone;
  - `--publisher acme` → id `acme/<name>`, `publisher: { id: "acme" }`;
  - a manifest id with no `/` → `<name>` is the whole id;
  - non-empty `--into`, a file at `--into`, and a symlink at `--into` (skip only where the OS cannot create one) → exit 2, no IPC call made;
  - an `archivePath` outside a `registry-clone-staging/c-*/package.tgz` shape → exit 1, nothing read, nothing removed (assert a sentinel file beside it survives);
  - sha mismatch (fake reply with a wrong `packageSha256`) → exit 1, `--into` not created;
  - each licence case gives its exact warning line; an MIT manifest gives none;
  - a label/id with `String.fromCodePoint(0x1b)` prints cleaned;
  - `--json` shape;
  - `rpcTimeoutForExtensionSub("clone", …)` is the interactive budget (beside the existing tests).
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/extension-clone.test.ts` — FAIL.
- [ ] **Step 3: Implement** and wire.
- [ ] **Step 4: Run** it and `bun test packages/cli/src/commands/extension.test.ts`; `bunx biome lint --only=complexity/noExcessiveCognitiveComplexity packages/cli/src/commands/extension-clone.ts` (split by phase if any function exceeds 15) — PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus extension clone writes an editable copy of a published extension`.

### Task 4: Docs, roadmap and gates

**Files:** `docs/cli-reference.md` (a `### nimbus extension clone …` section after `sponsor`: flags, what the copy is and is not, the licence warning, the R5 key note, the staging dir and its one-hour sweep, the two shared writes); `docs/roadmap.md` (the clone row ticked and rewritten without any signature bypass; the clone acceptance criterion replaced by the spec § 8 wording; the project 7 table row and the other status lines say PR 2 of 4); `docs/CHANGELOG.md` (dated entry); `CLAUDE.md`/`GEMINI.md` status sentence (PR 2 of 4), identically; `.claude/commands/nimbus-sandbox-and-extensions.md` (one line).

- [ ] **Step 1:** Write the docs; every flag, message and path quoted must match Tasks 1–3.
- [ ] **Step 2: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests` — PASS.
- [ ] **Step 3: Commit** `docs: nimbus extension clone`.
