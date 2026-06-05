# Phase 6 Slice 3 — Identity & Access (SSO/OIDC + SCIM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add enterprise identity to the Slice 1 federation substrate — OIDC device-code SSO with Vault-stored, signature-validated ID tokens, and a trust-anchor SCIM 2.0 endpoint whose deprovision auto-revokes a user's federation grants — gated by new structural invariant I18.

**Architecture:** A new `packages/gateway/src/identity/` subsystem (parallel to `federation/`) owns OIDC discovery/device-flow/JWKS/verifier, the identity DB store, the SCIM service + deprovision tie-in, and an `identity.*`/`scim.*` IPC dispatcher. SCIM provisioning rides the existing HTTP write surface (I13). The federation query gate consults the verifier before answering (I18). Migration V34 adds four tables. Local `ask`/`search` are never affected — identity gates federation only.

**Tech Stack:** Bun v1.2 / TypeScript 6 strict (no `any`); `bun:sqlite`; Bun WebCrypto (`crypto.subtle`, RS256) for JWT verification — **no new npm dependency**; Biome; `bun test`.

**Spec:** [`docs/superpowers/specs/2026-06-05-phase6-slice3-identity-design.md`](../specs/2026-06-05-phase6-slice3-identity-design.md). Read it before starting.

---

## Conventions for every task

- **Branch:** `dev/asafgolombek/phase6-slice3-identity` (already checked out in worktree `.worktrees/phase6-slice3-identity`). Never commit on `main`.
- **Run tests from the worktree root.** Bun test a single file: `bun test packages/gateway/src/identity/<file>.test.ts`.
- **No `any`.** Use `unknown` + narrowing for all external/wire data.
- **All SQLite writes** go through `dbRun`/`dbExec`/`dbStmtRun` from `db/write.ts` (I14). Never `db.run(`/`db.exec(`.
- **Tokens** (`id_token`, `refresh_token`, SCIM bearer) live ONLY in the Vault — never in a DB column, IPC/wire field, log, or config.
- **Commit** at the end of each task with a Conventional Commit; end every body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **TDD:** write the failing test, run it red, implement minimally, run it green, commit.

### ⚠️ Branch-time verification (do FIRST, before Task 1)

- [ ] **Confirm the migration number.** Open `packages/gateway/src/index/local-index.ts` and read `CURRENT_SCHEMA_VERSION`. This plan assumes **33 → 34**. If a parallel track already bumped it to 34, **use 35 everywhere this plan says 34** (rename the SQL constant/file/labels accordingly). Migrations are strictly contiguous — take the next free number, keep `BACKFILL_LABELS` gapless.

  Run: `bun -e "import {CURRENT_SCHEMA_VERSION} from './packages/gateway/src/index/local-index.ts'; console.log(CURRENT_SCHEMA_VERSION)"`
  Expected: prints `33` (proceed with V34). If it prints `34`, this plan's "34" becomes "35".

---

## Task 1: Migration V34 — identity tables

**Files:**

- Create: `packages/gateway/src/index/identity-v34-sql.ts`
- Create: `packages/gateway/src/index/migrations/runner-v34.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + `INDEXED_SCHEMA_STEPS` tail + `BACKFILL_LABELS` tail)
- Modify: `packages/gateway/src/index/local-index.ts:269` (`CURRENT_SCHEMA_VERSION = 33` → `34`)

- [ ] **Step 1: Write the failing test**

```typescript
// runner-v34.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V34 migration — identity tables", () => {
  test("creates the four identity tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('identity_session','scim_user','identity_binding','oidc_jwks_cache')`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["identity_binding", "identity_session", "oidc_jwks_cache", "scim_user"]);
  });

  test("idx_identity_binding_peer index exists", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const indexes = db
      .query<{ name: string }, []>(`PRAGMA index_list(identity_binding)`)
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_identity_binding_peer");
  });

  test("user_version is at least 34 and V34 is recorded", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const { user_version } = db.query(`PRAGMA user_version`).get() as { user_version: number };
    expect(user_version).toBeGreaterThanOrEqual(34);
    const row = db
      .query("SELECT description FROM _schema_migrations WHERE version = 34")
      .get() as { description: string } | null;
    expect(row?.description).toContain("identity");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v34.test.ts`
Expected: FAIL — migration to 34 does not exist (target version exceeds steps).

- [ ] **Step 3: Create the SQL constant**

```typescript
// identity-v34-sql.ts
// V34 — Phase 6 Slice 3 (Identity & Access).
// Append-only: 4 new tables. No secret values are stored in any column (tokens live in the Vault).
export const V34_IDENTITY_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS identity_session (
     issuer        TEXT PRIMARY KEY,
     external_id   TEXT NOT NULL,
     email         TEXT,
     claims_json   TEXT NOT NULL DEFAULT '{}',
     validated_at  INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     status        TEXT NOT NULL DEFAULT 'active'
   );`,
  `CREATE TABLE IF NOT EXISTS scim_user (
     external_id   TEXT PRIMARY KEY,
     user_name     TEXT,
     email         TEXT,
     active        INTEGER NOT NULL DEFAULT 1,
     attrs_json    TEXT NOT NULL DEFAULT '{}',
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS identity_binding (
     external_id   TEXT NOT NULL,
     peer_id       TEXT NOT NULL,
     bound_at      INTEGER NOT NULL,
     bound_by      TEXT NOT NULL CHECK(bound_by IN ('handshake','admin')),
     revoked_at    INTEGER,
     PRIMARY KEY (external_id, peer_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_identity_binding_peer ON identity_binding(peer_id);`,
  `CREATE TABLE IF NOT EXISTS oidc_jwks_cache (
     issuer        TEXT NOT NULL,
     kid           TEXT NOT NULL,
     key_json      TEXT NOT NULL,
     fetched_at    INTEGER NOT NULL,
     PRIMARY KEY (issuer, kid)
   );`,
];
```

- [ ] **Step 4: Wire the step + label + version bump**

In `runner.ts`, add the import near the other V-SQL imports (alongside `import { V33_FEDERATION_SQL } from "../federation-v33-sql.ts";`):

```typescript
import { V34_IDENTITY_SQL } from "../identity-v34-sql.ts";
```

Append to the END of `INDEXED_SCHEMA_STEPS` (right after the V32→V33 `simpleStep(...)`, before the closing `];`):

```typescript
  simpleStep(
    33,
    34,
    "identity_session/scim_user/identity_binding/oidc_jwks_cache (identity v34)",
    V34_IDENTITY_SQL,
  ),
```

Append to the END of `BACKFILL_LABELS` (after the federation v33 entry, before `];`):

```typescript
  "identity_session/scim_user/identity_binding/oidc_jwks_cache (identity v34) (backfilled)",
```

In `local-index.ts:269` change `export const CURRENT_SCHEMA_VERSION = 33;` to `= 34;`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner-v34.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/identity-v34-sql.ts \
        packages/gateway/src/index/migrations/runner-v34.test.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/local-index.ts
git commit -m "feat(identity): add V34 migration — identity_session/scim_user/identity_binding/oidc_jwks_cache

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Identity types

**Files:**

- Create: `packages/gateway/src/identity/types.ts`
- Create: `packages/gateway/src/identity/types.test.ts`

These are the shared shapes every later task imports. The test exercises the two runtime validators defined here (`parseTokenResponse`, `parseDeviceAuthResponse`) so the file has coverage and the narrowing is proven.

- [ ] **Step 1: Write the failing test**

```typescript
// types.test.ts
import { describe, expect, test } from "bun:test";
import { parseDeviceAuthResponse, parseTokenResponse } from "./types.ts";

describe("parseTokenResponse", () => {
  test("maps snake_case OIDC token fields", () => {
    const r = parseTokenResponse({
      id_token: "h.p.s",
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    expect(r).toEqual({ idToken: "h.p.s", accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  });
  test("throws when id_token is missing", () => {
    expect(() => parseTokenResponse({ access_token: "at" })).toThrow();
  });
});

describe("parseDeviceAuthResponse", () => {
  test("maps device_authorization fields with interval default 5", () => {
    const r = parseDeviceAuthResponse({
      device_code: "dc",
      user_code: "WXYZ-1234",
      verification_uri: "https://acme/activate",
      expires_in: 900,
    });
    expect(r.deviceCode).toBe("dc");
    expect(r.userCode).toBe("WXYZ-1234");
    expect(r.interval).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// types.ts
/** A `fetch`-shaped injectable for deterministic tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Injected clock (ms). Module code must never call Date.now() directly in hot paths under test. */
export type Clock = () => number;

export interface OidcDiscovery {
  readonly issuer: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface DeviceAuthResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export interface TokenResponse {
  readonly idToken: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

export interface ValidatedClaims {
  readonly sub: string;
  readonly email?: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number; // seconds
  readonly nbf?: number; // seconds
  readonly raw: Record<string, unknown>;
}

export interface IdentitySession {
  readonly issuer: string;
  readonly externalId: string;
  readonly email: string | null;
  readonly validatedAt: number; // ms
  readonly expiresAt: number; // ms
  readonly status: "active" | "expired" | "deprovisioned";
}

export interface ScimUser {
  readonly externalId: string;
  readonly userName: string | null;
  readonly email: string | null;
  readonly active: boolean;
  readonly attrs: Record<string, unknown>;
}

export type BindingSource = "handshake" | "admin";
export interface IdentityBinding {
  readonly externalId: string;
  readonly peerId: string;
  readonly boundAt: number;
  readonly boundBy: BindingSource;
  readonly revokedAt: number | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("identity: expected a JSON object");
  }
  return v as Record<string, unknown>;
}
function str(rec: Record<string, unknown>, k: string): string | undefined {
  const v = rec[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(rec: Record<string, unknown>, k: string): number | undefined {
  const v = rec[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseTokenResponse(v: unknown): TokenResponse {
  const rec = asRecord(v);
  const idToken = str(rec, "id_token");
  if (idToken === undefined) throw new TypeError("identity: token response missing id_token");
  return {
    idToken,
    ...(str(rec, "access_token") === undefined ? {} : { accessToken: str(rec, "access_token") }),
    ...(str(rec, "refresh_token") === undefined ? {} : { refreshToken: str(rec, "refresh_token") }),
    ...(num(rec, "expires_in") === undefined ? {} : { expiresIn: num(rec, "expires_in") }),
  };
}

export function parseDeviceAuthResponse(v: unknown): DeviceAuthResponse {
  const rec = asRecord(v);
  const deviceCode = str(rec, "device_code");
  const userCode = str(rec, "user_code");
  const verificationUri = str(rec, "verification_uri");
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new TypeError("identity: malformed device authorization response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(str(rec, "verification_uri_complete") === undefined
      ? {}
      : { verificationUriComplete: str(rec, "verification_uri_complete") }),
    interval: num(rec, "interval") ?? 5,
    expiresIn: num(rec, "expires_in") ?? 600,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/types.ts packages/gateway/src/identity/types.test.ts
git commit -m "feat(identity): core types + token/device-auth response validators

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Config — `[identity]` + `[scim]`

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts` (add after the federation section, ~line 574)
- Create: `packages/gateway/src/config/nimbus-toml-identity.test.ts`

Reuses the file's existing helpers: `parseBool`, `parseString`, `parseIntDec`, `forEachSectionEntry`, `loadTomlSection`, `parseStringArray` (already imported for other sections). Mirrors the federation pattern verbatim.

- [ ] **Step 1: Write the failing test**

```typescript
// nimbus-toml-identity.test.ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NIMBUS_IDENTITY_TOML,
  DEFAULT_NIMBUS_SCIM_TOML,
  parseNimbusIdentityToml,
  parseNimbusScimToml,
} from "./nimbus-toml.ts";

describe("[identity] config", () => {
  test("defaults: disabled, device_code, sensible grace", () => {
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.enabled).toBe(false);
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.flow).toBe("device_code");
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.sessionGraceSeconds).toBeGreaterThan(0);
  });
  test("parses issuer/client_id/scopes/grace", () => {
    const cfg = parseNimbusIdentityToml(
      [
        "[identity]",
        'issuer = "https://acme.okta.com"',
        'client_id = "0oaABC"',
        "enabled = true",
        'scopes = ["openid", "email"]',
        "session_grace_seconds = 120",
        "jwks_max_age_seconds = 3600",
      ].join("\n"),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuer).toBe("https://acme.okta.com");
    expect(cfg.clientId).toBe("0oaABC");
    expect(cfg.scopes).toEqual(["openid", "email"]);
    expect(cfg.sessionGraceSeconds).toBe(120);
    expect(cfg.jwksMaxAgeSeconds).toBe(3600);
  });
});

describe("[scim] config", () => {
  test("default disabled", () => {
    expect(DEFAULT_NIMBUS_SCIM_TOML.enabled).toBe(false);
  });
  test("parses enabled", () => {
    expect(parseNimbusScimToml("[scim]\nenabled = true").enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-identity.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Write the implementation** (append after `loadNimbusFederationFromConfigDir`)

```typescript
export type NimbusIdentityToml = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  flow: "device_code";
  scopes: string[];
  sessionGraceSeconds: number;
  revalidateIntervalSeconds: number;
  tokenRefreshSkewSeconds: number;
  jwksMaxAgeSeconds: number;
};

export const DEFAULT_NIMBUS_IDENTITY_TOML: NimbusIdentityToml = {
  enabled: false,
  issuer: "",
  clientId: "",
  flow: "device_code",
  scopes: ["openid", "email", "profile"],
  sessionGraceSeconds: 86400,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};

function applyNimbusIdentityKey(
  out: Partial<NimbusIdentityToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "issuer":
      out.issuer = parseString(valRaw);
      break;
    case "client_id":
      out.clientId = parseString(valRaw);
      break;
    case "scopes": {
      const arr = parseStringArray(valRaw).filter((s) => s.length > 0);
      if (arr.length > 0) out.scopes = arr;
      break;
    }
    case "session_grace_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.sessionGraceSeconds = n;
      break;
    }
    case "revalidate_interval_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.revalidateIntervalSeconds = n;
      break;
    }
    case "token_refresh_skew_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.tokenRefreshSkewSeconds = n;
      break;
    }
    case "jwks_max_age_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.jwksMaxAgeSeconds = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusIdentityToml(
  raw: string,
  defaults: NimbusIdentityToml = DEFAULT_NIMBUS_IDENTITY_TOML,
): NimbusIdentityToml {
  const out: Partial<NimbusIdentityToml> = {};
  forEachSectionEntry(raw, "[identity]", (key, valRaw) => applyNimbusIdentityKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusIdentityFromConfigDir(configDir: string): NimbusIdentityToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_IDENTITY_TOML,
    parseNimbusIdentityToml,
  );
}

export type NimbusScimToml = { enabled: boolean };
export const DEFAULT_NIMBUS_SCIM_TOML: NimbusScimToml = { enabled: false };

export function parseNimbusScimToml(
  raw: string,
  defaults: NimbusScimToml = DEFAULT_NIMBUS_SCIM_TOML,
): NimbusScimToml {
  const out: Partial<NimbusScimToml> = {};
  forEachSectionEntry(raw, "[scim]", (key, valRaw) => {
    if (key === "enabled") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
    }
  });
  return { ...defaults, ...out };
}

export function loadNimbusScimFromConfigDir(configDir: string): NimbusScimToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_SCIM_TOML,
    parseNimbusScimToml,
  );
}
```

> If `parseStringArray` is not already imported in `nimbus-toml.ts`, add it to the import from `./toml-primitives.ts`. Confirm with: `grep -n "parseStringArray" packages/gateway/src/config/nimbus-toml.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-identity.test.ts
git commit -m "feat(identity): [identity] + [scim] nimbus.toml config sections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Identity store (DB access)

**Files:**

- Create: `packages/gateway/src/identity/identity-store.ts`
- Create: `packages/gateway/src/identity/identity-store.test.ts`

Owns all reads/writes to the four V34 tables via `dbRun` (I14). No token handling here.

- [ ] **Step 1: Write the failing test**

```typescript
// identity-store.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdentityStore", () => {
  let db: Database;
  let store: IdentityStore;
  beforeEach(() => {
    db = freshDb();
    store = new IdentityStore(db);
  });

  test("upsertSession + getSession round-trips", () => {
    store.upsertSession({
      issuer: "https://acme",
      externalId: "sub-1",
      email: "a@acme.com",
      validatedAt: 1000,
      expiresAt: 2000,
      status: "active",
    });
    const s = store.getSession("https://acme");
    expect(s?.externalId).toBe("sub-1");
    expect(s?.status).toBe("active");
  });

  test("scim upsert + setActive + getByExternalId", () => {
    store.upsertScimUser({ externalId: "u1", userName: "alice", email: "a@acme.com", active: true, attrs: {} }, 10);
    store.setScimActive("u1", false, 20);
    expect(store.getScimUser("u1")?.active).toBe(false);
  });

  test("bindings: bind, list active by externalId, revoke", () => {
    store.bind("u1", "peer:aa", "admin", 30);
    store.bind("u1", "peer:bb", "handshake", 31);
    expect(store.activePeerIdsFor("u1").sort()).toEqual(["peer:aa", "peer:bb"]);
    store.revokeBinding("peer:aa", 40);
    expect(store.activePeerIdsFor("u1")).toEqual(["peer:bb"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/identity-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// identity-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { BindingSource, IdentitySession, ScimUser } from "./types.ts";

interface SessionRow {
  issuer: string;
  external_id: string;
  email: string | null;
  validated_at: number;
  expires_at: number;
  status: string;
}
interface ScimRow {
  external_id: string;
  user_name: string | null;
  email: string | null;
  active: number;
  attrs_json: string;
}

export class IdentityStore {
  constructor(private readonly db: Database) {}

  upsertSession(s: IdentitySession & { claimsJson?: string }): void {
    dbRun(
      this.db,
      `INSERT INTO identity_session (issuer, external_id, email, claims_json, validated_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer) DO UPDATE SET
         external_id = excluded.external_id, email = excluded.email, claims_json = excluded.claims_json,
         validated_at = excluded.validated_at, expires_at = excluded.expires_at, status = excluded.status`,
      [s.issuer, s.externalId, s.email, s.claimsJson ?? "{}", s.validatedAt, s.expiresAt, s.status],
    );
  }

  getSession(issuer: string): IdentitySession | undefined {
    const row = this.db
      .query<SessionRow, [string]>(`SELECT * FROM identity_session WHERE issuer = ?`)
      .get(issuer);
    if (row === null || row === undefined) return undefined;
    return {
      issuer: row.issuer,
      externalId: row.external_id,
      email: row.email,
      validatedAt: row.validated_at,
      expiresAt: row.expires_at,
      status: row.status === "deprovisioned" ? "deprovisioned" : row.status === "expired" ? "expired" : "active",
    };
  }

  setSessionStatus(issuer: string, status: IdentitySession["status"]): void {
    dbRun(this.db, `UPDATE identity_session SET status = ? WHERE issuer = ?`, [status, issuer]);
  }

  clearSession(issuer: string): void {
    dbRun(this.db, `DELETE FROM identity_session WHERE issuer = ?`, [issuer]);
  }

  upsertScimUser(u: ScimUser, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO scim_user (external_id, user_name, email, active, attrs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         user_name = excluded.user_name, email = excluded.email, active = excluded.active,
         attrs_json = excluded.attrs_json, updated_at = excluded.updated_at`,
      [u.externalId, u.userName, u.email, u.active ? 1 : 0, JSON.stringify(u.attrs), nowMs, nowMs],
    );
  }

  setScimActive(externalId: string, active: boolean, nowMs: number): void {
    dbRun(this.db, `UPDATE scim_user SET active = ?, updated_at = ? WHERE external_id = ?`, [
      active ? 1 : 0,
      nowMs,
      externalId,
    ]);
  }

  getScimUser(externalId: string): ScimUser | undefined {
    const row = this.db
      .query<ScimRow, [string]>(`SELECT * FROM scim_user WHERE external_id = ?`)
      .get(externalId);
    if (row === null || row === undefined) return undefined;
    let attrs: Record<string, unknown> = {};
    try {
      const p: unknown = JSON.parse(row.attrs_json);
      if (p !== null && typeof p === "object" && !Array.isArray(p)) attrs = p as Record<string, unknown>;
    } catch {
      /* corrupt attrs default to {} */
    }
    return {
      externalId: row.external_id,
      userName: row.user_name,
      email: row.email,
      active: row.active === 1,
      attrs,
    };
  }

  findScimByEmail(email: string): ScimUser | undefined {
    const row = this.db
      .query<{ external_id: string }, [string]>(`SELECT external_id FROM scim_user WHERE email = ?`)
      .get(email);
    return row === null || row === undefined ? undefined : this.getScimUser(row.external_id);
  }

  listScimUsers(): ScimUser[] {
    const ids = this.db
      .query<{ external_id: string }, []>(`SELECT external_id FROM scim_user ORDER BY external_id ASC`)
      .all();
    return ids.map((r) => this.getScimUser(r.external_id)).filter((u): u is ScimUser => u !== undefined);
  }

  bind(externalId: string, peerId: string, by: BindingSource, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO identity_binding (external_id, peer_id, bound_at, bound_by, revoked_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(external_id, peer_id) DO UPDATE SET bound_at = excluded.bound_at, bound_by = excluded.bound_by, revoked_at = NULL`,
      [externalId, peerId, nowMs, by],
    );
  }

  activePeerIdsFor(externalId: string): string[] {
    return this.db
      .query<{ peer_id: string }, [string]>(
        `SELECT peer_id FROM identity_binding WHERE external_id = ? AND revoked_at IS NULL ORDER BY peer_id ASC`,
      )
      .all(externalId)
      .map((r) => r.peer_id);
  }

  revokeBinding(peerId: string, nowMs: number): void {
    dbRun(this.db, `UPDATE identity_binding SET revoked_at = ? WHERE peer_id = ? AND revoked_at IS NULL`, [
      nowMs,
      peerId,
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/identity-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/identity-store.ts packages/gateway/src/identity/identity-store.test.ts
git commit -m "feat(identity): IdentityStore — session/scim_user/binding DB access (I14)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: JWKS cache (fetch + persist + TTL)

**Files:**

- Create: `packages/gateway/src/identity/jwks-cache.ts`
- Create: `packages/gateway/src/identity/jwks-cache.test.ts`

Persists public JWKs in `oidc_jwks_cache` and serves a key by `kid` with TTL + offline behavior (review Q2). Public keys only — not secret.

- [ ] **Step 1: Write the failing test**

```typescript
// jwks-cache.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { JwksCache } from "./jwks-cache.ts";

function jwksResponse(kid: string): Response {
  return new Response(JSON.stringify({ keys: [{ kid, kty: "RSA", n: "AAAA", e: "AQAB", alg: "RS256" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("JwksCache", () => {
  test("fetches + persists on a kid miss, then serves from cache", async () => {
    const db = freshDb();
    let calls = 0;
    const fetchLike = async () => {
      calls++;
      return jwksResponse("k1");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 3600 });
    const first = await cache.getKey("https://acme", "https://acme/jwks", "k1", 1000);
    expect(first?.kid).toBe("k1");
    expect(calls).toBe(1);
    const second = await cache.getKey("https://acme", "https://acme/jwks", "k1", 2000);
    expect(second?.kid).toBe("k1");
    expect(calls).toBe(1); // served from cache
  });

  test("kid miss with offline fetch returns undefined (fail closed)", async () => {
    const db = freshDb();
    const fetchLike = async () => {
      throw new Error("offline");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 3600 });
    expect(await cache.getKey("https://acme", "https://acme/jwks", "missing", 1000)).toBeUndefined();
  });

  test("stale-past-TTL key is refetched; if offline it is NOT served", async () => {
    const db = freshDb();
    let online = true;
    const fetchLike = async () => {
      if (!online) throw new Error("offline");
      return jwksResponse("k1");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 10 });
    await cache.getKey("https://acme", "https://acme/jwks", "k1", 0); // cached at t=0
    online = false;
    // now is 20_000ms later → key is older than 10s TTL → refetch attempted → offline → not served
    expect(await cache.getKey("https://acme", "https://acme/jwks", "k1", 20_000)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/jwks-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// jwks-cache.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { FetchLike } from "./types.ts";

/** A public JWK (RSA). Stored verbatim; non-secret. */
export interface PublicJwk {
  readonly kid: string;
  readonly kty: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
  readonly [k: string]: unknown;
}

interface CacheRow {
  key_json: string;
  fetched_at: number;
}

export class JwksCache {
  constructor(
    private readonly db: Database,
    private readonly fetchLike: FetchLike,
    private readonly opts: { maxAgeSeconds: number },
  ) {}

  /** Returns the JWK for `kid`, fetching when absent or stale. Fails CLOSED (undefined) if offline. */
  async getKey(issuer: string, jwksUri: string, kid: string, nowMs: number): Promise<PublicJwk | undefined> {
    const fresh = this.readFresh(issuer, kid, nowMs);
    if (fresh !== undefined) return fresh;
    // miss or stale → try one refetch
    const ok = await this.refetch(issuer, jwksUri, nowMs);
    if (!ok) return undefined;
    return this.readFresh(issuer, kid, nowMs);
  }

  private readFresh(issuer: string, kid: string, nowMs: number): PublicJwk | undefined {
    const row = this.db
      .query<CacheRow, [string, string]>(
        `SELECT key_json, fetched_at FROM oidc_jwks_cache WHERE issuer = ? AND kid = ?`,
      )
      .get(issuer, kid);
    if (row === null || row === undefined) return undefined;
    if (nowMs - row.fetched_at > this.opts.maxAgeSeconds * 1000) return undefined; // stale → force refetch
    try {
      return JSON.parse(row.key_json) as PublicJwk;
    } catch {
      return undefined;
    }
  }

  private async refetch(issuer: string, jwksUri: string, nowMs: number): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetchLike(jwksUri);
    } catch {
      return false; // offline
    }
    if (!res.ok) return false;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    if (body === null || typeof body !== "object") return false;
    const keys = (body as Record<string, unknown>)["keys"];
    if (!Array.isArray(keys)) return false;
    for (const k of keys) {
      if (k === null || typeof k !== "object") continue;
      const kid = (k as Record<string, unknown>)["kid"];
      if (typeof kid !== "string") continue;
      dbRun(
        this.db,
        `INSERT INTO oidc_jwks_cache (issuer, kid, key_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(issuer, kid) DO UPDATE SET key_json = excluded.key_json, fetched_at = excluded.fetched_at`,
        [issuer, kid, JSON.stringify(k), nowMs],
      );
    }
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/jwks-cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/jwks-cache.ts packages/gateway/src/identity/jwks-cache.test.ts
git commit -m "feat(identity): JWKS cache with TTL + fail-closed offline handling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verifier (I18 canonical) — RS256 ID-token validation

**Files:**

- Create: `packages/gateway/src/identity/verifier.ts`
- Create: `packages/gateway/src/identity/verifier.test.ts`

The ONLY module that validates an ID token. Uses Bun WebCrypto (`crypto.subtle`, RS256) — no new dependency. Also exposes the pure `isOperatorValid()` the federation gate consults.

- [ ] **Step 1: Write the failing test** (generates a real RSA keypair + signs a JWT so the crypto path is exercised end-to-end)

```typescript
// verifier.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { JwksCache } from "./jwks-cache.ts";
import { IdentityStore } from "./identity-store.ts";
import { isOperatorValid, IdTokenVerifier } from "./verifier.ts";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeSignedJwt(
  claims: Record<string, unknown>,
  kid: string,
): Promise<{ jwt: string; jwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const header = { alg: "RS256", kid, typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(signingInput)),
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { jwt: `${signingInput}.${b64url(sig)}`, jwk: { ...jwk, kid, alg: "RS256" } };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdTokenVerifier", () => {
  test("accepts a correctly-signed token with matching iss/aud/exp", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: "https://acme", aud: "client-1", sub: "sub-1", email: "a@acme.com", exp: now / 1000 + 3600 },
      "k1",
    );
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), { maxAgeSeconds: 3600 });
    const v = new IdTokenVerifier(cache, { issuer: "https://acme", clientId: "client-1", jwksUri: "https://acme/jwks" });
    const claims = await v.validateIdToken(jwt, now);
    expect(claims.sub).toBe("sub-1");
    expect(claims.email).toBe("a@acme.com");
  });

  test("rejects a token whose aud does not match the client_id", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt({ iss: "https://acme", aud: "WRONG", sub: "s", exp: now / 1000 + 60 }, "k1");
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), { maxAgeSeconds: 3600 });
    const v = new IdTokenVerifier(cache, { issuer: "https://acme", clientId: "client-1", jwksUri: "https://acme/jwks" });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow();
  });

  test("rejects an expired token", async () => {
    const db = freshDb();
    const now = 1_000_000;
    const { jwt, jwk } = await makeSignedJwt({ iss: "https://acme", aud: "client-1", sub: "s", exp: now / 1000 - 10 }, "k1");
    const cache = new JwksCache(db, async () => new Response(JSON.stringify({ keys: [jwk] })), { maxAgeSeconds: 3600 });
    const v = new IdTokenVerifier(cache, { issuer: "https://acme", clientId: "client-1", jwksUri: "https://acme/jwks" });
    await expect(v.validateIdToken(jwt, now)).rejects.toThrow();
  });
});

describe("isOperatorValid", () => {
  test("true within grace, false past grace, false when deprovisioned", () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({ issuer: "https://acme", externalId: "s", email: null, validatedAt: 0, expiresAt: 1000, status: "active" });
    expect(isOperatorValid(store, "https://acme", 1500, 1000)).toBe(true); // exp=1000, grace=1000 → ok until 2000
    expect(isOperatorValid(store, "https://acme", 2500, 1000)).toBe(false); // past grace
    store.setSessionStatus("https://acme", "deprovisioned");
    expect(isOperatorValid(store, "https://acme", 1500, 1000)).toBe(false);
  });
  test("false when there is no session at all", () => {
    const db = freshDb();
    expect(isOperatorValid(new IdentityStore(db), "https://acme", 0, 1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/verifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// verifier.ts
import type { IdentityStore } from "./identity-store.ts";
import type { JwksCache, PublicJwk } from "./jwks-cache.ts";
import type { ValidatedClaims } from "./types.ts";

const CLOCK_SKEW_SECONDS = 60;

export class IdTokenValidationError extends Error {}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return new Uint8Array(Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64"));
}
function b64urlToJson(s: string): Record<string, unknown> {
  const obj: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new IdTokenValidationError("identity: JWT segment is not an object");
  }
  return obj as Record<string, unknown>;
}

function parseJwt(jwt: string): JwtParts {
  const segs = jwt.split(".");
  if (segs.length !== 3) throw new IdTokenValidationError("identity: malformed JWT");
  const [h, p, s] = segs as [string, string, string];
  return { header: b64urlToJson(h), payload: b64urlToJson(p), signingInput: `${h}.${p}`, signature: b64urlToBytes(s) };
}

async function verifyRs256(jwk: PublicJwk, signingInput: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, new TextEncoder().encode(signingInput));
}

export class IdTokenVerifier {
  constructor(
    private readonly jwks: JwksCache,
    private readonly cfg: { issuer: string; clientId: string; jwksUri: string },
  ) {}

  /** I18 — the ONLY ID-token validation path. RS256 only (Okta/Entra/Auth0/Google). nowMs is injected. */
  async validateIdToken(jwt: string, nowMs: number): Promise<ValidatedClaims> {
    const { header, payload, signingInput, signature } = parseJwt(jwt);
    if (header["alg"] !== "RS256") {
      throw new IdTokenValidationError(`identity: unsupported alg ${String(header["alg"])} (RS256 only)`);
    }
    const kid = header["kid"];
    if (typeof kid !== "string") throw new IdTokenValidationError("identity: missing kid");
    const jwk = await this.jwks.getKey(this.cfg.issuer, this.cfg.jwksUri, kid, nowMs);
    if (jwk === undefined) throw new IdTokenValidationError("identity: no usable signing key (rotated/offline)");
    if (!(await verifyRs256(jwk, signingInput, signature))) {
      throw new IdTokenValidationError("identity: signature verification failed");
    }
    if (payload["iss"] !== this.cfg.issuer) throw new IdTokenValidationError("identity: issuer mismatch");
    const aud = payload["aud"];
    const audOk = aud === this.cfg.clientId || (Array.isArray(aud) && aud.includes(this.cfg.clientId));
    if (!audOk) throw new IdTokenValidationError("identity: audience mismatch");
    const nowSec = nowMs / 1000;
    const exp = payload["exp"];
    if (typeof exp !== "number" || nowSec > exp + CLOCK_SKEW_SECONDS) {
      throw new IdTokenValidationError("identity: token expired");
    }
    const nbf = payload["nbf"];
    if (typeof nbf === "number" && nowSec + CLOCK_SKEW_SECONDS < nbf) {
      throw new IdTokenValidationError("identity: token not yet valid");
    }
    const sub = payload["sub"];
    if (typeof sub !== "string" || sub.length === 0) throw new IdTokenValidationError("identity: missing sub");
    return {
      sub,
      ...(typeof payload["email"] === "string" ? { email: payload["email"] } : {}),
      iss: this.cfg.issuer,
      aud: this.cfg.clientId,
      exp,
      ...(typeof nbf === "number" ? { nbf } : {}),
      raw: payload,
    };
  }
}

/** The federation gate's single question. Pure/synchronous — no network. */
export function isOperatorValid(
  store: IdentityStore,
  issuer: string,
  nowMs: number,
  graceSeconds: number,
): boolean {
  const s = store.getSession(issuer);
  if (s === undefined) return false;
  if (s.status !== "active") return false;
  return nowMs <= s.expiresAt + graceSeconds * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/verifier.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/verifier.ts packages/gateway/src/identity/verifier.test.ts
git commit -m "feat(identity): I18 ID-token verifier (RS256, WebCrypto) + isOperatorValid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: OIDC discovery

**Files:**

- Create: `packages/gateway/src/identity/oidc-discovery.ts`
- Create: `packages/gateway/src/identity/oidc-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// oidc-discovery.test.ts
import { describe, expect, test } from "bun:test";
import { fetchOidcDiscovery } from "./oidc-discovery.ts";

const META = {
  issuer: "https://acme",
  device_authorization_endpoint: "https://acme/dev",
  token_endpoint: "https://acme/token",
  jwks_uri: "https://acme/jwks",
};

describe("fetchOidcDiscovery", () => {
  test("requests .well-known/openid-configuration and maps endpoints", async () => {
    let requested = "";
    const fetchLike = async (url: string) => {
      requested = url;
      return new Response(JSON.stringify(META));
    };
    const d = await fetchOidcDiscovery("https://acme", fetchLike);
    expect(requested).toBe("https://acme/.well-known/openid-configuration");
    expect(d.tokenEndpoint).toBe("https://acme/token");
    expect(d.deviceAuthorizationEndpoint).toBe("https://acme/dev");
    expect(d.jwksUri).toBe("https://acme/jwks");
  });

  test("throws when the IdP lacks a device_authorization_endpoint", async () => {
    const fetchLike = async () =>
      new Response(JSON.stringify({ issuer: "https://acme", token_endpoint: "x", jwks_uri: "y" }));
    await expect(fetchOidcDiscovery("https://acme", fetchLike)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/oidc-discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// oidc-discovery.ts
import type { FetchLike, OidcDiscovery } from "./types.ts";

export async function fetchOidcDiscovery(issuer: string, fetchLike: FetchLike): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, "");
  const res = await fetchLike(`${base}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`identity: discovery failed (${res.status})`);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object") throw new Error("identity: malformed discovery document");
  const rec = body as Record<string, unknown>;
  const dev = rec["device_authorization_endpoint"];
  const tok = rec["token_endpoint"];
  const jwks = rec["jwks_uri"];
  if (typeof dev !== "string" || typeof tok !== "string" || typeof jwks !== "string") {
    throw new Error("identity: discovery document missing device_authorization_endpoint/token_endpoint/jwks_uri");
  }
  return { issuer: base, deviceAuthorizationEndpoint: dev, tokenEndpoint: tok, jwksUri: jwks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/oidc-discovery.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/oidc-discovery.ts packages/gateway/src/identity/oidc-discovery.test.ts
git commit -m "feat(identity): OIDC .well-known discovery fetch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: OIDC device-authorization flow

**Files:**

- Create: `packages/gateway/src/identity/oidc-device-flow.ts`
- Create: `packages/gateway/src/identity/oidc-device-flow.test.ts`

RFC 8628: request a device code, then poll the token endpoint honoring `authorization_pending` / `slow_down` / `expired_token`. Injected `fetch`, `sleep`, and `now` for determinism.

- [ ] **Step 1: Write the failing test**

```typescript
// oidc-device-flow.test.ts
import { describe, expect, test } from "bun:test";
import { pollDeviceToken, requestDeviceCode } from "./oidc-device-flow.ts";

const DISCOVERY = {
  issuer: "https://acme",
  deviceAuthorizationEndpoint: "https://acme/dev",
  tokenEndpoint: "https://acme/token",
  jwksUri: "https://acme/jwks",
};

describe("requestDeviceCode", () => {
  test("POSTs client_id + scope and returns the device authorization", async () => {
    const fetchLike = async () =>
      new Response(
        JSON.stringify({ device_code: "dc", user_code: "ABCD", verification_uri: "https://acme/act", interval: 1, expires_in: 60 }),
      );
    const r = await requestDeviceCode(DISCOVERY, "client-1", ["openid"], fetchLike);
    expect(r.deviceCode).toBe("dc");
    expect(r.userCode).toBe("ABCD");
  });
});

describe("pollDeviceToken", () => {
  test("polls through authorization_pending then returns tokens", async () => {
    const bodies = [
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      new Response(JSON.stringify({ id_token: "h.p.s", refresh_token: "rt", expires_in: 3600 }), { status: 200 }),
    ];
    let i = 0;
    const fetchLike = async () => bodies[i++] as Response;
    const tok = await pollDeviceToken(DISCOVERY, "client-1", "dc", {
      fetchLike,
      sleep: async () => {},
      intervalSeconds: 1,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      onPoll: () => {},
    });
    expect(tok.idToken).toBe("h.p.s");
    expect(tok.refreshToken).toBe("rt");
  });

  test("throws on access_denied and surfaces error_description (review S1)", async () => {
    const fetchLike = async () =>
      new Response(
        JSON.stringify({ error: "access_denied", error_description: "user rejected the request", error_uri: "https://acme/help" }),
        { status: 400 },
      );
    await expect(
      pollDeviceToken(DISCOVERY, "client-1", "dc", {
        fetchLike,
        sleep: async () => {},
        intervalSeconds: 1,
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        onPoll: () => {},
      }),
    ).rejects.toThrow(/access_denied — user rejected the request \(https:\/\/acme\/help\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/oidc-device-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// oidc-device-flow.ts
import {
  type DeviceAuthResponse,
  type FetchLike,
  type OidcDiscovery,
  type TokenResponse,
  parseDeviceAuthResponse,
  parseTokenResponse,
} from "./types.ts";

function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  };
}

export async function requestDeviceCode(
  d: OidcDiscovery,
  clientId: string,
  scopes: readonly string[],
  fetchLike: FetchLike,
): Promise<DeviceAuthResponse> {
  const res = await fetchLike(d.deviceAuthorizationEndpoint, form({ client_id: clientId, scope: scopes.join(" ") }));
  if (!res.ok) throw new Error(`identity: device authorization failed (${res.status})`);
  return parseDeviceAuthResponse(await res.json());
}

export interface PollOpts {
  readonly fetchLike: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalSeconds: number;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly onPoll: () => void;
}

export async function pollDeviceToken(
  d: OidcDiscovery,
  clientId: string,
  deviceCode: string,
  opts: PollOpts,
): Promise<TokenResponse> {
  let intervalMs = opts.intervalSeconds * 1000;
  for (;;) {
    if (opts.now() > opts.deadlineMs) throw new Error("identity: device code expired before authorization");
    opts.onPoll();
    const res = await opts.fetchLike(
      d.tokenEndpoint,
      form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: clientId }),
    );
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) return parseTokenResponse(body);
    const err = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["error"] : undefined;
    if (err === "authorization_pending") {
      await opts.sleep(intervalMs);
      continue;
    }
    if (err === "slow_down") {
      intervalMs += 5000;
      await opts.sleep(intervalMs);
      continue;
    }
    // Surface the IdP's rich error fields (review S1) so operators can debug bad client_id / scopes.
    const rec = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof err === "string" ? err : "unknown";
    const desc = typeof rec["error_description"] === "string" ? ` — ${rec["error_description"] as string}` : "";
    const uri = typeof rec["error_uri"] === "string" ? ` (${rec["error_uri"] as string})` : "";
    throw new Error(`identity: device token error: ${code}${desc}${uri}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/oidc-device-flow.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/oidc-device-flow.ts packages/gateway/src/identity/oidc-device-flow.test.ts
git commit -m "feat(identity): OIDC device authorization grant (RFC 8628) request + poll

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Identity vault keys + identity runtime (login + revalidate/refresh)

**Files:**

- Create: `packages/gateway/src/identity/identity-vault.ts` (the ONLY file that names the raw-token Vault keys — I18/D14)
- Create: `packages/gateway/src/identity/identity-runtime.ts`
- Create: `packages/gateway/src/identity/identity-runtime.test.ts`

`identity-vault.ts` centralizes the three token keys so D14 can assert they appear nowhere else. `identity-runtime.ts` orchestrates `login()` (discovery → device code → poll → validate → persist session + tokens) and `revalidateSession()` (single throttled refresh attempt; review Q1).

- [ ] **Step 1: Write the failing test** (runtime with injected discovery/device-flow/verifier seams)

```typescript
// identity-runtime.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import { IdentityRuntime } from "./identity-runtime.ts";
import { isOperatorValid } from "./verifier.ts";
import type { NimbusIdentityToml } from "../config/nimbus-toml.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    store: m,
    vault: {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
      listKeys: async () => [...m.keys()],
    },
  };
}
const CFG: NimbusIdentityToml = {
  enabled: true, issuer: "https://acme", clientId: "c1", flow: "device_code",
  scopes: ["openid"], sessionGraceSeconds: 1000, revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300, jwksMaxAgeSeconds: 86400,
};
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdentityRuntime.login", () => {
  test("persists a session + stores tokens in the vault (never in DB)", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    const { vault, store: vaultMap } = fakeVault();
    const rt = new IdentityRuntime({
      cfg: CFG, store, vault, now: () => 1000,
      deps: {
        discover: async () => ({ issuer: "https://acme", deviceAuthorizationEndpoint: "d", tokenEndpoint: "t", jwksUri: "j" }),
        requestDeviceCode: async () => ({ deviceCode: "dc", userCode: "UC", verificationUri: "https://acme/act", interval: 1, expiresIn: 60 }),
        pollDeviceToken: async () => ({ idToken: "h.p.s", refreshToken: "rt", expiresIn: 3600 }),
        validateIdToken: async () => ({ sub: "sub-1", email: "a@acme.com", iss: "https://acme", aud: "c1", exp: 2, raw: {} }),
      },
    });
    const begun = await rt.login(() => {});
    expect(begun.userCode).toBe("UC");
    expect(store.getSession("https://acme")?.externalId).toBe("sub-1");
    expect(vaultMap.get("identity.oidc.id_token")).toBe("h.p.s");
    expect(vaultMap.get("identity.oidc.refresh_token")).toBe("rt");
    // no token leaked into the DB:
    const dump = JSON.stringify(db.query("SELECT * FROM identity_session").all());
    expect(dump.includes("h.p.s")).toBe(false);
  });
});

describe("IdentityRuntime.revalidateSession", () => {
  test("refresh success resets expires_at", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({ issuer: "https://acme", externalId: "s", email: null, validatedAt: 0, expiresAt: 1000, status: "active" });
    const { vault } = fakeVault();
    await vault.set("identity.oidc.refresh_token", "rt");
    let refreshed = false;
    const rt = new IdentityRuntime({
      cfg: CFG, store, vault, now: () => 5000,
      deps: {
        discover: async () => ({ issuer: "https://acme", deviceAuthorizationEndpoint: "d", tokenEndpoint: "t", jwksUri: "j" }),
        requestDeviceCode: async () => { throw new Error("n/a"); },
        pollDeviceToken: async () => { throw new Error("n/a"); },
        validateIdToken: async () => ({ sub: "s", iss: "https://acme", aud: "c1", exp: 9999, raw: {} }),
        refreshTokens: async () => { refreshed = true; return { idToken: "new", refreshToken: "rt2", expiresIn: 3600 }; },
      },
    });
    await rt.revalidateSession();
    expect(refreshed).toBe(true);
    expect(store.getSession("https://acme")?.expiresAt).toBeGreaterThan(1000);
  });

  test("refresh failure: no throw, expires_at unchanged, status still active, warn logged (review P2)", async () => {
    const db = freshDb();
    const store = new IdentityStore(db);
    store.upsertSession({ issuer: "https://acme", externalId: "s", email: null, validatedAt: 0, expiresAt: 1000, status: "active" });
    const { vault } = fakeVault();
    await vault.set("identity.oidc.refresh_token", "rt");
    const warnings: string[] = [];
    const rt = new IdentityRuntime({
      cfg: CFG, store, vault, now: () => 5000, log: (m) => warnings.push(m),
      deps: {
        discover: async () => ({ issuer: "https://acme", deviceAuthorizationEndpoint: "d", tokenEndpoint: "t", jwksUri: "j" }),
        requestDeviceCode: async () => { throw new Error("n/a"); },
        pollDeviceToken: async () => { throw new Error("n/a"); },
        validateIdToken: async () => { throw new Error("n/a"); },
        refreshTokens: async () => { throw new Error("offline"); },
      },
    });
    await rt.revalidateSession(); // must not throw
    const s = store.getSession("https://acme");
    expect(s?.expiresAt).toBe(1000); // NOT advanced
    expect(s?.status).toBe("active"); // NOT forced to expired — grace governs validity
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("relying on grace window");
    // Grace semantics (isOperatorValid): with grace=1s, valid until expires_at(1000ms)+1000ms=2000ms.
    expect(isOperatorValid(store, "https://acme", 1500, 1)).toBe(true);
    expect(isOperatorValid(store, "https://acme", 3000, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/identity-runtime.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3a: Write `identity-vault.ts`**

```typescript
// identity-vault.ts
// I18/D14: the ONLY file naming the raw-token Vault keys. The static D14 check asserts these
// literals appear nowhere outside packages/gateway/src/identity/.
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export const IDENTITY_ID_TOKEN_KEY = "identity.oidc.id_token";
export const IDENTITY_REFRESH_TOKEN_KEY = "identity.oidc.refresh_token";
export const IDENTITY_SCIM_BEARER_KEY = "identity.scim.bearer";

export async function storeOidcTokens(
  vault: NimbusVault,
  tokens: { idToken: string; refreshToken?: string },
): Promise<void> {
  await vault.set(IDENTITY_ID_TOKEN_KEY, tokens.idToken);
  if (tokens.refreshToken !== undefined) await vault.set(IDENTITY_REFRESH_TOKEN_KEY, tokens.refreshToken);
}
export async function readRefreshToken(vault: NimbusVault): Promise<string | null> {
  return vault.get(IDENTITY_REFRESH_TOKEN_KEY);
}
export async function clearOidcTokens(vault: NimbusVault): Promise<void> {
  await vault.delete(IDENTITY_ID_TOKEN_KEY);
  await vault.delete(IDENTITY_REFRESH_TOKEN_KEY);
}
export async function readScimBearer(vault: NimbusVault): Promise<string | null> {
  return vault.get(IDENTITY_SCIM_BEARER_KEY);
}
export async function writeScimBearer(vault: NimbusVault, token: string): Promise<void> {
  await vault.set(IDENTITY_SCIM_BEARER_KEY, token);
}
```

- [ ] **Step 3b: Write `identity-runtime.ts`**

```typescript
// identity-runtime.ts
import type { NimbusIdentityToml } from "../config/nimbus-toml.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { IdentityStore } from "./identity-store.ts";
import { readRefreshToken, storeOidcTokens } from "./identity-vault.ts";
import type { DeviceAuthResponse, OidcDiscovery, TokenResponse, ValidatedClaims } from "./types.ts";

export interface IdentityRuntimeDeps {
  discover(issuer: string): Promise<OidcDiscovery>;
  requestDeviceCode(d: OidcDiscovery, clientId: string, scopes: readonly string[]): Promise<DeviceAuthResponse>;
  pollDeviceToken(d: OidcDiscovery, clientId: string, deviceCode: string, onPoll: () => void): Promise<TokenResponse>;
  validateIdToken(jwt: string, nowMs: number): Promise<ValidatedClaims>;
  refreshTokens?(d: OidcDiscovery, clientId: string, refreshToken: string): Promise<TokenResponse>;
}

export class IdentityRuntime {
  private lastRevalidateMs = 0;
  constructor(
    private readonly o: {
      cfg: NimbusIdentityToml;
      store: IdentityStore;
      vault: NimbusVault;
      now: () => number;
      deps: IdentityRuntimeDeps;
      /** Warn sink for non-fatal refresh failures (review P2). Production wiring passes the structured
       *  logger's warn; defaults to a no-op so tests can assert it without a logger dependency. */
      log?: (msg: string) => void;
    },
  ) {}

  /** Begin device-code login; returns the user-facing prompt, then completes in the background-awaitable promise. */
  async login(onProgress: (info: DeviceAuthResponse) => void): Promise<DeviceAuthResponse> {
    const { cfg, deps } = this.o;
    const d = await deps.discover(cfg.issuer);
    const auth = await deps.requestDeviceCode(d, cfg.clientId, cfg.scopes);
    onProgress(auth);
    const tokens = await deps.pollDeviceToken(d, cfg.clientId, auth.deviceCode, () => {});
    await this.persist(tokens);
    return auth;
  }

  private async persist(tokens: TokenResponse): Promise<void> {
    const claims = await this.o.deps.validateIdToken(tokens.idToken, this.o.now());
    const now = this.o.now();
    this.o.store.upsertSession({
      issuer: this.o.cfg.issuer,
      externalId: claims.sub,
      email: claims.email ?? null,
      validatedAt: now,
      expiresAt: claims.exp * 1000,
      status: "active",
      claimsJson: JSON.stringify({ sub: claims.sub, email: claims.email }),
    });
    await storeOidcTokens(this.o.vault, { idToken: tokens.idToken, ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }) });
  }

  /** Single throttled refresh attempt. Never throws on refresh failure (grace is the fallback). */
  async revalidateSession(): Promise<void> {
    const { cfg, store, now, deps } = this.o;
    const t = now();
    if (t - this.lastRevalidateMs < cfg.revalidateIntervalSeconds * 1000) return;
    this.lastRevalidateMs = t;
    const session = store.getSession(cfg.issuer);
    if (session === undefined || session.status !== "active") return;
    if (t < session.expiresAt - cfg.tokenRefreshSkewSeconds * 1000) return; // not near expiry
    if (deps.refreshTokens === undefined) return;
    const refresh = await readRefreshToken(this.o.vault);
    if (refresh === null) return;
    try {
      const d = await deps.discover(cfg.issuer);
      const tokens = await deps.refreshTokens(d, cfg.clientId, refresh);
      await this.persist(tokens);
    } catch (e) {
      // offline / revoked → leave session as-is (expires_at NOT advanced, status NOT forced to
      // expired); the grace window governs isOperatorValid() until now > expires_at + grace.
      this.o.log?.(`identity: token refresh failed, relying on grace window: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
```

> The production wiring (Task 16) injects `deps` whose `validateIdToken` calls `IdTokenVerifier`, and whose `discover`/`requestDeviceCode`/`pollDeviceToken`/`refreshTokens` close over the real `fetch`, a real `sleep`, and the config-derived deadline. `refreshTokens` issues a `grant_type=refresh_token` POST (mirror `requestDeviceCode`'s `form()` helper).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/identity-runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/identity-vault.ts packages/gateway/src/identity/identity-runtime.ts packages/gateway/src/identity/identity-runtime.test.ts
git commit -m "feat(identity): IdentityRuntime login + throttled refresh; Vault-only token keys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: SCIM service (resource shape + PII allowlist + PatchOp)

**Files:**

- Create: `packages/gateway/src/identity/scim-service.ts`
- Create: `packages/gateway/src/identity/scim-service.test.ts`

Pure SCIM logic (no HTTP). Projects inbound resources through the **non-PII attribute allowlist** (spec §6.1 / review S2) before any store write, and parses PatchOps to detect `active:false`.

- [ ] **Step 1: Write the failing test**

```typescript
// scim-service.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import { applyScimCreate, parseScimPatchActive, projectScimAttrs } from "./scim-service.ts";

function freshStore(): { db: Database; store: IdentityStore } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return { db, store: new IdentityStore(db) };
}

describe("projectScimAttrs — PII allowlist (S2)", () => {
  test("keeps only allowlisted non-PII fields; drops phone/address/enterprise extension", () => {
    const attrs = projectScimAttrs({
      userName: "alice",
      displayName: "Alice A",
      name: { formatted: "Alice A", familyName: "A" },
      phoneNumbers: [{ value: "+1-555-0100" }],
      addresses: [{ streetAddress: "1 Main St" }],
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Eng", manager: { value: "m1" } },
      meta: { lastModified: "2026-06-05T00:00:00Z", resourceType: "User" },
    });
    expect(attrs).toEqual({ displayName: "Alice A", name: { formatted: "Alice A" }, meta: { lastModified: "2026-06-05T00:00:00Z" } });
  });
});

describe("applyScimCreate", () => {
  test("promotes externalId/userName/email/active and stores allowlisted attrs", () => {
    const { store } = freshStore();
    applyScimCreate(
      store,
      { externalId: "u1", userName: "alice", emails: [{ value: "a@acme.com", primary: true }], active: true, phoneNumbers: [{ value: "x" }] },
      100,
    );
    const u = store.getScimUser("u1");
    expect(u?.email).toBe("a@acme.com");
    expect(u?.active).toBe(true);
    expect(JSON.stringify(u?.attrs).includes("phoneNumbers")).toBe(false);
  });
});

describe("parseScimPatchActive", () => {
  test("detects active:false from a replace PatchOp", () => {
    expect(
      parseScimPatchActive({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] }),
    ).toBe(false);
  });
  test("detects active:false from a value-object replace", () => {
    expect(parseScimPatchActive({ Operations: [{ op: "replace", value: { active: false } }] })).toBe(false);
  });
  test("returns undefined when no active op present", () => {
    expect(parseScimPatchActive({ Operations: [{ op: "replace", path: "displayName", value: "x" }] })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/scim-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// scim-service.ts
import type { IdentityStore } from "./identity-store.ts";
import type { ScimUser } from "./types.ts";

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Non-PII allowlist (spec §6.1). Everything not named here is dropped before storage. */
export function projectScimAttrs(resource: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof resource["displayName"] === "string") out["displayName"] = resource["displayName"];
  const name = rec(resource["name"]);
  if (name !== undefined && typeof name["formatted"] === "string") out["name"] = { formatted: name["formatted"] };
  const meta = rec(resource["meta"]);
  if (meta !== undefined && typeof meta["lastModified"] === "string") out["meta"] = { lastModified: meta["lastModified"] };
  return out;
}

function primaryEmail(resource: Record<string, unknown>): string | null {
  const emails = resource["emails"];
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => rec(e)?.["primary"] === true) ?? emails[0];
  const v = rec(primary)?.["value"];
  return typeof v === "string" ? v : null;
}

export function toScimUser(resource: Record<string, unknown>): ScimUser {
  const externalId = resource["externalId"] ?? resource["id"];
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new ScimError("missing externalId", 400);
  }
  const active = resource["active"];
  return {
    externalId,
    userName: typeof resource["userName"] === "string" ? resource["userName"] : null,
    email: primaryEmail(resource),
    active: active === undefined ? true : active === true,
    attrs: projectScimAttrs(resource),
  };
}

export function applyScimCreate(store: IdentityStore, resource: Record<string, unknown>, nowMs: number): ScimUser {
  const u = toScimUser(resource);
  store.upsertScimUser(u, nowMs);
  return u;
}

/** Returns the new `active` value if a PatchOp sets it, else undefined. */
export function parseScimPatchActive(patch: Record<string, unknown>): boolean | undefined {
  const ops = patch["Operations"];
  if (!Array.isArray(ops)) return undefined;
  let result: boolean | undefined;
  for (const op of ops) {
    const o = rec(op);
    if (o === undefined) continue;
    const opName = typeof o["op"] === "string" ? o["op"].toLowerCase() : "";
    if (opName !== "replace" && opName !== "add") continue;
    if (o["path"] === "active") result = o["value"] === true;
    else {
      const val = rec(o["value"]);
      if (val !== undefined && "active" in val) result = val["active"] === true;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/scim-service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/scim-service.ts packages/gateway/src/identity/scim-service.test.ts
git commit -m "feat(identity): SCIM service — non-PII attribute allowlist + PatchOp active parsing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Deprovision → revoke federation grants

**Files:**

- Create: `packages/gateway/src/identity/deprovision.ts`
- Create: `packages/gateway/src/identity/deprovision.test.ts`

The lifecycle tie-in: `external_id → bound peer_ids → revoke each grant on every namespace`. Reuses Slice 1's `NamespaceStore.revoke`. Audited.

- [ ] **Step 1: Write the failing test** (real DB, real `NamespaceStore`, end-to-end through the query gate)

```typescript
// deprovision.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import { answerFederatedQuery } from "../federation/query-gate.ts";
import { IdentityStore } from "./identity-store.ts";
import { deprovisionUser } from "./deprovision.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("deprovisionUser", () => {
  test("revokes all bound peers' grants; the peer's next query returns no_grant", async () => {
    const db = freshDb();
    const ns = new NamespaceStore(db);
    const ids = new IdentityStore(db);
    ns.publish("project:zurich", [{ kind: "service", value: "github" }]);
    ns.grant("project:zurich", "peer:alice", "viewer", true);
    ids.upsertScimUser({ externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} }, 1);
    ids.bind("u-alice", "peer:alice", "admin", 1);

    const ctx = {
      db,
      store: ns,
      consentCache: new SessionConsentCache(),
      prompt: async () => "approved" as const,
      consentTimeoutMs: 1000,
    };
    // Before deprovision: a standing-consent grant answers (ok).
    const before = await answerFederatedQuery(ctx, { peerId: "peer:alice", request: { namespace: "project:zurich", purpose: "p" } });
    expect(before.kind).toBe("ok");

    const revoked = deprovisionUser({ db, store: ns, identity: ids, nowMs: 2 }, "u-alice");
    expect(revoked).toContain("peer:alice");

    const after = await answerFederatedQuery(ctx, { peerId: "peer:alice", request: { namespace: "project:zurich", purpose: "p" } });
    expect(after.kind).toBe("error");
    if (after.kind === "error") expect(after.error).toBe("no_grant");
    expect(ids.getScimUser("u-alice")?.active).toBe(false);
  });

  test("rolls back atomically — a mid-cascade failure leaves NO grant revoked (review P1)", () => {
    const db = freshDb();
    const ids = new IdentityStore(db);
    // A store whose revoke throws on the 2nd namespace, simulating a mid-loop write failure.
    let calls = 0;
    const failingStore = Object.assign(new NamespaceStore(db), {
      revoke(name: string, peerId: string, nowMs?: number): void {
        calls += 1;
        if (calls === 2) throw new Error("simulated write failure");
        NamespaceStore.prototype.revoke.call(this, name, peerId, nowMs);
      },
    });
    failingStore.publish("ns:a", [{ kind: "service", value: "github" }]);
    failingStore.publish("ns:b", [{ kind: "service", value: "github" }]);
    failingStore.grant("ns:a", "peer:alice", "viewer", true);
    failingStore.grant("ns:b", "peer:alice", "viewer", true);
    ids.upsertScimUser({ externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} }, 1);
    ids.bind("u-alice", "peer:alice", "admin", 1);

    expect(() => deprovisionUser({ db, store: failingStore, identity: ids, nowMs: 2 }, "u-alice")).toThrow();
    // Transaction rolled back: BOTH grants remain, scim_user still active, binding intact.
    expect(failingStore.getActiveGrant("ns:a", "peer:alice")).toBeDefined();
    expect(failingStore.getActiveGrant("ns:b", "peer:alice")).toBeDefined();
    expect(ids.getScimUser("u-alice")?.active).toBe(true);
    expect(ids.activePeerIdsFor("u-alice")).toEqual(["peer:alice"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/deprovision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// deprovision.ts
import type { Database } from "bun:sqlite";
import { appendFederationAudit } from "../federation/federation-audit.ts";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import type { IdentityStore } from "./identity-store.ts";

interface NsNameRow {
  name: string;
}

export interface DeprovisionCtx {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
  readonly nowMs: number;
}

/**
 * Mark the SCIM user inactive, then revoke every active federation grant for every peer bound to
 * that identity. Returns the peer ids whose grants were revoked. Audited per (namespace, peer).
 *
 * ATOMIC (review P1): the whole cascade — scim_user.active, every NamespaceStore.revoke, each audit
 * append, and identity_binding.revoked_at — runs inside a single `db.transaction(...)`. If any write
 * throws mid-cascade the transaction rolls back, so a deprovision is all-or-nothing (never a partial
 * state where some grants are revoked and others survive). `db.transaction` is allowed by D12 (it
 * matches neither `db.run(` nor `db.exec(`); the inner mutations still route through `dbRun` (I14).
 */
export function deprovisionUser(ctx: DeprovisionCtx, externalId: string): string[] {
  const peerIds = ctx.identity.activePeerIdsFor(externalId);
  const namespaces = ctx.db.query<NsNameRow, []>(`SELECT name FROM federation_namespaces`).all().map((r) => r.name);
  ctx.db.transaction(() => {
    ctx.identity.setScimActive(externalId, false, ctx.nowMs);
    for (const peerId of peerIds) {
      for (const ns of namespaces) {
        if (ctx.store.getActiveGrant(ns, peerId) === undefined) continue;
        ctx.store.revoke(ns, peerId, ctx.nowMs);
        appendFederationAudit(ctx.db, {
          peerId,
          namespace: ns,
          purpose: `scim-deprovision:${externalId}`,
          decision: "no_grant",
          method: "federation.query",
          timestamp: ctx.nowMs,
        });
      }
      ctx.identity.revokeBinding(peerId, ctx.nowMs);
    }
  })();
  return peerIds;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/identity/deprovision.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/identity/deprovision.ts packages/gateway/src/identity/deprovision.test.ts
git commit -m "feat(identity): SCIM deprovision revokes bound peers' federation grants (audited)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: SCIM HTTP routes on the write surface (I13)

**Files:**

- Create: `packages/gateway/src/identity/scim-http-routes.ts`
- Create: `packages/gateway/src/identity/scim-http-routes.test.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (route PATCH/DELETE + `/scim/` POST to the SCIM handler; resolve the SCIM bearer token)

The SCIM endpoint reuses the existing single `writeDb` (I13: no second writable DB) and authenticates with its OWN bearer token (`identity.scim.bearer`) via `requireBearer` (constant-time, I10). `isScimPath` + `dispatchScimRoute` own a small allowlist; rejections are bearer-gated.

- [ ] **Step 1: Write the failing test**

```typescript
// scim-http-routes.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "./identity-store.ts";
import { dispatchScimRoute, isScimPath, SCIM_WRITE_ROUTES } from "./scim-http-routes.ts";

function ctx() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return { writeDb: db, store: new NamespaceStore(db), identity: new IdentityStore(db), scimToken: "scim-secret", nowMs: () => 1 };
}
function req(method: string, path: string, token: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/scim+json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://127.0.0.1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("SCIM HTTP routes", () => {
  test("isScimPath matches /scim/v2/Users and item paths", () => {
    expect(isScimPath(new URL("http://x/scim/v2/Users"))).toBe(true);
    expect(isScimPath(new URL("http://x/scim/v2/Users/u1"))).toBe(true);
    expect(isScimPath(new URL("http://x/v1/deployments"))).toBe(false);
  });

  test("allowlist is exactly the 3 SCIM write routes", () => {
    expect([...SCIM_WRITE_ROUTES].sort()).toEqual(
      ["DELETE /scim/v2/Users/{id}", "PATCH /scim/v2/Users/{id}", "POST /scim/v2/Users"].sort(),
    );
  });

  test("401 without a valid bearer", async () => {
    const res = await dispatchScimRoute(req("POST", "/scim/v2/Users", "wrong", { externalId: "u1", userName: "a" }), ctx());
    expect(res.status).toBe(401);
  });

  test("POST provisions, PATCH active:false deprovisions", async () => {
    const c = ctx();
    c.store.publish("ns", [{ kind: "service", value: "github" }]);
    c.store.grant("ns", "peer:alice", "viewer", true);
    c.identity.bind("u1", "peer:alice", "admin", 1);
    const create = await dispatchScimRoute(req("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "alice", active: true }), c);
    expect(create.status).toBe(201);
    const patch = await dispatchScimRoute(
      req("PATCH", "/scim/v2/Users/u1", "scim-secret", { Operations: [{ op: "replace", path: "active", value: false }] }),
      c,
    );
    expect(patch.status).toBe(200);
    expect(c.store.getActiveGrant("ns", "peer:alice")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/identity/scim-http-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// scim-http-routes.ts
import type { Database } from "bun:sqlite";
import { requireBearer } from "../ipc/http-auth.ts";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import { deprovisionUser } from "./deprovision.ts";
import { IdentityStore } from "./identity-store.ts";
import { applyScimCreate, parseScimPatchActive, ScimError } from "./scim-service.ts";

/** I13 — the SCIM write surface allowlist (mirrors WRITE_ROUTE_ALLOWLIST's discipline). */
export const SCIM_WRITE_ROUTES: readonly string[] = Object.freeze([
  "POST /scim/v2/Users",
  "PATCH /scim/v2/Users/{id}",
  "DELETE /scim/v2/Users/{id}",
]);

const ITEM_RE = /^\/scim\/v2\/Users\/([^/]+)$/;

export interface ScimRouteContext {
  readonly writeDb: Database;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
  readonly scimToken: string;
  readonly nowMs: () => number;
}

export function isScimPath(url: URL): boolean {
  return url.pathname === "/scim/v2/Users" || ITEM_RE.test(url.pathname);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/scim+json" } });
}

function normalizedKey(method: string, url: URL): string | undefined {
  if (method === "POST" && url.pathname === "/scim/v2/Users") return "POST /scim/v2/Users";
  if (ITEM_RE.test(url.pathname) && (method === "PATCH" || method === "DELETE")) return `${method} /scim/v2/Users/{id}`;
  return undefined;
}

export async function dispatchScimRoute(req: Request, ctx: ScimRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const key = normalizedKey(req.method, url);
  if (key === undefined || !SCIM_WRITE_ROUTES.includes(key)) {
    return json({ detail: "not_found", status: 404 }, 404);
  }
  if (ctx.scimToken === "") return json({ detail: "scim_disabled", status: 503 }, 503);
  const auth = requireBearer(req, { expectedToken: ctx.scimToken });
  if (!auth.ok) return json({ detail: "unauthorized", status: 401 }, 401);

  try {
    if (key === "POST /scim/v2/Users") {
      const body = await req.json();
      if (body === null || typeof body !== "object") throw new ScimError("invalid body", 400);
      const u = applyScimCreate(ctx.identity, body as Record<string, unknown>, ctx.nowMs());
      return json({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id: u.externalId, userName: u.userName, active: u.active }, 201);
    }
    const id = ITEM_RE.exec(url.pathname)?.[1];
    if (id === undefined) throw new ScimError("missing id", 400);
    if (key === "DELETE /scim/v2/Users/{id}") {
      deprovisionUser({ db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() }, id);
      return new Response(null, { status: 204 });
    }
    // PATCH
    const body = await req.json();
    if (body === null || typeof body !== "object") throw new ScimError("invalid body", 400);
    const active = parseScimPatchActive(body as Record<string, unknown>);
    if (active === false) {
      deprovisionUser({ db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() }, id);
    } else if (active === true) {
      ctx.identity.setScimActive(id, true, ctx.nowMs());
    }
    const u = ctx.identity.getScimUser(id);
    return json({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id, active: u?.active ?? false }, 200);
  } catch (e) {
    if (e instanceof ScimError) return json({ detail: e.message, status: e.status }, e.status);
    return json({ detail: "internal_error", status: 500 }, 500);
  }
}
```

- [ ] **Step 4: Wire into `http-server.ts`** — in the `Bun.serve` `fetch` handler, BEFORE the existing method gate, add a SCIM branch (it needs `writeDb`, the federation `NamespaceStore`, an `IdentityStore`, and the SCIM token). Add a new optional `resolveScimToken?: () => Promise<string>` and `configDir` plumbing to `ReadOnlyHttpServerOptions`, and:

```typescript
// inside fetch(req), after `const url = new URL(req.url);`
if (writeDb !== null && opts.resolveScimToken !== undefined && isScimPath(url) && req.method !== "GET") {
  const scimToken = await opts.resolveScimToken();
  return dispatchScimRoute(req, {
    writeDb,
    store: new NamespaceStore(writeDb),
    identity: new IdentityStore(writeDb),
    scimToken,
    nowMs: opts.nowMs ?? ((): number => Date.now()),
  });
}
```

Add the imports at the top of `http-server.ts`:

```typescript
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { dispatchScimRoute, isScimPath } from "../identity/scim-http-routes.ts";
```

- [ ] **Step 5: Run tests + commit**

Run: `bun test packages/gateway/src/identity/scim-http-routes.test.ts`
Expected: PASS (4 tests).

```bash
git add packages/gateway/src/identity/scim-http-routes.ts packages/gateway/src/identity/scim-http-routes.test.ts packages/gateway/src/ipc/http-server.ts
git commit -m "feat(identity): SCIM 2.0 Users endpoint on the HTTP write surface (I13, bearer-authed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `identity.*` + `scim.*` IPC dispatcher

**Files:**

- Create: `packages/gateway/src/ipc/identity-rpc.ts`
- Create: `packages/gateway/src/ipc/identity-rpc.test.ts`

Mirrors `federation-rpc.ts`: `dispatchByMethod` map, an `IdentityRpcError`, `asRecord`/`requireString` local helpers. `identity.login` is long-running (returns `{ jobId }` and emits progress/done/error). Management/read methods return immediately.

- [ ] **Step 1: Write the failing test**

```typescript
// identity-rpc.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { dispatchIdentityRpc } from "./identity-rpc.ts";

function freshCtx() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  const store = new IdentityStore(db);
  store.upsertSession({ issuer: "https://acme", externalId: "sub-1", email: "a@acme.com", validatedAt: 0, expiresAt: 10, status: "active" });
  store.upsertScimUser({ externalId: "u1", userName: "alice", email: "a@acme.com", active: true, attrs: {} }, 1);
  return {
    db,
    issuer: "https://acme",
    identityStore: store,
    notify: () => {},
    now: () => 5,
    startLogin: () => ({ jobId: "login-1" }),
  };
}

describe("dispatchIdentityRpc", () => {
  test("identity.status returns the validated identity (no token)", async () => {
    const out = await dispatchIdentityRpc("identity.status", {}, freshCtx());
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as Record<string, unknown>;
      expect(v["externalId"]).toBe("sub-1");
      expect(JSON.stringify(v).toLowerCase().includes("token")).toBe(false);
    }
  });
  test("identity.bind binds email→peer and scim.listUsers returns the roster", async () => {
    const ctx = freshCtx();
    const bind = await dispatchIdentityRpc("identity.bind", { email: "a@acme.com", peerId: "peer:alice" }, ctx);
    expect(bind.kind).toBe("hit");
    expect(ctx.identityStore.activePeerIdsFor("u1")).toEqual(["peer:alice"]);
    const list = await dispatchIdentityRpc("scim.listUsers", {}, ctx);
    if (list.kind === "hit") expect((list.value as { users: unknown[] }).users.length).toBe(1);
  });
  test("identity.login returns a jobId (long-running)", async () => {
    const out = await dispatchIdentityRpc("identity.login", {}, freshCtx());
    if (out.kind === "hit") expect((out.value as { jobId: string }).jobId).toBe("login-1");
  });
  test("unknown method is a miss", async () => {
    expect((await dispatchIdentityRpc("identity.bogus", {}, freshCtx())).kind).toBe("miss");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/identity-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// identity-rpc.ts
import type { Database } from "bun:sqlite";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { isOperatorValid } from "../identity/verifier.ts";
import type { IdentityStore } from "../identity/identity-store.ts";

export class IdentityRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new IdentityRpcError(-32602, "ERR_INVALID_PARAMS: expected an object");
  }
  return v as Record<string, unknown>;
}
function requireString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new IdentityRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

export interface IdentityRpcContext {
  readonly db: Database;
  readonly issuer: string;
  readonly identityStore: IdentityStore;
  readonly notify: (method: string, params: unknown) => void;
  readonly now: () => number;
  /** Starts the long-running device-code login job; returns its jobId. Injected by the dispatcher wiring. */
  readonly startLogin: () => { jobId: string };
  readonly graceSeconds?: number;
}

export async function dispatchIdentityRpc(
  method: string,
  params: unknown,
  ctx: IdentityRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IdentityRpcContext>(method, params, ctx, {
    "identity.login": () => ctx.startLogin(),
    "identity.logout": () => {
      ctx.identityStore.clearSession(ctx.issuer);
      return { ok: true };
    },
    "identity.status": () => {
      const s = ctx.identityStore.getSession(ctx.issuer);
      if (s === undefined) return { loggedIn: false };
      return {
        loggedIn: true,
        externalId: s.externalId,
        email: s.email,
        issuer: s.issuer,
        expiresAt: s.expiresAt,
        status: s.status,
        operatorValid: isOperatorValid(ctx.identityStore, ctx.issuer, ctx.now(), ctx.graceSeconds ?? 0),
      };
    },
    "identity.bind": (p) => {
      const rec = asRecord(p);
      const email = requireString(rec, "email");
      const peerId = requireString(rec, "peerId");
      const user = ctx.identityStore.findScimByEmail(email);
      if (user === undefined) throw new IdentityRpcError(-32602, `ERR_NO_SUCH_USER: ${email}`);
      ctx.identityStore.bind(user.externalId, peerId, "admin", ctx.now());
      return { ok: true, externalId: user.externalId };
    },
    "identity.unbind": (p) => {
      ctx.identityStore.revokeBinding(requireString(asRecord(p), "peerId"), ctx.now());
      return { ok: true };
    },
    "identity.listBindings": (p) => {
      const rec = asRecord(p);
      const email = requireString(rec, "email");
      const user = ctx.identityStore.findScimByEmail(email);
      return { peers: user === undefined ? [] : ctx.identityStore.activePeerIdsFor(user.externalId) };
    },
    "scim.status": () => ({ users: ctx.identityStore.listScimUsers().length }),
    "scim.listUsers": () => ({ users: ctx.identityStore.listScimUsers() }),
    "scim.deprovision": (p) => {
      const email = requireString(asRecord(p), "email");
      const user = ctx.identityStore.findScimByEmail(email);
      if (user === undefined) throw new IdentityRpcError(-32602, `ERR_NO_SUCH_USER: ${email}`);
      // Imported lazily to avoid a cycle; deprovisionUser needs the federation store built from db.
      const { deprovisionUser } = require("../identity/deprovision.ts") as typeof import("../identity/deprovision.ts");
      const { NamespaceStore } = require("../federation/namespace-store.ts") as typeof import("../federation/namespace-store.ts");
      const peers = deprovisionUser(
        { db: ctx.db, store: new NamespaceStore(ctx.db), identity: ctx.identityStore, nowMs: ctx.now() },
        user.externalId,
      );
      return { ok: true, revokedPeers: peers };
    },
    // scim.setToken handled in the dispatcher wiring (Task 14) — it writes to the Vault and is not pure.
  });
}
```

> Replace the `require(...)` lazy imports with top-level `import` if no cycle exists (verify with `bun test`); the lazy form is shown only as a cycle-safety fallback. Prefer top-level imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/identity-rpc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/identity-rpc.ts packages/gateway/src/ipc/identity-rpc.test.ts
git commit -m "feat(identity): identity.* + scim.* IPC dispatcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: IPC server wiring + LAN forbiddance

**Files:**

- Modify: `packages/gateway/src/ipc/server/options.ts` (add identity options)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (add `tryDispatchIdentityRpc` + call site)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (`FORBIDDEN_OVER_LAN` += identity/scim methods)
- Create: `packages/gateway/src/ipc/identity-rpc-lan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// identity-rpc-lan.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("identity/scim methods are forbidden over LAN", () => {
  test("FORBIDDEN_OVER_LAN lists every identity.* and scim.* management method", () => {
    const src = readFileSync("packages/gateway/src/ipc/lan-rpc.ts", "utf8");
    for (const m of [
      "identity.login", "identity.status", "identity.logout", "identity.bind", "identity.unbind",
      "identity.listBindings", "scim.status", "scim.setToken", "scim.listUsers", "scim.deprovision",
    ]) {
      expect(src).toContain(`"${m}"`);
    }
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/ipc/identity-rpc-lan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three wirings**

In `lan-rpc.ts`, append to `FORBIDDEN_OVER_LAN` (after the federation block):

```typescript
  // Identity & SCIM (Slice 3): all management/read methods are local/CLI/Tauri-only — never over LAN.
  "identity.login",
  "identity.status",
  "identity.logout",
  "identity.bind",
  "identity.unbind",
  "identity.listBindings",
  "scim.status",
  "scim.setToken",
  "scim.listUsers",
  "scim.deprovision",
```

In `server/options.ts`, add to `CreateIpcServerOptions`:

```typescript
  // Identity (Phase 6 Slice 3). Present only when [identity].enabled; dispatcher skips cleanly when unset.
  identityStore?: IdentityStore;
  identityIssuer?: string;
  identityGraceSeconds?: number;
  identityStartLogin?: () => { jobId: string };
  identityVault?: NimbusVault; // for scim.setToken
```

(Add the `IdentityStore` import: `import type { IdentityStore } from "../../identity/identity-store.ts";`.)

In `server/dispatchers.ts`, add a dispatcher mirroring `tryDispatchFederationRpc`:

```typescript
import { dispatchIdentityRpc, IdentityRpcError } from "../identity-rpc.ts";
import { writeScimBearer } from "../../identity/identity-vault.ts";

export async function tryDispatchIdentityRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const store = ctx.options.identityStore;
  const issuer = ctx.options.identityIssuer;
  const index = ctx.options.localIndex;
  if (store === undefined || issuer === undefined || index === undefined) return phase4RpcSkipped;
  // scim.setToken writes a credential to the Vault — handled here, not in the pure dispatcher.
  if (method === "scim.setToken") {
    const vault = ctx.options.identityVault;
    const rec = params as Record<string, unknown>;
    if (vault === undefined || typeof rec?.["token"] !== "string") {
      throw new RpcMethodError(-32602, "ERR_INVALID_PARAMS: token required");
    }
    await writeScimBearer(vault, rec["token"]);
    return { ok: true };
  }
  try {
    const out = await dispatchIdentityRpc(method, params, {
      db: index.getDatabase(),
      issuer,
      identityStore: store,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      now: () => Date.now(),
      startLogin: ctx.options.identityStartLogin ?? (() => { throw new RpcMethodError(-32000, "identity login not wired"); }),
      ...(ctx.options.identityGraceSeconds === undefined ? {} : { graceSeconds: ctx.options.identityGraceSeconds }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IdentityRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

And add the call site next to the federation one:

```typescript
const identityOutcome = await tryDispatchIdentityRpc(ctx, method, params);
if (identityOutcome !== phase4RpcSkipped) return identityOutcome;
```

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/ipc/identity-rpc-lan.test.ts && bun test packages/gateway/src/ipc/`
Expected: PASS; no regressions in the ipc suite.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/server/options.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/identity-rpc-lan.test.ts
git commit -m "feat(identity): wire identity.*/scim.* dispatcher; forbid over LAN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: I18 — query gate consults the verifier

**Files:**

- Modify: `packages/gateway/src/federation/types.ts` (`FederationDecision` += `"identity_invalid"`)
- Modify: `packages/gateway/src/federation/query-gate.ts` (optional identity guard in `QueryGateCtx`; check at top of `answerFederatedQuery`)
- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (`FederationRpcContext` += `identityGuard`; pass into `answerFederatedQuery`)
- Create: `packages/gateway/src/federation/query-gate-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// query-gate-identity.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { NamespaceStore } from "./namespace-store.ts";
import { SessionConsentCache } from "./consent-cache.ts";
import { answerFederatedQuery } from "./query-gate.ts";

function baseCtx(db: Database) {
  const store = new NamespaceStore(db);
  store.publish("ns", [{ kind: "service", value: "github" }]);
  store.grant("ns", "peer:alice", "viewer", true);
  return { db, store, consentCache: new SessionConsentCache(), prompt: async () => "approved" as const, consentTimeoutMs: 100 };
}
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}
const q = { peerId: "peer:alice", request: { namespace: "ns", purpose: "p" } };

describe("I18 — operator identity gates federated answering", () => {
  test("invalid operator → opaque no_grant (peer learns nothing); audited as identity_invalid", async () => {
    const db = freshDb();
    const ctx = { ...baseCtx(db), identity: { enabled: true, isOperatorValid: () => false } };
    const r = await answerFederatedQuery(ctx, q);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toBe("no_grant");
    const row = db.query("SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1").get() as { action_type: string };
    expect(row.action_type).toContain("identity_invalid");
  });

  test("valid operator → answers normally", async () => {
    const db = freshDb();
    const ctx = { ...baseCtx(db), identity: { enabled: true, isOperatorValid: () => true } };
    expect((await answerFederatedQuery(ctx, q)).kind).toBe("ok");
  });

  test("identity disabled → unaffected (answers)", async () => {
    const db = freshDb();
    expect((await answerFederatedQuery(baseCtx(db), q)).kind).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/federation/query-gate-identity.test.ts`
Expected: FAIL — `identity` not on `QueryGateCtx`; audit lacks `identity_invalid`.

- [ ] **Step 3: Implement**

In `federation/types.ts`, extend the union:

```typescript
export type FederationDecision =
  | "answered"
  | "no_grant"
  | "not_paired"
  | "namespace_unknown"
  | "timeout"
  | "consent_denied"
  | "identity_invalid";
```

In `query-gate.ts`, add to `QueryGateCtx`:

```typescript
  /** I18: when identity is enabled, the answerer's own operator identity must be valid to federate. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
```

And at the TOP of `answerFederatedQuery` (before the namespace lookup):

```typescript
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    // Audited precisely; over the wire we return the SAME opaque denial as no_grant (no identity-state leak).
    audit(ctx, q, "identity_invalid");
    return { kind: "error", error: "no_grant" };
  }
```

In `ipc/federation-rpc.ts`, add `identityGuard?: { enabled: boolean; isOperatorValid: () => boolean }` to `FederationRpcContext`, and in the `federation.query` handler pass it through:

```typescript
        ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }),
```

(inside the `answerFederatedQuery({ db, store, consentCache, prompt, consentTimeoutMs, ... })` ctx object). Then in `dispatchers.ts` `tryDispatchFederationRpc`, populate `identityGuard` from the identity options when present:

```typescript
      ...(ctx.options.identityStore !== undefined && ctx.options.identityIssuer !== undefined
        ? { identityGuard: { enabled: true, isOperatorValid: () => isOperatorValid(ctx.options.identityStore!, ctx.options.identityIssuer!, Date.now(), ctx.options.identityGraceSeconds ?? 0) } }
        : {}),
```

(import `isOperatorValid` from `../../identity/verifier.ts`).

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/federation/`
Expected: PASS (existing federation tests + the new identity test).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/types.ts packages/gateway/src/federation/query-gate.ts packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/federation/query-gate-identity.test.ts
git commit -m "feat(identity): I18 — federation answering consults the operator-validity verifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Boot wiring + integration acceptance

**Files:**

- Create: `packages/gateway/src/identity/identity-boot.ts` (builds the runtime + the `startLogin` long-running closure + production `IdentityRuntimeDeps`)
- Modify: `packages/gateway/src/platform/assemble.ts` (load `[identity]`/`[scim]`, construct, wire to `ipcOpts` + the HTTP server's `resolveScimToken`)
- Create: `packages/gateway/test/integration/identity-scim-acceptance.test.ts`

- [ ] **Step 1: Write the failing integration test** (the full deprovision → `no_grant` path through the SCIM HTTP route)

```typescript
// identity-scim-acceptance.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";
import { NamespaceStore } from "../../src/federation/namespace-store.ts";
import { IdentityStore } from "../../src/identity/identity-store.ts";
import { dispatchScimRoute } from "../../src/identity/scim-http-routes.ts";
import { SessionConsentCache } from "../../src/federation/consent-cache.ts";
import { answerFederatedQuery } from "../../src/federation/query-gate.ts";

describe("Slice 3 acceptance — SCIM deprovision revokes federation access", () => {
  test("IdP DELETE /scim/v2/Users/{id} → peer's next federated query is no_grant", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const store = new NamespaceStore(db);
    const identity = new IdentityStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    store.grant("project:zurich", "peer:alice", "viewer", true);
    identity.upsertScimUser({ externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} }, 1);
    identity.bind("u-alice", "peer:alice", "admin", 1);

    const req = new Request("http://127.0.0.1/scim/v2/Users/u-alice", {
      method: "DELETE",
      headers: { authorization: "Bearer scim-secret" },
    });
    const res = await dispatchScimRoute(req, { writeDb: db, store, identity, scimToken: "scim-secret", nowMs: () => 2 });
    expect(res.status).toBe(204);

    const gate = { db, store, consentCache: new SessionConsentCache(), prompt: async () => "approved" as const, consentTimeoutMs: 100 };
    const after = await answerFederatedQuery(gate, { peerId: "peer:alice", request: { namespace: "project:zurich", purpose: "p" } });
    expect(after.kind).toBe("error");
    if (after.kind === "error") expect(after.error).toBe("no_grant");
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/test/integration/identity-scim-acceptance.test.ts`
Expected: PASS already if Tasks 10–12 are correct (this is an acceptance guard over existing modules). If it fails, fix the implicated module before proceeding. (No new production code is strictly required for this test — it locks the contract.)

- [ ] **Step 3: Write `identity-boot.ts` + wire `assemble.ts`**

`identity-boot.ts` exports `buildIdentityBoot(cfg, scimCfg, index, vault)` returning `{ store, issuer, graceSeconds, startLogin, resolveScimToken, enabled }` where:

- `store = new IdentityStore(index.getDatabase())`
- `startLogin` uses `LongRunningJobRegistry` (`jobIdPrefix: "identity-login"`, methods `identity.loginProgress`/`identity.loginDone`/`identity.loginError`) whose `run` calls `IdentityRuntime.login`, with production `IdentityRuntimeDeps` closing over real `fetch`, the `IdTokenVerifier` (built from a `JwksCache`), and a real `sleep`. Construct the `IdentityRuntime` with `log:` set to the gateway's structured-logger `warn` (review P2) so a failed background refresh is observable. The same runtime's `revalidateSession()` is invoked at boot and is safe to call before each federated op.
- `resolveScimToken = async () => (await readScimBearer(vault)) ?? ""` (returns "" when unset → SCIM route replies 503).

In `assemble.ts`, near the federation block (~line 439), add:

```typescript
const identityCfg = loadNimbusIdentityFromConfigDir(paths.configDir);
const scimCfg = loadNimbusScimFromConfigDir(paths.configDir);
if (identityCfg.enabled && localIndex !== undefined) {
  const boot = buildIdentityBoot(identityCfg, scimCfg, localIndex, vault);
  ipcOpts.identityStore = boot.store;
  ipcOpts.identityIssuer = boot.issuer;
  ipcOpts.identityGraceSeconds = boot.graceSeconds;
  ipcOpts.identityStartLogin = boot.startLogin;
  ipcOpts.identityVault = vault;
  if (scimCfg.enabled) httpOpts.resolveScimToken = boot.resolveScimToken; // wherever the read-only HTTP server opts are built
}
```

(Add imports for `loadNimbusIdentityFromConfigDir`, `loadNimbusScimFromConfigDir`, and `buildIdentityBoot`. Find where `startReadOnlyHttpServer` opts are assembled and set `resolveScimToken` there.)

- [ ] **Step 4: Run tests + commit**

Run: `bun test packages/gateway/test/integration/identity-scim-acceptance.test.ts && bun test packages/gateway/src/platform/`
Expected: PASS.

```bash
git add packages/gateway/src/identity/identity-boot.ts packages/gateway/src/platform/assemble.ts packages/gateway/test/integration/identity-scim-acceptance.test.ts
git commit -m "feat(identity): boot wiring + SCIM-deprovision acceptance test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: CLI — `nimbus identity` + `nimbus scim`

**Files:**

- Create: `packages/cli/src/commands/identity.ts`
- Create: `packages/cli/src/commands/scim.ts`
- Create: `packages/cli/src/commands/identity.test.ts`
- Create: `packages/cli/src/commands/scim.test.ts`
- Modify: `packages/cli/src/commands/registry.ts` (`COMMAND_NAMES` += `"identity"`, `"scim"` — keep alphabetical)
- Modify: `packages/cli/src/index.ts` (import `runIdentity`/`runScim`; add to `COMMAND_HANDLERS`)

Mirror `team.ts`: a pure `parseIdentityArgs`/`parseScimArgs` (unit-tested) + a `runIdentity`/`runScim` that opens an `IPCClient` and calls `client.call(...)`. `identity login` subscribes to `identity.loginProgress`/`Done`/`Error` like the reembed command.

- [ ] **Step 1: Write the failing tests** (parse functions only)

```typescript
// identity.test.ts
import { expect, test } from "bun:test";
import { parseIdentityArgs } from "./identity.ts";

test("login (default)", () => {
  expect(parseIdentityArgs([])).toEqual({ kind: "login" });
  expect(parseIdentityArgs(["login"])).toEqual({ kind: "login" });
});
test("status / logout", () => {
  expect(parseIdentityArgs(["status"])).toEqual({ kind: "status" });
  expect(parseIdentityArgs(["logout"])).toEqual({ kind: "logout" });
});
test("bind requires email + peer", () => {
  expect(parseIdentityArgs(["bind", "a@acme.com", "peer:aa"])).toEqual({ kind: "bind", email: "a@acme.com", peerId: "peer:aa" });
  expect(() => parseIdentityArgs(["bind", "a@acme.com"])).toThrow();
});
test("unbind / list-bindings", () => {
  expect(parseIdentityArgs(["unbind", "peer:aa"])).toEqual({ kind: "unbind", peerId: "peer:aa" });
  expect(parseIdentityArgs(["list-bindings", "a@acme.com"])).toEqual({ kind: "listBindings", email: "a@acme.com" });
});
test("unknown throws", () => {
  expect(() => parseIdentityArgs(["bogus"])).toThrow();
});
```

```typescript
// scim.test.ts
import { expect, test } from "bun:test";
import { parseScimArgs } from "./scim.ts";

test("status / list-users defaults", () => {
  expect(parseScimArgs(["status"])).toEqual({ kind: "status" });
  expect(parseScimArgs(["list-users"])).toEqual({ kind: "listUsers" });
});
test("set-token requires a token", () => {
  expect(parseScimArgs(["set-token", "secret"])).toEqual({ kind: "setToken", token: "secret" });
  expect(() => parseScimArgs(["set-token"])).toThrow();
});
test("deprovision requires an email", () => {
  expect(parseScimArgs(["deprovision", "a@acme.com"])).toEqual({ kind: "deprovision", email: "a@acme.com" });
  expect(() => parseScimArgs(["deprovision"])).toThrow();
});
```

- [ ] **Step 2: Run them red**

Run: `bun test packages/cli/src/commands/identity.test.ts packages/cli/src/commands/scim.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `identity.ts`** (parse + run; mirror `team.ts` structure)

```typescript
// identity.ts
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type IdentityCommand =
  | { kind: "login" }
  | { kind: "status" }
  | { kind: "logout" }
  | { kind: "bind"; email: string; peerId: string }
  | { kind: "unbind"; peerId: string }
  | { kind: "listBindings"; email: string };

export function parseIdentityArgs(argv: string[]): IdentityCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "login":
      return { kind: "login" };
    case "status":
      return { kind: "status" };
    case "logout":
      return { kind: "logout" };
    case "bind": {
      const [email, peerId] = [rest[0], rest[1]];
      if (!email || !peerId) throw new Error("Usage: nimbus identity bind <email> <peerId>");
      return { kind: "bind", email, peerId };
    }
    case "unbind": {
      const peerId = rest[0];
      if (!peerId) throw new Error("Usage: nimbus identity unbind <peerId>");
      return { kind: "unbind", peerId };
    }
    case "list-bindings": {
      const email = rest[0];
      if (!email) throw new Error("Usage: nimbus identity list-bindings <email>");
      return { kind: "listBindings", email };
    }
    default:
      throw new Error(`Unknown subcommand: ${sub}\nUsage: nimbus identity [login|status|logout|bind|unbind|list-bindings]`);
  }
}

function awaitLogin(client: IPCClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let jobId: string | undefined;
    client.onNotification("identity.loginProgress", (n: unknown) => {
      const p = n as { jobId: string; verificationUri?: string; userCode?: string };
      if (jobId === undefined || p.jobId !== jobId) return;
      if (p.verificationUri && p.userCode) {
        process.stdout.write(`Open ${p.verificationUri} and enter code: ${p.userCode}\n`);
      }
    });
    client.onNotification("identity.loginDone", (n: unknown) => {
      if ((n as { jobId: string }).jobId === jobId) resolve();
    });
    client.onNotification("identity.loginError", (n: unknown) => {
      const p = n as { jobId: string; message: string };
      if (p.jobId === jobId) reject(new Error(p.message));
    });
    client.call<{ jobId: string }>("identity.login", {}).then((r) => { jobId = r.jobId; }).catch(reject);
  });
}

export async function runIdentity(argv: string[]): Promise<void> {
  let cmd: IdentityCommand;
  try {
    cmd = parseIdentityArgs(argv);
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
      case "login":
        await awaitLogin(client);
        process.stdout.write("Logged in.\n");
        break;
      case "status": {
        const r = await client.call<unknown>("identity.status", {});
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "logout":
        await client.call("identity.logout", {});
        process.stdout.write("Logged out.\n");
        break;
      case "bind":
        await client.call("identity.bind", { email: cmd.email, peerId: cmd.peerId });
        process.stdout.write(`Bound ${cmd.email} → ${cmd.peerId}\n`);
        break;
      case "unbind":
        await client.call("identity.unbind", { peerId: cmd.peerId });
        process.stdout.write(`Unbound ${cmd.peerId}\n`);
        break;
      case "listBindings": {
        const r = await client.call<unknown>("identity.listBindings", { email: cmd.email });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}
```

- [ ] **Step 3b: Implement `scim.ts`** (same shape; subcommands `status|set-token|list-users|deprovision` → `scim.status`/`scim.setToken`/`scim.listUsers`/`scim.deprovision`). Parser:

```typescript
// scim.ts (parser excerpt — runScim mirrors runIdentity's client.call dispatch)
export type ScimCommand =
  | { kind: "status" }
  | { kind: "setToken"; token: string }
  | { kind: "listUsers" }
  | { kind: "deprovision"; email: string };

export function parseScimArgs(argv: string[]): ScimCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return { kind: "status" };
    case "set-token": {
      const token = rest[0];
      if (!token) throw new Error("Usage: nimbus scim set-token <token>");
      return { kind: "setToken", token };
    }
    case "list-users":
      return { kind: "listUsers" };
    case "deprovision": {
      const email = rest[0];
      if (!email) throw new Error("Usage: nimbus scim deprovision <email>");
      return { kind: "deprovision", email };
    }
    default:
      throw new Error(`Unknown subcommand: ${sub}\nUsage: nimbus scim [status|set-token|list-users|deprovision]`);
  }
}
```

- [ ] **Step 3c: Register the commands**

In `registry.ts` `COMMAND_NAMES`, insert `"identity"` (after `"help"`) and `"scim"` (after `"scaffold"`/before `"search"`) — keep alphabetical order.

In `index.ts`: add `import { runIdentity } from "./commands/identity.ts";` and `import { runScim } from "./commands/scim.ts";`, then in `COMMAND_HANDLERS` add `identity: runIdentity,` and `scim: runScim,`.

- [ ] **Step 4: Run green**

Run: `bun test packages/cli/src/commands/identity.test.ts packages/cli/src/commands/scim.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/identity.ts packages/cli/src/commands/scim.ts packages/cli/src/commands/identity.test.ts packages/cli/src/commands/scim.test.ts packages/cli/src/commands/registry.ts packages/cli/src/index.ts
git commit -m "feat(identity): nimbus identity + nimbus scim CLI commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Tauri allowlist + I18 invariant triple + static D14

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` += 6 methods; `assert_eq!` 67 → 73; mark `identity.login` long-running per the file's existing long-running mechanism)
- Modify: `packages/gateway/src/security-invariants.test.ts` (count mirror 67 → 73; new I18 block)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (new `checkIdentityTokenVaultInvariant` = D14; register in `run()` + `Mode`)
- Create: `scripts/structure-audit/check-identity-d14.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` (I18 row), `docs/roadmap.md` (flip the two Identity & Access rows), `docs/CHANGELOG.md`, `docs/cli-reference.md`

> **Correction baked in:** the existing D11 vault-key check (`buildVaultKeyRegex`) is built ONLY from `CONNECTOR_VAULT_SECRET_KEYS`, so it will NOT catch the `identity.*` keys. Do **not** rely on adding identity keys to `VAULT_KEY_ALLOW_LIST` (a no-op). The real enforcement is the new purpose-built **D14** check below.

- [ ] **Step 1: Write the failing tests**

Add to `security-invariants.test.ts`:

```typescript
describe("I18 — IdP token validation is intrinsic + tokens are Vault-only", () => {
  test("identity.* read/login methods are in the Tauri allowlist; bind/setToken are NOT", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["identity.login", "identity.status", "identity.logout", "identity.listBindings", "scim.status", "scim.listUsers"]) {
      expect(rust).toContain(`"${m}"`);
    }
    expect(rust).not.toMatch(/^\s*"scim\.setToken",\s*$/m);
    expect(rust).not.toMatch(/^\s*"identity\.bind",\s*$/m);
  });
  test("allowlist_exact_size assertion is 73", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*73\s*\)/);
  });
  test("only the identity verifier validates an ID token; query-gate consults it", async () => {
    const gate = await read("packages/gateway/src/federation/query-gate.ts");
    expect(gate).toContain("isOperatorValid");
  });
});
```

Add `check-identity-d14.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { checkIdentityTokenVaultInvariant } from "./check-nimbus-invariants.ts";

describe("D14 — identity token Vault keys stay inside identity/", () => {
  test("flags an identity token key literal used outside packages/gateway/src/identity/", () => {
    const v = checkIdentityTokenVaultInvariant([
      { relPath: "packages/gateway/src/ipc/leaky.ts", contents: `const k = "identity.oidc.id_token";` },
    ]);
    expect(v.length).toBe(1);
    expect(v[0]?.rule).toBe("D14-identity-token");
  });
  test("allows the same literal inside identity/", () => {
    const v = checkIdentityTokenVaultInvariant([
      { relPath: "packages/gateway/src/identity/identity-vault.ts", contents: `export const K = "identity.oidc.id_token";` },
    ]);
    expect(v.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run them red**

Run: `bun test packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-identity-d14.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `gateway_bridge.rs` `ALLOWED_METHODS`, add (keep sorted): `"identity.listBindings"`, `"identity.login"`, `"identity.logout"`, `"identity.status"`, `"scim.listUsers"`, `"scim.status"`. Change `assert_eq!(ALLOWED_METHODS.len(), 67);` → `73`. If the file marks long-running methods in a separate list, add `identity.login` there.

In `check-nimbus-invariants.ts`, add:

```typescript
const IDENTITY_TOKEN_KEYS = ["identity.oidc.id_token", "identity.oidc.refresh_token", "identity.scim.bearer"];
const IDENTITY_DIR = "packages/gateway/src/identity/";

export function checkIdentityTokenVaultInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.startsWith(IDENTITY_DIR) || f.relPath.endsWith(".test.ts")) continue;
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (IDENTITY_TOKEN_KEYS.some((k) => line.includes(`"${k}"`) || line.includes(`'${k}'`))) {
        out.push({ rule: "D14-identity-token", file: f.relPath, line: i + 1, snippet: line.trim() });
      }
    }
  }
  return out;
}
```

Register it in `run()` alongside D13 (the `"binary-only" || "all"` block):

```typescript
  if (mode === "binary-only" || mode === "all") {
    const v = checkIdentityTokenVaultInvariant(files);
    for (const e of v) {
      console.error(`::error file=${e.file},line=${e.line}::D14 identity token key used outside identity/ — I18 regression: ${e.snippet}`);
    }
    if (v.length > 0) exit = 1;
  }
```

In `security-invariants.test.ts`, update the existing `allowlist_exact_size` test from 67 → 73 (search for `67`).

- [ ] **Step 4: Docs** — add the I18 row to `docs/SECURITY-INVARIANTS.md` (rationale + anti-pattern, mirroring I17), the CLAUDE.md + GEMINI.md invariant tables, and the static-complement paragraph (mention D14). Flip `docs/roadmap.md` Identity & Access rows `- [ ]` → `- [x]` for SSO/OIDC + SCIM with a Slice 3 delivered note. Add a `docs/CHANGELOG.md` entry. Add `nimbus identity` / `nimbus scim` to `docs/cli-reference.md`. Markdown-lint-fix all touched docs:

Run: `bunx markdownlint-cli2 --fix "docs/**/*.md" "CLAUDE.md" "GEMINI.md"`

- [ ] **Step 5: Run green + commit**

Run: `bun test packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-identity-d14.test.ts && bun run audit:structure` (or the script that runs `check-nimbus-invariants.ts --binary-only`)
Expected: PASS; static check exits 0 on the real tree.

```bash
git add -A
git commit -m "feat(identity): I18 invariant triple + static D14 + Tauri allowlist (73) + docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Full preflight + Linux coverage-floor

**Files:** none (verification only)

- [ ] **Step 1: Biome + typecheck**

Run: `bun run preflight:fast`
Expected: all static gates green. Fix any `no-any`/lint/typecheck issues in the new files.

- [ ] **Step 2: Full test suite + full preflight**

Run: `bun run preflight`
Expected: green. If a coverage gate trips on Windows for an unrelated file, treat it as a Windows flake (see Step 3) — but the new `identity/` files must genuinely clear ≥80%.

- [ ] **Step 3: Linux-authoritative coverage-floor (Docker)** — Windows local coverage flakes on unrelated files; Linux is authoritative.

```bash
docker run --rm -v "C:/gitrep/Nimbus/.worktrees/phase6-slice3-identity":/src:ro oven/bun:latest bash -lc \
  'apt-get update -qq && apt-get install -y -qq git >/dev/null && mkdir -p /app && (cd /src && tar --exclude=node_modules --exclude=.git -cf - .) | (cd /app && tar -xf -) && cd /app && bun install && bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor'
```

Expected: `audit:coverage-floor` passes. If an `identity/` file is `<80%` on Linux, add the missing test cases (usually an error branch) and re-run.

- [ ] **Step 4: Stop and report.** Do not push or open the PR. Summarize: tasks complete, preflight result, Linux coverage-floor result. Wait for the user to confirm before pushing.

---

## Self-Review (completed during planning)

- **Spec coverage:** OIDC device-code SSO (Tasks 7–9), Vault-only tokens (Task 9, `identity-vault.ts`), ID-token validation on session/federation (Task 6 + 15), SCIM SP endpoint (Tasks 10–12), deprovision→revoke (Task 11), `scim_user↔peer_id` binding handshake+admin (Tasks 4/13; handshake-claim auto-bind rides the inbound `approveInboundPair` seam — admin `identity.bind` is the active path in Slice 3, consistent with the spec's deferred-outbound note), config (Task 3), IPC+Tauri+CLI (Tasks 13/14/17/18), I18 triple + D14 (Tasks 6/15/18), V34 migration (Task 1), review fixes Q1/Q2/S1/S2/T1 (Tasks 9/5/1/10 + the mock-OIDC E2E is realized as the injected-fetch device-flow test in Task 8 + acceptance Task 16). All covered.
- **Type consistency:** `IdentityStore` method names, `ValidatedClaims`, `TokenResponse`, `DeviceAuthResponse`, `isOperatorValid(store, issuer, nowMs, graceSeconds)`, `deprovisionUser(ctx, externalId)`, `dispatchScimRoute(req, ctx)`, `SCIM_WRITE_ROUTES` are used identically across tasks.
- **Migration caveat:** the branch-time check (top of plan) guards the V34/V35 contiguity risk.
- **Known correction recorded:** D11 is connector-key-scoped → identity keys need the purpose-built D14 (Task 18), not a `VAULT_KEY_ALLOW_LIST` entry.
