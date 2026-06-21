---
name: nimbus-egress
description: >
  S1 "Local Brain" — the Egress Ledger & `nimbus prove`. The always-on, append-only,
  BLAKE3-chained ledger of every authorized outbound action (invariant `I29` / static `D22`):
  one `egress_ledger` row is appended from `engine/executor.ts` `ToolExecutor.gate()` BEFORE
  `connectors.dispatch` — a denied gate writes a `result_status='blocked'` row, and an append
  failure ABORTS the action (fail-closed, never dispatches), so a 0-row window is structurally
  sound. `destination` is the `serviceOf()` action-type prefix (never a raw URL); `payload_summary`
  is `redactAuditPayload`-scrubbed at 256 bytes (a debugging aid, NOT the security boundary); the
  chain reuses `db/audit-chain.ts` genesis + BLAKE3 and verifies timing-safe (I10). The sole
  mutation is the HITL-gated `egress.prune` continuing tombstone (I2 frozen set). Covers the V44
  `egress_ledger` schema, the `egress.*` IPC (4 renderer-exposed reads + the non-exposed prune),
  the `nimbus prove` / `nimbus egress [verify|prune]` CLI, and Vault-reused receipt signing. Use
  when adding or auditing egress-ledger behavior, touching `packages/gateway/src/egress/`, the
  executor dispatch chokepoint, the `egress.*` IPC, the `nimbus prove`/`nimbus egress` CLI, wiring
  the `EgressSink` into a new `ToolExecutor`, or asking why `prove` reports a non-zero or
  `indeterminate` count.
---

# Nimbus S1 "Local Brain" — Egress Ledger & `nimbus prove`

## Why This Skill Exists

Nimbus's central promise is local sovereignty — the machine is the source of truth, the cloud is a connector. The Egress Ledger makes that **provable**: every action the executor authorizes to leave the machine is recorded in a tamper-evident chain *before* it dispatches. `nimbus prove "<query>"` can then answer "did this query send anything outbound?" with a sound `0`, not a hopeful one.

The completeness claim rests on a single structural invariant (`I29`/`D22`): there is exactly one place a connector dispatch happens (`executor.ts`), and the ledger append is wired into the gate that guards it, append-before-dispatch, fail-closed. A 0-row window is only meaningful because no outbound path can skip the ledger.

## File Map — `packages/gateway/src/egress/`

| File | Role |
|---|---|
| `egress-ledger.ts` | The append-only writer: `appendEgressEntry(db, entry)` reads the head hash (`GENESIS_HASH` if empty; throws on a malformed head — fail-closed), computes the BLAKE3 `row_hash`, and inserts via `dbRun` (I14/D12). `computeEgressRowHash` hashes `prev_hash \| timestamp \| source_type \| source_id \| destination \| method \| hitl_status \| result_status` (mirrors `db/audit-chain.ts`). `EgressSink` + `makeEgressSink(db)` — the DI seam wired into `ToolExecutor`. NO update/delete path lives here. |
| `egress-record.ts` | `buildEgressEntry({ action, hitlStatus, resultStatus, sessionId, now })` → the `EgressEntry` struct. `summarizeDestination` = `serviceOf(action.type)` (the segment before the first dot, never a raw URL). `redactEgressSummary` = `redactAuditPayload` capped at 256 bytes. Result statuses: `"authorized" \| "blocked"`; HITL statuses: `"approved" \| "not_required" \| "rejected"`. |
| `egress-verify.ts` | Read + verify: `verifyEgressChain(db, fromId=0)` walks the chain, recomputes each row hash, and compares with `sha256HexEqualConstantTime` (I10 — never `===`); a `prev_hash`/`row_hash` mismatch fails closed with `brokenAt`. `egressHead` (head + count), `listEgress` (clamped to `MAX_EGRESS_LIST_LIMIT` 5000), and `proveWindow` (the rows + completeness tier + WHOLE-ledger verify). |
| `egress-sign.ts` | `digestEgressWindow(rows)` (BLAKE3 over ordered row hashes) + `signWindowDigest(vault, digest)` — signs with the Vault-only Ed25519 **share** keypair via `ensureShareKeypair` (no new Vault key; the seed never leaves Vault). Returns only `{ sigB64, pubkeyB64 }`. A LOCAL receipt, not the portable EAF artifact (deferred). |
| `egress-prune.ts` | `pruneEgress(db, beforeTs, now)` — the SOLE mutation. Deletes `timestamp < beforeTs` in one atomic transaction; survivors keep their ORIGINAL `prev_hash`/`row_hash`; appends one `source_type='prune'` tombstone whose `source_id` carries the boundary hash (which IS hashed, so the attestation is tamper-evident). `prunedCount === 0` → no-op, no tombstone. |

**Wiring:** `engine/executor.ts` `ToolExecutor.gate()` (the append site) · `ipc/egress-rpc.ts` (the `egress.*` registry) · `platform/assemble.ts` + `engine/run-ask.ts` + `chatops/chatops-boot.ts` (sink injection) · `cli/src/commands/prove.ts` (CLI).

## Security Invariant — I29 / static D22 (the triple)

**Statement:** every gated action appends exactly **one** `egress_ledger` row from `ToolExecutor.gate()` BEFORE `connectors.dispatch` is called — so a 0-row window is structurally impossible to fake.

1. **Append-before-dispatch** — in `executor.ts`, after the audit record and before the rejected-return, `gate()` calls `egressSink.append(buildEgressEntry(...))`. `execute()` only reaches `connectors.dispatch(action)` when the gate returns `"proceed"`.
2. **Blocked row on deny** — a denied gate appends a `result_status='blocked'` row (`hitl_status='rejected'`) and never dispatches. Both approved and denied decisions are ledgered.
3. **Fail-closed on append failure** — if `EgressSink.append` throws, `gate()` throws, `execute()` propagates, and dispatch never runs. NEVER wrap the append in a swallowing `try/catch` that lets dispatch proceed.
4. **Tamper-evident** — BLAKE3 chain, timing-safe verify (`sha256HexEqualConstantTime`, I10).
5. **Sole mutation** — `egress.prune` is the only sanctioned edit, a continuing tombstone (not a silent gap), and is a member of the `I2` HITL frozen set.

**Static `D22`** (`scripts/structure-audit/check-nimbus-invariants.ts` `checkEgressChokepointConfinement`, runs in `audit:invariants` before tests): (a) `connectors.dispatch` may appear ONLY in `engine/executor.ts` — NO wrapper/allowlist exemption, no "approved wrapper" carve-out; any new dispatcher decorator, re-export, or "just this once" call elsewhere fails the preflight static check immediately. (b) `appendEgressEntry` is confined to `packages/gateway/src/egress/`. Test files are exempt. The runtime counterpart is the `I29` describe block in `packages/gateway/src/security-invariants.test.ts`. See `nimbus-security-invariants` for the triple-rule contract.

## The ledger shape — V44 `egress_ledger`

Columns: `id`, `timestamp`, `source_type`, `source_id`, `destination`, `method`, `payload_summary`, `hitl_status` (CHECK `approved`/`not_required`/`rejected`), `result_status` (CHECK `authorized`/`blocked`), `row_hash`, `prev_hash` + 3 lookup indexes (ts / source / dest). Migration `egress-ledger-v44-sql.ts`; see `nimbus-db-migrations`.

- **Append-only, BLAKE3-chained** — reuses `db/audit-chain.ts`'s `GENESIS_HASH` + BLAKE3 primitives. `hitl_status` IS hashed (a post-write consent flip must break verify); `payload_summary` is deliberately NOT hashed (it is lossy/redacted, a debugging aid).
- **`destination` = `serviceOf()` prefix** — the service/host segment of `action.type`, never a raw URL, so no secret-bearing query string is ever stored.
- **`payload_summary` = `redactAuditPayload`-scrubbed, ≤256 bytes** — best-effort credential scrubbing for debugging, NOT the security boundary. The security claim is the append-before-dispatch chokepoint, not the redactor.

## Which `ToolExecutor`s get the sink (completeness wiring)

The egress sink is injected into **every** `ToolExecutor` that reaches a real connector dispatch:

- the agent action path — `run-ask.ts` (`nimbus ask` / `agent.invoke`),
- chatops-approved writes — `chatops/chatops-boot.ts`,
- **both** tribal-capture executors (in-chat KB write + the tribal write path).

Gate-only **stub** executors deliberately get **NO sink** — `vault`, `teamvault`, `reindex`, `data`, `auto-update`, `connector.auth` — because their actions are LOCAL mutations, not outbound. Adding a sink there would record non-egress events as egress. The sink is an optional constructor arg (`egressSink?: EgressSink`); production injects `makeEgressSink(db)`, tests may omit it.

## Surfaces

- **IPC (`ipc/egress-rpc.ts`):** `egress.head` / `egress.list` / `egress.verify` / `egress.proveWindow` are **read** verbs and ARE renderer-exposed (Tauri `ALLOWED_METHODS`, I7). `egress.proveWindow` takes `since`/`until`/`sign`; `sign === true` attaches a `receipt` (`digestEgressWindow` → `signWindowDigest`). **`egress.prune` is the SOLE mutation** — it routes through `requestPruneApproval` (production: the fail-closed executor consent gate, I2), is NOT renderer-exposed, and returns `{ approved: false, prunedCount: 0 }` on deny. Before exposing any new egress method over LAN/Tauri, consult `nimbus-ipc` + `nimbus-tauri-allowlist`.
- **CLI (`cli/src/commands/prove.ts`):**
  - `nimbus prove "<query>"` — snapshots `egress.head` before, runs the query via `agent.invoke` (blocking), snapshots after, prints the count diff (`outbound egress events during this query: 0 ✓` when delta is 0; otherwise the `egress.proveWindow` report). `--receipt`/`--sign` attaches a signed receipt.
  - `nimbus egress [verify] [--since <dur>] [--json] [--sign]` — the report (default) or offline chain-verify (`verify`). A degraded chain prints `indeterminate`, never a false `0`, and exits 1.
  - `nimbus egress prune (--before <ISO|epoch> | --older-than <duration>)` — HITL-gated retention; the two cutoff forms are **mutually exclusive** (supplying both errors). `--older-than` reuses `parseSinceDurationToMs`. The consent prompt is registered inline (`registerConsentPromptHandler`); deny → nothing removed.
- **Receipt signing** reuses the Vault-only Ed25519 **share** keypair (`share.signing.privkey` via `ensureShareKeypair`) — no new Vault key; the private seed never leaves the Vault.

## Why `prove` reports what it reports

- **`0 ✓`** — head count unchanged across the query: no gated action dispatched (local-only). Sound only because the chain is intact and the chokepoint is total.
- **A non-zero count** — the query dispatched real outbound actions; each is a row. Denied actions still show as `blocked` rows in the report (they were stopped, not silent).
- **`indeterminate`** — `verifyEgressChain` (run over the WHOLE ledger, `fromId=0`, not just the window) found a break. The "zero egress in window W" inference is only sound if the entire chain is intact, so a degraded chain is reported as unverifiable, never as proof of zero. This is the EAF "indeterminate, never a false zero" rule.

## Gotchas

- **The append site is `gate()`, the dispatch site is `execute()`.** Never add a second `connectors.dispatch` call anywhere but `executor.ts` — D22 fails the static audit before tests run, and any bypass would make a 0-row window a false negative.
- **Never swallow an append failure.** A `try/catch` around `egressSink.append` that lets dispatch proceed defeats I29. Append failure must abort the action.
- **`appendEgressEntry` lives only in `egress/`.** Naming it outside `egress/*` (non-test) fails D22.
- **Stub executors get no sink on purpose.** Don't reflexively inject `makeEgressSink` into vault/teamvault/reindex/data/auto-update/connector.auth — they perform local mutations, not egress.
- **`payload_summary` is not a security control.** It is redacted/capped for debugging; the boundary is the chokepoint. Don't rely on it to keep secrets out, and don't hash it (it's intentionally excluded from `computeEgressRowHash`).
- **`egress.prune` is the only mutation, and it's HITL-gated.** It writes a continuing tombstone (survivors keep their original hashes), so a prune is cryptographically distinguishable from a history rewrite. Don't expose it to the renderer.
- **Verify is whole-ledger, by design.** `proveWindow` verifies `fromId=0`, not just the window — a row deleted/relinked outside the window corrupts a later `prev_hash` without touching window rows, so a window-scoped verify would miss it.
- **No new Vault key for receipts.** Signing reuses the share keypair; don't mint a separate egress signing key.
