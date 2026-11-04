# Author onboarding (Phase 9.5 project 7): design

**Status:** draft, 2026-11-04. Branch `dev/asaf/author-onboarding-spec`; this file never lands on `main`.
**Closes:** Phase 9.5, and with it Spine S3, once every PR in § 10 has merged.

## 1. Intent

Nimbus can now run, check and publish third-party extensions. What it lacks is the first hour of an
author's experience: starting an extension from an API they already have a description of, starting
from somebody else's published extension, being paid for the work, and finding all of this in one
place. Project 7 adds those four things and nothing that changes what code may run.

## 2. Goals, non-goals, anti-goals

**Goals**
- `nimbus scaffold extension <name> --from-openapi <path|url>` writes a working, installable extension
  with one MCP tool per OpenAPI operation, its network hosts declared, and tests that run offline.
- `nimbus extension clone <id>` puts an editable copy of a published registry package in a folder,
  stripped of the original publisher's identity, ready to install unsigned or to sign with the
  author's own key.
- An optional `funding` list in the manifest, shown by `nimbus extension info` and opened by
  `nimbus extension sponsor <id>`.
- An **Authors** section on the docs site that walks an author from scaffold to publish.

**Non-goals**
- The grant program: a budget decision, the owner's (as registry hosting is).
- The Sponsor button on the registry page and desktop tile: it moves with the open row
  **Marketplace page and desktop tile**.
- A first-party connector scaffold (`nimbus connector init`) and a gateway sync handler: extensions do
  not index.
- AsyncAPI. It describes message channels, which do not map onto request/response MCP tools.

**Anti-goals** (a version of this that works and is still a failure)
- Any new way for code to run without the owner's `extension approve` (I43), or a signature check
  skipped for "development" (I16).
- A clone that still claims to be the original: the original publisher's key or signature left on
  code the author has changed.
- A scaffold that hides egress: a generated tool calling a host its manifest does not declare.
- A `funding` link that opens without the owner seeing where it goes.

## 3. Owner rulings (2026-11-04)

- **R1 Scope:** the four buildable rows; the grant program stays the owner's.
- **R2 Clone trust:** the author re-signs with their own key; there is no unsigned development mode.
  The roadmap row's "signature verification is bypassed for local dev only" and its acceptance
  wording "spawns … without a signature error" are rewritten (§ 8).
- **R3 Scaffold target:** an extension, not a first-party connector.
- **R4 Author Hub:** an `/authors/` section of `packages/docs`.
- **R5 Clone publisher key:** verify the signature, do not trust the key (§ 5).
- **R6 License:** an optional SPDX `license` field; clone warns and never refuses (§ 5).

**A fact that shapes R2.** A local-path install of a manifest with no `publisher` is already allowed
and records the extension as unsigned (`verifyAndRecordSignature` returns null; I16 is a no-op for
it), and running it still needs a run grant (I43). So a clone with the original `publisher` and
`signature` removed installs through the existing door, unsigned and labelled `(unsigned)`, and the
author can sign it with `nimbus extension keygen` + `sign`. Clone adds no trust path.

## 4. The OpenAPI scaffold

**Command.** `--from-openapi <path|url>` is a new flag on the existing `nimbus scaffold extension
<name> [--publisher <id>]` (my call: the scaffold command exists; a parallel `extension init` would be
a second way to do one thing). It is offline except for the optional URL fetch, and needs no gateway.

**Input.**
- OpenAPI 3.0.x and 3.1.x, as JSON or YAML (the `yaml` package, already a CLI dependency). Swagger 2.0
  is refused with a message naming a converter; so is a document with no `openapi` field.
- A `url` is fetched by the CLI: `https:` only, at most 5 redirects each staying `https:`, at most
  10 MiB, a 30 s timeout. It is the author's own command fetching a document they named, the same
  class as `extension publish` running `git` (outside the gateway, so not in the egress ledger; the
  docs say so). No air-gap setting is consulted (my call): the only one, `[llm] enforce_air_gap`,
  governs model calls, and the CLI reads no gateway config for an offline command; the docs say a
  path works anywhere.
- Only local `$ref`s (`#/...`) are resolved; an external `$ref` is refused, naming the pointer. Cycles
  are cut at depth 8 with `{}` and a warning.

**Output** (in addition to what `scaffold extension` already writes):
- `nimbus.extension.json`: `permissions.network` = the distinct hosts of `servers[].url` (and of
  operation-level `servers`), `host` or `host:port`, after server-variable defaults are substituted. A
  server that is not `https:`, has no host, or whose host fails the manifest's hostname rule is skipped
  with a warning; if none remain the scaffold refuses (there is nothing to call). `credentials` gets
  entries for the security schemes it supports (my calls): `apiKey` in a header or query and `http`
  bearer get one entry each; `http` basic gets two (`<scheme>_user`, `<scheme>_password`). Names are the
  scheme name normalised to `[a-z][a-z0-9_]`, cut to fit the 32-character credential-name rule with a
  `_2` suffix on a collision. Each operation uses the first supported alternative of its own `security`
  requirement (else the document's top-level one); an operation with none sends no credential. Other
  schemes (OAuth 2 flows, OpenID Connect, cookie keys) are listed in the README as left to the author.
- `src/operations.ts`: the generated table, one entry per operation: tool name, HTTP method, path
  template, server, parameter locations, and the input JSON Schema.
- `src/tools.ts`: one MCP tool per operation, all served by one generic request function that builds
  the URL from the table, sends only to the table's server, applies the declared credential from the
  environment the runtime injects, and returns the response body as text (truncated at 64 KiB with a
  marker).
- `src/tools.test.ts`: offline tests with an injected `fetch`: every tool's request goes to a declared
  host, path parameters are encoded, a missing required parameter is refused before any request.
- `README.md`: the operations generated, the skipped ones and why, the credential to set, and the next
  steps (build, `extension install`, `extension approve`, `eval --package`).

**Mapping rules.**
- Tool name: `operationId` normalised to `[a-z0-9_]`; otherwise `<method>_<path segments>`. Collisions
  get `_2`, `_3`. The length cap is `64 - len("ext_<slug>__")` for the extension's own service slug,
  because `userMcpModelToolName` silently drops a longer name from `approve --model`
  (`user-mcp-agent-tools.ts`); a name cut to fit is listed in the scaffold's output.
- Input schema: an object whose properties are the path, query and header parameters (names
  prefixed only on a clash between locations) plus `body` for a JSON request body. Non-JSON bodies
  (form, multipart) generate the tool with a README note, and the request function refuses them.
- Description: `summary`, else `description`, cut at 512 characters. It is author-editable text; the
  runtime already treats server-supplied descriptions as untrusted (I11).
- Every non-`GET`/`HEAD` operation is generated like any other. The README says each call of every
  `ext_*` tool already asks the owner (I42).
- A spec with more than 200 operations is refused unless `--max-operations <n>` raises the cap, so a
  vendor's whole API does not silently become 1,000 tools.

**Eval stub.** `evals/smoke.eval.json` is not generated: an eval runs with no network (I49), and a
generated HTTP tool cannot answer offline. The README points at `nimbus eval --record`.

## 5. `nimbus extension clone`

**Command.** `nimbus extension clone <id> [--registry <name>] [--version <v>] [--into <dir>]
[--publisher <id>] [--json]`. `<name>` is the last `/`-segment of the id (my call). `--into` defaults
to `./<name>`; an existing non-empty directory is refused.

**Fetch.** Through the gateway, so the bytes arrive only through the verified chain (I44: pinned root,
sequence, index hashes, the I16 signature, I48 blocks) and every request is ledgered and air-gap
checked. A new IPC method `extension.cloneSource` reuses the steps of `fetchVerifiedRegistryPackage`
without its "already installed" refusal (cloning an installed extension is a normal case). It returns
the hash-checked archive, and the CLI unpacks it with `registry-format` `inspectPackage` (File and
Directory entries only, size and count caps). The gateway stages in a temp directory as install does
and removes it before replying. It runs no prompt and writes no extension row and no Vault entry; the
two writes the shared fetch already makes stay, and are documented: the registry's anti-rollback
sequence advances, and the egress ledger gets its rows. It is refused over LAN and absent from the
Tauri allowlist (my call: it is author tooling).

**Publisher key (owner ruling R5, 2026-11-04): verify, don't trust.** Clone verifies the I16 signature
against the key the signed index names, with the hashes and the I48 blocks, but does not run
`publisherKeyDecision` and stores no key: nothing is trusted for running, and the copy carries no
publisher. It prints the key's fingerprint and the verified-publisher badge text (or `Unverified
publisher`), and writes both to `CLONED_FROM.md`.

**What the copy is.**
- `nimbus.extension.json` with `signature` removed and `publisher` removed. With `--publisher <id>`,
  `id` becomes `<id>/<name>` and `publisher` becomes `{ "id": "<id>" }`, ready for `sign`, which fills
  in the key. That shape does not parse until it is signed (the manifest needs `publisher.key` and a
  `signature` together), the same as `scaffold extension --publisher` writes today, so clone prints the
  `keygen` and `sign` commands and the README says to sign before installing. Without `--publisher`,
  `id` is kept and the copy installs unsigned; the README warns that installing it beside the original
  is refused (same id) and that publishing it needs a new id.
- `CLONED_FROM.md`: the original id, version, registry, publisher id and key fingerprint, the date,
  and `repository` when the manifest names one.
- Everything else as published: the manifest, `dist/`, `evals/`, README, LICENSE.

**What it is not.** A published package carries built code (`dist/`), not source. When the manifest
names a `repository`, clone prints it as the place to fork the source; otherwise it says the copy is
built JavaScript. This is stated in the command's help and the Hub.

**License (owner ruling R6, 2026-11-04): add the field, warn only.** A new optional top-level
`license`, an SPDX license expression of at most 128 characters, read raw like `funding` (ignored at
runtime when malformed; refused by `extension sign`, `publish` and the registry action, in the funding
PR). `extension info` shows it. Clone always proceeds; it names the license, and when it is missing or
not made only of OSI-approved SPDX ids (a list baked into `registry-format`, my call) it warns that the
author must have the right to modify and redistribute the code. The roadmap's "published under an
open-source license" becomes this warning.

## 6. Funding and `nimbus extension sponsor`

**Format.** An optional top-level `funding` array of `{ "url": string, "label"?: string }`, at most 8
entries. `url` is `https:` with a host; `label` is at most 64 characters with no control or bidi
characters. Older gateways ignore an unknown top-level key, and the signature covers the raw manifest,
so `funding` is signed with everything else.
- Read raw like `repository` (`provenance.ts`): at runtime a malformed `funding` is ignored and shown
  as `funding: (invalid, ignored)`. `extension sign` and `extension publish` refuse it (the author's
  tools), and so does the registry action's `validate-publish.ts`, unlike `repository`, which publish
  ignores (my call: a link the owner may open should be well-formed at the source). The funding PR
  rebuilds the action's `dist`. A registry still on an older action can sign a malformed `funding`, which
  every gateway then ignores; the docs say so rather than claiming no registry ever signs one.
- `info --registry` and `sponsor --registry` read the manifest of the version an install would take (the
  newest stable, or the channel the owner chose), checked against the root-signed index by hash, the same
  trust `registry.info` gives every other manifest field today (my call).
- No host allowlist (my call): GitHub Sponsors, Patreon, Buy Me a Coffee, Ko-fi, Open Collective and
  Stripe links all change; the confirmation shows the host instead.

**Surfaces.** `nimbus extension info <id>` (local and `--registry`/`--remote`) and `--json` show the
entries. `nimbus extension sponsor <id> [--registry <name>] [--index <n>]` prints every entry, and on a
TTY asks before opening the chosen one (default the first) with `openHttpsUrl`, the
`extension report` precedent: the URL is always printed, the host is named in the question, off a TTY
nothing opens. The desktop shows the entries as text in the extension details; the button waits for
the marketplace tile row.

## 7. The Authors section

A sidebar group **Authors** in `packages/docs/astro.config.mjs`, pages under
`src/content/docs/authors/`:
1. Overview: what an extension is, what the sandbox and approvals do (I42/I43), the path below.
2. Start: `scaffold extension`, `--from-openapi`, `extension clone`.
3. Build and test locally: build, `extension install <path>`, `approve`, `tools`/`call`.
4. Evals: the `evals/*.eval.json` format, `eval --package`, `eval --record`.
5. Sign and publish: `keygen`, `sign`, `pack`, `publish`, key rotation, the official registry.
6. Funding: the `funding` field and `sponsor`.
7. Verified publishers: what the badge means, and how to ask (the trust-feed process as documented).

Content is ported from `docs/contributors/extension-author-walkthrough.md`, `docs/registry-hosting.md`
and `docs/cli-reference.md`, which stay the reference; the walkthrough gains a link to the section. The
grant program is not mentioned. External links are checked by lychee as today.

## 8. Roadmap and docs

- The four rows are ticked in the PR that ships each, with their wording rewritten to what shipped:
  `nimbus connector init` → `nimbus scaffold extension --from-openapi` (no sync handler); clone without
  any signature bypass; `funding` without the registry button (moved to the tile row); the Hub as
  `/authors/`.
- The clone acceptance criterion becomes: "`nimbus extension clone <id>` produces a copy that installs
  from its path (unsigned, or after `extension sign` with the author's key when `--publisher` was
  given) and runs after `extension approve`."
- The last PR marks project 7 ✅, and Phase 9.5 and S3 complete in `docs/roadmap.md`,
  `docs/CHANGELOG.md`, `CLAUDE.md` and `GEMINI.md`, leaving the owner's non-buildable items (hosting,
  pricing and KYC, the grant program, the 30-extension bar) and the open tile row listed as open.
- `docs/cli-reference.md` gets each command; `nimbus-sandbox-and-extensions` skill gets clone and
  funding.

## 9. Invariants

No new invariant. I44 is amended (triple rule: wiring, docs, test in one commit) to say that registry
bytes reach an author's clone only through the same verified chain, from the extension's registry, with
one stated difference (R5): the clone path verifies the index-named key's signature but makes no
publisher-key decision and stores no key, because nothing it produces is installed or run under that
publisher. Tests: a revoked or taken-down version is refused (I48), a tampered archive is refused, a
bad signature is refused, an unknown key is accepted for clone and the Vault holds no key afterwards,
and clone creates no extension row. The scaffold, `funding` and `license` touch no gate.

## 10. Delivery

One PR at a time, each from `main` after the previous one merges, each with a plan on this branch that
Antigravity reviews:
1. **Funding and license:** both fields' format and validation (registry-format), sign, publish and
   registry-action refusal with the action `dist` rebuilt, `info`, `sponsor`, desktop text.
2. **Clone:** `extension.cloneSource`, the CLI, the I44 amendment.
3. **OpenAPI scaffold:** parser, mapping, generated files, tests.
4. **Authors section and close-out:** the docs pages, roadmap/CHANGELOG/CLAUDE/GEMINI.

## 11. Open questions for the owner

None. The builder check (2026-11-04) raised ten points; R5 and R6 answered the two that were the
owner's, and the rest are settled above as my calls.

## 12. Left to the builder

- How `extension.cloneSource` hands the package to the CLI, under § 5's constraint.
- The exact README wording, and the generated code's style, within § 4.
- Page wording in § 7.
