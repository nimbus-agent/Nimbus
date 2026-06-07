# Phase 6 Slice 4 — Org Policy Engine + Admin Console + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an org-level policy engine (trust-anchor-signed `nimbus.policy.toml`, fetched over the federation channel, verified, and enforced locally — monotonic-stricter so it can only tighten HITL/quorum/retention), a dependency-free local Admin Console, an observability surface (status API + Prometheus `/metrics`), audit-log shipping, a team audit merged view, and a durable GDPR purge — gated by new structural invariant **I22**.

**Architecture:** A new `packages/gateway/src/policy/` subsystem owns the policy schema, Ed25519 sign/verify over a canonicalized byte form, the policy gate (verify → load → `EnforcedPolicy`), persistence, federation distribution, and the profile resolver. Enforcement hangs off existing sites: connector allowlist in `platform/assemble.ts` (before the mesh starts), retention floor in the retention sidecar, HITL/quorum override in the executor/quorum reader. A new `status/` subsystem builds one snapshot exposed as IPC + JSON + Prometheus text. The console is a vanilla-TS static bundle in `packages/admin-console`, served by the gateway HTTP server. GDPR purge adds a durable per-peer ledger retried on sync. Migrations V36 (policy) + V37 (GDPR) add five tables.

**Tech Stack:** Bun v1.2 / TypeScript 6 strict (no `any`); `bun:sqlite`; **tweetnacl** `nacl.sign.detached` for Ed25519 (already a dependency — no new package); SDK `generateEd25519Keypair`/`encodeBase64`/`decodeBase64`; Bun's bundler (`bun build`) for the console; Biome; `bun test`.

**Spec:** [`docs/superpowers/specs/2026-06-07-phase6-slice4-policy-admin-observability-design.md`](../specs/2026-06-07-phase6-slice4-policy-admin-observability-design.md). Read it before starting.

---

## Conventions for every task

- **Branch:** `dev/asafgolombek/phase6-slice4-policy-admin-observability` (already checked out in worktree `.worktrees/phase6-slice4-policy-admin-observability`). Never commit on `main`. Verify: `git rev-parse --abbrev-ref HEAD`.
- **Run tests from the worktree root.** Single file: `bun test packages/gateway/src/policy/<file>.test.ts`. **Never** run the full suite / `bun run test` / `preflight` / `test:coverage` — they OOM. Scoped `bun test <files>` + `bun run preflight:fast` (static gates) only.
- **No `any`.** Use `unknown` + narrowing for all external/wire data.
- **All SQLite writes** go through `dbRun`/`dbExec`/`dbStmtRun` from `packages/gateway/src/db/write.ts` (I14). Never `db.run(`/`db.exec(`.
- **Secrets** (`policy.signing.privkey`) live ONLY in the Vault — never a DB column, IPC/wire field, log, or config. The matching pubkey may be persisted/sent (it is public).
- **Enforcement reads `EnforcedPolicy` from `policy-gate.ts`** — never the raw `.toml` (I22).
- **Lint before commit:** `bunx biome check <changed files>`; typecheck `cd packages/gateway && bun run typecheck`.
- **Commit** at the end of each task with a Conventional Commit; end every body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **TDD:** write the failing test, run it red, implement minimally, run it green, lint, commit.
- **Biome in worktree gotcha:** `bun run lint` reports "0 files" inside `.claude/worktrees`, but this worktree is under `.worktrees/` (not `.claude/`), so `bunx biome check packages scripts` works normally.

### ⚠️ Branch-time verification (do FIRST, before Task 1)

- [ ] **Confirm migration numbers.** Read `CURRENT_SCHEMA_VERSION` in `packages/gateway/src/index/local-index.ts`. This plan assumes **35 → 36** (policy) **→ 37** (GDPR). If a parallel track bumped it, shift every `36`/`37` in this plan to the next free contiguous numbers (keep `BACKFILL_LABELS` gapless).

  Run: `bun -e "import {CURRENT_SCHEMA_VERSION} from './packages/gateway/src/index/local-index.ts'; console.log(CURRENT_SCHEMA_VERSION)"`
  Expected: prints `35`.

- [ ] **Read the integration points** you will wire into (do not edit yet), to confirm exact symbols:
  - `packages/gateway/src/federation/federation-server.ts` — `dispatchFederationRpc(method, params, ctx)` + the `onMessage` switch (you'll add `federation.policy`, `federation.purge`, `federation.auditExport`).
  - `packages/gateway/src/ipc/lan-server.ts` — the LAN method allow-set (admit the new federation methods).
  - `packages/gateway/src/ipc/http-server.ts` — the request router (you'll add `/v1/admin/status`, `/metrics`, `/admin/*`).
  - `packages/gateway/src/ipc/http-write-routes.ts` — `WRITE_ROUTE_ALLOWLIST` (add `PUT /v1/admin/policy`).
  - `packages/gateway/src/ipc/http-auth.ts` — bearer compare helper (reuse for `/metrics` + `/v1/admin/*`).
  - `packages/gateway/src/platform/assemble.ts` — where connectors are registered/spawned (gate on the allowlist before this).
  - `packages/gateway/src/engine/quorum/quorum-coordinator.ts` + `packages/gateway/src/config/nimbus-toml.ts` `parseQuorumConfig` — where the per-action quorum size is resolved.
  - `packages/gateway/src/index/migrations/runner.ts` — `INDEXED_SCHEMA_STEPS` + `BACKFILL_LABELS` tails + `runIndexedSchemaMigrations`.

---

## Lane A — Policy core

### Task 1: Policy schema types + `nimbus.policy.toml` parser

**Files:**
- Create: `packages/gateway/src/policy/types.ts`
- Create: `packages/gateway/src/policy/policy-toml.ts`
- Test: `packages/gateway/src/policy/policy-toml.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// policy-toml.test.ts
import { describe, expect, test } from "bun:test";
import { parsePolicyToml, serializePolicyToml } from "./policy-toml.ts";

const SAMPLE = `
[policy]
version = 1
org = "acme"
issued_at = "2026-06-07T00:00:00Z"

[policy.connectors]
allow = ["github", "slack", "jira"]

[policy.retention]
min_days = 30

[policy.hitl]
require = ["db.drop", "vault.export"]

[policy.hitl.quorum."terraform.destroy"]
approvers = 2
window_seconds = 3600

[policy.audit]
ship_to = "https://siem.acme.internal/ingest"
ship_format = "ndjson"
`;

describe("parsePolicyToml", () => {
  test("parses all sections", () => {
    const p = parsePolicyToml(SAMPLE);
    expect(p.version).toBe(1);
    expect(p.org).toBe("acme");
    expect(p.connectors.allow).toEqual(["github", "slack", "jira"]);
    expect(p.retention.minDays).toBe(30);
    expect(p.hitl.require).toEqual(["db.drop", "vault.export"]);
    expect(p.hitl.quorum.get("terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 3600 });
    expect(p.audit.shipTo).toBe("https://siem.acme.internal/ingest");
  });

  test("absent connectors section => unrestricted (allow undefined)", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "x"\n`);
    expect(p.connectors.allow).toBeUndefined();
    expect(p.retention.minDays).toBe(0);
    expect(p.hitl.require).toEqual([]);
    expect(p.hitl.quorum.size).toBe(0);
    expect(p.audit.shipTo).toBeUndefined();
  });

  test("round-trips through serialize→parse", () => {
    const p = parsePolicyToml(SAMPLE);
    expect(parsePolicyToml(serializePolicyToml(p))).toEqual(p);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/policy-toml.test.ts`
Expected: FAIL — `Cannot find module './policy-toml.ts'`.

- [ ] **Step 3: Write `types.ts`**

```typescript
// types.ts
import type { QuorumRule } from "../config/nimbus-toml.ts";

export type { QuorumRule };

/** The parsed org policy (anchor-authored). Optional fields = "no constraint". */
export interface OrgPolicy {
  readonly version: number;
  readonly org: string;
  readonly issuedAt?: string;
  readonly connectors: { readonly allow?: readonly string[] };
  readonly retention: { readonly minDays: number };
  readonly hitl: {
    readonly require: readonly string[];
    readonly quorum: ReadonlyMap<string, QuorumRule>;
  };
  readonly audit: { readonly shipTo?: string; readonly shipFormat?: string };
}

/** Where a persisted policy came from. */
export type PolicySource = "anchor" | "peer" | "none";

/** Runtime policy status for the observability snapshot. */
export interface PolicyState {
  readonly org?: string;
  readonly version?: number;
  readonly signatureValid: boolean;
  readonly lastFetchedMs?: number;
  readonly pendingRestart: boolean;
  readonly source: PolicySource;
}
```

- [ ] **Step 4: Write `policy-toml.ts`**

```typescript
// policy-toml.ts
import type { QuorumRule } from "../config/nimbus-toml.ts";
import {
  isTableHeader,
  parseIntDec,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "../config/toml-primitives.ts";
import type { OrgPolicy } from "./types.ts";

function parseScalarString(raw: string): string | undefined {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1);
  return undefined;
}

const QUORUM_PREFIX = '[policy.hitl.quorum."';

/** Parse a canonicalized nimbus.policy.toml string into an OrgPolicy. */
export function parsePolicyToml(source: string): OrgPolicy {
  let version = 0;
  let org = "";
  let issuedAt: string | undefined;
  let allow: string[] | undefined;
  let minDays = 0;
  let require: string[] = [];
  const quorum = new Map<string, QuorumRule>();
  let shipTo: string | undefined;
  let shipFormat: string | undefined;

  let section = "";
  let quorumId: string | undefined;
  const quorumAccum = new Map<string, Record<string, string>>();

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      quorumId = undefined;
      if (trimmed.startsWith(QUORUM_PREFIX) && trimmed.endsWith('"]')) {
        const id = trimmed.slice(QUORUM_PREFIX.length, -2);
        if (id.length > 0) {
          quorumId = id;
          if (!quorumAccum.has(id)) quorumAccum.set(id, {});
        }
        section = "quorum";
      } else {
        section = trimmed;
      }
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    const { key, valRaw } = kv;
    switch (section) {
      case "[policy]":
        if (key === "version") version = parseIntDec(valRaw) ?? 0;
        else if (key === "org") org = parseScalarString(valRaw) ?? "";
        else if (key === "issued_at") issuedAt = parseScalarString(valRaw);
        break;
      case "[policy.connectors]":
        if (key === "allow") allow = [...parseStringArray(valRaw)];
        break;
      case "[policy.retention]":
        if (key === "min_days") minDays = parseIntDec(valRaw) ?? 0;
        break;
      case "[policy.hitl]":
        if (key === "require") require = [...parseStringArray(valRaw)];
        break;
      case "[policy.audit]":
        if (key === "ship_to") shipTo = parseScalarString(valRaw);
        else if (key === "ship_format") shipFormat = parseScalarString(valRaw);
        break;
      case "quorum":
        if (quorumId !== undefined) {
          const b = quorumAccum.get(quorumId);
          if (b !== undefined) b[key] = valRaw;
        }
        break;
      default:
        break;
    }
  }

  for (const [id, b] of quorumAccum) {
    const approvers = parseIntDec(b.approvers ?? "") ?? 0;
    const windowSeconds = parseIntDec(b.window_seconds ?? "") ?? 0;
    if (approvers >= 1 && windowSeconds > 0) quorum.set(id, { approvers, windowSeconds });
  }

  return {
    version,
    org,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    connectors: allow === undefined ? {} : { allow },
    retention: { minDays },
    hitl: { require, quorum },
    audit: {
      ...(shipTo === undefined ? {} : { shipTo }),
      ...(shipFormat === undefined ? {} : { shipFormat }),
    },
  };
}

/** Serialize an OrgPolicy back to canonical-ish TOML (used by the anchor editor + round-trip tests). */
export function serializePolicyToml(p: OrgPolicy): string {
  const lines: string[] = ["[policy]", `version = ${p.version}`, `org = "${p.org}"`];
  if (p.issuedAt !== undefined) lines.push(`issued_at = "${p.issuedAt}"`);
  if (p.connectors.allow !== undefined) {
    lines.push("", "[policy.connectors]", `allow = [${p.connectors.allow.map((c) => `"${c}"`).join(", ")}]`);
  }
  lines.push("", "[policy.retention]", `min_days = ${p.retention.minDays}`);
  lines.push("", "[policy.hitl]", `require = [${p.hitl.require.map((r) => `"${r}"`).join(", ")}]`);
  for (const [id, rule] of p.hitl.quorum) {
    lines.push("", `[policy.hitl.quorum."${id}"]`, `approvers = ${rule.approvers}`, `window_seconds = ${rule.windowSeconds}`);
  }
  if (p.audit.shipTo !== undefined) {
    lines.push("", "[policy.audit]", `ship_to = "${p.audit.shipTo}"`);
    if (p.audit.shipFormat !== undefined) lines.push(`ship_format = "${p.audit.shipFormat}"`);
  }
  return `${lines.join("\n")}\n`;
}
```

> **Note:** confirm `parseIntDec`, `parseStringArray`, `isTableHeader`, `splitKeyValue`, `stripComment` are exported from `config/toml-primitives.ts` (they are used by `nimbus-toml.ts`). If a name differs, match the real export.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/policy/policy-toml.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Lint + commit**

```bash
bunx biome check packages/gateway/src/policy/
git add packages/gateway/src/policy/types.ts packages/gateway/src/policy/policy-toml.ts packages/gateway/src/policy/policy-toml.test.ts
git commit -m "feat(policy): nimbus.policy.toml schema types + parser"
```

---

### Task 2: Signature canonicalization + Ed25519 sign/verify

**Files:**
- Create: `packages/gateway/src/policy/policy-signing.ts`
- Test: `packages/gateway/src/policy/policy-signing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// policy-signing.test.ts
import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair } from "@nimbus-dev/sdk";
import { canonicalize, signPolicy, verifyPolicy } from "./policy-signing.ts";

describe("canonicalize", () => {
  test("CRLF, BOM, trailing whitespace, and extra EOF newlines all normalize identically", () => {
    const lf = 'a = 1\nb = 2\n';
    const crlf = '﻿a = 1  \r\nb = 2\r\n\r\n';
    expect(canonicalize(crlf)).toBe(canonicalize(lf));
    expect(canonicalize(lf)).toBe('a = 1\nb = 2\n');
  });
});

describe("signPolicy / verifyPolicy", () => {
  test("a signature over canonical bytes verifies regardless of on-disk line endings", () => {
    const kp = generateEd25519Keypair(); // { publicKey, secretKey } base64
    const tomlLf = 'x = 1\n';
    const sig = signPolicy(tomlLf, kp.secretKey);
    // Same content, CRLF + trailing blank line on disk:
    expect(verifyPolicy('x = 1\r\n\r\n', sig, kp.publicKey)).toBe(true);
    expect(verifyPolicy('x = 2\n', sig, kp.publicKey)).toBe(false); // tampered
  });

  test("wrong key fails", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const sig = signPolicy('q = 1\n', a.secretKey);
    expect(verifyPolicy('q = 1\n', sig, b.publicKey)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/policy-signing.test.ts`
Expected: FAIL — module not found.

> **Branch-time check:** confirm `generateEd25519Keypair`, `encodeBase64`, `decodeBase64` are exported from `@nimbus-dev/sdk` (they are re-exported by `extensions/verify-signature.ts`). Confirm `tweetnacl` is importable as `import nacl from "tweetnacl"` in the gateway (it is used by `updater/signature-verifier.ts`).

- [ ] **Step 3: Write `policy-signing.ts`**

```typescript
// policy-signing.ts
import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

/**
 * Canonical byte form for signing/verifying. Both sign and verify call this, so
 * CRLF<->LF/BOM/trailing-whitespace rewrites by git or editors cannot break a
 * signature across platforms (platform-equality). See spec §4.2.1.
 */
export function canonicalize(toml: string): string {
  let s = toml;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); // LF only
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "")) // trailing ws per line
    .join("\n");
  s = `${s.replace(/\n+$/g, "")}\n`; // exactly one trailing newline
  return s;
}

const enc = new TextEncoder();

/** Detached Ed25519 signature (base64) over canonicalize(toml). */
export function signPolicy(toml: string, secretKeyB64: string): string {
  const msg = enc.encode(canonicalize(toml));
  const sig = nacl.sign.detached(msg, decodeBase64(secretKeyB64));
  return encodeBase64(sig);
}

/** Verify a detached base64 signature against the pinned base64 pubkey. */
export function verifyPolicy(toml: string, sigB64: string, pubKeyB64: string): boolean {
  try {
    const msg = enc.encode(canonicalize(toml));
    return nacl.sign.detached.verify(msg, decodeBase64(sigB64), decodeBase64(pubKeyB64));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/policy/policy-signing.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
bunx biome check packages/gateway/src/policy/policy-signing.ts packages/gateway/src/policy/policy-signing.test.ts
git add packages/gateway/src/policy/policy-signing.ts packages/gateway/src/policy/policy-signing.test.ts
git commit -m "feat(policy): canonicalization + Ed25519 sign/verify (cross-platform stable)"
```

---

### Task 3: V36 migration + policy persistence store

**Files:**
- Create: `packages/gateway/src/index/policy-v36-sql.ts`
- Create: `packages/gateway/src/policy/policy-store.ts`
- Test: `packages/gateway/src/policy/policy-store.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (append V36 step + label)
- Modify: `packages/gateway/src/index/local-index.ts` (`CURRENT_SCHEMA_VERSION = 35` → `36`)

- [ ] **Step 1: Write the failing test**

```typescript
// policy-store.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

describe("PolicyStore", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("persists and reloads the last-known-valid policy", () => {
    const store = new PolicyStore(db);
    store.persist({ toml: 'org = "acme"\n', sig: "AA==", org: "acme", version: 1, source: "peer", fetchedAt: 100 });
    const got = store.load();
    expect(got?.org).toBe("acme");
    expect(got?.version).toBe(1);
    expect(got?.source).toBe("peer");
  });

  test("load() returns undefined when no policy persisted", () => {
    expect(new PolicyStore(freshDb()).load()).toBeUndefined();
  });

  test("pins and reads the anchor pubkey", () => {
    const store = new PolicyStore(db);
    store.pinAnchorPubkey("PUBKEYB64", "pairing", 42);
    expect(store.getAnchorPubkey()).toBe("PUBKEYB64");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/policy-store.test.ts`
Expected: FAIL — table `org_policy_state` missing / module not found.

- [ ] **Step 3: Write the V36 SQL**

```typescript
// policy-v36-sql.ts
export const POLICY_V36_SQL = `
CREATE TABLE IF NOT EXISTS org_policy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  toml TEXT NOT NULL,
  sig TEXT NOT NULL,
  org TEXT NOT NULL,
  version INTEGER NOT NULL,
  issued_at TEXT,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_anchor_pin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pubkey TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
`;
```

- [ ] **Step 4: Wire the migration step** in `index/migrations/runner.ts`

Read the file; follow the existing `simpleStep`/`applySchemaStep` pattern (same shape as the V35 tail). Append:

```typescript
import { POLICY_V36_SQL } from "../policy-v36-sql.ts";
// ... in INDEXED_SCHEMA_STEPS, append after the V35 entry:
simpleStep(36, POLICY_V36_SQL),
// ... in BACKFILL_LABELS, append (keep gapless):
[36, "policy state + anchor pin tables"],
```

Then bump `CURRENT_SCHEMA_VERSION = 36` in `index/local-index.ts`.

- [ ] **Step 5: Write `policy-store.ts`**

```typescript
// policy-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { PolicySource } from "./types.ts";

export interface PersistedPolicy {
  readonly toml: string;
  readonly sig: string;
  readonly org: string;
  readonly version: number;
  readonly issuedAt?: string;
  readonly fetchedAt: number;
  readonly source: PolicySource;
}

interface PolicyRow {
  toml: string;
  sig: string;
  org: string;
  version: number;
  issued_at: string | null;
  fetched_at: number;
  source: string;
}

export class PolicyStore {
  constructor(private readonly db: Database) {}

  persist(p: PersistedPolicy): void {
    dbRun(
      this.db,
      `INSERT INTO org_policy_state (id, toml, sig, org, version, issued_at, fetched_at, source)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         toml = excluded.toml, sig = excluded.sig, org = excluded.org,
         version = excluded.version, issued_at = excluded.issued_at,
         fetched_at = excluded.fetched_at, source = excluded.source`,
      [p.toml, p.sig, p.org, p.version, p.issuedAt ?? null, p.fetchedAt, p.source],
    );
  }

  load(): PersistedPolicy | undefined {
    const row = this.db.query("SELECT * FROM org_policy_state WHERE id = 1").get() as PolicyRow | null;
    if (row === null) return undefined;
    return {
      toml: row.toml,
      sig: row.sig,
      org: row.org,
      version: row.version,
      ...(row.issued_at === null ? {} : { issuedAt: row.issued_at }),
      fetchedAt: row.fetched_at,
      source: row.source as PolicySource,
    };
  }

  pinAnchorPubkey(pubkey: string, source: "pairing" | "manual", nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO policy_anchor_pin (id, pubkey, pinned_at, source) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pubkey = excluded.pubkey, pinned_at = excluded.pinned_at, source = excluded.source`,
      [pubkey, nowMs, source],
    );
  }

  getAnchorPubkey(): string | undefined {
    const row = this.db.query("SELECT pubkey FROM policy_anchor_pin WHERE id = 1").get() as { pubkey: string } | null;
    return row?.pubkey;
  }
}
```

- [ ] **Step 6: Run tests + verify migration**

Run: `bun test packages/gateway/src/policy/policy-store.test.ts`
Expected: PASS (3 tests).
Run: `bun -e "import {CURRENT_SCHEMA_VERSION} from './packages/gateway/src/index/local-index.ts'; console.log(CURRENT_SCHEMA_VERSION)"`
Expected: prints `36`.

- [ ] **Step 7: Lint + commit**

```bash
bunx biome check packages/gateway/src/policy/ packages/gateway/src/index/policy-v36-sql.ts
git add packages/gateway/src/policy/policy-store.ts packages/gateway/src/policy/policy-store.test.ts packages/gateway/src/index/policy-v36-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts
git commit -m "feat(policy): V36 migration + PolicyStore (persist last-valid + pinned pubkey)"
```

---

### Task 4: Policy gate — verify → load → EnforcedPolicy (monotonic-stricter, fail-closed)

**Files:**
- Create: `packages/gateway/src/policy/policy-gate.ts`
- Test: `packages/gateway/src/policy/policy-gate.test.ts`

`EnforcedPolicy` is the ONLY thing enforcement sites read. It is computed monotonically against a **local baseline**, so policy can only tighten (spec §4.3 R3).

- [ ] **Step 1: Write the failing test**

```typescript
// policy-gate.test.ts
import { describe, expect, test } from "bun:test";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { parsePolicyToml } from "./policy-toml.ts";
import { computeEnforced, type LocalBaseline } from "./policy-gate.ts";

const baseline: LocalBaseline = {
  retentionDays: 7,
  hitlRequired: new Set(["git.force_push_main"]),
  quorum: new Map<string, QuorumRule>([["terraform.destroy", { approvers: 1, windowSeconds: 600 }]]),
};

describe("computeEnforced — monotonic stricter", () => {
  test("retention floor raises but never lowers", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=30\n`), baseline);
    expect(e.retentionDays).toBe(30); // max(7, 30)
    const e2 = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.retention]\nmin_days=3\n`), baseline);
    expect(e2.retentionDays).toBe(7); // policy below baseline => baseline wins
  });

  test("HITL required = union; policy cannot drop a local requirement", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl]\nrequire=["db.drop"]\n`), baseline);
    expect([...e.hitlRequired].sort()).toEqual(["db.drop", "git.force_push_main"]);
  });

  test("quorum approvers = max(local, policy); raise-then-lower toward baseline both apply (no high-water lock)", () => {
    const raise = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=3\nwindow_seconds=900\n`), baseline);
    expect(raise.quorum.get("terraform.destroy")?.approvers).toBe(3);
    const lower = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=2\nwindow_seconds=900\n`), baseline);
    expect(lower.quorum.get("terraform.destroy")?.approvers).toBe(2); // still >= baseline 1
  });

  test("policy below baseline quorum cannot weaken it", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.hitl.quorum."terraform.destroy"]\napprovers=1\nwindow_seconds=900\n`), {
      ...baseline,
      quorum: new Map<string, QuorumRule>([["terraform.destroy", { approvers: 2, windowSeconds: 600 }]]),
    });
    expect(e.quorum.get("terraform.destroy")?.approvers).toBe(2); // max(2,1)
  });

  test("connectors allow passes through (undefined = unrestricted)", () => {
    const e = computeEnforced(parsePolicyToml(`[policy]\nversion=1\norg="x"\n[policy.connectors]\nallow=["github"]\n`), baseline);
    expect(e.connectorAllow).toEqual(["github"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/policy-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `policy-gate.ts`**

```typescript
// policy-gate.ts
import type { Database } from "bun:sqlite";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { parsePolicyToml } from "./policy-toml.ts";
import type { PersistedPolicy, PolicyStore } from "./policy-store.ts";
import { verifyPolicy } from "./policy-signing.ts";
import type { OrgPolicy, PolicyState } from "./types.ts";

/** The local config/default floor that policy can only tighten, never loosen. */
export interface LocalBaseline {
  readonly retentionDays: number;
  readonly hitlRequired: ReadonlySet<string>;
  readonly quorum: ReadonlyMap<string, QuorumRule>;
}

/** The enforced view — the ONLY thing enforcement sites read (I22). */
export interface EnforcedPolicy {
  readonly connectorAllow?: readonly string[];
  readonly retentionDays: number;
  readonly hitlRequired: ReadonlySet<string>;
  readonly quorum: ReadonlyMap<string, QuorumRule>;
  readonly auditShipTo?: string;
  readonly auditShipFormat?: string;
}

/** Pure monotonic-stricter resolution against the local baseline (spec §4.3 R3). */
export function computeEnforced(policy: OrgPolicy, base: LocalBaseline): EnforcedPolicy {
  const hitlRequired = new Set<string>(base.hitlRequired);
  for (const a of policy.hitl.require) hitlRequired.add(a);

  const quorum = new Map<string, QuorumRule>(base.quorum);
  for (const [id, pol] of policy.hitl.quorum) {
    const local = quorum.get(id);
    const approvers = Math.max(local?.approvers ?? 0, pol.approvers);
    const windowSeconds = pol.windowSeconds > 0 ? pol.windowSeconds : (local?.windowSeconds ?? pol.windowSeconds);
    quorum.set(id, { approvers, windowSeconds });
  }

  return {
    ...(policy.connectors.allow === undefined ? {} : { connectorAllow: policy.connectors.allow }),
    retentionDays: Math.max(base.retentionDays, policy.retention.minDays),
    hitlRequired,
    quorum,
    ...(policy.audit.shipTo === undefined ? {} : { auditShipTo: policy.audit.shipTo }),
    ...(policy.audit.shipFormat === undefined ? {} : { auditShipFormat: policy.audit.shipFormat }),
  };
}

/**
 * Verify a candidate {toml, sig} against the pinned pubkey. Returns the parsed
 * OrgPolicy ONLY if the signature is valid; otherwise null (caller falls back to
 * last-valid — fail-closed, spec §4.3 R1).
 */
export function verifyCandidate(toml: string, sig: string, pinnedPubkey: string): OrgPolicy | null {
  if (!verifyPolicy(toml, sig, pinnedPubkey)) return null;
  return parsePolicyToml(toml);
}

/**
 * The single gate enforcement consults. Holds the active OrgPolicy (or none) and
 * the local baseline; exposes EnforcedPolicy + status. Unverified policy never
 * reaches here — only verifyCandidate-approved policies are set.
 */
export class PolicyGate {
  private active: OrgPolicy | undefined;
  private state: PolicyState = { signatureValid: false, pendingRestart: false, source: "none" };

  constructor(
    private readonly store: PolicyStore,
    private baseline: LocalBaseline,
  ) {
    this.rehydrate();
  }

  private rehydrate(): void {
    const persisted = this.store.load();
    const pinned = this.store.getAnchorPubkey();
    if (persisted === undefined || pinned === undefined) return;
    const parsed = verifyCandidate(persisted.toml, persisted.sig, pinned);
    if (parsed === null) return; // persisted copy tampered on disk — stay ungoverned
    this.active = parsed;
    this.state = {
      org: persisted.org,
      version: persisted.version,
      signatureValid: true,
      lastFetchedMs: persisted.fetchedAt,
      pendingRestart: false,
      source: persisted.source === "none" ? "peer" : persisted.source,
    };
  }

  /** Apply a freshly-verified policy (already signature-checked). */
  applyVerified(policy: OrgPolicy, persisted: PersistedPolicy, pendingRestart: boolean): void {
    this.active = policy;
    this.state = {
      org: persisted.org,
      version: persisted.version,
      signatureValid: true,
      lastFetchedMs: persisted.fetchedAt,
      pendingRestart,
      source: persisted.source === "none" ? "peer" : persisted.source,
    };
  }

  setBaseline(base: LocalBaseline): void {
    this.baseline = base;
  }

  enforced(): EnforcedPolicy {
    if (this.active === undefined) {
      return {
        retentionDays: this.baseline.retentionDays,
        hitlRequired: this.baseline.hitlRequired,
        quorum: this.baseline.quorum,
      };
    }
    return computeEnforced(this.active, this.baseline);
  }

  status(): PolicyState {
    return this.state;
  }
}

/** Build a PolicyGate bound to a db (helper for assembly). */
export function buildPolicyGate(_db: Database, store: PolicyStore, baseline: LocalBaseline): PolicyGate {
  return new PolicyGate(store, baseline);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/policy/policy-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bunx biome check packages/gateway/src/policy/
cd packages/gateway && bun run typecheck && cd ../..
git add packages/gateway/src/policy/policy-gate.ts packages/gateway/src/policy/policy-gate.test.ts
git commit -m "feat(policy): PolicyGate + EnforcedPolicy (monotonic-stricter, fail-closed)"
```

---

### Task 5: Invariant I22 — security test + static D16 + vault key allow-list

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts` (add I22 cases)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (add `policy.signing.privkey` to `VAULT_KEY_ALLOW_LIST`; add D16 check)
- Modify: `docs/SECURITY-INVARIANTS.md` (new I22 row) — **same commit (triple rule)**
- Modify: `CLAUDE.md` + `GEMINI.md` (I22 line; bump "I1–I21" → "I1–I22")

- [ ] **Step 1: Write the failing I22 test**

```typescript
// security-invariants.test.ts — append
import { generateEd25519Keypair } from "@nimbus-dev/sdk";
import { Database } from "bun:sqlite";
import { runIndexedSchemaMigrations } from "./index/migrations/runner.ts";
import { PolicyStore } from "./policy/policy-store.ts";
import { PolicyGate, type LocalBaseline } from "./policy/policy-gate.ts";
import { signPolicy } from "./policy/policy-signing.ts";

describe("I22 — org policy applied only from a signature-verified bundle, monotonic-stricter", () => {
  const baseline: LocalBaseline = { retentionDays: 7, hitlRequired: new Set(["git.force_push_main"]), quorum: new Map() };

  function gateWith(toml: string, sig: string, pubkey: string): PolicyGate {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(pubkey, "manual", 1);
    store.persist({ toml, sig, org: "acme", version: 1, source: "peer", fetchedAt: 1 });
    return new PolicyGate(store, baseline);
  }

  test("(a) a tampered policy is rejected; the gate stays ungoverned (falls back to baseline)", () => {
    const kp = generateEd25519Keypair();
    const good = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(good, kp.secretKey);
    const tampered = good.replace("min_days=30", "min_days=99");
    const gate = gateWith(tampered, sig, kp.publicKey);
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7); // baseline, NOT 99
  });

  test("(b) a valid policy below baseline cannot weaken HITL/quorum/retention", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=3\n[policy.hitl]\nrequire=[]\n`;
    const gate = gateWith(toml, signPolicy(toml, kp.secretKey), kp.publicKey);
    expect(gate.enforced().retentionDays).toBe(7);
    expect(gate.enforced().hitlRequired.has("git.force_push_main")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes after Task 4 modules exist**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t I22`
Expected: PASS (both cases) — the modules already exist from Tasks 2–4. (If red, fix the gate, not the test.)

- [ ] **Step 3: Add the vault key + D16 static check** in `scripts/structure-audit/check-nimbus-invariants.ts`

```typescript
// In VAULT_KEY_ALLOW_LIST (near line 196), add:
  "policy.signing.privkey",
  "policy.signing.pubkey",
```

Add a D16 check: assert that outside `packages/gateway/src/policy/`, no non-test file imports `policy-toml.ts`'s `parsePolicyToml` for enforcement (enforcement must go through `policy-gate.ts`). Follow the existing D13/D15 check shape (a directory scan with an `ALLOWED` carve-out = `packages/gateway/src/policy/policy-gate.ts`).

- [ ] **Step 4: Add the I22 row to `docs/SECURITY-INVARIANTS.md`** (mirror the I21 row's structure: production wiring site, rationale, anti-patterns, the static D16 complement).

- [ ] **Step 5: Update `CLAUDE.md` + `GEMINI.md`** — add the I22 bullet (copy the wording from the spec §10), and the static-complement line `… D15, **D16**`. Bump the See-Also "I1–I21" → "I1–I22".

- [ ] **Step 6: Run the static audit + I22 test**

Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts` (or the script's package alias — check `package.json`)
Expected: passes (no D16 violations; vault key recognized).
Run: `bun test packages/gateway/src/security-invariants.test.ts -t I22`
Expected: PASS.

- [ ] **Step 7: Commit (triple rule — wiring already landed Tasks 2–4; here: test + docs + static)**

```bash
bunx biome check packages/gateway/src scripts/structure-audit
git add packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(policy): invariant I22 (signed policy + monotonic-stricter) + static D16"
```

---

## Lane B — Enforcement

> Lane B depends on Lane A (`policy-gate.ts`). Each site reads `EnforcedPolicy`, never the raw policy.

### Task 6: Profile resolver (policy × Phase 3.5 profile, monotonic-stricter)

**Files:**
- Create: `packages/gateway/src/policy/profile-resolver.ts`
- Test: `packages/gateway/src/policy/profile-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// profile-resolver.test.ts
import { describe, expect, test } from "bun:test";
import { resolveEffectiveConfig, type ProfileConfig } from "./profile-resolver.ts";
import type { EnforcedPolicy } from "./policy-gate.ts";

const policy: EnforcedPolicy = {
  connectorAllow: ["github", "slack", "jira"],
  retentionDays: 30,
  hitlRequired: new Set(["db.drop"]),
  quorum: new Map(),
};

describe("resolveEffectiveConfig", () => {
  test("connectors = profile ∩ policy.allow (profile cannot add a forbidden connector)", () => {
    const profile: ProfileConfig = { enabledConnectors: ["github", "notion"], retentionDays: 90 };
    expect(resolveEffectiveConfig(profile, policy).enabledConnectors).toEqual(["github"]);
  });

  test("retention = max(profile, policy)", () => {
    expect(resolveEffectiveConfig({ enabledConnectors: [], retentionDays: 90 }, policy).retentionDays).toBe(90);
    expect(resolveEffectiveConfig({ enabledConnectors: [], retentionDays: 10 }, policy).retentionDays).toBe(30);
  });

  test("policy.connectorAllow undefined => profile passes through unbounded", () => {
    const e = resolveEffectiveConfig({ enabledConnectors: ["x", "y"], retentionDays: 5 }, { ...policy, connectorAllow: undefined });
    expect(e.enabledConnectors).toEqual(["x", "y"]);
  });
});
```

- [ ] **Step 2: Run test → FAIL.** `bun test packages/gateway/src/policy/profile-resolver.test.ts`

- [ ] **Step 3: Write `profile-resolver.ts`**

```typescript
// profile-resolver.ts
import type { EnforcedPolicy } from "./policy-gate.ts";

export interface ProfileConfig {
  readonly enabledConnectors: readonly string[];
  readonly retentionDays: number;
}

export interface EffectiveConfig {
  readonly enabledConnectors: readonly string[];
  readonly retentionDays: number;
}

/** Policy is a hard outer bound; profile may be stricter, never looser (spec §5.1). */
export function resolveEffectiveConfig(profile: ProfileConfig, policy: EnforcedPolicy): EffectiveConfig {
  const allow = policy.connectorAllow;
  const enabledConnectors =
    allow === undefined ? profile.enabledConnectors : profile.enabledConnectors.filter((c) => allow.includes(c));
  return {
    enabledConnectors,
    retentionDays: Math.max(profile.retentionDays, policy.retentionDays),
  };
}
```

- [ ] **Step 4: Run test → PASS.** Then lint + commit.

```bash
bunx biome check packages/gateway/src/policy/profile-resolver.ts packages/gateway/src/policy/profile-resolver.test.ts
git add packages/gateway/src/policy/profile-resolver.ts packages/gateway/src/policy/profile-resolver.test.ts
git commit -m "feat(policy): profile×policy resolver (policy clamps profile, monotonic)"
```

---

### Task 7: Connector allowlist enforced before the mesh starts

**Files:**
- Create: `packages/gateway/src/policy/connector-allowlist.ts`
- Test: `packages/gateway/src/policy/connector-allowlist.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (gate connector registration on the allowlist)

- [ ] **Step 1: Read `platform/assemble.ts`** and find where connector ids are collected/registered/spawned (the list the mesh iterates). You will filter that list. Note the exact variable name and the `appendAuditEntry` import.

- [ ] **Step 2: Write the failing pure-filter test**

```typescript
// connector-allowlist.test.ts
import { describe, expect, test } from "bun:test";
import { partitionByAllowlist } from "./connector-allowlist.ts";

describe("partitionByAllowlist", () => {
  test("undefined allow => everything permitted, nothing blocked", () => {
    const r = partitionByAllowlist(["github", "slack"], undefined);
    expect(r.permitted).toEqual(["github", "slack"]);
    expect(r.blocked).toEqual([]);
  });

  test("only allowlisted ids are permitted; the rest are blocked", () => {
    const r = partitionByAllowlist(["github", "slack", "jira"], ["github"]);
    expect(r.permitted).toEqual(["github"]);
    expect(r.blocked).toEqual(["slack", "jira"]);
  });
});
```

- [ ] **Step 3: Run → FAIL.** `bun test packages/gateway/src/policy/connector-allowlist.test.ts`

- [ ] **Step 4: Write `connector-allowlist.ts`**

```typescript
// connector-allowlist.ts
export interface AllowlistPartition {
  readonly permitted: readonly string[];
  readonly blocked: readonly string[];
}

/** Split configured connector ids by the policy allowlist. undefined allow = unrestricted. */
export function partitionByAllowlist(
  configured: readonly string[],
  allow: readonly string[] | undefined,
): AllowlistPartition {
  if (allow === undefined) return { permitted: configured, blocked: [] };
  const permitted: string[] = [];
  const blocked: string[] = [];
  for (const id of configured) (allow.includes(id) ? permitted : blocked).push(id);
  return { permitted, blocked };
}
```

- [ ] **Step 5: Wire into `assemble.ts`** — before the mesh starts, filter the configured connector list:

```typescript
import { partitionByAllowlist } from "../policy/connector-allowlist.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
// ... after the PolicyGate is built and BEFORE connectors are registered/spawned:
const { permitted, blocked } = partitionByAllowlist(configuredConnectorIds, policyGate.enforced().connectorAllow);
for (const id of blocked) {
  appendAuditEntry(db, {
    actionType: "policy.connector.blocked",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ connector: id }),
    timestamp: Date.now(),
  });
}
// use `permitted` (not the raw list) as the set of connectors the mesh starts
```

> Match the real variable names in `assemble.ts`. The audit `timestamp` may use the assembly clock if one is injected.

- [ ] **Step 6: Run the filter test → PASS.** Typecheck the gateway.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bun test packages/gateway/src/policy/connector-allowlist.test.ts
```

- [ ] **Step 7: Lint + commit**

```bash
bunx biome check packages/gateway/src/policy packages/gateway/src/platform/assemble.ts
git add packages/gateway/src/policy/connector-allowlist.ts packages/gateway/src/policy/connector-allowlist.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(policy): connector allowlist enforced before mesh start (audited)"
```

---

### Task 8: Retention floor

**Files:**
- Modify: `packages/gateway/src/db/tool-call-log-retention.ts` (accept a floor; effective = max)
- Modify: `packages/gateway/src/platform/assemble.ts` (pass `policyGate.enforced().retentionDays`)
- Test: `packages/gateway/src/db/tool-call-log-retention.test.ts` (add a floor case)

- [ ] **Step 1: Add the failing test** (append to the existing retention test file)

```typescript
test("policy floor lengthens retention: effective = max(local, floor)", () => {
  const db = makeDbWithToolCallLog(); // existing helper in this test file
  // local config says 7 days, policy floor says 30 -> rows in the 8-30 day window must be KEPT
  insertToolCall(db, { calledAt: Date.now() - 20 * 86_400_000 }); // 20 days old
  pruneToolCallLog(db, { retentionDays: effectiveRetentionDays(7, 30), nowMs: Date.now() });
  expect(countToolCalls(db)).toBe(1); // kept, because effective retention is 30, not 7
});
```

- [ ] **Step 2: Run → FAIL** (`effectiveRetentionDays` undefined). `bun test packages/gateway/src/db/tool-call-log-retention.test.ts`

- [ ] **Step 3: Add `effectiveRetentionDays` to `tool-call-log-retention.ts`**

```typescript
/** Policy retention floor: effective retention is at least the floor (keep longer). */
export function effectiveRetentionDays(localDays: number, policyFloorDays: number): number {
  return Math.max(localDays, policyFloorDays);
}
```

- [ ] **Step 4: Wire it in `assemble.ts`** where `startToolCallLogRetention` is called: pass `effectiveRetentionDays(localConfigDays, policyGate.enforced().retentionDays)`.

- [ ] **Step 5: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/db/tool-call-log-retention.ts packages/gateway/src/platform/assemble.ts
git add packages/gateway/src/db/tool-call-log-retention.ts packages/gateway/src/db/tool-call-log-retention.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(policy): retention floor (effective = max(local, policy floor))"
```

---

### Task 9: HITL / quorum override wiring

**Files:**
- Create: `packages/gateway/src/policy/quorum-override.ts`
- Test: `packages/gateway/src/policy/quorum-override.test.ts`
- Modify: the quorum-size resolution call site (read first — Task 0 located `parseQuorumConfig` consumer + `quorum-coordinator.ts`)

The policy engine is the authoritative quorum home. The effective per-action rule already comes from `EnforcedPolicy.quorum` (Task 4 folded `max(local, policy)`). This task exposes a single resolver the executor/coordinator call.

- [ ] **Step 1: Write the failing test**

```typescript
// quorum-override.test.ts
import { describe, expect, test } from "bun:test";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { resolveQuorumRule } from "./quorum-override.ts";
import type { EnforcedPolicy } from "./policy-gate.ts";

const enforced: EnforcedPolicy = {
  retentionDays: 7,
  hitlRequired: new Set(["db.drop"]),
  quorum: new Map<string, QuorumRule>([["terraform.destroy", { approvers: 2, windowSeconds: 3600 }]]),
};

describe("resolveQuorumRule", () => {
  test("returns the enforced rule for a governed action", () => {
    expect(resolveQuorumRule(enforced, "terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 3600 });
  });
  test("returns undefined for an ungoverned action (no quorum)", () => {
    expect(resolveQuorumRule(enforced, "noop.action")).toBeUndefined();
  });
  test("isHitlRequiredByPolicy reflects the union set", () => {
    expect(enforced.hitlRequired.has("db.drop")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/policy/quorum-override.test.ts`

- [ ] **Step 3: Write `quorum-override.ts`**

```typescript
// quorum-override.ts
import type { QuorumRule } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "./policy-gate.ts";

/** The authoritative quorum rule for an action type, or undefined if none applies. */
export function resolveQuorumRule(enforced: EnforcedPolicy, actionType: string): QuorumRule | undefined {
  return enforced.quorum.get(actionType);
}

/** Whether policy/baseline forces HITL on this action type. */
export function isHitlRequiredByPolicy(enforced: EnforcedPolicy, actionType: string): boolean {
  return enforced.hitlRequired.has(actionType);
}
```

- [ ] **Step 4: Wire the call site.** Where the quorum size was previously read from `parseQuorumConfig`/`nimbus.toml`, source it from `resolveQuorumRule(policyGate.enforced(), actionType)` instead, falling back to the prior local default only when the gate is ungoverned. **Do not change the executor `gate()` HITL frozen-set membership (I2/I3)** — policy only adds/tightens, the structural gate stays.

- [ ] **Step 5: Run → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/policy
git add packages/gateway/src/policy/quorum-override.ts packages/gateway/src/policy/quorum-override.test.ts
git commit -m "feat(policy): authoritative quorum/HITL resolver from EnforcedPolicy"
```

---

## Lane C — Distribution (federation.policy serve/fetch, pinning, sync refetch)

### Task 10: `federation.policy` — anchor serves the signed bundle

**Files:**
- Create: `packages/gateway/src/policy/policy-distribution.ts`
- Test: `packages/gateway/src/policy/policy-distribution.test.ts`
- Modify: `packages/gateway/src/federation/federation-server.ts` (dispatch `federation.policy`)
- Modify: `packages/gateway/src/ipc/lan-server.ts` (admit `federation.policy` in the LAN allow-set)

- [ ] **Step 1: Write the failing serve test**

```typescript
// policy-distribution.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";
import { servePolicy } from "./policy-distribution.ts";

function db36(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

describe("servePolicy (anchor side)", () => {
  test("returns the persisted {toml, sig} for a known policy", () => {
    const db = db36();
    const store = new PolicyStore(db);
    store.persist({ toml: 'org="acme"\n', sig: "S1", org: "acme", version: 1, source: "anchor", fetchedAt: 1 });
    expect(servePolicy(store)).toEqual({ toml: 'org="acme"\n', sig: "S1" });
  });

  test("returns null when the anchor has no policy", () => {
    expect(servePolicy(new PolicyStore(db36()))).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/policy/policy-distribution.test.ts`

- [ ] **Step 3: Write `policy-distribution.ts` (serve half)**

```typescript
// policy-distribution.ts
import type { PolicyStore } from "./policy-store.ts";

/** Wire shape exchanged over federation.policy. */
export interface PolicyBundle {
  readonly toml: string;
  readonly sig: string;
}

/** Anchor side: hand back the persisted signed bundle (public — no secret). */
export function servePolicy(store: PolicyStore): PolicyBundle | null {
  const p = store.load();
  if (p === undefined) return null;
  return { toml: p.toml, sig: p.sig };
}
```

- [ ] **Step 4: Dispatch + allowlist.** In `federation-server.ts` `dispatchFederationRpc`, add a `federation.policy` case returning `servePolicy(ctx.policyStore)` (thread a `policyStore` into `FederationRpcContext`). In `lan-server.ts`, add `federation.policy` to the admitted LAN methods (read-only, like `federation.query`).

- [ ] **Step 5: Run serve test → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/policy packages/gateway/src/federation/federation-server.ts packages/gateway/src/ipc/lan-server.ts
git add packages/gateway/src/policy/policy-distribution.ts packages/gateway/src/policy/policy-distribution.test.ts packages/gateway/src/federation/federation-server.ts packages/gateway/src/ipc/lan-server.ts
git commit -m "feat(policy): federation.policy — anchor serves the signed bundle"
```

---

### Task 11: Peer fetch → verify → persist → re-enforce (`policy-runtime`)

**Files:**
- Create: `packages/gateway/src/policy/policy-runtime.ts`
- Test: `packages/gateway/src/policy/policy-runtime.test.ts`

- [ ] **Step 1: Write the failing refresh test** (uses an injected fetch fn so no real LAN)

```typescript
// policy-runtime.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";
import { PolicyGate, type LocalBaseline } from "./policy-gate.ts";
import { signPolicy } from "./policy-signing.ts";
import { refreshPolicy } from "./policy-runtime.ts";

const baseline: LocalBaseline = { retentionDays: 7, hitlRequired: new Set(), quorum: new Map() };

function setup() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  const store = new PolicyStore(db);
  const gate = new PolicyGate(store, baseline);
  return { db, store, gate };
}

describe("refreshPolicy (peer side)", () => {
  test("a validly-signed fetched policy is persisted and applied", async () => {
    const kp = generateEd25519Keypair();
    const { store, gate } = setup();
    store.pinAnchorPubkey(kp.publicKey, "manual", 1);
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const out = await refreshPolicy({
      store,
      gate,
      pinnedPubkey: kp.publicKey,
      nowMs: 1000,
      fetch: async () => ({ toml, sig: signPolicy(toml, kp.secretKey) }),
    });
    expect(out.applied).toBe(true);
    expect(gate.enforced().retentionDays).toBe(30);
    expect(gate.status().version).toBe(2);
  });

  test("a tampered fetched policy is rejected; the prior enforced view is unchanged", async () => {
    const kp = generateEd25519Keypair();
    const { store, gate } = setup();
    store.pinAnchorPubkey(kp.publicKey, "manual", 1);
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(toml, kp.secretKey);
    const out = await refreshPolicy({
      store,
      gate,
      pinnedPubkey: kp.publicKey,
      nowMs: 1000,
      fetch: async () => ({ toml: toml.replace("30", "99"), sig }),
    });
    expect(out.applied).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7); // baseline, not 99
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/policy/policy-runtime.test.ts`

- [ ] **Step 3: Write `policy-runtime.ts`**

```typescript
// policy-runtime.ts
import { verifyCandidate, type PolicyGate } from "./policy-gate.ts";
import type { PolicyBundle } from "./policy-distribution.ts";
import type { PolicyStore } from "./policy-store.ts";

export interface RefreshDeps {
  readonly store: PolicyStore;
  readonly gate: PolicyGate;
  readonly pinnedPubkey: string;
  readonly nowMs: number;
  readonly fetch: () => Promise<PolicyBundle | null>;
  readonly onConnectorAllowChanged?: () => void; // marks pendingRestart
}

export interface RefreshOutcome {
  readonly applied: boolean;
  readonly reason?: "no_bundle" | "bad_signature" | "unchanged";
}

/** Peer refresh: fetch → verify → persist → re-enforce. Fail-closed on bad sig. */
export async function refreshPolicy(deps: RefreshDeps): Promise<RefreshOutcome> {
  const bundle = await deps.fetch();
  if (bundle === null) return { applied: false, reason: "no_bundle" };
  const parsed = verifyCandidate(bundle.toml, bundle.sig, deps.pinnedPubkey);
  if (parsed === null) return { applied: false, reason: "bad_signature" }; // keep last-valid

  const prev = deps.store.load();
  const prevAllow = JSON.stringify(prev === undefined ? null : prev.toml);
  const pendingRestart = prevAllow !== JSON.stringify(bundle.toml) && deps.onConnectorAllowChanged !== undefined;

  const persisted = {
    toml: bundle.toml,
    sig: bundle.sig,
    org: parsed.org,
    version: parsed.version,
    ...(parsed.issuedAt === undefined ? {} : { issuedAt: parsed.issuedAt }),
    fetchedAt: deps.nowMs,
    source: "peer" as const,
  };
  deps.store.persist(persisted);
  deps.gate.applyVerified(parsed, persisted, pendingRestart);
  if (pendingRestart) deps.onConnectorAllowChanged?.();
  return { applied: true };
}
```

> The audit `policy.applied` entry (spec §4.4) is emitted by the caller in `assemble.ts`/sync wiring, where the `db` handle lives. Keep `refreshPolicy` pure of audit so it stays unit-testable; add the `appendAuditEntry` call at the sync call site.

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/policy
git add packages/gateway/src/policy/policy-runtime.ts packages/gateway/src/policy/policy-runtime.test.ts
git commit -m "feat(policy): peer refresh — fetch/verify/persist/re-enforce (fail-closed)"
```

---

### Task 12: Pubkey pinning at pair-approval + `policy.trust` manual fallback

**Files:**
- Modify: the pair-approval path (read `federation/peer-pairing.ts` — find where an approved peer's claims are recorded) to pin the anchor policy pubkey when the handshake carries one.
- Create: `packages/gateway/src/policy/policy-trust.ts` (manual pin)
- Test: `packages/gateway/src/policy/policy-trust.test.ts`

- [ ] **Step 1: Write the failing manual-pin test**

```typescript
// policy-trust.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";
import { trustAnchorPubkey } from "./policy-trust.ts";

describe("trustAnchorPubkey", () => {
  test("validates base64 length and pins", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    const pubkey = "A".repeat(44); // 32-byte key base64 ≈ 44 chars
    trustAnchorPubkey(store, pubkey, 5);
    expect(store.getAnchorPubkey()).toBe(pubkey);
  });

  test("rejects an obviously malformed key", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    expect(() => trustAnchorPubkey(new PolicyStore(db), "nope", 5)).toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/policy/policy-trust.test.ts`

- [ ] **Step 3: Write `policy-trust.ts`**

```typescript
// policy-trust.ts
import { decodeBase64 } from "@nimbus-dev/sdk";
import type { PolicyStore } from "./policy-store.ts";

/** Manually pin an org policy pubkey (the `nimbus policy trust` fallback). */
export function trustAnchorPubkey(store: PolicyStore, pubkeyB64: string, nowMs: number): void {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(pubkeyB64);
  } catch {
    throw new Error("policy trust: pubkey is not valid base64");
  }
  if (bytes.length !== 32) throw new Error("policy trust: Ed25519 pubkey must be 32 bytes");
  store.pinAnchorPubkey(pubkeyB64, "manual", nowMs);
}
```

- [ ] **Step 4: Wire pairing pin.** In the pair-approval path, when the inbound handshake includes a policy pubkey claim, call `store.pinAnchorPubkey(claim, "pairing", now)`. Reuse the Slice 3 signed-claim pattern (`federation-identity.ts`). If the handshake carries none, leave unpinned (peer stays ungoverned until `nimbus policy trust`).

- [ ] **Step 5: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/policy packages/gateway/src/federation/peer-pairing.ts
git add packages/gateway/src/policy/policy-trust.ts packages/gateway/src/policy/policy-trust.test.ts packages/gateway/src/federation/peer-pairing.ts
git commit -m "feat(policy): pin anchor pubkey at pairing + nimbus policy trust fallback"
```

---

## Lane D — Observability

### Task 13: `GatewayStatus` snapshot builder

**Files:**
- Create: `packages/gateway/src/status/types.ts`
- Create: `packages/gateway/src/status/gateway-status.ts`
- Test: `packages/gateway/src/status/gateway-status.test.ts`

The snapshot is built from injected reader functions so it unit-tests without a live mesh.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway-status.test.ts
import { describe, expect, test } from "bun:test";
import { buildGatewayStatus, type StatusInputs } from "./gateway-status.ts";

const inputs: StatusInputs = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [{ peerId: "peer:aa", reachable: true, lastSeenMs: 100 }],
  connectors: [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok", lastSyncMs: 50 }],
  namespaces: [{ name: "project:zurich", subscribers: 2, lastPropagateMs: 10 }],
  audit: { chainLength: 8431, lastHash: "ab", appendRate1h: 12 },
  hitl: { pendingApprovals: 2, pendingQuorum: 1 },
  identity: { operatorValid: true, externalId: "alice@acme" },
  syncFreshnessMs: 30000,
};

describe("buildGatewayStatus", () => {
  test("assembles the snapshot verbatim from inputs", () => {
    const s = buildGatewayStatus(inputs);
    expect(s.policy.org).toBe("acme");
    expect(s.connectors[0]?.blockedByPolicy).toBe(false);
    expect(s.audit.chainLength).toBe(8431);
    expect(s.hitl.pendingApprovals).toBe(2);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/status/gateway-status.test.ts`

- [ ] **Step 3: Write `types.ts` + `gateway-status.ts`**

```typescript
// types.ts
import type { PolicyState } from "../policy/types.ts";

export interface PeerStatus { peerId: string; reachable: boolean; lastSeenMs?: number }
export interface ConnectorStatus { id: string; enabled: boolean; blockedByPolicy: boolean; health: string; lastSyncMs?: number }
export interface NamespaceStatus { name: string; subscribers: number; lastPropagateMs?: number }
export interface AuditStatus { chainLength: number; lastHash: string; appendRate1h: number }
export interface HitlStatusCounts { pendingApprovals: number; pendingQuorum: number }
export interface IdentityStatus { operatorValid: boolean; externalId?: string }

export interface GatewayStatus {
  policy: PolicyState;
  peers: PeerStatus[];
  connectors: ConnectorStatus[];
  namespaces: NamespaceStatus[];
  audit: AuditStatus;
  hitl: HitlStatusCounts;
  identity: IdentityStatus;
  syncFreshnessMs: number;
}
```

```typescript
// gateway-status.ts
import type {
  AuditStatus, ConnectorStatus, GatewayStatus, HitlStatusCounts,
  IdentityStatus, NamespaceStatus, PeerStatus,
} from "./types.ts";
import type { PolicyState } from "../policy/types.ts";

export interface StatusInputs {
  policy: PolicyState;
  peers: PeerStatus[];
  connectors: ConnectorStatus[];
  namespaces: NamespaceStatus[];
  audit: AuditStatus;
  hitl: HitlStatusCounts;
  identity: IdentityStatus;
  syncFreshnessMs: number;
}

/** Pure assembler. Real readers are wired at the call site (Task 15). */
export function buildGatewayStatus(i: StatusInputs): GatewayStatus {
  return {
    policy: i.policy, peers: i.peers, connectors: i.connectors, namespaces: i.namespaces,
    audit: i.audit, hitl: i.hitl, identity: i.identity, syncFreshnessMs: i.syncFreshnessMs,
  };
}
```

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/status
git add packages/gateway/src/status/types.ts packages/gateway/src/status/gateway-status.ts packages/gateway/src/status/gateway-status.test.ts
git commit -m "feat(status): GatewayStatus snapshot builder"
```

---

### Task 14: Prometheus text exposition

**Files:**
- Create: `packages/gateway/src/status/prometheus-format.ts`
- Test: `packages/gateway/src/status/prometheus-format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// prometheus-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatPrometheus } from "./prometheus-format.ts";
import type { GatewayStatus } from "./types.ts";

const status: GatewayStatus = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [{ peerId: "peer:aa", reachable: true }, { peerId: "peer:bb", reachable: false }],
  connectors: [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: [],
  audit: { chainLength: 42, lastHash: "x", appendRate1h: 3 },
  hitl: { pendingApprovals: 2, pendingQuorum: 1 },
  identity: { operatorValid: true },
  syncFreshnessMs: 1000,
};

describe("formatPrometheus", () => {
  test("emits HELP/TYPE + labeled samples", () => {
    const out = formatPrometheus(status);
    expect(out).toContain("# TYPE nimbus_policy_signature_valid gauge");
    expect(out).toContain("nimbus_policy_signature_valid 1");
    expect(out).toContain('nimbus_peer_reachable{peer="peer:aa"} 1');
    expect(out).toContain('nimbus_peer_reachable{peer="peer:bb"} 0');
    expect(out).toContain("nimbus_audit_chain_length 42");
    expect(out).toContain("nimbus_hitl_pending 3"); // approvals + quorum
    expect(out.endsWith("\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/gateway/src/status/prometheus-format.test.ts`

- [ ] **Step 3: Write `prometheus-format.ts`**

```typescript
// prometheus-format.ts
import type { GatewayStatus } from "./types.ts";

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Render a GatewayStatus as Prometheus text exposition (v0.0.4). */
export function formatPrometheus(s: GatewayStatus): string {
  const L: string[] = [];
  const gauge = (name: string, help: string) => {
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  };

  gauge("nimbus_policy_signature_valid", "1 if the active org policy signature is valid");
  L.push(`nimbus_policy_signature_valid ${s.policy.signatureValid ? 1 : 0}`);

  gauge("nimbus_peer_reachable", "1 if a federated peer is reachable");
  for (const p of s.peers) L.push(`nimbus_peer_reachable{peer="${esc(p.peerId)}"} ${p.reachable ? 1 : 0}`);

  gauge("nimbus_connector_enabled", "1 if a connector is enabled (not blocked by policy)");
  for (const c of s.connectors) L.push(`nimbus_connector_enabled{connector="${esc(c.id)}"} ${c.enabled && !c.blockedByPolicy ? 1 : 0}`);

  gauge("nimbus_audit_chain_length", "number of entries in the local audit chain");
  L.push(`nimbus_audit_chain_length ${s.audit.chainLength}`);

  gauge("nimbus_hitl_pending", "pending HITL approvals + quorum requests");
  L.push(`nimbus_hitl_pending ${s.hitl.pendingApprovals + s.hitl.pendingQuorum}`);

  gauge("nimbus_sync_freshness_ms", "ms since the last successful sync");
  L.push(`nimbus_sync_freshness_ms ${s.syncFreshnessMs}`);

  return `${L.join("\n")}\n`;
}
```

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/status
git add packages/gateway/src/status/prometheus-format.ts packages/gateway/src/status/prometheus-format.test.ts
git commit -m "feat(status): Prometheus /metrics text exposition"
```

---

### Task 15: HTTP `/v1/admin/status` + `/metrics` (bearer) + `admin.status` IPC

**Files:**
- Modify: `packages/gateway/src/ipc/http-server.ts` (routes; reuse `http-auth` bearer)
- Create: `packages/gateway/src/ipc/admin-status-rpc.ts` (assemble real `StatusInputs` from stores)
- Test: `packages/gateway/src/ipc/admin-status-rpc.test.ts`
- Modify: the IPC dispatcher to register `admin.status` (read `ipc/server/dispatchers.ts`-style location; see `nimbus-ipc` skill)

- [ ] **Step 1: Read `http-server.ts`** — note the request-routing shape (`url.pathname` checks returning `Response`) and how `dispatchMetricsRpc`/SCIM auth gate. Reuse the bearer-compare from `http-auth.ts` for the two new read routes.

- [ ] **Step 2: Write the failing assembler test**

```typescript
// admin-status-rpc.test.ts
import { describe, expect, test } from "bun:test";
import { assembleStatusInputs, type StatusReaders } from "./admin-status-rpc.ts";

const readers: StatusReaders = {
  policyState: () => ({ org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" }),
  peers: () => [{ peerId: "peer:aa", reachable: true }],
  connectors: () => [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: () => [],
  audit: () => ({ chainLength: 1, lastHash: "h", appendRate1h: 0 }),
  hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
  identity: () => ({ operatorValid: true }),
  syncFreshnessMs: () => 0,
};

describe("assembleStatusInputs", () => {
  test("pulls each field from its reader", () => {
    const i = assembleStatusInputs(readers);
    expect(i.policy.org).toBe("acme");
    expect(i.peers[0]?.peerId).toBe("peer:aa");
  });
});
```

- [ ] **Step 3: Run → FAIL.** Then write `admin-status-rpc.ts`:

```typescript
// admin-status-rpc.ts
import { buildGatewayStatus } from "../status/gateway-status.ts";
import type { GatewayStatus } from "../status/types.ts";
import type { PolicyState } from "../policy/types.ts";
import type {
  AuditStatus, ConnectorStatus, HitlStatusCounts, IdentityStatus, NamespaceStatus, PeerStatus,
} from "../status/types.ts";

export interface StatusReaders {
  policyState: () => PolicyState;
  peers: () => PeerStatus[];
  connectors: () => ConnectorStatus[];
  namespaces: () => NamespaceStatus[];
  audit: () => AuditStatus;
  hitl: () => HitlStatusCounts;
  identity: () => IdentityStatus;
  syncFreshnessMs: () => number;
}

export function assembleStatusInputs(r: StatusReaders) {
  return {
    policy: r.policyState(), peers: r.peers(), connectors: r.connectors(),
    namespaces: r.namespaces(), audit: r.audit(), hitl: r.hitl(),
    identity: r.identity(), syncFreshnessMs: r.syncFreshnessMs(),
  };
}

export function buildStatus(r: StatusReaders): GatewayStatus {
  return buildGatewayStatus(assembleStatusInputs(r));
}
```

- [ ] **Step 4: Add the HTTP routes** in `http-server.ts` (bearer-gated, GET-only):

```typescript
// inside the router, before the 404 fallback:
if (url.pathname === "/v1/admin/status" && req.method === "GET") {
  if (!bearerOk(req)) return json({ error: "unauthorized" }, 401);
  return json({ data: buildStatus(statusReaders) });
}
if (url.pathname === "/metrics" && req.method === "GET") {
  if (!bearerOk(req)) return new Response("unauthorized", { status: 401 });
  return new Response(formatPrometheus(buildStatus(statusReaders)), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
```

> `bearerOk(req)` reuses the constant-time compare in `http-auth.ts` (I10/I13). `statusReaders` is threaded into the server options from assembly.

- [ ] **Step 5: Register `admin.status` IPC** in the dispatcher (returns `buildStatus(...)`). Follow the `nimbus-ipc` skill's "add a method" checklist.

- [ ] **Step 6: Run the assembler test → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/ipc/admin-status-rpc.ts packages/gateway/src/ipc/http-server.ts
git add packages/gateway/src/ipc/admin-status-rpc.ts packages/gateway/src/ipc/admin-status-rpc.test.ts packages/gateway/src/ipc/http-server.ts
git commit -m "feat(observability): /v1/admin/status + bearer-gated /metrics + admin.status IPC"
```

---

## Lane E — Admin Console (`packages/admin-console`)

### Task 16: Console package scaffold + `bun build` + pure render functions

**Files:**
- Create: `packages/admin-console/package.json`
- Create: `packages/admin-console/tsconfig.json`
- Create: `packages/admin-console/index.html`
- Create: `packages/admin-console/src/render.ts` (pure view→HTML-string functions)
- Create: `packages/admin-console/src/styles.css`
- Test: `packages/admin-console/src/render.test.ts`

- [ ] **Step 1: Scaffold `package.json`** (AGPL leaf; no runtime deps)

```json
{
  "name": "@nimbus-dev/admin-console",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "scripts": {
    "build": "bun build src/main.ts --outdir dist --minify && bun run copy:static",
    "copy:static": "bun -e \"import {cpSync} from 'node:fs';cpSync('index.html','dist/index.html');cpSync('src/styles.css','dist/styles.css')\"",
    "typecheck": "tsc --noEmit",
    "test": "bun test src"
  },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

> Add `packages/admin-console` to the root workspace `build` fan-out (read root `package.json` scripts; the gateway build/package step must run this `build` first). Add `packages/admin-console/dist/` to `.gitignore`.

- [ ] **Step 2: Write the failing render test**

```typescript
// render.test.ts
import { describe, expect, test } from "bun:test";
import { renderOverview, renderPolicyBanner } from "./render.ts";
import type { GatewayStatus } from "./render.ts";

const status: GatewayStatus = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [{ peerId: "peer:aa", reachable: true }],
  connectors: [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }, { id: "slack", enabled: false, blockedByPolicy: true, health: "ok" }],
  namespaces: [], audit: { chainLength: 9, lastHash: "h", appendRate1h: 1 },
  hitl: { pendingApprovals: 2, pendingQuorum: 0 }, identity: { operatorValid: true }, syncFreshnessMs: 30000,
};

describe("render", () => {
  test("overview shows peer + connector-blocked counts and escapes text", () => {
    const html = renderOverview(status);
    expect(html).toContain("1/1"); // peers reachable
    expect(html).toContain("1 blocked"); // slack blocked by policy
    expect(html).toContain("2"); // hitl pending
  });
  test("policy banner flags ungoverned", () => {
    expect(renderPolicyBanner({ ...status.policy, source: "none", signatureValid: false })).toContain("ungoverned");
    expect(renderPolicyBanner(status.policy)).toContain("acme");
  });
});
```

- [ ] **Step 3: Run → FAIL.** `bun test packages/admin-console/src/render.test.ts`

- [ ] **Step 4: Write `render.ts`** (pure, no DOM). Re-declare the wire types locally (the console is a separate leaf and must not import gateway source).

```typescript
// render.ts
export interface PolicyState { org?: string; version?: number; signatureValid: boolean; pendingRestart: boolean; source: "anchor" | "peer" | "none" }
export interface GatewayStatus {
  policy: PolicyState;
  peers: { peerId: string; reachable: boolean }[];
  connectors: { id: string; enabled: boolean; blockedByPolicy: boolean; health: string }[];
  namespaces: { name: string; subscribers: number }[];
  audit: { chainLength: number; lastHash: string; appendRate1h: number };
  hitl: { pendingApprovals: number; pendingQuorum: number };
  identity: { operatorValid: boolean; externalId?: string };
  syncFreshnessMs: number;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPolicyBanner(p: PolicyState): string {
  if (p.source === "none" || !p.signatureValid) {
    return `<div class="banner banner-warn">⚠ ungoverned — no valid org policy applied</div>`;
  }
  const restart = p.pendingRestart ? ' · <span class="warn">restart pending</span>' : "";
  return `<div class="banner">policy <b>${esc(p.org ?? "")}</b> v${p.version ?? 0} ✓ signed${restart}</div>`;
}

export function renderOverview(s: GatewayStatus): string {
  const reachable = s.peers.filter((p) => p.reachable).length;
  const blocked = s.connectors.filter((c) => c.blockedByPolicy).length;
  const card = (label: string, value: string) => `<div class="card"><div class="card-v">${esc(value)}</div><div class="card-l">${esc(label)}</div></div>`;
  return [
    renderPolicyBanner(s.policy),
    `<div class="cards">`,
    card("peers reachable", `${reachable}/${s.peers.length}`),
    card("connectors", `${s.connectors.length} (${blocked} blocked)`),
    card("audit chain", `${s.audit.chainLength}`),
    card("HITL pending", `${s.hitl.pendingApprovals + s.hitl.pendingQuorum}`),
    card("sync age", `${Math.round(s.syncFreshnessMs / 1000)}s`),
    card("operator", s.identity.operatorValid ? "valid ✓" : "invalid ✗"),
    `</div>`,
  ].join("");
}
```

- [ ] **Step 5: Run → PASS.** Add `index.html` (mount point + sidebar shell + `<script type="module" src="./main.ts">` — `main.ts` comes in Task 18) and a minimal `styles.css`. Build:

```bash
cd packages/admin-console && bun install && bun run typecheck && cd ../..
bun test packages/admin-console/src/render.test.ts
```

- [ ] **Step 6: Lint + commit**

```bash
bunx biome check packages/admin-console/src
git add packages/admin-console/ .gitignore
git commit -m "feat(admin-console): scaffold + bun build + pure render functions"
```

---

### Task 17: Gateway serves `/admin/*` with runtime asset resolution + 503-when-unbuilt

**Files:**
- Create: `packages/gateway/src/ipc/admin-console-assets.ts`
- Test: `packages/gateway/src/ipc/admin-console-assets.test.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (serve `/admin/*`)

- [ ] **Step 1: Write the failing resolver test**

```typescript
// admin-console-assets.test.ts
import { describe, expect, test } from "bun:test";
import { contentTypeFor, safeAssetPath } from "./admin-console-assets.ts";

describe("admin-console-assets", () => {
  test("maps extensions to content types", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("main.js")).toContain("javascript");
    expect(contentTypeFor("styles.css")).toContain("text/css");
  });
  test("rejects path traversal", () => {
    expect(safeAssetPath("/admin/../../etc/passwd")).toBeUndefined();
    expect(safeAssetPath("/admin/main.js")).toBe("main.js");
    expect(safeAssetPath("/admin")).toBe("index.html");
    expect(safeAssetPath("/admin/")).toBe("index.html");
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `admin-console-assets.ts`:

```typescript
// admin-console-assets.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  const ext = file.split(".").pop() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Translate a /admin/* request path to a relative asset name; reject traversal. */
export function safeAssetPath(pathname: string): string | undefined {
  let rel = pathname.replace(/^\/admin\/?/, "");
  if (rel === "") rel = "index.html";
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) return undefined;
  return rel;
}

/** Resolve the built console dist root. Returns undefined if not built. */
export function resolveConsoleDist(baseDir: string): string | undefined {
  const dist = join(baseDir, "..", "admin-console", "dist"); // packages/gateway -> packages/admin-console/dist
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}
```

- [ ] **Step 3: Serve `/admin/*` in `http-server.ts`**

```typescript
import { contentTypeFor, resolveConsoleDist, safeAssetPath } from "./admin-console-assets.ts";
// ...
if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
  if (!bearerOk(req)) return new Response("unauthorized", { status: 401 });
  const dist = resolveConsoleDist(import.meta.dir);
  if (dist === undefined) return new Response("admin console not built — run `bun run build`", { status: 503 });
  const rel = safeAssetPath(url.pathname);
  if (rel === undefined) return new Response("bad path", { status: 400 });
  const file = Bun.file(join(dist, rel));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "content-type": contentTypeFor(rel) } });
}
```

> Confirm `import.meta.dir` resolves to `packages/gateway/src/ipc` at runtime; adjust the `..` depth in `resolveConsoleDist` to reach `packages/admin-console/dist`. In a packaged release, point at the shipped assets root instead (a `NIMBUS_ADMIN_CONSOLE_DIST` override env is acceptable).

- [ ] **Step 4: Run → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/ipc/admin-console-assets.ts packages/gateway/src/ipc/http-server.ts
git add packages/gateway/src/ipc/admin-console-assets.ts packages/gateway/src/ipc/admin-console-assets.test.ts packages/gateway/src/ipc/http-server.ts
git commit -m "feat(admin-console): gateway serves /admin/* (bearer, 503-when-unbuilt, no traversal)"
```

---

### Task 18: Console client — fetch + mount + the 6 views + policy editor

**Files:**
- Create: `packages/admin-console/src/client.ts` (typed fetch wrapper with bearer)
- Create: `packages/admin-console/src/main.ts` (DOM mount + sidebar routing)
- Create: `packages/admin-console/src/views.ts` (the remaining 5 render functions)
- Test: `packages/admin-console/src/views.test.ts`

- [ ] **Step 1: Write failing tests for the remaining pure views** (`renderConnectors`, `renderAudit`, `renderPolicy`, `renderUsers`, `renderNamespaces`) — assert each escapes text and shows the key columns from §7. (Same pattern as Task 16; write a concrete assertion per view — e.g. `renderConnectors([...]).toContain("blocked by policy")`.)

- [ ] **Step 2: Run → FAIL → implement `views.ts`** as pure `(...) => string` functions mirroring `render.ts`. Policy view: read-only table on peers; on the anchor, include a `<textarea>` + Save button (wired in `main.ts` to `PUT /v1/admin/policy`).

- [ ] **Step 3: Write `client.ts` + `main.ts`** (not unit-tested — thin DOM glue):

```typescript
// client.ts
export function makeClient(token: string) {
  const h = { authorization: `Bearer ${token}` };
  return {
    status: async () => (await (await fetch("/v1/admin/status", { headers: h })).json()).data,
    savePolicy: async (toml: string) =>
      fetch("/v1/admin/policy", { method: "PUT", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ toml }) }),
  };
}
```

`main.ts`: read the token from a `#token` input (operator pastes it, or the `nimbus admin console` URL carries it in `#fragment` which never hits the server), wire sidebar clicks to swap `innerHTML` using the render functions, poll `status()` every 5s on the Overview.

- [ ] **Step 4: Build + view tests → PASS.**

```bash
cd packages/admin-console && bun run build && bun run typecheck && cd ../..
bun test packages/admin-console/src/views.test.ts
```

- [ ] **Step 5: Add `PUT /v1/admin/policy`** to `http-write-routes.ts` `WRITE_ROUTE_ALLOWLIST` (anchor-only; validate via `parsePolicyToml`, then `signPolicy` with the Vault key, persist, `appendAuditEntry`). Update the route-count assertion in the write-routes test (+1).

- [ ] **Step 6: Lint + commit**

```bash
bunx biome check packages/admin-console/src packages/gateway/src/ipc/http-write-routes.ts
git add packages/admin-console/src packages/gateway/src/ipc/http-write-routes.ts packages/gateway/src/ipc/http-write-routes.test.ts
git commit -m "feat(admin-console): 6 views + client + anchor policy editor (PUT /v1/admin/policy)"
```

---

### Task 19: Audit-log shipper (metadata-only NDJSON POST)

**Files:**
- Create: `packages/gateway/src/audit/audit-shipper.ts`
- Test: `packages/gateway/src/audit/audit-shipper.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (start the shipper when `enforced().auditShipTo` is set; push its stop handle onto the sidecar stop list)

- [ ] **Step 1: Write the failing test** (injected `postFn` + clock — no real HTTP)

```typescript
// audit-shipper.test.ts
import { describe, expect, test } from "bun:test";
import { toShippableLine, shipBatch, type AuditMetaRow } from "./audit-shipper.ts";

const rows: AuditMetaRow[] = [
  { id: 1, actionType: "policy.applied", hitlStatus: "not_required", hash: "abc", timestamp: 100, actionJson: '{"secret":"x"}' },
];

describe("audit-shipper", () => {
  test("toShippableLine emits metadata ONLY — never actionJson", () => {
    const line = JSON.parse(toShippableLine(rows[0] as AuditMetaRow));
    expect(line).toEqual({ id: 1, actionType: "policy.applied", hitlStatus: "not_required", hash: "abc", timestamp: 100 });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  test("shipBatch POSTs NDJSON and returns the count shipped", async () => {
    let body = "";
    const n = await shipBatch(rows, { shipTo: "https://siem/x", post: async (_u, b) => { body = b; return true; } });
    expect(n).toBe(1);
    expect(body.trim().split("\n")).toHaveLength(1);
    expect(body).not.toContain("secret");
  });

  test("shipBatch returns 0 and does not throw when the POST fails", async () => {
    const n = await shipBatch(rows, { shipTo: "https://siem/x", post: async () => false });
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `audit-shipper.ts`:

```typescript
// audit-shipper.ts
export interface AuditMetaRow {
  readonly id: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly hash: string;
  readonly timestamp: number;
  readonly actionJson?: string; // present in DB rows; NEVER shipped
}

/** Project to metadata-only — the no-leak guarantee (spec §5). */
export function toShippableLine(row: AuditMetaRow): string {
  return JSON.stringify({
    id: row.id, actionType: row.actionType, hitlStatus: row.hitlStatus, hash: row.hash, timestamp: row.timestamp,
  });
}

export interface ShipDeps {
  readonly shipTo: string;
  readonly post: (url: string, ndjson: string) => Promise<boolean>;
}

/** POST a batch as NDJSON; return the number shipped (0 on failure — best-effort). */
export async function shipBatch(rows: readonly AuditMetaRow[], deps: ShipDeps): Promise<number> {
  if (rows.length === 0) return 0;
  const ndjson = `${rows.map(toShippableLine).join("\n")}\n`;
  const ok = await deps.post(deps.shipTo, ndjson);
  return ok ? rows.length : 0;
}
```

- [ ] **Step 3: Sidecar wiring** in `assemble.ts`: when `enforced().auditShipTo` is set, start an interval that selects new `audit_log` rows since a persisted cursor, calls `shipBatch` with a real `fetch`-based `post` (NDJSON `content-type: application/x-ndjson`, bounded retry), and advances the cursor only on success. Push the stop handle onto the sidecar stop list (mirror `startToolCallLogRetention`). Keep the default `post` out of the unit test.

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/audit/audit-shipper.ts packages/gateway/src/audit/audit-shipper.test.ts
git add packages/gateway/src/audit/audit-shipper.ts packages/gateway/src/audit/audit-shipper.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(policy): audit-log shipper (metadata-only NDJSON to policy ship_to)"
```

---

## Lane F — Team audit merged view

### Task 20: `federation.auditExport` — consent-gated, metadata-only

**Files:**
- Create: `packages/gateway/src/federation/audit-export.ts`
- Test: `packages/gateway/src/federation/audit-export.test.ts`
- Modify: `federation/federation-server.ts` (`federation.auditExport` case) + `ipc/lan-server.ts` (admit it, consent-gated like `federation.query`)

- [ ] **Step 1: Write the failing test**

```typescript
// audit-export.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { exportFederationAudit } from "./audit-export.ts";

function dbWithAudit(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  appendAuditEntry(db, { actionType: "federation.query", hitlStatus: "not_required", actionJson: '{"q":"secret"}', timestamp: 100 });
  appendAuditEntry(db, { actionType: "ask", hitlStatus: "not_required", actionJson: "{}", timestamp: 200 });
  return db;
}

describe("exportFederationAudit", () => {
  test("returns ONLY federation-prefixed entries, metadata only (no actionJson)", () => {
    const rows = exportFederationAudit(dbWithAudit(), { sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionType).toBe("federation.query");
    expect(JSON.stringify(rows[0])).not.toContain("secret");
    expect((rows[0] as Record<string, unknown>).actionJson).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `audit-export.ts`:

```typescript
// audit-export.ts
import type { Database } from "bun:sqlite";

export interface FederationAuditEntry {
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly hash: string;
  readonly timestamp: number;
}

/** Federation-only, metadata-only audit slice (leak-proof — never actionJson). */
export function exportFederationAudit(db: Database, opts: { sinceMs: number }): FederationAuditEntry[] {
  const rows = db
    .query("SELECT action_type, hitl_status, hash, timestamp FROM audit_log WHERE action_type LIKE 'federation.%' AND timestamp >= ? ORDER BY timestamp ASC")
    .all(opts.sinceMs) as { action_type: string; hitl_status: string; hash: string; timestamp: number }[];
  return rows.map((r) => ({ actionType: r.action_type, hitlStatus: r.hitl_status, hash: r.hash, timestamp: r.timestamp }));
}
```

> Confirm the real `audit_log` column names (`action_type`, `hitl_status`, `hash`, `timestamp`) by reading `db/audit-chain.ts` schema. Adjust if they differ.

- [ ] **Step 3: Dispatch + allowlist** `federation.auditExport` (consent-gated exactly like `federation.query` — the answering peerId is forced from the NaCl session; the requester must hold a grant/consent). Add to the LAN allow-set.

- [ ] **Step 4: Run → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/federation/audit-export.ts packages/gateway/src/federation/audit-export.test.ts
git add packages/gateway/src/federation/audit-export.ts packages/gateway/src/federation/audit-export.test.ts packages/gateway/src/federation/federation-server.ts packages/gateway/src/ipc/lan-server.ts
git commit -m "feat(federation): federation.auditExport (consent-gated, metadata-only)"
```

---

### Task 21: `team.auditMerged` aggregation + IPC + CLI

**Files:**
- Create: `packages/gateway/src/federation/audit-merge.ts`
- Test: `packages/gateway/src/federation/audit-merge.test.ts`
- Modify: IPC dispatcher (`team.auditMerged`) + CLI (`nimbus team audit`)

- [ ] **Step 1: Write the failing merge test**

```typescript
// audit-merge.test.ts
import { describe, expect, test } from "bun:test";
import { mergeTeamAudit } from "./audit-merge.ts";

describe("mergeTeamAudit", () => {
  test("merges per-peer streams into one timeline sorted by timestamp, tagged by peer", () => {
    const merged = mergeTeamAudit([
      { peerId: "peer:aa", entries: [{ actionType: "federation.query", hitlStatus: "x", hash: "h1", timestamp: 200 }] },
      { peerId: "peer:bb", entries: [{ actionType: "federation.query", hitlStatus: "x", hash: "h2", timestamp: 100 }] },
    ]);
    expect(merged.map((m) => m.peerId)).toEqual(["peer:bb", "peer:aa"]);
    expect(merged[0]?.timestamp).toBe(100);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `audit-merge.ts`:

```typescript
// audit-merge.ts
import type { FederationAuditEntry } from "./audit-export.ts";

export interface PeerAuditStream { peerId: string; entries: FederationAuditEntry[] }
export interface MergedAuditEntry extends FederationAuditEntry { peerId: string }

/** Flatten + tag + sort ascending by timestamp. */
export function mergeTeamAudit(streams: readonly PeerAuditStream[]): MergedAuditEntry[] {
  const out: MergedAuditEntry[] = [];
  for (const s of streams) for (const e of s.entries) out.push({ ...e, peerId: s.peerId });
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
```

- [ ] **Step 3: Wire `team.auditMerged` IPC** — fan out `federation.auditExport` to each paired peer (via the outbound LAN client), then `mergeTeamAudit`. Include the local stream (`exportFederationAudit` on the owner's db). Add `nimbus team audit` CLI calling it (table output). Follow the `nimbus-federation-identity` skill for the `nimbus team` CLI pattern.

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/federation/audit-merge.ts packages/gateway/src/federation/audit-merge.test.ts
git add packages/gateway/src/federation/audit-merge.ts packages/gateway/src/federation/audit-merge.test.ts
git commit -m "feat(federation): team.auditMerged aggregation + nimbus team audit"
```

---

## Lane G — GDPR purge (durable, retried on sync)

### Task 22: V37 migration + `GdprPurgeStore`

**Files:**
- Create: `packages/gateway/src/index/gdpr-v37-sql.ts`
- Create: `packages/gateway/src/policy/gdpr-purge-store.ts`
- Test: `packages/gateway/src/policy/gdpr-purge-store.test.ts`
- Modify: `index/migrations/runner.ts` (V37 step + label) + `index/local-index.ts` (`36` → `37`)

- [ ] **Step 1: Write the failing store test**

```typescript
// gdpr-purge-store.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

describe("GdprPurgeStore", () => {
  let db: Database;
  let store: GdprPurgeStore;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    store = new GdprPurgeStore(db);
  });

  test("opens a job with one pending request per peer", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa", "peer:bb"], openedAt: 1 });
    expect(store.pendingRequests("j1").map((r) => r.peerId).sort()).toEqual(["peer:aa", "peer:bb"]);
  });

  test("marking a request done removes it from pending; job closes when all done", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa"], openedAt: 1 });
    store.markDone("j1", "peer:aa", "SIGREC", 2);
    expect(store.pendingRequests("j1")).toHaveLength(0);
    expect(store.allDone("j1")).toBe(true);
  });

  test("incrementAttempt bumps the counter for retry backoff", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa"], openedAt: 1 });
    store.incrementAttempt("j1", "peer:aa", 5);
    expect(store.pendingRequests("j1")[0]?.attempts).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write the V37 SQL:

```typescript
// gdpr-v37-sql.ts
export const GDPR_V37_SQL = `
CREATE TABLE IF NOT EXISTS gdpr_purge_job (
  job_id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  completion_sig TEXT
);
CREATE TABLE IF NOT EXISTS gdpr_purge_request (
  job_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_ms INTEGER,
  deletion_record TEXT,
  PRIMARY KEY (job_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_gdpr_request_pending ON gdpr_purge_request (status);
`;
```

Wire V37 into `runner.ts` (`simpleStep(37, GDPR_V37_SQL)` + `[37, "gdpr purge ledger"]`) and bump `CURRENT_SCHEMA_VERSION = 37`.

- [ ] **Step 3: Write `gdpr-purge-store.ts`**

```typescript
// gdpr-purge-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface PurgeRequestRow { jobId: string; peerId: string; status: string; attempts: number }

export class GdprPurgeStore {
  constructor(private readonly db: Database) {}

  openJob(p: { jobId: string; externalId: string; peers: readonly string[]; openedAt: number }): void {
    this.db.transaction(() => {
      dbRun(this.db, "INSERT INTO gdpr_purge_job (job_id, external_id, opened_at) VALUES (?, ?, ?)", [p.jobId, p.externalId, p.openedAt]);
      for (const peer of p.peers) {
        dbRun(this.db, "INSERT INTO gdpr_purge_request (job_id, peer_id, status) VALUES (?, ?, 'pending')", [p.jobId, peer]);
      }
    })();
  }

  pendingRequests(jobId: string): PurgeRequestRow[] {
    const rows = this.db.query("SELECT job_id, peer_id, status, attempts FROM gdpr_purge_request WHERE job_id = ? AND status = 'pending'").all(jobId) as {
      job_id: string; peer_id: string; status: string; attempts: number;
    }[];
    return rows.map((r) => ({ jobId: r.job_id, peerId: r.peer_id, status: r.status, attempts: r.attempts }));
  }

  /** All currently-open jobs with at least one pending request (for sync retry). */
  openJobIds(): string[] {
    const rows = this.db.query("SELECT DISTINCT job_id FROM gdpr_purge_request WHERE status = 'pending'").all() as { job_id: string }[];
    return rows.map((r) => r.job_id);
  }

  markDone(jobId: string, peerId: string, deletionRecord: string, nowMs: number): void {
    dbRun(this.db, "UPDATE gdpr_purge_request SET status = 'done', deletion_record = ?, last_attempt_ms = ? WHERE job_id = ? AND peer_id = ?", [deletionRecord, nowMs, jobId, peerId]);
  }

  incrementAttempt(jobId: string, peerId: string, nowMs: number): void {
    dbRun(this.db, "UPDATE gdpr_purge_request SET attempts = attempts + 1, last_attempt_ms = ? WHERE job_id = ? AND peer_id = ?", [nowMs, jobId, peerId]);
  }

  allDone(jobId: string): boolean {
    const row = this.db.query("SELECT COUNT(*) AS n FROM gdpr_purge_request WHERE job_id = ? AND status != 'done'").get(jobId) as { n: number };
    return row.n === 0;
  }

  closeJob(jobId: string, completionSig: string, nowMs: number): void {
    dbRun(this.db, "UPDATE gdpr_purge_job SET closed_at = ?, completion_sig = ? WHERE job_id = ?", [nowMs, completionSig, jobId]);
  }
}
```

- [ ] **Step 4: Run → PASS** + verify version `37`. Lint + commit.

```bash
bun -e "import {CURRENT_SCHEMA_VERSION} from './packages/gateway/src/index/local-index.ts'; console.log(CURRENT_SCHEMA_VERSION)"
bunx biome check packages/gateway/src/policy packages/gateway/src/index/gdpr-v37-sql.ts
git add packages/gateway/src/policy/gdpr-purge-store.ts packages/gateway/src/policy/gdpr-purge-store.test.ts packages/gateway/src/index/gdpr-v37-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts
git commit -m "feat(gdpr): V37 purge ledger + GdprPurgeStore (durable per-peer state)"
```

---

### Task 23: Purge orchestration — local revoke + delete + open job

**Files:**
- Create: `packages/gateway/src/policy/gdpr-purge.ts`
- Test: `packages/gateway/src/policy/gdpr-purge.test.ts`

- [ ] **Step 1: Write the failing test** (injected deps — no real federation)

```typescript
// gdpr-purge.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";
import { startPurge, type PurgeDeps } from "./gdpr-purge.ts";

describe("startPurge", () => {
  test("revokes grants, deletes local contributions, opens a durable job with one request per peer", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const revoked: string[] = [];
    const deps: PurgeDeps = {
      store: new GdprPurgeStore(db),
      resolvePeer: () => "peer:alice",
      revokeAllGrants: (pid) => { revoked.push(pid); },
      deleteLocalContributions: () => 3,
      knownPeers: () => ["peer:aa", "peer:bb"],
      newJobId: () => "job-1",
      nowMs: () => 1000,
    };
    const r = await startPurge(deps, "alice");
    expect(r.jobId).toBe("job-1");
    expect(revoked).toEqual(["peer:alice"]);
    expect(r.localDeleted).toBe(3);
    expect(deps.store.pendingRequests("job-1").map((p) => p.peerId).sort()).toEqual(["peer:aa", "peer:bb"]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `gdpr-purge.ts`:

```typescript
// gdpr-purge.ts
import type { GdprPurgeStore } from "./gdpr-purge-store.ts";

export interface PurgeDeps {
  readonly store: GdprPurgeStore;
  readonly resolvePeer: (externalId: string) => string | undefined;
  readonly revokeAllGrants: (peerId: string) => void;
  readonly deleteLocalContributions: (peerId: string) => number;
  readonly knownPeers: () => readonly string[];
  readonly newJobId: () => string;
  readonly nowMs: () => number;
}

export interface PurgeStartResult { jobId: string; localDeleted: number }

/** Begin a GDPR purge: local revoke + delete now; remote requests durable + retried (§9.1). */
export async function startPurge(deps: PurgeDeps, externalId: string): Promise<PurgeStartResult> {
  const peerId = deps.resolvePeer(externalId);
  if (peerId === undefined) throw new Error(`gdpr purge: unknown user ${externalId}`);
  deps.revokeAllGrants(peerId);
  const localDeleted = deps.deleteLocalContributions(peerId);
  const jobId = deps.newJobId();
  deps.store.openJob({ jobId, externalId, peers: deps.knownPeers(), openedAt: deps.nowMs() });
  return { jobId, localDeleted };
}
```

- [ ] **Step 3: Run → PASS.** Wire the real deps in the IPC handler (Task 26): `revokeAllGrants` = reuse Slice 3 deprovision (`NamespaceStore.revoke` per grant); `deleteLocalContributions` = delete items/grants attributable to the peer from shared namespaces; `resolvePeer` = identity binding lookup. Lint + commit.

```bash
bunx biome check packages/gateway/src/policy/gdpr-purge.ts packages/gateway/src/policy/gdpr-purge.test.ts
git add packages/gateway/src/policy/gdpr-purge.ts packages/gateway/src/policy/gdpr-purge.test.ts
git commit -m "feat(gdpr): purge orchestration (local revoke+delete, open durable job)"
```

---

### Task 24: `federation.purge` serve — HITL-queued + signed deletion record

**Files:**
- Create: `packages/gateway/src/policy/deletion-record.ts`
- Test: `packages/gateway/src/policy/deletion-record.test.ts`
- Modify: `federation/federation-server.ts` (`federation.purge` → enqueue HITL) + `ipc/lan-server.ts`

- [ ] **Step 1: Write the failing deletion-record test**

```typescript
// deletion-record.test.ts
import { describe, expect, test } from "bun:test";
import { generateEd25519Keypair } from "@nimbus-dev/sdk";
import { signDeletionRecord, verifyDeletionRecord } from "./deletion-record.ts";

describe("deletion record", () => {
  test("signs and verifies a canonical {externalId, peerId, deletedCount, at}", () => {
    const kp = generateEd25519Keypair();
    const rec = { externalId: "alice", peerId: "peer:aa", deletedCount: 4, at: 1000 };
    const sig = signDeletionRecord(rec, kp.secretKey);
    expect(verifyDeletionRecord(rec, sig, kp.publicKey)).toBe(true);
    expect(verifyDeletionRecord({ ...rec, deletedCount: 99 }, sig, kp.publicKey)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `deletion-record.ts` (reuse `canonicalize`-style determinism via stable JSON key order):

```typescript
// deletion-record.ts
import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
import nacl from "tweetnacl";

export interface DeletionRecord {
  readonly externalId: string;
  readonly peerId: string;
  readonly deletedCount: number;
  readonly at: number;
}

function canonicalJson(r: DeletionRecord): string {
  return JSON.stringify({ at: r.at, deletedCount: r.deletedCount, externalId: r.externalId, peerId: r.peerId });
}

const enc = new TextEncoder();

export function signDeletionRecord(r: DeletionRecord, secretKeyB64: string): string {
  return encodeBase64(nacl.sign.detached(enc.encode(canonicalJson(r)), decodeBase64(secretKeyB64)));
}

export function verifyDeletionRecord(r: DeletionRecord, sigB64: string, pubKeyB64: string): boolean {
  try {
    return nacl.sign.detached.verify(enc.encode(canonicalJson(r)), decodeBase64(sigB64), decodeBase64(pubKeyB64));
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Wire `federation.purge` serve.** On receiving `federation.purge { externalId }` from an authenticated peer, enqueue it into the **local HITL queue** (do NOT auto-execute — spec D11). When the local operator approves, run the local delete, sign a `DeletionRecord` with this gateway's box/sign key, and return it to the requester. Add to LAN allow-set. The requester (Task 25) marks the request `done` with the returned record.

- [ ] **Step 4: Run → PASS.** Typecheck. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/policy/deletion-record.ts packages/gateway/src/policy/deletion-record.test.ts
git add packages/gateway/src/policy/deletion-record.ts packages/gateway/src/policy/deletion-record.test.ts packages/gateway/src/federation/federation-server.ts packages/gateway/src/ipc/lan-server.ts
git commit -m "feat(gdpr): federation.purge (HITL-queued) + signed deletion records"
```

---

### Task 25: Sync-cycle retry + job completion + aggregate signed record

**Files:**
- Create: `packages/gateway/src/policy/gdpr-purge-retry.ts`
- Test: `packages/gateway/src/policy/gdpr-purge-retry.test.ts`
- Modify: the sync scheduler (`sync/scheduler.ts`) to call the retry tick each cycle

- [ ] **Step 1: Write the failing retry test**

```typescript
// gdpr-purge-retry.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";
import { retryPendingPurges, type RetryDeps } from "./gdpr-purge-retry.ts";

describe("retryPendingPurges", () => {
  test("offline peer stays pending; a returning peer completes and closes the job", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const store = new GdprPurgeStore(db);
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:on", "peer:off"], openedAt: 1 });

    const deps: RetryDeps = {
      store,
      requestPurge: async (peerId) => (peerId === "peer:on" ? "SIGREC" : null), // off is unreachable
      signCompletion: () => "AGGSIG",
      nowMs: () => 10,
    };
    await retryPendingPurges(deps); // round 1: on done, off pending
    expect(store.pendingRequests("j1").map((p) => p.peerId)).toEqual(["peer:off"]);
    expect(store.allDone("j1")).toBe(false);

    // peer:off comes back:
    await retryPendingPurges({ ...deps, requestPurge: async () => "SIGREC2" });
    expect(store.allDone("j1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Then write `gdpr-purge-retry.ts`:

```typescript
// gdpr-purge-retry.ts
import type { GdprPurgeStore } from "./gdpr-purge-store.ts";

export interface RetryDeps {
  readonly store: GdprPurgeStore;
  /** Send federation.purge to a peer; returns the signed deletion record, or null if unreachable/not-yet-approved. */
  readonly requestPurge: (peerId: string) => Promise<string | null>;
  readonly signCompletion: (jobId: string) => string;
  readonly nowMs: () => number;
}

/** One retry tick: attempt every pending request; close jobs whose requests are all done. */
export async function retryPendingPurges(deps: RetryDeps): Promise<void> {
  for (const jobId of deps.store.openJobIds()) {
    for (const req of deps.store.pendingRequests(jobId)) {
      deps.store.incrementAttempt(jobId, req.peerId, deps.nowMs());
      const record = await deps.requestPurge(req.peerId);
      if (record !== null) deps.store.markDone(jobId, req.peerId, record, deps.nowMs());
    }
    if (deps.store.allDone(jobId)) deps.store.closeJob(jobId, deps.signCompletion(jobId), deps.nowMs());
  }
}
```

> When a job closes, the caller appends a `team.purge.completed` audit entry with the aggregate signature (the `db` handle lives at the sync call site).

- [ ] **Step 3: Wire the retry tick** into `sync/scheduler.ts` (call `retryPendingPurges` each cycle with a real `requestPurge` via the outbound LAN client and `signCompletion` via the gateway sign key + `signDeletionRecord` over the job summary).

- [ ] **Step 4: Run → PASS.** Lint + commit.

```bash
bunx biome check packages/gateway/src/policy/gdpr-purge-retry.ts packages/gateway/src/policy/gdpr-purge-retry.test.ts
git add packages/gateway/src/policy/gdpr-purge-retry.ts packages/gateway/src/policy/gdpr-purge-retry.test.ts packages/gateway/src/sync/scheduler.ts
git commit -m "feat(gdpr): sync-cycle retry of pending purges + job completion record"
```

---

## Lane H — Surface & docs

### Task 26: CLI + IPC dispatcher registration

**Files:**
- Create: `packages/gateway/src/ipc/policy-rpc.ts` (`policy.show`, `policy.sign`, `policy.trust`, `policy.refetch`, `team.purge`)
- Test: `packages/gateway/src/ipc/policy-rpc.test.ts`
- Modify: the IPC server dispatcher to mount the new namespace (see `nimbus-ipc` skill; reuse `dispatchByMethod` helper)
- Modify: `packages/cli/src/...` — add `nimbus policy {show,sign,push,trust,verify}`, `nimbus admin {status,console}`, `nimbus team {purge,audit}` (follow the existing `nimbus team` command module from Slice 1)

- [ ] **Step 1: Write the failing dispatcher test** (hit/miss envelope, per `dispatchByMethod`)

```typescript
// policy-rpc.test.ts
import { describe, expect, test } from "bun:test";
import { dispatchPolicyRpc, type PolicyRpcCtx } from "./policy-rpc.ts";

function ctx(): PolicyRpcCtx {
  return {
    showPolicy: () => ({ org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" }),
    signPolicy: () => { throw new Error("anchor-only"); },
    trustPubkey: () => {},
    refetch: async () => ({ applied: true }),
    purge: async () => ({ jobId: "j1", localDeleted: 0 }),
    isAnchor: false,
  };
}

describe("dispatchPolicyRpc", () => {
  test("policy.show returns the current state", async () => {
    const out = await dispatchPolicyRpc("policy.show", {}, ctx());
    expect(out.kind).toBe("hit");
  });
  test("policy.sign on a non-anchor fails closed", async () => {
    await expect(dispatchPolicyRpc("policy.sign", {}, ctx())).rejects.toThrow();
  });
  test("unknown method => miss", async () => {
    expect((await dispatchPolicyRpc("policy.nope", {}, ctx())).kind).toBe("miss");
  });
});
```

- [ ] **Step 2: Run → FAIL → implement `policy-rpc.ts`** using the `dispatchByMethod` helper (`ipc/_lib/dispatch-by-method.ts`). `policy.sign` and `team.purge` guard on `ctx.isAnchor`/operator and throw if not permitted. Register the dispatcher in the IPC server.

- [ ] **Step 3: Add CLI commands.** `nimbus policy show|verify` (read), `nimbus policy sign|push|trust` (local/anchor), `nimbus admin status` (prints the snapshot), `nimbus admin console` (prints `http://127.0.0.1:<port>/admin#token=<bearer>` — token in the fragment so it never reaches the server logs), `nimbus team purge --user <id> [--status <jobId>]`, `nimbus team audit`.

- [ ] **Step 4: Run dispatcher test → PASS.** Typecheck gateway + cli. Lint + commit.

```bash
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages/gateway/src/ipc/policy-rpc.ts packages/cli/src
git add packages/gateway/src/ipc/policy-rpc.ts packages/gateway/src/ipc/policy-rpc.test.ts packages/cli/src
git commit -m "feat(policy): policy.* / team.purge IPC + nimbus policy/admin/team CLI"
```

---

### Task 27: Tauri allowlist (I7)

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS`)
- Modify: the Rust allowlist test (count + membership)

- [ ] **Step 1:** Read the `nimbus-tauri-allowlist` skill. Add the **read-only** methods to `ALLOWED_METHODS`: `admin.status`, `policy.show`, `team.auditMerged`. Do **NOT** add `policy.sign`, `policy.trust`, `policy.refetch`, `team.purge` (RCE/destructive-class — CLI/local-only, I7).

- [ ] **Step 2:** Update the Rust allowlist count assertion (+3) and add membership asserts for the three new methods + negative asserts that `policy.sign`/`team.purge` are absent.

- [ ] **Step 3: Commit** (Rust isn't built on this box's preflight:fast; the CI Rust job validates).

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(policy): expose read-only admin.status/policy.show/team.auditMerged to renderer (I7)"
```

---

### Task 28: Docs — architecture, CHANGELOG, roadmap (CLAUDE/GEMINI/SECURITY-INVARIANTS I22 landed in Task 5)

**Files:**
- Modify: `docs/architecture.md` (new `policy/` + `status/` subsystems; the `policy.*`/`admin.*`/`team.*` IPC catalogue rows; the V36/V37 schema rows; `/v1/admin/status`, `/metrics`, `/admin/*` HTTP routes)
- Modify: `docs/CHANGELOG.md` (Slice 4 entry — per the connector-docs→CHANGELOG convention; do NOT touch the CLAUDE.md status line)
- Modify: `docs/roadmap.md` (check the Slice 4 boxes: org policy engine, policy enforcement, admin console, team audit log, GDPR purge; mark the Slice 4 delivery row delivered with the date 2026-06-07)
- Verify: `GEMINI.md` I22 mirror matches `CLAUDE.md` (Task 5)

- [ ] **Step 1:** Make the edits above. Keep all markdown links **relative**.

- [ ] **Step 2:** Run the doc-refs audit (it scans CLAUDE/GEMINI/architecture + named docs).

Run: `bun run audit:doc-refs`
Expected: passes (no broken links/paths).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/CHANGELOG.md docs/roadmap.md GEMINI.md
git commit -m "docs: Slice 4 — policy/admin/observability architecture + roadmap + CHANGELOG"
```

---

### Task 29: Integration acceptance + preflight + branch finish

**Files:**
- Create: `packages/gateway/test/integration/phase6-slice4-policy.test.ts` (or the repo's integration test dir — confirm location from a Slice 1–3 acceptance test)

- [ ] **Step 1: Write the acceptance test** — two in-process gateways (anchor + peer) over the existing test LAN harness:
  1. Anchor signs a policy (`min_days=30`, allowlist `["github"]`, quorum `terraform.destroy=2`).
  2. Peer pins the anchor pubkey, calls `refreshPolicy`, and `enforced()` reflects it.
  3. A tampered bundle is rejected; the peer keeps the last-valid policy.
  4. `partitionByAllowlist` blocks a non-listed connector and emits `policy.connector.blocked`.
  5. `GET /v1/admin/status` (with bearer) returns the snapshot; without bearer → 401.
  6. `GET /metrics` returns Prometheus text with `nimbus_policy_signature_valid 1`.
  7. GDPR purge with one offline peer: request stays `pending`, a second retry completes + closes the job.

- [ ] **Step 2: Run the acceptance test** (scoped — never the full suite):

Run: `bun test packages/gateway/test/integration/phase6-slice4-policy.test.ts`
Expected: PASS.

- [ ] **Step 3: Scoped sweep of every new/changed test file** (list them explicitly — do not run the whole suite):

```bash
bun test packages/gateway/src/policy packages/gateway/src/status packages/gateway/src/audit/audit-shipper.test.ts packages/gateway/src/federation/audit-export.test.ts packages/gateway/src/federation/audit-merge.test.ts packages/gateway/src/ipc/admin-status-rpc.test.ts packages/gateway/src/ipc/admin-console-assets.test.ts packages/gateway/src/ipc/policy-rpc.test.ts packages/admin-console/src packages/gateway/src/security-invariants.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Static gates (memory-safe).**

```bash
bun run preflight:fast
bun run scripts/structure-audit/check-nimbus-invariants.ts
cd packages/gateway && bun run typecheck && cd ../..
bunx biome check packages scripts
```

Expected: all green. (Do **not** run `bun run preflight` / `test:coverage` — they OOM this box.)

- [ ] **Step 5: Coverage floor (CI-authoritative).** Push the branch, open the PR, and read the **`coverage-lcov-merged`** artifact from the "Unit + Coverage" job. Every new source file under `policy/`, `status/`, `audit/audit-shipper.ts`, the new `ipc/*` files, and `admin-console/src` must be **≥80%/file**. Local scoped coverage is NOT authoritative — confirm on CI. Add targeted tests for any file under the floor.

- [ ] **Step 6: Push + finish the branch.** Use the explicit refspec (local branch name == remote, but be explicit):

```bash
git push origin HEAD:refs/heads/dev/asafgolombek/phase6-slice4-policy-admin-observability
```

Then invoke `superpowers:finishing-a-development-branch` to open the PR.

---

## Self-Review (spec coverage map)

| Spec section | Task(s) |
|---|---|
| §4.1 placement (`policy/`, `status/`, `admin-console/`) | 1–18 |
| §4.2 schema + §4.2.1 canonicalization | 1, 2 |
| §4.3 trust/distribution + fail-closed | 2, 3, 4, 10, 11, 12 |
| §4.4 peer refresh data flow | 11 |
| §5 connector allowlist / retention floor / HITL-quorum / audit shipping | 7, 8, 9, 19 |
| §5.1 profile × policy | 6 |
| §6 status API + Prometheus /metrics (+auth) | 13, 14, 15 |
| §7 admin console (6 views) + §7.1 build lifecycle | 16, 17, 18 |
| §8 team audit merged view | 20, 21 |
| §9 GDPR purge + §9.1 durability | 22, 23, 24, 25 |
| §10 invariant I22 + static D16 | 5 |
| §11 IPC/CLI/Tauri/HTTP surface | 15, 18, 26, 27 |
| §12 testing strategy | every task (TDD) + 29 |
| §13 build lanes A–H | tasks grouped by lane |
| §14 roadmap items closed | 28 |

No spec requirement is unmapped. Migration numbers (V36/V37) and the I22→D16 numbering are verified at branch time (the verification block + Task 5).

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. (NOTE: per the project gotcha, connector/gateway build subagents must run **foreground** — background subagents are denied Bash/PowerShell; and run `bun install` + `cd packages/client && bun run build` in the worktree first so typecheck doesn't false-fail on `@nimbus-dev/client`.)
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
