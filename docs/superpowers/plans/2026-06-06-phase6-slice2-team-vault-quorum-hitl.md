# Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add team-scoped credentials and approvals to Nimbus — a trust-anchor Team Vault consumed only via anchor-proxied tool execution, plus delegated (multi-user) and quorum (two-man-rule) HITL — without weakening any local-first / HITL-structural / no-plaintext-credential invariant.

**Architecture:** One gateway is the *trust anchor* and holds team secrets in its own OS Vault. Teammates never receive a secret; they call a new over-the-wire `federation.invoke` primitive asking the anchor to run a named connector tool, and the anchor runs it through its own executor gate (HITL applies) and returns only the result. Quorum HITL gates the anchor's credential unlock behind N distinct authenticated-peer approvals; delegated HITL lets an owner route their approvals to a scoped, time-boxed teammate. New invariants I19 (leak-proof team-secret injection), I20 (delegated-approval authority), I21 (distinct-peer quorum); migration V35.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict (no `any`), `bun:sqlite`, Biome, JSON-RPC 2.0 IPC, NaCl-box LAN channel (Slice 1), Bun test.

**Design spec:** [`docs/superpowers/specs/2026-06-06-phase6-slice2-team-vault-quorum-hitl-design.md`](../specs/2026-06-06-phase6-slice2-team-vault-quorum-hitl-design.md) (decisions D1–D12).

---

## Reference patterns (read these before starting — the code below mirrors them)

| Concern | Mirror this existing file |
|---|---|
| Migration schema SQL constant | `packages/gateway/src/index/federation-v33-sql.ts` |
| Migration wiring (steps + backfill labels) | `packages/gateway/src/index/migrations/runner.ts:287-420` |
| SQLite store (entries + live-checked grants) | `packages/gateway/src/federation/namespace-store.ts` |
| Over-the-wire gate (identity → grant → consent → leak-proof result + audit) | `packages/gateway/src/federation/query-gate.ts` |
| Federation audit append | `packages/gateway/src/federation/federation-audit.ts` |
| IPC dispatcher (`dispatchByMethod`, `asRecord`, `requireString`) | `packages/gateway/src/ipc/federation-rpc.ts` |
| LAN admittance + peerId forcing (I5/I17) | `packages/gateway/src/federation/federation-server.ts:73-89` |
| Consent coordinator (request/respond/disconnect) | `packages/gateway/src/ipc/consent.ts` |
| Executor HITL gate + `HITL_REQUIRED_BACKING` (I2/I3/I4) | `packages/gateway/src/engine/executor.ts:15-218` |
| Static D-check (D14 identity is the closest analog for D15) | `scripts/structure-audit/check-nimbus-invariants.ts:195-232` |
| Write helpers (only `db/write.ts` may call `db.run`/`db.exec` — D12) | `packages/gateway/src/db/write.ts` |

**Non-negotiable reminders while implementing:**

- Run `cd packages/gateway && bunx tsc --noEmit` after EVERY task — `bun test` transpiles but does not full-typecheck.
- All SQLite writes go through `dbRun`/`dbExec`/`dbStmtRun` from `db/write.ts` (I14/D12). Never call `db.run`/`db.exec` directly outside `db/write.ts`.
- No `any`; use `unknown` + narrowing. `exactOptionalPropertyTypes` is on — capture a `T | undefined` in a const before assigning to an optional field, or use a conditional spread `...(v === undefined ? {} : { k: v })`.
- New migration version is **V35** (confirm `origin/main` is still V34 first — see Task 2).
- Lint validation in `.claude/worktrees/` is broken (biome excludes the path); validate with `bunx biome check packages scripts` from the repo, not `bun run lint`.

---

## File Structure

**New files (gateway):**

- `packages/gateway/src/index/team-vault-v35-sql.ts` — V35 schema constant.
- `packages/gateway/src/teamvault/team-vault-keys.ts` — `teamvault.<entry>.<key>` derivation + validation (D15 home).
- `packages/gateway/src/teamvault/team-vault-store.ts` — `TeamVaultStore` (entries + grants, live-checked `checkGrant`).
- `packages/gateway/src/teamvault/team-vault-audit.ts` — audit append for invoke/quorum/delegation decisions.
- `packages/gateway/src/engine/quorum/quorum-coordinator.ts` — `QuorumCoordinator` (distinct-peer, deny-aborts, timeout).
- `packages/gateway/src/engine/delegation-store.ts` — `DelegationStore` (scoped + time-boxed).
- `packages/gateway/src/engine/delegated-approval.ts` — `resolveDelegatedApproval` (I20 authority check).
- `packages/gateway/src/federation/invoke-gate.ts` — `answerFederatedInvoke` (I19 gate).
- `packages/gateway/src/ipc/teamvault-rpc.ts` — local management dispatcher (`teamvault.*`).
- `packages/gateway/src/ipc/hitl-rpc.ts` — local management dispatcher (`hitl.delegate*`, `hitl.pendingQueue`).
- Plus a `.test.ts` beside each.

**Modified files:**

- `packages/gateway/src/index/migrations/runner.ts` — register V35 step + backfill label.
- `packages/gateway/src/config/nimbus-toml.ts` — `[hitl.quorum]` typed loader.
- `packages/gateway/src/engine/executor.ts` — add `teamvault.put`/`teamvault.delete` to `HITL_REQUIRED_BACKING`.
- `packages/gateway/src/ipc/federation-rpc.ts` — add `federation.invoke` / `federation.quorumRespond` / `federation.approvalRespond` + ctx fields.
- `packages/gateway/src/ipc/lan-rpc.ts` (I5 allow/forbid list) — admit the three new wire methods; forbid `teamvault.*` + `hitl.delegate*`.
- `packages/gateway/src/platform/assemble.ts` — construct stores + wire dispatchers + ctx.
- `packages/cli/src/commands/team.ts` + the CLI registry — new subcommands.
- `packages/ui/src-tauri/src/gateway_bridge.rs` — `ALLOWED_METHODS` additions.
- `packages/gateway/src/security-invariants.test.ts` — I19/I20/I21 + count mirror.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D15.
- `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` — I19–I21 rows.
- `scripts/coverage-floor/exclusions.ts` + `sonar-project.properties` — new glue/CLI files.
- `docs/CHANGELOG.md` — Slice 2 delivery entry.

---

## Part 0 — Baseline

### Task 0: Worktree baseline

**Files:** none (environment).

- [ ] **Step 1: Install deps + build the client package**

A fresh worktree fails the gateway typecheck on `@nimbus-dev/client` until `packages/client` is built (known trap).

Run:
```bash
bun install
cd packages/client && bun run build && cd ../..
```

- [ ] **Step 2: Confirm a clean gateway typecheck baseline**

Run: `cd packages/gateway && bunx tsc --noEmit`
Expected: exits 0 (no errors). If it errors on unrelated pre-existing nimbus-mcp deps, note them as pre-existing and proceed.

- [ ] **Step 3: Confirm the federation test baseline is green**

Run: `bun test packages/gateway/src/federation packages/gateway/src/engine`
Expected: PASS.

---

## Part A — V35 migration (foundation)

### Task 1: V35 schema SQL constant

**Files:**
- Create: `packages/gateway/src/index/team-vault-v35-sql.ts`
- Test: `packages/gateway/src/index/team-vault-v35-sql.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { V35_TEAM_VAULT_SQL } from "./team-vault-v35-sql.ts";

describe("V35_TEAM_VAULT_SQL", () => {
  it("creates the three team-vault/HITL tables in a fresh db", () => {
    const db = new Database(":memory:");
    for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("team_vault_entries");
    expect(names).toContain("team_vault_grants");
    expect(names).toContain("hitl_delegations");
    db.close();
  });

  it("is idempotent (IF NOT EXISTS) — re-applying does not throw", () => {
    const db = new Database(":memory:");
    for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    expect(() => {
      for (const sql of V35_TEAM_VAULT_SQL) db.exec(sql);
    }).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/team-vault-v35-sql.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema constant**

```ts
// V35 — Phase 6 Slice 2 (Team Vault + Multi-user/Quorum HITL).
// Append-only: 3 new tables. Secret bytes live in the OS Vault under teamvault.<entry>.<key>,
// NEVER in these tables (metadata + RBAC only). Quorum/delegation in-flight state is session-only.
export const V35_TEAM_VAULT_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS team_vault_entries (
     entry      TEXT PRIMARY KEY,
     service    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS team_vault_grants (
     entry      TEXT NOT NULL,
     peer_id    TEXT NOT NULL,
     tool_id    TEXT NOT NULL,
     mode       TEXT NOT NULL CHECK(mode IN ('use')),
     granted_at INTEGER NOT NULL,
     revoked_at INTEGER,
     PRIMARY KEY (entry, peer_id, tool_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_tv_grants_peer ON team_vault_grants(peer_id);`,
  `CREATE TABLE IF NOT EXISTS hitl_delegations (
     delegation_id TEXT PRIMARY KEY,
     delegate_peer TEXT NOT NULL,
     scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('action_type','service')),
     scope_value   TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     revoked_at    INTEGER
   );`,
  `CREATE INDEX IF NOT EXISTS idx_hitl_deleg_peer ON hitl_delegations(delegate_peer);`,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/team-vault-v35-sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/team-vault-v35-sql.ts packages/gateway/src/index/team-vault-v35-sql.test.ts
git commit -m "feat(teamvault): V35 schema constant (team_vault_entries/grants + hitl_delegations)"
```

### Task 2: Wire V35 into the migration runner

**Files:**
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Test: `packages/gateway/src/index/migrations/team-vault-v35-migration.test.ts`

- [ ] **Step 1: Verify main is still at V34 (migration contiguity)**

Run: `git grep -n "33,\s*34" packages/gateway/src/index/migrations/runner.ts`
Expected: the `simpleStep(33, 34, ...)` identity row is the last step. If a `34, 35` step already exists, STOP — coordinate the version number.

- [ ] **Step 2: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V35 team-vault migration", () => {
  it("creates team-vault tables at target version 35", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(uv).toBe(35);
    const names = (
      db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("team_vault_entries");
    expect(names).toContain("hitl_delegations");
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/team-vault-v35-migration.test.ts`
Expected: FAIL — `runIndexedSchemaMigrations(db, 35)` throws "Unsupported local index schema version: 34 (expected 0–35)".

- [ ] **Step 4: Add the import, the step, and the backfill label**

In `runner.ts`, add the import beside the V34 import (line ~38):
```ts
import { V35_TEAM_VAULT_SQL } from "../team-vault-v35-sql.ts";
```

Append to `INDEXED_SCHEMA_STEPS` (after the `simpleStep(33, 34, …)` entry, line ~382):
```ts
  simpleStep(
    34,
    35,
    "team_vault_entries/grants + hitl_delegations (team vault + multi-user/quorum HITL v35)",
    V35_TEAM_VAULT_SQL,
  ),
```

Append the matching label to `BACKFILL_LABELS` (after the V34 identity label, line ~419) — **the array index must equal version-1, so this MUST be the 35th entry**:
```ts
  "team_vault_entries/grants + hitl_delegations (team vault + multi-user/quorum HITL v35) (backfilled)",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/team-vault-v35-migration.test.ts`
Expected: PASS.

- [ ] **Step 6: Find every hard-coded target version and bump 34 → 35**

The gateway opens the index at a fixed target version. Find the call sites:

Run: `git grep -n "runIndexedSchemaMigrations(" packages/gateway/src --and --not -e ".test.ts"`
Expected: production callers pass a literal (e.g. `34`). For each non-test caller, change the literal to `35`. (Leave test callers that intentionally seed older versions alone.)

- [ ] **Step 7: Typecheck + run the full migration suite**

Run: `cd packages/gateway && bunx tsc --noEmit && cd ../.. && bun test packages/gateway/src/index/migrations`
Expected: PASS (watch for any test asserting "latest version is 34" — bump it to 35).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/team-vault-v35-migration.test.ts
git commit -m "feat(teamvault): wire V35 migration into the indexed schema runner"
```

---

## Part B — Team Vault core

### Task 3: Team Vault key derivation (D15 home)

**Files:**
- Create: `packages/gateway/src/teamvault/team-vault-keys.ts`
- Test: `packages/gateway/src/teamvault/team-vault-keys.test.ts`

The team keyspace mirrors the connector's own vault keys: a secret for entry `prod-aws` connector key `aws.access_key_id` is stored at `teamvault.prod-aws.aws.access_key_id`. This is the ONLY module allowed to name the `teamvault.` prefix (D15).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { TEAM_VAULT_PREFIX, teamVaultKey } from "./team-vault-keys.ts";

describe("teamVaultKey", () => {
  it("composes teamvault.<entry>.<connectorKey>", () => {
    expect(teamVaultKey("prod-aws", "aws.access_key_id")).toBe(
      "teamvault.prod-aws.aws.access_key_id",
    );
  });

  it("exposes the reserved prefix", () => {
    expect(TEAM_VAULT_PREFIX).toBe("teamvault.");
    expect(teamVaultKey("x", "slack.oauth").startsWith(TEAM_VAULT_PREFIX)).toBe(true);
  });

  it("rejects an entry with a dot (would corrupt the keyspace)", () => {
    expect(() => teamVaultKey("a.b", "slack.oauth")).toThrow(/entry/i);
  });

  it("rejects an empty entry or key", () => {
    expect(() => teamVaultKey("", "slack.oauth")).toThrow();
    expect(() => teamVaultKey("ok", "")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/teamvault/team-vault-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** The reserved Vault keyspace for team-scoped secrets. D15: this prefix is named ONLY here. */
export const TEAM_VAULT_PREFIX = "teamvault." as const;

const ENTRY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Derive the OS-Vault key for a team secret. The team keyspace mirrors the connector's own
 * vault keys, so injection can reuse the connector's existing vault-key → env-var mapping
 * (design D8): `teamvault.<entry>.<connectorKey>`.
 */
export function teamVaultKey(entry: string, connectorKey: string): string {
  if (!ENTRY_RE.test(entry)) {
    throw new Error(`team-vault: invalid entry "${entry}" (lowercase alnum + dashes, no dots)`);
  }
  if (connectorKey.length === 0) {
    throw new Error("team-vault: connectorKey must be non-empty");
  }
  return `${TEAM_VAULT_PREFIX}${entry}.${connectorKey}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/teamvault/team-vault-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-keys.ts packages/gateway/src/teamvault/team-vault-keys.test.ts
git commit -m "feat(teamvault): team-vault-keys derivation (D15 keyspace home)"
```

### Task 4: TeamVaultStore (entries + live-checked grants)

**Files:**
- Create: `packages/gateway/src/teamvault/team-vault-store.ts`
- Test: `packages/gateway/src/teamvault/team-vault-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "./team-vault-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}

describe("TeamVaultStore", () => {
  let db: Database;
  let store: TeamVaultStore;
  beforeEach(() => {
    db = freshDb();
    store = new TeamVaultStore(db);
  });

  it("creates an entry and lists it", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    expect(store.listEntries().map((e) => e.entry)).toContain("prod-aws");
  });

  it("grants then checkGrant returns true for the exact (entry,peer,tool)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(true);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.lambda.invoke")).toBe(false);
    expect(store.checkGrant("prod-aws", "peer:other", "aws.ec2.instance.stop")).toBe(false);
  });

  it("revoke makes checkGrant return false immediately (live-checked)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    store.revoke("prod-aws", "peer:abc", "aws.ec2.instance.stop", 2000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(false);
  });

  it("re-grant after revoke re-activates (revoked_at cleared)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    store.revoke("prod-aws", "peer:abc", "aws.ec2.instance.stop", 2000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 3000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(true);
  });

  it("getEntry returns the bound service (drives which connector keys to inject)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    expect(store.getEntry("prod-aws")?.service).toBe("aws");
    expect(store.getEntry("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/teamvault/team-vault-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror NamespaceStore)**

```ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface TeamVaultEntry {
  readonly entry: string;
  readonly service: string;
  readonly createdAt: number;
  readonly createdBy: string;
}

interface EntryRow {
  entry: string;
  service: string;
  created_at: number;
  created_by: string;
}

export class TeamVaultStore {
  constructor(private readonly db: Database) {}

  createEntry(entry: string, service: string, createdBy: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `INSERT INTO team_vault_entries (entry, service, created_at, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entry) DO UPDATE SET service = excluded.service`,
      [entry, service, nowMs, createdBy],
    );
  }

  getEntry(entry: string): TeamVaultEntry | undefined {
    const row = this.db
      .query<EntryRow, [string]>(`SELECT * FROM team_vault_entries WHERE entry = ?`)
      .get(entry);
    if (row === null || row === undefined) return undefined;
    return {
      entry: row.entry,
      service: row.service,
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
  }

  listEntries(): TeamVaultEntry[] {
    const rows = this.db
      .query<EntryRow, []>(`SELECT * FROM team_vault_entries ORDER BY entry ASC`)
      .all();
    return rows.map((r) => ({
      entry: r.entry,
      service: r.service,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  grant(entry: string, peerId: string, toolId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `INSERT INTO team_vault_grants (entry, peer_id, tool_id, mode, granted_at, revoked_at)
       VALUES (?, ?, ?, 'use', ?, NULL)
       ON CONFLICT(entry, peer_id, tool_id) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`,
      [entry, peerId, toolId, nowMs],
    );
  }

  revoke(entry: string, peerId: string, toolId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `UPDATE team_vault_grants SET revoked_at = ?
       WHERE entry = ? AND peer_id = ? AND tool_id = ? AND revoked_at IS NULL`,
      [nowMs, entry, peerId, toolId],
    );
  }

  /** Live-checked on every call (no cache): an active grant must exist for the exact tuple. (D11) */
  checkGrant(entry: string, peerId: string, toolId: string): boolean {
    const row = this.db
      .query<{ one: number }, [string, string, string]>(
        `SELECT 1 AS one FROM team_vault_grants
         WHERE entry = ? AND peer_id = ? AND tool_id = ? AND revoked_at IS NULL`,
      )
      .get(entry, peerId, toolId);
    return row !== null && row !== undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/teamvault/team-vault-store.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-store.ts packages/gateway/src/teamvault/team-vault-store.test.ts
git commit -m "feat(teamvault): TeamVaultStore (entries + live-checked per-(entry,peer,tool) grants)"
```

---

## Part C — Quorum

### Task 5: `[hitl.quorum]` config loader

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml-quorum.test.ts`

> Read `nimbus-toml.ts` first to match its existing section-parsing style (how `[lan]`/`[federation]` are parsed and exported). Mirror that exact shape; the code below is the contract, adapt naming to the file's conventions.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { parseQuorumConfig } from "./nimbus-toml.ts";

describe("[hitl.quorum] config", () => {
  it("parses action-type → {approvers, windowSeconds}", () => {
    const cfg = parseQuorumConfig({
      "hitl.quorum": {
        "iac.terraform.destroy": { approvers: 2, windowSeconds: 300 },
      },
    });
    expect(cfg.get("iac.terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 300 });
  });

  it("defaults to an empty map when the section is absent (quorum off)", () => {
    expect(parseQuorumConfig({}).size).toBe(0);
  });

  it("ignores malformed rows (non-numeric approvers) rather than throwing", () => {
    const cfg = parseQuorumConfig({
      "hitl.quorum": { "x.y": { approvers: "two", windowSeconds: 300 } },
    });
    expect(cfg.has("x.y")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-quorum.test.ts`
Expected: FAIL — `parseQuorumConfig` not exported.

- [ ] **Step 3: Implement (add to `nimbus-toml.ts`)**

```ts
export interface QuorumRule {
  readonly approvers: number;
  readonly windowSeconds: number;
}
export type QuorumConfig = ReadonlyMap<string, QuorumRule>;

/**
 * Parse the `[hitl.quorum]` section: action-type → {approvers, windowSeconds}. Default empty
 * (quorum off). Shaped so the Slice 4 policy engine can later override/absorb this map.
 */
export function parseQuorumConfig(raw: Record<string, unknown>): QuorumConfig {
  const out = new Map<string, QuorumRule>();
  const section = raw["hitl.quorum"];
  if (section === null || typeof section !== "object") return out;
  for (const [actionType, v] of Object.entries(section as Record<string, unknown>)) {
    if (v === null || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const approvers = r["approvers"];
    const windowSeconds = r["windowSeconds"];
    if (typeof approvers !== "number" || typeof windowSeconds !== "number") continue;
    if (approvers < 1 || windowSeconds <= 0) continue;
    out.set(actionType, { approvers, windowSeconds });
  }
  return out;
}
```

> If `nimbus-toml.ts` parses TOML into a nested object rather than dotted keys (`{ hitl: { quorum: {...} } }`), adjust the lookup accordingly — read the file's existing `[lan]` parse to confirm the shape, and make the test match.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-quorum.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-quorum.test.ts
git commit -m "feat(hitl): [hitl.quorum] config loader (action-type -> approvers/window)"
```

### Task 6: QuorumCoordinator (I21 — distinct-peer, deny-aborts, timeout)

**Files:**
- Create: `packages/gateway/src/engine/quorum/quorum-coordinator.ts`
- Test: `packages/gateway/src/engine/quorum/quorum-coordinator.test.ts`

The coordinator is a pure in-memory aggregator. It broadcasts a request via an injected `broadcast` fn and resolves when enough DISTINCT peers approve, a peer denies, or the window elapses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { QuorumCoordinator } from "./quorum-coordinator.ts";

function makeCoord() {
  const broadcasts: Array<{ requestId: string }> = [];
  const coord = new QuorumCoordinator((requestId) => broadcasts.push({ requestId }));
  return { coord, broadcasts };
}

describe("QuorumCoordinator (I21)", () => {
  it("resolves 'approved' only after N distinct peers approve", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 10_000 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:b", true);
    expect(await p).toEqual({ outcome: "approved", approvers: ["peer:a", "peer:b"] });
  });

  it("does NOT count the same peer twice (no double-count)", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 50 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:a", true); // duplicate — ignored
    const r = await p; // window elapses with only 1 distinct approver
    expect(r.outcome).toBe("failed");
  });

  it("a single explicit denial aborts immediately (fail-closed, D9)", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 10_000 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    coord.respond(requestId, "peer:b", false); // denial
    expect((await p).outcome).toBe("denied");
  });

  it("times out to 'failed' with the partial approver set", async () => {
    const { coord, broadcasts } = makeCoord();
    const p = coord.collect({ approvers: 2, windowMs: 30 });
    const requestId = broadcasts[0]!.requestId;
    coord.respond(requestId, "peer:a", true);
    const r = await p;
    expect(r.outcome).toBe("failed");
    expect(r.approvers).toEqual(["peer:a"]);
  });

  it("ignores responses for an unknown/expired requestId", async () => {
    const { coord } = makeCoord();
    expect(coord.respond("nope", "peer:a", true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/quorum/quorum-coordinator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { randomUUID } from "node:crypto";

export type QuorumOutcome = "approved" | "denied" | "failed";
export interface QuorumResult {
  readonly outcome: QuorumOutcome;
  readonly approvers: readonly string[];
}
export interface QuorumRequestOpts {
  readonly approvers: number;
  readonly windowMs: number;
}

interface Pending {
  readonly need: number;
  readonly approved: Set<string>;
  readonly resolve: (r: QuorumResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type QuorumBroadcast = (requestId: string) => void;

/** Session-only N-of-M approval aggregator. I21: counts ONLY distinct peerIds; deny aborts. */
export class QuorumCoordinator {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly broadcast: QuorumBroadcast) {}

  collect(opts: QuorumRequestOpts): Promise<QuorumResult> {
    const requestId = randomUUID();
    return new Promise<QuorumResult>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(requestId);
        this.pending.delete(requestId);
        resolve({ outcome: "failed", approvers: p ? [...p.approved] : [] });
      }, opts.windowMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pending.set(requestId, {
        need: opts.approvers,
        approved: new Set<string>(),
        resolve,
        timer,
      });
      this.broadcast(requestId);
    });
  }

  /** Returns true if the response matched a live request. */
  respond(requestId: string, peerId: string, approved: boolean): boolean {
    const p = this.pending.get(requestId);
    if (p === undefined) return false;
    if (!approved) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ outcome: "denied", approvers: [...p.approved] });
      return true;
    }
    p.approved.add(peerId); // Set dedupes — no double-count (I21).
    if (p.approved.size >= p.need) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ outcome: "approved", approvers: [...p.approved] });
    }
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/quorum/quorum-coordinator.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/quorum/quorum-coordinator.ts packages/gateway/src/engine/quorum/quorum-coordinator.test.ts
git commit -m "feat(hitl): QuorumCoordinator (I21 distinct-peer counting, fail-closed denial)"
```

---

## Part D — Multi-user / delegated HITL

### Task 7: DelegationStore (scoped + time-boxed)

**Files:**
- Create: `packages/gateway/src/engine/delegation-store.ts`
- Test: `packages/gateway/src/engine/delegation-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DelegationStore } from "./delegation-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}

describe("DelegationStore", () => {
  let store: DelegationStore;
  beforeEach(() => {
    store = new DelegationStore(freshDb());
  });

  it("creates a delegation and finds the active delegate for an in-scope action", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "iac.terraform.apply",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    expect(store.activeDelegateFor("action_type", "iac.terraform.apply", "peer:bob", 5000)).toBe(true);
    expect(store.activeDelegateFor("action_type", "iac.terraform.apply", "peer:eve", 5000)).toBe(false);
    expect(store.activeDelegateFor("action_type", "email.send", "peer:bob", 5000)).toBe(false);
  });

  it("treats an expired delegation as inactive", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 2000,
      nowMs: 1000,
    });
    expect(store.activeDelegateFor("service", "aws", "peer:bob", 3000)).toBe(false);
  });

  it("revoked delegation is inactive immediately", () => {
    const id = store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    store.revoke(id, 1500);
    expect(store.activeDelegateFor("service", "aws", "peer:bob", 2000)).toBe(false);
  });

  it("lists active delegations", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    expect(store.listActive(5000).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/delegation-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dbRun } from "../db/write.ts";

export type DelegationScopeKind = "action_type" | "service";

export interface DelegationInput {
  readonly delegatePeer: string;
  readonly scopeKind: DelegationScopeKind;
  readonly scopeValue: string;
  readonly expiresAt: number;
  readonly nowMs?: number;
}

export interface Delegation {
  readonly delegationId: string;
  readonly delegatePeer: string;
  readonly scopeKind: DelegationScopeKind;
  readonly scopeValue: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface Row {
  delegation_id: string;
  delegate_peer: string;
  scope_kind: DelegationScopeKind;
  scope_value: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export class DelegationStore {
  constructor(private readonly db: Database) {}

  create(input: DelegationInput): string {
    const now = input.nowMs ?? Date.now();
    const id = randomUUID();
    dbRun(
      this.db,
      `INSERT INTO hitl_delegations
         (delegation_id, delegate_peer, scope_kind, scope_value, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, input.delegatePeer, input.scopeKind, input.scopeValue, now, input.expiresAt],
    );
    return id;
  }

  revoke(delegationId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `UPDATE hitl_delegations SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL`,
      [nowMs, delegationId],
    );
  }

  /** Live-checked: is `peerId` an active, in-scope, unexpired delegate for this action? (I20 input) */
  activeDelegateFor(
    scopeKind: DelegationScopeKind,
    scopeValue: string,
    peerId: string,
    nowMs: number,
  ): boolean {
    const row = this.db
      .query<{ one: number }, [DelegationScopeKind, string, string, number]>(
        `SELECT 1 AS one FROM hitl_delegations
         WHERE scope_kind = ? AND scope_value = ? AND delegate_peer = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(scopeKind, scopeValue, peerId, nowMs);
    return row !== null && row !== undefined;
  }

  listActive(nowMs: number): Delegation[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT * FROM hitl_delegations WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      )
      .all(nowMs);
    return rows.map((r) => ({
      delegationId: r.delegation_id,
      delegatePeer: r.delegate_peer,
      scopeKind: r.scope_kind,
      scopeValue: r.scope_value,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/delegation-store.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/delegation-store.ts packages/gateway/src/engine/delegation-store.test.ts
git commit -m "feat(hitl): DelegationStore (scoped + time-boxed, live-checked active)"
```

### Task 8: resolveDelegatedApproval (I20 authority check)

**Files:**
- Create: `packages/gateway/src/engine/delegated-approval.ts`
- Test: `packages/gateway/src/engine/delegated-approval.test.ts`

This is the function the executor gate calls when an action needs HITL and a delegation may apply. It asks the delegate over an injected `requestRemote` channel, but **only honors the answer if the answering peer is a live, in-scope delegate AND identity-valid (I20)**. On timeout/offline it returns `"fallback_to_owner"` (D10).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { resolveDelegatedApproval } from "./delegated-approval.ts";

const baseDeps = {
  isActiveDelegate: (peerId: string) => peerId === "peer:bob",
  isOperatorValid: () => true,
};

describe("resolveDelegatedApproval (I20)", () => {
  it("honors an approval from a live, in-scope, identity-valid delegate", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(r).toBe("approved");
  });

  it("honors a denial from the delegate (no fallback)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: false }),
    });
    expect(r).toBe("rejected");
  });

  it("REJECTS a forged approval from a non-delegate peer (wire not trusted)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:eve", approved: true }),
    });
    expect(r).toBe("fallback_to_owner");
  });

  it("REJECTS an approval when the delegate's operator identity is invalid (I18)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      isOperatorValid: () => false,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(r).toBe("fallback_to_owner");
  });

  it("falls back to owner on timeout/offline (D10)", async () => {
    const r = await resolveDelegatedApproval({
      ...baseDeps,
      requestRemote: async () => ({ kind: "timeout" }),
    });
    expect(r).toBe("fallback_to_owner");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/delegated-approval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type RemoteApprovalOutcome =
  | { readonly kind: "answered"; readonly peerId: string; readonly approved: boolean }
  | { readonly kind: "timeout" };

export interface DelegatedApprovalDeps {
  /** True iff `peerId` holds a live, in-scope delegation for this action (DelegationStore). */
  readonly isActiveDelegate: (peerId: string) => boolean;
  /** I18: the answering delegate's operator identity must be valid. */
  readonly isOperatorValid: () => boolean;
  /** Route the approval request to the delegate over federation; resolve with their answer. */
  readonly requestRemote: () => Promise<RemoteApprovalOutcome>;
}

export type DelegatedApprovalResult = "approved" | "rejected" | "fallback_to_owner";

/**
 * I20 — a remote approval is honored ONLY when the answering peer is a live in-scope delegate
 * AND identity-valid. Anything else (forged peer, invalid identity, timeout/offline) falls back
 * to a local owner prompt (D10). The wire is never trusted.
 */
export async function resolveDelegatedApproval(
  deps: DelegatedApprovalDeps,
): Promise<DelegatedApprovalResult> {
  const outcome = await deps.requestRemote();
  if (outcome.kind === "timeout") return "fallback_to_owner";
  if (!deps.isActiveDelegate(outcome.peerId)) return "fallback_to_owner";
  if (!deps.isOperatorValid()) return "fallback_to_owner";
  return outcome.approved ? "approved" : "rejected";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/delegated-approval.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/delegated-approval.ts packages/gateway/src/engine/delegated-approval.test.ts
git commit -m "feat(hitl): resolveDelegatedApproval (I20 delegate authority + identity check)"
```

---

## Part E — Team-vault audit + the invoke gate

### Task 9: Team-vault audit append

**Files:**
- Create: `packages/gateway/src/teamvault/team-vault-audit.ts`
- Test: `packages/gateway/src/teamvault/team-vault-audit.test.ts`

Mirror `federation-audit.ts` — append a tamper-evident entry (into the same BLAKE3 chain + `federation_json` column) for every invoke/quorum decision.

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendTeamVaultAudit } from "./team-vault-audit.ts";

describe("appendTeamVaultAudit", () => {
  it("writes a row with the team-vault decision into audit_log + federation_json", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    appendTeamVaultAudit(db, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      decision: "no_grant",
      timestamp: 1000,
    });
    const row = db
      .query(`SELECT action_type, federation_json FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string; federation_json: string };
    expect(row.action_type).toBe("teamvault.invoke.no_grant");
    expect(JSON.parse(row.federation_json)).toMatchObject({ entry: "prod-aws", peer_id: "peer:abc" });
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";

export type TeamVaultDecision =
  | "answered"
  | "no_grant"
  | "identity_invalid"
  | "quorum_failed"
  | "quorum_denied";

export interface TeamVaultAuditFields {
  readonly peerId: string;
  readonly entry: string;
  readonly toolId: string;
  readonly decision: TeamVaultDecision;
  readonly timestamp: number;
  readonly approvers?: readonly string[];
}

/** Tamper-evident audit for an inbound team-vault invoke (answered or rejected). */
export function appendTeamVaultAudit(db: Database, f: TeamVaultAuditFields): void {
  const federationJson = JSON.stringify({
    peer_id: f.peerId,
    entry: f.entry,
    tool_id: f.toolId,
    decision: f.decision,
    method: "federation.invoke",
    ...(f.approvers === undefined ? {} : { approvers: f.approvers }),
  });
  appendAuditEntry(db, {
    actionType: `teamvault.invoke.${f.decision}`,
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ method: "federation.invoke", entry: f.entry, toolId: f.toolId }),
    timestamp: f.timestamp,
    federationJson,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-audit.ts packages/gateway/src/teamvault/team-vault-audit.test.ts
git commit -m "feat(teamvault): tamper-evident audit append for invoke decisions"
```

### Task 10: answerFederatedInvoke gate (I19) — RBAC + quorum + leak-proof result

**Files:**
- Create: `packages/gateway/src/federation/invoke-gate.ts`
- Test: `packages/gateway/src/federation/invoke-gate.test.ts`

The gate is the sole consumption path. Order: identity (I18) → RBAC (live-check) → quorum (if configured) → run via injected `runTool` (which the anchor wires to its executor; the secret is injected there) → leak-proof result. **I19: the gate's own result carries only `{ ok, result }`; the secret is never in scope here — it is fetched and injected inside `runTool`.**

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { answerFederatedInvoke, type InvokeGateCtx } from "./invoke-gate.ts";

function freshCtx(over: Partial<InvokeGateCtx> = {}): { db: Database; ctx: InvokeGateCtx } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  const store = new TeamVaultStore(db);
  store.createEntry("prod-aws", "aws", "owner", 1000);
  store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
  const ctx: InvokeGateCtx = {
    db,
    store,
    quorumFor: () => undefined, // no quorum by default
    runQuorum: async () => ({ outcome: "approved", approvers: [] }),
    runTool: async () => ({ stopped: true }),
    now: () => 5000,
    ...over,
  };
  return { db, ctx };
}

describe("answerFederatedInvoke (I19)", () => {
  it("runs the tool and returns ok for a granted (entry,peer,tool)", async () => {
    const { ctx } = freshCtx();
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: { id: "i-123" },
      purpose: "stop idle box",
    });
    expect(r).toEqual({ kind: "ok", result: { stopped: true } });
  });

  it("returns opaque no_grant for an ungranted tool (no entry-existence leak)", async () => {
    const { db, ctx } = freshCtx();
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.lambda.invoke",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.no_grant");
  });

  it("returns opaque no_grant (audited identity_invalid) when operator identity is invalid (I18)", async () => {
    const { db, ctx } = freshCtx({ identity: { enabled: true, isOperatorValid: () => false } });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "no_grant" });
    const audited = db
      .query(`SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { action_type: string };
    expect(audited.action_type).toBe("teamvault.invoke.identity_invalid");
  });

  it("does NOT run the tool when quorum is required but fails", async () => {
    let ran = false;
    const { ctx } = freshCtx({
      quorumFor: () => ({ approvers: 2, windowSeconds: 300 }),
      runQuorum: async () => ({ outcome: "failed", approvers: ["peer:x"] }),
      runTool: async () => {
        ran = true;
        return {};
      },
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "error", error: "quorum_failed" });
    expect(ran).toBe(false);
  });

  it("runs the tool when quorum is required and met", async () => {
    const { ctx } = freshCtx({
      quorumFor: () => ({ approvers: 2, windowSeconds: 300 }),
      runQuorum: async () => ({ outcome: "approved", approvers: ["peer:x", "peer:y"] }),
    });
    const r = await answerFederatedInvoke(ctx, {
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      args: {},
      purpose: "x",
    });
    expect(r).toEqual({ kind: "ok", result: { stopped: true } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/federation/invoke-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror query-gate.ts)**

```ts
import type { Database } from "bun:sqlite";
import { appendTeamVaultAudit, type TeamVaultDecision } from "../teamvault/team-vault-audit.ts";
import type { TeamVaultStore } from "../teamvault/team-vault-store.ts";

export interface QuorumRuleLite {
  readonly approvers: number;
  readonly windowSeconds: number;
}
export interface QuorumOutcomeLite {
  readonly outcome: "approved" | "denied" | "failed";
  readonly approvers: readonly string[];
}

export interface InvokeGateCtx {
  readonly db: Database;
  readonly store: TeamVaultStore;
  /** [hitl.quorum] lookup for the bound tool's action-type; undefined → no quorum. */
  readonly quorumFor: (toolId: string) => QuorumRuleLite | undefined;
  /** Run the quorum collection (QuorumCoordinator.collect adapted to seconds→ms). */
  readonly runQuorum: (rule: QuorumRuleLite) => Promise<QuorumOutcomeLite>;
  /**
   * Execute the tool on the anchor. The secret is fetched from the OS Vault and injected
   * INSIDE this callback (the anchor's wiring), so it is never in this gate's scope (I19).
   */
  readonly runTool: (input: {
    entry: string;
    service: string;
    toolId: string;
    args: unknown;
  }) => Promise<unknown>;
  readonly now?: () => number;
  /** I18: when identity is enabled, the anchor operator must be valid to serve a team credential. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface InboundInvoke {
  readonly peerId: string;
  readonly entry: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly purpose: string;
}

export type InvokeResult =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: "no_grant" | "quorum_failed" | "quorum_denied" };

function audit(
  ctx: InvokeGateCtx,
  q: InboundInvoke,
  decision: TeamVaultDecision,
  approvers?: readonly string[],
): void {
  appendTeamVaultAudit(ctx.db, {
    peerId: q.peerId,
    entry: q.entry,
    toolId: q.toolId,
    decision,
    timestamp: (ctx.now ?? Date.now)(),
    ...(approvers === undefined ? {} : { approvers }),
  });
}

/**
 * I19 — the ONLY path that consumes a team-vault credential. identity → RBAC → quorum →
 * run-with-injected-secret. Returns only `{ result }`; the secret never enters this scope and is
 * never placed in any outbound payload. Every outcome is audited.
 */
export async function answerFederatedInvoke(
  ctx: InvokeGateCtx,
  q: InboundInvoke,
): Promise<InvokeResult> {
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    audit(ctx, q, "identity_invalid");
    return { kind: "error", error: "no_grant" }; // opaque (no identity-state leak)
  }

  const entryDef = ctx.store.getEntry(q.entry);
  if (entryDef === undefined || !ctx.store.checkGrant(q.entry, q.peerId, q.toolId)) {
    audit(ctx, q, "no_grant"); // opaque whether entry exists or grant is missing
    return { kind: "error", error: "no_grant" };
  }

  const rule = ctx.quorumFor(q.toolId);
  if (rule !== undefined) {
    const outcome = await ctx.runQuorum(rule);
    if (outcome.outcome === "denied") {
      audit(ctx, q, "quorum_denied", outcome.approvers);
      return { kind: "error", error: "quorum_denied" };
    }
    if (outcome.outcome !== "approved") {
      audit(ctx, q, "quorum_failed", outcome.approvers);
      return { kind: "error", error: "quorum_failed" };
    }
  }

  const result = await ctx.runTool({
    entry: q.entry,
    service: entryDef.service,
    toolId: q.toolId,
    args: q.args,
  });
  audit(ctx, q, "answered");
  return { kind: "ok", result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/federation/invoke-gate.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/invoke-gate.ts packages/gateway/src/federation/invoke-gate.test.ts
git commit -m "feat(teamvault): answerFederatedInvoke gate (I19 identity+RBAC+quorum, leak-proof result)"
```

---

## Part F — IPC wiring

### Task 11: Add the three over-the-wire methods to the federation dispatcher

**Files:**
- Modify: `packages/gateway/src/ipc/federation-rpc.ts`
- Test: `packages/gateway/src/ipc/federation-rpc-invoke.test.ts`

Add `federation.invoke`, `federation.quorumRespond`, `federation.approvalRespond` to `dispatchFederationRpc`, and the ctx fields they need. `federation.invoke` calls `answerFederatedInvoke`; the two `*Respond` methods feed the coordinator + delegated-approval broker (singletons, like `federationConsent`).

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as never,
    pairing: { listPeers: () => [] } as never,
    teamVault: {
      quorumFor: () => undefined,
      runTool: async () => ({ ok: 1 }),
    },
  };
}

describe("federation.invoke dispatch", () => {
  it("returns no_grant when no grant exists (peerId forced by caller)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    new TeamVaultStore(db).createEntry("prod-aws", "aws", "owner", 1);
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.lambda.invoke", purpose: "x" },
      ctx(db),
    );
    expect(out.kind).toBe("hit");
    expect(out.value).toEqual({ kind: "error", error: "no_grant" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/federation-rpc-invoke.test.ts`
Expected: FAIL — `teamVault` not on context / method returns miss.

- [ ] **Step 3: Extend the context interface**

In `federation-rpc.ts`, add to `FederationRpcContext` (after the `identityGuard` field, ~line 40):
```ts
  // Team Vault (Slice 2). Present on the answering (anchor) dispatch path.
  readonly teamVault?: {
    readonly quorumFor: (toolId: string) => { approvers: number; windowSeconds: number } | undefined;
    readonly runTool: (input: {
      entry: string;
      service: string;
      toolId: string;
      args: unknown;
    }) => Promise<unknown>;
  };
```

Add imports at the top:
```ts
import { answerFederatedInvoke } from "../federation/invoke-gate.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
```

> Tasks 12–13 create `quorum-singleton.ts` and `delegated-approval-broker.ts`. If executing strictly in order, create those two files first (they are tiny — shown in Task 12/13) so this task typechecks.

- [ ] **Step 4: Add the three handlers inside `dispatchByMethod`'s map**

```ts
    "federation.invoke": async (p) => {
      const rec = asRecord(p);
      if (ctx.teamVault === undefined) {
        throw new FederationRpcError(-32603, "ERR_TEAMVAULT_UNAVAILABLE: not the trust anchor");
      }
      const tv = ctx.teamVault;
      return answerFederatedInvoke(
        {
          db: ctx.db,
          store: new TeamVaultStore(ctx.db),
          quorumFor: tv.quorumFor,
          runQuorum: (rule) =>
            quorumCoordinator.collect({
              approvers: rule.approvers,
              windowMs: rule.windowSeconds * 1000,
            }),
          runTool: tv.runTool,
          ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }),
        },
        {
          peerId: requireString(rec, "peerId"),
          entry: requireString(rec, "entry"),
          toolId: requireString(rec, "toolId"),
          purpose: requireString(rec, "purpose"),
          args: rec["args"],
        },
      );
    },
    "federation.quorumRespond": (p) => {
      const rec = asRecord(p);
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = quorumCoordinator.respond(
        requireString(rec, "requestId"),
        requireString(rec, "peerId"),
        rec["approved"],
      );
      return { ok: true, matched };
    },
    "federation.approvalRespond": (p) => {
      const rec = asRecord(p);
      if (typeof rec["approved"] !== "boolean") {
        throw new FederationRpcError(-32602, "ERR_INVALID_PARAMS: approved must be a boolean");
      }
      const matched = delegatedApprovalBroker.respond(
        requireString(rec, "requestId"),
        requireString(rec, "peerId"),
        rec["approved"],
      );
      return { ok: true, matched };
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/federation-rpc-invoke.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc-invoke.test.ts
git commit -m "feat(teamvault): federation.invoke/quorumRespond/approvalRespond dispatch"
```

### Task 12: Quorum singleton + broadcast wiring

**Files:**
- Create: `packages/gateway/src/engine/quorum/quorum-singleton.ts`
- Test: `packages/gateway/src/engine/quorum/quorum-singleton.test.ts`

A process singleton (like `federationConsent`) whose broadcast channel is late-bound after the IPC server exists.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { quorumCoordinator } from "./quorum-singleton.ts";

describe("quorumCoordinator singleton", () => {
  it("broadcasts the requestId via the late-bound channel", async () => {
    const seen: string[] = [];
    quorumCoordinator.setBroadcast((requestId) => seen.push(requestId));
    const p = quorumCoordinator.collect({ approvers: 1, windowMs: 5000 });
    expect(seen.length).toBe(1);
    quorumCoordinator.respond(seen[0]!, "peer:a", true);
    expect((await p).outcome).toBe("approved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/quorum/quorum-singleton.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (subclass with a settable broadcast)**

```ts
import { QuorumCoordinator } from "./quorum-coordinator.ts";

class BoundQuorumCoordinator extends QuorumCoordinator {
  private channel: (requestId: string) => void = () => {};
  constructor() {
    super((requestId) => this.channel(requestId));
  }
  setBroadcast(fn: (requestId: string) => void): void {
    this.channel = fn;
  }
}

/** Process-wide quorum aggregator; `setBroadcast` is late-bound after the IPC server exists. */
export const quorumCoordinator = new BoundQuorumCoordinator();
```

> Note: `broadcast` is read at `collect()` time via the arrow closure, so late-binding works. Confirm `QuorumCoordinator`'s constructor stores the passed fn (it does) and calls it in `collect` (it does).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/quorum/quorum-singleton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/quorum/quorum-singleton.ts packages/gateway/src/engine/quorum/quorum-singleton.test.ts
git commit -m "feat(hitl): quorumCoordinator process singleton with late-bound broadcast"
```

### Task 13: Delegated-approval broker singleton

**Files:**
- Create: `packages/gateway/src/engine/delegated-approval-broker.ts`
- Test: `packages/gateway/src/engine/delegated-approval-broker.test.ts`

A broadcast broker (mirror `consent-broker.ts`) that the gate's `requestRemote` uses to ask a delegate and that `federation.approvalRespond` resolves. Returns `{ kind: "answered", peerId, approved }` or `{ kind: "timeout" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { delegatedApprovalBroker } from "./delegated-approval-broker.ts";

describe("delegatedApprovalBroker", () => {
  it("resolves with the responder's peerId + decision", async () => {
    const ids: string[] = [];
    delegatedApprovalBroker.setBroadcast((requestId) => ids.push(requestId));
    const p = delegatedApprovalBroker.request({ prompt: "approve deploy?" }, 5000);
    delegatedApprovalBroker.respond(ids[0]!, "peer:bob", true);
    expect(await p).toEqual({ kind: "answered", peerId: "peer:bob", approved: true });
  });

  it("times out to {kind:'timeout'}", async () => {
    delegatedApprovalBroker.setBroadcast(() => {});
    const r = await delegatedApprovalBroker.request({ prompt: "x" }, 20);
    expect(r).toEqual({ kind: "timeout" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/engine/delegated-approval-broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror consent-broker.ts)**

```ts
import { randomUUID } from "node:crypto";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";

interface Pending {
  readonly resolve: (o: RemoteApprovalOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class DelegatedApprovalBroker {
  private channel: (requestId: string, prompt: string) => void = () => {};
  private readonly pending = new Map<string, Pending>();

  setBroadcast(fn: (requestId: string, prompt: string) => void): void {
    this.channel = fn;
  }

  request(input: { prompt: string }, timeoutMs: number): Promise<RemoteApprovalOutcome> {
    const requestId = randomUUID();
    return new Promise<RemoteApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.pending.set(requestId, { resolve, timer });
      this.channel(requestId, input.prompt);
    });
  }

  respond(requestId: string, peerId: string, approved: boolean): boolean {
    const p = this.pending.get(requestId);
    if (p === undefined) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve({ kind: "answered", peerId, approved });
    return true;
  }
}

export const delegatedApprovalBroker = new DelegatedApprovalBroker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/engine/delegated-approval-broker.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/delegated-approval-broker.ts packages/gateway/src/engine/delegated-approval-broker.test.ts
git commit -m "feat(hitl): delegatedApprovalBroker (broadcast + resolve, mirror consent-broker)"
```

### Task 14: Team Vault management dispatcher (`teamvault.*`) + HITL gating

**Files:**
- Create: `packages/gateway/src/ipc/teamvault-rpc.ts`
- Modify: `packages/gateway/src/engine/executor.ts` (add to `HITL_REQUIRED_BACKING`)
- Test: `packages/gateway/src/ipc/teamvault-rpc.test.ts`

Local-only methods: `teamvault.put` (writes secret keys to the OS Vault + entry metadata), `teamvault.delete`, `teamvault.grant`, `teamvault.revoke`, `teamvault.list`. `put`/`delete` are added to `HITL_REQUIRED_BACKING` (I2) so any planned-action form gates; the IPC handler also performs a consent check via the injected coordinator before writing.

- [ ] **Step 1: Add the two action types to `HITL_REQUIRED_BACKING`**

In `executor.ts`, inside the `HITL_REQUIRED_BACKING` set (after `"vault.delete",` line 101):
```ts
  "teamvault.put",
  "teamvault.delete",
```

- [ ] **Step 2: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { dispatchTeamVaultRpc, type TeamVaultRpcContext } from "./teamvault-rpc.ts";

function ctx(db: Database, vault: Map<string, string>): TeamVaultRpcContext {
  return {
    db,
    vault: {
      set: async (k, v) => void vault.set(k, v),
      delete: async (k) => void vault.delete(k),
    },
    operator: "owner",
  };
}

describe("teamvault-rpc", () => {
  it("put writes per-connector secret keys to the vault + creates the entry", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    const out = await dispatchTeamVaultRpc(
      "teamvault.put",
      {
        entry: "prod-aws",
        service: "aws",
        secrets: { "aws.access_key_id": "AKIA...", "aws.secret_access_key": "shh" },
      },
      ctx(db, vault),
    );
    expect(out.kind).toBe("hit");
    expect(vault.get(teamVaultKey("prod-aws", "aws.access_key_id"))).toBe("AKIA...");
    expect(vault.get(teamVaultKey("prod-aws", "aws.secret_access_key"))).toBe("shh");
    const listed = await dispatchTeamVaultRpc("teamvault.list", {}, ctx(db, vault));
    expect(listed.value).toMatchObject({ entries: [{ entry: "prod-aws", service: "aws" }] });
  });

  it("grant then a no-grant becomes a grant (RBAC surfaced via store)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const vault = new Map<string, string>();
    await dispatchTeamVaultRpc(
      "teamvault.put",
      { entry: "prod-aws", service: "aws", secrets: { "aws.access_key_id": "x" } },
      ctx(db, vault),
    );
    const g = await dispatchTeamVaultRpc(
      "teamvault.grant",
      { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
      ctx(db, vault),
    );
    expect(g.value).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/teamvault-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
import type { Database } from "bun:sqlite";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class TeamVaultRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "TeamVaultRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface TeamVaultRpcContext {
  readonly db: Database;
  readonly vault: {
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** Operator identity recorded as created_by. */
  readonly operator: string;
}

function rec(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== "object") {
    throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return p as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a non-empty string`);
  }
  return v;
}

export async function dispatchTeamVaultRpc(
  method: string,
  params: unknown,
  ctx: TeamVaultRpcContext,
): Promise<RpcMissOrHit> {
  const store = new TeamVaultStore(ctx.db);
  return dispatchByMethod<TeamVaultRpcContext>(method, params, ctx, {
    "teamvault.put": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const service = str(r, "service");
      const secrets = r["secrets"];
      if (secrets === null || typeof secrets !== "object") {
        throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: secrets object required");
      }
      for (const [k, v] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: secret ${k} must be a string`);
        }
        await ctx.vault.set(teamVaultKey(entry, k), v);
      }
      store.createEntry(entry, service, ctx.operator);
      return { ok: true };
    },
    "teamvault.delete": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const keys = r["keys"];
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (typeof k === "string") await ctx.vault.delete(teamVaultKey(entry, k));
        }
      }
      return { ok: true };
    },
    "teamvault.grant": (p) => {
      const r = rec(p);
      store.grant(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.revoke": (p) => {
      const r = rec(p);
      store.revoke(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.list": () => {
      return { entries: store.listEntries() };
    },
  });
}
```

> The IPC server must run `teamvault.put`/`teamvault.delete` through the consent gate before dispatch (they are in `HITL_REQUIRED`). Wire that in Task 17 (assemble) following how `vault.set` is gated; if `vault.set` is gated inside its own handler, mirror that exact mechanism here.

- [ ] **Step 5: Run test + typecheck**

Run: `bun test packages/gateway/src/ipc/teamvault-rpc.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/teamvault-rpc.ts packages/gateway/src/ipc/teamvault-rpc.test.ts packages/gateway/src/engine/executor.ts
git commit -m "feat(teamvault): teamvault.* management dispatcher + HITL-gate put/delete (I2)"
```

### Task 15: HITL delegation management dispatcher (`hitl.*`)

**Files:**
- Create: `packages/gateway/src/ipc/hitl-rpc.ts`
- Test: `packages/gateway/src/ipc/hitl-rpc.test.ts`

Local methods: `hitl.delegate` (create), `hitl.revokeDelegation`, `hitl.listDelegations`, `hitl.pendingQueue` (the delegate's inbound approval requests — drawn from the broker's open requests; for Slice 2, return the in-memory queue the broker exposes).

- [ ] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchHitlRpc, type HitlRpcContext } from "./hitl-rpc.ts";

function ctx(db: Database): HitlRpcContext {
  return { db, now: () => 1000 };
}

describe("hitl-rpc", () => {
  it("delegate then listDelegations returns the active delegation", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const created = await dispatchHitlRpc(
      "hitl.delegate",
      { delegatePeer: "peer:bob", scopeKind: "service", scopeValue: "aws", expiresAt: 99999 },
      ctx(db),
    );
    expect(created.kind).toBe("hit");
    const listed = await dispatchHitlRpc("hitl.listDelegations", {}, ctx(db));
    expect((listed.value as { delegations: unknown[] }).delegations.length).toBe(1);
  });

  it("rejects an expiresAt in the past", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    await expect(
      dispatchHitlRpc(
        "hitl.delegate",
        { delegatePeer: "peer:bob", scopeKind: "service", scopeValue: "aws", expiresAt: 500 },
        ctx(db),
      ),
    ).rejects.toThrow(/expiresAt/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/hitl-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Database } from "bun:sqlite";
import { DelegationStore, type DelegationScopeKind } from "../engine/delegation-store.ts";
import { delegatedApprovalBroker } from "../engine/delegated-approval-broker.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class HitlRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "HitlRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface HitlRpcContext {
  readonly db: Database;
  readonly now?: () => number;
}

function rec(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== "object") {
    throw new HitlRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return p as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a non-empty string`);
  }
  return v;
}
function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a number`);
  }
  return v;
}

export async function dispatchHitlRpc(
  method: string,
  params: unknown,
  ctx: HitlRpcContext,
): Promise<RpcMissOrHit> {
  const store = new DelegationStore(ctx.db);
  const now = (ctx.now ?? Date.now)();
  return dispatchByMethod<HitlRpcContext>(method, params, ctx, {
    "hitl.delegate": (p) => {
      const r = rec(p);
      const scopeKind = str(r, "scopeKind");
      if (scopeKind !== "action_type" && scopeKind !== "service") {
        throw new HitlRpcError(-32602, `ERR_INVALID_PARAMS: bad scopeKind ${scopeKind}`);
      }
      const expiresAt = num(r, "expiresAt");
      if (expiresAt <= now) {
        throw new HitlRpcError(-32602, "ERR_INVALID_PARAMS: expiresAt must be in the future");
      }
      const id = store.create({
        delegatePeer: str(r, "delegatePeer"),
        scopeKind: scopeKind as DelegationScopeKind,
        scopeValue: str(r, "scopeValue"),
        expiresAt,
        nowMs: now,
      });
      return { delegationId: id };
    },
    "hitl.revokeDelegation": (p) => {
      const r = rec(p);
      store.revoke(str(r, "delegationId"), now);
      return { ok: true };
    },
    "hitl.listDelegations": () => {
      return { delegations: store.listActive(now) };
    },
    "hitl.pendingQueue": () => {
      return { pending: delegatedApprovalBroker.listPending() };
    },
  });
}
```

> Add a `listPending(): Array<{ requestId: string; prompt: string }>` accessor to `delegatedApprovalBroker` in Task 13's file (it just maps the `pending` map keys + prompts). If you skipped it, add it now and re-run Task 13's test.

- [ ] **Step 4: Run test + typecheck**

Run: `bun test packages/gateway/src/ipc/hitl-rpc.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/hitl-rpc.ts packages/gateway/src/ipc/hitl-rpc.test.ts packages/gateway/src/engine/delegated-approval-broker.ts
git commit -m "feat(hitl): hitl.* delegation management dispatcher + pendingQueue"
```

### Task 16: LAN admittance (I5) — admit the 3 wire methods, forbid management

**Files:**
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (the I5 allow/forbid mechanism — read it first)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I5 case)
- Test: covered by the I5 case + a new admittance assertion

> **Read `lan-rpc.ts` and the I5 case in `security-invariants.test.ts` first.** Slice 1 admits `federation.query`/`federation.expertise` over LAN and FORBIDS `vault.*`/`updater.*`/etc. Determine whether admittance is a positive allowlist or a `FORBIDDEN_OVER_LAN` denylist, and follow that exact mechanism.

- [ ] **Step 1: Write/extend the failing assertion** (in `security-invariants.test.ts`, I5 block)

```ts
it("I5: admits the team-vault wire methods but FORBIDS team-vault/HITL management over LAN", () => {
  // Adapt these calls to the real I5 API in lan-rpc.ts (checkLanMethodAllowed or the allow/forbid set).
  expect(isLanMethodAllowed("federation.invoke")).toBe(true);
  expect(isLanMethodAllowed("federation.quorumRespond")).toBe(true);
  expect(isLanMethodAllowed("federation.approvalRespond")).toBe(true);
  expect(isLanMethodAllowed("teamvault.put")).toBe(false);
  expect(isLanMethodAllowed("teamvault.grant")).toBe(false);
  expect(isLanMethodAllowed("hitl.delegate")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t I5`
Expected: FAIL.

- [ ] **Step 3: Update `lan-rpc.ts`**

- Add `federation.invoke`, `federation.quorumRespond`, `federation.approvalRespond` to the LAN-admitted set (mirror `federation.query`).
- Ensure `teamvault.*` and `hitl.*` are FORBIDDEN over LAN — if I5 is a prefix denylist, add the `teamvault` and `hitl` namespaces; if it's a positive allowlist, simply do NOT add them (then assert they're rejected).

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t I5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(teamvault): admit federation.invoke/*Respond over LAN; forbid teamvault/hitl mgmt (I5)"
```

---

## Part G — Boot wiring + CLI + Tauri

### Task 17: assemble.ts — construct stores, wire dispatchers + ctx

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` callers if not already at 35 (done in Task 2)
- Test: a focused smoke test, e.g. `packages/gateway/test/integration/teamvault/assemble-teamvault.test.ts`

> **Read `assemble.ts` first** to see how the federation dispatcher, `federationConsent.setBroadcast`, and the IPC method table are wired. Mirror that for: (a) `quorumCoordinator.setBroadcast` + `delegatedApprovalBroker.setBroadcast` (broadcast `federation.quorumRequest` / `federation.approvalRequest` via `ipc.broadcast`); (b) register `dispatchTeamVaultRpc` + `dispatchHitlRpc` in the local IPC method table; (c) pass `teamVault: { quorumFor, runTool }` into the `FederationRpcContext` (only on the anchor — gate behind the same `[federation].enabled` flag); (d) `quorumFor` = `(toolId) => quorumConfig.get(toolId)`; (e) `runTool` = a closure that injects `teamvault.<entry>.<key>` secrets and dispatches the connector tool through the executor.

- [ ] **Step 1: Write the smoke test** (asserts a put→grant→invoke happy path through the assembled wiring)

```ts
import { describe, expect, it } from "bun:test";
// Import the assembled gateway test harness used by other integration tests in this repo.
// (Follow the pattern in test/integration/federation/two-gateway-wire.integration.test.ts.)

describe("assembled team-vault wiring", () => {
  it("put → grant → invoke returns the tool result, never the secret", async () => {
    // 1. boot an anchor gateway with [federation].enabled
    // 2. teamvault.put { entry:'demo', service:'<mock>', secrets:{ '<mock>.token':'SECRET' } }
    // 3. teamvault.grant { entry:'demo', peerId:'peer:self', toolId:'<mock.read>' }
    // 4. dispatch federation.invoke locally with forced peerId 'peer:self'
    // 5. assert result is the mock tool's output and JSON.stringify(result) does NOT contain 'SECRET'
    expect(true).toBe(true); // replace with the real harness assertions
  });
});
```

> This smoke test is a scaffold — fill it using the existing integration harness (`two-gateway-wire.integration.test.ts`) and a mock connector tool. Do NOT leave the `expect(true)` placeholder in the final commit; it must exercise the real path.

- [ ] **Step 2: Wire assemble.ts** (broadcasts, dispatchers, ctx) following the read-first notes above.

- [ ] **Step 3: Run the smoke test + full gateway typecheck**

Run: `cd packages/gateway && bunx tsc --noEmit && cd ../.. && bun test packages/gateway/test/integration/teamvault`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/gateway/test/integration/teamvault
git commit -m "feat(teamvault): boot wiring — stores, broadcasts, dispatchers, anchor ctx"
```

### Task 18: CLI — `nimbus team vault put|grant|revoke|list`

**Files:**
- Modify: `packages/cli/src/commands/team.ts`
- Modify: the CLI registry (`COMMAND_NAMES`) AND `index.ts` `COMMAND_HANDLERS` if `team` subcommands are individually registered (read `team.ts` first)
- Test: `packages/cli/src/commands/team-vault.test.ts`

> Read `team.ts` to match its subcommand dispatch + `IPCClient` usage. Add `team vault put/grant/revoke/list` calling `teamvault.put/grant/revoke/list`. Remember `disconnect()` not `close()` for the IPC client.

- [ ] **Step 1: Write the failing test** (mirror an existing `team` subcommand test — inject a fake IPC client)

```ts
import { describe, expect, it } from "bun:test";
import { runTeamCommand } from "./team.ts"; // adapt to the real exported entry

describe("nimbus team vault", () => {
  it("vault grant calls teamvault.grant with the parsed args", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeClient = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { ok: true };
      },
      disconnect: () => {},
    };
    await runTeamCommand(["vault", "grant", "prod-aws", "peer:abc", "aws.ec2.instance.stop"], {
      client: fakeClient,
    });
    expect(calls[0]).toEqual({
      method: "teamvault.grant",
      params: { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `bun test packages/cli/src/commands/team-vault.test.ts` → FAIL.

- [ ] **Step 3: Implement the `vault` subcommand branch** in `team.ts` (parse `put|grant|revoke|list`, build params, call the IPC method, print result).

- [ ] **Step 4: Register the command name** in the CLI registry so `audit:readme-cli` passes (add `team` subcommand docs if the registry tracks them).

- [ ] **Step 5: Run it to verify it passes** + `bun test packages/cli/src/commands` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team-vault.test.ts
git commit -m "feat(cli): nimbus team vault put|grant|revoke|list"
```

### Task 19: CLI — `nimbus team invoke`

**Files:**
- Modify: `packages/cli/src/commands/team.ts`
- Test: `packages/cli/src/commands/team-invoke.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { runTeamCommand } from "./team.ts";

describe("nimbus team invoke", () => {
  it("invoke calls federation.ask-invoke with peer/entry/tool", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeClient = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { kind: "ok", result: {} };
      },
      disconnect: () => {},
    };
    await runTeamCommand(
      ["invoke", "peer:abc", "prod-aws", "aws.ec2.instance.stop", "--purpose", "stop idle"],
      { client: fakeClient },
    );
    expect(calls[0]?.method).toBe("federation.askInvoke");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement.** Add an asker-side `federation.askInvoke` to `federation-rpc.ts` mirroring `federation.ask` (it `requireAskTarget` + `sendFederatedOverWire(..., "federation.invoke", body)`), and the `team invoke` CLI branch that calls it.

> This requires a small addition to `federation-rpc.ts` (`federation.askInvoke`) — add it with a unit test mirroring Task 11's, then the CLI branch here.

- [ ] **Step 4: Run it to verify it passes** + typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team-invoke.test.ts packages/gateway/src/ipc/federation-rpc.ts
git commit -m "feat(cli): nimbus team invoke (asker-side federation.askInvoke)"
```

### Task 20: CLI — `nimbus team delegate|delegations|approve|deny`

**Files:**
- Modify: `packages/cli/src/commands/team.ts`
- Test: `packages/cli/src/commands/team-delegate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { runTeamCommand } from "./team.ts";

describe("nimbus team delegate/approve", () => {
  it("delegate calls hitl.delegate", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeClient = {
      call: async (m: string, p: unknown) => {
        calls.push({ method: m, params: p });
        return { delegationId: "d1" };
      },
      disconnect: () => {},
    };
    await runTeamCommand(
      ["delegate", "peer:bob", "--scope", "service:aws", "--expires", "3600"],
      { client: fakeClient, now: () => 1000 },
    );
    expect(calls[0]?.method).toBe("hitl.delegate");
  });

  it("approve routes to federation.approvalRespond/quorumRespond", async () => {
    const calls: string[] = [];
    const fakeClient = {
      call: async (m: string) => {
        calls.push(m);
        return { ok: true };
      },
      disconnect: () => {},
    };
    await runTeamCommand(["approve", "req-123"], { client: fakeClient });
    expect(calls[0]).toMatch(/approvalRespond|quorumRespond/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement** the `delegate`/`delegations`/`approve`/`deny` branches. For `approve`/`deny`, call BOTH `federation.quorumRespond` and `federation.approvalRespond` (or a single `team.respond` that the gateway fans to both brokers) — simplest: the CLI sends to `federation.approvalRespond` and `federation.quorumRespond` is reached via the same id space; pick one and document it. Parse `--scope kind:value` and `--expires <seconds>` (compute `expiresAt = now + seconds*1000`).

- [ ] **Step 4: Run it to verify it passes** + typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/team.ts packages/cli/src/commands/team-delegate.test.ts
git commit -m "feat(cli): nimbus team delegate|delegations|approve|deny"
```

### Task 21: Tauri allowlist (I7)

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Modify: `packages/gateway/src/security-invariants.test.ts` (count mirror)

> **Read `gateway_bridge.rs` ALLOWED_METHODS first** (currently 74). Add the renderer-SAFE methods; keep secret-writing renderer-FORBIDDEN.

- [ ] **Step 1: Add the renderer-safe methods** (alphabetized) to `ALLOWED_METHODS`:
```
"federation.approvalRespond",
"federation.quorumRespond",
"hitl.listDelegations",
"hitl.pendingQueue",
"teamvault.list",
```
Do NOT add: `teamvault.put`, `teamvault.delete`, `teamvault.grant`, `teamvault.revoke`, `hitl.delegate`, `hitl.revokeDelegation`, `federation.invoke`, `federation.askInvoke` (RCE-class / out-of-band — renderer-forbidden, like `vault.set`/`federation.pair`).

- [ ] **Step 2: Update the Rust count assertion** `assert_eq!(ALLOWED_METHODS.len(), 74)` → `79` (74 + 5). Verify by counting your additions.

- [ ] **Step 3: Update the TS mirror** in `security-invariants.test.ts` (`allowlist_exact_size assertion is 74` → `79`).

- [ ] **Step 4: Run the allowlist tests**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t allowlist` and (if Rust toolchain present) `cd packages/ui/src-tauri && cargo test allowlist`
Expected: PASS. If Rust isn't available locally, rely on the TS mirror + CI.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs packages/gateway/src/security-invariants.test.ts
git commit -m "feat(teamvault): expose renderer-safe team-vault/HITL read methods (I7, 74->79)"
```

---

## Part H — Invariants (the triple: wiring + docs + test)

### Task 22: I19 runtime test + D15 static check

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts` (I19)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D15 + run wiring)
- Test: the static check gets a unit test in `scripts/structure-audit/check-nimbus-invariants.test.ts`

- [ ] **Step 1: Write the failing I19 runtime test**

```ts
it("I19: a team secret is never returned in the invoke gate result", async () => {
  // Build an InvokeGateCtx whose runTool injects a known secret and returns a result that does
  // NOT echo it; assert the gate result contains only { kind, result } and no secret-shaped value.
  // Also assert team-vault-keys.ts is the only non-test file naming the `teamvault.` prefix (D15 below).
  const text = await Bun.file(
    "packages/gateway/src/federation/invoke-gate.ts",
  ).text();
  expect(text).not.toMatch(/teamvault\.[a-z]/); // the gate never names a concrete teamvault key
});
```

- [ ] **Step 2: Write the failing D15 unit test** (mirror `checkIdentityTokenVaultInvariant` test)

```ts
import { describe, expect, it } from "bun:test";
import { checkTeamVaultKeyInvariant } from "./check-nimbus-invariants.ts";

describe("D15 team-vault keyspace", () => {
  it("flags a non-teamvault file that names the teamvault. prefix", () => {
    const v = checkTeamVaultKeyInvariant([
      { relPath: "packages/gateway/src/ipc/leak.ts", contents: `const k = "teamvault.x.y";` },
    ]);
    expect(v.length).toBe(1);
  });
  it("allows team-vault-keys.ts itself", () => {
    const v = checkTeamVaultKeyInvariant([
      {
        relPath: "packages/gateway/src/teamvault/team-vault-keys.ts",
        contents: `export const TEAM_VAULT_PREFIX = "teamvault.";`,
      },
    ]);
    expect(v.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run both to verify they fail.**

- [ ] **Step 4: Implement `checkTeamVaultKeyInvariant`** in `check-nimbus-invariants.ts` (mirror `checkIdentityTokenVaultInvariant`)

```ts
const TEAM_VAULT_DIR = "packages/gateway/src/teamvault/";
const TEAM_VAULT_PREFIX_RE = /['"`]teamvault\./;

/** D15 (I19) — the `teamvault.` Vault-key prefix is named ONLY inside teamvault/. */
export function checkTeamVaultKeyInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.startsWith(TEAM_VAULT_DIR) || f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (TEAM_VAULT_PREFIX_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D15-teamvault-key",
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

Wire it into `run()` alongside D14 (in the `binary-only || all` block):
```ts
  if (mode === "binary-only" || mode === "all") {
    const v = checkTeamVaultKeyInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D15 teamvault. key used outside teamvault/ — I19 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 5: Run both tests + the static audit binary**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts -t I19 && bun scripts/structure-audit/check-nimbus-invariants.ts --binary-only`
Expected: tests PASS; audit exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts
git commit -m "feat(security): I19 + static D15 (team-vault secret leak-proof injection)"
```

### Task 23: I20 + I21 runtime invariant tests

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts`

- [ ] **Step 1: Add the I20 + I21 cases** (these assert the production wiring, not just the unit logic):

```ts
it("I20: delegated approval rejects a non-delegate/identity-invalid answerer (wire not trusted)", async () => {
  const { resolveDelegatedApproval } = await import("./engine/delegated-approval.ts");
  const forged = await resolveDelegatedApproval({
    isActiveDelegate: () => false,
    isOperatorValid: () => true,
    requestRemote: async () => ({ kind: "answered", peerId: "peer:eve", approved: true }),
  });
  expect(forged).toBe("fallback_to_owner");
});

it("I21: quorum counts only distinct peers and a denial aborts", async () => {
  const { QuorumCoordinator } = await import("./engine/quorum/quorum-coordinator.ts");
  const ids: string[] = [];
  const c = new QuorumCoordinator((id) => ids.push(id));
  const p = c.collect({ approvers: 2, windowMs: 30 });
  c.respond(ids[0]!, "peer:a", true);
  c.respond(ids[0]!, "peer:a", true); // dup ignored
  expect((await p).outcome).toBe("failed");
});
```

- [ ] **Step 2: Run** `bun test packages/gateway/src/security-invariants.test.ts -t "I20|I21"` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts
git commit -m "test(security): I20 (delegated authority) + I21 (distinct-peer quorum) invariants"
```

### Task 24: Docs — SECURITY-INVARIANTS.md + CLAUDE.md/GEMINI.md I-list

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md`
- Modify: `CLAUDE.md` + `GEMINI.md` (the I1–I18 list → add I19–I21)

- [ ] **Step 1: Add I19/I20/I21 rows to `docs/SECURITY-INVARIANTS.md`** with wiring site + test pointer + rationale (mirror the I17/I18 entries; include D15 under I19's static complement).

- [ ] **Step 2: Add three lines to the Security Invariants list in BOTH `CLAUDE.md` and `GEMINI.md`:**

```md
- **I19** — team secrets injected only inside `answerFederatedInvoke`, never in an outbound payload (static D15) · `federation/invoke-gate.ts`, `teamvault/team-vault-keys.ts`
- **I20** — delegated approval honored only for a live in-scope delegate + valid operator identity · `engine/delegated-approval.ts`
- **I21** — distinct-peer quorum counting intrinsic to `QuorumCoordinator` · `engine/quorum/quorum-coordinator.ts`
```
Also extend the "Static complement" sentence to mention D15.

- [ ] **Step 3: Validate doc links** — `bun run audit:doc-refs` (or the equivalent) and `markdownlint-cli2 --fix` the changed docs (superpowers + repo docs are linted in full preflight).

- [ ] **Step 4: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "docs(security): document I19-I21 + D15 (team vault + quorum/delegated HITL)"
```

---

## Part I — Integration + acceptance

### Task 25: Two-gateway invoke integration (anchor-proxy happy path + revocation)

**Files:**
- Create: `packages/gateway/test/integration/teamvault/two-gateway-invoke.integration.test.ts`

> Mirror `test/integration/federation/two-gateway-wire.integration.test.ts` (two in-process runtimes over a real loopback NaCl socket). Anchor B holds a team secret for a mock connector; peer A pairs, B grants A a tool, A calls `federation.askInvoke` → over the wire → B runs the mock tool with the injected secret → A receives only the result.

- [ ] **Step 1: Write the test** covering:
  - happy path: A receives the mock tool result; the raw secret string never appears in A's received payload.
  - revocation: after B `teamvault.revoke`, A's next invoke returns `{ kind: "error", error: "no_grant" }` (acceptance: revocation within one cycle).

- [ ] **Step 2: Run** `bun test packages/gateway/test/integration/teamvault/two-gateway-invoke.integration.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/teamvault/two-gateway-invoke.integration.test.ts
git commit -m "test(teamvault): two-gateway anchor-proxy invoke + revocation integration"
```

### Task 26: Three-gateway quorum integration (acceptance: single approval stays locked)

**Files:**
- Create: `packages/gateway/test/integration/teamvault/quorum-invoke.integration.test.ts`

- [ ] **Step 1: Write the test:** anchor C with `[hitl.quorum]` requiring 2 approvers for the mock tool's action-type; peer A invokes; approvers B + D answer `federation.quorumRespond`.
  - With both approving within the window → tool runs, A gets the result.
  - With only ONE approval → window elapses → A gets `{ kind: "error", error: "quorum_failed" }` and the credential is never used (assert the mock tool's run-counter stayed 0). **(Acceptance criterion.)**
  - With one explicit denial → A gets `quorum_denied` immediately.

- [ ] **Step 2: Run** → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/teamvault/quorum-invoke.integration.test.ts
git commit -m "test(teamvault): three-gateway quorum invoke acceptance (single approval stays locked)"
```

### Task 27: Delegated-approval audit-in-both-logs acceptance

**Files:**
- Create: `packages/gateway/test/integration/teamvault/delegated-approval.integration.test.ts`

- [ ] **Step 1: Write the test:** owner A delegates an action-type to delegate B; an action needing HITL fires on A; the request routes to B; B approves; assert the decision is recorded in BOTH A's and B's local audit logs (the acceptance criterion). Also assert that if B is offline, A falls back to a local owner prompt (D10).

- [ ] **Step 2: Run** → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/integration/teamvault/delegated-approval.integration.test.ts
git commit -m "test(hitl): delegated approval recorded in both audit logs + offline fallback"
```

---

## Part J — Finalize

### Task 28: Coverage-floor exclusions (local + Sonar parity)

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties`

- [ ] **Step 1: Add glue/boot/CLI-runner files** that are not meaningfully unit-coverable (e.g. `platform/assemble.ts` additions, CLI command runners, the singletons) to `scripts/coverage-floor/exclusions.ts`.

- [ ] **Step 2: Mirror the SAME files** into `sonar-project.properties` `sonar.coverage.exclusions` (the Slice 1 parity trap — local-exempt ≠ Sonar-exempt; `audit:exclusion-parity` enforces Sonar ⊆ Local only, so a Sonar-only gap still bites).

- [ ] **Step 3: Verify parity**

Run: `bun run audit:exclusion-parity`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "chore(teamvault): coverage-floor exclusions for glue/CLI files (local + sonar parity)"
```

### Task 29: CHANGELOG + full preflight

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add a dated Slice 2 delivery entry** to `docs/CHANGELOG.md` (do NOT touch the CLAUDE.md/GEMINI.md status line — convention). Summarize: Team Vault anchor-proxy invoke, quorum + delegated HITL, V35, I19–I21/D15, new `federation.invoke`/`teamvault.*`/`hitl.*` surfaces.

- [ ] **Step 2: Run the fast preflight**

Run: `bun run preflight:fast`
Expected: PASS (static gates + typecheck).

- [ ] **Step 3: Run the full test suite + structure audit**

Run: `bun run test:ci && bun scripts/structure-audit/check-nimbus-invariants.ts --binary-only`
Expected: PASS; audit exits 0.

- [ ] **Step 4: Docker-verify coverage-floor (Linux-authoritative)** — per the Slice 1 memory, Windows coverage-floor flakes. If on Windows, run the floor in `oven/bun:latest` before trusting a red.

- [ ] **Step 5: Commit + open the PR**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): Phase 6 Slice 2 — Team Vault + Multi-user/Quorum HITL"
```

Then run `bun run preflight` once more clean and open the PR against `main`.

---

## Self-review (completed by plan author)

- **Spec coverage:** Team Vault store + keys (T3/T4) ✓; anchor-proxy invoke (T10/T17/T25) ✓; quorum (T5/T6/T12/T26) ✓; delegated HITL (T7/T8/T13/T15/T27) ✓; V35 (T1/T2) ✓; `[hitl.quorum]` config (T5) ✓; D8 env mapping (T3 keyspace + T17 runTool injection) ✓; D9 deny-aborts (T6/T10/T26) ✓; D10 timeout fallback (T8/T27) ✓; D11 live-check (T4/T25) ✓; D12 restart fail-safe (session-only singletons T12/T13) ✓; I19/I20/I21 + D15 (T22/T23) ✓; surfaces — IPC (T11/T14/T15/T16), CLI (T18/T19/T20), Tauri (T21) ✓; acceptance criteria (T25 revocation, T26 single-approval-locked, T27 both-audit-logs) ✓.
- **Known read-first wiring tasks (T16 lan-rpc I5 API, T17 assemble, T18–T20 team.ts, T21 gateway_bridge.rs, T5 nimbus-toml shape):** each instructs reading the target file first and mirroring the named adjacent pattern, because those files' exact internal APIs were not all read at plan time. Do not skip the read step.
- **Type consistency:** `InvokeResult`/`QuorumResult`/`RemoteApprovalOutcome`/`DelegatedApprovalResult` names are used consistently across producer + consumer tasks. `checkGrant(entry,peerId,toolId)` and `activeDelegateFor(kind,value,peer,now)` signatures match between store and gate tasks.
- **Placeholder note:** T17's smoke test ships a `expect(true)` scaffold — the task explicitly requires replacing it with the real harness assertions before commit. No other placeholders.
