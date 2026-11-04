# Author onboarding PR 1 — `funding` and `license` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extension manifests may carry optional `funding` links and an SPDX `license`; Nimbus refuses malformed ones where an author signs or a registry publishes, shows them in `nimbus extension info`, and `nimbus extension sponsor <id>` opens a funding link after an explicit yes.

**Architecture:** Both fields are read RAW from the signed manifest JSON by pure readers in `@nimbus-dev/registry-format` (the `readManifestRepository` precedent), so the strict manifest parser and older gateways are untouched. Refusal happens in `validatePublish` (CLI publish and the registry action) and `nimbus extension sign`; display reads the hash-checked installed manifest (`extension.info`) or the hash-checked newest registry manifest (`registry.info`). `sponsor` copies `extension report`'s confirm-then-`openHttpsUrl` shape.

**Tech Stack:** Bun, TypeScript strict, `@nimbus-dev/registry-format` (pure, also runs under the runner's Node), Biome.

**Spec:** `docs/superpowers/specs/2026-11-04-author-onboarding-design.md` § 5 (License) and § 6, on branch `dev/asaf/author-onboarding-spec`. Owner rulings R1–R6.

## Global Constraints

- `funding`: optional top-level array of `{ "url": string, "label"?: string }`, 1 to 8 entries; `url` is `https:` with a host, no userinfo, at most 2048 characters; `label` 1 to 64 characters with no control characters (`\p{Cc}`) and no bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069); no other keys in an entry; no duplicate `url`.
- `license`: optional top-level string, an SPDX license expression of at most 128 characters (shape check only, § Task 1; the OSI list is PR 2's).
- At runtime a malformed field is IGNORED and reported as invalid, never a manifest error; at `sign`, `publish` and the registry action it is REFUSED.
- `registry-format` stays pure and Node-safe: no Bun APIs, no `Promise.try` (see memory: registry-format runs under the runner's Node).
- No new IPC method, no allowlist change (Tauri `ALLOWED_METHODS`, LAN), no schema migration, no invariant change.
- Every string from a manifest printed by the CLI goes through the existing `clean()` sanitiser.
- A link opens only on a TTY, only after a yes, only through `openHttpsUrl`; the URL is always printed.
- Desktop: nothing in this PR (ruling below).
- Run `bun run preflight:fast` and `bun run typecheck:tests` before every push; rebuild the registry action `dist` (`bun run --cwd packages/github-actions/registry-action build`) after Task 1.

## Rulings made in this plan (against the spec)

- **Desktop text dropped from PR 1.** Spec § 6 says "the desktop shows the entries as text in the extension details". The desktop has no details view (`packages/ui/src/pages/Marketplace.tsx` renders one list row from `extension.list`). Adding a view is the open **Marketplace page and desktop tile** row's work. Cost if wrong: one small UI PR later. The spec is updated to say so.
- **Remote reads describe the newest LISTED version.** Spec § 6 says `--registry` reads "the version an install would take". `registry.info` fetches and hash-checks exactly one manifest, the newest listed version's, and every other remote field (permissions, evidence, provenance) already describes it, labelled by `evidenceFor`. Funding and license follow the same version and the same label rather than adding a second manifest fetch. Cost if wrong: a beta's funding shown for a stable install, visibly labelled. The spec is updated.

## Review Focus

1. A `funding.url` of `javascript:`, `http:`, `file:` or `https://user:pass@host/` is invalid and can never reach `openHttpsUrl` (Task 1 reader test; Task 4 test that an invalid view opens nothing).
2. A label carrying an ANSI escape or a bidi override is invalid at the source, and the CLI still `clean()`s whatever it prints (Task 1, Task 3).
3. A manifest edited on disk after install shows no funding or license, not the edited one (Task 2: hash mismatch → both `null`).
4. `sponsor` off a TTY prints and never opens; a "no" opens nothing (Task 4).
5. A manifest with neither field still signs and publishes exactly as before (Task 1, Task 3 regression tests).

---

### Task 1: The readers and the publish refusal (registry-format)

**Files:**
- Create: `packages/registry-format/src/author-metadata.ts`
- Create: `packages/registry-format/src/author-metadata.test.ts`
- Modify: `packages/registry-format/src/index.ts` (exports)
- Modify: `packages/registry-format/src/validate-publish.ts` (after `parseCandidateManifest`, rule 2)
- Modify: `packages/registry-format/src/validate-publish.test.ts`
- Modify: `packages/github-actions/registry-action/dist/*` (rebuilt, not hand-edited)

**Interfaces:**
- Produces (exported from `@nimbus-dev/registry-format`):
  ```ts
  export const MAX_FUNDING_ENTRIES = 8;
  export const MAX_FUNDING_LABEL_CHARS = 64;
  export const MAX_FUNDING_URL_CHARS = 2048;
  export const MAX_LICENSE_CHARS = 128;
  export interface FundingEntry { readonly url: string; readonly label?: string }
  export type AuthorField<T> =
    | { readonly kind: "absent" }
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "invalid"; readonly reason: string };
  export function readManifestFunding(raw: unknown): AuthorField<readonly FundingEntry[]>;
  export function readManifestLicense(raw: unknown): AuthorField<string>;
  export function isFundingUrl(url: unknown): url is string;
  /** What info shows: null when absent; `fundingInvalid`/`licenseInvalid` only when malformed. */
  export interface AuthorMetadataView {
    readonly funding: readonly FundingEntry[] | null;
    readonly fundingInvalid?: true;
    readonly license: string | null;
    readonly licenseInvalid?: true;
  }
  export function authorMetadataView(raw: unknown): AuthorMetadataView;
  /** Throws `RegistryError("ERR_REGISTRY_MANIFEST_INVALID", "<field>: <reason>")` on a malformed field. */
  export function assertAuthorMetadata(raw: unknown): void;
  ```
- `raw` that is not a plain object reads as absent for both fields.

- [ ] **Step 1: Write the failing reader tests** in `author-metadata.test.ts`:
  - absent: `readManifestFunding({})` → `{ kind: "absent" }`; same for license.
  - ok: `[{ url: "https://github.com/sponsors/acme", label: "GitHub Sponsors" }, { url: "https://ko-fi.com/acme" }]` → `ok` with both entries, label kept, second has no `label` key.
  - invalid, one test each, asserting `kind: "invalid"` and that `reason` names the problem: not an array; `[]`; 9 entries; entry not an object; extra key `{ url, label, icon }`; `url` `"http://x.com"`, `"javascript:alert(1)"`, `"file:///etc/passwd"`, `"https://user:pw@x.com/"`, `"https://"` , a 2049-character https URL; duplicate url; label `""`, 65 characters, containing `"\u001b[31m"`, containing `"‮"` (write the escape with `String.fromCodePoint(0x202e)`, never a raw bidi character in source — Sonar S6389).
  - license ok: `"MIT"`, `"Apache-2.0"`, `"MIT OR Apache-2.0"`, `"(MIT OR Apache-2.0) AND BSD-3-Clause"`, `"Apache-2.0 WITH LLVM-exception"`, `"LicenseRef-Acme-1.0"`, `"GPL-2.0-or-later"`, `"GPL-2.0+"`.
  - license invalid: `""`, `42`, `"MIT OR"`, `"OR MIT"`, `"MIT AND AND BSD"`, `"(MIT"`, `"MIT)"`, `"MIT WITH"`, `"MIT WITH (X)"`, `"M I T"`, a 129-character string, `"MIT\n"`.
  - `authorMetadataView` maps absent → `null` with no `*Invalid` key, ok → value, invalid → `null` plus `fundingInvalid: true` / `licenseInvalid: true`.
  - `assertAuthorMetadata({ license: "MIT OR" })` throws a `RegistryError` with code `ERR_REGISTRY_MANIFEST_INVALID` and message starting `license: `; `({})` does not throw.

- [ ] **Step 2: Run** `bun test packages/registry-format/src/author-metadata.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement `author-metadata.ts`.** The SPDX check is a tokenizer plus a small grammar, which the tests do not fully determine:
  - Tokens split on whitespace and around `(` `)`. A license id token matches `/^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/` or `/^LicenseRef-[A-Za-z0-9.-]+$/`; operators are exactly `AND`, `OR`, `WITH` (case-sensitive, per SPDX).
  - Grammar: `expr := term ((AND|OR) term)*`; `term := id [WITH id] | "(" expr ")"`. All tokens consumed; any other token or a leftover is invalid. Reject control characters before tokenizing.
  - URL check: `URL.canParse`, then `protocol === "https:"`, `hostname !== ""`, `username === "" && password === ""`, length ≤ 2048.

- [ ] **Step 4: Run** the test file — expected PASS.

- [ ] **Step 5: Write the failing publish tests** in `validate-publish.test.ts`, using the file's existing candidate builder:
  - a candidate whose signed manifest has `funding: [{ url: "http://x.com" }]` → rejects with `ERR_REGISTRY_MANIFEST_INVALID`, message contains `funding:`.
  - the same with `license: "MIT OR"` → rejects, message contains `license:`.
  - valid `funding` and `license` → verdict returned (no new verdict fields).
  - the existing no-field candidate still passes (an existing test may already cover it; keep it).

- [ ] **Step 6: Wire `assertAuthorMetadata(raw)`** into `validatePublish` immediately after rule 2's `parseCandidateManifest`, commented `// 2b`. Run `bun test packages/registry-format` — expected PASS.

- [ ] **Step 7: Rebuild the action** with `bun run --cwd packages/github-actions/registry-action build`, then run `bun run audit:action-dist` — expected: no drift.

- [ ] **Step 8: Commit** `feat(registry-format): read and validate manifest funding and license`.

### Task 2: The gateway carries both fields in `extension.info` and `registry.info`

**Files:**
- Create: `packages/gateway/src/extensions/installed-author-metadata.ts`
- Create: `packages/gateway/src/extensions/installed-author-metadata.test.ts`
- Modify: `packages/gateway/src/ipc/automation-rpc.ts` (`handleExtensionInfo`: the shared `run` object, so every return branch carries it)
- Modify: `packages/gateway/src/ipc/registry-rpc.ts` (`registry.info` full reply, not `reportOnly`)
- Modify: `packages/gateway/src/ipc/automation-rpc.edges.test.ts`, `packages/gateway/src/ipc/registry-rpc.test.ts`

**Interfaces:**
- Consumes: `authorMetadataView`, `AuthorMetadataView` (Task 1).
- Produces: `installedAuthorMetadata(row: ExtensionRow): AuthorMetadataView` — reads the manifest via `resolveExtensionManifestPath(row.install_path)` ONCE, checks its sha256 against `row.manifest_hash` with `sha256HexEqualConstantTime` (as `readVerifiedManifest` in `approve-run.ts` does), and returns `authorMetadataView(JSON.parse(text))`. Missing file, unreadable file, bad JSON or a hash mismatch → `{ funding: null, license: null }` and a debug log; it never throws.
- `extension.info` reply: `extension.funding`, `extension.license` and, when malformed, `extension.fundingInvalid` / `extension.licenseInvalid`.
- `registry.info` full reply: top-level `funding`, `license`, `fundingInvalid?`, `licenseInvalid?` from `authorMetadataView(JSON.parse(text))` of the newest listed version's hash-checked manifest (the `text` already parsed for provenance; parse it once and reuse).

- [ ] **Step 1: Write the failing tests:**
  - `installed-author-metadata.test.ts` (fresh temp dir, real files, no mocks): a manifest with valid fields and a matching `manifest_hash` → both values; the same file edited after hashing → `{ funding: null, license: null }`; no manifest file → nulls; malformed `funding` with a matching hash → `fundingInvalid: true`.
  - `automation-rpc.edges.test.ts`: `extension.info` for an installed fixture with `funding`/`license` returns them under `extension`; one fixture taking the signature-disabled branch still carries them.
  - `registry-rpc.test.ts`: the newest manifest's `funding`/`license` appear in the full reply; a `reportOnly` call does not include them.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/installed-author-metadata.test.ts packages/gateway/src/ipc/automation-rpc.edges.test.ts packages/gateway/src/ipc/registry-rpc.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the module and the two wirings.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `feat(gateway): carry manifest funding and license in extension and registry info`.

### Task 3: The CLI shows them, and `sign` refuses malformed ones

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` (`runExtensionInfo` local branch, `runExtensionSign`)
- Modify: `packages/cli/src/commands/extension-registry-cmds.ts` (`runExtensionInfoRemote`, `RemoteInfo`)
- Create: `packages/cli/src/commands/author-metadata-lines.ts` (+ `.test.ts`)
- Modify: `packages/cli/src/commands/extension.test.ts`, `extension-registry-cmds.test.ts`

**Interfaces:**
- Consumes: Task 2's reply fields; `assertAuthorMetadata`, `FundingEntry` (Task 1).
- Produces: `authorMetadataLines(view: { funding?: unknown; fundingInvalid?: unknown; license?: unknown; licenseInvalid?: unknown }): string[]`, every string `clean()`ed:
  - `License: <expr>` | `License: (invalid, ignored)` | `License: not declared`
  - `Funding: none` | `Funding: (invalid, ignored)` | `Funding:` followed by one line per entry `  <n>. <label> <url>` (label omitted when absent; `n` from 1). Entries are re-checked with `isFundingUrl`; one that fails is dropped from the list.

- [ ] **Step 1: Write the failing tests:** `author-metadata-lines.test.ts` for every line form above, including a label with `"\u001b[2J"` coming out cleaned; `extension.test.ts`: local `info` prints the lines after the publisher block; `extension-registry-cmds.test.ts`: remote `info` prints them after the provenance line; `sign` on a manifest with `license: "MIT OR"` exits 2, writes `manifest license is invalid: ` to stderr and leaves the file byte-identical; `sign` on a manifest with neither field still signs (existing test, keep).
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/author-metadata-lines.test.ts packages/cli/src/commands/extension.test.ts packages/cli/src/commands/extension-registry-cmds.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.** In `runExtensionSign`, call `assertAuthorMetadata(parsed)` after `JSON.parse` and before deleting `signature`; on a `RegistryError` print `manifest <field> is invalid: <reason>; fix it before signing` (field and reason from the error message) and return 2.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(cli): show funding and license in extension info; sign refuses malformed ones`.

### Task 4: `nimbus extension sponsor <id>`

**Files:**
- Create: `packages/cli/src/commands/extension-sponsor.ts` (+ `.test.ts`)
- Modify: `packages/cli/src/commands/extension.ts` (`dispatchExtensionWithCode` handler `sponsor`, wired exactly like `report`; `EXTENSION_USAGE`)

**Interfaces:**
- Consumes: `extension.info` / `registry.info` fields (Task 2), `isFundingUrl` (Task 1), `openHttpsUrl`, `clean`.
- Produces: `runExtensionSponsor(args: readonly string[], deps: SponsorDeps): Promise<number>` with
  `SponsorDeps = { client: IPCClient; isTty: boolean; confirm: (q: string) => Promise<boolean>; openUrl: (u: string) => Promise<void>; log: (s: string) => void; err: (s: string) => void }`.
- Usage: `nimbus extension sponsor <id> [--registry <name>] [--index <n>]`.
- Behaviour:
  - Without `--registry`: `extension.info { id }`; with it: `registry.info { id, registry }`.
  - Prints `Funding links for <id>:` (remote: plus `(from <version>, <channel>)` from `evidenceFor`) and the numbered list.
  - `funding` null → `<id> declares no funding links.` exit 1; `fundingInvalid` → `<id>'s funding field is malformed and is ignored.` exit 1. An IPC error naming `ERR_REGISTRY_` or `Extension not found` → its message cleaned, exit 1.
  - `--index n` picks entry n (1-based; default 1). Missing value, not a positive integer, or out of range → usage message, exit 2.
  - The chosen URL is re-checked with `isFundingUrl`; failing → error, exit 1, nothing opens.
  - Off a TTY: print `Open <url> in your browser to sponsor.` and exit 0 without asking.
  - On a TTY: `confirm("Open <host> in your browser? [y/N] ")` (host from `new URL(url).host`); yes → `openUrl(url)`, exit 0; no → exit 0, nothing opened. An `openUrl` rejection → `could not open the browser: <message>` (cleaned), exit 1, the URL already printed.

- [ ] **Step 1: Write the failing tests** with fake deps (record `openUrl` calls; assert the call COUNT): one per behaviour bullet above, plus: a `javascript:` URL that somehow arrives in the reply opens nothing; the remote form passes `registry` to `registry.info`; `--index 2` opens the second entry.
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/extension-sponsor.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** and wire the handler.
- [ ] **Step 4: Run** the test, then `bun test packages/cli/src/commands/extension.test.ts` — expected PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus extension sponsor opens a funding link after an explicit yes`.

### Task 5: Docs, roadmap and gates

**Files:**
- Modify: `docs/cli-reference.md` (`extension info` output lines; a new `### nimbus extension sponsor <id> [--registry <name>] [--index <n>]` section after `report`; `sign` refuses malformed `funding`/`license`; a short "Manifest fields `funding` and `license`" paragraph under `publish` with the Global Constraints rules, the runtime-ignore/publish-refuse split, and the stated bound that a registry on an older action can sign a malformed one that gateways then ignore)
- Modify: `docs/roadmap.md` (**Author sponsorship** row: ticked, rewritten to what shipped; the Sponsor button named as moved to **Marketplace page and desktop tile**, whose row gains it; the project 7 status cell: "PR 1 of 4 (funding and license) <date>")
- Modify: `docs/CHANGELOG.md` (dated entry)
- Modify: `packages/github-actions/registry-action/README.md` (the publish check now refuses malformed `funding`/`license`)
- Modify: `.claude/commands/nimbus-sandbox-and-extensions.md` (one line each for the fields and `sponsor`)

- [ ] **Step 1:** Write the docs. Every command, flag and message quoted must match Tasks 1–4 exactly.
- [ ] **Step 2: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests` — expected all pass.
- [ ] **Step 3: Commit** `docs: funding, license and extension sponsor`.
