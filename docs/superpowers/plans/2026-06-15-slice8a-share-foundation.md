# Slice 8a — Share Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of the Share & Virality subsystem — a content-addressed, signed, redacted share artifact emitted only through an owner-HITL-gated chokepoint (invariant I27), with verify-share, the `share_records` store (migration V41), IPC + CLI surfaces, and the static D21 confinement.

**Architecture:** A new `packages/gateway/src/share/` subsystem. Pure modules (redaction, SSRF-safe fetch, the `nimbus-share/v1` format codec, the Vault-backed signing keypair) compose into a single `share-gate.ts` that is the *only* path data takes to leave the machine: collect session → redact → owner approves exact redacted bytes via the `share.publish` HITL action → sign with a Vault-only Ed25519 key → emit (file / configured HTTP sink / federation peer) → audit-log the applied redaction set. `verify-share` reuses the same codec. A static audit (D21) and a runtime invariant test (I27) confine the emit path + the action type + the signing-key read to the gate.

**Tech Stack:** Bun + TypeScript strict, `@nimbus-dev/sdk` (`generateEd25519Keypair`, `encodeBase64`/`decodeBase64`, `canonicalize`), `tweetnacl` (`nacl.sign.detached`), `@noble/hashes/blake3`, `bun:sqlite`, `bun:test`.

**Reference spec:** `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md` (§5, §6, §11).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/gateway/src/share/share-redaction.ts` | Compose existing secret patterns + the share PII set (emails/hosts/IPs/slack-handles/CC) + caller patterns; return redacted payload + applied family names. |
| `packages/gateway/src/share/safe-fetch.ts` | SSRF-guarded fetch: reject loopback/link-local/RFC-1918/non-http(s), validate the *resolved* address. |
| `packages/gateway/src/share/share-keypair.ts` | `ensureShareKeypair(vault)` — Vault-only `share.signing.{priv,pub}key`. |
| `packages/gateway/src/share/share-format.ts` | `nimbus-share/v1` envelope type + `canonicalizeBody` + `contentHash` + `signShareBody` + `verifyShareBytes` (bytes-in, no I/O). |
| `packages/gateway/src/share/share-store.ts` | `share_records` insert/list/get/prune over the DB. |
| `packages/gateway/src/share/share-consent-broker.ts` | `ShareConsentBroker` — request owner approval of the redacted preview, await approve/reject (fail-closed timeout). Mirrors `PreflightConsentBroker`. |
| `packages/gateway/src/share/share-gate.ts` | The I27 chokepoint: `createShare()` orchestrates collect → redact → preview → HITL → sign → emit → audit. |
| `packages/gateway/src/share/verify-share.ts` | `verifyShareFromInput()` — parse file/url (via safe-fetch), call `verifyShareBytes`, evaluate advisory expiry. |
| `packages/gateway/src/index/share-records-v41-sql.ts` | V41 CREATE TABLE SQL. |
| `packages/gateway/src/ipc/share-rpc.ts` | `dispatchShareRpc()` — `share.create/verify/list/get/pubkey/prune`. |
| `packages/cli/src/commands/share.ts` | `runShare()` + `runVerifyShare()`. |

**Modified:** `engine/executor.ts` (add `share.publish`), `index/local-index.ts` (bump version), `index/migrations/runner.ts` (register V41), `ipc/server/dispatchers.ts` (wire share rpc), `cli/src/index.ts` + `cli/src/commands/index.ts` (register commands), `ui/src-tauri/src/gateway_bridge.rs` (4 read-only methods), `scripts/structure-audit/check-nimbus-invariants.ts` (D21), `security-invariants.test.ts` (I27), docs.

---

## Pre-flight (do once before Task 1)

- [ ] **Confirm branch + worktree.** Run `git rev-parse --abbrev-ref HEAD`; expect `dev/asafgolombek/phase6-slice8-share-virality`. If a worktree was requested, it exists under `.claude/worktrees/`.
- [ ] **Read the substrate templates** you will mirror, so types match exactly:
  - `packages/gateway/src/policy/anchor-keypair.ts` (keypair-in-Vault template)
  - `packages/gateway/src/policy/policy-signing.ts` (`canonicalize`, nacl detached sign/verify)
  - `packages/gateway/src/audit/format-audit-payload.ts` (`SENSITIVE_VALUE_PATTERNS`, `SENSITIVE_KEY`)
  - `packages/gateway/src/db/audit-chain.ts` (`appendAuditEntry`, `computeAuditRowHash` uses `@noble/hashes/blake3`)
  - `packages/gateway/src/federation/preflight-consent-broker.ts` (consent broker template)
  - `packages/gateway/src/ipc/tribal-rpc.ts` (RPC handler template) + `ipc/_lib/dispatch-by-method.ts`
  - `packages/gateway/src/vault/nimbus-vault.ts` (`get → Promise<string|null>`, `set → Promise<void>`)

---

## Task 1: Share redaction (`share-redaction.ts`)

**Files:**

- Create: `packages/gateway/src/share/share-redaction.ts`
- Test: `packages/gateway/src/share/share-redaction.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/share-redaction.test.ts
import { describe, expect, test } from "bun:test";
import { redactForShare } from "./share-redaction.ts";

describe("redactForShare", () => {
  test("strips emails, IPs, hostnames, slack handles, credit cards, and secrets", () => {
    const { redacted, applied } = redactForShare({
      note: "ping alice@corp.com on 10.1.2.3 via db-prod-01.internal",
      handle: "<@U012ABCDEF>",
      card: "4111 1111 1111 1111",
      token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("alice@corp.com");
    expect(json).not.toContain("10.1.2.3");
    expect(json).not.toContain("db-prod-01.internal");
    expect(json).not.toContain("U012ABCDEF");
    expect(json).not.toContain("4111");
    expect(json).not.toContain("ghp_");
    expect(json).toContain("[REDACTED]");
    expect(applied).toEqual(
      expect.arrayContaining(["emails", "ips", "hostnames", "slack-handles", "credit-cards", "secrets"]),
    );
  });

  test("applies caller-supplied patterns and records them", () => {
    const { redacted, applied } = redactForShare(
      { msg: "project ZURICH is internal" },
      [/ZURICH/g],
    );
    expect(JSON.stringify(redacted)).not.toContain("ZURICH");
    expect(applied).toContain("caller");
  });

  test("leaves benign content intact", () => {
    const { redacted, applied } = redactForShare({ msg: "hello world", count: 3 });
    expect(redacted).toEqual({ msg: "hello world", count: 3 });
    expect(applied).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-redaction.test.ts`
Expected: FAIL — `Cannot find module './share-redaction.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/share/share-redaction.ts
import { SENSITIVE_VALUE_PATTERNS } from "../audit/format-audit-payload.ts";

/** Share-specific PII patterns, keyed by stable family name (added on top of secrets). */
const SHARE_PII_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["emails", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["slack-handles", /<[@#][A-Z0-9]{6,}(?:\|[^>]+)?>/g],
  ["credit-cards", /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g],
  ["ips", /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])/g],
  ["hostnames", /(?<![\w.])(?:[a-z0-9-]+\.)+(?:internal|local|corp|lan|intra)(?![\w])/gi],
]);

export interface ShareRedactionResult {
  readonly redacted: unknown;
  /** Stable family names actually applied (for body.redactionSet + audit). */
  readonly applied: readonly string[];
}

function scrub(s: string, applied: Set<string>, caller: readonly RegExp[]): string {
  let out = s;
  for (const [family, pat] of SENSITIVE_VALUE_PATTERNS) {
    if (pat.test(out)) {
      applied.add("secrets");
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  for (const [family, pat] of SHARE_PII_PATTERNS) {
    if (pat.test(out)) {
      applied.add(family);
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  for (const pat of caller) {
    if (pat.test(out)) {
      applied.add("caller");
      out = out.replace(pat, "[REDACTED]");
    }
    pat.lastIndex = 0;
  }
  return out;
}

function walk(value: unknown, applied: Set<string>, caller: readonly RegExp[]): unknown {
  if (typeof value === "string") return scrub(value, applied, caller);
  if (Array.isArray(value)) return value.map((v) => walk(v, applied, caller));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, applied, caller);
    }
    return out;
  }
  return value;
}

export function redactForShare(
  payload: unknown,
  callerPatterns: readonly RegExp[] = [],
): ShareRedactionResult {
  const applied = new Set<string>();
  const redacted = walk(payload, applied, callerPatterns);
  return { redacted, applied: [...applied].sort() };
}
```

> Note: confirm `SENSITIVE_VALUE_PATTERNS` is exported from `format-audit-payload.ts` (it is per the substrate map). If the export name differs, import the real one — do not duplicate the regexes.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-redaction.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-redaction.ts packages/gateway/src/share/share-redaction.test.ts
git commit -m "feat(share): share-redaction — secrets + PII families + caller patterns"
```

---

## Task 2: SSRF-safe fetch (`safe-fetch.ts`)

**Files:**

- Create: `packages/gateway/src/share/safe-fetch.ts`
- Test: `packages/gateway/src/share/safe-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/safe-fetch.test.ts
import { describe, expect, test } from "bun:test";
import { assertSafeUrl, isPrivateAddress } from "./safe-fetch.ts";

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["::1", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
  ])("%s -> private=%p", (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });
});

describe("assertSafeUrl", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/scheme/i);
    expect(() => assertSafeUrl("ftp://host/x")).toThrow(/scheme/i);
  });
  test("rejects literal loopback/private hosts", () => {
    expect(() => assertSafeUrl("http://127.0.0.1/x")).toThrow(/private|loopback/i);
    expect(() => assertSafeUrl("http://192.168.0.5/x")).toThrow(/private|loopback/i);
  });
  test("accepts a public https url", () => {
    expect(() => assertSafeUrl("https://example.com/share.json")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/safe-fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/share/safe-fetch.ts
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split(".").map((n) => Number.parseInt(n, 10));
    if (p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && (p[1] ?? 0) >= 16 && (p[1] ?? 0) <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 0) return true;
    return false;
  }
  if (v === 6) {
    const a = addr.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
  }
  return false;
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`unsafe url: malformed (${raw})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsafe url: scheme ${url.protocol} not allowed (http/https only)`);
  }
  const host = url.hostname;
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new Error(`unsafe url: host ${host} is loopback/private`);
  }
  return url;
}

/**
 * Validate scheme + literal/resolved address, then fetch.
 *
 * KNOWN LIMITATION (design-review point 2): `fetch()` performs its own DNS resolution at
 * connect time, so a malicious low-TTL DNS server could return a public IP to `lookup()` here
 * and a private IP to `fetch()` — a TOCTOU/DNS-rebind window. We do NOT fully close it: pinning
 * the connection to the resolved IP would require overriding SNI/Host and breaks TLS cert
 * validation for https in Bun's fetch. The residual risk is bounded because (a) the `--http`
 * sink host is config-pinned (`[share.http_sink].url`), not caller-chosen, and (b) `verify-share`
 * url fetch is a user-initiated read whose worst case is reading a public address it was already
 * pointed at. Full IP-pinning via a custom connector is a tracked hardening follow-up, not 8a.
 */
export async function safeFetch(raw: string, init?: RequestInit): Promise<Response> {
  const url = assertSafeUrl(raw);
  if (isIP(url.hostname) === 0) {
    const resolved = await lookup(url.hostname, { all: true });
    for (const { address } of resolved) {
      if (isPrivateAddress(address)) {
        throw new Error(`unsafe url: ${url.hostname} resolves to private ${address}`);
      }
    }
  }
  return fetch(url, init);
}
```

> Do not name this guarantee "SSRF-proof" anywhere — it is "SSRF-guarded with a documented DNS-rebind residual." The honest scoping is part of the fix.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/safe-fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/safe-fetch.ts packages/gateway/src/share/safe-fetch.test.ts
git commit -m "feat(share): safe-fetch SSRF guard (block loopback/private, resolved-addr check)"
```

---

## Task 3: Vault-only signing keypair (`share-keypair.ts`)

**Files:**

- Create: `packages/gateway/src/share/share-keypair.ts`
- Test: `packages/gateway/src/share/share-keypair.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/share-keypair.test.ts
import { describe, expect, test } from "bun:test";
import { ensureShareKeypair, SHARE_SIGNING_PRIVKEY, SHARE_SIGNING_PUBKEY } from "./share-keypair.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    listKeys: async () => [...m.keys()],
  };
}

describe("ensureShareKeypair", () => {
  test("generates and persists a 32-byte keypair on first call", async () => {
    const v = fakeVault();
    const kp = await ensureShareKeypair(v);
    expect(Buffer.from(kp.pubkeyB64, "base64").length).toBe(32);
    expect(v.store.get(SHARE_SIGNING_PRIVKEY)).toBe(kp.privkeyB64);
    expect(v.store.get(SHARE_SIGNING_PUBKEY)).toBe(kp.pubkeyB64);
  });

  test("reuses persisted material on subsequent calls", async () => {
    const v = fakeVault();
    const a = await ensureShareKeypair(v);
    const b = await ensureShareKeypair(v);
    expect(b).toEqual(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-keypair.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (mirror `policy/anchor-keypair.ts` verbatim, renaming keys)

```typescript
// packages/gateway/src/share/share-keypair.ts
import { decodeBase64, encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export const SHARE_SIGNING_PRIVKEY = "share.signing.privkey";
export const SHARE_SIGNING_PUBKEY = "share.signing.pubkey";

function isValidB64Len(b64: string, len: number): boolean {
  try {
    return decodeBase64(b64).length === len;
  } catch {
    return false;
  }
}

export async function ensureShareKeypair(
  vault: NimbusVault,
): Promise<{ privkeyB64: string; pubkeyB64: string }> {
  const existingPriv = await vault.get(SHARE_SIGNING_PRIVKEY);
  const existingPub = await vault.get(SHARE_SIGNING_PUBKEY);
  if (
    existingPriv !== null &&
    existingPub !== null &&
    isValidB64Len(existingPriv, 32) &&
    isValidB64Len(existingPub, 32)
  ) {
    return { privkeyB64: existingPriv, pubkeyB64: existingPub };
  }
  const kp = generateEd25519Keypair();
  const privkeyB64 = encodeBase64(kp.privkey);
  const pubkeyB64 = encodeBase64(kp.pubkey);
  await vault.set(SHARE_SIGNING_PRIVKEY, privkeyB64);
  await vault.set(SHARE_SIGNING_PUBKEY, pubkeyB64);
  return { privkeyB64, pubkeyB64 };
}
```

> Verify `generateEd25519Keypair()` returns `{ privkey, pubkey }` as `Uint8Array` (per `anchor-keypair.ts`). If the field is a 32-byte seed, that matches nacl `fromSeed` used in Task 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-keypair.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-keypair.ts packages/gateway/src/share/share-keypair.test.ts
git commit -m "feat(share): Vault-only share.signing keypair (mirrors anchor-keypair)"
```

---

## Task 4: Share format codec (`share-format.ts`)

**Files:**

- Create: `packages/gateway/src/share/share-format.ts`
- Test: `packages/gateway/src/share/share-format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/share-format.test.ts
import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair, encodeBase64 } from "@nimbus-dev/sdk";
import { buildShareFile, verifyShareBytes, type ShareBody } from "./share-format.ts";

function bodyFixture(): ShareBody {
  return {
    kind: "transcript",
    sessionId: "s-1",
    createdAt: 1000,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "Asaf", pubkey: "PLACEHOLDER" },
    turns: [{ role: "user", text: "hi", timestamp: 1000 }],
  };
}

describe("share-format", () => {
  test("round-trip: a signed file verifies", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes);
    expect(r.signatureValid).toBe(true);
    expect(r.contentHashValid).toBe(true);
    expect(r.expired).toBe(false);
  });

  test("tampering with body fails the signature", () => {
    const kp = generateEd25519Keypair();
    const body = { ...bodyFixture(), origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) } };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    (file.body as { sessionId: string }).sessionId = "s-tampered";
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes);
    expect(r.signatureValid && r.contentHashValid).toBe(false);
  });

  test("expiry is advisory: a genuine-but-expired share is signatureValid + expired", () => {
    const kp = generateEd25519Keypair();
    const body = {
      ...bodyFixture(),
      expiresAt: 500,
      origin: { label: "Asaf", pubkey: encodeBase64(kp.pubkey) },
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const r = verifyShareBytes(bytes, { now: 1000 });
    expect(r.signatureValid).toBe(true);
    expect(r.expired).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/share/share-format.ts
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

export const SHARE_FORMAT = "nimbus-share/v1";

export interface ShareOrigin {
  readonly label: string;
  readonly pubkey: string;
}
export interface ShareTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
}
export interface ShareToolCall {
  readonly toolId: string;
  readonly service: string;
  readonly params: unknown;
  readonly status: string;
}
export interface ShareBody {
  readonly kind: "transcript" | "recipe";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly redactionSet: readonly string[];
  readonly origin: ShareOrigin;
  readonly turns?: readonly ShareTurn[];
  readonly toolCalls?: readonly ShareToolCall[];
  readonly recipe?: unknown;
}
export interface ShareForwardingHop {
  readonly gatewayLabel: string;
  readonly pubkey: string;
  readonly sig: string;
}
export interface ShareFile {
  readonly format: string;
  readonly contentHash: string;
  readonly body: ShareBody;
  readonly sig: { readonly alg: "ed25519"; readonly pubkey: string; readonly signature: string };
  readonly forwarding: { readonly hops: number; readonly chain: readonly ShareForwardingHop[] };
}

/** Stable, key-sorted JSON of the body — the canonical bytes for hashing + signing. */
export function canonicalizeBody(body: ShareBody): Uint8Array {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        o[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v;
  };
  return new TextEncoder().encode(JSON.stringify(sortKeys(body)));
}

export function contentHash(body: ShareBody): string {
  return bytesToHex(blake3(canonicalizeBody(body)));
}

export function buildShareFile(body: ShareBody, privkeyB64: string, pubkeyB64: string): ShareFile {
  const canonical = canonicalizeBody(body);
  const seed = decodeBase64(privkeyB64);
  if (seed.length !== 32) {
    // Fail-closed: the Vault stores a 32-byte Ed25519 seed (generateEd25519Keypair().privkey,
    // validated by ensureShareKeypair). A wrong length means corruption — never silently slice.
    throw new TypeError(`share signing key must be a 32-byte seed, got ${seed.length}`);
  }
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const signature = Buffer.from(nacl.sign.detached(canonical, kp.secretKey)).toString("base64");
  return {
    format: SHARE_FORMAT,
    contentHash: bytesToHex(blake3(canonical)),
    body,
    sig: { alg: "ed25519", pubkey: pubkeyB64, signature },
    forwarding: { hops: 0, chain: [] },
  };
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly signatureValid: boolean;
  readonly contentHashValid: boolean;
  readonly expired: boolean;
  readonly errors: readonly string[];
}

export function verifyShareBytes(bytes: Uint8Array, opts?: { now?: number }): VerifyResult {
  const now = opts?.now ?? Date.now();
  const errors: string[] = [];
  let parsed: ShareFile;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as ShareFile;
  } catch {
    return { ok: false, signatureValid: false, contentHashValid: false, expired: false, errors: ["malformed json"] };
  }
  if (parsed.format !== SHARE_FORMAT) errors.push(`unexpected format: ${String(parsed.format)}`);
  const canonical = canonicalizeBody(parsed.body);
  const contentHashValid = bytesToHex(blake3(canonical)) === parsed.contentHash;
  if (!contentHashValid) errors.push("content hash mismatch");
  let signatureValid = false;
  try {
    signatureValid = nacl.sign.detached.verify(
      canonical,
      decodeBase64(parsed.sig.signature),
      decodeBase64(parsed.sig.pubkey),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) errors.push("signature invalid");
  const expired = parsed.body.expiresAt !== null && parsed.body.expiresAt < now;
  // Expiry is advisory — NOT part of ok. ok = genuine + untampered.
  return { ok: signatureValid && contentHashValid, signatureValid, contentHashValid, expired, errors };
}
```

> `tweetnacl` is the existing nacl dep (see `policy/policy-signing.ts`'s `import nacl from "tweetnacl"`). Match its import style exactly.
>
> **Canonicalization — prefer reuse (design-review point 3):** before keeping the local `sortKeys`, check whether the SDK `canonicalize` re-exported from `extensions/canonical-json.ts` can serialize an arbitrary share body. It is the project's *manifest* canonicalizer and enforces limits (`ManifestNestedTooDeep`, `NonIntegerNumberInManifest`, `UnsupportedManifestValueType`). A share body has nested transcript turns / tool-call params and integer timestamps — if it stays within those limits, **import and reuse `canonicalize`** (delete the local `sortKeys`) so there is one canonicalizer and no drift. Only if real share bodies can exceed the manifest limits (deep nesting, non-integer numbers, unsupported value types) do you keep the local key-sorter — and then add a one-line comment stating exactly which limit forced the fork. Either way, `contentHash`/sign/verify must all call the *same* function.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-format.ts packages/gateway/src/share/share-format.test.ts
git commit -m "feat(share): nimbus-share/v1 codec — canonical body, content hash, sign/verify, advisory expiry"
```

---

## Task 5: Migration V41 — `share_records`

**Files:**

- Create: `packages/gateway/src/index/share-records-v41-sql.ts`
- Modify: `packages/gateway/src/index/local-index.ts` (bump `CURRENT_SCHEMA_VERSION` 40 → 41)
- Modify: `packages/gateway/src/index/migrations/runner.ts` (register V41 step)
- Test: `packages/gateway/src/index/migrations/share-records-v41.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/index/migrations/share-records-v41.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex, CURRENT_SCHEMA_VERSION } from "../local-index.ts";

describe("V41 share_records", () => {
  test("CURRENT_SCHEMA_VERSION is 41", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(41);
  });
  test("ensureSchema creates share_records with expected columns", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const cols = (db.query("PRAGMA table_info(share_records)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "content_hash", "kind", "session_id", "created_at", "expires_at",
        "redaction_set_json", "provenance_json", "body_json", "sig_json", "sink",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/share-records-v41.test.ts`
Expected: FAIL — `CURRENT_SCHEMA_VERSION` is 40 / table missing.

- [ ] **Step 3: Create the SQL file**

```typescript
// packages/gateway/src/index/share-records-v41-sql.ts
export const SHARE_RECORDS_V41_SQL = `
CREATE TABLE IF NOT EXISTS share_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash        TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL,
  session_id          TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  redaction_set_json  TEXT NOT NULL,
  provenance_json     TEXT NOT NULL,
  body_json           TEXT NOT NULL,
  sig_json            TEXT NOT NULL,
  sink                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_records_session ON share_records(session_id);
CREATE INDEX IF NOT EXISTS idx_share_records_created ON share_records(created_at);
`;
```

- [ ] **Step 4: Register the migration + bump the version**

In `packages/gateway/src/index/local-index.ts`, change the version constant:

```typescript
export const CURRENT_SCHEMA_VERSION = 41;
```

In `packages/gateway/src/index/migrations/runner.ts`: add the import at the top alongside the other `*-vNN-sql` imports:

```typescript
import { SHARE_RECORDS_V41_SQL } from "../share-records-v41-sql.ts";
```

and append to the `INDEXED_SCHEMA_STEPS` array, after the V40 step:

```typescript
  simpleStep(40, 41, "share_records (share & virality ledger v41)", SHARE_RECORDS_V41_SQL),
```

> Read the existing V39/V40 entries first to copy the exact `simpleStep(...)` call shape and trailing-comma style.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/share-records-v41.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/share-records-v41-sql.ts packages/gateway/src/index/local-index.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/share-records-v41.test.ts
git commit -m "feat(share): V41 share_records ledger"
```

---

## Task 6: Share store (`share-store.ts`)

**Files:**

- Create: `packages/gateway/src/share/share-store.ts`
- Test: `packages/gateway/src/share/share-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/share-store.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { insertShareRecord, listShareRecords, getShareRecord, pruneExpiredShares } from "./share-store.ts";

function freshDb() {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}
const rec = (over: Partial<Parameters<typeof insertShareRecord>[1]> = {}) => ({
  contentHash: "h1", kind: "transcript", sessionId: "s1", createdAt: 100, expiresAt: null,
  redactionSet: ["secrets"], provenance: { hops: 0, chain: [] }, bodyJson: "{}", sigJson: "{}",
  sink: "file", ...over,
});

describe("share-store", () => {
  test("insert + get by content hash", () => {
    const db = freshDb();
    insertShareRecord(db, rec());
    const got = getShareRecord(db, "h1");
    expect(got?.kind).toBe("transcript");
  });
  test("list excludes expired by default, includes with includeExpired", () => {
    const db = freshDb();
    insertShareRecord(db, rec({ contentHash: "live", expiresAt: null }));
    insertShareRecord(db, rec({ contentHash: "dead", expiresAt: 1 }));
    expect(listShareRecords(db, { now: 1000 }).map((r) => r.contentHash)).toEqual(["live"]);
    expect(listShareRecords(db, { now: 1000, includeExpired: true }).length).toBe(2);
  });
  test("prune removes expired rows", () => {
    const db = freshDb();
    insertShareRecord(db, rec({ contentHash: "dead", expiresAt: 1 }));
    expect(pruneExpiredShares(db, 1000)).toBe(1);
    expect(getShareRecord(db, "dead")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/share/share-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (use `dbRun` for writes — I14)

```typescript
// packages/gateway/src/share/share-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface ShareRecordInput {
  readonly contentHash: string;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly redactionSet: readonly string[];
  readonly provenance: unknown;
  readonly bodyJson: string;
  readonly sigJson: string;
  readonly sink: string;
}
export interface ShareRecord extends Omit<ShareRecordInput, "redactionSet" | "provenance"> {
  readonly id: number;
  readonly redactionSet: readonly string[];
  readonly provenance: unknown;
}

export function insertShareRecord(db: Database, r: ShareRecordInput): void {
  dbRun(
    db,
    `INSERT INTO share_records
       (content_hash, kind, session_id, created_at, expires_at, redaction_set_json, provenance_json, body_json, sig_json, sink)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.contentHash, r.kind, r.sessionId, r.createdAt, r.expiresAt,
      JSON.stringify(r.redactionSet), JSON.stringify(r.provenance), r.bodyJson, r.sigJson, r.sink,
    ],
  );
}

type Row = {
  id: number; content_hash: string; kind: string; session_id: string | null;
  created_at: number; expires_at: number | null; redaction_set_json: string;
  provenance_json: string; body_json: string; sig_json: string; sink: string;
};
const map = (row: Row): ShareRecord => ({
  id: row.id, contentHash: row.content_hash, kind: row.kind, sessionId: row.session_id,
  createdAt: row.created_at, expiresAt: row.expires_at,
  redactionSet: JSON.parse(row.redaction_set_json) as string[],
  provenance: JSON.parse(row.provenance_json), bodyJson: row.body_json, sigJson: row.sig_json, sink: row.sink,
});

export function getShareRecord(db: Database, contentHash: string): ShareRecord | undefined {
  const row = db.query("SELECT * FROM share_records WHERE content_hash = ?").get(contentHash) as Row | null;
  return row === null ? undefined : map(row);
}

export function listShareRecords(
  db: Database,
  opts: { now: number; includeExpired?: boolean; limit?: number },
): ShareRecord[] {
  const limit = opts.limit ?? 100;
  const rows = (
    opts.includeExpired === true
      ? db.query("SELECT * FROM share_records ORDER BY created_at DESC LIMIT ?").all(limit)
      : db
          .query(
            "SELECT * FROM share_records WHERE expires_at IS NULL OR expires_at >= ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(opts.now, limit)
  ) as Row[];
  return rows.map(map);
}

export function pruneExpiredShares(db: Database, now: number): number {
  const before = (db.query("SELECT COUNT(*) AS c FROM share_records WHERE expires_at IS NOT NULL AND expires_at < ?").get(now) as { c: number }).c;
  dbRun(db, "DELETE FROM share_records WHERE expires_at IS NOT NULL AND expires_at < ?", [now]);
  return before;
}
```

> Confirm `dbRun` signature/import from `db/write.ts` (I14 requires writes go through it). If it takes `(db, sql, params)` as shown in `db/audit-chain.ts`, this matches.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/share/share-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-store.ts packages/gateway/src/share/share-store.test.ts
git commit -m "feat(share): share_records store (insert/list/get/prune, expired-filtering)"
```

---

## Task 7: HITL action type `share.publish` + I27 runtime test

**Files:**

- Modify: `packages/gateway/src/engine/executor.ts` (add `"share.publish"` to `HITL_REQUIRED_BACKING`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (add I27 block)

- [ ] **Step 1: Write the failing invariant test** — append to `security-invariants.test.ts`:

```typescript
describe("I27 — outbound share gated by share.publish HITL action", () => {
  test("HITL_REQUIRED includes share.publish", async () => {
    const { HITL_REQUIRED } = await import("./engine/executor.ts");
    expect(HITL_REQUIRED.has("share.publish")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I27"`
Expected: FAIL — `share.publish` not in the set.

- [ ] **Step 3: Add the action type.** In `packages/gateway/src/engine/executor.ts`, add to the `HITL_REQUIRED_BACKING` Set literal (alphabetical-ish, near other namespaced entries):

```typescript
  "share.publish",
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I27"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/executor.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(share): add share.publish to HITL frozen set (I27, runtime test)"
```

---

## Task 8: Consent broker + share gate (`share-consent-broker.ts`, `share-gate.ts`)

**Files:**

- Create: `packages/gateway/src/share/share-consent-broker.ts`
- Create: `packages/gateway/src/share/share-gate.ts`
- Test: `packages/gateway/src/share/share-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/share-gate.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { createShare } from "./share-gate.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), delete: async () => {}, listKeys: async () => [...m.keys()] };
}
function deps(approve: boolean, db: Database) {
  return {
    db,
    vault: fakeVault(),
    label: "Asaf",
    now: () => 1000,
    collectSession: () => ({ turns: [{ role: "user" as const, text: "ping alice@corp.com", timestamp: 1 }], toolCalls: [] }),
    requestApproval: async () => approve,
    recordAudit: (e: { actionType: string; hitlStatus: string }) => audit.push(e),
  };
}
const audit: { actionType: string; hitlStatus: string }[] = [];

describe("createShare (I27 gate)", () => {
  test("rejected approval => no file, audit records rejected, nothing persisted", async () => {
    audit.length = 0;
    const db = new Database(":memory:"); LocalIndex.ensureSchema(db);
    const r = await createShare({ sessionId: "s1", kind: "transcript", sink: { type: "file" } }, deps(false, db));
    expect(r.status).toBe("rejected");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "rejected" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 0 });
  });

  test("approved => redacted+signed share returned, persisted, audit approved", async () => {
    audit.length = 0;
    const db = new Database(":memory:"); LocalIndex.ensureSchema(db);
    const r = await createShare({ sessionId: "s1", kind: "transcript", sink: { type: "file" } }, deps(true, db));
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.share)).not.toContain("alice@corp.com");
    expect(r.share?.body.redactionSet).toContain("emails");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "approved" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/share/share-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the consent broker** (mirror `federation/preflight-consent-broker.ts`)

```typescript
// packages/gateway/src/share/share-consent-broker.ts
import { randomUUID } from "node:crypto";

type Broadcast = (method: string, params: unknown) => void;
interface Pending { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout>; }

export interface ShareApprovalInput {
  readonly sessionId: string;
  readonly kind: string;
  /** The exact redacted preview the owner must approve. */
  readonly preview: unknown;
  readonly redactionSet: readonly string[];
  readonly sink: string;
}

export class ShareConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};
  setBroadcast(fn: Broadcast): void { this.broadcast = fn; }

  request(input: ShareApprovalInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); }, ttlMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("share.approvalRequest", { requestId, ...input });
    });
  }
  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }
}
```

- [ ] **Step 4: Write the gate**

```typescript
// packages/gateway/src/share/share-gate.ts
import type { Database } from "bun:sqlite";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { ensureShareKeypair } from "./share-keypair.ts";
import { redactForShare } from "./share-redaction.ts";
import { buildShareFile, type ShareBody, type ShareFile, type ShareToolCall, type ShareTurn } from "./share-format.ts";
import { insertShareRecord } from "./share-store.ts";

export interface SessionContent {
  readonly turns: readonly ShareTurn[];
  readonly toolCalls: readonly ShareToolCall[];
}
export type ShareSink = { type: "file" } | { type: "http"; url: string } | { type: "peer"; peerId: string };
export interface CreateShareRequest {
  readonly sessionId: string;
  readonly kind: "transcript" | "recipe";
  readonly sink: ShareSink;
  readonly callerPatterns?: readonly RegExp[];
  readonly expiresAt?: number | null;
}
export interface CreateShareDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly label: string;
  readonly now: () => number;
  readonly collectSession: (sessionId: string) => SessionContent;
  /** Owner HITL — must resolve true only on explicit owner approval of the preview. */
  readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;
  readonly recordAudit: (e: { actionType: string; hitlStatus: string; actionJson: string; timestamp: number; sessionId?: string }) => void;
}
export type CreateShareResult =
  | { readonly status: "ok"; readonly share: ShareFile }
  | { readonly status: "rejected" };

export async function createShare(req: CreateShareRequest, deps: CreateShareDeps): Promise<CreateShareResult> {
  const now = deps.now();
  const content = deps.collectSession(req.sessionId);
  const { redacted, applied } = redactForShare(
    { turns: content.turns, toolCalls: content.toolCalls },
    req.callerPatterns ?? [],
  );

  const approved = await deps.requestApproval(redacted, applied);
  if (!approved) {
    deps.recordAudit({
      actionType: "share.publish", hitlStatus: "rejected",
      actionJson: JSON.stringify({ sessionId: req.sessionId, kind: req.kind, redactionSet: applied, sink: req.sink.type }),
      timestamp: now, sessionId: req.sessionId,
    });
    return { status: "rejected" };
  }

  const kp = await ensureShareKeypair(deps.vault);
  const r = redacted as { turns?: readonly ShareTurn[]; toolCalls?: readonly ShareToolCall[] };
  const body: ShareBody = {
    kind: req.kind, sessionId: req.sessionId, createdAt: now,
    expiresAt: req.expiresAt ?? null, redactionSet: applied,
    origin: { label: deps.label, pubkey: kp.pubkeyB64 },
    ...(req.kind === "transcript" ? { turns: r.turns ?? [] } : {}),
    toolCalls: r.toolCalls ?? [],
  };
  const share = buildShareFile(body, kp.privkeyB64, kp.pubkeyB64);

  insertShareRecord(deps.db, {
    contentHash: share.contentHash, kind: body.kind, sessionId: req.sessionId,
    createdAt: now, expiresAt: body.expiresAt, redactionSet: applied,
    provenance: share.forwarding, bodyJson: JSON.stringify(body), sigJson: JSON.stringify(share.sig), sink: req.sink.type,
  });
  deps.recordAudit({
    actionType: "share.publish", hitlStatus: "approved",
    actionJson: JSON.stringify({ sessionId: req.sessionId, kind: req.kind, redactionSet: applied, sink: req.sink.type, contentHash: share.contentHash }),
    timestamp: now, sessionId: req.sessionId,
  });
  return { status: "ok", share };
}
```

> The actual emit (write file / `safeFetch` POST to the configured sink / federation forward) is wired in the RPC layer (Task 9) using `req.sink`; the gate's contract is "redact → approve → sign → persist → audit." Sink delivery for `peer` lands in 8d.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/gateway/src/share/share-gate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/share/share-consent-broker.ts packages/gateway/src/share/share-gate.ts packages/gateway/src/share/share-gate.test.ts
git commit -m "feat(share): I27 share-gate (redact -> owner HITL -> sign -> persist -> audit) + consent broker"
```

---

## Task 9: verify-share logic (`verify-share.ts`)

**Files:**

- Create: `packages/gateway/src/share/verify-share.ts`
- Test: `packages/gateway/src/share/verify-share.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/share/verify-share.test.ts
import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair, encodeBase64 } from "@nimbus-dev/sdk";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { verifyShareFromBytes } from "./verify-share.ts";

describe("verifyShareFromBytes", () => {
  test("reports per-check results for a genuine share", () => {
    const kp = generateEd25519Keypair();
    const body: ShareBody = {
      kind: "transcript", sessionId: "s", createdAt: 1, expiresAt: null, redactionSet: [],
      origin: { label: "A", pubkey: encodeBase64(kp.pubkey) }, turns: [],
    };
    const file = buildShareFile(body, encodeBase64(kp.privkey), encodeBase64(kp.pubkey));
    const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(file)));
    expect(r.ok).toBe(true);
    expect(r.origin?.label).toBe("A");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/share/verify-share.ts
import { safeFetch } from "./safe-fetch.ts";
import { verifyShareBytes, type VerifyResult } from "./share-format.ts";

export interface VerifyShareReport extends VerifyResult {
  readonly origin?: { label: string; pubkey: string };
}

export function verifyShareFromBytes(bytes: Uint8Array, opts?: { now?: number }): VerifyShareReport {
  const base = verifyShareBytes(bytes, opts);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { body?: { origin?: { label: string; pubkey: string } } };
    return parsed.body?.origin === undefined ? base : { ...base, origin: parsed.body.origin };
  } catch {
    return base;
  }
}

export async function verifyShareFromInput(input: string, opts?: { now?: number }): Promise<VerifyShareReport> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const res = await safeFetch(input);
    const buf = new Uint8Array(await res.arrayBuffer());
    return verifyShareFromBytes(buf, opts);
  }
  const buf = await Bun.file(input).bytes();
  return verifyShareFromBytes(buf, opts);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/verify-share.ts packages/gateway/src/share/verify-share.test.ts
git commit -m "feat(share): verify-share (bytes + file/url via SSRF-safe fetch)"
```

---

## Task 10: IPC surface (`share-rpc.ts`) + dispatcher wiring

**Files:**

- Create: `packages/gateway/src/ipc/share-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (wire `share.*`)
- Modify: the LAN-forbidden registry so `share.create` is LAN-forbidden (verify the real mechanism — see Step 4)
- Test: `packages/gateway/src/ipc/share-rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/ipc/share-rpc.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchShareRpc } from "./share-rpc.ts";

const okVerify = { ok: true, signatureValid: true, contentHashValid: true, expired: false, errors: [] as string[] };
function ctx(_db: Database) {
  return {
    createShare: async () => ({ status: "ok" as const, contentHash: "h1" }),
    verifyBytes: () => okVerify,
    verifyUrl: async () => okVerify,
    pubkey: async () => "PUB",
    list: () => [],
    get: () => undefined,
    prune: () => 0,
  };
}

describe("dispatchShareRpc", () => {
  test("share.pubkey returns the pubkey", async () => {
    const db = new Database(":memory:"); LocalIndex.ensureSchema(db);
    const out = await dispatchShareRpc("share.pubkey", {}, ctx(db));
    expect(out).toEqual({ kind: "hit", value: { pubkey: "PUB" } });
  });
  test("unknown method misses", async () => {
    const db = new Database(":memory:"); LocalIndex.ensureSchema(db);
    const out = await dispatchShareRpc("share.nope", {}, ctx(db));
    expect(out.kind).toBe("miss");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the RPC module** (mirror `ipc/tribal-rpc.ts`; the context functions are injected at wiring time so the handlers stay testable)

```typescript
// packages/gateway/src/ipc/share-rpc.ts
import { dispatchByMethod, type RpcMethodHandlerMap, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

interface VerifyShape { ok: boolean; signatureValid: boolean; contentHashValid: boolean; expired: boolean; errors: readonly string[] }
export interface ShareRpcCtx {
  readonly createShare: (params: unknown) => Promise<{ status: string; contentHash?: string }>;
  readonly verifyBytes: (bytes: Uint8Array) => VerifyShape;
  /** Gateway-side SSRF-safe fetch + verify for the url form (wraps verifyShareFromInput). */
  readonly verifyUrl: (url: string) => Promise<VerifyShape>;
  readonly pubkey: () => Promise<string>;
  readonly list: (includeExpired: boolean) => unknown;
  readonly get: (contentHash: string) => unknown;
  readonly prune: () => number;
}

function reqString(p: unknown, key: string): string {
  const rec = p as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string") throw new Error(`ERR_INVALID_PARAMS: ${key} (string) required`);
  return v;
}

const HANDLERS: RpcMethodHandlerMap<ShareRpcCtx> = {
  "share.create": (p, ctx) => ctx.createShare(p),
  "share.verify": (p, ctx) => {
    const params = p as { bytesB64?: string; url?: string } | null;
    if (typeof params?.bytesB64 === "string") {
      return ctx.verifyBytes(new Uint8Array(Buffer.from(params.bytesB64, "base64")));
    }
    if (typeof params?.url === "string") {
      return ctx.verifyUrl(params.url); // gateway-side SSRF-safe fetch (verifyShareFromInput)
    }
    throw new Error("ERR_INVALID_PARAMS: share.verify requires bytesB64 or url");
  },
  "share.pubkey": async (_p, ctx) => ({ pubkey: await ctx.pubkey() }),
  "share.list": (p, ctx) => ctx.list((p as { includeExpired?: boolean } | null)?.includeExpired === true),
  "share.get": (p, ctx) => ctx.get(reqString(p, "contentHash")),
  "share.prune": (_p, ctx) => ({ pruned: ctx.prune() }),
} as const;

export function dispatchShareRpc(method: string, params: unknown, ctx: ShareRpcCtx): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
```

- [ ] **Step 4: Wire the dispatcher + LAN-forbid `share.create`.**
  - **Read `packages/gateway/src/ipc/server/dispatchers.ts`** and find how `tribal`/`federation` RPC is wired into the Phase-4 dispatch chain. Add a `tryDispatchShareRpc(ctx, method, params)` following that exact pattern, constructing `ShareRpcCtx` from real deps: `createShare` calls the Task-8 `createShare` (with the consent broker's `request` as `requestApproval`, `collectSession` reading the transcript via `engine-get-session-transcript` + `tool_call_log`, and after a successful gate, performing the sink emit — file write / `safeFetch` POST to the configured `[share.http_sink]` / peer-forward-stub-for-8d); `verifyBytes` → `verifyShareFromBytes`; `verifyUrl` → `verifyShareFromInput` (gateway-side SSRF-safe fetch); `pubkey` → `ensureShareKeypair(...).pubkeyB64`; `list`/`get`/`prune` → `share-store`.
  - **Read the LAN method-allow mechanism** (CLAUDE.md I5: `checkLanMethodAllowed` intrinsic to `LanServer`, `ipc/lan-server.ts`; federation methods are explicitly LAN-callable). Ensure `share.create`/`share.prune` are **not** LAN-callable while `share.verify`/`share.list`/`share.get`/`share.pubkey` may be. Match whatever allow/deny structure that file uses (allowlist of LAN-callable methods, or a forbidden set). Add a test mirroring the existing LAN-allow tests.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/share-rpc.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/share-rpc.test.ts
git commit -m "feat(share): share.* IPC (create/verify/list/get/pubkey/prune) + dispatcher wiring + LAN scoping"
```

---

## Task 11: CLI commands (`share`, `verify-share`)

**Files:**

- Create: `packages/cli/src/commands/share.ts`
- Modify: `packages/cli/src/commands/index.ts` (export `runShare`, `runVerifyShare`)
- Modify: `packages/cli/src/index.ts` (register in `COMMAND_HANDLERS`)
- Test: `packages/cli/src/commands/share.test.ts`

- [ ] **Step 1: Write the failing test** (pure arg-parsing — keep IPC out of the unit test)

```typescript
// packages/cli/src/commands/share.test.ts
import { describe, expect, test } from "bun:test";
import { parseShareCreateArgs } from "./share.ts";

describe("parseShareCreateArgs", () => {
  test("parses session id, sink, expiry, redact patterns", () => {
    const r = parseShareCreateArgs(["s-123", "--out", "x.json", "--expires", "7d", "--redact", "ZURICH"]);
    expect(r.sessionId).toBe("s-123");
    expect(r.sink).toEqual({ type: "file", path: "x.json" });
    expect(r.expiresMs).toBeGreaterThan(0);
    expect(r.redact).toEqual(["ZURICH"]);
  });
  test("defaults sink to a file when none given", () => {
    expect(parseShareCreateArgs(["s-1"]).sink.type).toBe("file");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/commands/share.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the command** (mirror `commands/audit.ts` `withIpc` usage)

```typescript
// packages/cli/src/commands/share.ts
import { IPCClient } from "../ipc-client/index.ts";
import { getCliPlatformPaths } from "../platform-paths.ts";
import { readGatewayState } from "../gateway-state.ts";

export interface ShareCreateArgs {
  readonly sessionId: string;
  readonly sink: { type: "file"; path?: string } | { type: "http" } | { type: "peer"; peerId: string };
  readonly expiresMs: number | null;
  readonly redact: readonly string[];
  readonly asRecipe: boolean;
}

const DURATION = /^(\d+)([smhd])$/;
function parseDuration(s: string): number | null {
  const m = DURATION.exec(s);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? "0", 10);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] ?? "s"] ?? 1000;
  return n * unit;
}

export function parseShareCreateArgs(args: readonly string[]): ShareCreateArgs {
  const sessionId = args[0] ?? "";
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = flag("--out");
  const peer = flag("--to-peer");
  const sink = out !== undefined ? { type: "file" as const, path: out }
    : args.includes("--http") ? { type: "http" as const }
    : peer !== undefined ? { type: "peer" as const, peerId: peer }
    : { type: "file" as const };
  const exp = flag("--expires");
  return {
    sessionId,
    sink,
    expiresMs: exp === undefined ? null : parseDuration(exp),
    redact: args.flatMap((a, i) => (a === "--redact" && args[i + 1] !== undefined ? [args[i + 1] as string] : [])),
    asRecipe: args.includes("--as-recipe"),
  };
}

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) throw new Error("Gateway is not running. Start with: nimbus start");
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try { return await fn(client); } finally { await client.disconnect(); }
}

export async function runShare(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const a = parseShareCreateArgs(rest);
    await withIpc(async (c) => {
      const r = await c.call<{ status: string; contentHash?: string }>("share.create", {
        sessionId: a.sessionId, kind: a.asRecipe ? "recipe" : "transcript",
        sink: a.sink, expiresMs: a.expiresMs, redact: a.redact,
      });
      console.log(r.status === "ok" ? `Shared: ${r.contentHash}` : `Share ${r.status}`);
    });
    return;
  }
  if (sub === "list") {
    await withIpc(async (c) => {
      const rows = await c.call<{ contentHash: string; kind: string; createdAt: number }[]>("share.list", { includeExpired: rest.includes("--all") });
      for (const row of rows) console.log(`${row.contentHash}  ${row.kind}  ${new Date(row.createdAt).toISOString()}`);
    });
    return;
  }
  if (sub === "prune") {
    await withIpc(async (c) => { const r = await c.call<{ pruned: number }>("share.prune", {}); console.log(`Pruned ${r.pruned}`); });
    return;
  }
  if (sub === "pubkey") {
    await withIpc(async (c) => { const r = await c.call<{ pubkey: string }>("share.pubkey", {}); console.log(r.pubkey); });
    return;
  }
  console.error("Usage: nimbus share <create|list|prune|pubkey> ...");
  process.exitCode = 1;
}

export async function runVerifyShare(args: string[]): Promise<void> {
  const input = args[0];
  if (input === undefined) { console.error("Usage: nimbus verify-share <file|url>"); process.exitCode = 1; return; }
  await withIpc(async (c) => {
    const bytes = input.startsWith("http") ? undefined : await Bun.file(input).bytes();
    const r = await c.call<{ ok: boolean; signatureValid: boolean; expired: boolean; errors: string[] }>(
      "share.verify",
      bytes === undefined ? { url: input } : { bytesB64: Buffer.from(bytes).toString("base64") },
    );
    console.log(`signature: ${r.signatureValid ? "VALID" : "INVALID"}${r.expired ? " (expired)" : ""}`);
    if (!r.ok) { console.error(r.errors.join("; ")); process.exitCode = 1; }
  });
}
```

> Confirm the real import paths for `IPCClient`, `getCliPlatformPaths`, `readGatewayState` by reading `commands/audit.ts` — match them exactly. `share.verify` accepts either `bytesB64` (local file, read CLI-side) or `url` (gateway-side SSRF-safe fetch).

- [ ] **Step 4: Register the commands.** In `packages/cli/src/commands/index.ts` add exports for `runShare`, `runVerifyShare`. In `packages/cli/src/index.ts` add to `COMMAND_HANDLERS`:

```typescript
  share: runShare,
  "verify-share": runVerifyShare,
```

and add `runShare, runVerifyShare` to the import from `./commands/index.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/cli/src/commands/share.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/share.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts packages/cli/src/commands/share.test.ts
git commit -m "feat(cli): nimbus share (create/list/prune/pubkey) + verify-share"
```

---

## Task 12: Tauri allowlist — 4 read-only methods

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`

- [ ] **Step 1: Read the current `ALLOWED_METHODS` array + the `allowlist_exact_size` test** to get the exact current count and confirm alphabetical ordering is enforced.

- [ ] **Step 2: Add the four read-only methods** in alphabetical position (after `scim.*`, before `team.*`):

```rust
    "share.get",
    "share.list",
    "share.pubkey",
    "share.verify",
```

**Do NOT add `share.create` or `share.prune`** (outbound/mutating — CLI-only, I7).

- [ ] **Step 3: Update the size assertion** in `allowlist_exact_size` by +4 (read the current value first; do not guess).

- [ ] **Step 4: Run the Rust allowlist tests**

Run: `cd packages/ui/src-tauri && cargo test allowlist`
Expected: PASS (`allowlist_exact_size`, `allowlist_is_alphabetized`).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(share): expose read-only share.{get,list,pubkey,verify} to renderer (I7)"
```

---

## Task 13: Static D21 confinement

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Test: the structure-audit has its own test harness — add a case if one exists; otherwise the `bun run` invocation is the check.

- [ ] **Step 1: Read the D20 (warehouse-write) check** in `check-nimbus-invariants.ts` to copy the exact `FileEntry`/`Violation`/`stripComments` helpers and the `run()` wiring.

- [ ] **Step 2: Add the D21 checks** — confine (a) the `share.publish` action-type literal and (b) the `share.signing.privkey` Vault-key literal to the gate + keypair files:

```typescript
// D21 (I27): the share.publish HITL action type may be NAMED only in the executor frozen
// set and the share-gate; the share.signing.privkey Vault key only in share-keypair.ts.
const D21_PUBLISH_ALLOWED = [
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/share/share-gate.ts",
];
const D21_PUBLISH_RE = /['"`]share\.publish['"`]/;
const D21_PRIVKEY_ALLOWED = ["packages/gateway/src/share/share-keypair.ts"];
const D21_PRIVKEY_RE = /['"`]share\.signing\.privkey['"`]/;

function checkD21(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const lines = stripComments(f.contents).split("\n");
    const orig = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (D21_PUBLISH_RE.test(line) && !D21_PUBLISH_ALLOWED.includes(f.relPath))
        out.push({ rule: "D21-share-publish", file: f.relPath, line: i + 1, snippet: (orig[i] ?? "").trim() });
      if (D21_PRIVKEY_RE.test(line) && !D21_PRIVKEY_ALLOWED.includes(f.relPath))
        out.push({ rule: "D21-share-signing-privkey", file: f.relPath, line: i + 1, snippet: (orig[i] ?? "").trim() });
    }
  }
  return out;
}
```

Wire `checkD21(files)` into the aggregation in `run()` exactly like the D20 call (push its violations into the same list; match the existing `Violation` shape — adjust field names to the real type).

- [ ] **Step 3: Run the audit**

Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts`
Expected: PASS (0 violations — `share.publish` only in executor + gate; `share.signing.privkey` only in share-keypair).

- [ ] **Step 4: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(share): static D21 — confine share.publish + share.signing.privkey to the gate"
```

---

## Task 14: Docs — SECURITY-INVARIANTS, CLAUDE.md, skill

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (add I27 + D21 rationale/anti-patterns)
- Modify: `CLAUDE.md` (add the I27 bullet to the invariant list; update the static-complement line to include D21; bump "invariants through I27" / schema V41 in the status line per the connector-docs-changelog convention — note: status-line edits go in CHANGELOG/doc-refs, not the merge-conflict-prone CLAUDE status line; follow the doc-status-drift memory)
- Modify: `docs/CHANGELOG.md` (Slice 8a entry)

- [ ] **Step 1: Add the I27 row** to `docs/SECURITY-INVARIANTS.md` following the I26 entry's structure (wiring site, rationale, anti-patterns, the triple rule). Use the invariant text from the spec §6.7.

- [ ] **Step 2: Add the I27 bullet** to the invariant list in `CLAUDE.md` (after I26) and append `D21` to the static-complement sentence.

- [ ] **Step 3: Add a CHANGELOG entry** under the current version dated 2026-06-15 describing Slice 8a (share-gate, I27, V41, verify-share). Follow the connector-docs-changelog convention.

- [ ] **Step 4: Validate doc refs**

Run: `bun run audit:doc-refs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md CLAUDE.md docs/CHANGELOG.md
git commit -m "docs(share): I27 + D21 rationale, CHANGELOG 8a entry"
```

---

## Task 15: E2E CLI test (real gateway + file sink)

**Files:**

- Create: `packages/cli/test/e2e/share.e2e.test.ts` (match the existing e2e dir/naming — read a sibling e2e test first)

- [ ] **Step 1: Write the e2e test** — spin a real gateway subprocess, seed a session (insert `audit_log` rows with a `session_id` + a `tool_call_log` row), auto-approve the HITL via the e2e consent seam (read how preflight/tribal e2e tests approve owner HITL — likely an env seam or a `share.approvalRespond` call), run `nimbus share create <session> --out <tmp>.json`, then `nimbus verify-share <tmp>.json`, and assert the output reports a VALID signature and that the file contains no raw email/secret.

```typescript
// sketch — fill in using the sibling e2e harness (gateway spawn + IPC client)
import { describe, expect, test } from "bun:test";
// import { startGatewayForTest, runCli } from "<the existing e2e harness>";

describe("share e2e", () => {
  test("create -> verify round-trip with redaction", async () => {
    // 1. start gateway in a fresh temp dir
    // 2. seed audit_log (session_id="e2e-1", action_type engine.askUser/askAssistant) + tool_call_log
    // 3. trigger share.create with auto-approve; write to <tmp>/out.json
    // 4. read out.json -> assert no "alice@corp.com", contains "[REDACTED]"
    // 5. run verify-share <tmp>/out.json -> assert "signature: VALID"
    expect(true).toBe(true); // replace with real assertions
  });
});
```

> This is the one task with a real placeholder sketch because the e2e harness shape must be copied from a sibling test (e.g. a preflight/tribal e2e). Read that harness first, then write concrete assertions — do not ship the `expect(true)` line.

- [ ] **Step 2: Run the e2e test**

Run: `bun test packages/cli/test/e2e/share.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e/share.e2e.test.ts
git commit -m "test(share): e2e create -> verify round-trip with redaction"
```

---

## Final: full pre-flight before pushing

- [ ] **Run the I27 + invariant suite:** `bun test packages/gateway/src/security-invariants.test.ts`
- [ ] **Run the structure audit:** `bun run scripts/structure-audit/check-nimbus-invariants.ts`
- [ ] **Run the full pre-flight (CI parity):** `bun run preflight` (per the `nimbus-preflight` skill + the ship-readiness memory — full all-package tsc, build-lcov + coverage-floor (Docker-Linux-authoritative; new `share/*` files must clear ≥80% line+branch), lychee, whole-branch `/code-review`).
- [ ] **Open the PR** only after preflight is green (ship-readiness: never push-and-see).

---

## Self-Review notes (author)

- **Spec coverage:** §5 format (Task 4 incl. `forwarding` default), §6.1 redaction (Task 1), §6.2 gate+I27 (Tasks 7,8), §6.3 keypair (Task 3), §6.4 verify+expiry-advisory+SSRF (Tasks 2,9), §6.5 IPC/CLI/Tauri (Tasks 10,11,12), §6.6 V41 (Tasks 5,6), §6.7 I27/D21 (Tasks 7,13), §11 testing (each task is TDD + Task 15 e2e). Recipe/replay/forwarding population are out of 8a scope (Waves 8b–8d) — the `forwarding` field ships inert here.
- **Type consistency:** `ShareBody`/`ShareFile`/`VerifyResult` defined in Task 4 are reused verbatim in Tasks 8,9,10. `redactForShare → { redacted, applied }` consistent across Tasks 1,8. `ensureShareKeypair → { privkeyB64, pubkeyB64 }` consistent across Tasks 3,8,10.
- **Known verify-then-wire steps (not placeholders):** Task 10 Step 4 (dispatcher + LAN mechanism) and Task 15 (e2e harness) require reading the real sibling site first — each states the exact pattern + expected shape to copy.
