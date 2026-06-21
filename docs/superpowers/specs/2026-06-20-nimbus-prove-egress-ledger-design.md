# `nimbus prove` — Egress Ledger as a Trust Product — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 1 Spine / **S1 "Local Brain"** (the always-on egress-ledger primitive + `nimbus prove` read-surface, harvested forward from Phase 8 Wave 4 / Phase 7 Wave 6 / Phase 22 per the 2026-06-17 Sequencing Spine overlay).
**Scope:** `packages/gateway/src/egress/` (new), `packages/gateway/src/index/egress-ledger-v44-sql.ts` (new V44 migration), one-line hook in `packages/gateway/src/engine/executor.ts` `gate()`, one new IPC namespace handler `packages/gateway/src/ipc/egress-rpc.ts` (new), one new security-invariant row (I29) wired in `packages/gateway/src/security-invariants.test.ts` + the static complement `scripts/structure-audit/check-nimbus-invariants.ts`, and `nimbus prove` / `nimbus egress` CLI subcommands in `packages/cli/`. Reuses (not rebuilds): `db/audit-chain.ts` (BLAKE3 chain), `audit/format-audit-payload.ts` (`redactAuditPayload`), `share/share-keypair.ts` (Vault-only Ed25519), `util/timing-safe-compare.ts` (I10).

---

## Motivation / Goal

The deepest moat in the roadmap (North-Star **M7 "Provable Locality"**, `docs/roadmap.md` line 1132, 1526) is not a feature — it is a **provable claim**: "this agent contacted only these hosts, and on this query it contacted *none*." Every cloud relay vendor *is* the egress and *is* the data sink, so it can only assert non-disclosure in a PDF. Only a local-first, sandboxed, HITL-gated gateway can mint a credible **negative**.

This spec ships the **cheapest seed** of that moat: a minimal, always-on, append-only, BLAKE3-chained **egress ledger** that records every outbound action the gateway authorizes, plus the `nimbus prove` / `nimbus egress` read-and-verify surface. The product framing — "watch in real time that zero outbound calls occurred for this query" (`docs/roadmap.md` line 1028, 1053) — turns an invisible architectural property into a thing the user can *see and verify*. That is what makes local-first legible and sellable.

The hard part — **"proof of what did NOT leave"** — is solved structurally, not statistically: the ledger sits on a *chokepoint*, the chokepoint is enforced by a new invariant (I29), and a *signed completeness claim over that chokepoint* means "every outbound action is in the ledger; if the ledger shows zero rows in this window, zero outbound actions happened" is a sound inference rather than a hopeful one.

## Where this fits (roadmap home + not-already-shipped evidence)

**Roadmap home.** Track 1 Spine **S1 "Local Brain"**, per `docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md` lines 66–68: *"[NEW] Egress ledger as an always-on primitive + `nimbus prove` — pulled up from Phase 22. The cheap seed of the deepest moat."* The substrate rows are listed unchecked at `docs/roadmap.md`:

- line 1132 — `nimbus egress` signed ledger "built on the I15 per-host network allowlist + the BLAKE3 audit chain … the North-Star M7 (Provable Locality) capability".
- line 1028 / 1053 — `nimbus prove [<query>]` interactive proof mode showing the ledger before/after a query.
- line 1526 — the *auditor-grade externally-anchored export* is explicitly **deferred to Phase 12.5**; in scope here is only the local ledger + read surface.

**Not already shipped (verified).** There is no `egress_ledger` table and no `egress/` directory. The migration list in `packages/gateway/src/index/migrations/runner.ts` ends at `simpleStep(42, 43, …)` (V43 `share_inbox`); **V44 is the next free under the proposed global sequence** (see Numbering note below). The closest shipped neighbors are reusable but distinct:

- `share/share-gate.ts` (I27) is the *outbound-share* chokepoint — it gates a user-initiated *publish*, not every machine egress. It is the architectural model to copy, not the thing to extend.
- `db/audit-chain.ts` (V18 BLAKE3 `row_hash`/`prev_hash` over `audit_log`) already chains **HITL decisions**, but `audit_log` (`schema-sql.ts` line 45) records *consent outcomes*, not *egress events with destination + result*. The egress ledger is a sibling table with destination/result columns the audit log lacks.

So this is **net-new scope built on shipped primitives** — reuse the chain math, the redactor, the keypair, and the chokepoint pattern; add one table, one hook, one read surface, one invariant.

## Approaches considered

### Approach A — Syscall / kernel-level egress capture (eBPF / dtrace / ETW)

Intercept every outbound network syscall from the gateway and every sandboxed connector at the OS boundary, log host/port/bytes.

- **Pro:** captures *truly everything*, including a connector that tries to exfiltrate outside its declared hosts; closest to a "tamper-evident wiretap."
- **Con (fatal for now):** violates **Platform equality (Non-Negotiable 5)** unless three separate, privileged, fragile interceptors (eBPF on Linux, dtrace/Endpoint Security on macOS, ETW/WFP on Windows) are built and kept at parity — each needs elevated permissions Nimbus does not assume. It is a multi-month platform effort, not "the cheapest primitive." It also captures bytes the gateway can't attribute to a task/action (no semantic source), producing a noisy ledger that proves *traffic* but not *intent*. **Defer to Phase 8 W4 hardening**; out of scope.

### Approach B — Chokepoint ledger at the executor + connector-dispatch seam (recommended)

The gateway's own architecture already funnels every *authorized outbound action* through exactly one place: `ToolExecutor.gate()` in `engine/executor.ts`. The Non-Negotiable **"MCP as connector standard" (#4)** — an architectural rule, not an invariant-backed runtime check — means the engine *never* calls a cloud API directly: every cloud touch is an MCP tool dispatch the engine plans as a `PlannedAction` and routes through `connectors.dispatch()`. So a ledger write co-located with the existing `recordAudit` call in `gate()` captures every outbound action the gateway authorizes, *with its semantic source* (action type, session, HITL status). The "completeness claim" is then a claim over a code-level chokepoint the new invariant (I29) makes total — I29 is precisely the runtime/static enforcement this architectural rule has lacked.

- **Pro:** ~1 hook, platform-equal (pure TypeScript), zero new privileges, every row is semantically attributed, reuses the entire shipped chain+redactor+keypair stack. Directly delivers the `nimbus prove` "before/after a query" demo because the ledger is in the same process as the planner.
- **Con:** the completeness guarantee is "every action the engine plans" — it does **not** catch a sandboxed connector making an *undeclared* extra HTTP call inside its own process. That gap is real and must be stated honestly in the proof output (see Security). It is bounded by the I15 sandbox host-allowlist (already shipped) and closed fully only by Approach A later.

### Approach C — Per-connector MCP-server-side instrumentation

Each first-party MCP connector self-reports its outbound calls back to the gateway over a side channel.

- **Pro:** sees real connector traffic, not just planned actions.
- **Con:** trust-inverted — a malicious/buggy connector self-reporting its own egress is exactly the thing you cannot trust; it also requires touching all ~80 connectors (huge surface) and an unaudited new IPC channel from sandboxed processes back into the gateway (attack surface against I1/I15). Rejected as both untrustworthy and high-cost.

### Recommendation

**Approach B.** It is the only option that is (a) genuinely *the cheapest primitive* (one hook + one table + one read surface), (b) **platform-equal by construction** (pure Bun/TypeScript), (c) **trustworthy** (the gateway logs its own authorization decisions, not a connector's self-report), and (d) a faithful instance of the *already-proven* I27 chokepoint pattern. Its honesty gap (undeclared in-sandbox connector calls) is disclosed in the proof output as a *tier* ("authorized-actions-complete; raw-syscall-capture: deferred") rather than hidden — which is exactly the posture the Phase 22 EAF "indeterminate, never a false zero" rule (`docs/roadmap.md` line 2153) demands. Approach A is the natural Phase 8 follow-on that *raises the tier* without changing the ledger schema or the `prove` surface.

## Design (recommended)

### Architecture & components

New directory `packages/gateway/src/egress/`:

- **`egress-ledger.ts`** — the write path. `appendEgressEntry(db, entry)`: computes the BLAKE3 `row_hash` over `prev_hash | timestamp | source_type | source_id | destination | method | result_status` (reusing the `blake3`/`bytesToHex` primitive exactly as `db/audit-chain.ts` does — extract the shared hash helper if clean, else mirror it), reads the prior head, INSERTs append-only. No UPDATE/DELETE paths exist in this module. Mirrors `appendAuditEntry`'s `GENESIS_HASH` + prev-head-read shape.
- **`egress-record.ts`** — pure types + the `summarizeDestination()` / `classifyMethod()` helpers. `destination` is `{ host, service, kind }` derived from the `PlannedAction.type` prefix (`serviceOf()` already exists in `executor.ts`) — *not* from a raw URL, so no secret-bearing query string is ever stored. `payload_summary` is produced by `redactAuditPayload(action.payload)` (reused from `audit/format-audit-payload.ts`, already strips `gh*_`, `sk-`, `Bearer`, JWT, AWS keys, and `token|key|secret|…` object keys) capped at 256 bytes.
- **`egress-verify.ts`** — the read/verify path. `verifyEgressChain(db)` walks rows, recomputes each `row_hash`, and compares with `timingSafeCompare` (I10, from `util/timing-safe-compare.ts`) — never `===`. Returns `{ ok: boolean, brokenAt?: number }`. `proveWindow(db, { since, until })` returns the rows + a `completeness` object `{ tier: "authorized-actions", outboundEgressEvents: n }` and, when `--receipt`/`--sign` is requested, signs the window digest with the Vault-only share keypair (`ensureShareKeypair` from `share/share-keypair.ts` — same key family as `share.signing.privkey`, no new Vault key needed).
- **`egress-prune.ts`** — `pruneEgress(db, beforeTs)`: the *only* sanctioned mutation, and even it is append-aware — it deletes whole prefix rows and writes a single `source_type='prune'` tombstone row continuing the chain so the chain head stays verifiable (a pruned ledger reads "history before T was pruned at T by owner," not a silent gap).

New migration `packages/gateway/src/index/egress-ledger-v44-sql.ts` + a `simpleStep(43, 44, "egress_ledger (provable-locality primitive v44)", EGRESS_LEDGER_V44_SQL)` appended to `migrations/runner.ts`.

New `packages/gateway/src/ipc/egress-rpc.ts` exposing the `egress.*` namespace (below).

CLI: `packages/cli/src/commands/egress.ts` + `prove.ts` (or one `prove.ts` that subsumes `egress` per the roadmap's combined `nimbus principles` + `nimbus prove` framing, line 1028 — keep them as two verbs, one handler module).

### Data flow

**Write (always-on).** Engine plans a `PlannedAction` → `ToolExecutor.gate()` resolves HITL → the existing `this.audit.recordAudit(...)` fires → **immediately after, synchronously, in the same `try` scope**, `appendEgressEntry(...)` records the egress row *before* `execute()` is allowed to call `connectors.dispatch()`. Critically the ledger row is written for an action that is **about to** egress (`hitlStatus !== "rejected"`); a rejected/denied action writes a row with `result_status='blocked'` so the ledger also proves *what was stopped*. The hook is injected via an `EgressSink` interface added to the `ToolExecutor` constructor (DI, never `mock.module` — matches the codebase's CI-Linux DI rule), keeping `executor.ts` import-light and the gate logic test-isolated.

**Read (`nimbus prove "<query>"`).** CLI captures the ledger head hash → runs the query via the normal ask path → captures the new head → prints the diff: every row appended during the query, or the headline `outbound egress events during this query: 0 ✓` when the local-only query touched nothing. `nimbus egress --since 24h [--json] [--sign]` prints/serializes the window + chain-verify result. `nimbus egress verify` recomputes the whole chain offline.

**Prune.** `nimbus egress prune --before <date>` → HITL-gated (`egress.prune` action, see Security) → tombstone row.

### IPC / CLI surface

IPC namespace `egress.*` (handler `ipc/egress-rpc.ts`):

- `egress.list({ since?, until?, limit? })` → rows (read-only).
- `egress.verify()` → `{ ok, brokenAt? }`.
- `egress.head()` → current chain head hash + count (lets the CLI snapshot before/after a query).
- `egress.proveWindow({ since, until, sign? })` → `{ rows, completeness, receipt? }`.
- `egress.prune({ beforeTs })` → owner-HITL-gated; returns `{ prunedCount }`.

CLI:

- `nimbus prove "<query>"` — runs the query, shows ledger before/after (the demo surface).
- `nimbus prove --receipt "<query>"` — same, plus a signed `outbound_egress_events: n` artifact.
- `nimbus egress [--since <dur>] [--json] [--sign]` — the report.
- `nimbus egress verify` — offline chain integrity check.
- `nimbus egress prune --before <date>` — owner-HITL retention control.

**Tauri allowlist (I7):** expose only the read verbs (`egress.list`, `egress.verify`, `egress.head`, `egress.proveWindow`) to the renderer; **`egress.prune` is NOT renderer-exposed** (it mutates), matching the `nimbus-tauri-allowlist` "no RCE/mutation-class to renderer" rule.

### Security: the 7 Non-Negotiables, invariant impact, fail-closed

| Non-Negotiable | How preserved |
| --- | --- |
| **1. Local-first** | The ledger is a local SQLite table; nothing about it makes a network call. The *signed export* to an external sink stays **deferred to Phase 12.5** (`docs/roadmap.md` line 1526) — explicitly out of scope. `nimbus prove` is the local-first story made *visible*, not a new egress path. |
| **2. HITL is structural** | The write hook lives *inside* `gate()`, after consent resolution — it cannot front-run or replace the consent gate. The one mutation, `egress.prune`, is itself a new HITL action `egress.prune` added to `HITL_REQUIRED_BACKING` (the I2 frozen set in `executor.ts`) so retention edits are owner-approved; no config bypass. |
| **3. No plaintext credentials** | `payload_summary` runs through the shipped `redactAuditPayload` (strips token/key/secret/bearer/JWT/AWS/GitHub families); `destination` is derived from the action-type prefix, never a raw URL with a query-string secret. The receipt signing key is the **existing** Vault-only Ed25519 share keypair — **no new Vault key, no key in logs/IPC/config**. |
| **4. MCP as connector standard** | The ledger observes `PlannedAction` egress; because the architecture routes every cloud touch through `connectors.dispatch()` (the engine never calls a cloud API directly — Non-Negotiable #4), the chokepoint *is* the MCP-dispatch boundary. The ledger does not itself call any connector. (No existing invariant enforces this MCP-only routing; the new I29 below is the first runtime+static check that the ledger sits atop it.) |
| **5. Platform equality** | Pure Bun/TypeScript + `bun:sqlite` + `@noble/hashes` — byte-identical on Windows/macOS/Linux. (The deferred syscall-capture tier is the only platform-specific piece, and it is explicitly *not* in this slice.) |
| **6. AGPL-3.0 core / MIT SDK** | All new code lives in `packages/gateway` (AGPL) + `packages/cli` (AGPL). No license-field changes; nothing added to `sdk`/`client`. |
| **7. No `any`** | Strict types throughout; `payload` enters as `Record<string, unknown>` (already the `PlannedAction` shape) and external/raw values use `unknown`. |

**Numbering note:** I28 remains reserved for the MCP-server owner-sink (branch dev/asafgolombek/phase7-mcp-gateway-server). The family ideas in 2026-06-20-superpowers-specs-consolidated-review.md §1 are mutually exclusive, so the actual number is the next-free at each spec's own merge time, reconciled by build order. As shipped, the egress ledger landed first and took **I29 / D22 / V44**; the Watch Daemon will take the next-free numbers (I30 / D23 / V45) at *its* merge time.

**Invariant impact — new invariant I29** (I28 remains reserved for the unmerged MCP-server owner-sink on `dev/asafgolombek/phase7-mcp-gateway-server`; the egress ledger landed first, so it takes I29 — the later-merging Watch Daemon will take I30):

> **I29 — Egress-ledger completeness over the executor chokepoint.** Every authorized outbound action (`ToolExecutor.gate()` resolving to non-`rejected`, i.e. about to reach `connectors.dispatch()`) appends exactly one `egress_ledger` row **before** dispatch returns; a rejected/blocked action appends a `result_status='blocked'` row. No action reaches `connectors.dispatch()` without a preceding ledger append (fail-closed: an append failure aborts the action). The ledger is append-only + BLAKE3-chained; the only mutation is the HITL-gated `egress.prune`, which writes a continuing tombstone (never a silent gap). Verification compares hashes with `timingSafeCompare` (I10), never `===`. **The chokepoint's totality is itself enforced statically (D22 below): every egress that the ledger claims to cover must route through `ToolExecutor` — no call to or import of `connectors.dispatch` may exist outside `ToolExecutor`, closing the "a dispatch bypassed the gate" hole that would otherwise make a `0`-row window a false negative.**
>
> - **Wiring:** `engine/executor.ts` `gate()`/`execute()` (the append-before-dispatch seam) + `egress/egress-ledger.ts` (append) + `egress/egress-prune.ts` (the sole mutation).
> - **Test:** `security-invariants.test.ts` — a `gate()`→`execute()` run with a stub dispatcher asserts a row was appended *before* dispatch was called, that a denied action still appends a `blocked` row, and that `execute()` throws (action aborted) if the append throws.
> - **Static complement:** `scripts/structure-audit/check-nimbus-invariants.ts` (new check `D22`): (a) the egress-ledger append symbol and the `egress_ledger` table-write are confined to `egress/*`; no other file may INSERT into `egress_ledger`; `executor.ts` must reference the egress sink; **(b) `connectors.dispatch` is called/imported only from within `ToolExecutor` — any reference to `connectors.dispatch` outside `engine/executor.ts` fails the audit, making the executor chokepoint *total* (every egress provably routes through the ledgered gate, not just by convention).**

**Reused invariants:** I2 (HITL frozen set gains `egress.prune`), I10 (timing-safe verify), I27's *pattern* (chokepoint + Vault-sign + append-only persist + redact), and the V18 BLAKE3 chain math.

**Schema migration — V44** (`egress-ledger-v44-sql.ts`, append-only/forward-only per `nimbus-db-migrations`):

```sql
CREATE TABLE IF NOT EXISTS egress_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        INTEGER NOT NULL,
  source_type      TEXT NOT NULL,   -- 'task' | 'agent' | 'prune'
  source_id        TEXT,            -- session/task/agent id (nullable for system rows)
  destination      TEXT NOT NULL,   -- service/host derived from action-type prefix, never a raw URL
  method           TEXT NOT NULL,   -- action.type (e.g. 'email.send', 'repo.commit.push')
  payload_summary  TEXT NOT NULL,   -- redactAuditPayload(...), <=256 bytes
  hitl_status      TEXT NOT NULL CHECK(hitl_status IN ('approved','not_required','rejected')),
  result_status    TEXT NOT NULL CHECK(result_status IN ('authorized','blocked')),
  row_hash         TEXT NOT NULL,
  prev_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_ts ON egress_ledger(timestamp);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_source ON egress_ledger(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_dest ON egress_ledger(destination);
```

**Fail-closed behavior.** (a) Append failure in `gate()`/`execute()` → the action is **aborted**, never dispatched (the ledger is on the critical path, not best-effort). (b) `egress.prune` denied/timed-out → nothing is pruned. (c) Chain verify mismatch → `nimbus egress verify` exits non-zero and `egress.proveWindow` returns `ok:false` with `brokenAt` — a tampered ledger can never present as clean. (d) `nimbus prove` over a degraded/unverifiable chain prints `indeterminate`, **never a false `0`** (the Phase 22 EAF rule).

### Testing

- **Invariant test (security-invariants.test.ts):** the I29 trio above — append-before-dispatch, blocked-row-on-deny, abort-on-append-failure. Same file as I1–I27.
- **Static-audit test (D22):** assert `check-nimbus-invariants.ts` fails when a `connectors.dispatch` reference is planted outside `engine/executor.ts` (proves the chokepoint-totality rule is enforced, not just documented).
- **Integration (real `bun:sqlite`, fresh temp dir, no DB mocks):** V44 migration applies on a V43 DB and is idempotent; append → verify round-trips; a hand-tampered `row_hash` makes `verifyEgressChain` return `{ok:false, brokenAt}`; prune writes a tombstone and leaves the chain verifiable.
- **Vault test:** assert `payload_summary` never contains a seeded `ghp_…`/`sk-…`/`Bearer …` value, and that the receipt signing reuses the share keypair without exposing the private key over IPC.
- **e2e-CLI (real Gateway subprocess + mock MCP):** `nimbus prove "<local-only query>"` prints `outbound egress events: 0`; a query that triggers a mock connector dispatch prints exactly one row with the right `method`; `nimbus egress verify` exits 0 on a clean chain, non-zero on a corrupted one.
- **Coverage:** every new file ≥80% line+branch (the live `audit:coverage-floor` floor; pure helpers in `egress-record.ts`/`egress-verify.ts` make this cheap). Keep `egress/` files small and DI-seamed so the floor is hit without integration scaffolding.

## Non-goals (YAGNI)

- **Syscall/eBPF/dtrace/ETW raw-traffic capture** — deferred to Phase 8 W4 hardening (raises the completeness *tier*, no schema change).
- **External/auditor-grade signed export to a SIEM sink** — explicitly Phase 12.5 (`docs/roadmap.md` line 1526); this slice is local-only.
- **Per-answer portable EAF receipts / `eaf-verify` binary** — Phase 22 (`docs/roadmap.md` line 2125). The `--receipt` flag here emits a *local* signed window digest, not the portable EAF payload type.
- **Egress *budgets* / capability leases** — Phase 26 (`docs/roadmap.md` line 2285); the ledger records, it does not throttle.
- **Catching undeclared in-process connector HTTP calls** — bounded today by the I15 host-allowlist; closed by the deferred syscall tier. Stated honestly in `prove` output, not silently claimed.
- **`nimbus principles`** (the sibling verb at line 1028) — separate, cheaper doc-printer; can ride along but is not load-bearing here. Cut from this slice unless trivial.

## Open questions

1. **Append placement — `gate()` vs `execute()`?** The cleanest fail-closed seam is: `gate()` returns `proceed`/`rejected`; `execute()` appends the ledger row (with `result_status` from the gate outcome) *before* `connectors.dispatch()`. Confirm we want the `blocked` row written from `gate()`'s rejected branch directly (so a never-`execute()`d denial is still logged) vs only from `execute()`. Leaning: write from `gate()` so every gate decision is ledgered regardless of caller.
2. **Read-action coverage. — RESOLVED.** The risk was that some *read* connector dispatches bypass `ToolExecutor`, leaving the "zero egress on this query" claim a hole. Resolution: this is now enforced **structurally**, not audited-and-hoped — the D22 static complement (above) forbids any call to or import of `connectors.dispatch` outside `ToolExecutor` (`engine/executor.ts`), so by construction every egress (read or write) routes through the ledgered gate; a planted bypass fails the static audit. The one-pass audit of every existing `connectors.dispatch` call site is retained as a **pre-implementation acceptance gate** (criterion 9) that must pass *before* the D22 rule is switched on — proving the current tree already satisfies the rule rather than discovering a violation at enforcement time.
3. **Receipt key choice.** Reuse the share keypair (`share.signing.privkey` family) vs a dedicated `egress.signing.privkey`? Reuse is cheaper and avoids a new Vault key; a dedicated key cleanly separates "I published this" from "this is my locality proof." Leaning reuse for the cheap-primitive goal; revisit at Phase 22.
4. **Retention default.** Unbounded (auditor-grade) by default, manual prune only — confirm this is acceptable for high-volume gateways, or whether a soft size cap with an HITL prompt is wanted.

## Acceptance criteria

1. V44 `egress_ledger` migration applies on a V43 DB, is idempotent, and is the only new table.
2. Every action that reaches `connectors.dispatch()` has a preceding `egress_ledger` row (proven by the I29 test); a denied action has a `result_status='blocked'` row; an append failure aborts the action (no dispatch).
3. `nimbus prove "<local-only query>"` prints `outbound egress events during this query: 0` and `nimbus prove` over a query that hits a mock connector shows exactly the rows for that dispatch.
4. `nimbus egress verify` exits 0 on a clean chain and non-zero on a single tampered row (verified with `timingSafeCompare`, not `===`).
5. No seeded credential value appears in any `payload_summary`; the receipt signature reuses the Vault-only key and the private key never crosses IPC.
6. `egress.prune` is in the I2 frozen set, is HITL-gated, writes a continuing tombstone, and is **not** renderer-exposed (I7).
7. The I29 row exists in three places in one commit (wiring + `SECURITY-INVARIANTS.md` doc row + `security-invariants.test.ts` + the static `D22` check) per the invariant triple rule; I28 left reserved.
8. Every new `egress/`, `ipc/egress-rpc.ts`, and CLI file clears the ≥80% line+branch coverage floor; `bun run preflight` is green before the first push.
9. **(pre-implementation gate)** A one-pass audit of *every* `connectors.dispatch` call site proves all egress — read and write — routes through `ToolExecutor`; the D22 static check (no `connectors.dispatch` reference outside `engine/executor.ts`) passes on the current tree before it is switched on. Without this, the "zero egress" claim has a hole and the slice does not ship.
