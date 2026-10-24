# Role packs P3 PR 1: the role-pack manifest format and the registry `packs` entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the role-pack manifest format and the registry index `packs` entry in the pure
`@nimbus-dev/registry-format` package, so PR 2 (gateway install/remove/CLI) and later projects build
against one stable, tested format.

**Architecture:** One new pure module, `role-pack.ts` (manifest parse + digest), plus a never-throwing
`readRegistryPacks` reader in `index-format.ts`. Nothing in the gateway consumes either yet, apart from
one gateway test pinning the pack-id regex equal to the gateway's own. No runtime behaviour changes.

**Tech Stack:** TypeScript 7 strict, Bun test, `@nimbus-dev/sdk` `canonicalize`, `node:crypto` SHA-256.

**Spec:** `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md` §§ 5.1–5.2 (branch
`dev/asaf/role-packs` only). Parent: `2026-10-21-role-packs-overview-design.md` § 5 Project 3.

**PR split for Project 3 (this plan is PR 1):** PR 1 format (this); PR 2 gateway store record +
`checkPackLayer`, `pack.install` gate (I47/D36), `pack.*` IPC, CLI, bundled packs, the `registry list` note for a dropped `packs` map; PR 3
`[oncall.push] enabled` live + allowlist key + DevOps pack's on-call line + doctor `[info]` + docs.
Each later plan is written after the previous PR merges, against real types.

## Global Constraints

- `packages/registry-format/src` imports nothing from gateway/cli/ui (dependency-cruiser rule
  `registry-format-is-pure`).
- No `any`; external data is `unknown` and narrowed.
- Errors are `RegistryError` (`src/errors.ts`) with a new code `ERR_REGISTRY_ROLE_PACK_INVALID`;
  the detail starts with the field path (e.g. `suggestedConnectors[2]: ...`).
- Per-file coverage floor: ≥ 85 % lines AND ≥ 80 % branches for every new/changed source file
  (`audit:coverage-floor`; `packages/registry-format/src/**` is in scope).
- `canonicalize` is imported exactly as `index-format.ts` does, with its `// NOSONAR S1874` comment.
- Branch from current `main` as `dev/asafgolombek/role-packs-p3-format`; the spec and this plan never
  land on `main`.
- Values (verbatim from the spec): pack id regex
  `/^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9_-]{0,63}$/`; `defaults` ≤ 65,536
  UTF-8 bytes; whole manifest ≤ `128 * 1024` bytes; `name` 1–80 chars; `description` 1–500 chars
  (both refused with leading/trailing whitespace, not trimmed); `members` ≤ 32;
  `roles` ≤ 8, each `/^[a-z][a-z0-9-]{0,31}$/`; `suggestedConnectors` ≤ 32, each
  `/^[a-z0-9][a-z0-9_]{0,63}$/`; canonical index manifest path `packs/<id>/<version>/manifest.json`.

## Review Focus

1. **Multi-byte text in `defaults`.** The cap is UTF-8 bytes, not `.length`: 30,000 `é` (60,000
   bytes) passes, 33,000 `é` (66,000 bytes) is refused even though its `.length` is 33,000.
2. **A manifest saved with a BOM** (Windows editors): a leading U+FEFF is stripped before
   `JSON.parse`, the way `parseRegistryIndex` does.
3. **Duplicates and prototype keys:** the same connector, role or member twice is refused; a
   top-level `"__proto__"` key is refused as unknown (JSON.parse makes it an own property); a
   pre-parsed value whose prototype is not `Object.prototype`/`null`, or that would only satisfy a
   field through an inherited property, is refused.
4. **Absent vs empty arrays digest the same:** a manifest omitting `roles`/`members`/
   `suggestedConnectors` and one giving `[]` produce identical `rolePackDigest`.
5. **A bad `packs` entry is contained:** `parseRegistryIndex` still parses and the signature still
   verifies; `readRegistryPacks` returns `{ packs: {}, invalid }` instead of throwing.

Each has its test in the owning task below.

---

### Task 1: The manifest parser and digest (`role-pack.ts`)

**Files:**
- Create: `packages/registry-format/src/role-pack.ts`
- Create: `packages/registry-format/src/role-pack.test.ts`
- Modify: `packages/registry-format/src/caps.ts` (add the two caps)
- Modify: `packages/registry-format/src/errors.ts` (add the code to the union)
- Modify: `packages/registry-format/src/index.ts` (export the new names)
- Create: `packages/gateway/src/packs/pack-id-format.test.ts`

**Interfaces:**
- Consumes: `isValidSemver` (`index-format.ts`), `assertSafeExtensionId` (`extension-id.ts`),
  `RegistryError`, `canonicalize` from `@nimbus-dev/sdk`; gateway `PACK_ID_RE` from
  `packages/gateway/src/config/pack-settable.ts` (test only).
- Produces (all exported from the package root):
  ```ts
  export const MAX_ROLE_PACK_MANIFEST_BYTES = 128 * 1024;          // caps.ts
  export const MAX_ROLE_PACK_DEFAULTS_BYTES = 65_536;               // caps.ts
  export const ROLE_PACK_ID_RE: RegExp;                             // role-pack.ts
  export const CONNECTOR_ID_SHAPE_RE: RegExp;                       // role-pack.ts
  export const ROLE_TAG_RE: RegExp;                                 // role-pack.ts, /^[a-z][a-z0-9-]{0,31}$/
  export const MAX_ROLE_PACK_ROLES = 8, MAX_ROLE_PACK_CONNECTORS = 32, MAX_ROLE_PACK_MEMBERS = 32; // role-pack.ts
  export interface RolePackManifest {
    readonly schema: 1;
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly roles: readonly string[];               // absent → []
    readonly suggestedConnectors: readonly string[]; // absent → []
    readonly members: readonly string[];             // absent → []
    readonly defaults: string;                       // absent → "" (a suggestions-only pack)
  }
  export function parseRolePackManifest(text: string): RolePackManifest;
  export function parseRolePackManifestValue(raw: unknown): RolePackManifest; // for static JSON imports
  export function rolePackDigest(m: RolePackManifest): string;                // 64 lowercase hex
  ```

- [ ] **Step 1: Write the failing tests** in `role-pack.test.ts` (`describe("parseRolePackManifest")`,
  `describe("rolePackDigest")`). Use a `valid()` fixture:
  `{ schema: 1, id: "devops", name: "DevOps", version: "1.0.0", description: "On-call and delivery.",
  roles: ["devops", "sre"], suggestedConnectors: ["pagerduty", "github"], members: [],
  defaults: "[fleet]\nenabled = true\n" }`. Tests, each asserting `toThrow` with
  `ERR_REGISTRY_ROLE_PACK_INVALID` and the named field path in the message unless stated:
  - `parses a valid manifest` — returns every field equal to the fixture.
  - `absent optional arrays and defaults normalise` — omit `roles`, `suggestedConnectors`,
    `members`, `defaults` → `[]`, `[]`, `[]`, `""`.
  - `refuses schema other than 1` — `schema: 2` and `schema: "1"` (path `schema`).
  - `refuses unknown top-level keys` — `sourceMapping: {}` (path `sourceMapping`), and the raw text
    `{"__proto__":{}, ...valid}` (path `__proto__`).
  - `refuses a non-object document` — `[]`, `null`, `"x"`, and invalid JSON text (the last must be a
    `RegistryError`, never the native `SyntaxError`: assert `toBeInstanceOf(RegistryError)`).
  - `refuses a non-plain or inheriting value` — `parseRolePackManifestValue(Object.create({ defaults: "x" }))`
    with the other fields as own properties is refused (path `manifest`), and a `class` instance is
    refused.
  - `id rules` — refuses `""`, `"PM"`, `"-pm"`, `"con"`, `"lpt1"`, `"a".repeat(65)`; accepts
    `"a".repeat(64)` and `"pm_2-x"`.
  - `name rules` — refuses `""`, `"   "`, `" DevOps"`, `"DevOps "`, `"x".repeat(81)`; accepts
    `"x".repeat(80)` and `"Dev Ops"`.
  - `version must be strict semver` — refuses `"1.0"`, `"v1.0.0"`, `" 1.0.0"`; accepts `"1.2.3-beta.1"`.
  - `description rules` — refuses `""`, `"x".repeat(501)`, `"text
"`; accepts `"x".repeat(500)` and an
    inner newline (`"a
b"`).
  - `roles rules` — refuses 9 entries, `"Dev"`, `"1dev"`, a duplicate (path `roles[1]`).
  - `suggestedConnectors rules` — refuses 33 entries, `"Slack"`, `"a/b"`, `"a b"`, a duplicate
    (path `suggestedConnectors[1]`); accepts `"google_drive"`.
  - `members are shape-checked, not refused` — `["com.nimbus.readwise"]` parses (the gateway, not the
    format, refuses non-empty); `["../evil"]` and a duplicate are refused (path `members[0]` / `[1]`),
    each as a `RegistryError`, and 33 entries are refused (path `members`).
  - `defaults byte cap counts UTF-8 bytes` (Review Focus 1) — `"é".repeat(30_000)` parses;
    `"é".repeat(33_000)` is refused (path `defaults`); a non-string `defaults` is refused.
  - `whole-document cap` — text longer than `MAX_ROLE_PACK_MANIFEST_BYTES` UTF-8 bytes is refused
    before `JSON.parse` (path `manifest`).
  - `strips a leading BOM` (Review Focus 2) — `"﻿" + JSON.stringify(valid())` parses.
  - `parseRolePackManifestValue accepts the parsed object` — same result as the text form.
  - `rolePackDigest is stable across formatting and key order` — pretty-printed text, compact
    text, and an object with keys in reverse order all give the same digest, matching
    `/^[0-9a-f]{64}$/`.
  - `absent and empty arrays digest the same` (Review Focus 4).
  - `a description-only change changes the digest`.

  In `packages/gateway/src/packs/pack-id-format.test.ts`:
  `test("registry-format ROLE_PACK_ID_RE equals the gateway PACK_ID_RE", () => {
  expect(ROLE_PACK_ID_RE.source).toBe(PACK_ID_RE.source); expect(ROLE_PACK_ID_RE.flags).toBe(PACK_ID_RE.flags); })`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `bun test packages/registry-format/src/role-pack.test.ts packages/gateway/src/packs/pack-id-format.test.ts`
  Expected: FAIL — `role-pack.ts` does not exist / exports missing.

- [ ] **Step 3: Implement**

  - `caps.ts`: the two constants above, each with a one-line comment (the 128 KiB one says why it
    exceeds `MAX_MANIFEST_BYTES`: a 64 KiB `defaults` grows under JSON escaping).
  - `errors.ts`: add `"ERR_REGISTRY_ROLE_PACK_INVALID"` to `RegistryErrorCode`.
  - `role-pack.ts`: `parseRolePackManifest` measures `new TextEncoder().encode(text).byteLength`
    against the cap, strips one leading U+FEFF, `JSON.parse`s, then delegates to
    `parseRolePackManifestValue`. The value parser checks the allowed key set
    (`schema id name version description roles suggestedConnectors members defaults`) with
    `Object.keys`, then each field in table order; array fields check count first (`field:
    exceeds maximum of N entries`), then each element's type and shape (`field[i]: ...`), then
    uniqueness against a `Set` (`field[i]: duplicate entry "x"`, so a duplicate reports the SECOND
    index). Every throw is a `RegistryError`: `JSON.parse` is wrapped (`manifest: not valid JSON:
    <message>`), and `assertSafeExtensionId` (which throws a plain `Error`) is wrapped as
    `members[i]: <its message>`. Before the key check, the value must be a non-array object whose
    prototype is `Object.prototype` or `null` (`manifest: must be a plain JSON object`), and every
    field is read only after `Object.hasOwn(o, key)`, so an inherited property is never read. The returned object is built fresh from the
    checked fields (never a spread of the input), with the absent→default normalisation, so the
    digest sees only known keys. `rolePackDigest` is
    `createHash("sha256").update(canonicalize(m)).digest("hex")`.
  - `index.ts`: export the two caps, the three regexes, the three count caps, the type, and the
    three functions.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `bun test packages/registry-format/src/role-pack.test.ts packages/gateway/src/packs/pack-id-format.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/registry-format/src/role-pack.ts packages/registry-format/src/role-pack.test.ts packages/registry-format/src/caps.ts packages/registry-format/src/errors.ts packages/registry-format/src/index.ts packages/gateway/src/packs/pack-id-format.test.ts
  git commit -m "feat(registry-format): the role-pack manifest format and digest"
  ```

### Task 2: The registry index `packs` entry (`readRegistryPacks`)

**Files:**
- Modify: `packages/registry-format/src/index-format.ts`
- Modify: `packages/registry-format/src/index-format.test.ts`
- Modify: `packages/registry-format/src/index.ts`

**Interfaces:**
- Consumes: Task 1's `ROLE_PACK_ID_RE`, `MAX_ROLE_PACK_MANIFEST_BYTES`; `index-format.ts`'s private
  helpers `asObject`, `requireKeys`, `str`, `matching`, `isoTimestamp`, `isValidSemver`, `HEX64_RE`.
- Produces:
  ```ts
  export interface RegistryPackVersionEntry {
    channel: RegistryChannel;
    manifest: string;           // must equal `packs/<id>/<version>/manifest.json`
    manifestSha256: string;     // 64 lowercase hex
    manifestSizeBytes: number;  // safe integer, 1..MAX_ROLE_PACK_MANIFEST_BYTES
    publishedAt: string;        // parseable timestamp
  }
  export interface RegistryPackEntry {
    versions: Readonly<Record<string, RegistryPackVersionEntry>>;
  }
  export type RegistryPacksRead = {
    readonly packs: Readonly<Record<string, RegistryPackEntry>>;
    readonly invalid?: string;  // the RegistryError detail when the map was dropped
  };
  export function readRegistryPacks(index: RegistryIndex): RegistryPacksRead; // never throws
  ```
  `RegistryIndex` gains `readonly packs?: unknown;` — documentation that the parser carries the raw
  value through (it already does, via the `...o` spread). `parseRegistryIndex` itself is **not**
  changed: it must never read or rewrite `packs`, because `registryIndexSigningBytes` canonicalises
  the returned object and any rewrite would break the signature.

- [ ] **Step 1: Write the failing tests** in `index-format.test.ts`, `describe("readRegistryPacks")`,
  reusing the file's existing `sign()` / fixture helpers. A valid pack entry:
  `packs: { devops: { versions: { "1.0.0": { channel: "stable",
  manifest: "packs/devops/1.0.0/manifest.json", manifestSha256: "a".repeat(64),
  manifestSizeBytes: 900, publishedAt: "2026-10-24T00:00:00Z" } } } }`.
  - `an index without packs reads as empty` — `{ packs: {} }`, no `invalid`.
  - `a valid packs map parses` — returns the entry; the signed index verifies with
    `verifyRegistryIndexSelf`.
  - `packs is covered by the signature` — mutate `manifestSha256` after signing →
    `verifyRegistryIndexSelf` rejects with `ERR_REGISTRY_SIGNATURE_INVALID`.
  - `a malformed entry drops the whole map, not the index` (Review Focus 5) — a second pack whose
    `manifest` is `"packs/pm/1.0.0/x.json"`: `parseRegistryIndex` returns its extensions unchanged,
    the signature still verifies, and `readRegistryPacks` returns `packs: {}` with `invalid`
    containing `not canonical`.
  - one test per refusal, each asserting `packs: {}` and an `invalid` naming the path: `packs` not an
    object (`[]`); a pack id failing `ROLE_PACK_ID_RE` (`"PM"`); a pack with no versions; a non-semver
    version key (`"1.0"`); unknown `channel`; `manifestSizeBytes` `0`, `1.5`, and
    `MAX_ROLE_PACK_MANIFEST_BYTES + 1`; a malformed `manifestSha256`; a missing `publishedAt`.
  - `unknown keys inside an entry are tolerated` — an extra `publisher` field on a pack entry parses
    (forward compatibility, same rule as `requireKeys` elsewhere).

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `bun test packages/registry-format/src/index-format.test.ts`
  Expected: FAIL — `readRegistryPacks` is not exported.

- [ ] **Step 3: Implement** `readRegistryPacks` in `index-format.ts` with private
  `parsePackEntry(raw, id)` / `parsePackVersionEntry(raw, id, version)` mirroring
  `parseExtensionEntry` / `parseVersionEntry` (same helpers, same `...o` carry-through, paths
  prefixed `packs.`). `readRegistryPacks` reads `index.packs`; `undefined` → `{ packs: {} }`; it
  wraps the whole map's parse in one `try`, and on a `RegistryError` returns
  `{ packs: {}, invalid: err.detail }`, matching with `err instanceof RegistryError` (any other error
  is rethrown — that is a bug, not data). `null`, `[]` and primitives are not `undefined`: they reach
  `asObject` and come back as `invalid: "packs must be an object"`.
  Export the new types and function from `index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `bun test packages/registry-format/src`
  Expected: PASS (the existing index-format tests unchanged).

- [ ] **Step 5: Commit**

  ```bash
  git add packages/registry-format/src/index-format.ts packages/registry-format/src/index-format.test.ts packages/registry-format/src/index.ts
  git commit -m "feat(registry-format): read the registry index packs entry without failing the index"
  ```

### Task 3: Verify and open the PR

- [ ] **Step 1:** `bun run preflight:fast` — expected: passes (typecheck, biome, dependency-cruiser
  `registry-format-is-pure`, doc-refs).
- [ ] **Step 2:** `bun test packages/registry-format packages/gateway/src/packs` — expected: 0 fail.
- [ ] **Step 3:** Coverage for the two changed source files:
  `bun test packages/registry-format/src --coverage` — `role-pack.ts` and `index-format.ts` each
  ≥ 85 % lines and ≥ 80 % branches. Add a targeted test for any uncovered branch.
- [ ] **Step 4:** Confirm the branch carries no `docs/superpowers/` file
  (`git diff --name-only origin/main...HEAD | grep superpowers` prints nothing).
- [ ] **Step 5:** Push and open the PR. Title:
  `feat(registry-format): role-pack manifest format and registry packs entry`. Body: what it adds,
  that nothing consumes it yet (PR 2 does), that `parseRegistryIndex` is deliberately untouched
  because the signature covers its returned object, and the attribution line.

## Plan review (2026-10-24, `…-pr1-pack-format-review.md`)

Accepted: wrap `JSON.parse` and `assertSafeExtensionId` so only `RegistryError` escapes (1.1, 1.2);
plain-object prototype check plus own-property reads (1.3); `null`/`[]` packs reported as invalid
(1.4); export `ROLE_TAG_RE` (2.1); refuse surrounding whitespace in `name`/`description` rather
than trim, so the digest never hides a typo (2.2); `members` ≤ 32 (2.3); the duplicate-path rule
(3.1). Already in the plan: semver via `isValidSemver` (2.4), the canonical-path check (3.2), the
size bounds (3.3), the gateway parity test and its expected red (3.4). Nothing rejected.
