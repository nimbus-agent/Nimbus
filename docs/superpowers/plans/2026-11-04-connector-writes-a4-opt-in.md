# Connector Writes A4: Owner Opt-In for Model Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can turn model-initiated connector writes on per connector, up to a wave, with `nimbus connector writes enable <service> [--wave <n>]` (an owner-approved action), turn them off with `disable`, and see the state with `status`. An org policy can forbid it (`connector_write_model_access`, tighten-only). Nothing reads the enablement yet except `status`: the model door (A5) is the first consumer.

**Architecture:** A SQLite table (`connector_write_enablement`, schema V83) holds one row per enabled service. A small store module reads and writes it through the I14 write helpers. Three IPC methods (`connector.writesEnable`, `connector.writesDisable`, `connector.writesStatus`) are CLI-only: refused on LAN (I5) and absent from the Tauri allowlist (I7). `enable` is a new frozen-set HITL type, `connector.writes.enable`, approved by the LOCAL owner only (never delegable, I20), behind a gate-only executor that dispatches nothing and appends no egress row (it is a local mutation, the `NULL_EGRESS_SINK` precedent).

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, `bun:test`, the CLI (`packages/cli`).

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` (branch `dev/asaf/connector-writes-spec`), § 5.2 "Opt-in" and § 10 (A4).

## Global Constraints

- Branch from `origin/main`. This plan and the spec never land on `main`.
- **Defaults:** off for every connector. `--wave` sets `max_wave`; omitted, it is `3`. Wave `4` only with an explicit `--wave 4`. Valid values: `2`, `3`, `4`.
- **Which services:** only a service that has at least one row in `CONNECTOR_WRITE_ROWS`, by `serviceOf(row.actionType)` (e.g. `github`, `kubernetes`, `github_actions`, `snowflake`). Anything else is refused with `ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE` before any prompt.
- **Policy:** `connector_write_model_access` joins `AI_V2_CAPABILITIES` (`policy/types.ts`). When the resolved policy disables it, OR the policy accessor is absent (fail-closed, like `isUserMcpModelAccessEnabled`), `enable` is refused before the prompt with `ERR_CONNECTOR_WRITES_POLICY`, and `status` reports `policyAllows: false`. `disable` always works. `dispatchConnectorRpc`'s options do NOT carry a policy accessor, a DB or a clock today: add a REQUIRED `getEnforcedPolicy: () => EnforcedPolicy | undefined` (find how `user_mcp_model_access`'s live accessor is threaded in `platform/assemble.ts` and reuse that source), plus the DB and `now` it needs; `undefined` from the accessor means refuse.
- **The approval:** `connector.writes.enable` is added to `HITL_REQUIRED_BACKING`, classified `denied("gateway_internal", …)` in `ACTION_PROPOSABILITY`, and added to the explicit condition in `ToolExecutor.tryDelegatedApproval` that returns `"fallback"` (today `action.type === "registry.add" || action.type === "pack.install" || action.type.startsWith("extension.")`; add `|| action.type === "connector.writes.enable"`). Without it, an active delegate for service `connector` (`serviceOf("connector.writes.enable")`) would be asked instead of the owner (I20). The handler calls only `toolExecutor.gate(action)`, never `execute` (`connector.adoptLocalAuth` calls `toolExecutor.gate` the same way), on the IPC `toolExecutor` the connector dispatcher already receives.
- **The prompt says exactly what is enabled.** `formatConsentPrompt` gains a dedicated branch for `connector.writes.enable` (the precedent is its `pack.install` and `extension.eval` branches; the generic path prints only a JSON `Details:` line). The branch prints `Service: <service>`, `Up to wave: <n>`, one line per write that becomes model-offerable (`  <toolId>  <actionType>  wave <w>`, every row of that service with `wave <= max_wave`), and the fixed sentence `Each call will still ask you before it runs.` Values come from gateway constants (row table), not from the caller, but pass each through the same escaping the A2 preview uses (`connectors/connector-writes/preview.ts`'s sanitiser) anyway. The payload is `{ service, maxWave, writes: [{ toolId, actionType, wave }] }`.
- **Writes to SQLite only through `dbRun` / `dbExec` / `dbStmtRun`** (`db/write.ts`, I14 / static D12): `removeModelWriteEnablement` returns `dbRun(...).changes > 0`. Import `Database` as a TYPE only (`import type { Database } from "bun:sqlite"`, static D30). Sorting uses `localeCompare` comparators.
- `disable` needs no approval (it only narrows), removes the row, and is idempotent (`{ removed: false }` when nothing was enabled).
- The IPC methods are refused on LAN: add all three to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`, and add `connector.writesEnable` and `connector.writesDisable` to `WRITE_METHODS` as well (defence in depth, like the other mutating `connector.*` methods). They are NOT added to `ALLOWED_METHODS` (`packages/ui/src-tauri/src/gateway_bridge.rs`); the I7 test for that is a regression guard (green on day one by design) and is labelled so.
- No comparator-less `.sort()`; no `any`; no literal invisible characters.
- Before every push: `bun run preflight:fast`, `bun run typecheck:tests`, and once `bun test packages/cli --parallel` (the 11 TUI Yoga failures are pre-existing). The CLI structure test bans `const TIMEOUT_MS = 30_000` anywhere in `packages/cli/src`.
- Do not compile the gateway; never a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings this plan makes

- **O1: Storage is a table, not `nimbus.toml`** (spec § 5.2): no profile or layered config (D35) can turn it on, the same shape as the user-MCP `model_access` column.
- **O2: The IPC namespace stays `connector.*`** with three named methods, because `connector` is an existing CLI-only-by-method namespace on LAN; each method is named in the LAN denylist rather than the whole namespace.
- **O3: `status` lists every eligible service**, enabled or not, so the owner can see what could be enabled: `{ services: [{ service, enabled, maxWave?, enabledAt?, writes: number }], policyAllows }`, sorted by service.
- **O4: Re-enabling an enabled service with a different wave replaces its row**, behind a fresh approval (a wider wave is a new grant; a narrower one still prompts, for one rule).

## Review Focus

1. **A delegate approving `connector.writes.enable`** — must fall back to the local owner (I20); pinned in the executor delegation test.
2. **A policy that forbids it, applied after boot** — `enable` reads the LIVE resolved policy per call; pinned.
3. **`--wave 5`, `--wave 1`, `--wave abc`, a service with no rows (`mcp_x`, `ext_y`, `email`)** — each refused before any prompt.
4. **A LAN peer or the desktop renderer calling the methods** — refused / absent; pinned.
5. **Disable while nothing is enabled, and enable twice** — idempotent disable; O4 on re-enable.

---

### Task 1: Schema V83 and the store

**Files:**
- Create: `packages/gateway/src/index/connector-write-enablement-v83-sql.ts` (follow `extension-observation-notice-v82-sql.ts`)
- Modify: `packages/gateway/src/index/migrations/runner.ts`: import `CONNECTOR_WRITE_ENABLEMENT_V83_SQL` and append `simpleStep(82, 83, "connector write opt-in table", CONNECTOR_WRITE_ENABLEMENT_V83_SQL)` to `INDEXED_SCHEMA_STEPS`, after the V82 step
- Modify: `packages/gateway/src/index/local-index.ts`: `CURRENT_SCHEMA_VERSION = 83`
- Create: `packages/gateway/src/index/migrations/runner-v83.test.ts` (follow `runner-v82.test.ts`)
- Create: `packages/gateway/src/connectors/connector-writes/enablement-store.ts`, test `enablement-store.test.ts`

**Interfaces:**
- SQL: `CREATE TABLE connector_write_enablement (service TEXT PRIMARY KEY, max_wave INTEGER NOT NULL CHECK (max_wave IN (2, 3, 4)), enabled_at INTEGER NOT NULL)`.
- Store:
  ```ts
  export interface ModelWriteEnablement { readonly service: string; readonly maxWave: ConnectorWriteWave; readonly enabledAt: number }
  export function modelWriteServices(): readonly string[]; // derived from CONNECTOR_WRITE_ROWS, sorted
  export function setModelWriteEnablement(db: Database, service: string, maxWave: ConnectorWriteWave, now: number): void; // upsert (O4)
  export function removeModelWriteEnablement(db: Database, service: string): boolean;
  export function getModelWriteEnablement(db: Database, service: string): ModelWriteEnablement | undefined;
  export function listModelWriteEnablement(db: Database): readonly ModelWriteEnablement[];
  export function writesEnabledBy(service: string, maxWave: ConnectorWriteWave): readonly ConnectorWriteRow[]; // rows of the service with wave <= maxWave
  ```
- [ ] **Step 1: Write failing tests**: the migration creates the table and the CHECK refuses `max_wave = 5`; the upsert replaces; remove returns true then false; list is sorted; `modelWriteServices()` contains `github`, `kubernetes`, `snowflake` and not `mcp_x`; `writesEnabledBy("github", 2)` holds `github_issue_create` and not `github_pr_merge` (wave 3).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (writes through `dbRun`).
- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors/connector-writes packages/gateway/src/index/migrations` and `bun run typecheck`. PASS.
- [ ] **Step 5: Commit.** `feat(gateway): schema V83, the connector write opt-in table`.

### Task 2: The policy capability and the approval type

**Files:**
- Modify: `packages/gateway/src/policy/types.ts` (`AI_V2_CAPABILITIES` gains `"connector_write_model_access"` with a doc comment like `user_mcp_model_access`'s)
- Create: `packages/gateway/src/connectors/connector-writes/model-write-capability.ts` with `isConnectorWriteModelAccessEnabled(enforced)` (fail-closed on `undefined`), test beside it
- Modify: `packages/gateway/src/engine/executor.ts` (frozen set gains `connector.writes.enable`; `tryDelegatedApproval`'s structural exemption gains it), `packages/gateway/src/connectors/proposable-actions.ts` (`denied("gateway_internal", …)`)
- Test: `engine/executor-delegation.test.ts` (a live in-scope delegate for `connector` still falls back to the owner for `connector.writes.enable`), `security-invariants.test.ts` (I2 frozen-set membership, I20 exemption, I22 capability present in the parser's list)

- [ ] Steps: failing tests → implement → `bun test packages/gateway/src/engine packages/gateway/src/policy packages/gateway/src/connectors packages/gateway/src/security-invariants.test.ts` → commit `feat(gateway): the connector_write_model_access lock-off and the connector.writes.enable approval`.

### Task 3: The IPC methods

**Files:**
- Create: `packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts` (handlers), wired from `ipc/connector-rpc.ts`'s switch the way `connector.adoptLocalAuth` is (it needs `toolExecutor`, the DB, the live policy accessor, `now`)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (denylist the three methods, each with a one-line reason)
- Test: `packages/gateway/src/ipc/connector-rpc-model-writes.test.ts`; `ipc/lan-rpc.test.ts` (each method refused); `security-invariants.test.ts` I7 block (none of the three in `ALLOWED_METHODS`) and I5 block

**Interfaces:**
- `connector.writesEnable { service: string; wave?: 2 | 3 | 4 }` → `{ service, maxWave, writes: number }`. Order: validate params → service eligible → policy allows (LIVE) → build the action `{ type: "connector.writes.enable", payload: { service, maxWave, writes: [...] } }` → `toolExecutor.gate(action)` → on `"proceed"`, `setModelWriteEnablement` → return. A rejected gate returns `ERR_CONNECTOR_WRITES_DECLINED` and writes nothing.
- `connector.writesDisable { service: string }` → `{ removed: boolean }` (no gate).
- `connector.writesStatus {}` → the O3 shape.
- Error codes follow the file's existing `ConnectorRpcError` pattern; add the three `ERR_CONNECTOR_WRITES_*` names wherever this repo lists error codes (`git grep -n "ERR_CONNECTOR_" packages/gateway/src/ipc` for the convention).

- [ ] **Step 1: Write failing tests**, one per Review Focus line 2–5, plus: an approved enable writes the row, and the prompt TEXT names every tool in `writesEnabledBy(service, maxWave)` and the fixed sentence; a declined enable writes nothing; the audit row exists for the gate decision; and the executor the handler uses is wired with `NULL_EGRESS_SINK` (assert on the wiring, or pass a spy sink and assert the handler's own executor is built with the null sink — not on an always-empty ledger).
- [ ] Steps 2–5: run red, implement, run `bun test packages/gateway/src/ipc packages/gateway/src/security-invariants.test.ts`, commit `feat(gateway): connector.writesEnable, writesDisable and writesStatus`.

### Task 4: The CLI

**Files:**
- Modify: `packages/cli/src/commands/connector.ts` (or the file that owns `nimbus connector` subcommands — find it), adding `writes enable <service> [--wave <n>]`, `writes disable <service>`, `writes status [--json]`
- Test: the matching CLI test file, following the existing `connector` subcommand tests (DI over `mock.module`)

**Behaviour:**
- `enable` calls `withIpc(fn, undefined, INTERACTIVE_RPC_TIMEOUT_MS)` (`withIpc` in `connector.ts` delegates to `withGatewayIpc`; an omitted consent arg selects the interactive prompt handler; `INTERACTIVE_RPC_TIMEOUT_MS` from `../lib/rpc-timeouts.ts` — the default is 30 s, which an owner reading the prompt can exceed). Never a literal `30_000`.
- Put the subcommand in a `runConnectorWrites(args: string[])` function (in `connector.ts` or a sibling `connector-writes-cli.ts`) dispatched from `connector.ts`'s `switch (sub)` as `writes`. A missing `<service>` for `enable`/`disable`, an unknown verb, or an extra positional prints usage to stderr and exits 2. `printConnectorHelp()` gains the three lines `nimbus connector writes enable <service> [--wave 2|3|4]`, `nimbus connector writes disable <service>`, `nimbus connector writes status [--json]`. On success it prints `Model writes enabled for <service> up to wave <n> (<k> writes). Each call will still ask you.`
- `disable` prints `Model writes disabled for <service>.` or `Model writes were not enabled for <service>.`
- `status` prints one aligned line per eligible service (`<service>  enabled  wave <n>  <k> writes` / `<service>  off`), then `Policy: allows` / `Policy: forbids (connector_write_model_access)`. `--json` prints the raw O3 object.
- `--wave` accepts only `2`, `3`, `4`; anything else exits 2 with a usage message before any RPC.

- [ ] Steps: failing tests → implement → `bun test packages/cli/src/commands` (focused) then once `bun test packages/cli --parallel` → commit `feat(cli): nimbus connector writes enable, disable and status`.

### Task 5: Docs

**Files:** the five core docs (owner rule) — `CLAUDE.md` + `GEMINI.md` (identical; S4 progress A4 ✅; the I20 line's never-delegable list gains `connector.writes.enable`; the schema version V82 → V83), `docs/roadmap.md` (S4 progress), `docs/architecture.md` (the opt-in table, IPC methods, the approval), `docs/README.md` (only if it carries S4 progress), `docs/cli-reference.md` (the three new subcommands, flags, output, exit codes) — plus `docs/SECURITY-INVARIANTS.md` (I2: re-derive and bump the frozen-set type count; I20: add `connector.writes.enable` to the never-delegable list; I22: add `connector_write_model_access` and re-derive the capability count; I5 LAN denylist; I7 not exposed), `docs/CHANGELOG.md`, and any `.claude/commands/nimbus-*.md` that lists IPC methods, LAN-denied methods, policy capabilities or schema versions (`audit:status-drift` and `audit:doc-refs` will name stale counts — re-derive the list, not just the number). Schema version V82 → V83 wherever docs state the current version.

- [ ] Steps: update → `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast`, `bun run typecheck:tests` → scan for invisible characters → commit `docs: owner opt-in for model connector writes`.

## PR

- Title: `feat(gateway): owner opt-in for model connector writes (nimbus connector writes)`. Not breaking (new, off by default).
- Body: what the owner can do, defaults, the approval and its no-delegate rule, the lock-off, CLI-only surfaces, rulings O1–O4, tests, attribution. No unbalanced `(`.
- Auto-merge; resolve every thread.
