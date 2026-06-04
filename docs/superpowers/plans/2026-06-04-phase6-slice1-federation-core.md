# Phase 6 Slice 1 — Federation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Nimbus Gateways on a LAN discover each other, pair with mutual approval, publish a named filtered slice of one index, and answer a peer's consented, scope-enforced, audited, revocable federated queries — including a content-free expertise rank — with a leak-proof guarantee enforced by new security invariant I17.

**Architecture:** A new isolated `packages/gateway/src/federation/` module. All inbound peer queries funnel through a single structural gate (`query-gate.ts`) that resolves the peer's grant+role, enforces the namespace's declared filter, performs a scoped index read returning only declared item types, and audits every answer/rejection into the Blake3 chain. Discovery sits behind a `DiscoveryProvider` interface (in-memory mock for tests, third-party mDNS for production). The two over-the-wire methods (`federation.query`, `federation.expertise`) are the only `federation.*` methods admitted by the LAN allowlist; all management methods are local/Tauri-only.

**Tech Stack:** Bun v1.2+ / TypeScript 6.x strict, Bun SQLite, NaCl box (existing `lan-crypto.ts`), Blake3 audit chain (existing), a third-party mDNS/DNS-SD library (vetted via `bun run audit:deps`), Biome, `bun test`.

**Design of record:** [`docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md`](../specs/2026-06-04-phase6-federation-core-design.md). Read it before starting.

**Branch:** `dev/asafgolombek/phase6-slice1-federation-core` (already created off `main`).

---

## Conventions for every task

- **TDD**: write the failing test first, run it to watch it fail, implement minimally, run it to watch it pass, commit.
- **Run a single test file**: `bun test packages/gateway/src/federation/<file>.test.ts`
- **Typecheck before each commit**: `bun run typecheck` (or the package-scoped `tsc`); the gateway must stay `any`-free (non-negotiable #7).
- **Lint**: `bun run lint` (Biome).
- **No `any`** — use `unknown` for external/wire data and narrow it.
- **All SQLite writes** route through `dbRun` / `dbExec` / `dbStmtRun` from `packages/gateway/src/db/write.ts` (I14). Identifiers via `escapeIdentifier` (I9) — here all identifiers are static literals, so bound parameters suffice.
- **Commit messages**: Conventional Commits, scope `feat(federation)` / `feat(gateway)` / `test(federation)`, end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

**Create:**

| File | Responsibility |
|------|----------------|
| `packages/gateway/src/index/federation-v33-sql.ts` | V33 migration SQL: 3 federation tables + `audit_log.federation_json` column. |
| `packages/gateway/src/federation/types.ts` | Shared federation types (role, filter, grant, request/response, decision, rank). No logic. |
| `packages/gateway/src/federation/namespace-store.ts` | CRUD for namespace definitions, declared filters, and per-peer grants/roles. Single source of truth for "what is shareable, with whom, at what role". |
| `packages/gateway/src/federation/consent-cache.ts` | Per-`(peer,namespace)`-per-session consent decision cache; invalidated on grant change. |
| `packages/gateway/src/federation/discovery.ts` | `DiscoveryProvider` interface + `InMemoryDiscoveryProvider` (tests) + `MdnsDiscoveryProvider` (prod) + manual-entry fallback. |
| `packages/gateway/src/federation/peer-pairing.ts` | Outbound/mutual pairing on top of `lan-pairing.ts` + `lan-crypto.ts`; persists to `lan_peers`. |
| `packages/gateway/src/federation/expertise.ts` | Content-free relevance rank (`high\|medium\|low\|none`). |
| `packages/gateway/src/federation/query-gate.ts` | **The I17 structural gate.** `answerFederatedQuery()` — the only function that answers peer queries. |
| `packages/gateway/src/federation/federation-audit.ts` | Thin helper appending a federation audit entry (`federation_json`) into the Blake3 chain. |
| `packages/gateway/src/ipc/federation-rpc.ts` | `federation.*` JSON-RPC dispatcher (`dispatchFederationRpc`). |

**Modify:**

| File | Change |
|------|--------|
| `packages/gateway/src/db/audit-chain.ts` | Add optional `federationJson` to hash input + append path (backward-compatible). |
| `packages/gateway/src/db/audit-verify.ts` | Read `federation_json` column and pass it into `computeAuditRowHash`. |
| `packages/gateway/src/index/migrations/runner.ts` | Register V33 `simpleStep`. |
| `packages/gateway/src/config/nimbus-toml.ts` | New `[federation]` section (consent timeout, mDNS enable/bind). |
| `packages/gateway/src/ipc/lan-rpc.ts` | Forbid management `federation.*` over LAN; admit only `federation.query` / `federation.expertise`. |
| `packages/gateway/src/ipc/server/dispatchers.ts` | Register `tryDispatchFederationRpc`. |
| `packages/gateway/src/ipc/server/context.ts` | (If needed) expose vault/configDir to the federation dispatch wiring. |
| `packages/gateway/src/security-invariants.test.ts` | I17 enforcement test. |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Static D13: no `local-index` import under `federation/` except `query-gate.ts`. |
| `docs/SECURITY-INVARIANTS.md` | New I17 row + rationale. |
| `CLAUDE.md` + `GEMINI.md` | Add I17 to the Security Invariants table (both files, same commit). |
| `packages/cli/src/commands/team.ts` (create) + `commands/index.ts` + `src/index.ts` | `nimbus team` command group. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Add the 5 local `federation.*` management methods to `ALLOWED_METHODS`; bump the count assertion. |

**Test files** (create alongside each module): `*.test.ts` colocated, plus integration tests under `packages/gateway/test/` (confirm exact integration dir with `nimbus-testing` — the gateway uses colocated unit tests and a `test/` tree for multi-subprocess E2E).

---

## Task 1: V33 migration — federation tables + audit `federation_json` column

**Files:**
- Create: `packages/gateway/src/index/federation-v33-sql.ts`
- Create: `packages/gateway/src/index/federation-v33-sql.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`

- [ ] **Step 1: Write the migration SQL constant**

Create `packages/gateway/src/index/federation-v33-sql.ts`:

```typescript
// V33 — Phase 6 Slice 1 (Federation Core).
// Append-only: 3 new tables + 1 nullable column on audit_log.
export const V33_FEDERATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS federation_namespaces (
     namespace_id TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     owner_self   INTEGER NOT NULL DEFAULT 1,
     created_at   INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS federation_namespace_filters (
     namespace_id TEXT NOT NULL,
     filter_kind  TEXT NOT NULL CHECK(filter_kind IN ('service','type','tag')),
     filter_value TEXT NOT NULL,
     PRIMARY KEY (namespace_id, filter_kind, filter_value)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_fed_filters_ns ON federation_namespace_filters(namespace_id);`,
  `CREATE TABLE IF NOT EXISTS federation_grants (
     namespace_id     TEXT NOT NULL,
     peer_id          TEXT NOT NULL,
     role             TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
     standing_consent INTEGER NOT NULL DEFAULT 0,
     granted_at       INTEGER NOT NULL,
     revoked_at       INTEGER,
     PRIMARY KEY (namespace_id, peer_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_fed_grants_peer ON federation_grants(peer_id);`,
  `ALTER TABLE audit_log ADD COLUMN federation_json TEXT;`,
];
```

- [ ] **Step 2: Register V33 in the runner**

In `packages/gateway/src/index/migrations/runner.ts`, add the import near the other `-vNN-sql` imports:

```typescript
import { V33_FEDERATION_SQL } from "../federation-v33-sql.ts";
```

Append to the `INDEXED_SCHEMA_STEPS` array, immediately after the `simpleStep(31, 32, ...)` entry:

```typescript
  simpleStep(
    32,
    33,
    "federation namespaces/filters/grants + audit_log.federation_json (federation v33)",
    V33_FEDERATION_SQL,
  ),
```

If `runner.ts` maintains a `BACKFILL_LABELS` map (or equivalent target-version label list), add a `33` entry mirroring the V32 entry's shape. (Confirm by reading the file — the drift test will catch a missing label.)

- [ ] **Step 3: Write the failing migration test**

Create `packages/gateway/src/index/federation-v33-sql.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts"; // confirm exported runner name

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});

test("V33 creates federation tables and the audit_log.federation_json column", () => {
  runIndexedSchemaMigrations(db); // brings a fresh DB to the latest version (>= 33)

  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'federation_%'`,
    )
    .all()
    .map((r) => r.name)
    .sort();
  expect(tables).toEqual([
    "federation_grants",
    "federation_namespace_filters",
    "federation_namespaces",
  ]);

  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(audit_log)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("federation_json");

  const userVersion = (db.query(`PRAGMA user_version`).get() as { user_version: number })
    .user_version;
  expect(userVersion).toBeGreaterThanOrEqual(33);
});
```

> NOTE: confirm the exact exported runner entry point name in `runner.ts` (e.g. `runIndexedSchemaMigrations` / `migrateIndexed`). Use the real name; the import must resolve.

- [ ] **Step 4: Run the test — expect FAIL, then PASS**

Run: `bun test packages/gateway/src/index/federation-v33-sql.test.ts`
Expected first run: FAIL (tables missing / import unresolved) until Steps 1–2 land. After Steps 1–2: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/gateway/src/index/federation-v33-sql.ts \
        packages/gateway/src/index/federation-v33-sql.test.ts \
        packages/gateway/src/index/migrations/runner.ts
git commit -m "feat(gateway): V33 migration — federation tables + audit_log.federation_json"
```

---

## Task 2: Backward-compatible federation audit (`federation_json` in the Blake3 chain)

**Files:**
- Modify: `packages/gateway/src/db/audit-chain.ts`
- Modify: `packages/gateway/src/db/audit-verify.ts`
- Create: `packages/gateway/src/federation/federation-audit.ts`
- Create: `packages/gateway/src/federation/federation-audit.test.ts`

**Why backward-compatible:** `computeAuditRowHash` is shared by append (`audit-chain.ts`), verify (`audit-verify.ts`), the migration ledger (`runner.ts`), and the perf worker (`perf/surfaces/sqlite-worker-audit.ts`). The new field must be appended to the hashed payload **only when present**, so every existing caller and every pre-existing row hashes identically.

- [ ] **Step 1: Extend the hash input (backward-compatible)**

In `packages/gateway/src/db/audit-chain.ts`, extend `AuditRowHashInput` and `computeAuditRowHash`:

```typescript
export interface AuditRowHashInput {
  readonly prevHash: string;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly actionJson: string;
  readonly timestamp: number;
  readonly federationJson?: string | null; // NEW — folded only when a non-empty string
}

export function computeAuditRowHash(input: AuditRowHashInput): string {
  const encoder = new TextEncoder();
  const base = `${input.prevHash}|${input.actionType}|${input.hitlStatus}|${input.actionJson}|${String(input.timestamp)}`;
  // Backward-compatible: legacy rows (no federationJson) hash exactly as before.
  const withFed =
    typeof input.federationJson === "string" && input.federationJson.length > 0
      ? `${base}|${input.federationJson}`
      : base;
  return bytesToHex(blake3(encoder.encode(withFed)));
}
```

- [ ] **Step 2: Extend the append path**

In the same file, extend `AppendAuditEntryFields` and `appendAuditEntry` to persist + hash the column:

```typescript
export interface AppendAuditEntryFields {
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly actionJson: string;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly federationJson?: string | null; // NEW
}
```

Update `appendAuditEntry` to pass `federationJson: fields.federationJson ?? null` into `computeAuditRowHash`, and change the INSERT to include the column:

```typescript
  const rowHash = computeAuditRowHash({
    prevHash,
    actionType: fields.actionType,
    hitlStatus: fields.hitlStatus,
    actionJson: fields.actionJson,
    timestamp: fields.timestamp,
    federationJson: fields.federationJson ?? null,
  });
  dbRun(
    db,
    `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash, session_id, federation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.actionType,
      fields.hitlStatus,
      fields.actionJson,
      fields.timestamp,
      rowHash,
      prevHash,
      fields.sessionId ?? null,
      fields.federationJson ?? null,
    ],
  );
```

- [ ] **Step 3: Make verify federation-aware**

In `packages/gateway/src/db/audit-verify.ts`, the row SELECT must also fetch `federation_json`, and the `computeAuditRowHash({...})` reconstruction (around line 54) must pass it:

```typescript
// add federation_json to the SELECT column list used to read each row, then:
    const expected = computeAuditRowHash({
      prevHash,
      actionType: row.action_type,
      hitlStatus: row.hitl_status,
      actionJson: row.action_json,
      timestamp: row.timestamp,
      federationJson: row.federation_json ?? null, // NEW — null for legacy rows
    });
```

Update the row type used by verify to include `federation_json: string | null`.

- [ ] **Step 4: Write the federation-audit helper**

Create `packages/gateway/src/federation/federation-audit.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { FederationDecision } from "./types.ts";

export interface FederationAuditFields {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly decision: FederationDecision;
  readonly method: "federation.query" | "federation.expertise";
  readonly timestamp: number;
}

/** Append a tamper-evident audit entry for an inbound federated query (answered or rejected). */
export function appendFederationAudit(db: Database, f: FederationAuditFields): void {
  const federationJson = JSON.stringify({
    peer_id: f.peerId,
    namespace: f.namespace,
    purpose: f.purpose,
    decision: f.decision,
    method: f.method,
  });
  appendAuditEntry(db, {
    actionType: `federation.answer.${f.decision}`,
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ method: f.method, namespace: f.namespace }),
    timestamp: f.timestamp,
    federationJson,
  });
}
```

- [ ] **Step 5: Write the failing test (chain continuity)**

Create `packages/gateway/src/federation/federation-audit.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { verifyAuditChain } from "../db/audit-verify.ts"; // confirm exported name
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendFederationAudit } from "./federation-audit.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
});
afterEach(() => db.close());

test("legacy + federation audit rows keep the Blake3 chain verifiable", () => {
  // a legacy (non-federation) row first
  appendAuditEntry(db, {
    actionType: "tool.call",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ tool: "x" }),
    timestamp: 1000,
  });
  // then federation rows: answered + rejected
  appendFederationAudit(db, {
    peerId: "peerA",
    namespace: "project:zurich",
    purpose: "review",
    decision: "answered",
    method: "federation.query",
    timestamp: 2000,
  });
  appendFederationAudit(db, {
    peerId: "peerB",
    namespace: "project:zurich",
    purpose: "snoop",
    decision: "no_grant",
    method: "federation.query",
    timestamp: 3000,
  });

  const result = verifyAuditChain(db); // confirm return shape (e.g. { ok: boolean })
  expect(result.ok).toBe(true);

  const fedRows = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .all();
  expect(fedRows.length).toBe(2);
});
```

- [ ] **Step 6: Run — FAIL → PASS, typecheck, commit**

Run: `bun test packages/gateway/src/federation/federation-audit.test.ts packages/gateway/src/db/audit-chain.test.ts packages/gateway/src/db/audit-verify.test.ts`
Expected: the new test fails until Steps 1–4 land; the **existing** audit-chain/verify tests must STILL pass (proves backward compatibility).

```bash
bun run typecheck
git add packages/gateway/src/db/audit-chain.ts packages/gateway/src/db/audit-verify.ts \
        packages/gateway/src/federation/federation-audit.ts \
        packages/gateway/src/federation/federation-audit.test.ts
git commit -m "feat(gateway): federation_json folded into audit chain (backward-compatible)"
```

---

## Task 3: Shared federation types

**Files:**
- Create: `packages/gateway/src/federation/types.ts`

No tests (pure types). This task exists so later tasks reference one canonical set of names.

- [ ] **Step 1: Write the types**

Create `packages/gateway/src/federation/types.ts`:

```typescript
export type FederationRole = "owner" | "editor" | "viewer";

export type FilterKind = "service" | "type" | "tag";

export interface NamespaceFilter {
  readonly kind: FilterKind;
  readonly value: string;
}

export interface NamespaceDefinition {
  readonly namespaceId: string;
  readonly name: string;
  readonly ownerSelf: boolean;
  readonly createdAt: number;
  readonly filters: readonly NamespaceFilter[];
}

export interface NamespaceGrant {
  readonly namespaceId: string;
  readonly peerId: string;
  readonly role: FederationRole;
  readonly standingConsent: boolean;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/** Inbound, over-the-wire request shape (validated from `unknown`). */
export interface FederatedQueryRequest {
  readonly namespace: string;
  readonly purpose: string;
  readonly types?: readonly string[];
  readonly limit?: number;
}

/**
 * The ONLY item fields ever exposed over federation. Deliberately excludes
 * `metadata` (the raw_meta-equivalent), `author_id`, `external_id`. (Leak-proof contract.)
 */
export interface FederatedItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly snippet: string; // from item.body_preview, truncated
  readonly modifiedAt: number;
}

export interface FederatedQueryResponse {
  readonly items: readonly FederatedItem[];
}

export type FederationDecision =
  | "answered"
  | "no_grant"
  | "not_paired"
  | "namespace_unknown"
  | "timeout"
  | "consent_denied";

export type ExpertiseRank = "high" | "medium" | "low" | "none";

export interface ExpertiseRequest {
  readonly query: string;
  readonly purpose: string;
}

export interface ExpertiseResponse {
  readonly rank: ExpertiseRank;
}

/** Over-the-wire error codes returned to the requesting peer (no leak of undeclared types). */
export type FederationWireError =
  | "not_paired"
  | "no_grant"
  | "namespace_unknown"
  | "timeout_waiting_for_consent"
  | "consent_denied";
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add packages/gateway/src/federation/types.ts
git commit -m "feat(federation): shared federation types"
```

---

## Task 4: Namespace store (CRUD for namespaces, filters, grants)

**Files:**
- Create: `packages/gateway/src/federation/namespace-store.ts`
- Create: `packages/gateway/src/federation/namespace-store.test.ts`

`NamespaceStore` is the single source of truth for "what is shareable, with whom, at what role". It is a thin, fully-tested wrapper over the V33 tables. All writes go through `dbRun`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/namespace-store.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { NamespaceStore } from "./namespace-store.ts";

let db: Database;
let store: NamespaceStore;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
  store = new NamespaceStore(db);
});
afterEach(() => db.close());

test("publish creates a namespace with declared filters", () => {
  store.publish("project:zurich", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
  const ns = store.getByName("project:zurich");
  expect(ns?.name).toBe("project:zurich");
  expect(ns?.filters).toEqual([
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
});

test("grant + getGrant returns an active grant; revoke makes it inactive", () => {
  store.publish("project:zurich", [{ kind: "type", value: "pull_request" }]);
  store.grant("project:zurich", "peerA", "viewer", false);
  const g = store.getActiveGrant("project:zurich", "peerA");
  expect(g?.role).toBe("viewer");
  expect(g?.standingConsent).toBe(false);

  store.revoke("project:zurich", "peerA");
  expect(store.getActiveGrant("project:zurich", "peerA")).toBeUndefined();
});

test("getActiveGrant returns undefined for an unknown peer or namespace", () => {
  expect(store.getActiveGrant("nope", "peerA")).toBeUndefined();
});

test("declaredTypes returns only the 'type' filters", () => {
  store.publish("p", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
    { kind: "type", value: "issue" },
  ]);
  expect(store.declaredTypes("p").sort()).toEqual(["issue", "pull_request"]);
  expect(store.declaredServices("p")).toEqual(["github"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`NamespaceStore` undefined). `bun test packages/gateway/src/federation/namespace-store.test.ts`

- [ ] **Step 3: Implement `NamespaceStore`**

Create `packages/gateway/src/federation/namespace-store.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type {
  FederationRole,
  NamespaceDefinition,
  NamespaceFilter,
  NamespaceGrant,
} from "./types.ts";

interface NsRow {
  namespace_id: string;
  name: string;
  owner_self: number;
  created_at: number;
}
interface FilterRow {
  filter_kind: "service" | "type" | "tag";
  filter_value: string;
}
interface GrantRow {
  namespace_id: string;
  peer_id: string;
  role: FederationRole;
  standing_consent: number;
  granted_at: number;
  revoked_at: number | null;
}

/** Deterministic namespace id derived from the name (no Math.random / Date.now in module code). */
function namespaceIdFor(name: string): string {
  return `ns:${name}`;
}

export class NamespaceStore {
  constructor(private readonly db: Database) {}

  publish(name: string, filters: readonly NamespaceFilter[], nowMs = Date.now()): NamespaceDefinition {
    const id = namespaceIdFor(name);
    this.db.transaction(() => {
      dbRun(
        this.db,
        `INSERT INTO federation_namespaces (namespace_id, name, owner_self, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(namespace_id) DO UPDATE SET name = excluded.name`,
        [id, name, nowMs],
      );
      dbRun(this.db, `DELETE FROM federation_namespace_filters WHERE namespace_id = ?`, [id]);
      for (const f of filters) {
        dbRun(
          this.db,
          `INSERT OR IGNORE INTO federation_namespace_filters (namespace_id, filter_kind, filter_value)
           VALUES (?, ?, ?)`,
          [id, f.kind, f.value],
        );
      }
    })();
    const def = this.getByName(name);
    if (def === undefined) throw new Error("federation: namespace publish failed");
    return def;
  }

  getByName(name: string): NamespaceDefinition | undefined {
    const row = this.db
      .query<NsRow, [string]>(`SELECT * FROM federation_namespaces WHERE name = ?`)
      .get(name);
    if (row === null || row === undefined) return undefined;
    return {
      namespaceId: row.namespace_id,
      name: row.name,
      ownerSelf: row.owner_self === 1,
      createdAt: row.created_at,
      filters: this.filtersFor(row.namespace_id),
    };
  }

  private filtersFor(namespaceId: string): NamespaceFilter[] {
    const rows = this.db
      .query<FilterRow, [string]>(
        `SELECT filter_kind, filter_value FROM federation_namespace_filters
         WHERE namespace_id = ? ORDER BY rowid ASC`,
      )
      .all(namespaceId);
    return rows.map((r) => ({ kind: r.filter_kind, value: r.filter_value }));
  }

  declaredTypes(name: string): string[] {
    return (this.getByName(name)?.filters ?? [])
      .filter((f) => f.kind === "type")
      .map((f) => f.value);
  }

  declaredServices(name: string): string[] {
    return (this.getByName(name)?.filters ?? [])
      .filter((f) => f.kind === "service")
      .map((f) => f.value);
  }

  grant(
    name: string,
    peerId: string,
    role: FederationRole,
    standingConsent: boolean,
    nowMs = Date.now(),
  ): void {
    const id = namespaceIdFor(name);
    dbRun(
      this.db,
      `INSERT INTO federation_grants (namespace_id, peer_id, role, standing_consent, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(namespace_id, peer_id) DO UPDATE SET
         role = excluded.role,
         standing_consent = excluded.standing_consent,
         granted_at = excluded.granted_at,
         revoked_at = NULL`,
      [id, peerId, role, standingConsent ? 1 : 0, nowMs],
    );
  }

  revoke(name: string, peerId: string, nowMs = Date.now()): void {
    const id = namespaceIdFor(name);
    dbRun(
      this.db,
      `UPDATE federation_grants SET revoked_at = ? WHERE namespace_id = ? AND peer_id = ? AND revoked_at IS NULL`,
      [nowMs, id, peerId],
    );
  }

  /** Live-checked: returns the grant ONLY if it exists and is not revoked. */
  getActiveGrant(name: string, peerId: string): NamespaceGrant | undefined {
    const id = namespaceIdFor(name);
    const row = this.db
      .query<GrantRow, [string, string]>(
        `SELECT * FROM federation_grants WHERE namespace_id = ? AND peer_id = ? AND revoked_at IS NULL`,
      )
      .get(id, peerId);
    if (row === null || row === undefined) return undefined;
    return {
      namespaceId: row.namespace_id,
      peerId: row.peer_id,
      role: row.role,
      standingConsent: row.standing_consent === 1,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    };
  }
}
```

> `nowMs = Date.now()` is a **default parameter** evaluated at call time in production, and tests pass explicit timestamps — this keeps the module deterministic under test without `Date.now()` appearing in a hot path.

- [ ] **Step 4: Run — expect PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/namespace-store.test.ts
bun run typecheck
git add packages/gateway/src/federation/namespace-store.ts packages/gateway/src/federation/namespace-store.test.ts
git commit -m "feat(federation): namespace store (namespaces, filters, grants)"
```

---

## Task 5: Session consent cache

**Files:**
- Create: `packages/gateway/src/federation/consent-cache.ts`
- Create: `packages/gateway/src/federation/consent-cache.test.ts`

Caches a non-standing consent decision per `(peerId, namespace)` for the lifetime of the process session; invalidated immediately on grant revoke/role change (acceptance criterion 4). In-memory only — never persisted (that's what `standing_consent` is for).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/consent-cache.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { SessionConsentCache } from "./consent-cache.ts";

test("remembers an approval for the (peer, namespace) pair", () => {
  const c = new SessionConsentCache();
  expect(c.get("peerA", "ns1")).toBeUndefined();
  c.set("peerA", "ns1", true);
  expect(c.get("peerA", "ns1")).toBe(true);
  c.set("peerA", "ns2", false);
  expect(c.get("peerA", "ns2")).toBe(false);
});

test("invalidate clears a single (peer, namespace) decision", () => {
  const c = new SessionConsentCache();
  c.set("peerA", "ns1", true);
  c.invalidate("peerA", "ns1");
  expect(c.get("peerA", "ns1")).toBeUndefined();
});

test("invalidateNamespace clears every peer's decision for a namespace", () => {
  const c = new SessionConsentCache();
  c.set("peerA", "ns1", true);
  c.set("peerB", "ns1", true);
  c.set("peerA", "ns2", true);
  c.invalidateNamespace("ns1");
  expect(c.get("peerA", "ns1")).toBeUndefined();
  expect(c.get("peerB", "ns1")).toBeUndefined();
  expect(c.get("peerA", "ns2")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/gateway/src/federation/consent-cache.test.ts`

- [ ] **Step 3: Implement**

Create `packages/gateway/src/federation/consent-cache.ts`:

```typescript
function key(peerId: string, namespace: string): string {
  return `${peerId} ${namespace}`;
}

/** In-memory, process-lifetime consent decisions for non-standing grants. Never persisted. */
export class SessionConsentCache {
  private readonly decisions = new Map<string, boolean>();

  get(peerId: string, namespace: string): boolean | undefined {
    return this.decisions.get(key(peerId, namespace));
  }

  set(peerId: string, namespace: string, approved: boolean): void {
    this.decisions.set(key(peerId, namespace), approved);
  }

  invalidate(peerId: string, namespace: string): void {
    this.decisions.delete(key(peerId, namespace));
  }

  invalidateNamespace(namespace: string): void {
    const suffix = ` ${namespace}`;
    for (const k of this.decisions.keys()) {
      if (k.endsWith(suffix)) this.decisions.delete(k);
    }
  }
}
```

- [ ] **Step 4: Run — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/consent-cache.test.ts
bun run typecheck
git add packages/gateway/src/federation/consent-cache.ts packages/gateway/src/federation/consent-cache.test.ts
git commit -m "feat(federation): session consent cache"
```

---

## Task 6: Discovery provider (interface + in-memory + mDNS + manual fallback)

**Files:**
- Create: `packages/gateway/src/federation/discovery.ts`
- Create: `packages/gateway/src/federation/discovery.test.ts`
- Modify: `package.json` (add the mDNS dependency)

The interface is what the rest of the slice depends on; the mDNS implementation is swappable. **All unit/integration tests inject `InMemoryDiscoveryProvider`** — never a real broadcast.

- [ ] **Step 1: Add and vet the mDNS dependency**

```bash
bun add multicast-dns       # or: bun add bonjour-service
bun run audit:deps          # dep-safety pre-flight (see nimbus-commands); must pass
```

If `audit:deps` flags the lib, prefer `bonjour-service` (maintained TS, fewer transitive deps) or fall back to a first-party UDP-multicast responder behind the same interface. Record the choice in the commit body.

- [ ] **Step 2: Write the failing test (interface + in-memory mock)**

Create `packages/gateway/src/federation/discovery.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { InMemoryDiscoveryProvider } from "./discovery.ts";
import type { DiscoveredPeer } from "./discovery.ts";

test("InMemoryDiscoveryProvider lists the injected peers", async () => {
  const peers: DiscoveredPeer[] = [
    { instanceName: "asaf-laptop", host: "192.168.1.10", port: 7475 },
    { instanceName: "bob-desktop", host: "192.168.1.11", port: 7475 },
  ];
  const provider = new InMemoryDiscoveryProvider(peers);
  await provider.start();
  expect(await provider.list()).toEqual(peers);
  await provider.stop();
});

test("addManualPeer surfaces a peer when mDNS is unavailable", async () => {
  const provider = new InMemoryDiscoveryProvider([]);
  await provider.start();
  provider.addManualPeer({ instanceName: "manual", host: "10.0.0.5", port: 7475 });
  expect(await provider.list()).toEqual([{ instanceName: "manual", host: "10.0.0.5", port: 7475 }]);
  await provider.stop();
});
```

- [ ] **Step 3: Run — expect FAIL.** `bun test packages/gateway/src/federation/discovery.test.ts`

- [ ] **Step 4: Implement the interface + both providers**

Create `packages/gateway/src/federation/discovery.ts`:

```typescript
export interface DiscoveredPeer {
  readonly instanceName: string;
  readonly host: string;
  readonly port: number;
}

/** Discovery never implies trust — pairing still requires mutual approval. */
export interface DiscoveryProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of currently-known peers (mDNS-advertised + manually added). */
  list(): Promise<readonly DiscoveredPeer[]>;
  /** Advertise this gateway as `_nimbus._tcp` on the given port. */
  advertise(instanceName: string, port: number): Promise<void>;
  /** Manual fallback for mDNS-absent environments. */
  addManualPeer(peer: DiscoveredPeer): void;
}

/** Deterministic, broadcast-free provider for unit + integration tests. */
export class InMemoryDiscoveryProvider implements DiscoveryProvider {
  private readonly peers: DiscoveredPeer[];
  constructor(seed: readonly DiscoveredPeer[] = []) {
    this.peers = [...seed];
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async list(): Promise<readonly DiscoveredPeer[]> {
    return [...this.peers];
  }
  async advertise(): Promise<void> {}
  addManualPeer(peer: DiscoveredPeer): void {
    this.peers.push(peer);
  }
}
```

Then add the production `MdnsDiscoveryProvider` in the same file (sketch — adapt to the chosen lib's API; keep ALL of its broadcast surface inside this class so the rest of the module stays testable):

```typescript
import makeMdns from "multicast-dns"; // or bonjour-service equivalent

const SERVICE_TYPE = "_nimbus._tcp.local";

export class MdnsDiscoveryProvider implements DiscoveryProvider {
  private mdns: ReturnType<typeof makeMdns> | undefined;
  private readonly seen = new Map<string, DiscoveredPeer>();
  private readonly manual: DiscoveredPeer[] = [];

  async start(): Promise<void> {
    this.mdns = makeMdns();
    this.mdns.on("response", (resp: { answers: ReadonlyArray<Record<string, unknown>> }) => {
      // Parse SRV/A records for SERVICE_TYPE; on a match, this.seen.set(name, {instanceName, host, port}).
      // Keep parsing defensive: treat every field as `unknown` and narrow.
    });
    this.mdns.query({ questions: [{ name: SERVICE_TYPE, type: "PTR" }] });
  }
  async stop(): Promise<void> {
    this.mdns?.destroy();
    this.mdns = undefined;
  }
  async list(): Promise<readonly DiscoveredPeer[]> {
    return [...this.seen.values(), ...this.manual];
  }
  async advertise(instanceName: string, port: number): Promise<void> {
    // Respond to PTR queries for SERVICE_TYPE with SRV/A/TXT for this instance.
  }
  addManualPeer(peer: DiscoveredPeer): void {
    this.manual.push(peer);
  }
}
```

> The mDNS record parsing/serialization is the only fiddly part — implement it test-first against the chosen lib's record shapes in a follow-up commit, behind the real-broadcast E2E (Task 14). The interface + in-memory provider are what the rest of Slice 1 binds to, so they unblock everything.

- [ ] **Step 5: Run unit tests — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/discovery.test.ts
bun run typecheck
git add packages/gateway/src/federation/discovery.ts packages/gateway/src/federation/discovery.test.ts package.json bun.lock
git commit -m "feat(federation): DiscoveryProvider interface + in-memory + mDNS skeleton"
```

---

## Task 7: Peer pairing (mutual approval, outbound direction)

**Files:**
- Create: `packages/gateway/src/federation/peer-pairing.ts`
- Create: `packages/gateway/src/federation/peer-pairing.test.ts`

Builds on `lan-pairing.ts` (codes), `lan-crypto.ts` (keys), and the existing `lan_peers` table helpers on `LocalIndex` (`addLanPeer`, `getLanPeerByPubkey`, `listLanPeers`, `removeLanPeer`). Pairing requires **mutual** owner approval: the initiator supplies a code; the responder's owner must approve the inbound request before the peer row is persisted.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/peer-pairing.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts"; // confirm constructor signature
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { PeerPairing } from "./peer-pairing.ts";

let index: LocalIndex;
beforeEach(() => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
  index = new LocalIndex(db); // adapt to the real constructor
});
afterEach(() => index.close?.());

test("approveInboundPair persists an inbound peer only after owner approval", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;

  const req = pairing.beginInboundPair({
    peerPubkey: peerKey,
    hostIp: "192.168.1.11",
    displayName: "bob-desktop",
  });
  // not yet persisted
  expect(index.getLanPeerByPubkey(peerKey)).toBeUndefined();

  const peerId = pairing.approveInboundPair(req); // owner-approved
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.direction).toBe("inbound");
  expect(row?.write_allowed).toBe(0); // federation answering is read-only
});

test("rejectInboundPair never persists the peer", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({ peerPubkey: peerKey, hostIp: "1.2.3.4" });
  pairing.rejectInboundPair(req);
  expect(index.getLanPeerByPubkey(peerKey)).toBeUndefined();
});

test("listPeers reflects persisted peers", () => {
  const pairing = new PeerPairing(index);
  const k = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({ peerPubkey: k, hostIp: "1.2.3.4" });
  pairing.approveInboundPair(req);
  expect(pairing.listPeers().length).toBe(1);
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/gateway/src/federation/peer-pairing.test.ts`

- [ ] **Step 3: Implement**

Create `packages/gateway/src/federation/peer-pairing.ts`:

```typescript
import type { LocalIndex, LanPeerRow } from "../index/local-index.ts";

export interface InboundPairRequest {
  readonly peerPubkey: Uint8Array;
  readonly hostIp: string;
  readonly hostPort?: number;
  readonly displayName?: string;
}

/** Deterministic peer id from the pubkey (first 16 hex of the key). */
function peerIdFor(pubkey: Uint8Array): string {
  let hex = "";
  for (const b of pubkey.slice(0, 8)) hex += b.toString(16).padStart(2, "0");
  return `peer:${hex}`;
}

/**
 * Mutual peer pairing. An inbound request is staged (`beginInboundPair`) and persisted ONLY
 * after the owner approves (`approveInboundPair`). Federation peers are always read-only
 * (`write_allowed = 0`) — Slice 1 answering never needs write.
 */
export class PeerPairing {
  constructor(private readonly index: LocalIndex) {}

  beginInboundPair(req: InboundPairRequest): InboundPairRequest {
    // Staging is intentionally a no-op holder; approval is the structural gate.
    return req;
  }

  approveInboundPair(req: InboundPairRequest): string {
    const peerId = peerIdFor(req.peerPubkey);
    this.index.addLanPeer({
      peerId,
      peerPubkey: req.peerPubkey,
      direction: "inbound",
      ...(req.hostIp === undefined ? {} : { hostIp: req.hostIp }),
      ...(req.hostPort === undefined ? {} : { hostPort: req.hostPort }),
      ...(req.displayName === undefined ? {} : { displayName: req.displayName }),
    });
    return peerId;
  }

  rejectInboundPair(_req: InboundPairRequest): void {
    // Explicit rejection: nothing persisted. Present for symmetry + audit hooks.
  }

  listPeers(): LanPeerRow[] {
    return this.index.listLanPeers();
  }

  removePeer(peerId: string): void {
    this.index.removeLanPeer(peerId);
  }
}
```

> Confirm `LocalIndex`'s real constructor + that `addLanPeer`/`getLanPeerByPubkey`/`listLanPeers`/`removeLanPeer` exist with the signatures from the design spec §4.2. If `LocalIndex` wraps the DB differently, adapt the test's construction accordingly.

- [ ] **Step 4: Run — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/peer-pairing.test.ts
bun run typecheck
git add packages/gateway/src/federation/peer-pairing.ts packages/gateway/src/federation/peer-pairing.test.ts
git commit -m "feat(federation): mutual-approval peer pairing"
```

---

## Task 8: Expertise (content-free rank)

**Files:**
- Create: `packages/gateway/src/federation/expertise.ts`
- Create: `packages/gateway/src/federation/expertise.test.ts`

Returns ONLY a coarse rank; the response shape carries zero item content (acceptance criterion 6). Relevance is scored locally from a count of matching items in the asked scope.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/expertise.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { scoreExpertise } from "./expertise.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
});
afterEach(() => db.close());

function insertItem(id: string, title: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, 'github', 'pull_request', ?, ?, ?, 1, 1)`,
    [id, id, title, title],
  );
}

test("returns 'none' when nothing matches", () => {
  const r = scoreExpertise(db, { query: "auth.ts race condition", purpose: "who-knows" });
  expect(r.rank).toBe("none");
  expect(Object.keys(r)).toEqual(["rank"]); // NO item content in the payload
});

test("more matches => higher rank", () => {
  for (let i = 0; i < 12; i++) insertItem(`github:pr${i}`, "fix auth.ts race condition");
  const r = scoreExpertise(db, { query: "auth.ts", purpose: "who-knows" });
  expect(r.rank).toBe("high");
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/gateway/src/federation/expertise.test.ts`

- [ ] **Step 3: Implement**

Create `packages/gateway/src/federation/expertise.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { ExpertiseRank, ExpertiseRequest, ExpertiseResponse } from "./types.ts";

function rankForCount(n: number): ExpertiseRank {
  if (n === 0) return "none";
  if (n >= 10) return "high";
  if (n >= 3) return "medium";
  return "low";
}

/**
 * Locally score this gateway's relevance to a query and return ONLY a coarse rank.
 * The response payload is `{ rank }` and never carries item bodies (leak-proof).
 */
export function scoreExpertise(db: Database, req: ExpertiseRequest): ExpertiseResponse {
  // Token-LIKE count over title + body_preview. Cheap, content-free output.
  const tokens = req.query.split(/\s+/).filter((t) => t.length >= 3).slice(0, 5);
  if (tokens.length === 0) return { rank: "none" };
  const clauses = tokens.map(() => `(title LIKE ? OR body_preview LIKE ?)`).join(" OR ");
  const vals: string[] = [];
  for (const t of tokens) {
    vals.push(`%${t}%`, `%${t}%`);
  }
  const row = db
    .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM item WHERE ${clauses}`)
    .get(...vals);
  return { rank: rankForCount(row?.n ?? 0) };
}
```

- [ ] **Step 4: Run — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/expertise.test.ts
bun run typecheck
git add packages/gateway/src/federation/expertise.ts packages/gateway/src/federation/expertise.test.ts
git commit -m "feat(federation): content-free expertise rank"
```

---

## Task 9: Query gate — the I17 structural gate

**Files:**
- Create: `packages/gateway/src/federation/query-gate.ts`
- Create: `packages/gateway/src/federation/query-gate.test.ts`

`answerFederatedQuery()` is the ONLY function that answers `federation.query`. It is the single place that touches `local-index`/`item-list-query` under `federation/` (enforced by I17). It: resolves the peer's active grant, applies consent semantics, compiles **only** the namespace's declared filters into the read, returns **only** declared item types as `FederatedItem` (no `metadata`), and audits every outcome.

- [ ] **Step 1: Write the failing test (the heart of the slice)**

Create `packages/gateway/src/federation/query-gate.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { SessionConsentCache } from "./consent-cache.ts";
import { NamespaceStore } from "./namespace-store.ts";
import { answerFederatedQuery } from "./query-gate.ts";
import type { ConsentPrompter } from "./query-gate.ts";

let db: Database;
let store: NamespaceStore;
const autoApprove: ConsentPrompter = async () => "approved";
const autoDeny: ConsentPrompter = async () => "denied";

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
  store = new NamespaceStore(db);
  // seed: 2 PRs (declared) + 1 secret email (NOT declared)
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix auth','body1',10,1,'{"secret":"x"}')`);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr2','github','pull_request','pr2','Add cache','body2',20,1,'{"secret":"y"}')`);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('gmail:e1','gmail','email','e1','Salaries','TOP SECRET',30,1,'{"secret":"z"}')`);
  store.publish("project:zurich", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
});
afterEach(() => db.close());

function ctx(consent: ConsentPrompter, cache = new SessionConsentCache()) {
  return { db, store, consentCache: cache, prompt: consent, consentTimeoutMs: 1000, now: () => 100 };
}

test("granted viewer with standing consent gets only declared items, audited", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("ok");
  if (res.kind !== "ok") return;
  expect(res.response.items.map((i) => i.id).sort()).toEqual(["github:pr1", "github:pr2"]);
  // leak-proof: no metadata field present on any item
  for (const it of res.response.items) {
    expect(Object.keys(it).sort()).toEqual(["id", "modifiedAt", "service", "snippet", "title", "type"]);
  }
  const audited = db.query(`SELECT COUNT(*) AS n FROM audit_log WHERE federation_json IS NOT NULL`).get() as { n: number };
  expect(audited.n).toBe(1);
});

test("no grant => empty + audited rejection", async () => {
  const res = await answerFederatedQuery(ctx(autoApprove), {
    peerId: "stranger",
    request: { namespace: "project:zurich", purpose: "snoop" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("no_grant");
  const row = db.query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`).get() as { federation_json: string };
  expect(JSON.parse(row.federation_json).decision).toBe("no_grant");
});

test("undeclared type request returns empty (no leak that email exists)", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review", types: ["email"] },
  });
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.response.items).toEqual([]); // email never returned
});

test("revoked grant => empty even if session consent was cached", async () => {
  const cache = new SessionConsentCache();
  store.grant("project:zurich", "peerA", "viewer", false);
  cache.set("peerA", "project:zurich", true); // simulate earlier approval
  store.revoke("project:zurich", "peerA");      // revoke + cache invalidation expected
  cache.invalidateNamespace("project:zurich");  // gate must do this on revoke (Task 10 wiring)
  const res = await answerFederatedQuery(ctx(autoDeny, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("error");
});

test("non-standing grant: consent timeout => timeout_waiting_for_consent", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const timeoutPrompt: ConsentPrompter = () => new Promise((r) => setTimeout(() => r("timeout"), 5));
  const res = await answerFederatedQuery({ ...ctx(timeoutPrompt), consentTimeoutMs: 1 }, {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("timeout_waiting_for_consent");
});

test("unknown namespace => namespace_unknown", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "no-such-ns", purpose: "review" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("namespace_unknown");
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/gateway/src/federation/query-gate.test.ts`

- [ ] **Step 3: Implement the gate**

Create `packages/gateway/src/federation/query-gate.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { buildItemListSql } from "../index/item-list-query.ts";
import { appendFederationAudit } from "./federation-audit.ts";
import type { SessionConsentCache } from "./consent-cache.ts";
import type { NamespaceStore } from "./namespace-store.ts";
import type {
  FederatedItem,
  FederatedQueryRequest,
  FederatedQueryResponse,
  FederationDecision,
  FederationWireError,
} from "./types.ts";

export type ConsentDecision = "approved" | "denied" | "timeout";
export type ConsentPrompter = (input: {
  peerId: string;
  namespace: string;
  purpose: string;
  role: string;
}) => Promise<ConsentDecision>;

export interface QueryGateCtx {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly consentCache: SessionConsentCache;
  readonly prompt: ConsentPrompter;
  readonly consentTimeoutMs: number;
  readonly now?: () => number;
}

export interface InboundQuery {
  readonly peerId: string;
  readonly request: FederatedQueryRequest;
}

export type AnswerResult =
  | { readonly kind: "ok"; readonly response: FederatedQueryResponse }
  | { readonly kind: "error"; readonly error: FederationWireError };

const SNIPPET_MAX = 280;
const DEFAULT_LIMIT = 50;

interface ItemRow {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  modified_at: number;
}

function toFederatedItem(r: ItemRow): FederatedItem {
  return {
    id: r.id,
    service: r.service,
    type: r.type,
    title: r.title,
    snippet: (r.body_preview ?? "").slice(0, SNIPPET_MAX),
    modifiedAt: r.modified_at,
  };
}

function audit(ctx: QueryGateCtx, q: InboundQuery, decision: FederationDecision): void {
  const nowMs = (ctx.now ?? Date.now)();
  appendFederationAudit(ctx.db, {
    peerId: q.peerId,
    namespace: q.request.namespace,
    purpose: q.request.purpose,
    decision,
    method: "federation.query",
    timestamp: nowMs,
  });
}

/**
 * I17 — the ONLY path that answers an inbound federated query. Enforces grant + role +
 * the namespace's declared filter; returns only declared item types; audits every outcome.
 */
export async function answerFederatedQuery(
  ctx: QueryGateCtx,
  q: InboundQuery,
): Promise<AnswerResult> {
  const ns = ctx.store.getByName(q.request.namespace);
  if (ns === undefined) {
    audit(ctx, q, "namespace_unknown");
    return { kind: "error", error: "namespace_unknown" };
  }

  // Live-checked grant — revocation takes effect immediately.
  const grant = ctx.store.getActiveGrant(q.request.namespace, q.peerId);
  if (grant === undefined) {
    audit(ctx, q, "no_grant");
    return { kind: "error", error: "no_grant" };
  }

  // Consent: standing grant never prompts; otherwise use session cache or prompt with timeout.
  if (!grant.standingConsent) {
    const cached = ctx.consentCache.get(q.peerId, q.request.namespace);
    if (cached === false) {
      audit(ctx, q, "consent_denied");
      return { kind: "error", error: "consent_denied" };
    }
    if (cached === undefined) {
      const decision = await withTimeout(
        ctx.prompt({ peerId: q.peerId, namespace: q.request.namespace, purpose: q.request.purpose, role: grant.role }),
        ctx.consentTimeoutMs,
      );
      if (decision === "timeout") {
        audit(ctx, q, "timeout");
        return { kind: "error", error: "timeout_waiting_for_consent" };
      }
      const approved = decision === "approved";
      ctx.consentCache.set(q.peerId, q.request.namespace, approved);
      if (!approved) {
        audit(ctx, q, "consent_denied");
        return { kind: "error", error: "consent_denied" };
      }
    }
  }

  // Compile ONLY declared filters into the read. Requested types are intersected with declared.
  const declaredServices = ctx.store.declaredServices(q.request.namespace);
  const declaredTypes = ctx.store.declaredTypes(q.request.namespace);
  const requested = q.request.types;
  const types =
    requested === undefined ? declaredTypes : declaredTypes.filter((t) => requested.includes(t));

  // If the requested type set is entirely outside the declared shape, the result is empty —
  // identical shape to an in-scope query with no matches (no leak of undeclared types).
  const { sql, vals } = buildItemListSql({
    services: declaredServices,
    types,
    limit: q.request.limit ?? DEFAULT_LIMIT,
  });
  const rows = ctx.db.query<ItemRow, Array<string | number>>(sql).all(...vals);
  const items = rows.map(toFederatedItem);

  audit(ctx, q, "answered");
  return { kind: "ok", response: { items } };
}

function withTimeout(p: Promise<ConsentDecision>, ms: number): Promise<ConsentDecision> {
  return Promise.race([
    p,
    new Promise<ConsentDecision>((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}
```

> `buildItemListSql` does `SELECT * FROM item`, so the row will include `metadata` etc. — but `toFederatedItem` maps **only** the safe columns, so the wire shape can never carry `metadata`. The leak-proof test asserts the exact key set.

- [ ] **Step 4: Run — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/federation/query-gate.test.ts
bun run typecheck
git add packages/gateway/src/federation/query-gate.ts packages/gateway/src/federation/query-gate.test.ts
git commit -m "feat(federation): query gate — scoped, consented, audited answering (I17 core)"
```

---

## Task 10: IPC surface — `federation-rpc.ts` + dispatch + LAN allowlist + consent notification

**Files:**
- Create: `packages/gateway/src/ipc/federation-rpc.ts`
- Create: `packages/gateway/src/ipc/federation-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`

This wires the module into JSON-RPC. **Critical security point:** `checkLanMethodAllowed` is a *blocklist* — by default `federation.namespace.publish` etc. would be answerable over the wire. We must explicitly forbid every management method over LAN and admit ONLY `federation.query` + `federation.expertise`.

- [ ] **Step 1: Forbid federation management methods over LAN (failing test first)**

In `packages/gateway/src/ipc/lan-rpc.test.ts` (create if absent; otherwise extend), add:

```typescript
import { expect, test } from "bun:test";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

const peer = { peerId: "p", writeAllowed: false };

test("federation.query and federation.expertise are admitted over LAN", () => {
  expect(() => checkLanMethodAllowed("federation.query", peer)).not.toThrow();
  expect(() => checkLanMethodAllowed("federation.expertise", peer)).not.toThrow();
});

test("federation management methods are forbidden over LAN", () => {
  for (const m of [
    "federation.discover",
    "federation.pair",
    "federation.peers",
    "federation.namespace.publish",
    "federation.namespace.grant",
    "federation.namespace.revoke",
  ]) {
    expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
  }
});

test("vault/data/extension remain forbidden over LAN", () => {
  for (const m of ["vault.get", "data.export", "extension.install"]) {
    expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (management methods currently allowed). `bun test packages/gateway/src/ipc/lan-rpc.test.ts`

- [ ] **Step 3: Add the federation management methods to the LAN blocklist**

In `packages/gateway/src/ipc/lan-rpc.ts`, extend `FORBIDDEN_OVER_LAN` with the exact management method strings (NOT the `federation` namespace prefix — that would also block `federation.query`):

```typescript
const FORBIDDEN_OVER_LAN = new Set([
  "vault",
  "updater",
  "lan",
  "profile",
  "audit",
  "data",
  "security",
  "connector.addMcp",
  "extension.sync",
  "extension.checkForUpdates",
  "extension.update",
  "index.reembed",
  "index.reembedCancel",
  // Federation: management methods are local/Tauri-only. Only federation.query /
  // federation.expertise are answerable over the wire (I17 + I5).
  "federation.discover",
  "federation.pair",
  "federation.peers",
  "federation.namespace.publish",
  "federation.namespace.grant",
  "federation.namespace.revoke",
]);
```

Run the test again — PASS.

- [ ] **Step 4: Write the federation RPC dispatcher (failing test first)**

Create `packages/gateway/src/ipc/federation-rpc.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc } from "./federation-rpc.ts";
import type { FederationRpcContext } from "./federation-rpc.ts";

let db: Database;
let notes: Array<{ method: string; params: unknown }>;
function ctx(): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: (method, params) => notes.push({ method, params }),
  };
}
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db);
  notes = [];
});
afterEach(() => db.close());

test("namespace.publish then peers/query round-trip", async () => {
  const pub = await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "project:zurich", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  expect(pub.kind).toBe("hit");

  const miss = await dispatchFederationRpc("federation.unknown", {}, ctx());
  expect(miss.kind).toBe("miss");
});

test("federation.query with no grant returns the no_grant error shape", async () => {
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns", filters: [{ kind: "type", value: "pull_request" }] },
    ctx(),
  );
  const res = await dispatchFederationRpc(
    "federation.query",
    { peerId: "stranger", namespace: "ns", purpose: "x" },
    ctx(),
  );
  expect(res.kind).toBe("hit");
});
```

- [ ] **Step 5: Run — expect FAIL.** `bun test packages/gateway/src/ipc/federation-rpc.test.ts`

- [ ] **Step 6: Implement `federation-rpc.ts`**

Create `packages/gateway/src/ipc/federation-rpc.ts` (mirrors `agents-rpc.ts`):

```typescript
import type { Database } from "bun:sqlite";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import { scoreExpertise } from "../federation/expertise.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { answerFederatedQuery } from "../federation/query-gate.ts";
import type { ConsentDecision, ConsentPrompter } from "../federation/query-gate.ts";
import type {
  ExpertiseRequest,
  FederatedQueryRequest,
  FederationRole,
  NamespaceFilter,
} from "../federation/types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class FederationRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "FederationRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface FederationRpcContext {
  readonly db: Database;
  readonly consentTimeoutMs: number;
  readonly notify: (method: string, params: unknown) => void;
}

// One session-scoped consent cache per process. Shared across calls (the dispatcher is per-call).
const sessionConsent = new SessionConsentCache();

function asRecord(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object") {
    throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return params as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new FederationRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

function parseFilters(raw: unknown): NamespaceFilter[] {
  if (!Array.isArray(raw)) throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: filters[]");
  return raw.map((f) => {
    const r = asRecord(f);
    const kind = requireString(r, "kind");
    if (kind !== "service" && kind !== "type" && kind !== "tag") {
      throw new FederationRpcError(-32602, `ERR_INVALID_PARAMS: bad filter kind ${kind}`);
    }
    return { kind, value: requireString(r, "value") };
  });
}

/** The owner-UI consent prompt is surfaced via a notification; for now resolve via a notify hook. */
function makePrompter(ctx: FederationRpcContext): ConsentPrompter {
  return async (input): Promise<ConsentDecision> => {
    // Emits the consent-request notification; the actual owner decision is delivered out-of-band
    // (consent.respond style) in the Tauri/CLI wiring. Until that lands, default to a timeout-safe deny.
    ctx.notify("federation.consentRequest", input);
    return "denied";
  };
}

export async function dispatchFederationRpc(
  method: string,
  params: unknown,
  ctx: FederationRpcContext,
): Promise<RpcMissOrHit> {
  const store = new NamespaceStore(ctx.db);
  return dispatchByMethod<FederationRpcContext>(method, params, ctx, {
    "federation.namespace.publish": (p) => {
      const rec = asRecord(p);
      const name = requireString(rec, "name");
      const def = store.publish(name, parseFilters(rec["filters"]));
      return { namespace: def.name, filters: def.filters };
    },
    "federation.namespace.grant": (p) => {
      const rec = asRecord(p);
      const role = requireString(rec, "role") as FederationRole;
      store.grant(
        requireString(rec, "namespace"),
        requireString(rec, "peerId"),
        role,
        rec["standingConsent"] === true,
      );
      return { ok: true };
    },
    "federation.namespace.revoke": (p) => {
      const rec = asRecord(p);
      store.revoke(requireString(rec, "namespace"), requireString(rec, "peerId"));
      // Revocation invalidates any cached session consent immediately (acceptance criterion 4).
      sessionConsent.invalidateNamespace(requireString(rec, "namespace"));
      return { ok: true };
    },
    "federation.query": async (p) => {
      const rec = asRecord(p);
      const request: FederatedQueryRequest = {
        namespace: requireString(rec, "namespace"),
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"]) ? { types: rec["types"] as string[] } : {}),
      };
      const res = await answerFederatedQuery(
        {
          db: ctx.db,
          store,
          consentCache: sessionConsent,
          prompt: makePrompter(ctx),
          consentTimeoutMs: ctx.consentTimeoutMs,
        },
        { peerId: requireString(rec, "peerId"), request },
      );
      return res;
    },
    "federation.expertise": (p) => {
      const rec = asRecord(p);
      const req: ExpertiseRequest = {
        query: requireString(rec, "query"),
        purpose: requireString(rec, "purpose"),
      };
      return scoreExpertise(ctx.db, req); // { rank } only
    },
  });
}
```

> The full owner-consent round-trip (notification → owner approves in UI → decision delivered back to the blocked query) reuses the existing HITL approval-UI patterns (design §4.6). The `makePrompter` hook above is the seam; wiring the real `consent.respond`-style delivery is a small follow-up that consults `nimbus-tauri-allowlist`. The structural gate (`query-gate.ts`) is already correct and tested.

- [ ] **Step 7: Register the dispatcher**

In `packages/gateway/src/ipc/server/dispatchers.ts`, add the import alongside the others:

```typescript
import { dispatchFederationRpc, FederationRpcError } from "../federation-rpc.ts";
```

Add a `tryDispatchFederationRpc(ctx, method, params)` wrapper mirroring the sibling `tryDispatch*Rpc` functions (use the existing `phase4RpcSkipped` sentinel + the `ctx.options.localIndex.getDatabase()` / `ctx.broadcastNotification` wiring seen in `tryDispatchAgentsRpc`):

```typescript
async function tryDispatchFederationRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const out = await dispatchFederationRpc(method, params, {
    db: ctx.options.localIndex.getDatabase(),
    consentTimeoutMs: (ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000,
    notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
  });
  if (out.kind === "miss") return phase4RpcSkipped;
  // mirror the sibling error→JSON-RPC mapping used for FederationRpcError
  return out.value;
}
```

Then chain it inside `tryDispatchPhase4Rpc`, after `tryDispatchSecurityRpc` and before `tryDispatchMetricsRpc`:

```typescript
  const federationOutcome = await tryDispatchFederationRpc(ctx, method, params);
  if (federationOutcome !== phase4RpcSkipped) return federationOutcome;
```

Plumb `federationConsentTimeoutSeconds` from the loaded `[federation]` config (Task 11) into `CreateIpcServerOptions` (follow how `configDir` / LAN options are threaded). If that plumbing is large, default to 30s at the dispatcher for this slice and wire the config override in the same commit as Task 11.

- [ ] **Step 8: Run all the IPC tests — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/ipc/federation-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts
bun run typecheck
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.test.ts \
        packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/lan-rpc.test.ts \
        packages/gateway/src/ipc/server/dispatchers.ts
git commit -m "feat(gateway): federation IPC dispatcher + LAN allowlist (admit query/expertise only)"
```

---

## Task 11: `[federation]` config section

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Create/extend: `packages/gateway/src/config/nimbus-toml.test.ts` (federation cases)

Mirrors the `[lan]` section pattern exactly (lines 425–507).

- [ ] **Step 1: Failing test**

Add to `packages/gateway/src/config/nimbus-toml.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { DEFAULT_NIMBUS_FEDERATION_TOML, parseNimbusFederationToml } from "./nimbus-toml.ts";

test("federation defaults: disabled, 30s consent timeout, mDNS on", () => {
  expect(DEFAULT_NIMBUS_FEDERATION_TOML).toEqual({
    enabled: false,
    consentTimeoutSeconds: 30,
    mdnsEnabled: true,
    mdnsBind: "0.0.0.0",
  });
});

test("parses overrides", () => {
  const r = parseNimbusFederationToml(
    `[federation]\nenabled = true\nconsent_timeout_seconds = 15\nmdns_enabled = false\nmdns_bind = "127.0.0.1"\n`,
  );
  expect(r).toEqual({
    enabled: true,
    consentTimeoutSeconds: 15,
    mdnsEnabled: false,
    mdnsBind: "127.0.0.1",
  });
});

test("rejects an out-of-range consent timeout (keeps default)", () => {
  const r = parseNimbusFederationToml(`[federation]\nconsent_timeout_seconds = 0\n`);
  expect(r.consentTimeoutSeconds).toBe(30);
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/gateway/src/config/nimbus-toml.test.ts`

- [ ] **Step 3: Implement the section** (insert after the `[lan]` block, ~line 507)

```typescript
export type NimbusFederationToml = {
  enabled: boolean;
  consentTimeoutSeconds: number;
  mdnsEnabled: boolean;
  mdnsBind: string;
};

export const DEFAULT_NIMBUS_FEDERATION_TOML: NimbusFederationToml = {
  enabled: false,
  consentTimeoutSeconds: 30,
  mdnsEnabled: true,
  mdnsBind: "0.0.0.0",
};

function applyNimbusFederationKey(
  out: Partial<NimbusFederationToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "consent_timeout_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0 && n <= 3600) out.consentTimeoutSeconds = n;
      break;
    }
    case "mdns_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.mdnsEnabled = b;
      break;
    }
    case "mdns_bind":
      out.mdnsBind = parseString(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlFederationSection(source: string): Partial<NimbusFederationToml> {
  const out: Partial<NimbusFederationToml> = {};
  forEachSectionEntry(source, "[federation]", (key, valRaw) => {
    applyNimbusFederationKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusFederationToml(
  raw: string,
  defaults: NimbusFederationToml = DEFAULT_NIMBUS_FEDERATION_TOML,
): NimbusFederationToml {
  const section = parseNimbusTomlFederationSection(raw);
  return { ...defaults, ...section };
}

export function loadNimbusFederationFromPath(tomlPath: string): NimbusFederationToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_FEDERATION_TOML, parseNimbusFederationToml);
}

export function loadNimbusFederationFromConfigDir(configDir: string): NimbusFederationToml {
  return loadNimbusFederationFromPath(join(configDir, "nimbus.toml"));
}
```

> `mdns_bind` defaults to `0.0.0.0` here because mDNS multicast must reach the LAN — this is the discovery advertiser bind, NOT the LAN RPC server bind (which stays `127.0.0.1` per I6). Note the distinction in the commit body so it isn't mistaken for an I6 regression.

- [ ] **Step 4: Run — PASS, typecheck, commit**

```bash
bun test packages/gateway/src/config/nimbus-toml.test.ts
bun run typecheck
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts
git commit -m "feat(gateway): [federation] config section (consent timeout, mDNS)"
```

---

## Task 12: Security Invariant I17 (docs row + runtime test + static D13)

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md`
- Modify: `CLAUDE.md`, `GEMINI.md` (same commit)
- Modify: `packages/gateway/src/security-invariants.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`

The triple rule: production wiring (Task 9) + docs row + enforcement test. Plus a static complement.

- [ ] **Step 1: Add the I17 runtime enforcement test**

In `packages/gateway/src/security-invariants.test.ts`, add (use the file's existing `read`/repo-root helpers — match the surrounding style):

```typescript
describe("I17 — federated answering is intrinsic to the query gate", () => {
  test("only query-gate.ts imports the index read path under federation/", async () => {
    const dir = "packages/gateway/src/federation";
    const files = (await readdir(resolve(REPO_ROOT, dir))).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const f of files) {
      const src = await readFile(resolve(REPO_ROOT, dir, f), "utf8");
      const importsIndexRead = /from\s+["'][^"']*(local-index|item-list-query)/.test(src);
      if (f === "query-gate.ts") {
        expect(importsIndexRead).toBe(true);
      } else {
        expect(importsIndexRead).toBe(false);
      }
    }
  });

  test("only federation.query and federation.expertise are admitted over LAN", async () => {
    const src = await readFile(resolve(REPO_ROOT, "packages/gateway/src/ipc/lan-rpc.ts"), "utf8");
    for (const m of [
      "federation.namespace.publish",
      "federation.namespace.grant",
      "federation.namespace.revoke",
      "federation.pair",
      "federation.peers",
      "federation.discover",
    ]) {
      expect(src).toContain(`"${m}"`); // present in FORBIDDEN_OVER_LAN
    }
  });
});
```

> Match the existing imports at the top of `security-invariants.test.ts` (`readdir`, `readFile`, `resolve`, `REPO_ROOT`). If the file uses a `read(relPath)` helper instead, use that.

- [ ] **Step 2: Run — expect PASS** (wiring already landed in Tasks 9–10). `bun test packages/gateway/src/security-invariants.test.ts`

- [ ] **Step 3: Add the static D13 rule**

In `scripts/structure-audit/check-nimbus-invariants.ts`, add a `checkFederationImportInvariant(files)` function (mirror the existing D10/D12 rule shape — confirm the real `FileEntry`/`Violation` types and the `run()` dispatch in the file):

```typescript
export function checkFederationImportInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const DIR = "packages/gateway/src/federation/";
  const ALLOWED = "packages/gateway/src/federation/query-gate.ts";
  for (const f of files) {
    if (!f.relPath.startsWith(DIR) || f.relPath === ALLOWED || f.relPath.endsWith(".test.ts")) {
      continue;
    }
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/from\s+["'][^"']*(local-index|item-list-query)/.test(line)) {
        out.push({ rule: "D13-federation-import", file: f.relPath, line: i + 1, snippet: line.trim() });
      }
    }
  }
  return out;
}
```

Wire it into the `run()`/`all` dispatch exactly like D10/D12 (emit `::error` + set exit=1 on any violation).

- [ ] **Step 4: Add the docs row + CLAUDE.md/GEMINI.md row**

In `docs/SECURITY-INVARIANTS.md`, add an I17 section (wiring site = `federation/query-gate.ts`; anti-pattern = a federation RPC handler that reads `local-index` directly or ignores `federation_namespace_filters`). In `CLAUDE.md` and `GEMINI.md`, add the I17 row to the Security Invariants table (same wording, same commit, both files).

- [ ] **Step 5: Run the static audit + tests, commit**

```bash
bun run scripts/structure-audit/check-nimbus-invariants.ts   # or the script's npm alias; expect 0 violations
bun test packages/gateway/src/security-invariants.test.ts
git add docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md \
        packages/gateway/src/security-invariants.test.ts \
        scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "feat(security): invariant I17 — federated answering intrinsic to query gate"
```

---

## Task 13: CLI — `nimbus team`

**Files:**
- Create: `packages/cli/src/commands/team.ts`
- Modify: `packages/cli/src/commands/index.ts` (export `runTeam`)
- Modify: `packages/cli/src/index.ts` (register `team: runTeam`)
- Create: `packages/cli/src/commands/team.test.ts` (arg parser)

Mirrors the `metrics.ts` command pattern: a pure `parseTeamArgs` (unit-tested) + a `runTeam` that connects over `IPCClient`.

- [ ] **Step 1: Failing arg-parser test**

Create `packages/cli/src/commands/team.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { parseTeamArgs } from "./team.ts";

test("discover (default)", () => {
  expect(parseTeamArgs([])).toEqual({ kind: "discover" });
  expect(parseTeamArgs(["discover"])).toEqual({ kind: "discover" });
});

test("namespace publish requires a name and >=1 filter", () => {
  expect(
    parseTeamArgs(["namespace", "publish", "project:zurich", "--type", "pull_request", "--service", "github"]),
  ).toEqual({
    kind: "namespacePublish",
    name: "project:zurich",
    filters: [
      { kind: "type", value: "pull_request" },
      { kind: "service", value: "github" },
    ],
  });
  expect(() => parseTeamArgs(["namespace", "publish"])).toThrow();
});

test("namespace grant", () => {
  expect(parseTeamArgs(["namespace", "grant", "project:zurich", "peer:abcd", "viewer"])).toEqual({
    kind: "namespaceGrant",
    namespace: "project:zurich",
    peerId: "peer:abcd",
    role: "viewer",
    standing: false,
  });
});

test("query + who-knows", () => {
  expect(parseTeamArgs(["query", "project:zurich", "peer:abcd", "find auth bugs"])).toEqual({
    kind: "query",
    namespace: "project:zurich",
    peerId: "peer:abcd",
    purpose: "find auth bugs",
  });
  expect(parseTeamArgs(["who-knows", "auth.ts race"])).toEqual({
    kind: "whoKnows",
    query: "auth.ts race",
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `bun test packages/cli/src/commands/team.test.ts`

- [ ] **Step 3: Implement `team.ts`**

Create `packages/cli/src/commands/team.ts`:

```typescript
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type TeamCommand =
  | { kind: "discover" }
  | { kind: "pair"; host: string; code: string }
  | { kind: "namespacePublish"; name: string; filters: Array<{ kind: string; value: string }> }
  | { kind: "namespaceGrant"; namespace: string; peerId: string; role: string; standing: boolean }
  | { kind: "namespaceRevoke"; namespace: string; peerId: string }
  | { kind: "query"; namespace: string; peerId: string; purpose: string }
  | { kind: "whoKnows"; query: string };

function collectFilters(args: string[]): Array<{ kind: string; value: string }> {
  const filters: Array<{ kind: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--type" || a === "--service" || a === "--tag") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.length === 0) throw new Error(`${a} requires a value`);
      filters.push({ kind: a.slice(2), value: v });
      i += 1;
    }
  }
  return filters;
}

export function parseTeamArgs(argv: string[]): TeamCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "discover":
      return { kind: "discover" };
    case "pair": {
      const host = rest[0];
      const code = rest[1];
      if (!host || !code) throw new Error("Usage: nimbus team pair <host> <code>");
      return { kind: "pair", host, code };
    }
    case "namespace": {
      const action = rest[0];
      if (action === "publish") {
        const name = rest[1];
        if (!name) throw new Error("Usage: nimbus team namespace publish <name> --type T --service S");
        const filters = collectFilters(rest.slice(2));
        if (filters.length === 0) throw new Error("publish requires at least one --type/--service/--tag");
        return { kind: "namespacePublish", name, filters };
      }
      if (action === "grant") {
        const [namespace, peerId, role] = [rest[1], rest[2], rest[3]];
        if (!namespace || !peerId || !role) throw new Error("Usage: nimbus team namespace grant <ns> <peerId> <role> [--standing]");
        return { kind: "namespaceGrant", namespace, peerId, role, standing: rest.includes("--standing") };
      }
      if (action === "revoke") {
        const [namespace, peerId] = [rest[1], rest[2]];
        if (!namespace || !peerId) throw new Error("Usage: nimbus team namespace revoke <ns> <peerId>");
        return { kind: "namespaceRevoke", namespace, peerId };
      }
      throw new Error("Usage: nimbus team namespace [publish|grant|revoke] ...");
    }
    case "query": {
      const [namespace, peerId, ...purposeParts] = rest;
      if (!namespace || !peerId || purposeParts.length === 0) {
        throw new Error('Usage: nimbus team query <ns> <peerId> "<purpose>"');
      }
      return { kind: "query", namespace, peerId, purpose: purposeParts.join(" ") };
    }
    case "who-knows": {
      const q = rest.join(" ");
      if (q.length === 0) throw new Error('Usage: nimbus team who-knows "<query>"');
      return { kind: "whoKnows", query: q };
    }
    default:
      throw new Error(`Unknown subcommand: ${sub}\nUsage: nimbus team [discover|pair|namespace|query|who-knows]`);
  }
}

export async function runTeam(argv: string[]): Promise<void> {
  let cmd: TeamCommand;
  try {
    cmd = parseTeamArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    switch (cmd.kind) {
      case "discover": {
        const r = await client.call<{ peers: unknown[] }>("federation.discover", {});
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "namespacePublish": {
        const r = await client.call<unknown>("federation.namespace.publish", {
          name: cmd.name,
          filters: cmd.filters,
        });
        process.stdout.write(`Published ${cmd.name}\n${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "namespaceGrant": {
        await client.call<unknown>("federation.namespace.grant", {
          namespace: cmd.namespace,
          peerId: cmd.peerId,
          role: cmd.role,
          standingConsent: cmd.standing,
        });
        process.stdout.write(`Granted ${cmd.role} on ${cmd.namespace} to ${cmd.peerId}\n`);
        break;
      }
      case "namespaceRevoke": {
        await client.call<unknown>("federation.namespace.revoke", {
          namespace: cmd.namespace,
          peerId: cmd.peerId,
        });
        process.stdout.write(`Revoked ${cmd.peerId} from ${cmd.namespace}\n`);
        break;
      }
      case "query": {
        const r = await client.call<unknown>("federation.query", {
          peerId: cmd.peerId,
          namespace: cmd.namespace,
          purpose: cmd.purpose,
        });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "whoKnows": {
        const r = await client.call<{ rank: string }>("federation.expertise", {
          query: cmd.query,
          purpose: "who-knows",
        });
        process.stdout.write(`rank: ${r.rank}\n`);
        break;
      }
      case "pair": {
        const r = await client.call<unknown>("federation.pair", { host: cmd.host, code: cmd.code });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
    }
  } finally {
    await client.close?.();
  }
}
```

> Confirm `IPCClient`'s real `connect`/`call`/`close` names from `metrics.ts`'s usage (`new IPCClient(state.socketPath)`, `await client.connect()`, `client.call<T>(method, params)`). Adjust `client.close?.()` to the real teardown method.

- [ ] **Step 4: Register the command**

In `packages/cli/src/commands/index.ts`, export `runTeam`. In `packages/cli/src/index.ts`, add `runTeam` to the import block and `team: runTeam,` to `COMMAND_HANDLERS`.

- [ ] **Step 5: Run — PASS, typecheck, commit**

```bash
bun test packages/cli/src/commands/team.test.ts
bun run typecheck
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team.test.ts \
        packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(cli): nimbus team command group"
```

---

## Task 14: Tauri allowlist — local federation management methods (I7)

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`

Add ONLY the local management methods to `ALLOWED_METHODS`. The over-the-wire answering methods (`federation.query`, `federation.expertise`) are **never** renderer-callable.

- [ ] **Step 1: Add the methods (alphabetical position)**

In `ALLOWED_METHODS` add:

```rust
    "federation.discover",
    "federation.namespace.grant",
    "federation.namespace.publish",
    "federation.namespace.revoke",
    "federation.pair",
    "federation.peers",
```

(6 methods. Do NOT add `federation.query` or `federation.expertise`.)

- [ ] **Step 2: Bump the count assertion**

The current assertion is `assert_eq!(ALLOWED_METHODS.len(), 62);` (line ~429). Update to `68` (62 + 6). If you add a different count of methods, set it to the exact new length.

- [ ] **Step 3: Run the Rust allowlist test, commit**

```bash
# from packages/ui/src-tauri:
cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist
git add packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(ui): expose local federation.* management methods to renderer (I7)"
```

> Consult the `nimbus-tauri-allowlist` skill before this task to confirm whether any of these must be classified long-running or globally-rebroadcast, and the exact current count.

---

## Task 15: Two-gateway integration + acceptance tests

**Files:**
- Create: `packages/gateway/test/federation/federation-e2e.test.ts` (confirm the integration dir via `nimbus-testing`)
- Create: `packages/gateway/test/federation/discovery-mdns.e2e.test.ts` (skippable real-mDNS E2E)

The canonical scenario uses two real Gateway subprocesses, real SQLite, fresh temp dirs, the `InMemoryDiscoveryProvider`, and the real NaCl-box LAN channel.

- [ ] **Step 1: Write the canonical integration scenario**

Create `packages/gateway/test/federation/federation-e2e.test.ts` following the project's two-subprocess E2E pattern (real gateway via the test harness used by other LAN/E2E tests — locate it with `nimbus-testing`). The scenario, asserting each acceptance criterion:

```text
1. Start Gateway A (owner) + Gateway B (peer), each with a fresh temp configDir and the
   InMemoryDiscoveryProvider seeded with the other's address.
2. B discovers A via federation.discover (mock provider) and pairs; A's owner approves the
   inbound pair (criterion 1). Assert: an UNPAIRED B query is rejected + audited.
3. A: federation.namespace.publish "project:zurich" with filters {service:github, type:pull_request}.
4. A: federation.namespace.grant viewer to B (standing_consent=true).
5. B issues federation.query over the real LAN channel → receives only the github/pull_request
   items, NO email/metadata (criteria 2 + 5). Assert the exact FederatedItem key set.
6. B issues a query for type "email" (undeclared) → empty result; A's audit shows a recorded
   query, no leak (criterion 5).
7. A: federation.namespace.revoke B. B's next query returns empty + audited within the same
   process session (criterion 4: live-checked + session-consent invalidated).
8. A: audit.verify still returns ok after all federation events (criterion 3).
9. B: federation.expertise "auth.ts" → returns only { rank }, payload carries zero item
   bodies (criterion 6).
10. Assert vault.*/data.*/extension.* over the LAN channel are rejected (criterion 7 / I5).
```

Each numbered step is an `expect` group in the test. Reuse the existing LAN E2E harness's subprocess spawn + encrypted-client helpers rather than re-implementing the NaCl handshake.

- [ ] **Step 2: Consent-timeout acceptance test**

Add a test where A grants B a **non-standing** grant and A's owner-consent prompt never resolves; assert B's query returns `timeout_waiting_for_consent` after `consent_timeout_seconds`, and A audits decision `timeout` (criterion 10). Drive the timeout deterministically by configuring a small `[federation].consent_timeout_seconds` in A's temp config.

- [ ] **Step 3: Real-mDNS skippable E2E**

Create `packages/gateway/test/federation/discovery-mdns.e2e.test.ts` guarded by an env flag so it skips on multicast-less CI:

```typescript
import { expect, test } from "bun:test";

const RUN = process.env["NIMBUS_MDNS_E2E"] === "1";

test.skipIf(!RUN)("MdnsDiscoveryProvider advertises and browses _nimbus._tcp", async () => {
  const { MdnsDiscoveryProvider } = await import("../../src/federation/discovery.ts");
  const adv = new MdnsDiscoveryProvider();
  const browser = new MdnsDiscoveryProvider();
  await adv.start();
  await adv.advertise("test-instance", 7475);
  await browser.start();
  // poll list() up to a few seconds for the advertised instance
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    const peers = await browser.list();
    found = peers.some((p) => p.instanceName.includes("test-instance"));
    if (!found) await new Promise((r) => setTimeout(r, 250));
  }
  await adv.stop();
  await browser.stop();
  expect(found).toBe(true);
});
```

- [ ] **Step 4: Run the integration suite, commit**

```bash
bun test packages/gateway/test/federation/federation-e2e.test.ts
NIMBUS_MDNS_E2E=1 bun test packages/gateway/test/federation/discovery-mdns.e2e.test.ts   # local only
git add packages/gateway/test/federation/
git commit -m "test(federation): two-gateway E2E (discover→pair→publish→grant→query→revoke→verify) + mDNS E2E"
```

---

## Task 16: Roadmap checkbox + preflight + PR

**Files:**
- Modify: `docs/roadmap.md` (tick the Slice 1 sub-items now delivered)
- Modify: `docs/CHANGELOG.md` (dated Slice 1 entry — connector/feature delivery convention)

- [ ] **Step 1: Tick delivered roadmap items**

In the Phase 6 body, check the boxes for: Consent-scoped federated query primitive, Privacy-preserving expertise routing, Nimbus-to-Nimbus federation, Shared index namespaces, LAN discovery, RBAC (per-namespace owner/editor/viewer at the protocol layer). Add the Slice 1 ✅ marker to the delivery-slices table row. Do NOT tick Slice 2–9 items.

- [ ] **Step 2: CHANGELOG entry**

Add a dated `## [unreleased]`/Slice 1 entry summarizing Federation Core (per the connector-docs→CHANGELOG convention — do NOT append to the CLAUDE.md status line).

- [ ] **Step 3: Full preflight**

```bash
bun run preflight
```

Fix anything red. Common gotchas (from project memory): in a fresh worktree, `cd packages/client && bun run build` if the typecheck false-fails on `@nimbus-dev/client`; coverage-floor is CI-Linux-authoritative — if a federation file reads <80% on Linux only, add the missing unit test rather than guessing.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin dev/asafgolombek/phase6-slice1-federation-core
gh pr create --title "feat: Phase 6 Slice 1 — Federation Core" --body "<summary + acceptance-criteria checklist from the spec §5>"
```

---

## Self-Review (run before handing off to execution)

**Spec coverage** — every §5 acceptance criterion maps to a task:

| Spec §5 criterion | Covered by |
|---|---|
| 1 Mutual pairing + unpaired rejected/audited | Task 7 + Task 15 step 1 |
| 2 Scoped answering (viewer gets only matching; no-grant empty+audited) | Task 9 + Task 15 |
| 3 Audit completeness + chain still verifies | Task 2 + Task 9 + Task 15 step 1.8 |
| 4 Revocation live-checked + session-consent invalidated | Task 5 + Task 9 + Task 10 step 6 (revoke→invalidateNamespace) |
| 5 Leak-proof contract (undeclared type empty; no raw_meta) | Task 3 (FederatedItem shape) + Task 9 test |
| 6 Expertise privacy (rank only) | Task 8 |
| 7 Channel allowlist (vault/data/extension forbidden; only 2 fed methods) | Task 10 + Task 12 |
| 8 I17 enforcement test exists | Task 12 |
| 9 Platform equality + mDNS-absent fallback | Task 6 (manual fallback) + Task 15 (skippable mDNS) |
| 10 Consent timeout | Task 9 test + Task 15 step 2 |

**Other spec sections:** §4.3 components → Tasks 4–10; §6 data model → Task 1; §7 I17 → Task 12; §8 testing (DI discovery, skippable mDNS) → Tasks 6 + 15.

**Open items deferred to implementation (flagged, not placeholders):**
- The full owner-consent UI round-trip (notification → approve → unblock) — `makePrompter` seam in Task 10; structural gate already complete + tested. Consult `nimbus-tauri-allowlist`.
- mDNS record parse/serialize detail — Task 6 skeleton; real broadcast behind the Task 15 skippable E2E.
- Exact integration-test harness path — confirm via `nimbus-testing` (Task 15).
- A handful of "confirm the real exported name" notes (runner entry point, `LocalIndex` constructor, `verifyAuditChain` return shape, `IPCClient` teardown) — verify against the file before writing the import; each is named precisely.

**Type consistency check:** `FederatedItem` keys are identical in `types.ts`, the `query-gate.ts` mapper, and the Task 9 leak-proof assertion (`id, modifiedAt, service, snippet, title, type`). `FederationDecision` values match between `types.ts`, `federation-audit.ts`, and the `query-gate.ts` `audit()` calls. `ConsentPrompter`/`ConsentDecision` names match between `query-gate.ts` and `federation-rpc.ts`.
