# Phase 5 T2 PR 2 — Verified Publisher (Ed25519-signed manifests) — Design

> **Status:** Draft (rev 1, post-brainstorm)
> **Author:** asafgolombek
> **Date:** 2026-05-17
> **Type:** Per-PR design (locks the implementation surface for `phase-5-t2-pr2-verified-publisher`)
> **Parent:** [T2 sequencing spec](./2026-05-16-phase-5-t2-design.md) §2 PR 2
> **Predecessor:** [T2 PR 1 sandbox design](./2026-05-16-phase-5-t2-pr1-sandbox-design.md) — merged 2026-05-17 (PR #329)

## Purpose

Extension manifests carry a publisher identity (Ed25519 public key) and an embedded signature. The signature is verified at install AND at every Gateway startup before the extension is allowed to spawn. Publisher public keys are fetched from a registry-hosted directory (`<registry>/publishers/<id>.key`), cached as vault keys, and refreshed via a new `nimbus extension sync` CLI command. Air-gapped installs accept a local key file via `--publisher-key <path>`. Pre-T2 unsigned extensions keep working but are marked `(unverified)`.

This PR introduces a new structural security invariant **I16** ("every installed extension with a `publisher` field has its signature verified at install AND at every startup") and follows the invariant triple rule: production wiring at two sites + docs entry + enforcement test (grep + behavioral).

The parent T2 sequencing spec locked OpenPGP / `openpgp.js` for this PR. The brainstorming round on 2026-05-17 **revisited that choice** and switched to Ed25519 + embedded signature because:

- **Uniform with the rest of the Nimbus crypto stack** — the updater (Phase 4 WS4) uses Ed25519 over SHA-256; the upcoming ratings signing key (T2 PR 5) uses Ed25519; LAN pairing uses NaCl box (X25519+Ed25519).
- **No third-party crypto dep** — Bun ships Ed25519 in WebCrypto (`crypto.subtle`); no `openpgp.js` (~250 KB) needed.
- **No SHA-1 anywhere** — OpenPGP v4 fingerprints are SHA-1; v5 are SHA-256 but adoption is uneven. Ed25519 sidesteps the v4/v5 fingerprint debate the recovered design-review raised.
- **Trivial verification surface** — Ed25519 verify is ~10 LOC of glue over WebCrypto. Smaller surface, smaller threat model, fewer "legacy crypto support knobs" to disable.
- **Mild positive on the "publishers can't reuse their GPG identity" downside** — scoping the signing identity to Nimbus extensions specifically means a leaked email-signing GPG key does not compromise extension signing.

## Section 1 — Architecture overview

### 1.1 New invariant I16

> Every installed extension with a `publisher` field has its signature verified at install AND at every Gateway startup before it is allowed to spawn.

| Element | Where |
|---|---|
| Production wiring site #1 | [`packages/gateway/src/extensions/install-from-local.ts`](../../../packages/gateway/src/extensions/install-from-local.ts) — calls `verifyManifestSignature(...)` after manifest parse, before install commits. |
| Production wiring site #2 | [`packages/gateway/src/extensions/verify-extensions.ts`](../../../packages/gateway/src/extensions/verify-extensions.ts) — iterates `extension_state` rows; for each row whose on-disk manifest carries `publisher`, calls `verifyManifestSignature(...)`. |
| Docs entry | [`docs/SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) §I16 (new row in the table at the top + new section near the bottom). |
| Enforcement test (static) | `packages/gateway/src/security-invariants.test.ts` — greps both wiring sites for `verifyManifestSignature(`. |
| Enforcement test (behavioral) | Same file — seeds an extension dir with a signed manifest but no vault key; calls `verifyExtensions`; asserts the extension is hard-disabled with reason `publisher_key_missing`. |
| Static-audit complement | None — I16 is enforced by the runtime tests (grep + behavioral) only, no static-time `D`-rule. (Unlike I1/I14/I15, which have a static-time `D`-rule, signature verification doesn't have an easy syntactic signature to grep for.) |

### 1.2 Component map

```
packages/gateway/src/extensions/
├── manifest.ts                  (existing — schema extended with publisher + signature)
├── canonical-json.ts            🟢 NEW — deterministic JSON for signing/verification (~30 LOC)
├── verify-signature.ts          🟢 NEW — Ed25519 sign + verify wrappers via Bun WebCrypto
├── publisher-keys.ts            🟢 NEW — vault key cache I/O + resolvePublisherKey helper
├── registry-client.ts           🟢 NEW — fetches <registry>/publishers/<id>.key, retry on transient
├── sync.ts                      🟢 NEW — orchestrates `nimbus extension sync`
├── install-from-local.ts        (existing — adds verifyManifestSignature call site #1)
├── verify-extensions.ts         (existing — adds verifyManifestSignature call site #2)
└── hard-disable.ts              (existing — gains new reason values)

packages/gateway/src/ipc/
├── extensions-rpc.ts            (existing — adds `extension.sync` handler; CLI-only, NOT in renderer allowlist)

packages/cli/src/commands/extension.ts
                                 (existing — adds `sync`, `keygen`, `sign`, `--publisher-key`
                                              flag to install, tabular `list` output, publisher
                                              column in `info`)

scripts/structure-audit/check-nimbus-invariants.ts
                                 (existing — D11 vault-key allow-list adds extension.publisher_key.*)
```

### 1.3 Data flow — install (`nimbus extension install <path-or-url>`)

1. Parse manifest. Validate per Section 2.
2. If `manifest.publisher === undefined`: install proceeds with pre-T2 unsigned legacy path; the row in `extension_state` records `publisher_id` implicitly `null` (no column exists; derived at read-time).
3. If `manifest.publisher` is set:
   - **Resolve pubkey** via `resolvePublisherKey({ publisherId, explicitKeyPath, vault, fetcher, enforceAirGap })` in priority order:
     1. `--publisher-key <path>`: read file, base64-decode, expect 32 bytes.
     2. Cached vault key `extension.publisher_key.<id>`.
     3. Registry fetch via `fetcher.fetch(publisherId)`. Air-gap → `AirGapNoPublisherKey`; 404 → `PublisherNotRegistered`; transient/registry_error → `RegistryUnreachable`.
   - Call `verifyManifestSignature(manifest, resolvedPubkey)`. On failure, append `extension.signature_failed` audit entry, refuse install.
   - On success: write pubkey to vault (idempotent), append `extension.signature_verified` audit entry, proceed.

### 1.4 Data flow — startup (`verifyExtensions`)

1. Read all `extension_state` rows.
2. For each row, parse the on-disk manifest. If `manifest.publisher !== undefined`:
   - Read cached pubkey from vault.
   - **Vault key missing** → `hardDisable(row.id, "publisher_key_missing")` (I16 behavioral-test target).
   - Else call `verifyManifestSignature(manifest, pubkey)`. On error → `hardDisable(row.id, <error→reason>)`.
3. After the loop, append one batched `extension.startup_verification` audit entry with `{ signatures_checked, hard_disabled, failures }`.

### 1.5 Trust anchor model

The **registry pubkey is the trust anchor**. The `manifest.publisher.key` field is an assertion about which key signed the manifest; it is not the trust source. Trust comes from "the registry says this key belongs to `<publisher-id>`."

At install / sync time, the resolved pubkey (from the priority chain) is compared against `manifest.publisher.key`. Mismatch → `PublisherKeyMismatch`. This prevents an attacker who steals a manifest from substituting their own pubkey and re-signing.

### 1.6 Vault namespace + Registry URL

- **Vault key namespace:** `extension.publisher_key.<id>` where `<id>` matches `^[a-z0-9][a-z0-9._-]*$` (max 64 chars). Added to **D11 vault-key allow-list** in `scripts/structure-audit/check-nimbus-invariants.ts`.
- **Registry URL:** `<registry>/publishers/<id>.key` (base path configurable via `[registry].base_url` in `nimbus.toml`, defaults to `https://registry.nimbus-agent.dev`). Body is base64-encoded 32-byte raw Ed25519 pubkey, no envelope. Keeps the registry static-file-servable.

## Section 2 — Manifest schema additions

### 2.1 New fields

```typescript
type ExtensionManifest = {
  id: string;
  version: string;
  name?: string;
  entry?: string;
  permissions: SandboxPermissions;
  publisher?: { id: string; key: string };  // NEW — both subfields required if present
  signature?: string;                       // NEW — required iff `publisher` is set
};
```

### 2.2 Validation rules (in `extensions/manifest.ts` → `parseExtensionManifestForRegistry`)

| Field | Format | Rejection rule |
|---|---|---|
| `publisher.id` | `^[a-z0-9][a-z0-9._-]*$`, max 64 chars | Identical to service-id format from the CI/CD data layer. |
| `publisher.key` | base64 of a 32-byte Ed25519 public key (44 chars including padding) | Length check + base64-decodes to exactly 32 bytes. Raw key bytes only — no PEM, no PKIX, no DER. |
| `signature` | base64 of a 64-byte Ed25519 signature (88 chars including padding) | Length check + base64-decodes to exactly 64 bytes. |
| **Pairing** | `publisher` ↔ `signature` symmetric | Both present or both absent. Validator throws `extension manifest must have publisher and signature together, or neither` on either alone. |
| **Unknown keys at top level** | Silently ignored (existing) | Forward-compat. |
| **Unknown keys inside `publisher`** | Rejected | Defense-in-depth — prevents future schema fields that affect trust from sneaking past an old verifier. |

### 2.3 Pre-T2 compatibility

- Existing extensions have no `publisher` field. They parse successfully and load as before.
- `nimbus extension list` shows them with `Publisher: (unverified)`. Same for `nimbus extension info <id>`.
- The legacy `permissions: string[]` form (already detected by T2 PR 1's `isPreT2Legacy` flag) takes precedence — pre-T2 extensions are hard-disabled at registry-load time per PR 1's deviation. The publisher field is irrelevant for them.

### 2.4 No DB schema migration

PR 2 ships **no V<N> migration**. The publisher id is derived from the on-disk manifest at sync and startup time (O(N) manifest reads per sync; N≈30; cost is sub-millisecond). PR 4's V31 migration may denormalize `publisher_id` later if dependency-resolution joins benefit, but PR 2 doesn't need it.

## Section 3 — Signature verification + canonical form

### 3.1 Canonical JSON algorithm (`extensions/canonical-json.ts`)

```typescript
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new NonIntegerNumberInManifest();
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();   // Unicode codepoint order
    return "{" + keys.map(k =>
      JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k])
    ).join(",") + "}";
  }
  throw new UnsupportedManifestValueType();
}

export function canonicalizeManifest(manifest: ExtensionManifest): Uint8Array {
  const { signature: _omit, ...rest } = manifest;
  return new TextEncoder().encode(canonicalize(rest));
}
```

Property tests (`fast-check`):
- Round-trip: `canonicalize(parse(canonicalize(x))) === canonicalize(x)` for arbitrary manifest-shaped inputs.
- Key-order invariance: shuffling input object key order does not change output.
- Signature-field stripping: `canonicalizeManifest({...m, signature: "anything"})` equals `canonicalizeManifest(m)`.
- Integer-only rejection: any non-integer number anywhere in the manifest tree throws `NonIntegerNumberInManifest`.

### 3.2 Ed25519 sign / verify (`extensions/verify-signature.ts`)

```typescript
export class PublisherKeyMismatch extends Error { name = "PublisherKeyMismatch"; }
export class SignatureInvalidFormat extends Error { name = "SignatureInvalidFormat"; }
export class SignatureInvalid extends Error { name = "SignatureInvalid"; }
export class NonIntegerNumberInManifest extends Error { name = "NonIntegerNumberInManifest"; }
export class UnsupportedManifestValueType extends Error { name = "UnsupportedManifestValueType"; }

export async function verifyManifestSignature(
  manifest: ExtensionManifest,
  resolvedPubkey: Uint8Array,   // 32 bytes — fetched from registry, vault, or --publisher-key
): Promise<void> {
  if (!manifest.publisher || !manifest.signature) {
    throw new Error("verifyManifestSignature called on unsigned manifest — caller must check first");
  }
  const declaredPubkey = decodeBase64(manifest.publisher.key);
  if (declaredPubkey.length !== 32) throw new SignatureInvalidFormat();
  if (!constantTimeBytesEqual(declaredPubkey, resolvedPubkey)) {
    throw new PublisherKeyMismatch();
  }
  const sig = decodeBase64(manifest.signature);
  if (sig.length !== 64) throw new SignatureInvalidFormat();
  const canonical = canonicalizeManifest(manifest);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", resolvedPubkey, { name: "Ed25519" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify("Ed25519", cryptoKey, sig, canonical);
  if (!ok) throw new SignatureInvalid();
}

export async function signManifest(
  manifest: ExtensionManifest,  // signature field ignored if present
  privkey: Uint8Array,          // 32-byte Ed25519 seed
): Promise<string>;             // returns base64 signature

export function generateEd25519Keypair(): { privkey: Uint8Array; pubkey: Uint8Array };
```

`constantTimeBytesEqual` uses the existing [`util/timing-safe-compare.ts`](../../../packages/gateway/src/util/timing-safe-compare.ts) helper (invariant `I10`). Pubkeys are not secret, but the helper keeps the codebase uniform and avoids the lint smell of branching on key bytes.

### 3.3 Error → user-facing message map

| Error class | Install-time message | Startup hard-disable reason |
|---|---|---|
| `PublisherKeyMismatch` | "Publisher key in the manifest does not match the key registered to `<id>`. Re-run `nimbus extension sync`, or re-run `nimbus extension install <path-or-url> --publisher-key <path>` with the correct key from a trusted source." | `publisher_key_mismatch` |
| `SignatureInvalidFormat` | "Manifest signature is malformed (expected 88-character base64 of a 64-byte Ed25519 signature). Manifest may be corrupted; re-run `nimbus extension install <path-or-url>` from a clean source." | `signature_malformed` |
| `SignatureInvalid` | "Manifest signature does not verify against publisher `<id>`'s key. Manifest may have been tampered with." | `signature_failed` |
| (vault key absent at startup) | n/a | `publisher_key_missing` |
| `AirGapNoPublisherKey` (install) | "Air-gap is enforced; publisher key for `<id>` is not in your local cache. Re-run `nimbus extension install <path-or-url> --publisher-key <path>` with the key locally available." | n/a |
| `PublisherNotRegistered` (install) | "Publisher `<id>` is not registered with the registry. Install refused." | n/a |
| `RegistryUnreachable` (install) | "Could not reach `<registry>/publishers/<id>.key`. Try `nimbus extension sync` later, or re-run `nimbus extension install <path-or-url> --publisher-key <path>` with the key locally available." | n/a |

## Section 4 — Registry client + `nimbus extension sync`

### 4.1 Registry client (`extensions/registry-client.ts`)

```typescript
export type PublisherKeyFetchResult =
  | { kind: "ok"; pubkey: Uint8Array }
  | { kind: "not_found" }
  | { kind: "transient"; statusCode?: number; message: string }
  | { kind: "registry_error"; statusCode: number; message: string };

export interface PublisherKeyFetcher {
  fetch(publisherId: string): Promise<PublisherKeyFetchResult>;
}

export function createPublisherKeyFetcher(opts: {
  baseUrl: string;                  // [registry].base_url
  timeoutMs?: number;               // default 10000
  retries?: number;                 // default 1
}): PublisherKeyFetcher;
```

- **Timeout** via `AbortController`; configurable via `[extensions].publisher_key_fetch_timeout_ms`.
- **Retry once** on `transient` results (network error, 5xx, AbortError). No exponential backoff — sync is operator-initiated.
- **Body parser:** trim → base64-decode → assert exactly 32 bytes. Reject otherwise as `registry_error`.
- **No JSON envelope.** Raw base64 ASCII body. Static-file-servable.

### 4.2 Vault cache (`extensions/publisher-keys.ts`)

```typescript
const VAULT_KEY_PREFIX = "extension.publisher_key.";

export async function readPublisherKey(vault: NimbusVault, publisherId: string): Promise<Uint8Array | undefined>;
export async function writePublisherKey(vault: NimbusVault, publisherId: string, pubkey: Uint8Array): Promise<void>;
export async function evictPublisherKey(vault: NimbusVault, publisherId: string): Promise<void>;
export async function listCachedPublisherIds(vault: NimbusVault): Promise<string[]>;
export async function resolvePublisherKey(opts: ResolvePublisherKeyOpts): Promise<Uint8Array>;
```

Vault stores base64-encoded pubkey (consistent with other Nimbus vault entries).

### 4.3 Sync orchestrator (`extensions/sync.ts`)

```typescript
export type SyncResult = {
  publishersChecked: number;
  publishersUnchanged: number;
  publishersUpdated: { id: string; reverifyResult: "ok" | "failed"; failedExtensions: string[] }[];
  publishersEvicted: string[];
  failures: { id: string; reason: string }[];
};

export class AirGapEnforcementError extends Error { name = "AirGapEnforcementError"; }

export async function syncPublisherKeys(opts: {
  vault: NimbusVault;
  db: Database;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
  dryRun?: boolean;
}): Promise<SyncResult>;
```

**Algorithm:**

1. If `enforceAirGap`: throw `AirGapEnforcementError`. Caller maps to exit code 3.
2. Read all `extension_state` rows; parse each on-disk manifest; collect `DISTINCT manifest.publisher.id`.
3. For each id (parallel; N is small, no rate-limiting needed):
   - `fetcher.fetch(id)`:
     - `ok` + equal to cached → `publishersUnchanged++`.
     - `ok` + different from cached → (unless `dryRun`) `writePublisherKey`; re-verify every installed extension with that publisher id; record `publishersUpdated` with re-verify outcome.
     - `not_found` → (unless `dryRun`) `evictPublisherKey`; record `publishersEvicted`.
     - `transient` / `registry_error` → leave cache untouched; record `failures`.
4. Append one `extension.publisher_key_synced` audit entry per publisher per outcome.
5. Return aggregated `SyncResult`.

**Concurrency:** process-wide async mutex in `sync.ts` ensures at most one in-flight `syncPublisherKeys` run. `verifyExtensions` reads vault keys as a snapshot at startup; if a sync overlaps a restart, the next verify pass picks up the post-sync state.

### 4.4 IPC method

| Property | Value |
|---|---|
| Method | `extension.sync` (request/response) |
| Params | `{ dryRun?: boolean }` |
| Returns | `SyncResult` JSON |
| Tauri renderer allowlist | **NOT** in `ALLOWED_METHODS` (I7) — CLI-only |
| LAN exposure | In `FORBIDDEN_OVER_LAN` (I5) |
| HTTP write surface | Not added (I13 — `WRITE_ROUTE_ALLOWLIST` unchanged) |

### 4.5 CLI

```
nimbus extension sync [--dry-run] [--json]
```

| Flag | Behavior |
|---|---|
| (default) | Human-readable per-publisher summary + counts. Exit code per below. |
| `--dry-run` | Don't write to vault, don't audit. Print what would change. |
| `--json` | Emit `SyncResult` JSON to stdout. Stderr only carries error lines. Respects `NO_COLOR`. |

| Exit | Meaning |
|---|---|
| `0` | All publishers checked; no rotations caused re-verification failures. |
| `2` | A key rotation caused at least one installed extension to fail re-verification. `SyncResult.publishersUpdated[].failedExtensions` lists them. Operator action required: re-run `nimbus extension install <path-or-url> --publisher-key <path>` for each affected extension. |
| `3` | Air-gap enforced. To refresh a single publisher's key, reinstall the affected extension with `nimbus extension install <path-or-url> --publisher-key <path>` from a trusted local source. |
| `4` | Registry unreachable for all publishers (every fetch returned `transient`). |

## Section 5 — Install + startup wiring + I16 enforcement

### 5.1 `install-from-local.ts` changes (I16 wiring site #1)

After existing manifest parse + SHA-256 + permissions checks:

```typescript
if (manifest.publisher !== undefined) {
  const resolvedPubkey = await resolvePublisherKey({
    publisherId: manifest.publisher.id,
    explicitKeyPath: opts.publisherKeyPath,   // from --publisher-key <path>
    vault: opts.vault,
    fetcher: opts.fetcher,
    enforceAirGap: opts.enforceAirGap,
  });
  try {
    await verifyManifestSignature(manifest, resolvedPubkey);
  } catch (err) {
    appendAuditEntry({
      actionType: "extension.signature_failed",
      payload: { id, publisher_id: manifest.publisher.id, error: err.name, message: err.message },
    });
    throw err;
  }
  await writePublisherKey(opts.vault, manifest.publisher.id, resolvedPubkey);
  appendAuditEntry({
    actionType: "extension.signature_verified",
    payload: { id, publisher_id: manifest.publisher.id, verified_at_ms: Date.now() },
  });
}
// proceed with install
```

### 5.2 `verify-extensions.ts` changes (I16 wiring site #2)

Iterate `extension_state` rows; for each row whose on-disk manifest carries `publisher`, verify. Aggregate counts; emit one batched audit entry.

```typescript
let signaturesChecked = 0;
let signatureHardDisabled = 0;
const failures: { id: string; reason: string }[] = [];

for (const row of rows) {
  const { manifest } = parseExtensionManifestForRegistry(readManifestText(row.path));
  if (manifest.publisher === undefined) continue;

  signaturesChecked++;
  const pubkey = await readPublisherKey(opts.vault, manifest.publisher.id);
  if (pubkey === undefined) {
    await hardDisable(opts.db, row.id, "publisher_key_missing");
    signatureHardDisabled++;
    failures.push({ id: row.id, reason: "publisher_key_missing" });
    continue;
  }
  try {
    await verifyManifestSignature(manifest, pubkey);
  } catch (err) {
    const reason = errorToHardDisableReason(err);
    await hardDisable(opts.db, row.id, reason);
    signatureHardDisabled++;
    failures.push({ id: row.id, reason });
  }
}

appendAuditEntry({
  actionType: "extension.startup_verification",
  payload: { signatures_checked: signaturesChecked, hard_disabled: signatureHardDisabled, failures },
});
```

### 5.3 `hard-disable.ts` reason additions

New `disabled_reason` values added to the existing string union:

- `publisher_key_missing`
- `publisher_key_mismatch`
- `signature_failed`
- `signature_malformed`

### 5.4 `nimbus extension install --publisher-key <path>`

New flag on the existing `install` command. CLI reads the file, validates base64 + 32-byte length, surfaces the parse error early if malformed. Passes through to `installExtensionFromLocalDirectory({ publisherKeyPath })`. No vault writes happen before signature verification succeeds.

### 5.5 I16 enforcement test (`packages/gateway/src/security-invariants.test.ts`)

**Static — source grep:**

```typescript
test("I16: install-from-local.ts and verify-extensions.ts both call verifyManifestSignature", async () => {
  const install = await Bun.file(installFromLocalPath).text();
  const verify = await Bun.file(verifyExtensionsPath).text();
  expect(install).toContain("verifyManifestSignature(");
  expect(verify).toContain("verifyManifestSignature(");
});
```

**Behavioral — load with missing vault key → hard-disabled:**

```typescript
test("I16 behavioral: signed extension with missing vault key is hard-disabled at startup", async () => {
  const { vault, db, tmpDir } = await setupFreshGateway();

  // Stage an extension dir with a signed manifest, but DON'T write the publisher key to vault.
  const { privkey, pubkey } = generateEd25519Keypair();
  const baseManifest: ExtensionManifest = {
    id: "test-ext",
    version: "1.0.0",
    permissions: defaultPermissions(),
    publisher: { id: "test-pub", key: encodeBase64(pubkey) },
  };
  const signature = await signManifest(baseManifest, privkey);
  const signed = { ...baseManifest, signature };
  writeExtensionToDisk(tmpDir, signed);
  insertExtensionStateRow(db, { id: "test-ext", path: extPath });
  // (intentionally skip writePublisherKey)

  await verifyExtensions({ vault, db, /* ... */ });

  const state = readExtensionState(db, "test-ext");
  expect(state.disabled).toBe(true);
  expect(state.disabled_reason).toBe("publisher_key_missing");
});
```

This is the test the recovered design-review §5 specifically asked for. It catches the "wired but doesn't actually hard-disable" failure mode that source-grep can't.

### 5.6 No DB schema migration

`extension_state.publisher_id` column is **not** added in PR 2 — see §2.4. The publisher id is derived from the on-disk manifest at sync and startup time.

## Section 6 — CLI, audit, testing, coverage, out of scope

### 6.1 Full CLI surface

| Command | Behavior | Vault writes |
|---|---|---|
| `nimbus extension install <path-or-url> [--publisher-key <key-file>]` | Existing + `--publisher-key` flag. If manifest carries `publisher`, verify using priority chain. | Writes `extension.publisher_key.<id>` on every successful install (idempotent — same bytes on re-install). |
| `nimbus extension sync [--dry-run] [--json]` | Refresh cached publisher keys (Section 4.5). | Writes / evicts `extension.publisher_key.<id>`. |
| `nimbus extension list [--json]` | Tabular human output: `ID | Version | Publisher | Status`. Publisher: `<id>` for verified, `(unverified)` for legacy. `--json` preserves machine-readable structure (`publisher: { id, key }` or `null`). | None. |
| `nimbus extension info <id> [--json]` | Adds "Publisher" section: id, base64 pubkey (first 16 chars + `…` for human; full in `--json`), `verified_at`, `last_synced_at`. | None. |
| `nimbus extension keygen [--out <path>] [--force]` | Generate fresh Ed25519 keypair. Prints pubkey (base64) to stdout. Writes privkey to `<path>` (default `~/.nimbus/publisher-key`) with mode `0600`. Refuses to overwrite without `--force`. | None — does not touch vault. |
| `nimbus extension sign <ext-dir> [--key <path>]` | Read manifest; if a `signature` field is already present, strip it before canonicalization; compute the canonical bytes; sign; write the manifest back with the new `signature` field set (overwriting any prior value). `--key` defaults to `~/.nimbus/publisher-key`. | None. |

All commands respect `NO_COLOR`. Tabular output uses manual padding — **no new dep**.

### 6.2 Audit log action types

| Action type | When | `hitlStatus` | Payload |
|---|---|---|---|
| `extension.signature_verified` | At install, after signature verifies | `not_required` | `{ id, publisher_id, verified_at_ms }` |
| `extension.signature_failed` | At install, before install is refused | `not_required` | `{ id, publisher_id, error, message }` |
| `extension.publisher_key_synced` | Per publisher per sync run | `not_required` | `{ id, kind: "unchanged"\|"updated"\|"evicted"\|"failed", reason? }` |
| `extension.startup_verification` | One batched entry per Gateway startup | `not_required` | `{ signatures_checked, hard_disabled, failures: [{id, reason}] }` |

None are HITL-required — verification is automatic; hard-disable is a structural defense.

### 6.3 Testing layers

| Test | File | Asserts |
|---|---|---|
| Canonical JSON unit | `packages/gateway/src/extensions/canonical-json.test.ts` | Sorted-keys property, idempotent round-trip, integer-only rejection, signature-field stripping, `fast-check` property tests |
| Sign + verify round-trip | `packages/gateway/src/extensions/verify-signature.test.ts` | Sign-then-verify succeeds; tampered manifest fails; wrong key fails; `PublisherKeyMismatch` when declared ≠ resolved |
| Registry client | `packages/gateway/src/extensions/registry-client.test.ts` | Body decoder accepts 32-byte base64; rejects malformed; 200/404/5xx mapped to correct kind; AbortController timeout fires; retry counted |
| Publisher-keys vault | `packages/gateway/src/extensions/publisher-keys.test.ts` | Read/write/evict round-trips through MockVault; `resolvePublisherKey` priority chain |
| Sync orchestrator | `packages/gateway/src/extensions/sync.test.ts` | Unchanged / updated / evicted / failed paths; rotation triggers re-verify; dry-run writes nothing; air-gap throws |
| Install integration | `packages/gateway/src/extensions/install-from-local.test.ts` | Signed install succeeds; tampered manifest rejected; `--publisher-key` precedence; registry fetch fills cache |
| Startup integration | `packages/gateway/src/extensions/verify-extensions.test.ts` | Signed extensions verified; missing vault key → hard-disable; tampered manifest → hard-disable; pre-T2 unsigned unaffected; batched audit emitted |
| I16 invariants | `packages/gateway/src/security-invariants.test.ts` | Grep both wiring sites; behavioral test (Section 5.5) |
| CLI e2e — sync | `packages/cli/test/e2e/scenarios/extension-sync.e2e.test.ts` | Mock registry serves test key; sync writes vault entry; air-gap exit 3 |
| CLI e2e — install | `packages/cli/test/e2e/scenarios/extension-install-signed.e2e.test.ts` | `--publisher-key` path; failure modes; tampered manifest refused |
| CLI e2e — sign + keygen | `packages/cli/test/e2e/scenarios/extension-sign-keygen.e2e.test.ts` | Round trip: keygen → sign → install verifies |

All test fixtures generate Ed25519 keypairs in-process at test setup — **no committed crypto material**, no fixture regeneration script.

### 6.4 Coverage gates

| Gate | Target | Touched by |
|---|---|---|
| `bun run test:coverage:extensions` | **≥85% (existing)** | Stays green; new files (`canonical-json.ts`, `verify-signature.ts`, `publisher-keys.ts`, `registry-client.ts`, `sync.ts`) all fall under this gate. |

**No new coverage gate** — PR 2's new files all live under `packages/gateway/src/extensions/`, which already has the ≥85% gate from prior phases.

### 6.5 Out of scope (explicit)

- **GPG / OpenPGP support.** Switched to Ed25519. The recovered design-review's v4/v5 question is moot — Ed25519 has no fingerprint version concept.
- **Publisher key rotation with grace period.** Hard-disable on next startup is the only path; survey-data-driven grace is a follow-up.
- **Publisher revocation beyond delete-from-registry.** No CRL / OCSP / revocation cert.
- **Multi-signature manifests.** Single Ed25519 signature only.
- **Auto-sync on a polling cadence.** Sync is CLI-only.
- **Tauri renderer-callable sync.** `extension.sync` is CLI-only — not in `ALLOWED_METHODS` (I7 count assertion unchanged).
- **Web-of-trust / key endorsement.** No publisher-to-publisher links.
- **Audit-log content for publisher pubkey bytes.** Only `publisher_id` is logged — the bytes are in the vault row, not interesting for forensics.
- **Schema migrations.** Per the parent T2 spec (line 251), PR 2 ships no V<N> SQL migration. PR 4 ships V31 for `extension_dependency`.
- **LAN exposure of `extension.sync`.** In `FORBIDDEN_OVER_LAN` (I5).
- **HTTP write surface additions.** `WRITE_ROUTE_ALLOWLIST` unchanged (I13).
- **Backwards-compat shim for OpenPGP-signed manifests from any third-party tooling.** No such tooling exists for Nimbus extensions; the format we ship is the format.
- **Publisher-key expiration metadata.** Ed25519 keys carry no expiration; if needed later, an optional `expires_at` field at the registry-metadata layer is a follow-up.

## Section 7 — Cross-cutting

### 7.1 Invariant interactions

| Invariant | Touched | What changes |
|---|---|---|
| **I1** (extensionProcessEnv) | No | Sandbox still wraps every spawn (PR 1). Untouched here. |
| **I2 / I3 / I4** (HITL) | No | No new action types; verification is automatic, not HITL-gated. |
| **I5** (LAN allowlist) | Yes | `extension.sync` added to `FORBIDDEN_OVER_LAN` (read-only and write-side both refused over LAN). |
| **I7** (Tauri allowlist) | No | No new methods exposed to the renderer; `ALLOWED_METHODS` count assertion unchanged. |
| **I9** (SQL parameter binding) | No | All new reads/writes through `dbRun` / `dbExec` already use parameter binding. |
| **I10** (constant-time compare) | Yes | `verifyManifestSignature` uses `constantTimeBytesEqual` from `util/timing-safe-compare.ts`. |
| **I11** (tool-output envelope) | No | No new LLM-facing surface. |
| **I13** (HTTP write routes) | No | `WRITE_ROUTE_ALLOWLIST` unchanged. |
| **I14** (typed `dbRun`) | Yes | All new SQLite writes go through `dbRun` / `dbExec` (the `publisher.*` audit writes; `hardDisable` already does). Static `D12` audit catches violations. |
| **I15** (sandbox runner intrinsic) | No | Untouched — verification runs in the Gateway process, not extension processes. |
| **I16 (new)** | Yes | This PR's primary invariant. See §1.1. |

### 7.2 Static-audit interactions (`scripts/structure-audit/check-nimbus-invariants.ts`)

- **D1** (cross-package): all PR 2 code stays inside `packages/gateway/src/extensions/` and `packages/cli/src/commands/`. No new cross-package boundary.
- **D11** (vault-key allow-list): adds `extension.publisher_key.*` pattern.
- **D12** (typed `dbRun`): unchanged; new writes go through the typed wrapper.

### 7.3 Verification gates before opening the PR

```
bun run typecheck
bun run lint
bun run audit:invariants                # D11 + D12 gates
bun run audit:structure                 # full structure audit
bun audit --audit-level high
bun run test:coverage:extensions        # ≥85%
bun run test:ci                          # full CI parity (Ubuntu)
```

The 3-OS push matrix (Windows / macOS / Linux) runs on push to `main` after PR review.

### 7.4 Commit cadence

Per the cadence locked in the parent T2 spec (§4): feat / test / docs commits with `Co-Authored-By:` trailer. No squash merge — per-task commit history is the audit trail.

## Section 8 — See also

- [`./2026-05-16-phase-5-t2-design.md`](./2026-05-16-phase-5-t2-design.md) §2 PR 2 — parent T2 sequencing spec; locked scope; the brainstorm round on 2026-05-17 deviated on crypto choice (Ed25519 instead of OpenPGP) — see Purpose section above for rationale.
- [`./2026-05-16-phase-5-t2-pr1-sandbox-design.md`](./2026-05-16-phase-5-t2-pr1-sandbox-design.md) — predecessor PR; merged 2026-05-17 (PR #329).
- [`../../SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) — I16 row added here in the implementation PR.
- [`../../../.claude/commands/nimbus-security-invariants.md`](../../../.claude/commands/nimbus-security-invariants.md) — invariant triple rule that I16 follows.
- [`../../../.claude/commands/nimbus-connector-authoring.md`](../../../.claude/commands/nimbus-connector-authoring.md) — gets a "Signing your extension" subsection in the implementation PR.
- [`../../roadmap.md`](../../roadmap.md) §"Extension Marketplace v2" — T2 sub-checkbox for PR 2 flips to `[x]` on merge.

## Section 9 — Open questions deferred to the implementation plan

These are below the threshold of "design decision" and should be locked in the implementation plan rather than here:

- Exact name and shape of the registry test fixture (mock HTTP server library — likely Bun's built-in test fetch mocking).
- Exact `cli-table3`-or-manual-padding column width tuning for `nimbus extension list` (manual padding chosen; width tuning is a UX detail).
- Whether `nimbus extension keygen --out` writes the private key as a raw 32-byte file or base64-encoded text (decision in plan; recommend base64 for cross-platform line-ending safety).
- Whether `nimbus extension sign` accepts manifests from stdin in addition to a directory path (recommend directory-only; stdin add-on is a follow-up).
- Exact wording of the "publisher rotated keys" CLI message (UX detail).

These are not design-locked items — they will not change the architecture or invariant story.
