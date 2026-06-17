# Phase 6 Slice 8d — Sovereign-Mesh Referral — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user forward a signed, redacted share to a paired peer over the existing authenticated federation channel — with an immutable, origin-verifiable provenance hop-chain, an attribution chip ("forwarded from `<origin>`, N hops away"), and a deferred-reveal inbox that drains pending shares on first pair — closing Slice 8 and effectively Phase 6 (Team).

**Architecture:** Forwarding **out** is a share-emit and so passes the I27 gate. Two emit faces: (1) *origin* emit wires the existing `share create --to-peer` stub in `share-rpc.ts` (HITL already fired in `createShare`; `hops` stays 0); (2) *re-forward* is a new `share/share-forward.ts` `forwardShare()` that loads an existing signed share, owner-HITL-approves via the **existing** `share.publish` action, appends ONE hop to the top-level `forwarding` envelope (signed with the gateway's own Ed25519 share key over `contentHash ++ prior-chain`, leaving `body`+`sig` byte-identical), and delivers it over `sendFederatedOverWire`. Inbound shares arrive via a new wire-answerable `federation.shareReceive` and are stored **inert** (no execution, no index-merge) in a new V43 `share_inbox` table keyed by recipient pubkey; the first-successful-pair hook drains pending forwards to the newly-paired peer. No new invariant — forwarding reuses I27; D21's static confinement is extended (an audited new rule) to keep the chokepoint property true for the second emit path.

**Tech Stack:** Bun + TypeScript 6 strict · `bun:sqlite` · `tweetnacl` (`nacl.sign.detached` — same Ed25519 primitive `buildShareFile` uses) · `@noble/hashes/blake3` (existing share-format) · `js-yaml@^4.2.0` (existing) · Biome.

## Global Constraints

- **No `any`** — `unknown` for external/wire input (the inbound share file, the forwarding envelope, RPC params); TypeScript strict mode. (Non-Negotiable #7)
- **I27 is the single outbound-share chokepoint** — every share emitted to a file, HTTP sink, **or a federation peer** routes through the share-gate domain (`createShare` for origin, `forwardShare` for re-forward), both behind the LOCAL owner's `share.publish` HITL approval (a member of the `I2` frozen set). Forwarding adds NO new HITL action type and NO new invariant number (spec §13). A denied/timed-out approval emits nothing (fail-closed). (spec §9.1, §2)
- **Provenance is immutable inner + advisory envelope** — the inner `body`+`sig` are NEVER altered by a forwarder (byte-identical across hops, verifiable against the origin). The hop chain lives in the top-level `forwarding` envelope (OUTSIDE `canonicalizeBody`). Each hop signs over `contentHash ++ prior-chain` with the forwarder's own Ed25519 key; a tampered hop fails its OWN sig without touching content verification. The chain is advisory attribution and cannot forge or mutate content. (spec §9.2)
- **Receiving is inert** — an inbound forwarded share is stored as a viewable/replayable artifact ONLY: never auto-merged into the index, never auto-executed, no embedding write. Receiving therefore needs no HITL. This is a TESTED property, not a new invariant. (spec §9.4, §13)
- **Hop signing key** — a forwarder signs its hop with its OWN gateway Ed25519 share-signing key, obtained via `ensureShareKeypair(vault)` (the same key + primitive `buildShareFile` uses: `nacl.sign.keyPair.fromSeed(seed)` → `nacl.sign.detached`). The hop's `pubkey` is the forwarder's share pubkey (b64). The `share.signing.privkey` literal stays confined to `share-keypair.ts` (D21) — `share-forward.ts` only calls `ensureShareKeypair`, never names the key literal.
- **`federation.shareForward` is local-only; `federation.shareReceive` is answerable** — `shareForward` is the owner's asker-side trigger (like `federation.ask`) → added to `FORBIDDEN_OVER_LAN`. `shareReceive` is how shares arrive → NOT forbidden (answerable; `checkLanMethodAllowed` in `LanServer` is the I5 gate). (spec §9.1)
- **Migration is purely additive** — V43 adds ONE new table (`share_inbox`); it ALTERs no existing table and changes no existing SELECT/INSERT shape, so it cannot break tests that hand-build `tool_call_log`/`share_records` schemas. `CURRENT_SCHEMA_VERSION` 42 → 43.
- **Coverage** — every new/modified file clears the ≥80% line+branch true-coverage floor (Docker-Linux-authoritative; baseline at `docs/structure-audit/coverage-baseline.json`, `files: {}` → new files must clear ≥80%). Pure core files (`share-forwarding.ts`, `share-inbox-store.ts`, `share-forward.ts`, the attribution formatter) must be ≥80%; IPC/CLI glue follows the 8a/8c exclusion precedent only where a pure core can't be tested.
- **Tests** — run with `bun test <path>`; gateway unit tests live beside source as `*.test.ts`; integration tests under `packages/gateway/test/integration/`; e2e under `packages/gateway/test/e2e/`.

---

### Task 1: `share/share-forwarding.ts` — pure hop-chain crypto

**Files:**

- Create: `packages/gateway/src/share/share-forwarding.ts`
- Test: `packages/gateway/src/share/share-forwarding.test.ts`

**Interfaces:**

- Consumes: `ShareFile`, `ShareForwardingHop` from `./share-format.ts` (already defined: `ShareFile.forwarding = { hops: number; chain: readonly ShareForwardingHop[] }`; `ShareForwardingHop = { gatewayLabel: string; pubkey: string; sig: string }`).
- Produces:
  - `function hopSigningMessage(contentHash: string, priorChain: readonly ShareForwardingHop[]): Uint8Array` — the canonical bytes a hop signs over (`contentHash` ++ stable-serialized prior chain).
  - `function appendForwardingHop(share: ShareFile, signer: { gatewayLabel: string; pubkeyB64: string; privkeyB64: string }): ShareFile` — returns a NEW `ShareFile` with `body`+`sig` byte-identical, `forwarding.chain` gaining ONE hop and `forwarding.hops` incremented. Signs over `hopSigningMessage(share.contentHash, priorChain)` with `nacl.sign.detached`.
  - `interface ForwardingChainResult { readonly valid: boolean; readonly hopsValid: number; readonly hopsTotal: number; readonly errors: readonly string[] }`.
  - `function verifyForwardingChain(share: ShareFile): ForwardingChainResult` — validates each hop's sig against its claimed `pubkey` over `hopSigningMessage(contentHash, chain[0..i-1])`. Advisory — never touches content/origin verification.

> **Why the gateway's own share key signs the hop** (spec §9.2 + Global Constraints): the federation *box* identity (`federation.identity_secret`) is an X25519 key — usable for NaCl `box` (the wire seal) but NOT for detached signatures. The gateway already has an Ed25519 identity (its share-signing keypair via `ensureShareKeypair`); reusing it keeps the hop offline-verifiable by anyone holding the share, with no new Vault key. The hop `pubkey` is that gateway's share pubkey, exactly as `body.origin.pubkey` is the origin's.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/share-forwarding.test.ts
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { buildShareFile, type ShareBody } from "./share-format.ts";
import { appendForwardingHop, verifyForwardingChain } from "./share-forwarding.ts";

function kp(seedByte: number): { privkeyB64: string; pubkeyB64: string } {
  const seed = new Uint8Array(32).fill(seedByte);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return {
    privkeyB64: Buffer.from(seed).toString("base64"),
    pubkeyB64: Buffer.from(pair.publicKey).toString("base64"),
  };
}

function originShare(): ReturnType<typeof buildShareFile> {
  const origin = kp(1);
  const body: ShareBody = {
    kind: "recipe",
    sessionId: "s1",
    createdAt: 1,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "alice", pubkey: origin.pubkeyB64 },
    recipe: { recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, steps: [], graphTraversals: [] },
  };
  return buildShareFile(body, origin.privkeyB64, origin.pubkeyB64);
}

describe("appendForwardingHop", () => {
  test("leaves body + sig + contentHash byte-identical; increments hops; adds one hop", () => {
    const base = originShare();
    const bob = kp(2);
    const fwd = appendForwardingHop(base, { gatewayLabel: "bob", ...bob });
    expect(JSON.stringify(fwd.body)).toBe(JSON.stringify(base.body)); // body untouched
    expect(fwd.sig).toEqual(base.sig); // origin sig untouched
    expect(fwd.contentHash).toBe(base.contentHash);
    expect(fwd.forwarding.hops).toBe(1);
    expect(fwd.forwarding.chain).toHaveLength(1);
    expect(fwd.forwarding.chain[0]?.gatewayLabel).toBe("bob");
    expect(fwd.forwarding.chain[0]?.pubkey).toBe(bob.pubkeyB64);
  });

  test("a second hop chains over the prior chain; both verify", () => {
    const base = originShare();
    const hop1 = appendForwardingHop(base, { gatewayLabel: "bob", ...kp(2) });
    const hop2 = appendForwardingHop(hop1, { gatewayLabel: "carol", ...kp(3) });
    expect(hop2.forwarding.hops).toBe(2);
    expect(hop2.forwarding.chain.map((h) => h.gatewayLabel)).toEqual(["bob", "carol"]);
    expect(verifyForwardingChain(hop2).valid).toBe(true);
    expect(verifyForwardingChain(hop2).hopsValid).toBe(2);
  });
});

describe("verifyForwardingChain", () => {
  test("empty chain is valid (0 hops)", () => {
    const r = verifyForwardingChain(originShare());
    expect(r.valid).toBe(true);
    expect(r.hopsTotal).toBe(0);
  });

  test("a tampered hop sig fails its own sig but is detected without touching content", () => {
    const hop1 = appendForwardingHop(originShare(), { gatewayLabel: "bob", ...kp(2) });
    const tampered: typeof hop1 = {
      ...hop1,
      forwarding: {
        hops: 1,
        chain: [{ ...hop1.forwarding.chain[0]!, gatewayLabel: "mallory" }], // label changed, sig now stale
      },
    };
    const r = verifyForwardingChain(tampered);
    expect(r.valid).toBe(false);
    expect(r.hopsValid).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-forwarding.test.ts`
Expected: FAIL — `Cannot find module './share-forwarding.ts'`.

- [ ] **Step 3: Implement the module**

```ts
// packages/gateway/src/share/share-forwarding.ts
import nacl from "tweetnacl";
import type { ShareFile, ShareForwardingHop } from "./share-format.ts";

/**
 * Canonical bytes a forwarding hop signs over: the immutable `contentHash` concatenated with a
 * stable serialization of the PRIOR chain entries. Because every hop binds the content hash, a hop
 * sig is meaningless if detached from its share; because it binds the prior chain, hops cannot be
 * reordered or truncated without invalidating later hops. Pure + deterministic. (spec §9.2)
 */
export function hopSigningMessage(
  contentHash: string,
  priorChain: readonly ShareForwardingHop[],
): Uint8Array {
  const stablePrior = priorChain.map((h) => ({
    gatewayLabel: h.gatewayLabel,
    pubkey: h.pubkey,
    sig: h.sig,
  }));
  return new TextEncoder().encode(`${contentHash}\n${JSON.stringify(stablePrior)}`);
}

/**
 * Append ONE forwarding hop. The inner `body` + origin `sig` + `contentHash` are returned untouched
 * (byte-identical) — a forwarder NEVER re-signs or mutates content. Only the top-level `forwarding`
 * envelope grows: one `{ gatewayLabel, pubkey, sig }` entry signed with the forwarder's Ed25519
 * share key (same primitive as `buildShareFile`) over `hopSigningMessage(contentHash, priorChain)`.
 */
export function appendForwardingHop(
  share: ShareFile,
  signer: { gatewayLabel: string; pubkeyB64: string; privkeyB64: string },
): ShareFile {
  const seed = new Uint8Array(Buffer.from(signer.privkeyB64, "base64"));
  if (seed.length !== 32) {
    throw new TypeError(`hop signing key must be a 32-byte seed, got ${seed.length}`);
  }
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const priorChain = share.forwarding.chain;
  const msg = hopSigningMessage(share.contentHash, priorChain);
  const sig = Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("base64");
  const hop: ShareForwardingHop = { gatewayLabel: signer.gatewayLabel, pubkey: signer.pubkeyB64, sig };
  return {
    ...share,
    forwarding: { hops: share.forwarding.hops + 1, chain: [...priorChain, hop] },
  };
}

export interface ForwardingChainResult {
  readonly valid: boolean;
  readonly hopsValid: number;
  readonly hopsTotal: number;
  readonly errors: readonly string[];
}

/**
 * Validate the advisory hop chain: each hop's `sig` must verify against its claimed `pubkey` over
 * `hopSigningMessage(contentHash, chain[0..i-1])`. Never touches content/origin verification — a
 * bad hop is reported here while the inner `body`/`sig` remain independently verifiable.
 */
export function verifyForwardingChain(share: ShareFile): ForwardingChainResult {
  const chain = share.forwarding.chain;
  const errors: string[] = [];
  let hopsValid = 0;
  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    if (hop === undefined) continue;
    try {
      const pub = new Uint8Array(Buffer.from(hop.pubkey, "base64"));
      const sig = new Uint8Array(Buffer.from(hop.sig, "base64"));
      const msg = hopSigningMessage(share.contentHash, chain.slice(0, i));
      if (pub.length === 32 && sig.length === 64 && nacl.sign.detached.verify(msg, sig, pub)) {
        hopsValid++;
      } else {
        errors.push(`hop ${i} (${hop.gatewayLabel}): signature invalid`);
      }
    } catch {
      errors.push(`hop ${i} (${hop.gatewayLabel}): malformed key/signature`);
    }
  }
  return { valid: errors.length === 0, hopsValid, hopsTotal: chain.length, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-forwarding.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** — controller commits after DONE (implementers do NOT commit). Staged:

```bash
git add packages/gateway/src/share/share-forwarding.ts packages/gateway/src/share/share-forwarding.test.ts
git commit -m "feat(share): pure forwarding hop-chain crypto (append + verify)"
```

---

### Task 2: Migration V43 — `share_inbox`

**Files:**

- Create: `packages/gateway/src/index/share-inbox-v43-sql.ts`
- Test: `packages/gateway/src/index/share-inbox-v43-sql.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (register the step after the V42 line)
- Modify: `packages/gateway/src/index/local-index.ts:269` (`CURRENT_SCHEMA_VERSION` 42 → 43)

**Interfaces:**

- Produces: `export const SHARE_INBOX_V43_SQL: string` — the DDL for the `share_inbox` table.

> **Single dual-purpose table** (spec §10: "`share_inbox` (received / pending-forward, keyed by recipient pubkey)"): `direction = 'pending'` rows are sender-side forwards awaiting a not-yet-paired recipient (drained on first pair); `direction = 'received'` rows are inbound inert artifacts. `share_json` holds the full signed `ShareFile` (body + sig + forwarding envelope) so a row is a self-contained, replayable artifact. `origin_label` + `hops` are denormalized for cheap attribution-chip rendering. Append-only; manual prune only (consistent with `share_records`, spec §10).

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/index/share-inbox-v43-sql.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SHARE_INBOX_V43_SQL } from "./share-inbox-v43-sql.ts";

describe("SHARE_INBOX_V43_SQL", () => {
  test("creates share_inbox with the expected columns + indexes; is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(SHARE_INBOX_V43_SQL);
    db.exec(SHARE_INBOX_V43_SQL); // CREATE ... IF NOT EXISTS → idempotent
    const cols = (db.query("PRAGMA table_info(share_inbox)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "content_hash",
        "direction",
        "hops",
        "id",
        "origin_label",
        "received_at",
        "recipient_pubkey",
        "share_json",
        "status",
      ].sort(),
    );
    db.run(
      `INSERT INTO share_inbox (recipient_pubkey, content_hash, direction, share_json, origin_label, hops, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["PUB", "abc", "received", "{}", "alice", 1, 100, "viewable"],
    );
    expect((db.query("SELECT COUNT(*) c FROM share_inbox").get() as { c: number }).c).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/share-inbox-v43-sql.test.ts`
Expected: FAIL — `Cannot find module './share-inbox-v43-sql.ts'`.

- [ ] **Step 3: Implement the DDL**

```ts
// packages/gateway/src/index/share-inbox-v43-sql.ts

/**
 * V43 (Phase 6 Slice 8d) — `share_inbox`: a single dual-purpose, recipient-pubkey-keyed table.
 *
 *   direction = 'pending'  → a sender-side forward awaiting a not-yet-paired recipient; the
 *                            first-successful-pair hook drains these to the newly-paired peer.
 *   direction = 'received' → an inbound, INERT forwarded share (viewable/replayable; never merged
 *                            into the index, never executed — receiving needs no HITL, spec §9.4).
 *
 * `share_json` is the full signed ShareFile (body + sig + forwarding envelope), so each row is a
 * self-contained artifact. `origin_label`/`hops` are denormalized for the attribution chip.
 * Append-only; manual prune only (mirrors share_records, spec §10).
 */
export const SHARE_INBOX_V43_SQL = `
CREATE TABLE IF NOT EXISTS share_inbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_pubkey  TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  direction         TEXT NOT NULL,
  share_json        TEXT NOT NULL,
  origin_label      TEXT NOT NULL,
  hops              INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  status            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_inbox_unique
  ON share_inbox(recipient_pubkey, content_hash, direction);
CREATE INDEX IF NOT EXISTS idx_share_inbox_recipient ON share_inbox(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_share_inbox_status ON share_inbox(status);
`;
```

- [ ] **Step 4: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import near the other V41/V42 SQL imports:

```ts
import { SHARE_INBOX_V43_SQL } from "../share-inbox-v43-sql.ts";
```

Then add to `INDEXED_SCHEMA_STEPS`, immediately AFTER the V42 line (`simpleStep(41, 42, "tool_call_log.params_json (recipe params v42)", TOOL_CALL_PARAMS_V42_SQL),`):

```ts
simpleStep(42, 43, "share_inbox (sovereign-mesh referral v43)", SHARE_INBOX_V43_SQL),
```

- [ ] **Step 5: Bump `CURRENT_SCHEMA_VERSION`**

In `packages/gateway/src/index/local-index.ts:269`, change:

```ts
export const CURRENT_SCHEMA_VERSION = 42;
```

to:

```ts
export const CURRENT_SCHEMA_VERSION = 43;
```

- [ ] **Step 6: Find + fix any schema-version assertions**

Run: `grep -rn "SCHEMA_VERSION\b\|toBe(42)\|=== 42\|version: 42" packages/gateway/src --include=*.test.ts | grep -i "version\|migrat"`
Any test asserting the current version is `42` or that the migration ledger ends at V42 must be bumped to 43. Patch each. (The new table is additive — no `tool_call_log`/`share_records` hand-built-schema test needs a change, but a migrations-roundtrip test that walks `0 → CURRENT` will now expect a `share_inbox` table to exist; assert it does.)

- [ ] **Step 7: Run tests + commit**

Run: `bun test packages/gateway/src/index/share-inbox-v43-sql.test.ts packages/gateway/src/index/migrations/`
Expected: PASS.

```bash
git add packages/gateway/src/index/share-inbox-v43-sql.ts packages/gateway/src/index/share-inbox-v43-sql.test.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts
git commit -m "feat(share): V43 share_inbox migration (deferred-reveal referral inbox)"
```

---

### Task 3: `share/share-inbox-store.ts` — inbox persistence

**Files:**

- Create: `packages/gateway/src/share/share-inbox-store.ts`
- Test: `packages/gateway/src/share/share-inbox-store.test.ts`

**Interfaces:**

- Consumes: `Database` from `bun:sqlite`; `ShareFile` from `./share-format.ts`; `SHARE_INBOX_V43_SQL` from `../index/share-inbox-v43-sql.ts` (test only — to build the table).
- Produces:
  - `interface ShareInboxRow { readonly id: number; readonly recipientPubkey: string; readonly contentHash: string; readonly direction: "pending" | "received"; readonly share: ShareFile; readonly originLabel: string; readonly hops: number; readonly receivedAt: number; readonly status: string }`.
  - `function insertPendingForward(db, p: { recipientPubkey: string; share: ShareFile; now: number }): void` — inserts a `direction='pending'`, `status='pending'` row (`INSERT OR IGNORE` on the unique index → idempotent re-forward).
  - `function insertReceivedShare(db, p: { share: ShareFile; now: number }): void` — inserts a `direction='received'`, `status='viewable'` row keyed by `share.sig.pubkey`... **no** — keyed by the LOCAL recipient; the store does not know "self", so the caller passes nothing and we key received rows by the share's origin? See note. Keyed by `recipientPubkey = "self"` sentinel is wrong; instead key by the share's `contentHash` uniqueness and store `recipient_pubkey = share.body.origin.pubkey`? Resolved below — received rows use `recipient_pubkey = '@self'` constant (only the local gateway holds its own received inbox).
  - `function listReceivedShares(db, opts: { limit?: number }): ShareInboxRow[]` — `direction='received'`, newest first.
  - `function drainPending(db, recipientPubkey: string): ShareInboxRow[]` — returns all `direction='pending'` rows for that recipient (caller delivers them, then calls `markDelivered`).
  - `function markDelivered(db, id: number): void` — sets `status='delivered'` (kept for audit; not re-drained).

> **Keying decision.** A `pending` row is keyed by the intended *recipient*'s pubkey (b64) — the sender may hold pending forwards for many recipients. A `received` row is the local gateway's own inbox; it is keyed by the constant `RECEIVED_SELF = "@self"` so `listReceivedShares` is a simple `WHERE recipient_pubkey = '@self'` and the `(recipient_pubkey, content_hash, direction)` unique index dedupes a re-delivered share. `origin_label`/`hops` are read off the share (`share.body.origin.label`, `share.forwarding.hops`) at insert.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/share-inbox-store.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SHARE_INBOX_V43_SQL } from "../index/share-inbox-v43-sql.ts";
import type { ShareFile } from "./share-format.ts";
import {
  drainPending,
  insertPendingForward,
  insertReceivedShare,
  listReceivedShares,
  markDelivered,
} from "./share-inbox-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(SHARE_INBOX_V43_SQL);
  return d;
}

function share(hash: string, originLabel: string, hops: number): ShareFile {
  return {
    format: "nimbus-share/v1",
    contentHash: hash,
    body: {
      kind: "recipe",
      sessionId: "s1",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: originLabel, pubkey: "ORIGIN" },
    },
    sig: { alg: "ed25519", pubkey: "ORIGIN", signature: "S" },
    forwarding: { hops, chain: [] },
  };
}

describe("share-inbox-store", () => {
  test("received share round-trips with attribution; idempotent", () => {
    const d = db();
    insertReceivedShare(d, { share: share("h1", "alice", 2), now: 100 });
    insertReceivedShare(d, { share: share("h1", "alice", 2), now: 100 }); // dedup
    const rows = listReceivedShares(d, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.originLabel).toBe("alice");
    expect(rows[0]?.hops).toBe(2);
    expect(rows[0]?.share.contentHash).toBe("h1");
    expect(rows[0]?.direction).toBe("received");
  });

  test("pending forwards are keyed by recipient + drained per recipient", () => {
    const d = db();
    insertPendingForward(d, { recipientPubkey: "BOB", share: share("h1", "alice", 1), now: 10 });
    insertPendingForward(d, { recipientPubkey: "BOB", share: share("h2", "alice", 1), now: 11 });
    insertPendingForward(d, { recipientPubkey: "CAROL", share: share("h3", "alice", 1), now: 12 });
    const bob = drainPending(d, "BOB");
    expect(bob.map((r) => r.contentHash).sort()).toEqual(["h1", "h2"]);
    expect(drainPending(d, "CAROL").map((r) => r.contentHash)).toEqual(["h3"]);
    markDelivered(d, bob[0]!.id);
    // delivered rows are not re-drained
    expect(drainPending(d, "BOB").map((r) => r.contentHash)).toEqual(["h2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-inbox-store.test.ts`
Expected: FAIL — `Cannot find module './share-inbox-store.ts'`.

- [ ] **Step 3: Implement the store**

```ts
// packages/gateway/src/share/share-inbox-store.ts
import type { Database } from "bun:sqlite";
import type { ShareFile } from "./share-format.ts";

/** Received rows are the local gateway's own inbox — keyed by this constant, not a peer pubkey. */
const RECEIVED_SELF = "@self";

export interface ShareInboxRow {
  readonly id: number;
  readonly recipientPubkey: string;
  readonly contentHash: string;
  readonly direction: "pending" | "received";
  readonly share: ShareFile;
  readonly originLabel: string;
  readonly hops: number;
  readonly receivedAt: number;
  readonly status: string;
}

interface RawRow {
  id: number;
  recipient_pubkey: string;
  content_hash: string;
  direction: string;
  share_json: string;
  origin_label: string;
  hops: number;
  received_at: number;
  status: string;
}

function toRow(r: RawRow): ShareInboxRow {
  return {
    id: r.id,
    recipientPubkey: r.recipient_pubkey,
    contentHash: r.content_hash,
    direction: r.direction === "pending" ? "pending" : "received",
    share: JSON.parse(r.share_json) as ShareFile,
    originLabel: r.origin_label,
    hops: r.hops,
    receivedAt: r.received_at,
    status: r.status,
  };
}

function insert(
  db: Database,
  p: {
    recipientPubkey: string;
    share: ShareFile;
    direction: "pending" | "received";
    status: string;
    now: number;
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO share_inbox
       (recipient_pubkey, content_hash, direction, share_json, origin_label, hops, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.recipientPubkey,
      p.share.contentHash,
      p.direction,
      JSON.stringify(p.share),
      p.share.body.origin.label,
      p.share.forwarding.hops,
      p.now,
      p.status,
    ],
  );
}

/** Queue a forward for a (possibly not-yet-paired) recipient, keyed by their pubkey. */
export function insertPendingForward(
  db: Database,
  p: { recipientPubkey: string; share: ShareFile; now: number },
): void {
  insert(db, { ...p, direction: "pending", status: "pending" });
}

/** Store an inbound forwarded share as an inert, viewable artifact in the local inbox. */
export function insertReceivedShare(db: Database, p: { share: ShareFile; now: number }): void {
  insert(db, { recipientPubkey: RECEIVED_SELF, ...p, direction: "received", status: "viewable" });
}

/** List the local inbox (received inert shares), newest first. */
export function listReceivedShares(db: Database, opts: { limit?: number }): ShareInboxRow[] {
  const limit = opts.limit ?? 200;
  const rows = db
    .query(
      `SELECT * FROM share_inbox WHERE direction = 'received' AND recipient_pubkey = ?
       ORDER BY received_at DESC LIMIT ?`,
    )
    .all(RECEIVED_SELF, limit) as RawRow[];
  return rows.map(toRow);
}

/** All still-pending forwards queued for a recipient pubkey (status 'pending'). */
export function drainPending(db: Database, recipientPubkey: string): ShareInboxRow[] {
  const rows = db
    .query(
      `SELECT * FROM share_inbox WHERE direction = 'pending' AND status = 'pending' AND recipient_pubkey = ?
       ORDER BY received_at ASC`,
    )
    .all(recipientPubkey) as RawRow[];
  return rows.map(toRow);
}

/** Mark a pending forward delivered (kept for audit; never re-drained). */
export function markDelivered(db: Database, id: number): void {
  db.run(`UPDATE share_inbox SET status = 'delivered' WHERE id = ?`, [id]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-inbox-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-inbox-store.ts packages/gateway/src/share/share-inbox-store.test.ts
git commit -m "feat(share): share_inbox store (pending forwards + received inert artifacts)"
```

---

### Task 4: `share/share-forward.ts` — `forwardShare()` (HITL-gated re-forward emit)

**Files:**

- Create: `packages/gateway/src/share/share-forward.ts`
- Test: `packages/gateway/src/share/share-forward.test.ts`

**Interfaces:**

- Consumes: `ShareFile` (`./share-format.ts`); `appendForwardingHop` (`./share-forwarding.ts`); `ShareInboxRow` is not needed here.
- Produces:
  - `interface ForwardPeer { readonly host: string; readonly port: number; readonly pubkey: string }` — a reachable paired peer.
  - `interface ForwardShareDeps {`
    - `readonly now: () => number;`
    - `readonly label: string;` // this gateway's display label (hop gatewayLabel)
    - `readonly loadShare: (contentHash: string) => ShareFile | undefined;` // from share_records (or inbox)
    - `readonly shareKeypair: () => Promise<{ privkeyB64: string; pubkeyB64: string }>;` // ensureShareKeypair
    - `readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;` // share.publish HITL (shareConsent broker)
    - `readonly lookupPeer: (recipientPubkey: string) => ForwardPeer | undefined;` // paired+reachable?
    - `readonly deliver: (share: ShareFile, peer: ForwardPeer) => Promise<void>;` // sendFederatedOverWire
    - `readonly queuePending: (recipientPubkey: string, share: ShareFile) => void;` // insertPendingForward
    - `readonly recordAudit: (e: { actionType: string; hitlStatus: string; actionJson: string; timestamp: number }) => void;`
  - `}`
  - `type ForwardOutcome = { readonly status: "rejected" } | { readonly status: "ok"; readonly delivered: boolean; readonly contentHash: string }`.
  - `async function forwardShare(req: { contentHash: string; recipientPubkey: string }, deps: ForwardShareDeps): Promise<ForwardOutcome>`.

> **`forwardShare` IS the second I27 emit chokepoint** (Global Constraints; D21 extension in Task 6). Order: load → owner HITL via `share.publish` (fail-closed: a deny persists/forwards NOTHING) → append the local gateway's hop IFF this gateway is not the origin → deliver to a reachable peer OR queue pending for a not-yet-paired recipient → audit. The `share.publish` literal is named here (the audit `actionType`), which is why Task 6 adds `share-forward.ts` to `D21_PUBLISH_ALLOWED`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/share-forward.test.ts
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { buildShareFile, type ShareBody, type ShareFile } from "./share-format.ts";
import { type ForwardPeer, type ForwardShareDeps, forwardShare } from "./share-forward.ts";
import { verifyForwardingChain } from "./share-forwarding.ts";

function kp(b: number) {
  const seed = new Uint8Array(32).fill(b);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return { privkeyB64: Buffer.from(seed).toString("base64"), pubkeyB64: Buffer.from(pair.publicKey).toString("base64") };
}
const ORIGIN = kp(1);
const SELF = kp(9);

function aliceShare(): ShareFile {
  const body: ShareBody = {
    kind: "recipe", sessionId: "s1", createdAt: 1, expiresAt: null, redactionSet: [],
    origin: { label: "alice", pubkey: ORIGIN.pubkeyB64 },
    recipe: { recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, steps: [], graphTraversals: [] },
  };
  return buildShareFile(body, ORIGIN.privkeyB64, ORIGIN.pubkeyB64);
}

function baseDeps(over: Partial<ForwardShareDeps>): ForwardShareDeps {
  const share = aliceShare();
  return {
    now: () => 100,
    label: "bob",
    loadShare: (h) => (h === share.contentHash ? share : undefined),
    shareKeypair: async () => SELF,
    requestApproval: async () => true,
    lookupPeer: () => undefined,
    deliver: async () => {},
    queuePending: () => {},
    recordAudit: () => {},
    ...over,
  };
}

describe("forwardShare", () => {
  test("approved + reachable peer → appends hop, delivers, audits approved", async () => {
    const share = aliceShare();
    const peer: ForwardPeer = { host: "1.2.3.4", port: 9, pubkey: "BOXPUB" };
    let deliveredShare: ShareFile | undefined;
    const audit: string[] = [];
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        lookupPeer: () => peer,
        deliver: async (s) => { deliveredShare = s; },
        recordAudit: (e) => audit.push(`${e.actionType}:${e.hitlStatus}`),
      }),
    );
    expect(out).toEqual({ status: "ok", delivered: true, contentHash: share.contentHash });
    expect(deliveredShare?.forwarding.hops).toBe(1);
    expect(deliveredShare?.body).toEqual(share.body); // inner body untouched
    expect(verifyForwardingChain(deliveredShare!).valid).toBe(true);
    expect(audit).toEqual(["share.publish:approved"]);
  });

  test("approved + NOT-paired recipient → queues pending (not delivered)", async () => {
    const share = aliceShare();
    let queued: ShareFile | undefined;
    let delivered = false;
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "CAROL" },
      baseDeps({
        lookupPeer: () => undefined,
        queuePending: (_r, s) => { queued = s; },
        deliver: async () => { delivered = true; },
      }),
    );
    expect(out).toEqual({ status: "ok", delivered: false, contentHash: share.contentHash });
    expect(queued?.forwarding.hops).toBe(1);
    expect(delivered).toBe(false);
  });

  test("denied approval → fail-closed: no deliver, no queue, audits rejected", async () => {
    const share = aliceShare();
    let touched = false;
    const audit: string[] = [];
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        requestApproval: async () => false,
        lookupPeer: () => ({ host: "h", port: 1, pubkey: "P" }),
        deliver: async () => { touched = true; },
        queuePending: () => { touched = true; },
        recordAudit: (e) => audit.push(`${e.actionType}:${e.hitlStatus}`),
      }),
    );
    expect(out).toEqual({ status: "rejected" });
    expect(touched).toBe(false);
    expect(audit).toEqual(["share.publish:rejected"]);
  });

  test("unknown contentHash → rejected, no approval requested", async () => {
    let approvalAsked = false;
    const out = await forwardShare(
      { contentHash: "nope", recipientPubkey: "BOB" },
      baseDeps({ requestApproval: async () => { approvalAsked = true; return true; } }),
    );
    expect(out).toEqual({ status: "rejected" });
    expect(approvalAsked).toBe(false);
  });

  test("forwarding own share (origin == self) → no hop appended (hops stays 0)", async () => {
    // Build a share whose origin IS this gateway's share key.
    const body: ShareBody = {
      kind: "recipe", sessionId: "s1", createdAt: 1, expiresAt: null, redactionSet: [],
      origin: { label: "bob", pubkey: SELF.pubkeyB64 },
      recipe: { recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, steps: [], graphTraversals: [] },
    };
    const own = buildShareFile(body, SELF.privkeyB64, SELF.pubkeyB64);
    let deliveredShare: ShareFile | undefined;
    await forwardShare(
      { contentHash: own.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        loadShare: (h) => (h === own.contentHash ? own : undefined),
        lookupPeer: () => ({ host: "h", port: 1, pubkey: "P" }),
        deliver: async (s) => { deliveredShare = s; },
      }),
    );
    expect(deliveredShare?.forwarding.hops).toBe(0);
    expect(deliveredShare?.forwarding.chain).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-forward.test.ts`
Expected: FAIL — `Cannot find module './share-forward.ts'`.

- [ ] **Step 3: Implement `forwardShare`**

```ts
// packages/gateway/src/share/share-forward.ts
import type { ShareFile } from "./share-format.ts";
import { appendForwardingHop } from "./share-forwarding.ts";

export interface ForwardPeer {
  readonly host: string;
  readonly port: number;
  readonly pubkey: string;
}

export interface ForwardShareDeps {
  readonly now: () => number;
  readonly label: string;
  readonly loadShare: (contentHash: string) => ShareFile | undefined;
  readonly shareKeypair: () => Promise<{ privkeyB64: string; pubkeyB64: string }>;
  readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;
  readonly lookupPeer: (recipientPubkey: string) => ForwardPeer | undefined;
  readonly deliver: (share: ShareFile, peer: ForwardPeer) => Promise<void>;
  readonly queuePending: (recipientPubkey: string, share: ShareFile) => void;
  readonly recordAudit: (e: {
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
  }) => void;
}

export type ForwardOutcome =
  | { readonly status: "rejected" }
  | { readonly status: "ok"; readonly delivered: boolean; readonly contentHash: string };

/**
 * Re-forward an existing signed share to a peer — the SECOND I27 outbound-share chokepoint
 * (the first is `createShare`). The inner body+sig are never altered; only a forwarding hop is
 * appended (unless this gateway IS the origin). Owner-HITL via `share.publish` is mandatory and
 * fail-closed (a deny forwards/queues NOTHING). A reachable paired peer is delivered to immediately;
 * a not-yet-paired recipient is queued in `share_inbox` (drained on first pair, spec §9.4).
 */
export async function forwardShare(
  req: { contentHash: string; recipientPubkey: string },
  deps: ForwardShareDeps,
): Promise<ForwardOutcome> {
  const share = deps.loadShare(req.contentHash);
  if (share === undefined) return { status: "rejected" };

  const preview = {
    contentHash: share.contentHash,
    origin: share.body.origin,
    hops: share.forwarding.hops,
    recipientPubkey: req.recipientPubkey,
  };
  const approved = await deps.requestApproval(preview, share.body.redactionSet);
  const ts = deps.now();
  if (!approved) {
    deps.recordAudit({
      actionType: "share.publish",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({ forward: preview }),
      timestamp: ts,
    });
    return { status: "rejected" };
  }

  // Append THIS gateway's hop unless it authored the share (origin == self → no self-hop).
  const kp = await deps.shareKeypair();
  const forwarded =
    share.body.origin.pubkey === kp.pubkeyB64
      ? share
      : appendForwardingHop(share, {
          gatewayLabel: deps.label,
          pubkeyB64: kp.pubkeyB64,
          privkeyB64: kp.privkeyB64,
        });

  const peer = deps.lookupPeer(req.recipientPubkey);
  let delivered = false;
  if (peer !== undefined) {
    await deps.deliver(forwarded, peer);
    delivered = true;
  } else {
    deps.queuePending(req.recipientPubkey, forwarded);
  }

  deps.recordAudit({
    actionType: "share.publish",
    hitlStatus: "approved",
    actionJson: JSON.stringify({
      forward: preview,
      delivered,
      hops: forwarded.forwarding.hops,
    }),
    timestamp: ts,
  });
  return { status: "ok", delivered, contentHash: share.contentHash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-forward.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-forward.ts packages/gateway/src/share/share-forward.test.ts
git commit -m "feat(share): forwardShare — HITL-gated re-forward emit (I27, second chokepoint)"
```

---

### Task 5: `share/share-forward.ts` — `receiveForwardedShare()` (inbound inert store)

**Files:**

- Modify: `packages/gateway/src/share/share-forward.ts`
- Test: `packages/gateway/src/share/share-forward.test.ts` (append)

**Interfaces:**

- Consumes: `ShareFile` (`./share-format.ts`); `verifyShareBytes` (`./share-format.ts`).
- Produces:
  - `interface ReceiveShareDeps {`
    - `readonly now: () => number;`
    - `readonly storeReceived: (share: ShareFile) => void;` // insertReceivedShare
    - `}`
  - `type ReceiveOutcome = { readonly ok: boolean; readonly reason?: string }`.
  - `async function receiveForwardedShare(rawShare: unknown, deps: ReceiveShareDeps): Promise<ReceiveOutcome>` — validates the inbound share's CONTENT signature (reject if invalid — never store garbage), then stores it inert. NO execution, NO index-merge, NO embedding write — receiving is inert and needs no HITL (spec §9.4). The hop chain is advisory and is NOT a gate on storage.

> **Inert is the receiving-side safety property** (spec §9.4, §13 → no new invariant; a TESTED property). `receiveForwardedShare` may ONLY: verify the content sig and call `storeReceived`. It must never reach the executor, the index writer, or the embedding pipeline. The Task-5 test asserts the deps surface is exactly `{ now, storeReceived }` — there is no executor/index dep to call.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to packages/gateway/src/share/share-forward.test.ts
import { receiveForwardedShare, type ReceiveShareDeps } from "./share-forward.ts";

describe("receiveForwardedShare — inert inbound", () => {
  test("valid signed share → stored inert (no execution dep exists to call)", async () => {
    const share = aliceShare();
    let stored: ShareFile | undefined;
    const deps: ReceiveShareDeps = { now: () => 1, storeReceived: (s) => { stored = s; } };
    const out = await receiveForwardedShare(share, deps);
    expect(out.ok).toBe(true);
    expect(stored?.contentHash).toBe(share.contentHash);
  });

  test("tampered body (bad content sig) → rejected, NOT stored", async () => {
    const share = aliceShare();
    const tampered = { ...share, body: { ...share.body, sessionId: "EVIL" } }; // sig no longer matches
    let stored = false;
    const out = await receiveForwardedShare(tampered, { now: () => 1, storeReceived: () => { stored = true; } });
    expect(out.ok).toBe(false);
    expect(stored).toBe(false);
  });

  test("non-object / malformed input → rejected (fail-safe)", async () => {
    let stored = false;
    const deps: ReceiveShareDeps = { now: () => 1, storeReceived: () => { stored = true; } };
    expect((await receiveForwardedShare(null, deps)).ok).toBe(false);
    expect((await receiveForwardedShare("nope", deps)).ok).toBe(false);
    expect(stored).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-forward.test.ts`
Expected: FAIL — `receiveForwardedShare` not exported.

- [ ] **Step 3: Implement `receiveForwardedShare` (append to share-forward.ts)**

```ts
// append to packages/gateway/src/share/share-forward.ts
import { verifyShareBytes } from "./share-format.ts";

export interface ReceiveShareDeps {
  readonly now: () => number;
  /** Persist the inbound share as an INERT, viewable artifact (insertReceivedShare). */
  readonly storeReceived: (share: ShareFile) => void;
}

export type ReceiveOutcome = { readonly ok: boolean; readonly reason?: string };

/**
 * Accept an inbound forwarded share and store it INERT (spec §9.4): the content signature must
 * verify (reject otherwise — never persist a forged body), then the share is recorded as a
 * viewable/replayable artifact. This function has NO access to the executor, index writer, or
 * embedding pipeline — receiving never executes, never merges into the index, and needs no HITL.
 * The advisory hop chain is not a storage gate.
 */
export async function receiveForwardedShare(
  rawShare: unknown,
  deps: ReceiveShareDeps,
): Promise<ReceiveOutcome> {
  if (rawShare === null || typeof rawShare !== "object") {
    return { ok: false, reason: "malformed" };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(rawShare));
  const verdict = verifyShareBytes(bytes, { now: deps.now() });
  if (!verdict.signatureValid || !verdict.contentHashValid) {
    return { ok: false, reason: "content signature invalid" };
  }
  deps.storeReceived(rawShare as ShareFile);
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-forward.test.ts`
Expected: PASS (8 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/share-forward.ts packages/gateway/src/share/share-forward.test.ts
git commit -m "feat(share): receiveForwardedShare — inert inbound store (sig-verified, no execution)"
```

---

### Task 6: D21 static extension — confine `forwardShare`

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (the D21 block, ~lines 451–546)
- Test: `scripts/structure-audit/check-nimbus-invariants.test.ts` (the D21 describe block — add cases)

**Interfaces:**

- Modifies the two existing D21 confinement structures; adds one new rule.

> **Why an audited D21 extension is the faithful move, not a new invariant** (spec §13 + the crux): I27 says "no share leaves the machine except through the gate." `forwardShare` is a SECOND gate function (origin emit already routes through `createShare`). To keep the chokepoint property statically true, D21 must (a) permit `share-forward.ts` to NAME `share.publish` (it is the audit action type for the forward HITL), and (b) confine `forwardShare` CALLS to its home + the one wiring site (`ipc/federation-rpc.ts`), exactly mirroring the existing `createShare` confinement. No new invariant NUMBER, no new HITL action type, no new Vault key — `forwardShare` reuses `share.publish` (I2 frozen set unchanged) and `ensureShareKeypair` (privkey literal stays in `share-keypair.ts`).

- [ ] **Step 1: Add `share-forward.ts` to the `share.publish` allow-list**

In `scripts/structure-audit/check-nimbus-invariants.ts`, extend `D21_PUBLISH_ALLOWED`:

```ts
const D21_PUBLISH_ALLOWED = [
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/share/share-gate.ts",
  "packages/gateway/src/share/share-forward.ts", // I27 second emit chokepoint (re-forward HITL)
];
```

- [ ] **Step 2: Add the new `forwardShare` confinement rule**

Immediately after the `checkShareConsentBrokerConfinement` function (the `createShare` confinement), add a parallel rule:

```ts
// D21 (I27) extension: `forwardShare` — the re-forward chokepoint (owner-HITL + hop-append + emit) —
// may be CALLED only from its home (share-forward.ts) and the single wiring file federation-rpc.ts.
// Mirrors the createShare confinement so the SECOND outbound-share emit path cannot be invoked out of
// band, bypassing the owner's share.publish HITL gate (I27). Test files are exempt.
const D21_FORWARDSHARE_ALLOWED = [
  "packages/gateway/src/share/share-forward.ts",
  "packages/gateway/src/ipc/federation-rpc.ts",
];
const D21_FORWARDSHARE_RE = /\bforwardShare\b/;

export function checkForwardShareConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D21_FORWARDSHARE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D21_FORWARDSHARE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D21-forwardshare-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 3: Wire the new check into the audit aggregator**

Find where `checkShareConsentBrokerConfinement` / `checkSharePublishConfinement` results are collected (the top-level `runStructureAudit` / `collectViolations` aggregation) and add `...checkForwardShareConfinement(files)` alongside them.

Run: `grep -n "checkShareConsentBrokerConfinement\|checkSharePublishConfinement" scripts/structure-audit/check-nimbus-invariants.ts`
Add the new call in the same aggregation spot.

- [ ] **Step 4: Add the test cases**

In `scripts/structure-audit/check-nimbus-invariants.test.ts`, in the D21 describe block, add:

```ts
test("D21: forwardShare called outside share-forward.ts + federation-rpc.ts is a violation", () => {
  const v = checkForwardShareConfinement([
    { relPath: "packages/gateway/src/ipc/some-other.ts", contents: "await forwardShare(req, deps);" },
  ]);
  expect(v.map((x) => x.rule)).toContain("D21-forwardshare-callsite");
});

test("D21: forwardShare called from its home + wiring site is allowed", () => {
  const v = checkForwardShareConfinement([
    { relPath: "packages/gateway/src/share/share-forward.ts", contents: "export async function forwardShare() {}" },
    { relPath: "packages/gateway/src/ipc/federation-rpc.ts", contents: "await forwardShare(req, deps);" },
  ]);
  expect(v).toHaveLength(0);
});

test("D21: share.publish named in share-forward.ts is allowed (re-forward audit action)", () => {
  const v = checkSharePublishConfinement([
    { relPath: "packages/gateway/src/share/share-forward.ts", contents: 'actionType: "share.publish"' },
  ]);
  expect(v).toHaveLength(0);
});
```

(Use the same `FileEntry` literal shape the existing D21 tests use — confirm by reading a sibling test in the file.)

- [ ] **Step 5: Run the static audit + tests**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts && bun run scripts/structure-audit/check-nimbus-invariants.ts`
Expected: PASS; the static audit exits 0 against the current tree (Tasks 1–5 don't yet call `forwardShare` outside allowed sites).

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts
git commit -m "feat(share): D21 extension — confine forwardShare (I27 second emit chokepoint)"
```

---

### Task 7: `federation.shareForward` + `federation.shareReceive` RPC handlers

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (add 2 handlers + context deps)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (add `federation.shareForward` to `FORBIDDEN_OVER_LAN`)
- Test: `packages/gateway/src/ipc/federation-rpc.test.ts` (or the share-forward dispatch test sibling — match the existing federation-rpc test file)
- Test: `packages/gateway/src/ipc/lan-rpc.test.ts` (assert forward forbidden, receive answerable)

**Interfaces:**

- Consumes: `forwardShare`, `receiveForwardedShare`, `ForwardShareDeps`, `ReceiveShareDeps` (`../share/share-forward.ts`).
- Adds to `FederationRpcContext` (read the existing interface; add only these fields, all injected at the boot site in Task 12):
  - `readonly forwardShareDeps?: ForwardShareDeps;`
  - `readonly receiveShareDeps?: ReceiveShareDeps;`
  - `readonly resolvePeerPubkey?: (peerIdOrPubkey: string) => string | undefined;` // peerId → b64 pubkey (or pass-through a raw pubkey)
- Produces (in the `dispatchByMethod` map):
  - `"federation.shareForward"` — LOCAL (asker-side): `{ contentHash, recipient }` → resolve recipient to a pubkey → `forwardShare`. Returns `ForwardOutcome`.
  - `"federation.shareReceive"` — INBOUND (answerable): `{ share }` → `receiveForwardedShare`. Returns `{ ok }`. `peerId` is forced by the transport (spoof-proof) but is NOT trusted for content — the origin sig + hop chain are. Receiving is inert, no HITL.

> **`federation.shareForward` is the only NEW caller of `forwardShare`** (D21 allows it). `federation.shareReceive` is answerable over the wire — it is how shares arrive (Task lan-rpc add keeps `shareForward` local-only). Both fail-closed if their deps are unset (federation disabled).

- [ ] **Step 1: Write the failing dispatch test**

```ts
// add to the federation-rpc dispatch test file (match the existing one; e.g. federation-rpc.test.ts)
import { dispatchFederationRpc } from "./federation-rpc.ts";

test("federation.shareForward routes to forwardShare with resolved pubkey", async () => {
  let seen: { contentHash: string; recipientPubkey: string } | undefined;
  const ctx = makeFederationCtx({
    resolvePeerPubkey: (id) => (id === "peer:bob" ? "BOBPUB" : undefined),
    forwardShareDeps: stubForwardDeps((req) => { seen = req; return { status: "ok", delivered: true, contentHash: req.contentHash }; }),
  });
  const out = await dispatchFederationRpc("federation.shareForward", { contentHash: "h1", recipient: "peer:bob" }, ctx);
  expect(out.kind).toBe("hit");
  expect(seen).toEqual({ contentHash: "h1", recipientPubkey: "BOBPUB" });
});

test("federation.shareReceive stores inbound inert share", async () => {
  let received = false;
  const ctx = makeFederationCtx({
    receiveShareDeps: { now: () => 1, storeReceived: () => { received = true; } },
  });
  const out = await dispatchFederationRpc("federation.shareReceive", { share: validSignedShareObject() }, ctx);
  expect(out.kind).toBe("hit");
  expect(received).toBe(true);
});
```

> `makeFederationCtx`, `stubForwardDeps`, `validSignedShareObject` — add small local helpers in the test (build a real signed share via `buildShareFile` as in Task 4; `makeFederationCtx` spreads over the existing test's context factory — read the file for its shape first).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts`
Expected: FAIL — methods not handled.

- [ ] **Step 3: Add the handlers**

In the `dispatchByMethod<FederationRpcContext>` map in `federation-rpc.ts`, add:

```ts
"federation.shareForward": async (p, ctx) => {
  if (ctx.forwardShareDeps === undefined || ctx.resolvePeerPubkey === undefined) {
    throw new LanError(-32603, "ERR_SHARE_FORWARD_UNAVAILABLE: federation forwarding not configured");
  }
  const rec = asRecord(p);
  const contentHash = requireString(rec, "contentHash");
  const recipientPubkey = ctx.resolvePeerPubkey(requireString(rec, "recipient"));
  if (recipientPubkey === undefined) {
    throw new LanError(-32602, "ERR_UNKNOWN_RECIPIENT: no pubkey for recipient");
  }
  return forwardShare({ contentHash, recipientPubkey }, ctx.forwardShareDeps);
},

"federation.shareReceive": async (p, ctx) => {
  if (ctx.receiveShareDeps === undefined) {
    throw new LanError(-32603, "ERR_SHARE_RECEIVE_UNAVAILABLE: federation receive not configured");
  }
  const rec = asRecord(p);
  return receiveForwardedShare(rec["share"], ctx.receiveShareDeps);
},
```

Add the imports (`forwardShare`, `receiveForwardedShare`, types) and the three new optional `FederationRpcContext` fields. Use the file's existing `asRecord` / `requireString` / `LanError` helpers (confirm their names by reading the file).

- [ ] **Step 4: Forbid `federation.shareForward` over LAN**

In `packages/gateway/src/ipc/lan-rpc.ts`, add to `FORBIDDEN_OVER_LAN` (next to `federation.ask`):

```ts
"federation.shareForward", // local-only asker entrypoint (sends a share over the wire); not answerable
```

(Leave `federation.shareReceive` OUT of the set — it must be answerable.)

- [ ] **Step 5: Add the lan-rpc test**

```ts
// packages/gateway/src/ipc/lan-rpc.test.ts
test("federation.shareForward is forbidden over LAN; federation.shareReceive is answerable", () => {
  const peer = { peerId: "peer:x", writeAllowed: false };
  expect(() => checkLanMethodAllowed("federation.shareForward", peer)).toThrow(/not callable over LAN/);
  expect(() => checkLanMethodAllowed("federation.shareReceive", peer)).not.toThrow();
});
```

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts && bun run --cwd packages/gateway typecheck`
Expected: PASS, 0 type errors.

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/federation-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts
git commit -m "feat(share): federation.shareForward (local) + shareReceive (answerable) RPCs"
```

---

### Task 8: `share-rpc.ts` — wire origin `--to-peer` delivery + `share.inbox` list

**Files:**

- Modify: `packages/gateway/src/ipc/share-rpc.ts` (replace the peer-sink stub ~lines 181–192; add `share.inbox`; extend `ShareRpcCtx`)
- Test: `packages/gateway/src/ipc/share-rpc.test.ts` (match the existing file)

**Interfaces:**

- Consumes: `listReceivedShares` (`../share/share-inbox-store.ts`); the `deliver` wire primitive + peer lookup (injected via `ShareRpcCtx`, wired in Task 12).
- Adds to `ShareRpcCtx`:
  - `readonly deliverToPeer?: (share: ShareFile, peerId: string) => Promise<boolean>;` // origin emit; true if delivered, false if peer unknown/unreachable → leaves the persisted+signed share as a local artifact
- Adds method `"share.inbox"` → `{ inbox: listReceivedShares(ctx.db, { includeAll }) }`.
- Replaces the peer-sink stub: after `createShare` persists+signs the share with `sink.type === "peer"`, call `ctx.deliverToPeer?.(result.share, sink.peerId)`; return `{ status: "ok", contentHash, delivered }`.

> **Origin emit needs NO new HITL** — `createShare` already ran the `share.publish` gate before persisting. The peer-sink wiring only *delivers* the already-approved, already-signed share; it appends no hop (origin, `hops` stays 0). This stays inside the existing `share-rpc.ts` D21 site — no D21 change for the origin path.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/gateway/src/ipc/share-rpc.test.ts
test("share.inbox returns received inert shares", async () => {
  const ctx = makeShareCtx(); // existing factory; seed share_inbox with a received row via insertReceivedShare
  // ...insert a received row into ctx.db...
  const out = await dispatchShareRpc("share.inbox", {}, ctx);
  expect(out.kind).toBe("hit");
});

test("share.create --to-peer delivers via deliverToPeer after createShare persists", async () => {
  let deliveredPeer: string | undefined;
  const ctx = makeShareCtx({
    requestApproval: async () => true,
    deliverToPeer: async (_s, peerId) => { deliveredPeer = peerId; return true; },
  });
  const out = await dispatchShareRpc(
    "share.create",
    { sessionId: "s1", sink: { type: "peer", peerId: "peer:bob" } },
    ctx,
  );
  expect(out.kind).toBe("hit");
  expect(deliveredPeer).toBe("peer:bob");
});
```

(Read `share-rpc.test.ts` for the actual `makeShareCtx`/`dispatchShareRpc` helper names + how `share.create` is currently tested; mirror that. The `deliverToPeer` default in the ctx factory should be a no-op returning `false`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: FAIL — `share.inbox` not handled / `deliverToPeer` not called.

- [ ] **Step 3: Implement**

Replace the peer-sink stub (the `// peer sink: persisted + signed, but NOT forwarded over the wire yet` block):

```ts
} else if (sink.type === "http") {
  await emitHttp(ctx, json);
} else if (sink.type === "peer") {
  const delivered = (await ctx.deliverToPeer?.(result.share, sink.peerId)) ?? false;
  return { status: "ok", contentHash: result.share.contentHash, delivered } as const;
}
return { status: "ok", contentHash: result.share.contentHash } as const;
```

Add the `share.inbox` handler to the `HANDLERS` map:

```ts
"share.inbox": (params, ctx) => {
  const rec = asRecord(params) ?? {};
  const includeAll = rec["all"] === true;
  return { inbox: listReceivedShares(ctx.db, includeAll ? {} : { limit: 200 }) };
},
```

Add the `deliverToPeer?` field to `ShareRpcCtx` and the `listReceivedShares` import.

- [ ] **Step 4: Run + commit**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts && bun run --cwd packages/gateway typecheck`
Expected: PASS.

```bash
git add packages/gateway/src/ipc/share-rpc.ts packages/gateway/src/ipc/share-rpc.test.ts
git commit -m "feat(share): wire origin --to-peer delivery + share.inbox list (8d)"
```

---

### Task 9: Drain-on-first-pair hook

**Files:**

- Modify: `packages/gateway/src/federation/peer-pairing.ts` (add `onPairComplete?` constructor dep, fire it in both pair paths)
- Modify: `packages/gateway/src/federation/federation-runtime.ts` (thread `onPairComplete` through `buildFederationRuntime`)
- Test: `packages/gateway/src/federation/peer-pairing.test.ts`

**Interfaces:**

- `PeerPairing` constructor gains a third param `private readonly onPairComplete?: (peerId: string) => void | Promise<void>`.
- Both `initiatePair` and `approveInboundPair` call `await this.onPairComplete?.(peerId)` AFTER `addLanPeer`, BEFORE returning `peerId`.
- `buildFederationRuntime(cfg, index, identity, onPairComplete?)` passes the callback through.

> **The drain itself lives in `assemble.ts`** (Task 12): `onPairComplete(peerId)` → resolve the peer's pubkey + host/port → `drainPending(db, pubkey)` → for each, `deliver` + `markDelivered`. Here we only add the seam + prove it fires.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/federation/peer-pairing.test.ts
test("approveInboundPair fires onPairComplete with the new peerId", () => {
  const index = makeFakeIndex(); // existing test helper / a minimal addLanPeer stub
  const fired: string[] = [];
  const pairing = new PeerPairing(index, undefined, (peerId) => { fired.push(peerId); });
  const peerId = pairing.approveInboundPair({ peerPubkey: new Uint8Array(32).fill(7) });
  expect(fired).toEqual([peerId]);
});

test("initiatePair fires onPairComplete after a successful handshake", async () => {
  const index = makeFakeIndex();
  const fired: string[] = [];
  const handshake = async () => new Uint8Array(32).fill(5);
  const pairing = new PeerPairing(index, handshake, (peerId) => { fired.push(peerId); });
  const peerId = await pairing.initiatePair("h", 1, "code");
  expect(fired).toEqual([peerId]);
});
```

(Read the existing `peer-pairing.test.ts` for the index fake; if none exists, build a minimal object implementing `addLanPeer`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/federation/peer-pairing.test.ts`
Expected: FAIL — constructor takes only 2 args / callback not fired.

- [ ] **Step 3: Implement**

In `peer-pairing.ts`, extend the constructor and both pair methods:

```ts
constructor(
  private readonly index: LocalIndex,
  private readonly handshake?: OutboundPairHandshake,
  /** Fired once with the new peerId after a peer is first persisted — drives the share-inbox drain (8d). */
  private readonly onPairComplete?: (peerId: string) => void | Promise<void>,
) {}
```

In `initiatePair`, after `this.index.addLanPeer({...})` and before `return peerId;`:

```ts
await this.onPairComplete?.(peerId);
```

In `approveInboundPair`, after `addLanPeer` and before `return peerId;` (note: `approveInboundPair` is currently sync — keep it sync by NOT awaiting; fire-and-forget OR make it async). **Decision:** keep `approveInboundPair` returning `string` (callers depend on it); call `void this.onPairComplete?.(peerId);` (fire-and-forget — the drain is best-effort, and a pairing must not fail because a later drain delivery failed). For `initiatePair` (already async) `await` is fine but wrap so a drain failure does not reject the pair:

```ts
// approveInboundPair (stays sync):
void this.onPairComplete?.(peerId);
return peerId;
```

```ts
// initiatePair (async): a drain failure must not fail the pair
try { await this.onPairComplete?.(peerId); } catch { /* best-effort drain */ }
return peerId;
```

In `federation-runtime.ts`, add the param + pass it:

```ts
export function buildFederationRuntime(
  cfg: NimbusFederationToml,
  index: LocalIndex,
  identity: BoxKeypair,
  onPairComplete?: (peerId: string) => void | Promise<void>,
): FederationRuntime | undefined {
  // ...
  pairing: new PeerPairing(index, handshake, onPairComplete),
  // ...
}
```

- [ ] **Step 4: Run + typecheck + commit**

Run: `bun test packages/gateway/src/federation/peer-pairing.test.ts && bun run --cwd packages/gateway typecheck`
Expected: PASS.

```bash
git add packages/gateway/src/federation/peer-pairing.ts packages/gateway/src/federation/federation-runtime.ts packages/gateway/src/federation/peer-pairing.test.ts
git commit -m "feat(share): drain-on-first-pair seam (PeerPairing.onPairComplete)"
```

---

### Task 10: Attribution chip formatter + CLI (`share forward`, `share inbox`)

**Files:**

- Create: `packages/gateway/src/share/attribution.ts` (pure formatter)
- Test: `packages/gateway/src/share/attribution.test.ts`
- Modify: `packages/cli/src/commands/share.ts` (add `forward` + `inbox` subcommands; render the chip)

**Interfaces:**

- Produces: `function formatAttributionChip(p: { originLabel: string; hops: number }): string` — `hops === 0` → `"from <origin> (direct)"`; `hops === 1` → `"forwarded from <origin>, 1 hop away"`; `hops > 1` → `"forwarded from <origin>, N hops away"`.

> **CLI is IPC glue → coverage-excluded** like the 8a/8c precedent (`cli/commands/share.ts` is in `exclusions.ts`). The PURE formatter (`attribution.ts`) is unit-tested and ≥80%. The CLI parses args, calls `federation.shareForward` / `share.inbox`, and renders `formatAttributionChip` per inbox row.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/attribution.test.ts
import { describe, expect, test } from "bun:test";
import { formatAttributionChip } from "./attribution.ts";

describe("formatAttributionChip", () => {
  test("0 hops → direct", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 0 })).toBe("from alice (direct)");
  });
  test("1 hop → singular", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 1 })).toBe("forwarded from alice, 1 hop away");
  });
  test("N hops → plural", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 3 })).toBe("forwarded from alice, 3 hops away");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/share/attribution.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the formatter**

```ts
// packages/gateway/src/share/attribution.ts

/** Render the provenance attribution chip for a received/forwarded share (spec §9.3). Pure. */
export function formatAttributionChip(p: { originLabel: string; hops: number }): string {
  if (p.hops <= 0) return `from ${p.originLabel} (direct)`;
  const unit = p.hops === 1 ? "hop" : "hops";
  return `forwarded from ${p.originLabel}, ${p.hops} ${unit} away`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/share/attribution.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the CLI subcommands**

In `packages/cli/src/commands/share.ts`, add two subcommands (mirror the existing `share list` / `share create` `withIpc` pattern — read the file first):

- `nimbus share forward <contentHash> --to-peer <peerId>` → `withIpc(c => c.request("federation.shareForward", { contentHash, recipient: peerId }))` → print `delivered`/`queued`.
- `nimbus share inbox [--all]` → `withIpc(c => c.request("share.inbox", { all }))` → for each `inbox` row print `formatAttributionChip({ originLabel: row.originLabel, hops: row.hops })` + `contentHash` + `kind`.

Import `formatAttributionChip` from `@nimbus-dev/gateway`'s share module per the existing cross-package import convention used by `share.ts` (confirm how `share.ts` imports gateway pure helpers; if it can't, inline the same 3-line formatter in the CLI — but prefer the shared import).

- [ ] **Step 6: Update the CLI reference doc**

Add `nimbus share forward` + `nimbus share inbox` to `docs/cli-reference.md` (the Share & Virality section). Keep `audit:readme-cli` / `audit:doc-refs` green.

- [ ] **Step 7: Run + commit**

Run: `bun test packages/gateway/src/share/attribution.test.ts && bun run --cwd packages/cli typecheck`
Expected: PASS.

```bash
git add packages/gateway/src/share/attribution.ts packages/gateway/src/share/attribution.test.ts packages/cli/src/commands/share.ts docs/cli-reference.md
git commit -m "feat(share): attribution chip + nimbus share forward/inbox CLI"
```

---

### Task 11: `verify-share` — additional hop-chain validation

**Files:**

- Modify: `packages/gateway/src/share/verify-share.ts` (`VerifyShareReport` gains advisory forwarding fields)
- Test: `packages/gateway/src/share/verify-share.test.ts`

**Interfaces:**

- `VerifyShareReport` gains: `readonly forwarding?: { readonly hops: number; readonly chainValid: boolean; readonly hopsValid: number }`.
- `verifyShareFromBytes` additionally runs `verifyForwardingChain(parsedShareFile)` and surfaces the advisory result. Content verification (signature/hash/expiry) is UNCHANGED — a bad hop never flips `signatureValid`/`ok` (the chain is advisory attribution, spec §9.2).

> **Content stays authoritative; the chain is advisory** (spec §9.2): a share whose origin sig is valid but whose hop chain is tampered returns `signatureValid: true, ok: true` + `forwarding.chainValid: false`. A reviewer trusts content via `signatureValid`; the chain only colours the attribution chip.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/gateway/src/share/verify-share.test.ts
test("verify surfaces an advisory forwarding result without affecting content validity", () => {
  // build a share, append a real hop → chainValid true, content valid
  const signed = /* buildShareFile(...) as in other tests */;
  const fwd = appendForwardingHop(signed, { gatewayLabel: "bob", ...bobKp });
  const bytes = new TextEncoder().encode(JSON.stringify(fwd));
  const r = verifyShareFromBytes(bytes);
  expect(r.signatureValid).toBe(true);
  expect(r.forwarding?.hops).toBe(1);
  expect(r.forwarding?.chainValid).toBe(true);
});

test("a tampered hop → chainValid false but content still verifies", () => {
  const signed = /* buildShareFile(...) */;
  const fwd = appendForwardingHop(signed, { gatewayLabel: "bob", ...bobKp });
  const tampered = { ...fwd, forwarding: { hops: 1, chain: [{ ...fwd.forwarding.chain[0], gatewayLabel: "mallory" }] } };
  const r = verifyShareFromBytes(new TextEncoder().encode(JSON.stringify(tampered)));
  expect(r.signatureValid).toBe(true); // content untouched
  expect(r.forwarding?.chainValid).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: FAIL — `forwarding` not on the report.

- [ ] **Step 3: Implement**

In `verify-share.ts`, where `verifyShareFromBytes` parses the `ShareFile` and builds `VerifyShareReport`, add (after the existing content verify, reusing the already-parsed share object):

```ts
import { verifyForwardingChain } from "./share-forwarding.ts";
// ...
// (after parsing `parsed: ShareFile` and computing the base report)
const chain = verifyForwardingChain(parsed);
return {
  ...baseReport,
  forwarding: { hops: parsed.forwarding.hops, chainValid: chain.valid, hopsValid: chain.hopsValid },
};
```

(Confirm the local variable name the function uses for the parsed share + report; the YAML→JSON path already parses to a JS object — reuse it. If the function returns early on parse failure, leave `forwarding` undefined there.)

- [ ] **Step 4: Run + commit**

Run: `bun test packages/gateway/src/share/verify-share.test.ts && bun run --cwd packages/gateway typecheck`
Expected: PASS.

```bash
git add packages/gateway/src/share/verify-share.ts packages/gateway/src/share/verify-share.test.ts
git commit -m "feat(share): verify-share surfaces advisory forwarding-chain result"
```

---

### Task 12: `assemble.ts` wiring + Tauri allowlist

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts` (wire the federation forward/receive deps, the share-rpc `deliverToPeer`, and the drain-on-pair callback)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (add `share.inbox` to `ALLOWED_METHODS`, read-only)
- Test: exercised by Task 13's e2e; `gateway_bridge.rs` has an exact-count Rust test to update; mirror the JS allowlist count if one exists.

**Interfaces:** integration wiring only — no new unit test (assemble is integration-wired; the e2e covers it).

> **The delivery primitive** lives here as a closure over `sendFederatedOverWire` + the federation `identity` (BoxKeypair) + `index.listLanPeers`/`getLanPeerByPubkey`. It is the single production `deliver`/`deliverToPeer`/drain-delivery implementation, injected into both `forwardShareDeps.deliver`, `shareRpcCtx.deliverToPeer`, and the drain callback. Keeping it in `assemble.ts` (the boot site) means the wire-emit is not imported by the share domain modules (they stay unit-testable).

- [ ] **Step 1: Build the delivery + resolution closures**

In `assemble.ts`, near the federation runtime wiring (after `const identity = await loadOrCreateFederationIdentity(vault);` and `buildFederationRuntime(...)`), add:

```ts
// 8d: deliver a signed share to a peer over the authenticated, pubkey-pinned federation wire.
const deliverShareToPeer = async (share: ShareFile, peer: { host: string; port: number; pubkey: string }) => {
  await sendFederatedOverWire(
    peer.host,
    peer.port,
    identity,
    new Uint8Array(Buffer.from(peer.pubkey, "base64")),
    "federation.shareReceive",
    { share },
  );
};
// peerId/pubkey → reachable ForwardPeer (paired only)
const lookupForwardPeer = (recipientPubkey: string) => {
  const row = index.getLanPeerByPubkey(new Uint8Array(Buffer.from(recipientPubkey, "base64")));
  if (row?.host_ip == null || row.host_port == null) return undefined;
  return { host: row.host_ip, port: row.host_port, pubkey: recipientPubkey };
};
const resolvePeerPubkey = (peerIdOrPubkey: string) => {
  // a paired peerId resolves to its row's pubkey; otherwise treat the input as a raw b64 pubkey
  const row = index.listLanPeers().find((r) => peerIdFor(r.peer_pubkey) === peerIdOrPubkey);
  return row ? Buffer.from(row.peer_pubkey).toString("base64") : peerIdOrPubkey;
};
```

(Use the existing `peerIdFor` if exported, else inline the `peer:${hex(pubkey[0:8])}` form. Confirm `index`, `vault`, `sendFederatedOverWire`, `ShareFile` are in scope / import them.)

- [ ] **Step 2: Wire `forwardShareDeps` + `receiveShareDeps` into the federation RPC context**

```ts
// forwardShareDeps — the second I27 chokepoint's dependencies
forwardShareDeps: {
  now,
  label: shareLabel, // same label createShare uses (hostname)
  loadShare: (h) => { const r = getShareRecord(index.db, h); return r ? shareFileFromRecord(r) : undefined; },
  shareKeypair: () => ensureShareKeypair(vault),
  requestApproval: (preview, set) => shareConsent.request(preview, set), // SAME owner broker as createShare (D21)
  lookupPeer: lookupForwardPeer,
  deliver: deliverShareToPeer,
  queuePending: (recipientPubkey, share) => insertPendingForward(index.db, { recipientPubkey, share, now: now() }),
  recordAudit: recordShareAudit,
},
receiveShareDeps: { now, storeReceived: (share) => insertReceivedShare(index.db, { share, now: now() }) },
resolvePeerPubkey,
```

`shareFileFromRecord(r)` reconstructs a `ShareFile` from a `share_records` row: `{ format: "nimbus-share/v1", contentHash: r.content_hash, body: JSON.parse(r.body_json), sig: JSON.parse(r.sig_json), forwarding: JSON.parse(r.provenance_json) }`. Add this tiny helper next to the wiring (or in `share-store.ts` if cleaner — but keep it out of the D21-confined emit path).

- [ ] **Step 3: Wire `deliverToPeer` into the share-rpc context**

In the `ipcOpts.shareRpcCtx = { … }` literal, add:

```ts
deliverToPeer: async (share, peerId) => {
  const pub = resolvePeerPubkey(peerId);
  const peer = lookupForwardPeer(pub);
  if (peer === undefined) return false;
  await deliverShareToPeer(share, peer);
  return true;
},
```

- [ ] **Step 4: Wire the drain-on-pair callback into the federation runtime**

Where `buildFederationRuntime(cfg, index, identity)` is called, pass the drain callback:

```ts
const drainOnPair = async (peerId: string) => {
  const pub = resolvePeerPubkey(peerId);
  const peer = lookupForwardPeer(pub);
  if (peer === undefined) return;
  for (const row of drainPending(index.db, pub)) {
    try {
      await deliverShareToPeer(row.share, peer);
      markDelivered(index.db, row.id);
    } catch { /* best-effort; retried on next pair/online */ }
  }
};
const federation = buildFederationRuntime(cfg.federation, index, identity, drainOnPair);
```

- [ ] **Step 5: Tauri allowlist — expose `share.inbox` read-only**

In `packages/ui/src-tauri/src/gateway_bridge.rs`, add `"share.inbox"` to `ALLOWED_METHODS` (alphabetized, next to the other `share.*` read methods `share.get`/`share.list`/`share.pubkey`/`share.verify`). Do NOT add `federation.shareForward` (emit/RCE-class → CLI-only). Update the exact-size count test. If a JS mirror of the count exists (`nimbus-tauri-allowlist` skill notes one), bump it too.

- [ ] **Step 6: Typecheck the gateway + commit**

Run: `bun run --cwd packages/gateway typecheck`
Expected: 0 errors. (Every `FederationRpcContext` / `ShareRpcCtx` literal must now supply the new fields — the only production site is `assemble.ts`; test ctx factories provide defaults.)

```bash
git add packages/gateway/src/platform/assemble.ts packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(share): assemble wiring (forward/receive/drain) + share.inbox Tauri allowlist"
```

---

### Task 13: E2E — forward a share between two real gateways + drain-on-pair

**Files:**

- Create: `packages/gateway/test/e2e/share-forward-e2e.test.ts`

**Interfaces:** real-gateway raw-IPC round-trip (model on `share-e2e.test.ts` + `tribal-e2e.test.ts` — two gateway subprocesses, paired, mock-peer wire).

> **The end-to-end proof** (spec §11): gateway A creates+approves a share and forwards it to paired gateway B; B's `share.inbox` shows it with the attribution chip; verify the content sig holds and the hop chain has 1 valid hop. Then exercise the deferred path: forward to an unpaired pubkey → it queues → pair → it drains and appears in B's inbox.

- [ ] **Step 1: Write the e2e**

Build two real gateway subprocesses (reuse the `share-e2e.test.ts` spawn harness + `NIMBUS_E2E_SEED_SESSION_JSON` seed so A has a session to share). Pair A↔B (reuse the federation e2e pairing helper, or the `tribal-e2e`/`federation` pairing seam). Steps asserted:

1. On A: `share.create` `{ sessionId, sink: { type: "peer", peerId: <B> } }` with approval auto-accepted → `{ status: "ok", delivered: true }`.
2. On B: poll `share.inbox` until the row appears; assert `originLabel` = A's label, `hops` = 0 (direct origin emit) OR forward via `federation.shareForward` from a third identity to get `hops: 1`. Assert `verifyShareFromBytes(JSON.stringify(row.share))` → `signatureValid: true`, `forwarding.chainValid: true`.
3. Deferred path: on A, `federation.shareForward` to a pubkey B has not yet paired with → assert it queues (B inbox empty). Complete the pair → assert B's inbox drains the share.

(Keep timeouts generous; use the `waitForNotify`/deadline-poll helper pattern from prior e2e tests, never fixed sleeps — see the memory `bun-test-unref-timer-hang` + `waitForNotify` lessons.)

- [ ] **Step 2: Run the e2e**

Run: `bun test packages/gateway/test/e2e/share-forward-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/share-forward-e2e.test.ts
git commit -m "test(share): e2e — forward a share between two gateways + drain-on-pair"
```

---

### Task 14: Docs — CHANGELOG, spec status, architecture, invariants, CLAUDE/GEMINI

**Files:**

- Modify: `docs/CHANGELOG.md` (dated 2026-06-17 entry — canonical connector/feature log)
- Modify: `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md` (mark 8d delivered in §13)
- Modify: `docs/architecture.md` (V43 `share_inbox`; the forwarding envelope + attribution; `federation.shareForward`/`shareReceive`/`share.inbox` methods)
- Modify: `docs/SECURITY-INVARIANTS.md` (under I27: note the D21 static extension covers the second emit path `forwardShare` — NO new invariant number)
- Modify: `CLAUDE.md` + `GEMINI.md` (schema bump to V43; Slice 8 complete; NO new invariant — keep I1–I27 range)

> **No new invariant** — do NOT add an I28 row anywhere. I27's prose + the D21 static-complement line get a clause noting forwarding (`forwardShare`) is the second confined emit path. Schema line moves to V43. The Phase-6/Slice-8 status line flips to "Slice 8 complete". Connector-style deliveries go in `docs/CHANGELOG.md` (not the CLAUDE.md status line — merge-conflict convention).

- [ ] **Step 1: CHANGELOG entry** — under a `2026-06-17` heading, describe Slice 8d: forwarding over the federation wire, immutable provenance hop-chain + attribution chip, V43 `share_inbox` deferred-reveal, `federation.shareForward`/`shareReceive` + `share.inbox`, D21 extended (no new invariant).

- [ ] **Step 2: Spec §13** — mark the 8d row delivered (e.g. ✅ + PR ref placeholder).

- [ ] **Step 3: architecture.md** — add V43 to the schema table; document the forwarding envelope/provenance + the 3 new methods in the IPC catalogue.

- [ ] **Step 4: SECURITY-INVARIANTS.md** — extend the I27 entry: forwarding reuses I27; D21 now confines BOTH `createShare` and `forwardShare`; the hop key is the gateway's Ed25519 share key (no new Vault key); receiving is inert (tested property).

- [ ] **Step 5: CLAUDE.md + GEMINI.md** — schema `V42` → `V43`; Phase 6 status "Slice 8 ✅ complete"; keep the invariant range I1–I27 (verify no I28 crept in).

- [ ] **Step 6: Validate docs**

Run: `bun run audit:doc-refs && bun run audit:readme-cli`
Expected: PASS.

```bash
git add docs/CHANGELOG.md docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md docs/architecture.md docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md docs/cli-reference.md
git commit -m "docs(share): Slice 8d — forwarding, V43 share_inbox, D21 extension (no new invariant)"
```

---

### Task 15: Coverage floor + full preflight + ship

**Files:** no new source — verification + baseline only.

- [ ] **Step 1: Static gates** (run from the worktree root):

```bash
bun run --cwd packages/gateway typecheck && bun run --cwd packages/cli typecheck
bunx biome check packages scripts        # NOT `bun run lint` — false-fails in worktrees
bun run scripts/structure-audit/check-nimbus-invariants.ts   # D21 incl. forwardShare
bun test packages/gateway/src/security-invariants.test.ts    # I27 still 1 assertion (no new invariant)
bun run audit:doc-refs && bun run audit:cross-platform && bun run js-licenses
```

- [ ] **Step 2: Full test suites** — unit + the WHOLE integration suite + e2e (the 8b lesson — never push on unit-only):

```bash
bun test packages/gateway/src/share/ packages/gateway/src/ipc/ packages/gateway/src/federation/ packages/gateway/src/index/
bun test packages/gateway/test/integration/
bun test packages/gateway/test/e2e/share-forward-e2e.test.ts packages/gateway/test/e2e/share-e2e.test.ts
```

- [ ] **Step 3: Coverage floor (Docker-Linux-authoritative)** — start Docker, then:

```bash
bash scripts/coverage-floor/reseed-docker.sh    # build the lcov in oven/bun:latest
bun run audit:coverage-floor                     # CHECK ONLY — new files must clear ≥80% (baseline files:{})
```

If any new file is <80%, add targeted tests (pure cores: share-forwarding/share-inbox-store/share-forward/attribution should already clear; verify-share/federation-rpc/share-rpc additions may need a branch test) — do NOT `--update-baseline` to mask a real gap. CLI `share.ts` stays excluded (8a precedent); confirm `assemble.ts` is already excluded.

- [ ] **Step 4: CI duplication gate** — verify with the EXACT CI command (not `audit:duplication`):

```bash
bunx jscpd packages --min-lines 10 --threshold 5
```

Expected: under 5%. (share-forward / share-forwarding share little with createShare; if a clone trips, extract the shared shape.)

- [ ] **Step 5: lychee on ALL changed .md** (incl. any review/companion file — the 8c lesson; never commit `file:///<abs>` links):

```bash
~/.cargo/bin/lychee docs/CHANGELOG.md docs/architecture.md docs/SECURITY-INVARIANTS.md docs/cli-reference.md docs/superpowers/plans/2026-06-17-slice8d-referral.md docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md
```

- [ ] **Step 6: Merge origin/main + clean diffstat, then push + open PR**

```bash
git fetch origin && git merge origin/main   # expect drift; resolve disjoint
git diff --stat origin/main..HEAD            # confirm only intended files
git push -u origin worktree-phase6-slice8d-referral
gh pr create --title "feat(share): Phase 6 Slice 8d — sovereign-mesh referral (forwarding, provenance, V43 inbox)" --body "<summary + spec §9 + I27/D21-extension note + schema V43>"
```

- [ ] **Step 7: Post-CI** — address CodeRabbit/Sonar (fix or reasoned-decline), then RESOLVE each review thread via the GraphQL `resolveReviewThread` mutation (an unresolved conversation blocks merge). Watch coverage-floor + CI-jscpd + Sonar on the new files.

---

## Self-Review (completed during authoring)

- **Spec §9.1 Forwarding** → Tasks 4 (forwardShare), 7 (RPCs), 8 (origin --to-peer), 12 (wire). **§9.2 Provenance** → Tasks 1 (hop crypto), 11 (verify). **§9.3 Attribution chip** → Task 10. **§9.4 Deferred-reveal** → Tasks 2 (V43), 3 (store), 5 (inert receive), 9 (drain seam), 12 (drain wire), 13 (e2e). **§10 V43** → Task 2. **§11 tests** → Tasks 1/4/5/9/11/13. **§13 no new invariant** → Task 6 (D21 extension only) + Task 14 (docs).
- **Type consistency** — `ShareFile.forwarding`, `ShareForwardingHop`, `ForwardShareDeps`, `ForwardOutcome`, `ReceiveShareDeps`, `ShareInboxRow`, `ForwardPeer` are defined once and reused verbatim across tasks. `forwardShare` (Task 4) is the exact name confined in Task 6 and called in Task 7.
- **No new HITL action type / Vault key / invariant number** — `share.publish` reused (I2 frozen set + I27 test unchanged); hop signs with `ensureShareKeypair` (privkey literal stays in `share-keypair.ts`); D21 grows by one audited rule.
- **Migration is additive** — V43 is a NEW table; no existing SELECT/INSERT shape changes, so no hand-built-schema test needs patching (only schema-version assertions, Task 2 Step 6).
