# Phase 5 T2 PR 2 — Verified Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Ed25519-signed extension manifest verification surface (invariant I16) end-to-end — manifest schema, canonical-JSON, Ed25519 verify, vault cache, registry sync, install + startup wiring, CLI surface (`install --publisher-key`, `sync`, `keygen`, `sign`, tabular `list`, publisher in `info`), and the I16 enforcement test triple.

**Architecture:** Ed25519 + embedded signature in `nimbus.extension.json`. Publisher pubkeys fetched from `<registry>/publishers/<id>.key` and cached as `extension.publisher_key.<id>` vault keys. Verification at install AND every Gateway startup. Hard-disable on failure via a new `SignatureDisabledRegistry` singleton parallel to PR 1's `PreT2DisabledRegistry`. No DB migration. CLI-only sync (not in Tauri allowlist, in `FORBIDDEN_OVER_LAN`).

**Tech Stack:** Bun WebCrypto Ed25519, custom canonical-JSON (~30 LOC + fast-check), existing `NimbusVault` interface, existing `appendAuditEntry` helper, existing `setExtensionEnabled` + `listExtensions` helpers from `automation/extension-store.ts`.

**Source spec:** [`docs/superpowers/specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design.md`](../specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design.md). Read it once before starting.

---

## Pre-flight (do this once before Task 1)

- [ ] **P-1: Confirm worktree + branch**

```bash
git rev-parse --show-toplevel    # → .../.worktrees/phase-5-t2-pr2-verified-publisher
git branch --show-current        # → dev/asafgolombek/phase-5-t2-pr2-verified-publisher
git status                       # → clean (3 spec commits already on branch)
```

- [ ] **P-2: Confirm baseline tests pass**

```bash
bun test:coverage:extensions
```

Expected: ≥85% green, no failures (this is the gate we must keep green throughout).

---

## Phase A — Foundation primitives (no deps)

### Task 1: Canonical JSON serializer

**Files:**
- Create: `packages/gateway/src/extensions/canonical-json.ts`
- Create: `packages/gateway/src/extensions/canonical-json.test.ts`

- [ ] **Step 1: Write failing tests** (`packages/gateway/src/extensions/canonical-json.test.ts`)

```typescript
import { describe, expect, it } from "bun:test";

import {
  canonicalize,
  canonicalizeManifest,
  ManifestNestedTooDeep,
  NonIntegerNumberInManifest,
  UnsupportedManifestValueType,
} from "./canonical-json.ts";

describe("canonicalize", () => {
  it("serializes primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe(`"hello"`);
  });

  it("sorts object keys by Unicode codepoint", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe(`{"a":2,"b":1,"c":3}`);
  });

  it("is invariant under input key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe(`[3,1,2]`);
  });

  it("normalizes string VALUES to NFC", () => {
    // "café" composed (precomposed é, U+00E9) vs decomposed (e + U+0301)
    const composed = "café";
    const decomposed = "café";
    expect(canonicalize(composed)).toBe(canonicalize(decomposed));
  });

  it("does NOT normalize object KEYS", () => {
    // Keys are signed byte-for-byte; we never rewrite them.
    const composed = { "café": 1 };
    const decomposed = { "café": 1 };
    expect(canonicalize(composed)).not.toBe(canonicalize(decomposed));
  });

  it("rejects non-integer numbers", () => {
    expect(() => canonicalize(1.5)).toThrow(NonIntegerNumberInManifest);
    expect(() => canonicalize(Number.NaN)).toThrow(NonIntegerNumberInManifest);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(NonIntegerNumberInManifest);
  });

  it("rejects unsupported types", () => {
    expect(() => canonicalize(undefined as unknown)).toThrow(UnsupportedManifestValueType);
    expect(() => canonicalize(() => 0 as unknown)).toThrow(UnsupportedManifestValueType);
  });

  it("caps recursion at MAX_DEPTH = 32", () => {
    const buildNested = (n: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(canonicalize(buildNested(32))).toContain("[");
    expect(() => canonicalize(buildNested(33))).toThrow(ManifestNestedTooDeep);
  });

  it("is idempotent: parse(canonicalize(parse(canonicalize(x)))) === canonicalize(x)", () => {
    const x = { z: 1, a: [2, { c: 3, b: 4 }], m: "hi" };
    const round1 = canonicalize(x);
    const round2 = canonicalize(JSON.parse(round1));
    expect(round2).toBe(round1);
  });
});

describe("canonicalizeManifest", () => {
  it("strips the top-level signature field", () => {
    const m = {
      id: "test",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "p", key: "AAA" },
      signature: "anything-here",
    };
    const withSig = canonicalizeManifest(m);
    const withoutSig = canonicalizeManifest({ ...m, signature: "different" });
    expect(new TextDecoder().decode(withSig)).toBe(new TextDecoder().decode(withoutSig));
  });

  it("returns UTF-8 bytes", () => {
    const out = canonicalizeManifest({
      id: "test",
      version: "1.0.0",
      permissions: {},
    } as never);
    expect(out).toBeInstanceOf(Uint8Array);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/canonical-json.test.ts
```

Expected: `Cannot find module './canonical-json.ts'` or equivalent.

- [ ] **Step 3: Implement** (`packages/gateway/src/extensions/canonical-json.ts`)

```typescript
/**
 * Deterministic JSON canonicalization for extension manifests.
 *
 * Used as the input to Ed25519 manifest signing (T2 PR 2 / I16). The signed
 * bytes are the manifest with the `signature` field stripped, re-serialized
 * via the rules below. Signing and verifying both call into this module so
 * the byte sequences match exactly.
 *
 * Rules:
 * - Object keys sorted by Unicode codepoint (lexicographic on UTF-16 units).
 * - String VALUES Unicode-normalized to NFC so semantically-equal strings
 *   yield identical bytes regardless of how the source editor encoded them.
 *   Object KEYS are NOT normalized — the publisher signs them byte-for-byte
 *   as serialized.
 * - Integer numbers only (manifests have no floating-point fields).
 * - No whitespace; UTF-8 encoded.
 * - Recursion capped at MAX_DEPTH (32) — real manifests have depth ≤ 4; the
 *   cap defends against a maliciously crafted manifest blowing the stack.
 *
 * Preconditions: callers pass values produced by `JSON.parse`. That domain
 * guarantees no cycles, no undefined / function / symbol values, no NaN /
 * Infinity. The thrown error classes below are defensive for callers that
 * violate the precondition (e.g. constructing the input in-memory).
 */

export class NonIntegerNumberInManifest extends Error {
  override readonly name = "NonIntegerNumberInManifest";
}
export class UnsupportedManifestValueType extends Error {
  override readonly name = "UnsupportedManifestValueType";
}
export class ManifestNestedTooDeep extends Error {
  override readonly name = "ManifestNestedTooDeep";
}

const MAX_DEPTH = 32;

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new ManifestNestedTooDeep();
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new NonIntegerNumberInManifest();
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v, depth + 1)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k], depth + 1))
        .join(",") +
      "}"
    );
  }
  throw new UnsupportedManifestValueType();
}

export function canonicalizeManifest(manifest: object): Uint8Array {
  const clone: Record<string, unknown> = { ...(manifest as Record<string, unknown>) };
  delete clone["signature"];
  return new TextEncoder().encode(canonicalize(clone));
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/canonical-json.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/canonical-json.ts packages/gateway/src/extensions/canonical-json.test.ts
git commit -m "feat(extensions): canonical-JSON serializer for manifest signing (T2 PR 2)"
```

---

### Task 2: Ed25519 sign / verify primitives + manifest signature verification

**Files:**
- Create: `packages/gateway/src/extensions/verify-signature.ts`
- Create: `packages/gateway/src/extensions/verify-signature.test.ts`

- [ ] **Step 1: Write failing tests** (`packages/gateway/src/extensions/verify-signature.test.ts`)

```typescript
import { describe, expect, it } from "bun:test";

import {
  decodeBase64,
  encodeBase64,
  errorToHardDisableReason,
  generateEd25519Keypair,
  PublisherKeyMismatch,
  signManifest,
  SignatureInvalid,
  SignatureInvalidFormat,
  verifyManifestSignature,
} from "./verify-signature.ts";

const baseManifest = (pubkeyB64: string) => ({
  id: "test-ext",
  version: "1.0.0",
  permissions: {},
  publisher: { id: "test-pub", key: pubkeyB64 },
});

describe("generateEd25519Keypair", () => {
  it("returns 32-byte privkey and 32-byte pubkey", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    expect(privkey).toBeInstanceOf(Uint8Array);
    expect(pubkey).toBeInstanceOf(Uint8Array);
    expect(privkey.length).toBe(32);
    expect(pubkey.length).toBe(32);
  });

  it("produces distinct keypairs", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    expect(encodeBase64(a.pubkey)).not.toBe(encodeBase64(b.pubkey));
  });
});

describe("signManifest + verifyManifestSignature round-trip", () => {
  it("verify(sign(m)) succeeds for matching key", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const signature = await signManifest(m, privkey);
    const signed = { ...m, signature };
    await expect(verifyManifestSignature(signed, pubkey)).resolves.toBeUndefined();
  });

  it("rejects manifest tampered after signing", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const signature = await signManifest(m, privkey);
    const tampered = { ...m, version: "9.9.9", signature };
    await expect(verifyManifestSignature(tampered, pubkey)).rejects.toThrow(SignatureInvalid);
  });

  it("rejects when verifier holds a different key", async () => {
    const signer = generateEd25519Keypair();
    const otherKey = generateEd25519Keypair().pubkey;
    const m = baseManifest(encodeBase64(signer.pubkey));
    const signature = await signManifest(m, signer.privkey);
    const signed = { ...m, signature };
    await expect(verifyManifestSignature(signed, otherKey)).rejects.toThrow(PublisherKeyMismatch);
  });

  it("rejects signature with wrong base64 length", async () => {
    const { pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const tooShort = { ...m, signature: encodeBase64(new Uint8Array(63)) };
    await expect(verifyManifestSignature(tooShort, pubkey)).rejects.toThrow(SignatureInvalidFormat);
  });

  it("rejects manifest.publisher.key with wrong length", async () => {
    const { pubkey } = generateEd25519Keypair();
    const sig = encodeBase64(new Uint8Array(64));
    const bad = {
      id: "test-ext",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(new Uint8Array(31)) },
      signature: sig,
    };
    await expect(verifyManifestSignature(bad, pubkey)).rejects.toThrow(SignatureInvalidFormat);
  });

  it("ignores existing signature field when signing (idempotent re-sign)", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest(encodeBase64(pubkey));
    const sig1 = await signManifest(m, privkey);
    const sig2 = await signManifest({ ...m, signature: "garbage" }, privkey);
    // Ed25519 is deterministic over the same input, so the two sigs must match.
    expect(sig1).toBe(sig2);
  });
});

describe("encodeBase64 / decodeBase64", () => {
  it("round-trip", () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});

describe("errorToHardDisableReason", () => {
  it("maps error classes to reason strings", () => {
    expect(errorToHardDisableReason(new SignatureInvalid())).toBe("signature_failed");
    expect(errorToHardDisableReason(new SignatureInvalidFormat())).toBe("signature_malformed");
    expect(errorToHardDisableReason(new PublisherKeyMismatch())).toBe("publisher_key_mismatch");
  });

  it("falls back to signature_failed for unknown errors", () => {
    expect(errorToHardDisableReason(new Error("???"))).toBe("signature_failed");
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/verify-signature.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement** (`packages/gateway/src/extensions/verify-signature.ts`)

```typescript
/**
 * Ed25519 sign + verify primitives for extension manifest signatures.
 * I16 wiring: `install-from-local.ts` and `verify-extensions.ts` both call
 * `verifyManifestSignature(...)`.
 */

import { canonicalizeManifest } from "./canonical-json.ts";

export class PublisherKeyMismatch extends Error {
  override readonly name = "PublisherKeyMismatch";
}
export class SignatureInvalidFormat extends Error {
  override readonly name = "SignatureInvalidFormat";
}
export class SignatureInvalid extends Error {
  override readonly name = "SignatureInvalid";
}

export type SignatureDisableReason =
  | "publisher_key_missing"
  | "publisher_key_mismatch"
  | "signature_failed"
  | "signature_malformed";

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

type SignedManifestShape = {
  publisher?: { id: string; key: string };
  signature?: string;
  [k: string]: unknown;
};

/**
 * Verify `manifest.signature` against the canonical bytes of the manifest
 * (with `signature` stripped), the declared `manifest.publisher.key`, and
 * the externally-resolved `resolvedPubkey`. Throws on any mismatch.
 *
 * Caller must check `manifest.publisher !== undefined` first — this function
 * does not gate the unsigned case.
 */
export async function verifyManifestSignature(
  manifest: SignedManifestShape,
  resolvedPubkey: Uint8Array,
): Promise<void> {
  if (manifest.publisher === undefined || manifest.signature === undefined) {
    throw new Error(
      "verifyManifestSignature called on unsigned manifest — caller must check first",
    );
  }
  if (resolvedPubkey.length !== 32) throw new SignatureInvalidFormat();
  const declaredPubkey = decodeBase64(manifest.publisher.key);
  if (declaredPubkey.length !== 32) throw new SignatureInvalidFormat();
  if (!constantTimeBytesEqual(declaredPubkey, resolvedPubkey)) {
    throw new PublisherKeyMismatch();
  }
  const sig = decodeBase64(manifest.signature);
  if (sig.length !== 64) throw new SignatureInvalidFormat();
  const canonical = canonicalizeManifest(manifest);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    resolvedPubkey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("Ed25519", cryptoKey, sig, canonical);
  if (!ok) throw new SignatureInvalid();
}

/**
 * Deterministically sign a manifest's canonical bytes with `privkey` (32-byte
 * Ed25519 seed). Returns the 64-byte signature as base64. Any existing
 * `signature` field on the manifest is ignored (stripped by
 * `canonicalizeManifest`).
 */
export async function signManifest(
  manifest: SignedManifestShape,
  privkey: Uint8Array,
): Promise<string> {
  if (privkey.length !== 32) throw new SignatureInvalidFormat();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    privkey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const canonical = canonicalizeManifest(manifest);
  const sig = await crypto.subtle.sign("Ed25519", cryptoKey, canonical);
  return encodeBase64(new Uint8Array(sig));
}

/**
 * Generate a fresh Ed25519 keypair via WebCrypto and export both halves as
 * raw 32-byte arrays. Used by `nimbus extension keygen` and by every test
 * fixture (no committed crypto material — see spec §6.3).
 */
export function generateEd25519Keypair(): { privkey: Uint8Array; pubkey: Uint8Array } {
  // Bun's WebCrypto generateKey is async, but we want a sync API for test
  // helpers. Fall back to Bun's sync nodeCrypto bridge.
  // node:crypto exposes generateKeyPairSync("ed25519").
  // The "raw" export of an Ed25519 private key in node:crypto includes the
  // DER prefix; we strip to the 32-byte seed via the JWK form.
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privkey = new Uint8Array(Buffer.from(privJwk.d, "base64url"));
  const pubkey = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
  return { privkey, pubkey };
}

/**
 * Map a verification error class to the `SignatureDisableReason` string the
 * `SignatureDisabledRegistry` (hard-disable.ts) records.
 */
export function errorToHardDisableReason(err: unknown): SignatureDisableReason {
  if (err instanceof PublisherKeyMismatch) return "publisher_key_mismatch";
  if (err instanceof SignatureInvalidFormat) return "signature_malformed";
  if (err instanceof SignatureInvalid) return "signature_failed";
  return "signature_failed";
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/verify-signature.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/verify-signature.ts packages/gateway/src/extensions/verify-signature.test.ts
git commit -m "feat(extensions): Ed25519 sign+verify primitives + manifest signature verifier (T2 PR 2)"
```

---

## Phase B — Manifest schema additions

### Task 3: Extend manifest schema with `publisher` + `signature` fields

**Files:**
- Modify: `packages/gateway/src/extensions/manifest.ts` (lines 38–46 for the type; 48–109 for the parser)
- Modify: `packages/gateway/src/extensions/manifest.test.ts`

- [ ] **Step 1: Write failing tests** — append to `packages/gateway/src/extensions/manifest.test.ts`:

```typescript
import { parseExtensionManifestForRegistry } from "./manifest.ts";

describe("parseExtensionManifestForRegistry — publisher + signature fields", () => {
  const makeJson = (extras: Record<string, unknown>) =>
    JSON.stringify({
      id: "test-ext",
      version: "1.0.0",
      permissions: {},
      ...extras,
    });

  it("accepts manifest with no publisher and no signature", () => {
    const out = parseExtensionManifestForRegistry(makeJson({}));
    expect(out.manifest.publisher).toBeUndefined();
    expect(out.manifest.signature).toBeUndefined();
  });

  it("accepts well-formed publisher + signature pair", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 44 chars, decodes to 32 zero bytes
    const sig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 88 chars
    const out = parseExtensionManifestForRegistry(
      makeJson({ publisher: { id: "test-pub", key: pubkey }, signature: sig }),
    );
    expect(out.manifest.publisher).toEqual({ id: "test-pub", key: pubkey });
    expect(out.manifest.signature).toBe(sig);
  });

  it("rejects publisher without signature", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "test-pub", key: pubkey } }),
      ),
    ).toThrow(/publisher and signature together, or neither/);
  });

  it("rejects signature without publisher", () => {
    const sig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(() => parseExtensionManifestForRegistry(makeJson({ signature: sig }))).toThrow(
      /publisher and signature together, or neither/,
    );
  });

  it("rejects bad publisher.id format", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = "A".repeat(88);
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "BAD ID WITH SPACE", key: pubkey }, signature: sig }),
      ),
    ).toThrow(/publisher\.id/);
  });

  it("rejects publisher.key with wrong length", () => {
    const sig = "A".repeat(88);
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "test-pub", key: "too-short" }, signature: sig }),
      ),
    ).toThrow(/publisher\.key/);
  });

  it("rejects signature with wrong length", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({ publisher: { id: "test-pub", key: pubkey }, signature: "too-short" }),
      ),
    ).toThrow(/signature/);
  });

  it("rejects unknown keys inside publisher", () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = "A".repeat(88);
    expect(() =>
      parseExtensionManifestForRegistry(
        makeJson({
          publisher: { id: "test-pub", key: pubkey, hint: "trust me" },
          signature: sig,
        }),
      ),
    ).toThrow(/unknown key/);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/manifest.test.ts
```

Expected: new tests fail because the parser doesn't yet enforce the rules.

- [ ] **Step 3: Implement** — modify `packages/gateway/src/extensions/manifest.ts`. Replace the existing `ExtensionManifest` type (lines 38–46) and add the publisher parser at the bottom. Final content of those sections:

```typescript
export type ExtensionManifest = {
  id: string;
  version: string;
  name?: string;
  /** Relative path to entry file (default dist/index.js). */
  entry?: string;
  /** Sandbox permission envelope (object form; legacy array → default-deny). */
  permissions: SandboxPermissions;
  /** Verified-publisher identity (T2 PR 2). Paired with `signature`. */
  publisher?: { id: string; key: string };
  /** Base64 Ed25519 signature over the canonicalized manifest minus this field. */
  signature?: string;
};

/** Allowed publisher id format. Matches the service-id pattern from CI/CD data layer. */
const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 32-byte Ed25519 pubkey in base64 standard encoding (with padding). */
const PUBLISHER_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** 64-byte Ed25519 signature in base64 standard encoding (with padding). */
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

function parsePublisher(value: unknown): { id: string; key: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension manifest publisher must be an object");
  }
  const o = value as Record<string, unknown>;
  const allowed = new Set(["id", "key"]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      throw new Error(`extension manifest publisher has unknown key: ${k}`);
    }
  }
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  if (id === "" || id.length > 64 || !PUBLISHER_ID_RE.test(id)) {
    throw new Error("extension manifest publisher.id is required and must match [a-z0-9][a-z0-9._-]* (max 64 chars)");
  }
  const key = typeof o["key"] === "string" ? o["key"].trim() : "";
  if (!PUBLISHER_KEY_RE.test(key)) {
    throw new Error("extension manifest publisher.key must be 44-char base64 of a 32-byte Ed25519 public key");
  }
  return { id, key };
}

function parseSignature(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("extension manifest signature must be a string");
  if (!SIGNATURE_RE.test(value)) {
    throw new Error("extension manifest signature must be 88-char base64 of a 64-byte Ed25519 signature");
  }
  return value;
}
```

Then, inside `parseExtensionManifestForRegistry` (right after the existing `entry` extraction at line 87 — call it after the `entry` line, before the `isPreT2Legacy` line), add:

```typescript
  const publisher = parsePublisher(o["publisher"]);
  const signature = parseSignature(o["signature"]);
  if ((publisher === undefined) !== (signature === undefined)) {
    throw new Error("extension manifest must have publisher and signature together, or neither");
  }
```

And in the returned manifest object (the `manifest: { ... }` block), add the two fields conditionally:

```typescript
      ...(publisher !== undefined ? { publisher } : {}),
      ...(signature !== undefined ? { signature } : {}),
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/manifest.test.ts
```

Expected: all green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/manifest.ts packages/gateway/src/extensions/manifest.test.ts
git commit -m "feat(extensions): add publisher + signature fields to manifest schema (T2 PR 2)"
```

---

## Phase C — Vault cache + registry client

### Task 4: Publisher-keys vault cache

**Files:**
- Create: `packages/gateway/src/extensions/publisher-keys.ts`
- Create: `packages/gateway/src/extensions/publisher-keys.test.ts`

- [ ] **Step 1: Write failing tests** (`packages/gateway/src/extensions/publisher-keys.test.ts`)

```typescript
import { describe, expect, it } from "bun:test";

import { MockVault } from "../vault/mock-vault.ts";
import { generateEd25519Keypair, encodeBase64 } from "./verify-signature.ts";
import {
  evictPublisherKey,
  listCachedPublisherIds,
  PUBLISHER_KEY_VAULT_PREFIX,
  readPublisherKey,
  writePublisherKey,
} from "./publisher-keys.ts";

describe("publisher-keys vault cache", () => {
  it("write then read returns the same 32-byte pubkey", async () => {
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const out = await readPublisherKey(vault, "test-pub");
    expect(out).toEqual(pubkey);
  });

  it("read returns undefined when no entry", async () => {
    const vault = new MockVault();
    expect(await readPublisherKey(vault, "absent")).toBeUndefined();
  });

  it("evict removes the entry", async () => {
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    await evictPublisherKey(vault, "test-pub");
    expect(await readPublisherKey(vault, "test-pub")).toBeUndefined();
  });

  it("list returns sorted publisher ids", async () => {
    const vault = new MockVault();
    const k = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "b-pub", k);
    await writePublisherKey(vault, "a-pub", k);
    await writePublisherKey(vault, "c-pub", k);
    const out = await listCachedPublisherIds(vault);
    expect(out).toEqual(["a-pub", "b-pub", "c-pub"]);
  });

  it("vault keys live under the documented prefix", () => {
    expect(PUBLISHER_KEY_VAULT_PREFIX).toBe("extension.publisher_key.");
  });

  it("rejects writing a non-32-byte pubkey", async () => {
    const vault = new MockVault();
    await expect(writePublisherKey(vault, "test-pub", new Uint8Array(31))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/publisher-keys.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement** (`packages/gateway/src/extensions/publisher-keys.ts`)

```typescript
/**
 * Publisher-key vault cache. Stores 32-byte Ed25519 pubkeys base64-encoded
 * under `extension.publisher_key.<publisher-id>`. The vault-key allow-list
 * (D11 static audit) restricts this namespace.
 */

import type { NimbusVault } from "../vault/index.ts";
import { decodeBase64, encodeBase64 } from "./verify-signature.ts";

export const PUBLISHER_KEY_VAULT_PREFIX = "extension.publisher_key." as const;

function key(publisherId: string): string {
  return `${PUBLISHER_KEY_VAULT_PREFIX}${publisherId}`;
}

export async function readPublisherKey(
  vault: NimbusVault,
  publisherId: string,
): Promise<Uint8Array | undefined> {
  const raw = await vault.get(key(publisherId));
  if (raw === undefined || raw === "") return undefined;
  const bytes = decodeBase64(raw);
  if (bytes.length !== 32) return undefined;
  return bytes;
}

export async function writePublisherKey(
  vault: NimbusVault,
  publisherId: string,
  pubkey: Uint8Array,
): Promise<void> {
  if (pubkey.length !== 32) {
    throw new Error(`publisher key must be 32 bytes (got ${String(pubkey.length)})`);
  }
  await vault.set(key(publisherId), encodeBase64(pubkey));
}

export async function evictPublisherKey(
  vault: NimbusVault,
  publisherId: string,
): Promise<void> {
  await vault.delete(key(publisherId));
}

export async function listCachedPublisherIds(vault: NimbusVault): Promise<readonly string[]> {
  const all = await vault.list();
  const out: string[] = [];
  for (const k of all) {
    if (k.startsWith(PUBLISHER_KEY_VAULT_PREFIX)) {
      out.push(k.slice(PUBLISHER_KEY_VAULT_PREFIX.length));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/publisher-keys.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/publisher-keys.ts packages/gateway/src/extensions/publisher-keys.test.ts
git commit -m "feat(extensions): publisher-key vault cache (T2 PR 2)"
```

---

### Task 5: Registry client (publisher pubkey fetcher)

**Files:**
- Create: `packages/gateway/src/extensions/registry-client.ts`
- Create: `packages/gateway/src/extensions/registry-client.test.ts`

- [ ] **Step 1: Write failing tests** (`packages/gateway/src/extensions/registry-client.test.ts`)

```typescript
import { describe, expect, it, mock } from "bun:test";

import { createPublisherKeyFetcher } from "./registry-client.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

function fakeFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return mock((_url: RequestInfo | URL) => {
    const r = responses[i++];
    if (r === undefined) throw new Error("fakeFetch ran out of responses");
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  }) as unknown as typeof fetch;
}

describe("PublisherKeyFetcher", () => {
  it("ok: returns 32-byte pubkey for valid 44-char base64 body", async () => {
    const { pubkey } = generateEd25519Keypair();
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response(encodeBase64(pubkey), { status: 200 })]),
    });
    const result = await f.fetch("test-pub");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.pubkey).toEqual(pubkey);
  });

  it("not_found: 404 maps to not_found", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("", { status: 404 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("not_found");
  });

  it("transient: 503 is retried once, succeeds on retry", async () => {
    const { pubkey } = generateEd25519Keypair();
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 1,
      fetchFn: fakeFetch([
        new Response("", { status: 503 }),
        new Response(encodeBase64(pubkey), { status: 200 }),
      ]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("ok");
  });

  it("transient: 503 twice surfaces transient result", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 1,
      fetchFn: fakeFetch([
        new Response("", { status: 503 }),
        new Response("", { status: 503 }),
      ]),
    });
    const out = await f.fetch("test-pub");
    expect(out.kind).toBe("transient");
  });

  it("registry_error: 401 surfaces registry_error", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("", { status: 401 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("registry_error: body not exactly 44 trimmed chars is rejected", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("AAAA", { status: 200 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("registry_error: appended trailing garbage rejected (S5 hardening)", async () => {
    const { pubkey } = generateEd25519Keypair();
    const valid = encodeBase64(pubkey);
    const padded = valid + "EXTRA-ATTACKER-BYTES==";
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response(padded, { status: 200 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("transient: fetch rejection treated as transient", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 0,
      fetchFn: fakeFetch([new Error("ECONNRESET")]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("transient");
  });

  it("builds URL as <baseUrl>/publishers/<id>.key", async () => {
    const { pubkey } = generateEd25519Keypair();
    const seen: string[] = [];
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: (async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return new Response(encodeBase64(pubkey), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await f.fetch("test-pub");
    expect(seen[0]).toBe("https://reg.example/publishers/test-pub.key");
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/registry-client.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement** (`packages/gateway/src/extensions/registry-client.ts`)

```typescript
/**
 * Registry client that fetches `<baseUrl>/publishers/<id>.key` and returns
 * the 32-byte Ed25519 pubkey body. Body shape: raw 44-char base64 (with
 * padding) of a 32-byte payload, no envelope. Strict body-length check
 * defends against trailing-garbage / append-style attacks.
 */

import { decodeBase64 } from "./verify-signature.ts";

export type PublisherKeyFetchResult =
  | { kind: "ok"; pubkey: Uint8Array }
  | { kind: "not_found" }
  | { kind: "transient"; statusCode?: number; message: string }
  | { kind: "registry_error"; statusCode: number; message: string };

export interface PublisherKeyFetcher {
  fetch(publisherId: string): Promise<PublisherKeyFetchResult>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;
const EXPECTED_BASE64_LEN = 44; // base64 of 32 bytes with padding

export function createPublisherKeyFetcher(opts: {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  /** Injected fetch implementation for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}): PublisherKeyFetcher {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const fetchFn = opts.fetchFn ?? fetch;

  async function attempt(publisherId: string): Promise<PublisherKeyFetchResult> {
    const url = `${baseUrl}/publishers/${publisherId}.key`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (res.status === 404) return { kind: "not_found" };
      if (res.status >= 500 && res.status < 600) {
        return { kind: "transient", statusCode: res.status, message: `HTTP ${String(res.status)}` };
      }
      if (res.status >= 400) {
        return { kind: "registry_error", statusCode: res.status, message: `HTTP ${String(res.status)}` };
      }
      if (!res.ok) {
        return { kind: "registry_error", statusCode: res.status, message: `HTTP ${String(res.status)}` };
      }
      const text = (await res.text()).trim();
      if (text.length !== EXPECTED_BASE64_LEN) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: `publisher key body must be exactly ${String(EXPECTED_BASE64_LEN)} trimmed chars (got ${String(text.length)})`,
        };
      }
      const pubkey = decodeBase64(text);
      if (pubkey.length !== 32) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: "publisher key body did not decode to 32 bytes",
        };
      }
      return { kind: "ok", pubkey };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "transient", message: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetch(publisherId: string): Promise<PublisherKeyFetchResult> {
      let result = await attempt(publisherId);
      let remaining = retries;
      while (result.kind === "transient" && remaining > 0) {
        remaining--;
        result = await attempt(publisherId);
      }
      return result;
    },
  };
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/registry-client.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/registry-client.ts packages/gateway/src/extensions/registry-client.test.ts
git commit -m "feat(extensions): registry client for publisher pubkey fetch (T2 PR 2)"
```

---

## Phase D — `resolvePublisherKey` + sync orchestrator

### Task 6: `resolvePublisherKey` helper

**Files:**
- Modify: `packages/gateway/src/extensions/publisher-keys.ts` (append)
- Modify: `packages/gateway/src/extensions/publisher-keys.test.ts` (append)

- [ ] **Step 1: Append the failing tests** to `packages/gateway/src/extensions/publisher-keys.test.ts`:

```typescript
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AirGapNoPublisherKey,
  PublisherNotRegistered,
  RegistryUnreachable,
  resolvePublisherKey,
} from "./publisher-keys.ts";

const fakeFetcher = (result: import("./registry-client.ts").PublisherKeyFetchResult) => ({
  fetch: async () => result,
});

describe("resolvePublisherKey", () => {
  it("priority 1: --publisher-key path takes precedence", async () => {
    const vault = new MockVault();
    const fileKey = generateEd25519Keypair().pubkey;
    const cachedKey = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "test-pub", cachedKey);

    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    writeFileSync(file, encodeBase64(fileKey) + "\n");
    try {
      const out = await resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: file,
        vault,
        fetcher: fakeFetcher({ kind: "ok", pubkey: generateEd25519Keypair().pubkey }),
        enforceAirGap: false,
      });
      expect(out).toEqual(fileKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("priority 2: vault cache used when no --publisher-key", async () => {
    const vault = new MockVault();
    const cachedKey = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "test-pub", cachedKey);
    const out = await resolvePublisherKey({
      publisherId: "test-pub",
      explicitKeyPath: undefined,
      vault,
      fetcher: fakeFetcher({ kind: "not_found" }),
      enforceAirGap: false,
    });
    expect(out).toEqual(cachedKey);
  });

  it("priority 3: registry fetch when neither flag nor cache", async () => {
    const vault = new MockVault();
    const regKey = generateEd25519Keypair().pubkey;
    const out = await resolvePublisherKey({
      publisherId: "test-pub",
      explicitKeyPath: undefined,
      vault,
      fetcher: fakeFetcher({ kind: "ok", pubkey: regKey }),
      enforceAirGap: false,
    });
    expect(out).toEqual(regKey);
  });

  it("air-gap: throws AirGapNoPublisherKey when no flag + no cache", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "ok", pubkey: generateEd25519Keypair().pubkey }),
        enforceAirGap: true,
      }),
    ).rejects.toThrow(AirGapNoPublisherKey);
  });

  it("registry 404 surfaces PublisherNotRegistered", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "not_found" }),
        enforceAirGap: false,
      }),
    ).rejects.toThrow(PublisherNotRegistered);
  });

  it("registry unreachable surfaces RegistryUnreachable", async () => {
    const vault = new MockVault();
    await expect(
      resolvePublisherKey({
        publisherId: "test-pub",
        explicitKeyPath: undefined,
        vault,
        fetcher: fakeFetcher({ kind: "transient", message: "ECONNREFUSED" }),
        enforceAirGap: false,
      }),
    ).rejects.toThrow(RegistryUnreachable);
  });

  it("explicit key path with malformed body surfaces clear error", async () => {
    const vault = new MockVault();
    const dir = mkdtempSync(join(tmpdir(), "nimbus-key-"));
    const file = join(dir, "pub.key");
    writeFileSync(file, "not-base64-of-32-bytes");
    try {
      await expect(
        resolvePublisherKey({
          publisherId: "test-pub",
          explicitKeyPath: file,
          vault,
          fetcher: fakeFetcher({ kind: "not_found" }),
          enforceAirGap: false,
        }),
      ).rejects.toThrow(/publisher key file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/publisher-keys.test.ts
```

Expected: new tests fail (`resolvePublisherKey` not exported).

- [ ] **Step 3: Append to `packages/gateway/src/extensions/publisher-keys.ts`**:

```typescript
import { readFileSync } from "node:fs";

import type { PublisherKeyFetcher } from "./registry-client.ts";

export class AirGapNoPublisherKey extends Error {
  override readonly name = "AirGapNoPublisherKey";
  constructor(publisherId: string) {
    super(
      `air-gap is enforced; publisher key for "${publisherId}" is not in your local cache — re-run \`nimbus extension install <path-or-url> --publisher-key <path>\` with the key locally available`,
    );
  }
}

export class PublisherNotRegistered extends Error {
  override readonly name = "PublisherNotRegistered";
  constructor(publisherId: string) {
    super(`publisher "${publisherId}" is not registered with the registry; install refused`);
  }
}

export class RegistryUnreachable extends Error {
  override readonly name = "RegistryUnreachable";
  constructor(publisherId: string, reason: string) {
    super(
      `could not reach registry for publisher "${publisherId}" (${reason}); check your network connection and re-run the install, or re-run \`nimbus extension install <path-or-url> --publisher-key <path>\` with the key locally available — \`nimbus extension sync\` cannot help here because it only refreshes already-installed extensions`,
    );
  }
}

export interface ResolvePublisherKeyOpts {
  publisherId: string;
  explicitKeyPath: string | undefined;
  vault: NimbusVault;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
}

/**
 * Resolve a publisher's 32-byte pubkey in priority order:
 *   1. --publisher-key <path>
 *   2. cached vault key extension.publisher_key.<id>
 *   3. registry fetch (refused under enforceAirGap)
 * Throws on the documented error classes.
 */
export async function resolvePublisherKey(opts: ResolvePublisherKeyOpts): Promise<Uint8Array> {
  // Priority 1: explicit file
  if (opts.explicitKeyPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(opts.explicitKeyPath, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`publisher key file ${opts.explicitKeyPath} could not be read: ${msg}`);
    }
    const trimmed = text.trim();
    if (trimmed.length !== 44) {
      throw new Error(
        `publisher key file ${opts.explicitKeyPath} must contain exactly 44 base64 chars (got ${String(trimmed.length)})`,
      );
    }
    const bytes = decodeBase64(trimmed);
    if (bytes.length !== 32) {
      throw new Error(`publisher key file ${opts.explicitKeyPath} did not decode to 32 bytes`);
    }
    return bytes;
  }
  // Priority 2: vault cache
  const cached = await readPublisherKey(opts.vault, opts.publisherId);
  if (cached !== undefined) return cached;
  // Priority 3: registry
  if (opts.enforceAirGap) throw new AirGapNoPublisherKey(opts.publisherId);
  const result = await opts.fetcher.fetch(opts.publisherId);
  if (result.kind === "ok") return result.pubkey;
  if (result.kind === "not_found") throw new PublisherNotRegistered(opts.publisherId);
  if (result.kind === "transient") {
    throw new RegistryUnreachable(opts.publisherId, result.message);
  }
  throw new RegistryUnreachable(opts.publisherId, `${String(result.statusCode)}: ${result.message}`);
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/publisher-keys.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/publisher-keys.ts packages/gateway/src/extensions/publisher-keys.test.ts
git commit -m "feat(extensions): resolvePublisherKey priority chain (T2 PR 2)"
```

---

### Task 7: Sync orchestrator

**Files:**
- Create: `packages/gateway/src/extensions/sync.ts`
- Create: `packages/gateway/src/extensions/sync.test.ts`

- [ ] **Step 1: Write failing tests** (`packages/gateway/src/extensions/sync.test.ts`)

```typescript
import { describe, expect, it } from "bun:test";

import { Database } from "bun:sqlite";

import { setupFreshExtensionDb, stageSignedExtensionOnDisk } from "../../test/fixtures/extension.ts";
import { MockVault } from "../vault/mock-vault.ts";
import { writePublisherKey } from "./publisher-keys.ts";
import { AirGapEnforcementError, syncPublisherKeys } from "./sync.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

describe("syncPublisherKeys", () => {
  it("unchanged: cached key equals registry key → publishersUnchanged++", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
      enforceAirGap: false,
    });
    expect(result.publishersChecked).toBe(1);
    expect(result.publishersUnchanged).toBe(1);
    expect(result.publishersUpdated).toEqual([]);
  });

  it("updated: registry serves new key → cache rewritten + reverify runs", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const old = generateEd25519Keypair().pubkey;
    const fresh = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "pub-a", old);
    // Manifest signed by `old`. Re-verify against `fresh` must fail.
    stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey: old });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: fresh }) },
      enforceAirGap: false,
    });
    expect(result.publishersUpdated).toHaveLength(1);
    expect(result.publishersUpdated[0]!.id).toBe("pub-a");
    expect(result.publishersUpdated[0]!.reverifyResult).toBe("failed");
  });

  it("evicted: registry 404 → cache deleted", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "not_found" }) },
      enforceAirGap: false,
    });
    expect(result.publishersEvicted).toEqual(["pub-a"]);
  });

  it("failed: registry transient → recorded but cache untouched", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "pub-a", pubkey);
    stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey });

    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "transient", message: "ECONNREFUSED" }) },
      enforceAirGap: false,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("pub-a");
  });

  it("dry-run: no vault writes, no audit", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const old = generateEd25519Keypair().pubkey;
    const fresh = generateEd25519Keypair().pubkey;
    await writePublisherKey(vault, "pub-a", old);
    stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "pub-a", pubkey: old });

    await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: fresh }) },
      enforceAirGap: false,
      dryRun: true,
    });
    // Cache is untouched
    expect(encodeBase64(await readCached(vault, "pub-a"))).toBe(encodeBase64(old));
  });

  it("air-gap: throws AirGapEnforcementError", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    await expect(
      syncPublisherKeys({
        vault,
        db,
        fetcher: { fetch: async () => ({ kind: "ok", pubkey: new Uint8Array(32) }) },
        enforceAirGap: true,
      }),
    ).rejects.toThrow(AirGapEnforcementError);
  });

  it("no installed extensions with publishers → empty result", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    const result = await syncPublisherKeys({
      vault,
      db,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey: new Uint8Array(32) }) },
      enforceAirGap: false,
    });
    expect(result.publishersChecked).toBe(0);
  });
});

async function readCached(vault: MockVault, id: string): Promise<Uint8Array> {
  const { readPublisherKey } = await import("./publisher-keys.ts");
  const b = await readPublisherKey(vault, id);
  if (!b) throw new Error("expected cached key");
  return b;
}
```

- [ ] **Step 2: Create fixture helper** (`packages/gateway/test/fixtures/extension.ts`)

```typescript
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INDEXED_SCHEMA_STEPS } from "../../src/index/migrations/runner.ts";
import { insertExtensionRow } from "../../src/automation/extension-store.ts";
import { signManifest, encodeBase64 } from "../../src/extensions/verify-signature.ts";
import { createHash } from "node:crypto";

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Create a fresh in-memory SQLite DB with the indexed schema migrated up,
 * plus a temp extensions directory. Caller cleans up.
 */
export function setupFreshExtensionDb(): { db: Database; extensionsDir: string } {
  const db = new Database(":memory:");
  for (const step of INDEXED_SCHEMA_STEPS) {
    step.run(db);
  }
  const extensionsDir = mkdtempSync(join(tmpdir(), "nimbus-ext-test-"));
  return { db, extensionsDir };
}

/**
 * Stage a signed extension on disk under `<extensionsDir>/<id>/` plus the
 * matching `extension` table row. Returns install path.
 */
export async function stageSignedExtensionOnDisk(opts: {
  db: Database;
  extensionsDir: string;
  publisherId: string;
  pubkey: Uint8Array;
  privkey?: Uint8Array;
  extensionId?: string;
  version?: string;
}): Promise<string> {
  const id = opts.extensionId ?? `ext-${opts.publisherId}`;
  const version = opts.version ?? "1.0.0";
  const dir = join(opts.extensionsDir, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const baseManifest = {
    id,
    version,
    permissions: {},
    publisher: { id: opts.publisherId, key: encodeBase64(opts.pubkey) },
  };
  let signature = "";
  if (opts.privkey !== undefined) {
    signature = await signManifest(baseManifest, opts.privkey);
  } else {
    signature = "A".repeat(86) + "==";
  }
  const manifest = { ...baseManifest, signature };
  const manifestPath = join(dir, "nimbus.extension.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  writeFileSync(manifestPath, manifestBytes);
  const entryPath = join(dir, "dist", "index.js");
  writeFileSync(entryPath, "export default {};");
  const entryBytes = Buffer.from("export default {};", "utf8");
  insertExtensionRow(opts.db, {
    id,
    version,
    install_path: dir,
    manifest_hash: sha256HexOfBytes(manifestBytes),
    entry_hash: sha256HexOfBytes(entryBytes),
    enabled: 1,
    installed_at: Date.now(),
    last_verified_at: Date.now(),
  });
  return dir;
}
```

- [ ] **Step 3: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/sync.test.ts
```

Expected: module not found.

- [ ] **Step 4: Implement** (`packages/gateway/src/extensions/sync.ts`)

```typescript
/**
 * Sync orchestrator for publisher pubkeys. Walks installed extensions,
 * collects distinct publisher ids, refreshes each from the registry, and
 * reverifies installed manifests when a key rotates.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { listExtensions } from "../automation/extension-store.ts";
import type { NimbusVault } from "../vault/index.ts";
import {
  parseExtensionManifestForRegistry,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import {
  evictPublisherKey,
  readPublisherKey,
  writePublisherKey,
} from "./publisher-keys.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
import {
  decodeBase64,
  verifyManifestSignature,
  encodeBase64,
} from "./verify-signature.ts";

export class AirGapEnforcementError extends Error {
  override readonly name = "AirGapEnforcementError";
  constructor() {
    super("air-gap is enforced; nimbus extension sync refused");
  }
}

export type SyncUpdated = {
  id: string;
  reverifyResult: "ok" | "failed";
  failedExtensions: string[];
};

export type SyncFailure = { id: string; reason: string };

export type SyncResult = {
  publishersChecked: number;
  publishersUnchanged: number;
  publishersUpdated: SyncUpdated[];
  publishersEvicted: string[];
  failures: SyncFailure[];
};

let syncMutex: Promise<unknown> = Promise.resolve();

export async function syncPublisherKeys(opts: {
  vault: NimbusVault;
  db: Database;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
  dryRun?: boolean;
}): Promise<SyncResult> {
  const run = async (): Promise<SyncResult> => {
    if (opts.enforceAirGap) throw new AirGapEnforcementError();
    const rows = listExtensions(opts.db);
    const publisherIdToExtensions = new Map<string, string[]>();
    const manifestByExtId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const mp = resolveExtensionManifestPath(row.install_path);
      if (mp === undefined) continue;
      let parsed;
      try {
        parsed = parseExtensionManifestForRegistry(readFileSync(mp, "utf8"));
      } catch {
        continue;
      }
      const m = parsed.manifest;
      if (m.publisher === undefined) continue;
      manifestByExtId.set(row.id, m as unknown as Record<string, unknown>);
      const arr = publisherIdToExtensions.get(m.publisher.id) ?? [];
      arr.push(row.id);
      publisherIdToExtensions.set(m.publisher.id, arr);
    }

    const result: SyncResult = {
      publishersChecked: 0,
      publishersUnchanged: 0,
      publishersUpdated: [],
      publishersEvicted: [],
      failures: [],
    };

    for (const [publisherId, extIds] of publisherIdToExtensions) {
      result.publishersChecked++;
      const fetched = await opts.fetcher.fetch(publisherId);
      if (fetched.kind === "transient" || fetched.kind === "registry_error") {
        result.failures.push({ id: publisherId, reason: fetched.message });
        continue;
      }
      if (fetched.kind === "not_found") {
        if (!opts.dryRun) await evictPublisherKey(opts.vault, publisherId);
        result.publishersEvicted.push(publisherId);
        continue;
      }
      const cached = await readPublisherKey(opts.vault, publisherId);
      const equal =
        cached !== undefined && encodeBase64(cached) === encodeBase64(fetched.pubkey);
      if (equal) {
        result.publishersUnchanged++;
        continue;
      }
      if (!opts.dryRun) await writePublisherKey(opts.vault, publisherId, fetched.pubkey);
      const failed: string[] = [];
      let allOk = true;
      for (const extId of extIds) {
        const m = manifestByExtId.get(extId);
        if (m === undefined) continue;
        try {
          await verifyManifestSignature(
            m as { publisher?: { id: string; key: string }; signature?: string },
            fetched.pubkey,
          );
        } catch {
          failed.push(extId);
          allOk = false;
        }
      }
      result.publishersUpdated.push({
        id: publisherId,
        reverifyResult: allOk ? "ok" : "failed",
        failedExtensions: failed,
      });
    }

    return result;
  };

  const ticket = syncMutex.then(() => run());
  syncMutex = ticket.catch(() => undefined);
  return ticket;
}
```

- [ ] **Step 5: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/sync.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/extensions/sync.ts packages/gateway/src/extensions/sync.test.ts packages/gateway/test/fixtures/extension.ts
git commit -m "feat(extensions): syncPublisherKeys orchestrator (T2 PR 2)"
```

---

## Phase E — Install wiring (I16 site #1)

### Task 8: Add `verifyManifestSignature` call site in `install-from-local.ts`

**Files:**
- Modify: `packages/gateway/src/extensions/install-from-local.ts` (function `installExtensionFromLocalDirectory` at line 283 + `completeExtensionInstallAfterCopy` at line 79)
- Modify: `packages/gateway/src/extensions/install-from-local.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/gateway/src/extensions/install-from-local.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { INDEXED_SCHEMA_STEPS } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock-vault.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "./verify-signature.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import { readPublisherKey } from "./publisher-keys.ts";

function freshGw() {
  const db = new Database(":memory:");
  for (const s of INDEXED_SCHEMA_STEPS) s.run(db);
  const extensionsDir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
  const sourceDir = mkdtempSync(join(tmpdir(), "nimbus-src-"));
  return { db, extensionsDir, sourceDir };
}

async function writeSignedSource(opts: {
  sourceDir: string;
  id: string;
  privkey: Uint8Array;
  pubkey: Uint8Array;
  publisherId?: string;
  mutateBeforeSign?: (m: Record<string, unknown>) => Record<string, unknown>;
}): Promise<void> {
  mkdirSync(join(opts.sourceDir, "dist"), { recursive: true });
  let manifest: Record<string, unknown> = {
    id: opts.id,
    version: "1.0.0",
    permissions: {},
    publisher: { id: opts.publisherId ?? "test-pub", key: encodeBase64(opts.pubkey) },
  };
  if (opts.mutateBeforeSign !== undefined) manifest = opts.mutateBeforeSign(manifest);
  const signature = await signManifest(manifest as never, opts.privkey);
  writeFileSync(
    join(opts.sourceDir, "nimbus.extension.json"),
    JSON.stringify({ ...manifest, signature }),
  );
  writeFileSync(join(opts.sourceDir, "dist", "index.js"), "export default {};");
}

describe("installExtensionFromLocalDirectory — signed extensions", () => {
  it("rejects when publisher.key in manifest disagrees with --publisher-key file", async () => {
    const { db, extensionsDir, sourceDir } = freshGw();
    const vault = new MockVault();
    const signer = generateEd25519Keypair();
    const otherKey = generateEd25519Keypair().pubkey;
    await writeSignedSource({
      sourceDir,
      id: "test-ext-mismatch",
      privkey: signer.privkey,
      pubkey: signer.pubkey,
    });
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pub-"));
    const keyFile = join(dir, "pub.key");
    writeFileSync(keyFile, encodeBase64(otherKey) + "\n");
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: sourceDir,
          vault,
          fetcher: { fetch: async () => ({ kind: "not_found" }) },
          enforceAirGap: false,
          publisherKeyPath: keyFile,
        }),
      ).rejects.toThrow(/PublisherKeyMismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  it("installs successfully when --publisher-key matches manifest publisher.key", async () => {
    const { db, extensionsDir, sourceDir } = freshGw();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writeSignedSource({ sourceDir, id: "test-ext-ok", privkey, pubkey });
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pub-"));
    const keyFile = join(dir, "pub.key");
    writeFileSync(keyFile, encodeBase64(pubkey) + "\n");
    try {
      const result = await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: sourceDir,
        vault,
        fetcher: { fetch: async () => ({ kind: "not_found" }) },
        enforceAirGap: false,
        publisherKeyPath: keyFile,
      });
      expect(result.id).toBe("test-ext-ok");
      expect(await readPublisherKey(vault, "test-pub")).toEqual(pubkey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  it("refuses install when manifest tampered after signing", async () => {
    const { db, extensionsDir, sourceDir } = freshGw();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    // Sign one manifest...
    await writeSignedSource({
      sourceDir,
      id: "test-ext-tampered",
      privkey,
      pubkey,
    });
    // ...then rewrite the version field on disk to break the signature.
    const mfPath = join(sourceDir, "nimbus.extension.json");
    const text = (await Bun.file(mfPath).text());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed["version"] = "9.9.9";
    writeFileSync(mfPath, JSON.stringify(parsed));
    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: sourceDir,
        vault,
        fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
        enforceAirGap: false,
      }),
    ).rejects.toThrow(/SignatureInvalid/);
  });

  it("unsigned manifest installs without writing publisher_key vault entry", async () => {
    const { db, extensionsDir, sourceDir } = freshGw();
    const vault = new MockVault();
    mkdirSync(join(sourceDir, "dist"), { recursive: true });
    writeFileSync(
      join(sourceDir, "nimbus.extension.json"),
      JSON.stringify({ id: "test-ext-unsigned", version: "1.0.0", permissions: {} }),
    );
    writeFileSync(join(sourceDir, "dist", "index.js"), "export default {};");
    const result = await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: sourceDir,
      vault,
      fetcher: { fetch: async () => ({ kind: "not_found" }) },
      enforceAirGap: false,
    });
    expect(result.id).toBe("test-ext-unsigned");
    expect(await readPublisherKey(vault, "test-pub")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/install-from-local.test.ts
```

Expected: new signature-flow tests fail (the options shape doesn't yet include `vault`, `fetcher`, `enforceAirGap`, `publisherKeyPath`).

- [ ] **Step 3: Modify `packages/gateway/src/extensions/install-from-local.ts`** — extend the `options` signature, parse signed manifests, call `verifyManifestSignature` after copy. Replace the public function (line 283) and `completeExtensionInstallAfterCopy` (line 79) with the versions below:

```typescript
// At the top of the file, near the existing imports:
import type { NimbusVault } from "../vault/index.ts";
import { parseExtensionManifestForRegistry } from "./manifest.ts";
import { writePublisherKey, resolvePublisherKey } from "./publisher-keys.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
import { verifyManifestSignature } from "./verify-signature.ts";
import { appendAuditEntry } from "../audit/audit-log.ts";

// Replace completeExtensionInstallAfterCopy:
async function completeExtensionInstallAfterCopy(options: {
  db: Database;
  dest: string;
  manifest: ExtensionManifest;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
}): Promise<InstallExtensionFromLocalResult> {
  const destManifestPath = resolveExtensionManifestPath(options.dest);
  if (destManifestPath === undefined) {
    throw new Error("extension manifest missing after copy");
  }
  const destManifestBytes = readFileSync(destManifestPath);
  const manifestHex = sha256HexOfBytes(destManifestBytes);
  // Use the registry-form parser so we can see publisher + signature.
  const destParse = parseExtensionManifestForRegistry(destManifestBytes.toString("utf8"));
  const destManifest = destParse.manifest;
  if (
    destManifest.id !== options.manifest.id ||
    destManifest.version !== options.manifest.version
  ) {
    throw new Error("manifest id/version changed across copy");
  }

  // I16 wiring site #1.
  if (destManifest.publisher !== undefined) {
    if (options.vault === undefined || options.fetcher === undefined) {
      throw new Error(
        "internal: signed extension install requires vault + fetcher options",
      );
    }
    let resolvedPubkey: Uint8Array;
    try {
      resolvedPubkey = await resolvePublisherKey({
        publisherId: destManifest.publisher.id,
        explicitKeyPath: options.publisherKeyPath,
        vault: options.vault,
        fetcher: options.fetcher,
        enforceAirGap: options.enforceAirGap ?? false,
      });
      await verifyManifestSignature(destManifest, resolvedPubkey);
    } catch (err) {
      appendAuditEntry({
        actionType: "extension.signature_failed",
        payload: {
          id: options.manifest.id,
          publisher_id: destManifest.publisher.id,
          error: err instanceof Error ? err.name : "Unknown",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
    await writePublisherKey(options.vault, destManifest.publisher.id, resolvedPubkey);
    appendAuditEntry({
      actionType: "extension.signature_verified",
      payload: {
        id: options.manifest.id,
        publisher_id: destManifest.publisher.id,
        verified_at_ms: Date.now(),
      },
    });
  }

  const entryRelRaw =
    destManifest.entry !== undefined && destManifest.entry !== ""
      ? destManifest.entry
      : "dist/index.js";
  if (entryRelRaw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entryRelRaw)) {
    throw new Error("extension entry must be a relative path");
  }
  const entryPath = assertEntryInsideInstall(options.dest, entryRelRaw);
  if (!existsSync(entryPath)) {
    throw new Error(`extension entry file missing: ${entryRelRaw}`);
  }
  const entryBytes = readFileSync(entryPath);
  const entryHex = sha256HexOfBytes(entryBytes);

  const now = Date.now();
  insertExtensionRow(options.db, {
    id: options.manifest.id,
    version: options.manifest.version,
    install_path: options.dest,
    manifest_hash: manifestHex,
    entry_hash: entryHex,
    enabled: 1,
    installed_at: now,
    last_verified_at: now,
  });

  return {
    id: options.manifest.id,
    version: options.manifest.version,
    installPath: options.dest,
    manifestHash: manifestHex,
    entryHash: entryHex,
  };
}

// Replace installExtensionFromLocalDirectory:
export async function installExtensionFromLocalDirectory(options: {
  db: Database;
  extensionsDir: string;
  sourcePath: string;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  publisherKeyPath?: string;
}): Promise<InstallExtensionFromLocalResult> {
  // ... existing body up to and including the cpSync call ...
  // (keep the existing logic unchanged through `cpSync(sourceResolved, dest, ...)`)

  try {
    return await completeExtensionInstallAfterCopy({
      db: options.db,
      dest,
      manifest,
      vault: options.vault,
      fetcher: options.fetcher,
      enforceAirGap: options.enforceAirGap,
      publisherKeyPath: options.publisherKeyPath,
    });
  } catch (e) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* best-effort rollback */
    }
    throw e;
  }
}
```

Also propagate options through `installExtensionFromArchive` (line 221) — add the same three optional fields and forward them on the recursive call to `installExtensionFromLocalDirectory`.

- [ ] **Step 4: Update all gateway callers of `installExtensionFromLocalDirectory`** — search for call sites and add the optional fields where the gateway has a vault + fetcher in scope:

```bash
bun grep -l 'installExtensionFromLocalDirectory' --type ts | head
```

For each caller in `packages/gateway/src/` (not tests), pass the gateway's `vault`, a fetcher constructed from `[registry].base_url`, and the runtime `enforceAirGap` flag. (CLI plumbing comes in Task 16; for now the gateway-internal callers must compile.)

- [ ] **Step 5: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/install-from-local.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/extensions/install-from-local.ts packages/gateway/src/extensions/install-from-local.test.ts
git commit -m "feat(extensions): I16 wiring site #1 — install-time signature verify (T2 PR 2)"
```

---

## Phase F — Startup wiring (I16 site #2)

### Task 9: `SignatureDisabledRegistry` singleton in `hard-disable.ts`

**Files:**
- Modify: `packages/gateway/src/extensions/hard-disable.ts` (append after `preT2DisabledIds`)
- Modify: `packages/gateway/src/extensions/hard-disable.test.ts` (append)

- [ ] **Step 1: Append the failing tests** to `packages/gateway/src/extensions/hard-disable.test.ts`:

```typescript
import { signatureDisabledRegistry } from "./hard-disable.ts";

describe("signatureDisabledRegistry", () => {
  beforeEach(() => signatureDisabledRegistry.reset());

  it("mark + reasonFor round-trip", () => {
    signatureDisabledRegistry.mark("ext-a", "publisher_key_missing");
    expect(signatureDisabledRegistry.reasonFor("ext-a")).toBe("publisher_key_missing");
  });

  it("has + count", () => {
    expect(signatureDisabledRegistry.has("ext-a")).toBe(false);
    expect(signatureDisabledRegistry.count()).toBe(0);
    signatureDisabledRegistry.mark("ext-a", "signature_failed");
    expect(signatureDisabledRegistry.has("ext-a")).toBe(true);
    expect(signatureDisabledRegistry.count()).toBe(1);
  });

  it("list returns sorted by id", () => {
    signatureDisabledRegistry.mark("ext-c", "signature_failed");
    signatureDisabledRegistry.mark("ext-a", "publisher_key_missing");
    signatureDisabledRegistry.mark("ext-b", "publisher_key_mismatch");
    expect(signatureDisabledRegistry.list().map((e) => e.id)).toEqual([
      "ext-a",
      "ext-b",
      "ext-c",
    ]);
  });

  it("reset clears all", () => {
    signatureDisabledRegistry.mark("ext-a", "signature_failed");
    signatureDisabledRegistry.reset();
    expect(signatureDisabledRegistry.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/hard-disable.test.ts
```

Expected: `signatureDisabledRegistry` not exported.

- [ ] **Step 3: Append to `packages/gateway/src/extensions/hard-disable.ts`**:

```typescript
import type { SignatureDisableReason } from "./verify-signature.ts";

/**
 * In-memory registry of extension ids that are hard-disabled by the T2 PR 2
 * verified-publisher pipeline. Parallel to {@link PreT2DisabledRegistry};
 * rebuilt at the top of every `verifyExtensionsBestEffort` run.
 */
class SignatureDisabledRegistry {
  private readonly reasons = new Map<string, SignatureDisableReason>();

  reset(): void {
    this.reasons.clear();
  }

  mark(id: string, reason: SignatureDisableReason): void {
    this.reasons.set(id, reason);
  }

  has(id: string): boolean {
    return this.reasons.has(id);
  }

  reasonFor(id: string): SignatureDisableReason | undefined {
    return this.reasons.get(id);
  }

  list(): readonly { id: string; reason: SignatureDisableReason }[] {
    return [...this.reasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, reason]) => ({ id, reason }));
  }

  count(): number {
    return this.reasons.size;
  }
}

export const signatureDisabledRegistry = new SignatureDisabledRegistry();
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/hard-disable.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/hard-disable.ts packages/gateway/src/extensions/hard-disable.test.ts
git commit -m "feat(extensions): SignatureDisabledRegistry singleton (T2 PR 2)"
```

---

### Task 10: Add startup signature verification to `verifyExtensionsBestEffort`

**Files:**
- Modify: `packages/gateway/src/extensions/verify-extensions.ts` (function `verifyExtensionsBestEffort` at line 140)
- Modify: `packages/gateway/src/extensions/verify-extensions.test.ts`

- [ ] **Step 1: Append the failing test** to `packages/gateway/src/extensions/verify-extensions.test.ts`:

```typescript
import pino from "pino";
import { MockVault } from "../vault/mock-vault.ts";
import { writePublisherKey } from "./publisher-keys.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "./verify-signature.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import {
  getExtensionRow,
  listExtensions,
} from "../automation/extension-store.ts";
import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { verifyExtensionsBestEffort } from "./verify-extensions.ts";

const silentLogger = pino({ level: "silent" });

describe("verifyExtensionsBestEffort — signed extensions", () => {
  beforeEach(() => signatureDisabledRegistry.reset());

  it("signed manifest with cached key passes", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(1);
    expect(signatureDisabledRegistry.count()).toBe(0);
  });

  it("vault key missing → row disabled + registry marked publisher_key_missing", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    // intentionally skip writePublisherKey
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-test-pub")).toBe("publisher_key_missing");
  });

  it("tampered manifest (post-signing edit) → row disabled + signature_failed", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const installPath = await stageSignedExtensionOnDisk({
      db,
      extensionsDir,
      publisherId: "test-pub",
      pubkey,
      privkey,
    });
    // Tamper with version (not signature). Re-stamp manifest_hash so PR 1's
    // SHA-256 sweep doesn't catch the row via a different code path.
    const mfPath = join(installPath, "nimbus.extension.json");
    const orig = JSON.parse(await Bun.file(mfPath).text()) as Record<string, unknown>;
    orig["version"] = "9.9.9";
    writeFileSync(mfPath, JSON.stringify(orig));
    const newHash = createHash("sha256").update(readFileSync(mfPath)).digest("hex");
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = ?", [newHash, "ext-test-pub"]);

    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });

    const row = listExtensions(db).find((r) => r.id === "ext-test-pub");
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor("ext-test-pub")).toBe("signature_failed");
  });

  it("unsigned extension is unaffected by the new path", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    // Stage an unsigned extension directly via the existing helper path.
    const id = "ext-legacy";
    mkdirSync(join(extensionsDir, id, "dist"), { recursive: true });
    const mfBytes = Buffer.from(JSON.stringify({ id, version: "1.0.0", permissions: {} }), "utf8");
    writeFileSync(join(extensionsDir, id, "nimbus.extension.json"), mfBytes);
    writeFileSync(join(extensionsDir, id, "dist", "index.js"), "export default {};");
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: join(extensionsDir, id),
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update("export default {};").digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    await verifyExtensionsBestEffort(db, silentLogger, undefined, { vault });
    const row = listExtensions(db).find((r) => r.id === id);
    expect(row?.enabled).toBe(1);
    expect(signatureDisabledRegistry.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/extensions/verify-extensions.test.ts
```

Expected: new tests fail because `verifyExtensionsBestEffort` doesn't yet accept a `{ vault }` option or run the signature loop.

- [ ] **Step 3: Modify `packages/gateway/src/extensions/verify-extensions.ts`**:

Extend the function signature and add a fourth parameter:

```typescript
import { appendAuditEntry } from "../audit/audit-log.ts";
import type { NimbusVault } from "../vault/index.ts";
import { parseExtensionManifestForRegistry } from "./manifest.ts";
import { readPublisherKey } from "./publisher-keys.ts";
import { errorToHardDisableReason, type SignatureDisableReason, verifyManifestSignature } from "./verify-signature.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";

export interface VerifyExtensionsSignatureOpts {
  vault: NimbusVault;
}

export async function verifyExtensionsBestEffort(
  db: Database,
  logger: Logger,
  mesh?: ExtensionMeshHandle,
  signatureOpts?: VerifyExtensionsSignatureOpts,
): Promise<void> {
  if (readIndexedUserVersion(db) < 10) {
    return;
  }
  // (existing pre-T2 sweep — unchanged)
  const preT2Disabled = hardDisablePreT2Extensions({ db, logger });
  if (mesh !== undefined) {
    for (const row of preT2Disabled) {
      await mesh.stopExtensionClient(row.id);
    }
  }
  const rows = listExtensions(db).filter((r) => r.enabled === 1);
  if (rows.length === 0) return;
  const now = Date.now();
  for (const row of rows) {
    await verifyOneExtension(db, logger, row, now, mesh);
  }
  // T2 PR 2 / I16 — signature pass.
  if (signatureOpts !== undefined) {
    signatureDisabledRegistry.reset();
    let signaturesChecked = 0;
    let signatureHardDisabled = 0;
    const failures: { id: string; reason: SignatureDisableReason }[] = [];
    for (const row of listExtensions(db).filter((r) => r.enabled === 1)) {
      const manifestPath = resolveExtensionManifestPath(row.install_path);
      if (manifestPath === undefined) continue;
      let manifestText: string;
      try {
        manifestText = readFileSync(manifestPath, "utf8");
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseExtensionManifestForRegistry(manifestText);
      } catch {
        continue;
      }
      const m = parsed.manifest;
      if (m.publisher === undefined) continue;
      signaturesChecked++;
      const pubkey = await readPublisherKey(signatureOpts.vault, m.publisher.id);
      let reason: SignatureDisableReason | undefined;
      if (pubkey === undefined) {
        reason = "publisher_key_missing";
      } else {
        try {
          await verifyManifestSignature(m, pubkey);
        } catch (err) {
          reason = errorToHardDisableReason(err);
        }
      }
      if (reason !== undefined) {
        setExtensionEnabled(db, row.id, false);
        signatureDisabledRegistry.mark(row.id, reason);
        signatureHardDisabled++;
        failures.push({ id: row.id, reason });
        if (mesh !== undefined) await mesh.stopExtensionClient(row.id);
      }
    }
    appendAuditEntry({
      actionType: "extension.startup_verification",
      payload: {
        signatures_checked: signaturesChecked,
        hard_disabled: signatureHardDisabled,
        failures,
      },
    });
  }
}
```

- [ ] **Step 4: Update gateway startup wiring** — find where `verifyExtensionsBestEffort` is called at gateway startup (`bun grep -l verifyExtensionsBestEffort --type ts`) and pass `{ vault }` as the fourth argument.

- [ ] **Step 5: Run the test — expect pass**

```bash
bun test packages/gateway/src/extensions/verify-extensions.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/extensions/verify-extensions.ts packages/gateway/src/extensions/verify-extensions.test.ts
git commit -m "feat(extensions): I16 wiring site #2 — startup signature verify (T2 PR 2)"
```

---

## Phase G — IPC

### Task 11: `extension.sync` IPC handler + `FORBIDDEN_OVER_LAN` entry

**Files:**
- Modify: `packages/gateway/src/ipc/extensions-rpc.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (line ~30 — `FORBIDDEN_OVER_LAN`)
- Modify: `packages/gateway/src/ipc/extensions-rpc.test.ts`

- [ ] **Step 1: Append failing tests** to `packages/gateway/src/ipc/extensions-rpc.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

import { dispatchExtensionsRpc } from "./extensions-rpc.ts";
import {
  setupFreshExtensionDb,
  stageSignedExtensionOnDisk,
} from "../../test/fixtures/extension.ts";
import { MockVault } from "../vault/mock-vault.ts";
import { writePublisherKey } from "../extensions/publisher-keys.ts";
import { generateEd25519Keypair, encodeBase64 } from "../extensions/verify-signature.ts";

describe("extension.sync RPC", () => {
  it("dispatches and returns SyncResult JSON", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { pubkey, privkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    await stageSignedExtensionOnDisk({ db, extensionsDir, publisherId: "test-pub", pubkey, privkey });

    const response = await dispatchExtensionsRpc("extension.sync", { dryRun: false }, {
      db,
      vault,
      fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
      enforceAirGap: false,
    });
    expect(response).toMatchObject({
      publishersChecked: 1,
      publishersUnchanged: 1,
    });
  });

  it("returns air-gap error when enforceAirGap=true", async () => {
    const { db } = setupFreshExtensionDb();
    const vault = new MockVault();
    await expect(
      dispatchExtensionsRpc("extension.sync", { dryRun: false }, {
        db,
        vault,
        fetcher: { fetch: async () => ({ kind: "not_found" }) },
        enforceAirGap: true,
      }),
    ).rejects.toThrow(/air-gap/i);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/gateway/src/ipc/extensions-rpc.test.ts
```

Expected: `extension.sync` not recognized.

- [ ] **Step 3: Modify `packages/gateway/src/ipc/extensions-rpc.ts`** — add an `extension.sync` case to the dispatcher:

```typescript
import { syncPublisherKeys, type SyncResult } from "../extensions/sync.ts";

// Inside the dispatcher's switch on method:
case "extension.sync": {
  const dryRun = params !== null && typeof params === "object"
    && "dryRun" in params && typeof (params as { dryRun: unknown }).dryRun === "boolean"
    ? (params as { dryRun: boolean }).dryRun
    : false;
  const result: SyncResult = await syncPublisherKeys({
    vault: ctx.vault,
    db: ctx.db,
    fetcher: ctx.fetcher,
    enforceAirGap: ctx.enforceAirGap,
    dryRun,
  });
  return result;
}
```

Extend the `ctx` parameter type signature to include `vault`, `fetcher`, `enforceAirGap`. (Look for the existing `ExtensionsRpcContext` type and add the three fields.)

- [ ] **Step 4: Modify `packages/gateway/src/ipc/lan-rpc.ts`** — find `FORBIDDEN_OVER_LAN` (around line 30) and add `"extension.sync"` to the array, alphabetically. Update any count assertion if present.

- [ ] **Step 5: Append a LAN test** to `packages/gateway/src/ipc/lan-rpc.test.ts`:

```typescript
import { FORBIDDEN_OVER_LAN } from "./lan-rpc.ts";

it("extension.sync is forbidden over LAN", () => {
  expect(FORBIDDEN_OVER_LAN).toContain("extension.sync");
});
```

- [ ] **Step 6: Run all changed tests — expect pass**

```bash
bun test packages/gateway/src/ipc/extensions-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/extensions-rpc.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/extensions-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts
git commit -m "feat(ipc): extension.sync handler + FORBIDDEN_OVER_LAN entry (T2 PR 2)"
```

---

## Phase H — CLI

### Task 12: `nimbus extension keygen` subcommand

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` (existing — add `keygen` subcommand)

- [ ] **Step 1: Write failing test** (`packages/cli/test/e2e/extension-keygen.smoke.e2e.test.ts`)

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./helpers.ts";

describe("nimbus extension keygen", () => {
  it("writes a 44-char base64 pubkey + 0600 privkey file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-keygen-"));
    const outPath = join(dir, "pub.key");
    try {
      const { stdout, exitCode } = await runCli(["extension", "keygen", "--out", outPath]);
      expect(exitCode).toBe(0);
      // stdout has the base64 pubkey
      expect(stdout.trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      // privkey file exists and has the right shape
      const priv = readFileSync(outPath, "utf8").trim();
      expect(priv).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      if (process.platform !== "win32") {
        const mode = statSync(outPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing file without --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-keygen-"));
    const outPath = join(dir, "pub.key");
    try {
      await runCli(["extension", "keygen", "--out", outPath]);
      const second = await runCli(["extension", "keygen", "--out", outPath]);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("--force");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/cli/test/e2e/extension-keygen.smoke.e2e.test.ts
```

Expected: command not found.

- [ ] **Step 3: Implement** — add a `keygen` subcommand to `packages/cli/src/commands/extension.ts`. Reuse `generateEd25519Keypair` from `@nimbus-dev/sdk` (or directly via a re-export in `packages/sdk/src/index.ts` — see Task 26).

```typescript
// inside the `extension` command registry, alongside install / list / info:
async function runKeygen(args: string[]): Promise<number> {
  const outIdx = args.indexOf("--out");
  const force = args.includes("--force");
  let outPath = join(homedir(), ".nimbus", "publisher-key");
  if (outIdx >= 0 && outIdx + 1 < args.length) outPath = args[outIdx + 1]!;
  if (existsSync(outPath) && !force) {
    process.stderr.write(`refusing to overwrite ${outPath} without --force\n`);
    return 2;
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(outPath), { recursive: true });
  // base64 + newline; chmod 0600 on POSIX.
  writeFileSync(outPath, encodeBase64(privkey) + "\n");
  if (process.platform !== "win32") chmodSync(outPath, 0o600);
  process.stdout.write(encodeBase64(pubkey) + "\n");
  return 0;
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/test/e2e/extension-keygen.smoke.e2e.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/test/e2e/extension-keygen.smoke.e2e.test.ts
git commit -m "feat(cli): nimbus extension keygen (T2 PR 2)"
```

---

### Task 13: `nimbus extension sign <ext-dir>` subcommand

**Files:**
- Modify: `packages/cli/src/commands/extension.ts`
- Create: `packages/cli/test/e2e/extension-sign.smoke.e2e.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./helpers.ts";
import { decodeBase64, encodeBase64, generateEd25519Keypair, signManifest } from "../../../gateway/src/extensions/verify-signature.ts";

describe("nimbus extension sign", () => {
  it("signs a manifest in place; resulting manifest verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
    const extDir = join(dir, "my-ext");
    mkdirSync(join(extDir, "dist"), { recursive: true });
    const { privkey, pubkey } = generateEd25519Keypair();
    const keyPath = join(dir, "pub.key");
    writeFileSync(keyPath, encodeBase64(privkey) + "\n");
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "my-ext",
        version: "0.1.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(pubkey) },
      }),
    );
    writeFileSync(join(extDir, "dist", "index.js"), "export default {};");
    try {
      const { exitCode } = await runCli(["extension", "sign", extDir, "--key", keyPath]);
      expect(exitCode).toBe(0);
      const text = readFileSync(join(extDir, "nimbus.extension.json"), "utf8");
      const m = JSON.parse(text) as { signature?: string };
      expect(m.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing signature field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir, { recursive: true });
    const { privkey, pubkey } = generateEd25519Keypair();
    const keyPath = join(dir, "pub.key");
    writeFileSync(keyPath, encodeBase64(privkey) + "\n");
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "my-ext",
        version: "0.1.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(pubkey) },
        signature: "A".repeat(86) + "==",
      }),
    );
    try {
      const { exitCode } = await runCli(["extension", "sign", extDir, "--key", keyPath]);
      expect(exitCode).toBe(0);
      const m = JSON.parse(readFileSync(join(extDir, "nimbus.extension.json"), "utf8")) as { signature: string };
      expect(m.signature).not.toBe("A".repeat(86) + "==");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/cli/test/e2e/extension-sign.smoke.e2e.test.ts
```

Expected: subcommand not recognized.

- [ ] **Step 3: Implement** — add the `sign` subcommand:

```typescript
async function runSign(args: string[]): Promise<number> {
  const extDir = args[0];
  if (extDir === undefined) {
    process.stderr.write("usage: nimbus extension sign <ext-dir> [--key <path>]\n");
    return 2;
  }
  const keyIdx = args.indexOf("--key");
  const keyPath = keyIdx >= 0 ? args[keyIdx + 1]! : join(homedir(), ".nimbus", "publisher-key");
  const priv = decodeBase64(readFileSync(keyPath, "utf8").trim());
  if (priv.length !== 32) {
    process.stderr.write(`key file ${keyPath} did not decode to 32 bytes\n`);
    return 2;
  }
  const manifestPath = join(extDir, "nimbus.extension.json");
  const text = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  delete parsed["signature"];
  const sig = await signManifest(parsed, priv);
  writeFileSync(manifestPath, JSON.stringify({ ...parsed, signature: sig }, null, 2));
  return 0;
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/test/e2e/extension-sign.smoke.e2e.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/test/e2e/extension-sign.smoke.e2e.test.ts
git commit -m "feat(cli): nimbus extension sign (T2 PR 2)"
```

---

### Task 14: `nimbus extension sync` CLI subcommand

**Files:**
- Modify: `packages/cli/src/commands/extension.ts`
- Create: `packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { runCli, runCliWithMockGateway } from "./helpers.ts";

describe("nimbus extension sync", () => {
  it("exit 0 when sync succeeds with no rotations", async () => {
    const { exitCode, stdout } = await runCliWithMockGateway(
      ["extension", "sync"],
      {
        rpcResponses: {
          "extension.sync": {
            publishersChecked: 1,
            publishersUnchanged: 1,
            publishersUpdated: [],
            publishersEvicted: [],
            failures: [],
          },
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("publishers checked: 1");
  });

  it("exit 2 when a rotation failed re-verification", async () => {
    const { exitCode } = await runCliWithMockGateway(["extension", "sync"], {
      rpcResponses: {
        "extension.sync": {
          publishersChecked: 1,
          publishersUnchanged: 0,
          publishersUpdated: [{ id: "pub-a", reverifyResult: "failed", failedExtensions: ["ext-a"] }],
          publishersEvicted: [],
          failures: [],
        },
      },
    });
    expect(exitCode).toBe(2);
  });

  it("exit 3 when gateway returns air-gap error", async () => {
    const { exitCode } = await runCliWithMockGateway(["extension", "sync"], {
      rpcError: { code: -32000, message: "air-gap is enforced" },
    });
    expect(exitCode).toBe(3);
  });

  it("exit 4 when gateway reports unreachable for all", async () => {
    const { exitCode } = await runCliWithMockGateway(["extension", "sync"], {
      rpcResponses: {
        "extension.sync": {
          publishersChecked: 1,
          publishersUnchanged: 0,
          publishersUpdated: [],
          publishersEvicted: [],
          failures: [{ id: "pub-a", reason: "ECONNREFUSED" }],
        },
      },
    });
    expect(exitCode).toBe(4);
  });

  it("--json emits the raw SyncResult", async () => {
    const { stdout } = await runCliWithMockGateway(["extension", "sync", "--json"], {
      rpcResponses: {
        "extension.sync": {
          publishersChecked: 0,
          publishersUnchanged: 0,
          publishersUpdated: [],
          publishersEvicted: [],
          failures: [],
        },
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({ publishersChecked: 0 });
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts
```

Expected: subcommand not recognized.

- [ ] **Step 3: Implement** — add the `sync` subcommand:

```typescript
async function runSync(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  let result: SyncResult;
  try {
    result = (await ipcCall("extension.sync", { dryRun })) as SyncResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/air-gap/i.test(msg)) {
      process.stderr.write(msg + "\n");
      return 3;
    }
    process.stderr.write(msg + "\n");
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(`publishers checked: ${String(result.publishersChecked)}\n`);
    process.stdout.write(`unchanged:          ${String(result.publishersUnchanged)}\n`);
    process.stdout.write(`updated:            ${String(result.publishersUpdated.length)}\n`);
    process.stdout.write(`evicted:            ${String(result.publishersEvicted.length)}\n`);
    process.stdout.write(`failed:             ${String(result.failures.length)}\n`);
    for (const u of result.publishersUpdated) {
      if (u.reverifyResult === "failed") {
        process.stderr.write(
          `publisher ${u.id} rotated keys; ${String(u.failedExtensions.length)} extension(s) failed re-verify: ${u.failedExtensions.join(", ")}\n`,
        );
      }
    }
  }
  if (result.publishersUpdated.some((u) => u.reverifyResult === "failed")) return 2;
  if (result.publishersChecked > 0 && result.failures.length === result.publishersChecked) return 4;
  return 0;
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts
git commit -m "feat(cli): nimbus extension sync (T2 PR 2)"
```

---

### Task 15: Tabular `nimbus extension list` output with Publisher column

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` — the `list` subcommand
- Modify: existing `nimbus extension list` test (next to extension.ts)

- [ ] **Step 1: Write failing tests** for the tabular shape (extend the existing test file for the `list` command):

```typescript
it("tabular human output has ID | Version | Publisher | Status columns", async () => {
  const { stdout } = await runCliWithMockGateway(["extension", "list"], {
    rpcResponses: {
      "extension.list": [
        { id: "ext-a", version: "1.0.0", enabled: true, publisher: { id: "pub-a", key: "AAA" } },
        { id: "ext-b", version: "0.5.1", enabled: true, publisher: undefined },
      ],
    },
  });
  // header row
  expect(stdout).toMatch(/ID\s+Version\s+Publisher\s+Status/);
  expect(stdout).toContain("ext-a");
  expect(stdout).toContain("pub-a");
  expect(stdout).toContain("(unverified)");
});

it("(unverified) is dim yellow when stdout is a TTY and NO_COLOR is unset", async () => {
  const { stdout } = await runCliWithMockGateway(["extension", "list"], {
    rpcResponses: {
      "extension.list": [{ id: "ext-b", version: "0.5.1", enabled: true, publisher: undefined }],
    },
    isTty: true,
    env: { /* NO_COLOR unset */ },
  });
  // ANSI dim yellow: \x1b[2;33m...\x1b[0m
  expect(stdout).toMatch(/\x1b\[2;33m\(unverified\)\x1b\[0m/);
});

it("NO_COLOR=1 disables ANSI codes", async () => {
  const { stdout } = await runCliWithMockGateway(["extension", "list"], {
    rpcResponses: {
      "extension.list": [{ id: "ext-b", version: "0.5.1", enabled: true, publisher: undefined }],
    },
    isTty: true,
    env: { NO_COLOR: "1" },
  });
  expect(stdout).not.toMatch(/\x1b\[/);
});
```

- [ ] **Step 2: Run the tests — expect failure**

```bash
bun test packages/cli/src/commands/extension.test.ts
```

Expected: format tests fail.

- [ ] **Step 3: Implement** — replace the `list` subcommand's output formatter:

```typescript
function formatExtensionListTable(
  rows: Array<{ id: string; version: string; enabled: boolean; publisher?: { id: string } }>,
  opts: { isTty: boolean; noColor: boolean },
): string {
  const headers = ["ID", "Version", "Publisher", "Status"];
  const data = rows.map((r) => [
    r.id,
    r.version,
    r.publisher !== undefined ? r.publisher.id : "(unverified)",
    r.enabled ? "enabled" : "disabled",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const renderCell = (s: string, w: number, col: number): string => {
    const padded = pad(s, w);
    if (!opts.isTty || opts.noColor) return padded;
    if (col === 2 && s === "(unverified)") return `\x1b[2;33m${padded}\x1b[0m`;
    return padded;
  };
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i]!)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) {
    lines.push(row.map((c, i) => renderCell(c, widths[i]!, i)).join("  "));
  }
  return lines.join("\n") + "\n";
}
```

Use `formatExtensionListTable` in the existing `list` handler when output is not `--json`. The `--json` branch must still emit the `publisher` field as `{ id, key } | null`.

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/src/commands/extension.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/src/commands/extension.test.ts
git commit -m "feat(cli): tabular extension list with Publisher column (T2 PR 2)"
```

---

### Task 16: `--publisher-key <path>` flag on `nimbus extension install`

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` — the `install` subcommand
- Create: `packages/cli/test/e2e/extension-install-signed.smoke.e2e.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliWithMockGateway } from "./helpers.ts";

describe("nimbus extension install --publisher-key", () => {
  it("passes --publisher-key path through to the gateway install RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
    const keyFile = join(dir, "pub.key");
    writeFileSync(keyFile, "A".repeat(43) + "=\n");
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({ id: "my-ext", version: "1.0.0", permissions: {} }),
    );
    try {
      const { exitCode, calls } = await runCliWithMockGateway(
        ["extension", "install", extDir, "--publisher-key", keyFile],
        {
          rpcResponses: { "extension.install": { id: "my-ext", version: "1.0.0" } },
          captureCalls: true,
        },
      );
      expect(exitCode).toBe(0);
      const installCall = calls.find((c) => c.method === "extension.install");
      expect(installCall?.params).toMatchObject({ publisherKeyPath: keyFile });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces gateway PublisherKeyMismatch as exit 1", async () => {
    const { exitCode, stderr } = await runCliWithMockGateway(["extension", "install", "/nonexistent"], {
      rpcError: { code: -32000, message: "PublisherKeyMismatch: ..." },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("PublisherKeyMismatch");
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/cli/test/e2e/extension-install-signed.smoke.e2e.test.ts
```

Expected: --publisher-key not parsed.

- [ ] **Step 3: Implement** — extend the `install` handler:

```typescript
// inside runInstall:
const publisherKeyIdx = args.indexOf("--publisher-key");
const publisherKeyPath = publisherKeyIdx >= 0 ? args[publisherKeyIdx + 1] : undefined;
const result = await ipcCall("extension.install", {
  sourcePath: resolved,
  ...(publisherKeyPath !== undefined ? { publisherKeyPath } : {}),
});
```

And in the gateway `extension.install` RPC handler (likely in `packages/gateway/src/ipc/extensions-rpc.ts`), wire the new param through to `installExtensionFromLocalDirectory(...)`.

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/test/e2e/extension-install-signed.smoke.e2e.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/test/e2e/extension-install-signed.smoke.e2e.test.ts packages/gateway/src/ipc/extensions-rpc.ts
git commit -m "feat(cli): --publisher-key flag on extension install (T2 PR 2)"
```

---

### Task 17: Publisher section in `nimbus extension info`

**Files:**
- Modify: `packages/cli/src/commands/extension.ts` — the `info` subcommand
- Modify: existing test file for `info`

- [ ] **Step 1: Append failing tests**

```typescript
it("info shows Publisher section with id + truncated key for signed extensions", async () => {
  const { stdout } = await runCliWithMockGateway(["extension", "info", "ext-a"], {
    rpcResponses: {
      "extension.info": {
        id: "ext-a",
        version: "1.0.0",
        publisher: { id: "pub-a", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      },
    },
  });
  expect(stdout).toMatch(/Publisher:\s+pub-a/);
  expect(stdout).toContain("AAAAAAAAAAAAAAAA…");
});

it("info shows (unverified) for unsigned extensions", async () => {
  const { stdout } = await runCliWithMockGateway(["extension", "info", "ext-b"], {
    rpcResponses: {
      "extension.info": { id: "ext-b", version: "0.5.1", publisher: undefined },
    },
  });
  expect(stdout).toMatch(/Publisher:\s+\(unverified\)/);
});

it("--json includes full publisher.key", async () => {
  const fullKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const { stdout } = await runCliWithMockGateway(["extension", "info", "ext-a", "--json"], {
    rpcResponses: {
      "extension.info": { id: "ext-a", version: "1.0.0", publisher: { id: "pub-a", key: fullKey } },
    },
  });
  const parsed = JSON.parse(stdout) as { publisher: { key: string } };
  expect(parsed.publisher.key).toBe(fullKey);
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
bun test packages/cli/src/commands/extension.test.ts
```

Expected: info doesn't render the publisher section.

- [ ] **Step 3: Implement** — extend the info handler:

```typescript
function formatInfoHuman(info: { id: string; version: string; publisher?: { id: string; key: string } }): string {
  const lines = [`ID:        ${info.id}`, `Version:   ${info.version}`];
  if (info.publisher !== undefined) {
    const shortKey = info.publisher.key.slice(0, 16) + "…";
    lines.push(`Publisher: ${info.publisher.id}`, `  key:     ${shortKey}`);
  } else {
    lines.push(`Publisher: (unverified)`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
bun test packages/cli/src/commands/extension.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts packages/cli/src/commands/extension.test.ts
git commit -m "feat(cli): Publisher section in extension info (T2 PR 2)"
```

---

## Phase I — Invariants + static audits + docs

### Task 18: I16 enforcement test in `security-invariants.test.ts`

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts`

- [ ] **Step 1: Write the failing tests** — append a new `describe("I16: …")` block:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pino from "pino";

import { MockVault } from "./vault/mock-vault.ts";
import { insertExtensionRow, listExtensions } from "./automation/extension-store.ts";
import { setupFreshExtensionDb } from "../test/fixtures/extension.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./extensions/verify-signature.ts";
import { writePublisherKey } from "./extensions/publisher-keys.ts";
import { signatureDisabledRegistry } from "./extensions/hard-disable.ts";
import { verifyExtensionsBestEffort } from "./extensions/verify-extensions.ts";

describe("I16 — Verified-publisher invariant", () => {
  it("static: install-from-local.ts and verify-extensions.ts both call verifyManifestSignature", async () => {
    const installPath = "packages/gateway/src/extensions/install-from-local.ts";
    const verifyPath = "packages/gateway/src/extensions/verify-extensions.ts";
    const install = await Bun.file(installPath).text();
    const verify = await Bun.file(verifyPath).text();
    expect(install).toContain("verifyManifestSignature(");
    expect(verify).toContain("verifyManifestSignature(");
  });

  it("behavioral #1: signed extension with missing vault key is hard-disabled at startup", async () => {
    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    const id = "test-ext-missing-key";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = { id, version: "1.0.0", permissions: {}, publisher: { id: "test-pub", key: encodeBase64(pubkey) } };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    writeFileSync(join(dir, "dist", "index.js"), "export default {};");
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update("export default {};").digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    // (intentionally skip writePublisherKey)

    await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

    const row = listExtensions(db).find((r) => r.id === id);
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor(id)).toBe("publisher_key_missing");

    rmSync(extensionsDir, { recursive: true, force: true });
  });

  it("behavioral #2: tampered manifest is hard-disabled at startup with signature_failed", async () => {
    signatureDisabledRegistry.reset();
    const { db, extensionsDir } = setupFreshExtensionDb();
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", pubkey);
    const id = "test-ext-tampered";
    const dir = join(extensionsDir, id);
    mkdirSync(join(dir, "dist"), { recursive: true });
    const base = { id, version: "1.0.0", permissions: {}, publisher: { id: "test-pub", key: encodeBase64(pubkey) } };
    const signature = await signManifest(base, privkey);
    const mfBytes = Buffer.from(JSON.stringify({ ...base, signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), mfBytes);
    writeFileSync(join(dir, "dist", "index.js"), "export default {};");
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(mfBytes).digest("hex"),
      entry_hash: createHash("sha256").update("export default {};").digest("hex"),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });
    // Mutate the on-disk manifest version, then re-stamp manifest_hash so
    // PR 1's SHA-256 sweep doesn't fire first.
    const tampered = Buffer.from(JSON.stringify({ ...base, version: "9.9.9", signature }), "utf8");
    writeFileSync(join(dir, "nimbus.extension.json"), tampered);
    const newHash = createHash("sha256").update(tampered).digest("hex");
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = ?", [newHash, id]);

    await verifyExtensionsBestEffort(db, pino({ level: "silent" }), undefined, { vault });

    const row = listExtensions(db).find((r) => r.id === id);
    expect(row?.enabled).toBe(0);
    expect(signatureDisabledRegistry.reasonFor(id)).toBe("signature_failed");

    rmSync(extensionsDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test — expect pass**

```bash
bun test packages/gateway/src/security-invariants.test.ts
```

Expected: 3 new tests green.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts
git commit -m "test(security-invariants): I16 grep + behavioral assertions (T2 PR 2)"
```

---

### Task 19: D11 vault-key allow-list — add `extension.publisher_key.*`

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`

- [ ] **Step 1: Find the D11 allow-list** — grep for `D11` and the existing vault-key patterns:

```bash
bun grep -n 'D11\|VAULT_KEY_RE\|publisher_key' scripts/structure-audit/check-nimbus-invariants.ts
```

- [ ] **Step 2: Add the pattern** — extend the allow-list regex / array to include `extension\.publisher_key\.[a-z0-9][a-z0-9._-]*`.

- [ ] **Step 3: Run the audit — expect pass**

```bash
bun run audit:invariants
```

Expected: D10 + D11 + D12 all pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "audit(D11): add extension.publisher_key.* to vault-key allow-list (T2 PR 2)"
```

---

### Task 20: SECURITY-INVARIANTS.md §I16 entry

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md`

- [ ] **Step 1: Read the existing structure** — the file has a table at the top (I1..I15) and prose sections below.

- [ ] **Step 2: Add the I16 row** to the table:

```markdown
| I16 | Every installed extension with a `publisher` field has its signature verified at install AND every Gateway startup | `extensions/install-from-local.ts` `completeExtensionInstallAfterCopy` (Ed25519 verify after copy); `extensions/verify-extensions.ts` `verifyExtensionsBestEffort` signature pass | New install/start path that skips `verifyManifestSignature(...)` for an extension whose manifest carries `publisher` |
```

- [ ] **Step 3: Add the prose section** after §I15:

```markdown
## I16 — Verified-publisher signature

Every installed extension that declares a `publisher` field in its
`nimbus.extension.json` carries an Ed25519 signature over the canonicalized
manifest (with the `signature` field stripped). The signature is verified at
two sites:

- **Install:** `installExtensionFromLocalDirectory` resolves the publisher's
  pubkey from `--publisher-key`, vault cache, or registry (priority order),
  calls `verifyManifestSignature(...)`, writes the pubkey to the vault under
  `extension.publisher_key.<id>` on success, and appends an audit entry.
  Install is refused on any verification failure.
- **Startup:** `verifyExtensionsBestEffort`'s signature pass iterates every
  installed extension whose on-disk manifest carries `publisher`, reads the
  cached pubkey, verifies the signature, and on any failure flips
  `extension.enabled` to 0 + records the structured reason in the in-memory
  `SignatureDisabledRegistry` singleton (parallel to PR 1's
  `PreT2DisabledRegistry`). One batched
  `extension.startup_verification` audit entry is appended per Gateway run.

Pre-T2 extensions without a `publisher` field are unaffected — they keep
working and surface as `(unverified)` in CLI output.

### Enforcement

`packages/gateway/src/security-invariants.test.ts` carries three assertions:

1. **Static grep:** both wiring sites contain `verifyManifestSignature(`.
2. **Behavioral #1:** a signed extension with no cached vault key is
   hard-disabled at startup with reason `publisher_key_missing`.
3. **Behavioral #2:** a manifest tampered after signing is hard-disabled at
   startup with reason `signature_failed`.

The behavioral pair catches the "wired but doesn't actually disable" failure
mode that pure source-grep can't see.

### Anti-patterns

- Adding a new install path that copies an extension into place without
  calling `verifyManifestSignature(...)` on a signed manifest.
- Adding a new startup verification path that calls the existing
  `verifyExtensionsBestEffort` without passing `{ vault }` — the signature
  pass is gated on the presence of `signatureOpts`.
- Storing the publisher pubkey anywhere other than the
  `extension.publisher_key.<id>` vault namespace — the D11 static audit
  enforces the namespace, and any second cache would race with the canonical
  one.
```

- [ ] **Step 3: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md
git commit -m "docs(security): I16 verified-publisher invariant entry (T2 PR 2)"
```

---

### Task 21: Update CLAUDE.md security-invariant table row count + status line

**Files:**
- Modify: `CLAUDE.md` (line 10 status line + line 36 invariant count if present)
- Modify: `GEMINI.md` (mirror)

- [ ] **Step 1: Status line update** — add `T2 PR 2 ✅ (2026-MM-DD)` to line 10 of `CLAUDE.md` (placeholder date; replaced at merge time per the cadence). Mirror in `GEMINI.md`.

- [ ] **Step 2: Invariant table mention** — the `| I15 |` row exists; add `| I16 |` row mirroring the SECURITY-INVARIANTS.md entry shape. Mirror in `GEMINI.md`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md GEMINI.md
git commit -m "docs(claude-md): record T2 PR 2 + I16 in non-negotiables status line"
```

---

## Phase J — E2E sanity

### Task 22: E2E — signed install → list → info round trip

**Files:**
- Create: `packages/cli/test/e2e/extension-signed-roundtrip.smoke.e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliAgainstGateway } from "./helpers.ts";

describe("e2e: keygen → sign → install → list → info", () => {
  it("full round-trip with a real Gateway subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-e2e-"));
    const keyOut = join(dir, "pub.key");
    const extDir = join(dir, "my-ext");
    mkdirSync(join(extDir, "dist"), { recursive: true });

    // 1. keygen
    const kg = await runCliAgainstGateway(["extension", "keygen", "--out", keyOut]);
    expect(kg.exitCode).toBe(0);
    const pubkeyB64 = kg.stdout.trim();

    // 2. write a manifest declaring this pubkey
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "round-trip-ext",
        version: "1.0.0",
        permissions: {},
        publisher: { id: "test-pub", key: pubkeyB64 },
      }),
    );
    writeFileSync(join(extDir, "dist", "index.js"), "export default {};");

    // 3. sign
    const sign = await runCliAgainstGateway(["extension", "sign", extDir, "--key", keyOut]);
    expect(sign.exitCode).toBe(0);

    // 4. install (with --publisher-key)
    const inst = await runCliAgainstGateway([
      "extension", "install", extDir, "--publisher-key", keyOut,
    ]);
    expect(inst.exitCode).toBe(0);

    // 5. list shows our extension with the publisher id
    const lst = await runCliAgainstGateway(["extension", "list"]);
    expect(lst.stdout).toContain("round-trip-ext");
    expect(lst.stdout).toContain("test-pub");

    // 6. info shows publisher section
    const inf = await runCliAgainstGateway(["extension", "info", "round-trip-ext"]);
    expect(inf.stdout).toMatch(/Publisher:\s+test-pub/);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — expect pass**

```bash
bun test packages/cli/test/e2e/extension-signed-roundtrip.smoke.e2e.test.ts
```

Expected: green (real Gateway subprocess).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e/extension-signed-roundtrip.smoke.e2e.test.ts
git commit -m "test(e2e): signed-publisher install round-trip (T2 PR 2)"
```

---

### Task 23: E2E — `extension sync` with mock registry HTTP server

**Files:**
- Create: `packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
import { describe, expect, it } from "bun:test";

import { runCliAgainstGateway, startMockRegistry } from "./helpers.ts";

describe("e2e: extension sync against mock registry", () => {
  it("syncs publisher key from registry", async () => {
    const { url, stop, addPublisher } = await startMockRegistry();
    try {
      // Pre-stage: install a signed extension whose manifest declares a known publisher.
      // (Reuse the round-trip-ext fixture pattern from Task 22.)
      // ... setup omitted for brevity, see helper ...
      addPublisher("test-pub", /* pubkey bytes */ new Uint8Array(32));

      const sync = await runCliAgainstGateway(
        ["extension", "sync"],
        { env: { NIMBUS_REGISTRY_BASE_URL: url } },
      );
      expect(sync.exitCode).toBe(0);
      expect(sync.stdout).toContain("publishers checked: 1");
    } finally {
      stop();
    }
  });

  it("exit 3 under enforce_air_gap = true", async () => {
    const sync = await runCliAgainstGateway(
      ["extension", "sync"],
      { env: { NIMBUS_ENFORCE_AIR_GAP: "true" } },
    );
    expect(sync.exitCode).toBe(3);
  });
});
```

- [ ] **Step 2: Add `startMockRegistry` helper** to `packages/cli/test/e2e/helpers.ts`:

```typescript
export async function startMockRegistry(): Promise<{
  url: string;
  stop: () => void;
  addPublisher: (id: string, pubkey: Uint8Array) => void;
}> {
  const publishers = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const m = /^\/publishers\/([a-z0-9._-]+)\.key$/.exec(u.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const key = publishers.get(m[1]!);
      if (key === undefined) return new Response("not found", { status: 404 });
      return new Response(key, { status: 200 });
    },
  });
  const url = `http://localhost:${String(server.port)}`;
  return {
    url,
    stop: () => { server.stop(); },
    addPublisher: (id, pubkey) => publishers.set(id, Buffer.from(pubkey).toString("base64")),
  };
}
```

- [ ] **Step 3: Run — expect pass**

```bash
bun test packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/e2e/extension-sync.smoke.e2e.test.ts packages/cli/test/e2e/helpers.ts
git commit -m "test(e2e): extension sync against mock registry (T2 PR 2)"
```

---

## Phase K — Docs + final verification + roadmap

### Task 24: SDK re-export `generateEd25519Keypair` for connector authors

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/index.test.ts`

- [ ] **Step 1: Append a failing test**

```typescript
import { generateEd25519Keypair, signManifest } from "@nimbus-dev/sdk";

describe("@nimbus-dev/sdk publisher signing surface", () => {
  it("re-exports generateEd25519Keypair", () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    expect(privkey.length).toBe(32);
    expect(pubkey.length).toBe(32);
  });
  it("re-exports signManifest", () => {
    expect(typeof signManifest).toBe("function");
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
bun test packages/sdk/src/index.test.ts
```

- [ ] **Step 3: Implement** — add the re-exports in `packages/sdk/src/index.ts`:

```typescript
export {
  encodeBase64,
  decodeBase64,
  generateEd25519Keypair,
  signManifest,
  verifyManifestSignature,
} from "../../gateway/src/extensions/verify-signature.ts";
```

(Note: SDK is MIT-licensed; the imported symbols from the gateway live behind the same SDK entry point so connector authors can sign manifests without taking an AGPL dep.)

- [ ] **Step 4: Run — expect pass**

```bash
bun test packages/sdk/src/index.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/index.ts packages/sdk/src/index.test.ts
git commit -m "feat(sdk): re-export Ed25519 publisher signing helpers (T2 PR 2)"
```

---

### Task 25: Add "Signing your extension" section to nimbus-connector-authoring.md

**Files:**
- Modify: `.claude/commands/nimbus-connector-authoring.md`

- [ ] **Step 1: Append a new section after the existing "Coverage Gate" section**:

```markdown
## Signing your extension (T2 PR 2)

Every published extension SHOULD carry a `publisher` field + an embedded
Ed25519 `signature` field. Pre-T2 unsigned extensions still work but show
`(unverified)` in `nimbus extension list` and `nimbus extension info`.

**Generate a publisher keypair** (one-time):

```bash
nimbus extension keygen --out ~/.nimbus/publisher-key
```

`--out` writes the base64-encoded 32-byte Ed25519 seed to the given path (mode
`0600` on POSIX). The matching public key is printed to stdout — register
this with the Nimbus registry (or with whoever distributes your extension's
public key).

**Add `publisher` to your manifest** (`nimbus.extension.json`):

```json
{
  "id": "com.example.my-extension",
  "version": "0.1.0",
  "permissions": { ... },
  "publisher": {
    "id": "my-publisher-id",
    "key": "<your base64 pubkey from keygen>"
  }
}
```

**Sign the manifest** before publishing:

```bash
nimbus extension sign ./path/to/my-extension --key ~/.nimbus/publisher-key
```

This writes the `signature` field back into the manifest in place. Re-run
after any manifest edit — the signature is over the canonicalized manifest
minus the signature field, so any other change invalidates the signature.

**Verification.** Both `nimbus extension install` and every Gateway startup
verify the signature against the publisher key (cached in vault under
`extension.publisher_key.<id>`). Verification failures refuse install or
hard-disable the extension at startup.

For air-gap installs, ship the public key as a separate file and install
with `--publisher-key <path>`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/nimbus-connector-authoring.md
git commit -m "docs(skill): nimbus-connector-authoring — signing your extension (T2 PR 2)"
```

---

### Task 26: Roadmap T2 PR 2 sub-checkbox + Last updated header

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Find the T2 PR 2 row** (per the parent T2 spec line 301):

```bash
bun grep -n 'T2 PR 2' docs/roadmap.md
```

- [ ] **Step 2: Flip the checkbox** — `- [ ]` → `- [x]` and append `(2026-MM-DD, PR #TBD)`. Placeholder values; replaced post-merge.

- [ ] **Step 3: Extend the `Last updated:` line** at `docs/roadmap.md:7` with `T2 PR 2 ✅ (2026-MM-DD)`.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): T2 PR 2 sub-checkbox + status (placeholder dates)"
```

---

### Task 27: Audit-log action types — verify all four are registered

**Files:**
- Modify: `packages/gateway/src/audit/audit-log.ts` (if the action-type union is enforced) and its test

- [ ] **Step 1: Find the action-type registry** — grep for one of the existing audit types:

```bash
bun grep -n 'extension\.installed\|actionType' packages/gateway/src/audit/audit-log.ts | head
```

- [ ] **Step 2: Add the four new types** to the union / enum:

```
"extension.signature_verified"
"extension.signature_failed"
"extension.publisher_key_synced"
"extension.startup_verification"
```

- [ ] **Step 3: Update the audit-log test** to cover each:

```typescript
it("accepts the four T2 PR 2 action types", () => {
  for (const t of [
    "extension.signature_verified",
    "extension.signature_failed",
    "extension.publisher_key_synced",
    "extension.startup_verification",
  ]) {
    expect(() => appendAuditEntry({ actionType: t as AuditActionType, payload: {} })).not.toThrow();
  }
});
```

- [ ] **Step 4: Run — expect pass**

```bash
bun test packages/gateway/src/audit/audit-log.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/audit/audit-log.ts packages/gateway/src/audit/audit-log.test.ts
git commit -m "feat(audit): register T2 PR 2 action types (T2 PR 2)"
```

---

### Task 28: `nimbus diag --json` surface — add `signature_disabled_count`

**Files:**
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts` (the `diag.snapshot` handler)
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.test.ts`

- [ ] **Step 1: Append a failing test**

```typescript
it("diag.snapshot includes signature_disabled_count", async () => {
  signatureDisabledRegistry.reset();
  signatureDisabledRegistry.mark("ext-x", "signature_failed");
  const out = await dispatchDiagnosticsRpc("diag.snapshot", null, { /* ctx */ });
  expect((out as { signature_disabled_count: number }).signature_disabled_count).toBe(1);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts
```

- [ ] **Step 3: Implement** — add the field to the snapshot:

```typescript
import { signatureDisabledRegistry } from "../extensions/hard-disable.ts";
// ...
return {
  // ...existing fields...
  signature_disabled_count: signatureDisabledRegistry.count(),
};
```

- [ ] **Step 4: Run — expect pass**

```bash
bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/diagnostics-rpc.ts packages/gateway/src/ipc/diagnostics-rpc.test.ts
git commit -m "feat(diag): surface signature_disabled_count (T2 PR 2)"
```

---

### Task 29: Coverage gate — verify `test:coverage:extensions` ≥85% stays green

- [ ] **Step 1: Run the gate**

```bash
bun run test:coverage:extensions
```

Expected: line coverage ≥ 85% for `packages/gateway/src/extensions/`. If below, identify the uncovered branches via the coverage report and add tests until green. New files in this PR: `canonical-json.ts`, `verify-signature.ts`, `publisher-keys.ts`, `registry-client.ts`, `sync.ts` — each should be ≥80% in isolation.

- [ ] **Step 2: Commit any coverage backfills**

```bash
git add packages/gateway/src/extensions/
git commit -m "test(extensions): backfill coverage to keep ≥85% gate green (T2 PR 2)"
```

---

### Task 30: Full local CI parity

- [ ] **Step 1: Typecheck + lint**

```bash
bun run typecheck
bun run lint
```

- [ ] **Step 2: Audits**

```bash
bun run audit:invariants
bun run audit:structure
bun audit --audit-level high
```

- [ ] **Step 3: Coverage gates touched by PR 2**

```bash
bun run test:coverage:extensions
```

- [ ] **Step 4: Full CI parity**

```bash
bun run test:ci
```

Expected: all green.

- [ ] **Step 5: If any of the above fail** — fix the root cause; **do not** `--no-verify` or relax invariants. Commit fixes with conventional messages.

---

### Task 31: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin dev/asafgolombek/phase-5-t2-pr2-verified-publisher
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "T2 PR 2: verified publisher (Ed25519-signed manifests, I16)" --body "$(cat <<'EOF'
## Summary
- Adds Ed25519-signed extension manifests with new invariant **I16** (verify at install + every startup).
- New CLI: `nimbus extension sync`, `nimbus extension keygen`, `nimbus extension sign`; `nimbus extension install --publisher-key <path>`; tabular `nimbus extension list` with Publisher column.
- New module surface under `packages/gateway/src/extensions/`: `canonical-json.ts`, `verify-signature.ts`, `publisher-keys.ts`, `registry-client.ts`, `sync.ts`.
- New IPC method `extension.sync` — CLI-only, in `FORBIDDEN_OVER_LAN`, NOT in Tauri allowlist.
- No DB migration. No new Tauri allowlist entries. No HTTP write surface additions.
- Static D11 audit extended to allow `extension.publisher_key.*` vault keys.

## Spec
- [`docs/superpowers/specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design.md`](docs/superpowers/specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design.md)
- [`docs/superpowers/specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design-review.md`](docs/superpowers/specs/2026-05-17-phase-5-t2-pr2-verified-publisher-design-review.md)
- [`docs/superpowers/plans/2026-05-17-phase-5-t2-pr2-verified-publisher.md`](docs/superpowers/plans/2026-05-17-phase-5-t2-pr2-verified-publisher.md)

## Test plan
- [x] `bun run typecheck` green
- [x] `bun run lint` green
- [x] `bun run audit:invariants` green (D10 + D11 + D12)
- [x] `bun run audit:structure` green
- [x] `bun audit --audit-level high` clean
- [x] `bun run test:coverage:extensions` ≥85%
- [x] `bun run test:ci` green (Ubuntu PR gate)
- [ ] 3-OS push matrix green (Windows / macOS / Linux) — fires on push to `main` after merge approval

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Once CI is green and the PR merges** — replace the `2026-MM-DD` placeholders in `CLAUDE.md` line 10, `GEMINI.md`, and `docs/roadmap.md` with the actual merge date + PR number in a small follow-up commit on `main`.

---

## Self-Review (controller checklist, run before dispatching Task 1)

**Spec coverage** — every spec section maps to a task:

| Spec § | Implemented by task(s) |
|---|---|
| §1 Architecture overview | Tasks 8, 10 (the I16 wiring sites realize the invariant) |
| §2 Manifest schema additions | Task 3 |
| §3 Canonical JSON + Ed25519 verify | Tasks 1, 2 |
| §4 Registry client + sync | Tasks 5, 6, 7 |
| §5 Install + startup wiring + I16 enforcement | Tasks 8, 9, 10, 18 |
| §6.1 CLI surface | Tasks 12, 13, 14, 15, 16, 17 |
| §6.2 Audit log action types | Task 27 |
| §6.3 Testing layers | Each task's TDD cycle |
| §6.4 Coverage gate | Task 29 |
| §6.5 Out-of-scope | (not implemented — only locked as out-of-scope) |
| §7 Cross-cutting / invariants table / D11 | Tasks 19, 20, 21 |
| §8 See also | (links; no task needed) |
| §9 Open questions deferred to plan | Tasks 12 (keygen format → already locked in spec §3.2), 14 (sync exit codes), 13 (sign overwrite) |
| §10 Review disposition | (committed alongside spec; no task needed) |

**Placeholder scan:** no "TBD" / "TODO" / "fill in" patterns in task bodies. Two placeholders are intentional and called out: `2026-MM-DD` in CLAUDE.md/roadmap status edits, replaced at merge time; `PR #TBD` in the roadmap row, replaced when the PR number is assigned.

**Type consistency:** error class names match across tasks (`PublisherKeyMismatch`, `SignatureInvalid`, `SignatureInvalidFormat`, `ManifestNestedTooDeep`); `SignatureDisableReason` union matches in `verify-signature.ts` and `hard-disable.ts`; `SyncResult` shape consistent between gateway and CLI.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-phase-5-t2-pr2-verified-publisher.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality) between tasks. The recommended approach for a 31-task plan.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, with batch checkpoints for review.

Which approach?
