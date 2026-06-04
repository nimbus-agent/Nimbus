# tool_call_log Retention Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the unbounded `tool_call_log` table with a configurable retention policy: a daily prune job deletes rows older than `[audit].tool_call_log_retention_days` (default 90) and records ONE `tool_call_log.pruned` entry in the BLAKE3-chained `audit_log` with the deleted-row count.

**Architecture:** Three seams. (1) A new `[audit]` TOML section parsed in `config/nimbus-toml.ts`, mirroring the `[extensions]` integer-with-bounds parser. (2) A pure `pruneToolCallLog(db, { retentionDays, nowMs })` function in a new `db/tool-call-log-retention.ts` that deletes old rows and appends the audit entry via the existing `appendAuditEntry` — never rewriting the chain, only appending. (3) A `setInterval`-based scheduler registration in `platform/assemble.ts`, mirroring the existing session-memory prune (`maybeAttachSessionMemoryStore`): prune once at startup, then every 24h, with the stop handle pushed onto `sidecarStops`.

**Tech Stack:** Bun v1.2 / TypeScript strict, `bun:sqlite`, Biome. Tests are `bun test`.

**No migration required:** `tool_call_log` is the V29 table; `called_at` (epoch **ms**) is already indexed. Retention is row deletion, not a schema change.

**Invariant note (I14):** all writes go through `dbRun` (the DELETE and the audit INSERT via `appendAuditEntry`). No new `db.run`/`db.exec`. The chained `audit_log` is only **appended** to (the sanctioned path), never pruned or rewritten — "don't touch audit_log proper" is satisfied.

---

## File Structure

- **Modify** `packages/gateway/src/config/nimbus-toml.ts` — add `NimbusAuditToml` type, default, parser, loaders.
- **Create** `packages/gateway/src/db/tool-call-log-retention.ts` — pure `pruneToolCallLog` + `startToolCallLogRetention` scheduler.
- **Modify** `packages/gateway/src/platform/assemble.ts` — register the retention scheduler after the session-memory store, push stop onto `sidecarStops`.
- **Create** `packages/gateway/src/config/nimbus-toml.audit.test.ts` — config parser unit tests.
- **Create** `packages/gateway/src/db/tool-call-log-retention.test.ts` — prune + audit-append unit/integration tests.

---

## Task 1: `[audit]` config section

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts` (add after the `[extensions]` section, ~line 587)
- Test: `packages/gateway/src/config/nimbus-toml.audit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml.audit.test.ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NIMBUS_AUDIT_TOML,
  parseNimbusAuditToml,
} from "./nimbus-toml.ts";

describe("parseNimbusAuditToml", () => {
  test("defaults to 90 days when no [audit] section", () => {
    expect(parseNimbusAuditToml("")).toEqual({ toolCallLogRetentionDays: 90 });
    expect(DEFAULT_NIMBUS_AUDIT_TOML).toEqual({ toolCallLogRetentionDays: 90 });
  });

  test("reads a valid integer retention", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 30\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(30);
  });

  test("0 disables pruning (kept forever)", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 0\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(0);
  });

  test("throws on a non-integer value", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 12.5\n";
    expect(() => parseNimbusAuditToml(raw)).toThrow();
  });

  test("throws on a negative or out-of-range value", () => {
    expect(() =>
      parseNimbusAuditToml("[audit]\ntool_call_log_retention_days = -1\n"),
    ).toThrow();
    expect(() =>
      parseNimbusAuditToml("[audit]\ntool_call_log_retention_days = 40000\n"),
    ).toThrow();
  });

  test("ignores entries outside the [audit] section", () => {
    const raw = "[other]\ntool_call_log_retention_days = 5\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(90);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from worktree root): `bun test packages/gateway/src/config/nimbus-toml.audit.test.ts`
Expected: FAIL — `parseNimbusAuditToml` / `DEFAULT_NIMBUS_AUDIT_TOML` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/gateway/src/config/nimbus-toml.ts` (after the `[extensions]` loaders block, immediately before `export type NimbusUserToml`):

```ts
export type NimbusAuditToml = {
  // 0 disables pruning (rows kept forever). > 0 = delete tool_call_log rows
  // older than N days on the daily retention job.
  toolCallLogRetentionDays: number;
};

export const DEFAULT_NIMBUS_AUDIT_TOML: NimbusAuditToml = {
  toolCallLogRetentionDays: 90,
};

function parseToolCallLogRetentionDays(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(
      `[audit].tool_call_log_retention_days must be an integer (got: ${valRaw})`,
    );
  }
  if (n < 0 || n > 36_500) {
    throw new Error(
      `[audit].tool_call_log_retention_days must be in [0, 36500] (got: ${n})`,
    );
  }
  return n;
}

function parseNimbusTomlAuditSection(source: string): Partial<NimbusAuditToml> {
  const out: Partial<NimbusAuditToml> = {};
  forEachSectionEntry(source, "[audit]", (key, valRaw) => {
    if (key === "tool_call_log_retention_days") {
      out.toolCallLogRetentionDays = parseToolCallLogRetentionDays(valRaw);
    }
  });
  return out;
}

export function parseNimbusAuditToml(
  raw: string,
  defaults: NimbusAuditToml = DEFAULT_NIMBUS_AUDIT_TOML,
): NimbusAuditToml {
  return { ...defaults, ...parseNimbusTomlAuditSection(raw) };
}

export function loadNimbusAuditFromPath(tomlPath: string): NimbusAuditToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AUDIT_TOML, parseNimbusAuditToml);
}

export function loadNimbusAuditFromConfigDir(configDir: string): NimbusAuditToml {
  return loadNimbusAuditFromPath(join(configDir, "nimbus.toml"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml.audit.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.audit.test.ts
git commit -m "feat(config): add [audit].tool_call_log_retention_days (default 90)"
```

---

## Task 2: Pure `pruneToolCallLog` + audit append

**Files:**

- Create: `packages/gateway/src/db/tool-call-log-retention.ts`
- Test: `packages/gateway/src/db/tool-call-log-retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/db/tool-call-log-retention.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { GENESIS_HASH } from "./audit-chain.ts";
import { writeToolCallLog } from "./tool-call-log.ts";
import { pruneToolCallLog } from "./tool-call-log-retention.ts";

const DAY_MS = 86_400_000;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_id TEXT NOT NULL,
      service TEXT NOT NULL,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER,
      result_envelope TEXT,
      status TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      hitl_status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      row_hash TEXT,
      prev_hash TEXT,
      session_id TEXT
    );
  `);
  return db;
}

function seedCall(db: Database, calledAt: number): void {
  writeToolCallLog(db, {
    sessionId: null,
    toolId: "t",
    service: "s",
    calledAt,
    durationMs: 1,
    resultEnvelope: "{}",
    status: "ok",
  });
}

function countCalls(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM tool_call_log").get() as { c: number }).c;
}

describe("pruneToolCallLog", () => {
  let db: Database;
  const now = 1_000 * DAY_MS; // arbitrary fixed "now"

  beforeEach(() => {
    db = freshDb();
  });

  test("deletes rows older than the retention window, keeps newer", () => {
    seedCall(db, now - 91 * DAY_MS); // older than 90d -> pruned
    seedCall(db, now - 89 * DAY_MS); // within 90d -> kept
    seedCall(db, now); // now -> kept
    const deleted = pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    expect(deleted).toBe(1);
    expect(countCalls(db)).toBe(2);
  });

  test("retentionDays = 0 disables pruning (no delete, no audit row)", () => {
    seedCall(db, now - 10_000 * DAY_MS);
    const deleted = pruneToolCallLog(db, { retentionDays: 0, nowMs: now });
    expect(deleted).toBe(0);
    expect(countCalls(db)).toBe(1);
    const audit = db.query("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number };
    expect(audit.c).toBe(0);
  });

  test("writes exactly one chained tool_call_log.pruned audit entry with the count", () => {
    seedCall(db, now - 100 * DAY_MS);
    seedCall(db, now - 200 * DAY_MS);
    pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    const rows = db
      .query("SELECT action_type, hitl_status, action_json, prev_hash, row_hash FROM audit_log")
      .all() as Array<{
      action_type: string;
      hitl_status: string;
      action_json: string;
      prev_hash: string;
      row_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action_type).toBe("tool_call_log.pruned");
    expect(rows[0]?.hitl_status).toBe("not_required");
    expect(JSON.parse(rows[0]?.action_json ?? "{}").deleted_count).toBe(2);
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[0]?.row_hash).toHaveLength(64);
  });

  test("no rows to prune -> no audit entry", () => {
    seedCall(db, now);
    const deleted = pruneToolCallLog(db, { retentionDays: 90, nowMs: now });
    expect(deleted).toBe(0);
    const audit = db.query("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number };
    expect(audit.c).toBe(0);
  });

  test("missing tool_call_log table is a no-op (returns 0)", () => {
    const bare = new Database(":memory:");
    expect(pruneToolCallLog(bare, { retentionDays: 90, nowMs: now })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/db/tool-call-log-retention.test.ts`
Expected: FAIL — module `tool-call-log-retention.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/db/tool-call-log-retention.ts
import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "./audit-chain.ts";
import { dbRun } from "./write.ts";

const DAY_MS = 86_400_000;

/** Daily cadence for the retention job. */
export const TOOL_CALL_LOG_PRUNE_INTERVAL_MS = DAY_MS;

export interface PruneToolCallLogOptions {
  /** From `[audit].tool_call_log_retention_days`. 0 disables pruning. */
  retentionDays: number;
  /** Injected clock (epoch ms) for deterministic tests. */
  nowMs: number;
}

function toolCallLogExists(db: Database): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_call_log'")
    .get() as { 1: number } | null;
  return row !== null;
}

/**
 * Delete tool_call_log rows older than the retention window and, when any were
 * removed, append ONE `tool_call_log.pruned` entry to the chained audit_log.
 * The audit_log chain is only appended to — never rewritten. Returns the number
 * of deleted rows.
 */
export function pruneToolCallLog(db: Database, opts: PruneToolCallLogOptions): number {
  if (opts.retentionDays <= 0) {
    return 0;
  }
  if (!toolCallLogExists(db)) {
    return 0;
  }
  const cutoffMs = opts.nowMs - opts.retentionDays * DAY_MS;

  let deleted = 0;
  db.transaction(() => {
    const res = dbRun(db, "DELETE FROM tool_call_log WHERE called_at < ?", [cutoffMs]);
    deleted = Number(res.changes);
    if (deleted > 0) {
      appendAuditEntry(db, {
        actionType: "tool_call_log.pruned",
        hitlStatus: "not_required",
        actionJson: JSON.stringify({
          deleted_count: deleted,
          retention_days: opts.retentionDays,
          cutoff_ms: cutoffMs,
        }),
        timestamp: opts.nowMs,
      });
    }
  })();
  return deleted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/db/tool-call-log-retention.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/db/tool-call-log-retention.ts packages/gateway/src/db/tool-call-log-retention.test.ts
git commit -m "feat(db): prune tool_call_log + append tool_call_log.pruned audit entry"
```

---

## Task 3: Scheduler `startToolCallLogRetention`

**Files:**

- Modify: `packages/gateway/src/db/tool-call-log-retention.ts`
- Test: `packages/gateway/src/db/tool-call-log-retention.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/db/tool-call-log-retention.test.ts`:

```ts
import { startToolCallLogRetention } from "./tool-call-log-retention.ts";

describe("startToolCallLogRetention", () => {
  const now = 1_000 * DAY_MS;

  test("prunes once immediately on start", () => {
    const db = freshDb();
    seedCall(db, now - 200 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 90,
      nowMs: () => now,
    });
    try {
      expect(countCalls(db)).toBe(0);
    } finally {
      handle.stop();
    }
  });

  test("a prune error does not throw out of the tick", () => {
    const db = freshDb();
    db.exec("DROP TABLE audit_log"); // append will fail inside the tick
    seedCall(db, now - 200 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 90,
      nowMs: () => now,
    });
    handle.stop(); // must not have thrown
    expect(true).toBe(true);
  });

  test("retentionDays = 0 starts no timer and prunes nothing", () => {
    const db = freshDb();
    seedCall(db, now - 10_000 * DAY_MS);
    const handle = startToolCallLogRetention(db, {
      retentionDays: 0,
      nowMs: () => now,
    });
    try {
      expect(countCalls(db)).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/db/tool-call-log-retention.test.ts`
Expected: FAIL — `startToolCallLogRetention` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/gateway/src/db/tool-call-log-retention.ts`:

```ts
export interface StartToolCallLogRetentionOptions {
  retentionDays: number;
  /** Clock source; defaults to Date.now. Injected in tests. */
  nowMs?: () => number;
}

export interface ToolCallLogRetentionHandle {
  stop(): void;
}

/**
 * Run the retention prune once immediately, then every 24h. Each tick is
 * isolated (a thrown prune never escapes). Returns a stop handle to clear the
 * timer; push it onto the sidecar stop list. When retention is disabled
 * (retentionDays <= 0) no timer is created and the handle is a no-op.
 */
export function startToolCallLogRetention(
  db: Database,
  opts: StartToolCallLogRetentionOptions,
): ToolCallLogRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  if (opts.retentionDays <= 0) {
    return { stop: () => {} };
  }
  const tick = (): void => {
    try {
      pruneToolCallLog(db, { retentionDays: opts.retentionDays, nowMs: clock() });
    } catch {
      // Best-effort maintenance — never crash the scheduler.
    }
  };
  tick();
  const timer = setInterval(tick, TOOL_CALL_LOG_PRUNE_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/db/tool-call-log-retention.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/db/tool-call-log-retention.ts packages/gateway/src/db/tool-call-log-retention.test.ts
git commit -m "feat(db): daily startToolCallLogRetention scheduler with injected clock"
```

---

## Task 4: Wire the scheduler into platform assembly

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts` (import block ~line 11-20; registration after line 356)

- [ ] **Step 1: Add the import**

In the `../config/nimbus-toml.ts` import block (lines 11-19), add `loadNimbusAuditFromConfigDir` in alphabetical order (before `loadNimbusAutomationFromConfigDir`):

```ts
import {
  loadNimbusAuditFromConfigDir,
  loadNimbusAutomationFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusLlmPartialFromPath,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
```

Add the retention-module import near the other `../db/...` imports:

```ts
import { startToolCallLogRetention } from "../db/tool-call-log-retention.ts";
```

- [ ] **Step 2: Register the scheduler**

Immediately after line 356 (`const sessionMemoryStore = maybeAttachSessionMemoryStore(...)`), add:

```ts
  const auditCfg = loadNimbusAuditFromConfigDir(paths.configDir);
  const toolCallLogRetention = startToolCallLogRetention(db, {
    retentionDays: auditCfg.toolCallLogRetentionDays,
  });
  sidecarStops.push(() => toolCallLogRetention.stop());
```

- [ ] **Step 3: Typecheck + run the gateway config/db suites**

Run: `bun run typecheck` (from repo root) — Expected: no new errors.
Run: `bun test packages/gateway/src/db/tool-call-log-retention.test.ts packages/gateway/src/config/nimbus-toml.audit.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(gateway): start tool_call_log retention scheduler on assembly"
```

---

## Task 5: Docs — CHANGELOG entry + roadmap checkbox

> The Phase 5 ✅ flip and the roadmap-row status line are handled in the separate docs-reconciliation PR (PR B). This PR only flips its own roadmap checkbox and logs the delivery, per the CHANGELOG convention (memory: connector-docs-changelog-convention — log deliveries in `docs/CHANGELOG.md`, do NOT append to the CLAUDE.md/GEMINI.md status line).

**Files:**

- Modify: `docs/roadmap.md` (the `tool_call_log` retention-policy checkbox line)
- Modify: `docs/CHANGELOG.md` (new dated entry under Phase 5)

- [ ] **Step 1: Flip the roadmap checkbox**

In `docs/roadmap.md`, change the `tool_call_log` retention policy line from `- [ ]` to `- [x]` and append a delivery note `(2026-06-04, Phase 5)` with a one-line summary (config key + default + audit-row behavior + no-migration note).

- [ ] **Step 2: Add the CHANGELOG entry**

Add a `### 2026-06-04` entry (or extend the existing one) under `## Phase 5 — The Extended Surface` in `docs/CHANGELOG.md` describing the retention policy: the `[audit].tool_call_log_retention_days` key (default 90, 0 = disabled), the daily prune job, the single `tool_call_log.pruned` audit entry, and that the chained `audit_log` is only appended to (never pruned).

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md docs/CHANGELOG.md
git commit -m "docs: log tool_call_log retention policy delivery"
```

---

## Task 6: Preflight + push

- [ ] **Step 1: Run preflight**

Run (from worktree root): `bun run preflight`
Expected: all gates green. If markdownlint/lychee flags the CHANGELOG/roadmap edits, fix and re-run.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin dev/asafgolombek/tool-call-log-retention
gh pr create --base main --title "feat: tool_call_log retention policy ([audit].tool_call_log_retention_days)" --body "<summary + test plan>"
```

---

## Self-Review

**Spec coverage:**

- `[audit].tool_call_log_retention_days` (default 90) → Task 1 ✅
- Daily prune of rows older than threshold → Tasks 2 (delete) + 3 (daily scheduler) ✅
- ONE `tool_call_log.pruned` audit row with deleted count → Task 2 (asserted exactly-one, count in `deleted_count`) ✅
- Must NOT touch the BLAKE3-chained audit_log proper → Task 2 only **appends** via `appendAuditEntry`; no audit_log delete/rewrite anywhere ✅
- Currently unbounded → bounded by the daily delete ✅
- No migration (V29 table, `called_at` indexed) → confirmed, no `index/` file created ✅

**Placeholder scan:** Step 5/6 docs/PR bodies reference "<summary>" placeholders — those are human-authored prose, acceptable. All code steps carry complete code.

**Type consistency:** `pruneToolCallLog(db, { retentionDays, nowMs })` (number nowMs) vs `startToolCallLogRetention(db, { retentionDays, nowMs?: () => number })` (clock fn) — intentionally different: the pure fn takes a fixed instant, the scheduler takes a clock source and calls it per tick. `ToolCallLogRetentionHandle.stop()` matches the `sidecarStops.push(() => ...stop())` usage. `DEFAULT_NIMBUS_AUDIT_TOML` / `parseNimbusAuditToml` / `loadNimbusAuditFromConfigDir` names consistent across Tasks 1 and 4.
