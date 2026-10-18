# Extension registry: protocol and client (Phase 9.5, project 1 of 7)

> Status: design, awaiting owner approval. Feature-branch document only: it never lands on `main`.
> Its durable content moves to `docs/architecture.md`, `docs/cli-reference.md`,
> `docs/SECURITY-INVARIANTS.md`, `docs/roadmap.md` and `docs/CHANGELOG.md` before the implementation
> PR, and this file is deleted on the branch.

## 1. Intent

The owner wants to ship ALL of Phase 9.5 (Marketplace Registry), which finishes S3. It splits into
seven projects in dependency order: (1) registry protocol + client, (2) publishing, (3) trust layer,
(4) dependencies + starter packs, (5) `nimbus eval` (Phase 9 Wave 5, a prerequisite of the quality
layer), (6) quality layer, (7) author onboarding. This document covers **project 1 only**.

Project 1 makes "a registry" a real, configured thing that Nimbus can search and install from, and
moves the existing auto-update daemon onto it. Everything later builds on this format.

**Why now, and why this shape.** Survey of `main` at `d91c63c2` found a half-built client:

- `extensions/registry-client.ts` defines an HTTP protocol (`GET /v1/extensions/{id}/latest`,
  `/v1/extensions/{id}/manifest?version=`, `/publishers/{id}.key`) used ONLY by the auto-update
  daemon, and only when the env var `NIMBUS_EXTENSIONS_REGISTRY_URL` is set (`platform/assemble.ts`
  ~2057). No registry exists to answer it.
- `extensionsPublisherKeyFetcher` (`ipc/server/options.ts:104`) is never set in production, so
  installing ANY signed extension throws "requires vault and publisher key fetcher"
  (`install-from-local.ts:109-113`) unless the key is already Vault-cached.
- A publisher key is trusted on first fetch from whatever URL answered (TOFU), then Vault-cached.
- No registry fetch (key, metadata, tarball) appends an egress-ledger row.
- Dependency install checks `entryHash` but not `tarballSha256`; the update orchestrator never ties
  the signed `manifestRaw` to the claimed `manifestHash`.
- The desktop Marketplace page lists installed extensions only; its "Install from directory"
  button can never succeed because `extension.install` is (correctly) off the Tauri allowlist.

## 2. Decisions the owner made

- **Ship all of Phase 9.5**, in the seven-project order above. Project 1 first.
- **A registry is a folder of signed static files.** No code runs on the registry side. The same
  tree works from a local directory, GitHub Pages, an S3/R2/GCS bucket, or an internal web server.
  Hosting is undecided and must not affect the design.
- **The first user is the owner, dogfooding**: build a registry folder on their own disk, add it,
  search and install from it on a clean gateway. (My call, corrected after review: a clean
  NON-demo gateway in the LOCALAPPDATA acceptance sandbox, not `--demo` — a demo gateway refuses
  `extension.install`/`approveRun`, never builds the runtime and never starts the update daemon,
  and widening I41 for this is not worth it.)
- **Several registries at once**, searched together.

## 3. Goals

1. A versioned, static registry layout with a root-key-signed `index.json`.
2. Offline maintainer commands that create a registry folder and add/remove extensions in it.
3. Client commands to add, list, refresh and remove named registries, each with a pinned root key.
4. `nimbus extension search` / `info <ref>` / `install <ref>` against the configured registries.
5. The auto-update daemon reads from the extension's own source registry, not an env var.
6. Signed installs work: the publisher key comes from the signed index, not a TOFU fetch.
7. Every remote registry fetch appends one egress-ledger row; air-gap refuses all of them.

## 4. Non-goals (later projects own these)

- Network publishing (`nimbus extension publish`, registry-side publish hook) — project 2.
- Baked verified-publisher trust store, publisher key rotation, moderation ledger, provenance — 3.
- Dependency resolution from a registry, starter packs — project 4.
- Quality scores, ratings, permission-transparency scoring, `extension audit` — projects 5–6.
- Registry search/install in the desktop app. No new method joins the Tauri allowlist.
- Org-policy control over WHICH registries may be added (noted as a follow-up in § 12).
- Index sharding / pagination. One `index.json` is fine for hundreds of extensions.

## 5. Anti-goals (would make this a failure even if it works)

- **Any path that installs or updates code whose bytes were not covered by the pinned root key's
  signature** (index → hashes → tarball) AND the publisher's I16 signature.
- **Dependency confusion**: an id present in two registries being resolved by priority, or an
  update arriving from a registry other than the one the extension was installed from.
- **Silent re-trust**: a registry's root key changing and the client accepting the new one.
- **An unledgered outbound request** (I29's spirit), or a registry fetch under `enforce_air_gap`.
- **Ambiguity between a local path and a registry reference** that installs something the owner
  did not mean.
- A protocol that needs a server to run code (it would kill the static-hosting promise).

## 6. Constraints

Non-negotiables 1–7 apply; specifically: platform equality (all paths via `path.join`, tests on
all three OSes), no `any`, Vault-only secrets. Invariants that bind this work:

- **I16** — publisher Ed25519 verify at install + every startup + pre-spawn; unchanged and still
  required. Canonical bytes stay `extensions/canonical-json.ts`.
- **I2 / I4** — `extension.install` stays an executor-gated HITL action. Adding a registry is
  trust-expanding and gets its own HITL action type (my call, § 8.4).
- **I5** — `checkLanMethodAllowed` is a DENYLIST: a new `registry.*` namespace is LAN-reachable
  unless explicitly denied. Every new method must be LAN-forbidden.
- **I7** — nothing new on the Tauri allowlist.
- **I29** — new outbound requests must be ledgered, fail-closed (§ 8.7).
- **I22** — enforcement reads `EnforcedPolicy`, never raw policy TOML.
- **I43** — run grants are untouched: a registry install still needs `nimbus extension approve`
  before the code runs.
- **I41** — a demo-rooted gateway must remain unable to reach the real install; registry fetches
  are outbound and need an explicit demo decision (§ 8.11).
- Schema is forward-only; the next free migration number (V71 at time of writing — re-check).

## 7. Registry format

### 7.1 Layout

```
<registry-root>/
  index.json                                    signed envelope (§ 7.2)
  extensions/<id>/<version>/manifest.json       the publisher-signed nimbus.extension.json, verbatim
  extensions/<id>/<version>/package.tgz         the extension package
```

All references inside `index.json` are paths RELATIVE to the registry root, so a folder can be
copied to any host unchanged. `<id>` goes through the existing `assertSafeExtensionId` and `<version>` through a
strict semver check before either is joined into a path or URL (path-traversal guard). Ids may
contain `/` (existing namespaced ids are nested directories); the layout nests the same way.

### 7.2 `index.json`

```jsonc
{
  "format": 1,
  "rootKey": "<base64 Ed25519 pubkey, 44 chars>",
  "sequence": 42,                       // strictly increasing per re-sign
  "generatedAt": "2026-10-18T12:00:00Z",
  "extensions": {
    "<id>": {
      "publisher": { "id": "<publisher-id>", "key": "<base64 pubkey>" },
      "versions": {
        "<version>": {
          "channel": "stable",          // "stable" | "beta"
          "name": "Acme Deploy",        // copied from the manifest by `maintain add`, for search
          "manifest": "extensions/<id>/<version>/manifest.json",
          "manifestSha256": "<64 hex>",
          "package": "extensions/<id>/<version>/package.tgz",
          "packageSha256": "<64 hex>",
          "packageSizeBytes": 12345,
          "entryHash": "<64 hex>",
          "publishedAt": "2026-10-18T12:00:00Z"
        }
      }
    }
  },
  "signature": "<base64 Ed25519 signature, 88 chars>"
}
```

- **Signed bytes:** canonical JSON (`extensions/canonical-json.ts`) of the object with the
  top-level `signature` removed — the same rule I16 uses for manifests, so one canonicaliser.
- **One publisher key per extension id** in a given registry. Changing it is key rotation and is
  refused by the maintainer commands until project 3 defines rotation.
- **Unsigned extensions are not listable.** A registry entry must carry a publisher; the
  maintainer refuses a package whose manifest has no `publisher`/`signature`.
- **Freshness (my call):** no hard expiry, because an air-gapped mirror would break. `sequence`
  gives rollback protection (§ 8.2); a stale `generatedAt` is reported by `nimbus doctor` and
  `registry list`, not refused. Freeze attacks are therefore a stated bound, not prevented.
- **Size caps (my call):** `index.json` ≤ 8 MiB, `manifest.json` ≤ 64 KiB, package ≤ 50 MB
  compressed (the existing auto-update cap). Exceeding a cap refuses before parsing. Extraction
  separately caps the UNCOMPRESSED total and the file count (§ 8.10), so a small gzip bomb cannot
  fill the disk.
- **Package layout:** files at the archive root (`./nimbus.extension.json`), no symlinks, no
  special files, entries in sorted order with normalised mtimes/modes so the same tree packs to
  the same bytes (cheap now; project 3's provenance work wants it). `maintain add` produces exactly
  this; the client's extractor still accepts the existing single-top-level-folder form.
- **Removing the last version of an id removes the id's whole entry**, publisher binding included.
  Tombstones that keep a binding reserved belong to project 3's takedown work.

### 7.3 Transports

- `https://` — the normal case.
- `http://` — only to a loopback host, and only outside production builds (copy
  `updater/manifest-fetcher.ts`'s rule). Needed for tests.
- `file://` or a plain absolute directory path — a local registry. Makes no network request and
  therefore appends no egress row and is allowed under air-gap (my call). **A UNC path
  (`\\host\share`, `//host/share`, `\\?\UNC\...`) or a `file://` URL whose host is anything but
  empty or `localhost` is REFUSED**: on Windows those open an SMB/WebDAV connection, i.e. real
  outbound traffic with no ledger row and under air-gap. `file://` URLs are resolved with
  `node:url`'s `fileURLToPath`.

The old `/v1/...` endpoints and `/publishers/{id}.key` are removed, not kept beside the new layout.
`NIMBUS_EXTENSIONS_REGISTRY_URL` is removed. Not a breaking change: no registry has ever existed to
point it at.

## 8. Client behaviour

### 8.1 Registry records

New table (V71 tentatively) `extension_registry`:
`name` (PK, `[a-z0-9][a-z0-9-]*`, ≤ 32), `url`, `root_key`, `root_fingerprint`, `last_sequence`,
`last_generated_at`, `added_at`, `last_fetched_at`.

Stored in the DB, not `nimbus.toml` (my call): the gateway writes it only after fetching the index
and obtaining the owner's consent, and the same pattern already holds user MCP registrations
(`user_mcp_connector`). The `extension` row gains `source_registry`, `source_root_fingerprint` and
`source_channel` (`stable`|`beta`, recorded at install from `--channel`, default `stable`); all
three NULL for a local-path install. A `beta` extension is offered the newest version across
`stable ∪ beta`; a `stable` one only `stable`. The manifest's `updateChannel` stops deciding what
the daemon polls.

**Fingerprint format:** root fingerprints use the existing `publisherKeyFingerprint`
(`install-from-local.ts`, first 32 hex chars of SHA-256 over the 32 raw key bytes), so root and
publisher fingerprints look the same everywhere.

### 8.2 Fetch-and-verify (one function every caller uses)

1. Transport check (§ 7.3), air-gap check, egress append (§ 8.7) — in that order, before any byte
   leaves.
2. Size cap, parse, schema-validate.
3. `rootKey` in the document must equal the pinned key; verify `signature` over canonical bytes.
   Mismatch → `ERR_REGISTRY_ROOT_KEY_CHANGED` / `ERR_REGISTRY_SIGNATURE_INVALID`. Never re-pins.
4. `sequence` must be ≥ `last_sequence` (equal allowed: same index re-served). Lower →
   `ERR_REGISTRY_ROLLBACK`. On success, store the new sequence and `generatedAt`.

### 8.3 Managing registries — `nimbus registry add|list|refresh|remove`

- `add <name> <url> [--fingerprint <fp>]`, in this order: validate `name`; refuse a name or URL
  already present; fetch the index (one egress row, `destination` = the candidate name — it records
  a fetch that really happened even if the owner then declines); verify the index against its OWN
  `rootKey`; if `--fingerprint` was given, refuse unless it matches; prompt the `registry.add`
  HITL gate with `{ name, url, rootFingerprint, extensionCount, generatedAt }`; on approval insert
  the row with that key pinned. `--fingerprint` is a pin check (you got the fingerprint out of
  band and want a mismatch to refuse before you are even asked), not a way to skip the prompt.
- `list`: name, URL, fingerprint, extension count, last fetched, staleness.
- `refresh [<name>]`: re-runs fetch-and-verify.
- `remove <name>`: deletes the record. Installed extensions from it stay installed and keep
  running; they get no further updates and `nimbus doctor` names them.

### 8.4 Consent for adding a registry (my call — flag for review)

Adding a registry widens what may later be offered for install, so it is a new HITL action type
`registry.add` in the I2 frozen set, prompted at the executor with the name, URL and fingerprint.
The CLI additionally requires a TTY exactly like `extension approve`: no `--yes`, and the prompt
handler is registered directly so `NIMBUS_SCRIPT_CONSENT_SOURCE` cannot answer it. Automated tests
answer the consent request over the raw socket at the gateway level, as the existing approve tests
do; the § 11 dogfood run is done by a person. `remove`, `list` and `refresh` need no consent.

- The gate that prompts `registry.add` is wired with `NULL_EGRESS_SINK`, like
  `buildExtensionGateExecutor`, so approving it appends no spurious `task`-class row next to the
  real `registry` row.
- **Never delegable (I20):** `tryDelegatedApproval` refuses `registry.add` and every `extension.*`
  action type alongside `isUserMcpActionType`, so a federated peer holding a delegation can never
  approve a trust root or local code. Today only the gate's `delegation: undefined` stops it; this
  makes it structural.
- **Prompt field names never contain `key`/`auth`:** the executor's `SENSITIVE_PAYLOAD_KEY`
  redacts any such field to `[REDACTED]` in the prompt. Use `rootFingerprint`,
  `sourceRootFingerprint`, `publisherFingerprint` in the `registry.add`, `extension.install` and
  `extension.autoUpdate` payloads, never `rootKey`/`publisherKey`.

### 8.5 References and search

- **A registry reference is an extension id plus flags, never a syntax** (my call, after review:
  ids may legally contain `/` and `@`, so `<registry>/<id>@<version>` cannot be parsed
  unambiguously): `--registry <name>` qualifies, `--version <v>` pins, `--channel beta` widens.
- `nimbus extension install <arg>`: if `<arg>` resolves to an EXISTING path, it is a local install
  exactly as today, and `--registry`/`--version` are refused with it; otherwise `<arg>` is an
  extension id looked up in the registries. The command always prints which it chose ("from
  registry internal, publisher acme, key …").
- An id that exists in more than one registry, with no `--registry` → `ERR_REGISTRY_AMBIGUOUS`,
  naming each registry. Never resolved by priority.
- Version: the newest version on the `stable` channel unless `--version` or `--channel beta`. The
  signed index's `channel` is authoritative; the manifest's `updateChannel` is ignored for
  registry purposes.
- `nimbus extension search <query>`: case-insensitive substring over id, name and publisher id,
  across all registries, results tagged with their registry. Reads each registry's freshly
  verified index (one fetch per registry per command; no persistent catalogue cache in project 1).
- `nimbus extension info <id> --registry <name>` (or `--remote` to search all): for a registry entry, shows versions, channels, publisher id,
  publisher-key fingerprint, declared permissions (from the manifest) and sizes. Plain `info <id>` of an
  installed id is unchanged.

### 8.6 Install from a registry

1. Resolve the reference (§ 8.5) against freshly verified indexes.
2. Fetch `manifest.json` and `package.tgz` (each an egress row); check size and the index's
   `manifestSha256` / `packageSha256` BEFORE use.
3. The manifest's `publisher.id`/`publisher.key` must equal the index entry's; verify its I16
   signature with that key.
4. If the Vault already caches a DIFFERENT key for that publisher id →
   `ERR_REGISTRY_PUBLISHER_KEY_CONFLICT` (my call; project 3 replaces this with rotation).
5. Hand the package to the existing `installExtensionFromLocalDirectory` with the publisher key
   passed explicitly. Its `extension.install` HITL prompt now also shows registry name and root
   fingerprint. Its existing entry-hash and tree-digest checks run unchanged; `entryHash` must
   also equal the index's.
6. Record `source_registry` and `source_root_fingerprint`. Running still requires
   `nimbus extension approve` (I43, unchanged).
7. An id that is already installed is refused, as today (`installRootNode` refuses an existing
   directory); the message points at `nimbus extension update` or remove-then-install. No in-place
   version switching through `install`.
8. A manifest with a non-empty `dependsOn` installs only when every dependency is ALREADY
   installed and satisfies it; nothing is fetched transitively (project 4). The existing
   `registryClient` dependency path is not wired.

### 8.7 Egress

A new I29 coverage class `registry`, `per-call`: one row per remote request (index, manifest,
package), appended before the request, fail-closed. `destination` is the registry NAME (never the
raw URL); `method` is `registry.index` / `registry.manifest` / `registry.package`;
`payload_summary` carries the extension id and version only. `THIS_BINARY_COVERAGE.registry` is
raised in the same commit as the appender's production caller. A static rule in the D22 family
confines the registry fetch primitive to the registry client module (my call on exact shape).
Local (`file://`/path) registries append nothing.

Mechanics the builder must get right: `registry` is INSERTED in sort order in `COVERAGE_CLASSES`
(between `peer` and `session` — the array order is the boot marker's hashed wire format), and
added to `EGRESS_SOURCE_TYPES`, `ALL_NONE_COVERAGE` and the CLI's hand-maintained
`COVERAGE_CLASS_LABELS` in `prove.ts`. Adding a class makes markers written by older binaries
unparseable, so `nimbus prove` reports a window spanning the upgrade as `indeterminate`: the
documented fail-safe, stated in the CHANGELOG.

### 8.8 Auto-update daemon

- Constructed at boot whenever boot policy allows auto-update and
  `NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE` is not `1` (replacing the env-var check); each tick reads
  the CURRENT registry table, so a registry added at runtime is picked up on the next tick with no
  restart, and no registries means a tick that does nothing. (My call, after review.)
- **One index fetch per registry per tick:** a tick groups enabled registry-sourced extensions by
  `source_registry`, fetches and verifies each registry's `index.json` once (one egress row), and
  fetches a `manifest.json` only for an extension whose index shows a newer version.
- Checks each enabled extension with a `source_registry` against THAT registry only, and only
  while the registry's current root fingerprint equals `source_root_fingerprint`. A local-path
  install is never auto-updated. The same id in another registry is ignored.
- **Detect, then the owner applies (owner decision).** The daemon only detects and lists an
  available update, as today. Applying stays an owner action through the existing
  `extension.autoUpdate` HITL prompt, which now also shows the source registry name and root
  fingerprint. An applied update changes the tree digest, so the I43 run grant no longer matches
  and the extension does not run until the owner re-approves it with `nimbus extension approve`.
  This is intended: every run approval covers code the owner was shown. No grant carry-over.
- Apply verifies exactly as § 8.6 steps 2–5 (this also closes the `manifestRaw` ↔ `manifestHash`
  gap, since the manifest is now matched to the signed index hash). **One air-gap switch:** `[llm] enforce_air_gap` (the
  only existing key, already gateway-wide) is read by the update runtime AND set on
  `CreateIpcServerOptions.extensionsEnforceAirGap`, which `assemble.ts` never sets today, so install,
  search, `info --remote`, `registry add|refresh` and the daemon all obey the same switch.

### 8.9 Fixes folded in

- Local install of a signed extension with no `--publisher-key` and no Vault-cached key fails with
  a clear message naming `--publisher-key`, instead of "requires vault and publisher key fetcher".
  The unwired `extensionsPublisherKeyFetcher` option and `/publishers/{id}.key` path are deleted.
- **`nimbus extension sync` / `extension.sync` / `extensions/sync.ts` are removed**, with the
  `needs_sync` status and its hint in `auto-update-rpc.ts`/`auto-update.ts`. All existed only to
  call the never-wired `PublisherKeyFetcher`, so the command could not succeed in production. A
  registry-sourced update now gets its publisher key from the signed index; a Vault key that
  differs yields `ERR_REGISTRY_PUBLISHER_KEY_CONFLICT`. Not breaking: nothing that worked stops.
- `docs/architecture.md`'s sample manifest (§ Subsystem 4) is corrected to match `manifest.ts`.
- `docs/SECURITY-INVARIANTS.md`'s claim that the update orchestrator re-verifies signatures is
  corrected or made true (it becomes true via § 8.8).

### 8.10 Existing update-path bugs this project must fix first

Review found that the apply path the § 11 scenario depends on has never worked against a real
install. These are existing defects, not new design, and the plan should land them as their own
first PR before the registry work (my call on ordering):

1. **Layout mismatch (`ENOENT` on every update).** Install writes files flat at
   `<extensionsDir>/<id>` and records that as `install_path`; `applyUpgradeSwap`/`applyDowngradeSwap`
   rename `<extensionsDir>/<id>/active`, which never exists; three `_prev` lookups use
   `dirname(install_path)/_prev`, which disagrees with where the swap puts it. **Fix: keep the flat
   `install_path`** (no migration of installed extensions, and nested namespaced ids stay simple)
   and move `_prev/<id>/<version>`, the holding buffer and `_pending` into one versions area OUTSIDE
   every extension's install tree and outside what the orphan sweep walks; update
   `applyUpgradeSwap`, `applyDowngradeSwap`, `hasPrevVersion`, `resolveExtensionInfoExtras` and
   `tryPromotePrevVersion` together. No installed extension can be in the old `active/` shape, since
   no update ever succeeded.
2. **The startup orphan sweep deletes namespaced extensions.** `sweepOrphanActiveDirsBestEffort`
   matches each top-level directory name against `extension.id`; for `acme/foo` the directory is
   `acme`, matches nothing, and is `rmSync`'d at every boot. **Fix:** treat a top-level directory as
   live when it is any installed id's first path segment, and skip the versions area. Data loss
   today for anyone with a namespaced id, so it goes first.
3. **`_pending` with a namespaced id** joins `<id>-<version>` under `_pending` but only creates
   `_pending` itself. **Fix:** a slugged directory name (same slug as the versions area).
4. **One extraction pipeline.** Install uses system `tar` plus `assertNoEntryEscapes` and
   `findExtensionSourceRootInTree`; update uses the npm `tar` package with neither, and a symlink in
   an update silently leaves `tree_digest = NULL` after the swap. **Fix:** both use the install
   pipeline; escape checks, the uncompressed-size and file-count caps, and
   `computeExtensionTreeDigest` all run on the extracted tree BEFORE anything is swapped in, and a
   failure refuses the update with the old version untouched.
5. **`nimbus extension update`/`downgrade` hang.** The CLI never registers a consent handler and
   keeps the 30 s timeout, so the gateway's `extension.autoUpdate` prompt is never shown and the
   call times out. **Fix:** register the prompt handler and use `INTERACTIVE_RPC_TIMEOUT_MS`, as
   `install` does.

### 8.11 Demo-rooted gateways (my call)

Every new `registry.*` method and `extension.search`/registry `info` is refused on a demo-rooted
gateway with `ERR_DEMO_FORBIDDEN`, added to I41's `dispatchMethod` gate. `extension.install` is
already refused there. I41 is otherwise untouched.

## 9. Maintainer commands (offline, no gateway)

Pure CLI, like today's `nimbus extension keygen` / `sign`, operating on a folder:

- `nimbus registry maintain init <dir> [--key <path>]` — creates the layout, writes a root
  private key file (mode 0600, refuses to overwrite without `--force`, default
  `~/.nimbus/registry-key`), writes an empty signed index with `sequence: 1`, prints the
  fingerprint.
- `nimbus registry maintain add <dir> <package.tgz | extension-dir> [--channel stable|beta]
  [--key <path>]` — given a directory, packs it into `package.tgz` first (no separate
  `extension pack` command exists); validates the package (manifest parse, I16 signature, entry hash), refuses an existing
  `<id>@<version>` and a changed publisher key, copies files in, re-signs with `sequence + 1`.
- `nimbus registry maintain remove <dir> <id>[@<version>] [--key <path>]` — removes the entry from
  the index and re-signs. Files may stay (content-addressed takedown semantics come in project 3).

Every `maintain` command writes `index.json` through a temp file in `<dir>` plus an atomic
rename, so a gateway reading a local registry or a sync job copying it never sees half an index.

The root key lives in a file, not the Vault, matching how publisher keys work today and because
registry maintenance happens on a machine that may not run a gateway.

## 10. Surfaces summary

- **CLI:** `registry add|list|refresh|remove`, `registry maintain init|add|remove`,
  `extension search`, `extension info <ref>`, `extension install <ref>` (extended).
- **IPC:** `registry.add`, `registry.list`, `registry.refresh`, `registry.remove`,
  `extension.search`, `extension.registryInfo` (exact names: builder's call). All CLI-only,
  LAN-forbidden, not on the Tauri allowlist. Each needs BOTH the inner handler and the outer
  dispatcher routing entry, proven by an E2E over a real socket.
- **Schema:** one migration (registry table + three `extension` columns).
- **Security docs:** a new invariant is likely warranted (my call — "registry-sourced code is
  installed or updated only through the fetch-and-verify chain, from its source registry"),
  with wiring + docs + test in one commit per the triple rule.

## 11. Testing and acceptance

- Unit: index canonicalisation/signing round trip, schema validation, every refusal code in § 8,
  path-vs-id resolution (including Windows drive-letter, UNC and `file://` host refusals).
- Integration (real SQLite, temp dirs, real files): a registry folder built by the maintainer
  commands, served both as a local path and over a loopback `Bun.serve`; tampering tests for each
  hash, the signature, the root key and the sequence; ambiguity across two registries; an update
  offered by a non-source registry is ignored.
- E2E: real gateway subprocess, real socket, every new IPC method routed.
- Egress: exactly one row per remote request; append failure aborts; local registry appends none.
- All three OSes per Non-negotiable 5.

**Acceptance (the dogfood scenario):** on a clean non-demo gateway in the LOCALAPPDATA sandbox, the owner runs
`registry maintain init`, signs and adds an example extension, `registry add`s the folder,
`extension search` finds it, `extension install` installs it (two prompts: registry add, install),
`extension approve` lets it run, a new version added to the folder is detected by the update
daemon and listed, applying it prompts and succeeds, the extension then refuses to run until
re-approved, and tampering with any byte in the folder makes install or update refuse.

## 12. Left to the builder

- Module layout under `packages/gateway/src/extensions/` (a `registry/` subfolder is fine), exact
  IPC method names, error-code spellings, CLI output formatting, PR split.
- Whether search reads indexes concurrently.
- Exact shape of the D22-family static rule.

**Deferred from review:** a `description` field in the index (project 6's catalogue needs it;
search over id/name/publisher is enough now); tombstones that reserve a removed id's publisher
binding (project 3).

**Follow-ups noted, not in scope:** org-policy allowlist of registry fingerprints (I22); the
desktop Marketplace "Install from directory" button that can never work (remove it or route it
differently); an opt-in catalogue cache for offline search.
