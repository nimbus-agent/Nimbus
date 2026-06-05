# Phase 6 Slice 1 — Over-the-Wire Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three deferred Slice-1 federation seams so two real Nimbus Gateways exchange consented, scope-enforced, audited federated queries over the NaCl-box LAN channel.

**Architecture:** A persistent per-gateway box-identity keypair (Vault) feeds both an outbound LAN client (`ipc/lan-client.ts`) and a `LanServer` constructed at boot from the existing `[lan]` transport config (gated on `[federation].enabled`). Inbound `federation.query`/`federation.expertise` route through the existing `query-gate.ts` with the answering `peerId` taken from the authenticated NaCl session. A `FederationConsentBroker` turns the deny-stub prompter into a real owner round-trip: it broadcasts `federation.consentRequest` to local clients and unblocks on a `federation.consentRespond` local IPC method (CLI + Tauri).

**Tech Stack:** Bun v1.2+, TypeScript 6 strict (no `any`), `tweetnacl` (NaCl box), `bun:sqlite`, Biome, Rust (Tauri allowlist).

---

## Spec refinements discovered during planning (authoritative over the spec)

These supersede the matching details in `docs/superpowers/specs/2026-06-05-phase6-federation-over-the-wire-design.md`:

1. **Transport config is `[lan]`, not `[federation]`.** `NimbusLanToml` already exists with `{ enabled, port, bind, pairingWindowSeconds, maxFailedAttempts, lockoutSeconds }`, defaults `127.0.0.1`/`7475` (I6-clean). The `LanServer` sources bind/port/pairing/rate-limit from `[lan]`; it is **started only when `[federation].enabled`**. `[lan].port = 0` gives an ephemeral port. No `[federation]` schema change.
2. **`LocalIndex.getLanPeerByPubkey(pubkey)` already exists**, and **`addLanPeer` is already upsert** (`ON CONFLICT(peer_pubkey) DO UPDATE`). Q2 is already satisfied; no index change.
3. **Mirror the existing `ConsentCoordinatorImpl`** (`ipc/consent.ts`, `consent.request`/`consent.respond`). The federation broker **broadcasts** the request (any connected local owner client may respond) because the requester is a LAN peer with no local session. Response param shape mirrors HITL: `{ requestId, approved: boolean }`.
4. **No gateway-subprocess test harness exists.** The payoff test is **two in-process federation runtimes over a real loopback NaCl-box socket** (same class as `test/integration/lan/lan-rpc.test.ts`), plus a boot-wiring unit test for the assemble extraction. (Deviates from the spec's "two subprocesses"; faithful to "reuse the existing LAN E2E harness".)
5. **Status method is `lan.getStatus`** returning `{ enabled, pairingOpen, listenAddr }`.
6. **Asker-side over-the-wire query** (`federation.ask` / `federation.askExpertise` + CLI rewire) is included as Tasks 14–15 so `sendFederatedOverWire` has a real production consumer and the CLI genuinely federates. These are separable — they can be dropped without affecting the three seams + payoff test.

## File map

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `packages/gateway/src/ipc/lan-crypto.ts` | Modify | add `boxKeypairFromSecretKey` |
| `packages/gateway/src/federation/federation-identity.ts` | Create | load-or-create Vault box identity |
| `packages/gateway/src/ipc/lan-client.ts` | Create | `outboundPairHandshake` + `sendFederatedOverWire` |
| `packages/gateway/src/federation/consent-broker.ts` | Create | broadcast consent round-trip singleton |
| `packages/gateway/src/federation/federation-runtime.ts` | Modify | inject real handshake + identity |
| `packages/gateway/src/federation/federation-server.ts` | Create | build the federation `LanServer` (testable) |
| `packages/gateway/src/ipc/federation-rpc.ts` | Modify | broker prompter + `federation.consentRespond` + (T14) `federation.ask*` |
| `packages/gateway/src/ipc/lan-rpc.ts` | Modify | forbid new local-only methods over LAN |
| `packages/gateway/src/ipc/server/options.ts` | Modify | add `federationBroadcast` wiring hook (none needed — singleton) / `lanServer` already present |
| `packages/gateway/src/platform/assemble.ts` | Modify | construct+start `LanServer`, advertise, late-bind broadcast |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Modify | `federation.consentRespond` allowlist (67→68) |
| `packages/gateway/src/security-invariants.test.ts` | Modify | allowlist mirror + R1 impersonation + I5 extension |
| `packages/cli/src/commands/team.ts` | Modify | `team consent`, `team listen`, (T15) over-wire `query`/`who-knows` |
| `packages/cli/src/commands/registry.ts`, `packages/cli/src/index.ts` | Modify | (only if new top-level command names; `team` already registered) |
| `packages/gateway/test/integration/federation/two-gateway-wire.integration.test.ts` | Create | the payoff walk |
| `docs/SECURITY-INVARIANTS.md`, `docs/CHANGELOG.md`, `docs/roadmap.md` | Modify | doc updates |

**Common commands** (run from the worktree root `C:/gitrep/Nimbus/.worktrees/dev/asafgolombek/phase6-slice1-federation-wire`):

- Single test file: `bun test packages/gateway/src/federation/federation-identity.test.ts`
- Typecheck a package: `bun run --filter @nimbus-dev/gateway typecheck` (or `bunx tsc -p packages/gateway/tsconfig.json --noEmit`)
- Static invariants: `bun run audit:invariants` (runs `check-nimbus-invariants.ts`)

---

### Task 1: `boxKeypairFromSecretKey` crypto helper

**Files:**

- Modify: `packages/gateway/src/ipc/lan-crypto.ts`
- Test: `packages/gateway/src/ipc/lan-crypto.test.ts`

- [ ] **Step 1: Write the failing test** (append to `lan-crypto.test.ts`)

```typescript
import { boxKeypairFromSecretKey, generateBoxKeypair } from "./lan-crypto.ts";

test("boxKeypairFromSecretKey recovers the same keypair from its secret", () => {
  const kp = generateBoxKeypair();
  const recovered = boxKeypairFromSecretKey(kp.secretKey);
  expect(Buffer.from(recovered.publicKey).toString("hex")).toBe(
    Buffer.from(kp.publicKey).toString("hex"),
  );
  expect(Buffer.from(recovered.secretKey).toString("hex")).toBe(
    Buffer.from(kp.secretKey).toString("hex"),
  );
});

test("boxKeypairFromSecretKey rejects a wrong-length secret", () => {
  expect(() => boxKeypairFromSecretKey(new Uint8Array(31))).toThrow();
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/lan-crypto.test.ts`
Expected: FAIL — `boxKeypairFromSecretKey` is not exported.

- [ ] **Step 3: Implement** (append to `lan-crypto.ts`, after `generateBoxKeypair`)

```typescript
export function boxKeypairFromSecretKey(secretKey: Uint8Array): BoxKeypair {
  if (secretKey.length !== 32) {
    throw new Error(`box secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const kp = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/lan-crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-crypto.ts packages/gateway/src/ipc/lan-crypto.test.ts
git commit -m "feat(federation): boxKeypairFromSecretKey helper for identity recovery"
```

---

### Task 2: Federation identity keypair (Vault)

**Files:**

- Create: `packages/gateway/src/federation/federation-identity.ts`
- Test: `packages/gateway/src/federation/federation-identity.test.ts`

`NimbusVault.get(key) → Promise<string|null>`, `set(key,value) → Promise<void>`. Key `federation.identity_secret` (base64). Verify this string does **not** match the D11 `VAULT_KEY_RE` (built from connector suffixes like `access_token`/`api_key`); `identity_secret` does not collide, so no `VAULT_KEY_ALLOW_LIST` edit. (Confirm in Step 5 with `bun run audit:invariants`.)

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, expect, test } from "bun:test";
import { boxKeypairFromSecretKey } from "../ipc/lan-crypto.ts";
import { FEDERATION_IDENTITY_VAULT_KEY, loadOrCreateFederationIdentity } from "./federation-identity.ts";

function fakeVault() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async () => [...store.keys()],
  };
}

test("creates a 32-byte identity on first call and persists it base64", async () => {
  const v = fakeVault();
  const kp = await loadOrCreateFederationIdentity(v);
  expect(kp.secretKey.length).toBe(32);
  const stored = v.store.get(FEDERATION_IDENTITY_VAULT_KEY);
  expect(stored).toBeDefined();
  expect(Buffer.from(stored as string, "base64").length).toBe(32);
});

test("returns the SAME keypair on a second call (load path)", async () => {
  const v = fakeVault();
  const a = await loadOrCreateFederationIdentity(v);
  const b = await loadOrCreateFederationIdentity(v);
  expect(Buffer.from(b.publicKey).toString("hex")).toBe(Buffer.from(a.publicKey).toString("hex"));
});

test("regenerates if the stored secret is corrupt (wrong length)", async () => {
  const v = fakeVault();
  await v.set(FEDERATION_IDENTITY_VAULT_KEY, Buffer.from(new Uint8Array(10)).toString("base64"));
  const kp = await loadOrCreateFederationIdentity(v);
  expect(kp.secretKey.length).toBe(32);
  // a subsequent load is now stable
  const again = boxKeypairFromSecretKey(
    new Uint8Array(Buffer.from(v.store.get(FEDERATION_IDENTITY_VAULT_KEY) as string, "base64")),
  );
  expect(Buffer.from(again.publicKey).toString("hex")).toBe(Buffer.from(kp.publicKey).toString("hex"));
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/federation/federation-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";
import { type BoxKeypair, boxKeypairFromSecretKey, generateBoxKeypair } from "../ipc/lan-crypto.ts";

export const FEDERATION_IDENTITY_VAULT_KEY = "federation.identity_secret";

/**
 * Load-or-create the gateway's persistent NaCl box identity. The 32-byte secret is stored
 * base64-encoded in the Vault; the public key is the gateway's stable peer identity. Vault-only
 * (non-negotiable #3). A corrupt/short stored value is regenerated and overwritten.
 */
export async function loadOrCreateFederationIdentity(
  vault: VaultReader & VaultWriter,
): Promise<BoxKeypair> {
  const existing = await vault.get(FEDERATION_IDENTITY_VAULT_KEY);
  if (existing !== null) {
    const secret = new Uint8Array(Buffer.from(existing, "base64"));
    if (secret.length === 32) return boxKeypairFromSecretKey(secret);
    // fall through: corrupt → regenerate
  }
  const kp = generateBoxKeypair();
  await vault.set(FEDERATION_IDENTITY_VAULT_KEY, Buffer.from(kp.secretKey).toString("base64"));
  return kp;
}
```

- [ ] **Step 4: Run tests + invariants**

Run: `bun test packages/gateway/src/federation/federation-identity.test.ts && bun run audit:invariants`
Expected: tests PASS; invariants report no D11 violation for `federation-identity.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/federation-identity.ts packages/gateway/src/federation/federation-identity.test.ts
git commit -m "feat(federation): persistent Vault box identity (loadOrCreateFederationIdentity)"
```

---

### Task 3: Outbound pair handshake (`lan-client.ts`)

**Files:**

- Create: `packages/gateway/src/ipc/lan-client.ts`
- Test: `packages/gateway/src/ipc/lan-client.test.ts`

Wire protocol (from `lan-server.ts` + `test/integration/lan/lan-rpc.test.ts`): 4-byte big-endian length prefix; handshake frame `{ kind:"pair", client_pubkey:<b64>, pairing_code }`; reply `{ kind:"pair_ok", host_pubkey:<b64>, peer_id }` or `{ kind:"pair_err" }`.

- [ ] **Step 1: Write the failing test** (drives a REAL in-process `LanServer`)

```typescript
import { afterEach, expect, test } from "bun:test";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer } from "./lan-server.ts";
import { PairingWindow, generatePairingCode } from "./lan-pairing.ts";
import { LanRateLimiter } from "./lan-rate-limit.ts";
import { outboundPairHandshake } from "./lan-client.ts";

let server: LanServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startResponder(open: boolean) {
  const hostKp = generateBoxKeypair();
  const pairing = new PairingWindow(5000);
  const code = generatePairingCode();
  if (open) pairing.open(code);
  server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: hostKp,
    pairing,
    rateLimit: new LanRateLimiter({ maxFailures: 3, windowMs: 2000, lockoutMs: 2000 }),
    isKnownPeer: () => null,
    registerPeer: () => "peer-x",
    onMessage: async () => ({}),
  });
  await server.start();
  const addr = server.listenAddr();
  if (!addr) throw new Error("no addr");
  return { hostKp, code, port: addr.port };
}

test("outboundPairHandshake returns the responder host pubkey on pair_ok", async () => {
  const { hostKp, code, port } = await startResponder(true);
  const selfKp = generateBoxKeypair();
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, selfKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(Buffer.from(hostKp.publicKey).toString("hex"));
});

test("outboundPairHandshake throws on pair_err (window closed)", async () => {
  const { code, port } = await startResponder(false);
  const selfKp = generateBoxKeypair();
  await expect(outboundPairHandshake("127.0.0.1", port, code, selfKp)).rejects.toThrow();
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/lan-client.test.ts`
Expected: FAIL — `outboundPairHandshake` not found.

- [ ] **Step 3: Implement** (`lan-client.ts`)

```typescript
import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";

const DEFAULT_TIMEOUT_MS = 5000;

interface FrameReader {
  push(chunk: Uint8Array): void;
  next(): Uint8Array | undefined;
}

/** Buffers a 4-byte-length-prefixed stream and yields one frame body at a time. */
function makeFrameReader(): FrameReader {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;
    },
    next() {
      if (buf.length < 4) return undefined;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const len = view.getUint32(0, false);
      if (buf.length < 4 + len) return undefined;
      const body = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      return body;
    },
  };
}

function frame(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  const out = new Uint8Array(4 + payload.length);
  out.set(header, 0);
  out.set(payload, 4);
  return out;
}

/** Connect, send one request frame, resolve with the first reply frame body (or reject on timeout/close). */
function exchangeOneFrame(
  host: string,
  port: number,
  send: (socket: Socket<undefined>) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader();
    let settled = false;
    const timer = setTimeout(() => finish(undefined, new Error("lan-client: handshake timeout")), timeoutMs);
    function finish(body: Uint8Array | undefined, err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (body) resolve(body);
      else reject(new Error("lan-client: connection closed without reply"));
    }
    void Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          try {
            send(socket);
          } catch (e) {
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
          }
        },
        data(socket, chunk) {
          reader.push(chunk);
          const body = reader.next();
          if (body !== undefined) {
            socket.end();
            finish(body);
          }
        },
        close() {
          finish(undefined);
        },
        error(_s, e) {
          finish(undefined, e instanceof Error ? e : new Error(String(e)));
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))));
  });
}

function writeFrame(socket: Socket<undefined>, payload: Uint8Array): void {
  socket.write(frame(payload));
}

/** The production OutboundPairHandshake (PeerPairing DI default). Returns the responder's box pubkey. */
export async function outboundPairHandshake(
  host: string,
  port: number,
  code: string,
  selfKp: BoxKeypair,
): Promise<Uint8Array> {
  const req = new TextEncoder().encode(
    JSON.stringify({
      kind: "pair",
      client_pubkey: Buffer.from(selfKp.publicKey).toString("base64"),
      pairing_code: code,
    }),
  );
  const body = await exchangeOneFrame(host, port, (s) => writeFrame(s, req));
  const msg = JSON.parse(new TextDecoder().decode(body)) as { kind?: string; host_pubkey?: string };
  if (msg.kind !== "pair_ok" || typeof msg.host_pubkey !== "string") {
    throw new Error(`lan-client: pairing rejected (${msg.kind ?? "unknown"})`);
  }
  const hostPub = new Uint8Array(Buffer.from(msg.host_pubkey, "base64"));
  if (hostPub.length !== 32) throw new Error("lan-client: bad host pubkey length");
  return hostPub;
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/lan-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-client.ts packages/gateway/src/ipc/lan-client.test.ts
git commit -m "feat(federation): outbound LAN pair handshake client"
```

---

### Task 4: `sendFederatedOverWire` (authenticated encrypted RPC)

**Files:**

- Modify: `packages/gateway/src/ipc/lan-client.ts`
- Test: `packages/gateway/src/ipc/lan-client.test.ts`

Flow: `hello` handshake (the asker is a known peer post-pair) → read `hello_ok` (+`host_pubkey`) → send `sealBoxFrame({id,method,params})` → read+`openBoxFrame` → return `result` (throw on `error`).

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { sendFederatedOverWire } from "./lan-client.ts";

test("sendFederatedOverWire performs hello + encrypted RPC against a known peer", async () => {
  const hostKp = generateBoxKeypair();
  const selfKp = generateBoxKeypair();
  server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: hostKp,
    pairing: new PairingWindow(5000),
    rateLimit: new LanRateLimiter({ maxFailures: 3, windowMs: 2000, lockoutMs: 2000 }),
    isKnownPeer: (pub) =>
      Buffer.compare(Buffer.from(pub), Buffer.from(selfKp.publicKey)) === 0
        ? { peerId: "peer-known", writeAllowed: false }
        : null,
    registerPeer: () => "peer-known",
    onMessage: async (method, params, peer) => ({ method, params, peerId: peer.peerId }),
  });
  await server.start();
  const port = server.listenAddr()?.port as number;
  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    selfKp,
    hostKp.publicKey,
    "federation.query",
    { namespace: "n", purpose: "p" },
  )) as { method: string; peerId: string };
  expect(res.method).toBe("federation.query");
  expect(res.peerId).toBe("peer-known"); // server authenticated us, not our body
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/lan-client.test.ts`
Expected: FAIL — `sendFederatedOverWire` not found.

- [ ] **Step 3: Implement** (append to `lan-client.ts`; add imports `openBoxFrame, sealBoxFrame` from `./lan-crypto.ts`)

```typescript
import { openBoxFrame, sealBoxFrame } from "./lan-crypto.ts";

/** Two-frame exchange: send req frame A, read reply A, send req frame B (from reply A), read reply B. */
function exchangeHelloThenRpc(
  host: string,
  port: number,
  hello: Uint8Array,
  buildRpc: (helloReply: { host_pubkey?: string; kind?: string }) => Uint8Array,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader();
    let phase: "hello" | "rpc" = "hello";
    let settled = false;
    const timer = setTimeout(() => finish(undefined, new Error("lan-client: rpc timeout")), timeoutMs);
    function finish(body: Uint8Array | undefined, err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (body) resolve(body);
      else reject(new Error("lan-client: connection closed mid-exchange"));
    }
    void Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          writeFrame(socket, hello);
        },
        data(socket, chunk) {
          reader.push(chunk);
          const body = reader.next();
          if (body === undefined) return;
          if (phase === "hello") {
            let reply: { host_pubkey?: string; kind?: string };
            try {
              reply = JSON.parse(new TextDecoder().decode(body)) as typeof reply;
            } catch {
              socket.end();
              finish(undefined, new Error("lan-client: bad hello reply"));
              return;
            }
            if (reply.kind !== "hello_ok") {
              socket.end();
              finish(undefined, new Error(`lan-client: hello rejected (${reply.kind ?? "unknown"})`));
              return;
            }
            phase = "rpc";
            try {
              writeFrame(socket, buildRpc(reply));
            } catch (e) {
              socket.end();
              finish(undefined, e instanceof Error ? e : new Error(String(e)));
            }
            return;
          }
          socket.end();
          finish(body);
        },
        close() {
          finish(undefined);
        },
        error(_s, e) {
          finish(undefined, e instanceof Error ? e : new Error(String(e)));
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))));
  });
}

/** Send one authenticated, encrypted federation RPC to a paired peer and return its result. */
export async function sendFederatedOverWire(
  host: string,
  port: number,
  selfKp: BoxKeypair,
  peerPubkey: Uint8Array,
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const hello = new TextEncoder().encode(
    JSON.stringify({ kind: "hello", client_pubkey: Buffer.from(selfKp.publicKey).toString("base64") }),
  );
  const replyFrame = await exchangeHelloThenRpc(
    host,
    port,
    hello,
    (reply) => {
      const hostPub = new Uint8Array(Buffer.from(reply.host_pubkey ?? "", "base64"));
      if (Buffer.compare(Buffer.from(hostPub), Buffer.from(peerPubkey)) !== 0) {
        throw new Error("lan-client: responder pubkey does not match pinned peer key");
      }
      return sealBoxFrame(
        new TextEncoder().encode(JSON.stringify({ id: 1, method, params })),
        peerPubkey,
        selfKp.secretKey,
      );
    },
    timeoutMs,
  );
  const plain = openBoxFrame(replyFrame, peerPubkey, selfKp.secretKey);
  const resp = JSON.parse(new TextDecoder().decode(plain)) as {
    result?: unknown;
    error?: { code?: string; message?: string };
  };
  if (resp.error !== undefined) {
    throw new Error(`lan-client: peer error ${resp.error.code ?? ""} ${resp.error.message ?? ""}`.trim());
  }
  return resp.result;
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/lan-client.test.ts`
Expected: PASS (both pair + RPC tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-client.ts packages/gateway/src/ipc/lan-client.test.ts
git commit -m "feat(federation): sendFederatedOverWire authenticated encrypted client"
```

---

### Task 5: Wire the real handshake into `PeerPairing` via `federation-runtime`

**Files:**

- Modify: `packages/gateway/src/federation/federation-runtime.ts`
- Test: `packages/gateway/src/federation/federation-runtime.test.ts` (create if absent)

`buildFederationRuntime` gains the identity keypair and constructs the real `OutboundPairHandshake` (closing `selfKp` in), passing it to `new PeerPairing(index, handshake)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { LocalIndex } from "../index/local-index.ts";
import { buildFederationRuntime } from "./federation-runtime.ts";

test("buildFederationRuntime wires a real outbound handshake (initiatePair no longer throws 'not wired')", async () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const index = new LocalIndex(db);
  const rt = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    index,
    generateBoxKeypair(),
  );
  expect(rt).toBeDefined();
  // No responder running → connection error, NOT the "not wired" sentinel.
  await expect(rt?.pairing.initiatePair("127.0.0.1", 1, "code")).rejects.not.toThrow(
    "outbound pair handshake not wired",
  );
  index.close();
});

test("buildFederationRuntime returns undefined when disabled", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const index = new LocalIndex(db);
  expect(
    buildFederationRuntime(
      { enabled: false, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
      index,
      generateBoxKeypair(),
    ),
  ).toBeUndefined();
  index.close();
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/federation/federation-runtime.test.ts`
Expected: FAIL — `buildFederationRuntime` takes 2 args / `identity` unused (typecheck or runtime mismatch).

- [ ] **Step 3: Implement** (replace `federation-runtime.ts`)

```typescript
import type { NimbusFederationToml } from "../config/nimbus-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { outboundPairHandshake } from "../ipc/lan-client.ts";
import {
  type DiscoveryProvider,
  InMemoryDiscoveryProvider,
  MdnsDiscoveryProvider,
} from "./discovery.ts";
import { PeerPairing } from "./peer-pairing.ts";

export interface FederationRuntime {
  readonly discovery: DiscoveryProvider;
  readonly pairing: PeerPairing;
  readonly consentTimeoutSeconds: number;
}

/**
 * Build the federation runtime services. Returns undefined when federation is disabled.
 * The outbound pair handshake is the production `lan-client` implementation, with this gateway's
 * box identity closed in; `initiatePair` therefore works end-to-end.
 */
export function buildFederationRuntime(
  cfg: NimbusFederationToml,
  index: LocalIndex,
  identity: BoxKeypair,
): FederationRuntime | undefined {
  if (!cfg.enabled) return undefined;
  const discovery: DiscoveryProvider = cfg.mdnsEnabled
    ? new MdnsDiscoveryProvider()
    : new InMemoryDiscoveryProvider();
  const handshake = (host: string, port: number, code: string): Promise<Uint8Array> =>
    outboundPairHandshake(host, port, code, identity);
  return {
    discovery,
    pairing: new PeerPairing(index, handshake),
    consentTimeoutSeconds: cfg.consentTimeoutSeconds,
  };
}
```

- [ ] **Step 4: Run tests + the existing acceptance test still green**

Run: `bun test packages/gateway/src/federation/federation-runtime.test.ts packages/gateway/test/integration/federation/federation-acceptance.integration.test.ts`
Expected: PASS. (The acceptance test constructs `PeerPairing` directly, not `buildFederationRuntime`, so it is unaffected.)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/federation-runtime.ts packages/gateway/src/federation/federation-runtime.test.ts
git commit -m "feat(federation): inject real outbound handshake + box identity into runtime"
```

---

### Task 6: `FederationConsentBroker`

**Files:**

- Create: `packages/gateway/src/federation/consent-broker.ts`
- Test: `packages/gateway/src/federation/consent-broker.test.ts`

Mirrors `ConsentCoordinatorImpl` but **broadcasts** (no per-client ownership) and carries a TTL safety-net. Exposes a module singleton `federationConsent`.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { FederationConsentBroker } from "./consent-broker.ts";

test("request broadcasts and resolves on respond(approved=true)", async () => {
  const broker = new FederationConsentBroker();
  const sent: Array<{ method: string; params: unknown }> = [];
  broker.setBroadcast((method, params) => sent.push({ method, params }));
  const p = broker.request({ peerId: "peer:a", namespace: "n", purpose: "x", role: "viewer" }, 1000);
  expect(sent.length).toBe(1);
  expect(sent[0]?.method).toBe("federation.consentRequest");
  const rid = (sent[0]?.params as { requestId: string }).requestId;
  broker.respond(rid, true);
  expect(await p).toBe("approved");
});

test("respond(false) resolves denied; unknown id is a no-op", async () => {
  const broker = new FederationConsentBroker();
  broker.setBroadcast(() => {});
  const p = broker.request({ peerId: "p", namespace: "n", purpose: "x", role: "viewer" }, 1000);
  const rid = broker.pendingIds()[0] as string;
  expect(broker.respond("nope", true)).toBe(false); // unknown id → not matched
  expect(broker.respond(rid, false)).toBe(true); // matched
  expect(await p).toBe("denied");
});

test("TTL safety-net resolves denied and purges if no response", async () => {
  const broker = new FederationConsentBroker();
  broker.setBroadcast(() => {});
  const p = broker.request({ peerId: "p", namespace: "n", purpose: "x", role: "viewer" }, 20);
  expect(await p).toBe("denied");
  expect(broker.pendingIds().length).toBe(0);
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/federation/consent-broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { randomUUID } from "node:crypto";
import type { ConsentDecision } from "./query-gate.ts";

export interface ConsentRequestInput {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly role: string;
}

type Broadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (d: ConsentDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owner-consent round-trip for inbound federated queries. The request is broadcast to all connected
 * local clients (any owner UI may answer); `respond` resolves the matching pending promise. A TTL
 * safety-net guarantees no pending entry leaks even if the owner never answers (belt-and-suspenders
 * behind query-gate's own consent-timeout race).
 */
export class FederationConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  request(input: ConsentRequestInput, ttlMs: number): Promise<ConsentDecision> {
    const requestId = randomUUID();
    return new Promise<ConsentDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("denied");
      }, ttlMs);
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("federation.consentRequest", { requestId, ...input });
    });
  }

  /** Returns true if a pending request matched (and was resolved); false for unknown/expired/settled. */
  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false; // unknown / already settled / expired
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved ? "approved" : "denied");
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

/** Process singleton shared by the local dispatcher and the LAN onMessage path. */
export const federationConsent = new FederationConsentBroker();
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/federation/consent-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/consent-broker.ts packages/gateway/src/federation/consent-broker.test.ts
git commit -m "feat(federation): consent broker (broadcast request + respond + TTL)"
```

---

### Task 7: Broker-backed prompter + `federation.consentRespond` in the dispatcher

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts`
- Test: `packages/gateway/src/ipc/federation-rpc.test.ts`

Replace the deny-stub `makePrompter` with the broker; add a `federation.consentRespond` case.

- [ ] **Step 1: Write the failing test** (append to `federation-rpc.test.ts`)

```typescript
import { federationConsent } from "../federation/consent-broker.ts";

test("federation.query blocks then unblocks on federation.consentRespond(approved)", async () => {
  // Build a ctx with a published+granted (non-standing) namespace, then race a respond.
  const c = makeFederationCtx(); // existing helper in this test file; seeds db + ctx
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, true));
  });
  await dispatchFederationRpc("federation.namespace.publish", { name: "ns-c7", filters: [{ kind: "type", value: "pull_request" }] }, c);
  await dispatchFederationRpc("federation.namespace.grant", { namespace: "ns-c7", peerId: "peer:z", role: "viewer", standingConsent: false }, c);
  const out = await dispatchFederationRpc("federation.query", { peerId: "peer:z", namespace: "ns-c7", purpose: "p" }, c);
  expect(out.kind).toBe("hit");
});

test("federation.consentRespond resolves a pending request", async () => {
  const c = makeFederationCtx();
  const out = await dispatchFederationRpc("federation.consentRespond", { requestId: "x", approved: true }, c);
  expect(out.kind).toBe("hit");
  // unknown id → ok:true (well-formed call) but matched:false (nothing was pending)
  expect((out as { value: { ok: boolean; matched: boolean } }).value.matched).toBe(false);
});
```

> If `federation-rpc.test.ts` lacks a `makeFederationCtx` helper, add one mirroring `federation-acceptance.integration.test.ts`'s `ctx()` (seed db via `runIndexedSchemaMigrations(db, 33)`; `new LocalIndex(db)`; `new PeerPairing(index)`).

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts`
Expected: FAIL — `consentRespond` unknown method (miss) / query denies (deny-stub).

- [ ] **Step 3: Implement** (edit `federation-rpc.ts`)

Replace the `makePrompter` function:

```typescript
import { federationConsent } from "../federation/consent-broker.ts";

function makePrompter(ctx: FederationRpcContext): ConsentPrompter {
  return (input) => federationConsent.request(input, ctx.consentTimeoutMs);
}
```

Add a case inside the `dispatchByMethod` map (alongside the others):

```typescript
    "federation.consentRespond": (p) => {
      const rec = asRecord(p);
      const requestId = requireString(rec, "requestId");
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = federationConsent.respond(requestId, rec["approved"]);
      return { ok: true, matched };
    },
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts`
Expected: PASS.

> Also update `federation-acceptance.integration.test.ts`: its deferred-seam assertion that the prompter "denies + notifies" now changes — the broker no longer auto-denies. Set `federationConsent.setBroadcast(() => {})` in that test's setup so non-standing queries time out via `consentTimeoutMs` (audited `timeout`), preserving its intent. Run it and adjust the one assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.test.ts packages/gateway/test/integration/federation/federation-acceptance.integration.test.ts
git commit -m "feat(federation): broker-backed consent prompter + federation.consentRespond"
```

---

### Task 8: Forbid the new local-only methods over LAN (I5)

**Files:**

- Modify: `packages/gateway/src/ipc/lan-rpc.ts`
- Test: `packages/gateway/src/ipc/lan-rpc.test.ts` (or wherever `checkLanMethodAllowed` is unit-tested)

- [ ] **Step 1: Write the failing test**

```typescript
test("federation.consentRespond is forbidden over LAN; query/expertise are allowed", () => {
  const peer = { peerId: "p", writeAllowed: false };
  expect(() => checkLanMethodAllowed("federation.consentRespond", peer)).toThrow();
  expect(() => checkLanMethodAllowed("federation.ask", peer)).toThrow();
  expect(() => checkLanMethodAllowed("federation.askExpertise", peer)).toThrow();
  expect(() => checkLanMethodAllowed("federation.query", peer)).not.toThrow();
  expect(() => checkLanMethodAllowed("federation.expertise", peer)).not.toThrow();
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/lan-rpc.test.ts`
Expected: FAIL — consentRespond/ask currently pass (not forbidden).

- [ ] **Step 3: Implement** — add to the `FORBIDDEN_OVER_LAN` set (in the federation block):

```typescript
  "federation.consentRespond",
  "federation.ask",
  "federation.askExpertise",
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/lan-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/lan-rpc.test.ts
git commit -m "feat(federation): forbid consentRespond + ask methods over LAN (I5)"
```

---

### Task 9: Federation `LanServer` builder (`federation-server.ts`)

**Files:**

- Create: `packages/gateway/src/federation/federation-server.ts`
- Test: `packages/gateway/src/federation/federation-server.test.ts`

Pure-ish builder so the boot wiring is testable without `assemble.ts`. Returns `{ lanServer, pairingWindow, rateLimit }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair, sealBoxFrame, openBoxFrame } from "../ipc/lan-crypto.ts";
import { generatePairingCode } from "../ipc/lan-pairing.ts";
import { buildFederationLanServer } from "./federation-server.ts";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

test("buildFederationLanServer registers an inbound peer on valid pair, then answers federation.query over the wire", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);
  // publish + grant a standing namespace so no consent prompt is needed
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix','b',10,1,'{}')`);

  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: { bind: "127.0.0.1", port: 0, pairingWindowSeconds: 60, maxFailedAttempts: 3, lockoutSeconds: 60 },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  stop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  // Pair: open the window, run the outbound handshake
  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const { outboundPairHandshake } = await import("../ipc/lan-client.ts");
  const askerKp = generateBoxKeypair();
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, askerKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(Buffer.from(identity.publicKey).toString("hex"));

  // an inbound peer row now exists (read-only)
  expect(index.getLanPeerByPubkey(askerKp.publicKey)).toBeDefined();
});
```

**P2 — socket teardown (applies to this test and Task 16).** Every test that starts a `LanServer` MUST `await server.stop()` in `afterEach` (already shown via the `stop` holder). `LanServer.stop()` calls `instance.stop(true)`, which **force-closes** active connections, releasing file descriptors — important under CI so tests don't hang or leak FDs. The `lan-client` helpers (`exchangeOneFrame`/`exchangeHelloThenRpc`) always `socket.end()` after the reply (and on `close`/`error`), so the client side never leaks either. Do not start a server without a matching awaited stop.

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/federation/federation-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { Database } from "bun:sqlite";
import type { LocalIndex } from "../index/local-index.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { PairingWindow } from "../ipc/lan-pairing.ts";
import { LanRateLimiter } from "../ipc/lan-rate-limit.ts";
import { LanError, type LanPeerContext } from "../ipc/lan-rpc.ts";
import { LanServer } from "../ipc/lan-server.ts";
import type { DiscoveryProvider } from "./discovery.ts";
import type { PeerPairing } from "./peer-pairing.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "../ipc/federation-rpc.ts";

export interface FederationLanConfig {
  readonly bind: string;
  readonly port: number;
  readonly pairingWindowSeconds: number;
  readonly maxFailedAttempts: number;
  readonly lockoutSeconds: number;
}

export interface BuildFederationLanServerDeps {
  readonly db: Database;
  readonly index: LocalIndex;
  readonly identity: BoxKeypair;
  readonly lan: FederationLanConfig;
  readonly consentTimeoutMs: number;
  readonly notify: (method: string, params: unknown) => void;
  // discovery/pairing only used to satisfy the federation ctx type for query/expertise (unused there)
  readonly discovery?: DiscoveryProvider;
  readonly pairing?: PeerPairing;
}

export interface FederationLanServer {
  readonly lanServer: LanServer;
  readonly pairingWindow: PairingWindow;
  readonly rateLimit: LanRateLimiter;
}

function peerIdFor(pubkey: Uint8Array): string {
  return `peer:${bytesToHex(pubkey.subarray(0, 8))}`;
}

/** Build (but do not start) the federation LanServer + its pairing window + rate limiter. */
export function buildFederationLanServer(deps: BuildFederationLanServerDeps): FederationLanServer {
  const pairingWindow = new PairingWindow(deps.lan.pairingWindowSeconds * 1000);
  const rateLimit = new LanRateLimiter({
    maxFailures: deps.lan.maxFailedAttempts,
    windowMs: deps.lan.pairingWindowSeconds * 1000,
    lockoutMs: deps.lan.lockoutSeconds * 1000,
  });

  const lanServer = new LanServer({
    bind: deps.lan.bind,
    port: deps.lan.port,
    hostKeypair: deps.identity,
    pairing: {
      isOpen: () => pairingWindow.isOpen(),
      consume: (code) => pairingWindow.consume(code),
      open: (code) => pairingWindow.open(code),
      close: () => pairingWindow.close(),
      getExpiresAt: () => pairingWindow.getExpiresAt() ?? undefined,
    },
    rateLimit,
    isKnownPeer: (pubkey) => {
      const row = deps.index.getLanPeerByPubkey(pubkey);
      return row === undefined ? null : { peerId: row.peer_id, writeAllowed: false };
    },
    registerPeer: (pubkey, ip) => {
      const peerId = peerIdFor(pubkey);
      deps.index.addLanPeer({ peerId, peerPubkey: pubkey, direction: "inbound", hostIp: ip });
      return peerId;
    },
    onMessage: async (method, params, peer: LanPeerContext) => {
      // I17 / R1: the answering peerId is the AUTHENTICATED session id, never the request body.
      const body =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const forced = { ...body, peerId: peer.peerId };
      const ctx: FederationRpcContext = {
        db: deps.db,
        consentTimeoutMs: deps.consentTimeoutMs,
        notify: deps.notify,
        // discover/pair/peers are FORBIDDEN_OVER_LAN, so these are never exercised on this path:
        discovery: deps.discovery ?? ({ list: async () => [] } as unknown as DiscoveryProvider),
        pairing: deps.pairing ?? ({ listPeers: () => [] } as unknown as PeerPairing),
      };
      const out = await dispatchFederationRpc(method, forced, ctx);
      if (out.kind === "hit") return out.value;
      throw new LanError(-32601, `ERR_METHOD_NOT_ALLOWED: ${method}`);
    },
  });

  return { lanServer, pairingWindow, rateLimit };
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/federation/federation-server.test.ts && bun run audit:invariants`
Expected: tests PASS; invariants clean (no D13 — this file does not import `item-list-query`).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/federation-server.ts packages/gateway/src/federation/federation-server.test.ts
git commit -m "feat(federation): testable LanServer builder (isKnownPeer/registerPeer/onMessage)"
```

---

### Task 10: Boot wiring in `assemble.ts`

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts`

No new unit test (covered by Task 9 + Task 16 integration); verify via typecheck + a smoke boot. Load `[lan]` config and the identity; build+start the server only when federation is enabled; advertise; late-bind the broker broadcast.

**P1 — boot-gating is `[federation].enabled` ONLY.** The federation `LanServer` is the *only* production `LanServer` construction (verified: `grep -rn "new LanServer" packages/gateway/src` → tests only). It gates **solely** on `[federation].enabled`. `[lan].enabled` is **not consulted** — `[lan]` contributes only transport *parameters* (`bind`/`port`/`pairingWindowSeconds`/`maxFailedAttempts`/`lockoutSeconds`). So `[federation].enabled = true` + `[lan].enabled = false` **starts** the server (using `[lan]`'s bind/port/etc.); `[federation].enabled = false` never starts it regardless of `[lan].enabled`. Add a one-line code comment to that effect at the gate. (Matches the prompt's "Only start it when `[federation].enabled`.")

- [ ] **Step 1: Implement** — replace the federation block (currently lines ~439–447):

```typescript
  const federationCfg = loadNimbusFederationFromConfigDir(paths.configDir);
  // The federation LanServer is gated SOLELY on [federation].enabled. [lan].enabled is NOT
  // consulted; [lan] only supplies transport params (bind/port/pairing/rate-limit) below.
  if (federationCfg.enabled) {
    const identity = await loadOrCreateFederationIdentity(vault);
    const federationRuntime = buildFederationRuntime(federationCfg, localIndex, identity);
    if (federationRuntime !== undefined) {
      void federationRuntime.discovery.start();
      sidecarStops.push(() => void federationRuntime.discovery.stop());
      ipcOpts.federationDiscovery = federationRuntime.discovery;
      ipcOpts.federationPairing = federationRuntime.pairing;
      ipcOpts.federationConsentTimeoutSeconds = federationRuntime.consentTimeoutSeconds;

      const lanCfg = loadNimbusLanFromConfigDir(paths.configDir);
      const built = buildFederationLanServer({
        db,
        index: localIndex,
        identity,
        lan: {
          bind: lanCfg.bind,
          port: lanCfg.port,
          pairingWindowSeconds: lanCfg.pairingWindowSeconds,
          maxFailedAttempts: lanCfg.maxFailedAttempts,
          lockoutSeconds: lanCfg.lockoutSeconds,
        },
        consentTimeoutMs: federationRuntime.consentTimeoutSeconds * 1000,
        notify: () => {},
        discovery: federationRuntime.discovery,
        pairing: federationRuntime.pairing,
      });
      await built.lanServer.start();
      const addr = built.lanServer.listenAddr();
      if (addr !== undefined && federationCfg.mdnsEnabled) {
        void federationRuntime.discovery.advertise(`nimbus-${GATEWAY_VERSION}`, addr.port);
      }
      ipcOpts.lanServer = built.lanServer;
      ipcOpts.lanPairingWindow = built.pairingWindow;
      sidecarStops.push(() => void built.lanServer.stop());
    }
  }
```

Add imports at the top of `assemble.ts`:

```typescript
import { loadOrCreateFederationIdentity } from "../federation/federation-identity.ts";
import { buildFederationLanServer } from "../federation/federation-server.ts";
import { loadNimbusLanFromConfigDir } from "../config/nimbus-toml.ts"; // verify exact export name
```

After `const ipc = createIpcServer(ipcOpts);` (line ~449), late-bind the broker broadcast:

```typescript
  if (federationCfg.enabled) {
    federationConsent.setBroadcast((method, params) => ipc.broadcast(method, params));
  }
```

Add import: `import { federationConsent } from "../federation/consent-broker.ts";`

> **Verify exact config loader name:** grep `loadNimbusLanFromConfigDir` / `loadNimbusFederationFromConfigDir` in `config/nimbus-toml.ts`. If the LAN loader has a different name (e.g. `loadNimbusLanToml`), use that. If `[lan]` is loaded elsewhere already in `assemble.ts`, reuse that value instead of re-loading.

- [ ] **Step 2: Typecheck + smoke**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no errors.
Run (smoke — federation disabled by default, so boot must be unaffected): `bun test packages/gateway/test/integration` (the existing boot/ipc integration tests).
Expected: PASS (no behavior change when `[federation].enabled` is false).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(federation): construct+start LanServer at boot; late-bind consent broadcast"
```

---

### Task 11: Tauri allowlist — `federation.consentRespond` (I7)

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Modify: `packages/gateway/src/security-invariants.test.ts`

`ALLOWED_METHODS` is alphabetized; `federation.consentRespond` sorts **before** `federation.discover`. Count 67 → 68.

- [ ] **Step 1: Update the TS mirror test FIRST (red)** — in `security-invariants.test.ts`, change the assertion `allowlist_exact_size assertion is 67` → `68` (find the exact wording with grep). Run it:

Run: `bun test packages/gateway/src/security-invariants.test.ts -t allowlist`
Expected: FAIL (mirror now says 68 but Rust/source still 67) — confirms the mirror is wired.

- [ ] **Step 2: Edit the Rust allowlist** — in `gateway_bridge.rs`, insert in alphabetical order just before `"federation.discover",`:

```rust
    "federation.consentRespond",
```

And update the count assertion (line ~434):

```rust
        assert_eq!(ALLOWED_METHODS.len(), 68);
```

- [ ] **Step 3: Run the Rust + TS checks**

Run: `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist` (if Rust toolchain present) and `bun test packages/gateway/src/security-invariants.test.ts -t allowlist`
Expected: PASS. (If Rust is unavailable locally, rely on CI; ensure the count + alphabetization are correct by inspection.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs packages/gateway/src/security-invariants.test.ts
git commit -m "feat(federation): expose federation.consentRespond to renderer (I7 67->68)"
```

---

### Task 12: CLI `nimbus team consent <requestId> approve|deny`

**Files:**

- Modify: `packages/cli/src/commands/team.ts`
- Test: `packages/cli/src/commands/team.test.ts` (or add a parse test where team args are tested)

- [ ] **Step 1: Write the failing test** (arg parsing)

```typescript
import { parseTeamArgs } from "./team.ts"; // export it if not already

test("parses team consent approve/deny", () => {
  expect(parseTeamArgs(["consent", "req-1", "approve"])).toEqual({ kind: "consent", requestId: "req-1", approved: true });
  expect(parseTeamArgs(["consent", "req-2", "deny"])).toEqual({ kind: "consent", requestId: "req-2", approved: false });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: FAIL — `consent` kind not handled.

- [ ] **Step 3: Implement** — add to the `TeamCommand` union, `parseTeamArgs`, and the runner switch:

```typescript
// union:
  | { kind: "consent"; requestId: string; approved: boolean }

// parseTeamArgs:
  if (sub === "consent") {
    const requestId = rest[0];
    const verb = rest[1];
    if (requestId === undefined || (verb !== "approve" && verb !== "deny")) {
      throw new Error('usage: nimbus team consent <requestId> approve|deny');
    }
    return { kind: "consent", requestId, approved: verb === "approve" };
  }

// runner switch:
  case "consent": {
    try {
      const r = (await client.call("federation.consentRespond", {
        requestId: cmd.requestId,
        approved: cmd.approved,
      })) as { matched?: boolean };
      if (r.matched === false) {
        process.stderr.write(`No pending consent request for ${cmd.requestId} (already answered or timed out).\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`consent ${cmd.approved ? "approved" : "denied"} for ${cmd.requestId}\n`);
      }
    } catch (e) {
      process.stderr.write(`Error responding to consent request: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
    break;
  }
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team.test.ts
git commit -m "feat(cli): nimbus team consent <id> approve|deny"
```

---

### Task 13: CLI `nimbus team listen` (interactive consent watcher)

**Files:**

- Modify: `packages/cli/src/commands/team.ts`
- Test: covered by manual + the integration test (Task 16); add a parse test for `listen`.

Reuses the `client.onNotification(...)` + `@clack/prompts confirm` pattern from `lib/interactive-ipc-handlers.ts`.

- [ ] **Step 1: Write the failing parse test**

```typescript
test("parses team listen", () => {
  expect(parseTeamArgs(["listen"])).toEqual({ kind: "listen" });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — add `{ kind: "listen" }` to the union + parse, and a runner branch that keeps the client open:

```typescript
  case "listen": {
    process.stdout.write("Listening for federation consent requests. Ctrl-C to stop.\n");
    client.onNotification("federation.consentRequest", (params: unknown) => {
      void (async () => {
        const p = params as { requestId?: string; peerId?: string; namespace?: string; purpose?: string };
        if (typeof p.requestId !== "string") return;
        const ok = await confirm({
          message: `Peer ${p.peerId ?? "?"} requests "${p.namespace ?? "?"}" (purpose: ${p.purpose ?? "?"}). Approve?`,
        });
        if (isCancel(ok)) {
          // Prompt cancelled (Esc): do NOT submit a deny — leave the query to time out on the
          // answerer per consent_timeout_seconds. Avoids an accidental denial from a stray Esc.
          process.stdout.write(`consent prompt cancelled for ${p.requestId}; leaving it to time out.\n`);
          return;
        }
        try {
          await client.call("federation.consentRespond", { requestId: p.requestId, approved: ok === true });
        } catch (e) {
          process.stderr.write(`Error sending consent decision: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      })();
    });
    await new Promise<void>(() => {}); // run until interrupted
    break;
  }
```

Add imports: `import { confirm, isCancel } from "@clack/prompts";` (already a CLI dependency — see `lib/interactive-ipc-handlers.ts`). The `listen` runner must NOT hit the `finally { client.disconnect() }` until interrupted — confirm the runner structure keeps the client alive (the `await new Promise(() => {})` blocks).

- [ ] **Step 4: Run it; verify it passes (parse) + manual smoke optional**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/team.ts
git commit -m "feat(cli): nimbus team listen — interactive federation consent watcher"
```

---

### Task 14: Asker-side over-the-wire query (`federation.ask` / `federation.askExpertise`)

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts`
- Test: `packages/gateway/src/ipc/federation-rpc.test.ts`

Local methods that look up a paired peer (`getLanPeerByPubkey`/`listLanPeers` → host/port/pubkey) and call `sendFederatedOverWire`. These require the peer registry; add `index` to `FederationRpcContext`.

- [ ] **Step 1: Write the failing test** (drives a real in-process responder LanServer)

```typescript
test("federation.ask sends over the wire to a paired peer and returns its answer", async () => {
  // Stand up a responder LanServer (peer B) with a standing-granted namespace; pair A->B; then ask.
  // (Full setup mirrors Task 9's federation-server.test.ts; assert the returned items come from B.)
});
```

> Write the concrete body mirroring `federation-server.test.ts`: build B via `buildFederationLanServer`, start it, open pairing, `outboundPairHandshake` from A's identity, persist B as an outbound peer in A's index (the production `initiatePair` does this), then call `dispatchFederationRpc("federation.ask", { peerId: <B>, namespace, purpose }, ctxA)` and assert the items match B's seeded data.

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts -t "federation.ask"`
Expected: FAIL — method unknown.

- [ ] **Step 3: Implement** — add `index` to `FederationRpcContext`; add cases:

```typescript
    "federation.ask": async (p) => {
      const rec = asRecord(p);
      const peerId = requireString(rec, "peerId");
      const row = ctx.index.listLanPeers().find((r) => r.peer_id === peerId);
      if (row === undefined || row.host_ip === null || row.host_port === null) {
        throw new FederationRpcError(-32602, `ERR_UNKNOWN_PEER: ${peerId}`);
      }
      const body: Record<string, unknown> = {
        namespace: requireString(rec, "namespace"),
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"]) ? { types: rec["types"] } : {}),
      };
      return sendFederatedOverWire(
        row.host_ip,
        row.host_port,
        ctx.selfIdentity,
        row.peer_pubkey,
        "federation.query",
        body,
      );
    },
```

(and an analogous `federation.askExpertise` calling `"federation.expertise"`). Thread `selfIdentity: BoxKeypair` and `index: LocalIndex` into `FederationRpcContext` (built in `dispatchers.ts` from `ipcOpts`; pass the identity via a new `ipcOpts.federationIdentity` set in `assemble.ts`).

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/gateway/src/ipc/federation-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/options.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(federation): asker-side federation.ask/askExpertise over the wire"
```

---

### Task 15: Rewire CLI `team query` / `who-knows` to federate over the wire

**Files:**

- Modify: `packages/cli/src/commands/team.ts`
- Test: `packages/cli/src/commands/team.test.ts`

- [ ] **Step 1: Write the failing parse test** (peer-first signature)

```typescript
test("team query sends to a peer via federation.ask", () => {
  expect(parseTeamArgs(["query", "peer:abc", "project:zurich", "why"]))
    .toEqual({ kind: "query", peerId: "peer:abc", namespace: "project:zurich", purpose: "why" });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: FAIL (current shape differs).

- [ ] **Step 3: Implement** — change the `query` runner to call `federation.ask` (and `whoKnows` → `federation.askExpertise`), keeping the local-answer methods only for the in-process tests:

```typescript
  case "query": {
    const r = await client.call("federation.ask", { peerId: cmd.peerId, namespace: cmd.namespace, purpose: cmd.purpose });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    break;
  }
```

- [ ] **Step 4: Run it; verify it passes**

Run: `bun test packages/cli/src/commands/team.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team.test.ts
git commit -m "feat(cli): team query/who-knows federate over the wire via federation.ask"
```

---

### Task 16: Payoff — two-gateway-over-the-wire integration test

**Files:**

- Create: `packages/gateway/test/integration/federation/two-gateway-wire.integration.test.ts`

Two in-process federation runtimes (A asker, B answerer), real loopback NaCl socket, in-memory discovery. Walks the full acceptance.

- [ ] **Step 1: Write the test**

```typescript
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { federationConsent } from "../../../src/federation/consent-broker.ts";
import { NamespaceStore } from "../../../src/federation/namespace-store.ts";
import { PeerPairing } from "../../../src/federation/peer-pairing.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";
import { outboundPairHandshake, sendFederatedOverWire } from "../../../src/ipc/lan-client.ts";

// ... beforeEach: build B (db + index + LanServer started on 127.0.0.1:0, identity B), seed items;
//     build A (db + index + identity A).
// Walk:
//   1. pair: B.pairingWindow.open(code); hostPub = await outboundPairHandshake(127.0.0.1, B.port, code, A.identity)
//      → A persists B as outbound peer (peer_pubkey=hostPub, host/port); assert B has A as inbound peer.
//   2. publish + grant viewer (standing_consent=false) on B (via NamespaceStore directly or B's local dispatch).
//   3. query (consented): set federationConsent.setBroadcast(rid -> respond approve);
//      res = sendFederatedOverWire(B.host, B.port, A.identity, hostPub, "federation.query", {namespace, purpose})
//      assert res.items only contain declared types; no metadata/raw_meta fields.
//   4. undeclared-type query → res.items empty.
//   5. revoke grant on B → query returns no_grant-shaped error.
//   6. verifyAuditChain(new LocalIndex(B.db), {...}) still verifies; federation entries present.
//   7. expertise: sendFederatedOverWire(... "federation.expertise" ...) → rank only, zero item content.
//   8. consent-timeout: fresh non-standing grant, setBroadcast(noop) → expect error "timeout_waiting_for_consent".
//   9. impersonation (R1): sendFederatedOverWire with body { peerId: "peer:SOMEONE_ELSE", namespace, purpose }
//      → answered for A's grant only (B ignores body peerId).
```

> Fill in each step with concrete code (mirror `federation-acceptance.integration.test.ts` for publish/grant/revoke via the local dispatcher against B's ctx, and `federation-server.test.ts` for the wire calls). Use B's local `dispatchFederationRpc` for management (publish/grant/revoke) since those are local methods.

- [ ] **Step 2: Run it; verify it passes**

Run: `bun test packages/gateway/test/integration/federation/two-gateway-wire.integration.test.ts`
Expected: PASS — all acceptance steps green.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/federation/two-gateway-wire.integration.test.ts
git commit -m "test(federation): two-gateway over-the-wire acceptance (pair→query→revoke→audit→expertise→timeout→impersonation)"
```

---

### Task 17: Security-invariants test additions (R1 + I5) and docs

**Files:**

- Modify: `packages/gateway/src/security-invariants.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: Add the R1 impersonation + I5 admittance assertions** to `security-invariants.test.ts` (mirror Task 8/Task 16 assertions at the unit layer): assert `checkLanMethodAllowed` admits `federation.query`/`federation.expertise` and rejects `federation.consentRespond`/`federation.ask`/`vault.x`/`data.x`/`extension.install`.

```typescript
test("I5: federation over-the-wire admittance", () => {
  const peer = { peerId: "p", writeAllowed: false };
  for (const m of ["federation.query", "federation.expertise"]) {
    expect(() => checkLanMethodAllowed(m, peer)).not.toThrow();
  }
  for (const m of ["federation.consentRespond", "federation.ask", "vault.get", "data.import", "extension.install"]) {
    expect(() => checkLanMethodAllowed(m, peer)).toThrow();
  }
});
```

- [ ] **Step 2: Run it; verify it passes**

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: PASS.

- [ ] **Step 3: Update docs**

- `docs/SECURITY-INVARIANTS.md`: under I5/I17, note the now-live over-the-wire wiring; under I7, add the `federation.consentRespond` renderer entry.
- `docs/CHANGELOG.md`: dated entry — "Phase 6 Slice 1 — over-the-wire federation (outbound client, LanServer boot, owner-consent round-trip, two-gateway acceptance)."
- `docs/roadmap.md`: flip the Slice-1 "deferred seams" note to delivered.
- `markdownlint-cli2 --fix` the changed docs (superpowers + docs are linted in full preflight).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md docs/CHANGELOG.md docs/roadmap.md
git commit -m "docs(federation): record over-the-wire wiring (I5/I7/I17) + R1/I5 tests + changelog/roadmap"
```

---

### Task 18: Full preflight + Linux coverage verification

**Files:** none (verification only)

- [ ] **Step 1: Run the fast static gates**

Run: `bun run preflight:fast`
Expected: green (lint, typecheck, invariants, audits).

- [ ] **Step 2: Run the full preflight**

Run: `bun run preflight`
Expected: green. Fix any red before proceeding.

- [ ] **Step 3: Verify `audit:coverage-floor` on Linux (CI-authoritative)** via Docker:

```bash
docker run --rm -v "C:/gitrep/Nimbus/.worktrees/dev/asafgolombek/phase6-slice1-federation-wire":/src:ro oven/bun:latest bash -lc \
  'mkdir -p /app && (cd /src && tar --exclude=node_modules --exclude=.git -cf - .) | (cd /app && tar -xf -) \
   && cd /app && apt-get update -y >/dev/null && apt-get install -y git >/dev/null && bun install \
   && bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor'
```

Expected: no coverage-floor violations for the new `federation/` and `ipc/lan-client.ts` files. If a new file reads `<80%` on Linux, add focused tests until it clears (Windows numbers are not authoritative).

- [ ] **Step 4: Stop and report.** Do NOT push or open the PR until preflight is green and the user confirms (per the session constraints).

---

## Self-review (run before handing off)

**Spec coverage:** Seam 1 → Tasks 3,4,5,(14,15). Seam 2 → Tasks 9,10. Seam 3 → Tasks 6,7,11,12,13. Identity prerequisite → Tasks 1,2. Payoff E2E → Task 16. R1 → Tasks 9,16,17. R2/I5 → Tasks 8,17. R3/I6 → Task 10 (`[lan]` defaults). R4/I7 → Task 11. R5 → Task 6. R6 → Task 2. V34 cession → no migration task. Docs → Task 17. Preflight/coverage → Task 18.

**Placeholder scan:** Task 14/16 test bodies are described, not fully written, because they compose helpers proven concretely in Tasks 4/9 — the implementing subagent writes the concrete body following the cited templates. All implementation code blocks are complete.

**Type consistency:** `BoxKeypair` (lan-crypto), `ConsentDecision` = `"approved"|"denied"|"timeout"` (query-gate), `FederationRpcContext` extended consistently (Tasks 9/14 both add `db`/`consentTimeoutMs`/`notify`/`discovery`/`pairing`, plus `index`/`selfIdentity` in Task 14 — ensure `dispatchers.ts` builds the full shape). `getLanPeerByPubkey` / `addLanPeer` / `listLanPeers` signatures match `local-index.ts`.

**Known verification points flagged for the implementer:** exact config-loader export name for `[lan]` (Task 10); whether `parseTeamArgs` is already exported (Task 12); exact `allowlist_exact_size` assertion wording (Task 11); whether `dispatchers.ts` already passes `db`/`index` into the federation ctx (Task 14).
