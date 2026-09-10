# S2 Toolgen PR 3 — Persistence + Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nimbus tool save <tool-id>` promotes a live generated tool to a durable one, bound by an Ed25519 signature over the canonical artifact to the bytes the owner approved — and closes the pre-existing leak where an ephemeral tool's Vault credential outlives both the tool and the gateway.

**Architecture:** A saved tool gets its own store (`<configDir>/toolgen/saved/<toolId>/`) and its own verification pass, inheriting invariant I16's *property* without the extension subsystem's machinery. Machine-derived absolute paths are excluded from the signature and the sandbox manifest is reconstructed at spawn, then asserted against the signed shape. Authority splits on two axes: the `generated_tool` row governs whether a tool exists, disk-plus-signature governs what it is.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, `tweetnacl` (Ed25519, via `@nimbus-dev/sdk`'s `generateEd25519Keypair`/`decodeBase64`/`encodeBase64`), Biome, `bun test`.

**Spec:** [`docs/superpowers/specs/2026-09-10-s2-toolgen-persistence-design.md`](../specs/2026-09-10-s2-toolgen-persistence-design.md)
(review disposition in that spec's § 14; review itself at [`…-design-review.md`](../specs/2026-09-10-s2-toolgen-persistence-design-review.md))

---

## Global Constraints

- **No `any`.** External/parsed data is `unknown` and narrowed with real guards, never a type assertion.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** (`db/write.ts`) — static rule D12/I14.
- **Bound parameters only**; identifiers via `escapeIdentifier` — I9.
- **No plaintext credentials** in logs, IPC, config, or DB columns — Non-Negotiable #3. The Ed25519 private seed is Vault-only.
- **Platform equality** — Windows/macOS/Linux. Build paths with `path.join()`; never hardcode separators. `bun run audit:cross-platform` must stay green.
- **`mkdir` must carry `mode` forward on the same call as `recursive: true`** — a later `mode` on an existing dir is a silent no-op. Match `toolgen-script-store.ts`: `mkdir(dir, { recursive: true, mode: 0o700 })`.
- **The `toolgen` IPC namespace stays LAN-forbidden and absent from the Tauri allowlist.** The `ALLOWED_METHODS` count assertion must not move.
- **Triple rule** — invariant wiring, the `docs/SECURITY-INVARIANTS.md` entry, and the `security-invariants.test.ts` enforcement test land in the SAME commit (Task 11).
- **Every gate/guard test must be red-proved by reverting the fix**, and every "refuses" assertion needs a positive control proving the valid case works.
- Run `bun run preflight:fast` before declaring any task done; `bun run preflight` before the PR.

---

## Plan-level refinement — read before Task 1

The spec's § 3 lists three files under `saved/<toolId>/`: `index.ts`, `artifact.json`, `artifact.sig`. While mapping the file structure, one improvement emerged that the spec does not state, and it changes one of the spec's tests:

**`artifact.json` holds the canonical bytes verbatim, and `index.ts` is derived.**

- `artifact.json` is written as *exactly* `canonicalArtifactBytes(artifact)` — the same string that is signed. Verification is then signature-over-file-bytes with no re-canonicalisation step, which removes an entire bug class (canonicalising on load and getting a different string than was signed).
- `index.ts` is **re-emitted from the verified `artifact.body` at spawn**, not read back and trusted. It is a derived, disposable file kept on disk for inspection.

**Consequence for testing:** the spec's "byte flip in `index.ts` → refuses" test is **replaced** by "byte flip in `index.ts` → overwritten at spawn; the tool executes the approved bytes." That is a stronger property — tampering with the derived file is irrelevant rather than merely detected.

If you disagree with this refinement, stop and raise it before Task 1; it is load-bearing for Tasks 4, 8 and 9.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/gateway/src/toolgen/toolgen-portable-manifest.ts` | Derive the signable manifest shape; assert a concrete manifest satisfies it |
| `packages/gateway/src/toolgen/toolgen-keypair.ts` | Vault-only Ed25519 keypair; sign + verify detached signatures |
| `packages/gateway/src/toolgen/toolgen-saved-store.ts` | The ONLY reader/writer of `toolgen/saved/` — D29(d)'s home |
| `packages/gateway/src/toolgen/toolgen-saved-repo.ts` | `generated_tool` row CRUD |
| `packages/gateway/src/toolgen/toolgen-save-gate.ts` | Ordered save gate: refusals → consent → sign → persist |
| `packages/gateway/src/toolgen/toolgen-boot-reconcile.ts` | Boot: row verification pass + orphan sweep |
| `packages/gateway/src/toolgen/toolgen-credential-sweep.ts` | Exhaustive `toolgen.` Vault sweep (boot + shutdown) |
| `packages/gateway/src/index/generated-tool-v61-sql.ts` | V61 DDL |

**Modified:**

| File | Change |
|---|---|
| `toolgen/toolgen-artifact.ts` | Canonicalize the portable manifest, not the concrete one |
| `toolgen/toolgen-types.ts` | `PortableToolManifest`, new error codes, saved-envelope type |
| `toolgen/toolgen-broker.ts` | `credentialHostsFor` dep + `ERR_TOOLGEN_CREDENTIAL_REQUIRED` |
| `toolgen/toolgen-registry.ts` | Separate saved collection; `forSession` unions; budget unchanged |
| `toolgen/toolgen-consent-broker.ts` | `ToolgenSaveApprovalInput` |
| `ipc/toolgen-rpc.ts` | `toolgen.save`; `toolgen.list` widening; revoke drops credentials |
| `platform/assemble.ts` | Wire the new deps |
| `gateway-main.ts` | Shutdown credential sweep |
| `index/migrations/runner.ts`, `index/local-index.ts` | V61 step; `CURRENT_SCHEMA_VERSION = 61` |
| `packages/cli/src/commands/tool.ts` | `save` subcommand; `credential set` made real; list rendering |
| `scripts/structure-audit/check-nimbus-invariants.ts` | D29(d); `toolgen-keypair.ts` vault allow-list entry |
| `packages/gateway/src/security-invariants.test.ts` | I40 |
| `docs/SECURITY-INVARIANTS.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`, `docs/CHANGELOG.md` | I40 + re-ledger |

---

## Task 1: Portable manifest — stop signing machine-derived paths

Spec § 3.1. **This must be first.** Every later task signs on top of `canonicalArtifactBytes`, and changing it is free only until signed artifacts exist on disk.

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-portable-manifest.ts`
- Create: `packages/gateway/src/toolgen/toolgen-portable-manifest.test.ts`
- Modify: `packages/gateway/src/toolgen/toolgen-artifact.ts`
- Modify: `packages/gateway/src/toolgen/toolgen-types.ts`
- Test: `packages/gateway/src/toolgen/toolgen-artifact.test.ts`

**Interfaces:**

- Consumes: `GeneratedToolArtifact`, `ExtensionManifest`, `canonicalize` (`extensions/canonical-json.ts`).
- Produces:
  - `toPortableManifest(m: ExtensionManifest): PortableToolManifest`
  - `assertConcreteManifestMatches(concrete: ExtensionManifest, portable: PortableToolManifest, expectedRead: readonly string[]): void` — throws `ToolgenError("ERR_TOOLGEN_MANIFEST_SHAPE_INVALID", …)`
  - `PortableToolManifest` (in `toolgen-types.ts`)

- [ ] **Step 1: Add the type to `toolgen-types.ts`**

```ts
/**
 * The manifest fields that are SIGNED. Deliberately excludes `filesystem.read`, whose entries are
 * machine-derived absolute paths (`dirname(process.execPath)`, plus its parent on macOS) — signing
 * those makes a Bun upgrade indistinguishable from tampering (spec § 3.1). The read set is instead
 * reconstructed at spawn and asserted against this shape.
 */
export interface PortableToolManifest {
  readonly id: string;
  readonly version: string;
  readonly updateChannel: string;
  /** Empty by construction — I39. Signed so a non-empty value cannot ride in unnoticed. */
  readonly network: readonly string[];
  /** Empty by construction. Signed for the same reason. */
  readonly filesystemWrite: readonly string[];
}

/** Added in PR 3; see spec § 9's error table. */
export const ERR_TOOLGEN_MANIFEST_SHAPE_INVALID = "ERR_TOOLGEN_MANIFEST_SHAPE_INVALID";
export const ERR_TOOLGEN_CREDENTIAL_REQUIRED = "ERR_TOOLGEN_CREDENTIAL_REQUIRED";
export const ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN = "ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN";
export const ERR_TOOLGEN_SIGNATURE_INVALID = "ERR_TOOLGEN_SIGNATURE_INVALID";
export const ERR_TOOLGEN_SAVE_DISABLED = "ERR_TOOLGEN_SAVE_DISABLED";
export const ERR_TOOLGEN_SAVE_NOT_LIVE = "ERR_TOOLGEN_SAVE_NOT_LIVE";
export const ERR_TOOLGEN_SAVE_DENIED = "ERR_TOOLGEN_SAVE_DENIED";
```

- [ ] **Step 2: Write the failing test** — `toolgen-portable-manifest.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { buildGeneratedManifest } from "./toolgen-stub.ts";
import { assertConcreteManifestMatches, toPortableManifest } from "./toolgen-portable-manifest.ts";

const RUNTIME = ["/opt/bun/bin"];

describe("toPortableManifest", () => {
  test("two manifests differing ONLY in resolved read paths are portably identical", () => {
    const a = buildGeneratedManifest("t1", { scriptDir: "/cfg/toolgen/ephemeral/t1", runtimeReadPaths: RUNTIME });
    const b = buildGeneratedManifest("t1", { scriptDir: "/cfg/toolgen/saved/t1", runtimeReadPaths: ["/usr/local/bun/bin", "/usr/local"] });
    expect(toPortableManifest(a)).toEqual(toPortableManifest(b));
  });
});

describe("assertConcreteManifestMatches", () => {
  test("accepts a manifest whose read set is exactly own-dir + runtime paths", () => {
    const m = buildGeneratedManifest("t1", { scriptDir: "/cfg/saved/t1", runtimeReadPaths: RUNTIME });
    expect(() =>
      assertConcreteManifestMatches(m, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]),
    ).not.toThrow();
  });

  test("refuses an extra read path that the expected set does not contain", () => {
    const m = buildGeneratedManifest("t1", { scriptDir: "/cfg/saved/t1", runtimeReadPaths: [...RUNTIME, "/etc"] });
    expect(() =>
      assertConcreteManifestMatches(m, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]),
    ).toThrow(/ERR_TOOLGEN_MANIFEST_SHAPE_INVALID/);
  });

  test("refuses a non-empty network grant even when the read set is correct", () => {
    const m = buildGeneratedManifest("t1", { scriptDir: "/cfg/saved/t1", runtimeReadPaths: RUNTIME });
    const tampered = { ...m, permissions: { ...m.permissions, network: ["api.example.com"] } };
    expect(() =>
      assertConcreteManifestMatches(tampered, toPortableManifest(m), ["/cfg/saved/t1", ...RUNTIME]),
    ).toThrow(/ERR_TOOLGEN_MANIFEST_SHAPE_INVALID/);
  });
});
```

- [ ] **Step 3: Run it — expect failure**

Run: `bun test packages/gateway/src/toolgen/toolgen-portable-manifest.test.ts`
Expected: FAIL — `Cannot find module './toolgen-portable-manifest.ts'`

- [ ] **Step 4: Implement `toolgen-portable-manifest.ts`**

```ts
import type { ExtensionManifest } from "../extensions/manifest.ts";
import { ERR_TOOLGEN_MANIFEST_SHAPE_INVALID, type PortableToolManifest, ToolgenError } from "./toolgen-types.ts";

/**
 * The signable projection of a generated tool's manifest (spec § 3.1).
 *
 * `filesystem.read` is dropped ON PURPOSE: its entries are machine-derived absolute paths, so
 * signing them would make a Bun upgrade, a config-dir move, or simply a different OS present as a
 * signature mismatch — a tampering warning for an event that is not tampering.
 */
export function toPortableManifest(m: ExtensionManifest): PortableToolManifest {
  return {
    id: m.id,
    version: m.version,
    updateChannel: m.updateChannel,
    network: [...(m.permissions?.network ?? [])],
    filesystemWrite: [...(m.permissions?.filesystem?.write ?? [])],
  };
}

/**
 * Assert that a manifest reconstructed at spawn still satisfies the shape the owner signed.
 *
 * This is what makes reconstruction SAFE rather than merely convenient: the concrete manifest is
 * built from code (not read back from disk, so not attacker-influenceable), and this check proves
 * the rebuild did not widen anything the signature covers.
 *
 * The read comparison is SET equality, not subset: a missing path breaks the spawn and an extra one
 * is a widened grant, and neither should pass.
 */
export function assertConcreteManifestMatches(
  concrete: ExtensionManifest,
  portable: PortableToolManifest,
  expectedRead: readonly string[],
): void {
  const actual = toPortableManifest(concrete);
  const refuse = (why: string): never => {
    throw new ToolgenError(ERR_TOOLGEN_MANIFEST_SHAPE_INVALID, `reconstructed manifest does not match the signed shape: ${why}`);
  };

  if (actual.id !== portable.id) refuse(`id ${actual.id} != ${portable.id}`);
  if (actual.version !== portable.version) refuse("version differs");
  if (actual.updateChannel !== portable.updateChannel) refuse("updateChannel differs");
  if (actual.network.length > 0) refuse("network grant is non-empty");
  if (portable.network.length > 0) refuse("signed manifest carries a network grant");
  if (actual.filesystemWrite.length > 0) refuse("filesystem write grant is non-empty");

  const got = new Set(concrete.permissions?.filesystem?.read ?? []);
  const want = new Set(expectedRead);
  if (got.size !== want.size) refuse(`read set has ${got.size} entries, expected ${want.size}`);
  for (const p of want) if (!got.has(p)) refuse(`read set is missing ${p}`);
}
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/gateway/src/toolgen/toolgen-portable-manifest.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Switch `canonicalArtifactBytes` to the portable manifest**

In `toolgen-artifact.ts`, change the `manifest` line and extend the docstring:

```ts
    inputSchema: artifact.inputSchema,
    // PORTABLE projection, not the concrete manifest (spec § 3.1). The concrete manifest's
    // `filesystem.read` holds machine-derived absolute paths — the ephemeral script dir and
    // `dirname(process.execPath)` — so signing it would bind the artifact to one machine, one Bun
    // install and one OS. The spawn path rebuilds the concrete manifest and asserts it against this
    // shape instead (`assertConcreteManifestMatches`).
    manifest: toPortableManifest(artifact.manifest),
```

- [ ] **Step 7: Add the artifact-level regression test**

Append to `toolgen-artifact.test.ts`:

```ts
test("artifact digest is stable across a change of script dir and runtime read paths", () => {
  const base = { toolId: "t1", toolName: "t", description: "d", body: "return 1;",
    approvedHosts: ["api.example.com"], credentialHosts: [], inputSchema: { type: "object", properties: {} } } as const;
  const a = { ...base, manifest: buildGeneratedManifest("t1", { scriptDir: "/cfg/toolgen/ephemeral/t1", runtimeReadPaths: ["/opt/bun/bin"] }) };
  const b = { ...base, manifest: buildGeneratedManifest("t1", { scriptDir: "/cfg/toolgen/saved/t1", runtimeReadPaths: ["/usr/local/bun/bin", "/usr/local"] }) };
  expect(artifactDigest(a)).toBe(artifactDigest(b));
});

test("digest still changes when a security-relevant field changes", () => {
  const m = buildGeneratedManifest("t1", { scriptDir: "/cfg/x", runtimeReadPaths: [] });
  const base = { toolId: "t1", toolName: "t", description: "d", body: "return 1;",
    approvedHosts: ["api.example.com"], credentialHosts: [], inputSchema: { type: "object", properties: {} }, manifest: m } as const;
  expect(artifactDigest(base)).not.toBe(artifactDigest({ ...base, body: "return 2;" }));
  expect(artifactDigest(base)).not.toBe(artifactDigest({ ...base, approvedHosts: ["evil.example.com"] }));
  expect(artifactDigest(base)).not.toBe(artifactDigest({ ...base, credentialHosts: ["api.example.com"] }));
});
```

The second test is the **positive control**: without it, "the digest is stable" would also pass if the digest stopped depending on anything.

- [ ] **Step 8: Run the whole toolgen suite — nothing else may regress**

Run: `bun test packages/gateway/src/toolgen`
Expected: PASS. Existing create-time approval and audit-digest tests may assert digest *values*; update those fixtures, and note in the commit that ephemeral artifacts do not persist, so no stored digest is invalidated.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/toolgen/
git commit -m "feat(toolgen): sign the portable manifest, not machine-derived paths"
```

---

## Task 2: Schema V61 — `generated_tool`

**Files:**

- Create: `packages/gateway/src/index/generated-tool-v61-sql.ts`
- Create: `packages/gateway/src/toolgen/toolgen-saved-repo.ts`, `toolgen-saved-repo.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`, `packages/gateway/src/index/local-index.ts`

**Interfaces:**

- Produces:
  - `GENERATED_TOOL_V61_SQL: string`
  - `SavedToolRow` — `{ toolId, toolName, description, artifactJson, artifactDigest, signature, pubkey, approvedAt, savedAt, lastLoadedAt: number | null, disabledReason: SavedToolDisabledReason | null }`
  - `type SavedToolDisabledReason = "signature_mismatch" | "signature_missing" | "artifact_missing" | "pubkey_rotated" | "pubkey_unavailable" | "schema_invalid"`

> **`schema_invalid` is not redundant with `signature_mismatch`.** A valid signature proves the bytes
> were not tampered with; it proves nothing about their *shape*. An artifact written by a different
> build of Nimbus verifies perfectly and may still be missing a field this version requires.
> Signature verification is not schema validation, and the parse must guard (Task 4).

- `insertSavedTool(db, row): void` · `listSavedTools(db): SavedToolRow[]` · `getSavedTool(db, toolId): SavedToolRow | null` · `deleteSavedTool(db, toolId): void` · `setSavedToolDisabled(db, toolId, reason: SavedToolDisabledReason | null): void` · `touchSavedToolLoaded(db, toolId, now): void` · `repairSavedToolCache(db, toolId, { artifactJson, artifactDigest }): void`

> **Note:** `body_missing` from the spec's § 4 list is **dropped** — under the plan-level refinement `index.ts` is derived, so its absence is not a failure state. Keep the other five.

- [ ] **Step 1: Write the DDL**

`packages/gateway/src/index/generated-tool-v61-sql.ts`:

```ts
/**
 * V61 — saved (persisted) generated tools, spec § 4.
 *
 * The row governs EXISTENCE; disk plus signature governs CONTENT. A `saved/<toolId>` directory with
 * no row here is an orphan and is swept at boot — never adopted — because a valid signature proves
 * an artifact was approved ONCE, not that it is approved NOW.
 *
 * `artifact_json` is the canonical byte string that was signed, stored verbatim so verification
 * never re-canonicalises. `pubkey` is per row so a Vault rotation reports as `pubkey_rotated`
 * rather than masquerading as tampering.
 */
export const GENERATED_TOOL_V61_SQL = `
CREATE TABLE IF NOT EXISTS generated_tool (
  tool_id          TEXT PRIMARY KEY,
  tool_name        TEXT NOT NULL,
  description      TEXT NOT NULL,
  artifact_json    TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  signature        TEXT NOT NULL,
  pubkey           TEXT NOT NULL,
  approved_at      INTEGER NOT NULL,
  saved_at         INTEGER NOT NULL,
  last_loaded_at   INTEGER,
  disabled_reason  TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_generated_tool_healthy
  ON generated_tool (tool_id) WHERE disabled_reason IS NULL;
`;
```

- [ ] **Step 2: Register the migration step**

In `index/migrations/runner.ts`: add the import beside the other `*_V*_SQL` imports, then append after the V60 line:

```ts
  simpleStep(60, 61, "saved generated tools (persistence + signing)", GENERATED_TOOL_V61_SQL),
```

In `index/local-index.ts`: `export const CURRENT_SCHEMA_VERSION = 61;`

- [ ] **Step 3: Write the failing repo test** — `toolgen-saved-repo.test.ts`

Use a real in-memory SQLite via the project's existing migration helper (follow `packages/gateway/src/index/migrations/*.test.ts` for how a test DB is migrated — do **not** hand-execute the DDL, or the test stops proving the migration is registered).

```ts
test("insert then get round-trips every column", () => {
  const db = migratedTestDb();
  insertSavedTool(db, { toolId: "t1", toolName: "gitea_issues", description: "d",
    artifactJson: '{"a":1}', artifactDigest: "deadbeef", signature: "sig", pubkey: "pk",
    approvedAt: 1000, savedAt: 2000, lastLoadedAt: null, disabledReason: null });
  expect(getSavedTool(db, "t1")).toEqual({ toolId: "t1", toolName: "gitea_issues", description: "d",
    artifactJson: '{"a":1}', artifactDigest: "deadbeef", signature: "sig", pubkey: "pk",
    approvedAt: 1000, savedAt: 2000, lastLoadedAt: null, disabledReason: null });
});

test("setSavedToolDisabled writes and clears the reason", () => {
  const db = migratedTestDb();
  insertSavedTool(db, /* …as above… */);
  setSavedToolDisabled(db, "t1", "signature_mismatch");
  expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_mismatch");
  setSavedToolDisabled(db, "t1", null);
  expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
});

test("deleteSavedTool removes the row and is idempotent", () => {
  const db = migratedTestDb();
  insertSavedTool(db, /* … */);
  deleteSavedTool(db, "t1");
  expect(getSavedTool(db, "t1")).toBeNull();
  expect(() => deleteSavedTool(db, "t1")).not.toThrow();
});

test("the migration actually ran — schema version is 61", () => {
  expect(readIndexedUserVersion(migratedTestDb())).toBe(61);
});
```

That last test is the positive control: it fails if the step was never registered, which would otherwise make every other test here pass against a hand-made table.

- [ ] **Step 4: Run — expect failure**

Run: `bun test packages/gateway/src/toolgen/toolgen-saved-repo.test.ts`

- [ ] **Step 5: Implement `toolgen-saved-repo.ts`**

Every write through `dbRun`/`dbStmtRun` from `db/write.ts` (D12/I14); every value a bound parameter (I9). Follow `fleet/`'s repository files for the established row-mapping shape in this codebase.

- [ ] **Step 6: Run — expect pass. Then run the migration suite**

Run: `bun test packages/gateway/src/toolgen/toolgen-saved-repo.test.ts packages/gateway/src/index/migrations`
Expected: PASS. A migration-count or `CURRENT_SCHEMA_VERSION` assertion elsewhere may need updating — search for `60` in `packages/gateway/src/index/**` and `packages/gateway/test/**`.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/ packages/gateway/src/toolgen/
git commit -m "feat(toolgen): schema V61 generated_tool + saved-tool repository"
```

---

## Task 3: Vault Ed25519 keypair + detached signing

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-keypair.ts`, `toolgen-keypair.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`VAULT_KEY_ALLOW_LIST`, `PLATFORM_VAULT_KEYS`)

**Interfaces:**

- Consumes: `NimbusVault`; `generateEd25519Keypair`, `decodeBase64`, `encodeBase64` from `@nimbus-dev/sdk`; `nacl` from `tweetnacl`.
- Produces:
  - `TOOLGEN_SIGNING_PRIVKEY = "toolgen.signing.privkey"` · `TOOLGEN_SIGNING_PUBKEY = "toolgen.signing.pubkey"`
  - `ensureToolgenKeypair(vault): Promise<{ privkeyB64: string; pubkeyB64: string }>`
  - `signArtifact(vault, canonicalBytes: string): Promise<{ sigB64: string; pubkeyB64: string }>`
  - `verifyArtifactSignature(canonicalBytes: string, sigB64: string, pubkeyB64: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
test("sign then verify round-trips", async () => {
  const vault = new FakeVault();
  const { sigB64, pubkeyB64 } = await signArtifact(vault, "canonical-bytes");
  expect(verifyArtifactSignature("canonical-bytes", sigB64, pubkeyB64)).toBe(true);
});

test("a single changed byte fails verification", async () => {
  const vault = new FakeVault();
  const { sigB64, pubkeyB64 } = await signArtifact(vault, "canonical-bytes");
  expect(verifyArtifactSignature("canonical-bytez", sigB64, pubkeyB64)).toBe(false);
});

test("a signature from a different keypair fails", async () => {
  const a = new FakeVault();
  const b = new FakeVault();
  const signed = await signArtifact(a, "x");
  const other = await signArtifact(b, "x");
  expect(verifyArtifactSignature("x", other.sigB64, signed.pubkeyB64)).toBe(false);
});

test("malformed base64 returns false rather than throwing", () => {
  expect(verifyArtifactSignature("x", "!!!not-base64!!!", "!!!also-not!!!")).toBe(false);
});

test("the keypair is generated once and reused", async () => {
  const vault = new FakeVault();
  const first = await ensureToolgenKeypair(vault);
  const second = await ensureToolgenKeypair(vault);
  expect(second.pubkeyB64).toBe(first.pubkeyB64);
});

test("a mismatched stored pair is regenerated rather than used", async () => {
  const vault = new FakeVault();
  const good = await ensureToolgenKeypair(vault);
  const foreign = await ensureToolgenKeypair(new FakeVault());
  await vault.set(TOOLGEN_SIGNING_PUBKEY, foreign.pubkeyB64); // privkey from one pair, pubkey from another
  const fixed = await ensureToolgenKeypair(vault);
  expect(fixed.pubkeyB64).not.toBe(foreign.pubkeyB64);
  expect(verifyArtifactSignature("x", (await signArtifact(vault, "x")).sigB64, fixed.pubkeyB64)).toBe(true);
});

test("the private seed is never returned by any read-only accessor", async () => {
  const vault = new FakeVault();
  await ensureToolgenKeypair(vault);
  const { sigB64 } = await signArtifact(vault, "x");
  expect(sigB64).not.toContain((await vault.get(TOOLGEN_SIGNING_PRIVKEY)) ?? " ");
});
```

- [ ] **Step 2: Run — expect failure.** `bun test packages/gateway/src/toolgen/toolgen-keypair.test.ts`

- [ ] **Step 3: Implement `toolgen-keypair.ts`**

Copy `share/share-keypair.ts`'s structure exactly — `isValidB64Len(…, 32)`, `isMatchingKeypair`, regenerate when either value is absent, malformed, or inconsistent — then add:

```ts
export async function signArtifact(
  vault: NimbusVault,
  canonicalBytes: string,
): Promise<{ sigB64: string; pubkeyB64: string }> {
  const { privkeyB64, pubkeyB64 } = await ensureToolgenKeypair(vault);
  const kp = nacl.sign.keyPair.fromSeed(decodeBase64(privkeyB64));
  const sig = nacl.sign.detached(new TextEncoder().encode(canonicalBytes), kp.secretKey);
  return { sigB64: encodeBase64(sig), pubkeyB64 };
}

/** Pure and synchronous — no Vault access — so the boot pass verifies N artifacts against one read pubkey. */
export function verifyArtifactSignature(canonicalBytes: string, sigB64: string, pubkeyB64: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalBytes),
      decodeBase64(sigB64),
      decodeBase64(pubkeyB64),
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run — expect pass** (7 tests)

- [ ] **Step 5: Register the Vault keys in the structure audit**

`VAULT_KEY_ALLOW_LIST` gains, with this comment — the distinction from the neighbouring entry is the point:

```ts
  // The toolgen SIGNING keys, unlike `toolgen-credentials.ts`'s per-host keys directly above, are
  // STATIC literals — the audit's literal scan genuinely sees them, so this entry is real
  // enforcement rather than documentation of a keyspace the scan cannot reach.
  "packages/gateway/src/toolgen/toolgen-keypair.ts",
```

`PLATFORM_VAULT_KEYS` gains `"toolgen.signing.privkey"` and `"toolgen.signing.pubkey"`.

- [ ] **Step 6: Verify the audit is green**

Run: `bun run audit:invariants`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/toolgen/ scripts/structure-audit/
git commit -m "feat(toolgen): Vault-only Ed25519 signing keypair"
```

---

## Task 4: The saved store — the only verifying reader

D29(d)'s home. Spec § 3, § 7.

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-saved-store.ts`, `toolgen-saved-store.test.ts`

**Interfaces:**

- Consumes: `assertSafeToolId` (`toolgen-script-store.ts`), `verifyArtifactSignature` (Task 3).
- Produces:
  - `savedToolDir(configDir, toolId): string`
  - `writeSavedTool(configDir, toolId, { canonicalJson, sigB64, script }): Promise<void>`
  - `parseCanonicalArtifact(json: string): SavedArtifactFields | null` — a real guard, no type assertion
  - `SavedArtifactFields = { toolId: string; toolName: string; description: string; body: string; approvedHosts: readonly string[]; credentialHosts: readonly string[]; inputSchema: ToolInputSchema; manifest: PortableToolManifest }`
  - `readVerifiedSavedTool(configDir, toolId, pubkeyB64): Promise<{ ok: true; canonicalJson: string; artifact: SavedArtifactFields } | { ok: false; reason: SavedToolDisabledReason }>` — **the only accessor**, and it returns data that is both verified *and* well-formed
  - `removeSavedTool(configDir, toolId): Promise<void>`
  - `listSavedToolDirs(configDir): Promise<string[]>` — directory names only, for the orphan sweep
  - `rewriteSavedToolScript(configDir, toolId, script): Promise<string>` — re-emits the derived `index.ts`, returns its path

- [ ] **Step 1: Write the failing test**

```ts
test("write then read verifies", async () => {
  const dir = await tmpConfigDir();
  const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), CANON);
  await writeSavedTool(dir, "t1", { canonicalJson: CANON, sigB64, script: "// script" });
  const r = await readVerifiedSavedTool(dir, "t1", pubkeyB64);
  expect(r).toMatchObject({ ok: true, canonicalJson: CANON });
});

test("a tampered artifact.json is refused", async () => {
  /* …write, then overwrite artifact.json with CANON + " " … */
  expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({ ok: false, reason: "signature_mismatch" });
});

test("a missing artifact.sig is refused as signature_missing, distinct from a mismatch", async () => {
  /* …write, then rm artifact.sig… */
  expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({ ok: false, reason: "signature_missing" });
});

test("a missing artifact.json is refused as artifact_missing", async () => { /* … */ });

test("a signature made by a different key is refused as signature_mismatch", async () => {
  // NOT `pubkey_rotated` — see the note below this block. The store cannot tell a rotation from
  // tampering; both are "verify returned false". Task 8 owns that distinction because only the
  // caller knows whether the ROW's stored pubkey differs from the Vault's current one.
  /* sign with vault A, verify against vault B's pubkey */
  expect(await readVerifiedSavedTool(dir, "t1", otherPubkey)).toEqual({ ok: false, reason: "signature_mismatch" });
});

test("a tampered index.ts does NOT affect verification — it is derived, not signed", async () => {
  /* …write, then overwrite index.ts with "malicious()"… */
  expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toMatchObject({ ok: true, canonicalJson: CANON });
});

test("a VALIDLY SIGNED artifact with the wrong shape is refused as schema_invalid", async () => {
  // The signature verifies — this is a real artifact from a different build, not an attack.
  // Verification proves the bytes were not altered; it says nothing about their shape.
  const wrongShape = JSON.stringify({ toolId: "t1", body: "x" }); // no approvedHosts, no manifest
  const { sigB64, pubkeyB64 } = await signArtifact(new FakeVault(), wrongShape);
  await writeSavedTool(dir, "t1", { canonicalJson: wrongShape, sigB64, script: "//" });
  expect(await readVerifiedSavedTool(dir, "t1", pubkeyB64)).toEqual({ ok: false, reason: "schema_invalid" });
});

test("parseCanonicalArtifact rejects a wrong-typed field rather than coercing it", () => {
  expect(parseCanonicalArtifact(JSON.stringify({ ...VALID_FIELDS, approvedHosts: "api.example.com" }))).toBeNull();
  expect(parseCanonicalArtifact(JSON.stringify({ ...VALID_FIELDS, body: 42 }))).toBeNull();
});

test("POSITIVE CONTROL — parseCanonicalArtifact accepts a well-formed artifact", () => {
  expect(parseCanonicalArtifact(JSON.stringify(VALID_FIELDS))).not.toBeNull();
});

test("removeSavedTool is idempotent", async () => { /* remove twice, no throw */ });

test("listSavedToolDirs returns directory names only", async () => { /* … */ });

test("an unsafe tool id is refused before touching the filesystem", async () => {
  await expect(writeSavedTool(dir, "../escape", { canonicalJson: CANON, sigB64: "s", script: "" })).rejects.toThrow();
});
```

> `pubkey_rotated` vs `signature_mismatch` cannot be distinguished by cryptography alone — both are "verify returned false". Distinguish them at the **caller** (Task 8), which knows whether the row's stored `pubkey` differs from the Vault's current one. In the store, return `signature_mismatch`; Task 8 upgrades it to `pubkey_rotated` when the pubkeys differ. Write the store test accordingly and move the `pubkey_rotated` assertion to Task 8.

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `toolgen-saved-store.ts`**

- `savedToolDir` = `join(configDir, "toolgen", "saved", toolId)` after `assertSafeToolId`, using module constants (`STORE_DIR`/`SAVED_DIR`) exactly as the ephemeral store does.
- `writeSavedTool` → `mkdir(dir, { recursive: true, mode: 0o700 })`, then three `writeFile(..., { mode: 0o600 })` calls. **Write `artifact.sig` LAST** — a crash mid-write then leaves an unverifiable directory that the sweep or the `signature_missing` path handles, rather than a signed-but-incomplete one.
- `readVerifiedSavedTool` reads `artifact.json` as **bytes → utf8 string** and verifies over that exact string. Never re-canonicalise.
- Add a file-level docstring naming D29(d) and stating that no unverified accessor may be added.

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/toolgen/
git commit -m "feat(toolgen): saved-tool store with a single verifying accessor"
```

---

## Task 5: Close the ephemeral credential leak

Spec § 8.1–8.2. **Independently valuable — it fixes a shipped defect and does not depend on save existing.**

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-credential-sweep.ts`, `toolgen-credential-sweep.test.ts`
- Modify: `packages/gateway/src/ipc/toolgen-rpc.ts`, `packages/gateway/src/gateway-main.ts`, `packages/gateway/src/platform/assemble.ts`
- Test: `packages/gateway/src/ipc/toolgen-rpc.test.ts`, `packages/gateway/src/gateway-main.test.ts`

**Interfaces:**

- Consumes: `VaultLister`/`VaultDeleter`; `toolCredentialKey` (`toolgen-credentials.ts`).
- Produces:
  - `sweepToolgenCredentials(vault: NimbusVault): Promise<number>` — deletes every `toolgen.`-prefixed key except `toolgen.signing.*`; returns the count.
  - `deleteCredentialsForTool(vault, toolId, hosts): Promise<void>` — re-exported from `toolgen-credentials.ts`'s existing per-host delete.

- [ ] **Step 1: Write the failing test**

```ts
test("sweeps every per-host credential", async () => {
  const vault = new FakeVault();
  await vault.set(toolCredentialKey("t1", "api.example.com"), '{"type":"bearer","token":"x"}');
  await vault.set(toolCredentialKey("t2", "other.example.com"), '{"type":"bearer","token":"y"}');
  expect(await sweepToolgenCredentials(vault)).toBe(2);
  expect(await vault.get(toolCredentialKey("t1", "api.example.com"))).toBeNull();
});

test("RETAINS the signing keypair — sweeping it would orphan every saved tool", async () => {
  const vault = new FakeVault();
  await ensureToolgenKeypair(vault);
  await vault.set(toolCredentialKey("t1", "api.example.com"), "{}");
  await sweepToolgenCredentials(vault);
  expect(await vault.get(TOOLGEN_SIGNING_PRIVKEY)).not.toBeNull();
  expect(await vault.get(TOOLGEN_SIGNING_PUBKEY)).not.toBeNull();
});

test("leaves non-toolgen keys untouched", async () => {
  const vault = new FakeVault();
  await vault.set("github.pat", "ghp_x");
  await sweepToolgenCredentials(vault);
  expect(await vault.get("github.pat")).toBe("ghp_x");
});

test("sweeps a crash-orphaned key for a tool that no longer exists anywhere", async () => {
  const vault = new FakeVault();
  await vault.set(toolCredentialKey("gone", "api.example.com"), "{}");
  expect(await sweepToolgenCredentials(vault)).toBe(1);
});
```

And in `toolgen-rpc.test.ts` — the defect this task exists for:

```ts
test("toolgen.revoke deletes the Vault credential, not just the child and the script", async () => {
  /* register a tool with a bound credential for api.example.com, then: */
  await dispatch("toolgen.revoke", { toolId: "t1" });
  expect(await vault.get(toolCredentialKey("t1", "api.example.com"))).toBeNull();
});
```

- [ ] **Step 2: Run — expect failure.** The `revoke` test must fail **against current `main`**; that failure is the proof the leak is real.

- [ ] **Step 3: Implement the sweep**

```ts
const SIGNING_PREFIX = "toolgen.signing.";

/**
 * Delete every per-host generated-tool credential, retaining only the signing keypair.
 *
 * TOTAL by design (spec § 8.2): because no saved tool carries a credential across sessions, there is
 * no "keep the saved ones" set to compute. A selective sweep would have to join Vault keys against
 * `generated_tool` rows — more code, and a place for a saved tool's credential to survive a restart
 * in contradiction of I40.
 */
export async function sweepToolgenCredentials(vault: NimbusVault): Promise<number> {
  const keys = await vault.listKeys("toolgen.");
  let n = 0;
  for (const key of keys) {
    if (key.startsWith(SIGNING_PREFIX)) continue;
    await vault.delete(key);
    n++;
  }
  return n;
}
```

- [ ] **Step 4: Wire the three call sites**

1. `ipc/toolgen-rpc.ts` — `toolgen.revoke` gains a third half. Update the "BOTH halves, always" comment to say **three**, and name what the third one is:

```ts
    await ctx.gateDeps.registry.revoke(toolId);
    await ctx.removeScript(toolId);
    // The THIRD half. Until PR 3 this was missing: a revoked tool's per-host Vault bindings
    // outlived both the tool and the gateway, keyed to a toolId nothing would ever call again.
    await ctx.revokeCredentialsForTool(toolId);
```

Resolve the tool's hosts from the registry envelope **before** `registry.revoke` removes it.

1. `gateway-main.ts` — after `removeAllToolScripts`, add `await deps.sweepToolgenCredentials()`. Follow the existing dep-injection shape; `gateway-main.test.ts` already asserts call **order**, so extend that assertion rather than adding a parallel one.

2. `platform/assemble.ts` — call the sweep once at boot, before the registry is populated.

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/gateway/src/toolgen packages/gateway/src/ipc/toolgen-rpc.test.ts packages/gateway/src/gateway-main.test.ts`

- [ ] **Step 6: Red-prove** — revert the `toolgen-rpc.ts` change, confirm the revoke test fails, restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/
git commit -m "fix(toolgen): sweep per-host Vault credentials on revoke, boot and shutdown"
```

---

## Task 6: Broker refuses an unbound credentialed host

Spec § 8.3. Also a shipped-defect fix: `handleFetch` currently proceeds unauthenticated on a `null` binding, which the file's own comment already argues it must not do.

**Files:**

- Modify: `packages/gateway/src/toolgen/toolgen-broker.ts`, `toolgen-broker.test.ts`, `platform/assemble.ts`

**Interfaces:**

- Produces: `ToolgenBrokerDeps.credentialHostsFor: (toolId: string) => readonly string[]` — same shape as the existing `approvedHostsFor`.

- [ ] **Step 1: Write the failing test**

```ts
test("refuses a fetch to a credentialHosts host with no binding, and makes NO request", async () => {
  let fetched = 0;
  const broker = makeBroker({
    credentialHostsFor: () => ["api.example.com"],
    readCredential: async () => null,
    doFetch: async () => { fetched++; return new Response("{}"); },
  });
  const res = await broker.handleFetch("t1", { url: "https://api.example.com/x", method: "GET", headers: {} });
  expect(res.error?.code).toBe("ERR_TOOLGEN_CREDENTIAL_REQUIRED");
  expect(fetched).toBe(0); // a refusal that still hits the network is the bug wearing a new exit code
});

test("the refusal appends a blocked tool-class egress row", async () => {
  /* …as above… */
  const rows = db.query("SELECT result_status FROM egress_ledger WHERE source_type = 'tool'").all();
  expect(rows).toEqual([{ result_status: "blocked" }]);
});

test("POSITIVE CONTROL — the same host WITH a binding succeeds and carries the header", async () => {
  let seen: Record<string, string> = {};
  const broker = makeBroker({
    credentialHostsFor: () => ["api.example.com"],
    readCredential: async () => ({ type: "bearer", token: "tok" }),
    doFetch: async (_u, init) => { seen = init.headers as Record<string, string>; return new Response("{}"); },
  });
  await broker.handleFetch("t1", { url: "https://api.example.com/x", method: "GET", headers: {} });
  expect(seen["Authorization"]).toBe("Bearer tok");
});

test("a host NOT in credentialHosts with no binding proceeds uncredentialed — the deliberate asymmetry", async () => {
  let fetched = 0;
  const broker = makeBroker({
    approvedHostsFor: () => ["public.example.com"],
    credentialHostsFor: () => [],
    readCredential: async () => null,
    doFetch: async () => { fetched++; return new Response("{}"); },
  });
  const res = await broker.handleFetch("t1", { url: "https://public.example.com/x", method: "GET", headers: {} });
  expect(res.error).toBeUndefined();
  expect(fetched).toBe(1);
});
```

- [ ] **Step 2: Run — expect the first three to fail** (the fourth passes today, which is correct: it pins behaviour that must not change).

- [ ] **Step 3: Implement**

In `toolgen-broker.ts`, immediately after the existing `readCredential` try/catch and **before** `ledger("authorized")`:

```ts
    // A host the owner was TOLD would carry a credential must never be reached without one. Before
    // PR 3 a null binding fell through to `if (binding !== null)` below and the request went out
    // unauthenticated — reachable on every restart once saved tools stopped carrying credentials
    // across sessions (I40). The asymmetry is deliberate: a host outside `credentialHosts` is
    // uncredentialed BY DESIGN and still proceeds.
    if (binding === null && this.#deps.credentialHostsFor(toolId).some((h) => h.toLowerCase() === host)) {
      return refuse(
        ERR_TOOLGEN_CREDENTIAL_REQUIRED,
        `${host} requires a credential binding and none is set; run: nimbus tool credential set ${toolId} ${host} --bearer <token>`,
      );
    }
    if (binding !== null) applyCredential(headers, binding);
```

`refuse(...)` already appends the `blocked` row — confirm by reading its definition rather than assuming, and if it does not, append before returning.

Wire `credentialHostsFor` in `platform/assemble.ts` from the registry envelope's `artifact.credentialHosts`, mirroring how `approvedHostsFor` is wired.

- [ ] **Step 4: Run — expect all four to pass**

- [ ] **Step 5: Red-prove** — revert the new block, confirm tests 1–2 fail, restore.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/toolgen/ packages/gateway/src/platform/
git commit -m "fix(toolgen): refuse a brokered fetch to an unbound credentialed host"
```

---

## Task 7: The save gate

Spec § 6, § 6.1.

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-save-gate.ts`, `toolgen-save-gate.test.ts`
- Modify: `toolgen-consent-broker.ts`, `engine/executor.ts` (`HITL_REQUIRED_BACKING`)

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces:
  - `ToolgenSaveApprovalInput` = `ToolgenApprovalInput` fields **plus** `readonly persistence: true`
  - `saveGeneratedTool(req: { toolId: string }, deps: ToolgenSaveDeps): Promise<ToolgenSaveOutcome>`
  - `type ToolgenSaveOutcome = { status: "saved"; toolId: string } | { status: "already_saved"; toolId: string } | { status: "repaired"; toolId: string } | { status: "denied" } | { status: "refused"; code: string }`

- [ ] **Step 1: Add `tool.save` to the HITL frozen set**

`engine/executor.ts`'s `HITL_REQUIRED_BACKING` gains `"tool.save"`. The I2 membership test asserts a **count** — update it in the same commit.

- [ ] **Step 2: Write the failing gate test**

Order matters more than any individual check; test it as an order.

```ts
test("refuses when the capability is disabled by config — WITHOUT prompting", async () => {
  let prompted = 0;
  const out = await saveGeneratedTool({ toolId: "t1" }, deps({ enabled: false, requestApproval: async () => { prompted++; return true; } }));
  expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
  expect(prompted).toBe(0); // a disabled capability must not advertise itself by prompting
});

test("refuses when org policy disables tool_generation — still without prompting", async () => { /* … */ });

test("refuses fail-closed when the policy accessor is ABSENT", async () => {
  const out = await saveGeneratedTool({ toolId: "t1" }, deps({ capabilitiesDisabled: undefined }));
  expect(out).toEqual({ status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" });
});

test("refuses a terminated tool", async () => { /* registry.isTerminated -> true */ });
test("refuses an unknown tool id", async () => { /* ERR_TOOLGEN_SAVE_NOT_LIVE */ });

test("a denied approval writes NOTHING — no row, no files", async () => {
  const out = await saveGeneratedTool({ toolId: "t1" }, deps({ requestApproval: async () => false }));
  expect(out).toEqual({ status: "denied" });
  expect(getSavedTool(db, "t1")).toBeNull();
  expect(existsSync(savedToolDir(cfg, "t1"))).toBe(false);
});

test("an approval TIMEOUT is treated as a denial", async () => { /* broker rejects on TTL */ });

test("a successful save writes the row and the files, and the artifact verifies", async () => {
  const out = await saveGeneratedTool({ toolId: "t1" }, deps());
  expect(out).toEqual({ status: "saved", toolId: "t1" });
  const row = getSavedTool(db, "t1");
  expect(row?.disabledReason).toBeNull();
  const pub = (await ensureToolgenKeypair(vault)).pubkeyB64;
  expect(await readVerifiedSavedTool(cfg, "t1", pub)).toMatchObject({ ok: true });
});

test("the approved bytes ARE the signed bytes", async () => {
  let approvedBody = "";
  await saveGeneratedTool({ toolId: "t1" }, deps({ requestApproval: async (i) => { approvedBody = i.body; return true; } }));
  const { canonicalJson } = (await readVerifiedSavedTool(cfg, "t1", pub)) as { canonicalJson: string };
  expect(JSON.parse(canonicalJson).body).toBe(approvedBody);
});

test("the prompt discloses persistence — it is a different grant from create", async () => {
  let input: ToolgenSaveApprovalInput | undefined;
  await saveGeneratedTool({ toolId: "t1" }, deps({ requestApproval: async (i) => { input = i; return true; } }));
  expect(input?.persistence).toBe(true);
});

test("saving an UNCHANGED tool twice returns already_saved and prompts ONCE", async () => {
  let prompts = 0;
  const d = deps({ requestApproval: async () => { prompts++; return true; } });
  await saveGeneratedTool({ toolId: "t1" }, d);
  expect(await saveGeneratedTool({ toolId: "t1" }, d)).toEqual({ status: "already_saved", toolId: "t1" });
  expect(prompts).toBe(1);
});

test("saving after the artifact CHANGED prompts again", async () => {
  let prompts = 0;
  const d = deps({ requestApproval: async () => { prompts++; return true; } });
  await saveGeneratedTool({ toolId: "t1" }, d);
  d.registry.register(envelopeWithBody("return 2;"), async () => {});
  await saveGeneratedTool({ toolId: "t1" }, d);
  expect(prompts).toBe(2); // else the standing approval widens to bytes nobody approved
});

test("a save does NOT kill the running child", async () => {
  let closed = 0;
  const d = deps({ registryClose: async () => { closed++; } });
  await saveGeneratedTool({ toolId: "t1" }, d);
  expect(closed).toBe(0);
});

test("a DISABLED row with a matching digest is REPAIRED, not reported already_saved", async () => {
  let prompts = 0;
  const d = deps({ requestApproval: async () => { prompts++; return true; } });
  await saveGeneratedTool({ toolId: "t1" }, d);
  await rm(join(savedToolDir(cfg, "t1"), "artifact.sig"));       // corrupt the disk
  await reconcileSavedTools(d);                                   // boot disables it
  expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_missing");

  expect(await saveGeneratedTool({ toolId: "t1" }, d)).toEqual({ status: "repaired", toolId: "t1" });
  expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
  expect(await readVerifiedSavedTool(cfg, "t1", pub)).toMatchObject({ ok: true });
  expect(prompts).toBe(1); // the bytes were already approved; a second prompt buys nothing
});
```

That last test is the one this task exists to keep honest: without it, a disabled tool is
unrepairable through any user-facing path and the failure is invisible from every unit test above.

- [ ] **Step 3: Run — expect failure**

- [ ] **Step 4: Implement `toolgen-save-gate.ts`**

Follow `createGeneratedTool`'s existing structure in `toolgen-gate.ts`. Exact order:

```text
1. config enabled?            -> ERR_TOOLGEN_SAVE_DISABLED   (before consent)
2. policy allows?             -> ERR_TOOLGEN_SAVE_DISABLED   (before consent; fail-closed if accessor absent)
3. live + non-terminated?     -> ERR_TOOLGEN_SAVE_NOT_LIVE
4. artifact from the ENVELOPE (never re-read from disk)
5. canonical = canonicalArtifactBytes(artifact); digest = artifactDigest(artifact)
6. existing row, same digest, AND disabled_reason IS NULL? -> { status: "already_saved" }, no prompt
   existing row, same digest, but DISABLED?               -> repair: re-sign, rewrite disk, clear
                                                             disabled_reason. NO re-prompt.
7. approval (persistence: true)       -> denied/TTL => { status: "denied" }, write nothing
8. signArtifact -> writeSavedTool -> insertSavedTool (in that order)
9. audit `tool.save` on EVERY outcome
```

**Why the disabled branch repairs without re-prompting.** The digest matching means the live
artifact is byte-identical to what the owner already approved for persistence. The prompt exists to
bind an approval to specific bytes; those bytes have not changed, so a second prompt buys no
security and spends the owner's attention — which is the resource every HITL gate is really
rationing. What it *must* do is disclose: the CLI reports `repaired` rather than silently reporting
success, so an owner whose tool was disabled learns that it was.

Without the `disabled_reason IS NULL` clause, a tool disabled at boot by a corrupt or missing
artifact is **permanently unrepairable through the UI** — `nimbus tool save` would return
`already_saved` forever while the tool stays dead. Add `{ status: "repaired", toolId }` to
`ToolgenSaveOutcome`.

Keep the ordered list readable as an ordered list at the call site — split by phase into named steps if it grows, never by hiding a check in a helper a reader has to go find (the I35 complexity lesson).

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/toolgen/ packages/gateway/src/engine/
git commit -m "feat(toolgen): the save gate — refusals before consent, persistence approved separately"
```

---

## Task 8: Boot reconciliation + orphan sweep

Spec § 7.1.

**Files:**

- Create: `packages/gateway/src/toolgen/toolgen-boot-reconcile.ts`, `toolgen-boot-reconcile.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`

**Interfaces:**

- Produces: `reconcileSavedTools(deps: { db; configDir; vault; logger }): Promise<{ verified: number; disabled: number; sweptOrphans: number }>`

- [ ] **Step 1: Write the failing test**

```ts
test("a healthy saved tool verifies and stays enabled", async () => { /* verified: 1, disabled: 0 */ });

test("a tampered artifact is disabled with signature_mismatch", async () => {
  await corruptArtifactJson(cfg, "t1");
  await reconcileSavedTools(d);
  expect(getSavedTool(db, "t1")?.disabledReason).toBe("signature_mismatch");
});

test("a rotated Vault keypair reports pubkey_rotated, NOT signature_mismatch", async () => {
  await vault.delete(TOOLGEN_SIGNING_PRIVKEY);
  await vault.delete(TOOLGEN_SIGNING_PUBKEY);
  await ensureToolgenKeypair(vault); // fresh pair
  await reconcileSavedTools(d);
  expect(getSavedTool(db, "t1")?.disabledReason).toBe("pubkey_rotated");
});

test("a missing artifact.json disables with artifact_missing", async () => { /* … */ });

test("ORPHAN: a validly-signed saved/ directory with NO row is SWEPT, not adopted", async () => {
  await writeSavedTool(cfg, "orphan", { canonicalJson: CANON, sigB64: validSig, script: "//" });
  const r = await reconcileSavedTools(d);
  expect(r.sweptOrphans).toBe(1);
  expect(existsSync(savedToolDir(cfg, "orphan"))).toBe(false);
  expect(getSavedTool(db, "orphan")).toBeNull(); // never adopted
});

test("the row's cached digest is REPAIRED when disk disagrees but verifies", async () => {
  db.exec("UPDATE generated_tool SET artifact_digest = 'stale' WHERE tool_id = 't1'");
  await reconcileSavedTools(d);
  expect(getSavedTool(db, "t1")?.artifactDigest).not.toBe("stale");
  expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
});

test("reconciliation spawns NOTHING", async () => {
  let spawns = 0;
  await reconcileSavedTools({ ...d, spawn: () => { spawns++; } });
  expect(spawns).toBe(0);
});

test("a previously-disabled tool is RE-ENABLED once its artifact verifies again", async () => {
  setSavedToolDisabled(db, "t1", "signature_mismatch");
  await reconcileSavedTools(d);
  expect(getSavedTool(db, "t1")?.disabledReason).toBeNull();
});
```

The orphan test is the one that must not be softened: it writes a **valid** signature, so a pass proves the sweep is driven by the missing row rather than by a failed check.

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```text
pass 1 — rows:
  read the current Vault pubkey once
  for each row:
    r = readVerifiedSavedTool(configDir, row.toolId, currentPubkey)
    ok      -> clear disabled_reason; repair cached digest if it differs; verified++
    !ok     -> reason = (r.reason === "signature_mismatch" && row.pubkey !== currentPubkey)
                 ? "pubkey_rotated" : r.reason
               setSavedToolDisabled(db, row.toolId, reason); disabled++
  (pubkey absent from the Vault entirely -> "pubkey_unavailable" for every row)

pass 2 — orphans:
  for each dir in listSavedToolDirs(configDir):
    if no row -> removeSavedTool(configDir, dir); sweptOrphans++
```

Wire into `platform/assemble.ts` at boot, **after** the credential sweep (Task 5) and before the registry is populated.

Give `toolgen-boot-reconcile.ts` a file-level docstring recording the authority split and its cost, so pass 2 does not read as an over-eager cleanup to someone finding it later:

```ts
/**
 * Boot reconciliation for saved generated tools (spec § 7.1).
 *
 * The `generated_tool` ROW is the root of existence: it is the durable record that an owner
 * approved persistence for this tool. Pass 2 therefore sweeps any `saved/<toolId>` directory with
 * no row, mirroring `extensions/verify-extensions.ts`'s `sweepOrphanActiveDirsBestEffort` — a
 * directory is never adopted, because a valid signature proves an artifact was approved ONCE, not
 * that it is approved NOW. Adopting orphans would let a restored backup, or a copy of a tool the
 * owner deliberately revoked, silently re-register a standing execution capability.
 *
 * STATED COST: losing the database sweeps every saved tool. That is correct rather than
 * unfortunate — what was lost is the record of approval, so the approval is gone with it and the
 * owner re-saves. Do not "fix" this by adopting signed directories.
 */
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/toolgen/ packages/gateway/src/platform/
git commit -m "feat(toolgen): boot reconciliation — verify rows, sweep orphan directories"
```

---

## Task 9: Registry saved collection + verify-at-spawn

Spec § 7, § 7.2.

**Files:**

- Modify: `toolgen-registry.ts`, `toolgen-registry.test.ts`, `toolgen-agent-tools.ts`, `platform/assemble.ts`

**Interfaces:**

- Produces:
  - `ToolgenRegistry.registerSaved(envelope: SavedToolEnvelope): void`
  - `ToolgenRegistry.savedTools(): SavedToolEnvelope[]`
  - `SavedToolEnvelope = { artifact: GeneratedToolArtifact; toolId: string; needsCredentials: boolean }`
  - `forSession(sessionId)` returns ephemeral-for-session **∪** saved
  - `countForSession(sessionId)` **unchanged** — ephemeral only

`ToolgenEnvelope.sessionId` stays **required**; saved tools live in a separate map (spec § 7.2 rejects making it optional).

- [ ] **Step 1: Write the failing test**

```ts
test("a saved tool is visible from a session that did not create it", () => {
  const r = new ToolgenRegistry();
  r.registerSaved(savedEnvelope("t1"));
  expect(r.forSession("some-other-session").map((e) => e.artifact.toolId)).toContain("t1");
});

test("saved tools do NOT consume the per-session creation budget", () => {
  const r = new ToolgenRegistry();
  r.registerSaved(savedEnvelope("s1"));
  r.registerSaved(savedEnvelope("s2"));
  r.registerSaved(savedEnvelope("s3"));
  expect(r.countForSession("cli")).toBe(0); // else saving 3 tools permanently disables creation
});

test("ephemeral tools remain session-scoped", () => {
  const r = new ToolgenRegistry();
  r.register(envelope("e1", "session-a"), async () => {});
  expect(r.forSession("session-b").map((e) => e.artifact.toolId)).not.toContain("e1");
});

test("a saved tool needing credentials is still LISTED but flagged", () => { /* needsCredentials: true */ });

test("spawn re-verifies: a tool tampered with AFTER boot refuses at spawn", async () => {
  await reconcileSavedTools(d);            // green at boot
  await corruptArtifactJson(cfg, "t1");    // tampered afterwards
  await expect(spawnSavedTool("t1")).rejects.toThrow(/ERR_TOOLGEN_SIGNATURE_INVALID/);
});

test("spawn rebuilds index.ts from the VERIFIED body, so a tampered index.ts never executes", async () => {
  await writeFile(join(savedToolDir(cfg, "t1"), "index.ts"), "throw new Error('malicious')");
  const path = await spawnSavedTool("t1");
  expect(await readFile(path, "utf8")).not.toContain("malicious");
});

test("spawn asserts the reconstructed manifest against the signed shape", async () => {
  await expect(spawnSavedTool("t1", { runtimeReadPaths: ["/etc"], expectedRead: ["/cfg"] }))
    .rejects.toThrow(/ERR_TOOLGEN_MANIFEST_SHAPE_INVALID/);
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

- A second private map `#saved` on the registry; `forSession` concatenates; `countForSession` untouched.
- A spawn path in `toolgen-saved-spawn.ts`. **The envelope it hands to `buildToolSpawnSpec` must carry the CONCRETE manifest**, not the portable one from the artifact — `buildToolSpawnSpec` passes `envelope.artifact.manifest` straight into `wrapServerSpec` (`toolgen-client.ts:48-56`), and a `PortableToolManifest` has no `permissions` at all, so the sandbox would be configured from `undefined`:

```ts
export async function spawnSavedTool(toolId: string, deps: SavedSpawnDeps): Promise<GeneratedToolHandle> {
  const verified = await deps.readVerifiedSavedTool(deps.configDir, toolId, deps.pubkeyB64);
  if (!verified.ok) {
    throw new ToolgenError(ERR_TOOLGEN_SIGNATURE_INVALID, `saved tool ${toolId} failed verification: ${verified.reason}`);
  }
  const fields = verified.artifact; // already schema-guarded by the store — never JSON.parse here

  const savedDir = deps.savedToolDir(deps.configDir, toolId);
  const runtimeReadPaths = deps.runtime.requiredReadPaths();

  // Rebuild the CONCRETE manifest from code, then prove it still satisfies what was signed.
  const manifest = buildGeneratedManifest(toolId, { scriptDir: savedDir, runtimeReadPaths });
  assertConcreteManifestMatches(manifest, fields.manifest, [savedDir, ...runtimeReadPaths]);

  // Re-emit the derived script from the VERIFIED body — never read index.ts back and trust it.
  const scriptPath = await deps.rewriteSavedToolScript(deps.configDir, toolId, emitToolScript({
    toolId, toolName: fields.toolName, description: fields.description,
    body: fields.body, inputSchema: fields.inputSchema,
  }));

  return deps.spawn({
    artifact: { ...fields, manifest },   // concrete manifest, for wrapServerSpec
    sessionId: deps.sessionId,           // the CALLER's session — see below
    scriptPath,
    approvedAt: deps.row.approvedAt,     // from generated_tool, not invented
  });
}
```

Two details the review's sketch got wrong, both worth stating so they are not reintroduced:

- **No `sessionId: "saved"` sentinel.** A magic session string collides with `forSession`'s filter and would make the saved tool visible to exactly one fictional session. `ToolgenEnvelope.sessionId` here is the *spawning caller's* session — the registry's `#saved` map is what makes the tool globally visible, not a value smuggled into this field.
- **`approvedAt` comes from the row, not the artifact.** It lives on `ToolgenEnvelope`, not on `GeneratedToolArtifact`, and is therefore not in the canonical JSON at all — so `rawArtifact.approvedAt ?? now()` would silently stamp every spawn with the current time and quietly destroy the record of when the owner actually approved it.
- `buildGeneratedTools` (`toolgen-agent-tools.ts`) needs no change if `forSession` unions — but **assert that**, since it is the surface the model sees. A saved tool that fails verification must be absent from the returned object entirely, not present-and-erroring.

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/toolgen/ packages/gateway/src/platform/
git commit -m "feat(toolgen): saved tools visible to every session; verify and rebuild at spawn"
```

---

## Task 10: IPC + CLI surface

Spec § 9.

**Files:**

- Modify: `ipc/toolgen-rpc.ts`, `toolgen-rpc.test.ts`, `packages/cli/src/commands/tool.ts`, `tool.test.ts`

**Interfaces:**

- Produces: `toolgen.save({ toolId })` → `ToolgenSaveOutcome`; `toolgen.list` entries gain `{ saved: boolean; needsCredentials: boolean; disabledReason: string | null }`; `toolgen.credentialSet({ toolId, host, binding })`.

- [ ] **Step 1: Write the failing tests**

```ts
// IPC
test("toolgen.save dispatches to the save gate and returns its outcome", async () => { /* … */ });
test("toolgen.list includes saved tools regardless of the caller's sessionId", async () => { /* … */ });
test("toolgen.credentialSet refuses a host outside the signed credentialHosts", async () => {
  await expect(dispatch("toolgen.credentialSet", { toolId: "t1", host: "evil.com", binding: { type: "bearer", token: "x" } }))
    .rejects.toThrow(/ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN/);
});
test("toolgen.credentialSet accepts a host that IS in credentialHosts", async () => { /* positive control */ });
test("the whole toolgen namespace stays LAN-forbidden", () => {
  for (const m of ["toolgen.save", "toolgen.credentialSet"]) expect(checkLanMethodAllowed(m)).toBe(false);
});

// CLI
test("nimbus tool save <id> calls toolgen.save", async () => { /* … */ });
test("nimbus tool save with no id exits non-zero with usage", async () => { /* … */ });
test("nimbus tool credential set is no longer a refusal stub", async () => { /* … */ });
test("nimbus tool list marks saved vs ephemeral and shows needs-credentials", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

- IPC handlers follow the existing `toolgen.*` shape in `ipc/toolgen-rpc.ts`. **Do not** add these to the Tauri allowlist; **do not** change the `ALLOWED_METHODS` count.
- **`toolgen.credentialSet` must run its host through `normalizeHost`** (exported from `toolgen-gate.ts:40`) *before* testing membership of `credentialHosts` **and** before composing the Vault key — one normalisation, used for both. `credentialHosts` holds normalised names, so a user typing `API.example.com`, `https://api.example.com/v1` or `api.example.com:443` would otherwise be refused for a host they legitimately own.

  This exact mismatch has already cost this file once: `toolgen-gate.ts:293-294` records that normalising in one place while forwarding the raw value in another "split one host into two names and broke three things at once." Normalise once, then use only the normalised value. The error message should name **both** forms, so a refused owner can see what their input became:

```ts
const host = normalizeHost(requireString(params, "host"));
if (!credentialHosts.includes(host)) {
  throw new ToolgenError(ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN,
    `host "${raw}" (normalised: ${host}) is not among this tool's approved credential hosts: [${credentialHosts.join(", ")}]`);
}
```

  Test both the refusal **and** that `API.EXAMPLE.COM` is *accepted* for a tool whose `credentialHosts` holds `api.example.com` — without that positive control, "refuses unknown hosts" passes for an implementation that refuses everything.

- CLI: extend `ParsedToolArgs` with `{ sub: "save"; toolId: string }`; add the `case "save":` branch; update `USAGE`. Unknown subcommands must keep **throwing** (existing behaviour, deliberate).
- Replace `credential set`'s refusal stub with a real call. Its `--bearer` / `--header` / `--basic` parser already exists — this is what puts `header` and `basic` on a user-facing path for the first time.

- [ ] **Step 4: Run — expect pass.** Also `bun run audit:readme-cli` if the CLI registry is drift-checked.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/ packages/cli/src/
git commit -m "feat(toolgen): nimbus tool save + a real credential set"
```

---

## Task 11: Invariant I40, static rule D29(d), docs — one commit

The triple rule: wiring + docs + enforcement test together.

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`, `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`

- [ ] **Step 1: Write the D29(d) rule**

Key on **identifiers, not path text**. The reviewed regex form (`/toolgen[\\/]saved/`) matches nothing — the store composes from constants — and a guard that cannot fire reports green forever.

```ts
const D29D_STORE = "packages/gateway/src/toolgen/toolgen-saved-store.ts";
const D29D_ALLOWED_CALLERS = new Set([D29D_STORE, "packages/gateway/src/toolgen/toolgen-boot-reconcile.ts"]);
// Written as what CANNOT pass: any file outside the allow-list naming the store's private path
// constant or a non-verifying read accessor. `readVerifiedSavedTool` is deliberately NOT matched —
// it is the sanctioned door.
const D29D_FORBIDDEN = /\b(SAVED_STORE_DIR|readSavedToolUnverified|rawSavedArtifact)\b/;
```

State the bound in the rule's own comment: a dynamically assembled path still evades a text scan, so capability confinement (only the store module is handed the saved path) is the real defense — exactly as D27(b) says of `media_grant`.

- [ ] **Step 2: Add the must-fail fixture**

Assert the rule reports a violation for a synthetic file containing a forbidden identifier. **Without this the rule's green is indistinguishable from the rule matching nothing** — the precise failure the reviewed version would have shipped.

- [ ] **Step 3: Add the I40 enforcement test** in `security-invariants.test.ts`

```ts
test("I40: readVerifiedSavedTool is the ONLY exported accessor for a saved artifact", () => { /* … */ });
test("I40: a saved artifact failing verification is not offered to the model", () => { /* … */ });
test("I40: tool.save is in the HITL frozen set", () => {
  expect(HITL_REQUIRED_BACKING.has("tool.save")).toBe(true);
});
test("I40: no saved tool retains a credential across a sweep", async () => { /* … */ });
```

- [ ] **Step 4: Write the `docs/SECURITY-INVARIANTS.md` I40 section**

Use spec § 10's draft text verbatim, **including the residual** — *this defends the filesystem-write attacker, not the Vault-read attacker* — and § 2's corrected reasoning (hash verification trusts the DB; a signature trusts only the Vault). Do **not** reproduce the parent spec's "nothing detects tampering" claim; it is false, and overstating this is the failure mode the air-gap claim already cost once.

- [ ] **Step 5: Run**

Run: `bun run audit:invariants && bun test packages/gateway/src/security-invariants.test.ts`

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/ packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md
git commit -m "feat(toolgen): invariant I40 + static rule D29(d)"
```

---

## Task 12: Cross-platform integration test + ledger correction

**Files:**

- Create: `packages/gateway/test/integration/toolgen/toolgen-saved-spawn.test.ts`
- Modify: `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`, `docs/CHANGELOG.md`, the parent spec's § 10

- [ ] **Step 1: Write the per-platform spawn test**

This is the test the ephemeral-path bug would have failed, and unit fakes cannot reproduce it — the failure was an OS-level access denial.

```ts
test("a saved tool spawns and answers in a gateway that never saw its create", async () => {
  /* save in gateway A -> shut it down -> boot gateway B on the same configDir
     -> reconcile -> invoke the saved tool -> assert a real result */
});

test("REGRESSION: a changed runtime read path does not break a saved tool", async () => {
  /* save, then reconcile with a DIFFERENT requiredReadPaths(), then spawn.
     Fails against the rejected "sign the concrete manifest" design; passes against this one. */
});

test("the saved script never carries a network grant", async () => {
  /* assert the reconstructed manifest's permissions.network is [] */
});
```

Follow `test/integration/toolgen/toolgen-draft-e2e.test.ts` for harness shape. Do **not** `skipIf` a platform — a skipped test never runs locally and CI is its first execution.

- [ ] **Step 2: Run on this OS, then Linux**

Run: `bun test packages/gateway/test/integration/toolgen`
Then: `bun run verify:docker --changed`

- [ ] **Step 3: Re-ledger the delivery split** (spec § 12)

Correct in all four places — `CLAUDE.md` and `GEMINI.md` are mirrors and must both change or they drift:

- The parent spec's § 10: PR 2 shipped **drafting**, not agent-initiated.
- `docs/roadmap.md`'s toolgen row: closes on **owner-initiated** persistence; agent-initiated becomes a named, reason-recorded deferral, the treatment fleet PR 2b and the screen lane received.
- `CLAUDE.md` + `GEMINI.md`: invariants now run **through I40** (I28 still reserved); schema **V61**; the S2 toolgen row.
- `docs/CHANGELOG.md`.

- [ ] **Step 4: Full preflight**

Run: `bun run preflight`
Then: `bun run audit:doc-refs` (the `docs/` and `.claude/commands/` citations added above **are** gated, unlike the spec's)

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "docs: I40, schema V61, and the toolgen delivery re-ledger"
gh pr create --title "feat(toolgen): runtime tool generation PR 3 of 3 — persistence + signing"
```

PR title carries the conventional-commit type — release-please parses the **title**, and the squash commit is built from title + body, so a local commit message never reaches `main`.

---

## Self-Review

**Spec coverage** — every section maps to a task: § 2 → 11 · § 3 → 4 · § 3.1 → 1, 9, 12 · § 4 → 2, 8 · § 5 → 3 · § 6/6.1 → 7 · § 7 → 9 · § 7.1 → 8 · § 7.2 → 9 · § 8.1/8.2 → 5 · § 8.3 → 6 · § 9 → 10 · § 10 → 11 · § 11 → spread, with the per-platform half in 12 · § 12 → 12.

**Deviations from the spec, both deliberate and flagged above:**

1. `index.ts` is derived and re-emitted at spawn; the "byte flip in index.ts → refuses" test becomes "→ overwritten, approved bytes execute". Raise before Task 1 if unwanted.
2. `body_missing` dropped from `SavedToolDisabledReason` — it cannot occur once the script is derived.

**Known open item carried from spec § 13:** whether `extensions/verify-signature.ts` is reusable. Task 3 resolves it by writing a small detached verifier, since that module is shaped around a manifest with an embedded signature field rather than a detached signature over canonical bytes.

**Type consistency:** `SavedToolDisabledReason` (Task 2) is the single union used by Tasks 4 and 8. `PortableToolManifest` (Task 1) is consumed by 9. `credentialHostsFor` (Task 6) matches the existing `approvedHostsFor` shape. `ToolgenEnvelope.sessionId` stays required throughout; saved tools use `SavedToolEnvelope` (Task 9).

---

## Review Disposition (2026-09-10)

Against [`2026-09-10-s2-toolgen-persistence-review.md`](./2026-09-10-s2-toolgen-persistence-review.md).
Each item was checked against the tree before disposition.

| # | Item | Disposition | Note |
|---|---|---|---|
| 2.1 | Reconstruct `ExtensionManifest` at spawn | **Accepted — real gap in the plan; sketch corrected** | Verified: `buildToolSpawnSpec` passes `envelope.artifact.manifest` into `wrapServerSpec`, and a portable manifest has no `permissions`. Task 9 now specifies the envelope. Two details in the sketch rejected: the `sessionId: "saved"` sentinel (collides with `forSession`'s filter), and `rawArtifact.approvedAt ?? now()` (`approvedAt` is on the envelope, not the artifact, so it is never in the canonical JSON — that fallback would silently stamp every spawn with the current time). |
| 2.2 | Self-heal a disabled row | **Accepted in full** | Real: the short-circuit made a disabled tool unrepairable through any user-facing path. Task 7 now gates on `disabled_reason IS NULL` and adds a `repaired` outcome. Repair does **not** re-prompt — the digest matching means the bytes were already approved — but it does disclose, so an owner learns their tool had been disabled. |
| 2.3 | `normalizeHost` in `credentialSet` | **Accepted, strengthened** | Verified `normalizeHost` is exported from `toolgen-gate.ts:40`, and the same file's lines 293–294 record this exact mismatch already causing a bug once. Task 10 normalises once and uses only the normalised value, names both forms in the error, and adds the positive control the review omitted (`API.EXAMPLE.COM` must be **accepted**, or "refuses unknown hosts" passes for an implementation that refuses everything). |
| 2.4 | Docstring for the authority split | **Accepted** | Added to Task 8 verbatim in the implementation, including the stated cost, so pass 2 does not read as over-eager cleanup to a later reader. |

**Added beyond the review — signature verification is not schema validation.** The review's sketch
did `JSON.parse(verified.canonicalJson)` into an untyped value, which violates the no-`any`
non-negotiable and, more importantly, assumes that a verified artifact is a *well-formed* one. It is
not: an artifact written by a different build of Nimbus verifies perfectly and can still be missing a
field this version requires. Task 4 now owns `parseCanonicalArtifact`, a real guard; the single
verifying accessor returns data that is verified **and** well-formed; and `schema_invalid` joins
`SavedToolDisabledReason` so the two failure modes are distinguishable in `nimbus tool list` rather
than a valid-but-unusable artifact being reported as tampering.
