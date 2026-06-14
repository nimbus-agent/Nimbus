# Phase 6 Slice 7 — Wave 7b: Team-shared credentials (faithful I19, unified spawn)

**Date:** 2026-06-14
**Status:** design — approved interactively; pending written-spec sign-off before `writing-plans`
**Slice:** Phase 6 Slice 7, Wave 7b (follows Wave 7a — the 6 data-warehouse/BI connectors + lineage, shipped in PR #595)
**Depends on:** Slice 1 (Federation Core), Slice 2 (Team Vault + I19 invoke-gate), Slice 3 (Identity/SSO) — all shipped; Wave 7a (merged to main)
**Branch:** `dev/asafgolombek/phase6-slice7-wave7b` (fresh off main `d16fe204`); worktree `.claude/worktrees/dev+asafgolombek+phase6-slice7-wave7b`

---

## 1. Goal

The six Wave-7a warehouse/BI connectors — **snowflake, tableau, looker, powerbi, montecarlo, bigeye** — currently authenticate from the operator's **personal Vault**. Wave 7b adds an **opt-in team-shared-credential path**: a workspace pins a shared service-account secret in **Team Vault**, and the connector sources it **only** through the existing **I19** secret chokepoint — leak-proof result, fail-closed on a missing secret, sandboxed (I15).

**Non-goals / explicitly out of scope:**

- **No new security invariant.** Wave 7b is a *consumer* of I19; the `security-invariants.test.ts` count is **unchanged**.
- **No HITL write actions** — those are Wave 7c (`warehouse.task.run`, `bi.dataset.refresh`, …). Wave 7b is read/metadata-sync only.
- **No org-policy entitlement layer** — a team entry existing in the local Team Vault *is* the entitlement; policy gating (I22) is not introduced here.

---

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Branch | Fresh off main (PR #595 merged), new worktree |
| D2 | Secret injection model | **Faithful I19 (spawn):** the secret-using fetch runs inside a spawned connector subprocess; the secret never enters the gateway heap |
| D3 | Local-operator adapter shape (F3) | **Principal-polymorphic gate:** refactor `answerFederatedInvoke` to take `Principal = peer \| localOperator`; one honest gate, real principal in audit, single chokepoint |
| D4 | Local authorization | **Config pin** (`credential="team"` + a resolvable `team_entry`) **+ identity-valid if `[identity]` enabled** (I18). No per-peer grant row; no quorum |
| D5 | Transport | **Unify on the connector (spawn always):** both personal and team sync go through *spawn → call `<svc>_list` → gateway maps/indexes the returned raw*. Gateway-side `connectorFetch` deleted from the 6 sync handlers. Mappers + lineage logic stay single-sourced gateway-side |
| D6 | Connector read-tool pagination | The 6 `<svc>_list` tools gain `cursor`/`limit` and return `{ items, nextCursor }`, so unified sync keeps Wave-7a pagination parity |
| D7 | Config entry reference | **Explicit `team_entry`**; `credential="team"` with no `team_entry` is a fail-closed config error |
| D8 | Quorum on reads | **None** — the read-sync tool carries no `[hitl.quorum]` rule; quorum stays reserved for Wave 7c writes |

### 2.1 Why faithful-spawn over a gateway-side team-view read

I19's guarantee is that a **team** service-account secret (which the operator may not be personally entitled to see raw) lives **only** inside an ephemeral, sandboxed connector subprocess — never in the long-lived gateway heap where the agent/LLM and broad logging operate. A gateway-side read of a team secret (even via a scoped `createTeamVaultView`) would materialize it in gateway scope exactly like a personal secret, weakening I19's "ephemeral-connector-only" property. We keep the strong property: **team secrets are consumed only via `invokeTeamTool` → `spawnTeamToolAndCall`.**

### 2.2 Why unify personal onto the spawn path

The team path *must* spawn (D2). Rather than maintain two transports (gateway-side fetch for personal, spawn for team), both go through the connector's read tool. This is the standard Nimbus connector shape, removes the pre-existing gateway/connector fetch overlap, single-sources the (security-irrelevant) mapper gateway-side, and pre-pays the connector infrastructure Wave 7c needs. **Accepted costs:** per-cycle spawn overhead on personal sync; pagination support added to the 6 read tools (D6) so personal sync does not regress to a single ≤500-object page; re-baselining coverage on the 6 just-merged sync files.

---

## 3. Verified current-state facts (main, post-#595)

These shaped the design and must be re-checked if main moves:

1. **All connectors sync gateway-side** via `connectorFetch` + a personal Vault secret read in the handler (`packages/gateway/src/connectors/*-sync.ts`). The `ensure<Svc>McpRunning()` call manages the subprocess lifecycle but its tools are **not** used by sync today.
2. **The 6 connector MCP servers are real, not stubs.** Each registers `<svc>_list / _get / _search` with live fetch (verified directly: `packages/mcp-connectors/powerbi/src/server.ts` → `powerbi_list/_get/_search`). `<svc>_list` currently returns a **single capped page** (`limit`, max 500) with no cursor — built for interactive top-N queries, not exhaustive sync. → D6 closes this gap.
3. **I19 chokepoint:** `federation/invoke-gate.ts` `answerFederatedInvoke(ctx, InboundInvoke{peerId,…})` → `teamvault/team-tool-invoke.ts` `invokeTeamTool` (fail-closed secret-presence check) → `teamvault/team-tool-spawn.ts` `spawnTeamToolAndCall` (`spawnerFor(service)` spawns with a `createTeamVaultView(vault, entry)`; secret read by the spawner, injected into subprocess env, never returned).
4. **`spawnerFor(service)`** maps the 6 warehouse services through the **phase3 bundle spawner** (`ensurePhase3BundleMcp`); given a team vault view scoped to a single entry, only that entry's service resolves its keys and spawns (others noop). No new single-service spawner required.
5. **Team Vault store** (`teamvault/team-vault-store.ts`): an *entry* = `{ entry, service, createdAt, createdBy }`. `checkGrant(entry, peerId, toolId)` is strictly per-peer; **there is no local-operator concept today** → D3/D4 introduce one at the gate (authorization), not in the grant table.
6. **No `[connectors.<name>]` config section exists today.** Pattern to follow: `[lan]` / `[identity]` (`forEachSectionEntry`) and `[hitl.quorum."<type>"]` (`collectQuorumKvSections`).
7. **D15 static audit** forbids composing the literal `"teamvault."` prefix outside `teamvault/team-vault-keys.ts`. Wave 7b adds **no** new prefix-literal site (it reuses `createTeamVaultView`).

---

## 4. Config schema

New per-connector section in `config/nimbus-toml.ts` (the first `[connectors.<name>]` family):

```toml
[connectors.snowflake]
credential = "team"            # "personal" (default when section/key absent) | "team"
team_entry  = "prod-snowflake" # required iff credential = "team"
```

- Parsed into `ReadonlyMap<ConnectorServiceId, ConnectorCredentialConfig>` where
  `ConnectorCredentialConfig = { credential: "personal" | "team"; teamEntry?: string }`.
- **Validation (fail-closed):**
  - `credential` not in `{personal, team}` → config error.
  - `credential = "team"` with absent/empty `team_entry` → config error.
  - `team_entry` must satisfy the Team Vault entry-name rule (`ENTRY_RE` in `team-vault-keys.ts`: lowercase alnum + dashes, no dots).
  - A `[connectors.<name>]` for a name that is not one of the six → config error (keeps the surface tight; can widen later).
- **Back-compat:** no section, or `credential` absent → `personal`. Solo machines with no federation are unaffected.
- The selection never materializes the secret into config; when `team`, the secret is injected ephemerally by the I19 machinery (§5/§6).

---

## 5. Principal-polymorphic gate (the I19 front-end refactor)

`federation/invoke-gate.ts` is refactored so the gate authorizes a **principal**, not implicitly a peer:

```ts
export type InvokePrincipal =
  | { readonly kind: "peer"; readonly peerId: string }
  | { readonly kind: "localOperator" };
```

- The invoke request carries `principal` instead of a bare `peerId`. `InboundInvoke` (the wire shape) keeps `peerId` and is adapted to `{ kind: "peer", peerId }` at the federation entry point — **the federated path's behavior is byte-identical** (regression-tested).
- **Authorization branch:**
  - `peer` → unchanged: `store.getEntry(entry)` + `store.checkGrant(entry, peerId, toolId)`, then quorum (if a rule exists).
  - `localOperator` → authorized by the **config pin**: the connector's `team_entry` resolves to an existing entry whose `service` matches the connector, **and** if `[identity]` is enabled, `identity.isOperatorValid()` must hold (I18). **No `checkGrant`, no quorum** for the read tool (D8).
- Both branches converge on the **same** `runTool` → `invokeTeamTool` → spawn. The secret chokepoint and injection are unchanged.
- **Audit** records the real principal: the `teamvault.invoke.<decision>` audit row carries `localOperator` (not a synthetic peer id). Audit fields: extend `team-vault-audit.ts` to accept a principal descriptor instead of a required `peerId`.

This is F3's resolution: not "synthetic peer into `answerFederatedInvoke`" and not a duplicated sibling — a single honest gate that both the wire path and the local sync path enter, with `invokeTeamTool` remaining the one secret-consumption chokepoint named by I19.

---

## 6. Unified spawn-based sync transport

Both credential modes route through *spawn → `<svc>_list` (paginated) → gateway maps + indexes the returned raw items*. The Wave-7a mappers and lineage-key logic (`normalizeDataModelKey`, the graph populators) stay **gateway-side and single-sourced**.

### 6.1 Connector read-tool pagination (D6)

Each `<svc>_list` tool gains:
- input: `{ cursor?: string; limit?: number }`,
- output: `{ items: unknown[]; nextCursor: string | null }`.

The cursor is vendor-specific (resolved in the plan): Snowflake SQL-API offset/`partition`, Tableau pagination token, Looker/PowerBI/Bigeye page index, Monte Carlo GraphQL `endCursor`. `_get`/`_search` are unaffected.

### 6.2 Personal sync

- The 6 `*-sync.ts` handlers stop calling `connectorFetch`. Instead they **spawn the connector with the personal vault view** (the existing lazy-mesh/phase3 path) and call `<svc>_list` page-by-page, mapping + `upsertIndexedItemForSync` per page until `nextCursor === null`, then return the existing `SyncResult` shape.
- New helper (plan open-item §9): "call a tool on the lazy-mesh-spawned (personal) connector" — the persistent-mesh analogue of `spawnTeamToolAndCall`, using the personal vault. The `SyncContext`/mesh wiring exposes the spawned client's tools to the handler.

### 6.3 Team sync

- When `credential="team"` for the service, the handler instead routes through the gate: `principal = { kind: "localOperator" }`, `entry = teamEntry`, `toolId = "<svc>_list"` → `invokeTeamTool` → `spawnTeamToolAndCall` with `createTeamVaultView(vault, teamEntry)` → `<svc>_list` → returns raw items (leak-proof; secret stayed in the subprocess) → gateway maps + indexes.
- **Fail-closed:** missing team secret → `invokeTeamTool` throws `team_secret_missing`; the sync records a failed cycle and surfaces an actionable error — it never falls back to a personal credential (D8 of Slice 2 carried forward).
- **Pagination across one spawn (open item §9):** prefer spawning once and looping `<svc>_list(cursor)` calls within that spawn (a small `invokeTeamTool` variant that calls the tool N times before disconnect), versus a spawn-per-page fallback. Resolved in the plan against latency/coverage.

---

## 7. Security & invariants

- **I19 — count unchanged.** Wording broadens from "an inbound peer" to "a peer **or** local-operator principal," still "team-vault secrets consumed only via `invoke-gate.ts` → ephemeral team-credentialed connector." Wiring sites unchanged (`invoke-gate.ts`, `team-tool-invoke.ts`). Update `docs/SECURITY-INVARIANTS.md` I19 row + the CLAUDE.md/GEMINI.md I19 line in the same commit (the triple rule).
- **D15 static audit** stays green — no new `"teamvault."` literal site (reuse `createTeamVaultView`/`teamVaultKey`).
- **`security-invariants.test.ts` I19 test extended** to cover the local-operator principal: (a) the secret never appears in the returned result, the audit row, or logs; (b) fail-closed when the team secret is absent; (c) the federated peer path remains gated exactly as before.
- **I15** sandbox: the team spawn reuses `wrapServerSpec`/`spawnTeamToolAndCall`, already sandboxed — unchanged.
- **I18:** local-operator authorization consults `isOperatorValid()` when identity is enabled (mirrors the federated check).

---

## 8. Testing & acceptance

Per the Nimbus testing philosophy (`nimbus-testing`):

- **Team-vault no-leak test** (the Vault standard): no shared secret value escapes the local path through the result, audit, IPC, or logs; assert on a populated indexed item that no secret-shaped value is present.
- **Fail-closed test:** `credential="team"` with the team secret absent → sync fails closed (no personal fallback, actionable error).
- **Gate regression:** the federated peer path (`kind:"peer"`) behaves identically pre/post refactor — grant + quorum + audit unchanged.
- **Config tests:** parse/validate `[connectors.<name>]`; team-without-`team_entry` and unknown-connector are errors; absent → personal.
- **Connector read-tool tests:** `<svc>_list` pagination (cursor round-trip, `nextCursor` termination) per connector, fetch faked at the HTTP boundary (`describeWithFetchRestore` + URL-branching `fetch` stub) — no live cloud.
- **Sync wiring tests:** for each connector, personal and team both index via the spawned tool; the Wave-7a mappers/lineage edges are unchanged (re-use the existing mapper fixtures).
- **E2E (seam-based):** a team-credential sync end-to-end against a mock connector via an `NIMBUS_*_E2E_SINK_DIR`-style seam (no live warehouse), proving the gate → spawn → index path and the audit row.

### Acceptance criteria (Wave 7b exit)

1. A connector configured `credential="team"` sources its secret **only** via the I19 machinery (gate → `invokeTeamTool` → spawn), and **fails closed** when the team secret is absent; the secret never appears in config, logs, or IPC.
2. `credential="personal"` (default) is unchanged in behavior and indexes the same items as Wave 7a (pagination parity preserved after the unify).
3. The federated peer invoke path is behaviorally identical after the principal-polymorphic refactor.
4. `bun run preflight` green on the 3-OS matrix; **`security-invariants.test.ts` count unchanged** (no new invariant); D15 static audit green.
5. **Coverage floor:** every changed/new file clears ≥80% line+branch (baseline `{}`; CI-Linux-authoritative via `audit:coverage-floor`), verified by a Docker dry-run before the first push (the ship-readiness rule — never push-and-see).

---

## 9. Open items for the plan (not blockers)

- **O1 — personal tool-call helper:** the lazy-mesh persistent-connector "call a tool" path the personal sync needs (analogue of `spawnTeamToolAndCall`), and how `SyncContext`/the mesh exposes the spawned client to the 6 handlers.
- **O2 — pagination within one team spawn:** one spawn + N tool calls vs spawn-per-page; resolve against latency + coverage.
- **O3 — per-vendor `<svc>_list` cursor contract:** the concrete cursor/offset token for each of the six APIs.
- **O4 — e2e seam reuse:** which `NIMBUS_*_E2E_SINK_DIR`-style seam (from Slice 5) drives the team e2e without a live warehouse.
- **O5 — audit shape:** extend `team-vault-audit.ts` to record a principal descriptor (`localOperator` vs peer id) without breaking the existing federated audit rows / their tests.
- **O6 — staging:** land config → gate refactor (+ I19 test) → one connector end-to-end (**snowflake**) → fan out the other five sequentially (commit per connector to avoid subagent-death mid-registration) → docs + preflight + Docker coverage dry-run.

---

## 10. Reusable gotchas carried in (from Wave 7a / Sub-project B)

- **Connector registration is type-coupled** across ~6 sites; a read-tool signature change ripples to the connector's own tests and the lazy-mesh config. Change one connector fully before fanning out.
- **Coverage floor is CI-Linux-authoritative** and the baseline is `{}` — Docker (`oven/bun:latest`, bun 1.3.14) dry-run before first push; reseed from the PR's **own** merge-lcov artifact if a round is needed, never from stale main lcov.
- **Prefer DI over `mock.module`** for anything in the combined `bun test packages/cli/src` / gateway runs (process-global leak).
- **Now-relative fixtures**, never hardcoded dates (the date-rollover trap).
- **`bun test` ≠ `tsc --noEmit`** — run the full typecheck; connector wiring failures hide from `bun test`.
