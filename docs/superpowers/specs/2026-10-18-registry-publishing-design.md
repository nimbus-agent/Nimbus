# Extension registry: publishing (Phase 9.5, project 2 of 7)

> Status: design, awaiting owner approval. Feature-branch document only — it never lands on `main`;
> durable content moves to `docs/architecture.md`, `docs/cli-reference.md`,
> `docs/SECURITY-INVARIANTS.md`, `docs/roadmap.md` and `docs/CHANGELOG.md` before the PR, and this
> file is deleted on the branch.

## 1. Intent

Project 1 (shipped: #1695, #1699) made a registry a folder of root-key-signed static files that
Nimbus can add, search, install from and update from. A registry today is built only by a
maintainer running `nimbus registry maintain add` with the root key on their own machine. Project 2
lets an **extension author publish to a registry they do not own**, with an independent check
before anything becomes installable — the roadmap's "author publishing flow" + "registry-side
publish hook" — while keeping project 1's promise that a registry is static files with no server of
ours.

Why now: the owner wants all of Phase 9.5 shipped (it finishes S3). `docs/ecosystem-roadmap.md`
cautions against building the marketplace before an author is waiting; this project therefore
makes the **first-author path work end to end** (scaffold → sign → publish → install).

## 2. Decisions the owner made

- **A registry is a git repository.** Publishing is a pull request against it; the registry
  repo's CI is the publish hook; merging is the review step; GitHub Pages (or any static host)
  serves the folder.
- **The root key is a CI secret** (not a maintainer-only local step): after a merge, CI re-signs
  `index.json` automatically.
- **The first real registry is a new public repo `nimbus-agent/extensions`**, served by GitHub
  Pages. Creating the repo, enabling Pages and adding the secret are the owner's steps; this
  project builds everything that goes in it.
- **The gateway's manifest is the source of truth** (`packages/gateway/src/extensions/manifest.ts`).
  The SDK's `runContractTests` validates a DIFFERENT schema (`displayName`, `entrypoint`,
  `runtime`, `minNimbusVersion`, …) that no installable extension satisfies; unifying the two is a
  recorded follow-up, not this project.

## 3. Goals

1. `nimbus scaffold extension <name>` produces an extension that the gateway can install unchanged:
   a gateway-valid `nimbus.extension.json` and an MCP stdio entry that builds to the declared
   entry.
2. `nimbus extension publish <dir> --registry-repo <owner/repo>` prepares a publish pull request
   from a signed extension, without Nimbus ever holding a GitHub token.
3. A GitHub Action (one action, two modes) that registry repos use: **check** a publish PR, and
   **sign** the index after a merge.
4. `nimbus registry maintain init <dir> --github` writes the registry repo's workflow files, so
   "start your own registry" (public or company-internal) is one command plus a secret.
5. The `nimbus-agent/extensions` registry is ready to go live the moment the owner creates the
   repo and secret.

## 4. Non-goals

- Baked verified-publisher trust store, publisher key rotation, takedown/moderation ledger,
  provenance attestation — project 3.
- Dependencies and starter packs — project 4.
- `nimbus eval`, quality scores, ratings — projects 5–6.
- Unifying the SDK and gateway manifest schemas (follow-up; record it on the roadmap).
- A Nimbus-hosted upload server, or Nimbus storing/using a GitHub token.
- Registries on forges other than GitHub (the layout is forge-neutral; only the CI glue is
  GitHub-specific in this project).

## 5. Anti-goals

- **Anything becomes installable without passing the check job AND a human merge.**
- **The root key is readable by a workflow run triggered by a pull request** (including from a
  fork) — i.e. a PR author can get their bytes signed without a merge.
- **A publish PR changes `index.json` or another extension's files.**
- **The check job and the client disagree** on what is valid (two copies of the format/rules that
  can drift).
- A published version can be overwritten, or an id's publisher key silently changed.

## 6. Constraints

Non-negotiables apply (platform equality for the CLI parts; no `any`; no plaintext credentials).
Project 1's format is fixed: `index.json` (format 1, rootKey, increasing `sequence`, per-version
channel/name/canonical paths/SHA-256s/size/entryHash/publishedAt), canonical-JSON Ed25519 signature
via the SDK's deprecated NFC `canonicalize` (never `@nimbus-dev/sdk/signing`), strict SemVer
version keys, caps (package ≤ 50 MiB, unpacked ≤ 200 MiB / 5000 entries, manifest ≤ 64 KiB, index ≤
8 MiB), deterministic packing (sorted, mtime 0, mode 0644). I16 publisher signatures unchanged.
Existing GitHub Actions in this repo are node20 JS actions bundled with
`bun build --target=node` into a committed `dist/` (`packages/github-actions/*`).

## 7. Design

### 7.1 Scaffold (`nimbus scaffold extension <name>`)

Today it emits `package.json`, `src/server.ts` (McpServer on stdio with an `echo` tool), a test,
README, `.gitignore` — and no manifest. It gains a gateway-valid `nimbus.extension.json`:
`id` (from the name; a valid extension id), `version: "0.1.0"`, `name`, `entry` matching the
build output, `permissions: { network: [], filesystem: { read: [], write: [] } }` (least
privilege), `updateChannel: "stable"`. No `publisher`/`signature` (added by
`nimbus extension sign`). The README's "next steps" are: build → `nimbus extension keygen` →
`nimbus extension sign .` → `nimbus extension publish . --registry-repo nimbus-agent/extensions`.
A test proves the scaffolded tree, once built and signed, passes the gateway's own install
validation (`installExtensionFromLocalDirectory` on a temp copy, ungated) — the scaffold and the
installer cannot disagree.

### 7.2 `nimbus extension publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--no-pr]`

Offline-first, no gateway needed, no token:

1. Validate the extension locally exactly as the registry check will: manifest parse (gateway
   rules), `publisher` + `signature` present and the I16 signature verifies against the
   manifest's own key, entry exists and stays inside the tree, deterministic pack, caps. Refuse
   with the same messages the check job would print.
2. Obtain a working clone: `--clone <path>` (an existing local clone of the registry repo, must be
   clean) or else clone `https://github.com/<owner>/<repo>` into a temp dir with `git` (shallow).
3. Read the clone's `index.json` (structural read, signature verified against its own rootKey) and
   pre-check: `<id>@<version>` absent; if the id exists, its bound publisher key equals the
   manifest's.
4. On a new branch `publish/<id>/<version>`, write ONLY
   `extensions/<id>/<version>/manifest.json` (the signed manifest bytes, verbatim) and
   `extensions/<id>/<version>/package.tgz`, plus a `publish-request.json` next to them
   (`{ id, version, channel, publisherFingerprint }`; channel defaults to `stable`). Commit with a
   fixed message. Never touch `index.json`.
5. If `gh` is on PATH and authenticated (`gh auth status`), push to the author's fork
   (`gh repo fork --remote`) and `gh pr create` with a generated title/body. Otherwise (or
   `--no-pr`) print the branch, the clone path and the exact `git push` + `gh pr create` commands.
   Nimbus never reads, stores or passes a GitHub token; `gh` owns auth.

`git`/`gh` are spawned hidden (`platform/spawn-capture.ts`-style, `windowsHide`) with argv arrays,
never a shell string.

### 7.3 The registry action (`packages/github-actions/registry-action`, node20, bundled `dist/`)

One action, `mode: check | sign`.

**`check`** (runs on `pull_request`, no secrets, read-only token):
- The PR diff may add files only under `extensions/<id>/<version>/` for ONE new `<id>@<version>`
  (exactly `manifest.json`, `package.tgz`, `publish-request.json`); any other path changed —
  including `index.json`, workflows, or another extension's files — fails.
- Re-run every client-side check from 7.2 step 1 on the PR's files, against the BASE branch's
  signed `index.json` (verified with its own rootKey; the base is trusted, the head is not):
  version new, publisher key equal to the bound key for an existing id, caps, signature.
- Run the SDK sandbox probe `runSandboxContractTests` against the extracted package **if** it can
  actually confine on a GitHub Linux runner; if it cannot (no sandbox tooling), the job must say
  so explicitly in its summary rather than report a pass (see § 9 open point).
- Writes a job summary listing id, version, channel, publisher fingerprint, declared permissions
  (network hosts, read/write paths) so the reviewer sees what they are approving.

**`sign`** (runs on `push` to the default branch, in a protected GitHub **environment** that holds
`NIMBUS_REGISTRY_ROOT_KEY`, never on `pull_request` / `pull_request_target`):
- Re-validates every `extensions/<id>/<version>/` directory that is not yet in `index.json` with
  the same checks as `check` (defence in depth: the merge may have bypassed the PR check).
- Adds the new entries (name from the manifest, channel from `publish-request.json`, hashes,
  size, entryHash, `publishedAt` = the merge commit time), `sequence + 1`, re-signs, commits
  `index.json` back with `[skip ci]`-style loop protection, and leaves `publish-request.json`
  files deleted or ignored (builder's call — they must not affect the signed index).
- Refuses (job fails, nothing signed) if the root key's public half does not equal `index.json`'s
  `rootKey`.

**Single source of the rules:** the action must not carry a third copy of the format or the
validation rules. It bundles the existing gateway/CLI modules (`extensions/registry/index-format.ts`,
`extensions/manifest.ts`, the CLI's `lib/registry-index.ts` signer, `lib/registry-pack.ts`, and the
maintain command's package inspection) via relative imports at bundle time, like
`packages/github-actions/shared`. The golden-vector test from project 1 runs against the bundled
signer too.

### 7.4 `nimbus registry maintain init <dir> --github`

In addition to today's init, writes into `<dir>/.github/workflows/`:
- `registry-check.yml` — `on: pull_request`, `permissions: contents: read`, runs the action in
  `check` mode;
- `registry-sign.yml` — `on: push` to the default branch, `environment: registry-signing`,
  `permissions: contents: write`, concurrency group so two merges never sign concurrently, runs
  the action in `sign` mode;
- a `README.md` for the registry explaining how to publish to it and that the root key must be
  stored as the `NIMBUS_REGISTRY_ROOT_KEY` secret of the `registry-signing` environment with
  required reviewers or branch protection.
The action is referenced by a pinned tag (`nimbus-agent/registry-action@vX.Y.Z` mirrored from
this repo — exact distribution mechanism is the builder's call, matching how the two existing
actions are distributed). It prints the root key's public fingerprint and the secret value to set,
once, and keeps the key file 0600 as today.

### 7.5 The first registry

Everything the owner needs to create `nimbus-agent/extensions`: run
`nimbus registry maintain init <clone> --github`, push, create the `registry-signing` environment
with the secret, enable Pages, protect the default branch. A docs page lists these steps. The
owner performs them; nothing in this project pushes to that repo.

## 8. Testing and acceptance

- Unit: scaffold output validates with the gateway's installer; publish's local checks match the
  action's (same module, plus a parity test); PR-diff path rules (only one new version dir, no
  other paths); sign refuses a mismatched key; sign is idempotent (re-running with nothing new
  changes nothing); sequence increments by exactly one.
- Integration (real temp git repos, a local bare "remote"; no network): publish writes the right
  branch and files and never touches `index.json`; `--no-pr` prints commands; a fake `gh` on PATH
  receives the expected argv; check mode run against a crafted PR tree accepts a good publish and
  rejects: a changed `index.json`, a second version, a changed publisher key, a duplicate
  version, an unsigned manifest, an oversized package; sign mode over a merged tree produces an
  index that project 1's client verifies and installs from.
- Workflow files: `init --github` output is valid YAML with the exact triggers/permissions in 7.4
  (`pull_request` never has the secret; sign runs only on push to default branch in the
  environment) — asserted by test.
- **Acceptance:** in temp dirs, `scaffold` → build → `keygen` → `sign` → `publish --no-pr` into a
  local registry clone → run the action's `check` on that diff → "merge" → run `sign` →
  `nimbus registry add` the folder → `nimbus extension install` succeeds.

## 9. Left to the builder / open points

- Module layout of the action; how the action is mirrored/released (follow the two existing
  actions); exact CLI output.
- **Sandbox probe on CI (open, the builder check should weigh in):** `runSandboxContractTests`
  forks a probe for network/filesystem denial; on a stock `ubuntu-latest` runner it may have no
  confinement to test. Acceptable outcomes: run it under `bwrap` installed by the workflow, or
  report "not run: no sandbox on this runner" in the summary. It must never report a pass it did
  not earn.
- Whether `publish-request.json` files are deleted by `sign` or kept and ignored.

**Follow-ups to record (not in scope):** unify the SDK `runContractTests` manifest schema with the
gateway's; non-GitHub forges; a `nimbus extension publish` path for private registries hosted on
plain buckets.
