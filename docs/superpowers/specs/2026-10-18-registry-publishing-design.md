# Extension registry: publishing (Phase 9.5, project 2 of 7)

> Status: design, awaiting owner approval. Feature-branch document only — it never lands on `main`;
> durable content moves to `docs/architecture.md`, `docs/cli-reference.md`,
> `docs/SECURITY-INVARIANTS.md`, `docs/roadmap.md` and `docs/CHANGELOG.md` before the PR, and this
> file is deleted on the branch.

## 1. Intent

Project 1 (shipped: #1695, #1699) made a registry a folder of root-key-signed static files that
Nimbus can add, search, install from and update from. Today a registry is built only by a maintainer
running `nimbus registry maintain add` with the root key on their own machine. Project 2 lets an
**extension author publish to a registry they do not own**, with an independent check and a human
review before anything becomes installable — the roadmap's "author publishing flow" and
"registry-side publish hook" — while keeping project 1's promise that a registry is static files
with no server of ours.

Why now: the owner wants all of Phase 9.5 shipped (it finishes S3). `docs/ecosystem-roadmap.md`
cautions against building the marketplace before an author is waiting, so this project makes the
**first-author path work end to end** — scaffold → build → sign → publish → install → the extension
actually RUNS.

## 2. Decisions the owner made

- **A registry is a git repository.** Publishing is a pull request against it; the registry repo's
  CI is the publish hook; merging is the review step; GitHub Pages (or any static host) serves the
  signed folder.
- **The root key is a CI secret**, used automatically after a merge — guarded by
- **a required reviewer on every signing run**: the signing job runs in a GitHub environment with
  required reviewers, so nothing is signed unless a human approves that specific run.
- **On the public registry, extension ids are namespaced by publisher**: an id must be
  `<publisher.id>/<name>`. Nobody can claim a bare name; the check enforces it mechanically. A
  registry can turn this off (private registries).
- **The first real registry is a new public repo `nimbus-agent/extensions`.** Creating it, its
  environment, secret, Pages and branch protection are the owner's steps; this project builds
  everything that goes in it.
- **The gateway's manifest is the source of truth** (`packages/gateway/src/extensions/manifest.ts`).
  The SDK's `runContractTests` validates a different schema no installable extension satisfies;
  unifying them is a recorded follow-up.

## 3. Goals

1. `nimbus scaffold extension <name>` produces an extension the gateway installs AND runs unchanged.
2. `nimbus extension publish <dir> --registry-repo <owner/repo>` prepares a publish pull request,
   with Nimbus never holding a GitHub token.
3. A GitHub Action with two modes: **check** a publish PR, **sign** after a merge.
4. `nimbus registry maintain init <dir> --github` writes the registry repo's workflows, config and
   README, so starting a registry (public or company-internal) is one command plus the owner steps.
5. `nimbus-agent/extensions` can go live as soon as the owner performs § 7.6.

## 4. Non-goals

- Baked verified-publisher trust store, publisher key rotation, takedown/moderation ledger,
  provenance attestation — project 3.
- Dependencies and starter packs — project 4. `nimbus eval`, quality scores, ratings — projects 5–6.
- Any runtime check of a package in CI (running extension code on the runner). The SDK's
  `runSandboxContractTests` is NOT used: it never loads the extension, probes whatever confines
  the harness process, would make the runner contact an author-chosen host, and its
  `/etc/passwd` probe fails under bwrap's read-only bind. The job summary says plainly that no
  runtime check is performed.
- Unifying the SDK and gateway manifest schemas (follow-up, recorded on the roadmap).
- A Nimbus-hosted upload server; Nimbus storing or using a GitHub token; forges other than GitHub.

## 5. Anti-goals

- **Anything becomes installable without passing the check, a human merge, AND a human approval
  of the signing run.**
- **The root key is reachable from a workflow triggered by a pull request** (including forks).
- **A publish PR changes `index.json`, the signed site, workflows, registry config, or another
  extension's files** without the check failing.
- **The check job, the sign job and the client disagree** on validity (separate copies of rules).
- A published version can be overwritten, or an id's publisher key silently changed.
- A scaffolded extension installs but cannot run.

## 6. Constraints

Non-negotiables apply (platform equality for the CLI; no `any`; no plaintext credentials). Project
1's format is fixed: `index.json` (format 1, rootKey, increasing `sequence`, per-version
channel/name/canonical paths/SHA-256s/size/entryHash/publishedAt), canonical-JSON Ed25519 signature
via the SDK's deprecated NFC `canonicalize` (never `@nimbus-dev/sdk/signing`), strict SemVer version
keys, caps (package ≤ 50 MiB, unpacked ≤ 200 MiB / 5000 entries, manifest ≤ 64 KiB, index ≤ 8 MiB),
deterministic packing. I16 publisher signatures and the I43 runtime are unchanged.

## 7. Design

### 7.1 Scaffold (`nimbus scaffold extension <name>`, split from `scaffold mcp`)

Today `extension` is an alias of `mcp`; it becomes its own template (`scaffold mcp` is unchanged).
The extension template:

- `nimbus.extension.json`, gateway-valid: `id` (`<publisher>/<name>` once keygen is known —
  scaffold takes `--publisher <id>`; without it the id is `<name>` and the README says namespacing
  is required on the public registry), `version: "0.1.0"`, `name`, `entry: "dist/index.js"`,
  `permissions: { network: [], filesystem: { read: [], write: [] } }`, `updateChannel: "stable"`.
- The build is a single-file JavaScript bundle `bun build src/server.ts --target=bun
  --outfile dist/index.js` (NOT `--compile` — the I43 runtime `import()`s the entry as JS on every
  OS), and the server starts unconditionally when imported (no `import.meta.main` guard — false
  under `import()`).
- A **package file set**: the published package contains exactly `nimbus.extension.json`,
  `dist/**`, and `README.md`/`LICENSE` if present — never `node_modules`, `src`, tests. One shared
  function decides the set; scaffold documents it; publish and `registry maintain add <dir>` use
  it (a `<dir>` input to `maintain add` packs the same set).
- README "next steps": build → `nimbus extension keygen` → `nimbus extension sign .` →
  `nimbus extension publish . --registry-repo nimbus-agent/extensions`.
- Test: the scaffolded tree, built and signed, installs via the gateway's installer AND, approved
  to run, starts and answers an MCP `tools/list` with the `echo` tool through the real I43 runtime
  (sandbox-dependent leg skipped only where the sandbox is unavailable, never silently).

### 7.2 `nimbus extension publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--no-pr]`

Offline-first, no gateway, no token:

1. Validate locally with the SAME module the action uses (§ 7.4): manifest (gateway rules),
   `publisher` + `signature` present and the I16 signature verifies with the manifest's key, entry
   inside the tree, package file set, deterministic pack, caps, and — when the registry requires
   it — the id namespace rule.
2. Working clone: `--clone <path>` (existing, clean) or a shallow `git clone
   https://github.com/<owner>/<repo>` into a temp dir.
3. Read the registry's published state (§ 7.3 — the signed `index.json` on the `gh-pages`
   branch, verified against its own rootKey) and the registry config on the default branch;
   pre-check: `<id>@<version>` absent; an existing id's bound key equals the manifest's.
4. On a new branch `publish/<id>/<version>` write ONLY `extensions/<id>/<version>/manifest.json`
   (signed bytes, verbatim), `package.tgz` and `publish-request.json`
   (`{ id, version, channel, publisherFingerprint }`, channel default `stable`). Commit.
5. If `gh` is on PATH and authenticated, fork and `gh pr create`; otherwise (or `--no-pr`) print
   the branch, clone path and exact `git push` / `gh pr create` commands. `gh` owns auth; Nimbus
   never reads, stores or passes a token. `git`/`gh` are spawned hidden with argv arrays.

### 7.3 Registry repository layout

- **Default branch (`main`, protected)**: sources only — `extensions/<id>/<version>/…` as merged
  from publish PRs, `nimbus-registry.json` (config: `{ "format": 1, "requirePublisherNamespace":
  true }`), the workflows, README. It never holds a signed `index.json`.
- **`gh-pages` branch**: the published site — the signed `index.json` plus the
  `extensions/<id>/<version>/{manifest.json,package.tgz}` it references. Written only by the sign
  job (the branch is not protected by required reviews, so the job's `GITHUB_TOKEN` can push;
  `main`'s protection stays intact). Pages serves `gh-pages`. A `GITHUB_TOKEN` push triggers no
  workflows, so there is no signing loop.
- The previous signed `index.json` on `gh-pages` is the source of truth for sequence and publisher
  bindings for both check and sign.

### 7.4 The registry action (`packages/github-actions/registry-action`, **node24**)

One action, `mode: check | sign`, bundled with `bun build --target=node` into a committed
`dist/`. **Single source of rules:** it bundles the same validation the CLI uses. That requires a
refactor, part of this project: move `assertSafeExtensionId` and the other pure helpers out of
`install-from-local.ts` into a leaf module; extract the package inspection/validation from
`registry-maintain.ts` (`inspectPackage`, `validateManifest`) into an exported lib module that uses
the gateway's manifest rules (one validator, not two); keep `index-format.ts` and the signer free of
Bun-only and database imports. A **closure test** builds the action bundle and fails if its import
graph reaches `bun:*`, the migration runner, sqlite-vec or any DB module; a **drift gate** fails if
`dist/` is not the build of the current sources. Project 1's golden vector runs against the bundled
signer.

**`check`** (on `pull_request`; `permissions: contents: read`; no secrets):
- Path rule: the diff may only ADD files under `extensions/<id>/<version>/` for exactly one new
  `<id>@<version>` (`manifest.json`, `package.tgz`, `publish-request.json`). Any other change —
  workflows, `nimbus-registry.json`, README, another extension's files — fails.
- Validates with the shared module against the `gh-pages` signed index: new version, bound key
  equality, namespace rule (if `requirePublisherNamespace`), caps, signature.
- Job summary for the reviewer: id, version, channel, publisher fingerprint, **NEW ID** flagged
  prominently, declared permissions (network hosts, read/write paths), and "no runtime check of
  the package is performed".
- Because a PR can edit the check workflow itself, a green check is NOT the boundary; it is a
  reviewer aid. The boundary is the sign job + its required approval.

**`sign`** (on `push` to the default branch AND `workflow_dispatch`; `environment:
registry-signing` with required reviewers; `permissions: contents: write`; `concurrency:
registry-sign`, `cancel-in-progress: false`):
- Checks out the LATEST default-branch HEAD (not `github.sha`) and the `gh-pages` branch.
- Is the content boundary: for every `extensions/<id>/<version>/` on `main` not yet in the signed
  index it re-runs the shared validation against the signed bindings; a dir that fails is SKIPPED
  and named in the job summary (never signed later unless it is fixed and passes); dirs already in
  the index must be byte-identical to what was signed (a changed signed version fails the run).
- Refuses outright (nothing signed) if the root key's public half ≠ the signed index's `rootKey`,
  or if `nimbus-registry.json` changed since the last signed run in a way that loosens a rule
  (e.g. namespace turned off) — loosening is a maintainer action done by hand.
- Adds passing entries (name from manifest, channel from `publish-request.json`, hashes, size,
  entryHash, `publishedAt` = HEAD commit time), `sequence + 1`, signs, writes the site into
  `gh-pages` and pushes; on a non-fast-forward it re-fetches and retries from the top (bounded).
- Idempotent: nothing new → no commit.
- Stated bound: a merged change to a workflow file runs on the next push; the required approval of
  the signing run is what stops a tampered `registry-sign.yml` from using the key, so the reviewer
  approving a run must check that run's workflow diff.

### 7.5 `nimbus registry maintain init <dir> --github`

In addition to today's init, writes `.github/workflows/registry-check.yml`,
`.github/workflows/registry-sign.yml` (exact triggers/permissions/environment/concurrency of
§ 7.4), `nimbus-registry.json` (`requirePublisherNamespace: true` unless
`--no-publisher-namespace`), and a README explaining how to publish and how to approve signing
runs. The workflows reference the action by **path in this monorepo pinned to the CLI's own
release tag** (`nimbus-agent/Nimbus/packages/github-actions/registry-action@v<cli-version>`; tags
are immutable under the protected-tags ruleset). It prints the root key's fingerprint and the
secret value to set, once. The empty signed index goes to the `gh-pages` layout (init creates the
site folder the sign job maintains; the owner pushes it to `gh-pages` once).

### 7.6 The first registry — owner steps (docs page)

Create `nimbus-agent/extensions`; run `nimbus registry maintain init <clone> --github`; push `main`
and the initial `gh-pages`; create environment `registry-signing` with required reviewers and the
secret `NIMBUS_REGISTRY_ROOT_KEY`; set Pages to serve `gh-pages`; protect `main` (PRs required).
Nothing in this project pushes to that repo.

## 8. Testing and acceptance

- Unit: shared validator used by CLI publish, maintain add, and both action modes (parity by
  construction + a test that all four call it); path rule; namespace rule; sign skips a bad dir and
  signs the rest; sign refuses a changed signed version, a mismatched key, a loosened config;
  idempotence; sequence +1; closure test; dist drift gate; workflow YAML from `init --github`
  asserts triggers/permissions/environment/concurrency exactly.
- Integration (real temp git repos with a local bare remote and `gh-pages` branch; no network): a
  good publish passes check and sign; rejects a changed `index.json`/workflow/config/other
  extension, a second version, a changed key, a non-namespaced id, a duplicate, an unsigned
  manifest, an oversized package; a fake `gh` receives the expected argv; `--no-pr` prints
  commands.
- **Acceptance**: scaffold (`--publisher`) → build → keygen → sign → `publish --no-pr` into a local
  registry clone → action `check` on that diff → merge → action `sign` → `nimbus registry add` the
  `gh-pages` folder → `nimbus extension install` → `nimbus extension approve` → `nimbus connector
  tools ext_…` lists `echo` (the extension RUNS). Sandbox-dependent step skipped only where the
  sandbox is unavailable, with the skip stated.

## 9. Left to the builder

Module names for the extracted leaf modules; action source layout; CLI output wording; the bounded
retry count for the `gh-pages` push; whether `publish-request.json` is copied to `gh-pages` (it
must not affect the signed index).

**Follow-ups to record (not in scope):** unify the SDK `runContractTests` schema with the gateway's;
non-GitHub forges; bucket-hosted private registries; migrate the two existing actions to node24.

## 10. Calls made after the builder check (owner to skim)

`gh-pages` holds the signed site so `main` stays protected; the sign job (with required approval)
is the security boundary, the check job a reviewer aid; bad dirs are skipped and reported, not
run-blocking; the SDK sandbox probe is dropped; the action targets node24 and is pinned by path to
the CLI release tag; refactor shared validation into Bun-free leaf modules with a closure test;
the scaffold becomes its own template that builds a runnable JS bundle with a defined package file
set; acceptance proves the extension runs.
