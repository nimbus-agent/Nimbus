# Coverage Floor Phase 1B — Critical Paths (OAuth + Credential Orchestration + DB Recovery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise per-file line coverage to ≥80% for the 5 critical-path gateway files in Phase 1B of the coverage-floor initiative, and remove all 5 from `docs/structure-audit/coverage-baseline.json`.

**Architecture:** Per-file unit tests using existing in-repo helpers (no shared harness — those land in Phases 2/3). Each test exercises uncovered branches in already-shipped logic with assertions on meaningful surface (DB rows, audit entries, vault writes, RPC error codes), not "function was called." Tests are added under `packages/gateway/test/unit/`, mirroring source paths.

**Tech Stack:** `bun test`, `bun:sqlite` `Database`, `MockVault` from `packages/gateway/src/vault/mock.ts`, real `Bun.serve` for OAuth callback testing, injected `PKCEFetch` double, temp dirs via `node:fs` `mkdtempSync` + `node:os` `tmpdir`.

**Spec:** [docs/superpowers/specs/2026-05-17-coverage-floor-design.md](../specs/2026-05-17-coverage-floor-design.md) §Phasing §Phase 1.

**Files in scope (current baseline → goal):**

| File                                                                    | Current | Existing test                                             |
| ----------------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `packages/gateway/src/auth/pkce.ts`                                     | 65.10%  | none (indirect coverage from integration tests)           |
| `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`               | 6.28%   | none                                                      |
| `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts` | 4.44%   | none                                                      |
| `packages/gateway/src/db/snapshot.ts`                                   | 10.05%  | none                                                      |
| `packages/gateway/src/db/repair.ts`                                     | 34.76%  | `packages/gateway/test/unit/db/repair.test.ts` (gap-fill) |

---

## File Structure

**New test files (5):**

| Path                                                                               | Responsibility                                                                                                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/gateway/test/unit/auth/pkce.test.ts`                                     | `pkceCodeChallengeS256`, `refreshAccessToken`, `refreshSlackUserToken`, `refreshNotionToken`, `runPKCEFlow` end-to-end with real `Bun.serve` |
| `packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts`               | `handleConnectorAuth` dispatch + each connector-specific auth helper (PAT-based, multi-secret cloud, observability, OAuth/PKCE dispatch)     |
| `packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts` | `ensureCredentialConnectorsRunning` + each `ensureXxx*` helper with mocked spawn functions                                                   |
| `packages/gateway/test/unit/db/snapshot.test.ts`                                   | `takeSnapshot`, `listSnapshots`, `previewRestore`, `restoreSnapshot`, `pruneSnapshots`, `startSnapshotScheduler`, `formatSnapshotList`       |
| (extend existing) `packages/gateway/test/unit/db/repair.test.ts`                   | Gap-fill: `repairVecOrphans`, `repairForeignKeys`, multi-action scenarios, error paths, `isUnsafeSqlIdentifier` guard                        |

**Modified files (1):**

- `docs/structure-audit/coverage-baseline.json` — remove the 5 entries above (one final commit after lcov verification).

**No production source changes** unless a test surfaces a genuine bug. If a test fails because the production code has a defect, fix it in the same commit and call it out in the commit message.

---

## TDD Cycle for Coverage Work

The standard TDD red→green cycle applies _with a twist_ — the production implementation already exists, so:

1. **Write a focused test** that exercises a specific uncovered branch or function.
2. **Run it.** Two outcomes:
   - **PASS** — the test covers existing logic correctly. This is the goal — move on.
   - **FAIL** — either (a) the test has a bug and needs fixing, or (b) production code has a defect. If (b), fix the production code in the same commit and note it in the commit message.
3. **Commit** the test (and any production fix).
4. **Continue** until the file's coverage ≥80% in CI Linux lcov.

After all 5 files have tests landed, run the local lcov build once to verify each file ≥80%, then **remove the 5 entries from the baseline JSON in a single commit** (per spec §The Ratchet rule 4).

---

## Task 1: Set up isolated worktree

**Files:**

- New worktree: `.worktrees/coverage-floor-phase-1b-2026-05-17/`
- New branch: `dev/asafgolombek/coverage-floor-phase-1b-2026-05-17`

- [ ] **Step 1: Invoke using-git-worktrees skill**

The skill creates the worktree + branch. Run it via the `Skill` tool with skill name `superpowers:using-git-worktrees`.

Pass these parameters when the skill asks:

- Branch name: `dev/asafgolombek/coverage-floor-phase-1b-2026-05-17`
- Base branch: `main`
- Worktree path: `.worktrees/coverage-floor-phase-1b-2026-05-17/`

- [ ] **Step 2: Verify the worktree was created**

Run: `git worktree list`
Expected: shows `.worktrees/coverage-floor-phase-1b-2026-05-17` on the new branch.

- [ ] **Step 3: Switch working directory to the worktree**

All subsequent file paths in this plan are relative to `.worktrees/coverage-floor-phase-1b-2026-05-17/`. Note: per CLAUDE.md, never prepend `cd` to `git` commands — git uses the worktree-aware cwd already.

- [ ] **Step 4: Verify `bun install` works in the worktree**

Run: `bun install`
Expected: no errors; node_modules populated.

---

## Task 2: db/repair.ts — fill coverage gaps

**Goal:** Raise `packages/gateway/src/db/repair.ts` from 34.76% to ≥80% by adding tests for the four uncovered branches: `repairVecOrphans`, `repairForeignKeys`, multi-action scenarios, and the `isUnsafeSqlIdentifier` guard.

**Files:**

- Modify: `packages/gateway/test/unit/db/repair.test.ts`
- Read for context (do not modify): `packages/gateway/src/db/repair.ts`

- [ ] **Step 1: Read the existing test file**

Read `packages/gateway/test/unit/db/repair.test.ts` end-to-end. Note the `makeDb()` helper, the `beforeEach`/`afterEach` lifecycle, and the assertion style. New tests reuse these.

- [ ] **Step 2: Read the source to confirm function signatures**

Read `packages/gateway/src/db/repair.ts`. Confirm the exact signatures of:

- `repairIndex(db, opts?)` and what `opts` accepts
- The four internal helpers and what each repairs
- `isUnsafeSqlIdentifier(identifier)` — what counts as unsafe

- [ ] **Step 3: Write the failing test — vec orphan repair**

Append to `packages/gateway/test/unit/db/repair.test.ts`:

```typescript
describe("repairIndex — vec orphans", () => {
  it("deletes vec_items_384 rows with no matching items row and reports the count", () => {
    const db = makeDb();

    // Seed: one valid item with embedding, one orphan vec row.
    db.run("INSERT INTO items (id, service, type, title, updated_at) VALUES ('valid:1', 'github', 'pr', 't', 0)");
    // Insert a vec row for an item that doesn't exist.
    db.run("INSERT INTO embedding_chunk (id, item_id, chunk_index, text) VALUES ('chunk:orphan:0', 'orphan:1', 0, '')");
    // Insert into the vec_items_384 virtual table (matches the chunk).
    // NOTE: the exact INSERT format depends on the V<N> migration — confirm against
    // the SQL in `packages/gateway/src/index/vec-items-*-v*-sql.ts` while writing.

    const report = repairIndex(db);

    const vecOutcome = report.outcomes.find((o) => o.action === "vec_orphan_delete");
    expect(vecOutcome?.status).toBe("applied");
    expect(vecOutcome?.detail).toMatch(/\d+/); // detail includes affected count

    db.close();
  });
});
```

**If the exact INSERT into the virtual table doesn't match the schema, read the migration SQL constant for the right `vec_items_*` table name and column shape, then adjust the seed.** If the helper genuinely cannot be invoked without modifying source, the test should call `repairIndex(db)` and assert the `repairVecOrphans` outcome regardless of pre-state — the existing-clean-DB test path stays at "skipped" status.

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/test/unit/db/repair.test.ts -t "vec orphans"`
Expected: PASS (the function is already implemented; the test exercises previously-uncovered lines).

- [ ] **Step 5: Write the failing test — foreign-key cascade repair**

Append to the same file:

```typescript
describe("repairIndex — foreign-key cascade", () => {
  it("deletes rows referencing nonexistent items and reports per-table counts", () => {
    const db = makeDb();
    // Seed a FK-violating row. E.g. embedding_chunk row whose item_id doesn't exist.
    db.run("INSERT INTO embedding_chunk (id, item_id, chunk_index, text) VALUES ('orphan-chunk:1', 'ghost-item', 0, 'x')");

    const report = repairIndex(db);

    const fkOutcome = report.outcomes.find((o) => o.action === "foreign_key_cascade_delete");
    expect(fkOutcome?.status).toBe("applied");
    expect(fkOutcome?.detail).toContain("embedding_chunk"); // detail names the affected table

    const remaining = db.query("SELECT COUNT(*) AS n FROM embedding_chunk").get() as { n: number };
    expect(remaining.n).toBe(0);

    db.close();
  });
});
```

- [ ] **Step 6: Run the FK test**

Run: `bun test packages/gateway/test/unit/db/repair.test.ts -t "foreign-key cascade"`
Expected: PASS. If the table list cascaded by `repairForeignKeys` doesn't include `embedding_chunk`, read the source to find one that is cascaded and seed against that.

- [ ] **Step 7: Write the failing test — unsafe SQL identifier guard**

Append:

```typescript
describe("repairForeignKeys — identifier injection defense (S5-F6)", () => {
  it("isUnsafeSqlIdentifier rejects identifiers with quotes / semicolons / spaces", () => {
    // isUnsafeSqlIdentifier is a private helper. The test must reach it via repairIndex
    // running over an internally-defined list. The defense is structural — if
    // isUnsafeSqlIdentifier is unreachable from the public API, this test asserts
    // that no repair outcome ever produces unsafe SQL by checking each detail string
    // does not contain SQL-injection sentinels.
    const db = makeDb();
    const report = repairIndex(db);
    for (const o of report.outcomes) {
      expect(o.detail ?? "").not.toMatch(/[;'"]/);
    }
    db.close();
  });
});
```

If `isUnsafeSqlIdentifier` is exported, prefer a direct unit test:

```typescript
import { isUnsafeSqlIdentifier } from "../../../src/db/repair";

it("rejects identifiers with quotes / semicolons / spaces", () => {
  expect(isUnsafeSqlIdentifier("items")).toBe(false);
  expect(isUnsafeSqlIdentifier("items;DROP")).toBe(true);
  expect(isUnsafeSqlIdentifier('items"')).toBe(true);
  expect(isUnsafeSqlIdentifier("two words")).toBe(true);
});
```

- [ ] **Step 8: Run the identifier-guard test**

Run: `bun test packages/gateway/test/unit/db/repair.test.ts -t "identifier"`
Expected: PASS.

- [ ] **Step 9: Write the failing test — multi-action report**

Append:

```typescript
describe("repairIndex — multi-action report", () => {
  it("returns one outcome per action with status 'applied' or 'skipped'", () => {
    const db = makeDb();
    const report = repairIndex(db);

    const seenActions = new Set(report.outcomes.map((o) => o.action));
    expect(seenActions.has("vec_orphan_delete")).toBe(true);
    expect(seenActions.has("fts5_rebuild")).toBe(true);
    expect(seenActions.has("orphaned_sync_tokens_delete")).toBe(true);
    expect(seenActions.has("foreign_key_cascade_delete")).toBe(true);

    for (const o of report.outcomes) {
      expect(["applied", "skipped", "error"]).toContain(o.status);
    }
    expect(report.repairedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601

    db.close();
  });
});
```

- [ ] **Step 10: Run the multi-action test**

Run: `bun test packages/gateway/test/unit/db/repair.test.ts -t "multi-action"`
Expected: PASS.

- [ ] **Step 11: Run the full repair test file + check coverage locally**

Run: `bun test packages/gateway/test/unit/db/repair.test.ts --coverage`
Expected: all tests PASS; the printed coverage table shows `db/repair.ts` at ≥80%. If below, identify the missing branch from the `# Uncovered Lines` annotation and add one targeted test for it.

- [ ] **Step 12: Commit**

```bash
git add packages/gateway/test/unit/db/repair.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): cover vec-orphan + FK cascade + identifier guard in db/repair

Adds tests for the four uncovered branches in `repairIndex`:
- `repairVecOrphans` cleanup + count reporting
- `repairForeignKeys` cascade across joined tables
- `isUnsafeSqlIdentifier` defense (S5-F6)
- multi-action report shape + ISO-8601 timestamp

Raises `db/repair.ts` past the 80% per-file floor; baseline removal follows
in the same PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: db/snapshot.ts — full coverage

**Goal:** Raise `packages/gateway/src/db/snapshot.ts` from 10.05% to ≥80% by adding tests for all 7 exports + the scheduler lifecycle. Uses a real temp dir (because `VACUUM INTO` writes actual files).

**Files:**

- Create: `packages/gateway/test/unit/db/snapshot.test.ts`
- Read for context: `packages/gateway/src/db/snapshot.ts`, `packages/gateway/test/unit/db/repair.test.ts` (for the `makeDb()` pattern)

- [ ] **Step 1: Read the source**

Read `packages/gateway/src/db/snapshot.ts` end-to-end. Note the filename format (`snapshot-<timestamp>.db.gz`), the `dbRun(VACUUM INTO)` call, the gzip wrapper, and the scheduler's `setInterval` handle.

- [ ] **Step 2: Create the test file scaffolding**

Write `packages/gateway/test/unit/db/snapshot.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "../../../src/index/local-index";
import { takeSnapshot, listSnapshots, previewRestore, restoreSnapshot, pruneSnapshots, startSnapshotScheduler, formatSnapshotList, DEFAULT_SNAPSHOT_CONFIG } from "../../../src/db/snapshot";

function makeDbAt(path: string): Database {
  const db = new Database(path);
  LocalIndex.ensureSchema(db);
  // Seed two items so snapshot/restore have content to compare.
  db.run("INSERT INTO items (id, service, type, title, updated_at) VALUES ('a:1','github','pr','seed-a',0)");
  db.run("INSERT INTO items (id, service, type, title, updated_at) VALUES ('a:2','github','pr','seed-b',0)");
  return db;
}

describe("db/snapshot", () => {
  let tmp: string;
  let dbPath: string;
  let snapshotsDir: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-snapshot-test-"));
    dbPath = join(tmp, "nimbus.db");
    snapshotsDir = join(tmp, "snapshots");
    db = makeDbAt(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Add the `takeSnapshot` happy-path test**

Inside the `describe` block:

```typescript
it("takeSnapshot writes a gzipped snapshot and returns metadata", async () => {
  const entry = await takeSnapshot({ dbPath, snapshotsDir });

  expect(existsSync(entry.path)).toBe(true);
  expect(entry.filename).toMatch(/^snapshot-\d+\.db\.gz$/);
  expect(entry.compressedSizeBytes).toBeGreaterThan(0);
  expect(entry.timestampMs).toBeLessThanOrEqual(Date.now());

  // Confirm the magic bytes — first 2 bytes of gzip are 0x1f 0x8b.
  const bytes = readFileSync(entry.path);
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
});
```

- [ ] **Step 4: Add the `listSnapshots` ordering test**

```typescript
it("listSnapshots returns entries sorted newest-first", async () => {
  const a = await takeSnapshot({ dbPath, snapshotsDir });
  // Force a different timestamp.
  await new Promise((r) => setTimeout(r, 5));
  const b = await takeSnapshot({ dbPath, snapshotsDir });

  const entries = await listSnapshots({ snapshotsDir });
  expect(entries).toHaveLength(2);
  expect(entries[0].timestampMs).toBeGreaterThanOrEqual(entries[1].timestampMs);
  expect(entries[0].path).toBe(b.path);
  expect(entries[1].path).toBe(a.path);
});

it("listSnapshots returns empty array when dir does not exist", async () => {
  const entries = await listSnapshots({ snapshotsDir: join(tmp, "does-not-exist") });
  expect(entries).toEqual([]);
});

it("listSnapshots ignores files that don't match the naming pattern", async () => {
  await takeSnapshot({ dbPath, snapshotsDir });
  // Drop an unrelated file in the same dir.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(snapshotsDir, "not-a-snapshot.txt"), "garbage");

  const entries = await listSnapshots({ snapshotsDir });
  expect(entries).toHaveLength(1);
  expect(entries[0].filename).toMatch(/^snapshot-/);
});
```

- [ ] **Step 5: Add the `previewRestore` test**

```typescript
it("previewRestore decompresses into a temp DB and reports row counts", async () => {
  const entry = await takeSnapshot({ dbPath, snapshotsDir });

  // Mutate the live DB after snapshot.
  db.run("INSERT INTO items (id, service, type, title, updated_at) VALUES ('a:3','github','pr','live-only',0)");

  const preview = await previewRestore({ snapshotPath: entry.path, livePath: dbPath });

  expect(preview.snapshotItemCount).toBe(2);
  expect(preview.liveItemCount).toBe(3);
  // The preview must not have mutated the live DB.
  const live = db.query("SELECT COUNT(*) as n FROM items").get() as { n: number };
  expect(live.n).toBe(3);
});
```

If `previewRestore` returns a shape different from `{ snapshotItemCount, liveItemCount }`, **read the type definition first** and adjust the assertions to match the actual shape.

- [ ] **Step 6: Add the `restoreSnapshot` test**

```typescript
it("restoreSnapshot overwrites the live DB file from a snapshot", async () => {
  const entry = await takeSnapshot({ dbPath, snapshotsDir });

  db.run("INSERT INTO items (id, service, type, title, updated_at) VALUES ('a:99','github','pr','post-snap',0)");
  db.close();

  await restoreSnapshot({ snapshotPath: entry.path, livePath: dbPath });

  const restored = new Database(dbPath);
  const n = restored.query("SELECT COUNT(*) as n FROM items").get() as { n: number };
  expect(n.n).toBe(2); // back to the snapshot's row count
  restored.close();

  // Re-open db for afterEach cleanup.
  db = new Database(dbPath);
});
```

- [ ] **Step 7: Add the `pruneSnapshots` retention test**

```typescript
it("pruneSnapshots keeps the N newest and deletes the rest", async () => {
  // Make 5 snapshots with distinct timestamps.
  const created = [];
  for (let i = 0; i < 5; i++) {
    created.push(await takeSnapshot({ dbPath, snapshotsDir }));
    await new Promise((r) => setTimeout(r, 2));
  }

  const pruned = await pruneSnapshots({ snapshotsDir, keepLast: 2 });
  expect(pruned.deleted).toBe(3);

  const remaining = await listSnapshots({ snapshotsDir });
  expect(remaining).toHaveLength(2);
  // The two newest must be retained.
  expect(remaining.map((r) => r.path).sort()).toEqual([created[3].path, created[4].path].sort());
});

it("pruneSnapshots keeps everything when keepLast >= total", async () => {
  await takeSnapshot({ dbPath, snapshotsDir });
  await takeSnapshot({ dbPath, snapshotsDir });
  const pruned = await pruneSnapshots({ snapshotsDir, keepLast: 10 });
  expect(pruned.deleted).toBe(0);
});
```

- [ ] **Step 8: Add the scheduler test**

```typescript
it("startSnapshotScheduler fires snapshots on interval and stop() cancels", async () => {
  let fireCount = 0;
  const handle = startSnapshotScheduler({
    dbPath,
    snapshotsDir,
    intervalMs: 10,
    keepLast: 100,
    onSnapshot: () => {
      fireCount++;
    },
  });

  // Wait two intervals + slack.
  await new Promise((r) => setTimeout(r, 30));
  handle.stop();
  const after = fireCount;

  // Wait further; count must not increase after stop.
  await new Promise((r) => setTimeout(r, 30));
  expect(fireCount).toBe(after);
  expect(fireCount).toBeGreaterThanOrEqual(2);
});
```

If `startSnapshotScheduler` has a different surface (no `onSnapshot` callback, returns a different handle), read the source and adjust. The essential assertion is _intervals fired & stop() cancels_.

- [ ] **Step 9: Add the `formatSnapshotList` test**

```typescript
it("formatSnapshotList renders empty + non-empty cases", () => {
  expect(formatSnapshotList([])).toMatch(/no snapshots/i);

  const sample = [
    { path: "/x/snapshot-1000.db.gz", filename: "snapshot-1000.db.gz", timestampMs: 1000, compressedSizeBytes: 42 },
    { path: "/x/snapshot-2000.db.gz", filename: "snapshot-2000.db.gz", timestampMs: 2000, compressedSizeBytes: 999 },
  ];
  const out = formatSnapshotList(sample);
  expect(out).toContain("snapshot-1000.db.gz");
  expect(out).toContain("snapshot-2000.db.gz");
});

it("DEFAULT_SNAPSHOT_CONFIG has sensible defaults", () => {
  expect(DEFAULT_SNAPSHOT_CONFIG.enabled).toBeDefined();
  expect(DEFAULT_SNAPSHOT_CONFIG.keepLast).toBeGreaterThan(0);
  expect(DEFAULT_SNAPSHOT_CONFIG.intervalMs).toBeGreaterThan(0);
});
```

- [ ] **Step 10: Run the full file + check coverage**

Run: `bun test packages/gateway/test/unit/db/snapshot.test.ts --coverage`
Expected: all tests PASS; coverage of `db/snapshot.ts` ≥80%. If below, the printed `# Uncovered Lines` shows which branch — usually the `error` outcome path. Add one targeted test (e.g. point `takeSnapshot` at an unwritable dir to trigger the error path) to lift past 80%.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/test/unit/db/snapshot.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): add unit tests for db/snapshot

Covers takeSnapshot / listSnapshots / previewRestore / restoreSnapshot /
pruneSnapshots / startSnapshotScheduler / formatSnapshotList using a real
temp dir (VACUUM INTO writes files). Asserts on filesystem state, gzip
magic bytes, retention math, and scheduler lifecycle.

Raises db/snapshot.ts past the 80% per-file floor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: auth/pkce.ts — pure helpers + refresh functions

**Goal:** Cover `pkceCodeChallengeS256`, `refreshAccessToken`, `refreshSlackUserToken`, `refreshNotionToken`. The `runPKCEFlow` end-to-end test is Task 5.

**Files:**

- Create: `packages/gateway/test/unit/auth/pkce.test.ts`
- Read for context: `packages/gateway/src/auth/pkce.ts`

- [ ] **Step 1: Read the source**

Read `packages/gateway/src/auth/pkce.ts` and confirm:

- `pkceCodeChallengeS256(verifier: string): Promise<string>` signature
- `refreshAccessToken(ctx: RefreshAccessTokenContext): Promise<...>` signature — what's in `ctx`?
- `refreshSlackUserToken` and `refreshNotionToken` signatures
- The `PKCEFetch` type — confirm it's a `(input, init) => Promise<Response>` shape so we can inject

- [ ] **Step 2: Create the test file with the pure helper test**

Write `packages/gateway/test/unit/auth/pkce.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { createMockVault } from "../../../src/vault/mock";
import { pkceCodeChallengeS256, refreshAccessToken, refreshSlackUserToken, refreshNotionToken } from "../../../src/auth/pkce";

describe("pkceCodeChallengeS256", () => {
  it("matches the RFC 7636 Appendix B test vector", async () => {
    // RFC 7636 §Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // produces challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceCodeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces base64url output (no '+', '/', or '=')", async () => {
    const challenge = await pkceCodeChallengeS256("a".repeat(43));
    expect(challenge).not.toMatch(/[+/=]/);
  });
});
```

- [ ] **Step 3: Run it**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts -t "pkceCodeChallengeS256"`
Expected: PASS.

- [ ] **Step 4: Add `refreshAccessToken` happy-path test**

Append to the test file:

```typescript
describe("refreshAccessToken", () => {
  it("Google: posts to token endpoint, persists new token to vault", async () => {
    const vault = createMockVault();
    await vault.set("google.oauth.refresh_token", "stored-refresh");

    let capturedReq: Request | undefined;
    const fakeFetch = async (input: any, init?: any) => {
      capturedReq = new Request(input, init);
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await refreshAccessToken({
      provider: "google",
      clientId: "client-x",
      vault,
      fetch: fakeFetch as any,
    });

    expect(result.accessToken).toBe("new-access");
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // Token URL must be the Google token endpoint.
    expect(capturedReq!.url).toContain("oauth2.googleapis.com/token");
    // The refresh token came from the vault, not from the caller.
    const body = await capturedReq!.text();
    expect(body).toContain("refresh_token=stored-refresh");
    expect(body).toContain("client_id=client-x");
    expect(body).toContain("grant_type=refresh_token");
  });
});
```

**Adjust the exact `RefreshAccessTokenContext` field names** (`provider`, `clientId`, `vault`, `fetch`) to match the real type signature when you read the source.

- [ ] **Step 5: Run the refresh test**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts -t "refreshAccessToken"`
Expected: PASS.

- [ ] **Step 6: Add Microsoft + error-path tests for `refreshAccessToken`**

Append:

```typescript
it("Microsoft: posts to v2.0 token endpoint with tenant 'common'", async () => {
  const vault = createMockVault();
  await vault.set("microsoft.oauth.refresh_token", "ms-refresh");

  let capturedUrl = "";
  const fakeFetch = async (input: any, init?: any) => {
    capturedUrl = new Request(input, init).url;
    return new Response(JSON.stringify({ access_token: "ms-new", expires_in: 1800 }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await refreshAccessToken({ provider: "microsoft", clientId: "c", vault, fetch: fakeFetch as any });

  expect(capturedUrl).toMatch(/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token/);
});

it("throws on non-200 response", async () => {
  const vault = createMockVault();
  await vault.set("google.oauth.refresh_token", "x");

  const fakeFetch = async () => new Response("invalid_grant", { status: 400 });

  await expect(refreshAccessToken({ provider: "google", clientId: "c", vault, fetch: fakeFetch as any })).rejects.toThrow();
});

it("throws when refresh token is missing from vault", async () => {
  const vault = createMockVault();
  // No token seeded.
  const fakeFetch = async () => new Response("{}", { status: 200 });

  await expect(refreshAccessToken({ provider: "google", clientId: "c", vault, fetch: fakeFetch as any })).rejects.toThrow();
});
```

- [ ] **Step 7: Run the new tests**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts -t "refreshAccessToken"`
Expected: all PASS.

- [ ] **Step 8: Add `refreshSlackUserToken` test**

```typescript
describe("refreshSlackUserToken", () => {
  it("posts to slack.com/api/oauth.v2.access and persists authed_user.access_token", async () => {
    const vault = createMockVault();
    await vault.set("slack.oauth.refresh_token", "slack-refresh");

    let capturedUrl = "";
    const fakeFetch = async (input: any, init?: any) => {
      capturedUrl = new Request(input, init).url;
      return new Response(
        JSON.stringify({
          ok: true,
          authed_user: { access_token: "slack-new", expires_in: 7200 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const r = await refreshSlackUserToken({
      clientId: "slack-cid",
      vault,
      fetch: fakeFetch as any,
    });

    expect(r.accessToken).toBe("slack-new");
    expect(capturedUrl).toContain("slack.com/api/oauth.v2.access");
  });

  it("throws when response body has ok: false", async () => {
    const vault = createMockVault();
    await vault.set("slack.oauth.refresh_token", "x");
    const fakeFetch = async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200, headers: { "Content-Type": "application/json" } });

    await expect(refreshSlackUserToken({ clientId: "c", vault, fetch: fakeFetch as any })).rejects.toThrow();
  });
});
```

- [ ] **Step 9: Add `refreshNotionToken` test**

```typescript
describe("refreshNotionToken", () => {
  it("posts to api.notion.com/v1/oauth/token with Basic auth header", async () => {
    const vault = createMockVault();
    await vault.set("notion.oauth.refresh_token", "notion-refresh");

    let capturedReq: Request | undefined;
    const fakeFetch = async (input: any, init?: any) => {
      capturedReq = new Request(input, init);
      return new Response(JSON.stringify({ access_token: "notion-new" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await refreshNotionToken({
      clientId: "notion-cid",
      clientSecret: "notion-secret",
      vault,
      fetch: fakeFetch as any,
    });

    expect(capturedReq!.url).toContain("api.notion.com/v1/oauth/token");
    const auth = capturedReq!.headers.get("Authorization");
    expect(auth).toMatch(/^Basic /);
    // Decoded form is "clientId:clientSecret"
    const decoded = Buffer.from(auth!.slice(6), "base64").toString();
    expect(decoded).toBe("notion-cid:notion-secret");
  });
});
```

- [ ] **Step 10: Run the full test file + coverage check**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts --coverage`
Expected: all PASS. Note the current coverage for `auth/pkce.ts` — should rise from 65% toward 80%, but might still be below 80% until Task 5 adds the `runPKCEFlow` test.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/test/unit/auth/pkce.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): cover pkce pure helpers + token refresh paths

Adds unit tests for pkceCodeChallengeS256 (RFC 7636 vector), and
refreshAccessToken / refreshSlackUserToken / refreshNotionToken with
injected PKCEFetch doubles. Asserts on:
- token endpoint URLs (provider routing)
- vault read of stored refresh_token
- Basic auth header for Notion
- error path on non-200 / ok:false

runPKCEFlow end-to-end test follows in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: auth/pkce.ts — `runPKCEFlow` end-to-end

**Goal:** Cover `runPKCEFlow` using a real `Bun.serve()` instance (the function spawns its own callback server; the test drives the redirect by hitting that server with a constructed code+state).

**Files:**

- Modify: `packages/gateway/test/unit/auth/pkce.test.ts`

- [ ] **Step 1: Re-read `runPKCEFlow` carefully**

Read `runPKCEFlow` in `packages/gateway/src/auth/pkce.ts`. Identify:

- The exact `PKCEOptions` field names (`clientId`, `scopes`, `provider`, `vault`, `openUrl`, `fetch`, etc.)
- The redirect port — is it caller-specified, randomly allocated, or fixed?
- The expected query params on the callback URL (`code`, `state`)
- The HTML response sent to the browser after callback
- What the function returns on success

- [ ] **Step 2: Add a `runPKCEFlow` happy-path test**

Append to `packages/gateway/test/unit/auth/pkce.test.ts`:

```typescript
describe("runPKCEFlow", () => {
  it("completes the OAuth flow: opens URL, receives callback, exchanges code, persists tokens", async () => {
    const vault = createMockVault();

    let authUrl = "";
    const openUrl = async (url: string) => {
      authUrl = url;
    };

    let tokenRequest: Request | undefined;
    const fakeFetch = async (input: any, init?: any) => {
      tokenRequest = new Request(input, init);
      return new Response(
        JSON.stringify({
          access_token: "flow-access",
          refresh_token: "flow-refresh",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Kick off the flow — runPKCEFlow returns a promise that resolves when
    // the callback handler completes.
    const flowPromise = runPKCEFlow({
      provider: "google",
      clientId: "test-client",
      clientSecret: "test-secret",
      scopes: ["openid", "email"],
      vault,
      openUrl,
      fetch: fakeFetch as any,
      // If runPKCEFlow accepts a redirectPort, pass 0 for OS-assigned and read back.
    });

    // Wait until openUrl was called (i.e. server is up + auth URL is built).
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (authUrl) return resolve();
        if (Date.now() - start > 3000) return reject(new Error("openUrl was never called"));
        setTimeout(tick, 5);
      };
      tick();
    });

    // Parse the auth URL to extract redirect_uri and state.
    const auth = new URL(authUrl);
    const redirectUri = auth.searchParams.get("redirect_uri");
    const state = auth.searchParams.get("state");
    expect(redirectUri).toBeTruthy();
    expect(state).toBeTruthy();

    // Hit the callback with a code + the same state. Real local HTTP.
    const callback = new URL(redirectUri!);
    callback.searchParams.set("code", "auth-code-xyz");
    callback.searchParams.set("state", state!);
    const callbackResp = await fetch(callback.toString());
    expect(callbackResp.status).toBe(200); // success HTML page

    // Now flowPromise resolves.
    const result = await flowPromise;

    expect(result.accessToken).toBe("flow-access");
    expect(result.refreshToken).toBe("flow-refresh");

    // Token exchange request: assert it carried the right grant_type + code_verifier.
    expect(tokenRequest).toBeDefined();
    const body = await tokenRequest!.text();
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
    expect(body).toContain("code_verifier=");
    expect(body).toContain("client_id=test-client");

    // Vault must contain the new tokens.
    expect(await vault.get("google.oauth.access_token")).toBe("flow-access");
    expect(await vault.get("google.oauth.refresh_token")).toBe("flow-refresh");
  });
});
```

- [ ] **Step 3: Run it**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts -t "runPKCEFlow"`
Expected: PASS. If FAIL because of port conflicts, check whether `runPKCEFlow` exposes a way to bind to port 0 (OS-assigned). If not and the function uses a fixed port, run tests serially or pick a unique port per test.

If the test deadlocks (callback never resolves the flow), inspect whether `runPKCEFlow` waits on a different signal (e.g. an internal Promise that resolves on receiving the callback) — debug by adding console.error around the polling loop and the callback hit.

- [ ] **Step 4: Add `runPKCEFlow` error-path tests**

Append:

```typescript
it("rejects when the callback arrives with a different state (CSRF defense)", async () => {
  const vault = createMockVault();
  let authUrl = "";
  const openUrl = async (url: string) => {
    authUrl = url;
  };
  const fakeFetch = async () => new Response("{}", { status: 200 });

  const flowPromise = runPKCEFlow({
    provider: "google",
    clientId: "test-client",
    clientSecret: "test-secret",
    scopes: ["openid"],
    vault,
    openUrl,
    fetch: fakeFetch as any,
  });

  await new Promise<void>((r) => {
    const tick = () => (authUrl ? r() : setTimeout(tick, 5));
    tick();
  });

  const auth = new URL(authUrl);
  const redirectUri = auth.searchParams.get("redirect_uri")!;
  const cb = new URL(redirectUri);
  cb.searchParams.set("code", "x");
  cb.searchParams.set("state", "WRONG-STATE");
  await fetch(cb.toString());

  await expect(flowPromise).rejects.toThrow(/state/i);
});

it("rejects when the callback arrives with ?error= (user denied)", async () => {
  const vault = createMockVault();
  let authUrl = "";
  const openUrl = async (url: string) => {
    authUrl = url;
  };
  const fakeFetch = async () => new Response("{}", { status: 200 });

  const flowPromise = runPKCEFlow({
    provider: "google",
    clientId: "c",
    clientSecret: "s",
    scopes: ["openid"],
    vault,
    openUrl,
    fetch: fakeFetch as any,
  });

  await new Promise<void>((r) => {
    const tick = () => (authUrl ? r() : setTimeout(tick, 5));
    tick();
  });

  const cb = new URL(new URL(authUrl).searchParams.get("redirect_uri")!);
  cb.searchParams.set("error", "access_denied");
  cb.searchParams.set("state", new URL(authUrl).searchParams.get("state")!);
  await fetch(cb.toString());

  await expect(flowPromise).rejects.toThrow(/access_denied|denied/i);
});
```

- [ ] **Step 5: Run all pkce tests + coverage**

Run: `bun test packages/gateway/test/unit/auth/pkce.test.ts --coverage`
Expected: all PASS. `auth/pkce.ts` should now be ≥80%. If not, inspect the uncovered branches and add targeted tests (often Slack-specific or Notion-specific branches inside `runPKCEFlow` if it switches on provider).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/test/unit/auth/pkce.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): end-to-end runPKCEFlow test with real Bun.serve

Spins up the real OAuth callback server, drives the redirect via local
HTTP, and asserts on:
- auth URL params (redirect_uri, state)
- code_verifier + grant_type=authorization_code in token exchange body
- vault persistence of access_token + refresh_token
- CSRF defense (state mismatch rejects)
- user-denied path (?error=access_denied rejects)

Brings auth/pkce.ts above the 80% per-file floor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: connectors/lazy-mesh/credential-orchestration.ts — full coverage

**Goal:** Cover `ensureCredentialConnectorsRunning` + the 11 `ensureXxx*` helpers. Mock the `connector-spawns.ts` module so spawn calls are observable.

**Files:**

- Create: `packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts`
- Read for context: `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts`, `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts`, `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts` (for the `mock.module()` pattern)

- [ ] **Step 1: Read the source files**

Confirm:

- `ensureCredentialConnectorsRunning(ctx: MeshSpawnContext)` — what's in `ctx`?
- Each `ensureXxx*` function's signature and which vault keys it reads (use the `nimbus-connector-authoring` + `nimbus-file-map` skill content already in your context for the per-connector key list)
- The 11 spawn helpers exported by `connector-spawns.ts` (`ensureGithubMcp`, `ensureSlackMcp`, etc.)

- [ ] **Step 2: Create the test scaffolding with module mocks**

Write `packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockVault } from "../../../../src/vault/mock";

// Track every spawn call. mock.module replaces the spawn helpers
// with no-op stubs that record their invocations.
const spawnCalls: Array<{ name: string; ctx: unknown }> = [];

mock.module("../../../../src/connectors/lazy-mesh/connector-spawns", () => {
  const make = (name: string) => async (ctx: unknown) => {
    spawnCalls.push({ name, ctx });
  };
  return {
    ensureGithubMcp: make("github"),
    ensureSlackMcp: make("slack"),
    ensureNotionMcp: make("notion"),
    ensureLinearMcp: make("linear"),
    ensureGoogleDriveMcp: make("google-drive"),
    ensureGmailMcp: make("gmail"),
    ensureOnedriveMcp: make("onedrive"),
    ensureBitbucketMcp: make("bitbucket"),
    ensureJiraMcp: make("jira"),
    ensureConfluenceMcp: make("confluence"),
    ensureDiscordMcp: make("discord"),
    ensureJenkinsMcp: make("jenkins"),
    ensureCircleciMcp: make("circleci"),
    ensurePagerdutyMcp: make("pagerduty"),
    ensureKubernetesMcp: make("kubernetes"),
    // Add any other spawn helper that credential-orchestration.ts imports.
  };
});

import { ensureCredentialConnectorsRunning } from "../../../../src/connectors/lazy-mesh/credential-orchestration";

describe("credential-orchestration", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  afterEach(() => {
    spawnCalls.length = 0;
  });
});
```

**Adjust the `mock.module` path** to be relative to the test file, and add/remove entries to match what `credential-orchestration.ts` actually imports.

- [ ] **Step 3: Add the "no creds → no spawns" test**

```typescript
it("spawns nothing when vault is empty", async () => {
  const vault = createMockVault();
  await ensureCredentialConnectorsRunning({ vault } as any);
  expect(spawnCalls).toEqual([]);
});
```

- [ ] **Step 4: Add per-connector "single key present → single spawn" tests**

```typescript
describe("single-secret connectors", () => {
  it("github PAT → spawns github only", async () => {
    const vault = createMockVault();
    await vault.set("github.pat", "ghp_test");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["github"]);
  });

  it("linear API key → spawns linear only", async () => {
    const vault = createMockVault();
    await vault.set("linear.api_key", "lin_test");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["linear"]);
  });

  it("circleci token → spawns circleci only", async () => {
    const vault = createMockVault();
    await vault.set("circleci.token", "c_test");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["circleci"]);
  });

  it("pagerduty token → spawns pagerduty only", async () => {
    const vault = createMockVault();
    await vault.set("pagerduty.token", "pd_test");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["pagerduty"]);
  });

  it("whitespace-only secret does not spawn (trim defense)", async () => {
    const vault = createMockVault();
    await vault.set("circleci.token", "   ");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls).toEqual([]);
  });
});
```

**Confirm the exact vault key names** by reading `connector-secrets-manifest.ts` or by grepping for the key strings in `credential-orchestration.ts`.

- [ ] **Step 5: Add multi-secret AND-logic tests**

```typescript
describe("multi-secret connectors require ALL keys", () => {
  it("bitbucket: username alone does not spawn", async () => {
    const vault = createMockVault();
    await vault.set("bitbucket.username", "user");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls).toEqual([]);
  });

  it("bitbucket: username + app_password spawns", async () => {
    const vault = createMockVault();
    await vault.set("bitbucket.username", "user");
    await vault.set("bitbucket.app_password", "pw");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["bitbucket"]);
  });

  it("jira: needs token + email + base_url; partial does not spawn", async () => {
    const vault = createMockVault();
    await vault.set("jira.token", "t");
    await vault.set("jira.email", "e@x");
    // missing jira.base_url
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls).toEqual([]);

    await vault.set("jira.base_url", "https://x.atlassian.net");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toEqual(["jira"]);
  });

  it("confluence: same triple as jira", async () => {
    const vault = createMockVault();
    await vault.set("confluence.token", "t");
    await vault.set("confluence.email", "e@x");
    await vault.set("confluence.base_url", "https://x.atlassian.net/wiki");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toContain("confluence");
  });

  it("jenkins: needs base_url + username + token", async () => {
    const vault = createMockVault();
    await vault.set("jenkins.base_url", "https://jenkins.x");
    await vault.set("jenkins.username", "u");
    // missing jenkins.token
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls).toEqual([]);

    await vault.set("jenkins.token", "t");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toContain("jenkins");
  });
});
```

- [ ] **Step 6: Add discord opt-in test**

```typescript
describe("discord opt-in", () => {
  it("requires both enabled=1 AND token", async () => {
    const vault = createMockVault();
    await vault.set("discord.token", "d_t");
    // enabled flag missing
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).not.toContain("discord");

    await vault.set("discord.enabled", "1");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).toContain("discord");
  });

  it("enabled=0 is treated as opt-out even with token present", async () => {
    const vault = createMockVault();
    await vault.set("discord.token", "d_t");
    await vault.set("discord.enabled", "0");
    await ensureCredentialConnectorsRunning({ vault } as any);
    expect(spawnCalls.map((c) => c.name)).not.toContain("discord");
  });
});
```

- [ ] **Step 7: Add Google OAuth multi-variant test**

```typescript
describe("Google OAuth — any variant spawns google-drive + gmail", () => {
  it("shared OAuth key spawns both", async () => {
    const vault = createMockVault();
    // Use the shared-key form. Confirm the exact key name from
    // sharedOAuthKey() in connector-vault.ts.
    await vault.set("google.oauth.access_token", "ya29.x");
    await ensureCredentialConnectorsRunning({ vault } as any);
    const names = spawnCalls.map((c) => c.name);
    expect(names).toContain("google-drive");
    expect(names).toContain("gmail");
  });
});
```

- [ ] **Step 8: Add the multi-connector "everything wired" test**

```typescript
it("multiple connectors with creds present all spawn", async () => {
  const vault = createMockVault();
  await vault.set("github.pat", "g");
  await vault.set("linear.api_key", "l");
  await vault.set("pagerduty.token", "p");

  await ensureCredentialConnectorsRunning({ vault } as any);

  const names = spawnCalls.map((c) => c.name).sort();
  expect(names).toEqual(["github", "linear", "pagerduty"]);
});
```

- [ ] **Step 9: Run + coverage check**

Run: `bun test packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts --coverage`
Expected: all PASS; `credential-orchestration.ts` coverage rises from 4.44% to ≥80%. If a `ensureXxx*` helper is uncovered, add a focused test for its single-key path.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): unit tests for credential-orchestration

Covers ensureCredentialConnectorsRunning + every ensureXxx* helper using
mock.module() on connector-spawns. Asserts on:
- empty vault → no spawns
- single-secret connectors spawn exactly themselves
- whitespace-only secrets do not spawn (trim defense)
- multi-secret AND-logic (bitbucket, jira, confluence, jenkins)
- discord opt-in requires enabled=1 AND token
- Google OAuth fan-out to drive + gmail
- multi-connector composite case

Brings connectors/lazy-mesh/credential-orchestration.ts past 80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ipc/connector-rpc-handlers/auth.ts — Part 1 (single-secret + observability)

**Goal:** Cover the PAT-based connectors (github, gitlab, linear, circleci, jenkins, bitbucket) + the observability set (grafana, sentry, newrelic, datadog, pagerduty). Part 2 in Task 8 covers multi-secret cloud + OAuth dispatch.

**Files:**

- Create: `packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts`
- Read for context: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`, `packages/gateway/test/integration/connector-remove-oauth-restore.integration.test.ts` (for the `ServerCtx`-shape stub pattern)

- [ ] **Step 1: Read the source**

Read `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`. Confirm:

- `handleConnectorAuth(params, ctx)` signature — what's in `ctx`? (vault, localIndex, config, openUrl, ...)
- The `params` shape for each connector (typically `{ connector: "github", credentials: { pat: "..." } }` or similar)
- The error-return shape (does it throw, or return `{ error: { code, message } }`?)
- Which exact vault keys each helper writes

- [ ] **Step 2: Create the scaffolding**

Write `packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalIndex } from "../../../../src/index/local-index";
import { createMockVault } from "../../../../src/vault/mock";
import { handleConnectorAuth } from "../../../../src/ipc/connector-rpc-handlers/auth";
import type { NimbusVault } from "../../../../src/vault";

function makeCtx(overrides: Partial<{ vault: NimbusVault; db: Database }> = {}) {
  const db = overrides.db ?? new Database(":memory:");
  if (!overrides.db) LocalIndex.ensureSchema(db);
  const vault = overrides.vault ?? createMockVault();
  const localIndex = new LocalIndex(db);
  return {
    db,
    vault,
    localIndex,
    openUrl: async (_url: string) => {
      /* no-op for non-OAuth tests */
    },
    config: {
      /* fill with minimal required fields */
    },
  };
}

describe("handleConnectorAuth", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });
});
```

**Adjust `makeCtx` to whatever real shape `ServerCtx` has** — read the type definition and fill in any required fields (the `config` shape is usually a `nimbus.toml` parse result; you may need to provide a `defaultConfig()` helper from `packages/gateway/src/config/nimbus-toml.ts`).

- [ ] **Step 3: Add GitHub PAT happy + error tests**

```typescript
describe("github PAT", () => {
  it("persists the PAT to vault and registers a scheduler entry", async () => {
    const result = await handleConnectorAuth({ connector: "github", credentials: { pat: "ghp_abc123" } } as any, ctx as any);

    expect(result.ok).toBe(true);
    expect(await ctx.vault.get("github.pat")).toBe("ghp_abc123");

    // Scheduler row was written.
    const row = ctx.db.query("SELECT * FROM scheduler_state WHERE service = 'github' LIMIT 1").get();
    expect(row).toBeTruthy();
  });

  it("returns an error when PAT is missing", async () => {
    const result = await handleConnectorAuth({ connector: "github", credentials: {} } as any, ctx as any);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBeDefined();

    // No vault write.
    expect(await ctx.vault.get("github.pat")).toBeNull();
  });

  it("never returns the PAT value in the response (credential redaction)", async () => {
    const result = await handleConnectorAuth({ connector: "github", credentials: { pat: "ghp_SECRET_ABC" } } as any, ctx as any);
    const json = JSON.stringify(result);
    expect(json).not.toContain("ghp_SECRET_ABC");
  });
});
```

**Adjust the schema names** (`scheduler_state` may be `sync_state` or `connectors` — read the source/migrations).

- [ ] **Step 4: Add gitlab + linear + circleci + jenkins + bitbucket tests**

Follow the same pattern. For each:

- happy: provide minimum required creds, assert vault key written, assert no token in response.
- error: omit a required field, assert `ok: false`.

```typescript
describe("gitlab PAT", () => {
  it("persists PAT and optional apiBaseUrl", async () => {
    const r = await handleConnectorAuth({ connector: "gitlab", credentials: { pat: "glpat-xxx", apiBaseUrl: "https://gitlab.x" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("gitlab.pat")).toBe("glpat-xxx");
    expect(await ctx.vault.get("gitlab.base_url")).toBe("https://gitlab.x");
  });

  it("works with just a PAT (apiBaseUrl optional)", async () => {
    const r = await handleConnectorAuth({ connector: "gitlab", credentials: { pat: "glpat-y" } } as any, ctx as any);
    expect(r.ok).toBe(true);
  });
});

describe("linear API key", () => {
  it("persists the API key", async () => {
    const r = await handleConnectorAuth({ connector: "linear", credentials: { apiKey: "lin_api_x" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("linear.api_key")).toBe("lin_api_x");
  });

  it("rejects empty apiKey", async () => {
    const r = await handleConnectorAuth({ connector: "linear", credentials: { apiKey: "" } } as any, ctx as any);
    expect(r.ok).toBe(false);
  });
});

describe("circleci token", () => {
  it("persists the token", async () => {
    const r = await handleConnectorAuth({ connector: "circleci", credentials: { token: "c_xxx" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("circleci.token")).toBe("c_xxx");
  });
});

describe("jenkins (base_url + username + token)", () => {
  it("persists all three", async () => {
    const r = await handleConnectorAuth({ connector: "jenkins", credentials: { baseUrl: "https://j.x", username: "u", token: "t" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("jenkins.base_url")).toBe("https://j.x");
    expect(await ctx.vault.get("jenkins.username")).toBe("u");
    expect(await ctx.vault.get("jenkins.token")).toBe("t");
  });

  it("rejects when any field is missing", async () => {
    const r = await handleConnectorAuth({ connector: "jenkins", credentials: { baseUrl: "https://j.x", username: "u" } } as any, ctx as any);
    expect(r.ok).toBe(false);
  });
});

describe("bitbucket (username + app_password)", () => {
  it("persists both", async () => {
    const r = await handleConnectorAuth({ connector: "bitbucket", credentials: { username: "u", appPassword: "pw" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("bitbucket.username")).toBe("u");
    expect(await ctx.vault.get("bitbucket.app_password")).toBe("pw");
  });
});
```

- [ ] **Step 5: Add observability connector tests**

```typescript
describe("grafana (base_url + token)", () => {
  it("persists both", async () => {
    const r = await handleConnectorAuth({ connector: "grafana", credentials: { baseUrl: "https://g.x", token: "t" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("grafana.base_url")).toBe("https://g.x");
    expect(await ctx.vault.get("grafana.token")).toBe("t");
  });
});

describe("sentry (token + org_slug + optional url)", () => {
  it("persists with default base URL", async () => {
    const r = await handleConnectorAuth({ connector: "sentry", credentials: { token: "t", orgSlug: "my-org" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("sentry.token")).toBe("t");
    expect(await ctx.vault.get("sentry.org_slug")).toBe("my-org");
  });

  it("persists custom base URL when provided", async () => {
    const r = await handleConnectorAuth({ connector: "sentry", credentials: { token: "t", orgSlug: "my-org", baseUrl: "https://s.acme.com" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("sentry.base_url")).toBe("https://s.acme.com");
  });
});

describe("newrelic (token + optional account_id)", () => {
  it("persists token", async () => {
    const r = await handleConnectorAuth({ connector: "newrelic", credentials: { token: "t" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("newrelic.token")).toBe("t");
  });
});

describe("datadog (api_key + app_key + optional site)", () => {
  it("persists both keys", async () => {
    const r = await handleConnectorAuth({ connector: "datadog", credentials: { apiKey: "ak", appKey: "appk" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("datadog.api_key")).toBe("ak");
    expect(await ctx.vault.get("datadog.app_key")).toBe("appk");
  });
});

describe("pagerduty (token)", () => {
  it("persists token", async () => {
    const r = await handleConnectorAuth({ connector: "pagerduty", credentials: { token: "t" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("pagerduty.token")).toBe("t");
  });
});
```

- [ ] **Step 6: Run + verify**

Run: `bun test packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts --coverage`
Expected: all PASS. Note the coverage — still under 80% because Task 8 adds cloud + OAuth paths.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): connector-rpc auth — single-secret + observability

Covers PAT-based connectors (github, gitlab, linear, circleci, jenkins,
bitbucket) and observability set (grafana, sentry, newrelic, datadog,
pagerduty). For each:
- happy path: minimum creds → vault writes the right keys, scheduler row
  appears
- error path: missing required field → ok:false, no vault write
- redaction: full RPC response JSON does not echo the credential value

Multi-secret cloud + OAuth dispatch follow in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: ipc/connector-rpc-handlers/auth.ts — Part 2 (cloud + OAuth dispatch)

**Goal:** Cover the multi-secret cloud connectors (aws, azure, gcp, kubernetes) + the OAuth dispatch helpers (`oauthClientConfigForProvider`, `oauthScopesFromConnectorRequest`, `oauthRedirectPortFromRec`, `connectorAuthOAuthPkce`) + the IAC opt-in + Discord opt-in.

**Files:**

- Modify: `packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts`

- [ ] **Step 1: Add AWS tests (access-key pair OR profile)**

Append:

```typescript
describe("aws (access key pair OR profile)", () => {
  it("persists access key + secret when both provided", async () => {
    const r = await handleConnectorAuth({ connector: "aws", credentials: { accessKeyId: "AKIA...", secretAccessKey: "secret" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("aws.access_key_id")).toBe("AKIA...");
    expect(await ctx.vault.get("aws.secret_access_key")).toBe("secret");
  });

  it("persists profile-only auth (no static keys)", async () => {
    const r = await handleConnectorAuth({ connector: "aws", credentials: { profile: "default" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("aws.profile")).toBe("default");
    // No static key written.
    expect(await ctx.vault.get("aws.access_key_id")).toBeNull();
  });

  it("rejects when neither access key pair nor profile present", async () => {
    const r = await handleConnectorAuth({ connector: "aws", credentials: {} } as any, ctx as any);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Add Azure + GCP + Kubernetes tests**

```typescript
describe("azure (tenant + client + secret)", () => {
  it("persists all three", async () => {
    const r = await handleConnectorAuth({ connector: "azure", credentials: { tenantId: "t", clientId: "c", clientSecret: "s" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("azure.tenant_id")).toBe("t");
    expect(await ctx.vault.get("azure.client_id")).toBe("c");
    expect(await ctx.vault.get("azure.client_secret")).toBe("s");
  });

  it("rejects partial trio", async () => {
    const r = await handleConnectorAuth({ connector: "azure", credentials: { tenantId: "t", clientId: "c" } } as any, ctx as any);
    expect(r.ok).toBe(false);
  });
});

describe("gcp (credentials path + optional project)", () => {
  it("persists path + project", async () => {
    const r = await handleConnectorAuth({ connector: "gcp", credentials: { credentialsJsonPath: "/etc/gcp.json", projectId: "p1" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("gcp.credentials_json_path")).toBe("/etc/gcp.json");
    expect(await ctx.vault.get("gcp.project_id")).toBe("p1");
  });
});

describe("kubernetes (kubeconfig + optional context)", () => {
  it("persists kubeconfig path", async () => {
    const r = await handleConnectorAuth({ connector: "kubernetes", credentials: { kubeconfigPath: "/home/u/.kube/config" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("kubernetes.kubeconfig")).toBe("/home/u/.kube/config");
  });

  it("persists explicit context", async () => {
    const r = await handleConnectorAuth({ connector: "kubernetes", credentials: { kubeconfigPath: "/c", context: "prod-eu" } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("kubernetes.context")).toBe("prod-eu");
  });
});
```

- [ ] **Step 3: Add discord + IAC opt-in tests**

```typescript
describe("discord opt-in", () => {
  it("requires explicit opt-in + token", async () => {
    const r = await handleConnectorAuth({ connector: "discord", credentials: { token: "d_t", enabled: true } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("discord.token")).toBe("d_t");
    expect(await ctx.vault.get("discord.enabled")).toBe("1");
  });

  it("rejects without opt-in flag", async () => {
    const r = await handleConnectorAuth({ connector: "discord", credentials: { token: "d_t" } } as any, ctx as any);
    expect(r.ok).toBe(false);
  });
});

describe("iac opt-in", () => {
  it("persists enabled=1", async () => {
    const r = await handleConnectorAuth({ connector: "iac", credentials: { enabled: true } } as any, ctx as any);
    expect(r.ok).toBe(true);
    expect(await ctx.vault.get("iac.enabled")).toBe("1");
  });
});
```

- [ ] **Step 4: Add OAuth-dispatch tests**

```typescript
describe("OAuth/PKCE dispatch", () => {
  it("rejects unknown OAuth provider", async () => {
    const r = await handleConnectorAuth({ connector: "oauth", credentials: { provider: "lemons" } } as any, ctx as any);
    expect(r.ok).toBe(false);
  });

  it("rejects google when config.oauth.google_client_id is missing", async () => {
    // Default ctx has empty config — runPKCEFlow needs a client id from config or env.
    const r = await handleConnectorAuth({ connector: "oauth", credentials: { provider: "google" } } as any, ctx as any);
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? "").toMatch(/client_id|config/i);
  });

  it("validates scopes — empty list rejected", async () => {
    // Use the exported helper directly if it's exported; otherwise reach via handler.
    // Confirm import path.
    const { oauthScopesFromConnectorRequest } = await import("../../../../src/ipc/connector-rpc-handlers/auth");
    expect(() => oauthScopesFromConnectorRequest({ scopes: [] } as any)).toThrow();
  });

  it("validates redirect port — out-of-range rejected", async () => {
    const { oauthRedirectPortFromRec } = await import("../../../../src/ipc/connector-rpc-handlers/auth");
    expect(() => oauthRedirectPortFromRec({ redirectPort: 99999 } as any)).toThrow();
    expect(() => oauthRedirectPortFromRec({ redirectPort: -1 } as any)).toThrow();
    expect(oauthRedirectPortFromRec({ redirectPort: 7474 } as any)).toBe(7474);
  });

  it("provider config maps known providers to their token endpoints", async () => {
    const { oauthClientConfigForProvider } = await import("../../../../src/ipc/connector-rpc-handlers/auth");
    const google = oauthClientConfigForProvider("google", {} as any);
    expect(google.helpMessage).toBeDefined();
    // Adjust the asserted shape to match the real return type.
  });
});
```

**Adjust the helper import paths** if `oauthClientConfigForProvider` and friends are internal — if they're not exported, reach them via the public `handleConnectorAuth` with crafted params and assert on the dispatcher's error message.

- [ ] **Step 5: Add the "unknown connector" dispatch test**

```typescript
describe("dispatch", () => {
  it("returns an error for an unknown connector name", async () => {
    const r = await handleConnectorAuth({ connector: "lemons", credentials: {} } as any, ctx as any);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBeDefined();
  });
});
```

- [ ] **Step 6: Run + verify**

Run: `bun test packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts --coverage`
Expected: all PASS; coverage of `ipc/connector-rpc-handlers/auth.ts` ≥80%. If a specific helper is uncovered, add a targeted test for it.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts
git commit -m "$(cat <<'EOF'
test(coverage-floor): connector-rpc auth — cloud + OAuth dispatch

Covers AWS (access-key pair OR profile), Azure (tenant trio), GCP, Kubernetes,
Discord opt-in, IAC opt-in, and the OAuth/PKCE dispatch helpers
(oauthClientConfigForProvider, oauthScopesFromConnectorRequest,
oauthRedirectPortFromRec, dispatch error for unknown provider, dispatch
error for unknown connector).

Raises ipc/connector-rpc-handlers/auth.ts past 80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Verify all 5 files ≥80% locally, then update baseline

**Goal:** Build the merged lcov locally, verify each Phase 1B file is ≥80%, and remove the 5 entries from `docs/structure-audit/coverage-baseline.json` per spec §The Ratchet rule 4.

**Files:**

- Modify: `docs/structure-audit/coverage-baseline.json`

- [ ] **Step 1: Build the merged lcov**

Run: `bun run audit:coverage-floor:build-lcov`
Expected: produces `coverage/lcov.merged.info` (or whatever path the script writes — confirm by reading `scripts/coverage-floor/build-lcov.sh`).

This step takes a while (full per-package coverage build). If it fails for a reason unrelated to Phase 1B (e.g. a pre-existing platform issue), follow the canonical "push, download CI lcov artifact, reseed" workflow documented in `docs/contributors/coverage.md` — push the branch, wait for CI, then `gh run download` the `coverage-lcov-merged` artifact.

- [ ] **Step 2: Run the gate against the merged lcov**

Run: `bun run audit:coverage-floor`
Expected output: either

- **PASS**: all 5 Phase 1B files are now ≥80% AND the baseline still references them (the gate complains "file X is ≥80% but still in baseline — remove it"). This is the success signal.
- **FAIL**: one or more files still below 80%. Read the gate's per-file output, identify which file needs more tests, return to the corresponding Task (2–8) and add coverage for the named uncovered lines.

- [ ] **Step 3: Remove the 5 entries from the baseline**

Edit `docs/structure-audit/coverage-baseline.json` and delete these five entries:

```json
"packages/gateway/src/auth/pkce.ts": { "min_coverage_pct": 65.1 },
"packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts": { "min_coverage_pct": 4.44 },
"packages/gateway/src/db/repair.ts": { "min_coverage_pct": 34.76 },
"packages/gateway/src/db/snapshot.ts": { "min_coverage_pct": 10.05 },
"packages/gateway/src/ipc/connector-rpc-handlers/auth.ts": { "min_coverage_pct": 6.28 },
```

Also update the top-level `generated_at` timestamp to the current UTC time (ISO-8601, e.g. `2026-05-17T14:30:00.000Z`).

- [ ] **Step 4: Re-run the gate**

Run: `bun run audit:coverage-floor`
Expected: exit 0, no complaints. All 5 files are now subject to the full ≥80% floor without baseline entries.

- [ ] **Step 5: Re-run the exclusion-parity check**

Run: `bun run audit:exclusion-parity`
Expected: exit 0. The 5 removed files were never in `sonar.coverage.exclusions` (they're not exempt — they're past-the-floor), so no drift.

- [ ] **Step 6: Run the full bun test suite locally to confirm no other test regressed**

Run: `bun test`
Expected: all green. Address any unrelated failures before committing the baseline change.

- [ ] **Step 7: Commit the baseline update**

```bash
git add docs/structure-audit/coverage-baseline.json
git commit -m "$(cat <<'EOF'
chore(coverage-floor): remove Phase 1B files from baseline

All five Phase 1B critical-path files are now ≥80% line coverage in
Linux CI lcov; baseline entries removed per spec §The Ratchet rule 4:

- packages/gateway/src/auth/pkce.ts
- packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts
- packages/gateway/src/db/repair.ts
- packages/gateway/src/db/snapshot.ts
- packages/gateway/src/ipc/connector-rpc-handlers/auth.ts

Baseline shrinks by 5 entries (183 → 178).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Push + open PR

**Files:**

- None (pure git/GitHub ops)

- [ ] **Step 1: Push the branch**

Run: `git push -u origin dev/asafgolombek/coverage-floor-phase-1b-2026-05-17`
Expected: branch created on origin; PR creation URL printed.

- [ ] **Step 2: Wait for CI to finish on the branch**

Run: `gh run watch` (or `gh run list --branch dev/asafgolombek/coverage-floor-phase-1b-2026-05-17 --limit 1`)
Expected: the `coverage-floor` job is green; the `pr-quality` job is green.

If CI's lcov reports any Phase 1B file as below 80% (despite the local check passing), follow the docs/contributors/coverage.md workflow — download the CI lcov artifact and inspect which lines CI sees as uncovered. CI uses a deterministic environment (Linux, fixed Bun version); any divergence usually means a test relied on local OS state.

- [ ] **Step 3: Create the PR**

Run:

```bash
gh pr create --title "test(coverage-floor): Phase 1B — OAuth + credential orchestration + DB recovery" --body "$(cat <<'EOF'
## Summary

Phase 1B of the coverage-floor initiative (`docs/superpowers/specs/2026-05-17-coverage-floor-design.md` §Phase 1). Raises per-file line coverage to ≥80% for the 5 critical-path files and removes them from the baseline.

Files brought above the 80% per-file floor:

| File | Was | Now |
|---|---|---|
| `packages/gateway/src/auth/pkce.ts` | 65.10% | ≥80% |
| `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts` | 4.44% | ≥80% |
| `packages/gateway/src/db/repair.ts` | 34.76% | ≥80% |
| `packages/gateway/src/db/snapshot.ts` | 10.05% | ≥80% |
| `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` | 6.28% | ≥80% |

Baseline shrinks from 183 to 178 entries.

No production source changes (no bugs surfaced by the new tests). Test infrastructure is per-file — the shared connector-sync-harness and rpc-harness land in Phases 2/3.

## Test plan

- [ ] `bun run audit:coverage-floor` exits 0 with the updated baseline
- [ ] `bun run audit:exclusion-parity` exits 0
- [ ] `bun test packages/gateway/test/unit/db/{repair,snapshot}.test.ts` passes
- [ ] `bun test packages/gateway/test/unit/auth/pkce.test.ts` passes
- [ ] `bun test packages/gateway/test/unit/connectors/lazy-mesh/credential-orchestration.test.ts` passes
- [ ] `bun test packages/gateway/test/unit/ipc/connector-rpc-handlers/auth.test.ts` passes
- [ ] CI green on Linux (`pr-quality`) + 3-OS matrix on push to main
- [ ] CI Linux lcov artifact shows each Phase 1B file at ≥80%

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI on the PR, address any feedback**

If any review feedback comes in, invoke `superpowers:receiving-code-review` to handle it. Do not implement suggestions blindly — verify each one against the spec and the existing tests.

---

## Self-Review Notes

- **Spec coverage:** All five Phase 1B files in the spec's Phase 1 table are addressed (Tasks 2–8). The ratchet rule of "remove from baseline in the same PR" is covered in Task 9. The "test infrastructure per-file" constraint is honored — no shared harness is built (those are Phase 2/3 deliverables per spec §Test Harnesses).

- **No shared harness built ahead of Phase 2/3:** Tasks 2–8 each scaffold their own setup directly. The `makeCtx()` helper in Task 7 is local to that test file, not a shared export.

- **Assertion quality:** Each task asserts on meaningful surface (vault writes, DB rows, audit entries, redaction of credential values in responses, gzip magic bytes, RFC 7636 known vector for PKCE) — not just "function was called."

- **`engine/agent.ts` is NOT covered here:** That file is Phase 1A. This PR is 1B-only.

- **OAuth/PKCE test note:** Task 5 uses a real `Bun.serve` — this is the right choice over mocking the server entry, because the function under test creates its own server and we'd otherwise be testing nothing. The trade is some real local HTTP per test, ~5–20 ms each.

- **Baseline diff is deterministic:** Five entries removed, no entries added, `generated_at` timestamp updated. Task 9 has explicit instructions for this.

---

## Risk Register

| Risk                                                                                     | Mitigation                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleConnectorAuth`'s actual params/return shape differs from the plan's assumed shape | Step 1 of Task 7 explicitly says "read the source first." All code blocks in the plan are templates — adjust field names to match.                                                                                                            |
| `runPKCEFlow` test deadlocks because the function holds a Promise the test can't resolve | Step 3 of Task 5 instructs to debug by logging around the polling loop and callback hit. Worst case: split the test into a smaller covering test that exercises pkceCodeChallengeS256 + the URL builder helper without running the full flow. |
| Local lcov build fails on Windows (Bun's coverage path quirks)                           | Task 9 Step 1 explicitly directs to the "push + CI lcov download" workflow as fallback. Don't try to fix Windows-local lcov here.                                                                                                             |
| A test exposes a real bug in production code                                             | Per "TDD Cycle for Coverage Work" — fix the bug in the same commit, note it in the commit message, continue.                                                                                                                                  |
| Phase 1B opens a window where the ratchet count assertion is wrong                       | Task 9 Step 4 (`bun run audit:coverage-floor`) catches this before commit.                                                                                                                                                                    |
