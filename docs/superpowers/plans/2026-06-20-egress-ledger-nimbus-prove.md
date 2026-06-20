# Egress Ledger & `nimbus prove` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship an always-on, append-only, BLAKE3-chained **egress ledger** that records every outbound action the gateway authorizes — co-located with the executor HITL gate — plus the `nimbus prove` / `nimbus egress` read-and-verify surface, so a user can *see and verify* that zero outbound calls occurred for a local-only query.

**Architecture:** A new `packages/gateway/src/egress/` directory owns the write path (`appendEgressEntry`), the pure record/redaction helpers, and the verify/prove/prune logic. The single write hook lives inside `ToolExecutor.gate()` (the existing connector-dispatch chokepoint), injected via a DI'd `EgressSink` so the executor stays import-light and test-isolated. A V44 SQLite migration adds the `egress_ledger` table. A new `egress.*` IPC namespace + `nimbus prove`/`nimbus egress` CLI expose read/verify/prove/prune. A new invariant **I30** (with static complement **D23**) makes the executor chokepoint *total* so a `0`-row window is a sound negative, not a hopeful one.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict (NO `any`), Biome, bun:sqlite, bun test.

## Global Constraints

- **Numbering — migration is V44; invariant is a reconcile-at-execution label.** Migrations are CONTIGUOUS (never skip a version): the schema head is V43 and egress is built before the Watch Daemon, so this migration is **V44** (`simpleStep(43, 44, …)`). The invariant is labelled **I30** / static complement **D23** as a proposed-sequence placeholder; at execution set it to the real next-free invariant above the current ceiling (I27 today — **I28** if the MCP-server owner-sink on `dev/asafgolombek/phase7-mcp-gateway-server` is still unmerged when this lands, else the next free) and the next-free D, applied consistently across the I-row in `SECURITY-INVARIANTS.md`/`CLAUDE.md`/`GEMINI.md`, the `security-invariants.test.ts` test, and the `check-nimbus-invariants.ts` D check, in one pass.
- **Per-file coverage floor ≥80% line+branch**, CI-Linux-authoritative (`audit:coverage-floor`). Baseline is `{}` (every non-flagship file must clear the floor). DI every seam (db, clock/`now`, vault, notify) so each new `egress/*`, `ipc/egress-rpc.ts`, and CLI file is unit-testable without integration scaffolding.
- **Invariant triple rule (one commit).** The I30 wiring + the `SECURITY-INVARIANTS.md` row + the `CLAUDE.md`/`GEMINI.md` row + the `security-invariants.test.ts` test + the `scripts/structure-audit/check-nimbus-invariants.ts` D23 static check ALL land in the SAME commit (Task 7). Retiring an invariant = delete the row, never leave drift.
- **Branch hygiene.** Never commit on `main`/`develop`. Before any commit: `git switch -c dev/asafgolombek/egress-ledger-nimbus-prove` and verify `git rev-parse --abbrev-ref HEAD`.
- **No `any`** — `unknown` for external/raw data; strict mode is non-negotiable.
- **Biome** is the linter/formatter; run `bunx biome check packages scripts` (NOT `bun run lint`, which 0-files in worktrees).
- **No plaintext credentials** — the receipt signing key reuses the existing Vault-only Ed25519 share keypair (`ensureShareKeypair`); the private seed is never returned over IPC, persisted to a DB column, or logged.
- **HITL is structural** — `egress.prune` is the only mutation; it joins the I2 frozen set (`HITL_REQUIRED_BACKING`) and is owner-approved via a broker, never config-bypassed.
- **I14/D12** — all SQLite writes go through `dbRun`/`dbExec`/`dbStmtRun` from `db/write.ts` (never raw `db.run`/`db.exec`).
- **I9** — bound-param SQL only; never interpolate caller data into SQL.
- **Append placement (fail-closed).** The ledger row is appended **before** `connectors.dispatch()`; an append failure **aborts** the action (throws, never dispatches). A rejected/denied action appends a `result_status='blocked'` row.

---

## File Structure

**Created:**

| File | Single responsibility |
| --- | --- |
| `packages/gateway/src/index/egress-ledger-v44-sql.ts` | The `EGRESS_LEDGER_V44_SQL` constant (CREATE TABLE `egress_ledger` + 3 indexes). |
| `packages/gateway/src/index/migrations/runner-v44.test.ts` | V44 migration test: applies on a V43 DB, idempotent, table shape correct. |
| `packages/gateway/src/egress/egress-record.ts` | Pure types + `summarizeDestination()` / `classifyMethod()` / `redactEgressSummary()` helpers (no DB, no IO). |
| `packages/gateway/src/egress/egress-record.test.ts` | Unit tests for the pure record helpers. |
| `packages/gateway/src/egress/egress-ledger.ts` | The write path: `appendEgressEntry(db, entry)` (BLAKE3-chained, append-only) + the `EgressSink` interface + `makeEgressSink(db, now)`. |
| `packages/gateway/src/egress/egress-ledger.test.ts` | Unit/integration tests for the append path (real `bun:sqlite`). |
| `packages/gateway/src/egress/egress-verify.ts` | The read/verify path: `verifyEgressChain(db, fromId)`, `proveWindow(db, opts)`, `listEgress(db, opts)`, `egressHead(db)`. |
| `packages/gateway/src/egress/egress-verify.test.ts` | Unit/integration tests for verify/prove/list/head (clean + tampered chains). |
| `packages/gateway/src/egress/egress-prune.ts` | `pruneEgress(db, beforeTs, now)`: the sole mutation; deletes prefix rows + writes a continuing `source_type='prune'` tombstone. |
| `packages/gateway/src/egress/egress-prune.test.ts` | Unit/integration tests for prune (tombstone written, chain stays verifiable). |
| `packages/gateway/src/egress/egress-sign.ts` | `signWindowDigest(vault, digest)`: signs a window digest with the Vault-only share keypair; never returns the private key. |
| `packages/gateway/src/egress/egress-sign.test.ts` | Vault test: private key never escapes; signature verifies. |
| `packages/gateway/src/ipc/egress-rpc.ts` | `dispatchEgressRpc(method, params, ctx)` for `egress.list`/`egress.verify`/`egress.head`/`egress.proveWindow`/`egress.prune`. |
| `packages/gateway/src/ipc/egress-rpc.test.ts` | Unit tests for the egress RPC handlers (param validation + dispatch). |
| `packages/cli/src/commands/prove.ts` | `runProve(args)` + `runEgress(args)` — the `nimbus prove` / `nimbus egress` CLI (both verbs, one module). |
| `packages/cli/src/commands/prove.test.ts` | Unit tests for the CLI handlers (injected IPC client). |

**Modified:**

| File | Change |
| --- | --- |
| `packages/gateway/src/index/migrations/runner.ts` | Import `EGRESS_LEDGER_V44_SQL`; append `simpleStep(43, 44, …)`. (BACKFILL_LABELS is NOT touched — it intentionally stops at v37.) |
| `packages/gateway/src/index/local-index.ts` | Bump `CURRENT_SCHEMA_VERSION` 43 → 44. |
| `packages/gateway/src/engine/executor.ts` | Add `egress.prune` to `HITL_REQUIRED_BACKING`; add optional `egressSink?: EgressSink` constructor param; append-before-dispatch wiring in `gate()`/`execute()`. |
| `packages/gateway/src/security-invariants.test.ts` | Add the `describe("I30 — …")` block (3 sub-tests + D23-presence test). |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Add `checkEgressChokepointConfinement` (D23) + wire it into `run()`. |
| `scripts/structure-audit/check-nimbus-invariants.test.ts` | Add a D23 unit test (planted `connectors.dispatch` outside executor fails). |
| `packages/gateway/src/ipc/server/dispatchers.ts` | Add `tryDispatchEgressRpc` + wire it into the phase-4 chain. |
| `packages/gateway/src/ipc/server/options.ts` | Add `egressRpcCtx?: EgressRpcCtx` to the server options. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Add the 4 read-only `egress.*` verbs to `ALLOWED_METHODS` (bump count 95 → 99); NOT `egress.prune`. |
| `packages/cli/src/index.ts` | Register `prove: runProve` + `egress: runEgress` in `COMMAND_HANDLERS`. |
| `docs/SECURITY-INVARIANTS.md` | Add the I30 row (triple rule, Task 7). |
| `CLAUDE.md` + `GEMINI.md` | Add the I30 bullet + the D23 line in the "Static complement" paragraph (triple rule, Task 7). |
| `docs/CHANGELOG.md` | Add the dated egress-ledger entry (Task 13). |

---

## Task 1: PRE-IMPL ACCEPTANCE GATE — prove `connectors.dispatch` is already total

**Files:** Create: (none) · Modify: (none) · Test: this task is a verification gate, not code.

**Interfaces:** Produces: a documented finding that every `connectors.dispatch` call site routes through `ToolExecutor`, OR a BLOCKER if it does not. (D23 in Task 7 will switch the rule on; this proves the current tree already satisfies it.)

This is criterion 9 of the spec: the "zero egress" completeness claim is only sound if every outbound action routes through the ledgered `ToolExecutor`. If a `connectors.dispatch` call exists outside `engine/executor.ts`, the ledger is incomplete and the slice does not ship until that bypass is removed. Verify it BEFORE enforcing D23.

- [ ] **Step 1: Enumerate every `connectors.dispatch` reference.** Run:
  ```
  bun run --bun rg -n "connectors\.dispatch" packages/gateway/src --glob '!*.test.ts'
  ```
  (or use the Grep tool with pattern `connectors\.dispatch`). **Expected:** exactly ONE hit:
  - `packages/gateway/src/engine/executor.ts:303 — const result = await this.connectors.dispatch(action);`
- [ ] **Step 2: Enumerate every `.dispatch(action` reference to confirm no OTHER caller invokes a dispatcher.** Run:
  ```
  bun run --bun rg -n "\.dispatch\(action" packages/gateway/src --glob '!*.test.ts'
  ```
  **Expected:** these hits, and confirm each is a *method definition* or an in-`connectors/` decorator delegation, NOT a `ToolExecutor`-bypassing call:
  - `connectors/registry.ts` — `async dispatch(action: PlannedAction)` — the `ConnectorDispatcher` *implementation* (definition, not a call).
  - `connectors/warehouse-write-dispatch.ts` — `dispatch(action: …)` (definition) + `inner.dispatch(action)` (the decorator delegating to the wrapped dispatcher, INSIDE the `connectors/` layer — this is `inner.dispatch`, NOT `connectors.dispatch`).
  - `chatops/chatops-tool-runner-e2e-sink.ts` — `dispatch(action: …)` — a test/e2e sink *implementation* (definition).
  - `engine/types.ts` — `dispatch(action: PlannedAction): Promise<unknown>;` — the interface *declaration*.
- [ ] **Step 3: Document the finding.** Confirm in the PR description / commit body that:
  - The only `connectors.dispatch` (property access on the executor-injected dispatcher) is `executor.ts:303`.
  - All other `.dispatch(action)` occurrences are interface declarations, `ConnectorDispatcher` implementations, or the `connectors/`-internal decorator delegation (`inner.dispatch`) — none of which is an outbound-action call that bypasses `ToolExecutor.gate()`.
  - **Therefore the executor chokepoint is already total**, and D23 (forbidding `connectors.dispatch` outside `engine/executor.ts`) can be switched on in Task 7 without first removing any bypass.
- [ ] **Step 4: BLOCKER check.** If Step 1 returns more than one hit, or if any `.dispatch(action)` in Step 2 is a *call on the executor's dispatcher from outside `ToolExecutor`*, STOP: the slice cannot ship until that path is routed through `ToolExecutor`. Record it as a blocker and surface it to the user before proceeding.

(No commit for this task — it is a read-only acceptance gate. Its conclusion is captured in the Task 7 commit body.)

---

## Task 2: V44 `egress_ledger` migration

**Files:** Create: `packages/gateway/src/index/egress-ledger-v44-sql.ts`, `packages/gateway/src/index/migrations/runner-v44.test.ts` · Modify: `packages/gateway/src/index/migrations/runner.ts`, `packages/gateway/src/index/local-index.ts`

**Interfaces:** Produces: `export const EGRESS_LEDGER_V44_SQL: string` (the CREATE TABLE + indexes). Consumes (existing): `runIndexedSchemaMigrations(db, targetVersion)`, `CURRENT_SCHEMA_VERSION`, `GENESIS_HASH`.

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/index/migrations/runner-v44.test.ts`:
  ```ts
  import { Database } from "bun:sqlite";
  import { describe, expect, test } from "bun:test";
  import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
  import { runIndexedSchemaMigrations } from "./runner.ts";

  function columnNames(db: Database, table: string): string[] {
    return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  }

  describe("V44 migration — egress_ledger", () => {
    test("CURRENT_SCHEMA_VERSION is at least 44", () => {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
    });

    test("applies on a V43 DB and creates egress_ledger with the expected columns", () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 43);
      expect(columnNames(db, "egress_ledger")).toHaveLength(0); // table absent at V43
      runIndexedSchemaMigrations(db, 44);
      expect(columnNames(db, "egress_ledger")).toEqual(
        expect.arrayContaining([
          "id",
          "timestamp",
          "source_type",
          "source_id",
          "destination",
          "method",
          "payload_summary",
          "hitl_status",
          "result_status",
          "row_hash",
          "prev_hash",
        ]),
      );
      db.close();
    });

    test("is idempotent — re-running to V44 on a V44 DB is a no-op (no throw, no dup rows)", () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 44);
      db.run(
        `INSERT INTO egress_ledger
          (timestamp, source_type, source_id, destination, method, payload_summary, hitl_status, result_status, row_hash, prev_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [1, "task", "s1", "email", "email.send", "{}", "approved", "authorized", "a".repeat(64), "0".repeat(64)],
      );
      runIndexedSchemaMigrations(db, 44); // second run: must skip the step entirely
      const count = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
      expect(count).toBe(1);
      db.close();
    });

    test("the three lookup indexes exist", () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 44);
      const idx = (db.query(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(idx).toEqual(
        expect.arrayContaining([
          "idx_egress_ledger_ts",
          "idx_egress_ledger_source",
          "idx_egress_ledger_dest",
        ]),
      );
      db.close();
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/index/migrations/runner-v44.test.ts` — Expected: FAIL (`CURRENT_SCHEMA_VERSION` is 43, so the `>= 44` assertion fails; `runIndexedSchemaMigrations(db, 44)` throws "Unsupported local index schema version" because no 43→44 step exists yet).
- [ ] **Step 3: Implement.** Create `packages/gateway/src/index/egress-ledger-v44-sql.ts`:
  ```ts
  /**
   * V44 (S1 "Local Brain" — provable-locality primitive) — `egress_ledger`: an always-on,
   * append-only, BLAKE3-chained ledger of every outbound action the gateway AUTHORIZES.
   *
   * `destination` is the service/host derived from the action-type prefix (`serviceOf()`), NEVER a
   * raw URL with a query-string secret. `payload_summary` is `redactAuditPayload(action.payload)`
   * capped at 256 bytes. `result_status='blocked'` rows record what was STOPPED (a denied gate).
   * `source_type='prune'` is the single tombstone row class (the only sanctioned mutation continues
   * the chain rather than leaving a silent gap). Append-only; manual prune only. See I30/D23.
   */
  export const EGRESS_LEDGER_V44_SQL = `
  CREATE TABLE IF NOT EXISTS egress_ledger (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        INTEGER NOT NULL,
    source_type      TEXT NOT NULL,
    source_id        TEXT,
    destination      TEXT NOT NULL,
    method           TEXT NOT NULL,
    payload_summary  TEXT NOT NULL,
    hitl_status      TEXT NOT NULL CHECK(hitl_status IN ('approved','not_required','rejected')),
    result_status    TEXT NOT NULL CHECK(result_status IN ('authorized','blocked')),
    row_hash         TEXT NOT NULL,
    prev_hash        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_egress_ledger_ts ON egress_ledger(timestamp);
  CREATE INDEX IF NOT EXISTS idx_egress_ledger_source ON egress_ledger(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_egress_ledger_dest ON egress_ledger(destination);
  `;
  ```
  In `packages/gateway/src/index/migrations/runner.ts`, add the import next to the other SQL-constant imports (near line 46, where `SHARE_INBOX_V43_SQL` is imported):
  ```ts
  import { EGRESS_LEDGER_V44_SQL } from "../egress-ledger-v44-sql.ts";
  ```
  Append to the `INDEXED_SCHEMA_STEPS` array immediately after the `simpleStep(42, 43, …)` line (~line 405):
  ```ts
  simpleStep(43, 44, "egress_ledger (provable-locality primitive v44)", EGRESS_LEDGER_V44_SQL),
  ```
  (V44 is the next-free contiguous schema version — head is V43. Migrations are never skipped. Do NOT add a `BACKFILL_LABELS` entry: that array stops at v37 and the runner test pins the missing-label throw to v38.)
  In `packages/gateway/src/index/local-index.ts`, bump the version (line ~269):
  ```ts
  export const CURRENT_SCHEMA_VERSION = 44;
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/index/migrations/runner-v44.test.ts` — Expected: PASS (4 tests). Then run the existing migration-runner pin to confirm no regression: `bun test packages/gateway/src/index/migrations/runner.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** —
  ```
  git switch -c dev/asafgolombek/egress-ledger-nimbus-prove
  git add packages/gateway/src/index/egress-ledger-v44-sql.ts \
          packages/gateway/src/index/migrations/runner-v44.test.ts \
          packages/gateway/src/index/migrations/runner.ts \
          packages/gateway/src/index/local-index.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): V44 egress_ledger migration (provable-locality primitive)

  Append-only, BLAKE3-chained ledger table for every authorized outbound
  action. V44 is the next-free contiguous version (schema head was V43).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: Pure egress-record helpers

**Files:** Create: `packages/gateway/src/egress/egress-record.ts`, `packages/gateway/src/egress/egress-record.test.ts`

**Interfaces:** Consumes (existing): `serviceOf(actionType: string): string` from `engine/executor.ts`; `redactAuditPayload(payload: unknown, maxBytes?: number): string` from `audit/format-audit-payload.ts`; `PlannedAction` from `engine/types.ts`. Produces:
- `export type EgressResultStatus = "authorized" | "blocked"`
- `export type EgressHitlStatus = "approved" | "not_required" | "rejected"`
- `export interface EgressEntry { timestamp: number; sourceType: string; sourceId: string | null; destination: string; method: string; payloadSummary: string; hitlStatus: EgressHitlStatus; resultStatus: EgressResultStatus }`
- `export function summarizeDestination(actionType: string): string`
- `export function redactEgressSummary(payload: unknown): string`
- `export function buildEgressEntry(args: { action: PlannedAction; hitlStatus: EgressHitlStatus; resultStatus: EgressResultStatus; sessionId: string | undefined; now: number }): EgressEntry`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/egress/egress-record.test.ts`:
  ```ts
  import { describe, expect, test } from "bun:test";
  import { buildEgressEntry, redactEgressSummary, summarizeDestination } from "./egress-record.ts";

  describe("summarizeDestination", () => {
    test("derives the service prefix from a dotted action type", () => {
      expect(summarizeDestination("email.send")).toBe("email");
      expect(summarizeDestination("repo.commit.push")).toBe("repo");
    });
    test("returns the whole type when it has no dot", () => {
      expect(summarizeDestination("ping")).toBe("ping");
    });
  });

  describe("redactEgressSummary", () => {
    test("strips a ghp_ token and caps at 256 bytes", () => {
      const out = redactEgressSummary({ note: `token ghp_${"a".repeat(40)} done` });
      expect(out).not.toContain("ghp_");
      expect(out).toContain("[REDACTED]");
      expect(out.length).toBeLessThanOrEqual(256 + 16); // +slack for the truncation marker
    });
    test("strips a Bearer header and an sk- key", () => {
      const out = redactEgressSummary({ h: `Bearer ${"z".repeat(30)}`, k: `sk-${"y".repeat(30)}` });
      expect(out).not.toContain("zzzz");
      expect(out).not.toContain("sk-yyyy");
    });
    test("truncates an over-long payload to <= 256 bytes of body", () => {
      const out = redactEgressSummary({ big: "x".repeat(5000) });
      expect(out).toContain("…[truncated]");
      expect(out.length).toBeLessThanOrEqual(256 + "…[truncated]".length);
    });
  });

  describe("buildEgressEntry", () => {
    test("maps a planned action into an authorized ledger entry", () => {
      const e = buildEgressEntry({
        action: { type: "email.send", payload: { to: "a@b.c" } },
        hitlStatus: "approved",
        resultStatus: "authorized",
        sessionId: "sess-1",
        now: 1700,
      });
      expect(e.timestamp).toBe(1700);
      expect(e.sourceType).toBe("task");
      expect(e.sourceId).toBe("sess-1");
      expect(e.destination).toBe("email");
      expect(e.method).toBe("email.send");
      expect(e.hitlStatus).toBe("approved");
      expect(e.resultStatus).toBe("authorized");
      expect(e.payloadSummary).toContain("a@b.c");
    });
    test("uses sourceType 'task' and a null sourceId when no session is present", () => {
      const e = buildEgressEntry({
        action: { type: "repo.commit.push" },
        hitlStatus: "not_required",
        resultStatus: "authorized",
        sessionId: undefined,
        now: 5,
      });
      expect(e.sourceId).toBeNull();
      expect(e.payloadSummary).toBe("{}");
    });
    test("a rejected gate yields a blocked entry", () => {
      const e = buildEgressEntry({
        action: { type: "data.delete", payload: { id: 1 } },
        hitlStatus: "rejected",
        resultStatus: "blocked",
        sessionId: "s",
        now: 9,
      });
      expect(e.resultStatus).toBe("blocked");
      expect(e.hitlStatus).toBe("rejected");
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/egress/egress-record.test.ts` — Expected: FAIL (`./egress-record.ts` does not exist — module resolution error).
- [ ] **Step 3: Implement** — `packages/gateway/src/egress/egress-record.ts`:
  ```ts
  import { redactAuditPayload } from "../audit/format-audit-payload.ts";
  import { serviceOf } from "../engine/executor.ts";
  import type { PlannedAction } from "../engine/types.ts";

  /** Max body bytes for `payload_summary` before the redactor appends `…[truncated]`. */
  const EGRESS_SUMMARY_MAX_BYTES = 256;

  export type EgressResultStatus = "authorized" | "blocked";
  export type EgressHitlStatus = "approved" | "not_required" | "rejected";

  export interface EgressEntry {
    readonly timestamp: number;
    readonly sourceType: string;
    readonly sourceId: string | null;
    readonly destination: string;
    readonly method: string;
    readonly payloadSummary: string;
    readonly hitlStatus: EgressHitlStatus;
    readonly resultStatus: EgressResultStatus;
  }

  /**
   * The destination recorded in the ledger: the service/host PREFIX of the action type
   * (`serviceOf` — the segment before the first dot), never a raw URL. So no secret-bearing
   * query string is ever stored.
   */
  export function summarizeDestination(actionType: string): string {
    return serviceOf(actionType);
  }

  /**
   * The redacted, length-capped payload summary. Reuses the shipped `redactAuditPayload` (strips
   * gh*_/sk-/Bearer/JWT/AWS families + token|key|secret|… object keys). Best-effort credential
   * scrubbing for debugging — NOT relied on as the security boundary (the security claim is the
   * append-before-dispatch chokepoint, not the redactor).
   */
  export function redactEgressSummary(payload: unknown): string {
    return redactAuditPayload(payload ?? {}, EGRESS_SUMMARY_MAX_BYTES);
  }

  /** Build a ledger entry from a gated action. `now` is injected (DI; the clock seam). */
  export function buildEgressEntry(args: {
    readonly action: PlannedAction;
    readonly hitlStatus: EgressHitlStatus;
    readonly resultStatus: EgressResultStatus;
    readonly sessionId: string | undefined;
    readonly now: number;
  }): EgressEntry {
    return {
      timestamp: args.now,
      sourceType: "task",
      sourceId: args.sessionId ?? null,
      destination: summarizeDestination(args.action.type),
      method: args.action.type,
      payloadSummary: redactEgressSummary(args.action.payload),
      hitlStatus: args.hitlStatus,
      resultStatus: args.resultStatus,
    };
  }
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/egress/egress-record.test.ts` — Expected: PASS (8 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/egress/egress-record.ts packages/gateway/src/egress/egress-record.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): pure egress-record helpers (destination/redaction/entry builder)

  serviceOf-derived destination (never a raw URL), redactAuditPayload-backed
  256-byte summary, DI'd now() clock. No DB, no IO.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: `appendEgressEntry` + `EgressSink` (BLAKE3-chained write path)

**Files:** Create: `packages/gateway/src/egress/egress-ledger.ts`, `packages/gateway/src/egress/egress-ledger.test.ts`

**Interfaces:** Consumes (existing): `blake3` from `@noble/hashes/blake3.js`, `bytesToHex` from `@noble/hashes/utils.js`, `GENESIS_HASH` from `db/audit-chain.ts`, `dbRun` from `db/write.ts`. Consumes (Task 3): `EgressEntry`. Produces:
- `export function computeEgressRowHash(input: { prevHash: string; timestamp: number; sourceType: string; sourceId: string | null; destination: string; method: string; resultStatus: string }): string`
- `export function appendEgressEntry(db: Database, entry: EgressEntry): void`
- `export interface EgressSink { append(entry: EgressEntry): void }`
- `export function makeEgressSink(db: Database): EgressSink`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/egress/egress-ledger.test.ts`:
  ```ts
  import { Database } from "bun:sqlite";
  import { afterEach, beforeEach, describe, expect, test } from "bun:test";
  import { GENESIS_HASH } from "../db/audit-chain.ts";
  import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
  import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
  import type { EgressEntry } from "./egress-record.ts";
  import { appendEgressEntry, computeEgressRowHash, makeEgressSink } from "./egress-ledger.ts";

  function entry(over: Partial<EgressEntry> = {}): EgressEntry {
    return {
      timestamp: 100,
      sourceType: "task",
      sourceId: "s1",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
      ...over,
    };
  }

  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  describe("appendEgressEntry", () => {
    test("the first row chains from GENESIS_HASH with a 64-char hex row_hash", () => {
      appendEgressEntry(db, entry());
      const row = db.query(`SELECT prev_hash, row_hash FROM egress_ledger ORDER BY id ASC`).get() as {
        prev_hash: string;
        row_hash: string;
      };
      expect(row.prev_hash).toBe(GENESIS_HASH);
      expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("the second row's prev_hash equals the first row's row_hash", () => {
      appendEgressEntry(db, entry({ method: "email.send" }));
      appendEgressEntry(db, entry({ method: "repo.commit.push", timestamp: 200 }));
      const rows = db.query(`SELECT row_hash, prev_hash FROM egress_ledger ORDER BY id ASC`).all() as {
        row_hash: string;
        prev_hash: string;
      }[];
      expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
    });

    test("computeEgressRowHash is deterministic for the same inputs", () => {
      const i = {
        prevHash: GENESIS_HASH,
        timestamp: 1,
        sourceType: "task",
        sourceId: "s",
        destination: "email",
        method: "email.send",
        resultStatus: "authorized",
      };
      expect(computeEgressRowHash(i)).toBe(computeEgressRowHash(i));
    });

    test("a blocked row persists result_status='blocked' and hitl_status='rejected'", () => {
      appendEgressEntry(db, entry({ resultStatus: "blocked", hitlStatus: "rejected" }));
      const row = db.query(`SELECT result_status, hitl_status FROM egress_ledger`).get() as {
        result_status: string;
        hitl_status: string;
      };
      expect(row.result_status).toBe("blocked");
      expect(row.hitl_status).toBe("rejected");
    });
  });

  describe("makeEgressSink", () => {
    test("the sink appends a row through append()", () => {
      const sink = makeEgressSink(db);
      sink.append(entry());
      const c = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
      expect(c).toBe(1);
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/egress/egress-ledger.test.ts` — Expected: FAIL (`./egress-ledger.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/gateway/src/egress/egress-ledger.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import { blake3 } from "@noble/hashes/blake3.js";
  import { bytesToHex } from "@noble/hashes/utils.js";
  import { GENESIS_HASH } from "../db/audit-chain.ts";
  import { dbRun } from "../db/write.ts";
  import type { EgressEntry } from "./egress-record.ts";

  export interface EgressRowHashInput {
    readonly prevHash: string;
    readonly timestamp: number;
    readonly sourceType: string;
    readonly sourceId: string | null;
    readonly destination: string;
    readonly method: string;
    readonly resultStatus: string;
  }

  /**
   * BLAKE3 row hash over `prev_hash | timestamp | source_type | source_id | destination | method |
   * result_status`. Mirrors `db/audit-chain.ts`'s `computeAuditRowHash` exactly (same blake3 +
   * bytesToHex primitive). `payload_summary` is intentionally NOT hashed: it is redacted/lossy and
   * a debugging aid, not part of the tamper-evident commitment.
   */
  export function computeEgressRowHash(input: EgressRowHashInput): string {
    const encoder = new TextEncoder();
    const base = `${input.prevHash}|${String(input.timestamp)}|${input.sourceType}|${input.sourceId ?? ""}|${input.destination}|${input.method}|${input.resultStatus}`;
    return bytesToHex(blake3(encoder.encode(base)));
  }

  function readHeadHash(db: Database): string {
    const raw = db.query(`SELECT row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`).get() as
      | { row_hash: string | null }
      | undefined;
    const h = raw?.row_hash;
    return typeof h === "string" && h.length === 64 ? h : GENESIS_HASH;
  }

  /**
   * Append one egress row, chained to the current head. Append-only — this module exposes NO update
   * or delete path (the sole mutation lives in egress-prune.ts). Writes via `dbRun` (I14/D12).
   */
  export function appendEgressEntry(db: Database, entry: EgressEntry): void {
    const prevHash = readHeadHash(db);
    const rowHash = computeEgressRowHash({
      prevHash,
      timestamp: entry.timestamp,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      destination: entry.destination,
      method: entry.method,
      resultStatus: entry.resultStatus,
    });
    dbRun(
      db,
      `INSERT INTO egress_ledger
        (timestamp, source_type, source_id, destination, method, payload_summary, hitl_status, result_status, row_hash, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.timestamp,
        entry.sourceType,
        entry.sourceId,
        entry.destination,
        entry.method,
        entry.payloadSummary,
        entry.hitlStatus,
        entry.resultStatus,
        rowHash,
        prevHash,
      ],
    );
  }

  /** The DI seam wired into `ToolExecutor` — appends to the given DB. */
  export interface EgressSink {
    append(entry: EgressEntry): void;
  }

  export function makeEgressSink(db: Database): EgressSink {
    return {
      append(entry: EgressEntry): void {
        appendEgressEntry(db, entry);
      },
    };
  }
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/egress/egress-ledger.test.ts` — Expected: PASS (6 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/egress/egress-ledger.ts packages/gateway/src/egress/egress-ledger.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): appendEgressEntry + EgressSink (BLAKE3-chained, append-only)

  Mirrors db/audit-chain.ts chain math; writes via dbRun (I14/D12); the sink
  is the DI seam the executor consumes.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: Verify / prove / list / head read path

**Files:** Create: `packages/gateway/src/egress/egress-verify.ts`, `packages/gateway/src/egress/egress-verify.test.ts`

**Interfaces:** Consumes (existing): `sha256HexEqualConstantTime(a, b): boolean` from `util/timing-safe-compare.ts` (I10 — works on 64-char hex, which is BLAKE3's output width); `GENESIS_HASH` from `db/audit-chain.ts`. Consumes (Task 4): `computeEgressRowHash`. Produces:
- `export type EgressRow = { id: number; timestamp: number; sourceType: string; sourceId: string | null; destination: string; method: string; payloadSummary: string; hitlStatus: string; resultStatus: string; rowHash: string; prevHash: string }`
- `export type EgressVerifyResult = { ok: boolean; verifiedRows: number; brokenAt?: number; reason?: string }`
- `export function verifyEgressChain(db: Database, fromId?: number): EgressVerifyResult`
- `export function listEgress(db: Database, opts: { since?: number; until?: number; limit?: number }): EgressRow[]`
- `export function egressHead(db: Database): { head: string; count: number }`
- `export type EgressCompleteness = { tier: "authorized-actions"; outboundEgressEvents: number }`
- `export function proveWindow(db: Database, opts: { since?: number; until?: number }): { rows: EgressRow[]; completeness: EgressCompleteness; verify: EgressVerifyResult }`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/egress/egress-verify.test.ts`:
  ```ts
  import { Database } from "bun:sqlite";
  import { afterEach, beforeEach, describe, expect, test } from "bun:test";
  import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
  import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
  import { appendEgressEntry } from "./egress-ledger.ts";
  import type { EgressEntry } from "./egress-record.ts";
  import { egressHead, listEgress, proveWindow, verifyEgressChain } from "./egress-verify.ts";

  function e(over: Partial<EgressEntry> = {}): EgressEntry {
    return {
      timestamp: 100,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
      ...over,
    };
  }

  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  describe("verifyEgressChain", () => {
    test("an empty ledger verifies ok with 0 rows", () => {
      expect(verifyEgressChain(db)).toEqual({ ok: true, verifiedRows: 0 });
    });
    test("a clean 3-row chain verifies ok", () => {
      appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
      appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
      appendEgressEntry(db, e({ method: "c.z", timestamp: 3 }));
      const r = verifyEgressChain(db);
      expect(r.ok).toBe(true);
      expect(r.verifiedRows).toBe(3);
    });
    test("a tampered row_hash is detected and brokenAt points at it", () => {
      appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
      appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
      const id = (db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }).id;
      db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [id]);
      const r = verifyEgressChain(db);
      expect(r.ok).toBe(false);
      expect(r.brokenAt).toBe(id);
    });
  });

  describe("egressHead", () => {
    test("reports the head hash and count", () => {
      appendEgressEntry(db, e());
      const h = egressHead(db);
      expect(h.count).toBe(1);
      expect(h.head).toMatch(/^[0-9a-f]{64}$/);
    });
    test("an empty ledger reports the genesis head and count 0", () => {
      const h = egressHead(db);
      expect(h.count).toBe(0);
      expect(h.head).toBe("0".repeat(64));
    });
  });

  describe("listEgress", () => {
    test("filters by since/until and respects limit", () => {
      appendEgressEntry(db, e({ timestamp: 10 }));
      appendEgressEntry(db, e({ timestamp: 20 }));
      appendEgressEntry(db, e({ timestamp: 30 }));
      expect(listEgress(db, { since: 15, until: 25 })).toHaveLength(1);
      expect(listEgress(db, { limit: 2 })).toHaveLength(2);
    });
  });

  describe("proveWindow", () => {
    test("a zero-egress window reports outboundEgressEvents 0 and verifies ok", () => {
      const out = proveWindow(db, { since: 0, until: 1000 });
      expect(out.completeness).toEqual({ tier: "authorized-actions", outboundEgressEvents: 0 });
      expect(out.verify.ok).toBe(true);
      expect(out.rows).toHaveLength(0);
    });
    test("a window with one dispatch reports exactly that row", () => {
      appendEgressEntry(db, e({ timestamp: 50, method: "email.send" }));
      const out = proveWindow(db, { since: 0, until: 100 });
      expect(out.completeness.outboundEgressEvents).toBe(1);
      expect(out.rows[0]?.method).toBe("email.send");
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/egress/egress-verify.test.ts` — Expected: FAIL (`./egress-verify.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/gateway/src/egress/egress-verify.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import { GENESIS_HASH } from "../db/audit-chain.ts";
  import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
  import { computeEgressRowHash } from "./egress-ledger.ts";

  export type EgressRow = {
    id: number;
    timestamp: number;
    sourceType: string;
    sourceId: string | null;
    destination: string;
    method: string;
    payloadSummary: string;
    hitlStatus: string;
    resultStatus: string;
    rowHash: string;
    prevHash: string;
  };

  type RawRow = {
    id: number;
    timestamp: number;
    source_type: string;
    source_id: string | null;
    destination: string;
    method: string;
    payload_summary: string;
    hitl_status: string;
    result_status: string;
    row_hash: string;
    prev_hash: string;
  };

  function toRow(r: RawRow): EgressRow {
    return {
      id: r.id,
      timestamp: r.timestamp,
      sourceType: r.source_type,
      sourceId: r.source_id,
      destination: r.destination,
      method: r.method,
      payloadSummary: r.payload_summary,
      hitlStatus: r.hitl_status,
      resultStatus: r.result_status,
      rowHash: r.row_hash,
      prevHash: r.prev_hash,
    };
  }

  export type EgressVerifyResult = {
    ok: boolean;
    verifiedRows: number;
    brokenAt?: number;
    reason?: string;
  };

  /**
   * Walk the chain from `fromId` (exclusive), recompute each row hash, and compare with the
   * constant-time hex comparator (I10 — `sha256HexEqualConstantTime` works on any 64-char hex,
   * which is BLAKE3's output width — never `===`). A `prev_hash` discontinuity or a hash mismatch
   * fails closed with `brokenAt`.
   */
  export function verifyEgressChain(db: Database, fromId = 0): EgressVerifyResult {
    const start = Math.max(0, Math.floor(fromId));
    const rows = db
      .query(
        `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
                hitl_status, result_status, row_hash, prev_hash
         FROM egress_ledger WHERE id > ? ORDER BY id ASC`,
      )
      .all(start) as RawRow[];

    let prev =
      start > 0
        ? ((db.query(`SELECT row_hash FROM egress_ledger WHERE id = ?`).get(start) as
            | { row_hash: string }
            | undefined)?.row_hash ?? GENESIS_HASH)
        : GENESIS_HASH;

    let verified = 0;
    for (const r of rows) {
      if (!sha256HexEqualConstantTime(r.prev_hash, prev)) {
        return { ok: false, verifiedRows: verified, brokenAt: r.id, reason: `prev_hash mismatch at id ${String(r.id)}` };
      }
      const expected = computeEgressRowHash({
        prevHash: prev,
        timestamp: r.timestamp,
        sourceType: r.source_type,
        sourceId: r.source_id,
        destination: r.destination,
        method: r.method,
        resultStatus: r.result_status,
      });
      if (!sha256HexEqualConstantTime(expected, r.row_hash)) {
        return { ok: false, verifiedRows: verified, brokenAt: r.id, reason: `row_hash mismatch at id ${String(r.id)}` };
      }
      prev = r.row_hash;
      verified += 1;
    }
    return { ok: true, verifiedRows: verified };
  }

  export function egressHead(db: Database): { head: string; count: number } {
    const head = (db.query(`SELECT row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`).get() as
      | { row_hash: string }
      | undefined)?.row_hash ?? GENESIS_HASH;
    const count = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
    return { head, count };
  }

  export function listEgress(
    db: Database,
    opts: { since?: number; until?: number; limit?: number },
  ): EgressRow[] {
    const since = opts.since ?? 0;
    const until = opts.until ?? Number.MAX_SAFE_INTEGER;
    const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 1000;
    const rows = db
      .query(
        `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
                hitl_status, result_status, row_hash, prev_hash
         FROM egress_ledger WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC LIMIT ?`,
      )
      .all(since, until, limit) as RawRow[];
    return rows.map(toRow);
  }

  export type EgressCompleteness = { tier: "authorized-actions"; outboundEgressEvents: number };

  /**
   * The `nimbus prove` window: the rows in [since, until], the completeness tier (honest about the
   * "authorized-actions" boundary — does NOT claim raw-syscall capture, per the spec), and the chain
   * verify result. A degraded chain surfaces `verify.ok === false` — the CLI prints `indeterminate`,
   * never a false `0` (the EAF "indeterminate, never a false zero" rule).
   */
  export function proveWindow(
    db: Database,
    opts: { since?: number; until?: number },
  ): { rows: EgressRow[]; completeness: EgressCompleteness; verify: EgressVerifyResult } {
    const rows = listEgress(db, { since: opts.since, until: opts.until });
    const outbound = rows.filter((r) => r.resultStatus === "authorized").length;
    return {
      rows,
      completeness: { tier: "authorized-actions", outboundEgressEvents: outbound },
      verify: verifyEgressChain(db),
    };
  }
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/egress/egress-verify.test.ts` — Expected: PASS (9 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/egress/egress-verify.ts packages/gateway/src/egress/egress-verify.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): verify/prove/list/head read path (timing-safe chain verify)

  verifyEgressChain compares hashes with sha256HexEqualConstantTime (I10),
  never ===. proveWindow reports the honest 'authorized-actions' tier.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: Prune (the sole mutation — continuing tombstone)

**Files:** Create: `packages/gateway/src/egress/egress-prune.ts`, `packages/gateway/src/egress/egress-prune.test.ts`

**Interfaces:** Consumes (existing): `dbRun`, `dbExec` from `db/write.ts`. Consumes (Task 4): `appendEgressEntry`. Consumes (Task 5): `verifyEgressChain`. Produces:
- `export function pruneEgress(db: Database, beforeTs: number, now: number): { prunedCount: number }`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/egress/egress-prune.test.ts`:
  ```ts
  import { Database } from "bun:sqlite";
  import { afterEach, beforeEach, describe, expect, test } from "bun:test";
  import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
  import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
  import { appendEgressEntry } from "./egress-ledger.ts";
  import type { EgressEntry } from "./egress-record.ts";
  import { pruneEgress } from "./egress-prune.ts";
  import { verifyEgressChain } from "./egress-verify.ts";

  function e(ts: number): EgressEntry {
    return {
      timestamp: ts,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    };
  }

  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  describe("pruneEgress", () => {
    test("deletes rows before the cutoff and reports the count", () => {
      appendEgressEntry(db, e(10));
      appendEgressEntry(db, e(20));
      appendEgressEntry(db, e(30));
      const out = pruneEgress(db, 25, 999);
      expect(out.prunedCount).toBe(2);
    });

    test("writes a continuing 'prune' tombstone row so the chain stays verifiable", () => {
      appendEgressEntry(db, e(10));
      appendEgressEntry(db, e(20));
      pruneEgress(db, 15, 999);
      const tomb = db
        .query(`SELECT source_type, method, result_status FROM egress_ledger ORDER BY id DESC LIMIT 1`)
        .get() as { source_type: string; method: string; result_status: string };
      expect(tomb.source_type).toBe("prune");
      expect(verifyEgressChain(db).ok).toBe(true);
    });

    test("pruning an empty/zero-match window still leaves a verifiable chain", () => {
      appendEgressEntry(db, e(100));
      pruneEgress(db, 0, 999); // nothing before ts 0
      expect(verifyEgressChain(db).ok).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/egress/egress-prune.test.ts` — Expected: FAIL (`./egress-prune.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/gateway/src/egress/egress-prune.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import { dbRun } from "../db/write.ts";
  import { appendEgressEntry } from "./egress-ledger.ts";

  /**
   * The ONLY sanctioned mutation of the egress ledger. Deletes whole rows with `timestamp < beforeTs`
   * then appends a continuing `source_type='prune'` tombstone (which re-chains from the surviving
   * head), so a pruned ledger reads "history before T was pruned at T by owner", never a silent gap.
   * Owner-HITL-gated upstream (the `egress.prune` action joins the I2 frozen set; the RPC consults an
   * owner-consent broker before calling this). Writes via `dbRun` (I14/D12).
   */
  export function pruneEgress(db: Database, beforeTs: number, now: number): { prunedCount: number } {
    const before = Math.floor(beforeTs);
    const matched = (db.query(`SELECT COUNT(*) as c FROM egress_ledger WHERE timestamp < ?`).get(before) as {
      c: number;
    }).c;
    dbRun(db, `DELETE FROM egress_ledger WHERE timestamp < ?`, [before]);
    appendEgressEntry(db, {
      timestamp: now,
      sourceType: "prune",
      sourceId: null,
      destination: "local",
      method: "egress.prune",
      payloadSummary: JSON.stringify({ before, prunedCount: matched }),
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    return { prunedCount: matched };
  }
  ```
  (Note: `dbExec` is not needed here — the import list is just `dbRun`. The tombstone re-chains via `appendEgressEntry`, which reads the surviving head; after a full prune the surviving head is `GENESIS_HASH`, so the tombstone correctly chains from genesis and `verifyEgressChain` stays green.)
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/egress/egress-prune.test.ts` — Expected: PASS (3 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/egress/egress-prune.ts packages/gateway/src/egress/egress-prune.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): pruneEgress — the sole mutation, writes a continuing tombstone

  Deletes pre-cutoff rows then appends a source_type='prune' tombstone that
  re-chains the head; the ledger stays verifiable (no silent gap).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: Wire the sink into the executor + the I30 invariant TRIPLE (one commit)

**Files:** Modify: `packages/gateway/src/engine/executor.ts`, `packages/gateway/src/security-invariants.test.ts`, `scripts/structure-audit/check-nimbus-invariants.ts`, `scripts/structure-audit/check-nimbus-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` · Test: `packages/gateway/src/engine/executor.test.ts` (extend), the two test files above.

**Interfaces:** Consumes (Task 3): `EgressHitlStatus`, `EgressResultStatus`, `buildEgressEntry`. Consumes (Task 4): `EgressSink`. Produces: a `ToolExecutor` whose `gate()` appends an egress row (before any dispatch) for every gate decision, and whose append-failure aborts the action.

**This is the invariant triple-rule task: wiring + docs (SECURITY-INVARIANTS.md + CLAUDE.md + GEMINI.md) + test (security-invariants.test.ts) + static check (check-nimbus-invariants.ts) ALL land here in ONE commit.**

- [ ] **Step 1: Write the failing tests.** Append to `packages/gateway/src/engine/executor.test.ts` (create a focused new describe; reuse the file's existing harness style — a stub `ConsentChannel`, `AuditSink`, `ConnectorDispatcher`):
  ```ts
  import { describe, expect, test } from "bun:test";
  import { ToolExecutor } from "./executor.ts";
  import type { EgressSink } from "../egress/egress-ledger.ts";
  import type { EgressEntry } from "../egress/egress-record.ts";
  import type { ActionResult, ConnectorDispatcher, ConsentChannel, AuditSink, PlannedAction } from "./types.ts";

  function deps(over: {
    approve?: boolean;
    onDispatch?: () => void;
    sink?: EgressSink;
  }): { consent: ConsentChannel; audit: AuditSink; connectors: ConnectorDispatcher; appended: EgressEntry[] } {
    const appended: EgressEntry[] = [];
    const consent: ConsentChannel = {
      requestApproval: async () => over.approve ?? true,
    };
    const audit: AuditSink = { recordAudit: () => {} };
    const connectors: ConnectorDispatcher = {
      dispatch: async (_a: PlannedAction) => {
        over.onDispatch?.();
        return { ok: true };
      },
    };
    return { consent, audit, connectors, appended };
  }

  describe("I30 — egress ledger append-before-dispatch (executor wiring)", () => {
    test("a row is appended BEFORE connectors.dispatch is called", async () => {
      const order: string[] = [];
      const appended: EgressEntry[] = [];
      const sink: EgressSink = { append: (e) => { order.push("append"); appended.push(e); } };
      const d = deps({ onDispatch: () => order.push("dispatch") });
      const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
      await exec.execute({ type: "search.run", payload: {} });
      expect(order).toEqual(["append", "dispatch"]);
      expect(appended[0]?.resultStatus).toBe("authorized");
    });

    test("a denied HITL action appends a blocked row and NEVER dispatches", async () => {
      const dispatched = { count: 0 };
      const appended: EgressEntry[] = [];
      const sink: EgressSink = { append: (e) => appended.push(e) };
      const d = deps({ approve: false, onDispatch: () => { dispatched.count += 1; } });
      const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
      const res: ActionResult = await exec.execute({ type: "email.send", payload: {} });
      expect(res.status).toBe("rejected");
      expect(dispatched.count).toBe(0);
      expect(appended[0]?.resultStatus).toBe("blocked");
      expect(appended[0]?.hitlStatus).toBe("rejected");
    });

    test("an append failure ABORTS the action (dispatch never runs, error propagates)", async () => {
      const dispatched = { count: 0 };
      const sink: EgressSink = { append: () => { throw new Error("ledger write failed"); } };
      const d = deps({ onDispatch: () => { dispatched.count += 1; } });
      const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
      await expect(exec.execute({ type: "search.run", payload: {} })).rejects.toThrow(/ledger write failed/);
      expect(dispatched.count).toBe(0);
    });

    test("with no sink injected, the executor still gates + dispatches (back-compat)", async () => {
      const d = deps({});
      const exec = new ToolExecutor(d.consent, d.audit, d.connectors);
      const res = await exec.execute({ type: "search.run", payload: {} });
      expect(res.status).toBe("ok");
    });
  });
  ```
  Append the I30 block to `packages/gateway/src/security-invariants.test.ts`:
  ```ts
  describe("I30 — egress-ledger completeness over the executor chokepoint", () => {
    test("egress.prune is in the I2 HITL frozen set", async () => {
      const { HITL_REQUIRED } = await import("./engine/executor.ts");
      expect(HITL_REQUIRED.has("egress.prune")).toBe(true);
    });

    test("executor.gate appends an egress row before dispatch, blocks on deny, aborts on append failure", async () => {
      const { ToolExecutor } = await import("./engine/executor.ts");
      const order: string[] = [];
      const appended: Array<{ resultStatus: string }> = [];
      const consent = { requestApproval: async () => true };
      const audit = { recordAudit: () => {} };
      const connectors = { dispatch: async () => { order.push("dispatch"); return {}; } };
      const sink = { append: (e: { resultStatus: string }) => { order.push("append"); appended.push(e); } };
      const exec = new ToolExecutor(consent, audit, connectors, undefined, sink);
      await exec.execute({ type: "search.run", payload: {} });
      expect(order).toEqual(["append", "dispatch"]);

      // deny → blocked row, no dispatch
      const order2: string[] = [];
      const denyConsent = { requestApproval: async () => false };
      const sink2 = { append: (e: { resultStatus: string }) => order2.push(e.resultStatus) };
      const connectors2 = { dispatch: async () => { order2.push("dispatch"); return {}; } };
      const exec2 = new ToolExecutor(denyConsent, audit, connectors2, undefined, sink2);
      await exec2.execute({ type: "email.send", payload: {} });
      expect(order2).toContain("blocked");
      expect(order2).not.toContain("dispatch");

      // append throws → abort
      const throwingSink = { append: () => { throw new Error("x"); } };
      const connectors3 = { dispatch: async () => ({}) };
      const exec3 = new ToolExecutor(consent, audit, connectors3, undefined, throwingSink);
      await expect(exec3.execute({ type: "search.run", payload: {} })).rejects.toThrow();
    });

    test("D23 confines connectors.dispatch to executor.ts and the egress append to egress/*", async () => {
      const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
      expect(audit).toContain("D23-connectors-dispatch");
      expect(audit).toContain("D23-egress-append");
    });

    test("the egress append symbol is NOT referenced outside egress/* and executor.ts", async () => {
      // executor wires the SINK (makeEgressSink built in assemble), not appendEgressEntry directly.
      const exec = await read("packages/gateway/src/engine/executor.ts");
      expect(exec).toContain("EgressSink");
    });
  });
  ```
  Add the D23 static-check unit test to `scripts/structure-audit/check-nimbus-invariants.test.ts` (follow the existing per-check test style — import the new function, feed a planted-violation `FileEntry[]`, assert a violation):
  ```ts
  import { describe, expect, test } from "bun:test";
  import {
    checkEgressChokepointConfinement,
    type FileEntry,
  } from "./check-nimbus-invariants.ts";

  describe("D23 — egress chokepoint confinement", () => {
    test("flags connectors.dispatch outside engine/executor.ts", () => {
      const files: FileEntry[] = [
        { relPath: "packages/gateway/src/rogue/bypass.ts", contents: "await this.connectors.dispatch(action);\n" },
      ];
      const v = checkEgressChokepointConfinement(files);
      expect(v.some((x) => x.rule === "D23-connectors-dispatch")).toBe(true);
    });

    test("allows connectors.dispatch inside engine/executor.ts", () => {
      const files: FileEntry[] = [
        { relPath: "packages/gateway/src/engine/executor.ts", contents: "await this.connectors.dispatch(action);\n" },
      ];
      expect(checkEgressChokepointConfinement(files)).toHaveLength(0);
    });

    test("flags appendEgressEntry referenced outside egress/*", () => {
      const files: FileEntry[] = [
        { relPath: "packages/gateway/src/rogue/x.ts", contents: "appendEgressEntry(db, e);\n" },
      ];
      const v = checkEgressChokepointConfinement(files);
      expect(v.some((x) => x.rule === "D23-egress-append")).toBe(true);
    });

    test("allows appendEgressEntry inside egress/*", () => {
      const files: FileEntry[] = [
        { relPath: "packages/gateway/src/egress/egress-prune.ts", contents: "appendEgressEntry(db, e);\n" },
      ];
      expect(checkEgressChokepointConfinement(files)).toHaveLength(0);
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/engine/executor.test.ts packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.test.ts` — Expected: FAIL (`ToolExecutor` has no 5th param / ignores the sink; `egress.prune` not in the set; `checkEgressChokepointConfinement` is not exported; the D23 rule strings are absent from `check-nimbus-invariants.ts`).
- [ ] **Step 3: Implement.** In `packages/gateway/src/engine/executor.ts`:
  - Add the import (top of file, after the existing imports):
    ```ts
    import type { EgressSink } from "../egress/egress-ledger.ts";
    import { buildEgressEntry } from "../egress/egress-record.ts";
    ```
  - Add `"egress.prune"` to `HITL_REQUIRED_BACKING` (immediately after `"share.publish",` near line 124):
    ```ts
      // S1 "Local Brain" — egress-ledger retention edit (the sole ledger mutation) is owner-HITL
      // gated (I2 frozen set); the egress.prune RPC consults the owner consent broker before pruning.
      "egress.prune",
    ```
  - Add the optional 5th constructor param (after `delegation?`):
    ```ts
    export class ToolExecutor {
      constructor(
        private readonly consent: ConsentChannel,
        private readonly audit: AuditSink,
        private readonly connectors: ConnectorDispatcher,
        private readonly delegation?: ExecutorDelegationDep,
        private readonly egressSink?: EgressSink,
      ) {}
    ```
  - In `gate()`, immediately AFTER the `this.audit.recordAudit({...})` call and BEFORE the `if (hitlStatus === "rejected")` return, append the egress row (so every gate decision is ledgered, regardless of caller — per Open Question 1's "write from gate()" resolution). The append throwing propagates out of `gate()` (hence out of `execute()`), aborting before any dispatch:
    ```ts
        if (this.egressSink !== undefined) {
          this.egressSink.append(
            buildEgressEntry({
              action,
              hitlStatus,
              resultStatus: hitlStatus === "rejected" ? "blocked" : "authorized",
              sessionId,
              now: Date.now(),
            }),
          );
        }
    ```
    (`sessionId` is already in scope from the `getAgentRequestSessionId()` call above the audit record.)
  - In `packages/gateway/src/index/local-index.ts` no change is needed here (done in Task 2).
  - In `scripts/structure-audit/check-nimbus-invariants.ts`, add the D23 check function (after `checkForwardShareConfinement`, before the `type Mode` line):
    ```ts
    // D23 (I30) — the executor chokepoint must be TOTAL. (a) `connectors.dispatch` (the property
    // access on the executor-injected dispatcher) may appear ONLY in engine/executor.ts — a reference
    // anywhere else would let an outbound action bypass the ledgered gate, making a 0-row window a
    // false negative. (b) the egress-ledger append symbol (`appendEgressEntry`) is confined to
    // egress/* (the write path's only home). Test files are exempt.
    const D23_DISPATCH_ALLOWED = "packages/gateway/src/engine/executor.ts";
    const D23_DISPATCH_RE = /\bconnectors\.dispatch\b/;
    const D23_APPEND_RE = /\bappendEgressEntry\b/;
    const D23_APPEND_ALLOWED_PREFIX = "packages/gateway/src/egress/";

    export function checkEgressChokepointConfinement(files: readonly FileEntry[]): Violation[] {
      const out: Violation[] = [];
      for (const f of files) {
        if (f.relPath.endsWith(".test.ts")) continue;
        const strippedLines = stripComments(f.contents).split("\n");
        const originalLines = f.contents.split("\n");
        for (let i = 0; i < strippedLines.length; i++) {
          const line = strippedLines[i] ?? "";
          if (D23_DISPATCH_RE.test(line) && f.relPath !== D23_DISPATCH_ALLOWED) {
            out.push({
              rule: "D23-connectors-dispatch",
              file: f.relPath,
              line: i + 1,
              snippet: (originalLines[i] ?? "").trim(),
            });
          }
          if (D23_APPEND_RE.test(line) && !f.relPath.startsWith(D23_APPEND_ALLOWED_PREFIX)) {
            out.push({
              rule: "D23-egress-append",
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
    Wire it into `run()` alongside the other `binary-only`/`all` checks (after the `checkForwardShareConfinement` block, before the `db-run` block):
    ```ts
      if (mode === "binary-only" || mode === "all") {
        const v = checkEgressChokepointConfinement(files);
        for (const e of v) {
          console.error(
            `::error file=${e.file},line=${e.line}::D23 egress chokepoint breach (connectors.dispatch outside executor.ts, or appendEgressEntry outside egress/) — bypasses I30: ${e.snippet}`,
          );
        }
        if (v.length > 0) exit = 1;
      }
    ```
  - In `docs/SECURITY-INVARIANTS.md`, add the I30 row (mirror the I27 entry's structure: wiring + test + static complement). Place it after the I27 row.
  - In `CLAUDE.md` AND `GEMINI.md`, add the I30 bullet to the invariant list (after the I27 bullet) and append `, I30 (D23)` to the "Static complement" paragraph's enumerated rule list:
    ```
    - **I30** — egress-ledger completeness over the executor chokepoint: every gated action appends one `egress_ledger` row before `connectors.dispatch` (blocked row on deny; append failure aborts); BLAKE3-chained, append-only, timing-safe verify (I10); the sole mutation is HITL-gated `egress.prune` (continuing tombstone). D23 confines `connectors.dispatch` to `executor.ts` + the append to `egress/*` · `engine/executor.ts`, `egress/*`
    ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/engine/executor.test.ts packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.test.ts` — Expected: PASS. Then run the static audit binary to confirm the live tree is clean: `bun scripts/structure-audit/check-nimbus-invariants.ts --binary-only` — Expected: exit 0, no `D23` errors printed.
- [ ] **Step 5: Commit** (the whole triple in one commit) —
  ```
  git add packages/gateway/src/engine/executor.ts packages/gateway/src/engine/executor.test.ts \
          packages/gateway/src/security-invariants.test.ts \
          scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.test.ts \
          docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
  git commit -m "$(cat <<'EOF'
  feat(egress): I30 + D23 — egress-ledger completeness over the executor chokepoint

  Append-before-dispatch wiring in ToolExecutor.gate (blocked row on deny;
  append failure aborts), egress.prune joins the I2 frozen set, the I30 test
  trio, the D23 static check (connectors.dispatch confined to executor.ts;
  appendEgressEntry confined to egress/*), and the SECURITY-INVARIANTS.md +
  CLAUDE.md + GEMINI.md rows — the invariant triple in one commit.

  Pre-impl acceptance gate (Task 1): the only connectors.dispatch reference is
  executor.ts:303; all other .dispatch(action) occurrences are interface
  declarations, ConnectorDispatcher implementations, or the connectors/-internal
  decorator delegation (inner.dispatch) — the chokepoint is already total.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: Sign a window digest with the Vault-only share keypair

**Files:** Create: `packages/gateway/src/egress/egress-sign.ts`, `packages/gateway/src/egress/egress-sign.test.ts`

**Interfaces:** Consumes (existing): `ensureShareKeypair(vault): Promise<{ privkeyB64; pubkeyB64 }>` from `share/share-keypair.ts`; `decodeBase64`, `encodeBase64` from `@nimbus-dev/sdk`; `nacl` from `tweetnacl`; `NimbusVault` from `vault/nimbus-vault.ts`. Produces:
- `export async function signWindowDigest(vault: NimbusVault, digest: string): Promise<{ sigB64: string; pubkeyB64: string }>`
- `export function digestEgressWindow(rows: readonly { rowHash: string }[]): string`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/egress/egress-sign.test.ts`:
  ```ts
  import { describe, expect, test } from "bun:test";
  import { decodeBase64 } from "@nimbus-dev/sdk";
  import nacl from "tweetnacl";
  import { digestEgressWindow, signWindowDigest } from "./egress-sign.ts";

  /** A minimal in-memory NimbusVault stand-in (only get/set are exercised). */
  function fakeVault(): { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<void> } {
    const m = new Map<string, string>();
    return {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
    };
  }

  describe("digestEgressWindow", () => {
    test("is a stable 64-char hex over the row hashes", () => {
      const d1 = digestEgressWindow([{ rowHash: "a".repeat(64) }, { rowHash: "b".repeat(64) }]);
      const d2 = digestEgressWindow([{ rowHash: "a".repeat(64) }, { rowHash: "b".repeat(64) }]);
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("signWindowDigest", () => {
    test("produces a signature that verifies against the returned pubkey", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test stand-in for NimbusVault
      const vault = fakeVault() as any;
      const digest = digestEgressWindow([{ rowHash: "c".repeat(64) }]);
      const { sigB64, pubkeyB64 } = await signWindowDigest(vault, digest);
      const ok = nacl.sign.detached.verify(
        new TextEncoder().encode(digest),
        decodeBase64(sigB64),
        decodeBase64(pubkeyB64),
      );
      expect(ok).toBe(true);
    });

    test("never returns the private key material", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test stand-in for NimbusVault
      const vault = fakeVault() as any;
      const out = await signWindowDigest(vault, digestEgressWindow([{ rowHash: "d".repeat(64) }]));
      expect(Object.keys(out).sort()).toEqual(["pubkeyB64", "sigB64"]);
      expect(JSON.stringify(out)).not.toContain("privkey");
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/egress/egress-sign.test.ts` — Expected: FAIL (`./egress-sign.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/gateway/src/egress/egress-sign.ts`:
  ```ts
  import { blake3 } from "@noble/hashes/blake3.js";
  import { bytesToHex } from "@noble/hashes/utils.js";
  import { decodeBase64, encodeBase64 } from "@nimbus-dev/sdk";
  import nacl from "tweetnacl";
  import { ensureShareKeypair } from "../share/share-keypair.ts";
  import type { NimbusVault } from "../vault/nimbus-vault.ts";

  /** A stable BLAKE3 digest over a window's ordered row hashes — the thing the receipt signs. */
  export function digestEgressWindow(rows: readonly { rowHash: string }[]): string {
    const encoder = new TextEncoder();
    return bytesToHex(blake3(encoder.encode(rows.map((r) => r.rowHash).join("|"))));
  }

  /**
   * Sign a window digest with the Vault-only Ed25519 share keypair (reused — no new Vault key). The
   * private seed is read inside `ensureShareKeypair` solely to thread into the in-process signing
   * call; it is NEVER returned. The result carries only the detached signature + the public key
   * (safe to surface). This is a LOCAL receipt — not the portable EAF artifact (deferred to Phase 22).
   */
  export async function signWindowDigest(
    vault: NimbusVault,
    digest: string,
  ): Promise<{ sigB64: string; pubkeyB64: string }> {
    const { privkeyB64, pubkeyB64 } = await ensureShareKeypair(vault);
    const seed = decodeBase64(privkeyB64);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const sig = nacl.sign.detached(new TextEncoder().encode(digest), kp.secretKey);
    return { sigB64: encodeBase64(sig), pubkeyB64 };
  }
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/egress/egress-sign.test.ts` — Expected: PASS (3 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/egress/egress-sign.ts packages/gateway/src/egress/egress-sign.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): signWindowDigest — local receipt via the Vault-only share keypair

  Reuses ensureShareKeypair (no new Vault key); returns only the detached
  signature + pubkey — the private seed never leaves the Vault.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 9: `egress.*` IPC handler

**Files:** Create: `packages/gateway/src/ipc/egress-rpc.ts`, `packages/gateway/src/ipc/egress-rpc.test.ts`

**Interfaces:** Consumes (existing): `dispatchByMethod`, `RpcMissOrHit` from `ipc/_lib/dispatch-by-method.ts`; `Database` from `bun:sqlite`; `NimbusVault`. Consumes (Task 5): `verifyEgressChain`, `listEgress`, `egressHead`, `proveWindow`. Consumes (Task 6): `pruneEgress`. Consumes (Task 8): `signWindowDigest`, `digestEgressWindow`. Produces:
- `export interface EgressRpcCtx { db: Database; vault: NimbusVault; now: () => number; requestPruneApproval: (beforeTs: number) => Promise<boolean> }`
- `export class EgressRpcError extends Error { rpcCode: number }`
- `export async function dispatchEgressRpc(method, params, ctx): Promise<RpcMissOrHit>`

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/ipc/egress-rpc.test.ts`:
  ```ts
  import { Database } from "bun:sqlite";
  import { afterEach, beforeEach, describe, expect, test } from "bun:test";
  import { appendEgressEntry } from "../egress/egress-ledger.ts";
  import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
  import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
  import { dispatchEgressRpc, type EgressRpcCtx } from "./egress-rpc.ts";

  function fakeVault() {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); } };
  }

  let db: Database;
  function ctx(over: Partial<EgressRpcCtx> = {}): EgressRpcCtx {
    return {
      db,
      // biome-ignore lint/suspicious/noExplicitAny: test stand-in
      vault: fakeVault() as any,
      now: () => 12345,
      requestPruneApproval: async () => true,
      ...over,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    appendEgressEntry(db, {
      timestamp: 100, sourceType: "task", sourceId: "s", destination: "email",
      method: "email.send", payloadSummary: "{}", hitlStatus: "approved", resultStatus: "authorized",
    });
  });
  afterEach(() => db.close());

  describe("dispatchEgressRpc", () => {
    test("unknown method misses", async () => {
      expect(await dispatchEgressRpc("egress.nope", {}, ctx())).toEqual({ kind: "miss" });
    });
    test("egress.head returns the head + count", async () => {
      const out = await dispatchEgressRpc("egress.head", {}, ctx());
      expect(out.kind).toBe("hit");
      const v = (out as { kind: "hit"; value: { head: string; count: number } }).value;
      expect(v.count).toBe(1);
    });
    test("egress.list returns rows", async () => {
      const out = await dispatchEgressRpc("egress.list", {}, ctx());
      const v = (out as { kind: "hit"; value: { rows: unknown[] } }).value;
      expect(v.rows).toHaveLength(1);
    });
    test("egress.verify returns ok on a clean chain", async () => {
      const out = await dispatchEgressRpc("egress.verify", {}, ctx());
      const v = (out as { kind: "hit"; value: { ok: boolean } }).value;
      expect(v.ok).toBe(true);
    });
    test("egress.proveWindow includes completeness + verify, and a receipt only when sign:true", async () => {
      const noSign = await dispatchEgressRpc("egress.proveWindow", { since: 0, until: 1000 }, ctx());
      const nv = (noSign as { kind: "hit"; value: Record<string, unknown> }).value;
      expect(nv["receipt"]).toBeUndefined();
      const signed = await dispatchEgressRpc("egress.proveWindow", { since: 0, until: 1000, sign: true }, ctx());
      const sv = (signed as { kind: "hit"; value: { receipt: { sigB64: string } } }).value;
      expect(typeof sv.receipt.sigB64).toBe("string");
    });
    test("egress.prune routes through the approval broker (denied → not pruned)", async () => {
      const denied = await dispatchEgressRpc("egress.prune", { beforeTs: 9999 }, ctx({ requestPruneApproval: async () => false }));
      const dv = (denied as { kind: "hit"; value: { prunedCount: number; approved: boolean } }).value;
      expect(dv.approved).toBe(false);
      expect(dv.prunedCount).toBe(0);
    });
    test("egress.prune with approval prunes and reports the count", async () => {
      const out = await dispatchEgressRpc("egress.prune", { beforeTs: 9999 }, ctx());
      const v = (out as { kind: "hit"; value: { prunedCount: number; approved: boolean } }).value;
      expect(v.approved).toBe(true);
      expect(v.prunedCount).toBe(1);
    });
    test("egress.prune rejects a non-integer beforeTs", async () => {
      await expect(dispatchEgressRpc("egress.prune", { beforeTs: "x" }, ctx())).rejects.toThrow(/beforeTs/);
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/ipc/egress-rpc.test.ts` — Expected: FAIL (`./egress-rpc.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/gateway/src/ipc/egress-rpc.ts`:
  ```ts
  import type { Database } from "bun:sqlite";
  import { digestEgressWindow, signWindowDigest } from "../egress/egress-sign.ts";
  import { egressHead, listEgress, proveWindow, verifyEgressChain } from "../egress/egress-verify.ts";
  import { pruneEgress } from "../egress/egress-prune.ts";
  import { asRecord } from "../connectors/unknown-record.ts";
  import type { NimbusVault } from "../vault/nimbus-vault.ts";
  import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

  export class EgressRpcError extends Error {
    readonly rpcCode: number;
    constructor(rpcCode: number, message: string) {
      super(message);
      this.name = "EgressRpcError";
      this.rpcCode = rpcCode;
    }
  }

  export interface EgressRpcCtx {
    readonly db: Database;
    readonly vault: NimbusVault;
    readonly now: () => number;
    /** Owner-HITL approval for the sole mutation (egress.prune). Denied/timed-out → nothing pruned. */
    readonly requestPruneApproval: (beforeTs: number) => Promise<boolean>;
  }

  function optInt(params: unknown, key: string): number | undefined {
    const rec = asRecord(params);
    if (rec === undefined || !(key in rec)) return undefined;
    const v = rec[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new EgressRpcError(-32602, `egress: ${key} must be a non-negative integer`);
    }
    return v;
  }

  function reqInt(params: unknown, key: string): number {
    const v = optInt(params, key);
    if (v === undefined) throw new EgressRpcError(-32602, `egress: ${key} (non-negative integer) required`);
    return v;
  }

  function handleList(params: unknown, ctx: EgressRpcCtx): { rows: ReturnType<typeof listEgress> } {
    return {
      rows: listEgress(ctx.db, {
        since: optInt(params, "since"),
        until: optInt(params, "until"),
        limit: optInt(params, "limit"),
      }),
    };
  }

  function handleVerify(_p: unknown, ctx: EgressRpcCtx): ReturnType<typeof verifyEgressChain> {
    return verifyEgressChain(ctx.db);
  }

  function handleHead(_p: unknown, ctx: EgressRpcCtx): ReturnType<typeof egressHead> {
    return egressHead(ctx.db);
  }

  async function handleProveWindow(
    params: unknown,
    ctx: EgressRpcCtx,
  ): Promise<ReturnType<typeof proveWindow> & { receipt?: { sigB64: string; pubkeyB64: string; digest: string } }> {
    const window = proveWindow(ctx.db, { since: optInt(params, "since"), until: optInt(params, "until") });
    const rec = asRecord(params);
    const sign = rec !== undefined && rec["sign"] === true;
    if (!sign) return window;
    const digest = digestEgressWindow(window.rows);
    const { sigB64, pubkeyB64 } = await signWindowDigest(ctx.vault, digest);
    return { ...window, receipt: { sigB64, pubkeyB64, digest } };
  }

  async function handlePrune(
    params: unknown,
    ctx: EgressRpcCtx,
  ): Promise<{ approved: boolean; prunedCount: number }> {
    const beforeTs = reqInt(params, "beforeTs");
    const approved = await ctx.requestPruneApproval(beforeTs);
    if (!approved) return { approved: false, prunedCount: 0 };
    const { prunedCount } = pruneEgress(ctx.db, beforeTs, ctx.now());
    return { approved: true, prunedCount };
  }

  export async function dispatchEgressRpc(
    method: string,
    params: unknown,
    ctx: EgressRpcCtx,
  ): Promise<RpcMissOrHit> {
    return dispatchByMethod<EgressRpcCtx>(method, params, ctx, {
      "egress.list": handleList,
      "egress.verify": handleVerify,
      "egress.head": handleHead,
      "egress.proveWindow": handleProveWindow,
      "egress.prune": handlePrune,
    });
  }
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/ipc/egress-rpc.test.ts` — Expected: PASS (8 tests).
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/ipc/egress-rpc.ts packages/gateway/src/ipc/egress-rpc.test.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): egress.* IPC handler (list/verify/head/proveWindow/prune)

  Read verbs are pure reads; proveWindow signs only on sign:true; prune routes
  through the injected owner-HITL approval broker (denied → nothing pruned).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 10: Wire the egress RPC into the dispatcher chain + Tauri read-only allowlist

**Files:** Modify: `packages/gateway/src/ipc/server/dispatchers.ts`, `packages/gateway/src/ipc/server/options.ts`, `packages/ui/src-tauri/src/gateway_bridge.rs` · Test: extend `packages/gateway/src/ipc/server/dispatchers.test.ts`; the Tauri tests live inline in `gateway_bridge.rs`.

**Interfaces:** Consumes (Task 9): `dispatchEgressRpc`, `EgressRpcError`, `EgressRpcCtx`. Produces: `tryDispatchEgressRpc(ctx, method, params): Promise<unknown>` (mirrors `tryDispatchShareRpc`).

- [ ] **Step 1: Write the failing test.** Add to `packages/gateway/src/ipc/server/dispatchers.test.ts` (follow the existing `tryDispatchShareRpc` test style — `makeCtx` with the new `egressRpcCtx`):
  ```ts
  describe("tryDispatchEgressRpc", () => {
    test("skips a non-egress method", async () => {
      const { ctx } = makeCtx();
      expect(await tryDispatchEgressRpc(ctx, "engine.ask", {})).toBe(phase4RpcSkipped);
    });
    test("skips when egressRpcCtx is not wired", async () => {
      const { ctx } = makeCtx();
      expect(await tryDispatchEgressRpc(ctx, "egress.head", {})).toBe(phase4RpcSkipped);
    });
    test("dispatches egress.head when wired", async () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const egressRpcCtx = {
        db,
        // biome-ignore lint/suspicious/noExplicitAny: test stand-in
        vault: { get: async () => null, set: async () => {} } as any,
        now: () => 1,
        requestPruneApproval: async () => false,
      };
      const { ctx } = makeCtx({ egressRpcCtx });
      const out = (await tryDispatchEgressRpc(ctx, "egress.head", {})) as { count: number };
      expect(out.count).toBe(0);
    });
  });
  ```
  Add the Tauri assertions to `packages/ui/src-tauri/src/gateway_bridge.rs` (in the test module, alongside the existing share/audit asserts; update the count assertion):
  ```rust
  assert!(is_method_allowed("egress.head"));
  assert!(is_method_allowed("egress.list"));
  assert!(is_method_allowed("egress.verify"));
  assert!(is_method_allowed("egress.proveWindow"));
  assert!(!is_method_allowed("egress.prune"));
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/ipc/server/dispatchers.test.ts` — Expected: FAIL (`tryDispatchEgressRpc` is not exported; `egressRpcCtx` is not on the options type). (The Rust test fails on `cargo test` — see Step 4.)
- [ ] **Step 3: Implement.**
  - In `packages/gateway/src/ipc/server/options.ts`, add the import + field (near the other RPC-ctx fields like `shareRpcCtx`):
    ```ts
    import type { EgressRpcCtx } from "../egress-rpc.ts";
    // ... inside the options interface:
    egressRpcCtx?: EgressRpcCtx;
    ```
  - In `packages/gateway/src/ipc/server/dispatchers.ts`, add the import (alongside `dispatchShareRpc`):
    ```ts
    import { dispatchEgressRpc, EgressRpcError } from "../egress-rpc.ts";
    ```
    Add the `try*` function (mirror `tryDispatchShareRpc`, ~line 802):
    ```ts
    export async function tryDispatchEgressRpc(
      ctx: ServerCtx,
      method: string,
      params: unknown,
    ): Promise<unknown> {
      if (!method.startsWith("egress.")) return phase4RpcSkipped;
      const rpc = ctx.options.egressRpcCtx;
      if (rpc === undefined) return phase4RpcSkipped;
      try {
        const out = await dispatchEgressRpc(method, params, rpc);
        if (out.kind === "hit") return out.value;
      } catch (e) {
        if (e instanceof EgressRpcError) throw new RpcMethodError(e.rpcCode, e.message);
        throw e;
      }
      return phase4RpcSkipped;
    }
    ```
    Wire it into the phase-4 chain immediately before `tryDispatchAdminRpc` (~line 893, where `tryDispatchShareRpc` is called):
    ```ts
      const egressOutcome = await tryDispatchEgressRpc(ctx, method, params);
      if (egressOutcome !== phase4RpcSkipped) return egressOutcome;
    ```
  - In `packages/ui/src-tauri/src/gateway_bridge.rs`, insert the 4 read verbs into `ALLOWED_METHODS` in alphabetical order (they sort after `"diag.snapshot"` and before `"engine.askStream"`):
    ```rust
        "diag.snapshot",
        "egress.head",
        "egress.list",
        "egress.proveWindow",
        "egress.verify",
        "engine.askStream",
    ```
    Bump the count assertion from `95` to `99`:
    ```rust
            assert_eq!(ALLOWED_METHODS.len(), 99);
    ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/ipc/server/dispatchers.test.ts` — Expected: PASS. Then the Rust allowlist test: `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist` — Expected: PASS (count is 99, alphabetized, `egress.prune` absent). (If `cargo` is unavailable locally, the CI cross-platform job covers it; verify the array is alphabetized and `egress.prune` is NOT present by inspection.)
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/options.ts \
          packages/gateway/src/ipc/server/dispatchers.test.ts packages/ui/src-tauri/src/gateway_bridge.rs
  git commit -m "$(cat <<'EOF'
  feat(egress): wire egress.* into the IPC dispatcher chain + Tauri read allowlist

  tryDispatchEgressRpc mirrors tryDispatchShareRpc; the 4 read verbs join
  ALLOWED_METHODS (count 95->99); egress.prune is NOT renderer-exposed (I7).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 11: Boot wiring — build `egressRpcCtx` + the executor sink in assemble.ts

**Files:** Modify: `packages/gateway/src/platform/assemble.ts` (and wherever the `ToolExecutor` is constructed + the server options are built). Test: a focused assemble test if one exists for the share ctx; otherwise the e2e in Task 12 covers it.

**Interfaces:** Consumes (Task 4): `makeEgressSink`. Consumes (Task 9): `EgressRpcCtx`. Produces: a `ToolExecutor` constructed with the egress sink; an `egressRpcCtx` passed into the IPC server options.

- [ ] **Step 1: Find the wiring sites.** Run:
  ```
  bun run --bun rg -n "new ToolExecutor\(" packages/gateway/src
  bun run --bun rg -n "shareRpcCtx:" packages/gateway/src/platform/assemble.ts
  ```
  **Expected:** the `new ToolExecutor(...)` construction site(s) and the `shareRpcCtx:` option assignment (the model to mirror for `egressRpcCtx:`).
- [ ] **Step 2: Write/extend the failing test.** If `platform/assemble.ts` has a companion test that asserts the share ctx is wired, add an analogous assertion that `egressRpcCtx` is present and that the constructed `ToolExecutor` received a sink. If no such test exists, mark this task verified by the Task 12 e2e (an `egress.head` call over a real gateway must return `count: 0`, which only works if `egressRpcCtx` is wired). Prefer adding a minimal unit assertion:
  ```ts
  // in the nearest assemble/server-options test:
  test("egressRpcCtx is wired into the IPC server options", () => {
    const opts = buildServerOptionsForTest(/* existing test harness */);
    expect(opts.egressRpcCtx).toBeDefined();
    expect(opts.egressRpcCtx?.db).toBeDefined();
  });
  ```
  (Use the assemble/options test harness already present in the repo; if none, rely on Task 12.)
- [ ] **Step 3: Implement.** In `packages/gateway/src/platform/assemble.ts`:
  - Import the sink + ctx builders:
    ```ts
    import { makeEgressSink } from "../egress/egress-ledger.ts";
    import type { EgressRpcCtx } from "../ipc/egress-rpc.ts";
    ```
  - At the `ToolExecutor` construction site, pass the sink as the 5th argument (the db is the LocalIndex DB already in scope at assemble time):
    ```ts
    const egressSink = makeEgressSink(localIndex.getDatabase());
    const executor = new ToolExecutor(consentChannel, auditSink, dispatcher, delegationDep, egressSink);
    ```
    (Match the exact identifiers used at the real construction site found in Step 1 — `consentChannel`/`auditSink`/`dispatcher`/`delegationDep` are placeholders for the local variable names already present there.)
  - Build the `egressRpcCtx` and assign it into the IPC server options (mirror the `shareRpcCtx:` assignment), reusing the same owner-consent broker the share gate uses for `requestApproval` so prune is fail-closed:
    ```ts
    const egressRpcCtx: EgressRpcCtx = {
      db: localIndex.getDatabase(),
      vault,
      now: () => Date.now(),
      requestPruneApproval: async (beforeTs) =>
        shareConsent.request(
          `Prune the egress ledger of all rows before ${new Date(beforeTs).toISOString()}? This is the only sanctioned mutation; a continuing tombstone is written.`,
        ),
    };
    ipcOpts.egressRpcCtx = egressRpcCtx;
    ```
    (Use the actual owner-consent broker identifier present in assemble — the same one wired as `createShare`'s `requestApproval` per D21. If the broker's method signature differs, adapt the call to return a `Promise<boolean>`.)
- [ ] **Step 4: Run it to verify it passes** — Run the nearest assemble/options test, e.g. `bun test packages/gateway/src/platform/assemble.test.ts` (or the file found in Step 1) — Expected: PASS. Then a full typecheck of the package: `bun run --cwd packages/gateway typecheck` (or `bunx tsc --noEmit -p packages/gateway/tsconfig.json`) — Expected: no errors.
- [ ] **Step 5: Commit** —
  ```
  git add packages/gateway/src/platform/assemble.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): boot wiring — executor egress sink + egressRpcCtx in assemble

  ToolExecutor gets makeEgressSink(localIndex db); egress.prune approval routes
  through the same fail-closed owner-consent broker as the share gate.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 12: `nimbus prove` / `nimbus egress` CLI

**Files:** Create: `packages/cli/src/commands/prove.ts`, `packages/cli/src/commands/prove.test.ts` · Modify: `packages/cli/src/index.ts`

**Interfaces:** Consumes (existing): `IPCClient` from `../ipc-client/index.ts`; `readGatewayState`, `getCliPlatformPaths` (the `withIpc` helper pattern from `audit.ts`). Consumes (over IPC): `egress.head`, `egress.list`, `egress.verify`, `egress.proveWindow`, `egress.prune`. Produces:
- `export async function runProve(args: string[]): Promise<void>`
- `export async function runEgress(args: string[]): Promise<void>`
- `export async function runEgressVerify(client: IPCClient): Promise<void>` (DI'd client for unit tests)
- `export async function runEgressReport(client: IPCClient, opts: { since?: number; json: boolean; sign: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing test** — `packages/cli/src/commands/prove.test.ts` (inject a fake `IPCClient`; do NOT spawn a gateway here):
  ```ts
  import { describe, expect, test } from "bun:test";
  import { runEgressReport, runEgressVerify } from "./prove.ts";

  type Call = { method: string; params: unknown };

  function fakeClient(responses: Record<string, unknown>): {
    calls: Call[];
    call: <T>(method: string, params: unknown) => Promise<T>;
  } {
    const calls: Call[] = [];
    return {
      calls,
      call: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        return responses[method] as T;
      },
    };
  }

  describe("runEgressVerify", () => {
    test("exit code 0 on a clean chain", async () => {
      process.exitCode = 0;
      // biome-ignore lint/suspicious/noExplicitAny: fake client
      const c = fakeClient({ "egress.verify": { ok: true, verifiedRows: 3 } }) as any;
      await runEgressVerify(c);
      expect(process.exitCode).toBe(0);
    });
    test("exit code 1 on a tampered chain", async () => {
      process.exitCode = 0;
      // biome-ignore lint/suspicious/noExplicitAny: fake client
      const c = fakeClient({ "egress.verify": { ok: false, brokenAt: 7, reason: "row_hash mismatch at id 7" } }) as any;
      await runEgressVerify(c);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });
  });

  describe("runEgressReport", () => {
    test("calls egress.proveWindow with sign when --sign is passed", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: fake client
      const c = fakeClient({
        "egress.proveWindow": { rows: [], completeness: { tier: "authorized-actions", outboundEgressEvents: 0 }, verify: { ok: true } },
      }) as any;
      await runEgressReport(c, { json: false, sign: true });
      expect(c.calls[0]?.method).toBe("egress.proveWindow");
      expect((c.calls[0]?.params as { sign?: boolean }).sign).toBe(true);
    });
  });
  ```
- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/cli/src/commands/prove.test.ts` — Expected: FAIL (`./prove.ts` does not exist).
- [ ] **Step 3: Implement** — `packages/cli/src/commands/prove.ts`:
  ```ts
  import { IPCClient } from "../ipc-client/index.ts";
  import { readGatewayState } from "../lib/gateway-process.ts";
  import { getCliPlatformPaths } from "../paths.ts";

  type VerifyResult = { ok: boolean; verifiedRows: number; brokenAt?: number; reason?: string };
  type EgressRow = { timestamp: number; destination: string; method: string; resultStatus: string };
  type ProveResult = {
    rows: EgressRow[];
    completeness: { tier: string; outboundEgressEvents: number };
    verify: VerifyResult;
    receipt?: { sigB64: string; pubkeyB64: string; digest: string };
  };
  type Head = { head: string; count: number };

  async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
    const paths = getCliPlatformPaths();
    const state = await readGatewayState(paths);
    if (state === undefined) {
      throw new Error("Gateway is not running. Start with: nimbus start");
    }
    const client = new IPCClient(state.socketPath);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.disconnect();
    }
  }

  /** Parse `--since <dur>` (e.g. 24h, 30m, 7d) into an epoch-ms lower bound relative to now. */
  function parseSince(args: string[]): number | undefined {
    const i = args.indexOf("--since");
    if (i < 0) return undefined;
    const raw = args[i + 1];
    if (raw === undefined) return undefined;
    const m = /^(\d+)([smhd])$/.exec(raw);
    if (m === null) return undefined;
    const n = Number.parseInt(m[1] as string, 10);
    const unit = m[2] as string;
    const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * ms;
  }

  export async function runEgressVerify(client: IPCClient): Promise<void> {
    const out = await client.call<VerifyResult>("egress.verify", {});
    if (out.ok) {
      console.log(`[ok]   egress chain integrity — ${String(out.verifiedRows)} rows verified`);
      process.exitCode = 0;
    } else {
      console.log(`[FAIL] egress chain break at row ${String(out.brokenAt)}: ${out.reason ?? "unknown"}`);
      process.exitCode = 1;
    }
  }

  export async function runEgressReport(
    client: IPCClient,
    opts: { since?: number; json?: boolean; sign?: boolean },
  ): Promise<void> {
    const params: Record<string, unknown> = {};
    if (opts.since !== undefined) params["since"] = opts.since;
    if (opts.sign === true) params["sign"] = true;
    const out = await client.call<ProveResult>("egress.proveWindow", params);
    if (opts.json === true) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    if (!out.verify.ok) {
      console.log(`indeterminate — egress chain is unverifiable (break at row ${String(out.verify.brokenAt)})`);
      process.exitCode = 1;
      return;
    }
    console.log(`outbound egress events: ${String(out.completeness.outboundEgressEvents)} (tier: ${out.completeness.tier})`);
    for (const r of out.rows) {
      const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
      console.log(`  ${ts}  ${r.method.padEnd(28)} ${r.resultStatus}`);
    }
    if (out.receipt !== undefined) {
      console.log(`receipt: digest=${out.receipt.digest} sig=${out.receipt.sigB64.slice(0, 16)}…`);
    }
  }

  /** `nimbus prove "<query>"` — snapshot head, run the query, print the diff (before/after). */
  export async function runProve(args: string[]): Promise<void> {
    const sign = args.includes("--receipt") || args.includes("--sign");
    const query = args.find((a) => !a.startsWith("--"));
    await withIpc(async (client) => {
      const before = await client.call<Head>("egress.head", {});
      if (query !== undefined && query !== "") {
        // The blocking ask path (mirrors `nimbus ask` in commands/ask.ts): agent.invoke with
        // stream:false returns { reply }. We only need the round-trip so the ledger head advances.
        await client.call("agent.invoke", { input: query, stream: false });
      }
      const after = await client.call<Head>("egress.head", {});
      const delta = after.count - before.count;
      if (delta === 0) {
        console.log(`outbound egress events during this query: 0 ✓`);
      } else {
        console.log(`outbound egress events during this query: ${String(delta)}`);
        await runEgressReport(client, { json: false, sign });
      }
    });
  }

  /** `nimbus egress [verify] [--since <dur>] [--json] [--sign]` — the report / offline verify. */
  export async function runEgress(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    if (sub === "verify") {
      await withIpc((c) => runEgressVerify(c));
      return;
    }
    if (sub === "prune") {
      const i = rest.indexOf("--before");
      const dateStr = i >= 0 ? rest[i + 1] : undefined;
      if (dateStr === undefined) {
        throw new Error("Usage: nimbus egress prune --before <ISO-date>");
      }
      const beforeTs = Date.parse(dateStr);
      if (Number.isNaN(beforeTs)) {
        throw new Error(`Invalid --before date: ${dateStr}`);
      }
      await withIpc(async (c) => {
        const out = await c.call<{ approved: boolean; prunedCount: number }>("egress.prune", { beforeTs });
        console.log(
          out.approved
            ? `[ok] pruned ${String(out.prunedCount)} egress rows (tombstone written)`
            : `[denied] prune not approved — nothing removed`,
        );
      });
      return;
    }
    const since = parseSince(args);
    const json = args.includes("--json");
    const signFlag = args.includes("--sign");
    await withIpc((c) => runEgressReport(c, { since, json, sign: signFlag }));
  }
  ```
  Register in `packages/cli/src/index.ts` — add the imports (near `runShare`) and the two handler entries (in `COMMAND_HANDLERS`, after `share: runShare,`):
  ```ts
  import { runEgress, runProve } from "./commands/prove.ts";
  // ... in COMMAND_HANDLERS:
    prove: runProve,
    egress: runEgress,
  ```
- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/cli/src/commands/prove.test.ts` — Expected: PASS (3 tests). Then typecheck the CLI package: `bunx tsc --noEmit -p packages/cli/tsconfig.json` — Expected: no errors.
- [ ] **Step 5: Commit** —
  ```
  git add packages/cli/src/commands/prove.ts packages/cli/src/commands/prove.test.ts packages/cli/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(egress): nimbus prove + nimbus egress CLI (report / verify / prune)

  prove snapshots the ledger head before/after a query and prints the diff
  (0 -> the headline negative); egress {verify,prune,--since,--json,--sign}.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 13: docs/CHANGELOG entry + final preflight

**Files:** Modify: `docs/CHANGELOG.md`

**Interfaces:** (none — documentation + verification only)

- [ ] **Step 1: Add the CHANGELOG entry.** Prepend a dated entry under the current unreleased/most-recent section of `docs/CHANGELOG.md` (match the file's existing date-heading + bullet format):
  ```markdown
  ### 2026-06-20 — Egress Ledger & `nimbus prove` (S1 "Local Brain")

  - **Egress ledger (V44 `egress_ledger`):** an always-on, append-only, BLAKE3-chained ledger of every authorized outbound action, written from `ToolExecutor.gate()` BEFORE `connectors.dispatch()` (a denied action records a `result_status='blocked'` row; an append failure aborts the action, fail-closed).
  - **Invariant I30 + static complement D23:** the executor chokepoint is made total — `connectors.dispatch` is confined to `engine/executor.ts` and the ledger append to `egress/*`, so a `0`-row window is a sound negative. I28 reserved (MCP-server owner-sink).
  - **`nimbus prove "<query>"`** shows the ledger before/after a query (`outbound egress events: 0 ✓` for a local-only query); **`nimbus egress [verify|prune|--since|--json|--sign]`** is the report / offline chain-verify / HITL-gated retention control. The 4 read verbs are renderer-exposed (I7); `egress.prune` is not.
  - Receipt signing reuses the Vault-only Ed25519 share keypair (no new Vault key; private seed never leaves the Vault). The external/auditor-grade signed export remains deferred to Phase 12.5.
  ```
- [ ] **Step 2: Run the full per-file coverage floor + preflight.** Run:
  ```
  bun run preflight:fast
  ```
  Expected: PASS (types, Biome, static rules incl. D23, `audit:doc-refs`). Then the full suite for the touched subsystems:
  ```
  bun test packages/gateway/src/egress packages/gateway/src/ipc/egress-rpc.test.ts \
           packages/gateway/src/engine/executor.test.ts packages/gateway/src/security-invariants.test.ts \
           packages/gateway/src/index/migrations/runner-v44.test.ts packages/cli/src/commands/prove.test.ts \
           scripts/structure-audit/check-nimbus-invariants.test.ts
  ```
  Expected: all PASS.
- [ ] **Step 3: Verify the coverage floor (CI-Linux-authoritative).** Run the repo's coverage-floor gate (e.g. `bun run audit:coverage-floor` or the documented `build-lcov.sh` + `check.ts` flow) and confirm every new `egress/*`, `ipc/egress-rpc.ts`, and `cli/.../prove.ts` file clears ≥80% line+branch. If any file is below, add the missing-arm unit tests in its `*.test.ts` before proceeding. Expected: no `below_floor` violations for the new files.
- [ ] **Step 4: Full preflight.** Run:
  ```
  bun run preflight
  ```
  Expected: GREEN. Fix any failure locally before considering the slice done (do not push red).
- [ ] **Step 5: Commit** —
  ```
  git add docs/CHANGELOG.md
  git commit -m "$(cat <<'EOF'
  docs(egress): CHANGELOG — Egress Ledger & nimbus prove (S1 Local Brain)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review (writing-plans)

**Spec coverage (acceptance criteria → task):**
1. V44 migration applies on V43, idempotent, only new table → **Task 2** (`runner-v44.test.ts`: applies-on-V43, idempotent, table shape, indexes).
2. Every dispatched action has a preceding row; denied → blocked row; append failure aborts → **Task 4** (append path) + **Task 7** (`gate()` wiring + the I30 trio test).
3. `nimbus prove` prints `0` for local-only / exactly the rows for a dispatch → **Task 5** (`proveWindow`) + **Task 12** (`runProve` head-diff).
4. `egress verify` exits 0 clean / non-zero tampered, timing-safe → **Task 5** (`verifyEgressChain` + `sha256HexEqualConstantTime`) + **Task 12** (`runEgressVerify` exit codes).
5. No seeded credential in `payload_summary`; receipt reuses Vault key, private key never crosses IPC → **Task 3** (`redactEgressSummary` strips ghp_/sk-/Bearer) + **Task 8** (`signWindowDigest` returns only sig+pubkey, Vault test).
6. `egress.prune` in I2 set, HITL-gated, continuing tombstone, NOT renderer-exposed → **Task 7** (`egress.prune` in `HITL_REQUIRED_BACKING` + I30 test) + **Task 6** (tombstone) + **Task 9** (approval broker) + **Task 10** (`!is_method_allowed("egress.prune")`).
7. I30 in three places in one commit + D23 + I28 reserved → **Task 7** (wiring + SECURITY-INVARIANTS.md + CLAUDE.md/GEMINI.md + security-invariants.test.ts + D23 static check, all one commit; numbering note documents the I28 reservation).
8. Every new file ≥80% floor; `preflight` green before first push → **Task 13** (coverage-floor gate + full preflight); each task's tests target the new file's arms.
9. Pre-impl audit proves `connectors.dispatch` total before D23 is switched on → **Task 1** (enumerate + document + BLOCKER check), referenced in the Task 7 commit body.

**Placeholder scan:** No "TBD"/"TODO"/"implement later"/"handle edge cases"/"similar to Task N". Each code step contains the actual code; each test step the actual test; each command is exact with an expected outcome. The two spots that defer to real-tree identifiers (Task 11 assemble variable names; Task 13 the exact coverage-floor command) are unavoidable boot-wiring/repo-tooling specifics, each with a Step-1 discovery command and an explicit "mirror the `shareRpcCtx` site" instruction — not unspecified logic.

**Type consistency:** `EgressEntry`/`EgressHitlStatus`/`EgressResultStatus` (Task 3) are consumed verbatim by Tasks 4/5/6/7/9. `EgressSink` (Task 4) is consumed by Task 7 (executor param) and built by Task 11. `EgressRpcCtx` (Task 9) is consumed by Task 10 (options) and built by Task 11. `verifyEgressChain`/`listEgress`/`egressHead`/`proveWindow` (Task 5), `pruneEgress` (Task 6), `signWindowDigest`/`digestEgressWindow` (Task 8) are all consumed by Task 9. `serviceOf`/`redactAuditPayload`/`GENESIS_HASH`/`sha256HexEqualConstantTime`/`ensureShareKeypair`/`dbRun`/`dispatchByMethod`/`runIndexedSchemaMigrations`/`CURRENT_SCHEMA_VERSION` are all existing exports confirmed by the grounding read-pass. No type or function is referenced before a task defines it (or before the grounding establishes it as existing).
